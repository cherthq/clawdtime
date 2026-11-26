import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { JobBroker } from "../src/attention/jobs.js";
import { RemoteExecutionRunner } from "../src/control/remote-runner.js";
import type { ExecutionResult } from "../src/contracts.js";
const intent = {
  instruction: "Synthetic fixture task",
  kind: "file" as const,
  preference: "auto" as const,
};
const result: ExecutionResult = {
  outcome: "succeeded",
  summary: "Synthetic verified result",
  verification: {
    verified: true,
    method: "file_read",
    evidenceId: "synthetic",
  },
  unresolvedEffectIds: [],
};
function fixture() {
  let now = 100_000;
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport(), {
      clock: () => now,
    });
  const invite = service.createPairingInvite({
    memberId: "human",
    recipient: "fixture",
    lineId: "line",
    conversationId: "messages",
    deviceId: "mac",
    displayId: "1",
  });
  const pairing = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: false,
  });
  const registration = {
    adapter: "codex" as const,
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "managed-one",
    hostId: "host",
    protocolVersion: 2 as const,
    conversation: {
      version: 1 as const,
      runnerId: "remote-codex-app-server",
      executionSession: "api_managed" as const,
    },
    capabilities: { cooperativePause: true, polling: true },
  };
  const agent = service.registerSession(pairing.token, registration);
  const binding = {
    sessionId: agent.session.id,
    pairingId: pairing.pairing.id,
    memberId: "human",
  };
  const remote = new RemoteExecutionRunner(service, true),
    broker = new JobBroker(service, [remote]);
  const details = {
    version: "fixture",
    projectRoot: "/fixture",
    externalSessionId: registration.externalSessionId,
  };
  remote.ready(binding, details);
  return {
    store,
    service,
    pairing,
    agent,
    binding,
    remote,
    broker,
    registration,
    details,
    advance: (ms: number) => (now += ms),
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.useRealTimers());
describe("scoped local execution worker", () => {
  it("readiness of one session never admits work into another session", () => {
    const f = fixture();
    const other = f.service.registerSession(f.pairing.token, {
      ...f.registration,
      externalSessionId: "managed-two",
    });
    const binding = { ...f.binding, sessionId: other.session.id };
    expect(f.broker.capabilities(f.binding).available).toBe(true);
    expect(f.broker.capabilities(binding).available).toBe(false);
    expect(() =>
      f.broker.submit(binding, { channel: "text", eventId: "one" }, intent),
    ).toThrow("unavailable");
    f.store.close();
  });
  it("stale worker readiness rejects new work and retires queued work for clarification", async () => {
    const f = fixture(),
      job = f.broker.submit(
        f.binding,
        { channel: "text", eventId: "queued" },
        intent,
      );
    f.advance(10000);
    expect(() =>
      f.broker.submit(f.binding, { channel: "text", eventId: "later" }, intent),
    ).toThrow("unavailable");
    f.broker.dispatch();
    await settle();
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      state: "waiting_clarification",
      progress: "runner_unavailable",
    });
    f.remote.ready(f.binding, f.details);
    f.broker.dispatch();
    await settle();
    expect(f.remote.next(f.binding, "retry")).toEqual({});
    f.store.close();
  });
  it("retries one delivery event with the same dispatch and accepts result idempotently", async () => {
    const f = fixture(),
      job = f.broker.submit(
        f.binding,
        { channel: "text", eventId: "one" },
        intent,
      );
    f.broker.dispatch();
    await settle();
    const dispatch = f.remote.next(f.binding, "poll-one").dispatch!;
    expect(dispatch.job.id).toBe(job.id);
    expect(f.remote.next(f.binding, "poll-one").dispatch?.job.dispatchId).toBe(
      dispatch.job.dispatchId,
    );
    expect(f.remote.next(f.binding, "different-poll")).toEqual({});
    f.remote.event(f.binding, dispatch.job.dispatchId!, { type: "accepted" });
    f.remote.result(f.binding, dispatch.job.dispatchId!, result);
    expect(
      f.remote.result(f.binding, dispatch.job.dispatchId!, result),
    ).toEqual({ accepted: true });
    expect(() =>
      f.remote.result(f.binding, dispatch.job.dispatchId!, {
        ...result,
        outcome: "failed",
      }),
    ).toThrow("identity changed");
    await settle();
    expect(f.broker.status(f.binding, job.id).state).toBe("succeeded");
    expect(f.remote.next(f.binding, "poll-one")).toEqual({});
    f.store.close();
  });
  it("wrong session/member cannot claim, report or cancel a dispatch", async () => {
    const f = fixture(),
      job = f.broker.submit(
        f.binding,
        { channel: "text", eventId: "one" },
        intent,
      );
    f.broker.dispatch();
    await settle();
    const forged = { ...f.binding, memberId: "stranger" };
    expect(() => f.remote.ready(forged, f.details)).toThrow();
    expect(() => f.remote.next(forged, "forged")).toThrow();
    const dispatch = f.remote.next(f.binding, "poll").dispatch!;
    expect(() =>
      f.remote.event(
        { ...f.binding, sessionId: "other" },
        dispatch.job.dispatchId!,
        { type: "accepted" },
      ),
    ).toThrow();
    expect(() =>
      f.remote.result(forged, dispatch.job.dispatchId!, result),
    ).toThrow();
    f.remote.result(f.binding, dispatch.job.dispatchId!, result);
    await settle();
    expect(f.broker.status(f.binding, job.id).state).toBe("succeeded");
    f.store.close();
  });
  it("claimed timeout preserves unknown outcome and refuses replay", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      job = f.broker.submit(
        f.binding,
        { channel: "text", eventId: "one" },
        intent,
      );
    f.broker.dispatch();
    await Promise.resolve();
    const dispatch = f.remote.next(f.binding, "poll").dispatch!;
    await vi.advanceTimersByTimeAsync(120_001);
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      state: "unknown",
      result: { unresolvedEffectIds: [dispatch.job.dispatchId] },
    });
    expect(f.remote.next(f.binding, "poll")).toEqual({});
    expect(() =>
      f.broker.submit(f.binding, { channel: "text", eventId: "retry" }, intent),
    ).toThrow("unresolved");
    f.store.close();
  });
  it("cancellation before claim is confirmed but after claim remains requested", async () => {
    const f = fixture(),
      first = f.broker.submit(
        f.binding,
        { channel: "text", eventId: "one" },
        intent,
      );
    f.broker.dispatch();
    await settle();
    f.broker.cancel(
      f.binding,
      { channel: "text", eventId: "cancel-one" },
      first.id,
      1,
    );
    await settle();
    expect(f.broker.status(f.binding, first.id).state).toBe("canceled");
    const second = f.broker.submit(
      f.binding,
      { channel: "text", eventId: "two" },
      intent,
    );
    f.broker.dispatch();
    await settle();
    const dispatch = f.remote.next(f.binding, "poll").dispatch!;
    f.broker.cancel(
      f.binding,
      { channel: "voice", eventId: "cancel-two" },
      second.id,
      1,
    );
    expect(
      f.remote.command(f.binding, dispatch.job.dispatchId!).cancelRequested,
    ).toBe(true);
    expect(f.broker.status(f.binding, second.id).state).toBe(
      "cancel_requested",
    );
    f.remote.result(f.binding, dispatch.job.dispatchId!, {
      outcome: "canceled",
      summary: "Quiescence observed",
      unresolvedEffectIds: [],
    });
    await settle();
    expect(f.broker.status(f.binding, second.id).state).toBe("canceled");
    f.store.close();
  });
  it("retains a late authenticated result as reconciliation evidence without clearing unknown or replaying payloads", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      job = f.broker.submit(
        f.binding,
        { channel: "text", eventId: "one" },
        intent,
      );
    f.broker.dispatch();
    await Promise.resolve();
    const dispatch = f.remote.next(f.binding, "original-poll").dispatch!,
      dispatchId = dispatch.job.dispatchId!;
    await vi.advanceTimersByTimeAsync(120_001);
    const before = f.broker.status(f.binding, job.id),
      receiptBefore = f.store.get("job_dispatch", dispatchId);
    expect(before.state).toBe("unknown");
    expect(f.remote.result(f.binding, dispatchId, result)).toEqual({
      accepted: true,
      reconciliationRequired: true,
    });
    expect(f.store.get("remote_result_receipt", dispatchId)).toEqual({
      id: dispatchId,
      sessionId: f.binding.sessionId,
      outcome: "succeeded",
      unresolvedEffectIds: [],
      verification: result.verification,
      reconciliationRequired: true,
    });
    expect(
      f.store.get<{ summary?: string }>("remote_result_receipt", dispatchId)
        ?.summary,
    ).toBeUndefined();
    const fingerprint = f.store.event(
      `remote-result:${dispatchId}`,
    )?.fingerprint;
    expect(f.remote.result(f.binding, dispatchId, result)).toMatchObject({
      accepted: true,
    });
    expect(f.store.event(`remote-result:${dispatchId}`)?.fingerprint).toBe(
      fingerprint,
    );
    expect(f.store.all("remote_result_receipt")).toHaveLength(1);
    expect(() =>
      f.remote.result(f.binding, dispatchId, { ...result, outcome: "failed" }),
    ).toThrow("identity changed");
    expect(() =>
      f.remote.result(
        { ...f.binding, memberId: "stranger" },
        dispatchId,
        result,
      ),
    ).toThrow();
    expect(f.remote.next(f.binding, "original-poll")).toEqual({});
    expect(f.remote.next(f.binding, "new-poll")).toEqual({});
    expect(f.broker.status(f.binding, job.id)).toEqual(before);
    expect(f.store.get("job_dispatch", dispatchId)).toEqual(receiptBefore);
    expect(() =>
      f.broker.submit(f.binding, { channel: "text", eventId: "retry" }, intent),
    ).toThrow("unresolved");
    f.store.close();
  });
});
describe("remote worker connections", () => {
  function managed(f: ReturnType<typeof fixture>, index: number) {
    const registered = f.service.registerSession(f.pairing.token, {
      ...f.registration,
      externalSessionId: `managed-${index}`,
    });
    return {
      session: registered.session,
      binding: { ...f.binding, sessionId: registered.session.id },
      details: { ...f.details, externalSessionId: `managed-${index}` },
    };
  }
  it("forgets the worker of a finished session, so finished sessions never fill the capacity", () => {
    const f = fixture();
    let accepted = 0;
    for (let i = 0; i < 150; i++) {
      const worker = managed(f, i);
      f.remote.ready(worker.binding, worker.details);
      accepted++;
      // The session ends, and its worker stops sending heartbeats.
      f.store.put("session", { ...worker.session, state: "stopped" });
      f.advance(1000);
    }
    expect(accepted).toBe(150);
    f.store.close();
  });
  it("forgets a worker whose heartbeat stopped, and still bounds live workers", () => {
    const f = fixture();
    const workers = Array.from({ length: 99 }, (_, i) => managed(f, i));
    for (const worker of workers)
      f.remote.ready(worker.binding, worker.details);
    const extra = managed(f, 200);
    expect(() => f.remote.ready(extra.binding, extra.details)).toThrow(
      "capacity",
    );
    // Every worker stops its heartbeat; the sessions stay open.
    f.advance(10_000);
    for (const worker of workers)
      f.store.put("session", {
        ...f.store.get<typeof worker.session>("session", worker.session.id)!,
        lastSeenAt: f.service.clock(),
      });
    f.store.put("session", { ...extra.session, lastSeenAt: f.service.clock() });
    expect(f.remote.ready(extra.binding, extra.details)).toEqual({
      ready: true,
    });
    expect(f.remote.capabilities(extra.binding).available).toBe(true);
    expect(f.remote.capabilities(workers[0]!.binding).available).toBe(false);
    f.remote.ready(workers[0]!.binding, workers[0]!.details);
    expect(f.remote.capabilities(workers[0]!.binding).available).toBe(true);
    f.store.close();
  });
});
