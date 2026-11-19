import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import {
  TaskAudioCallCoordinator,
  hasConnectedTaskWalkthroughCall,
} from "../src/attention/task-audio-call.js";
import {
  HttpTaskHandsetMediaPort,
  NativeTaskAudioCalls,
  taskHandsetMediaFingerprint,
  taskAudioRoomName,
  taskHandsetFingerprint,
  taskAudioFingerprint,
  type TaskAudioPlan,
  type TaskHandsetPorts,
  type TaskHandsetMediaObservation,
} from "../src/transport/task-audio.js";
import type {
  TaskWalkthroughPlan,
  TaskWalkthroughAuthorization,
} from "../src/task-walkthrough-contracts.js";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});
const callId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  let now = 1_000_000;
  const store = new Store();
  stores.push(store);
  const vault = new Vault("ab".repeat(32));
  const plan: TaskWalkthroughPlan = {
    version: 1,
    mode: "handset_walkthrough",
    id: "call",
    taskSessionId: "session",
    taskId: "task",
    runId: "run",
    revision: 4,
    voiceSessionId: "voice",
    pairingId: "pair",
    memberId: "member",
    deviceId: "mac",
    lineId: "22222222-2222-4222-8222-222222222222",
    recipientHash: hash("synthetic"),
    mediaSessionId: "media",
    workerIdentity: "worker",
    agentIdentity: "agent",
    exportGrantId: "export",
    callKind: "review",
    presentationBinding: {
      presentationId: "presentation",
      manifestFingerprint: hash("manifest"),
      presentationGrantId: "localgrant",
      verificationId: "verification",
      hostId: "host",
      captureDeviceId: "mac",
    },
    dispatchExpiresAt: now + 240_000,
    expiresAt: now + 1_500_000,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    instructions: true,
    control: false,
    nativeActivation: false,
    maxCalls: 1,
  };
  const auth: TaskWalkthroughAuthorization = {
    id: "authorization",
    planFingerprint: taskHandsetFingerprint(plan),
    authorizedAt: now,
    expiresAt: plan.dispatchExpiresAt,
    callExpiresAt: plan.expiresAt,
    oneCallAuthorized: true,
  };
  let mediaState: TaskHandsetMediaObservation["state"] = "absent",
    nativeState: "connected" | "terminal" = "connected";
  const observation = (): TaskHandsetMediaObservation => ({
    callAttemptId: plan.id,
    mediaSessionId: plan.mediaSessionId,
    state: mediaState,
    mode: "handset_walkthrough",
    instructions: true,
    nativeActivation: false,
    planFingerprint: taskHandsetFingerprint(plan),
    sharingActive: mediaState !== "closed",
    videoEvidence: {
      evidence: "sdk_frame_accepted_not_remote_seen",
      presentationId: plan.presentationBinding.presentationId,
      manifestFingerprint: plan.presentationBinding.manifestFingerprint,
      sceneId: "overview",
      generation: 1,
      sourceFrameId: "source",
      geometryGeneration: hash("geometry"),
      capturedAt: now,
      renderedAt: now,
      acceptedAt: now,
    },
    exportGrantId: plan.exportGrantId,
    presentationBinding: plan.presentationBinding,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    control: false,
    ...(mediaState === "active" ? { providerCallId: callId } : {}),
  });
  const ports: TaskHandsetPorts = {
    authorize: vi.fn(() => {}),
    readiness: vi.fn(async () => ({
      source: "synthetic" as const,
      checkedAt: now,
      planFingerprint: auth.planFingerprint,
      lineId: plan.lineId,
      pairingId: plan.pairingId,
      memberId: plan.memberId,
      deviceId: plan.deviceId,
      recipientHash: plan.recipientHash,
      idle: true,
      exclusiveOwner: true,
      identityVerified: true,
      cursorPreserved: true,
      cleanupClear: true,
      audioReady: true,
      videoReady: true,
      presentationReady: true,
    })),
    media: {
      prepare: vi.fn(async () => {
        mediaState = "prepared";
        return {
          ...observation(),
          credentials: {
            livekit_url: "wss://example.invalid",
            participant_token: "x".repeat(50),
            remote_participant_identity: plan.agentIdentity,
          },
          silentPublisherReady: true as const,
          videoPublisherReady: true,
        };
      }),
      activate: vi.fn(async () => {
        mediaState = "active";
        return observation();
      }),
      inspect: vi.fn(async () => observation()),
      close: vi.fn(async () => {
        mediaState = "closed";
        return observation();
      }),
    },
    calls: {
      create: vi.fn(async () => ({
        providerCallId: callId,
        lineId: plan.lineId,
      })),
      inspect: vi.fn(async () => ({
        providerCallId: callId,
        state: nativeState,
        cleanupComplete: nativeState === "terminal",
      })),
      end: vi.fn(async () => ({
        accepted: true as const,
        providerCallId: callId,
      })),
    },
  };
  const coordinator = new TaskAudioCallCoordinator(store, vault, ports, {
    dispatchEnabled: true,
    clock: () => now,
  });
  const connect = async () => {
    coordinator.reserve(plan, auth);
    await coordinator.prepare(plan.id);
    await coordinator.dial(plan.id);
    await coordinator.activate(plan.id);
  };
  return {
    store,
    vault,
    plan,
    auth,
    ports,
    coordinator,
    connect,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    terminal: () => {
      nativeState = "terminal";
    },
  };
}
describe("walkthrough call admission", () => {
  it("uses the same effect receipts and fences stale, failed and ended native proofs", async () => {
    const f = fixture();
    await f.connect();
    expect(f.coordinator.status(f.plan.id).state).toBe("connected");
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(true);
    f.advance(5001);
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(false);
    await f.coordinator.inspect(f.plan.id);
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(true);
    vi.mocked(f.ports.calls.inspect).mockRejectedValueOnce(
      new Error("unavailable"),
    );
    await f.coordinator.inspect(f.plan.id);
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(false);
    await f.coordinator.inspect(f.plan.id);
    f.terminal();
    await f.coordinator.inspect(f.plan.id);
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(false);
  });
  it("keeps a connected conversation past dispatch expiry without admitting another effect", async () => {
    const f = fixture();
    await f.connect();
    f.advance(300_000);
    await f.coordinator.inspect(f.plan.id);
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(true);
    await f.coordinator.activate(f.plan.id);
    expect(f.ports.media.activate).toHaveBeenCalledTimes(1);
    f.advance(1_200_000);
    expect(
      hasConnectedTaskWalkthroughCall(f.store, f.vault, f.plan, f.now()),
    ).toBe(false);
  });
  it("refuses long dispatch authority and missing independent video readiness before effects", async () => {
    const f = fixture();
    expect(() =>
      f.coordinator.reserve(f.plan, {
        ...f.auth,
        expiresAt: f.now() + 300_001,
      }),
    ).toThrow(/authority/);
    f.coordinator.reserve(f.plan, f.auth);
    const ready = await f.ports.readiness(f.plan, f.auth);
    vi.mocked(f.ports.readiness).mockResolvedValue({
      ...ready,
      videoReady: false,
    });
    await expect(f.coordinator.prepare(f.plan.id)).rejects.toThrow(/readiness/);
    expect(f.ports.media.prepare).not.toHaveBeenCalled();
  });
  it("keeps unknown walkthrough effects in the existing global fence after restart", async () => {
    const f = fixture();
    f.coordinator.reserve(f.plan, f.auth);
    vi.mocked(f.ports.media.prepare).mockRejectedValueOnce(new Error("lost"));
    expect((await f.coordinator.prepare(f.plan.id)).state).toBe("unknown");
    const next = { ...f.plan, id: "second" };
    expect(() =>
      f.coordinator.reserve(next, {
        ...f.auth,
        id: "new",
        planFingerprint: taskHandsetFingerprint(next),
      }),
    ).toThrow(/existing or unknown/);
    const restarted = new TaskAudioCallCoordinator(f.store, f.vault, f.ports, {
      clock: f.now,
    });
    await restarted.prepare(f.plan.id);
    expect(f.ports.media.prepare).toHaveBeenCalledTimes(1);
  });
  it("preserves historical audio fingerprints and rejects accidental widening", () => {
    const f = fixture();
    const {
      version,
      mode,
      exportGrantId,
      callKind,
      presentationBinding,
      dispatchExpiresAt,
      instructions,
      nativeActivation,
      ...base
    } = f.plan;
    const old: TaskAudioPlan = {
      ...base,
      video: false,
      screen: false,
      presentation: false,
      expiresAt: f.auth.expiresAt,
    };
    expect(taskHandsetFingerprint(old)).toBe(taskAudioFingerprint(old));
    expect(() =>
      taskHandsetFingerprint({
        ...old,
        video: true,
      } as unknown as TaskAudioPlan),
    ).toThrow();
  });
});

function mediaFixture() {
  const f = fixture(),
    request = vi.fn<typeof fetch>();
  const raw = {
    mode: "handset_walkthrough",
    instructions: true,
    nativeActivation: false,
    planFingerprint: taskHandsetFingerprint(f.plan),
    callAttemptId: f.plan.id,
    mediaSessionId: f.plan.mediaSessionId,
    roomName: taskAudioRoomName(f.plan.mediaSessionId),
    bindingFingerprint: taskHandsetMediaFingerprint(f.plan),
    exportGrantId: f.plan.exportGrantId,
    presentationBinding: f.plan.presentationBinding,
    state: "prepared",
    closed: false,
    nativeCallClosed: false,
    sharingActive: true,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    control: false,
    videoEvidence: {
      evidence: "sdk_frame_accepted_not_remote_seen",
      presentationId: f.plan.presentationBinding.presentationId,
      manifestFingerprint: f.plan.presentationBinding.manifestFingerprint,
      sceneId: "overview",
      generation: 1,
      sourceFrameId: "source",
      geometryGeneration: hash("geometry"),
      capturedAt: f.now() + 0.125,
      renderedAt: f.now() + 0.25,
      acceptedAt: f.now() + 0.5,
    },
    silentPublisherReady: true,
    videoPublisherReady: true,
    credentials: {
      livekit_url: "wss://example.invalid",
      participant_token: "x".repeat(50),
      remote_participant_identity: f.plan.agentIdentity,
    },
  };
  const port = new HttpTaskHandsetMediaPort(
    { origin: "http://127.0.0.1:3456", token: "x".repeat(32) },
    request,
  );
  return { ...f, request, raw, port };
}
describe("walkthrough media and native adapters", () => {
  it("retains bounded first-retirement diagnostics through closed status without treating them as success evidence", async () => {
    const f = mediaFixture();
    const sharingDiagnostics = {
      firstStop: {
        reason: "source_unavailable",
        mediaState: "active",
        elapsedMs: 1200,
        lastFrameAgeMs: 400,
      },
      sourceFrames: 18,
      renderedFrames: 17,
      presentationFailure: {
        phase: "source_capture",
        reason: "source_refused",
      },
    };
    f.request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...f.raw,
          state: "closed",
          closed: true,
          sharingActive: false,
          sharingDiagnostics,
        }),
      ),
    );
    const observation = await f.port.inspect(f.plan);
    expect(
      "sharingDiagnostics" in observation && observation.sharingDiagnostics,
    ).toEqual(sharingDiagnostics);
    expect(observation.state).toBe("closed");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![1]!.method).toBe("GET");
  });

  it("accepts a diagnostic snapshot before retirement without fabricating a cause", async () => {
    const f = mediaFixture(),
      sharingDiagnostics = {
        firstStop: null,
        sourceFrames: 0,
        renderedFrames: 0,
        presentationFailure: null,
      };
    f.request.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...f.raw, sharingDiagnostics })),
    );
    const observation = await f.port.inspect(f.plan);
    expect(
      "sharingDiagnostics" in observation && observation.sharingDiagnostics,
    ).toEqual(sharingDiagnostics);
  });

  it("retains authority retirement separately from task change and accepts saturated bounded counters", async () => {
    const f = mediaFixture();
    const sharingDiagnostics = {
      firstStop: {
        reason: "authority_retired",
        mediaState: "closing",
        elapsedMs: 1_800_000,
        lastFrameAgeMs: 1_800_000,
      },
      sourceFrames: 1_000_000,
      renderedFrames: 1_000_000,
      presentationFailure: null,
    };
    f.request.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...f.raw, sharingDiagnostics })),
    );
    const observation = await f.port.inspect(f.plan);
    expect(
      "sharingDiagnostics" in observation && observation.sharingDiagnostics,
    ).toEqual(sharingDiagnostics);
  });

  it.each([
    { sourceFrames: -1 },
    { sourceFrames: 1_000_001 },
    { renderedFrames: 0.5 },
    { extra: "unapproved text" },
    {
      firstStop: {
        reason: "raw_error",
        mediaState: "active",
        elapsedMs: 1,
        lastFrameAgeMs: null,
      },
    },
    {
      firstStop: {
        reason: "frame_stale",
        mediaState: "active",
        elapsedMs: 1_800_001,
        lastFrameAgeMs: null,
      },
    },
    {
      firstStop: {
        reason: "frame_stale",
        mediaState: "active",
        elapsedMs: 1,
        lastFrameAgeMs: -1,
      },
    },
    {
      firstStop: {
        reason: "frame_stale",
        mediaState: "arbitrary",
        elapsedMs: 1,
        lastFrameAgeMs: null,
      },
    },
    {
      firstStop: {
        reason: "frame_stale",
        mediaState: "active",
        elapsedMs: 1,
        lastFrameAgeMs: null,
        error: "private text",
      },
    },
    { presentationFailure: { phase: "raw_phase", reason: "other" } },
    { presentationFailure: { phase: "other", reason: "raw_error" } },
    {
      presentationFailure: {
        phase: "other",
        reason: "other",
        stack: "private text",
      },
    },
  ])(
    "refuses malformed or unallowlisted sharing diagnostics without retry: %j",
    async (override) => {
      const f = mediaFixture();
      f.request.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...f.raw,
            sharingDiagnostics: {
              firstStop: null,
              sourceFrames: 1,
              renderedFrames: 1,
              presentationFailure: null,
              ...override,
            },
          }),
        ),
      );
      await expect(f.port.inspect(f.plan)).rejects.toThrow();
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it("requires explicit new binding and retains real fractional SDK evidence", async () => {
    const f = mediaFixture();
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce(new Response(JSON.stringify(f.raw)));
    const prepared = await f.port.prepare(f.plan, "prepare");
    expect("videoEvidence" in prepared && prepared.videoEvidence).toEqual(
      f.raw.videoEvidence,
    );
    const body = JSON.parse(String(f.request.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({
      mode: "handset_walkthrough",
      planFingerprint: taskHandsetFingerprint(f.plan),
      exportGrantId: "export",
      video: true,
      instructions: true,
      nativeActivation: false,
    });
    expect(f.request.mock.calls[0]![1]!.redirect).toBe("error");
  });
  it.each([
    "wrong_export",
    "wrong_geometry_type",
    "wrong_frame",
    "missing_video",
    "contradictory_cleanup",
  ])("refuses %s in media without retry", async (kind) => {
    const f = mediaFixture();
    const raw = structuredClone(f.raw) as Record<string, any>;
    if (kind === "wrong_export") raw.exportGrantId = "other";
    if (kind === "wrong_geometry_type")
      raw.videoEvidence.geometryGeneration = 1;
    if (kind === "wrong_frame")
      raw.videoEvidence.manifestFingerprint = hash("other");
    if (kind === "missing_video") raw.videoPublisherReady = false;
    if (kind === "contradictory_cleanup") raw.closed = true;
    f.request.mockResolvedValueOnce(new Response(JSON.stringify(raw)));
    await expect(f.port.prepare(f.plan, "prepare")).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("sends native video true only for explicit validated walkthrough and preserves directional proof", async () => {
    const f = fixture();
    const plan = { ...f.plan, recipientHash: hash("+15550000001") },
      request = vi.fn<typeof fetch>();
    const calls = new NativeTaskAudioCalls(
      {
        callsOrigin: "https://calls.example.invalid",
        projectId: "project",
        projectKey: "x".repeat(32),
        recipient: "+15550000001",
        lineId: plan.lineId,
      },
      request,
    );
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { id: callId, line_id: plan.lineId } }),
      ),
    );
    await calls.create(
      plan,
      {
        livekit_url: "wss://example.invalid",
        participant_token: "x".repeat(50),
        remote_participant_identity: plan.agentIdentity,
      },
      "dial",
    );
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).media).toEqual({
      audio: true,
      video: true,
    });
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            call_id: callId,
            events: [
              { id: "bridge", type: "bridge_ready", source: "worker" },
              { id: "video", type: "remote_video_ready", source: "worker" },
            ],
          },
        }),
      ),
    );
    expect(await calls.inspect(plan, callId)).toEqual({
      providerCallId: callId,
      state: "connected",
      cleanupComplete: false,
      remoteVideoReady: true,
    });
  });
});
