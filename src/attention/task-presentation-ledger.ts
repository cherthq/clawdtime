import { z } from "zod";
import type { IndependentTaskSession } from "../contracts.js";
import { DomainError, hash, Vault } from "../storage/security.js";
import { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { buildTaskBrief, TaskLedger } from "./task-ledger.js";
import {
  taskPresentationFingerprint,
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
  taskSceneFrameSchema,
  taskPresentationCleanupSchema,
  type TaskPresentationManifest,
  type TaskPresentationGrant,
  type TaskPresentationRecord,
  type TaskPresentationEffect,
  type TaskSceneFrame,
  type TaskPresentationCleanup,
  type TaskPresentationCaptureBinding,
} from "../task-presentation-contracts.js";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const captureBindingSchema = z
  .object({
    callAttemptId: identity,
    voiceSessionId: identity,
    exportGrantId: identity,
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const KIND = "coding-task-presentation-v1";
const ready = new Set([
  "needs_decision",
  "walkthrough_ready",
  "review_ready",
  "in_call",
  "review_call",
]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export { taskPresentationFingerprint } from "../task-presentation-contracts.js";
interface EventReceipt {
  id: string;
  fingerprint: string;
  presentationId: string;
}
export interface TaskPresentationClaim {
  eventId: string;
  expectedGeneration: number;
  action: TaskPresentationEffect["action"];
  sceneId?: string;
  frame?: TaskSceneFrame;
}
export interface TaskPresentationSettlement {
  state: "done" | "rejected" | "unknown";
  frame?: TaskSceneFrame;
  cleanup?: TaskPresentationCleanup;
}
const claimSchema = z
  .object({
    eventId: identity,
    expectedGeneration: z.number().int().nonnegative().safe(),
    action: z.enum(["show_scene", "narrate", "stop"]),
    sceneId: identity.optional(),
    frame: taskSceneFrameSchema.optional(),
  })
  .strict();
const settlementSchema = z
  .object({
    state: z.enum(["done", "rejected", "unknown"]),
    frame: taskSceneFrameSchema.optional(),
    cleanup: taskPresentationCleanupSchema.optional(),
  })
  .strict();

/** Read-only admission fence; never instantiates the ledger or rewrites restart receipts. */
export function unresolvedTaskPresentations(store: Store, vault: Vault) {
  return new ProtectedTaskStore<TaskPresentationRecord>(store, vault, KIND)
    .all()
    .filter((record) => record.state !== "stopped" || !record.cleanup)
    .map((record) => ({
      id: record.id,
      state: record.state,
      taskId: record.manifest.taskId,
      sessionId: record.manifest.sessionId,
    }));
}

/** Metadata/prose only. No capture, speech, task execution or transport occurs in this ledger. */
export class TaskPresentationLedger {
  private readonly records: ProtectedTaskStore<TaskPresentationRecord>;
  private readonly events: ProtectedTaskStore<EventReceipt>;
  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly tasks: TaskLedger,
    private readonly clock: () => number = Date.now,
    private readonly authorizeCapture?: (
      record: TaskPresentationRecord,
      binding: TaskPresentationCaptureBinding,
    ) => void,
  ) {
    this.records = new ProtectedTaskStore(store, vault, KIND);
    this.events = new ProtectedTaskStore(
      store,
      vault,
      "coding-task-presentation-event-v1",
    );
    store.transaction(() => {
      for (const record of this.records.all()) {
        let changed = false;
        for (const effect of record.effects)
          if (effect.state === "running") {
            effect.state = "unknown";
            changed = true;
          }
        // Capturing or audible output cannot be presumed ended after service restart.
        if (
          changed ||
          ["presenting", "visible", "narrating"].includes(record.state)
        ) {
          record.state = "unknown";
          delete record.frame;
          this.records.put(record);
        }
      }
    });
  }
  prepare(
    session: IndependentTaskSession,
    input: {
      eventId: string;
      manifest: TaskPresentationManifest;
      grant: TaskPresentationGrant;
    },
    captureBinding?: TaskPresentationCaptureBinding,
  ): { presentation: TaskPresentationRecord; replayed: boolean } {
    identity.parse(input.eventId);
    const manifest = taskPresentationManifestSchema.parse(input.manifest),
      grant = taskPresentationGrantSchema.parse(input.grant);
    captureBinding =
      captureBinding === undefined
        ? undefined
        : captureBindingSchema.parse(captureBinding);
    const fingerprint = taskPresentationFingerprint(manifest),
      eventFingerprint = hash(
        canonical({ sessionId: session.id, manifest, grant, captureBinding }),
      );
    return this.store.transaction(() => {
      const key = hash(`prepare\0${session.id}\0${input.eventId}`),
        previous = this.event(key, eventFingerprint);
      if (previous)
        return {
          presentation: this.get(session.id, previous.presentationId),
          replayed: true,
        };
      if (this.records.get(manifest.id))
        throw new DomainError(409, "Presentation identity already exists.");
      if (
        (grant.continuity === "call") !== (captureBinding !== undefined) ||
        (captureBinding && !this.authorizeCapture)
      )
        throw new DomainError(
          403,
          "Explicit call-scoped capture authority is required.",
        );
      if (
        captureBinding &&
        (captureBinding.expiresAt <= this.clock() ||
          captureBinding.expiresAt > session.expiresAt)
      )
        throw new DomainError(
          403,
          "Call-scoped capture lifetime is unavailable.",
        );
      if (this.unresolved().length)
        throw new DomainError(
          409,
          "Another presentation still reserves capture.",
        );
      if (
        session.revokedAt !== undefined ||
        session.expiresAt <= this.clock() ||
        session.version !== 1 ||
        manifest.sessionId !== session.id ||
        grant.hostId !== session.hostId ||
        grant.expiresAt > session.expiresAt
      )
        throw new DomainError(
          403,
          "Exact current local presentation session is required.",
        );
      const record: TaskPresentationRecord = {
        id: manifest.id,
        manifest,
        fingerprint,
        grant,
        ...(captureBinding
          ? { captureBinding: structuredClone(captureBinding) }
          : {}),
        generation: 0,
        state: "prepared",
        effects: [],
        createdAt: this.clock(),
      };
      this.current(record);
      if (
        this.tasks.get(session.id, manifest.taskId).projectRoot !==
        session.projectRoot
      )
        throw new DomainError(
          403,
          "Task project differs from presentation session.",
        );
      if (this.records.all().some((r) => r.grant.id === grant.id))
        throw new DomainError(
          409,
          "Presentation grant identity was already used.",
        );
      this.records.put(record);
      this.events.put({
        id: key,
        fingerprint: eventFingerprint,
        presentationId: record.id,
      });
      return { presentation: record, replayed: false };
    });
  }
  get(sessionId: string, id: string): TaskPresentationRecord {
    const record = this.record(id);
    if (record.manifest.sessionId !== sessionId)
      throw new DomainError(
        404,
        "Presentation is unavailable in this session.",
      );
    return record;
  }
  list(sessionId: string) {
    return this.records.all().filter((r) => r.manifest.sessionId === sessionId);
  }
  unresolved(): TaskPresentationRecord[] {
    return this.records
      .all()
      .filter((r) => r.state !== "stopped" || !r.cleanup);
  }
  claim(
    id: string,
    raw: TaskPresentationClaim,
  ): {
    presentation: TaskPresentationRecord;
    receipt: TaskPresentationEffect;
    replayed: boolean;
  } {
    const input = claimSchema.parse(raw),
      fingerprint = hash(canonical(input)),
      key = hash(`claim\0${id}\0${input.eventId}`);
    return this.store.transaction(() => {
      const record = this.record(id),
        previous = this.event(key, fingerprint);
      if (previous)
        return {
          presentation: record,
          receipt: record.effects.find((e) => e.id === input.eventId)!,
          replayed: true,
        };
      if (record.effects.some((e) => e.id === input.eventId))
        throw new DomainError(
          409,
          "Presentation operation identity conflicts.",
        );
      if (record.generation !== input.expectedGeneration)
        throw new DomainError(409, "Presentation generation is stale.");
      if (record.effects.length >= 128)
        throw new DomainError(
          409,
          "Presentation effect receipt limit reached.",
        );
      if (input.action === "stop") {
        if (input.sceneId || input.frame || record.stoppedAt === undefined)
          throw new DomainError(
            409,
            "Stop must revoke admission before cleanup is claimed.",
          );
        if (record.effects.some((e) => e.action === "stop"))
          throw new DomainError(
            409,
            "Inspect the original cleanup receipt; cleanup cannot be retried.",
          );
      } else {
        if (input.action === "show_scene") this.captureCurrent(record);
        else this.current(record);
        if (
          record.stoppedAt !== undefined ||
          record.state === "unknown" ||
          record.effects.some((e) => ["running", "unknown"].includes(e.state))
        )
          throw new DomainError(
            409,
            "Presentation admission is stopped or unresolved.",
          );
        if (this.unresolved().some((r) => r.id !== id))
          throw new DomainError(409, "Another presentation reserves capture.");
        if (!record.manifest.scenes.some((s) => s.id === input.sceneId))
          throw new DomainError(400, "Unknown exact presentation scene.");
        if (input.action === "show_scene") {
          if (input.frame)
            throw new DomainError(
              400,
              "Scene selection cannot nominate a prior frame.",
            );
          record.generation++;
          record.state = "presenting";
          delete record.frame;
          delete record.activeSceneId;
        } else {
          if (
            !input.frame ||
            record.state !== "visible" ||
            record.activeSceneId !== input.sceneId ||
            !record.frame
          )
            throw new DomainError(
              409,
              "Narration requires the currently visible scene.",
            );
          const shown = record.effects.find(
            (e) => e.id === record.frame!.operationId,
          );
          if (!shown || shown.action !== "show_scene" || shown.state !== "done")
            throw new DomainError(
              409,
              "Narration requires a verified scene receipt.",
            );
          this.frame(record, input.frame, shown);
          if (
            input.frame.geometryGeneration !== record.frame.geometryGeneration
          )
            throw new DomainError(
              409,
              "Scene geometry changed before narration.",
            );
          record.frame = input.frame;
          record.state = "narrating";
        }
      }
      const receipt: TaskPresentationEffect = {
        id: input.eventId,
        action: input.action,
        generation: record.generation,
        state: "running",
        startedAt: this.clock(),
        ...(input.sceneId ? { sceneId: input.sceneId } : {}),
        ...(input.frame ? { frame: input.frame } : {}),
      };
      record.effects.push(receipt);
      this.records.put(record);
      this.events.put({ id: key, fingerprint, presentationId: id });
      return { presentation: record, receipt, replayed: false };
    });
  }
  settle(
    id: string,
    eventId: string,
    raw: TaskPresentationSettlement,
  ): TaskPresentationRecord {
    identity.parse(eventId);
    const result = settlementSchema.parse(raw),
      key = hash(`settle\0${id}\0${eventId}`),
      fingerprint = hash(canonical(result));
    return this.store.transaction(() => {
      const record = this.record(id);
      if (this.event(key, fingerprint)) return record;
      const effect = record.effects.find((e) => e.id === eventId);
      if (!effect || effect.state !== "running")
        throw new DomainError(
          409,
          "Only the original in-flight presentation effect can settle.",
        );
      if (result.state === "done") {
        if (effect.action === "show_scene") {
          if (!result.frame || result.cleanup)
            throw new DomainError(400, "A rendered scene frame is required.");
          this.frame(record, result.frame, effect);
          effect.frame = result.frame;
          if (record.stoppedAt === undefined) {
            this.captureCurrent(record);
            record.frame = result.frame;
            record.activeSceneId = effect.sceneId;
            record.state = "visible";
          }
        } else if (effect.action === "narrate") {
          if (result.frame || result.cleanup)
            throw new DomainError(
              400,
              "Narration completion cannot replace frame or cleanup evidence.",
            );
          if (record.stoppedAt === undefined) {
            this.current(record);
            record.state = "visible";
          }
        } else {
          if (!result.cleanup || result.frame)
            throw new DomainError(
              400,
              "Exact joined presentation cleanup is required.",
            );
          record.cleanup = result.cleanup;
        }
      } else {
        if (result.frame || result.cleanup)
          throw new DomainError(
            400,
            "Unsuccessful effects cannot claim frame or cleanup evidence.",
          );
        record.state = "unknown";
        delete record.frame;
      }
      effect.state = result.state;
      effect.completedAt = this.clock();
      if (record.stoppedAt !== undefined) {
        delete record.frame;
        delete record.activeSceneId;
        record.state =
          record.cleanup && !record.effects.some((e) => e.state === "running")
            ? "stopped"
            : "unknown";
      }
      this.records.put(record);
      this.events.put({ id: key, fingerprint, presentationId: id });
      return record;
    });
  }
  stop(id: string, eventId: string): TaskPresentationRecord {
    identity.parse(eventId);
    return this.store.transaction(() => {
      const record = this.record(id),
        key = hash(`stop\0${id}\0${eventId}`),
        fingerprint = hash(id);
      if (this.event(key, fingerprint) || record.stoppedAt !== undefined)
        return record;
      if (record.stoppedAt === undefined) {
        record.stoppedAt = this.clock();
        record.generation++;
        record.state = "unknown";
        delete record.frame;
        delete record.activeSceneId;
      }
      this.records.put(record);
      this.events.put({ id: key, fingerprint, presentationId: id });
      return record;
    });
  }
  private event(key: string, fingerprint: string) {
    const previous = this.events.get(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new DomainError(409, "Presentation event identity conflicts.");
    return previous;
  }
  private record(id: string) {
    const record = this.records.get(id);
    if (
      !record ||
      record.id !== record.manifest.id ||
      taskPresentationFingerprint(record.manifest) !== record.fingerprint
    )
      throw new DomainError(404, "Presentation is unavailable.");
    return record;
  }
  private grantCurrent(record: TaskPresentationRecord) {
    const now = this.clock(),
      m = record.manifest,
      g = record.grant;
    if (
      g.manifestFingerprint !== record.fingerprint ||
      g.sessionId !== m.sessionId ||
      g.taskId !== m.taskId ||
      g.runId !== m.runId ||
      g.taskRevision !== m.taskRevision ||
      g.authorizedAt > now ||
      g.expiresAt <= now
    )
      throw new DomainError(
        403,
        "Exact current local presentation grant is required.",
      );
  }
  private captureCurrent(record: TaskPresentationRecord) {
    if (record.grant.continuity !== "call") {
      if (record.captureBinding)
        throw new DomainError(
          403,
          "Capture binding cannot upgrade a legacy grant.",
        );
      this.current(record);
      return;
    }
    this.grantCurrent(record);
    const binding = record.captureBinding;
    if (!binding || !this.authorizeCapture)
      throw new DomainError(
        403,
        "Current call-scoped capture authority is unavailable.",
      );
    captureBindingSchema.parse(binding);
    if (binding.expiresAt <= this.clock())
      throw new DomainError(403, "Call-scoped capture authority expired.");
    const task = this.tasks.get(
      record.manifest.sessionId,
      record.manifest.taskId,
    );
    if (
      task.revision < record.manifest.taskRevision ||
      !task.runs.some((run) => run.id === record.manifest.runId) ||
      !task.verifications.some(
        (verification) =>
          verification.id === record.manifest.verificationId &&
          verification.runId === record.manifest.runId,
      )
    )
      throw new DomainError(
        403,
        "Original presentation provenance is unavailable.",
      );
    this.authorizeCapture(record, binding);
  }
  /** Recheck the persisted record, never caller-nominated capture scope. */
  assertCapture(record: TaskPresentationRecord): void {
    const current = this.record(record.id);
    if (
      current.stoppedAt !== undefined ||
      ["stopped", "unknown"].includes(current.state)
    )
      throw new DomainError(
        409,
        "Presentation capture is stopped or unresolved.",
      );
    this.captureCurrent(current);
  }
  private current(record: TaskPresentationRecord) {
    this.grantCurrent(record);
    const m = record.manifest;
    const task = this.tasks.get(m.sessionId, m.taskId),
      run = task.runs.at(-1);
    if (
      task.revision !== m.taskRevision ||
      run?.id !== m.runId ||
      !["completed", "failed", "blocked"].includes(run.state) ||
      run.cancelRequested ||
      !ready.has(task.state) ||
      task.verification?.id !== m.verificationId ||
      task.verification.runId !== run.id ||
      task.verification.state === "unknown" ||
      task.calls.some((c) => c.state === "unknown") ||
      !task.brief ||
      task.brief.runId !== run.id ||
      task.brief.verificationId !== m.verificationId
    )
      throw new DomainError(
        409,
        "Presentation requires the exact current verified terminal task.",
      );
    const brief = buildTaskBrief(task);
    if (m.kind !== brief.kind || m.opening !== brief.opening)
      throw new DomainError(
        409,
        "Presentation opening differs from the verified task brief.",
      );
  }
  private frame(
    record: TaskPresentationRecord,
    raw: TaskSceneFrame,
    effect: TaskPresentationEffect,
  ) {
    const frame = taskSceneFrameSchema.parse(raw),
      scene = record.manifest.scenes.find((s) => s.id === effect.sceneId),
      now = this.clock();
    if (
      !scene ||
      frame.presentationId !== record.id ||
      frame.manifestFingerprint !== record.fingerprint ||
      frame.operationId !== effect.id ||
      frame.sceneId !== effect.sceneId ||
      frame.generation !== effect.generation ||
      canonical(frame.target) !== canonical(scene.target) ||
      frame.capturedAt > frame.renderedAt ||
      frame.transitionCompletedAt > frame.capturedAt ||
      frame.renderedAt > now ||
      frame.transitionCompletedAt > now ||
      now - frame.capturedAt > 2000 ||
      now - frame.renderedAt > 2000
    )
      throw new DomainError(
        409,
        "Fresh exact rendered scene evidence is required.",
      );
  }
}
