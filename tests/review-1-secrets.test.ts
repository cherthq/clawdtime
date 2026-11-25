import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * Review 1: a secret in the words that the person sends while a task runs.
 * The docs say that words that hold a password or a PIN are written nowhere
 * and never sent to the planner. These words reach both.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

/** A task whose planner is choosing its first action, until the test lets it go on. */
async function running() {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-review-1-secrets-"));
  roots.push(home);
  let release = () => {};
  const gate = new Promise<void>((open) => (release = open));
  const wait: Action = { kind: "wait", ms: 0 };
  const done: Action = { kind: "done", summary: "Signed in." };
  const planner = new ScriptedPlanner([
    async () => {
      await gate;
      return wait;
    },
    done,
  ]);
  const hands = new FakeHands([observation([element(1, { title: "Save" })])]);
  const now = () => 1_000_000;
  const journal = new ComputerJournal(home, now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now,
    notify: () => {},
  });
  await worker.submit("r1", "Sign in to the bank");
  await until(() => planner.inputs.length === 1);
  return { worker, planner, journal, release, home };
}

describe("review 1: a secret in words while a task runs", () => {
  it.each([
    // An order: it steers the task, so it goes to the planner.
    ["type hunter22 in the password field", "hunter22"],
    ["enter 4821 in the pin field", "4821"],
    // A hold: it pauses, and the words are kept all the same.
    ["my pin number is 4821", "4821"],
    // The same with a common misspelling of password.
    ["my pasword is hunter22", "hunter22"],
  ])(
    "keeps %j out of the record and away from the planner",
    async (words, secret) => {
      const { worker, planner, journal, release, home } = await running();
      await worker.submit("g1", words);
      release();
      await until(
        () =>
          planner.inputs.length >= 2 ||
          worker.snapshot().state === "waiting_for_person",
      );
      const guidance = journal.guidance("r1").map((said) => said.text);
      expect(guidance.join(" ")).not.toContain(secret);
      expect(
        readFileSync(join(home, "computer", "guidance.json"), "utf8"),
      ).not.toContain(secret);
      const heard = planner.inputs.flatMap((input) => input.guidance ?? []);
      expect(heard.join(" ")).not.toContain(secret);
      worker.stop();
      await worker.idle();
    },
  );
});

describe("review 1: a secret split over two messages", () => {
  it("keeps a PIN that comes in the message after the one that names the field", async () => {
    const { worker, planner, journal, release } = await running();
    // An order: it steers and does not pause, so the next words are taken
    // while the task runs. Each message alone looks like no secret.
    await worker.submit("g1", "type my pin in the pin field");
    await worker.submit("g2", "4821");
    release();
    await until(
      () =>
        planner.inputs.length >= 2 ||
        worker.snapshot().state === "waiting_for_person",
    );
    const guidance = journal.guidance("r1").map((said) => said.text);
    expect(guidance.join(" ")).not.toContain("4821");
    const heard = planner.inputs.flatMap((input) => input.guidance ?? []);
    expect(heard.join(" ")).not.toContain("4821");
    worker.stop();
    await worker.idle();
  });
});
