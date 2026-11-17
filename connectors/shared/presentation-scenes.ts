import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./client.js";
import {
  livePresentationIntentSchema,
  livePresentationResultSchema,
  type LivePresentationIntent,
  type LivePresentationResult,
} from "../../src/live-presentation-contracts.js";
import {
  cameraCommandSchema,
  cameraReceiptSchema,
  cameraRectSchema,
  cameraStatusSchema,
  type CameraCommand,
  type CameraStatus,
} from "../../src/camera-contracts.js";
import {
  presentationScenePlanSchema,
  presentationSceneAttestationSchema,
  presentationSceneVerificationSchema,
  type PresentationScenePlan,
  type PresentationSceneVerification,
} from "../../src/presentation-scene-contracts.js";

export interface PresentationScenePorts {
  cameraStatus(): Promise<unknown>;
  cameraCommand(command: CameraCommand): Promise<unknown>;
  executionStatus(): Promise<unknown>;
  presentLive?(intent: LivePresentationIntent): Promise<unknown>;
}
const executionSchema = z.object({
  executor: z.enum(["none", "native", "clawdtime"]),
  state: z.enum(["idle", "working", "pending_approval", "uncertain", "paused"]),
  epoch: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  acknowledgedCursor: z.number().int().nonnegative(),
  pendingDelivery: z.boolean(),
  viewingStopped: z.boolean().optional(),
  hold: z.object({ active: z.boolean() }),
  leases: z.array(z.object({ state: z.string() })),
  actions: z.array(z.object({ state: z.string() })),
});
type Phase =
  | "idle"
  | "awaiting_verification"
  | "presenting"
  | "presented"
  | "completed"
  | "replanning"
  | "interrupted"
  | "blocked"
  | "expired";

/** Ephemeral camera choreography only. The originating agent supplies native observations. */
export class PresentationSceneController {
  private plan: PresentationScenePlan;
  private readonly expiresAt: number;
  private readonly prefix = randomUUID();
  private generation = 0;
  private index = -1;
  private phase: Phase = "idle";
  private stopped = false;
  private tail: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private unknownCommandId: string | undefined;
  private cameraFailure:
    | {
        commandId: string;
        op: CameraCommand["op"] | "live_present";
        httpStatus: number | null;
      }
    | undefined;
  private binding:
    Pick<CameraStatus, "sessionId" | "deviceId" | "leaseId"> | undefined;
  private presentedFingerprint: string | undefined;
  private liveReceipt: LivePresentationResult | undefined;
  private readonly planIds = new Map<string, string>();
  private readonly observations: Array<{
    sampledAt: number;
    camera: CameraStatus;
  }> = [];

  constructor(
    plan: unknown,
    private readonly ports: PresentationScenePorts,
    private readonly clock = Date.now,
  ) {
    this.plan = presentationScenePlanSchema.parse(plan);
    this.planIds.set(this.plan.id, JSON.stringify(this.plan));
    this.expiresAt = clock() + 15 * 60_000;
  }

  status() {
    if (this.clock() >= this.expiresAt) this.phase = "expired";
    return structuredClone({
      plan: this.plan,
      phase: this.phase,
      generation: this.generation,
      scene: this.plan.scenes[this.index] ?? null,
      expiresAt: this.expiresAt,
      unknownCommandId: this.unknownCommandId ?? null,
      cameraFailure: this.cameraFailure ?? null,
      liveReceipt: this.liveReceipt ?? null,
      planCount: this.planIds.size,
    });
  }

  observe() {
    const generation = this.generation;
    this.valid(generation);
    return this.enqueue(async () => {
      if (this.phase !== "awaiting_verification")
        throw new Error(
          "Begin a scene before observing its presentation source.",
        );
      const camera = await this.fresh(generation);
      const observedAt = this.clock();
      this.observations.splice(
        0,
        this.observations.length,
        ...this.observations
          .filter((o) => observedAt - o.sampledAt <= 2000)
          .slice(-7),
      );
      this.observations.push({ sampledAt: observedAt, camera });
      return structuredClone({
        generation,
        sceneId: this.plan.scenes[this.index]!.id,
        observedAt,
        camera,
      });
    });
  }

  private valid(generation: number) {
    if (this.stopped)
      throw new Error(
        "Presentation controller stopped; no queued camera work may continue.",
      );
    if (this.clock() >= this.expiresAt) {
      this.phase = "expired";
      throw new Error("Presentation plan expired; prepare a fresh plan.");
    }
    if (generation !== this.generation)
      throw new Error(
        "Scene was interrupted or superseded; discard its verification.",
      );
    if (this.unknownCommandId)
      throw new Error(
        "Camera outcome is unknown; inspect the original command without replaying it.",
      );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Invalidate awaited/queued work immediately without submitting cleanup effects. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.phase = "interrupted";
    this.observations.length = 0;
    this.presentedFingerprint = undefined;
  }

  private block(generation: number) {
    if (generation === this.generation)
      this.phase = this.clock() >= this.expiresAt ? "expired" : "blocked";
  }

  private async released(generation: number) {
    const execution = executionSchema.parse(await this.ports.executionStatus());
    this.valid(generation);
    if (
      execution.executor !== "none" ||
      execution.state !== "idle" ||
      execution.pendingDelivery ||
      execution.viewingStopped ||
      execution.hold.active ||
      execution.cursor !== execution.acknowledgedCursor ||
      execution.leases.some((l) => l.state === "unknown") ||
      execution.actions.some((a) =>
        ["pending", "submitted", "unknown"].includes(a.state),
      )
    )
      throw new Error(
        "Presentation requires released native ownership, acknowledged context and no unresolved input.",
      );
    return execution;
  }

  private async fresh(
    generation: number,
    verification?: PresentationSceneVerification,
  ) {
    this.valid(generation);
    const execution = await this.released(generation);
    const status = cameraStatusSchema.parse(await this.ports.cameraStatus());
    this.valid(generation);
    const currentExecution = await this.released(generation);
    if (
      currentExecution.epoch !== execution.epoch ||
      currentExecution.cursor !== execution.cursor
    )
      throw new Error(
        "Execution changed while resolving the camera; observe current context again.",
      );
    const scene = this.plan.scenes[this.index];
    if (
      !scene ||
      status.state !== "live" ||
      status.surface.kind !== "display" ||
      status.surface.displayId !== scene.window.displayId ||
      !status.sourceFrameId ||
      !status.geometryGeneration ||
      !status.contentRevision ||
      status.capturedAt === null ||
      this.clock() - status.capturedAt > 2000 ||
      status.capturedAt > this.clock() + 1000
    )
      throw new Error(
        "Scene requires a fresh live frame of its explicitly selected display.",
      );
    if (
      this.binding &&
      (status.sessionId !== this.binding.sessionId ||
        status.deviceId !== this.binding.deviceId ||
        status.leaseId !== this.binding.leaseId)
    )
      throw new Error(
        "Presentation authority changed; do not reuse the scene controller.",
      );
    this.binding ??= {
      sessionId: status.sessionId,
      deviceId: status.deviceId,
      leaseId: status.leaseId,
    };
    if (
      verification &&
      (verification.leaseId !== status.leaseId ||
        verification.geometryGeneration !== status.geometryGeneration ||
        verification.contentRevision !== status.contentRevision ||
        this.clock() - verification.observedAt > 2000 ||
        verification.observedAt > this.clock())
    )
      throw new Error(
        "Scene verification is stale or its source changed; observe the native result again.",
      );
    if (
      verification &&
      !this.observations.some(
        (o) =>
          this.clock() - o.sampledAt <= 2000 &&
          o.camera.sourceFrameId === verification.sourceFrameId &&
          o.camera.leaseId === verification.leaseId &&
          o.camera.geometryGeneration === verification.geometryGeneration &&
          o.camera.contentRevision === verification.contentRevision,
      )
    )
      throw new Error(
        "Scene verification requires a recent source sampled by this controller.",
      );
    return status;
  }

  private async dispatch(
    generation: number,
    operation: Record<string, unknown>,
    verification?: PresentationSceneVerification,
  ) {
    const status = await this.fresh(generation, verification);
    this.valid(generation);
    if (this.sequence >= 256)
      throw new Error("Presentation command bound reached; end this plan.");
    const commandId = `scene-${this.prefix}-${++this.sequence}`;
    const command = cameraCommandSchema.parse({
      version: 1,
      commandId,
      expectedRevision: status.revision,
      sourceFrameId: status.sourceFrameId,
      geometryGeneration: status.geometryGeneration,
      contentRevision: status.contentRevision,
      ...operation,
    });
    try {
      const receipt = cameraReceiptSchema.parse(
        await this.ports.cameraCommand(command),
      );
      if (receipt.commandId !== commandId || receipt.state !== "accepted")
        throw new Error("Camera command was not confirmed.");
    } catch (error) {
      // Any write failure is conservatively unknown; never create a replacement command.
      this.unknownCommandId = commandId;
      const httpStatus =
        error instanceof ApiError &&
        [
          400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 502, 503, 504,
        ].includes(error.status)
          ? error.status
          : null;
      this.cameraFailure = { commandId, op: command.op, httpStatus };
      this.phase = "blocked";
      throw new Error(
        `Camera outcome is unknown (${command.op}${httpStatus === null ? "" : `, HTTP ${httpStatus}`}); inspect its original command without replaying it.`,
      );
    }
    this.valid(generation);
  }

  begin(sceneId: string) {
    const index = this.plan.scenes.findIndex((scene) => scene.id === sceneId);
    if (index < 0)
      return Promise.reject(new Error("Unknown presentation scene."));
    this.valid(this.generation);
    const generation = ++this.generation;
    this.index = index;
    this.phase = "awaiting_verification";
    this.presentedFingerprint = undefined;
    this.observations.length = 0;
    return this.enqueue(async () => {
      try {
        await this.dispatch(generation, { op: "clear" });
        await this.dispatch(generation, { op: "overview" });
        return this.status();
      } catch (error) {
        this.block(generation);
        throw error;
      }
    });
  }

  next() {
    const next = this.plan.scenes[this.index + 1];
    if (!next)
      return Promise.reject(new Error("Presentation has no next scene."));
    return this.begin(next.id);
  }

  complete() {
    this.valid(this.generation);
    if (
      this.phase !== "presented" ||
      this.index !== this.plan.scenes.length - 1
    )
      throw new Error(
        "Present the final planned scene before completing the walkthrough.",
      );
    this.phase = "completed";
    return this.status();
  }

  replan(rawPlan: unknown, expectedGeneration: number) {
    this.valid(expectedGeneration);
    if (!["completed", "interrupted"].includes(this.phase))
      return Promise.reject(
        new Error(
          "Complete or interrupt the current walkthrough before replacing its plan.",
        ),
      );
    const plan = presentationScenePlanSchema.parse(rawPlan);
    const previous = this.planIds.get(plan.id);
    if (previous)
      return Promise.reject(
        new Error(
          previous === JSON.stringify(plan)
            ? "Presentation plan ID was already used; do not replay a walkthrough."
            : "Presentation plan ID belongs to different immutable content.",
        ),
      );
    if (this.planIds.size >= 8)
      return Promise.reject(
        new Error("Presentation plan revision bound reached."),
      );
    const displayId = this.plan.scenes[this.index]?.window.displayId;
    if (
      !displayId ||
      plan.scenes.some((scene) => scene.window.displayId !== displayId)
    )
      return Promise.reject(
        new Error(
          "Replacement scenes must use the same explicitly selected display.",
        ),
      );
    const generation = ++this.generation;
    this.phase = "replanning";
    this.presentedFingerprint = undefined;
    this.observations.length = 0;
    return this.enqueue(async () => {
      try {
        await this.dispatch(generation, { op: "clear" });
        await this.dispatch(generation, { op: "overview" });
        this.valid(generation);
        this.plan = plan;
        this.planIds.set(plan.id, JSON.stringify(plan));
        this.index = -1;
        this.liveReceipt = undefined;
        this.phase = "idle";
        return this.status();
      } catch (error) {
        this.block(generation);
        throw error;
      }
    });
  }

  /** Geometric camera presentation only; the port resolves the live native target atomically. */
  presentLive() {
    const generation = this.generation;
    this.valid(generation);
    const scene = this.plan.scenes[this.index];
    if (!scene?.focus || !this.ports.presentLive)
      return Promise.reject(
        new Error(
          "This scene requires a prepared window-relative focus and a qualified live presentation port.",
        ),
      );
    const fingerprint = JSON.stringify({
      planId: this.plan.id,
      sceneId: scene.id,
      generation,
      window: scene.window,
      focus: scene.focus,
      annotation: scene.annotation,
    });
    return this.enqueue(async () => {
      this.valid(generation);
      if (
        this.phase === "presented" &&
        this.presentedFingerprint === fingerprint
      )
        return this.status();
      if (this.phase !== "awaiting_verification")
        throw new Error(
          "Begin the current prepared scene before live presentation.",
        );
      await this.fresh(generation);
      this.valid(generation);
      if (this.sequence >= 256)
        throw new Error("Presentation command bound reached; end this plan.");
      const commandId = `scene-${this.prefix}-${++this.sequence}`;
      const intent = livePresentationIntentSchema.parse({
        commandId,
        planId: this.plan.id,
        sceneId: scene.id,
        generation,
        window: scene.window,
        focus: scene.focus,
        ...(scene.annotation ? { annotation: scene.annotation } : {}),
      });
      this.phase = "presenting";
      let receipt: LivePresentationResult;
      try {
        receipt = livePresentationResultSchema.parse(
          await this.ports.presentLive!(intent),
        );
        if (receipt.commandId !== commandId)
          throw new Error("Live presentation receipt mismatch.");
        this.liveReceipt = receipt;
        if (receipt.state === "uncertain")
          throw new Error("Live presentation outcome is uncertain.");
        if (receipt.state === "accepted") {
          const observation = receipt.observation!;
          if (
            JSON.stringify(observation.window) !==
              JSON.stringify(scene.window) ||
            !observation.appActive ||
            !observation.windowFocused ||
            !observation.windowOnScreen ||
            this.clock() - observation.observedAt > 2000 ||
            observation.observedAt > this.clock() ||
            this.clock() - receipt.camera!.capturedAt > 2000 ||
            receipt.camera!.capturedAt > this.clock() + 1000
          )
            throw new Error(
              "Live presentation receipt lacks the fresh exact target.",
            );
        }
      } catch (error) {
        this.unknownCommandId = commandId;
        const httpStatus =
          error instanceof ApiError &&
          [
            400, 401, 403, 404, 409, 410, 413, 422, 429, 500, 502, 503, 504,
          ].includes(error.status)
            ? error.status
            : null;
        this.cameraFailure = { commandId, op: "live_present", httpStatus };
        this.phase = "blocked";
        throw new Error(
          "Live camera outcome is unknown; reconcile the original command without retrying.",
        );
      }
      this.valid(generation);
      if (receipt.state === "rejected") {
        this.phase = "blocked";
        throw new Error(
          "Live camera presentation was rejected; inspect its receipt before a new intent.",
        );
      }
      this.presentedFingerprint = fingerprint;
      this.phase = "presented";
      return this.status();
    });
  }

  /** Samples and presents in this runtime; never refreshes the agent's observation time. */
  async presentObserved(rawAttestation: unknown, rawRect: unknown) {
    const attestation =
      presentationSceneAttestationSchema.parse(rawAttestation);
    const rect = cameraRectSchema.parse(rawRect);
    this.valid(attestation.generation);
    const scene = this.plan.scenes[this.index];
    if (
      this.phase !== "awaiting_verification" ||
      !scene ||
      scene.id !== attestation.sceneId ||
      JSON.stringify(scene.window) !== JSON.stringify(attestation.window)
    )
      throw new Error(
        "Attestation does not identify the current planned scene and exact window.",
      );
    if (
      this.clock() - attestation.observedAt > 2000 ||
      attestation.observedAt > this.clock()
    )
      throw new Error(
        "Original scene attestation is stale; observe the native result again.",
      );
    const bounds = attestation.windowBounds;
    if (
      rect.x < bounds.x ||
      rect.y < bounds.y ||
      rect.x + rect.width > bounds.x + bounds.width + 1e-9 ||
      rect.y + rect.height > bounds.y + bounds.height + 1e-9
    )
      throw new Error(
        "Scene focus must fit the freshly observed window bounds.",
      );
    const sampled = await this.observe();
    // Only source metadata comes from the new sample. The agent's own witness is immutable.
    return this.present(
      {
        ...attestation,
        sourceFrameId: sampled.camera.sourceFrameId,
        geometryGeneration: sampled.camera.geometryGeneration,
        contentRevision: sampled.camera.contentRevision,
        leaseId: sampled.camera.leaseId,
      },
      rect,
    );
  }

  present(rawVerification: unknown, rawRect: unknown) {
    const verification =
      presentationSceneVerificationSchema.parse(rawVerification);
    const rect = cameraRectSchema.parse(rawRect);
    const bounds = verification.windowBounds;
    if (
      rect.x < bounds.x ||
      rect.y < bounds.y ||
      rect.x + rect.width > bounds.x + bounds.width + 1e-9 ||
      rect.y + rect.height > bounds.y + bounds.height + 1e-9
    )
      return Promise.reject(
        new Error("Scene focus must fit the freshly observed window bounds."),
      );
    const generation = verification.generation;
    const fingerprint = JSON.stringify({ verification, rect });
    this.valid(generation);
    const scene = this.plan.scenes[this.index];
    if (
      !scene ||
      scene.id !== verification.sceneId ||
      JSON.stringify(scene.window) !== JSON.stringify(verification.window)
    )
      return Promise.reject(
        new Error("Verification does not identify the planned exact window."),
      );
    return this.enqueue(async () => {
      this.valid(generation);
      if (
        this.phase === "presented" &&
        this.presentedFingerprint === fingerprint
      )
        return this.status();
      if (this.phase !== "awaiting_verification")
        throw new Error(
          "Begin and verify the scene before presentation; do not replay it.",
        );
      this.phase = "presenting";
      try {
        await this.dispatch(
          generation,
          { op: "focus_region", rect, durationMs: 450, automatic: false },
          verification,
        );
        if (scene.annotation)
          await this.dispatch(
            generation,
            {
              op: "annotation_upsert",
              annotation: {
                id: `scene-${scene.id}`,
                ...scene.annotation,
                rect,
                ttlMs: 3000,
              },
            },
            verification,
          );
        this.presentedFingerprint = fingerprint;
        this.phase = "presented";
        return this.status();
      } catch (error) {
        this.block(generation);
        throw error;
      }
    });
  }

  interrupt() {
    this.valid(this.generation);
    const generation = ++this.generation;
    this.phase = "interrupted";
    this.presentedFingerprint = undefined;
    this.observations.length = 0;
    return this.enqueue(async () => {
      try {
        await this.dispatch(generation, { op: "clear" });
        await this.dispatch(generation, { op: "overview" });
        return this.status();
      } catch (error) {
        this.block(generation);
        throw error;
      }
    });
  }
}
