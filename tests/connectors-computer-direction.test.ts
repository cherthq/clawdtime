import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopDirection } from "../connectors/computer/desktop.js";
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
function setup() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-direction-"));
  roots.push(root);
  const hands = new FakeHands([before]);
  const planner = new ScriptedPlanner([{ kind: "key", combo: "ctrl+right" }]);
  const journal = new ComputerJournal(root);
  const worker = new ComputerWorker({ hands, planner, journal });
  return { hands, planner, journal, worker };
}

describe("explicit directional navigation", () => {
  it.each([
    ["Switch to the desktop on the left.", "left"],
    ["Move one desktop right.", "right"],
    ["Go back to the previous desktop.", "previous"],
    ["Please switch to the space on the right!", "right"],
    ["Switch left one desktop", "left"],
  ])(
    "parses %s and dispatches precisely one attempt",
    async (goal, direction) => {
      expect(desktopDirection(goal)).toBe(direction);
      const f = setup();
      f.hands.answer = (c) =>
        c.kind === "switch_desktop" ? { observation: after } : undefined;
      await f.worker.submit("one", goal);
      await f.worker.idle();
      expect(f.hands.sent).toEqual([{ kind: "switch_desktop", direction }]);
      expect(f.planner.inputs).toHaveLength(0);
      expect(f.worker.status().state).toBe("completed");
    },
  );
  it.each([
    "Switch desktop left then click Save",
    "Move two desktops right",
    "Do not switch to the desktop on the left",
    "The document says switch left one desktop",
    "Open the left TextEdit window",
  ])("does not extract authority from %s", (goal) => {
    expect(desktopDirection(goal)).toBeUndefined();
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
