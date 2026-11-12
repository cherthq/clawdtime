import {
  recordTerminationIntent,
  type TerminationSource,
} from "../attention/termination.js";
import { noticeRetirementValid } from "../control/obsolete-notice.js";
import {
  retireSetupInvitation,
  setupInvitationRetirementValid,
  type SetupRetirementInput,
} from "../pairing/retired-setup.js";
import { mediaStatusSchema } from "./media-diagnostics.js";
import { z } from "zod";
import type {
  AttentionRequest,
  Pairing,
  EffectReceipt,
  Transport,
  CallSession,
  SetupTest,
} from "../contracts.js";
import { Store } from "../storage/store.js";
import {
  configurationChecks,
  NotDialed,
  PreflightBlocked,
  type ReadinessCheck,
  type TransportReadiness,
  type DeviceReadiness,
} from "./readiness.js";
import { DomainError, hash, Vault } from "../storage/security.js";
import {
  NativeMessages,
  jsonRequest,
  type MessageBinding,
  type EventAnchor,
} from "./native-messages.js";
export interface LineHandoff {
  owner: "clawdtime";
  sourceOwnerPaused: true;
  /** Required by live preflight; protected operator evidence, never user-visible. */
  phone?: string;
  identityEvidence?: string;
  sourcePauseEvidence?: string;
  lineId: string;
  providerLineId: string;
  instanceId: string;
  baseline: EventAnchor;
  checkedAt: number;
  rollbackRecord: string;
}
export interface NativeTransportConfig {
  enabled: boolean;
  binding: MessageBinding;
  callsOrigin: string;
  projectId: string;
  projectKey: string;
  mediaOrigin: string;
  mediaKey: string;
  encryptionKey: string;
  testerAllowlist: string[];
  handoff: LineHandoff;
}
interface MediaRecord {
  id: string;
  requestId: string;
  state:
    | "preparing"
    | "prepared"
    | "dialing"
    | "allocated"
    | "active"
    | "closing"
    | "closed"
    | "unknown";
  credentials?: string;
  providerCallId?: string;
  outcome?: "declined" | "unanswered" | "disconnected" | "failed";
  /** Set only when the native dial request was provably never sent. */
  notDialed?: { phase: NotDialed["phase"]; at: number };
}
interface QuestionSpeech {
  id: string;
  sessionId: string;
  requestId: string;
  state:
    | "dispatching"
    | "accepted"
    | "playing"
    | "completed"
    | "cancelled"
    | "failed"
    | "unknown";
  fingerprint: string;
  updatedAt?: string;
}
const speechReceiptSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  state: z.enum([
    "accepted",
    "playing",
    "completed",
    "cancelled",
    "failed",
    "unknown",
  ]),
  updatedAt: z.string().nullable().optional(),
});
const credentialsSchema = z.object({
  livekit_url: z.string().startsWith("wss://"),
  participant_token: z.string().min(40),
  remote_participant_identity: z.string().min(1),
});
export const mediaSessionId = (requestId: string) =>
  `ct_${hash(requestId).slice(0, 40)}`;
export class NativeTransport implements Transport {
  readonly mode = "live" as const;
  readonly messages: NativeMessages;
  readonly vault: Vault;
  private polling = false;
  retireSetupInvitation(input: SetupRetirementInput) {
    const pairing = this.store.get<Pairing>("pairing", input.pairingId);
    if (!pairing) throw new DomainError(409, "Setup pairing is unavailable.");
    this.guard(pairing);
    const b = this.config.binding;
    return retireSetupInvitation(
      this.store,
      {
        lineId: b.lineId,
        providerLineId: b.providerLineId,
        phone: b.phone,
        instanceId: b.instanceId,
        fingerprint: this.bindingFingerprint(),
      },
      input,
    );
  }
  constructor(
    readonly store: Store,
    readonly config: NativeTransportConfig,
    readonly request: typeof fetch = fetch,
    private readonly options: { readOnly?: boolean } = {},
  ) {
    for (const origin of [config.callsOrigin, config.mediaOrigin]) {
      const u = new URL(origin);
      if (
        u.protocol !== "https:" ||
        u.origin !== origin ||
        u.username ||
        u.password
      )
        throw new Error("Live service origins must be bare HTTPS.");
    }
    this.messages = new NativeMessages(store, config.binding, request, options);
    this.vault = new Vault(config.encryptionKey);
    if (!options.readOnly) this.guard();
    this.store.saveState(
      "native-binding-fingerprint",
      this.bindingFingerprint(),
    );
  }
  private guard(pairing?: Pairing) {
    if (this.options.readOnly)
      throw new DomainError(
        403,
        "Read-only transport cannot dispatch effects.",
      );
    const c = this.config,
      h = c.handoff;
    if (
      !c.enabled ||
      !h ||
      h.owner !== "clawdtime" ||
      h.sourceOwnerPaused !== true ||
      h.lineId !== c.binding.lineId ||
      h.providerLineId !== c.binding.providerLineId ||
      h.instanceId !== c.binding.instanceId ||
      h.phone !== c.binding.phone ||
      !h.identityEvidence?.trim() ||
      !h.sourcePauseEvidence?.trim() ||
      !Number.isFinite(h.checkedAt) ||
      h.checkedAt <= 0 ||
      h.checkedAt > Date.now() + 1000 ||
      !h.rollbackRecord ||
      !Number.isSafeInteger(h.baseline.sequence) ||
      h.baseline.sequence < 1 ||
      !h.baseline.eventId
    )
      throw new DomainError(
        503,
        "Live traffic requires verified exclusive line handoff and rollback record.",
      );
    if (
      pairing &&
      (pairing.lineId !== c.binding.lineId ||
        !c.testerAllowlist.includes(pairing.recipient) ||
        pairing.revokedAt !== undefined)
    )
      throw new DomainError(
        403,
        "Pairing is not authorized for the test line.",
      );
  }
  bindingFingerprint() {
    const c = this.config;
    return hash(
      JSON.stringify({
        binding: c.binding,
        projectId: c.projectId,
        projectKey: c.projectKey,
        callsOrigin: c.callsOrigin,
        mediaOrigin: c.mediaOrigin,
        mediaKey: c.mediaKey,
        handoff: c.handoff,
      }),
    );
  }
  /** GET-only: no cursor movement, line mutation, media allocation or capture. */
  async preflight(
    options: { requireIdle?: boolean } = {},
  ): Promise<TransportReadiness> {
    const checks = configurationChecks(this.config),
      now = Date.now();
    const add = (
      id: string,
      passed: boolean,
      message: string,
      nextAction?: string,
    ) =>
      checks.push({
        id,
        status: passed ? "pass" : "fail",
        message,
        ...(!passed && nextAction ? { nextAction } : {}),
      });
    const cursor = this.messages.cursor();
    const results = await Promise.allSettled([
      this.messages.verify(),
      (cursor ?? this.config.handoff?.baseline)
        ? this.messages.verifyAnchor(cursor ?? this.config.handoff.baseline)
        : Promise.reject(new Error("No handoff boundary.")),
      this.lineInventory(),
      this.media("/health"),
    ]);
    add(
      "native_identity",
      results[0].status === "fulfilled",
      results[0].status === "fulfilled"
        ? "Native provider, phone and instance exactly match the configured binding."
        : "Native identity or health could not be verified.",
      "Check the protected native binding and service health; do not enable a different line.",
    );
    const boundary =
      results[1].status === "fulfilled" &&
      !!cursor &&
      !!this.config.handoff?.baseline &&
      cursor.sequence >= this.config.handoff.baseline.sequence &&
      (cursor.sequence !== this.config.handoff.baseline.sequence ||
        cursor.eventId === this.config.handoff.baseline.eventId);
    add(
      "native_cursor",
      boundary,
      boundary
        ? "The committed cursor and retained provider anchor agree."
        : "A committed non-replaying native cursor is missing or inconsistent.",
      "Provision the exact approved boundary in standby, preserving existing cursors and receipts.",
    );
    let idle = false;
    const lines = results[2];
    if (lines.status === "fulfilled") {
      const line = lines.value,
        health = line.session_health;
      const exact =
        line.id === this.config.binding.lineId &&
        (line.phone_number == null ||
          line.phone_number === this.config.binding.phone) &&
        health?.line_id === this.config.binding.lineId &&
        health.identity_confirmed === true;
      add(
        "logical_identity",
        exact,
        exact
          ? "The exact logical line and confirmed worker identity match; private handoff evidence supplies the native inventory join."
          : "Calls logical line or confirmed worker identity does not match.",
        "Reconcile the exact logical/native inventory join; a display name is insufficient.",
      );
      idle = line.current_call_id === null && line.worker_occupied === false;
      const owned =
        typeof line.current_call_id === "string" &&
        this.store
          .all<CallSession>("call")
          .some(
            (c) =>
              c.providerCallId === line.current_call_id && c.state !== "ended",
          );
      add(
        "line_occupancy",
        idle || (!options.requireIdle && owned),
        idle
          ? "The selected line is idle."
          : owned
            ? "The line is occupied by this application's retained call."
            : "The selected line is busy or its occupancy is unverified.",
        "Wait for confirmed native cleanup; do not interrupt or compete with another owner.",
      );
      const heartbeat =
        typeof health?.last_heartbeat_at === "string"
          ? Date.parse(health.last_heartbeat_at)
          : NaN;
      add(
        "worker_heartbeat",
        Number.isFinite(heartbeat) &&
          heartbeat <= now + 1000 &&
          now - heartbeat <= 90000,
        "The exact Calls worker heartbeat must be recent.",
        "Restore worker connectivity; stale identity/readiness evidence cannot authorize a new call.",
      );
      const ready = health?.readiness;
      const audio =
        ready?.audio_ready === true ||
        (ready?.audio_ready === false &&
          Array.isArray(ready?.automatic?.checks) &&
          ready.automatic.checks.some(
            (c: unknown) =>
              !!c &&
              typeof c === "object" &&
              (c as Record<string, unknown>).id === "system_audio_capture" &&
              (c as Record<string, unknown>).outcome === "at_call_start",
          ));
      const capabilities =
        ready &&
        [
          "control_ready",
          "facetime_signed_in",
          "accessibility_ready",
          "screen_capture_ready",
          "video_ready",
          "production_media_ready",
        ].every((k) => ready[k] === true) &&
        audio;
      add(
        "calls_worker",
        !!capabilities &&
          (!idle ||
            (line.status === "available" && health?.status === "accepting")),
        capabilities
          ? "Worker declares outbound media readiness; deferred system audio still requires call-start verification."
          : "Worker media readiness is incomplete or unverified.",
        "Inspect worker readiness; do not treat a deferred audio capture check as physical audio evidence.",
      );
    } else {
      add(
        "logical_identity",
        false,
        "The exact Calls line inventory could not be verified.",
        "Check the project-scoped Calls credentials and logical line binding.",
      );
      add("line_occupancy", false, "Line occupancy could not be verified.");
      add("calls_worker", false, "Worker readiness could not be verified.");
      add(
        "worker_heartbeat",
        false,
        "Calls worker heartbeat could not be verified.",
      );
    }
    const media = results[3];
    const m = media.status === "fulfilled" ? media.value : undefined;
    add(
      "media_service",
      !!m &&
        m.service === "clawdtime-media" &&
        m.ok === true &&
        m.configured === true,
      "Independent ClawdTime media service readiness must be verified.",
      "Check the independent media deployment, provider configuration and protected media origin.",
    );
    add(
      "media_gateway",
      !!m && m.devicesConfigured === true && m.deviceGatewayConnected === true,
      "The paired-device gateway must be configured and connected.",
      "Start the independent outbound gateway; do not expose or silently arm the helper.",
    );
    const unknownNotices = this.store
      .all<{ id: string; state: string }>("notice")
      .filter((n) => n.state === "unknown");
    const retiredNotices = unknownNotices.filter((n) =>
      noticeRetirementValid(this.store, n, now),
    ).length;
    if (retiredNotices)
      checks.push({
        id: "obsolete_onboarding_delivery",
        status: "not_applicable",
        message: `${retiredNotices} obsolete onboarding notice(s) retain unknown delivery under an exact operator supersession audit; none may be retried.`,
      });
    const unknownEffects = this.store.effects("unknown");
    const retiredSetupInvitations = unknownEffects.filter((e) =>
      setupInvitationRetirementValid(this.store, e, now),
    ).length;
    if (retiredSetupInvitations)
      checks.push({
        id: "expired_setup_invitation_delivery",
        status: "not_applicable",
        message: `${retiredSetupInvitations} expired setup invitation(s) retain unknown delivery under an exact operator supersession audit; none may be retried.`,
      });
    const uncertain =
      unknownEffects.length -
      retiredSetupInvitations +
      this.store.all<CallSession>("call").filter((c) => c.state === "unknown")
        .length +
      unknownNotices.length -
      retiredNotices +
      this.store
        .all<{ state: string }>("lease")
        .filter((l) => l.state === "unknown").length +
      this.store
        .all<{ state: string }>("action")
        .filter((a) => ["unknown", "submitted", "running"].includes(a.state))
        .length;
    add(
      "local_recovery",
      uncertain === 0,
      uncertain === 0
        ? "No uncertain native or control outcomes block new work."
        : "Retained uncertain native or control outcomes require reconciliation.",
      "Inspect the original receipt IDs and cleanup evidence; do not reset state or retry effects.",
    );
    const report: TransportReadiness = {
      recovery: {
        unknownNoticeCount: unknownNotices.length,
        retiredObsoleteNoticeCount: retiredNotices,
        unknownEffectCount: unknownEffects.length,
        retiredSetupInvitationCount: retiredSetupInvitations,
        blockingUncertainCount: uncertain,
      },
      checkedAt: now,
      mode: "live",
      liveReady: checks.every(
        (c) => c.status === "pass" || c.status === "not_applicable",
      ),
      checks,
      bindingFingerprint: this.bindingFingerprint(),
    };
    this.store.saveState("native-preflight", report);
    this.store.saveState("native-line-idle", {
      checkedAt: now,
      idle,
      bindingFingerprint: report.bindingFingerprint,
    });
    return report;
  }
  private async lineInventory(): Promise<Record<string, any>> {
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const raw = await this.calls(`/api/v1/lines?limit=100&offset=${offset}`);
      const data = z
        .object({
          items: z.array(z.record(z.string(), z.unknown())).max(100),
          total: z.number().int().nonnegative(),
          limit: z.number().int().positive(),
          offset: z.number().int().nonnegative(),
        })
        .parse(raw.data);
      if (data.offset !== offset)
        throw new Error("Calls inventory pagination changed.");
      const matches = data.items.filter(
        (l) => l.id === this.config.binding.lineId,
      );
      if (matches.length > 1)
        throw new Error("Duplicate logical line identity.");
      if (matches[0]) return matches[0];
      if (data.items.length === 0 || offset + data.items.length >= data.total)
        break;
      offset += data.items.length;
    }
    throw new Error("Exact logical line not found in bounded inventory.");
  }
  async preflightDevice(pairing: Pairing): Promise<DeviceReadiness> {
    const checks: ReadinessCheck[] = [];
    const add = (
      id: string,
      ok: boolean,
      message: string,
      nextAction?: string,
    ) =>
      checks.push({
        id,
        status: ok ? "pass" : "fail",
        message,
        ...(!ok && nextAction ? { nextAction } : {}),
      });
    try {
      const raw = await this.media(
        `/devices/${encodeURIComponent(pairing.deviceId)}/readiness/${encodeURIComponent(pairing.memberId)}/${encodeURIComponent(pairing.displayId)}`,
      );
      const exact =
        raw.deviceId === pairing.deviceId &&
        raw.memberId === pairing.memberId &&
        String(raw.displayId) === pairing.displayId;
      add(
        "paired_device",
        exact && raw.available === true,
        "The exact paired device/member/display must be available.",
        "Check gateway enrollment and the intended Mac; do not substitute another device.",
      );
      add(
        "display",
        exact && raw.displayAttached === true,
        "The explicitly selected display must still be attached.",
        "Select the intended display locally and pair again if it changed.",
      );
      add(
        "screen_permission",
        exact && raw.screenPermission === true && raw.viewAllowed === true,
        "Screen Recording and this member's display-view permission must be granted.",
        "Grant Screen Recording and select this member/display in the local companion.",
      );
      add(
        "local_arm",
        exact && raw.armed === true,
        "Sharing must be explicitly enabled by the local Mac owner.",
        "Use local Enable after reviewing the paired session; doctor never arms or captures.",
      );
      checks.push({
        id: "control_permission",
        status: !pairing.allowControl
          ? "not_applicable"
          : exact &&
              raw.controlPermission === true &&
              raw.controlAllowed === true
            ? "pass"
            : "fail",
        message: pairing.allowControl
          ? "Accessibility and the member's display-control permission must be granted."
          : "This pairing authorizes viewing only.",
        ...(pairing.allowControl &&
        (!raw.controlPermission || !raw.controlAllowed)
          ? {
              nextAction:
                "Grant Accessibility and explicitly enable control for this member/display locally.",
            }
          : {}),
      });
    } catch {
      checks.push({
        id: "paired_device",
        status: "unknown",
        message: "Scoped helper readiness could not be read.",
        nextAction:
          "Check the independent gateway/helper and scoped readiness endpoint.",
      });
    }
    const report: DeviceReadiness = {
      checkedAt: Date.now(),
      deviceId: pairing.deviceId,
      memberId: pairing.memberId,
      displayId: pairing.displayId,
      bindingFingerprint: this.bindingFingerprint(),
      checks,
    };
    this.store.saveState(`device-readiness:${pairing.id}`, report);
    return report;
  }
  private async requireReady(pairing: Pairing, kind: "call" | "message") {
    const report = await this.preflight({ requireIdle: kind === "call" });
    const required = report.checks.filter(
      (c) =>
        kind === "call" ||
        (!c.id.startsWith("media_") && c.id !== "calls_worker"),
    );
    if (
      required.some((c) => c.status !== "pass" && c.status !== "not_applicable")
    )
      throw new PreflightBlocked(
        "Live transport preflight is blocked; inspect readiness before dispatch.",
      );
    if (kind === "call") {
      const device = await this.preflightDevice(pairing);
      if (
        device.checks.some(
          (c) => c.status !== "pass" && c.status !== "not_applicable",
        )
      )
        throw new PreflightBlocked(
          "Paired Mac readiness is blocked; no call was placed.",
        );
    }
  }
  async calls(path: string, body?: unknown, key?: string) {
    if (this.options.readOnly && body !== undefined)
      throw new DomainError(
        403,
        "Read-only transport cannot dispatch effects.",
      );
    return jsonRequest(
      this.config.callsOrigin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.projectKey}`,
          "X-Chert-Project-Id": this.config.projectId,
          "content-type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
    );
  }
  async media(path: string, body?: unknown) {
    if (this.options.readOnly && body !== undefined)
      throw new DomainError(
        403,
        "Read-only transport cannot dispatch effects.",
      );
    return jsonRequest(
      this.config.mediaOrigin + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.config.mediaKey}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      this.request,
    );
  }
  async mediaStatus(requestId: string) {
    const attention = this.store.get<AttentionRequest>("attention", requestId);
    if (!attention)
      throw new DomainError(404, "Attention request is unavailable.");
    const id = mediaSessionId(requestId),
      owned = this.store.get<MediaRecord>("media", id);
    const unavailable = (
      reason:
        | "not_allocated"
        | "binding_mismatch"
        | "media_not_found"
        | "invalid_status"
        | "media_unavailable",
    ) => ({ id, alive: false as const, state: "unavailable" as const, reason });
    if (!owned) return unavailable("not_allocated");
    if (owned.id !== id || owned.requestId !== attention.id)
      return unavailable("binding_mismatch");
    try {
      const result = mediaStatusSchema.safeParse(
        await this.media(`/sessions/${id}`),
      );
      if (!result.success || result.data.id !== id)
        return unavailable("invalid_status");
      return result.data;
    } catch (error) {
      return unavailable(
        error instanceof Error &&
          error.message === "Provider returned HTTP 404."
          ? "media_not_found"
          : "media_unavailable",
      );
    }
  }
  async call(attention: AttentionRequest, pairing: Pairing, effectId: string) {
    this.guard(pairing);
    await this.requireReady(pairing, "call");
    if (!this.messages.cursor())
      throw new DomainError(
        409,
        "Verified native event boundary is required before dialing.",
      );
    const id = mediaSessionId(attention.id),
      old = this.store.get<MediaRecord>("media", id);
    if (old) {
      if (old.requestId === attention.id && old.providerCallId)
        return { callId: old.providerCallId, accepted: true };
      throw new DomainError(
        409,
        "Existing media/call outcome requires reconciliation.",
      );
    }
    const record: MediaRecord = {
      id,
      requestId: attention.id,
      state: "preparing",
    };
    this.store.put("media", record);
    let phase: NotDialed["phase"] = "media_prepare";
    let dialSent = false;
    try {
      const media = await this.media("/sessions", {
        id,
        meetingId: attention.id,
        lineId: pairing.lineId,
        captions: true,
        screen: true,
      });
      if (
        media.id !== id ||
        media.silentPublisherReady !== true ||
        media.videoPublisherReady !== true
      )
        throw new Error("Media readiness not confirmed.");
      const credentials = credentialsSchema.parse(media.credentials);
      this.store.put("media", {
        ...record,
        state: "prepared",
        credentials: this.vault.seal(credentials),
      });
      phase = "pre_dial_check";
      const currentPairing = this.store.get<Pairing>("pairing", pairing.id);
      if (!currentPairing)
        throw new DomainError(403, "Pairing no longer exists.");
      this.guard(currentPairing);
      const current = this.store.get<AttentionRequest>(
        "attention",
        attention.id,
      );
      if (
        !current ||
        current.state !== "queued" ||
        current.deadline <= Date.now()
      )
        throw new DomainError(409, "Attention expired before dialing.");
      this.store.put("media", {
        ...record,
        state: "dialing",
        credentials: this.vault.seal(credentials),
      });
      // From here on the provider may have received the dial: any failure is unknown.
      dialSent = true;
      const response = await this.calls(
        "/api/v1/calls",
        {
          direction: "outbound",
          mode: "customer_managed",
          line_id: pairing.lineId,
          media: { audio: true, video: true },
          destination: pairing.recipient,
          destination_type: "phone",
          ...credentials,
        },
        effectId,
      );
      const call = z
        .object({ id: z.string().uuid(), line_id: z.string() })
        .parse(response.data);
      if (call.line_id !== pairing.lineId)
        throw new Error("Allocated call line mismatch.");
      this.store.put("media", {
        ...record,
        state: "allocated",
        credentials: this.vault.seal(credentials),
        providerCallId: call.id,
      });
      return { callId: call.id, accepted: true };
    } catch (e) {
      const current = this.store.get<MediaRecord>("media", id)!;
      if (!dialSent) {
        // No native dial was sent, so the human cannot have been called. The
        // unactivated media session self-closes on its activation timeout.
        this.store.put("media", {
          ...current,
          state: "closed",
          notDialed: { phase, at: Date.now() },
        });
        throw new NotDialed(
          e instanceof Error ? e.message : "Call preparation failed.",
          phase,
        );
      }
      this.store.put("media", { ...current, state: "unknown" });
      throw e;
    }
  }
  async message(pairing: Pairing, text: string, effectId: string) {
    this.guard(pairing);
    await this.requireReady(pairing, "message");
    return this.messages.send(pairing, text, effectId);
  }
  async endCall(callId: string, effectId: string) {
    const owned = this.store
      .all<MediaRecord>("media")
      .find((s) => s.providerCallId === callId);
    if (!owned) throw new DomainError(403, "Cannot end an unowned call.");
    this.store.put("media", { ...owned, state: "closing" });
    let mediaClosed = false;
    try {
      await this.media(`/sessions/${owned.id}/close`, {});
      mediaClosed = true;
    } catch {
      /* Native hangup must still be attempted when media is unavailable. */
    }
    await this.calls(
      `/api/v1/calls/${encodeURIComponent(callId)}/end`,
      { reason: "ClawdTime attention ended" },
      effectId,
    );
    this.store.saveState(`cleanup:${owned.id}`, {
      nativeEndRequested: true,
      mediaClosed,
      cleanupPending: true,
    });
    return {
      accepted: true,
      actionId: effectId,
      mediaClosed,
      cleanupPending: true,
    };
  }
  /** An unknown POST acknowledgement is never retried or fabricated. Only the
   * independently observed cleanup goal can be reconciled, using GET evidence. */
  private async reconcileEndedCall(
    session: MediaRecord,
    observe: (requestId: string, state: "ended") => unknown,
  ) {
    const effectId = `${session.requestId}:end`;
    const effect = this.store.effect(effectId),
      request = this.store.get<AttentionRequest>(
        "attention",
        session.requestId,
      ),
      call = this.store.get<CallSession>("call", session.id),
      pairing =
        request && this.store.get<Pairing>("pairing", request.pairingId);
    if (
      !effect ||
      effect.id !== effectId ||
      effect.kind !== "end_call" ||
      effect.state !== "unknown" ||
      !effect.payload ||
      typeof effect.payload !== "object" ||
      Array.isArray(effect.payload) ||
      !request ||
      !call ||
      !pairing ||
      !["closed", "closing"].includes(session.state) ||
      session.id !== mediaSessionId(request.id) ||
      session.requestId !== request.id ||
      !session.providerCallId ||
      call.id !== session.id ||
      call.requestId !== request.id ||
      call.pairingId !== pairing.id ||
      call.providerCallId !== session.providerCallId ||
      request.callId !== call.id ||
      request.pairingId !== pairing.id ||
      pairing.lineId !== this.config.binding.lineId ||
      ![
        `iMessage;-;${pairing.recipient}`,
        `any;-;${pairing.recipient}`,
      ].includes(pairing.conversationId) ||
      effect.payload.requestId !== request.id ||
      effect.payload.pairingId !== pairing.id ||
      effect.payload.callId !== session.providerCallId ||
      Object.keys(effect.payload).sort().join(",") !==
        "callId,pairingId,requestId"
    )
      return false;
    const auditId = `end-call-reconciliation:${effectId}`;
    if (this.store.event(auditId)) return false;
    const entityBody = (kind: string, id: string) =>
      this.store.query(
        "SELECT body FROM entities WHERE kind=? AND id=?",
        kind,
        id,
      )[0]?.body;
    const effectBody = () =>
      this.store.query("SELECT body FROM effects WHERE id=?", effectId)[0]
        ?.body;
    const original = {
      effect: effectBody(),
      request: entityBody("attention", request.id),
      pairing: entityBody("pairing", pairing.id),
      call: entityBody("call", call.id),
      media: entityBody("media", session.id),
    };
    const bindingFingerprint = this.bindingFingerprint();
    try {
      const response = await this.calls(
        `/api/v1/calls/${encodeURIComponent(session.providerCallId)}/events`,
      );
      const data = z
        .object({
          call_id: z.literal(session.providerCallId),
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
      const cleanup = data.events.find(
        (e) => e.source === "worker" && e.type === "cleanup_complete",
      );
      if (
        !cleanup ||
        data.events.filter((e) => e.id === cleanup.id).length !== 1
      )
        return false;
      const media = z
        .object({
          id: z.literal(session.id),
          alive: z.literal(false),
          state: z.literal("closed"),
        })
        .parse(await this.media(`/sessions/${session.id}`));
      return this.store.transaction(() => {
        if (
          effectBody() !== original.effect ||
          entityBody("attention", request.id) !== original.request ||
          entityBody("pairing", pairing.id) !== original.pairing ||
          entityBody("call", call.id) !== original.call ||
          entityBody("media", session.id) !== original.media ||
          this.bindingFingerprint() !== bindingFingerprint ||
          this.store.event(auditId)
        )
          return false;
        const reconciledAt = Date.now();
        const result = {
          accepted: true,
          actionId: effectId,
          callId: session.providerCallId,
          cleanupConfirmed: true,
          mediaClosed: true,
          cleanupPending: false,
          recovered: true,
          nativeEndAcknowledgementUnknown: true,
          auditId,
        };
        const audit = {
          version: 1,
          effectId,
          requestId: request.id,
          callId: call.id,
          providerCallId: session.providerCallId,
          originalEffect: effect,
          originalEffectBody: original.effect,
          bindingFingerprint,
          bindingHashes: Object.fromEntries(
            Object.entries(original).map(([k, v]) => [k, hash(String(v))]),
          ),
          nativeEvent: cleanup,
          mediaEvidence: media,
          reconciledAt,
          result,
        };
        this.store.recordEvent(auditId, hash(JSON.stringify(audit)), audit);
        if (call.state !== "ended") {
          observe(request.id, "ended");
          if (this.store.get<CallSession>("call", call.id)?.state !== "ended")
            throw new Error(
              "Cleanup observation did not settle the owned call.",
            );
        }
        if (session.state !== "closed")
          this.store.put<MediaRecord>("media", {
            id: session.id,
            requestId: request.id,
            providerCallId: session.providerCallId,
            state: "closed",
            ...(session.outcome ? { outcome: session.outcome } : {}),
          });
        const final: EffectReceipt = { ...effect, state: "done", result };
        const update = this.store.db
          .prepare("UPDATE effects SET body=? WHERE id=? AND body=?")
          .run(JSON.stringify(final), effectId, String(original.effect));
        if (update.changes !== 1)
          throw new Error("Cleanup receipt changed during reconciliation.");
        return true;
      });
    } catch {
      // Unavailable or contradictory evidence preserves the original unknown.
      return false;
    }
  }
  /** Exact read-only receipt lookup; never needs the original spoken text. */
  async speechStatus(
    request: AttentionRequest,
    pairing: Pairing,
    replyId: string,
  ) {
    const session = this.store.get<MediaRecord>("media", request.callId ?? "");
    const previous = this.store.get<QuestionSpeech>("speech", replyId);
    if (
      !session ||
      session.requestId !== request.id ||
      request.pairingId !== pairing.id ||
      (previous &&
        (previous.requestId !== request.id ||
          previous.sessionId !== session.id))
    )
      throw new DomainError(409, "Speech receipt binding is unavailable.");
    if (
      previous &&
      ["completed", "cancelled", "failed"].includes(previous.state)
    )
      return { state: previous.state as "completed" | "cancelled" | "failed" };
    try {
      const raw = await jsonRequest(
        `${this.config.mediaOrigin}/sessions/${session.id}/speech/${encodeURIComponent(replyId)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${this.config.mediaKey}` },
        },
        (url, init) =>
          this.request(url, { ...init, signal: AbortSignal.timeout(2000) }),
      );
      const receipt = speechReceiptSchema.parse(raw);
      if (receipt.id !== replyId || receipt.sessionId !== session.id)
        throw new Error("Speech receipt identity differs.");
      if (previous)
        this.store.put<QuestionSpeech>("speech", {
          ...previous,
          state: receipt.state,
          ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}),
        });
      return { state: receipt.state };
    } catch {
      return { state: "unknown" as const };
    }
  }
  /** Agent-authored speech uses one durable ID; after any attempted POST only GET may reconcile. */
  async speak(
    request: AttentionRequest,
    pairing: Pairing,
    replyId: string,
    text: string,
    reconcileOnly = false,
  ) {
    const session = this.store.get<MediaRecord>("media", request.callId ?? "");
    if (
      !session ||
      session.requestId !== request.id ||
      request.pairingId !== pairing.id
    )
      throw new DomainError(409, "Speech media binding is unavailable.");
    const fingerprint = hash(text);
    const claim = this.store.transaction(() => {
      const previous = this.store.get<QuestionSpeech>("speech", replyId);
      if (
        previous &&
        (previous.fingerprint !== fingerprint ||
          previous.requestId !== request.id ||
          previous.sessionId !== session.id)
      )
        throw new DomainError(409, "Speech identity changed.");
      const record: QuestionSpeech = previous ?? {
        id: replyId,
        sessionId: session.id,
        requestId: request.id,
        fingerprint,
        state: "dispatching",
      };
      if (!previous) {
        if (!reconcileOnly) this.guard(pairing);
        if (
          !reconcileOnly &&
          (session.state !== "active" ||
            pairing.revokedAt !== undefined ||
            request.deadline <= Date.now())
        )
          throw new DomainError(409, "Speech authorization is closed.");
        this.store.put("speech", record);
      }
      return { record, lookup: !!previous || reconcileOnly };
    });
    if (["completed", "cancelled", "failed"].includes(claim.record.state))
      return {
        state: claim.record.state as "completed" | "cancelled" | "failed",
      };
    try {
      const raw = claim.lookup
        ? await this.media(
            `/sessions/${session.id}/speech/${encodeURIComponent(replyId)}`,
          )
        : await this.media(`/sessions/${session.id}/speak`, {
            id: replyId,
            callId: session.id,
            text,
          });
      const receipt = speechReceiptSchema.parse(raw);
      if (receipt.id !== replyId || receipt.sessionId !== session.id)
        throw new Error("Speech receipt identity differs.");
      this.store.put<QuestionSpeech>("speech", {
        ...claim.record,
        state: receipt.state,
        ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}),
      });
      return { state: receipt.state };
    } catch {
      this.store.put<QuestionSpeech>("speech", {
        ...claim.record,
        state: "unknown",
      });
      return { state: "unknown" as const };
    }
  }
  private async question(session: MediaRecord) {
    const attention = this.store.get<AttentionRequest>(
      "attention",
      session.requestId,
    );
    const pairing =
      attention && this.store.get<Pairing>("pairing", attention.pairingId);
    if (
      !attention ||
      !pairing ||
      pairing.revokedAt !== undefined ||
      attention.responseId ||
      attention.deadline <= Date.now() ||
      !["ringing", "connected", "awaiting_input"].includes(attention.state)
    )
      return;
    const utteranceId = `${attention.id}:question`;
    const previous = this.store.get<QuestionSpeech>("speech", utteranceId);
    // Setup is already authorized in the originating chat. Do not narrate its
    // internal test question. Existing utterances still reconcile by their exact
    // receipt; omission is never permission to erase or repeat uncertain speech.
    if (
      !previous &&
      this.store
        .all<SetupTest>("setup_test")
        .some(
          (test) =>
            test.requestId === attention.id &&
            test.sessionId === attention.sessionId &&
            test.pairingId === attention.pairingId,
        )
    )
      return;
    if (
      previous &&
      ["completed", "cancelled", "failed"].includes(previous.state)
    )
      return;
    const text = `Your agent asks: ${attention.question}`
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 36)
      .join(" ")
      .slice(0, 280);
    const record: QuestionSpeech = previous ?? {
      id: utteranceId,
      sessionId: session.id,
      requestId: attention.id,
      state: "dispatching",
      fingerprint: hash(text),
    };
    // Commit before network dispatch. A crash/timeout can only trigger GET lookup,
    // even if no receipt can be found; it never grants permission to speak again.
    if (!previous) this.store.put("speech", record);
    try {
      const raw = previous
        ? await this.media(
            `/sessions/${session.id}/speech/${encodeURIComponent(utteranceId)}`,
          )
        : await this.media(`/sessions/${session.id}/speak`, {
            id: utteranceId,
            callId: session.id,
            text,
          });
      const receipt = speechReceiptSchema.parse(raw);
      if (receipt.id !== utteranceId || receipt.sessionId !== session.id)
        throw new Error("Speech receipt belongs to another request.");
      this.store.put<QuestionSpeech>("speech", {
        ...record,
        state: receipt.state,
        ...(receipt.updatedAt ? { updatedAt: receipt.updatedAt } : {}),
      });
    } catch {
      this.store.put<QuestionSpeech>("speech", { ...record, state: "unknown" });
      // Playback is supplementary: a provider outage must not terminate screen
      // viewing, native call cleanup or authenticated text feedback.
    }
  }
  async pollCalls(
    observe: (
      requestId: string,
      state:
        | "connected"
        | "declined"
        | "unanswered"
        | "disconnected"
        | "failed"
        | "ended",
      qualified?: boolean,
    ) => unknown,
    options: {
      cleanupOnly?: boolean;
      cleanupSource?: TerminationSource;
      observeOnly?: boolean;
      onTerminalPending?: (requestId: string) => void;
    } = {},
  ) {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const session of this.store
        .all<MediaRecord>("media")
        .filter(
          (s) =>
            !!s.providerCallId &&
            (s.state !== "closed" ||
              this.store.effect(`${s.requestId}:end`)?.state === "unknown"),
        )) {
        if (
          ["closed", "closing"].includes(session.state) &&
          this.store.effect(`${session.requestId}:end`)?.state === "unknown"
        ) {
          await this.reconcileEndedCall(session, observe);
          continue; // Reconciliation never repeats native end or media close POSTs.
        }
        if (
          options.cleanupOnly &&
          !this.store.effect(`${session.requestId}:end`)
        ) {
          const attention = this.store.get<AttentionRequest>(
            "attention",
            session.requestId,
          );
          if (attention) {
            const call = this.store.get<CallSession>("call", session.id);
            if (call)
              recordTerminationIntent(
                this.store,
                attention,
                call,
                options.cleanupSource ?? "cleanup_only",
                Date.now(),
              );
            this.store.putEffect({
              id: `${session.requestId}:end`,
              kind: "end_call",
              state: "pending",
              payload: {
                requestId: attention.id,
                pairingId: attention.pairingId,
                callId: session.providerCallId,
              },
              createdAt: Date.now(),
            });
          }
        }
        const response = await this.calls(
          `/api/v1/calls/${encodeURIComponent(session.providerCallId!)}/events`,
        );
        const data = z
          .object({
            call_id: z.string(),
            events: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                source: z.string(),
              }),
            ),
          })
          .parse(response.data);
        if (data.call_id !== session.providerCallId)
          throw new Error("Call events belong to another call.");
        // Recover only a provider ID already committed from an exact allocation receipt.
        // A lost allocation response without an ID remains unknown; never dial again.
        const effect = this.store.effect(`${session.requestId}:call`);
        if (
          effect?.state === "unknown" &&
          ["allocated", "active", "closing"].includes(session.state)
        ) {
          const attention = this.store.get<AttentionRequest>(
            "attention",
            session.requestId,
          );
          const call = this.store.get<CallSession>("call", session.id);
          if (
            attention &&
            call &&
            call.requestId === attention.id &&
            effect.payload.localCallId === session.id
          ) {
            this.store.transaction(() => {
              this.store.putEffect({
                ...effect,
                state: "done",
                result: {
                  accepted: true,
                  callId: session.providerCallId!,
                  recovered: true,
                },
              });
              this.store.put("call", {
                ...call,
                providerCallId: session.providerCallId,
                state: session.state === "active" ? "connected" : "ringing",
              });
              const pairing = this.store.get<Pairing>(
                "pairing",
                attention.pairingId,
              );
              const closed =
                options.cleanupOnly === true ||
                !pairing ||
                pairing.revokedAt !== undefined ||
                attention.deadline <= Date.now();
              this.store.put("attention", {
                ...attention,
                callId: call.id,
                state:
                  attention.state === "unknown"
                    ? closed
                      ? "expired"
                      : "ringing"
                    : attention.state,
              });
              if (closed && !this.store.effect(`${attention.id}:end`)) {
                recordTerminationIntent(
                  this.store,
                  attention,
                  call,
                  options.cleanupSource ?? "allocation_terminal",
                  Date.now(),
                );
                this.store.putEffect({
                  id: `${attention.id}:end`,
                  kind: "end_call",
                  state: "pending",
                  payload: {
                    requestId: attention.id,
                    pairingId: attention.pairingId,
                    callId: session.providerCallId,
                  },
                  createdAt: Date.now(),
                });
              }
            });
          }
        }
        const types = data.events
          .filter((e) => e.source === "worker")
          .map((e) => e.type);
        if (
          types.some((t) =>
            ["ended", "failed", "rejected", "cleanup_complete"].includes(t),
          )
        ) {
          if (options.observeOnly) {
            // Worker termination revokes control now, but does not prove media cleanup.
            // The coordinator queues ordinary durable cleanup; this read pass never POSTs.
            this.store.put("media", { ...session, state: "closing" });
            options.onTerminalPending?.(session.requestId);
            continue;
          }
          const attention = this.store.get<AttentionRequest>(
            "attention",
            session.requestId,
          );
          const call = this.store.get<CallSession>("call", session.id);
          if (attention && call)
            recordTerminationIntent(
              this.store,
              attention,
              call,
              "worker_terminal",
              Date.now(),
              null,
            );
          await this.media(`/sessions/${session.id}/close`, {});
          const outcome = types.includes("rejected")
            ? "declined"
            : types.includes("failed")
              ? "failed"
              : (session.outcome ?? "disconnected");
          this.store.put("media", { ...session, state: "closing", outcome });
          if (types.includes("cleanup_complete")) {
            observe(session.requestId, outcome);
            this.store.put("media", {
              id: session.id,
              requestId: session.requestId,
              state: "closed",
              providerCallId: session.providerCallId,
              outcome,
            });
          }
          continue;
        }
        const domain = this.store.get<CallSession>("call", session.id);
        if (!domain || domain.providerCallId !== session.providerCallId)
          continue; // receipt must commit first
        if (
          !options.cleanupOnly &&
          !options.observeOnly &&
          types.includes("bridge_ready") &&
          session.state === "allocated"
        ) {
          const attention = this.store.get<AttentionRequest>(
            "attention",
            session.requestId,
          );
          const pairing = attention
            ? this.store.get<Pairing>("pairing", attention.pairingId)
            : undefined;
          if (
            !attention ||
            !pairing ||
            pairing.revokedAt !== undefined ||
            attention.deadline <= Date.now() ||
            !["ringing", "queued", "connected", "awaiting_input"].includes(
              attention.state,
            )
          )
            continue;
          this.guard(pairing);
          observe(session.requestId, "connected", true);
          await this.media(`/sessions/${session.id}/activate`, {
            callId: session.id,
          });
          this.store.put("media", { ...session, state: "active" });
          await this.question(session);
        }
        if (
          !options.cleanupOnly &&
          !options.observeOnly &&
          session.state === "active"
        ) {
          await this.question(session);
          const health = await this.media(`/sessions/${session.id}`);
          if (health.id !== session.id || health.alive !== true) {
            const attention = this.store.get<AttentionRequest>(
              "attention",
              session.requestId,
            );
            if (attention)
              recordTerminationIntent(
                this.store,
                attention,
                domain,
                "media_unavailable",
                Date.now(),
                `${session.requestId}:media-failure-end`,
              );
            this.store.put("media", {
              ...session,
              state: "closing",
              outcome: "failed",
            });
            await this.endCall(
              session.providerCallId!,
              `${session.requestId}:media-failure-end`,
            );
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
