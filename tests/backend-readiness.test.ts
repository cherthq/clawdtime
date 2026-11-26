import { legacySetupInvitation } from "../src/pairing/retired-setup.js";
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
function fixture(
  readOnly = false,
  store = new Store(),
  textTransport?: NativeTransportConfig["textTransport"],
) {
  const c = config(),
    requests: { url: string; method: string; body?: unknown }[] = [];
  if (textTransport !== undefined) c.textTransport = textTransport;
  const standard = {
    body: {
      success: true,
      guid: "00000000-0000-4000-8000-000000000001",
      delivery: { isSent: true, isDelivered: false, error: 0 },
    } as unknown,
    raw: undefined as string | undefined,
    status: 200,
    unavailable: false,
  };
  const receipt = {
    status: 404,
    body: undefined as unknown,
    raw: undefined as string | undefined,
    unavailable: false,
  };
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
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const path = new URL(String(url)).pathname;
    if (path === "/send") {
      if (standard.unavailable)
        throw new Error("Fixture timeout after possible submission");
      return new Response(standard.raw ?? JSON.stringify(standard.body), {
        status: standard.status,
      });
    }
    if (path.startsWith("/api/v1/text-operations/v1/")) {
      // Match the native route's accepted operation-origin grammar.
      if (!/^text_[a-f0-9]{32}$/.test(path.split("/").at(-1)!))
        return new Response(
          JSON.stringify({ error: "invalid text operation request" }),
          { status: 400 },
        );
      if (receipt.unavailable) throw new Error("Fixture unavailable");
      return new Response(
        receipt.raw ??
          JSON.stringify(
            receipt.body ?? { found: false, origin: path.split("/").at(-1) },
          ),
        { status: receipt.status },
      );
    }
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
  if (!store.state(`messages:${line}`))
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
  return {
    store,
    c,
    requests,
    lineRecord,
    media,
    device,
    receipt,
    standard,
    transport,
    pairing,
  };
}
describe("explicit standard text transport", () => {
  it("keeps strict receipt mode as the default and fingerprints an explicit mode change", async () => {
    const f = fixture(true);
    const strict = new NativeTransport(
      f.store,
      { ...f.c, textTransport: "strict_receipts" },
      f.transport.messages.request,
      { readOnly: true },
    );
    const standard = new NativeTransport(
      f.store,
      { ...f.c, textTransport: "standard_once" },
      f.transport.messages.request,
      { readOnly: true },
    );
    expect(strict.bindingFingerprint()).toBe(f.transport.bindingFingerprint());
    expect(standard.bindingFingerprint()).not.toBe(strict.bindingFingerprint());
    f.receipt.body = { error: "Not found" };
    expect((await f.transport.preflight()).liveReady).toBe(false);
    expect(f.requests.some((r) => new URL(r.url).pathname === "/send")).toBe(
      false,
    );
    f.store.close();
  });
  it.each([null, "", "fallback", true])(
    "rejects invalid explicit transport mode %s",
    (mode) => {
      const f = fixture(true);
      const invalid = { ...f.c, textTransport: mode as never };
      expect(
        configurationChecks(invalid).find(
          (c) => c.id === "service_configuration",
        )?.status,
      ).toBe("fail");
      expect(
        () =>
          new NativeTransport(f.store, invalid, f.transport.messages.request, {
            readOnly: true,
          }),
      ).toThrow();
      expect(f.requests).toHaveLength(0);
      f.store.close();
    },
  );
  it("does not probe unsupported receipts in explicit standard mode and reports its limitation", async () => {
    const f = fixture(true, new Store(), "standard_once");
    f.receipt.unavailable = true;
    const report = await f.transport.preflight();
    expect(report.liveReady).toBe(true);
    expect(
      report.checks.find((c) => c.id === "native_text_transport"),
    ).toMatchObject({
      status: "pass",
      message: expect.stringContaining("Send capability is untested"),
    });
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    expect(f.requests.some((r) => r.url.includes("text-operations"))).toBe(
      false,
    );
    f.transport.messages.verify = async () => {
      throw new Error("Fixture identity mismatch");
    };
    expect(
      (await f.transport.preflight()).checks.find(
        (c) => c.id === "native_text_transport",
      )?.status,
    ).toBe("fail");
    f.store.close();
  });
  it("submits exactly one bound standard request and reports only provider acknowledgement", async () => {
    const f = fixture(false, new Store(), "standard_once");
    const result = await f.transport.message(
      f.pairing,
      "Synthetic fixture",
      "fixture-effect",
    );
    expect(result).toEqual({
      accepted: true,
      receiptId: "00000000-0000-4000-8000-000000000001",
      status: "acknowledged",
      operationOrigin: `text_${hash("fixture-effect").slice(0, 32)}`,
    });
    expect(result).not.toHaveProperty("delivered");
    expect(f.requests.filter((r) => r.method === "POST")).toEqual([
      {
        url: `${f.c.binding.origin}/send`,
        method: "POST",
        body: {
          to: f.pairing.recipient,
          message: "Synthetic fixture",
          idempotency_key: result.operationOrigin,
          native_sms_disabled: true,
        },
      },
    ]);
    expect(f.requests.some((r) => r.url.includes("text-operations"))).toBe(
      false,
    );
    f.store.close();
  });
  it.each([
    { guid: undefined },
    { guid: "synthetic-receipt" },
    { success: false },
    { delivery: { isSent: false, error: 0 } },
    { delivery: { isSent: true, error: 1 } },
    { queued: true },
    { duplicate: true },
    { suppressed: true },
    { error: "failure" },
    { status: "pending" },
    { from: "+15550000003" },
    { to: "+15550000003" },
    { phone_line_id: "other" },
  ])(
    "refuses uncertain standard acknowledgement %# without an alternate route",
    async (override) => {
      const f = fixture(false, new Store(), "standard_once");
      f.standard.body = { ...(f.standard.body as object), ...override };
      await expect(
        f.transport.message(f.pairing, "Synthetic fixture", "fixture-effect"),
      ).rejects.toThrow("outcome unknown");
      expect(
        f.requests
          .filter((r) => r.method === "POST")
          .map((r) => new URL(r.url).pathname),
      ).toEqual(["/send"]);
      expect(f.requests.some((r) => r.url.includes("text-operations"))).toBe(
        false,
      );
      f.store.close();
    },
  );
  it.each([
    "accepted",
    "timeout",
    "non_json",
    "malformed",
    "queued",
    "http_error",
    "http_accepted",
  ] as const)(
    "retains %s submission through repeated drain and restart without resubmitting",
    async (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), "clawdtime-standard-once-"));
      const path = join(directory, "state.sqlite");
      let open: Store | undefined;
      try {
        const f = fixture(false, (open = new Store(path)), "standard_once");
        if (outcome === "timeout") f.standard.unavailable = true;
        if (outcome === "non_json")
          f.standard.raw = "<html>Fixture interrupted</html>";
        if (outcome === "malformed") f.standard.body = { success: true };
        if (outcome === "queued") {
          f.standard.status = 202;
          f.standard.body = {
            success: true,
            queued: true,
            message_id: "fixture-queued",
          };
        }
        if (outcome === "http_error") f.standard.status = 503;
        if (outcome === "http_accepted") f.standard.status = 202;
        f.store.put("pairing", f.pairing);
        f.store.put("attention", {
          id: "fixture-completed-request",
          pairingId: f.pairing.id,
          sessionId: "fixture-session",
          state: "completed",
          createdAt: Date.now(),
          deadline: Date.now() + 60_000,
        });
        f.store.putEffect({
          id: "fixture-message",
          kind: "message",
          state: "pending",
          createdAt: Date.now(),
          payload: {
            pairingId: f.pairing.id,
            requestId: "fixture-completed-request",
            text: "Synthetic fixture",
          },
        });
        const service = new ClawdTime(f.store, f.transport);
        await service.drain();
        await service.drain();
        const retained = f.store.effect("fixture-message")!;
        expect(retained.state).toBe(
          outcome === "accepted" ? "done" : "unknown",
        );
        expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
        expect(f.store.all("call")).toHaveLength(0);
        const cursor = f.transport.messages.cursor();
        f.store.close();
        open = undefined;
        const reopened = fixture(
          false,
          (open = new Store(path)),
          "standard_once",
        );
        const recovered = new ClawdTime(reopened.store, reopened.transport);
        await recovered.drain();
        expect(reopened.store.effect("fixture-message")).toEqual(retained);
        expect(reopened.transport.messages.cursor()).toEqual(cursor);
        expect(reopened.requests).toHaveLength(0);
      } finally {
        open?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

function obsoleteNoticeFixture(store?: Store) {
  const f = fixture(false, store),
    vault = new Vault(f.c.encryptionKey),
    now = Date.now();
  const pairing = { ...f.pairing, createdAt: now - 700_000 },
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
  it("qualifies strict missing-receipt lookup with a fresh origin and the exact sender using GET only", async () => {
    const f = fixture(true);
    const cursor = f.transport.messages.cursor();
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await f.transport.preflight();
      expect(report.liveReady).toBe(true);
      expect(
        report.checks.find((c) => c.id === "native_text_transport")?.status,
      ).toBe("pass");
    }
    const probes = f.requests.filter((r) =>
      r.url.includes("/text-operations/"),
    );
    expect(probes).toHaveLength(2);
    expect(new Set(probes.map((r) => new URL(r.url).pathname)).size).toBe(2);
    for (const probe of probes) {
      const url = new URL(probe.url);
      expect(url.origin).toBe(f.c.binding.origin);
      expect(url.pathname).toMatch(
        /^\/api\/v1\/text-operations\/v1\/text_[a-f0-9]{32}$/,
      );
      expect(url.searchParams.get("from")).toBe(f.c.binding.phone);
    }
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    expect(f.transport.messages.cursor()).toEqual(cursor);
    expect(f.store.effects()).toHaveLength(0);
    f.store.close();
  });
  it.each([
    ["generic 404", 404, { error: "Not found" }, false],
    ["missing origin", 404, { found: false }, false],
    ["wrong origin", 404, { found: false, origin: "other" }, false],
    ["wrong found type", 404, { found: "false" }, false],
    ["found receipt", 404, { found: true }, false],
    ["unexpected success", 200, undefined, false],
    ["unavailable status", 503, undefined, false],
    ["network unavailable", 404, undefined, true],
  ])(
    "blocks %s receipt lookup without changing unknown delivery",
    async (_name, status, body, unavailable) => {
      const f = fixture(true);
      Object.assign(f.receipt, { status, body, unavailable });
      const notice = {
        id: "unknown-notice",
        state: "unknown",
        sealed: "retained",
      };
      f.store.put("notice", notice);
      const cursor = f.transport.messages.cursor();
      const report = await f.transport.preflight();
      expect(report.liveReady).toBe(false);
      expect(
        report.checks.find((c) => c.id === "native_identity")?.status,
      ).toBe("pass");
      expect(
        report.checks.find((c) => c.id === "native_text_transport")?.status,
      ).toBe("fail");
      expect(f.requests.every((r) => r.method === "GET")).toBe(true);
      expect(f.store.get("notice", notice.id)).toEqual(notice);
      expect(f.transport.messages.cursor()).toEqual(cursor);
      expect(f.store.effects()).toHaveLength(0);
      f.store.close();
    },
  );
  it.each(["{", "x".repeat(4097)])(
    "rejects malformed or oversized receipt JSON without dispatch",
    async (raw) => {
      const f = fixture(true);
      f.receipt.raw = raw;
      const report = await f.transport.preflight();
      expect(report.liveReady).toBe(false);
      expect(
        report.checks.find((c) => c.id === "native_text_transport")?.status,
      ).toBe("fail");
      expect(f.requests.every((r) => r.method === "GET")).toBe(true);
      expect(f.store.effects()).toHaveLength(0);
      f.store.close();
    },
  );
  it("refuses message dispatch before POST when receipt lookup is unsupported", async () => {
    const f = fixture();
    f.receipt.body = { error: "Not found" };
    await expect(
      f.transport.message(f.pairing, "Fixture only", "fixture-operation"),
    ).rejects.toThrow("preflight is blocked");
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    expect(f.store.effects()).toHaveLength(0);
    f.store.close();
  });
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
      unknownEffectCount: 0,
      retiredSetupInvitationCount: 0,
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
    f.media.service = "other-project-media";
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

function expiredSetupFixture(
  readOnly = false,
  existing?: ReturnType<typeof fixture>,
) {
  const f = existing ?? fixture(readOnly),
    now = Date.now();
  const pairing = f.store.get<Pairing>("pairing", f.pairing.id) ?? {
    ...f.pairing,
    createdAt: now - 700_000,
  };
  f.store.put("pairing", pairing);
  f.store.put("session", {
    id: "session",
    pairingId: pairing.id,
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "chat",
    hostId: "mac",
    createdAt: now - 700_000,
    capabilities: { cooperativePause: true, polling: true },
    state: "active",
    controlEpoch: 0,
    lastSeenAt: now,
  });
  const test = {
    id: "setup_legacy",
    sessionId: "session",
    pairingId: pairing.id,
    createdAt: now - 650_000,
    expiresAt: now - 50_000,
    state: "expired",
    invitationEffectId: "setup_legacy:invite",
  };
  f.store.put("setup_test", test);
  const effect = f.store.putEffect({
    id: test.invitationEffectId,
    kind: "message",
    state: "unknown",
    createdAt: test.createdAt,
    payload: {
      setupTestId: test.id,
      pairingId: pairing.id,
      text: legacySetupInvitation,
    },
  });
  const input = {
    testId: test.id,
    effectId: effect.id,
    pairingId: pairing.id,
    evidenceReference: `sha256:${"a".repeat(64)}`,
    acknowledgeUnknown: true as const,
    receipt: {
      origin: `text_${hash(effect.id).slice(0, 32)}`,
      fingerprint: hash(
        JSON.stringify([
          "chert-text-once-v1",
          f.c.binding.phone,
          pairing.recipient,
          legacySetupInvitation,
        ]).replaceAll("/", "\\/"),
      ),
      preparedGuid: "11111111-2222-4333-8444-555555555555",
      state: "attempted" as const,
      found: true as const,
    },
  };
  return { ...f, test, effect, input };
}
describe("native expired setup recovery gate", () => {
  it("allows only an independently validated obsolete onboarding exception alongside the exact expired setup invitation", async () => {
    const original = obsoleteNoticeFixture();
    original.retire();
    const f = expiredSetupFixture(false, original);
    f.transport.retireSetupInvitation(f.input);
    expect((await f.transport.preflight()).recovery).toMatchObject({
      unknownNoticeCount: 1,
      retiredObsoleteNoticeCount: 1,
      unknownEffectCount: 1,
      retiredSetupInvitationCount: 1,
      blockingUncertainCount: 0,
    });
    expect(f.store.get("notice", original.notice.id)).toEqual(original.notice);
    f.store.put("notice", { id: "other-unknown", state: "unknown" });
    expect((await f.transport.preflight()).liveReady).toBe(false);
    f.store.close();
  });

  it("exempts the exact retired invitation but preserves unknown count and every other uncertain effect", async () => {
    const f = expiredSetupFixture();
    expect((await f.transport.preflight()).liveReady).toBe(false);
    const count = f.requests.length;
    f.transport.retireSetupInvitation(f.input);
    expect(f.requests).toHaveLength(count);
    const report = await f.transport.preflight();
    expect(report.liveReady).toBe(true);
    expect(report.recovery).toMatchObject({
      unknownEffectCount: 1,
      retiredSetupInvitationCount: 1,
      blockingUncertainCount: 0,
    });
    f.store.putEffect({ ...f.effect, id: "other-unknown" });
    expect((await f.transport.preflight()).liveReady).toBe(false);
    expect(f.store.effect(f.effect.id)).toEqual(f.effect);
    f.store.putEffect({ ...f.effect, id: "other-unknown", state: "failed" });
    f.store.putEffect({
      ...f.effect,
      payload: { ...f.effect.payload, text: "tampered" },
    });
    expect((await f.transport.preflight()).recovery).toMatchObject({
      retiredSetupInvitationCount: 0,
      blockingUncertainCount: 1,
    });
    expect(f.requests.every((r) => r.method === "GET")).toBe(true);
    f.store.close();
  });
  it.each(["read-only", "not-allowlisted", "wrong-line"])(
    "refuses retirement for %s transport binding",
    (kind) => {
      const f = expiredSetupFixture(kind === "read-only");
      if (kind === "not-allowlisted") f.c.testerAllowlist = [];
      if (kind === "wrong-line")
        f.store.put("pairing", { ...f.pairing, lineId: "other" });
      expect(() => f.transport.retireSetupInvitation(f.input)).toThrow();
      expect(f.requests).toHaveLength(0);
      f.store.close();
    },
  );
});
