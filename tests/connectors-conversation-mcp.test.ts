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
import { ConversationService } from "../src/attention/conversation.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";

it("v2 MCP keeps one exact session across ordered turns and reconnect without replaying speech or ending sharing", async () => {
  const project = canonicalProject(
      mkdtempSync(join(tmpdir(), "clawdtime-v2-mcp-")),
    ),
    store = new Store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(store, transport),
    turns = new ConversationService(service),
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
      displayId: binding.displayId,
      allowView: true,
      allowControl: true,
    });
  const token = (c: any) => c.req.header("authorization").slice(7);
  app.onError((e, c) => c.json({ error: e.message }, 409));
  app.post("/api/sessions", async (c) =>
    c.json(service.registerSession(token(c), await c.req.json())),
  );
  app.post("/api/sessions/heartbeat", (c) =>
    c.json({ session: service.heartbeat(token(c)) }),
  );
  app.get("/api/doctor", (c) => c.json(service.doctor(token(c))));
  app.post("/api/attention", async (c) => {
    const request = service.requestAttention(token(c), await c.req.json());
    await service.drain();
    service.observeCall(request.id, "connected", true);
    return c.json({ request: service.status(token(c), request.id) });
  });
  app.get("/api/attention/:id/conversation/turns", (c) =>
    c.json(
      turns.poll(
        token(c),
        c.req.param("id"),
        Number(c.req.query("after") ?? 0),
      ),
    ),
  );
  app.post("/api/attention/:id/conversation/ack", async (c) =>
    c.json(
      turns.acknowledge(
        token(c),
        c.req.param("id"),
        (await c.req.json()).turnId,
      ),
    ),
  );
  app.post("/api/attention/:id/conversation/progress", async (c) => {
    const b = await c.req.json();
    return c.json(
      turns.progress(token(c), c.req.param("id"), b.turnId, b.state),
    );
  });
  app.post("/api/attention/:id/conversation/reply", async (c) =>
    c.json(await turns.reply(token(c), c.req.param("id"), await c.req.json())),
  );
  app.post("/api/attention/:id/conversation/end", (c) =>
    c.json(turns.end(token(c), c.req.param("id"))),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const connection = join(project, "connection.json");
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    ...grant,
    adapter: "codex",
    adapterVersion: "synthetic",
    projectRoot: project,
    hostId: "fixture-host",
  });
  const clients: Client[] = [];
  const start = async (runId: string) => {
    const client = new Client({ name: "fixture", version: "1" });
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
          CLAWDTIME_RUN_ID: runId,
        },
        stderr: "pipe",
      }),
    );
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      error: result.isError,
      value: JSON.parse((result.content as { text: string }[])[0]!.text),
    };
  };
  try {
    const runId = randomUUID(),
      first = await start(runId);
    const status = await call(first, "connection_status");
    expect(status.value.protocolVersion).toBe(2);
    expect(
      (await call(first, "yield_control", { backgroundActorsStopped: true }))
        .error,
    ).toBe(true);
    const created = await call(first, "request_attention", {
      taskId: "fixture",
      idempotencyKey: "stable-call",
      reason: "decision",
      question: "Fixture?",
    });
    expect(created.error).toBeFalsy();
    const requestId = created.value.request.id;
    const one = turns.receive({
      memberId: binding.memberId,
      lineId: binding.lineId,
      conversationId: binding.conversationId,
      eventId: "synthetic-one",
      requestId,
      channel: "text",
      text: "Choose blue.",
    });
    const two = turns.receive({
      memberId: binding.memberId,
      lineId: binding.lineId,
      conversationId: binding.conversationId,
      eventId: "synthetic-two",
      requestId,
      channel: "text",
      text: "Then choose green.",
      kind: "correction",
    });
    const batch = await call(first, "conversation_turns", {
      requestId,
      after: 0,
      waitSeconds: 0,
    });
    expect(batch.value.turns.map((t: any) => t.sequence)).toEqual([1, 2]);
    await call(first, "acknowledge_turn", { requestId, turnId: one.id });
    expect(
      (await call(first, "conversation_turns", { requestId, after: 0 })).value
        .turns[0].state,
    ).toBe("received");
    const stale = await call(first, "conversation_reply", {
      requestId,
      turnId: one.id,
      replyId: "reply-one",
      text: "Blue chosen.",
      expectedCursor: 1,
    });
    expect(stale.error).toBe(true);
    expect(transport.spoken).toHaveLength(0);
    await call(first, "acknowledge_turn", { requestId, turnId: two.id });
    await call(first, "conversation_progress", {
      requestId,
      turnId: one.id,
      state: "executing",
    });
    const spoken = await call(first, "conversation_reply", {
      requestId,
      turnId: one.id,
      replyId: "reply-one",
      text: "Green chosen.",
      expectedCursor: batch.value.cursor,
    });
    expect(spoken.error).toBeFalsy();
    await call(first, "conversation_progress", {
      requestId,
      turnId: one.id,
      state: "completed",
    });
    expect(transport.ended).toHaveLength(0);
    expect(store.all<any>("session")[0]?.state).toBe("active");
    await first.close();
    const reconnected = await start(runId);
    const existing = await call(reconnected, "conversation_turns", {
      requestId,
      after: 0,
    });
    expect(existing.value.replies).toHaveLength(1);
    expect(existing.value.session.id).toBe(batch.value.session.id);
    const repeat = await call(reconnected, "conversation_reply", {
      requestId,
      turnId: one.id,
      replyId: "reply-one",
      text: "Green chosen.",
      expectedCursor: batch.value.cursor,
    });
    expect(repeat.error).toBeFalsy();
    expect(transport.spoken).toHaveLength(1);
    expect(
      (
        await call(reconnected, "conversation_reply", {
          requestId,
          turnId: one.id,
          replyId: "different",
          text: "Blue chosen.",
        })
      ).error,
    ).toBe(true);
    await call(reconnected, "acknowledge_turn", { requestId, turnId: two.id });
    await call(reconnected, "conversation_progress", {
      requestId,
      turnId: two.id,
      state: "pending_approval",
    });
    expect(transport.ended).toHaveLength(0);
    const other = await start(randomUUID());
    expect(
      (await call(other, "conversation_turns", { requestId, after: 0 })).error,
    ).toBe(true);
    await call(reconnected, "end_conversation", { requestId });
    await service.drain();
    expect(transport.calls).toHaveLength(1);
    expect(transport.ended).toHaveLength(1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(project, { recursive: true, force: true });
  }
}, 15000);
