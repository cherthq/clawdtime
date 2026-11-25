/**
 * Computer use: the first words of a request, and its rare words on the way.
 *
 * No request opens with a fixed sentence. The outline (`plan.ts`) that the
 * planner writes after the first look also holds one short line for the
 * person, `say`: what it does first, in their language and specific to the
 * request and to the screen ("Opening Notes and searching for the budget
 * note."). The worker says that line once, through its `notify`, as soon as
 * the outline is there.
 *
 * When the outline fails, has no line that can be said, or has none within a
 * few seconds (`openingMs`), the line is made from the planner's own reason
 * for its first action instead ("Open Notes to find the note" becomes
 * "Opening Notes to find the note."). A reason that cannot be read as an act
 * of the worker gives no line. The reasons of the first three actions are
 * tried, in order.
 *
 * A question or the end that comes first is the first message, and no start
 * line follows it. On the way, one revision of the plan in a request may say
 * one line in the planner's own words. Every line is checked here: one line of
 * at most 120 characters, no secret, and no word of how the worker works.
 *
 * Nothing here acts on the Mac. It keeps no text after the request.
 */
import { looksSecretStrict } from "./journal.js";

export const openingLimits = {
  /** Characters of one line for the person. A longer one is cut to its first sentence, or dropped. */
  length: 120,
  /** How long the outline's line may take before a reason of the planner may stand in. */
  waitMs: 4000,
  /** The first actions whose reasons may make the line. */
  reasons: 3,
} as const;

/** Words of the worker's own machinery. A line with one of them is not said. */
const machinery =
  /\b(?:sub-?goals?|plan_update|planner|steps?\s+\d+|checked\s+actions?|one\s+action\s+at\s+a\s+time)\b/i;
/** The engine's end opens with "Done.": a start line never does, nor with the old "Started.". */
const endWords = /^(?:done|started)\b/i;

const oneLine = (value: string) =>
  value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Quotes around the whole line are no part of it.
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();

/**
 * One line for the person, from the planner's own words, or null when it
 * cannot be said: no text, a secret, a word of the machinery, or longer than
 * the limit even as its first sentence.
 */
export function spokenLine(raw: unknown): string | null {
  if (typeof raw !== "string" || looksSecretStrict(raw)) return null;
  let line = oneLine(raw);
  if (!line) return null;
  if (line.length > openingLimits.length) {
    const first = /^.*?[.!?](?=\s|$)/u.exec(line)?.[0];
    if (!first || first.length > openingLimits.length) return null;
    line = first;
  }
  if (machinery.test(line) || endWords.test(line)) return null;
  if (!/[.!?…。।]$/u.test(line)) line = `${line}.`;
  if (line.length > openingLimits.length) return null;
  return `${line[0]!.toUpperCase()}${line.slice(1)}`;
}

/** Verbs of work on a screen, and how a line says that the worker does them now. */
const doing: Record<string, string> = {
  accept: "accepting",
  activate: "activating",
  add: "adding",
  answer: "answering",
  attach: "attaching",
  browse: "browsing",
  bring: "bringing",
  call: "calling",
  cancel: "canceling",
  change: "changing",
  check: "checking",
  choose: "choosing",
  clear: "clearing",
  click: "clicking",
  close: "closing",
  compare: "comparing",
  compose: "composing",
  confirm: "confirming",
  copy: "copying",
  create: "creating",
  delete: "deleting",
  dismiss: "dismissing",
  download: "downloading",
  drag: "dragging",
  edit: "editing",
  enter: "entering",
  expand: "expanding",
  fill: "filling",
  filter: "filtering",
  find: "finding",
  focus: "focusing",
  get: "getting",
  go: "going",
  hover: "hovering",
  inspect: "inspecting",
  launch: "launching",
  load: "loading",
  locate: "locating",
  log: "logging",
  look: "looking",
  make: "making",
  mark: "marking",
  move: "moving",
  navigate: "navigating",
  open: "opening",
  paste: "pasting",
  pick: "picking",
  play: "playing",
  post: "posting",
  press: "pressing",
  put: "putting",
  quit: "quitting",
  read: "reading",
  refresh: "refreshing",
  reject: "rejecting",
  reload: "reloading",
  remove: "removing",
  reply: "replying",
  return: "returning",
  review: "reviewing",
  save: "saving",
  scroll: "scrolling",
  search: "searching",
  select: "selecting",
  send: "sending",
  set: "setting",
  share: "sharing",
  show: "showing",
  sign: "signing",
  sort: "sorting",
  start: "starting",
  submit: "submitting",
  switch: "switching",
  tap: "tapping",
  try: "trying",
  turn: "turning",
  type: "typing",
  update: "updating",
  upload: "uploading",
  use: "using",
  view: "viewing",
  visit: "visiting",
  wait: "waiting",
  write: "writing",
};
const gerunds = new Set(Object.values(doing));
/** Words before the verb that say nothing: "First, open Notes". */
const lead = /^(?:(?:first|now|next|then|so|finally|ok|okay)\b[,:]?\s+)+/i;
/** A reason that already speaks as the worker: "I open Notes", "Let me open Notes". */
const firstPerson =
  /^(?:I|I['’](?:m|ll)|I am|I will|Let me|We|We['’](?:re|ll))\b/;

/** A verb of what is, in the next two words: the first word was the name of a thing. */
const saysWhatIs =
  /^\s+(?:\S+\s+)?(?:is|are|was|were|has|have|had|shows?|appears?|seems?|looks?|lists?|holds?|contains?|opened|loaded)\b/i;

const asDoing = (word: string) => {
  const lower = word.toLowerCase();
  if (gerunds.has(lower)) return lower;
  return doing[lower] ?? null;
};

/**
 * The line made from the planner's reason for an action ("What this action
 * is for, in a few words"): its first sentence, said as what the worker does
 * now. Null when the reason does not start with a verb of work on a screen,
 * or when the line cannot be said (`spokenLine`).
 */
export function lineFromWhy(raw: string): string | null {
  let text = oneLine(raw);
  text = /^.*?[.!?](?=\s|$)/u.exec(text)?.[0] ?? text;
  text = text.replace(lead, "").replace(/^to\s+/i, "");
  if (!text) return null;
  if (firstPerson.test(text)) return spokenLine(text);
  const word = /^[A-Za-z]+/.exec(text)?.[0];
  const verb = word ? asDoing(word) : null;
  if (!word || !verb) return null;
  // "Search field is visible", "Search results show it": the word is a noun there.
  if (saysWhatIs.test(text.slice(word.length))) return null;
  // A verb needs what it acts on, in words: "turn 1" says nothing.
  if (!/\p{L}{2,}/u.test(text.slice(word.length))) return null;
  const rest = text
    .slice(word.length)
    // "Open Notes and search for it": the second verb is said the same way.
    .replace(
      /\b(and|then)\s+([A-Za-z]+)\b/g,
      (all, joint: string, next: string) => {
        const also = asDoing(next);
        return also ? `${joint} ${also}` : all;
      },
    );
  return spokenLine(`${verb[0]!.toUpperCase()}${verb.slice(1)}${rest}`);
}

/**
 * The first words of one request. The worker tells it what happens; it says
 * the start line once, through `send`, and answers who waits for the first
 * words. It has one timer, which never holds the process.
 */
export class Opening {
  /** The first words were said, or the request ended: no start line comes now. */
  private over = false;
  /** The outline gave no line, or its time passed: a reason may make the line. */
  private due = false;
  private reasons = 0;
  /** The line from a reason of the planner, kept until it is due. */
  private fromReason?: string;
  private revised = false;
  private timer?: NodeJS.Timeout;
  /** What was said first: the start line, a question or the end. "" when the request ended with nothing said. */
  private first?: string;
  private readonly waiting = new Set<(words: string) => void>();

  constructor(
    private readonly send: (line: string) => void,
    private readonly waitMs: number = openingLimits.waitMs,
  ) {}

  /** The outline was asked for: its line has `waitMs` to come. */
  asked() {
    if (this.over || this.timer) return;
    this.timer = setTimeout(() => this.lapse(), Math.max(0, this.waitMs));
    this.timer.unref?.();
  }
  /** The outline came. `say` is its line, or nothing. */
  outlined(say: unknown) {
    const line = spokenLine(say);
    if (line) this.tell(line);
    else this.lapse();
  }
  /** No line of the outline comes: it failed, none was asked for, or its time passed. */
  lapse() {
    this.due = true;
    this.clear();
    if (this.fromReason) this.tell(this.fromReason);
  }
  /** The planner chose an action of the screen, for this reason. */
  acting(why: string) {
    if (this.over || this.fromReason) return;
    if (this.reasons >= openingLimits.reasons) return;
    this.reasons++;
    const line = lineFromWhy(why);
    if (!line) return;
    this.fromReason = line;
    if (this.due) this.tell(line);
  }
  /**
   * The plan was revised for this reason. The first revision of a request
   * that can be said is said, once. Before the first words it is the start
   * line.
   */
  revise(reason: unknown) {
    if (this.revised) return;
    const line = spokenLine(reason);
    if (!line) return;
    this.revised = true;
    if (!this.over) this.tell(line);
    else this.send(line);
  }
  /** The worker said something else to the person: a question. No start line follows it. */
  spoke(words: string) {
    if (this.over) return;
    this.over = true;
    this.clear();
    this.settle(words);
  }
  /** The request ended. `words` is what the person was told, or "" when the end was told elsewhere. */
  end(words: string) {
    this.spoke(words);
    this.revised = true;
  }
  /**
   * The first words, for a caller that shows or speaks one answer only. ""
   * when none came within `withinMs`. The words also went to `send` or to
   * the worker's own notice.
   */
  words(withinMs: number): Promise<string> {
    if (this.first !== undefined) return Promise.resolve(this.first);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(""), Math.max(0, withinMs));
      timer.unref?.();
      const done = (words: string) => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve(words);
      };
      this.waiting.add(done);
    });
  }

  private tell(line: string) {
    if (this.over) return;
    this.over = true;
    this.clear();
    try {
      this.send(line);
    } finally {
      this.settle(line);
    }
  }
  private settle(words: string) {
    if (this.first !== undefined) return;
    this.first = words;
    for (const done of [...this.waiting]) done(words);
  }
  private clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
