import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { ClawdTimeClient } from "./client.js";
import { startHeartbeat } from "./heartbeat.js";
import { summarizeReadiness, requireAttentionReadiness } from "./readiness.js";
import {
  loadConnection,
  secureRead,
  secureWrite,
  type RunState,
} from "./state.js";
import type { Adapter } from "../../src/contracts.js";

const instructions =
  "ClawdTime cooperatively calls your paired human. Before requesting attention stop conflicting work and join/stop all background computer actors, then call yield_control. Remain paused until explicit human response, acknowledge_response, and resume_agent succeeds. Never treat timeout as approval. Reuse request idempotency keys after uncertainty. Poll attention_result (bounded waits); never dial again to recover. Native permissions remain in force.";
const output = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export async function startMcp(options: {
  connection: string;
  project: string;
  adapter: Adapter;
  runId?: string;
}) {
  const connection = loadConnection(
    options.connection,
    options.project,
    options.adapter,
  );
  const runId = options.runId || process.env.CLAWDTIME_RUN_ID || randomUUID();
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(runId))
    throw new Error("Invalid local run identifier.");
  const statePath = join(dirname(options.connection), "runs", `${runId}.json`);
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  if (existsSync(lockPath)) {
    const previousPid = Number(readFileSync(join(lockPath, "pid"), "utf8"));
    try {
      process.kill(previousPid, 0);
      throw new Error(
        "This local ClawdTime run is already connected; stop its client before recovery.",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    rmSync(lockPath, { recursive: true });
  }
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, "pid"), String(process.pid), { mode: 0o600 });
  const releaseLock = () => {
    if (
      existsSync(join(lockPath, "pid")) &&
      readFileSync(join(lockPath, "pid"), "utf8") === String(process.pid)
    )
      rmSync(lockPath, { recursive: true, force: true });
  };
  process.once("exit", releaseLock);
  let run: RunState = existsSync(statePath)
    ? secureRead<RunState>(statePath)
    : {
        schemaVersion: 1,
        runId,
        projectRoot: connection.projectRoot,
        adapter: options.adapter,
      };
  if (
    run.projectRoot !== connection.projectRoot ||
    run.adapter !== options.adapter ||
    run.runId !== runId
  )
    throw new Error("Run identity mismatch.");
  secureWrite(statePath, run);
  let client: ClawdTimeClient | undefined;
  let connecting: Promise<ClawdTimeClient> | undefined;
  async function getClient() {
    if (client) return client;
    if (!connecting)
      connecting = (async () => {
        if (!run.token) {
          if (run.registrationIntentAt)
            throw new Error(
              "Previous registration outcome is unknown. Preserve this run and reconcile it; do not register again.",
            );
          run.registrationIntentAt = Date.now();
          secureWrite(statePath, run);
          const result = await new ClawdTimeClient(
            connection.baseUrl,
            connection.token,
          ).register({
            adapter: connection.adapter,
            adapterVersion: connection.adapterVersion,
            projectRoot: connection.projectRoot,
            externalSessionId: runId,
            hostId: connection.hostId,
            capabilities: { cooperativePause: true, polling: true },
          });
          run = { ...run, session: result.session, token: result.token };
          secureWrite(statePath, run);
        }
        const scoped = new ClawdTimeClient(connection.baseUrl, run.token!);
        // Reconnect refreshes liveness immediately, but expired/stopped tokens stay rejected.
        await scoped.heartbeat();
        client = scoped;
        return client;
      })().catch((error) => {
        connecting = undefined;
        throw error;
      });
    return connecting;
  }
  const stopHeartbeat = startHeartbeat(async () => {
    // Do not register an unused session or replace its token after authentication failure.
    if (client) await client.heartbeat();
  });
  const server = new McpServer(
    { name: "clawdtime", version: "0.1.0" },
    { instructions },
  );
  const id = z.string().min(1).max(200);
  const guarded =
    <T>(fn: (args: T) => Promise<unknown>) =>
    async (args: T) => {
      try {
        return output(await fn(args));
      } catch (error) {
        return {
          ...output({
            error: error instanceof Error ? error.message : "ClawdTime failed",
            retryPolicy:
              "Inspect the same request; never generate a fresh key to retry an uncertain effect.",
          }),
          isError: true,
        };
      }
    };
  server.registerTool(
    "connection_status",
    {
      description:
        "Check this exact project/session connection. Returns no credentials.",
      inputSchema: {},
    },
    guarded(async () => {
      const { ready: _legacyReady, ...backend } = await (
        await getClient()
      ).doctor();
      return {
        ...backend,
        readiness: summarizeReadiness(backend),
        localRunId: runId,
        projectRoot: connection.projectRoot,
        adapter: connection.adapter,
      };
    }),
  );
  server.registerTool(
    "yield_control",
    {
      description:
        "Pause this cooperative session before attention/CUA. Call only after stopping/joining all background actors and pending computer mutations. Do no conflicting work until resume_agent succeeds.",
      inputSchema: { backgroundActorsStopped: z.literal(true) },
    },
    guarded(async () => {
      const value = await (await getClient()).yield();
      run.session = value.session;
      secureWrite(statePath, run);
      return value;
    }),
  );
  server.registerTool(
    "request_attention",
    {
      description:
        "Create one durable attention request/call for the paired human. Use one stable idempotencyKey per question and preserve returned request ID. Native permission requests are not bypassed.",
      inputSchema: {
        taskId: id,
        idempotencyKey: id,
        reason: z.enum(["blocker", "decision", "approval", "review", "result"]),
        question: z.string().min(1).max(4000),
        timeoutSeconds: z.number().int().min(15).max(900).optional(),
      },
      annotations: { idempotentHint: true },
    },
    guarded(async (args) => {
      const client = await getClient();
      requireAttentionReadiness(await client.doctor());
      return client.requestAttention(args);
    }),
  );
  server.registerTool(
    "attention_status",
    {
      description:
        "Read this session’s durable request state without redialing.",
      inputSchema: { requestId: id },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ requestId }) => (await getClient()).status(requestId)),
  );
  server.registerTool(
    "attention_result",
    {
      description:
        "Read feedback for this exact session. Wait at most 20 seconds per call; pending/timeout is not approval. Repeated reads return the same response until explicitly acknowledged.",
      inputSchema: {
        requestId: id,
        waitSeconds: z.number().int().min(0).max(20).default(0),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ requestId, waitSeconds }) => {
      const client = await getClient(),
        deadline = Date.now() + waitSeconds * 1000;
      while (true) {
        const value = await client.result(requestId);
        if (
          value.response ||
          ![
            "requested",
            "queued",
            "ringing",
            "connected",
            "awaiting_input",
          ].includes(value.request.state) ||
          Date.now() >= deadline
        )
          return value;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, deadline - Date.now())),
        );
      }
    }),
  );
  server.registerTool(
    "acknowledge_response",
    {
      description:
        "Acknowledge receipt of the exact human response. This does not resume the agent or bypass its permission policy.",
      inputSchema: { requestId: id, responseId: id },
      annotations: { idempotentHint: true },
    },
    guarded(async ({ requestId, responseId }) =>
      (await getClient()).ack(requestId, responseId),
    ),
  );
  server.registerTool(
    "resume_agent",
    {
      description:
        "Explicitly resume only after reading/acknowledging feedback, reviewing control receipts/current epoch, and release of all CUA. On failure stay paused. Native agent approvals remain required.",
      inputSchema: {
        requestId: id,
        controlEpoch: z.number().int().nonnegative(),
      },
    },
    guarded(async ({ requestId, controlEpoch }) => {
      const value = await (await getClient()).resume(requestId, controlEpoch);
      run.session = value.session;
      secureWrite(statePath, run);
      return value;
    }),
  );
  server.registerTool(
    "complete_attention",
    {
      description:
        "Return a factual concise result/artifact link to the same Messages conversation after completing this task. Reuse the request ID after uncertainty.",
      inputSchema: { requestId: id, text: z.string().min(1).max(8000) },
      annotations: { idempotentHint: true },
    },
    guarded(async ({ requestId, text }) =>
      (await getClient()).complete(requestId, text),
    ),
  );
  server.server.onclose = () => {
    stopHeartbeat();
    releaseLock();
  };
  process.once("exit", stopHeartbeat);
  await server.connect(new StdioServerTransport());
  return server;
}
