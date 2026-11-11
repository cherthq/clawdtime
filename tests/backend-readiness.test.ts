import { describe, it, expect } from "vitest";
import {
  NativeTransport,
  type NativeTransportConfig,
} from "../src/transport/native.js";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { configurationChecks } from "../src/transport/readiness.js";
import type { Pairing, CallSession } from "../src/contracts.js";
const line = "00000000-0000-4000-8000-000000000099";
function config(): NativeTransportConfig {
  return {
    enabled: true,
    binding: {
      origin: "https://native.example.test",
      token: "fixture-native-secret-unique",
      signingSecret: "fixture-native-signing-secret-unique",
      lineId: line,
      providerLineId: "pl_fixture",
      phone: "+15550000002",
      instanceId: "native-instance",
    },
    callsOrigin: "https://calls.example.test",
    projectId: "fixture-project",
    projectKey: "fixture-project-key-unique",
    mediaOrigin: "https://media.example.test",
    mediaKey: "fixture-media-key-unique-at-least-32-characters",
    encryptionKey: "1".repeat(64),
    testerAllowlist: ["+15550000001"],
    handoff: {
      owner: "clawdtime",
      sourceOwnerPaused: true,
      phone: "+15550000002",
      identityEvidence: "private-confirmed-requested-line",
      sourcePauseEvidence: "private-source-pause-record",
      lineId: line,
      providerLineId: "pl_fixture",
      instanceId: "native-instance",
      baseline: { sequence: 1, eventId: "fixture-baseline" },
      checkedAt: Date.now(),
      rollbackRecord: "private-rollback-record",
    },
  };
}
function fixture(readOnly = false) {
  const store = new Store(),
    c = config(),
    requests: { url: string; method: string }[] = [];
  const lineRecord: Record<string, any> = {
    id: line,
    phone_number: null,
    status: "available",
    current_call_id: null,
    worker_occupied: false,
    session_health: {
      line_id: line,
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
          checks: [{ id: "system_audio_capture", outcome: "at_call_start" }],
        },
      },
    },
  };
  const media: Record<string, unknown> = {
    service: "clawdtime-media",
    ok: true,
    configured: true,
    devicesConfigured: true,
    deviceGatewayConnected: true,
  };
  const device: Record<string, unknown> = {
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
  const request = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    const path = new URL(String(url)).pathname;
    const body =
      path === "/api/v1/whoami"
        ? {
            healthy: true,
            phone_line: {
              phone_line_id: c.binding.providerLineId,
              phone_number: c.binding.phone,
              instance_id: c.binding.instanceId,
            },
          }
        : path === "/api/v1/events/1"
          ? {
              sequence: 1,
              event_id: "fixture-baseline",
              type: "boundary",
              phone_line_id: c.binding.providerLineId,
              payload: { phone_line_id: c.binding.providerLineId },
            }
          : path === "/api/v1/lines"
            ? { data: { items: [lineRecord], total: 1, limit: 100, offset: 0 } }
            : path === "/health"
              ? media
              : device;
    return new Response(JSON.stringify(body));
  };
  store.saveState(`messages:${line}`, c.handoff.baseline);
  const transport = new NativeTransport(store, c, request as typeof fetch, {
    readOnly,
  });
  const pairing: Pairing = {
    id: "pair",
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: line,
    deviceId: "mac",
    displayId: "1",
    createdAt: Date.now(),
    allowView: true,
    allowControl: true,
  };
  return { store, c, requests, lineRecord, media, device, transport, pairing };
}
describe("read-only live preflight", () => {
  it("accepts null logical phone only with exact logical/native evidence and explicitly deferred audio capture", async () => {
    const f = fixture(),
      before = f.transport.messages.cursor();
    const report = await f.transport.preflight({ requireIdle: true });
    expect(report.liveReady).toBe(true);
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    expect(f.transport.messages.cursor()).toEqual(before);
    expect(f.store.effects()).toHaveLength(0);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(f.c.binding.phone);
    expect(serialized).not.toContain(f.c.binding.token);
    expect(serialized).not.toContain(f.c.projectKey);
  });
  it.each(["line", "phone", "worker", "audio", "heartbeat"])(
    "rejects changed or unsupported %s evidence",
    async (kind) => {
      const f = fixture();
      if (kind === "line") f.lineRecord.id = "foreign";
      if (kind === "phone") f.lineRecord.phone_number = "+15550000009";
      if (kind === "worker") f.lineRecord.session_health.line_id = "foreign";
      if (kind === "audio")
        f.lineRecord.session_health.readiness.automatic.checks = [];
      if (kind === "heartbeat")
        f.lineRecord.session_health.last_heartbeat_at = "2000-01-01T00:00:00Z";
      expect((await f.transport.preflight()).liveReady).toBe(false);
      expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    },
  );
  it("allows owned-call result messaging readiness but denies another new allocation while busy", async () => {
    const f = fixture();
    f.lineRecord.current_call_id = "owned-call";
    f.lineRecord.worker_occupied = true;
    f.lineRecord.status = "busy";
    f.lineRecord.session_health.status = "active";
    f.store.put<CallSession>("call", {
      id: "local",
      requestId: "attention",
      pairingId: "pair",
      providerCallId: "owned-call",
      state: "connected",
      remoteParticipantQualified: true,
      createdAt: Date.now(),
    });
    expect((await f.transport.preflight()).liveReady).toBe(true);
    expect((await f.transport.preflight({ requireIdle: true })).liveReady).toBe(
      false,
    );
    f.lineRecord.current_call_id = "foreign-call";
    expect((await f.transport.preflight()).liveReady).toBe(false);
  });
  it("requires the independent media identity, scoped ACL, attached display, permissions and local Enable", async () => {
    const f = fixture();
    f.media.service = "apple-teams-media";
    expect((await f.transport.preflight()).liveReady).toBe(false);
    let report = await f.transport.preflightDevice(f.pairing);
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    f.device.memberId = "foreign";
    report = await f.transport.preflightDevice(f.pairing);
    expect(report.checks.some((c) => c.status === "fail")).toBe(true);
    f.device.memberId = "member";
    f.device.armed = false;
    report = await f.transport.preflightDevice(f.pairing);
    expect(report.checks.find((c) => c.id === "local_arm")?.status).toBe(
      "fail",
    );
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("validates deployment bindings, independent secrets and actual handoff evidence", () => {
    const c = config();
    expect(configurationChecks(c).every((c) => c.status === "pass")).toBe(true);
    c.handoff.phone = "+15550000009";
    expect(
      configurationChecks(c).find((c) => c.id === "line_handoff")?.status,
    ).toBe("fail");
    c.handoff.phone = c.binding.phone;
    c.handoff.sourcePauseEvidence = undefined;
    expect(
      configurationChecks(c).find((c) => c.id === "line_handoff")?.status,
    ).toBe("fail");
    c.mediaKey = c.projectKey;
    expect(
      configurationChecks(c).find((c) => c.id === "service_configuration")
        ?.status,
    ).toBe("fail");
    c.binding.lineId = "native-inventory-id-not-logical-uuid";
    expect(
      configurationChecks(c).find((c) => c.id === "native_configuration")
        ?.status,
    ).toBe("fail");
  });
  it("read-only transport cannot POST through any exposed provider client", async () => {
    const f = fixture(true);
    await expect(f.transport.calls("/api/v1/calls", {})).rejects.toThrow(
      "Read-only",
    );
    await expect(f.transport.media("/sessions", {})).rejects.toThrow(
      "Read-only",
    );
    await expect(
      f.transport.messages.api("/api/v1/text-operations/v1", {}),
    ).rejects.toThrow("Read-only");
    expect(f.requests).toHaveLength(0);
    expect((await f.transport.preflight()).liveReady).toBe(true);
  });
  it("doctor requires fresh scoped evidence and never turns pairing consent into live readiness", async () => {
    const f = fixture();
    let now = Date.now();
    const service = new ClawdTime(f.store, f.transport, { clock: () => now });
    const invite = service.createPairingInvite({
      memberId: "member",
      recipient: f.pairing.recipient,
      conversationId: f.pairing.conversationId,
      lineId: line,
      deviceId: "mac",
      displayId: "1",
    });
    const pair = service.claimPairing({
      token: invite.token,
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl: true,
    });
    expect(service.doctor(pair.token).readiness.liveReady).toBe(false);
    await f.transport.preflight();
    await f.transport.preflightDevice(pair.pairing);
    expect(service.doctor(pair.token).readiness.liveReady).toBe(true);
    now += 31000;
    expect(service.doctor(pair.token).readiness.liveReady).toBe(false);
  });
  it("preflight failure leaves call effect pending without pretending a native call occurred", async () => {
    const f = fixture();
    const service = new ClawdTime(f.store, f.transport);
    const invite = service.createPairingInvite({
      memberId: "member",
      recipient: f.pairing.recipient,
      conversationId: f.pairing.conversationId,
      lineId: line,
      deviceId: "mac",
      displayId: "1",
    });
    const pair = service.claimPairing({
      token: invite.token,
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl: true,
    });
    const session = service.registerSession(pair.token, {
      adapter: "codex",
      adapterVersion: "fixture",
      projectRoot: "/disposable",
      externalSessionId: "fixture",
      hostId: "mac",
      capabilities: { cooperativePause: true, polling: true },
    });
    service.yieldSession(session.token);
    service.requestAttention(session.token, {
      taskId: "task",
      idempotencyKey: "stable",
      reason: "decision",
      question: "Fixture?",
    });
    f.device.armed = false;
    await service.drain();
    expect(f.store.effects("pending")).toHaveLength(1);
    expect(f.store.effects("unknown")).toHaveLength(0);
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
  });
});
