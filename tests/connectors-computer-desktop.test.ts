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
  ] as const)(
    "stops on %s before another plan or input can run",
    async (error) => {
      const f = setup([
        activate,
        activate,
        { kind: "type", text: "should never type" },
      ]);
      f.hands.answer = (c) =>
        c.kind === "open_app" ? { ok: false, error } : undefined;
      await f.worker.submit("blocked", "Show the disposable target");
      await f.worker.idle();
      expect(f.worker.status().state).toBe("blocked");
      expect(f.journal.get("blocked")?.reason).toBe(error);
      expect(f.hands.sent).toEqual([activate]);
      expect(f.planner.inputs).toHaveLength(1);
    },
  );

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
