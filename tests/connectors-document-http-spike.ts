/** Opt-in: actual HTTP, document worker and QuickLook. --real-model uses operator-supplied environment; attachment transport is always simulated. */
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { JobBroker } from "../src/attention/jobs.js";
import { AttachmentService } from "../src/attention/attachments.js";
import { DocumentService } from "../src/control/documents.js";
import {
  JobConversation,
  configuredTextModel,
  type ConversationModel,
} from "../src/control/job-conversation.js";
import { RemoteExecutionRunner } from "../src/control/remote-runner.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { createApp } from "../src/app.js";
import { createDocumentHost } from "../connectors/shared/document-host.js";
import { ExecutorWorker } from "../connectors/shared/executor-worker.js";
import { fixturePdf } from "./connectors-document-fixtures.js";

const realModel = process.argv.includes("--real-model");
const configuredModel = realModel
  ? configuredTextModel(process.env)
  : undefined;
if (realModel && !configuredModel)
  throw new Error(
    "--real-model requires operator-supplied text model configuration.",
  );
const deadlineMs = realModel ? 90_000 : 30_000;
const temp = await realpath(
  await mkdtemp(join(tmpdir(), "clawdtime-document-http-")),
);
const root = join(temp, "documents");
await mkdir(root);
const bytes = fixturePdf();
await writeFile(join(root, "Synthetic Resume.pdf"), bytes, { mode: 0o600 });
const store = new Store(),
  transport = new SimulationTransport(),
  service = new ClawdTime(store, transport);
const remote = new RemoteExecutionRunner(service, true, "remote-documents"),
  broker = new JobBroker(service, [remote]);
let documentService!: DocumentService;
let candidateId: string | null = null;
const model: ConversationModel = configuredModel ?? {
  async propose({ text }) {
    return {
      action: text.startsWith("find")
        ? "discover_documents"
        : text.startsWith("preview")
          ? "preview_document"
          : "send_document",
      reply: "Synthetic document fixture intent.",
      jobId: null,
      instruction: null,
      kind: null,
      target: null,
      verification: null,
      candidateId: text.startsWith("preview") ? candidateId : null,
    };
  },
};
let app: ReturnType<typeof createApp>;
const server = serve({
  fetch: (request) => app.fetch(request),
  hostname: "127.0.0.1",
  port: 0,
});
if (!server.listening)
  await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`,
  abort = new AbortController();
documentService = new DocumentService(service, broker, origin);
let stages = 0,
  sends = 0;
const attachments = new AttachmentService(
  service,
  {
    async stage(_pair, _file, actual, before) {
      before();
      stages++;
      assert.deepEqual(Buffer.from(actual), bytes);
      return { attachmentId: "att_" + "a".repeat(32) };
    },
    async send(pair, _file, _staged, before) {
      before({ sequence: 1, eventId: "synthetic-anchor" });
      sends++;
      return {
        attachmentId: "att_" + "a".repeat(32),
        messageId: "00000000-0000-4000-8000-000000000001",
        providerLineId: "synthetic-provider",
        recipient: pair.recipient,
        evidence: "send_response",
      };
    },
    async reconcile() {
      return undefined;
    },
  },
  documentService,
);
documentService.attachments = attachments;
const frontend = new JobConversation(service, broker, model, documentService),
  control = new ControlCoordinator(store, new SimulatedDevice());
app = createApp(service, control, new HumanRouter(service, control), {
  origin,
  simulation: true,
  conversation: frontend,
  documentRunner: remote,
  documents: documentService,
});
let work: Promise<void> | undefined,
  host: Awaited<ReturnType<typeof createDocumentHost>> | undefined;
let browser: Browser | undefined,
  page: Page | undefined,
  previewLink: string | undefined;
let browserLoadMs = 0,
  imageWidth = 0,
  imageHeight = 0;
let maintenance: ReturnType<typeof setInterval> | undefined;
const started = performance.now(),
  timings: object[] = [],
  boundaries: string[] = [];
const waitFor = async (predicate: () => boolean) => {
  while (!predicate()) {
    if (performance.now() - started > deadlineMs)
      throw new Error("Document HTTP fixture deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
try {
  const invite = service.createPairingInvite({
    memberId: "synthetic-human",
    recipient: "+15550000001",
    lineId: "synthetic-line",
    conversationId: "iMessage;-;+15550000001",
    deviceId: "synthetic-mac",
    displayId: "1",
  });
  const pair = service.claimPairing({
    token: invite.token,
    deviceId: "synthetic-mac",
    displayId: "1",
    allowView: true,
    allowControl: false,
  });
  const agent = service.registerSession(pair.token, {
    adapter: "codex",
    adapterVersion: "document-http-fixture",
    externalSessionId: "explicit-document-fixture",
    projectRoot: root,
    hostId: "synthetic-host",
    protocolVersion: 2,
    capabilities: { cooperativePause: true, polling: true },
    conversation: {
      version: 1,
      runnerId: "remote-documents",
      executionSession: "api_managed",
    },
    documentAccess: {
      version: 1,
      readOnly: true,
      expiresAt: Date.now() + (realModel ? 120_000 : 60_000),
    },
  });
  const binding = frontend.binding(agent.session);
  host = await createDocumentHost(agent.session, origin, agent.token);
  const worker = new ExecutorWorker({
    origin,
    token: agent.token,
    session: agent.session,
    ledgerPath: join(temp, "worker.json"),
    runner: host.runner,
    pollMs: 50,
    request: (async (url, init) => {
      if (String(url).endsWith("/api/executor/events"))
        boundaries.push(JSON.parse(String(init?.body)).event.type);
      return fetch(url, init);
    }) as typeof fetch,
  });
  work = worker.run(abort.signal);
  maintenance = setInterval(() => {
    broker.dispatch();
    frontend.reportUpdates();
    void service.drain();
  }, 20);
  await waitFor(() => remote.capabilities(binding).available);
  let sequence = 0;
  const turn = async (text: string) => {
    const response = await fetch(origin + "/api/conversation/turn", {
      method: "POST",
      signal: AbortSignal.timeout(
        Math.max(1, Math.floor(deadlineMs - (performance.now() - started))),
      ),
      headers: {
        authorization: `Bearer ${agent.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventId: `synthetic-turn-${++sequence}`, text }),
    });
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  for (const [operation, text] of [
    ["discover", "find my resume"],
    ["preview", "preview the listed document"],
    ["prepare_transfer", "send this document"],
  ]) {
    const began = performance.now(),
      submitted = await turn(text!);
    assert(submitted.job, `${operation} did not submit`);
    await waitFor(() =>
      [
        "succeeded",
        "failed",
        "unknown",
        "canceled",
        "waiting_clarification",
      ].includes(broker.status(binding, submitted.job.id).state),
    );
    const result = broker.status(binding, submitted.job.id);
    assert.equal(result.state, "succeeded", `${operation}: ${result.state}`);
    assert.equal(result.result?.verification?.verified, true);
    if (operation === "discover") {
      const candidates = result.result?.document?.candidates;
      assert.equal(candidates?.length, 1);
      candidateId = candidates![0]!.id;
    }
    if (operation === "preview") {
      assert(documentService.context(binding).selectionId);
      const description = documentService.describe(result)!;
      previewLink = /https?:\/\/[^ ]+\/document-preview#[^ ]+/.exec(
        description,
      )?.[0];
      assert(previewLink && new URL(previewLink).origin === origin);
      browser = await chromium.launch({
        headless: true,
        ...(existsSync("/Applications/Google Chrome.app")
          ? { channel: "chrome" }
          : {}),
      });
      page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      await page.clock.install();
      const loadAt = performance.now();
      await page.goto(previewLink);
      await page.waitForFunction(() => {
        const image = document.getElementById("image") as HTMLImageElement;
        return image.complete && image.naturalWidth > 0;
      });
      assert.equal(
        await page.locator("#name").textContent(),
        "Synthetic Resume.pdf",
      );
      assert.equal(new URL(page.url()).hash, "");
      const dimensions = await page.locator("#image").evaluate((image) => ({
        width: (image as HTMLImageElement).naturalWidth,
        height: (image as HTMLImageElement).naturalHeight,
      }));
      imageWidth = dimensions.width;
      imageHeight = dimensions.height;
      assert(imageWidth > 0 && imageHeight > 0);
      browserLoadMs = Math.round(performance.now() - loadAt);
      await mkdir(".data/document-demo", { recursive: true, mode: 0o700 });
      await page.screenshot({
        path: ".data/document-demo/synthetic-preview.png",
        fullPage: true,
      });
    }
    timings.push({
      operation,
      verified: true,
      elapsedMs: Math.round(performance.now() - began),
    });
  }
  await turn("send this document");
  assert.equal(stages, 1);
  assert.equal(sends, 1);
  assert.equal(boundaries.filter((value) => value === "accepted").length, 3);
  assert.equal(await host.stop(), true);
  assert.equal(
    store.get<{ state: string }>("document_root_grant", host.grant.id)?.state,
    "revoked",
  );
  assert.equal(transport.calls.length, 0);
  assert(page && previewLink);
  await page.clock.fastForward(120001);
  assert.equal(await page.locator("#image").getAttribute("src"), null);
  assert.match(await page.locator("#status").innerText(), /expired/);
  await page.goto(previewLink);
  await page.waitForFunction(() =>
    document.getElementById("status")!.textContent!.includes("expired"),
  );
  assert.equal(await page.locator("#image").getAttribute("src"), null);
  console.log(
    JSON.stringify({
      actualHttpWorker: true,
      actualQuickLook: true,
      browserPreview: {
        loaded: true,
        imageWidth,
        imageHeight,
        browserLoadMs,
        expiredImageRemoved: true,
        revokedPreviewRefused: true,
        screenshot: ".data/document-demo/synthetic-preview.png",
      },
      syntheticDocuments: true,
      scriptedFrontend: !realModel,
      realTextModel: realModel,
      simulatedAttachmentTransport: true,
      actualExternalSends: 0,
      acceptedDispatches: 3,
      stages,
      sends,
      duplicateSendSuppressed: true,
      localStopRevoked: true,
      nativeControl: "none",
      callCount: 0,
      timings,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
} finally {
  await browser?.close();
  clearInterval(maintenance);
  abort.abort();
  await host?.stop();
  await work?.catch(() => {});
  documentService.close();
  await broker.stop();
  await attachments.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  bytes.fill(0);
  await rm(temp, { recursive: true, force: true });
}
