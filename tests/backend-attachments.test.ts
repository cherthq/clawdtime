import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  AttachmentService,
  type AttachmentAuthority,
} from "../src/attention/attachments.js";
import {
  NativeAttachmentPort,
  attachmentFilename,
  attachmentFileSchema,
  validateAttachmentBytes,
  type AttachmentPort,
  type AttachmentReceipt,
} from "../src/transport/attachments.js";
import type { NativeTransport } from "../src/transport/native.js";
import type { DocumentSelection, DocumentCandidate } from "../src/contracts.js";
const bytes = Buffer.from("%PDF-1.7\nSYNTHETIC DOCUMENT\n%%EOF");
const sha = createHash("sha256").update(bytes).digest("hex");
const attachmentId = "att_" + "a".repeat(32),
  messageId = "00000000-0000-4000-8000-000000000001";
const source = (eventId: string) => ({ channel: "text" as const, eventId });
const receipt: AttachmentReceipt = {
  attachmentId,
  messageId,
  providerLineId: "provider-line",
  recipient: "+15550000001",
  evidence: "send_response",
};
function fixture() {
  let now = 100000;
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport(), {
      clock: () => now,
    });
  const invite = service.createPairingInvite({
    memberId: "human",
    recipient: receipt.recipient,
    lineId: "line",
    conversationId: `iMessage;-;${receipt.recipient}`,
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
    projectRoot: "/fixture",
    externalSessionId: "documents",
    hostId: "host",
    protocolVersion: 2 as const,
    conversation: {
      version: 1 as const,
      runnerId: "remote-documents",
      executionSession: "api_managed" as const,
    },
    documentAccess: {
      version: 1 as const,
      readOnly: true as const,
      expiresAt: 200000,
    },
    capabilities: { cooperativePause: true, polling: true },
  };
  const agent = service.registerSession(pair.token, registration),
    binding = {
      sessionId: agent.session.id,
      pairingId: pair.pairing.id,
      memberId: "human",
    };
  const candidate: DocumentCandidate = {
    id: "doc_" + sha,
    grantId: "grant",
    name: "Résumé 2026.pdf",
    mimeType: "application/pdf",
    byteLength: bytes.length,
    sha256: sha,
    previewSupport: "first_page",
  };
  let selection: DocumentSelection = {
    ...binding,
    id: "selection",
    grantId: "grant",
    candidate,
    previewJobId: "preview",
    previewRevision: 1,
    expiresAt: 180000,
    sequence: 3,
  };
  let current = true;
  const authority: AttachmentAuthority = {
    selection: () => selection,
    assertCurrent: () => {
      if (!current) throw new Error("selection changed");
    },
  };
  const port: AttachmentPort = {
    stage: vi.fn(async (_pair, _file, _bytes, before) => {
      before();
      return { attachmentId };
    }),
    send: vi.fn(async (_pair, _file, _staged, before) => {
      before({ sequence: 1, eventId: "anchor" });
      return receipt;
    }),
    reconcile: vi.fn(async () => undefined),
  };
  const attachments = new AttachmentService(service, port, authority);
  const enqueue = () =>
    attachments.enqueue(binding, source("send"), {
      selectionId: selection.id,
      candidateId: candidate.id,
      sha256: sha,
      recipient: "paired_imessage",
    });
  return {
    store,
    service,
    pair,
    registration,
    agent,
    binding,
    candidate,
    selection,
    authority,
    port,
    attachments,
    enqueue,
    advance: (ms: number) => (now += ms),
    invalidate: () => (current = false),
    select: (value: DocumentSelection) => (selection = value),
  };
}
describe("exact selected-document attachment ledger", () => {
  it("binds actual bytes and exact paired recipient with stage/send claims before effects", async () => {
    const f = fixture(),
      d = f.enqueue();
    expect(d.file.filename).toBe("Resume_2026.pdf");
    expect(d.candidate.name).toBe("Résumé 2026.pdf");
    f.port.stage = vi.fn(async (_p, _f, b, before) => {
      expect(Buffer.from(b)).toEqual(bytes);
      expect(f.attachments.status(f.binding, d.id).state).toBe("staging");
      before();
      expect(f.attachments.status(f.binding, d.id).uploadAttempted).toBe(true);
      return { attachmentId };
    });
    f.port.send = vi.fn(async (p, _f, _s, before) => {
      expect(p.recipient).toBe(receipt.recipient);
      before({ sequence: 1, eventId: "anchor" });
      expect(f.attachments.status(f.binding, d.id)).toMatchObject({
        state: "sending",
        sendAttempted: true,
        attachmentId,
      });
      return receipt;
    });
    f.attachments.provideBytes(f.binding, d.id, bytes);
    const done = await f.attachments.wait(f.binding, d.id);
    expect(done).toMatchObject({
      state: "accepted",
      delivery: "provider_accepted",
      receipt,
    });
    expect(done).not.toHaveProperty("handsetDelivered");
    expect(JSON.stringify(f.store.all("attachment_dispatch"))).not.toContain(
      "SYNTHETIC DOCUMENT",
    );
    expect(f.enqueue().id).toBe(d.id);
    f.attachments.provideBytes(f.binding, d.id, bytes);
    expect(f.port.send).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("deduplicates a new approval event for the same selection and rejects changed event identity", () => {
    const f = fixture(),
      d = f.enqueue();
    expect(
      f.attachments.enqueue(f.binding, source("another"), {
        selectionId: "selection",
        candidateId: f.candidate.id,
        sha256: sha,
        recipient: "paired_imessage",
      }).id,
    ).toBe(d.id);
    expect(() =>
      f.attachments.enqueue(f.binding, source("send"), {
        selectionId: "selection",
        candidateId: f.candidate.id,
        sha256: "b".repeat(64),
        recipient: "paired_imessage",
      }),
    ).toThrow("identity");
    f.store.close();
  });
  it("refuses changed bytes, selection, recipient, expired authority and forged ownership before upload", () => {
    const f = fixture(),
      d = f.enqueue();
    expect(() =>
      f.attachments.provideBytes(f.binding, d.id, Buffer.from("%PDF-wrong")),
    ).toThrow("bytes");
    expect(() =>
      f.attachments.provideBytes(
        { ...f.binding, memberId: "other" },
        d.id,
        bytes,
      ),
    ).toThrow();
    f.invalidate();
    expect(() => f.attachments.provideBytes(f.binding, d.id, bytes)).toThrow();
    expect(f.port.stage).not.toHaveBeenCalled();
    f.store.close();
    const g = fixture(),
      e = g.enqueue();
    g.store.put("pairing", { ...g.pair.pairing, recipient: "+15550000002" });
    expect(() => g.attachments.provideBytes(g.binding, e.id, bytes)).toThrow(
      "approval",
    );
    g.store.close();
    const h = fixture(),
      i = h.enqueue();
    h.advance(80001);
    expect(() => h.attachments.provideBytes(h.binding, i.id, bytes)).toThrow();
    h.store.close();
  });
  it("cancel before bytes creates no upload or send and cannot be revived", async () => {
    const f = fixture(),
      d = f.enqueue();
    f.attachments.cancel(f.binding, d.id);
    expect(f.attachments.provideBytes(f.binding, d.id, bytes).state).toBe(
      "canceled",
    );
    expect(f.port.stage).not.toHaveBeenCalled();
    expect(f.port.send).not.toHaveBeenCalled();
    f.store.close();
  });
  it("correction after stage prevents send and retains known stage identity", async () => {
    const f = fixture(),
      d = f.enqueue();
    f.port.stage = vi.fn(async (_p, _f, _b, before) => {
      before();
      f.invalidate();
      return { attachmentId };
    });
    f.attachments.provideBytes(f.binding, d.id, bytes);
    expect(await f.attachments.wait(f.binding, d.id)).toMatchObject({
      state: "failed",
      attachmentId,
    });
    expect(f.port.send).not.toHaveBeenCalled();
    f.store.close();
  });
  it("lost send response becomes unknown, blocks new selection and only exact provider event reconciles", async () => {
    const f = fixture(),
      d = f.enqueue();
    f.port.send = vi.fn(async (_p, _f, _s, before) => {
      before({ sequence: 1, eventId: "anchor" });
      throw new Error("lost response");
    });
    f.attachments.provideBytes(f.binding, d.id, bytes);
    expect((await f.attachments.wait(f.binding, d.id)).state).toBe("unknown");
    f.select({ ...f.selection, id: "second" });
    expect(() =>
      f.attachments.enqueue(f.binding, source("second"), {
        selectionId: "second",
        candidateId: f.candidate.id,
        sha256: sha,
        recipient: "paired_imessage",
      }),
    ).toThrow("unresolved");
    f.attachments.provideBytes(f.binding, d.id, bytes);
    expect(f.port.send).toHaveBeenCalledTimes(1);
    expect((await f.attachments.reconcile(f.binding, d.id)).state).toBe(
      "unknown",
    );
    f.port.reconcile = vi.fn(async () => ({
      ...receipt,
      evidence: "provider_event" as const,
      eventId: `msg_sent:${messageId}`,
      eventSequence: 2,
    }));
    expect(await f.attachments.reconcile(f.binding, d.id)).toMatchObject({
      state: "accepted",
      delivery: "provider_accepted",
    });
    expect(f.port.send).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("restart never resumes an interrupted transfer or erases its claim", () => {
    const f = fixture(),
      d = f.enqueue();
    f.store.put("attachment_dispatch", {
      ...d,
      state: "sending",
      phase: "send",
      uploadAttempted: true,
      sendAttempted: true,
      attachmentId,
      anchor: { sequence: 1, eventId: "anchor" },
    });
    const restarted = new AttachmentService(f.service, f.port, f.authority);
    expect(restarted.status(f.binding, d.id)).toMatchObject({
      state: "unknown",
      sendAttempted: true,
      reason: "process_interrupted",
    });
    expect(restarted.provideBytes(f.binding, d.id, bytes).state).toBe(
      "unknown",
    );
    expect(f.port.send).not.toHaveBeenCalled();
    f.store.close();
  });
  it("Stop after upload claim but before upload acknowledgement never sends the file", async () => {
    const f = fixture(),
      d = f.enqueue();
    let release!: (value: { attachmentId: string }) => void;
    f.port.stage = vi.fn(async (_p, _f, _b, before) => {
      before();
      return new Promise<{ attachmentId: string }>((resolve) => {
        release = resolve;
      });
    });
    f.attachments.provideBytes(f.binding, d.id, bytes);
    expect(f.attachments.cancel(f.binding, d.id).state).toBe("unknown");
    release({ attachmentId });
    expect(await f.attachments.wait(f.binding, d.id)).toMatchObject({
      state: "canceled",
      attachmentId,
    });
    expect(f.port.send).not.toHaveBeenCalled();
    f.store.close();
  });
  it("Stop after send claim preserves unknown even when a later POST receipt arrives", async () => {
    const f = fixture(),
      d = f.enqueue();
    let release!: (value: AttachmentReceipt) => void;
    f.port.send = vi.fn(async (_p, _f, _s, before) => {
      before({ sequence: 1, eventId: "anchor" });
      return new Promise<AttachmentReceipt>((resolve) => {
        release = resolve;
      });
    });
    f.attachments.provideBytes(f.binding, d.id, bytes);
    await new Promise((r) => setImmediate(r));
    expect(f.attachments.cancel(f.binding, d.id).state).toBe("unknown");
    release(receipt);
    expect(await f.attachments.wait(f.binding, d.id)).toMatchObject({
      state: "unknown",
      sendAttempted: true,
      receipt,
    });
    expect(f.port.send).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("requires immutable future <=hour document access on the exact managed runner", () => {
    const f = fixture();
    expect(() =>
      f.service.registerSession(f.pair.token, {
        ...f.registration,
        documentAccess: {
          ...f.registration.documentAccess!,
          expiresAt: 200001,
        },
      }),
    ).toThrow("binding differs");
    for (const changed of [
      { documentAccess: undefined },
      {
        conversation: {
          ...f.registration.conversation,
          runnerId: "remote-codex-app-server",
        },
      },
      {
        documentAccess: { ...f.registration.documentAccess, expiresAt: 100000 },
      },
      {
        documentAccess: {
          ...f.registration.documentAccess,
          expiresAt: 3700001,
        },
      },
      { protocolVersion: 1 as const },
    ])
      expect(() =>
        f.service.registerSession(f.pair.token, {
          ...f.registration,
          externalSessionId: "new",
          ...changed,
        }),
      ).toThrow();
    f.store.close();
  });
  it("bounded shutdown detaches late upload callbacks before storage closes", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(),
        d = f.enqueue();
      let release!: (value: { attachmentId: string }) => void;
      f.port.stage = vi.fn(async (_p, _f, _b, before) => {
        before();
        return new Promise<{ attachmentId: string }>((resolve) => {
          release = resolve;
        });
      });
      f.attachments.provideBytes(f.binding, d.id, bytes);
      const stopped = f.attachments.stop();
      await vi.advanceTimersByTimeAsync(5001);
      await stopped;
      expect(f.attachments.status(f.binding, d.id).state).toBe("unknown");
      f.store.close();
      release({ attachmentId });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.port.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("normalizes maximum-length and non-ASCII names within exact provider filename bounds", () => {
    for (const name of [
      "x".repeat(175) + ".docx",
      "_Résumé Draft.docx",
      "文档.docx",
      ".hidden.docx",
      "CON.docx",
    ]) {
      const filename = attachmentFilename(
        name,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(filename.length).toBeLessThanOrEqual(160);
      expect(
        attachmentFileSchema.safeParse({
          filename,
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          byteLength: 5,
          sha256: sha,
        }).success,
      ).toBe(true);
    }
  });
  it("accepts bounded PDF/DOCX/Pages bytes by approved digest without pretending MIME proves document safety", () => {
    expect(
      attachmentFilename(
        "Résumé Draft.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("Resume_Draft.docx");
    for (const [mimeType, filename, data] of [
      ["application/pdf", "Resume.pdf", bytes],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Resume.docx",
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]),
      ],
      [
        "application/vnd.apple.pages",
        "Resume.pages",
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]),
      ],
    ] as const)
      expect(() =>
        validateAttachmentBytes(
          {
            mimeType,
            filename,
            byteLength: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
          },
          data,
        ),
      ).not.toThrow();
  });
});
function nativeFixture() {
  const f = fixture();
  const file = f.enqueue().file;
  const requests: { path: string; body?: unknown }[] = [];
  const summary = {
    id: attachmentId,
    filename: file.filename,
    mime_type: file.mimeType,
    total_bytes: file.byteLength,
    message_id: messageId,
  };
  let eventCount = 1,
    gap = false;
  const messages = {
    verify: vi.fn(async () => ({})),
    cursor: () => ({ sequence: 1, eventId: "anchor" }),
    verifyAnchor: vi.fn(async (a: any) => a),
    api: vi.fn(async (path: string, body?: unknown) => {
      requests.push({ path, body });
      if (path === "/api/v1/attachments")
        return {
          attachment: {
            ...summary,
            transfer_state: "ready",
            local_path: "/private/strip",
          },
        };
      if (path.startsWith("/api/v1/attachments/"))
        return { attachment: { ...summary, transfer_state: "ready" } };
      if (path === "/api/v1/send")
        return {
          status: "sent",
          delivery: "direct",
          phone_line_id: "provider-line",
          phone: receipt.recipient,
          message_id: messageId,
          attachments: [summary],
        };
      return {
        events: Array.from({ length: eventCount }, (_, i) => {
          const guid =
            i === 0 ? messageId : "00000000-0000-4000-8000-000000000002";
          return {
            sequence: 2 + i + (gap ? 1 : 0),
            event_id: `msg_sent:${guid}`,
            type: "message_sent",
            phone_line_id: "provider-line",
            payload: {
              phone_line_id: "provider-line",
              message: {
                guid,
                recipient: receipt.recipient,
                phone_line_id: "provider-line",
                attachments: [{ ...summary, message_id: guid }],
              },
            },
          };
        }),
        head_sequence: 1 + eventCount,
        has_more: false,
      };
    }),
  };
  const transport = {
    config: { binding: { lineId: "line", providerLineId: "provider-line" } },
    messages,
    attachmentPreflight: vi.fn(async () => {}),
  } as unknown as NativeTransport;
  const port = new NativeAttachmentPort(transport);
  return {
    ...f,
    file,
    port,
    requests,
    messages,
    events: (n: number) => (eventCount = n),
    gap: () => (gap = true),
  };
}
describe("native attachment protocol without live traffic", () => {
  it("stages exact bytes then sends one attachment with no companion text or idempotency retry claim", async () => {
    const f = nativeFixture(),
      stageClaim = vi.fn(),
      sendClaim = vi.fn();
    expect(
      await f.port.stage(f.pair.pairing, f.file, bytes, stageClaim),
    ).toEqual({ attachmentId });
    expect(stageClaim).toHaveBeenCalledTimes(1);
    expect(
      await f.port.send(f.pair.pairing, f.file, { attachmentId }, sendClaim),
    ).toEqual(receipt);
    expect(sendClaim).toHaveBeenCalledWith({ sequence: 1, eventId: "anchor" });
    expect(
      f.requests.find((r) => r.path === "/api/v1/attachments")?.body,
    ).toEqual({
      filename: "Resume_2026.pdf",
      mime_type: "application/pdf",
      data_base64: bytes.toString("base64"),
    });
    expect(f.requests.find((r) => r.path === "/api/v1/send")?.body).toEqual({
      phone: receipt.recipient,
      attachments: [{ id: attachmentId }],
    });
    f.store.close();
  });
  it("final predispatch rejection prevents POST after asynchronous preflight", async () => {
    const f = nativeFixture();
    await expect(
      f.port.send(f.pair.pairing, f.file, { attachmentId }, () => {
        throw new Error("closed");
      }),
    ).rejects.toThrow("closed");
    expect(f.requests.some((r) => r.path === "/api/v1/send")).toBe(false);
    f.store.close();
  });
  it("reconciles one exact native event without moving cursors; multiple matches or gap do not establish one send", async () => {
    const f = nativeFixture(),
      anchor = { sequence: 1, eventId: "anchor" };
    expect(
      await f.port.reconcile(f.pair.pairing, f.file, { attachmentId }, anchor),
    ).toMatchObject({
      ...receipt,
      evidence: "provider_event",
      eventSequence: 2,
    });
    expect(f.messages.cursor()).toEqual(anchor);
    expect(f.requests.every((r) => r.body === undefined)).toBe(true);
    f.events(2);
    expect(
      await f.port.reconcile(f.pair.pairing, f.file, { attachmentId }, anchor),
    ).toBeUndefined();
    f.events(1);
    f.gap();
    await expect(
      f.port.reconcile(f.pair.pairing, f.file, { attachmentId }, anchor),
    ).rejects.toThrow("boundary");
    f.store.close();
  });
  it("retains ambiguous POST outcome without retry", async () => {
    const f = nativeFixture();
    f.messages.api.mockImplementation(async (path) => {
      f.requests.push({ path });
      if (path === "/api/v1/send") throw new Error("timeout");
      return {
        attachment: {
          id: attachmentId,
          filename: f.file.filename,
          mime_type: f.file.mimeType,
          total_bytes: f.file.byteLength,
          transfer_state: "ready",
        },
      } as any;
    });
    await expect(
      f.port.send(f.pair.pairing, f.file, { attachmentId }, () => {}),
    ).rejects.toThrow("timeout");
    expect(f.requests.filter((r) => r.path === "/api/v1/send")).toHaveLength(1);
    f.store.close();
  });
});
