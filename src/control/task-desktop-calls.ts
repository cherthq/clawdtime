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
  policyDesktopCallRequestSchema,
  type DesktopCallsConfig,
  type DesktopCallRequest,
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
import type { ProactiveCallCoordinator } from "../attention/proactive-coordinator.js";
import type { ProactiveReviewPacket } from "./proactive-preparation.js";
import type { TaskReviewCallbackLedger } from "../attention/task-review-callback-ledger.js";

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
  reviews?: TaskReviewCallbackLedger;
  proactive?: {
    coordinator: ProactiveCallCoordinator;
    packet(intentId: string): ProactiveReviewPacket | undefined;
  };
  executionOwnership?: {
    acquireReviewOwnership(attemptId: string): void;
    confirmReviewOwnership?(): Promise<void>;
    releaseReviewOwnership(attemptId: string): void;
  };
  private active?: DesktopHandsetAttempt;
  private pending?: Promise<void>;
  private pendingRecord?: TaskDesktopCallRecord;
  private stopPending = false;
  private closing = false;
  reconcileReview() {
    const record = this.pendingRecord;
    if (
      record?.policyIntentId &&
      this.proactive &&
      this.active?.status().connectedOnce
    ) {
      const intent = this.proactive.coordinator.get(record.policyIntentId);
      if (intent.state === "dispatching")
        this.proactive.coordinator.outcome(
          intent.id,
          record.attemptId,
          "connected",
        );
    }
    if (!record || !this.reviews || !this.active?.status().connectedOnce)
      return;
    const callback = this.reviews
      .list(record.sessionId, record.taskId)
      .find((r) => r.attemptId === record.attemptId);
    if (callback?.state === "dispatching")
      this.reviews.outcome(
        record.sessionId,
        callback.id,
        record.attemptId,
        "in_review",
      );
  }
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
      attemptId: r.attemptId,
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
  requestPolicy(input: unknown) {
    return this.request(policyDesktopCallRequestSchema.parse(input));
  }
  async waitForAttempt(attemptId: string) {
    const session = this.tasks.authenticate(this.options.sessionToken);
    const before = this.ledger
      .list(session.id)
      .find((record) => record.attemptId === attemptId);
    if (!before)
      throw new DomainError(404, "Exact desktop attempt is unavailable.");
    if (this.pendingRecord?.attemptId === attemptId && this.pending)
      await this.pending;
    const record = this.ledger.get(session.id, before.id);
    return {
      state:
        record.state === "closed"
          ? ("ended" as const)
          : record.state === "failed"
            ? ("refused" as const)
            : ("unknown" as const),
      cleanupConfirmed: record.cleanupConfirmed,
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
    const policyRequest = "policyAttempt" in request;
    if (
      !policyRequest &&
      this.proactive &&
      (this.proactive.coordinator.doctor().active ||
        this.proactive.coordinator.doctor().unknown.length)
    )
      throw new DomainError(
        409,
        "Shared phone ownership is active or unresolved.",
      );
    if (policyRequest) this.validatePolicyRequest(request, "admission");
    if (!policyRequest && this.selectedTaskId?.() !== task.id)
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
    let callbackId: string | undefined;
    let ownershipId: string | undefined;
    let claim: ReturnType<TaskDesktopCallLedger["claim"]>;
    try {
      claim = this.tasks.store.transaction(() => {
        const claim = this.ledger.claim(session.id, {
          eventId: request.eventId,
          taskId: request.taskId,
          runId: request.runId,
          expectedRevision: request.expectedRevision,
          manifestFingerprint: fingerprint,
          requestFingerprint,
          authorizationId: request.authorizationId,
          ...(policyRequest
            ? {
                policyAttemptId: request.policyAttempt.attemptId,
                policyGrantId: request.policyAttempt.id,
                policyIntentId: request.policyAttempt.intentId,
              }
            : {}),
          authorizedAt: request.authorizedAt,
          expiresAt: request.expiresAt,
        });
        if (this.reviews) {
          const callback = this.reviews.schedule(session.id, task.id).record;
          this.reviews.prepared(session.id, callback.id, {
            manifestFingerprint: fingerprint,
            opening: brief.opening,
          });
          this.reviews.reserve(session.id, callback.id, claim.record.attemptId);
          callbackId = callback.id;
        }
        this.executionOwnership?.acquireReviewOwnership(claim.record.attemptId);
        ownershipId = claim.record.attemptId;
        return claim;
      });
    } catch (error) {
      // No factory/effect has started. Roll back the in-memory half of a failed commit.
      if (ownershipId)
        this.executionOwnership?.releaseReviewOwnership(ownershipId);
      throw error;
    }
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
      authorization: policyRequest
        ? { version: 2, policyAttempt: request.policyAttempt }
        : { id: request.authorizationId, userAuthorizedOneCall: true },
      walkthrough: {
        presentationFile: this.options.configPath,
        helperBinary: c.helperBinary,
        checksFile: this.options.checksPath,
        callDurationMs: request.callDurationMs,
        ...(policyRequest
          ? { version: 2 as const }
          : {
              userAuthorizedPreparedWindowExport: true as const,
              userAuthorizedTaskInstructions: true as const,
            }),
      },
    };
    // Durable claim precedes voice admission, subprocess creation, capture and all external effects.
    this.pending = Promise.resolve()
      .then(async () => {
        let factoryStarted = false;
        try {
          await this.executionOwnership?.confirmReviewOwnership?.();
          if (this.closing || this.stopPending)
            throw Error("Review preparation stopped before effects.");
          factoryStarted = true;
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
            ...(policyRequest
              ? {
                  policy: {
                    grant: request.policyAttempt,
                    assertCurrent: (phase: "initial" | "ongoing") =>
                      this.validatePolicyRequest(request, phase),
                  },
                }
              : {}),
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
          const connected = attempt.status().connectedOnce === true;
          this.tasks.store.transaction(() => {
            this.ledger.complete(record.id, {
              cleanupConfirmed: true,
              outcome: "closed",
            });
            if (callbackId)
              this.reviews!.outcome(
                session.id,
                callbackId,
                record.attemptId,
                connected ? "delivered" : "failed",
              );
          });
          if (policyRequest)
            this.proactive!.coordinator.outcome(
              request.policyAttempt.intentId,
              record.attemptId,
              "ended",
              { cleanupConfirmed: true },
            );
          if (ownershipId)
            this.executionOwnership?.releaseReviewOwnership(ownershipId);
          this.active = undefined;
          this.presentationPort = undefined;
          this.pendingRecord = undefined;
        } catch {
          if (!factoryStarted) {
            this.tasks.store.transaction(() => {
              this.ledger.complete(record.id, {
                cleanupConfirmed: true,
                outcome: "failed",
              });
              if (callbackId)
                this.reviews!.outcome(
                  session.id,
                  callbackId,
                  record.attemptId,
                  "failed",
                );
            });
            if (ownershipId)
              this.executionOwnership?.releaseReviewOwnership(ownershipId);
            if (policyRequest)
              this.proactive!.coordinator.outcome(
                request.policyAttempt.intentId,
                record.attemptId,
                "refused",
                { cleanupConfirmed: true },
              );
            this.pendingRecord = undefined;
            return;
          }
          // An exception does not establish that native/media effects were absent or cleaned up.
          const settled = this.ledger
            .list(session.id)
            .find((r) => r.id === record.id);
          if (settled && !settled.cleanupConfirmed)
            this.tasks.store.transaction(() => {
              this.ledger.markUnknown(record.id);
              if (policyRequest)
                this.proactive!.coordinator.outcome(
                  request.policyAttempt.intentId,
                  record.attemptId,
                  "unknown",
                );
              if (callbackId)
                this.reviews!.outcome(
                  session.id,
                  callbackId,
                  record.attemptId,
                  "unknown",
                );
            });
        }
      })
      .finally(() => {
        this.pending = undefined;
      });
    return { attempt: this.publicRecord(record), replayed: false };
  }
  private validatePolicyRequest(
    request: Extract<DesktopCallRequest, { version: 2 }>,
    phase: "admission" | "initial" | "ongoing",
  ) {
    const p = this.proactive,
      grant = request.policyAttempt;
    if (!p || !p.coordinator.authority.validateGrant(grant))
      throw new DomainError(403, "Current policy attempt authority required.");
    const intent = p.coordinator.get(grant.intentId),
      session = this.tasks.authenticate(this.options.sessionToken);
    const source = grant.source,
      task = this.tasks.ledger.get(session.id, request.taskId);
    if (
      source.kind !== "task" ||
      grant.channel !== "phone_walkthrough" ||
      intent.grantId !== grant.id ||
      intent.attemptId !== grant.attemptId ||
      !["dispatching", "connected"].includes(intent.state) ||
      grant.scope.personId !== session.memberId ||
      grant.scope.deviceId !== session.deviceId ||
      grant.scope.projectRoot !== session.projectRoot ||
      grant.scope.sessionId !== session.id ||
      grant.scope.taskId !== task.id ||
      request.authorizationId !== grant.id ||
      request.authorizedAt !== grant.issuedAt ||
      request.expiresAt > grant.expiresAt ||
      request.authorizedAt + request.callDurationMs > grant.expiresAt ||
      source.sessionId !== session.id ||
      source.taskId !== task.id ||
      source.runId !== request.runId ||
      source.revision !== request.expectedRevision
    )
      throw new DomainError(
        403,
        "Policy call context differs from the exact task attempt.",
      );
    if (
      phase !== "ongoing" &&
      (task.runs.at(-1)?.id !== source.runId ||
        task.revision !== source.revision ||
        task.verification?.id !== source.verificationId)
    )
      throw new DomainError(409, "Policy call result is no longer current.");
    const packet = p.packet(intent.id);
    if (
      !packet ||
      packet.fingerprint !== grant.packetFingerprint ||
      packet.source.kind !== "task" ||
      packet.source.taskId !== source.taskId ||
      packet.source.runId !== source.runId ||
      packet.source.revision !== source.revision ||
      packet.source.verificationId !== source.verificationId
    )
      throw new DomainError(
        403,
        "Exact policy-authorized preparation packet required.",
      );
    if (phase === "admission" && packet.expiresAt <= Date.now())
      throw new DomainError(409, "Policy prepared frames are stale.");
    const manifest = request.prepared.manifest;
    if (packet.views.length !== manifest.scenes.length)
      throw new DomainError(
        403,
        "Policy packet must bind every prepared scene.",
      );
    for (const scene of manifest.scenes) {
      const view = packet.views.find(
        (v) => v.id === scene.id && v.windowId === scene.target.windowId,
      );
      const exact = `window:${scene.target.appId}:${scene.target.windowId}:${scene.target.processIdentity}`;
      if (
        !view ||
        !grant.viewScope.includes(view.scope) ||
        ![
          exact,
          `presentation:${manifest.id}`,
          ...(scene.target.appId === "com.clawdtime.review-view"
            ? ["prepared-review"]
            : []),
        ].includes(view.scope) ||
        (scene.artifact && scene.artifact.sha256 !== view.artifactDigest)
      )
        throw new DomainError(
          403,
          "Prepared scene exceeds exact policy view scope.",
        );
    }
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
