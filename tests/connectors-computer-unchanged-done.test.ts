import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action } from "../connectors/computer/ports.js";
import { quitAtEnd } from "../connectors/computer/quit-done.js";
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

describe("a done while the app that the goal asks to quit is still open", () => {
  const read: Action = {
    kind: "done",
    summary: "The first note is Groceries.",
  };
  const quit: Action = { kind: "quit_app", name: "Notes" };
  const goal =
    "Open Notes and tell me the title of the first note. Only look and read. Then quit Notes.";
  const notes = observation([element(1, { title: "Groceries" })]);
  const finder = observation([element(1, { title: "Documents" })], {
    app: { name: "Finder", bundleId: "com.apple.finder", window: "Home" },
  });
  const open =
    "not taken yet: The goal also asks to quit Notes; it is still open.";

  it("goes back to the planner once, and the done after the quit is taken", async () => {
    const { worker, planner, hands, said, journal } = setup(
      [read, quit, read],
      [notes, finder],
    );
    await worker.submit("quit_1", goal);
    await worker.idle();
    expect(planner.inputs).toHaveLength(3);
    expect(planner.inputs[1]!.history.at(-1)?.outcome).toBe(open);
    expect(hands.sent).toEqual([quit]);
    expect(said.at(-1)).toBe("Done. The first note is Groceries.");
    expect(journal.get("quit_1")!.steps.map((step) => step.outcome)).toEqual([
      "done_app_open",
      "ok",
      "ok",
    ]);
  });

  it("takes the second done, also while the app is still open", async () => {
    const { worker, planner, hands, said } = setup([read, read], [notes]);
    await worker.submit("quit_2", goal);
    await worker.idle();
    expect(planner.inputs).toHaveLength(2);
    expect(hands.sent).toEqual([]);
    expect(said.at(-1)).toBe("Done. The first note is Groceries.");
  });

  it("knows the app by the name that open_app found for it, in the language of the Mac", async () => {
    // The person says Color, the Mac shows Colour: the bundle identifier is the same app.
    const meter = (name: string) =>
      observation([element(1, { title: "Hold Position" })], {
        surfaceEpoch: 2,
        app: { name, bundleId: "com.example.meter", window: "Meter" },
      });
    const { worker, planner, hands, said } = setup(
      [
        { kind: "open_app", name: "Color Meter" },
        { kind: "done", summary: "It shows 120, 64, 32." },
        { kind: "quit_app", name: "Colour Meter" },
        { kind: "done", summary: "It showed 120, 64, 32." },
      ],
      [finder, meter("Colour Meter"), finder],
    );
    hands.answer = (command) =>
      command.kind === "open_app"
        ? {
            observation: meter("Colour Meter"),
            resolvedBundleId: "com.example.meter",
          }
        : undefined;
    await worker.submit(
      "quit_3",
      "Open Color Meter and tell me what it shows. Then quit Color Meter.",
    );
    await worker.idle();
    expect(planner.inputs[2]!.history.at(-1)?.outcome).toBe(
      "not taken yet: The goal also asks to quit Color Meter; it is still open.",
    );
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "open_app",
      "quit_app",
    ]);
    expect(said.at(-1)).toBe("Done. It showed 120, 64, 32.");
  });

  it("is taken at once when another app is in front, when the goal ends with no quit, or names no app", async () => {
    for (const [request, screen] of [
      [goal, finder],
      ["Open Notes and tell me the title of the first note.", notes],
      [
        "Open Notes and tell me the title of the first note. Then quit it.",
        notes,
      ],
      ["Open Notes and tell me the title. Do not quit Notes.", notes],
    ] as const) {
      const { worker, planner, said } = setup([read], [screen]);
      await worker.submit("quit_4", request);
      await worker.idle();
      expect(planner.inputs, request).toHaveLength(1);
      expect(said.at(-1), request).toBe("Done. The first note is Groceries.");
    }
  });

  it("is taken at once when the worker was not asked to check", async () => {
    const { worker, planner, said } = setup([read], [notes], false);
    await worker.submit("quit_off", goal);
    await worker.idle();
    expect(planner.inputs).toHaveLength(1);
    expect(said.at(-1)).toBe("Done. The first note is Groceries.");
  });
});

describe("the app that the end of a goal asks to quit", () => {
  it("is named by the last sentence or the last clause of the goal", () => {
    for (const [goal, app] of [
      ["Open Tips and read the first tip. Then quit Tips.", "Tips"],
      ["Open Tips, read the first tip and then quit Tips", "Tips"],
      ["Read the window, and quit the Font Book app.", "Font Book"],
      ["Quit Digital Color Meter.", "Digital Color Meter"],
      ["Open Chess. Finally, quit Chess!", "Chess"],
    ] as const)
      expect(quitAtEnd(goal), goal).toBe(app);
    for (const goal of [
      "Open Tips and read the first tip.",
      "Quit Tips, then open Notes.",
      "Open Notes. Then quit it.",
      "Open Notes. Do not quit Notes.",
      "Open Notes and never quit Notes.",
      "",
    ])
      expect(quitAtEnd(goal), goal).toBeNull();
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
