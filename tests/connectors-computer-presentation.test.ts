import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PresentationEvents,
  presentationEventSchema,
} from "../connectors/computer/presentation.js";
import { PanelHands } from "../connectors/computer/panel-hands.js";
import {
  computerPort,
  offComputerPort,
} from "../connectors/computer/service.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { ScriptedPlanner, until } from "./connectors-computer-fixture.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskService } from "../src/control/task-service.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import { DomainError } from "../src/storage/security.js";

function event(at = 10_000) {
  return {
    version: 1,
    producerId: "fixture-panel",
    sequence: 1,
    commandSeq: 41,
    at,
    expiresAt: at + 1500,
    kind: "target",
    reducedMotion: false,
    surface: {
      displayId: "1",
      width: 1440,
      height: 900,
      scale: 2,
      appId: "fixture.app",
      windowId: "12",
      window: { x: 10, y: 20, w: 1000, h: 800 },
    },
    target: { x: 100, y: 100, w: 40, h: 25 },
  };
}

describe("native presentation boundary", () => {
  it("accepts the same synthetic v1 wire fixture encoded by Swift and consumed by the line", () => {
    const wire = JSON.parse(
      readFileSync(
        new URL("./fixtures/call-presentation-v1.json", import.meta.url),
        "utf8",
      ),
    );
    expect(presentationEventSchema.parse(wire)).toEqual(wire);
  });
  it("the real worker's Stop retires video immediately while an already served action awaits its receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawdtime-presentation-stop-"));
    const hands = new PanelHands({ first: 41, timeoutMs: 5000 });
    const worker = new ComputerWorker({
      hands,
      planner: new ScriptedPlanner([
        { kind: "done", summary: "Fixture finished." },
      ]),
      journal: new ComputerJournal(root),
    });
    const port = computerPort(worker, hands);
    const desktop = {
      authorizePanel(value: string) {
        if (value !== "p".repeat(40)) throw new DomainError(401, "Denied.");
      },
    } as TaskDesktopService;
    const app = createTaskApp(
      {} as TaskService,
      "o".repeat(40),
      undefined,
      undefined,
      undefined,
      undefined,
      desktop,
      undefined,
      undefined,
      undefined,
      port,
    );
    const request = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${"p".repeat(40)}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      await worker.submit(
        "presentation-fixture",
        "Inspect the disposable fixture.",
      );
      await until(() => hands.next(0) !== null);
      const wire = event(Date.now());
      expect(
        await (await request("/desktop/hands/presentation", wire)).json(),
      ).toEqual({ ok: true });
      await request("/desktop/execution/stop", {});
      expect(worker.run()).toMatchObject({ active: true, state: "stopping" });
      expect(await (await request("/desktop/presentation")).json()).toEqual({
        version: 1,
        event: null,
      });
      expect(
        await (
          await request("/desktop/hands/presentation", { ...wire, sequence: 2 })
        ).json(),
      ).toEqual({ ok: false });
      // The exact original receipt is still awaited. Presentation did not retract or replay it.
      expect(
        await (
          await request("/desktop/hands/result", { seq: 41, ok: true })
        ).json(),
      ).toEqual({ ok: true });
      await until(() => !worker.run().active);
      expect(hands.next(41)).toBeNull();
      expect(await (await request("/desktop/presentation")).json()).toEqual({
        version: 1,
        event: null,
      });
    } finally {
      worker.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("admits only bounded metadata and leaves input geometry unchanged", () => {
    const wire = event();
    const parsed = presentationEventSchema.parse(wire);
    expect(parsed.target).toEqual(wire.target);
    expect(parsed.surface?.scale).toBe(2);
    for (const change of [
      { text: "not metadata" },
      { screenshot: "not metadata" },
      { expiresAt: wire.at + 2001 },
      { expiresAt: wire.at },
      { target: { x: 1439, y: 0, w: 2, h: 2 } },
      { target: { x: NaN, y: 0, w: 2, h: 2 } },
      { target: { x: -1, y: 0, w: 2, h: 2 } },
      { surface: { ...wire.surface, window: { x: 0, y: 0, w: 1441, h: 10 } } },
      { surface: { ...wire.surface, title: "private" } },
      { kind: "context" },
      { kind: "transition" },
    ])
      expect(
        presentationEventSchema.safeParse({ ...wire, ...change }).success,
      ).toBe(false);
  });

  it("binds to served commands, rejects replay and expiry, and keeps only the newest event", () => {
    let now = 10_000;
    const broker = new PresentationEvents(() => now);
    const first = event();
    expect(broker.accept(first, 40, true)).toBe(false);
    expect(broker.accept(first, 41, false)).toBe(false);
    expect(broker.accept(first, 41, true)).toBe(true);
    expect(broker.accept(first, 41, true)).toBe(false);
    expect(
      broker.accept({ ...first, producerId: "older-panel" }, 41, true),
    ).toBe(false);
    expect(
      broker.accept(
        { ...first, at: now + 101, expiresAt: now + 1000, sequence: 2 },
        41,
        true,
      ),
    ).toBe(false);
    expect(broker.latest(true)).toEqual(first);
    now += 1500;
    expect(broker.latest(true)).toBeNull();
    expect(broker.accept(first, 41, true)).toBe(false);
    expect(broker.accept({ ...event(now), sequence: 2 }, 41, true)).toBe(true);
    broker.clear();
    expect(broker.accept({ ...event(now), sequence: 2 }, 41, true)).toBe(false);
    const reset = {
      version: 1,
      producerId: "fixture-panel",
      sequence: 3,
      commandSeq: 41,
      at: now,
      expiresAt: now + 1000,
      kind: "reset",
      reducedMotion: false,
    };
    expect(broker.accept(reset, 41, true)).toBe(true);
    expect(broker.latest(true)).toBeNull();
    expect(
      broker.accept(
        { ...event(now), producerId: "new-panel", commandSeq: 42 },
        42,
        true,
      ),
    ).toBe(true);
    expect(broker.latest(false)).toBeNull();
  });

  it("does not grant presentation identity before delivery or after takeover, timeout, or Stop", async () => {
    const hands = new PanelHands({ first: 41, timeoutMs: 10 });
    const pending = hands.run(
      { kind: "click", x: 100, y: 100, count: 1, button: "left" },
      "Click",
    );
    expect(hands.presentationCommand()).toBe(0);
    hands.next(0);
    expect(hands.presentationCommand()).toBe(41);
    hands.result({ seq: 41, ok: true, interrupted: true });
    await pending;
    expect(hands.presentationCommand()).toBe(0);
    const timed = hands.run({ kind: "wait", ms: 0 }, "Wait").catch(() => {});
    hands.next(41);
    await timed;
    expect(hands.presentationCommand()).toBe(0);
    const stopped = hands.run({ kind: "wait", ms: 0 }, "Wait");
    hands.next(42);
    hands.withdraw();
    expect(hands.presentationCommand()).toBe(0);
    hands.result({ seq: 43, ok: true });
    await stopped;
  });

  it("authenticates reads/writes and retires the picture on Stop without changing action receipts", async () => {
    const hands = new PanelHands({ first: 41 });
    let state = "running";
    let enabled = true;
    const worker = {
      status: () => ({ enabled, state }),
      stop: () => {
        state = "stopping";
        return {};
      },
    } as unknown as ComputerWorker;
    const port = computerPort(worker, hands);
    const desktop = {
      authorizePanel(token: string) {
        if (token !== "p".repeat(40)) throw new DomainError(401, "Denied.");
      },
    } as TaskDesktopService;
    const app = createTaskApp(
      {} as TaskService,
      "o".repeat(40),
      undefined,
      undefined,
      undefined,
      undefined,
      desktop,
      undefined,
      undefined,
      undefined,
      port,
    );
    const request = (path: string, body?: unknown, token = "p".repeat(40)) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const wire = event(Date.now());
    expect(
      (await request("/desktop/presentation", undefined, "wrong")).status,
    ).toBe(401);
    expect(
      (await request("/desktop/hands/presentation", wire, "wrong")).status,
    ).toBe(401);
    expect(
      await (await request("/desktop/hands/presentation", wire)).json(),
    ).toEqual({ ok: false });
    const pending = hands.run({ kind: "wait", ms: 0 }, "Wait");
    hands.next(0);
    expect(
      await (await request("/desktop/hands/presentation", wire)).json(),
    ).toEqual({ ok: true });
    expect(await (await request("/desktop/presentation")).json()).toEqual({
      version: 1,
      event: wire,
    });
    expect(
      (
        await request("/desktop/hands/presentation", {
          ...wire,
          text: "private",
        })
      ).status,
    ).toBe(400);
    enabled = false;
    expect(await (await request("/desktop/presentation")).json()).toEqual({
      version: 1,
      event: null,
    });
    enabled = true;
    expect(
      await (
        await request("/desktop/hands/presentation", { ...wire, sequence: 2 })
      ).json(),
    ).toEqual({ ok: true });
    await request("/desktop/execution/stop", {});
    expect(await (await request("/desktop/presentation")).json()).toEqual({
      version: 1,
      event: null,
    });
    expect(
      await (
        await request("/desktop/hands/presentation", { ...wire, sequence: 3 })
      ).json(),
    ).toEqual({ ok: false });
    expect(hands.result({ seq: 41, ok: true })).toBe(true);
    expect(await pending).toEqual({ seq: 41, ok: true });
    expect(offComputerPort("Disabled").presentation()).toEqual({
      version: 1,
      event: null,
    });
  });
});
