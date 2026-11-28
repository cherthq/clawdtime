/**
 * Fakes for the chat agent: a computer engine with the worker's public
 * surface, coding jobs, a world with a real desk, memory and trove in a
 * temporary state folder, and a scripted model. No real model, no screen.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";
import type {
  LoopCall,
  LoopMessage,
  LoopModel,
  LoopToolSpec,
} from "../connectors/agents/agent-loop.js";
import type { SupervisorWorld } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import type {
  JobFacts,
  JobPort,
  JobStartOptions,
} from "../connectors/agents/jobs.js";

export const tempRoot = () =>
  mkdtempSync(join(tmpdir(), "clawdtime-chat-agent-"));

const live = new Set(["running", "waiting_for_person"]);

/** The computer worker as the chat sees it: submit, answer, stop, snapshot. */
export class FakeComputer {
  state = "idle";
  requestId: string | undefined;
  goal = "";
  message = "Computer use is on. Nothing runs.";
  waiting: "approval" | "question" | "takeover" | undefined;
  guidance: string[] = [];
  configured = true;
  readonly submits: { id: string; text: string }[] = [];
  readonly answers: string[] = [];
  /** The order of what happened, with the model's requests, for tests of order. */
  readonly trail: string[];
  stops = 0;
  /** As the app-owned worker: a start answers with no words, and its first words come by `firstWords`. */
  quiet = false;
  private opened: { id: string; words: string } | null = null;
  private count = 0;
  constructor(trail: string[] = []) {
    this.trail = trail;
  }
  get isLive() {
    return live.has(this.state);
  }
  snapshot(): DesktopExecutionSnapshot {
    return {
      configured: this.configured,
      mode: "native",
      state: this.state,
      canStop: this.configured && this.isLive,
      message: this.message,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.isLive ? { goal: this.goal } : {}),
      ...(this.isLive && this.guidance.length
        ? { guidance: [...this.guidance] }
        : {}),
      ...(this.waiting ? { waiting: this.waiting } : {}),
    };
  }
  /** A task runs, as if the owner had started it before. */
  run(goal: string) {
    this.requestId = `req_${++this.count}`;
    this.state = "running";
    this.goal = goal;
    this.waiting = undefined;
    this.guidance = [];
    this.message = `Working on: "${goal}". Step 2 of at most 40.`;
    return this;
  }
  ask(waiting: "approval" | "question" | "takeover", question: string) {
    this.state = "waiting_for_person";
    this.waiting = waiting;
    this.message = question;
    return this;
  }
  finish(report: string, state = "completed") {
    this.state = state;
    this.waiting = undefined;
    this.message = report;
    return this;
  }
  async submit(id: string, text: string) {
    this.trail.push(`submit:${text}`);
    this.submits.push({ id, text });
    if (!this.configured) return { message: "Computer use is off." };
    if (this.isLive) {
      this.guidance.push(text);
      return { message: `Got it. I added that to the task: "${text}".` };
    }
    this.run(text);
    if (this.quiet) {
      this.opened = { id, words: `I'm opening the page first for "${text}".` };
      return { message: "" };
    }
    return { message: `Started on the screen: "${text}".` };
  }
  async firstWords(eventId: string, _withinMs: number) {
    return this.opened?.id === eventId ? this.opened.words : "";
  }
  async answer(text: string) {
    this.trail.push(`answer:${text}`);
    this.answers.push(text);
    if (this.state !== "waiting_for_person") return { message: this.message };
    if (this.waiting === "approval" && /^\s*(?:no|nope|don|deny)/i.test(text)) {
      this.finish("I did not do it: you said no.", "canceled");
      return { message: this.message };
    }
    this.state = "running";
    this.waiting = undefined;
    this.message = `Working on: "${this.goal}". Step 3 of at most 40.`;
    return { message: "Continuing." };
  }
  stop(): DesktopExecutionSnapshot {
    this.trail.push("stop");
    this.stops++;
    if (this.isLive)
      this.finish("Stopped. Nothing more runs on the screen.", "canceled");
    return this.snapshot();
  }
  clear() {
    return { message: "Cleared." };
  }
}

/** Coding jobs that start nothing: each start is a record. */
export class FakeJobs implements JobPort {
  readonly started: { job: string; options: JobStartOptions }[] = [];
  readonly list: JobFacts[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  async start(job: string, options: JobStartOptions = {}) {
    this.started.push({ job, options });
    const id = `20261126T120000-${String(this.list.length).padStart(4, "0")}`;
    this.list.unshift({
      id,
      job,
      startedAt: this.now(),
      done: false,
      status: "awaiting_result",
      result: null,
    });
    return { ok: true, said: `I started a job for that: "${job}".` };
  }
  recent(limit = 10) {
    return this.list.slice(0, limit);
  }
  finish(result: string) {
    const job = this.list[0];
    if (job) Object.assign(job, { done: true, status: "completed", result });
  }
}

/** A world for the chat with a real desk in the state folder. */
export function chatWorld(
  root: string,
  options: {
    computer?: FakeComputer;
    jobs?: FakeJobs;
    memory?: boolean;
    now?: () => number;
  } = {},
): SupervisorWorld {
  const now = options.now ?? Date.now;
  const desk = new DecisionDesk(root, now);
  if (options.memory) desk.memory.setEnabled(true);
  return {
    now,
    board: () => null,
    desk,
    focus: async () => ({ ok: false }),
    send: async () => ({ ok: false, route: "none" }),
    clis: () => [],
    ...(options.computer ? { execution: options.computer } : {}),
    ...(options.jobs ? { jobs: options.jobs } : {}),
  };
}

export interface ModelRequest {
  system: string;
  messages: LoopMessage[];
  tools: LoopToolSpec[];
}

let callCount = 0;
export const call = (
  name: string,
  args: Record<string, unknown> = {},
): LoopCall => ({
  id: `call_${++callCount}`,
  name,
  arguments: JSON.stringify(args),
});

/** A model whose answers are scripted, one for each request; then words. It keeps every request. */
export function scriptedModel(
  answers: (
    | { text?: string; calls?: LoopCall[] }
    | ((
        request: ModelRequest,
      ) =>
        | { text?: string; calls?: LoopCall[] }
        | Promise<{ text?: string; calls?: LoopCall[] }>)
  )[],
  options: { trail?: string[] } = {},
): LoopModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async next(request) {
      options.trail?.push("model");
      const copy: ModelRequest = structuredClone(request);
      requests.push(copy);
      const step = answers[requests.length - 1];
      const answer = typeof step === "function" ? await step(copy) : step;
      return {
        text: answer?.text ?? (answer ? "" : "Done for now."),
        calls: answer?.calls ?? [],
      };
    },
  };
}

/** Every text of every request, joined: for tests that look for what went out. */
export const sentText = (requests: ModelRequest[]) =>
  requests
    .map((request) =>
      [
        request.system,
        ...request.messages.map((message) =>
          message.role === "assistant"
            ? `${message.content} ${(message.calls ?? []).map((item) => item.arguments).join(" ")}`
            : message.content,
        ),
      ].join("\n"),
    )
    .join("\n");
