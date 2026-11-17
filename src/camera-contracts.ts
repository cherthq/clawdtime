import { z } from "zod";

/** Independent implementation. Camera coordinates never grant OS-input authority. */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const sequence = z.number().int().nonnegative().safe();
const finite = z.number().finite();
const unit = finite.min(0).max(1);
export const cameraRectSchema = z
  .object({
    x: unit,
    y: unit,
    width: finite.min(0.01).max(1),
    height: finite.min(0.01).max(1),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1.000000001 && r.y + r.height <= 1.000000001,
    "Rectangle must fit the source.",
  );
export const cameraSurfaceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("display"),
      id: z
        .string()
        .regex(/^[1-9][0-9]{0,9}$/)
        .refine((v) => Number(v) <= 0xffffffff),
      displayId: z.number().int().min(1).max(0xffffffff),
    })
    .strict()
    .refine((s) => Number(s.id) === s.displayId, "Display identity mismatch."),
  z
    .object({
      kind: z.literal("window"),
      id: z
        .string()
        .regex(/^[1-9][0-9]{0,9}$/)
        .refine((v) => Number(v) <= 0xffffffff),
      displayId: z.number().int().min(1).max(0xffffffff),
      ownerPid: z.number().int().positive().max(0x7fffffff),
    })
    .strict(),
]);
export const cameraSelectionSchema = z
  .object({ version: z.literal(1), surface: cameraSurfaceSchema })
  .strict();
const label = z
  .string()
  .min(1)
  .max(160)
  .refine((s) => !/[\p{Cc}\p{Cs}]/u.test(s));
export const cameraAnnotationSchema = z
  .object({
    id,
    kind: z.enum(["pointer", "arrow", "rectangle", "highlight", "label"]),
    rect: cameraRectSchema,
    text: label.optional(),
    ttlMs: z.number().int().min(100).max(10000),
  })
  .strict()
  .refine((a) => a.kind !== "label" || !!a.text, "A label requires text.");
const envelope = {
  version: z.literal(1),
  commandId: id,
  expectedRevision: sequence,
  sourceFrameId: id,
  geometryGeneration: id,
};
export const cameraCommandSchema = z.discriminatedUnion("op", [
  z
    .object({
      ...envelope,
      op: z.literal("focus_region"),
      rect: cameraRectSchema,
      durationMs: z.number().int().min(0).max(1500).default(450),
      automatic: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal("zoom_out"),
      factor: finite.min(1).max(8).default(2),
      durationMs: z.number().int().min(0).max(1500).default(450),
    })
    .strict(),
  ...(["overview", "pin", "unpin", "freeze", "resume", "clear"] as const).map(
    (op) => z.object({ ...envelope, op: z.literal(op) }).strict(),
  ),
  z
    .object({
      ...envelope,
      op: z.literal("annotation_upsert"),
      annotation: cameraAnnotationSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal("annotation_remove"),
      annotationId: id,
    })
    .strict(),
  z
    .object({
      ...envelope,
      op: z.literal("context"),
      text: label,
      ttlMs: z.number().int().min(100).max(10000),
    })
    .strict(),
]);
export const presentationReferenceSchema = z
  .object({
    revision: sequence,
    geometryGeneration: id,
    sourceFrameId: id,
  })
  .strict();
export const cameraSourceSchema = z
  .object({
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    originX: finite.min(-100000).max(100000),
    originY: finite.min(-100000).max(100000),
    pointWidth: finite.positive().max(32768),
    pointHeight: finite.positive().max(32768),
    displayOriginX: finite.min(-100000).max(100000),
    displayOriginY: finite.min(-100000).max(100000),
    displayPointWidth: finite.positive().max(32768),
    displayPointHeight: finite.positive().max(32768),
  })
  .strict()
  .refine(
    (s) => s.width * s.height <= 32_000_000,
    "Source exceeds pixel budget.",
  );
// A selected window has its own pixel boundary. WindowServer may place it partly
// offscreen without changing that identity. Native capture still enforces the
// selected display anchor/lifecycle; selected-window fallback input is disabled.
function fitsDisplay(s: z.infer<typeof cameraSourceSchema>) {
  return (
    s.originX >= s.displayOriginX &&
    s.originY >= s.displayOriginY &&
    s.originX + s.pointWidth <= s.displayOriginX + s.displayPointWidth + 0.01 &&
    s.originY + s.pointHeight <= s.displayOriginY + s.displayPointHeight + 0.01
  );
}
export const cameraFrameSchema = z
  .object({
    version: z.literal(1),
    surface: cameraSurfaceSchema,
    geometryGeneration: id,
    contentRevision: id,
    source: cameraSourceSchema,
  })
  .strict()
  .refine(
    (v) => v.surface.kind === "window" || fitsDisplay(v.source),
    "Display source must fit authorized display.",
  );
export const cameraStatusSchema = z
  .object({
    version: z.literal(1),
    sessionId: id,
    deviceId: id,
    leaseId: id,
    revision: sequence,
    state: z.enum(["live", "paused", "unavailable"]),
    surface: cameraSurfaceSchema,
    sourceFrameId: id.nullable(),
    capturedAt: finite.nonnegative().nullable(),
    geometryGeneration: id.nullable(),
    contentRevision: id.nullable(),
    crop: cameraRectSchema,
    source: cameraSourceSchema.nullable(),
    output: z
      .object({
        width: z.number().int().min(1).max(1920),
        height: z.number().int().min(1).max(1080),
        viewport: z
          .object({
            x: finite.nonnegative(),
            y: finite.nonnegative(),
            width: finite.positive(),
            height: finite.positive(),
          })
          .strict(),
      })
      .strict()
      .refine(
        (o) =>
          o.viewport.x + o.viewport.width <= o.width &&
          o.viewport.y + o.viewport.height <= o.height,
        "Viewport must fit output.",
      ),
    pinned: z.boolean(),
    moving: z.boolean(),
    annotations: z
      .array(
        cameraAnnotationSchema.safeExtend({ expiresAt: finite.nonnegative() }),
      )
      .max(16),
    context: z
      .object({ text: label, expiresAt: finite.nonnegative() })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.source === null || v.surface.kind === "window" || fitsDisplay(v.source),
    "Display source must fit authorized display.",
  );
export const cameraReceiptSchema = z
  .object({
    version: z.literal(1),
    commandId: id,
    revision: sequence,
    state: z.enum(["accepted", "superseded"]),
  })
  .strict();
export type CameraSelection = z.infer<typeof cameraSelectionSchema>;
export type CameraCommand = z.infer<typeof cameraCommandSchema>;
export type CameraFrame = z.infer<typeof cameraFrameSchema>;
export type CameraStatus = z.infer<typeof cameraStatusSchema>;
export type CameraReceipt = z.infer<typeof cameraReceiptSchema>;
export type PresentationReference = z.infer<typeof presentationReferenceSchema>;
