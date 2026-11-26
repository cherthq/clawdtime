import { z } from "zod";
import { presentationSceneWindowSchema } from "./presentation-scene-contracts.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const sequence = z.number().int().nonnegative().safe();
export const nativePresentationWindowSchema =
  presentationSceneWindowSchema.refine(
    (window) =>
      ["com.apple.finder", "com.apple.TextEdit"].includes(window.appId),
    "The local native review supports only Finder and TextEdit.",
  );
export const nativePresentationAuthoritySchema = z
  .object({
    requestId: id,
    sessionId: id,
    leaseId: id,
    epoch: sequence.min(1),
    cursor: sequence,
    policyRevision: z.number().int().positive().safe(),
    displayId: z.number().int().positive().max(0xffffffff),
  })
  .strict();
export const nativePresentationOperationSchema = z
  .object({
    version: z.literal(1),
    operationId: id,
    sceneId: id,
    generation: sequence,
    action: z.enum(["activate_app", "raise_window"]),
    window: nativePresentationWindowSchema,
    expected: nativePresentationAuthoritySchema,
  })
  .strict()
  .refine(
    (operation) => operation.window.displayId === operation.expected.displayId,
    "Target must belong to the authorized display.",
  );
export const nativePresentationObservationSchema = z
  .object({
    window: nativePresentationWindowSchema,
    observedAt: z.number().finite().nonnegative(),
    processIdentity: id,
    windowBounds: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict(),
    appActive: z.boolean(),
    windowFocused: z.boolean(),
    windowOnScreen: z.boolean(),
  })
  .strict();
export const nativePresentationTerminalSchema = z
  .object({
    receiptId: id,
    operationId: id,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    hostId: id,
    completedAt: z.number().finite().nonnegative(),
  })
  .strict();
export const nativePresentationHostResultSchema = z
  .object({
    operationId: id,
    state: z.enum([
      "rejected",
      "submitted",
      "returned",
      "verified",
      "uncertain",
    ]),
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
    terminalEvidence: nativePresentationTerminalSchema.optional(),
    observation: nativePresentationObservationSchema.optional(),
  })
  .strict();
export type NativePresentationOperation = z.infer<
  typeof nativePresentationOperationSchema
>;
export type NativePresentationAuthority = z.infer<
  typeof nativePresentationAuthoritySchema
>;
export type NativePresentationObservation = z.infer<
  typeof nativePresentationObservationSchema
>;
export type NativePresentationHostResult = z.infer<
  typeof nativePresentationHostResultSchema
>;

/** Fixed diagnostic vocabulary; never return native exception text. */
export const nativeQualificationReasonSchema = z.enum([
  "qualification_unavailable",
  "invalid_operation",
  "native_stopped",
  "native_busy",
  "native_request_expired_or_invalid",
  "invalid_request",
  "binding_changed",
  "target_unavailable",
  "accessibility_permission_missing",
  "screen_permission_missing",
  "display_inactive",
  "window_outside_display",
  "session_forced_unavailable",
  "session_missing",
  "session_off_console",
  "session_login_incomplete",
  "session_locked",
  "cg_list_unavailable",
  "cg_list_bound",
  "cg_window_missing",
  "cg_owner_changed",
  "cg_bounds_unavailable",
  "cg_geometry_changed",
  "cg_geometry_ambiguous",
  "app_unavailable",
  "app_terminated",
  "app_bundle_changed",
  "app_launch_identity_unavailable",
  "ax_windows_unavailable",
  "ax_window_bound",
  "ax_read_deadline",
  "ax_title_unavailable",
  "ax_geometry_unavailable",
  "ax_title_changed",
  "ax_minimized_or_unavailable",
  "ax_target_missing",
  "ax_target_ambiguous",
  "broker_authority_shape",
  "broker_authority_binding",
  "broker_authority_expired",
  "broker_authority_unavailable",
  "media_capability_disabled",
  "media_stopped",
  "media_not_started",
  "media_selection_missing",
  "media_lease_retired",
  "media_executor_mismatch",
  "media_session_mismatch",
  "media_lease_mismatch",
  "media_epoch_mismatch",
  "media_epoch_unapplied",
  "media_policy_mismatch",
  "media_display_mismatch",
  "media_display_type_mismatch",
  "media_camera_missing",
  "media_camera_not_live",
  "media_frame_missing",
  "native_transport_unavailable",
  "native_response_unavailable",
  "native_response_mismatch",
  "observation_unavailable",
  "prepared_target_changed",
  "qualification_limit",
]);
