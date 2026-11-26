import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawdTime } from "../src/attention/service.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import type {
  SessionRegistration,
  ControlLease,
  ExecutionOwnership,
} from "../src/contracts.js";
import { ScreenCamera } from "../src/control/camera.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { Viewing } from "../src/control/viewing.js";
import { LivePresentationCoordinator } from "../src/control/live-presentation.js";
import { createApp } from "../src/app.js";
import { HumanRouter } from "../src/control/human-router.js";
import { mediaSessionId } from "../media/device-port.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const registration = {
  adapter: "codex",
  adapterVersion: "synthetic-production-test",
  projectRoot: "/disposable-presentation-fixture",
  externalSessionId: "presentation-session",
  hostId: "fixture-host",
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
  },
} as const;
function fixture() {
  const store = new Store();
  stores.push(store);
  const transport = new SimulationTransport();
  let now = Date.now();
  const service = new ClawdTime(store, transport, { clock: () => now });
  const pairing = service.claimPairing({
    token: service.createPairingInvite({
      memberId: "fixture-human",
      recipient: "fixture-recipient",
      conversationId: "fixture-conversation",
      lineId: "fixture-line",
      deviceId: "fixture-mac",
      displayId: "1",
    }).token,
    deviceId: "fixture-mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  return {
    store,
    transport,
    service,
    pairing,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("production live presentation immutable negotiation", () => {
  it("requires explicit opt-in and preserves it only on exact reconnect", () => {
    const f = fixture();
    const legacy = {
      ...registration,
      capabilities: {
        cooperativePause: true,
        polling: true,
        screenCameraVersion: 1 as const,
      },
    };
    const first = f.service.registerSession(f.pairing.token, legacy);
    expect(first.session.capabilities.livePresentationVersion).toBeUndefined();
    expect(() =>
      f.service.registerSession(f.pairing.token, registration),
    ).toThrow("binding differs");
    const fresh = {
      ...registration,
      externalSessionId: "fresh-presentation-session",
    };
    const enabled = f.service.registerSession(f.pairing.token, fresh);
    expect(enabled.session.capabilities.livePresentationVersion).toBe(1);
    expect(f.service.registerSession(f.pairing.token, fresh).session.id).toBe(
      enabled.session.id,
    );
    expect(() =>
      f.service.registerSession(f.pairing.token, {
        ...fresh,
        capabilities: legacy.capabilities,
      }),
    ).toThrow("binding differs");
    expect(f.transport.calls).toHaveLength(0);
    expect(f.store.all("lease")).toHaveLength(0);
  });

  it("rejects legacy, missing camera, window, managed, document, audio and forged capabilities", () => {
    const f = fixture();
    const cases = [
      { ...registration, protocolVersion: 1 },
      { ...registration, screenCamera: undefined },
      {
        ...registration,
        capabilities: {
          ...registration.capabilities,
          screenCameraVersion: undefined,
        },
      },
      {
        ...registration,
        capabilities: {
          ...registration.capabilities,
          livePresentationVersion: 2,
        },
      },
      {
        ...registration,
        capabilities: {
          ...registration.capabilities,
          livePresentationVersion: true,
        },
      },
      {
        ...registration,
        screenCamera: {
          version: 1,
          surface: { kind: "window", id: "12", displayId: 1, ownerPid: 42 },
        },
      },
      {
        ...registration,
        conversation: {
          version: 1,
          runnerId: "remote",
          executionSession: "api_managed",
        },
      },
      {
        ...registration,
        documentAccess: {
          version: 1,
          readOnly: true,
          expiresAt: Date.now() + 10000,
        },
      },
      {
        ...registration,
        audioQualification: {
          version: 1,
          executionDisabled: true,
          expiresAt: Date.now() + 10000,
        },
      },
    ];
    for (const candidate of cases)
      expect(() =>
        f.service.registerSession(
          f.pairing.token,
          candidate as SessionRegistration,
        ),
      ).toThrow();
    expect(f.store.all("session")).toHaveLength(0);
    expect(f.transport.calls).toHaveLength(0);
  });
});

async function controllerFixture(enabled = true) {
  const f = fixture();
  const agent = f.service.registerSession(f.pairing.token, registration);
  const intent = {
    commandId: "present-1",
    planId: "plan",
    sceneId: "scene",
    generation: 1,
    window: {
      appId: "com.apple.finder",
      windowId: "12",
      ownerPid: 42,
      displayId: 1,
    },
    focus: {
      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      durationMs: 450,
    },
    annotation: {
      kind: "label",
      text: "synthetic-private-label-do-not-persist",
    },
  };
  let hookQualify: (() => Promise<void>) | undefined;
  let hookPresent: ((result: any) => Promise<void>) | undefined;
  let lastPresentation: any;
  let lastQualification: any;
  const records = () => f.store.all<any>("live-presentation");
  const observation = () => ({
    window: intent.window,
    processIdentity: "process-start-1",
    observedAt: f.service.clock(),
    windowBounds: { x: 100, y: 100, width: 500, height: 300 },
    appActive: true,
    windowFocused: true,
    windowOnScreen: true,
  });
  class Peer extends SimulatedDevice {
    readyVersion: number | undefined = 1;
    readiness = vi.fn(async () => ({
      cameraVersion: 1,
      livePresentationVersion: this.readyVersion,
      controlPolicy: "agent_tools_only",
      policyRevision: 1,
      controlAllowed: false,
      armed: true,
      available: true,
      screenPermission: true,
      viewAllowed: true,
      displayAttached: true,
      activeLease: this.leases.size > 0,
      activeLeaseId: this.leases.keys().next().value,
    }));
    cameraStatus = vi.fn(async (): Promise<any> => {
      throw new Error("Camera callback must remain lock-free");
    });
    cameraCommand = vi.fn(async (): Promise<any> => {
      throw new Error("No generic camera dispatch");
    });
    resolvePresentation = vi.fn(async (_lease: ControlLease, input: any) => {
      lastQualification = input;
      expect(records().at(-1).phase).toBe("qualifying");
      await hookQualify?.();
      return observation();
    });
    livePresentation = vi.fn(
      async (_lease: ControlLease, presentation: any, fingerprint: string) => {
        lastPresentation = presentation;
        expect(records().at(-1).phase).toBe("dispatching");
        const result = {
          version: 1,
          commandId: presentation.commandId,
          fingerprint,
          receiptId: "host-receipt",
          state: "accepted",
          reason: "target_presentation_applied",
          observation: observation(),
          camera: {
            revision: 3,
            sourceFrameId: "new-frame",
            geometryGeneration: "geometry",
            contentRevision: "new-content",
            capturedAt: f.service.clock(),
          },
        };
        await hookPresent?.(result);
        return result;
      },
    );
  }
  const device = new Peer();
  const control = new ControlCoordinator(f.store, device, f.service.clock);
  const viewing = new Viewing(f.store, device, f.service.clock, false, true);
  const request = f.service.requestAttention(agent.token, {
    taskId: "presentation",
    idempotencyKey: "presentation",
    reason: "review",
    question: "Review the synthetic fixture.",
  });
  await f.service.drain();
  f.service.observeCall(request.id, "connected", true);
  await viewing.tick();
  const lease = f.store.all<ControlLease>("lease")[0]!;
  const owner: ExecutionOwnership = {
    id: request.id,
    requestId: request.id,
    sessionId: agent.session.id,
    executor: "none",
    state: "idle",
    epoch: 0,
    policyRevision: 1,
    updatedAt: f.service.clock(),
  };
  f.store.put("execution", owner);
  const revision = { cursor: 0, acknowledgedCursor: 0, pendingDelivery: false };
  let hold = false;
  const camera = new ScreenCamera(f.service, control, true);
  const options = {
    enabled,
    revision: () => ({ ...revision }),
    assertClear: () => {
      if (hold) throw new Error("Interpretation held");
    },
  };
  const coordinator = new LivePresentationCoordinator(
    f.service,
    camera,
    options,
  );
  const present = (body: unknown = intent) =>
    coordinator.present(agent.token, request.id, body);
  const mutate = (change: string) => {
    if (change === "stop")
      f.store.saveState(`view-stopped:${request.id}`, true);
    if (change === "cursor") revision.cursor++;
    if (change === "owner")
      f.store.put("execution", {
        ...owner,
        executor: "native",
        state: "working",
      });
    if (change === "policy")
      f.store.put("lease", { ...lease, policyRevision: 2 });
    if (change === "hold") hold = true;
  };
  return {
    ...f,
    agent,
    request,
    lease,
    device,
    intent,
    coordinator,
    options,
    camera,
    records,
    present,
    mutate,
    lastPresentation: () => lastPresentation,
    lastQualification: () => lastQualification,
    onQualify: (hook: () => Promise<void>) => {
      hookQualify = hook;
    },
    onPresent: (hook: (result: any) => Promise<void>) => {
      hookPresent = hook;
    },
  };
}

describe("production live presentation durable authority", () => {
  it("authenticates production callbacks and exposes metadata-only receipts through the real routes", async () => {
    const f = await controllerFixture();
    const app = createApp(
      f.service,
      f.camera.control,
      new HumanRouter(f.service, f.camera.control),
      {
        origin: "http://127.0.0.1",
        simulation: true,
        mediaToken: "m".repeat(64),
        screenCameraEnabled: true,
        livePresentationEnabled: true,
      },
    );
    const media = (
      suffix: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.request(`/media/${mediaSessionId(f.request.id)}/${suffix}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${"m".repeat(64)}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    f.onQualify(async () => {
      const body = { qualification: f.lastQualification() };
      expect(
        (
          await media("presentation-qualification", body, {
            Authorization: "Bearer foreign",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await media("presentation-qualification", body, {
            Origin: "http://localhost",
          })
        ).status,
      ).toBe(403);
      expect((await media("presentation-qualification", body)).status).toBe(
        200,
      );
    });
    const base = `/api/attention/${f.request.id}/conversation/presentation`;
    expect((await app.request(base)).status).toBe(401);
    const result = await app.request(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.agent.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(f.intent),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).state).toBe("accepted");
    expect(
      (
        await media("presentation-authority", {
          presentation: f.lastPresentation(),
        })
      ).status,
    ).toBe(200);
    f.mutate("stop");
    expect(
      (
        await media("presentation-authority", {
          presentation: f.lastPresentation(),
        })
      ).status,
    ).toBe(409);
    const receipt = await app.request(
      `${base}/receipts/${f.intent.commandId}`,
      { headers: { Authorization: `Bearer ${f.agent.token}` } },
    );
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).state).toBe("accepted");
    expect(f.device.cameraStatus).not.toHaveBeenCalled();
    expect(f.device.inputs).toHaveLength(0);
  });

  it("defaults off and requires matched peer negotiation before any work", async () => {
    const disabled = await controllerFixture(false);
    await expect(disabled.present()).rejects.toThrow("enabled");
    expect(disabled.device.resolvePresentation).not.toHaveBeenCalled();
    expect(disabled.records()).toHaveLength(0);
    const oldPeer = await controllerFixture();
    oldPeer.device.readyVersion = undefined;
    await expect(oldPeer.present()).rejects.toThrow("peer");
    expect(oldPeer.device.livePresentation).not.toHaveBeenCalled();
  });

  it("durably reserves before RPC, binds a fresh process and stores no annotation label", async () => {
    const f = await controllerFixture();
    expect((await f.present()).state).toBe("accepted");
    expect(f.lastPresentation().processIdentity).toBe("process-start-1");
    expect(f.lastPresentation().annotation.text).toBe(f.intent.annotation.text);
    expect(JSON.stringify(f.records())).not.toContain(f.intent.annotation.text);
    expect(f.device.inputs).toHaveLength(0);
    expect(f.device.cameraCommand).not.toHaveBeenCalled();
  });

  it.each(["stop", "cursor", "owner", "policy", "hold"])(
    "refuses %s during read-only qualification before presentation",
    async (change) => {
      const f = await controllerFixture();
      f.onQualify(async () => f.mutate(change));
      expect((await f.present()).state).toBe("rejected");
      expect(f.device.livePresentation).not.toHaveBeenCalled();
      expect(f.records()[0].phase).toBe("rejected");
    },
  );

  it.each(["stop", "cursor", "owner", "policy", "hold"])(
    "retains uncertainty and host evidence when %s races the host result",
    async (change) => {
      const f = await controllerFixture();
      f.onPresent(async () => f.mutate(change));
      expect((await f.present()).state).toBe("uncertain");
      expect(f.records()[0].hostResult.state).toBe("accepted");
      expect(f.coordinator.hasUnresolved(f.request.id)).toBe(true);
      expect((await f.present()).state).toBe("uncertain");
      expect(f.device.livePresentation).toHaveBeenCalledTimes(1);
    },
  );

  it("deduplicates exact IDs, rejects mutations and fences older scene generations", async () => {
    const f = await controllerFixture();
    const first = await f.present();
    expect(await f.present()).toEqual(first);
    await expect(
      f.present({
        ...f.intent,
        annotation: { ...f.intent.annotation, text: "changed" },
      }),
    ).rejects.toThrow("already bound");
    await expect(
      f.present({ ...f.intent, commandId: "other", sceneId: "next" }),
    ).rejects.toThrow("generation");
    const old = f.lastPresentation();
    expect(
      (
        await f.present({
          ...f.intent,
          commandId: "next",
          sceneId: "next",
          generation: 2,
        })
      ).state,
    ).toBe("accepted");
    expect(() =>
      f.coordinator.authority(f.agent.session, f.request.id, old),
    ).toThrow("changed");
    expect(f.device.livePresentation).toHaveBeenCalledTimes(2);
  });

  it("recovers an interrupted durable reservation as unknown without replay", async () => {
    const f = await controllerFixture();
    await f.present();
    const saved = f.records()[0];
    f.store.put("live-presentation", {
      ...saved,
      phase: "dispatching",
      result: undefined,
      hostResult: undefined,
    });
    const restarted = new LivePresentationCoordinator(
      f.service,
      f.camera,
      f.options,
    );
    expect(restarted.hasUnresolved(f.request.id)).toBe(true);
    expect(
      restarted.receipt(f.agent.token, f.request.id, f.intent.commandId).state,
    ).toBe("uncertain");
    expect(
      (await restarted.present(f.agent.token, f.request.id, f.intent)).state,
    ).toBe("uncertain");
    await expect(
      restarted.present(f.agent.token, f.request.id, {
        ...f.intent,
        commandId: "new",
        generation: 2,
      }),
    ).rejects.toThrow("unresolved");
    expect(f.device.livePresentation).toHaveBeenCalledTimes(1);
  });

  it("keeps authority callbacks read-only and bound to the exact current presentation", async () => {
    const f = await controllerFixture();
    await f.present();
    const calls = f.device.readiness.mock.calls.length;
    const value = f.lastPresentation();
    expect(
      f.coordinator.authority(f.agent.session, f.request.id, value).fingerprint,
    ).toBe(f.records()[0].fingerprint);
    expect(() =>
      f.coordinator.authority(f.agent.session, f.request.id, {
        ...value,
        processIdentity: "forged",
      }),
    ).toThrow();
    expect(f.device.readiness).toHaveBeenCalledTimes(calls);
    expect(f.device.cameraStatus).not.toHaveBeenCalled();
    f.advance(8001);
    expect(() =>
      f.coordinator.authority(f.agent.session, f.request.id, value),
    ).toThrow();
  });

  it("binds read-only qualification callbacks to the exact journaled request and original expiry", async () => {
    const f = await controllerFixture();
    f.onQualify(async () => {
      const q = f.lastQualification();
      const reads = f.device.readiness.mock.calls.length;
      expect(
        f.coordinator.qualification(f.agent.session, f.request.id, q).expiresAt,
      ).toBe(q.expiresAt);
      expect(() =>
        f.coordinator.qualification(f.agent.session, f.request.id, {
          ...q,
          expiresAt: q.expiresAt + 1,
        }),
      ).toThrow();
      expect(() =>
        f.coordinator.qualification(f.agent.session, f.request.id, {
          ...q,
          window: { ...q.window, windowId: "13" },
        }),
      ).toThrow();
      expect(f.device.readiness).toHaveBeenCalledTimes(reads);
      expect(f.device.cameraStatus).not.toHaveBeenCalled();
    });
    expect((await f.present()).state).toBe("accepted");
    expect(() =>
      f.coordinator.qualification(
        f.agent.session,
        f.request.id,
        f.lastQualification(),
      ),
    ).toThrow();
  });

  it("does not refresh an expired qualification when its delayed observation arrives", async () => {
    const f = await controllerFixture();
    f.onQualify(async () => {
      f.advance(2001);
    });
    expect((await f.present()).state).toBe("rejected");
    expect(f.device.livePresentation).not.toHaveBeenCalled();
  });

  it("retains a delayed accepted host receipt as uncertain without replaying it", async () => {
    const f = await controllerFixture();
    let originalObservedAt: number | undefined;
    f.onPresent(async (result) => {
      originalObservedAt = result.observation.observedAt;
      f.advance(2001);
    });
    expect((await f.present()).state).toBe("uncertain");
    expect(f.records()[0].hostResult.state).toBe("accepted");
    expect(f.records()[0].hostResult.observation.observedAt).toBe(
      originalObservedAt,
    );
    expect(f.coordinator.hasUnresolved(f.request.id)).toBe(true);
    expect((await f.present()).state).toBe("uncertain");
    expect(f.device.livePresentation).toHaveBeenCalledTimes(1);
    expect(f.device.inputs).toHaveLength(0);
  });

  it("does not restart the original authority lifetime for a late fresh-looking result", async () => {
    const f = await controllerFixture();
    f.onPresent(async (result) => {
      f.advance(8001);
      result.observation.observedAt = f.service.clock();
      result.camera.capturedAt = f.service.clock();
    });
    expect((await f.present()).state).toBe("uncertain");
    expect(f.records()[0].hostResult.state).toBe("accepted");
    expect(() =>
      f.coordinator.authority(
        f.agent.session,
        f.request.id,
        f.lastPresentation(),
      ),
    ).toThrow("changed");
    expect((await f.present()).state).toBe("uncertain");
    expect(f.device.livePresentation).toHaveBeenCalledTimes(1);
  });

  it("refuses disarmed readiness before target qualification or durable presentation work", async () => {
    const f = await controllerFixture();
    const readiness = await f.device.readiness();
    f.device.readiness.mockResolvedValue({ ...readiness, armed: false });
    await expect(f.present()).rejects.toThrow("Fresh live presentation peer");
    expect(f.records()).toHaveLength(0);
    expect(f.device.resolvePresentation).not.toHaveBeenCalled();
    expect(f.device.livePresentation).not.toHaveBeenCalled();
    expect(f.device.inputs).toHaveLength(0);
  });

  it("allows a fresh authoritative epoch-zero view without a stored execution owner", async () => {
    const f = await controllerFixture();
    f.store.db
      .prepare("DELETE FROM entities WHERE kind='execution' AND id=?")
      .run(f.request.id);
    expect((await f.present()).state).toBe("accepted");
    expect(f.lastPresentation().expected.epoch).toBe(0);
  });
});
