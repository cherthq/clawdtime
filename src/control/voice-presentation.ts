import { createHash } from "node:crypto";
import type { AgentSession } from "../contracts.js";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import {
  voicePreparationSchema,
  voiceCameraSchema,
  type VoicePreparation,
} from "../voice-contracts.js";
import type { ScreenCamera } from "./camera.js";

type Prepared = {
  value: VoicePreparation;
  expiresAt: number;
  leaseId?: string;
  contentRevision?: string;
};
/** Only the original coding session can supply targets. No provider coordinates or OS input. */
export class VoicePresentation {
  private prepared = new Map<string, Prepared>();
  constructor(
    readonly service: ClawdTime,
    readonly camera: ScreenCamera,
  ) {}
  private prune() {
    for (const [id, p] of this.prepared) {
      const r = this.service.store.get<
        import("../contracts.js").AttentionRequest
      >("attention", id);
      if (
        p.expiresAt <= this.service.clock() ||
        !r ||
        !["connected", "awaiting_input"].includes(r.state) ||
        this.service.store.state(`view-stopped:${id}`)
      )
        this.prepared.delete(id);
    }
  }
  async prepare(
    session: AgentSession,
    requestId: string,
    input: unknown,
    check: () => void,
  ) {
    this.prune();
    check();
    const value = voicePreparationSchema.parse(input);
    const status = value.targets.length
      ? await this.camera.status(session, requestId)
      : undefined;
    check();
    if (
      status &&
      (status.state !== "live" ||
        status.geometryGeneration !== value.geometryGeneration ||
        status.contentRevision !== value.contentRevision)
    )
      throw new DomainError(
        409,
        "Prepare targets against the current live camera geometry.",
      );
    if (!this.prepared.has(requestId) && this.prepared.size >= 100)
      throw new DomainError(429, "Prepared presentation capacity reached.");
    const expiresAt = this.service.clock() + 300_000;
    this.prepared.set(requestId, {
      value,
      expiresAt,
      leaseId: status?.leaseId,
      contentRevision: status?.contentRevision ?? undefined,
    });
    const expiry = setTimeout(() => {
      if (this.prepared.get(requestId)?.expiresAt === expiresAt)
        this.prepared.delete(requestId);
    }, 300_000);
    expiry.unref();
    return {
      version: 1 as const,
      prepared: true as const,
      expiresAt,
      targetIds: value.targets.map((t) => t.id),
    };
  }
  context(requestId: string) {
    this.prune();
    return this.prepared.get(requestId)?.value;
  }
  clear(requestId: string) {
    this.prepared.delete(requestId);
  }
  async command(
    session: AgentSession,
    requestId: string,
    input: unknown,
    check: () => void,
  ): Promise<{ accepted: boolean; reply: string }> {
    check();
    this.prune();
    const value = voiceCameraSchema.parse(input);
    const hash = (v: string) => createHash("sha256").update(v).digest("hex");
    const key = `voice-camera:${hash(`${requestId}:${value.eventId}`)}`;
    const fingerprint = hash(JSON.stringify(value));
    const prior = this.service.store.state<{
      fingerprint: string;
      accepted: boolean;
      reply: string;
    }>(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new DomainError(409, "Voice camera event changed.");
      return { accepted: prior.accepted, reply: prior.reply };
    }
    const status = await this.camera.status(session, requestId);
    check();
    const p = this.prepared.get(requestId);
    const target = p?.value.targets.find((t) => t.id === value.targetId);
    if (
      ["focus", "annotate"].includes(value.action) &&
      (!p ||
        !target ||
        p.expiresAt <= this.service.clock() ||
        p.leaseId !== status.leaseId ||
        p.value.geometryGeneration !== status.geometryGeneration ||
        p.contentRevision !== status.contentRevision)
    )
      throw new DomainError(
        409,
        "Prepared target is missing or stale; ask the coding session to prepare it again.",
      );
    if (
      status.state !== "live" ||
      !status.sourceFrameId ||
      !status.geometryGeneration
    )
      throw new DomainError(409, "Current live camera frame required.");
    const envelope = {
      version: 1,
      commandId: `voice_${hash(key).slice(0, 40)}`,
      expectedRevision: status.revision,
      sourceFrameId: status.sourceFrameId,
      geometryGeneration: status.geometryGeneration,
    };
    const command =
      value.action === "focus"
        ? {
            ...envelope,
            op: "focus_region",
            rect: target!.rect,
            durationMs: 450,
            automatic: true,
          }
        : value.action === "annotate"
          ? {
              ...envelope,
              op: "annotation_upsert",
              annotation: {
                id: `voice_${target!.id}`.slice(0, 160),
                kind: target!.annotation?.kind ?? "highlight",
                rect: target!.rect,
                ...(target!.annotation?.text
                  ? { text: target!.annotation.text }
                  : {}),
                ttlMs: 8000,
              },
            }
          : { ...envelope, op: value.action };
    if (this.service.store.state(key))
      return this.command(session, requestId, input, check);
    // Reserve before dispatch. A lost acknowledgement never causes a second effect.
    this.service.store.transaction(() => {
      const countKey = `voice-camera-count:${requestId}`;
      const count = this.service.store.state<number>(countKey) ?? 0;
      if (count >= 512)
        throw new DomainError(
          429,
          "Voice camera event capacity reached; original receipts remain available.",
        );
      this.service.store.saveState(countKey, count + 1);
      this.service.store.saveState(key, {
        fingerprint,
        accepted: false,
        reply: "Camera outcome is unknown; do not repeat this event.",
      });
    });
    const receipt = await this.camera.command(session, requestId, command);
    check();
    const result = {
      accepted: receipt.state === "accepted",
      reply:
        receipt.state === "accepted"
          ? "Presentation command accepted; handset visibility is not verified."
          : "Presentation command was superseded.",
    };
    this.service.store.saveState(key, { fingerprint, ...result });
    return result;
  }
}
