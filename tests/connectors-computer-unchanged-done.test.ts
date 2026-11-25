import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "Saved." };
const save = observation([element(1, { title: "Save" })]);
const saved = observation([element(1, { title: "Saved" })]);

function setup(
  script: Action[],
  screens: ReturnType<typeof observation>[],
  unchangedDone = true,
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-unchanged-done-"));
  roots.push(home);
  const clock = { now: 1_000_000 };
  const hands = new FakeHands(screens);
  const planner = new ScriptedPlanner(script);
  const said: string[] = [];
  const journal = new ComputerJournal(home, () => clock.now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: (text) => said.push(text),
    ...(unchangedDone ? { unchangedDone } : {}),
  });
  return { worker, planner, hands, said, journal };
}

describe("a done after an input that changed nothing", () => {
  it("goes back to the planner once, and the next done is taken", async () => {
    // The app does not take the click: every look shows the same screen.
    const { worker, planner, hands, said } = setup([click, done, done], [save]);
    await worker.submit("still_1", "Save the note");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(planner.inputs).toHaveLength(3);
    expect(planner.inputs[2]!.history.at(-1)?.outcome).toMatch(
      /^not taken yet: the screen looks the same as before your last action \(click_element\)/,
    );
    expect(said.at(-1)).toBe("Done. Saved.");
  });

  it("tells the planner at once that a click changed nothing", async () => {
    const { worker, planner } = setup([click, done, done], [save]);
    await worker.submit("still_told", "Save the note");
    await worker.idle();
    expect(planner.inputs[1]!.history.at(-1)?.outcome).toMatch(
      /^sent, but the screen looks the same after it/,
    );
  });

  it("lets the planner act again after the note, as a person would retry", async () => {
    const { worker, hands, said } = setup(
      [click, done, click, done],
      [save, save, save, save, saved],
    );
    await worker.submit("still_2", "Save the note");
    await worker.idle();
    expect(hands.sent).toHaveLength(2);
    expect(said.at(-1)).toBe("Done. Saved.");
  });

  it("is taken at once when the screen changed after the input", async () => {
    const { worker, planner, said } = setup([click, done], [save, save, saved]);
    await worker.submit("moved", "Save the note");
    await worker.idle();
    expect(planner.inputs).toHaveLength(2);
    expect(said.at(-1)).toBe("Done. Saved.");
  });

  it("is taken at once when no input came before it", async () => {
    const { worker, planner, said } = setup([done], [save]);
    await worker.submit("look_only", "Is the note saved?");
    await worker.idle();
    expect(planner.inputs).toHaveLength(1);
    expect(said.at(-1)).toBe("Done. Saved.");
  });

  it("is taken at once when the worker was not asked to check", async () => {
    const { worker, planner, said } = setup([click, done], [save], false);
    await worker.submit("off", "Save the note");
    await worker.idle();
    expect(planner.inputs).toHaveLength(2);
    expect(said.at(-1)).toBe("Done. Saved.");
  });
});

describe("an answer to a question of the planner", () => {
  const ask = (question: string): Action => ({ kind: "ask", question });
  it("takes an email address for a question about an email, also when it names the password step", async () => {
    const { worker, planner } = setup(
      [
        ask(
          "Please type your work email in the Email field, then tell me when you are ready for the password step.",
        ),
        done,
      ],
      [save],
    );
    await worker.submit("email_answer", "Sign in with my work email");
    await until(() => worker.snapshot().state === "waiting_for_person");
    expect((await worker.answer("ada@example.com")).message).toBe(
      "Thank you. I go on.",
    );
    await worker.idle();
    expect(planner.inputs[1]!.history.at(-1)?.outcome).toBe(
      "the person answered: ada@example.com",
    );
  });

  it("still refuses a bare value for a question about a password", async () => {
    const { worker } = setup(
      [ask("What is the password of the Ledger account?"), done],
      [save],
    );
    await worker.submit("password_answer", "Sign in to Ledger");
    await until(() => worker.snapshot().state === "waiting_for_person");
    expect((await worker.answer("hunter22")).message).toMatch(
      /^I do not take a password or a key in the chat/,
    );
    worker.stop();
    await worker.idle();
  });
});
