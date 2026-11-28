import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { NavigationIntent } from "../connectors/computer/navigation.js";
import type { Outline, OutlineInput } from "../connectors/computer/plan.js";
import type { Action, Planner } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);

/** A promise that the test settles. */
function later<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "The note is saved." };
const say = "Opening Notes and saving the budget note.";

/**
 * A planner whose reading of the request the test holds back, as a language
 * model does for a second. Its turns answer at once.
 */
class SlowReader implements Planner {
  readonly turns: { action: Action; why: string }[];
  readonly asked: number[] = [];
  readonly reading = later<NavigationIntent>();
  readingAsked = false;
  outlineOf?: (input: OutlineInput) => Promise<Outline>;
  constructor(turns: Action[]) {
    this.turns = turns.map((action) => ({ action, why: "Save the note" }));
  }
  navigation() {
    this.readingAsked = true;
    return this.reading.promise;
  }
  async next() {
    this.asked.push(Date.now());
    return (
      this.turns.shift() ?? {
        action: { kind: "give_up", reason: "The script ended." } as Action,
        why: "",
      }
    );
  }
}

function setup(planner: Planner) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-first-turn-"));
  roots.push(root);
  const hands = new FakeHands([
    observation([element(1, { title: "Save" })], { surfaceEpoch: 3 }),
  ]);
  const said: string[] = [];
  const worker = new ComputerWorker({
    hands,
    planner,
    journal: new ComputerJournal(root),
    notify: (text) => said.push(text),
  });
  return { hands, said, worker };
}

describe("the reading of a request runs beside the first look and the first turn", () => {
  it("asks the first turn before the reading is in, and sends its action only after it", async () => {
    const planner = new SlowReader([click, done]);
    const f = setup(planner);
    await f.worker.submit("one", "Save the budget note.");
    // The look and the turn do not wait for the reading.
    await until(() => planner.asked.length === 1);
    expect(planner.readingAsked).toBe(true);
    expect(f.hands.commands.map((c) => c.kind)).toEqual(["observe"]);
    // Nothing goes to the Mac before the reading is in.
    await new Promise((done) => setTimeout(done, 30));
    expect(f.hands.sent).toEqual([]);
    planner.reading.resolve({ kind: "none" });
    await f.worker.idle();
    expect(f.hands.sent.map((c) => c.kind)).toEqual(["click"]);
    expect(f.worker.status().state).toBe("completed");
  });

  it("drops the turn that ran beside a reading that says to move: only the move goes out", async () => {
    const planner = new SlowReader([click, done]);
    const f = setup(planner);
    f.hands.answer = (c) =>
      c.kind === "switch_desktop"
        ? {
            observation: observation([], {
              surfaceEpoch: 9,
              app: {
                name: "TextEdit",
                bundleId: "com.apple.TextEdit",
                window: "Draft",
              },
            }),
          }
        : undefined;
    await f.worker.submit("one", "Move one desktop right.");
    await until(() => planner.asked.length === 1);
    planner.reading.resolve({ kind: "desktop", direction: "right" });
    await f.worker.idle();
    expect(f.hands.sent).toEqual([
      { kind: "switch_desktop", direction: "right" },
    ]);
    expect(f.worker.status().state).toBe("completed");
  });

  it("ends with nothing sent when the slow reading fails, as before", async () => {
    const planner = new SlowReader([click, done]);
    const f = setup(planner);
    await f.worker.submit("one", "Save the budget note.");
    await until(() => planner.asked.length === 1);
    planner.reading.reject(new Error("The model did not answer."));
    await f.worker.idle();
    expect(f.hands.sent).toEqual([]);
    expect(f.worker.status().state).toBe("blocked");
  });

  it("asks the question of a slow reading that cannot tell, and sends nothing", async () => {
    const planner = new SlowReader([click, done]);
    const f = setup(planner);
    await f.worker.submit("one", "Go there.");
    await until(() => planner.asked.length === 1);
    planner.reading.resolve({ kind: "clarify", question: "Where to?" });
    await f.worker.idle();
    expect(f.hands.sent).toEqual([]);
    expect(f.said).toEqual(["Where to?"]);
  });

  it("says the outline's first line only after the reading is in, and never for a move", async () => {
    const work = new SlowReader([click, done]);
    work.outlineOf = async () => ({
      subgoals: [{ goal: "Save the note", check: "It shows saved" }],
      say,
    });
    Object.assign(work, {
      outline: (input: OutlineInput) => work.outlineOf!(input),
    });
    const f = setup(work);
    await f.worker.submit("one", "Save the budget note.");
    await until(() => work.asked.length === 1);
    await new Promise((done) => setTimeout(done, 30));
    expect(f.said).toEqual([]);
    work.reading.resolve({ kind: "none" });
    await until(() => f.said.length > 0);
    expect(f.said[0]).toBe(say);
    await f.worker.idle();

    const move = new SlowReader([click, done]);
    Object.assign(move, {
      outline: async () => ({
        subgoals: [{ goal: "Save the note", check: "It shows saved" }],
        say,
      }),
    });
    const g = setup(move);
    g.hands.answer = (c) =>
      c.kind === "switch_desktop"
        ? { observation: observation([], { surfaceEpoch: 9 }) }
        : undefined;
    await g.worker.submit("two", "Move one desktop right.");
    await until(() => move.asked.length === 1);
    move.reading.resolve({ kind: "desktop", direction: "right" });
    await g.worker.idle();
    expect(g.said).not.toContain(say);
  });

  it("stops at once while the reading is out, with nothing sent", async () => {
    const planner = new SlowReader([click, done]);
    const f = setup(planner);
    await f.worker.submit("one", "Save the budget note.");
    await until(() => planner.asked.length === 1);
    f.worker.stop();
    await f.worker.idle();
    expect(f.hands.sent).toEqual([]);
    expect(f.worker.status().state).toBe("canceled");
  });
});
