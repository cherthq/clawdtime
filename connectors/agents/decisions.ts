import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import {
  decisionKinds,
  decisionValues,
  decisionVias,
  requestPattern,
  Trove,
  type TroveEntry,
} from "./trove.js";
import { agentKinds, type AgentKind } from "./types.js";

/**
 * The decision desk: how the person answers an agent without its terminal.
 * An agent's hook puts a request on the desk and waits a short time. The
 * panel, the command line or a phone call puts the answer next to it, and the
 * hook hands that answer to the agent. With no answer the hook gives up
 * silently and the agent shows its own prompt, exactly as it does with no hook.
 */
export const deskDirectory = (root: string) =>
  join(root, "agents", "decisions");

const text = (max: number) => z.string().max(max);
export const requestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{16}$/),
    agent: z.enum(agentKinds),
    /** A hash of the agent's own session identifier. */
    sessionKey: z.string().regex(/^[0-9a-f]{32}$/),
    cwd: text(4096).nullable(),
    /** The hook's parent processes, nearest first: they tie the request to a session on the board. */
    pids: z.array(z.number().int().positive()).max(3),
    kind: z.enum(decisionKinds),
    tool: text(80),
    summary: text(600),
    pattern: text(160),
    /** The choices of a question. Empty for a permission. */
    options: z.array(text(200)).max(8),
    createdAt: z.number().int().nonnegative(),
    /** After this time the hook stops waiting and the agent asks in its terminal. */
    holdUntil: z.number().int().nonnegative(),
  })
  .strict();
export type DecisionRequest = z.infer<typeof requestSchema>;

export const answerSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{16}$/),
    decision: z.enum(decisionValues),
    text: text(600).nullable(),
    via: z.enum(decisionVias),
    /** The person asked to repeat this answer for the same request in this project. */
    remember: z.boolean(),
    at: z.number().int().nonnegative(),
  })
  .strict();
export type DecisionAnswer = z.infer<typeof answerSchema>;

const attendanceSchema = z
  .object({ version: z.literal(1), at: z.number().int().nonnegative() })
  .strict();
const modeSchema = z
  .object({
    version: z.literal(1),
    away: z.boolean(),
    since: z.number().int().nonnegative(),
  })
  .strict();

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const clip = (value: unknown, max: number) =>
  typeof value === "string"
    ? value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";

export interface Described {
  kind: (typeof decisionKinds)[number];
  tool: string;
  summary: string;
  options: string[];
}

/**
 * What a hook payload asks the person, or null when the desk cannot answer it.
 * Permission requests of Claude Code and Codex, and a Claude Code question with
 * one single-choice question or a plan to approve.
 */
export function describeRequest(
  input: Record<string, unknown>,
): Described | null {
  const tool = clip(input.tool_name, 80);
  const toolInput = record(input.tool_input) ?? {};
  if (input.hook_event_name === "PermissionRequest") {
    if (!tool) return null;
    const command = Array.isArray(toolInput.command)
      ? toolInput.command.filter((part) => typeof part === "string").join(" ")
      : toolInput.command;
    const summary =
      clip(command, 600) ||
      clip(
        toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path,
        600,
      ) ||
      clip(
        toolInput.url ??
          toolInput.query ??
          toolInput.description ??
          toolInput.prompt,
        600,
      ) ||
      tool;
    return { kind: "permission", tool, summary, options: [] };
  }
  if (input.hook_event_name !== "PreToolUse") return null;
  if (tool === "AskUserQuestion") {
    const questions = Array.isArray(toolInput.questions)
      ? toolInput.questions
      : [];
    const only = questions.length === 1 ? record(questions[0]) : null;
    if (!only || only.multiSelect === true) return null;
    const options = (Array.isArray(only.options) ? only.options : [])
      .map((option) => clip(record(option)?.label, 200))
      .filter(Boolean)
      .slice(0, 8);
    const question = clip(only.question, 600);
    if (!question || !options.length) return null;
    return { kind: "question", tool, summary: question, options };
  }
  if (tool === "ExitPlanMode")
    return {
      kind: "plan",
      tool,
      summary: clip(toolInput.plan, 600) || "A plan is ready for review.",
      options: [],
    };
  return null;
}

/** The exact output that hands the answer to the agent. null: say nothing. */
export function hookOutput(
  input: Record<string, unknown>,
  request: Pick<DecisionRequest, "kind">,
  answer: Pick<DecisionAnswer, "decision" | "text">,
): string | null {
  const reason = answer.text || "Declined from ClawdTime.";
  if (request.kind === "permission") {
    const decision =
      answer.decision === "allow"
        ? { behavior: "allow" }
        : answer.decision === "deny"
          ? { behavior: "deny", message: reason }
          : null;
    return decision
      ? JSON.stringify({
          hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
        })
      : null;
  }
  const toolInput = record(input.tool_input) ?? {};
  if (answer.decision === "deny")
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  if (request.kind === "plan" && answer.decision === "allow")
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: toolInput,
      },
    });
  if (
    request.kind === "question" &&
    answer.decision === "answer" &&
    answer.text
  ) {
    const questions = Array.isArray(toolInput.questions)
      ? toolInput.questions
      : [];
    const question = record(questions[0])?.question;
    if (typeof question !== "string") return null;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, answers: { [question]: answer.text } },
      },
    });
  }
  return null;
}

/**
 * Whether the hook waits for an answer from the desk, and how long. It waits
 * only while someone attends the desk. The agent shows its own prompt at the
 * same time, so the person can still answer in the terminal: the first answer
 * wins. Away mode waits long enough for a phone call.
 */
export function holdPolicy(facts: { attended: boolean; away: boolean }): {
  hold: boolean;
  seconds: number;
} {
  if (!facts.attended) return { hold: false, seconds: 0 };
  return { hold: true, seconds: facts.away ? 540 : 45 };
}

export class DecisionDesk {
  private readonly directory: string;
  readonly trove: Trove;
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = deskDirectory(root);
    this.trove = new Trove(root);
  }
  private path(kind: "pending" | "answers", id: string) {
    return join(this.directory, kind, `${id}.json`);
  }
  private read<T>(file: string, schema: z.ZodType<T>): T | null {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 16_384) return null;
      return schema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  /** The supervisor says that it is here. A hook holds only while this is fresh. */
  attend() {
    secureWrite(join(this.directory, "attending.json"), {
      version: 1,
      at: this.now(),
    });
  }
  attended() {
    const seen = this.read(
      join(this.directory, "attending.json"),
      attendanceSchema,
    );
    return seen !== null && this.now() - seen.at < 10_000;
  }
  /** Away: the person is not at the Mac. Requests wait for a phone call. */
  setAway(away: boolean) {
    secureWrite(join(this.directory, "mode.json"), {
      version: 1,
      away,
      since: this.now(),
    });
  }
  away() {
    return (
      this.read(join(this.directory, "mode.json"), modeSchema)?.away === true
    );
  }

  open(facts: {
    agent: AgentKind;
    sessionId: string;
    cwd: string | null;
    pids: number[];
    described: Described;
    holdSeconds: number;
  }): DecisionRequest {
    const at = this.now();
    const request = requestSchema.parse({
      version: 1,
      id: randomBytes(8).toString("hex"),
      agent: facts.agent,
      sessionKey: createHash("sha256")
        .update(facts.sessionId)
        .digest("hex")
        .slice(0, 32),
      cwd: facts.cwd?.slice(0, 4096) ?? null,
      pids: facts.pids
        .filter((pid) => Number.isInteger(pid) && pid > 1)
        .slice(0, 3),
      kind: facts.described.kind,
      tool: facts.described.tool,
      summary: facts.described.summary,
      pattern: requestPattern(facts.described.tool, facts.described.summary),
      options: facts.described.options,
      createdAt: at,
      holdUntil: at + Math.round(facts.holdSeconds * 1000),
    });
    secureWrite(this.path("pending", request.id), request);
    return request;
  }
  /** Requests that still wait. One that ran out of time is removed. */
  pending(): DecisionRequest[] {
    const directory = join(this.directory, "pending");
    let names: string[] = [];
    try {
      names = readdirSync(directory).filter((name) =>
        /^[0-9a-f]{16}\.json$/.test(name),
      );
    } catch {
      return [];
    }
    const result: DecisionRequest[] = [];
    for (const name of names.slice(0, 200)) {
      const request = this.read(join(directory, name), requestSchema);
      // A hook that died leaves its request behind: it goes after its hold time.
      if (!request || this.now() > request.holdUntil + 5000) {
        rmSync(join(directory, name), { force: true });
        continue;
      }
      if (this.now() <= request.holdUntil) result.push(request);
    }
    return result.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  }
  get(id: string) {
    return /^[0-9a-f]{16}$/.test(id)
      ? this.read(this.path("pending", id), requestSchema)
      : null;
  }
  /** Puts the person's answer on the desk. False when the request no longer waits. */
  answer(
    id: string,
    answer: {
      decision: DecisionAnswer["decision"];
      text?: string | null;
      via: DecisionAnswer["via"];
      remember?: boolean;
    },
  ): boolean {
    const request = this.get(id);
    if (!request || this.now() > request.holdUntil) return false;
    if (
      request.kind === "question"
        ? answer.decision === "allow"
        : answer.decision === "answer"
    )
      return false;
    if (
      request.kind === "question" &&
      answer.decision === "answer" &&
      !answer.text?.trim()
    )
      return false;
    if (existsSync(this.path("answers", id))) return false;
    secureWrite(
      this.path("answers", id),
      answerSchema.parse({
        version: 1,
        id,
        decision: answer.decision,
        text: answer.text?.trim().slice(0, 600) || null,
        via: answer.via,
        remember:
          answer.remember === true &&
          answer.decision === "allow" &&
          request.kind === "permission",
        at: this.now(),
      }),
    );
    return true;
  }
  /** The hook's side: the answer, if one came. */
  take(id: string) {
    return this.read(this.path("answers", id), answerSchema);
  }
  /** The hook is done with the request: both files go, and the trove keeps the decision. */
  close(
    request: DecisionRequest,
    answer: DecisionAnswer | null,
  ): TroveEntry | null {
    rmSync(this.path("pending", request.id), { force: true });
    rmSync(this.path("answers", request.id), { force: true });
    if (!answer) return null;
    const entry = this.trove.record({
      at: answer.at,
      agent: request.agent,
      project: request.cwd ? basename(request.cwd).slice(0, 120) || "/" : "",
      cwd: request.cwd,
      kind: request.kind,
      tool: request.tool,
      pattern: request.pattern,
      summary: request.summary,
      decision: answer.decision,
      text: answer.text,
      via: answer.via,
      waitedSeconds: Math.max(0, (answer.at - request.createdAt) / 1000),
    });
    if (answer.remember)
      try {
        this.trove.addRule(
          request,
          `From the answer of ${new Date(answer.at).toISOString().slice(0, 10)}.`,
          answer.at,
        );
      } catch {
        // A request that is too broad for a rule is still answered this once.
      }
    return entry;
  }
}
