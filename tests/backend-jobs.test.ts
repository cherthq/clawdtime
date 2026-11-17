import { hash } from "../src/storage/security.js";
import { RoutedExecutionRunner } from "../src/control/desktop-runner.js";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { JobBroker } from "../src/attention/jobs.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import type {
  AgentSession,
  ExecutionResult,
  ExecutionRunner,
  JobIntent,
} from "../src/contracts.js";

const intent: JobIntent = {
  instruction: "Synthetic fixture instruction",
  kind: "file",
  preference: "auto",
};
const source = (eventId: string, channel: "text" | "voice" = "text") => ({
  eventId,
  channel,
});
const success: ExecutionResult = {
  outcome: "succeeded",
  summary: "Private model prose must not persist",
  verification: {
    verified: true,
    method: "file_read",
    evidenceId: "observed-fixture",
  },
  unresolvedEffectIds: [],
};
function fixture(path?: string) {
  const store = new Store(path),
    transport = new SimulationTransport();
  let now = 100_000;
  const service = new ClawdTime(store, transport, { clock: () => now });
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
    allowControl: true,
  });
  const registration = {
    adapter: "codex" as const,
    adapterVersion: "test",
    projectRoot: "/fixture",
    externalSessionId: "api-managed",
    hostId: "host",
    protocolVersion: 2 as const,
    conversation: {
      version: 1 as const,
      runnerId: "runner",
      executionSession: "api_managed" as const,
    },
    capabilities: { polling: true, cooperativePause: true },
  };
  const agent = service.registerSession(pairing.token, registration);
  const binding = {
    sessionId: agent.session.id,
    pairingId: pairing.pairing.id,
    memberId: "human",
  };
  let resolve!: (result: ExecutionResult) => void,
    calls = 0,
    aborted = false;
  const runner: ExecutionRunner = {
    capabilities: () => ({
      id: "runner",
      host: "codex_app_server",
      available: true,
      version: "fixture",
      nativeControl: "none",
      customControl: false,
      cancellation: "cooperative",
    }),
    run: async (_request, emit, signal) => {
      calls++;
      emit({ type: "accepted" });
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const broker = new JobBroker(service, [runner]);
  return {
    store,
    service,
    transport,
    agent,
    pairing,
    registration,
    binding,
    broker,
    runner,
    advance: (ms: number) => (now += ms),
    resolve: (result = success) => resolve(result),
    calls: () => calls,
    aborted: () => aborted,
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("asynchronous job broker", () => {
  it("atomically accepts, deduplicates real event identity and does not retain task content", async () => {
    const f = fixture();
    const job = f.broker.submit(f.binding, source("first"), intent);
    expect(job.state).toBe("queued");
    expect(f.store.get("job_dispatch", `${job.id}:1`)).toMatchObject({
      state: "pending",
    });
    expect(f.broker.submit(f.binding, source("first"), intent).id).toBe(job.id);
    expect(() =>
      f.broker.submit(f.binding, source("first"), {
        ...intent,
        instruction: "Changed",
      }),
    ).toThrow("identity changed");
    expect(f.broker.submit(f.binding, source("separate"), intent).id).not.toBe(
      job.id,
    );
    expect(
      JSON.stringify(f.store.query("SELECT * FROM entities")),
    ).not.toContain(intent.instruction);
    f.store.close();
  });
  it("keeps conversational work responsive during slow execution and serializes a session", async () => {
    const f = fixture(),
      a = f.broker.submit(f.binding, source("one"), intent),
      b = f.broker.submit(f.binding, source("two"), intent);
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(1);
    const sequence = f.broker.sequence(f.binding, source("question"));
    f.broker.queueReply(
      f.binding,
      source("question"),
      sequence,
      "The first job is running.",
      a.id,
    );
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(1);
    expect(f.broker.status(f.binding, b.id).state).toBe("queued");
    f.resolve();
    await settle();
    expect(f.broker.status(f.binding, a.id).state).toBe("succeeded");
    expect(
      JSON.stringify(f.store.query("SELECT * FROM entities")),
    ).not.toContain(success.summary);
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(2);
    f.resolve();
    await settle();
    f.store.close();
  });
  it("orders voice and text corrections and suppresses old results after running revision", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("voice-one", "voice"), intent);
    f.broker.dispatch();
    await settle();
    const revised = f.broker.revise(f.binding, source("text-fix"), job.id, 1, {
      ...intent,
      instruction: "New target",
    });
    expect(revised).toMatchObject({
      revision: 2,
      instructionSequence: 2,
      state: "cancel_requested",
    });
    expect(f.aborted()).toBe(true);
    f.resolve();
    await settle();
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      state: "waiting_clarification",
      revision: 2,
    });
    expect(f.broker.status(f.binding, job.id).result).toBeUndefined();
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(1);
    f.store.close();
  });
  it("queued cancellation never dispatches; running cancellation awaits confirmed outcome", async () => {
    const f = fixture(),
      first = f.broker.submit(f.binding, source("one"), intent);
    expect(
      f.broker.cancel(f.binding, source("cancel-one"), first.id, 1).state,
    ).toBe("canceled");
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(0);
    const second = f.broker.submit(f.binding, source("two"), intent);
    f.broker.dispatch();
    await settle();
    expect(
      f.broker.cancel(f.binding, source("cancel-two"), second.id, 1).state,
    ).toBe("cancel_requested");
    f.resolve({ outcome: "canceled", summary: "", unresolvedEffectIds: [] });
    await settle();
    expect(f.broker.status(f.binding, second.id).state).toBe("canceled");
    f.store.close();
  });
  it("independent verification is required and unresolved effects block all further dispatch", async () => {
    const f = fixture(),
      first = f.broker.submit(f.binding, source("one"), intent);
    f.broker.dispatch();
    await settle();
    f.resolve({ ...success, verification: undefined });
    await settle();
    expect(f.broker.status(f.binding, first.id).state).toBe("failed");
    const second = f.broker.submit(f.binding, source("two"), intent);
    f.broker.dispatch();
    await settle();
    f.resolve({ ...success, unresolvedEffectIds: ["input-receipt"] });
    await settle();
    expect(f.broker.status(f.binding, second.id).state).toBe("unknown");
    expect(() =>
      f.broker.submit(f.binding, source("fallback"), intent),
    ).toThrow("unresolved");
    f.store.close();
  });
  it("refuses unavailable hosts and unimplemented control capabilities before creating work", () => {
    const f = fixture(),
      unavailable = new JobBroker(f.service, []);
    expect(unavailable.capabilities(f.binding).available).toBe(false);
    expect(() => unavailable.submit(f.binding, source("one"), intent)).toThrow(
      "unavailable",
    );
    expect(() =>
      f.broker.submit(f.binding, source("desktop"), {
        ...intent,
        kind: "desktop",
        preference: "native",
      }),
    ).toThrow("surface");
    expect(f.broker.list(f.binding)).toHaveLength(0);
    f.store.close();
  });
  it("refuses wrong member, pairing, session and expired session", () => {
    const f = fixture();
    for (const binding of [
      { ...f.binding, memberId: "stranger" },
      { ...f.binding, sessionId: "stranger" },
    ])
      expect(() => f.broker.submit(binding, source("wrong"), intent)).toThrow(
        "identity",
      );
    f.advance(20_000);
    expect(() => f.broker.submit(f.binding, source("expired"), intent)).toThrow(
      "unavailable",
    );
    f.store.close();
  });
  it("suppresses stale queued replies and rechecks revocation immediately before send", async () => {
    const f = fixture(),
      sequence = f.broker.sequence(f.binding, source("one"));
    f.broker.queueReply(f.binding, source("one"), sequence, "Old answer");
    f.broker.sequence(f.binding, source("two", "voice"));
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(0);
    const next = f.broker.currentSequence(f.binding);
    f.broker.queueReply(f.binding, source("two"), next, "New answer");
    f.store.put("session", {
      ...f.agent.session,
      state: "stopped",
    } satisfies AgentSession);
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(0);
    expect(
      f.store.effects().every((effect) => effect.payload.text === undefined),
    ).toBe(true);
    f.store.close();
  });
  it("unknown outbound replies are never replayed", async () => {
    const f = fixture(),
      sequence = f.broker.sequence(f.binding, source("one"));
    const receipt = f.broker.queueReply(
      f.binding,
      source("one"),
      sequence,
      "Reply",
    )!;
    let attempts = 0;
    f.transport.message = async () => {
      attempts++;
      throw new Error("Lost receipt");
    };
    await f.service.drain();
    expect(f.store.effect(receipt.id)?.state).toBe("unknown");
    expect(
      f.broker.queueReply(f.binding, source("one"), sequence, "Reply")?.id,
    ).toBe(receipt.id);
    await f.service.drain();
    expect(attempts).toBe(1);
    f.store.close();
  });
  it("restart preserves metadata and does not revive missing prompts or uncertain actions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-jobs-")),
      path = join(directory, "state.sqlite");
    try {
      const f = fixture(path),
        one = f.broker.submit(f.binding, source("one"), intent),
        two = f.broker.submit(f.binding, source("two"), intent);
      f.broker.dispatch();
      await settle();
      const reopened = new Store(path),
        service = new ClawdTime(reopened, new SimulationTransport(), {
          clock: () => 100_000,
        });
      const broker = new JobBroker(service, [f.runner]);
      expect(broker.status(f.binding, one.id).state).toBe("unknown");
      expect(broker.status(f.binding, two.id).state).toBe(
        "waiting_clarification",
      );
      broker.dispatch();
      await settle();
      expect(f.calls()).toBe(1);
      f.resolve({
        outcome: "unknown",
        summary: "",
        unresolvedEffectIds: ["old"],
      });
      await settle();
      reopened.close();
      f.store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("negotiation cannot be changed on a registered session", () => {
    const f = fixture();
    expect(() =>
      f.service.registerSession(f.pairing.token, {
        ...f.registration,
        conversation: { ...f.registration.conversation, runnerId: "another" },
      }),
    ).toThrow("binding differs");
    f.store.close();
  });
  it("holds queued actions during interpretation and stale releases cannot clear newer holds", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    const first = f.broker.hold(f.binding, source("first"));
    const next = f.broker.hold(f.binding, source("next", "voice"));
    f.broker.clearHold(f.binding, first);
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(0);
    f.advance(10_001); // Hold expiry itself never grants input authority.
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(0);
    f.broker.clearHold(f.binding, next);
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(1);
    f.resolve();
    await settle();
    expect(f.broker.status(f.binding, job.id).state).toBe("succeeded");
    f.store.close();
  });
  it("a cross-channel interpretation hold arriving after durable dispatch prevents executor launch", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    f.broker.dispatch();
    const hold = f.broker.hold(f.binding, source("voice-correction", "voice"));
    await settle();
    expect(f.calls()).toBe(0);
    expect(f.broker.status(f.binding, job.id).state).toBe("queued");
    expect(f.store.get<any>("job_dispatch", `${job.id}:1`).state).toBe(
      "pending",
    );
    f.broker.revise(f.binding, source("voice-correction", "voice"), job.id, 1, {
      ...intent,
      instruction: "Revised fixture",
    });
    f.broker.clearHold(f.binding, hold);
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(1);
    f.resolve();
    await settle();
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      revision: 2,
      state: "succeeded",
    });
    f.store.close();
  });
  it("session expiry between durable dispatch and launch never invokes the executor", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    f.broker.dispatch();
    f.advance(20000);
    await settle();
    expect(f.calls()).toBe(0);
    expect(f.store.get<any>("conversation_job", job.id).state).toBe("canceled");
    f.store.close();
  });
  it("runner readiness loss between durable dispatch and launch requires clarification", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    f.broker.dispatch();
    const caps = f.runner.capabilities();
    f.runner.capabilities = () => ({ ...caps, available: false });
    await settle();
    expect(f.calls()).toBe(0);
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      state: "waiting_clarification",
      progress: "runner_unavailable",
    });
    f.store.close();
  });
  it("does not publish completion facts while a newer correction is unresolved", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    f.broker.dispatch();
    await settle();
    const hold = f.broker.hold(f.binding, source("voice-correction", "voice"));
    f.resolve();
    await settle();
    expect(() =>
      f.broker.queueReply(
        f.binding,
        source("result"),
        hold,
        "Verified",
        job.id,
      ),
    ).toThrow("finalized intent");
    expect(f.store.effects()).toHaveLength(0);
    f.broker.clearHold(f.binding, hold);
    f.broker.queueReply(f.binding, source("result"), hold, "Verified", job.id);
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(1);
    f.store.close();
  });
  it("bounded status history never hides an older unresolved effect from admission or Stop", () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("old"), intent);
    for (let i = 0; i < 101; i++)
      f.store.put("conversation_job", {
        ...job,
        id: `history-${i}`,
        state: "succeeded",
      });
    expect(f.broker.list(f.binding).some((j) => j.id === job.id)).toBe(false);
    f.store.put("conversation_job", { ...job, state: "unknown" });
    expect(() => f.broker.submit(f.binding, source("new"), intent)).toThrow(
      "unresolved",
    );
    f.store.put("conversation_job", { ...job, state: "queued" });
    f.broker.cancelAll(f.binding, source("stop"));
    expect(f.broker.status(f.binding, job.id).state).toBe("canceled");
    f.store.close();
  });
  it("repeat local Stop event does not cancel work accepted after that event", () => {
    const f = fixture(),
      first = f.broker.submit(f.binding, source("first"), intent);
    f.broker.cancelAll(f.binding, source("stop"));
    expect(f.broker.status(f.binding, first.id).state).toBe("canceled");
    const second = f.broker.submit(f.binding, source("second"), intent);
    f.broker.cancelAll(f.binding, source("stop"));
    expect(f.broker.status(f.binding, second.id).state).toBe("queued");
    f.store.close();
  });
  it("malformed executor output becomes unknown without exposing untrusted data", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    f.broker.dispatch();
    await settle();
    f.resolve({
      outcome: "succeeded",
      summary: "private",
      unresolvedEffectIds: ["/private/data"],
    });
    await settle();
    expect(f.broker.status(f.binding, job.id).state).toBe("unknown");
    expect(
      f.broker.status(f.binding, job.id).result?.unresolvedEffectIds,
    ).toEqual([`${job.id}:1`]);
    expect(
      JSON.stringify(f.store.query("SELECT * FROM entities")),
    ).not.toContain("/private/data");
    f.store.close();
  });
  it("cancellation before the async launch microtask does not invoke an executor", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent);
    f.broker.dispatch();
    f.broker.cancel(f.binding, source("cancel"), job.id, 1);
    await settle();
    expect(f.calls()).toBe(0);
    expect(f.broker.status(f.binding, job.id).state).toBe("canceled");
    f.store.close();
  });
  it("revocation during execution requests stop and prevents pending subsequent jobs", async () => {
    const f = fixture(),
      first = f.broker.submit(f.binding, source("first"), intent),
      second = f.broker.submit(f.binding, source("second"), intent);
    f.broker.dispatch();
    await settle();
    f.store.put("pairing", { ...f.pairing.pairing, revokedAt: 100_001 });
    f.broker.dispatch();
    expect(f.aborted()).toBe(true);
    f.resolve({ outcome: "canceled", summary: "", unresolvedEffectIds: [] });
    await settle();
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(1);
    expect(f.store.get("conversation_job", first.id)).toMatchObject({
      state: "canceled",
    });
    expect(f.store.get("conversation_job", second.id)).toMatchObject({
      state: "canceled",
    });
    f.store.close();
  });
  it("redacts terminal and expired broker outbox text during retention sweep", () => {
    const f = fixture(),
      sequence = f.broker.sequence(f.binding, source("one"));
    const effect = f.broker.queueReply(
      f.binding,
      source("one"),
      sequence,
      "Synthetic private reply",
    )!;
    f.store.putEffect({ ...effect, state: "unknown" });
    new ClawdTime(f.store, f.transport, { clock: () => 100_000 });
    expect(f.store.effect(effect.id)?.payload.text).toBeUndefined();
    expect(f.store.effect(effect.id)?.payload.textFingerprint).toBe(
      effect.payload.textFingerprint,
    );
    expect(f.store.effect(effect.id)?.state).toBe("unknown");
    const next = f.broker.queueReply(
      f.binding,
      source("two"),
      sequence,
      "Expiring synthetic reply",
    )!;
    new ClawdTime(f.store, f.transport, { clock: () => 800_000 });
    expect(f.store.effect(next.id)).toMatchObject({ state: "failed" });
    expect(f.store.effect(next.id)?.payload.text).toBeUndefined();
    f.store.close();
  });
  it("admits an available desktop-only route while refusing an unavailable file host", async () => {
    const f = fixture();
    const original = f.runner.capabilities();
    f.runner.capabilities = () => ({
      ...original,
      available: false,
      taskKinds: [],
    });
    let calls = 0;
    const desktop: ExecutionRunner = {
      capabilities: () => ({
        id: "custom",
        host: "bounded_desktop",
        available: true,
        version: "synthetic",
        nativeControl: "none",
        customControl: true,
        cancellation: "cooperative",
        taskKinds: ["desktop"],
      }),
      run: async (_request, emit) => {
        calls++;
        emit({ type: "accepted" });
        return {
          ...success,
          verification: {
            verified: true,
            method: "ui_observation",
            evidenceId: "synthetic-ui",
          },
        };
      },
    };
    const broker = new JobBroker(f.service, [
      new RoutedExecutionRunner(f.runner, desktop),
    ]);
    expect(broker.capabilities(f.binding).available).toBe(true);
    expect(() => broker.submit(f.binding, source("files"), intent)).toThrow(
      "unavailable",
    );
    const job = broker.submit(f.binding, source("desktop"), {
      instruction: "Synthetic desktop fixture",
      kind: "desktop",
      preference: "custom",
      target: "Fixture",
      grantId: "synthetic",
    });
    broker.dispatch();
    await settle();
    expect(calls).toBe(1);
    expect(broker.status(f.binding, job.id).state).toBe("succeeded");
    f.store.close();
  });
  it("rechecks per-kind route availability immediately before executor dispatch", async () => {
    const f = fixture(),
      job = f.broker.submit(f.binding, source("start"), intent),
      caps = f.runner.capabilities();
    f.runner.capabilities = () => ({
      ...caps,
      taskKinds: ["desktop"],
      customControl: true,
    });
    f.broker.dispatch();
    await settle();
    expect(f.calls()).toBe(0);
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      state: "waiting_clarification",
      progress: "runner_unavailable",
    });
    expect(() =>
      f.broker.revise(f.binding, source("retry"), job.id, 1, intent),
    ).toThrow("unavailable");
    f.store.close();
  });
  it("bounded shutdown preserves unknown and detaches late callbacks before storage closes", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        job = f.broker.submit(f.binding, source("start"), intent);
      f.broker.dispatch();
      await Promise.resolve();
      const stopping = f.broker.stop();
      await vi.advanceTimersByTimeAsync(5001);
      await stopping;
      expect(f.broker.status(f.binding, job.id).state).toBe("unknown");
      f.store.close();
      f.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // A late confirmed result cannot write to closed storage or resurrect unknown work.
    } finally {
      vi.useRealTimers();
    }
  });
});

function documentFixture() {
  const f = fixture();
  const expiresAt = f.service.clock() + 300000;
  f.store.put("session", {
    ...f.agent.session,
    conversation: {
      ...f.agent.session.conversation!,
      runnerId: "remote-documents",
    },
    documentAccess: { version: 1, readOnly: true, expiresAt },
  });
  const grant = {
    ...f.binding,
    id: `docgrant_${hash(f.binding.sessionId).slice(0, 40)}`,
    projectRoot: f.agent.session.projectRoot,
    hostId: f.agent.session.hostId,
    expiresAt,
    state: "active" as const,
  };
  f.store.put("document_root_grant", grant);
  const caps = f.runner.capabilities();
  f.runner.capabilities = () => ({
    ...caps,
    id: "remote-documents",
    taskKinds: ["document"],
  });
  return { ...f, grant, broker: new JobBroker(f.service, [f.runner]) };
}
describe("verified structured document jobs", () => {
  it.each(["revoked", "expired"])(
    "%s document grant requests active cancellation and preserves an unknown runner outcome",
    async (reason) => {
      const f = documentFixture();
      const job = f.broker.submit(f.binding, source("discover"), {
        instruction: "List",
        kind: "document",
        preference: "auto",
        document: { operation: "discover", grantId: f.grant.id },
      });
      f.broker.dispatch();
      await settle();
      if (reason === "revoked")
        f.store.put("document_root_grant", { ...f.grant, state: "revoked" });
      else {
        f.advance(300001);
        const session = f.store.get<AgentSession>(
          "session",
          f.binding.sessionId,
        )!;
        f.store.put("session", { ...session, lastSeenAt: f.service.clock() });
      }
      expect(() => f.broker.dispatch()).not.toThrow();
      expect(f.aborted()).toBe(true);
      expect(f.broker.status(f.binding, job.id).state).toBe("cancel_requested");
      f.resolve({
        outcome: "unknown",
        summary: "",
        unresolvedEffectIds: [job.id],
      });
      await settle();
      expect(f.broker.status(f.binding, job.id).state).toBe("unknown");
      f.broker.dispatch();
      expect(f.calls()).toBe(1);
      f.store.close();
    },
  );
  it("closed queued document capabilities cannot throw out of maintenance or launch work", () => {
    const f = documentFixture();
    const job = f.broker.submit(f.binding, source("discover"), {
      instruction: "List",
      kind: "document",
      preference: "auto",
      document: { operation: "discover", grantId: f.grant.id },
    });
    f.runner.capabilities = () => {
      throw new Error("Grant closed");
    };
    expect(() => f.broker.dispatch()).not.toThrow();
    expect(f.broker.status(f.binding, job.id).state).toBe(
      "waiting_clarification",
    );
    expect(f.calls()).toBe(0);
    f.store.close();
  });
  it("requires exact immutable root grant and document operation, preserving only verified structured metadata", async () => {
    const f = documentFixture(),
      request: JobIntent = {
        instruction: "List documents",
        kind: "document",
        preference: "auto",
        document: { operation: "discover", grantId: f.grant.id },
      };
    expect(() =>
      f.broker.submit(f.binding, source("missing"), {
        ...request,
        document: undefined,
      }),
    ).toThrow();
    expect(() =>
      f.broker.submit(f.binding, source("wrong"), {
        ...request,
        document: { operation: "discover", grantId: "other" },
      }),
    ).toThrow("grant");
    const job = f.broker.submit(f.binding, source("discover"), request);
    f.broker.dispatch();
    await settle();
    const candidate = {
      id: "doc_" + "a".repeat(64),
      grantId: f.grant.id,
      name: "Resume.pdf",
      mimeType: "application/pdf",
      byteLength: 100,
      sha256: "b".repeat(64),
      previewSupport: "first_page" as const,
    };
    f.resolve({
      ...success,
      verification: {
        verified: true,
        method: "document_digest",
        evidenceId: "metadata",
      },
      document: { operation: "discover", candidates: [candidate] },
    });
    await settle();
    expect(f.broker.status(f.binding, job.id)).toMatchObject({
      state: "succeeded",
      result: { document: { operation: "discover", candidates: [candidate] } },
    });
    f.store.close();
  });
  it("revoked root between acceptance and launch prevents any host operation", async () => {
    const f = documentFixture(),
      job = f.broker.submit(f.binding, source("discover"), {
        instruction: "List",
        kind: "document",
        preference: "auto",
        document: { operation: "discover", grantId: f.grant.id },
      });
    f.broker.dispatch();
    f.store.put("document_root_grant", { ...f.grant, state: "revoked" });
    await settle();
    expect(f.calls()).toBe(0);
    expect(f.broker.status(f.binding, job.id).state).toBe(
      "waiting_clarification",
    );
    f.store.close();
  });
  it("wrong operation, candidate or receipt cannot verify a transfer", async () => {
    for (const mismatch of ["operation", "candidate", "receipt"]) {
      const f = documentFixture(),
        candidate = {
          id: "doc_" + "a".repeat(64),
          grantId: f.grant.id,
          name: "Resume.pdf",
          mimeType: "application/pdf",
          byteLength: 100,
          sha256: "b".repeat(64),
          previewSupport: "first_page" as const,
        };
      const job = f.broker.submit(f.binding, source("send"), {
        instruction: "Transfer",
        kind: "document",
        preference: "auto",
        document: {
          operation: "prepare_transfer",
          grantId: f.grant.id,
          candidate,
          transferId: "transfer",
        },
      });
      f.broker.dispatch();
      await settle();
      f.resolve({
        ...success,
        verification: {
          verified: true,
          method:
            mismatch === "receipt" ? "document_digest" : "attachment_receipt",
          evidenceId: "receipt",
        },
        document:
          mismatch === "operation"
            ? { operation: "discover", candidates: [] }
            : {
                operation: "prepare_transfer",
                candidate:
                  mismatch === "candidate"
                    ? { ...candidate, sha256: "c".repeat(64) }
                    : candidate,
                transferId: "transfer",
              },
      });
      await settle();
      expect(f.broker.status(f.binding, job.id).state).toBe("unknown");
      expect(
        f.broker.status(f.binding, job.id).result?.document,
      ).toBeUndefined();
      f.store.close();
    }
  });
});
