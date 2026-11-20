import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { focusSession, realRunner, type Runner } from "./focus.js";
import { boardSnapshotSchema, type BoardSnapshot } from "./types.js";

/** What the panel routes need from the board. */
export interface AgentBoardPort {
  /** The latest snapshot, or null when none is fresh. */
  snapshot(): BoardSnapshot | null;
  focus(id: string): ReturnType<typeof focusSession>;
}

const maximumLine = 2 * 1024 * 1024;

/**
 * Runs the publisher as a child and keeps its latest valid snapshot. A child
 * that ends is started again after a delay that grows to one minute.
 */
export class BoardFeed implements AgentBoardPort {
  private child: ChildProcess | undefined;
  private latest: BoardSnapshot | undefined;
  private buffer = "";
  private closed = false;
  private restart: NodeJS.Timeout | undefined;
  private delayMs = 2000;
  constructor(
    private readonly options: {
      intervalMs?: number;
      now?: () => number;
      spawn?: typeof spawn;
      runner?: Runner;
    } = {},
  ) {}

  private get intervalMs() {
    return this.options.intervalMs ?? 3000;
  }

  start() {
    if (this.closed || this.child) return;
    // The same runtime and loader as this process: tsx in development, plain
    // node for the built files. The publisher file has the matching extension.
    const script = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./publisher.ts" : "./publisher.js",
        import.meta.url,
      ),
    );
    const child = (this.options.spawn ?? spawn)(
      process.execPath,
      [...process.execArgv, script, String(this.intervalMs)],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    const ended = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.buffer = "";
      if (this.closed) return;
      this.restart = setTimeout(() => this.start(), this.delayMs);
      this.restart.unref();
      this.delayMs = Math.min(60_000, this.delayMs * 2);
    };
    child.once("error", ended);
    child.once("exit", ended);
  }

  /** Public for tests: feeds bytes as the child would print them. */
  receive(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > maximumLine) this.buffer = "";
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        this.latest = boardSnapshotSchema.parse(JSON.parse(line));
        this.delayMs = 2000;
      } catch {
        // An invalid line is dropped. The last valid snapshot ages out.
      }
    }
  }

  snapshot() {
    const now = (this.options.now ?? Date.now)();
    if (!this.latest) return null;
    const interval = this.latest.intervalMs ?? this.intervalMs;
    return now - this.latest.generatedAt > interval * 3 + 2000
      ? null
      : this.latest;
  }

  async focus(id: string) {
    const session = this.snapshot()?.sessions.find((item) => item.id === id);
    if (!session) return { ok: false, precision: "none" as const };
    return focusSession(session, this.options.runner ?? realRunner);
  }

  close() {
    this.closed = true;
    if (this.restart) clearTimeout(this.restart);
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}
