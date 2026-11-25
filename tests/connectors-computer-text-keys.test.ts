import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type {
  Action,
  HandCommand,
  Observation,
} from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  editsText,
  noTextFocusText,
  textKeyHold,
} from "../connectors/computer/text-keys.js";
import {
  FakeHands,
  ScriptedPlanner,
  element,
  observation,
} from "./connectors-computer-fixture.js";

/**
 * A notes app in the fixture's screen: a list of notes, an editor and a
 * search field. The editor takes keys only when it has the focus, as in a
 * real app: cmd+a there selects its text, and typed text then replaces it.
 * With the focus elsewhere, cmd+a and typed text change no note.
 */
class NotesApp {
  text = "milk, eggs, bread";
  focused = false;
  selected = false;
  readonly row = element(2, {
    role: "AXStaticText",
    title: "Groceries",
    x: 100,
    y: 150,
    w: 260,
    h: 40,
  });
  readonly search = element(1, {
    role: "AXSearchField",
    title: "Search",
    x: 900,
    y: 60,
    w: 190,
    h: 26,
  });
  editor(): Observation["elements"][number] {
    return element(3, {
      role: "AXTextArea",
      title: "",
      value: this.text,
      x: 400,
      y: 120,
      w: 800,
      h: 600,
      focused: this.focused,
    });
  }
  look(): Observation {
    return observation([this.search, this.row, this.editor()]);
  }
  /** What one command of the hands does to the app. */
  run(command: HandCommand) {
    if (command.kind === "click") {
      const editor = this.editor();
      // A click in the editor puts the caret there and drops a selection.
      this.focused =
        command.x >= editor.x &&
        command.x < editor.x + editor.w &&
        command.y >= editor.y &&
        command.y < editor.y + editor.h;
      this.selected = false;
    }
    if (command.kind === "key" && command.combo === "cmd+a" && this.focused)
      this.selected = true;
    if (command.kind === "type" && this.focused) {
      this.text = this.selected ? command.text : this.text + command.text;
      this.selected = false;
    }
  }
}

describe("which keys edit text", () => {
  it("names select all, cut, paste and delete a word, however they are written", () => {
    for (const combo of [
      "cmd+a",
      "Command+A",
      "cmd+x",
      "cmd+v",
      "shift+cmd+v",
      "cmd+shift+alt+v",
      "opt+delete",
      "alt+backspace",
      "option+forwarddelete",
    ])
      expect(editsText(combo), combo).toBe(true);
    // Copy changes nothing; cmd+delete has its own question in Finder.
    for (const combo of [
      "cmd+c",
      "cmd+z",
      "cmd+s",
      "cmd+delete",
      "delete",
      "return",
      "tab",
      "a",
      "not a key",
    ])
      expect(editsText(combo), combo).toBe(false);
  });

  it("holds such a key back only when the look names elements and no text field has the focus", () => {
    const key = (combo: string): Action => ({ kind: "key", combo });
    const field = (role: string, focused: boolean) =>
      element(3, { role, focused });
    // A text field, a text area or a search field with the focus takes it.
    for (const role of ["AXTextField", "AXTextArea", "AXSearchField"])
      expect(
        textKeyHold(key("cmd+a"), observation([field(role, true)])),
        role,
      ).toBeNull();
    // The focus in a list, on a button, or on no element: held back.
    for (const role of ["AXList", "AXOutline", "AXButton"])
      expect(
        textKeyHold(key("cmd+a"), observation([field(role, true)])),
        role,
      ).toBe(noTextFocusText);
    expect(
      textKeyHold(key("cmd+v"), observation([field("AXTextArea", false)])),
    ).toBe(noTextFocusText);
    expect(
      textKeyHold(key("cmd+v"), observation([field("AXCell", false)])),
    ).toBe(noTextFocusText);
    // A look with no element cannot say where the focus is: the key goes.
    expect(textKeyHold(key("cmd+a"), observation([]))).toBeNull();
    // Other keys and other actions are not touched.
    expect(
      textKeyHold(key("return"), observation([field("AXList", true)])),
    ).toBeNull();
    expect(
      textKeyHold(
        { kind: "type", text: "oat milk" },
        observation([field("AXList", true)]),
      ),
    ).toBeNull();
  });

  it("lets such a key go to a cell, a sheet, a grid, a canvas, a web editor or a document view with the focus", () => {
    const key = (combo: string): Action => ({ kind: "key", combo });
    // A spreadsheet cell or its sheet, a grid, the canvas of a document, a web
    // page that draws its own editor (web sheets and slides), the view of a document.
    for (const role of [
      "AXCell",
      "AXTable",
      "AXGrid",
      "AXLayoutArea",
      "AXWebArea",
      "AXScrollArea",
    ])
      for (const combo of ["cmd+a", "cmd+v", "cmd+x", "opt+delete"])
        expect(
          textKeyHold(
            key(combo),
            observation([
              element(1, { role: "AXButton", title: "Bold" }),
              element(2, { role, title: "A1", focused: true }),
            ]),
          ),
          `${combo} in ${role}`,
        ).toBeNull();
  });
});

describe("keys that edit text, with no text field in focus", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  const setup = (script: Action[]) => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-text-keys-"));
    roots.push(home);
    const app = new NotesApp();
    const hands = new FakeHands([app.look()]);
    hands.answer = (command) => {
      app.run(command);
      if (command.kind !== "observe") return undefined;
      const seen = app.look();
      const { image, imageWidth, imageHeight, ...bare } = seen;
      return { observation: command.image ? seen : bare };
    };
    const planner = new ScriptedPlanner(script);
    const journal = new ComputerJournal(home, () => 1_000_000);
    const worker = new ComputerWorker({
      hands,
      planner,
      journal,
      now: () => 1_000_000,
      notify: () => {},
    });
    return { app, hands, planner, journal, worker };
  };
  const goal =
    "Open the note named Groceries and replace all of its text with the one line 'oat milk'.";
  const clickRow: Action = { kind: "click_element", element: 2 };
  const clickEditor: Action = { kind: "click_element", element: 3 };
  const selectAll: Action = { kind: "key", combo: "cmd+a" };

  it("holds select-all back when the planner skipped the click into the note, and tells the planner", async () => {
    // The planner test failure of 23 Nov 2026 (2 of 3 runs): a click on the
    // note in the list, then cmd+a with the focus still out of the editor.
    const { app, hands, planner, worker } = setup([
      clickRow,
      selectAll,
      { kind: "give_up", reason: "Stop here." },
    ]);
    await worker.submit("r1", goal);
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(planner.inputs[2]!.history.at(-1)).toMatchObject({
      action: selectAll,
      outcome:
        "refused: No text field has the focus. Click into the text first.",
    });
    expect(app.selected).toBe(false);
    expect(app.text).toBe("milk, eggs, bread");
  });

  it("sends select-all after the click into the note, and the text is replaced", async () => {
    const { app, hands, worker } = setup([
      clickRow,
      selectAll,
      clickEditor,
      selectAll,
      { kind: "type", text: "oat milk" },
      { kind: "done", summary: "The note says oat milk." },
    ]);
    await worker.submit("r1", goal);
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "click",
      "click",
      "key",
      "type",
    ]);
    expect(app.text).toBe("oat milk");
    expect(worker.snapshot().state).toBe("completed");
  });

  it("ends the request after three such keys in a row, with the reason", async () => {
    const { hands, journal, worker } = setup([
      clickRow,
      selectAll,
      { kind: "key", combo: "cmd+v" },
      { kind: "key", combo: "opt+delete" },
      { kind: "done", summary: "Never read." },
    ]);
    await worker.submit("r1", goal);
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "too_many_refusals",
    });
    expect(worker.snapshot().message).toContain(
      "No text field has the focus. Click into the text first.",
    );
  });
});
