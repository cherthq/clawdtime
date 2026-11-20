import { z } from "zod";

/** Adapter evidence establishes that this attempt posted no native input. */
export class CuaInputNotDispatched extends Error {
  constructor() {
    super("The computer action was refused before input was dispatched.");
  }
}

/**
 * The runtime cannot start until the person does one setup step. The advice is
 * a fixed sentence from this code, never text from a tool, a page or a model,
 * so it is safe to show.
 */
export class CuaSetupRequired extends Error {
  constructor(readonly advice: string) {
    super("The computer runtime needs a setup step first.");
  }
}

export const cuaActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("activate"),
      targetId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("type"),
      text: z
        .string()
        .min(1)
        .max(512)
        .refine((s) => !/[\x00-\x1f\x7f]/.test(s)),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      deltaY: z
        .number()
        .int()
        .min(-500)
        .max(500)
        .refine((n) => n !== 0),
    })
    .strict(),
]);
export type CuaAction = z.infer<typeof cuaActionSchema>;
export interface CuaObservation {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  /** In-memory only; never included in durable records or log output. */
  imageDataUrl: string;
  /** Hash of pixels + current target identity; excludes volatile capture ID/time. */
  fingerprint: string;
  context: string;
}
export const cuaPlanSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("action"),
      observationId: z.string().min(1),
      action: cuaActionSchema,
      description: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("done"),
      observationId: z.string().min(1),
      summary: z.string().min(1).max(1600),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pause"),
      observationId: z.string().min(1),
      reason: z.string().min(1).max(600),
    })
    .strict(),
]);
export type CuaPlan = z.infer<typeof cuaPlanSchema>;
export interface CuaPlanner {
  plan(
    input: {
      goal: string;
      observation: CuaObservation;
      previousActions: CuaAction[];
    },
    signal: AbortSignal,
  ): Promise<CuaPlan>;
  verify(
    input: {
      goal: string;
      observation: CuaObservation;
      proposedSummary: string;
    },
    signal: AbortSignal,
  ): Promise<{ verified: boolean; summary: string }>;
}
export interface CuaDevice {
  /** A new, app-owned surface or explicitly authorized helper lease. No chat dependency. */
  open(
    task: { taskId: string; sessionId: string; expiresAt: number },
    signal: AbortSignal,
  ): Promise<void>;
  observe(signal: AbortSignal): Promise<CuaObservation>;
  /** Optional native target proof when whole-screen pixels changed; never grants input permission. */
  revalidate?(
    action: CuaAction,
    planned: CuaObservation,
    current: CuaObservation,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Recheck target identity/freshness at the final dispatch boundary. No automatic retries. */
  execute(
    input: { actionId: string; observationId: string; action: CuaAction },
    signal: AbortSignal,
  ): Promise<void>;
  /** 'allowed' only for exact fixture effects from trusted configuration, never model risk labels. */
  authorize(
    action: CuaAction,
    observation: CuaObservation,
  ): Promise<"allowed" | "confirm" | "refused">;
  /** Stops capture/input and releases ownership only after known quiescence; reject on unknown cleanup. */
  stop(): Promise<void>;
}
export const bundledCuaConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["browser", "native"]),
    model: z.string().min(1).max(120),
    reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
    maxSteps: z.number().int().min(1).max(30).default(20),
    timeoutMs: z.number().int().min(10000).max(900000).default(300000),
    browser: z
      .object({
        startUrl: z.string().url(),
        allowedOrigins: z.array(z.string().url()).min(1).max(10),
        headless: z.boolean().default(false),
        /** Exact disposable fixture permissions; must be loopback and explicitly configured. */
        fixtureGrants: z
          .array(
            z
              .object({
                testId: z.string().min(1).max(100),
                type: z.enum(["click", "type", "scroll"]),
                text: z.string().max(512).optional(),
              })
              .strict(),
          )
          .max(20)
          .default([]),
      })
      .strict()
      .optional(),
    native: z
      .object({
        origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]+$/),
        token: z.string().min(32),
        deviceId: z.string().min(1),
        executorId: z.string().min(1),
        displayId: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.mode === "browser") !== !!value.browser ||
      (value.mode === "native") !== !!value.native
    )
      ctx.addIssue({
        code: "custom",
        message: "Configure exactly the selected runtime adapter.",
      });
  });
export type BundledCuaConfig = z.infer<typeof bundledCuaConfigSchema>;
