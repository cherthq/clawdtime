// Narrow DM extraction from Apple Teams src/chert/messages.ts at be47b11.
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Pairing } from "../contracts.js";
import { Store } from "../storage/store.js";
import { DomainError, hash } from "../storage/security.js";
export interface MessageBinding {
  origin: string;
  token: string;
  signingSecret: string;
  lineId: string;
  providerLineId: string;
  phone: string;
  instanceId: string;
}
export interface NativeMessage {
  id: string;
  lineId: string;
  sender: string;
  conversationId: string;
  text: string;
}
const rowSchema = z.object({
  sequence: z.number().int().positive(),
  event_id: z.string().min(1),
  type: z.string(),
  phone_line_id: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export interface EventAnchor {
  sequence: number;
  eventId: string;
  fingerprint?: string;
}
function identity(row: z.infer<typeof rowSchema>, binding: MessageBinding) {
  const identities = [row.phone_line_id, row.payload.phone_line_id].filter(
    (v) => v !== undefined,
  );
  if (
    !identities.length ||
    identities.some((v) => v !== binding.providerLineId)
  )
    throw new DomainError(409, "Native event line identity changed.");
}
export function normalizeNativeEvent(
  raw: unknown,
  binding: MessageBinding,
): NativeMessage | null {
  const row = rowSchema.parse(raw);
  identity(row, binding);
  if (row.type !== "message_received") return null;
  const rawMessage = row.payload.message as Record<string, unknown> | undefined;
  if (rawMessage?.phone_line_id !== binding.providerLineId)
    throw new DomainError(409, "Message line identity changed.");
  const parsed = z
    .object({
      guid: z.string().min(1),
      phone_line_id: z.string(),
      role: z.literal("inbound"),
      status: z.literal("received"),
      service: z.literal("imessage"),
      recipient: z.string().regex(/^\+[1-9]\d{7,14}$/),
      chat_id: z.string(),
      is_group: z.literal(false),
      parts: z
        .array(
          z.object({
            type: z.literal("text"),
            text: z.string().min(1).max(8000),
            value: z.string().optional(),
          }),
        )
        .min(1)
        .max(16),
    })
    .safeParse(rawMessage);
  if (!parsed.success) return null;
  const m = parsed.data;
  if (
    row.event_id !== `recv:${m.guid}` ||
    m.parts.some((p) => p.value !== undefined && p.value !== p.text)
  )
    throw new DomainError(409, "Conflicting native message evidence.");
  if (
    ![`iMessage;-;${m.recipient}`, `any;-;${m.recipient}`].includes(m.chat_id)
  )
    return null;
  const text = m.parts.map((p) => p.text).join("\n");
  if (text.length > 8000) return null;
  return {
    id: `native:${hash(binding.lineId).slice(0, 16)}:${hash(row.event_id)}`,
    lineId: binding.lineId,
    sender: m.recipient,
    conversationId: m.chat_id,
    text,
  };
}
// Exact source exception: an opt-out observation is administrative evidence only.
// It has no command authority and must correlate to an earlier authenticated DM.
function correlatedAdminObservation(
  row: z.infer<typeof rowSchema>,
  candidates: unknown[],
  binding: MessageBinding,
) {
  if (
    row.type !== "lead_opted_out" ||
    row.phone_line_id !== undefined ||
    row.payload.phone_line_id !== undefined ||
    row.payload.source !== "inbound" ||
    typeof row.payload.message_guid !== "string" ||
    row.event_id !== `optout:${row.payload.message_guid}`
  )
    return false;
  return candidates.some((raw) => {
    const parsed = rowSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.sequence >= row.sequence ||
      parsed.data.type !== "message_received" ||
      parsed.data.event_id !== `recv:${row.payload.message_guid}`
    )
      return false;
    const event = normalizeNativeEvent(parsed.data, binding);
    return !!event && event.sender === row.payload.recipient_phone;
  });
}
export async function jsonRequest(
  url: string,
  init: RequestInit,
  request: typeof fetch = fetch,
) {
  const response = await request(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Provider returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024)
    throw new Error("Provider response too large.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provider response is not an object.");
  return value as Record<string, unknown>;
}
export class NativeMessages {
  private polling = false;
  constructor(
    readonly store: Store,
    readonly binding: MessageBinding,
    readonly request: typeof fetch = fetch,
  ) {
    const u = new URL(binding.origin);
    if (
      u.protocol !== "https:" ||
      u.origin !== binding.origin ||
      u.username ||
      u.password
    )
      throw new Error("Native origin must be a bare HTTPS origin.");
  }
  async api(path: string, body?: unknown) {
    const raw = body === undefined ? "" : JSON.stringify(body),
      ts = Math.floor(Date.now() / 1000);
    return jsonRequest(
      this.binding.origin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.binding.token}`,
          "x-chert-signature": `v1,${ts},${createHmac("sha256", this.binding.signingSecret).update(`${ts}.${raw}`).digest("hex")}`,
          "content-type": "application/json",
          "ngrok-skip-browser-warning": "true",
        },
        ...(raw ? { body: raw } : {}),
      },
      this.request,
    );
  }
  async verify() {
    const result = await this.api("/api/v1/whoami"),
      line = result.phone_line as Record<string, unknown> | undefined;
    if (
      !line ||
      line.phone_line_id !== this.binding.providerLineId ||
      line.phone_number !== this.binding.phone ||
      line.instance_id !== this.binding.instanceId
    )
      throw new DomainError(
        409,
        "Native identity differs from configured exact line.",
      );
    if (result.healthy !== true)
      throw new DomainError(503, "Native line is unhealthy.");
    return result;
  }
  cursor() {
    return this.store.state<EventAnchor>(`messages:${this.binding.lineId}`);
  }
  async baseline(sequence: number, eventId: string) {
    await this.verify();
    if (this.cursor())
      throw new DomainError(
        409,
        "Existing cursor must be reconciled, never replaced.",
      );
    const row = rowSchema.parse(await this.api(`/api/v1/events/${sequence}`));
    identity(row, this.binding);
    if (row.sequence !== sequence || row.event_id !== eventId)
      throw new DomainError(409, "Baseline does not match retained anchor.");
    this.store.saveState(`messages:${this.binding.lineId}`, {
      sequence,
      eventId,
      fingerprint: hash(JSON.stringify(row)),
    });
  }
  async poll(receive: (event: NativeMessage) => void) {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.verify();
      const cursor = this.cursor();
      if (!cursor) throw new DomainError(409, "No verified native baseline.");
      const anchor = rowSchema.parse(
        await this.api(`/api/v1/events/${cursor.sequence}`),
      );
      // A previously validated admin observation can be the retained cursor.
      // Its exact committed fingerprint carries the earlier correlation proof.
      if (cursor.fingerprint) {
        if (hash(JSON.stringify(anchor)) !== cursor.fingerprint)
          throw new DomainError(409, "Retained cursor evidence changed.");
      } else identity(anchor, this.binding);
      if (
        anchor.sequence !== cursor.sequence ||
        anchor.event_id !== cursor.eventId
      )
        throw new DomainError(409, "Retained cursor anchor changed.");
      const page = await this.api(
          `/api/v1/events/catchup?since_sequence=${cursor.sequence}&limit=100`,
        ),
        rows = z.array(rowSchema).max(100).parse(page.events);
      let expected = cursor.sequence;
      for (const row of rows) {
        if (!correlatedAdminObservation(row, [anchor, ...rows], this.binding))
          identity(row, this.binding);
        if (row.sequence !== ++expected)
          throw new DomainError(409, "Native event sequence gap.");
      }
      if (
        !Number.isSafeInteger(page.head_sequence) ||
        Number(page.head_sequence) < expected ||
        typeof page.has_more !== "boolean" ||
        (!page.has_more && page.head_sequence !== expected)
      )
        throw new DomainError(409, "Native event head inconsistent.");
      for (const row of rows)
        this.store.transaction(() => {
          const event =
            row.type === "message_received"
              ? normalizeNativeEvent(row, this.binding)
              : null;
          if (event) receive(event);
          this.store.saveState(`messages:${this.binding.lineId}`, {
            sequence: row.sequence,
            eventId: row.event_id,
            fingerprint: hash(JSON.stringify(row)),
          });
        });
    } finally {
      this.polling = false;
    }
  }
  async send(pairing: Pairing, text: string, effectId: string) {
    await this.verify();
    if (
      pairing.lineId !== this.binding.lineId ||
      ![
        `iMessage;-;${pairing.recipient}`,
        `any;-;${pairing.recipient}`,
      ].includes(pairing.conversationId)
    )
      throw new DomainError(
        403,
        "Message target does not match bound direct conversation.",
      );
    if (!text.trim() || text.length > 8000 || Buffer.byteLength(text) > 16384)
      throw new DomainError(422, "Message exceeds native limits.");
    const operation = {
      origin: `text_${hash(effectId).slice(0, 32)}`,
      from: this.binding.phone,
      to: pairing.recipient,
      text,
    };
    const r = await this.api("/api/v1/text-operations/v1", operation);
    const fingerprint = hash(
      JSON.stringify([
        "chert-text-once-v1",
        operation.from,
        operation.to,
        text,
      ]).replaceAll("/", "\\/"),
    );
    if (
      r.origin !== operation.origin ||
      r.from !== operation.from ||
      r.to !== operation.to ||
      r.fingerprint !== fingerprint ||
      r.state !== "acknowledged" ||
      typeof r.preparedGuid !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(r.preparedGuid)
    )
      throw new Error("Native text acknowledgement missing; outcome unknown.");
    return {
      accepted: true,
      receiptId: r.preparedGuid,
      status: "acknowledged",
      operationOrigin: operation.origin,
    };
  }
}
