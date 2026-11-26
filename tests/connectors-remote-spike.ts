/** Opt-in real HTTP pull worker and Codex execution; synthetic conversation/transport only. */
import { serve } from "@hono/node-server";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { JobBroker } from "../src/attention/jobs.js";
import {
  JobConversation,
  type ConversationModel,
} from "../src/control/job-conversation.js";
import { RemoteExecutionRunner } from "../src/control/remote-runner.js";
import { CodexAppServerRunner } from "../connectors/codex/runner.js";
import { ExecutorWorker } from "../connectors/shared/executor-worker.js";
import { ControlCoordinator } from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { createApp } from "../src/app.js";

const root = await realpath(
  await mkdtemp(join(tmpdir(), "clawdtime-remote-proof-")),
);
const store = new Store(),
  transport = new SimulationTransport(),
  service = new ClawdTime(store, transport);
const remote = new RemoteExecutionRunner(service, true),
  broker = new JobBroker(service, [remote]);
const model: ConversationModel = {
  async propose({ text }) {
    const empty = {
      jobId: null,
      instruction: null,
      kind: null,
      target: null,
      verification: null,
    };
    if (text.startsWith("Lifecycle ")) {
      const revised = text === "Lifecycle revise",
        cancel = text === "Lifecycle cancel candidate",
        path = cancel ? "cancel-result.txt" : "revision-result.txt",
        expected = revised ? "51\n" : "50\n";
      return {
        ...empty,
        action: revised ? "revise" : "submit",
        reply: "Scripted lifecycle fixture intent.",
        kind: "file",
        instruction: `Read input.json in this disposable directory and write exactly ${JSON.stringify(expected)} to ${path}. Use only local shell/file tools inside this directory, no networks, apps, MCP, desktop, background work or outside files.`,
        verification: { kind: "file_contains", path, expected },
      };
    }
    return text === "Calculate that"
      ? {
          ...empty,
          action: "clarify",
          reply: "Which fixture and expected file result?",
        }
      : {
          ...empty,
          action: "submit",
          reply: "Submitting the specified fixture.",
          kind: "file",
          instruction:
            "Read input.json in this disposable project, wait three seconds, sum its values, and write exactly 50 followed by newline to result.txt. Use only local shell/file tools inside this directory, no networks, apps, MCP, desktop, background work or outside files.",
          verification: {
            kind: "file_contains",
            path: "result.txt",
            expected: "50\n",
          },
        };
  },
};
const frontend = new JobConversation(service, broker, model);
const unavailable = async (): Promise<never> => {
  throw new Error("No desktop device in this file-only probe");
};
const control = new ControlCoordinator(store, {
  createLease: unavailable,
  frame: unavailable,
  action: unavailable,
  release: unavailable,
});
const app = createApp(service, control, new HumanRouter(service, control), {
  origin: "http://127.0.0.1",
  simulation: true,
  conversation: frontend,
  remoteRunner: remote,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.on("listening", r));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No fixture listener");
const origin = `http://127.0.0.1:${address.port}`;
const local = new CodexAppServerRunner({
  enabled: true,
  version: "unqualified",
  projectRoots: [root],
  timeoutMs: 90_000,
});
const abort = new AbortController();
let work: Promise<void> | undefined,
  maintenance: ReturnType<typeof setInterval> | undefined;
const started = performance.now();
const boundaries: Array<{
  boundary: string;
  dispatchId: string;
  elapsedMs: number;
}> = [];
try {
  await writeFile(
    join(root, "input.json"),
    JSON.stringify({ values: [17, 25, 8] }),
  );
  const invite = service.createPairingInvite({
    memberId: "fixture-member",
    recipient: "fixture",
    conversationId: "fixture-messages",
    lineId: "fixture-line",
    deviceId: "fixture-device",
    displayId: "1",
  });
  const paired = service.claimPairing({
    token: invite.token,
    deviceId: "fixture-device",
    displayId: "1",
    allowView: true,
    allowControl: false,
  });
  const registered = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: local.capabilities().version,
    projectRoot: root,
    externalSessionId: "explicit-remote-managed-fixture",
    hostId: "fixture-host",
    protocolVersion: 2,
    conversation: {
      version: 1,
      runnerId: "remote-codex-app-server",
      executionSession: "api_managed",
    },
    capabilities: { cooperativePause: true, polling: true },
  });
  const binding = frontend.binding(registered.session);
  const worker = new ExecutorWorker({
    origin,
    token: registered.token,
    session: registered.session,
    ledgerPath: join(root, "worker.json"),
    runner: local,
    pollMs: 100,
    request: (async (url, init) => {
      const response = await fetch(url, init);
      const path = new URL(String(url)).pathname;
      if (["/api/executor/events", "/api/executor/result"].includes(path)) {
        const body = JSON.parse(String(init?.body));
        boundaries.push({
          dispatchId: body.dispatchId,
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
  work = worker.run(abort.signal);
  maintenance = setInterval(() => {
    broker.dispatch();
    frontend.reportUpdates();
    void service.drain();
  }, 50);
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${registered.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(`Fixture HTTP rejected: ${response.status}`);
    return response.json() as Promise<any>;
  };
  while (!remote.capabilities(binding).available) {
    if (performance.now() - started > 10_000)
      throw new Error("Worker did not connect");
    await new Promise((r) => setTimeout(r, 20));
  }
  const clarification = await api("/api/conversation/turn", {
    eventId: "clarify",
    text: "Calculate that",
  });
  await service.drain();
  const submitted = await api("/api/conversation/turn", {
    eventId: "submit",
    text: "Sum input.json and write result.txt; expected text 50 followed by newline",
  });
  if (!submitted.job) throw new Error("No submitted job");
  while (!boundaries.some((x) => x.boundary === "accepted")) {
    if (performance.now() - started > 15_000)
      throw new Error("Worker did not accept");
    await new Promise((r) => setTimeout(r, 20));
  }
  const beforeStatus = performance.now();
  const status = await api("/api/conversation/turn", {
    eventId: "status",
    text: "status",
  });
  const statusMs = performance.now() - beforeStatus;
  while (
    ["queued", "running", "waiting_approval", "cancel_requested"].includes(
      broker.status(binding, submitted.job.id).state,
    )
  ) {
    if (performance.now() - started > 95_000)
      throw new Error("Fixture deadline");
    await new Promise((r) => setTimeout(r, 25));
  }
  frontend.reportUpdates();
  await service.drain();
  const completed = broker.status(binding, submitted.job.id),
    exact = await readFile(join(root, "result.txt"), "utf8").catch(() => "");
  const verified = completed.state === "succeeded" && exact === "50\n";
  const reported = transport.messages.some((m) =>
    m.text.includes("completed and independently verified"),
  );
  let lifecycle: Record<string, unknown> | undefined;
  if (process.argv.includes("--lifecycle")) {
    const waitFor = async (predicate: () => boolean, limitMs = 90_000) => {
      const began = performance.now();
      while (!predicate()) {
        if (performance.now() - began > limitMs)
          throw new Error("Lifecycle fixture deadline");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const send = (eventId: string, text: string) =>
      api("/api/conversation/turn", { eventId, text });
    const original = await send("revision-original", "Lifecycle original");
    await waitFor(
      () =>
        boundaries.some(
          (entry) =>
            entry.dispatchId === `${original.job.id}:1` &&
            entry.boundary === "accepted",
        ),
      15_000,
    );
    const revisedAt = performance.now();
    const revision = await send("revision-change", "Lifecycle revise");
    await waitFor(() =>
      [
        "succeeded",
        "failed",
        "canceled",
        "unknown",
        "waiting_clarification",
      ].includes(broker.status(binding, original.job.id).state),
    );
    const confirmationRequired =
      broker.status(binding, original.job.id).progress ===
      "revision_requires_confirmation";
    if (confirmationRequired) {
      // Confirmation is another explicit ordered instruction, never automatic retry
      // of an unknown result. The original executor has confirmed quiescence.
      await send("revision-confirmed", "Lifecycle revise");
      await waitFor(() =>
        ["succeeded", "failed", "canceled", "unknown"].includes(
          broker.status(binding, original.job.id).state,
        ),
      );
    }
    const revisedResult = broker.status(binding, original.job.id);
    const revisedExact = await readFile(
      join(root, "revision-result.txt"),
      "utf8",
    ).catch(() => "");
    lifecycle = {
      revisedWhileAccepted: revision.job?.state === "cancel_requested",
      confirmationRequired,
      revision: revisedResult.revision,
      revisionState: revisedResult.state,
      revisionVerified:
        revisedResult.state === "succeeded" && revisedExact === "51\n",
      revisionElapsedMs: Math.round(performance.now() - revisedAt),
      originalDispatch: store.get<{ state: string }>(
        "job_dispatch",
        `${original.job.id}:1`,
      )?.state,
    };
    // Unknown is retained as a real limit, never worked around with a new session.
    if (revisedResult.state !== "unknown") {
      const cancelCandidate = await send(
        "cancel-candidate",
        "Lifecycle cancel candidate",
      );
      await waitFor(
        () =>
          boundaries.some(
            (entry) =>
              entry.dispatchId === `${cancelCandidate.job.id}:1` &&
              entry.boundary === "accepted",
          ),
        15_000,
      );
      const cancelAt = performance.now();
      const cancellation = await send("cancel-request", "cancel task");
      await waitFor(
        () =>
          ["succeeded", "failed", "canceled", "unknown"].includes(
            broker.status(binding, cancelCandidate.job.id).state,
          ),
        15_000,
      );
      const cancelResult = broker.status(binding, cancelCandidate.job.id);
      Object.assign(lifecycle, {
        cancellationRequested: cancellation.job?.state === "cancel_requested",
        cancellationState: cancelResult.state,
        cancellationElapsedMs: Math.round(performance.now() - cancelAt),
        cancellationEffectsUnresolved:
          cancelResult.result?.unresolvedEffectIds.length,
        cancelOutputAbsent: await readFile(
          join(root, "cancel-result.txt"),
          "utf8",
        ).then(
          () => false,
          () => true,
        ),
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        actualHttpWorker: true,
        actualCodexExecutor: true,
        syntheticFrontend: true,
        simulatedMessages: true,
        version: local.capabilities().version,
        clarified: !clarification.job,
        queuedReceipt: submitted.job.state,
        statusWhileRunning: status.job?.state,
        statusMs: Math.round(statusMs * 1000) / 1000,
        verified,
        reported,
        callCount: transport.calls.length,
        boundaries,
        ...(lifecycle ? { lifecycle } : {}),
        elapsedMs: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
  );
  process.exitCode =
    verified &&
    reported &&
    status.job?.state === "running" &&
    (!lifecycle ||
      (lifecycle.revisionVerified === true &&
        lifecycle.cancellationState === "canceled" &&
        lifecycle.cancelOutputAbsent === true))
      ? 0
      : 1;
} finally {
  clearInterval(maintenance);
  abort.abort();
  await work?.catch(() => {});
  await broker.stop();
  local.close();
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  await rm(root, { recursive: true, force: true });
}
