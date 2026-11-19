import type { TaskVoiceSession } from "../contracts.js";
import { DomainError, hash } from "../storage/security.js";
import {
  taskWalkthroughFingerprint,
  taskWalkthroughPlanSchema,
  type TaskWalkthroughPlan,
} from "../task-walkthrough-contracts.js";
import {
  taskPresentationManifestSchema,
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskSceneFrame,
} from "../task-presentation-contracts.js";
import {
  taskWalkthroughVideoEvidenceSchema,
  type TaskWalkthroughVideoEvidence,
} from "../transport/task-audio.js";
import type { TaskPresentationService } from "./task-presentation-service.js";
import type { TaskVoicePresentationPort } from "./task-voice-service.js";

/** A source-bound projection over the existing presentation ledger, not another executor. */
export class TaskWalkthroughPresentation implements TaskVoicePresentationPort {
  private readonly plan: TaskWalkthroughPlan;
  private readonly manifest: TaskPresentationManifest;
  constructor(
    private readonly presentation: TaskPresentationService,
    plan: TaskWalkthroughPlan,
    manifest: TaskPresentationManifest,
    private readonly taskCredential: string,
    private readonly evidenceFor: (
      frame: TaskSceneFrame,
    ) => TaskWalkthroughVideoEvidence,
    private readonly authority: {
      initial: () => void;
      ongoing: () => void;
      preparing: () => boolean;
      clock?: () => number;
    },
  ) {
    this.plan = taskWalkthroughPlanSchema.parse(plan);
    this.manifest = taskPresentationManifestSchema.parse(manifest);
    const p = this.plan,
      m = this.manifest;
    if (
      m.id !== p.presentationBinding.presentationId ||
      taskPresentationFingerprint(m) !==
        p.presentationBinding.manifestFingerprint ||
      m.taskId !== p.taskId ||
      m.sessionId !== p.taskSessionId ||
      m.runId !== p.runId ||
      m.taskRevision !== p.revision ||
      m.verificationId !== p.presentationBinding.verificationId ||
      m.kind !== p.callKind
    )
      throw new DomainError(
        403,
        "Prepared scene manifest differs from the export plan.",
      );
  }
  private bound(voice: TaskVoiceSession) {
    const p = this.plan;
    if (
      voice.mode !== "handset_walkthrough" ||
      voice.id !== p.voiceSessionId ||
      voice.sessionId !== p.taskSessionId ||
      voice.taskId !== p.taskId ||
      voice.callAttemptId !== p.id ||
      voice.exportGrantId !== p.exportGrantId ||
      voice.presentationId !== p.presentationBinding.presentationId ||
      voice.manifestFingerprint !== p.presentationBinding.manifestFingerprint
    )
      throw new DomainError(
        403,
        "Exact prepared conversation/presentation binding required.",
      );
  }
  private record() {
    const record = this.presentation.status(
      this.taskCredential,
      this.plan.taskId,
      this.manifest.id,
    );
    if (
      record.fingerprint !==
        this.plan.presentationBinding.manifestFingerprint ||
      record.grant.id !== this.plan.presentationBinding.presentationGrantId
    )
      throw new DomainError(
        403,
        "Capture receipt differs from the authorized export.",
      );
    return record;
  }
  context(voice: TaskVoiceSession) {
    this.bound(voice);
    let sharingActive = false;
    let exportActive = false;
    let activeSceneId: string | undefined;
    let sceneEvidenceCurrent = false;
    try {
      const authority = this.presentation.authority(
        this.taskCredential,
        this.plan.taskId,
        this.manifest.id,
      );
      sceneEvidenceCurrent = authority.sceneEvidenceCurrent;
      const record = this.record();
      exportActive =
        record.stoppedAt === undefined &&
        record.state !== "unknown" &&
        record.state !== "stopped";
      sharingActive =
        ["visible", "narrating"].includes(record.state) &&
        record.stoppedAt === undefined;
      activeSceneId = sharingActive ? record.activeSceneId : undefined;
    } catch {
      /* Expired/stale sharing does not end authorized task conversation. */
    }
    return {
      planFingerprint: taskWalkthroughFingerprint(this.plan),
      exportActive,
      sharingActive,
      sceneEvidenceCurrent,
      ...(activeSceneId ? { activeSceneId } : {}),
      scenes: this.manifest.scenes.map((s) => ({ id: s.id, title: s.title })),
    };
  }
  private request(
    voice: TaskVoiceSession,
    action: "opening" | "show" | "stop",
    input: {
      eventId: string;
      utteranceId?: string;
      sceneId?: string;
    },
  ) {
    const { store, vault } = this.presentation.tasks;
    const event = `walkthrough-request:${hash(`${voice.id}\0${input.eventId}`)}`;
    const fingerprint = hash(
      JSON.stringify({ voiceId: voice.id, action, ...input }),
    );
    return store.transaction(() => {
      const previous = store.state<{ sealed: string }>(event);
      if (previous) {
        const saved = vault.open<{
          fingerprint: string;
          operationId: string;
          generation: number;
        }>(previous.sealed);
        if (saved.fingerprint !== fingerprint)
          throw new DomainError(
            409,
            "Prepared scene request conflicts with its original source.",
          );
        return saved;
      }
      const saved = {
        fingerprint,
        operationId: `voice_scene_${hash(event)}`,
        generation: this.record().generation,
      };
      store.saveState(event, { sealed: vault.seal(saved) });
      return saved;
    });
  }
  async opening(voice: TaskVoiceSession, eventId: string) {
    this.bound(voice);
    this.authority.initial();
    if (eventId !== `opening_${this.plan.id}` || !this.authority.preparing())
      throw new DomainError(
        403,
        "The exact initial media preparation is required.",
      );
    return this.showPrepared(voice, "opening", {
      eventId,
      sceneId: this.manifest.scenes[0]!.id,
    });
  }
  async show(
    voice: TaskVoiceSession,
    input: { eventId: string; utteranceId: string; sceneId: string },
  ) {
    this.bound(voice);
    this.authority.ongoing();
    return this.showPrepared(voice, "show", input);
  }
  private async showPrepared(
    voice: TaskVoiceSession,
    action: "opening" | "show",
    input: {
      eventId: string;
      utteranceId?: string;
      sceneId: string;
    },
  ) {
    const scene = this.manifest.scenes.find((s) => s.id === input.sceneId);
    if (!scene)
      throw new DomainError(
        403,
        "Only immutable prepared scenes are available.",
      );
    const before = this.presentation.authority(
      this.taskCredential,
      this.plan.taskId,
      this.manifest.id,
    );
    if (action === "opening" && !before.sceneEvidenceCurrent)
      throw new DomainError(
        409,
        "Opening requires the current verified prepared scene.",
      );
    const request = this.request(voice, action, input);
    const record = await this.presentation.show(
      this.taskCredential,
      this.plan.taskId,
      this.manifest.id,
      {
        eventId: request.operationId,
        expectedGeneration: request.generation,
        sceneId: scene.id,
      },
    );
    const effect = record.effects.find((e) => e.id === request.operationId);
    if (effect?.state !== "done" || record.activeSceneId !== scene.id)
      throw new DomainError(
        409,
        "The prepared scene effect did not establish the current view.",
      );
    // Historical receipts never stand in for currently published pixels.
    const frame = await this.presentation.observeCurrent(
      this.taskCredential,
      this.plan.taskId,
      record.id,
    );
    if (frame.sceneId !== scene.id || frame.generation !== record.generation)
      throw new DomainError(
        409,
        "The current view differs from the requested scene.",
      );
    const videoEvidence = taskWalkthroughVideoEvidenceSchema.parse(
      this.evidenceFor(frame),
    );
    const now = (this.authority.clock ?? Date.now)();
    if (
      videoEvidence.presentationId !== frame.presentationId ||
      videoEvidence.manifestFingerprint !== frame.manifestFingerprint ||
      videoEvidence.sceneId !== frame.sceneId ||
      videoEvidence.generation !== frame.generation ||
      videoEvidence.sourceFrameId !== frame.sourceFrameId ||
      videoEvidence.geometryGeneration !== frame.geometryGeneration ||
      videoEvidence.capturedAt !== frame.capturedAt ||
      videoEvidence.renderedAt !== frame.renderedAt ||
      videoEvidence.acceptedAt > now + 100 ||
      now - videoEvidence.acceptedAt > 1000
    )
      throw new DomainError(
        409,
        "Fresh exact SDK frame acceptance is required.",
      );
    const { sceneEvidenceCurrent } = this.presentation.authority(
      this.taskCredential,
      this.plan.taskId,
      this.manifest.id,
    );
    if (action === "opening") {
      if (!sceneEvidenceCurrent)
        throw new DomainError(
          409,
          "Opening evidence changed during publication.",
        );
      this.authority.initial();
      if (!this.authority.preparing())
        throw new DomainError(
          403,
          "Initial preparation ended during scene publication.",
        );
    } else this.authority.ongoing();
    return {
      sceneId: scene.id,
      sceneEvidenceCurrent,
      title: sceneEvidenceCurrent ? scene.title : "Live prepared window",
      narration: sceneEvidenceCurrent
        ? scene.narration
        : "Here is the live window. Current task status has the result and verification details.",
      expectedOutcome: sceneEvidenceCurrent
        ? scene.expectedOutcome
        : "Live window shown; use current task status for verification.",
      generation: frame.generation,
      evidence: "sdk_frame_accepted_not_remote_seen" as const,
      videoEvidence,
    };
  }
  async stop(
    voice: TaskVoiceSession,
    input: { eventId: string; utteranceId: string },
  ) {
    this.bound(voice);
    // Exact owned cleanup remains possible even after presentation invalidation.
    const request = this.request(voice, "stop", input);
    return this.stopLocal(request.operationId);
  }
  async stopLocal(eventId: string) {
    const result = await this.presentation.stop(
      this.taskCredential,
      this.plan.taskId,
      this.manifest.id,
      { eventId },
    );
    if (
      !result.cleanup ||
      Object.values(result.cleanup).some((v) => v !== true)
    )
      throw new DomainError(409, "Sharing cleanup remains unconfirmed.");
    return { sharingStopped: true, voiceEnded: false, taskCanceled: false };
  }
  async retire(
    voice: TaskVoiceSession,
    input: { eventId: string; reason: string },
  ) {
    this.bound(voice);
    return this.stopLocal(
      `retire_${hash(`${voice.id}\0${input.eventId}\0${input.reason}`)}`,
    );
  }
}
