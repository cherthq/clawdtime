import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import {
  HumanRouter,
  type SingleActionPlanner,
} from "../src/control/human-router.js";
import {
  ControlPreflightError,
  sanitizeControlPreflightDiagnostics,
  type ControlPreflightDiagnostics,
  type ControlPreflightCode,
} from "../src/control/errors.js";
import { Viewing } from "../src/control/viewing.js";
import { createApp } from "../src/app.js";
import type { ActionReceipt, ControlLease } from "../src/contracts.js";

async function fixture(planner?: SingleActionPlanner) {
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport()),
    device = new SimulatedDevice(),
    control = new ControlCoordinator(store, device),
    human = new HumanRouter(service, control, planner),
    viewing = new Viewing(store, device);
  const binding = {
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: "line",
    deviceId: "mac",
    displayId: "1",
  };
  const invite = service.createPairingInvite(binding),
    paired = service.claimPairing({
      token: invite.token,
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl: true,
    });
  const agent = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "one",
    hostId: "host.local",
    capabilities: { cooperativePause: true, polling: true },
  });
  service.yieldSession(agent.token);
  const request = service.requestAttention(agent.token, {
    taskId: "task",
    idempotencyKey: "one",
    reason: "decision",
    question: "fixture",
  });
  await service.drain();
  service.observeCall(request.id, "connected", true);
  const send = (eventId: string, text: string) =>
    human.receive({
      eventId,
      text,
      requestId: request.id,
      memberId: binding.memberId,
      lineId: binding.lineId,
      conversationId: binding.conversationId,
      channel: "text",
    }) as Promise<any>;
  const command = (id: string) => store.state<any>(`human-command:${id}`);
  return {
    store,
    service,
    device,
    control,
    human,
    viewing,
    agent,
    request,
    binding,
    send,
    command,
  };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const codes: ControlPreflightCode[] = [
  "planning_refused",
  "planner_unavailable",
  "planning_timeout",
  "frame_unavailable",
  "screen_changed",
  "invalid_plan",
  "context_expired",
];

describe("known CUA preflight failures and focus safety", () => {
  it("retains only whitelisted diagnostics on a proven pre-input failure", async () => {
    const dirty = {
      phase: "planning",
      elapsedMs: 1200,
      frameAgeMs: 50,
      prompt: "PRIVATE_PROMPT",
      url: "https://private.invalid",
      pixels: "PRIVATE_PIXELS",
      comparison: {
        kind: "pixels_changed",
        changedPixels: 7,
        changedTiles: [0, 4, 11],
        width: 640,
        height: 360,
        jpegBase64: "PRIVATE_JPEG",
        error: "PRIVATE_PROVIDER_ERROR",
      },
    };
    const error = new ControlPreflightError(
      "screen_changed",
      dirty as ControlPreflightDiagnostics,
    );
    dirty.comparison.changedTiles.push(9);
    Object.assign(error.diagnostics!, {
      rawError: "PRIVATE_ERROR_AFTER_CONSTRUCTION",
    });
    Object.assign(error.diagnostics!.comparison!, {
      image: "PRIVATE_IMAGE_AFTER_CONSTRUCTION",
    });
    const f = await fixture({
      plan: async () => {
        throw error;
      },
    });
    await f.viewing.tick();
    const result = await f.send("diagnostics", "do: focus textbox");
    const expected = {
      phase: "planning",
      elapsedMs: 1200,
      frameAgeMs: 50,
      comparison: {
        kind: "pixels_changed",
        changedPixels: 7,
        changedTiles: [0, 4, 11],
        width: 640,
        height: 360,
      },
    };
    expect(result).toMatchObject({
      state: "not_started",
      diagnostics: expected,
    });
    expect(result.diagnostics).toEqual(expected);
    expect(f.command("diagnostics").result.diagnostics).toEqual(expected);
    const app = createApp(f.service, f.control, f.human, {
      origin: "http://127.0.0.1:3310",
      simulation: true,
    });
    const authorized = await app.request(
      `/api/attention/${f.request.id}/diagnostics`,
      {
        headers: { authorization: `Bearer ${f.agent.token}` },
      },
    );
    expect((await authorized.json()).controlPreflight).toEqual({
      actionId: result.actionId,
      code: "screen_changed",
      diagnostics: expected,
    });
    const unauthorized = await app.request(
      `/api/attention/${f.request.id}/diagnostics`,
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toContain("changedTiles");
    expect(
      JSON.stringify(f.store.query("SELECT body FROM operational_state")),
    ).not.toContain("PRIVATE_");
    expect(await f.send("diagnostics", "do: focus textbox")).toEqual(result);
    expect(f.device.inputs).toHaveLength(0);
    f.store.close();
  });

  it.each([
    { phase: "other" },
    { elapsedMs: -1 },
    { elapsedMs: 60_001 },
    { elapsedMs: Infinity },
    { frameAgeMs: -501 },
    { frameAgeMs: 60_001 },
    { frameAgeMs: NaN },
    { comparison: { kind: "raw_error" } },
    { comparison: { kind: "pixels_changed", changedPixels: 921601 } },
    { comparison: { kind: "pixels_changed", changedPixels: -1 } },
    { comparison: { kind: "pixels_changed", changedPixels: 1.5 } },
    { comparison: { kind: "pixels_changed", changedTiles: [12] } },
    { comparison: { kind: "pixels_changed", changedTiles: [-1] } },
    { comparison: { kind: "pixels_changed", changedTiles: [1, 1] } },
    { comparison: { kind: "pixels_changed", changedTiles: Array(13).fill(1) } },
    { comparison: { kind: "geometry_changed", width: 1281, height: 720 } },
    { comparison: { kind: "geometry_changed", width: 1280, height: 721 } },
    { comparison: { kind: "geometry_changed", width: 0, height: 720 } },
    {
      comparison: {
        kind: "pixels_changed",
        width: 10,
        height: 10,
        changedPixels: 101,
      },
    },
  ])(
    "drops invalid diagnostic fields %# without exposing their contents",
    (invalid) => {
      const error = new ControlPreflightError("screen_changed", {
        phase: "settling",
        elapsedMs: 0,
        frameAgeMs: 0,
        ...invalid,
      } as ControlPreflightDiagnostics);
      expect(error.diagnostics).toBeUndefined();
      expect(error.code).toBe("screen_changed");
      expect(error.message).toBe("The screen changed while planning.");
    },
  );

  it("keeps fixed metadata bounds and safely discards throwing getters", () => {
    expect(
      sanitizeControlPreflightDiagnostics({
        phase: "settling",
        elapsedMs: 60_000,
        frameAgeMs: -500,
        comparison: {
          kind: "pixels_changed",
          width: 1280,
          height: 720,
          changedPixels: 921600,
          changedTiles: Array.from({ length: 12 }, (_, i) => i),
        },
      }),
    ).toBeDefined();
    expect(
      sanitizeControlPreflightDiagnostics({
        get phase() {
          throw new Error("PRIVATE_GETTER");
        },
      }),
    ).toBeUndefined();
  });

  it("never persists planning diagnostics as proof after an input dispatch", async () => {
    const f = await fixture();
    f.device.action = async () => {
      throw new ControlPreflightError("screen_changed", {
        phase: "planning",
        elapsedMs: 100,
        frameAgeMs: 0,
        comparison: { kind: "identical" },
      });
    };
    await expect(
      f.send("dispatch-diagnostics", "click 0.5 0.5"),
    ).rejects.toThrow("uncertain");
    expect(f.command("dispatch-diagnostics").result.state).toBe("unknown");
    expect(f.command("dispatch-diagnostics").result).not.toHaveProperty(
      "diagnostics",
    );
    f.store.close();
  });

  it.each(codes)(
    "settles %s with no input, confirmed release and view restoration; duplicate never replans",
    async (code) => {
      let plans = 0;
      const f = await fixture({
        plan: async () => {
          plans++;
          throw new ControlPreflightError(code);
        },
      });
      await f.viewing.tick();
      const result = await f.send("plan", "do: focus the intended textbox");
      expect(result).toMatchObject({
        accepted: false,
        state: "not_started",
        code,
      });
      expect(result.clarification).toContain("No input was sent.");
      expect(result.clarification).toContain("visually verify");
      expect(f.store.all("action")).toHaveLength(0);
      expect(f.device.inputs).toHaveLength(0);
      expect(
        f.store.all<ControlLease>("lease").every((l) => l.state === "released"),
      ).toBe(true);
      expect(f.command("plan")).toMatchObject({
        phase: "not_started",
        actionId: `input_${createHash("sha256").update("plan").digest("hex").slice(0, 40)}`,
      });
      expect(await f.send("plan", "do: focus the intended textbox")).toEqual(
        result,
      );
      expect(plans).toBe(1);
      await f.viewing.tick();
      expect([...f.device.leases.values()].map((l) => l.mode)).toEqual([
        "view",
      ]);
      f.store.close();
    },
  );
  it("blocks typing after failed planning until a separate explicit observed click, without claiming focus success", async () => {
    const f = await fixture({
      plan: async () => {
        throw new ControlPreflightError("planner_unavailable");
      },
    });
    await f.viewing.tick();
    await f.send("plan", "do: focus intended textbox");
    await f.viewing.tick();
    const blocked = await f.send("typing", "type: private text");
    expect(blocked.state).toBe("not_started");
    expect(blocked.clarification).toContain("explicit click");
    expect(f.device.inputs).toHaveLength(0);
    const clicked = await f.send("click", "click 0.5 0.5");
    expect(clicked.receipt.state).toBe("observed");
    expect(clicked.note).toContain("does not prove");
    expect(f.device.inputs).toHaveLength(1);
    expect((await f.send("new-type", "type: private text")).receipt.state).toBe(
      "observed",
    );
    expect(f.device.inputs).toHaveLength(2);
    expect(await f.send("typing", "type: private text")).toEqual(blocked);
    expect(f.device.inputs).toHaveLength(2);
    expect(
      JSON.stringify(f.store.query("SELECT body FROM operational_state")),
    ).not.toContain("private text");
    f.store.close();
  });
  it("does not substitute an AI typing plan for the required explicit click", async () => {
    let calls = 0;
    const f = await fixture({
      plan: async () => {
        if (++calls === 1) throw new ControlPreflightError("planning_refused");
        return {
          action: { kind: "type", text: "unintended" },
          frame: {
            id: "fresh",
            capturedAt: Date.now(),
            width: 100,
            height: 100,
          },
        };
      },
    });
    await f.send("failed", "do: focus textbox");
    expect((await f.send("ai-type", "do: type now")).state).toBe("not_started");
    expect(f.device.inputs).toHaveLength(0);
    f.store.close();
  });
  it.each([false, true])(
    "a separately requested planned click clears focus only after observed input and release (uncertain=%s)",
    async (uncertain) => {
      let plans = 0;
      const f = await fixture({
        plan: async () => {
          if (++plans === 1) throw new ControlPreflightError("screen_changed");
          return {
            action: { kind: "click", x: 0.5, y: 0.5 },
            frame: {
              id: "fresh",
              capturedAt: Date.now(),
              width: 100,
              height: 100,
            },
          };
        },
      });
      await f.send("failed", "do: focus textbox");
      const focusKey = `focus-unverified:${createHash("sha256")
        .update(JSON.stringify(["mac", "1"]))
        .digest("hex")}`;
      if (uncertain)
        f.device.action = async () => {
          throw new Error("Input outcome unknown");
        };
      if (uncertain) {
        await expect(
          f.send("new-click", "do: click the textbox"),
        ).rejects.toThrow("uncertain");
        expect(f.store.state(focusKey)).toBe(true);
        expect((await f.send("type", "type: fixture")).state).toBe(
          "not_started",
        );
      } else {
        expect(
          (await f.send("new-click", "do: click the textbox")).receipt.state,
        ).toBe("observed");
        expect(f.store.state(focusKey)).toBe(false);
        expect((await f.send("type", "type: fixture")).receipt.state).toBe(
          "observed",
        );
        expect(f.device.inputs).toHaveLength(2);
      }
      f.store.close();
    },
  );
  it("does not create viewing consent when no view was previously active", async () => {
    const f = await fixture({
      plan: async () => {
        throw new ControlPreflightError("planning_timeout");
      },
    });
    expect((await f.send("plan", "do: focus textbox")).state).toBe(
      "not_started",
    );
    expect(f.store.state(`view-restore:${f.request.id}`)).toBeUndefined();
    await f.viewing.tick();
    expect(f.device.leases.size).toBe(0);
    f.store.close();
  });
  it("keeps uncertain old-view release unknown without input or rearm", async () => {
    const f = await fixture({
      plan: async () => {
        throw new Error("must not plan");
      },
    });
    await f.viewing.tick();
    let releases = 0;
    f.device.release = async () => {
      releases++;
      throw new Error("PRIVATE_HELPER_ERROR");
    };
    await expect(f.send("plan", "do: focus textbox")).rejects.toThrow(
      "uncertain",
    );
    expect(f.command("plan").result.state).toBe("unknown");
    expect(f.store.all("action")).toHaveLength(0);
    expect(f.store.state(`view-restore:${f.request.id}`)).not.toBe(true);
    await f.send("plan", "do: focus textbox");
    expect(releases).toBe(1);
    expect(JSON.stringify(f.command("plan"))).not.toContain(
      "PRIVATE_HELPER_ERROR",
    );
    f.store.close();
  });
  it("does not settle no-input or restore viewing if control release is uncertain", async () => {
    const f = await fixture({
      plan: async () => {
        throw new ControlPreflightError("screen_changed");
      },
    });
    await f.viewing.tick();
    const release = f.device.release.bind(f.device);
    f.device.release = async (l) => {
      if (l.mode === "control") throw new Error("lost release");
      await release(l);
    };
    await expect(f.send("plan", "do: focus textbox")).rejects.toThrow(
      "uncertain",
    );
    expect(f.command("plan").result).toMatchObject({
      state: "unknown",
      cleanup: "unknown",
    });
    expect(
      f.store
        .all<ControlLease>("lease")
        .some((l) => l.mode === "control" && l.state === "unknown"),
    ).toBe(true);
    expect(f.store.all("action")).toHaveLength(0);
    expect(f.store.state(`view-restore:${f.request.id}`)).not.toBe(true);
    f.store.close();
  });
  it("honors Stop while releasing the old view, before a control lease exists", async () => {
    const f = await fixture(),
      began = barrier(),
      finish = barrier();
    await f.viewing.tick();
    const release = f.device.release.bind(f.device);
    let first = true;
    f.device.release = async (l) => {
      if (first) {
        first = false;
        began.resolve();
        await finish.promise;
      }
      await release(l);
    };
    const input = f.send("click", "click 0.5 0.5");
    await began.promise;
    await f.send("stop", "stop");
    finish.resolve();
    expect(await input).toMatchObject({
      state: "not_started",
      code: "stopped",
    });
    expect(
      f.store.all<ControlLease>("lease").filter((l) => l.mode === "control"),
    ).toHaveLength(0);
    expect(f.device.inputs).toHaveLength(0);
    await f.viewing.tick();
    expect(f.device.leases.size).toBe(0);
    expect((await f.send("after-stop", "click 0.5 0.5")).code).toBe("stopped");
    expect(f.store.state(`view-stopped:${f.request.id}`)).toBe(true);
    f.store.close();
  });
  it("honors Stop during planning and never restores the latched screen", async () => {
    const began = barrier(),
      finish = barrier();
    const f = await fixture({
      plan: async () => {
        began.resolve();
        await finish.promise;
        return {
          action: { kind: "click", x: 0.5, y: 0.5 },
          frame: {
            id: "fresh",
            capturedAt: Date.now(),
            width: 100,
            height: 100,
          },
        };
      },
    });
    await f.viewing.tick();
    const input = f.send("plan", "do: focus textbox");
    await began.promise;
    await f.send("stop", "stop");
    finish.resolve();
    expect(await input).toMatchObject({
      state: "not_started",
      code: "stopped",
    });
    expect(f.device.inputs).toHaveLength(0);
    await f.viewing.tick();
    expect(f.device.leases.size).toBe(0);
    expect(f.store.state(`view-restore:${f.request.id}`)).not.toBe(true);
    f.store.close();
  });
  it("does not restore after Stop wins during final release of an observed click", async () => {
    const f = await fixture(),
      began = barrier(),
      finish = barrier();
    await f.viewing.tick();
    const release = f.device.release.bind(f.device);
    let firstControl = true;
    f.device.release = async (l) => {
      if (l.mode === "control" && firstControl) {
        firstControl = false;
        began.resolve();
        await finish.promise;
      }
      await release(l);
    };
    const input = f.send("click", "click 0.5 0.5");
    await began.promise;
    await f.send("stop", "stop");
    finish.resolve();
    expect((await input).receipt.state).toBe("observed");
    await f.viewing.tick();
    expect(f.device.leases.size).toBe(0);
    expect(f.store.state(`view-restore:${f.request.id}`)).not.toBe(true);
    f.store.close();
  });
  it("retains post-dispatch unknown and never repeats input even if the thrown error is typed", async () => {
    const f = await fixture();
    await f.viewing.tick();
    f.device.action = async (_l, _f, _a, id) => {
      f.device.inputs.push(id);
      throw new ControlPreflightError("planner_unavailable");
    };
    await expect(f.send("click", "click 0.5 0.5")).rejects.toThrow("uncertain");
    expect(f.store.all<ActionReceipt>("action")[0]?.state).toBe("unknown");
    expect((await f.send("click", "click 0.5 0.5")).state).toBe("unknown");
    expect(f.device.inputs).toHaveLength(1);
    expect(f.store.state(`view-restore:${f.request.id}`)).not.toBe(true);
    f.store.close();
  });
  it("keeps submitted input blocked when its post-action frame fails", async () => {
    const f = await fixture(),
      frame = f.device.frame.bind(f.device);
    await f.viewing.tick();
    let frames = 0;
    f.device.frame = async (l) => {
      if (++frames > 1) throw new Error("PRIVATE_FRAME_ERROR");
      return frame(l);
    };
    await expect(f.send("click", "click 0.5 0.5")).rejects.toThrow("uncertain");
    expect(f.store.all<ActionReceipt>("action")[0]?.state).toBe("submitted");
    f.device.frame = frame;
    await expect(
      f.control.acquire(f.request.id, f.binding.memberId),
    ).rejects.toThrow("reconciled");
    expect(f.device.inputs).toHaveLength(1);
    expect(f.store.state(`view-restore:${f.request.id}`)).not.toBe(true);
    expect(JSON.stringify(f.command("click"))).not.toContain(
      "PRIVATE_FRAME_ERROR",
    );
    f.store.close();
  });
});
