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
 * The front window of one running application as shares of the main screen:
 * JSON `{ owner, x, y, w, h }`, or "none". Matches only exact case-insensitive
 * owner names passed in argv. Reads the window list of the system, which needs
 * no permission for the place and the owner of a window.
 */
const frontWindow = `function run(argv) {
  ObjC.import("CoreGraphics");
  ObjC.import("AppKit");
  var wanted = [];
  for (var j = 0; j < argv.length; j++) wanted.push(String(argv[j]).toLowerCase());
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || [];
  var screens = $.NSScreen.screens;
  if (!screens.count) return "none";
  var main = screens.objectAtIndex(0).frame;
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    if (w.kCGWindowLayer !== 0 || !w.kCGWindowBounds || !w.kCGWindowOwnerName) continue;
    var owner = String(w.kCGWindowOwnerName);
    if (wanted.indexOf(owner.toLowerCase()) < 0) continue;
    var b = w.kCGWindowBounds;
    if (b.Width < 200 || b.Height < 120) continue;
    return JSON.stringify({
      owner: owner,
      x: b.X / main.size.width,
      y: b.Y / main.size.height,
      w: b.Width / main.size.width,
      h: b.Height / main.size.height
    });
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

/** Exact aliases from spoken or short app names to macOS window owner names. */
const appAliases: Record<string, readonly string[]> = {
  chrome: ["Google Chrome"],
  "google chrome": ["Google Chrome"],
  vscode: ["Code", "Visual Studio Code"],
  "vs code": ["Code", "Visual Studio Code"],
  "visual studio code": ["Code", "Visual Studio Code"],
  iterm: ["iTerm2"],
  iterm2: ["iTerm2"],
  imessage: ["Messages"],
  messages: ["Messages"],
  settings: ["System Settings", "System Preferences"],
  "system settings": ["System Settings", "System Preferences"],
  "system preferences": ["System Settings", "System Preferences"],
  brave: ["Brave Browser"],
  edge: ["Microsoft Edge"],
  zoom: ["zoom.us"],
  quicktime: ["QuickTime Player"],
  "text edit": ["TextEdit"],
  "apple mail": ["Mail"],
  word: ["Microsoft Word"],
  excel: ["Microsoft Excel"],
  powerpoint: ["Microsoft PowerPoint"],
  outlook: ["Microsoft Outlook"],
  teams: ["Microsoft Teams", "Microsoft Teams (work or school)"],
};

const cleanAppQuery = (value: string): string | null => {
  const name = value
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.app$/i, "")
    .trim();
  if (!name || name.length > 80 || name.startsWith("-")) return null;
  return name;
};

/** Exact candidate owner names for a query, preserving case and order. */
export function ownerCandidates(name: string): string[] {
  const clean = cleanAppQuery(name);
  if (!clean) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string) => {
    const lower = value.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(value);
  };
  add(clean);
  const aliases = appAliases[clean.toLowerCase()];
  if (aliases) {
    for (const alias of aliases) add(alias);
  }
  return out;
}

export interface WindowMatch {
  owner: string;
  view: CallView;
}

/**
 * Looks up the front on-screen window of a running macOS application by exact
 * case-insensitive owner match (or exact alias). Never launches an app.
 */
export async function windowLookup(
  run: Runner,
  name: string,
): Promise<WindowMatch | null> {
  const candidates = ownerCandidates(name);
  if (!candidates.length) return null;
  const result = await run(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", frontWindow, ...candidates],
    5000,
  );
  if (result.status !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw || raw === "none") return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        owner?: unknown;
        x?: unknown;
        y?: unknown;
        w?: unknown;
        h?: unknown;
      };
      const owner = typeof parsed.owner === "string" ? parsed.owner.trim() : "";
      if (
        !owner ||
        owner.startsWith("-") ||
        !candidates.some((c) => c.toLowerCase() === owner.toLowerCase())
      )
        return null;
      const view = cleanView({
        x: parsed.x,
        y: parsed.y,
        w: parsed.w,
        h: parsed.h,
      });
      return view ? { owner, view } : null;
    } catch {
      return null;
    }
  }
  const numbers = raw.split(/\s+/).map(Number);
  if (numbers.length !== 4) return null;
  const [x, y, w, h] = numbers as [number, number, number, number];
  const view = cleanView({ x, y, w, h });
  return view ? { owner: candidates[0]!, view } : null;
}

/** The front window of an application, as a view. null when it has no window on the main screen. */
export async function windowView(
  run: Runner,
  owner: string,
): Promise<CallView | null> {
  return (await windowLookup(run, owner))?.view ?? null;
}

export type CallViewTarget = AgentSession | null | { app: string };

export interface ViewResult {
  ok: boolean;
  /** One sentence that can be said aloud. */
  said: string;
}

/**
 * Zooms the call video to the front window of an already-running macOS app.
 * Never launches a non-running app and focuses only the exact matched owner.
 */
export async function showAppOnCall(
  deps: {
    store: ViewStore;
    run: Runner;
    pause?: (ms: number) => Promise<void>;
  },
  app: string,
): Promise<ViewResult> {
  const name = cleanAppQuery(app);
  if (!name)
    return {
      ok: false,
      said: "Tell me which open app window you want to zoom in on.",
    };
  const found = await windowLookup(deps.run, name);
  if (!found)
    return {
      ok: false,
      said: `I could not find an open ${name} window on the main screen to zoom in on.`,
    };
  await deps.run("/usr/bin/open", ["-a", found.owner], 5000);
  await (deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(450);
  const refreshed = await windowLookup(deps.run, found.owner);
  const view = refreshed?.view ?? found.view;
  deps.store.set(view);
  return {
    ok: true,
    said: `The call now shows only the ${found.owner} window. Say "show the whole screen" to go back.`,
  };
}

/**
 * Sets the view of the call to the window of one session or running app, or to
 * the whole screen with null. For a session: its tab comes to the front first,
 * so its window is the front window of its terminal, and that window is the view.
 */
export async function showOnCall(
  deps: {
    store: ViewStore;
    run: Runner;
    /** The titles that find the session's tab: see topics.ts. */
    titles: (session: AgentSession) => string[];
    pause?: (ms: number) => Promise<void>;
  },
  target: CallViewTarget,
): Promise<ViewResult> {
  if (!target) {
    deps.store.set(null);
    return { ok: true, said: "The call shows the whole screen again." };
  }
  if ("app" in target) return showAppOnCall(deps, target.app);
  const session = target;
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
