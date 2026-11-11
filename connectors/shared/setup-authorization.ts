import type { SetupTest } from "../../src/contracts.js";

/** A client attestation of actual user consent, never inferred from readiness. */
export function requireSetupAuthorization(
  test: SetupTest | null | undefined,
  testId: string,
  sessionId: string,
  pairingId: string,
) {
  if (
    !test ||
    test.id !== testId ||
    test.sessionId !== sessionId ||
    test.pairingId !== pairingId ||
    test.approvalMode !== "native_session" ||
    !["awaiting_approval", "approved"].includes(test.state) ||
    test.requestId !== undefined
  )
    throw new Error(
      "Authorization requires the current unconsumed setup test in this exact session; read status first. Legacy SMS approval cannot be replaced.",
    );
}

export function validateSetupAuthorization(
  value: unknown,
  testId: string,
  sessionId: string,
  pairingId: string,
): { test: SetupTest } {
  const test =
    value && typeof value === "object"
      ? (value as { test?: SetupTest }).test
      : undefined;
  requireSetupAuthorization(test, testId, sessionId, pairingId);
  if (
    !test ||
    test.state !== "approved" ||
    test.approvalSource !== "native_session" ||
    !Number.isFinite(test.approvedAt) ||
    typeof test.approvalEventId !== "string" ||
    !test.approvalEventId ||
    !Number.isFinite(test.expiresAt) ||
    test.expiresAt <= test.approvedAt!
  )
    throw new Error(
      "Authorization response is not bound approval evidence. Preserve the intent and reconcile status; never resend.",
    );
  return { test };
}
