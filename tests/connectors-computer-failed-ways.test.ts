import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aimOf,
  failedReason,
  failedWaysLimit,
  keepFailed,
} from "../connectors/computer/failed-ways.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { brief } from "../connectors/computer/planner.js";
import type { Action, StepRecord } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

const seen = observation([
  element(1, { title: "Export", enabled: false }),
  element(2, { title: "Search", role: "AXTextField" }),
  element(3, { title: "Code 482913", role: "AXStaticText" }),
]);

describe("the element of a step", () => {
  it("keeps the name that the journal keeps, with the role of the element of the look", () => {
    expect(
      aimOf({ kind: "click_element", element: 1 }, "Export", seen),
    ).toEqual({ target: "Export", role: "AXButton" });
    expect(
      aimOf({ kind: "type", text: "milk", element: 2 }, "Search", seen),
    ).toEqual({ target: "Search", role: "AXTextField" });
  });

  it("names the element of the look when the checks refused the action before they named it", () => {
    expect(aimOf({ kind: "click_element", element: 1 }, "", seen)).toEqual({
      target: "Export",
      role: "AXButton",
    });
    // An element that is not in the look names nothing.
    expect(aimOf({ kind: "click_element", element: 40 }, "", seen)).toEqual({});
  });

  it("gives no role when the look does not hold the element of that name", () => {
    expect(aimOf({ kind: "click_at", x: 10, y: 20 }, "Layers", seen)).toEqual({
      target: "Layers",
    });
    expect(
      aimOf({ kind: "click_element", element: 2 }, "Export", seen),
    ).toEqual({ target: "Export" });
    expect(aimOf({ kind: "key", combo: "cmd+s" }, "cmd+s", null)).toEqual({
      target: "cmd+s",
    });
  });

  it("never holds typed text, and leaves out a name that looks like a secret", () => {
    const typed = aimOf(
      { kind: "type", text: "hunter22 is my password", element: 2 },
      "Search",
      seen,
    );
    expect(JSON.stringify(typed)).not.toContain("hunter22");
    expect(aimOf({ kind: "type", text: "x" }, "", seen)).toEqual({});
    expect(aimOf({ kind: "click_element", element: 3 }, "", seen)).toEqual({});
    expect(
      aimOf({ kind: "click_at", x: 1, y: 1 }, "password: hunter22", seen),
    ).toEqual({});
  });

  it("cuts the name to 60 characters on one line", () => {
    const aim = aimOf(
      { kind: "click_at", x: 1, y: 1 },
      `Line one\nLine two ${"y".repeat(200)}`,
      null,
    );
    expect(aim.target).toBe(`Line one Line two ${"y".repeat(42)}`);
  });
});

describe("the reason of a way that did not work", () => {
  it("reads it from the fixed words at the start of the step line", () => {
    expect(failedReason("refused: Element 4 is disabled.")).toBe(
      "refused, nothing was sent",
    );
    expect(
      failedReason("not sent: The screen changed since the planner looked."),
    ).toBe("held back, nothing was sent");
    expect(failedReason("did not run: not_found")).toBe(
      "the Mac did not run it",
    );
    expect(
      failedReason(
        "sent, but the screen looks the same after it, so it may not have worked. Look again.",
      ),
    ).toBe("sent, but the screen did not change");
    expect(
      failedReason(
        "ok, the address went to the browser, but the page did not load.",
      ),
    ).toBe("the page did not load");
    expect(
      failedReason(
        "This action did not work 3 times in a row: it was not sent, or the screen did not change after it. Choose another way. Last outcome: refused: Element 4 is disabled.",
      ),
    ).toBe("refused, nothing was sent");
  });

  it("is none for a step that worked, or that the person held back", () => {
    for (const outcome of [
      "ok",
      "ok: the closer picture comes with this turn",
      "ok, the address went to the browser. The screen below shows whether the page came.",
      "the person answered: use the menu",
      "gave up",
      "not sent: The person said more before it went out.",
      "not sent: The person asked to hold before it went out.",
      "not sent: The person took over.",
    ])
      expect(failedReason(outcome)).toBeNull();
  });
});

describe("the list of ways that did not work", () => {
  const record = (
    step: number,
    values: Partial<StepRecord> = {},
  ): StepRecord => ({
    step,
    action: { kind: "click_element", element: 4 },
    why: "x",
    outcome: "refused: Element 4 is disabled.",
    target: "Export",
    role: "AXButton",
    ...values,
  });

  it("keeps one row for each way, with its count and its newest try last", () => {
    const rows = keepFailed(
      [],
      [
        record(1),
        record(2, {
          action: { kind: "key", combo: "cmd+e" },
          target: "cmd+e",
          role: undefined,
          outcome: "sent, but the screen looks the same after it.",
        }),
        record(5, { outcome: "not sent: The target is gone." }),
        record(6, { outcome: "ok" }),
      ],
    );
    expect(rows).toEqual([
      {
        kind: "key",
        name: "cmd+e",
        reason: "sent, but the screen did not change",
        count: 1,
        step: 2,
      },
      {
        kind: "click_element",
        role: "AXButton",
        name: "Export",
        reason: "held back, nothing was sent",
        count: 2,
        step: 5,
      },
    ]);
    // The list grows from what it holds.
    expect(keepFailed(rows, [record(9)]).at(-1)).toMatchObject({
      name: "Export",
      count: 3,
      step: 9,
    });
  });

  it("keeps the newest 12 ways", () => {
    const rows = keepFailed(
      [],
      Array.from({ length: 14 }, (_, index) =>
        record(index + 1, { target: `Button ${index + 1}` }),
      ),
    );
    expect(failedWaysLimit).toBe(12);
    expect(rows).toHaveLength(12);
    expect(rows[0]!.name).toBe("Button 3");
    expect(rows.at(-1)!.name).toBe("Button 14");
  });

  it("holds no typed text, no step with no name and no name that looks like a secret", () => {
    const rows = keepFailed(
      [],
      [
        record(1, {
          action: { kind: "type", text: "hunter22 is the code", element: 2 },
          target: "Search",
          role: "AXTextField",
        }),
        record(2, { target: undefined, role: undefined }),
        record(3, { target: "password: hunter22", role: undefined }),
      ],
    );
    expect(rows).toEqual([
      {
        kind: "type",
        role: "AXTextField",
        name: "Search",
        reason: "refused, nothing was sent",
        count: 1,
        step: 1,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("hunter22");
  });
});

describe("the ways that did not work, in the worker", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  });
  const screen = observation([
    element(1, { title: "Export", enabled: false }),
    element(2, { title: "Search", role: "AXTextField" }),
  ]);
  const exportClick: Action = { kind: "click_element", element: 1 };
  const twoLines: Action = {
    kind: "type",
    text: "first line\nhunter22",
    element: 2,
  };
  const waits: Action[] = Array.from({ length: 13 }, (_, index) => ({
    kind: "wait",
    ms: index + 1,
  }));
  const done: Action = { kind: "done", summary: "Exported." };

  function setup(
    script: ConstructorParameters<typeof ScriptedPlanner>[0],
    failedWays = true,
  ) {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-failed-ways-"));
    roots.push(home);
    const clock = { now: 1_000_000 };
    const hands = new FakeHands([screen]);
    const planner = new ScriptedPlanner(script);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(home, () => clock.now),
      now: () => clock.now,
      ...(failedWays ? { failedWays } : {}),
    });
    return { worker, planner, hands };
  }

  it("keeps a way that did not work for the whole request, and the planner reads it once it is out of view", async () => {
    const { worker, planner } = setup([exportClick, twoLines, ...waits, done]);
    await worker.submit("long", "Export the report");
    await worker.idle();
    const exportRow = {
      kind: "click_element",
      role: "AXButton",
      name: "Export",
      reason: "refused, nothing was sent",
      count: 1,
      step: 1,
    };
    const typeRow = {
      kind: "type",
      role: "AXTextField",
      name: "Search",
      reason: "refused, nothing was sent",
      count: 1,
      step: 2,
    };
    expect(planner.inputs[0]).not.toHaveProperty("failed");
    expect(planner.inputs[1]!.failed).toEqual([exportRow]);
    expect(planner.inputs[2]!.failed).toEqual([exportRow, typeRow]);
    const last = planner.inputs.at(-1)!;
    expect(last.failed).toEqual([exportRow, typeRow]);
    expect(
      JSON.stringify(planner.inputs.map((input) => input.failed)),
    ).not.toContain("hunter22");
    // While both steps are in view, the brief says nothing more.
    expect(brief(planner.inputs[2]!, false)).not.toContain(
      "Ways that did not work",
    );
    // Out of view, the planner reads both.
    expect(last.history[0]!.step).toBeGreaterThan(2);
    const text = brief(last, false);
    expect(text).toContain(
      "Ways that did not work earlier in this request, before your last steps.",
    );
    expect(text).toContain(
      '- click_element AXButton "Export": refused, nothing was sent',
    );
    expect(text).toContain(
      '- type AXTextField "Search": refused, nothing was sent',
    );
    expect(text).not.toContain("hunter22\n");
  });

  it("starts again after the person's new words", async () => {
    let said = false;
    const { worker, planner } = setup([
      exportClick,
      async () => {
        if (!said) {
          said = true;
          await worker.submit("more", "Use the menu instead");
        }
        return { kind: "wait", ms: 1 };
      },
      { kind: "wait", ms: 2 },
      done,
    ]);
    await worker.submit("words", "Export the report");
    await worker.idle();
    const heard = planner.inputs.filter((input) => input.guidance?.length);
    expect(heard.length).toBeGreaterThan(0);
    for (const input of heard) expect(input).not.toHaveProperty("failed");
  });

  it("is off unless the worker is asked to keep it", async () => {
    const { worker, planner } = setup([exportClick, ...waits, done], false);
    await worker.submit("off", "Export the report");
    await worker.idle();
    for (const input of planner.inputs)
      expect(input).not.toHaveProperty("failed");
  });
});
