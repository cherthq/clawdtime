import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { answerByCall, loadCallLink, openCall } from "./call.js";
import { agentLabel } from "./catalog.js";
import { DecisionDesk, type DecisionRequest } from "./decisions.js";
import { focusSession, realRunner, type Runner } from "./focus.js";
import { stateRoot } from "./hooks.js";
import { sendText } from "./input.js";
import { title } from "./render.js";
import { boardSnapshotSchema, type BoardSnapshot } from "./types.js";

/** What the panel routes need from the board. */
export interface AgentBoardPort {
  /** The latest snapshot, or null when none is fresh. */
  snapshot(): BoardSnapshot | null;
  focus(id: string): ReturnType<typeof focusSession>;
  decisions(): DecisionsView;
  answer(input: {
    id: string;
    decision: "allow" | "deny" | "answer";
    text?: string | null;
    remember?: boolean;
  }): boolean;
  setAway(away: boolean): void;
  send(id: string, text: string, enter: boolean): ReturnType<typeof sendText>;
}

/** The requests that wait for the person, as the panel shows them. */
export interface DecisionsView {
  version: 1;
  away: boolean;
  /** A phone link exists, so away mode can place a call. */
  callReady: boolean;
  pending: {
    id: string;
    agent: string;
    agentLabel: string;
    kind: string;
    tool: string;
    summary: string;
    options: string[];
    project: string;
    /** The session on the board that asks, when it is known. */
    session: string | null;
    sessionId: string | null;
    createdAt: number;
    holdUntil: number;
    allowedBefore: number;
    deniedBefore: number;
    /** The person can make a rule from this answer. */
    canRemember: boolean;
  }[];
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
  readonly desk: DecisionDesk;
  private readonly calling = new Set<string>();
  constructor(
    private readonly options: {
      intervalMs?: number;
      now?: () => number;
      spawn?: typeof spawn;
      runner?: Runner;
      /** The state folder of the desk and the trove. */
      root?: string;
      /** Places the call for one request. The default uses the linked pairing. */
      call?: (request: DecisionRequest) => Promise<{
        decision: "allow" | "deny" | "answer";
        text: string | null;
      } | null>;
    } = {},
  ) {
    this.root =
      options.root ?? stateRoot({ env: process.env, home: homedir() });
    this.desk = new DecisionDesk(this.root, options.now ?? Date.now);
  }
  private readonly root: string;

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

  /**
   * The requests that wait. Each read also says that someone attends the desk:
   * the panel reads this every second, and a hook holds only while it does.
   */
  decisions(): DecisionsView {
    this.desk.attend();
    const sessions = this.snapshot()?.sessions ?? [];
    const away = this.desk.away();
    const link = this.options.call ? true : loadCallLink(this.root) !== null;
    const pending = this.desk.pending();
    if (away && link) for (const request of pending) this.escalate(request);
    return {
      version: 1,
      away,
      callReady: link,
      pending: pending.map((request) => {
        const sameAgent = sessions.filter(
          (session) => session.agent === request.agent,
        );
        const inFolder = sameAgent.filter(
          (session) => session.cwd !== null && session.cwd === request.cwd,
        );
        const session =
          sameAgent.find(
            (item) => item.pid !== null && request.pids.includes(item.pid),
          ) ?? (inFolder.length === 1 ? inFolder[0] : undefined);
        const before = this.desk.trove.suggest(request);
        return {
          id: request.id,
          agent: request.agent,
          agentLabel: agentLabel(request.agent),
          kind: request.kind,
          tool: request.tool,
          summary: request.summary,
          options: request.options,
          project: request.cwd?.split("/").filter(Boolean).at(-1) ?? "",
          session: session ? title(session) : null,
          sessionId: session?.id ?? null,
          createdAt: request.createdAt,
          holdUntil: request.holdUntil,
          allowedBefore: before.allowed,
          deniedBefore: before.denied,
          canRemember:
            request.kind === "permission" &&
            request.cwd !== null &&
            request.pattern !== "Bash",
        };
      }),
    };
  }
  /** Away: one call for each request, and its spoken answer goes to the desk. */
  private escalate(request: DecisionRequest) {
    if (this.calling.has(request.id)) return;
    this.calling.add(request.id);
    const now = this.options.now ?? Date.now;
    const place =
      this.options.call ??
      (async (item: DecisionRequest) => {
        const link = loadCallLink(this.root);
        if (!link) return null;
        return answerByCall(await openCall(link, item), item, {
          now,
          deadline: item.holdUntil - 5000,
        });
      });
    void place(request)
      .then((answer) => {
        if (answer) this.desk.answer(request.id, { ...answer, via: "call" });
      })
      .catch(() => {
        // A call that could not be placed leaves the request for the panel and the terminal.
      });
  }
  answer(input: {
    id: string;
    decision: "allow" | "deny" | "answer";
    text?: string | null;
    remember?: boolean;
  }) {
    return this.desk.answer(input.id, { ...input, via: "panel" });
  }
  setAway(away: boolean) {
    this.desk.setAway(away);
  }
  async send(id: string, text: string, enter: boolean) {
    const session = this.snapshot()?.sessions.find((item) => item.id === id);
    if (!session) return { ok: false, route: "none" as const };
    return sendText(
      session,
      text,
      { enter },
      this.options.runner ?? realRunner,
    );
  }

  close() {
    this.closed = true;
    if (this.restart) clearTimeout(this.restart);
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}
