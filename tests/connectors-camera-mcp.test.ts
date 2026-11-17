import { it, expect } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";

it("actual stdio MCP negotiates the immutable camera and sends bounded commands once without CUA", async () => {
  const root = canonicalProject(
    mkdtempSync(join(tmpdir(), "clawdtime-camera-mcp-")),
  );
  const app = new Hono();
  let registration: any,
    mutations = 0,
    input = 0;
  const session: any = {
    id: "session",
    protocolVersion: 2,
    state: "active",
    controlEpoch: 0,
  };
  const status = {
    version: 1,
    sessionId: "session",
    deviceId: "device",
    leaseId: "lease",
    revision: 0,
    state: "live",
    surface: { kind: "window", id: "14", displayId: 2, ownerPid: 71 },
    sourceFrameId: "frame",
    capturedAt: 100,
    geometryGeneration: "geometry",
    contentRevision: "content",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    source: null,
    output: {
      width: 1280,
      height: 720,
      viewport: { x: 0, y: 0, width: 1280, height: 720 },
    },
    pinned: false,
    moving: false,
    annotations: [],
    context: null,
  };
  app.post("/api/sessions", async (c) => {
    registration = await c.req.json();
    Object.assign(session, registration);
    return c.json({ session, token: "synthetic-session" });
  });
  app.post("/api/sessions/heartbeat", (c) => c.json({ session }));
  app.get("/api/doctor", (c) => c.json({ mode: "simulation", session }));
  app.get("/api/attention/request/conversation/camera", (c) => c.json(status));
  app.post("/api/attention/request/conversation/camera", async (c) => {
    const command = await c.req.json();
    mutations++;
    expect(command).toEqual({
      version: 1,
      commandId: "stable",
      expectedRevision: 0,
      sourceFrameId: "frame",
      geometryGeneration: "geometry",
      op: "overview",
    });
    return c.json({
      version: 1,
      commandId: command.commandId,
      revision: 1,
      state: "accepted",
    });
  });
  app.post("/api/attention/request/conversation/act", (c) => {
    input++;
    return c.json({});
  });
  app.post("/api/attention/request/conversation/voice/prepare", async (c) => {
    const preparation = await c.req.json();
    expect(preparation.context).toBe("Synthetic task context");
    expect(preparation.geometryGeneration).toBe("geometry");
    expect(preparation.contentRevision).toBe("content");
    return c.json({
      version: 1,
      prepared: true,
      expiresAt: Date.now() + 300000,
      targetIds: ["fixture"],
    });
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.on("listening", r));
  const connection = join(root, "connection.json");
  secureWrite(connection, {
    schemaVersion: 1,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "synthetic-pairing",
    pairing: { id: "pairing" },
    adapter: "codex",
    adapterVersion: "synthetic",
    projectRoot: root,
    hostId: "host",
  });
  const clients: Client[] = [];
  const runId = randomUUID();
  const start = async (display: string, voice = true) => {
    const client = new Client({ name: "camera-fixture", version: "1" });
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
          root,
          "--agent",
          "codex",
          "--screen-camera",
          "true",
          "--camera-display",
          display,
          "--camera-window",
          "14",
          "--camera-owner-pid",
          "71",
          ...(voice ? ["--voice-frontend", "elevenlabs"] : []),
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
    const client = await start("2");
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("screen_camera_command");
    const observed = await client.callTool({
      name: "screen_camera_status",
      arguments: { requestId: "request" },
    });
    expect(observed.isError).toBeFalsy();
    expect(registration.screenCamera).toEqual({
      version: 1,
      surface: status.surface,
    });
    expect(registration.voiceFrontend).toEqual({
      version: 1,
      provider: "elevenlabs",
    });
    expect(registration.conversation).toBeUndefined();
    const prepared = await client.callTool({
      name: "prepare_voice_presentation",
      arguments: {
        requestId: "request",
        preparation: {
          version: 1,
          context: "Synthetic task context",
          geometryGeneration: "geometry",
          contentRevision: "content",
          targets: [
            {
              id: "fixture",
              label: "Fixture area",
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
            },
          ],
        },
      },
    });
    expect(prepared.isError).toBeFalsy();
    expect(registration.capabilities).toMatchObject({
      screenCameraVersion: 1,
      nativeControl: "none",
      sharedSurface: false,
    });
    const command = await client.callTool({
      name: "screen_camera_command",
      arguments: {
        requestId: "request",
        command: {
          version: 1,
          commandId: "stable",
          expectedRevision: 0,
          sourceFrameId: "frame",
          geometryGeneration: "geometry",
          op: "overview",
        },
      },
    });
    expect(command.isError).toBeFalsy();
    expect(mutations).toBe(1);
    expect(input).toBe(0);
    await client.close();
    // Reopening a protected run with another display fails before re-registration.
    await expect(start("3")).rejects.toThrow();
    await expect(start("2", false)).rejects.toThrow();
    expect(mutations).toBe(1);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
