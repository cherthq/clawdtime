import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { HandCommand } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

/**
 * Review 1: the closer look. A click that the planner gives in the closer
 * picture is mapped onto the screen of the look of that turn (closer.ts).
 * When that screen is another one than the one the closer picture shows,
 * the planner aims at something that is no longer there.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe("review 1: a closer picture of a screen that changed", () => {
  it("does not reach the planner when the look after it shows another app", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-review-1-closer-"));
    roots.push(home);
    const notes = observation([
      element(1, { title: "Three stars", x: 600, y: 420, w: 40, h: 20 }),
    ]);
    // Between the zoom and the next look, Mail came to the front, with its
    // Delete button where the stars were.
    const mail = observation(
      [element(1, { title: "Delete", x: 600, y: 420, w: 40, h: 20 })],
      {
        app: { name: "Mail", bundleId: "com.apple.mail", window: "Inbox" },
      },
    );
    const hands = new FakeHands([notes, mail]);
    hands.answer = (command: HandCommand) =>
      command.kind === "zoom"
        ? {
            ok: true,
            observation: {
              ...notes,
              elements: [],
              image: "Y2xvc2Vy",
              imageWidth: 960,
              imageHeight: 600,
            },
          }
        : undefined;
    const planner = new ScriptedPlanner([
      { kind: "look_closer", x: 640, y: 400 },
      { kind: "give_up", reason: "Stop here." },
    ]);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(home, () => 1_000_000),
      now: () => 1_000_000,
      notify: () => {},
    });
    await worker.submit("r1", "Give the review three stars");
    await worker.idle();
    expect(planner.inputs[1]!.observation!.app.name).toBe("Mail");
    expect(planner.inputs[1]!.closer).toBeUndefined();
  });
});
