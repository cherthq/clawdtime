import { z } from "zod";
import type { ClawdTime } from "./service.js";
import type {
  ConversationTurn,
  ConversationTurnState,
} from "./conversation.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  Pairing,
} from "../contracts.js";
import { DomainError, hash } from "../storage/security.js";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const summarySchema = z
  .string()
  .min(1)
  .refine(
    (s) =>
      [...s].length <= 160 &&
      Buffer.byteLength(s) <= 640 &&
      !/[\p{Cc}\p{Cs}]/u.test(s),
    "Summary must be at most 160 Unicode characters and 640 UTF-8 bytes, without controls.",
  );
export const presentationSchema = z
  .object({
    version: z.literal(1),
    activity: z
      .object({
        activityId: identifier,
        kind: z.enum(["status", "approval_needed"]),
        summary: summarySchema,
      })
      .strict()
      .optional(),
    outcome: z
      .object({
        outcomeId: identifier,
        summary: summarySchema,
        verification: z.enum(["agent_observed", "not_verified", "unknown"]),
        evidenceKind: z
          .enum(["ui_observation", "test_result", "artifact"])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const order = z.number().int().nonnegative().safe();
const work = z.enum([
  "received",
  "executing",
  "pending_approval",
  "completed",
  "canceled",
  "uncertain",
]);
export const activityProjectionSchema = z
  .object({
    version: z.literal(1),
    sequence: order,
    delivery: z.enum(["pending", "acknowledged"]),
    work,
    expiresAt: z.string().datetime({ offset: true }).optional(),
    currentSummary: summarySchema.optional(),
    entries: z
      .array(
        z.object({
          activityId: identifier,
          sequence: order,
          kind: z.enum(["status", "approval_needed", "outcome"]),
          summary: summarySchema.optional(),
        }),
      )
      .max(20),
    outcome: z
      .object({
        outcomeId: identifier,
        status: z.enum(["completed", "canceled", "uncertain"]),
        verification: z.enum(["agent_observed", "not_verified", "unknown"]),
        evidenceKind: z
          .enum(["ui_observation", "test_result", "artifact"])
          .optional(),
        summary: summarySchema.optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.entries.every(
        (entry, i) =>
          entry.sequence <= value.sequence &&
          (i === 0 || entry.sequence > value.entries[i - 1]!.sequence),
      ) &&
      (!value.outcome || value.outcome.status === value.work),
    "Projection ordering or outcome state mismatch.",
  );
export type PresentationInput = z.infer<typeof presentationSchema>;
export interface PresentationReceipt {
  activityId: string;
  sequence: number;
  kind: "status" | "approval_needed" | "outcome";
  fingerprint: string;
  createdAt: number;
  outcomeId?: string;
  status?: ConversationTurnState;
  verification?: "agent_observed" | "not_verified" | "unknown";
  evidenceKind?: "ui_observation" | "test_result" | "artifact";
}
const terminal = new Set(["completed", "canceled", "uncertain"]);
const instances = new WeakMap<ClawdTime, PresentationStore>();
export function presentationFor(service: ClawdTime) {
  let value = instances.get(service);
  if (!value) {
    value = new PresentationStore(service);
    instances.set(service, value);
  }
  return value;
}
/** Text never enters SQLite. Durable bounded per-turn fingerprints reject replay. */
export class PresentationStore {
  private text = new Map<
    string,
    Map<string, { summary: string; expiresAt: number; turnId: string }>
  >();
  constructor(readonly service: ClawdTime) {}
  reset() {
    this.text.clear();
    // A restarted publisher invalidates previously displayed text even for a
    // completed turn whose durable work state did not change.
    for (const requestId of new Set(
      this.service.store
        .all<ConversationTurn>("conversation_turn")
        .filter((t) => t.presentation?.length)
        .map((t) => t.requestId),
    ))
      this.bump(requestId);
  }
  bump(requestId: string) {
    const n =
      (this.service.store.state<number>(`presentation-sequence:${requestId}`) ??
        0) + 1;
    this.service.store.saveState(`presentation-sequence:${requestId}`, n);
    return n;
  }
  clear(requestId: string) {
    if (this.text.delete(requestId)) this.bump(requestId);
  }
  clearTurn(requestId: string, turnId: string) {
    const cache = this.text.get(requestId);
    if (!cache) return;
    let changed = false;
    for (const [id, value] of cache)
      if (value.turnId === turnId) {
        cache.delete(id);
        changed = true;
      }
    if (!cache.size) this.text.delete(requestId);
    if (changed) this.bump(requestId);
  }
  private authorized(requestId: string) {
    const s = this.service.store,
      now = this.service.clock();
    const r = s.get<AttentionRequest>("attention", requestId);
    const agent = r && s.get<AgentSession>("session", r.sessionId);
    const call = r && s.get<CallSession>("call", r.callId ?? "");
    const pairing = r && s.get<Pairing>("pairing", r.pairingId);
    return !!(
      r &&
      agent &&
      pairing &&
      !pairing.revokedAt &&
      agent.state !== "stopped" &&
      agent.protocolVersion === 2 &&
      now - (agent.lastSeenAt ?? agent.createdAt) < 20000 &&
      (agent.lastSeenAt ?? agent.createdAt) <= now + 1000 &&
      r.deadline > now &&
      ["connected", "awaiting_input", "response_delivered"].includes(r.state) &&
      call?.state === "connected" &&
      call.requestId === r.id &&
      call.pairingId === r.pairingId &&
      agent.pairingId === r.pairingId &&
      call.remoteParticipantQualified &&
      !s.state(`view-stopped:${r.id}`) &&
      !s.state(`listening-stopped:${r.id}`)
    );
  }
  prune() {
    const now = this.service.clock();
    for (const [requestId, values] of this.text) {
      if (!this.authorized(requestId)) {
        this.clear(requestId);
        continue;
      }
      let changed = false;
      for (const [id, v] of values)
        if (v.expiresAt <= now) {
          values.delete(id);
          changed = true;
        }
      if (!values.size) this.text.delete(requestId);
      if (changed) this.bump(requestId);
    }
  }
  /** Validate before changing work state. Capacity only drops optional presentation. */
  prepare(
    turn: ConversationTurn,
    state: ConversationTurnState,
    raw?: PresentationInput,
  ) {
    if (!raw) return [];
    const input = presentationSchema.parse(raw);
    if (input.outcome && !terminal.has(state))
      throw new DomainError(409, "An outcome requires terminal turn progress.");
    if (
      input.activity?.kind === "approval_needed" &&
      state !== "pending_approval"
    )
      throw new DomainError(
        409,
        "Approval activity requires pending approval.",
      );
    if (
      input.outcome &&
      state === "uncertain" &&
      input.outcome.verification !== "unknown"
    )
      throw new DomainError(
        409,
        "Uncertain outcomes require unknown verification.",
      );
    if (input.activity && terminal.has(state))
      throw new DomainError(409, "Terminal progress accepts only an outcome.");
    const items = [
      ...(input.activity ? [{ ...input.activity }] : []),
      ...(input.outcome
        ? [
            {
              activityId: input.outcome.outcomeId,
              kind: "outcome" as const,
              ...input.outcome,
              status: state,
            },
          ]
        : []),
    ];
    return items.map((item) => {
      const fingerprint = hash(JSON.stringify({ state, ...item }));
      const previous = turn.presentation?.find(
        (p) => p.activityId === item.activityId,
      );
      if (previous && previous.fingerprint !== fingerprint)
        throw new DomainError(
          409,
          "Presentation identity changed; reconcile the original receipt.",
        );
      if (
        !previous &&
        item.kind === "outcome" &&
        turn.presentation?.some((p) => p.kind === "outcome")
      )
        throw new DomainError(409, "This turn already has an outcome receipt.");
      return { item, fingerprint, previous };
    });
  }
  record(
    turn: ConversationTurn,
    prepared: ReturnType<PresentationStore["prepare"]>,
  ) {
    this.prune();
    const receipts = [...(turn.presentation ?? [])];
    if (terminal.has(turn.state)) {
      const cache = this.text.get(turn.requestId);
      if (cache)
        for (const [id, value] of cache)
          if (value.turnId === turn.id) cache.delete(id);
    }
    for (const { item, fingerprint, previous } of prepared) {
      if (previous || receipts.length >= (item.kind === "outcome" ? 20 : 19))
        continue;
      const sequence = this.bump(turn.requestId),
        createdAt = this.service.clock();
      const { summary, ...metadata } = item;
      receipts.push({ ...metadata, fingerprint, sequence, createdAt });
      if (this.authorized(turn.requestId)) {
        let cache = this.text.get(turn.requestId);
        if (!cache && this.text.size < 100) {
          cache = new Map();
          this.text.set(turn.requestId, cache);
        }
        if (cache && cache.size < 20)
          cache.set(`${turn.id}:${item.activityId}`, {
            summary,
            turnId: turn.id,
            expiresAt: createdAt + (item.kind === "outcome" ? 60000 : 600000),
          });
      }
    }
    return this.service.store.put<ConversationTurn>("conversation_turn", {
      ...turn,
      ...(receipts.length ? { presentation: receipts } : {}),
    });
  }
  projection(requestId: string) {
    this.prune();
    const turns = this.service.store
      .all<ConversationTurn>("conversation_turn")
      .filter((t) => t.requestId === requestId)
      .sort((a, b) => a.sequence - b.sequence);
    const last = turns.at(-1);
    const focus =
      turns.find((t) => t.state === "uncertain") ??
      turns.find((t) => ["executing", "pending_approval"].includes(t.state)) ??
      last;
    const cache = this.text.get(requestId);
    const entries = turns
      .flatMap((t) =>
        (t.presentation ?? []).map((p) => ({
          ...p,
          turnId: t.id,
          text: cache?.get(`${t.id}:${p.activityId}`),
        })),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-20);
    const outcome = entries.findLast(
      (p) => p.kind === "outcome" && p.turnId === focus?.id,
    );
    const current = entries.findLast(
      (p) => p.turnId === focus?.id && p.kind !== "outcome" && p.text,
    );
    const expires = entries.flatMap((p) => (p.text ? [p.text.expiresAt] : []));
    return {
      version: 1 as const,
      sequence:
        this.service.store.state<number>(
          `presentation-sequence:${requestId}`,
        ) ?? 0,
      delivery: last?.delivery ?? "pending",
      work: focus?.state ?? "received",
      ...(current?.text && !terminal.has(focus?.state ?? "")
        ? { currentSummary: current.text.summary }
        : {}),
      ...(expires.length
        ? { expiresAt: new Date(Math.min(...expires)).toISOString() }
        : {}),
      entries: entries.map((p) => ({
        activityId: p.activityId,
        sequence: p.sequence,
        kind: p.kind,
        ...(p.text ? { summary: p.text.summary } : {}),
      })),
      ...(outcome
        ? {
            outcome: {
              outcomeId: outcome.outcomeId!,
              status: outcome.status!,
              verification: outcome.verification!,
              ...(outcome.evidenceKind
                ? { evidenceKind: outcome.evidenceKind }
                : {}),
              ...(outcome.text ? { summary: outcome.text.summary } : {}),
            },
          }
        : {}),
    };
  }
}
