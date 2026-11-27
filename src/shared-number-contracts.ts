import { z } from "zod";
import type { Pairing } from "./contracts.js";

export const routingId = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const expiresAt = z.number().int().positive();

// These are OUTPUTS of trusted adapters, never request-body attestations.
export const accountIdentitySchema = z
  .object({
    memberId: routingId,
    expiresAt,
  })
  .strict();
export const verifiedAliasSchema = z
  .object({
    memberId: routingId,
    lineId: routingId,
    // The adapter supplies the exact canonical, separately verified alias.
    recipient: z.union([z.string().regex(/^\+[1-9]\d{7,14}$/), z.email()]),
    conversationId: z.string().min(1).max(320),
    expiresAt,
  })
  .strict();
const providerBinding = {
  eventId: routingId,
  lineId: routingId,
  providerCallId: routingId,
  roomId: routingId,
  participantId: routingId,
  expiresAt,
};
export const routingProviderEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("incoming"),
      ...providerBinding,
      // The provider's observed caller handle, exactly as the member verified
      // it (E.164 phone number or email). It only selects whose paired Mac may
      // be shown the call code. It never authorizes a Mac by itself.
      caller: z.string().min(1).max(320).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("cleanup_complete"), ...providerBinding })
    .strict(),
]);
export type RoutingProviderEvent = z.infer<typeof routingProviderEventSchema>;
export type AccountIdentity = z.infer<typeof accountIdentitySchema>;
export type VerifiedAlias = z.infer<typeof verifiedAliasSchema>;
export const callProofTurnSchema = z
  .object({
    lineId: routingId,
    providerCallId: routingId,
    roomId: routingId,
    participantId: routingId,
    turnId: routingId,
    code: z.string().max(32),
    expiresAt,
  })
  .strict();
export type CallProofTurn = z.infer<typeof callProofTurnSchema>;

/** No default verifier exists. Webhook signatures establish event provenance,
 * not human identity. The provider adapter must bind its room participant to
 * the exact call and distinguish cleanup completion from media disconnect. */
export interface SharedNumberVerifiers {
  account(proof: unknown): Promise<AccountIdentity>;
  alias(proof: unknown): Promise<VerifiedAlias>;
  provider(proof: unknown): Promise<RoutingProviderEvent>;
  // An original turn received from the pinned call participant. Do not accept
  // identity fields or a reconstructed transcript supplied by a model tool.
  callProofTurn(proof: unknown): Promise<CallProofTurn>;
}

/** A member's verified alias as stored: keyed digests, never the number. */
export interface SharedAlias {
  memberId: string;
  lineId: string;
  recipientDigest: string;
  conversationDigest: string;
  expiresAt: number;
}
export interface SharedMember {
  id: string;
  alias: SharedAlias;
  /** The number, sealed, kept only to dial this member's callbacks. A
   * permanent ban drops it. */
  sealedRecipient?: string;
  pairingId?: string;
  revokedAt?: number;
}
/** A shared pairing names the member's number only by its keyed digests. */
export interface SharedPairing extends Omit<
  Pairing,
  "recipient" | "conversationId"
> {
  recipientDigest: string;
  conversationDigest: string;
}
export interface SharedDeviceCredential {
  id: string;
  pairingId: string;
  memberId: string;
  deviceId: string;
  digest: string;
  createdAt: number;
  revokedAt?: number;
}
export interface SharedConnection {
  id: string;
  credentialId: string;
  memberId: string;
  pairingId: string;
  deviceId: string;
  desktopInstanceId: string;
  expiresAt: number;
}
export interface SharedCallScope {
  memberId: string;
  pairingId: string;
  deviceId: string;
  displayId: string;
  desktopInstanceId: string;
  connectionId: string;
  grantId: string;
  allowView: boolean;
  allowControl: boolean;
  // Reply destinations come from this persisted pairing snapshot only, as
  // keyed digests. A callback opens the member's sealed number to dial it.
  recipientDigest: string;
  conversationDigest: string;
}
export type SharedCallState =
  // Declined at once: no Mac could verify the caller, or the caller is over
  // its limit of unverified calls. It never holds the slot.
  | "declined"
  | "unknown_identity"
  | "unauthorized"
  | "offline"
  | "busy"
  | "admitted"
  | "ended"
  | "outcome_unknown";
export interface SharedCall {
  id: string;
  lineId: string;
  providerCallId: string;
  roomId: string;
  participantId: string;
  state: SharedCallState;
  createdAt: number;
  authorizationExpiresAt?: number;
  scope?: SharedCallScope;
  cleanupAt?: number;
  callbackTaskId?: string;
  activatedAt?: number;
  expectedMemberId?: string;
  // Keyed digest of the observed caller handle, comparable with a member's
  // recipientDigest; the handle is not stored.
  callerDigest?: string;
  // Set when an unverified call is released for the line to end it.
  releasedAt?: number;
}
export interface SharedCallProof {
  id: string;
  callId: string;
  memberId: string;
  pairing: SharedPairing;
  // The code was shown on this paired Mac, over this live device connection.
  credentialId: string;
  connectionId: string;
  digest: string;
  attempts: number;
  expiresAt: number;
  consumedAt?: number;
}
export interface SharedTaskOwnership {
  id: string;
  callId: string;
  lineId: string;
  providerCallId: string;
  scope: SharedCallScope;
  userTurnId: string;
  requestDigest: string;
  createdAt: number;
  resultId?: string;
  callbackRequested?: boolean;
}
export interface SharedCallbackOwnership {
  id: string;
  taskId: string;
  resultId: string;
  callId: string;
  lineId: string;
  scope: SharedCallScope;
  state:
    | "queued"
    | "preparing"
    | "dialing"
    | "active"
    | "unknown"
    | "ended"
    | "canceled";
  roomId?: string;
  providerCallId?: string;
  outboundCallId?: string;
  createdAt: number;
  /** Claims that ended before any dial: nothing reached the provider. */
  undialed?: number;
  /** A callback put back in the queue waits until this time. */
  notBefore?: number;
}
