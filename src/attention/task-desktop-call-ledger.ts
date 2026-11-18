import { z } from "zod";
import { DomainError, hash, id, Vault } from "../storage/security.js";
import { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { buildTaskBrief, TaskLedger } from "./task-ledger.js";

const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const claimSchema = z
  .object({
    eventId: identity,
    taskId: identity,
    runId: identity,
    expectedRevision: z.number().int().nonnegative().safe(),
    manifestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    authorizationId: identity,
    authorizedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type TaskDesktopCallClaim = z.infer<typeof claimSchema>;
export interface TaskDesktopCallRecord extends TaskDesktopCallClaim {
  id: string;
  sessionId: string;
  attemptId: string;
  fingerprint: string;
  verificationId: string;
  callKind: "decision" | "review";
  state: "starting" | "active" | "closed" | "failed" | "unknown";
  cleanupConfirmed: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface TaskDesktopCallMutation {
  record: TaskDesktopCallRecord;
  replayed: boolean;
}

/** Read-only readiness projection; never reconcile constructors or mutate receipt state. */
export function unresolvedDesktopCallAdmissions(store: Store, vault: Vault) {
  return new ProtectedTaskStore<TaskDesktopCallRecord>(
    store,
    vault,
    "coding-desktop-call-v1",
  )
    .all()
    .filter((record) => !["closed", "failed"].includes(record.state))
    .map((record) => ({
      id: record.id,
      sessionId: record.sessionId,
      taskId: record.taskId,
      attemptId: record.attemptId,
      state: record.state,
    }));
}

/** Local admission only. The existing coordinator retains all external effect receipts. */
export class TaskDesktopCallLedger {
  private readonly records: ProtectedTaskStore<TaskDesktopCallRecord>;
  private readonly owned = new Set<string>();
  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly tasks: TaskLedger,
    private readonly clock: () => number = Date.now,
  ) {
    this.records = new ProtectedTaskStore(
      store,
      vault,
      "coding-desktop-call-v1",
    );
    store.transaction(() => {
      for (const record of this.records.all()) {
        if (record.state === "starting" || record.state === "active")
          this.records.put({
            ...record,
            state: "unknown",
            cleanupConfirmed: false,
            updatedAt: this.clock(),
          });
      }
    });
  }

  claim(
    sessionId: string,
    input: TaskDesktopCallClaim,
  ): TaskDesktopCallMutation {
    identity.parse(sessionId);
    const parsed = claimSchema.parse(input);
    const fingerprint = hash(JSON.stringify({ sessionId, ...parsed }));
    return this.store.transaction(() => {
      const records = this.records.all();
      const prior = records.find(
        (record) =>
          record.sessionId === sessionId && record.eventId === parsed.eventId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Desktop call admission event conflicts.");
        return { record: prior, replayed: true };
      }
      if (
        records.some(
          (record) => record.authorizationId === parsed.authorizationId,
        )
      )
        throw new DomainError(
          409,
          "Desktop call authorization was already consumed.",
        );
      if (this.unresolved().length)
        throw new DomainError(
          409,
          "An unresolved desktop call admission remains.",
        );
      const now = this.clock();
      if (
        parsed.authorizedAt > now ||
        parsed.expiresAt <= now ||
        parsed.expiresAt <= parsed.authorizedAt ||
        parsed.expiresAt > parsed.authorizedAt + 300_000
      )
        throw new DomainError(
          403,
          "Fresh bounded desktop call authorization is required.",
        );
      const task = this.tasks.get(sessionId, parsed.taskId),
        run = task.runs.at(-1);
      if (
        !run ||
        run.id !== parsed.runId ||
        task.revision !== parsed.expectedRevision ||
        !["needs_decision", "review_ready"].includes(task.state) ||
        !["completed", "failed", "blocked"].includes(run.state) ||
        !task.verification ||
        task.verification.runId !== run.id ||
        task.verification.state === "unknown" ||
        !task.brief ||
        task.brief.runId !== run.id ||
        task.brief.verificationId !== task.verification.id ||
        task.runs.some((previous) =>
          ["queued", "running", "unknown"].includes(previous.state),
        ) ||
        task.calls.some((call) => !["ended", "unanswered"].includes(call.state))
      )
        throw new DomainError(
          409,
          "Desktop call requires the exact current known prepared result.",
        );
      const brief = buildTaskBrief(task);
      const record = this.records.put({
        ...parsed,
        id: id("desktop_call"),
        sessionId,
        attemptId: id("call_attempt"),
        fingerprint,
        verificationId: task.verification.id,
        callKind: brief.kind,
        state: "starting",
        cleanupConfirmed: false,
        createdAt: now,
        updatedAt: now,
      });
      this.owned.add(record.id);
      return { record, replayed: false };
    });
  }
  get(sessionId: string, id: string): TaskDesktopCallRecord {
    const record = this.records.get(id);
    if (!record || record.sessionId !== sessionId)
      throw new DomainError(404, "Desktop call admission unavailable.");
    return record;
  }
  list(sessionId: string): TaskDesktopCallRecord[] {
    return this.records
      .all()
      .filter((record) => record.sessionId === sessionId);
  }
  active(): TaskDesktopCallRecord[] {
    return this.records
      .all()
      .filter(
        (record) => record.state === "starting" || record.state === "active",
      );
  }
  unresolved(): TaskDesktopCallRecord[] {
    return this.records
      .all()
      .filter((record) => !["closed", "failed"].includes(record.state));
  }
  markActive(id: string): TaskDesktopCallRecord {
    return this.updateOwned(id, "active");
  }
  markUnknown(id: string): TaskDesktopCallRecord {
    return this.updateOwned(id, "unknown");
  }
  complete(
    id: string,
    input: { cleanupConfirmed: true; outcome: "closed" | "failed" },
  ): TaskDesktopCallRecord {
    if (
      input.cleanupConfirmed !== true ||
      !["closed", "failed"].includes(input.outcome)
    )
      throw new DomainError(
        409,
        "Confirmed cleanup is required to settle desktop call admission.",
      );
    return this.updateOwned(id, input.outcome);
  }
  private updateOwned(
    id: string,
    state: TaskDesktopCallRecord["state"],
  ): TaskDesktopCallRecord {
    return this.store.transaction(() => {
      const record = this.records.get(id);
      if (
        !this.owned.has(id) ||
        !record ||
        !["starting", "active"].includes(record.state)
      )
        throw new DomainError(
          409,
          "Only an in-process owned desktop call can settle; unknown requires explicit reconciliation.",
        );
      const updated = this.records.put({
        ...record,
        state,
        cleanupConfirmed: state === "closed" || state === "failed",
        updatedAt: this.clock(),
      });
      if (state !== "active") this.owned.delete(id);
      return updated;
    });
  }
}
