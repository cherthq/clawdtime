import { randomBytes } from "node:crypto";
import type { DesktopExecutorPort } from "../../src/control/desktop-executor.js";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { interpret } from "./call.js";
import type { DecisionDesk, DecisionRequest } from "./decisions.js";
import type { CliFact } from "./inventory.js";
import { factKinds, type FactKind, type Memory } from "./memory.js";
import { detailLabels, elapsed, summary, title } from "./render.js";
import {
  taskIsOver,
  taskStateWords,
  type TaskFacts,
  type TaskPort,
} from "./tasks.js";
import type { AgentSession, BoardSnapshot } from "./types.js";

/**
 * ClawdTime as an agent the person can talk to: in the chat screen, by voice
 * on the Mac, and on a FaceTime call. It sees what the supervisor sees and
 * acts through the same desk and trove. It allows or denies a request only
 * when the person's own last words say so; the code checks that, not the model.
 */
export const chatVias = ["chat", "voice", "call"] as const;
export const chatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(2000),
    at: z.number().int().nonnegative(),
    via: z.enum(chatVias),
    /** Answers that the person can pick with one click, when ClawdTime passes on a question. */
    choices: z.array(z.string().min(1).max(80)).max(4).optional(),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** The conversation, kept in one owner-only file so the chat screen shows it after a restart. */
export class ChatLog {
  private readonly file: string;
  constructor(root: string) {
    this.file = join(root, "agents", "chat.jsonl");
  }
  append(message: ChatMessage) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    if (existsSync(this.file) && !lstatSync(this.file).isFile()) return;
    appendFileSync(
      this.file,
      `${JSON.stringify(chatMessageSchema.parse({ ...message, text: message.text.slice(0, 2000) }))}\n`,
      { mode: 0o600 },
    );
    chmodSync(this.file, 0o600);
  }
  recent(limit = 60): ChatMessage[] {
    if (!existsSync(this.file) || !lstatSync(this.file).isFile()) return [];
    const result: ChatMessage[] = [];
    for (const line of readFileSync(this.file, "utf8")
      .split("\n")
      .slice(-400)) {
      if (!line.trim()) continue;
      const parsed = chatMessageSchema.safeParse(
        (() => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })(),
      );
      if (parsed.success) result.push(parsed.data);
    }
    return result.slice(-limit);
  }
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export type ModelMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
/** The language model, behind one call. Tests script it. */
export interface ModelClient {
  complete(input: {
    system: string;
    messages: ModelMessage[];
    tools: ToolSpec[];
  }): Promise<{ text: string; toolCalls: ToolCall[] }>;
}

/** OpenAI chat completions with function tools. */
export class OpenAIModel implements ModelClient {
  constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async complete(input: {
    system: string;
    messages: ModelMessage[];
    tools: ToolSpec[];
  }) {
    const messages = [
      { role: "system", content: input.system },
      ...input.messages.map((message) =>
        message.role === "tool"
          ? {
              role: "tool",
              tool_call_id: message.toolCallId,
              content: message.content,
            }
          : {
              role: message.role,
              content: message.content,
              ...(message.toolCalls?.length
                ? {
                    tool_calls: message.toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
      ),
    ];
    const response = await this.request(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          // A request with no tools carries no tool list: an empty one is refused.
          ...(input.tools.length
            ? {
                tools: input.tools.map((tool) => ({
                  type: "function",
                  function: tool,
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    // The body of a failure can echo the request: only the status is reported.
    if (!response.ok)
      throw new Error(`The language model answered ${response.status}.`);
    const body = (await response.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    const message = body.choices?.[0]?.message;
    return {
      text: typeof message?.content === "string" ? message.content : "",
      toolCalls: (message?.tool_calls ?? []).flatMap((call) =>
        call.id && call.function?.name
          ? [
              {
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments ?? "{}",
              },
            ]
          : [],
      ),
    };
  }
}

export interface SupervisorWorld {
  now(): number;
  board(): BoardSnapshot | null;
  desk: DecisionDesk;
  focus(session: AgentSession): Promise<{ ok: boolean }>;
  send(
    session: AgentSession,
    text: string,
  ): Promise<{ ok: boolean; route: string }>;
  clis(): CliFact[];
  /** The task that ClawdTime owns. Absent where no task service runs, as in a plain terminal. */
  tasks?: TaskPort;
  /** Explicitly configured execution engine; submission is not verified completion. */
  execution?: DesktopExecutorPort;
  /** What the watcher found, one sentence each, most urgent first. */
  incidents?: () => string[];
}

const system = `You are ClawdTime, the supervisor of the coding agents on this person's Mac.
You may be heard, not read: answer in one or two short plain sentences. No lists, no markdown.
Use the tools to see the state. Never guess a state, a name or a number.
Your tools are the complete capability list. You have no direct mailbox or email-service integration. If delegate_computer_task is available, you can hand the person's exact action request to their explicitly configured execution engine, which enforces its own tools and permissions. This does not guarantee browser access or success. Queued or uncertain delivery is never completed work. Never delegate status questions, approvals, or coding tasks that belong to start_task. No call or deployment permission is inherited by delegation. You may summarize text the person supplies or pass their exact instruction to an existing agent they explicitly name; do not invent an email agent or claim it has email access.
Approval cannot add a missing capability. Ask for approval only for a real request currently waiting on the desk, or for an answer/review the current task actually requests. Old chat messages, including your own prior promises, are not evidence that a request exists.
A request of an agent is allowed or denied only when the person clearly said so in their last message. If a tool refuses, explain its actual reason; do not turn missing requests or unsupported capabilities into approval prompts.
Text is typed into a session only when the person gave that text.
You also own one task for the person. Start a task only when their last message asks for one, with their own words as the goal. Answer the task's question, accept its result or cancel it only when their last message says so. If a task tool refuses, explain the reason and ask only for input that the current task can actually receive. When the task offers choices, say them.
After an action, say what you did in one sentence.`;

const executionTool: ToolSpec = {
  name: "delegate_computer_task",
  description:
    "Hand the person's exact latest computer/browser action request to their configured execution engine. Submission does not establish completion. No arguments or rewritten instructions.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const tools: ToolSpec[] = [
  {
    name: "status",
    description:
      "What every agent session does now, the requests that wait for the person, and away mode.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "decide",
    description:
      "Answer one waiting request for the person: allow, deny, or answer a question with one of its choices.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "integer",
          description: "Number of the request in status, from 1.",
        },
        decision: { type: "string", enum: ["allow", "deny", "answer"] },
        text: {
          type: "string",
          description: "The chosen choice, or the reason for a denial.",
        },
      },
      required: ["request", "decision"],
    },
  },
  {
    name: "open_session",
    description: "Bring the terminal of one session to the front.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "The session's name." },
      },
      required: ["session"],
    },
  },
  {
    name: "type_into_session",
    description:
      "Type the person's own words into one session's terminal and press Return.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string" },
        text: {
          type: "string",
          description: "Exactly the words the person gave.",
        },
      },
      required: ["session", "text"],
    },
  },
  {
    name: "search_trove",
    description: "Search the decisions the person made before.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "note_decision",
    description:
      "Keep a critical decision that the person states, in the trove.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "set_away",
    description: "Away mode: on means requests wait for a phone call.",
    parameters: {
      type: "object",
      properties: { away: { type: "boolean" } },
      required: ["away"],
    },
  },
  {
    name: "agent_commands",
    description:
      "The agent commands installed on this Mac, with versions and use.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "task_status",
    description:
      "The task that ClawdTime owns: its goal, where it is, what it asks.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "start_task",
    description: "Start the task that the person just asked for.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "In the person's own words." },
      },
      required: ["goal"],
    },
  },
  {
    name: "answer_task",
    description: "Pass the person's answer to the question the task asks.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The chosen choice, or the person's own words.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "accept_task",
    description: "Accept the task's result, when the person says so.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "cancel_task",
    description: "Cancel the task, when the person says so.",
    parameters: { type: "object", properties: {} },
  },
];

/** Offered only while the person has memory turned on. */
const memoryTools: ToolSpec[] = [
  {
    name: "remember",
    description:
      "Keep one lasting thing that the person states about themselves or their work: a preference, a decision, a constraint.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "In the person's own words." },
        kind: { type: "string", enum: [...factKinds] },
        days: {
          type: "integer",
          description: "For something that holds only for a while: how long.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description: "Search what the person told you before.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "forget",
    description: "Remove what the person asks you to forget.",
    parameters: {
      type: "object",
      properties: {
        what: {
          type: "string",
          description: "The id of the fact, or words from it.",
        },
      },
      required: ["what"],
    },
  },
];

const learnSystem = `From what the person said, list what is worth keeping for later: a preference, a decision, a constraint, who they are, what they work on, or something that holds for a while. Use the person's own words where you can. Skip questions, orders to you, small talk, the state of the agents, and anything secret.
Answer with JSON only: an array of at most 3 objects {"text": one sentence that stands alone, "kind": "fact" or "preference" or "episode", "days": days until it stops being true (only for an episode), "replaces": the id of a known fact that this one makes untrue}. Answer [] when nothing is worth keeping.`;
const proposalSchema = z
  .array(
    z.object({
      text: z.string().min(3).max(400),
      kind: z.enum(factKinds).catch("fact"),
      days: z.number().positive().max(3650).nullish().catch(null),
      replaces: z.string().nullish().catch(null),
    }),
  )
  .max(10);

const spokenWords = (value: string) =>
  value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** True when every word of `text` is a word that the person said. */
const ownWords = (text: string, spoken: string) => {
  const own = new Set(spokenWords(spoken));
  return spokenWords(text).every((word) => own.has(word));
};
const clean = (value: string, max: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

// Only direct mailbox-access requests. Pasted email text, coding tasks and
// explicit instructions to an existing agent continue through their own paths.
const directMailboxRequest =
  /^(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:check|read|summari[sz]e|review|open|search)(?:\s+and\s+(?:check|read|summari[sz]e|review|search))?\s+(?:(?:my|our|the)\s+)?(?:e-?mails?|inbox|gmail|outlook)(?:\s+(?:please|today|from today|from yesterday|for me))?[.!?]*$/i;
const mailboxUnavailable =
  "I cannot access your inbox because ClawdTime has no email integration. You can paste email text here for a summary; approval will not connect your mailbox.";
const bareDecision =
  /^(?:(?:yes|okay|ok|please)[, ]+)?(?:approve|approve it|allow|allow it|deny|deny it|go ahead|do it|yes|no|okay|ok|sure|proceed|accept|confirm)[.!?]*$/i;
const noPendingDecision =
  "There is no pending request to approve or deny. Nothing was authorized.";
const invitesApproval =
  /\b(?:say|reply(?: with)?|respond(?: with)?)\s+["“']?(?:approve|deny|yes or no|allow)\b|\b(?:I|we)\s+(?:need|require)\s+your\s+(?:approval|permission|confirmation)\b|\bplease\s+(?:approve|authorize)\b/i;

// What the person's own words must say before the task changes. The model
// chooses a tool; these decide whether the tool acts.
const startCue =
  /\b(?:start|begin|take|open|create|add|queue|launch|kick off|give (?:you|yourself|it|clawdtime))\b[^.?!]{0,40}\b(?:task|job)\b|\b(?:new|a|another|this|one)\s+(?:task|job)\s*[:,-]|^\s*(?:task|job)\s*[:,-]|\b(?:task|job)\s+for\s+you\b/i;
/** A sentence that asks about something. It never changes the task. */
const asksAbout = (spoken: string) =>
  /^\s*(?:did|has|have|had|is|are|was|were|what|why|how|when|where|who|which)\b/i.test(
    spoken,
  );
const isQuestion = (spoken: string) =>
  asksAbout(spoken) || /\?\s*$/.test(spoken);
const asksToStart = (spoken: string) =>
  startCue.test(spoken) && !asksAbout(spoken);
/** The goal in the person's sentence: what follows the word task or job. */
function goalFrom(spoken: string) {
  const text = clean(spoken, 8000);
  const cue = /\b(?:task|job)\b/i.exec(text);
  if (!cue) return "";
  return text
    .slice(cue.index + cue[0].length)
    .replace(/^\s*(?:for (?:you|clawdtime)\b)?\s*[.:,;-]?\s*/i, "")
    .replace(/^(?:is to|to|that|which|is)\s+/i, "")
    .replace(/[.!?\s]+$/, "")
    .trim();
}
const saysAccept = (spoken: string, requestsWaiting: number) =>
  !isQuestion(spoken) &&
  (/\baccept(?:ed|ing)?\b/i.test(spoken) ||
    /\b(?:approve|take|keep)\b[^.?!]{0,30}\b(?:result|task|work|changes?)\b/i.test(
      spoken,
    ) ||
    (requestsWaiting === 0 && /\b(?:looks good|lgtm|ship it)\b/i.test(spoken)));
const saysCancel = (spoken: string) =>
  !isQuestion(spoken) &&
  (/\bcancel\b/i.test(spoken) ||
    /\b(?:abort|drop|stop|kill|end)\b[^.?!]{0,20}\b(?:task|job)\b/i.test(
      spoken,
    ));
const needsDesktop =
  "Tasks need ClawdTime's desktop service. It is not running here.";

/** The task in one or two sentences that can be said aloud. */
function taskLine(task: TaskFacts) {
  const goal = clean(task.goal, 160);
  let line = `Task: "${goal}" is ${taskStateWords(task.state)}.`;
  if (task.question && task.canAnswer) {
    line += ` It waits for the person and asks: ${clean(task.question, 300)}`;
    if (task.choices.length) line += ` Choices: ${task.choices.join(", ")}.`;
  }
  if (task.canAccept)
    line += " Its result waits for the person's review: they can accept it.";
  return line;
}

/** What one turn of the conversation did, so that it does each thing once. */
interface Turn {
  /** Names this turn to the task service: the same turn never acts twice. */
  id: string;
  /** The turn looked at the task, so its answer may offer the task's choices. */
  sawTask: boolean;
  done: Map<string, string>;
}

export class Supervisor {
  constructor(
    private readonly world: SupervisorWorld,
    private readonly model: ModelClient | null,
  ) {}
  get ready() {
    return this.model !== null;
  }
  /**
   * What still runs after the last answer: memory that is being written. A
   * command that ends at once waits for it. It never rejects.
   */
  learning: Promise<void> = Promise.resolve();
  /** The memory, when the person turned it on. Off means that it does not exist for the agent. */
  private memory(): Memory | null {
    const memory = this.world.desk.memory;
    return memory.enabled() ? memory : null;
  }

  /** The state in words: the base of every answer, and the whole answer with no model. */
  status() {
    const board = this.world.board();
    const now = this.world.now();
    const pending = this.world.desk.pending();
    const lines: string[] = [];
    lines.push(
      board
        ? `Sessions: ${summary(board.counts)}.`
        : "The agent board is not available.",
    );
    for (const session of (board?.sessions ?? []).slice(0, 30))
      lines.push(
        `- ${title(session)} (${session.agentLabel}${session.host ? ` on the Mac ${session.host}` : ""}): ${detailLabels[session.detail]}${session.since ? ` for ${elapsed(session.since, now)}` : ""}`,
      );
    lines.push(
      pending.length
        ? `Requests that wait for an answer: ${pending.length}.`
        : "No request waits for an answer here.",
    );
    pending.forEach((request, index) =>
      lines.push(
        `${index + 1}. ${request.agent} in ${request.cwd?.split("/").filter(Boolean).at(-1) ?? "?"} ${request.kind === "question" ? "asks" : "asks to run"}: ${request.summary.slice(0, 200)}${request.options.length ? ` Choices: ${request.options.join(", ")}.` : ""}`,
      ),
    );
    const found = this.world.incidents?.() ?? [];
    if (found.length) {
      lines.push(`The watcher found ${found.length}:`);
      for (const sentence of found.slice(0, 10)) lines.push(`- ${sentence}`);
    }
    lines.push(
      this.world.desk.away() ? "Away mode is on." : "Away mode is off.",
    );
    if (this.world.tasks) {
      const task = this.world.tasks.current();
      lines.push(task ? taskLine(task) : "No task is active.");
    }
    if (this.world.execution)
      lines.push(this.world.execution.snapshot().message);
    return lines.join("\n");
  }

  /**
   * True when the person's words name the task while one is live. Such a
   * sentence is about the task: it never answers an agent's request.
   */
  private namesTask(spoken: string) {
    const task = this.world.tasks?.current();
    return !!task && !taskIsOver(task) && /\b(?:task|job)\b/i.test(spoken);
  }

  /** One change to the task. A turn does each kind of change once. */
  private async change(
    turn: Turn,
    kind: "start" | "answer" | "accept" | "cancel",
    act: (tasks: TaskPort, eventId: string) => Promise<{ message: string }>,
  ) {
    const tasks = this.world.tasks;
    if (!tasks) return needsDesktop;
    const before = turn.done.get(kind);
    if (before !== undefined) return before;
    turn.sawTask = true;
    let said: string;
    try {
      said = (await act(tasks, `${turn.id}_${kind}`)).message;
    } catch {
      said = "The task service did not take that.";
    }
    turn.done.set(kind, said);
    return said;
  }
  private async startTask(turn: Turn, spoken: string, wanted: string) {
    if (!this.world.tasks) return needsDesktop;
    // The person's own last words must ask for a task. The model alone cannot start one.
    if (!asksToStart(spoken))
      return "The person did not ask for a task in their last message. Ask them.";
    // The goal is what the person said. A goal that the model reworded is
    // replaced by the person's own sentence.
    const goal =
      wanted && spokenWords(wanted).length >= 2 && ownWords(wanted, spoken)
        ? wanted
        : goalFrom(spoken);
    if (spokenWords(goal).length < 2)
      return "The person gave no goal. Ask them what the task is.";
    return this.change(turn, "start", (tasks, eventId) =>
      tasks.start(goal.slice(0, 8000), eventId),
    );
  }
  private async answerTask(turn: Turn, spoken: string, wanted: string) {
    const tasks = this.world.tasks;
    if (!tasks) return needsDesktop;
    const task = tasks.current();
    if (!task?.question || !task.canAnswer) return "The task asks nothing now.";
    if (isQuestion(spoken))
      return "The person asked a question. That is not an answer. Tell them what the task asks.";
    // A named choice goes as that choice. Anything else goes in the person's words.
    const named = task.choices.length
      ? interpret(spoken, { kind: "question", options: task.choices })
      : null;
    const text =
      named?.decision === "answer" && named.text
        ? named.text
        : wanted && ownWords(wanted, spoken)
          ? wanted
          : clean(spoken, 8000);
    return this.change(turn, "answer", (port, eventId) =>
      port.answer(text, eventId),
    );
  }
  private async acceptTask(turn: Turn, spoken: string) {
    if (!this.world.tasks) return needsDesktop;
    if (!saysAccept(spoken, this.world.desk.pending().length))
      return "The person did not clearly say to accept. Ask them.";
    return this.change(turn, "accept", (tasks, eventId) =>
      tasks.accept(eventId),
    );
  }
  private async cancelTask(turn: Turn, spoken: string) {
    if (!this.world.tasks) return needsDesktop;
    if (!saysCancel(spoken))
      return "The person did not clearly say to cancel. Ask them.";
    return this.change(turn, "cancel", (tasks, eventId) =>
      tasks.cancel(eventId),
    );
  }
  /** The choices to show as buttons: those of the question that the task asks, when the turn spoke of the task. */
  private offer(turn: Turn) {
    if (!turn.sawTask) return [];
    const task = this.world.tasks?.current();
    if (!task?.question || !task.canAnswer) return [];
    const choices = task.choices.map((choice) => clean(choice, 200));
    return choices.length <= 4 &&
      choices.every((choice) => choice && choice.length <= 80)
      ? choices
      : [];
  }

  private session(name: string) {
    const sessions = this.world.board()?.sessions ?? [];
    const wanted = name.toLowerCase().trim();
    const exact = sessions.filter(
      (session) => title(session).toLowerCase() === wanted,
    );
    const found = exact.length
      ? exact
      : sessions.filter((session) =>
          title(session).toLowerCase().includes(wanted),
        );
    return found.length === 1 ? found[0]! : null;
  }
  private decide(
    request: DecisionRequest | undefined,
    spoken: string,
    via: ChatMessage["via"],
    wanted: { decision: string },
  ) {
    if (!request) return "No request has that number.";
    if (this.namesTask(spoken))
      return "The person spoke about the task, not about this request. Use the task tools, or ask them.";
    // The person's own last words must say it. The model alone cannot decide.
    const said = interpret(spoken, request);
    if (!said || said.decision !== wanted.decision)
      return "The person did not clearly say that. Ask them.";
    const ok = this.world.desk.answer(request.id, {
      decision: said.decision,
      text: said.text,
      via: via === "call" ? "call" : "panel",
    });
    if (!ok) return "That request no longer waits here.";
    return said.decision === "allow"
      ? "Allowed. The agent continues."
      : said.decision === "deny"
        ? "Denied. The agent is told."
        : `Answered: ${said.text}.`;
  }

  private async delegate(turn: Turn, spoken: string): Promise<string> {
    const execution = this.world.execution;
    if (!execution?.snapshot().configured)
      return "No computer executor is connected.";
    // A model cannot turn questions, approvals or scoped coding tasks into execution.
    const action =
      /^(?:(?:can|could|would|will)\s+(?:you|u)\s+)?(?:please\s+)?(?:check|read|summari[sz]e|review|open|search|find|browse|navigate|click|type|fill|download|compare|inspect|use|look|go|scroll|select)\b/i.test(
        spoken,
      );
    if (
      !action ||
      asksAbout(spoken) ||
      bareDecision.test(spoken) ||
      asksToStart(spoken) ||
      /\b(?:status|progress|pending requests?)\b/i.test(spoken)
    )
      return "That message is not a computer action request. Nothing was delegated.";
    const previous = turn.done.get("execution");
    if (previous !== undefined) return previous;
    let result: string;
    try {
      result = (await execution.submit(`${turn.id}_execution`, spoken)).message;
    } catch {
      result =
        "Computer task delivery is uncertain. It was not retried; check execution status.";
    }
    turn.done.set("execution", result);
    return result;
  }

  private async run(
    call: ToolCall,
    spoken: string,
    via: ChatMessage["via"],
    turn: Turn,
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      return "The arguments were not valid.";
    }
    switch (call.name) {
      case "delegate_computer_task":
        return this.delegate(turn, spoken);
      case "status":
        turn.sawTask = true;
        return this.status();
      case "task_status": {
        if (!this.world.tasks) return needsDesktop;
        turn.sawTask = true;
        const task = this.world.tasks.current();
        return task
          ? `${taskLine(task)} ${clean(task.summary, 300)}`
          : "No task is active.";
      }
      case "start_task":
        return this.startTask(
          turn,
          spoken,
          clean(String(args.goal ?? ""), 8000),
        );
      case "answer_task":
        return this.answerTask(
          turn,
          spoken,
          clean(String(args.text ?? ""), 8000),
        );
      case "accept_task":
        return this.acceptTask(turn, spoken);
      case "cancel_task":
        return this.cancelTask(turn, spoken);
      case "decide":
        return this.decide(
          this.world.desk.pending()[Number(args.request) - 1],
          spoken,
          via,
          { decision: String(args.decision) },
        );
      case "open_session": {
        const session = this.session(String(args.session ?? ""));
        if (!session) return "No single session has that name.";
        return (await this.world.focus(session)).ok
          ? `Opened ${title(session)}.`
          : `${title(session)} has no terminal on this Mac to open.`;
      }
      case "type_into_session": {
        const session = this.session(String(args.session ?? ""));
        const text = clean(String(args.text ?? ""), 2000);
        if (!session) return "No single session has that name.";
        if (!text || !spoken.toLowerCase().includes(text.toLowerCase()))
          return "Only the person's own words are typed. Ask them for the exact text.";
        const sent = await this.world.send(session, text);
        return sent.ok
          ? `Typed into ${title(session)}.`
          : `${title(session)} runs in a terminal that cannot take text from here.`;
      }
      case "search_trove": {
        const query = String(args.query ?? "");
        const found = this.world.desk.trove.search(query, 8);
        // A critical decision the person stated counts when it shares a word with the question.
        const wanted = spokenWords(query).filter((word) => word.length > 2);
        const notes = this.world.desk.trove
          .notes()
          .filter((note) => {
            const text = note.text.toLowerCase();
            return wanted.some((word) => text.includes(word));
          })
          .slice(-6);
        const lines = [
          ...notes.map(
            (note) =>
              `${new Date(note.at).toISOString().slice(0, 10)} the person decided: ${note.text.slice(0, 200)}`,
          ),
          ...found.map(
            (entry) =>
              `${new Date(entry.at).toISOString().slice(0, 10)} ${entry.decision} ${entry.agent} in ${entry.project}: ${entry.summary.slice(0, 120)}${entry.text ? ` (${entry.text.slice(0, 80)})` : ""}`,
          ),
        ];
        return lines.length
          ? lines.join("\n")
          : "Nothing in the trove matches.";
      }
      case "note_decision": {
        const text = clean(String(args.text ?? ""), 2000);
        if (!text) return "There was no text to keep.";
        // The trove keeps what the person said. When the model's wording adds a
        // word that the person did not say, the person's own sentence is kept.
        this.world.desk.trove.note(
          ownWords(text, spoken) ? text : clean(spoken, 2000),
          null,
          this.world.now(),
        );
        return "Kept in the trove as a critical decision.";
      }
      case "remember":
      case "recall":
      case "forget": {
        const memory = this.memory();
        if (!memory) return "There is no such tool.";
        try {
          if (call.name === "recall") {
            const found = memory.search(String(args.query ?? ""));
            return found.length
              ? found
                  .map(
                    ({ fact }) =>
                      `${fact.id} ${fact.text}${fact.source === "inferred" ? " (inferred)" : ""}`,
                  )
                  .join("\n")
              : "Nothing in memory matches.";
          }
          if (call.name === "forget") {
            // Only the person's own last words remove something.
            if (!/\b(forget|delete|remove|erase)\b/i.test(spoken))
              return "The person did not ask to forget. Ask them.";
            const removed = memory.forget(String(args.what ?? ""));
            return removed
              ? `Removed ${removed} from memory.`
              : "Nothing in memory matches that.";
          }
          const text = clean(String(args.text ?? ""), 400);
          if (!text) return "There was no text to keep.";
          // Memory keeps the person's words, as the trove does.
          memory.remember({
            text: ownWords(text, spoken) ? text : clean(spoken, 400),
            kind: factKinds.includes(args.kind as FactKind)
              ? (args.kind as FactKind)
              : "fact",
            days: typeof args.days === "number" ? args.days : null,
            source: "said",
          });
          return "Kept in memory.";
        } catch (error) {
          return error instanceof Error
            ? error.message
            : "Memory could not be changed.";
        }
      }
      case "set_away":
        this.world.desk.setAway(args.away === true);
        return args.away === true ? "Away mode is on." : "Away mode is off.";
      case "agent_commands":
        return (
          this.world
            .clis()
            .map(
              (cli) =>
                `${cli.label} ${cli.version ?? ""}: ${cli.runningNow} running, ${cli.sessionsLast7Days ?? "?"} sessions in 7 days`,
            )
            .join("\n") || "No agent command was found."
        );
      default:
        return "There is no such tool.";
    }
  }

  /**
   * With no language model: a clear yes or no to the one waiting request, a
   * plain word about the task, else the state.
   */
  private async plain(spoken: string, via: ChatMessage["via"], turn: Turn) {
    const pending = this.world.desk.pending();
    const tasks = this.world.tasks;
    const task = tasks?.current() ?? null;
    const asks = !!task?.question && task.canAnswer;
    // A sentence that names the task is about the task, even while an agent
    // waits: "cancel the task" must never deny that agent's request.
    const named = this.namesTask(spoken);
    if (tasks) {
      if (asksToStart(spoken)) return this.startTask(turn, spoken, "");
      if (
        task?.canCancel &&
        /\bcancel\b[^.?!]{0,20}\b(?:task|job)\b/i.test(spoken) &&
        !isQuestion(spoken)
      )
        return this.cancelTask(turn, spoken);
      if (named && task?.canAccept && saysAccept(spoken, 0))
        return this.acceptTask(turn, spoken);
    }
    // Any other yes or no belongs to the one agent that waits.
    if (pending.length === 1 && !named) {
      const said = interpret(spoken, pending[0]!);
      if (said) return this.decide(pending[0], spoken, via, said);
    }
    if (tasks) {
      if (task?.canAccept && saysAccept(spoken, pending.length))
        return this.acceptTask(turn, spoken);
      // An answer goes to the task only when nothing else could take it.
      if (task && asks && !pending.length && !isQuestion(spoken)) {
        const clear = task.choices.length
          ? interpret(spoken, { kind: "question", options: task.choices })
              ?.decision === "answer"
          : spokenWords(spoken).length >= 3 ||
            interpret(spoken, { kind: "permission", options: [] }) !== null;
        if (clear) return this.answerTask(turn, spoken, "");
      }
    }
    const board = this.world.board();
    const waiting = (board?.sessions ?? [])
      .filter((session) => session.state === "needs_you")
      .map((session) => title(session));
    const head = pending.length
      ? `${pending.length === 1 ? "One request waits" : `${pending.length} requests wait`} for your answer: ${pending[0]!.summary.slice(0, 120)}.`
      : waiting.length
        ? `${waiting.slice(0, 3).join(", ")} ${waiting.length === 1 ? "needs" : "need"} you.`
        : board
          ? `${summary(board.counts)}.`
          : "I cannot see the agents now.";
    let about = "";
    if (task && !taskIsOver(task)) {
      turn.sawTask = true;
      about = ` Your task "${clean(task.goal, 80)}" is ${taskStateWords(task.state)}.`;
      if (asks) {
        about += ` It asks: ${clean(task.question!, 200)}`;
        if (task.choices.length)
          about += ` Choices: ${task.choices.join(", ")}.`;
      }
      if (task.canAccept) about += " Say accept to take its result.";
    }
    // It invites an answer only when something here can take one.
    const tail = pending.length
      ? " Say approve or deny to answer a request."
      : asks
        ? " Say your answer and I pass it to the task."
        : "";
    return `${head}${about}${tail}`;
  }

  /**
   * After an answer: one more question to the model, with no tools, for the
   * lasting facts in the person's message. A fact in the person's own words is
   * marked as said; one that the model worded is marked as inferred.
   */
  private async learn(memory: Memory, spoken: string) {
    if (!this.model || spokenWords(spoken).length < 5) return;
    const near = memory.search(spoken, { limit: 8, threshold: 0.15 });
    const turn = await this.model.complete({
      system: learnSystem,
      messages: [
        {
          role: "user",
          content: `Known facts:\n${near.map(({ fact }) => `${fact.id} ${fact.text}`).join("\n") || "none"}\n\nThe person said:\n${spoken}`,
        },
      ],
      tools: [],
    });
    const start = turn.text.indexOf("[");
    const end = turn.text.lastIndexOf("]");
    if (start < 0 || end <= start) return;
    const proposed = proposalSchema.safeParse(
      JSON.parse(turn.text.slice(start, end + 1)),
    );
    if (!proposed.success) return;
    for (const item of proposed.data.slice(0, 3)) {
      try {
        memory.remember({
          text: item.text,
          kind: item.kind,
          days: item.days ?? null,
          replaces: item.replaces ?? null,
          source: ownWords(item.text, spoken) ? "said" : "inferred",
        });
      } catch {
        // A line that memory refuses, such as a credential, is left out.
      }
    }
  }

  /** One turn: the person's words in, ClawdTime's answer out. It never throws. */
  async reply(
    history: ChatMessage[],
    spoken: string,
    via: ChatMessage["via"],
  ): Promise<string> {
    return (await this.answer(history, spoken, via)).text;
  }

  /**
   * One turn, with the choices that the person can pick with one click when
   * the answer passes on a question of the task. It never throws.
   */
  async answer(
    history: ChatMessage[],
    spoken: string,
    via: ChatMessage["via"],
  ): Promise<{ text: string; choices: string[] }> {
    const turn: Turn = {
      id: `talk_${randomBytes(8).toString("hex")}`,
      sawTask: false,
      done: new Map(),
    };
    const text = await this.turn(history, spoken, via, turn);
    let choices: string[] = [];
    try {
      choices = this.offer(turn);
    } catch {
      choices = [];
    }
    return { text, choices };
  }

  private async turn(
    history: ChatMessage[],
    spoken: string,
    via: ChatMessage["via"],
    turn: Turn,
  ): Promise<string> {
    const words = clean(spoken, 2000);
    if (!words) return "I did not catch that.";
    const execution = this.world.execution;
    if (execution?.snapshot().configured) {
      if (
        /^(?:please\s+)?(?:stop|cancel|abort)(?:\s+(?:computer(?: task)?|execution|browser(?: task)?))?[.!?]*$/i.test(
          words,
        )
      )
        return execution.stop().message;
      if (
        /^(?:(?:what(?:'s| is)|check)\s+)?(?:computer(?: task)?|execution|browser(?: task)?)\s+status[.!?]*$/i.test(
          words,
        )
      )
        return execution.snapshot().message;
    }
    if (directMailboxRequest.test(words))
      return execution?.snapshot().configured
        ? this.delegate(turn, words)
        : mailboxUnavailable;
    const hasDecisionTarget = () => {
      const task = this.world.tasks?.current();
      return (
        this.world.desk.pending().length > 0 ||
        !!(task && !taskIsOver(task) && (task.canAnswer || task.canAccept))
      );
    };
    if (bareDecision.test(words) && !hasDecisionTarget())
      return noPendingDecision;
    if (!this.model) return this.plain(words, via, turn);
    const messages: ModelMessage[] = [
      ...history
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.text })),
      { role: "user" as const, content: words },
    ];
    // With memory on, the agent starts from what it knows about the person.
    const memory = this.memory();
    let known = "";
    try {
      known = memory?.profile() ?? "";
    } catch {
      known = "";
    }
    const brief = known
      ? `${system}\nWhat you know about this person, from memory (a line marked inferred is a guess):\n${known}`
      : system;
    const offered = [
      ...tools,
      ...(memory ? memoryTools : []),
      ...(execution?.snapshot().configured ? [executionTool] : []),
    ];
    try {
      for (let step = 0; step < 6; step++) {
        const task = this.world.tasks?.current();
        // Only authoritative flags/counts enter this instruction. Request text
        // and session names remain untrusted tool data, not system instructions.
        const current = `Current service facts: pending desk requests=${this.world.desk.pending().length}; task can answer=${!!(task && !taskIsOver(task) && task.canAnswer)}; task can accept=${!!(task && !taskIsOver(task) && task.canAccept)}. These facts take precedence over chat history.`;
        const reply = await this.model.complete({
          system: `${brief}\n${current}`,
          messages,
          tools: offered,
        });
        if (!reply.toolCalls.length) {
          if (invitesApproval.test(reply.text) && !hasDecisionTarget())
            return "There is no pending request to approve or deny.";
          // The answer is ready. What the message teaches is written after it.
          if (memory) this.learning = this.learn(memory, words).catch(() => {});
          return clean(reply.text, 900) || "Done.";
        }
        messages.push({
          role: "assistant",
          content: reply.text,
          toolCalls: reply.toolCalls,
        });
        for (const call of reply.toolCalls.slice(0, 6)) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: (await this.run(call, words, via, turn)).slice(0, 6000),
          });
          const executionResult = turn.done.get("execution");
          if (executionResult !== undefined) return executionResult;
        }
      }
      return "That took too many steps. Ask me again in a simpler way.";
    } catch {
      // No model now: the plain answer still tells the state and takes a clear yes or no.
      return this.plain(words, via, turn);
    }
  }
}
