import type {
  CodingRun,
  CodingTask,
  IndependentTaskSession,
  TaskCall,
  TaskCommand,
  TaskVerification,
} from "../contracts.js";
import { DomainError, hash, id, Vault } from "../storage/security.js";
import { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";

const unresolved = new Set(["running", "verifying", "unknown"]);
const decisionStates = new Set([
  "needs_decision",
  "walkthrough_ready",
  "in_call",
  "review_ready",
  "review_call",
]);
const terminalRuns = new Set(["completed", "failed", "blocked", "canceled"]);

function bounded(value: unknown, label: string, max = 8000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new DomainError(400, `Invalid ${label}.`);
  return value;
}

// Canonical fingerprints are independent of object property insertion order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

interface TaskReceipt {
  id: string;
  fingerprint: string;
  taskId: string;
}
export interface TaskMutation {
  task: CodingTask;
  replayed: boolean;
}

function firstResultSentence(summary?: string): string {
  const normalized = (summary ?? "The requested change is implemented.")
    .replace(/\s+/g, " ")
    .trim();
  // Keep closing quotes with the product result; later worker check notes are stale.
  const first =
    normalized.match(/^.*?[.!?]["'”’)]*(?=\s|$)/)?.[0] ?? normalized;
  return first.length <= 300 ? first : `${first.slice(0, 297).trimEnd()}…`;
}

/** Pure wording projection of the current independently verified run; no effects or receipt changes. */
export function buildTaskBrief(
  task: CodingTask,
): NonNullable<CodingTask["brief"]> {
  const run = task.runs.at(-1),
    verification = task.verification;
  if (
    !run ||
    !verification ||
    verification.runId !== run.id ||
    verification.state === "unknown" ||
    !["completed", "failed", "blocked"].includes(run.state) ||
    !decisionStates.has(task.state)
  )
    throw new DomainError(
      409,
      "A prepared brief requires the current known verified run.",
    );
  if (
    verification.state === "passed" &&
    run.state === "completed" &&
    !run.decision
  )
    return {
      runId: run.id,
      verificationId: verification.id,
      kind: "review",
      opening: `${firstResultSentence(run.summary)} The configured checks passed. Please review the result.`,
    };
  const question = (
    run.decision ??
    (task.decision?.runId === run.id ? task.decision.question : undefined) ??
    (run.state !== "completed"
      ? "The coding run did not complete successfully. What should change?"
      : "Independent verification did not pass. What should change?")
  )
    .replace(/\s+/g, " ")
    .slice(0, 1000);
  if (run.decision) {
    const status =
      verification.state !== "passed"
        ? " The result still needs to pass its checks."
        : run.state !== "completed"
          ? " The coding run did not complete successfully."
          : "";
    return {
      runId: run.id,
      verificationId: verification.id,
      kind: "decision",
      question,
      opening: `${question}${status}`,
    };
  }
  const checks = verification.checks
    .filter((check) => check.state !== "passed")
    .slice(0, 3)
    .map((check) => check.name.replace(/\s+/g, " ").slice(0, 100))
    .join(", ");
  const status =
    verification.state === "failed"
      ? `Independent verification failed: ${checks}.`
      : verification.state === "blocked"
        ? `Independent verification could not finish: ${checks}.`
        : `The coding run was ${run.state}.`;
  return {
    runId: run.id,
    verificationId: verification.id,
    kind: "decision",
    question,
    opening: `${status} ${question}`,
  };
}

/** Single-owner local task ledger. No transport or worker invocation occurs here. */
export class TaskLedger {
  private readonly tasks: ProtectedTaskStore<CodingTask>;
  private readonly receipts: ProtectedTaskStore<TaskReceipt>;
  private readonly calls: ProtectedTaskStore<TaskCall & { taskId: string }>;
  private readonly verifications: ProtectedTaskStore<
    TaskVerification & { taskId: string }
  >;

  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly clock: () => number = Date.now,
  ) {
    this.tasks = new ProtectedTaskStore(store, vault, "coding-task-v1");
    this.receipts = new ProtectedTaskStore(
      store,
      vault,
      "coding-task-event-v1",
    );
    this.calls = new ProtectedTaskStore(store, vault, "coding-task-call-v1");
    this.verifications = new ProtectedTaskStore(
      store,
      vault,
      "coding-task-verification-v1",
    );
    store.transaction(() => {
      for (const task of this.tasks.all()) {
        let changed = false;
        if (task.state === "running" || task.state === "verifying") {
          task.state = "unknown";
          const run = task.runs.at(-1);
          if (run?.state === "running") run.state = "unknown";
          changed = true;
        }
        if (task.call?.state === "connected") {
          task.call.state = "unknown";
          task.calls = task.calls.map((call) =>
            call.id === task.call!.id ? structuredClone(task.call!) : call,
          );
          this.calls.put({ ...task.call, taskId: task.id });
          task.state = "unknown";
          changed = true;
        }
        if (changed) {
          task.revision++;
          task.updatedAt = this.clock();
          this.tasks.put(task);
        }
      }
    });
  }

  create(
    session: IndependentTaskSession,
    input: { eventId: string; goal: string },
  ): TaskMutation {
    bounded(input.eventId, "event identity", 512);
    bounded(input.goal, "task goal");
    if (
      session.version !== 1 ||
      !session.permissions.execute ||
      session.revokedAt !== undefined ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= this.clock()
    )
      throw new DomainError(403, "Independent task session is unavailable.");
    return this.store.transaction(() => {
      const receiptId = this.receiptId(session.id, input.eventId);
      const fingerprint = hash(
        canonical({
          action: "create",
          sessionId: session.id,
          projectRoot: session.projectRoot,
          goal: input.goal,
        }),
      );
      const prior = this.replayed(receiptId, fingerprint, session.id);
      if (prior) return prior;
      const now = this.clock();
      const task: CodingTask = {
        id: id("task"),
        sessionId: session.id,
        revision: 0,
        goal: input.goal,
        projectRoot: session.projectRoot,
        state: "queued",
        runs: [this.newRun(input.goal)],
        verifications: [],
        calls: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.put(task);
      this.receipts.put({ id: receiptId, fingerprint, taskId: task.id });
      return { task, replayed: false };
    });
  }

  get(sessionId: string, taskId: string): CodingTask {
    const task = this.tasks.get(taskId);
    if (!task || task.sessionId !== sessionId)
      throw new DomainError(404, "Task is unavailable in this session.");
    return task;
  }

  list(sessionId: string): CodingTask[] {
    return this.tasks.all().filter((task) => task.sessionId === sessionId);
  }

  transition(
    sessionId: string,
    taskId: string,
    command: TaskCommand,
  ): TaskMutation {
    bounded(command.eventId, "event identity", 512);
    if (
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 0
    )
      throw new DomainError(400, "Invalid task revision.");
    return this.store.transaction(() => {
      const task = this.get(sessionId, taskId);
      const receiptId = this.receiptId(sessionId, command.eventId);
      const fingerprint = hash(canonical({ taskId, command }));
      const replayed = this.replayed(receiptId, fingerprint, sessionId);
      if (replayed) return replayed;
      if (task.revision !== command.expectedRevision)
        throw new DomainError(409, "Task revision is stale.");
      this.apply(task, command);
      task.revision++;
      task.updatedAt = this.clock();
      this.tasks.put(task);
      this.receipts.put({ id: receiptId, fingerprint, taskId });
      return { task, replayed: false };
    });
  }

  private apply(task: CodingTask, command: TaskCommand) {
    const run = task.runs.at(-1)!;
    switch (command.action) {
      case "claim_run": {
        if (
          task.state !== "queued" ||
          run.state !== "queued" ||
          run.id !== command.runId
        )
          throw new DomainError(
            409,
            "Only the current queued run can be claimed.",
          );
        if (
          this.tasks
            .all()
            .some(
              (other) =>
                unresolved.has(other.state) ||
                other.runs.some((candidate) =>
                  ["running", "unknown"].includes(candidate.state),
                ) ||
                other.calls.some((call) => call.state === "unknown"),
            )
        )
          throw new DomainError(
            409,
            "A worker or verification outcome is unresolved.",
          );
        task.state = "running";
        delete task.brief;
        run.state = "running";
        run.startedAt = this.clock();
        break;
      }
      case "run_result": {
        if (
          run.id !== command.runId ||
          run.dispatchId !== command.dispatchId ||
          !["running", "unknown"].includes(run.state) ||
          !["running", "unknown"].includes(task.state)
        )
          throw new DomainError(
            409,
            "Result does not match the unresolved dispatch.",
          );
        if (
          !["completed", "failed", "blocked", "canceled", "unknown"].includes(
            command.outcome,
          )
        )
          throw new DomainError(400, "Invalid worker outcome.");
        run.summary = bounded(command.summary, "worker summary", 4000);
        if (command.threadId !== undefined)
          run.threadId = bounded(
            command.threadId,
            "worker thread identity",
            200,
          );
        if (command.turnId !== undefined)
          run.turnId = bounded(command.turnId, "worker turn identity", 200);
        if (command.decision !== undefined)
          run.decision = bounded(command.decision, "decision", 2000);
        run.state = command.outcome;
        if (command.outcome !== "unknown") run.endedAt = this.clock();
        task.state =
          command.outcome === "unknown"
            ? "unknown"
            : command.outcome === "canceled" || run.cancelRequested
              ? "canceled"
              : "verifying";
        break;
      }
      case "verify_result": {
        if (
          task.state !== "verifying" ||
          !terminalRuns.has(run.state) ||
          command.verification.runId !== run.id
        )
          throw new DomainError(
            409,
            "Verification does not match the completed run.",
          );
        const verification = this.validateVerification(command.verification);
        if (this.verifications.get(verification.id))
          throw new DomainError(409, "Verification identity already exists.");
        this.verifications.put({ ...verification, taskId: task.id });
        task.verification = verification;
        task.verifications.push(verification);
        if (verification.state === "unknown") {
          task.state = "unknown";
          delete task.brief;
        } else if (
          verification.state === "passed" &&
          run.state === "completed" &&
          !run.decision
        ) {
          task.state = "review_ready";
          delete task.decision;
        } else {
          task.state = "needs_decision";
          task.decision = {
            id: id("decision"),
            runId: run.id,
            question:
              run.decision ??
              (run.state !== "completed"
                ? "The coding run did not complete successfully. What should change?"
                : "Independent verification did not pass. What should change?"),
          };
        }
        if (task.state !== "unknown") task.brief = buildTaskBrief(task);
        break;
      }
      case "prepare_call": {
        if (!["needs_decision", "review_ready"].includes(task.state))
          throw new DomainError(409, "Task is not ready for a prepared call.");
        if (command.simulated !== true)
          throw new DomainError(
            403,
            "Live calls are disabled in this checkpoint.",
          );
        bounded(command.callId, "call identity", 512);
        if (this.calls.get(command.callId))
          throw new DomainError(409, "Call identity already exists.");
        if (task.call && !["ended", "unanswered"].includes(task.call.state))
          throw new DomainError(409, "Previous call outcome is unresolved.");
        const kind = task.state === "review_ready" ? "review" : "decision";
        task.call = {
          id: command.callId,
          runId: run.id,
          kind,
          state: "prepared",
          opening: bounded(command.opening, "prepared opening", 2000),
          simulated: true,
        };
        this.calls.put({ ...task.call, taskId: task.id });
        task.calls.push(structuredClone(task.call));
        task.state = kind === "review" ? "review_ready" : "walkthrough_ready";
        break;
      }
      case "call_state": {
        const call = task.call;
        if (
          !call ||
          call.id !== command.callId ||
          !["prepared", "connected"].includes(call.state)
        )
          throw new DomainError(409, "Call is unavailable or terminal.");
        if (
          !["connected", "ended", "unanswered", "unknown"].includes(
            command.state,
          ) ||
          (command.state === "connected" && call.state !== "prepared") ||
          (command.state === "unanswered" && call.state !== "prepared")
        )
          throw new DomainError(409, "Invalid call transition.");
        call.state = command.state;
        this.calls.put({ ...call, taskId: task.id });
        task.calls = task.calls.map((previous) =>
          previous.id === call.id ? structuredClone(call) : previous,
        );
        if (command.state === "unknown") task.state = "unknown";
        else if (
          call.runId === run.id &&
          [
            "walkthrough_ready",
            "in_call",
            "review_call",
            "review_ready",
          ].includes(task.state)
        ) {
          if (command.state === "connected")
            task.state = call.kind === "review" ? "review_call" : "in_call";
          else
            task.state =
              call.kind === "review" ? "review_ready" : "needs_decision";
        }
        break;
      }
      case "decide": {
        if (
          !decisionStates.has(task.state) ||
          run.id !== command.runId ||
          !terminalRuns.has(run.state)
        )
          throw new DomainError(
            409,
            "A decision requires the current known terminal run.",
          );
        if (task.call?.state === "unknown")
          throw new DomainError(409, "Call outcome is unknown.");
        if (task.runs.length >= 32)
          throw new DomainError(409, "Task run limit reached.");
        const instruction = bounded(command.instruction, "scoped instruction");
        if (task.decision) {
          task.decision.answer = instruction;
          task.decision.eventId = command.eventId;
        }
        task.runs.push(this.newRun(instruction));
        task.state = "queued";
        delete task.brief;
        break;
      }
      case "accept": {
        if (
          !["review_ready", "review_call"].includes(task.state) ||
          run.id !== command.runId ||
          run.state !== "completed" ||
          task.verification?.runId !== run.id ||
          task.verification.state !== "passed" ||
          task.calls.some((call) => call.state === "unknown")
        )
          throw new DomainError(
            409,
            "Only the independently verified current result can be accepted.",
          );
        task.state = "accepted";
        break;
      }
      case "cancel": {
        if (["accepted", "canceled", "failed"].includes(task.state))
          throw new DomainError(409, "Task is already terminal.");
        run.cancelRequested = true;
        if (task.state === "running") {
          // The worker must return its original terminal receipt before this is stopped.
        } else if (unresolved.has(task.state)) {
          task.state = "unknown";
        } else {
          task.state = "canceled";
          if (run.state === "queued") {
            run.state = "canceled";
            run.endedAt = this.clock();
          }
        }
        break;
      }
      default:
        throw new DomainError(400, "Unsupported task command.");
    }
  }

  private validateVerification(value: TaskVerification): TaskVerification {
    bounded(value.id, "verification identity", 512);
    if (
      !Number.isFinite(value.completedAt) ||
      value.completedAt > this.clock() ||
      value.completedAt < 0 ||
      !Array.isArray(value.checks) ||
      value.checks.length < 1 ||
      value.checks.length > 16 ||
      !["passed", "failed", "blocked", "unknown"].includes(value.state)
    )
      throw new DomainError(400, "Invalid verification report.");
    for (const check of value.checks) {
      bounded(check.name, "check name", 200);
      bounded(check.summary, "check summary", 2000);
      if (
        !Array.isArray(check.command) ||
        check.command.length < 1 ||
        check.command.length > 32 ||
        !["passed", "failed", "blocked", "unknown"].includes(check.state) ||
        !(check.exitCode === null || Number.isSafeInteger(check.exitCode))
      )
        throw new DomainError(400, "Invalid verification check.");
      for (const arg of check.command) bounded(arg, "check argument", 2000);
      if (check.state === "passed" && check.exitCode !== 0)
        throw new DomainError(400, "A passed check requires exit code zero.");
    }
    const expected = value.checks.some((c) => c.state === "unknown")
      ? "unknown"
      : value.checks.some((c) => c.state === "blocked")
        ? "blocked"
        : value.checks.some((c) => c.state === "failed")
          ? "failed"
          : "passed";
    if (value.state !== expected)
      throw new DomainError(
        400,
        "Verification aggregate disagrees with checks.",
      );
    return structuredClone(value);
  }

  private newRun(instruction: string): CodingRun {
    return {
      id: id("run"),
      instruction,
      dispatchId: id("dispatch"),
      state: "queued",
    };
  }

  private receiptId(sessionId: string, eventId: string) {
    return hash(`${sessionId}\0${eventId}`);
  }

  private replayed(
    receiptId: string,
    fingerprint: string,
    sessionId: string,
  ): TaskMutation | undefined {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return undefined;
    if (receipt.fingerprint !== fingerprint)
      throw new DomainError(409, "Event identity has conflicting content.");
    return { task: this.get(sessionId, receipt.taskId), replayed: true };
  }
}
