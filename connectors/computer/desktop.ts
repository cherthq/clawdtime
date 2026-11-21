/** Desktop results are control evidence, not presentation/crop coordinates. */
import type { HandCommand, HandResult, Observation } from "./ports.js";

export const desktopBlockedText = {
  desktop_disabled:
    "Desktop activation is disabled in the panel (CLAWDTIME_DESKTOP_SWITCHING=off). No app was activated.",
  ambiguous_target:
    "More than one app or window matches. Name the app by bundle ID and the exact window title; nothing was activated.",
  unsupported_desktop:
    "Desktop activation supports ordinary windows with one main display. Full-screen, Split View, multiple displays, or unavailable window metadata are not supported; nothing was activated.",
  target_not_visible:
    "The intended ordinary window could not be identified before activation. Open the target window yourself and ask again; nothing was activated.",
} as const;

export const transitionUnknownText =
  "App or desktop activation was requested, but the intended window was not independently verified. It may have switched. I stopped without retrying or sending further input. Check the screen and Mission Control's app-switching setting, then run: clawdtime computer clear";

export const inputUnknownText =
  "Input began, then the target changed or control was interrupted. Some input may have reached the app. I stopped without retrying. Check the screen, then run: clawdtime computer clear";

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

/** Older panels that merely acknowledge activation cannot establish readiness. */
export function verifiedActivation(
  command: HandCommand,
  result: HandResult,
): boolean {
  if (command.kind !== "open_app" || !result.ok) return true;
  const seen = result.observation;
  return (
    !!seen &&
    seen.surfaceEpoch !== undefined &&
    !!seen.image &&
    !!seen.imageWidth &&
    !!seen.imageHeight &&
    !!seen.app.bundleId &&
    !!seen.app.name &&
    (seen.app.bundleId.toLowerCase() === command.name.toLowerCase() ||
      seen.app.name.toLowerCase() === command.name.toLowerCase()) &&
    (command.window === undefined || seen.app.window === command.window)
  );
}
