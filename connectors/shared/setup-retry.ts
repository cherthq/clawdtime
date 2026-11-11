import type { AgentSession, SetupTest } from "../../src/contracts.js";

export function requireRetryPredecessor(
  test: SetupTest | null | undefined,
  previousTestId: string,
  sessionId: string,
  pairingId: string,
) {
  if (
    !test ||
    test.id !== previousTestId ||
    test.sessionId !== sessionId ||
    test.pairingId !== pairingId
  )
    throw new Error(
      "Retry requires the exact current setup test owned by this session; read status first.",
    );
  if (
    test.state !== "expired" ||
    test.approvedAt !== undefined ||
    test.approvalEventId !== undefined ||
    test.requestId !== undefined
  )
    throw new Error(
      "Only an expired, never-approved invitation with no call request is eligible. Preserve the original outcome.",
    );
}
export function validateRetryResult(
  value: unknown,
  previousTestId: string,
  sessionId: string,
  pairingId: string,
): { test: SetupTest } {
  const test =
    value && typeof value === "object"
      ? (value as { test?: SetupTest }).test
      : undefined;
  if (
    !test ||
    typeof test.id !== "string" ||
    !test.id ||
    test.id === previousTestId ||
    test.previousTestId !== previousTestId ||
    test.sessionId !== sessionId ||
    test.pairingId !== pairingId ||
    test.state !== "awaiting_approval" ||
    !(test.approvalMode === "native_session"
      ? test.approvalCode === undefined
      : test.approvalMode === undefined &&
        typeof test.approvalCode === "string" &&
        /^[A-F0-9]{8}$/.test(test.approvalCode)) ||
    typeof test.invitationEffectId !== "string" ||
    !test.invitationEffectId ||
    test.approvedAt !== undefined ||
    test.approvalEventId !== undefined ||
    test.requestId !== undefined ||
    !Number.isFinite(test.createdAt) ||
    !Number.isFinite(test.expiresAt) ||
    test.expiresAt <= test.createdAt
  )
    throw new Error(
      "Retry response did not prove a fresh invitation bound to this exact session and predecessor. Preserve the intent and reconcile with status; never resend.",
    );
  return { test };
}
export function requireSameLiveSession(
  session: AgentSession | undefined,
  expected: AgentSession,
  runId: string,
) {
  if (
    !session ||
    session.id !== expected.id ||
    session.pairingId !== expected.pairingId ||
    session.externalSessionId !== runId ||
    session.projectRoot !== expected.projectRoot ||
    session.adapter !== expected.adapter ||
    session.adapterVersion !== expected.adapterVersion ||
    session.hostId !== expected.hostId ||
    session.createdAt !== expected.createdAt ||
    JSON.stringify(session.capabilities) !==
      JSON.stringify(expected.capabilities) ||
    session.state === "stopped" ||
    !session.lastSeenAt ||
    Date.now() - session.lastSeenAt > 20_000 ||
    session.lastSeenAt > Date.now() + 5000
  )
    throw new Error(
      "The original bridge session is missing, stale, stopped or differently bound. No new session was registered.",
    );
}
