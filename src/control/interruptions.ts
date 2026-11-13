import { z } from "zod";
import type { ClawdTime } from "../attention/service.js";
import { DomainError, hash } from "../storage/security.js";

export const interruptionSchema = z
  .object({
    callId: z.string().min(1).max(160),
    participantIdentity: z.string().min(1).max(160),
    interruptionId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    playbackGeneration: z.number().int().nonnegative().safe(),
    at: z.string().datetime({ offset: true }),
  })
  .strict();
type Receipt = { id: string; fingerprint: string; holdUntil: number };

/** Candidate audio can temporarily hold input, never authorize new work. */
export class Interruptions {
  constructor(private readonly service: ClawdTime) {}
  accept(requestId: string, raw: unknown) {
    const input = interruptionSchema.parse(raw),
      now = this.service.clock();
    const at = Date.parse(input.at),
      fingerprint = hash(JSON.stringify(input));
    const key = `input-interruptions:${requestId}`;
    const receipts = this.service.store.state<Receipt[]>(key) ?? [];
    const id = hash(input.interruptionId),
      previous = receipts.find((r) => r.id === id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError(409, "Interruption identity changed.");
      return { accepted: true, holdUntil: previous.holdUntil };
    }
    if (now - at > 2000 || at - now > 250)
      throw new DomainError(409, "Interruption is stale.");
    const receipt = {
      id,
      fingerprint,
      holdUntil: Math.min(now + 2000, at + 2000),
    };
    this.service.store.saveState(
      key,
      [...receipts.filter((r) => r.holdUntil > now), receipt].slice(-64),
    );
    return { accepted: true, holdUntil: receipt.holdUntil };
  }
  status(requestId: string) {
    const now = this.service.clock();
    const holdUntil = Math.max(
      0,
      ...(
        this.service.store.state<Receipt[]>(
          `input-interruptions:${requestId}`,
        ) ?? []
      ).map((r) => r.holdUntil),
    );
    return {
      active: holdUntil > now,
      holdUntil: holdUntil > now ? holdUntil : null,
      reason: holdUntil > now ? "incoming_speech" : null,
    };
  }
  assertClear(requestId: string) {
    if (this.status(requestId).active)
      throw new DomainError(
        409,
        "Incoming speech temporarily holds new input.",
        "input_held",
      );
  }
}
