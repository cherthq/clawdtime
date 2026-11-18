import { z } from "zod";
import {
  nativePresentationOperationSchema,
  nativePresentationObservationSchema,
  nativePresentationHostResultSchema,
} from "./native-presentation-contracts.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
/** Closed vocabulary: never persist arbitrary peer errors or target content. */
export const productionNativeRejectionReasonSchema = z.enum([
  "preparation_canceled",
  "activation_not_negotiated",
  "ownership_changed",
  "incoming_speech",
  "conflicting_input",
  "peer_unavailable",
  "local_policy_changed",
  "camera_frame_stale",
  "camera_unavailable",
  "camera_authority_changed",
  "target_changed",
  "authority_expired",
  "preflight_unavailable",
]);
export type ProductionNativeRejectionReason = z.infer<
  typeof productionNativeRejectionReasonSchema
>;
/** Planning expiry and the single dispatch deadline are distinct, never renewed. */
export const productionNativeEnvelopeSchema = z
  .object({
    version: z.literal(1),
    operation: nativePresentationOperationSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    binding: z
      .object({
        mediaSessionId: id,
        pairingId: id,
        deviceId: id,
        memberId: id,
        expiresAt: z.number().finite().positive(),
      })
      .strict(),
    nativeExpiresAt: z.number().finite().positive().optional(),
    preparedObservation: nativePresentationObservationSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.nativeExpiresAt === undefined ||
      v.nativeExpiresAt <= v.binding.expiresAt,
    "Dispatch cannot extend original planning authority.",
  );
export type ProductionNativeEnvelope = z.infer<
  typeof productionNativeEnvelopeSchema
>;
export const productionNativeReferenceSchema = z
  .object({
    operationId: id,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const productionNativeRecordSchema = z
  .object({
    id,
    envelope: productionNativeEnvelopeSchema,
    phase: z.enum([
      "prepared",
      "dispatching",
      "submitted",
      "returned",
      "verified",
      "rejected",
      "uncertain",
    ]),
    result: nativePresentationHostResultSchema.optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict();
export type ProductionNativeRecord = z.infer<
  typeof productionNativeRecordSchema
>;
