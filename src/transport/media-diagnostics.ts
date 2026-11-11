import { z } from "zod";

// Match media/screen_diagnostics.py. Unknown fields are stripped at every level;
// diagnostic strings are categories, bounded identifiers, or timestamps only.
const phase = z.enum([
  "prepared",
  "notice_playing",
  "notice_completed",
  "waiting_selection",
  "selection_received",
  "lease_create",
  "lease_renew",
  "frame_request",
  "viewing",
  "policy_unavailable",
  "stopped",
  "closed",
  "video_unavailable",
]);
const reason = z.enum([
  "authorization_expired",
  "previous_release_unconfirmed",
  "helper_stopped",
  "gateway_unavailable",
  "video_unavailable",
  "backend_unavailable",
  "policy_removed",
  "frame_unavailable",
  "frame_invalid",
  "frame_stale",
  "frame_dimensions",
  "lease_refused",
]);
const timestamp = z.string().max(40).datetime({ offset: true });
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/);
const httpStatus = z.number().int().min(100).max(599);
const gatewayResult = z.object({
  phase: z.enum(["lease_create", "lease_renew", "frame_request"]),
  at: timestamp,
  durationMs: z.number().int().min(0).max(999999),
  httpStatus: httpStatus.optional(),
  error: z
    .enum(["timeout", "connection", "invalid_response", "other"])
    .optional(),
});
export const mediaStatusSchema = z.object({
  id: z.string().regex(/^ct_[a-f0-9]{40}$/),
  alive: z.boolean(),
  state: z.enum([
    "preparing",
    "prepared",
    "active",
    "closing",
    "closed",
    "interrupted",
  ]),
  captions: z
    .object({
      enabled: z.boolean(),
      state: z.enum([
        "connecting",
        "reconnecting",
        "unavailable",
        "ended",
        "paused",
        "listening",
      ]),
      failed: z.boolean(),
    })
    .optional(),
  screen: z
    .object({
      leaseId: identifier.nullable(),
      deviceId: identifier.nullable(),
      displayId: z.number().int().min(1).max(4294967295).nullable(),
      mode: z.enum(["view", "control"]).nullable(),
      frameId: identifier.nullable(),
      capturedAt: timestamp.nullable(),
      state: z.enum(["stopped", "unavailable", "viewing"]),
    })
    .optional(),
  screenDiagnostics: z
    .object({
      version: z.literal(1),
      phase,
      updatedAt: timestamp,
      framesReceived: z.number().int().min(0).max(999999999),
      videoFramesEmitted: z.number().int().min(0).max(999999999),
      noticeStartedAt: timestamp.optional(),
      noticeCompletedAt: timestamp.optional(),
      selectionReceivedAt: timestamp.optional(),
      leaseCreateStartedAt: timestamp.optional(),
      firstFrameRequestedAt: timestamp.optional(),
      firstFrameAt: timestamp.optional(),
      lastFrameAt: timestamp.optional(),
      firstScreenVideoAt: timestamp.optional(),
      lastScreenVideoAt: timestamp.optional(),
      closedAt: timestamp.optional(),
      screenVideoObserved: z.boolean().optional(),
      lastGatewayHTTPStatus: httpStatus.optional(),
      terminalReason: reason.optional(),
      lastFailure: z
        .object({
          phase,
          reason,
          at: timestamp,
          httpStatus: httpStatus.optional(),
        })
        .optional(),
      lastGatewayResult: gatewayResult.optional(),
      lastGatewayFailure: gatewayResult.optional(),
    })
    .optional(),
});
