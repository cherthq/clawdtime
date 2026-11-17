import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type { JobBroker } from "../attention/jobs.js";
import type { AttachmentService } from "../attention/attachments.js";
import type {
  AgentSession,
  ConversationJob,
  DocumentCandidate,
  DocumentRootGrant,
  DocumentSelection,
  ExecutionResult,
  JobBinding,
  JobSource,
  Pairing,
  RunnerRequest,
} from "../contracts.js";
import {
  documentCandidateSchema,
  DOCUMENT_PREVIEW_MAX_BYTES,
} from "../document-contracts.js";
import { hash } from "../storage/security.js";

interface PreviewAsset extends JobBinding {
  id: string;
  candidate: DocumentCandidate;
  jobId: string;
  revision: number;
  bytes: Buffer;
  imageSha256: string;
  token: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}
/** Document access is a bounded read-only tool. It never grants desktop or arbitrary file execution. */
export class DocumentService {
  attachments?: AttachmentService;
  private assets = new Map<string, PreviewAsset>();
  constructor(
    readonly service: ClawdTime,
    readonly broker: JobBroker,
    readonly origin: string,
  ) {}

  binding(session: AgentSession): JobBinding {
    return {
      sessionId: session.id,
      pairingId: session.pairingId,
      memberId: this.service.pairing(session.pairingId).memberId,
    };
  }
  grant(binding: JobBinding): DocumentRootGrant {
    const s = this.service.store.get<AgentSession>(
      "session",
      binding.sessionId,
    );
    const p = this.service.pairing(binding.pairingId);
    if (!s || s.pairingId !== p.id || p.memberId !== binding.memberId)
      throw new DomainError(403, "Document session identity does not match.");
    this.service.assertExecutionAllowed(s);
    if (
      s.state === "stopped" ||
      !s.documentAccess ||
      s.documentAccess.readOnly !== true ||
      s.documentAccess.version !== 1 ||
      s.documentAccess.expiresAt <= this.service.clock() ||
      s.documentAccess.expiresAt > s.createdAt + 3600_000 ||
      s.protocolVersion !== 2 ||
      s.conversation?.runnerId !== "remote-documents" ||
      this.service.clock() - (s.lastSeenAt ?? s.createdAt) >= 20_000 ||
      (s.lastSeenAt ?? s.createdAt) > this.service.clock() + 1000
    )
      throw new DomainError(
        403,
        "The read-only document session is unavailable or expired.",
      );
    const id = `docgrant_${hash(s.id).slice(0, 40)}`;
    let grant = this.service.store.get<DocumentRootGrant>(
      "document_root_grant",
      id,
    );
    if (!grant) {
      grant = {
        ...binding,
        id,
        projectRoot: s.projectRoot,
        hostId: s.hostId,
        expiresAt: s.documentAccess.expiresAt,
        state: "active",
      };
      this.service.store.put("document_root_grant", grant);
    }
    if (
      grant.state !== "active" ||
      grant.expiresAt <= this.service.clock() ||
      grant.sessionId !== s.id ||
      grant.pairingId !== p.id ||
      grant.memberId !== p.memberId ||
      grant.projectRoot !== s.projectRoot ||
      grant.hostId !== s.hostId
    )
      throw new DomainError(403, "The local document grant has been revoked.");
    return grant;
  }
  context(binding: JobBinding) {
    const grant = this.grant(binding);
    const catalog = this.broker
      .list(binding)
      .filter(
        (j) =>
          j.kind === "document" &&
          j.state === "succeeded" &&
          j.result?.verification?.verified &&
          j.result.document?.operation === "discover",
      )
      .at(-1);
    const candidates = (catalog?.result?.document?.candidates ?? []).filter(
      (c) => c.grantId === grant.id,
    );
    this.refreshSelection(binding);
    const selectionId = this.service.store.state<string>(
      `document-selected:${binding.sessionId}`,
    );
    let selected: DocumentSelection | undefined;
    if (selectionId) {
      try {
        selected = this.selection(binding, selectionId);
      } catch {}
    }
    return {
      enabled: true,
      candidates,
      selected: selected?.candidate,
      selectionId: selected?.id,
      destination: "paired iMessage conversation",
      preview: "first page only",
    };
  }
  private invalidateSelection(binding: JobBinding) {
    this.service.store.saveState(
      `document-selected:${binding.sessionId}`,
      null,
    );
    for (const a of this.assets.values())
      if (a.sessionId === binding.sessionId) this.drop(a.id);
  }
  discover(binding: JobBinding, source: JobSource) {
    const grant = this.grant(binding);
    this.invalidateSelection(binding);
    return this.broker.submit(binding, source, {
      kind: "document",
      preference: "auto",
      instruction:
        "List supported documents in the explicitly selected read-only folder.",
      document: { operation: "discover", grantId: grant.id },
    });
  }
  preview(binding: JobBinding, source: JobSource, candidateId: string) {
    const grant = this.grant(binding);
    const candidate = this.context(binding).candidates.find(
      (c) => c.id === candidateId,
    );
    if (!candidate)
      throw new DomainError(
        409,
        "Choose a document from the current file list first.",
      );
    if (candidate.previewSupport !== "first_page")
      throw new DomainError(
        409,
        "This document cannot be previewed by the selected local host.",
      );
    this.invalidateSelection(binding);
    return this.broker.submit(binding, source, {
      kind: "document",
      preference: "auto",
      instruction:
        "Verify the selected document and render its first page without changing it.",
      document: { operation: "preview", grantId: grant.id, candidate },
    });
  }
  private refreshSelection(binding: JobBinding) {
    const grant = this.grant(binding);
    const latest = this.broker
      .list(binding)
      .filter(
        (j) =>
          j.kind === "document" &&
          j.result?.document?.operation === "preview" &&
          j.state === "succeeded" &&
          j.result.verification?.verified,
      )
      .at(-1);
    if (!latest) return;
    const asset = this.assets.get(latest.result!.document!.assetId!);
    if (
      !asset ||
      asset.expiresAt <= this.service.clock() ||
      asset.candidate.grantId !== grant.id ||
      asset.jobId !== latest.id ||
      asset.revision !== latest.revision
    )
      return;
    const id = `selection_${hash(`${latest.id}:${latest.revision}:${asset.id}`).slice(0, 40)}`;
    const existing = this.service.store.get<DocumentSelection>(
      "document_selection",
      id,
    );
    if (!existing)
      this.service.store.put("document_selection", {
        ...binding,
        id,
        grantId: grant.id,
        candidate: asset.candidate,
        previewJobId: latest.id,
        previewRevision: latest.revision,
        expiresAt: Math.min(asset.expiresAt, grant.expiresAt),
        sequence: latest.instructionSequence,
      } satisfies DocumentSelection);
    this.service.store.saveState(`document-selected:${binding.sessionId}`, id);
  }
  selection(binding: JobBinding, selectionId: string): DocumentSelection {
    const grant = this.grant(binding);
    const s = this.service.store.get<DocumentSelection>(
      "document_selection",
      selectionId,
    );
    if (
      !s ||
      s.sessionId !== binding.sessionId ||
      s.pairingId !== binding.pairingId ||
      s.memberId !== binding.memberId ||
      s.grantId !== grant.id ||
      s.expiresAt <= this.service.clock() ||
      this.service.store.state(`document-selected:${binding.sessionId}`) !==
        s.id
    )
      throw new DomainError(
        409,
        "Preview and select the exact document before sending it.",
      );
    const job = this.broker.status(binding, s.previewJobId);
    if (
      job.state !== "succeeded" ||
      job.revision !== s.previewRevision ||
      job.result?.verification?.verified !== true ||
      JSON.stringify(job.result.document?.candidate) !==
        JSON.stringify(s.candidate)
    )
      throw new DomainError(409, "The selected preview is no longer verified.");
    return s;
  }
  assertCurrent(
    binding: JobBinding,
    selectionId: string,
    candidate: DocumentCandidate,
  ) {
    const s = this.selection(binding, selectionId);
    if (
      JSON.stringify(s.candidate) !== JSON.stringify(candidate) ||
      this.service.store.state<{ active: boolean }>(
        `job-hold:${binding.sessionId}`,
      )?.active
    )
      throw new DomainError(
        409,
        "A newer instruction or document selection must be resolved first.",
      );
  }
  send(
    binding: JobBinding,
    source: JobSource,
    candidateId: string | undefined,
    userText: string,
  ) {
    if (!this.attachments)
      throw new DomainError(409, "Document sending is unavailable.");
    // Interpretation proposes a tool; the actual latest human turn must request sending.
    if (
      !/^(?:(?:please|okay|ok|yes)[,!. ]*)*(?:(?:can|could|would|will) you\s+)?(?:send|share|text)\b/i.test(
        userText.trim(),
      ) ||
      /\b(don['’]t|do not|never|not yet|wait|hold)\b/i.test(userText)
    )
      throw new DomainError(
        409,
        "Say send this document when you want it sent to your paired Messages conversation.",
      );
    const ctx = this.context(binding);
    if (!ctx.selectionId || (candidateId && candidateId !== ctx.selected?.id))
      throw new DomainError(
        409,
        "Preview and select that exact document before asking me to send it.",
      );
    const selection = this.selection(binding, ctx.selectionId);
    const normalized = (s: string) =>
      s
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .trim()
        .replace(/[.!?]+$/, "")
        .replace(/^["“]|["”]$/g, "")
        .trim();
    const reference = normalized(userText)
      .replace(
        /^(?:(?:please|okay|ok|yes)[,!. ]*)*(?:(?:can|could|would|will) you\s+)?(?:send|share|text)\s+/i,
        "",
      )
      .replace(
        /\s+(?:to me|to my (?:paired )?(?:imessage|messages)(?: conversation)?|to my phone|via imessage)(?: please)?$/i,
        "",
      )
      .replace(/^me\s+/, "")
      .replace(/\s+please$/, "")
      .trim();
    if (
      ![
        "it",
        "this",
        "that",
        "this one",
        "that one",
        "this document",
        "that document",
        "this file",
        "that file",
        "the selected document",
        "the selected file",
        "my resume",
        "my résumé",
        "the resume",
        "the résumé",
        normalized(selection.candidate.name),
      ].includes(reference)
    )
      throw new DomainError(
        409,
        "I can send the selected document only to your paired Messages conversation. Say send this document to me.",
      );
    const dispatch = this.attachments.enqueue(binding, source, {
      selectionId: selection.id,
      candidateId: selection.candidate.id,
      sha256: selection.candidate.sha256,
      recipient: "paired_imessage",
    });
    if (dispatch.state !== "awaiting_bytes")
      throw new DomainError(
        409,
        dispatch.state === "accepted"
          ? "That selected document was already submitted to Messages; no duplicate was sent."
          : "That send has a retained receipt. Check its status; it cannot be repeated automatically.",
      );
    try {
      const job = this.broker.submit(binding, source, {
        kind: "document",
        preference: "auto",
        instruction:
          "Read the exact approved document and transfer it once to the paired Messages conversation.",
        document: {
          operation: "prepare_transfer",
          grantId: selection.grantId,
          candidate: selection.candidate,
          transferId: dispatch.id,
        },
      });
      this.service.store.saveState(
        `document-transfer-job:${job.id}`,
        dispatch.id,
      );
      return job;
    } catch (error) {
      this.attachments.cancel(binding, dispatch.id);
      throw error;
    }
  }
  cancelJob(binding: JobBinding, jobId: string) {
    const transfer = this.service.store.state<string>(
      `document-transfer-job:${jobId}`,
    );
    if (transfer) this.attachments?.cancel(binding, transfer);
  }
  async upload(
    binding: JobBinding,
    request: RunnerRequest,
    input: {
      purpose: "preview" | "transfer";
      candidate: DocumentCandidate;
      transferId?: string;
    },
    bytes: Uint8Array,
    guard: () => void,
  ) {
    const grant = this.grant(binding),
      op = request.intent.document;
    const candidate = documentCandidateSchema.parse(input.candidate);
    if (
      request.intent.kind !== "document" ||
      !op ||
      op.grantId !== grant.id ||
      JSON.stringify(op.candidate) !== JSON.stringify(candidate) ||
      (input.purpose === "preview"
        ? op.operation !== "preview"
        : op.operation !== "prepare_transfer") ||
      input.transferId !== op.transferId
    )
      throw new DomainError(
        403,
        "Asset does not match the exact claimed document request.",
      );
    guard();
    if (input.purpose === "transfer") {
      if (!this.attachments || !op.transferId)
        throw new DomainError(409, "Attachment transport unavailable.");
      const dispatch = this.attachments.status(binding, op.transferId);
      if (JSON.stringify(dispatch.candidate) !== JSON.stringify(candidate))
        throw new DomainError(
          403,
          "Attachment approval differs from the selected file.",
        );
      this.attachments.provideBytes(binding, dispatch.id, bytes);
      const finished = await this.attachments.wait(
        binding,
        dispatch.id,
        30_000,
      );
      if (finished.state !== "accepted" || !finished.receipt)
        throw new DomainError(
          409,
          "Attachment outcome is not confirmed. Preserve the original receipt; do not retry.",
        );
      return {
        transferId: finished.id,
        verificationEvidenceId: hash(JSON.stringify(finished.receipt)),
      };
    }
    const image = Buffer.from(bytes);
    if (
      image.length < 33 ||
      image.length > DOCUMENT_PREVIEW_MAX_BYTES ||
      !image
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      image.subarray(12, 16).toString() !== "IHDR" ||
      image.readUInt32BE(16) < 1 ||
      image.readUInt32BE(20) < 1 ||
      image.readUInt32BE(16) > 4096 ||
      image.readUInt32BE(20) > 4096
    )
      throw new DomainError(
        400,
        "A bounded PNG first-page preview is required.",
      );
    if (this.assets.size >= 16)
      throw new DomainError(409, "Preview capacity reached.");
    const id = `preview_${hash(request.job.dispatchId!).slice(0, 40)}`;
    const imageSha256 = createHash("sha256").update(image).digest("hex");
    const previous = this.assets.get(id);
    if (previous) {
      if (previous.imageSha256 !== imageSha256)
        throw new DomainError(409, "Preview result identity changed.");
      return {
        assetId: id,
        verificationEvidenceId: hash(candidate.sha256 + imageSha256),
      };
    }
    const expiresAt = Math.min(this.service.clock() + 120_000, grant.expiresAt);
    const timer = setTimeout(
      () => this.drop(id),
      Math.max(1, expiresAt - this.service.clock()),
    );
    timer.unref();
    this.assets.set(id, {
      ...binding,
      id,
      candidate,
      jobId: request.job.id,
      revision: request.job.revision,
      bytes: image,
      imageSha256,
      token: randomBytes(32).toString("base64url"),
      expiresAt,
      timer,
    });
    return {
      assetId: id,
      verificationEvidenceId: hash(candidate.sha256 + imageSha256),
    };
  }
  validateResult(
    binding: JobBinding,
    request: RunnerRequest,
    result: ExecutionResult,
  ) {
    if (result.outcome !== "succeeded") return;
    const grant = this.grant(binding),
      doc = result.document,
      op = request.intent.document;
    if (
      !op ||
      !doc ||
      op.operation !== doc.operation ||
      !result.verification?.verified
    )
      throw new DomainError(
        409,
        "Document result does not match its operation.",
      );
    if (doc.operation === "discover") {
      if (
        !doc.candidates ||
        doc.candidates.some((c) => c.grantId !== grant.id) ||
        new Set(doc.candidates.map((c) => c.id)).size !== doc.candidates.length
      )
        throw new DomainError(
          409,
          "Document catalog contains an invalid binding.",
        );
    } else if (JSON.stringify(doc.candidate) !== JSON.stringify(op.candidate))
      throw new DomainError(
        409,
        "Document result differs from the chosen file.",
      );
    else if (doc.operation === "preview") {
      const asset = this.assets.get(doc.assetId!);
      if (
        !asset ||
        asset.sessionId !== binding.sessionId ||
        asset.jobId !== request.job.id ||
        asset.revision !== request.job.revision ||
        asset.expiresAt <= this.service.clock()
      )
        throw new DomainError(409, "Verified preview bytes are unavailable.");
    } else {
      const transfer = this.attachments?.status(binding, doc.transferId!);
      if (
        doc.transferId !== op.transferId ||
        transfer?.state !== "accepted" ||
        !transfer.receipt ||
        result.verification.method !== "attachment_receipt"
      )
        throw new DomainError(409, "An actual attachment receipt is required.");
    }
  }
  describe(
    job: ConversationJob,
    channel: "text" | "voice" = job.source.channel,
  ): string | undefined {
    if (job.kind !== "document") return;
    if (job.state !== "succeeded") return;
    const doc = job.result?.document;
    if (!doc || job.result?.verification?.verified !== true) return;
    if (doc.operation === "discover")
      return doc.candidates?.length
        ? `Found ${doc.candidates.length} document(s): ${doc.candidates
            .slice(0, 8)
            .map((c, i) => `${i + 1}. ${c.name.slice(0, 120)}`)
            .join(
              "; ",
            )}${doc.candidates.length > 8 ? "; additional files are available by name" : ""}. Which one should I preview?`
        : "No supported PDF, Word or Pages documents were found in the selected folder.";
    if (doc.operation === "prepare_transfer") {
      const receipt = this.attachments?.status(job, doc.transferId!);
      return receipt?.state === "accepted"
        ? `Messages accepted ${receipt.file.filename} for your paired conversation. Handset delivery is not yet confirmed.`
        : undefined;
    }
    this.refreshSelection(job);
    const asset = this.assets.get(doc.assetId!);
    if (!asset)
      return "That preview expired. Request a fresh preview before sending.";
    const link = `${this.origin}/document-preview#${asset.id}.${asset.token}`;
    return `First-page preview of ${doc.candidate!.name} is ready. ${channel === "text" ? link + " " : ""}Say send this document to send the exact original file to your paired Messages conversation.`;
  }
  publicAsset(id: string, token: string) {
    const asset = this.assets.get(id);
    if (!asset || asset.expiresAt <= this.service.clock())
      throw new DomainError(404, "Preview expired.");
    const a = Buffer.from(asset.token),
      b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new DomainError(404, "Preview unavailable.");
    this.grant(asset);
    return asset;
  }
  previewPolicy(binding: JobBinding, callId: string) {
    try {
      this.refreshSelection(binding);
      const id = this.service.store.state<string>(
        `document-selected:${binding.sessionId}`,
      );
      if (!id) return;
      const selection = this.selection(binding, id);
      const asset = [...this.assets.values()].find(
        (a) =>
          a.jobId === selection.previewJobId &&
          a.revision === selection.previewRevision,
      );
      if (!asset || asset.expiresAt <= this.service.clock()) return;
      return {
        version: 1,
        previewId: asset.id,
        sessionId: binding.sessionId,
        callId,
        artifactId: asset.candidate.id,
        sha256: asset.candidate.sha256,
        imageSha256: asset.imageSha256,
        label: asset.candidate.name.slice(0, 120),
        page: 1,
        pageCount: 1,
        expiresAt: new Date(asset.expiresAt).toISOString(),
      };
    } catch {
      return;
    }
  }
  mediaAsset(binding: JobBinding, callId: string, id: string) {
    const policy = this.previewPolicy(binding, callId);
    if (policy?.previewId !== id)
      throw new DomainError(404, "Selected document preview unavailable.");
    return this.assets.get(id)!;
  }
  stop(binding: JobBinding) {
    // Terminal Stop is idempotent and must still work after the grant expired.
    const s = this.service.store.get<AgentSession>(
      "session",
      binding.sessionId,
    );
    const p = this.service.store.get<Pairing>("pairing", binding.pairingId);
    if (
      !s ||
      !p ||
      !s.documentAccess ||
      s.pairingId !== binding.pairingId ||
      p.memberId !== binding.memberId
    )
      throw new DomainError(403, "Document session identity differs.");
    try {
      this.broker.cancelAll(binding, {
        channel: "text",
        eventId: `document-stop:${s.id}`,
      });
    } catch {}
    const id = `docgrant_${hash(s.id).slice(0, 40)}`;
    const grant = this.service.store.get<DocumentRootGrant>(
      "document_root_grant",
      id,
    );
    this.service.store.put<DocumentRootGrant>("document_root_grant", {
      ...(grant ?? {
        ...binding,
        id,
        projectRoot: s.projectRoot,
        hostId: s.hostId,
        expiresAt: s.documentAccess.expiresAt,
      }),
      state: "revoked",
    });
    for (const item of this.service.store.all<
      import("../attention/attachments.js").AttachmentDispatch
    >("attachment_dispatch"))
      if (
        item.sessionId === binding.sessionId &&
        item.pairingId === binding.pairingId &&
        item.memberId === binding.memberId
      )
        this.attachments?.cancel(binding, item.id);
    this.invalidateSelection(binding);
    return { stopped: true };
  }
  maintain() {
    for (const s of this.service.store.all<AgentSession>("session")) {
      if (!s.documentAccess) continue;
      const p = this.service.store.get<Pairing>("pairing", s.pairingId);
      if (!p) continue;
      const binding = {
        sessionId: s.id,
        pairingId: p.id,
        memberId: p.memberId,
      };
      try {
        this.grant(binding);
      } catch {
        this.stop(binding);
      }
    }
  }
  private drop(id: string) {
    const a = this.assets.get(id);
    if (a) {
      clearTimeout(a.timer);
      a.bytes.fill(0);
      this.assets.delete(id);
    }
  }
  close() {
    for (const id of this.assets.keys()) this.drop(id);
    this.attachments?.close();
  }
}
