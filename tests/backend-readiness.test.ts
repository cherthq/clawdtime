import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeTransport,
  type NativeTransportConfig,
} from "../src/transport/native.js";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { configurationChecks } from "../src/transport/readiness.js";
import type { Pairing, CallSession } from "../src/contracts.js";
import { Vault, hash } from "../src/storage/security.js";
import {
  retireObsoleteNotice,
  noticeRetirementValid,
} from "../src/control/obsolete-notice.js";
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
function fixture(readOnly = false, store = new Store()) {
  const c = config(),
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
function obsoleteNoticeFixture(store?: Store) {
  const f = fixture(false, store),
    vault = new Vault(f.c.encryptionKey),
    now = Date.now();
  const pairing = { ...f.pairing, createdAt: now - 600_000 },
    rawToken = "fixture-old-single-use-pairing-token",
    origin = "https://clawdtime.example.test";
  const binding = Object.fromEntries(
    [
      "memberId",
      "recipient",
      "lineId",
      "conversationId",
      "deviceId",
      "displayId",
    ].map((k) => [k, pairing[k as keyof Pairing]]),
  );
  f.store.put("pairing", pairing);
  f.store.put("invite", {
    id: hash(rawToken),
    binding,
    expiresAt: now - 1,
    consumedAt: pairing.createdAt,
    pairingId: pairing.id,
  });
  const inbound = {
    id: "fixture-original-pair",
    sender: pairing.recipient,
    lineId: pairing.lineId,
    conversationId: pairing.conversationId,
    text: "pair",
  };
  f.store.put("inbound", {
    id: inbound.id,
    state: "done",
    sealed: vault.seal(inbound),
  });
  const notice = {
    id: `${inbound.id}:notice`,
    state: "unknown",
    pairing: {
      ...pairing,
      id: "onboarding-fixture",
      allowView: false,
      allowControl: false,
    },
    sealed: vault.seal(
      `Install and pair your Mac: ${origin}/pair#token=${rawToken}&device=${pairing.deviceId}&display=${pairing.displayId} . This private link expires in 10 minutes.`,
    ),
  };
  f.store.put("notice", notice);
  const input = {
    noticeId: notice.id,
    pairingId: pairing.id,
    evidenceReference: `sha256:${"a".repeat(64)}`,
    allowedOrigins: [origin],
  };
  return {
    ...f,
    vault,
    notice,
    input,
    retire: () => retireObsoleteNotice(f.store, vault, input, now),
  };
}
describe("read-only live preflight", () => {
  it("treats a malformed null audit as invalid without throwing or clearing unknown delivery", async () => {
    const f = obsoleteNoticeFixture();
    f.store.recordEvent(
      `obsolete-notice-retirement:${f.notice.id}`,
      hash("null"),
      null,
    );
    expect(noticeRetirementValid(f.store, f.notice)).toBe(false);
    expect((await f.transport.preflight()).liveReady).toBe(false);
    expect(f.store.get("notice", f.notice.id)).toEqual(f.notice);
    f.store.close();
  });
  it("retains the exact obsolete notice and audit across restart without requeueing", () => {
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-retirement-")),
      path = join(directory, "state.sqlite");
    try {
      const f = obsoleteNoticeFixture(new Store(path));
      f.retire();
      const cursor = f.transport.messages.cursor();
      f.store.close();
      const reopened = new Store(path);
      try {
        const notice = reopened.get<typeof f.notice>("notice", f.notice.id)!;
        expect(notice).toEqual(f.notice);
        expect(noticeRetirementValid(reopened, notice)).toBe(true);
        expect(reopened.state(`messages:${line}`)).toEqual(cursor);
        expect(reopened.effects()).toHaveLength(0);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    "unconsumed",
    "unexpired",
    "foreign-binding",
    "unproven-inbound",
    "different-message",
    "running-notice",
    "malformed-timestamp",
  ])("refuses obsolete notice retirement with %s evidence", (kind) => {
    const f = obsoleteNoticeFixture();
    const invite = f.store.all<{
      id: string;
      consumedAt?: number;
      expiresAt: number;
      binding: Record<string, unknown>;
    }>("invite")[0]!;
    if (kind === "unconsumed")
      f.store.put("invite", { ...invite, consumedAt: undefined });
    if (kind === "unexpired")
      f.store.put("invite", { ...invite, expiresAt: Date.now() + 100_000 });
    if (kind === "foreign-binding")
      f.store.put("invite", {
        ...invite,
        binding: { ...invite.binding, lineId: "other" },
      });
    if (kind === "unproven-inbound")
      f.store.put("inbound", { id: "fixture-original-pair", state: "unknown" });
    if (kind === "different-message")
      f.store.put("notice", {
        ...f.notice,
        sealed: f.vault.seal("A different unknown message"),
      });
    if (kind === "running-notice")
      f.store.put("notice", { id: "other-in-flight", state: "running" });
    if (kind === "malformed-timestamp")
      f.store.put("pairing", {
        ...f.store.get<Pairing>("pairing", f.input.pairingId)!,
        createdAt: undefined,
      });
    expect(() => f.retire()).toThrow("incomplete");
    expect(
      f.store.event(`obsolete-notice-retirement:${f.notice.id}`),
    ).toBeUndefined();
    expect(f.store.effects()).toHaveLength(0);
    f.store.close();
  });
  it("exempts only an immutable obsolete invitation audit while retaining unknown delivery and cursor", async () => {
    const f = obsoleteNoticeFixture(),
      cursor = f.transport.messages.cursor();
    expect((await f.transport.preflight()).liveReady).toBe(false);
    const audit = f.retire();
    expect(audit.deliveryOutcome).toBe("unknown");
    expect(audit.replayAllowed).toBe(false);
    expect(f.retire()).toEqual(audit);
    expect(() =>
      retireObsoleteNotice(f.store, f.vault, {
        ...f.input,
        evidenceReference: `sha256:${"b".repeat(64)}`,
      }),
    ).toThrow("incomplete");
    const report = await f.transport.preflight();
    expect(report.liveReady).toBe(true);
    expect(report.recovery).toEqual({
      unknownNoticeCount: 1,
      retiredObsoleteNoticeCount: 1,
      blockingUncertainCount: 0,
    });
    expect(f.store.get("notice", f.notice.id)).toEqual(f.notice);
    expect(f.transport.messages.cursor()).toEqual(cursor);
    expect(f.store.effects()).toHaveLength(0);
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    f.store.close();
  });
  it.each(["notice", "invite", "pairing", "audit"])(
    "invalidates obsolete notice exemption after %s mutation",
    async (kind) => {
      const f = obsoleteNoticeFixture();
      const audit = f.retire();
      if (kind === "notice")
        f.store.put("notice", {
          ...f.notice,
          sealed: `${f.notice.sealed}changed`,
        });
      if (kind === "invite")
        f.store.put("invite", {
          ...f.store.get<{ id: string }>("invite", audit.inviteId)!,
          expiresAt: Date.now() + 100_000,
        });
      if (kind === "pairing")
        f.store.put("pairing", {
          ...f.store.get<Pairing>("pairing", audit.pairingId)!,
          deviceId: "foreign",
        });
      if (kind === "audit")
        f.store.db
          .prepare("UPDATE events SET fingerprint=? WHERE id=?")
          .run("corrupted", `obsolete-notice-retirement:${f.notice.id}`);
      const notice = f.store.get<typeof f.notice>("notice", f.notice.id)!;
      expect(noticeRetirementValid(f.store, notice)).toBe(false);
      expect((await f.transport.preflight()).liveReady).toBe(false);
      f.store.close();
    },
  );
  it.each(["notice", "effect", "call", "lease", "action"])(
    "keeps every other unknown %s blocking after obsolete notice retirement",
    async (kind) => {
      const f = obsoleteNoticeFixture();
      f.retire();
      if (kind === "effect")
        f.store.putEffect({
          id: "other",
          kind: "message",
          state: "unknown",
          payload: {},
          createdAt: Date.now(),
        });
      else f.store.put(kind, { id: "other", state: "unknown" });
      const report = await f.transport.preflight();
      expect(report.liveReady).toBe(false);
      expect(report.recovery?.retiredObsoleteNoticeCount).toBe(1);
      expect(report.recovery?.blockingUncertainCount).toBe(1);
      f.store.close();
    },
  );
  it.each([
    ["lease", "unknown"],
    ["action", "unknown"],
    ["action", "submitted"],
    ["action", "running"],
  ])("retains recovery blocking for %s state %s", async (kind, state) => {
    const f = fixture();
    f.store.put(kind, { id: "uncertain-control", state });
    const report = await f.transport.preflight();
    expect(report.checks.find((c) => c.id === "local_recovery")?.status).toBe(
      "fail",
    );
    expect(report.liveReady).toBe(false);
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    f.store.close();
  });
  it("does not confuse active leases and observed actions with unresolved recovery", async () => {
    const f = fixture();
    f.store.put("lease", { id: "active-view", state: "active" });
    f.store.put("action", { id: "observed", state: "observed" });
    expect(
      (await f.transport.preflight()).checks.find(
        (c) => c.id === "local_recovery",
      )?.status,
    ).toBe("pass");
    f.store.close();
  });
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
