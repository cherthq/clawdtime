import { z } from "zod";
import type { AgentSession, DocumentRootGrant } from "../../src/contracts.js";
import {
  documentCandidateSchema,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_PREVIEW_MAX_BYTES,
} from "../../src/document-contracts.js";
import { DocumentRunner, type DocumentAssetPort } from "./document-runner.js";
import { validateOrigin } from "./client.js";
import { canonicalProject } from "./state.js";

const grantSchema = z
  .object({
    id: z.string().min(1).max(160),
    sessionId: z.string().min(1),
    pairingId: z.string().min(1),
    memberId: z.string().min(1),
    projectRoot: z.string().min(1),
    hostId: z.string().min(1),
    expiresAt: z.number().finite(),
    state: z.enum(["active", "revoked"]),
  })
  .strict();

/** Local deterministic host; no model process, external send credentials or arbitrary upload URL. */
export async function createDocumentHost(
  session: AgentSession,
  rawOrigin: string,
  token: string,
  request: typeof fetch = fetch,
) {
  const origin = validateOrigin(rawOrigin);
  if (
    session.conversation?.runnerId !== "remote-documents" ||
    session.conversation.executionSession !== "api_managed" ||
    session.documentAccess?.version !== 1 ||
    session.documentAccess.readOnly !== true ||
    session.documentAccess.expiresAt <= Date.now() ||
    canonicalProject(session.projectRoot) !== session.projectRoot
  )
    throw new Error("Explicit current document session authority is required.");
  let stopped = false,
    stopPromise: Promise<boolean> | undefined;
  async function json(path: string, init?: RequestInit) {
    const response = await request(origin + path, {
      ...init,
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(4000),
    });
    if (!response.ok)
      throw new Error(
        "Document host request refused; preserve original receipts.",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Document response missing.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 128_000) {
        await reader.cancel();
        throw new Error("Document response exceeds bounds.");
      }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function valid(grant: DocumentRootGrant) {
    if (
      stopped ||
      grant.state !== "active" ||
      grant.sessionId !== session.id ||
      grant.pairingId !== session.pairingId ||
      grant.projectRoot !== session.projectRoot ||
      grant.hostId !== session.hostId ||
      grant.expiresAt !== session.documentAccess!.expiresAt ||
      grant.expiresAt <= Date.now()
    )
      throw new Error("Document root authority changed or expired.");
    return grant;
  }
  const original = valid(
    grantSchema.parse((await json("/api/documents/grant")).grant),
  );
  const guard = async () => {
    if (stopped) throw new Error("Local document Stop is active.");
    const current = valid(
      grantSchema.parse((await json("/api/documents/grant")).grant),
    );
    if (current.id !== original.id || current.memberId !== original.memberId)
      throw new Error("Document grant identity changed.");
  };
  const assets: DocumentAssetPort = {
    async upload(dispatchId, purpose, rawCandidate, bytes, transferId, signal) {
      await guard();
      const candidate = documentCandidateSchema.parse(rawCandidate);
      if (
        signal.aborted ||
        bytes.length >
          (purpose === "preview"
            ? DOCUMENT_PREVIEW_MAX_BYTES
            : DOCUMENT_MAX_BYTES)
      )
        throw new Error("Document upload stopped or exceeds bounds.");
      const metadata = Buffer.from(
        JSON.stringify({
          dispatchId,
          purpose,
          candidate,
          ...(transferId ? { transferId } : {}),
        }),
        "utf8",
      ).toString("base64url");
      // One attempt only. A lost response may follow an external attachment send.
      return z
        .object({
          assetId: z.string().min(1).max(160).optional(),
          transferId: z.string().min(1).max(160).optional(),
          verificationEvidenceId: z.string().min(1).max(160),
        })
        .strict()
        .parse(
          await json("/api/documents/assets", {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-ClawdTime-Document": metadata,
            },
            body: new Uint8Array(bytes),
            signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          }),
        );
    },
  };
  return {
    runner: new DocumentRunner(original, assets, guard),
    grant: original,
    stop() {
      stopped = true;
      stopPromise ??= json("/api/documents/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then(
        (result) => result?.stopped === true,
        () => false,
      );
      return stopPromise;
    },
  };
}
