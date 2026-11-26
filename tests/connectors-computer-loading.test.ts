import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action, Observation } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

/**
 * An app that open_app brought forward can take seconds to show what it
 * holds, as a news app or the page of a store does. Before the planner gives
 * up on such a screen, the worker waits with no input until it settles.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const settleLabel = "Wait for the screen to settle";
const app = {
  name: "Newsstand",
  bundleId: "com.example.newsstand",
  window: "Today",
};
const desktop = observation([], {
  surfaceEpoch: 1,
  app: { name: "Finder", bundleId: "com.apple.finder", window: "" },
});
const loading = observation([element(1, { title: "Loading" })], {
  surfaceEpoch: 2,
  app,
});
const loaded = observation(
  [
    element(1, { title: "Top story: The harbor bridge opens" }),
    element(2, { title: "Weather" }),
  ],
  { surfaceEpoch: 2, app },
);
const open: Action = { kind: "open_app", name: "Newsstand" };
const headline = (input: { observation: Observation | null }): Action =>
  input.observation?.elements.some((item) => item.title?.includes("harbor"))
    ? { kind: "done", summary: "The top headline: The harbor bridge opens." }
    : { kind: "give_up", reason: "No headline shows." };
const loadedNote =
  "not ended: The app came forward just before and its screen was still changing, so the worker waited with no input until it was still. Choose again from the new look: what was missing may show now.";

type Script = ConstructorParameters<typeof ScriptedPlanner>[0];
/**
 * Before open_app the screen shows the desktop. After it, the screen shows
 * `loading` for `loadingLooks` looks, then `loaded`. A look before an input
 * in the app counts too.
 */
function setup(
  script: Script,
  options: { loadingLooks?: number; settleLimit?: number } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-loading-"));
  roots.push(home);
  const hands = new FakeHands([desktop]);
  let opened = false;
  let looks = 0;
  hands.answer = (command) => {
    if (command.kind === "open_app") {
      opened = true;
      return { observation: loading, resolvedBundleId: app.bundleId };
    }
    if (command.kind !== "observe" || !opened) return undefined;
    looks++;
    const screen = looks <= (options.loadingLooks ?? 2) ? loading : loaded;
    const { image, imageWidth, imageHeight, ...bare } = screen;
    return {
      observation: command.image
        ? screen
        : { ...bare, elements: command.elements ? bare.elements : [] },
    };
  };
  const planner = new ScriptedPlanner(script);
  const clock = { now: 1_000_000 };
  const journal = new ComputerJournal(home, () => clock.now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: () => {},
    settleMs: 1,
    transientMs: 1,
    ...(options.settleLimit !== undefined
      ? { settleLimit: options.settleLimit }
      : {}),
  });
  const settleLooks = () =>
    hands.labels.filter((label) => label === settleLabel).length;
  return { hands, planner, journal, worker, settleLooks };
}

describe("an app whose content loads slowly", () => {
  it("waits on after the planner's wait until the screen settles, so the next look shows what loaded", async () => {
    const { hands, planner, journal, worker, settleLooks } = setup(
      [open, { kind: "wait", ms: 500 }, headline],
      { loadingLooks: 2 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    // Looks and waits only: nothing but the one open request went out.
    expect(hands.sent).toEqual([open]);
    // The looks of the wait: loading, loaded, loaded. Two in a row agree.
    expect(settleLooks()).toBe(3);
    expect(planner.inputs[2]!.history[1]).toMatchObject({
      action: { kind: "wait" },
      outcome:
        "ok. Then the worker waited with no input until the screen was still: the next look shows what the app loaded.",
    });
    expect(planner.inputs[2]!.observation?.elements[0]?.title).toBe(
      "Top story: The harbor bridge opens",
    );
    expect(journal.get("r1")!.steps.map((step) => step.outcome)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("waits before a give_up right after the app came forward, and the planner chooses again from the new look", async () => {
    const { hands, planner, journal, worker, settleLooks } = setup(
      [open, { kind: "give_up", reason: "No headline shows." }, headline],
      { loadingLooks: 2 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(hands.sent).toEqual([open]);
    expect(settleLooks()).toBe(3);
    expect(planner.inputs[2]!.history[1]).toMatchObject({
      action: { kind: "give_up" },
      outcome: loadedNote,
    });
    expect(journal.get("r1")!.steps.map((step) => step.outcome)).toEqual([
      "ok",
      "waited",
      "ok",
    ]);
  });

  it("waits once for one opening: a later give_up is read as before", async () => {
    const { planner, worker, settleLooks } = setup(
      [
        open,
        { kind: "give_up", reason: "No headline shows." },
        { kind: "give_up", reason: "No headline shows." },
        { kind: "give_up", reason: "No headline shows." },
      ],
      { loadingLooks: 2 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    expect(settleLooks()).toBe(3);
    // The second give_up gets the usual note with the other ways, the third ends.
    expect(planner.inputs).toHaveLength(4);
    expect(planner.inputs[3]!.history[2]!.outcome).toMatch(
      /^not ended: Do not give up yet\./,
    );
    expect(worker.snapshot()).toMatchObject({ state: "blocked" });
  });

  it("lets the give_up stand when the screen was already still", async () => {
    const { planner, worker, settleLooks } = setup(
      [
        open,
        { kind: "give_up", reason: "The app shows no headlines." },
        { kind: "give_up", reason: "The app shows no headlines." },
      ],
      { loadingLooks: 0 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    // Two looks in a row agreed with the look of the give_up: nothing loaded.
    expect(settleLooks()).toBe(2);
    expect(planner.inputs).toHaveLength(3);
    expect(planner.inputs[2]!.history[1]!.outcome).toMatch(
      /^not ended: Do not give up yet\./,
    );
    expect(worker.snapshot()).toMatchObject({ state: "blocked" });
  });

  it("ends a give_up that only the person can change at once, with no wait", async () => {
    const reason = "The app needs you to sign in to your account.";
    const { planner, worker, settleLooks } = setup(
      [open, { kind: "give_up", reason }],
      { loadingLooks: 9 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    expect(settleLooks()).toBe(0);
    expect(planner.inputs).toHaveLength(2);
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: `I could not finish. ${reason} Tell me another way to try, or do this step yourself.`,
    });
  });

  it("does not wait after an input went out in the app", async () => {
    const click: Action = { kind: "click_element", element: 2 };
    const { hands, worker, settleLooks } = setup(
      [
        open,
        click,
        { kind: "give_up", reason: "No headline shows." },
        { kind: "give_up", reason: "No headline shows." },
      ],
      { loadingLooks: 0 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "open_app",
      "click",
    ]);
    expect(settleLooks()).toBe(0);
    expect(worker.snapshot()).toMatchObject({ state: "blocked" });
  });

  it("counts the wait among the waits for the screen to settle of one request", async () => {
    const { worker, settleLooks } = setup(
      [open, { kind: "give_up", reason: "No headline shows." }],
      { loadingLooks: 2, settleLimit: 0 },
    );
    await worker.submit("r1", "Open Newsstand and tell me the top headline");
    await worker.idle();
    expect(settleLooks()).toBe(0);
  });
});
