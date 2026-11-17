import { z } from "zod";
import type {
  AgentSession,
  JobBinding,
  JobSource,
  Pairing,
  DocumentSelection,
  DocumentCandidate,
} from "../contracts.js";
import { DomainError, hash } from "../storage/security.js";
import type { ClawdTime } from "./service.js";
import {
  attachmentFileSchema,
  attachmentFilename,
  validateAttachmentBytes,
  type AttachmentFile,
  type AttachmentPort,
  type AttachmentReceipt,
} from "../transport/attachments.js";
import type { EventAnchor } from "../transport/native-messages.js";

export type AttachmentSelection = DocumentSelection;
export interface AttachmentAuthority {
  selection(binding: JobBinding, selectionId: string): AttachmentSelection;
  assertCurrent(
    binding: JobBinding,
    selectionId: string,
    candidate: AttachmentSelection["candidate"],
  ): void;
}
export interface AttachmentDispatch extends JobBinding {
  id: string;
  version: 1;
  source: JobSource;
  selectionId: string;
  candidateId: string;
  candidate: DocumentCandidate;
  file: AttachmentFile;
  recipient: string;
  lineId: string;
  conversationId: string;
  createdAt: number;
  expiresAt: number;
  state:
    | "awaiting_bytes"
    | "staging"
    | "sending"
    | "accepted"
    | "canceled"
    | "failed"
    | "unknown";
  phase: "awaiting_bytes" | "stage" | "send";
  uploadAttempted?: boolean;
  sendAttempted?: boolean;
  cancelRequested?: boolean;
  attachmentId?: string;
  anchor?: EventAnchor;
  receipt?: AttachmentReceipt;
  /** Provider receipt is not handset delivery or human receipt. */
  delivery?: "provider_accepted";
  reason?:
    | "authorization_closed"
    | "bytes_unavailable"
    | "provider_unavailable"
    | "outcome_unresolved"
    | "process_interrupted"
    | "canceled_before_send";
}
const identity = z.string().min(1).max(512);
const sourceSchema = z
  .object({ channel: z.enum(["text", "voice"]), eventId: identity })
  .strict();
const requestSchema = z
  .object({
    selectionId: identity,
    candidateId: identity,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    recipient: z.literal("paired_imessage"),
  })
  .strict();
const terminal = new Set(["accepted", "canceled", "failed", "unknown"]);
/** Durable metadata, transient bytes, exactly one local send claim per selected document. */
export class AttachmentService {
  private active = new Map<string, Promise<void>>();
  private bytesInFlight = 0;
  private closed = false;
  private detached = new Set<string>();
  constructor(
    readonly service: ClawdTime,
    readonly port: AttachmentPort,
    readonly authority: AttachmentAuthority,
  ) {
    service.store.transaction(() => {
      for (const item of service.store.all<AttachmentDispatch>(
        "attachment_dispatch",
      ))
        if (item.state === "staging" || item.state === "sending")
          this.save({
            ...item,
            state: "unknown",
            reason: "process_interrupted",
          });
    });
  }
  private owned(binding: JobBinding, live = true) {
    const session = this.service.store.get<AgentSession>(
      "session",
      binding.sessionId,
    );
    const pairing = this.service.store.get<Pairing>(
      "pairing",
      binding.pairingId,
    );
    if (
      !session ||
      !pairing ||
      session.pairingId !== pairing.id ||
      pairing.memberId !== binding.memberId
    )
      throw new DomainError(403, "Attachment session identity does not match.");
    if (live) {
      this.service.assertExecutionAllowed(session);
      if (
        pairing.revokedAt !== undefined ||
        session.state === "stopped" ||
        this.service.clock() - (session.lastSeenAt ?? session.createdAt) >=
          20000 ||
        (session.lastSeenAt ?? session.createdAt) > this.service.clock() + 1000
      )
        throw new DomainError(
          403,
          "Attachment session authority is unavailable.",
        );
    }
    return pairing;
  }
  private save(value: AttachmentDispatch) {
    return this.service.store.put("attachment_dispatch", value);
  }
  status(binding: JobBinding, id: string) {
    this.owned(binding, false);
    const value = this.service.store.get<AttachmentDispatch>(
      "attachment_dispatch",
      id,
    );
    if (
      !value ||
      value.sessionId !== binding.sessionId ||
      value.pairingId !== binding.pairingId ||
      value.memberId !== binding.memberId
    )
      throw new DomainError(
        404,
        "Attachment dispatch does not belong to this session.",
      );
    return value;
  }
  private current(value: AttachmentDispatch) {
    const pairing = this.owned(value);
    if (
      this.closed ||
      this.service.store.state("runtime:mode") === "standby" ||
      value.expiresAt <= this.service.clock() ||
      pairing.recipient !== value.recipient ||
      pairing.lineId !== value.lineId ||
      pairing.conversationId !== value.conversationId
    )
      throw new DomainError(403, "Attachment approval has closed.");
    const selection = this.authority.selection(value, value.selectionId);
    if (
      selection.id !== value.selectionId ||
      selection.sessionId !== value.sessionId ||
      selection.pairingId !== value.pairingId ||
      selection.memberId !== value.memberId ||
      selection.expiresAt <= this.service.clock() ||
      selection.candidate.id !== value.candidateId ||
      selection.candidate.sha256 !== value.file.sha256 ||
      JSON.stringify(selection.candidate) !== JSON.stringify(value.candidate) ||
      selection.candidate.mimeType !== value.file.mimeType ||
      selection.candidate.byteLength !== value.file.byteLength
    )
      throw new DomainError(
        409,
        "Document selection changed before attachment dispatch.",
      );
    this.authority.assertCurrent(value, value.selectionId, selection.candidate);
    return pairing;
  }
  enqueue(
    binding: JobBinding,
    input: JobSource,
    request: {
      selectionId: string;
      candidateId: string;
      sha256: string;
      recipient: "paired_imessage";
    },
  ): AttachmentDispatch {
    const pairing = this.owned(binding),
      source = sourceSchema.parse(input),
      asked = requestSchema.parse(request);
    const key = `attachment-request:${binding.sessionId}:${source.channel}:${source.eventId}`,
      fingerprint = hash(JSON.stringify({ binding, source, asked }));
    return this.service.store.transaction(() => {
      const prior = this.service.store.event<{ id: string }>(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Attachment event identity changed.");
        return this.status(binding, prior.result.id);
      }
      if (this.closed)
        throw new DomainError(409, "Attachment admission is closed.");
      const selection = this.authority.selection(binding, asked.selectionId);
      const file = attachmentFileSchema.parse({
        filename: attachmentFilename(
          selection.candidate.name,
          selection.candidate.mimeType as AttachmentFile["mimeType"],
        ),
        mimeType: selection.candidate.mimeType,
        byteLength: selection.candidate.byteLength,
        sha256: selection.candidate.sha256,
      });
      if (
        selection.candidate.id !== asked.candidateId ||
        file.sha256 !== asked.sha256
      )
        throw new DomainError(
          409,
          "Send approval does not match the selected document.",
        );
      const existing = this.service.store
        .all<AttachmentDispatch>("attachment_dispatch")
        .find(
          (d) =>
            d.sessionId === binding.sessionId && d.selectionId === selection.id,
        );
      if (existing) {
        if (
          existing.candidateId !== asked.candidateId ||
          existing.file.sha256 !== asked.sha256
        )
          throw new DomainError(
            409,
            "Selection already has a different attachment dispatch.",
          );
        this.service.store.recordEvent(key, fingerprint, { id: existing.id });
        return existing;
      }
      if (
        this.service.store
          .all<AttachmentDispatch>("attachment_dispatch")
          .some(
            (d) =>
              d.lineId === pairing.lineId &&
              ["staging", "sending", "unknown"].includes(d.state),
          )
      )
        throw new DomainError(
          409,
          "An unresolved attachment dispatch blocks another send.",
        );
      if (
        this.service.store
          .all<AttachmentDispatch>("attachment_dispatch")
          .filter((d) => d.sessionId === binding.sessionId).length >= 1000
      )
        throw new DomainError(409, "Attachment receipt capacity reached.");
      const item: AttachmentDispatch = {
        ...binding,
        id: `attachment_${hash(key).slice(0, 40)}`,
        version: 1,
        source,
        selectionId: selection.id,
        candidateId: asked.candidateId,
        candidate: selection.candidate,
        file,
        recipient: pairing.recipient,
        lineId: pairing.lineId,
        conversationId: pairing.conversationId,
        createdAt: this.service.clock(),
        expiresAt: Math.min(selection.expiresAt, this.service.clock() + 300000),
        state: "awaiting_bytes",
        phase: "awaiting_bytes",
      };
      this.current(item);
      this.save(item);
      this.service.store.recordEvent(key, fingerprint, { id: item.id });
      return item;
    });
  }
  provideBytes(binding: JobBinding, id: string, bytes: Uint8Array) {
    const value = this.status(binding, id);
    validateAttachmentBytes(value.file, bytes);
    if (value.state !== "awaiting_bytes") return value;
    this.current(value);
    if (
      this.bytesInFlight + bytes.byteLength > 32 * 1024 * 1024 ||
      this.active.size >= 8
    )
      throw new DomainError(409, "Attachment transfer capacity reached.");
    const copy = Uint8Array.from(bytes);
    this.bytesInFlight += copy.byteLength;
    this.save({ ...value, state: "staging", phase: "stage" });
    const promise = this.perform(value, copy).finally(() => {
      this.bytesInFlight -= copy.byteLength;
      copy.fill(0);
      this.active.delete(id);
    });
    this.active.set(id, promise);
    return this.status(binding, id);
  }
  private async perform(original: AttachmentDispatch, bytes: Uint8Array) {
    try {
      const pair = this.current(original);
      const staged = await this.port.stage(pair, original.file, bytes, () => {
        if (this.detached.has(original.id))
          throw new Error("Attachment dispatcher stopped.");
        const item = this.status(original, original.id);
        this.current(item);
        if (item.state !== "staging" || item.uploadAttempted)
          throw new DomainError(
            409,
            "Attachment upload already claimed or stopped.",
          );
        this.save({ ...item, uploadAttempted: true });
      });
      if (this.detached.has(original.id)) return;
      let item = this.status(original, original.id);
      this.save({
        ...item,
        attachmentId: staged.attachmentId,
        ...(item.cancelRequested && !item.sendAttempted
          ? {
              state: "canceled" as const,
              reason: "canceled_before_send" as const,
            }
          : {}),
      });
      if (item.state !== "staging") return;
      const receipt = await this.port.send(
        this.current(item),
        item.file,
        staged,
        (anchor) => {
          if (this.detached.has(original.id))
            throw new Error("Attachment dispatcher stopped.");
          item = this.status(original, original.id);
          this.current(item);
          if (item.state !== "staging" || item.sendAttempted)
            throw new DomainError(
              409,
              "Attachment send already claimed or stopped.",
            );
          this.save({
            ...item,
            state: "sending",
            phase: "send",
            sendAttempted: true,
            anchor,
          });
        },
      );
      if (this.detached.has(original.id)) return;
      item = this.status(original, original.id);
      if (
        receipt.attachmentId !== staged.attachmentId ||
        receipt.recipient !== item.recipient
      )
        throw new Error("Attachment receipt identity mismatch.");
      this.save({
        ...item,
        receipt,
        ...(item.state === "sending"
          ? {
              state: "accepted" as const,
              delivery: "provider_accepted" as const,
            }
          : {
              state: "unknown" as const,
              reason: "outcome_unresolved" as const,
            }),
      });
    } catch {
      if (this.detached.has(original.id)) return;
      const item = this.status(original, original.id);
      if (item.state === "canceled" && !item.sendAttempted) return;
      const uncertain =
        item.sendAttempted || (item.uploadAttempted && !item.attachmentId);
      this.save({
        ...item,
        state: uncertain ? "unknown" : "failed",
        reason: uncertain ? "outcome_unresolved" : "authorization_closed",
      });
    }
  }
  cancel(binding: JobBinding, id: string) {
    const item = this.status(binding, id);
    if (terminal.has(item.state)) return item;
    return this.save({
      ...item,
      cancelRequested: true,
      state:
        item.sendAttempted || (item.uploadAttempted && !item.attachmentId)
          ? "unknown"
          : "canceled",
      reason:
        item.sendAttempted || (item.uploadAttempted && !item.attachmentId)
          ? "outcome_unresolved"
          : "canceled_before_send",
    });
  }
  async wait(binding: JobBinding, id: string, timeoutMs = 20000) {
    z.number().int().min(0).max(30000).parse(timeoutMs);
    this.status(binding, id);
    const pending = this.active.get(id);
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((r) => {
          timer = setTimeout(r, timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return this.status(binding, id);
  }
  async reconcile(binding: JobBinding, id: string) {
    const item = this.status(binding, id);
    if (
      item.state !== "unknown" ||
      !item.sendAttempted ||
      !item.attachmentId ||
      !item.anchor
    )
      return item;
    const pairing = this.owned(binding, false);
    if (
      pairing.recipient !== item.recipient ||
      pairing.lineId !== item.lineId ||
      pairing.conversationId !== item.conversationId
    )
      throw new DomainError(
        409,
        "Original attachment recipient binding changed.",
      );
    const receipt = await this.port.reconcile(
      pairing,
      item.file,
      { attachmentId: item.attachmentId },
      item.anchor,
    );
    if (!receipt) return item;
    if (
      receipt.attachmentId !== item.attachmentId ||
      receipt.recipient !== item.recipient ||
      receipt.evidence !== "provider_event"
    )
      throw new DomainError(409, "Attachment reconciliation evidence differs.");
    const current = this.status(binding, id);
    if (current.state !== "unknown") return current;
    return this.save({
      ...current,
      state: "accepted",
      receipt,
      delivery: "provider_accepted",
      reason: undefined,
    });
  }
  async stop() {
    this.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.active.values()]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const id of this.active.keys()) this.detached.add(id);
  }
  close() {
    this.closed = true;
    for (const item of this.service.store.all<AttachmentDispatch>(
      "attachment_dispatch",
    ))
      if (!terminal.has(item.state)) this.cancel(item, item.id);
  }
}
