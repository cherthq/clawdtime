/**
 * Computer use: the worker.
 *
 * The person says what to do on this Mac. The worker then works by itself,
 * one request at a time and one action at a time:
 *
 *   look at the screen, ask the planner for ONE action, check that action in
 *   code, look again just before it goes out, send it through the hands or the
 *   browser, look again, repeat.
 *
 * The planner is a language model, so its output is an untrusted
 * single-action plan. The promises below hold whatever it says:
 *
 * - Every action is checked against what the worker last saw (`guards.ts`),
 *   and again against a look that is taken just before the input goes out.
 * - A secure field is never typed into. The person types it.
 * - A name or a key that cannot be undone, or that speaks for the person,
 *   needs the person's yes. So does typing in a terminal. The yes is read by
 *   the same conservative reader that reads a yes on a phone call.
 * - Stop is checked before and after every action. Stop is cooperative: an
 *   action that was already sent may finish, and nothing follows it.
 * - Done counts only after an observation that came after the last action.
 * - A request whose result is not known is never repeated. It is `uncertain`
 *   and blocks new work until the person clears it.
 * - What the person says while a request runs is for that request, and the
 *   request goes on by itself (`readMidTask` in `orders.ts`). Every message
 *   that is not a stop goes to the planner as their newest words. It starts
 *   no second request, it is no answer to a question, and it is no yes to an
 *   action. Only a plain request to pause pauses, and any next message ends
 *   the pause. With the owner's trust a pause also ends by itself after a
 *   bounded time. Words that hold a secret are never kept, and pause nothing.
 * - An action that was not sent is kept as not sent, and is not planned again
 *   and again in silence. When the person took over, the request pauses at
 *   once and says what it wanted to do. Three held steps in a row with the
 *   same reason make the worker wait, with no input, until two looks in a row
 *   show the same screen. Then the planner chooses again. After two such
 *   waits, or a screen that never settles, the task ends with what happened
 *   and what the person can do.
 * - The same action that was tried three times with no result is told to the
 *   planner. When the planner then chooses it again in the same place, the
 *   request ends and says what was tried. It never says done for that. An
 *   answer of the person gives the action a new start.
 * - Steps that go in circles are told to the planner (`progress.ts`): the
 *   same two or three actions again and again, or inputs after which the
 *   screen shows nothing new. Twice the planner gets a note with other ways.
 *   Then the person is asked one short question, and their answer goes on.
 * - A first give_up that is not about the person, a permission, a password
 *   or a secret goes back to the planner with the ways it did not try.
 * - A planner call that failed for a short time is waited for, within the
 *   time limit. No quota left or a key that does not work ends the request at
 *   once and says why. The signal of each planner call is aborted when the
 *   worker stops waiting for it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutionAuthority,
  DesktopExecutorPort,
} from "../../src/control/desktop-executor.js";
import {
  explicitApprovalNo,
  explicitApprovalYes,
  interpret,
} from "../agents/call.js";
import { looksSecret } from "../agents/memory.js";
import {
  actionSchema,
  againstPage,
  browserMethods,
  check,
  clean,
  focusedSecure,
  quietCall,
  readsBeforeCall,
  retarget,
  type BrowserCall,
  type Checked,
  type View,
  hasTextFocus,
  closerPart,
  yesQuestion,
} from "./guards.js";
import {
  closerChangedText,
  closerHold,
  closerOutOfDate,
  closerScene,
  closerSecureText,
  closerShowsSecure,
  type CloserScene,
} from "./closer.js";
import { textKeyHold } from "./text-keys.js";
import {
  guidanceLimit,
  looksBareSecret,
  looksSecretStrict,
  namesSecret,
  type ComputerJournal,
  type JournalRequest,
  type RequestState,
} from "./journal.js";
import { casualWords, defersWork, readMidTask, readWords } from "./orders.js";
import { HandsTimeout } from "./panel-hands.js";
import {
  activationRefusal,
  clearHint,
  desktopBlockedText,
  noOtherAppText,
  verifiedDesktopSwitch,
  inputUnknownText,
  sameSurface,
  transitionUnknownText,
  verifiedActivation,
  coveredText,
  coversThePlace,
} from "./desktop.js";
import { BrowserClosed, handErrors } from "./ports.js";
import { navigationIntentSchema, type NavigationIntent } from "./navigation.js";
import { directAddress, webAddress } from "./navigation.js";
import { directOpening } from "./planner.js";
import { supportedBrowsers } from "./browser.js";
import { errorPage, notLoadedNote } from "./error-page.js";
import { BrowserInputUnknown } from "./own-browser.js";
import {
  giveUpNote,
  otherWays,
  ProgressGuard,
  type ProgressContext,
  type ProgressStep,
} from "./progress.js";
import { planUpdateSchema, TaskPlan } from "./plan.js";
import { Opening } from "./opening.js";
import type { ComputerMemory } from "./remembered.js";
import type {
  Action,
  BrowserPage,
  BrowserPort,
  HandCommand,
  HandResult,
  Hands,
  HandsNext,
  Observation,
  Planner,
  StepRecord,
  Closer,
} from "./ports.js";

/** What every way to stop says. It never claims that an action was undone. */
export const stoppedText =
  "Stopped. An action that was already sent may have finished.";
const offStoppedText =
  "Computer use was turned off, so I stopped. An action that was already sent may have finished.";
const busyText =
  "A computer task is already running. Stop it, or wait for it to end, before a new one.";
/** The most characters of what the person adds to a request that runs. */
const guidanceLength = 600;
/** How many ids of such words the worker remembers, so that none of them starts a request later. */
const rememberedWords = 256;
/**
 * What the person hears about their words while a request runs. The task goes
 * on by itself: no sentence asks for a magic word to go on. Each sentence says
 * where the words are now. None says that they were done.
 */
const guidedText = "Got it. I take that into the task that runs.";
const resumedText = "Got it. I go on with the task and take that into it.";
const goingOnText = "I go on with the task.";
const continuingText = "Continuing.";
const pausedText = "Paused. Your next message goes on with it.";
const stillPausedText = "Still paused. Your next message goes on with it.";
const atEndText =
  "The task is at its end, so it takes no more words. Ask again when it has ended.";
/** The words came while a yes or an answer was awaited: what waited is set aside, and nothing is approved. */
const asideText = {
  yes_no:
    "Got it. I take that into the task and choose again. That was no yes: what waited for one is set aside.",
  free: "Got it. I take that into the task and choose again. The question that waited is set aside.",
} as const;
const asidePausedText = {
  yes_no:
    "Paused, and what waited for your yes is set aside. Your next message goes on with it.",
  free: "Paused, and the question that waited is set aside. Your next message goes on with it.",
} as const;
const asideGoText =
  "The question that waited is set aside, and I go on with the task.";
const noYesText = (question: string) =>
  `That was no yes, so it still waits. ${question}`;
const waitsText = (question: string) => `It waits for your answer. ${question}`;
/** With the owner's trust, a pause with no message ends by itself after this time. */
const resumePauseMs = 60_000;
const unclearText = (question: string) =>
  `I did not get a clear answer. ${question}`;
const guidanceFullText = `This task already took ${guidanceLimit} additions from you, and it takes no more.`;
const guidanceLongText = `That is longer than ${guidanceLength} characters, so I did not take it into the task that runs. Say it in fewer words.`;
const guidanceUnwrittenText =
  "The record of computer tasks could not be written, so I did not take that into the task.";
/** Why an action that was on its way was held back: it was chosen without the person's newest words. */
const saidMoreText = "The person said more before it went out.";
const heldByWordReason = "The person asked to hold before it went out.";
const ownershipText =
  "Screen input is held by the current phone walkthrough or an unresolved owner. No new computer action was sent.";
/** The state when nothing runs: a fact for the state route and the chat's model, no invitation. */
const idleText = "Computer use is on. No computer task runs now.";
export const offText =
  "Computer use is off. Turn it on with: clawdtime computer on";
const takeoverText =
  "You moved the mouse or pressed a key, so I paused. Your next message goes on with it.";
/**
 * The pause when an action was held back for the person. `wanted` is what
 * the action would have done. No sentence here says that it was done.
 */
const holdText = (wanted: string) =>
  `You are using the Mac, so I paused. Next I wanted to ${wanted}. Your next message goes on with it.`;
/** This many held steps in a row with the same reason end the task. */
const heldLimit = 3;
/** This many held steps in a row across any reasons end the task. */
const heldTotalLimit = 5;
const retiredReason =
  "The desktop or display changed. Old coordinates were retired; nothing was sent.";
const frontChangedReason =
  "Another app or window came to the front. Nothing was sent.";
const targetGoneReason =
  "The screen changed: the target is no longer there. Nothing was sent.";
const screenChangedReason = "The screen changed since the planner looked.";
const screenUnreadReason =
  "The screen could not be read just before the action.";
const pageChangedReason = "The page changed since it was read.";
const pageUnreadReason = "The page could not be read just before the action.";
/** Groups held reasons that report the same underlying block. */
const heldKey = (reason: string) =>
  reason === retiredReason || reason.includes("(stale_observation)")
    ? "surface_changed"
    : reason === targetGoneReason || reason === screenChangedReason
      ? "target_changed"
      : reason;
/**
 * The end of a request after three held steps in a row with the same reason:
 * what happened in plain words, truthfully whether anything went out
 * earlier, and what the person can do. Never says done. `waited`: the worker
 * waited for the screen to settle before, and it did not help.
 */
const heldEndText = (reason: string, sentBefore = false, waited = false) => {
  const noneSent = sentBefore
    ? "so nothing more was sent"
    : "so nothing was sent";
  const after = (what: string) =>
    waited ? `, also after I waited for the ${what} to settle` : "";
  if (reason === coveredText)
    return `A list or a card of the app kept lying over the place I wanted to use${after("screen")}, ${noneSent}. Press Escape to close it, then ask again.`;
  if (reason === retiredReason || reason.includes("(stale_observation)"))
    return `The screen kept changing under me${after("screen")}, ${noneSent}. Close any open menu or list in front, then ask again.`;
  if (reason === frontChangedReason)
    return `Another app or window kept coming to the front${after("screen")}, ${noneSent}. Bring the window you want to the front, then ask again.`;
  if (reason === targetGoneReason || reason === screenChangedReason)
    return `What I tried to use kept moving or disappearing before I could act${after("window")}, ${noneSent}. Wait until the window settles, then ask again.`;
  if (reason === screenUnreadReason)
    return `The screen could not be read before I acted${after("screen")}, ${noneSent}. Check that the window is visible and the ClawdTime panel is running, then ask again.`;
  if (reason === pageChangedReason)
    return `The page kept changing before I could act${after("page")}, ${noneSent}. Wait until the page finishes loading or settles, then ask again.`;
  if (reason === pageUnreadReason)
    return `The browser page could not be read before I acted${after("page")}, ${noneSent}. Check the browser window, then ask again.`;
  return `The panel could not send the action, ${noneSent}. Check the window and the ClawdTime panel, then ask again.`;
};
/** The end of a request after held steps across alternating reasons with no progress. */
const mixedHeldEndText = (
  surface: "window" | "page" | "mixed",
  times: number,
  sentBefore: boolean,
  waited = false,
) => {
  const noneSent = sentBefore
    ? "so nothing more was sent"
    : "so nothing was sent";
  const after = waited ? ", also after I waited for it to settle" : "";
  if (surface === "page")
    return `${times} of my last actions were held back and the page did not move on${after}, ${noneSent}. Wait until the page settles, then ask again.`;
  if (surface === "window")
    return `${times} of my last actions were held back and the window did not move on${after}, ${noneSent}. Wait until the window settles, then ask again.`;
  return `${times} of my last actions were held back and nothing moved on${waited ? ", also after I waited for the screen to settle" : ""}, ${noneSent}. Wait until things settle, then ask again.`;
};
/** A held reason that waiting can help: the screen or the page was another one. Not a fault of the panel. */
const settles = (reason: string) =>
  !reason.startsWith("The panel did not run it") ||
  reason.includes("(stale_observation)");
/** Held rows that end in a wait for the screen to settle, in one request. Then the next row ends it. */
const settleLimit = 2;
/** Looks at most in one wait for the screen to settle, and the pause between two of them. */
const settleLooks = 8;
const settlePauseMs = 400;
/** The most time of one wait for the screen to settle, whatever the looks. */
const settleBoundMs = 6_000;
/** What the planner reads in the line of the last held step, after the screen settled. */
const settledNote =
  "Then the worker waited with no input until the screen was still. Choose again from the new look: the target may be in another place now.";
/** Waits after a planner call that failed for a short time, in one request. */
const transientLimit = 3;
/** The pause after such a failure, and the most that the planner may ask for. */
const transientPauseMs = 3_000;
const transientMostMs = 15_000;
/** Why the planner could not choose, as the planner names it. Absent for an error of another kind. */
const troubleOf = (error: unknown) => {
  const trouble = (error as { trouble?: unknown } | null)?.trouble;
  return typeof trouble === "string" ? trouble : undefined;
};
const retryAfterOf = (error: unknown) => {
  const after = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof after === "number" && Number.isFinite(after) && after > 0
    ? after
    : 0;
};
/**
 * A reason to give up that only the person can change, or a risk: their
 * decision, an account, a permission, a password or a secret, money, or a
 * harm. Such a give_up ends at once. Every other first give_up is told the
 * ways that were not tried. A plain "you" is no such reason: "the button
 * you named does nothing" is about the screen.
 */
const forThePerson =
  /\b(?:person|people|user|human|owner|permissions?|allow(?:ed)?|access|privacy|accessibility|screen recording|automation|passwords?|passcode|passphrase|pin|secrets?|credentials?|tokens?|api key|license key|2fa|two[- ]factor|verification code|one[- ]time code|captcha|sign[- ]?in|log[- ]?in|login|accounts?|pay|payment|purchase|buy|card|bank|money|consent|approv(?:e|al)|confirm|decide|decision|choose|choice|unsafe|dangerous|danger|harm(?:ful)?|risk(?:y)?|destructive|irreversible|illegal|forbidden|prohibited|policy|refuse|malicious|private|confidential)\b/i;
/** A request that the person ended with a plain no to a question of the worker. */
const plainNo =
  /^\s*(?:no|nope|nah|no thanks|no thank you|never mind|nevermind)\s*[.!]*\s*$/i;
const progressRefusal = "Canceled. The task is not finished.";
/** The digest that a wait for the screen to settle compares: the surface, the app, the window and the elements, with no picture. */
const settlePrint = (seen: Observation | null) =>
  seen && `${seen.surfaceEpoch ?? "-"}|${screenPrint(seen, null, false)}`;
/** The digest that the progress guard compares: the surface and the screen with its picture. */
const progressPrint = (seen: Observation | null) =>
  seen && `${seen.surfaceEpoch ?? "-"}|${screenPrint(seen, null, true)}`;
const browserApps = new Set(supportedBrowsers.map((browser) => browser.id));
/** The signature of an action for the progress guard: the guards' one, or the kind and the direction. */
const progressSignature = (action: Action, checked: Checked) =>
  checked.verdict === "run" && checked.signature !== null
    ? checked.signature
    : JSON.stringify([
        action.kind,
        "direction" in action ? action.direction : null,
      ]);
/** Inputs after which a screen that looks the same means that they may not have worked. */
const stillKinds = new Set(["click_element", "click_at", "key", "type"]);
/** The same action is tried this many times with no result before the planner is told. It is the limit of the refusals. */
const repeatLimit = 3;
const repeatNote = (times: number) =>
  `This action did not work ${times} times in a row: it was not sent, or the screen did not change after it. Choose another way. If you choose the same action again now, the task ends.`;
/** The planner reads this many of its last steps. */
const shownSteps = 12;
const silentText = (sentBefore = false) =>
  `The ClawdTime panel did not answer, ${sentBefore ? "so nothing more was sent" : "so nothing was sent"}. Open the panel and ask again.`;
/** The end after two planner failures in a row, by what the last one was. */
const plannerText = (trouble?: string) =>
  trouble === "malformed"
    ? "The planner gave no usable action twice in a row, so I stopped. Nothing more was sent. Ask again, perhaps in other words."
    : trouble === "refused"
      ? "The planner refused to choose an action twice in a row, so I stopped. Nothing more was sent. Ask again in other words."
      : trouble === "transient"
        ? "The planner did not answer after several tries, so I stopped. Nothing more was sent. Ask again in a moment."
        : "The planner did not answer twice in a row, so I stopped. Nothing more was sent. Ask again in a moment.";
const quotaText =
  "The language model account has no quota left, so I stopped. Nothing more was sent. Add credit or raise the limit of the key, then ask again.";
const authText =
  "The language model did not accept the key, so I stopped. Nothing more was sent. Check CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY of the desktop service, then ask again.";
const refusalsText = (last?: string) =>
  `The planner chose 3 actions in a row that the checks refused, so I stopped.${last ? ` The last reason: ${last}` : ""} Ask again in other words.`;
const giveUpText = (reason: string) =>
  [
    "I could not finish.",
    reason,
    "Tell me another way to try, or do this step yourself.",
  ]
    .filter(Boolean)
    .join(" ");
/** Plan: the planner changed its plan again and again, and chose no action. */
const planLoopText =
  "The planner changed its plan again and again and chose no action, so I stopped. Nothing more was sent. Ask again, perhaps in other words.";
const faultText = `Something failed inside the worker, so I stopped. An action may have been sent. ${clearHint}`;
const secretText =
  "I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself.";
const unwrittenText =
  "The record of computer tasks could not be written, so nothing was started.";
const grantText = {
  no_accessibility:
    "ClawdTime may not control this Mac yet. Open System Settings, Privacy & Security, Accessibility, and turn on the ClawdTime panel. Then ask again.",
  no_screen_recording:
    "ClawdTime may not see the screen yet. Open System Settings, Privacy & Security, Screen & System Audio Recording, and turn on the ClawdTime panel. Then ask again.",
} as const;
const lostText = (label: string) =>
  `I sent this and its result never came back: ${label}. It may have happened or not. I do not send it again. ${clearHint}`;
const uncertainText = (request: JournalRequest) =>
  request.reason === "unreadable_journal"
    ? `The record of computer tasks cannot be read, so I cannot tell whether an earlier task has an unknown result. Nothing new starts until it is cleared. ${clearHint}`
    : `An earlier computer task has an unknown result: "${request.goal}". It is not run again. ${clearHint}`;
const unclearedText =
  "The record of computer tasks could not be cleared now. Say it again in a moment.";
/**
 * The end of a request whose planner chose the same action again after it
 * was told that it did not work: what was tried, what the screen shows, and
 * what the person can do. It never says that the action was done.
 */
const stuckText = (
  row: Row,
  /** The action in words, and the same with the field that has the focus now. */
  tried: string,
  wanted: string,
  seen: Observation | null,
) => {
  const notSent = row.count - row.sent - row.clicked;
  const came =
    row.sent === row.count
      ? "and I saw no change on the screen after it."
      : row.sent === 0 && row.clicked === 0
        ? `and it was never sent.${row.reason ? ` The last reason: ${row.reason}` : ""}`
        : `and it did not work. ${[
            row.sent > 0
              ? `Sent with no change on the screen that I saw: ${row.sent}.`
              : "",
            row.clicked > 0
              ? `Clicked the field without typing: ${row.clicked}.`
              : "",
            notSent > 0 ? `Not sent: ${notSent}.` : "",
          ]
            .filter(Boolean)
            .join(" ")}`;
  // The name of the app only. The title of a window can hold what was typed.
  const app = seen ? clean(seen.app.name, 60) : "";
  return `I tried ${row.count} times to ${tried}, ${came} So I stopped: the task is not finished.${app ? ` ${app} is in front.` : ""} You can ${wanted} yourself, or ask me again in other words.`;
};
const focusStuckText = (focus: FocusClicks, seen: Observation | null) => {
  const app = seen ? clean(seen.app.name, 60) : "";
  return `I clicked ${focus.field} ${focus.count} times and could not type into it, so I stopped: the task is not finished.${app ? ` ${app} is in front.` : ""} You can ${focus.wanted} yourself, or ask me again in other words.`;
};

/** What `GET /desktop/computer` answers. */
export const computerStatusSchema = z
  .object({
    version: z.literal(1),
    /** Computer use is on, and a worker runs in this service. */
    enabled: z.boolean(),
    /** idle, running, waiting_for_person, stopping, completed, blocked, canceled, uncertain. */
    state: z.string().max(40),
    message: z.string().max(2000),
    step: z.number().int().nonnegative(),
    goal: z.string().max(300),
    /** What the worker asks the person now. Null when it asks nothing. */
    question: z.string().max(2000).nullable(),
    /** What the person said for the request that runs after it began, oldest first. Absent when they said nothing more. */
    guidance: z.array(z.string().max(300)).max(guidanceLimit).optional(),
    /**
     * Why the request that runs waits for the person: they took over the Mac
     * and it paused, an action needs their yes, or the planner asked them a
     * question. Absent when it does not wait.
     */
    waiting: z.enum(["takeover", "approval", "question"]).optional(),
  })
  .strict();
export type ComputerStatus = z.infer<typeof computerStatusSchema>;

/** How long the parts of one step took. Numbers and the kind of action only, never a text of the screen. */
export interface StepTiming {
  step: number;
  /** The kind of the planned action: click_element, type, done. */
  kind: string;
  /** The look at the screen before the plan. Zero when the last look was still good. */
  lookMs: number;
  /** The planner's answer. */
  planMs: number;
  /** The checks, the questions to the person, and the action itself. */
  actMs: number;
  /**
   * Why the worker held the step back, when it did: one of its own fixed
   * sentences ("Another app or window came to the front. Nothing was sent."),
   * never a text of the screen.
   */
  held?: string;
  /**
   * What the worker did to get the request moving since the entry before,
   * in its own fixed words: `nudge_swing`, `nudge_still`, `ask_swing`,
   * `ask_still`, `end_swing`, `end_still`, `give_up_nudge`, `settled`,
   * `unsettled`, `transient`. Absent when it did none of these.
   */
  recovery?: string[];
  /** The time of those waits for the screen to settle and for the planner, in milliseconds. */
  waitMs?: number;
}

export interface ComputerWorkerOptions {
  hands: Hands;
  planner: Planner;
  journal: ComputerJournal;
  /** The browser, when one is connected. Without it the browser actions are refused. */
  browser?: BrowserPort;
  /** Whether computer use is still on. It is read before every action, so turning it off stops a request. */
  enabled?: () => boolean;
  /**
   * Says something to the person when no message of theirs waits for an
   * answer: the first line of a request (`opening.ts`), a question, the
   * result.
   */
  notify?: (text: string) => void;
  /** How long the outline's line for the person may take before the planner's first reason stands in (`opening.ts`). */
  openingMs?: number;
  /** Hears the time of each step, for a person who looks for the slow part. */
  timing?: (entry: StepTiming) => void;
  now?: () => number;
  /** The most actions that the planner may choose for one request. */
  maxSteps?: number;
  /** The most actions for a request whose plan had 3 subgoals or more (`plan.ts`). */
  plannedMaxSteps?: number;
  /**
   * A done right after a click, a key or typed text that left the screen as
   * it was goes back to the planner once. The service turns it on; made-up
   * hands of tests show one screen, so it is off unless asked for.
   */
  unchangedDone?: boolean;
  /**
   * The owner's trust: no question before an action of the ask policy. The
   * checks still refuse what they refuse, the last look before an input still
   * runs, Stop still wins, a result that is not known is never sent again,
   * and a password is still typed by the person. Off unless the owner turns
   * it on (`CLAWDTIME_COMPUTER_TRUST=on` for the desktop service).
   */
  trust?: boolean;
  /**
   * With the owner's trust, a pause with no message from the person ends by
   * itself after this time, and the task goes on. Without trust a pause waits
   * for the next message. Read against `now`. 60 seconds unless set.
   */
  resumeMs?: number;
  /** The most time for one request, with the time it waits for the person. */
  maxMs?: number;
  /** How long one call to the browser may take. */
  browserMs?: number;
  /** The pause between two looks of a wait for the screen to settle. */
  settleMs?: number;
  /** The most waits for the screen to settle in one request, in place of the end of a held row. */
  settleLimit?: number;
  /** The pause after a planner call that failed for a short time. */
  transientMs?: number;
  /**
   * The person's memory (`remembered.ts`). Before a request the planner gets
   * the few notes that fit its goal, and after it what the owner taught is
   * kept. It does nothing while memory is off. Without it the worker reads
   * and keeps nothing there.
   */
  memory?: ComputerMemory;
}

type Reply =
  | { kind: "yes" }
  | { kind: "text"; text: string }
  /**
   * The person said something else for the request in place of an answer.
   * It is no yes and no answer: what waited is not done, and the request goes
   * on to the planner's next choice.
   */
  | { kind: "aside" }
  /** The request ended while it waited: Stop, a no, the time limit. */
  | { kind: "over" };
interface Question {
  text: string;
  /** How the answer is read: a yes or no, continue or stop, or any words. */
  mode: "yes_no" | "continue" | "free";
  /** Why a continue pause is held, when `mode` is `"continue"`. */
  pause?: "takeover" | "hold";
  /** When the question began, by `now`. */
  since: number;
  /** What the person is told when their answer ends the request. */
  refusal: string;
  /** For a free question of the worker itself: a plain no or a stop word ends the request. */
  stopOnNo?: boolean;
  settle: (reply: Reply) => void;
}
/** Why a request waits, in the word that the status and the snapshot carry. */
const waitingFor = {
  continue: "takeover",
  yes_no: "approval",
  free: "question",
} as const;
/** What the person said for a request after it began. */
interface Guidance {
  /** The id that the words came with. The same id is taken once. */
  id: string;
  /** The words as one line, for the planner and for the checks. */
  text: string;
  /** The same as the journal keeps them, for the panel and the chat. */
  shown: string;
}
/** Words join a request only from the surface that started it: the same call, or no call on both sides. */
const sameSpeaker = (
  started: DesktopExecutionAuthority | undefined,
  said: DesktopExecutionAuthority | undefined,
) => started?.callId === said?.callId;
interface Run {
  authority?: DesktopExecutionAuthority;
  /** The closer look that the planner asked for, for its next turn only. */
  closer?: Closer;
  /** What the closer picture was taken of: it goes only with a look of that scene. */
  closerScene?: CloserScene;
  /** The closer looks sent in this request (closer.ts). */
  closerLooks?: number;
  /** Why the step of this turn was not sent, for the timing record. */
  held?: string;
  /**
   * The person said yes to these questions for this action, and the action
   * was then not sent: the screen had to be read again. The yes holds once,
   * for a short time, for the same action with the same questions.
   */
  approval?: {
    signature: string;
    /** The app and the window in front, or the page, when the person said yes. The yes is for that place only. */
    place: string;
    questions: string[];
    at: number;
    /** How often the yes was used with no new question. Two times at most. */
    tries: number;
  };
  /** Why the browser cannot be driven in this request, once it said so. The screen is used from then on. */
  browserClosed?: string;
  navigation?: NavigationIntent;
  id: string;
  /** The person's words, for the planner. */
  goal: string;
  /** The same as the journal keeps them, for the panel. */
  shown: string;
  /** What the person said for this request after it began, oldest first. */
  guidance: Guidance[];
  /** Notes from memory that fit the goal, read before the request, for the planner. */
  remembered?: string[];
  /**
   * The owner's own words for this request after it began, oldest first:
   * the words that were kept for it, and the answers to its questions. What
   * memory may keep of the request, at its end.
   */
  taught: string[];
  /** How many of those the planner had when it last began to choose. */
  heard: number;
  deadline: number;
  step: number;
  state: "running" | "waiting_for_person" | "stopping";
  history: StepRecord[];
  /** The last full look at the screen. */
  observation: Observation | null;
  /** The last reading of the page. Null after an action on the screen. */
  page: BrowserPage | null;
  /** The observation came after the last action that was sent. */
  fresh: boolean;
  /**
   * What came of the action of this turn, for the row below. Absent: it does
   * not count there. Clicked: the focus click went out, and the text did not.
   * Free: it was not sent just after an answer of the person, so it is
   * counted and not held against the action.
   */
  tried?: "sent" | "clicked" | "unsent" | "free";
  /**
   * The person answered a moment ago. An answer itself changes what is in
   * front, so the action of this step or of the next one can be held back
   * for that alone. Up to this step, one such action is held against nothing.
   */
  grace?: number;
  /** The same action on the same target, tried in a row with nothing that moved the task on. */
  stuck?: Row;
  /** Focus clicks in a row on the same field that typed no text. Survives steps with no signature. */
  focusClicks?: FocusClicks;
  /** Held steps in a row, by reason and in total, whatever the action was. */
  heldRow?: {
    key: string;
    count: number;
    total: number;
    /** Whether the holds in this row were on a window, a page, or both. */
    surface: "window" | "page" | "mixed";
    /** Digest before a sent input during this row; if the next look is unchanged, the row stays. */
    sentBefore?: string | null;
  };
  /** True once any real input or app/page command went out in this request. */
  sentInput: boolean;
  /** True once an input went out in the step of this turn. */
  stepInput: boolean;
  /** The signature of the action of this turn, for the progress guard. */
  signed?: string;
  /** The step of the last turn, until the next look says what came of it. */
  pending?: Omit<ProgressStep, "after">;
  /** The kind of the last input, when the look after it showed the same screen as before it. */
  stillAfter?: string;
  /** A done after an input that changed nothing was sent back once. */
  stillNoted?: boolean;
  /** A done while the browser showed an error page was sent back once. */
  errorPageNoted?: boolean;
  /** Finds steps that go in circles. One for each request. */
  progress: ProgressGuard;
  /** How many of the person's additions the progress guard knows of. */
  progressHeard: number;
  /** How many give_up answers became a note to the planner. One at most. */
  gaveUp: number;
  /** A wait for the screen to settle is due, in place of the end of a held row. */
  settle?: {
    reason: string;
    surface: "window" | "page" | "mixed";
    /** The row was of mixed reasons, with this many held steps. */
    mixed: boolean;
    total: number;
  };
  /** Waits for the screen to settle in this request. */
  recoveries: number;
  /** Waits after a planner call that failed for a short time, in this request. */
  transientWaits: number;
  /** The abort of the planner call that runs now. */
  plannerAbort?: AbortController;
  /** What the worker did to get moving since the last timing entry, and how long it waited. */
  recovery: string[];
  waitMs: number;
  /** True once the initial look at the screen has completed at least once. */
  firstLookDone: boolean;
  /** Why the action of this turn was not sent, for the row: one of the worker's own fixed sentences. */
  why?: string;
  /** What the next pause says, when an action was held back: what it would have done. */
  pauseText?: string;
  refusals: number;
  plannerFailures: number;
  /** The plan of the request (`plan.ts`). Absent before the outline, and when the outline failed. */
  plan?: TaskPlan;
  /** The outline was asked for once. It is not asked again, whatever came of it. */
  outlined?: boolean;
  /** The first words of the request to the person, and its one line on a revision (`opening.ts`). */
  opening: Opening;
  question: Question | null;
  stop: boolean;
  /** The hands said that the person moved the mouse or pressed a key. */
  takeover: boolean;
  /** The person said words that forbid or ask to hold: pause before any further input. */
  hold: boolean;
  /**
   * The person's last words for this request (or the request itself) named a
   * secret or a field for one: a short value that comes next is a secret.
   */
  secretNamed?: boolean;
  /** True while an effect command is awaiting the hands or the browser. */
  inFlight: boolean;
  /** Wakes an in-flight planner call when `hold` is requested. */
  wake?: () => void;
  /**
   * The person used the mouse or the keyboard while the worker looked at the
   * screen to plan. A look and an answer need no pause for that. An input
   * does: the worker asks before the next one, and not before.
   */
  personNear: boolean;
  halt: () => void;
  halted: Promise<null>;
}
/** What came of one command to the hands. */
interface Handed {
  /** The command went to the hands. False: it certainly did not run. */
  sent: boolean;
  /** The request ended on the way. */
  over: boolean;
  /** Null when no result came back. */
  result: HandResult | null;
}
type Ready = Extract<Checked, { verdict: "run" }>;
/**
 * One action on one target, tried in a row. A try counts when it was not
 * sent, and when it went out and the screen was the same after it: the same
 * elements and the same picture. A try after which anything moved starts a
 * new row: Tab from field to field, a key that goes down a list, a caret
 * that moves. Another action starts a new row too. A scroll, a wait and a
 * reading have no signature, and change nothing here.
 */
interface Row {
  signature: string;
  /** The tries in a row, sent or not sent. */
  count: number;
  /** How many of them went out completely. */
  sent: number;
  /** How many of them sent only the focus click without typing text. */
  clicked: number;
  /** How many of them were not sent just after an answer of the person. They do not count toward the limit. */
  free: number;
  /** The last try went out. */
  lastSent: boolean;
  /** What the worker could compare of the screen, with its picture, when it last tried. Null: it was not read. */
  screen: string | null;
  /** The action goes to the page, so the reading of the page is compared too. */
  page: boolean;
  /** Why the last try was not sent: one of the worker's own fixed sentences. */
  reason: string | null;
  /** The step of the last try, to find its line in the history. */
  step: number;
  /**
   * The planner was told that the action did not work: the app, the window
   * and the elements in front at that time, with no picture. Null: they were
   * not read. The same action as the next choice of the planner, in the same
   * place, ends the request.
   */
  told?: string | null;
}
/** Focus clicks in a row on the same field that typed no text. */
interface FocusClicks {
  key: string;
  field: string;
  wanted: string;
  bundleId: string;
  window: string;
  role: string;
  title: string;
  count: number;
}
const focusMovedToField = (seen: Observation | null, focus: FocusClicks) =>
  seen !== null &&
  seen.app.bundleId === focus.bundleId &&
  seen.app.window === focus.window &&
  seen.elements.some(
    (item) =>
      item.focused && item.role === focus.role && item.title === focus.title,
  );

/** True for what changes nothing on the Mac: a wait, a look, and a reading of the page or of its tabs. */
const sendsNoInput = (send: Ready["send"]) =>
  send.via === "browser"
    ? quietCall(send.call)
    : send.command.kind === "wait" ||
      send.command.kind === "observe" ||
      send.command.kind === "zoom";

/**
 * The hands held an input back because the person moved the mouse or pressed
 * a key since the command began. They refuse before any event, so nothing
 * went out.
 */
const heldForPerson = (handed: Handed) =>
  !handed.over &&
  handed.result?.ok === false &&
  handed.result.error === "refused" &&
  handed.result.interrupted === true;

/**
 * What two looks can be compared by: the app and the window in front, the
 * elements with their names, values, places and focus, the picture, and the
 * reading of the page. The picture counts, because a caret that moved or a
 * row that is chosen now shows only there. The time of the look and the
 * place of the pointer do not count. It is kept as a digest only. Null when
 * the screen was not read: then nothing is known, and nothing is the same.
 */
const screenPrint = (
  seen: Observation | null,
  page: BrowserPage | null,
  /** Without the picture the digest names a place: it stays the same while a caret blinks. */
  picture = true,
) =>
  seen &&
  createHash("sha256")
    .update(
      JSON.stringify([
        [
          seen.app.bundleId,
          seen.app.window,
          seen.elements.map((item) => [
            item.role,
            item.title,
            item.value ?? null,
            item.x,
            item.y,
            item.w,
            item.h,
            item.enabled,
            item.focused,
          ]),
        ],
        page && [
          page.url,
          page.title,
          page.text,
          page.elements.map((item) => [
            item.tag,
            item.role,
            item.label,
            item.value ?? null,
            item.disabled,
          ]),
        ],
      ]),
    )
    .update((picture && seen.image) || "")
    .digest("hex");
/** Digest of a browser page reading alone, to detect whether a page command changed it. */
const pagePrint = (page: BrowserPage | null) =>
  page &&
  createHash("sha256")
    .update(
      JSON.stringify([
        page.url,
        page.title,
        page.text,
        page.elements.map((item) => [
          item.tag,
          item.role,
          item.label,
          item.value ?? null,
          item.disabled,
        ]),
      ]),
    )
    .digest("hex");
/** True when both looks were read and show the same. */
const sameScreen = (one: string | null, other: string | null) =>
  one !== null && one === other;

/**
 * What a checked action would do, in words for the person: its label, and
 * for keys and text the named field that has the focus. The label holds the
 * name of an element, never typed text.
 */
const wordsOf = (ready: Ready) =>
  ready.label.charAt(0).toLowerCase() + ready.label.slice(1);
const wantedOf = (action: Action, ready: Ready, seen: Observation | null) => {
  const words = wordsOf(ready);
  if (
    action.kind !== "key" &&
    !(action.kind === "type" && action.element === undefined)
  )
    return words;
  const field = seen?.elements.find(
    (item) => item.focused && !item.secure && clean(item.title, 80) !== "",
  );
  return field ? `${words} in "${clean(field.title, 80)}"` : words;
};

/** How long a yes holds for the same action, when the first try was not sent. */
const approvalHoldsMs = 60_000;
/** The wait before the second look, when the first one failed. */
const lookAgainMs = 300;

class BrowserSilent extends Error {}
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new BrowserSilent("The browser did not answer in time.")),
      ms,
    );
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
function withinOrHalted<T>(
  work: Promise<T>,
  ms: number,
  halted: Promise<null>,
): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BrowserSilent("The browser did not answer in time."));
    }, ms);
    timer.unref();
    halted.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
const tidy = (page: BrowserPage): BrowserPage => ({
  ...page,
  text: page.text.slice(0, 6000),
  elements: page.elements.slice(0, 200),
});
const clip = (text: string) => text.slice(0, 1900);
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
/** How a step ended, in words for the planner and in one word for the journal. */
const outcome = (handed: Handed): [string, string] =>
  !handed.result
    ? ["no result came back", "lost"]
    : handed.result.ok
      ? ["ok", "ok"]
      : handed.result.error === "transition_unknown"
        ? [
            "activation was requested; the target was not verified",
            "transition_unknown",
          ]
        : handed.result.error === "input_unknown"
          ? ["input began; its outcome is unknown", "input_unknown"]
          : [
              `did not run: ${handed.result.error ?? "failed"}`,
              handed.result.error ?? "failed",
            ];

/** A clear yes, a clear no, or null. The reader is the one that reads a yes on a call. */
function readYes(words: string): boolean | null {
  const said = interpret(words, { kind: "permission", options: [] });
  return said?.decision === "allow"
    ? true
    : said?.decision === "deny"
      ? false
      : null;
}
/**
 * The answer to a yes or no question: only the strict yes of the chat
 * approves ("yes", "yes, go ahead"). A yes with a condition, a delay, a doubt
 * or a thanks ("yes, but later", "ok thanks") is no answer, and the question
 * waits. A clear no is a no.
 */
function readApproval(words: string): boolean | null {
  if (explicitApprovalYes.test(words)) return true;
  if (explicitApprovalNo.test(words)) return false;
  return readYes(words) === false ? false : null;
}

export class ComputerWorker implements DesktopExecutorPort {
  private ownershipGuard: () => boolean = () => true;
  setOwnershipGuard(guard: () => boolean) {
    this.ownershipGuard = guard;
  }
  private ownsScreen() {
    try {
      return this.ownershipGuard();
    } catch {
      return false;
    }
  }
  private current: Run | null = null;
  /**
   * The ids of words that were taken as words for a request, whatever came
   * of them. Such an id never starts a request of its own: the same message
   * that comes a second time gets the state and nothing else.
   */
  private readonly words = new Set<string>();
  private last: {
    requestId: string;
    state: RequestState;
    message: string;
    goal: string;
    step: number;
  } | null = null;
  private ended: Promise<void> = Promise.resolve();
  /** The first words of the newest request, by its id, for `firstWords`. */
  private opened: { id: string; opening: Opening } | null = null;
  private readonly hands: Hands;
  private readonly planner: Planner;
  private readonly journal: ComputerJournal;
  private readonly browser: BrowserPort | undefined;
  private readonly timing: ((entry: StepTiming) => void) | undefined;
  private readonly enabled: () => boolean;
  private readonly now: () => number;
  private readonly maxSteps: number;
  private readonly plannedMaxSteps: number;
  private readonly maxMs: number;
  private readonly browserMs: number;
  private readonly settleMs: number;
  private readonly settleLimit: number;
  private readonly transientMs: number;
  private readonly resumeMs: number;
  /** How many answers came at a pause, to give each one an id of its own. */
  private answers = 0;

  constructor(private readonly options: ComputerWorkerOptions) {
    this.hands = options.hands;
    // A request that only opens one web address needs no model for that step.
    this.planner = directOpening(options.planner);
    this.journal = options.journal;
    this.browser = options.browser;
    this.enabled = options.enabled ?? (() => true);
    this.now = options.now ?? Date.now;
    this.maxSteps = options.maxSteps ?? 40;
    this.plannedMaxSteps = options.plannedMaxSteps ?? 80;
    this.maxMs = options.maxMs ?? 15 * 60_000;
    this.browserMs = options.browserMs ?? 30_000;
    this.settleMs = options.settleMs ?? settlePauseMs;
    this.settleLimit = options.settleLimit ?? settleLimit;
    this.transientMs = options.transientMs ?? transientPauseMs;
    this.resumeMs = Math.max(0, options.resumeMs ?? resumePauseMs);
    this.timing = options.timing;
    // A request that was running when the service stopped has an unknown
    // result. It becomes uncertain here, and nothing runs it again.
    this.journal.recover();
  }

  /** Resolves when the request that runs now has ended. At once when none runs. */
  idle() {
    return this.ended;
  }

  private say(text: string) {
    try {
      this.options.notify?.(clip(text));
    } catch {
      // A message that could not be shown changes nothing of the work.
    }
  }
  private get timeText() {
    return `I stopped at the time limit of ${Math.round(this.maxMs / 60_000)} minutes. The task is not finished. Ask again to go on from where it is now.`;
  }
  /** Hands one entry to the timing listener. A listener that fails changes nothing. */
  private timed(run: Run, entry: Omit<StepTiming, "recovery" | "waitMs">) {
    if (!this.timing) return;
    const recovery = run.recovery.splice(0);
    const waitMs = Math.round(run.waitMs);
    run.waitMs = 0;
    try {
      this.timing({
        ...entry,
        ...(recovery.length ? { recovery } : {}),
        ...(waitMs > 0 ? { waitMs } : {}),
      });
    } catch {
      // A listener that fails changes nothing in the request.
    }
  }
  /** Keeps what the worker did to get the request moving, for the next timing entry. */
  private mark(run: Run, word: string, ms = 0) {
    if (run.recovery.length < 8) run.recovery.push(word);
    run.waitMs += Math.max(0, ms);
  }

  /** Ends the request. Everything after this sees that it is over. */
  private finish(
    run: Run,
    state: RequestState,
    reason: string,
    message: string,
    tell = true,
  ) {
    if (this.current !== run) return;
    this.current = null;
    this.last = {
      requestId: run.id,
      state,
      message: clip(message),
      goal: run.shown,
      step: run.step,
    };
    try {
      this.journal.set(run.id, state, reason);
    } catch {
      // The journal still says running. The next start reads that as uncertain.
    }
    this.learn(run, state, reason);
    const question = run.question;
    run.question = null;
    question?.settle({ kind: "over" });
    run.plannerAbort?.abort();
    run.halt();
    if (tell) this.say(message);
    run.opening.end(tell ? clip(message) : "");
  }

  /**
   * The check before and after every action: Stop, the switch and the time
   * limit. True when the request is over.
   */
  private halted(run: Run): boolean {
    if (this.current !== run) return true;
    if (!this.ownsScreen())
      this.finish(run, "blocked", "screen_owned_by_call", ownershipText);
    else if (run.authority?.isLive() === false)
      this.finish(run, "canceled", "call_expired", stoppedText, false);
    else if (run.stop)
      this.finish(run, "canceled", "stopped", stoppedText, false);
    else if (!this.enabled())
      this.finish(run, "canceled", "turned_off", offStoppedText);
    else if (this.now() >= run.deadline)
      this.finish(run, "blocked", "time_limit", this.timeText);
    return this.current !== run;
  }
  /** A request that waits for the person ends when the switch goes off or its time runs out. */
  private expire() {
    const run = this.current;
    if (run?.question && !this.halted(run)) this.resumeDue(run);
  }
  /**
   * With the owner's trust, a pause that waited `resumeMs` with no message
   * ends by itself, and the task goes on. True when it ended now. Without
   * trust a pause waits for the person.
   */
  private resumeDue(run: Run): boolean {
    const question = run.question;
    if (
      !this.options.trust ||
      this.current !== run ||
      question?.mode !== "continue" ||
      this.now() - question.since < this.resumeMs
    )
      return false;
    run.question = null;
    run.state = "running";
    this.say(
      `No message came in ${Math.round(this.resumeMs / 1000)} seconds, so I go on with the task.`,
    );
    question.settle({ kind: "yes" });
    return true;
  }

  status(): ComputerStatus {
    this.expire();
    const enabled = this.enabled();
    const run = this.current;
    if (run)
      return {
        version: 1,
        enabled,
        state: run.state,
        message:
          run.question?.text ??
          (run.state === "stopping"
            ? stoppedText
            : `Working on: "${clean(run.shown, 120)}". Step ${run.step} of at most ${this.stepLimit(run)}.`),
        step: run.step,
        goal: clean(run.shown, 200),
        question: run.question?.text ?? null,
        ...(run.guidance.length
          ? { guidance: run.guidance.map((said) => said.shown) }
          : {}),
        ...(run.question ? { waiting: waitingFor[run.question.mode] } : {}),
      };
    const unresolved = this.journal.unresolved();
    if (unresolved)
      return {
        version: 1,
        enabled,
        state: "uncertain",
        message:
          this.last?.state === "uncertain"
            ? this.last.message
            : uncertainText(unresolved),
        step: this.last?.step ?? unresolved.steps.length,
        goal: clean(unresolved.goal, 200),
        question: null,
      };
    // An uncertain request that the person cleared is in the past.
    if (this.last && this.last.state !== "uncertain")
      return {
        version: 1,
        enabled,
        state: this.last.state,
        message: this.last.message,
        step: this.last.step,
        goal: clean(this.last.goal, 200),
        question: null,
      };
    return {
      version: 1,
      enabled,
      state: "idle",
      message: enabled ? idleText : offText,
      step: 0,
      goal: "",
      question: null,
    };
  }
  snapshot(): DesktopExecutionSnapshot {
    const status = this.status();
    const requestId =
      this.current?.id ??
      (status.state === "uncertain"
        ? this.journal.unresolved()?.id
        : this.last?.requestId);
    return {
      ...(requestId ? { requestId } : {}),
      configured: status.enabled,
      // The worker acts on the screen of this Mac, as the native mode of the
      // bundled runtime does. With this the supervisor hands a plain UI
      // sentence to it before its language model reads the sentence, and the
      // panel gives up the keyboard when the person sends a request.
      mode: "native",
      state: status.state,
      canStop:
        status.enabled &&
        (status.state === "running" || status.state === "waiting_for_person"),
      message: status.message,
      // For a chat that is asked what runs: the request, what the person
      // added to it, and why it waits. Only while a request runs.
      ...(this.current ? { goal: status.goal } : {}),
      ...(status.guidance ? { guidance: status.guidance } : {}),
      ...(status.waiting ? { waiting: status.waiting } : {}),
    };
  }
  /** What the panel shows while it serves the hands. */
  run(): HandsNext["run"] {
    const run = this.current;
    return {
      active: run !== null,
      goal: run ? clean(run.shown, 200) : "",
      step: run?.step ?? 0,
      state: run?.state ?? "idle",
    };
  }

  /**
   * Starts one request and answers at once. The work goes on after the
   * answer. The same id never starts a second time, and nothing starts while
   * another request runs or while one has an unknown result. Words that come
   * while a request runs are the person's newest words for that request: see
   * `guide`.
   */
  /**
   * `reading` is what the supervisor's reader made of this same message,
   * when it read it: one move, or "none" for work that the planner does. The
   * worker then does not read the message a second time, which was one more
   * model call at the start of every such request. Without a reading the
   * worker reads the message itself, as before. A question back to the person
   * is no reading that can be handed over.
   */
  submitRead(
    eventId: string,
    text: string,
    reading: NavigationIntent,
    authority?: DesktopExecutionAuthority,
  ): Promise<{ message: string }> {
    return this.begin(eventId, text, reading, authority);
  }
  /** A request with no reading: the worker reads it itself. */
  submit(
    eventId: string,
    text: string,
    authority?: DesktopExecutionAuthority,
  ): Promise<{ message: string }> {
    return this.begin(eventId, text, undefined, authority);
  }
  private async begin(
    eventId: string,
    text: string,
    reading?: NavigationIntent,
    authority?: DesktopExecutionAuthority,
  ): Promise<{ message: string }> {
    if (!this.ownsScreen()) return { message: ownershipText };
    if (authority?.isLive() === false) return { message: stoppedText };
    const id = identity.parse(eventId);
    const goal = z.string().trim().min(1).max(2000).parse(text);
    const read =
      reading === undefined ? undefined : navigationIntentSchema.parse(reading);
    if (read?.kind === "clarify")
      throw new Error("A question to the person is no reading of a request.");
    // An id that is known, as a request or as words for one, starts nothing
    // and adds nothing: it gets the state as it is now.
    if (this.journal.get(id) || this.words.has(id) || this.journal.guided(id))
      return { message: this.snapshot().message };
    if (!this.enabled()) return { message: offText };
    // A request runs: these are words for it.
    if (this.current)
      return {
        message: await this.guide(this.current, id, goal, read, authority),
      };
    const unresolved = this.journal.unresolved();
    if (unresolved) return { message: uncertainText(unresolved) };
    let shown: string;
    try {
      // The record comes first: no work without it.
      shown = this.journal.open(id, goal).goal;
    } catch {
      return { message: unwrittenText };
    }
    let halt = () => {};
    const halted = new Promise<null>((resolve) => (halt = () => resolve(null)));
    const remembered = this.recall(goal);
    const run: Run = {
      authority,
      id,
      goal,
      shown,
      guidance: [],
      ...(remembered.length ? { remembered } : {}),
      taught: [],
      heard: 0,
      deadline: this.now() + this.maxMs,
      step: 0,
      state: "running",
      history: [],
      observation: null,
      page: null,
      fresh: false,
      sentInput: false,
      stepInput: false,
      progress: new ProgressGuard(),
      progressHeard: 0,
      gaveUp: 0,
      recoveries: 0,
      transientWaits: 0,
      recovery: [],
      waitMs: 0,
      firstLookDone: false,
      refusals: 0,
      plannerFailures: 0,
      question: null,
      stop: false,
      takeover: false,
      hold: false,
      inFlight: false,
      personNear: false,
      halt,
      halted,
      ...(read ? { navigation: read } : {}),
      opening: new Opening((line) => this.say(line), this.options.openingMs),
    };
    this.current = run;
    this.last = null;
    this.opened = { id, opening: run.opening };
    this.ended = this.loop(run);
    // No fixed sentence: the request's first words come by `notify`, and
    // `firstWords` gives them to a caller that has one answer only.
    return { message: "" };
  }

  /**
   * The first words of the request with this id to the person: its start
   * line (`opening.ts`), a question or its end, whichever came first. They
   * went to `notify` as well. For a caller that shows or speaks one answer
   * only: a call, a spoken reply, a terminal. "" when none came within
   * `withinMs`, when the request ended with no words for the person, or when
   * the id is not of the newest request.
   */
  firstWords(eventId: string, withinMs: number): Promise<string> {
    const opened = this.opened;
    if (!opened || opened.id !== eventId) return Promise.resolve("");
    return opened.opening.words(withinMs);
  }

  /**
   * The person spoke while a request runs. The task goes on by itself. Words
   * are read by `readMidTask` in `orders.ts`:
   * - "stop" stops the request at once, in every state: during the initial
   *   reading or the first look, at a pause, at a question, at the step limit,
   *   when the words cannot be kept, and when they also look like a secret.
   * - Words that hold a secret are never kept and never go to the planner.
   *   They change nothing else: a running task goes on, a pause stays a pause,
   *   and a question still waits.
   * - "pause" (a plain request to pause) pauses before the next input. Any
   *   next message ends that pause, and goes into the task when it steers.
   * - "status" (a question about how it goes) gets a short answer, and
   *   changes nothing. At a pause it goes on, as every message does.
   * - "go" (continue, ok, thanks) carries nothing to steer with: the task
   *   goes on, and a pause ends.
   * - "steer" (everything else) is kept as the person's newest words, and the
   *   task goes on with them: the planner chooses again. At a pause the task
   *   goes on. At a question it never approves: what waited is set aside.
   */
  private async guide(
    run: Run,
    id: string,
    words: string,
    reading: NavigationIntent | undefined,
    authority?: DesktopExecutionAuthority,
  ): Promise<string> {
    const text = clean(words, 2000);
    if (
      this.current === run &&
      (!text ||
        run.stop ||
        run.state === "stopping" ||
        !sameSpeaker(run.authority, authority))
    )
      return busyText;
    const kind = readMidTask(words);
    // A move that the planner can never make is a request of its own.
    if (
      this.current === run &&
      kind !== "stop" &&
      (reading?.kind === "desktop" || reading?.kind === "previous_app")
    )
      return busyText;
    // From here on these were words for this request. Their id starts none.
    this.remember(id);
    const recordSeen = () => {
      try {
        this.journal.seen(run.id, id);
      } catch {
        // A record that could not be written changes nothing of ending or refusing.
      }
    };
    if (this.current !== run) {
      recordSeen();
      return this.snapshot().message;
    }
    if (kind === "stop") {
      recordSeen();
      this.stop();
      return stoppedText;
    }
    // Check deadline, authority, switch and ownership even when no question
    // waits. If an effect command is in flight, do not finish prematurely (so
    // a lost result can still become uncertain), and take no more words.
    const over =
      !this.ownsScreen() ||
      run.authority?.isLive() === false ||
      !this.enabled() ||
      this.now() >= run.deadline;
    if (over) {
      recordSeen();
      if (!run.inFlight) {
        this.halted(run);
        return this.snapshot().message;
      }
      return atEndText;
    }
    const secret = this.holdsSecret(run, words);
    const tryKeep = (): { kept: true } | { kept: false; why: string } => {
      if (run.step >= this.stepLimit(run)) {
        recordSeen();
        return { kept: false, why: atEndText };
      }
      // A credential goes neither to the planner nor into the record.
      if (secret) {
        recordSeen();
        return { kept: false, why: secretText };
      }
      if (text.length > guidanceLength) {
        recordSeen();
        return { kept: false, why: guidanceLongText };
      }
      if (run.guidance.length >= guidanceLimit) {
        recordSeen();
        return { kept: false, why: guidanceFullText };
      }
      let shown: string;
      try {
        // The record comes first, as for the request itself.
        shown = this.journal.guide(run.id, { id, text });
      } catch {
        return { kept: false, why: guidanceUnwrittenText };
      }
      run.guidance.push({ id, text, shown });
      this.taught(run, text);
      return { kept: true };
    };

    const question = run.question;
    // A one-step navigation command is already dispatched: the task ends once
    // it returns (unless open_app is refused and falls back to planning).
    const navInFlight =
      run.navigation !== undefined &&
      run.navigation.kind !== "none" &&
      (run.step > 0 || run.inFlight);
    if (!question && navInFlight) {
      recordSeen();
      if (kind === "pause") run.hold = true;
      return atEndText;
    }
    // A secret is never kept, and it pauses nothing and ends no pause.
    if (secret) {
      recordSeen();
      if (question?.mode === "continue")
        return `${secretText} ${stillPausedText}`;
      if (question) return `${secretText} ${question.text}`;
      return `${secretText} ${goingOnText}`;
    }

    // Paused (the person took over, or asked to pause): any message goes on.
    if (question?.mode === "continue") {
      const resume = () => {
        run.question = null;
        run.state = "running";
        question.settle({ kind: "yes" });
      };
      if (kind === "pause") {
        recordSeen();
        return stillPausedText;
      }
      if (kind === "status") {
        recordSeen();
        resume();
        return `I go on with "${clean(run.shown, 120)}" now, from step ${run.step}.`;
      }
      if (kind === "go") {
        recordSeen();
        resume();
        return continuingText;
      }
      const kept = tryKeep();
      resume();
      if (kept.kept) return resumedText;
      return kept.why === atEndText ? atEndText : `${kept.why} ${goingOnText}`;
    }

    // Waiting on an approval (yes_no) or a planner question (free). Nothing
    // here is a yes and nothing here is an answer.
    if (question) {
      if (kind === "status") {
        recordSeen();
        return waitsText(question.text);
      }
      if (kind === "go" && question.mode === "yes_no") {
        recordSeen();
        return noYesText(question.text);
      }
      if (kind === "steer") {
        const kept = tryKeep();
        if (!kept.kept) return `${kept.why} ${question.text}`;
        run.question = null;
        question.settle({ kind: "aside" });
        return asideText[question.mode];
      }
      recordSeen();
      run.question = null;
      if (kind === "pause") {
        run.hold = true;
        question.settle({ kind: "aside" });
        return asidePausedText[question.mode];
      }
      question.settle({ kind: "aside" });
      return asideGoText;
    }

    // Running, or about to take the first action. Any message other than a
    // pause ends a pause that was asked for and has not begun yet.
    if (kind === "pause") {
      recordSeen();
      run.hold = true;
      run.wake?.();
      return this.pauseSays(pausedText);
    }
    if (kind === "status") {
      recordSeen();
      return this.statusText(run);
    }
    run.hold = false;
    if (kind === "go") {
      recordSeen();
      return goingOnText;
    }
    const kept = tryKeep();
    if (kept.kept) return guidedText;
    return kept.why === guidanceFullText
      ? `${guidanceFullText} ${goingOnText}`
      : kept.why;
  }
  /** What the person hears about a task that runs, in one short sentence. It never says done. */
  private statusText(run: Run) {
    const goal = clean(run.shown, 120);
    return run.step === 0
      ? `I am starting on "${goal}", and it is not done yet.`
      : `Still working on "${goal}", at step ${run.step}, and it is not done yet.`;
  }
  /** A pause says when it ends by itself: with the owner's trust, after a bounded time. */
  private pauseSays(text: string) {
    return this.options.trust
      ? `${text} With no message, I go on by myself in ${Math.round(this.resumeMs / 1000)} seconds.`
      : text;
  }
  /**
   * True when the person's words for a request hold a secret: a credential
   * in the words themselves (also misspelt, also in their casual reading),
   * or a short value on its own right after words that named a secret or a
   * field for one ("type my pin in the pin field", then "4821"). Remembers
   * whether these words name one.
   */
  private holdsSecret(run: Run, words: string): boolean {
    const text = clean(words, 2000);
    const afterSecret = run.secretNamed ?? namesSecret(run.goal);
    run.secretNamed = namesSecret(text);
    return (
      looksSecretStrict(words) ||
      looksSecretStrict(text) ||
      looksSecretStrict(casualWords(text)) ||
      (afterSecret && looksBareSecret(text))
    );
  }
  /**
   * The notes from memory that fit the goal. None without memory, while it
   * is off, and when it cannot be read: a request never waits on it.
   */
  private recall(goal: string): string[] {
    try {
      return this.options.memory?.recall(goal) ?? [];
    } catch {
      return [];
    }
  }
  /** Keeps the owner's words for the request. The newest 16 at most. */
  private taught(run: Run, words: string) {
    run.taught.push(words);
    if (run.taught.length > 16) run.taught.shift();
  }
  /**
   * At the end of a request: what the owner taught in it goes to memory,
   * while memory is on (`remembered.ts`). A memory that fails changes
   * nothing of the end.
   */
  private learn(run: Run, state: RequestState, reason: string) {
    try {
      this.options.memory?.learn({
        goal: run.goal,
        said: run.taught,
        state,
        reason,
        history: run.history,
      });
    } catch {
      // Memory is a help. The request ended all the same.
    }
  }
  private remember(id: string) {
    this.words.add(id);
    // The oldest goes first. The record on disk still knows the words that were kept.
    if (this.words.size > rememberedWords)
      this.words.delete(this.words.values().next().value!);
  }
  /**
   * The person's words for the checks. Only the request itself can say that a
   * close was asked for, and only until the person says more. Their later
   * words can mean "not that one" in many ways, and no pattern knows them
   * all. So after the first of them a close asks again, whatever they say.
   */
  /**
   * The request as the checks read it, to see what it asked for already. It
   * says no yes ahead of time when the person said more since, or when its
   * own words hold the work back, put it off or make it hang on something
   * ("hang on, reply to Sam", "reply to Sam tomorrow").
   */
  private spoken(run: Run) {
    return run.guidance.length || defersWork(run.goal) ? "" : run.goal;
  }
  /** All that the person said for the request: its goal and their words after it. */
  private saidAll(run: Run) {
    return [run.goal, ...run.guidance.map((said) => said.text)].join("\n");
  }
  /**
   * True when the person said more since the planner chose the action that
   * is on its way. It was chosen without their newest words, so it is not
   * sent: the planner chooses again with them.
   */
  private outdated(run: Run) {
    return run.guidance.length !== run.heard;
  }

  /**
   * Stop. A command that the hands have not fetched is taken back. An action
   * that is already with the hands may finish: the request ends when its
   * result arrives, and nothing follows it.
   */
  stop(): DesktopExecutionSnapshot {
    const run = this.current;
    if (run && !run.stop) {
      run.stop = true;
      // Stop does not wait for the planner, and the planner need not go on.
      run.plannerAbort?.abort();
      if (run.question)
        this.finish(run, "canceled", "stopped", stoppedText, false);
      else {
        run.state = "stopping";
        (this.hands as { withdraw?: () => unknown }).withdraw?.();
        run.halt();
      }
    }
    return this.snapshot();
  }

  /**
   * The person looked at the screen and says so: "clear the computer task".
   * This does what `clawdtime computer clear` does, for a person who has no
   * terminal at hand: on a call, or away from the Mac. The request with the
   * unknown result is marked as seen, so that new work can start. Its record
   * stays. Nothing is started and nothing is sent again. The answer is one
   * line that can be said aloud.
   */
  clear(): { message: string } {
    let done: ReturnType<ComputerJournal["clear"]>;
    try {
      done = this.journal.clear();
    } catch {
      return { message: unclearedText };
    }
    if (done.setAside) {
      const asideMessage = `The record of computer requests could not be read. It was set aside as ${done.setAside} and is not removed. New work can start.`;
      if (!done.cleared.length) return { message: asideMessage };
      const clearedMessage = done.cleared
        .map((request) => `Cleared: "${request.goal}". New work can start.`)
        .join(" ");
      return { message: `${clearedMessage} ${asideMessage}` };
    }
    if (!done.cleared.length) return { message: "Nothing to clear." };
    return {
      message: done.cleared
        .map((request) => `Cleared: "${request.goal}". New work can start.`)
        .join(" "),
    };
  }

  /** The person's reply to what the worker asks. Words that are not clear change nothing. */
  async answer(text: string): Promise<{ message: string }> {
    this.expire();
    const run = this.current;
    const question = run?.question;
    if (!run || !question) return { message: this.snapshot().message };
    const words = clean(text, 600);
    if (question.mode === "free") {
      if (!words) return { message: question.text };
      // The worker asked what to try next: a plain no or a stop word ends it.
      if (question.stopOnNo) {
        const stop = readWords(words) === "stop";
        if (stop || plainNo.test(words)) {
          const message = stop ? stoppedText : question.refusal;
          this.finish(
            run,
            "canceled",
            stop ? "stopped" : "refused_by_person",
            message,
            false,
          );
          return { message };
        }
      }
      // The answer goes to the planner. A credential never does, nor a short
      // value that answers a question about a secret field.
      const asked = namesSecret(question.text);
      // An email address that answers a question for an email is no secret,
      // also when the same question names the password step after it.
      const email =
        /\be-?mail\b|\buser ?name\b/i.test(question.text) &&
        /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(words.trim());
      if (
        looksSecret(text) ||
        this.holdsSecret(run, text) ||
        (asked && !email && looksBareSecret(words))
      )
        return { message: secretText };
      run.question = null;
      question.settle({ kind: "text", text: words });
      return { message: "Thank you. I go on." };
    }
    // A pause takes any message, as words that come while the task runs do:
    // a stop stops, a pause stays, everything else goes on.
    if (question.mode === "continue") {
      if (!words) return { message: question.text };
      const id = `answer_${createHash("sha256")
        .update(`${run.id}\n${++this.answers}\n${words}`)
        .digest("hex")
        .slice(0, 40)}`;
      return {
        message: await this.guide(run, id, words, undefined, run.authority),
      };
    }
    const said = readApproval(words);
    if (said === null) return { message: unclearText(question.text) };
    if (said) {
      run.question = null;
      question.settle({ kind: "yes" });
      return { message: continuingText };
    }
    this.finish(run, "canceled", "refused_by_person", question.refusal, false);
    return { message: question.refusal };
  }

  /** Asks the person and waits. The request ends at Stop, at a no and at the time limit. */
  private ask(
    run: Run,
    mode: Question["mode"],
    text: string,
    refusal: string,
    pause?: "takeover" | "hold",
    stopOnNo = false,
  ): Promise<Reply> {
    if (this.halted(run)) return Promise.resolve({ kind: "over" });
    let timer: NodeJS.Timeout | undefined;
    let resumer: NodeJS.Timeout | undefined;
    return new Promise<Reply>((settle) => {
      const question: Question = {
        text: clip(mode === "continue" ? this.pauseSays(text) : text),
        mode,
        refusal,
        settle,
        since: this.now(),
        ...(pause ? { pause } : {}),
        ...(stopOnNo ? { stopOnNo } : {}),
      };
      run.question = question;
      run.state = "waiting_for_person";
      this.journal.set(run.id, "waiting_for_person", "question");
      timer = setTimeout(
        () => this.expire(),
        Math.max(0, run.deadline - this.now()) + 50,
      );
      timer.unref();
      // With the owner's trust a pause ends by itself. The clock decides,
      // so the timer looks again when it fired before the time was up.
      if (mode === "continue" && this.options.trust) {
        const look = () => {
          if (run.question !== question || this.resumeDue(run)) return;
          resumer = setTimeout(
            look,
            Math.max(
              50,
              Math.min(
                this.resumeMs,
                question.since + this.resumeMs - this.now(),
              ),
            ),
          );
          resumer.unref();
        };
        look();
      }
      this.say(question.text);
      run.opening.spoke(question.text);
    }).then((reply) => {
      clearTimeout(timer);
      clearTimeout(resumer);
      if (this.current === run && reply.kind !== "over") {
        if (reply.kind === "text") this.taught(run, reply.text);
        run.state = "running";
        // The person took time to answer: the last look is old now.
        run.fresh = false;
        // The answer itself changes what is in front: the panel takes the
        // keyboard and gives it back. The action of this step or of the
        // next one can be held back for that alone.
        run.grace = run.step + 1;
        // The person answered a question from the planner after it was told
        // that an action did not work. That answer gives the action a new start.
        if (reply.kind === "text" && run.stuck?.told !== undefined)
          delete run.stuck;
        // The person's words, or their hands at a pause, are new: the steps
        // before them are not held against what comes next.
        if (reply.kind === "text" || mode === "continue") run.progress.heard();
        this.journal.set(
          run.id,
          "running",
          reply.kind === "aside" ? "guided" : "answered",
        );
      }
      return reply;
    });
  }

  /** One finished step: for the planner in words, for the journal as kind, name and one word. */
  private note(
    run: Run,
    action: Action,
    why: string,
    target: string,
    said: string,
    kept: string,
    kind: string = action.kind,
  ) {
    run.history.push({ step: run.step, action, why, outcome: said });
    this.journal.step(run.id, { kind, target, outcome: kept });
  }

  /**
   * One command to the hands, with Stop checked before and after it. A
   * command with an effect whose result never comes back makes the request
   * uncertain: it is not sent again.
   */
  private async hand(
    run: Run,
    command: HandCommand,
    label: string,
    /** A look before a plan, or a wait: the person's input during it is kept for the next input, and pauses nothing now. */
    planning = false,
  ): Promise<Handed> {
    if (this.halted(run)) return { sent: false, over: true, result: null };
    const beforeTransition = run.observation;
    // A closer look (zoom) is a picture too: it sends nothing to an app.
    const effect =
      command.kind !== "observe" &&
      command.kind !== "wait" &&
      command.kind !== "zoom";
    // After anything but a look, the screen and the page may be other ones.
    // That holds for a wait too: it waits for the screen to change.
    if (command.kind !== "observe") {
      run.fresh = false;
      run.page = null;
      if (
        command.kind === "open_app" ||
        command.kind === "switch_desktop" ||
        command.kind === "switch_previous_app"
      )
        run.observation = null;
    }
    let result: HandResult;
    if (effect) run.inFlight = true;
    try {
      result = await this.hands.run(command, label);
    } catch (error) {
      // The hands say whether the command was fetched. With no such word it may have run.
      const delivered = !(error instanceof HandsTimeout) || error.delivered;
      if (effect && delivered) {
        this.finish(run, "uncertain", "lost_result", lostText(label));
        return { sent: true, over: true, result: null };
      }
      this.finish(run, "blocked", "hands_silent", silentText(run.sentInput));
      return { sent: false, over: true, result: null };
    } finally {
      if (effect) run.inFlight = false;
    }
    // Unknown effects survive Stop and takeover. Never let the planner retry
    // activation, or continue using its former observation after a transition.
    if (result.error === "input_unknown") {
      this.finish(run, "uncertain", "input_unknown", inputUnknownText);
    } else if (
      result.error === "transition_unknown" ||
      !verifiedActivation(command, result) ||
      (command.kind === "switch_previous_app" &&
        result.ok &&
        (!beforeTransition ||
          !result.observation ||
          result.observation.app.bundleId === beforeTransition.app.bundleId ||
          result.observation.surfaceEpoch === undefined ||
          beforeTransition.surfaceEpoch === undefined ||
          result.observation.surfaceEpoch <= beforeTransition.surfaceEpoch)) ||
      (command.kind === "switch_desktop" &&
        result.ok &&
        (!beforeTransition || !verifiedDesktopSwitch(beforeTransition, result)))
    ) {
      result = { ...result, ok: false, error: "transition_unknown" };
      this.finish(
        run,
        "uncertain",
        "transition_unknown",
        transitionUnknownText,
      );
    } else if (activationRefusal(command, result)) {
      // Nothing was sent, so the request goes on: the caller hands the
      // reason to the planner, as it does for an action that a check refused.
    } else if (coversThePlace(command, result)) {
      // A list or a card of the app lies over the place of a click. Nothing
      // was sent, and the keys still reach that window: the caller tells the
      // planner, and the refusal counts in the row of held steps. It is no
      // refusal of a desktop switch, so it does not end the request here.
    } else if (
      !result.ok &&
      command.kind === "switch_previous_app" &&
      result.error === "not_found"
    ) {
      // The hands sent no key: there was no other app. That is known.
      this.finish(run, "blocked", "no_other_app", noOtherAppText);
    } else if (
      !result.ok &&
      result.error &&
      result.error in desktopBlockedText
    ) {
      // A desktop switch is the person's own one-step request. The planner
      // cannot send it, so a refusal ends the request with its reason.
      this.finish(
        run,
        "blocked",
        result.error,
        desktopBlockedText[result.error as keyof typeof desktopBlockedText],
      );
    } else if (
      !result.ok &&
      (result.error === "no_accessibility" ||
        result.error === "no_screen_recording")
    ) {
      const initialDesktopRead =
        command.kind === "observe" &&
        run.navigation?.kind !== undefined &&
        run.navigation.kind !== "none";
      this.finish(
        run,
        "blocked",
        result.error,
        initialDesktopRead
          ? `The initial desktop observation failed (${result.error}). No switch was attempted. ${grantText[result.error]}`
          : grantText[result.error],
      );
    } else if (!result.ok && result.error === "stopped_by_person")
      // The person stopped it at the hands. After Stop here, they know already.
      this.finish(run, "canceled", "stopped", stoppedText, !run.stop);
    if (this.halted(run)) return { sent: true, over: true, result };
    if (result.interrupted) {
      if (planning) run.personNear = true;
      else run.takeover = true;
    }
    return { sent: true, over: false, result };
  }
  /** A look with no image, just before an input. Null when the screen could not be read. */
  private async look(run: Run): Promise<Observation | null | "over"> {
    const handed = await this.hand(
      run,
      { kind: "observe", image: false, elements: true },
      "Check the screen",
    );
    if (handed.over) return "over";
    return handed.result?.ok ? (handed.result.observation ?? null) : null;
  }

  private async loop(run: Run) {
    try {
      // A reading that came with the request stands. Else the worker reads
      // the request itself, when its planner can.
      if (run.navigation === undefined && this.planner.navigation) {
        const controller = new AbortController();
        run.plannerAbort = controller;
        try {
          const intent = await Promise.race([
            within(
              this.reading(run.goal, controller.signal),
              Math.max(1, run.deadline - this.now()),
            ),
            run.halted,
          ]);
          if (this.halted(run) || !intent) return;
          run.navigation = navigationIntentSchema.parse(intent);
        } catch {
          if (this.halted(run)) return;
          return this.finish(
            run,
            "blocked",
            "navigation_unavailable",
            "I could not interpret the navigation request reliably. Nothing was sent; please ask again.",
          );
        } finally {
          // The worker waits no more for this reading, whatever came of it.
          controller.abort();
          if (run.plannerAbort === controller) delete run.plannerAbort;
        }
        if (run.navigation.kind === "clarify")
          return this.finish(
            run,
            "blocked",
            "navigation_ambiguous",
            run.navigation.question,
          );
      }
      // Only an app that the hands refused to open comes back from here to
      // the planner. Every other end of a navigation request is final.
      if (
        run.navigation &&
        run.navigation.kind !== "none" &&
        run.navigation.kind !== "clarify"
      ) {
        if (run.hold) {
          run.hold = false;
          delete run.approval;
          const reply = await this.ask(
            run,
            "continue",
            pausedText,
            stoppedText,
            "hold",
          );
          if (reply.kind !== "yes") return;
        }
        // The person's newest words win over the reading of the first ones:
        // with words added before the move went out, the planner plans.
        if (run.guidance.length > 0) run.navigation = { kind: "none" };
        if (
          run.navigation.kind !== "none" &&
          (await this.navigate(run, run.navigation)) !== "plan"
        )
          return;
      }
      for (;;) {
        if (this.halted(run)) return;
        // The pause comes at once, before the next look, plan, or step-limit end.
        // When an action was held back, it says what that action was.
        if (run.takeover || run.pauseText !== undefined || run.hold) {
          const reason =
            run.takeover || run.pauseText !== undefined ? "takeover" : "hold";
          const text =
            reason === "takeover"
              ? (run.pauseText ?? takeoverText)
              : pausedText;
          run.takeover = false;
          run.hold = false;
          run.personNear = false;
          delete run.pauseText;
          delete run.heldRow;
          delete run.settle;
          delete run.approval;
          const reply = await this.ask(
            run,
            "continue",
            text,
            stoppedText,
            reason,
          );
          if (reply.kind !== "yes") return;
          continue;
        }
        if (run.step >= this.stepLimit(run))
          return this.finish(
            run,
            "blocked",
            "step_limit",
            `I stopped at the limit of ${this.stepLimit(run)} steps. The task is not finished. Ask again to go on from where it is now.`,
          );
        // A held row ended in a wait for the screen to settle, in place of
        // the end of the request. Only looks and pauses repeat here.
        if (run.settle) {
          if ((await this.settle(run)) === "over") return;
          continue;
        }
        const lookFrom = this.now();
        if (!run.fresh || !run.observation) {
          const look = () =>
            this.hand(
              run,
              { kind: "observe", image: true, elements: true },
              "Look at the screen",
              true,
            );
          let handed = await look();
          if (handed.over) return;
          if (run.takeover || run.hold) continue;
          // A look can fail for a moment: the app in front is busy, or a
          // window is on its way. One more look after a short wait costs less
          // than a plan with no screen, which ended in a question to the
          // person about what the screen shows.
          if (!handed.result?.ok) {
            const waited = await this.hand(
              run,
              { kind: "wait", ms: lookAgainMs },
              "Wait for the screen",
              true,
            );
            if (waited.over) return;
            if (run.takeover || run.hold) continue;
            handed = await look();
            if (handed.over) return;
            if (run.takeover || run.hold) continue;
          }
          run.observation = handed.result?.ok
            ? (handed.result.observation ?? null)
            : null;
          run.fresh = run.observation !== null;
          run.firstLookDone = true;
          if (run.heldRow?.sentBefore !== undefined) {
            if (
              !sameScreen(
                run.heldRow.sentBefore,
                screenPrint(run.observation, null, true),
              )
            )
              delete run.heldRow;
            else delete run.heldRow.sentBefore;
          }
        }
        if (run.hold) continue;
        // Plan: one outline, asked for after the first look. It runs beside
        // the first turn, so it adds no wait: the plan comes with a later turn.
        if (!run.outlined) this.outline(run);
        if (run.focusClicks) {
          if (focusMovedToField(run.observation, run.focusClicks)) {
            if (run.stuck && run.stuck.clicked > 0) delete run.stuck;
          } else if (run.focusClicks.count >= repeatLimit) {
            return this.finish(
              run,
              "blocked",
              "no_progress",
              focusStuckText(run.focusClicks, run.observation),
            );
          }
        }
        // What came of the last step, now that this look shows it: steps
        // that go in circles get a note, then a question to the person.
        const judged = await this.judge(run);
        if (judged === "over") return;
        if (judged === "again") continue;
        this.notLoaded(run);
        this.remind(run);
        const planFrom = this.now();
        // How many times the person had added words when the planner began.
        // A yes that was kept for an action that was not sent does not
        // outlive words that came after it: the same action asks again.
        const heard = run.guidance.length;
        if (heard !== run.heard) delete run.approval;
        run.heard = heard;
        let planned: Awaited<ReturnType<Planner["next"]>> | "held" | null;
        let late: NodeJS.Timeout | undefined;
        let failure: { error: unknown } | undefined;
        // The planner hears through this signal when the worker waits no
        // more for its answer: Stop, a hold, the time limit, the end.
        const controller = new AbortController();
        run.plannerAbort = controller;
        let wake = () => {};
        const woken = new Promise<"held">((resolve) => {
          wake = () => {
            controller.abort();
            resolve("held");
          };
        });
        run.wake = wake;
        try {
          const input: Parameters<Planner["next"]>[0] & {
            signal: AbortSignal;
          } = {
            goal: run.goal,
            ...(run.guidance.length
              ? { guidance: run.guidance.map((said) => said.text) }
              : {}),
            ...(run.remembered ? { remembered: run.remembered } : {}),
            history: run.history.slice(-shownSteps),
            observation: run.observation,
            page: run.page,
            ...(run.browserClosed ? { browser: false } : {}),
            signal: controller.signal,
            ...(run.plan ? { plan: run.plan.view() } : {}),
            ...this.closerFor(run),
          };
          const plan = this.planner.next(input);
          plan.catch(() => {});
          // Neither Stop, hold nor the time limit waits for the planner.
          planned = await Promise.race([
            plan,
            run.halted,
            woken,
            new Promise<null>((resolve) => {
              late = setTimeout(
                () => resolve(null),
                Math.max(0, run.deadline - this.now()) + 10,
              );
              late.unref();
            }),
          ]);
        } catch (error) {
          failure = { error };
          planned = null;
        } finally {
          clearTimeout(late);
          delete run.wake;
          controller.abort();
          if (run.plannerAbort === controller) delete run.plannerAbort;
        }
        if (failure) {
          // What the planner threw can hold what was sent to it: it is not
          // passed on. Only its kind of trouble is read.
          if (this.halted(run)) return;
          if (run.hold) continue;
          const trouble = troubleOf(failure.error);
          // Waiting does not help here: the person must act first.
          if (trouble === "quota")
            return this.finish(run, "blocked", "planner_quota", quotaText);
          if (trouble === "auth")
            return this.finish(run, "blocked", "planner_auth", authText);
          // The planner already tried again inside its call. A pause, with
          // no input, and the planner chooses again from a new look.
          if (trouble === "transient" && run.transientWaits < transientLimit) {
            run.transientWaits++;
            const from = this.now();
            const rested = await this.rest(
              run,
              Math.min(
                Math.max(this.transientMs, retryAfterOf(failure.error)),
                Math.max(this.transientMs, transientMostMs),
              ),
            );
            this.mark(run, "transient", this.now() - from);
            if (rested === "over") return;
            run.fresh = false;
            continue;
          }
          if (++run.plannerFailures >= 2)
            return this.finish(
              run,
              "blocked",
              "planner_failed",
              plannerText(trouble),
            );
          continue;
        }
        if (this.halted(run)) return;
        if (planned === "held" || run.hold) continue;
        // No answer and no Stop: the time ran out while the planner chose.
        if (!planned)
          return this.finish(run, "blocked", "time_limit", this.timeText);
        // The person said more while the planner chose, so that choice did
        // not have their newest words. It is dropped, nothing is sent for it,
        // and the planner chooses again with them. A request takes a small
        // number of additions, so this ends.
        if (run.guidance.length !== heard) continue;
        // Plan: a change of the plan is no action. Nothing goes to the Mac,
        // and it takes no step. Its own bound ends a planner that loops on it.
        if ("update" in planned && !planned.action) {
          if (this.replan(run, planned.update)) continue;
          if (++run.plannerFailures >= 2)
            return this.finish(run, "blocked", "plan_loop", planLoopText);
          continue;
        }
        // Plan: a plan_update that came with the action is marked first.
        if ("update" in planned && planned.update !== undefined)
          this.replan(run, planned.update);
        run.plannerFailures = 0;
        run.step++;
        const actFrom = this.now();
        delete run.held;
        const chosen = (planned as { action?: unknown }).action;
        const kind = (chosen as { kind?: unknown } | null)?.kind;
        const before = progressPrint(run.observation);
        run.stepInput = false;
        delete run.signed;
        const why = clean(
          String((planned as { why?: unknown }).why ?? ""),
          200,
        );
        // The first line, when the outline gave none: the planner's own reason.
        // Done, give_up and ask say their own words.
        if (kind !== "done" && kind !== "give_up" && kind !== "ask")
          run.opening.acting(why);
        await this.act(run, chosen, why);
        // Plan: an action came, so the plan updates in a row start again.
        run.plan?.acted();
        // The next look says what came of this step.
        if (this.current === run)
          run.pending = {
            signature: run.signed ?? JSON.stringify(["none"]),
            kind: typeof kind === "string" ? clean(kind, 40) : "none",
            before,
            input: run.stepInput,
          };
        this.timed(run, {
          step: run.step,
          kind: typeof kind === "string" ? clean(kind, 40) : "none",
          lookMs: planFrom - lookFrom,
          planMs: actFrom - planFrom,
          actMs: this.now() - actFrom,
          ...(run.held ? { held: run.held } : {}),
        });
      }
    } catch {
      // A fault here is not proof that nothing was sent.
      this.finish(run, "uncertain", "fault", faultText);
    } finally {
      // What the worker did to get moving, when no step after it said so.
      if (run.recovery.length)
        this.timed(run, {
          step: run.step,
          kind: "end",
          lookMs: 0,
          planMs: 0,
          actMs: 0,
        });
    }
  }

  /** A user-authored direction is a one-shot operation outside the planner loop.
   * Neither a model, a continuation, nor a failed verification can repeat it.
   * "plan": the hands refused to open the named app before anything was
   * sent, and the planner goes on with that reason. */
  private async navigate(
    run: Run,
    intent: Exclude<NavigationIntent, { kind: "none" | "clarify" }>,
  ): Promise<"plan" | void> {
    // The person's words only open a web address: that is no move to an app,
    // whatever the reading says. The first planned step opens the address.
    if (directAddress(run.goal)) return "plan";
    const looked = await this.hand(
      run,
      { kind: "observe", image: true, elements: true },
      "Check desktop before switching",
    );
    if (looked.over) return;
    if (run.hold) {
      run.hold = false;
      delete run.approval;
      const reply = await this.ask(
        run,
        "continue",
        pausedText,
        stoppedText,
        "hold",
      );
      if (reply.kind !== "yes") return;
      if (run.guidance.length > 0) {
        run.navigation = { kind: "none" };
        return "plan";
      }
      return this.navigate(run, intent);
    }
    // Words that came during that look steer: the planner plans with them.
    if (run.guidance.length > 0) {
      run.navigation = { kind: "none" };
      return "plan";
    }
    const before = looked.result?.observation;
    if (run.takeover)
      return this.finish(
        run,
        "blocked",
        "desktop_not_ready",
        "You moved the mouse or pressed a key during the initial desktop observation. No switch was attempted. Ask again when ready.",
      );
    if (!looked.result?.ok) {
      // Only the bounded wire error vocabulary may enter this diagnostic. Do
      // not reflect a panel payload, screenshot, title, or field content.
      const error = handErrors.find((known) => known === looked.result?.error);
      return this.finish(
        run,
        "blocked",
        "desktop_not_ready",
        error
          ? `The initial desktop observation failed (${error}). No switch was attempted. Check the panel and ask again when ready.`
          : "The initial desktop observation failed without a recognized error code. No switch was attempted. Check the panel and ask again when ready.",
      );
    }
    if (before?.surfaceEpoch === undefined)
      return this.finish(
        run,
        "blocked",
        "desktop_not_ready",
        "The initial observation did not include a verified desktop surface epoch. No switch was attempted. Check that the panel supports desktop verification, then ask again.",
      );
    run.observation = before;
    run.step++;
    const command: HandCommand =
      intent.kind === "desktop"
        ? { kind: "switch_desktop", direction: intent.direction }
        : intent.kind === "previous_app"
          ? { kind: "switch_previous_app" }
          : {
              kind: "open_app",
              name: intent.name,
              ...(intent.window ? { window: intent.window } : {}),
            };
    const handed = await this.hand(
      run,
      command,
      intent.kind === "desktop"
        ? `Switch one desktop ${intent.direction}`
        : intent.kind === "previous_app"
          ? "Switch to the previous app"
          : `Bring ${intent.name} forward`,
    );
    if (handed.over) return;
    const refusal = activationRefusal(command, handed.result);
    if (refusal && command.kind === "open_app") {
      // "Open Chrome" names an app as people do, and the hands know it by
      // another name. The planner sees the reason and the screen: it can use
      // the name that this Mac knows, or tell the person why it cannot.
      this.note(
        run,
        command,
        "The person asked for this app.",
        clean(command.name, 80),
        `refused: ${refusal}`,
        handed.result?.error ?? "failed",
      );
      run.refusals = 1;
      run.navigation = { kind: "none" };
      return "plan";
    }
    if (!handed.result?.ok) {
      // Keep only the fixed wire vocabulary. Raw panel errors or screen fields
      // must never become user-facing diagnostics or journal reason codes.
      const error = handErrors.find((known) => known === handed.result?.error);
      return this.finish(
        run,
        "blocked",
        error ?? "desktop_not_sent",
        `The panel refused the desktop switch before dispatch${error ? ` (${error})` : ""}. No retry was attempted; check permissions and shortcut setup, then ask again.`,
      );
    }
    if (
      run.takeover ||
      (intent.kind === "desktop"
        ? !verifiedDesktopSwitch(before, handed.result)
        : !verifiedActivation(command, handed.result))
    )
      return this.finish(
        run,
        "uncertain",
        "transition_unknown",
        transitionUnknownText,
      );
    // Do not carry the old action target or start another planned action. A later
    // user request always obtains its own full observation and native input lease.
    run.observation = null;
    run.page = null;
    run.fresh = false;
    return this.finish(
      run,
      "completed",
      "desktop_switched",
      intent.kind === "desktop"
        ? `Verified one desktop transition ${intent.direction}.`
        : intent.kind === "previous_app"
          ? "Verified the switch to the previous app."
          : `Verified ${intent.name} is in front.`,
    );
  }

  /** Checks one planned action and, when it may run, sends it. */
  private async act(run: Run, raw: unknown, why: string) {
    const before = run.observation;
    const view: View = {
      observation: before,
      page: run.page,
      fresh: run.fresh,
      browser: this.drives(run),
      browserMethods: this.browserMethods,
      goal: this.spoken(run),
    };
    const parsed = actionSchema.safeParse(raw);
    // The history needs an action even for output that was none.
    const action: Action = parsed.success
      ? parsed.data
      : { kind: "wait", ms: 0 };
    const checked = check(raw, view, why);
    run.signed = progressSignature(action, checked);
    if (checked.verdict === "refuse") {
      this.note(
        run,
        action,
        why,
        "",
        `refused: ${checked.reason}`,
        "refused",
        parsed.success ? parsed.data.kind : "invalid",
      );
      if (++run.refusals >= 3)
        this.finish(run, "blocked", "too_many_refusals", refusalsText());
      return;
    }
    // The hands can still refuse to open an app. That refusal joins the row.
    const refused = run.refusals;
    run.refusals = 0;
    switch (checked.verdict) {
      case "done": {
        // A done right after an input that changed nothing on the screen goes
        // back once: a click that an app did not take looks like a click that
        // worked. It costs no turn in a request whose last input moved the screen.
        if (this.options.unchangedDone && run.stillAfter && !run.stillNoted) {
          run.stillNoted = true;
          return this.note(
            run,
            action,
            why,
            "",
            `not taken yet: the screen looks the same as before your last action (${run.stillAfter}), so it may not have worked. Look again: if the goal is met, call done again.`,
            "done_unchanged",
          );
        }
        // A done while the browser shows its own error page goes back once:
        // the page did not load, and spoken words are often misheard, so the
        // address may be wrong. A second done is taken.
        const shows = run.errorPageNoted
          ? null
          : errorPage(run.observation, run.page, this.saidAll(run));
        if (shows) {
          run.errorPageNoted = true;
          return this.note(
            run,
            action,
            why,
            "",
            `not taken yet: ${notLoadedNote(shows)} Only when the goal is to see this page, call done again.`,
            "done_error_page",
          );
        }
        this.note(run, action, why, "", "ok", "ok");
        return this.finish(
          run,
          "completed",
          "done",
          this.withFacts(run, `Done. ${clean(checked.summary, 900)}`.trim()),
        );
      }
      case "give_up": {
        const reason = clean(checked.reason, 900);
        // The first give_up goes back to the planner with the ways that it
        // did not try, unless only the person can change what stands in
        // the way. Nothing is sent for it.
        if (run.gaveUp === 0 && !forThePerson.test(reason)) {
          run.gaveUp++;
          const tried = new Set(
            run.history.map((record) => record.action.kind),
          );
          this.note(
            run,
            action,
            why,
            "",
            `not ended: ${giveUpNote(otherWays(this.context(run), tried))}`,
            "nudged",
          );
          this.mark(run, "give_up_nudge");
          return;
        }
        this.note(run, action, why, "", "gave up", "gave_up");
        return this.finish(
          run,
          "blocked",
          "gave_up",
          this.withFacts(run, giveUpText(reason)),
        );
      }
      case "ask": {
        // These are the planner's words, so they carry a mark. A question that
        // the checks ask before an action has none: the planner cannot pose
        // as them, and its answer allows nothing in code.
        const reply = await this.ask(
          run,
          "free",
          `The task asks: ${clean(checked.question, 900) || "it needs an answer from you to go on."}`,
          "",
        );
        if (reply.kind !== "text") return;
        return this.note(
          run,
          action,
          why,
          "",
          `the person answered: ${reply.text}`,
          "answered",
        );
      }
      case "person_types":
        return this.personTypes(run, action, why, checked);
    }
    // What this action can be compared by. An action on the page drops no
    // reading, so the reading counts for it. Any other action drops it. A
    // scroll, a wait and a reading are in no row, and need none of this.
    const viaPage = checked.send.via === "browser";
    const screen =
      checked.signature === null
        ? null
        : screenPrint(before, viaPage ? run.page : null);
    const row = run.stuck;
    if (row && row.signature === checked.signature) {
      // The last try went out and the screen is another one now: that try
      // moved something. The same action again is then a new row.
      if (row.lastSent && !sameScreen(row.screen, screen)) delete run.stuck;
      else if (row.told !== undefined) {
        // The planner was told that this action did not work, and chose it
        // again. That ends the request only while the planner still reads
        // the line that said so, and while the same app, window and elements
        // are in front. Otherwise the action gets a new row.
        const reads = run.history
          .slice(-shownSteps)
          .some((record) => record.step === row.step);
        if (
          !reads ||
          !sameScreen(
            row.told,
            screenPrint(before, viaPage ? run.page : null, false),
          )
        )
          delete run.stuck;
        else {
          // Nothing is sent, and the request ends with what is true.
          this.note(
            run,
            action,
            why,
            checked.target,
            `not sent: the same action did not work ${row.count} times in a row`,
            "not_sent_repeat",
          );
          return this.finish(
            run,
            "blocked",
            "no_progress",
            stuckText(
              row,
              wordsOf(checked),
              wantedOf(action, checked, before),
              before,
            ),
          );
        }
      }
    }
    // The person used the Mac while the worker looked. An input now could
    // land in their work, so the worker pauses and asks, as for any takeover.
    // What sends no input goes on: a wait, and a reading of the page.
    if (run.personNear && !sendsNoInput(checked.send)) {
      run.personNear = false;
      run.takeover = true;
      delete run.approval;
      return this.heldByHands(
        run,
        action,
        why,
        checked,
        "The person is using the Mac.",
      );
    }
    // A yes that the person gave a moment ago for this same action, which
    // was then not sent. It is used once.
    const held = run.approval;
    delete run.approval;
    // Where the action goes: a button with the same name in another app, in
    // another window or on another page is another action.
    const place =
      checked.send.via === "browser"
        ? `page|${run.page?.url ?? ""}`
        : `${before?.app.bundleId ?? ""}|${before?.app.window ?? ""}`;
    const kept =
      held &&
      checked.signature !== null &&
      held.signature === checked.signature &&
      held.place === place &&
      this.now() - held.at <= approvalHoldsMs
        ? held
        : null;
    const granted = kept?.questions ?? [];
    // A yes is used with no new question two times at most: an action that
    // is held back again and again must come back to the person.
    const tries = kept ? kept.tries + 1 : 0;
    const answered: string[] = [];
    // Only a row of the policy asks (`askPolicy` in guards.ts). The same
    // action again needs no yes of its own: the row of tries that changed
    // nothing, and the progress guard, answer a loop.
    // The owner's trust: the action goes with no question, and the record
    // keeps which row of the policy it passed.
    if (checked.risk && this.options.trust)
      this.mark(run, `trusted_${checked.policy ?? "risk"}`);
    else if (checked.risk) {
      const question = yesQuestion(checked, before, run.page);
      if (!granted.includes(question)) {
        const reply = await this.ask(
          run,
          "yes_no",
          question,
          `Canceled. I did not do it: ${checked.label}.`,
        );
        if (reply.kind !== "yes") return;
      }
      answered.push(question);
    }
    delete run.held;
    if (checked.send.via === "browser")
      await this.viaBrowser(run, action, why, checked);
    else await this.viaHands(run, action, why, checked, before, refused);
    this.tally(run, checked.signature, screen, viaPage);
    // The question itself changes what is in front, so the look just before
    // the action can differ from the planner's look, and the action is then
    // held back. The planner looks again. When it chooses the same action,
    // the person is not asked the same question a second time.
    if (
      answered.length &&
      run.held &&
      !run.takeover &&
      run.pauseText === undefined &&
      !run.hold &&
      !this.outdated(run) &&
      checked.signature !== null &&
      this.current === run &&
      tries < 2
    )
      run.approval = {
        signature: checked.signature,
        place,
        questions: answered,
        at: kept ? kept.at : this.now(),
        tries,
      };
  }

  /** Text for a secure field: the person types it, and the worker goes on after their yes. */
  private async personTypes(
    run: Run,
    action: Action,
    why: string,
    field: { label: string; target: string },
  ) {
    const reply = await this.ask(
      run,
      "yes_no",
      `${field.label}: that is a password field, and I never type there. Type it yourself, then say yes to go on, or no to stop.`,
      "Canceled. Nothing was typed.",
    );
    // The person said something else in place of the yes. A click that gave
    // the field the focus may have gone out before the question, so the
    // step stays in the record.
    if (reply.kind === "aside")
      return this.note(
        run,
        action,
        why,
        field.target,
        "not typed: that is a password field. The person said something else in place of a yes.",
        "set_aside",
      );
    if (reply.kind !== "yes") return;
    this.note(
      run,
      action,
      why,
      field.target,
      "not typed: that is a password field. The person typed it.",
      "person_typed",
    );
  }
  /** Adds the action of this turn to its row, when it went out or was not sent. */
  private tally(
    run: Run,
    signature: string | null,
    screen: string | null,
    page: boolean,
  ) {
    const tried = run.tried;
    const reason = run.why ?? null;
    delete run.tried;
    delete run.why;
    // A scroll, a wait or a reading has no signature: it changes no row.
    if (!tried || signature === null) return;
    const row = run.stuck?.signature === signature ? run.stuck : undefined;
    run.stuck = {
      signature,
      count: (row?.count ?? 0) + 1,
      sent: (row?.sent ?? 0) + (tried === "sent" ? 1 : 0),
      clicked: (row?.clicked ?? 0) + (tried === "clicked" ? 1 : 0),
      free: (row?.free ?? 0) + (tried === "free" ? 1 : 0),
      lastSent: tried === "sent",
      screen,
      page,
      reason: tried === "sent" || tried === "clicked" ? null : reason,
      step: run.step,
    };
  }
  /**
   * Before a plan: when the same action was tried `repeatLimit` times in a
   * row and nothing came of it, the planner reads that in the line of the
   * last try. A try that went out counts only here, with a look that came
   * after it: sent input is no proof, and the same screen is no result.
   */
  private remind(run: Run) {
    const row = run.stuck;
    if (!row || row.told !== undefined || row.count - row.free < repeatLimit)
      return;
    if (
      row.lastSent &&
      !sameScreen(
        row.screen,
        screenPrint(run.observation, row.page ? run.page : null),
      )
    )
      return;
    const index = run.history.findLastIndex(
      (record) => record.step === row.step,
    );
    const record = run.history[index];
    if (!record) return;
    run.history[index] = {
      ...record,
      outcome: `${repeatNote(row.count)} Last outcome: ${record.outcome}`,
    };
    row.told = screenPrint(run.observation, row.page ? run.page : null, false);
  }

  /** An input went out, or may have: for the request, and for the step of this turn. */
  private wentOut(run: Run) {
    run.sentInput = true;
    run.stepInput = true;
  }
  /** What is in front, for the other ways that a note names. */
  private context(run: Run): ProgressContext {
    const seen = run.observation;
    const words = [run.goal, ...run.guidance.map((said) => said.text)];
    return {
      browser: this.drives(run),
      page:
        run.page !== null ||
        (seen !== null && browserApps.has(seen.app.bundleId)),
      usedBrowser: run.history.some((record) =>
        record.action.kind.startsWith("browser_"),
      ),
      address: words.some((said) =>
        said.split(/\s+/).some((word) => {
          const found = webAddress(word);
          return found !== null && !found.fileLike;
        }),
      ),
    };
  }
  /**
   * After open_url or browser_open, when the look or the reading after it
   * shows an error page of the browser: the line of that step says that the
   * page did not load, and that the address may be misheard. Once for a step.
   */
  private notLoaded(run: Run) {
    const index = run.history.length - 1;
    const record = run.history[index];
    if (
      !record ||
      (record.action.kind !== "open_url" &&
        record.action.kind !== "browser_open") ||
      record.outcome !== "ok"
    )
      return;
    const shows = errorPage(run.observation, run.page, this.saidAll(run));
    if (!shows) return;
    run.history[index] = {
      ...record,
      outcome: `ok, the address went to the browser, but ${notLoadedNote(shows)}`,
    };
    // The record says that this site did not load, so that nothing takes
    // its name for a site that the owner uses (the words for speech to text).
    let host = "";
    try {
      host = new URL(record.action.url).hostname;
    } catch {
      host = "";
    }
    if (host)
      this.journal.step(run.id, {
        kind: record.action.kind,
        target: host,
        outcome: "not_loaded",
      });
  }
  /** A note for the planner, at the end of the line of its last step. */
  private tell(run: Run, note: string) {
    const index = run.history.length - 1;
    const record = run.history[index];
    if (!record) return;
    run.history[index] = { ...record, outcome: `${record.outcome} ${note}` };
  }
  /**
   * Gives the progress guard the step of the last turn, now that this look
   * shows what came of it, and carries out its answer. "again": the person
   * answered a question, and the worker looks again before the plan.
   */
  private async judge(run: Run): Promise<"go" | "again" | "over"> {
    // Words that the person added are new: the steps before them start no pattern.
    if (run.guidance.length !== run.progressHeard) {
      run.progressHeard = run.guidance.length;
      run.progress.heard();
    }
    const pending = run.pending;
    delete run.pending;
    if (!pending) return "go";
    const after = progressPrint(run.observation);
    // An input after which the screen is the same: a done now rests on nothing that was seen.
    run.stillAfter =
      pending.input &&
      stillKinds.has(pending.kind) &&
      pending.before !== null &&
      after !== null &&
      pending.before === after
        ? pending.kind
        : undefined;
    // The planner reads it at once: a click or a key that changed nothing is
    // no success, so its next turn can try another way before it types on.
    const last = run.history.at(-1);
    if (
      this.options.unchangedDone &&
      run.stillAfter &&
      last &&
      last.outcome === "ok"
    )
      last.outcome =
        "sent, but the screen looks the same after it, so it may not have worked. Look again; if nothing new shows, try another way (a menu item or a keyboard shortcut).";
    const verdict = run.progress.step({ ...pending, after }, this.context(run));
    if (verdict.kind === "allow") return "go";
    this.mark(run, `${verdict.kind}_${verdict.pattern}`);
    if (verdict.kind === "nudge") {
      this.tell(run, verdict.note);
      return "go";
    }
    if (verdict.kind === "end") {
      this.finish(run, "blocked", "no_progress", verdict.text);
      return "over";
    }
    // The worker's own question, so it has no mark of the planner. Its
    // answer goes to the planner, and allows nothing in code.
    const reply = await this.ask(
      run,
      "free",
      verdict.question,
      progressRefusal,
      undefined,
      true,
    );
    if (reply.kind === "over") return "over";
    if (reply.kind === "text")
      this.note(
        run,
        { kind: "ask", question: verdict.question },
        "The worker asked the person, because the screen did not move on.",
        "",
        `the person answered: ${reply.text}`,
        "answered",
      );
    return "again";
  }
  /**
   * A pause with no command and no input. Stop and the end of the request
   * end it at once, and a hold wakes it.
   */
  private async rest(run: Run, ms: number): Promise<"over" | "held" | "done"> {
    if (this.halted(run)) return "over";
    let timer: NodeJS.Timeout | undefined;
    let wake = () => {};
    const woken = new Promise<"held">((resolve) => {
      wake = () => resolve("held");
    });
    run.wake = wake;
    try {
      const came = await Promise.race([
        run.halted.then(() => "over" as const),
        woken,
        new Promise<"done">((resolve) => {
          timer = setTimeout(
            () => resolve("done"),
            Math.max(0, Math.min(ms, run.deadline - this.now())),
          );
          timer.unref();
        }),
      ]);
      if (this.halted(run)) return "over";
      return came === "done" && !run.hold ? "done" : "held";
    } finally {
      clearTimeout(timer);
      if (run.wake === wake) delete run.wake;
    }
  }
  /**
   * In place of the end of a held row: waits with no input until two looks
   * in a row show the same surface, app, window and elements (and the same
   * page, when a page was held), within a few seconds. Then the planner
   * chooses again from a new look. Only looks, readings of the page and
   * pauses repeat here, never an input. A screen that never settles ends the
   * request, as the row would have.
   */
  private async settle(run: Run): Promise<"over" | "held" | "settled"> {
    const due = run.settle!;
    delete run.settle;
    run.recoveries++;
    const from = this.now();
    const withPage = due.surface !== "window" && this.drives(run);
    let last: string | null = null;
    let settled = false;
    for (let looks = 0; looks < settleLooks; looks++) {
      if (looks > 0) {
        const rested = await this.rest(run, this.settleMs);
        if (rested !== "done") return rested;
      }
      const handed = await this.hand(
        run,
        { kind: "observe", image: false, elements: true },
        "Wait for the screen to settle",
        true,
      );
      if (handed.over) return "over";
      if (run.hold || run.takeover) return "held";
      let print = settlePrint(
        handed.result?.ok ? (handed.result.observation ?? null) : null,
      );
      if (print !== null && withPage) {
        const read = await this.readQuietly(run);
        if (read === "over") return "over";
        if (run.hold) return "held";
        if (read) print = `${print}|${pagePrint(read)}`;
      }
      if (print !== null && print === last) {
        settled = true;
        break;
      }
      last = print;
      if (this.now() - from >= settleBoundMs) break;
    }
    this.mark(run, settled ? "settled" : "unsettled", this.now() - from);
    run.fresh = false;
    run.page = null;
    if (!settled) {
      this.finish(
        run,
        "blocked",
        "repeated_hold",
        due.mixed
          ? mixedHeldEndText(due.surface, due.total, run.sentInput, true)
          : heldEndText(due.reason, run.sentInput, true),
      );
      return "over";
    }
    this.tell(run, settledNote);
    // The tries were held back because the screen moved, and none went out.
    // Now it is still, so the same action gets a new start.
    if (run.stuck && run.stuck.sent === 0 && run.stuck.clicked === 0)
      delete run.stuck;
    return "settled";
  }
  /** A reading of the page that changes nothing, for a wait. Null when it failed. */
  private async readQuietly(run: Run): Promise<BrowserPage | null | "over"> {
    const browser = this.browser;
    if (!browser) return null;
    try {
      const got = await withinOrHalted(
        browser.read(),
        this.browserMs,
        run.halted,
      );
      if (this.halted(run)) return "over";
      return got ? tidy(got) : null;
    } catch {
      return this.halted(run) ? "over" : null;
    }
  }
  /**
   * The planner's reading of the request, with the signal of the worker. It
   * reads as the planner in front does: a request that only opens one web
   * address needs no reading. The planner behind gets the signal.
   */
  private reading(goal: string, signal: AbortSignal) {
    const behind = this.options.planner;
    const read = behind.navigation;
    if (!read || directAddress(goal))
      return Promise.resolve<NavigationIntent>({ kind: "none" });
    return read.call(behind, goal, signal);
  }
  /**
   * The closer picture for this turn, once. It stays back when the look of
   * this turn has a password field in its part, or cannot say, and when that
   * look shows another app, window or display than the one the picture was
   * taken of (closer.ts): the planner then reads why.
   */
  private closerFor(run: Run): { closer?: Closer } {
    const closer = run.closer;
    const scene = run.closerScene;
    delete run.closer;
    delete run.closerScene;
    if (!closer) return {};
    const why = closerShowsSecure(closer, run.observation)
      ? closerSecureText
      : !scene || closerOutOfDate(scene, run.observation)
        ? closerChangedText
        : null;
    if (why === null) return { closer };
    const last = run.history.at(-1);
    if (last?.action.kind === "look_closer") last.outcome = `not shown: ${why}`;
    return {};
  }
  /**
   * A check just before the command held the action back: nothing went out.
   * It counts as a refusal of the checks, in the same row of three.
   */
  private withheld(
    run: Run,
    action: Action,
    why: string,
    ready: Ready,
    reason: string,
    refused: number,
  ) {
    this.note(run, action, why, ready.target, `refused: ${reason}`, "refused");
    if ((run.refusals = refused + 1) >= 3)
      this.finish(
        run,
        "blocked",
        "too_many_refusals",
        `${refusalsText} The last reason: ${reason}`,
      );
  }
  /**
   * The action was not sent: the screen is not what the planner saw, or the
   * person took over. The planner gets a new look. The journal keeps it as
   * not sent. For the person the pause comes at once, and says what was held
   * back. With no word from the hands, `heldLimit` held steps in a row with
   * the same reason end the task.
   */
  private changed(
    run: Run,
    action: Action,
    why: string,
    ready: Ready,
    reason: string,
    person = false,
  ) {
    run.fresh = false;
    run.held = reason;
    this.note(
      run,
      action,
      why,
      ready.target,
      `not sent: ${reason}`,
      person ? "not_sent_person" : "not_sent",
    );
    // For the person it is no try of the action: they decide at the pause.
    if (person) {
      delete run.tried;
      run.pauseText = holdText(wantedOf(action, ready, run.observation));
    } else if (reason === saidMoreText || reason === heldByWordReason) {
      // The person said more or asked to hold before it went out: no fault of the screen or action.
      delete run.tried;
    } else this.missed(run, reason);
  }
  /**
   * One held step with no word of the hands about the person: the screen or
   * the page was another one, or the panel did not run it. It counts in the
   * row of its action and in the row of held steps with the same reason.
   * `heldLimit` in a row with the same reason end the task, whatever the
   * action was. The one just after an answer of the person is free: it counts
   * in the row of its action and is held against nothing.
   */
  private missed(run: Run, reason: string) {
    run.why = reason;
    if (run.grace !== undefined && run.step <= run.grace) {
      delete run.grace;
      run.tried = "free";
      return;
    }
    run.tried = "unsent";
    const key = heldKey(reason);
    const count = run.heldRow?.key === key ? run.heldRow.count + 1 : 1;
    const total = (run.heldRow?.total ?? 0) + 1;
    const stepSurface =
      reason === pageChangedReason || reason === pageUnreadReason
        ? "page"
        : "window";
    const surface =
      !run.heldRow || run.heldRow.surface === stepSurface
        ? stepSurface
        : "mixed";
    run.heldRow = { key, count, total, surface };
    if (count < heldLimit && total < heldTotalLimit) return;
    const mixed = count < heldLimit;
    // The screen or the page did not hold still. In place of the end, the
    // worker waits with no input until it does, and the planner chooses
    // again. A few times in one request, then the next full row ends it.
    if (run.recoveries < this.settleLimit && settles(reason)) {
      run.settle = { reason, surface, mixed, total };
      delete run.heldRow;
      return;
    }
    const waited = run.recoveries > 0;
    this.finish(
      run,
      "blocked",
      "repeated_hold",
      mixed
        ? mixedHeldEndText(surface, total, run.sentInput, waited)
        : heldEndText(reason, run.sentInput, waited),
    );
  }
  /**
   * The hands held an input back because the person acted since the command
   * began. Nothing went out. The pause says what was held back. A yes for
   * the action is not kept for the next try: the person is asked again, as
   * before.
   */
  private heldByHands(
    run: Run,
    action: Action,
    why: string,
    ready: Ready,
    reason = "The person took over.",
  ) {
    this.changed(run, action, why, ready, reason, true);
    delete run.held;
    delete run.approval;
  }

  private async viaHands(
    run: Run,
    action: Action,
    why: string,
    first: Ready,
    before: Observation | null,
    /** The refusals in a row before this action. */
    refused: number,
  ) {
    let ready = first;
    if (first.send.via !== "hands") return;
    /** The look just before the input, when there was one. */
    let lastLook: Observation | null = null;
    let targetField =
      action.kind === "type" && action.element !== undefined
        ? before?.elements.find((item) => item.id === action.element)
        : undefined;
    if (first.send.look) {
      // Just before the input: look again, and check the same action against
      // that look. The planner took seconds to choose, and the person may
      // have taken minutes to say yes. The screen can be another one now.
      const seen = await this.look(run);
      if (seen === "over") return;
      if (run.hold || this.outdated(run))
        return this.changed(
          run,
          action,
          why,
          first,
          run.hold ? heldByWordReason : saidMoreText,
        );
      if (run.takeover) return this.heldByHands(run, action, why, first);
      if (!seen || !before)
        return this.changed(run, action, why, first, screenUnreadReason);
      lastLook = seen;
      const moved = retarget(action, before, seen);
      if (!moved.ok) return this.changed(run, action, why, first, moved.reason);
      if (moved.action.kind === "type" && moved.action.element !== undefined) {
        const targetId = moved.action.element;
        const refound = moved.observation.elements.find(
          (item) => item.id === targetId,
        );
        if (refound) targetField = refound;
      }
      const again = check(
        moved.action,
        {
          observation: moved.observation,
          page: null,
          fresh: true,
          browser: this.drives(run),
          goal: this.spoken(run),
        },
        why,
      );
      // A secure field took the focus since the planner looked.
      if (again.verdict === "person_types")
        return this.personTypes(run, action, why, again);
      // A yes was for what the person was asked. It does not cover another risk.
      if (
        again.verdict !== "run" ||
        again.send.via !== "hands" ||
        again.risk !== first.risk
      )
        return this.changed(run, action, why, first, screenChangedReason);
      ready = again;
    }
    const send = ready.send;
    if (send.via !== "hands") return;
    // Checks that only the worker can make, just before the command: a few
    // closer looks for each request (closer.ts), and a key that edits text
    // only where a text field has the focus (text-keys.ts). Nothing goes out.
    const withheld =
      closerHold(action, run.closerLooks ?? 0) ??
      textKeyHold(action, lastLook ?? before);
    if (withheld)
      return this.withheld(run, action, why, ready, withheld, refused);
    if (action.kind === "look_closer")
      run.closerLooks = (run.closerLooks ?? 0) + 1;
    const focusTarget = (): Omit<FocusClicks, "count"> => {
      const obs = lastLook ?? before;
      const bundleId = obs?.app.bundleId ?? "";
      const window = obs?.app.window ?? "";
      const role = targetField?.role ?? "";
      const title = targetField?.title ?? ready.target;
      const field = ready.label.startsWith("Type in ")
        ? ready.label.slice("Type in ".length)
        : ready.target
          ? `"${ready.target}"`
          : "the field";
      return {
        key: `${bundleId}|${window}|${role}|${title}`,
        field,
        wanted: wantedOf(action, first, before),
        bundleId,
        window,
        role,
        title,
      };
    };
    /**
     * The click on the field went out, and the text did not. The record says
     * that, and never that the text was typed. When the person took over, the
     * pause says what is left to do.
     */
    const clickedOnly = (said: string, countTry = false) => {
      if (run.takeover && this.current === run) {
        delete run.approval;
        run.pauseText = holdText(wantedOf(action, first, before));
      }
      if (countTry) {
        // No complete action went out: only the click on the field.
        run.tried = "clicked";
        const target = focusTarget();
        run.focusClicks =
          run.focusClicks?.key === target.key
            ? { ...target, count: run.focusClicks.count + 1 }
            : { ...target, count: 1 };
      } else {
        delete run.stuck;
      }
      this.note(run, action, why, first.target, said, "clicked");
    };
    if (send.focus) {
      const target = focusTarget();
      if (
        run.focusClicks?.key === target.key &&
        run.focusClicks.count >= repeatLimit
      ) {
        this.note(
          run,
          action,
          why,
          ready.target,
          `not sent: clicked ${target.field} ${run.focusClicks.count} times without typing`,
          "not_sent_repeat",
        );
        return this.finish(
          run,
          "blocked",
          "no_progress",
          focusStuckText(run.focusClicks, lastLook ?? before),
        );
      }
      const focus = await this.hand(run, send.focus, ready.label);
      if (!focus.sent) return;
      if (heldForPerson(focus))
        return this.heldByHands(run, action, why, first);
      // A list or a card of the app lies over the field: nothing went out.
      if (!focus.over && coversThePlace(send.focus, focus.result)) {
        this.note(
          run,
          action,
          why,
          ready.target,
          `not sent: ${coveredText}`,
          "not_sent",
        );
        return this.missed(run, coveredText);
      }
      if (focus.over || !focus.result?.ok) {
        this.note(run, action, why, ready.target, ...outcome(focus));
        // The panel did not run the click: nothing went out.
        if (!focus.over && focus.result)
          this.missed(
            run,
            `The panel did not run it (${focus.result.error ?? "failed"}). Nothing was sent.`,
          );
        return;
      }
      // A focus click went out. Keep heldRow pending until the next look confirms a change.
      this.wentOut(run);
      if (run.heldRow) run.heldRow.sentBefore = screenPrint(before, null, true);
      delete run.grace;
      if (run.takeover)
        return clickedOnly("clicked the field. The text was not typed.");
      // Where did the focus land? Text never goes into a secure field.
      const seen = await this.look(run);
      if (seen === "over" || run.takeover)
        return clickedOnly("clicked the field. The text was not typed.");
      if (!seen || !before || !sameSurface(before, seen))
        return clickedOnly(
          "clicked the field. The text was not typed: the screen changed.",
          true,
        );
      if (focusedSecure(seen)) return this.personTypes(run, action, why, ready);
      if (run.hold || this.outdated(run))
        return clickedOnly(
          run.hold
            ? "clicked the field. The text was not typed: the person asked to hold."
            : "clicked the field. The text was not typed: the person said more.",
        );
    }
    if (run.hold || this.outdated(run))
      return this.changed(
        run,
        action,
        why,
        ready,
        run.hold ? heldByWordReason : saidMoreText,
      );
    // A wait changes nothing on the Mac: the person's input during it is
    // kept for the next input, as for the look before a plan.
    const handed = await this.hand(
      run,
      send.command,
      ready.label,
      sendsNoInput(send),
    );
    if (!handed.sent) return;
    const refusal = handed.over
      ? null
      : activationRefusal(send.command, handed.result);
    if (refusal) {
      // The hands opened nothing. The planner reads why and chooses again,
      // as after a refusal of the checks: it counts in the same row of three.
      this.note(
        run,
        action,
        why,
        ready.target,
        `refused: ${refusal}`,
        handed.result?.error ?? "failed",
      );
      if ((run.refusals = refused + 1) >= 3)
        this.finish(run, "blocked", "too_many_refusals", refusalsText(refusal));
      return;
    }
    if (!sendsNoInput(send) && heldForPerson(handed)) {
      // With a click on the field before the text, that click went out.
      return send.focus
        ? clickedOnly("clicked the field. The text was not typed.")
        : this.heldByHands(run, action, why, first);
    }
    // An input that went out ends the row of held steps only once a real
    // change is seen. For open_app, compare the front without raw picture bytes.
    if (handed.result?.ok && !sendsNoInput(send)) {
      this.wentOut(run);
      delete run.grace;
      if (ready.signature !== null) delete run.focusClicks;
      if (run.heldRow) {
        if (send.command.kind === "open_app") {
          const sameFront = sameScreen(
            screenPrint(before, null, false),
            screenPrint(handed.result.observation ?? null, null, false),
          );
          if (!sameFront) delete run.heldRow;
        } else {
          run.heldRow.sentBefore = screenPrint(before, null, true);
        }
      }
    }
    // A closer look: the picture goes with the next turn of the planner.
    if (send.command.kind === "zoom" && action.kind === "look_closer") {
      const seen = handed.result?.ok ? handed.result.observation : undefined;
      const part = closerPart(action, before);
      if (
        seen?.image &&
        seen.imageWidth &&
        seen.imageHeight &&
        part &&
        before
      ) {
        run.closer = {
          image: seen.image,
          imageWidth: seen.imageWidth,
          imageHeight: seen.imageHeight,
          region: part.region,
        };
        // The part is a part of the look before the zoom: the picture fits
        // only a look of that same scene.
        run.closerScene = closerScene(before);
        return this.note(
          run,
          action,
          why,
          ready.target,
          "ok: the closer picture comes with this turn",
          "ok",
        );
      }
    }
    // Text with no field to take it went nowhere, or into the keys of the
    // app. The planner reads that, and looks for the text before it says done.
    if (
      handed.result?.ok &&
      action.kind === "type" &&
      !send.focus &&
      lastLook &&
      !hasTextFocus(lastLook)
    ) {
      run.tried = "sent";
      return this.note(
        run,
        action,
        why,
        ready.target,
        "sent, but no text field had the focus. Look for the text on the next screen: it may not be there.",
        "ok",
      );
    }
    // A polite quit can be refused by the app itself: it asks about work that
    // is not saved, and stays. The planner reads that, and looks.
    if (
      send.command.kind === "quit_app" &&
      handed.result &&
      !handed.result.ok &&
      handed.result.error === "failed"
    ) {
      this.wentOut(run);
      run.tried = "sent";
      return this.note(
        run,
        action,
        why,
        ready.target,
        "the quit was sent, but the app still runs: it may ask something first. Look at the screen.",
        "failed",
      );
    }
    // The panel did not run it.
    if (
      !handed.over &&
      handed.result &&
      !handed.result.ok &&
      !sendsNoInput(send)
    ) {
      // A list or a card of the app lies over the place: the planner reads
      // that in plain words, and it counts in the row of held steps.
      if (coversThePlace(send.command, handed.result)) {
        this.note(
          run,
          action,
          why,
          ready.target,
          `not sent: ${coveredText}`,
          "not_sent",
        );
        return this.missed(run, coveredText);
      }
      if (send.focus)
        return clickedOnly("clicked the field. The text was not typed.", true);
      this.note(run, action, why, ready.target, ...outcome(handed));
      return this.missed(
        run,
        `The panel did not run it (${handed.result.error ?? "failed"}). Nothing was sent.`,
      );
    }
    if (handed.result?.ok) run.tried = "sent";
    this.note(run, action, why, ready.target, ...outcome(handed));
  }

  /** True while a browser is connected and has not said that it is closed to this program. */
  private drives(run: Run) {
    return this.browser !== undefined && run.browserClosed === undefined;
  }
  /**
   * What the planner reads about a browser step that failed: the reason of
   * the driver, on one line. Its texts are fixed, or name an element of the
   * page that the planner already read. A browser that only the person can
   * open is not offered again in this request.
   */
  private browserFailure(run: Run, error: unknown, lead: string) {
    const reason =
      error instanceof Error && !(error instanceof BrowserSilent)
        ? error.message.replace(/\s+/g, " ").trim().slice(0, 300)
        : "";
    if (!(error instanceof BrowserClosed))
      return reason ? `${lead}: ${reason}` : `${lead}: the browser failed`;
    run.browserClosed = reason;
    run.page = null;
    return `${lead}: ${reason} The browser functions are off for this request. Use the screen.`;
  }
  /** The optional methods of the connected browser. The checks refuse an action that needs another one. */
  private get browserMethods() {
    return browserMethods(this.browser);
  }
  private call(browser: BrowserPort, call: BrowserCall): Promise<BrowserPage> {
    // The checks offer no action whose method the driver lacks. This is the
    // second line: nothing is sent, and the step reads why.
    const lacking = () =>
      Promise.reject(new Error("The browser cannot do that. Use the screen."));
    switch (call.name) {
      case "read":
        return browser.read();
      case "open":
        return browser.open(call.url);
      case "click":
        return browser.click(call.index);
      case "type":
        return browser.type(call.index, call.text, call.submit);
      case "scroll":
        return browser.scroll(call.direction);
      case "back":
        return browser.back();
      case "hover":
        return browser.hover?.(call.index) ?? lacking();
      case "select":
        return browser.select?.(call.index, call.option) ?? lacking();
      case "key":
        return browser.key?.(call.combo) ?? lacking();
      case "wait":
        return browser.waitFor?.(call.text, call.ms) ?? lacking();
      case "tabs":
        return browser.tabs?.() ?? lacking();
      case "switch_tab":
        return browser.switchTab?.(call.tab) ?? lacking();
    }
  }
  private async viaBrowser(
    run: Run,
    action: Action,
    why: string,
    first: Ready,
  ) {
    const browser = this.browser;
    if (!browser || first.send.via !== "browser") return;
    let call = first.send.call;
    if (readsBeforeCall(call)) {
      // Just before the input: read the page again and find the same element.
      // Its number names it inside one reading only. A tab is found again in
      // a new list of the tabs.
      if (this.halted(run)) return;
      let now: BrowserPage;
      try {
        const got = await withinOrHalted(
          call.name === "switch_tab"
            ? this.call(browser, { name: "tabs" })
            : browser.read(),
          this.browserMs,
          run.halted,
        );
        if (this.halted(run) || !got) return;
        now = tidy(got);
      } catch (error) {
        run.page = null;
        run.fresh = false;
        if (this.halted(run)) return;
        if (run.hold || this.outdated(run))
          return this.changed(
            run,
            action,
            why,
            first,
            run.hold ? heldByWordReason : saidMoreText,
          );
        this.note(
          run,
          action,
          why,
          first.target,
          this.browserFailure(
            run,
            error,
            "not sent: the page could not be read just before the action",
          ),
          "not_sent",
        );
        this.missed(run, pageUnreadReason);
        return;
      }
      if (this.halted(run)) return;
      run.page = now;
      if (run.hold || this.outdated(run))
        return this.changed(
          run,
          action,
          why,
          first,
          run.hold ? heldByWordReason : saidMoreText,
        );
      const moved = againstPage(action, call, now);
      const again = moved
        ? check(
            moved,
            {
              observation: run.observation,
              page: now,
              fresh: run.fresh,
              browser: true,
              browserMethods: this.browserMethods,
              goal: this.spoken(run),
            },
            why,
          )
        : null;
      if (
        !again ||
        again.verdict !== "run" ||
        again.send.via !== "browser" ||
        again.risk !== first.risk
      ) {
        run.fresh = false;
        run.held = pageChangedReason;
        this.note(
          run,
          action,
          why,
          first.target,
          "not sent: the page changed since it was read",
          "not_sent",
        );
        return this.missed(run, pageChangedReason);
      }
      call = again.send.call;
    }
    if (this.halted(run)) return;
    if (run.hold || this.outdated(run))
      return this.changed(
        run,
        action,
        why,
        first,
        run.hold ? heldByWordReason : saidMoreText,
      );
    // A scroll changes what the screen shows, but silence after it loses
    // nothing. A reading, a wait and a list of the tabs change nothing.
    const quiet = quietCall(call);
    const effect = !quiet && call.name !== "scroll";
    const pageBefore = call.name === "read" ? null : pagePrint(run.page);
    if (call.name !== "read") run.fresh = false;
    if (effect) run.inFlight = true;
    try {
      if (quiet) {
        const got = await withinOrHalted(
          this.call(browser, call),
          this.browserMs,
          run.halted,
        );
        if (this.halted(run) || !got) return;
        run.page = tidy(got);
      } else {
        run.page = tidy(await within(this.call(browser, call), this.browserMs));
      }
    } catch (error) {
      run.page = null;
      // Silence after an action is not proof that it did not happen. Nor is
      // a driver that lost the answer of an input that went out.
      const unknown =
        error instanceof BrowserSilent || error instanceof BrowserInputUnknown;
      if (unknown && effect) {
        this.note(
          run,
          action,
          why,
          first.target,
          "no result came back",
          "lost",
        );
        return this.finish(
          run,
          "uncertain",
          "lost_result",
          lostText(first.label),
        );
      }
      if (!quiet && !(error instanceof BrowserClosed)) this.wentOut(run);
      this.note(
        run,
        action,
        why,
        first.target,
        this.browserFailure(
          run,
          error,
          error instanceof BrowserInputUnknown
            ? "no result came back"
            : "did not run",
        ),
        "failed",
      );
      // The browser can fail after the click or the link went out. So this
      // is in no row: nothing here says that it was sent, or that it was not.
      this.halted(run);
      return;
    } finally {
      if (effect) run.inFlight = false;
    }
    // An input that went out ends the row of held steps only when the page or
    // screen actually changed.
    if (!quiet) {
      this.wentOut(run);
      delete run.grace;
      if (first.signature !== null) delete run.focusClicks;
      if (run.heldRow) {
        const samePage = sameScreen(pageBefore, pagePrint(run.page));
        if (!samePage) delete run.heldRow;
        else run.heldRow.sentBefore = screenPrint(run.observation, null, true);
      }
    }
    run.tried = "sent";
    this.note(
      run,
      action,
      why,
      first.target,
      // A wait for words that did not come is no failure, but it is not ok either.
      call.name === "wait" && run.page?.found === false
        ? "the words did not show on the page in that time"
        : "ok",
      "ok",
    );
    this.halted(run);
  }

  /*
   * The plan of a request (`plan.ts`). The worker keeps it, gives it to the
   * planner with each turn and takes its changes. Nothing of it goes to the
   * Mac, and nothing of it goes into the journal.
   */

  /** Plan: the most actions for this request. A plan that had 3 subgoals or more allows more. */
  private stepLimit(run: Run) {
    return run.plan?.long
      ? Math.max(this.maxSteps, this.plannedMaxSteps)
      : this.maxSteps;
  }

  /**
   * Plan: the outline, asked for once after the first look. It runs beside
   * the turns of the planner and nothing waits for it: the plan comes with
   * the first turn after it arrived. It never ends the request: a failure,
   * an answer that cannot be used or no time leaves it with no plan, and it
   * is not asked again. Stop, the end of the request and its time limit
   * abort its call. Not for a request that only opens an address.
   */
  private outline(run: Run) {
    run.outlined = true;
    const planner = this.options.planner;
    if (!planner.outline || directAddress(run.goal)) {
      // No outline, so no line from it: the planner's first reason may say what it does.
      run.opening.lapse();
      return;
    }
    const abort = new AbortController();
    const late = setTimeout(
      () => abort.abort(),
      Math.max(0, run.deadline - this.now()),
    );
    late.unref();
    const over = () => {
      clearTimeout(late);
      abort.abort();
    };
    void run.halted.then(over, over);
    void this.ended?.then(over, over);
    let made: ReturnType<NonNullable<Planner["outline"]>>;
    try {
      made = planner.outline({
        goal: run.goal,
        ...(run.guidance.length
          ? { guidance: run.guidance.map((said) => said.text) }
          : {}),
        ...(run.remembered ? { remembered: run.remembered } : {}),
        observation: run.observation,
        page: run.page,
        ...(run.browserClosed ? { browser: false } : {}),
        signal: abort.signal,
      });
    } catch {
      over();
      run.opening.lapse();
      return;
    }
    run.opening.asked();
    made.then(
      (outline) => {
        over();
        // A request that ended or changed takes no plan from an old call.
        if (this.current !== run || run.plan || run.stop) return;
        // A bare list is an outline with no line for the person.
        const plan = outline
          ? TaskPlan.from(Array.isArray(outline) ? outline : outline.subgoals)
          : null;
        if (plan) run.plan = plan;
        run.opening.outlined(Array.isArray(outline) ? undefined : outline?.say);
      },
      // What the planner threw can hold what was sent to it: it is not passed on.
      () => {
        over();
        if (this.current === run) run.opening.lapse();
      },
    );
  }

  /**
   * Plan: one change of the plan, in place of an action. True when the plan
   * took it or refused it: the planner reads which at its next turn. False
   * when the request has no plan or no change may come now. The loop counts
   * that as a failure of the planner.
   */
  private replan(run: Run, update: unknown): boolean {
    if (!run.plan) return false;
    const outcome = run.plan.apply(update);
    if (outcome.kind === "over") return false;
    run.plannerFailures = 0;
    // A revision that the plan took may say one line, once, in the planner's own words.
    const revised = planUpdateSchema.safeParse(update);
    if (
      outcome.kind === "taken" &&
      revised.success &&
      revised.data.op === "revise" &&
      this.current === run
    )
      run.opening.revise(revised.data.reason);
    return true;
  }

  /** Plan: the final message, with the facts that the planner kept and that the message does not hold. */
  private withFacts(run: Run, message: string) {
    const said = message.toLowerCase();
    const facts = (run.plan?.facts ?? [])
      .map((fact) => fact.replace(/[\s.;]+$/, ""))
      .filter((fact) => fact && !said.includes(fact.toLowerCase()));
    return facts.length
      ? `${message} Noted on the way: ${facts.join("; ")}.`
      : message;
  }
}
