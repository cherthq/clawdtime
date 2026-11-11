import { it, expect } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";

it("MCP restart retains one call/answer; a different local session cannot consume it", async () => {
  const project = canonicalProject(
      mkdtempSync(join(tmpdir(), "clawdtime-mcp-test-")),
    ),
    store = new Store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(store, transport),
    app = new Hono();
  const binding = {
    memberId: "member",
    recipient: "recipient",
    conversationId: "conversation",
    lineId: "line",
    deviceId: "device",
    displayId: "1",
  };
  const invite = service.createPairingInvite(binding),
    grant = service.claimPairing({
      token: invite.token,
      deviceId: "device",
      displayId: "1",
      allowView: true,
      allowControl: true,
    });
  let heartbeatCount = 0;
  let liveWithoutEvidence = false,
    attentionHttpCount = 0;
  const token = (c: any) => c.req.header("authorization").slice(7);
  app.onError((e, c) => c.json({ error: e.message }, 409));
  app.post("/api/sessions", async (c) =>
    c.json(service.registerSession(token(c), await c.req.json())),
  );
  app.post("/api/sessions/heartbeat", (c) => {
    heartbeatCount++;
    return c.json({ session: service.heartbeat(token(c)) });
  });
  app.get("/api/doctor", (c) => {
    const value = service.doctor(token(c));
    return c.json(
      liveWithoutEvidence
        ? { ...value, mode: "live", readiness: undefined }
        : value,
    );
  });
  app.post("/api/sessions/yield", (c) =>
    c.json({ session: service.yieldSession(token(c)) }),
  );
  app.post("/api/attention", async (c) => {
    attentionHttpCount++;
    const request = service.requestAttention(token(c), await c.req.json());
    await service.drain();
    return c.json({ request });
  });
  app.get("/api/attention/:id/result", (c) =>
    c.json({
      ...service.result(token(c), c.req.param("id")),
      session: service.authenticateSession(token(c)),
    }),
  );
  app.post("/api/attention/:id/ack", async (c) =>
    c.json({
      response: service.ack(
        token(c),
        c.req.param("id"),
        (await c.req.json()).responseId,
      ),
    }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const address = server.address() as { port: number };
  const connection = join(project, "connection.json");
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${address.port}`,
    ...grant,
    adapter: "codex",
    adapterVersion: "test",
    projectRoot: project,
    hostId: "fixture",
  });
  const clients: Client[] = [];
  const start = async (run: string) => {
    const client = new Client({ name: "test", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("cli/main.ts"),
          "mcp",
          "--connection",
          connection,
          "--project",
          project,
          "--agent",
          "codex",
        ],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (p): p is [string, string] => typeof p[1] === "string",
            ),
          ),
          CLAWDTIME_RUN_ID: run,
        },
        stderr: "pipe",
      }),
    );
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      error: result.isError,
      value: JSON.parse((result.content as { text: string }[])[0]!.text),
    };
  };
  try {
    const run = randomUUID(),
      first = await start(run);
    await call(first, "yield_control", { backgroundActorsStopped: true });
    const input = {
      taskId: "task",
      idempotencyKey: "stable",
      reason: "decision",
      question: "Pick?",
    };
    const created = await call(first, "request_attention", input);
    expect(created.error).toBeFalsy();
    const requestId = created.value.request.id;
    liveWithoutEvidence = true;
    const blocked = await call(first, "request_attention", input);
    expect(blocked.error).toBe(true);
    expect(blocked.value.error).toContain("Live attention is blocked");
    expect(attentionHttpCount).toBe(1);
    liveWithoutEvidence = false;
    service.receiveResponse({
      eventId: "reply",
      requestId,
      memberId: "member",
      lineId: "line",
      conversationId: "conversation",
      channel: "text",
      text: "Blue",
    });
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(heartbeatCount).toBeGreaterThanOrEqual(1);
    await first.close();
    const closedHeartbeatCount = heartbeatCount;
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(heartbeatCount).toBe(closedHeartbeatCount);
    const resumed = await start(run);
    const duplicate = await call(resumed, "request_attention", input);
    expect(duplicate.value.request.id).toBe(requestId);
    expect(transport.calls).toHaveLength(1);
    const feedback = await call(resumed, "attention_result", {
      requestId,
      waitSeconds: 0,
    });
    expect(feedback.value.response.text).toBe("Blue");
    const other = await start(randomUUID());
    expect(
      (await call(other, "attention_result", { requestId, waitSeconds: 0 }))
        .error,
    ).toBe(true);
    await call(resumed, "acknowledge_response", {
      requestId,
      responseId: feedback.value.response.id,
    });
    const repeat = await call(resumed, "attention_result", {
      requestId,
      waitSeconds: 0,
    });
    expect(repeat.value.response.id).toBe(feedback.value.response.id);
    expect(repeat.value.response.acknowledgedSessionId).toBe(
      feedback.value.session.id,
    );
    const owned = store.get<any>("session", feedback.value.session.id);
    store.put("session", { ...owned, lastSeenAt: Date.now() - 20_001 });
    service.expireSessions();
    await resumed.close();
    const expired = await start(run);
    expect((await call(expired, "connection_status", {})).error).toBe(true);
    expect(store.all("session")).toHaveLength(2);
    expect(transport.calls).toHaveLength(1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(project, { recursive: true, force: true });
  }
}, 30_000);
