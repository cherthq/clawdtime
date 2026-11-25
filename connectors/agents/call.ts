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
export function spokenQuestion(
  request: DecisionRequest,
  /** What the person said before that bears on it, from memory. */
  recalled: string | null = null,
) {
  const who = `${agentLabel(request.agent)}${request.cwd ? ` in ${request.cwd.split("/").filter(Boolean).at(-1)}` : ""}`;
  const what = request.summary.slice(0, spokenLength);
  const before = recalled
    ? ` You said before: ${recalled.slice(0, 160).replace(/[.!?]+$/, "")}.`
    : "";
  if (request.kind === "question")
    return `${who} asks: ${what} ${request.options.map((option, index) => `${numbers[index]}, ${option}.`).join(" ")}${before} Say the number or the answer.`;
  if (request.kind === "plan")
    return callCanApprove(request)
      ? `${who} has a plan ready.${before} Say approve to start it, or deny.`
      : `${who} has a plan ready.${before} It is too long to approve here: approve it ${readable(request)}, or say deny.`;
  return callCanApprove(request)
    ? `${who} asks to run ${request.tool === "Bash" ? "the command" : request.tool}: ${what}.${before} Say approve or deny.`
    : `${who} asks to run ${request.tool === "Bash" ? "the command" : request.tool}: ${what}.${before} That is not all of it, so I cannot approve it here: approve it ${readable(request)}, or say deny.`;
}

/** How much of a request a call reads aloud. */
const spokenLength = 220;
/**
 * True when a call can take an approval for this request: the person hears
 * all of it. A request that is not shown whole anywhere, and a command that
 * is longer than what the call reads, are approved where the person can read
 * them. A denial is taken on the call in every case.
 */
export const callCanApprove = (
  request: Pick<DecisionRequest, "kind" | "summary" | "answerInTerminal">,
) =>
  !request.answerInTerminal &&
  (request.kind !== "permission" || request.summary.length <= spokenLength);
/** Where the person can read all of the request. */
const readable = (request: Pick<DecisionRequest, "answerInTerminal">) =>
  request.answerInTerminal ? "in its terminal" : "in the panel or its terminal";

const refuse =
  /\b(deny|denied|decline|declined|reject|no|nope|don'?t|do not|stop|cancel|refuse|never)\b/;
const accept =
  /\b(approve|approved|allow|allowed|yes|yeah|yep|go ahead|do it|okay|ok|sure|proceed|accept|confirm)\b/;

/** A sentence that opens with its refusal is clear, whatever follows it. */
const opensWithNo =
  /^(?:no|nope|deny|denied|decline|declined|reject|stop|cancel|refuse|never|don'?t|do not)\b/;
/** "not" and its short forms turn an approval around. */
const negated =
  /\b(?:not|cannot|\w+n't|cant|wont|wouldnt|shouldnt|couldnt|isnt|arent|doesnt|didnt|wasnt|havent|hasnt)\b/;
/** The words of someone who has not decided, who asks for time, or who only greets. */
const unsure =
  /\b(?:maybe|perhaps|probably|possibly|unsure|i think|i guess|i suppose|i don'?t know|i do not know|dunno|no idea|wait|hold on|hang on|(?:one|a) (?:moment|second|sec|minute)|hello|hi|hey)\b/;
/** Sounds and small words that can stand before the sentence itself. */
const fillers =
  /^(?:(?:um+|uh+|er+|hmm+|so|well|and|but|oh|ah|like|now|then|please|okay|ok|yeah|yes|sure|right|alright) )+/;
/**
 * A sentence that asks. It opens with a question word, or it turns the verb
 * and the subject around ("is it", "should I"). Speech often comes with no
 * question mark, so the mark is not needed. "do it" and "do not" do not ask.
 */
const asking =
  /^(?:is|are|should|can|could|would|does|did|what|which|why|how|who|when|do (?!it\b|not\b))\b|\b(?:is|are|should|can|could|would|does|did) (?:it|i|we|you|that|this|they|he|she|there)\b|\bdo (?:i|we|you|they)\b/;
const plainWords = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** True when the words ask something: by a question mark, or by any part that is worded as a question. */
const asks = (spoken: string) =>
  /[?\uff1f]/.test(spoken) ||
  spoken
    .split(/[.,;:!]+/)
    .some((part) => asking.test(plainWords(part).replace(fillers, "")));
/** True when what was said stops on a "not": the rest of the sentence may still come. */
export const endsNegated = (spoken: string) =>
  new RegExp(`${negated.source}$`).test(plainWords(spoken));
/** True when the words give no clear answer: they turn around, hesitate or ask. */
const unclear = (spoken: string, words: string) =>
  negated.test(words) || unsure.test(words) || asks(spoken);
/**
 * True when the words tell nobody to go on: they hesitate or ask for time
 * ("wait", "hold on", "one moment", "not yet", "maybe"), or they open with a
 * word that asks about something ("why did you stop", "what is that"). A
 * request that is worded as a question ("can you press return") is not among
 * them: it tells what to do.
 */
export const holdsBack = (spoken: string) => {
  const words = plainWords(spoken);
  return (
    unsure.test(words) ||
    /\bnot (?:yet|now|so fast)\b|\b(?:later|in a (?:moment|second|sec|minute|bit))\b/.test(
      words,
    ) ||
    /^(?:why|what|which|who|whose|when|where|how)\b/.test(
      words.replace(fillers, ""),
    )
  );
};

/**
 * The strict yes for an action that waits for one: in the chat, on a call and
 * by text. Never a bare ok, okay, sure, yeah or yep, never a question, and
 * never a yes with a condition, a delay, a doubt or a thanks after it.
 */
export const explicitApprovalYes =
  /^(?:(?:please|pls|plz)[,\s]+)?(?:yes(?:[,\s]+(?:please|pls|plz))?(?:[,\s]+(?:do\s+it|go\s+ahead(?:\s+and\s+do\s+it)?|approve(?:\s+(?:it|that))?|allow(?:\s+(?:it|that))?|proceed|confirm(?:\s+(?:it|that))?|send\s+(?:it|that)|click\s+(?:it|that)|submit\s+(?:it|that)))?|i\s+approve|approve(?:\s+(?:it|that))?|allow(?:\s+(?:it|that))?|confirm(?:\s+(?:it|that))?|go\s+ahead(?:\s+and\s+do\s+it)?|do\s+it)(?:[,\s]+(?:please|pls|plz))?[.!]*$/i;
/** Explicit no or refusal for a waiting computer-action approval (never a question). */
export const explicitApprovalNo =
  /^(?:(?:please|pls|plz)[,\s]+)?(?:no|nope|nah|deny(?:\s+it)?|decline|reject|refuse|cancel|don['\u2019]?t|do\s+not)(?:[,\s]+(?:please|pls|plz))?[.!]*$|^(?:(?:no|nope|nah)[,\s]+)?(?:don['\u2019]?t|do\s+not|deny|decline|reject|refuse)\s+(?:do\s+(?:it|that)|approve(?:\s+(?:it|that))?|allow(?:\s+(?:it|that))?|send(?:\s+(?:it|that))?|click(?:\s+(?:it|that))?|submit(?:\s+(?:it|that))?|proceed|it|that)(?:[,\s]+(?:please|pls|plz))?[.!]*$/i;
/**
 * Reads what the person said as an answer. It returns null when the words are
 * not clear: then the call or the chat asks again. Silence, noise, an
 * unrelated sentence, yes and no together, an approval with "not" in the
 * sentence, a hedge and a question are never an approval. A clear refusal
 * denies.
 */
export function interpret(
  spoken: string,
  request: Pick<DecisionRequest, "kind" | "options">,
): { decision: "allow" | "deny" | "answer"; text: string | null } | null {
  const words = plainWords(spoken);
  if (!words) return null;
  const deny = {
    decision: "deny" as const,
    text: spoken.trim().slice(0, 300),
  };
  /** A refusal with no approval beside it. It stands when it opens the sentence, or when nothing in the sentence hesitates or asks. */
  const refused = (said: string) =>
    refuse.test(said) &&
    !accept.test(said) &&
    (opensWithNo.test(said) ||
      !(unsure.test(said) || asks(spoken) || asking.test(said)));
  if (request.kind === "question") {
    const labels = request.options.map(plainWords);
    // The words of one choice and nothing else: that choice, whatever its words are.
    const marked = (text: string) => /[?\uff1f]/.test(text);
    const exact = labels.indexOf(words);
    if (
      exact >= 0 &&
      labels.lastIndexOf(words) === exact &&
      (!marked(spoken) || marked(request.options[exact]!))
    )
      return { decision: "answer", text: request.options[exact]! };
    const chosen = new Set<number>();
    // What the person said around the choice.
    let around = words;
    labels.forEach((label, index) => {
      const named = label
        ? new RegExp(
            `\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
            "g",
          )
        : null;
      if (named?.test(words)) {
        chosen.add(index);
        around = around.replace(named, " ");
      }
      if (
        new RegExp(
          `\\b(${numbers[index]}|${ordinals[index]}|${index + 1})\\b`,
        ).test(words)
      )
        chosen.add(index);
    });
    around = around.replace(/\s+/g, " ").trim();
    if (chosen.size === 0) return refused(around) ? deny : null;
    if (chosen.size !== 1) return null;
    const choice = request.options[[...chosen][0]!]!;
    // A choice inside a refusal, a "not", a hedge or a question is no choice yet.
    if (
      refuse.test(around) ||
      negated.test(around) ||
      unsure.test(around) ||
      (marked(spoken) && !marked(choice)) ||
      asking.test(around.replace(fillers, ""))
    )
      return null;
    return { decision: "answer", text: choice };
  }
  const no = refuse.test(words),
    yes = accept.test(words);
  if (no && yes) return null;
  if (no) return refused(words) ? deny : null;
  if (!yes || unclear(spoken, words)) return null;
  return { decision: "allow", text: null };
}

const turnSchema = z
  .object({
    id: z.string().min(1).max(200),
    sequence: z.number().int().nonnegative(),
    // The backend takes up to 8,000 characters in one turn.
    text: z.string().max(8000).optional(),
  })
  .passthrough();
type Turn = z.infer<typeof turnSchema>;
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

/** When a call reads, waits and gives up. */
export interface CallTiming {
  now: () => number;
  deadline: number;
  /** The longest that one read of the conversation may take. */
  pollMs?: number;
  /**
   * The pause between two reads that brought nothing new. The backend answers
   * a read at once, so without a pause the loop would flood it.
   */
  pauseMs?: number;
  beatMs?: number;
}

/** What the person said since the last read. Every turn here is delivered. */
interface Heard {
  /** Oldest first. */
  turns: Turn[];
  /** The call is over already (the person hung up): nothing more can be spoken. */
  over: boolean;
  /**
   * Speaks an answer to the newest turn. False when the backend refused it,
   * for example because the person spoke again in the meantime.
   */
  say(text: string): Promise<boolean>;
}

/**
 * One call: place it, then read what the person says, in order, and hand each
 * batch to `heard`. `heard` returns a value to end the call, or undefined to
 * go on listening. This keeps to the backend's order of operations: a turn is
 * acknowledged before it is used, an answer is spoken to the newest turn only,
 * each handled turn is reported as completed, oldest first, and the
 * conversation is ended once, also when something throws.
 */
async function onCall<T>(
  client: CallClient,
  attentionInput: {
    idempotencyKey: string;
    reason: "approval" | "decision";
    question: string;
  },
  options: CallTiming,
  heard: (batch: Heard) => Promise<T | undefined>,
): Promise<{ value: T } | { ended: "hung_up" | "time" | "lost" }> {
  const remaining = () => options.deadline - options.now();
  // No time limit is sent: the backend then uses its own, and the same key
  // with the same words always names the same call.
  const { request: attention } = await client.requestAttention({
    taskId: "clawdtime-supervisor",
    ...attentionInput,
  });
  // The backend stops a session that is silent for 20 seconds.
  const beat = setInterval(
    () => void client.heartbeat().catch(() => {}),
    options.beatMs ?? 5000,
  );
  const pauseMs = options.pauseMs ?? Math.min(700, options.pollMs ?? 700);
  const pause = () =>
    new Promise<void>((done) => setTimeout(done, Math.max(0, pauseMs)));
  const operation = (
    name: "ack" | "progress" | "reply" | "end",
    body: unknown,
  ) =>
    client.conversationOperation(attention.id, name, body).then(
      () => true,
      () => false,
    );
  let cursor = 0,
    failures = 0,
    open = true;
  try {
    while (remaining() > 0) {
      let page: Awaited<ReturnType<CallClient["conversationTurns"]>>;
      try {
        page = await client.conversationTurns(
          attention.id,
          cursor,
          Math.max(1, Math.min(options.pollMs ?? 10_000, remaining())),
        );
      } catch {
        // A backend that does not answer: a few tries with a pause, then no more.
        if (++failures >= 4) return { ended: "lost" };
        await pause();
        continue;
      }
      const over =
        ended.includes(page.request?.state ?? "") ||
        page.conversation?.state === "ended";
      // In order, and only up to the first turn that cannot be read or
      // delivered: the backend takes acknowledgements in order.
      const delivered: Turn[] = [];
      let stuck = false;
      for (const raw of page.turns) {
        const parsed = turnSchema.safeParse(raw);
        if (!parsed.success) {
          stuck = true;
          break;
        }
        if (parsed.data.sequence <= cursor) continue;
        if (!(await operation("ack", { turnId: parsed.data.id }))) {
          stuck = true;
          break;
        }
        cursor = parsed.data.sequence;
        delivered.push(parsed.data);
      }
      if (delivered.length) {
        const newest = delivered.at(-1)!;
        const value = await heard({
          turns: delivered,
          over,
          say: (text) =>
            over
              ? Promise.resolve(false)
              : operation("reply", {
                  turnId: newest.id,
                  replyId: `reply-${newest.id}`,
                  text,
                  expectedCursor: cursor,
                }),
        });
        // Each of these turns is handled now. The backend wants that said for
        // each one, oldest first, before a later turn may be completed.
        if (!over)
          for (const turn of delivered)
            await operation("progress", {
              turnId: turn.id,
              state: "completed",
            });
        if (value !== undefined) {
          if (!over) await operation("end", {});
          open = false;
          return { value };
        }
      }
      if (over) {
        open = false;
        return { ended: "hung_up" };
      }
      if (stuck) {
        if (++failures >= 4) return { ended: "lost" };
      } else failures = 0;
      // Nothing new, or something to try again: wait before the next read.
      if (!delivered.length || stuck) await pause();
    }
    return { ended: "time" };
  } finally {
    clearInterval(beat);
    // Whatever happened, the call does not stay open on the backend.
    if (open) await operation("end", {});
  }
}

/**
 * Places the call and waits for a clear spoken answer until the deadline.
 * null: nobody answered clearly. The request then stays as it is.
 */
export async function answerByCall(
  client: CallClient,
  request: DecisionRequest,
  options: CallTiming & { recalled?: string | null },
): Promise<{
  decision: "allow" | "deny" | "answer";
  text: string | null;
} | null> {
  if (options.deadline - options.now() < 20_000) return null;
  let repeats = 0;
  let held = "";
  const result = await onCall(
    client,
    {
      // The same request never places a second call.
      idempotencyKey: `decision-${request.id}`,
      reason: request.kind === "question" ? "decision" : "approval",
      question: spokenQuestion(request, options.recalled ?? null),
    },
    options,
    async ({ turns, say }) => {
      // Fragments of one sentence arrive as several turns: they are read
      // together. Its last fragment alone could say the opposite.
      const said = turns
        .map((turn) => turn.text ?? "")
        .join(" ")
        .trim();
      const read = said ? interpret(`${held} ${said}`.trim(), request) : null;
      // A denial carries the person's words of this read as its reason.
      const answer =
        read?.decision === "deny"
          ? { ...read, text: said.slice(0, 300) }
          : read;
      // A sentence can stop on "not" in one read and go on in the next.
      held = !answer && endsNegated(said) ? "not" : "";
      // The person did not hear all of this request: the call takes no approval for it.
      if (answer?.decision === "allow" && !callCanApprove(request)) {
        await say(
          `I cannot approve this one here. Approve it ${readable(request)}, or say deny.`,
        );
        return undefined;
      }
      if (answer) {
        await say(
          answer.decision === "allow"
            ? "Approved. It continues now."
            : answer.decision === "deny"
              ? "Denied. I told it."
              : `Answered: ${answer.text}.`,
        );
        return answer;
      }
      if (repeats < 3) {
        repeats++;
        await say(
          request.kind === "question"
            ? "Say the number of your choice."
            : "Say approve, or say deny.",
        );
      }
      return undefined;
    },
  );
  return "value" in result ? result.value : null;
}

/**
 * Places one call that says one thing, for example what the watcher found. It
 * ends when the person says a word, when they hang up, or when the time runs
 * out. Nothing the person says here is an answer to an agent.
 */
export async function sayByCall(
  client: CallClient,
  sentence: string,
  options: CallTiming & {
    /** Names this one call, so the same news never places a second one. */
    key: string;
  },
): Promise<"heard" | "ended" | "time"> {
  const result = await onCall(
    client,
    {
      idempotencyKey: `incident-${options.key}`,
      reason: "decision",
      question: `${sentence.slice(0, 300)} Say okay when you have heard this.`,
    },
    options,
    async ({ turns, say }) => {
      if (!turns.some((turn) => turn.text?.trim())) return undefined;
      await say("Okay.");
      return "heard" as const;
    },
  );
  if ("value" in result) return result.value;
  return result.ended === "time" ? "time" : "ended";
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
  // Fails here, at link time, when the connection is not usable. A project
  // that was never paired is the common case: say that, and what to run.
  if (!existsSync(link.connectionFile))
    throw new Error(
      `This project is not paired for ${link.adapter}. Pair it first: clawdtime setup --agent ${link.adapter} --project PATH --setup-link-file PRIVATE_FILE --origin HTTPS_ORIGIN --allow-view true --allow-control true|false. Then link again.`,
    );
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
  /** Names this one call: a request id, or any unique word. */
  key: string,
): Promise<ClawdTimeClient> {
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
    externalSessionId: `clawdtime-supervisor-${key}`,
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

const farewell =
  /\b(bye|goodbye|that's all|that is all|hang up|end the call|thanks,? that's it|nothing else)\b/;

/**
 * A conversation with ClawdTime on a call. Each thing the person says goes to
 * `respond`, and its answer is spoken. It ends when the person says goodbye,
 * hangs up, or the time runs out. "lost": the backend stopped answering.
 */
export async function converseByCall(
  client: CallClient,
  respond: (spoken: string) => Promise<string>,
  options: CallTiming & { greeting: string; key: string },
): Promise<{
  turns: number;
  ended: "goodbye" | "hung_up" | "time" | "lost";
}> {
  let count = 0;
  const result = await onCall(
    client,
    {
      idempotencyKey: `talk-${options.key}`,
      reason: "decision",
      question: options.greeting,
    },
    options,
    async ({ turns, say }) => {
      // Fragments of one sentence arrive as several turns: they are answered together.
      const spoken = turns
        .map((turn) => turn.text ?? "")
        .join(" ")
        .trim();
      if (!spoken) return undefined;
      count++;
      const bye = farewell.test(spoken.toLowerCase());
      await say((bye ? "Goodbye." : await respond(spoken)).slice(0, 900));
      return bye ? ("goodbye" as const) : undefined;
    },
  );
  return {
    turns: count,
    ended: "value" in result ? result.value : result.ended,
  };
}

const readinessSchema = z
  .object({
    mode: z.string().max(40).optional(),
    ready: z.boolean().optional(),
    readiness: z
      .object({
        checks: z
          .array(
            z
              .object({
                id: z.string().max(80),
                status: z.string().max(20),
                message: z.string().max(400),
              })
              .passthrough(),
          )
          .max(40),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** What the backend says about a call for this pairing, before any call is placed. */
export interface CallCheck {
  /** A call can be placed now. */
  ready: boolean;
  /** "live": a phone rings. "simulation" or "standby": no phone rings. */
  mode: string;
  /** "note" is anything the backend neither passes nor fails, for example that the mode is simulation. */
  checks: { id: string; status: "pass" | "fail" | "note"; message: string }[];
}

/**
 * Asks the backend whether a call would work now. It opens a session, as a call
 * does, and reads the backend's own readiness. It places no call.
 */
export async function checkCall(
  link: CallLink,
  key: string,
): Promise<CallCheck> {
  const client = await openCall(link, key);
  const report = readinessSchema.parse(await client.doctor());
  const checks = (report.readiness?.checks ?? []).map((check) => ({
    id: check.id,
    status:
      check.status === "pass"
        ? ("pass" as const)
        : check.status === "fail"
          ? ("fail" as const)
          : ("note" as const),
    message: check.message.replace(/\p{C}/gu, " ").slice(0, 300),
  }));
  return {
    ready: report.ready === true,
    mode: report.mode ?? "unknown",
    checks,
  };
}

/** The check as lines for a terminal. */
export function callCheckText(check: CallCheck): string[] {
  const lines = [
    `The backend answers. Mode: ${check.mode}.`,
    ...check.checks.map(
      (item) =>
        `  ${item.status === "fail" ? "FAIL" : item.status}  ${item.id}: ${item.message}`,
    ),
  ];
  lines.push(
    check.ready
      ? check.mode === "live"
        ? "A call can be placed now, and your phone will ring."
        : "A call can be placed in this mode, but no phone rings: the line is not live."
      : "A call would not go through. Fix the lines marked FAIL.",
  );
  return lines;
}
