import { releaseSourceRevision } from "./release.js";
import { NativeActivationCoordinator } from "./control/native-activation.js";
import { isDeepStrictEqual } from "node:util";
import { VoicePresentation } from "./control/voice-presentation.js";
import { voiceEventSchema, voiceCameraSchema } from "./voice-contracts.js";
import { ScreenCamera } from "./control/camera.js";
import { LivePresentationCoordinator } from "./control/live-presentation.js";
import { livePresentationSchema } from "./live-presentation-contracts.js";
import { timelineFor } from "./transport/conversation-timeline.js";
import {
  presentationSchema,
  presentationFor,
} from "./attention/presentation.js";
import { ExecutionCoordinator } from "./control/execution.js";
import { Interruptions, interruptionSchema } from "./control/interruptions.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ClawdTime, DomainError } from "./attention/service.js";
import { ControlCoordinator } from "./control/coordinator.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  Pairing,
  ActionReceipt,
} from "./contracts.js";
import {
  HumanRouter,
  HumanCommandConflict,
  isImmediateStop,
} from "./control/human-router.js";
import { SetupService } from "./pairing/setup.js";
import { mediaFailureSchema } from "./transport/media-diagnostics.js";
import {
  websiteOrigin,
  websitePages,
  websitePage,
  websiteSitemap,
  websiteRobots,
  websiteInstallScript,
  websiteDownload,
  type WebsitePath,
} from "./website.js";
import {
  WebsiteMetrics,
  readOperationalWebsiteMetrics,
} from "./storage/website-metrics.js";
import type { JobConversation } from "./control/job-conversation.js";
import type { RemoteExecutionRunner } from "./control/remote-runner.js";
import type { DocumentService } from "./control/documents.js";
import {
  documentCandidateSchema,
  documentResultSchema,
  DOCUMENT_MAX_BYTES,
} from "./document-contracts.js";
import type { TextDesktopPort } from "./control/text-device.js";
import type { TextControlGrant } from "./contracts.js";
import {
  setupRetirementInput,
  type SetupRetirementInput,
} from "./pairing/retired-setup.js";

export interface AppOptions {
  screenCameraEnabled?: boolean;
  livePresentationEnabled?: boolean;
  nativeActivationEnabled?: boolean;
  elevenLabsEnabled?: boolean;
  elevenLabsReadiness?: () => Promise<{
    configured: boolean;
    agentValidated: boolean;
    ready: boolean;
  }>;
  conversation?: JobConversation;
  textDevice?: TextDesktopPort;
  remoteRunner?: RemoteExecutionRunner;
  documentRunner?: RemoteExecutionRunner;
  documents?: DocumentService;
  origin: string;
  compatibleOrigins?: string[];
  operatorToken?: string;
  mediaToken?: string;
  simulation: boolean;
  dispatchEnabled?: boolean;
  publicTextNumber?: string;
  websiteAnalyticsEnabled?: boolean;
  audioQualificationEnabled?: boolean;
  audioQualificationReadiness?: () => Promise<{
    enabled: boolean;
    directKeyConfigured: boolean;
    websocketQualified: boolean;
    transportReady: boolean;
    sdk: { available: boolean };
  }>;
  twoWayVoiceEnabled?: boolean;
  remoteAudioIsolated?: boolean;
  retireObsoleteNotice?: (input: {
    noticeId: string;
    pairingId: string;
    evidenceReference: string;
  }) => unknown;
  callDiagnostics?: (requestId: string) => Promise<unknown>;
  retireSetupInvitation?: (input: SetupRetirementInput) => unknown;
}
const bearer = (value?: string) =>
  value?.startsWith("Bearer ") ? value.slice(7) : "";
function matches(a: string, b?: string) {
  return (
    !!b &&
    b.length >= 32 &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
const mediaId = (id: string) =>
  `ct_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
export function createApp(
  service: ClawdTime,
  control: ControlCoordinator,
  human: HumanRouter,
  options: AppOptions,
) {
  const app = new Hono();
  const websiteMetrics = new WebsiteMetrics(service.store, {
    enabled: options.websiteAnalyticsEnabled === true,
  });
  const setup = new SetupService(service);
  const camera = new ScreenCamera(
    service,
    control,
    options.screenCameraEnabled === true,
  );
  const voicePresentation = new VoicePresentation(service, camera);
  const interruptions = new Interruptions(service);
  const livePresentation = new LivePresentationCoordinator(service, camera, {
    enabled: options.livePresentationEnabled === true,
    revision: (requestId) => human.turns.executionRevision(requestId),
    assertClear: (requestId) => interruptions.assertClear(requestId),
  });
  const nativeActivation = new NativeActivationCoordinator(service, camera, {
    enabled: options.nativeActivationEnabled === true,
    revision: (requestId) => human.turns.executionRevision(requestId),
    assertClear: (requestId) => interruptions.assertClear(requestId),
  });
  const execution = new ExecutionCoordinator(
    service,
    control,
    (token, requestId, cursor) => {
      interruptions.assertClear(requestId);
      human.turns.assertCurrentInput(token, requestId, cursor);
    },
    async (token, requestId, frameId, reference) => {
      const view = await camera.status(token, requestId);
      if (
        view.state !== "live" ||
        view.moving ||
        view.sourceFrameId !== frameId ||
        (reference &&
          (view.revision !== reference.revision ||
            view.geometryGeneration !== reference.geometryGeneration ||
            view.sourceFrameId !== reference.sourceFrameId))
      )
        throw new DomainError(
          409,
          "Observe a current stable camera view before input.",
        );
    },
  );
  const allowedOrigins = new Set([
    options.origin,
    ...(options.compatibleOrigins ?? []),
  ]);
  // Railway terminates HTTPS upstream of this HTTP server. Use the exact Host
  // from the request URL, not its internal scheme or untrusted forwarded headers.
  const canonicalHost = new URL(websiteOrigin).host;
  const isWebsiteOrigin = (url: string, origin?: string) => {
    const requestHost = new URL(url).host;
    return (
      (requestHost === canonicalHost && origin === websiteOrigin) ||
      (options.simulation &&
        origin === options.origin &&
        requestHost === new URL(options.origin).host)
    );
  };
  app.use(
    "/api/website/events",
    bodyLimit({
      maxSize: 1024,
      onError: (c) => c.json({ accepted: false }, 413),
    }),
  );
  const ordinaryBodyLimit = bodyLimit({ maxSize: 32_768 });
  const documentBodyLimit = bodyLimit({ maxSize: DOCUMENT_MAX_BYTES });
  app.use("*", (c, next) =>
    (c.req.path === "/api/documents/assets" && c.req.method === "POST"
      ? documentBodyLimit
      : ordinaryBodyLimit)(c, next),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    const origin = c.req.header("origin");
    if (
      origin &&
      !allowedOrigins.has(origin) &&
      !(
        c.req.path === "/api/website/events" &&
        isWebsiteOrigin(c.req.url, origin)
      )
    )
      return c.json({ error: "Origin is not allowed." }, 403);
    if (
      ["POST", "PUT", "DELETE", "PATCH"].includes(c.req.method) &&
      !(c.req.path === "/api/documents/assets" && c.req.method === "POST"
        ? c.req.header("content-type") === "application/octet-stream"
        : c.req.header("content-type")?.startsWith("application/json"))
    )
      return c.json({ error: "JSON required." }, 415);
    await next();
  });
  app.onError((err, c) =>
    c.json(
      {
        ...(err instanceof DomainError && err.code
          ? { errorCode: err.code }
          : {}),
        error:
          err instanceof DomainError || err instanceof z.ZodError
            ? err.message
            : "Request could not be completed. Check scoped state and readiness.",
      },
      err instanceof DomainError
        ? (err.status as 400)
        : err instanceof z.ZodError
          ? 400
          : 409,
    ),
  );
  app.get("/health", (c) =>
    c.json({
      ok: true,
      sourceRevision: releaseSourceRevision(),
      mode: options.simulation
        ? "simulation"
        : options.dispatchEnabled === false
          ? "standby"
          : "live",
      physicalAcceptance: false,
    }),
  );
  // Qualification credentials can only keep their bounded audio session alive,
  // inspect it, or stop it. No ordinary connector API may gain authority from one.
  app.use("/api/*", async (c, next) => {
    const token = bearer(c.req.header("authorization"));
    let session: AgentSession | undefined;
    if (token) {
      try {
        session = service.authenticateSession(token);
      } catch {
        /* route authenticates its own credential kind */
      }
    }
    if (session?.audioQualification !== undefined) {
      const allowed =
        (c.req.method === "POST" &&
          ["/api/sessions/heartbeat", "/api/disconnect"].includes(
            c.req.path,
          )) ||
        (c.req.method === "GET" &&
          /^\/api\/attention\/[^/]+(?:\/diagnostics)?$/.test(c.req.path));
      if (!allowed)
        throw new DomainError(
          403,
          "Audio qualification has no execution authority.",
        );
    }
    await next();
  });
  app.get("/api/jobs", (c) => {
    const frontend = options.conversation;
    if (!frontend)
      throw new DomainError(409, "Conversational broker is disabled.");
    const binding = frontend.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    return c.json({
      jobs: frontend.broker.list(binding).map((job) => ({
        ...job,
        report: frontend.describe(job),
        timing: frontend.broker.timing.snapshot(job.id),
      })),
      conversationTiming: frontend.broker.timing.snapshot(binding.sessionId),
      runner: frontend.broker.capabilities(binding),
      sequence: frontend.broker.currentSequence(binding),
    });
  });
  const workerId = z.string().min(1).max(160);
  function workerFor(binding: import("./contracts.js").JobBinding) {
    const session = service.store.get<import("./contracts.js").AgentSession>(
      "session",
      binding.sessionId,
    );
    const runner =
      session?.conversation?.runnerId === "remote-documents"
        ? options.documentRunner
        : options.remoteRunner;
    if (!runner || session?.conversation?.runnerId !== runner.id)
      throw new DomainError(409, "Selected remote worker is unavailable.");
    return runner;
  }
  const workerResult = z
    .object({
      outcome: z.enum(["succeeded", "failed", "canceled", "unknown"]),
      summary: z.string().max(1200),
      verification: z
        .object({
          verified: z.boolean(),
          method: z.enum([
            "file_read",
            "ui_observation",
            "document_digest",
            "attachment_receipt",
          ]),
          evidenceId: z.string().min(1).max(160),
        })
        .strict()
        .optional(),
      unresolvedEffectIds: z.array(workerId).max(32),
      document: documentResultSchema.optional(),
    })
    .strict();
  app.post("/api/executor/ready", async (c) => {
    if (
      (!options.remoteRunner && !options.documentRunner) ||
      !options.conversation
    )
      throw new DomainError(409, "Remote worker unavailable.");
    const token = bearer(c.req.header("authorization"));
    const session = service.authenticateSession(token);
    service.heartbeat(token);
    const binding = options.conversation.binding(
      service.authenticateSession(token),
    );
    const details = z
      .object({
        version: z.string().min(1).max(100),
        projectRoot: z.string().min(1).max(512),
        externalSessionId: z.string().min(1).max(512),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(workerFor(binding).ready(binding, details));
  });
  app.post("/api/executor/next", async (c) => {
    if (
      (!options.remoteRunner && !options.documentRunner) ||
      !options.conversation
    )
      throw new DomainError(409, "Remote worker unavailable.");
    const binding = options.conversation.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    const value = z
      .object({ eventId: workerId })
      .strict()
      .parse(await c.req.json());
    return c.json(workerFor(binding).next(binding, value.eventId));
  });
  app.post("/api/executor/events", async (c) => {
    if (
      (!options.remoteRunner && !options.documentRunner) ||
      !options.conversation
    )
      throw new DomainError(409, "Remote worker unavailable.");
    const binding = options.conversation.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    const event = z.discriminatedUnion("type", [
      z.object({ type: z.literal("accepted") }).strict(),
      z
        .object({
          type: z.literal("progress"),
          stage: z.enum(["reasoning", "observing", "input", "verifying"]),
        })
        .strict(),
      z.object({ type: z.literal("waiting_approval") }).strict(),
    ]);
    const value = z
      .object({ dispatchId: workerId, event })
      .strict()
      .parse(await c.req.json());
    return c.json(
      workerFor(binding).event(binding, value.dispatchId, value.event),
    );
  });
  app.post("/api/executor/result", async (c) => {
    if (
      (!options.remoteRunner && !options.documentRunner) ||
      !options.conversation
    )
      throw new DomainError(409, "Remote worker unavailable.");
    const binding = options.conversation.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    const value = z
      .object({ dispatchId: workerId, result: workerResult })
      .strict()
      .parse(await c.req.json());
    const runner = workerFor(binding);
    if (runner.id === "remote-documents") {
      if (!options.documents)
        throw new DomainError(409, "Document tools unavailable.");
      // Repeated result reconciliation is handled by the runner's durable receipt.
      if (!service.store.event(`remote-result:${value.dispatchId}`))
        options.documents.validateResult(
          binding,
          runner.request(binding, value.dispatchId),
          value.result,
        );
    }
    return c.json(runner.result(binding, value.dispatchId, value.result));
  });
  app.get("/api/executor/command", (c) => {
    if (
      (!options.remoteRunner && !options.documentRunner) ||
      !options.conversation
    )
      throw new DomainError(409, "Remote worker unavailable.");
    const binding = options.conversation.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    return c.json(
      workerFor(binding).command(
        binding,
        workerId.parse(c.req.query("dispatchId")),
      ),
    );
  });
  function documentContext(token: string) {
    const session = service.authenticateSession(token);
    if (
      !options.documents ||
      !options.conversation ||
      session.conversation?.runnerId !== "remote-documents"
    )
      throw new DomainError(409, "Read-only document tools are unavailable.");
    return {
      session,
      documents: options.documents,
      binding: options.documents.binding(session),
    };
  }
  app.get("/api/documents/grant", (c) => {
    const { documents, binding } = documentContext(
      bearer(c.req.header("authorization")),
    );
    return c.json({ grant: documents.grant(binding) });
  });
  app.post("/api/documents/stop", (c) => {
    const { documents, binding } = documentContext(
      bearer(c.req.header("authorization")),
    );
    return c.json(documents.stop(binding));
  });
  app.get("/api/documents/context", (c) => {
    const { documents, binding } = documentContext(
      bearer(c.req.header("authorization")),
    );
    return c.json(documents.context(binding));
  });
  app.get("/api/documents/transfers/:id", (c) => {
    const { documents, binding } = documentContext(
      bearer(c.req.header("authorization")),
    );
    if (!documents.attachments)
      throw new DomainError(409, "Attachment transport unavailable.");
    const item = documents.attachments.status(binding, c.req.param("id"));
    return c.json({
      id: item.id,
      state: item.state,
      filename: item.file.filename,
      delivery: item.delivery,
      receipt: item.receipt ? { evidence: item.receipt.evidence } : undefined,
    });
  });
  app.post("/api/documents/assets", async (c) => {
    const { documents, binding } = documentContext(
      bearer(c.req.header("authorization")),
    );
    const header = c.req.header("X-ClawdTime-Document");
    if (!header || header.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(header))
      throw new DomainError(400, "Bounded document metadata required.");
    const value = z
      .object({
        dispatchId: workerId,
        purpose: z.enum(["preview", "transfer"]),
        candidate: documentCandidateSchema,
        transferId: workerId.optional(),
      })
      .strict()
      .parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
    const runner = workerFor(binding);
    const request = runner.assertActive(binding, value.dispatchId);
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new DomainError(400, "Document bytes required.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > DOCUMENT_MAX_BYTES) {
          await reader.cancel();
          throw new DomainError(413, "Document exceeds the transfer bound.");
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      try {
        return c.json(
          await documents.upload(binding, request, value, bytes, () => {
            runner.assertActive(binding, value.dispatchId);
          }),
        );
      } finally {
        bytes.fill(0);
      }
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  });
  app.get("/document-preview", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    return c.html(
      readFileSync(
        new URL("../public/document-preview.html", import.meta.url),
        "utf8",
      ),
    );
  });
  app.get("/document-preview.js", (c) => {
    c.header("Content-Type", "application/javascript");
    c.header("Cache-Control", "no-store");
    return c.body(
      readFileSync(
        new URL("../public/document-preview.js", import.meta.url),
        "utf8",
      ),
    );
  });
  app.get("/document-previews/:id/:part", (c) => {
    if (!options.documents) throw new DomainError(404, "Preview unavailable.");
    const asset = options.documents.publicAsset(
      c.req.param("id"),
      bearer(c.req.header("authorization")),
    );
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (c.req.param("part") === "meta")
      return c.json({ name: asset.candidate.name, expiresAt: asset.expiresAt });
    if (c.req.param("part") !== "image")
      throw new DomainError(404, "Preview unavailable.");
    c.header("Content-Type", "image/png");
    return c.body(new Uint8Array(asset.bytes));
  });
  app.post("/api/control-grants", async (c) => {
    if (!options.conversation || !options.textDevice)
      throw new DomainError(409, "Text control is unavailable.");
    const session = service.authenticateSession(
      bearer(c.req.header("authorization")),
    );
    const binding = options.conversation.binding(session),
      pairing = service.pairing(binding.pairingId);
    if (!pairing.allowControl)
      throw new DomainError(403, "Pairing does not permit control.");
    const value = z
      .object({
        grantId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
        actions: z
          .array(z.enum(["click", "type", "scroll"]))
          .min(1)
          .max(3),
        durationSeconds: z.number().int().min(30).max(900),
        policyRevision: z.number().int().nonnegative(),
        localEnableGeneration: z.number().int().nonnegative(),
      })
      .strict()
      .parse(await c.req.json());
    const prior = service.store.get<TextControlGrant>(
      "text_grant_proposal",
      value.grantId,
    );
    if (prior) {
      if (prior.sessionId !== session.id)
        throw new DomainError(403, "Grant belongs to another session.");
      return c.json({ state: "pending", grantId: prior.id, reconcile: true });
    }
    const grant: TextControlGrant = {
      ...binding,
      id: value.grantId,
      kind: "text_session",
      deviceId: pairing.deviceId,
      displayId: pairing.displayId,
      projectRoot: session.projectRoot,
      surface: `display:${pairing.displayId}`,
      actions: [...new Set(value.actions)],
      expiresAt: service.clock() + value.durationSeconds * 1000,
      policyRevision: value.policyRevision,
      localEnableGeneration: value.localEnableGeneration,
      state: "active",
    };
    service.store.put("text_grant_proposal", grant);
    await options.textDevice.proposeGrant(grant);
    return c.json({
      state: "pending",
      grantId: grant.id,
      localApprovalRequired: true,
    });
  });
  app.get("/api/control-grants/:id", async (c) => {
    if (!options.conversation || !options.textDevice)
      throw new DomainError(409, "Text control unavailable.");
    const session = service.authenticateSession(
      bearer(c.req.header("authorization")),
    );
    options.conversation.binding(session);
    const grant = service.store.get<TextControlGrant>(
      "text_grant_proposal",
      c.req.param("id"),
    );
    if (!grant || grant.sessionId !== session.id)
      throw new DomainError(404, "Scoped grant unavailable.");
    const local = await options.textDevice.grantStatus(
      grant.deviceId,
      grant.id,
    );
    options.conversation.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    if (local.state === "active" && local.grant) {
      for (const key of Object.keys(grant) as (keyof TextControlGrant)[])
        if (JSON.stringify(local.grant[key]) !== JSON.stringify(grant[key]))
          throw new DomainError(409, "Local grant binding changed.");
      if (
        grant.expiresAt <= service.clock() ||
        service.store.get<TextControlGrant>("text_control_grant", grant.id)
          ?.state === "revoked"
      )
        throw new DomainError(409, "Grant expired or stopped.");
      service.store.put("text_control_grant", grant);
    }
    return c.json({ state: local.state, grantId: grant.id });
  });
  app.post("/api/conversation/turn", async (c) => {
    const frontend = options.conversation;
    if (!frontend)
      throw new DomainError(409, "Conversational broker is disabled.");
    const binding = frontend.binding(
      service.authenticateSession(bearer(c.req.header("authorization"))),
    );
    const value = z
      .object({
        eventId: z.string().min(1).max(160),
        text: z.string().trim().min(1).max(4000),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await frontend.receive(
        binding,
        { channel: "text", eventId: value.eventId },
        value.text,
      ),
    );
  });
  for (const path of Object.keys(websitePages) as WebsitePath[]) {
    app.get(path, (c) => {
      // Canonicalize only marketing HTML. Never redirect service APIs/callbacks.
      if (options.simulation || new URL(c.req.url).host !== canonicalHost)
        c.header("X-Robots-Tag", "noindex, follow");
      c.header("Link", `<${websiteOrigin}${path}>; rel="canonical"`);
      return c.html(
        websitePage(
          path,
          !options.simulation && options.dispatchEnabled === true
            ? options.publicTextNumber
            : undefined,
          options.websiteAnalyticsEnabled === true &&
            isWebsiteOrigin(
              c.req.url,
              options.simulation ? options.origin : websiteOrigin,
            ),
        ),
      );
    });
  }
  app.get("/robots.txt", (c) => c.text(websiteRobots));
  app.get("/sitemap.xml", (c) => {
    c.header("Content-Type", "application/xml; charset=utf-8");
    return c.body(websiteSitemap());
  });
  app.get("/install.sh", websiteInstallScript);
  app.get("/download", websiteDownload);
  app.post("/api/website/events", async (c) => {
    // Same-origin JSON only; no cookies or cross-site collection.
    if (
      !isWebsiteOrigin(c.req.url, c.req.header("origin")) ||
      c.req.header("sec-fetch-site") === "cross-site"
    )
      return c.json({ accepted: false }, 403);
    if (
      c.req.header("dnt") === "1" ||
      c.req.header("sec-gpc") === "1" ||
      /bot|crawler|spider|headless/i.test(c.req.header("user-agent") ?? "")
    )
      return c.body(null, 204);
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json({ accepted: false }, 400);
    }
    const result = websiteMetrics.recordBrowser(input);
    if (result.accepted) return c.body(null, 202);
    return c.json(
      { accepted: false },
      result.reason === "invalid"
        ? 400
        : result.reason === "rate_limited"
          ? 429
          : result.reason === "disabled"
            ? 404
            : 503,
    );
  });
  app.get("/api/operator/website-metrics", (c) => {
    if (!matches(bearer(c.req.header("authorization")), options.operatorToken))
      return c.json({ error: "Operator authorization required." }, 401);
    const days = Number(c.req.query("days") ?? 28);
    const report = websiteMetrics.report(days);
    return c.json(
      report.available
        ? {
            ...report,
            operational: readOperationalWebsiteMetrics(service.store, days),
          }
        : report,
      report.available
        ? 200
        : report.reason === "invalid"
          ? 400
          : report.reason === "disabled"
            ? 404
            : 503,
    );
  });
  app.get("/pair", (c) => {
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.html(
      readFileSync(new URL("../public/pair.html", import.meta.url), "utf8"),
    );
  });
  app.get("/setup", (c) => {
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.html(
      readFileSync(new URL("../public/setup.html", import.meta.url), "utf8"),
    );
  });
  app.get("/agents", (c) => {
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.body(
      readFileSync(new URL("../public/agents.txt", import.meta.url), "utf8"),
    );
  });
  app.get("/assets/:name", (c) => {
    const name = c.req.param("name");
    if (["chert-logo.png", "social-card.png"].includes(name)) {
      c.header("Content-Type", "image/png");
      return c.body(
        new Uint8Array(
          readFileSync(new URL(`../public/${name}`, import.meta.url)),
        ),
      );
    }
    if (
      ![
        "style.css",
        "pair.js",
        "landing.css",
        "landing.js",
        "website-analytics.js",
        "favicon.svg",
      ].includes(name)
    )
      return c.notFound();
    c.header(
      "Content-Type",
      name.endsWith("css")
        ? "text/css"
        : name.endsWith("svg")
          ? "image/svg+xml"
          : "text/javascript",
    );
    return c.body(
      readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"),
    );
  });
  app.post("/api/pairing/claim", async (c) =>
    c.json({
      baseUrl: allowedOrigins.has(new URL(c.req.url).origin)
        ? new URL(c.req.url).origin
        : options.origin,
      ...service.claimPairing(await c.req.json()),
    }),
  );
  app.post("/api/sessions", async (c) =>
    c.json(
      service.registerSession(
        bearer(c.req.header("authorization")),
        await c.req.json(),
      ),
    ),
  );
  async function voiceReady(token: string) {
    const session = service.authenticateSession(token);
    if (!session.voiceFrontend) return true;
    if (
      !options.elevenLabsEnabled ||
      !options.twoWayVoiceEnabled ||
      !options.remoteAudioIsolated
    )
      return false;
    if (options.simulation) return true;
    try {
      return (await options.elevenLabsReadiness?.())?.ready === true;
    } catch {
      return false;
    }
  }
  async function requireVoiceReady(token: string) {
    if (!(await voiceReady(token)))
      throw new DomainError(
        409,
        "Dedicated streaming voice frontend is not ready; no call was placed.",
      );
  }
  app.get("/api/doctor", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const result = service.doctor(token);
    if (!result.session?.voiceFrontend) return c.json(result);
    const ready = await voiceReady(token);
    return c.json({
      ...result,
      ready: result.ready && ready,
      voiceFrontendReady: ready,
      readiness: {
        ...result.readiness,
        liveReady: result.readiness.liveReady && ready,
        checks: [
          ...result.readiness.checks,
          {
            id: "streaming_voice",
            status: ready ? "pass" : "fail",
            message: ready
              ? "Dedicated streaming voice configuration validated; handset performance is unverified."
              : "Enable and validate the dedicated ElevenLabs frontend before calling.",
          },
        ],
      },
    });
  });
  app.get("/api/setup/test", (c) =>
    c.json(setup.get(bearer(c.req.header("authorization")))),
  );
  app.post("/api/setup/test/authorize", async (c) => {
    const { testId, userAuthorizedCall } = z
      .object({
        testId: z.string().min(1).max(200),
        userAuthorizedCall: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      setup.authorize(
        bearer(c.req.header("authorization")),
        testId,
        userAuthorizedCall,
      ),
    );
  });
  app.post("/api/setup/test/retry", async (c) => {
    const { previousTestId } = z
      .object({ previousTestId: z.string().min(1).max(200) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      setup.retry(bearer(c.req.header("authorization")), previousTestId),
    );
  });
  for (const [path, action] of [
    ["/api/setup/test", (token: string) => setup.invite(token)],
    ["/api/setup/test/start", (token: string) => setup.start(token)],
    ["/api/setup/test/verify", (token: string) => setup.verify(token)],
    ["/api/setup/test/cancel", (token: string) => setup.cancel(token)],
  ] as const)
    app.post(path, async (c) => {
      z.object({})
        .strict()
        .parse(await c.req.json());
      if (path === "/api/setup/test/start")
        await requireVoiceReady(bearer(c.req.header("authorization")));
      return c.json(action(bearer(c.req.header("authorization"))));
    });
  app.post("/api/attention", async (c) => {
    await requireVoiceReady(bearer(c.req.header("authorization")));
    const request = service.requestAttention(
      bearer(c.req.header("authorization")),
      await c.req.json(),
    );
    return c.json({ request }, 202);
  });
  app.get("/api/attention/:id", (c) =>
    c.json({
      request: service.status(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    }),
  );
  app.get("/api/attention/:id/result", (c) => {
    const token = bearer(c.req.header("authorization")),
      result = service.result(token, c.req.param("id")),
      session = service.authenticateSession(token);
    const leases = service.store
      .all<ControlLease>("lease")
      .filter((l) => l.requestId === result.request.id);
    return c.json({
      ...result,
      session,
      leases,
      actions: service.store
        .all<ActionReceipt>("action")
        .filter((a) => leases.some((l) => l.id === a.leaseId)),
    });
  });
  // Version 2 is negotiated at registration, never inferred from an active call.
  app.get("/api/conversation/inbox", (c) =>
    c.json(human.turns.inbox(bearer(c.req.header("authorization")))),
  );
  app.get("/api/attention/:id/conversation/turns", async (c) => {
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0)
      .parse(c.req.query("after"));
    await human.turns.reconcileReplies(
      bearer(c.req.header("authorization")),
      c.req.param("id"),
    );
    return c.json({
      ...human.turns.poll(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        after,
      ),
      hold: interruptions.status(c.req.param("id")),
    });
  });
  app.post("/api/attention/:id/conversation/ack", async (c) => {
    const b = z
      .object({ turnId: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      human.turns.acknowledge(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        b.turnId,
      ),
    );
  });
  app.post("/api/attention/:id/conversation/progress", async (c) => {
    const b = z
      .object({
        turnId: z.string().min(1),
        presentation: presentationSchema.optional(),
        state: z.enum([
          "executing",
          "completed",
          "canceled",
          "uncertain",
          "pending_approval",
        ]),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      human.turns.progress(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        b.turnId,
        b.state,
        b.presentation,
      ),
    );
  });
  app.post("/api/attention/:id/conversation/reply", async (c) => {
    const b = z
      .object({
        turnId: z.string().min(1),
        replyId: z.string().min(1),
        text: z.string().min(1).max(900),
        expectedCursor: z.number().int().nonnegative().safe().optional(),
        channel: z.enum(["text", "voice"]).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await human.turns.reply(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        b,
      ),
    );
  });
  app.post("/api/attention/:id/conversation/cancel", async (c) => {
    const b = z
      .object({ turnId: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      human.turns.cancel(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        b.turnId,
      ),
    );
  });
  app.post("/api/attention/:id/conversation/end", async (c) => {
    const r = human.turns.end(
      bearer(c.req.header("authorization")),
      c.req.param("id"),
    );
    execution.stop(c.req.param("id"));
    voicePresentation.clear(c.req.param("id"));
    await control.stopPairing(r.request.pairingId);
    return c.json(r);
  });
  app.get("/api/attention/:id/conversation/execution", (c) => {
    const owner = execution.status(
      bearer(c.req.header("authorization")),
      c.req.param("id"),
    );
    const leases = service.store
      .all<ControlLease>("lease")
      .filter((l) => l.requestId === owner.requestId);
    const actions = service.store
      .all<ActionReceipt>("action")
      .filter((a) => leases.some((l) => l.id === a.leaseId));
    return c.json({
      ...owner,
      leases,
      actions,
      viewingStopped: Boolean(
        service.store.state(`view-stopped:${owner.requestId}`),
      ),
      ...human.turns.executionRevision(owner.requestId),
      hold: interruptions.status(owner.requestId),
      nativeCancellation: "cooperative_host_dependent",
    });
  });
  app.post("/api/attention/:id/conversation/execution", async (c) => {
    service.status(bearer(c.req.header("authorization")), c.req.param("id"));
    if (livePresentation.hasUnresolved(c.req.param("id")))
      throw new DomainError(
        409,
        "Presentation outcome unresolved; inspect its receipt before transfer.",
      );
    return c.json(
      await execution.transition(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        await c.req.json(),
      ),
    );
  });
  app.get("/api/attention/:id/conversation/native-activation/status", (c) =>
    c.json(
      nativeActivation.status(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    ),
  );
  app.get(
    "/api/attention/:id/conversation/native-activation/receipts/:operationId",
    (c) =>
      c.json(
        nativeActivation.receipt(
          bearer(c.req.header("authorization")),
          c.req.param("id"),
          c.req.param("operationId"),
        ),
      ),
  );
  for (const method of [
    "prepare",
    "dispatch",
    "reconcile",
    "cancel",
  ] as const) {
    app.post(
      `/api/attention/:id/conversation/native-activation/${method}`,
      async (c) =>
        c.json(
          await nativeActivation[method](
            bearer(c.req.header("authorization")),
            c.req.param("id"),
            await c.req.json(),
          ),
        ),
    );
  }
  app.get("/api/attention/:id/conversation/native-activation", (c) =>
    c.json(
      nativeActivation.status(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    ),
  );
  app.get("/api/attention/:id/conversation/presentation", async (c) =>
    c.json(
      await livePresentation.status(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    ),
  );
  app.post("/api/attention/:id/conversation/presentation", async (c) =>
    c.json(
      await livePresentation.present(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        await c.req.json(),
      ),
    ),
  );
  app.get(
    "/api/attention/:id/conversation/presentation/receipts/:commandId",
    (c) =>
      c.json(
        livePresentation.receipt(
          bearer(c.req.header("authorization")),
          c.req.param("id"),
          c.req.param("commandId"),
        ),
      ),
  );
  app.post("/api/attention/:id/conversation/voice/prepare", async (c) => {
    const token = bearer(c.req.header("authorization"));
    const request = service.status(token, c.req.param("id"));
    const session = service.authenticateSession(token);
    const check = () => {
      const ctx = qualifiedVoice(mediaId(request.id));
      if (ctx.session.id !== session.id)
        throw new DomainError(403, "Exact voice session required.");
    };
    return c.json(
      await voicePresentation.prepare(
        session,
        request.id,
        await c.req.json(),
        check,
      ),
    );
  });
  app.get("/api/attention/:id/conversation/camera", async (c) =>
    c.json(
      await camera.status(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
      ),
    ),
  );
  app.post("/api/attention/:id/conversation/camera", async (c) =>
    c.json(
      await camera.command(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        await c.req.json(),
      ),
    ),
  );
  app.post("/api/attention/:id/conversation/observe", async (c) => {
    const b = z
      .object({ epoch: z.number().int().nonnegative() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await execution.observe(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        b.epoch,
      ),
    );
  });
  app.post("/api/attention/:id/conversation/act", async (c) =>
    c.json(
      await execution.act(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        await c.req.json(),
      ),
    ),
  );
  app.get("/api/attention/:id/diagnostics", async (c) => {
    const request = service.status(
      bearer(c.req.header("authorization")),
      c.req.param("id"),
    );
    return c.json({
      requestId: request.id,
      call: request.callId
        ? service.store.get<CallSession>("call", request.callId)
        : null,
      conversationTimeline: timelineFor(service).snapshot(request.id),
      controlTiming: control.timing.snapshot(request.id),
      capturedFrame: service.store.state(`setup-view:${request.id}`) ?? null,
      controlPreflight:
        service.store.state(`control-preflight:${request.id}`) ?? null,
      screenStop: service.store.state(`screen-stop:${request.id}`) ?? null,
      callTermination:
        service.store.state(`call-termination:${request.id}`) ?? null,
      mediaFailure: service.store.state(`media-failure:${request.id}`) ?? null,
      media: options.callDiagnostics
        ? await options.callDiagnostics(request.id)
        : { state: "simulation", physicalAcceptance: false },
    });
  });
  app.post("/api/attention/:id/ack", async (c) =>
    c.json({
      response: service.ack(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        (await c.req.json()).responseId,
      ),
    }),
  );
  app.post("/api/attention/:id/resume", async (c) =>
    c.json(
      service.resume(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        (await c.req.json()).controlEpoch,
      ),
    ),
  );
  app.post("/api/attention/:id/terminal-ack", async (c) => {
    const { controlEpoch } = z
      .object({ controlEpoch: z.number().int().nonnegative() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      service.acknowledgeTerminal(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        controlEpoch,
      ),
    );
  });
  app.post("/api/attention/:id/complete", async (c) =>
    c.json({
      request: service.complete(
        bearer(c.req.header("authorization")),
        c.req.param("id"),
        (await c.req.json()).text,
      ),
    }),
  );
  app.post("/api/sessions/yield", (c) =>
    c.json({
      session: service.yieldSession(bearer(c.req.header("authorization"))),
    }),
  );
  app.post("/api/sessions/heartbeat", (c) =>
    c.json({
      session: service.heartbeat(bearer(c.req.header("authorization"))),
    }),
  );
  app.post("/api/disconnect", async (c) => {
    const token = bearer(c.req.header("authorization")),
      doctor = service.doctor(token);
    if (options.documents)
      for (const session of service.store.all<AgentSession>("session"))
        if (session.pairingId === doctor.pairing.id && session.documentAccess)
          options.documents.stop(options.documents.binding(session));
    const result = service.disconnect(token);
    await control.stopPairing(doctor.pairing.id);
    return c.json(result);
  });
  app.use("/internal/*", async (c, next) => {
    if (!matches(bearer(c.req.header("authorization")), options.operatorToken))
      return c.json({ error: "Operator authentication required." }, 401);
    await next();
  });
  async function audioTestReadiness() {
    const media = options.audioQualificationReadiness
      ? await options.audioQualificationReadiness()
      : {
          enabled: options.simulation,
          directKeyConfigured: options.simulation,
          websocketQualified: options.simulation,
          transportReady: options.simulation,
          sdk: { available: options.simulation },
        };
    const enabled = options.audioQualificationEnabled === true;
    const dispatchEnabled = options.dispatchEnabled ?? options.simulation;
    return {
      version: 1,
      enabled,
      dispatchEnabled,
      ready:
        enabled &&
        dispatchEnabled &&
        media.enabled &&
        media.directKeyConfigured &&
        media.websocketQualified &&
        media.transportReady &&
        media.sdk.available,
      media,
      executionDisabled: true,
      maxDurationSeconds: 300,
      requiresFreshCallReadiness: true,
      physicalAcceptance: false,
    };
  }
  app.get("/internal/audio-qualifications/readiness", async (c) =>
    c.json(await audioTestReadiness()),
  );
  app.post("/internal/audio-qualifications", async (c) => {
    if (
      !options.audioQualificationEnabled ||
      !(options.dispatchEnabled ?? options.simulation)
    )
      throw new DomainError(409, "Audio qualification admission is disabled.");
    const input = z
      .object({
        pairingId: z.string().min(1).max(160),
        idempotencyKey: z.string().min(16).max(160),
        durationSeconds: z.number().int().min(30).max(300),
        readyForOneCall: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    if (!(await audioTestReadiness()).ready)
      throw new DomainError(409, "Audio qualification media is unavailable.");
    // This is the only admission route. Deployment and readiness reads never call it.
    return c.json(service.requestAudioQualification(input), 201);
  });
  app.get("/internal/audio-qualifications/:id", (c) =>
    c.json(service.audioQualificationStatus(c.req.param("id"))),
  );
  app.post("/internal/audio-qualifications/:id/stop", (c) =>
    c.json(service.stopAudioQualification(c.req.param("id"))),
  );
  app.post("/internal/obsolete-notices/retire", async (c) => {
    if (!options.retireObsoleteNotice) return c.notFound();
    const { acknowledgeUnknown: _ack, ...input } = z
      .object({
        noticeId: z.string().min(1).max(200),
        pairingId: z.string().min(1).max(200),
        evidenceReference: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        acknowledgeUnknown: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    options.retireObsoleteNotice(input);
    return c.json({
      retiredFromGating: true,
      deliveryOutcome: "unknown",
      replayAllowed: false,
    });
  });
  app.post("/internal/calls/reconcile-undialed", async (c) => {
    const { requestId, evidenceReference } = z
      .object({
        requestId: z.string().min(1).max(200),
        evidenceReference: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        acknowledgeUnknown: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    const audit = service.reconcileUndialedCall({
      requestId,
      evidenceReference,
    });
    return c.json({
      reconciled: true,
      effectId: audit.effectId,
      dialSent: false,
      replayAllowed: false,
    });
  });
  app.post("/internal/setup-invitations/retire", async (c) => {
    if (!options.retireSetupInvitation) return c.notFound();
    const result = options.retireSetupInvitation(
      setupRetirementInput.parse(await c.req.json()),
    );
    return c.json({
      retiredFromGating: true,
      result,
      deliveryOutcome: "unknown",
      replayAllowed: false,
    });
  });
  app.get("/internal/readiness", (c) =>
    c.json({
      mode: service.transport.mode,
      pending: service.store.effects("pending").length,
      unknown: service.store.effects("unknown").length,
      activeCalls: service.store
        .all<CallSession>("call")
        .filter((s) => s.state !== "ended").length,
      physicalAcceptance: false,
    }),
  );
  app.post("/internal/pairing", async (c) => {
    const value = await c.req.json();
    const invite = service.createPairingInvite(value);
    return c.json({
      ...invite,
      url: `${options.origin}/pair#token=${encodeURIComponent(invite.token)}&device=${encodeURIComponent(value.deviceId)}&display=${encodeURIComponent(value.displayId)}`,
    });
  });
  app.post("/internal/simulation/call", async (c) => {
    if (!options.simulation) return c.notFound();
    const b = await c.req.json();
    return c.json(
      service.observeCall(b.requestId, b.state, b.qualified === true),
    );
  });
  app.post("/internal/simulation/human", async (c) => {
    if (!options.simulation) return c.notFound();
    return c.json(await human.receive(await c.req.json()));
  });
  app.post("/internal/drain", async (c) => {
    await service.drain({
      cleanupOnly: !(options.dispatchEnabled ?? options.simulation),
    });
    return c.json({ ok: true });
  });
  app.use("/media/*", async (c, next) => {
    if (!matches(bearer(c.req.header("authorization")), options.mediaToken))
      return c.json({ error: "Media authentication required." }, 401);
    await next();
  });
  function mediaContext(id: string) {
    const request = service.store
      .all<AttentionRequest>("attention")
      .find((r) => mediaId(r.id) === id);
    if (!request) throw new DomainError(404, "Unknown media session.");
    const pairing = service.store.get<Pairing>("pairing", request.pairingId)!;
    const call = service.store
      .all<CallSession>("call")
      .find((c) => c.requestId === request.id);
    const session = service.store.get<AgentSession>(
      "session",
      request.sessionId,
    )!;
    return { request, pairing, call, session };
  }
  function isAudioQualification(context: ReturnType<typeof mediaContext>) {
    return [context.session, context.request, context.call].some(
      (entity) => entity?.audioQualification !== undefined,
    );
  }
  // Presence denies every ordinary media instruction path, even malformed/mismatched metadata.
  app.use("/media/:id/*", async (c, next) => {
    const context = mediaContext(c.req.param("id"));
    if (
      isAudioQualification(context) &&
      !["policy", "failure", "screen-stopped"].includes(
        c.req.path.split("/").at(-1)!,
      )
    )
      throw new DomainError(
        403,
        "Audio qualification cannot deliver instructions.",
      );
    await next();
  });
  app.post("/media/:id/native-activation-authority", async (c) => {
    if (c.req.header("Origin"))
      throw new DomainError(403, "Server bridge required.");
    const { session, request } = mediaContext(c.req.param("id"));
    const body = z
      .object({ envelope: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      nativeActivation.authority(session, request.id, body.envelope),
    );
  });
  app.post("/media/:id/presentation-qualification", async (c) => {
    if (c.req.header("Origin"))
      throw new DomainError(403, "Server bridge required.");
    const { session, request } = mediaContext(c.req.param("id"));
    const body = z
      .object({ qualification: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      livePresentation.qualification(session, request.id, body.qualification),
    );
  });
  app.post("/media/:id/presentation-authority", async (c) => {
    if (c.req.header("Origin"))
      throw new DomainError(403, "Server bridge required.");
    const { session, request } = mediaContext(c.req.param("id"));
    const body = z
      .object({ presentation: livePresentationSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      livePresentation.authority(session, request.id, body.presentation),
    );
  });
  function qualifiedVoice(id: string) {
    const context = mediaContext(id);
    const { request, session, call, pairing } = context;
    const now = service.clock();
    if (
      !options.elevenLabsEnabled ||
      !options.twoWayVoiceEnabled ||
      !options.remoteAudioIsolated ||
      session.voiceFrontend?.provider !== "elevenlabs" ||
      session.protocolVersion !== 2 ||
      session.conversation ||
      session.documentAccess ||
      isAudioQualification(context) ||
      session.capabilities.voiceInteractionVersion !== 1 ||
      session.state === "stopped" ||
      pairing.revokedAt !== undefined ||
      now - (session.lastSeenAt ?? session.createdAt) >= 20000 ||
      (session.lastSeenAt ?? session.createdAt) > now + 1000 ||
      request.deadline <= now ||
      !["connected", "awaiting_input"].includes(request.state) ||
      !call ||
      request.callId !== call.id ||
      call.state !== "connected" ||
      !call.remoteParticipantQualified ||
      service.store.state(`muted:${request.id}`) ||
      service.store.state(`listening-stopped:${request.id}`)
    )
      throw new DomainError(
        403,
        "Qualified same-chat streaming voice required.",
      );
    service.assertExecutionAllowed(session);
    return { ...context, call };
  }
  function voiceInput(id: string, value: { callId: string }) {
    const ctx = qualifiedVoice(id);
    if (value.callId !== ctx.call.id)
      throw new DomainError(403, "Voice call identity mismatch.");
    return ctx;
  }
  app.get("/media/:id/voice/context", (c) => {
    const { request } = qualifiedVoice(c.req.param("id"));
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .safe()
      .default(0)
      .parse(c.req.query("after"));
    const prepared = voicePresentation.context(request.id);
    const activity = presentationFor(service).projection(request.id);
    const sequence = activity?.sequence ?? 0;
    return c.json({
      sequence,
      context: service.store.state(`view-stopped:${request.id}`)
        ? "Screen sharing is stopped. " + request.question.slice(0, 1900)
        : (prepared?.context ?? request.question.slice(0, 2000)),
      cameraTargets:
        prepared?.targets.map((t) => ({ id: t.id, label: t.label })) ?? [],
      updates:
        activity && sequence > after
          ? [
              {
                id: `progress_${sequence}`,
                revision: sequence,
                text: JSON.stringify({
                  state: activity.work,
                  summary: activity.currentSummary,
                  outcome: activity.outcome,
                }),
              },
            ]
          : [],
    });
  });
  app.post("/media/:id/voice/intent", async (c) => {
    const value = voiceEventSchema
      .extend({ text: z.string().trim().min(1).max(8000) })
      .strict()
      .parse(await c.req.json());
    const { request, pairing, call } = voiceInput(c.req.param("id"), value);
    const result = await human.receive({
      eventId: `voice-intent:${request.id}:${value.eventId}`,
      requestId: request.id,
      memberId: pairing.memberId,
      lineId: pairing.lineId,
      conversationId: pairing.conversationId,
      channel: "voice",
      text: value.text,
      callId: call.id,
      qualifiedRemoteAudio: true,
    });
    return c.json(result);
  });
  app.post("/media/:id/voice/camera", async (c) => {
    const value = voiceCameraSchema.parse(await c.req.json());
    const { request, session, pairing } = voiceInput(c.req.param("id"), value);
    if (value.action === "stop") {
      service.store.saveState(`view-stopped:${request.id}`, true);
      voicePresentation.clear(request.id);
      execution.stop(request.id);
      await control.stopPairing(pairing.id);
      return c.json({ accepted: true, reply: "Sharing stopped." });
    }
    return c.json(
      await voicePresentation.command(session, request.id, value, () => {
        voiceInput(c.req.param("id"), value);
      }),
    );
  });
  app.post("/media/:id/voice/end", async (c) => {
    const value = voiceEventSchema.parse(await c.req.json());
    const { request, session, call, pairing } = voiceInput(
      c.req.param("id"),
      value,
    );
    service.endConversationFromBoundCall(request.id, session.id, call.id);
    voicePresentation.clear(request.id);
    execution.stop(request.id);
    await control.stopPairing(pairing.id);
    return c.json({ accepted: true, reply: "Call ending; cleanup requested." });
  });
  function conversationalMedia(id: string) {
    const context = mediaContext(id);
    const { request, call, session } = context;
    if (session.documentAccess) {
      if (!options.documents)
        throw new DomainError(409, "Document authority unavailable.");
      options.documents.grant(options.documents.binding(session));
    }
    if (
      !options.conversation ||
      !options.twoWayVoiceEnabled ||
      !options.remoteAudioIsolated ||
      !session.conversation ||
      session.capabilities.voiceInteractionVersion !== 1 ||
      call?.state !== "connected" ||
      !call.remoteParticipantQualified ||
      request.deadline <= service.clock() ||
      !["connected", "awaiting_input"].includes(request.state) ||
      service.store.state(`listening-stopped:${request.id}`) ||
      service.store.state(`muted:${request.id}`)
    )
      throw new DomainError(
        409,
        "Qualified conversational voice is unavailable.",
      );
    return {
      ...context,
      frontend: options.conversation,
      binding: options.conversation.binding(session),
    };
  }
  app.get("/media/:id/conversation/jobs", (c) => {
    const { frontend, binding } = conversationalMedia(c.req.param("id"));
    return c.json({
      jobs: frontend.broker
        .list(binding)
        .map((job) => ({ ...job, report: frontend.describe(job, "voice") })),
      sequence: frontend.broker.currentSequence(binding),
    });
  });
  app.post("/media/:id/conversation/turn", async (c) => {
    const { frontend, binding, call } = conversationalMedia(c.req.param("id"));
    const value = z
      .object({
        eventId: z.string().min(1).max(160),
        text: z.string().trim().min(1).max(4000),
        callId: z.string().min(1),
        qualifiedRemoteAudio: z.literal(true),
        context: z
          .array(
            z
              .object({
                role: z.enum(["user", "assistant"]),
                text: z.string().max(3000),
              })
              .strict(),
          )
          .max(8)
          .refine(
            (items) =>
              items.reduce((n, item) => n + item.text.length, 0) <= 3000,
          )
          .optional(),
      })
      .strict()
      .parse(await c.req.json());
    if (value.callId !== call!.id)
      throw new DomainError(403, "Voice call identity mismatch.");
    return c.json(
      await frontend.receive(
        binding,
        { channel: "voice", eventId: value.eventId },
        value.text,
        () => {
          conversationalMedia(c.req.param("id"));
        },
        value.context,
      ),
    );
  });
  app.get("/media/:id/policy", (c) => {
    const { request, pairing, call, session } = mediaContext(c.req.param("id")),
      now = service.clock();
    if (isAudioQualification({ request, pairing, call, session })) {
      const schema = z
        .object({
          version: z.literal(1),
          executionDisabled: z.literal(true),
          expiresAt: z.number().finite().int(),
        })
        .strict();
      const values = [session, request, call].map((entity) =>
        schema.safeParse(entity?.audioQualification),
      );
      const first = values[0];
      const q = first?.success ? first.data : undefined;
      const valid =
        q &&
        values.every((v) => v.success && v.data.expiresAt === q.expiresAt) &&
        q.expiresAt <= session.createdAt + 300_000 &&
        q.expiresAt === request.deadline &&
        session.adapter === "audio-qualification" &&
        session.protocolVersion === 2 &&
        !session.conversation &&
        !session.interaction &&
        session.pairingId === pairing.id &&
        call?.pairingId === pairing.id &&
        call.requestId === request.id &&
        request.callId === call.id;
      const listening =
        valid &&
        options.audioQualificationEnabled === true &&
        !pairing.revokedAt &&
        session.state === "active" &&
        Number.isFinite(session.lastSeenAt ?? session.createdAt) &&
        now - (session.lastSeenAt ?? session.createdAt) < 20_000 &&
        (session.lastSeenAt ?? session.createdAt) <= now + 1000 &&
        q.expiresAt > now &&
        call?.state === "connected" &&
        call.remoteParticipantQualified &&
        ["connected", "awaiting_input"].includes(request.state) &&
        !service.store.state(`listening-stopped:${request.id}`) &&
        !service.store.state(`view-stopped:${request.id}`) &&
        !service.store.state(`muted:${request.id}`);
      return c.json({
        state: listening ? "listening" : "ended",
        muted: !listening,
        protocolVersion: 2,
        voiceMode: "audio_qualification",
        remoteAudioIsolated: false,
        captionsEnabled: false,
        callId: call?.id,
        audioQualification: {
          version: 1,
          executionDisabled: true,
          expiresAt: new Date(q?.expiresAt ?? now).toISOString(),
        },
        expiresAt: new Date(
          Math.min(now + 2000, q?.expiresAt ?? now),
        ).toISOString(),
      });
    }
    let documentAuthorized = !session.documentAccess;
    if (session.documentAccess && options.documents) {
      try {
        options.documents.grant(options.documents.binding(session));
        documentAuthorized = true;
      } catch {}
    }
    const open =
      (!session.voiceFrontend ||
        (options.elevenLabsEnabled &&
          options.twoWayVoiceEnabled &&
          options.remoteAudioIsolated)) &&
      documentAuthorized &&
      !pairing.revokedAt &&
      session.state !== "stopped" &&
      now - (session.lastSeenAt ?? session.createdAt) <= 20_000 &&
      call?.state === "connected" &&
      call.remoteParticipantQualified &&
      request.deadline > now &&
      ["connected", "awaiting_input", "response_delivered"].includes(
        request.state,
      ) &&
      !service.store.state(`listening-stopped:${request.id}`);
    const lease = service.store
      .all<ControlLease>("lease")
      .find(
        (l) =>
          l.requestId === request.id &&
          l.state === "active" &&
          l.expiresAt > now,
      );
    const selection =
      open &&
      !session.documentAccess &&
      (!session.screenCamera ||
        (options.screenCameraEnabled === true &&
          c.req.header("X-ClawdTime-Camera") === "1" &&
          lease?.cameraVersion === 1 &&
          isDeepStrictEqual(lease.surface, session.screenCamera.surface))) &&
      !service.store.state(`view-stopped:${request.id}`) &&
      lease &&
      (session.protocolVersion === 2 || session.state === "yielded") &&
      session.controlEpoch === lease.epoch
        ? {
            ...(options.screenCameraEnabled &&
            session.screenCamera &&
            lease.cameraVersion === 1
              ? { cameraVersion: 1, surface: lease.surface }
              : {}),
            leaseId: lease.id,
            deviceId: lease.deviceId,
            alias: "Paired Mac",
            memberId: lease.memberId,
            callId: lease.callId,
            displayId: Number(lease.displayId),
            mode: lease.mode,
            expiresAt: new Date(lease.expiresAt).toISOString(),
            ...(lease.protocolVersion === 2
              ? {
                  protocolVersion: 2,
                  sessionId: lease.sessionId,
                  executor: lease.executor,
                  executorEpoch: lease.executorEpoch,
                  policyRevision: lease.policyRevision,
                }
              : {}),
          }
        : undefined;
    return c.json({
      state: open ? "listening" : "ended",
      sessionId: session.id,
      muted: service.store.state(`muted:${request.id}`) === true,
      protocolVersion: session.protocolVersion ?? 1,
      ...(session.voiceFrontend?.provider === "elevenlabs"
        ? { conversationVersion: 1, conversationFrontend: "elevenlabs" }
        : options.conversation &&
            session.conversation?.version === 1 &&
            options.twoWayVoiceEnabled &&
            options.remoteAudioIsolated &&
            session.capabilities.voiceInteractionVersion === 1
          ? { conversationVersion: 1, conversationFrontend: "gpt_live" }
          : {}),
      ...(session.protocolVersion === 2
        ? {
            voiceMode:
              options.twoWayVoiceEnabled === true &&
              options.remoteAudioIsolated === true &&
              session.capabilities.voiceInteractionVersion === 1
                ? "two_way"
                : "half_duplex",
            remoteAudioIsolated: options.remoteAudioIsolated === true,
            voiceInteractionVersion:
              session.capabilities.voiceInteractionVersion,
            conversationRevision: human.turns.executionRevision(request.id)
              .cursor,
          }
        : {}),
      ...(session.protocolVersion === 2 &&
      !session.documentAccess &&
      c.req.header("X-ClawdTime-Presentation") === "1"
        ? {
            presentationSequence: presentationFor(service).projection(
              request.id,
            ).sequence,
            presentationBinding: {
              sessionId: session.id,
              memberId: pairing.memberId,
              deviceId: pairing.deviceId,
              displayId: Number(pairing.displayId),
            },
          }
        : {}),
      captionsEnabled: open,
      callId: call?.id,
      expiresAt: new Date(now + 20_000).toISOString(),
      ...(selection ? { screenSelection: selection } : {}),
      ...(open &&
      !selection &&
      call &&
      pairing.allowView &&
      !service.store.state(`view-stopped:${request.id}`) &&
      options.documents
        ? {
            documentPreview: options.documents.previewPolicy(
              options.documents.binding(session),
              call.id,
            ),
          }
        : {}),
    });
  });
  app.get("/media/:id/document-preview/:previewId", (c) => {
    const { request, pairing, call, session } = mediaContext(c.req.param("id"));
    if (
      !options.documents ||
      !pairing.allowView ||
      session.state === "stopped" ||
      call?.state !== "connected" ||
      !call.remoteParticipantQualified ||
      request.deadline <= service.clock() ||
      !["connected", "awaiting_input", "response_delivered"].includes(
        request.state,
      ) ||
      service.store.state(`view-stopped:${request.id}`) ||
      service.store.state(`listening-stopped:${request.id}`)
    )
      throw new DomainError(
        403,
        "Document viewing is not active for this call.",
      );
    const asset = options.documents.mediaAsset(
      options.documents.binding(session),
      call.id,
      c.req.param("previewId"),
    );
    c.header("Cache-Control", "no-store");
    c.header("Content-Type", "image/png");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(asset.bytes));
  });
  app.post("/media/:id/interrupt", async (c) => {
    const { request, pairing, call, session } = mediaContext(c.req.param("id"));
    const input = interruptionSchema.parse(await c.req.json());
    const now = service.clock();
    if (
      !options.twoWayVoiceEnabled ||
      !options.remoteAudioIsolated ||
      session.protocolVersion !== 2 ||
      session.capabilities.voiceInteractionVersion !== 1 ||
      pairing.revokedAt !== undefined ||
      session.state === "stopped" ||
      now - (session.lastSeenAt ?? session.createdAt) >= 20_000 ||
      (session.lastSeenAt ?? session.createdAt) > now + 1000 ||
      request.deadline <= now ||
      !["connected", "awaiting_input"].includes(request.state) ||
      !call ||
      call.state !== "connected" ||
      !call.remoteParticipantQualified ||
      input.callId !== call.id ||
      input.participantIdentity !== `worker-${c.req.param("id")}` ||
      service.store.state(`muted:${request.id}`) === true ||
      service.store.state(`listening-stopped:${request.id}`) ||
      (service.store.state(`view-stopped:${request.id}`) &&
        !session.voiceFrontend)
    )
      throw new DomainError(403, "Qualified two-way audio required.");
    const receipt = interruptions.accept(request.id, input);
    if (options.conversation && session.conversation?.version === 1)
      options.conversation.broker.hold(options.conversation.binding(session), {
        channel: "voice",
        eventId: `speech-hold:${input.interruptionId}`,
      });
    return c.json(receipt);
  });
  app.post("/media/:id/segments", async (c) => {
    const { request, pairing, call, session } = mediaContext(c.req.param("id")),
      b = await c.req.json();
    if (service.store.state(`listening-stopped:${request.id}`))
      return c.json({ captured: false, stopped: true });
    if (
      !call ||
      b.source !== "remote_participant" ||
      b.callId !== call.id ||
      b.participantIdentity !== `worker-${c.req.param("id")}`
    )
      throw new DomainError(403, "Unqualified audio source.");
    const heard = z.string().min(1).max(8000).parse(b.text);
    const input = {
      eventId: `voice:${c.req.param("id")}:${z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9_-]+$/)
        .parse(b.id)}`,
      requestId: request.id,
      memberId: pairing.memberId,
      lineId: pairing.lineId,
      conversationId: pairing.conversationId,
      channel: "voice" as const,
      text: heard,
      callId: call.id,
      qualifiedRemoteAudio: true,
    };
    // An exact acknowledged or in-flight command may be reconciled after its
    // timestamp ages out. This only reads its original receipt, never dispatches
    // another turn. Current qualified call/member binding still applies.
    try {
      const previous = human.reconcile(input);
      if (previous)
        return c.json({
          ...previous,
          captured:
            previous.stopped !== true &&
            (previous.accepted === true ||
              !!previous.reply ||
              !!previous.clarification),
        });
    } catch (error) {
      if (error instanceof HumanCommandConflict)
        return c.json(
          {
            error: "Event content changed.",
            errorCode: "segment_conflict",
            captured: false,
          },
          409,
        );
      throw error;
    }
    if (
      service.store.state(`muted:${request.id}`) === true &&
      !isImmediateStop(heard)
    )
      return c.json({ captured: false, muted: true });
    if (
      Math.abs(Date.now() - Date.parse(b.at)) > 10_000 ||
      !Number.isFinite(Date.parse(b.at))
    )
      return c.json(
        { error: "Stale speech.", errorCode: "stale_speech", captured: false },
        409,
      );
    // The qualified private-call participant speaks naturally. Intent belongs
    // to the conversation agent; a wake phrase is not authentication.
    const command = heard;
    const immediateStop = isImmediateStop(command);
    if (immediateStop && session.documentAccess && options.documents)
      options.documents.stop(options.documents.binding(session));
    if (immediateStop && session.protocolVersion !== 2) {
      service.store.saveState(`listening-stopped:${request.id}`, true);
    }
    const result = (await human.receive(input)) as {
      accepted?: boolean;
      reply?: string;
      clarification?: string;
    };
    return c.json({
      ...result,
      captured:
        !immediateStop &&
        (result.accepted === true || !!result.reply || !!result.clarification),
    });
  });
  app.post("/media/:id/screen-stopped", async (c) => {
    const { request, session } = mediaContext(c.req.param("id")),
      b = await c.req.json();
    const lease = service.store.get<ControlLease>("lease", String(b.leaseId));
    if (!lease || lease.requestId !== request.id)
      throw new DomainError(403, "Screen stop binding mismatch.");
    // Retain the first authenticated failure, never arbitrary media text. Later
    // cleanup callbacks must not obscure the original stopped-screen cause.
    if (!service.store.state(`screen-stop:${request.id}`)) {
      const reason = z
        .enum([
          "gateway_unavailable",
          "helper_stopped",
          "authorization_expired",
        ])
        .safeParse(b.reason);
      service.store.saveState(`screen-stop:${request.id}`, {
        leaseId: lease.id,
        reason: reason.success ? reason.data : "stopped",
        at: control.now(),
      });
    }
    if (lease.state === "active") {
      service.store.put("lease", { ...lease, state: "unknown" });
      service.store.put("session", {
        ...session,
        controlEpoch: session.controlEpoch + 1,
      });
    }
    execution.stop(request.id);
    voicePresentation.clear(request.id);
    service.store.saveState(`view-started:${request.id}`, true);
    service.store.saveState(`view-stopped:${request.id}`, true);
    return c.json({ stopped: true });
  });
  app.post("/media/:id/failure", async (c) => {
    const { request, pairing } = mediaContext(c.req.param("id"));
    // Optional metadata must never prevent authenticated fail-closed cleanup.
    // Preserve callback receipt separately from the first end-intent source:
    // this callback can itself be a consequence of earlier termination.
    const diagnostic = mediaFailureSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    try {
      if (!service.store.state(`media-failure:${request.id}`))
        service.store.saveState(`media-failure:${request.id}`, {
          ...(diagnostic.success
            ? diagnostic.data
            : { reason: "unspecified", category: "unspecified" }),
          receivedAt: control.now(),
        });
    } catch {
      // Cleanup and its original effect ID remain authoritative.
    }
    voicePresentation.clear(request.id);
    service.failCall(request.id, "media_failure");
    await control.stopPairing(pairing.id);
    return c.json({ ok: true });
  });
  return app;
}
