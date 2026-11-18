import { isDeepStrictEqual } from "node:util";
import { CameraOperationError } from "../camera-errors.js";
import {
  cameraCommandSchema,
  cameraReceiptSchema,
  cameraStatusSchema,
  type CameraStatus,
} from "../camera-contracts.js";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type { ControlCoordinator } from "./coordinator.js";
import type { AgentSession, ControlLease } from "../contracts.js";
import { localPolicySchema, type PolicyDevice } from "./execution.js";

/** A successful renewal extends validity without changing the bound authority. */
function sameCameraAuthority(before: ControlLease, after: ControlLease) {
  return (
    after.expiresAt >= before.expiresAt &&
    isDeepStrictEqual({ ...before, expiresAt: after.expiresAt }, after)
  );
}

/** Camera-only operations reuse viewing authority; they never acquire an executor. */
export class ScreenCamera {
  constructor(
    readonly service: ClawdTime,
    readonly control: ControlCoordinator,
    readonly enabled = false,
  ) {}
  context(token: string | AgentSession, requestId: string) {
    const session =
      typeof token === "string"
        ? this.service.authenticateSession(token)
        : token;
    this.service.assertExecutionAllowed(session);
    const request =
      typeof token === "string"
        ? this.service.status(token, requestId)
        : this.service.store.get<import("../contracts.js").AttentionRequest>(
            "attention",
            requestId,
          );
    if (!request) throw new DomainError(404, "Unknown attention request.");
    if (request.sessionId !== session.id)
      throw new DomainError(403, "Exact session required.");
    if (
      !this.enabled ||
      session.protocolVersion !== 2 ||
      !session.screenCamera ||
      session.capabilities.screenCameraVersion !== 1 ||
      session.documentAccess ||
      session.audioQualification
    )
      throw new DomainError(
        409,
        "Screen camera is not enabled for this session.",
        "camera_not_negotiated",
      );
    const lease = this.service.store
      .all<ControlLease>("lease")
      .find((l) => l.requestId === requestId && l.state === "active");
    if (
      !lease ||
      lease.cameraVersion !== 1 ||
      !isDeepStrictEqual(lease.surface, session.screenCamera.surface)
    )
      throw new DomainError(
        409,
        "An authorized camera surface is required.",
        "camera_authorization_required",
      );
    if (lease.mode === "view") this.control.checkView(lease.id, lease.memberId);
    else this.control.check(lease.id, lease.memberId);
    return { session, lease };
  }
  private async ready(token: string | AgentSession, requestId: string) {
    const before = this.context(token, requestId);
    const device = this.control.device as typeof this.control.device &
      Partial<PolicyDevice>;
    if (!device.cameraStatus || !device.cameraCommand || !device.readiness)
      throw new DomainError(
        409,
        "Camera peer is unsupported.",
        "camera_not_negotiated",
      );
    const local = await this.peer(async () =>
      localPolicySchema.parse(
        await device.readiness!(
          before.lease.deviceId,
          before.lease.memberId,
          before.lease.displayId,
        ),
      ),
    );
    const after = this.context(token, requestId);
    if (
      !sameCameraAuthority(before.lease, after.lease) ||
      local.cameraVersion !== 1 ||
      !local.armed ||
      !local.available ||
      !local.screenPermission ||
      !local.viewAllowed ||
      !local.displayAttached ||
      !local.activeLease ||
      local.activeLeaseId !== after.lease.id ||
      local.policyRevision !== after.lease.policyRevision
    )
      throw new DomainError(
        409,
        "Fresh camera peer authorization required.",
        "camera_authorization_required",
      );
    return after;
  }
  private validate(status: unknown, lease: ControlLease): CameraStatus {
    const result = cameraStatusSchema.parse(status);
    if (
      result.sessionId !== lease.sessionId ||
      result.deviceId !== lease.deviceId ||
      result.leaseId !== lease.id ||
      !isDeepStrictEqual(result.surface, lease.surface)
    )
      throw new DomainError(
        409,
        "Camera source binding mismatch.",
        "camera_source_mismatch",
      );
    const now = this.service.clock();
    if (
      result.state === "live" &&
      (!result.sourceFrameId ||
        !result.geometryGeneration ||
        !result.contentRevision ||
        !result.source ||
        result.capturedAt === null ||
        result.capturedAt > now + 250 ||
        now - result.capturedAt > 2000)
    )
      throw new DomainError(
        409,
        "Camera frame is stale.",
        "camera_frame_stale",
      );
    return result;
  }
  private async peer<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code =
        error instanceof CameraOperationError
          ? error.code
          : "camera_transport_failed";
      throw new DomainError(
        code === "camera_transport_failed" ? 502 : 409,
        "Camera operation was not confirmed; inspect the original operation without replaying it.",
        code,
      );
    }
  }
  async status(token: string | AgentSession, requestId: string) {
    const before = await this.ready(token, requestId);
    const raw = await this.peer(() =>
      this.control.device.cameraStatus!(before.lease),
    );
    const after = this.context(token, requestId);
    if (!sameCameraAuthority(before.lease, after.lease))
      throw new DomainError(
        409,
        "Camera authority changed.",
        "camera_authority_changed",
      );
    return this.validate(raw, after.lease);
  }
  async command(token: string | AgentSession, requestId: string, raw: unknown) {
    const command = cameraCommandSchema.parse(raw);
    const before = await this.ready(token, requestId);
    // Media serializes revision, frame, rate and dedupe checks with its frame lock.
    const receipt = cameraReceiptSchema.parse(
      await this.peer(() =>
        this.control.device.cameraCommand!(before.lease, command),
      ),
    );
    const after = this.context(token, requestId);
    if (
      !sameCameraAuthority(before.lease, after.lease) ||
      receipt.commandId !== command.commandId
    )
      throw new DomainError(
        409,
        "Camera acknowledgement changed; read status before proceeding.",
        "camera_authority_changed",
      );
    return receipt;
  }
}
