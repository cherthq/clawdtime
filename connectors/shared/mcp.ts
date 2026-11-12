import { sessionCapabilities, type ProtocolOptions } from "./protocol.js";
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
import {
  conversationCommands,
  executeConversationCommand,
  type ConversationCommand,
} from "./conversation.js";
import type { Adapter } from "../../src/contracts.js";

const instructions =
  "ClawdTime carries calls and human turns for THIS coding session. Check connection_status.protocolVersion: v2 uses conversation_turns, acknowledge_turn, conversation_progress and conversation_reply; ordinary file work can continue while sharing. Native approvals remain required. Shared-screen input requires exclusive execution ownership and a verified matching surface. Fallback is off by default. Stable IDs and unknown receipts prohibit replay. Legacy v1: yield_control, attention_result, acknowledge_response, resume_agent; remain paused until release.";
export function mcpOutput(value: unknown) {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];
  if (value && typeof value === "object" && "dataUrl" in value) {
    const { dataUrl, ...metadata } = value as Record<string, unknown>;
    if (
      typeof dataUrl !== "string" ||
      dataUrl.length > 2_000_000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
    )
      throw new Error(
        "Invalid transient screen image; no image or input returned.",
      );
    content.push({ type: "text", text: JSON.stringify(metadata) });
    content.push({
      type: "image",
      data: dataUrl.slice("data:image/jpeg;base64,".length),
      mimeType: "image/jpeg",
    });
  } else content.push({ type: "text", text: JSON.stringify(value) });
  return { content };
}
const output = mcpOutput;
export async function startMcp(options: {
  connection: string;
  project: string;
  adapter: Adapter;
  runId?: string;
  protocolVersion?: 1 | 2;
  nativeControl?: ProtocolOptions["nativeControl"];
  sharedSurface?: boolean;
  nativeCancellation?: boolean;
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
            protocolVersion: options.protocolVersion ?? 2,
            capabilities: sessionCapabilities(options),
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
    { name: "clawdtime", version: "0.2.0" },
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
        protocolVersion: run.session?.protocolVersion ?? 1,
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
      const scoped = await getClient();
      if (run.session?.protocolVersion === 2)
        throw new Error(
          "V2 keeps this coding session active. Claim shared-screen input with transfer_execution; do not use legacy yield.",
        );
      const value = await scoped.yield();
      run.session = value.session;
      secureWrite(statePath, run);
      return value;
    }),
  );
  server.registerTool(
    "request_attention",
    {
      description:
        "Create one durable attention request/call for the paired human after actual user call authorization. V2 remains active and polls conversation_turns; only legacy v1 requires prior yield. Use one stable idempotencyKey and preserve request ID. Native approvals remain required.",
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
  for (const [name, definition] of Object.entries(conversationCommands)) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.schema.shape,
        annotations: { readOnlyHint: "readOnly" in definition },
      },
      guarded(async (args: Record<string, unknown>) => {
        const scoped = await getClient();
        if (run.session?.protocolVersion !== 2)
          throw new Error(
            "This is a legacy session. Preserve its architecture; use legacy attention tools. Start a fresh explicitly authorized v2 session after cleanup.",
          );
        return executeConversationCommand(
          scoped,
          name as ConversationCommand,
          args,
        );
      }),
    );
  }
  server.server.onclose = () => {
    stopHeartbeat();
    releaseLock();
  };
  process.once("exit", stopHeartbeat);
  await server.connect(new StdioServerTransport());
  return server;
}
