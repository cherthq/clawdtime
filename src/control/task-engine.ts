import type {
  CodingTask,
  TaskWorker,
  TaskWorkerResult,
  TaskVerification,
} from "../contracts.js";
import { id } from "../storage/security.js";
import { TaskService } from "./task-service.js";
import {
  runTaskVerification,
  validateVerificationPlan,
  type VerificationPlan,
} from "./task-verification.js";

/** Service-owned sequential worker. No chat, transport, audio or model grants authority. */
export class TaskEngine {
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private closing = false;
  private settled = new Set<(taskId: string) => void>();
  onSettled(listener: (taskId: string) => void) {
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }
  constructor(
    readonly service: TaskService,
    private worker: TaskWorker,
    private plan: VerificationPlan,
    private verify: typeof runTaskVerification = runTaskVerification,
  ) {
    validateVerificationPlan(plan);
    this.plan = structuredClone(plan);
  }
  start(sessionId: string, taskId: string): CodingTask {
    if (this.closing) throw new Error("Task engine is stopping.");
    this.service.session(sessionId);
    const task = this.service.ledger.get(sessionId, taskId);
    if (this.active.has(taskId)) return task;
    const run = task.runs.at(-1)!;
    const claim = this.service.ledger.transition(sessionId, taskId, {
      action: "claim_run",
      eventId: `claim:${run.dispatchId}`,
      expectedRevision: task.revision,
      runId: run.id,
    });
    if (claim.replayed) return claim.task;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.execute(claim.task, controller))
      .finally(() => {
        this.active.delete(taskId);
        if (!this.closing)
          for (const listener of this.settled) {
            try {
              listener(taskId);
            } catch {
              /* Durable held receipt remains available; no automatic retry. */
            }
          }
      });
    this.active.set(taskId, { controller, promise });
    // Requests remain responsive; failure conservatively retains the durable unresolved claim.
    void promise.catch(() => {});
    return claim.task;
  }
  async wait(taskId: string) {
    await this.active.get(taskId)?.promise;
  }
  cancel(taskId: string) {
    this.active.get(taskId)?.controller.abort();
  }
  /** Call cleanup may close an idle engine, but must never abort admitted work. */
  closeIfIdle(): boolean {
    if (this.active.size) return false;
    this.closing = true;
    return true;
  }
  async close() {
    this.closing = true;
    for (const value of this.active.values()) value.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((value) => value.promise),
    );
  }
  private async execute(claim: CodingTask, controller: AbortController) {
    const run = claim.runs.at(-1)!;
    let result: TaskWorkerResult;
    const monitor = setInterval(() => {
      try {
        this.service.session(claim.sessionId);
      } catch {
        controller.abort();
      }
    }, 250);
    try {
      try {
        this.service.session(claim.sessionId);
        if (controller.signal.aborted)
          result = {
            outcome: "canceled",
            summary: "Canceled before worker invocation.",
          };
        else
          result = await this.worker.run(
            {
              taskId: claim.id,
              runId: run.id,
              dispatchId: run.dispatchId,
              revision: claim.revision,
              projectRoot: claim.projectRoot,
              context: this.context(claim),
            },
            ({ phase, threadId, turnId }) => {
              this.service.ledger.progress(
                claim.sessionId,
                claim.id,
                run.id,
                phase,
                { threadId, turnId },
              );
            },
            controller.signal,
          );
      } catch {
        result = {
          outcome: "unknown",
          summary:
            "Worker outcome unavailable; original dispatch retained without retry.",
        };
      }
      let current = this.service.ledger.get(claim.sessionId, claim.id);
      current = this.service.ledger.transition(claim.sessionId, claim.id, {
        action: "run_result",
        eventId: `result:${run.dispatchId}`,
        expectedRevision: current.revision,
        runId: run.id,
        dispatchId: run.dispatchId,
        ...result,
      }).task;
      if (current.state !== "verifying") return;
      let verification: TaskVerification;
      try {
        verification = await this.verify(
          claim.projectRoot,
          run.id,
          this.plan,
          controller.signal,
          () => {
            this.service.session(claim.sessionId);
          },
        );
      } catch {
        verification = {
          id: id("verification"),
          runId: run.id,
          state: "unknown",
          completedAt: Date.now(),
          checks: [
            {
              name: "Independent watcher",
              command: ["watcher"],
              state: "unknown",
              exitCode: null,
              summary:
                "Watcher outcome unavailable; no automatic execution replay.",
            },
          ],
        };
      }
      current = this.service.ledger.get(claim.sessionId, claim.id);
      if (current.state !== "verifying") return; // Cancellation/restart uncertainty is never overwritten.
      this.service.ledger.transition(claim.sessionId, claim.id, {
        action: "verify_result",
        eventId: `verification:${run.dispatchId}`,
        expectedRevision: current.revision,
        verification,
      });
    } finally {
      clearInterval(monitor);
    }
  }
  private context(task: CodingTask) {
    const run = task.runs.at(-1)!;
    return JSON.stringify({
      goal: task.goal,
      projectRoot: task.projectRoot,
      instruction: run.instruction,
      // Human restrictions introduced in an earlier revision must survive later
      // turns. Worker summaries are not an authoritative substitute for them.
      priorHumanInstructions: task.runs
        .slice(0, -1)
        .map((prior) => prior.instruction),
      priorResults: task.runs.slice(-3, -1).map((prior) => ({
        runId: prior.id,
        outcome: prior.state,
        summary: prior.summary?.slice(0, 400),
        decision: prior.decision?.slice(0, 200),
      })),
      verification: task.verification
        ? {
            state: task.verification.state,
            checks: task.verification.checks.slice(0, 8).map((check) => ({
              name: check.name.slice(0, 100),
              state: check.state,
              exitCode: check.exitCode,
              summary: check.summary.slice(0, 120),
            })),
          }
        : undefined,
      decision: task.decision
        ? {
            id: task.decision.id,
            question: task.decision.question.slice(0, 500),
            ...(task.decision.options
              ? {
                  options: task.decision.options
                    .slice(0, 3)
                    .map((v) => v.slice(0, 500)),
                }
              : {}),
            answered: task.decision.answer === run.instruction,
            ...(task.decision.answer === run.instruction
              ? { answerSource: "instruction" }
              : {}),
          }
        : undefined,
      constraints:
        "Work only in this selected project. This is a new scoped run. Preserve the original goal and every restriction in it across all revisions, including don't deploy, draft only, and don't send. Result acceptance never authorizes deployment. Do not deploy, publish, send messages, place calls or change credentials. The supervisor owns review callbacks. A decision marked answered is historical; its exact answer is the instruction. Report only genuinely remaining product decisions, not an already answered question. Native permissions cannot be approved through ClawdTime.",
    });
  }
}
