import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Adapter } from "../../src/contracts.js";
import { ClawdTimeClient } from "../shared/client.js";
import { sessionCapabilities } from "../shared/protocol.js";
import { loadConnection, secureWrite } from "../shared/state.js";
import { agentLabel } from "./catalog.js";
import { deskDirectory, type DecisionRequest } from "./decisions.js";

/**
 * The phone: when the person is away, a request that waits becomes a FaceTime
 * call through the ClawdTime backend and its Chert line. The call asks the
 * question aloud, takes the spoken answer, and the answer goes back to the
 * agent through the same desk as a click in the panel.
 */
export interface CallClient {
  requestAttention(input: {
    taskId: string;
    idempotencyKey: string;
    reason: "approval" | "decision";
    question: string;
    timeoutSeconds?: number;
  }): Promise<{ request: { id: string; state: string } }>;
  conversationTurns(
    id: string,
    after?: number,
    timeoutMs?: number,
  ): Promise<{
    turns: unknown[];
    request?: { state: string };
    conversation?: { state: string };
  }>;
  conversationOperation(
    id: string,
    operation: "ack" | "progress" | "reply" | "end",
    body: unknown,
  ): Promise<unknown>;
  heartbeat(): Promise<unknown>;
}

const numbers = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
];
const ordinals = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
];

/** What the call says first: who asks, what, and how to answer. */
export function spokenQuestion(request: DecisionRequest) {
  const who = `${agentLabel(request.agent)}${request.cwd ? ` in ${request.cwd.split("/").filter(Boolean).at(-1)}` : ""}`;
  const what = request.summary.slice(0, 220);
  if (request.kind === "question")
    return `${who} asks: ${what} ${request.options.map((option, index) => `${numbers[index]}, ${option}.`).join(" ")} Say the number or the answer.`;
  if (request.kind === "plan")
    return `${who} has a plan ready. Say approve to start it, or deny.`;
  return `${who} asks to run ${request.tool === "Bash" ? "the command" : request.tool}: ${what}. Say approve or deny.`;
}

const refuse =
  /\b(deny|denied|decline|declined|reject|no|nope|don'?t|do not|stop|cancel|refuse|never)\b/;
const accept =
  /\b(approve|approved|allow|allowed|yes|yeah|yep|go ahead|do it|okay|ok|sure|proceed|accept|confirm)\b/;

/**
 * Reads one spoken sentence as an answer. It returns null when the words are
 * not clear, or say both yes and no: then the call asks again. Silence, noise
 * or an unrelated sentence is never an approval.
 */
export function interpret(
  spoken: string,
  request: Pick<DecisionRequest, "kind" | "options">,
): { decision: "allow" | "deny" | "answer"; text: string | null } | null {
  const words = spoken
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return null;
  if (request.kind === "question") {
    const chosen = new Set<number>();
    request.options.forEach((option, index) => {
      const label = option
        .toLowerCase()
        .replace(/[^a-z0-9' ]+/g, " ")
        .trim();
      if (
        label &&
        new RegExp(
          `\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        ).test(words)
      )
        chosen.add(index);
      if (
        new RegExp(
          `\\b(${numbers[index]}|${ordinals[index]}|${index + 1})\\b`,
        ).test(words)
      )
        chosen.add(index);
    });
    if (chosen.size === 1)
      return { decision: "answer", text: request.options[[...chosen][0]!]! };
    if (chosen.size === 0 && refuse.test(words))
      return { decision: "deny", text: spoken.trim().slice(0, 300) };
    return null;
  }
  const no = refuse.test(words),
    yes = accept.test(words);
  if (no === yes) return null;
  return no
    ? { decision: "deny", text: spoken.trim().slice(0, 300) }
    : { decision: "allow", text: null };
}

const turnSchema = z
  .object({
    id: z.string().min(1).max(200),
    sequence: z.number().int().nonnegative(),
    text: z.string().max(4000).optional(),
  })
  .passthrough();
const ended = [
  "completed",
  "declined",
  "unanswered",
  "canceled",
  "expired",
  "disconnected",
  "failed",
  "unknown",
];

/**
 * Places the call and waits for a clear spoken answer until the deadline.
 * null: nobody answered clearly. The request then stays as it is.
 */
export async function answerByCall(
  client: CallClient,
  request: DecisionRequest,
  options: {
    now: () => number;
    deadline: number;
    pollMs?: number;
    beatMs?: number;
  },
): Promise<{
  decision: "allow" | "deny" | "answer";
  text: string | null;
} | null> {
  const remaining = () => options.deadline - options.now();
  if (remaining() < 20_000) return null;
  const { request: attention } = await client.requestAttention({
    taskId: "clawdtime-supervisor",
    // The same request never places a second call.
    idempotencyKey: `decision-${request.id}`,
    reason: request.kind === "question" ? "decision" : "approval",
    question: spokenQuestion(request),
    timeoutSeconds: Math.max(20, Math.floor(remaining() / 1000)),
  });
  // The backend stops a session that is silent for 20 seconds.
  const beat = setInterval(
    () => void client.heartbeat().catch(() => {}),
    options.beatMs ?? 5000,
  );
  let cursor = 0,
    repeats = 0;
  const say = (turnId: string, text: string) =>
    client
      .conversationOperation(attention.id, "reply", {
        turnId,
        replyId: `reply-${turnId}`,
        text,
        expectedCursor: cursor,
      })
      .catch(() => {});
  try {
    while (remaining() > 0) {
      const page = await client.conversationTurns(
        attention.id,
        cursor,
        Math.max(1, Math.min(options.pollMs ?? 10_000, remaining())),
      );
      const turns = page.turns
        .flatMap((raw) => {
          const parsed = turnSchema.safeParse(raw);
          return parsed.success ? [parsed.data] : [];
        })
        .filter((turn) => turn.sequence > cursor)
        .sort((left, right) => left.sequence - right.sequence);
      for (const turn of turns) {
        cursor = turn.sequence;
        await client
          .conversationOperation(attention.id, "ack", { turnId: turn.id })
          .catch(() => {});
      }
      // The last thing the person said decides. Earlier fragments are context.
      const last = turns.at(-1);
      const answer = last?.text ? interpret(last.text, request) : null;
      if (last && answer) {
        await say(
          last.id,
          answer.decision === "allow"
            ? "Approved. It continues now."
            : answer.decision === "deny"
              ? "Denied. I told it."
              : `Answered: ${answer.text}.`,
        );
        await client
          .conversationOperation(attention.id, "progress", {
            turnId: last.id,
            state: "completed",
          })
          .catch(() => {});
        await client
          .conversationOperation(attention.id, "end", {})
          .catch(() => {});
        return answer;
      }
      if (last && repeats < 3) {
        repeats++;
        await say(
          last.id,
          request.kind === "question"
            ? "Say the number of your choice."
            : "Say approve, or say deny.",
        );
      }
      if (
        ended.includes(page.request?.state ?? "") ||
        page.conversation?.state === "ended"
      )
        return null;
    }
    await client.conversationOperation(attention.id, "end", {}).catch(() => {});
    return null;
  } finally {
    clearInterval(beat);
  }
}

const linkSchema = z
  .object({
    version: z.literal(1),
    /** The connection that `clawdtime setup` or `connect` made for a project. */
    connectionFile: z.string().max(4096),
    project: z.string().max(4096),
    adapter: z.enum(["codex", "claude-code"]),
    linkedAt: z.number().int().nonnegative(),
  })
  .strict();
export type CallLink = z.infer<typeof linkSchema>;
const linkPath = (root: string) => join(deskDirectory(root), "call.json");

export function saveCallLink(root: string, link: Omit<CallLink, "version">) {
  // Fails here, at link time, when the connection is not usable.
  loadConnection(link.connectionFile, link.project, link.adapter as Adapter);
  secureWrite(linkPath(root), { version: 1, ...link });
}
export function loadCallLink(root: string): CallLink | null {
  try {
    const file = linkPath(root);
    if (!existsSync(file) || !lstatSync(file).isFile()) return null;
    return linkSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
export function removeCallLink(root: string) {
  rmSync(linkPath(root), { force: true });
}

/** A fresh backend session for one call, from the linked pairing. */
export async function openCall(
  link: CallLink,
  request: DecisionRequest,
): Promise<CallClient> {
  const connection = loadConnection(
    link.connectionFile,
    link.project,
    link.adapter as Adapter,
  );
  const registered = await new ClawdTimeClient(
    connection.baseUrl,
    connection.token,
  ).register({
    protocolVersion: 2,
    adapter: connection.adapter,
    adapterVersion: connection.adapterVersion,
    projectRoot: connection.projectRoot,
    externalSessionId: `clawdtime-supervisor-${request.id}`,
    hostId: connection.hostId || hostname(),
    // The supervisor only talks. It claims no screen and no input.
    capabilities: sessionCapabilities({
      protocolVersion: 2,
      nativeControl: "none",
      sharedSurface: false,
    }),
  });
  return new ClawdTimeClient(connection.baseUrl, registered.token);
}
