import { z } from "zod";

/** Bounded diagnostics only; these codes never authorize replay. */
export const CAMERA_ERROR_CODES = [
  "camera_not_negotiated",
  "camera_invalid_command",
  "camera_identity_conflict",
  "camera_frame_stale",
  "camera_content_changed",
  "camera_presentation_changed",
  "camera_rate_limited",
  "camera_paused",
  "camera_rejected",
  "camera_authority_changed",
  "camera_authorization_required",
  "camera_source_mismatch",
  "camera_transport_failed",
] as const;
export const cameraErrorCodeSchema = z.enum(CAMERA_ERROR_CODES);
export type CameraErrorCode = z.infer<typeof cameraErrorCodeSchema>;

export class CameraOperationError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode) {
    super(
      "Camera operation was not confirmed; inspect the original operation without replaying it.",
    );
    this.code = cameraErrorCodeSchema.parse(code);
  }
}
