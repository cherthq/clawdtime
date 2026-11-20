import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ChatLog,
  OpenAIModel,
  Supervisor,
  type ChatMessage,
  type ModelClient,
} from "./brain.js";
import type { CliFact } from "./inventory.js";
import {
  speak,
  speechSettings,
  transcribe,
  type SpeechSettings,
} from "./speech.js";
import { answerByCall, loadCallLink, openCall } from "./call.js";
import { agentLabel } from "./catalog.js";
import { DecisionDesk, type DecisionRequest } from "./decisions.js";
import { focusSession, realRunner, type Runner } from "./focus.js";
import { stateRoot } from "./hooks.js";
import { focusRemote, HostBook, RemoteDesk, remoteSend } from "./hosts.js";
import { sendText } from "./input.js";
import { title } from "./render.js";
import {
  boardSnapshotSchema,
  type AgentSession,
  type BoardSnapshot,
} from "./types.js";

/** What the panel routes need from the board. */
export interface AgentBoardPort {
  /** The latest snapshot, or null when none is fresh. */
  snapshot(): BoardSnapshot | null;
  focus(id: string): ReturnType<typeof focusSession>;
  decisions(): DecisionsView;
  /** A request of a remote Mac is answered over ssh, so that answer is a promise. */
  answer(input: {
    id: string;
    decision: "allow" | "deny" | "answer";
    text?: string | null;
    remember?: boolean;
  }): boolean | Promise<boolean>;
  setAway(away: boolean): void;
  send(id: string, text: string, enter: boolean): ReturnType<typeof sendText>;
  chat(): ChatView;
  /** Memory on or off. It is off until the person turns it on. */
  setMemory(enabled: boolean): void;
  say(text: string): Promise<ChatMessage>;
  hear(recording: string): Promise<{
    heard: string;
    reply: ChatMessage | null;
    audio: string | null;
  }>;
}

/** The conversation with ClawdTime, as the chat screen shows it. */
export interface ChatView {
  version: 1;
  /** A language model answers. Without one ClawdTime tells the state and takes a clear yes or no. */
  model: boolean;
  /** Speech in and out is available. */
  speech: boolean;
  /** The folder for recordings and spoken answers. The panel writes and reads there. */
  voiceDirectory: string;
  /** The person turned memory on: ClawdTime keeps what they tell it. */
  memory: boolean;
  messages: ChatMessage[];
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
    /** The remote Mac whose agent asks. Absent for an agent on this Mac. */
    host?: string;
    /** What the person said before that bears on this request. Null with memory off. */
    recalled: string | null;
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
      /** The language model. The default is OpenAI when a key is in the environment. */
      model?: ModelClient | null;
      /** Speech settings. The default reads the environment. */
      speech?: SpeechSettings | null;
      clis?: () => CliFact[];
    } = {},
  ) {
    this.root =
      options.root ?? stateRoot({ env: process.env, home: homedir() });
    this.desk = new DecisionDesk(this.root, options.now ?? Date.now);
    this.book = new HostBook(this.root);
    this.remoteDesk = new RemoteDesk({
      book: this.book,
      run: options.runner ?? realRunner,
      now: options.now ?? Date.now,
    });
    this.log = new ChatLog(this.root);
    const key =
      process.env.CLAWDTIME_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const model =
      options.model !== undefined
        ? options.model
        : key
          ? new OpenAIModel(
              key,
              process.env.CLAWDTIME_SUPERVISOR_MODEL || "gpt-4.1-mini",
            )
          : null;
    this.speech =
      options.speech !== undefined
        ? options.speech
        : speechSettings(process.env);
    this.supervisor = new Supervisor(
      {
        now: options.now ?? Date.now,
        board: () => this.snapshot(),
        desk: this.desk,
        focus: (session) => this.focusOne(session),
        send: (session, text) => this.sendOne(session, text, true),
        clis: options.clis ?? (() => []),
      },
      model,
    );
  }
  private readonly root: string;
  private readonly book: HostBook;
  private readonly remoteDesk: RemoteDesk;
  /** A session of this Mac comes forward here. One of a remote Mac opens in a new window over ssh. */
  private async focusOne(session: AgentSession) {
    const run = this.options.runner ?? realRunner;
    if (!session.host) return focusSession(session, run);
    const host = this.book.get(session.host);
    return host
      ? focusRemote(host, session, run, this.root)
      : { ok: false, precision: "none" as const };
  }
  private async sendOne(session: AgentSession, text: string, enter: boolean) {
    const run = this.options.runner ?? realRunner;
    if (!session.host) return sendText(session, text, { enter }, run);
    const host = this.book.get(session.host);
    return host
      ? remoteSend(host, session, text, enter, run)
      : { ok: false, route: "none" as const };
  }
  private readonly log: ChatLog;
  private readonly supervisor: Supervisor;
  private readonly speech: SpeechSettings | null;
  private get voiceDirectory() {
    return join(this.root, "agents", "voice");
  }

  chat(): ChatView {
    mkdirSync(this.voiceDirectory, { recursive: true, mode: 0o700 });
    return {
      version: 1,
      model: this.supervisor.ready,
      speech: this.speech !== null,
      voiceDirectory: this.voiceDirectory,
      memory: this.desk.memory.enabled(),
      messages: this.log.recent(),
    };
  }
  setMemory(enabled: boolean) {
    this.desk.memory.setEnabled(enabled);
  }
  /** One typed message from the person, and ClawdTime's answer. */
  async say(
    text: string,
    via: ChatMessage["via"] = "chat",
  ): Promise<ChatMessage> {
    const now = this.options.now ?? Date.now;
    const history = this.log.recent(24);
    this.log.append({
      role: "user",
      text: text.slice(0, 2000),
      at: now(),
      via,
    });
    const reply: ChatMessage = {
      role: "assistant",
      text: await this.supervisor.reply(history, text, via),
      at: now(),
      via,
    };
    this.log.append(reply);
    return reply;
  }
  /**
   * One recording from the panel: its words, ClawdTime's answer, and the answer
   * as speech. The recording is removed once its words are known.
   */
  async hear(recording: string) {
    if (!this.speech || !/^[A-Za-z0-9_-]{1,60}\.(wav|m4a)$/.test(recording))
      return { heard: "", reply: null, audio: null };
    const file = join(this.voiceDirectory, recording);
    let heard = "";
    try {
      heard = await transcribe(file, this.speech);
    } catch {
      heard = "";
    } finally {
      rmSync(file, { force: true });
    }
    if (!heard) return { heard: "", reply: null, audio: null };
    const reply = await this.say(heard, "voice");
    let audio: string | null = `reply-${Date.now().toString(36)}.mp3`;
    try {
      // Only the newest answer is kept as sound.
      for (const name of readdirSync(this.voiceDirectory))
        if (/^reply-[a-z0-9]+\.mp3$/.test(name))
          rmSync(join(this.voiceDirectory, name), { force: true });
      writeFileSync(
        join(this.voiceDirectory, audio),
        await speak(reply.text, this.speech),
        { mode: 0o600 },
      );
    } catch {
      audio = null;
    }
    return { heard, reply, audio };
  }

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
    return this.focusOne(session);
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
    // The remote Macs are asked in the background. This read shows what they
    // last said, and their hooks learn there that someone attends here.
    void this.remoteDesk.poll();
    const all: (DecisionRequest & { host?: string })[] = [
      ...pending,
      ...this.remoteDesk.pending(),
    ];
    return {
      version: 1,
      away,
      callReady: link,
      pending: all.map((request) => {
        const host = request.host;
        const sameAgent = sessions.filter(
          (session) => session.agent === request.agent && session.host === host,
        );
        const inFolder = sameAgent.filter(
          (session) => session.cwd !== null && session.cwd === request.cwd,
        );
        const session =
          sameAgent.find(
            (item) => item.pid !== null && request.pids.includes(item.pid),
          ) ?? (inFolder.length === 1 ? inFolder[0] : undefined);
        // The trove of a remote Mac stays on that Mac: no counts for its requests here.
        const before = host
          ? { allowed: 0, denied: 0 }
          : this.desk.trove.suggest(request);
        return {
          ...(host ? { host } : {}),
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
          recalled: this.desk.recalled(request),
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
        return answerByCall(await openCall(link, item.id), item, {
          now,
          deadline: item.holdUntil - 5000,
          recalled: this.desk.recalled(item),
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
    if (this.remoteDesk.pending().some((request) => request.id === input.id))
      return this.remoteDesk.answer(input);
    return this.desk.answer(input.id, { ...input, via: "panel" });
  }
  setAway(away: boolean) {
    this.desk.setAway(away);
  }
  async send(id: string, text: string, enter: boolean) {
    const session = this.snapshot()?.sessions.find((item) => item.id === id);
    if (!session) return { ok: false, route: "none" as const };
    return this.sendOne(session, text, enter);
  }

  close() {
    this.closed = true;
    if (this.restart) clearTimeout(this.restart);
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}
