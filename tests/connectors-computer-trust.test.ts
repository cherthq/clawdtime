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
const done: Action = { kind: "done", summary: "Ordered." };

function setup(
  title: string,
  trust: boolean,
  script: Action[] = [click, done],
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-trust-"));
  roots.push(home);
  const clock = { now: 1_000_000 };
  const hands = new FakeHands([observation([element(1, { title })])]);
  const planner = new ScriptedPlanner(script);
  const said: string[] = [];
  const worker = new ComputerWorker({
    hands,
    planner,
    journal: new ComputerJournal(home, () => clock.now),
    now: () => clock.now,
    notify: (text) => said.push(text),
    ...(trust ? { trust } : {}),
  });
  return { worker, hands, said };
}

describe("the owner's trust", () => {
  it.each(["Place order", "Delete forever", "Empty Trash"])(
    "clicks %j with no question when the owner trusts it",
    async (title) => {
      const { worker, hands, said } = setup(title, true);
      await worker.submit(
        `trust_${title.replace(/\W/g, "_")}`,
        "Do what the screen needs",
      );
      await worker.idle();
      expect(hands.sent).toHaveLength(1);
      expect(said.at(-1)).toBe("Done. Ordered.");
    },
  );

  it("asks first without the owner's trust", async () => {
    const { worker, hands } = setup("Place order", false);
    await worker.submit("no_trust", "Do what the screen needs");
    await until(() => worker.snapshot().state === "waiting_for_person");
    expect(hands.sent).toHaveLength(0);
    worker.stop();
    await worker.idle();
    expect(hands.sent).toHaveLength(0);
  });

  it("still stops at once at Stop", async () => {
    const { worker, hands } = setup("Place order", true, [
      { kind: "wait", ms: 10 },
      { kind: "wait", ms: 11 },
      click,
      done,
    ]);
    await worker.submit("trust_stop", "Do what the screen needs");
    worker.stop();
    await worker.idle();
    expect(hands.sent).toHaveLength(0);
  });
});
