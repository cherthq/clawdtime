import { z } from "zod";

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const documentIdentity = z.string().min(1).max(160);
export const documentMime = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.apple.pages",
]);
export const documentCandidateSchema = z
  .object({
    id: z.string().regex(/^doc_[a-f0-9]{64}$/),
    grantId: documentIdentity,
    name: z
      .string()
      .min(1)
      .max(180)
      .refine((s) => !/[\x00-\x1f\x7f/\\]/.test(s)),
    mimeType: documentMime,
    byteLength: z.number().int().positive().max(DOCUMENT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    previewSupport: z.enum(["first_page", "none"]),
  })
  .strict();
export const documentOperationSchema = z
  .object({
    operation: z.enum(["discover", "preview", "prepare_transfer"]),
    grantId: documentIdentity,
    candidate: documentCandidateSchema.optional(),
    transferId: documentIdentity.optional(),
  })
  .strict()
  .superRefine((x, c) => {
    if (
      (x.operation === "discover") === !!x.candidate ||
      (x.operation === "prepare_transfer") !== !!x.transferId ||
      (x.candidate && x.candidate.grantId !== x.grantId)
    )
      c.addIssue({
        code: "custom",
        message: "Document operation binding is invalid.",
      });
  });
export const documentResultSchema = z
  .object({
    operation: z.enum(["discover", "preview", "prepare_transfer"]),
    candidates: z.array(documentCandidateSchema).max(32).optional(),
    candidate: documentCandidateSchema.optional(),
    assetId: documentIdentity.optional(),
    transferId: documentIdentity.optional(),
  })
  .strict()
  .superRefine((x, c) => {
    const valid =
      x.operation === "discover"
        ? !!x.candidates && !x.candidate && !x.assetId && !x.transferId
        : x.operation === "preview"
          ? !!x.candidate && !!x.assetId && !x.candidates && !x.transferId
          : !!x.candidate && !!x.transferId && !x.candidates && !x.assetId;
    if (!valid)
      c.addIssue({
        code: "custom",
        message: "Document result binding is invalid.",
      });
  });
