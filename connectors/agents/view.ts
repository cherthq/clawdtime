import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { focusSession, type Runner } from "./focus.js";
import { title } from "./render.js";
import type { AgentSession } from "./types.js";

/**
 * The view of a call: which part of the main screen the call's video shows.
 * A person on a phone cannot read a whole screen. "Zoom in on the session that
 * builds the page" sets the view to that one window, and the line agent, which
 * sends the video, crops to it. null is the whole screen.
 *
 * The view is four shares of the main screen, from 0 to 1. It is kept in one
 * small owner-only file, because the program that answers a request and the
 * program that sends the video are two processes.
 */
export interface CallView {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A view inside the screen, or null when the numbers are no window that a person asked to see. */
export function cleanView(value: unknown): CallView | null {
  const view = value as Partial<CallView> | null;
  if (!view || typeof view !== "object") return null;
  const numbers = [view.x, view.y, view.w, view.h];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n)))
    return null;
  const x = Math.min(1, Math.max(0, view.x!));
  const y = Math.min(1, Math.max(0, view.y!));
  const w = Math.min(1 - x, Math.max(0, view.w!));
  const h = Math.min(1 - y, Math.max(0, view.h!));
  if (w < 0.08 || h < 0.08) return null;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

export class ViewStore {
  private readonly file: string;
  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(root, "agents", "view.json");
  }
  /** The view and when it was set. A view of an earlier call is the caller's to ignore. */
  get(): { view: CallView | null; at: number } {
    try {
      if (!existsSync(this.file) || !lstatSync(this.file).isFile())
        return { view: null, at: 0 };
      const value = JSON.parse(readFileSync(this.file, "utf8")) as {
        view?: unknown;
        at?: unknown;
      };
      return {
        view: cleanView(value.view),
        at: typeof value.at === "number" && value.at > 0 ? value.at : 0,
      };
    } catch {
      return { view: null, at: 0 };
    }
  }
  set(view: CallView | null) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, view: cleanView(view), at: this.now() }),
      { mode: 0o600 },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
}

/**
 * The front window of one application as shares of the main screen:
 * "x y w h" in shares, or "none". It reads the window list of the system,
 * which needs no permission for the place and the owner of a window.
 */
const frontWindow = `function run(argv) {
  ObjC.import("CoreGraphics");
  ObjC.import("AppKit");
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  var screens = $.NSScreen.screens;
  if (!screens.count) return "none";
  var main = screens.objectAtIndex(0).frame;
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.kCGWindowOwnerName !== argv[0] || w.kCGWindowLayer !== 0 || !w.kCGWindowBounds) continue;
    var b = w.kCGWindowBounds;
    if (b.Width < 200 || b.Height < 120) continue;
    return [b.X / main.size.width, b.Y / main.size.height, b.Width / main.size.width, b.Height / main.size.height].join(" ");
  }
  return "none";
}`;

/** The name that the system's window list gives each terminal application. */
const owners: Record<string, string> = {
  Terminal: "Terminal",
  Ghostty: "Ghostty",
  iTerm: "iTerm2",
  iTerm2: "iTerm2",
  WezTerm: "WezTerm",
  Alacritty: "Alacritty",
  kitty: "kitty",
  Warp: "Warp",
};

/** The front window of an application, as a view. null when it has no window on the main screen. */
export async function windowView(
  run: Runner,
  owner: string,
): Promise<CallView | null> {
  const result = await run(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", frontWindow, owner],
    5000,
  );
  if (result.status !== 0) return null;
  const numbers = result.stdout.trim().split(/\s+/).map(Number);
  if (numbers.length !== 4) return null;
  const [x, y, w, h] = numbers as [number, number, number, number];
  return cleanView({ x, y, w, h });
}

export interface ViewResult {
  ok: boolean;
  /** One sentence that can be said aloud. */
  said: string;
}

/**
 * Sets the view of the call to the window of one session, or to the whole
 * screen with null. For a session: its tab comes to the front first, so its
 * window is the front window of its terminal, and that window is the view.
 */
export async function showOnCall(
  deps: {
    store: ViewStore;
    run: Runner;
    /** The titles that find the session's tab: see topics.ts. */
    titles: (session: AgentSession) => string[];
    pause?: (ms: number) => Promise<void>;
  },
  session: AgentSession | null,
): Promise<ViewResult> {
  if (!session) {
    deps.store.set(null);
    return { ok: true, said: "The call shows the whole screen again." };
  }
  const name = title(session);
  if (session.host || session.terminal.remote || session.focus === "none")
    return { ok: false, said: `${name} has no window on this Mac to show.` };
  const owner = session.terminal.app ? owners[session.terminal.app] : undefined;
  if (!owner)
    return {
      ok: false,
      said: `I cannot find the window of ${session.terminal.app ?? "that terminal"} to zoom in on.`,
    };
  const focused = await focusSession(
    session,
    deps.run,
    "tmux",
    deps.titles(session),
  );
  if (!focused.ok)
    return { ok: false, said: `${name} did not come to the front.` };
  // The window needs a moment to come to the front of the window list.
  await (deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(450);
  const view = await windowView(deps.run, owner);
  if (!view)
    return {
      ok: false,
      said: `I brought ${name} to the front, but I could not find its window on the main screen to zoom in on.`,
    };
  deps.store.set(view);
  return {
    ok: true,
    said: `The call now shows only the window of ${name}. Say "show the whole screen" to go back.`,
  };
}
