import { join, relative, isAbsolute, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { hash, DomainError } from "../storage/security.js";
import { buildTaskBrief } from "../attention/task-ledger.js";
import {
  TaskDesktopCallLedger,
  type TaskDesktopCallRecord,
} from "../attention/task-desktop-call-ledger.js";
import { taskPresentationFingerprint } from "../task-presentation-contracts.js";
import {
  desktopCallRequestSchema,
  type DesktopCallsConfig,
} from "./task-desktop-calls-config.js";
import type { TaskService } from "./task-service.js";
import type { TaskEngine } from "./task-engine.js";
import type {
  TaskVoiceService,
  TaskVoicePresentationPort,
} from "./task-voice-service.js";
import type { TaskVoiceLedger } from "../attention/task-voice-ledger.js";
import type { DesktopControlPort } from "./task-desktop-service.js";
import {
  runHandsetAttempt,
  type HandsetConfig,
  type SharedHandsetOwner,
} from "./task-handset-runtime.js";
import { readDesktopPrivateBytes } from "./task-desktop-config.js";

export type DesktopHandsetAttempt = Awaited<
  ReturnType<typeof runHandsetAttempt>
>;
export type DesktopAttemptFactory = (
  config: HandsetConfig,
  path: string,
  owner: SharedHandsetOwner,
) => Promise<DesktopHandsetAttempt>;
const inert = {
  controlId: null,
  callActive: false,
  sharingActive: false,
  canStopCall: false,
  canStopSharing: false,
};

/** One service owner, one worker, one call attempt. No dispatch occurs without a new operator envelope. */
export class TaskDesktopCalls implements DesktopControlPort {
  readonly ledger: TaskDesktopCallLedger;
  presentationPort?: TaskVoicePresentationPort;
  selectedTaskId?: () => string | undefined;
  private active?: DesktopHandsetAttempt;
  private pending?: Promise<void>;
  private pendingRecord?: TaskDesktopCallRecord;
  private stopPending = false;
  private closing = false;
  constructor(
    readonly tasks: TaskService,
    readonly engine: TaskEngine,
    readonly voices: TaskVoiceLedger,
    readonly voice: TaskVoiceService,
    readonly options: {
      config: DesktopCallsConfig;
      configPath: string;
      stateDirectory: string;
      projectRoot: string;
      sessionPath: string;
      sessionToken: string;
      checksPath: string;
      operatorToken: string;
    },
    private factory: DesktopAttemptFactory = runHandsetAttempt,
  ) {
    this.ledger = new TaskDesktopCallLedger(
      tasks.store,
      tasks.vault,
      tasks.ledger,
    );
  }
  snapshot() {
    return (
      this.active?.controls.snapshot() ??
      (this.pending && this.pendingRecord
        ? {
            ...inert,
            controlId: this.pendingRecord.attemptId,
            canStopCall: !this.stopPending,
          }
        : { ...inert })
    );
  }
  async stopSharing(controlId: string, eventId: string) {
    if (!this.active) throw new DomainError(409, "No owned call is available.");
    await this.active.controls.stopSharing(controlId, eventId);
  }
  async stopCall(controlId: string, eventId: string) {
    if (
      !this.active &&
      this.pending &&
      this.pendingRecord?.attemptId === controlId
    ) {
      this.stopPending = true;
      return; // Accepted cancellation of preparation; never subsequently start this attempt.
    }
    if (!this.active) throw new DomainError(409, "No owned call is available.");
    await this.active.controls.stopCall(controlId, eventId);
  }
  private publicRecord(r: TaskDesktopCallRecord) {
    return {
      id: r.id,
      eventId: r.eventId,
      taskId: r.taskId,
      runId: r.runId,
      revision: r.expectedRevision,
      callKind: r.callKind,
      state: r.state,
      cleanupConfirmed: r.cleanupConfirmed,
    };
  }
  status() {
    const session = this.tasks.authenticate(this.options.sessionToken);
    const records = this.ledger.list(session.id);
    const unresolved = this.ledger.unresolved();
    const selected = this.selectedTaskId?.();
    const task = selected
      ? this.tasks.ledger.get(session.id, selected)
      : undefined;
    const ready =
      task &&
      ["needs_decision", "review_ready"].includes(task.state) &&
      !this.tasks.readiness(this.options.sessionToken, task.id).blockedReasons
        .length;
    return {
      state: unresolved.some((r) => r.state === "unknown")
        ? "reconciliation_required"
        : this.active
          ? "in_call"
          : this.pending
            ? "preparing"
            : ready
              ? "awaiting_call_authorization"
              : "waiting_for_result",
      message: unresolved.some((r) => r.state === "unknown")
        ? "A previous call outcome needs reconciliation. It will not be repeated."
        : this.active
          ? "The prepared call is active. Coding continues independently."
          : this.pending
            ? "Preparing the authorized call."
            : ready
              ? "The result is ready for a prepared call. Fresh call authorization is required."
              : "Calls wait for a verified result or a product decision.",
      current: ready
        ? {
            taskId: task.id,
            runId: task.runs.at(-1)!.id,
            revision: task.revision,
            brief: buildTaskBrief(task),
            verificationId: task.verification?.id,
          }
        : null,
      attempts: records.slice(-20).map((r) => this.publicRecord(r)),
    };
  }
  request(input: unknown) {
    if (this.closing)
      throw new DomainError(409, "Desktop call service is stopping.");
    const request = desktopCallRequestSchema.parse(input);
    const session = this.tasks.authenticate(this.options.sessionToken);
    const requestFingerprint = hash(JSON.stringify(request));
    const prior = this.ledger
      .list(session.id)
      .find((r) => r.eventId === request.eventId);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint)
        throw new DomainError(409, "Call request conflicts with its receipt.");
      return { attempt: this.publicRecord(prior), replayed: true };
    }
    if (request.prepared.grant.continuity !== "call")
      throw new DomainError(
        403,
        "New desktop calls require persistent call-scoped sharing.",
      );
    if (this.pending || this.active || this.ledger.unresolved().length)
      throw new DomainError(
        409,
        "The previous call has not completed cleanup.",
      );
    if (
      this.tasks.options.simulation ||
      !session.permissions.voice ||
      this.tasks.readiness(this.options.sessionToken, request.taskId)
        .blockedReasons.length
    )
      throw new DomainError(
        409,
        "A paired task with a known result and clean call state is required.",
      );
    const task = this.tasks.ledger.get(session.id, request.taskId);
    if (this.selectedTaskId?.() !== task.id)
      throw new DomainError(
        409,
        "The call must belong to the task selected in the desktop panel.",
      );
    const brief = buildTaskBrief(task),
      { manifest: m, grant: g } = request.prepared;
    const fingerprint = taskPresentationFingerprint(m),
      now = Date.now();
    if (
      m.sessionId !== session.id ||
      m.taskId !== request.taskId ||
      m.runId !== request.runId ||
      m.taskRevision !== request.expectedRevision ||
      m.verificationId !== task.verification?.id ||
      m.opening !== brief.opening ||
      m.kind !== brief.kind ||
      g.manifestFingerprint !== fingerprint ||
      g.sessionId !== session.id ||
      g.taskId !== m.taskId ||
      g.runId !== m.runId ||
      g.taskRevision !== m.taskRevision ||
      g.hostId !== session.hostId ||
      g.authorizedAt > now ||
      g.expiresAt <= now ||
      g.expiresAt > session.expiresAt ||
      g.expiresAt < request.authorizedAt + request.callDurationMs
    )
      throw new DomainError(
        409,
        "Prepared views and grants must match the exact current verified result.",
      );
    this.validatePaths();
    const claim = this.ledger.claim(session.id, {
      eventId: request.eventId,
      taskId: request.taskId,
      runId: request.runId,
      expectedRevision: request.expectedRevision,
      manifestFingerprint: fingerprint,
      requestFingerprint,
      authorizationId: request.authorizationId,
      authorizedAt: request.authorizedAt,
      expiresAt: request.expiresAt,
    });
    const c = this.options.config,
      record = claim.record;
    this.pendingRecord = record;
    this.stopPending = false;
    const config: HandsetConfig = {
      mode: "handset_walkthrough",
      stateDirectory: this.options.stateDirectory,
      desktopPanel: false,
      sessionFile: this.options.sessionPath,
      taskId: task.id,
      projectRoot: this.options.projectRoot,
      attemptDirectory: join(c.attemptRoot, record.attemptId),
      providerFile: c.providerFile,
      livekitFile: c.livekitFile,
      inspectorBundle: c.inspectorBundle,
      python: c.python,
      native: c.native,
      destination: c.destination,
      railway: { ...c.railway, ...request.standby },
      ...(c.ports ? { ports: c.ports } : {}),
      authorization: {
        id: request.authorizationId,
        userAuthorizedOneCall: true,
      },
      walkthrough: {
        presentationFile: this.options.configPath,
        helperBinary: c.helperBinary,
        checksFile: this.options.checksPath,
        callDurationMs: request.callDurationMs,
        userAuthorizedPreparedWindowExport: true,
        userAuthorizedTaskInstructions: true,
      },
    };
    // Durable claim precedes voice admission, subprocess creation, capture and all external effects.
    this.pending = Promise.resolve()
      .then(async () => {
        try {
          const attempt = await this.factory(config, this.options.configPath, {
            tasks: this.tasks,
            engine: this.engine,
            voices: this.voices,
            voice: this.voice,
            sessionToken: this.options.sessionToken,
            operatorToken: this.options.operatorToken,
            attemptId: record.attemptId,
            prepared: request.prepared,
            authorizedAt: request.authorizedAt,
            dispatchExpiresAt: request.expiresAt,
            bindPresenter: (value) => {
              this.presentationPort = value;
            },
          });
          this.active = attempt;
          this.ledger.markActive(record.id);
          if (this.closing || this.stopPending)
            await attempt.stop("desktop_preparation_stopped");
          else await attempt.start();
          await attempt.finished;
          this.ledger.complete(record.id, {
            cleanupConfirmed: true,
            outcome: "closed",
          });
          this.active = undefined;
          this.presentationPort = undefined;
          this.pendingRecord = undefined;
        } catch {
          // An exception does not establish that native/media effects were absent or cleaned up.
          this.ledger.markUnknown(record.id);
        }
      })
      .finally(() => {
        this.pending = undefined;
      });
    return { attempt: this.publicRecord(record), replayed: false };
  }
  private validatePaths() {
    const c = this.options.config;
    const root = realpathSync(this.options.projectRoot);
    const outside = (path: string) => {
      const p = relative(root, realpathSync(path));
      if (!p || (p !== ".." && !p.startsWith(".." + sep) && !isAbsolute(p)))
        throw Error(
          "Call configuration and attempt state must remain outside the worker project.",
        );
    };
    for (const path of [
      this.options.configPath,
      this.options.sessionPath,
      this.options.checksPath,
      c.providerFile,
      c.livekitFile,
    ]) {
      outside(path);
      readDesktopPrivateBytes(path);
    }
    for (const path of [
      c.python,
      c.helperBinary,
      c.inspectorBundle,
      c.railway.binary,
    ]) {
      outside(path);
      const stat = lstatSync(realpathSync(path));
      if (!stat.isFile() || stat.mode & 0o022)
        throw Error(
          "Call executables and inspector must be protected from worker modification.",
        );
    }
    outside(c.attemptRoot);
    const stat = lstatSync(c.attemptRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw Error("An existing owner-only call attempt directory is required.");
    if (
      c.native.lineId !== c.destination.lineId ||
      hash(c.native.recipient) !== c.destination.recipientHash
    )
      throw Error("Call destination binding differs.");
  }
  async close() {
    this.closing = true;
    await this.active?.stop("desktop_service_shutdown");
    if (this.pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error(
                    "Call cleanup remains unresolved; preserve service ownership.",
                  ),
                ),
              10_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (this.ledger.unresolved().length)
      throw Error("Unresolved call receipts require reconciliation.");
  }
}
