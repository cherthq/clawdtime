import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
export const phonePresentationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sharing"),
      action: z.enum(["show", "hide"]),
      applied: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("zoom"),
      // zoom: the caller moved the video onto a part of the screen.
      action: z.enum(["overview", "enable", "disable", "resume", "zoom"]),
      applied: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("shape"),
      action: z.enum(["wide", "upright"]),
      applied: z.boolean(),
    })
    .strict(),
]);
export type PhonePresentation = z.infer<typeof phonePresentationSchema>;
export const sharedTaskBindingSchema = z
  .object({
    taskId: id,
    callId: id,
    desktopInstanceId: id,
  })
  .strict();
export type SharedTaskBinding = z.infer<typeof sharedTaskBindingSchema>;
export interface PhoneTurnContext {
  sharedTask?: SharedTaskBinding;
  phonePresentation?: PhonePresentation;
  /** Runtime authority supplied by the server; never accepted from JSON. */
  isLive?: () => boolean;
}
export const phoneCallSchema = z
  .object({ instanceId: id, callId: id })
  .strict();
export const phoneChatPayloadSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(2000)
      .refine(
        (text) =>
          text.trim().length > 0 &&
          !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),
      ),
    presentation: phonePresentationSchema.optional(),
  })
  .strict();
export const phoneChatSchema = phoneCallSchema
  .extend({
    requestId: id,
    sharedTask: sharedTaskBindingSchema.optional(),
    ...phoneChatPayloadSchema.shape,
  })
  .strict();
export const phoneResponseSchema = z
  .object({
    ok: z.boolean(),
    code: z.string().max(100).optional(),
    expiresAt: z.number().finite().optional(),
    reply: z
      .object({ text: z.string().max(20000) })
      .strict()
      .optional(),
  })
  .strict();
