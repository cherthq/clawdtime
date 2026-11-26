import { z } from "zod";
import { routingId } from "./shared-number-contracts.js";
import {
  phoneChatPayloadSchema,
  phoneResponseSchema,
} from "./phone-desktop-contracts.js";

export const sharedOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.enum([
        "open",
        "renew",
        "stop",
        "close",
        "frame",
        "hide",
        "walkthrough",
      ]),
    })
    .strict(),
  z
    .object({
      action: z.literal("chat"),
      requestId: routingId,
      ...phoneChatPayloadSchema.shape,
    })
    .strict(),
]);
export type SharedOperation = z.infer<typeof sharedOperationSchema>;
export const sharedCommandSchema = z
  .object({
    id: routingId,
    callId: routingId,
    connectionId: routingId,
    instanceId: routingId,
    deviceId: routingId,
    expiresAt: z.number().int().positive(),
    operation: sharedOperationSchema,
    walkthrough: z
      .object({ taskId: routingId, resultId: routingId })
      .strict()
      .optional(),
  })
  .strict();
export type SharedCommand = z.infer<typeof sharedCommandSchema>;
export const sharedResultSchema = phoneResponseSchema
  .extend({
    taskId: routingId.optional(),
    walkthrough: z
      .object({ text: z.string().max(20000), opened: z.boolean() })
      .strict()
      .optional(),
    frame: z
      .object({
        jpeg: z
          .string()
          .max(8_000_000)
          .regex(/^[A-Za-z0-9+/]+=*$/),
        width: z.number().int().positive().max(2400),
        height: z.number().int().positive().max(2400),
        capturedAt: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SharedResult = z.infer<typeof sharedResultSchema>;
