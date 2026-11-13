import { timelineFor } from "../transport/conversation-timeline.js";
import { z } from "zod";
import {
  presentationFor,
  type PresentationInput,
  type PresentationReceipt,
} from "./presentation.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
} from "../contracts.js";
import { DomainError, hash, id } from "../storage/security.js";
import type { ClawdTime, ResponseInput } from "./service.js";

export type ConversationTurnState =
  | "received"
  | "executing"
  | "completed"
  | "canceled"
  | "uncertain"
  | "pending_approval";
export interface ConversationTurn {
  id: string;
  requestId: string;
  sessionId: string;
  sequence: number;
  channel: "voice" | "text";
  text?: string;
  kind: "answer" | "correction" | "approval";
  createdAt: number;
  updatedAt: number;
  delivery: "pending" | "acknowledged";
  acknowledgedAt?: number;
  state: ConversationTurnState;
  cancellationRequestedAt?: number;
  presentation?: PresentationReceipt[];
  correlationId?: string;
}
export interface ConversationReply {
  id: string;
  requestId: string;
  sessionId: string;
  turnId: string;
  fingerprint: string;
  checkedAt?: number;
  state:
    | "dispatching"
    | "accepted"
    | "playing"
    | "completed"
    | "cancelled"
    | "failed"
    | "unknown";
  createdAt: number;
}
const identity = z.string().min(1).max(512);
const responseSchema = z
  .object({
    eventId: identity,
    requestId: identity,
    memberId: identity,
    lineId: identity,
    conversationId: identity,
    channel: z.enum(["text", "voice"]),
    text: z.string().trim().min(1).max(8000),
    kind: z.enum(["answer", "correction", "approval"]).optional(),
    qualifiedRemoteAudio: z.boolean().optional(),
    callId: identity.optional(),
  })
  .strict();
const terminal = new Set([
  "completed",
  "declined",
  "unanswered",
  "canceled",
  "expired",
  "disconnected",
  "failed",
  "unknown",
]);
const terminalTurn = new Set<ConversationTurnState>([
  "completed",
  "canceled",
  "uncertain",
]);
const finalSpeech = new Set(["completed", "cancelled", "failed"]);
const maxTextAgeMs = 24 * 60 * 60 * 1000;

/** Bounded durable delivery to the exact originating agent. No secondary model. */
export class ConversationService {
  private speaking = new Set<string>();
  constructor(readonly service: ClawdTime) {
    presentationFor(service).reset();
    // A process restart cannot prove that a client-side action was completed.
    for (const turn of service.store.all<ConversationTurn>("conversation_turn"))
      if (turn.state === "executing") this.saveTurn(turn, "uncertain");
    for (const reply of service.store.all<ConversationReply>(
      "conversation_reply",
    ))
      if (reply.state === "dispatching")
        service.store.put("conversation_reply", { ...reply, state: "unknown" });
    this.prune();
  }
  private owned(raw: string, requestId: string, requireOpen = false) {
    this.service.expireSessions();
    const session = this.service.authenticateSession(raw);
    const request = this.service.status(raw, requestId);
    if (session.protocolVersion !== 2)
      throw new DomainError(
        409,
        "This session uses the legacy attention protocol.",
      );
    if (requireOpen) this.open(session, request);
    return { session, request };
  }
  private open(session: AgentSession, request: AttentionRequest) {
    if (
      session.state === "stopped" ||
      session.pairingId !== request.pairingId ||
      session.id !== request.sessionId ||
      session.protocolVersion !== 2 ||
      this.service.clock() - (session.lastSeenAt ?? session.createdAt) >=
        20_000 ||
      (session.lastSeenAt ?? session.createdAt) > this.service.clock() + 1000 ||
      terminal.has(request.state) ||
      request.deadline <= this.service.clock() ||
      this.service.store.state(`listening-stopped:${request.id}`)
    )
      throw new DomainError(
        409,
        "Conversation is unavailable or no longer listening.",
      );
    this.service.pairing(session.pairingId);
  }
  private qualified(input: ResponseInput) {
    const value = responseSchema.parse(input);
    const store = this.service.store;
    const request = store.get<AttentionRequest>("attention", value.requestId);
    const session =
      request && store.get<AgentSession>("session", request.sessionId);
    if (!request || !session || session.protocolVersion !== 2)
      throw new DomainError(404, "Agent-owned conversation is unavailable.");
    const pairing = this.service.pairing(request.pairingId);
    if (
      pairing.memberId !== value.memberId ||
      pairing.lineId !== value.lineId ||
      pairing.conversationId !== value.conversationId
    )
      throw new DomainError(
        403,
        "Conversation feedback identity does not match.",
      );
    if (value.channel === "voice") {
      const call = store.get<CallSession>("call", request.callId ?? "");
      if (
        !value.qualifiedRemoteAudio ||
        !call ||
        call.id !== value.callId ||
        call.requestId !== request.id ||
        call.pairingId !== pairing.id ||
        call.state !== "connected" ||
        !call.remoteParticipantQualified
      )
        throw new DomainError(
          403,
          "Voice requires the qualified participant of this call.",
        );
      if (value.kind === "approval")
        throw new DomainError(
          403,
          "Voice cannot replace native agent approval.",
        );
    }
    return { value, request, session };
  }
  reconcile(input: ResponseInput): ConversationTurn | undefined {
    const { value } = this.qualified(input);
    const previous = this.service.store.event<{ turnId: string }>(
      `conversation:${value.eventId}`,
    );
    if (!previous) return undefined;
    if (previous.fingerprint !== hash(JSON.stringify(value)))
      throw new DomainError(409, "Inbound event identity changed.");
    this.prune();
    return this.service.store.get<ConversationTurn>(
      "conversation_turn",
      previous.result.turnId,
    );
  }
  receive(input: ResponseInput): ConversationTurn {
    const { value, session, request } = this.qualified(input);
    return this.service.store.transaction(() => {
      const previous = this.reconcile(value);
      if (previous) return previous;
      this.open(session, request);
      this.prune();
      const turns = this.turns(request.id);
      if (turns.filter((t) => !terminalTurn.has(t.state)).length >= 100)
        throw new DomainError(
          409,
          "Conversation queue is full; acknowledge and finish earlier turns.",
        );
      const now = this.service.clock();
      const turn = this.service.store.put<ConversationTurn>(
        "conversation_turn",
        {
          id: id("turn"),
          requestId: request.id,
          sessionId: session.id,
          sequence: (turns.at(-1)?.sequence ?? 0) + 1,
          ...(value.eventId.startsWith("voice:")
            ? { correlationId: hash(value.eventId.slice(6)).slice(0, 24) }
            : {}),
          channel: value.channel,
          text: value.text,
          kind: value.kind ?? "answer",
          createdAt: now,
          updatedAt: now,
          delivery: "pending",
          state: "received",
        },
      );
      // Event records retain only the receipt pointer, never duplicate transcripts.
      this.service.store.recordEvent(
        `conversation:${value.eventId}`,
        hash(JSON.stringify(value)),
        { turnId: turn.id },
      );
      timelineFor(this.service).record(
        request.id,
        "callback_accepted",
        turn.correlationId ?? turn.id,
      );
      presentationFor(this.service).bump(request.id);
      return turn;
    });
  }
  private turns(requestId: string) {
    return this.service.store
      .all<ConversationTurn>("conversation_turn")
      .filter((t) => t.requestId === requestId)
      .sort((a, b) => a.sequence - b.sequence);
  }
  private turn(requestId: string, turnId: string) {
    const turn = this.service.store.get<ConversationTurn>(
      "conversation_turn",
      turnId,
    );
    if (!turn || turn.requestId !== requestId)
      throw new DomainError(404, "Turn does not belong to this conversation.");
    return turn;
  }
  private saveTurn(turn: ConversationTurn, state: ConversationTurnState) {
    const next = { ...turn, state, updatedAt: this.service.clock() };
    if (terminalTurn.has(state)) {
      delete next.text;
      presentationFor(this.service).clearTurn(turn.requestId, turn.id);
    }
    presentationFor(this.service).bump(turn.requestId);
    return this.service.store.put<ConversationTurn>("conversation_turn", next);
  }
  /** Pending content expires after 24h; receipts/fingerprints remain for deduplication. */
  prune() {
    presentationFor(this.service).prune();
    for (const turn of this.service.store.all<ConversationTurn>(
      "conversation_turn",
    )) {
      const request = this.service.store.get<AttentionRequest>(
        "attention",
        turn.requestId,
      );
      if (
        !terminalTurn.has(turn.state) &&
        (this.service.clock() - turn.createdAt >= maxTextAgeMs ||
          !request ||
          terminal.has(request.state) ||
          this.service.store.state(`listening-stopped:${turn.requestId}`))
      )
        this.saveTurn(
          turn,
          turn.state === "executing" ? "uncertain" : "canceled",
        );
      else if (terminalTurn.has(turn.state) && turn.text !== undefined)
        this.saveTurn(turn, turn.state);
    }
  }
  poll(raw: string, requestId: string, afterSequence = 0) {
    const { request, session } = this.owned(raw, requestId);
    z.number().int().nonnegative().safe().parse(afterSequence);
    this.prune();
    const all = this.turns(requestId),
      cursor = all.at(-1)?.sequence ?? 0;
    if (afterSequence > cursor)
      throw new DomainError(
        409,
        "Conversation cursor is ahead of durable history.",
      );
    const turns = all.filter((t) => t.sequence > afterSequence).slice(0, 100);
    return {
      request,
      session,
      capabilities: { presentationVersion: 1 },
      activity: presentationFor(this.service).projection(requestId),
      turns,
      cursor: turns.at(-1)?.sequence ?? afterSequence,
      replies: this.service.store
        .all<ConversationReply>("conversation_reply")
        .filter((r) => r.requestId === requestId),
    };
  }
  /** Bounded, read-only reconciliation before a poll; no transcript or speech replay. */
  async reconcileReplies(raw: string, requestId: string) {
    const { request } = this.owned(raw, requestId);
    const lookup = this.service.transport.speechStatus;
    if (!lookup) return;
    const pairing = this.service.pairing(request.pairingId);
    const pending = this.service.store
      .all<ConversationReply>("conversation_reply")
      .filter(
        (r) =>
          r.requestId === requestId &&
          !finalSpeech.has(r.state) &&
          !this.speaking.has(r.id),
      )
      .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
      .slice(0, 4);
    await Promise.all(
      pending.map(async (reply) => {
        this.speaking.add(reply.id);
        try {
          const result = await lookup.call(
            this.service.transport,
            request,
            pairing,
            reply.id,
          );
          const state = z
            .enum([
              "accepted",
              "playing",
              "completed",
              "cancelled",
              "failed",
              "unknown",
            ])
            .parse(result.state);
          const current = this.service.store.get<ConversationReply>(
            "conversation_reply",
            reply.id,
          )!;
          if (!finalSpeech.has(current.state))
            this.service.store.put<ConversationReply>("conversation_reply", {
              ...current,
              state,
              checkedAt: this.service.clock(),
            });
        } catch {
          const current = this.service.store.get<ConversationReply>(
            "conversation_reply",
            reply.id,
          )!;
          if (!finalSpeech.has(current.state))
            this.service.store.put<ConversationReply>("conversation_reply", {
              ...current,
              state: "unknown",
              checkedAt: this.service.clock(),
            });
        } finally {
          this.speaking.delete(reply.id);
        }
      }),
    );
  }
  acknowledge(raw: string, requestId: string, turnId: string) {
    this.owned(raw, requestId);
    return this.service.store.transaction(() => {
      const turn = this.turn(requestId, turnId);
      if (turn.delivery === "acknowledged") return turn;
      if (
        this.turns(requestId).some(
          (t) => t.sequence < turn.sequence && t.delivery !== "acknowledged",
        )
      )
        throw new DomainError(409, "Acknowledge earlier turn delivery first.");
      timelineFor(this.service).record(
        requestId,
        "agent_acknowledged",
        turn.correlationId ?? turn.id,
      );
      presentationFor(this.service).bump(requestId);
      return this.service.store.put<ConversationTurn>("conversation_turn", {
        ...turn,
        delivery: "acknowledged",
        acknowledgedAt: this.service.clock(),
        updatedAt: this.service.clock(),
      });
    });
  }
  progress(
    raw: string,
    requestId: string,
    turnId: string,
    state: Exclude<ConversationTurnState, "received">,
    presentation?: PresentationInput,
  ) {
    const { session, request } = this.owned(raw, requestId);
    z.enum([
      "executing",
      "completed",
      "canceled",
      "uncertain",
      "pending_approval",
    ]).parse(state);
    return this.service.store.transaction(() => {
      const turn = this.turn(requestId, turnId);
      const display = presentationFor(this.service);
      const prepared = display.prepare(turn, state, presentation);
      if (turn.state === state) {
        if (!terminalTurn.has(turn.state)) this.open(session, request);
        if (terminalTurn.has(turn.state) && prepared.some((p) => !p.previous))
          throw new DomainError(
            409,
            "Terminal presentation cannot be replaced or revived.",
          );
        const result = prepared.some((p) => !p.previous)
          ? display.record(turn, prepared)
          : turn;
        return { ...result, activity: display.projection(requestId) };
      }
      this.open(session, request);
      if (turn.delivery !== "acknowledged")
        throw new DomainError(
          409,
          "Acknowledge turn delivery before reporting progress.",
        );
      if (terminalTurn.has(turn.state))
        throw new DomainError(
          409,
          "Terminal or uncertain turns cannot be replayed.",
        );
      if (
        turn.cancellationRequestedAt !== undefined &&
        ["executing", "pending_approval"].includes(state)
      )
        throw new DomainError(
          409,
          "Cancellation requested; report the actual completed, canceled or uncertain outcome.",
        );
      if (
        ["executing", "pending_approval", "completed"].includes(state) &&
        this.turns(requestId).some(
          (t) => t.sequence < turn.sequence && !terminalTurn.has(t.state),
        )
      )
        throw new DomainError(
          409,
          "Reconcile earlier turns before beginning this turn.",
        );
      const result = display.record(this.saveTurn(turn, state), prepared);
      timelineFor(this.service).record(
        requestId,
        state === "pending_approval"
          ? "approval_reported"
          : terminalTurn.has(state)
            ? "outcome_reported"
            : "execution_reported",
        turn.correlationId ?? turn.id,
      );
      return { ...result, activity: display.projection(requestId) };
    });
  }
  cancel(raw: string, requestId: string, turnId: string) {
    this.owned(raw, requestId);
    return this.service.store.transaction(() => {
      const turn = this.turn(requestId, turnId);
      if (
        terminalTurn.has(turn.state) ||
        turn.cancellationRequestedAt !== undefined
      )
        return turn;
      const next = { ...turn, cancellationRequestedAt: this.service.clock() };
      // A running native tool cannot be canceled by claiming it did not happen.
      return this.saveTurn(
        next,
        turn.state === "executing" ? "executing" : "canceled",
      );
    });
  }
  async reply(
    raw: string,
    requestId: string,
    input: {
      turnId: string;
      replyId: string;
      text: string;
      expectedCursor?: number;
    },
  ) {
    const { request, session } = this.owned(raw, requestId);
    const value = z
      .object({
        turnId: identity,
        replyId: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9_-]+$/),
        text: z.string().trim().min(1).max(900),
        expectedCursor: z.number().int().nonnegative().safe().optional(),
      })
      .strict()
      .parse(input);
    const turn = this.turn(requestId, value.turnId);
    if (turn.delivery !== "acknowledged")
      throw new DomainError(409, "Acknowledge turn delivery before replying.");
    const replyId = `${requestId}:reply:${value.replyId}`,
      fingerprint = hash(JSON.stringify(value));
    const previous = this.service.store.get<ConversationReply>(
      "conversation_reply",
      replyId,
    );
    if (previous && previous.fingerprint !== fingerprint)
      throw new DomainError(409, "Reply identity changed.");
    if (
      this.service.store
        .all<ConversationReply>("conversation_reply")
        .some((r) => r.turnId === turn.id && r.id !== replyId)
    )
      throw new DomainError(
        409,
        "This turn already has a reply; reconcile its original identity.",
        "reply_exists",
      );
    if (
      previous &&
      (finalSpeech.has(previous.state) || this.speaking.has(replyId))
    )
      return previous;
    if (!previous) {
      this.open(session, request);
      // Check synchronously before reserving a speech receipt. A refusal has no
      // speech effect; an existing receipt must always remain reconcilable.
      const turns = this.turns(requestId);
      if (
        (value.expectedCursor ?? turn.sequence) !==
          (turns.at(-1)?.sequence ?? 0) ||
        turns.some((t) => t.delivery !== "acknowledged")
      )
        throw new DomainError(
          409,
          "Newer conversation context must be read and acknowledged before replying.",
          "reply_context_stale",
        );
      if (turn.state === "canceled")
        throw new DomainError(409, "Canceled turns cannot dispatch speech.");
      const call = this.service.store.get<CallSession>(
        "call",
        request.callId ?? "",
      );
      if (
        !call ||
        call.requestId !== request.id ||
        call.pairingId !== request.pairingId ||
        call.state !== "connected" ||
        !call.remoteParticipantQualified
      )
        throw new DomainError(
          409,
          "A qualified connected call is required for speech.",
        );
    }
    if (!this.service.transport.speak)
      throw new DomainError(
        409,
        "This transport cannot publish spoken replies.",
      );
    const claim = this.service.store.transaction(() => {
      const retained = this.service.store.get<ConversationReply>(
        "conversation_reply",
        replyId,
      );
      if (retained && retained.fingerprint !== fingerprint)
        throw new DomainError(409, "Reply identity changed.");
      if (
        this.service.store
          .all<ConversationReply>("conversation_reply")
          .some((r) => r.turnId === turn.id && r.id !== replyId)
      )
        throw new DomainError(
          409,
          "This turn already has a reply; reconcile its original identity.",
          "reply_exists",
        );
      const record: ConversationReply = retained ?? {
        id: replyId,
        requestId,
        sessionId: session.id,
        turnId: turn.id,
        fingerprint,
        state: "dispatching",
        createdAt: this.service.clock(),
      };
      if (!retained) this.service.store.put("conversation_reply", record);
      return { record, lookup: !!retained };
    });
    const { record } = claim;
    if (finalSpeech.has(record.state)) return record;
    this.speaking.add(replyId);
    try {
      const result = await this.service.transport.speak(
        request,
        this.service.pairing(request.pairingId),
        replyId,
        value.text,
        claim.lookup,
      );
      const state = z
        .enum([
          "accepted",
          "playing",
          "completed",
          "cancelled",
          "failed",
          "unknown",
        ])
        .parse(result.state);
      if (["accepted", "playing", "completed"].includes(state))
        timelineFor(this.service).record(
          requestId,
          "reply_accepted",
          hash(`${request.callId}:${replyId}`).slice(0, 24),
        );
      return this.service.store.put<ConversationReply>("conversation_reply", {
        ...record,
        state,
      });
    } catch {
      return this.service.store.put<ConversationReply>("conversation_reply", {
        ...record,
        state: "unknown",
      });
    } finally {
      this.speaking.delete(replyId);
    }
  }
  end(raw: string, requestId: string) {
    this.owned(raw, requestId);
    const request = this.service.endConversation(raw, requestId);
    timelineFor(this.service).record(requestId, "end_requested", requestId);
    this.prune();
    return {
      request,
      ended: true,
      cleanupPending: this.service.store
        .all<CallSession>("call")
        .some((c) => c.requestId === requestId && c.state !== "ended"),
    };
  }
}
