/**
 * Computer use: the limits of a closer look.
 *
 * A closer look (`look_closer`) is a picture only. The hands take one part of
 * the screen larger (command `zoom`) and send nothing to an app. The rules
 * here keep it a small, safe look:
 *
 * - A request has at most `closerLimit` closer looks.
 * - A part of the screen with a password field in it is never shown larger:
 *   the check before the zoom refuses it, and a closer picture whose part has
 *   a password field in the look after it never reaches the planner.
 * - A closer picture goes to the planner only with a look of the same
 *   screen: the same app and window in front, the same display and the same
 *   size of picture. When another app came to the front since the zoom, the
 *   planner would aim at a thing that is no longer there.
 * - A click in the closer picture is turned into a click in the first
 *   picture, so that every check of a click runs on it as on any click.
 */
import type { Action, Closer, Observation } from "./ports.js";
import { sameWindowTitle } from "./desktop.js";

/** The most closer looks in one request. */
export const closerLimit = 6;
export const closerLimitText = `This request had ${closerLimit} closer looks already. Use the pictures that you have, or choose another way.`;
export const closerSecureText =
  "A password field is in that part of the screen. A closer look never shows one.";
export const closerChangedText =
  "The screen changed after the closer look: another app, window or display is in front now. Use the new picture, or look closer again.";

/** What a closer picture was taken of: the app and the window in front, the display and the size of the first picture. */
export interface CloserScene {
  app: { name: string; bundleId: string; window: string };
  screen: { width: number; height: number; scale: number };
  surfaceEpoch?: number;
  imageWidth?: number;
  imageHeight?: number;
}

/** The scene of the look that a closer picture is a part of. */
export function closerScene(seen: Observation): CloserScene {
  return {
    app: { ...seen.app },
    screen: { ...seen.screen },
    surfaceEpoch: seen.surfaceEpoch,
    imageWidth: seen.imageWidth,
    imageHeight: seen.imageHeight,
  };
}

/**
 * True when the look of this turn is not of the scene that the closer
 * picture was taken of: another app or window in front, another display or
 * surface, or a first picture of another size. No look is a change too.
 */
export function closerOutOfDate(
  taken: CloserScene,
  seen: Observation | null,
): boolean {
  if (!seen) return true;
  return (
    seen.app.bundleId !== taken.app.bundleId ||
    seen.app.name !== taken.app.name ||
    !sameWindowTitle(taken.app.window, seen.app.window) ||
    seen.screen.width !== taken.screen.width ||
    seen.screen.height !== taken.screen.height ||
    seen.screen.scale !== taken.screen.scale ||
    seen.surfaceEpoch !== taken.surfaceEpoch ||
    seen.imageWidth !== taken.imageWidth ||
    seen.imageHeight !== taken.imageHeight
  );
}

/** A part of the screen, in screen points. */
interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The space around a password field that is also kept out of a closer look, in screen points. */
const secureMargin = 8;

/** True when a password field of the observation lies in the area, or near it. */
export function secureInArea(seen: Observation, area: Area): boolean {
  return seen.elements.some(
    (item) =>
      item.secure &&
      item.x - secureMargin < area.x + area.w &&
      area.x < item.x + item.w + secureMargin &&
      item.y - secureMargin < area.y + area.h &&
      area.y < item.y + item.h + secureMargin,
  );
}

/**
 * True when the closer picture may not go to the planner: the look after it
 * has a password field in its part, or that look cannot say (no look, or no
 * picture to map the part with). When in doubt, the picture stays back.
 */
export function closerShowsSecure(
  closer: Closer,
  seen: Observation | null,
): boolean {
  if (!seen?.imageWidth || !seen.imageHeight) return true;
  const across = seen.screen.width / seen.imageWidth,
    down = seen.screen.height / seen.imageHeight;
  const { x, y, w, h } = closer.region;
  return secureInArea(seen, {
    x: x * across,
    y: y * down,
    w: w * across,
    h: h * down,
  });
}

/** Why a closer look is not sent now, or null when it may go. */
export function closerHold(action: Action, done: number): string | null {
  return action.kind === "look_closer" && done >= closerLimit
    ? closerLimitText
    : null;
}

/**
 * A click that the planner gave in the closer picture, as a click in the
 * first picture. A click with `closer` false loses the flag. A click with
 * `closer` true and no closer picture in this turn, or a point outside it,
 * is a problem for the model to fix: it is never guessed.
 */
export function fromCloserPicture(
  action: Action,
  closer: Closer | undefined,
): { action: Action } | { problem: string } {
  if (action.kind !== "click_at" || !("closer" in action)) return { action };
  const { closer: flag, ...plain } = action as Action & { closer?: unknown };
  if (flag === false) return { action: plain as Action };
  // Any other value is left for the check of the arguments.
  if (flag !== true) return { action };
  if (!closer)
    return {
      problem:
        "There is no closer picture in this turn. Give x and y in the pixels of the first picture, with no closer.",
    };
  const { x, y } = plain as { x?: unknown; y?: unknown };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !(x >= 0 && x <= closer.imageWidth && y >= 0 && y <= closer.imageHeight)
  )
    return {
      problem: `The point is not inside the closer picture of ${closer.imageWidth} by ${closer.imageHeight} pixels.`,
    };
  const region = closer.region;
  return {
    action: {
      ...plain,
      x: Math.round(region.x + (x * region.w) / closer.imageWidth),
      y: Math.round(region.y + (y * region.h) / closer.imageHeight),
    } as Action,
  };
}
