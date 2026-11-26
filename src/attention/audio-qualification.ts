import { z } from "zod";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  Pairing,
} from "../contracts.js";
import { DomainError } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { hasUnresolvedNativeDevice } from "../storage/native-reservations.js";

export const audioQualificationSchema = z
  .object({
    version: z.literal(1),
    executionDisabled: z.literal(true),
    expiresAt: z.number().finite().positive(),
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
]);
/** A marker of any shape is execution-disabled; malformed historical data fails closed. */
export function isAudioQualification(
  value: { audioQualification?: unknown } | undefined,
) {
  return value?.audioQualification !== undefined;
}
export function activeAudioQualification(store: Store, pairing: Pairing) {
  const pairings = store.all<Pairing>("pairing");
  const scoped = (pairingId: string) => {
    const owner = pairings.find((item) => item.id === pairingId);
    return (
      pairingId === pairing.id ||
      owner?.lineId === pairing.lineId ||
      owner?.deviceId === pairing.deviceId
    );
  };
  const sessions = store.all<AgentSession>("session"),
    calls = store.all<CallSession>("call");
  return (
    store
      .all<AttentionRequest>("attention")
      .find(
        (request) =>
          isAudioQualification(request) &&
          scoped(request.pairingId) &&
          (!terminal.has(request.state) ||
            calls.some(
              (call) => call.requestId === request.id && call.state !== "ended",
            )),
      ) ??
    sessions.find(
      (session) =>
        isAudioQualification(session) &&
        scoped(session.pairingId) &&
        session.state !== "stopped",
    ) ??
    calls.find(
      (call) =>
        isAudioQualification(call) &&
        scoped(call.pairingId) &&
        call.state !== "ended",
    )
  );
}

/** No qualification can conceal competing or uncertain work on the line/device. */
export function assertAudioQualificationIdle(
  store: Store,
  pairing: Pairing,
  now: number,
) {
  const pairings = store.all<Pairing>("pairing");
  const pairingIds = new Set(
    pairings
      .filter(
        (item) =>
          item.id === pairing.id ||
          item.lineId === pairing.lineId ||
          item.deviceId === pairing.deviceId,
      )
      .map((item) => item.id),
  );
  const sessions = store
    .all<AgentSession>("session")
    .filter((session) => pairingIds.has(session.pairingId));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const requests = store
    .all<AttentionRequest>("attention")
    .filter((request) => pairingIds.has(request.pairingId));
  const requestIds = new Set(requests.map((request) => request.id));
  const scoped = (record: Record<string, unknown>) => {
    if (typeof record.pairingId === "string")
      return pairingIds.has(record.pairingId);
    if (typeof record.sessionId === "string")
      return sessionIds.has(record.sessionId);
    if (typeof record.requestId === "string")
      return requestIds.has(record.requestId);
    if (typeof record.deviceId === "string")
      return record.deviceId === pairing.deviceId;
    // An orphan unresolved record has no proven unrelated owner.
    return true;
  };
  const blocked = (message: string) => {
    throw new DomainError(409, message);
  };
  if (hasUnresolvedNativeDevice(store, pairing.deviceId, now))
    blocked("Unresolved native input reserves this device.");
  if (sessions.some((session) => session.state !== "stopped"))
    blocked("An existing session must stop before audio qualification.");
  if (requests.some((request) => !terminal.has(request.state)))
    blocked("An attention request still reserves audio qualification scope.");
  if (
    store
      .all<CallSession>("call")
      .some((call) => pairingIds.has(call.pairingId) && call.state !== "ended")
  )
    blocked("An existing or uncertain call reserves this line.");
  if (
    store
      .all<Record<string, unknown>>("media")
      .some((item) => scoped(item) && item.state !== "closed")
  )
    blocked("Media cleanup is not confirmed.");
  if (
    store
      .effects()
      .some(
        (effect) =>
          scoped(effect.payload) &&
          ["pending", "running", "unknown"].includes(effect.state),
      )
  )
    blocked(
      "Pending or uncertain transport effects block audio qualification.",
    );
  if (
    store.all<Record<string, unknown>>("notice").some((notice) => {
      const owner = notice.pairing as Pairing | undefined;
      return (
        (!owner || pairingIds.has(owner.id)) &&
        ["pending", "running", "unknown"].includes(String(notice.state))
      );
    })
  )
    blocked("Pending or uncertain notices block audio qualification.");
  if (
    store
      .all<Record<string, unknown>>("setup_test")
      .some(
        (test) =>
          scoped(test) &&
          ["awaiting_approval", "approved", "call_requested"].includes(
            String(test.state),
          ),
      )
  )
    blocked("An existing setup reservation blocks audio qualification.");
  const unresolved: Record<string, string[]> = {
    document_root_grant: ["active"],
    attachment_dispatch: ["awaiting_bytes", "staging", "sending", "unknown"],
    conversation_job: [
      "queued",
      "running",
      "waiting_clarification",
      "waiting_approval",
      "cancel_requested",
      "unknown",
    ],
    job_dispatch: ["pending", "dispatching", "accepted", "unknown"],
    conversation_turn: [
      "received",
      "executing",
      "pending_approval",
      "uncertain",
    ],
    conversation_reply: ["dispatching", "accepted", "playing", "unknown"],
    lease: ["active", "unknown", "revoked"],
    action: ["pending", "running", "submitted", "unknown"],
    desktop_ownership: ["working", "unknown"],
    desktop_action: ["pending", "submitted", "unknown"],
  };
  for (const [kind, states] of Object.entries(unresolved))
    if (
      store
        .all<Record<string, unknown>>(kind)
        .some((item) => scoped(item) && states.includes(String(item.state)))
    )
      blocked(`Unresolved ${kind} blocks audio qualification.`);
  if (
    store
      .all<Record<string, unknown>>("execution")
      .some(
        (item) =>
          scoped(item) &&
          (item.executor !== "none" ||
            ["working", "pending_approval", "uncertain", "paused"].includes(
              String(item.state),
            )),
      )
  )
    blocked("Execution ownership blocks audio qualification.");
  if (
    store
      .all<Record<string, unknown>>("text_control_grant")
      .some((item) => scoped(item) && item.state === "active")
  )
    blocked("An active local control grant blocks audio qualification.");
  if (
    store
      .all<Record<string, unknown>>("remote_result_receipt")
      .some((item) => scoped(item) && item.reconciliationRequired === true)
  )
    blocked("A remote result still requires reconciliation.");
  void now;
}
