import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { ScreenCamera } from "../src/control/camera.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { Viewing } from "../src/control/viewing.js";
import { NativeActivationCoordinator } from "../src/control/native-activation.js";
import { ExecutionCoordinator } from "../src/control/execution.js";
import { HumanRouter } from "../src/control/human-router.js";
import { createApp } from "../src/app.js";
import { mediaSessionId } from "../media/device-port.js";
import type { ControlLease, ExecutionOwnership } from "../src/contracts.js";
import type { CameraStatus } from "../src/camera-contracts.js";
import type { ProductionNativeEnvelope } from "../src/production-native-contracts.js";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
async function fixture(enabled = true) {
  let now = 1_000_000,
    hook:
      | ((stage: string, envelope?: ProductionNativeEnvelope) => Promise<void>)
      | undefined;
  const store = new Store();
  stores.push(store);
  const service = new ClawdTime(store, new SimulationTransport(), {
    clock: () => now,
  });
  const invite = service.createPairingInvite({
    memberId: "synthetic-human",
    recipient: "synthetic-recipient",
    conversationId: "synthetic-conversation",
    lineId: "synthetic-line",
    deviceId: "synthetic-mac",
    displayId: "1",
  });
  const pair = service.claimPairing({
    token: invite.token,
    deviceId: "synthetic-mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const agent = service.registerSession(pair.token, {
    adapter: "codex",
    adapterVersion: "synthetic-production",
    projectRoot: "/disposable",
    externalSessionId: "synthetic-session",
    hostId: "synthetic-host",
    protocolVersion: 2,
    screenCamera: {
      version: 1,
      surface: { kind: "display", id: "1", displayId: 1 },
    },
    capabilities: {
      cooperativePause: true,
      polling: true,
      screenCameraVersion: 1,
      livePresentationVersion: 1,
      nativeActivationVersion: 1,
      nativeControl: "desktop",
      sharedSurface: true,
    },
  });
  const target = {
    appId: "com.apple.finder",
    windowId: "12",
    ownerPid: 42,
    displayId: 1,
  };
  const observation = () => ({
    window: target,
    observedAt: now,
    processIdentity: "process-1",
    windowBounds: { x: 100, y: 100, width: 500, height: 300 },
    appActive: true,
    windowFocused: true,
    windowOnScreen: true,
  });
  let lease: ControlLease;
  class Peer extends SimulatedDevice {
    capability: number | undefined = 1;
    readiness = vi.fn(async () => {
      await hook?.("readiness");
      return {
        cameraVersion: 1,
        nativeActivationVersion: this.capability,
        controlPolicy: "agent_tools_only",
        policyRevision: 1,
        controlAllowed: true,
        armed: true,
        available: true,
        screenPermission: true,
        viewAllowed: true,
        displayAttached: true,
        activeLease: true,
        activeLeaseId: lease?.id,
      };
    });
    cameraCommand = vi.fn(async (): Promise<any> => {
      throw new Error("No camera mutation");
    });
    cameraStatus = vi.fn(async (l: ControlLease): Promise<CameraStatus> => {
      await hook?.("camera");
      return {
        version: 1,
        sessionId: l.sessionId,
        deviceId: l.deviceId,
        leaseId: l.id,
        revision: 0,
        state: "live",
        surface: l.surface!,
        sourceFrameId: "frame",
        capturedAt: now,
        geometryGeneration: "geometry",
        contentRevision: "content",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        source: {
          width: 1000,
          height: 800,
          originX: 0,
          originY: 0,
          pointWidth: 1000,
          pointHeight: 800,
          displayOriginX: 0,
          displayOriginY: 0,
          displayPointWidth: 1000,
          displayPointHeight: 800,
        },
        output: {
          width: 1000,
          height: 800,
          viewport: { x: 0, y: 0, width: 1000, height: 800 },
        },
        pinned: false,
        moving: false,
        annotations: [],
        context: null,
      };
    });
    nativePrepare = vi.fn(
      async (_l: ControlLease, e: ProductionNativeEnvelope) => {
        expect(
          service.nativeReservations.get(e.operation.operationId)?.phase,
        ).toBe("prepared");
        await hook?.("prepare", e);
        return observation();
      },
    );
    nativeDispatch = vi.fn(
      async (_l: ControlLease, e: ProductionNativeEnvelope) => {
        expect(
          service.nativeReservations.get(e.operation.operationId)?.phase,
        ).toBe("dispatching");
        await hook?.("dispatch", e);
        return result(e);
      },
    );
    nativeReceipt = vi.fn(async (_l: ControlLease, id: string) => {
      const e = service.nativeReservations.get(id)!.envelope;
      await hook?.("receipt", e);
      return result(e);
    });
  }
  function result(e: ProductionNativeEnvelope) {
    return {
      operationId: e.operation.operationId,
      state: "verified" as const,
      reason: "target_verified",
      terminalEvidence: {
        operationId: e.operation.operationId,
        fingerprint: e.fingerprint,
        receiptId: "host-receipt",
        hostId: "clawdtime-installed-native",
        completedAt: now,
      },
      observation: observation(),
    };
  }
  const device = new Peer(),
    control = new ControlCoordinator(store, device, service.clock);
  const viewing = new Viewing(store, device, service.clock, false, true);
  const request = service.requestAttention(agent.token, {
    taskId: "native",
    idempotencyKey: "native",
    reason: "review",
    question: "Review synthetic fixture",
  });
  await service.drain();
  service.observeCall(request.id, "connected", true);
  await viewing.tick();
  lease = store.all<ControlLease>("lease")[0]!;
  lease = { ...lease, executor: "native", executorEpoch: 1, policyRevision: 1 };
  store.put("lease", lease);
  const owner: ExecutionOwnership = {
    id: request.id,
    requestId: request.id,
    sessionId: agent.session.id,
    executor: "native",
    state: "working",
    epoch: 1,
    policyRevision: 1,
    updatedAt: now,
  };
  store.put("execution", owner);
  const operation = {
    version: 1,
    operationId: "operation",
    sceneId: "scene",
    generation: 1,
    action: "activate_app",
    window: target,
    expected: {
      requestId: request.id,
      sessionId: agent.session.id,
      leaseId: lease.id,
      epoch: 1,
      cursor: 0,
      policyRevision: 1,
      displayId: 1,
    },
  };
  const revision = { cursor: 0, acknowledgedCursor: 0, pendingDelivery: false };
  const camera = new ScreenCamera(service, control, true);
  const coordinator = new NativeActivationCoordinator(service, camera, {
    enabled,
    revision: () => ({ ...revision }),
    assertClear: () => {},
  });
  const reference = () => ({
    operationId: operation.operationId,
    fingerprint: service.nativeReservations.get(operation.operationId)!.envelope
      .fingerprint,
  });
  return {
    store,
    service,
    pair,
    agent,
    device,
    control,
    request,
    lease,
    owner,
    operation,
    camera,
    coordinator,
    revision,
    observation,
    result,
    reference,
    prepare: () => coordinator.prepare(agent.token, request.id, operation),
    dispatch: () => coordinator.dispatch(agent.token, request.id, reference()),
    on: (fn: typeof hook) => {
      hook = fn;
    },
    advance: (ms: number) => {
      now += ms;
    },
    stop: () => store.saveState(`view-stopped:${request.id}`, true),
  };
}

describe("production native activation coordinator", () => {
  it("durably prepares and dispatches once, binds duplicate fingerprints, and returns verified evidence", async () => {
    const f = await fixture();
    const p = await f.prepare();
    expect(p.phase).toBe("prepared");
    expect(p.envelope.binding.mediaSessionId).toBe(
      mediaSessionId(f.request.id),
    );
    expect(await f.prepare()).toEqual(p);
    expect(f.device.nativePrepare).toHaveBeenCalledTimes(1);
    expect((await f.dispatch()).phase).toBe("verified");
    expect((await f.dispatch()).phase).toBe("verified");
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
    await expect(
      f.coordinator.prepare(f.agent.token, f.request.id, {
        ...f.operation,
        action: "raise_window",
      }),
    ).rejects.toThrow("already bound");
    expect(
      f.service.nativeReservations.hasUnresolvedDevice(f.lease.deviceId),
    ).toBe(false);
  });
  it("rejects missing capability, disabled gate, wrong scope and unsupported target without dispatch", async () => {
    const f = await fixture(false);
    await expect(f.prepare()).rejects.toThrow("not negotiated or enabled");
    const g = await fixture();
    g.device.capability = undefined;
    expect((await g.prepare()).phase).toBe("rejected");
    expect(g.device.nativePrepare).not.toHaveBeenCalled();
    const h = await fixture();
    for (const key of [
      "sessionId",
      "leaseId",
      "epoch",
      "cursor",
      "policyRevision",
      "displayId",
    ] as const) {
      const value = h.operation.expected[key];
      await expect(
        h.coordinator.prepare(h.agent.token, h.request.id, {
          ...h.operation,
          expected: {
            ...h.operation.expected,
            [key]: typeof value === "number" ? value + 1 : "wrong",
          },
        }),
      ).rejects.toThrow();
    }
    await expect(
      h.coordinator.prepare(h.agent.token, h.request.id, {
        ...h.operation,
        window: { ...h.operation.window, appId: "com.apple.Terminal" },
      }),
    ).rejects.toThrow();
    expect(h.device.nativePrepare).not.toHaveBeenCalled();
    expect(h.device.nativeDispatch).not.toHaveBeenCalled();
  });
  it.each(["readiness", "camera", "prepare"])(
    "cancels before any input when Stop arrives during %s",
    async (stage) => {
      const f = await fixture();
      f.on(async (s) => {
        if (s === stage) f.stop();
      });
      expect((await f.prepare()).phase).toBe("rejected");
      expect(f.device.nativeDispatch).not.toHaveBeenCalled();
      expect(
        f.service.nativeReservations.hasUnresolvedDevice(f.lease.deviceId),
      ).toBe(false);
    },
  );
  it("retains uncertain input after Stop during dispatch and reconciles only by reading exact host receipt", async () => {
    const f = await fixture();
    await f.prepare();
    f.on(async (s) => {
      if (s === "dispatch") f.stop();
    });
    expect((await f.dispatch()).phase).toBe("uncertain");
    expect(
      f.service.nativeReservations.hasUnresolvedDevice(f.lease.deviceId),
    ).toBe(true);
    expect((await f.dispatch()).phase).toBe("uncertain");
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
    const reconciled = await f.coordinator.reconcile(
      f.agent.token,
      f.request.id,
      f.reference(),
    );
    expect(reconciled.phase).toBe("returned");
    expect(reconciled.result?.reason).toBe(
      "host_terminal_reconciled_not_ui_verified",
    );
    expect(f.device.nativeReceipt).toHaveBeenCalledTimes(1);
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
  });
  it("preserves original expiry across delayed replies without renewing authority", async () => {
    const f = await fixture();
    await f.prepare();
    const original =
      f.service.nativeReservations.get("operation")!.envelope.binding.expiresAt;
    f.on(async (s) => {
      if (s === "dispatch") f.advance(2001);
    });
    expect((await f.dispatch()).phase).toBe("uncertain");
    const saved = f.service.nativeReservations.get("operation")!;
    expect(saved.envelope.binding.expiresAt).toBe(original);
    expect(saved.envelope.nativeExpiresAt).toBe(1002000);
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
  });
  it("safely rejects helper preparation failure and target replacement; lost dispatch stays uncertain", async () => {
    const f = await fixture();
    f.device.nativePrepare.mockRejectedValueOnce(
      new Error("synthetic failure"),
    );
    expect((await f.prepare()).phase).toBe("rejected");
    expect(f.device.nativeDispatch).not.toHaveBeenCalled();
    const g = await fixture();
    await g.prepare();
    g.device.nativeDispatch.mockImplementationOnce(async (_l, e) => ({
      ...g.result(e),
      observation: {
        ...g.observation(),
        processIdentity: "replacement-process",
      },
    }));
    expect((await g.dispatch()).phase).toBe("uncertain");
    const h = await fixture();
    await h.prepare();
    h.device.nativeDispatch.mockRejectedValueOnce(
      new Error("synthetic lost receipt"),
    );
    expect((await h.dispatch()).phase).toBe("uncertain");
    expect((await h.dispatch()).phase).toBe("uncertain");
    expect(h.device.nativeDispatch).toHaveBeenCalledTimes(1);
  });
  it("fences another display's owner and prevents release while reservation unresolved", async () => {
    const f = await fixture();
    f.store.put("lease", {
      ...f.lease,
      id: "other-lease",
      requestId: "other-request",
      displayId: "2",
    });
    f.store.put("execution", {
      ...f.owner,
      id: "other-request",
      requestId: "other-request",
    });
    await expect(f.prepare()).rejects.toThrow("Another device input actor");
    const g = await fixture();
    const execution = new ExecutionCoordinator(g.service, g.control);
    g.store.put("execution", g.owner);
    await g.prepare();
    await expect(
      execution.transition(g.agent.token, g.request.id, {
        executor: "none",
        expectedEpoch: 1,
        previousOutcome: "completed",
        backgroundActorsStopped: true,
      }),
    ).rejects.toThrow("Unresolved input");
  });
  it.each(["pending_approval", "orphan_owner", "unknown_action"])(
    "fences device-wide retained %s before preparation",
    async (kind) => {
      const f = await fixture();
      if (kind === "unknown_action") {
        f.store.put("lease", {
          ...f.lease,
          id: "old-lease",
          displayId: "2",
          state: "released",
        });
        f.store.put("action", {
          id: "unknown-input",
          leaseId: "old-lease",
          frameId: "old-frame",
          state: "unknown",
          createdAt: 1,
        });
      } else {
        f.store.put("attention", { ...f.request, id: "old-request" });
        f.store.put("execution", {
          ...f.owner,
          id: "old-request",
          requestId: "old-request",
          state: kind === "pending_approval" ? "pending_approval" : "working",
        });
        if (kind !== "orphan_owner")
          f.store.put("lease", {
            ...f.lease,
            id: "old-lease",
            requestId: "old-request",
            displayId: "2",
          });
      }
      await expect(f.prepare()).rejects.toThrow("Another device input actor");
      expect(f.device.nativePrepare).not.toHaveBeenCalled();
    },
  );
  it("reconciles old terminal evidence after restart timing without claiming fresh UI", async () => {
    const f = await fixture();
    await f.prepare();
    const original = f.result(
      f.service.nativeReservations.get("operation")!.envelope,
    );
    f.device.nativeDispatch.mockRejectedValueOnce(
      new Error("synthetic lost receipt"),
    );
    expect((await f.dispatch()).phase).toBe("uncertain");
    f.advance(3000);
    f.device.nativeReceipt.mockResolvedValueOnce(original);
    const result = await f.coordinator.reconcile(
      f.agent.token,
      f.request.id,
      f.reference(),
    );
    expect(result.phase).toBe("returned");
    expect(result.result?.reason).toBe(
      "host_terminal_reconciled_not_ui_verified",
    );
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
  });
  it("rejects raising an inactive app without dispatch, while allowing a separately prepared activation", async () => {
    const f = await fixture();
    const inactive = {
      ...f.observation(),
      appActive: false,
      windowFocused: false,
    };
    f.device.nativePrepare.mockResolvedValueOnce(inactive);
    const rejected = await f.coordinator.prepare(f.agent.token, f.request.id, {
      ...f.operation,
      action: "raise_window",
    });
    expect(rejected.phase).toBe("rejected");
    expect((await f.dispatch()).phase).toBe("rejected");
    expect(f.device.nativeDispatch).not.toHaveBeenCalled();
    const activation = await f.coordinator.prepare(
      f.agent.token,
      f.request.id,
      { ...f.operation, operationId: "activate-after-rejected-raise" },
    );
    expect(activation.phase).toBe("prepared");
    expect(f.device.nativePrepare).toHaveBeenCalledTimes(2);
  });
  it("rejects stale generations and same-generation replacement scenes or targets before contacting the helper", async () => {
    const f = await fixture();
    f.operation.generation = 3;
    await f.prepare();
    await f.dispatch();
    const changes = [
      { generation: 2 },
      { sceneId: "replacement-scene" },
      { window: { ...f.operation.window, windowId: "13" } },
      { window: { ...f.operation.window, ownerPid: 43 } },
    ];
    for (const [index, change] of changes.entries()) {
      await expect(
        f.coordinator.prepare(f.agent.token, f.request.id, {
          ...f.operation,
          operationId: `replacement-${index}`,
          ...change,
        }),
      ).rejects.toThrow("current scene generation");
    }
    expect(f.device.nativePrepare).toHaveBeenCalledTimes(1);
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
    expect(f.service.nativeReservations.all(f.request.id)).toHaveLength(1);
    const followup = await f.coordinator.prepare(f.agent.token, f.request.id, {
      ...f.operation,
      operationId: "followup",
      generation: 4,
      sceneId: "followup-scene",
    });
    expect(followup.phase).toBe("prepared");
  });
  it.each(["readiness", "dispatch"])(
    "serializes two concurrent dispatch clients during %s without a second effect",
    async (stage) => {
      const f = await fixture();
      await f.prepare();
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((done) => {
        entered = done;
      });
      const held = new Promise<void>((done) => {
        release = done;
      });
      let once = false;
      f.on(async (current) => {
        if (current === stage && !once) {
          once = true;
          entered();
          await held;
        }
      });
      const first = f.dispatch();
      await started;
      try {
        if (stage === "readiness")
          await expect(f.dispatch()).rejects.toThrow("busy");
        else expect((await f.dispatch()).phase).toBe("dispatching");
        expect(f.device.nativeDispatch).toHaveBeenCalledTimes(
          stage === "dispatch" ? 1 : 0,
        );
      } finally {
        release();
      }
      expect((await first).phase).toBe("verified");
      expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
      expect((await f.dispatch()).phase).toBe("verified");
      expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses cancellation of an in-flight effect and retains its device fence until the original result returns", async () => {
    const f = await fixture();
    await f.prepare();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    f.on(async (stage) => {
      if (stage === "dispatch") {
        entered();
        await held;
      }
    });
    const dispatched = f.dispatch();
    await started;
    try {
      expect(() =>
        f.coordinator.cancel(f.agent.token, f.request.id, f.reference()),
      ).toThrow("undispatched");
      expect(f.service.nativeReservations.get("operation")?.phase).toBe(
        "dispatching",
      );
      expect(
        f.service.nativeReservations.hasUnresolvedDevice(f.lease.deviceId),
      ).toBe(true);
      expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await dispatched).phase).toBe("verified");
    expect(
      f.service.nativeReservations.hasUnresolvedDevice(f.lease.deviceId),
    ).toBe(false);
    expect(f.device.nativeDispatch).toHaveBeenCalledTimes(1);
  });
  it("authenticates public routes and server-only authority callback", async () => {
    const f = await fixture();
    const app = createApp(
      f.service,
      f.control,
      new HumanRouter(f.service, f.control),
      {
        origin: "http://localhost",
        simulation: true,
        mediaToken: "m".repeat(64),
        screenCameraEnabled: true,
        nativeActivationEnabled: true,
      },
    );
    f.store.put("execution", f.owner);
    const base = `/api/attention/${f.request.id}/conversation/native-activation`;
    const send = (
      path: string,
      body?: unknown,
      token = f.agent.token,
      extra = {},
    ) =>
      app.request(path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    expect((await app.request(`${base}/status`)).status).toBe(401);
    f.on(async (stage, e) => {
      if (stage !== "prepare") return;
      const path = `/media/${mediaSessionId(f.request.id)}/native-activation-authority`;
      expect((await send(path, { envelope: e }, "foreign")).status).toBe(401);
      expect(
        (
          await send(path, { envelope: e }, "m".repeat(64), {
            Origin: "http://localhost",
          })
        ).status,
      ).toBe(403);
      expect((await send(path, { envelope: e }, "m".repeat(64))).status).toBe(
        200,
      );
    });
    const prepared = await send(`${base}/prepare`, f.operation);
    expect(prepared.status).toBe(200);
    expect((await prepared.json()).phase).toBe("prepared");
    const dispatched = await send(`${base}/dispatch`, f.reference());
    expect(dispatched.status).toBe(200);
    expect((await dispatched.json()).phase).toBe("verified");
    expect((await send(`${base}/receipts/operation`)).status).toBe(200);
  });
});
