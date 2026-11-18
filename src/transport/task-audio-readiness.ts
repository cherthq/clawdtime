import { z } from "zod";
import type { Pairing } from "../contracts.js";
import { Store } from "../storage/store.js";
import { DomainError, hash } from "../storage/security.js";
import {
  NativeMessageReader,
  type EventAnchor,
  jsonRequest,
  type MessageBinding,
} from "./native-messages.js";
import type { LineHandoff } from "./native.js";
import {
  taskHandsetFingerprint,
  type TaskHandsetPlan,
  type TaskHandsetAuthorization,
  type TaskHandsetReadiness,
  type TaskAudioPlan,
  type TaskAudioAuthorization,
  type TaskAudioReadiness,
} from "./task-audio.js";

import {
  isTaskWalkthroughPlan,
  taskWalkthroughAuthorizationSchema,
  type TaskWalkthroughPlan,
  type TaskWalkthroughAuthorization,
} from "../task-walkthrough-contracts.js";

/** Read-only native evidence for c.1. No legacy media, gateway, screen or video dependency. */
export class NativeTaskAudioReadiness {
  private readonly messages: NativeMessageReader;
  constructor(
    private readonly store: Pick<Store, "get" | "all" | "state" | "effects">,
    private readonly config: {
      binding: MessageBinding;
      callsOrigin: string;
      projectId: string;
      projectKey: string;
      handoff: () => LineHandoff;
    },
    private readonly request: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    const url = new URL(config.callsOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== config.callsOrigin ||
      url.username ||
      url.password ||
      !config.projectId ||
      config.projectKey.length < 16
    )
      throw new DomainError(
        400,
        "Exact protected native Calls configuration is required.",
      );
    this.messages = new NativeMessageReader(config.binding, request);
  }
  private local(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
  ) {
    const now = this.clock(),
      fingerprint = taskHandsetFingerprint(plan),
      b = this.config.binding,
      h = this.config.handoff();
    const pairing = this.store.get<Pairing>("pairing", plan.pairingId),
      cursor = this.store.state<EventAnchor>(`messages:${b.lineId}`);
    if (
      !Number.isFinite(authorization.authorizedAt) ||
      !Number.isFinite(authorization.expiresAt) ||
      authorization.planFingerprint !== fingerprint ||
      authorization.oneCallAuthorized !== true ||
      authorization.authorizedAt > now ||
      authorization.expiresAt <= now ||
      authorization.expiresAt > authorization.authorizedAt + 300_000 ||
      (isTaskWalkthroughPlan(plan)
        ? !taskWalkthroughAuthorizationSchema.safeParse(authorization)
            .success ||
          !("callExpiresAt" in authorization) ||
          plan.expiresAt !== authorization.callExpiresAt ||
          plan.dispatchExpiresAt !== authorization.expiresAt
        : "callExpiresAt" in authorization ||
          plan.expiresAt > authorization.expiresAt) ||
      plan.expiresAt <= now
    )
      throw new DomainError(
        403,
        "Fresh exact one-call authorization is required.",
      );
    if (
      !pairing ||
      pairing.revokedAt !== undefined ||
      pairing.memberId !== plan.memberId ||
      pairing.deviceId !== plan.deviceId ||
      pairing.lineId !== plan.lineId ||
      hash(pairing.recipient) !== plan.recipientHash ||
      b.lineId !== plan.lineId
    )
      throw new DomainError(
        403,
        "Current task audio pairing identity differs.",
      );
    if (
      !h ||
      h.owner !== "clawdtime" ||
      h.sourceOwnerPaused !== true ||
      h.lineId !== b.lineId ||
      h.providerLineId !== b.providerLineId ||
      h.instanceId !== b.instanceId ||
      h.phone !== b.phone ||
      !h.identityEvidence?.trim() ||
      !h.sourcePauseEvidence?.trim() ||
      !h.rollbackRecord?.trim() ||
      !Number.isFinite(h.checkedAt) ||
      h.checkedAt > now + 1000 ||
      now - h.checkedAt > 300_000
    )
      throw new DomainError(
        403,
        "Fresh exact exclusive native ownership evidence is required.",
      );
    if (
      !cursor ||
      !Number.isSafeInteger(h.baseline?.sequence) ||
      h.baseline.sequence < 1 ||
      !h.baseline.eventId ||
      cursor.sequence < h.baseline.sequence ||
      (cursor.sequence === h.baseline.sequence &&
        cursor.eventId !== h.baseline.eventId)
    )
      throw new DomainError(
        409,
        "Preserved committed native cursor is required.",
      );
    if (
      this.store
        .effects()
        .some((e) => ["pending", "running", "unknown"].includes(e.state)) ||
      this.store
        .all<{ state: string }>("call")
        .some((c) => c.state !== "ended") ||
      this.store
        .all<{ state: string }>("lease")
        .some((c) => ["active", "unknown"].includes(c.state)) ||
      this.store
        .all<{ state: string }>("action")
        .some((c) =>
          ["pending", "submitted", "running", "unknown"].includes(c.state),
        )
    )
      throw new DomainError(
        409,
        "Existing native effects or control ownership require reconciliation.",
      );
    return { cursor, handoffFingerprint: hash(JSON.stringify(h)), fingerprint };
  }
  private async line() {
    let offset = 0;
    const matching: Record<string, unknown>[] = [];
    for (let page = 0; page < 20; page++) {
      const raw = await jsonRequest(
        `${this.config.callsOrigin}/api/v1/lines?limit=100&offset=${offset}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.config.projectKey}`,
            "X-Chert-Project-Id": this.config.projectId,
          },
        },
        this.request,
      );
      const data = z
        .object({
          items: z.array(z.record(z.string(), z.unknown())).max(100),
          total: z.number().int().nonnegative(),
          limit: z.number().int().positive(),
          offset: z.number().int().nonnegative(),
        })
        .parse(raw.data);
      if (
        data.offset !== offset ||
        data.limit !== 100 ||
        (data.items.length === 0 && offset < data.total)
      )
        throw new DomainError(
          409,
          "Native inventory pagination is inconsistent.",
        );
      matching.push(
        ...data.items.filter((line) => line.id === this.config.binding.lineId),
      );
      offset += data.items.length;
      if (offset >= data.total) {
        if (matching.length !== 1)
          throw new DomainError(
            409,
            "Exactly one native logical line is required.",
          );
        return matching[0]!;
      }
    }
    throw new DomainError(409, "Native inventory exceeded the bounded read.");
  }
  async check(
    plan: TaskAudioPlan,
    authorization: TaskAudioAuthorization,
  ): Promise<TaskAudioReadiness> {
    return this.checkBound(plan, authorization);
  }
  async checkWalkthrough(
    plan: TaskWalkthroughPlan,
    authorization: TaskWalkthroughAuthorization,
  ): Promise<TaskHandsetReadiness> {
    return this.checkBound(plan, authorization);
  }
  private async worker(workerId: string): Promise<Record<string, unknown>> {
    if (!workerId || workerId.length > 200)
      throw new DomainError(409, "Exact native worker binding is unavailable.");
    const matches: Record<string, unknown>[] = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const response = await jsonRequest(
        `${this.config.callsOrigin}/api/v1/workers?limit=100&offset=${offset}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.config.projectKey}`,
            "X-Chert-Project-Id": this.config.projectId,
          },
        },
        this.request,
      );
      const page = z
        .object({
          items: z.array(z.record(z.string(), z.unknown())).max(100),
          total: z.number().int().nonnegative(),
          limit: z.literal(100),
          offset: z.literal(offset),
        })
        .parse(response.data);
      matches.push(...page.items.filter((item) => item.id === workerId));
      if (matches.length > 1 || (!page.items.length && offset < page.total))
        throw new DomainError(409, "Native worker inventory conflicts.");
      if (offset + page.items.length >= page.total) {
        if (matches.length !== 1)
          throw new DomainError(409, "Exact native worker is unavailable.");
        return matches[0]!;
      }
    }
    throw new DomainError(409, "Native worker inventory exceeded its bound.");
  }
  private async checkBound(
    plan: TaskHandsetPlan,
    authorization: TaskHandsetAuthorization,
  ): Promise<TaskHandsetReadiness> {
    const before = this.local(plan, authorization),
      startedAt = this.clock();
    const results = await Promise.allSettled([
      this.messages.verify(),
      this.messages.verifyAnchor(before.cursor),
      this.line(),
    ]);
    for (const result of results)
      if (result.status === "rejected")
        throw new DomainError(
          503,
          "Exact native identity, cursor or idle line could not be verified.",
        );
    const after = this.local(plan, authorization);
    if (
      before.handoffFingerprint !== after.handoffFingerprint ||
      JSON.stringify(before.cursor) !== JSON.stringify(after.cursor)
    )
      throw new DomainError(
        409,
        "Native ownership or cursor changed during verification.",
      );
    const line = (results[2] as PromiseFulfilledResult<Record<string, unknown>>)
      .value;
    const worker = isTaskWalkthroughPlan(plan)
      ? await this.worker(
          typeof line.worker_id === "string" ? line.worker_id : "",
        )
      : undefined;
    // Worker inspection adds an await: recheck retained identity and ownership again before returning.
    if (worker) {
      const final = this.local(plan, authorization);
      if (
        final.handoffFingerprint !== before.handoffFingerprint ||
        JSON.stringify(final.cursor) !== JSON.stringify(before.cursor)
      )
        throw new DomainError(
          409,
          "Native ownership changed during video verification.",
        );
      const session = z
        .record(z.string(), z.unknown())
        .parse(line.session_health);
      const capabilities = z
        .record(z.string(), z.unknown())
        .parse(session.capabilities);
      const workerCapabilities = z
        .record(z.string(), z.unknown())
        .parse(worker.capabilities);
      if (
        line.supports_video !== true ||
        line.supports_audio !== true ||
        worker.enabled !== true ||
        worker.status !== "accepting" ||
        worker.current_call_id !== null ||
        capabilities.video !== true ||
        capabilities.outbound_video_protocol !== 1 ||
        workerCapabilities.video !== true ||
        workerCapabilities.outbound_audio_protocol !== 1 ||
        workerCapabilities.outbound_video_protocol !== 1 ||
        !automaticVideoEvidence(worker, this.clock()) ||
        !automaticVideoEvidence(
          {
            ...worker,
            readiness: session.readiness,
            last_heartbeat_at: session.last_heartbeat_at,
          },
          this.clock(),
        )
      )
        throw new DomainError(
          503,
          "Fresh exact automatic native video readiness is unavailable.",
        );
    }
    const health = z
      .object({
        line_id: z.literal(plan.lineId),
        identity_confirmed: z.literal(true),
        last_heartbeat_at: z.string(),
        status: z.literal("accepting"),
        capabilities: z.object({ outbound_audio_protocol: z.literal(1) }),
        readiness: z.record(z.string(), z.unknown()),
      })
      .parse(line.session_health);
    const heartbeat = Date.parse(health.last_heartbeat_at),
      ready = health.readiness;
    const audio = audioEvidence(ready, this.clock());
    if (
      line.id !== plan.lineId ||
      (line.phone_number != null &&
        line.phone_number !== this.config.binding.phone) ||
      line.current_call_id !== null ||
      line.worker_occupied !== false ||
      line.status !== "available" ||
      !Number.isFinite(heartbeat) ||
      heartbeat > this.clock() + 1000 ||
      this.clock() - heartbeat > 90_000 ||
      !audio ||
      ["control_ready", "facetime_signed_in", "accessibility_ready"].some(
        (key) => ready[key] !== true,
      ) ||
      this.clock() - startedAt > 10_000
    )
      throw new DomainError(
        503,
        "Fresh exact idle native audio readiness is unavailable.",
      );
    return {
      source: "operator_verified_native",
      checkedAt: startedAt,
      planFingerprint: after.fingerprint,
      lineId: plan.lineId,
      pairingId: plan.pairingId,
      memberId: plan.memberId,
      deviceId: plan.deviceId,
      recipientHash: plan.recipientHash,
      idle: true,
      exclusiveOwner: true,
      identityVerified: true,
      cursorPreserved: true,
      cleanupClear: true,
      audioReady: true,
      ...(worker ? { videoReady: true } : {}),
    };
  }
}

const audioPrerequisites = [
  "accessibility",
  "facetime_signed_in",
  "audio_devices",
  "facetime_selections",
  "playback_renderer",
  "configuration",
  "control_plane_poll",
];
function audioEvidence(ready: Record<string, unknown>, now: number): boolean {
  const parsed = z
    .object({
      runtime_started_at: z.string(),
      started_at: z.string(),
      completed_at: z.string(),
      checks: z
        .array(
          z.object({
            id: z.string(),
            outcome: z.string(),
            completed_at: z.string().nullable(),
          }),
        )
        .max(100),
    })
    .safeParse(ready.automatic);
  if (!parsed.success) return false;
  const automatic = parsed.data,
    runtime = Date.parse(automatic.runtime_started_at),
    start = Date.parse(automatic.started_at),
    end = Date.parse(automatic.completed_at);
  if (
    ![runtime, start, end].every(Number.isFinite) ||
    runtime > start ||
    start > end ||
    end > now ||
    new Set(automatic.checks.map((c) => c.id)).size !== automatic.checks.length
  )
    return false;
  const fresh = (value: string | null) => {
    const time = value === null ? NaN : Date.parse(value);
    return (
      Number.isFinite(time) &&
      time >= runtime &&
      time <= end &&
      now - time < 90_000
    );
  };
  if (
    !audioPrerequisites.every((id) =>
      automatic.checks.some(
        (c) => c.id === id && c.outcome === "passed" && fresh(c.completed_at),
      ),
    )
  )
    return false;
  const capture = automatic.checks.find((c) => c.id === "system_audio_capture");
  return (
    !!capture &&
    ((ready.audio_ready === true &&
      capture.outcome === "passed" &&
      fresh(capture.completed_at)) ||
      (ready.audio_ready === false &&
        capture.outcome === "at_call_start" &&
        capture.completed_at === null))
  );
}

/** Same binding/freshness gates as the source-owned outbound reference, never aggregate video_ready alone. */
function automaticVideoEvidence(
  worker: Record<string, unknown>,
  now: number,
): boolean {
  const digest = z.string().regex(/^[a-f0-9]{64}$/),
    stamp = z.string();
  const automatic = z.object({
    version: z.literal(1),
    worker_id: z.literal(worker.id as string),
    runtime_id: z.string().uuid(),
    build: digest,
    device_binding: digest,
    config_binding: digest,
    profile: z.enum(["audio", "audio_optional_video", "audio_video"]),
    runtime_started_at: stamp,
    started_at: stamp,
    completed_at: stamp,
    checks: z
      .array(
        z.object({
          id: z.string(),
          outcome: z.string(),
          completed_at: z.string().nullable(),
        }),
      )
      .max(100),
  });
  const parsed = z
    .object({
      runtime_id: z.string().uuid(),
      build: digest,
      device_binding: digest,
      config_binding: digest,
      automatic_transport_missing: z.boolean().optional(),
      automatic,
      operating_intent: z
        .object({ runtime_id: z.string().uuid(), runtime_started_at: stamp })
        .optional(),
    })
    .safeParse(worker.readiness);
  if (!parsed.success || worker.automatic_readiness_enabled !== true)
    return false;
  const ready = parsed.data,
    a = ready.automatic,
    heartbeat = Date.parse(String(worker.last_heartbeat_at));
  const runtime = Date.parse(a.runtime_started_at),
    start = Date.parse(a.started_at),
    end = Date.parse(a.completed_at);
  if (
    ready.automatic_transport_missing ||
    ![heartbeat, runtime, start, end].every(Number.isFinite) ||
    heartbeat > now ||
    now - heartbeat >= 30000 ||
    runtime > start ||
    start > end ||
    end > now ||
    ready.runtime_id !== a.runtime_id ||
    ready.build !== a.build ||
    ready.device_binding !== a.device_binding ||
    ready.config_binding !== a.config_binding ||
    (ready.operating_intent &&
      (ready.operating_intent.runtime_id !== a.runtime_id ||
        ready.operating_intent.runtime_started_at !== a.runtime_started_at)) ||
    new Set(a.checks.map((c) => c.id)).size !== a.checks.length
  )
    return false;
  return [...audioPrerequisites, "video_resources", "screen_capture"].every(
    (id) =>
      a.checks.some((c) => {
        const at = c.completed_at === null ? NaN : Date.parse(c.completed_at);
        return (
          c.id === id &&
          c.outcome === "passed" &&
          Number.isFinite(at) &&
          at >= runtime &&
          at <= end &&
          now - at < 90000
        );
      }),
  );
}
