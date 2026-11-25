import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type {
  Action,
  BrowserPage,
  BrowserTab,
  Observation,
} from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeBrowser,
  FakeHands,
  observation,
  page,
  pageElement,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

/**
 * The newer actions through the real worker: the checks, the question, the
 * look just before the input and the call to the hands or to the browser.
 * The hands and the browser only keep a list. Nothing here touches a real
 * mouse, keyboard, screen or browser.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

/** A browser on paper that has every optional method. */
class RichBrowser extends FakeBrowser {
  /** The lists of the tabs that the next calls of tabs give, in order; the last one repeats. */
  lists: BrowserTab[][] = [];
  found = true;
  /** A call that never answers, by its name. */
  silent = "";
  private answer(name: string, page: BrowserPage) {
    return name === this.silent
      ? new Promise<BrowserPage>(() => {})
      : Promise.resolve(page);
  }
  async hover(index: number) {
    this.calls.push(`hover ${index}`);
    return this.answer("hover", this.current);
  }
  async select(index: number, option: string) {
    this.calls.push(`select ${index} ${option}`);
    return this.answer("select", this.current);
  }
  async key(combo: string) {
    this.calls.push(`key ${combo}`);
    return this.answer("key", this.current);
  }
  async waitFor(text: string | null, ms: number) {
    this.calls.push(`wait ${text} ${ms}`);
    return this.answer("waitFor", { ...this.current, found: this.found });
  }
  async tabs() {
    this.calls.push("tabs");
    const tabs =
      this.lists.length > 1 ? this.lists.shift()! : (this.lists[0] ?? []);
    return this.answer("tabs", { ...this.current, tabs });
  }
  async switchTab(tab: number) {
    this.calls.push(`switch ${tab}`);
    return this.answer("switchTab", this.current);
  }
}

function setup(
  script: ConstructorParameters<typeof ScriptedPlanner>[0],
  options: {
    screens?: Observation[];
    browser?: FakeBrowser;
    browserMs?: number;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-actions-"));
  roots.push(home);
  const hands = new FakeHands(options.screens ?? [observation()]);
  const planner = new ScriptedPlanner(script);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal: new ComputerJournal(home, () => 1_000_000),
    now: () => 1_000_000,
    notify: () => {},
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.browserMs ? { browserMs: options.browserMs } : {}),
  });
  const waiting = async () => {
    for (let tries = 0; tries < 1000; tries++) {
      if (worker.snapshot().state === "waiting_for_person") return;
      await new Promise((done) => setTimeout(done, 2));
    }
    throw new Error("The worker did not ask.");
  };
  return { hands, planner, worker, waiting };
}
const done: Action = { kind: "done", summary: "Done." };
const outcomes = (planner: ScriptedPlanner) =>
  planner.inputs.at(-1)!.history.map((step) => step.outcome);

describe("a hover and a drag through the worker", () => {
  const board = observation([
    element(1, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
    element(2, { title: "Done", x: 600, y: 100, w: 200, h: 300 }),
  ]);
  const drag: Action = {
    kind: "drag",
    from: { element: 1 },
    to: { element: 2 },
  };
  it("moves the pointer for a hover, with its label, after the last look, and asks nothing", async () => {
    const { worker, hands } = setup([{ kind: "hover", element: 1 }, done], {
      screens: [board],
    });
    await worker.submit("r1", "Open the menu of the card");
    await worker.idle();
    expect(hands.commands.map((command) => command.kind)).toEqual([
      "observe",
      "observe",
      "move",
      "observe",
    ]);
    expect(hands.sent).toEqual([{ kind: "move", x: 150, y: 120 }]);
    expect(hands.labels[2]).toBe('Hover over "Card"');
    expect(worker.snapshot().state).toBe("completed");
  });
  it("sends a drag from one end to the other", async () => {
    const { worker, hands } = setup([drag, done], { screens: [board] });
    await worker.submit("r1", "Move the card to done");
    await worker.idle();
    expect(hands.sent).toEqual([
      { kind: "drag", fromX: 150, fromY: 120, toX: 700, toY: 250 },
    ]);
    expect(hands.labels[2]).toBe('Drag "Card" to "Done"');
  });
  it("asks before a drag onto Trash: no sends nothing, yes sends it", async () => {
    const desk = observation([
      element(1, { title: "Report.pdf", x: 100, y: 100, w: 100, h: 40 }),
      element(2, { role: "AXDockItem", title: "Trash", x: 1300, y: 860 }),
    ]);
    for (const [answer, sent] of [
      ["no", 0],
      ["yes", 1],
    ] as const) {
      const { worker, hands, waiting } = setup([drag, done], {
        screens: [desk],
      });
      await worker.submit("r1", "Tidy the desktop");
      await waiting();
      expect(worker.snapshot().message).toBe(
        'Drag "Report.pdf" to "Trash" in Notes? It moves what it drags to the Trash. Say yes or no.',
      );
      expect(hands.sent).toEqual([]);
      await worker.answer(answer);
      await worker.idle();
      expect(hands.sent).toHaveLength(sent);
    }
  });
  it("sends no drag when an end is gone at the last look, and tells the planner", async () => {
    const moved = observation([
      element(1, { title: "Card", x: 100, y: 100, w: 100, h: 40 }),
    ]);
    const { worker, hands, planner } = setup([drag, done], {
      screens: [board, moved],
    });
    await worker.submit("r1", "Move the card to done");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(outcomes(planner)[0]).toMatch(
      /^not sent: The screen changed: the target is no longer there/,
    );
  });
  it("sends no hover when its element is gone at the last look", async () => {
    const { worker, hands, planner } = setup(
      [{ kind: "hover", element: 1 }, done],
      { screens: [board, observation([element(1, { title: "Other" })])] },
    );
    await worker.submit("r1", "Open the menu of the card");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(outcomes(planner)[0]).toMatch(/^not sent: The screen changed/);
  });
  it("scrolls by the amount that the planner gave", async () => {
    const { worker, hands } = setup(
      [{ kind: "scroll", direction: "down", amount: 3 }, done],
      { screens: [board] },
    );
    await worker.submit("r1", "Scroll a little");
    await worker.idle();
    expect(hands.sent).toEqual([
      { kind: "scroll", x: 720, y: 450, dx: 0, dy: 3 },
    ]);
  });
});

describe("the newer browser actions through the worker", () => {
  const shop = page([
    pageElement(1, { label: "Menu" }),
    pageElement(2, { label: "Size", tag: "select", role: "combobox" }),
    pageElement(3, { label: "Pay now" }),
  ]);
  const read: Action = { kind: "browser_read" };
  it("chooses an option after a new reading finds the same list", async () => {
    const browser = new RichBrowser(shop);
    const { worker } = setup(
      [read, { kind: "browser_select", index: 2, option: "Large" }, done],
      { browser },
    );
    await worker.submit("r1", "Pick the large size");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read", "select 2 Large"]);
    expect(worker.snapshot().state).toBe("completed");
  });
  it("hovers an element of the page with no question", async () => {
    const browser = new RichBrowser(shop);
    const { worker } = setup(
      [read, { kind: "browser_hover", index: 3 }, done],
      { browser },
    );
    await worker.submit("r1", "Show the menu");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read", "hover 3"]);
  });
  it("asks before Enter while the page has a control that a click asks about", async () => {
    const browser = new RichBrowser(shop);
    const { worker, waiting } = setup(
      [read, { kind: "browser_key", combo: "enter" }, done],
      { browser },
    );
    await worker.submit("r1", "Finish the form");
    await waiting();
    expect(worker.snapshot().message).toBe(
      'Press Enter on example.com? It can press "Pay now". It spends your money. Say yes or no.',
    );
    await worker.answer("no");
    await worker.idle();
    expect(browser.calls).toEqual(["read"]);
  });
  it("sends no key when the page changed its risk since it was read", async () => {
    const browser = new RichBrowser(page([pageElement(1, { label: "Next" })]));
    const { worker, planner } = setup(
      [
        read,
        () => {
          // The page gets a Pay button between the reading and the key.
          browser.current = shop;
          return { kind: "browser_key", combo: "Enter" };
        },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Go on");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read"]);
    expect(outcomes(planner)[1]).toBe(
      "not sent: the page changed since it was read",
    );
  });
  it("waits on the page, and tells the planner when the words did not show", async () => {
    const browser = new RichBrowser(shop);
    browser.found = false;
    const { worker, planner } = setup(
      [{ kind: "browser_wait", ms: 500, text: "Order placed" }, done],
      { browser },
    );
    await worker.submit("r1", "Wait for the order");
    await worker.idle();
    expect(browser.calls).toEqual(["wait Order placed 500"]);
    expect(outcomes(planner)).toEqual([
      "the words did not show on the page in that time",
    ]);
    expect(planner.inputs.at(-1)!.page?.found).toBe(false);
  });
  it("lists the tabs, then switches to the tab that a new list finds again", async () => {
    const browser = new RichBrowser(shop);
    const inbox = {
      index: 2,
      title: "Inbox",
      url: "https://mail.example/",
      active: false,
    };
    const shopTab = {
      index: 1,
      title: "Example",
      url: "https://example.com/",
      active: true,
    };
    browser.lists = [
      [shopTab, inbox],
      // A tab opened in front of the others: the inbox is the third tab now.
      [{ ...shopTab, index: 2 }, { ...inbox, index: 3 }, { ...shopTab }],
    ];
    const { worker, planner } = setup(
      [{ kind: "browser_tabs" }, { kind: "browser_switch_tab", tab: 2 }, done],
      { browser },
    );
    await worker.submit("r1", "Go to my inbox tab");
    await worker.idle();
    expect(browser.calls).toEqual(["tabs", "tabs", "switch 3"]);
    expect(planner.inputs[1]!.page?.tabs).toEqual([shopTab, inbox]);
    expect(worker.snapshot().state).toBe("completed");
  });
  it("sends no switch when the tab is gone from the new list", async () => {
    const browser = new RichBrowser(shop);
    const inbox = {
      index: 2,
      title: "Inbox",
      url: "https://mail.example/",
      active: false,
    };
    browser.lists = [[inbox], []];
    const { worker, planner } = setup(
      [{ kind: "browser_tabs" }, { kind: "browser_switch_tab", tab: 2 }, done],
      { browser },
    );
    await worker.submit("r1", "Go to my inbox tab");
    await worker.idle();
    expect(browser.calls).toEqual(["tabs", "tabs"]);
    expect(outcomes(planner)[1]).toBe(
      "not sent: the page changed since it was read",
    );
  });
  it("refuses a newer browser action that the connected driver cannot do", async () => {
    const browser = new FakeBrowser(shop);
    const { worker, planner } = setup(
      [read, { kind: "browser_select", index: 2, option: "Large" }, done],
      { browser },
    );
    await worker.submit("r1", "Pick the large size");
    await worker.idle();
    expect(browser.calls).toEqual(["read"]);
    expect(outcomes(planner)[1]).toMatch(
      /^refused: The browser that is connected cannot do that/,
    );
  });
  it("ends as uncertain when a key gets no answer, but goes on after a wait with no answer", async () => {
    const keyed = new RichBrowser(page([pageElement(1, { label: "Next" })]));
    keyed.silent = "key";
    const first = setup([read, { kind: "browser_key", combo: "Tab" }, done], {
      browser: keyed,
      browserMs: 20,
    });
    await first.worker.submit("r1", "Next field");
    await first.worker.idle();
    expect(first.worker.snapshot().state).toBe("uncertain");
    const waited = new RichBrowser(shop);
    waited.silent = "waitFor";
    const second = setup([{ kind: "browser_wait", ms: 200 }, done], {
      browser: waited,
      browserMs: 20,
    });
    await second.worker.submit("r1", "Wait for the page");
    await second.worker.idle();
    expect(second.worker.snapshot().state).toBe("completed");
    expect(outcomes(second.planner)[0]).toMatch(/^did not run/);
  });
});
