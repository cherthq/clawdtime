import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { mediaSessionId } from "../src/transport/native.js";
import { JobBroker } from "../src/attention/jobs.js";
import { AttachmentService } from "../src/attention/attachments.js";
import { DocumentService } from "../src/control/documents.js";
import {
  JobConversation,
  type ConversationModel,
  type ProposedIntent,
} from "../src/control/job-conversation.js";
import { RemoteExecutionRunner } from "../src/control/remote-runner.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { createApp } from "../src/app.js";
import type {
  DocumentCandidate,
  CallSession,
  ExecutionResult,
  RunnerRequest,
} from "../src/contracts.js";
import type {
  AttachmentPort,
  AttachmentReceipt,
} from "../src/transport/attachments.js";
const pdf = Buffer.from("%PDF-1.7\nSYNTHETIC RESUME\n%%EOF"),
  sha = createHash("sha256").update(pdf).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const attachmentId = "att_" + "a".repeat(32),
  messageId = "00000000-0000-4000-8000-000000000001";
const settle = () => new Promise<void>((r) => setImmediate(r));
const fixtures: {
  documents: DocumentService;
  broker: JobBroker;
  attachments: AttachmentService;
  store: Store;
}[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.documents.close();
    const stops = [f.broker.stop(), f.attachments.stop()];
    await vi.runAllTimersAsync();
    await Promise.all(stops);
    f.store.close();
  }
  vi.useRealTimers();
});
function fixture() {
  let now = 100000,
    event = 0;
  const store = new Store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(store, transport, { clock: () => now });
  const invite = service.createPairingInvite({
    memberId: "human",
    recipient: "+15550000001",
    lineId: "line",
    conversationId: "iMessage;-;+15550000001",
    deviceId: "mac",
    displayId: "1",
  });
  const pair = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: false,
  });
  const registration = {
    adapter: "codex" as const,
    adapterVersion: "fixture",
    externalSessionId: "document-fixture",
    projectRoot: "/disposable",
    hostId: "fixture-host",
    protocolVersion: 2 as const,
    conversation: {
      version: 1 as const,
      runnerId: "remote-documents",
      executionSession: "api_managed" as const,
    },
    documentAccess: {
      version: 1 as const,
      readOnly: true as const,
      expiresAt: 1000000,
    },
    capabilities: { polling: true, cooperativePause: true },
  };
  const agent = service.registerSession(pair.token, registration),
    binding = {
      sessionId: agent.session.id,
      pairingId: pair.pairing.id,
      memberId: "human",
    };
  const remote = new RemoteExecutionRunner(service, true, "remote-documents"),
    broker = new JobBroker(service, [remote]),
    documents = new DocumentService(service, broker, "http://fixture");
  const grant = documents.grant(binding),
    candidate: DocumentCandidate = {
      id: "doc_" + "b".repeat(64),
      grantId: grant.id,
      name: "Synthetic Resume.pdf",
      mimeType: "application/pdf",
      byteLength: pdf.length,
      sha256: sha,
      previewSupport: "first_page",
    };
  const port: AttachmentPort = {
    stage: vi.fn(async (_p, _f, _b, before) => {
      before();
      return { attachmentId };
    }),
    send: vi.fn(async (p, _f, _s, before) => {
      before({ sequence: 1, eventId: "fixture-anchor" });
      return {
        attachmentId,
        messageId,
        providerLineId: "provider-line",
        recipient: p.recipient,
        evidence: "send_response" as const,
      };
    }),
    reconcile: vi.fn(async () => undefined),
  };
  const attachments = new AttachmentService(service, port, documents);
  documents.attachments = attachments;
  const base = {
    reply: "Working on the requested document.",
    jobId: null,
    instruction: null,
    kind: null,
    target: null,
    verification: null,
  };
  const model: ConversationModel = {
    propose: async ({ text }) =>
      ({
        ...base,
        action: text.startsWith("find")
          ? "discover_documents"
          : text.startsWith("preview")
            ? "preview_document"
            : "send_document",
        candidateId: text.startsWith("preview") ? candidate.id : null,
      }) as ProposedIntent,
  };
  const frontend = new JobConversation(service, broker, model, documents),
    control = new ControlCoordinator(store, new SimulatedDevice());
  const app = createApp(service, control, new HumanRouter(service, control), {
    origin: "http://fixture",
    simulation: true,
    mediaToken: "synthetic-media-token-32-characters-minimum",
    conversation: frontend,
    documentRunner: remote,
    documents,
  });
  const api = (path: string, body?: unknown, token = agent.token) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const turn = async (text: string) => {
    const r = await api("/api/conversation/turn", {
      eventId: `turn-${++event}`,
      text,
    });
    expect(r.status).toBe(200);
    return r.json() as Promise<any>;
  };
  const claim = async () => {
    await settle();
    const r = await api("/api/executor/next", { eventId: `poll-${++event}` });
    expect(r.status).toBe(200);
    const dispatch = (await r.json()).dispatch as RunnerRequest;
    expect(dispatch).toBeDefined();
    expect(
      (
        await api("/api/executor/events", {
          dispatchId: dispatch.job.dispatchId,
          event: { type: "accepted" },
        })
      ).status,
    ).toBe(200);
    return dispatch;
  };
  const finish = async (
    request: RunnerRequest,
    document: ExecutionResult["document"],
    method: "document_digest" | "attachment_receipt" = "document_digest",
  ) => {
    const result: ExecutionResult = {
      outcome: "succeeded",
      summary: "Synthetic verified operation",
      unresolvedEffectIds: [],
      verification: {
        verified: true,
        method,
        evidenceId: "synthetic-evidence",
      },
      document,
    };
    const r = await api("/api/executor/result", {
      dispatchId: request.job.dispatchId,
      result,
    });
    await settle();
    return r;
  };
  const upload = (
    request: RunnerRequest,
    purpose: "preview" | "transfer",
    data: Uint8Array = purpose === "preview" ? png : pdf,
    changes: Record<string, unknown> = {},
    token = agent.token,
  ) =>
    app.request("/api/documents/assets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "X-ClawdTime-Document": Buffer.from(
          JSON.stringify({
            dispatchId: request.job.dispatchId,
            purpose,
            candidate,
            ...(purpose === "transfer"
              ? { transferId: request.intent.document?.transferId }
              : {}),
            ...changes,
          }),
        ).toString("base64url"),
      },
      body: Uint8Array.from(data),
    });
  const discover = async () => {
    await turn("find my resume");
    const r = await claim();
    expect(
      (await finish(r, { operation: "discover", candidates: [candidate] }))
        .status,
    ).toBe(200);
    return r;
  };
  const preview = async (image = png) => {
    await discover();
    await turn("preview the listed document");
    const r = await claim(),
      up = await upload(r, "preview", image);
    expect(up.status).toBe(200);
    const result = await up.json();
    expect(
      (
        await finish(r, {
          operation: "preview",
          candidate,
          assetId: result.assetId,
        })
      ).status,
    ).toBe(200);
    const ctx = documents.context(binding);
    expect(ctx.selectionId).toBeDefined();
    const report = documents.describe(broker.status(binding, r.job.id))!;
    const cap = /document-preview#([^ ]+)/.exec(report)![1]!;
    const [assetId, token] = cap.split(".");
    return {
      request: r,
      assetId: assetId!,
      token: token!,
      selectionId: ctx.selectionId!,
    };
  };
  const f = {
    store,
    transport,
    service,
    pair,
    agent,
    registration,
    binding,
    remote,
    broker,
    documents,
    grant,
    candidate,
    port,
    attachments,
    frontend,
    app,
    api,
    turn,
    claim,
    finish,
    upload,
    discover,
    preview,
    advance: (ms: number) => (now += ms),
  };
  remote.ready(binding, {
    version: "deterministic-fixture",
    projectRoot: registration.projectRoot,
    externalSessionId: registration.externalSessionId,
  });
  fixtures.push(f);
  return f;
}
describe("document conversation and authenticated asset integration", () => {
  it("discovers, previews and sends through real contracts with one provider receipt and no duplicate", async () => {
    const f = fixture(),
      preview = await f.preview();
    const page = await f.app.request(
      `/document-previews/${preview.assetId}/image`,
      { headers: { authorization: `Bearer ${preview.token}` } },
    );
    expect(page.status).toBe(200);
    expect(Buffer.from(await page.arrayBuffer())).toEqual(png);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const sent = await f.turn("send this document");
    expect(sent.job?.kind).toBe("document");
    expect(sent.reply).toContain("queued");
    expect(
      f.store.state<{ active: boolean }>(`job-hold:${f.binding.sessionId}`)
        ?.active,
    ).toBe(false);
    const request = await f.claim(),
      up = await f.upload(request, "transfer");
    expect(up.status).toBe(200);
    const ack = await up.json();
    expect(ack.transferId).toBe(request.intent.document!.transferId);
    expect(
      (
        await f.finish(
          request,
          {
            operation: "prepare_transfer",
            candidate: f.candidate,
            transferId: ack.transferId,
          },
          "attachment_receipt",
        )
      ).status,
    ).toBe(200);
    expect(f.broker.status(f.binding, request.job.id).state).toBe("succeeded");
    expect(
      f.documents.describe(f.broker.status(f.binding, request.job.id)),
    ).toContain("Handset delivery is not yet confirmed");
    expect(
      (await f.api(`/api/documents/transfers/${ack.transferId}`)).status,
    ).toBe(200);
    const dispatches = f.store.all("attachment_dispatch");
    const jobs = f.broker.list(f.binding);
    expect((await f.turn("send this document")).job).toBeUndefined();
    expect(f.store.all("attachment_dispatch")).toEqual(dispatches);
    expect(f.broker.list(f.binding)).toEqual(jobs);
    expect(f.port.send).toHaveBeenCalledTimes(1);
    expect(f.transport.calls).toHaveLength(0);
  });
  it("accepts bounded binary previews larger than JSON limits and rejects non-document binary POSTs", async () => {
    const f = fixture(),
      image = Buffer.concat([png, Buffer.alloc(40000)]),
      preview = await f.preview(image);
    const response = await f.app.request(
      `/document-previews/${preview.assetId}/image`,
      { headers: { authorization: `Bearer ${preview.token}` } },
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(image.length);
    expect(
      (
        await f.app.request("/api/conversation/turn", {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.agent.token}`,
            "content-type": "application/octet-stream",
          },
          body: Uint8Array.from(png),
        })
      ).status,
    ).toBe(415);
  });
  it("cannot send without a current selected preview or accept preview success without actual bytes", async () => {
    const f = fixture();
    expect((await f.turn("send this document")).job).toBeUndefined();
    await f.discover();
    await f.turn("preview this document");
    const request = await f.claim();
    expect(
      (
        await f.finish(request, {
          operation: "preview",
          candidate: f.candidate,
          assetId: "invented",
        })
      ).status,
    ).toBe(409);
    expect(f.documents.context(f.binding).selected).toBeUndefined();
    expect(f.port.stage).not.toHaveBeenCalled();
  });
  it("refuses another recipient instead of silently sending to the paired human", async () => {
    const f = fixture();
    await f.preview();
    const jobs = f.broker.list(f.binding);
    const result = await f.turn("send this document to Bob");
    expect(result.job).toBeUndefined();
    expect(f.broker.list(f.binding)).toEqual(jobs);
    expect(f.store.all("attachment_dispatch")).toHaveLength(0);
    expect(f.port.stage).not.toHaveBeenCalled();
  });
  it("refuses changed source digest and cross-session asset upload before any external effect", async () => {
    const f = fixture();
    await f.preview();
    await f.turn("send this document");
    const request = await f.claim();
    expect(
      (await f.upload(request, "transfer", Buffer.from("%PDF-CHANGED"))).status,
    ).toBe(409);
    expect(f.port.stage).not.toHaveBeenCalled();
    const other = f.service.registerSession(f.pair.token, {
      ...f.registration,
      externalSessionId: "other",
    });
    expect(
      (await f.upload(request, "transfer", pdf, {}, other.token)).status,
    ).toBe(403);
  });
  it("Stop before transfer upload revokes grant, cancels pending bytes and invalidates private preview", async () => {
    const f = fixture(),
      preview = await f.preview();
    await f.turn("send this document");
    const request = await f.claim();
    expect((await f.api("/api/documents/stop", {})).status).toBe(200);
    expect((await f.upload(request, "transfer")).status).toBe(403);
    expect(f.port.stage).not.toHaveBeenCalled();
    expect(
      (
        await f.app.request(`/document-previews/${preview.assetId}/image`, {
          headers: { authorization: `Bearer ${preview.token}` },
        })
      ).status,
    ).toBe(404);
  });
  it("Stop during upload prevents send even after a valid staging acknowledgment arrives", async () => {
    const f = fixture();
    await f.preview();
    await f.turn("send this document");
    const request = await f.claim();
    let release!: (v: { attachmentId: string }) => void;
    f.port.stage = vi.fn(async (_p, _f, _b, before) => {
      before();
      return new Promise<{ attachmentId: string }>((r) => {
        release = r;
      });
    });
    const upload = f.upload(request, "transfer");
    await settle();
    expect(f.port.stage).toHaveBeenCalledTimes(1);
    await f.api("/api/documents/stop", {});
    release({ attachmentId });
    expect((await upload).status).toBe(409);
    expect(f.port.send).not.toHaveBeenCalled();
  });
  it("literal conversational Stop revokes the document grant during staging and never sends", async () => {
    const f = fixture();
    await f.preview();
    await f.turn("send this document");
    const request = await f.claim();
    let release!: (v: { attachmentId: string }) => void;
    f.port.stage = vi.fn(async (_p, _f, _b, before) => {
      before();
      return new Promise<{ attachmentId: string }>((resolve) => {
        release = resolve;
      });
    });
    const upload = f.upload(request, "transfer");
    await settle();
    expect(f.port.stage).toHaveBeenCalledTimes(1);
    await f.turn("Stop");
    expect(f.store.get("document_root_grant", f.grant.id)).toMatchObject({
      state: "revoked",
    });
    release({ attachmentId });
    expect((await upload).status).toBe(409);
    expect(f.port.send).not.toHaveBeenCalled();
  });
  it("document-only media policy excludes screen and presentation authority even when requested", async () => {
    const f = fixture();
    const request = f.service.requestAttention(f.agent.token, {
      taskId: "fixture-preview",
      idempotencyKey: "fixture-call",
      reason: "decision",
      question: "View synthetic document",
    });
    await f.service.drain();
    f.service.observeCall(request.id, "connected");
    const call = f.store
      .all<CallSession>("call")
      .find((item) => item.requestId === request.id)!;
    f.store.put("call", { ...call, remoteParticipantQualified: true });
    // Even stale/corrupt desktop authority must not escape through document policy.
    f.store.put("lease", {
      id: "synthetic-lease",
      requestId: request.id,
      state: "active",
      expiresAt: f.service.clock() + 10000,
      epoch: f.agent.session.controlEpoch,
      deviceId: "mac",
      memberId: "human",
      callId: call.id,
      displayId: "1",
      mode: "view",
    });
    const response = await f.app.request(
      `/media/${mediaSessionId(request.id)}/policy`,
      {
        headers: {
          authorization: "Bearer synthetic-media-token-32-characters-minimum",
          "X-ClawdTime-Presentation": "1",
        },
      },
    );
    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.state).toBe("listening");
    for (const field of [
      "screenSelection",
      "presentationBinding",
      "presentationSequence",
    ])
      expect(policy).not.toHaveProperty(field);
  });
  it("private preview requires its own capability and expires independently of an ordinary session token", async () => {
    const f = fixture(),
      preview = await f.preview();
    const other = f.service.registerSession(f.pair.token, {
      ...f.registration,
      externalSessionId: "other",
    });
    for (const token of [f.agent.token, other.token, "wrong"])
      expect(
        (
          await f.app.request(`/document-previews/${preview.assetId}/image`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await f.app.request(`/document-previews/other/image`, {
          headers: { authorization: `Bearer ${preview.token}` },
        })
      ).status,
    ).toBe(404);
    f.advance(120001);
    expect(
      (
        await f.app.request(`/document-previews/${preview.assetId}/image`, {
          headers: { authorization: `Bearer ${preview.token}` },
        })
      ).status,
    ).toBe(404);
  });
  it.each(["expired", "revoked_pairing"])(
    "%s authority cleanup cancels awaiting transfers and revokes private preview",
    async (reason) => {
      const f = fixture(),
        preview = await f.preview();
      await f.turn("send this document");
      if (reason === "expired") f.advance(900001);
      else
        f.store.put("pairing", {
          ...f.pair.pairing,
          revokedAt: f.service.clock(),
        });
      expect(() => f.documents.maintain()).not.toThrow();
      expect(f.store.get("document_root_grant", f.grant.id)).toMatchObject({
        state: "revoked",
      });
      expect(f.store.all("attachment_dispatch")).toEqual([
        expect.objectContaining({ state: "canceled" }),
      ]);
      expect(() => f.documents.stop(f.binding)).not.toThrow();
      expect(
        (
          await f.app.request(`/document-previews/${preview.assetId}/image`, {
            headers: { authorization: `Bearer ${preview.token}` },
          })
        ).status,
      ).toBe(404);
      expect(f.port.stage).not.toHaveBeenCalled();
    },
  );
  it("Stop before first grant materialization persists a tombstone and cannot recreate authority", () => {
    const f = fixture();
    f.store.db
      .prepare("DELETE FROM entities WHERE kind=? AND id=?")
      .run("document_root_grant", f.grant.id);
    expect(f.documents.stop(f.binding)).toEqual({ stopped: true });
    expect(f.store.get("document_root_grant", f.grant.id)).toMatchObject({
      state: "revoked",
      sessionId: f.binding.sessionId,
    });
    expect(() => f.documents.grant(f.binding)).toThrow("revoked");
  });
});
