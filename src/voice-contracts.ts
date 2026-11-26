import { z } from "zod";
import { cameraRectSchema } from "./camera-contracts.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const label = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((s) => !/[\p{Cc}\p{Cs}]/u.test(s));
export const voicePreparationSchema = z
  .object({
    version: z.literal(1),
    context: z.string().trim().max(2000),
    geometryGeneration: id.optional(),
    contentRevision: id.optional(),
    targets: z
      .array(
        z
          .object({
            id,
            label,
            rect: cameraRectSchema,
            annotation: z
              .object({
                kind: z.enum([
                  "pointer",
                  "arrow",
                  "rectangle",
                  "highlight",
                  "label",
                ]),
                text: label.optional(),
              })
              .strict()
              .refine((a) => a.kind !== "label" || !!a.text)
              .optional(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict()
  .refine(
    (v) => !v.targets.length || (!!v.geometryGeneration && !!v.contentRevision),
  )
  .refine((v) => new Set(v.targets.map((t) => t.id)).size === v.targets.length);
export const voicePreparedReceiptSchema = z
  .object({
    version: z.literal(1),
    prepared: z.literal(true),
    expiresAt: z.number().finite(),
    targetIds: z.array(id).max(12),
  })
  .strict();
export const voiceEventSchema = z
  .object({ eventId: id, callId: id, qualifiedRemoteAudio: z.literal(true) })
  .strict();
export const voiceCameraSchema = voiceEventSchema
  .extend({
    action: z.enum(["focus", "overview", "annotate", "clear", "stop"]),
    targetId: id.optional(),
  })
  .strict()
  .refine((v) => !["focus", "annotate"].includes(v.action) || !!v.targetId);
export type VoicePreparation = z.infer<typeof voicePreparationSchema>;
