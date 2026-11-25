import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserClock } from "../connectors/computer/browser.js";
import type {
  DevToolsDial,
  DevToolsPipeHandlers,
} from "../connectors/computer/devtools.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  OwnBrowser,
  type BrowserLauncher,
} from "../connectors/computer/own-browser.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

/**
 * Review 1: ClawdTime's own browser. No test here starts a program or opens
 * a connection: the browser is on paper, as in
 * tests/connectors-computer-own-browser.test.ts, whose paper browser this
 * file copies.
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
  const root = mkdtempSync(join(tmpdir(), "clawdtime-review-1-own-"));
  roots.push(root);
  return root;
}
function fakeClock(): BrowserClock {
  let time = 1_000_000;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

interface Sent {
  method: string;
  params: Record<string, unknown>;
  session?: string;
}
type PageCallSeen = { do: string; index?: number } & Record<string, unknown>;

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
const form = {
  title: "Sign in",
  url: "https://bank.test/",
  text: "Sign in to your bank.",
  elements: [
    element(1, "Next"),
    element(2, "Password", { tag: "input", role: "textbox", password: true }),
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
  name: 'Number 1, "Next",',
  disabled: false,
  readOnly: false,
  password: false,
  focused: false,
  ...values,
});

class PaperBrowser {
  readonly sent: Sent[] = [];
  readonly launches: { program: string; args: string[] }[] = [];
  readonly running = new Set<number>();
  pid = 4000;
  port = 45_000;
  targets = [
    { targetId: "T1", type: "page", title: "", url: "https://bank.test/" },
  ];
  page: Record<string, unknown> = { ...form };
  locate: (index: number) => Record<string, unknown> = () => box();
  /** What the page answers for a call other than read and locate. */
  other: (call: PageCallSeen) => Record<string, unknown> = () => ({
    ok: true,
  });
  dieOn: (sent: Sent) => boolean = () => false;
  private readonly connections = new Set<DevToolsPipeHandlers>();

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
    const lock = join(this.profile, "SingletonLock");
    try {
      unlinkSync(lock);
    } catch {
      // None yet.
    }
    symlinkSync(`${host}-${pid}`, lock);
    this.running.add(pid);
    return {
      pid,
      exited: () => !this.running.has(pid),
      kill: () => this.running.delete(pid),
    };
  };

  readonly dial: DevToolsDial = async (_url, handlers) => {
    this.connections.add(handlers);
    return {
      send: (text) => this.receive(JSON.parse(text), handlers),
      close: () => this.end(handlers),
    };
  };

  die() {
    this.running.delete(this.pid);
    for (const handlers of [...this.connections]) this.end(handlers);
  }
  of(method: string) {
    return this.sent.filter((item) => item.method === method);
  }
  inputs() {
    return this.sent.filter((item) => item.method.startsWith("Input."));
  }
  presses() {
    return this.of("Input.dispatchMouseEvent").filter(
      (item) => item.params.type === "mousePressed",
    );
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
    const result = this.answer(sent);
    queueMicrotask(() => {
      if (this.connections.has(handlers))
        handlers.message(JSON.stringify({ id: message.id, result }));
    });
  }
  private answer({ method, params }: Sent): unknown {
    switch (method) {
      case "SystemInfo.getProcessInfo":
        return {
          processInfo: [
            { type: "browser", id: this.pid, cpuTime: 1 },
            { type: "renderer", id: 9, cpuTime: 1 },
          ],
        };
      case "Target.getTargets":
        return {
          targetInfos: this.targets.map((target) => ({
            ...target,
            attached: false,
          })),
        };
      case "Target.attachToTarget":
        return { sessionId: `S-${String(params.targetId)}` };
      case "Runtime.evaluate": {
        const expression = String(params.expression);
        const call = JSON.parse(
          expression.slice(expression.lastIndexOf("})(") + 3, -1),
        ) as PageCallSeen;
        const value =
          call.do === "read"
            ? { ok: true, ready: true, next: 3, page: this.page }
            : call.do === "locate"
              ? this.locate(call.index!)
              : this.other(call);
        return { result: { type: "string", value: JSON.stringify(value) } };
      }
      // A browser of the family names the private world of the page script.
      case "Page.createIsolatedWorld":
        return { executionContextId: 7 };
      default:
        return {};
    }
  }
}

function setup() {
  const root = folder();
  const profile = join(root, "computer", "browser-profile");
  const paper = new PaperBrowser(profile);
  const browser = new OwnBrowser({
    env: { CLAWDTIME_CONFIG_HOME: root },
    home: join(root, "home"),
    launch: paper.launch,
    dial: paper.dial,
    clock: fakeClock(),
    alive: (pid) => paper.running.has(pid),
    host,
    runnable: (path) => path === program,
  });
  return { root, paper, browser };
}

describe("review 1: the own browser and a password field", () => {
  it("never presses a key while a password field has the focus", async () => {
    const { paper, browser } = setup();
    await browser.read();
    // The person typed their password; the focus stays in that field. The
    // page script of the other driver refuses a key there. Asked anything,
    // this page says where its focus is.
    const refusal =
      "The focus is in a password field. The worker never presses a key there: ask the person.";
    paper.other = () => ({ ok: false, error: refusal });
    paper.locate = () =>
      box({
        kind: "text",
        tag: "input",
        role: "textbox",
        password: true,
        focused: true,
        name: 'Number 2, "Password",',
      });
    // Space writes a space into the field; Backspace takes a character of
    // the password away; Enter sends the form with it.
    for (const combo of ["Space", "Backspace", "Enter"])
      await expect(browser.key!(combo)).rejects.toThrow(/password field/);
    expect(paper.inputs()).toEqual([]);
  });
});

describe("review 1: an input of the own browser whose result is not known", () => {
  it("makes the request uncertain and never sends the same click again", async () => {
    const { paper, browser } = setup();
    const home = folder();
    // The connection ends while the button goes down: the click may have
    // happened. The planner reads the page again and clicks again.
    paper.dieOn = (sent) =>
      sent.method === "Input.dispatchMouseEvent" &&
      sent.params.type === "mousePressed" &&
      paper.presses().length === 1;
    const planner = new ScriptedPlanner([
      { kind: "browser_read" },
      { kind: "browser_click", index: 1 },
      { kind: "browser_read" },
      { kind: "browser_click", index: 1 },
      { kind: "done", summary: "Next is pressed." },
    ]);
    const worker = new ComputerWorker({
      hands: new FakeHands([observation()]),
      planner,
      journal: new ComputerJournal(home, () => 1_000_000),
      now: () => 1_000_000,
      notify: () => {},
      browser,
    });
    await worker.submit("r1", "Press Next on the bank page");
    await worker.idle();
    expect(paper.presses()).toHaveLength(1);
    expect(worker.snapshot().state).toBe("uncertain");
  });
});
