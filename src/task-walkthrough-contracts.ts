/** Explicit handset export authority. A local presentation grant alone cannot export. */
import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  TaskAudioAuthorization,
  TaskAudioPlan,
} from "./transport/task-audio.js";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const taskWalkthroughPresentationBindingSchema = z
  .object({
    presentationId: identity,
    manifestFingerprint: digest,
    presentationGrantId: identity,
    verificationId: identity,
    hostId: identity,
    captureDeviceId: identity,
  })
  .strict();

export const taskWalkthroughPlanSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("handset_walkthrough"),
    id: identity,
    taskSessionId: identity,
    taskId: identity,
    runId: identity,
    revision: z.number().int().nonnegative().safe(),
    voiceSessionId: identity,
    pairingId: identity,
    memberId: identity,
    deviceId: identity,
    lineId: z.string().uuid(),
    recipientHash: digest,
    mediaSessionId: identity,
    workerIdentity: identity,
    agentIdentity: identity,
    exportGrantId: identity,
    callKind: z.enum(["decision", "review"]),
    presentationBinding: taskWalkthroughPresentationBindingSchema,
    dispatchExpiresAt: stamp,
    expiresAt: stamp,
    audio: z.literal(true),
    video: z.literal(true),
    screen: z.literal(true),
    presentation: z.literal(true),
    instructions: z.literal(true),
    control: z.literal(false),
    nativeActivation: z.literal(false),
    maxCalls: z.literal(1),
  })
  .strict()
  .refine(
    (p) =>
      p.workerIdentity !== p.agentIdentity &&
      p.dispatchExpiresAt <= p.expiresAt &&
      p.presentationBinding.captureDeviceId === p.deviceId,
    "Walkthrough participant, lifetime or capture-device binding conflicts.",
  );
export type TaskWalkthroughPlan = z.infer<typeof taskWalkthroughPlanSchema>;

export function taskWalkthroughFingerprint(plan: TaskWalkthroughPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(taskWalkthroughPlanSchema.parse(plan)))
    .digest("hex");
}

export const taskWalkthroughAuthorizationSchema = z
  .object({
    id: identity,
    planFingerprint: digest,
    authorizedAt: stamp,
    /** Deadline to dispatch/activate, never an automatic renewal. */
    expiresAt: stamp,
    /** Separately authorized maximum conversation lifetime. */
    callExpiresAt: stamp,
    oneCallAuthorized: z.literal(true),
  })
  .strict()
  .refine(
    (a) =>
      a.authorizedAt < a.expiresAt &&
      a.expiresAt <= a.authorizedAt + 300_000 &&
      a.expiresAt <= a.callExpiresAt &&
      a.callExpiresAt <= a.authorizedAt + 1_800_000,
    "Walkthrough dispatch and conversation lifetimes must be explicitly bounded.",
  );
export type TaskWalkthroughAuthorization = z.infer<
  typeof taskWalkthroughAuthorizationSchema
>;

export const taskWalkthroughExportGrantSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("handset_walkthrough"),
    id: identity,
    planFingerprint: digest,
    authorizationId: identity,
    sourcePairingId: identity,
    projectRoot: z.string().min(1).max(4096),
    authorizedAt: stamp,
    dispatchExpiresAt: stamp,
    expiresAt: stamp,
    exportPreparedWindows: z.literal(true),
    instructions: z.literal(true),
    control: z.literal(false),
    nativeActivation: z.literal(false),
    maxCalls: z.literal(1),
  })
  .strict()
  .refine(
    (g) =>
      g.authorizedAt < g.dispatchExpiresAt &&
      g.dispatchExpiresAt <= g.authorizedAt + 300_000 &&
      g.dispatchExpiresAt <= g.expiresAt &&
      g.expiresAt <= g.authorizedAt + 1_800_000,
    "Export authority must have bounded dispatch and conversation lifetimes.",
  );
export type TaskWalkthroughExportGrant = z.infer<
  typeof taskWalkthroughExportGrantSchema
>;

/** Operator-only voice admission; an instruction still needs a connected receipt. */
export const taskWalkthroughVoiceBindingSchema = z
  .object({
    mode: z.literal("handset_walkthrough"),
    callAttemptId: identity,
    exportGrantId: identity,
    presentationId: identity,
    manifestFingerprint: digest,
  })
  .strict();
export type TaskWalkthroughVoiceBinding = z.infer<
  typeof taskWalkthroughVoiceBindingSchema
>;
export type TaskHandsetPlan = TaskAudioPlan | TaskWalkthroughPlan;
export type TaskHandsetAuthorization =
  TaskAudioAuthorization | TaskWalkthroughAuthorization;
export function isTaskWalkthroughPlan(
  plan: TaskHandsetPlan,
): plan is TaskWalkthroughPlan {
  return "mode" in plan && plan.mode === "handset_walkthrough";
}
