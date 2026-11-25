/**
 * Computer use: the progress guard.
 *
 * The worker gives it one line for each step: the action as a signature, a
 * digest of the screen before the step and after it, and whether an input
 * went out. Before the next plan it answers what the worker does:
 *
 * - `allow`: go on.
 * - `nudge`: tell the planner, in one note of its history, that it goes in
 *   circles, and which other ways fit what is in front.
 * - `ask`: ask the person one short question, and go on with the answer.
 * - `end`: stop the request with a plain text.
 *
 * It finds two patterns:
 *
 * - A swing: the same two or three actions again (A B A B, or A B C A B C),
 *   and the second round showed no screen that was new in this request.
 * - A still screen: several inputs in a row, after none of which the screen
 *   showed anything that this request had not seen before.
 *
 * A run of one and the same action is the worker's own streak and row. This
 * guard does not judge it, so their questions and texts stay as they are.
 *
 * It keeps digests and signatures only, never a text of the screen. It has
 * no timer and does no input or output, so it is tested alone.
 */

export interface ProgressStep {
  /** The action and its arguments as one string: the same for the same action. */
  signature: string;
  /** The kind of action: click_element, key, scroll. */
  kind: string;
  /** Digest of the screen that the planner saw. Null when it was not read. */
  before: string | null;
  /** Digest of the next look. Null when it was not read. */
  after: string | null;
  /** An input went out in this step: a click, a key, text, a scroll, an open. */
  input: boolean;
}

/** What is in front, to pick the other ways that fit. */
export interface ProgressContext {
  /** A browser driver is connected and on for this request. */
  browser: boolean;
  /** A web page is in front. */
  page: boolean;
  /** The planner used a browser function in this request. */
  usedBrowser: boolean;
  /** The person's words name a web address. */
  address: boolean;
}

/** `swing`: back and forth between the same actions. `still`: inputs and no new screen. */
export type ProgressPattern = "swing" | "still";

export type ProgressVerdict =
  | { kind: "allow" }
  | { kind: "nudge"; pattern: ProgressPattern; note: string }
  | { kind: "ask"; pattern: ProgressPattern; question: string }
  | { kind: "end"; pattern: ProgressPattern; text: string };

export interface ProgressLimits {
  /** Inputs in a row with no new screen that make a still screen. */
  still: number;
  /** Notes to the planner in one request. */
  nudges: number;
  /** Questions to the person in one request, after the notes. */
  asks: number;
}

export const progressLimits: ProgressLimits = { still: 4, nudges: 2, asks: 2 };

/** The other ways that fit, as short phrases for the planner. Never empty. */
export function otherWays(
  context: ProgressContext,
  /** The kinds of action that were tried: their way is not offered again. */
  tried: ReadonlySet<string> = new Set(),
): string[] {
  const has = (kind: string) => tried.has(kind);
  const ways: string[] = [];
  if (
    context.browser &&
    context.page &&
    !context.usedBrowser &&
    ![...tried].some((kind) => kind.startsWith("browser_"))
  )
    ways.push("browser_read and the page elements");
  if (!has("key")) ways.push("keys: Tab, Return, Escape, a menu shortcut");
  if (!has("scroll") && !has("browser_scroll")) ways.push("scroll");
  ways.push("a search field");
  if (context.address && !has("open_url"))
    ways.push("open_url with the address");
  if (!has("open_app")) ways.push("open_app for the right app or window");
  return ways;
}

/** The note for the planner after its first give_up. */
export const giveUpNote = (ways: string[]) =>
  `Do not give up yet. Try another way first: ${ways.join("; ")}. Give up only when none of them can work.`;

const nudgeNote = (pattern: ProgressPattern, count: number, ways: string[]) =>
  `${
    pattern === "swing"
      ? `You went back and forth between the same ${count} actions, and the screen showed nothing new.`
      : `Your last ${count} actions did not change the screen.`
  } Do not repeat them. Try another way: ${ways.join("; ")}.`;

const askText = (pattern: ProgressPattern) =>
  `${
    pattern === "swing"
      ? "I keep going back and forth, and the screen shows nothing new."
      : "My last actions did not change the screen."
  } What should I try next? Say it in a few words, or say no to stop.`;

export const progressEndText =
  "My last actions did not move the task on, also after I tried other ways and asked you, so I stopped. The task is not finished. Ask again in other words, or do the next step yourself.";

const stillRow = () => ({
  count: 0,
  kinds: new Set<string>(),
  signatures: new Set<string>(),
});

interface Input {
  signature: string;
  kind: string;
  /** The look after it showed a screen that was new in this request. */
  fresh: boolean;
}

export class ProgressGuard {
  private readonly limits: ProgressLimits;
  /** Every digest of this request. A screen in it is no new screen. */
  private readonly seen = new Set<string>();
  /** The last inputs that went out, newest last. */
  private inputs: Input[] = [];
  /** Inputs in a row that showed no new screen, their kinds and their actions. */
  private still = stillRow();
  private nudged = 0;
  private asked = 0;

  constructor(limits: Partial<ProgressLimits> = {}) {
    this.limits = { ...progressLimits, ...limits };
  }

  /** How many notes and questions this request had. */
  get counts() {
    return { nudges: this.nudged, asks: this.asked };
  }

  /**
   * The person answered or said more. What came before was without their
   * words, so both patterns start again. The counts stay.
   */
  heard() {
    this.clear();
  }

  /** One finished step, and what the worker does before the next plan. */
  step(step: ProgressStep, context: ProgressContext): ProgressVerdict {
    if (step.before !== null) this.seen.add(step.before);
    const known = step.after !== null;
    const fresh = known && !this.seen.has(step.after!);
    if (known) this.seen.add(step.after!);
    // Anything new on the screen is progress, also after a wait or a reading.
    if (fresh) this.still = stillRow();
    // Something came by itself, a page that loaded: no round runs across it.
    // A new screen after an input is part of its round.
    if (fresh && !step.input) this.inputs = [];
    if (step.input) {
      // A look that was not read says nothing: it can close no round and
      // counts in no still row.
      this.inputs = [
        ...this.inputs,
        { signature: step.signature, kind: step.kind, fresh: fresh || !known },
      ].slice(-6);
      if (known && !fresh) {
        this.still.count++;
        this.still.kinds.add(step.kind);
        this.still.signatures.add(step.signature);
      }
    }
    const swing = this.swing();
    const pattern: ProgressPattern | null = swing
      ? "swing"
      : // One and the same action in a row is the worker's streak, not this.
        this.still.count >= this.limits.still && this.still.signatures.size > 1
        ? "still"
        : null;
    if (!pattern) return { kind: "allow" };
    const count = swing ? swing.period : this.still.count;
    const tried = swing ? swing.kinds : this.still.kinds;
    // The pattern is answered once. The next answer needs a new pattern.
    this.clear();
    if (this.nudged < this.limits.nudges) {
      this.nudged++;
      return {
        kind: "nudge",
        pattern,
        note: nudgeNote(pattern, count, otherWays(context, tried)),
      };
    }
    if (this.asked < this.limits.asks) {
      this.asked++;
      return { kind: "ask", pattern, question: askText(pattern) };
    }
    return { kind: "end", pattern, text: progressEndText };
  }

  private clear() {
    this.inputs = [];
    this.still = stillRow();
  }

  /** Two full rounds of two or three actions, and no new screen in the second one. */
  private swing(): { period: number; kinds: Set<string> } | null {
    for (const period of [2, 3]) {
      const window = this.inputs.slice(-2 * period);
      if (window.length < 2 * period) continue;
      const first = window.slice(0, period);
      const second = window.slice(period);
      if (
        second.every(
          (input, index) => input.signature === first[index]!.signature,
        ) &&
        // A run of one action is the worker's streak, not a swing.
        new Set(first.map((input) => input.signature)).size > 1 &&
        second.every((input) => !input.fresh)
      )
        return { period, kinds: new Set(window.map((input) => input.kind)) };
    }
    return null;
  }
}
