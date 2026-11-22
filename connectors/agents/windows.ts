import { ghosttyTerminal, realRunner, type Runner } from "./focus.js";
import { title } from "./render.js";
import type { AgentSession } from "./types.js";

/**
 * The size of a session's own terminal window, through the terminal's own
 * scripting. It sends no key and no text to the session, and it needs no
 * Accessibility permission. Each script takes its target as an argument.
 */
export const windowActions = [
  "maximize",
  "restore",
  "bigger_text",
  "smaller_text",
  "normal_text",
] as const;
export type WindowAction = (typeof windowActions)[number];

const terminalZoom = `on run argv
  set target to "/dev/" & item 1 of argv
  set wanted to (item 2 of argv) is "true"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is target then
          set zoomed of w to wanted
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "missing"
end run`;
/** The action is one of the fixed strings below. No word of a person or a model reaches it. */
const ghosttyAction = `on run argv
  set wanted to item 1 of argv
  tell application "Ghostty"
    set matches to every terminal whose id is wanted
    if (count of matches) is 0 then return "missing"
    perform action (item 2 of argv) on (item 1 of matches)
    return "ok"
  end tell
end run`;
const ghosttyFront = `on run argv
  set wanted to item 1 of argv
  tell application "Ghostty"
    set matches to every terminal whose id is wanted
    if (count of matches) is 0 then return "missing"
    focus (item 1 of matches)
    return "ok"
  end tell
end run`;
/**
 * Whether the front window of one application fills a screen: "filled",
 * "partial" or "unknown". It reads the window list of the system, which needs
 * no permission for the place and the owner of a window.
 */
const fills = `function run(argv) {
  ObjC.import("CoreGraphics");
  ObjC.import("AppKit");
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  var front = null;
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.kCGWindowOwnerName === argv[0] && w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 200) { front = w.kCGWindowBounds; break; }
  }
  if (!front) return "unknown";
  var screens = $.NSScreen.screens;
  var count = screens.count;
  if (!count) return "unknown";
  var top = screens.objectAtIndex(0).frame.size.height;
  var near = function (a, b) { return Math.abs(a - b) <= 4; };
  for (var s = 0; s < count; s++) {
    var screen = screens.objectAtIndex(s);
    var frames = [screen.visibleFrame, screen.frame];
    for (var f = 0; f < frames.length; f++) {
      var r = frames[f];
      if (near(front.X, r.origin.x) && near(front.Y, top - r.origin.y - r.size.height) && near(front.Width, r.size.width) && near(front.Height, r.size.height)) return "filled";
    }
  }
  return "partial";
}`;

const ghosttyText: Partial<Record<WindowAction, string>> = {
  bigger_text: "increase_font_size:2",
  smaller_text: "decrease_font_size:2",
  normal_text: "reset_font_size",
};
const textSaid: Partial<Record<WindowAction, string>> = {
  bigger_text: "is bigger now",
  smaller_text: "is smaller now",
  normal_text: "is back to its normal size",
};

export interface WindowResult {
  ok: boolean;
  /** One sentence that can be said aloud. */
  said: string;
}

/**
 * Makes the window of one session fill the screen, puts it back, or changes
 * the text size of its terminal. A terminal that offers no way to do it gets a
 * plain refusal: nothing is guessed and no key is pressed.
 */
export async function sessionWindow(
  session: AgentSession,
  action: WindowAction,
  run: Runner = realRunner,
  /** The name of the session and the title it shows: how a Ghostty terminal is found. */
  titles: string[] = [],
): Promise<WindowResult> {
  const name = title(session);
  const { terminal } = session;
  if (session.host || terminal.remote || session.focus === "none")
    return { ok: false, said: `${name} has no window on this Mac.` };
  const osa = (...args: string[]) => run("/usr/bin/osascript", args, 5000);
  const done = (result: { status: number | null; stdout: string }) =>
    result.status === 0 && result.stdout.trim() === "ok";
  const lost = { ok: false, said: `I could not find the window of ${name}.` };
  const size = action === "maximize" || action === "restore";

  if (terminal.app === "Terminal") {
    if (!size)
      return {
        ok: false,
        said: "Terminal has no text size for one window. I can make the window fill the screen.",
      };
    const tty = terminal.tmux ? terminal.tmux.clientTty : terminal.tty;
    if (!tty) return lost;
    const wanted = action === "maximize";
    if (!done(await osa("-e", terminalZoom, tty, String(wanted)))) return lost;
    return {
      ok: true,
      said: wanted
        ? `The window of ${name} fills the screen now.`
        : `The window of ${name} is back to its own size.`,
    };
  }

  if (terminal.app === "Ghostty" && !terminal.tmux) {
    const id = await ghosttyTerminal(run, titles);
    if (!id) return lost;
    if (!size) {
      if (!done(await osa("-e", ghosttyAction, id, ghosttyText[action]!)))
        return lost;
      return { ok: true, said: `The text of ${name} ${textSaid[action]}.` };
    }
    // Ghostty has only a toggle. The window comes to the front, its size is
    // read, and the toggle is sent only when the size is not the wanted one.
    if (!done(await osa("-e", ghosttyFront, id))) return lost;
    const state = (
      await osa("-l", "JavaScript", "-e", fills, "Ghostty")
    ).stdout.trim();
    if (state !== "filled" && state !== "partial")
      return {
        ok: false,
        said: `I could not read the size of the window of ${name}, so I changed nothing.`,
      };
    const wanted = action === "maximize";
    if ((state === "filled") === wanted)
      return {
        ok: true,
        said: wanted
          ? `The window of ${name} already fills the screen.`
          : `The window of ${name} already has its own size.`,
      };
    if (!done(await osa("-e", ghosttyAction, id, "toggle_maximize")))
      return lost;
    return {
      ok: true,
      said: wanted
        ? `The window of ${name} fills the screen now.`
        : `The window of ${name} is back to its own size.`,
    };
  }

  return {
    ok: false,
    said: `I cannot change the window of ${terminal.app ?? "that terminal"}.`,
  };
}
