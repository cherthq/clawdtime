import { z } from "zod";
import { cameraRectSchema } from "./camera-contracts.js";
import {
  nativePresentationWindowSchema,
  nativePresentationObservationSchema,
} from "./native-presentation-contracts.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const seq = z.number().int().nonnegative().safe();
export const livePresentationIntentSchema = z
  .object({
    commandId: id,
    planId: id,
    sceneId: id,
    generation: seq,
    window: nativePresentationWindowSchema,
    focus: z
      .object({
        rect: cameraRectSchema,
        durationMs: z.number().int().min(0).max(1500).default(450),
      })
      .strict(),
    annotation: z
      .object({
        kind: z.enum(["pointer", "arrow", "rectangle", "highlight", "label"]),
        text: z
          .string()
          .trim()
          .min(1)
          .max(160)
          .refine((v) => !/[\p{Cc}\p{Cs}]/u.test(v))
          .optional(),
      })
      .strict()
      .refine((v) => v.kind !== "label" || !!v.text)
      .optional(),
  })
  .strict();
export const livePresentationAuthoritySchema = z
  .object({
    requestId: id,
    sessionId: id,
    leaseId: id,
    epoch: seq,
    cursor: seq,
    policyRevision: z.number().int().positive().safe(),
    displayId: z.number().int().positive().max(0xffffffff),
  })
  .strict();
export const livePresentationSchema = livePresentationIntentSchema
  .extend({
    version: z.literal(1),
    processIdentity: id,
    expected: livePresentationAuthoritySchema,
  })
  .strict()
  .refine((v) => v.window.displayId === v.expected.displayId);
export const livePresentationResultSchema = z
  .object({
    version: z.literal(1),
    commandId: id,
    state: z.enum(["accepted", "rejected", "uncertain"]),
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    receiptId: id,
    observation: nativePresentationObservationSchema.optional(),
    camera: z
      .object({
        revision: seq,
        sourceFrameId: id,
        geometryGeneration: id,
        contentRevision: id,
        capturedAt: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.state !== "accepted" || (!!v.observation && !!v.camera));
export type LivePresentationIntent = z.infer<
  typeof livePresentationIntentSchema
>;
export const livePresentationStatusSchema = z
  .object({
    version: z.literal(1),
    available: z.literal(true),
    requestId: id,
    generation: seq,
    planId: id.nullable(),
    sceneId: id.nullable(),
    unresolvedCommandId: id.nullable(),
  })
  .strict();
export type LivePresentation = z.infer<typeof livePresentationSchema>;
export type LivePresentationResult = z.infer<
  typeof livePresentationResultSchema
>;
