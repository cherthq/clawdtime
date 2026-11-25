/**
 * Computer use: a done while the app that the goal asks to quit is open.
 *
 * Many requests end with "Then quit <App>." In the stress run on the owner's
 * Mac (26 Nov 2026) several of them ended with done while the app was still
 * open: the planner read what it was asked for and stopped there. So a done
 * while the app that the end of the goal asks to quit is in front goes back
 * to the planner once, as a done after an input that changed nothing does.
 * The next done is taken.
 *
 * The worker sees only the app in front. An app that runs behind another one
 * is not seen, so it is not judged.
 */
import type { Observation } from "./ports.js";

/** A name as it is compared: lower case, one space, no ".app". */
const key = (name: string) =>
  name
    .trim()
    .replace(/\.app$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

/** Words that stand for an app without naming it. */
const pronoun =
  /^(?:it|them|that|this|those|these|everything|all|all of them|the app|the apps)$/i;

/**
 * The app that the end of the goal asks to quit, as the goal names it: "Then
 * quit Tips." gives "Tips". The quit starts the last sentence, or follows
 * then, and, finally or lastly in it. Null when the end of the goal asks for
 * no quit, or for the quit of no named app ("Then quit it").
 */
export function quitAtEnd(goal: string): string | null {
  const said = goal.trim().replace(/[\s.!]+$/, "");
  const found =
    /(?:^|[.!?;]\s+|,\s+|\b(?:then|and|finally|lastly),?\s+)quit\s+(?:the\s+)?([^.!?;,]+?)(?:\s+app)?$/i.exec(
      said,
    );
  if (!found) return null;
  const name = found[1]!.trim();
  return name && !pronoun.test(name) ? name : null;
}

/**
 * The app in front is the app of that name: by the name that it shows, by its
 * bundle identifier, or as the app that open_app found for that name in this
 * request (`opened`, by the name as it was said). The last one knows an app
 * whose name the Mac shows in another language: "Colour" for "Color".
 */
export function inFront(
  name: string,
  front: Observation["app"],
  opened: Readonly<Record<string, string>> = {},
): boolean {
  const wanted = key(name);
  const bundle = front.bundleId.trim().toLowerCase();
  if (!wanted || !bundle) return false;
  return (
    key(front.name) === wanted ||
    bundle === wanted ||
    opened[wanted]?.trim().toLowerCase() === bundle
  );
}

/** The key under which `inFront` finds the app that open_app found for a name. */
export const openedKey = key;

/** What the planner reads when its done goes back. */
export const quitOpenNote = (name: string) =>
  `The goal also asks to quit ${name}; it is still open.`;
