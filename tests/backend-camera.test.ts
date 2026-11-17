import { afterEach, describe, expect, it } from "vitest";
import { ClawdTime } from "../src/attention/service.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import type { SessionRegistration } from "../src/contracts.js";
import type {
  ControlLease,
  Frame,
  InputAction,
  ActionReceipt,
} from "../src/contracts.js";
import type {
  CameraStatus,
  CameraCommand,
  PresentationReference,
} from "../src/camera-contracts.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { Viewing } from "../src/control/viewing.js";
import { createApp } from "../src/app.js";
import { mediaSessionId } from "../media/device-port.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const displayCamera = {
  version: 1 as const,
  surface: { kind: "display" as const, id: "1", displayId: 1 },
};
const registration: SessionRegistration = {
  protocolVersion: 2,
  interaction: {
    version: 1,
    commandChannel: "imessage_first",
    messageUpdates: false,
  },
  adapter: "codex",
  adapterVersion: "synthetic-camera-test",
  projectRoot: "/disposable-camera-fixture",
  externalSessionId: "camera-session",
  hostId: "fixture-host",
  screenCamera: displayCamera,
  capabilities: {
    cooperativePause: true,
    polling: true,
    screenCameraVersion: 1,
  },
};

function registrationFixture() {
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
    service,
    transport,
    pairing,
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("screen camera immutable session negotiation", () => {
  it("keeps legacy sessions off and requires an explicit matching v2 selection", () => {
    const f = registrationFixture();
    const { screenCamera: _selection, ...old } = registration;
    const legacy = {
      ...old,
      capabilities: { cooperativePause: true, polling: true },
    };
    const first = f.service.registerSession(f.pairing.token, legacy);
    expect(first.session.screenCamera).toBeUndefined();
    expect(first.session.capabilities.screenCameraVersion).toBeUndefined();
    expect(() =>
      f.service.registerSession(f.pairing.token, registration),
    ).toThrow("binding differs");
    const fresh = f.service.registerSession(f.pairing.token, {
      ...registration,
      externalSessionId: "fresh-camera-session",
    });
    expect(fresh.session.screenCamera).toEqual(displayCamera);
    expect(fresh.session.capabilities.screenCameraVersion).toBe(1);
    expect(f.transport.calls).toHaveLength(0);
    expect(f.store.all("lease")).toHaveLength(0);
    expect(f.store.all("action")).toHaveLength(0);
  });

  it("rejects incomplete, legacy, forged, wrong-display and document negotiations", () => {
    const f = registrationFixture();
    const { screenCamera: _selection, ...withoutSelection } = registration;
    const cases = [
      withoutSelection,
      {
        ...registration,
        capabilities: { cooperativePause: true, polling: true },
      },
      { ...registration, protocolVersion: 1 },
      { ...registration, screenCamera: { ...displayCamera, version: 2 } },
      {
        ...registration,
        screenCamera: {
          version: 1,
          surface: { kind: "display", id: "2", displayId: 2 },
        },
      },
      {
        ...registration,
        screenCamera: {
          version: 1,
          surface: {
            kind: "display",
            id: "1",
            displayId: 1,
            arbitraryAuthority: true,
          },
        },
      },
      {
        ...registration,
        documentAccess: {
          version: 1,
          readOnly: true,
          expiresAt: f.clock() + 10000,
        },
        conversation: {
          version: 1,
          runnerId: "remote-documents",
          executionSession: "api_managed",
        },
      },
      {
        ...registration,
        audioQualification: {
          version: 1,
          executionDisabled: true,
          expiresAt: f.clock() + 10000,
        },
      },
    ];
    for (const value of cases)
      expect(() =>
        f.service.registerSession(
          f.pairing.token,
          value as SessionRegistration,
        ),
      ).toThrow();
    expect(f.store.all("session")).toHaveLength(0);
    expect(f.transport.calls).toHaveLength(0);
  });

  it("reconnects the exact surface and rejects another window, device scope or opt-out", () => {
    const f = registrationFixture();
    const window = {
      ...registration,
      screenCamera: {
        version: 1 as const,
        surface: {
          kind: "window" as const,
          id: "7",
          displayId: 1,
          ownerPid: 123,
        },
      },
    };
    const first = f.service.registerSession(f.pairing.token, window);
    const again = f.service.registerSession(f.pairing.token, window);
    expect(again.session.id).toBe(first.session.id);
    expect(again.token).not.toBe(first.token);
    for (const surface of [
      { ...window.screenCamera.surface, id: "8" },
      { ...window.screenCamera.surface, ownerPid: 124 },
      { ...window.screenCamera.surface, displayId: 2 },
    ])
      expect(() =>
        f.service.registerSession(f.pairing.token, {
          ...window,
          screenCamera: { version: 1, surface },
        }),
      ).toThrow();
    expect(() =>
      f.service.registerSession(f.pairing.token, {
        ...window,
        screenCamera: undefined,
        capabilities: { cooperativePause: true, polling: true },
      }),
    ).toThrow("binding differs");
    expect(f.store.all("session")).toHaveLength(1);
  });
});

async function cameraFixture(enabled = true, opted = true) {
  const f = registrationFixture();
  class CameraDevice extends SimulatedDevice {
    cameraVersion: number | undefined = 1;
    commands: CameraCommand[] = [];
    statusCalls = 0;
    revision = 0;
    frameSequence = 1;
    dispatched: {
      frame: Frame;
      action: InputAction;
      presentation?: PresentationReference;
    }[] = [];
    statusOverride: Partial<CameraStatus> = {};
    frameOverride: Partial<Frame> = {};
    readinessOverride: Record<string, unknown> = {};
    receiptCommandId?: string;
    beforeStatus?: () => void | Promise<void>;
    beforeCommand?: () => void | Promise<void>;
    async frame(lease: ControlLease): Promise<Frame> {
      if (!this.leases.has(lease.id)) throw new Error("Stopped");
      return {
        id: `source_${this.frameSequence}`,
        capturedAt: f.clock(),
        width: 2000,
        height: 1000,
        camera: {
          version: 1,
          surface: displayCamera.surface,
          geometryGeneration: "geometry_1",
          contentRevision: "content_1",
          source: {
            width: 2000,
            height: 1000,
            originX: -1000,
            originY: 0,
            pointWidth: 1000,
            pointHeight: 500,
            displayOriginX: -1000,
            displayOriginY: 0,
            displayPointWidth: 1000,
            displayPointHeight: 500,
          },
        },
        ...this.frameOverride,
      };
    }
    async action(
      lease: ControlLease,
      frame: Frame,
      action: InputAction,
      actionId: string,
      presentation?: PresentationReference,
    ) {
      this.dispatched.push({ frame, action, presentation });
      const result = await super.action(lease, frame, action, actionId);
      this.frameSequence++;
      return result;
    }
    async readiness() {
      return {
        cameraVersion: this.cameraVersion,
        controlPolicy: "agent_tools_with_fallback",
        policyRevision: 1,
        controlAllowed: true,
        armed: true,
        available: true,
        screenPermission: true,
        viewAllowed: true,
        displayAttached: true,
        activeLease: this.leases.size > 0,
        activeLeaseId: this.leases.keys().next().value,
        ...this.readinessOverride,
      };
    }
    async cameraStatus(lease: ControlLease): Promise<CameraStatus> {
      this.statusCalls++;
      await this.beforeStatus?.();
      return {
        version: 1,
        sessionId: lease.sessionId,
        deviceId: lease.deviceId,
        leaseId: lease.id,
        revision: this.revision,
        state: "live",
        surface: displayCamera.surface,
        sourceFrameId: `source_${this.frameSequence}`,
        capturedAt: f.clock(),
        geometryGeneration: "geometry_1",
        contentRevision: "content_1",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        source: {
          width: 2000,
          height: 1000,
          originX: -1000,
          originY: 0,
          pointWidth: 1000,
          pointHeight: 500,
          displayOriginX: -1000,
          displayOriginY: 0,
          displayPointWidth: 1000,
          displayPointHeight: 500,
        },
        output: {
          width: 1280,
          height: 720,
          viewport: { x: 0, y: 40, width: 1280, height: 640 },
        },
        pinned: false,
        moving: false,
        annotations: [],
        context: null,
        ...this.statusOverride,
      };
    }
    async cameraCommand(_lease: ControlLease, command: CameraCommand) {
      await this.beforeCommand?.();
      this.commands.push(command);
      return {
        version: 1 as const,
        commandId: this.receiptCommandId ?? command.commandId,
        revision: ++this.revision,
        state: "accepted" as const,
      };
    }
  }
  const device = new CameraDevice();
  const control = new ControlCoordinator(f.store, device, f.clock);
  const human = new HumanRouter(f.service, control);
  const viewing = new Viewing(f.store, device, f.clock, false, enabled);
  const agent = f.service.registerSession(
    f.pairing.token,
    opted
      ? registration
      : {
          ...registration,
          screenCamera: undefined,
          capabilities: { cooperativePause: true, polling: true },
        },
  );
  const request = f.service.requestAttention(agent.token, {
    taskId: "camera-task",
    idempotencyKey: "camera-review",
    reason: "review",
    question: "Review synthetic disposable camera content.",
  });
  await f.service.drain();
  f.service.observeCall(request.id, "connected", true);
  await viewing.tick();
  const app = createApp(f.service, control, human, {
    origin: "http://127.0.0.1",
    simulation: true,
    mediaToken: "m".repeat(64),
    screenCameraEnabled: enabled,
  });
  const api = (body?: unknown, token = agent.token) =>
    app.request(`/api/attention/${request.id}/conversation/camera`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const policy = (negotiate = true) =>
    app.request(`/media/${mediaSessionId(request.id)}/policy`, {
      headers: {
        authorization: `Bearer ${"m".repeat(64)}`,
        ...(negotiate ? { "X-ClawdTime-Camera": "1" } : {}),
      },
    });
  const execution = (path: string, body?: unknown) =>
    app.request(`/api/attention/${request.id}/conversation/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    ...f,
    device,
    control,
    human,
    viewing,
    agent,
    request,
    app,
    api,
    policy,
    execution,
  };
}

const focus = {
  version: 1,
  commandId: "focus_1",
  expectedRevision: 0,
  sourceFrameId: "source_1",
  geometryGeneration: "geometry_1",
  op: "focus_region",
  rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
  durationMs: 450,
  automatic: false,
};

describe("screen camera authenticated API and existing viewing lease", () => {
  it("forwards a bounded camera command through the exact lease without claiming input ownership", async () => {
    const f = await cameraFixture();
    const response = await f.api();
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({
      version: 1,
      sessionId: f.agent.session.id,
      deviceId: "fixture-mac",
      sourceFrameId: "source_1",
      state: "live",
    });
    const commanded = await f.api(focus);
    expect(commanded.status).toBe(200);
    expect(await commanded.json()).toMatchObject({
      commandId: "focus_1",
      state: "accepted",
    });
    expect(f.device.commands).toEqual([focus]);
    expect(f.device.inputs).toHaveLength(0);
    expect(f.store.all("execution")).toHaveLength(0);
    expect(f.store.all("action")).toHaveLength(0);
    expect(f.store.all<ControlLease>("lease")[0]?.mode).toBe("view");
    expect(f.transport.calls).toHaveLength(1);
  });

  it("requires backend opt-in, session opt-in and a version-qualified peer", async () => {
    for (const [enabled, opted] of [
      [false, true],
      [true, false],
    ]) {
      const f = await cameraFixture(enabled, opted);
      expect((await f.api()).status).toBe(409);
      expect((await f.api(focus)).status).toBe(409);
      expect(f.device.commands).toHaveLength(0);
      expect(f.device.statusCalls).toBe(0);
    }
    const old = await cameraFixture();
    old.device.cameraVersion = undefined;
    expect((await old.api()).status).toBe(409);
    expect((await old.api(focus)).status).toBe(409);
    expect(old.device.commands).toHaveLength(0);
  });

  it("rejects a different registered session before contacting the camera", async () => {
    const f = await cameraFixture();
    const other = f.service.registerSession(f.pairing.token, {
      ...registration,
      externalSessionId: "other-session",
    });
    expect((await f.api(undefined, other.token)).status).toBe(404);
    expect((await f.api(focus, other.token)).status).toBe(404);
    expect(f.device.statusCalls).toBe(0);
    expect(f.device.commands).toHaveLength(0);
  });

  it("rejects stale or mismatched frame responses instead of exposing another source", async () => {
    const f = await cameraFixture();
    const overrides: Partial<CameraStatus>[] = [
      { sessionId: "other_session" },
      { deviceId: "other_mac" },
      { leaseId: "other_lease" },
      { surface: { kind: "window", id: "7", displayId: 1, ownerPid: 123 } },
      { capturedAt: f.clock() - 2001 },
      { capturedAt: f.clock() + 10000 },
      { sourceFrameId: null },
      { geometryGeneration: null },
      { source: null },
    ];
    for (const override of overrides) {
      f.device.statusOverride = override;
      expect((await f.api()).status).toBeGreaterThanOrEqual(400);
    }
    expect(f.device.inputs).toHaveLength(0);
  });

  it("revalidates Stop, revocation, expiry and lease identity across camera awaits", async () => {
    for (const invalidate of [
      (f: Awaited<ReturnType<typeof cameraFixture>>) =>
        f.store.saveState(`view-stopped:${f.request.id}`, true),
      (f: Awaited<ReturnType<typeof cameraFixture>>) =>
        f.store.put("pairing", { ...f.pairing.pairing, revokedAt: f.clock() }),
      (f: Awaited<ReturnType<typeof cameraFixture>>) => f.advance(20001),
      (f: Awaited<ReturnType<typeof cameraFixture>>) => {
        const lease = f.store.all<ControlLease>("lease")[0]!;
        f.store.put("lease", { ...lease, state: "released" });
      },
    ]) {
      const f = await cameraFixture();
      f.device.beforeStatus = () => {
        invalidate(f);
      };
      expect((await f.api()).status).toBeGreaterThanOrEqual(400);
      expect((await f.api(focus)).status).toBeGreaterThanOrEqual(400);
      expect(f.device.commands).toHaveLength(0);
      expect(f.device.inputs).toHaveLength(0);
    }
  });

  it("rejects malformed or unbounded commands before media dispatch", async () => {
    const f = await cameraFixture();
    for (const body of [
      { ...focus, arbitraryMouseBypass: true },
      { ...focus, rect: { x: 0.9, y: 0, width: 0.5, height: 1 } },
      { ...focus, rect: { x: 0, y: 0, width: 0, height: 1 } },
      { ...focus, durationMs: 1501 },
      { ...focus, expectedRevision: -1 },
      { ...focus, sourceFrameId: "" },
      { ...focus, version: 2 },
    ])
      expect((await f.api(body)).status).toBe(400);
    expect(f.device.commands).toHaveLength(0);
    expect(f.device.inputs).toHaveLength(0);
  });

  it("publishes only the negotiated surface and never silently widens a camera session", async () => {
    const enabled = await cameraFixture();
    const selected = await (await enabled.policy()).json();
    expect(selected.screenSelection).toMatchObject({
      sessionId: enabled.agent.session.id,
      cameraVersion: 1,
      surface: displayCamera.surface,
    });
    const disabled = await cameraFixture(false);
    expect(await (await disabled.policy()).json()).not.toHaveProperty(
      "screenSelection",
    );
    const stopped = await cameraFixture();
    stopped.store.saveState(`view-stopped:${stopped.request.id}`, true);
    expect(await (await stopped.policy()).json()).not.toHaveProperty(
      "screenSelection",
    );
    await stopped.viewing.tick();
    expect(await (await stopped.policy()).json()).not.toHaveProperty(
      "screenSelection",
    );
    const legacy = await cameraFixture(true, false);
    const old = await (await legacy.policy(false)).json();
    expect(old.screenSelection).toBeDefined();
    expect(old.screenSelection).not.toHaveProperty("cameraVersion");
    expect(old.screenSelection).not.toHaveProperty("surface");
  });

  it("requires the exact active helper lease and matching local policy revision", async () => {
    const f = await cameraFixture();
    for (const override of [
      { activeLeaseId: "other_lease" },
      { policyRevision: 2 },
      { activeLease: false },
      { screenPermission: false },
      { armed: false },
      { viewAllowed: false },
      { available: false },
      { displayAttached: false },
    ]) {
      f.device.readinessOverride = override;
      expect((await f.api()).status).toBe(409);
      expect((await f.api(focus)).status).toBe(409);
    }
    expect(f.device.statusCalls).toBe(0);
    expect(f.device.commands).toHaveLength(0);
  });

  it("does not acknowledge a raced Stop or a receipt for another command", async () => {
    const f = await cameraFixture();
    f.device.beforeCommand = () => {
      f.store.saveState(`view-stopped:${f.request.id}`, true);
    };
    expect((await f.api(focus)).status).toBeGreaterThanOrEqual(400);
    expect(f.device.commands).toHaveLength(1);
    expect(f.device.inputs).toHaveLength(0);
    const other = await cameraFixture();
    other.device.receiptCommandId = "wrong_command";
    expect((await other.api(focus)).status).toBe(409);
    expect(other.device.commands).toHaveLength(1);
  });

  it("rejects a restarted control authority without replaying camera work", async () => {
    const f = await cameraFixture();
    expect((await f.api(focus)).status).toBe(200);
    new ControlCoordinator(f.store, f.device, f.clock);
    expect((await f.api()).status).toBe(409);
    expect((await f.api(focus)).status).toBe(409);
    expect(f.device.commands).toHaveLength(1);
    expect(f.device.inputs).toHaveLength(0);
  });
});

describe("screen camera preserves the existing CUA ownership and receipts", () => {
  const claim = {
    expectedEpoch: 0,
    executor: "clawdtime",
    previousOutcome: "idle",
    backgroundActorsStopped: true,
    expectedCursor: 0,
  };
  const act = {
    epoch: 1,
    actionId: "camera_click_1",
    frameId: "source_1",
    action: { kind: "click", x: 0.5, y: 0.5 },
    expectedCursor: 0,
    presentation: {
      revision: 0,
      sourceFrameId: "source_1",
      geometryGeneration: "geometry_1",
    },
  };

  it("requires ownership, keeps pristine observations, forwards the exact transform reference and observes once", async () => {
    const f = await cameraFixture();
    expect((await f.execution("act", act)).status).toBeGreaterThanOrEqual(400);
    expect(f.device.inputs).toHaveLength(0);
    expect((await f.execution("execution", claim)).status).toBe(200);
    const observation = await f.execution("observe", { epoch: 1 });
    expect(observation.status).toBe(200);
    expect(await observation.json()).toMatchObject({
      frame: {
        id: "source_1",
        width: 2000,
        height: 1000,
        camera: {
          geometryGeneration: "geometry_1",
          surface: displayCamera.surface,
        },
      },
    });
    const result = await f.execution("act", act);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      id: "camera_click_1",
      state: "observed",
      afterFrame: { id: "source_2" },
    });
    expect(f.device.inputs).toEqual(["camera_click_1"]);
    expect(f.device.dispatched[0]).toMatchObject({
      frame: { id: "source_1", width: 2000, height: 1000 },
      action: act.action,
      presentation: act.presentation,
    });
    // A repeated action reconciles the original receipt after its view changed.
    const replay = await f.execution("act", act);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: "camera_click_1",
      state: "observed",
      afterFrame: { id: "source_2" },
    });
    expect(f.device.inputs).toHaveLength(1);
    expect(f.store.get<ActionReceipt>("action", "camera_click_1")?.state).toBe(
      "observed",
    );
    expect(
      (
        await f.execution("execution", {
          ...claim,
          expectedEpoch: 1,
          executor: "none",
          previousOutcome: "completed",
        })
      ).status,
    ).toBe(200);
  });

  it("rejects frozen, moving, changed generation and changed camera revision before input", async () => {
    for (const override of [
      { state: "paused" as const },
      { moving: true },
      { revision: 1 },
      { geometryGeneration: "geometry_2" },
      { sourceFrameId: "source_2" },
    ]) {
      const f = await cameraFixture();
      expect((await f.execution("execution", claim)).status).toBe(200);
      expect((await f.execution("observe", { epoch: 1 })).status).toBe(200);
      f.device.statusOverride = override;
      expect((await f.execution("act", act)).status).toBe(409);
      expect(f.device.inputs).toHaveLength(0);
      expect(f.store.all("action")).toHaveLength(0);
    }
  });

  it("rejects a zoom revision that changes during validation and still honors pending human corrections", async () => {
    const f = await cameraFixture();
    await f.execution("execution", claim);
    await f.execution("observe", { epoch: 1 });
    f.device.beforeStatus = () => {
      f.device.revision++;
    };
    expect((await f.execution("act", act)).status).toBe(409);
    expect(f.device.inputs).toHaveLength(0);
    f.device.beforeStatus = undefined;
    f.device.revision = 0;
    await f.human.receive({
      eventId: "correction",
      requestId: f.request.id,
      memberId: "fixture-human",
      lineId: "fixture-line",
      conversationId: "fixture-conversation",
      channel: "text",
      text: "Wait for the next synthetic choice.",
    });
    expect((await f.execution("act", act)).status).toBe(409);
    expect(f.device.inputs).toHaveLength(0);
  });

  it("does not admit unreferenced source input from a frozen camera", async () => {
    const f = await cameraFixture();
    await f.execution("execution", claim);
    await f.execution("observe", { epoch: 1 });
    f.device.statusOverride = { state: "paused" };
    const { presentation: _reference, ...sourceAction } = act;
    expect((await f.execution("act", sourceAction)).status).toBe(409);
    expect(f.device.inputs).toHaveLength(0);
  });

  it("refuses missing, wrong-surface and inconsistent pristine observation metadata", async () => {
    const f = await cameraFixture();
    expect((await f.execution("execution", claim)).status).toBe(200);
    const lease = f.store.all<ControlLease>("lease")[0]!;
    const valid = await f.device.frame(lease);
    for (const override of [
      { camera: undefined },
      {
        camera: {
          ...valid.camera!,
          surface: {
            kind: "window" as const,
            id: "7",
            displayId: 1,
            ownerPid: 123,
          },
        },
      },
      { width: 1999 },
      { height: 999 },
    ]) {
      f.device.frameOverride = override;
      expect(
        (await f.execution("observe", { epoch: 1 })).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(f.store.state(`frame:${lease.id}`)).toBeUndefined();
    expect(f.device.inputs).toHaveLength(0);
  });

  it("cannot repurpose a completed input ID with a different presentation reference", async () => {
    const f = await cameraFixture();
    await f.execution("execution", claim);
    await f.execution("observe", { epoch: 1 });
    expect((await f.execution("act", act)).status).toBe(200);
    expect(
      (
        await f.execution("act", {
          ...act,
          presentation: { ...act.presentation, revision: 1 },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.device.inputs).toHaveLength(1);
    expect(f.store.all("action")).toHaveLength(1);
  });

  it("does not attach a misleading pixel transform to keyboard input", async () => {
    const f = await cameraFixture();
    await f.execution("execution", claim);
    await f.execution("observe", { epoch: 1 });
    expect(
      (
        await f.execution("act", {
          ...act,
          action: { kind: "type", text: "disposable" },
        })
      ).status,
    ).toBe(400);
    expect(f.device.inputs).toHaveLength(0);
    expect(f.store.all("action")).toHaveLength(0);
  });
});
