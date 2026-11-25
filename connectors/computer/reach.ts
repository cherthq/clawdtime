/**
 * Computer use: reach the owner when the worker needs them.
 *
 * The worker asks in the chat. When the owner does not answer there in a short
 * time, the reach places ONE call to the owner on the Chert line, through the
 * proactive call path of the line, and says the question in one or two plain
 * sentences. When that call fails, is not answered, or the line is not set up,
 * it sends ONE text to the owner instead. The owner's answer, spoken or texted,
 * goes to the worker's own `answer`, as an answer in the chat does: the worker
 * reads it with its own rules, and a yes is never inferred here. A question
 * that waits for a yes takes only the strict yes of the chat
 * (`explicitApprovalYes`) or a plain no: words with a doubt, a condition, a
 * delay, a refusal or a thanks ("ok, hold off", "yes, but later", "ok
 * thanks") go nowhere, and the question waits.
 *
 * Rules that are code here:
 *
 * - One call and one text at most for one question, also after a restart. No
 *   call is placed again, whatever came of the first one.
 * - A newer question replaces an older one. An older call that was not dialed
 *   yet is taken back. Stop of the request, an answer in the chat or the end
 *   of the request does the same, and ends a call that rings for it.
 * - A sign-in or a code is never asked for by voice or by text. The message
 *   says what is needed and where, and that the owner signs in on the Mac or
 *   in ClawdTime's own browser profile. Words that look like a password or a
 *   code are never passed on to the worker, and so never reach the planner.
 * - Every attempt and its outcome is kept in `computer/reach.json`, for its
 *   owner only: kinds, times and fixed outcome words. Never a question, an
 *   answer or a typed text.
 *
 * The reach has no timer of its own. The service calls `tick` about once a
 * second, and tests call it with their own clock.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DesktopExecutionSnapshot } from "../../src/control/desktop-executor.js";
import type {
  CallScope,
  CallTrigger,
  EnqueueCall,
  ProactiveCallIntent,
} from "../../src/attention/proactive-contracts.js";
import type { ProactivePolicy } from "../../src/attention/proactive-policy.js";
import type { ProactiveSourceEvidence } from "../../src/control/proactive-preparation.js";
import {
  explicitApprovalNo,
  explicitApprovalYes,
  holdsBack,
} from "../agents/call.js";
import { looksSecret } from "../agents/memory.js";
import {
  ownerTextLine,
  sendOwnerText,
  textSettings,
  type TextSettings,
} from "../agents/texts.js";
import { secureRead, secureWrite } from "../shared/state.js";
import {
  computerDirectory,
  looksSecretStrict,
  type JournalRequest,
} from "./journal.js";
import { readWords } from "./orders.js";

/** What the worker waits on, in the reach's own words. */
export type ReachKind = "approval" | "question" | "signin" | "code" | "blocked";
/** Where the request came from. Only a request from the chat waits before the reach. */
export type ReachOrigin = "chat" | "call" | "text" | "routine";

/** What the reach needs of the worker: its public surface, nothing more. */
export interface ReachWorker {
  snapshot(): DesktopExecutionSnapshot;
  answer(text: string): Promise<{ message: string }>;
  stop(): DesktopExecutionSnapshot;
}

/** One question, ready to be said. */
export interface ReachAsk {
  /** Names this one question. The same key never places a second call. */
  key: string;
  requestId: string;
  kind: ReachKind;
  /** One or two plain sentences for the call. */
  spoken: string;
}

/** Where one placed call is now. */
export type CallPhase =
  | { phase: "unsent"; reason?: string }
  | { phase: "live"; connected: boolean }
  | {
      phase: "over";
      result: "answered" | "not_answered" | "failed" | "unknown";
      reason?: string;
    };

/** The call side of the reach. Tests give a fake one. */
export interface ReachCallPort {
  /** Whether a call can be placed now, and a fixed word for why not. No call is placed. */
  readiness(): { ready: boolean; reason: string };
  /** Places one call. */
  place(ask: ReachAsk): { id: string } | { refused: string };
  phase(id: string): CallPhase;
  /** Takes back a call that was not dialed. True when nothing went out. */
  cancel(id: string): boolean;
  /** Ends a call that is on its way or on the line. */
  end(id: string): void;
}

export type TextOutcome =
  "sent" | "already_sent" | "unknown" | `refused:${string}`;
/** The text side of the reach. Tests give a fake one. */
export interface ReachTextPort {
  readiness(): { ready: boolean; reason: string };
  send(key: string, text: string): Promise<TextOutcome>;
}

/** The session name of every call of the reach on the line. */
export const reachSession = "clawdtime-computer";
/** The default time that the owner has to answer in the chat. */
export const reachDelayMs = 45_000;
/** A call that was not dialed after this time is taken back, and a text goes. */
const placeMs = 60_000;
const keptItems = 50;
const keptTurns = 8;
/** How long after a text turn began a request still counts as asked by text. */
const textTurnMs = 120_000;

/** True for a call of the reach: a spoken alert that shares no screen. */
export const voiceOnlyCall = (intent: {
  source: { kind: string };
  channel: string;
}) => intent.source.kind === "computer" && intent.channel === "phone_alert";

const reachFile = (root: string) => join(computerDirectory(root), "reach.json");
const turnFile = (root: string) =>
  join(computerDirectory(root), "text-turn.json");

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const tidy = (value: string) =>
  value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
/** Cuts at a sentence end when one is near, else at a word. */
const cut = (value: string, limit: number) => {
  const text = tidy(value);
  if (text.length <= limit) return text;
  const part = text.slice(0, limit);
  const end = Math.max(
    part.lastIndexOf(". "),
    part.lastIndexOf("? "),
    part.lastIndexOf("! "),
  );
  if (end > limit * 0.5) return part.slice(0, end + 1);
  const space = part.lastIndexOf(" ");
  return `${part.slice(0, space > 0 ? space : limit)}...`;
};

/** What kind of help the question needs. Read from the worker's own fixed words. */
export function reachKind(
  question: string,
  mode: "yes_no" | "free",
): Exclude<ReachKind, "blocked"> {
  if (/that is a password field/i.test(question)) return "signin";
  if (mode === "yes_no") return "approval";
  if (
    /\b(?:codes?|otp|one[- ]time|verification|verify|2fa|two[- ]factor|authenticator|passcode|pin)\b/i.test(
      question,
    )
  )
    return "code";
  if (
    /\b(?:sign(?:ed|ing)?[- ]?in|log(?:ged|ging)?[- ]?in|password|passphrase|credentials?)\b/i.test(
      question,
    )
  )
    return "signin";
  return "question";
}

/** Where a sign-in or a code is needed: a site that the words name, or an app. Null when none is named. */
export function reachPlace(...texts: string[]): string | null {
  for (const text of texts) {
    const site =
      /\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|app|dev|me|us|uk|de|fr|edu|gov))\b/i.exec(
        text,
      );
    if (site) return site[1]!.toLowerCase();
  }
  for (const text of texts) {
    const named =
      /\b(?:to|into|in|on|for|with|at)\s+([A-Z][\w-]*(?:\s+[A-Z][\w-]*)?)/.exec(
        text,
      );
    if (named && !/^(?:The|This|That|It|I|Say|Type|Then)\b/.test(named[1]!))
      return named[1]!;
  }
  return null;
}

/** The words of the call and of the text for one question. Never a request for a secret. */
export function reachWords(input: {
  kind: ReachKind;
  mode: "yes_no" | "free" | "none";
  question: string;
  goal: string;
}): { spoken: string; text: string } {
  const goal = cut(input.goal, 120);
  const go = input.mode === "yes_no" ? "yes" : "done";
  const where = reachPlace(input.question, input.goal);
  switch (input.kind) {
    case "signin": {
      const at = where ? ` to ${where}` : "";
      return {
        spoken: `ClawdTime on your Mac needs you to sign in${at}: sign in on the Mac, or once in ClawdTime's own browser profile, then say ${go}. Never say a password or a code on this call.`,
        text: `ClawdTime on your Mac needs you to sign in${at}${goal ? ` for "${goal}"` : ""}. Sign in on the Mac, or once in ClawdTime's own browser profile. Then reply ${go} to go on, or stop. Never send a password or a code in a text.`,
      };
    }
    case "code": {
      const at = where ? ` for ${where}` : "";
      return {
        spoken: `ClawdTime on your Mac needs a code${at}: type it on the Mac yourself, then say ${go}. Never say a code on this call.`,
        text: `ClawdTime on your Mac needs a code${at}${goal ? ` for "${goal}"` : ""}. Type it on the Mac yourself, then reply ${go} to go on, or stop. Never send a code in a text.`,
      };
    }
    case "approval":
      return {
        spoken: `ClawdTime on your Mac needs your yes. ${cut(input.question, 260)}`,
        text: `ClawdTime on your Mac needs your yes${goal ? ` for "${goal}"` : ""}. ${cut(input.question, 600)}${/\byes or no\.?\s*$/i.test(input.question) ? "" : " Reply yes or no."}`,
      };
    case "question": {
      const asked = input.question.replace(/^The task asks:\s*/i, "");
      return {
        spoken: `ClawdTime on your Mac asks: ${cut(asked, 260)} Say your answer.`,
        text: `ClawdTime on your Mac asks${goal ? `, for "${goal}"` : ""}: ${cut(asked, 600)} Reply with your answer, or stop.`,
      };
    }
    case "blocked":
      return {
        spoken: `ClawdTime could not finish${goal ? ` "${goal}"` : " the task on your Mac"}. ${cut(input.question, 240)}`,
        text: `ClawdTime could not finish${goal ? ` "${goal}"` : " the task on your Mac"}. ${cut(input.question, 600)} Ask again in the chat, by text or on a call.`,
      };
  }
}

/** Fixed replies of the reach. None says that something was done on the screen. */
export const reachReplies = {
  gone: "That question no longer waits, so nothing was passed on.",
  ended:
    "That task has ended, and nothing runs from here. Ask again in the chat, by text or on a call.",
  secret:
    "I do not take a password or a code by phone or by text, so nothing was passed on. Type it on the Mac yourself, then say done.",
  held: "I did not pass that on: it reads as a question or as a wait.",
  unclear: "I did not get a clear answer.",
} as const;

const eventSchema = z
  .object({
    at: z.number().int().nonnegative(),
    /** One fixed word: call_placed, call_not_answered, text_sent. */
    what: z.string().regex(/^[a-z_]{1,40}$/),
    /** A fixed code from the call or text side, never text of the screen. */
    detail: z
      .string()
      .regex(/^[A-Za-z0-9_:,-]{1,80}$/)
      .optional(),
  })
  .strict();
const recordSchema = z
  .object({
    /** A digest of the question. It holds none of its words. */
    id: z.string().regex(/^[a-f0-9]{24}$/),
    requestId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
    kind: z.enum(["approval", "question", "signin", "code", "blocked"]),
    origin: z.enum(["chat", "call", "text", "routine"]),
    seenAt: z.number().int().nonnegative(),
    events: z.array(eventSchema).max(40),
  })
  .strict();
export type ReachRecord = z.infer<typeof recordSchema>;
const sideSchema = z
  .object({ ready: z.boolean(), reason: z.string().max(200) })
  .strict();
const fileSchema = z
  .object({
    version: z.literal(1),
    readiness: z
      .object({
        at: z.number().int().nonnegative(),
        calls: sideSchema,
        texts: sideSchema,
      })
      .strict()
      .optional(),
    items: z.array(recordSchema).max(keptItems),
  })
  .strict();
export type ReachFile = z.infer<typeof fileSchema>;

/** The record of the reach, or an empty one. A file that cannot be read is not trusted. */
export function readReach(root: string): ReachFile | null {
  const file = reachFile(root);
  if (!existsSync(file)) return { version: 1, items: [] };
  try {
    return fileSchema.parse(secureRead(file));
  } catch {
    return null;
  }
}

/**
 * The text channel says that it hands one text of the owner to the service,
 * so that the service knows these exact words came by text. Only a digest of
 * the words is kept, with the time.
 */
export function markTextTurn(root: string, words: string, at = Date.now()) {
  secureWrite(turnFile(root), { version: 1, at, digest: digest(words) });
}
/** True when the text channel marked these exact words a short time ago. */
export function isTextTurn(root: string, words: string, at = Date.now()) {
  try {
    const file = turnFile(root);
    if (!existsSync(file) || !lstatSync(file).isFile()) return false;
    const value = z
      .object({
        version: z.literal(1),
        at: z.number(),
        digest: z.string(),
      })
      .parse(secureRead(file));
    return (
      value.digest === digest(words) &&
      at >= value.at - 1000 &&
      at - value.at <= textTurnMs
    );
  } catch {
    return false;
  }
}

interface Seen {
  key: string;
  id: string;
  requestId: string;
  kind: ReachKind;
  mode: "yes_no" | "free" | "none";
  question: string;
  goal: string;
}
interface Item extends Seen {
  origin: ReachOrigin;
  seenAt: number;
  spoken: string;
  text: string;
  call?: { id: string; at: number; over: boolean; connected: boolean };
  /** A call was asked for: placed, refused, or not set up. */
  tried: boolean;
  texted: boolean;
  /** A text went out, or may have: its reply is for this question. */
  awaitingText: boolean;
  /** The answer came through the reach, on the call or by text. */
  answeredVia?: "call" | "text";
}

const final = new Set(["completed", "blocked", "canceled", "uncertain"]);

export interface OwnerReachOptions {
  root: string;
  worker: ReachWorker;
  /** Reads the goal, the start and the reason of a request. Read only. */
  journal?: { get(id: string): JournalRequest | null };
  call?: ReachCallPort;
  text?: ReachTextPort;
  now?: () => number;
  /** How long the owner has to answer in the chat first. 0 calls at once. */
  delayMs?: number;
  /** Says a line in the chat, for the person at the Mac. */
  notify?: (text: string) => void;
}

/** One reach for one worker. See the top of this file. */
export class OwnerReach {
  private item: Item | null = null;
  /** Questions that were reached once. Their ids only. */
  private readonly handled = new Set<string>();
  private readonly turns: { start: number; end?: number }[] = [];
  private ticking = false;
  private readinessAt = 0;
  private readinessShown = "";
  private readonly now: () => number;
  private readonly delayMs: number;
  private file: ReachFile;

  constructor(private readonly options: OwnerReachOptions) {
    this.now = options.now ?? Date.now;
    this.delayMs = Math.max(0, options.delayMs ?? reachDelayMs);
    // A record that cannot be read is set aside in memory only: every
    // question in it counts as reached, so nothing is reached twice.
    const found = readReach(options.root);
    if (!found)
      // A record that cannot be read is set aside under a new name, never
      // removed and never written over. The reach starts a new one.
      try {
        renameSync(
          reachFile(options.root),
          `${reachFile(options.root)}.unreadable-${this.now()}`,
        );
      } catch {
        // It stays where it is; the new record then cannot be written.
      }
    this.file = found ?? { version: 1, items: [] };
    for (const item of this.file.items) this.handled.add(item.id);
  }

  /** The records, newest last. */
  records(): ReachRecord[] {
    return this.file.items.map((item) => ({
      ...item,
      events: [...item.events],
    }));
  }
  /** The question that the reach works on now. */
  current(): { id: string; kind: ReachKind; requestId: string } | null {
    return this.item
      ? {
          id: this.item.id,
          kind: this.item.kind,
          requestId: this.item.requestId,
        }
      : null;
  }

  /** A text of the owner reached the service: requests that start now came by text. */
  textTurn(start = this.now()) {
    this.turns.push({ start });
    if (this.turns.length > keptTurns) this.turns.shift();
  }
  textTurnEnded(start: number, end = this.now()) {
    const turn = this.turns.find((item) => item.start === start && !item.end);
    if (turn) turn.end = end;
  }
  /** True while a text of the reach waits for its reply. */
  awaitsText() {
    return (
      !!this.item?.awaitingText &&
      this.item.kind !== "blocked" &&
      !this.item.answeredVia
    );
  }

  private save() {
    try {
      secureWrite(reachFile(this.options.root), fileSchema.parse(this.file));
    } catch {
      // A record that cannot be written changes nothing of the reach itself.
    }
  }
  private record(item: Item, what: string, detail?: string) {
    let row = this.file.items.find((entry) => entry.id === item.id);
    if (!row) {
      row = {
        id: item.id,
        requestId: item.requestId,
        kind: item.kind,
        origin: item.origin,
        seenAt: item.seenAt,
        events: [],
      };
      this.file.items.push(row);
      if (this.file.items.length > keptItems) this.file.items.shift();
    }
    const code = detail
      ?.replace(/[^A-Za-z0-9_:,-]+/g, "_")
      .slice(0, 80)
      .replace(/^_+|_+$/g, "");
    if (row.events.length < 40)
      row.events.push({
        at: this.now(),
        what,
        ...(code ? { detail: code } : {}),
      });
    this.save();
  }

  /** What the worker waits on now, when the reach may help. */
  private read(): Seen | null {
    let snapshot: DesktopExecutionSnapshot;
    try {
      snapshot = this.options.worker.snapshot();
    } catch {
      return null;
    }
    const requestId = snapshot.requestId;
    if (!snapshot.configured || !requestId) return null;
    const request = (() => {
      try {
        return this.options.journal?.get(requestId) ?? null;
      } catch {
        return null;
      }
    })();
    const goal = snapshot.goal ?? request?.goal ?? "";
    if (
      snapshot.state === "waiting_for_person" &&
      (snapshot.waiting === "approval" || snapshot.waiting === "question")
    ) {
      const question = snapshot.message ?? "";
      if (!question.trim()) return null;
      const mode = snapshot.waiting === "approval" ? "yes_no" : "free";
      // The step makes a new ask of the same words a new question.
      const step = request?.steps.length ?? 0;
      const key = [requestId, step, snapshot.waiting, question].join("\n");
      return {
        key,
        id: digest(key).slice(0, 24),
        requestId,
        kind: reachKind(question, mode),
        mode,
        question,
        goal,
      };
    }
    if (snapshot.state === "blocked") {
      // A call held the screen, so the owner is on a call already. A routine
      // reports the end of its own request by text.
      if (
        request?.reason === "screen_owned_by_call" ||
        requestId.startsWith("routine_")
      )
        return null;
      const key = [requestId, "blocked"].join("\n");
      return {
        key,
        id: digest(key).slice(0, 24),
        requestId,
        kind: "blocked",
        mode: "none",
        question: snapshot.message ?? "",
        goal,
      };
    }
    return null;
  }

  private originOf(requestId: string): ReachOrigin {
    if (requestId.startsWith("routine_")) return "routine";
    if (requestId.startsWith("phone_")) return "call";
    let created: number | undefined;
    try {
      created = this.options.journal?.get(requestId)?.createdAt;
    } catch {
      created = undefined;
    }
    if (
      created !== undefined &&
      this.turns.some(
        (turn) =>
          created! >= turn.start - 1000 &&
          created! <= (turn.end ?? turn.start + textTurnMs) + 1000,
      )
    )
      return "text";
    return "chat";
  }

  /** One round. Safe to call at any time; one round runs at a time. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const seen = this.read();
      const item = this.item;
      if (item && seen?.key !== item.key)
        this.close(
          item,
          seen
            ? "replaced"
            : item.kind === "blocked"
              ? "moved_on"
              : this.closing(),
        );
      if (seen && !this.item && !this.handled.has(seen.id)) this.open(seen);
      if (this.item) await this.advance(this.item);
      this.showReadiness();
    } finally {
      this.ticking = false;
    }
  }

  /** Why a question went away: the request goes on, was stopped, or ended. */
  private closing() {
    try {
      const state = this.options.worker.snapshot().state;
      if (state === "canceled") return "stopped";
      if (final.has(state) || state === "idle") return "ended";
      return "answered_elsewhere";
    } catch {
      return "ended";
    }
  }

  private open(seen: Seen) {
    const origin = this.originOf(seen.requestId);
    const words = reachWords(seen);
    this.item = {
      ...seen,
      origin,
      seenAt: this.now(),
      spoken: words.spoken,
      text: words.text,
      tried: false,
      texted: false,
      awaitingText: false,
    };
    this.handled.add(seen.id);
    this.record(this.item, "asked");
  }

  private close(item: Item, why: string) {
    this.item = null;
    const call = this.options.call;
    if (item.call && !item.call.over && call) {
      let phase: CallPhase;
      try {
        phase = call.phase(item.call.id);
      } catch {
        phase = { phase: "over", result: "unknown" };
      }
      if (phase.phase === "unsent") {
        let back = false;
        try {
          back = call.cancel(item.call.id);
        } catch {
          back = false;
        }
        this.record(item, back ? "call_taken_back" : "call_take_back_failed");
      } else if (phase.phase === "live" && item.answeredVia !== "call") {
        // The question is gone: the phone stops ringing for it.
        try {
          call.end(item.call.id);
          this.record(item, "call_ended");
        } catch {
          this.record(item, "call_end_failed");
        }
      }
    }
    if (!item.answeredVia) this.record(item, why);
  }

  private delayFor(origin: ReachOrigin) {
    return origin === "chat" ? this.delayMs : 0;
  }

  private async advance(item: Item) {
    const now = this.now();
    if (!item.tried && !item.texted) {
      if (now - item.seenAt < this.delayFor(item.origin)) return;
      item.tried = true;
      const call = this.options.call;
      const ready = (() => {
        try {
          return (
            call?.readiness() ?? { ready: false, reason: "calls_not_set_up" }
          );
        } catch {
          return { ready: false, reason: "call_readiness_failed" };
        }
      })();
      if (!call || !ready.ready) {
        this.record(item, "call_not_set_up", ready.reason);
        return this.textOnce(item);
      }
      let placed: { id: string } | { refused: string };
      try {
        placed = call.place({
          key: item.id,
          requestId: item.requestId,
          kind: item.kind,
          spoken: item.spoken,
        });
      } catch {
        placed = { refused: "call_place_failed" };
      }
      if ("refused" in placed) {
        this.record(item, "call_refused", placed.refused);
        return this.textOnce(item);
      }
      item.call = { id: placed.id, at: now, over: false, connected: false };
      this.record(item, "call_placed");
      return;
    }
    if (!item.call || item.call.over || !this.options.call) return;
    const call = this.options.call;
    let phase: CallPhase;
    try {
      phase = call.phase(item.call.id);
    } catch {
      phase = { phase: "over", result: "unknown", reason: "call_unreadable" };
    }
    if (phase.phase === "unsent") {
      if (now - item.call.at < placeMs) return;
      let back = false;
      try {
        back = call.cancel(item.call.id);
      } catch {
        back = false;
      }
      if (!back) return; // It went out meanwhile: its outcome comes later.
      item.call.over = true;
      this.record(item, "call_not_dialed", phase.reason);
      return this.textOnce(item);
    }
    if (phase.phase === "live") {
      if (phase.connected && !item.call.connected) {
        item.call.connected = true;
        this.record(item, "call_connected");
      }
      return;
    }
    item.call.over = true;
    this.record(item, `call_${phase.result}`, phase.reason);
    // The owner picked up and heard the question. No text follows a call
    // that was answered, also when no clear answer came on it.
    if (phase.result === "answered" || item.call.connected) return;
    return this.textOnce(item);
  }

  /** At most one text for one question. Nothing is sent again, whatever came of it. */
  private async textOnce(item: Item) {
    if (item.texted) return;
    item.texted = true;
    const text = this.options.text;
    const ready = (() => {
      try {
        return (
          text?.readiness() ?? { ready: false, reason: "texts_not_set_up" }
        );
      } catch {
        return { ready: false, reason: "text_readiness_failed" };
      }
    })();
    if (!text || !ready.ready) {
      this.record(item, "text_not_set_up", ready.reason);
      // The person at the Mac sees why nobody was reached.
      try {
        this.options.notify?.(
          item.kind === "blocked"
            ? "I could not reach you by phone or by text to say that the task above did not finish."
            : "I could not reach you by phone or by text about the question above. It still waits here.",
        );
      } catch {
        // A line that could not be shown changes nothing.
      }
      return;
    }
    let outcome: TextOutcome;
    try {
      outcome = await text.send(`clawdtime-reach:${item.id}`, item.text);
    } catch {
      outcome = "unknown";
    }
    // A reply may come also when the outcome is not known.
    item.awaitingText = !outcome.startsWith("refused:");
    this.record(
      item,
      outcome === "sent" || outcome === "already_sent"
        ? "text_sent"
        : outcome === "unknown"
          ? "text_unknown"
          : "text_refused",
      outcome.startsWith("refused:") ? outcome.slice(8) : undefined,
    );
  }

  /**
   * The owner's answer on the call or by text. It goes to the worker's own
   * `answer` only while the worker still waits on that same question. Stop
   * always stops. Words that look like a password or a code go nowhere.
   */
  async reply(
    words: string,
    via: "call" | "text",
    questionId?: string,
  ): Promise<string> {
    const item = this.item;
    if (!item || (questionId !== undefined && questionId !== item.id))
      return reachReplies.gone;
    const seen = this.read();
    if (seen?.key !== item.key) {
      this.close(item, seen ? "replaced" : this.closing());
      return reachReplies.gone;
    }
    if (item.kind === "blocked") return reachReplies.ended;
    const said = tidy(words).slice(0, 600);
    if (!said) return item.spoken;
    if (readWords(said) === "stop") {
      item.answeredVia = via;
      this.record(item, `stopped_by_${via}`);
      return this.options.worker.stop().message ?? reachReplies.gone;
    }
    if (
      looksSecret(said) ||
      looksSecretStrict(said) ||
      ((item.kind === "signin" || item.kind === "code") &&
        /\d(?:[\s.-]?\d){3,}/.test(said))
    ) {
      this.record(item, `secret_refused_${via}`);
      return reachReplies.secret;
    }
    if (item.mode === "free" && holdsBack(said)) {
      this.record(item, `held_${via}`);
      return `${reachReplies.held} ${item.spoken}`;
    }
    // A question that waits for a yes takes the strict yes of the chat, or a
    // plain no. Anything else (a doubt, a condition, a delay, a refusal that
    // is no plain no, a thanks) goes nowhere, and the question waits.
    let handed = said;
    if (item.mode === "yes_no") {
      if (explicitApprovalNo.test(said)) handed = "no";
      else if (!explicitApprovalYes.test(said)) {
        this.record(item, `unclear_${via}`);
        return `${reachReplies.unclear} ${item.question}`;
      }
    }
    item.answeredVia = via;
    let message: string;
    try {
      message = (await this.options.worker.answer(handed)).message;
    } catch {
      message = reachReplies.gone;
    }
    // Words that the worker did not take leave the question as it was.
    if (this.read()?.key === item.key) {
      delete item.answeredVia;
      this.record(item, `unclear_${via}`);
    } else this.record(item, `answered_by_${via}`);
    return message;
  }

  /** What the proactive call path of the line asks of the reach. */
  proactiveSource() {
    return {
      evidence: (intent: ProactiveCallIntent): ProactiveSourceEvidence => {
        const source = intent.source;
        const item = this.item;
        const mine =
          source.kind === "computer" &&
          !!item &&
          item.id === source.decisionId &&
          item.requestId === source.runId;
        const current = mine && this.read()?.key === item!.key;
        const spoken = mine
          ? item!.spoken
          : "This question of the computer task no longer waits.";
        return {
          current,
          sourceFingerprint: digest(JSON.stringify([source, spoken])),
          goal: "A computer task on this Mac",
          status: "decision",
          summary: spoken,
          question: spoken,
          checks: [],
          artifacts: [],
          views: [],
        };
      },
      answer: (intent: ProactiveCallIntent, words: string) =>
        intent.source.kind === "computer"
          ? this.reply(words, "call", intent.source.decisionId)
          : Promise.resolve(reachReplies.gone),
      /** Stop said on the call stops the computer work, whatever it asked. */
      stop: (intent: ProactiveCallIntent) => {
        const item = this.item;
        if (
          item &&
          intent.source.kind === "computer" &&
          item.id === intent.source.decisionId
        ) {
          item.answeredVia = "call";
          this.record(item, "stopped_by_call");
        }
        try {
          this.options.worker.stop();
        } catch {
          // Stop is asked again by the next word or button.
        }
      },
    };
  }

  /** What the reach can do now, for `clawdtime computer doctor`. Written when it changes, and every minute. */
  readiness() {
    const side = (port?: {
      readiness(): { ready: boolean; reason: string };
    }) => {
      try {
        return port?.readiness() ?? { ready: false, reason: "not_set_up" };
      } catch {
        return { ready: false, reason: "readiness_failed" };
      }
    };
    return { calls: side(this.options.call), texts: side(this.options.text) };
  }
  private showReadiness() {
    const now = this.now();
    // Checked every 30 seconds, and written when it changed or got old.
    if (this.readinessAt && now - this.readinessAt < 30_000) return;
    this.readinessAt = now;
    const state = this.readiness();
    const shown = JSON.stringify(state);
    if (
      shown === this.readinessShown &&
      now - (this.file.readiness?.at ?? 0) < 120_000
    )
      return;
    this.readinessShown = shown;
    this.file.readiness = {
      at: now,
      calls: { ready: state.calls.ready, reason: state.calls.reason },
      texts: { ready: state.texts.ready, reason: state.texts.reason },
    };
    this.save();
  }
}

/** The text side over the settings of the text channel in the environment of the service. */
export function ownerTextPort(
  env: Record<string, string | undefined>,
  root: string,
  request: typeof fetch = fetch,
): ReachTextPort {
  const settled = ():
    { settings: TextSettings; line: string } | { reason: string } => {
    const found = textSettings(env);
    if ("missing" in found)
      return { reason: `missing:${found.missing.join(",")}` };
    const line = ownerTextLine(root, found.settings);
    if (!line) return { reason: "no_line" };
    return { settings: found.settings, line };
  };
  return {
    readiness() {
      const found = settled();
      return "settings" in found
        ? { ready: true, reason: "ready" }
        : { ready: false, reason: found.reason };
    },
    async send(key, text) {
      const found = settled();
      if (!("settings" in found)) return `refused:${found.reason}`;
      return sendOwnerText(found.settings, found.line, key, text, request);
    },
  };
}

/** What the reach needs of the proactive call path of the line. */
export interface ProactiveReachDeps {
  coordinator: {
    enqueue(input: EnqueueCall): { record: ProactiveCallIntent };
    get(id: string): ProactiveCallIntent;
    cancel(id: string, reason?: string): ProactiveCallIntent;
    list(): ProactiveCallIntent[];
    authority: { list(): ProactivePolicy[] };
  };
  /** The outbound line of the service is configured. */
  configured: () => boolean;
  /** The selected project: a policy of it lets the reach call. */
  projectRoot: string;
  /** Runs the call queue now, so that a call does not wait for the next turn. */
  pump?: () => void;
  /** Ends a call that is on its way. */
  stop?: (intentId: string) => void;
  /** The line is in a call now. */
  liveCall?: () => boolean;
  now?: () => number;
}

/** The call side over the proactive call path of the line: one intent for one question. */
export function proactiveReachCall(deps: ProactiveReachDeps): ReachCallPort {
  const now = deps.now ?? Date.now;
  const policy = (
    trigger: CallTrigger,
  ): { policy: ProactivePolicy } | { reason: string } => {
    const fitting = deps.coordinator.authority
      .list()
      .filter(
        (p) =>
          p.revokedAt === undefined &&
          p.expiresAt > now() &&
          p.scope.projectRoot === deps.projectRoot &&
          (!p.scope.sessionId || p.scope.sessionId === reachSession) &&
          !p.scope.taskId &&
          p.triggers.includes(trigger) &&
          p.channels.includes("phone_alert"),
      );
    return fitting.length === 1
      ? { policy: fitting[0]! }
      : {
          reason: fitting.length ? "calling_policy_ambiguous" : "no_policy",
        };
  };
  return {
    readiness() {
      if (!deps.configured())
        return { ready: false, reason: "outbound_setup_missing" };
      const chosen = policy("decision");
      if (!("policy" in chosen)) return { ready: false, reason: chosen.reason };
      if (deps.coordinator.list().some((intent) => intent.state === "unknown"))
        return { ready: false, reason: "earlier_call_unknown" };
      if (deps.liveCall?.()) return { ready: false, reason: "line_in_a_call" };
      return { ready: true, reason: "ready" };
    },
    place(ask) {
      const trigger: CallTrigger =
        ask.kind === "blocked" ? "failure" : "decision";
      const chosen = policy(trigger);
      if (!("policy" in chosen)) return { refused: chosen.reason };
      const scope: CallScope = {
        personId: chosen.policy.scope.personId,
        deviceId: chosen.policy.scope.deviceId,
        projectRoot: chosen.policy.scope.projectRoot,
        sessionId: reachSession,
      };
      const { record } = deps.coordinator.enqueue({
        source: {
          kind: "computer",
          sessionId: reachSession,
          runId: ask.requestId,
          decisionId: ask.key,
        },
        scope,
        policyId: chosen.policy.id,
        trigger,
        channel: "phone_alert",
        expiresAt: Math.min(now() + 10 * 60_000, chosen.policy.expiresAt),
        brief: ask.spoken.slice(0, 4000),
      });
      try {
        deps.pump?.();
      } catch {
        // The queue runs again on its own turn.
      }
      return { id: record.id };
    },
    phase(id) {
      const record = deps.coordinator.get(id);
      const connected = record.history.some(
        (entry) => entry.state === "connected",
      );
      switch (record.state) {
        case "queued":
        case "preparing":
        case "ready":
          return {
            phase: "unsent",
            ...(record.reason ? { reason: record.reason } : {}),
          };
        case "dispatching":
        case "connected":
          return {
            phase: "live",
            connected: connected || record.state === "connected",
          };
        case "ended":
          return {
            phase: "over",
            result: connected ? "answered" : "not_answered",
          };
        case "unknown":
          return {
            phase: "over",
            result: connected ? "answered" : "unknown",
            ...(record.reason ? { reason: record.reason } : {}),
          };
        default:
          return {
            phase: "over",
            result: "failed",
            ...(record.reason ? { reason: record.reason } : {}),
          };
      }
    },
    cancel(id) {
      return (
        deps.coordinator.cancel(id, "reach_taken_back").state === "canceled"
      );
    },
    end(id) {
      deps.stop?.(id);
    },
  };
}

/**
 * The owner's words in the chat, on a call or by text, before the language
 * model of the chat reads them: a routine to add, or the reply to a text of
 * the reach. Everything else goes to `say` as before. A text of the owner
 * marks the time in which a request starts by text.
 */
export function withOwnerWords<Rest extends unknown[], Message>(
  say: (text: string, ...rest: Rest) => Promise<Message>,
  deps: {
    reach?: OwnerReach | undefined;
    /** A routine to add, list or change from the words, or null when they are no such thing. */
    routine?: (words: string) => string | null;
    /** True when the text channel handed these exact words over. */
    fromText?: (words: string) => boolean;
    /** Makes the answer of the chat from a reply of the reach or the routines. */
    answered: (text: string, reply: string, ...rest: Rest) => Message;
    now?: () => number;
  },
): (text: string, ...rest: Rest) => Promise<Message> {
  const now = deps.now ?? Date.now;
  return async (text, ...rest) => {
    let fromText = false;
    try {
      fromText = deps.fromText?.(text) ?? false;
    } catch {
      fromText = false;
    }
    let routine: string | null = null;
    try {
      // Words with a stop word always go on: Stop wins over a routine.
      routine =
        readWords(text) === "stop" ? null : (deps.routine?.(text) ?? null);
    } catch {
      routine = null;
    }
    if (routine !== null) return deps.answered(text, routine, ...rest);
    if (fromText && deps.reach?.awaitsText())
      return deps.answered(text, await deps.reach.reply(text, "text"), ...rest);
    if (!fromText || !deps.reach) return say(text, ...rest);
    const start = now();
    deps.reach.textTurn(start);
    try {
      return await say(text, ...rest);
    } finally {
      deps.reach.textTurnEnded(start, now());
    }
  };
}
