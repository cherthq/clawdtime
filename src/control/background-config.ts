import { z } from "zod";
import { cuaDriverProbeConfigSchema } from "../../connectors/agents/cua-driver-probe.js";
import { bundledCuaConfigSchema } from "./cua-contracts.js";

const qualifiedApp = z
  .object({
    bundleId: z.string().min(1),
    executablePath: z.string().startsWith("/"),
    bundleVersion: z.string().min(1),
    destination: z.string().min(1).max(128),
  })
  .strict();
/** Protected operator configuration; no model output can modify qualifications. */
export const backgroundConfigSchema = z
  .object({
    version: z.literal(1),
    backend: z.literal("cua-driver-background"),
    driver: cuaDriverProbeConfigSchema,
    native: z
      .object({
        origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]+$/),
        token: z.string().min(32).max(256),
        deviceId: z.string().min(1),
        executorId: z.string().min(1),
        displayId: z.number().int().positive(),
      })
      .strict(),
    model: z.string().min(1),
    reasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
    messages: qualifiedApp.extend({
      bundleId: z.literal("com.apple.MobileSMS"),
    }),
    codex: qualifiedApp.extend({ bundleId: z.literal("com.openai.codex") }),
    overlayQualification: z
      .object({
        driverVersion: z.literal("0.55.0"),
        artifactSha256: z.literal(
          "faf11948f8f9b410a76750e65ae14cb1d95cc321aa61fc158f70de8a68c270b1",
        ),
        driverGeneration: z.string().min(1),
        osBuild: z.string().min(1).max(128),
        capturePipeline: z.literal("get_window_state/jpeg/display_only"),
        qualificationId: z.string().min(1).max(128),
        result: z.literal("excluded"),
        qualifiedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().positive(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(10000).max(300000).default(120000),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Reuse the native credential validation without altering native execution.
    const valid = bundledCuaConfigSchema.safeParse({
      version: 1,
      mode: "native",
      model: v.model,
      native: v.native,
    });
    if (!valid.success)
      ctx.addIssue({ code: "custom", message: "Invalid helper configuration" });
  });
export type BackgroundConfig = z.infer<typeof backgroundConfigSchema>;
