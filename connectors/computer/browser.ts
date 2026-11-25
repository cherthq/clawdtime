/**
 * The browser, driven through its own scripting door.
 *
 * A browser on macOS takes a string of JavaScript through Apple events and
 * runs it in the page of its front window. That is the person's own browser,
 * with their sign-ins. The page is read and operated as it is, with no guess
 * at pixels.
 *
 * Every command is /usr/bin/osascript with an argument list. No shell runs.
 * The script of the command is one fixed text for each browser. The page
 * script, the text to type and the address travel as arguments of its run
 * handler, never inside that text, so nothing in them can change the command.
 *
 * Which browsers. Google Chrome with its Beta, Dev and Canary channels,
 * Chromium, Brave Browser and Microsoft Edge are built from one source and
 * share one scripting dictionary: a tab takes `execute ... javascript`, and
 * the person allows it under View > Developer. Safari has its own command,
 * `do JavaScript`. Other browsers of the Chromium family are not driven:
 * their dictionary or their menu differs, or is not certain.
 *
 * Numbers. Each element of a reading carries a number, kept on the element
 * in the page. The driver tells the page its own name and the next free
 * number with every call, so a number is never given twice: not in another
 * document, not in another tab, not by another driver. A number that no
 * element of the page in front carries is an error, never another element.
 *
 * The wait. A browser gives back the value of a script at once and waits for
 * no promise. So after a step that changes the page, the driver looks again
 * until the page is ready, for a bounded time, and returns that reading.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { webAddress } from "../agents/browser.js";
import {
  pageHelpers,
  pageLimits,
  pageScript,
  parsePageKey,
  type PageCall,
} from "./browser-script.js";
// The own browser uses the parser of this file in its methods only, so the
// two files may import each other.
import { OwnBrowser } from "./own-browser.js";
import {
  BrowserClosed,
  type BrowserElement,
  type BrowserPage,
  type BrowserPort,
  type BrowserTab,
} from "./ports.js";

export interface CommandOutput {
  /** null when the command could not start or was stopped by the timeout. */
  status: number | null;
  stdout: string;
  /** What the command wrote as its error. A runner may leave it out. */
  stderr?: string;
}
/** Runs one command from an argument list. It never rejects and never uses a shell. */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandOutput>;
export interface BrowserClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) =>
          resolve({
            status: error
              ? typeof error.code === "number"
                ? error.code
                : null
              : 0,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
          }),
      );
    } catch {
      // An argument that the system refuses: the command did not start.
      resolve({ status: null, stdout: "", stderr: "" });
    }
  });

export const systemClock: BrowserClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const osascript = "/usr/bin/osascript";

export const browserTiming = {
  /** The most that one command may take. */
  callMs: 8000,
  /** After a step, the page gets this long before the first look. */
  firstLookMs: 150,
  lookEveryMs: 250,
  /** The most that the driver waits for the page after a step. */
  waitMs: 3000,
} as const;

/**
 * The longest text for one step, as it travels. macOS gives one command
 * about a million bytes for all its arguments and its environment.
 */
const mostTextBytes = 500_000;

export interface SupportedBrowser {
  /** The name that the person knows. */
  name: string;
  /** The bundle identifier: the name that macOS knows. */
  id: string;
  family: BrowserPage["browser"];
  /** One sentence: where the person allows JavaScript from Apple events. */
  allow: string;
}
const chromium = (name: string, id: string): SupportedBrowser => ({
  name,
  id,
  family: "chrome",
  allow: `${name} does not take page scripts yet: in ${name}, choose View > Developer > Allow JavaScript from Apple Events.`,
});
/**
 * The browsers that this driver drives. When none is in front, the first one
 * of this list that is open is driven.
 */
export const supportedBrowsers: readonly SupportedBrowser[] = [
  chromium("Google Chrome", "com.google.Chrome"),
  {
    name: "Safari",
    id: "com.apple.Safari",
    family: "safari",
    allow:
      'Safari does not take page scripts yet: in Safari > Settings > Advanced, switch on "Show features for web developers", then in Safari > Settings > Developer, switch on "Allow JavaScript from Apple Events".',
  },
  chromium("Brave Browser", "com.brave.Browser"),
  chromium("Microsoft Edge", "com.microsoft.edgemac"),
  chromium("Chromium", "org.chromium.Chromium"),
  chromium("Google Chrome Beta", "com.google.Chrome.beta"),
  chromium("Google Chrome Dev", "com.google.Chrome.dev"),
  chromium("Google Chrome Canary", "com.google.Chrome.canary"),
];

export type BrowserTrouble =
  | "javascript_off"
  | "automation_denied"
  | "not_running"
  | "timed_out"
  | "no_window"
  | "no_answer";

/**
 * The real error texts and numbers, in one place. A case is known by one of
 * its numbers or by a part of its text; the first row that fits wins. Letter
 * case and the kind of apostrophe do not count. To teach the driver a new
 * wording, add it to `texts`.
 */
export const browserErrors: readonly {
  trouble: BrowserTrouble;
  numbers: readonly number[];
  texts: readonly string[];
}[] = [
  {
    // The first text is of the Chromium browsers (number 12), the second is in
    // both wordings of Safari (number 8). Those numbers mean other things in
    // other applications, so only the text counts.
    trouble: "javascript_off",
    numbers: [],
    texts: [
      "Executing JavaScript through AppleScript is turned off",
      "Allow JavaScript from Apple Events",
    ],
  },
  {
    trouble: "automation_denied",
    numbers: [-1743],
    texts: ["Not authorized to send Apple events"],
  },
  {
    trouble: "not_running",
    numbers: [-600],
    texts: ["Application isn't running"],
  },
  {
    trouble: "timed_out",
    numbers: [-1712],
    texts: ["AppleEvent timed out"],
  },
  {
    trouble: "no_window",
    numbers: [-1719, -1728],
    texts: ["Invalid index", "Can't get window 1", "Can't get document 1"],
  },
  {
    // The browser ran nothing and gave nothing back, as on its own pages.
    trouble: "no_answer",
    numbers: [-2753, -2763],
    texts: ["The variable theAnswer is not defined", "No result was returned"],
  },
];

const { oneLine } = pageHelpers;
const noBrowser =
  "No supported browser is open: open Google Chrome or Safari, then try again.";
const noProbe =
  "macOS did not say which browsers are open: try again in a moment.";
const unreadable = (browser: SupportedBrowser) =>
  `${browser.name} gave an answer that ClawdTime could not read: read the page again.`;

/** What the person must do, in one sentence. */
function reasonFor(trouble: BrowserTrouble, browser: SupportedBrowser) {
  const { name } = browser;
  switch (trouble) {
    case "javascript_off":
      return browser.allow;
    case "automation_denied":
      return `macOS has not allowed the automation of ${name}: in System Settings > Privacy & Security > Automation, switch on ${name} under the app that runs ClawdTime.`;
    case "not_running":
      return `${name} is not open any more: open it, then try again.`;
    case "timed_out":
      return `${name} did not answer in time: if macOS asks whether ${name} may be controlled, allow it, then try again.`;
    case "no_window":
      return `${name} has no window open: open a page in it, then try again.`;
    case "no_answer":
      return `${name} cannot run a script on the page in front, which is one of its own pages: open a web page, then try again.`;
  }
}

const plain = (value: string) => value.replaceAll("\u2019", "'").toLowerCase();
function troubleOf(number: number | null, text: string) {
  const said = plain(text);
  for (const row of browserErrors)
    if (
      (number !== null && row.numbers.includes(number)) ||
      row.texts.some((item) => said.includes(plain(item)))
    )
      return row.trouble;
  return null;
}

/** The application in the text of a script. An identifier holds nothing that could end the string. */
const named = (browser: SupportedBrowser) => {
  if (!/^[A-Za-z0-9.-]+$/.test(browser.id))
    throw new Error(
      "A bundle identifier holds letters, digits, dots and dashes.",
    );
  return `application id "${browser.id}"`;
};
/** A failure inside the script comes back as text, with its number, so one reading of the output finds it. */
const failure = `  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try`;

/**
 * Which of the browsers run, and which one is in front. The identifiers are
 * arguments: the text names no application, so it compiles on a Mac that
 * lacks one of them. Asking whether an application runs does not start it.
 */
export const probeScript = `on run argv
  set theReport to ""
  repeat with theItem in argv
    set theIdentifier to theItem as text
    try
      if running of application id theIdentifier then
        set theState to "open"
        try
          if frontmost of application id theIdentifier then set theState to "front"
        end try
        set theReport to theReport & theState & " " & theIdentifier & linefeed
      end if
    end try
  end repeat
  return theReport
end run`;

/** Runs the page script, the first argument, in the page of the front window. */
export function runScript(browser: SupportedBrowser) {
  const [count, ask] =
    browser.family === "safari"
      ? [
          "(count of documents)",
          "do JavaScript thePageScript in front document",
        ]
      : [
          "(count of windows)",
          "execute active tab of front window javascript thePageScript",
        ];
  return `on run argv
  set thePageScript to item 1 of argv
  try
    tell ${named(browser)}
      if ${count} is 0 then return "clawdtime:no-window"
      set theAnswer to ${ask}
    end tell
    if theAnswer is missing value then return "clawdtime:no-answer"
    return theAnswer as text
${failure}
end run`;
}

/**
 * Opens the address, the first argument, in a new tab of the front window,
 * and brings the browser forward. The page that the person had stays as it is.
 */
export function openScript(browser: SupportedBrowser) {
  const [count, first, more] =
    browser.family === "safari"
      ? [
          "(count of documents)",
          "make new document with properties {URL:theAddress}",
          "tell front window to set current tab to (make new tab with properties {URL:theAddress})",
        ]
      : [
          "(count of windows)",
          "make new window\n        set URL of active tab of front window to theAddress",
          "tell front window to make new tab with properties {URL:theAddress}",
        ];
  return `on run argv
  set theAddress to item 1 of argv
  try
    tell ${named(browser)}
      if ${count} is 0 then
        ${first}
      else
        ${more}
      end if
      activate
    end tell
    return "clawdtime:opened"
${failure}
end run`;
}

/**
 * Lists the tabs of the front window, one line for each: its place, whether
 * the window shows it, its address and its title, apart by a tab character.
 * A browser makes every run of white space in a title one space, so a title
 * holds no tab and no line break. The lists are read in one go inside the
 * browser, and the lines are made outside it, where "tab" is no word of the
 * browser's dictionary.
 */
export function tabsScript(browser: SupportedBrowser) {
  const [count, title, active] =
    browser.family === "safari"
      ? ["(count of documents)", "name", "index of current tab of front window"]
      : ["(count of windows)", "title", "active tab index of front window"];
  return `on run argv
  try
    tell ${named(browser)}
      if ${count} is 0 then return "clawdtime:no-window"
      set theAddresses to URL of every tab of front window
      set theTitles to ${title} of every tab of front window
      set theActive to ${active}
    end tell
    set theSeparator to character id 9
    set theReport to ""
    repeat with theIndex from 1 to (count of theAddresses)
      set theAddress to item theIndex of theAddresses
      if theAddress is missing value then set theAddress to ""
      set theTitle to item theIndex of theTitles
      if theTitle is missing value then set theTitle to ""
      set theReport to theReport & theIndex & theSeparator & (theIndex = theActive) & theSeparator & theAddress & theSeparator & theTitle & linefeed
    end repeat
    return theReport
${failure}
end run`;
}

/**
 * Brings the tab at the place of the first argument to the front of the
 * front window. The browser itself does not come forward: the person keeps
 * the app that they use.
 */
export function switchTabScript(browser: SupportedBrowser) {
  const [count, move] =
    browser.family === "safari"
      ? [
          "(count of documents)",
          "set current tab of front window to tab theIndex of front window",
        ]
      : [
          "(count of windows)",
          "set active tab index of front window to theIndex",
        ];
  return `on run argv
  try
    set theIndex to (item 1 of argv) as integer
    tell ${named(browser)}
      if ${count} is 0 then return "clawdtime:no-window"
      if theIndex > (count of tabs of front window) then return "clawdtime:no-tab"
      ${move}
    end tell
    return "clawdtime:switched"
${failure}
end run`;
}

/** The most tabs of one window in a list. */
const mostTabs = 100;
/** The lines of the tabs script. A line in another shape is left out. */
function tabsOf(printed: string, browser: SupportedBrowser): BrowserTab[] {
  const tabs: BrowserTab[] = [];
  for (const row of printed.split("\n")) {
    const match = /^(\d{1,4})\t(true|false)\t([^\t]*)\t(.*)$/.exec(row);
    if (!match) continue;
    tabs.push({
      index: Number(match[1]),
      title: oneLine(match[4], pageLimits.title),
      url: oneLine(match[3], pageLimits.link),
      active: match[2] === "true",
    });
  }
  if (!tabs.length) throw new Error(unreadable(browser));
  return tabs.slice(0, mostTabs);
}
/** Text as a wait compares it: one line, in small letters. */
const folded = (value: string) => oneLine(value, 20_000).toLowerCase();

/** What the page script answers. The limits are checked again here: a page is not trusted. */
const elementSchema = z
  .object({
    index: z.number().int().positive(),
    tag: z.string().max(40),
    role: z.string().max(40),
    label: z.string().max(pageLimits.label),
    value: z.string().max(pageLimits.value).optional(),
    href: z.string().max(pageLimits.link).optional(),
    disabled: z.boolean(),
    password: z.boolean(),
  })
  .strict();
const answerSchema = z.union([
  z.object({ ok: z.literal(false), error: z.string().max(4000) }).strict(),
  z
    .object({
      ok: z.literal(true),
      ready: z.boolean().optional(),
      next: z.number().int().positive().optional(),
      page: z
        .object({
          title: z.string().max(pageLimits.title),
          url: z.string().max(pageLimits.address),
          text: z.string().max(pageLimits.text),
          elements: z.array(elementSchema).max(pageLimits.elements),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

/** One answer of the page script, as checked. */
export type PageAnswer = z.infer<typeof answerSchema>;
/** The reading in an answer of the page script. */
export type PageReading = NonNullable<
  Extract<PageAnswer, { ok: true }>["page"]
>;

/**
 * Reads one answer of the page script. A page is not trusted: text that is
 * not exactly an answer that the script gives is null.
 */
export function parsePageAnswer(text: string): PageAnswer | null {
  try {
    return answerSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The page of one reading. A password field never carries its value: the
 * page script never sends it, and a page that tampers with the answer
 * cannot either.
 */
export function pageOfReading(
  browser: BrowserPage["browser"],
  reading: PageReading,
): BrowserPage {
  const elements = reading.elements.map((element): BrowserElement => {
    if (!element.password) return element;
    const { value: _secret, ...rest } = element;
    return rest;
  });
  return { browser, ...reading, elements };
}

const refusal = (result: { reason: string; closed?: true }) =>
  result.closed ? new BrowserClosed(result.reason) : new Error(result.reason);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The name of the switch for the browser drivers. */
export const browserSwitch = "CLAWDTIME_COMPUTER_BROWSER";

/**
 * The driver, when the person turned one on. "on" drives the browser in
 * front, the person's own, with their sign-ins, through its scripting door.
 * "own" drives ClawdTime's own browser, with its own profile, which starts
 * at the first browser step. Any other value is off. Making a driver starts
 * nothing.
 */
export function browserFromEnvironment(
  env: Record<string, string | undefined>,
  make: () => BrowserPort = () => new AppleEventsBrowser(),
  makeOwn: () => BrowserPort = () => new OwnBrowser({ env }),
): BrowserPort | undefined {
  const chosen = env[browserSwitch];
  return chosen === "on" ? make() : chosen === "own" ? makeOwn() : undefined;
}

export class AppleEventsBrowser implements BrowserPort {
  /** Names this driver to the page, which keeps its numbers apart from those of another driver. */
  readonly session = randomBytes(6).toString("hex");
  /** One above the highest number that any reading gave out. */
  private next = 1;

  constructor(
    private readonly run: CommandRunner = runCommand,
    private readonly clock: BrowserClock = systemClock,
  ) {}

  async doctor(): Promise<{
    ok: boolean;
    browser: string | null;
    reason: string;
  }> {
    const browser = await this.front();
    if (browser === "unknown")
      return { ok: false, browser: null, reason: noProbe };
    if (!browser) return { ok: false, browser: null, reason: noBrowser };
    try {
      await this.ask(browser, { do: "ping" });
    } catch (error) {
      return { ok: false, browser: browser.name, reason: messageOf(error) };
    }
    return {
      ok: true,
      browser: browser.name,
      reason: `${browser.name} can be read and operated.`,
    };
  }

  /** Opens a web address in a new tab. Anything but http and https is refused. */
  async open(url: string): Promise<BrowserPage> {
    const address = webAddress(url);
    if (address.length > pageLimits.address)
      throw new Error("The address is too long to open.");
    const browser = await this.chosen();
    const result = this.outcome(
      browser,
      await this.command(["-e", openScript(browser), address]),
    );
    if ("reason" in result) throw refusal(result);
    if (result.text !== "clawdtime:opened")
      throw new Error(unreadable(browser));
    // A new tab holds an empty first document until the address answers.
    return this.settled(browser, (page) => /^https?:/i.test(page.url));
  }

  async read(): Promise<BrowserPage> {
    return (await this.look(await this.chosen())).page;
  }

  async click(index: number): Promise<BrowserPage> {
    return this.step({ do: "click", index: numbered(index) });
  }

  /**
   * Sets the text of a field, chooses in a select by the text of a choice, or
   * adds the text at the end of an editable region. With `submit`, the form of
   * the field is submitted, or Return is sent when it has no form.
   */
  async type(
    index: number,
    text: string,
    submit: boolean,
  ): Promise<BrowserPage> {
    const call: PageCall = {
      do: "type",
      index: numbered(index),
      text: String(text),
      submit: submit === true,
    };
    if (pageHelpers.encode(call.text).length > mostTextBytes)
      throw new Error(
        "The text is too long for one step: send it in smaller parts.",
      );
    return this.step(call);
  }

  async scroll(direction: "down" | "up"): Promise<BrowserPage> {
    if (direction !== "down" && direction !== "up")
      throw new Error("A page scrolls down or up.");
    return this.step({ do: "scroll", direction });
  }

  async back(): Promise<BrowserPage> {
    return this.step({ do: "back" });
  }

  /** Moves the pointer over one element, with no click, then reads the page when it holds still. */
  async hover(index: number): Promise<BrowserPage> {
    return this.step({ do: "hover", index: numbered(index) });
  }

  /** Chooses one option of a list of choices by the text that it shows. */
  async select(index: number, option: string): Promise<BrowserPage> {
    const text = oneLine(typeof option === "string" ? option : "", 400);
    if (!text) throw new Error("Name the option by the text that it shows.");
    return this.step({ do: "select", index: numbered(index), option: text });
  }

  /** One key in the element of the page that has the focus. */
  async key(combo: string): Promise<BrowserPage> {
    const key = parsePageKey(typeof combo === "string" ? combo : "");
    if (!key)
      throw new Error(
        "A page takes Enter, Escape, Tab, Shift+Tab, the arrow keys, PageUp, PageDown, Home, End, Backspace or Space.",
      );
    return this.step({ do: "key", combo: key });
  }

  /**
   * Reads the page until its visible text holds the words, or until the time
   * is up, and says which. With no words it waits until the page is ready
   * and the same in two readings in a row. It changes nothing on the page.
   */
  async waitFor(text: string | null, ms: number): Promise<BrowserPage> {
    if (!Number.isSafeInteger(ms) || ms < 100 || ms > 10_000)
      throw new Error("A wait takes 100 to 10000 milliseconds.");
    const wanted = text === null ? null : folded(String(text));
    if (wanted === "")
      throw new Error("Give the words to wait for, or leave them out.");
    const browser = await this.chosen();
    const from = this.clock.now();
    let last: BrowserPage | null = null;
    let failed: unknown = null;
    for (;;) {
      try {
        const seen = await this.look(browser);
        if (wanted !== null && folded(seen.page.text).includes(wanted))
          return { ...seen.page, found: true };
        const same =
          last !== null && JSON.stringify(last) === JSON.stringify(seen.page);
        if (wanted === null && seen.ready && same) return seen.page;
        last = seen.page;
      } catch (error) {
        // What was read before a failure is not the page now.
        last = null;
        failed = error;
      }
      const left = from + ms - this.clock.now();
      if (left <= 0) break;
      await this.clock.sleep(Math.min(browserTiming.lookEveryMs, left));
    }
    if (last) return wanted === null ? last : { ...last, found: false };
    throw failed;
  }

  /** The page of the tab in front, with the tabs of its window. */
  async tabs(): Promise<BrowserPage> {
    const browser = await this.chosen();
    const result = this.outcome(
      browser,
      await this.command(["-e", tabsScript(browser)]),
    );
    if ("reason" in result) throw refusal(result);
    const tabs = tabsOf(result.text, browser);
    const { page } = await this.look(browser);
    return { ...page, tabs };
  }

  /** Brings one tab of the front window to the front, by its place, then reads it when it is ready. */
  async switchTab(tab: number): Promise<BrowserPage> {
    if (!Number.isSafeInteger(tab) || tab < 1 || tab > 9999)
      throw new Error("Give the number of a tab from the last list of tabs.");
    const browser = await this.chosen();
    const result = this.outcome(
      browser,
      await this.command(["-e", switchTabScript(browser), String(tab)]),
    );
    if ("reason" in result) throw refusal(result);
    if (result.text === "clawdtime:no-tab")
      throw new Error(
        "That tab is not in the front window any more: list the tabs again.",
      );
    if (result.text !== "clawdtime:switched")
      throw new Error(unreadable(browser));
    return this.settled(browser);
  }

  /** One step that changes the page, then the page when it is ready again. */
  private async step(call: PageCall) {
    const browser = await this.chosen();
    await this.ask(browser, call);
    return this.settled(browser);
  }

  private async command(args: string[]): Promise<CommandOutput> {
    try {
      return await this.run(osascript, args, browserTiming.callMs);
    } catch {
      return { status: null, stdout: "" };
    }
  }

  /** The supported browser in front, or the first of the list that is open. */
  private async front(): Promise<SupportedBrowser | "unknown" | null> {
    const output = await this.command([
      "-e",
      probeScript,
      ...supportedBrowsers.map((browser) => browser.id),
    ]);
    if (output.status !== 0) return "unknown";
    const open = new Set<SupportedBrowser>();
    let front: SupportedBrowser | null = null;
    for (const line of output.stdout.split("\n")) {
      const match = /^(front|open) (\S+)$/.exec(line.trim());
      const browser = supportedBrowsers.find((item) => item.id === match?.[2]);
      if (!browser) continue;
      open.add(browser);
      if (match?.[1] === "front") front ??= browser;
    }
    return front ?? supportedBrowsers.find((item) => open.has(item)) ?? null;
  }

  private async chosen() {
    const browser = await this.front();
    if (browser === "unknown") throw new Error(noProbe);
    if (!browser) throw new Error(noBrowser);
    return browser;
  }

  /** The text that the command printed, or the reason why the browser did not do it. */
  private outcome(
    browser: SupportedBrowser,
    output: CommandOutput,
  ): { text: string } | { reason: string; closed?: true } {
    if (output.status === null)
      return { reason: reasonFor("timed_out", browser) };
    // osascript ends what it prints with one line break.
    const printed = output.stdout.replace(/\r?\n$/, "");
    const marked = /^clawdtime:error:(-?\d+):([\s\S]*)$/.exec(printed);
    if (marked || output.status !== 0) {
      const text = marked ? marked[2]! : `${output.stderr ?? ""} ${printed}`;
      const number = marked
        ? Number(marked[1])
        : Number(/\((-?\d+)\)\s*$/.exec(text)?.[1] ?? Number.NaN);
      const trouble = troubleOf(Number.isFinite(number) ? number : null, text);
      if (trouble)
        return {
          reason: reasonFor(trouble, browser),
          // Only the person opens these two doors, in settings.
          ...(trouble === "javascript_off" || trouble === "automation_denied"
            ? { closed: true as const }
            : {}),
        };
      const detail =
        oneLine(marked ? `${text} (${number})` : text, 200) ||
        `osascript ended with status ${output.status}.`;
      return {
        reason: `${browser.name} gave an error that ClawdTime does not know: ${detail}`,
      };
    }
    if (printed === "clawdtime:no-window")
      return { reason: reasonFor("no_window", browser) };
    if (printed === "clawdtime:no-answer")
      return { reason: reasonFor("no_answer", browser) };
    return { text: printed };
  }

  /** One call into the page. It throws the reason when the door is closed or the page refuses. */
  private async ask(browser: SupportedBrowser, call: PageCall) {
    const script = pageScript(call, {
      session: this.session,
      start: this.next,
    });
    const result = this.outcome(
      browser,
      await this.command(["-e", runScript(browser), script]),
    );
    if ("reason" in result) throw refusal(result);
    const answer = parsePageAnswer(result.text);
    if (!answer) throw new Error(unreadable(browser));
    if (!answer.ok) throw new Error(oneLine(answer.error, 300));
    if (answer.next !== undefined) this.next = Math.max(this.next, answer.next);
    return answer;
  }

  /** One reading of the page as it is now. */
  private async look(browser: SupportedBrowser) {
    const answer = await this.ask(browser, { do: "read" });
    if (!answer.page) throw new Error(unreadable(browser));
    const page = pageOfReading(browser.family, answer.page);
    return { ready: answer.ready === true, page };
  }

  /**
   * Waits until the page is ready again: loaded, not on its way out, and the
   * same in two readings in a row. The wait has an end. When it comes, the
   * last reading is the answer, or the failure when the last look failed.
   */
  private async settled(
    browser: SupportedBrowser,
    fits: (page: BrowserPage) => boolean = () => true,
  ): Promise<BrowserPage> {
    const from = this.clock.now();
    let last: BrowserPage | null = null;
    let failed: unknown = null;
    await this.clock.sleep(browserTiming.firstLookMs);
    for (;;) {
      try {
        const seen = await this.look(browser);
        const same =
          last !== null && JSON.stringify(last) === JSON.stringify(seen.page);
        if (seen.ready && same && fits(seen.page)) return seen.page;
        last = seen.page;
      } catch (error) {
        // What was read before a failure is not the page now.
        last = null;
        failed = error;
      }
      const left = from + browserTiming.waitMs - this.clock.now();
      if (left <= 0) break;
      await this.clock.sleep(Math.min(browserTiming.lookEveryMs, left));
    }
    if (last) return last;
    throw failed;
  }
}

function numbered(index: number) {
  if (!Number.isSafeInteger(index) || index < 1)
    throw new Error(
      "Give the number of an element from the last reading of the page.",
    );
  return index;
}
