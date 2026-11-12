import { describe, it, expect } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import {
  NativeTransport,
  type NativeTransportConfig,
  mediaSessionId,
} from "../src/transport/native.js";
import type {
  AttentionRequest,
  CallSession,
  Pairing,
} from "../src/contracts.js";
const logicalLineId = "00000000-0000-4000-8000-000000000099";
const config: NativeTransportConfig = {
  enabled: true,
  binding: {
    origin: "https://native.example.test",
    token: "fixture-native-token-long-enough",
    signingSecret: "fixture-native-signature-long-enough",
    lineId: logicalLineId,
    providerLineId: "provider",
    phone: "+15550000002",
    instanceId: "instance",
  },
  callsOrigin: "https://calls.example.test",
  projectId: "fixture-project",
  projectKey: "fixture-project-key-long-enough",
  mediaOrigin: "https://media.example.test",
  mediaKey: "fixture-independent-media-key-long-enough",
  encryptionKey: "1".repeat(64),
  testerAllowlist: ["+15550000001"],
  handoff: {
    owner: "clawdtime",
    sourceOwnerPaused: true,
    phone: "+15550000002",
    identityEvidence: "private-fixture-identity",
    sourcePauseEvidence: "private-fixture-pause",
    lineId: logicalLineId,
    providerLineId: "provider",
    instanceId: "instance",
    baseline: { sequence: 1, eventId: "recv:baseline" },
    checkedAt: Date.now(),
    rollbackRecord: "private-fixture",
  },
};
const nativeCallId = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const store = new Store(),
    requests: { url: string; method: string; body: any }[] = [];
  let events: string[] = [];
  let closeFails = false;
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url)),
      path = parsed.pathname,
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), method: init?.method ?? "GET", body });
    let result: unknown = {};
    if (path === "/api/v1/whoami")
      result = {
        healthy: true,
        phone_line: {
          phone_line_id: "provider",
          phone_number: config.binding.phone,
          instance_id: "instance",
        },
      };
    else if (path === "/api/v1/lines")
      result = {
        data: {
          items: [
            {
              id: logicalLineId,
              phone_number: null,
              status: "available",
              current_call_id: null,
              worker_occupied: false,
              session_health: {
                line_id: logicalLineId,
                identity_confirmed: true,
                status: "accepting",
                last_heartbeat_at: new Date().toISOString(),
                readiness: {
                  control_ready: true,
                  facetime_signed_in: true,
                  accessibility_ready: true,
                  screen_capture_ready: true,
                  audio_ready: false,
                  video_ready: true,
                  production_media_ready: true,
                  automatic: {
                    checks: [
                      { id: "system_audio_capture", outcome: "at_call_start" },
                    ],
                  },
                },
              },
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        },
      };
    else if (path === "/api/v1/events/1")
      result = {
        sequence: 1,
        event_id: "recv:baseline",
        type: "baseline",
        phone_line_id: "provider",
        payload: { phone_line_id: "provider" },
      };
    else if (path === "/health")
      result = {
        service: "clawdtime-media",
        ok: true,
        configured: true,
        devicesConfigured: true,
        deviceGatewayConnected: true,
        activeSessions: 0,
      };
    else if (path.includes("/readiness/"))
      result = {
        deviceId: "mac",
        memberId: "member",
        displayId: "1",
        available: true,
        displayAttached: true,
        screenPermission: true,
        viewAllowed: true,
        armed: true,
        controlPermission: true,
        controlAllowed: true,
      };
    else if (path === "/sessions")
      result = {
        id: body.id,
        silentPublisherReady: true,
        videoPublisherReady: true,
        credentials: {
          livekit_url: "wss://fixture.example.test",
          participant_token: "fixture-native-token-long-enough".repeat(8),
          remote_participant_identity: `worker-${body.id}`,
        },
      };
    else if (path === "/api/v1/calls")
      result = { data: { id: nativeCallId, line_id: logicalLineId } };
    else if (path.endsWith("/events"))
      result = {
        data: {
          call_id: nativeCallId,
          events: events.map((type, i) => ({
            id: `event-${i}`,
            type,
            source: "worker",
          })),
        },
      };
    else if (path.endsWith("/speak"))
      result = {
        id: body.id,
        sessionId: path.split("/")[2],
        state: "accepted",
      };
    else if (path.includes("/speech/"))
      result = {
        id: decodeURIComponent(path.split("/").at(-1)!),
        sessionId: path.split("/")[2],
        state: "completed",
      };
    else if (path.endsWith("/close") && closeFails)
      throw new Error("Media unavailable");
    else if (
      path.startsWith("/sessions/") &&
      !path.endsWith("/activate") &&
      !path.endsWith("/close")
    )
      result = { id: path.split("/")[2], alive: true };
    return new Response(JSON.stringify(result));
  };
  store.saveState(`messages:${logicalLineId}`, config.handoff.baseline);
  const transport = new NativeTransport(store, config, request as typeof fetch),
    app = new ClawdTime(store, transport);
  const invite = app.createPairingInvite({
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: logicalLineId,
    deviceId: "mac",
    displayId: "1",
  });
  const pair = app.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const agent = app.registerSession(pair.token, {
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/disposable",
    externalSessionId: "fixture-session",
    hostId: "mac",
    capabilities: { cooperativePause: true, polling: true },
  });
  app.yieldSession(agent.token);
  const attention = app.requestAttention(agent.token, {
    taskId: "task",
    idempotencyKey: "once",
    reason: "decision",
    question: "Fixture question",
  });
  return {
    store,
    transport,
    app,
    pair,
    agent,
    attention,
    requests,
    request: request as typeof fetch,
    events: (value: string[]) => (events = value),
    failClose: () => (closeFails = true),
  };
}
describe("native protocol integration without live traffic", () => {
  it("records integration cleanup intent before the original end effect without replay", async () => {
    const f = fixture();
    await f.app.drain();
    const before = f.requests.length;
    await f.transport.pollCalls(
      (id, state, qualified) => f.app.observeCall(id, state, qualified),
      { cleanupOnly: true, cleanupSource: "integration_failure" },
    );
    const first = f.store.state(`call-termination:${f.attention.id}`);
    expect(first).toMatchObject({
      source: "integration_failure",
      effectId: `${f.attention.id}:end`,
    });
    expect(f.requests.slice(before).every((r) => r.method === "GET")).toBe(
      true,
    );
    await f.transport.pollCalls(
      (id, state, qualified) => f.app.observeCall(id, state, qualified),
      { cleanupOnly: true, cleanupSource: "standby" },
    );
    expect(f.store.state(`call-termination:${f.attention.id}`)).toEqual(first);
    expect(f.store.effects().filter((e) => e.kind === "end_call")).toHaveLength(
      1,
    );
    f.store.close();
  });

  it("reads only the owned media session and returns bounded diagnostic metadata without credentials or pixels", async () => {
    const f = fixture(),
      id = mediaSessionId(f.attention.id),
      requests: string[] = [];
    const at = "2026-11-11T19:00:00.123456+00:00";
    const body: Record<string, unknown> = {
      id,
      alive: true,
      state: "prepared",
      credentials: { token: "PRIVATE_TOKEN" },
      captions: {
        enabled: true,
        state: "listening",
        failed: false,
        text: "PRIVATE_CAPTION",
      },
      screen: {
        leaseId: "lease",
        deviceId: "mac",
        displayId: 1,
        mode: "view",
        frameId: "frame",
        capturedAt: at,
        state: "viewing",
        jpegBase64: "PRIVATE_PIXELS",
      },
      lifecycleDiagnostics: {
        version: 1,
        firstFailure: {
          reason: "room_disconnected",
          category: "room_event",
          at,
          elapsedMs: 1000,
          exception: "PRIVATE_EXCEPTION",
        },
        closeRequested: {
          reason: "failure",
          at,
          elapsedMs: 1001,
          text: "PRIVATE_TEXT",
        },
        lastSegmentFailure: {
          reason: "callback_stale",
          at,
          elapsedMs: 12000,
          ageMs: 11000,
          httpStatus: 409,
          text: "PRIVATE_SEGMENT",
          exception: "PRIVATE_EXCEPTION",
        },
        transcript: "PRIVATE_TRANSCRIPT",
      },
      screenDiagnostics: {
        version: 1,
        phase: "viewing",
        updatedAt: at,
        framesReceived: 1,
        videoFramesEmitted: 2,
        screenVideoObserved: true,
        firstFrameAt: at,
        lastGatewayResult: {
          phase: "frame_request",
          at,
          durationMs: 25,
          httpStatus: 200,
          url: "PRIVATE_URL",
        },
        lastFailure: {
          phase: "lease_create",
          reason: "lease_refused",
          at,
          httpStatus: 409,
          exception: "PRIVATE_EXCEPTION",
        },
        text: "PRIVATE_TEXT",
      },
    };
    const transport = new NativeTransport(f.store, config, (async (
      url,
      init,
    ) => {
      expect(init?.method).toBe("GET");
      requests.push(String(url));
      return new Response(JSON.stringify(body));
    }) as typeof fetch);
    expect((await transport.mediaStatus(f.attention.id)).state).toBe(
      "unavailable",
    );
    expect(requests).toHaveLength(0);
    f.store.put("media", {
      id,
      requestId: f.attention.id,
      state: "active",
      credentials: "PRIVATE_STORED_SECRET",
    });
    const before = f.store.query("SELECT * FROM entities"),
      effects = f.store.effects();
    const result = await transport.mediaStatus(f.attention.id);
    expect(result).toMatchObject({
      id,
      alive: true,
      lifecycleDiagnostics: {
        lastSegmentFailure: {
          reason: "callback_stale",
          at,
          elapsedMs: 12000,
          ageMs: 11000,
          httpStatus: 409,
        },
        firstFailure: {
          reason: "room_disconnected",
          category: "room_event",
          at,
          elapsedMs: 1000,
        },
        closeRequested: { reason: "failure", at, elapsedMs: 1001 },
      },
      screenDiagnostics: {
        phase: "viewing",
        framesReceived: 1,
        screenVideoObserved: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(requests).toEqual([`${config.mediaOrigin}/sessions/${id}`]);
    expect(f.store.query("SELECT * FROM entities")).toEqual(before);
    expect(f.store.effects()).toEqual(effects);
    body.alive = false;
    body.state = "closed";
    delete body.screen;
    delete body.captions;
    expect(await transport.mediaStatus(f.attention.id)).toMatchObject({
      id,
      alive: false,
      state: "closed",
      screenDiagnostics: { framesReceived: 1, updatedAt: at },
    });
    body.id = mediaSessionId("foreign");
    expect(await transport.mediaStatus(f.attention.id)).toMatchObject({
      state: "unavailable",
      reason: "invalid_status",
    });
    await expect(transport.mediaStatus("foreign-request")).rejects.toThrow(
      "unavailable",
    );
    f.store.close();
  });
  it.each([
    "missing",
    "error",
    "oversized",
    "invalid-category",
    "foreign-record",
  ])(
    "fails closed with safe read-only metadata for %s diagnostics",
    async (kind) => {
      const f = fixture(),
        id = mediaSessionId(f.attention.id);
      let reads = 0;
      f.store.put("media", {
        id,
        requestId: kind === "foreign-record" ? "foreign" : f.attention.id,
        state: "closed",
      });
      const transport = new NativeTransport(f.store, config, (async () => {
        reads++;
        if (kind === "error") throw new Error("PRIVATE_PROVIDER_EXCEPTION");
        if (kind === "missing")
          return new Response("PRIVATE_BODY", { status: 404 });
        return new Response(
          JSON.stringify({
            id,
            alive: false,
            state: "closed",
            screenDiagnostics: {
              version: 1,
              phase:
                kind === "invalid-category"
                  ? "PRIVATE_PROVIDER_EXCEPTION"
                  : "closed",
              updatedAt: new Date().toISOString(),
              framesReceived: kind === "oversized" ? 1e10 : 0,
              videoFramesEmitted: 0,
            },
          }),
        );
      }) as typeof fetch);
      const result = await transport.mediaStatus(f.attention.id);
      expect(result.state).toBe("unavailable");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
      expect(reads).toBe(kind === "foreign-record" ? 0 : 1);
      if (kind === "missing")
        expect(result).toMatchObject({ reason: "media_not_found" });
      f.store.close();
    },
  );
  it("requires exact exclusive handoff and never enables via credentials alone", () => {
    expect(
      () => new NativeTransport(new Store(), { ...config, enabled: false }),
    ).toThrow("handoff");
    expect(
      () =>
        new NativeTransport(new Store(), {
          ...config,
          handoff: { ...config.handoff, providerLineId: "foreign" },
        }),
    ).toThrow("handoff");
    expect(
      () =>
        new NativeTransport(new Store(), {
          ...config,
          handoff: { ...config.handoff, sourceOwnerPaused: false as true },
        }),
    ).toThrow("handoff");
  });
  it("prepares silent video, dials once with stable ID, activates only bridge_ready and reserves until cleanup", async () => {
    const f = fixture();
    await f.app.drain();
    const mediaId = mediaSessionId(f.attention.id);
    const call = f.requests.find(
      (r) => new URL(r.url).pathname === "/api/v1/calls",
    )!;
    expect(call.body.line_id).toBe(logicalLineId);
    expect(call.body.mode).toBe("customer_managed");
    expect(call.body.livekit_url).toBe("wss://fixture.example.test");
    expect(call.body.media.video).toBe(true);
    f.events(["ringing"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.requests.some((r) => r.url.endsWith("/activate"))).toBe(false);
    f.events(["bridge_ready"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(
      f.requests.find((r) => r.url.endsWith("/activate"))?.body.callId,
    ).toBe(mediaId);
    expect(f.store.get<CallSession>("call", mediaId)?.state).toBe("connected");
    f.events(["bridge_ready", "ended"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.store.get<CallSession>("call", mediaId)?.state).toBe("connected");
    f.events(["bridge_ready", "ended", "cleanup_complete"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.store.get<CallSession>("call", mediaId)?.state).toBe("ended");
    expect(
      f.requests.filter((r) => new URL(r.url).pathname === "/api/v1/calls"),
    ).toHaveLength(1);
  });
  it("speaks a bounded attention question after activation notice and reconciles the stable utterance once", async () => {
    const f = fixture();
    await f.app.drain();
    f.store.put("attention", {
      ...f.store.get<AttentionRequest>("attention", f.attention.id)!,
      question: "Choose the safe fixture option. ".repeat(40),
    });
    f.events(["bridge_ready"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    const speech = f.requests.find((r) => r.url.endsWith("/speak"))!;
    expect(speech.body.id).toBe(`${f.attention.id}:question`);
    expect(speech.body.callId).toBe(mediaSessionId(f.attention.id));
    expect(speech.body.text.length).toBeLessThanOrEqual(280);
    expect(speech.body.text.split(" ").length).toBeLessThanOrEqual(36);
    expect(
      f.requests.findIndex((r) => r.url.endsWith("/activate")),
    ).toBeLessThan(f.requests.findIndex((r) => r.url.endsWith("/speak")));
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.requests.filter((r) => r.url.endsWith("/speak"))).toHaveLength(1);
    expect(
      f.store.get<{ state: string }>("speech", `${f.attention.id}:question`)
        ?.state,
    ).toBe("completed");
  });
  it("omits the setup question across polls and restart without rewriting speech receipts", async () => {
    const f = fixture();
    await f.app.drain();
    f.store.put("setup_test", {
      id: "setup_fixture",
      requestId: f.attention.id,
      sessionId: f.attention.sessionId,
      pairingId: f.attention.pairingId,
      state: "call_requested",
      createdAt: Date.now(),
      expiresAt: f.attention.deadline,
      invitationEffectId: "setup_fixture:invite",
    });
    f.events(["bridge_ready"]);
    const observe = (id: string, state: any, qualified?: boolean) =>
      f.app.observeCall(id, state, qualified);
    await f.transport.pollCalls(observe);
    await f.transport.pollCalls(observe);
    const restarted = new NativeTransport(f.store, config, f.request);
    await restarted.pollCalls(observe);
    expect(f.requests.filter((r) => r.url.endsWith("/speak"))).toHaveLength(0);
    expect(f.store.get("speech", `${f.attention.id}:question`)).toBeUndefined();
    expect(
      f.store.get<CallSession>("call", mediaSessionId(f.attention.id))?.state,
    ).toBe("connected");
    const speech = {
      id: `${f.attention.id}:question`,
      sessionId: mediaSessionId(f.attention.id),
      requestId: f.attention.id,
      state: "unknown",
      fingerprint: "retained-fingerprint",
    };
    f.store.put("speech", speech);
    await restarted.pollCalls(observe);
    expect(f.requests.filter((r) => r.url.endsWith("/speak"))).toHaveLength(0);
    expect(f.requests.filter((r) => r.url.includes("/speech/"))).toHaveLength(
      1,
    );
    expect(f.store.get("speech", speech.id)).toEqual({
      ...speech,
      state: "completed",
    });
    f.store.close();
  });
  it("does not suppress an ordinary question because an unrelated setup test exists", async () => {
    const f = fixture();
    await f.app.drain();
    f.store.put("setup_test", {
      id: "foreign-setup",
      requestId: f.attention.id,
      sessionId: "another-session",
      pairingId: f.attention.pairingId,
    });
    f.events(["bridge_ready"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.requests.filter((r) => r.url.endsWith("/speak"))).toHaveLength(1);
    f.store.close();
  });
  it("does not replay a possibly audible question after timeout and keeps call active", async () => {
    const f = fixture();
    await f.app.drain();
    const original = f.transport.media.bind(f.transport);
    let speaks = 0,
      reads = 0;
    f.transport.media = async (path, body) => {
      if (path.endsWith("/speak")) {
        speaks++;
        throw new Error("Response lost after playback began");
      }
      if (path.includes("/speech/")) reads++;
      return original(path, body);
    };
    f.events(["bridge_ready"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(
      f.store.get<{ state: string }>("speech", `${f.attention.id}:question`)
        ?.state,
    ).toBe("unknown");
    expect(
      f.store.get<CallSession>("call", mediaSessionId(f.attention.id))?.state,
    ).toBe("connected");
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(speaks).toBe(1);
    expect(reads).toBe(1);
    expect(
      f.store.get<{ state: string }>("speech", `${f.attention.id}:question`)
        ?.state,
    ).toBe("completed");
  });
  it("still sends native hangup when media close is unavailable and preserves separate cleanup state", async () => {
    const f = fixture();
    await f.app.drain();
    f.failClose();
    const result = await f.transport.endCall(nativeCallId, "fixture-end");
    expect(
      f.requests.some((r) => r.url.endsWith(`/calls/${nativeCallId}/end`)),
    ).toBe(true);
    expect(result.mediaClosed).toBe(false);
    expect(result.cleanupPending).toBe(true);
    expect(
      f.store.get<CallSession>("call", mediaSessionId(f.attention.id))?.state,
    ).toBe("ringing");
  });
  it("recovers a committed provider allocation by read-only events after interrupted domain receipt commit", async () => {
    const f = fixture();
    await f.app.drain();
    const localId = mediaSessionId(f.attention.id),
      effect = f.store.effects()[0]!;
    f.store.putEffect({ ...effect, state: "unknown" });
    f.store.put("attention", { ...f.attention, state: "unknown" });
    const original = f.store.get<CallSession>("call", localId)!;
    f.store.put("call", {
      ...original,
      providerCallId: undefined,
      state: "prepared",
    });
    const before = f.requests.length;
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.requests.slice(before).every((r) => r.method === "GET")).toBe(
      true,
    );
    expect(f.store.effect(effect.id)?.state).toBe("done");
    expect(f.store.get<CallSession>("call", localId)?.providerCallId).toBe(
      nativeCallId,
    );
    expect(
      f.store.get<AttentionRequest>("attention", f.attention.id)?.state,
    ).toBe("ringing");
  });
  it("standby recovery of a committed allocation only recovers identifiers for cleanup, never activation or speech", async () => {
    const f = fixture();
    await f.app.drain();
    const localId = mediaSessionId(f.attention.id),
      effect = f.store.effects()[0]!;
    f.store.putEffect({ ...effect, state: "unknown" });
    f.store.put("attention", { ...f.attention, state: "unknown" });
    const call = f.store.get<CallSession>("call", localId)!;
    f.store.put("call", {
      ...call,
      providerCallId: undefined,
      state: "prepared",
    });
    f.events(["bridge_ready"]);
    await f.transport.pollCalls(
      (id, state, qualified) => f.app.observeCall(id, state, qualified),
      { cleanupOnly: true },
    );
    expect(
      f.requests.some(
        (r) => r.url.endsWith("/activate") || r.url.endsWith("/speak"),
      ),
    ).toBe(false);
    expect(
      f.store.get<AttentionRequest>("attention", f.attention.id)?.state,
    ).toBe("expired");
    expect(f.store.get<CallSession>("call", localId)?.providerCallId).toBe(
      nativeCallId,
    );
    expect(
      f.store.effects("pending").filter((e) => e.kind === "end_call"),
    ).toHaveLength(1);
    await f.app.drain({ cleanupOnly: true });
    expect(
      f.requests.filter((r) => r.url.endsWith(`/calls/${nativeCallId}/end`)),
    ).toHaveLength(1);
  });
  it("does not activate media after attention is canceled and cleanup-only drain sends no new call", async () => {
    const f = fixture();
    await f.app.drain({ cleanupOnly: true });
    expect(f.requests).toHaveLength(0);
    await f.app.drain();
    f.app.failCall(f.attention.id);
    f.events(["bridge_ready"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    expect(f.requests.some((r) => r.url.endsWith("/activate"))).toBe(false);
    await f.app.drain({ cleanupOnly: true });
    expect(f.requests.some((r) => r.url.endsWith("/end"))).toBe(true);
  });
  it("rechecks pairing revocation after media preparation before native allocation", async () => {
    const f = fixture(),
      original = f.transport.media.bind(f.transport);
    f.transport.media = async (path, body) => {
      const result = await original(path, body);
      if (path === "/sessions") f.app.disconnect(f.agent.token);
      return result;
    };
    await f.app.drain();
    expect(
      f.requests.some((r) => new URL(r.url).pathname === "/api/v1/calls"),
    ).toBe(false);
    expect(f.store.effects("unknown")).toHaveLength(1);
  });
});

async function cleanupReconciliationFixture(
  state: "closed" | "closing" = "closed",
) {
  const f = fixture();
  await f.app.drain();
  const localId = mediaSessionId(f.attention.id);
  if (state === "closed") f.app.observeCall(f.attention.id, "ended");
  const request = f.store.get<AttentionRequest>("attention", f.attention.id)!;
  f.store.put("attention", {
    ...request,
    state: "completed",
    result: "Fixture completed result",
  });
  f.store.put("media", {
    id: localId,
    requestId: request.id,
    providerCallId: nativeCallId,
    state,
  });
  const effect = f.store.putEffect({
    id: `${request.id}:end`,
    kind: "end_call",
    state: "unknown",
    createdAt: Date.now(),
    payload: {
      requestId: request.id,
      pairingId: request.pairingId,
      callId: nativeCallId,
    },
    result: { reason: "Original end acknowledgement unknown" },
  });
  f.events(["ended", "cleanup_complete"]);
  const rawMedia = f.transport.media.bind(f.transport);
  f.transport.media = async (path, body) => {
    const result = await rawMedia(path, body);
    return path === `/sessions/${localId}` && body === undefined
      ? {
          ...result,
          id: localId,
          alive: false,
          state: "closed",
          privateDiagnostic: "DO_NOT_RETAIN",
        }
      : result;
  };
  const poll = () =>
    f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
  return {
    ...f,
    localId,
    effect,
    poll,
    auditId: `end-call-reconciliation:${effect.id}`,
  };
}

describe("read-only unknown end-call reconciliation", () => {
  it.each(["closed", "closing"] as const)(
    "reconciles exact %s cleanup using only GET and retains the original unknown acknowledgement",
    async (state) => {
      const f = await cleanupReconciliationFixture(state);
      f.store.putEffect({
        id: "unrelated-unknown",
        kind: "message",
        state: "unknown",
        createdAt: 1,
        payload: { text: "untouched" },
      });
      f.store.saveState("unrelated-state", { untouched: true });
      const cursor = f.transport.messages.cursor(),
        other = f.store.effect("unrelated-unknown"),
        original = f.store.effect(f.effect.id),
        before = f.requests.length;
      await f.poll();
      expect(f.store.effect(f.effect.id)).toMatchObject({
        state: "done",
        result: {
          accepted: true,
          cleanupConfirmed: true,
          mediaClosed: true,
          cleanupPending: false,
          recovered: true,
          nativeEndAcknowledgementUnknown: true,
        },
      });
      const audit = f.store.event<any>(f.auditId)!;
      expect(audit.result.originalEffect).toEqual(original);
      expect(audit.result.nativeEvent).toMatchObject({
        id: "event-1",
        source: "worker",
        type: "cleanup_complete",
      });
      expect(audit.result.mediaEvidence).toEqual({
        id: f.localId,
        alive: false,
        state: "closed",
      });
      expect(JSON.stringify(audit)).not.toContain("DO_NOT_RETAIN");
      expect(f.store.get<CallSession>("call", f.localId)?.state).toBe("ended");
      expect(
        f.store.get<AttentionRequest>("attention", f.attention.id)?.state,
      ).toBe("completed");
      expect(f.store.get<{ state: string }>("media", f.localId)?.state).toBe(
        "closed",
      );
      expect(f.requests.slice(before).map((r) => r.method)).toEqual([
        "GET",
        "GET",
      ]);
      expect(f.store.effect("unrelated-unknown")).toEqual(other);
      expect(f.transport.messages.cursor()).toEqual(cursor);
      expect(f.store.state("unrelated-state")).toEqual({ untouched: true });
      const reads = f.requests.length,
        effects = f.store.effects(),
        events = f.store.query("SELECT * FROM events");
      await f.poll();
      expect(f.requests).toHaveLength(reads);
      expect(f.store.effects()).toEqual(effects);
      expect(f.store.query("SELECT * FROM events")).toEqual(events);
      f.store.close();
    },
  );
  it.each([
    "forged-source",
    "no-cleanup",
    "wrong-call",
    "duplicate-event",
    "media-alive",
    "media-open",
    "wrong-media",
    "media-unavailable",
    "events-unavailable",
  ])("preserves unknown with %s evidence", async (failure) => {
    const f = await cleanupReconciliationFixture(),
      calls = f.transport.calls.bind(f.transport),
      media = f.transport.media.bind(f.transport);
    f.transport.calls = async (path, body, key) => {
      const response = await calls(path, body, key);
      const data = response.data as {
        call_id: string;
        events: { id: string; type: string; source: string }[];
      };
      if (path.endsWith("/events")) {
        if (failure === "events-unavailable")
          throw new Error("private event failure");
        if (failure === "wrong-call")
          response.data = { ...data, call_id: "other" };
        if (failure === "forged-source")
          data.events = data.events.map((e: any) => ({ ...e, source: "api" }));
        if (failure === "no-cleanup")
          data.events = data.events.filter(
            (e: any) => e.type !== "cleanup_complete",
          );
        if (failure === "duplicate-event")
          data.events.push({ ...data.events[1]! });
      }
      return response;
    };
    f.transport.media = async (path, body) => {
      const response = await media(path, body);
      if (failure === "media-unavailable")
        throw new Error("private media failure");
      if (failure === "media-alive") response.alive = true;
      if (failure === "media-open") response.state = "active";
      if (failure === "wrong-media") response.id = "other";
      return response;
    };
    const before = f.requests.length,
      original = f.store.effect(f.effect.id);
    await f.poll();
    expect(f.store.effect(f.effect.id)).toEqual(original);
    expect(f.store.event(f.auditId)).toBeUndefined();
    expect(f.requests.slice(before).every((r) => r.method === "GET")).toBe(
      true,
    );
    f.store.close();
  });
  it.each([
    "kind",
    "request-payload",
    "pairing-payload",
    "call-payload",
    "request-call",
    "call-request",
    "call-pairing",
    "call-provider",
    "media-id",
    "line",
  ])("refuses a mismatched %s before provider reads", async (mismatch) => {
    const f = await cleanupReconciliationFixture();
    if (mismatch === "kind")
      f.store.putEffect({ ...f.effect, kind: "message" });
    if (mismatch === "request-payload")
      f.store.putEffect({
        ...f.effect,
        payload: { ...f.effect.payload, requestId: "other" },
      });
    if (mismatch === "pairing-payload")
      f.store.putEffect({
        ...f.effect,
        payload: { ...f.effect.payload, pairingId: "other" },
      });
    if (mismatch === "call-payload")
      f.store.putEffect({
        ...f.effect,
        payload: { ...f.effect.payload, callId: "other" },
      });
    const call = f.store.get<CallSession>("call", f.localId)!;
    if (mismatch === "request-call")
      f.store.put("attention", {
        ...f.store.get<AttentionRequest>("attention", f.attention.id)!,
        callId: "other",
      });
    if (mismatch === "call-request")
      f.store.put("call", { ...call, requestId: "other" });
    if (mismatch === "call-pairing")
      f.store.put("call", { ...call, pairingId: "other" });
    if (mismatch === "call-provider")
      f.store.put("call", { ...call, providerCallId: "other" });
    if (mismatch === "media-id")
      f.store.db
        .prepare(
          "UPDATE entities SET body=json_set(body,'$.id','other') WHERE kind='media' AND id=?",
        )
        .run(f.localId);
    if (mismatch === "line")
      f.store.put("pairing", { ...f.pair.pairing, lineId: "other" });
    const before = f.requests.length,
      original = f.store.effect(f.effect.id);
    await f.poll();
    expect(f.requests).toHaveLength(before);
    expect(f.store.effect(f.effect.id)).toEqual(original);
    expect(f.store.event(f.auditId)).toBeUndefined();
    f.store.close();
  });
  it.each(["effect", "request", "pairing", "call", "media"])(
    "CAS refuses concurrent %s mutation during GET evidence",
    async (kind) => {
      const f = await cleanupReconciliationFixture(),
        media = f.transport.media.bind(f.transport);
      f.transport.media = async (path, body) => {
        const response = await media(path, body);
        if (kind === "effect")
          f.store.putEffect({
            ...f.effect,
            result: { reason: "concurrent writer" },
          });
        else {
          const id =
            kind === "request"
              ? f.attention.id
              : kind === "pairing"
                ? f.pair.pairing.id
                : f.localId;
          const entityKind = kind === "request" ? "attention" : kind;
          f.store.put(entityKind, {
            ...f.store.get(entityKind, id)!,
            id,
            changed: true,
          });
        }
        return response;
      };
      await f.poll();
      expect(f.store.effect(f.effect.id)?.state).toBe("unknown");
      expect(f.store.event(f.auditId)).toBeUndefined();
      f.store.close();
    },
  );
  it("rolls back when insert-only audit persistence fails and never overwrites an existing audit", async () => {
    const f = await cleanupReconciliationFixture("closing"),
      call = f.store.get("call", f.localId),
      media = f.store.get("media", f.localId);
    f.store.db.exec(
      "CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON events WHEN NEW.id LIKE 'end-call-reconciliation:%' BEGIN SELECT RAISE(ABORT,'fixture audit refusal'); END",
    );
    await f.poll();
    expect(f.store.effect(f.effect.id)).toEqual(f.effect);
    expect(f.store.event(f.auditId)).toBeUndefined();
    expect(f.store.get("call", f.localId)).toEqual(call);
    expect(f.store.get("media", f.localId)).toEqual(media);
    f.store.db.exec("DROP TRIGGER reject_cleanup_audit");
    f.store.recordEvent(f.auditId, "original", { retained: true });
    const before = f.requests.length;
    await f.poll();
    expect(f.requests).toHaveLength(before);
    expect(f.store.effect(f.effect.id)).toEqual(f.effect);
    expect(f.store.event(f.auditId)?.result).toEqual({ retained: true });
    f.store.close();
  });
  it("rolls back audit and partially observed cleanup when the synchronous observer fails", async () => {
    const f = await cleanupReconciliationFixture("closing"),
      call = f.store.get("call", f.localId),
      media = f.store.get("media", f.localId);
    await f.transport.pollCalls((id, state) => {
      f.app.observeCall(id, state);
      throw new Error("fixture observer failure");
    });
    expect(f.store.effect(f.effect.id)).toEqual(f.effect);
    expect(f.store.event(f.auditId)).toBeUndefined();
    expect(f.store.get("call", f.localId)).toEqual(call);
    expect(f.store.get("media", f.localId)).toEqual(media);
    f.store.close();
  });
});

describe("conversation read-only call maintenance", () => {
  it("does not activate, speak or end while observing a bridge-ready call", async () => {
    const f = fixture();
    await f.app.drain();
    f.events(["bridge_ready"]);
    const before = f.requests.length;
    await f.transport.pollCalls(
      (id, state, qualified) => f.app.observeCall(id, state, qualified),
      { observeOnly: true },
    );
    expect(f.requests.slice(before).every((r) => r.method === "GET")).toBe(
      true,
    );
    expect(
      f.store.get<any>("media", mediaSessionId(f.attention.id))?.state,
    ).toBe("allocated");
    expect(f.store.effect(`${f.attention.id}:end`)).toBeUndefined();
    f.store.close();
  });
  it("propagates worker termination without claiming media cleanup or sending POSTs", async () => {
    const f = fixture();
    await f.app.drain();
    f.events(["bridge_ready"]);
    await f.transport.pollCalls((id, state, qualified) =>
      f.app.observeCall(id, state, qualified),
    );
    f.events(["bridge_ready", "ended", "cleanup_complete"]);
    const before = f.requests.length;
    const observed: string[] = [];
    await f.transport.pollCalls(
      (id, state, qualified) => f.app.observeCall(id, state, qualified),
      {
        observeOnly: true,
        onTerminalPending: (id) => {
          observed.push(id);
          f.app.failCall(id);
        },
      },
    );
    expect(observed).toEqual([f.attention.id]);
    expect(f.requests.slice(before).every((r) => r.method === "GET")).toBe(
      true,
    );
    expect(
      f.store.get<AttentionRequest>("attention", f.attention.id)?.state,
    ).toBe("failed");
    expect(
      f.store.get<CallSession>("call", mediaSessionId(f.attention.id))?.state,
    ).toBe("connected");
    expect(f.store.effect(`${f.attention.id}:end`)?.state).toBe("pending");
    f.store.close();
  });
});
