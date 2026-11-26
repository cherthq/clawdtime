import { documentMime } from "../document-contracts.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Pairing } from "../contracts.js";
import { DomainError } from "../storage/security.js";
import type { NativeTransport } from "./native.js";
import type { EventAnchor } from "./native-messages.js";

export interface AttachmentFile {
  filename: string;
  mimeType:
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.apple.pages";
  byteLength: number;
  sha256: string;
}
export interface StagedAttachment {
  attachmentId: string;
}
export interface AttachmentReceipt {
  attachmentId: string;
  messageId: string;
  providerLineId: string;
  recipient: string;
  evidence: "send_response" | "provider_event";
  eventId?: string;
  eventSequence?: number;
}
export interface AttachmentPort {
  stage(
    pairing: Pairing,
    file: AttachmentFile,
    bytes: Uint8Array,
    beforeDispatch: () => void,
  ): Promise<StagedAttachment>;
  send(
    pairing: Pairing,
    file: AttachmentFile,
    staged: StagedAttachment,
    beforeDispatch: (anchor: EventAnchor) => void,
  ): Promise<AttachmentReceipt>;
  reconcile(
    pairing: Pairing,
    file: AttachmentFile,
    staged: StagedAttachment,
    anchor: EventAnchor,
  ): Promise<AttachmentReceipt | undefined>;
}
export const attachmentFileSchema = z
  .object({
    filename: z
      .string()
      .min(5)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(pdf|docx|pages)$/),
    mimeType: documentMime,
    byteLength: z
      .number()
      .int()
      .min(5)
      .max(10 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function attachmentFilename(
  name: string,
  mimeType: AttachmentFile["mimeType"],
): string {
  const extension =
    mimeType === "application/pdf"
      ? "pdf"
      : mimeType === "application/vnd.apple.pages"
        ? "pages"
        : "docx";
  let base = name
    .replace(/\.(pdf|docx|pages)$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!base) base = "document";
  if (!/^[A-Za-z0-9]/.test(base)) base = `document${base}`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base += "_";
  return `${base.slice(0, 159 - extension.length)}.${extension}`;
}
export function validateAttachmentBytes(
  file: AttachmentFile,
  bytes: Uint8Array,
) {
  attachmentFileSchema.parse(file);
  if (
    bytes.byteLength !== file.byteLength ||
    (file.mimeType === "application/pdf"
      ? Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
      : Buffer.from(bytes.subarray(0, 4)).toString("hex") !== "504b0304") ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw new DomainError(
      409,
      "Selected document bytes no longer match the approved file.",
    );
}
const attachmentId = z.string().regex(/^att_[a-f0-9]{32}$/);
const guid = z.string().uuid();
const summarySchema = z.object({
  id: attachmentId,
  filename: z.string(),
  mime_type: z.string(),
  total_bytes: z.number().int(),
  message_id: guid.optional(),
});
function exactSummary(raw: unknown, file: AttachmentFile, id?: string) {
  const parsed = summarySchema.parse(raw);
  if (
    (id && parsed.id !== id) ||
    parsed.filename !== file.filename ||
    parsed.mime_type !== file.mimeType ||
    parsed.total_bytes !== file.byteLength
  )
    throw new DomainError(
      409,
      "Provider attachment identity differs from the selected document.",
    );
  return parsed;
}
/** Native attachment sends bypass its text outbox. Never retry a POST here. */
export class NativeAttachmentPort implements AttachmentPort {
  constructor(readonly transport: NativeTransport) {}
  private target(pairing: Pairing) {
    if (
      pairing.lineId !== this.transport.config.binding.lineId ||
      ![
        `iMessage;-;${pairing.recipient}`,
        `any;-;${pairing.recipient}`,
      ].includes(pairing.conversationId)
    )
      throw new DomainError(
        403,
        "Attachment target is not the paired iMessage conversation.",
      );
  }
  async stage(
    pairing: Pairing,
    file: AttachmentFile,
    bytes: Uint8Array,
    beforeDispatch: () => void,
  ) {
    validateAttachmentBytes(file, bytes);
    const dataBase64 = Buffer.from(bytes).toString("base64");
    this.target(pairing);
    await this.transport.attachmentPreflight(pairing);
    beforeDispatch();
    const result = await this.transport.messages.api("/api/v1/attachments", {
      filename: file.filename,
      mime_type: file.mimeType,
      data_base64: dataBase64,
    });
    const staged = exactSummary(result.attachment, file);
    if (
      (result.attachment as Record<string, unknown>).transfer_state !== "ready"
    )
      throw new Error("Attachment staging outcome requires reconciliation.");
    return { attachmentId: staged.id };
  }
  async send(
    pairing: Pairing,
    file: AttachmentFile,
    staged: StagedAttachment,
    beforeDispatch: (anchor: EventAnchor) => void,
  ) {
    attachmentFileSchema.parse(file);
    attachmentId.parse(staged.attachmentId);
    this.target(pairing);
    await this.transport.attachmentPreflight(pairing);
    const metadata = await this.transport.messages.api(
      `/api/v1/attachments/${staged.attachmentId}`,
    );
    exactSummary(metadata.attachment, file, staged.attachmentId);
    if (
      (metadata.attachment as Record<string, unknown>).transfer_state !==
      "ready"
    )
      throw new DomainError(409, "Provider attachment is not ready.");
    const cursor = this.transport.messages.cursor();
    if (!cursor)
      throw new DomainError(409, "Verified native event boundary is required.");
    const anchor = await this.transport.messages.verifyAnchor(cursor);
    beforeDispatch(anchor);
    const result = await this.transport.messages.api("/api/v1/send", {
      phone: pairing.recipient,
      attachments: [{ id: staged.attachmentId }],
    });
    const parsed = z
      .object({
        status: z.literal("sent"),
        delivery: z.literal("direct"),
        phone_line_id: z.string(),
        phone: z.string(),
        message_id: guid,
        attachments: z.array(summarySchema).length(1),
      })
      .parse(result);
    const attachment = exactSummary(
      parsed.attachments[0],
      file,
      staged.attachmentId,
    );
    if (
      parsed.phone_line_id !== this.transport.config.binding.providerLineId ||
      parsed.phone !== pairing.recipient ||
      attachment.message_id !== parsed.message_id
    )
      throw new Error("Attachment dispatch receipt mismatch; outcome unknown.");
    return {
      attachmentId: staged.attachmentId,
      messageId: parsed.message_id,
      providerLineId: parsed.phone_line_id,
      recipient: parsed.phone,
      evidence: "send_response" as const,
    };
  }
  /** Read-only bounded event scan. Never advances the shared Messages cursor. */
  async reconcile(
    pairing: Pairing,
    file: AttachmentFile,
    staged: StagedAttachment,
    anchor: EventAnchor,
  ) {
    this.target(pairing);
    attachmentFileSchema.parse(file);
    attachmentId.parse(staged.attachmentId);
    await this.transport.messages.verify();
    await this.transport.messages.verifyAnchor(anchor);
    let cursor = anchor.sequence;
    const found = new Map<string, AttachmentReceipt>();
    for (let page = 0; page < 10; page++) {
      const data = await this.transport.messages.api(
        `/api/v1/events/catchup?since_sequence=${cursor}&limit=100`,
      );
      const parsed = z
        .object({
          events: z
            .array(
              z.object({
                sequence: z.number().int().positive(),
                event_id: z.string(),
                type: z.string(),
                phone_line_id: z.string().optional(),
                payload: z.record(z.string(), z.unknown()),
              }),
            )
            .max(100),
          head_sequence: z.number().int().nonnegative(),
          has_more: z.boolean(),
        })
        .parse(data);
      for (const row of parsed.events) {
        if (
          row.sequence !== ++cursor ||
          [row.phone_line_id, row.payload.phone_line_id]
            .filter((v) => v !== undefined)
            .some((v) => v !== this.transport.config.binding.providerLineId)
        )
          throw new Error("Attachment reconciliation event boundary changed.");
        if (row.type !== "message_sent") continue;
        const message = z
          .object({
            guid,
            recipient: z.string(),
            phone_line_id: z.string(),
            attachments: z.array(summarySchema).length(1),
          })
          .safeParse(row.payload.message);
        if (
          !message.success ||
          message.data.recipient !== pairing.recipient ||
          message.data.phone_line_id !==
            this.transport.config.binding.providerLineId ||
          row.event_id !== `msg_sent:${message.data.guid}`
        )
          continue;
        const item = message.data.attachments[0]!;
        if (item.id !== staged.attachmentId) continue;
        exactSummary(item, file, staged.attachmentId);
        if (item.message_id !== message.data.guid)
          throw new Error("Attachment event identity mismatch.");
        found.set(message.data.guid, {
          attachmentId: staged.attachmentId,
          messageId: message.data.guid,
          providerLineId: message.data.phone_line_id,
          recipient: message.data.recipient,
          evidence: "provider_event",
          eventId: row.event_id,
          eventSequence: row.sequence,
        });
      }
      if (
        parsed.head_sequence < cursor ||
        (!parsed.has_more && parsed.head_sequence !== cursor) ||
        (parsed.has_more && !parsed.events.length)
      )
        throw new Error("Attachment event page is incomplete.");
      if (!parsed.has_more)
        return found.size === 1 ? [...found.values()][0] : undefined;
    }
    return undefined;
  }
}
