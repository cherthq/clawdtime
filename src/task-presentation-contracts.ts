/** Independent task presentation v1. Local view-only grants never authorize calls or input. */
import { z } from "zod";
import { createHash } from "node:crypto";
/** Sorted object keys, JSON numbers; hash only a schema-normalized manifest. */
export function taskPresentationFingerprint(
  manifest: TaskPresentationManifest,
): string {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object")
      return (
        "{" +
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
          .join(",") +
        "}"
      );
    return JSON.stringify(value);
  }
  return createHash("sha256")
    .update(canonical(taskPresentationManifestSchema.parse(manifest)))
    .digest("hex");
}

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z.number().int().nonnegative().safe();
const stamp = z.number().finite().nonnegative();
const prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
export const taskSceneTargetSchema = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,159}$/),
    windowId: z
      .string()
      .regex(/^[1-9][0-9]{0,9}$/)
      .refine((v) => Number(v) <= 0xffffffff),
    ownerPid: z.number().int().positive().max(0x7fffffff),
    processIdentity: digest,
    displayId: z.number().int().positive().max(0xffffffff),
    titleHash: digest,
  })
  .strict();
export const taskSceneFocusSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((v) => v.x + v.width <= 1 && v.y + v.height <= 1);
export const taskSceneSchema = z
  .object({
    id: identity,
    kind: z.enum(["code", "preview", "verification"]),
    title: prose(160),
    narration: prose(1600),
    expectedOutcome: prose(500),
    target: taskSceneTargetSchema,
    focus: taskSceneFocusSchema,
    transitionMs: z.number().int().min(450).max(650).default(550),
    artifact: z
      .object({
        relativePath: prose(1000).refine(
          (v) =>
            !v.startsWith("/") &&
            !/^[A-Za-z]:/.test(v) &&
            !v.split(/[\\/]/).some((p) => p === ".." || p === ""),
        ),
        sha256: digest,
      })
      .strict()
      .optional(),
  })
  .strict();
export const taskPresentationManifestSchema = z
  .object({
    version: z.literal(1),
    id: identity,
    sessionId: identity,
    taskId: identity,
    runId: identity,
    taskRevision: sequence,
    verificationId: identity,
    kind: z.enum(["decision", "review"]),
    opening: prose(2000),
    fps: z.literal(15),
    scenes: z.array(taskSceneSchema).min(1).max(12),
  })
  .strict()
  .refine((v) => new Set(v.scenes.map((s) => s.id)).size === v.scenes.length)
  .refine(
    (v) => v.scenes[0]?.narration === v.opening,
    "The first scene must speak the exact prepared task opening.",
  );
export const taskPresentationGrantSchema = z
  .object({
    version: z.literal(1),
    id: identity,
    manifestFingerprint: digest,
    sessionId: identity,
    taskId: identity,
    runId: identity,
    taskRevision: sequence,
    hostId: identity,
    authorizedAt: stamp,
    expiresAt: stamp,
    localOnly: z.literal(true),
    capture: z.literal(true),
    presentation: z.literal(true),
    control: z.literal(false),
    nativeActivation: z.literal(false),
    calls: z.literal(false),
  })
  .strict()
  .refine(
    (v) =>
      v.expiresAt > v.authorizedAt &&
      v.expiresAt - v.authorizedAt <= 15 * 60_000,
  );
/** Host-render evidence only; content correctness and physical visibility remain separate observations. */
export const taskSceneFrameSchema = z
  .object({
    presentationId: identity,
    manifestFingerprint: digest,
    operationId: identity,
    sceneId: identity,
    generation: sequence,
    target: taskSceneTargetSchema,
    sourceFrameId: identity,
    geometryGeneration: identity,
    contentRevision: digest,
    capturedAt: stamp,
    renderedAt: stamp,
    transitionCompletedAt: stamp,
    evidence: z.literal("local_frame_rendered_not_human_seen"),
  })
  .strict();
export const taskPresentationCleanupSchema = z
  .object({
    captureStopped: z.literal(true),
    narrationStopped: z.literal(true),
    outputCleared: z.literal(true),
    childrenJoined: z.literal(true),
  })
  .strict();
export type TaskSceneTarget = z.infer<typeof taskSceneTargetSchema>;
export type TaskPresentationScene = z.infer<typeof taskSceneSchema>;
export type TaskPresentationManifest = z.infer<
  typeof taskPresentationManifestSchema
>;
export type TaskPresentationGrant = z.infer<typeof taskPresentationGrantSchema>;
export type TaskSceneFrame = z.infer<typeof taskSceneFrameSchema>;
export type TaskPresentationCleanup = z.infer<
  typeof taskPresentationCleanupSchema
>;
export type TaskPresentationEffect = {
  id: string;
  action: "show_scene" | "narrate" | "stop";
  sceneId?: string;
  generation: number;
  state: "running" | "done" | "rejected" | "unknown";
  startedAt: number;
  completedAt?: number;
  frame?: TaskSceneFrame;
};
export type TaskPresentationRecord = {
  id: string;
  manifest: TaskPresentationManifest;
  fingerprint: string;
  grant: TaskPresentationGrant;
  generation: number;
  state:
    "prepared" | "presenting" | "visible" | "narrating" | "stopped" | "unknown";
  stoppedAt?: number;
  cleanup?: TaskPresentationCleanup;
  activeSceneId?: string;
  frame?: TaskSceneFrame;
  effects: TaskPresentationEffect[];
  createdAt: number;
};
export interface TaskPresentationHost {
  prepare(input: {
    presentationId: string;
    manifest: TaskPresentationManifest;
    grant: TaskPresentationGrant;
    fingerprint: string;
  }): Promise<{ ready: true }>;
  show(input: {
    presentationId: string;
    operationId: string;
    manifestFingerprint: string;
    sceneId: string;
    generation: number;
  }): Promise<TaskSceneFrame>;
  /** Fresh frame observation without replaying any scene effect. */
  observe(presentationId: string): Promise<TaskSceneFrame>;
  narrate(input: {
    presentationId: string;
    operationId: string;
    sceneId: string;
    generation: number;
    frame: TaskSceneFrame;
    text: string;
  }): Promise<{
    completed: true;
    evidence: "playback_completed_not_audibility";
  }>;
  stop(presentationId: string): Promise<TaskPresentationCleanup>;
}
