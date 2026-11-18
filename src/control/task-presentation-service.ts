import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  readFileSync,
  realpathSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DomainError, hash } from "../storage/security.js";
import { buildTaskBrief } from "../attention/task-ledger.js";
import { TaskPresentationLedger } from "../attention/task-presentation-ledger.js";
import {
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
  taskPresentationFingerprint,
  taskSceneFrameSchema,
  taskPresentationCleanupSchema,
  type TaskPresentationGrant,
  type TaskPresentationHost,
  type TaskPresentationManifest,
  type TaskPresentationRecord,
  type TaskSceneFrame,
} from "../task-presentation-contracts.js";
import type { TaskService } from "./task-service.js";
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const command = z
  .object({
    eventId: identity,
    expectedGeneration: z.number().int().nonnegative().safe(),
    sceneId: identity,
  })
  .strict();

/** Separate operator-installed view-only capability; a task token cannot mint capture authority. */
export class TaskPresentationService {
  private busy = new Set<string>();
  private stopping = new Map<string, Promise<TaskPresentationRecord>>();
  constructor(
    readonly tasks: TaskService,
    readonly ledger: TaskPresentationLedger,
    readonly host: TaskPresentationHost,
    private readonly authorized: {
      manifest: TaskPresentationManifest;
      grant: TaskPresentationGrant;
    },
    private clock = Date.now,
  ) {
    this.authorized = structuredClone({
      manifest: taskPresentationManifestSchema.parse(authorized.manifest),
      grant: taskPresentationGrantSchema.parse(authorized.grant),
    });
    if (
      taskPresentationFingerprint(authorized.manifest) !==
      authorized.grant.manifestFingerprint
    )
      throw Error(
        "Operator presentation grant does not match prepared manifest.",
      );
  }
  private record(
    raw: string,
    taskId: string,
    presentationId: string,
    cleanup = false,
  ) {
    let sessionId: string;
    if (cleanup) {
      const credential =
        raw.length >= 32
          ? this.tasks.store.get<{ sessionId: string }>(
              "task-credential",
              hash(raw),
            )
          : undefined;
      if (!credential)
        throw new DomainError(
          401,
          "Exact task credential required for cleanup.",
        );
      sessionId = credential.sessionId;
    } else sessionId = this.tasks.authenticate(raw).id;
    const record = this.ledger.get(sessionId, presentationId);
    if (
      record.id !== this.authorized.manifest.id ||
      taskPresentationFingerprint(record.manifest) !==
        taskPresentationFingerprint(this.authorized.manifest) ||
      record.grant.id !== this.authorized.grant.id
    )
      throw new DomainError(
        403,
        "Presentation is outside this exact host binding.",
      );
    if (record.manifest.taskId !== taskId)
      throw new DomainError(403, "Presentation belongs to another task.");
    return record;
  }
  private current(record: TaskPresentationRecord) {
    const session = this.tasks.session(record.manifest.sessionId);
    const task = this.tasks.ledger.get(session.id, record.manifest.taskId);
    const m = record.manifest,
      g = record.grant,
      brief = buildTaskBrief(task);
    if (
      record.stoppedAt !== undefined ||
      record.state === "unknown" ||
      g.expiresAt <= this.clock() ||
      g.authorizedAt > this.clock() + 1000 ||
      g.expiresAt > session.expiresAt ||
      task.runs.at(-1)?.id !== m.runId ||
      task.revision !== m.taskRevision ||
      brief.runId !== m.runId ||
      brief.verificationId !== m.verificationId ||
      brief.kind !== m.kind ||
      brief.opening !== m.opening ||
      task.runs.some((r) => ["queued", "running", "unknown"].includes(r.state))
    )
      throw new DomainError(
        409,
        "Presentation is stopped, stale, or unavailable.",
      );
    return { session, task };
  }
  private artifacts(record: TaskPresentationRecord) {
    const { task } = this.current(record),
      root = realpathSync(task.projectRoot);
    for (const scene of record.manifest.scenes)
      if (scene.artifact) {
        const path = scene.artifact.relativePath;
        if (isAbsolute(path) || path.split(/[\\/]/).some((p) => p === ".."))
          throw new DomainError(
            403,
            "Artifact path is outside the selected project.",
          );
        const requested = resolve(root, path),
          actual = realpathSync(requested),
          inside = relative(root, actual);
        if (
          !inside ||
          inside === ".." ||
          inside.startsWith(".." + sep) ||
          isAbsolute(inside) ||
          actual !== requested
        )
          throw new DomainError(403, "Presentation artifact unavailable.");
        const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
            throw new DomainError(403, "Presentation artifact unavailable.");
          if (
            createHash("sha256").update(readFileSync(fd)).digest("hex") !==
            scene.artifact.sha256
          )
            throw new DomainError(
              409,
              "Presentation artifact changed; prepare a new scene.",
            );
        } finally {
          closeSync(fd);
        }
      }
  }
  async prepare(raw: string, taskId: string, input: unknown) {
    const session = this.tasks.authenticate(raw);
    const value = z
      .object({
        eventId: identity,
        manifest: taskPresentationManifestSchema,
        grant: taskPresentationGrantSchema,
      })
      .strict()
      .parse(input);
    if (
      value.manifest.taskId !== taskId ||
      !isDeepStrictEqual(value.manifest, this.authorized.manifest) ||
      !isDeepStrictEqual(value.grant, this.authorized.grant)
    )
      throw new DomainError(
        403,
        "An exact operator-installed presentation grant is required.",
      );
    const result = this.ledger.prepare(session, value),
      record = result.presentation;
    this.artifacts(record);
    await this.host.prepare({
      presentationId: record.id,
      manifest: record.manifest,
      grant: record.grant,
      fingerprint: record.fingerprint,
    });
    this.current(this.ledger.get(session.id, record.id));
    return record;
  }
  status(raw: string, taskId: string, presentationId: string) {
    return this.record(raw, taskId, presentationId);
  }
  authority(raw: string, taskId: string, presentationId: string) {
    const r = this.record(raw, taskId, presentationId);
    this.artifacts(r);
    return {
      presentationId: r.id,
      manifestFingerprint: r.fingerprint,
      sessionId: r.manifest.sessionId,
      taskId: r.manifest.taskId,
      runId: r.manifest.runId,
      taskRevision: r.manifest.taskRevision,
      hostId: r.grant.hostId,
      expiresAt: r.grant.expiresAt,
      active: true,
      localOnly: true,
      capture: true,
      presentation: true,
      control: false,
      nativeActivation: false,
      calls: false,
      generation: r.generation,
      state: r.state,
    };
  }
  private frame(
    record: TaskPresentationRecord,
    raw: unknown,
    sceneId: string,
  ): TaskSceneFrame {
    const frame = taskSceneFrameSchema.parse(raw),
      scene = record.manifest.scenes.find((s) => s.id === sceneId),
      now = this.clock();
    if (
      !scene ||
      frame.presentationId !== record.id ||
      frame.manifestFingerprint !== record.fingerprint ||
      frame.sceneId !== sceneId ||
      frame.generation !== record.generation ||
      !isDeepStrictEqual(frame.target, scene.target) ||
      frame.capturedAt > now + 100 ||
      now - frame.capturedAt > 1000 ||
      frame.renderedAt < frame.capturedAt ||
      frame.renderedAt > now + 100 ||
      frame.transitionCompletedAt > frame.renderedAt ||
      frame.transitionCompletedAt > frame.capturedAt
    )
      throw new DomainError(409, "Fresh exact scene output is required.");
    return frame;
  }
  /** Validate current output without replaying a previously completed scene effect. */
  async observeCurrent(raw: string, taskId: string, presentationId: string) {
    const record = this.record(raw, taskId, presentationId);
    this.artifacts(record);
    if (!record.activeSceneId || !record.frame)
      throw new DomainError(409, "No completed current scene is available.");
    const frame = this.frame(
      record,
      await this.host.observe(presentationId),
      record.activeSceneId,
    );
    const fresh = this.record(raw, taskId, presentationId);
    this.artifacts(fresh);
    if (
      fresh.generation !== record.generation ||
      fresh.activeSceneId !== record.activeSceneId ||
      frame.operationId !== record.frame.operationId ||
      !fresh.effects.some(
        (e) =>
          e.id === frame.operationId &&
          e.action === "show_scene" &&
          e.state === "done",
      )
    )
      throw new DomainError(
        409,
        "The scene changed during output verification.",
      );
    return frame;
  }
  async show(
    raw: string,
    taskId: string,
    presentationId: string,
    input: unknown,
  ) {
    const value = command.parse(input);
    let r = this.record(raw, taskId, presentationId);
    this.artifacts(r);
    if (this.busy.has(r.id))
      throw new DomainError(409, "Presentation operation is in progress.");
    const claimed = this.ledger.claim(r.id, { ...value, action: "show_scene" });
    if (claimed.replayed) return claimed.presentation;
    this.busy.add(r.id);
    r = claimed.presentation;
    try {
      const result = await this.host.show({
        presentationId: r.id,
        operationId: claimed.receipt.id,
        manifestFingerprint: r.fingerprint,
        sceneId: value.sceneId,
        generation: claimed.receipt.generation,
      });
      const fresh = this.ledger.get(r.manifest.sessionId, r.id);
      this.current(fresh);
      const frame = this.frame(fresh, result, value.sceneId);
      if (frame.operationId !== claimed.receipt.id)
        throw new DomainError(409, "Scene receipt does not match dispatch.");
      this.ledger.settle(r.id, value.eventId, { state: "done", frame });
      return this.ledger.get(r.manifest.sessionId, r.id);
    } catch {
      this.ledger.settle(r.id, value.eventId, { state: "unknown" });
      await this.stopOwned(r, "failure_" + hash(value.eventId)).catch(() => {});
      throw new DomainError(
        409,
        "Scene outcome unavailable; inspect original receipts and Stop.",
      );
    } finally {
      this.busy.delete(r.id);
    }
  }
  async narrate(
    raw: string,
    taskId: string,
    presentationId: string,
    input: unknown,
  ) {
    const value = command.parse(input);
    const r = this.record(raw, taskId, presentationId);
    this.artifacts(r);
    const prior = r.effects.find((e) => e.id === value.eventId);
    if (prior) {
      if (
        prior.action !== "narrate" ||
        prior.sceneId !== value.sceneId ||
        prior.generation !== value.expectedGeneration
      )
        throw new DomainError(409, "Narration receipt conflicts.");
      return r;
    }
    if (this.busy.has(r.id))
      throw new DomainError(409, "Presentation operation is in progress.");
    this.busy.add(r.id);
    let submitted = false;
    try {
      const observed = await this.host.observe(r.id),
        fresh = this.ledger.get(r.manifest.sessionId, r.id);
      this.current(fresh);
      const frame = this.frame(fresh, observed, value.sceneId);
      const claimed = this.ledger.claim(r.id, {
        ...value,
        action: "narrate",
        frame,
      });
      if (claimed.replayed) return claimed.presentation;
      submitted = true;
      const result = await this.host.narrate({
        presentationId: r.id,
        operationId: claimed.receipt.id,
        sceneId: value.sceneId,
        generation: claimed.receipt.generation,
        frame,
        text: r.manifest.scenes.find((s) => s.id === value.sceneId)!.narration,
      });
      if (
        result.completed !== true ||
        result.evidence !== "playback_completed_not_audibility"
      )
        throw Error();
      this.current(this.ledger.get(r.manifest.sessionId, r.id));
      this.ledger.settle(r.id, value.eventId, { state: "done" });
      return this.ledger.get(r.manifest.sessionId, r.id);
    } catch {
      if (submitted)
        this.ledger.settle(r.id, value.eventId, { state: "unknown" });
      await this.stopOwned(r, "failure_" + hash(value.eventId)).catch(() => {});
      throw new DomainError(409, "Narration unavailable; no automatic replay.");
    } finally {
      this.busy.delete(r.id);
    }
  }
  async stop(
    raw: string,
    taskId: string,
    presentationId: string,
    input: unknown,
  ) {
    const { eventId } = z.object({ eventId: identity }).strict().parse(input);
    const r = await this.stopOwned(
      this.record(raw, taskId, presentationId, true),
      eventId,
    );
    return {
      id: r.id,
      state: r.state,
      generation: r.generation,
      ...(r.stoppedAt === undefined ? {} : { stoppedAt: r.stoppedAt }),
      ...(r.cleanup ? { cleanup: r.cleanup } : {}),
    };
  }
  private async stopOwned(
    r: TaskPresentationRecord,
    eventId: string,
  ): Promise<TaskPresentationRecord> {
    if (this.stopping.has(r.id)) return this.stopping.get(r.id)!;
    const operation = (async () => {
      const stopped = this.ledger.stop(r.id, eventId);
      if (stopped.cleanup) return stopped;
      const effect = this.ledger.claim(r.id, {
        eventId: "cleanup_" + hash(eventId),
        expectedGeneration: stopped.generation,
        action: "stop",
      });
      if (effect.replayed) return effect.presentation;
      try {
        const cleanup = taskPresentationCleanupSchema.parse(
          await this.host.stop(r.id),
        );
        this.ledger.settle(r.id, effect.receipt.id, { state: "done", cleanup });
      } catch {
        this.ledger.settle(r.id, effect.receipt.id, { state: "unknown" });
        throw new DomainError(
          409,
          "Presentation cleanup unconfirmed; do not restart.",
        );
      }
      return this.ledger.get(r.manifest.sessionId, r.id);
    })();
    this.stopping.set(r.id, operation);
    try {
      return await operation;
    } finally {
      this.stopping.delete(r.id);
    }
  }
  /** Periodic task invalidation stops capture; it never starts another operation. */
  async reconcile() {
    for (const r of this.ledger.unresolved()) {
      if (r.id !== this.authorized.manifest.id) continue;
      try {
        this.artifacts(r);
      } catch {
        await this.stopOwned(r, "invalidated_" + hash(r.id)).catch(() => {});
      }
    }
  }
  async close() {
    await Promise.allSettled(
      this.ledger
        .unresolved()
        .filter((r) => r.id === this.authorized.manifest.id)
        .map((r) => this.stopOwned(r, "shutdown_" + hash(r.id))),
    );
  }
}
