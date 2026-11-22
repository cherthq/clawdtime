import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import {
  ProactivePolicyAuthority,
  type ProactivePolicyInput,
} from "../src/attention/proactive-policy.js";
import type { EnqueueCall } from "../src/attention/proactive-contracts.js";

const stores: Store[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fingerprint = "ab".repeat(32);
function fixture(path = ":memory:") {
  const store = new Store(path),
    vault = new Vault("cd".repeat(32));
  stores.push(store);
  let now = 1000;
  const clock = () => now;
  const authority = new ProactivePolicyAuthority(store, vault, clock);
  const coordinator = new ProactiveCallCoordinator(
    store,
    vault,
    authority,
    clock,
  );
  const policy: ProactivePolicyInput = {
    version: 2,
    id: "policy",
    scope: { personId: "human", deviceId: "mac", projectRoot: "/fixture" },
    triggers: ["decision", "waiting", "failure", "review", "completion"],
    channels: ["phone_alert", "phone_walkthrough"],
    expiresAt: 100000,
    maxAttempts: 10,
    minIntervalMs: 0,
    attemptLifetimeMs: 10000,
    viewScope: ["presentation:fixture"],
    alertFallback: false,
    consent: {
      actorId: "human",
      recordedAt: 1000,
      source: "human_request",
      statement: "Call when this work needs me or is checked.",
    },
  };
  authority.register(policy);
  const input: EnqueueCall = {
    source: {
      kind: "session",
      sessionId: "session",
      runId: "run",
      enrollmentId: "enrollment",
    },
    scope: { ...policy.scope, sessionId: "session" },
    policyId: "policy",
    trigger: "failure",
    channel: "phone_alert",
    expiresAt: 100000,
    brief: "The check failed; please choose the next step.",
  };
  const ready = (value = input) => {
    const { record } = coordinator.enqueue(value);
    coordinator.prepare(record.id);
    return coordinator.ready(record.id, fingerprint);
  };
  const reserve = (intentId: string) =>
    coordinator.reserve(intentId, {
      sourceCurrent: true,
      lineAvailable: true,
      packetFingerprint: fingerprint,
    });
  return {
    store,
    vault,
    clock,
    authority,
    coordinator,
    policy,
    input,
    ready,
    reserve,
    time: (value: number) => {
      now = value;
    },
  };
}

describe("durable proactive phone coordinator", () => {
  it("deduplicates a decision observed through a hook, watcher and Job without consuming phone delivery as chat", () => {
    const f = fixture();
    const decision: EnqueueCall = {
      ...f.input,
      trigger: "decision",
      source: {
        kind: "decision",
        sessionId: "session",
        runId: "run",
        decisionId: "question",
      },
    };
    const first = f.coordinator.enqueue(decision);
    expect(
      f.coordinator.enqueue({
        ...decision,
        source: {
          kind: "job",
          jobId: "job",
          launchId: "launch",
          sessionId: "session",
          runId: "run",
          decisionId: "question",
        },
      }).record.id,
    ).toBe(first.record.id);
    expect(
      f.coordinator.enqueue({
        ...decision,
        source: {
          kind: "session",
          enrollmentId: "enrolled",
          sessionId: "session",
          runId: "run",
          decisionId: "question",
        },
      }).record.id,
    ).toBe(first.record.id);
    expect(f.coordinator.list()).toHaveLength(1);
    expect(f.coordinator.get(first.record.id).observations).toHaveLength(3);
    expect(() =>
      f.coordinator.enqueue({
        ...decision,
        channel: "chat",
      } as unknown as EnqueueCall),
    ).toThrow();
  });
  it("matches Job and enrolled-session results by exact run and digest", () => {
    const f = fixture();
    const first = f.coordinator.enqueue({
      ...f.input,
      trigger: "completion",
      source: {
        kind: "job",
        sessionId: "session",
        runId: "run",
        jobId: "job",
        launchId: "launch",
        resultDigest: fingerprint,
      },
    });
    expect(
      f.coordinator.enqueue({
        ...f.input,
        trigger: "review",
        source: {
          kind: "session",
          sessionId: "session",
          runId: "run",
          enrollmentId: "enrollment",
          resultDigest: fingerprint,
        },
      }).record.id,
    ).toBe(first.record.id);
    expect(
      f.coordinator.enqueue({
        ...f.input,
        trigger: "completion",
        source: {
          kind: "job",
          sessionId: "session",
          runId: "new-run",
          jobId: "job",
          launchId: "new-launch",
          resultDigest: fingerprint,
        },
      }).record.id,
    ).not.toBe(first.record.id);
  });
  it("prioritizes exact questions and cancels unsent duplicate waiting alerts", () => {
    const f = fixture();
    const waiting = f.coordinator.enqueue({
      ...f.input,
      trigger: "waiting",
    }).record;
    const failure = f.ready();
    const decision = f.coordinator.enqueue({
      ...f.input,
      trigger: "decision",
      source: {
        kind: "decision",
        sessionId: "session",
        runId: "run",
        decisionId: "q",
      },
    }).record;
    expect(f.coordinator.get(waiting.id).state).toBe("canceled");
    expect(() => f.reserve(failure.id)).toThrow(/higher-priority/);
    f.coordinator.cancelDecision("wrong", "run", "q");
    expect(f.coordinator.get(decision.id).state).toBe("queued");
    f.coordinator.cancelDecision("session", "run", "q");
    expect(f.coordinator.get(decision.id).reason).toBe("decision_resolved");
    expect(f.reserve(failure.id).replayed).toBe(false);
  });
  it("reserves once before dispatch and retains a lost response through restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "proactive-"));
    dirs.push(dir);
    const path = join(dir, "state.sqlite"),
      f = fixture(path);
    const record = f.ready(),
      attempt = f.reserve(record.id);
    expect(attempt.grant).toMatchObject({
      version: 2,
      inputAllowed: false,
      packetFingerprint: fingerprint,
      viewScope: [],
    });
    expect(f.authority.get("policy")?.attempts).toBe(1);
    expect(f.reserve(record.id).replayed).toBe(true);
    f.store.close();
    const g = fixture(path);
    expect(g.coordinator.get(record.id).state).toBe("unknown");
    expect(g.reserve(record.id).replayed).toBe(true);
    const other = g.ready({
      ...g.input,
      source: { ...g.input.source, runId: "another" },
    });
    expect(() => g.reserve(other.id)).toThrow(/occupied or unresolved/);
    expect(g.authority.get("policy")?.attempts).toBe(1);
    expect(g.coordinator.cancel(record.id).state).toBe("unknown");
  });
  it("restarts preparation with fresh evidence and never calls from an old packet", () => {
    const f = fixture(),
      record = f.ready();
    const restarted = new ProactiveCallCoordinator(
      f.store,
      f.vault,
      f.authority,
      f.clock,
    );
    expect(restarted.get(record.id)).toMatchObject({
      state: "queued",
      reason: "preparation_requires_refresh",
    });
    expect(restarted.get(record.id).packetFingerprint).toBeUndefined();
    expect(() =>
      restarted.reserve(record.id, {
        sourceCurrent: true,
        lineAvailable: true,
        packetFingerprint: fingerprint,
      }),
    ).toThrow(/prepared/);
  });
  it("defers a busy incoming line without spending authority", () => {
    const f = fixture(),
      record = f.ready();
    expect(() =>
      f.coordinator.reserve(record.id, {
        sourceCurrent: true,
        lineAvailable: false,
        packetFingerprint: fingerprint,
      }),
    ).toThrow(/occupied/);
    expect(f.coordinator.get(record.id).state).toBe("ready");
    expect(f.authority.get("policy")?.attempts).toBe(0);
  });
  it("rejects changed source, wrong packet and revoked policy immediately before dispatch", () => {
    const f = fixture(),
      record = f.ready();
    expect(() =>
      f.coordinator.reserve(record.id, {
        sourceCurrent: false,
        lineAvailable: true,
        packetFingerprint: fingerprint,
      }),
    ).toThrow();
    expect(() =>
      f.coordinator.reserve(record.id, {
        sourceCurrent: true,
        lineAvailable: true,
        packetFingerprint: "ef".repeat(32),
      }),
    ).toThrow();
    f.authority.revoke("policy");
    expect(() => f.reserve(record.id)).toThrow();
    expect(f.coordinator.reconcile(record.id, { current: true }).state).toBe(
      "canceled",
    );
    expect(f.authority.get("policy")?.attempts).toBe(0);
  });
  it("refuses stale revisions without synthesizing success and retains submitted outcomes", () => {
    const f = fixture(),
      record = f.ready();
    expect(
      f.coordinator.reconcile(record.id, {
        current: false,
        reason: "result_superseded",
      }).state,
    ).toBe("canceled");
    const current = f.ready({
        ...f.input,
        source: { ...f.input.source, runId: "revision" },
      }),
      attempt = f.reserve(current.id);
    expect(f.coordinator.reconcile(current.id, { current: false }).state).toBe(
      "dispatching",
    );
    expect(
      f.coordinator.outcome(current.id, attempt.record.attemptId!, "ended")
        .state,
    ).toBe("unknown");
  });
  it("does not release the line on hangup until cleanup is confirmed", () => {
    const f = fixture(),
      record = f.ready(),
      attempt = f.reserve(record.id).record.attemptId!;
    f.coordinator.outcome(record.id, attempt, "connected");
    expect(f.coordinator.outcome(record.id, attempt, "ended").state).toBe(
      "unknown",
    );
    expect(() =>
      f.coordinator.outcome(record.id, attempt, "ended", {
        cleanupConfirmed: true,
      }),
    ).toThrow(/reconciliation/);
    expect(() =>
      f.coordinator.reconcileOutcome(record.id, {
        attemptId: "wrong",
        providerReceiptId: "ended",
        cleanupReceiptId: "drained",
        outcome: "ended",
      }),
    ).toThrow();
    expect(
      f.coordinator.reconcileOutcome(record.id, {
        attemptId: attempt,
        providerReceiptId: "ended",
        cleanupReceiptId: "drained",
        outcome: "ended",
      }).state,
    ).toBe("ended");
    expect(f.reserve(record.id).replayed).toBe(true);
  });
  it("Stop cancels only pending delivery and never approves or cancels running work", () => {
    const f = fixture(),
      record = f.ready();
    expect(f.coordinator.cancel(record.id, "stop_calling").state).toBe(
      "canceled",
    );
    expect(() => f.reserve(record.id)).toThrow();
    expect(f.coordinator.doctor().pending).toBe(0);
    expect(f.store.effects()).toHaveLength(0);
  });
  it("keeps phone content encrypted and uses only additive entities readable by the baseline store", () => {
    const f = fixture(),
      record = f.ready();
    f.reserve(record.id);
    const rows = JSON.stringify(f.store.query("SELECT * FROM entities"));
    expect(rows).not.toContain(f.input.brief);
    expect(rows).not.toContain(f.policy.consent.statement);
    expect(f.store.query("PRAGMA user_version")).toEqual([{ user_version: 1 }]);
    expect(f.store.all("coding-review-callback-v1")).toEqual([]);
  });
});

describe("versioned explicit calling policy", () => {
  it("does not upgrade legacy one-call consent or grant input from viewing", () => {
    const f = fixture();
    expect(() =>
      f.authority.register({
        ...f.policy,
        version: 1,
        userAuthorizedOneCall: true,
      } as unknown as ProactivePolicyInput),
    ).toThrow();
    const record = f.ready({ ...f.input, channel: "phone_walkthrough" }),
      grant = f.reserve(record.id).grant!;
    expect(grant.viewScope).toEqual(["presentation:fixture"]);
    expect(grant.inputAllowed).toBe(false);
    expect(f.authority.validateGrant(grant)).toBe(true);
    expect(
      f.authority.validateGrant({
        ...grant,
        packetFingerprint: "ef".repeat(32),
      }),
    ).toBe(false);
    f.authority.revoke("policy");
    expect(f.authority.validateGrant(grant)).toBe(false);
  });
  it("binds person, device, project and enrolled session", () => {
    const f = fixture();
    f.authority.register({
      ...f.policy,
      id: "scoped",
      scope: { ...f.policy.scope, sessionId: "session" },
    });
    for (const key of [
      "personId",
      "deviceId",
      "projectRoot",
      "sessionId",
    ] as const) {
      const input = {
        ...f.input,
        policyId: "scoped",
        scope: { ...f.input.scope, [key]: "wrong" },
      };
      expect(f.authority.inspect(input).reason).toBe("policy_scope_mismatch");
    }
    expect(
      f.authority.inspect({ ...f.input, policyId: "scoped" }).allowed,
    ).toBe(true);
  });
  it("does not silently downgrade a walkthrough or permit alert-only viewing", () => {
    const f = fixture();
    f.authority.register({
      ...f.policy,
      id: "alerts",
      channels: ["phone_alert"],
      viewScope: [],
    });
    expect(
      f.coordinator.enqueue({
        ...f.input,
        policyId: "alerts",
        channel: "phone_walkthrough",
      }).record,
    ).toMatchObject({ state: "refused", reason: "channel_not_authorized" });
    expect(() =>
      f.authority.register({ ...f.policy, id: "badviews", viewScope: [] }),
    ).toThrow(/view scope/);
  });
  it("enforces bounded lifetime, expiry, quiet hours and rate budgets", () => {
    const f = fixture();
    f.authority.register({
      ...f.policy,
      id: "limited",
      maxAttempts: 1,
      attemptLifetimeMs: 1000,
    });
    const first = f.ready({ ...f.input, policyId: "limited" }),
      attempt = f.reserve(first.id);
    expect(attempt.grant?.expiresAt).toBe(2000);
    f.coordinator.outcome(first.id, attempt.record.attemptId!, "ended", {
      cleanupConfirmed: true,
    });
    expect(
      f.authority.inspect({ ...f.input, policyId: "limited" }).reason,
    ).toBe("call_budget_exhausted");
    f.time(2000);
    expect(f.authority.validateGrant(attempt.grant!)).toBe(false);
    f.authority.register({
      ...f.policy,
      id: "hours",
      consent: { ...f.policy.consent, recordedAt: 2000 },
      allowedHours: { timeZone: "UTC", startHour: 9, endHour: 17 },
    });
    expect(f.authority.inspect({ ...f.input, policyId: "hours" }).reason).toBe(
      "quiet_hours",
    );
    f.time(100000);
    expect(f.authority.inspect(f.input).reason).toBe("policy_expired");
  });
  it("rejects replacing or reviving an existing policy identity", () => {
    const f = fixture();
    expect(f.authority.register(f.policy).attempts).toBe(0);
    expect(() =>
      f.authority.register({ ...f.policy, maxAttempts: 99 }),
    ).toThrow(/already exists/);
    f.authority.revoke("policy");
    expect(() => f.authority.register(f.policy)).toThrow(/already exists/);
  });
});
