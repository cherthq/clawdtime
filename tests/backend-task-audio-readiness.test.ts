import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { hash } from "../src/storage/security.js";
import { NativeTaskAudioReadiness } from "../src/transport/task-audio-readiness.js";
import {
  taskAudioFingerprint,
  taskHandsetFingerprint,
  type TaskAudioPlan,
} from "../src/transport/task-audio.js";
import type { TaskWalkthroughPlan } from "../src/task-walkthrough-contracts.js";
const stores: Store[] = [];
afterEach(() => {
  stores.forEach((store) => store.close());
  stores.length = 0;
});
function fixture() {
  const store = new Store();
  stores.push(store);
  let now = 1_000_000;
  const binding = {
    origin: "https://native.example.invalid",
    token: "synthetic-token-only",
    signingSecret: "synthetic-signing-only",
    lineId: "22222222-2222-4222-8222-222222222222",
    providerLineId: "provider",
    phone: "+15550000002",
    instanceId: "instance",
  };
  const plan: TaskAudioPlan = {
    id: "attempt",
    taskSessionId: "session",
    taskId: "task",
    runId: "run",
    revision: 4,
    voiceSessionId: "voice",
    pairingId: "pair",
    memberId: "member",
    deviceId: "mac",
    lineId: binding.lineId,
    recipientHash: hash("+15550000001"),
    mediaSessionId: "media",
    workerIdentity: "incoming",
    agentIdentity: "outgoing",
    expiresAt: now + 240000,
    audio: true,
    video: false,
    screen: false,
    presentation: false,
    control: false,
    maxCalls: 1,
  };
  const authorization = {
    id: "auth",
    planFingerprint: taskAudioFingerprint(plan),
    authorizedAt: now,
    expiresAt: now + 240000,
    oneCallAuthorized: true as const,
  };
  const handoff = {
    owner: "clawdtime" as const,
    sourceOwnerPaused: true as const,
    phone: binding.phone,
    identityEvidence: "synthetic join",
    sourcePauseEvidence: "synthetic paused",
    lineId: binding.lineId,
    providerLineId: binding.providerLineId,
    instanceId: binding.instanceId,
    baseline: { sequence: 4, eventId: "e4" },
    checkedAt: now,
    rollbackRecord: "synthetic rollback",
  };
  store.saveState(`messages:${binding.lineId}`, handoff.baseline);
  store.put("pairing", {
    id: plan.pairingId,
    memberId: plan.memberId,
    deviceId: plan.deviceId,
    lineId: binding.lineId,
    recipient: "+15550000001",
  });
  const ready: Record<string, unknown> = {
    control_ready: true,
    facetime_signed_in: true,
    accessibility_ready: true,
    audio_ready: true,
    video_ready: false,
    screen_capture_ready: false,
    production_media_ready: false,
    automatic: {
      runtime_started_at: new Date(now - 1000).toISOString(),
      started_at: new Date(now - 500).toISOString(),
      completed_at: new Date(now).toISOString(),
      checks: [
        "accessibility",
        "facetime_signed_in",
        "audio_devices",
        "facetime_selections",
        "playback_renderer",
        "configuration",
        "control_plane_poll",
        "system_audio_capture",
      ].map((id) => ({
        id,
        outcome: "passed",
        completed_at: new Date(now).toISOString(),
      })),
    },
  };
  const line: Record<string, any> = {
    id: binding.lineId,
    phone_number: binding.phone,
    current_call_id: null,
    worker_occupied: false,
    status: "available",
    session_health: {
      line_id: binding.lineId,
      identity_confirmed: true,
      last_heartbeat_at: new Date(now).toISOString(),
      status: "accepting",
      readiness: ready,
      capabilities: { outbound_audio_protocol: 1 },
    },
  };
  const worker: Record<string, any> = {};
  let onRequest = () => {};
  const request = vi.fn<typeof fetch>(async (url, init) => {
    onRequest();
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    const body =
      path === "/api/v1/whoami"
        ? {
            healthy: true,
            phone_line: {
              phone_line_id: binding.providerLineId,
              phone_number: binding.phone,
              instance_id: binding.instanceId,
            },
          }
        : path === "/api/v1/events/4"
          ? {
              sequence: 4,
              event_id: "e4",
              type: "fixture",
              phone_line_id: binding.providerLineId,
              payload: {},
            }
          : path === "/api/v1/lines"
            ? { data: { items: [line], total: 1, limit: 100, offset: 0 } }
            : path === "/api/v1/workers"
              ? { data: { items: [worker], total: 1, limit: 100, offset: 0 } }
              : (() => {
                  throw new Error("unexpected endpoint");
                })();
    return new Response(JSON.stringify(body));
  });
  const adapter = new NativeTaskAudioReadiness(
    {
      get: store.get.bind(store),
      all: store.all.bind(store),
      state: store.state.bind(store),
      effects: store.effects.bind(store),
    },
    {
      binding,
      callsOrigin: "https://calls.example.invalid",
      projectId: "project",
      projectKey: "synthetic-key-only",
      handoff: () => handoff,
    },
    request,
    () => now,
  );
  return {
    store,
    worker,
    adapter,
    plan,
    authorization,
    binding,
    handoff,
    line,
    ready,
    request,
    check: () => adapter.check(plan, authorization),
    advance: (ms: number) => (now += ms),
    onRequest: (callback: () => void) => (onRequest = callback),
  };
}
describe("read-only native task audio readiness", () => {
  it("requires no legacy media/gateway/video and preserves the exact cursor", async () => {
    const f = fixture();
    expect(f.request).not.toHaveBeenCalled();
    expect(await f.check()).toMatchObject({
      source: "operator_verified_native",
      idle: true,
      audioReady: true,
      cursorPreserved: true,
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.store.state(`messages:${f.binding.lineId}`)).toEqual(
      f.handoff.baseline,
    );
    expect(f.request.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        f.binding.origin + "/api/v1/whoami",
        f.binding.origin + "/api/v1/events/4",
        "https://calls.example.invalid/api/v1/lines?limit=100&offset=0",
      ]),
    );
  });
  it("accepts only explicit deferred system-audio readiness, without claiming physical capture", async () => {
    const f = fixture();
    f.ready.audio_ready = false;
    await expect(f.check()).rejects.toThrow(/audio readiness/);
    const automatic = f.ready.automatic as {
      checks: { id: string; outcome: string; completed_at: string | null }[];
    };
    const capture = automatic.checks.find(
      (c) => c.id === "system_audio_capture",
    )!;
    capture.outcome = "at_call_start";
    capture.completed_at = null;
    expect((await f.check()).audioReady).toBe(true);
    f.ready.automatic = {
      checks: [
        {
          id: "system_audio_capture",
          outcome: "at_call_start",
          completed_at: null,
        },
      ],
    };
    await expect(f.check()).rejects.toThrow(/audio readiness/);
  });
  it.each(["busy", "heartbeat", "identity", "worker", "audio"])(
    "blocks %s evidence",
    async (reason) => {
      const f = fixture();
      if (reason === "busy") f.line.current_call_id = "other";
      if (reason === "heartbeat")
        f.line.session_health.last_heartbeat_at = new Date(0).toISOString();
      if (reason === "identity")
        f.line.session_health.identity_confirmed = false;
      if (reason === "worker") f.line.worker_occupied = true;
      if (reason === "audio") f.ready.audio_ready = false;
      await expect(f.check()).rejects.toThrow();
    },
  );
  it.each(["missing", "failed", "stale", "duplicate", "snapshot", "protocol"])(
    "rejects %s audio prerequisites even with audio_ready true",
    async (reason) => {
      const f = fixture();
      const automatic = f.ready.automatic as {
        runtime_started_at: string;
        started_at: string;
        completed_at: string;
        checks: { id: string; outcome: string; completed_at: string }[];
      };
      const device = automatic.checks.find((c) => c.id === "audio_devices")!;
      if (reason === "missing")
        automatic.checks = automatic.checks.filter((c) => c !== device);
      if (reason === "failed") device.outcome = "failed";
      if (reason === "stale") device.completed_at = new Date(0).toISOString();
      if (reason === "duplicate") automatic.checks.push({ ...device });
      if (reason === "snapshot")
        automatic.started_at = new Date(1_100_000).toISOString();
      if (reason === "protocol")
        f.line.session_health.capabilities.outbound_audio_protocol = 0;
      await expect(f.check()).rejects.toThrow();
    },
  );
  it.each([NaN, Infinity])(
    "rejects malformed authorization timestamps %s before reads",
    async (bad) => {
      const f = fixture();
      f.authorization.expiresAt = bad;
      await expect(f.check()).rejects.toThrow(/authorization/);
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("refuses stale ownership, wrong recipient and unresolved legacy state before network", async () => {
    const f = fixture();
    f.handoff.checkedAt -= 300001;
    await expect(f.check()).rejects.toThrow(/ownership/);
    expect(f.request).not.toHaveBeenCalled();
    const g = fixture();
    g.store.put("pairing", {
      id: "pair",
      memberId: "member",
      deviceId: "mac",
      lineId: g.plan.lineId,
      recipient: "+15550000009",
    });
    await expect(g.check()).rejects.toThrow(/pairing/);
    expect(g.request).not.toHaveBeenCalled();
    const h = fixture();
    h.store.put("call", { id: "prior", state: "unknown" });
    await expect(h.check()).rejects.toThrow(/reconciliation/);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses ownership changes during GET and never retries failed native reads", async () => {
    const f = fixture();
    f.onRequest(() => {
      f.handoff.sourcePauseEvidence = "changed";
    });
    await expect(f.check()).rejects.toThrow(/changed/);
    expect(f.request).toHaveBeenCalledTimes(3);
    const g = fixture();
    g.request.mockRejectedValue(new Error("synthetic network failure"));
    await expect(g.check()).rejects.toThrow(/could not be verified/);
    expect(g.request).toHaveBeenCalledTimes(3);
  });
});

function videoFixture() {
  const f = fixture(),
    now = f.authorization.authorizedAt,
    runtimeId = "33333333-3333-4333-8333-333333333333";
  const automatic = f.ready.automatic as Record<string, any>;
  Object.assign(automatic, {
    version: 1,
    worker_id: "worker",
    runtime_id: runtimeId,
    build: hash("build"),
    device_binding: hash("device"),
    config_binding: hash("config"),
    profile: "audio_video",
  });
  automatic.checks.push(
    ...["video_resources", "screen_capture"].map((id) => ({
      id,
      outcome: "passed",
      completed_at: new Date(now).toISOString(),
    })),
  );
  Object.assign(f.ready, {
    runtime_id: runtimeId,
    build: automatic.build,
    device_binding: automatic.device_binding,
    config_binding: automatic.config_binding,
  });
  Object.assign(f.line, {
    worker_id: "worker",
    supports_audio: true,
    supports_video: true,
  });
  Object.assign(f.line.session_health.capabilities, {
    video: true,
    outbound_video_protocol: 1,
  });
  Object.assign(f.worker, {
    id: "worker",
    enabled: true,
    status: "accepting",
    current_call_id: null,
    automatic_readiness_enabled: true,
    last_heartbeat_at: new Date(now).toISOString(),
    capabilities: { ...f.line.session_health.capabilities },
    readiness: structuredClone(f.ready),
  });
  const plan: TaskWalkthroughPlan = {
    ...f.plan,
    version: 1,
    mode: "handset_walkthrough",
    exportGrantId: "export",
    callKind: "review",
    dispatchExpiresAt: f.plan.expiresAt,
    expiresAt: now + 900000,
    presentationBinding: {
      presentationId: "presentation",
      manifestFingerprint: hash("manifest"),
      presentationGrantId: "grant",
      verificationId: "verification",
      hostId: "host",
      captureDeviceId: f.plan.deviceId,
    },
    video: true,
    screen: true,
    presentation: true,
    instructions: true,
    nativeActivation: false,
  };
  const authorization = {
    ...f.authorization,
    planFingerprint: taskHandsetFingerprint(plan),
    callExpiresAt: plan.expiresAt,
  };
  return { ...f, plan, authorization };
}
describe("distinct native walkthrough readiness", () => {
  it("joins exact worker and session automatic evidence without claiming presentation or physical acceptance", async () => {
    const f = videoFixture();
    const evidence = await f.adapter.checkWalkthrough(f.plan, f.authorization);
    expect(evidence.videoReady).toBe(true);
    expect(evidence.presentationReady).toBeUndefined();
    expect(
      f.request.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toContain("/api/v1/workers");
  });
  it.each([
    "line_video",
    "worker_video",
    "worker_protocol",
    "session_protocol",
    "worker_binding",
    "session_runtime",
    "check_failure",
    "check_stale",
    "aggregate_only",
  ])("refuses missing or inconsistent %s evidence", async (kind) => {
    const f = videoFixture();
    if (kind === "line_video") f.line.supports_video = false;
    if (kind === "worker_video") f.worker.capabilities.video = false;
    if (kind === "worker_protocol")
      delete f.worker.capabilities.outbound_video_protocol;
    if (kind === "session_protocol")
      delete f.line.session_health.capabilities.outbound_video_protocol;
    if (kind === "worker_binding")
      f.worker.readiness.automatic.config_binding = hash("other");
    if (kind === "session_runtime")
      (f.ready.automatic as Record<string, any>).runtime_id =
        "44444444-4444-4444-8444-444444444444";
    if (kind === "check_failure")
      f.worker.readiness.automatic.checks.find(
        (c: any) => c.id === "video_resources",
      ).outcome = "failed";
    if (kind === "check_stale")
      f.worker.readiness.automatic.checks.find(
        (c: any) => c.id === "screen_capture",
      ).completed_at = new Date(
        f.authorization.authorizedAt - 90000,
      ).toISOString();
    if (kind === "aggregate_only") {
      f.worker.readiness.video_ready = true;
      delete f.worker.readiness.automatic;
    }
    await expect(
      f.adapter.checkWalkthrough(f.plan, f.authorization),
    ).rejects.toThrow(/video readiness/);
  });
});
