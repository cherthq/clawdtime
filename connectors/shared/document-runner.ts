import { createHash } from "node:crypto";
import type {
  DocumentCandidate,
  DocumentRootGrant,
  ExecutionResult,
  ExecutionRunner,
  RunnerEvent,
  RunnerRequest,
} from "../../src/contracts.js";
import {
  documentOperationSchema,
  documentCandidateSchema,
} from "../../src/document-contracts.js";
import { LocalDocuments } from "./local-documents.js";
import { withDocumentPreview } from "./document-preview.js";

export interface DocumentAssetPort {
  upload(
    dispatchId: string,
    purpose: "preview" | "transfer",
    candidate: DocumentCandidate,
    bytes: Buffer,
    transferId: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    assetId?: string;
    transferId?: string;
    verificationEvidenceId: string;
  }>;
}
type Preview = typeof withDocumentPreview;
/** Deterministic document operations on the explicitly selected local host. No execution agent. */
export class DocumentRunner implements ExecutionRunner {
  private readonly documents: LocalDocuments;
  private readonly seen = new Set<string>();
  private busy = false;
  constructor(
    readonly grant: DocumentRootGrant,
    private readonly assets: DocumentAssetPort,
    private readonly authorize: () => void | Promise<void>,
    private readonly preview: Preview = withDocumentPreview,
    private readonly clock = Date.now,
  ) {
    this.documents = new LocalDocuments(grant, authorize, clock);
  }
  capabilities() {
    return {
      id: "remote-documents",
      host: "local_documents" as const,
      version: "local-documents-v1",
      available:
        this.grant.state === "active" && this.grant.expiresAt > this.clock(),
      taskKinds: ["document" as const],
      nativeControl: "none" as const,
      customControl: false,
      cancellation: "cooperative" as const,
    };
  }
  async run(
    request: RunnerRequest,
    emit: (event: RunnerEvent) => void,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const dispatchId = request.job.dispatchId;
    const operation = documentOperationSchema.safeParse(
      request.intent.document,
    );
    const fail = (
      outcome: ExecutionResult["outcome"],
      summary: string,
    ): ExecutionResult => ({
      outcome,
      summary,
      unresolvedEffectIds:
        outcome === "unknown" && dispatchId ? [dispatchId] : [],
    });
    if (
      !dispatchId ||
      this.busy ||
      !operation.success ||
      request.intent.kind !== "document" ||
      request.job.kind !== "document" ||
      request.job.runnerId !== "remote-documents" ||
      request.projectRoot !== this.grant.projectRoot ||
      request.job.sessionId !== this.grant.sessionId ||
      request.job.pairingId !== this.grant.pairingId ||
      request.job.memberId !== this.grant.memberId ||
      operation.data.grantId !== this.grant.id ||
      !this.capabilities().available
    )
      return fail(
        "failed",
        "Document operation or local authority is unavailable.",
      );
    if (this.seen.has(dispatchId))
      return fail(
        "unknown",
        "Document dispatch already received; reconcile its original receipt.",
      );
    if (signal.aborted)
      return fail("canceled", "Document operation stopped before execution.");
    this.seen.add(dispatchId);
    this.busy = true;
    let uploaded = false;
    try {
      await this.authorize();
      if (signal.aborted)
        return fail("canceled", "Document operation stopped before execution.");
      emit({ type: "accepted" });
      emit({ type: "progress", stage: "observing" });
      const op = operation.data;
      if (op.operation === "discover") {
        const candidates = await this.documents.discover(signal);
        emit({ type: "progress", stage: "verifying" });
        return {
          outcome: "succeeded",
          summary: "Bounded local document discovery verified.",
          unresolvedEffectIds: [],
          verification: {
            verified: true,
            method: "document_digest",
            evidenceId: createHash("sha256")
              .update(JSON.stringify(candidates))
              .digest("hex"),
          },
          document: { operation: "discover", candidates },
        };
      }
      return await this.documents.withVerifiedDocument(
        { candidateId: op.candidate!.id, sha256: op.candidate!.sha256 },
        signal,
        async (candidate, bytes, guard) => {
          if (
            JSON.stringify(documentCandidateSchema.parse(candidate)) !==
            JSON.stringify(op.candidate)
          )
            throw new Error("Candidate metadata changed.");
          const upload = async (asset: Buffer) => {
            await guard();
            if (signal.aborted) throw new Error("Stopped before upload.");
            uploaded = true;
            const receipt = await this.assets.upload(
              dispatchId,
              op.operation === "preview" ? "preview" : "transfer",
              candidate,
              asset,
              op.transferId,
              signal,
            );
            if (
              !receipt.verificationEvidenceId ||
              (op.operation === "preview"
                ? !receipt.assetId || !!receipt.transferId
                : receipt.transferId !== op.transferId || !!receipt.assetId)
            )
              throw new Error(
                "Document asset receipt does not match operation.",
              );
            emit({ type: "progress", stage: "verifying" });
            return {
              outcome: "succeeded" as const,
              summary:
                op.operation === "preview"
                  ? "First-page document preview verified."
                  : "Exact selected document transfer acknowledged.",
              unresolvedEffectIds: [],
              verification: {
                verified: true,
                method:
                  op.operation === "preview"
                    ? ("document_digest" as const)
                    : ("attachment_receipt" as const),
                evidenceId: receipt.verificationEvidenceId,
              },
              document: {
                operation: op.operation,
                candidate,
                ...(op.operation === "preview"
                  ? { assetId: receipt.assetId }
                  : { transferId: receipt.transferId }),
              },
            };
          };
          return op.operation === "preview"
            ? this.preview(candidate, bytes, signal, guard, upload)
            : upload(bytes);
        },
      );
    } catch {
      return uploaded
        ? fail(
            "unknown",
            "Document upload or transfer outcome requires its original receipt; do not retry.",
          )
        : fail(
            signal.aborted ? "canceled" : "failed",
            signal.aborted
              ? "Document operation stopped with no upload attempted."
              : "Document verification or preview failed before upload.",
          );
    } finally {
      this.busy = false;
    }
  }
}
