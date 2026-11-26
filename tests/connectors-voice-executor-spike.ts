/** Opt-in local voice-ingress fixture. Real text model and Codex; no handset or outbound transport. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { JobBroker } from "../src/attention/jobs.js";
import {
  JobConversation,
  configuredTextModel,
} from "../src/control/job-conversation.js";
import { RemoteExecutionRunner } from "../src/control/remote-runner.js";
import { CodexAppServerRunner } from "../connectors/codex/runner.js";
import { ExecutorWorker } from "../connectors/shared/executor-worker.js";
import { ControlCoordinator } from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { createApp } from "../src/app.js";

async function main() {
  const index = process.argv.indexOf("--handshake");
  if (index < 0 || !process.argv[index + 1])
    throw new Error("Private handshake path required");
  const handshake = resolve(process.argv[index + 1]!);
  let prompt =
    "Create result dot T X T containing the digits five zero followed by a newline. Verify that file contains the digits five zero followed by a newline. Use only this project.";
  const promptIndex = process.argv.indexOf("--prompt-file");
  if (promptIndex >= 0) {
    if (!process.argv[promptIndex + 1])
      throw new Error("Private synthetic prompt file required");
    const file = await open(
      resolve(process.argv[promptIndex + 1]!),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size > 4000
      )
        throw new Error(
          "Prompt must be a bounded owner-only synthetic fixture file",
        );
      prompt = z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }
  const model = configuredTextModel(process.env);
  if (!model)
    throw new Error("Explicit real conversation model configuration required");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "clawdtime-voice-executor-")),
  );
  const started = performance.now();
  let expiresAt = Date.now() + 90_000;
  const token = randomBytes(32).toString("hex"),
    callId = "fixture-voice-call";
  const mediaSessionId = "ct_" + randomBytes(20).toString("hex");
  const store = new Store(),
    transport = new SimulationTransport();
  const service = new ClawdTime(store, transport);
  const remote = new RemoteExecutionRunner(service, true),
    broker = new JobBroker(service, [remote]);
  const interpretations: {
    action: string;
    verificationKind: string | null;
    hasInstruction: boolean;
    hasVerificationPath: boolean;
    hasExpectedText: boolean;
    durationMs: number;
  }[] = [];
  const frontend = new JobConversation(service, broker, {
    async propose(input) {
      const began = performance.now();
      try {
        const proposal = await model.propose(input);
        interpretations.push({
          action: proposal.action,
          verificationKind: proposal.verification?.kind ?? null,
          hasInstruction: !!proposal.instruction,
          hasVerificationPath: !!proposal.verification?.path,
          hasExpectedText: !!proposal.verification?.expected,
          durationMs: Math.round(performance.now() - began),
        });
        return proposal;
      } catch (error) {
        interpretations.push({
          action: "model_error",
          verificationKind: null,
          hasInstruction: false,
          hasVerificationPath: false,
          hasExpectedText: false,
          durationMs: Math.round(performance.now() - began),
        });
        throw error;
      }
    },
  });
  const local = new CodexAppServerRunner({
    enabled: true,
    version: "unqualified",
    projectRoots: [root],
    timeoutMs: 60_000,
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("No desktop surface in fixture");
  };
  const control = new ControlCoordinator(store, {
    createLease: unavailable,
    frame: unavailable,
    action: unavailable,
    release: unavailable,
  });
  const backend = createApp(
    service,
    control,
    new HumanRouter(service, control),
    {
      origin: "http://127.0.0.1",
      simulation: true,
      conversation: frontend,
      remoteRunner: remote,
    },
  );
  const invite = service.createPairingInvite({
    memberId: "fixture-human",
    recipient: "fixture",
    conversationId: "fixture-messages",
    lineId: "fixture-line",
    deviceId: "fixture-device",
    displayId: "1",
  });
  const pair = service.claimPairing({
    token: invite.token,
    deviceId: "fixture-device",
    displayId: "1",
    allowView: true,
    allowControl: false,
  });
  const registration = service.registerSession(pair.token, {
    adapter: "codex",
    adapterVersion: local.capabilities().version,
    projectRoot: root,
    externalSessionId: "voice-fixture-" + randomBytes(12).toString("hex"),
    hostId: "fixture-host",
    protocolVersion: 2,
    conversation: {
      version: 1,
      runnerId: "remote-codex-app-server",
      executionSession: "api_managed",
    },
    capabilities: {
      cooperativePause: true,
      polling: true,
      nativeControl: "none",
    },
  });
  const binding = frontend.binding(registration.session);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let receivedTurns = 0,
    statusReads = 0,
    handshakeWritten = false;
  const boundaries: { boundary: string; elapsedMs: number }[] = [];
  const app = new Hono();
  app.use("/fixture/*", async (context, next) => {
    const candidate = Buffer.from(context.req.header("authorization") ?? ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    )
      return context.json({ error: "Fixture authentication required" }, 401);
    if (Date.now() >= expiresAt)
      return context.json({ error: "Fixture expired" }, 410);
    await next();
  });
  app.post("/fixture/turn", async (context) => {
    const body = z
      .object({
        eventId: z.string().min(1).max(160),
        text: z.string().trim().min(1).max(4000),
        callId: z.literal(callId),
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
              items.reduce((size, item) => size + item.text.length, 0) <= 3000,
          )
          .optional(),
      })
      .strict()
      .parse(await context.req.json());
    receivedTurns++;
    const began = performance.now();
    const result = await frontend.receive(
      binding,
      { channel: "voice", eventId: body.eventId },
      body.text,
      undefined,
      body.context,
    );
    boundaries.push({
      boundary: "conversation_returned",
      elapsedMs: Math.round(performance.now() - began),
    });
    return context.json(result);
  });
  app.get("/fixture/jobs", (context) => {
    statusReads++;
    return context.json({
      jobs: broker.list(binding),
      sequence: broker.currentSequence(binding),
      runner: broker.capabilities(binding),
      interpretations,
    });
  });
  app.post("/fixture/finish", (context) => {
    setTimeout(finish, 20);
    return context.json({ stopping: true });
  });
  app.route("/", backend);
  app.onError((_error, context) =>
    context.json(
      { error: "Fixture request refused; inspect authoritative status" },
      409,
    ),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  const listening = new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const abort = new AbortController();
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined,
    workerFailure = false;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  try {
    await writeFile(
      join(root, "input.json"),
      JSON.stringify({ values: [17, 25, 8] }),
    );
    await listening;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture listener unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    const worker = new ExecutorWorker({
      origin,
      token: registration.token,
      session: registration.session,
      ledgerPath: join(root, "worker.json"),
      runner: local,
      pollMs: 100,
      request: (async (url, init) => {
        const response = await fetch(url, init);
        const path = new URL(String(url)).pathname;
        if (["/api/executor/events", "/api/executor/result"].includes(path)) {
          const body = JSON.parse(String(init?.body));
          boundaries.push({
            boundary: path.endsWith("result")
              ? "result_received"
              : body.event.type === "progress"
                ? body.event.stage
                : body.event.type,
            elapsedMs: Math.round(performance.now() - started),
          });
        }
        return response;
      }) as typeof fetch,
    });
    work = worker.run(abort.signal).catch(() => {
      workerFailure = true;
      finish();
    });
    maintenance = setInterval(() => broker.dispatch(), 50);
    while (!remote.capabilities(binding).available) {
      if (workerFailure || performance.now() - started > 10_000)
        throw new Error("Worker did not connect");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Exclusive private file, never log tokens or model prompts. Lead owns provisioning of env credentials.
    expiresAt = Date.now() + 90_000;
    lifetime = setTimeout(finish, 90_000);
    const file = await open(handshake, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          origin,
          token,
          callId,
          mediaSessionId,
          projectRoot: root,
          expiresAt,
          prompt,
        }) + "\n",
      );
      await file.sync();
      handshakeWritten = true;
    } finally {
      await file.close();
    }
    console.log(
      JSON.stringify({
        ready: true,
        lifetimeMs: 90_000,
        actualTextFrontend: true,
        actualCodexExecutor: true,
        voiceIngressIsFixture: true,
        nativeControl: "none",
      }),
    );
    await finished;
    const jobs = broker.list(binding);
    const exact = await readFile(join(root, "result.txt"), "utf8").catch(
      () => "",
    );
    const verified =
      jobs.some(
        (job) =>
          job.state === "succeeded" &&
          job.result?.verification?.verified === true,
      ) && exact === "50\n";
    console.log(
      JSON.stringify({
        actualTextFrontend: true,
        actualCodexExecutor: true,
        voiceIngressIsFixture: true,
        version: local.capabilities().version,
        receivedTurns,
        statusReads,
        interpretations,
        verified,
        jobs: jobs.map((job) => ({
          id: job.id,
          state: job.state,
          revision: job.revision,
          progress: job.progress,
          verification: job.result?.verification,
          timing: broker.timing.snapshot(job.id),
        })),
        callCount: transport.calls.length,
        messageCount: transport.messages.length,
        workerFailure,
        boundaries,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
    process.exitCode =
      verified &&
      !workerFailure &&
      transport.calls.length === 0 &&
      transport.messages.length === 0
        ? 0
        : 1;
  } finally {
    clearTimeout(lifetime);
    clearInterval(maintenance);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    abort.abort();
    await work?.catch(() => {});
    await broker.stop();
    local.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    if (handshakeWritten) await rm(handshake, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(() => {
  console.error(
    "Voice executor fixture failed; no external transport was dispatched. Inspect scoped test state without replaying effects.",
  );
  process.exitCode = 1;
});
