import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  navigationIntentSchema,
  parseNavigationCalls,
  type NavigationIntent,
} from "../connectors/computer/navigation.js";
import { actionSchema } from "../connectors/computer/guards.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  handCommandSchema,
  type HandResult,
} from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
const before = observation([], { surfaceEpoch: 7 });
const after = observation([], {
  surfaceEpoch: 9,
  app: {
    name: "TextEdit",
    bundleId: "com.apple.TextEdit",
    window: "Disposable destination",
  },
});
function setup(
  intent: NavigationIntent = { kind: "desktop", direction: "right" },
) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-direction-"));
  roots.push(root);
  const hands = new FakeHands([before]);
  const navigationInputs: string[] = [];
  const planner = Object.assign(
    new ScriptedPlanner([{ kind: "key", combo: "ctrl+right" }]),
    {
      navigation: async (goal: string) => {
        navigationInputs.push(goal);
        return intent;
      },
    },
  );
  const journal = new ComputerJournal(root);
  const worker = new ComputerWorker({ hands, planner, journal });
  return { hands, planner, journal, worker, navigationInputs };
}

describe("explicit directional navigation", () => {
  it.each([
    ["Switch to the desktop on the left.", "left"],
    ["Move one desktop right.", "right"],
    ["Go back to the previous desktop.", "previous"],
    ["Please switch to the space on the right!", "right"],
    ["Could you slide our workspace one slot leftward?", "left"],
    ["Take me over to the neighboring Space on my right", "right"],
  ] as const)(
    "dispatches one model-interpreted intent for %s",
    async (goal, direction) => {
      const f = setup({ kind: "desktop", direction });
      f.hands.answer = (c) =>
        c.kind === "switch_desktop" ? { observation: after } : undefined;
      await f.worker.submit("one", goal);
      await f.worker.idle();
      expect(f.hands.sent).toEqual([{ kind: "switch_desktop", direction }]);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.navigationInputs).toEqual([goal]);
      expect(f.worker.status().state).toBe("completed");
    },
  );
  it.each([
    "Switch desktop left then click Save",
    "Move two desktops right",
    "Go back there",
  ])(
    "does not dispatch an interpretation that requires clarification: %s",
    async (goal) => {
      const f = setup({
        kind: "clarify",
        question: "Which single destination do you mean?",
      });
      await f.worker.submit("one", goal);
      await f.worker.idle();
      expect(f.hands.commands).toEqual([]);
      expect(f.worker.status().state).toBe("blocked");
      expect(f.navigationInputs).toEqual([goal]);
    },
  );
  it("rejects extra moves, unknown kinds, and multiple model calls", () => {
    expect(
      navigationIntentSchema.safeParse({
        kind: "desktop",
        direction: "right",
        count: 2,
      }).success,
    ).toBe(false);
    expect(
      navigationIntentSchema.safeParse({ kind: "desktop", direction: "up" })
        .success,
    ).toBe(false);
    expect(() =>
      parseNavigationCalls([
        { name: "desktop", arguments: '{"direction":"left"}' },
        { name: "previous_app", arguments: "{}" },
      ]),
    ).toThrow();
    expect(() =>
      parseNavigationCalls([
        { name: "none", arguments: '{"kind":"desktop","direction":"right"}' },
      ]),
    ).toThrow();
  });
  it.each([
    [
      { kind: "app", name: "TextEdit", window: "Disposable destination" },
      { kind: "open_app", name: "TextEdit", window: "Disposable destination" },
    ],
    [{ kind: "previous_app" }, { kind: "switch_previous_app" }],
  ] as const)(
    "runs one app transition outside the screen planner: %j",
    async (intent, command) => {
      const f = setup(intent);
      f.hands.answer = (c) =>
        c.kind !== "observe" ? { observation: after } : undefined;
      await f.worker.submit(
        "one",
        "Please bring that requested application forward",
      );
      await f.worker.idle();
      expect(f.hands.sent).toEqual([command]);
      expect(f.planner.inputs).toEqual([]);
      expect(f.worker.status().state).toBe("completed");
    },
  );
  it.each([
    ["iTerm", "iTerm2", "com.googlecode.iterm2"],
    ["Visual Studio Code", "Code", "com.microsoft.VSCode"],
    ["Safari.app", "Safari", "com.apple.Safari"],
  ] as const)(
    'completes "go to %s" when the app that the hands found is in front',
    async (said, name, bundleId) => {
      const f = setup({ kind: "app", name: said });
      f.hands.answer = (c) =>
        c.kind === "open_app"
          ? {
              observation: { ...after, app: { name, bundleId, window: "~" } },
              resolvedBundleId: bundleId,
            }
          : undefined;
      await f.worker.submit("one", `Go to ${said}`);
      await f.worker.idle();
      expect(f.hands.sent).toEqual([{ kind: "open_app", name: said }]);
      expect(f.planner.inputs).toEqual([]);
      expect(f.worker.status().state).toBe("completed");
      expect(f.journal.unresolved()).toBeNull();
    },
  );
  it("goes on with the planner when the hands know no app by the name that was said", async () => {
    // "Open Chrome": the app's file, its name in Finder and its running name
    // are all "Google Chrome". The hands open nothing and say so.
    const chrome = {
      ...after,
      app: {
        name: "Google Chrome",
        bundleId: "com.google.Chrome",
        window: "New Tab",
      },
    };
    const f = setup({ kind: "app", name: "Chrome" });
    f.planner = Object.assign(
      new ScriptedPlanner([
        { kind: "open_app", name: "Google Chrome" },
        { kind: "done", summary: "Chrome is in front." },
      ]),
      { navigation: f.planner.navigation },
    );
    const worker = new ComputerWorker({
      hands: f.hands,
      planner: f.planner,
      journal: f.journal,
    });
    f.hands.answer = (c) =>
      c.kind !== "open_app"
        ? undefined
        : c.name === "Chrome"
          ? { ok: false, error: "not_found" }
          : { observation: chrome, resolvedBundleId: "com.google.Chrome" };
    await worker.submit("one", "Open Chrome");
    await worker.idle();
    expect(f.hands.sent).toEqual([
      { kind: "open_app", name: "Chrome" },
      { kind: "open_app", name: "Google Chrome" },
    ]);
    expect(f.planner.inputs[0]?.history).toEqual([
      {
        step: 1,
        action: { kind: "open_app", name: "Chrome" },
        why: "The person asked for this app.",
        outcome: expect.stringMatching(
          /^refused: No app with that name was found on this Mac\. Nothing was opened\./,
        ),
      },
    ]);
    expect(worker.status()).toMatchObject({
      state: "completed",
      message: "Done. Chrome is in front.",
    });
    expect(f.journal.unresolved()).toBeNull();
  });
  it("lets the planner tell the person why the app cannot be opened, and does not lock", async () => {
    const f = setup({ kind: "app", name: "Notesy", window: "Shopping" });
    f.planner = Object.assign(
      new ScriptedPlanner([
        { kind: "give_up", reason: "No app with the name Notesy is here." },
      ]),
      { navigation: f.planner.navigation },
    );
    const worker = new ComputerWorker({
      hands: f.hands,
      planner: f.planner,
      journal: f.journal,
    });
    f.hands.answer = (c) =>
      c.kind === "open_app" ? { ok: false, error: "not_found" } : undefined;
    await worker.submit("one", "Go to the Shopping window of Notesy");
    await worker.idle();
    expect(f.hands.sent).toEqual([
      { kind: "open_app", name: "Notesy", window: "Shopping" },
    ]);
    expect(worker.status()).toMatchObject({
      state: "blocked",
      message: "I could not finish. No app with the name Notesy is here.",
    });
    expect(f.journal.unresolved()).toBeNull();
    expect((await worker.submit("two", "Open Notes")).message).toMatch(
      /^Started/,
    );
  });
  it("counts the refused app of the person's request in the row of three", async () => {
    const f = setup({ kind: "app", name: "Notesy" });
    const again = { kind: "open_app", name: "Notesy" } as const;
    f.planner = Object.assign(new ScriptedPlanner([again, again, again]), {
      navigation: f.planner.navigation,
    });
    const worker = new ComputerWorker({
      hands: f.hands,
      planner: f.planner,
      journal: f.journal,
    });
    f.hands.answer = (c) =>
      c.kind === "open_app" ? { ok: false, error: "not_found" } : undefined;
    await worker.submit("one", "Open Notesy");
    await worker.idle();
    expect(f.hands.sent).toEqual([again, again, again]);
    expect(worker.status().state).toBe("blocked");
    expect(f.journal.get("one")?.reason).toBe("too_many_refusals");
    expect(f.journal.unresolved()).toBeNull();
  });
  it.each(["no_accessibility", "no_screen_recording"] as const)(
    "ends an app request on %s with the sentence that names the right, and never asks the planner",
    async (error) => {
      const f = setup({ kind: "app", name: "Notes" });
      f.hands.answer = (c) =>
        c.kind === "open_app" ? { ok: false, error } : undefined;
      await f.worker.submit("one", "Open Notes");
      await f.worker.idle();
      expect(f.worker.status().state).toBe("blocked");
      expect(f.worker.status().message).toMatch(
        error === "no_accessibility"
          ? /Privacy & Security, Accessibility/
          : /Screen & System Audio Recording/,
      );
      expect(f.journal.get("one")?.reason).toBe(error);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.hands.sent).toHaveLength(1);
    },
  );
  it("keeps an app request with an unknown result away from the planner", async () => {
    const f = setup({ kind: "app", name: "Notes" });
    f.hands.answer = (c) =>
      c.kind === "open_app"
        ? { ok: false, error: "transition_unknown" }
        : undefined;
    await f.worker.submit("one", "Open Notes");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("uncertain");
    expect(f.planner.inputs).toHaveLength(0);
    expect(f.hands.sent).toHaveLength(1);
  });
  it("rejects a previous-app receipt that still shows the same app", async () => {
    const f = setup({ kind: "previous_app" });
    f.hands.answer = (c) =>
      c.kind === "switch_previous_app"
        ? { observation: { ...before, surfaceEpoch: 9 } }
        : undefined;
    await f.worker.submit("one", "Return to my last application");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("uncertain");
    expect(f.hands.sent).toHaveLength(1);
  });
  it("discards a late interpretation after Stop", async () => {
    const f = setup();
    let resolve!: (intent: NavigationIntent) => void;
    f.planner.navigation = () =>
      new Promise((r) => {
        resolve = r;
      });
    await f.worker.submit("one", "Slide to the next space on the right");
    f.worker.stop();
    resolve({ kind: "desktop", direction: "right" });
    await f.worker.idle();
    expect(f.hands.commands).toEqual([]);
    expect(f.worker.status().state).toBe("canceled");
  });
  it("blocks invalid model interpretation before observing or dispatching", async () => {
    const f = setup();
    f.planner.navigation = async () =>
      ({ kind: "desktop", direction: "right", count: 2 }) as NavigationIntent;
    await f.worker.submit("one", "Move next door");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("blocked");
    expect(f.hands.commands).toEqual([]);
  });
  it("keeps the directional command outside the model action vocabulary", () => {
    const command = { kind: "switch_desktop", direction: "right" };
    expect(handCommandSchema.safeParse(command).success).toBe(true);
    expect(actionSchema.safeParse(command).success).toBe(false);
    expect(handCommandSchema.safeParse({ ...command, count: 2 }).success).toBe(
      false,
    );
  });
  it.each([
    { ok: false, error: "transition_unknown" },
    { ok: true },
    { ok: true, observation: before },
    { ok: true, observation: { ...after, image: undefined } },
    { ok: true, observation: { ...after, surfaceEpoch: undefined } },
    {
      ok: true,
      observation: { ...after, screen: { ...after.screen, scale: 1 } },
    },
    { ok: true, observation: after, interrupted: true },
  ] satisfies Partial<HandResult>[])(
    "fences unverified/delayed/boundary outcomes without replanning: %j",
    async (result) => {
      const f = setup();
      f.hands.answer = (c) =>
        c.kind === "switch_desktop" ? result : undefined;
      await f.worker.submit("one", "Move one desktop right");
      await f.worker.idle();
      expect(f.worker.status().state).toBe("uncertain");
      await f.worker.submit("two", "Move one desktop right");
      await f.worker.idle();
      expect(f.hands.sent).toHaveLength(1);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.journal.get("one")?.reason).toBe("transition_unknown");
    },
  );
  it("says that the desktop did not change at the last desktop, and does not lock", async () => {
    const f = setup({ kind: "desktop", direction: "right" });
    f.hands.answer = (c) =>
      c.kind === "switch_desktop"
        ? { ok: false, error: "desktop_unchanged" }
        : undefined;
    await f.worker.submit("one", "Move one desktop right");
    await f.worker.idle();
    expect(f.worker.status()).toMatchObject({
      state: "blocked",
      message:
        "The desktop did not change. There may be no desktop on that side.",
    });
    expect(f.journal.get("one")?.reason).toBe("desktop_unchanged");
    // Known, not unknown: nothing to clear, and the next request runs at once.
    expect(f.journal.unresolved()).toBeNull();
    expect(f.worker.clear()).toEqual({ message: "Nothing to clear." });
    expect(f.hands.sent).toHaveLength(1);
    expect(f.planner.inputs).toHaveLength(0);
    f.hands.answer = (c) =>
      c.kind === "switch_desktop" ? { observation: after } : undefined;
    await f.worker.submit("two", "Move one desktop right");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("completed");
    // One switch for each request: the first was never sent a second time.
    expect(f.hands.sent).toEqual([
      { kind: "switch_desktop", direction: "right" },
      { kind: "switch_desktop", direction: "right" },
    ]);
  });
  it("says that there is no other app when Command+Tab has nowhere to go, and does not lock", async () => {
    const f = setup({ kind: "previous_app" });
    f.hands.answer = (c) =>
      c.kind === "switch_previous_app"
        ? { ok: false, error: "not_found" }
        : undefined;
    await f.worker.submit("one", "Go back to the app I was just using");
    await f.worker.idle();
    expect(f.worker.status()).toMatchObject({
      state: "blocked",
      message: "There is no other app to go back to. Nothing was sent.",
    });
    expect(f.journal.get("one")?.reason).toBe("no_other_app");
    expect(f.journal.unresolved()).toBeNull();
    expect(f.hands.sent).toEqual([{ kind: "switch_previous_app" }]);
    expect(f.planner.inputs).toHaveLength(0);
    expect((await f.worker.submit("two", "Open Notes")).message).toMatch(
      /^Started/,
    );
    await f.worker.idle();
  });
  it.each([
    ["switch_desktop", { kind: "desktop", direction: "right" }],
    ["switch_previous_app", { kind: "previous_app" }],
  ] as const)(
    "keeps a real unknown of %s unknown: an interruption in the middle and a lost result",
    async (kind, intent) => {
      for (const answer of [
        { ok: false, error: "transition_unknown", interrupted: true },
        { ok: false, error: "input_unknown" },
        "lost",
      ] as const) {
        const f = setup(intent);
        f.hands.answer = (c) => (c.kind === kind ? answer : undefined);
        await f.worker.submit("one", "Move");
        await f.worker.idle();
        expect(f.worker.status().state).toBe("uncertain");
        expect(f.worker.status().message).toMatch(
          /say "clear the computer task", or run: clawdtime computer clear$/,
        );
        expect((await f.worker.submit("two", "Move")).message).toMatch(
          /unknown result/,
        );
        expect(f.hands.sent).toHaveLength(1);
      }
    },
  );
  it.each([
    "desktop_shortcut_unavailable",
    "desktop_history_unavailable",
    "desktop_disabled",
    "unsupported_desktop",
    "no_accessibility",
    "no_screen_recording",
  ] as const)("reports predispatch %s without retries", async (error) => {
    const f = setup();
    f.hands.answer = (c) =>
      c.kind === "switch_desktop" ? { ok: false, error } : undefined;
    await f.worker.submit("one", "Move one desktop left");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("blocked");
    expect(f.journal.get("one")?.reason).toBe(error);
    expect(f.hands.sent).toHaveLength(1);
    expect(f.planner.inputs).toHaveLength(0);
  });
  it.each([
    ["no_accessibility", "no_accessibility"],
    ["no_screen_recording", "no_screen_recording"],
    ["stale_observation", "desktop_not_ready"],
    ["failed", "desktop_not_ready"],
    ["refused", "desktop_not_ready"],
  ] as const)(
    "reports the initial observation's %s without sending a switch",
    async (error, reason) => {
      const f = setup();
      f.hands.answer = () => ({ ok: false, error });
      await f.worker.submit("one", "Move one desktop left");
      await f.worker.idle();
      expect(f.hands.commands).toEqual([
        { kind: "observe", image: true, elements: true },
      ]);
      expect(f.hands.sent).toHaveLength(0);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.worker.status()).toMatchObject({
        state: "blocked",
        step: 0,
      });
      expect(f.worker.status().message).toContain(`failed (${error})`);
      expect(f.worker.status().message).toContain("No switch was attempted.");
      expect(f.journal.get("one")?.reason).toBe(reason);
    },
  );
  it.each([undefined, "untrusted fixture detail"])(
    "does not reflect an absent or unrecognized initial observation error: %s",
    async (error) => {
      const f = setup();
      f.hands.answer = () => ({
        ok: false,
        error: error as HandResult["error"],
      });
      await f.worker.submit("one", "Move one desktop left");
      await f.worker.idle();
      expect(f.hands.sent).toHaveLength(0);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.worker.status().state).toBe("blocked");
      expect(f.worker.status().message).toContain(
        "without a recognized error code",
      );
      expect(f.worker.status().message).toContain("No switch was attempted.");
      expect(f.worker.status().message).not.toContain(
        "untrusted fixture detail",
      );
      expect(f.journal.get("one")?.reason).toBe("desktop_not_ready");
    },
  );
  it.each([undefined, observation()])(
    "distinguishes missing desktop readiness evidence from a failed observation",
    async (seen) => {
      const f = setup();
      f.hands.answer = () => ({ observation: seen });
      await f.worker.submit("one", "Move one desktop left");
      await f.worker.idle();
      expect(f.hands.sent).toHaveLength(0);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.worker.status().state).toBe("blocked");
      expect(f.worker.status().message).toContain(
        "did not include a verified desktop surface epoch",
      );
      expect(f.worker.status().message).toContain("No switch was attempted.");
      expect(f.journal.get("one")?.reason).toBe("desktop_not_ready");
    },
  );
  it("does not resume a directional attempt after takeover before dispatch", async () => {
    const f = setup();
    f.hands.answer = () => ({ interrupted: true });
    await f.worker.submit("one", "Move one desktop left");
    await f.worker.idle();
    expect(f.hands.sent).toHaveLength(0);
    expect(f.worker.status().state).toBe("blocked");
    expect(f.worker.status().message).toContain(
      "You moved the mouse or pressed a key",
    );
    expect(f.worker.status().message).toContain("No switch was attempted.");
    expect(f.journal.get("one")?.reason).toBe("desktop_not_ready");
    await f.worker.answer("continue");
    expect(f.hands.sent).toHaveLength(0);
  });
  it("preserves unknown outcome when Stop interrupts dispatch", async () => {
    const f = setup();
    f.hands.answer = (c) => {
      if (c.kind !== "switch_desktop") return undefined;
      f.worker.stop();
      return { ok: false, error: "transition_unknown" };
    };
    await f.worker.submit("one", "Move one desktop left");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("uncertain");
    expect(f.hands.sent).toHaveLength(1);
  });
  it("permits repeated separate verified requests, each with a new observation", async () => {
    const f = setup();
    f.hands.answer = (c) =>
      c.kind === "switch_desktop" ? { observation: after } : undefined;
    for (const id of ["one", "two"]) {
      await f.worker.submit(id, "Move one desktop right");
      await f.worker.idle();
    }
    expect(f.hands.commands.map((c) => c.kind)).toEqual([
      "observe",
      "switch_desktop",
      "observe",
      "switch_desktop",
    ]);
    expect(f.planner.inputs).toHaveLength(0);
  });
  it("does not let disabled desktop switching block subsequent ordinary input", async () => {
    const f = setup();
    f.hands.answer = (c) =>
      c.kind === "switch_desktop"
        ? { ok: false, error: "desktop_disabled" }
        : undefined;
    await f.worker.submit("direction", "Move one desktop right");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("blocked");
    const planner = new ScriptedPlanner([
      { kind: "type", text: "disposable fixture" },
      { kind: "done", summary: "Typed" },
    ]);
    const next = new ComputerWorker({
      hands: f.hands,
      planner,
      journal: f.journal,
    });
    await next.submit("typing", "Type disposable fixture");
    await next.idle();
    expect(f.hands.sent.map((c) => c.kind)).toEqual(["switch_desktop", "type"]);
    expect(next.status().state).toBe("completed");
  });
  it("fences a lost receipt across restart and does not replay the same event", async () => {
    const f = setup();
    f.hands.answer = (c) => (c.kind === "switch_desktop" ? "lost" : undefined);
    await f.worker.submit("one", "Move one desktop right");
    await f.worker.idle();
    const next = new ComputerWorker({
      hands: f.hands,
      planner: f.planner,
      journal: f.journal,
    });
    await next.submit("one", "Move one desktop right");
    await next.idle();
    expect(next.status().state).toBe("uncertain");
    expect(f.hands.sent).toHaveLength(1);
  });
});
