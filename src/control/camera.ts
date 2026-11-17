import { isDeepStrictEqual } from "node:util";
import {
  cameraCommandSchema,
  cameraReceiptSchema,
  cameraStatusSchema,
  type CameraStatus,
} from "../camera-contracts.js";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type { ControlCoordinator } from "./coordinator.js";
import type { ControlLease } from "../contracts.js";
import { localPolicySchema, type PolicyDevice } from "./execution.js";

/** Camera-only operations reuse viewing authority; they never acquire an executor. */
export class ScreenCamera {
  constructor(
    readonly service: ClawdTime,
    readonly control: ControlCoordinator,
    readonly enabled = false,
  ) {}
  private context(token: string, requestId: string) {
    const session = this.service.authenticateSession(token);
    const request = this.service.status(token, requestId);
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
      );
    const lease = this.service.store
      .all<ControlLease>("lease")
      .find((l) => l.requestId === requestId && l.state === "active");
    if (
      !lease ||
      lease.cameraVersion !== 1 ||
      !isDeepStrictEqual(lease.surface, session.screenCamera.surface)
    )
      throw new DomainError(409, "An authorized camera surface is required.");
    if (lease.mode === "view") this.control.checkView(lease.id, lease.memberId);
    else this.control.check(lease.id, lease.memberId);
    return { session, lease };
  }
  private async ready(token: string, requestId: string) {
    const before = this.context(token, requestId);
    const device = this.control.device as typeof this.control.device &
      Partial<PolicyDevice>;
    if (!device.cameraStatus || !device.cameraCommand || !device.readiness)
      throw new DomainError(409, "Camera peer is unsupported.");
    const local = localPolicySchema.parse(
      await device.readiness(
        before.lease.deviceId,
        before.lease.memberId,
        before.lease.displayId,
      ),
    );
    const after = this.context(token, requestId);
    if (
      !isDeepStrictEqual(before.lease, after.lease) ||
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
      throw new DomainError(409, "Fresh camera peer authorization required.");
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
      throw new DomainError(409, "Camera source binding mismatch.");
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
      throw new DomainError(409, "Camera frame is stale.");
    return result;
  }
  async status(token: string, requestId: string) {
    const before = await this.ready(token, requestId);
    const raw = await this.control.device.cameraStatus!(before.lease);
    const after = this.context(token, requestId);
    if (!isDeepStrictEqual(before.lease, after.lease))
      throw new DomainError(409, "Camera authority changed.");
    return this.validate(raw, after.lease);
  }
  async command(token: string, requestId: string, raw: unknown) {
    const command = cameraCommandSchema.parse(raw);
    const before = await this.ready(token, requestId);
    // Media serializes revision, frame, rate and dedupe checks with its frame lock.
    const receipt = cameraReceiptSchema.parse(
      await this.control.device.cameraCommand!(before.lease, command),
    );
    const after = this.context(token, requestId);
    if (
      !isDeepStrictEqual(before.lease, after.lease) ||
      receipt.commandId !== command.commandId
    )
      throw new DomainError(
        409,
        "Camera acknowledgement changed; read status before proceeding.",
      );
    return receipt;
  }
}
