import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { ConversationService } from "../src/attention/conversation.js";
import { SetupService } from "../src/pairing/setup.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { createApp, type AppOptions } from "../src/app.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { mediaSessionId } from "../src/transport/native.js";
import { mediaStatusSchema } from "../src/transport/media-diagnostics.js";
import type { AgentSession, CallSession } from "../src/contracts.js";

const registration = {
  adapter: "codex" as const,
  adapterVersion: "fixture",
  projectRoot: "/disposable",
  externalSessionId: "fixture-session",
  hostId: "fixture-host",
  capabilities: { cooperativePause: true, polling: true },
};
const operator = "operator-fixture-".repeat(3),
  media = "media-fixture-".repeat(3);
function fixture(options: Partial<AppOptions> = {}) {
  let now = 1_000_000;
  const store = new Store(),
    transport = new SimulationTransport();
  const service = new ClawdTime(store, transport, { clock: () => now });
  const invite = service.createPairingInvite({
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: "line",
    deviceId: "mac",
    displayId: "display",
  });
  const pair = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "display",
    allowView: true,
    allowControl: true,
  });
  const control = new ControlCoordinator(
    store,
    new SimulatedDevice(),
    () => now,
  );
  const app = createApp(service, control, new HumanRouter(service, control), {
    origin: "http://localhost",
    simulation: true,
    operatorToken: operator,
    mediaToken: media,
    audioQualificationEnabled: true,
    ...options,
  });
  const input = {
    pairingId: pair.pairing.id,
    idempotencyKey: "fixture-qualification-once",
    durationSeconds: 30,
    readyForOneCall: true as const,
  };
  const start = () => service.requestAudioQualification(input);
  const request = (
    path: string,
    token = operator,
    body?: unknown,
    method?: string,
  ) =>
    app.request(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    store,
    transport,
    service,
    pair,
    input,
    start,
    request,
    advance: (ms: number) => (now += ms),
  };
}

describe("execution-disabled audio qualification", () => {
  it("admits one fresh bounded session without execution or message authority; replay never redials", async () => {
    const f = fixture(),
      q = f.start();
    expect(q.token).toEqual(expect.any(String));
    expect(q.session).toMatchObject({
      adapter: "audio-qualification",
      protocolVersion: 2,
      state: "active",
      audioQualification: {
        version: 1,
        executionDisabled: true,
        expiresAt: 1_030_000,
      },
      capabilities: {
        nativeControl: "none",
        polling: false,
        cooperativePause: false,
      },
    });
    expect(q.session.conversation).toBeUndefined();
    expect(q.session.interaction).toBeUndefined();
    expect(f.transport.calls).toHaveLength(0);
    expect(f.store.all("execution")).toHaveLength(0);
    expect(f.store.all("lease")).toHaveLength(0);
    expect(f.start()).toEqual({ session: q.session, request: q.request });
    expect(() =>
      f.service.requestAudioQualification({ ...f.input, durationSeconds: 60 }),
    ).toThrow(/identity changed/);
    await f.service.drain();
    await f.service.drain();
    expect(f.transport.calls).toHaveLength(1);
    expect(f.transport.messages).toHaveLength(0);
    const restarted = new ClawdTime(f.store, f.transport, {
      clock: f.service.clock,
    });
    expect(restarted.requestAudioQualification(f.input).request.id).toBe(
      q.request.id,
    );
    expect(restarted.requestAudioQualification(f.input).token).toBeUndefined();
    await restarted.drain();
    expect(f.transport.calls).toHaveLength(1);
    restarted.stopAudioQualification(q.request.id);
    await restarted.drain();
    expect(
      restarted.audioQualificationStatus(q.request.id).cleanupConfirmed,
    ).toBe(true);
    expect(restarted.requestAudioQualification(f.input).request.id).toBe(
      q.request.id,
    );
    await restarted.drain();
    expect(f.transport.calls).toHaveLength(1);
    expect(restarted.pairing(f.pair.pairing.id).revokedAt).toBeUndefined();
    f.store.close();
  });
  it("lost dial acknowledgement remains unknown across Stop and restart, with no second attempt", async () => {
    const f = fixture();
    let attempts = 0;
    f.transport.call = async () => {
      attempts++;
      throw new Error("lost acknowledgement");
    };
    const q = f.start();
    await f.service.drain();
    expect(f.store.effect(`${q.request.id}:call`)?.state).toBe("unknown");
    f.service.stopAudioQualification(q.request.id);
    const restarted = new ClawdTime(f.store, f.transport, {
      clock: f.service.clock,
    });
    expect(restarted.requestAudioQualification(f.input).request.id).toBe(
      q.request.id,
    );
    expect(() =>
      restarted.requestAudioQualification({
        ...f.input,
        idempotencyKey: "new-key",
      }),
    ).toThrow();
    await restarted.drain();
    expect(attempts).toBe(1);
    expect(
      restarted.audioQualificationStatus(q.request.id).cleanupConfirmed,
    ).toBe(false);
    f.store.close();
  });
  it("unconfirmed predial media cleanup cannot be reported as stopped cleanup", () => {
    const f = fixture(),
      q = f.start();
    f.store.put("media", {
      id: "media",
      requestId: q.request.id,
      state: "unknown",
    });
    const status = f.service.stopAudioQualification(q.request.id);
    expect(status.call.state).toBe("ended");
    expect(status.cleanupConfirmed).toBe(false);
    expect(status.mediaState).toBe("unconfirmed");
    expect(() =>
      f.service.requestAudioQualification({
        ...f.input,
        idempotencyKey: "new-key",
      }),
    ).toThrow(/Media cleanup/);
    f.store.close();
  });
  it("qualification reserves another pairing on the same device or line", () => {
    const f = fixture();
    f.start();
    const invite = f.service.createPairingInvite({
      memberId: "other",
      recipient: "+15550000003",
      conversationId: "iMessage;-;+15550000003",
      lineId: "line",
      deviceId: "mac-other",
      displayId: "display-other",
    });
    const pair = f.service.claimPairing({
      token: invite.token,
      deviceId: "mac-other",
      displayId: "display-other",
      allowView: true,
      allowControl: false,
    });
    expect(() => f.service.registerSession(pair.token, registration)).toThrow(
      /qualification/,
    );
    f.store.close();
  });
  it("local Stop before dispatch prevents any call and cannot reconnect the dedicated identity", async () => {
    const f = fixture(),
      q = f.start();
    expect(f.service.stopAudioQualification(q.request.id)).toMatchObject({
      session: { state: "stopped" },
      request: { state: "canceled" },
      call: { state: "ended" },
      cleanupConfirmed: true,
    });
    await f.service.drain();
    expect(f.transport.calls).toHaveLength(0);
    expect(() =>
      f.service.registerSession(f.pair.token, {
        ...registration,
        externalSessionId: q.session.externalSessionId,
        hostId: q.session.hostId,
      }),
    ).toThrow(/cannot register/);
    expect(() =>
      f.service.registerSession(f.pair.token, {
        ...registration,
        audioQualification: q.session.audioQualification,
      } as any),
    ).toThrow();
    expect(() =>
      f.service.registerSession(f.pair.token, {
        ...registration,
        adapter: "audio-qualification",
      }),
    ).toThrow();
    f.store.close();
  });
  it("heartbeats never renew the fixed deadline; expiry ends the exact session", async () => {
    const f = fixture(),
      q = f.start();
    await f.service.drain();
    f.advance(15_000);
    f.service.heartbeat(q.token!);
    f.advance(14_999);
    f.service.heartbeat(q.token!);
    expect(
      f.service.audioQualificationStatus(q.request.id).request.deadline,
    ).toBe(1_030_000);
    f.advance(1);
    f.service.expire();
    await f.service.drain();
    expect(f.service.audioQualificationStatus(q.request.id)).toMatchObject({
      session: { state: "stopped" },
      request: { state: "expired" },
      call: { state: "ended" },
      cleanupConfirmed: true,
    });
    expect(() => f.service.heartbeat(q.token!)).toThrow();
    f.store.close();
  });
  it("domain APIs cannot turn a qualification into a task session", () => {
    const f = fixture(),
      q = f.start(),
      turns = new ConversationService(f.service);
    const response = {
      eventId: "input-event",
      requestId: q.request.id,
      memberId: "member",
      lineId: "line",
      conversationId: "iMessage;-;+15550000001",
      channel: "text" as const,
      text: "Execute a task",
    };
    for (const action of [
      () => f.service.registerSession(f.pair.token, registration),
      () =>
        f.service.requestAttention(q.token!, {
          taskId: "task",
          idempotencyKey: "new",
          reason: "decision",
          question: "Task?",
        }),
      () => f.service.yieldSession(q.token!),
      () => f.service.receiveResponse(response),
      () => turns.receive(response),
      () => turns.poll(q.token!, q.request.id),
      () => new SetupService(f.service).invite(q.token!),
    ])
      expect(action).toThrow(/qualification/i);
    expect(f.store.all("response")).toHaveLength(0);
    expect(f.store.all("conversation_turn")).toHaveLength(0);
    expect(f.store.all("setup_test")).toHaveLength(0);
    f.store.close();
  });
  it.each([
    ["conversation_job", "unknown"],
    ["job_dispatch", "accepted"],
    ["conversation_turn", "executing"],
    ["conversation_reply", "playing"],
    ["lease", "revoked"],
    ["action", "submitted"],
    ["desktop_ownership", "working"],
    ["desktop_action", "unknown"],
    ["execution", "paused"],
    ["text_control_grant", "active"],
    ["media", "closing"],
    ["call", "unknown"],
    ["setup_test", "approved"],
  ])("blocks unresolved %s/%s before admission", (kind, state) => {
    const f = fixture();
    f.store.put(kind, { id: "conflict", pairingId: f.pair.pairing.id, state });
    expect(f.start).toThrow();
    expect(f.store.all("attention")).toHaveLength(0);
    f.store.close();
  });
  it.each(["pending", "running", "unknown"])(
    "blocks %s transport effects and never retries ambiguity",
    async (state) => {
      const f = fixture();
      f.store.putEffect({
        id: "uncertain",
        kind: "message",
        state: state as any,
        payload: { pairingId: f.pair.pairing.id, text: "fixture" },
        createdAt: f.service.clock(),
      });
      expect(f.start).toThrow(/transport effects/);
      expect(f.transport.calls).toHaveLength(0);
      f.store.close();
    },
  );
  it("blocks active ordinary sessions and unresolved reconciliation receipts", () => {
    const f = fixture(),
      agent = f.service.registerSession(f.pair.token, registration);
    expect(f.start).toThrow(/session/);
    f.store.put("session", { ...agent.session, state: "stopped" });
    f.store.put("remote_result_receipt", {
      id: "late",
      pairingId: f.pair.pairing.id,
      reconciliationRequired: true,
    });
    expect(f.start).toThrow(/reconciliation/);
    f.store.close();
  });
  it("suppresses seeded message effects at dispatch", async () => {
    const f = fixture(),
      q = f.start();
    for (const [id, owner] of [
      ["request", { requestId: q.request.id }],
      ["session", { sessionId: q.session.id }],
      ["pairing", {}],
    ] as const)
      f.store.putEffect({
        id,
        kind: "message",
        state: "pending",
        payload: {
          ...owner,
          pairingId: f.pair.pairing.id,
          text: "Do not send",
        },
        createdAt: f.service.clock(),
      });
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(0);
    for (const id of ["request", "session", "pairing"])
      expect(f.store.effect(id)?.state).toBe("failed");
    f.store.close();
  });
  it.each(["session", "call"])(
    "reserves the line for malformed %s-only markers",
    (kind) => {
      const f = fixture();
      f.store.put(kind, {
        id: "malformed",
        pairingId: f.pair.pairing.id,
        state: kind === "session" ? "active" : "connected",
        audioQualification: null,
        createdAt: f.service.clock(),
        lastSeenAt: f.service.clock(),
      });
      expect(() =>
        f.service.registerSession(f.pair.token, registration),
      ).toThrow(/qualification/);
      f.store.close();
    },
  );
  it("malformed expired markers cannot crash maintenance", () => {
    const f = fixture();
    f.store.put("attention", {
      id: "malformed",
      pairingId: f.pair.pairing.id,
      sessionId: "missing",
      state: "queued",
      deadline: 0,
      audioQualification: null,
    });
    expect(() => f.service.expire()).not.toThrow();
    expect(f.store.get<any>("attention", "malformed").state).toBe("unknown");
    f.store.close();
  });
  it("requires operator authentication, explicit one-call consent, enabled dispatch and media readiness", async () => {
    const f = fixture();
    expect(
      (await f.request("/internal/audio-qualifications", "", f.input)).status,
    ).toBe(401);
    expect(
      (
        await f.request("/internal/audio-qualifications", operator, {
          ...f.input,
          readyForOneCall: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.request("/internal/audio-qualifications", f.pair.token, f.input))
        .status,
    ).toBe(401);
    expect(
      (await f.request("/internal/audio-qualifications", operator, f.input))
        .status,
    ).toBe(201);
    expect(f.transport.calls).toHaveLength(0);
    f.store.close();
    for (const options of [
      { audioQualificationEnabled: false },
      { dispatchEnabled: false },
      {
        audioQualificationReadiness: async () => ({
          enabled: true,
          directKeyConfigured: false,
          transportReady: true,
          websocketQualified: true,
          sdk: { available: true },
        }),
      },
    ]) {
      const blocked = fixture(options);
      expect(
        (
          await blocked.request(
            "/internal/audio-qualifications",
            operator,
            blocked.input,
          )
        ).status,
      ).toBe(409);
      expect(blocked.store.all("attention")).toHaveLength(0);
      blocked.store.close();
    }
  });
  it("qualification credentials allow status/heartbeat/Stop and deny all execution API paths", async () => {
    const f = fixture(),
      q = f.start();
    for (const path of [
      "/api/sessions/yield",
      "/api/setup",
      "/api/conversation/jobs",
      `/api/attention/${q.request.id}/conversation/reply`,
      `/api/attention/${q.request.id}/conversation/execution`,
      `/api/attention/${q.request.id}/complete`,
    ])
      expect((await f.request(path, q.token!, {})).status, path).toBe(403);
    expect(
      (await f.request(`/api/attention/${q.request.id}`, q.token!)).status,
    ).toBe(200);
    expect(
      (await f.request("/api/sessions/heartbeat", q.token!, {})).status,
    ).toBe(200);
    expect((await f.request("/api/disconnect", q.token!, {})).status).toBe(200);
    expect(f.service.audioQualificationStatus(q.request.id).request.state).toBe(
      "canceled",
    );
    expect(f.service.pairing(f.pair.pairing.id).revokedAt).toBeUndefined();
    f.store.close();
  });
  it("qualified media receives only fixed audio policy and cannot send task inputs", async () => {
    const f = fixture(),
      q = f.start();
    await f.service.drain();
    f.service.observeCall(q.request.id, "connected");
    const call = f.service.audioQualificationStatus(q.request.id).call;
    f.store.put<CallSession>("call", {
      ...call,
      remoteParticipantQualified: true,
    });
    const base = `/media/${mediaSessionId(q.request.id)}`;
    const policy = await (await f.request(`${base}/policy`, media)).json();
    expect(policy).toMatchObject({
      state: "listening",
      protocolVersion: 2,
      voiceMode: "audio_qualification",
      remoteAudioIsolated: false,
      captionsEnabled: false,
      audioQualification: {
        executionDisabled: true,
        expiresAt: new Date(q.request.deadline).toISOString(),
      },
    });
    for (const field of [
      "screenSelection",
      "presentationBinding",
      "presentationSequence",
      "conversation",
    ])
      expect(policy).not.toHaveProperty(field);
    for (const path of [
      "segments",
      "interrupt",
      "conversation/turn",
      "conversation/jobs",
    ])
      expect(
        (
          await f.request(
            `${base}/${path}`,
            media,
            path.endsWith("jobs") ? undefined : {},
          )
        ).status,
        path,
      ).toBe(403);
    f.service.stopAudioQualification(q.request.id);
    expect(
      await (await f.request(`${base}/policy`, media)).json(),
    ).toMatchObject({ state: "ended", muted: true });
    f.store.close();
  });
  it("retains bounded audio counters while stripping raw content from diagnostics", () => {
    const audioQualification = {
      version: 1,
      executionDisabled: true,
      started: true,
      finalized: true,
      outputLatched: true,
      elapsedMs: 300000,
      inputFrames: 20,
      outputChunks: 10,
      discardedOutputChunks: 3,
      discardedDelegations: 2,
      discardedTranscriptEvents: 5,
      cutoffs: 1,
      transcript: "private",
      key: "secret",
    };
    const parsed = mediaStatusSchema.parse({
      id: "ct_" + "a".repeat(40),
      alive: false,
      state: "closed",
      lifecycleDiagnostics: { version: 1, audioQualification },
    });
    expect(parsed.lifecycleDiagnostics?.audioQualification).not.toHaveProperty(
      "transcript",
    );
    expect(parsed.lifecycleDiagnostics?.audioQualification).not.toHaveProperty(
      "key",
    );
    expect(
      mediaStatusSchema.safeParse({
        id: "ct_" + "a".repeat(40),
        alive: false,
        lifecycleDiagnostics: {
          version: 1,
          audioQualification: { ...audioQualification, elapsedMs: 300001 },
        },
      }).success,
    ).toBe(false);
  });
});
