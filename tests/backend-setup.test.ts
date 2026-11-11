import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SetupService } from "../src/pairing/setup.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import type { SetupTest, Transport } from "../src/contracts.js";

function fixture(mode: "simulation" | "live" = "simulation", legacy = true) {
  let now = 100_000;
  const store = new Store(),
    simulated = new SimulationTransport();
  const transport: Transport =
    mode === "simulation"
      ? simulated
      : {
          mode,
          call: (...args) => simulated.call(...args),
          endCall: (...args) => simulated.endCall(...args),
          message: async (...args) => ({
            ...(await simulated.message(...args)),
            simulated: false,
            status: "acknowledged",
          }),
        };
  const service = new ClawdTime(store, transport, { clock: () => now }),
    setup = new SetupService(service);
  // Historical fixtures exercise persisted SMS consent without retaining the old
  // creation workflow in production. New-flow cases pass legacy=false below.
  if (legacy) {
    const invite = setup.invite.bind(setup);
    setup.invite = (raw) => {
      const result = invite(raw);
      if (result.test.approvalMode !== "native_session") return result;
      const { approvalMode: _mode, ...old } = result.test;
      const test = store.put<SetupTest>("setup_test", {
        ...old,
        approvalCode: "AABBCCDD",
      });
      return { test };
    };
  }
  const binding = {
    memberId: "member",
    recipient: "+15550000001",
    conversationId: "iMessage;-;+15550000001",
    lineId: "line",
    deviceId: "mac",
    displayId: "1",
  };
  const invite = service.createPairingInvite(binding);
  const pairing = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const register = (externalSessionId: string) =>
    service.registerSession(pairing.token, {
      adapter: "codex",
      adapterVersion: "fixture",
      projectRoot: "/fixture",
      externalSessionId,
      hostId: "mac",
      capabilities: { cooperativePause: true, polling: true },
    });
  const agent = register("one");
  if (mode === "live") {
    store.saveState("native-binding-fingerprint", "fixture-binding");
    store.saveState("native-preflight", {
      checkedAt: now,
      mode: "live",
      liveReady: true,
      bindingFingerprint: "fixture-binding",
      checks: [
        {
          id: "fixture_transport",
          status: "pass",
          message: "Unit-test evidence only",
        },
      ],
    });
    store.saveState(`device-readiness:${pairing.pairing.id}`, {
      checkedAt: now,
      deviceId: "mac",
      memberId: "member",
      displayId: "1",
      bindingFingerprint: "fixture-binding",
      checks: [
        {
          id: "fixture_device",
          status: "pass",
          message: "Unit-test evidence only",
        },
      ],
    });
  }
  const event = {
    id: "yes-one",
    sender: binding.recipient,
    lineId: binding.lineId,
    conversationId: binding.conversationId,
    get text() {
      const test = store.all<SetupTest>("setup_test").at(-1);
      return test?.approvalCode ? `YES ${test.approvalCode}` : "YES";
    },
  };
  return {
    store,
    service,
    setup,
    simulated,
    pairing,
    agent,
    register,
    event,
    binding,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("same-session approved setup test", () => {
  it("gives a late exact YES a bounded start window and a started call its full deadline", async () => {
    const f = fixture(),
      initial = f.setup.invite(f.agent.token).test;
    await f.service.drain();
    const advanceAlive = (ms: number) => {
      for (let remaining = ms; remaining > 0;) {
        const step = Math.min(remaining, 5000);
        f.advance(step);
        remaining -= step;
        f.service.heartbeat(f.agent.token);
        f.service.expire();
        f.setup.expire();
      }
    };
    expect(initial.expiresAt).toBe(initial.createdAt + 600_000);
    advanceAlive(535_000);
    const approvedAt = f.now();
    expect(f.setup.receive(f.event)).toBe(true);
    const approved = f.setup.get(f.agent.token).test!;
    expect(approved.expiresAt).toBe(approvedAt + 600_000);
    advanceAlive(60_000);
    expect(f.setup.receive(f.event)).toBe(true);
    expect(f.setup.receive({ ...f.event, id: "duplicate-yes" })).toBe(true);
    expect(f.setup.get(f.agent.token).test).toEqual(approved);
    f.service.yieldSession(f.agent.token);
    const started = f.setup.start(f.agent.token);
    expect(started.test.expiresAt).toBe(started.request.deadline);
    expect(started.request.deadline).toBe(f.now() + 300_000);
    await f.service.drain();
    advanceAlive(6_000); // The original invitation expired five seconds after call start.
    expect(f.now()).toBeGreaterThan(initial.expiresAt);
    expect(f.setup.get(f.agent.token).test?.state).toBe("call_requested");
    expect(f.service.status(f.agent.token, started.request.id).state).toBe(
      "ringing",
    );
    expect(f.simulated.ended).toHaveLength(0);
    expect(f.setup.receive({ ...f.event, id: "yes-during-call" })).toBe(false);
    expect(f.setup.start(f.agent.token)).toMatchObject({
      test: started.test,
      request: { id: started.request.id, deadline: started.request.deadline },
    });
    expect(f.setup.get(f.agent.token).test?.expiresAt).toBe(
      started.request.deadline,
    );
    advanceAlive(294_000);
    expect(f.setup.get(f.agent.token).test?.state).toBe("expired");
    await f.service.drain();
    expect(f.simulated.ended).toHaveLength(1);
    expect(f.setup.receive({ ...f.event, id: "yes-after-call-expiry" })).toBe(
      false,
    );
    expect(() => f.setup.start(f.agent.token)).toThrow("closed");
    expect(f.simulated.calls).toHaveLength(1);
    f.store.close();
  });

  it("does not expire a started call when the approved start window subsequently closes", async () => {
    const f = fixture();
    f.setup.invite(f.agent.token);
    await f.service.drain();
    f.setup.receive(f.event);
    const approved = f.setup.get(f.agent.token).test!;
    for (let step = 0; step < 119; step++) {
      f.advance(5000);
      f.service.heartbeat(f.agent.token);
      f.setup.expire();
    }
    f.service.yieldSession(f.agent.token);
    const started = f.setup.start(f.agent.token);
    await f.service.drain();
    f.advance(5000);
    f.service.heartbeat(f.agent.token);
    f.setup.expire();
    expect(f.now()).toBe(approved.expiresAt);
    expect(f.setup.get(f.agent.token).test?.state).toBe("call_requested");
    expect(f.setup.get(f.agent.token).test?.expiresAt).toBe(
      started.request.deadline,
    );
    f.service.observeCall(started.request.id, "ended");
    const before = f.store.all("call")[0];
    f.setup.receive({ ...f.event, id: "yes-after-end" });
    f.setup.start(f.agent.token);
    await f.service.drain();
    expect(f.store.all("call")[0]).toEqual(before);
    expect(f.simulated.calls).toHaveLength(1);
    f.store.close();
  });

  it.each([true, false])(
    "keeps the unapproved deadline and never revives an expired invitation (legacy=%s)",
    async (isLegacy) => {
      const f = fixture(),
        initial = f.setup.invite(f.agent.token).test;
      const { approvalCode: _code, ...legacy } = initial;
      const unapproved = isLegacy ? legacy : initial;
      f.store.put("setup_test", unapproved);
      await f.service.drain();
      f.advance(599_999);
      expect(
        f.setup.receive({ ...f.event, id: "wrong", text: "YES WRONG" }),
      ).toBe(false);
      expect(f.setup.get(f.agent.token).test?.expiresAt).toBe(
        initial.expiresAt,
      );
      f.advance(1);
      expect(f.setup.receive({ ...f.event, id: "late-legacy" })).toBe(false);
      const closed = f.store.get<SetupTest>("setup_test", unapproved.id)!;
      expect(closed).toEqual({ ...unapproved, state: "expired" });
      f.advance(1_000_000);
      f.setup.expire();
      expect(f.setup.receive({ ...f.event, id: "much-later" })).toBe(false);
      expect(f.store.get("setup_test", unapproved.id)).toEqual(closed);
      expect(f.simulated.calls).toHaveLength(0);
      f.store.close();
    },
  );

  it("recognizes persisted exact challenges and legacy bare-YES consent", async () => {
    const f = fixture(),
      test = f.setup.invite(f.agent.token).test;
    expect(test.approvalCode).toMatch(/^[A-F0-9]{8}$/);
    await f.service.drain();
    for (const text of [
      "YES",
      "YES DEADBEEF",
      "YES",
      "YES BAD",
      "NO other",
      "CANCEL other",
    ])
      expect(f.setup.receive({ ...f.event, id: `new:${text}`, text })).toBe(
        false,
      );
    expect(f.setup.get(f.agent.token).test?.state).toBe("awaiting_approval");
    expect(
      f.setup.receive({
        ...f.event,
        id: "exact",
        text: `yes ${test.approvalCode!.toLowerCase()}`,
      }),
    ).toBe(true);
    f.setup.cancel(f.agent.token);
    const other = f.register("legacy"),
      legacy = f.setup.invite(other.token).test;
    const { approvalCode: _code, ...old } = legacy;
    f.store.put("setup_test", old);
    await f.service.drain();
    expect(
      f.setup.receive({ ...f.event, id: "legacy-bare", text: "YES" }),
    ).toBe(true);
    expect(f.setup.get(other.token).test?.state).toBe("approved");
    f.store.close();
  });
  it("requires fresh live readiness before claiming the setup is configured", () => {
    const f = fixture("live");
    f.store.saveState(`device-readiness:${f.pairing.pairing.id}`, null);
    expect(() => f.setup.invite(f.agent.token)).toThrow("doctor readiness");
    expect(f.store.effects()).toHaveLength(0);
    f.store.close();
  });

  it("queues one invitation, requires delivered invitation and exact human YES, then yields and starts one call", async () => {
    const f = fixture(),
      test = f.setup.invite(f.agent.token).test;
    expect(f.setup.invite(f.agent.token).test).toEqual(test);
    expect(f.store.effects()).toHaveLength(1);
    expect(f.setup.receive(f.event)).toBe(false);
    expect(() => f.setup.start(f.agent.token)).toThrow(
      "explicit authorization",
    );
    await f.service.drain();
    expect(f.simulated.messages).toHaveLength(1);
    // A previously seen early YES must never become approval after delivery.
    expect(f.setup.receive(f.event)).toBe(false);
    expect(
      f.setup.receive({
        ...f.event,
        id: "wrong-sender",
        sender: "+15550000009",
      }),
    ).toBe(false);
    expect(
      f.setup.receive({ ...f.event, id: "wrong-line", lineId: "other" }),
    ).toBe(false);
    expect(
      f.setup.receive({
        ...f.event,
        id: "wrong-chat",
        conversationId: "other",
      }),
    ).toBe(false);
    expect(
      f.setup.receive({
        ...f.event,
        id: "unrelated",
        text: "yesterday was good",
      }),
    ).toBe(false);
    expect(f.setup.receive({ ...f.event, id: "yes-two" })).toBe(true);
    expect(f.simulated.calls).toHaveLength(0);
    expect(() => f.setup.start(f.agent.token)).toThrow("Yield");
    f.service.yieldSession(f.agent.token);
    const started = f.setup.start(f.agent.token);
    expect(f.setup.start(f.agent.token)).toEqual(started);
    await f.service.drain();
    expect(f.simulated.calls).toHaveLength(1);
    expect(f.setup.receive({ ...f.event, id: "yes-two" })).toBe(true);
    expect(() =>
      f.setup.receive({ ...f.event, id: "yes-two", text: "NO" }),
    ).toThrow("changed");
    expect(() => f.setup.verify(f.agent.token)).toThrow("real qualified call");
    f.store.close();
  });

  it("binds approval to one session, prevents ambiguous invitations, and expires without calling", async () => {
    const f = fixture(),
      other = f.register("two");
    f.setup.invite(f.agent.token);
    expect(f.setup.get(other.token)).toEqual({ test: null });
    expect(() => f.setup.invite(other.token)).toThrow("Another session");
    await f.service.drain();
    f.setup.receive(f.event);
    expect(() => f.setup.start(other.token)).toThrow("Invite the human");
    f.advance(600_001);
    expect(f.setup.get(f.agent.token).test?.state).toBe("expired");
    expect(() => f.setup.start(f.agent.token)).toThrow(
      "explicit authorization",
    );
    expect(f.setup.receive({ ...f.event, id: "late" })).toBe(false);
    expect(f.setup.invite(f.agent.token).test.state).toBe("expired");
    expect(f.simulated.calls).toHaveLength(0);
    f.store.close();
  });

  it("cancels pending invitations and active calls without replaying either", async () => {
    const f = fixture();
    f.setup.invite(f.agent.token);
    expect(f.setup.receive({ ...f.event, text: "NO" })).toBe(true);
    await f.service.drain();
    expect(f.simulated.messages).toHaveLength(0);
    const second = f.register("two");
    f.setup.invite(second.token);
    await f.service.drain();
    f.setup.receive({ ...f.event, id: "second-yes" });
    f.service.yieldSession(second.token);
    const { request } = f.setup.start(second.token);
    await f.service.drain();
    f.setup.receive({ ...f.event, id: "cancel", text: "cancel" });
    expect(f.setup.get(second.token).test?.state).toBe("canceled");
    expect(f.service.status(second.token, request.id).state).toBe("canceled");
    await f.service.drain();
    expect(f.simulated.ended).toHaveLength(1);
    expect(() => f.setup.start(second.token)).toThrow("closed");
    f.setup.cancel(second.token);
    await f.service.drain();
    expect(f.simulated.calls).toHaveLength(1);
    f.store.close();
  });

  it("preserves uncertain invitation without replay after service restart", async () => {
    const f = fixture(),
      test = f.setup.invite(f.agent.token).test;
    f.simulated.message = async () => {
      throw new Error("uncertain network response");
    };
    await f.service.drain();
    expect(f.store.effect(test.invitationEffectId)?.state).toBe("unknown");
    const service = new ClawdTime(f.store, f.simulated, { clock: f.now }),
      restarted = new SetupService(service);
    expect(restarted.invite(f.agent.token).test.id).toBe(test.id);
    expect(restarted.receive(f.event)).toBe(false);
    await service.drain();
    expect(f.store.effects()).toHaveLength(1);
    expect(f.store.effect(test.invitationEffectId)?.state).toBe("unknown");
    f.store.close();
  });

  it("cancels a lost originating session and cleans up its call without granting another session approval", async () => {
    const f = fixture();
    const test = f.setup.invite(f.agent.token).test;
    await f.service.drain();
    f.setup.receive(f.event);
    f.service.yieldSession(f.agent.token);
    f.setup.start(f.agent.token);
    await f.service.drain();
    f.advance(20_001);
    f.service.expireSessions();
    f.setup.expire();
    expect(f.store.get<{ state: string }>("setup_test", test.id)?.state).toBe(
      "canceled",
    );
    expect(() => f.setup.start(f.agent.token)).toThrow("stopped");
    await f.service.drain();
    expect(f.simulated.ended).toHaveLength(1);
    expect(f.simulated.calls).toHaveLength(1);
    f.store.close();
  });

  it.each([true, false])(
    "verifies only the complete live-evidence chain (legacy=%s)",
    async (legacy) => {
      const f = fixture("live", legacy);
      const test = f.setup.invite(f.agent.token).test;
      await f.service.drain();
      if (legacy) f.setup.receive(f.event);
      else f.setup.authorize(f.agent.token, test.id, true);
      f.service.yieldSession(f.agent.token);
      const { request } = f.setup.start(f.agent.token);
      await f.service.drain();
      const call = f.service.observeCall(request.id, "connected", true);
      const view = {
        requestId: request.id,
        callId: call.id,
        sessionId: f.agent.session.id,
        pairingId: f.pairing.pairing.id,
        leaseId: "fixture",
        frameId: "frame",
        capturedAt: f.now(),
        observedAt: f.now(),
        live: true,
      };
      f.store.saveState(`setup-view:${request.id}`, view);
      f.advance(100);
      const response = f.service.receiveResponse({
        eventId: "feedback",
        requestId: request.id,
        memberId: f.binding.memberId,
        lineId: f.binding.lineId,
        conversationId: f.binding.conversationId,
        channel: "text",
        text: legacy
          ? "I can see my screen."
          : "All done. Carry on with coding.",
      });
      const visibility = {
        eventId: "earlier-visibility",
        requestId: request.id,
        sessionId: f.agent.session.id,
        pairingId: f.pairing.pairing.id,
        callId: call.id,
        visible: true,
        reportedAt: view.observedAt,
      };
      if (!legacy)
        f.store.saveState(`screen-feedback:${request.id}`, visibility);
      f.service.ack(f.agent.token, request.id, response.id);
      f.service.resume(f.agent.token, request.id, 0);
      f.service.complete(
        f.agent.token,
        request.id,
        "Screen feedback received; this session continued.",
      );
      expect(() => f.setup.verify(f.agent.token)).toThrow(
        "Messages result receipt",
      );
      await f.service.drain();
      f.store.saveState(`setup-view:${request.id}`, {
        ...view,
        sessionId: "other",
      });
      expect(() => f.setup.verify(f.agent.token)).toThrow(
        "real qualified call",
      );
      f.store.saveState(`setup-view:${request.id}`, view);
      const acknowledged = f.store.get<typeof response>(
        "response",
        response.id,
      )!;
      f.store.put("response", {
        ...acknowledged,
        text: "I cannot see my screen.",
      });
      if (!legacy)
        f.store.saveState(`screen-feedback:${request.id}`, {
          ...visibility,
          visible: false,
        });
      expect(() => f.setup.verify(f.agent.token)).toThrow(
        "real qualified call",
      );
      if (!legacy) {
        for (const mismatch of [
          { callId: "other" },
          { sessionId: "other" },
          { pairingId: "other" },
          { requestId: "other" },
          { reportedAt: view.observedAt - 1 },
          { reportedAt: response.createdAt + 1 },
        ]) {
          f.store.saveState(`screen-feedback:${request.id}`, {
            ...visibility,
            ...mismatch,
          });
          expect(() => f.setup.verify(f.agent.token)).toThrow(
            "real qualified call",
          );
        }
        f.store.saveState(`screen-feedback:${request.id}`, visibility);
      }
      f.store.put("response", acknowledged);
      f.service.observeCall(request.id, "ended");
      expect(f.setup.verify(f.agent.token).test.state).toBe("verified");
      expect(f.setup.verify(f.agent.token).test.state).toBe("verified");
      f.store.close();
    },
  );
});

describe("natural setup with existing native-chat consent", () => {
  it("announces setup without a code and requires scoped explicit consent once", async () => {
    const f = fixture("simulation", false);
    const test = f.setup.invite(f.agent.token).test;
    expect(test.approvalMode).toBe("native_session");
    expect(test.approvalCode).toBeUndefined();
    expect(f.setup.receive(f.event)).toBe(false);
    expect(() => f.setup.start(f.agent.token)).toThrow(
      "explicit authorization",
    );
    expect(() => f.setup.authorize(f.agent.token, "other", true)).toThrow();
    const other = f.register("other");
    expect(() => f.setup.authorize(other.token, test.id, true)).toThrow();
    expect(() =>
      f.setup.authorize(f.agent.token, test.id, false as true),
    ).toThrow();
    const approved = f.setup.authorize(f.agent.token, test.id, true).test;
    expect(approved.approvalSource).toBe("native_session");
    f.advance(1000);
    expect(f.setup.authorize(f.agent.token, test.id, true).test).toEqual(
      approved,
    );
    expect(() => f.setup.start(f.agent.token)).toThrow("notice delivery");
    await f.service.drain();
    expect(f.simulated.messages[0]?.text).not.toMatch(/YES|code|answer:/);
    f.service.yieldSession(f.agent.token);
    const started = f.setup.start(f.agent.token);
    expect(started.request.question).not.toMatch(/answer:|ClawdTime answer/);
    expect(() => f.setup.authorize(f.agent.token, test.id, true)).toThrow();
    await f.service.drain();
    f.setup.start(f.agent.token);
    await f.service.drain();
    expect(f.simulated.calls).toHaveLength(1);
    f.store.close();
  });
  it.each(["expired", "stale", "revoked", "canceled"])(
    "does not authorize %s setup",
    (kind) => {
      const f = fixture("simulation", false);
      const test = f.setup.invite(f.agent.token).test;
      if (kind === "expired") f.advance(600001);
      if (kind === "stale") f.advance(20001);
      if (kind === "canceled") f.setup.cancel(f.agent.token);
      if (kind === "revoked")
        f.store.put("pairing", { ...f.pairing.pairing, revokedAt: f.now() });
      expect(() => f.setup.authorize(f.agent.token, test.id, true)).toThrow();
      expect(f.simulated.calls).toHaveLength(0);
      f.store.close();
    },
  );
});
