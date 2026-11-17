import { expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";

it("actual stdio MCP negotiates live presentation and exposes one-shot intent/status/receipt tools", async () => {
  const root = canonicalProject(
    mkdtempSync(join(tmpdir(), "clawdtime-live-mcp-")),
  );
  const app = new Hono();
  let session: any,
    posts = 0;
  const paths: string[] = [];
  const receipt = {
    version: 1,
    commandId: "stable",
    state: "rejected",
    reason: "synthetic_target_unavailable",
    fingerprint: "a".repeat(64),
    receiptId: "receipt",
  };
  app.use("*", async (c, next) => {
    paths.push(c.req.path);
    await next();
  });
  app.post("/api/sessions", async (c) => {
    session = { ...(await c.req.json()), id: "session", state: "active" };
    return c.json({ session, token: "synthetic-session" });
  });
  app.post("/api/sessions/heartbeat", (c) => c.json({ session }));
  app.get("/api/attention/request/conversation/presentation", (c) =>
    c.json({
      version: 1,
      available: true,
      requestId: "request",
      generation: 0,
      planId: null,
      sceneId: null,
      unresolvedCommandId: null,
    }),
  );
  app.post("/api/attention/request/conversation/presentation", async (c) => {
    posts++;
    expect((await c.req.json()).commandId).toBe("stable");
    return c.json(receipt);
  });
  app.get(
    "/api/attention/request/conversation/presentation/receipts/stable",
    (c) => c.json(receipt),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const connection = join(root, "connection.json");
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "synthetic-pairing",
    pairing: { id: "pair" },
    adapter: "codex",
    adapterVersion: "synthetic",
    projectRoot: root,
    hostId: "host",
  });
  const clients: Client[] = [],
    runId = randomUUID();
  const start = async (live = true) => {
    const client = new Client({ name: "live-fixture", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("cli/main.ts"),
          "mcp",
          "--agent",
          "codex",
          "--connection",
          connection,
          "--project",
          root,
          "--screen-camera",
          "true",
          "--camera-display",
          "2",
          ...(live ? ["--live-presentation", "true"] : []),
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
  try {
    const client = await start();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "present_prepared_scene",
        "live_presentation_status",
        "live_presentation_receipt",
      ]),
    );
    expect(
      (
        await client.callTool({
          name: "live_presentation_status",
          arguments: { requestId: "request" },
        })
      ).isError,
    ).toBeFalsy();
    expect(session.capabilities.livePresentationVersion).toBe(1);
    expect(session.screenCamera.surface).toEqual({
      kind: "display",
      id: "2",
      displayId: 2,
    });
    expect(
      (
        await client.callTool({
          name: "present_prepared_scene",
          arguments: {
            requestId: "request",
            intent: {
              commandId: "stable",
              planId: "plan",
              sceneId: "scene",
              generation: 0,
              window: {
                appId: "com.apple.finder",
                windowId: "12",
                ownerPid: 71,
                displayId: 2,
              },
              focus: {
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
                durationMs: 450,
              },
            },
          },
        })
      ).isError,
    ).toBeFalsy();
    expect(
      (
        await client.callTool({
          name: "live_presentation_receipt",
          arguments: { requestId: "request", commandId: "stable" },
        })
      ).isError,
    ).toBeFalsy();
    expect(posts).toBe(1);
    expect(
      paths.some(
        (p) =>
          p.includes("/act") || p.includes("/setup") || p.includes("/camera"),
      ),
    ).toBe(false);
    await client.close();
    await expect(start(false)).rejects.toThrow();
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
