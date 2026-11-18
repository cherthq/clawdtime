import { describe, expect, it, vi } from "vitest";
import {
  HTTPTaskPresentationHost,
  HTTPTaskWalkthroughPresentationHost,
} from "../src/transport/task-presentation.js";
import { hash } from "../src/storage/security.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskSceneFrame,
} from "../src/task-presentation-contracts.js";
import type { TaskWalkthroughPlan } from "../src/task-walkthrough-contracts.js";
const manifest: TaskPresentationManifest = {
  version: 1,
  id: "presentation",
  sessionId: "session",
  taskId: "task",
  runId: "run",
  taskRevision: 4,
  verificationId: "verification",
  kind: "review",
  opening: "The filter works. The configured checks passed.",
  fps: 15,
  scenes: [
    {
      id: "code",
      kind: "code",
      title: "Filter",
      narration: "The filter works. The configured checks passed.",
      expectedOutcome: "Filter code visible",
      target: {
        appId: "com.example.editor",
        windowId: "42",
        ownerPid: 123,
        processIdentity: hash("launch"),
        displayId: 1,
        titleHash: hash("private title"),
      },
      focus: { x: 0, y: 0, width: 1, height: 1 },
      transitionMs: 550,
    },
  ],
};
const fingerprint = taskPresentationFingerprint(manifest),
  grant = {
    version: 1 as const,
    id: "grant",
    manifestFingerprint: fingerprint,
    sessionId: "session",
    taskId: "task",
    runId: "run",
    taskRevision: 4,
    hostId: "host",
    authorizedAt: 1000,
    expiresAt: 10000,
    localOnly: true as const,
    capture: true as const,
    presentation: true as const,
    control: false as const,
    nativeActivation: false as const,
    calls: false as const,
  };
const prepared = { presentationId: manifest.id, manifest, grant, fingerprint },
  show = {
    presentationId: manifest.id,
    operationId: "show",
    manifestFingerprint: fingerprint,
    sceneId: "code",
    generation: 1,
  };
const frame: TaskSceneFrame = {
  ...show,
  target: manifest.scenes[0]!.target,
  sourceFrameId: "source",
  geometryGeneration: "geometry",
  contentRevision: hash("pixels"),
  capturedAt: 2000,
  renderedAt: 2000,
  transitionCompletedAt: 2000,
  evidence: "local_frame_rendered_not_human_seen",
};
const cleanup = {
  captureStopped: true,
  narrationStopped: true,
  outputCleared: true,
  childrenJoined: true,
};
function response(raw: unknown) {
  return new Response(JSON.stringify(raw));
}
function fixture() {
  const request = vi.fn<typeof fetch>();
  const host = new HTTPTaskPresentationHost(
    { origin: "http://127.0.0.1:3456", token: "x".repeat(32) },
    request,
  );
  const prepare = async () => {
    request.mockResolvedValueOnce(response({ ready: true }));
    await host.prepare(prepared);
  };
  return { request, host, prepare };
}
describe("strict local presentation host transport", () => {
  it("performs no startup work and sends only exact fixed presentation endpoints", async () => {
    const f = fixture();
    expect(f.request).not.toHaveBeenCalled();
    await f.prepare();
    f.request.mockResolvedValueOnce(response(frame));
    expect(await f.host.show(show)).toEqual(frame);
    f.request.mockResolvedValueOnce(response(frame));
    expect(await f.host.observe(manifest.id)).toEqual(frame);
    f.request.mockResolvedValueOnce(
      response({
        completed: true,
        evidence: "playback_completed_not_audibility",
      }),
    );
    await f.host.narrate({
      presentationId: manifest.id,
      operationId: "speech",
      sceneId: "code",
      generation: 1,
      frame,
      text: manifest.scenes[0]!.narration,
    });
    f.request.mockResolvedValueOnce(response(cleanup));
    expect(await f.host.stop(manifest.id)).toEqual(cleanup);
    expect(f.request.mock.calls.map(([url]) => String(url))).toEqual(
      [
        "/prepare",
        "/show",
        "/observe?presentationId=presentation",
        "/narrate",
        "/stop",
      ].map((path) => "http://127.0.0.1:3456" + path),
    );
    for (const [, init] of f.request.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer " + "x".repeat(32),
      );
    }
    expect(f.request.mock.calls[2]![1]?.method).toBe("GET");
  });
  it.each([
    "https://example.invalid",
    "http://localhost:3456",
    "http://127.0.0.1:3456/path",
    "http://127.0.0.1:80",
  ])("refuses origin %s", (origin) => {
    expect(
      () => new HTTPTaskPresentationHost({ origin, token: "x".repeat(32) }),
    ).toThrow();
  });
  it("refuses changed manifests, targets and arbitrary narration before output", async () => {
    const f = fixture();
    await f.prepare();
    await expect(
      f.host.prepare({
        ...prepared,
        manifest: {
          ...manifest,
          opening: "different",
          scenes: manifest.scenes.map((scene, i) =>
            i === 0 ? { ...scene, narration: "different" } : scene,
          ),
        },
      }),
    ).rejects.toThrow(/binding/);
    f.request.mockResolvedValueOnce(
      response({ ...frame, target: { ...frame.target, ownerPid: 999 } }),
    );
    await expect(f.host.show(show)).rejects.toThrow(/binding/);
    await expect(
      f.host.narrate({
        presentationId: manifest.id,
        operationId: "speech",
        sceneId: "code",
        generation: 1,
        frame,
        text: "Read unrelated data",
      }),
    ).rejects.toThrow(/Narration/);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { operationId: "other" },
    { generation: 2 },
    { sceneId: "other" },
    { presentationId: "other" },
    { manifestFingerprint: hash("other") },
  ])("rejects mismatched rendered effect %j", async (bad) => {
    const f = fixture();
    await f.prepare();
    f.request.mockResolvedValueOnce(response({ ...frame, ...bad }));
    await expect(f.host.show(show)).rejects.toThrow();
  });
  it("does not retry uncertain effects or accept input/capture capability flags in preparation responses", async () => {
    const f = fixture();
    await f.prepare();
    f.request.mockRejectedValueOnce(new Error("unknown network outcome"));
    await expect(f.host.show(show)).rejects.toThrow();
    expect(f.request).toHaveBeenCalledTimes(2);
    const g = fixture();
    g.request.mockResolvedValueOnce(response({ ready: true, control: true }));
    await expect(g.host.prepare(prepared)).rejects.toThrow();
  });
  it("can clean an exact identity after a lost prepare response without implying physical visibility", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("lost"));
    await expect(f.host.prepare(prepared)).rejects.toThrow();
    f.request.mockResolvedValueOnce(response(cleanup));
    await expect(f.host.stop(manifest.id)).resolves.toEqual(cleanup);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});

function handsetFixture() {
  let now = 2500;
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
      manifestFingerprint: fingerprint,
      presentationGrantId: "grant",
      verificationId: "verification",
      hostId: "host",
      captureDeviceId: "mac",
    },
    dispatchExpiresAt: 5000,
    expiresAt: 10000,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    instructions: true,
    control: false,
    nativeActivation: false,
    maxCalls: 1,
  };
  const request = vi.fn<typeof fetch>();
  const host = new HTTPTaskWalkthroughPresentationHost(
    { origin: "http://127.0.0.1:3456", token: "x".repeat(32), plan },
    request,
    () => now,
  );
  const videoEvidence = {
    evidence: "sdk_frame_accepted_not_remote_seen",
    presentationId: frame.presentationId,
    manifestFingerprint: frame.manifestFingerprint,
    sceneId: frame.sceneId,
    generation: frame.generation,
    sourceFrameId: frame.sourceFrameId,
    geometryGeneration: frame.geometryGeneration,
    capturedAt: frame.capturedAt,
    renderedAt: frame.renderedAt,
    acceptedAt: 2100.5,
  };
  return {
    request,
    host,
    videoEvidence,
    advance: (ms: number) => {
      now += ms;
    },
    prepare: async () => {
      request.mockResolvedValueOnce(response({ ready: true }));
      await host.prepare(prepared);
    },
  };
}
describe("walkthrough presentation export transport", () => {
  it("binds exact fresh SDK frame evidence and keeps Stop sharing separate from dialogue", async () => {
    const f = handsetFixture();
    await f.prepare();
    f.request.mockResolvedValueOnce(
      response({ frame, videoEvidence: f.videoEvidence }),
    );
    expect(await f.host.show(show)).toEqual(frame);
    expect(f.host.evidenceFor(frame)).toEqual(f.videoEvidence);
    await expect(
      f.host.narrate({
        presentationId: manifest.id,
        operationId: "speech",
        sceneId: "code",
        generation: 1,
        frame,
        text: manifest.opening,
      }),
    ).rejects.toThrow(/single authorized dialogue/);
    expect(f.request).toHaveBeenCalledTimes(2);
    const updated = {
      ...frame,
      sourceFrameId: "source2",
      capturedAt: 2200.25,
      renderedAt: 2200.5,
    };
    const video = {
      ...f.videoEvidence,
      sourceFrameId: "source2",
      capturedAt: 2200.25,
      renderedAt: 2200.5,
      acceptedAt: 2300.75,
    };
    f.request.mockResolvedValueOnce(
      response({ frame: updated, videoEvidence: video }),
    );
    expect(await f.host.observe(manifest.id)).toEqual(updated);
    expect(() => f.host.evidenceFor(frame)).toThrow(/No current SDK/);
    expect(f.host.evidenceFor(updated)).toEqual(video);
    f.request.mockResolvedValueOnce(response(cleanup));
    await f.host.stop(manifest.id);
    expect(() => f.host.evidenceFor(updated)).toThrow(/No current SDK/);
    expect(
      f.request.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      "/presentation/prepare",
      "/presentation/show",
      "/presentation/observe",
      "/stop-sharing",
    ]);
    expect(JSON.parse(String(f.request.mock.calls.at(-1)![1]!.body))).toEqual({
      callAttemptId: "call",
      presentationId: "presentation",
    });
  });
  it.each([
    "source",
    "geometry",
    "scene",
    "stale",
    "future",
    "fractional_geometry",
  ])("rejects conflicting %s proof", async (kind) => {
    const f = handsetFixture();
    await f.prepare();
    const video = { ...f.videoEvidence };
    if (kind === "source") video.sourceFrameId = "wrong";
    if (kind === "geometry") video.geometryGeneration = "wrong";
    if (kind === "scene") video.sceneId = "wrong";
    if (kind === "stale") f.advance(3000);
    if (kind === "future") video.acceptedAt = 4000;
    const raw =
      kind === "fractional_geometry"
        ? { ...video, geometryGeneration: 1 }
        : video;
    f.request.mockResolvedValueOnce(response({ frame, videoEvidence: raw }));
    await expect(f.host.show(show)).rejects.toThrow();
    expect(() => f.host.evidenceFor(frame)).toThrow();
  });
  it("rejects mismatched export provenance before a host request", async () => {
    const f = handsetFixture();
    await expect(
      f.host.prepare({ ...prepared, grant: { ...grant, id: "other" } }),
    ).rejects.toThrow(/provenance/);
    expect(f.request).not.toHaveBeenCalled();
  });
});
