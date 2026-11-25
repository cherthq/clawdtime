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
  /** After a step, the page gets this long before the first look. */
  firstLookMs: 100,
  lookEveryMs: 100,
  /** No network request that starts or ends for this long is quiet. */
  quietMs: 400,
  /** A request that is open this long, and not the page itself, no longer counts. */
  longRequestMs: 1500,
  /** The most that the driver waits for the page after a step. */
  waitMs: 5000,
  /** After an address opens. */
  openWaitMs: 10_000,
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
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
const shiftKey: KeySpec = { key: "Shift", code: "ShiftLeft", keyCode: 16 };
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
  const name = shifted ? parts[1]! : parts.length === 1 ? parts[0]! : "";
  const spec = keySpecs[name === "return" ? "enter" : name];
  if (!spec || (shifted && name !== "tab"))
    throw new Error(
      `${me} presses one of these keys: Enter, Escape, Tab, Shift+Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown, Home, End, Backspace, Space.`,
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
    cover: z.string().max(40).optional(),
    /** Why a pointer at the centre does not reach it, besides an element on top of it. */
    blocked: z.enum(["frame", "control", "unsure"]).optional(),
  })
  .strict();
type Located = z.infer<typeof locateSchema>;

const targetSchema = z.object({
  targetId: z.string().min(1).max(200),
  type: z.string(),
  title: z.string(),
  url: z.string(),
});
const targetsSchema = z.object({ targetInfos: z.array(targetSchema) });
type Target = z.infer<typeof targetSchema>;
const processesSchema = z.object({
  processInfo: z.array(z.object({ type: z.string(), id: z.number() })),
});
const frameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string().min(1).max(200) }) }),
});
const historySchema = z.object({
  currentIndex: z.number().int(),
  entries: z.array(z.object({ id: z.number().int(), url: z.string() })),
});

const web = (url: string) => /^https?:\/\//i.test(url);
const blank = (url: string) =>
  url === "" ||
  url === "about:blank" ||
  /^[a-z]+:\/\/(newtab|new-tab-page)\/?$/i.test(url);
/** A tab that the person sees: a web page or an empty one. Never a page of the browser itself. */
const listable = (target: Target) =>
  target.type === "page" && (web(target.url) || blank(target.url));

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
/** One page that the driver is attached to. */
interface Tab {
  targetId: string;
  session: string;
  url: string;
  /** When a network request of the page last started or ended. */
  lastRequestAt: number;
  /** Requests that are open: whether each is a document, and when it started. */
  open: Map<string, { document: boolean; at: number }>;
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
}
/** One input step: whether a command with an effect went out. */
interface Step {
  sent: boolean;
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
    const step: Step = { sent: false };
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
      await this.activate(live, tab.targetId);
      const navigated = await this.effect<{ errorText?: unknown }>(
        step,
        tab,
        "Page.navigate",
        { url: address },
      );
      if (typeof navigated.errorText === "string" && navigated.errorText)
        throw new Error(
          `The page did not open: ${oneLine(navigated.errorText, 120)}.`,
        );
      return await this.settled(tab, ownTiming.openWaitMs, (page) =>
        web(page.url),
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
      const box = await this.located(tab, index);
      if (box.disabled) throw new Error(`${box.name} is disabled now.`);
      if (box.tag === "select")
        throw new Error(
          `${box.name} is a list of choices. Use select with the text of one choice.`,
        );
      reachable(box);
      await this.press(tab, step, box);
      return this.settled(tab, ownTiming.waitMs);
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
      let box = await this.located(tab, index);
      takesText(box);
      if (box.kind === "choice") {
        step.sent = true;
        await this.ask(tab, { do: "type", index, text: said, submit: false });
        if (submit) await this.keys(tab, step, keyEvents("Enter"));
        return this.settled(tab, ownTiming.waitMs);
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
      const page = await this.settled(tab, ownTiming.waitMs);
      if (!submit && box.kind === "text" && said !== "") {
        const field = page.elements.find((item) => item.index === index);
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
      step.sent = true;
      await this.ask(tab, { do: "scroll", direction });
      return this.settled(tab, ownTiming.waitMs);
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
      await this.effect(step, tab, "Page.navigateToHistoryEntry", {
        entryId: earlier.id,
      });
      return this.settled(tab, ownTiming.waitMs);
    });
  }

  /** Moves the pointer onto the element, with no click. */
  async hover(index: number): Promise<BrowserPage> {
    numbered(index);
    return this.input(async (tab, step) => {
      const box = await this.located(tab, index);
      reachable(box);
      await this.effect(step, tab, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x,
        y: box.y,
        button: "none",
        buttons: 0,
      });
      return this.settled(tab, ownTiming.waitMs);
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
      const box = await this.located(tab, index);
      if (box.disabled) throw new Error(`${box.name} is disabled now.`);
      if (box.tag === "select") {
        step.sent = true;
        await this.ask(tab, { do: "type", index, text: want, submit: false });
        return this.settled(tab, ownTiming.waitMs);
      }
      if (box.role !== "listbox" && box.role !== "combobox")
        throw new Error(
          `${box.name} is not a list of choices. Click it, or type into it.`,
        );
      reachable(box);
      await this.press(tab, step, box);
      const opened = await this.settled(tab, ownTiming.waitMs);
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
      return this.settled(tab, ownTiming.waitMs);
    });
  }

  /**
   * One key or combo in the page: it goes to the element with the focus. The
   * page script says first where the focus is: in a password field or in a
   * frame, no key is pressed.
   */
  async key(combo: string): Promise<BrowserPage> {
    const events = keyEvents(combo);
    return this.input(async (tab, step) => {
      await this.ask(tab, { do: "focus" });
      await this.keys(tab, step, events);
      return this.settled(tab, ownTiming.waitMs);
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
      return this.settled(tab, ownTiming.waitMs);
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
      const now = this.clock.now();
      tab.lastRequestAt = now;
      // A stream that stays open is not a page that loads.
      if (params.type === "EventSource" || params.type === "WebSocket") return;
      tab.open.set(params.requestId, {
        document: params.type === "Document",
        at: now,
      });
    });
    for (const done of ["Network.loadingFinished", "Network.loadingFailed"])
      connection.on(done, (params, session) => {
        const tab = tabOf(session);
        if (!tab || typeof params.requestId !== "string") return;
        // An answer may lead the page to ask for more: the quiet starts again.
        tab.lastRequestAt = this.clock.now();
        tab.open.delete(params.requestId);
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
      if ((frame as { parentId?: unknown }).parentId !== undefined) return;
      tab.documents += 1;
      tab.world = null;
    });
    connection.on("Target.detachedFromTarget", (params) => {
      if (typeof params.sessionId !== "string") return;
      const tab = this.tabsBySession.get(params.sessionId);
      if (!tab) return;
      this.tabsBySession.delete(tab.session);
      this.tabsById.delete(tab.targetId);
    });
    connection.onClose(() => {
      if (this.live === live) this.forget(true);
    });
    return live;
  }

  /** Lets go of the browser. `ended` marks a browser that closed by itself. */
  private forget(ended = false) {
    if (ended) this.ended = true;
    this.live = null;
    this.current = null;
    this.listing = null;
    this.tabsById.clear();
    this.tabsBySession.clear();
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
    return listed.data.targetInfos.filter(listable);
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
      known.url = url;
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
    };
    this.tabsById.set(targetId, tab);
    this.tabsBySession.set(tab.session, tab);
    await Promise.all([
      this.command(tab, "Page.enable"),
      this.command(tab, "Network.enable"),
    ]);
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
    const step: Step = { sent: false };
    try {
      return await run(await this.tab(false), step);
    } catch (error) {
      throw this.lost(step, error);
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

  private command<T = Record<string, unknown>>(
    tab: Tab,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = ownTiming.callMs,
  ) {
    const live = this.live;
    if (!live)
      return Promise.reject(new DevToolsClosed(endedNothingSent, false));
    return live.connection.send<T>(method, params, {
      session: tab.session,
      timeoutMs,
    });
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

  private async look(tab: Tab) {
    const answer = await this.ask(tab, { do: "read" });
    if (!answer.page) throw new Error(unreadable);
    // The page may have gone to an address that is not a web page.
    if (!web(answer.page.url) && !blank(answer.page.url))
      throw new Error(ownPage);
    tab.url = answer.page.url;
    return {
      ready: answer.ready === true,
      page: pageOfReading("own", answer.page),
    };
  }

  /** Where element N is now, after it came into view. */
  private async located(tab: Tab, index: number): Promise<Located> {
    if (!web(tab.url) && !blank(tab.url)) throw new Error(ownPage);
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

  /** Whether the page is quiet: no new request for a while, and none that it waits for. */
  private quiet(tab: Tab) {
    const now = this.clock.now();
    if (now - tab.lastRequestAt < ownTiming.quietMs) return false;
    for (const request of tab.open.values())
      if (request.document || now - request.at < ownTiming.longRequestMs)
        return false;
    return true;
  }

  /**
   * Waits until the page is ready again: loaded, not on its way out, and
   * quiet on the network. The wait has an end. When it comes, the last
   * reading is the answer, or the failure when the last look failed.
   */
  private async settled(
    tab: Tab,
    capMs: number,
    fits: (page: BrowserPage) => boolean = () => true,
  ): Promise<BrowserPage> {
    const from = this.clock.now();
    let last: BrowserPage | null = null;
    let failed: unknown = null;
    await this.clock.sleep(ownTiming.firstLookMs);
    for (;;) {
      if (tab.dialog !== null) throw new Error(dialogText(tab.dialog));
      try {
        const seen = await this.look(tab);
        if (seen.ready && this.quiet(tab) && fits(seen.page)) return seen.page;
        last = seen.page;
      } catch (error) {
        if (error instanceof DevToolsClosed) throw error;
        // What was read before a failure is not the page now.
        last = null;
        failed = error;
      }
      const left = from + capMs - this.clock.now();
      if (left <= 0) break;
      await this.clock.sleep(Math.min(ownTiming.lookEveryMs, left));
    }
    if (last) return last;
    throw failed ?? new Error(unreadable);
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
