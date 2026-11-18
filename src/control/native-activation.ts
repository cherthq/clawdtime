import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type {
  ActionReceipt,
  Pairing,
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  ExecutionOwnership,
} from "../contracts.js";
import {
  nativePresentationOperationSchema,
  nativePresentationObservationSchema,
  nativePresentationHostResultSchema,
  type NativePresentationOperation,
} from "../native-presentation-contracts.js";
import {
  productionNativeEnvelopeSchema,
  productionNativeReferenceSchema,
  type ProductionNativeEnvelope,
  type ProductionNativeRecord,
  type ProductionNativeRejectionReason,
} from "../production-native-contracts.js";
import { localPolicySchema, type PolicyDevice } from "./execution.js";
import type { ScreenCamera } from "./camera.js";

/** Narrow, durable activation authority. The installed helper remains the final input gate. */
export class NativeActivationCoordinator {
  private busy = new Set<string>();
  constructor(
    readonly service: ClawdTime,
    readonly camera: ScreenCamera,
    readonly options: {
      enabled: boolean;
      revision(requestId: string): {
        cursor: number;
        acknowledgedCursor: number;
        pendingDelivery: boolean;
      };
      assertClear(requestId: string): void;
    },
  ) {}
  private rejectPreparation(operationId: string, error: unknown) {
    // This is before beginDispatch: it proves no native input was submitted.
    // Preserve a bounded cause without storing arbitrary peer error text.
    const reasons: Record<string, ProductionNativeRejectionReason> = {
      "Native activation was not negotiated or enabled.":
        "activation_not_negotiated",
      "Exact current native ownership is required.": "ownership_changed",
      "Incoming speech temporarily holds new input.": "incoming_speech",
      "Another device input actor is unresolved.": "conflicting_input",
      "Native activation peer unavailable.": "peer_unavailable",
      "Helper-local native activation policy unavailable.":
        "local_policy_changed",
      "Camera frame is stale.": "camera_frame_stale",
      "Fresh stable native display required.": "camera_unavailable",
      "An authorized camera surface is required.": "camera_unavailable",
      "Fresh camera peer authorization required.": "camera_authority_changed",
      "Camera authority changed.": "camera_authority_changed",
      "Camera source binding mismatch.": "camera_authority_changed",
      "Original native authority changed or expired.": "authority_expired",
      "Native target changed.": "target_changed",
      "Target not prepared.": "target_changed",
    };
    const reason =
      error instanceof DomainError ||
      (error instanceof Error &&
        ["Native target changed.", "Target not prepared."].includes(
          error.message,
        ))
        ? (reasons[error.message] ?? "preflight_unavailable")
        : "preflight_unavailable";
    return this.service.nativeReservations.cancelPrepared(operationId, reason);
  }
  private identity(token: string | AgentSession, requestId: string) {
    const session =
      typeof token === "string"
        ? this.service.authenticateSession(token)
        : token;
    const request = this.service.store.get<AttentionRequest>(
      "attention",
      requestId,
    );
    if (!request || request.sessionId !== session.id)
      throw new DomainError(403, "Exact native activation session required.");
    return { session, request };
  }
  private context(
    token: string | AgentSession,
    requestId: string,
    operation: NativePresentationOperation,
  ) {
    const { session, request } = this.identity(token, requestId);
    if (
      !this.options.enabled ||
      session.capabilities.nativeActivationVersion !== 1 ||
      session.capabilities.livePresentationVersion !== 1 ||
      session.conversation ||
      session.documentAccess ||
      session.audioQualification ||
      session.screenCamera?.surface.kind !== "display"
    )
      throw new DomainError(
        409,
        "Native activation was not negotiated or enabled.",
      );
    const { lease } = this.camera.context(session, requestId);
    const pairing = this.service.pairing(request.pairingId);
    const call = this.service.store.get<CallSession>(
      "call",
      request.callId ?? "",
    );
    const owner = this.service.store.get<ExecutionOwnership>(
      "execution",
      requestId,
    );
    const revision = this.options.revision(requestId),
      now = this.service.clock();
    this.options.assertClear(requestId);
    const expected = {
      requestId,
      sessionId: session.id,
      leaseId: lease.id,
      epoch: owner?.epoch,
      cursor: revision.cursor,
      policyRevision: lease.policyRevision,
      displayId: Number(lease.displayId),
    };
    if (
      !isDeepStrictEqual(operation.expected, expected) ||
      !pairing.allowControl ||
      session.state !== "active" ||
      now - (session.lastSeenAt ?? session.createdAt) > 20000 ||
      (session.lastSeenAt ?? session.createdAt) > now + 1000 ||
      request.deadline <= now ||
      !["connected", "awaiting_input"].includes(request.state) ||
      call?.state !== "connected" ||
      !call.remoteParticipantQualified ||
      owner?.executor !== "native" ||
      owner.state !== "working" ||
      owner.sessionId !== session.id ||
      owner.policyRevision !== lease.policyRevision ||
      lease.executor !== "native" ||
      lease.executorEpoch !== owner.epoch ||
      lease.mode !== "view" ||
      lease.expiresAt <= now ||
      revision.pendingDelivery ||
      revision.cursor !== revision.acknowledgedCursor ||
      this.service.store.state(`view-stopped:${requestId}`) ||
      this.service.nativeReservations.hasUnresolvedDevice(
        pairing.deviceId,
        operation.operationId,
      )
    )
      throw new DomainError(409, "Exact current native ownership is required.");
    // App activation affects the whole device, including other selected displays.
    const deviceLeases = this.service.store
      .all<ControlLease>("lease")
      .filter((l) => l.deviceId === pairing.deviceId);
    if (
      deviceLeases.some((l) => l.state === "unknown") ||
      this.service.store
        .all<ActionReceipt>("action")
        .some(
          (a) =>
            deviceLeases.some((l) => l.id === a.leaseId) &&
            ["pending", "submitted", "unknown"].includes(a.state),
        ) ||
      this.service.store.all<ExecutionOwnership>("execution").some(
        (e) =>
          e.requestId !== requestId &&
          (() => {
            const r = this.service.store.get<AttentionRequest>(
              "attention",
              e.requestId,
            );
            const p =
              r && this.service.store.get<Pairing>("pairing", r.pairingId);
            return (
              p?.deviceId === pairing.deviceId ||
              deviceLeases.some((l) => l.requestId === e.requestId)
            );
          })() &&
          (e.state === "uncertain" ||
            (e.executor !== "none" && !["idle", "paused"].includes(e.state))),
      )
    )
      throw new DomainError(409, "Another device input actor is unresolved.");
    return { session, request, lease, pairing };
  }
  private async ready(
    token: string | AgentSession,
    requestId: string,
    operation: NativePresentationOperation,
  ) {
    const before = this.context(token, requestId, operation);
    const device = this.camera.control
      .device as typeof this.camera.control.device & Partial<PolicyDevice>;
    if (
      !device.readiness ||
      !device.nativePrepare ||
      !device.nativeDispatch ||
      !device.nativeReceipt
    )
      throw new DomainError(409, "Native activation peer unavailable.");
    const local = localPolicySchema.parse(
      await device.readiness(
        before.lease.deviceId,
        before.lease.memberId,
        before.lease.displayId,
      ),
    );
    this.context(token, requestId, operation);
    if (
      local.nativeActivationVersion !== 1 ||
      !local.armed ||
      !local.available ||
      !local.screenPermission ||
      !local.viewAllowed ||
      !local.controlAllowed ||
      local.controlPolicy === "view_only" ||
      !local.displayAttached ||
      !local.activeLease ||
      local.activeLeaseId !== before.lease.id ||
      local.policyRevision !== before.lease.policyRevision
    )
      throw new DomainError(
        409,
        "Helper-local native activation policy unavailable.",
      );
    const camera = await this.camera.status(token, requestId);
    const current = this.context(token, requestId, operation);
    if (
      camera.state !== "live" ||
      camera.moving ||
      camera.leaseId !== current.lease.id
    )
      throw new DomainError(409, "Fresh stable native display required.");
    return current;
  }
  status(token: string, requestId: string) {
    const { session } = this.identity(token, requestId);
    return {
      enabled:
        this.options.enabled &&
        session.capabilities.nativeActivationVersion === 1,
      operations: this.service.nativeReservations.all(requestId),
    };
  }
  receipt(token: string, requestId: string, operationId: string) {
    this.identity(token, requestId);
    const r = this.service.nativeReservations.get(operationId);
    if (!r || r.envelope.operation.expected.requestId !== requestId)
      throw new DomainError(404, "Unknown native operation.");
    return r;
  }
  private reference(token: string, requestId: string, raw: unknown) {
    const ref = productionNativeReferenceSchema.parse(raw),
      r = this.receipt(token, requestId, ref.operationId);
    if (r.envelope.fingerprint !== ref.fingerprint)
      throw new DomainError(409, "Native operation fingerprint changed.");
    return r;
  }
  async prepare(token: string, requestId: string, raw: unknown) {
    this.identity(token, requestId);
    const operation = nativePresentationOperationSchema.parse(raw),
      fingerprint = createHash("sha256")
        .update(JSON.stringify(operation))
        .digest("hex");
    const old = this.service.nativeReservations.get(operation.operationId);
    if (old) {
      const r = this.receipt(token, requestId, operation.operationId);
      if (r.envelope.fingerprint !== fingerprint)
        throw new DomainError(409, "Native operation ID already bound.");
      return r;
    }
    const c = this.context(token, requestId, operation),
      now = this.service.clock();
    const prior = this.service.nativeReservations.all(requestId).at(-1)
      ?.envelope.operation;
    if (
      prior &&
      (operation.generation < prior.generation ||
        (operation.generation === prior.generation &&
          (operation.sceneId !== prior.sceneId ||
            !isDeepStrictEqual(operation.window, prior.window))))
    )
      throw new DomainError(409, "A current scene generation is required.");
    const envelope: ProductionNativeEnvelope = {
      version: 1,
      operation,
      fingerprint,
      binding: {
        mediaSessionId: `ct_${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`,
        pairingId: c.pairing.id,
        deviceId: c.lease.deviceId,
        memberId: c.lease.memberId,
        expiresAt: Math.min(c.lease.expiresAt, now + 20000),
      },
    };
    this.service.nativeReservations.reserve(envelope);
    try {
      await this.ready(token, requestId, operation);
      const observation = nativePresentationObservationSchema.parse(
        await this.camera.control.device.nativePrepare!(c.lease, envelope),
      );
      this.authority(c.session, requestId, envelope);
      if (
        !isDeepStrictEqual(observation.window, operation.window) ||
        this.service.clock() - observation.observedAt > 2000 ||
        observation.observedAt > this.service.clock() + 250 ||
        (operation.action === "raise_window" && !observation.appActive)
      )
        throw new Error("Native target changed.");
      return this.service.nativeReservations.setPreparedObservation(
        operation.operationId,
        observation,
      );
    } catch (error) {
      return this.rejectPreparation(operation.operationId, error);
    }
  }
  authority(session: AgentSession, requestId: string, raw: unknown) {
    const envelope = productionNativeEnvelopeSchema.parse(raw),
      c = this.context(session, requestId, envelope.operation);
    const record = this.service.nativeReservations.get(
        envelope.operation.operationId,
      ),
      now = this.service.clock();
    if (
      !record ||
      !["prepared", "dispatching"].includes(record.phase) ||
      !isDeepStrictEqual(record.envelope, envelope) ||
      envelope.binding.expiresAt <= now ||
      envelope.binding.pairingId !== c.pairing.id ||
      envelope.binding.deviceId !== c.lease.deviceId ||
      envelope.binding.memberId !== c.lease.memberId ||
      envelope.binding.expiresAt > c.lease.expiresAt ||
      (record.phase === "dispatching" &&
        (!envelope.nativeExpiresAt ||
          envelope.nativeExpiresAt <= now ||
          envelope.nativeExpiresAt > now + 2000))
    )
      throw new DomainError(
        409,
        "Original native authority changed or expired.",
      );
    return envelope;
  }
  private validateResult(
    raw: unknown,
    record: ProductionNativeRecord,
    freshUI = true,
  ) {
    const r = nativePresentationHostResultSchema.parse(raw),
      t = r.terminalEvidence,
      e = record.envelope;
    if (
      r.operationId !== record.id ||
      (t &&
        (t.operationId !== record.id ||
          t.fingerprint !== e.fingerprint ||
          t.hostId !== "clawdtime-installed-native" ||
          t.completedAt < record.createdAt ||
          t.completedAt > this.service.clock() + 1000)) ||
      (["verified", "returned", "rejected"].includes(r.state) && !t) ||
      (r.state === "submitted" && t)
    )
      throw new Error("Native receipt mismatch.");
    if (
      r.state === "verified" &&
      (!r.observation ||
        !e.preparedObservation ||
        !isDeepStrictEqual(r.observation.window, e.operation.window) ||
        r.observation.processIdentity !==
          e.preparedObservation.processIdentity ||
        !isDeepStrictEqual(
          r.observation.windowBounds,
          e.preparedObservation.windowBounds,
        ) ||
        !r.observation.appActive ||
        !r.observation.windowFocused ||
        !r.observation.windowOnScreen ||
        (freshUI && this.service.clock() - r.observation.observedAt > 2000) ||
        r.observation.observedAt > this.service.clock() + 250)
    )
      throw new Error("Native result unverified.");
    return r;
  }
  async dispatch(token: string, requestId: string, raw: unknown) {
    let r = this.reference(token, requestId, raw);
    if (r.phase !== "prepared") return r;
    if (this.busy.has(r.envelope.binding.deviceId))
      throw new DomainError(409, "Native operation is busy.");
    this.busy.add(r.envelope.binding.deviceId);
    try {
      let c;
      try {
        c = await this.ready(token, requestId, r.envelope.operation);
        this.authority(c.session, requestId, r.envelope);
        if (!r.envelope.preparedObservation)
          throw new Error("Target not prepared.");
      } catch (error) {
        return this.rejectPreparation(r.id, error);
      }
      r = this.service.nativeReservations.beginDispatch(
        r.id,
        Math.min(r.envelope.binding.expiresAt, this.service.clock() + 2000),
        r.envelope.preparedObservation!,
      );
      try {
        const result = this.validateResult(
          await this.camera.control.device.nativeDispatch!(c.lease, r.envelope),
          r,
        );
        this.authority(c.session, requestId, r.envelope);
        return this.service.nativeReservations.finish(r.id, result);
      } catch {
        return this.service.nativeReservations.finish(r.id, {
          operationId: r.id,
          state: "uncertain",
          reason: "native_outcome_unconfirmed",
        });
      }
    } finally {
      this.busy.delete(r.envelope.binding.deviceId);
    }
  }
  cancel(token: string, requestId: string, raw: unknown) {
    const r = this.reference(token, requestId, raw);
    return this.service.nativeReservations.cancelPrepared(r.id);
  }
  async reconcile(token: string, requestId: string, raw: unknown) {
    const r = this.reference(token, requestId, raw);
    if (
      !["dispatching", "submitted", "uncertain"].includes(r.phase) ||
      this.busy.has(r.envelope.binding.deviceId)
    )
      return r;
    const lease = this.service.store.get<ControlLease>(
      "lease",
      r.envelope.operation.expected.leaseId,
    );
    if (!lease || !this.camera.control.device.nativeReceipt) return r;
    try {
      const result = this.validateResult(
        await this.camera.control.device.nativeReceipt(
          lease,
          r.id,
          r.envelope.fingerprint,
        ),
        r,
        false,
      );
      if (!result.terminalEvidence) return r;
      // Returned actor evidence can settle ownership after Stop; it never retroactively verifies UI.
      return this.service.nativeReservations.finish(r.id, {
        ...result,
        state: result.state === "rejected" ? "rejected" : "returned",
        reason: "host_terminal_reconciled_not_ui_verified",
      });
    } catch {
      return r;
    }
  }
}
