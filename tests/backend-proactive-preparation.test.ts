import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProactiveCallCoordinator } from "../src/attention/proactive-coordinator.js";
import { ProactivePolicyAuthority } from "../src/attention/proactive-policy.js";
import {
  ProactivePreparationService,
  type ProactiveSourceEvidence,
  type ProactivePreparedView,
} from "../src/control/proactive-preparation.js";
import type { EnqueueCall } from "../src/attention/proactive-contracts.js";
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const fingerprint = "ab".repeat(32),
  digest = "cd".repeat(32);
function fixture(
  channel: EnqueueCall["channel"] = "phone_walkthrough",
  decision = false,
) {
  const store = new Store(),
    vault = new Vault("ef".repeat(32));
  stores.push(store);
  let now = 10000;
  const clock = () => now,
    authority = new ProactivePolicyAuthority(store, vault, clock),
    coordinator = new ProactiveCallCoordinator(store, vault, authority, clock);
  authority.register({
    version: 2,
    id: "policy",
    scope: {
      personId: "person",
      deviceId: "device",
      projectRoot: "/fixture",
      sessionId: "session",
    },
    triggers: ["decision", "review", "completion"],
    channels: ["phone_alert", "phone_walkthrough"],
    expiresAt: 1000000,
    maxAttempts: 1,
    minIntervalMs: 100000,
    attemptLifetimeMs: 10000,
    viewScope: ["fixture-view"],
    alertFallback: false,
    consent: {
      actorId: "person",
      recordedAt: now,
      source: "human_request",
      statement: "Call with the checked fixture.",
    },
  });
  const input: EnqueueCall = {
    policyId: "policy",
    source: decision
      ? {
          kind: "decision",
          sessionId: "session",
          runId: "run",
          decisionId: "question",
        }
      : {
          kind: "job",
          sessionId: "session",
          runId: "run",
          jobId: "job",
          launchId: "launch",
          resultDigest: digest,
        },
    scope: {
      personId: "person",
      deviceId: "device",
      projectRoot: "/fixture",
      sessionId: "session",
    },
    trigger: decision ? "decision" : "completion",
    channel,
    expiresAt: 1000000,
    brief: "Review this bounded fixture.",
  };
  const intent = coordinator.enqueue(input).record;
  const evidence: ProactiveSourceEvidence = {
    current: true,
    sourceFingerprint: fingerprint,
    goal: "Create fixture",
    status: decision ? "decision" : "verified",
    summary: "Fixture summary",
    ...(decision
      ? { question: "Which heading should I use?", choices: ["One", "Two"] }
      : {}),
    checks: decision
      ? []
      : [
          {
            id: "check",
            name: "Fixture check",
            status: "passed",
            resultDigest: digest,
          },
        ],
    artifacts:
      channel === "phone_walkthrough"
        ? [
            {
              id: "artifact",
              reference: "/fixture/index.html",
              digest,
              scope: "fixture-view",
            },
          ]
        : [],
    views:
      channel === "phone_walkthrough"
        ? [
            {
              id: "view",
              scope: "fixture-view",
              title: "Result",
              artifactId: "artifact",
            },
          ]
        : [],
  };
  const view: ProactivePreparedView = {
    id: "view",
    scope: "fixture-view",
    title: "Result",
    artifactId: "artifact",
    artifactDigest: digest,
    windowId: "window-7",
    frameObservedAt: now,
    sourceFingerprint: fingerprint,
  };
  const inspectSource = vi.fn(() => structuredClone(evidence));
  const resolveViews = vi.fn(async () => [structuredClone(view)]);
  const releaseViews = vi.fn(
    async (): Promise<{ confirmed: boolean; receiptId?: string }> => ({
      confirmed: true,
      receiptId: "cleanup",
    }),
  );
  const service = new ProactivePreparationService(
    store,
    vault,
    coordinator,
    { inspectSource, resolveViews, releaseViews },
    clock,
  );
  return {
    store,
    authority,
    coordinator,
    intent,
    evidence,
    view,
    inspectSource,
    resolveViews,
    releaseViews,
    service,
    time: (value: number) => {
      now = value;
    },
  };
}

describe("authorized proactive walkthrough preparation", () => {
  it("prepares bounded views then resolves read-only, including after budget-consuming reservation", async () => {
    const f = fixture(),
      packet = await f.service.prepare(f.intent.id);
    expect(packet.walkthroughOrder).toEqual(["view"]);
    expect(packet.narration).toContain("configured independent checks passed");
    expect(f.resolveViews).toHaveBeenCalledTimes(1);
    expect(await f.service.resolve(f.intent.id)).toEqual(packet);
    f.coordinator.reserve(f.intent.id, {
      sourceCurrent: true,
      lineAvailable: true,
      packetFingerprint: packet.fingerprint,
    });
    expect(await f.service.resolve(f.intent.id)).toEqual(packet);
    expect(f.resolveViews).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(f.store.query("SELECT * FROM entities")),
    ).not.toContain("Fixture summary");
  });
  it("prepares spoken alerts without opening or capturing views", async () => {
    const f = fixture("phone_alert");
    const packet = await f.service.prepare(f.intent.id);
    expect(packet.views).toEqual([]);
    expect(f.resolveViews).not.toHaveBeenCalled();
  });
  it("binds mid-run questions independently of completion and independent success", async () => {
    const f = fixture("phone_walkthrough", true);
    const packet = await f.service.prepare(f.intent.id);
    expect(packet.status).toBe("decision");
    expect(packet.source).toMatchObject({
      kind: "decision",
      decisionId: "question",
    });
    expect(packet.narration).toContain("Which heading");
    expect(packet.narration).not.toContain("passed");
    expect(packet.checks).toEqual([]);
  });
  it("invalidates changed results and resolved decisions without reusing capture", async () => {
    const f = fixture();
    await f.service.prepare(f.intent.id);
    f.evidence.sourceFingerprint = "11".repeat(32);
    expect(await f.service.resolve(f.intent.id)).toBeUndefined();
    expect(f.resolveViews).toHaveBeenCalledTimes(1);
    const g = fixture("phone_alert", true);
    await g.service.prepare(g.intent.id);
    g.evidence.current = false;
    expect(await g.service.resolve(g.intent.id)).toBeUndefined();
  });
  it("rejects source changes during effectful preparation and confirms cleanup", async () => {
    const f = fixture();
    f.resolveViews.mockImplementation(async () => {
      f.evidence.sourceFingerprint = "22".repeat(32);
      return [f.view];
    });
    await expect(f.service.prepare(f.intent.id)).rejects.toThrow(
      "source_changed_during_preparation",
    );
    expect(f.releaseViews).toHaveBeenCalledWith(f.intent.id);
    expect(f.coordinator.get(f.intent.id).state).toBe("queued");
    expect(await f.service.resolve(f.intent.id)).toBeUndefined();
  });
  it("revocation during preparation cleans up without dialing or retaining readiness", async () => {
    const f = fixture();
    f.resolveViews.mockImplementation(async () => {
      f.authority.revoke("policy");
      return [f.view];
    });
    await expect(f.service.prepare(f.intent.id)).rejects.toThrow(
      "policy_revoked",
    );
    expect(f.releaseViews).toHaveBeenCalledTimes(1);
    expect(f.coordinator.get(f.intent.id).attemptId).toBeUndefined();
  });
  it.each([
    "stale",
    "future",
    "wrong-window-scope",
    "changed-artifact",
    "wrong-source",
  ])("rejects %s frame metadata", async (problem) => {
    const f = fixture();
    if (problem === "stale") f.view.frameObservedAt = 5000;
    if (problem === "future") f.view.frameObservedAt = 10001;
    if (problem === "wrong-window-scope") f.view.scope = "another-project";
    if (problem === "changed-artifact") f.view.artifactDigest = "33".repeat(32);
    if (problem === "wrong-source") f.view.sourceFingerprint = "44".repeat(32);
    await expect(f.service.prepare(f.intent.id)).rejects.toThrow();
    expect(f.releaseViews).toHaveBeenCalledTimes(1);
    expect(f.coordinator.get(f.intent.id).state).toBe("queued");
  });
  it("refuses duplicate windows and unauthorized artifact references", async () => {
    const f = fixture();
    f.evidence.views.push({ ...f.evidence.views[0]!, id: "view2" });
    f.resolveViews.mockImplementation(async () => [
      f.view,
      { ...f.view, id: "view2" },
    ]);
    await expect(f.service.prepare(f.intent.id)).rejects.toThrow(
      "exact_views_required",
    );
    const g = fixture();
    g.evidence.artifacts[0]!.scope = "foreign";
    await expect(g.service.prepare(g.intent.id)).rejects.toThrow(
      "artifact_outside_view_scope",
    );
    expect(g.resolveViews).not.toHaveBeenCalled();
  });
  it("keeps unknown capture cleanup fenced until exact reviewed reconciliation", async () => {
    const f = fixture();
    f.view.frameObservedAt = 0;
    f.releaseViews.mockResolvedValue({ confirmed: false });
    await expect(f.service.prepare(f.intent.id)).rejects.toThrow(
      "capture_cleanup_unknown",
    );
    expect(f.coordinator.get(f.intent.id).state).toBe("unknown");
    expect(f.coordinator.doctor().unknown).toHaveLength(1);
    expect(f.coordinator.cancel(f.intent.id).state).toBe("unknown");
    expect(
      f.coordinator.reconcilePreparation(f.intent.id, "drain-confirmed").state,
    ).toBe("canceled");
  });
  it("does not treat an unverified answer file or failed check as successful", async () => {
    const f = fixture();
    f.evidence.checks = [];
    await expect(f.service.prepare(f.intent.id)).rejects.toThrow(
      "independent_verification_required",
    );
    const g = fixture();
    g.evidence.status = "unverified";
    await expect(g.service.prepare(g.intent.id)).rejects.toThrow(
      "result_not_verified",
    );
    const h = fixture("phone_alert");
    h.evidence.status = "unverified";
    h.evidence.checks = [];
    expect((await h.service.prepare(h.intent.id)).narration).toContain(
      "not been independently verified",
    );
  });
  it("retains call narration after initial frame expiry without claiming fresh views", async () => {
    const f = fixture(),
      packet = await f.service.prepare(f.intent.id);
    const { grant } = f.coordinator.reserve(f.intent.id, {
      sourceCurrent: true,
      lineAvailable: true,
      packetFingerprint: packet.fingerprint,
    });
    f.time(15000);
    expect(await f.service.resolve(f.intent.id)).toBeUndefined();
    const metadata = await f.service.resolveForCall(f.intent.id, grant!);
    expect(metadata?.narration).toBe(packet.narration);
    expect(metadata).not.toHaveProperty("views");
    expect(metadata).not.toHaveProperty("walkthroughOrder");
    f.evidence.sourceFingerprint = "99".repeat(32);
    expect(await f.service.resolveForCall(f.intent.id, grant!)).toBeUndefined();
    f.evidence.sourceFingerprint = fingerprint;
    f.authority.revoke("policy");
    expect(await f.service.resolveForCall(f.intent.id, grant!)).toBeUndefined();
  });
  it("expires frames in the read-only resolver instead of silently recapturing", async () => {
    const f = fixture();
    await f.service.prepare(f.intent.id);
    f.time(15000);
    expect(await f.service.resolve(f.intent.id)).toBeUndefined();
    expect(f.resolveViews).toHaveBeenCalledTimes(1);
  });
});
