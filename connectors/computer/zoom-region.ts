/**
 * Call video only: where a thing that the caller names is on the main
 * display. "Zoom on the address bar", "the Send button", "the error message",
 * "zoom on Stonepad", "the Riverchat window".
 *
 * Two sources, both read only:
 *  - the hands' last look: the app in front, its window title and the
 *    Accessibility elements of that window (their names, and the words of the
 *    texts on the screen). It is kept in memory when a result of the hands
 *    arrives. This module never asks the hands for a look, never sends input
 *    and never takes a picture.
 *  - the system's list of the windows on the screen, by owner and place. That
 *    list needs no permission and holds no picture.
 *
 * The answer is a rectangle in shares of the main display and the kind of
 * match. No label, title, value or app name leaves this module, and none of
 * it is journaled or logged. The rectangle frames the call video only; it is
 * never an input coordinate.
 */
import { z } from "zod";
import type { Observation, ScreenElement } from "./ports.js";
import type { Runner } from "../agents/focus.js";

/** A look older than this says nothing about the screen any more. */
export const LOOK_FRESH_MS = 60_000;

export const regionRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .refine(
        (text) => text.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(text),
      ),
  })
  .strict();

/** A rectangle in shares of the main display, from 0 to 1. */
export interface Share {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type RegionAnswer =
  | {
      version: 1;
      code: "found";
      match: "element" | "window";
      region: Share;
    }
  | {
      version: 1;
      /** no_look: no fresh look and no window matched; no_match: a fresh look named nothing like it. */
      code: "no_look" | "no_match";
      match: null;
      region: null;
    };

/** One window on the screen, front to back, in shares of the main display. */
export interface ScreenWindow extends Share {
  owner: string;
}
export type WindowList = () => Promise<ScreenWindow[] | null>;

interface Look {
  receivedAt: number;
  epoch: number | undefined;
  screen: { width: number; height: number };
  app: { name: string; bundleId: string; window: string };
  elements: ScreenElement[];
}

/** The hands' last look, in memory only. The picture is never kept. */
export class LastLook {
  private look: Look | null = null;
  constructor(private readonly now: () => number = Date.now) {}

  take(observation: Observation): void {
    const { screen, app, elements } = observation;
    if (!(screen.width > 0 && screen.height > 0)) {
      this.look = null;
      return;
    }
    // A look with a picture only names the app in front and has no elements:
    // they are those of the last look, while the app and surface stay.
    if (elements.length === 0) {
      if (
        this.look &&
        (this.look.app.bundleId !== app.bundleId ||
          this.look.epoch !== observation.surfaceEpoch)
      )
        this.look = null;
      return;
    }
    this.look = {
      receivedAt: this.now(),
      epoch: observation.surfaceEpoch,
      screen: { width: screen.width, height: screen.height },
      app: { name: app.name, bundleId: app.bundleId, window: app.window },
      elements: elements.map((e) => ({ ...e })),
    };
  }

  /** The look while it is fresh, else null. */
  current(): Look | null {
    if (this.look && this.now() - this.look.receivedAt > LOOK_FRESH_MS)
      this.look = null;
    return this.look;
  }
}

/** Plain words: lower case, letters and digits, one space between words. */
export function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Words that carry no name: "the button that says send" names "send". */
const filler = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "our",
  "its",
  "of",
  "on",
  "onto",
  "into",
  "at",
  "to",
  "in",
  "for",
  "with",
  "and",
  "please",
  "zoom",
  "show",
  "me",
  "us",
  "see",
  "look",
  "says",
  "say",
  "saying",
  "called",
  "named",
  "labeled",
  "labelled",
  "reads",
  "part",
  "thing",
  "bar",
  "area",
  "screen",
  "there",
  "here",
]);

const fields = ["AXTextField", "AXTextArea", "AXComboBox"];
const texts = ["AXStaticText", "AXHeading"];
/** A word of the kind of thing, and the Accessibility roles it names. */
const kinds: Record<string, string[]> = {
  button: ["AXButton", "AXMenuButton", "AXPopUpButton"],
  buttons: ["AXButton", "AXMenuButton", "AXPopUpButton"],
  link: ["AXLink"],
  links: ["AXLink"],
  tab: ["AXTab", "AXRadioButton"],
  field: fields,
  box: fields,
  input: fields,
  textbox: fields,
  menu: ["AXMenuButton", "AXMenuBarItem", "AXMenuItem", "AXPopUpButton"],
  checkbox: ["AXCheckBox"],
  toggle: ["AXCheckBox"],
  switch: ["AXCheckBox"],
  dropdown: ["AXPopUpButton", "AXComboBox"],
  popup: ["AXPopUpButton", "AXComboBox"],
  slider: ["AXSlider"],
  image: ["AXImage"],
  picture: ["AXImage"],
  photo: ["AXImage"],
  icon: ["AXImage"],
  logo: ["AXImage"],
  text: texts,
  message: texts,
  label: texts,
  heading: texts,
  title: texts,
  paragraph: texts,
};
/** Things a person names by what they are; the word must also be in their name. */
const things: Record<string, string[]> = {
  chart: ["AXImage", "AXGroup"],
  graph: ["AXImage", "AXGroup"],
  plot: ["AXImage", "AXGroup"],
  diagram: ["AXImage", "AXGroup"],
};
/** Words that a screen uses for the same thing. */
const alike: Record<string, string[]> = {
  address: ["address", "url", "location", "search"],
  url: ["address", "url", "location", "search"],
  location: ["address", "url", "location", "search"],
  search: ["search", "find"],
  error: [
    "error",
    "errors",
    "failed",
    "failure",
    "invalid",
    "warning",
    "exception",
    "denied",
    "unable",
    "cannot",
    "cant",
    "couldnt",
    "problem",
  ],
  warning: ["warning", "caution", "alert"],
};
/** A field that people call a bar: the address bar, the search bar. */
const barFields = new Set(["address", "url", "location", "search"]);
const windowWords = new Set(["window", "windows", "app", "application"]);

/** What the caller's words ask for. */
interface Wanted {
  /** Words of the name, without filler or the kind. */
  name: string[];
  /** The phrase of the name, for an exact title. */
  phrase: string;
  /** Roles that the kind names; empty when the words name no kind. */
  roles: string[];
  /** The words say "window" or "app". */
  window: boolean;
}

function wanted(text: string): Wanted {
  const all = words(text);
  const window = all.some((w) => windowWords.has(w));
  const roles = new Set<string>();
  const name: string[] = [];
  for (const word of all) {
    if (windowWords.has(word)) continue;
    const kind = kinds[word];
    if (kind) {
      kind.forEach((role) => roles.add(role));
      continue;
    }
    const thing = things[word];
    if (thing) thing.forEach((role) => roles.add(role));
    if (!filler.has(word)) name.push(word);
  }
  // "The address bar" is a field.
  if (all.includes("bar") && name.some((w) => barFields.has(w)))
    fields.forEach((role) => roles.add(role));
  return { name, phrase: name.join(" "), roles: [...roles], window };
}

const stem = (word: string) =>
  word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
const seenWord = (seen: Set<string>, choice: string) => {
  if (seen.has(choice) || seen.has(stem(choice))) return true;
  for (const one of seen)
    if (
      choice.length >= 4 &&
      (stem(one) === stem(choice) ||
        (one.startsWith(choice) && one.length <= choice.length + 3))
    )
      return true;
  return false;
};
/** How well one word of the name is in a thing's words: 1 as said, 0.6 as a word for the same thing, else 0. */
function has(seen: Set<string>, word: string): number {
  if (seenWord(seen, word)) return 1;
  return (alike[word] ?? []).some((choice) => seenWord(seen, choice)) ? 0.6 : 0;
}

/**
 * How well a name covers one text: `found` is the share of its words that
 * are there in any form, `weight` the same with a word for the same thing
 * counted lower than the word itself.
 */
function cover(
  want: string[],
  text: string,
): { found: number; weight: number } {
  const none = { found: 0, weight: 0 };
  if (!want.length) return none;
  const seen = new Set(words(text));
  if (!seen.size) return none;
  const each = want.map((word) => has(seen, word));
  return {
    found: each.filter((n) => n > 0).length / want.length,
    weight: each.reduce((sum, n) => sum + n, 0) / want.length,
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** A rectangle inside the display, or null for one that does not show. */
export function cleanShare(r: Share): Share | null {
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) return null;
  const x = clamp01(r.x),
    y = clamp01(r.y);
  const w = Math.min(1 - x, clamp01(r.x + r.w) - x),
    h = Math.min(1 - y, clamp01(r.y + r.h) - y);
  if (w <= 0.002 || h <= 0.002) return null;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** The window list and the look name an app the same way, up to case and marks. */
const sameApp = (a: string, b: string) =>
  words(a).join(" ") === words(b).join(" ") && words(a).length > 0;

interface Candidate {
  score: number;
  match: "element" | "window";
  region: Share;
}

function elementCandidates(want: Wanted, look: Look): Candidate[] {
  const { width, height } = look.screen;
  const share = (e: ScreenElement) =>
    cleanShare({
      x: e.x / width,
      y: e.y / height,
      w: e.w / width,
      h: e.h / height,
    });
  const found: Candidate[] = [];
  if (want.name.length) {
    look.elements.forEach((e, order) => {
      // A secure field is never a target of the call video, by any name.
      if (e.secure) return;
      const region = share(e);
      if (!region) return;
      const title = cover(want.name, e.title);
      const value = cover(want.name, e.value ?? "");
      const best = title.weight >= value.weight ? title : value;
      // A name of one word must be found; a longer one at least half.
      if (best.found < (want.name.length === 1 ? 1 : 0.5)) return;
      const exact = words(e.title).join(" ") === want.phrase;
      const kindFits = !want.roles.length || want.roles.includes(e.role);
      // A thing of another kind counts only with exactly that name: a web
      // page draws some buttons as texts, but "the Upload button" is not a
      // sentence that holds the word.
      if (!kindFits && !exact) return;
      const role = want.roles.length ? (kindFits ? 4 : -4) : 0;
      found.push({
        score:
          best.weight * 10 +
          (exact ? 3 : 0) +
          (title.weight >= value.weight ? 1 : 0) +
          role +
          (e.focused ? 0.5 : 0) -
          order / 10_000,
        match: "element",
        region,
      });
    });
  }
  // "The button" or "the picture": the words name only a kind. Then the
  // largest thing of that kind. A group is too vague to stand for one.
  if (!want.name.length && want.roles.length) {
    let best: Candidate | null = null,
      area = 0;
    for (const e of look.elements) {
      if (e.secure || e.role === "AXGroup" || !want.roles.includes(e.role))
        continue;
      const region = share(e);
      if (!region || region.w * region.h <= area) continue;
      area = region.w * region.h;
      best = { score: 5, match: "element", region };
    }
    if (best) found.push(best);
  }
  return found;
}

function windowCandidates(
  want: Wanted,
  look: Look | null,
  windows: ScreenWindow[],
): Candidate[] {
  if (!want.name.length) {
    // "This window" or "the app": the window in front.
    const region = want.window && windows[0] && cleanShare(windows[0]);
    return region ? [{ score: 10, match: "window", region }] : [];
  }
  const found: Candidate[] = [];
  const seen = new Set<string>();
  windows.forEach((w, order) => {
    // The frontmost window of each owner; the list goes front to back.
    if (seen.has(w.owner)) return;
    seen.add(w.owner);
    const region = cleanShare(w);
    if (!region) return;
    const byOwner = cover(want.name, w.owner).found;
    // The window in front of the last look also answers to its title.
    const byTitle =
      look && sameApp(w.owner, look.app.name)
        ? cover(want.name, look.app.window).found
        : 0;
    const covered = Math.max(byOwner, byTitle);
    if (covered < (want.name.length === 1 ? 1 : 0.5)) return;
    found.push({
      // An app that the caller names wins over a thing in a window that
      // carries the same word, unless the words name a kind of thing.
      score:
        covered * 10 +
        (covered === 1 ? 5 : 0) +
        (want.window ? 4 : 0) -
        order / 10_000,
      match: "window",
      region,
    });
  });
  return found;
}

/**
 * The region of the named thing. Area words ("top right") are the line's
 * own; this answers for the things that only the Mac knows.
 */
export async function resolveRegion(
  name: string,
  deps: { look: LastLook; windows?: WindowList },
): Promise<RegionAnswer> {
  let want = wanted(name);
  let look = deps.look.current();
  const windows = (await deps.windows?.().catch(() => null)) ?? null;
  // The look stands for the screen only while its app has the front window.
  // ClawdTime's own windows float above and are not in this list. Without the
  // list nothing tells that the look is still the screen, so it is not used.
  if (look && !(windows?.[0] && sameApp(windows[0].owner, look.app.name)))
    look = null;
  // "The Send button in Riverchat": a thing in a named app. Only a look of
  // that app can find it; a window of that app is not the thing. Many apps
  // have everyday names, so the app counts only when the look is of it or
  // the caller says "in" (or "inside", "from", "on", "of") before it.
  const said = words(name);
  const app = windows?.find((w) => {
    const owner = words(w.owner);
    return owner.length > 0 && owner.every((word) => want.name.includes(word));
  });
  let scoped = false;
  if (app) {
    const owner = words(app.owner);
    const rest = want.name.filter((word) => !owner.includes(word));
    const ofLook = look !== null && sameApp(app.owner, look.app.name);
    const named = said.some(
      (word, i) =>
        ["in", "inside", "from", "on", "of"].includes(word) &&
        owner.every((part, j) => said[i + 1 + j] === part),
    );
    if (
      (rest.length || (want.roles.length && !want.window)) &&
      (ofLook || named)
    ) {
      scoped = true;
      want = { ...want, name: rest, phrase: rest.join(" "), window: false };
      if (!ofLook) look = null;
    }
  }
  // A kind of thing in a window ("the Send button") is never a window.
  const elementKind = scoped || (want.roles.length > 0 && !want.window);
  const candidates = [
    ...(look && !want.window ? elementCandidates(want, look) : []),
    ...(!elementKind && windows ? windowCandidates(want, look, windows) : []),
  ];
  const best = candidates.reduce<Candidate | null>(
    (top, next) => (!top || next.score > top.score ? next : top),
    null,
  );
  if (best)
    return {
      version: 1,
      code: "found",
      match: best.match,
      region: best.region,
    };
  return {
    version: 1,
    code: look ? "no_match" : "no_look",
    match: null,
    region: null,
  };
}

/**
 * The windows on the main display, front to back: owner and place only. It
 * reads the system's window list, which needs no permission for these two and
 * holds no picture. No window title is read.
 */
const windowListScript = `function run() {
  ObjC.import("CoreGraphics");
  ObjC.import("AppKit");
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  var screens = $.NSScreen.screens;
  if (!screens.count) return "[]";
  var main = screens.objectAtIndex(0).frame;
  var out = [];
  for (var i = 0; i < list.length && out.length < 60; i++) {
    var w = list[i];
    if (w.kCGWindowLayer !== 0 || !w.kCGWindowBounds || typeof w.kCGWindowOwnerName !== "string") continue;
    var b = w.kCGWindowBounds;
    if (b.Width < 120 || b.Height < 80) continue;
    out.push({ owner: w.kCGWindowOwnerName, x: b.X / main.size.width, y: b.Y / main.size.height, w: b.Width / main.size.width, h: b.Height / main.size.height });
  }
  return JSON.stringify(out);
}`;

const windowSchema = z
  .array(
    z
      .object({
        owner: z.string().min(1).max(200),
        x: z.number().finite(),
        y: z.number().finite(),
        w: z.number().finite().positive(),
        h: z.number().finite().positive(),
      })
      .strict(),
  )
  .max(60);

export function systemWindows(run: Runner, timeoutMs = 2000): WindowList {
  return async () => {
    const result = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", windowListScript],
      timeoutMs,
    );
    if (result.status !== 0) return null;
    try {
      return windowSchema.parse(JSON.parse(result.stdout));
    } catch {
      return null;
    }
  };
}
