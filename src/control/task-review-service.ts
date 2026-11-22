import type { CodingTask } from "../contracts.js";
import { TaskReviewCallbackLedger } from "../attention/task-review-callback-ledger.js";
import type { TaskService } from "./task-service.js";
import type { TaskEngine } from "./task-engine.js";
import {
  desktopCallRequestSchema,
  type DesktopCallRequest,
} from "./task-desktop-calls-config.js";
import type { TaskReviewCallbackRecord } from "../attention/task-review-callback-ledger.js";
import type { TaskDesktopCalls } from "./task-desktop-calls.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { DomainError, hash } from "../storage/security.js";
import { taskPresentationFingerprint } from "../task-presentation-contracts.js";

interface PreparedDelivery {
  id: string;
  sessionId: string;
  callbackId: string;
  fingerprint: string;
  request: DesktopCallRequest;
  state: "queued" | "submitting" | "dispatched" | "refused" | "unknown";
}
/** Read-only resolver of existing authorized views/envelopes. May be repeated after
 * restart: MUST NOT capture, spawn processes, mint grants, dial, or change external
 * state. Actual preparation/capture belongs to the existing one-attempt runtime.
 * It cannot infer capture/call grants from a goal. */
export interface ReviewPreparationPort {
  prepare(record: TaskReviewCallbackRecord): Promise<DesktopCallRequest | null>;
}

const ready = new Set(["review_ready", "needs_decision"]);

/** Supervisor-owned preparation. Worker output never supplies call authority. */
export class TaskReviewService {
  readonly ledger: TaskReviewCallbackLedger;
  private unsubscribe?: () => void;
  private deliveries: ProtectedTaskStore<PreparedDelivery>;
  private pumping = false;
  private closed = false;
  private preparation?: ReviewPreparationPort;
  private calls?: Pick<TaskDesktopCalls, "request">;
  constructor(
    readonly tasks: TaskService,
    private sessionToken: string,
    engine?: TaskEngine,
    private phoneConfigured = false,
  ) {
    this.ledger = new TaskReviewCallbackLedger(
      tasks.store,
      tasks.vault,
      tasks.ledger,
    );
    this.deliveries = new ProtectedTaskStore(
      tasks.store,
      tasks.vault,
      "coding-review-delivery-v1",
    );
    for (const delivery of this.deliveries.all())
      if (delivery.state === "submitting")
        tasks.store.transaction(() => {
          this.deliveries.put({ ...delivery, state: "unknown" });
          const callback = this.ledger.get(
            delivery.sessionId,
            delivery.callbackId,
          );
          if (
            [
              "preparing",
              "blocked",
              "awaiting_call",
              "dispatching",
              "in_review",
              "unknown",
            ].includes(callback.state)
          )
            this.ledger.markUnknown(
              delivery.sessionId,
              delivery.callbackId,
              "delivery_reservation_unconfirmed",
            );
        });
    this.unsubscribe = engine?.onSettled(() => {
      this.refresh();
      void this.pump();
    });
    this.refresh();
  }
  close() {
    this.closed = true;
    this.unsubscribe?.();
  }
  configureDelivery(
    calls: Pick<TaskDesktopCalls, "request">,
    preparation?: ReviewPreparationPort,
  ) {
    this.calls = calls;
    this.preparation = preparation;
  }
  /** Protected operator path. Stores one exact envelope before asynchronous delivery. */
  stage(callbackId: string, input: unknown) {
    const session = this.tasks.authenticate(this.sessionToken);
    const initial = this.ledger.get(session.id, callbackId);
    this.ledger.reconcile(session.id, initial.taskId);
    const record = this.ledger.get(session.id, callbackId);
    const request = desktopCallRequestSchema.parse(input);
    if (
      request.taskId !== record.taskId ||
      request.runId !== record.runId ||
      request.expectedRevision !== record.reviewRevision ||
      request.prepared.manifest.sessionId !== session.id ||
      request.prepared.manifest.verificationId !== record.verificationId ||
      request.prepared.manifest.opening !== record.opening
    )
      throw new DomainError(
        409,
        "Prepared delivery must match the exact callback result.",
      );
    const fingerprint = hash(JSON.stringify(request));
    const prior = this.deliveries.get(record.id);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new DomainError(
          409,
          "Callback already has a different prepared delivery. Preserve its original outcome.",
        );
      return { callbackId, state: prior.state, replayed: true };
    }
    if (!["preparing", "blocked", "awaiting_call"].includes(record.state))
      throw new DomainError(
        409,
        "Callback was stopped, superseded or already attempted.",
      );
    this.tasks.store.transaction(() => {
      this.ledger.prepared(session.id, record.id, {
        manifestFingerprint: taskPresentationFingerprint(
          request.prepared.manifest,
        ),
        opening: record.opening,
      });
      this.deliveries.put({
        id: record.id,
        sessionId: session.id,
        callbackId,
        fingerprint,
        request,
        state: "queued",
      });
    });
    return { callbackId, state: "queued", replayed: false };
  }
  /** One serialized supervisor pump; neither a failed nor uncertain delivery is retried. */
  async pump() {
    if (this.pumping || this.closed || !this.calls) return;
    this.pumping = true;
    try {
      const session = this.tasks.authenticate(this.sessionToken);
      for (const record of this.ledger.list(session.id)) {
        if (
          this.closed ||
          !["preparing", "blocked", "awaiting_call"].includes(record.state)
        )
          continue;
        let delivery = this.deliveries.get(record.id);
        if (!delivery && this.preparation) {
          const prepared = await this.preparation.prepare(record);
          if (prepared) {
            this.stage(record.id, prepared);
            delivery = this.deliveries.get(record.id);
          }
        }
        if (!delivery || delivery.state !== "queued" || this.closed) continue;
        this.ledger.reconcile(session.id, record.taskId);
        if (this.ledger.get(session.id, record.id).state === "canceled")
          continue;
        this.deliveries.put({ ...delivery, state: "submitting" });
        try {
          this.calls.request(delivery.request);
          this.deliveries.put({ ...delivery, state: "dispatched" });
        } catch {
          // request() validates/reserves synchronously before scheduling effects.
          // A bound attempt proves that reservation occurred; preserve uncertainty.
          const callback = this.ledger.get(session.id, record.id);
          const attempted = !!callback.attemptId;
          this.deliveries.put({
            ...delivery,
            state: attempted ? "unknown" : "refused",
          });
          if (
            attempted &&
            ["dispatching", "in_review"].includes(callback.state)
          )
            this.ledger.outcome(
              session.id,
              record.id,
              callback.attemptId!,
              "unknown",
            );
          if (!attempted)
            this.ledger.block(
              session.id,
              record.id,
              "prepared_delivery_refused",
            );
        }
      }
    } catch {
      /* Preserve existing intent and receipts. No model/network errors are logged. */
    } finally {
      this.pumping = false;
    }
  }
  refresh() {
    const session = this.tasks.authenticate(this.sessionToken);
    for (const task of this.tasks.ledger.list(session.id)) {
      try {
        this.ledger.reconcile(session.id, task.id);
        if (!ready.has(task.state) || task.runs.at(-1)?.cancelRequested)
          continue;
        const { record } = this.ledger.schedule(session.id, task.id);
        if (record.state === "preparing")
          this.ledger.block(
            session.id,
            record.id,
            this.phoneConfigured
              ? "fresh_views_and_call_authorization_required"
              : "phone_setup_missing",
          );
      } catch {
        /* A stale/unresolved result keeps its receipt; never replay it. */
      }
    }
  }
  request(task: CodingTask) {
    this.refresh();
    return {
      message: this.phoneConfigured
        ? "Review callback requested for this task. It will use the exact checked result; fresh prepared views and call authorization are required before dialing."
        : "Review callback intent is retained for this task, but phone setup is missing. The result will remain available for review here; no call is promised.",
    };
  }
  admissionNotice() {
    return this.phoneConfigured
      ? " Review follows independent checks. Calling requires fresh authorized views and an available phone line."
      : " Review follows independent checks. Phone callbacks are unavailable until phone setup is connected.";
  }
  snapshot(task: CodingTask) {
    const run = task.runs.at(-1)!;
    const callback = this.ledger
      .list(task.sessionId, task.id)
      .findLast(
        (r) => r.runId === run.id && r.verificationId === task.verification?.id,
      );
    const delivery = callback ? this.deliveries.get(callback.id) : undefined;
    const state =
      task.state === "accepted"
        ? "accepted"
        : task.state === "canceled"
          ? "canceled"
          : task.state === "unknown"
            ? "blocked"
            : task.state === "verifying"
              ? "verifying"
              : task.state === "queued"
                ? "queued"
                : task.state === "running"
                  ? task.runs.length > 1
                    ? "revising"
                    : "working"
                  : run.state === "failed"
                    ? "failed"
                    : delivery?.state === "unknown" ||
                        callback?.state === "unknown" ||
                        callback?.state === "blocked"
                      ? "blocked"
                      : callback?.state === "failed"
                        ? "failed"
                        : task.state === "needs_decision" ||
                            run.state === "blocked"
                          ? "blocked"
                          : callback?.state === "in_review" ||
                              callback?.state === "delivered" ||
                              task.state === "review_call"
                            ? "in_review"
                            : callback?.state === "preparing" ||
                                callback?.state === "dispatching"
                              ? "preparing_review"
                              : "awaiting_call";
    return {
      state,
      phoneConfigured: this.phoneConfigured,
      message:
        task.state === "accepted"
          ? "The exact reviewed result was accepted. Deployment remains a separate action."
          : task.state === "unknown"
            ? "The original worker outcome needs reconciliation; no callback or retry will be dispatched."
            : delivery?.state === "unknown" || callback?.state === "unknown"
              ? "Callback delivery is uncertain. Inspect the original attempt; it will not be redialed."
              : !this.phoneConfigured
                ? "Phone setup is missing. Review is available locally; no callback can be promised."
                : callback?.state === "blocked"
                  ? "Review context is prepared. Fresh authorized result views and one-call authorization are required."
                  : callback?.state === "delivered"
                    ? "Review call ended. Acceptance still requires your explicit approval of this result."
                    : callback?.state === "failed"
                      ? "The review call did not connect. No automatic redial is scheduled."
                      : "The supervisor retains one callback intent for each checked result.",
      callback: callback
        ? {
            id: callback.id,
            runId: callback.runId,
            revision: callback.reviewRevision,
            verificationId: callback.verificationId,
            state: callback.state,
            deliveryState: delivery?.state ?? null,
            reason: callback.reason,
            opening: callback.opening,
            // A preparation checklist, never a claim that pixels have been captured.
            views: [
              "current_result",
              "changed_source",
              "independent_verification",
            ],
            originalGoal: task.goal,
            humanInstructions: task.runs.map((prior) => prior.instruction),
            result: run.summary ?? null,
            checks:
              task.verification?.checks.map(({ name, state, summary }) => ({
                name,
                state,
                summary,
              })) ?? [],
            acceptance:
              "Approve this exact result or request a revision. Approval does not authorize deployment.",
          }
        : null,
    };
  }
}
