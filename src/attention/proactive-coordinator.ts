import { ProactiveTransportLedger } from "./proactive-transport-ledger.js";
import { DomainError, hash, id, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import {
  enqueueCallSchema,
  type CallSource,
  type EnqueueCall,
  type ProactiveCallIntent,
  type ProactiveCallState,
} from "./proactive-contracts.js";
import { ProactivePolicyAuthority } from "./proactive-policy.js";

const unsent = new Set<ProactiveCallState>(["queued", "preparing", "ready"]);
const occupied = new Set<ProactiveCallState>([
  "dispatching",
  "connected",
  "unknown",
]);
const priority = {
  decision: 0,
  waiting: 1,
  failure: 2,
  review: 3,
  completion: 3,
};
/** Every adapter must retain the same exact enrolled session/run and decision/result
 * identity. Adapter names and watch IDs never create a second physical call. */
export function proactiveSubjectKey(input: EnqueueCall) {
  const { source, scope, trigger } = input;
  const result =
    source.kind === "task"
      ? ["task-result", source.taskId, source.revision, source.verificationId]
      : "resultDigest" in source && source.resultDigest
        ? ["result", source.resultDigest]
        : [trigger === "review" ? "completion" : trigger];
  return hash(
    JSON.stringify([
      scope.personId,
      scope.deviceId,
      scope.projectRoot,
      source.sessionId,
      source.runId,
      source.decisionId ? ["decision", source.decisionId] : result,
    ]),
  );
}
function sameRun(a: ProactiveCallIntent, b: EnqueueCall) {
  return (
    a.scope.personId === b.scope.personId &&
    a.scope.deviceId === b.scope.deviceId &&
    a.scope.projectRoot === b.scope.projectRoot &&
    a.source.sessionId === b.source.sessionId &&
    a.source.runId === b.source.runId
  );
}

/** One service owns this coordinator and all adapters use it. No provider effects
 * occur here. Records are encrypted additive entities understood by the old Store. */
export class ProactiveCallCoordinator {
  private records: ProtectedTaskStore<ProactiveCallIntent>;
  readonly transport: ProactiveTransportLedger;
  constructor(
    private readonly store: Store,
    vault: Vault,
    readonly authority: ProactivePolicyAuthority,
    private readonly clock: () => number = Date.now,
  ) {
    this.transport = new ProactiveTransportLedger(store, vault, clock);
    this.records = new ProtectedTaskStore(
      store,
      vault,
      "proactive-call-intent-v1",
    );
    this.store.transaction(() => {
      for (const record of this.records.all()) {
        if (record.state === "dispatching" || record.state === "connected")
          this.move(record, "unknown", "restart_during_delivery");
        // Preparation may open/capture views: restart requires fresh preparation,
        // never reuse a stored claim that the old frame is still current.
        else if (record.state === "preparing" || record.state === "ready") {
          delete record.packetFingerprint;
          this.move(record, "queued", "preparation_requires_refresh");
        }
      }
    });
  }
  enqueue(input: EnqueueCall) {
    const value = enqueueCallSchema.parse(input);
    if (
      value.source.sessionId !== value.scope.sessionId ||
      (value.source.kind === "task" &&
        value.source.taskId !== value.scope.taskId)
    )
      throw new DomainError(400, "Call source and scope differ.");
    if (value.trigger === "decision" && !value.source.decisionId)
      throw new DomainError(
        400,
        "A question requires its exact decision identity.",
      );
    return this.store.transaction(() => {
      const key = proactiveSubjectKey(value),
        prior = this.records.get(key);
      if (prior) {
        if (
          prior.channel !== value.channel ||
          prior.policyId !== value.policyId
        )
          throw new DomainError(
            409,
            "Existing phone intent has a different channel or policy; do not duplicate it.",
          );
        if (
          !prior.observations.some(
            (source) => JSON.stringify(source) === JSON.stringify(value.source),
          )
        ) {
          if (prior.observations.length >= 32)
            throw new DomainError(409, "Call observation limit reached.");
          prior.observations.push(value.source);
          this.records.put(prior);
        }
        return { record: this.get(key), replayed: true };
      }
      const now = this.clock();
      const record: ProactiveCallIntent = {
        ...value,
        id: key,
        version: 1,
        observations: [value.source],
        state: "queued",
        createdAt: now,
        updatedAt: now,
        history: [{ state: "queued", at: now }],
      };
      this.records.put(record);
      const policy = this.authority.inspect(record);
      if (value.expiresAt <= now)
        this.move(record, "expired", "intent_expired");
      else if (
        !policy.allowed &&
        !["quiet_hours", "call_rate_limited"].includes(policy.reason ?? "")
      )
        this.move(record, "refused", policy.reason);
      else if (!policy.allowed) this.move(record, "queued", policy.reason);
      if (record.trigger === "decision" && unsent.has(record.state)) {
        for (const other of this.records.all())
          if (
            other.id !== record.id &&
            other.trigger === "waiting" &&
            sameRun(other, value) &&
            unsent.has(other.state)
          )
            this.move(other, "canceled", "exact_decision_takes_precedence");
      } else if (
        record.trigger === "waiting" &&
        unsent.has(record.state) &&
        this.records
          .all()
          .some(
            (other) =>
              other.trigger === "decision" &&
              sameRun(other, value) &&
              (unsent.has(other.state) ||
                occupied.has(other.state) ||
                other.state === "ended"),
          )
      )
        this.move(record, "canceled", "exact_decision_takes_precedence");
      return { record: this.get(key), replayed: false };
    });
  }
  get(intentId: string) {
    const record = this.records.get(intentId);
    if (!record) throw new DomainError(404, "Phone intent is unavailable.");
    return record;
  }
  /** Operator-authorized recovery after corrected verification, never an automatic
   * retry. Preserve the failed intent and all grants/effects. A dial reservation,
   * even without a response, makes this recovery ineligible. */
  recoverUndialedReview(
    intentId: string,
    input: { verificationId: string; brief: string },
  ) {
    return this.store.transaction(() => {
      const prior = this.get(intentId);
      if (
        prior.state !== "refused" ||
        prior.source.kind !== "job" ||
        !prior.source.resultDigest ||
        !prior.attemptId ||
        prior.source.verificationId === input.verificationId
      )
        throw new DomainError(
          409,
          "An undialed refused job review is required.",
        );
      const effects = this.transport.list(prior.attemptId);
      if (
        !effects.length ||
        effects.some(
          (effect) => effect.state !== "done" || effect.effect === "dial",
        ) ||
        !effects.some((effect) => effect.effect === "restore") ||
        !effects.some((effect) => effect.effect === "views_close") ||
        !effects.some((effect) => effect.effect === "session_release")
      )
        throw new DomainError(
          409,
          "No dial and confirmed cleanup are required.",
        );
      const value = enqueueCallSchema.parse({
        source: { ...prior.source, verificationId: input.verificationId },
        scope: prior.scope,
        policyId: prior.policyId,
        channel: prior.channel,
        trigger: "review",
        brief: input.brief,
        expiresAt: prior.expiresAt,
      });
      const key = hash(
        JSON.stringify([
          "undialed-review-recovery",
          prior.id,
          input.verificationId,
        ]),
      );
      const existing = this.records.get(key);
      if (existing) return existing;
      if (
        this.records
          .all()
          .some(
            (other) =>
              other.id !== prior.id &&
              (occupied.has(other.state) ||
                (sameRun(other, value) &&
                  proactiveSubjectKey(other) === proactiveSubjectKey(value))),
          )
      )
        throw new DomainError(
          409,
          "Another call or recovery already owns this result.",
        );
      const policy = this.authority.inspect(value);
      if (!policy.allowed)
        throw new DomainError(403, policy.reason ?? "Calling policy denied.");
      const now = this.clock();
      const reason = `undialed_recovery:${prior.id}`;
      return this.records.put({
        ...value,
        id: key,
        version: 1,
        observations: [value.source],
        state: "queued",
        createdAt: now,
        updatedAt: now,
        reason,
        history: [{ state: "queued", at: now, reason }],
      });
    });
  }
  list() {
    return this.records
      .all()
      .sort(
        (a, b) =>
          priority[a.trigger] - priority[b.trigger] ||
          a.createdAt - b.createdAt,
      );
  }
  /** Revalidation is supplied by the exact source adapter. No PID/idle inference belongs here. */
  reconcile(intentId: string, source: { current: boolean; reason?: string }) {
    return this.store.transaction(() => {
      const record = this.get(intentId);
      if (!unsent.has(record.state)) return record;
      if (!source.current)
        return this.move(
          record,
          "canceled",
          source.reason ?? "source_no_longer_current",
        );
      if (record.expiresAt <= this.clock())
        return this.move(record, "expired", "intent_expired");
      const policy = this.authority.inspect(record);
      if (
        !policy.allowed &&
        !["quiet_hours", "call_rate_limited"].includes(policy.reason ?? "")
      )
        return this.move(
          record,
          policy.reason === "policy_expired" ? "expired" : "canceled",
          policy.reason,
        );
      return record;
    });
  }
  prepare(intentId: string) {
    return this.store.transaction(() => {
      const record = this.reconcile(intentId, { current: true });
      if (!unsent.has(record.state))
        throw new DomainError(409, "Phone intent is no longer pending.");
      const policy = this.authority.inspect(record);
      if (!policy.allowed)
        throw new DomainError(403, policy.reason ?? "Calling policy denied.");
      delete record.packetFingerprint;
      return this.move(record, "preparing");
    });
  }
  ready(intentId: string, packetFingerprint: string) {
    if (!/^[a-f0-9]{64}$/.test(packetFingerprint))
      throw new DomainError(
        400,
        "Preparation requires an exact packet fingerprint.",
      );
    return this.store.transaction(() => {
      const record = this.reconcile(intentId, { current: true });
      if (record.state !== "preparing" && record.state !== "ready")
        throw new DomainError(409, "Phone intent is not preparing.");
      if (
        record.packetFingerprint &&
        record.packetFingerprint !== packetFingerprint
      )
        throw new DomainError(
          409,
          "Prepared packet changed; invalidate before preparing again.",
        );
      record.packetFingerprint = packetFingerprint;
      return this.move(record, "ready");
    });
  }
  block(intentId: string, reason: string) {
    if (!/^[a-zA-Z0-9_:-]{1,200}$/.test(reason))
      throw new DomainError(400, "Invalid phone blocker code.");
    return this.store.transaction(() => {
      const record = this.get(intentId);
      if (!unsent.has(record.state)) return record;
      delete record.packetFingerprint;
      return this.move(record, "queued", reason);
    });
  }
  /** The last source/line check must occur immediately before this synchronous call.
   * Returned replayed grants MUST NOT be submitted again. */
  reserve(
    intentId: string,
    input: {
      sourceCurrent: boolean;
      lineAvailable: boolean;
      packetFingerprint: string;
      attemptId?: string;
    },
  ) {
    return this.store.transaction(() => {
      let record = this.get(intentId);
      if (record.attemptId)
        return {
          record,
          grant: record.grantId
            ? this.authority.grant(record.grantId)
            : undefined,
          replayed: true,
        };
      record = this.reconcile(intentId, { current: input.sourceCurrent });
      if (
        record.state !== "ready" ||
        record.packetFingerprint !== input.packetFingerprint
      )
        throw new DomainError(409, "Current prepared phone intent required.");
      if (
        !input.lineAvailable ||
        this.records.all().some((other) => occupied.has(other.state))
      )
        throw new DomainError(409, "Phone line is occupied or unresolved.");
      if (
        this.list().some(
          (other) =>
            other.id !== record.id &&
            unsent.has(other.state) &&
            priority[other.trigger] < priority[record.trigger],
        )
      )
        throw new DomainError(
          409,
          "A higher-priority human decision is pending.",
        );
      const attemptId = input.attemptId ?? id("callattempt");
      if (!/^[a-zA-Z0-9_:-]{1,200}$/.test(attemptId))
        throw new DomainError(400, "Invalid phone attempt identity.");
      const grant = this.authority.issueAttempt({
        ...record,
        intentId: record.id,
        attemptId,
        packetFingerprint: input.packetFingerprint,
      });
      record.attemptId = attemptId;
      record.grantId = grant.id;
      return {
        record: this.move(record, "dispatching"),
        grant,
        replayed: false,
      };
    });
  }
  outcome(
    intentId: string,
    attemptId: string,
    state: "connected" | "ended" | "refused" | "unknown",
    options: { cleanupConfirmed?: boolean; reason?: string } = {},
  ) {
    return this.store.transaction(() => {
      const record = this.get(intentId);
      if (record.attemptId !== attemptId)
        throw new DomainError(409, "Phone outcome belongs to another attempt.");
      if (record.state === state) return record;
      if (!occupied.has(record.state) || record.state === "unknown")
        throw new DomainError(
          409,
          "Settled or unknown phone outcome requires explicit reconciliation.",
        );
      if (
        (state === "ended" || state === "refused") &&
        !options.cleanupConfirmed
      )
        return this.move(record, "unknown", "cleanup_unconfirmed");
      return this.move(record, state, options.reason);
    });
  }
  /** Only authoritative provider/capture receipts resolve uncertainty. This never
   * returns a record to the queue or permits a second attempt. */
  reconcileOutcome(
    intentId: string,
    input: {
      attemptId: string;
      providerReceiptId: string;
      cleanupReceiptId: string;
      outcome: "ended" | "refused";
    },
  ) {
    return this.store.transaction(() => {
      const record = this.get(intentId);
      if (
        record.state !== "unknown" ||
        record.attemptId !== input.attemptId ||
        !input.providerReceiptId.trim() ||
        !input.cleanupReceiptId.trim()
      )
        throw new DomainError(
          409,
          "Exact provider and cleanup receipts are required to reconcile this attempt.",
        );
      const proof = hash(
        JSON.stringify([input.providerReceiptId, input.cleanupReceiptId]),
      );
      return this.move(record, input.outcome, `reconciled:${proof}`);
    });
  }
  cancel(intentId: string, reason = "human_canceled") {
    return this.store.transaction(() => {
      const record = this.get(intentId);
      return unsent.has(record.state)
        ? this.move(record, "canceled", reason)
        : record;
    });
  }
  cancelDecision(sessionId: string, runId: string, decisionId: string) {
    return this.store.transaction(() =>
      this.list()
        .filter(
          (record) =>
            record.source.sessionId === sessionId &&
            record.source.runId === runId &&
            record.source.decisionId === decisionId,
        )
        .map((record) => this.cancel(record.id, "decision_resolved")),
    );
  }
  preparationUnknown(intentId: string) {
    return this.store.transaction(() => {
      const record = this.get(intentId);
      if (record.attemptId || occupied.has(record.state)) return record;
      return this.move(record, "unknown", "capture_cleanup_unknown");
    });
  }
  reconcilePreparation(intentId: string, cleanupReceiptId: string) {
    return this.store.transaction(() => {
      const record = this.get(intentId);
      if (
        record.state !== "unknown" ||
        record.attemptId ||
        record.reason !== "capture_cleanup_unknown" ||
        !cleanupReceiptId.trim()
      )
        throw new DomainError(
          409,
          "Exact preparation cleanup receipt required.",
        );
      return this.move(
        record,
        "canceled",
        `cleanup_reconciled:${hash(cleanupReceiptId)}`,
      );
    });
  }
  doctor() {
    const records = this.list();
    return {
      pending: records.filter((r) => unsent.has(r.state)).length,
      active: records.filter(
        (r) => r.state === "dispatching" || r.state === "connected",
      ).length,
      unknown: records
        .filter((r) => r.state === "unknown")
        .map((r) => ({
          intentId: r.id,
          attemptId: r.attemptId,
          reason: r.reason,
        })),
      blockers: records
        .filter((r) => unsent.has(r.state))
        .map((r) => ({
          intentId: r.id,
          state: r.state,
          channel: r.channel,
          reason: this.authority.inspect(r).reason ?? r.reason,
        })),
    };
  }
  private move(
    record: ProactiveCallIntent,
    state: ProactiveCallState,
    reason?: string,
  ) {
    if (record.state === state && record.reason === reason)
      return this.records.put(record);
    record.state = state;
    record.updatedAt = this.clock();
    if (reason) record.reason = reason;
    else delete record.reason;
    record.history.push({
      state,
      at: record.updatedAt,
      ...(reason ? { reason } : {}),
    });
    return this.records.put(record);
  }
}
