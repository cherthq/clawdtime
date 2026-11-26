import { z } from "zod";
import { DomainError, hash, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import type {
  ProactiveCallIntent,
  CallSource,
  CallAttemptGrant,
} from "../attention/proactive-contracts.js";
import type { ProactivePolicy } from "../attention/proactive-policy.js";
import { ProactiveCallCoordinator } from "../attention/proactive-coordinator.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().trim().min(1).max(2000);
const viewRequestSchema = z
  .object({
    id: bounded,
    scope: bounded,
    title: bounded,
    artifactId: bounded.optional(),
  })
  .strict();
const evidenceSchema = z
  .object({
    current: z.boolean(),
    sourceFingerprint: digest,
    goal: bounded,
    status: z.enum(["decision", "failed", "verified", "unverified"]),
    summary: bounded,
    question: bounded.optional(),
    choices: z.array(bounded).max(8).optional(),
    checks: z
      .array(
        z
          .object({
            id: bounded,
            name: bounded,
            status: z.enum(["passed", "failed", "unknown"]),
            resultDigest: digest,
          })
          .strict(),
      )
      .max(32),
    artifacts: z
      .array(
        z
          .object({ id: bounded, reference: bounded, digest, scope: bounded })
          .strict(),
      )
      .max(32),
    views: z.array(viewRequestSchema).max(16),
  })
  .strict();
export type ProactiveSourceEvidence = z.infer<typeof evidenceSchema>;
export type ProactiveViewRequest = z.infer<typeof viewRequestSchema>;
const viewSchema = z
  .object({
    id: bounded,
    scope: bounded,
    windowId: bounded.optional(),
    displayId: bounded.optional(),
    title: bounded,
    sourceFingerprint: digest,
    frameObservedAt: z.number().finite().nonnegative(),
    artifactId: bounded.optional(),
    artifactDigest: digest.optional(),
  })
  .strict()
  .refine(
    (view) => (view.windowId !== undefined) !== (view.displayId !== undefined),
    "One exact window or display is required.",
  )
  .refine(
    (view) =>
      (view.scope === "selected-display") === (view.displayId !== undefined),
    "Selected-display scope requires an exact display identity.",
  );
export type ProactivePreparedView = z.infer<typeof viewSchema>;
export interface ProactiveReviewPacket {
  id: string;
  version: 1;
  intentId: string;
  source: CallSource;
  sourceFingerprint: string;
  policyId: string;
  policyRevision: number;
  channel: ProactiveCallIntent["channel"];
  goal: string;
  status: ProactiveSourceEvidence["status"];
  summary: string;
  question?: string;
  choices: string[];
  checks: ProactiveSourceEvidence["checks"];
  artifacts: ProactiveSourceEvidence["artifacts"];
  narration: string;
  views: ProactivePreparedView[];
  walkthroughOrder: string[];
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
}
export interface ProactivePreparationPorts {
  /** Read-only adapter uses authoritative receipts/checks, never process absence or model claims. */
  inspectSource(
    intent: ProactiveCallIntent,
  ): Promise<ProactiveSourceEvidence> | ProactiveSourceEvidence;
  /** Existing presentation/capture owner must enforce exclusive execution, local Stop,
   * exact window authority and transient pixels. This method may open/capture views. */
  resolveViews(input: {
    intent: ProactiveCallIntent;
    policy: ProactivePolicy;
    requests: ProactiveViewRequest[];
    sourceFingerprint: string;
  }): Promise<ProactivePreparedView[]>;
  /** Always reconciles capture after failed/stale preparation; false retains owner uncertainty. */
  releaseViews(
    intentId: string,
  ): Promise<{ confirmed: boolean; receiptId?: string }>;
}

/** Effectful preparation and read-only packet resolution are intentionally separate.
 * Only bounded metadata is durable; neither screens nor audio are persisted. */
export class ProactivePreparationService {
  private packets: ProtectedTaskStore<ProactiveReviewPacket>;
  private preparing = new Set<string>();
  constructor(
    store: Store,
    vault: Vault,
    private readonly coordinator: ProactiveCallCoordinator,
    private readonly ports: ProactivePreparationPorts,
    private readonly clock: () => number = Date.now,
    private readonly maxFrameAgeMs = 5000,
  ) {
    if (maxFrameAgeMs < 1 || maxFrameAgeMs > 10000)
      throw new Error("Frame freshness bound must be at most ten seconds.");
    this.packets = new ProtectedTaskStore(
      store,
      vault,
      "proactive-review-packet-v1",
    );
  }
  async prepare(intentId: string): Promise<ProactiveReviewPacket> {
    if (this.preparing.has(intentId))
      throw new DomainError(409, "Walkthrough preparation is already running.");
    this.preparing.add(intentId);
    let touchedViews = false;
    try {
      const intent = this.coordinator.prepare(intentId),
        policy = this.policy(intent);
      const evidence = evidenceSchema.parse(
        await this.ports.inspectSource(intent),
      );
      this.validateEvidence(intent, evidence, policy);
      let views: ProactivePreparedView[] = [];
      if (intent.channel === "phone_walkthrough") {
        if (!evidence.views.length)
          throw new DomainError(409, "walkthrough_views_missing");
        touchedViews = true;
        views = z
          .array(viewSchema)
          .max(16)
          .parse(
            await this.ports.resolveViews({
              intent,
              policy,
              requests: evidence.views,
              sourceFingerprint: evidence.sourceFingerprint,
            }),
          );
        this.validateViews(evidence, views, policy);
      }
      const latest = evidenceSchema.parse(
        await this.ports.inspectSource(intent),
      );
      this.validateEvidence(intent, latest, this.policy(intent));
      if (JSON.stringify(latest) !== JSON.stringify(evidence))
        throw new DomainError(409, "source_changed_during_preparation");
      if (this.policy(intent).revision !== policy.revision)
        throw new DomainError(409, "policy_changed_during_preparation");
      if (intent.channel === "phone_walkthrough")
        this.validateViews(latest, views, policy);
      const now = this.clock();
      const narration =
        evidence.status === "verified"
          ? `The configured independent checks passed. ${evidence.summary}`
          : evidence.status === "decision"
            ? `Your input is needed. ${evidence.question}`
            : evidence.status === "failed"
              ? `Work needs attention. ${evidence.summary}`
              : `This result has not been independently verified. ${evidence.summary}`;
      const body: Omit<ProactiveReviewPacket, "fingerprint"> = {
        id: intent.id,
        version: 1,
        intentId: intent.id,
        source: intent.source,
        sourceFingerprint: evidence.sourceFingerprint,
        policyId: policy.id,
        policyRevision: policy.revision,
        channel: intent.channel,
        goal: evidence.goal,
        status: evidence.status,
        summary: evidence.summary,
        ...(evidence.question ? { question: evidence.question } : {}),
        choices: evidence.choices ?? [],
        checks: evidence.checks,
        artifacts: evidence.artifacts,
        narration,
        views,
        walkthroughOrder: views.map((view) => view.id),
        createdAt: now,
        expiresAt: Math.min(
          intent.expiresAt,
          policy.expiresAt,
          now + 30000,
          ...views.map((view) => view.frameObservedAt + this.maxFrameAgeMs),
        ),
      };
      const packet = this.packets.put({
        ...body,
        fingerprint: hash(JSON.stringify(body)),
      });
      this.coordinator.ready(intent.id, packet.fingerprint);
      return packet;
    } catch (error) {
      let reason =
        error instanceof DomainError && /^[a-z_]{1,100}$/.test(error.message)
          ? error.message
          : "preparation_failed";
      if (touchedViews) {
        try {
          if (!(await this.ports.releaseViews(intentId)).confirmed)
            reason = "capture_cleanup_unknown";
        } catch {
          reason = "capture_cleanup_unknown";
        }
      }
      if (reason === "capture_cleanup_unknown")
        this.coordinator.preparationUnknown(intentId);
      else this.coordinator.block(intentId, reason);
      throw new DomainError(409, reason);
    } finally {
      this.preparing.delete(intentId);
    }
  }
  /** Protected in-process metadata access for the native admission validator.
   * This alone makes no current-frame or source-readiness assertion. */
  packetSnapshot(intentId: string) {
    return this.packets.get(intentId);
  }
  /** Read-only resolver: no capture, spawning, authority minting or dialing. Can be
   * called repeatedly by delivery; stale packets return no envelope. */
  async resolve(intentId: string): Promise<ProactiveReviewPacket | undefined> {
    const packet = this.packets.get(intentId),
      intent = this.coordinator.get(intentId);
    if (
      !packet ||
      !["ready", "dispatching", "connected"].includes(intent.state) ||
      packet.fingerprint !== intent.packetFingerprint ||
      packet.expiresAt <= this.clock()
    )
      return undefined;
    try {
      const policy = this.policy(intent, true),
        evidence = evidenceSchema.parse(await this.ports.inspectSource(intent));
      if (
        policy.revision !== packet.policyRevision ||
        evidence.sourceFingerprint !== packet.sourceFingerprint ||
        JSON.stringify(intent.source) !== JSON.stringify(packet.source)
      )
        return undefined;
      this.validateEvidence(intent, evidence, policy);
      if (packet.channel === "phone_walkthrough")
        this.validateViews(evidence, packet.views, policy);
      return packet;
    } catch {
      return undefined;
    }
  }
  /** Call-time narration remains available for the bounded attempt after its
   * initial frames expire. This returns no frame/window readiness claim: the
   * active presentation runtime owns ongoing freshness and local Stop. */
  async resolveForCall(
    intentId: string,
    grant: CallAttemptGrant,
  ): Promise<
    | (Omit<
        ProactiveReviewPacket,
        "views" | "walkthroughOrder" | "expiresAt"
      > & { authorizedUntil: number })
    | undefined
  > {
    const packet = this.packets.get(intentId),
      intent = this.coordinator.get(intentId);
    if (
      !packet ||
      !["dispatching", "connected"].includes(intent.state) ||
      intent.grantId !== grant.id ||
      grant.intentId !== intent.id ||
      intent.attemptId !== grant.attemptId ||
      grant.packetFingerprint !== packet.fingerprint ||
      !this.coordinator.authority.validateGrant(grant)
    )
      return undefined;
    try {
      const evidence = evidenceSchema.parse(
        await this.ports.inspectSource(intent),
      );
      const policy = this.coordinator.authority.get(grant.policyId);
      if (
        !policy ||
        !this.coordinator.authority.validateGrant(grant) ||
        evidence.sourceFingerprint !== packet.sourceFingerprint ||
        JSON.stringify(intent.source) !== JSON.stringify(packet.source)
      )
        return undefined;
      this.validateEvidence(intent, evidence, policy);
      const {
        views: _views,
        walkthroughOrder: _order,
        expiresAt: _expiry,
        ...metadata
      } = packet;
      return { ...metadata, authorizedUntil: grant.expiresAt };
    } catch {
      return undefined;
    }
  }
  private policy(intent: ProactiveCallIntent, ignoreBudget = false) {
    const inspection = this.coordinator.authority.inspect(intent, {
      ignoreBudget,
    });
    if (!inspection.allowed || !inspection.policy)
      throw new DomainError(403, inspection.reason ?? "policy_denied");
    return inspection.policy;
  }
  private validateEvidence(
    intent: ProactiveCallIntent,
    evidence: ProactiveSourceEvidence,
    policy: ProactivePolicy,
  ) {
    if (!evidence.current)
      throw new DomainError(409, "source_no_longer_current");
    if (intent.trigger === "decision" || intent.source.decisionId) {
      if (
        evidence.status !== "decision" ||
        !evidence.question ||
        !intent.source.decisionId
      )
        throw new DomainError(409, "decision_binding_required");
    } else if (evidence.status === "decision")
      throw new DomainError(409, "decision_binding_required");
    if (
      evidence.status === "verified" &&
      (!evidence.checks.length ||
        evidence.checks.some((check) => check.status !== "passed"))
    )
      throw new DomainError(409, "independent_verification_required");
    if (
      intent.channel === "phone_walkthrough" &&
      evidence.status === "unverified"
    )
      throw new DomainError(409, "result_not_verified");
    for (const artifact of evidence.artifacts)
      if (!policy.viewScope.includes(artifact.scope))
        throw new DomainError(403, "artifact_outside_view_scope");
    for (const view of evidence.views) {
      if (!policy.viewScope.includes(view.scope))
        throw new DomainError(403, "view_outside_policy_scope");
      if (
        view.artifactId &&
        !evidence.artifacts.some(
          (artifact) =>
            artifact.id === view.artifactId && artifact.scope === view.scope,
        )
      )
        throw new DomainError(403, "view_artifact_binding_missing");
    }
    if (
      new Set(evidence.views.map((v) => v.id)).size !== evidence.views.length ||
      new Set(evidence.artifacts.map((v) => v.id)).size !==
        evidence.artifacts.length
    )
      throw new DomainError(409, "duplicate_preparation_identity");
  }
  private validateViews(
    evidence: ProactiveSourceEvidence,
    views: ProactivePreparedView[],
    policy: ProactivePolicy,
  ) {
    if (
      views.length !== evidence.views.length ||
      new Set(
        views.map((view) =>
          view.displayId
            ? `display:${view.displayId}`
            : `window:${view.windowId}`,
        ),
      ).size !== views.length ||
      new Set(views.map((view) => view.id)).size !== views.length
    )
      throw new DomainError(409, "exact_views_required");
    for (let index = 0; index < evidence.views.length; index++) {
      const requested = evidence.views[index]!,
        view = views[index]!;
      if (
        view.id !== requested.id ||
        view.scope !== requested.scope ||
        view.artifactId !== requested.artifactId ||
        !policy.viewScope.includes(view.scope) ||
        view.sourceFingerprint !== evidence.sourceFingerprint
      )
        throw new DomainError(409, "view_binding_mismatch");
      if (
        view.frameObservedAt > this.clock() ||
        this.clock() - view.frameObservedAt >= this.maxFrameAgeMs
      )
        throw new DomainError(409, "view_frame_stale");
      if (
        view.artifactId &&
        view.artifactDigest !==
          evidence.artifacts.find((artifact) => artifact.id === view.artifactId)
            ?.digest
      )
        throw new DomainError(409, "artifact_digest_changed");
    }
  }
}
