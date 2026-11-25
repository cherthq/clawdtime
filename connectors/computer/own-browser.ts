/**
 * ClawdTime's own browser.
 *
 * A browser of the Chromium family that ClawdTime starts itself, with its own
 * profile in the state folder, and drives through the Chrome DevTools
 * Protocol. It needs no setting in the person's browser and no Automation
 * right of macOS. The person signs in to sites in this profile once, and
 * stays signed in there. Their usual browser and its profile are not touched.
 *
 * The endpoint is this browser's own. The browser writes its port and the
 * path of its endpoint in `DevToolsActivePort`, in the profile folder, which
 * is private to this user. The driver reads them there, connects to
 * 127.0.0.1 only, and then asks the browser for the number of its process.
 * That number must be the process that this driver started, or, for a browser
 * of an earlier start, the process that holds the lock of this profile.
 * Anything else is refused.
 *
 * Reading is the page script of `browser-script.ts`, run in the page, with
 * the parser of `browser.ts`, so a reading and its numbers are the same as
 * with the other driver. The script runs in a private world of the page (an
 * isolated world of the protocol): it sees the same document, but the page's
 * own scripts cannot see its state or change the functions that it calls.
 * Input is real: the browser itself makes the mouse and key events, so the
 * page sees them as trusted. Before a pointer event, the page script brings
 * the element into view and says whether a pointer at its centre reaches it
 * and nothing else: no element on top, no frame and no other control there.
 * When it does not, nothing is sent. Before a key, the page script says
 * where the focus is: a password field or a frame takes no key.
 *
 * No blind retry. A read may start the browser again when it ended. An input
 * never starts it, and an input whose answer did not come back is never sent
 * again: its result is not known, and the driver throws
 * `BrowserInputUnknown`, which makes the request uncertain.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { webAddress } from "../agents/browser.js";
import { stateRoot } from "../agents/hooks.js";
import {
  pageHelpers,
  pageLimits,
  pageScript,
  type PageCall,
} from "./browser-script.js";
import {
  pageOfReading,
  parsePageAnswer,
  systemClock,
  type BrowserClock,
} from "./browser.js";
import {
  DevToolsClosed,
  DevToolsConnection,
  DevToolsError,
  DevToolsTimeout,
  browserEndpoint,
  dialWebSocket,
  readActivePort,
  type DevToolsDial,
} from "./devtools.js";
import { computerDirectory } from "./journal.js";
import {
  BrowserClosed,
  type BrowserPage,
  type BrowserPort,
  type BrowserTab,
} from "./ports.js";

/**
 * An input went out and its answer never came: the connection closed, or the
 * browser did not answer in time. It may have happened. The worker makes the
 * request uncertain and never sends it again.
 */
export class BrowserInputUnknown extends Error {}

/** A program that started. */
export interface LaunchedBrowser {
  /** 0 when the program did not start at all. */
  pid: number;
  exited(): boolean;
  kill(): void;
}
/** Starts the program with an argument list. No shell runs. */
export type BrowserLauncher = (
  program: string,
  args: string[],
) => LaunchedBrowser;

export const launchProgram: BrowserLauncher = (program, args) => {
  let done = false;
  try {
    const child = spawn(program, args, { stdio: "ignore" });
    child.once("exit", () => {
      done = true;
    });
    child.once("error", () => {
      done = true;
    });
    // The service may end while the browser stays open for the person.
    child.unref();
    return {
      pid: child.pid ?? 0,
      exited: () => done,
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // It ended already.
        }
      },
    };
  } catch {
    return { pid: 0, exited: () => true, kill: () => {} };
  }
};

/** Whether a process with this number runs. */
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The variable that names the browser program, when it is not one of the usual ones. */
export const ownBrowserPathVariable = "CLAWDTIME_OWN_BROWSER_PATH";

/** The programs, in the order they are looked for, in /Applications and ~/Applications. */
export const ownBrowserPrograms = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
] as const;

export const ownTiming = {
  /** The most that the program may take to start and name its port. */
  startMs: 20_000,
  pollMs: 50,
  /** The most that one command may take. */
  callMs: 8000,
  /**
   * The most that one input command may take. It is longer than the wait of
   * the worker, so that an input with no answer stays one with no answer
   * there, and is never taken for one that failed.
   */
  inputMs: 45_000,
  /** After a step, the page gets this long before the first quiescence check. */
  firstLookMs: 50,
  lookEveryMs: 40,
  /** No network request that starts or ends for this long is quiet. */
  quietMs: 100,
  /** No meaningful DOM mutation for this long is idle. */
  domIdleMs: 80,
  /** A request opened before a step that stays open this long no longer counts. */
  bgLongRequestMs: 650,
  /** A request opened during an action step that stays open this long no longer counts. */
  longRequestMs: 1500,
  /** A non-document request during a navigation may stay open this long before being ignored. */
  navLongRequestMs: 1500,
  /** The most that the driver waits for an in-page action to settle. */
  waitMs: 2000,
  /** The most that the driver waits for a navigation to settle. */
  openWaitMs: 3000,
  /** browser_wait reads this often. */
  waitForEveryMs: 250,
  /** The most that browser_wait waits. */
  waitForMs: 10_000,
  /** The most that the browser may take to close. */
  closeMs: 3000,
} as const;

/** The longest text for one step. */
const mostText = 20_000;
/** At most this many tabs are listed. */
const mostTabs = 50;
/** At most this many child frames are traversed per page read. */
const maxChildFrames = 16;
/** Network request types that never gate page settle. */
const ignoredNetworkTypes = new Set([
  "EventSource",
  "WebSocket",
  "Media",
  "Ping",
  "Manifest",
]);

const { oneLine } = pageHelpers;
const me = "ClawdTime's browser";
const notOpen = `${me} is not open. Nothing was sent. Read the page or open an address first: that starts it.`;
const endedNothingSent = `${me} closed. Nothing was sent. Read the page again: that starts it again.`;
const lostInput = `${me} closed while the input went out. Its result is not known, and it is not sent again. Read the page to see what happened.`;
const ownPage = `${me} shows one of its own pages, which ClawdTime does not read or operate: open a web page, then try again.`;
const unreadable = `${me} gave an answer that ClawdTime could not read: read the page again.`;
const changing = `The page changed while ${me} read it: read the page again.`;
/** The name of the private world of the page script. The page does not see it. */
const worldName = "ClawdTime";

/** The keys that a page step may press, with what the browser needs to make each one. */
interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  /** The editing command of macOS that the key stands for in a text field. */
  command?: string;
}
const keySpecs: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, command: "moveUp" },
  arrowdown: {
    key: "ArrowDown",
    code: "ArrowDown",
    keyCode: 40,
    command: "moveDown",
  },
  arrowleft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    keyCode: 37,
    command: "moveLeft",
  },
  arrowright: {
    key: "ArrowRight",
    code: "ArrowRight",
    keyCode: 39,
    command: "moveRight",
  },
  pageup: {
    key: "PageUp",
    code: "PageUp",
    keyCode: 33,
    command: "scrollPageUp",
  },
  pagedown: {
    key: "PageDown",
    code: "PageDown",
    keyCode: 34,
    command: "scrollPageDown",
  },
  home: {
    key: "Home",
    code: "Home",
    keyCode: 36,
    command: "scrollToBeginningOfDocument",
  },
  end: {
    key: "End",
    code: "End",
    keyCode: 35,
    command: "scrollToEndOfDocument",
  },
  backspace: {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
    command: "deleteBackward",
  },
  delete: {
    key: "Delete",
    code: "Delete",
    keyCode: 46,
    command: "deleteForward",
  },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
const shiftKey: KeySpec = { key: "Shift", code: "ShiftLeft", keyCode: 16 };
const metaKey: KeySpec = { key: "Meta", code: "MetaLeft", keyCode: 91 };
const metaCombos: Record<string, KeySpec> = {
  a: { key: "a", code: "KeyA", keyCode: 65, command: "selectAll" },
  z: { key: "z", code: "KeyZ", keyCode: 90, command: "undo" },
};
const shiftBit = 8;
const metaBit = 4;

/** One key event, as the browser takes it. */
export interface KeyEvent {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
  commands?: string[];
}
function down(spec: KeySpec, modifiers: number, commands?: string[]): KeyEvent {
  const event: KeyEvent = {
    type: spec.text !== undefined ? "keyDown" : "rawKeyDown",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers,
  };
  if (spec.text !== undefined) {
    event.text = spec.text;
    event.unmodifiedText = spec.text;
  }
  const said = commands ?? (spec.command ? [spec.command] : []);
  if (said.length) event.commands = said;
  return event;
}
const up = (spec: KeySpec, modifiers: number): KeyEvent => ({
  type: "keyUp",
  key: spec.key,
  code: spec.code,
  windowsVirtualKeyCode: spec.keyCode,
  nativeVirtualKeyCode: spec.keyCode,
  modifiers,
});

/**
 * The key events of one combo, in order: "Enter", "Shift+Tab". Letter case
 * does not count. Any other combo is refused, with nothing sent.
 */
export function keyEvents(combo: string): KeyEvent[] {
  const parts = String(combo)
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const shifted = parts.length === 2 && parts[0] === "shift";
  const meta =
    parts.length === 2 &&
    (parts[0] === "meta" || parts[0] === "cmd" || parts[0] === "command");
  if (meta) {
    const metaSpec = metaCombos[parts[1] ?? ""];
    if (metaSpec)
      return [
        down(metaKey, metaBit),
        down(metaSpec, metaBit),
        up(metaSpec, metaBit),
        up(metaKey, 0),
      ];
  }
  const name = shifted ? parts[1]! : parts.length === 1 ? parts[0]! : "";
  const spec = keySpecs[name === "return" ? "enter" : name];
  if (!spec || (shifted && name !== "tab"))
    throw new Error(
      `${me} presses one of these keys: Enter, Escape, Tab, Shift+Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown, Home, End, Backspace, Delete, Space, Meta+A, Meta+Z.`,
    );
  if (!shifted) return [down(spec, 0), up(spec, 0)];
  return [
    down(shiftKey, shiftBit),
    down(spec, shiftBit),
    up(spec, shiftBit),
    up(shiftKey, 0),
  ];
}
const selectAll: KeyEvent[] = [
  down({ key: "a", code: "KeyA", keyCode: 65 }, metaBit, ["selectAll"]),
  up({ key: "a", code: "KeyA", keyCode: 65 }, metaBit),
];
const toTheEnd: KeyEvent[] = [
  down({ key: "ArrowDown", code: "ArrowDown", keyCode: 40 }, metaBit, [
    "moveToEndOfDocument",
  ]),
  up({ key: "ArrowDown", code: "ArrowDown", keyCode: 40 }, metaBit),
];

/** What the locate step of the page script answers. */
const locateSchema = z
  .object({
    ok: z.literal(true),
    x: z.number().finite(),
    y: z.number().finite(),
    inside: z.boolean(),
    hit: z.boolean(),
    tag: z.string().max(40),
    role: z.string().max(40),
    kind: z.enum(["text", "choice", "check", "press", "region"]),
    name: z.string().max(300),
    disabled: z.boolean(),
    readOnly: z.boolean(),
    password: z.boolean(),
    focused: z.boolean(),
    file: z.boolean().optional(),
    inputType: z.string().max(30).optional(),
    cover: z.string().max(40).optional(),
    /** Why a pointer at the centre does not reach it, besides an element on top of it. */
    blocked: z.enum(["frame", "control", "unsure"]).optional(),
  })
  .strict();
type Located = z.infer<typeof locateSchema>;

const settleSchema = z.object({
  ok: z.literal(true),
  readyState: z.string().optional(),
  leaving: z.boolean().optional(),
  domIdleMs: z.number().finite().optional(),
  url: z.string().optional(),
});

const targetSchema = z.object({
  targetId: z.string().min(1).max(200),
  type: z.string(),
  title: z.string(),
  url: z.string(),
  openerId: z.string().optional(),
  openerFrameId: z.string().optional(),
});
const targetsSchema = z.object({ targetInfos: z.array(targetSchema) });
type Target = z.infer<typeof targetSchema>;
const processesSchema = z.object({
  processInfo: z.array(z.object({ type: z.string(), id: z.number() })),
});
interface FrameTreeNode {
  frame: {
    id: string;
    parentId?: string;
    url?: string;
    name?: string;
  };
  childFrames?: FrameTreeNode[];
}
const frameNodeSchema: z.ZodType<FrameTreeNode> = z.lazy(() =>
  z.object({
    frame: z.object({
      id: z.string().min(1).max(200),
      parentId: z.string().optional(),
      url: z.string().optional(),
      name: z.string().optional(),
    }),
    childFrames: z.array(frameNodeSchema).optional(),
  }),
);
const frameTreeSchema = z.object({
  frameTree: frameNodeSchema,
});
const historySchema = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int(), url: z.string() })),
});

const web = (url: string) => /^https?:\/\//i.test(url);
const chromeError = (url: string) => /^chrome-error:/i.test(url);
const blank = (url: string) =>
  url === "" ||
  url === "about:blank" ||
  /^[a-z]+:\/\/(newtab|new-tab-page)\/?$/i.test(url);
const frameAllowedUrl = (url: string) =>
  web(url) || blank(url) || url === "about:srcdoc";
/** A tab that the person sees: a web page, an empty one, or a browser network error page. Never settings/extensions. */
const listable = (target: Target) =>
  target.type === "page" &&
  (web(target.url) || blank(target.url) || chromeError(target.url));
const nativePickerTypes = new Set(["date", "time", "datetime-local"]);

function numbered(
  index: number,
  what = "an element from the last reading of the page",
) {
  if (!Number.isSafeInteger(index) || index < 1)
    throw new Error(`Give the number of ${what}.`);
  return index;
}
const plainText = (value: string) => oneLine(value, 100_000).toLowerCase();

export interface OwnBrowserOptions {
  /** The environment: the state folder and CLAWDTIME_OWN_BROWSER_PATH. */
  env?: Record<string, string | undefined>;
  home?: string;
  /** The profile folder. The default is `<state>/computer/browser-profile`. */
  profile?: string;
  /** The browser program. The default is the first one found. */
  executable?: string;
  /** Starts the browser with no window. Only tests do. The real start shows its window. */
  headless?: boolean;
  /** For tests: how the program starts, how the connection opens, the clock, and which processes run. */
  launch?: BrowserLauncher;
  dial?: DevToolsDial;
  clock?: BrowserClock;
  alive?: (pid: number) => boolean;
  /** The name of this computer, as the lock of a profile holds it. */
  host?: string;
  /** Whether a program file is there and may run. */
  runnable?: (path: string) => boolean;
}

/** A browser that answers, with the process number it proved. */
interface Live {
  connection: DevToolsConnection;
  pid: number;
  /** The program, when this driver started it. */
  launched: LaunchedBrowser | null;
}
interface OpenRequest {
  document: boolean;
  at: number;
  frameId?: string;
}
interface ChildWorld {
  session: string;
  contextId: number;
  documents: number;
}
interface ElementFrameRef {
  frameId: string;
  session: string;
  /** Frame IDs from main frame down to this child frame: [mainFrameId, ..., frameId]. */
  chain: string[];
  /** Owning CDP session for each frame in `chain` (parallel to `chain`). */
  sessions: string[];
}
interface FrameBox {
  offsetX: number;
  offsetY: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** One page that the driver is attached to. */
interface Tab {
  targetId: string;
  session: string;
  url: string;
  /** When a network request of the page last started or ended. */
  lastRequestAt: number;
  /** Requests that are open: whether each is a document, when it started, and its frame. */
  open: Map<string, OpenRequest>;
  /** The words of a dialog that the page shows, or null. */
  dialog: string | null;
  /** Called when a dialog opens. */
  dialogWatch: Set<() => void>;
  /** The id of the main frame of the tab, once known. */
  frame: string | null;
  /**
   * The private world of the page script in the document of the tab: its
   * execution context, "page" when the browser named none, or null before
   * the first call and after the document changed.
   */
  world: number | "page" | null;
  /** Counts the documents of the tab, so that a world made for an earlier one is never kept. */
  documents: number;
  /** Last top-level Document Network.loadingFailed errorText, cleared on new nav/load. */
  navError: string | null;
  /** True between Page.frameStartedLoading and Page.frameStoppedLoading for the main frame. */
  frameLoading: boolean;
  /** Isolated worlds cached per child frameId. */
  childWorlds: Map<string, ChildWorld>;
  /** Maps element index from the latest reading to its child frame (absent for main frame). */
  elementFrames: Map<number, ElementFrameRef>;
}
/** One input step: whether a command with an effect went out, and when it started. */
interface Step {
  sent: boolean;
  startedAt: number;
}

const runnableFile = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export class OwnBrowser implements BrowserPort {
  /** Names this driver to the page, which keeps its numbers apart from those of another driver. */
  readonly session = randomBytes(6).toString("hex");
  /** The profile folder. */
  readonly profile: string;
  private next = 1;
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  /** True once a browser that this driver used has ended. */
  private ended = false;
  private current: string | null = null;
  private readonly tabsById = new Map<string, Tab>();
  private readonly tabsBySession = new Map<string, Tab>();
  private readonly oopifsByFrameId = new Map<
    string,
    { frameId: string; session: string; parentSession: string | null }
  >();
  private readonly oopifsBySession = new Map<string, string>();
  private readonly discoveredTargets = new Map<string, Target>();
  private pendingPopup: { targetId: string; openerId: string } | null = null;
  /** The tabs of the last listing, by their number. */
  private listing: string[] | null = null;
  private readonly env: Record<string, string | undefined>;
  private readonly home: string;
  private readonly launch: BrowserLauncher;
  private readonly dial: DevToolsDial;
  private readonly clock: BrowserClock;
  private readonly alive: (pid: number) => boolean;
  private readonly host: string;
  private readonly runnable: (path: string) => boolean;

  constructor(private readonly options: OwnBrowserOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
    this.profile =
      options.profile ??
      join(
        computerDirectory(stateRoot({ env: this.env, home: this.home })),
        "browser-profile",
      );
    this.launch = options.launch ?? launchProgram;
    this.dial = options.dial ?? dialWebSocket;
    this.clock = options.clock ?? systemClock;
    this.alive = options.alive ?? processAlive;
    this.host = options.host ?? hostname();
    this.runnable = options.runnable ?? runnableFile;
  }

  /** The browser program, or why none can be used. */
  program(): { path: string; name: string } | { path: null; reason: string } {
    const named = this.options.executable ?? this.env[ownBrowserPathVariable];
    if (named) {
      let path = named;
      // An app bundle names its program inside.
      if (/\.app\/?$/.test(path))
        path = join(
          path,
          "Contents",
          "MacOS",
          basename(path).replace(/\.app\/?$/, ""),
        );
      if (!isAbsolute(path) || !this.runnable(path))
        return {
          path: null,
          reason: `${ownBrowserPathVariable} names no program that can run. Give the full path of Google Chrome, Chromium, Brave or Edge.`,
        };
      return { path, name: programName(path) };
    }
    for (const program of ownBrowserPrograms)
      for (const folder of ["/Applications", join(this.home, "Applications")]) {
        const path = join(folder, program);
        if (this.runnable(path)) return { path, name: programName(path) };
      }
    return {
      path: null,
      reason: `No browser for ClawdTime's own browser was found: install Google Chrome, or set ${ownBrowserPathVariable} to the program of Chromium, Brave or Edge.`,
    };
  }

  async doctor(): Promise<{
    ok: boolean;
    browser: string | null;
    reason: string;
  }> {
    const program = this.program();
    if (program.path === null)
      return { ok: false, browser: null, reason: program.reason };
    const folder = this.profileProblem(false);
    if (folder) return { ok: false, browser: program.name, reason: folder };
    const running = await this.answering();
    if (running === "silent")
      return {
        ok: false,
        browser: program.name,
        reason: `${me} holds its profile but does not answer on its own port: quit ${program.name} in that window, then try again.`,
      };
    return {
      ok: true,
      browser: program.name,
      reason:
        running === "answers"
          ? `${me} runs and answers on its own port, with its own profile in ${this.profile}.`
          : `It starts at the first browser step, with its own profile in ${this.profile}. Sign in to your sites there once.`,
    };
  }

  /** Opens a web address. Anything but http and https is refused. */
  async open(url: string): Promise<BrowserPage> {
    const address = webAddress(url);
    if (address.length > pageLimits.address)
      throw new Error("The address is too long to open.");
    const step: Step = { sent: false, startedAt: this.clock.now() };
    try {
      // Nothing went out yet, so the first open may start the browser.
      const live = await this.started(true);
      // An empty tab takes the address. Otherwise a new tab opens, and the
      // page that the person had stays as it is.
      const empty = (await this.targets(live)).filter((item) =>
        blank(item.url),
      );
      let target =
        empty.find((item) => item.targetId === this.current) ?? empty[0];
      if (!target) {
        const made = await live.connection.send<{ targetId?: unknown }>(
          "Target.createTarget",
          { url: "about:blank" },
          { timeoutMs: ownTiming.callMs },
        );
        if (typeof made.targetId !== "string") throw new Error(unreadable);
        target = {
          targetId: made.targetId,
          type: "page",
          title: "",
          url: "about:blank",
        };
      }
      const tab = await this.attach(live, target.targetId, target.url);
      this.current = tab.targetId;
      tab.navError = null;
      await this.activate(live, tab.targetId);
      const navigated = await this.effect<{ errorText?: unknown }>(
        step,
        tab,
        "Page.navigate",
        { url: address },
      );
      if (typeof navigated.errorText === "string" && navigated.errorText) {
        tab.navError = oneLine(navigated.errorText, 200);
        throw new Error(
          `The page did not open: ${oneLine(navigated.errorText, 120)}.`,
        );
      }
      return await this.settled(
        tab,
        ownTiming.openWaitMs,
        (page) => web(page.url) || chromeError(page.url),
        true,
        step.startedAt,
      );
    } catch (error) {
      throw this.lost(step, error);
    }
  }

  async read(): Promise<BrowserPage> {
    return this.reading(async (tab) => (await this.look(tab)).page);
  }

  async click(index: number): Promise<BrowserPage> {
    numbered(index);
    return this.input(async (tab, step) => {
      this.assertOperable(tab);
      const box = await this.located(tab, index);
      if (box.disabled) throw new Error(`${box.name} is disabled now.`);
      if (box.tag === "select")
        throw new Error(
          `${box.name} is a list of choices. Use select with the text of one choice.`,
        );
      if (box.file)
        throw new Error(
          `${box.name} is a file upload input. Clicking it opens a native file picker dialog, which ClawdTime cannot operate automatically. Ask the person to choose the file.`,
        );
      reachable(box);
      await this.press(tab, step, box);
      return this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
    });
  }

  /**
   * Sets the text of a field, chooses in a select by the text of a choice, or
   * adds the text at the end of an editable region. It clicks into the field
   * first, as a person does, unless the field has the focus. With `submit`,
   * Enter follows.
   */
  async type(
    index: number,
    text: string,
    submit: boolean,
  ): Promise<BrowserPage> {
    numbered(index);
    const said = String(text);
    if (said.length > mostText)
      throw new Error(
        "The text is too long for one step: send it in smaller parts.",
      );
    return this.input(async (tab, step) => {
      this.assertOperable(tab);
      const frameRef = tab.elementFrames.get(index);
      const askTarget = (call: PageCall) =>
        frameRef
          ? this.askInFrame(tab, frameRef.session, frameRef.frameId, call)
          : this.ask(tab, call);
      let box = await this.located(tab, index);
      takesText(box);
      const isNativePicker =
        box.tag === "input" &&
        box.inputType !== undefined &&
        nativePickerTypes.has(box.inputType);
      if (box.kind === "choice" || isNativePicker) {
        step.sent = true;
        await askTarget({ do: "type", index, text: said, submit: false });
        if (submit) await this.keys(tab, step, keyEvents("Enter"));
        return this.settled(
          tab,
          ownTiming.waitMs,
          () => true,
          false,
          step.startedAt,
        );
      }
      if (!box.focused) {
        reachable(box);
        await this.press(tab, step, box);
        box = await this.located(tab, index);
        // The field may have changed under the click.
        takesText(box);
        if (!box.focused)
          throw new Error(
            `${box.name} did not take the focus after a click. No text was typed. Read the page again.`,
          );
      }
      if (box.kind === "text") {
        await this.keys(tab, step, selectAll);
        if (said === "") await this.keys(tab, step, keyEvents("Backspace"));
      } else await this.keys(tab, step, toTheEnd);
      if (said !== "")
        await this.effect(step, tab, "Input.insertText", { text: said });
      if (submit) await this.keys(tab, step, keyEvents("Enter"));
      let page = await this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
      if (!submit && box.kind === "text" && !box.password && said.length > 0) {
        let field = page.elements.find((item) => item.index === index);
        if (field && !field.password && field.value === "") {
          // React/Vue controlled input fallback: only when Input.insertText left
          // the field empty, so masked/formatted fields are never clobbered.
          try {
            await askTarget({ do: "type", index, text: said, submit: false });
            page = await this.settled(
              tab,
              ownTiming.waitMs,
              () => true,
              false,
              step.startedAt,
            );
            field = page.elements.find((item) => item.index === index);
          } catch (fallbackError) {
            if (fallbackError instanceof DevToolsClosed) throw fallbackError;
            // Input.insertText already succeeded; swallow script fallback errors.
          }
        }
        if (field && !field.password && field.value === "")
          throw new Error(
            `${box.name} did not take that text. A number or a date field takes only its own form.`,
          );
      }
      return page;
    });
  }

  async scroll(direction: "down" | "up"): Promise<BrowserPage> {
    if (direction !== "down" && direction !== "up")
      throw new Error("A page scrolls down or up.");
    return this.input(async (tab, step) => {
      this.assertOperable(tab);
      step.sent = true;
      await this.ask(tab, { do: "scroll", direction });
      return this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
    });
  }

  async back(): Promise<BrowserPage> {
    return this.input(async (tab, step) => {
      const history = historySchema.safeParse(
        await this.command(tab, "Page.getNavigationHistory"),
      );
      if (!history.success) throw new Error(unreadable);
      const { currentIndex, entries } = history.data;
      const earlier = entries[currentIndex - 1];
      if (currentIndex < 1 || !earlier)
        throw new Error("This tab has no earlier page.");
      tab.navError = null;
      await this.effect(step, tab, "Page.navigateToHistoryEntry", {
        entryId: earlier.id,
      });
      return this.settled(
        tab,
        ownTiming.openWaitMs,
        () => true,
        true,
        step.startedAt,
      );
    });
  }

  /** Moves the pointer onto the element, with no click. */
  async hover(index: number): Promise<BrowserPage> {
    numbered(index);
    return this.input(async (tab, step) => {
      this.assertOperable(tab);
      const box = await this.located(tab, index);
      reachable(box);
      await this.effect(step, tab, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x,
        y: box.y,
        button: "none",
        buttons: 0,
      });
      return this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
    });
  }

  /**
   * Picks an option by its visible label. In a select of the page, the page
   * script picks it, and the page sees the input and change events. In a
   * list that the page draws, the list is clicked open and the option with
   * that label is clicked.
   */
  async select(index: number, option: string): Promise<BrowserPage> {
    numbered(index);
    const want = oneLine(String(option), 400);
    if (!want) throw new Error("Give the text of one choice.");
    return this.input(async (tab, step) => {
      this.assertOperable(tab);
      const frameRef = tab.elementFrames.get(index);
      const box = await this.located(tab, index);
      if (box.disabled) throw new Error(`${box.name} is disabled now.`);
      if (box.tag === "select") {
        step.sent = true;
        if (frameRef)
          await this.askInFrame(tab, frameRef.session, frameRef.frameId, {
            do: "type",
            index,
            text: want,
            submit: false,
          });
        else
          await this.ask(tab, { do: "type", index, text: want, submit: false });
        return this.settled(
          tab,
          ownTiming.waitMs,
          () => true,
          false,
          step.startedAt,
        );
      }
      if (box.role !== "listbox" && box.role !== "combobox")
        throw new Error(
          `${box.name} is not a list of choices. Click it, or type into it.`,
        );
      reachable(box);
      await this.press(tab, step, box);
      const opened = await this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
      const choices = opened.elements.filter(
        (item) =>
          (item.role === "option" || item.role === "menuitem") &&
          !item.disabled &&
          plainText(item.label) === want.toLowerCase(),
      );
      if (choices.length !== 1)
        throw new Error(
          `${box.name} opened, and ${choices.length ? "more than one choice has" : "no choice has"} that text. Read the page again.`,
        );
      const choice = await this.located(tab, choices[0]!.index);
      reachable(choice);
      await this.press(tab, step, choice);
      return this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
    });
  }

  /**
   * One key or combo in the page: it goes to the element with the focus. The
   * page script says first where the focus is: in a password field or in an
   * unverified frame, no key is pressed.
   */
  async key(combo: string): Promise<BrowserPage> {
    const events = keyEvents(combo);
    return this.input(async (tab, step) => {
      this.assertOperable(tab);
      if ((await this.world(tab)) === "page")
        throw new Error(
          "This browser gave no private world for the check before a key, so nothing was sent. Read the page again, or use the screen.",
        );
      try {
        await this.ask(tab, { do: "focus" });
      } catch (error) {
        if (
          error instanceof Error &&
          /focus is in a frame of the page/i.test(error.message)
        ) {
          await this.verifyFocusedFrameChain(tab, error);
        } else {
          throw error;
        }
      }
      await this.keys(tab, step, events);
      return this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
    });
  }

  /**
   * Reads the page until its visible text holds `text`, or until `ms`
   * passes. With no text, it waits `ms`, then reads. It has no effect.
   */
  async waitFor(text: string | null, ms: number): Promise<BrowserPage> {
    const span = Math.min(
      ownTiming.waitForMs,
      Math.max(0, Number.isFinite(ms) ? Math.round(ms) : 0),
    );
    const want = text === null ? "" : plainText(text);
    if (!want) {
      await this.clock.sleep(span);
      return this.read();
    }
    const from = this.clock.now();
    let failed: unknown = null;
    let last: BrowserPage | null = null;
    for (;;) {
      try {
        last = await this.read();
        failed = null;
        if (plainText(last.text).includes(want))
          return { ...last, found: true };
      } catch (error) {
        last = null;
        failed = error;
      }
      const left = from + span - this.clock.now();
      if (left <= 0) break;
      await this.clock.sleep(Math.min(ownTiming.waitForEveryMs, left));
    }
    if (last) return { ...last, found: false };
    throw failed;
  }

  /** The page of the active tab, with the tabs of the browser. */
  async tabs(): Promise<BrowserPage> {
    return this.reading(async (tab, live) => {
      const pages = (await this.targets(live)).slice(0, mostTabs);
      this.listing = pages.map((target) => target.targetId);
      const tabs: BrowserTab[] = pages.map((target, at) => ({
        index: at + 1,
        title: oneLine(target.title, pageLimits.title),
        url: oneLine(target.url, pageLimits.address),
        active: target.targetId === tab.targetId,
      }));
      return { ...(await this.look(tab)).page, tabs };
    });
  }

  /** Brings a tab of the last listing to the front, and reads it. */
  async switchTab(number: number): Promise<BrowserPage> {
    numbered(number, "a tab from the last list of tabs");
    return this.input(async (_tab, step) => {
      const live = this.live!;
      const targetId = this.listing?.[number - 1];
      if (!targetId)
        throw new Error("Give the number of a tab from the last list of tabs.");
      const target = (await this.targets(live)).find(
        (item) => item.targetId === targetId,
      );
      if (!target)
        throw new Error(
          `Tab ${number} is not open any more. List the tabs again.`,
        );
      step.sent = true;
      await this.activate(live, targetId);
      this.current = targetId;
      const tab = await this.attach(live, targetId, target.url);
      return this.settled(
        tab,
        ownTiming.waitMs,
        () => true,
        false,
        step.startedAt,
      );
    });
  }

  /** Closes the browser at service stop, so that no control port stays open. */
  async close(): Promise<void> {
    const live = this.live ?? (await this.starting?.catch(() => null)) ?? null;
    this.forget();
    if (!live) return;
    if (!live.connection.closed)
      try {
        await live.connection.send(
          "Browser.close",
          {},
          { timeoutMs: ownTiming.closeMs },
        );
      } catch {
        // It may close before it answers.
      }
    // The browser closes its control port first, and its program ends a
    // little later, by itself. A program that this driver started and that
    // keeps its port open is ended.
    const until = this.clock.now() + ownTiming.closeMs;
    while (
      !live.connection.closed &&
      !live.launched?.exited() &&
      this.clock.now() < until
    )
      await this.clock.sleep(ownTiming.pollMs);
    if (!live.connection.closed && live.launched && !live.launched.exited())
      live.launched.kill();
    live.connection.close();
  }

  // The browser, started or found.

  /**
   * The browser that answers. Only a step with no effect, or an open before
   * anything went out, may start it.
   */
  private async started(mayStart: boolean): Promise<Live> {
    const live = this.live;
    if (live && !live.connection.closed) return live;
    if (live) this.forget(true);
    if (!mayStart) throw new Error(this.ended ? endedNothingSent : notOpen);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Live> {
    const program = this.program();
    if (program.path === null) throw new BrowserClosed(program.reason);
    const folder = this.profileProblem(true);
    if (folder) throw new BrowserClosed(folder);
    const earlier = await this.earlier();
    if (earlier) return this.adopt(earlier);
    const portFile = join(this.profile, "DevToolsActivePort");
    // What an earlier start left there names no browser that runs now.
    try {
      unlinkSync(portFile);
    } catch {
      // There was none.
    }
    const args = [
      `--user-data-dir=${this.profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      ...(this.options.headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    const launched = this.launch(program.path, args);
    if (!launched.pid)
      throw new Error(`${program.name} did not start as ClawdTime's browser.`);
    const until = this.clock.now() + ownTiming.startMs;
    let port: { port: number; path: string } | null = null;
    for (;;) {
      port = this.portFile();
      if (port) break;
      if (launched.exited())
        throw new Error(
          `${program.name} ended as it started. When ${program.name} runs with ClawdTime's profile in another program, quit it there, then try again.`,
        );
      if (this.clock.now() >= until) {
        launched.kill();
        throw new Error(
          `${program.name} did not open its control port in time.`,
        );
      }
      await this.clock.sleep(ownTiming.pollMs);
    }
    let connection: DevToolsConnection;
    try {
      connection = await DevToolsConnection.open(
        browserEndpoint(port.port, port.path),
        this.dial,
        ownTiming.callMs,
      );
    } catch (error) {
      launched.kill();
      throw error;
    }
    if (!(await this.proven(connection, launched.pid))) {
      connection.close();
      launched.kill();
      throw new Error(
        `The program on the control port of ${me} is not the browser that ClawdTime started. Nothing was sent.`,
      );
    }
    return this.adopt({ connection, pid: launched.pid, launched });
  }

  /** A browser of an earlier start that holds this profile and answers, or null when none runs. */
  private async earlier(): Promise<Live | null> {
    const pid = this.lockHolder();
    if (pid === null) return null;
    const port = this.portFile();
    const connection = port
      ? await DevToolsConnection.open(
          browserEndpoint(port.port, port.path),
          this.dial,
          ownTiming.callMs,
        ).catch(() => null)
      : null;
    if (connection && (await this.proven(connection, pid)))
      return { connection, pid, launched: null };
    connection?.close();
    throw new Error(
      `${me} runs from an earlier start but does not answer on its own port: quit it in its window, then try again.`,
    );
  }

  /** Whether the browser on the connection runs as this process. */
  private async proven(connection: DevToolsConnection, pid: number) {
    try {
      const info = processesSchema.safeParse(
        await connection.send(
          "SystemInfo.getProcessInfo",
          {},
          {
            timeoutMs: ownTiming.callMs,
          },
        ),
      );
      if (!info.success) return false;
      const browsers = info.data.processInfo.filter(
        (item) => item.type === "browser",
      );
      return browsers.length === 1 && browsers[0]!.id === pid;
    } catch {
      return false;
    }
  }

  private adopt(live: Live): Live {
    this.live = live;
    this.listing = null;
    const { connection } = live;
    const tabOf = (session?: string) =>
      session ? this.tabsBySession.get(session) : undefined;
    connection.on("Network.requestWillBeSent", (params, session) => {
      const tab = tabOf(session);
      if (!tab || typeof params.requestId !== "string") return;
      // Ignore streaming, media, beacon/ping, manifest, and worker requests.
      if (
        (typeof params.type === "string" &&
          ignoredNetworkTypes.has(params.type)) ||
        params.loaderId === ""
      )
        return;
      const now = this.clock.now();
      tab.lastRequestAt = now;
      const isDocument = params.type === "Document";
      const frameId =
        typeof params.frameId === "string" ? params.frameId : undefined;
      if (isDocument && (!frameId || !tab.frame || frameId === tab.frame)) {
        tab.navError = null;
      }
      tab.open.set(params.requestId, {
        document: isDocument,
        at: now,
        ...(frameId ? { frameId } : {}),
      });
    });
    connection.on("Network.loadingFinished", (params, session) => {
      const tab = tabOf(session);
      if (!tab || typeof params.requestId !== "string") return;
      const tracked = tab.open.get(params.requestId);
      if (!tracked) return;
      // An answer may lead the page to ask for more: the quiet starts again.
      tab.lastRequestAt = this.clock.now();
      tab.open.delete(params.requestId);
      if (
        tracked.document &&
        (!tracked.frameId || !tab.frame || tracked.frameId === tab.frame)
      ) {
        tab.navError = null;
      }
    });
    connection.on("Network.loadingFailed", (params, session) => {
      const tab = tabOf(session);
      if (!tab || typeof params.requestId !== "string") return;
      const tracked = tab.open.get(params.requestId);
      if (tracked) {
        tab.lastRequestAt = this.clock.now();
        tab.open.delete(params.requestId);
      }
      const paramFrameId =
        typeof params.frameId === "string" ? params.frameId : undefined;
      const isMainDoc =
        tracked !== undefined &&
        tracked.document === true &&
        tab.frame !== null &&
        tracked.frameId === tab.frame &&
        (paramFrameId === undefined || paramFrameId === tab.frame);
      const errorText =
        typeof params.errorText === "string" ? params.errorText.trim() : "";
      if (
        isMainDoc &&
        params.canceled !== true &&
        errorText !== "" &&
        errorText !== "net::ERR_ABORTED"
      ) {
        tab.navError = oneLine(errorText, 200);
      }
    });
    connection.on("Page.frameStartedLoading", (params, session) => {
      const tab = tabOf(session);
      if (!tab) return;
      const frameId =
        typeof params.frameId === "string" ? params.frameId : undefined;
      if (!frameId || !tab.frame || frameId === tab.frame) {
        tab.frameLoading = true;
      }
    });
    connection.on("Page.frameStoppedLoading", (params, session) => {
      const tab = tabOf(session);
      if (!tab) return;
      const frameId =
        typeof params.frameId === "string" ? params.frameId : undefined;
      if (!frameId || !tab.frame || frameId === tab.frame) {
        tab.frameLoading = false;
      }
      for (const [id, req] of tab.open) {
        if (
          req.document &&
          (!frameId || !req.frameId || req.frameId === frameId)
        ) {
          tab.open.delete(id);
        }
      }
    });
    connection.on("Page.frameDetached", (params, session) => {
      const tab = tabOf(session);
      if (!tab) return;
      const frameId =
        typeof params.frameId === "string" ? params.frameId : undefined;
      if (params.reason === "swap") {
        // OOPIF / process swap: clear stale in-flight requests so settle never hangs.
        for (const [id, req] of tab.open) {
          if (!frameId || !req.frameId || req.frameId === frameId) {
            tab.open.delete(id);
          }
        }
        tab.lastRequestAt = Math.min(
          tab.lastRequestAt,
          this.clock.now() - ownTiming.quietMs,
        );
        if (!frameId || !tab.frame || frameId === tab.frame) {
          tab.frameLoading = false;
        }
      } else if (frameId) {
        for (const [id, req] of tab.open) {
          if (req.frameId === frameId) tab.open.delete(id);
        }
      }
      if (frameId) tab.childWorlds.delete(frameId);
    });
    connection.on("Page.javascriptDialogOpening", (params, session) => {
      const tab = tabOf(session);
      if (!tab) return;
      tab.dialog = oneLine(params.message, 200);
      for (const watch of [...tab.dialogWatch]) watch();
    });
    connection.on("Page.javascriptDialogClosed", (_params, session) => {
      const tab = tabOf(session);
      if (tab) tab.dialog = null;
    });
    // A new document in the main frame: the private world went with the old one.
    connection.on("Page.frameNavigated", (params, session) => {
      const tab = tabOf(session);
      const frame = params.frame;
      if (!tab || typeof frame !== "object" || frame === null) return;
      const frameRec = frame as {
        id?: unknown;
        parentId?: unknown;
        url?: unknown;
        unreachableUrl?: unknown;
      };
      if (frameRec.parentId !== undefined) {
        if (typeof frameRec.id === "string")
          tab.childWorlds.delete(frameRec.id);
        return;
      }
      tab.documents += 1;
      tab.world = null;
      tab.childWorlds.clear();
      tab.elementFrames.clear();
      if (typeof frameRec.id === "string") tab.frame = frameRec.id;
      const navUrl = typeof frameRec.url === "string" ? frameRec.url : "";
      if (navUrl) tab.url = navUrl;
      if (
        web(navUrl) &&
        !chromeError(navUrl) &&
        typeof frameRec.unreachableUrl !== "string"
      ) {
        tab.navError = null;
      }
    });
    connection.on("Target.targetCreated", (params) => {
      const parsed = targetSchema.safeParse(params.targetInfo);
      if (!parsed.success || parsed.data.type !== "page") return;
      const info = parsed.data;
      this.discoveredTargets.set(info.targetId, info);
      const activeTab = this.current
        ? this.tabsById.get(this.current)
        : undefined;
      const openedByActive =
        (info.openerId !== undefined && info.openerId === this.current) ||
        (info.openerFrameId !== undefined &&
          activeTab !== undefined &&
          (info.openerFrameId === activeTab.frame ||
            activeTab.childWorlds.has(info.openerFrameId)));
      if (openedByActive && this.current) {
        this.pendingPopup = { targetId: info.targetId, openerId: this.current };
      }
    });
    connection.on("Target.targetInfoChanged", (params) => {
      const parsed = targetSchema.safeParse(params.targetInfo);
      if (!parsed.success || parsed.data.type !== "page") return;
      const info = parsed.data;
      if (this.discoveredTargets.has(info.targetId)) {
        this.discoveredTargets.set(info.targetId, info);
      }
      const existing = this.tabsById.get(info.targetId);
      if (existing && (!chromeError(existing.url) || chromeError(info.url)))
        existing.url = info.url;
    });
    connection.on("Target.targetDestroyed", (params) => {
      if (typeof params.targetId !== "string") return;
      this.discoveredTargets.delete(params.targetId);
      if (this.pendingPopup?.targetId === params.targetId) {
        this.pendingPopup = null;
      }
      const tab = this.tabsById.get(params.targetId);
      if (tab) {
        this.tabsById.delete(tab.targetId);
        this.tabsBySession.delete(tab.session);
      }
    });
    connection.on("Target.attachedToTarget", (params, parentSession) => {
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : null;
      const info =
        typeof params.targetInfo === "object" && params.targetInfo !== null
          ? (params.targetInfo as Record<string, unknown>)
          : null;
      if (!sessionId || !info) return;
      const targetId = typeof info.targetId === "string" ? info.targetId : null;
      if (info.type === "iframe" && targetId) {
        this.oopifsByFrameId.set(targetId, {
          frameId: targetId,
          session: sessionId,
          parentSession: parentSession ?? null,
        });
        this.oopifsBySession.set(sessionId, targetId);
        void connection
          .send(
            "Page.enable",
            {},
            { session: sessionId, timeoutMs: ownTiming.callMs },
          )
          .catch(() => {});
        void connection
          .send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            { session: sessionId, timeoutMs: ownTiming.callMs },
          )
          .catch(() => {});
      }
    });
    connection.on("Target.detachedFromTarget", (params) => {
      if (typeof params.sessionId !== "string") return;
      const oopifFrame = this.oopifsBySession.get(params.sessionId);
      if (oopifFrame) {
        this.oopifsBySession.delete(params.sessionId);
        if (
          this.oopifsByFrameId.get(oopifFrame)?.session === params.sessionId
        ) {
          this.oopifsByFrameId.delete(oopifFrame);
        }
      }
      const tab = this.tabsBySession.get(params.sessionId);
      if (!tab) return;
      this.tabsBySession.delete(tab.session);
      this.tabsById.delete(tab.targetId);
    });
    connection.onClose(() => {
      if (this.live === live) this.forget(true);
    });
    void connection
      .send(
        "Target.setDiscoverTargets",
        { discover: true },
        { timeoutMs: ownTiming.callMs },
      )
      .catch(() => {});
    return live;
  }

  /** Lets go of the browser. `ended` marks a browser that closed by itself. */
  private forget(ended = false) {
    if (ended) this.ended = true;
    this.live = null;
    this.current = null;
    this.listing = null;
    this.pendingPopup = null;
    this.tabsById.clear();
    this.tabsBySession.clear();
    this.oopifsByFrameId.clear();
    this.oopifsBySession.clear();
    this.discoveredTargets.clear();
  }

  /** The process that holds the lock of this profile, on this computer, when it runs. */
  private lockHolder(): number | null {
    let said: string;
    try {
      said = readlinkSync(join(this.profile, "SingletonLock"));
    } catch {
      return null;
    }
    const match = /^(.+)-(\d+)$/.exec(said);
    if (!match || match[1] !== this.host) return null;
    const pid = Number(match[2]);
    return Number.isSafeInteger(pid) && pid > 0 && this.alive(pid) ? pid : null;
  }

  private portFile() {
    try {
      return readActivePort(
        readFileSync(join(this.profile, "DevToolsActivePort"), "utf8"),
      );
    } catch {
      return null;
    }
  }

  /** Whether a browser answers now: one that this driver uses, or one of an earlier start. It starts none. */
  private async answering(): Promise<"answers" | "silent" | "none"> {
    const live = this.live;
    if (live && !live.connection.closed) {
      try {
        await live.connection.send(
          "Browser.getVersion",
          {},
          {
            timeoutMs: ownTiming.callMs,
          },
        );
        return "answers";
      } catch {
        return "silent";
      }
    }
    if (!existsSync(this.profile)) return "none";
    try {
      const earlier = await this.earlier();
      if (!earlier) return "none";
      earlier.connection.close();
      return "answers";
    } catch {
      return "silent";
    }
  }

  /**
   * Why the profile folder cannot be used, or null. With `make`, a missing
   * folder is made, for its owner only. Without it, nothing is written.
   */
  private profileProblem(make: boolean): string | null {
    const folder = this.profile;
    if (!existsSync(folder)) {
      if (!make) {
        let parent = dirname(folder);
        while (!existsSync(parent) && dirname(parent) !== parent)
          parent = dirname(parent);
        try {
          accessSync(parent, constants.W_OK);
          return null;
        } catch {
          return `The profile folder ${folder} cannot be made: ${parent} cannot be written.`;
        }
      }
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
      } catch {
        return `The profile folder ${folder} cannot be made.`;
      }
    }
    try {
      const stat = lstatSync(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return `The profile folder ${folder} is not a plain folder.`;
      if ((stat.mode & 0o077) !== 0)
        return `The profile folder ${folder} is open to other users. Run: chmod 700 ${folder}`;
      accessSync(folder, constants.W_OK);
      return null;
    } catch {
      return `The profile folder ${folder} cannot be written.`;
    }
  }

  // Tabs and sessions.

  private async targets(live: Live): Promise<Target[]> {
    const listed = targetsSchema.safeParse(
      await live.connection.send(
        "Target.getTargets",
        {},
        {
          timeoutMs: ownTiming.callMs,
        },
      ),
    );
    if (!listed.success) throw new Error(unreadable);
    const result = listed.data.targetInfos.filter(listable);
    const seen = new Set(result.map((item) => item.targetId));
    for (const target of this.discoveredTargets.values()) {
      if (!seen.has(target.targetId) && listable(target)) {
        result.push(target);
        seen.add(target.targetId);
      }
    }
    return result;
  }

  /** The tab that the driver works in, attached. Only a read may make one when none is there. */
  private async tab(mayStart: boolean): Promise<Tab> {
    const live = await this.started(mayStart);
    const all = targetsSchema.safeParse(
      await live.connection.send(
        "Target.getTargets",
        {},
        {
          timeoutMs: ownTiming.callMs,
        },
      ),
    );
    if (!all.success) throw new Error(unreadable);
    const pages = all.data.targetInfos.filter((item) => item.type === "page");
    const seen = new Set(pages.map((item) => item.targetId));
    for (const target of this.discoveredTargets.values()) {
      if (!seen.has(target.targetId)) {
        pages.push(target);
        seen.add(target.targetId);
      }
    }
    let target =
      pages.find((item) => item.targetId === this.current) ??
      pages.find(listable);
    if (!target) {
      if (!mayStart)
        throw new Error(`${me} has no tab open. Nothing was sent.`);
      const made = await live.connection.send<{ targetId?: unknown }>(
        "Target.createTarget",
        { url: "about:blank" },
        { timeoutMs: ownTiming.callMs },
      );
      if (typeof made.targetId !== "string") throw new Error(unreadable);
      target = {
        targetId: made.targetId,
        type: "page",
        title: "",
        url: "about:blank",
      };
    }
    if (!listable(target)) throw new Error(ownPage);
    this.current = target.targetId;
    return this.attach(live, target.targetId, target.url);
  }

  private async attach(
    live: Live,
    targetId: string,
    url: string,
  ): Promise<Tab> {
    const known = this.tabsById.get(targetId);
    if (known) {
      if (!chromeError(known.url) || chromeError(url)) known.url = url;
      return known;
    }
    const attached = await live.connection.send<{ sessionId?: unknown }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
      { timeoutMs: ownTiming.callMs },
    );
    if (typeof attached.sessionId !== "string") throw new Error(unreadable);
    const tab: Tab = {
      targetId,
      session: attached.sessionId,
      url,
      lastRequestAt: Number.NEGATIVE_INFINITY,
      open: new Map(),
      dialog: null,
      dialogWatch: new Set(),
      frame: null,
      world: null,
      documents: 0,
      navError: null,
      frameLoading: false,
      childWorlds: new Map(),
      elementFrames: new Map(),
    };
    this.tabsById.set(targetId, tab);
    this.tabsBySession.set(tab.session, tab);
    await Promise.all([
      this.command(tab, "Page.enable"),
      this.command(tab, "Network.enable"),
    ]);
    await this.mainFrame(tab).catch(() => {});
    await this.command(tab, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => {});
    return tab;
  }

  private async activate(live: Live, targetId: string) {
    await live.connection.send(
      "Target.activateTarget",
      { targetId },
      {
        timeoutMs: ownTiming.callMs,
      },
    );
  }

  // Steps.

  /** A step with no effect. When the browser ended, it starts again, once. */
  private async reading<T>(run: (tab: Tab, live: Live) => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        const tab = await this.tab(true);
        return await run(tab, this.live!);
      } catch (error) {
        if (attempt === 0 && error instanceof DevToolsClosed) continue;
        throw error;
      }
    }
  }

  /** A step with an effect. It never starts the browser and never sends anything twice. */
  private async input(run: (tab: Tab, step: Step) => Promise<BrowserPage>) {
    const step: Step = { sent: false, startedAt: this.clock.now() };
    this.pendingPopup = null;
    try {
      return await run(await this.tab(false), step);
    } catch (error) {
      throw this.lost(step, error);
    }
  }

  /** Refuses input on chrome-error: warning pages and any non-web/non-blank browser page. */
  private assertOperable(tab: Tab) {
    if (chromeError(tab.url) || (!web(tab.url) && !blank(tab.url))) {
      throw new Error(ownPage);
    }
  }

  /**
   * The error to tell, when the connection closed during a step. Once an
   * input went out, its result is not known.
   */
  private lost(step: Step, error: unknown) {
    if (error instanceof BrowserInputUnknown) return error;
    if (!(error instanceof DevToolsClosed)) return error;
    return step.sent
      ? new BrowserInputUnknown(lostInput)
      : new Error(endedNothingSent);
  }

  private commandSession<T = Record<string, unknown>>(
    session: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = ownTiming.callMs,
  ) {
    const live = this.live;
    if (!live)
      return Promise.reject(new DevToolsClosed(endedNothingSent, false));
    return live.connection.send<T>(method, params, {
      session,
      timeoutMs,
    });
  }

  private command<T = Record<string, unknown>>(
    tab: Tab,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = ownTiming.callMs,
  ) {
    return this.commandSession<T>(tab.session, method, params, timeoutMs);
  }

  /**
   * One command with an effect. From here on the step counts as sent. A
   * dialog that the page opens ends the wait for the answer: the page waits
   * for the person then.
   */
  private async effect<T = Record<string, unknown>>(
    step: Step,
    tab: Tab,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (tab.dialog !== null) throw new Error(dialogText(tab.dialog));
    step.sent = true;
    let stop = () => {};
    const dialog = new Promise<never>((_resolve, reject) => {
      const watch = () => reject(new Error(dialogText(tab.dialog ?? "")));
      tab.dialogWatch.add(watch);
      stop = () => tab.dialogWatch.delete(watch);
    });
    try {
      return await Promise.race([
        this.command<T>(tab, method, params, ownTiming.inputMs),
        dialog,
      ]);
    } catch (error) {
      // The command went out and no answer came: it may have happened.
      if (error instanceof DevToolsTimeout)
        throw new BrowserInputUnknown(
          `${me} did not answer an input in time. Its result is not known, and it is not sent again. Read the page to see what happened.`,
        );
      throw error;
    } finally {
      stop();
    }
  }

  /** A click of the left button at the centre of the element. */
  private async press(tab: Tab, step: Step, box: Located) {
    const at = { x: box.x, y: box.y };
    await this.effect(step, tab, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...at,
      button: "none",
      buttons: 0,
    });
    await this.effect(step, tab, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...at,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.effect(step, tab, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...at,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  private async keys(tab: Tab, step: Step, events: KeyEvent[]) {
    for (const event of events)
      await this.effect(step, tab, "Input.dispatchKeyEvent", { ...event });
  }

  /** The id of the main frame of the tab. */
  private async mainFrame(tab: Tab): Promise<string> {
    if (tab.frame !== null) return tab.frame;
    const tree = frameTreeSchema.safeParse(
      await this.command(tab, "Page.getFrameTree"),
    );
    // The main frame of a page has the id of its target.
    tab.frame = tree.success ? tree.data.frameTree.frame.id : tab.targetId;
    return tab.frame;
  }

  /**
   * The private world of the page script in the document of the tab, made
   * once for each document. A world made while the document changed is not
   * kept: it may belong to the one before.
   */
  private async world(tab: Tab): Promise<number | "page"> {
    for (let attempt = 0; ; attempt++) {
      if (tab.world !== null) return tab.world;
      if (attempt === 2) throw new Error(changing);
      const documents = tab.documents;
      const frameId = await this.mainFrame(tab);
      const made = await this.command<{ executionContextId?: unknown }>(
        tab,
        "Page.createIsolatedWorld",
        { frameId, worldName },
      );
      if (tab.documents !== documents) continue;
      const id = made.executionContextId;
      // Every browser of the family names the world. One on paper may not:
      // the script then runs in the page's world, and its own checks still
      // refuse a hit test that the page replaced.
      tab.world =
        typeof id === "number" && Number.isSafeInteger(id) ? id : "page";
    }
  }

  /** Runs the page script once and gives back its answer as text. */
  private async evaluate(tab: Tab, call: PageCall): Promise<string> {
    if (tab.dialog !== null) throw new Error(dialogText(tab.dialog));
    const expression = pageScript(call, {
      session: this.session,
      start: this.next,
    });
    for (let attempt = 0; ; attempt++) {
      const world = await this.world(tab);
      let result: { result?: { value?: unknown }; exceptionDetails?: unknown };
      try {
        result = await this.command(tab, "Runtime.evaluate", {
          expression,
          returnByValue: true,
          silent: true,
          includeCommandLineAPI: false,
          ...(world === "page" ? {} : { contextId: world }),
        });
      } catch (error) {
        // The document changed and its world went with it: the script did
        // not start, so it runs once in the world of the new document.
        if (
          attempt === 0 &&
          world !== "page" &&
          error instanceof DevToolsError &&
          /cannot find context with specified id/i.test(error.message)
        ) {
          if (tab.world === world) tab.world = null;
          continue;
        }
        throw error;
      }
      if (
        result.exceptionDetails !== undefined ||
        typeof result.result?.value !== "string"
      )
        throw new Error(unreadable);
      return result.result.value;
    }
  }

  /** One call into the page. It throws the reason when the page refuses. */
  private async ask(tab: Tab, call: PageCall) {
    const answer = parsePageAnswer(await this.evaluate(tab, call));
    if (!answer) throw new Error(unreadable);
    if (!answer.ok) throw new Error(oneLine(answer.error, 300));
    if (answer.next !== undefined) this.next = Math.max(this.next, answer.next);
    return answer;
  }

  /**
   * Creates or reuses an isolated world for a child frame on its owning CDP session.
   * Never falls back to "page" (the top-level world): returns null if no isolated world can be created.
   */
  private async childWorld(
    tab: Tab,
    session: string,
    frameId: string,
  ): Promise<number | null> {
    const cached = tab.childWorlds.get(frameId);
    if (
      cached &&
      cached.session === session &&
      cached.documents === tab.documents
    ) {
      return cached.contextId;
    }
    try {
      const made = await this.commandSession<{ executionContextId?: unknown }>(
        session,
        "Page.createIsolatedWorld",
        { frameId, worldName },
      );
      const id = made.executionContextId;
      if (typeof id === "number" && Number.isSafeInteger(id)) {
        tab.childWorlds.set(frameId, {
          session,
          contextId: id,
          documents: tab.documents,
        });
        return id;
      }
      return null;
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
      return null;
    }
  }

  /** Runs the page script inside a child frame's isolated world. */
  private async evaluateInFrame(
    tab: Tab,
    session: string,
    frameId: string,
    call: PageCall,
  ): Promise<string> {
    if (tab.dialog !== null) throw new Error(dialogText(tab.dialog));
    const expression = pageScript(call, {
      session: this.session,
      start: this.next,
    });
    for (let attempt = 0; ; attempt++) {
      const world = await this.childWorld(tab, session, frameId);
      if (world === null)
        throw new Error(
          "This browser gave no private world for the child frame, so nothing was sent.",
        );
      let result: { result?: { value?: unknown }; exceptionDetails?: unknown };
      try {
        result = await this.commandSession(session, "Runtime.evaluate", {
          expression,
          returnByValue: true,
          silent: true,
          includeCommandLineAPI: false,
          contextId: world,
        });
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof DevToolsError &&
          /cannot find context with specified id/i.test(error.message)
        ) {
          tab.childWorlds.delete(frameId);
          continue;
        }
        throw error;
      }
      if (
        result.exceptionDetails !== undefined ||
        typeof result.result?.value !== "string"
      )
        throw new Error(unreadable);
      return result.result.value;
    }
  }

  private async askInFrame(
    tab: Tab,
    session: string,
    frameId: string,
    call: PageCall,
  ) {
    const answer = parsePageAnswer(
      await this.evaluateInFrame(tab, session, frameId, call),
    );
    if (!answer) throw new Error(unreadable);
    if (!answer.ok) throw new Error(oneLine(answer.error, 300));
    if (answer.next !== undefined) this.next = Math.max(this.next, answer.next);
    return answer;
  }

  private findFrameNode(
    root: FrameTreeNode,
    frameId: string,
  ): FrameTreeNode | null {
    if (root.frame.id === frameId) return root;
    for (const child of root.childFrames ?? []) {
      const found = this.findFrameNode(child, frameId);
      if (found) return found;
    }
    return null;
  }

  /**
   * Resolves the exact direct child frame whose <iframe>/<frame> element owns
   * focus inside (session, frameId, world). Returns null if focus cannot be
   * deterministically mapped to a direct child frame.
   */
  private async resolveFocusedChildFrame(
    session: string,
    frameId: string,
    world: number,
  ): Promise<{ frameId: string; url: string } | null> {
    let treeRaw: unknown;
    try {
      treeRaw = await this.commandSession(session, "Page.getFrameTree");
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
      return null;
    }
    const parsed = frameTreeSchema.safeParse(treeRaw);
    if (!parsed.success) return null;
    const node = this.findFrameNode(parsed.data.frameTree, frameId);
    const directChildren = node?.childFrames ?? [];
    if (directChildren.length === 0) return null;

    let objectId: string | null = null;
    try {
      const evalRes = await this.commandSession<{
        result?: { objectId?: unknown };
        exceptionDetails?: unknown;
      }>(session, "Runtime.evaluate", {
        expression: `(function () {
          if (typeof document.hasFocus === "function" && !document.hasFocus()) return null;
          var active = document.activeElement;
          for (var d = 0; active && active.shadowRoot && active.shadowRoot.activeElement && d < 30; d++) {
            active = active.shadowRoot.activeElement;
          }
          if (!active) return null;
          var tag = String(active.localName || "").toLowerCase();
          if (tag !== "iframe" && tag !== "frame") return null;
          return active;
        })()`,
        returnByValue: false,
        silent: true,
        includeCommandLineAPI: false,
        contextId: world,
      });
      if (
        evalRes.exceptionDetails === undefined &&
        typeof evalRes.result?.objectId === "string" &&
        evalRes.result.objectId
      ) {
        objectId = evalRes.result.objectId;
      }
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
      return null;
    }

    if (!objectId) return null;

    try {
      const described = await this.commandSession<{
        node?: { frameId?: unknown };
      }>(session, "DOM.describeNode", { objectId });
      const matchedId = described.node?.frameId;
      if (typeof matchedId === "string" && matchedId && matchedId !== frameId) {
        const childNode = directChildren.find((c) => c.frame.id === matchedId);
        if (childNode) {
          return {
            frameId: childNode.frame.id,
            url: childNode.frame.url ?? "",
          };
        }
        // Focused element belongs to an unlisted/unknown frame: refuse.
        return null;
      }
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
    } finally {
      void this.commandSession(session, "Runtime.releaseObject", {
        objectId,
      }).catch(() => {});
    }

    // Fallback when DOM.describeNode does not provide the owned child frameId:
    // match direct children by resolving each owner element in `world` and
    // checking strict identity with activeElement.
    for (const childNode of directChildren) {
      try {
        const owner = await this.commandSession<{ backendNodeId?: unknown }>(
          session,
          "DOM.getFrameOwner",
          { frameId: childNode.frame.id },
        );
        const backendNodeId = owner.backendNodeId;
        if (
          typeof backendNodeId !== "number" ||
          !Number.isSafeInteger(backendNodeId)
        )
          continue;
        const resolved = await this.commandSession<{
          object?: { objectId?: unknown };
        }>(session, "DOM.resolveNode", {
          backendNodeId,
          executionContextId: world,
        });
        const ownerObjId = resolved.object?.objectId;
        if (typeof ownerObjId !== "string" || !ownerObjId) continue;
        try {
          const check = await this.commandSession<{
            result?: { value?: unknown };
          }>(session, "Runtime.callFunctionOn", {
            objectId: ownerObjId,
            returnByValue: true,
            silent: true,
            functionDeclaration: `function () {
              if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
              var active = document.activeElement;
              for (var d = 0; active && active.shadowRoot && active.shadowRoot.activeElement && d < 30; d++) {
                active = active.shadowRoot.activeElement;
              }
              return active === this;
            }`,
          });
          if (check.result?.value === true) {
            return {
              frameId: childNode.frame.id,
              url: childNode.frame.url ?? "",
            };
          }
        } finally {
          void this.commandSession(session, "Runtime.releaseObject", {
            objectId: ownerObjId,
          }).catch(() => {});
        }
      } catch (error) {
        if (error instanceof DevToolsClosed) throw error;
      }
    }
    return null;
  }

  /**
   * Deterministically walks DOWN the focused frame chain from the top frame
   * to the leaf frame that actually owns focus, running focusCheck ONLY in that
   * leaf frame. Refuses on any unresolved/unlisted/blocked frame or error.
   */
  private async verifyFocusedFrameChain(
    tab: Tab,
    frameError: Error,
  ): Promise<void> {
    const maxDepth = 10;
    let currentSession = tab.session;
    let currentFrameId = await this.mainFrame(tab);
    const topWorld = await this.world(tab);
    if (topWorld === "page") throw frameError;
    let currentWorld: number = topWorld;

    for (let depth = 0; depth < maxDepth; depth++) {
      const child = await this.resolveFocusedChildFrame(
        currentSession,
        currentFrameId,
        currentWorld,
      );
      if (!child || !frameAllowedUrl(child.url)) throw frameError;

      const nextSession =
        this.oopifsByFrameId.get(child.frameId)?.session ?? currentSession;
      const nextWorld = await this.childWorld(tab, nextSession, child.frameId);
      if (nextWorld === null) throw frameError;

      try {
        await this.askInFrame(tab, nextSession, child.frameId, {
          do: "focus",
          child: true,
        });
        return;
      } catch (innerError) {
        if (innerError instanceof DevToolsClosed) throw innerError;
        if (
          innerError instanceof Error &&
          /password field/i.test(innerError.message)
        ) {
          throw innerError;
        }
        if (
          innerError instanceof Error &&
          /focus is in a frame of the page/i.test(innerError.message)
        ) {
          currentSession = nextSession;
          currentFrameId = child.frameId;
          currentWorld = nextWorld;
          continue;
        }
        throw frameError;
      }
    }
    throw frameError;
  }

  /**
   * Computes a child iframe's content box relative to its parent frame's
   * viewport, returning null if hidden, zero-sized, opacity: 0, or inert.
   */
  private async childFrameGeometry(
    tab: Tab,
    parentSession: string,
    parentFrameId: string,
    childFrameId: string,
    scrollIntoView: boolean,
  ): Promise<FrameBox | null> {
    let owner: { backendNodeId?: unknown };
    try {
      owner = await this.commandSession<{ backendNodeId?: unknown }>(
        parentSession,
        "DOM.getFrameOwner",
        { frameId: childFrameId },
      );
    } catch {
      return null;
    }
    const backendNodeId = owner.backendNodeId;
    if (
      typeof backendNodeId !== "number" ||
      !Number.isSafeInteger(backendNodeId)
    )
      return null;

    // Prefer isolated-world getBoundingClientRect + checkVisibility so opacity:0,
    // inert, and scroll offsets are handled accurately.
    try {
      const parentWorld =
        parentFrameId === tab.frame
          ? await this.world(tab)
          : await this.childWorld(tab, parentSession, parentFrameId);
      if (parentWorld !== "page" && parentWorld !== null) {
        const resolved = await this.commandSession<{
          object?: { objectId?: unknown };
        }>(parentSession, "DOM.resolveNode", {
          backendNodeId,
          executionContextId: parentWorld,
        });
        const objectId = resolved.object?.objectId;
        if (typeof objectId === "string" && objectId) {
          try {
            const measured = await this.commandSession<{
              result?: { value?: unknown };
            }>(parentSession, "Runtime.callFunctionOn", {
              objectId,
              arguments: [{ value: scrollIntoView }],
              returnByValue: true,
              silent: true,
              functionDeclaration: `function(shouldScroll) {
            var el = this;
            if (!el || typeof el.getBoundingClientRect !== "function") return null;
            if (shouldScroll && typeof el.scrollIntoView === "function") {
              var pre = el.getBoundingClientRect();
              if (pre.bottom <= 0 || pre.right <= 0 || pre.top >= (window.innerHeight || 0) || pre.left >= (window.innerWidth || 0)) {
                el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
              }
            }
            var r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return { visible: false };
            if (typeof el.checkVisibility === "function") {
              try {
                if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { visible: false };
              } catch (e) {}
            }
            var s = window.getComputedStyle(el);
            if (s && (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || s.opacity === "0")) {
              return { visible: false };
            }
            if (typeof el.closest === "function" && el.closest("[inert]")) return { visible: false };
            var bl = parseFloat(s && s.borderLeftWidth || "0") || 0;
            var bt = parseFloat(s && s.borderTopWidth || "0") || 0;
            var br = parseFloat(s && s.borderRightWidth || "0") || 0;
            var bb = parseFloat(s && s.borderBottomWidth || "0") || 0;
            var pl = parseFloat(s && s.paddingLeft || "0") || 0;
            var pt = parseFloat(s && s.paddingTop || "0") || 0;
            var pr = parseFloat(s && s.paddingRight || "0") || 0;
            var pb = parseFloat(s && s.paddingBottom || "0") || 0;
            var left = r.left + bl + pl;
            var top = r.top + bt + pt;
            var right = r.right - br - pr;
            var bottom = r.bottom - bb - pb;
            if (!(right > left && bottom > top)) return { visible: false };
            return { visible: true, offsetX: left, offsetY: top, left: left, top: top, right: right, bottom: bottom };
          }`,
            });
            const val = measured.result?.value as
              | {
                  visible?: boolean;
                  offsetX?: number;
                  offsetY?: number;
                  left?: number;
                  top?: number;
                  right?: number;
                  bottom?: number;
                }
              | null
              | undefined;
            if (val && val.visible === false) return null;
            if (
              val &&
              val.visible === true &&
              typeof val.offsetX === "number" &&
              typeof val.offsetY === "number" &&
              typeof val.left === "number" &&
              typeof val.top === "number" &&
              typeof val.right === "number" &&
              typeof val.bottom === "number"
            ) {
              return {
                offsetX: val.offsetX,
                offsetY: val.offsetY,
                left: val.left,
                top: val.top,
                right: val.right,
                bottom: val.bottom,
              };
            }
          } finally {
            void this.commandSession(parentSession, "Runtime.releaseObject", {
              objectId,
            }).catch(() => {});
          }
        }
      }
    } catch {
      // Fall back to DOM.getBoxModel below.
    }

    // Fallback: DOM.getBoxModel (content quad [x1, y1, x2, y2, x3, y3, x4, y4]).
    try {
      const boxModel = await this.commandSession<{
        model?: { content?: unknown };
      }>(parentSession, "DOM.getBoxModel", { backendNodeId });
      const content = boxModel.model?.content;
      if (Array.isArray(content) && content.length >= 6) {
        const [x1, y1, x2, , , y3] = content as number[];
        if (
          typeof x1 === "number" &&
          typeof y1 === "number" &&
          typeof x2 === "number" &&
          typeof y3 === "number" &&
          x2 > x1 &&
          y3 > y1
        ) {
          return {
            offsetX: x1,
            offsetY: y1,
            left: x1,
            top: y1,
            right: x2,
            bottom: y3,
          };
        }
      }
    } catch {
      // Frame not laid out.
    }
    return null;
  }

  /** Verifies that in a parent frame at local coordinates (x, y), the child iframe is not occluded. */
  private async frameHitCheck(
    tab: Tab,
    parentSession: string,
    parentFrameId: string,
    childFrameId: string,
    x: number,
    y: number,
  ): Promise<{ ok: true } | { ok: false; cover?: string }> {
    try {
      const owner = await this.commandSession(
        parentSession,
        "DOM.getFrameOwner",
        { frameId: childFrameId },
      );
      const backendNodeId = (owner as { backendNodeId?: unknown })
        .backendNodeId;
      if (typeof backendNodeId !== "number") return { ok: true };
      const world =
        parentFrameId === tab.frame
          ? await this.world(tab)
          : await this.childWorld(tab, parentSession, parentFrameId);
      if (world === "page" || world === null) return { ok: false };
      const resolved = await this.commandSession<{
        object?: { objectId?: unknown };
      }>(parentSession, "DOM.resolveNode", {
        backendNodeId,
        executionContextId: world,
      });
      const objectId = resolved.object?.objectId;
      if (typeof objectId !== "string" || !objectId) return { ok: true };
      try {
        const checked = await this.commandSession<{
          result?: { value?: { ok?: boolean; cover?: string } };
        }>(parentSession, "Runtime.callFunctionOn", {
          objectId,
          arguments: [{ value: x }, { value: y }],
          returnByValue: true,
          silent: true,
          functionDeclaration: `function(px, py) {
            var el = this;
            var top = document.elementFromPoint(px, py);
            for (var depth = 0; top && top !== el && top.shadowRoot && typeof top.shadowRoot.elementFromPoint === "function" && depth < 30; depth++) {
              var below = top.shadowRoot.elementFromPoint(px, py);
              if (!below || below === top) break;
              top = below;
            }
            if (!top) return { ok: false };
            if (top === el || (typeof el.contains === "function" && el.contains(top))) return { ok: true };
            return { ok: false, cover: String(top.localName || "").toLowerCase().slice(0, 40) };
          }`,
        });
        const val = checked.result?.value;
        if (val && val.ok === false) {
          return {
            ok: false,
            ...(typeof val.cover === "string" && val.cover
              ? { cover: val.cover }
              : {}),
          };
        }
      } finally {
        void this.commandSession(parentSession, "Runtime.releaseObject", {
          objectId,
        }).catch(() => {});
      }
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
      // Mocked browsers without DOM.resolveNode skip parent occlusion check.
    }
    return { ok: true };
  }

  /** Traverses visible child frames (same-origin, OOPIFs, and nested frames inside OOPIFs) and merges their elements & text. */
  private async readChildFrames(tab: Tab, page: BrowserPage): Promise<void> {
    let rawTree: unknown;
    try {
      rawTree = await this.command(tab, "Page.getFrameTree");
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
      return;
    }
    const parsed = frameTreeSchema.safeParse(rawTree);
    if (!parsed.success) return;
    tab.frame = parsed.data.frameTree.frame.id;

    const geomByFrame = new Map<string, FrameBox>();
    geomByFrame.set(tab.frame, {
      offsetX: 0,
      offsetY: 0,
      left: Number.NEGATIVE_INFINITY,
      top: Number.NEGATIVE_INFINITY,
      right: Number.POSITIVE_INFINITY,
      bottom: Number.POSITIVE_INFINITY,
    });

    const elements = [...page.elements];
    let text = page.text;
    let visited = 0;

    const walkChildren = async (
      parentNode: FrameTreeNode,
      parentSession: string,
      ancestors: string[],
      ancestorSessions: string[],
    ): Promise<void> => {
      for (const child of parentNode.childFrames ?? []) {
        if (visited >= maxChildFrames || elements.length >= pageLimits.elements)
          return;
        const url = child.frame.url ?? "";
        if (!frameAllowedUrl(url)) continue;
        const parentId = child.frame.parentId ?? parentNode.frame.id;
        const parentGeom = geomByFrame.get(parentId);
        if (!parentGeom) continue;

        visited += 1;
        const localGeom = await this.childFrameGeometry(
          tab,
          parentSession,
          parentId,
          child.frame.id,
          false,
        );
        if (!localGeom) continue;
        const accum: FrameBox = {
          offsetX: parentGeom.offsetX + localGeom.offsetX,
          offsetY: parentGeom.offsetY + localGeom.offsetY,
          left: Math.max(parentGeom.left, parentGeom.offsetX + localGeom.left),
          top: Math.max(parentGeom.top, parentGeom.offsetY + localGeom.top),
          right: Math.min(
            parentGeom.right,
            parentGeom.offsetX + localGeom.right,
          ),
          bottom: Math.min(
            parentGeom.bottom,
            parentGeom.offsetY + localGeom.bottom,
          ),
        };
        if (!(accum.right > accum.left && accum.bottom > accum.top)) continue;
        geomByFrame.set(child.frame.id, accum);

        const childSession =
          this.oopifsByFrameId.get(child.frame.id)?.session ?? parentSession;
        const chain = [...ancestors, child.frame.id];
        const sessions = [...ancestorSessions, childSession];

        try {
          const answer = await this.askInFrame(
            tab,
            childSession,
            child.frame.id,
            { do: "read" },
          );
          if (answer.page) {
            const childPage = pageOfReading("own", answer.page);
            for (const el of childPage.elements) {
              if (elements.length >= pageLimits.elements) break;
              elements.push(el);
              tab.elementFrames.set(el.index, {
                frameId: child.frame.id,
                session: childSession,
                chain,
                sessions,
              });
            }
            if (childPage.text && text.length < pageLimits.text) {
              const sep = text ? "\n" : "";
              text = (text + sep + childPage.text).slice(0, pageLimits.text);
            }
          }
        } catch (error) {
          if (error instanceof DevToolsClosed) throw error;
          // Detached, navigating, unattached cross-origin frame, or no isolated world: skip safely.
          continue;
        }

        let subNode: FrameTreeNode = child;
        if (
          childSession !== parentSession &&
          (child.childFrames?.length ?? 0) === 0
        ) {
          try {
            const oopifTreeRaw = await this.commandSession(
              childSession,
              "Page.getFrameTree",
            );
            const oopifParsed = frameTreeSchema.safeParse(oopifTreeRaw);
            if (oopifParsed.success) {
              subNode =
                this.findFrameNode(
                  oopifParsed.data.frameTree,
                  child.frame.id,
                ) ?? oopifParsed.data.frameTree;
            }
          } catch (error) {
            if (error instanceof DevToolsClosed) throw error;
          }
        }
        await walkChildren(subNode, childSession, chain, sessions);
      }
    };

    await walkChildren(
      parsed.data.frameTree,
      tab.session,
      [tab.frame],
      [tab.session],
    );

    page.elements = elements;
    page.text = text;
  }

  private async look(tab: Tab) {
    const answer = await this.ask(tab, { do: "read" });
    if (!answer.page) throw new Error(unreadable);
    // The page may have gone to an address that is not a web page.
    if (
      !web(answer.page.url) &&
      !blank(answer.page.url) &&
      !chromeError(answer.page.url)
    )
      throw new Error(ownPage);
    tab.url = answer.page.url;
    tab.elementFrames.clear();
    const page = pageOfReading("own", answer.page);
    if (chromeError(answer.page.url)) {
      page.elements = [];
    } else {
      await this.readChildFrames(tab, page);
    }
    if (
      tab.navError &&
      (chromeError(answer.page.url) || blank(answer.page.url))
    ) {
      Object.assign(page, { navError: tab.navError });
    }
    return {
      ready: answer.ready === true,
      page,
    };
  }

  /** Where element N is now, after it came into view. */
  private async located(tab: Tab, index: number): Promise<Located> {
    this.assertOperable(tab);
    const frameRef = tab.elementFrames.get(index);
    if (frameRef) {
      if (
        (await this.childWorld(tab, frameRef.session, frameRef.frameId)) ===
        null
      )
        throw new Error(
          "This browser gave no private world for the check before a click, so nothing was sent. Read the page again, or use the screen.",
        );
      // Pre-scroll ancestor iframes into view if needed, then locate inside the
      // child frame (which may also scroll ancestor windows), then measure the
      // final post-scroll viewport geometry for accurate coordinate translation.
      for (let i = 1; i < frameRef.chain.length; i++) {
        await this.childFrameGeometry(
          tab,
          frameRef.sessions[i - 1]!,
          frameRef.chain[i - 1]!,
          frameRef.chain[i]!,
          true,
        );
      }
      const text = await this.evaluateInFrame(
        tab,
        frameRef.session,
        frameRef.frameId,
        { do: "locate", index },
      );
      const refused = parsePageAnswer(text);
      if (refused && !refused.ok) throw new Error(oneLine(refused.error, 300));
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(unreadable);
      }
      const box = locateSchema.safeParse(parsed);
      if (!box.success) throw new Error(unreadable);
      let accum: FrameBox = {
        offsetX: 0,
        offsetY: 0,
        left: 0,
        top: 0,
        right: Number.POSITIVE_INFINITY,
        bottom: Number.POSITIVE_INFINITY,
      };
      const locals: FrameBox[] = [];
      for (let i = 1; i < frameRef.chain.length; i++) {
        const parentSession = frameRef.sessions[i - 1]!;
        const parentId = frameRef.chain[i - 1]!;
        const childId = frameRef.chain[i]!;
        const local = await this.childFrameGeometry(
          tab,
          parentSession,
          parentId,
          childId,
          false,
        );
        if (!local)
          throw new Error(
            `Number ${index} is hidden now. Read the page again.`,
          );
        locals[i] = local;
        accum = {
          offsetX: accum.offsetX + local.offsetX,
          offsetY: accum.offsetY + local.offsetY,
          left: Math.max(accum.left, accum.offsetX + local.left),
          top: Math.max(accum.top, accum.offsetY + local.top),
          right: Math.min(accum.right, accum.offsetX + local.right),
          bottom: Math.min(accum.bottom, accum.offsetY + local.bottom),
        };
      }
      const topX = box.data.x + accum.offsetX;
      const topY = box.data.y + accum.offsetY;
      const inside =
        box.data.inside &&
        topX >= accum.left &&
        topX <= accum.right &&
        topY >= accum.top &&
        topY <= accum.bottom;
      let hit = box.data.hit;
      let cover = box.data.cover;
      if (hit && inside && frameRef.chain.length >= 2) {
        // Walk EVERY parent level in the nested iframe chain in that parent's
        // local coordinates to defeat nested-iframe clickjacking overlays.
        let px = box.data.x;
        let py = box.data.y;
        for (let i = frameRef.chain.length - 1; i >= 1; i--) {
          const local = locals[i]!;
          px += local.offsetX;
          py += local.offsetY;
          const parentHit = await this.frameHitCheck(
            tab,
            frameRef.sessions[i - 1]!,
            frameRef.chain[i - 1]!,
            frameRef.chain[i]!,
            px,
            py,
          );
          if (!parentHit.ok) {
            hit = false;
            if (parentHit.cover) cover = parentHit.cover;
            break;
          }
        }
      }
      return {
        ...box.data,
        x: topX,
        y: topY,
        inside,
        hit,
        ...(cover ? { cover } : {}),
      };
    }
    // The check before an input runs only in the private world, where the
    // page cannot change what it reads. A browser that gave no such world
    // gets no input: in doubt, nothing is sent.
    if ((await this.world(tab)) === "page")
      throw new Error(
        "This browser gave no private world for the check before a click, so nothing was sent. Read the page again, or use the screen.",
      );
    const text = await this.evaluate(tab, { do: "locate", index });
    const refused = parsePageAnswer(text);
    if (refused && !refused.ok) throw new Error(oneLine(refused.error, 300));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(unreadable);
    }
    const box = locateSchema.safeParse(parsed);
    if (!box.success) throw new Error(unreadable);
    return box.data;
  }

  private hasOpenDocument(tab: Tab): boolean {
    for (const request of tab.open.values()) {
      if (request.document) return true;
    }
    return false;
  }

  /** Whether the page is quiet: no new request for a while, and none that it waits for. */
  private quiet(tab: Tab, isNavigation = false, stepStartedAt?: number) {
    const now = this.clock.now();
    if (now - tab.lastRequestAt < ownTiming.quietMs) return false;
    for (const request of tab.open.values()) {
      const openedInStep =
        stepStartedAt !== undefined && request.at >= stepStartedAt;
      const maxOpen =
        isNavigation || openedInStep
          ? ownTiming.navLongRequestMs
          : ownTiming.bgLongRequestMs;
      if (request.document || now - request.at < maxOpen) return false;
    }
    return true;
  }

  /** Runs a lightweight quiescence probe in the isolated world without scraping the DOM. */
  private async probeSettle(tab: Tab): Promise<{
    readyState: string;
    leaving: boolean;
    domIdleMs: number;
    url?: string;
  }> {
    const text = await this.evaluate(tab, { do: "settle" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(unreadable);
    }
    const result = settleSchema.safeParse(parsed);
    if (!result.success) throw new Error(unreadable);
    return {
      readyState: result.data.readyState ?? "complete",
      leaving: result.data.leaving === true,
      domIdleMs: result.data.domIdleMs ?? ownTiming.domIdleMs,
      ...(result.data.url !== undefined ? { url: result.data.url } : {}),
    };
  }

  /** Adopts a newly created popup/target="_blank" tab opened by the active tab. */
  private async adoptPendingPopup(activeTab: Tab): Promise<Tab | null> {
    const live = this.live;
    if (
      !live ||
      !this.pendingPopup ||
      this.pendingPopup.openerId !== activeTab.targetId
    )
      return null;
    const popupId = this.pendingPopup.targetId;
    this.pendingPopup = null;
    const info = this.discoveredTargets.get(popupId);
    if (info && !listable(info)) return null;
    const popupTab = await this.attach(
      live,
      popupId,
      info?.url ?? "about:blank",
    );
    this.current = popupId;
    return popupTab;
  }

  /**
   * Waits until readyState !== "loading", DOM mutations have been idle for
   * >= 80ms, and network activity has been quiet for >= 100ms (bounded at
   * 2000ms for in-page actions and 3000ms for navigations), then runs look()
   * ONCE instead of polling full DOM scrapes.
   */
  private async settled(
    initialTab: Tab,
    capMs: number,
    fits: (page: BrowserPage) => boolean = () => true,
    isNavigation = false,
    stepStartedAt?: number,
  ): Promise<BrowserPage> {
    let tab = initialTab;
    let navigation = isNavigation;
    let effectiveCap = capMs;
    const from = this.clock.now();
    const docsBefore = tab.documents;
    let failed: unknown = null;
    await this.clock.sleep(ownTiming.firstLookMs);
    for (;;) {
      const popup = await this.adoptPendingPopup(tab);
      if (popup) {
        tab = popup;
        navigation = true;
        effectiveCap = Math.max(effectiveCap, ownTiming.openWaitMs);
      }
      if (tab.dialog !== null) throw new Error(dialogText(tab.dialog));
      if (
        !navigation &&
        (tab.documents > docsBefore ||
          tab.frameLoading ||
          this.hasOpenDocument(tab))
      ) {
        navigation = true;
        effectiveCap = Math.max(effectiveCap, ownTiming.openWaitMs);
      }
      if (this.quiet(tab, navigation, stepStartedAt)) {
        try {
          const probe = await this.probeSettle(tab);
          failed = null;
          if (
            !navigation &&
            (tab.documents > docsBefore ||
              tab.frameLoading ||
              this.hasOpenDocument(tab))
          ) {
            navigation = true;
            effectiveCap = Math.max(effectiveCap, ownTiming.openWaitMs);
          }
          const ready = probe.readyState !== "loading" && !probe.leaving;
          const domIdle = probe.domIdleMs >= ownTiming.domIdleMs;
          const urlReady =
            probe.url === undefined ||
            !navigation ||
            web(probe.url) ||
            chromeError(probe.url);
          if (
            ready &&
            domIdle &&
            urlReady &&
            this.quiet(tab, navigation, stepStartedAt)
          ) {
            const seen = await this.look(tab);
            if (fits(seen.page)) return seen.page;
          }
        } catch (error) {
          if (error instanceof DevToolsClosed) throw error;
          failed = error;
        }
      }
      const left = from + effectiveCap - this.clock.now();
      if (left <= 0) break;
      await this.clock.sleep(Math.min(ownTiming.lookEveryMs, left));
    }
    const popup = await this.adoptPendingPopup(tab);
    if (popup) tab = popup;
    if (tab.dialog !== null) throw new Error(dialogText(tab.dialog));
    try {
      return (await this.look(tab)).page;
    } catch (error) {
      if (error instanceof DevToolsClosed) throw error;
      throw failed ?? error;
    }
  }
}

const dialogText = (message: string) =>
  `The page shows a dialog${message ? `: "${message}"` : ""}. ClawdTime does not answer it: ask the person to answer it in ClawdTime's browser.`;

/** The name of the program as the person knows it: the name of its app. */
function programName(path: string) {
  return /([^/]+)\.app\//.exec(path)?.[1] ?? basename(path);
}

/** A pointer at the centre reaches the element and nothing else, or nothing is sent. */
function reachable(box: Located) {
  if (!box.inside)
    throw new Error(
      `${box.name} is not in view, even after scrolling. Nothing was sent. Read the page again.`,
    );
  if (box.hit) return;
  const what = box.cover ? ` (${box.cover})` : "";
  if (box.blocked === "frame")
    throw new Error(
      `${box.name} has a frame at its centre${what}: a click there lands in another page, maybe of another site. Nothing was sent. Do it another way, or ask the person.`,
    );
  if (box.blocked === "control")
    throw new Error(
      `${box.name} has another control at its centre${what}: a click there presses that control. Nothing was sent. Read the page again and choose the element that does what you want.`,
    );
  if (box.blocked === "unsure")
    throw new Error(
      `ClawdTime cannot tell what lies at the centre of ${box.name}: the page changed the browser's own check. Nothing was sent. Use the screen, or ask the person.`,
    );
  throw new Error(
    `${box.name} is under another element at its centre${what}. Nothing was sent. Close what covers it, or scroll, then read the page again.`,
  );
}

/** The second wall: no text goes into a password field, or into a field that takes none. */
function takesText(box: Located) {
  if (box.password)
    throw new Error(
      `${box.name} is a password field. The worker never types a password: ask the person to type it.`,
    );
  if (box.disabled) throw new Error(`${box.name} is disabled now.`);
  if (box.kind === "press" || box.kind === "check")
    throw new Error(`${box.name} does not take text. Click it instead.`);
  if (box.readOnly) throw new Error(`${box.name} is read only.`);
}
