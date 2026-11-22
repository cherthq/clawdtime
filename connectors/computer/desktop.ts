/** Desktop results are control evidence, not presentation/crop coordinates. */
import type { HandCommand, HandResult, Observation } from "./ports.js";

export const desktopBlockedText = {
  desktop_disabled:
    "Desktop switching is disabled in the panel (CLAWDTIME_DESKTOP_SWITCHING=off). No transition was attempted.",
  desktop_shortcut_unavailable:
    "Configure and enable both Move left a space and Move right a space in macOS Keyboard Shortcuts > Mission Control, then explicitly map the matching shortcuts in the panel launch environment. No transition was attempted.",
  desktop_history_unavailable:
    "There is no verified previous desktop in this panel session. Ask for left or right explicitly. No transition was attempted.",
  ambiguous_target:
    "More than one app or window matches. Name the app by bundle ID and the exact window title; nothing was activated.",
  unsupported_desktop:
    "Navigation requires one active main display and a distinguishable ordinary or explicitly verified full-screen window. Split View, multiple displays, or unavailable evidence are unsupported; no transition was attempted.",
  target_not_visible:
    "The intended window could not be identified before activation. Open the target window yourself and ask again; nothing was activated.",
  // Known, not unknown: no Space change was reported and the same surface
  // stayed in view for the whole wait. Nothing locks after it.
  desktop_unchanged:
    "The desktop did not change. There may be no desktop on that side.",
} as const;

/** Command+Tab was refused before anything was sent: no other app runs. */
export const noOtherAppText =
  "There is no other app to go back to. Nothing was sent.";

/**
 * How a person clears an unknown result. The spoken way comes first: a person
 * on a call or away from the Mac has no terminal. The command stays for the
 * one who has. Both mark the request as seen and repeat nothing.
 */
export const clearHint =
  'After you looked at the screen, say "clear the computer task", or run: clawdtime computer clear';

/**
 * Answers to open_app that end the request: an unknown result, a missing
 * right, Stop. They never go to the planner as a refusal.
 */
const activationOver = new Set([
  "transition_unknown",
  "input_unknown",
  "no_accessibility",
  "no_screen_recording",
  "stopped_by_person",
]);
/** Why the hands opened nothing, when the reason is about the app or the window. */
const activationRefusedText: Record<string, string> = {
  not_found:
    "No app with that name was found on this Mac. Nothing was opened. Use the name that the app has in Finder or its bundle identifier, or tell the person that it is not there.",
  ambiguous_target:
    "More than one app has that name, or more than one window has that title. Nothing was activated. Use the bundle identifier, or leave the window title out to let the app choose its window.",
  unsupported_desktop:
    "A window can be chosen by its title only on one display, as an ordinary or a verified full-screen window. Nothing was activated. Leave the window title out to bring the app forward.",
  target_not_visible:
    "No window of that app has that title now. Nothing was activated. Leave the window title out to bring the app forward, or tell the person.",
  desktop_disabled:
    "Bringing an app forward is turned off in the panel (CLAWDTIME_DESKTOP_SWITCHING=off). Nothing was activated. Tell the person.",
  stale_observation: "The screen changed on the way. Nothing was activated.",
};
/**
 * The hands refused open_app before anything was sent: the reason, in words
 * for the planner. Null for every other result.
 *
 * The hands say `transition_unknown` for everything that fails after the
 * request went out, so any other error means that nothing was sent. Such a
 * refusal is not the end of the request. A person who says "open Chrome"
 * names an app as people do, and the planner can try the name that this Mac
 * knows or say why it cannot be done.
 */
export function activationRefusal(
  command: HandCommand,
  result: HandResult | null,
): string | null {
  if (command.kind !== "open_app" || !result || result.ok) return null;
  const error = result.error ?? "failed";
  if (activationOver.has(error)) return null;
  return (
    activationRefusedText[error] ??
    `The panel did not open it (${error}). Nothing was sent.`
  );
}

export const transitionUnknownText = `An app or desktop transition was attempted, but arrival was not independently verified. It may have switched; a disabled shortcut or a delayed animation can also prevent verification. I stopped without retrying or sending further input. Check the Mission Control settings too. ${clearHint}`;

export const inputUnknownText = `Input began, then the target changed or control was interrupted. Some input may have reached the app. I stopped without retrying. ${clearHint}`;

/** Same surface, including a round trip to another Space with unchanged titles. */
export function sameSurface(before: Observation, after: Observation): boolean {
  return (
    before.surfaceEpoch === after.surfaceEpoch &&
    before.app.bundleId === after.app.bundleId &&
    before.app.window === after.app.window &&
    before.screen.width === after.screen.width &&
    before.screen.height === after.screen.height &&
    before.screen.scale === after.screen.scale
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A window title as every observation carries it. This is `ElementCleaner.line`
 * of the panel, step for step: a control, format or space character becomes
 * one space, runs of spaces close up, and a title over the limit ends with an
 * ellipsis. A title that a person asked for is compared only in this form,
 * because the title in an observation has no other form.
 */
export function cleanTitle(title: string, limit = 200): string {
  const spaced = Array.from(title)
    .slice(0, limit * 8)
    .map((character) => (/[\p{C}\p{Z}]/u.test(character) ? " " : character))
    .join("");
  const words: string[] = [];
  let word: string[] = [];
  for (const { segment } of graphemes.segment(spaced)) {
    if (segment !== " ") word.push(segment);
    else if (word.length) {
      words.push(word.join(""));
      word = [];
    }
  }
  if (word.length) words.push(word.join(""));
  const line = words.join(" ");
  if (line.length <= limit) return line;
  let kept = "";
  for (const { segment } of graphemes.segment(line)) {
    // One unit stays free for the ellipsis.
    if (kept.length + segment.length > limit - 1) break;
    kept += segment;
  }
  return `${kept.trim()}…`;
}
/**
 * Two window titles that are the same title after the observation's cleaning.
 * The panel compares strings by their letters, not by how the letters are
 * stored, so "é" as one character equals "e" with an accent after it. The
 * same holds here. A title that cleans to nothing names no window.
 */
export function sameTitle(one: string, other: string): boolean {
  const title = cleanTitle(one).normalize("NFC");
  return title !== "" && title === cleanTitle(other).normalize("NFC");
}
/** A bundle identifier names one app, whatever the case of its letters. */
const sameApp = (one: string, other: string) =>
  one.trim().toLowerCase() === other.trim().toLowerCase();

/**
 * One definition of "arrived", the same as `DesktopArrival` in the panel.
 *
 * The hands find one app for the name and say which: its bundle identifier.
 * Arrived means that this app is in front. A name has four forms that the
 * hands accept (the bundle identifier, the name of the running app, the file
 * name, the name in Finder), so the name itself says nothing here: "iTerm"
 * opens an app that calls itself "iTerm2". With a window title, the window in
 * front also has that title, after the observation's cleaning on both sides.
 *
 * A panel that does not say which app it found is judged by the name, as
 * before. A panel that only acknowledges the command proves nothing.
 */
export function verifiedActivation(
  command: HandCommand,
  result: HandResult,
): boolean {
  if (
    (command.kind !== "open_app" && command.kind !== "switch_previous_app") ||
    !result.ok
  )
    return true;
  const seen = result.observation;
  if (
    !seen ||
    seen.surfaceEpoch === undefined ||
    !seen.image ||
    !seen.imageWidth ||
    !seen.imageHeight ||
    !seen.app.bundleId ||
    !seen.app.name
  )
    return false;
  if (command.kind === "switch_previous_app") return true;
  const resolved = result.resolvedBundleId;
  const app =
    resolved !== undefined
      ? resolved.trim() !== "" && sameApp(seen.app.bundleId, resolved)
      : sameApp(seen.app.bundleId, command.name) ||
        sameApp(seen.app.name, command.name);
  return (
    app &&
    (command.window === undefined || sameTitle(seen.app.window, command.window))
  );
}

export function verifiedDesktopSwitch(
  before: Observation,
  result: HandResult,
): boolean {
  const seen = result.observation;
  return (
    result.ok &&
    !!seen &&
    before.surfaceEpoch !== undefined &&
    seen.surfaceEpoch !== undefined &&
    seen.surfaceEpoch > before.surfaceEpoch &&
    !!seen.image &&
    !!seen.imageWidth &&
    !!seen.imageHeight &&
    seen.screen.width === before.screen.width &&
    seen.screen.height === before.screen.height &&
    seen.screen.scale === before.screen.scale
  );
}
