import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check, retarget } from "../connectors/computer/guards.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { PanelHands } from "../connectors/computer/panel-hands.js";
import {
  handCommandSchema,
  handResultSchema,
  type Action,
  type HandResult,
  type Observation,
} from "../connectors/computer/ports.js";
import {
  cleanTitle,
  sameTitle,
  verifiedActivation,
} from "../connectors/computer/desktop.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const target = observation(
  [element(1, { role: "AXTextField", title: "Fixture" })],
  {
    surfaceEpoch: 2,
    app: {
      name: "TextEdit",
      bundleId: "com.apple.TextEdit",
      window: "Disposable Spaces Fixture",
    },
  },
);
const activate: Action = {
  kind: "open_app",
  name: "com.apple.TextEdit",
  window: target.app.window,
};
const done: Action = { kind: "done", summary: "The fixture is visible." };
function setup(
  script: ConstructorParameters<typeof ScriptedPlanner>[0],
  screens: Observation[] = [target],
) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-desktop-spaces-"));
  roots.push(root);
  const hands = new FakeHands(screens);
  const planner = new ScriptedPlanner(script);
  const journal = new ComputerJournal(root);
  const worker = new ComputerWorker({ hands, planner, journal });
  return { hands, planner, journal, worker };
}

describe("verified desktop activation", () => {
  it("refuses standard Space-navigation chords in code, regardless of planner instructions", () => {
    const view = {
      observation: target,
      fresh: true,
      page: null,
      browser: false,
    };
    for (const combo of [
      "ctrl+left",
      "control+right",
      "ctrl+1",
      "shift+ctrl+2",
    ]) {
      expect(
        check({ kind: "key", combo }, view, "Switch desktop"),
      ).toMatchObject({
        verdict: "refuse",
        reason: expect.stringMatching(/open_app/),
      });
    }
    expect(
      check({ kind: "key", combo: "cmd+s" }, view, "Save fixture").verdict,
    ).toBe("run");
  });
  it("carries exact window selection through the guards and strict wire contract", () => {
    const checked = check(
      activate,
      { observation: target, fresh: true, page: null, browser: false },
      "Show fixture",
    );
    expect(checked).toMatchObject({
      verdict: "run",
      send: { command: activate, look: false },
    });
    expect(handCommandSchema.parse(activate)).toEqual(activate);
    for (const window of ["", " ", "one\ntwo", "x".repeat(201)]) {
      expect(
        check(
          { ...activate, window },
          { observation: target, fresh: true, page: null, browser: false },
          "",
        ).verdict,
      ).toBe("refuse");
    }
    expect(
      handCommandSchema.safeParse({ ...activate, desktop: 3 }).success,
    ).toBe(false);
  });

  it("retires the former screenshot and page, then takes a new full observation before input", async () => {
    const old = observation([], { surfaceEpoch: 1 });
    const f = setup(
      [activate, { kind: "type", text: "fixture" }, done],
      [old, target, target, target],
    );
    f.hands.answer = (command) =>
      command.kind === "open_app" ? { observation: target } : undefined;
    await f.worker.submit(
      "activate",
      "Bring the disposable TextEdit window forward and type fixture",
    );
    await f.worker.idle();
    expect(f.hands.commands.map((c) => c.kind)).toEqual([
      "observe",
      "open_app",
      "observe",
      "observe",
      "type",
      "observe",
    ]);
    expect(f.planner.inputs[1]?.observation).toEqual(target);
    expect(f.planner.inputs[1]?.page).toBeNull();
    expect(f.worker.status().state).toBe("completed");
    const saved = readFileSync(f.journal.file, "utf8");
    expect(saved).not.toContain(target.image);
    expect(saved).not.toContain(target.app.window);
    expect(saved).not.toContain("surfaceEpoch");
  });

  it.each([
    "desktop_disabled",
    "ambiguous_target",
    "unsupported_desktop",
    "target_not_visible",
    "not_found",
    "stale_observation",
    "refused",
  ] as const)(
    "hands %s back to the planner as a refused action, and nothing locks",
    async (error) => {
      const f = setup([activate, done]);
      f.hands.answer = (c) =>
        c.kind === "open_app" ? { ok: false, error } : undefined;
      await f.worker.submit("refused", "Show the disposable target");
      await f.worker.idle();
      // Nothing was sent, so the request went on: the planner read why and chose again.
      expect(f.hands.sent).toEqual([activate]);
      expect(f.planner.inputs).toHaveLength(2);
      expect(f.planner.inputs[1]?.history[0]?.outcome).toMatch(
        /^refused: .*Nothing was (?:opened|activated|sent)\./,
      );
      expect(f.planner.inputs[1]?.observation).toEqual(target);
      expect(f.journal.get("refused")?.steps[0]?.outcome).toBe(error);
      expect(f.worker.status().state).toBe("completed");
      expect(f.journal.unresolved()).toBeNull();
      expect((await f.worker.submit("next", "Another task")).message).toBe("");
    },
  );

  it("tells the planner that no app has the name, so that it can use the name this Mac knows", async () => {
    const chrome = observation([], {
      surfaceEpoch: 5,
      app: {
        name: "Google Chrome",
        bundleId: "com.google.Chrome",
        window: "New Tab",
      },
    });
    const f = setup(
      [
        { kind: "open_app", name: "Chrome" },
        { kind: "open_app", name: "Google Chrome" },
        done,
      ],
      [target, target, chrome],
    );
    f.hands.answer = (c) =>
      c.kind !== "open_app"
        ? undefined
        : c.name === "Chrome"
          ? { ok: false, error: "not_found" }
          : { observation: chrome, resolvedBundleId: "com.google.Chrome" };
    await f.worker.submit("chrome", "Open Chrome and show me the new tab");
    await f.worker.idle();
    expect(f.hands.sent).toEqual([
      { kind: "open_app", name: "Chrome" },
      { kind: "open_app", name: "Google Chrome" },
    ]);
    expect(f.planner.inputs[1]?.history[0]?.outcome).toMatch(
      /^refused: No app with that name was found on this Mac\./,
    );
    expect(f.planner.inputs[2]?.history[1]?.outcome).toBe("ok");
    expect(f.worker.status().state).toBe("completed");
    expect(f.journal.unresolved()).toBeNull();
  });

  it("ends after three refusals in a row with the reason, asks nothing, and does not lock", async () => {
    const f = setup([activate, activate, activate, done]);
    f.hands.answer = (c) =>
      c.kind === "open_app" ? { ok: false, error: "not_found" } : undefined;
    await f.worker.submit("absent", "Show the disposable target");
    await f.worker.idle();
    // The same refused action is no repeat of an action that went out: no
    // "I already did this twice" question stands in the way of the end.
    expect(f.hands.sent).toEqual([activate, activate, activate]);
    expect(f.worker.status()).toMatchObject({
      state: "blocked",
      question: null,
    });
    expect(f.worker.status().message).toMatch(
      /blocked 3 steps in a row.* The last reason: No app with that name was found on this Mac\./,
    );
    expect(f.journal.get("absent")?.reason).toBe("too_many_refusals");
    expect(f.journal.unresolved()).toBeNull();
    expect((await f.worker.submit("next", "Another task")).message).toBe("");
  });

  it("counts a refusal of the hands and a refusal of the checks in one row", async () => {
    const f = setup([
      activate,
      { kind: "open_app", name: "../Fixture" },
      activate,
      done,
    ]);
    f.hands.answer = (c) =>
      c.kind === "open_app"
        ? { ok: false, error: "ambiguous_target" }
        : undefined;
    await f.worker.submit("row", "Show the disposable target");
    await f.worker.idle();
    expect(f.hands.sent).toEqual([activate, activate]);
    expect(f.worker.status().state).toBe("blocked");
    expect(f.journal.get("row")?.reason).toBe("too_many_refusals");
    expect(f.planner.inputs).toHaveLength(3);
  });

  it("starts the row again after an action that ran", async () => {
    const f = setup([
      activate,
      activate,
      { kind: "wait", ms: 0 },
      activate,
      activate,
      done,
    ]);
    f.hands.answer = (c) =>
      c.kind === "open_app" ? { ok: false, error: "not_found" } : undefined;
    await f.worker.submit("reset", "Show the disposable target");
    await f.worker.idle();
    expect(f.hands.sent).toHaveLength(4);
    expect(f.worker.status().state).toBe("completed");
  });

  it.each([
    ["no_accessibility", /Accessibility, and turn on the ClawdTime panel/],
    [
      "no_screen_recording",
      /Screen & System Audio Recording, and turn on the ClawdTime panel/,
    ],
  ] as const)(
    "still ends on %s with the sentence that names the missing right",
    async (error, sentence) => {
      const f = setup([activate, activate, done]);
      f.hands.answer = (c) =>
        c.kind === "open_app" ? { ok: false, error } : undefined;
      await f.worker.submit("right", "Show the disposable target");
      await f.worker.idle();
      expect(f.worker.status().state).toBe("blocked");
      expect(f.worker.status().message).toMatch(sentence);
      expect(f.journal.get("right")?.reason).toBe(error);
      expect(f.hands.sent).toEqual([activate]);
      expect(f.planner.inputs).toHaveLength(1);
      expect(f.journal.unresolved()).toBeNull();
    },
  );

  it("still ends when the person stops it at the hands, and sends nothing more", async () => {
    const f = setup([activate, activate, done]);
    f.hands.answer = (c) =>
      c.kind === "open_app"
        ? { ok: false, error: "stopped_by_person" }
        : undefined;
    await f.worker.submit("stopped", "Show the disposable target");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("canceled");
    expect(f.hands.sent).toEqual([activate]);
    expect(f.planner.inputs).toHaveLength(1);
  });

  it.each([
    { ok: false, error: "transition_unknown" },
    { ok: true },
    { ok: true, observation: { ...target, surfaceEpoch: undefined } },
    { ok: true, observation: { ...target, image: undefined } },
    {
      ok: true,
      observation: {
        ...target,
        app: { ...target.app, window: "Wrong window" },
      },
    },
    {
      ok: true,
      observation: {
        ...target,
        app: { ...target.app, bundleId: "wrong.app", name: "Other" },
      },
    },
  ] satisfies Partial<HandResult>[])(
    "never retries uncertain or unverified activation %#",
    async (result) => {
      const f = setup([activate, activate, done]);
      f.hands.answer = (c) => (c.kind === "open_app" ? result : undefined);
      await f.worker.submit("unknown", "Show fixture");
      await f.worker.idle();
      expect(f.worker.status().state).toBe("uncertain");
      expect(f.journal.unresolved()?.reason).toBe("transition_unknown");
      expect(f.journal.get("unknown")?.steps[0]?.outcome).toBe(
        "transition_unknown",
      );
      expect((await f.worker.submit("another", "Try again")).message).toMatch(
        /unknown/,
      );
      expect(f.hands.sent).toEqual([activate]);
      const restarted = new ComputerWorker({
        hands: f.hands,
        planner: f.planner,
        journal: f.journal,
      });
      expect(restarted.status().state).toBe("uncertain");
    },
  );

  it("preserves an unknown activation even when Stop or takeover arrives while it settles", async () => {
    const f = setup([activate, done]);
    let release!: (value: Partial<HandResult>) => void;
    f.hands.answer = (c) =>
      c.kind === "open_app"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    await f.worker.submit("stop", "Show fixture");
    await until(() => !!release);
    f.worker.stop();
    release({ ok: false, error: "transition_unknown", interrupted: true });
    await f.worker.idle();
    expect(f.worker.status().state).toBe("uncertain");
    expect(f.hands.sent).toEqual([activate]);
    expect(f.journal.unresolved()?.id).toBe("stop");
  });

  it("takes a fresh plan after native stale-input refusal instead of reusing a coordinate", async () => {
    const f = setup([{ kind: "click_at", x: 30, y: 30 }, done]);
    f.hands.answer = (c) =>
      c.kind === "click"
        ? { ok: false, error: "stale_observation" }
        : undefined;
    await f.worker.submit("stale", "Inspect the fixture");
    await f.worker.idle();
    expect(f.hands.commands.map((c) => c.kind)).toEqual([
      "observe",
      "observe",
      "click",
      "observe",
    ]);
    expect(f.planner.inputs[1]?.history[0]?.outcome).toMatch(
      /stale_observation/,
    );
  });

  it("keeps unknown outcomes intact through the real panel mailbox", async () => {
    const hands = new PanelHands({ first: 1 });
    const pending = hands.run(activate, "Switching to target");
    const command = hands.next(0)!;
    expect(command.command).toEqual(activate);
    expect(hands.withdraw()).toBe(false);
    const result = handResultSchema.parse({
      seq: 1,
      ok: false,
      error: "transition_unknown",
      interrupted: true,
    });
    expect(hands.result(result)).toBe(true);
    expect(await pending).toEqual(result);
    expect(hands.next(0)).toBeNull();
    expect(hands.result(result)).toBe(false);
  });

  it("does not retry partially dispatched input after takeover or a surface change", async () => {
    const f = setup([
      { kind: "type", text: "fixture" },
      { kind: "type", text: "fixture" },
      done,
    ]);
    f.hands.answer = (c) =>
      c.kind === "type"
        ? { ok: false, error: "input_unknown", interrupted: true }
        : undefined;
    await f.worker.submit("partial", "Type in disposable fixture");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("uncertain");
    expect(f.worker.status().message).toMatch(/Some input may have reached/);
    expect(f.journal.unresolved()?.reason).toBe("input_unknown");
    expect(f.hands.sent).toEqual([{ kind: "type", text: "fixture" }]);
    expect(f.journal.get("partial")?.steps[0]?.outcome).toBe("input_unknown");
  });
});

describe("one definition of arrived", () => {
  // The name that a person says, the name that the app gives itself, and its
  // bundle identifier. `mac/Tests/TaskPanelCoreTests/DesktopArrivalTests.swift`
  // shows that the hands find each app by the name that is said here.
  const apps = [
    ["iTerm", "iTerm2", "com.googlecode.iterm2"],
    ["Visual Studio Code", "Code", "com.microsoft.VSCode"],
    ["Safari.app", "Safari", "com.apple.Safari"],
  ] as const;
  const front = (name: string, bundleId: string, window = "Window") =>
    observation([], { surfaceEpoch: 4, app: { name, bundleId, window } });

  it.each(apps)(
    'accepts "%s" when the app that the hands found is in front',
    async (said, name, bundleId) => {
      const open: Action = { kind: "open_app", name: said };
      const f = setup([open, done], [observation([], { surfaceEpoch: 1 })]);
      f.hands.answer = (c) =>
        c.kind === "open_app"
          ? { observation: front(name, bundleId), resolvedBundleId: bundleId }
          : undefined;
      await f.worker.submit("named", `Open ${said}`);
      await f.worker.idle();
      expect(f.hands.sent).toEqual([open]);
      expect(f.worker.status().state).toBe("completed");
      expect(f.journal.unresolved()).toBeNull();
      expect(f.planner.inputs[1]?.history[0]?.outcome).toBe("ok");
    },
  );

  it.each(apps)(
    'does not accept "%s" when another app is in front',
    async (said, _name, bundleId) => {
      const open: Action = { kind: "open_app", name: said };
      const f = setup([open, done], [observation([], { surfaceEpoch: 1 })]);
      f.hands.answer = (c) =>
        c.kind === "open_app"
          ? {
              observation: front("Finder", "com.apple.finder"),
              resolvedBundleId: bundleId,
            }
          : undefined;
      await f.worker.submit("other", `Open ${said}`);
      await f.worker.idle();
      expect(f.worker.status().state).toBe("uncertain");
      expect(f.journal.unresolved()?.reason).toBe("transition_unknown");
      expect(f.hands.sent).toEqual([open]);
    },
  );

  it("accepts an app in front that shows only a sheet or no window yet, and never another app with its sheet", async () => {
    // The hands verified the process in front. A sheet or a window that is
    // still opening has no title: a request that names no window needs none.
    const open: Action = { kind: "open_app", name: "Stonepad" };
    const sheetOnly = (name: string, bundleId: string) =>
      observation([element(1, { role: "AXSheet", title: "Syncing notes" })], {
        surfaceEpoch: 4,
        app: { name, bundleId, window: "" },
      });
    const accepted = setup(
      [open, done],
      [observation([], { surfaceEpoch: 1 })],
    );
    accepted.hands.answer = (c) =>
      c.kind === "open_app"
        ? {
            observation: sheetOnly("Stonepad", "com.example.stonepad"),
            resolvedBundleId: "com.example.stonepad",
          }
        : undefined;
    await accepted.worker.submit("sheet", "Open Stonepad");
    await accepted.worker.idle();
    expect(accepted.worker.status().state).toBe("completed");
    expect(accepted.journal.unresolved()).toBeNull();
    const wrong = setup([open, done], [observation([], { surfaceEpoch: 1 })]);
    wrong.hands.answer = (c) =>
      c.kind === "open_app"
        ? {
            observation: sheetOnly("Riverchat", "com.example.riverchat"),
            resolvedBundleId: "com.example.stonepad",
          }
        : undefined;
    await wrong.worker.submit("wrong", "Open Stonepad");
    await wrong.worker.idle();
    expect(wrong.worker.status().state).toBe("uncertain");
    expect(wrong.journal.unresolved()?.reason).toBe("transition_unknown");
    expect(wrong.hands.sent).toEqual([open]);
  });

  it("compares the app in front with the app that was found, not with the name", () => {
    const open = { kind: "open_app", name: "iTerm" } as const;
    const seen = front("iTerm2", "com.googlecode.iterm2");
    const result = (values: Partial<HandResult>): HandResult => ({
      seq: 1,
      ok: true,
      observation: seen,
      ...values,
    });
    expect(
      verifiedActivation(
        open,
        result({ resolvedBundleId: "com.googlecode.iterm2" }),
      ),
    ).toBe(true);
    expect(
      verifiedActivation(
        open,
        result({ resolvedBundleId: "COM.GoogleCode.iTerm2" }),
      ),
    ).toBe(true);
    for (const resolvedBundleId of ["com.apple.Terminal", "", " "])
      expect(verifiedActivation(open, result({ resolvedBundleId }))).toBe(
        false,
      );
    // A panel that does not say which app it found is judged by the name.
    expect(verifiedActivation(open, result({}))).toBe(false);
    expect(
      verifiedActivation({ kind: "open_app", name: "iTerm2" }, result({})),
    ).toBe(true);
    // The picture and the surface generation are needed in every case.
    expect(
      verifiedActivation(
        open,
        result({
          resolvedBundleId: "com.googlecode.iterm2",
          observation: { ...seen, image: undefined },
        }),
      ),
    ).toBe(false);
    expect(
      handResultSchema.safeParse({
        seq: 1,
        ok: true,
        resolvedBundleId: "a".repeat(201),
      }).success,
    ).toBe(false);
  });

  const titles = [
    ["Budget\u00a02026", "Budget 2026"],
    ["Notes\u200e \u2014 Draft", "Notes \u2014 Draft"],
    ["  padded\ttitle\u2028here ", "padded title here"],
    ["Cafe\u0301 menu", "Cafe\u0301 menu"],
    ["a".repeat(250), `${"a".repeat(199)}\u2026`],
    [`${"a".repeat(198)} bcd`, `${"a".repeat(198)}\u2026`],
  ] as const;
  it.each(titles)(
    "cleans a window title as the observation does %#",
    (asked, cleaned) => {
      // The same pairs are in the panel's test of `ElementCleaner.line`.
      expect(cleanTitle(asked)).toBe(cleaned);
      expect(cleanTitle(cleaned)).toBe(cleaned);
      expect(sameTitle(asked, cleaned)).toBe(true);
    },
  );
  it("keeps titles apart that differ in more than their spaces", () => {
    expect(sameTitle("Budget 2026", "Budget 2027")).toBe(false);
    expect(sameTitle("Budget 2026", "budget 2026")).toBe(false);
    expect(sameTitle("Budget2026", "Budget 2026")).toBe(false);
  });
  it("takes the same letters stored in two ways as one title, as the panel does", () => {
    expect(sameTitle("R\u00e9sum\u00e9.pdf", "Re\u0301sume\u0301.pdf")).toBe(
      true,
    );
    const open = {
      kind: "open_app",
      name: "Preview",
      window: "R\u00e9sum\u00e9.pdf",
    } as const;
    expect(
      verifiedActivation(open, {
        seq: 1,
        ok: true,
        observation: front(
          "Preview",
          "com.apple.Preview",
          "Re\u0301sume\u0301.pdf",
        ),
        resolvedBundleId: "com.apple.Preview",
      }),
    ).toBe(true);
  });
  it("never takes a title that cleans to nothing for an untitled window", () => {
    for (const nothing of ["", " ", "\u200b", "\u200b\u00a0\ufeff"]) {
      expect(sameTitle(nothing, "")).toBe(false);
      expect(sameTitle("", nothing)).toBe(false);
      expect(
        verifiedActivation(
          { kind: "open_app", name: "TextEdit", window: nothing },
          {
            seq: 1,
            ok: true,
            observation: front("TextEdit", "com.apple.TextEdit", ""),
            resolvedBundleId: "com.apple.TextEdit",
          },
        ),
      ).toBe(false);
    }
  });

  it("accepts a window title with a no-break space that the observation shows with a plain space", async () => {
    const open: Action = {
      kind: "open_app",
      name: "com.apple.TextEdit",
      window: "Budget\u00a02026",
    };
    const f = setup([open, done], [observation([], { surfaceEpoch: 1 })]);
    f.hands.answer = (c) =>
      c.kind === "open_app"
        ? {
            observation: front("TextEdit", "com.apple.TextEdit", "Budget 2026"),
            resolvedBundleId: "com.apple.TextEdit",
          }
        : undefined;
    await f.worker.submit("title", "Show the budget window");
    await f.worker.idle();
    expect(f.hands.sent).toEqual([open]);
    expect(f.worker.status().state).toBe("completed");
    expect(f.journal.unresolved()).toBeNull();
  });

  it("does not accept another window of the right app when a title was asked for", async () => {
    const open: Action = {
      kind: "open_app",
      name: "TextEdit",
      window: "Budget 2026",
    };
    const f = setup([open, done], [observation([], { surfaceEpoch: 1 })]);
    f.hands.answer = (c) =>
      c.kind === "open_app"
        ? {
            observation: front("TextEdit", "com.apple.TextEdit", "Budget 2027"),
            resolvedBundleId: "com.apple.TextEdit",
          }
        : undefined;
    await f.worker.submit("sibling", "Show the budget window");
    await f.worker.idle();
    expect(f.worker.status().state).toBe("uncertain");
    expect(f.hands.sent).toEqual([open]);
  });
});

describe("desktop coordinate retirement", () => {
  const before = observation([], { surfaceEpoch: 3 });
  it.each([
    { surfaceEpoch: 4 },
    { surfaceEpoch: undefined },
    { screen: { ...before.screen, scale: 1 } },
    { screen: { ...before.screen, width: 1600 } },
  ])(
    "refuses old-frame actions despite unchanged app/window titles %#",
    (change) => {
      const after = { ...before, ...change };
      for (const action of [
        { kind: "click_at", x: 30, y: 30 },
        { kind: "type", text: "fixture" },
        { kind: "key", combo: "tab" },
      ] satisfies Action[]) {
        expect(retarget(action, before, after)).toMatchObject({
          ok: false,
          reason: expect.stringMatching(/retired/),
        });
      }
    },
  );

  it("does not send an old-frame click after a Space round trip with identical labels", async () => {
    const after = { ...before, surfaceEpoch: 5 };
    const f = setup(
      [{ kind: "click_at", x: 30, y: 30 }, done],
      [before, after, after],
    );
    await f.worker.submit("roundtrip", "Inspect fixture");
    await f.worker.idle();
    expect(f.hands.sent).toEqual([]);
    expect(f.planner.inputs[1]?.history[0]?.outcome).toMatch(/retired/);
  });

  it("does not type after the focus click if the Space changes before the focused-field observation", async () => {
    const after = { ...target, surfaceEpoch: target.surfaceEpoch! + 1 };
    const f = setup(
      [{ kind: "type", text: "fixture", element: 1 }, done],
      [target, target, after, after],
    );
    await f.worker.submit("focus", "Type in fixture");
    await f.worker.idle();
    expect(f.hands.sent.map((c) => c.kind)).toEqual(["click"]);
    expect(f.planner.inputs[1]?.history[0]?.outcome).toMatch(
      /not typed: the screen changed/,
    );
  });
});
