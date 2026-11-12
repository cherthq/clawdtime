/** Opt-in real-client compatibility probe. All transport/human effects are synthetic. */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";
import type { Adapter } from "../src/contracts.js";

const adapter = process.argv[2] as Adapter;
if (!["codex", "claude-code"].includes(adapter))
  throw new Error(
    "Choose codex or claude-code. This probe never calls a phone.",
  );
const project = canonicalProject(
  mkdtempSync(join(tmpdir(), "clawdtime-client-probe-")),
);
const store = new Store(),
  transport = new SimulationTransport(),
  service = new ClawdTime(store, transport),
  app = new Hono();
const binding = {
  memberId: "fixture-member",
  recipient: "fixture-recipient",
  conversationId: "fixture-conversation",
  lineId: "fixture-line",
  deviceId: "fixture-device",
  displayId: "1",
};
const invite = service.createPairingInvite(binding),
  grant = service.claimPairing({
    token: invite.token,
    deviceId: binding.deviceId,
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
const token = (c: any) => c.req.header("authorization")?.slice(7) || "";
const events: string[] = [];
app.onError((e, c) => c.json({ error: e.message }, 409));
app.post("/api/sessions", async (c) => {
  events.push("register");
  return c.json(service.registerSession(token(c), await c.req.json()));
});
app.post("/api/sessions/heartbeat", (c) =>
  c.json({ session: service.heartbeat(token(c)) }),
);
app.get("/api/doctor", (c) => c.json(service.doctor(token(c))));
app.post("/api/sessions/yield", (c) => {
  events.push("yield");
  return c.json({ session: service.yieldSession(token(c)) });
});
app.post("/api/attention", async (c) => {
  events.push("request");
  const request = service.requestAttention(token(c), await c.req.json());
  await service.drain();
  service.observeCall(request.id, "connected", true);
  service.receiveResponse({
    memberId: binding.memberId,
    lineId: binding.lineId,
    conversationId: binding.conversationId,
    eventId: `fixture:${request.id}`,
    requestId: request.id,
    channel: "text",
    text: "Use the blue option. Synthetic compatibility feedback only.",
  });
  return c.json({ request });
});
app.get("/api/attention/:id", (c) =>
  c.json({ request: service.status(token(c), c.req.param("id")) }),
);
app.get("/api/attention/:id/result", (c) => {
  events.push("result");
  return c.json({
    ...service.result(token(c), c.req.param("id")),
    session: service.authenticateSession(token(c)),
  });
});
app.post("/api/attention/:id/ack", async (c) => {
  events.push("ack");
  return c.json({
    response: service.ack(
      token(c),
      c.req.param("id"),
      (await c.req.json()).responseId,
    ),
  });
});
app.post("/api/attention/:id/resume", async (c) => {
  events.push("resume");
  return c.json(
    service.resume(
      token(c),
      c.req.param("id"),
      (await c.req.json()).controlEpoch,
    ),
  );
});
app.post("/api/attention/:id/complete", async (c) => {
  events.push("complete");
  const request = service.complete(
    token(c),
    c.req.param("id"),
    (await c.req.json()).text,
  );
  await service.drain();
  return c.json({ request });
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.on("listening", r));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No local listener.");
const connection = join(project, "connection.json"),
  runId = randomUUID(),
  entry = resolve("cli/main.ts");
secureWrite(connection, {
  schemaVersion: 1,
  baseUrl: `http://127.0.0.1:${address.port}`,
  ...grant,
  adapter,
  adapterVersion: "compatibility-probe",
  projectRoot: project,
  hostId: "fixture-host",
});
const mcpArgs = [
  "--import",
  resolve("node_modules/tsx/dist/loader.mjs"),
  entry,
  "mcp",
  "--protocol-version",
  "1",
  "--project",
  project,
  "--agent",
  adapter,
  "--connection",
  connection,
];
const prompt = `This is a synthetic ClawdTime compatibility test. The expected localRunId is ${runId}. Call connection_status and stop if its localRunId differs. The expected adapter is ${adapter}. Use ONLY ClawdTime MCP tools. There are no background actors. Call connection_status, yield_control(backgroundActorsStopped=true), request_attention(taskId="probe", idempotencyKey="probe-v1", reason="decision", question="Blue or green?"), attention_result, acknowledge_response, resume_agent with current epoch from result, then complete_attention with text "Used blue after synthetic feedback; compatibility probe complete." Return CLAWDTIME_PROBE_OK only after all steps succeed. Do not call a phone, use shell, inspect files, or use any other tools. This backend is simulation only.`;
let args: string[];
if (adapter === "codex")
  args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "-C",
    project,
    "-c",
    `mcp_servers.clawdtime.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.clawdtime.args=${JSON.stringify(mcpArgs)}`,
    "-c",
    "mcp_servers.clawdtime.tool_timeout_sec=40",
    "-c",
    'mcp_servers.clawdtime.env_vars=["CLAWDTIME_RUN_ID"]',
    "-c",
    'mcp_servers.clawdtime.default_tools_approval_mode="approve"',
    prompt,
  ];
else {
  const config = join(project, "mcp.json");
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        clawdtime: { type: "stdio", command: process.execPath, args: mcpArgs },
      },
    }),
  );
  args = [
    "-p",
    prompt,
    "--strict-mcp-config",
    "--mcp-config",
    config,
    "--setting-sources",
    "",
    "--tools",
    "",
    "--allowedTools",
    "mcp__clawdtime__*",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}
const child = spawn(adapter === "codex" ? "codex" : "claude", args, {
  cwd: project,
  env: { ...process.env, CLAWDTIME_RUN_ID: runId },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "",
  stderr = "";
child.stdout.on("data", (b) => (stdout += String(b)));
child.stderr.on("data", (b) => (stderr += String(b)));
const timer = setTimeout(() => child.kill("SIGTERM"), 150_000);
const exit = await new Promise<number | null>((r) => {
  child.on("exit", r);
  child.on("error", () => r(127));
});
clearTimeout(timer);
const exactRunIdentity =
  store.all("session").length === 1 &&
  store.all("session")[0]?.externalSessionId === runId;
const completed =
  exactRunIdentity &&
  events.includes("complete") &&
  events.includes("resume") &&
  events.includes("ack") &&
  transport.messages.length === 1;
// Only sanitized phase/outcome evidence; native output can contain account metadata.
console.log(
  JSON.stringify(
    {
      adapter,
      exit,
      phases: events,
      simulatedCalls: transport.calls.length,
      simulatedMessages: transport.messages.length,
      completed,
      exactRunIdentity,
      marker: stdout.includes("CLAWDTIME_PROBE_OK"),
      failure: completed
        ? undefined
        : (stderr + stdout)
            .replace(/Bearer\s+\S+/g, "Bearer [redacted]")
            .slice(-1200),
    },
    null,
    2,
  ),
);
await new Promise<void>((r) => server.close(() => r()));
store.close();
rmSync(project, { recursive: true, force: true });
process.exitCode = completed ? 0 : 1;
