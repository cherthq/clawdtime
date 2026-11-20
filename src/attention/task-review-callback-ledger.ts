import type { CodingTask } from "../contracts.js";
import { DomainError, hash, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { buildTaskBrief, type TaskLedger } from "./task-ledger.js";

export type TaskReviewCallbackState =
  | "preparing"
  | "awaiting_call"
  | "dispatching"
  | "in_review"
  | "delivered"
  | "blocked"
  | "failed"
  | "canceled"
  | "unknown";
export interface TaskReviewCallbackRecord {
  id: string;
  sessionId: string;
  taskId: string;
  runId: string;
  verificationId: string;
  reviewRevision: number;
  kind: "review" | "decision";
  goal: string;
  /** Exact human instructions retain constraints introduced in earlier revisions. */
  humanInstructions?: string[];
  opening: string;
  state: TaskReviewCallbackState;
  manifestFingerprint?: string;
  attemptId?: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  history: Array<{
    state: TaskReviewCallbackState;
    at: number;
    reason?: string;
  }>;
}
const pending = new Set<TaskReviewCallbackState>([
  "preparing",
  "awaiting_call",
  "blocked",
]);
const inFlight = new Set<TaskReviewCallbackState>(["dispatching", "in_review"]);
const token = (value: string) => {
  if (!/^[a-zA-Z0-9_:-]{1,200}$/.test(value))
    throw new DomainError(400, "Invalid callback identity or reason code.");
  return value;
};

/** Durable supervisor intent, not a dialing capability. Existing call receipts own effects. */
export class TaskReviewCallbackLedger {
  private records: ProtectedTaskStore<TaskReviewCallbackRecord>;
  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly tasks: TaskLedger,
    private readonly clock: () => number = Date.now,
  ) {
    this.records = new ProtectedTaskStore(
      store,
      vault,
      "coding-review-callback-v1",
    );
    store.transaction(() => {
      for (const record of this.records.all()) {
        if (inFlight.has(record.state))
          this.move(record, "unknown", "restart_during_delivery");
      }
    });
  }

  schedule(sessionId: string, taskId: string) {
    return this.store.transaction(() => {
      const task = this.tasks.get(sessionId, taskId);
      const run = task.runs.at(-1);
      if (
        !run ||
        run.cancelRequested ||
        !["review_ready", "needs_decision"].includes(task.state) ||
        !["completed", "blocked", "failed"].includes(run.state) ||
        !task.verification ||
        task.verification.runId !== run.id ||
        task.verification.state === "unknown" ||
        task.calls.some((call) => call.state === "unknown")
      )
        throw new DomainError(
          409,
          "Callback requires a current known independently checked result.",
        );
      const brief = buildTaskBrief(task);
      const id = hash(
        JSON.stringify([sessionId, taskId, run.id, task.verification.id]),
      );
      const prior = this.records.get(id);
      if (prior) return { record: prior, replayed: true };
      this.reconcile(sessionId, taskId);
      const now = this.clock();
      const record: TaskReviewCallbackRecord = {
        id,
        sessionId,
        taskId,
        runId: run.id,
        verificationId: task.verification.id,
        reviewRevision: task.revision,
        kind: brief.kind,
        goal: task.goal,
        humanInstructions: task.runs.map((prior) => prior.instruction),
        opening: brief.opening,
        state: "preparing",
        createdAt: now,
        updatedAt: now,
        history: [{ state: "preparing", at: now }],
      };
      return { record: this.records.put(record), replayed: false };
    });
  }

  get(sessionId: string, id: string) {
    const record = this.records.get(id);
    if (!record || record.sessionId !== sessionId)
      throw new DomainError(404, "Callback is unavailable in this session.");
    return record;
  }

  list(sessionId: string, taskId?: string) {
    return this.records
      .all()
      .filter(
        (record) =>
          record.sessionId === sessionId &&
          (taskId === undefined || record.taskId === taskId),
      );
  }

  /** Only unsubmitted intents can be retired. In-flight/unknown effects keep their fence. */
  reconcile(sessionId: string, taskId: string) {
    return this.store.transaction(() => {
      const task = this.tasks.get(sessionId, taskId);
      return this.list(sessionId, taskId).map((record) => {
        if (pending.has(record.state) && !this.current(record, task, true))
          return this.move(
            record,
            "canceled",
            task.runs.at(-1)?.cancelRequested || task.state === "canceled"
              ? "task_stopped"
              : "result_superseded",
          );
        return record;
      });
    });
  }

  prepared(
    sessionId: string,
    id: string,
    input: { manifestFingerprint: string; opening: string },
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(input.manifestFingerprint) ||
      !input.opening.trim() ||
      input.opening.length > 4000
    )
      throw new DomainError(400, "Invalid prepared callback metadata.");
    return this.store.transaction(() => {
      const record = this.get(sessionId, id);
      this.requireCurrent(record);
      if (!pending.has(record.state))
        throw new DomainError(
          409,
          "Callback was already submitted or retired.",
        );
      // Narration is the ledger's honest verified brief, not arbitrary model claims.
      if (input.opening !== record.opening)
        throw new DomainError(
          409,
          "Prepared callback must retain its authoritative brief.",
        );
      if (
        record.state === "awaiting_call" &&
        record.manifestFingerprint !== input.manifestFingerprint
      )
        throw new DomainError(409, "Prepared callback manifest conflicts.");
      record.manifestFingerprint = input.manifestFingerprint;
      return this.move(record, "awaiting_call");
    });
  }

  block(sessionId: string, id: string, reason: string) {
    token(reason);
    return this.store.transaction(() => {
      const record = this.get(sessionId, id);
      this.requireCurrent(record);
      if (!pending.has(record.state))
        throw new DomainError(
          409,
          "Submitted callback cannot become an unsent blocker.",
        );
      return this.move(record, "blocked", reason);
    });
  }

  reserve(sessionId: string, id: string, attemptId: string) {
    token(attemptId);
    return this.store.transaction(() => {
      const record = this.get(sessionId, id);
      if (record.attemptId) {
        if (record.attemptId !== attemptId)
          throw new DomainError(
            409,
            "Callback already has a delivery attempt; do not redial.",
          );
        return { record, replayed: true };
      }
      this.requireCurrent(record);
      if (record.state !== "awaiting_call" || !record.manifestFingerprint)
        throw new DomainError(409, "Callback is not prepared for delivery.");
      if (
        this.records
          .all()
          .some(
            (other) => inFlight.has(other.state) || other.state === "unknown",
          )
      )
        throw new DomainError(409, "An unresolved callback delivery remains.");
      if (this.records.all().some((other) => other.attemptId === attemptId))
        throw new DomainError(
          409,
          "Call attempt is already bound to another callback.",
        );
      record.attemptId = attemptId;
      return { record: this.move(record, "dispatching"), replayed: false };
    });
  }

  outcome(
    sessionId: string,
    id: string,
    attemptId: string,
    state: "in_review" | "delivered" | "failed" | "unknown",
  ) {
    if (!["in_review", "delivered", "failed", "unknown"].includes(state))
      throw new DomainError(400, "Invalid callback outcome.");
    return this.store.transaction(() => {
      const record = this.get(sessionId, id);
      if (!record.attemptId || record.attemptId !== attemptId)
        throw new DomainError(
          409,
          "Callback outcome does not match its original attempt.",
        );
      if (record.state === state) return record;
      if (!inFlight.has(record.state))
        throw new DomainError(
          409,
          "Terminal or uncertain callback requires reviewed reconciliation.",
        );
      return this.move(
        record,
        state,
        state === "unknown" ? "delivery_outcome_unknown" : undefined,
      );
    });
  }

  cancel(sessionId: string, taskId: string) {
    return this.store.transaction(() =>
      this.list(sessionId, taskId).map((record) =>
        pending.has(record.state)
          ? this.move(record, "canceled", "task_stopped")
          : record,
      ),
    );
  }

  /** A crash while handing an envelope to the call owner may precede its local
   * attempt receipt. Fence the intent itself so direct call admission cannot
   * bypass the delivery queue's uncertainty. This never implies cleanup. */
  markUnknown(
    sessionId: string,
    id: string,
    reason = "delivery_reservation_unconfirmed",
  ) {
    token(reason);
    return this.store.transaction(() => {
      const record = this.get(sessionId, id);
      if (record.state === "unknown") return record;
      if (!pending.has(record.state) && !inFlight.has(record.state))
        throw new DomainError(
          409,
          "A settled callback cannot become uncertain without reconciliation.",
        );
      return this.move(record, "unknown", reason);
    });
  }

  private current(
    record: TaskReviewCallbackRecord,
    task: CodingTask,
    exactRevision: boolean,
  ) {
    return (
      task.runs.at(-1)?.id === record.runId &&
      task.verification?.id === record.verificationId &&
      (!exactRevision || task.revision === record.reviewRevision) &&
      ["review_ready", "needs_decision"].includes(task.state) &&
      !task.runs.at(-1)?.cancelRequested &&
      !task.calls.some((call) => call.state === "unknown")
    );
  }
  private requireCurrent(record: TaskReviewCallbackRecord) {
    if (
      !this.current(
        record,
        this.tasks.get(record.sessionId, record.taskId),
        true,
      )
    )
      throw new DomainError(
        409,
        "Callback result is stale, stopped, or unresolved.",
      );
  }
  private move(
    record: TaskReviewCallbackRecord,
    state: TaskReviewCallbackState,
    reason?: string,
  ) {
    if (record.state === state && record.reason === reason) return record;
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
