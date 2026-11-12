import type {
  ActionReceipt,
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  ExecutionOwnership,
  SetupTest,
  Pairing,
} from "../contracts.js";
import type { Store } from "../storage/store.js";

/** Preserve setup history; a closed v2 conversation no longer reserves its line. */
export function setupReservationBlocks(
  store: Store,
  test: SetupTest,
  live: boolean,
) {
  const open = ["awaiting_approval", "approved", "call_requested"].includes(
    test.state,
  );
  if (store.get<AgentSession>("session", test.sessionId)?.protocolVersion !== 2)
    return open;
  if (!test.requestId) {
    const invitation = store.effect(test.invitationEffectId);
    return (
      open ||
      !invitation ||
      ["pending", "running", "unknown"].includes(invitation.state)
    );
  }
  const request = store.get<AttentionRequest>("attention", test.requestId);
  if (
    !request ||
    request.sessionId !== test.sessionId ||
    request.pairingId !== test.pairingId ||
    ![
      "completed",
      "declined",
      "unanswered",
      "canceled",
      "expired",
      "disconnected",
      "failed",
    ].includes(request.state)
  )
    return true;
  const calls = store
    .all<CallSession>("call")
    .filter((c) => c.requestId === request.id);
  const media = store
    .all<{ requestId: string; providerCallId?: string; state: string }>("media")
    .filter((m) => m.requestId === request.id);
  if (
    !calls.length ||
    (request.callId && !calls.some((c) => c.id === request.callId)) ||
    calls.some(
      (c) =>
        c.state !== "ended" ||
        !Number.isFinite(c.endedAt) ||
        c.pairingId !== test.pairingId,
    ) ||
    media.some((m) => m.state !== "closed") ||
    (live &&
      calls.some(
        (c) =>
          c.providerCallId &&
          !media.some(
            (m) =>
              m.providerCallId === c.providerCallId && m.state === "closed",
          ),
      ))
  )
    return true;
  if (
    store
      .effects()
      .some(
        (e) =>
          (e.payload.requestId === request.id ||
            e.id === test.invitationEffectId) &&
          (["pending", "running", "unknown"].includes(e.state) ||
            (e.kind === "call" &&
              e.state === "done" &&
              !calls.some((c) => c.providerCallId === e.result?.callId))),
      )
  )
    return true;
  const leases = store
    .all<ControlLease>("lease")
    .filter((l) => l.requestId === request.id);
  if (
    leases.some((l) => l.state !== "released") ||
    store
      .all<ActionReceipt>("action")
      .some(
        (a) =>
          leases.some((l) => l.id === a.leaseId) &&
          ["pending", "running", "submitted", "unknown"].includes(a.state),
      )
  )
    return true;
  const execution = store.get<ExecutionOwnership>("execution", request.id);
  return (
    !!execution &&
    (execution.executor !== "none" || execution.state === "uncertain")
  );
}

/** Identical conversation scope at readiness, reservation creation and call start. */
export function blockingSetupReservation(
  store: Store,
  pairing: Pairing,
  sessionId: string | undefined,
  live: boolean,
  allowedTestId?: string,
) {
  return store.all<SetupTest>("setup_test").find((test) => {
    if (test.id === allowedTestId) return false;
    const owner = store.get<Pairing>("pairing", test.pairingId);
    return (
      test.sessionId !== sessionId &&
      owner?.lineId === pairing.lineId &&
      owner.recipient === pairing.recipient &&
      owner.conversationId === pairing.conversationId &&
      setupReservationBlocks(store, test, live)
    );
  });
}
