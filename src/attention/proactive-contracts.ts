import { z } from "zod";

const identity = z.string().min(1).max(300);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceBase = {
  sessionId: identity,
  runId: identity,
  decisionId: identity.optional(),
};
export const callSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...sourceBase,
      kind: z.literal("decision"),
      decisionId: identity,
    })
    .strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("job"),
      jobId: identity,
      launchId: identity,
      resultDigest: digest.optional(),
      verificationId: identity.optional(),
    })
    .strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("session"),
      enrollmentId: identity,
      terminalEventId: identity.optional(),
      resultDigest: digest.optional(),
    })
    .strict(),
  z
    .object({
      ...sourceBase,
      kind: z.literal("task"),
      taskId: identity,
      revision: z.number().int().nonnegative(),
      verificationId: identity,
    })
    .strict(),
]);
export type CallSource = z.infer<typeof callSourceSchema>;
export const callScopeSchema = z
  .object({
    personId: identity,
    deviceId: identity,
    projectRoot: z.string().min(1).max(2000),
    sessionId: identity,
    taskId: identity.optional(),
  })
  .strict();
export type CallScope = z.infer<typeof callScopeSchema>;
export const callChannelSchema = z.enum(["phone_alert", "phone_walkthrough"]);
export type CallChannel = z.infer<typeof callChannelSchema>;
export const callTriggerSchema = z.enum([
  "decision",
  "waiting",
  "failure",
  "completion",
  "review",
]);
export type CallTrigger = z.infer<typeof callTriggerSchema>;
export type ProactiveCallState =
  | "queued"
  | "preparing"
  | "ready"
  | "dispatching"
  | "connected"
  | "ended"
  | "canceled"
  | "expired"
  | "refused"
  | "unknown";
export interface ProactiveCallIntent {
  id: string;
  version: 1;
  source: CallSource;
  observations: CallSource[];
  scope: CallScope;
  policyId: string;
  trigger: CallTrigger;
  channel: CallChannel;
  expiresAt: number;
  brief: string;
  state: ProactiveCallState;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  packetFingerprint?: string;
  attemptId?: string;
  grantId?: string;
  history: Array<{ state: ProactiveCallState; at: number; reason?: string }>;
}
export const enqueueCallSchema = z
  .object({
    source: callSourceSchema,
    scope: callScopeSchema,
    policyId: identity,
    trigger: callTriggerSchema,
    channel: callChannelSchema,
    expiresAt: z.number().finite().nonnegative(),
    brief: z.string().trim().min(1).max(4000),
  })
  .strict();
export type EnqueueCall = z.infer<typeof enqueueCallSchema>;
export interface CallAttemptGrant {
  version: 2;
  id: string;
  policyId: string;
  policyRevision: number;
  packetFingerprint: string;
  intentId: string;
  attemptId: string;
  source: CallSource;
  scope: CallScope;
  channel: CallChannel;
  issuedAt: number;
  expiresAt: number;
  /** Viewing permission is bounded metadata, never an input grant or capture itself. */
  viewScope: string[];
  inputAllowed: false;
}

export const callAttemptGrantSchema = z
  .object({
    version: z.literal(2),
    id: identity,
    policyId: identity,
    policyRevision: z.number().int().positive(),
    packetFingerprint: digest,
    intentId: identity,
    attemptId: identity,
    source: callSourceSchema,
    scope: callScopeSchema,
    channel: callChannelSchema,
    issuedAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative(),
    viewScope: z.array(z.string().min(1).max(2000)).max(32),
    inputAllowed: z.literal(false),
  })
  .strict();
