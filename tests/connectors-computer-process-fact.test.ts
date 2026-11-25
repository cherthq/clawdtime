import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action, Observation } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import { frontAppFact } from "../connectors/system/fact.js";
import { SystemProbes } from "../connectors/system/probes.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";
import { fakeHost } from "./connectors-system-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const app = (name: string, bundleId: string) => ({ name, bundleId });
const fact = (name: string, bundleId: string, host = fakeHost()) =>
  frontAppFact(new SystemProbes(host), app(name, bundleId));

describe("the process fact of the app in front", () => {
  it("says an app is at full CPU while the screen does not change", async () => {
    expect(await fact("Stonepad", "com.example.stonepad")).toBe(
      "Process fact (data from this Mac): Stonepad (pid 4242) is at full CPU (98 percent) and is running while the screen does not change: it may be busy, or not responding.",
    );
  });

  it("says an app uses no CPU while the screen does not change", async () => {
    expect(await fact("Notes", "com.example.notes")).toBe(
      "Process fact (data from this Mac): Finder (pid 671) uses 0 percent CPU and is sleeping while the screen does not change: it may wait for something, or not respond.",
    );
  });

  it("says an app is stuck in a call to the system", async () => {
    expect(await fact("Ledgerly", "com.example.ledgerly")).toBe(
      "Process fact (data from this Mac): Ledgerly (pid 9100) uses 0 percent CPU and is waiting on the system while the screen does not change: it may not be responding.",
    );
  });

  it("says an app that runs no more crashed, with its newest crash report", async () => {
    expect(await fact("Riverchat", "com.example.riverchat")).toBe(
      "Process fact (data from this Mac): Riverchat does not run now: it may have crashed or quit. Riverchat crashed 2 min ago: EXC_BAD_ACCESS (SIGSEGV), KERN_INVALID_ADDRESS at 0x10.",
    );
  });

  it("runs nothing for a bundle id that does not parse, and stays quiet when a program fails", async () => {
    const host = fakeHost();
    expect(await fact("Stonepad", 'com.example"; kill', host)).toBeNull();
    expect(host.calls).toEqual([]);
    host.exec = async () => {
      throw new Error("no ps");
    };
    expect(await fact("Stonepad", "com.example.stonepad", host)).toBeNull();
  });
});

describe("the worker", () => {
  const two = observation(
    [element(1, { title: "Open" }), element(2, { title: "Back" })],
    {
      app: {
        name: "Stonepad",
        bundleId: "com.example.stonepad",
        window: "Notes",
      },
    },
  );
  const open: Action = { kind: "click_element", element: 1 };
  const back: Action = { kind: "click_element", element: 2 };
  const done: Action = { kind: "done", summary: "Opened." };

  function setup(
    script: Action[],
    processFact?: (app: {
      name: string;
      bundleId: string;
    }) => Promise<string | null>,
    screens: Observation[] = [two],
  ) {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-process-fact-"));
    roots.push(home);
    const planner = new ScriptedPlanner(script);
    const asked: { name: string; bundleId: string }[] = [];
    const worker = new ComputerWorker({
      hands: new FakeHands(screens),
      planner,
      journal: new ComputerJournal(home, () => 1_000_000),
      now: () => 1_000_000,
      settleMs: 1,
      transientMs: 1,
      ...(processFact
        ? {
            processFact: async (front: { name: string; bundleId: string }) => {
              asked.push(front);
              return processFact(front);
            },
          }
        : {}),
    });
    return { worker, planner, asked };
  }
  const lastOutcome = (input: { history: { outcome: string }[] }) =>
    input.history.at(-1)!.outcome;
  const still = [
    open,
    { kind: "key", combo: "tab" } as Action,
    back,
    { kind: "key", combo: "down" } as Action,
    done,
  ];

  it("adds the process fact to its note when inputs change nothing on the screen, with no model call", async () => {
    const line =
      "Process fact (data from this Mac): Stonepad (pid 4242) is at full CPU (98 percent) and is running while the screen does not change: it may be busy, or not responding.";
    const { worker, planner, asked } = setup(still, async () => line);
    await worker.submit("r1", "Open the note");
    await worker.idle();
    expect(asked).toEqual([
      { name: "Stonepad", bundleId: "com.example.stonepad" },
    ]);
    expect(lastOutcome(planner.inputs[4]!)).toMatch(
      /^ok Your last 4 actions did not change the screen\. Do not repeat them\. Try another way: .+\. Process fact \(data from this Mac\): Stonepad \(pid 4242\) is at full CPU/,
    );
    // The planner was asked once for each action, and no more.
    expect(planner.inputs).toHaveLength(5);
  });

  it("asks for no fact while the screen moves, or when it goes back and forth", async () => {
    const { worker, asked } = setup(
      [open, back, open, back, done],
      async () => "a fact",
    );
    await worker.submit("r1", "Find the setting");
    await worker.idle();
    expect(asked).toEqual([]);
  });

  it("keeps its note as it was when the fact fails", async () => {
    const { worker, planner } = setup(still, async () => {
      throw new Error("ps is gone");
    });
    await worker.submit("r1", "Open the note");
    await worker.idle();
    expect(lastOutcome(planner.inputs[4]!)).toMatch(
      /^ok Your last 4 actions did not change the screen\. Do not repeat them\. Try another way: [^.]+\.$/,
    );
  });
});
