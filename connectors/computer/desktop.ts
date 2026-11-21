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
    "Desktop switching currently requires ordinary desktops on one main display with distinguishable visible windows. Full-screen, Split View, multiple displays, or unavailable evidence are not qualified; no transition was attempted.",
  target_not_visible:
    "The intended ordinary window could not be identified before activation. Open the target window yourself and ask again; nothing was activated.",
} as const;

export const transitionUnknownText =
  "A desktop transition was attempted, but arrival was not independently verified. It may have switched; a boundary, disabled shortcut, or delayed animation can also prevent verification. I stopped without retrying or sending further input. Check the screen and Mission Control settings, then run: clawdtime computer clear";

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

/** Exact user-goal parser, never applied to model output or screen text. Compound
 * goals deliberately stay out: one request authorizes precisely one transition. */
export function desktopDirection(
  goal: string,
): "left" | "right" | "previous" | undefined {
  const words = goal
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .replace(/^please\s+/, "")
    .replace(/\s+please$/, "")
    .replace(/\s+/g, " ");
  if (
    /^(?:go|switch|move) back to (?:the )?previous (?:desktop|space)$/.test(
      words,
    ) ||
    /^(?:go|switch|move) to (?:the )?previous (?:desktop|space)$/.test(words)
  )
    return "previous";
  const match = words.match(
    /^(?:(?:switch|go|move) to (?:the )?(?:desktop|space) (?:on |to )?(?:the )?(left|right)|(?:move|switch|go) (?:one |a )?(?:desktop|space) (left|right)|(?:switch|move) (left|right) (?:one |a )?(?:desktop|space))$/,
  );
  return (match?.[1] ?? match?.[2] ?? match?.[3]) as
    "left" | "right" | undefined;
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
