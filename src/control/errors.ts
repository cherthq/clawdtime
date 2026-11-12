export type ControlPreflightCode =
  | "planning_refused"
  | "planner_unavailable"
  | "planning_timeout"
  | "frame_unavailable"
  | "screen_unavailable"
  | "screen_changed"
  | "invalid_plan"
  | "stopped"
  | "context_expired";

const messages: Record<ControlPreflightCode, string> = {
  planning_refused: "The requested screen action needs clarification.",
  planner_unavailable: "The screen action planner is unavailable.",
  planning_timeout: "Screen action planning timed out.",
  frame_unavailable: "A fresh screen frame is required.",
  screen_unavailable:
    "The screen connection was lost. Screen sharing and control are stopped.",
  screen_changed: "The screen changed while planning.",
  invalid_plan: "The proposed screen action is invalid.",
  stopped: "Screen control was stopped.",
  context_expired: "The active call or yielded agent context is unavailable.",
};

/** Only trusted local pre-dispatch code raises this. Never wrap input dispatch failures. */
export class ControlPreflightError extends Error {
  readonly diagnostics?: ControlPreflightDiagnostics;
  constructor(
    readonly code: ControlPreflightCode,
    diagnostics?: ControlPreflightDiagnostics,
  ) {
    super(messages[code]);
    this.name = "ControlPreflightError";
    this.diagnostics = sanitizeControlPreflightDiagnostics(diagnostics);
  }
}
import { z } from "zod";

export interface ScreenPreflightDiagnostics {
  phase: "settling" | "planning";
  elapsedMs: number;
  frameAgeMs: number;
  comparison?: {
    kind:
      | "identical"
      | "pixels_changed"
      | "encoding_only"
      | "geometry_changed"
      | "unavailable";
    changedPixels?: number;
    /** Unique zero-based tile indexes in a 4-column by 3-row grid. */
    changedTiles?: number[];
    width?: number;
    height?: number;
  };
}

export interface ConversationPreflightDiagnostics {
  phase: "conversation";
  elapsedMs: number;
  conversation: {
    phase: "generate" | "reply_validation";
    errorKind: "api" | "timeout" | "invalid_reply" | "other";
    statusCode?: number;
    completedSteps: number;
    finishReason?:
      "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";
    replyLength?: number;
  };
}

export interface ToolPreflightDiagnostics {
  phase: "tool_preflight";
  elapsedMs: number;
  reason:
    | "parallel_tools"
    | "operation_limit"
    | "action_invalid"
    | "action_limit"
    | "observation_missing"
    | "frame_mismatch";
}

export type ControlPreflightDiagnostics =
  | ScreenPreflightDiagnostics
  | ConversationPreflightDiagnostics
  | ToolPreflightDiagnostics;

const screenDiagnosticsSchema = z.object({
  phase: z.enum(["settling", "planning"]),
  elapsedMs: z.number().finite().min(0).max(60_000),
  frameAgeMs: z.number().finite().min(-500).max(60_000),
  comparison: z
    .object({
      kind: z.enum([
        "identical",
        "pixels_changed",
        "encoding_only",
        "geometry_changed",
        "unavailable",
      ]),
      changedPixels: z
        .number()
        .int()
        .min(0)
        .max(1280 * 720)
        .optional(),
      changedTiles: z
        .array(z.number().int().min(0).max(11))
        .max(12)
        .refine((values) => new Set(values).size === values.length)
        .optional(),
      width: z.number().int().min(1).max(1280).optional(),
      height: z.number().int().min(1).max(720).optional(),
    })
    .refine(
      (value) =>
        value.changedPixels === undefined ||
        value.width === undefined ||
        value.height === undefined ||
        value.changedPixels <= value.width * value.height,
    )
    .optional(),
});

const diagnosticsSchema = z.union([
  screenDiagnosticsSchema,
  z.object({
    phase: z.literal("tool_preflight"),
    elapsedMs: z.number().finite().min(0).max(60_000),
    reason: z.enum([
      "parallel_tools",
      "operation_limit",
      "action_invalid",
      "action_limit",
      "observation_missing",
      "frame_mismatch",
    ]),
  }),
  z.object({
    phase: z.literal("conversation"),
    elapsedMs: z.number().finite().min(0).max(60_000),
    conversation: z.object({
      phase: z.enum(["generate", "reply_validation"]),
      errorKind: z.enum(["api", "timeout", "invalid_reply", "other"]),
      statusCode: z.number().int().min(100).max(599).optional(),
      completedSteps: z.number().int().min(0).max(8),
      finishReason: z
        .enum([
          "stop",
          "length",
          "tool-calls",
          "content-filter",
          "error",
          "other",
        ])
        .optional(),
      replyLength: z.number().int().min(0).max(1_000_000).optional(),
    }),
  }),
]);

/** Copy only bounded telemetry; no arbitrary strings or nested values survive. */
export function sanitizeControlPreflightDiagnostics(
  value: unknown,
): ControlPreflightDiagnostics | undefined {
  try {
    const parsed = diagnosticsSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Malformed diagnostic getters must not change the safe failure outcome.
    return undefined;
  }
}
