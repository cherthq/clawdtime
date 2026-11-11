import { z } from "zod";
import type {
  AgentSession,
  EffectReceipt,
  Pairing,
  SetupTest,
} from "../contracts.js";
import { noticeRetirementValid } from "../control/obsolete-notice.js";
import { DomainError, hash } from "../storage/security.js";
import type { Store } from "../storage/store.js";

export const legacySetupInvitation =
  "ClawdTime is configured. Ready for one FaceTime video test showing this Mac’s selected screen? Reply YES when ready.";
const boundedId = z.string().min(1).max(200);
export const setupRetirementInput = z
  .object({
    testId: boundedId,
    effectId: boundedId,
    pairingId: boundedId,
    evidenceReference: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    acknowledgeUnknown: z.literal(true),
    receipt: z
      .object({
        origin: z.string().regex(/^text_[a-f0-9]{32}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        preparedGuid: z
          .string()
          .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
        state: z.literal("attempted"),
        found: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type SetupRetirementInput = z.infer<typeof setupRetirementInput>;
export type SetupRetirementBinding = {
  lineId: string;
  providerLineId: string;
  phone: string;
  instanceId: string;
  fingerprint: string;
};
const digest = (v: unknown) => hash(JSON.stringify(v));
const key = (id: string) => `expired-setup-invitation-retirement:${id}`;
// Heartbeats, cooperative yielding and control epochs legitimately change. Only
// the original session identity belongs in the immutable supersession proof.
const sessionIdentity = (s: AgentSession) => ({
  id: s.id,
  pairingId: s.pairingId,
  adapter: s.adapter,
  adapterVersion: s.adapterVersion,
  projectRoot: s.projectRoot,
  externalSessionId: s.externalSessionId,
  hostId: s.hostId,
  createdAt: s.createdAt,
  capabilities: s.capabilities,
});
interface Audit {
  version: 1;
  testId: string;
  effectId: string;
  pairingId: string;
  sessionId: string;
  testHash: string;
  effectHash: string;
  pairingHash: string;
  sessionIdentityHash: string;
  bindingHash: string;
  bindingFingerprint: string;
  receipt: SetupRetirementInput["receipt"];
  evidenceReference: string;
  at: number;
  cursorSnapshot: unknown;
  reason: "expired_unapproved_legacy_setup_invitation";
  deliveryOutcome: "unknown";
  replayAllowed: false;
}
function legacy(test: SetupTest, effect: EffectReceipt, now: number) {
  return (
    test.state === "expired" &&
    Number.isFinite(test.createdAt) &&
    Number.isFinite(test.expiresAt) &&
    test.createdAt < test.expiresAt &&
    test.expiresAt <= now &&
    test.approvalCode === undefined &&
    test.previousTestId === undefined &&
    test.approvedAt === undefined &&
    test.approvalEventId === undefined &&
    test.requestId === undefined &&
    test.verifiedAt === undefined &&
    effect.id === test.invitationEffectId &&
    effect.id === `${test.id}:invite` &&
    effect.kind === "message" &&
    effect.state === "unknown" &&
    effect.createdAt === test.createdAt &&
    !!effect.payload &&
    typeof effect.payload === "object" &&
    !Array.isArray(effect.payload) &&
    Object.keys(effect.payload).sort().join(",") ===
      "pairingId,setupTestId,text" &&
    effect.payload.setupTestId === test.id &&
    effect.payload.pairingId === test.pairingId &&
    effect.payload.text === legacySetupInvitation
  );
}
/** Checks an immutable exception, never reconciles delivery or permits replay. */
export function setupInvitationRetirementValid(
  store: Store,
  effect: EffectReceipt,
  now = Date.now(),
): boolean {
  const record = store.event<Audit>(key(effect.id));
  if (
    !record?.result ||
    typeof record.result !== "object" ||
    record.fingerprint !== digest(record.result)
  )
    return false;
  const a = record.result;
  if (
    !setupRetirementInput.safeParse({
      testId: a.testId,
      effectId: a.effectId,
      pairingId: a.pairingId,
      evidenceReference: a.evidenceReference,
      acknowledgeUnknown: true,
      receipt: a.receipt,
    }).success ||
    typeof a.sessionId !== "string" ||
    !a.sessionId ||
    ![
      a.testHash,
      a.effectHash,
      a.pairingHash,
      a.sessionIdentityHash,
      a.bindingHash,
    ].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) ||
    typeof a.bindingFingerprint !== "string" ||
    !a.bindingFingerprint
  )
    return false;
  const test = store.get<SetupTest>("setup_test", a.testId),
    pairing = store.get<Pairing>("pairing", a.pairingId),
    session = store.get<AgentSession>("session", a.sessionId);
  return (
    a.version === 1 &&
    a.reason === "expired_unapproved_legacy_setup_invitation" &&
    a.deliveryOutcome === "unknown" &&
    a.replayAllowed === false &&
    Number.isFinite(a.at) &&
    a.at <= now &&
    a.effectId === effect.id &&
    !!test &&
    legacy(test, effect, now) &&
    test.pairingId === a.pairingId &&
    test.sessionId === a.sessionId &&
    !!pairing &&
    !!session &&
    session.pairingId === pairing.id &&
    a.at >= test.expiresAt &&
    a.testHash === digest(test) &&
    a.effectHash === digest(effect) &&
    a.pairingHash === digest(pairing) &&
    a.sessionIdentityHash === digest(sessionIdentity(session)) &&
    a.bindingFingerprint === store.state("native-binding-fingerprint") &&
    a.receipt?.origin === `text_${hash(effect.id).slice(0, 32)}` &&
    a.receipt.state === "attempted" &&
    a.receipt.found === true
  );
}
/** Direct local check complements cached doctor evidence before replacement. */
export function setupInvitationReplacementAllowed(
  store: Store,
  effect: EffectReceipt,
  now = Date.now(),
) {
  return (
    setupInvitationRetirementValid(store, effect, now) &&
    !store
      .effects()
      .some(
        (e) =>
          e.id !== effect.id &&
          ["pending", "running", "unknown"].includes(e.state),
      ) &&
    !store
      .all<{ state: string }>("inbound")
      .some((x) => ["pending", "running", "unknown"].includes(x.state)) &&
    !store
      .all<{ id: string; state: string }>("notice")
      .some(
        (x) =>
          ["pending", "running"].includes(x.state) ||
          (x.state === "unknown" && !noticeRetirementValid(store, x, now)),
      ) &&
    !store.all<{ state: string }>("call").some((x) => x.state !== "ended") &&
    !store
      .all<{ state: string }>("lease")
      .some((x) => x.state !== "released") &&
    !store
      .all<{ state: string }>("action")
      .some((x) =>
        ["pending", "running", "submitted", "unknown"].includes(x.state),
      ) &&
    !store.all<{ state: string }>("media").some((x) => x.state !== "closed") &&
    !store
      .all<{ state: string }>("speech")
      .some((x) => !["completed", "cancelled", "failed"].includes(x.state))
  );
}
/** Operator-only, insert-only supersession of one expired legacy invitation. */
export function retireSetupInvitation(
  store: Store,
  binding: SetupRetirementBinding,
  raw: SetupRetirementInput,
  now = Date.now(),
) {
  const input = setupRetirementInput.parse(raw);
  const refuse = (): never => {
    throw new DomainError(
      409,
      "Expired setup invitation proof is incomplete; preserve unknown delivery and never replay.",
    );
  };
  return store.transaction(() => {
    const test = store.get<SetupTest>("setup_test", input.testId),
      effect = store.effect(input.effectId),
      pairing = store.get<Pairing>("pairing", input.pairingId),
      session = test
        ? store.get<AgentSession>("session", test.sessionId)
        : undefined;
    if (
      !test ||
      !effect ||
      !pairing ||
      !session ||
      !legacy(test, effect, now) ||
      test.pairingId !== pairing.id ||
      session.pairingId !== pairing.id ||
      pairing.revokedAt !== undefined ||
      !pairing.allowView ||
      pairing.lineId !== binding.lineId ||
      (pairing.conversationId !== `iMessage;-;${pairing.recipient}` &&
        pairing.conversationId !== `any;-;${pairing.recipient}`) ||
      !Number.isFinite(session.createdAt) ||
      !Number.isFinite(pairing.createdAt) ||
      session.createdAt > test.createdAt ||
      pairing.createdAt > test.createdAt ||
      binding.fingerprint !== store.state("native-binding-fingerprint") ||
      input.receipt.origin !== `text_${hash(effect.id).slice(0, 32)}` ||
      input.receipt.fingerprint !==
        hash(
          JSON.stringify([
            "chert-text-once-v1",
            binding.phone,
            pairing.recipient,
            legacySetupInvitation,
          ]).replaceAll("/", "\\/"),
        )
    )
      return refuse();
    const previous = store.event<Audit>(key(effect.id));
    if (previous) {
      if (
        !setupInvitationRetirementValid(store, effect, now) ||
        previous.result.evidenceReference !== input.evidenceReference ||
        digest(previous.result.receipt) !== digest(input.receipt) ||
        previous.result.bindingHash !== digest(binding)
      )
        return refuse();
      return {
        auditId: key(effect.id),
        testId: test.id,
        effectId: effect.id,
        deliveryOutcome: "unknown" as const,
        replayAllowed: false as const,
      };
    }
    // A never-called attempt cannot own any attention/control/media chain.
    const owned = (x: Record<string, unknown>) =>
      x.sessionId === session.id ||
      x.setupTestId === test.id ||
      x.requestId === test.id;
    if (
      store
        .all("attention")
        .some(
          (x) =>
            owned(x) ||
            x.taskId === `setup:${test.id}` ||
            x.idempotencyKey === `setup:${test.id}`,
        ) ||
      ["call", "lease", "action", "response", "speech", "media"].some((k) =>
        store.all(k).some(owned),
      ) ||
      store
        .effects()
        .some(
          (e) =>
            e.id !== effect.id &&
            ["pending", "running", "unknown"].includes(e.state),
        ) ||
      store
        .all<{ state: string }>("inbound")
        .some((x) => ["pending", "running", "unknown"].includes(x.state)) ||
      store
        .all<{ id: string; state: string }>("notice")
        .some(
          (x) =>
            ["pending", "running"].includes(x.state) ||
            (x.state === "unknown" && !noticeRetirementValid(store, x, now)),
        ) ||
      store.all<{ state: string }>("call").some((x) => x.state !== "ended") ||
      store
        .all<{ state: string }>("lease")
        .some((x) => x.state !== "released") ||
      store
        .all<{ state: string }>("action")
        .some((x) =>
          ["pending", "running", "submitted", "unknown"].includes(x.state),
        ) ||
      store.all<{ state: string }>("media").some((x) => x.state !== "closed") ||
      store
        .all<{ state: string }>("speech")
        .some((x) => !["completed", "cancelled", "failed"].includes(x.state))
    )
      return refuse();
    const cursorSnapshot = store.state<{ sequence: number; eventId: string }>(
      `messages:${pairing.lineId}`,
    );
    if (
      !cursorSnapshot ||
      !Number.isSafeInteger(cursorSnapshot.sequence) ||
      cursorSnapshot.sequence < 1 ||
      !cursorSnapshot.eventId
    )
      return refuse();
    const audit: Audit = {
      version: 1,
      testId: test.id,
      effectId: effect.id,
      pairingId: pairing.id,
      sessionId: session.id,
      testHash: digest(test),
      effectHash: digest(effect),
      pairingHash: digest(pairing),
      sessionIdentityHash: digest(sessionIdentity(session)),
      bindingHash: digest(binding),
      bindingFingerprint: binding.fingerprint,
      receipt: input.receipt,
      evidenceReference: input.evidenceReference,
      cursorSnapshot,
      at: now,
      reason: "expired_unapproved_legacy_setup_invitation",
      deliveryOutcome: "unknown",
      replayAllowed: false,
    };
    store.recordEvent(key(effect.id), digest(audit), audit);
    return {
      auditId: key(effect.id),
      testId: test.id,
      effectId: effect.id,
      deliveryOutcome: "unknown" as const,
      replayAllowed: false as const,
    };
  });
}
