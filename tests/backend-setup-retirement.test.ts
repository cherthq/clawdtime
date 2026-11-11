import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { createApp } from "../src/app.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { ClawdTime } from "../src/attention/service.js";
import { SetupService } from "../src/pairing/setup.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { hash } from "../src/storage/security.js";
import {
  legacySetupInvitation,
  retireSetupInvitation,
  setupInvitationRetirementValid,
  type SetupRetirementInput,
} from "../src/pairing/retired-setup.js";
import type { SetupTest, Transport } from "../src/contracts.js";

function fixture(path?: string) {
  let now = 1;
  const store = new Store(path),
    sim = new SimulationTransport();
  const transport: Transport = {
    mode: "live",
    call: (...args) => sim.call(...args),
    endCall: (...args) => sim.endCall(...args),
    message: (...args) => sim.message(...args),
  };
  const service = new ClawdTime(store, transport, { clock: () => now }),
    setup = new SetupService(service);
  const binding = {
    lineId: "line",
    providerLineId: "pl_fixture",
    phone: "+15550000002",
    instanceId: "fixture",
    fingerprint: "binding-fingerprint",
  };
  const invite = service.createPairingInvite({
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: "line",
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
  const register = (externalSessionId: string) =>
    service.registerSession(pair.token, {
      adapter: "codex",
      adapterVersion: "fixture",
      projectRoot: "/fixture",
      externalSessionId,
      hostId: "fixture-host.local",
      capabilities: { cooperativePause: true, polling: true },
    });
  const agent = register("same-chat"),
    pairing = pair.pairing;
  now = 1_000_000;
  const test: SetupTest = {
    id: "setup_legacy",
    sessionId: agent.session.id,
    pairingId: pairing.id,
    createdAt: 1,
    expiresAt: 600_001,
    state: "expired",
    invitationEffectId: "setup_legacy:invite",
  };
  store.put("setup_test", test);
  const effect = store.putEffect({
    id: test.invitationEffectId,
    kind: "message",
    state: "unknown",
    createdAt: 1,
    payload: {
      setupTestId: test.id,
      pairingId: pairing.id,
      text: legacySetupInvitation,
    },
    result: { reason: "uncertain" },
  });
  store.saveState("native-binding-fingerprint", binding.fingerprint);
  store.saveState("messages:line", { sequence: 10, eventId: "fixture-anchor" });
  function ready() {
    store.saveState("native-preflight", {
      checkedAt: now,
      mode: "live",
      liveReady: true,
      bindingFingerprint: binding.fingerprint,
      checks: [{ id: "fixture", status: "pass", message: "Test only" }],
    });
    store.saveState(`device-readiness:${pairing.id}`, {
      checkedAt: now,
      deviceId: "mac",
      memberId: "member",
      displayId: "1",
      bindingFingerprint: binding.fingerprint,
      checks: [{ id: "fixture", status: "pass", message: "Test only" }],
    });
  }
  store.put("session", { ...agent.session, lastSeenAt: now });
  ready();
  const input: SetupRetirementInput = {
    testId: test.id,
    effectId: effect.id,
    pairingId: pairing.id,
    evidenceReference: `sha256:${"a".repeat(64)}`,
    acknowledgeUnknown: true,
    receipt: {
      origin: `text_${hash(effect.id).slice(0, 32)}`,
      fingerprint: hash(
        JSON.stringify([
          "chert-text-once-v1",
          binding.phone,
          pairing.recipient,
          legacySetupInvitation,
        ]).replaceAll("/", "\\/"),
      ),
      preparedGuid: "11111111-2222-4333-8444-555555555555",
      state: "attempted",
      found: true,
    },
  };
  const event = (text: string, id = text) => ({
    id,
    text,
    sender: pairing.recipient,
    lineId: pairing.lineId,
    conversationId: pairing.conversationId,
  });
  return {
    store,
    sim,
    service,
    setup,
    agent,
    pairing,
    test,
    effect,
    binding,
    input,
    register,
    event,
    ready,
    retire: () => retireSetupInvitation(store, binding, input, now),
    now: () => now,
    advance: (ms: number) => (now += ms),
  };
}

describe("expired legacy setup invitation supersession", () => {
  it("enforces operator auth and strict retirement/retry endpoint bodies without broadening session authorization", async () => {
    const f = fixture(),
      control = new ControlCoordinator(f.store, new SimulatedDevice()),
      human = new HumanRouter(f.service, control),
      operator = "fixture-operator-secret-at-least-32-characters";
    let calls = 0;
    const app = createApp(f.service, control, human, {
      origin: "https://clawdtime.example.test",
      simulation: false,
      operatorToken: operator,
      retireSetupInvitation: (input) => {
        calls++;
        return retireSetupInvitation(f.store, f.binding, input, f.now());
      },
    });
    const post = (path: string, body: unknown, token = "") =>
      app.request(`https://clawdtime.example.test${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect(
      (await post("/internal/setup-invitations/retire", f.input, f.agent.token))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          "/internal/setup-invitations/retire",
          { ...f.input, extra: true },
          operator,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/internal/setup-invitations/retire",
          { ...f.input, acknowledgeUnknown: false },
          operator,
        )
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
    expect(
      (
        await post(
          "/api/setup/test/retry",
          { previousTestId: f.test.id },
          f.agent.token,
        )
      ).status,
    ).toBe(409);
    expect(
      (await post("/internal/setup-invitations/retire", f.input, operator))
        .status,
    ).toBe(200);
    expect(calls).toBe(1);
    expect(
      (
        await post(
          "/api/setup/test/retry",
          { previousTestId: f.test.id, extra: true },
          f.agent.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/setup/test/retry",
          { previousTestId: f.test.id },
          operator,
        )
      ).status,
    ).toBe(401);
    const other = f.register("foreign");
    expect(
      (
        await post(
          "/api/setup/test/retry",
          { previousTestId: f.test.id },
          other.token,
        )
      ).status,
    ).toBe(409);
    const reply = await post(
      "/api/setup/test/retry",
      { previousTestId: f.test.id },
      f.agent.token,
    );
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      test: {
        sessionId: f.agent.session.id,
        previousTestId: f.test.id,
        state: "awaiting_approval",
      },
    });
    expect(f.store.effect(f.effect.id)?.state).toBe("unknown");
    expect(f.sim.messages).toHaveLength(0);
    f.store.close();
  });
  it("records only an immutable audit and preserves unknown delivery, cursor and original records across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-retirement-")),
      path = join(dir, "store.sqlite"),
      f = fixture(path);
    const cursor = f.store.state("messages:line"),
      before = f.store.effects();
    expect(setupInvitationRetirementValid(f.store, f.effect, f.now())).toBe(
      false,
    );
    const audit = f.retire();
    expect(f.retire()).toEqual(audit);
    expect(audit).toMatchObject({
      deliveryOutcome: "unknown",
      replayAllowed: false,
    });
    expect(f.store.effects()).toEqual(before);
    expect(f.store.get("setup_test", f.test.id)).toEqual(f.test);
    expect(f.store.state("messages:line")).toEqual(cursor);
    expect(f.sim.messages).toHaveLength(0);
    f.service.heartbeat(f.agent.token);
    const yielded = f.service.yieldSession(f.agent.token);
    f.store.put("session", {
      ...yielded,
      controlEpoch: yielded.controlEpoch + 1,
    });
    expect(setupInvitationRetirementValid(f.store, f.effect, f.now())).toBe(
      true,
    );
    f.store.close();
    const restored = new Store(path);
    expect(
      setupInvitationRetirementValid(
        restored,
        restored.effect(f.effect.id)!,
        f.now(),
      ),
    ).toBe(true);
    expect(restored.effect(f.effect.id)?.state).toBe("unknown");
    restored.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it.each([
    "unexpired",
    "approved",
    "requested",
    "coded",
    "wrong-text",
    "extra-payload",
    "done",
    "foreign-pairing",
    "foreign-session-pairing",
    "bad-origin",
    "bad-fingerprint",
    "bad-guid",
    "missing-cursor",
    "other-effect",
    "inbound",
    "notice",
    "call",
    "lease",
    "action",
    "media",
    "speech",
    "attention",
  ])("refuses %s evidence before creating an exception", (kind) => {
    const f = fixture();
    if (kind === "unexpired")
      f.store.put("setup_test", { ...f.test, expiresAt: f.now() + 1 });
    if (kind === "approved")
      f.store.put("setup_test", {
        ...f.test,
        approvedAt: 12,
        approvalEventId: "prior",
      });
    if (kind === "requested")
      f.store.put("setup_test", { ...f.test, requestId: "request" });
    if (kind === "coded")
      f.store.put("setup_test", { ...f.test, approvalCode: "ABCDEF12" });
    if (kind === "wrong-text")
      f.store.putEffect({
        ...f.effect,
        payload: { ...f.effect.payload, text: "other" },
      });
    if (kind === "extra-payload")
      f.store.putEffect({
        ...f.effect,
        payload: { ...f.effect.payload, requestId: "request" },
      });
    if (kind === "done") f.store.putEffect({ ...f.effect, state: "done" });
    if (kind === "foreign-pairing")
      f.store.put("pairing", { ...f.pairing, lineId: "other" });
    if (kind === "foreign-session-pairing")
      f.store.put("session", { ...f.agent.session, pairingId: "other" });
    if (kind === "bad-origin")
      f.input.receipt.origin = `text_${"0".repeat(32)}`;
    if (kind === "bad-fingerprint")
      f.input.receipt.fingerprint = "0".repeat(64);
    if (kind === "bad-guid") f.input.receipt.preparedGuid = "invalid";
    if (kind === "missing-cursor") f.store.saveState("messages:line", null);
    if (kind === "other-effect")
      f.store.putEffect({ ...f.effect, id: "other", state: "unknown" });
    if (
      [
        "inbound",
        "notice",
        "call",
        "lease",
        "action",
        "media",
        "speech",
      ].includes(kind)
    )
      f.store.put(kind, { id: "other", state: "unknown" });
    if (kind === "attention")
      f.store.put("attention", {
        id: "prior",
        sessionId: f.agent.session.id,
        state: "completed",
      });
    expect(() => f.retire()).toThrow();
    expect(
      f.store.query(
        "SELECT id FROM events WHERE id LIKE 'expired-setup-invitation-retirement:%'",
      ),
    ).toHaveLength(0);
    expect(f.store.effect(f.effect.id)?.state).toBe(
      kind === "done" ? "done" : "unknown",
    );
    f.store.close();
  });
  it.each([
    "effect",
    "test",
    "pairing",
    "session",
    "binding",
    "audit",
    "null-audit",
    "malformed-audit",
  ])("rehashes %s and fails closed after mutation", (kind) => {
    const f = fixture(),
      audit = f.retire();
    if (kind === "effect")
      f.store.putEffect({ ...f.effect, result: { reason: "changed" } });
    if (kind === "test")
      f.store.put("setup_test", { ...f.test, expiresAt: f.test.expiresAt - 1 });
    if (kind === "pairing")
      f.store.put("pairing", { ...f.pairing, displayId: "2" });
    if (kind === "session")
      f.store.put("session", {
        ...f.agent.session,
        externalSessionId: "other-chat",
      });
    if (kind === "binding")
      f.store.saveState("native-binding-fingerprint", "other");
    if (kind === "audit")
      f.store.db
        .prepare("UPDATE events SET fingerprint=? WHERE id=?")
        .run("bad", audit.auditId);
    if (kind === "malformed-audit") {
      const malformed = { version: 1 };
      f.store.db
        .prepare("UPDATE events SET result=?,fingerprint=? WHERE id=?")
        .run(
          JSON.stringify(malformed),
          hash(JSON.stringify(malformed)),
          audit.auditId,
        );
    }
    if (kind === "null-audit")
      f.store.db
        .prepare("UPDATE events SET result=? WHERE id=?")
        .run("null", audit.auditId);
    expect(
      setupInvitationRetirementValid(
        f.store,
        f.store.effect(f.effect.id)!,
        f.now(),
      ),
    ).toBe(false);
    expect(() => f.retire()).toThrow();
    f.store.close();
  });
  it("requires the exact receipt/evidence on repeated operator submission", () => {
    const f = fixture();
    f.retire();
    f.input.evidenceReference = `sha256:${"b".repeat(64)}`;
    expect(() => f.retire()).toThrow();
    f.store.close();
  });
  it("creates one new coded attempt in the same session only after retirement, never resends the unknown invitation", async () => {
    const f = fixture();
    expect(() => f.setup.retry(f.agent.token, f.test.id)).toThrow("retired");
    f.retire();
    expect(f.service.doctor(f.agent.token)).toMatchObject({
      unknownEffects: 1,
      retiredSetupInvitationCount: 1,
      blockingUnknownEffects: 0,
      readiness: { liveReady: true },
    });
    const other = f.register("other-chat");
    expect(() => f.setup.retry(other.token, f.test.id)).toThrow("retired");
    expect(f.setup.invite(f.agent.token).test).toEqual(f.test);
    const next = f.setup.retry(f.agent.token, f.test.id).test;
    expect(next).toMatchObject({
      previousTestId: f.test.id,
      sessionId: f.agent.session.id,
      pairingId: f.pairing.id,
      state: "awaiting_approval",
    });
    expect(next.approvalMode).toBe("native_session");
    expect(next.approvalCode).toBeUndefined();
    expect(() => f.setup.retry(f.agent.token, f.test.id)).toThrow("retired");
    expect(f.setup.invite(f.agent.token).test).toEqual(next);
    expect(f.setup.get(f.agent.token).test).toEqual(next);
    expect(f.setup.receive(f.event(`YES ${next.approvalCode}`, "early"))).toBe(
      false,
    );
    await f.service.drain();
    expect(f.sim.messages).toHaveLength(1);
    expect(f.store.effect(f.effect.id)).toEqual(f.effect);
    expect(f.sim.messages[0]?.text).not.toContain("YES");
    for (const text of [
      "YES",
      "YES 00000000",
      "YES BAD",
      "YES ",
      "NO wrong-code",
      "CANCEL wrong-code",
    ])
      expect(f.setup.receive(f.event(text))).toBe(false);
    expect(f.setup.get(f.agent.token).test?.state).toBe("awaiting_approval");
    expect(f.setup.receive(f.event(`YES ${next.approvalCode}`, "early"))).toBe(
      false,
    );
    expect(f.setup.receive(f.event(`YES ${next.approvalCode}`, "fresh"))).toBe(
      false,
    );
    f.setup.authorize(f.agent.token, next.id, true);
    expect(f.sim.calls).toHaveLength(0);
    expect(() => f.setup.start(f.agent.token)).toThrow("Yield");
    f.service.yieldSession(f.agent.token);
    const started = f.setup.start(f.agent.token);
    await f.service.drain();
    expect(started.request.sessionId).toBe(f.agent.session.id);
    expect(f.sim.calls).toHaveLength(1);
    expect(f.store.get("setup_test", f.test.id)).toEqual(f.test);
    f.setup.cancel(f.agent.token);
    expect(f.setup.get(f.agent.token).test?.state).toBe("canceled");
    f.store.close();
  });
  it.each(["stale", "stopped", "yielded", "other-unknown", "stale-doctor"])(
    "does not replace on %s",
    (kind) => {
      const f = fixture();
      f.retire();
      if (kind === "stale") {
        f.advance(20_001);
        f.ready();
      }
      if (kind === "yielded") f.service.yieldSession(f.agent.token);
      if (kind === "stopped")
        f.store.put("session", { ...f.agent.session, state: "stopped" });
      if (kind === "other-unknown")
        f.store.putEffect({ ...f.effect, id: "other", state: "unknown" });
      if (kind === "stale-doctor") f.store.saveState("native-preflight", null);
      expect(() => f.setup.retry(f.agent.token, f.test.id)).toThrow();
      expect(f.store.all("setup_test")).toHaveLength(1);
      f.store.close();
    },
  );
});
