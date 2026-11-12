import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  NativeMessages,
  normalizeNativeEvent,
  type MessageBinding,
} from "../src/transport/native-messages.js";
import type {
  ControlLease,
  CallSession,
  AttentionRequest,
} from "../src/contracts.js";
const invite = {
  memberId: "member",
  recipient: "+15550000001",
  conversationId: "iMessage;-;+15550000001",
  lineId: "line",
  deviceId: "mac",
  displayId: "display",
};
const registration = {
  adapter: "codex" as const,
  adapterVersion: "test",
  projectRoot: "/disposable",
  externalSessionId: "external-1",
  hostId: "host",
  capabilities: { cooperativePause: true, polling: true },
};
const input = {
  taskId: "task",
  idempotencyKey: "stable",
  reason: "decision" as const,
  question: "Choose a color?",
};
function fixture(store = new Store(), transport = new SimulationTransport()) {
  let now = 100000;
  const app = new ClawdTime(store, transport, { clock: () => now });
  const link = app.createPairingInvite(invite);
  const pair = app.claimPairing({
    token: link.token,
    deviceId: "mac",
    displayId: "display",
    allowView: true,
    allowControl: true,
  });
  const agent = app.registerSession(pair.token, registration);
  app.yieldSession(agent.token);
  const request = () => app.requestAttention(agent.token, input);
  const answer = (requestId: string) =>
    app.receiveResponse({
      eventId: "event",
      requestId,
      memberId: invite.memberId,
      lineId: invite.lineId,
      conversationId: invite.conversationId,
      channel: "text",
      text: "Use blue.",
    });
  return {
    store,
    transport,
    app,
    pair,
    agent,
    request,
    answer,
    advance: (ms: number) => (now += ms),
  };
}
describe("durable scoped attention domain", () => {
  it("retains the first cleanup source and liveness before later cleanup callbacks", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    f.advance(1000);
    f.app.failCall(request.id, "media_failure");
    const first = f.store.state(`call-termination:${request.id}`);
    expect(first).toMatchObject({
      version: 1,
      source: "media_failure",
      at: 101000,
      requestId: request.id,
      sessionId: f.agent.session.id,
      effectId: `${request.id}:end`,
      sessionState: "yielded",
      heartbeatAgeMs: 1000,
      controlEpoch: 0,
    });
    const effect = f.store.effect(`${request.id}:end`);
    f.advance(21000);
    f.app.expireSessions();
    f.app.failCall(request.id, "worker_terminal");
    expect(f.store.state(`call-termination:${request.id}`)).toEqual(first);
    expect(f.store.effect(`${request.id}:end`)).toEqual(effect);
    expect(f.store.effects().filter((e) => e.kind === "end_call")).toHaveLength(
      1,
    );
    f.store.close();
  });
  it("records heartbeat expiry without inventing provenance for historical end effects", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    f.advance(20001);
    f.app.expireSessions();
    expect(f.store.state(`call-termination:${request.id}`)).toMatchObject({
      source: "session_heartbeat_expired",
      heartbeatAgeMs: 20001,
      sessionState: "stopped",
      controlEpoch: 1,
    });
    f.store.close();
    const old = fixture(),
      prior = old.request();
    await old.app.drain();
    old.store.putEffect({
      id: `${prior.id}:end`,
      kind: "end_call",
      state: "unknown",
      payload: { requestId: prior.id },
      createdAt: 100000,
    });
    old.app.failCall(prior.id, "media_failure");
    expect(old.store.state(`call-termination:${prior.id}`)).toBeUndefined();
    expect(old.store.effect(`${prior.id}:end`)?.state).toBe("unknown");
    old.store.close();
  });
  it("keeps cleanup operational when diagnostic persistence fails", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    f.store.put<ControlLease>("lease", {
      id: "failure-lease",
      requestId: request.id,
      sessionId: f.agent.session.id,
      pairingId: f.pair.pairing.id,
      callId: f.store.all<CallSession>("call")[0]!.id,
      deviceId: "mac",
      displayId: "display",
      memberId: "member",
      mode: "control",
      epoch: 0,
      expiresAt: 200000,
      state: "active",
    });
    const save = f.store.saveState.bind(f.store);
    f.store.saveState = (key, value) => {
      if (key.startsWith("call-termination:"))
        throw new Error("synthetic storage failure");
      return save(key, value);
    };
    expect(() => f.app.failCall(request.id, "media_failure")).not.toThrow();
    expect(f.store.effect(`${request.id}:end`)?.state).toBe("pending");
    expect(f.store.get<ControlLease>("lease", "failure-lease")?.state).toBe(
      "unknown",
    );
    await f.app.drain();
    expect(f.store.effect(`${request.id}:end`)?.state).toBe("done");
    f.store.close();
  });
  it("does not relabel a retained direct media health cleanup as a later failure", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    const call = f.store.all<CallSession>("call")[0]!;
    f.store.saveState(`cleanup:${call.id}`, {
      nativeEndRequested: true,
      mediaClosed: true,
      cleanupPending: true,
    });
    f.app.failCall(request.id, "media_failure");
    expect(f.store.state(`call-termination:${request.id}`)).toBeUndefined();
    expect(f.store.state(`cleanup:${call.id}`)).toEqual({
      nativeEndRequested: true,
      mediaClosed: true,
      cleanupPending: true,
    });
    f.store.close();
  });
  it("renews a default connected call on live heartbeats beyond its initial deadline", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    f.app.observeCall(request.id, "connected", true);
    for (let i = 0; i < 80; i++) {
      f.advance(5000);
      f.app.heartbeat(f.agent.token);
      f.app.expire();
    }
    const current = f.store.get<AttentionRequest>("attention", request.id)!;
    expect(current.state).toBe("awaiting_input");
    expect(request.renewWhileConnected).toBe(true);
    expect(current.deadline).toBe(800000);
    expect(current.deadline).toBeGreaterThan(request.deadline);
    expect(f.store.effect(`${request.id}:end`)).toBeUndefined();
    f.advance(20000);
    f.app.expireSessions();
    expect(f.store.effect(`${request.id}:end`)?.state).toBe("pending");
    expect(f.store.state(`call-termination:${request.id}`)).toMatchObject({
      source: "session_heartbeat_expired",
    });
    f.store.close();
  });
  it.each([
    "explicit",
    "legacy",
    "ringing",
    "unqualified",
    "ended",
    "stopped_view",
    "stopped_listening",
    "cleanup",
    "unknown_input",
    "unknown_lease",
    "wrong_epoch",
    "expired_lease",
    "responded",
    "expired_request",
    "media_closing",
    "media_unknown",
  ] as const)("never renews a %s call on heartbeat", async (kind) => {
    const f = fixture(),
      request = f.app.requestAttention(f.agent.token, {
        ...input,
        ...(kind === "explicit" ? { timeoutSeconds: 10 } : {}),
      });
    await f.app.drain();
    if (kind !== "ringing")
      f.app.observeCall(request.id, "connected", kind !== "unqualified");
    const call = f.store.all<CallSession>("call")[0]!;
    if (kind === "media_closing" || kind === "media_unknown")
      f.store.put("media", {
        id: call.id,
        requestId: request.id,
        state: kind === "media_closing" ? "closing" : "unknown",
      });
    if (kind === "legacy") {
      const { renewWhileConnected: _, ...old } = f.store.get<AttentionRequest>(
        "attention",
        request.id,
      )!;
      f.store.put("attention", old);
    }
    if (kind === "ended") f.app.observeCall(request.id, "ended");
    if (kind === "stopped_view")
      f.store.saveState(`view-stopped:${request.id}`, true);
    if (kind === "stopped_listening")
      f.store.saveState(`listening-stopped:${request.id}`, true);
    if (kind === "cleanup") f.app.failCall(request.id, "media_failure");
    if (
      [
        "unknown_input",
        "unknown_lease",
        "wrong_epoch",
        "expired_lease",
      ].includes(kind)
    ) {
      f.store.put<ControlLease>("lease", {
        id: "rolling-lease",
        requestId: request.id,
        sessionId: f.agent.session.id,
        pairingId: f.pair.pairing.id,
        callId: call.id,
        deviceId: "mac",
        displayId: "display",
        memberId: "member",
        mode: "control",
        epoch: kind === "wrong_epoch" ? 1 : 0,
        expiresAt: kind === "expired_lease" ? 100000 : 200000,
        state: kind === "unknown_lease" ? "unknown" : "active",
      });
      if (kind === "unknown_input")
        f.store.put("action", {
          id: "unknown-action",
          leaseId: "rolling-lease",
          state: "unknown",
        });
    }
    if (kind === "responded") f.answer(request.id);
    if (kind === "expired_request")
      f.store.put("attention", {
        ...f.store.get<AttentionRequest>("attention", request.id)!,
        deadline: 100001,
      });
    const before = f.store.get<AttentionRequest>("attention", request.id)!;
    f.advance(kind === "explicit" ? 10001 : 5000);
    f.app.heartbeat(f.agent.token);
    expect(
      f.store.get<AttentionRequest>("attention", request.id)?.deadline,
    ).toBe(before.deadline);
    if (kind === "explicit" || kind === "expired_request") {
      f.app.expire();
      expect(f.store.effect(`${request.id}:end`)).toBeDefined();
    }
    f.store.close();
  });
  it("revocation or stopped sessions never renew a connected request", async () => {
    for (const kind of ["revoked", "stopped"]) {
      const f = fixture(),
        request = f.request();
      await f.app.drain();
      f.app.observeCall(request.id, "connected", true);
      if (kind === "revoked") f.app.disconnect(f.agent.token);
      else {
        f.advance(20000);
        f.app.expireSessions();
      }
      expect(() => f.app.heartbeat(f.agent.token)).toThrow();
      expect(
        f.store.get<AttentionRequest>("attention", request.id)?.deadline,
      ).toBe(request.deadline);
      f.store.close();
    }
  });
  it("runs request, ring, feedback, exact-session acknowledgement, continuation and one Messages result", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    expect(f.transport.calls).toHaveLength(1);
    f.app.observeCall(request.id, "connected", true);
    const response = f.answer(request.id);
    expect(f.app.result(f.agent.token, request.id).response?.text).toBe(
      "Use blue.",
    );
    expect(
      f.app.result(f.agent.token, request.id).response?.acknowledgedAt,
    ).toBeUndefined();
    f.app.ack(f.agent.token, request.id, response.id);
    expect(f.app.resume(f.agent.token, request.id, 0).request.state).toBe(
      "resumed",
    );
    f.app.complete(f.agent.token, request.id, "Changed the color.");
    await f.app.drain();
    f.app.complete(f.agent.token, request.id, "Changed the color.");
    await f.app.drain();
    expect(f.transport.messages).toHaveLength(1);
    expect(f.transport.ended).toHaveLength(1);
    expect(f.store.all<CallSession>("call")[0]?.state).toBe("ended"); // simulation reports its own immediate cleanup
    f.app.observeCall(request.id, "ended");
    expect(f.store.all<CallSession>("call")[0]?.state).toBe("ended");
  });
  it("can finish two sequential simulated requests without retaining a stale call reservation", async () => {
    const f = fixture();
    for (const n of [1, 2]) {
      f.app.yieldSession(f.agent.token);
      const r = f.app.requestAttention(f.agent.token, {
        ...input,
        idempotencyKey: `request-${n}`,
      });
      await f.app.drain();
      const response = f.app.receiveResponse({
        eventId: `answer-${n}`,
        requestId: r.id,
        memberId: "member",
        lineId: "line",
        conversationId: invite.conversationId,
        channel: "text",
        text: "Continue",
      });
      f.app.ack(f.agent.token, r.id, response.id);
      f.app.resume(f.agent.token, r.id, 0);
      f.app.complete(f.agent.token, r.id, `Done ${n}`);
      await f.app.drain();
    }
    expect(f.transport.calls).toHaveLength(2);
    expect(f.transport.messages).toHaveLength(2);
  });
  it("rejects replay keys with changed content; repeated calls return same receipt", async () => {
    const f = fixture(),
      r = f.request();
    expect(f.request().id).toBe(r.id);
    expect(() =>
      f.app.requestAttention(f.agent.token, { ...input, question: "Changed?" }),
    ).toThrow("different arguments");
    await Promise.all([f.app.drain(), f.app.drain()]);
    expect(f.transport.calls).toHaveLength(1);
  });
  it("requires cooperative yield before placing a call", () => {
    const f = fixture();
    const other = f.app.registerSession(f.pair.token, {
      ...registration,
      externalSessionId: "external-2",
    });
    expect(() => f.app.requestAttention(other.token, input)).toThrow("Yield");
  });
  it("rejects wrong session response access and binding changes", () => {
    const f = fixture(),
      r = f.request(),
      other = f.app.registerSession(f.pair.token, {
        ...registration,
        externalSessionId: "external-2",
      });
    expect(() => f.app.result(other.token, r.id)).toThrow("does not belong");
    expect(() =>
      f.app.registerSession(f.pair.token, {
        ...registration,
        projectRoot: "/other",
      }),
    ).toThrow("binding differs");
  });
  it("cannot turn no answer, timeout or silence into approval", async () => {
    const f = fixture(),
      r = f.request();
    await f.app.drain();
    f.advance(301000);
    f.app.expire();
    expect(f.app.status(f.agent.token, r.id).state).toBe("expired");
    expect(() => f.app.resume(f.agent.token, r.id, 0)).toThrow("acknowledged");
    expect(() => f.answer(r.id)).toThrow("no longer");
    await f.app.drain();
    expect(f.transport.calls).toHaveLength(1);
  });
  it.each(["declined", "unanswered", "disconnected", "failed"] as const)(
    "records %s without continuing or redial",
    async (state) => {
      const f = fixture(),
        r = f.request();
      await f.app.drain();
      f.app.observeCall(r.id, state);
      expect(f.app.status(f.agent.token, r.id).state).toBe(state);
      await f.app.drain();
      expect(f.transport.calls).toHaveLength(1);
      expect(() => f.answer(r.id)).toThrow("no longer");
    },
  );
  it("deduplicates feedback and rejects changed inbound event identity", () => {
    const f = fixture(),
      r = f.request(),
      a = f.answer(r.id);
    expect(f.answer(r.id).id).toBe(a.id);
    expect(() =>
      f.app.receiveResponse({
        eventId: "event",
        requestId: r.id,
        memberId: "member",
        lineId: "line",
        conversationId: invite.conversationId,
        channel: "text",
        text: "Different",
      }),
    ).toThrow("identity changed");
  });
  it.each(["memberId", "lineId", "conversationId"] as const)(
    "rejects wrong feedback %s",
    (field) => {
      const f = fixture(),
        r = f.request();
      expect(() =>
        f.app.receiveResponse({
          eventId: "event",
          requestId: r.id,
          memberId: "member",
          lineId: "line",
          conversationId: invite.conversationId,
          channel: "text",
          text: "Go",
          [field]: "foreign",
        }),
      ).toThrow("identity does not match");
    },
  );
  it("requires qualified remote audio and text for sensitive approvals", async () => {
    const f = fixture(),
      r = f.request();
    await f.app.drain();
    f.app.observeCall(r.id, "connected", true);
    const call = f.store.all<CallSession>("call")[0]!;
    const speech = {
      eventId: "speech",
      requestId: r.id,
      memberId: "member",
      lineId: "line",
      conversationId: invite.conversationId,
      channel: "voice" as const,
      text: "Use blue.",
      callId: call.id,
    };
    expect(() => f.app.receiveResponse(speech)).toThrow("qualified remote");
    expect(() =>
      f.app.receiveResponse({
        ...speech,
        qualifiedRemoteAudio: true,
        kind: "approval",
      }),
    ).toThrow("authenticated text");
    expect(
      f.app.receiveResponse({ ...speech, qualifiedRemoteAudio: true }).channel,
    ).toBe("voice");
  });
  it("blocks continuation during control or unknown outcomes and enforces fresh epoch", () => {
    const f = fixture(),
      r = f.request(),
      a = f.answer(r.id);
    f.app.ack(f.agent.token, r.id, a.id);
    const lease: ControlLease = {
      id: "lease",
      requestId: r.id,
      sessionId: f.agent.session.id,
      pairingId: f.pair.pairing.id,
      callId: "call",
      deviceId: "mac",
      displayId: "display",
      memberId: "member",
      mode: "control",
      epoch: 1,
      expiresAt: 200000,
      state: "active",
    };
    f.store.put("lease", lease);
    f.store.put("session", {
      ...f.agent.session,
      state: "yielded",
      controlEpoch: 1,
    });
    expect(() => f.app.resume(f.agent.token, r.id, 0)).toThrow(
      "context changed",
    );
    expect(() => f.app.resume(f.agent.token, r.id, 1)).toThrow(
      "Control must be released",
    );
    f.store.put("lease", { ...lease, state: "unknown" });
    expect(() => f.app.resume(f.agent.token, r.id, 1)).toThrow(
      "Control must be released",
    );
    f.store.put("lease", { ...lease, state: "released" });
    f.store.put("action", { id: "action", leaseId: "lease", state: "unknown" });
    expect(() => f.app.resume(f.agent.token, r.id, 1)).toThrow(
      "uncertain actions",
    );
    f.store.put("action", {
      id: "action",
      leaseId: "lease",
      state: "observed",
    });
    expect(f.app.resume(f.agent.token, r.id, 1).session.state).toBe("active");
  });
  it.each([
    "canceled",
    "failed",
    "expired",
    "declined",
    "unanswered",
    "disconnected",
  ] as const)(
    "explicitly releases the same session after %s cleanup without human approval or completion",
    async (state) => {
      const f = fixture(),
        r = f.request();
      await f.app.drain();
      f.app.failCall(r.id);
      f.store.put("attention", {
        ...f.store.get<AttentionRequest>("attention", r.id)!,
        state,
      });
      expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
        "confirmed terminal cleanup",
      );
      await f.app.drain();
      const before = f.store.get<AttentionRequest>("attention", r.id)!;
      const released = f.app.acknowledgeTerminal(f.agent.token, r.id, 0);
      expect(released.session.state).toBe("active");
      expect(released.request).toEqual(before);
      expect(released.request.state).toBe(state);
      expect(released.acknowledgement.humanApproval).toBe(false);
      expect(f.app.acknowledgeTerminal(f.agent.token, r.id, 0)).toEqual(
        released,
      );
      expect(f.store.all("response")).toHaveLength(0);
      expect(f.store.effects().some((e) => e.kind === "message")).toBe(false);
      expect(() => f.app.complete(f.agent.token, r.id, "success")).toThrow(
        "acknowledge continuation",
      );
      expect(() => f.app.resume(f.agent.token, r.id, 0)).toThrow(
        "acknowledged human response",
      );
      f.app.yieldSession(f.agent.token);
      f.app.requestAttention(f.agent.token, {
        ...input,
        idempotencyKey: "another",
      });
      expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
        "confirmed terminal cleanup",
      );
      f.store.close();
    },
  );
  it("releases cancellation before allocation only after the queued effect definitively closes", async () => {
    const f = fixture(),
      r = f.request();
    f.app.failCall(r.id);
    expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "confirmed terminal cleanup",
    );
    await f.app.drain();
    expect(f.transport.calls).toHaveLength(0);
    expect(f.store.effect(`${r.id}:call`)?.state).toBe("failed");
    expect(
      f.app.acknowledgeTerminal(f.agent.token, r.id, 0).acknowledgement
        .humanApproval,
    ).toBe(false);
    // Legacy preallocation state may lack a local call row, but can never hide
    // a successful provider-allocation receipt or an uncertain dispatch.
    f.store.db.prepare("DELETE FROM entities WHERE kind='call'").run();
    expect(
      f.app.acknowledgeTerminal(f.agent.token, r.id, 0).session.state,
    ).toBe("active");
    const effect = f.store.effect(`${r.id}:call`)!;
    f.store.putEffect({
      ...effect,
      state: "done",
      result: { accepted: true, callId: "unaccounted-provider-call" },
    });
    expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "confirmed terminal cleanup",
    );
    f.store.close();
  });
  it("terminal acknowledgement requires exact session, epoch, released leases and reconciled inputs", async () => {
    const f = fixture(),
      r = f.request();
    await f.app.drain();
    f.app.failCall(r.id);
    await f.app.drain();
    const other = f.app.registerSession(f.pair.token, {
      ...registration,
      externalSessionId: "other",
    });
    expect(() => f.app.acknowledgeTerminal(other.token, r.id, 0)).toThrow(
      "does not belong",
    );
    f.store.put("session", {
      ...f.agent.session,
      state: "yielded",
      controlEpoch: 1,
    });
    expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "context changed",
    );
    const lease: ControlLease = {
      id: "terminal-lease",
      requestId: r.id,
      sessionId: f.agent.session.id,
      pairingId: f.pair.pairing.id,
      callId: "fixture",
      deviceId: "mac",
      displayId: "display",
      memberId: "member",
      mode: "control",
      epoch: 1,
      expiresAt: 0,
      state: "active",
    };
    for (const state of ["active", "unknown", "revoked"] as const) {
      f.store.put("lease", { ...lease, state });
      expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 1)).toThrow(
        "All screen leases",
      );
    }
    f.store.put("lease", { ...lease, state: "released" });
    for (const state of ["pending", "submitted", "unknown"]) {
      f.store.put("action", {
        id: "uncertain-input",
        leaseId: lease.id,
        state,
      });
      expect(() => f.app.acknowledgeTerminal(f.agent.token, r.id, 1)).toThrow(
        "uncertain inputs",
      );
    }
    f.store.put("action", {
      id: "uncertain-input",
      leaseId: lease.id,
      state: "observed",
    });
    expect(
      f.app.acknowledgeTerminal(f.agent.token, r.id, 1).session.state,
    ).toBe("active");
    f.store.close();
  });
  it("terminal acknowledgement cannot bypass native media cleanup, unknown dispatch or stopped sessions", async () => {
    const f = fixture(),
      r = f.request();
    await f.app.drain();
    f.app.failCall(r.id);
    await f.app.drain();
    const live = new ClawdTime(f.store, {
      mode: "live",
      call: (...a) => f.transport.call(...a),
      message: (...a) => f.transport.message(...a),
      endCall: (...a) => f.transport.endCall(...a),
    });
    expect(() => live.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "confirmed terminal cleanup",
    );
    const call = f.store.all<CallSession>("call")[0]!;
    f.store.put("media", {
      id: "fixture-media",
      requestId: r.id,
      providerCallId: call.providerCallId,
      state: "closing",
    });
    expect(() => live.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "confirmed terminal cleanup",
    );
    f.store.put("media", {
      id: "fixture-media",
      requestId: r.id,
      providerCallId: call.providerCallId,
      state: "closed",
    });
    const effect = f.store.effect(`${r.id}:call`)!;
    f.store.putEffect({ ...effect, state: "unknown" });
    expect(() => live.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "confirmed terminal cleanup",
    );
    f.store.putEffect(effect);
    f.store.put("attention", {
      ...f.store.get<AttentionRequest>("attention", r.id)!,
      state: "unknown",
    });
    expect(() => live.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "closed unsuccessful",
    );
    f.store.put("attention", {
      ...f.store.get<AttentionRequest>("attention", r.id)!,
      state: "failed",
    });
    expect(live.acknowledgeTerminal(f.agent.token, r.id, 0).session.state).toBe(
      "active",
    );
    f.store.put("session", { ...f.agent.session, state: "stopped" });
    expect(() => live.acknowledgeTerminal(f.agent.token, r.id, 0)).toThrow(
      "stopped",
    );
    f.store.close();
  });
  it("revocation cancels pending work, revokes sessions and never revives on registration", async () => {
    const f = fixture();
    f.request();
    f.app.disconnect(f.agent.token);
    await f.app.drain();
    expect(f.transport.calls).toHaveLength(0);
    expect(() => f.app.registerSession(f.pair.token, registration)).toThrow(
      "revoked",
    );
    expect(() => f.app.authenticateSession(f.agent.token)).toThrow("stopped");
  });
  it("preserves unknown effects after a timeout without blind retry", async () => {
    const f = fixture();
    let count = 0;
    f.transport.call = async () => {
      count++;
      throw new Error("network timeout after commit");
    };
    const r = f.request();
    await f.app.drain();
    await f.app.drain();
    expect(count).toBe(1);
    expect(f.app.status(f.agent.token, r.id).state).toBe("unknown");
    expect(f.store.effects("unknown")).toHaveLength(1);
    expect(() =>
      f.app.requestAttention(f.agent.token, {
        ...input,
        idempotencyKey: "fresh",
      }),
    ).toThrow("reserved");
  });
  it("turns crash-interrupted dispatch into unknown on durable reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-"));
    try {
      const path = join(dir, "state.sqlite"),
        f = fixture(new Store(path)),
        r = f.request();
      const effect = f.store.effects()[0]!;
      f.store.putEffect({ ...effect, state: "running" });
      f.store.close();
      const reopened = new Store(path),
        app = new ClawdTime(reopened, new SimulationTransport());
      expect(reopened.effects()[0]?.state).toBe("unknown");
      expect(reopened.get<AttentionRequest>("attention", r.id)?.state).toBe(
        "unknown",
      );
      expect(app.transport.mode).toBe("simulation");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("shutdown can stop a drain before starting the next committed pending effect", async () => {
    const f = fixture(),
      request = f.request();
    await f.app.drain();
    const response = f.answer(request.id);
    f.app.ack(f.agent.token, request.id, response.id);
    f.app.resume(f.agent.token, request.id, 0);
    f.app.complete(f.agent.token, request.id, "Done");
    let stopping = false;
    const message = f.transport.message.bind(f.transport);
    f.transport.message = async (...args) => {
      const result = await message(...args);
      stopping = true;
      return result;
    };
    await f.app.drain({ shouldStop: () => stopping });
    expect(f.transport.messages).toHaveLength(1);
    expect(f.transport.ended).toHaveLength(0);
    expect(f.store.effects("pending").map((e) => e.kind)).toEqual(["end_call"]);
    await f.app.drain({ cleanupOnly: true });
    expect(f.transport.ended).toHaveLength(1);
  });
  it("heartbeats keep only their own session alive and reads do not extend session lifetime", () => {
    const f = fixture(),
      r = f.request();
    expect(f.agent.session.lastSeenAt).toBe(100000);
    f.advance(15000);
    f.app.heartbeat(f.agent.token);
    f.advance(15000);
    expect(f.app.expireSessions().stopped).toBe(0);
    f.app.result(f.agent.token, r.id);
    f.advance(5000);
    expect(f.app.expireSessions().stopped).toBe(1);
    expect(() => f.app.heartbeat(f.agent.token)).toThrow("stopped");
    expect(() => f.app.registerSession(f.pair.token, registration)).toThrow(
      "cannot be revived",
    );
  });
  it("terminal session loss invalidates control and queues native cleanup without releasing the call reservation", async () => {
    const f = fixture(),
      r = f.request();
    await f.app.drain();
    f.app.observeCall(r.id, "connected", true);
    const call = f.store.all<CallSession>("call")[0]!;
    f.store.put<ControlLease>("lease", {
      id: "lease-lost-agent",
      requestId: r.id,
      sessionId: f.agent.session.id,
      pairingId: f.pair.pairing.id,
      callId: call.id,
      deviceId: "mac",
      displayId: "display",
      memberId: "member",
      mode: "control",
      epoch: 0,
      expiresAt: 150000,
      state: "active",
    });
    f.advance(20000);
    expect(f.app.expireSessions()).toEqual({ stopped: 1 });
    expect(f.store.get<ControlLease>("lease", "lease-lost-agent")?.state).toBe(
      "unknown",
    );
    expect(f.store.all<CallSession>("call")[0]?.state).toBe("connected");
    expect(f.store.effects("pending").some((e) => e.kind === "end_call")).toBe(
      true,
    );
    expect(
      f.store.get<{ controlEpoch: number }>("session", f.agent.session.id)
        ?.controlEpoch,
    ).toBe(1);
    expect(f.app.expireSessions()).toEqual({ stopped: 0 });
  });
  it("late heartbeat cannot revive a session after its timeout even before the next runtime tick", () => {
    const f = fixture();
    f.advance(20001);
    expect(() => f.app.heartbeat(f.agent.token)).toThrow("stopped");
  });
  it("a lost connector cancels an undispatched request without making a call", async () => {
    const f = fixture();
    f.request();
    f.advance(20000);
    f.app.expireSessions();
    await f.app.drain();
    expect(f.transport.calls).toHaveLength(0);
    expect(f.store.all<CallSession>("call")[0]?.state).toBe("ended");
  });
  it("pairing links are exact-device-bound, expiring and one-use", () => {
    const f = fixture(),
      link = f.app.createPairingInvite({ ...invite, ttlSeconds: 30 });
    expect(() =>
      f.app.claimPairing({
        token: link.token,
        deviceId: "other",
        displayId: "display",
        allowView: true,
        allowControl: true,
      }),
    ).toThrow("does not match");
    f.advance(31000);
    expect(() =>
      f.app.claimPairing({
        token: link.token,
        deviceId: "mac",
        displayId: "display",
        allowView: true,
        allowControl: true,
      }),
    ).toThrow("expired");
    const link2 = f.app.createPairingInvite(invite),
      claim = {
        token: link2.token,
        deviceId: "mac",
        displayId: "display",
        allowView: true,
        allowControl: false,
      };
    const claimed = f.app.claimPairing(claim);
    expect(
      f.store
        .all<{ pairingId?: string }>("invite")
        .some((i) => i.pairingId === claimed.pairing.id),
    ).toBe(true);
    expect(() => f.app.claimPairing(claim)).toThrow("already used");
  });
});
const binding: MessageBinding = {
  origin: "https://native.example.test",
  token: "not-a-real-secret",
  signingSecret: "not-a-real-secret",
  lineId: "line",
  providerLineId: "provider",
  phone: "+15550000002",
  instanceId: "instance",
};
function nativeRow(sequence = 1) {
  return {
    sequence,
    event_id: `recv:guid${sequence}`,
    type: "message_received",
    phone_line_id: "provider",
    payload: {
      phone_line_id: "provider",
      message: {
        guid: `guid${sequence}`,
        phone_line_id: "provider",
        role: "inbound",
        status: "received",
        service: "imessage",
        recipient: "+15550000001",
        chat_id: "any;-;+15550000001",
        is_group: false,
        parts: [{ type: "text", text: "answer" }],
      },
    },
  };
}
describe("native feed migration boundaries", () => {
  it("accepts observed any DM GUID, excludes SMS/echo/group and rejects conflicting line identities", () => {
    expect(normalizeNativeEvent(nativeRow(), binding)?.conversationId).toBe(
      "any;-;+15550000001",
    );
    for (const override of [
      { service: "sms" },
      { role: "outbound" },
      { is_group: true },
    ]) {
      const row = nativeRow();
      Object.assign(row.payload.message, override);
      expect(normalizeNativeEvent(row, binding)).toBeNull();
    }
    expect(() =>
      normalizeNativeEvent(
        { ...nativeRow(), phone_line_id: "foreign" },
        binding,
      ),
    ).toThrow("identity changed");
  });
  it("commits event effects and cursor together, rolls back on handler failure", async () => {
    const store = new Store();
    const request = async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      const body = path.endsWith("/whoami")
        ? {
            healthy: true,
            phone_line: {
              phone_line_id: "provider",
              phone_number: binding.phone,
              instance_id: "instance",
            },
          }
        : path.endsWith("/catchup")
          ? { events: [nativeRow(2)], head_sequence: 2, has_more: false }
          : nativeRow(1);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const native = new NativeMessages(store, binding, request as typeof fetch);
    await native.baseline(1, "recv:guid1");
    await expect(
      native.poll(() => {
        store.saveState("effect", { ok: true });
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect(native.cursor()?.sequence).toBe(1);
    expect(store.state("effect")).toBeUndefined();
    await native.poll(() => store.saveState("effect", { ok: true }));
    expect(native.cursor()?.sequence).toBe(2);
    await expect(native.baseline(2, "recv:guid2")).rejects.toThrow(
      "never replaced",
    );
  });
  it("rejects gaps before executing any event in a batch", async () => {
    const store = new Store();
    store.saveState("messages:line", { sequence: 1, eventId: "recv:guid1" });
    let called = 0;
    const request = async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).includes("whoami")
            ? {
                healthy: true,
                phone_line: {
                  phone_line_id: "provider",
                  phone_number: binding.phone,
                  instance_id: "instance",
                },
              }
            : String(url).includes("catchup")
              ? {
                  events: [nativeRow(2), nativeRow(4)],
                  head_sequence: 4,
                  has_more: false,
                }
              : nativeRow(1),
        ),
      );
    const native = new NativeMessages(store, binding, request as typeof fetch);
    await expect(
      native.poll(() => {
        called++;
      }),
    ).rejects.toThrow("sequence gap");
    expect(called).toBe(0);
    expect(native.cursor()?.sequence).toBe(1);
  });
});

describe("correlated line-less native administrative observations", () => {
  const admin = (sequence: number, guid: string) => ({
    sequence,
    event_id: `optout:${guid}`,
    type: "lead_opted_out",
    payload: {
      source: "inbound",
      message_guid: guid,
      recipient_phone: "+15550000001",
    },
  });
  function feed(initial: unknown[]) {
    const store = new Store();
    let rows = initial;
    const request = async (url: string | URL | Request) => {
      const u = new URL(String(url));
      let body: unknown;
      if (u.pathname.endsWith("/whoami"))
        body = {
          healthy: true,
          phone_line: {
            phone_line_id: "provider",
            phone_number: binding.phone,
            instance_id: "instance",
          },
        };
      else if (u.pathname.endsWith("/catchup")) {
        const since = Number(u.searchParams.get("since_sequence"));
        body = {
          events: rows.filter(
            (r) => (r as { sequence: number }).sequence > since,
          ),
          head_sequence: Math.max(
            ...rows.map((r) => (r as { sequence: number }).sequence),
          ),
          has_more: false,
        };
      } else
        body = rows.find(
          (r) =>
            (r as { sequence: number }).sequence ===
            Number(u.pathname.split("/").at(-1)),
        );
      return new Response(JSON.stringify(body));
    };
    return {
      store,
      native: new NativeMessages(store, binding, request as typeof fetch),
      set: (next: unknown[]) => (rows = next),
    };
  }
  it("advances correlated opt-out without executing it and retains it safely as next anchor", async () => {
    const f = feed([nativeRow(1), admin(2, "guid1")]);
    await f.native.baseline(1, "recv:guid1");
    const received: string[] = [];
    await f.native.poll((e) => received.push(e.id));
    expect(received).toHaveLength(0);
    expect(f.native.cursor()?.sequence).toBe(2);
    f.set([nativeRow(1), admin(2, "guid1"), nativeRow(3)]);
    await f.native.poll((e) => received.push(e.id));
    expect(received).toHaveLength(1);
    expect(f.native.cursor()?.sequence).toBe(3);
  });
  it("correlates an earlier verified message within the same page, never administrative prose", async () => {
    const f = feed([
      nativeRow(1),
      nativeRow(2),
      {
        ...admin(3, "guid2"),
        payload: { ...admin(3, "guid2").payload, text: "type: malicious" },
      },
    ]);
    await f.native.baseline(1, "recv:guid1");
    const received: string[] = [];
    await f.native.poll((e) => received.push(e.text));
    expect(received).toEqual(["answer"]);
    expect(f.native.cursor()?.sequence).toBe(3);
  });
  it.each(["sender", "guid", "source", "foreignLine", "future"] as const)(
    "rejects uncorrelated admin evidence: %s",
    async (kind) => {
      const bad: Record<string, any> = admin(2, "guid1");
      let rows: unknown[] = [nativeRow(1), bad];
      if (kind === "sender") bad.payload.recipient_phone = "+15550000009";
      if (kind === "guid") bad.payload.message_guid = "other";
      if (kind === "source") bad.payload.source = "outbound";
      if (kind === "foreignLine") bad.phone_line_id = "foreign";
      if (kind === "future") {
        bad.event_id = "optout:guid3";
        bad.payload.message_guid = "guid3";
        rows = [nativeRow(1), bad, nativeRow(3)];
      }
      const f = feed(rows);
      await f.native.baseline(1, "recv:guid1");
      let handled = 0;
      await expect(f.native.poll(() => handled++)).rejects.toThrow(
        "identity changed",
      );
      expect(handled).toBe(0);
      expect(f.native.cursor()?.sequence).toBe(1);
    },
  );
  it("rejects changed administrative anchor evidence even when its sequence/id are unchanged", async () => {
    const f = feed([nativeRow(1), admin(2, "guid1")]);
    await f.native.baseline(1, "recv:guid1");
    await f.native.poll(() => {});
    f.set([
      nativeRow(1),
      {
        ...admin(2, "guid1"),
        payload: {
          ...admin(2, "guid1").payload,
          recipient_phone: "+15550000009",
        },
      },
    ]);
    await expect(f.native.poll(() => {})).rejects.toThrow(
      "cursor evidence changed",
    );
    expect(f.native.cursor()?.sequence).toBe(2);
  });
});
