import { describe, expect, it } from "vitest";
import type { Runner } from "../connectors/agents/focus.js";
import {
  AppleEventsBrowser,
  browserErrors,
  browserFromEnvironment,
  browserSwitch,
  browserTiming,
  openScript,
  osascript,
  probeScript,
  runCommand,
  runScript,
  supportedBrowsers,
  switchTabScript,
  tabsScript,
  type BrowserClock,
  type CommandOutput,
  type CommandRunner,
} from "../connectors/computer/browser.js";
import {
  pageScript,
  type PageCall,
} from "../connectors/computer/browser-script.js";
import { BrowserInputUnknown } from "../connectors/computer/own-browser.js";
import {
  BrowserClosed,
  type BrowserPort,
} from "../connectors/computer/ports.js";

/**
 * No test here runs osascript or touches a browser. The command runner is
 * recorded: each test reads the exact argument list that would run, and
 * decides what "the browser" prints. The page script itself is proven in
 * connectors-computer-browser-script.test.ts, against a hand-made document.
 */
interface Call {
  command: string;
  args: string[];
  timeoutMs: number;
}
type Reply = string | CommandOutput;

const chrome = supportedBrowsers.find((item) => item.name === "Google Chrome")!;
const safari = supportedBrowsers.find((item) => item.name === "Safari")!;
const brave = supportedBrowsers.find((item) => item.name === "Brave Browser")!;

function fakeClock(start = 50_000) {
  let time = start;
  const slept: number[] = [];
  const clock: BrowserClock = {
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
  };
  return {
    clock,
    slept,
    pass: (ms: number) => {
      time += ms;
    },
  };
}

/**
 * A browser on paper. The probe gets `open`, the lines that say which
 * browsers run. Every other command gets the next reply of the list, and the
 * last reply again when the list is used up.
 */
function paper(replies: Reply[], options: { open?: string } = {}) {
  const calls: Call[] = [];
  let next = 0;
  const run: CommandRunner = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    if (args[1] === probeScript)
      return { status: 0, stdout: options.open ?? `front ${chrome.id}\n` };
    const reply = replies[Math.min(next, replies.length - 1)] ?? "";
    next += 1;
    return typeof reply === "string"
      ? { status: 0, stdout: `${reply}\n` }
      : reply;
  };
  const steps = fakeClock();
  const browser = new AppleEventsBrowser(run, steps.clock);
  return {
    browser,
    calls,
    slept: steps.slept,
    pass: steps.pass,
    /** The calls after the probe. */
    sent: () => calls.filter((call) => call.args[1] !== probeScript),
    script: (call: PageCall, start = 1) =>
      pageScript(call, { session: browser.session, start }),
  };
}

const button = {
  index: 1,
  tag: "button",
  role: "button",
  label: "Save",
  disabled: false,
  password: false,
};
const page = (values: Record<string, unknown> = {}) => ({
  title: "Orders",
  url: "https://example.test/orders",
  text: "Three orders wait.",
  elements: [button],
  ...values,
});
const reading = (
  values: Record<string, unknown> = {},
  more: { ready?: boolean; next?: number } = {},
) =>
  JSON.stringify({
    ok: true,
    ready: more.ready ?? true,
    next: more.next ?? 2,
    page: page(values),
  });
const done = JSON.stringify({ ok: true });
const marked = (number: number, text: string) =>
  `clawdtime:error:${number}:${text}`;

describe("the browser driver: the commands that run", () => {
  it("is a browser port with a constructor that needs no argument", () => {
    const port: BrowserPort = new AppleEventsBrowser();
    expect(port).toBeInstanceOf(AppleEventsBrowser);
    expect(new AppleEventsBrowser().session).not.toBe(
      new AppleEventsBrowser().session,
    );
  });

  it("takes the command runner of the other connectors, which carries no error text", async () => {
    const runner: Runner = async (_command, args) => ({
      status: 0,
      stdout:
        args[1] === probeScript
          ? `front ${chrome.id}\n`
          : `${marked(-1743, "Not authorized to send Apple events to Google Chrome.")}\n`,
    });
    const browser = new AppleEventsBrowser(runner, fakeClock().clock);
    // A failure of the browser comes back as printed text, so it is still known.
    expect((await browser.doctor()).reason).toMatch(
      /^macOS has not allowed the automation of Google Chrome/,
    );
  });

  it("asks which supported browsers are open with one argument list and no shell", async () => {
    const { browser, calls } = paper([reading()]);
    await browser.read();
    expect(osascript).toBe("/usr/bin/osascript");
    expect(calls[0]).toEqual({
      command: "/usr/bin/osascript",
      args: [
        "-e",
        probeScript,
        "com.google.Chrome",
        "com.apple.Safari",
        "com.brave.Browser",
        "com.microsoft.edgemac",
        "org.chromium.Chromium",
        "com.google.Chrome.beta",
        "com.google.Chrome.dev",
        "com.google.Chrome.canary",
      ],
      timeoutMs: 8000,
    });
    expect(supportedBrowsers.map((item) => item.name)).toEqual([
      "Google Chrome",
      "Safari",
      "Brave Browser",
      "Microsoft Edge",
      "Chromium",
      "Google Chrome Beta",
      "Google Chrome Dev",
      "Google Chrome Canary",
    ]);
    // The probe names no browser in its text, so it compiles on a Mac that lacks one.
    expect(probeScript).toBe(`on run argv
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
end run`);
  });

  it("reads the page with one script as one argument", async () => {
    const { browser, calls, script, slept } = paper([reading()]);
    expect(await browser.read()).toEqual({ browser: "chrome", ...page() });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", runScript(chrome), script({ do: "read" })],
      timeoutMs: 8000,
    });
    // Reading changes nothing, so it waits for nothing.
    expect(slept).toEqual([]);
    expect(runScript(chrome)).toBe(`on run argv
  set thePageScript to item 1 of argv
  try
    tell application id "com.google.Chrome"
      if (count of windows) is 0 then return "clawdtime:no-window"
      set theAnswer to execute active tab of front window javascript thePageScript
    end tell
    if theAnswer is missing value then return "clawdtime:no-answer"
    return theAnswer as text
  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try
end run`);
    expect(runScript(safari)).toBe(`on run argv
  set thePageScript to item 1 of argv
  try
    tell application id "com.apple.Safari"
      if (count of documents) is 0 then return "clawdtime:no-window"
      set theAnswer to do JavaScript thePageScript in front document
    end tell
    if theAnswer is missing value then return "clawdtime:no-answer"
    return theAnswer as text
  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try
end run`);
  });

  it("never puts the page script, the text or the address inside the script of the command", async () => {
    const { browser, sent, script } = paper([done, reading(), reading()]);
    const text = '" & (do shell script "id") & "\n$(id) `id` ; \\';
    await browser.type(1, text, true);
    const [typed] = sent();
    expect(typed!.args).toEqual([
      "-e",
      runScript(chrome),
      script({ do: "type", index: 1, text, submit: true }),
    ]);
    // The script of the command is the same text for every call to this browser.
    for (const call of sent()) expect(call.args[1]).toBe(runScript(chrome));
    expect(typed!.args[1]).not.toContain("shell script");
    // What travels is plain characters, and it does not start as an option.
    expect(typed!.args[2]).toMatch(/^\(function \(call\) \{[\x20-\x7e\n]*\)$/);
    for (const call of sent()) {
      expect(call.command).toBe("/usr/bin/osascript");
      expect(call.args).toHaveLength(3);
      expect(call.args[0]).toBe("-e");
    }
  });

  it("sends each step as its own call, then reads the page", async () => {
    const steps: [(browser: BrowserPort) => Promise<unknown>, PageCall][] = [
      [(browser) => browser.click(1), { do: "click", index: 1 }],
      [
        (browser) => browser.type(1, "tea", false),
        { do: "type", index: 1, text: "tea", submit: false },
      ],
      [
        (browser) => browser.scroll("down"),
        { do: "scroll", direction: "down" },
      ],
      [(browser) => browser.scroll("up"), { do: "scroll", direction: "up" }],
      [(browser) => browser.back(), { do: "back" }],
    ];
    for (const [step, call] of steps) {
      const { browser, sent, script } = paper([done, reading()]);
      expect(await step(browser)).toEqual({ browser: "chrome", ...page() });
      expect(sent().map((item) => item.args[2])).toEqual([
        script(call),
        script({ do: "read" }),
        script({ do: "read" }, 2),
      ]);
    }
  });

  it("opens only a web address, in a new tab of the browser in front", async () => {
    const { browser, calls, sent, script } = paper([
      "clawdtime:opened",
      reading({ url: "https://trychert.com/pricing" }),
    ]);
    expect(await browser.open("https://trychert.com/pricing")).toEqual({
      browser: "chrome",
      ...page({ url: "https://trychert.com/pricing" }),
    });
    expect(sent()[0]).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", openScript(chrome), "https://trychert.com/pricing"],
      timeoutMs: 8000,
    });
    expect(sent()[1]!.args).toEqual([
      "-e",
      runScript(chrome),
      script({ do: "read" }),
    ]);
    expect(openScript(chrome)).toBe(`on run argv
  set theAddress to item 1 of argv
  try
    tell application id "com.google.Chrome"
      if (count of windows) is 0 then
        make new window
        set URL of active tab of front window to theAddress
      else
        tell front window to make new tab with properties {URL:theAddress}
      end if
      activate
    end tell
    return "clawdtime:opened"
  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try
end run`);
    expect(openScript(safari)).toBe(`on run argv
  set theAddress to item 1 of argv
  try
    tell application id "com.apple.Safari"
      if (count of documents) is 0 then
        make new document with properties {URL:theAddress}
      else
        tell front window to set current tab to (make new tab with properties {URL:theAddress})
      end if
      activate
    end tell
    return "clawdtime:opened"
  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try
end run`);
    const before = calls.length;
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not an address",
      "-e",
      `https://example.test/${"a".repeat(2100)}`,
    ])
      await expect(browser.open(bad)).rejects.toThrow();
    expect(calls).toHaveLength(before);
  });

  it("refuses a number, a direction or a text that cannot be sent, before any command runs", async () => {
    const { browser, calls } = paper([done, reading()]);
    const number =
      "Give the number of an element from the last reading of the page.";
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(browser.click(bad)).rejects.toThrow(number);
      await expect(browser.type(bad, "x", false)).rejects.toThrow(number);
    }
    await expect(browser.scroll("sideways" as "down")).rejects.toThrow(
      "A page scrolls down or up.",
    );
    await expect(
      browser.type(1, "\u65e5".repeat(100_000), false),
    ).rejects.toThrow(
      "The text is too long for one step: send it in smaller parts.",
    );
    expect(calls).toEqual([]);
    // A long text that fits travels whole.
    const long = `${"long text \u00e9 ".repeat(5000)}end`;
    await browser.type(1, long, false);
    const typed = calls.find((call) => call.args[2]?.includes("long text"))!;
    expect(typed.args[2]).toBe(
      pageScript(
        { do: "type", index: 1, text: long, submit: false },
        { session: browser.session, start: 1 },
      ),
    );
  });
});

describe("the browser driver: which browser", () => {
  it("drives the browser in front, and the first of the list when none is in front", async () => {
    const cases: [string, string, "chrome" | "safari"][] = [
      [`open ${chrome.id}\nfront ${safari.id}\n`, runScript(safari), "safari"],
      [`open ${safari.id}\nopen ${chrome.id}\n`, runScript(chrome), "chrome"],
      [`open ${brave.id}\nopen ${safari.id}\n`, runScript(safari), "safari"],
      [`front ${brave.id}\nopen ${chrome.id}\n`, runScript(brave), "chrome"],
      // Lines that are not of the probe are not believed.
      [
        `front com.example.Other\nnoise\nopen ${safari.id}\n`,
        runScript(safari),
        "safari",
      ],
    ];
    for (const [open, script, family] of cases) {
      const { browser, sent } = paper([reading()], { open });
      expect((await browser.read()).browser).toBe(family);
      expect(sent()[0]!.args[1]).toBe(script);
    }
    expect(runScript(brave)).toContain(
      'tell application id "com.brave.Browser"',
    );
    expect(runScript(brave).replace(brave.id, chrome.id)).toBe(
      runScript(chrome),
    );
  });

  it("says so when no supported browser is open, and drives nothing", async () => {
    const none =
      "No supported browser is open: open Google Chrome or Safari, then try again.";
    const { browser, calls } = paper([reading()], { open: "\n" });
    await expect(browser.read()).rejects.toThrow(none);
    await expect(browser.click(1)).rejects.toThrow(none);
    await expect(browser.open("https://trychert.com")).rejects.toThrow(none);
    expect(calls.every((call) => call.args[1] === probeScript)).toBe(true);
    expect(await browser.doctor()).toEqual({
      ok: false,
      browser: null,
      reason: none,
    });
  });
});

describe("the browser driver: doctor", () => {
  const doctor = async (reply: Reply, open = `front ${chrome.id}\n`) => {
    const { browser, sent, script } = paper([reply], { open });
    const result = await browser.doctor();
    // The doctor asks the page for nothing but a sign of life.
    expect(sent().map((call) => call.args[2])).toEqual([
      script({ do: "ping" }),
    ]);
    return result;
  };
  const chromeOff =
    "Google Chrome does not take page scripts yet: in Google Chrome, choose View > Developer > Allow JavaScript from Apple Events.";
  const safariOff =
    'Safari does not take page scripts yet: in Safari > Settings > Advanced, switch on "Show features for web developers", then in Safari > Settings > Developer, switch on "Allow JavaScript from Apple Events".';

  it("says that the browser can be driven", async () => {
    expect(await doctor(done)).toEqual({
      ok: true,
      browser: "Google Chrome",
      reason: "Google Chrome can be read and operated.",
    });
    expect(await doctor(done, `front ${safari.id}\n`)).toEqual({
      ok: true,
      browser: "Safari",
      reason: "Safari can be read and operated.",
    });
  });

  it("names the menu path when the browser does not allow scripts from Apple events", async () => {
    expect(
      await doctor(
        marked(
          12,
          "Google Chrome got an error: Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events. For more information: https://support.google.com/chrome/?p=applescript",
        ),
      ),
    ).toEqual({ ok: false, browser: "Google Chrome", reason: chromeOff });
    expect(
      await doctor(
        marked(
          12,
          "Brave Browser got an error: Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.",
        ),
        `front ${brave.id}\n`,
      ),
    ).toEqual({
      ok: false,
      browser: "Brave Browser",
      reason: chromeOff.replaceAll("Google Chrome", "Brave Browser"),
    });
    for (const text of [
      "Safari got an error: You must enable 'Allow JavaScript from Apple Events' in the Developer section of Safari Settings to use 'do JavaScript'.",
      "Safari got an error: You must enable the 'Allow JavaScript from Apple Events' option in Safari's Develop menu to use 'do JavaScript'.",
    ])
      expect(await doctor(marked(8, text), `front ${safari.id}\n`)).toEqual({
        ok: false,
        browser: "Safari",
        reason: safariOff,
      });
  });

  it("says that macOS has not allowed automation of the browser", async () => {
    const reason =
      "macOS has not allowed the automation of Google Chrome: in System Settings > Privacy & Security > Automation, switch on Google Chrome under the app that runs ClawdTime.";
    expect(
      await doctor(
        marked(-1743, "Not authorized to send Apple events to Google Chrome."),
      ),
    ).toEqual({ ok: false, browser: "Google Chrome", reason });
    // The same failure when the command itself ends with it.
    expect(
      await doctor({
        status: 1,
        stdout: "",
        stderr:
          "166:231: execution error: Not authorized to send Apple events to Google Chrome. (-1743)\n",
      }),
    ).toEqual({ ok: false, browser: "Google Chrome", reason });
    // A number alone is enough, in any language of macOS.
    expect((await doctor(marked(-1743, "Nicht autorisiert."))).reason).toBe(
      reason,
    );
  });

  it("names every other case that it knows", async () => {
    const cases: [Reply, string][] = [
      [
        { status: null, stdout: "" },
        "Google Chrome did not answer in time: if macOS asks whether Google Chrome may be controlled, allow it, then try again.",
      ],
      [
        marked(-1712, "Google Chrome got an error: AppleEvent timed out."),
        "Google Chrome did not answer in time: if macOS asks whether Google Chrome may be controlled, allow it, then try again.",
      ],
      [
        marked(
          -600,
          "Google Chrome got an error: Application isn\u2019t running.",
        ),
        "Google Chrome is not open any more: open it, then try again.",
      ],
      // By its text alone, with the apostrophe that macOS prints.
      [
        marked(
          0,
          "Google Chrome got an error: Application isn\u2019t running.",
        ),
        "Google Chrome is not open any more: open it, then try again.",
      ],
      [
        "clawdtime:no-window",
        "Google Chrome has no window open: open a page in it, then try again.",
      ],
      [
        marked(
          -1719,
          "Google Chrome got an error: Can\u2019t get window 1. Invalid index.",
        ),
        "Google Chrome has no window open: open a page in it, then try again.",
      ],
      [
        "clawdtime:no-answer",
        "Google Chrome cannot run a script on the page in front, which is one of its own pages: open a web page, then try again.",
      ],
      [
        marked(-2753, "The variable theAnswer is not defined."),
        "Google Chrome cannot run a script on the page in front, which is one of its own pages: open a web page, then try again.",
      ],
    ];
    for (const [reply, reason] of cases)
      expect(await doctor(reply)).toEqual({
        ok: false,
        browser: "Google Chrome",
        reason,
      });
  });

  it("shows an error that it does not know, as one clean line", async () => {
    expect(
      await doctor(
        marked(
          -10000,
          "Google Chrome got an error:\n AppleEvent handler failed.",
        ),
      ),
    ).toEqual({
      ok: false,
      browser: "Google Chrome",
      reason:
        "Google Chrome gave an error that ClawdTime does not know: Google Chrome got an error: AppleEvent handler failed. (-10000)",
    });
    expect(
      (
        await doctor({
          status: 1,
          stdout: "",
          stderr: `0:5: syntax error: ${"x".repeat(500)}`,
        })
      ).reason,
    ).toHaveLength(
      "Google Chrome gave an error that ClawdTime does not know: ".length + 200,
    );
    expect((await doctor("<html>not an answer")).reason).toBe(
      "Google Chrome gave an answer that ClawdTime could not read: read the page again.",
    );
    expect((await doctor({ status: 1, stdout: "" })).reason).toBe(
      "Google Chrome gave an error that ClawdTime does not know: osascript ended with status 1.",
    );
  });

  it("says so when macOS does not tell which browsers are open, and never throws", async () => {
    const reason =
      "macOS did not say which browsers are open: try again in a moment.";
    for (const run of [
      async () => ({ status: 1, stdout: "" }),
      async () => ({ status: null, stdout: "" }),
      async () => {
        throw new Error("spawn failed");
      },
    ] satisfies CommandRunner[]) {
      const browser = new AppleEventsBrowser(run, fakeClock().clock);
      expect(await browser.doctor()).toEqual({
        ok: false,
        browser: null,
        reason,
      });
      await expect(browser.read()).rejects.toThrow(reason);
    }
  });

  it("marks the two errors that only the person can clear, and no other", async () => {
    const failing = (printed: string | null): CommandRunner => {
      return async (_command, args) =>
        args[1] === probeScript
          ? { status: 0, stdout: `front ${chrome.id}\n`, stderr: "" }
          : printed === null
            ? { status: null, stdout: "", stderr: "" }
            : { status: 0, stdout: printed, stderr: "" };
    };
    const thrown = async (printed: string | null) => {
      const browser = new AppleEventsBrowser(
        failing(printed),
        fakeClock().clock,
      );
      return browser.read().then(
        () => null,
        (error: unknown) => error,
      );
    };
    // Scripts from Apple events are off in the browser, and macOS refuses this program.
    for (const printed of [
      "clawdtime:error:12:Google Chrome got an error: Executing JavaScript through AppleScript is turned off.",
      "clawdtime:error:-1743:Not authorized to send Apple events to Google Chrome.",
    ])
      expect(await thrown(printed)).toBeInstanceOf(BrowserClosed);
    // What can change in a moment is an error, and not that one.
    for (const printed of [
      "clawdtime:error:-600:Application isn't running.",
      "clawdtime:no-window",
      "clawdtime:no-answer",
      "clawdtime:error:-1:Something new.",
      null,
    ]) {
      const error = await thrown(printed);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BrowserClosed);
    }
  });

  it("keeps the real error texts in one table", () => {
    expect(browserErrors).toEqual([
      {
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
        trouble: "no_answer",
        numbers: [-2753, -2763],
        texts: [
          "The variable theAnswer is not defined",
          "No result was returned",
        ],
      },
    ]);
  });
});

describe("the browser driver: what the page answers", () => {
  it("gives the error of the page as it is, and waits for nothing", async () => {
    const error =
      "Number 7 is not on the page any more. Read the page again and use a number from that reading.";
    const { browser, sent, slept } = paper([
      JSON.stringify({ ok: false, error }),
    ]);
    await expect(browser.click(7)).rejects.toThrow(error);
    expect(sent()).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("gives the reason of the doctor when a step meets a closed door", async () => {
    const { browser } = paper([
      marked(-1743, "Not authorized to send Apple events to Google Chrome."),
    ]);
    await expect(browser.read()).rejects.toThrow(
      "macOS has not allowed the automation of Google Chrome: in System Settings > Privacy & Security > Automation, switch on Google Chrome under the app that runs ClawdTime.",
    );
    await expect(browser.click(1)).rejects.toThrow(/Privacy & Security/);
    await expect(browser.open("https://trychert.com")).rejects.toThrow(
      /Privacy & Security/,
    );
  });

  it("never passes on the value of a password field, whatever the page says", async () => {
    const { browser } = paper([
      reading({
        elements: [
          { ...button, tag: "input", password: true, value: "hunter2" },
          { ...button, index: 2, tag: "input", value: "anish" },
        ],
      }),
    ]);
    const result = await browser.read();
    expect(result.elements[0]).toEqual({
      ...button,
      tag: "input",
      password: true,
    });
    expect(result.elements[1]!.value).toBe("anish");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("refuses an answer that is not a reading inside the limits", async () => {
    const unreadable =
      "Google Chrome gave an answer that ClawdTime could not read: read the page again.";
    for (const bad of [
      "",
      "missing value",
      "{",
      JSON.stringify({ ok: true }),
      JSON.stringify({ ok: true, ready: true, next: 2 }),
      reading({ text: "x".repeat(6001) }),
      reading({ title: 5 }),
      reading({ elements: Array.from({ length: 201 }, () => button) }),
      reading({ elements: [{ ...button, label: "x".repeat(121) }] }),
      reading({ elements: [{ ...button, index: 0 }] }),
      reading({ elements: [{ ...button, extra: "field" }] }),
      reading({ more: "than a page" }),
    ]) {
      const { browser } = paper([bad]);
      await expect(browser.read()).rejects.toThrow(unreadable);
    }
    // The error of a page is one clean line of bounded length.
    const { browser } = paper([
      JSON.stringify({ ok: false, error: `Stop.\n${"x".repeat(900)}` }),
    ]);
    const failure = await browser.read().catch((error: Error) => error.message);
    expect(failure).toHaveLength(300);
    expect(failure).toMatch(/^Stop\. x+$/);
  });

  it("tells the page to number new elements above every number that it gave out", async () => {
    const { browser, sent, script } = paper([
      reading({}, { next: 43 }),
      done,
      reading({}, { next: 43 }),
      reading({}, { next: 60 }),
      reading({}, { next: 5 }),
    ]);
    await browser.read();
    await browser.click(41);
    await browser.read();
    await browser.read();
    expect(sent().map((call) => call.args[2])).toEqual([
      script({ do: "read" }, 1),
      script({ do: "click", index: 41 }, 43),
      script({ do: "read" }, 43),
      script({ do: "read" }, 43),
      script({ do: "read" }, 60),
      // A page that answers with a lower number does not bring the count down.
      script({ do: "read" }, 60),
    ]);
  });
});

describe("the browser driver: the wait after a step", () => {
  it("returns when the page is ready and two readings agree", async () => {
    const { browser, sent, slept } = paper([done, reading(), reading()]);
    await browser.click(1);
    expect(sent()).toHaveLength(3);
    expect(slept).toEqual([
      browserTiming.firstLookMs,
      browserTiming.lookEveryMs,
    ]);
    expect(browserTiming).toEqual({
      callMs: 8000,
      firstLookMs: 150,
      lookEveryMs: 250,
      waitMs: 3000,
    });
  });

  it("waits while the page leaves, loads or still changes, and returns the fresh reading", async () => {
    const old = { text: "The old page." };
    const fresh = { url: "https://example.test/next", text: "The new page." };
    const { browser, sent, slept } = paper([
      done,
      // The click started a navigation: the old page is on its way out.
      reading(old, { ready: false }),
      reading(old, { ready: false }),
      // The new document is there, and still loads.
      reading({ ...fresh, text: "" }, { ready: false }),
      // It is loaded, and its own script still adds content.
      reading({ ...fresh, text: "The new" }),
      reading(fresh),
      reading(fresh),
    ]);
    expect(await browser.click(1)).toEqual({
      browser: "chrome",
      ...page(fresh),
    });
    expect(sent()).toHaveLength(7);
    expect(slept).toEqual([150, 250, 250, 250, 250, 250]);
  });

  it("stops after about three seconds and returns the last reading", async () => {
    // A page that never is ready.
    const never = paper([done, reading({}, { ready: false })]);
    expect(await never.browser.click(1)).toEqual({
      browser: "chrome",
      ...page(),
    });
    expect(never.slept).toEqual([150, ...Array<number>(11).fill(250), 100]);
    expect(never.slept.reduce((sum, ms) => sum + ms, 0)).toBe(
      browserTiming.waitMs,
    );
    // The probe, the click, and thirteen readings.
    expect(never.calls).toHaveLength(15);
    // A page that is ready, where each reading differs from the one before.
    const restless = paper([
      done,
      ...Array.from({ length: 40 }, (_, at) => reading({ text: `tick ${at}` })),
    ]);
    expect((await restless.browser.click(1)).text).toBe("tick 12");
    expect(restless.calls).toHaveLength(15);
  });

  it("counts the time that the commands themselves take", async () => {
    const steps = fakeClock();
    const replies = [done];
    for (let at = 0; at < 40; at++)
      replies.push(reading({ text: `tick ${at}` }));
    let next = 0;
    let waitFrom = 0;
    const driver = new AppleEventsBrowser(async (_command, args) => {
      if (args[1] === probeScript)
        return { status: 0, stdout: `front ${chrome.id}\n` };
      // Each command takes 400 milliseconds.
      steps.pass(400);
      if (next === 0) waitFrom = steps.clock.now();
      return { status: 0, stdout: `${replies[next++]}\n` };
    }, steps.clock);
    await driver.click(1);
    const waited = steps.clock.now() - waitFrom;
    expect(waited).toBeGreaterThanOrEqual(browserTiming.waitMs);
    expect(waited).toBeLessThanOrEqual(browserTiming.waitMs + 400);
  });

  it("reads again after a failure, and gives the failure when the time is up", async () => {
    const between = "clawdtime:no-answer";
    const settled = paper([done, between, between, reading(), reading()]);
    expect((await settled.browser.click(1)).title).toBe("Orders");
    expect(settled.slept).toEqual([150, 250, 250, 250]);
    // A reading from before the failure is not the page now.
    const lost = paper([done, reading(), between]);
    await expect(lost.browser.click(1)).rejects.toThrow(
      "Google Chrome cannot run a script on the page in front, which is one of its own pages: open a web page, then try again.",
    );
    expect(lost.slept.reduce((sum, ms) => sum + ms, 0)).toBe(3000);
  });

  it("says that the result of an input is not known when its answer or the reading after it is lost", async () => {
    const between = "clawdtime:no-answer";
    const silent: CommandOutput = { status: null, stdout: "" };
    const lost = [
      // The click went out, and no reading after it worked.
      { replies: [done, between], run: (b: BrowserPort) => b.click(1) },
      { replies: [done, silent], run: (b: BrowserPort) => b.click(1) },
      // The click script itself timed out, or gave nothing back.
      { replies: [silent], run: (b: BrowserPort) => b.click(1) },
      {
        replies: [marked(-1712, "AppleEvent timed out.")],
        run: (b: BrowserPort) => b.type(1, "tea", true),
      },
      { replies: [between], run: (b: BrowserPort) => b.key!("Enter") },
      { replies: ["{"], run: (b: BrowserPort) => b.back() },
      {
        replies: [marked(-2700, "Something new.")],
        run: (b: BrowserPort) => b.select!(1, "Large"),
      },
      // An address that went out, and a switch of the tab.
      { replies: [silent], run: (b: BrowserPort) => b.open("https://a.test") },
      {
        replies: ["clawdtime:opened", between],
        run: (b: BrowserPort) => b.open("https://a.test"),
      },
      {
        replies: ["clawdtime:switched", silent],
        run: (b: BrowserPort) => b.switchTab!(2),
      },
    ];
    for (const { replies, run } of lost) {
      const { browser, sent } = paper(replies);
      const error = await run(browser).catch((failure: unknown) => failure);
      expect(error, JSON.stringify(replies)).toBeInstanceOf(
        BrowserInputUnknown,
      );
      expect((error as Error).message).toMatch(
        /Its result is not known, and it is not sent again\./,
      );
      // The input went out once, never again: the rest are readings.
      expect(
        sent().filter((call) => !String(call.args[2]).includes('"do":"read"')),
      ).toHaveLength(1);
    }
  });

  it("keeps a refusal before any input a plain error: nothing was sent", async () => {
    const refusals = [
      JSON.stringify({ ok: false, error: "Number 1 is disabled now." }),
      marked(-1743, "Not authorized to send Apple events to Google Chrome."),
      marked(12, "Executing JavaScript through AppleScript is turned off."),
      marked(-600, "Application isn't running."),
      "clawdtime:no-window",
    ];
    for (const reply of refusals) {
      const { browser, sent } = paper([reply]);
      const error = await browser.click(1).catch((failure: unknown) => failure);
      expect(error, reply).toBeInstanceOf(Error);
      expect(error, reply).not.toBeInstanceOf(BrowserInputUnknown);
      expect(sent()).toHaveLength(1);
    }
    await expect(
      paper(["clawdtime:no-tab"]).browser.switchTab(9),
    ).rejects.not.toBeInstanceOf(BrowserInputUnknown);
  });

  it("waits after open until the new tab shows a web address", async () => {
    const blank = { url: "about:blank", title: "", text: "", elements: [] };
    const { browser, slept } = paper([
      "clawdtime:opened",
      // The new tab holds its first, empty document while the address loads.
      reading(blank),
      reading(blank),
      reading({ url: "https://trychert.com/" }),
      reading({ url: "https://trychert.com/" }),
    ]);
    expect((await browser.open("https://trychert.com")).url).toBe(
      "https://trychert.com/",
    );
    expect(slept).toEqual([150, 250, 250, 250]);
  });
});

describe("the browser driver: its switch", () => {
  it("is off until the environment says on, and makes no driver before that", () => {
    let made = 0;
    const driver = {} as BrowserPort;
    const make = () => {
      made += 1;
      return driver;
    };
    expect(browserSwitch).toBe("CLAWDTIME_COMPUTER_BROWSER");
    for (const value of [undefined, "", "off", "true", "1", "ON", " on", "yes"])
      expect(
        browserFromEnvironment({ [browserSwitch]: value }, make),
      ).toBeUndefined();
    expect(browserFromEnvironment({}, make)).toBeUndefined();
    expect(made).toBe(0);
    expect(browserFromEnvironment({ [browserSwitch]: "on" }, make)).toBe(
      driver,
    );
    expect(made).toBe(1);
  });

  it("supports CLAWDTIME_COMPUTER_BROWSER=auto using makeOwn only when Chromium is available", () => {
    let madeApple = 0;
    let madeOwn = 0;
    const apple = {} as BrowserPort;
    const own = {} as BrowserPort;
    const make = () => ((madeApple += 1), apple);
    const makeOwn = () => ((madeOwn += 1), own);
    expect(
      browserFromEnvironment(
        { [browserSwitch]: "auto" },
        make,
        makeOwn,
        () => false,
      ),
    ).toBeUndefined();
    expect(madeApple).toBe(0);
    expect(madeOwn).toBe(0);
    expect(
      browserFromEnvironment(
        { [browserSwitch]: "auto" },
        make,
        makeOwn,
        () => true,
      ),
    ).toBe(own);
    expect(madeApple).toBe(0);
    expect(madeOwn).toBe(1);
  });
});

describe("the browser driver: the command runner of the program", () => {
  it("passes every argument as it is, with no shell in between", async () => {
    const awkward = "$HOME `id` $(id) ; ls 'q' \"d\" \\ * \n new line \u65e5";
    expect(await runCommand("/bin/echo", ["-n", awkward, "two"], 5000)).toEqual(
      {
        status: 0,
        stdout: `${awkward} two`,
        stderr: "",
      },
    );
  });

  it("answers with no status when the command cannot start or takes too long", async () => {
    expect(
      (await runCommand("/nonexistent/clawdtime-command", [], 5000)).status,
    ).toBeNull();
    expect((await runCommand("/bin/sleep", ["5"], 50)).status).toBeNull();
    expect((await runCommand("/usr/bin/false", [], 5000)).status).toBe(1);
  });
});

describe("the browser driver: hover, choose, keys, waits and tabs", () => {
  it("sends a hover, a choice and a key each as its own call, then reads the page", async () => {
    const steps: [(browser: BrowserPort) => Promise<unknown>, PageCall][] = [
      [(browser) => browser.hover!(1), { do: "hover", index: 1 }],
      [
        (browser) => browser.select!(1, "  Large \n"),
        { do: "select", index: 1, option: "Large" },
      ],
      [(browser) => browser.key!("Enter"), { do: "key", combo: "Enter" }],
      [
        (browser) => browser.key!("shift + tab"),
        { do: "key", combo: "Shift+Tab" },
      ],
    ];
    for (const [step, call] of steps) {
      const { browser, sent, script } = paper([done, reading()]);
      expect(await step(browser)).toEqual({ browser: "chrome", ...page() });
      expect(sent().map((item) => item.args[2])).toEqual([
        script(call),
        script({ do: "read" }),
        script({ do: "read" }, 2),
      ]);
      for (const item of sent()) expect(item.args[1]).toBe(runScript(chrome));
    }
  });

  it("refuses a number, an option, a key, a wait or a tab that cannot be sent, before any command runs", async () => {
    const { browser, calls } = paper([done, reading()]);
    const number =
      "Give the number of an element from the last reading of the page.";
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(browser.hover(bad)).rejects.toThrow(number);
      await expect(browser.select(bad, "Large")).rejects.toThrow(number);
    }
    for (const option of ["", "   ", 5 as unknown as string])
      await expect(browser.select(1, option)).rejects.toThrow(
        "Name the option by the text that it shows.",
      );
    for (const combo of ["cmd+q", "a", "Delete", "", 13 as unknown as string])
      await expect(browser.key(combo)).rejects.toThrow(/^A page takes Enter/);
    for (const ms of [99, 10_001, 1.5, Number.NaN])
      await expect(browser.waitFor(null, ms)).rejects.toThrow(
        "A wait takes 100 to 10000 milliseconds.",
      );
    await expect(browser.waitFor("  ", 500)).rejects.toThrow(
      "Give the words to wait for, or leave them out.",
    );
    for (const tab of [0, -2, 1.5, 10_000, Number.POSITIVE_INFINITY])
      await expect(browser.switchTab(tab)).rejects.toThrow(
        "Give the number of a tab from the last list of tabs.",
      );
    expect(calls).toEqual([]);
  });

  it("waits until the words show on the page, whatever their case and spaces, and says so", async () => {
    const { browser, sent, slept } = paper([
      reading({ text: "Loading" }),
      reading({ text: "Loading" }),
      reading({ text: "Your ORDER\nis placed." }),
    ]);
    expect(await browser.waitFor("order  is placed", 5000)).toEqual({
      browser: "chrome",
      ...page({ text: "Your ORDER\nis placed." }),
      found: true,
    });
    expect(sent()).toHaveLength(3);
    // It reads at once, then at the usual pace.
    expect(slept).toEqual([250, 250]);
    for (const item of sent()) expect(item.args[1]).toBe(runScript(chrome));
  });

  it("gives the last reading with found false when the time runs out", async () => {
    const { browser, slept } = paper([reading({ text: "Loading" })]);
    expect(await browser.waitFor("Placed", 600)).toEqual({
      browser: "chrome",
      ...page({ text: "Loading" }),
      found: false,
    });
    expect(slept).toEqual([250, 250, 100]);
  });

  it("with no words, waits until the page is ready and holds still, at most the time given", async () => {
    const settles = paper([
      reading({}, { ready: false }),
      reading({ text: "Half" }),
      reading(),
      reading(),
    ]);
    const settled = await settles.browser.waitFor(null, 5000);
    expect(settled).toEqual({ browser: "chrome", ...page() });
    expect("found" in settled).toBe(false);
    expect(settles.sent()).toHaveLength(4);
    const never = paper([reading({}, { ready: false })]);
    expect(await never.browser.waitFor(null, 300)).toEqual({
      browser: "chrome",
      ...page(),
    });
    expect(never.slept).toEqual([250, 50]);
  });

  it("gives the failure of the page when no reading of the wait worked", async () => {
    const { browser } = paper(["clawdtime:no-answer"]);
    await expect(browser.waitFor("Placed", 300)).rejects.toThrow(
      /cannot run a script on the page in front/,
    );
  });

  it("lists the tabs of the front window with a script of the browser's own dictionary", () => {
    expect(tabsScript(chrome)).toBe(`on run argv
  try
    tell application id "com.google.Chrome"
      if (count of windows) is 0 then return "clawdtime:no-window"
      set theAddresses to URL of every tab of front window
      set theTitles to title of every tab of front window
      set theActive to active tab index of front window
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
  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try
end run`);
    expect(tabsScript(safari)).toContain(
      "set theTitles to name of every tab of front window",
    );
    expect(tabsScript(safari)).toContain(
      "set theActive to index of current tab of front window",
    );
    expect(tabsScript(safari)).toContain(
      'if (count of documents) is 0 then return "clawdtime:no-window"',
    );
    expect(tabsScript(brave)).toContain('application id "com.brave.Browser"');
  });

  it("reads the list of the tabs, leaves out a line of another shape, then reads the page in front", async () => {
    const listed = [
      "1\tfalse\thttps://mail.example/\tInbox (3)",
      "2\ttrue\thttps://example.test/orders\tOrders",
      "not a tab",
      "3\tmaybe\thttps://x.example/\tX",
      `4\tfalse\t\t${"Long ".repeat(80)}`,
    ].join("\n");
    const { browser, sent, script, slept } = paper([listed, reading()]);
    const seen = await browser.tabs();
    expect(seen).toEqual({
      browser: "chrome",
      ...page(),
      tabs: [
        {
          index: 1,
          title: "Inbox (3)",
          url: "https://mail.example/",
          active: false,
        },
        {
          index: 2,
          title: "Orders",
          url: "https://example.test/orders",
          active: true,
        },
        {
          index: 4,
          title: "Long ".repeat(40).trim(),
          url: "",
          active: false,
        },
      ],
    });
    expect(sent()[0]).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", tabsScript(chrome)],
      timeoutMs: 8000,
    });
    expect(sent()[1]!.args).toEqual([
      "-e",
      runScript(chrome),
      script({ do: "read" }),
    ]);
    // A list changes nothing, so it waits for nothing.
    expect(slept).toEqual([]);
  });

  it("says why when the tabs cannot be listed", async () => {
    await expect(paper(["no tabs here"]).browser.tabs()).rejects.toThrow(
      "Google Chrome gave an answer that ClawdTime could not read: read the page again.",
    );
    await expect(paper(["clawdtime:no-window"]).browser.tabs()).rejects.toThrow(
      "Google Chrome has no window open",
    );
    await expect(
      paper([
        marked(-1743, "Not authorized to send Apple events to Google Chrome."),
      ]).browser.tabs(),
    ).rejects.toBeInstanceOf(BrowserClosed);
  });

  it("switches to a tab by its place, passed as an argument, then reads the page when it is ready", async () => {
    const { browser, sent, script } = paper([
      "clawdtime:switched",
      reading({ title: "Inbox" }),
      reading({ title: "Inbox" }),
    ]);
    expect((await browser.switchTab(3)).title).toBe("Inbox");
    expect(sent()[0]).toEqual({
      command: "/usr/bin/osascript",
      args: ["-e", switchTabScript(chrome), "3"],
      timeoutMs: 8000,
    });
    expect(sent()[1]!.args[2]).toBe(script({ do: "read" }));
    expect(switchTabScript(chrome)).toBe(`on run argv
  try
    set theIndex to (item 1 of argv) as integer
    tell application id "com.google.Chrome"
      if (count of windows) is 0 then return "clawdtime:no-window"
      if theIndex > (count of tabs of front window) then return "clawdtime:no-tab"
      set active tab index of front window to theIndex
    end tell
    return "clawdtime:switched"
  on error theMessage number theNumber
    return "clawdtime:error:" & theNumber & ":" & theMessage
  end try
end run`);
    expect(switchTabScript(safari)).toContain(
      "set current tab of front window to tab theIndex of front window",
    );
    // The browser does not come forward: the person keeps the app that they use.
    expect(switchTabScript(chrome)).not.toContain("activate");
  });

  it("says when the tab is gone, and when the answer cannot be read", async () => {
    await expect(
      paper(["clawdtime:no-tab"]).browser.switchTab(9),
    ).rejects.toThrow(
      "That tab is not in the front window any more: list the tabs again.",
    );
    await expect(paper(["what"]).browser.switchTab(1)).rejects.toThrow(
      /could not read/,
    );
  });
});
