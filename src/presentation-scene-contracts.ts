import { z } from "zod";
import { cameraRectSchema } from "./camera-contracts.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const text = (length: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(length)
    .refine((v) => !/[\p{Cc}\p{Cs}]/u.test(v));

/** Presentation intent only. These identities never grant input or capture authority. */
export const presentationSceneWindowSchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,159}$/),
    windowId: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .refine((v) => Number(v) <= 0xffffffff),
    ownerPid: z.number().int().min(1).max(0x7fffffff),
    displayId: z.number().int().min(1).max(0xffffffff),
  })
  .strict();

export const presentationScenePlanSchema = z
  .object({
    version: z.literal(1),
    id,
    scenes: z
      .array(
        z
          .object({
            id,
            title: text(160),
            window: presentationSceneWindowSchema,
            intent: text(300),
            expectedOutcome: text(300),
            focus: z
              .object({
                rect: cameraRectSchema,
                durationMs: z.number().int().min(0).max(1500).default(450),
              })
              .strict()
              .optional(),
            annotation: z
              .object({
                kind: z.enum([
                  "pointer",
                  "arrow",
                  "rectangle",
                  "highlight",
                  "label",
                ]),
                text: text(160).optional(),
              })
              .strict()
              .refine((v) => v.kind !== "label" || !!v.text)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(
    (v) => new Set(v.scenes.map((s) => s.id)).size === v.scenes.length,
    "Scene IDs must be unique.",
  );

/** The original agent's fresh observation attestation, not proof from input submission. */
export const presentationSceneVerificationSchema = z
  .object({
    sceneId: id,
    generation: z.number().int().nonnegative().safe(),
    observedAt: z.number().finite().nonnegative(),
    window: presentationSceneWindowSchema,
    windowBounds: cameraRectSchema,
    resultVerified: z.literal(true),
    sourceFrameId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    geometryGeneration: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    contentRevision: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    leaseId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  })
  .strict();

export type PresentationScenePlan = z.infer<typeof presentationScenePlanSchema>;
/** Original agent's result attestation, before the runtime samples a source frame. */
export const presentationSceneAttestationSchema =
  presentationSceneVerificationSchema.omit({
    sourceFrameId: true,
    geometryGeneration: true,
    contentRevision: true,
    leaseId: true,
  });
export type PresentationSceneAttestation = z.infer<
  typeof presentationSceneAttestationSchema
>;
export type PresentationSceneVerification = z.infer<
  typeof presentationSceneVerificationSchema
>;
