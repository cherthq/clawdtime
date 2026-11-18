import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface TaskAudioInspectorOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  maxPending?: number;
  maxLineBytes?: number;
  closeGraceMs?: number;
}

/** Trusted argv only. Read-only JSON-lines RPC; this client never retries a request. */
export class TaskAudioInspectorClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly maxLineBytes: number;
  private readonly closeGraceMs: number;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private started = false;
  private ready = false;
  private failed = false;
  private closing = false;
  private exited = false;
  private joinedChild = false;
  private writes = Promise.resolve();
  private closePromise?: Promise<void>;
  private readonly startup: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly joined: Promise<void>;
  private joinedResolve!: () => void;
  private startupTimer?: ReturnType<typeof setTimeout>;

  constructor(options: TaskAudioInspectorOptions) {
    const bounded = (
      value: number | undefined,
      fallback: number,
      max: number,
    ) => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result < 1 || result > max)
        throw new Error("Invalid inspector client bound.");
      return result;
    };
    this.timeoutMs = bounded(options.timeoutMs, 5000, 60000);
    this.maxPending = bounded(options.maxPending, 16, 64);
    this.maxLineBytes = bounded(options.maxLineBytes, 1048576, 1048576);
    this.closeGraceMs = bounded(options.closeGraceMs, 1000, 5000);
    const startupTimeoutMs = bounded(options.startupTimeoutMs, 15000, 60000);
    if (!options.command || options.command.includes("\0"))
      throw new Error("Trusted inspector command required.");
    this.startup = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A failed spawn/handshake can precede the caller's explicit start().
    void this.startup.catch(() => {});
    this.joined = new Promise((resolve) => {
      this.joinedResolve = resolve;
    });
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume(); // Never retain or expose remote diagnostics/credentials.
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stdin.on("error", () =>
      this.fail("Inspector input unavailable."),
    );
    this.child.stdout.on("error", () =>
      this.fail("Inspector output unavailable."),
    );
    this.child.on("error", () => this.fail("Inspector process unavailable."));
    this.child.on("exit", () => {
      this.exited = true;
      if (!this.closing)
        this.fail("Inspector exited; requests were not retried.");
    });
    this.child.on("close", () => {
      this.exited = true;
      this.joinedChild = true;
      if (!this.closing)
        this.fail("Inspector closed; requests were not retried.");
      this.joinedResolve();
    });
    this.startupTimer = setTimeout(
      () => this.fail("Inspector readiness timed out."),
      startupTimeoutMs,
    );
  }

  /** Explicit handshake: the child must emit exactly {ready:true,version:1}. */
  async start(): Promise<void> {
    this.started = true;
    await this.startup;
    if (this.failed || this.closing)
      throw new Error("Inspector is unavailable.");
  }

  request(payload: unknown): Promise<unknown> {
    if (!this.started || !this.ready || this.failed || this.closing)
      return Promise.reject(
        new Error("Inspector must complete explicit startup before requests."),
      );
    if (this.pending.size >= this.maxPending)
      return Promise.reject(
        new Error("Inspector pending request limit reached."),
      );
    const id = `inspect_${++this.sequence}`;
    let line: string;
    try {
      if (payload === undefined) throw new Error();
      line = JSON.stringify({ id, payload });
      if (
        !Object.hasOwn(JSON.parse(line), "payload") ||
        Buffer.byteLength(line) > this.maxLineBytes
      )
        throw new Error();
    } catch {
      return Promise.reject(
        new Error("Inspector payload is invalid or exceeds its bound."),
      );
    }
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("Inspector request timed out; no retry was attempted."),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writes = this.writes
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (this.failed || this.closing) {
              resolve();
              return;
            }
            this.child.stdin.write(line + "\n", (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      )
      .catch(() =>
        this.fail("Inspector write failed; no retry was attempted."),
      );
    return result;
  }

  private receive(chunk: Buffer): void {
    if (this.failed || this.closing) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) {
        if (this.buffer.length > this.maxLineBytes)
          this.fail("Inspector response exceeds its bound.");
        return;
      }
      if (newline > this.maxLineBytes) {
        this.fail("Inspector response exceeds its bound.");
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(line),
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
      } catch {
        this.fail("Inspector returned malformed protocol data.");
        return;
      }
      const keys = Object.keys(value).sort().join(",");
      if (!this.ready) {
        if (
          keys !== "ready,version" ||
          value.ready !== true ||
          value.version !== 1
        ) {
          this.fail("Inspector readiness handshake differs.");
          return;
        }
        this.ready = true;
        clearTimeout(this.startupTimer);
        this.readyResolve();
      } else {
        const pending =
          typeof value.id === "string" ? this.pending.get(value.id) : undefined;
        const success = value.ok === true && keys === "id,ok,value";
        const refusal =
          value.ok === false &&
          keys === "error,id,ok" &&
          value.error === "inspection_failed";
        if (!pending || (!success && !refusal)) {
          this.fail("Inspector response identity or schema differs.");
          return;
        }
        this.pending.delete(value.id as string);
        clearTimeout(pending.timer);
        if (success) pending.resolve(value.value);
        else
          pending.reject(new Error("Inspector refused the read-only request."));
      }
      if (this.failed || this.closing) return;
    }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.startupTimer);
    const error = new Error(message);
    this.readyReject(error);
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    if (!this.closing) void this.close();
  }

  private signalChild(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid)
        process.kill(-this.child.pid, signal);
      else if (!this.exited) this.child.kill(signal);
    } catch {
      /* An already-exited owned child/group needs no repeated signal. */
    }
  }

  /** Idempotent cleanup joins the child; a canceled caller cannot abandon the shared close. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.fail("Inspector closed; requests were not retried.");
    this.closePromise = (async () => {
      if (!this.joinedChild) {
        this.child.stdin.destroy();
        this.signalChild("SIGTERM");
      }
      const kill = setTimeout(() => {
        if (!this.joinedChild) this.signalChild("SIGKILL");
      }, this.closeGraceMs);
      try {
        await this.joined;
      } finally {
        clearTimeout(kill);
      }
    })();
    return this.closePromise;
  }
}
