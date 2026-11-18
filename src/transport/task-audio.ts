import { z } from "zod";
import { hash, DomainError } from "../storage/security.js";
import { taskSceneFrameSchema } from "../task-presentation-contracts.js";
import { jsonRequest } from "./native-messages.js";
import {
  isTaskWalkthroughPlan,
  taskWalkthroughPlanSchema,
  taskWalkthroughFingerprint,
  taskWalkthroughPresentationBindingSchema,
  type TaskHandsetPlan,
  type TaskHandsetAuthorization,
  type TaskWalkthroughPlan,
} from "../task-walkthrough-contracts.js";
export type {
  TaskHandsetPlan,
  TaskHandsetAuthorization,
} from "../task-walkthrough-contracts.js";

/** Preserve c.1's exact serialized schema and hash; only the explicit new mode selects export. */
export function parseTaskHandsetPlan(plan: TaskHandsetPlan): TaskHandsetPlan {
  return isTaskWalkthroughPlan(plan)
    ? taskWalkthroughPlanSchema.parse(plan)
    : taskAudioPlanSchema.parse(plan);
}
export function taskHandsetFingerprint(plan: TaskHandsetPlan): string {
  return isTaskWalkthroughPlan(plan)
    ? taskWalkthroughFingerprint(plan)
    : taskAudioFingerprint(plan);
}
export const taskWalkthroughVideoEvidenceSchema = z
  .object({
    evidence: z.literal("sdk_frame_accepted_not_remote_seen"),
    presentationId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    manifestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sceneId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
    generation: z.number().int().nonnegative().safe(),
    sourceFrameId: taskSceneFrameSchema.shape.sourceFrameId,
    geometryGeneration: taskSceneFrameSchema.shape.geometryGeneration,
    capturedAt: taskSceneFrameSchema.shape.capturedAt,
    renderedAt: taskSceneFrameSchema.shape.renderedAt,
    acceptedAt: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(
    (frame) =>
      frame.capturedAt <= frame.renderedAt &&
      frame.renderedAt <= frame.acceptedAt,
    "Video evidence timestamps conflict.",
  );
export type TaskWalkthroughVideoEvidence = z.infer<
  typeof taskWalkthroughVideoEvidenceSchema
>;
export interface TaskWalkthroughMediaObservation extends Omit<
  TaskAudioMediaObservation,
  "video" | "screen" | "presentation"
> {
  mode: "handset_walkthrough";
  sharingActive: boolean;
  instructions: true;
  nativeActivation: false;
  planFingerprint: string;
  videoEvidence?: TaskWalkthroughVideoEvidence;
  video: true;
  screen: true;
  presentation: true;
  exportGrantId: string;
  presentationBinding: TaskWalkthroughPlan["presentationBinding"];
}
export type TaskHandsetMediaObservation =
  TaskAudioMediaObservation | TaskWalkthroughMediaObservation;
export type TaskHandsetReadiness = TaskAudioReadiness & {
  videoReady?: boolean;
  presentationReady?: boolean;
};
export interface TaskHandsetMediaPort {
  prepare(
    plan: TaskHandsetPlan,
    effectId: string,
  ): Promise<
    TaskHandsetMediaObservation & {
      credentials: TaskAudioCredentials;
      silentPublisherReady: true;
      videoPublisherReady?: boolean;
    }
  >;
  activate(
    plan: TaskHandsetPlan,
    providerCallId: string,
    effectId: string,
  ): Promise<TaskHandsetMediaObservation>;
  inspect(plan: TaskHandsetPlan): Promise<TaskHandsetMediaObservation>;
  close(
    plan: TaskHandsetPlan,
    effectId: string,
  ): Promise<TaskHandsetMediaObservation>;
}
export interface TaskHandsetCallsPort {
  create(
    plan: TaskHandsetPlan,
    credentials: TaskAudioCredentials,
    effectId: string,
  ): Promise<{ providerCallId: string; lineId: string }>;
  inspect(
    plan: TaskHandsetPlan,
    providerCallId: string,
  ): Promise<TaskAudioNativeObservation>;
  end(
    plan: TaskHandsetPlan,
    providerCallId: string,
    effectId: string,
  ): Promise<{ accepted: true; providerCallId: string }>;
}
export interface TaskHandsetPorts {
  authorize(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
  ): Promise<void> | void;
  readiness(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
  ): Promise<TaskHandsetReadiness>;
  media: TaskHandsetMediaPort;
  calls: TaskHandsetCallsPort;
}

/** c.1 only: a one-call audio plan is not a desktop, video or coding grant. */
export interface TaskAudioPlan {
  id: string;
  taskSessionId: string;
  taskId: string;
  runId: string;
  revision: number;
  voiceSessionId: string;
  pairingId: string;
  memberId: string;
  deviceId: string;
  lineId: string;
  recipientHash: string;
  mediaSessionId: string;
  workerIdentity: string;
  agentIdentity: string;
  expiresAt: number;
  audio: true;
  video: false;
  screen: false;
  presentation: false;
  control: false;
  maxCalls: 1;
}
export interface TaskAudioAuthorization {
  id: string;
  planFingerprint: string;
  authorizedAt: number;
  expiresAt: number;
  oneCallAuthorized: true;
}
export interface TaskAudioReadiness {
  source: "synthetic" | "operator_verified_native";
  checkedAt: number;
  planFingerprint: string;
  lineId: string;
  pairingId: string;
  memberId: string;
  deviceId: string;
  recipientHash: string;
  idle: boolean;
  exclusiveOwner: boolean;
  identityVerified: boolean;
  cursorPreserved: boolean;
  cleanupClear: boolean;
  audioReady: boolean;
}
export interface TaskAudioCredentials {
  livekit_url: string;
  participant_token: string;
  remote_participant_identity: string;
}
export interface TaskAudioMediaObservation {
  audioOutput?: {
    evidence: "sdk_acceptance_not_audibility";
    preparedSilentFrames: number;
    speechFrames: number;
  };
  callAttemptId: string;
  mediaSessionId: string;
  state: "absent" | "prepared" | "active" | "closed" | "unknown";
  providerCallId?: string;
  audio: true;
  video: false;
  screen: false;
  presentation: false;
  control: false;
}
export interface TaskAudioMediaPort {
  prepare(
    plan: TaskAudioPlan,
    effectId: string,
  ): Promise<
    TaskAudioMediaObservation & {
      credentials: TaskAudioCredentials;
      silentPublisherReady: true;
    }
  >;
  activate(
    plan: TaskAudioPlan,
    providerCallId: string,
    effectId: string,
  ): Promise<TaskAudioMediaObservation>;
  inspect(plan: TaskAudioPlan): Promise<TaskAudioMediaObservation>;
  close(
    plan: TaskAudioPlan,
    effectId: string,
  ): Promise<TaskAudioMediaObservation>;
}
export interface TaskAudioNativeObservation {
  /** Worker decoded/handoff evidence, never handset visibility or physical acceptance. */
  remoteVideoReady?: boolean;
  providerCallId: string;
  state: "allocated" | "connected" | "terminal";
  cleanupComplete: boolean;
}
export interface TaskAudioCallsPort {
  create(
    plan: TaskAudioPlan,
    credentials: TaskAudioCredentials,
    effectId: string,
  ): Promise<{ providerCallId: string; lineId: string }>;
  inspect(
    plan: TaskAudioPlan,
    providerCallId: string,
  ): Promise<TaskAudioNativeObservation>;
  end(
    plan: TaskAudioPlan,
    providerCallId: string,
    effectId: string,
  ): Promise<{ accepted: true; providerCallId: string }>;
}
export interface TaskAudioPorts {
  /** Must read current task/session/pairing and exact fresh one-call operator authority. */
  authorize(
    plan: TaskAudioPlan,
    authorization: TaskAudioAuthorization,
  ): Promise<void> | void;
  /** Native integrations must independently verify every field; synthetic evidence is never production readiness. */
  readiness(
    plan: TaskAudioPlan,
    authorization: TaskAudioAuthorization,
  ): Promise<TaskAudioReadiness>;
  media: TaskAudioMediaPort;
  calls: TaskAudioCallsPort;
}

const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
export const taskAudioPlanSchema = z
  .object({
    id: opaque,
    taskSessionId: opaque,
    taskId: opaque,
    runId: opaque,
    revision: z.number().int().nonnegative(),
    voiceSessionId: opaque,
    pairingId: opaque,
    memberId: opaque,
    deviceId: opaque,
    lineId: z.string().uuid(),
    recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
    mediaSessionId: opaque,
    workerIdentity: opaque,
    agentIdentity: opaque,
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    audio: z.literal(true),
    video: z.literal(false),
    screen: z.literal(false),
    presentation: z.literal(false),
    control: z.literal(false),
    maxCalls: z.literal(1),
  })
  .strict();
export function taskAudioFingerprint(plan: TaskAudioPlan): string {
  // zod rebuilds in schema order, so object insertion order cannot change identity.
  const value = taskAudioPlanSchema.parse(plan);
  if (value.workerIdentity === value.agentIdentity)
    throw new DomainError(
      400,
      "Incoming and outgoing participant identities must differ.",
    );
  return hash(JSON.stringify(value));
}
export const taskAudioRoomName = (mediaSessionId: string) =>
  `clawdtime-task-${opaque.parse(mediaSessionId)}`;

export function taskAudioMediaBinding(plan: TaskAudioPlan) {
  taskAudioFingerprint(plan);
  return {
    mediaSessionId: plan.mediaSessionId,
    taskId: plan.taskId,
    voiceSessionId: plan.voiceSessionId,
    callAttemptId: plan.id,
    roomName: taskAudioRoomName(plan.mediaSessionId),
    workerIdentity: plan.workerIdentity,
    agentIdentity: plan.agentIdentity,
    expiresAt: plan.expiresAt,
    audio: true as const,
    video: false as const,
    screen: false as const,
    presentation: false as const,
    control: false as const,
  };
}
export function taskAudioMediaFingerprint(plan: TaskAudioPlan) {
  return hash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(taskAudioMediaBinding(plan)).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    ),
  );
}

const credentialsSchema = z
  .object({
    livekit_url: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "wss:"),
    participant_token: z.string().min(40).max(8192),
    remote_participant_identity: opaque,
  })
  .strict();
export function validateTaskAudioCredentials(
  value: TaskAudioCredentials,
): TaskAudioCredentials {
  return credentialsSchema.parse(value);
}

/** Fixed loopback media bridge only. No auto-start, browser origin, redirect or retry. */
export class HttpTaskAudioMediaPort implements TaskAudioMediaPort {
  constructor(
    private readonly config: { origin: string; token: string },
    private readonly request: typeof fetch = fetch,
  ) {
    const origin = new URL(config.origin);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.origin !== config.origin ||
      origin.username ||
      origin.password ||
      !origin.port ||
      Number(origin.port) < 1024 ||
      config.token.length < 32 ||
      config.token.length > 200
    )
      throw new DomainError(
        400,
        "Exact loopback media origin and protected bearer are required.",
      );
  }
  private api(path: string, body?: unknown) {
    return jsonRequest(
      this.config.origin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
      path === "/close" ? 45000 : path === "/status" ? 5000 : 35000,
    );
  }
  private observation(
    plan: TaskAudioPlan,
    raw: Record<string, unknown>,
  ): TaskAudioMediaObservation {
    const result = z
      .object({
        callAttemptId: z.literal(plan.id),
        mediaSessionId: z.literal(plan.mediaSessionId),
        roomName: z.literal(taskAudioRoomName(plan.mediaSessionId)),
        bindingFingerprint: z.literal(taskAudioMediaFingerprint(plan)),
        state: z.enum(["absent", "prepared", "active", "closed", "unknown"]),
        providerCallId: z.string().uuid().optional(),
        closed: z.boolean(),
        nativeCallClosed: z.literal(false),
        audioOutput: z
          .object({
            evidence: z.literal("sdk_acceptance_not_audibility"),
            preparedSilentFrames: z.number().int().nonnegative().max(1_000_000),
            speechFrames: z.number().int().nonnegative().max(1_000_000),
          })
          .strict()
          .optional(),
        audio: z.literal(true),
        video: z.literal(false),
        screen: z.literal(false),
        presentation: z.literal(false),
        control: z.literal(false),
      })
      .parse(raw);
    if ((result.state === "closed") !== result.closed)
      throw new DomainError(
        409,
        "Media cleanup observation contradicts its state.",
      );
    return result;
  }
  async prepare(plan: TaskAudioPlan, _effectId: string) {
    const raw = await this.api("/prepare", taskAudioMediaBinding(plan));
    const observation = this.observation(plan, raw);
    if (
      observation.state !== "prepared" ||
      raw.silentPublisherReady !== true ||
      raw.videoPublisherReady !== false
    )
      throw new DomainError(
        409,
        "Audio-only media publisher readiness is unavailable.",
      );
    const credentials = validateTaskAudioCredentials(
      raw.credentials as TaskAudioCredentials,
    );
    if (credentials.remote_participant_identity !== plan.agentIdentity)
      throw new DomainError(409, "Prepared outgoing participant differs.");
    return { ...observation, credentials, silentPublisherReady: true as const };
  }
  async activate(
    plan: TaskAudioPlan,
    providerCallId: string,
    _effectId: string,
  ) {
    const observation = this.observation(
      plan,
      await this.api("/activate", {
        callAttemptId: plan.id,
        providerCallId,
        connected: true,
      }),
    );
    if (
      observation.state !== "active" ||
      observation.providerCallId !== providerCallId
    )
      throw new DomainError(
        409,
        "Exact connected media activation is unavailable.",
      );
    return observation;
  }
  async inspect(plan: TaskAudioPlan) {
    return this.observation(plan, await this.api("/status"));
  }
  async close(plan: TaskAudioPlan, _effectId: string) {
    const observation = this.observation(
      plan,
      await this.api("/close", { callAttemptId: plan.id }),
    );
    if (observation.state !== "closed")
      throw new DomainError(409, "Local media cleanup remains unconfirmed.");
    return observation;
  }
}

/** A distinct export binding; omitted fields never upgrade the historical audio binding. */
export function taskHandsetMediaBinding(plan: TaskHandsetPlan) {
  if (!isTaskWalkthroughPlan(plan)) return taskAudioMediaBinding(plan);
  const parsed = taskWalkthroughPlanSchema.parse(plan);
  return {
    mediaSessionId: parsed.mediaSessionId,
    taskId: parsed.taskId,
    voiceSessionId: parsed.voiceSessionId,
    callAttemptId: parsed.id,
    roomName: taskAudioRoomName(parsed.mediaSessionId),
    workerIdentity: parsed.workerIdentity,
    agentIdentity: parsed.agentIdentity,
    mode: parsed.mode,
    dispatchExpiresAt: parsed.dispatchExpiresAt,
    expiresAt: parsed.expiresAt,
    exportGrantId: parsed.exportGrantId,
    presentationBinding: parsed.presentationBinding,
    planFingerprint: taskHandsetFingerprint(parsed),
    audio: true as const,
    video: true as const,
    screen: true as const,
    presentation: true as const,
    instructions: true as const,
    control: false as const,
    nativeActivation: false as const,
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function taskHandsetMediaFingerprint(plan: TaskHandsetPlan) {
  if (!isTaskWalkthroughPlan(plan)) return taskAudioMediaFingerprint(plan);
  return hash(JSON.stringify(canonical(taskHandsetMediaBinding(plan))));
}

/** One fixed loopback service, with an explicit new export branch and unchanged c.1 adapter. */
export class HttpTaskHandsetMediaPort implements TaskHandsetMediaPort {
  private readonly audio: HttpTaskAudioMediaPort;
  constructor(
    private readonly config: { origin: string; token: string },
    private readonly request: typeof fetch = fetch,
  ) {
    this.config = { ...config };
    this.audio = new HttpTaskAudioMediaPort(this.config, request); // Validate protected origin/token without effects.
  }
  private api(path: string, body?: unknown) {
    return jsonRequest(
      this.config.origin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
      path === "/close" ? 45000 : path === "/status" ? 5000 : 35000,
    );
  }
  private observation(
    plan: TaskWalkthroughPlan,
    raw: Record<string, unknown>,
  ): TaskWalkthroughMediaObservation {
    const result = z
      .object({
        mode: z.literal("handset_walkthrough"),
        instructions: z.literal(true),
        nativeActivation: z.literal(false),
        planFingerprint: z.literal(taskHandsetFingerprint(plan)),
        callAttemptId: z.literal(plan.id),
        mediaSessionId: z.literal(plan.mediaSessionId),
        roomName: z.literal(taskAudioRoomName(plan.mediaSessionId)),
        bindingFingerprint: z.literal(taskHandsetMediaFingerprint(plan)),
        exportGrantId: z.literal(plan.exportGrantId),
        presentationBinding: taskWalkthroughPresentationBindingSchema,
        state: z.enum(["absent", "prepared", "active", "closed", "unknown"]),
        providerCallId: z.string().uuid().optional(),
        closed: z.boolean(),
        nativeCallClosed: z.literal(false),
        sharingActive: z.boolean(),
        videoEvidence: taskWalkthroughVideoEvidenceSchema.optional(),
        audio: z.literal(true),
        video: z.literal(true),
        screen: z.literal(true),
        presentation: z.literal(true),
        control: z.literal(false),
        audioOutput: z
          .object({
            evidence: z.literal("sdk_acceptance_not_audibility"),
            preparedSilentFrames: z.number().int().nonnegative().max(1_000_000),
            speechFrames: z.number().int().nonnegative().max(1_000_000),
          })
          .strict()
          .optional(),
      })
      .parse(raw);
    if (
      JSON.stringify(result.presentationBinding) !==
        JSON.stringify(
          taskWalkthroughPresentationBindingSchema.parse(
            plan.presentationBinding,
          ),
        ) ||
      (result.state === "closed") !== result.closed ||
      (result.closed && result.sharingActive) ||
      (result.videoEvidence &&
        (result.videoEvidence.presentationId !==
          plan.presentationBinding.presentationId ||
          result.videoEvidence.manifestFingerprint !==
            plan.presentationBinding.manifestFingerprint))
    )
      throw new DomainError(
        409,
        "Walkthrough media observation conflicts with its immutable export binding.",
      );
    return result;
  }
  async prepare(plan: TaskHandsetPlan, effectId: string) {
    if (!isTaskWalkthroughPlan(plan)) return this.audio.prepare(plan, effectId);
    const parsed = taskWalkthroughPlanSchema.parse(plan);
    const raw = await this.api("/prepare", taskHandsetMediaBinding(parsed));
    const observation = this.observation(parsed, raw);
    if (
      observation.state !== "prepared" ||
      raw.silentPublisherReady !== true ||
      raw.videoPublisherReady !== true ||
      !observation.videoEvidence ||
      !observation.sharingActive
    )
      throw new DomainError(
        409,
        "Prepared walkthrough audio and video evidence is unavailable.",
      );
    const credentials = validateTaskAudioCredentials(
      raw.credentials as TaskAudioCredentials,
    );
    if (credentials.remote_participant_identity !== plan.agentIdentity)
      throw new DomainError(409, "Prepared outgoing participant differs.");
    return {
      ...observation,
      credentials,
      silentPublisherReady: true as const,
      videoPublisherReady: true as const,
    };
  }
  async activate(
    plan: TaskHandsetPlan,
    providerCallId: string,
    effectId: string,
  ) {
    if (!isTaskWalkthroughPlan(plan))
      return this.audio.activate(plan, providerCallId, effectId);
    const observation = this.observation(
      plan,
      await this.api("/activate", {
        callAttemptId: plan.id,
        providerCallId,
        connected: true,
      }),
    );
    if (
      observation.state !== "active" ||
      observation.providerCallId !== providerCallId
    )
      throw new DomainError(
        409,
        "Exact connected walkthrough media is unavailable.",
      );
    return observation;
  }
  async inspect(plan: TaskHandsetPlan) {
    return isTaskWalkthroughPlan(plan)
      ? this.observation(plan, await this.api("/status"))
      : this.audio.inspect(plan);
  }
  async close(plan: TaskHandsetPlan, effectId: string) {
    if (!isTaskWalkthroughPlan(plan)) return this.audio.close(plan, effectId);
    const observation = this.observation(
      plan,
      await this.api("/close", { callAttemptId: plan.id }),
    );
    if (observation.state !== "closed")
      throw new DomainError(
        409,
        "Walkthrough local cleanup remains unconfirmed.",
      );
    return observation;
  }
}

/** Narrow Calls HTTP adapter. It does not supply ownership/readiness or enable dispatch. */
export class NativeTaskAudioCalls implements TaskAudioCallsPort {
  constructor(
    private readonly config: {
      callsOrigin: string;
      projectId: string;
      projectKey: string;
      recipient: string;
      lineId: string;
    },
    private readonly request: typeof fetch = fetch,
  ) {
    const origin = new URL(config.callsOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== config.callsOrigin ||
      origin.username ||
      origin.password ||
      !config.projectId ||
      config.projectKey.length < 16 ||
      !/^\+[1-9]\d{7,14}$/.test(config.recipient) ||
      !z.string().uuid().safeParse(config.lineId).success
    )
      throw new DomainError(
        400,
        "Protected task audio Calls configuration is invalid.",
      );
  }
  private bound(plan: TaskHandsetPlan) {
    parseTaskHandsetPlan(plan);
    if (
      plan.lineId !== this.config.lineId ||
      plan.recipientHash !== hash(this.config.recipient)
    )
      throw new DomainError(
        403,
        "Task audio destination does not match protected configuration.",
      );
  }
  private api(path: string, body?: unknown, effectId?: string) {
    return jsonRequest(
      this.config.callsOrigin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.projectKey}`,
          "X-Chert-Project-Id": this.config.projectId,
          "content-type": "application/json",
          ...(effectId ? { "Idempotency-Key": effectId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
    );
  }
  async create(
    plan: TaskHandsetPlan,
    credentials: TaskAudioCredentials,
    effectId: string,
  ) {
    this.bound(plan);
    const media = validateTaskAudioCredentials(credentials);
    if (media.remote_participant_identity !== plan.agentIdentity)
      throw new DomainError(
        403,
        "Outgoing audio identity differs from the prepared task plan.",
      );
    const response = await this.api(
      "/api/v1/calls",
      {
        direction: "outbound",
        mode: "customer_managed",
        line_id: plan.lineId,
        media: { audio: true, video: isTaskWalkthroughPlan(plan) },
        destination: this.config.recipient,
        destination_type: "phone",
        ...media,
      },
      effectId,
    );
    const call = z
      .object({ id: z.string().uuid(), line_id: z.literal(plan.lineId) })
      .parse(response.data);
    return { providerCallId: call.id, lineId: call.line_id };
  }
  async inspect(
    plan: TaskHandsetPlan,
    providerCallId: string,
  ): Promise<TaskAudioNativeObservation> {
    this.bound(plan);
    z.string().uuid().parse(providerCallId);
    const response = await this.api(
      `/api/v1/calls/${encodeURIComponent(providerCallId)}/events`,
    );
    const data = z
      .object({
        call_id: z.literal(providerCallId),
        events: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              type: z.string().min(1).max(100),
              source: z.string().min(1).max(100),
            }),
          )
          .max(10000),
      })
      .parse(response.data);
    if (
      new Set(data.events.map((event) => event.id)).size !== data.events.length
    )
      throw new DomainError(409, "Native event identity conflicts.");
    const events = new Set(
      data.events
        .filter((event) => event.source === "worker")
        .map((event) => event.type),
    );
    const cleanupComplete = events.has("cleanup_complete");
    const terminal =
      cleanupComplete ||
      ["ended", "failed", "rejected"].some((event) => events.has(event));
    return {
      providerCallId,
      state: terminal
        ? "terminal"
        : events.has("bridge_ready")
          ? "connected"
          : "allocated",
      cleanupComplete,
      ...(isTaskWalkthroughPlan(plan)
        ? { remoteVideoReady: events.has("remote_video_ready") }
        : {}),
    };
  }
  async end(plan: TaskHandsetPlan, providerCallId: string, effectId: string) {
    this.bound(plan);
    z.string().uuid().parse(providerCallId);
    await this.api(
      `/api/v1/calls/${encodeURIComponent(providerCallId)}/end`,
      { reason: "ClawdTime task audio smoke test ended" },
      effectId,
    );
    // This means submission was acknowledged, not that native worker cleanup completed.
    return { accepted: true as const, providerCallId };
  }
}
