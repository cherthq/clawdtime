import { basename } from "node:path";
import { z } from "zod";
import type { CodingTask } from "../contracts.js";
import { DomainError, equal, hash } from "../storage/security.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { unresolvedTaskAudioCalls } from "../attention/task-audio-call.js";
import { unresolvedTaskPresentations } from "../attention/task-presentation-ledger.js";
import type { TaskService } from "./task-service.js";
import type { TaskEngine } from "./task-engine.js";

const identity = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:-]+$/);
const binding = {
  taskId: identity,
  runId: identity,
  expectedRevision: z.number().int().nonnegative(),
};
const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      eventId: identity,
      action: z.literal("submit"),
      goal: z.string().trim().min(1).max(8000),
    })
    .strict(),
  z
    .object({
      eventId: identity,
      action: z.literal("decide"),
      ...binding,
      instruction: z.string().trim().min(1).max(8000),
    })
    .strict(),
  z
    .object({ eventId: identity, action: z.literal("accept"), ...binding })
    .strict(),
  z
    .object({ eventId: identity, action: z.literal("cancel"), ...binding })
    .strict(),
  z
    .object({
      eventId: identity,
      action: z.literal("stop_sharing"),
      controlId: identity,
    })
    .strict(),
  z
    .object({
      eventId: identity,
      action: z.literal("stop_call"),
      controlId: identity,
    })
    .strict(),
]);
type Command = z.infer<typeof commandSchema>;
export interface DesktopOperation {
  eventId: string;
  action: Command["action"];
  state: "pending" | "done" | "refused" | "unknown";
  message: string;
  taskId?: string;
  resultRevision?: number;
}
interface StoredOperation extends DesktopOperation {
  id: string;
  sessionId: string;
  desktopId: string;
  instanceId: string;
  fingerprint: string;
  createdAt: number;
  controlId?: string;
}
export interface DesktopControls {
  controlId: string | null;
  sharingActive: boolean;
  callActive: boolean;
  canStopSharing: boolean;
  canStopCall: boolean;
}
export interface DesktopControlPort {
  snapshot(): DesktopControls;
  stopSharing(controlId: string, eventId: string): Promise<void>;
  stopCall(controlId: string, eventId: string): Promise<void>;
}
export interface DesktopServiceConfig {
  desktopId: string;
  instanceId: string;
  configurationFingerprint: string;
  token: string;
  sessionToken: string;
  worker: "simulation" | "codex";
  /** Temporary handset composition may expose only its already-owned task. */
  boundTaskId?: string;
}
const terminal = new Set(["accepted", "canceled", "failed"]);
const decisions = new Set([
  "needs_decision",
  "review_ready",
  "walkthrough_ready",
  "in_call",
  "review_call",
]);
const terminalRuns = new Set(["completed", "failed", "blocked", "canceled"]);
const inertControls: DesktopControls = {
  controlId: null,
  sharingActive: false,
  callActive: false,
  canStopSharing: false,
  canStopCall: false,
};

/** A native UI capability for one existing service/session. It never grants calls. */
export class TaskDesktopService {
  private records: ProtectedTaskStore<StoredOperation>;
  private sessionId: string;
  private projectRoot: string;
  private sessionExpiresAt: number;
  constructor(
    readonly service: TaskService,
    readonly engine: TaskEngine | undefined,
    readonly config: DesktopServiceConfig,
    private controls?: DesktopControlPort,
    private taskActionsAvailable: () => boolean = () => true,
  ) {
    if (config.token.length < 32 || equal(config.token, config.sessionToken))
      throw Error("Separate desktop capability required.");
    if ((config.worker === "codex") !== !!engine)
      throw Error("Desktop worker configuration differs.");
    const session = service.authenticate(config.sessionToken);
    this.sessionId = session.id;
    this.projectRoot = session.projectRoot;
    this.sessionExpiresAt = session.expiresAt;
    if (config.boundTaskId) service.ledger.get(session.id, config.boundTaskId);
    this.records = new ProtectedTaskStore(
      service.store,
      service.vault,
      "coding-desktop-operation-v1",
    );
    for (const record of this.owned())
      if (record.state === "pending")
        this.records.put({
          ...record,
          state: "unknown",
          message:
            "The service restarted before confirmation. The original operation is retained; it will not be repeated.",
        });
  }
  private authorizeUI(raw: string) {
    if (!equal(raw, this.config.token))
      throw new DomainError(401, "Desktop authorization required.");
  }
  private owned() {
    return this.records
      .all()
      .filter(
        (r) =>
          r.sessionId === this.sessionId &&
          r.desktopId === this.config.desktopId,
      );
  }
  private publicOperation(r: StoredOperation): DesktopOperation {
    const { eventId, action, state, message, taskId, resultRevision } = r;
    return {
      eventId,
      action,
      state,
      message,
      ...(taskId ? { taskId } : {}),
      ...(resultRevision !== undefined ? { resultRevision } : {}),
    };
  }
  private key(eventId: string) {
    return hash(`${this.sessionId}\0${this.config.desktopId}\0${eventId}`);
  }
  private current() {
    if (this.config.boundTaskId)
      return this.service.ledger.get(this.sessionId, this.config.boundTaskId);
    const pointer = this.service.store.state<{ taskId: string }>(
      `desktop-current:${this.key("selection")}`,
    );
    return pointer
      ? this.service.ledger.get(this.sessionId, pointer.taskId)
      : this.service.ledger.list(this.sessionId).at(-1);
  }
  private unresolvedTaskOperation() {
    return this.owned().some(
      (r) =>
        !r.action.startsWith("stop_") &&
        ["pending", "unknown"].includes(r.state),
    );
  }
  private cleanupPending() {
    return (
      unresolvedTaskAudioCalls(this.service.store, this.service.vault).length >
        0 ||
      unresolvedTaskPresentations(this.service.store, this.service.vault)
        .length > 0
    );
  }
  private controlSnapshot() {
    const value = this.controls?.snapshot() ?? { ...inertControls };
    const unresolved = this.owned().filter(
      (r) =>
        r.controlId === value.controlId &&
        ["pending", "unknown"].includes(r.state),
    );
    return {
      ...value,
      canStopSharing:
        value.canStopSharing &&
        !unresolved.some((r) => r.action === "stop_sharing"),
      canStopCall:
        value.canStopCall && !unresolved.some((r) => r.action === "stop_call"),
    };
  }
  private projectTask(task: CodingTask) {
    const run = task.runs.at(-1)!;
    const pending = this.unresolvedTaskOperation();
    const callActive = this.controls?.snapshot().callActive ?? false;
    const readiness = this.service.readiness(this.config.sessionToken, task.id);
    const reviewSafe =
      this.taskActionsAvailable() &&
      !readiness.blockedReasons.length &&
      !callActive &&
      !pending;
    return {
      id: task.id,
      runId: run.id,
      revision: task.revision,
      goal: task.goal,
      state: task.state,
      summary:
        run.cancelRequested && !terminal.has(task.state)
          ? "Cancellation requested; waiting for the worker's confirmed outcome."
          : task.state === "accepted"
            ? "Result accepted. The independent checks passed."
            : (task.brief?.opening ??
              run.summary ??
              (this.engine
                ? task.state === "running"
                  ? "Codex is working in the selected project."
                  : task.state === "verifying"
                    ? "The watcher is running the independent checks."
                    : "The task is waiting to run."
                : "Simulation only. No coding worker is running.")),
      decision:
        task.decision && task.decision.runId === run.id
          ? {
              question: task.decision.question,
              ...(task.decision.options
                ? { options: task.decision.options }
                : {}),
            }
          : null,
      checks:
        task.verification?.runId === run.id
          ? task.verification.checks.map(({ name, state, summary }) => ({
              name,
              state,
              summary,
            }))
          : [],
      canDecide:
        reviewSafe && decisions.has(task.state) && terminalRuns.has(run.state),
      canAccept:
        reviewSafe &&
        ["review_ready", "review_call"].includes(task.state) &&
        run.state === "completed" &&
        task.verification?.state === "passed" &&
        task.verification.runId === run.id,
      canCancel:
        this.taskActionsAvailable() &&
        !terminal.has(task.state) &&
        !run.cancelRequested,
      updatedAt: task.updatedAt,
    };
  }
  snapshot(raw: string) {
    this.authorizeUI(raw);
    let sessionActive = true;
    try {
      this.sessionExpiresAt = this.service.authenticate(
        this.config.sessionToken,
      ).expiresAt;
    } catch {
      sessionActive = false;
    }
    const task = sessionActive ? this.current() : undefined;
    return {
      version: 1,
      desktopId: this.config.desktopId,
      instanceId: this.config.instanceId,
      configurationFingerprint: this.config.configurationFingerprint,
      projectRoot: this.projectRoot,
      projectLabel: basename(this.projectRoot),
      worker: this.config.worker,
      mode: this.service.options.simulation ? "simulation" : "standby",
      sessionExpiresAt: this.sessionExpiresAt,
      sessionActive,
      notice: sessionActive
        ? null
        : "Task authorization expired or was revoked. Existing call cleanup remains available.",
      canSubmit:
        !this.config.boundTaskId &&
        this.taskActionsAvailable() &&
        sessionActive &&
        (!task || terminal.has(task.state)) &&
        !this.unresolvedTaskOperation() &&
        !this.cleanupPending() &&
        (!task ||
          !this.service.readiness(this.config.sessionToken, task.id)
            .blockedReasons.length),
      task: task ? this.projectTask(task) : null,
      controls: this.controlSnapshot(),
      operations: this.owned()
        .filter((r) => ["pending", "unknown"].includes(r.state))
        .slice(-32)
        .map((r) => this.publicOperation(r)),
    };
  }
  operation(raw: string, eventId: string) {
    this.authorizeUI(raw);
    identity.parse(eventId);
    const record = this.records.get(this.key(eventId));
    return record
      ? this.publicOperation(record)
      : {
          eventId,
          state: "not_found",
          message:
            "No receipt is available. Do not repeat an uncertain submission.",
        };
  }
  async submit(raw: string, input: unknown): Promise<DesktopOperation> {
    this.authorizeUI(raw);
    const command = commandSchema.parse(input),
      key = this.key(command.eventId);
    const fingerprint = hash(JSON.stringify(command));
    const prior = this.records.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new DomainError(409, "Desktop operation identity conflicts.");
      return this.publicOperation(prior);
    }
    // A full task-history budget must not disable exact owned cleanup.
    if (!command.action.startsWith("stop_") && this.owned().length >= 4096)
      throw new DomainError(409, "Desktop operation capacity reached.");
    let record: StoredOperation = {
      id: key,
      sessionId: this.sessionId,
      desktopId: this.config.desktopId,
      instanceId: this.config.instanceId,
      fingerprint,
      createdAt: Date.now(),
      eventId: command.eventId,
      action: command.action,
      state: "pending",
      message: "Operation admitted; confirmation pending.",
    };
    if ("controlId" in command) record.controlId = command.controlId;
    let task: CodingTask | undefined;
    const isStop =
      command.action === "stop_call" || command.action === "stop_sharing";
    try {
      this.service.store.transaction(() => {
        if (!isStop && !this.taskActionsAvailable())
          throw new DomainError(
            409,
            "Task actions are closed for this service owner. Cleanup remains available.",
          );
        const snapshot = this.snapshot(raw);
        if (isStop) {
          const c = snapshot.controls;
          if (
            !this.controls ||
            command.controlId !== c.controlId ||
            !(command.action === "stop_call" ? c.canStopCall : c.canStopSharing)
          )
            throw new DomainError(
              409,
              "This call control is no longer available.",
            );
        } else if (command.action === "submit") {
          this.service.authenticate(this.config.sessionToken);
          if (!snapshot.canSubmit)
            throw new DomainError(
              409,
              "Finish or reconcile the current task before starting another.",
            );
          task = this.service.create(this.config.sessionToken, {
            eventId: `desktop:${key}`,
            goal: command.goal,
          }).task;
          this.service.store.saveState(
            `desktop-current:${this.key("selection")}`,
            { taskId: task.id },
          );
        } else {
          this.service.authenticate(this.config.sessionToken);
          task = this.service.ledger.get(this.sessionId, command.taskId);
          if (
            task.id !== snapshot.task?.id ||
            task.runs.at(-1)?.id !== command.runId ||
            task.revision !== command.expectedRevision
          )
            throw new DomainError(
              409,
              "The displayed task changed. Review its current state.",
            );
          const permitted =
            command.action === "decide"
              ? snapshot.task.canDecide
              : command.action === "accept"
                ? snapshot.task.canAccept
                : snapshot.task.canCancel;
          if (!permitted)
            throw new DomainError(
              409,
              "That task action is not available in the current state.",
            );
          task = this.service.command(this.config.sessionToken, task.id, {
            ...command,
            eventId: `desktop:${key}`,
          }).task;
        }
        if (task)
          record = {
            ...record,
            taskId: task.id,
            resultRevision: task.revision,
          };
        this.records.put(record);
      });
    } catch (error) {
      record = {
        ...record,
        state: "refused",
        message:
          error instanceof DomainError
            ? error.message
            : "Task action was refused. Refresh the current state.",
      };
      this.records.put(record);
      return this.publicOperation(record);
    }
    // Dispatch occurs only AFTER the local receipt/ledger transaction commits.
    try {
      if (command.action === "stop_sharing")
        await this.controls!.stopSharing(command.controlId, command.eventId);
      else if (command.action === "stop_call")
        await this.controls!.stopCall(command.controlId, command.eventId);
      else if (task && command.action === "cancel")
        this.engine?.cancel(task.id);
      else if (
        task &&
        ["submit", "decide"].includes(command.action) &&
        this.engine
      )
        task = this.engine.start(this.sessionId, task.id);
      record = {
        ...record,
        state: "done",
        ...(task ? { resultRevision: task.revision } : {}),
        message: isStop
          ? "Stop requested. Check the current call and sharing status for confirmation."
          : command.action === "cancel"
            ? "Cancellation requested. The task status shows whether the worker has stopped."
            : command.action === "accept"
              ? "Result accepted. Nothing was deployed."
              : this.engine
                ? "Coding run admitted. Independent verification follows completion."
                : "Simulation task recorded. No coding worker was started.",
      };
    } catch {
      record = {
        ...record,
        state: "unknown",
        message:
          "Confirmation is unavailable. The original operation is retained and will not be repeated; check the current task and control status.",
      };
    }
    const current = this.records.get(key)!;
    if (
      current.state === "pending" &&
      current.instanceId === this.config.instanceId
    )
      this.records.put(record);
    return this.publicOperation(this.records.get(key)!);
  }
}
