import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computerCli } from "../cli/computer.js";
import {
  AppleEventsBrowser,
  browserFromEnvironment,
  browserSwitch,
  type BrowserClock,
} from "../connectors/computer/browser.js";
import {
  DevToolsConnection,
  browserEndpoint,
  readActivePort,
  type DevToolsDial,
  type DevToolsPipeHandlers,
} from "../connectors/computer/devtools.js";
import { pageError } from "../connectors/computer/error-page.js";
import {
  BrowserInputUnknown,
  OwnBrowser,
  keyEvents,
  ownTiming,
  type BrowserLauncher,
} from "../connectors/computer/own-browser.js";
import type { BrowserPort } from "../connectors/computer/ports.js";
import { FakeBrowser } from "./connectors-computer-fixture.js";

/**
 * No test here starts a program or opens a connection. The browser is on
 * paper: a launcher that writes the port file a browser writes, and a
 * DevTools pipe that answers each command as a browser does and records it.
 * The page script is proven in a real browser by
 * tests/computer-own-browser.browser.ts.
 */
const program = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const host = "test-mac.local";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function folder() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-own-browser-"));
  roots.push(root);
  return root;
}

function fakeClock() {
  let time = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  const clock: BrowserClock = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
      for (const timer of timers.splice(0))
        if (timer.at <= time) timer.run();
        else timers.push(timer);
    },
  };
  return {
    clock,
    now: () => time,
    /** Runs `run` once the clock reaches `ms` from now. */
    later: (ms: number, run: () => void) => timers.push({ at: time + ms, run }),
  };
}

interface Sent {
  method: string;
  params: Record<string, unknown>;
  session?: string;
}
interface Target {
  targetId: string;
  type: string;
  title: string;
  url: string;
}
type PageCallSeen = { do: string; index?: number; text?: string } & Record<
  string,
  unknown
>;

const element = (
  index: number,
  label: string,
  values: Record<string, unknown> = {},
) => ({
  index,
  tag: "button",
  role: "button",
  label,
  disabled: false,
  password: false,
  ...values,
});
const shop = {
  title: "Shop",
  url: "https://shop.test/",
  text: "Kettles for sale.",
  elements: [
    element(1, "Buy"),
    element(2, "Name", { tag: "input", role: "textbox", value: "Old" }),
  ],
};
const box = (values: Record<string, unknown> = {}) => ({
  ok: true,
  x: 50.5,
  y: 20,
  inside: true,
  hit: true,
  tag: "button",
  role: "button",
  kind: "press",
  name: 'Number 1, "Buy",',
  disabled: false,
  readOnly: false,
  password: false,
  focused: false,
  ...values,
});

/**
 * A browser on paper. `page` is what a reading gives, `locate` what the
 * locate step gives for a number. A test changes either, or `answer` for
 * any command, and reads `sent`.
 */
class PaperBrowser {
  readonly sent: Sent[] = [];
  readonly dialed: string[] = [];
  readonly launches: { program: string; args: string[] }[] = [];
  readonly killed: number[] = [];
  readonly running = new Set<number>();
  pid = 4000;
  port = 45_000;
  /** The browser process that the browser names when asked. Null: its own. */
  claims: number | null = null;
  targets: Target[] = [
    { targetId: "T1", type: "page", title: "", url: "about:blank" },
  ];
  page: Record<string, unknown> = { ...shop };
  locate: (index: number) => Record<string, unknown> = () => box();
  /** Optional custom settle probe reply. */
  settle: () => Record<string, unknown> = () => ({ ok: true });
  /** Optional Page.getFrameTree response (default and per CDP session). */
  frameTree: Record<string, unknown> | null = null;
  frameTreeBySession = new Map<string, Record<string, unknown>>();
  /** Optional per-frame owner backendNodeId and boxModel content quad. */
  frameOwners = new Map<string, number>();
  boxModels = new Map<number, number[]>();
  /** Optional per-frame page/locate/focus overrides keyed by executionContextId. */
  worldByFrame = new Map<string, number | null>();
  pageByContext = new Map<number, Record<string, unknown>>();
  locateByContext = new Map<
    number,
    (index: number) => Record<string, unknown>
  >();
  focusByContext = new Map<number, Record<string, unknown>>();
  /** Optional custom reply for `{ do: "type" }` calls. */
  typeReply: (() => Record<string, unknown>) | null = null;
  /** Optional custom reply for `{ do: "extract" }` calls. */
  extractReply:
    ((offset: number, maxChars: number) => Record<string, unknown>) | null =
    null;
  /** Optional custom reply for `{ do: "scroll_to" }` calls. */
  scrollToReply: ((index: number) => Record<string, unknown>) | null = null;
  /** Optional focused child frameId reported by activeElement + DOM.describeNode per parent contextId. */
  focusedChildByContext = new Map<number, string | null>();
  /** Optional frameHitCheck override keyed by iframe owner backendNodeId. */
  frameHitByBackendNode = new Map<number, { ok: boolean; cover?: string }>();
  /** Returns true to close the connection instead of answering. */
  dieOn: (sent: Sent) => boolean = () => false;
  /** Called with each command before the answer, to emit events. */
  before: (sent: Sent) => void = () => {};
  history = {
    currentIndex: 0,
    entries: [{ id: 7, url: "https://shop.test/" }],
  };
  closesOnBrowserClose = true;
  refuseDial = false;
  /** The open connections: the service's, and one of a doctor in another process. */
  private readonly connections = new Set<DevToolsPipeHandlers>();
  private made = 1;

  constructor(readonly profile: string) {}

  readonly launch: BrowserLauncher = (path, args) => {
    this.launches.push({ program: path, args });
    this.pid += 1;
    this.port += 1;
    const pid = this.pid;
    const dir = args
      .find((arg) => arg.startsWith("--user-data-dir="))!
      .slice("--user-data-dir=".length);
    writeFileSync(
      join(dir, "DevToolsActivePort"),
      `${this.port}\n/devtools/browser/id-${pid}\n`,
    );
    this.lock(pid);
    this.running.add(pid);
    return {
      pid,
      exited: () => !this.running.has(pid),
      kill: () => {
        this.killed.push(pid);
        this.running.delete(pid);
      },
    };
  };

  lock(pid: number) {
    const lock = join(this.profile, "SingletonLock");
    try {
      unlinkSync(lock);
    } catch {
      // None yet.
    }
    symlinkSync(`${host}-${pid}`, lock);
  }

  readonly dial: DevToolsDial = async (url, handlers) => {
    this.dialed.push(url);
    if (this.refuseDial) throw new Error("refused");
    this.connections.add(handlers);
    return {
      send: (text) => this.receive(JSON.parse(text), handlers),
      close: () => this.end(handlers),
    };
  };

  /** The browser ends by itself. */
  die() {
    this.running.delete(this.pid);
    for (const handlers of [...this.connections]) this.end(handlers);
  }

  emit(method: string, params: Record<string, unknown>, session = "S-T1") {
    for (const handlers of this.connections)
      handlers.message(JSON.stringify({ method, params, sessionId: session }));
  }

  /** The commands of one method. */
  of(method: string) {
    return this.sent.filter((item) => item.method === method);
  }
  inputs() {
    return this.sent.filter((item) => item.method.startsWith("Input."));
  }
  /** The page script calls, in order. */
  calls(): PageCallSeen[] {
    return this.of("Runtime.evaluate")
      .filter((item) => item.params.returnByValue !== false)
      .map((item) => {
        const expression = String(item.params.expression);
        return JSON.parse(
          expression.slice(expression.lastIndexOf("})(") + 3, -1),
        ) as PageCallSeen;
      });
  }

  private end(handlers: DevToolsPipeHandlers) {
    if (this.connections.delete(handlers)) handlers.closed();
  }

  private receive(
    message: {
      id: number;
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    },
    handlers: DevToolsPipeHandlers,
  ) {
    const sent: Sent = {
      method: message.method,
      params: message.params,
      ...(message.sessionId ? { session: message.sessionId } : {}),
    };
    this.sent.push(sent);
    if (this.dieOn(sent)) {
      queueMicrotask(() => this.die());
      return;
    }
    this.before(sent);
    const result = this.answer(sent);
    queueMicrotask(() => {
      if (this.connections.has(handlers))
        handlers.message(JSON.stringify({ id: message.id, result }));
    });
    if (message.method === "Browser.close" && this.closesOnBrowserClose)
      queueMicrotask(() => this.die());
  }

  private answer({ method, params, session }: Sent): unknown {
    switch (method) {
      case "SystemInfo.getProcessInfo":
        return {
          processInfo: [
            { type: "browser", id: this.claims ?? this.pid, cpuTime: 1 },
            { type: "renderer", id: 9, cpuTime: 1 },
          ],
        };
      case "Browser.getVersion":
        return { product: "Chrome/158" };
      case "Target.getTargets":
        return {
          targetInfos: this.targets.map((target) => ({
            ...target,
            attached: false,
          })),
        };
      case "Target.attachToTarget":
        return { sessionId: `S-${String(params.targetId)}` };
      case "Target.createTarget": {
        this.made += 1;
        const targetId = `T${this.made}`;
        this.targets.push({
          targetId,
          type: "page",
          title: "",
          url: String(params.url),
        });
        return { targetId };
      }
      case "Target.closeTarget": {
        const targetId = String(params.targetId ?? "");
        const before = this.targets.length;
        this.targets = this.targets.filter(
          (item) => item.targetId !== targetId,
        );
        return { success: this.targets.length < before };
      }
      case "Page.navigate":
        this.page = { ...this.page, url: String(params.url) };
        return { frameId: "F", loaderId: "L" };
      case "Page.getNavigationHistory":
        return this.history;
      case "Page.getFrameTree":
        return (
          (session ? this.frameTreeBySession.get(session) : undefined) ??
          this.frameTree ??
          {}
        );
      case "DOM.getFrameOwner": {
        const backendNodeId = this.frameOwners.get(String(params.frameId));
        return backendNodeId !== undefined ? { backendNodeId } : {};
      }
      case "DOM.resolveNode": {
        const backendNodeId = Number(params.backendNodeId);
        if (this.frameHitByBackendNode.has(backendNodeId)) {
          return { object: { objectId: `NODE-${backendNodeId}` } };
        }
        return {};
      }
      case "DOM.describeNode": {
        const objectId = String(params.objectId ?? "");
        if (objectId.startsWith("FOCUSED-")) {
          return { node: { frameId: objectId.slice("FOCUSED-".length) } };
        }
        return {};
      }
      case "Runtime.callFunctionOn": {
        const objectId = String(params.objectId ?? "");
        const fn = String(params.functionDeclaration ?? "");
        if (objectId.startsWith("NODE-") && fn.includes("elementFromPoint")) {
          const backendNodeId = Number(objectId.slice("NODE-".length));
          const hit = this.frameHitByBackendNode.get(backendNodeId);
          if (hit) return { result: { value: hit } };
        }
        return { result: { value: null } };
      }
      case "DOM.getBoxModel": {
        const content = this.boxModels.get(Number(params.backendNodeId));
        return content ? { model: { content } } : {};
      }
      case "Runtime.evaluate": {
        const ctx = typeof params.contextId === "number" ? params.contextId : 7;
        if (params.returnByValue === false) {
          const focusedChild = this.focusedChildByContext.get(ctx);
          return focusedChild
            ? {
                result: { type: "object", objectId: `FOCUSED-${focusedChild}` },
              }
            : { result: { type: "object", subtype: "null", value: null } };
        }
        const expression = String(params.expression);
        const call = JSON.parse(
          expression.slice(expression.lastIndexOf("})(") + 3, -1),
        ) as PageCallSeen;
        const ctxPage = this.pageByContext.get(ctx) ?? this.page;
        const ctxLocate = this.locateByContext.get(ctx) ?? this.locate;
        const value =
          call.do === "read"
            ? {
                ok: true,
                ready: true,
                next: (call.start as number) + 2,
                page: ctxPage,
              }
            : call.do === "locate"
              ? ctxLocate(call.index!)
              : call.do === "focus"
                ? (this.focusByContext.get(ctx) ?? { ok: true })
                : call.do === "type" && this.typeReply
                  ? this.typeReply()
                  : call.do === "extract"
                    ? this.extractReply
                      ? this.extractReply(
                          Number(call.offset ?? 0),
                          Number(call.maxChars ?? 8000),
                        )
                      : {
                          ok: true,
                          url: String(ctxPage.url ?? ""),
                          title: String(ctxPage.title ?? ""),
                          text: String(ctxPage.text ?? ""),
                          offset: 0,
                          totalChars: String(ctxPage.text ?? "").length,
                          hasMore: false,
                        }
                    : call.do === "scroll_to" && this.scrollToReply
                      ? this.scrollToReply(Number(call.index))
                      : call.do === "settle"
                        ? this.settle()
                        : { ok: true };
        return { result: { type: "string", value: JSON.stringify(value) } };
      }
      // A browser of the family names the private world of the page script.
      case "Page.createIsolatedWorld": {
        const frameId = String(params.frameId ?? "");
        if (this.worldByFrame.has(frameId)) {
          const mapped = this.worldByFrame.get(frameId);
          return mapped === null ? {} : { executionContextId: mapped };
        }
        return { executionContextId: 7 };
      }
      default:
        return {};
    }
  }
}

function setup(
  values: {
    executable?: string;
    headless?: boolean;
    backgroundFocus?: boolean;
  } = {},
) {
  const root = folder();
  const profile = join(root, "computer", "browser-profile");
  const paper = new PaperBrowser(profile);
  const steps = fakeClock();
  const make = () =>
    new OwnBrowser({
      env: { CLAWDTIME_CONFIG_HOME: root },
      home: join(root, "home"),
      launch: paper.launch,
      dial: paper.dial,
      clock: steps.clock,
      alive: (pid) => paper.running.has(pid),
      host,
      runnable: (path) => path === program,
      ...values,
    });
  return { root, profile, paper, steps, browser: make(), make };
}

describe("ClawdTime's own browser: its endpoint", () => {
  it("starts at the first read, in its own private profile, and connects to the port that the profile names, on 127.0.0.1", async () => {
    const { root, profile, paper, browser } = setup();
    // Making the driver starts nothing and writes nothing.
    expect(paper.launches).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    const page = await browser.read();
    expect(paper.launches).toEqual([
      {
        program,
        args: [
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
      },
    ]);
    // The real start shows its window, and says nothing of automation.
    expect(paper.launches[0]!.args.join(" ")).not.toMatch(
      /headless|automation/,
    );
    expect(statSync(profile).mode & 0o777).toBe(0o700);
    expect(paper.dialed).toEqual([
      `ws://127.0.0.1:${paper.port}/devtools/browser/id-${paper.pid}`,
    ]);
    // The process is proven before any page is touched.
    expect(paper.sent[0]!.method).toBe("SystemInfo.getProcessInfo");
    expect(page).toEqual({ browser: "own", ...shop });
    expect(paper.calls()).toEqual([
      { do: "read", session: browser.session, start: 1 },
    ]);
  });

  it("starts with no window only when a test asks for it", async () => {
    const { paper, browser } = setup({ headless: true });
    await browser.read();
    expect(paper.launches[0]!.args).toContain("--headless=new");
  });

  it("refuses any address that is not the browser endpoint on 127.0.0.1, before a byte goes out", async () => {
    let dialed = 0;
    const dial: DevToolsDial = async () => {
      dialed += 1;
      throw new Error("never");
    };
    for (const url of [
      "ws://10.0.0.5:9222/devtools/browser/abc",
      "ws://localhost:9222/devtools/browser/abc",
      "ws://127.0.0.1.attacker.test:9222/devtools/browser/abc",
      "ws://[::1]:9222/devtools/browser/abc",
      "ws://127.1:9222/devtools/browser/abc",
      "wss://127.0.0.1:9222/devtools/browser/abc",
      "http://127.0.0.1:9222/devtools/browser/abc",
      "ws://someone@127.0.0.1:9222/devtools/browser/abc",
      "ws://127.0.0.1:9222/devtools/page/abc",
      "ws://127.0.0.1:9222/devtools/browser/abc?next=1",
      "ws://127.0.0.1/devtools/browser/abc",
      "not an address",
    ])
      await expect(DevToolsConnection.open(url, dial)).rejects.toThrow(
        /127\.0\.0\.1 only|not the path of a browser|not an address|plain form/,
      );
    expect(dialed).toBe(0);
    expect(browserEndpoint(9222, "/devtools/browser/abc-1")).toBe(
      "ws://127.0.0.1:9222/devtools/browser/abc-1",
    );
    expect(() => browserEndpoint(0, "/devtools/browser/a")).toThrow();
    expect(() => browserEndpoint(9222, "//attacker.test/x")).toThrow();
  });

  it("reads only a port and a browser path from the port file", () => {
    expect(readActivePort("9222\n/devtools/browser/abc-1\n")).toEqual({
      port: 9222,
      path: "/devtools/browser/abc-1",
    });
    for (const text of [
      "",
      "9222",
      "0\n/devtools/browser/abc",
      "70000\n/devtools/browser/abc",
      "9222\n/devtools/page/abc",
      "9222\n/devtools/browser/abc@attacker.test",
      "9222\n//attacker.test/devtools/browser/abc",
      "9222\n/devtools/browser/abc\nws://10.0.0.5:9222/",
      "ws://10.0.0.5:9222\n/devtools/browser/abc",
    ])
      expect(readActivePort(text)).toBeNull();
  });

  it("connects nowhere when the port file names anything else, and ends the program it started", async () => {
    const { paper, profile, make } = setup();
    const launch = paper.launch;
    (paper as { launch: BrowserLauncher }).launch = (path, args) => {
      const started = launch(path, args);
      writeFileSync(
        join(profile, "DevToolsActivePort"),
        "9222\nws://10.0.0.5:9222/devtools/browser/abc\n",
      );
      return started;
    };
    await expect(make().read()).rejects.toThrow(
      /did not open its control port in time/,
    );
    expect(paper.dialed).toEqual([]);
    expect(paper.killed).toEqual([paper.pid]);
  });

  it("refuses a browser on that port that is not the process it started", async () => {
    const { paper, browser } = setup();
    paper.claims = 31337;
    await expect(browser.read()).rejects.toThrow(
      /not the browser that ClawdTime started\. Nothing was sent\./,
    );
    expect(paper.sent.map((item) => item.method)).toEqual([
      "SystemInfo.getProcessInfo",
    ]);
    expect(paper.killed).toEqual([paper.pid]);
  });

  it("reuses the browser that runs, also one of an earlier start that proves it holds the profile", async () => {
    const { paper, browser, make } = setup();
    await browser.read();
    await browser.read();
    expect(paper.launches).toHaveLength(1);
    expect(paper.dialed).toHaveLength(1);
    // A new service finds the browser that the last one left open.
    const next = make();
    await next.read();
    expect(paper.launches).toHaveLength(1);
    expect(paper.dialed).toHaveLength(2);
    // A browser that holds the profile but cannot prove it is not used, and no second one starts.
    paper.claims = 31337;
    await expect(make().read()).rejects.toThrow(
      /earlier start but does not answer on its own port/,
    );
    expect(paper.launches).toHaveLength(1);
  });
});

describe("ClawdTime's own browser: no blind retry", () => {
  it("starts nothing for an input, before any start", async () => {
    const { paper, browser } = setup();
    const inputs: [string, (port: BrowserPort) => Promise<unknown>][] = [
      ["click", (port) => port.click(1)],
      ["type", (port) => port.type(2, "Ada", false)],
      ["scroll", (port) => port.scroll("down")],
      ["back", (port) => port.back()],
      ["hover", (port) => port.hover!(1)],
      ["select", (port) => port.select!(1, "Large")],
      ["key", (port) => port.key!("Enter")],
      ["switchTab", (port) => port.switchTab!(1)],
    ];
    for (const [name, run] of inputs)
      await expect(run(browser), name).rejects.toThrow(
        /is not open\. Nothing was sent\./,
      );
    expect(paper.launches).toEqual([]);
    expect(paper.dialed).toEqual([]);
  });

  it("starts again for a read after the browser ended, but never for an input, and never sends an input twice", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.die();
    await expect(browser.click(1)).rejects.toThrow(
      /closed\. Nothing was sent\. Read the page again/,
    );
    expect(paper.launches).toHaveLength(1);
    expect(paper.inputs()).toEqual([]);
    // A read has no effect: it starts the browser again.
    expect((await browser.read()).title).toBe("Shop");
    expect(paper.launches).toHaveLength(2);
    // The browser ends while the button goes down: the click is not sent again.
    paper.dieOn = (sent) =>
      sent.method === "Input.dispatchMouseEvent" &&
      sent.params.type === "mousePressed";
    await expect(browser.click(1)).rejects.toThrow(
      /closed while the input went out\. Its result is not known, and it is not sent again\./,
    );
    paper.dieOn = () => false;
    expect((await browser.read()).title).toBe("Shop");
    expect(paper.launches).toHaveLength(3);
    expect(
      paper
        .of("Input.dispatchMouseEvent")
        .filter((item) => item.params.type === "mousePressed"),
    ).toHaveLength(1);
  });

  it("does not open an address again when the browser ended while it opened", async () => {
    const { paper, browser } = setup();
    paper.dieOn = (sent) => sent.method === "Page.navigate";
    await expect(browser.open("https://shop.test/")).rejects.toThrow(
      /result is not known, and it is not sent again/,
    );
    expect(paper.of("Page.navigate")).toHaveLength(1);
  });
});

describe("ClawdTime's own browser: input", () => {
  it("clicks the centre of the element with real mouse events, then reads the page", async () => {
    const { paper, browser } = setup();
    await browser.read();
    const after = await browser.click(1);
    expect(after.title).toBe("Shop");
    expect(paper.calls().map((call) => call.do)).toEqual([
      "read",
      "locate",
      "settle",
      "read",
    ]);
    expect(paper.inputs().map((item) => item.params)).toEqual([
      { type: "mouseMoved", x: 50.5, y: 20, button: "none", buttons: 0 },
      {
        type: "mousePressed",
        x: 50.5,
        y: 20,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      {
        type: "mouseReleased",
        x: 50.5,
        y: 20,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
    ]);
    // Every page command goes to the page's own session.
    expect(paper.inputs().every((item) => item.session === "S-T1")).toBe(true);
  });

  it("refuses a click whose centre is covered, out of view or disabled, and sends nothing", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.locate = () => box({ hit: false, cover: "div" });
    await expect(browser.click(1)).rejects.toThrow(
      'Number 1, "Buy", is under another element at its centre (div). Nothing was sent.',
    );
    paper.locate = () => box({ inside: false });
    await expect(browser.click(1)).rejects.toThrow(/not in view/);
    paper.locate = () => box({ disabled: true });
    await expect(browser.click(1)).rejects.toThrow(/is disabled now/);
    expect(paper.inputs()).toEqual([]);
    // A pointer may rest on a disabled control.
    await expect(browser.hover!(1)).resolves.toBeTruthy();
    paper.locate = () => box({ hit: false });
    paper.sent.length = 0;
    await expect(browser.hover!(1)).rejects.toThrow(/under another element/);
    expect(paper.inputs()).toEqual([]);
  });

  it("maps each key to its key, code and key code", () => {
    const pressed = (combo: string) => keyEvents(combo)[0]!;
    expect(keyEvents("Enter")).toEqual([
      {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 0,
        text: "\r",
        unmodifiedText: "\r",
      },
      {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        modifiers: 0,
      },
    ]);
    const rows: [string, string, string, number][] = [
      ["Escape", "Escape", "Escape", 27],
      ["Tab", "Tab", "Tab", 9],
      ["ArrowUp", "ArrowUp", "ArrowUp", 38],
      ["ArrowDown", "ArrowDown", "ArrowDown", 40],
      ["ArrowLeft", "ArrowLeft", "ArrowLeft", 37],
      ["ArrowRight", "ArrowRight", "ArrowRight", 39],
      ["PageUp", "PageUp", "PageUp", 33],
      ["PageDown", "PageDown", "PageDown", 34],
      ["Home", "Home", "Home", 36],
      ["End", "End", "End", 35],
      ["Backspace", "Backspace", "Backspace", 8],
      ["Space", " ", "Space", 32],
    ];
    for (const [combo, key, code, keyCode] of rows)
      expect(pressed(combo), combo).toMatchObject({
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        modifiers: 0,
      });
    expect(pressed("Space")).toMatchObject({ type: "keyDown", text: " " });
    expect(pressed("Escape").type).toBe("rawKeyDown");
    expect(pressed("ArrowDown").commands).toEqual(["moveDown"]);
    expect(pressed("Backspace").commands).toEqual(["deleteBackward"]);
    expect(pressed("escape")).toEqual(pressed("Escape"));
    expect(
      keyEvents("Shift+Tab").map((event) => [
        event.type,
        event.key,
        event.modifiers,
      ]),
    ).toEqual([
      ["rawKeyDown", "Shift", 8],
      ["rawKeyDown", "Tab", 8],
      ["keyUp", "Tab", 8],
      ["keyUp", "Shift", 0],
    ]);
    for (const combo of ["", "a", "cmd+q", "Shift+Enter", "ctrl+Tab", "F5"])
      expect(() => keyEvents(combo), combo).toThrow(
        /presses one of these keys/,
      );
  });

  it("presses a key in the page, and refuses another one with nothing sent", async () => {
    const { paper, browser } = setup();
    await browser.read();
    await browser.key!("Enter");
    expect(
      paper.of("Input.dispatchKeyEvent").map((item) => item.params),
    ).toEqual(keyEvents("Enter"));
    paper.sent.length = 0;
    await expect(browser.key!("cmd+q")).rejects.toThrow(/presses one of/);
    expect(paper.sent).toEqual([]);
  });

  it("types by clicking into the field, selecting its old text, inserting the new text, and Enter to submit", async () => {
    const { paper, browser } = setup();
    await browser.read();
    let looks = 0;
    paper.locate = () =>
      box({
        tag: "input",
        role: "textbox",
        kind: "text",
        name: 'Number 2, "Name",',
        focused: (looks += 1) > 1,
      });
    paper.page = {
      ...shop,
      elements: [
        element(1, "Buy"),
        element(2, "Name", { tag: "input", role: "textbox", value: "Ada" }),
      ],
    };
    await browser.type(2, "Ada", true);
    const steps = paper
      .inputs()
      .map((item) =>
        item.method === "Input.dispatchMouseEvent"
          ? `mouse ${String(item.params.type)}`
          : item.method === "Input.insertText"
            ? `text ${String(item.params.text)}`
            : `key ${String(item.params.type)} ${String(item.params.key)} ${JSON.stringify(item.params.commands ?? [])}`,
      );
    expect(steps).toEqual([
      "mouse mouseMoved",
      "mouse mousePressed",
      "mouse mouseReleased",
      'key rawKeyDown a ["selectAll"]',
      "key keyUp a []",
      "text Ada",
      "key keyDown Enter []",
      "key keyUp Enter []",
    ]);
    // A field that has the focus already is not clicked.
    paper.sent.length = 0;
    paper.locate = () => box({ kind: "text", tag: "input", focused: true });
    await browser.type(2, "Ada", false);
    expect(
      paper.inputs().some((item) => item.method === "Input.dispatchMouseEvent"),
    ).toBe(false);
    // A field that does not take the focus gets no text.
    paper.sent.length = 0;
    paper.locate = () => box({ kind: "text", tag: "input", focused: false });
    await expect(browser.type(2, "Ada", false)).rejects.toThrow(
      /did not take the focus after a click\. No text was typed\./,
    );
    expect(paper.of("Input.insertText")).toEqual([]);
  });

  it("says when a field did not take the text", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.locate = () => box({ kind: "text", tag: "input", focused: true });
    paper.page = {
      ...shop,
      elements: [
        element(2, "Amount", { tag: "input", role: "spinbutton", value: "" }),
      ],
    };
    await expect(browser.type(2, "twelve", false)).rejects.toThrow(
      /did not take that text/,
    );
  });

  it("never types into a password field, and never shows its value", async () => {
    const { paper, browser } = setup();
    paper.page = {
      ...shop,
      elements: [
        element(3, "Password", {
          tag: "input",
          role: "textbox",
          password: true,
          value: "forged-by-the-page",
        }),
      ],
    };
    const page = await browser.read();
    expect(page.elements[0]).not.toHaveProperty("value");
    paper.locate = () =>
      box({ kind: "text", tag: "input", password: true, name: "Number 3," });
    await expect(browser.type(3, "hunter2", false)).rejects.toThrow(
      "Number 3, is a password field. The worker never types a password: ask the person to type it.",
    );
    // A field that turns into a password field under the click is refused too.
    let looks = 0;
    paper.locate = () =>
      box({ kind: "text", tag: "input", password: (looks += 1) > 1 });
    await expect(browser.type(3, "hunter2", false)).rejects.toThrow(
      /password field/,
    );
    expect(paper.of("Input.insertText")).toEqual([]);
    expect(paper.calls().some((call) => call.do === "type")).toBe(false);
    expect(JSON.stringify(paper.sent)).not.toContain("hunter2");
  });

  it("picks an option of a select by its label through the page script, and opens a list that the page draws", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.locate = () =>
      box({ tag: "select", role: "combobox", kind: "choice" });
    await browser.select!(4, "Large");
    expect(paper.calls().find((call) => call.do === "type")).toMatchObject({
      do: "type",
      index: 4,
      text: "Large",
      submit: false,
    });
    expect(paper.inputs()).toEqual([]);
    // A list that the page draws: it opens with a click, then the option is clicked.
    paper.locate = (index) =>
      index === 5
        ? box({ tag: "div", role: "listbox", x: 10, y: 10 })
        : box({ tag: "div", role: "option", x: 10, y: 40 });
    paper.page = {
      ...shop,
      elements: [
        element(5, "Size", { tag: "div", role: "listbox" }),
        element(6, "Small", { tag: "div", role: "option" }),
        element(7, "Large", { tag: "div", role: "option" }),
      ],
    };
    paper.sent.length = 0;
    await browser.select!(5, "large");
    expect(
      paper
        .of("Input.dispatchMouseEvent")
        .filter((item) => item.params.type === "mousePressed")
        .map((item) => item.params.y),
    ).toEqual([10, 40]);
    expect(paper.calls().filter((call) => call.do === "locate")).toEqual([
      expect.objectContaining({ index: 5 }),
      expect.objectContaining({ index: 7 }),
    ]);
    paper.locate = () => box();
    await expect(browser.select!(1, "Large")).rejects.toThrow(
      /is not a list of choices/,
    );
  });

  it("goes back one page in the history of the tab, and only when there is one", async () => {
    const { paper, browser } = setup();
    await browser.read();
    await expect(browser.back()).rejects.toThrow(/no earlier page/);
    expect(paper.of("Page.navigateToHistoryEntry")).toEqual([]);
    paper.history = {
      currentIndex: 1,
      entries: [
        { id: 7, url: "https://shop.test/" },
        { id: 8, url: "https://shop.test/next" },
      ],
    };
    await browser.back();
    expect(paper.of("Page.navigateToHistoryEntry")[0]!.params).toEqual({
      entryId: 7,
    });
  });

  it("opens an address in the empty tab, then in a new tab, and refuses anything but the web", async () => {
    const { paper, browser } = setup();
    await expect(browser.open("file:///etc/hosts")).rejects.toThrow(
      /Only http and https/,
    );
    expect(paper.launches).toEqual([]);
    await browser.open("https://shop.test/");
    expect(paper.of("Page.navigate")[0]).toMatchObject({
      params: { url: "https://shop.test/" },
      session: "S-T1",
    });
    paper.targets[0]!.url = "https://shop.test/";
    await browser.open("https://shop.test/next");
    expect(paper.of("Target.createTarget")).toHaveLength(1);
    expect(paper.of("Page.navigate")[1]).toMatchObject({ session: "S-T2" });
    expect(
      paper.of("Target.activateTarget").map((item) => item.params),
    ).toEqual([{ targetId: "T1" }, { targetId: "T2" }]);
  });

  it("stops waiting when the page opens a dialog, and leaves the dialog to the person", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.before = (sent) => {
      if (sent.params.type === "mouseReleased")
        paper.emit("Page.javascriptDialogOpening", {
          message: "Delete all orders?",
          type: "confirm",
        });
    };
    await expect(browser.click(1)).rejects.toThrow(
      'The page shows a dialog: "Delete all orders?". ClawdTime does not answer it: ask the person to answer it in ClawdTime\'s browser.',
    );
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([]);
  });
});

describe("ClawdTime's own browser: waits", () => {
  it("reads the page after a step only when the network is quiet", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    let from = 0;
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", { requestId: "r1", type: "XHR" });
      steps.later(600, () => {
        paper.page = { ...shop, text: "Prices loaded." };
        paper.emit("Network.loadingFinished", { requestId: "r1" });
      });
    };
    const after = await browser.click(1);
    expect(after.text).toBe("Prices loaded.");
    expect(steps.now() - from).toBeGreaterThanOrEqual(600 + ownTiming.quietMs);
  });

  it("does not wait for a request that stays open, nor past its cap for a page that keeps loading", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    let from = 0;
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", {
        requestId: "s",
        type: "Fetch",
      });
    };
    await browser.click(1);
    const open = steps.now() - from;
    expect(open).toBeGreaterThanOrEqual(ownTiming.longRequestMs);
    expect(open).toBeLessThan(ownTiming.waitMs);
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", {
        requestId: "d",
        type: "Document",
      });
    };
    await browser.click(1);
    // A hanging Document request upgrades to the navigation cap (openWaitMs = 3000ms).
    expect(steps.now() - from).toBeGreaterThanOrEqual(ownTiming.openWaitMs);
    expect(steps.now() - from).toBeLessThan(ownTiming.openWaitMs + 500);
  });

  it("waits for text every 250 ms, and says whether it came", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    steps.later(700, () => {
      paper.page = { ...shop, text: "Kettles for sale. Ready now." };
    });
    const from = steps.now();
    const seen = await browser.waitFor!("ready NOW", 3000);
    expect(seen.found).toBe(true);
    expect(steps.now() - from).toBe(750);
    const missed = await browser.waitFor!("never there", 600);
    expect(missed.found).toBe(false);
    const before = paper.of("Runtime.evaluate").length;
    const plain = await browser.waitFor!(null, 400);
    expect(plain.found).toBeUndefined();
    expect(paper.of("Runtime.evaluate").length - before).toBe(1);
    expect(paper.launches).toHaveLength(1);
  });
});

describe("ClawdTime's own browser: tabs", () => {
  it("lists the web tabs with the active one, and switches to a listed one", async () => {
    const { paper, browser } = setup();
    paper.targets = [
      {
        targetId: "T1",
        type: "page",
        title: "Shop",
        url: "https://shop.test/",
      },
      {
        targetId: "X",
        type: "page",
        title: "Settings",
        url: "chrome://settings/",
      },
      {
        targetId: "W",
        type: "service_worker",
        title: "",
        url: "https://shop.test/sw.js",
      },
      {
        targetId: "T2",
        type: "page",
        title: "Mail",
        url: "https://mail.test/",
      },
    ];
    await expect(browser.switchTab!(1)).rejects.toThrow(/is not open/);
    const listed = await browser.tabs!();
    expect(listed.tabs).toEqual([
      { index: 1, title: "Shop", url: "https://shop.test/", active: true },
      { index: 2, title: "Mail", url: "https://mail.test/", active: false },
    ]);
    paper.sent.length = 0;
    await browser.switchTab!(2);
    expect(paper.of("Target.activateTarget")[0]!.params).toEqual({
      targetId: "T2",
    });
    expect(paper.of("Runtime.evaluate").at(-1)!.session).toBe("S-T2");
    expect((await browser.tabs!()).tabs!.find((tab) => tab.active)!.index).toBe(
      2,
    );
    paper.sent.length = 0;
    await expect(browser.switchTab!(3)).rejects.toThrow(
      /from the last list of tabs/,
    );
    paper.targets = paper.targets.filter((item) => item.targetId !== "T1");
    await expect(browser.switchTab!(1)).rejects.toThrow(
      /Tab 1 is not open any more/,
    );
    expect(paper.of("Target.activateTarget")).toEqual([]);
  });

  it("does not read or operate a page of the browser itself", async () => {
    const { paper, browser } = setup();
    paper.targets = [
      {
        targetId: "X",
        type: "page",
        title: "Settings",
        url: "chrome://settings/",
      },
    ];
    await browser.read();
    expect(paper.of("Target.createTarget")).toHaveLength(1);
    paper.page = { ...shop, url: "chrome://settings/" };
    await expect(browser.read()).rejects.toThrow(/one of its own pages/);
  });
});

describe("ClawdTime's own browser: doctor and close", () => {
  it("says whether a program is there, whether the profile can be written, and whether a running browser answers, and writes nothing", async () => {
    const none = new OwnBrowser({
      env: { CLAWDTIME_CONFIG_HOME: folder() },
      home: "/nowhere",
      runnable: () => false,
    });
    expect(await none.doctor()).toEqual({
      ok: false,
      browser: null,
      reason:
        "No browser for ClawdTime's own browser was found: install Google Chrome, or set CLAWDTIME_OWN_BROWSER_PATH to the program of Chromium, Brave or Edge.",
    });
    const named = new OwnBrowser({
      env: {
        CLAWDTIME_CONFIG_HOME: folder(),
        CLAWDTIME_OWN_BROWSER_PATH: "chrome",
      },
      runnable: () => true,
    });
    expect((await named.doctor()).reason).toMatch(
      /CLAWDTIME_OWN_BROWSER_PATH names no program that can run/,
    );
    const bundle = new OwnBrowser({
      env: {
        CLAWDTIME_CONFIG_HOME: folder(),
        CLAWDTIME_OWN_BROWSER_PATH: "/Applications/Brave Browser.app",
      },
      runnable: (path) =>
        path === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    });
    expect(await bundle.doctor()).toMatchObject({
      ok: true,
      browser: "Brave Browser",
    });

    const { root, profile, paper, browser, make } = setup();
    const ready = await browser.doctor();
    expect(ready).toMatchObject({ ok: true, browser: "Google Chrome" });
    expect(ready.reason).toMatch(/starts at the first browser step/);
    expect(readdirSync(root)).toEqual([]);
    expect(paper.launches).toEqual([]);

    await browser.read();
    expect((await browser.doctor()).reason).toMatch(
      /runs and answers on its own port/,
    );
    // Another process, as the command line is, asks the browser of the service.
    const other = make();
    expect((await other.doctor()).reason).toMatch(/runs and answers/);
    paper.refuseDial = true;
    expect(await make().doctor()).toMatchObject({ ok: false });
    paper.refuseDial = false;

    chmodSync(profile, 0o755);
    expect((await make().doctor()).reason).toBe(
      `The profile folder ${profile} is open to other users. Run: chmod 700 ${profile}`,
    );
    chmodSync(profile, 0o700);
    expect(paper.launches).toHaveLength(1);
  });

  it("refuses to start in a profile folder that others can read", async () => {
    const { profile, paper, browser } = setup();
    mkdirSync(profile, { recursive: true, mode: 0o755 });
    chmodSync(profile, 0o755);
    await expect(browser.read()).rejects.toThrow(/open to other users/);
    expect(paper.launches).toEqual([]);
  });

  it("closes the browser at service stop, and ends a program that keeps its port open", async () => {
    const { paper, browser } = setup();
    await browser.close();
    expect(paper.sent).toEqual([]);
    await browser.read();
    await browser.close();
    expect(paper.of("Browser.close")).toHaveLength(1);
    expect(paper.killed).toEqual([]);
    await browser.read();
    paper.closesOnBrowserClose = false;
    await browser.close();
    expect(paper.killed).toEqual([paper.pid]);
  });
});

describe("ClawdTime's own browser: its switch and the command line", () => {
  it("is chosen by CLAWDTIME_COMPUTER_BROWSER=own, and making it starts nothing", () => {
    const apple = {} as BrowserPort;
    const own = {} as BrowserPort;
    const made: string[] = [];
    const choose = (value: string | undefined) =>
      browserFromEnvironment(
        { [browserSwitch]: value },
        () => (made.push("on"), apple),
        () => (made.push("own"), own),
      );
    expect(choose("own")).toBe(own);
    expect(choose("on")).toBe(apple);
    for (const value of [undefined, "", "OWN", " own", "off", "yes"])
      expect(choose(value)).toBeUndefined();
    expect(made).toEqual(["own", "on"]);
    const root = folder();
    const real = browserFromEnvironment({
      [browserSwitch]: "own",
      CLAWDTIME_CONFIG_HOME: root,
    });
    expect(real).toBeInstanceOf(OwnBrowser);
    expect((real as OwnBrowser).profile).toBe(
      join(root, "computer", "browser-profile"),
    );
    expect(existsSync(join(root, "computer"))).toBe(false);
    expect(browserFromEnvironment({ [browserSwitch]: "on" })).toBeInstanceOf(
      AppleEventsBrowser,
    );
  });

  it("names the browser in status and doctor", async () => {
    const root = folder();
    const lines: string[] = [];
    const run = async (
      args: string[],
      env: Record<string, string>,
      browser?: BrowserPort,
    ) => {
      lines.length = 0;
      await computerCli(args, {
        env: { CLAWDTIME_CONFIG_HOME: root, ...env },
        home: "/nowhere",
        print: (line) => lines.push(line),
        ...(browser ? { browser } : {}),
      });
      return lines.join("\n");
    };
    expect(await run(["status"], { [browserSwitch]: "own" })).toMatch(
      /^Browser: ClawdTime's own browser, with its own profile\. It starts at the first browser step\./m,
    );
    expect(await run(["status"], { [browserSwitch]: "on" })).toMatch(
      /^Browser: the browser in front, through its own scripting\./m,
    );
    expect(await run(["status"], {})).not.toMatch(/Browser:/);
    expect(await run(["doctor"], {})).toMatch(
      /browser +off\..*CLAWDTIME_COMPUTER_BROWSER=own\./,
    );
    const fake = new FakeBrowser();
    fake.doctor = async () => ({
      ok: true,
      browser: "Google Chrome",
      reason: "It starts at the first browser step.",
    });
    expect(await run(["doctor"], { [browserSwitch]: "own" }, fake)).toMatch(
      /browser +ClawdTime's own browser, Google Chrome, can be driven\. It starts at the first browser step\./,
    );
    fake.doctor = async () => ({
      ok: false,
      browser: null,
      reason: "No browser for ClawdTime's own browser was found.",
    });
    expect(await run(["doctor"], { [browserSwitch]: "own" }, fake)).toMatch(
      /browser +cannot be driven\. No browser for ClawdTime's own browser was found\./,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("ClawdTime's own browser: fast settle, nav errors, popups, iframes and input upgrades", () => {
  it("ignores EventSource, WebSocket, Media, Ping, Manifest and worker scripts (loaderId === '') during settle", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    let from = 0;
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", {
        requestId: "sse",
        type: "EventSource",
        loaderId: "L1",
      });
      paper.emit("Network.requestWillBeSent", {
        requestId: "ws",
        type: "WebSocket",
        loaderId: "L1",
      });
      paper.emit("Network.requestWillBeSent", {
        requestId: "vid",
        type: "Media",
        loaderId: "L1",
      });
      paper.emit("Network.requestWillBeSent", {
        requestId: "ping",
        type: "Ping",
        loaderId: "L1",
      });
      paper.emit("Network.requestWillBeSent", {
        requestId: "man",
        type: "Manifest",
        loaderId: "L1",
      });
      paper.emit("Network.requestWillBeSent", {
        requestId: "sw",
        type: "Script",
        loaderId: "",
      });
    };
    await browser.click(1);
    // Settled immediately on first quiescence probe without stalling.
    expect(steps.now() - from).toBe(ownTiming.firstLookMs);
  });

  it("clears stale in-flight requests on OOPIF swap (Page.frameDetached reason === 'swap') and Page.frameStoppedLoading", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    let from = 0;
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", {
        requestId: "doc1",
        type: "Document",
        frameId: "F_SWAP",
      });
      steps.later(120, () => {
        paper.emit("Page.frameDetached", { frameId: "F_SWAP", reason: "swap" });
      });
    };
    await browser.click(1);
    expect(steps.now() - from).toBeLessThan(ownTiming.waitMs);

    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", {
        requestId: "doc2",
        type: "Document",
        frameId: "F_MAIN",
      });
      steps.later(120, () => {
        paper.emit("Page.frameStoppedLoading", { frameId: "F_MAIN" });
      });
    };
    await browser.click(1);
    expect(steps.now() - from).toBeLessThan(ownTiming.waitMs);
  });

  it("waits for MutationObserver quiescence (domIdleMs >= 80) and scrapes full DOM once", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    let probes = 0;
    paper.settle = () => {
      probes += 1;
      return {
        ok: true,
        readyState: probes === 1 ? "loading" : "complete",
        leaving: false,
        domIdleMs: probes < 4 ? 20 : 95,
      };
    };
    paper.sent.length = 0;
    const from = steps.now();
    await browser.click(1);
    expect(probes).toBe(4);
    // Only ONE full `read` ran after 4 lightweight `settle` probes!
    expect(paper.calls().filter((c) => c.do === "read")).toHaveLength(1);
    expect(paper.calls().filter((c) => c.do === "settle")).toHaveLength(4);
    expect(steps.now() - from).toBeLessThan(ownTiming.waitMs);
  });

  it("captures Network.loadingFailed errorText for Document loads and surfaces it to pageError", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      paper.emit("Network.requestWillBeSent", {
        requestId: "nav1",
        type: "Document",
        frameId: "T1",
      });
      paper.emit("Network.loadingFailed", {
        requestId: "nav1",
        type: "Document",
        errorText: "net::ERR_NAME_NOT_RESOLVED",
        canceled: false,
      });
      paper.page = {
        title: "",
        url: "chrome-error://chromewebdata/",
        text: "",
        elements: [],
      };
    };
    const failedPage = await browser.click(1);
    expect(pageError(failedPage)).toBe(
      "the server was not found (ERR_NAME_NOT_RESOLVED)",
    );
    // A subsequent successful navigation clears navError.
    paper.before = () => {};
    paper.page = { ...shop };
    const recovered = await browser.open("https://shop.test/");
    expect(pageError(recovered)).toBeNull();
  });

  it("auto-tracks target='_blank' popups opened by the active tab and exposes them in tabs()", async () => {
    const { paper, browser } = setup();
    await browser.read();
    expect(paper.of("Target.setDiscoverTargets")).toEqual([
      expect.objectContaining({ params: { discover: true } }),
    ]);
    paper.before = (sent) => {
      if (sent.params.type !== "mouseReleased") return;
      paper.page = {
        title: "Popup Checkout",
        url: "https://shop.test/checkout",
        text: "Checkout popup",
        elements: [element(10, "Pay")],
      };
      paper.emit("Target.targetCreated", {
        targetInfo: {
          targetId: "T_POPUP",
          type: "page",
          title: "Popup Checkout",
          url: "https://shop.test/checkout",
          openerId: "T1",
        },
      });
    };
    const popupPage = await browser.click(1);
    expect(popupPage.title).toBe("Popup Checkout");
    expect(popupPage.url).toBe("https://shop.test/checkout");
    // The active tab switched to T_POPUP and tabs() sees it immediately.
    paper.before = () => {};
    const listed = await browser.tabs!();
    expect(listed.tabs).toEqual([
      expect.objectContaining({ url: "about:blank", active: false }),
      expect.objectContaining({
        title: "Popup Checkout",
        url: "https://shop.test/checkout",
        active: true,
      }),
    ]);
  });

  it("traverses child iframes recursively, translates coordinates via DOM.getFrameOwner/getBoxModel, and routes clicks & password masks", async () => {
    const { paper, browser } = setup();
    paper.frameTree = {
      frameTree: {
        frame: { id: "F_MAIN", url: "https://shop.test/" },
        childFrames: [
          {
            frame: {
              id: "F_CHILD",
              parentId: "F_MAIN",
              url: "https://shop.test/embed",
            },
          },
        ],
      },
    };
    paper.worldByFrame.set("F_MAIN", 7);
    paper.worldByFrame.set("F_CHILD", 8);
    paper.frameOwners.set("F_CHILD", 99);
    // Iframe content box at (100, 200) -> (400, 500)
    paper.boxModels.set(99, [100, 200, 400, 200, 400, 500, 100, 500]);
    paper.pageByContext.set(8, {
      title: "Embed",
      url: "https://shop.test/embed",
      text: "Inside iframe",
      elements: [
        element(3, "Frame Pay"),
        element(4, "Card PIN", {
          tag: "input",
          role: "textbox",
          password: true,
          value: "9999",
        }),
      ],
    });
    paper.locateByContext.set(8, () =>
      box({
        x: 25,
        y: 30,
        name: 'Number 3, "Frame Pay",',
      }),
    );

    const seen = await browser.read();
    expect(seen.text).toContain("Kettles for sale.");
    expect(seen.text).toContain("Inside iframe");
    expect(seen.elements.map((el) => [el.index, el.label])).toEqual([
      [1, "Buy"],
      [2, "Name"],
      [3, "Frame Pay"],
      [4, "Card PIN"],
    ]);
    // Password value inside iframe is stripped too.
    expect(seen.elements[3]).not.toHaveProperty("value");

    // Clicking element 3 inside F_CHILD translates (25, 30) + (100, 200) => (125, 230).
    paper.sent.length = 0;
    await browser.click(3);
    const pressed = paper
      .of("Input.dispatchMouseEvent")
      .find((item) => item.params.type === "mousePressed");
    expect(pressed?.params).toMatchObject({ x: 125, y: 230 });
  });

  it("refuses clicking <input type='file'> before sending any mouse event", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.locate = () =>
      box({
        tag: "input",
        role: "button",
        kind: "press",
        name: 'Number 5, "Upload",',
        file: true,
        inputType: "file",
      });
    paper.sent.length = 0;
    await expect(browser.click(5)).rejects.toThrow(
      /file upload input.*native file picker dialog/i,
    );
    expect(paper.inputs()).toEqual([]);
  });

  it("supports Delete, Meta+A / Cmd+A, and Meta+Z / Cmd+Z while still refusing unsafe shortcuts", () => {
    expect(keyEvents("Delete")[0]).toMatchObject({
      key: "Delete",
      code: "Delete",
      windowsVirtualKeyCode: 46,
      commands: ["deleteForward"],
    });
    expect(
      keyEvents("Cmd+A").map((e) => [e.type, e.key, e.modifiers, e.commands]),
    ).toEqual([
      ["rawKeyDown", "Meta", 4, undefined],
      ["rawKeyDown", "a", 4, ["selectAll"]],
      ["keyUp", "a", 4, undefined],
      ["keyUp", "Meta", 0, undefined],
    ]);
    expect(keyEvents("Meta+A")).toEqual(keyEvents("Cmd+A"));
    expect(keyEvents("Meta+Z")[1]).toMatchObject({
      key: "z",
      code: "KeyZ",
      modifiers: 4,
      commands: ["undo"],
    });
    expect(keyEvents("Cmd+Z")).toEqual(keyEvents("Meta+Z"));
    for (const unsafe of ["Cmd+Q", "Meta+W", "Cmd+V"])
      expect(() => keyEvents(unsafe), unsafe).toThrow(
        /presses one of these keys/,
      );
  });

  it("sets native date/time inputs via the page script, falls back only when field is empty, and never clobbers masked inputs", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.locate = () =>
      box({
        tag: "input",
        role: "textbox",
        kind: "text",
        inputType: "date",
        name: 'Number 2, "Date",',
        focused: false,
      });
    paper.sent.length = 0;
    await browser.type(2, "2026-11-14", false);
    expect(paper.inputs()).toEqual([]);
    expect(paper.calls().find((c) => c.do === "type")).toMatchObject({
      do: "type",
      index: 2,
      text: "2026-11-14",
      submit: false,
    });

    // Controlled input fallback: insertText leaves field empty (""), so fallback { do: "type" } runs.
    paper.locate = () =>
      box({
        tag: "input",
        role: "textbox",
        kind: "text",
        name: 'Number 2, "Name",',
        focused: true,
      });
    paper.page = {
      ...shop,
      elements: [
        element(1, "Buy"),
        element(2, "Name", { tag: "input", role: "textbox", value: "" }),
      ],
    };
    paper.before = (sent) => {
      if (
        sent.method === "Runtime.evaluate" &&
        String(sent.params.expression).includes('"do":"type"')
      ) {
        paper.page = {
          ...shop,
          elements: [
            element(1, "Buy"),
            element(2, "Name", {
              tag: "input",
              role: "textbox",
              value: "Updated",
            }),
          ],
        };
      }
    };
    paper.sent.length = 0;
    const after = await browser.type(2, "Updated", false);
    expect(after.elements[1]!.value).toBe("Updated");
    expect(paper.calls().some((c) => c.do === "type")).toBe(true);

    // Masked/formatted input: insertText succeeds and page formats "(555) 123-4567".
    // Fallback { do: "type" } must NOT run so the mask is never clobbered.
    paper.before = () => {};
    paper.page = {
      ...shop,
      elements: [
        element(1, "Buy"),
        element(2, "Phone", {
          tag: "input",
          role: "textbox",
          value: "(555) 123-4567",
        }),
      ],
    };
    paper.sent.length = 0;
    const masked = await browser.type(2, "5551234567", false);
    expect(masked.elements[1]!.value).toBe("(555) 123-4567");
    expect(paper.calls().some((c) => c.do === "type")).toBe(false);

    // Fallback script error is swallowed when Input.insertText already succeeded,
    // reporting the standard empty-field error instead of leaking a raw script failure.
    paper.page = {
      ...shop,
      elements: [
        element(1, "Buy"),
        element(2, "Name", { tag: "input", role: "textbox", value: "" }),
      ],
    };
    paper.typeReply = () => ({
      ok: false,
      error: "The page script stopped with TypeError.",
    });
    await expect(browser.type(2, "Ada", false)).rejects.toThrow(
      /did not take that text/,
    );
    paper.typeReply = null;
  });

  it("blocks all input actions on chrome-error: warning pages and strips elements while keeping error detection", async () => {
    const { paper, browser } = setup();
    await browser.read();
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      paper.emit("Network.requestWillBeSent", {
        requestId: "cert1",
        type: "Document",
        frameId: "T1",
      });
      paper.emit("Network.loadingFailed", {
        requestId: "cert1",
        type: "Document",
        errorText: "net::ERR_CERT_AUTHORITY_INVALID",
        canceled: false,
      });
      paper.page = {
        title: "Privacy error",
        url: "chrome-error://chromewebdata/",
        text: "Your connection is not private",
        elements: [
          element(1, "Advanced"),
          element(2, "Proceed to bad.test (unsafe)", {
            tag: "a",
            role: "link",
          }),
        ],
      };
    };
    const warnPage = await browser.click(1);
    expect(pageError(warnPage)).toBe(
      "a certificate error (ERR_CERT_AUTHORITY_INVALID)",
    );
    // Warning links/buttons must never be offered to the planner.
    expect(warnPage.elements).toEqual([]);

    // Every input action on chrome-error: must be refused with zero input events sent.
    paper.before = () => {};
    paper.sent.length = 0;
    await expect(browser.click(1)).rejects.toThrow(/one of its own pages/);
    await expect(browser.type(1, "x", false)).rejects.toThrow(
      /one of its own pages/,
    );
    await expect(browser.hover!(1)).rejects.toThrow(/one of its own pages/);
    await expect(browser.select!(1, "Advanced")).rejects.toThrow(
      /one of its own pages/,
    );
    await expect(browser.key!("Enter")).rejects.toThrow(/one of its own pages/);
    await expect(browser.scroll("down")).rejects.toThrow(
      /one of its own pages/,
    );
    expect(paper.inputs()).toEqual([]);

    // back() remains allowed so the agent can leave the error page.
    paper.history = {
      currentIndex: 1,
      entries: [
        { id: 7, url: "https://shop.test/" },
        { id: 8, url: "https://bad.test/" },
      ],
    };
    paper.page = { ...shop };
    const escaped = await browser.back();
    expect(escaped.url).toBe("https://shop.test/");
    expect(pageError(escaped)).toBeNull();
  });

  it("walks deterministically down the focused frame chain for key() and refuses password/uncached/unlisted frames", async () => {
    const { paper, browser } = setup();
    const frameRefusal = {
      ok: false,
      error:
        "The focus is in a frame of the page, which ClawdTime cannot see into. No key was pressed. Click into the page itself, or use the screen.",
    };
    const passwordRefusal = {
      ok: false,
      error:
        "The focus is in a password field. The worker never presses a key there: ask the person.",
    };

    paper.frameTree = {
      frameTree: {
        frame: { id: "F_MAIN", url: "https://shop.test/" },
        childFrames: [
          {
            frame: {
              id: "F_AD",
              parentId: "F_MAIN",
              url: "https://ads.test/banner",
            },
          },
          {
            frame: {
              id: "F_OUTER",
              parentId: "F_MAIN",
              url: "https://shop.test/outer",
            },
            childFrames: [
              {
                frame: {
                  id: "F_SECRET",
                  parentId: "F_OUTER",
                  url: "https://shop.test/secret",
                },
              },
              {
                frame: {
                  id: "F_NO_WORLD",
                  parentId: "F_OUTER",
                  url: "https://shop.test/noworld",
                },
              },
            ],
          },
        ],
      },
    };
    paper.worldByFrame.set("F_MAIN", 7);
    paper.worldByFrame.set("F_AD", 8);
    paper.worldByFrame.set("F_OUTER", 9);
    paper.worldByFrame.set("F_SECRET", 10);
    paper.frameOwners.set("F_AD", 81);
    paper.boxModels.set(81, [0, 0, 200, 0, 200, 100, 0, 100]);
    paper.pageByContext.set(8, {
      title: "Ad",
      url: "https://ads.test/banner",
      text: "Ad",
      elements: [],
    });
    // Only F_AD is cached by read() (F_OUTER has no boxModel yet).
    await browser.read();

    // Case 1: F_AD passes focusCheck, while focus is ACTUALLY in nested F_OUTER -> F_SECRET (password).
    paper.focusByContext.set(7, frameRefusal);
    paper.focusByContext.set(8, { ok: true });
    paper.focusByContext.set(9, frameRefusal);
    paper.focusByContext.set(10, passwordRefusal);
    paper.focusedChildByContext.set(7, "F_OUTER");
    paper.focusedChildByContext.set(9, "F_SECRET");
    paper.sent.length = 0;
    await expect(browser.key!("Space")).rejects.toThrow(/password field/);
    expect(paper.of("Input.dispatchKeyEvent")).toEqual([]);

    // Case 2: Focused child frame cannot be resolved (e.g. <object> or unlisted frame) -> REFUSE even though F_AD is cached!
    paper.focusedChildByContext.set(7, "F_UNKNOWN");
    paper.sent.length = 0;
    await expect(browser.key!("Enter")).rejects.toThrow(
      /focus is in a frame of the page/,
    );
    expect(paper.of("Input.dispatchKeyEvent")).toEqual([]);

    // Case 3: Focused child frame has no isolated world -> REFUSE!
    paper.focusedChildByContext.set(7, "F_OUTER");
    paper.focusedChildByContext.set(9, "F_NO_WORLD");
    paper.worldByFrame.set("F_NO_WORLD", null);
    paper.sent.length = 0;
    await expect(browser.key!("Enter")).rejects.toThrow(
      /focus is in a frame of the page/,
    );
    expect(paper.of("Input.dispatchKeyEvent")).toEqual([]);

    // Case 4: Focused leaf frame is non-password and owns focus -> ALLOWED!
    paper.focusedChildByContext.set(9, "F_SECRET");
    paper.worldByFrame.set("F_SECRET", 10);
    paper.focusByContext.set(10, { ok: true });
    paper.sent.length = 0;
    await browser.key!("Enter");
    expect(paper.of("Input.dispatchKeyEvent")).toHaveLength(2);
  });

  it("preserves 1500ms longRequestMs for POST/Fetch requests started during a click step without double-click settle", async () => {
    const { paper, steps, browser } = setup();
    await browser.read();
    let from = 0;
    paper.before = (sent) => {
      if (sent.params.type !== "mousePressed") return;
      from = steps.now();
      paper.emit("Network.requestWillBeSent", {
        requestId: "pay1",
        type: "Fetch",
        frameId: "T1",
      });
      steps.later(1000, () => {
        paper.page = { ...shop, text: "Payment confirmed." };
        paper.emit("Network.loadingFinished", { requestId: "pay1" });
      });
    };
    const after = await browser.click(1);
    expect(after.text).toBe("Payment confirmed.");
    expect(steps.now() - from).toBeGreaterThanOrEqual(1000 + ownTiming.quietMs);
    expect(steps.now() - from).toBeLessThan(ownTiming.waitMs);
  });

  it("ignores ERR_ABORTED, untracked, and ad-frame loadingFailed events and never attaches navError on healthy https pages", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // 1. net::ERR_ABORTED on main-frame Document (e.g. download / 204 / aborted prefetch) -> ignored.
    paper.emit("Network.requestWillBeSent", {
      requestId: "dl1",
      type: "Document",
      frameId: "T1",
    });
    paper.emit("Network.loadingFailed", {
      requestId: "dl1",
      type: "Document",
      errorText: "net::ERR_ABORTED",
      canceled: false,
    });
    expect(pageError(await browser.read())).toBeNull();

    // 2. Untracked Network.loadingFailed (never seen in requestWillBeSent) -> ignored.
    paper.emit("Network.loadingFailed", {
      requestId: "ghost-req",
      type: "Document",
      errorText: "net::ERR_CONNECTION_REFUSED",
      canceled: false,
    });
    expect(pageError(await browser.read())).toBeNull();

    // 3. Sub-frame / ad-frame Document failure -> ignored.
    paper.emit("Network.requestWillBeSent", {
      requestId: "ad-doc",
      type: "Document",
      frameId: "F_AD_IFRAME",
    });
    paper.emit("Network.loadingFailed", {
      requestId: "ad-doc",
      type: "Document",
      errorText: "net::ERR_BLOCKED_BY_CLIENT",
      canceled: false,
    });
    expect(pageError(await browser.read())).toBeNull();

    // 4. Even if main-frame Document fails, while tab stays on healthy https:// URL, navError is never attached.
    paper.emit("Network.requestWillBeSent", {
      requestId: "stale-nav",
      type: "Document",
      frameId: "T1",
    });
    paper.emit("Network.loadingFailed", {
      requestId: "stale-nav",
      type: "Document",
      errorText: "net::ERR_CONNECTION_REFUSED",
      canceled: false,
    });
    const healthy = await browser.read();
    expect(healthy.url).toBe("https://shop.test/");
    expect(pageError(healthy)).toBeNull();
  });

  it("checks frameHitCheck at every level of nested iframe chains to defeat nested clickjacking overlays", async () => {
    const { paper, browser } = setup();
    paper.frameTree = {
      frameTree: {
        frame: { id: "F_MAIN", url: "https://shop.test/" },
        childFrames: [
          {
            frame: {
              id: "F_OUTER",
              parentId: "F_MAIN",
              url: "https://shop.test/outer",
            },
            childFrames: [
              {
                frame: {
                  id: "F_INNER",
                  parentId: "F_OUTER",
                  url: "https://shop.test/inner",
                },
              },
            ],
          },
        ],
      },
    };
    paper.worldByFrame.set("F_MAIN", 7);
    paper.worldByFrame.set("F_OUTER", 8);
    paper.worldByFrame.set("F_INNER", 9);
    paper.frameOwners.set("F_OUTER", 101);
    paper.frameOwners.set("F_INNER", 102);
    paper.boxModels.set(101, [50, 60, 450, 60, 450, 460, 50, 460]);
    paper.boxModels.set(102, [20, 30, 320, 30, 320, 230, 20, 230]);
    paper.pageByContext.set(8, {
      title: "Outer",
      url: "https://shop.test/outer",
      text: "Outer",
      elements: [],
    });
    paper.pageByContext.set(9, {
      title: "Inner",
      url: "https://shop.test/inner",
      text: "Inner",
      elements: [element(3, "Inner Pay")],
    });
    paper.locateByContext.set(9, () =>
      box({ x: 15, y: 25, name: 'Number 3, "Inner Pay",' }),
    );
    // Top frame F_MAIN -> F_OUTER is unobstructed, but F_OUTER has a <div> overlay over F_INNER!
    paper.frameHitByBackendNode.set(101, { ok: true });
    paper.frameHitByBackendNode.set(102, { ok: false, cover: "div" });

    await browser.read();
    paper.sent.length = 0;
    await expect(browser.click(3)).rejects.toThrow(
      /under another element at its centre \(div\)\. Nothing was sent/,
    );
    expect(paper.inputs()).toEqual([]);
  });

  it("never falls back to top-level world for child frames and inherits OOPIF session for nested same-origin frames", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // Attach OOPIF F_OOPIF on session S-OOPIF.
    paper.emit("Target.attachedToTarget", {
      sessionId: "S-OOPIF",
      targetInfo: {
        targetId: "F_OOPIF",
        type: "iframe",
        url: "https://x.test/",
      },
    });

    paper.frameTree = {
      frameTree: {
        frame: { id: "F_MAIN", url: "https://shop.test/" },
        childFrames: [
          {
            frame: {
              id: "F_BROKEN",
              parentId: "F_MAIN",
              url: "https://shop.test/broken",
            },
          },
          {
            frame: {
              id: "F_OOPIF",
              parentId: "F_MAIN",
              url: "https://x.test/",
            },
            childFrames: [
              {
                frame: {
                  id: "F_NESTED_IN_OOPIF",
                  parentId: "F_OOPIF",
                  url: "https://x.test/inner",
                },
              },
            ],
          },
        ],
      },
    };
    paper.worldByFrame.set("F_MAIN", 7);
    // F_BROKEN fails to produce an isolated world: must be skipped, NEVER run without contextId!
    paper.worldByFrame.set("F_BROKEN", null);
    paper.worldByFrame.set("F_OOPIF", 11);
    paper.worldByFrame.set("F_NESTED_IN_OOPIF", 12);
    paper.frameOwners.set("F_BROKEN", 200);
    paper.frameOwners.set("F_OOPIF", 201);
    paper.frameOwners.set("F_NESTED_IN_OOPIF", 202);
    paper.boxModels.set(200, [0, 0, 100, 0, 100, 100, 0, 100]);
    paper.boxModels.set(201, [100, 100, 500, 100, 500, 400, 100, 400]);
    paper.boxModels.set(202, [10, 20, 210, 20, 210, 120, 10, 120]);
    paper.pageByContext.set(11, {
      title: "OOPIF",
      url: "https://x.test/",
      text: "OOPIF outer",
      elements: [],
    });
    paper.pageByContext.set(12, {
      title: "OOPIF Inner",
      url: "https://x.test/inner",
      text: "Nested inside OOPIF",
      elements: [element(5, "Nested OOPIF Button")],
    });
    paper.locateByContext.set(12, () =>
      box({ x: 30, y: 40, name: 'Number 5, "Nested OOPIF Button",' }),
    );

    paper.sent.length = 0;
    const seen = await browser.read();
    // F_BROKEN must never have triggered an evaluate without a contextId.
    expect(
      paper
        .of("Runtime.evaluate")
        .every((cmd) => typeof cmd.params.contextId === "number"),
    ).toBe(true);
    // F_NESTED_IN_OOPIF inherited S-OOPIF session (not S-T1)!
    const nestedWorldCmd = paper
      .of("Page.createIsolatedWorld")
      .find((cmd) => cmd.params.frameId === "F_NESTED_IN_OOPIF");
    expect(nestedWorldCmd?.session).toBe("S-OOPIF");
    expect(seen.elements.map((el) => el.label)).toContain(
      "Nested OOPIF Button",
    );

    // Clicking element 5 translates (30, 40) + (10, 20) + (100, 100) = (140, 160)
    // and runs DOM.getFrameOwner for F_NESTED_IN_OOPIF on S-OOPIF.
    paper.sent.length = 0;
    await browser.click(5);
    const ownerCmd = paper
      .of("DOM.getFrameOwner")
      .find((cmd) => cmd.params.frameId === "F_NESTED_IN_OOPIF");
    expect(ownerCmd?.session).toBe("S-OOPIF");
    const pressed = paper
      .of("Input.dispatchMouseEvent")
      .find((cmd) => cmd.params.type === "mousePressed");
    expect(pressed?.params).toMatchObject({ x: 140, y: 160 });
  });
});

describe("ClawdTime's own browser: Wave 2 CDP capabilities", () => {
  it("keeps read() and tabs() throwing dialogText when a dialog is open, while handleDialog() answers it", async () => {
    const { paper, browser } = setup();
    // Before the browser is open, handleDialog refuses with nothing sent.
    await expect(browser.handleDialog!(true)).rejects.toThrow(
      /is not open\. Nothing was sent\./,
    );
    await browser.read();

    // No dialog open yet -> refuses cleanly without sending Page.handleJavaScriptDialog.
    await expect(browser.handleDialog!(true)).rejects.toThrow(
      /no open dialog/i,
    );
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([]);

    // Trigger a prompt dialog during click -> click still reports the dialog.
    paper.before = (sent) => {
      if (sent.params.type === "mouseReleased") {
        paper.emit("Page.javascriptDialogOpening", {
          message: "Enter confirmation code",
          type: "prompt",
        });
      }
    };
    await expect(browser.click(1)).rejects.toThrow(
      /The page shows a dialog: "Enter confirmation code"\./,
    );
    paper.before = () => {};

    // read() and tabs() still throw dialogText so live planners never mistake a dialog for an empty page.
    paper.sent.length = 0;
    await expect(browser.read()).rejects.toThrow(
      /The page shows a dialog: "Enter confirmation code"\./,
    );
    await expect(browser.tabs!()).rejects.toThrow(
      /The page shows a dialog: "Enter confirmation code"\./,
    );
    expect(paper.of("Runtime.evaluate")).toEqual([]);

    // handleDialog sends Page.handleJavaScriptDialog, clears tab.dialog, settles, and returns fresh page.
    paper.page = { ...shop, text: "Code accepted." };
    paper.sent.length = 0;
    const after = await browser.handleDialog!(true, "ORDER-42");
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([
      expect.objectContaining({
        params: { accept: true, promptText: "ORDER-42" },
        session: "S-T1",
      }),
    ]);
    expect(after.dialog).toBeUndefined();
    expect(after.text).toBe("Code accepted.");

    // Dismissing a beforeunload dialog passes accept: false with no promptText.
    paper.emit("Page.javascriptDialogOpening", {
      message: "Leave page?",
      type: "beforeunload",
    });
    await expect(browser.read()).rejects.toThrow(
      /The page shows a dialog: "Leave page\?"\./,
    );
    paper.sent.length = 0;
    await browser.handleDialog!(false);
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([
      expect.objectContaining({
        params: { accept: false },
        session: "S-T1",
      }),
    ]);

    // Refuses handleDialog on chrome-error: pages and never echoes overly long promptText in errors.
    paper.page = {
      title: "Privacy error",
      url: "chrome-error://chromewebdata/",
      text: "",
      elements: [],
    };
    await browser.read();
    paper.emit("Page.javascriptDialogOpening", {
      message: "Alert on error page",
      type: "alert",
    });
    paper.sent.length = 0;
    await expect(browser.handleDialog!(true)).rejects.toThrow(
      /one of its own pages/,
    );
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([]);

    const longSecret = "s".repeat(25_000);
    try {
      await browser.handleDialog!(true, longSecret);
      expect.unreachable("should reject long promptText");
    } catch (error) {
      expect(String(error)).toMatch(/too long/i);
      expect(String(error)).not.toContain("sssss");
    }
  });

  it("routes OOPIF Page.javascriptDialogOpening to the parent tab and sends Page.handleJavaScriptDialog to the OOPIF session", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // Attach an OOPIF under S-T1 and a nested OOPIF under that OOPIF.
    paper.emit(
      "Target.attachedToTarget",
      {
        sessionId: "S-OOPIF-1",
        targetInfo: {
          targetId: "F_OOPIF_1",
          type: "iframe",
          url: "https://pay.test/frame",
        },
      },
      "S-T1",
    );
    paper.emit(
      "Target.attachedToTarget",
      {
        sessionId: "S-OOPIF-2",
        targetInfo: {
          targetId: "F_OOPIF_2",
          type: "iframe",
          url: "https://verify.test/frame",
        },
      },
      "S-OOPIF-1",
    );

    // Direct OOPIF dialog blocks read() on parent tab and handleDialog targets S-OOPIF-1.
    paper.emit(
      "Page.javascriptDialogOpening",
      { message: "Confirm payment?", type: "confirm" },
      "S-OOPIF-1",
    );
    await expect(browser.read()).rejects.toThrow(
      /The page shows a dialog: "Confirm payment\?"\./,
    );
    paper.sent.length = 0;
    const afterDirect = await browser.handleDialog!(true);
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([
      expect.objectContaining({
        params: { accept: true },
        session: "S-OOPIF-1",
      }),
    ]);
    expect(afterDirect.title).toBe("Shop");

    // Nested OOPIF dialog also resolves to parent tab and routes to S-OOPIF-2.
    paper.emit(
      "Page.javascriptDialogOpening",
      { message: "Enter PIN", type: "prompt" },
      "S-OOPIF-2",
    );
    await expect(browser.read()).rejects.toThrow(
      /The page shows a dialog: "Enter PIN"\./,
    );
    paper.sent.length = 0;
    await browser.handleDialog!(true, "4321");
    expect(paper.of("Page.handleJavaScriptDialog")).toEqual([
      expect.objectContaining({
        params: { accept: true, promptText: "4321" },
        session: "S-OOPIF-2",
      }),
    ]);

    // External close event on OOPIF session clears the tab dialog cleanly.
    paper.emit(
      "Page.javascriptDialogOpening",
      { message: "Wait", type: "alert" },
      "S-OOPIF-1",
    );
    paper.emit("Page.javascriptDialogClosed", {}, "S-OOPIF-1");
    const recovered = await browser.read();
    expect(recovered.title).toBe("Shop");
  });

  it("opens new tabs with URL validation via newTab() and closes tabs safely via closeTab()", async () => {
    const { paper, browser } = setup();
    // Refuses non-web URLs before launching the browser.
    await expect(browser.newTab!("file:///etc/hosts")).rejects.toThrow(
      /Only http and https/,
    );
    await expect(browser.newTab!("javascript:alert(1)")).rejects.toThrow(
      /Only http and https/,
    );
    expect(paper.launches).toEqual([]);

    // Opening a blank new tab starts the browser, creates about:blank target, switches current, settles.
    const blankPage = await browser.newTab!();
    expect(paper.of("Target.createTarget")[0]!.params).toEqual({
      url: "about:blank",
    });
    expect(blankPage.browser).toBe("own");

    // Opening a URL new tab passes the validated URL to Target.createTarget and activates it.
    paper.page = { ...shop, title: "Catalog", url: "https://shop.test/items" };
    const itemPage = await browser.newTab!("https://shop.test/items");
    expect(paper.of("Target.createTarget")[1]!.params).toEqual({
      url: "https://shop.test/items",
    });
    expect(itemPage.title).toBe("Catalog");

    // closeTab() closes the current tab and switches to a remaining tab.
    paper.sent.length = 0;
    paper.page = { ...shop, title: "Shop", url: "https://shop.test/" };
    const afterClose = await browser.closeTab!();
    expect(paper.of("Target.closeTarget")).toHaveLength(1);
    expect(paper.of("Target.closeTarget")[0]!.params).toEqual({
      targetId: "T3",
    });
    expect(afterClose.title).toBe("Shop");

    // closeTab(tabId) closes a specific tab by targetId.
    paper.sent.length = 0;
    await browser.closeTab!("T1");
    expect(paper.of("Target.closeTarget")[0]!.params).toEqual({
      targetId: "T1",
    });

    // Only one tab left (T2) -> refuses closing the very last open tab and sends nothing.
    paper.sent.length = 0;
    await expect(browser.closeTab!()).rejects.toThrow(
      /Cannot close the last open tab/,
    );
    expect(paper.of("Target.closeTarget")).toEqual([]);
  });

  it("fills multiple form fields in one batch via fillForm(), failing closed before any input on password or hidden fields", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // Bounds check: 0 or >20 fields refused before any CDP call.
    paper.sent.length = 0;
    await expect(browser.fillForm!([])).rejects.toThrow(/between 1 and 20/i);
    await expect(
      browser.fillForm!(
        Array.from({ length: 21 }, (_, i) => ({ index: i + 1, text: "x" })),
      ),
    ).rejects.toThrow(/between 1 and 20/i);
    expect(paper.sent).toEqual([]);

    // Fail closed BEFORE any input when field #2 is a password field!
    paper.locate = (index) =>
      index === 2
        ? box({
            tag: "input",
            role: "textbox",
            kind: "text",
            name: 'Number 2, "Name",',
            focused: true,
          })
        : box({
            tag: "input",
            role: "textbox",
            kind: "text",
            name: 'Number 3, "Password",',
            password: true,
          });
    paper.sent.length = 0;
    await expect(
      browser.fillForm!([
        { index: 2, text: "Ada Brook" },
        { index: 3, text: "never-type-this" },
      ]),
    ).rejects.toThrow(/password field/);
    // Zero mouse, key, or insertText events went out for field #1!
    expect(paper.inputs()).toEqual([]);
    expect(JSON.stringify(paper.sent)).not.toContain("never-type-this");

    // Fail closed BEFORE any input when a later field is covered/hidden!
    paper.locate = (index) =>
      index === 2
        ? box({
            tag: "input",
            role: "textbox",
            kind: "text",
            name: 'Number 2, "Name",',
            focused: true,
          })
        : box({
            tag: "input",
            role: "textbox",
            kind: "text",
            name: 'Number 4, "Email",',
            hit: false,
            cover: "div",
          });
    paper.sent.length = 0;
    await expect(
      browser.fillForm!([
        { index: 2, text: "Ada Brook" },
        { index: 4, text: "ada@shop.example" },
      ]),
    ).rejects.toThrow(/under another element/);
    expect(paper.inputs()).toEqual([]);

    // Successful 3-field batch fill (input + select + textarea with newline) settles ONCE!
    paper.locate = (index) => {
      if (index === 2)
        return box({
          tag: "input",
          role: "textbox",
          kind: "text",
          name: 'Number 2, "Name",',
          focused: true,
        });
      if (index === 3)
        return box({
          tag: "select",
          role: "combobox",
          kind: "choice",
          name: 'Number 3, "Role",',
        });
      return box({
        tag: "textarea",
        role: "textbox",
        kind: "text",
        name: 'Number 4, "Bio",',
        focused: true,
      });
    };
    paper.page = {
      ...shop,
      elements: [
        element(2, "Name", { tag: "input", role: "textbox", value: "Ada" }),
        element(3, "Role", { tag: "select", role: "combobox", value: "Admin" }),
        element(4, "Bio", {
          tag: "textarea",
          role: "textbox",
          value: "Line one Line two",
        }),
      ],
    };
    paper.sent.length = 0;
    const after = await browser.fillForm!([
      { index: 2, text: "Ada" },
      { index: 3, text: "Admin" },
      { index: 4, text: "Line one\nLine two" },
    ]);
    expect(after.elements[0]!.value).toBe("Ada");
    expect(paper.of("Input.insertText").map((cmd) => cmd.params.text)).toEqual([
      "Ada",
      "Line one\nLine two",
    ]);
    // Only ONE settle probe + ONE full read at the end!
    expect(paper.calls().filter((c) => c.do === "settle")).toHaveLength(1);
    expect(paper.calls().filter((c) => c.do === "read")).toHaveLength(1);

    // Stops immediately if navigation occurs mid-batch and throws BrowserInputUnknown (never silent partial success).
    paper.before = (sent) => {
      if (sent.method === "Input.insertText" && sent.params.text === "First") {
        paper.emit("Page.frameNavigated", {
          frame: { id: "F_MAIN", url: "https://shop.test/redirected" },
        });
      }
    };
    paper.sent.length = 0;
    try {
      await browser.fillForm!([
        { index: 2, text: "First" },
        { index: 4, text: "ShouldNotType" },
      ]);
      expect.unreachable("should throw BrowserInputUnknown on partial fill");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserInputUnknown);
      expect(String(error)).toMatch(/1 of 2 field\(s\)/);
      expect(String(error)).toMatch(/skipped field\(s\): 4/);
    }
    expect(paper.of("Input.insertText").map((cmd) => cmd.params.text)).toEqual([
      "First",
    ]);
    paper.before = () => {};

    // Early stop on popup mid-batch also throws BrowserInputUnknown.
    paper.before = (sent) => {
      if (sent.method === "Input.insertText" && sent.params.text === "Pop") {
        paper.emit("Target.targetCreated", {
          targetInfo: {
            targetId: "T_MID_POPUP",
            type: "page",
            title: "Popup",
            url: "https://shop.test/popup",
            openerId: "T1",
          },
        });
      }
    };
    paper.sent.length = 0;
    await expect(
      browser.fillForm!([
        { index: 2, text: "Pop" },
        { index: 4, text: "Skipped" },
      ]),
    ).rejects.toBeInstanceOf(BrowserInputUnknown);
    paper.before = () => {};

    // Mid-form error on field 2 (e.g. takesText disabled after field 1 filled) wraps in BrowserInputUnknown naming filled field(s).
    let locateCount4 = 0;
    paper.locate = (index) => {
      if (index === 2)
        return box({
          tag: "div",
          role: "textbox",
          kind: "region",
          name: 'Number 2, "Note",',
          focused: true,
        });
      locateCount4 += 1;
      // Phase 1 passes; Phase 2 sees field 4 turned disabled after field 2 was filled.
      return box({
        tag: "textarea",
        role: "textbox",
        kind: "text",
        name: 'Number 4, "Bio",',
        focused: true,
        disabled: locateCount4 >= 2,
      });
    };
    paper.sent.length = 0;
    try {
      await browser.fillForm!([
        { index: 2, text: "Already written" },
        { index: 4, text: "Second field" },
      ]);
      expect.unreachable("should throw BrowserInputUnknown on field 2 error");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserInputUnknown);
      expect(String(error)).toMatch(
        /already filling 1 field\(s\) \(number\(s\) 2\)/,
      );
      expect(String(error)).toMatch(/is disabled now/);
    }

    // Mid-form focus loss on field 2 after field 1 filled also wraps in BrowserInputUnknown.
    let locateCount5 = 0;
    paper.locate = (index) => {
      if (index === 2)
        return box({
          tag: "div",
          role: "textbox",
          kind: "region",
          name: 'Number 2, "Note",',
          focused: true,
        });
      locateCount5 += 1;
      // Phase 1 and Phase 2 pre-click see unfocused; post-click locate still sees focused: false.
      return box({
        tag: "input",
        role: "textbox",
        kind: "text",
        name: 'Number 5, "Code",',
        focused: false,
      });
    };
    try {
      await browser.fillForm!([
        { index: 2, text: "Contenteditable text" },
        { index: 5, text: "ABC" },
      ]);
      expect.unreachable("should throw BrowserInputUnknown on focus loss");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserInputUnknown);
      expect(String(error)).toMatch(
        /already filling 1 field\(s\) \(number\(s\) 2\)/,
      );
      expect(String(error)).toMatch(/did not take the focus/);
    }
    expect(locateCount5).toBeGreaterThanOrEqual(2);
  });

  it("closeTab() clears stale tab listing and removes OOPIF entries belonging to the closed tab", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // Attach an OOPIF on T1 (kept) and a nested OOPIF tree on T2 (to be closed).
    paper.emit(
      "Target.attachedToTarget",
      {
        sessionId: "S-OOPIF-T1",
        targetInfo: {
          targetId: "F_OOPIF_T1",
          type: "iframe",
          url: "https://keep.test/",
        },
      },
      "S-T1",
    );
    await browser.newTab!("https://shop.test/second");
    paper.emit(
      "Target.attachedToTarget",
      {
        sessionId: "S-OOPIF-T2",
        targetInfo: {
          targetId: "F_OOPIF_T2",
          type: "iframe",
          url: "https://drop.test/",
        },
      },
      "S-T2",
    );
    paper.emit(
      "Target.attachedToTarget",
      {
        sessionId: "S-OOPIF-T2-CHILD",
        targetInfo: {
          targetId: "F_OOPIF_T2_CHILD",
          type: "iframe",
          url: "https://drop-child.test/",
        },
      },
      "S-OOPIF-T2",
    );

    // Populate listing via tabs(), then close T2.
    await browser.tabs!();
    await browser.closeTab!("T2");

    // Stale listing is cleared so switchTab(1) refuses until tabs() is called again.
    await expect(browser.switchTab!(1)).rejects.toThrow(
      /from the last list of tabs/,
    );

    // Closed tab's OOPIFs are gone, while T1's OOPIF remains intact.
    const internal = browser as unknown as {
      oopifsByFrameId: Map<string, unknown>;
      oopifsBySession: Map<string, unknown>;
    };
    expect(internal.oopifsByFrameId.has("F_OOPIF_T2")).toBe(false);
    expect(internal.oopifsByFrameId.has("F_OOPIF_T2_CHILD")).toBe(false);
    expect(internal.oopifsBySession.has("S-OOPIF-T2")).toBe(false);
    expect(internal.oopifsBySession.has("S-OOPIF-T2-CHILD")).toBe(false);
    expect(internal.oopifsByFrameId.has("F_OOPIF_T1")).toBe(true);
    expect(internal.oopifsBySession.has("S-OOPIF-T1")).toBe(true);
  });

  it("newTab() resets pendingPopup so a stale popup is never adopted instead of the new tab", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // Simulate a stale popup target created earlier with openerId T1.
    paper.emit("Target.targetCreated", {
      targetInfo: {
        targetId: "T_STALE_POPUP",
        type: "page",
        title: "Stale Popup",
        url: "https://stale.test/",
        openerId: "T1",
      },
    });

    paper.page = {
      ...shop,
      title: "Fresh Tab",
      url: "https://shop.test/fresh",
    };
    const opened = await browser.newTab!("https://shop.test/fresh");
    expect(opened.title).toBe("Fresh Tab");
    expect(opened.url).toBe("https://shop.test/fresh");
    // Must attach and activate T2, never T_STALE_POPUP.
    const attachedIds = paper
      .of("Target.attachToTarget")
      .map((cmd) => cmd.params.targetId);
    expect(attachedIds).toContain("T2");
    expect(attachedIds).not.toContain("T_STALE_POPUP");
  });

  it("updates tab.url when a tab genuinely navigates to about:blank while preserving known URL on switchTab/closeTab", async () => {
    const { paper, browser } = setup();
    const internal = browser as unknown as {
      tabsById: Map<string, { url: string }>;
    };
    await browser.read();
    expect(internal.tabsById.get("T1")?.url).toBe("https://shop.test/");

    // When Target.getTargets reports T1 genuinely navigated to about:blank, tab() -> attach() updates tab.url immediately (before look()).
    paper.targets[0]!.url = "about:blank";
    let urlAtEvaluate = "";
    paper.before = (sent) => {
      if (sent.method === "Runtime.evaluate" && !urlAtEvaluate) {
        urlAtEvaluate = internal.tabsById.get("T1")?.url ?? "";
      }
    };
    paper.page = { title: "", url: "about:blank", text: "", elements: [] };
    await browser.read();
    paper.before = () => {};
    expect(urlAtEvaluate).toBe("about:blank");

    // On switchTab() (preserveUrl: true), a stale about:blank from Target.getTargets does not overwrite the target tab's known URL before settle/look.
    paper.targets[0]!.url = "https://shop.test/";
    paper.page = { ...shop };
    await browser.read();
    expect(internal.tabsById.get("T1")?.url).toBe("https://shop.test/");
    paper.page = { ...shop, url: "https://shop.test/second" };
    await browser.newTab!("https://shop.test/second");
    expect(internal.tabsById.get("T2")?.url).toBe("https://shop.test/second");
    await browser.tabs!();
    paper.targets[0]!.url = "about:blank";
    let urlAtSwitchSettle = "";
    paper.before = (sent) => {
      if (sent.method === "Runtime.evaluate" && !urlAtSwitchSettle) {
        urlAtSwitchSettle = internal.tabsById.get("T1")?.url ?? "";
      }
    };
    paper.page = { ...shop };
    await browser.switchTab!(1);
    paper.before = () => {};
    expect(urlAtSwitchSettle).toBe("https://shop.test/");
  });

  it("allows newlines in textarea and contenteditable, while blocking newlines in single-line inputs", async () => {
    const { paper, browser } = setup();
    await browser.read();

    // Single-line <input> rejects newlines BEFORE sending any input.
    paper.locate = () =>
      box({
        tag: "input",
        role: "textbox",
        kind: "text",
        name: 'Number 2, "Name",',
        focused: true,
      });
    paper.sent.length = 0;
    await expect(browser.type(2, "Ada\nBrook", false)).rejects.toThrow(
      /single-line field and does not take line breaks/,
    );
    expect(paper.inputs()).toEqual([]);

    // <textarea> accepts newlines and normalizes CRLF to LF.
    paper.locate = () =>
      box({
        tag: "textarea",
        role: "textbox",
        kind: "text",
        name: 'Number 4, "Notes",',
        focused: true,
      });
    paper.page = {
      ...shop,
      elements: [
        element(4, "Notes", {
          tag: "textarea",
          role: "textbox",
          value: "First Second",
        }),
      ],
    };
    paper.sent.length = 0;
    await browser.type(4, "First\r\nSecond", false);
    expect(paper.of("Input.insertText")[0]!.params).toEqual({
      text: "First\nSecond",
    });

    // contenteditable region (kind: "region") also accepts newlines.
    paper.locate = () =>
      box({
        tag: "div",
        role: "textbox",
        kind: "region",
        name: 'Number 5, "Message",',
        focused: true,
      });
    paper.sent.length = 0;
    await browser.type(5, "Hello\nWorld", false);
    expect(paper.of("Input.insertText")[0]!.params).toEqual({
      text: "Hello\nWorld",
    });
  });

  it("extracts paginated visible text with bounded maxChars and refuses non-web pages", async () => {
    const { paper, browser } = setup();
    const big = "A".repeat(10_500);
    paper.extractReply = (offset, maxChars) => {
      const start = Math.min(offset, big.length);
      const chunk = big.slice(start, start + maxChars);
      return {
        ok: true,
        url: "https://shop.test/terms",
        title: "Terms",
        text: chunk,
        offset: start,
        totalChars: big.length,
        hasMore: start + chunk.length < big.length,
      };
    };

    // Default maxChars is 8000, offset 0.
    const first = await browser.extract!();
    expect(first).toEqual({
      url: "https://shop.test/terms",
      title: "Terms",
      text: "A".repeat(8000),
      offset: 0,
      totalChars: 10_500,
      hasMore: true,
    });
    expect(paper.calls().at(-1)).toMatchObject({
      do: "extract",
      offset: 0,
      maxChars: 8000,
    });

    // Paginate from offset 8000 -> remaining 2500 chars, hasMore false.
    const rest = await browser.extract!({ offset: 8000, maxChars: 8000 });
    expect(rest.offset).toBe(8000);
    expect(rest.text).toHaveLength(2500);
    expect(rest.hasMore).toBe(false);

    // maxChars above 16000 is clamped to 16000.
    await browser.extract!({ offset: 0, maxChars: 99_999 });
    expect(paper.calls().at(-1)).toMatchObject({
      do: "extract",
      offset: 0,
      maxChars: 16_000,
    });

    // Refuses browser internal pages.
    paper.extractReply = () => ({
      ok: true,
      url: "chrome://settings/",
      title: "Settings",
      text: "Settings",
      offset: 0,
      totalChars: 8,
      hasMore: false,
    });
    await expect(browser.extract!()).rejects.toThrow(/one of its own pages/);
  });

  it("scrolls an element into view inside its owning frame via scrollToElement()", async () => {
    const { paper, browser } = setup();
    paper.frameTree = {
      frameTree: {
        frame: { id: "F_MAIN", url: "https://shop.test/" },
        childFrames: [
          {
            frame: {
              id: "F_CHILD",
              parentId: "F_MAIN",
              url: "https://shop.test/embed",
            },
          },
        ],
      },
    };
    paper.worldByFrame.set("F_MAIN", 7);
    paper.worldByFrame.set("F_CHILD", 8);
    paper.frameOwners.set("F_CHILD", 77);
    paper.boxModels.set(77, [0, 500, 300, 500, 300, 700, 0, 700]);
    paper.pageByContext.set(8, {
      title: "Embed",
      url: "https://shop.test/embed",
      text: "Child frame",
      elements: [element(3, "Bottom CTA")],
    });
    await browser.read();

    // Main-frame element scroll_to.
    paper.sent.length = 0;
    await browser.scrollToElement!(1);
    expect(paper.calls().find((c) => c.do === "scroll_to")).toMatchObject({
      do: "scroll_to",
      index: 1,
    });

    // Child-frame element scroll_to runs in the child frame's isolated world.
    paper.sent.length = 0;
    await browser.scrollToElement!(3);
    const childScrollEval = paper
      .of("Runtime.evaluate")
      .find(
        (cmd) =>
          cmd.params.contextId === 8 &&
          String(cmd.params.expression).includes('"do":"scroll_to"'),
      );
    expect(childScrollEval).toBeTruthy();
  });

  it("tracks Browser.downloadWillBegin and Browser.downloadProgress with sanitized basenames only", async () => {
    const { paper, browser } = setup();
    const before = await browser.read();
    expect(before.downloads).toBeUndefined();
    expect(paper.of("Browser.setDownloadBehavior")).toEqual([
      expect.objectContaining({
        params: { behavior: "default", eventsEnabled: true },
      }),
    ]);

    // POSIX and Windows full paths are stripped to sanitized basenames.
    paper.emit("Browser.downloadWillBegin", {
      guid: "dl-1",
      suggestedFilename: "/Users/alice/Downloads/invoice-2026.pdf",
    });
    paper.emit("Browser.downloadWillBegin", {
      guid: "dl-2",
      suggestedFilename: "C:\\Users\\alice\\Desktop\\..\\report.csv",
    });
    const inFlight = await browser.read();
    expect(inFlight.downloads).toEqual([
      { filename: "invoice-2026.pdf", state: "in_progress" },
      { filename: "report.csv", state: "in_progress" },
    ]);
    expect(JSON.stringify(inFlight.downloads)).not.toContain("alice");

    // Progress updates map inProgress -> in_progress, completed, canceled.
    paper.emit("Browser.downloadProgress", {
      guid: "dl-1",
      state: "completed",
    });
    paper.emit("Browser.downloadProgress", {
      guid: "dl-2",
      state: "canceled",
    });
    const finished = await browser.read();
    expect(finished.downloads).toEqual([
      { filename: "invoice-2026.pdf", state: "completed" },
      { filename: "report.csv", state: "canceled" },
    ]);

    // Bounded list keeps at most 20 recent downloads.
    for (let i = 0; i < 25; i++) {
      paper.emit("Browser.downloadWillBegin", {
        guid: `bulk-${i}`,
        suggestedFilename: `file-${i}.txt`,
      });
    }
    const capped = await browser.read();
    expect(capped.downloads).toHaveLength(20);
    expect(capped.downloads![0]!.filename).toBe("file-5.txt");
    expect(capped.downloads!.at(-1)!.filename).toBe("file-24.txt");
  });

  it("enables Emulation.setFocusEmulationEnabled on attach only when backgroundFocus is true", async () => {
    // Default (omitted): never sends Emulation.setFocusEmulationEnabled.
    const plain = setup();
    await plain.browser.read();
    expect(plain.paper.of("Emulation.setFocusEmulationEnabled")).toEqual([]);

    // backgroundFocus: true enables focus emulation on main tab and OOPIFs.
    const bg = setup({ backgroundFocus: true });
    await bg.browser.read();
    expect(bg.paper.of("Emulation.setFocusEmulationEnabled")).toEqual([
      expect.objectContaining({
        params: { enabled: true },
        session: "S-T1",
      }),
    ]);
    bg.paper.emit("Target.attachedToTarget", {
      sessionId: "S-OOPIF-BG",
      targetInfo: {
        targetId: "F_OOPIF_BG",
        type: "iframe",
        url: "https://x.test/",
      },
    });
    await Promise.resolve();
    expect(bg.paper.of("Emulation.setFocusEmulationEnabled")).toContainEqual(
      expect.objectContaining({
        params: { enabled: true },
        session: "S-OOPIF-BG",
      }),
    );
  });
});
