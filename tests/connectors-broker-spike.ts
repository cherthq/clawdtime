/** Opt-in actual Codex executor; conversational model and Messages transport are synthetic. */
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { JobBroker } from "../src/attention/jobs.js";
import {
  JobConversation,
  type ConversationModel,
} from "../src/control/job-conversation.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { CodexAppServerRunner } from "../connectors/codex/runner.js";
import type { ExecutionRunner } from "../src/contracts.js";

const project = await mkdtemp(join(tmpdir(), "clawdtime-broker-proof-"));
const store = new Store(),
  transport = new SimulationTransport(),
  service = new ClawdTime(store, transport);
const runner = new CodexAppServerRunner({
  enabled: true,
  version: "probe",
  projectRoots: [project],
  timeoutMs: 90_000,
});
let markAccepted!: () => void;
const accepted = new Promise<void>((r) => {
  markAccepted = r;
});
const started = performance.now();
const phases: Array<{ phase: string; elapsedMs: number }> = [];
const observingRunner: ExecutionRunner = {
  capabilities: () => runner.capabilities(),
  run: (input, emit, signal) =>
    runner.run(
      input,
      (event) => {
        phases.push({
          phase: event.type === "progress" ? event.stage : event.type,
          elapsedMs: Math.round(performance.now() - started),
        });
        emit(event);
        if (event.type === "accepted") markAccepted();
      },
      signal,
    ),
};
const broker = new JobBroker(service, [observingRunner]);
const model: ConversationModel = {
  async propose({ text }) {
    const empty = {
      jobId: null,
      instruction: null,
      kind: null,
      target: null,
      verification: null,
    };
    return text === "Please calculate that"
      ? {
          ...empty,
          action: "clarify",
          reply:
            "Which file should I calculate and what result should I verify?",
        }
      : {
          ...empty,
          action: "submit",
          reply: "Submit the specified fixture calculation.",
          kind: "file",
          instruction:
            "Inside this disposable project only: read input.json, wait three seconds to deliberately simulate slow work, sum its values, and write result.txt containing exactly the decimal sum and a newline. Use only local shell/file tools; no network, desktop, MCP, apps, background processes or other files.",
          verification: {
            kind: "file_contains",
            path: "result.txt",
            expected: "50\n",
          },
        };
  },
};
const frontend = new JobConversation(service, broker, model);
let heartbeat: ReturnType<typeof setInterval> | undefined;
try {
  await writeFile(
    join(project, "input.json"),
    JSON.stringify({ values: [17, 25, 8] }),
  );
  const invite = service.createPairingInvite({
    memberId: "fixture-member",
    recipient: "fixture",
    lineId: "fixture-line",
    conversationId: "fixture-messages",
    deviceId: "fixture-mac",
    displayId: "1",
  });
  const paired = service.claimPairing({
    token: invite.token,
    deviceId: "fixture-mac",
    displayId: "1",
    allowView: true,
    allowControl: false,
  });
  const registered = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: runner.capabilities().version,
    projectRoot: project,
    externalSessionId: "explicit-managed-fixture",
    hostId: "fixture-host",
    protocolVersion: 2,
    conversation: {
      version: 1,
      runnerId: "codex-app-server",
      executionSession: "api_managed",
    },
    capabilities: { cooperativePause: true, polling: true },
  });
  heartbeat = setInterval(() => service.heartbeat(registered.token), 5_000);
  const binding = frontend.binding(registered.session);
  const clarification = await frontend.receive(
    binding,
    { channel: "text", eventId: "clarify-fixture" },
    "Please calculate that",
  );
  await service.drain();
  const submitted = await frontend.receive(
    binding,
    { channel: "text", eventId: "submit-fixture" },
    "Sum input.json, write result.txt and verify 50 followed by newline.",
  );
  if (!submitted.job) throw new Error("No job submitted");
  await service.drain();
  await Promise.race([
    accepted,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("No executor acceptance")),
        15_000,
      ).unref(),
    ),
  ]);
  const beforeStatus = performance.now();
  const during = await frontend.receive(
    binding,
    { channel: "text", eventId: "status-fixture" },
    "status",
  );
  const statusMs = performance.now() - beforeStatus;
  await service.drain();
  while (
    ["queued", "running", "waiting_approval", "cancel_requested"].includes(
      broker.status(binding, submitted.job.id).state,
    ) &&
    performance.now() - started < 95_000
  ) {
    await new Promise((r) => setTimeout(r, 25));
    broker.dispatch();
  }
  const completed = broker.status(binding, submitted.job.id);
  frontend.reportUpdates();
  await service.drain();
  const verified =
    completed.state === "succeeded" &&
    (await readFile(join(project, "result.txt"), "utf8").catch(() => "")) ===
      "50\n";
  const completionReported = transport.messages.some((x) =>
    x.text.includes("completed and independently verified"),
  );
  console.log(
    JSON.stringify(
      {
        host: runner.capabilities(),
        syntheticFrontend: true,
        syntheticMessages: true,
        actualExecutor: true,
        clarifiedBeforeSubmit: !clarification.job,
        receiptState: submitted.job.state,
        statusWhileRunning: during.job?.state,
        statusResponseMs: Math.round(statusMs * 1000) / 1000,
        completedState: completed.state,
        verified,
        completionReported,
        messageReceipts: transport.messages.length,
        calls: transport.calls.length,
        phases,
        elapsedMs: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
  );
  process.exitCode =
    verified &&
    !clarification.job &&
    during.job?.state === "running" &&
    completionReported
      ? 0
      : 1;
} finally {
  clearInterval(heartbeat);
  await broker.stop();
  runner.close();
  store.close();
  await rm(project, { recursive: true, force: true });
}
