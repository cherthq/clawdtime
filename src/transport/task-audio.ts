import { z } from "zod";
import { hash, DomainError } from "../storage/security.js";
import { jsonRequest } from "./native-messages.js";

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
  private bound(plan: TaskAudioPlan) {
    taskAudioPlanSchema.parse(plan);
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
    plan: TaskAudioPlan,
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
        media: { audio: true, video: false },
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
    plan: TaskAudioPlan,
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
    };
  }
  async end(plan: TaskAudioPlan, providerCallId: string, effectId: string) {
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
