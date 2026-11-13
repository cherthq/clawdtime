import type {
  AgentSession,
  AttentionRequest,
  EffectReceipt,
} from "../contracts.js";
import type { ClawdTime } from "./service.js";
import type { ConversationTurn } from "./conversation.js";
import { DomainError, hash } from "../storage/security.js";
import { timelineFor } from "../transport/conversation-timeline.js";

type Stage =
  "accepted" | "acknowledged" | "pending_approval" | "outcome" | "reply";
const rank: Record<Stage, number> = {
  accepted: 0,
  acknowledged: 1,
  pending_approval: 2,
  outcome: 3,
  reply: 4,
};
const ttl = 10 * 60_000;

export function messagesEnabled(session: AgentSession) {
  return (
    session.protocolVersion === 2 &&
    session.interaction?.version === 1 &&
    session.interaction.commandChannel === "imessage_first"
  );
}

/** Stable, recipient-bound updates use the existing durable effects dispatcher. */
export function queueMessageUpdate(
  service: ClawdTime,
  request: AttentionRequest,
  turn: ConversationTurn,
  stage: Stage,
  text?: string,
  replyId?: string,
) {
  const session = service.store.get<AgentSession>("session", request.sessionId);
  if (
    !session ||
    !messagesEnabled(session) ||
    (stage !== "reply" && !session.interaction?.messageUpdates) ||
    (turn.channel !== "text" && stage !== "reply")
  )
    return;
  const effectId = `${request.id}:text:${turn.id}:${stage}`;
  const existing = service.store.effect(effectId);
  if (existing) return existing;
  const prefix = `Instruction ${turn.sequence}: `;
  const content =
    text ??
    prefix +
      (
        {
          accepted: "accepted by ClawdTime; waiting for your agent.",
          acknowledged: "received by your agent.",
          pending_approval:
            "waiting for approval in the original coding session. This message does not approve it.",
          outcome:
            turn.state === "completed"
              ? "the agent reports completion. Ask for details if needed."
              : turn.state === "canceled"
                ? "canceled before further work; any submitted action must still be checked."
                : "the outcome is unresolved. The action will not be repeated automatically.",
          reply: "",
        } satisfies Record<Stage, string>
      )[stage];
  if (
    !content.trim() ||
    content.length > 1200 ||
    Buffer.byteLength(content) > 4800
  )
    throw new DomainError(422, "Conversation update exceeds message limits.");
  // Only coalesce effects that have definitely not been submitted. Never erase an
  // uncertain or running notice to make a newer result look successful.
  for (const effect of service.store.effects("pending")) {
    if (
      effect.payload.conversationUpdate !== 1 ||
      effect.payload.turnId !== turn.id
    )
      continue;
    const previousStage = effect.payload.stage as Stage;
    if (rank[previousStage] < rank[stage])
      service.store.putEffect({
        ...effect,
        payload: { ...effect.payload, text: undefined },
        state: "failed",
        result: { reason: "Superseded before dispatch." },
      });
    else return;
  }
  const effect = service.store.putEffect({
    id: effectId,
    kind: "message",
    state: "pending",
    createdAt: service.clock(),
    payload: {
      conversationUpdate: 1,
      requestId: request.id,
      pairingId: request.pairingId,
      sessionId: session.id,
      turnId: turn.id,
      stage,
      text: content,
      textFingerprint: hash(content),
      expiresAt: service.clock() + ttl,
      ...(replyId ? { replyId } : {}),
      ...(stage === "reply"
        ? {
            expectedCursor: service.store
              .all<ConversationTurn>("conversation_turn")
              .filter((item) => item.requestId === request.id)
              .reduce((cursor, item) => Math.max(cursor, item.sequence), 0),
          }
        : {}),
    },
  });
  timelineFor(service).record(request.id, "message_queued", effectId);
  return effect;
}

/** Raised only before a message provider submission is attempted. */
export class MessageDispatchClosed extends Error {
  constructor() {
    super("Message authorization closed before dispatch.");
  }
}

export function messageUpdateAuthorized(
  service: ClawdTime,
  effect: EffectReceipt,
) {
  if (effect.payload.conversationUpdate !== 1) return true;
  const request = service.store.get<AttentionRequest>(
    "attention",
    String(effect.payload.requestId),
  );
  const session = service.store.get<AgentSession>(
    "session",
    String(effect.payload.sessionId),
  );
  const turn = service.store.get<ConversationTurn>(
    "conversation_turn",
    String(effect.payload.turnId),
  );
  return !!(
    request &&
    session &&
    turn &&
    messagesEnabled(session) &&
    (effect.payload.stage === "reply" || session.interaction?.messageUpdates) &&
    session.state !== "stopped" &&
    service.clock() - (session.lastSeenAt ?? session.createdAt) < 20_000 &&
    (session.lastSeenAt ?? session.createdAt) <= service.clock() + 1000 &&
    request.deadline > service.clock() &&
    ![
      "canceled",
      "expired",
      "declined",
      "unanswered",
      "disconnected",
      "failed",
      "unknown",
    ].includes(request.state) &&
    request.sessionId === session.id &&
    request.pairingId === effect.payload.pairingId &&
    turn.requestId === request.id &&
    turn.sessionId === session.id &&
    typeof effect.payload.expiresAt === "number" &&
    effect.payload.expiresAt > service.clock() &&
    typeof effect.payload.text === "string" &&
    hash(effect.payload.text) === effect.payload.textFingerprint &&
    (effect.payload.stage !== "reply" ||
      effect.payload.expectedCursor ===
        service.store
          .all<ConversationTurn>("conversation_turn")
          .filter((item) => item.requestId === request.id)
          .reduce((cursor, item) => Math.max(cursor, item.sequence), 0)) &&
    !service.store.state(`listening-stopped:${request.id}`)
  );
}

export function redactMessageEffect(effect: EffectReceipt): EffectReceipt {
  return effect.payload.conversationUpdate === 1
    ? { ...effect, payload: { ...effect.payload, text: undefined } }
    : effect;
}

export function pruneMessageEffects(service: ClawdTime) {
  for (const effect of service.store.effects()) {
    if (
      effect.payload.conversationUpdate !== 1 ||
      effect.payload.text === undefined
    )
      continue;
    if (["done", "failed", "unknown"].includes(effect.state))
      service.store.putEffect(redactMessageEffect(effect));
    else if (
      effect.state === "pending" &&
      (typeof effect.payload.expiresAt !== "number" ||
        effect.payload.expiresAt <= service.clock())
    )
      service.store.putEffect(
        redactMessageEffect({
          ...effect,
          state: "failed",
          result: { reason: "Message expired before dispatch." },
        }),
      );
  }
}
