import { describe, expect, it, vi } from "vitest";
import { hash } from "../src/storage/security.js";
import {
  HttpTaskAudioMediaPort,
  NativeTaskAudioCalls,
  taskAudioMediaBinding,
  taskAudioMediaFingerprint,
  type TaskAudioPlan,
} from "../src/transport/task-audio.js";
const callId = "11111111-1111-4111-8111-111111111111";
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
  lineId: "22222222-2222-4222-8222-222222222222",
  recipientHash: hash("+15550000001"),
  mediaSessionId: "media",
  workerIdentity: "incoming",
  agentIdentity: "outgoing",
  expiresAt: 1000000,
  audio: true,
  video: false,
  screen: false,
  presentation: false,
  control: false,
  maxCalls: 1,
};
const credentials = {
  livekit_url: "wss://media.example.invalid",
  participant_token: "synthetic-token-".repeat(5),
  remote_participant_identity: plan.agentIdentity,
};
const nativeConfig = {
  callsOrigin: "https://calls.example.invalid",
  projectId: "project",
  projectKey: "synthetic-key-".repeat(3),
  recipient: "+15550000001",
  lineId: plan.lineId,
};
function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}
function mediaReply(state: string, extra = {}) {
  return {
    ...taskAudioMediaBinding(plan),
    bindingFingerprint: taskAudioMediaFingerprint(plan),
    state,
    closed: state === "closed",
    nativeCallClosed: false,
    ...extra,
  };
}
describe("offline task audio HTTP adapters", () => {
  it("sends audio true/video false and preserves directional participant identity", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply({ data: { id: callId, line_id: plan.lineId } }));
    const calls = new NativeTaskAudioCalls(nativeConfig, request);
    expect(request).not.toHaveBeenCalled();
    expect(await calls.create(plan, credentials, "receipt")).toEqual({
      providerCallId: callId,
      lineId: plan.lineId,
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(nativeConfig.callsOrigin + "/api/v1/calls");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      media: { audio: true, video: false },
      remote_participant_identity: plan.agentIdentity,
      participant_token: credentials.participant_token,
    });
    await expect(
      calls.create(
        plan,
        { ...credentials, remote_participant_identity: plan.workerIdentity },
        "other",
      ),
    ).rejects.toThrow(/identity/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("never retries uncertain dial and rejects mismatched line acknowledgements", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("lost"));
    const calls = new NativeTaskAudioCalls(nativeConfig, request);
    await expect(calls.create(plan, credentials, "receipt")).rejects.toThrow(
      "lost",
    );
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue(reply({ data: { id: callId, line_id: callId } }));
    await expect(calls.create(plan, credentials, "other")).rejects.toThrow();
  });
  it("uses exact-call GET worker evidence and keeps end submission distinct from cleanup", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      reply({
        data: {
          call_id: callId,
          events: [{ id: "e1", source: "worker", type: "bridge_ready" }],
        },
      }),
    );
    const calls = new NativeTaskAudioCalls(nativeConfig, request);
    expect(await calls.inspect(plan, callId)).toEqual({
      providerCallId: callId,
      state: "connected",
      cleanupComplete: false,
    });
    expect(request.mock.calls[0]![1]?.method).toBe("GET");
    request.mockResolvedValue(reply({}));
    expect(await calls.end(plan, callId, "end-receipt")).toEqual({
      providerCallId: callId,
      accepted: true,
    });
    request.mockResolvedValue(
      reply({ data: { call_id: plan.lineId, events: [] } }),
    );
    await expect(calls.inspect(plan, callId)).rejects.toThrow();
  });
  it("binds loopback prepare/activate/status/close to one immutable audio-only room", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      reply(
        mediaReply("prepared", {
          credentials,
          silentPublisherReady: true,
          videoPublisherReady: false,
        }),
      ),
    );
    const media = new HttpTaskAudioMediaPort(
      { origin: "http://127.0.0.1:8765", token: "x".repeat(32) },
      request,
    );
    await media.prepare(plan, "prepare");
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual(
      taskAudioMediaBinding(plan),
    );
    expect(taskAudioMediaBinding(plan).roomName).toBe("clawdtime-task-media");
    request.mockResolvedValue(
      reply(mediaReply("active", { providerCallId: callId })),
    );
    await media.activate(plan, callId, "activate");
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
      callAttemptId: plan.id,
      providerCallId: callId,
      connected: true,
    });
    request.mockResolvedValue(
      reply(mediaReply("active", { providerCallId: callId })),
    );
    await media.inspect(plan);
    expect(request.mock.calls[2]![1]?.method).toBe("GET");
    request.mockResolvedValue(reply(mediaReply("closed")));
    await media.close(plan, "close");
    expect(request.mock.calls.map(([url]) => url)).toEqual(
      ["prepare", "activate", "status", "close"].map(
        (path) => `http://127.0.0.1:8765/${path}`,
      ),
    );
    for (const [, init] of request.mock.calls)
      expect(init?.redirect).toBe("error");
  });
  it.each([
    { video: true },
    { bindingFingerprint: "wrong" },
    { callAttemptId: "other" },
    { nativeCallClosed: true },
    { closed: true },
  ])(
    "rejects contradictory or foreign local media response %j",
    async (bad) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply(mediaReply("prepared", bad)));
      const media = new HttpTaskAudioMediaPort(
        { origin: "http://127.0.0.1:8765", token: "x".repeat(32) },
        request,
      );
      await expect(media.inspect(plan)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("retains bounded output counters without raw media content", async () => {
    const audioOutput = {
      evidence: "sdk_acceptance_not_audibility",
      preparedSilentFrames: 240,
      speechFrames: 12,
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(mediaReply("closed", { audioOutput })));
    const media = new HttpTaskAudioMediaPort(
      { origin: "http://127.0.0.1:8765", token: "x".repeat(32) },
      request,
    );
    expect((await media.inspect(plan)).audioOutput).toEqual(audioOutput);
  });
  it.each([
    { preparedSilentFrames: -1, speechFrames: 0 },
    { preparedSilentFrames: 0, speechFrames: 1.5 },
    { preparedSilentFrames: 0, speechFrames: Number.MAX_SAFE_INTEGER + 1 },
    { preparedSilentFrames: 0, speechFrames: 0, content: "forbidden" },
  ])("rejects malformed audio output counters %j", async (audioOutput) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(mediaReply("closed", { audioOutput })));
    const media = new HttpTaskAudioMediaPort(
      { origin: "http://127.0.0.1:8765", token: "x".repeat(32) },
      request,
    );
    await expect(media.inspect(plan)).rejects.toThrow();
  });

  it.each([
    {},
    { evidence: "audible" },
    { evidence: "sdk_acceptance_not_audibility", speechFrames: 1_000_001 },
  ])(
    "rejects missing or misleading audio counter evidence %j",
    async (fields) => {
      const audioOutput = {
        preparedSilentFrames: 0,
        speechFrames: 0,
        ...fields,
      };
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(reply(mediaReply("closed", { audioOutput })));
      const media = new HttpTaskAudioMediaPort(
        { origin: "http://127.0.0.1:8765", token: "x".repeat(32) },
        request,
      );
      await expect(media.inspect(plan)).rejects.toThrow();
    },
  );

  it("requires the configured fingerprint even before preparation", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(mediaReply("absent")));
    const media = new HttpTaskAudioMediaPort(
      { origin: "http://127.0.0.1:8765", token: "x".repeat(32) },
      request,
    );
    expect((await media.inspect(plan)).state).toBe("absent");
    const raw = mediaReply("absent") as Record<string, unknown>;
    delete raw.bindingFingerprint;
    request.mockResolvedValue(reply(raw));
    await expect(media.inspect(plan)).rejects.toThrow();
  });

  it("refuses nonloopback media origins before any request", () => {
    expect(
      () =>
        new HttpTaskAudioMediaPort({
          origin: "https://example.invalid",
          token: "x".repeat(32),
        }),
    ).toThrow(/loopback/);
  });
});
