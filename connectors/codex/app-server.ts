import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type AppServerMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};
export interface AppServerConnection {
  request(method: string, params: unknown): Promise<any>;
  respond(id: number | string, result: unknown): void;
  reject?(id: number | string): void;
  subscribe(listener: (message: AppServerMessage) => void): () => void;
  close(): void;
}

/** The executor uses its own Codex login; frontend/control-plane credentials are not task environment. */
export function executorEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) =>
      /^(?:HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|LANG|TZ|LC_[A-Z_]+|CODEX_HOME)$/i.test(
        key,
      ),
    ),
  );
}

/** Own stdio connection, never the desktop daemon's socket. No transcripts logged. */
export class CodexAppServerConnection implements AppServerConnection {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private listeners = new Set<(message: AppServerMessage) => void>();
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  constructor(
    projectRoot: string,
    binary = "codex",
    private timeoutMs = 15_000,
  ) {
    this.child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: executorEnvironment(),
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (line.length > 2_000_000) {
        this.close();
        return;
      }
      let message: AppServerMessage;
      try {
        message = JSON.parse(line);
      } catch {
        this.close();
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id));
        clearTimeout(pending.timer);
        // Provider error text can contain prompt/account content: do not propagate it.
        message.error
          ? pending.reject(new Error("executor_rpc_rejected"))
          : pending.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.disconnect());
    this.child.on("exit", () => this.disconnect("process_exit"));
    this.child.stdin.on("error", () => this.disconnect());
  }
  private disconnect(reason = "connection_lost") {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("executor_disconnected"));
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: "clawdtime/disconnected", params: { reason } });
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("executor_disconnected"));
    if (this.pending.size >= 32)
      return Promise.reject(new Error("executor_rpc_queue_full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("executor_rpc_timeout"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method: string) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }
  respond(id: number | string, result: unknown) {
    if (!this.closed)
      this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }
  reject(id: number | string) {
    if (!this.closed)
      this.child.stdin.write(
        `${JSON.stringify({ id, error: { code: -32601, message: "Unsupported worker request" } })}\n`,
      );
  }
  subscribe(listener: (message: AppServerMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    this.disconnect();
    this.child.kill("SIGTERM");
  }
}

export async function initializeAppServer(connection: AppServerConnection) {
  await connection.request("initialize", {
    clientInfo: { name: "clawdtime_managed_executor", version: "1.0.0" },
  });
  // initialized is a notification. The interface permits dedicated fake connections for tests.
  if (connection instanceof CodexAppServerConnection)
    connection.notify("initialized");
}
