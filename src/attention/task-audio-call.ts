import { z } from "zod";
import { DomainError, Vault } from "../storage/security.js";
import { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import {
  taskHandsetFingerprint,
  taskWalkthroughVideoEvidenceSchema,
  parseTaskHandsetPlan,
  validateTaskAudioCredentials,
  type TaskHandsetAuthorization,
  type TaskAudioCredentials,
  type TaskHandsetMediaObservation,
  type TaskHandsetPlan,
  type TaskHandsetPorts,
  type TaskHandsetReadiness,
} from "../transport/task-audio.js";

import {
  isTaskWalkthroughPlan,
  taskWalkthroughAuthorizationSchema,
  taskWalkthroughPresentationBindingSchema,
} from "../task-walkthrough-contracts.js";
import type { TaskVoiceSession, CodingTask } from "../contracts.js";

const KIND = "coding-task-audio-call-v1";
type Phase =
  | "media_prepare"
  | "native_dial"
  | "media_activate"
  | "native_end"
  | "media_close";
interface PhaseReceipt {
  id: string;
  state: "running" | "done" | "unknown";
  startedAt: number;
  completedAt?: number;
  failure?: "effect_outcome_unresolved";
}
export interface TaskAudioActivationDiagnostic {
  phase:
    | "activation_native_read"
    | "activation_authority_1"
    | "activation_authority_2"
    | "activation_native_refresh"
    | "activation_budget";
  state: "started" | "passed" | "refused" | "unavailable";
  at: number;
  elapsedMs?: number;
}
interface AudioCallRecord {
  id: string;
  plan: TaskHandsetPlan;
  fingerprint: string;
  authorization: TaskHandsetAuthorization;
  state:
    | "authorized"
    | "preparing"
    | "prepared"
    | "dialing"
    | "ringing"
    | "activating"
    | "connected"
    | "stopping"
    | "closed"
    | "unknown";
  receipts: Partial<Record<Phase, PhaseReceipt>>;
  diagnostics?: TaskAudioActivationDiagnostic[];
  credentials?: TaskAudioCredentials;
  providerCallId?: string;
  stopRequested: boolean;
  mediaClosed: boolean;
  nativeCleanupComplete: boolean;
  nativeObservation?: {
    providerCallId: string;
    state: "allocated" | "connected" | "terminal";
    cleanupComplete: boolean;
    remoteVideoReady?: boolean;
    observedAt: number;
  };
  updatedAt: number;
}
export interface TaskAudioCallStatus {
  id: string;
  taskId: string;
  taskSessionId: string;
  voiceSessionId: string;
  state: AudioCallRecord["state"];
  fingerprint: string;
  receipts: AudioCallRecord["receipts"];
  providerCallId?: string;
  stopRequested: boolean;
  mediaClosed: boolean;
  nativeCleanupComplete: boolean;
  cleanupConfirmed: boolean;
  nativeVideo?: {
    remoteDecoded: boolean;
    observedAt: number;
    evidence: "worker_remote_video_ready_not_human_seen";
  };
  physicalAcceptance: false;
  diagnostics: TaskAudioActivationDiagnostic[];
}
export function unresolvedTaskAudioCalls(store: Store, vault: Vault) {
  return new ProtectedTaskStore<AudioCallRecord>(store, vault, KIND)
    .all()
    .filter((record) => record.state !== "closed")
    .map((record) => ({
      id: record.id,
      state: record.state,
      taskSessionId: record.plan.taskSessionId,
      taskId: record.plan.taskId,
    }));
}

/** Local protected receipts only; this never performs a network read or revives an unknown call. */
export function hasConnectedTaskWalkthroughCall(
  store: Store,
  vault: Vault,
  plan: TaskHandsetPlan,
  now = Date.now(),
): boolean {
  if (!isTaskWalkthroughPlan(plan)) return false;
  const record = new ProtectedTaskStore<AudioCallRecord>(
    store,
    vault,
    KIND,
  ).get(plan.id);
  const proof = record?.nativeObservation;
  return (
    !!record &&
    record.fingerprint === taskHandsetFingerprint(plan) &&
    record.fingerprint === taskHandsetFingerprint(record.plan) &&
    record.state === "connected" &&
    !record.stopRequested &&
    !record.mediaClosed &&
    !record.nativeCleanupComplete &&
    record.plan.expiresAt > now &&
    record.receipts.native_dial?.state === "done" &&
    record.receipts.media_activate?.state === "done" &&
    Object.values(record.receipts).every(
      (receipt) => receipt.state === "done",
    ) &&
    !!proof &&
    proof.providerCallId === record.providerCallId &&
    proof.state === "connected" &&
    !proof.cleanupComplete &&
    proof.observedAt <= now &&
    now - proof.observedAt <= 5000
  );
}
export function assertConnectedTaskWalkthroughVoice(
  store: Store,
  vault: Vault,
  voice: TaskVoiceSession,
  now = Date.now(),
): void {
  if (voice.mode !== "handset_walkthrough") return;
  const record = new ProtectedTaskStore<AudioCallRecord>(
    store,
    vault,
    KIND,
  ).get(voice.callAttemptId);
  const plan = record?.plan;
  if (
    !plan ||
    !isTaskWalkthroughPlan(plan) ||
    plan.taskSessionId !== voice.sessionId ||
    plan.taskId !== voice.taskId ||
    plan.voiceSessionId !== voice.id ||
    plan.exportGrantId !== voice.exportGrantId ||
    plan.presentationBinding.presentationId !== voice.presentationId ||
    plan.presentationBinding.manifestFingerprint !==
      voice.manifestFingerprint ||
    !hasConnectedTaskWalkthroughCall(store, vault, plan, now)
  )
    throw new DomainError(
      403,
      "A fresh exact connected walkthrough call is required.",
    );
}

/** Acceptance is scoped to the reviewed result of this particular review call. */
export function assertConnectedTaskWalkthroughReview(
  store: Store,
  vault: Vault,
  voice: TaskVoiceSession,
  task: CodingTask,
  now = Date.now(),
): void {
  assertConnectedTaskWalkthroughVoice(store, vault, voice, now);
  if (voice.mode !== "handset_walkthrough")
    throw new DomainError(403, "An exact walkthrough review call is required.");
  const record = new ProtectedTaskStore<AudioCallRecord>(
      store,
      vault,
      KIND,
    ).get(voice.callAttemptId),
    plan = record?.plan;
  if (
    !plan ||
    !isTaskWalkthroughPlan(plan) ||
    plan.callKind !== "review" ||
    plan.runId !== task.runs.at(-1)!.id ||
    plan.revision !== task.revision ||
    plan.presentationBinding.verificationId !== task.verification?.id ||
    task.verification?.runId !== plan.runId ||
    task.verification.state !== "passed"
  )
    throw new DomainError(
      403,
      "A fresh final review call for this exact verified result is required.",
    );
}

/** Offline-ready c.1 coordinator. Default disabled; no startup scheduling, retries or legacy session grants. */
export class TaskAudioCallCoordinator {
  private readonly records: ProtectedTaskStore<AudioCallRecord>;
  private readonly clock: () => number;
  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly ports: TaskHandsetPorts,
    private readonly options: {
      dispatchEnabled?: boolean;
      environment?: "simulation" | "native";
      clock?: () => number;
    } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.records = new ProtectedTaskStore(store, vault, KIND);
    store.transaction(() => {
      for (const record of this.records.all()) {
        let interrupted = false;
        for (const receipt of Object.values(record.receipts))
          if (receipt.state === "running") {
            receipt.state = "unknown";
            receipt.failure = "effect_outcome_unresolved";
            interrupted = true;
          }
        if (
          interrupted ||
          ["ringing", "connected", "activating"].includes(record.state)
        ) {
          record.state = "unknown";
          record.updatedAt = this.clock();
          this.records.put(record);
        }
      }
    });
  }

  reserve(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
  ): TaskAudioCallStatus {
    const parsed = parseTaskHandsetPlan(plan),
      fingerprint = taskHandsetFingerprint(parsed);
    this.validateAuthorization(parsed, authorization, fingerprint);
    return this.store.transaction(() => {
      const prior = this.records.get(parsed.id);
      if (prior) {
        if (
          prior.fingerprint !== fingerprint ||
          JSON.stringify(prior.authorization) !== JSON.stringify(authorization)
        )
          throw new DomainError(409, "One-call admission identity conflicts.");
        return this.project(prior);
      }
      if (this.records.all().some((record) => record.state !== "closed"))
        throw new DomainError(
          409,
          "An existing or unknown call still reserves audio admission.",
        );
      if (
        this.records
          .all()
          .some((record) => record.authorization.id === authorization.id)
      )
        throw new DomainError(
          409,
          "One-call authorization was already consumed.",
        );
      return this.project(
        this.records.put({
          id: parsed.id,
          plan: parsed,
          fingerprint,
          authorization: structuredClone(authorization),
          state: "authorized",
          receipts: {},
          stopRequested: false,
          mediaClosed: false,
          nativeCleanupComplete: false,
          updatedAt: this.clock(),
        }),
      );
    });
  }

  status(id: string) {
    return this.project(this.get(id));
  }

  /** GET/read-only ports only; no media room, dial, activation, end or automatic admission. */
  async preflight(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
  ) {
    const fingerprint = taskHandsetFingerprint(plan);
    this.validateAuthorization(plan, authorization, fingerprint);
    await this.ports.authorize(plan, authorization);
    const evidence = await this.ports.readiness(plan, authorization);
    this.validateReadiness(plan, fingerprint, evidence);
    await this.ports.authorize(plan, authorization);
    this.validateAuthorization(plan, authorization, fingerprint);
    return {
      ready: true,
      dispatchEnabled: this.options.dispatchEnabled === true,
      readinessSource: evidence.source,
      checkedAt: evidence.checkedAt,
      fingerprint,
      physicalAcceptance: false,
      productionQualified: false,
      permissions: {
        audio: true,
        video: plan.video,
        screen: plan.screen,
        presentation: plan.presentation,
        control: false,
      },
    };
  }

  async prepare(id: string) {
    const record = this.get(id);
    if (record.receipts.media_prepare) return this.project(record);
    if (record.state !== "authorized")
      throw new DomainError(409, "Call is not ready for media preparation.");
    await this.admit(record, true);
    return this.effect(
      id,
      "media_prepare",
      "preparing",
      (current, effectId) => this.ports.media.prepare(current.plan, effectId),
      (current, result) => {
        this.validateMedia(current.plan, result, "prepared");
        if (
          result.silentPublisherReady !== true ||
          (isTaskWalkthroughPlan(current.plan) &&
            result.videoPublisherReady !== true)
        )
          throw new Error("Audio publisher is not ready.");
        this.validateVideoReady(current.plan, result);
        const credentials = validateTaskAudioCredentials(result.credentials);
        if (
          credentials.remote_participant_identity !== current.plan.agentIdentity
        )
          throw new Error("Outgoing participant identity mismatch.");
        current.credentials = credentials;
        if (!current.stopRequested) current.state = "prepared";
        else {
          current.mediaClosed = false;
          current.state = "unknown";
        }
      },
    );
  }

  async dial(id: string) {
    const record = this.get(id);
    if (record.receipts.native_dial) return this.project(record);
    if (
      record.state !== "prepared" ||
      record.receipts.media_prepare?.state !== "done" ||
      !record.credentials
    )
      throw new DomainError(
        409,
        "Exact audio preparation must complete before dialing.",
      );
    await this.admit(record, true);
    return this.effect(
      id,
      "native_dial",
      "dialing",
      (current, effectId) =>
        this.ports.calls.create(current.plan, current.credentials!, effectId),
      (current, result) => {
        z.string().uuid().parse(result.providerCallId);
        if (result.lineId !== current.plan.lineId)
          throw new Error("Native line identity mismatch.");
        current.providerCallId = result.providerCallId;
        if (!current.stopRequested) current.state = "ringing";
      },
    );
  }

  async activate(id: string) {
    const record = this.get(id);
    if (record.receipts.media_activate) return this.project(record);
    if (
      record.state !== "ringing" ||
      record.receipts.native_dial?.state !== "done" ||
      !record.providerCallId
    )
      throw new DomainError(
        409,
        "Only the exact allocated call can activate audio.",
      );
    const confirmConnected = async () => {
      const native = await this.ports.calls.inspect(
        record.plan,
        record.providerCallId!,
      );
      if (
        native.providerCallId !== record.providerCallId ||
        native.state !== "connected" ||
        native.cleanupComplete
      )
        throw new DomainError(409, "Native connection is not confirmed.");
      this.store.transaction(() => {
        const current = this.get(id);
        if (current.nativeObservation?.state === "terminal")
          throw new DomainError(
            409,
            "Native call already reached a terminal outcome.",
          );
        current.nativeObservation = { ...native, observedAt: this.clock() };
        this.records.put(current);
      });
    };
    await this.diagnose(id, "activation_native_read", confirmConnected);
    const confirmedAt = this.clock();
    await this.admit(record, false, true);
    await this.diagnose(id, "activation_native_refresh", confirmConnected);
    await this.diagnose(id, "activation_budget", () => {
      this.validateAuthorization(
        record.plan,
        record.authorization,
        record.fingerprint,
      );
      if (this.clock() - confirmedAt > 4000 || this.clock() < confirmedAt)
        throw new DomainError(
          409,
          "Activation admission exceeded its freshness budget.",
        );
      if (this.get(id).stopRequested)
        throw new DomainError(403, "Local Stop closed call admission.");
    });
    return this.effect(
      id,
      "media_activate",
      "activating",
      (current, effectId) =>
        this.ports.media.activate(
          current.plan,
          current.providerCallId!,
          effectId,
        ),
      (current, result) => {
        this.validateMedia(current.plan, result, "active");
        this.validateVideoReady(current.plan, result);
        if (result.providerCallId !== current.providerCallId)
          throw new Error("Media activation call differs.");
        if (!current.stopRequested) current.state = "connected";
        else {
          current.mediaClosed = false;
          current.state = "unknown";
        }
      },
    );
  }

  /** Cleanup remains available after expiry/revocation, but only for already-owned exact identities. */
  async stop(id: string): Promise<TaskAudioCallStatus> {
    this.store.transaction(() => {
      const record = this.get(id);
      if (record.state === "closed") return;
      record.stopRequested = true;
      record.state = "stopping";
      record.updatedAt = this.clock();
      this.records.put(record);
    });
    const original = this.get(id);
    if (original.state === "closed") return this.project(original);
    const operations: Promise<TaskAudioCallStatus>[] = [];
    if (original.receipts.media_prepare && !original.receipts.media_close)
      operations.push(
        this.effect(
          id,
          "media_close",
          "stopping",
          (current, effectId) => this.ports.media.close(current.plan, effectId),
          (current, result) => {
            this.validateMedia(current.plan, result, "closed");
            current.mediaClosed = true;
          },
          true,
        ),
      );
    if (original.providerCallId && !original.receipts.native_end)
      operations.push(
        this.effect(
          id,
          "native_end",
          "stopping",
          (current, effectId) =>
            this.ports.calls.end(
              current.plan,
              current.providerCallId!,
              effectId,
            ),
          (current, result) => {
            if (
              result.accepted !== true ||
              result.providerCallId !== current.providerCallId
            )
              throw new Error("Native cleanup acknowledgment differs.");
            // End submission is not cleanup_complete; a later exact GET must establish that.
          },
          true,
        ),
      );
    await Promise.allSettled(operations);
    return this.store.transaction(() => {
      const current = this.get(id);
      this.settleCleanup(current);
      this.records.put(current);
      return this.project(current);
    });
  }

  /** Reads only; uncertain effects retain their original receipts and are never replayed. */
  async inspect(id: string): Promise<TaskAudioCallStatus> {
    const original = this.get(id);
    const results = await Promise.allSettled([
      original.receipts.media_prepare
        ? this.ports.media.inspect(original.plan)
        : Promise.resolve(undefined),
      original.providerCallId
        ? this.ports.calls.inspect(original.plan, original.providerCallId)
        : Promise.resolve(undefined),
    ]);
    return this.store.transaction(() => {
      const current = this.get(id);
      if (
        current.fingerprint !== original.fingerprint ||
        current.providerCallId !== original.providerCallId
      )
        throw new DomainError(409, "Call binding changed during inspection.");
      const media = results[0],
        native = results[1];
      const mediaActorsUnchanged =
        JSON.stringify([
          current.receipts.media_prepare,
          current.receipts.media_activate,
        ]) ===
        JSON.stringify([
          original.receipts.media_prepare,
          original.receipts.media_activate,
        ]);
      if (mediaActorsUnchanged && media.status === "fulfilled" && media.value) {
        try {
          this.validateMedia(current.plan, media.value);
          if (media.value.state === "closed") current.mediaClosed = true;
          else if (current.mediaClosed) {
            current.mediaClosed = false;
            current.state = "unknown";
          }
        } catch {
          /* Contradictory reads cannot settle the retained effect. */
        }
      }
      if (
        native.status === "fulfilled" &&
        native.value &&
        native.value.providerCallId === current.providerCallId
      ) {
        if (current.nativeObservation?.state !== "terminal")
          current.nativeObservation = {
            ...native.value,
            observedAt: this.clock(),
          };
      } else if (current.nativeObservation?.state !== "terminal")
        delete current.nativeObservation;
      if (
        native.status === "fulfilled" &&
        native.value &&
        native.value.providerCallId === current.providerCallId &&
        native.value.state === "terminal" &&
        native.value.cleanupComplete === true
      )
        current.nativeCleanupComplete = true;
      this.settleCleanup(current);
      current.updatedAt = this.clock();
      this.records.put(current);
      return this.project(current);
    });
  }

  private get(id: string) {
    const record = this.records.get(id);
    if (
      !record ||
      record.plan.id !== id ||
      taskHandsetFingerprint(record.plan) !== record.fingerprint
    )
      throw new DomainError(404, "Task audio call is unavailable.");
    return record;
  }
  private requireEnabled() {
    if (this.options.dispatchEnabled !== true)
      throw new DomainError(403, "Task audio dispatch is disabled.");
  }
  private validateAuthorization(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
    fingerprint: string,
  ) {
    const now = this.clock();
    if (isTaskWalkthroughPlan(plan)) {
      const parsed =
        taskWalkthroughAuthorizationSchema.safeParse(authorization);
      if (
        !parsed.success ||
        parsed.data.planFingerprint !== fingerprint ||
        parsed.data.authorizedAt > now ||
        parsed.data.expiresAt <= now ||
        plan.dispatchExpiresAt !== parsed.data.expiresAt ||
        plan.expiresAt !== parsed.data.callExpiresAt
      )
        throw new DomainError(
          403,
          "Fresh exact walkthrough dispatch authority is required.",
        );
      return;
    }
    if ("callExpiresAt" in authorization)
      throw new DomainError(
        403,
        "Walkthrough authority cannot authorize audio smoke.",
      );
    if (
      !authorization ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(authorization.id) ||
      authorization.oneCallAuthorized !== true ||
      authorization.planFingerprint !== fingerprint ||
      !Number.isFinite(authorization.authorizedAt) ||
      !Number.isFinite(authorization.expiresAt) ||
      authorization.authorizedAt > now ||
      authorization.expiresAt <= now ||
      authorization.expiresAt > authorization.authorizedAt + 300_000 ||
      plan.expiresAt <= now ||
      plan.expiresAt > authorization.expiresAt
    )
      throw new DomainError(
        403,
        "Fresh exact one-call authorization is required.",
      );
  }
  private validateReadiness(
    plan: TaskHandsetPlan,
    fingerprint: string,
    evidence: TaskHandsetReadiness,
  ) {
    if (
      !evidence ||
      (isTaskWalkthroughPlan(plan) &&
        (evidence.videoReady !== true ||
          evidence.presentationReady !== true)) ||
      evidence.planFingerprint !== fingerprint ||
      evidence.lineId !== plan.lineId ||
      evidence.pairingId !== plan.pairingId ||
      evidence.memberId !== plan.memberId ||
      evidence.deviceId !== plan.deviceId ||
      evidence.recipientHash !== plan.recipientHash ||
      !Number.isFinite(evidence.checkedAt) ||
      evidence.checkedAt > this.clock() + 1000 ||
      this.clock() - evidence.checkedAt > 10_000 ||
      [
        evidence.idle,
        evidence.exclusiveOwner,
        evidence.identityVerified,
        evidence.cursorPreserved,
        evidence.cleanupClear,
        evidence.audioReady,
      ].some((value) => value !== true) ||
      evidence.source !==
        ((this.options.environment ?? "simulation") === "native"
          ? "operator_verified_native"
          : "synthetic")
    )
      throw new DomainError(
        403,
        "Fresh exact idle and exclusive audio readiness is required.",
      );
  }
  private async admit(
    record: AudioCallRecord,
    readiness: boolean,
    activation = false,
  ) {
    this.requireEnabled();
    const first = async () => {
      this.validateAuthorization(
        record.plan,
        record.authorization,
        record.fingerprint,
      );
      await this.ports.authorize(record.plan, record.authorization);
    };
    if (activation)
      await this.diagnose(record.id, "activation_authority_1", first);
    else await first();
    if (readiness)
      this.validateReadiness(
        record.plan,
        record.fingerprint,
        await this.ports.readiness(record.plan, record.authorization),
      );
    const second = async () => {
      await this.ports.authorize(record.plan, record.authorization);
      this.validateAuthorization(
        record.plan,
        record.authorization,
        record.fingerprint,
      );
      if (this.get(record.id).stopRequested)
        throw new DomainError(403, "Local Stop closed call admission.");
    };
    if (activation)
      await this.diagnose(record.id, "activation_authority_2", second);
    else await second();
  }
  private async diagnose<T>(
    id: string,
    phase: TaskAudioActivationDiagnostic["phase"],
    work: () => Promise<T> | T,
  ): Promise<T> {
    const started = this.clock();
    const append = (state: TaskAudioActivationDiagnostic["state"]) =>
      this.store.transaction(() => {
        const record = this.get(id),
          at = this.clock();
        record.diagnostics = [
          ...(record.diagnostics ?? []),
          {
            phase,
            state,
            at,
            ...(state === "started"
              ? {}
              : { elapsedMs: Math.max(0, at - started) }),
          },
        ].slice(-32);
        this.records.put(record);
      });
    append("started");
    try {
      const result = await work();
      append("passed");
      return result;
    } catch (error) {
      append(error instanceof DomainError ? "refused" : "unavailable");
      throw error;
    }
  }
  private validateVideoReady(
    plan: TaskHandsetPlan,
    result: TaskHandsetMediaObservation,
  ) {
    if (!isTaskWalkthroughPlan(plan)) return;
    const frame =
      "videoEvidence" in result
        ? taskWalkthroughVideoEvidenceSchema.parse(result.videoEvidence)
        : undefined;
    if (
      !frame ||
      !("sharingActive" in result) ||
      !result.sharingActive ||
      frame.presentationId !== plan.presentationBinding.presentationId ||
      frame.manifestFingerprint !==
        plan.presentationBinding.manifestFingerprint ||
      frame.acceptedAt > this.clock() ||
      this.clock() - frame.capturedAt > 2000
    )
      throw new Error("Fresh exact prepared video evidence is required.");
  }
  private validateMedia(
    plan: TaskHandsetPlan,
    result: TaskHandsetMediaObservation,
    expected?: TaskHandsetMediaObservation["state"],
  ) {
    if (
      !result ||
      result.callAttemptId !== plan.id ||
      result.mediaSessionId !== plan.mediaSessionId ||
      result.audio !== true ||
      result.video !== plan.video ||
      result.screen !== plan.screen ||
      result.presentation !== plan.presentation ||
      (isTaskWalkthroughPlan(plan) &&
        (!("mode" in result) ||
          result.mode !== "handset_walkthrough" ||
          result.instructions !== true ||
          result.nativeActivation !== false ||
          result.planFingerprint !== taskHandsetFingerprint(plan) ||
          result.exportGrantId !== plan.exportGrantId ||
          JSON.stringify(
            taskWalkthroughPresentationBindingSchema.parse(
              result.presentationBinding,
            ),
          ) !==
            JSON.stringify(
              taskWalkthroughPresentationBindingSchema.parse(
                plan.presentationBinding,
              ),
            ))) ||
      result.control !== false ||
      !["absent", "prepared", "active", "closed", "unknown"].includes(
        result.state,
      ) ||
      (expected && result.state !== expected)
    )
      throw new Error("Exact audio-only media observation required.");
  }
  private async effect<T>(
    id: string,
    phase: Phase,
    state: AudioCallRecord["state"],
    run: (record: AudioCallRecord, effectId: string) => Promise<T>,
    accept: (record: AudioCallRecord, result: T) => void,
    cleanup = false,
  ): Promise<TaskAudioCallStatus> {
    if (!cleanup) this.requireEnabled();
    const claimed = this.store.transaction(() => {
      const record = this.get(id);
      if (record.receipts[phase]) return undefined;
      if (record.state === "closed" || (!cleanup && record.stopRequested))
        throw new DomainError(403, "Call admission is closed.");
      const receipt: PhaseReceipt = {
        id: `task-audio:${id}:${phase}`,
        state: "running",
        startedAt: this.clock(),
      };
      record.receipts[phase] = receipt;
      record.state = state;
      record.updatedAt = this.clock();
      this.records.put(record);
      return { record, receipt };
    });
    if (!claimed) return this.status(id);
    try {
      const result = await run(claimed.record, claimed.receipt.id);
      this.store.transaction(() => {
        const current = this.get(id),
          receipt = current.receipts[phase]!;
        if (receipt.state !== "running") return; // A restart already fenced this result; inspection must reconcile original identities.
        accept(current, result);
        receipt.state = "done";
        receipt.completedAt = this.clock();
        current.updatedAt = this.clock();
        this.settleCleanup(current);
        this.records.put(current);
      });
    } catch {
      this.store.transaction(() => {
        const current = this.get(id),
          receipt = current.receipts[phase]!;
        if (receipt.state === "running") {
          receipt.state = "unknown";
          receipt.failure = "effect_outcome_unresolved";
        }
        if (phase === "media_prepare" || phase === "media_activate")
          current.mediaClosed = false;
        current.state = "unknown";
        current.updatedAt = this.clock();
        this.records.put(current);
      });
    }
    return this.status(id);
  }
  private settleCleanup(record: AudioCallRecord) {
    if (
      ["media_prepare", "native_dial", "media_activate"].some(
        (phase) => record.receipts[phase as Phase]?.state === "running",
      )
    )
      return;
    const mediaDone = !record.receipts.media_prepare || record.mediaClosed;
    const nativeDone =
      !record.receipts.native_dial ||
      (!!record.providerCallId && record.nativeCleanupComplete);
    if (
      mediaDone &&
      nativeDone &&
      (record.stopRequested || record.receipts.native_dial)
    )
      record.state = "closed";
  }
  private project(record: AudioCallRecord): TaskAudioCallStatus {
    return {
      id: record.id,
      taskId: record.plan.taskId,
      taskSessionId: record.plan.taskSessionId,
      voiceSessionId: record.plan.voiceSessionId,
      state: record.state,
      fingerprint: record.fingerprint,
      receipts: structuredClone(record.receipts),
      diagnostics: structuredClone(record.diagnostics ?? []),
      ...(record.providerCallId
        ? { providerCallId: record.providerCallId }
        : {}),
      stopRequested: record.stopRequested,
      mediaClosed: record.mediaClosed,
      nativeCleanupComplete: record.nativeCleanupComplete,
      cleanupConfirmed: record.state === "closed",
      ...(isTaskWalkthroughPlan(record.plan) &&
      record.nativeObservation?.remoteVideoReady !== undefined
        ? {
            nativeVideo: {
              remoteDecoded: record.nativeObservation.remoteVideoReady,
              observedAt: record.nativeObservation.observedAt,
              evidence: "worker_remote_video_ready_not_human_seen" as const,
            },
          }
        : {}),
      physicalAcceptance: false,
    };
  }
}
