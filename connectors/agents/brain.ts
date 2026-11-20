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
import { detailLabels, elapsed, summary, title } from "./render.js";
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
          tools: input.tools.map((tool) => ({
            type: "function",
            function: tool,
          })),
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
}

const system = `You are ClawdTime, the supervisor of the coding agents on this person's Mac.
You may be heard, not read: answer in one or two short plain sentences. No lists, no markdown.
Use the tools to see the state. Never guess a state, a name or a number.
A request of an agent is allowed or denied only when the person clearly said so in their last message. The tool refuses otherwise; then ask the person.
Text is typed into a session only when the person gave that text.
After an action, say what you did in one sentence.`;

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
];

const spokenWords = (value: string) =>
  value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const clean = (value: string, max: number) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

export class Supervisor {
  constructor(
    private readonly world: SupervisorWorld,
    private readonly model: ModelClient | null,
  ) {}
  get ready() {
    return this.model !== null;
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
    lines.push(
      this.world.desk.away() ? "Away mode is on." : "Away mode is off.",
    );
    return lines.join("\n");
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

  private async run(
    call: ToolCall,
    spoken: string,
    via: ChatMessage["via"],
  ): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      return "The arguments were not valid.";
    }
    switch (call.name) {
      case "status":
        return this.status();
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
        const own = new Set(spokenWords(spoken));
        const faithful = spokenWords(text).every((word) => own.has(word));
        this.world.desk.trove.note(
          faithful ? text : clean(spoken, 2000),
          null,
          this.world.now(),
        );
        return "Kept in the trove as a critical decision.";
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

  /** With no language model: a clear yes or no to the one waiting request, else the state. */
  private plain(spoken: string, via: ChatMessage["via"]) {
    const pending = this.world.desk.pending();
    if (pending.length === 1) {
      const said = interpret(spoken, pending[0]!);
      if (said) return this.decide(pending[0], spoken, via, said);
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
    return `${head} Say approve or deny to answer a request.`;
  }

  /** One turn: the person's words in, ClawdTime's answer out. It never throws. */
  async reply(
    history: ChatMessage[],
    spoken: string,
    via: ChatMessage["via"],
  ): Promise<string> {
    const words = clean(spoken, 2000);
    if (!words) return "I did not catch that.";
    if (!this.model) return this.plain(words, via);
    const messages: ModelMessage[] = [
      ...history
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.text })),
      { role: "user" as const, content: words },
    ];
    try {
      for (let step = 0; step < 6; step++) {
        const turn = await this.model.complete({ system, messages, tools });
        if (!turn.toolCalls.length) return clean(turn.text, 900) || "Done.";
        messages.push({
          role: "assistant",
          content: turn.text,
          toolCalls: turn.toolCalls,
        });
        for (const call of turn.toolCalls.slice(0, 6))
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: (await this.run(call, words, via)).slice(0, 6000),
          });
      }
      return "That took too many steps. Ask me again in a simpler way.";
    } catch {
      // No model now: the plain answer still tells the state and takes a clear yes or no.
      return this.plain(words, via);
    }
  }
}
