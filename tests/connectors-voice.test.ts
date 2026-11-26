import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protocolOptions,
  sessionCapabilities,
} from "../connectors/shared/protocol.js";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";
import { startSetupSession } from "../connectors/shared/setup-session.js";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import { executeConversationCommand } from "../connectors/shared/conversation.js";

const voiceFrontend = { version: 1 as const, provider: "elevenlabs" as const };
const managed = {
  version: 1 as const,
  runnerId: "remote-codex-app-server",
  executionSession: "api_managed" as const,
};

describe("explicit same-chat realtime voice", () => {
  it("defaults off and coexists with verified native desktop and selected camera", () => {
    expect(protocolOptions({}).voiceFrontend).toBeUndefined();
    const options = protocolOptions({
      "voice-frontend": "elevenlabs",
      "native-control": "desktop",
      "shared-surface": "true",
      "screen-camera": "true",
      "camera-display": "2",
    });
    expect(options.voiceFrontend).toEqual(voiceFrontend);
    expect(options.conversation).toBeUndefined();
    expect(sessionCapabilities(options)).toMatchObject({
      nativeControl: "desktop",
      sharedSurface: true,
      voiceInteractionVersion: 1,
      screenCameraVersion: 1,
    });
  });

  it.each([
    { "voice-frontend": "auto" },
    { "voice-frontend": "" },
    { "voice-frontend": "elevenlabs", "protocol-version": "1" },
    {
      "voice-frontend": "elevenlabs",
      runner: "remote-codex-app-server",
      "execution-session": "api_managed",
    },
  ] as Record<string, string>[])(
    "rejects unsupported selection %j",
    (flags) => {
      expect(() => protocolOptions(flags)).toThrow();
    },
  );

  it("rejects programmatic managed coexistence before recording a registration intent", () => {
    expect(() =>
      sessionCapabilities({ voiceFrontend, conversation: managed }),
    ).toThrow("same-chat");
  });

  function fixture() {
    const root = canonicalProject(
      mkdtempSync(join(tmpdir(), "clawdtime-voice-")),
    );
    const connection = join(root, "connection.json");
    const runId = "synthetic-realtime-chat";
    secureWrite(connection, {
      schemaVersion: 1,
      projectRoot: root,
      adapter: "codex",
      adapterVersion: "synthetic",
      hostId: "synthetic-host",
      baseUrl: "https://fixture.invalid",
      token: "synthetic-pairing",
      pairing: { id: "pair" },
    });
    const input = new PassThrough(),
      output = new PassThrough();
    const requests: { path: string; body: any }[] = [],
      messages: any[] = [];
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += String(chunk);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        messages.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    const request = (echo = true) =>
      (async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, body });
        return new Response(
          JSON.stringify(
            path === "/api/sessions"
              ? {
                  session: {
                    ...body,
                    id: "session",
                    ...(echo ? {} : { voiceFrontend: undefined }),
                  },
                  token: "synthetic-session",
                }
              : path === "/api/setup/test"
                ? {
                    test: {
                      id: "test",
                      requestId: "voice-request",
                      state: "completed",
                    },
                  }
                : path.endsWith("/voice/prepare")
                  ? {
                      version: 1,
                      prepared: true,
                      expiresAt: Date.now() + 300000,
                      targetIds: body.targets.map((t: any) => t.id),
                    }
                  : {},
          ),
        );
      }) as typeof fetch;
    return {
      root,
      connection,
      runId,
      input,
      output,
      requests,
      messages,
      request,
      options: {
        connection,
        project: root,
        adapter: "codex" as const,
        runId,
        input,
        output,
      },
    };
  }

  it("registers and reports realtime voice in this chat without inviting or calling", async () => {
    const f = fixture();
    const done = startSetupSession({
      ...f.options,
      voiceFrontend,
      nativeControl: "desktop",
      sharedSurface: true,
      request: f.request(),
    });
    try {
      await vi.waitFor(() => expect(f.messages[0]?.event).toBe("ready"));
      expect(f.messages[0]).toMatchObject({ currentChat: true, voiceFrontend });
      expect(f.requests[0]?.body).toMatchObject({
        voiceFrontend,
        capabilities: { nativeControl: "desktop", sharedSurface: true },
      });
      expect(f.requests[0]?.body).not.toHaveProperty("conversation");
      expect(f.requests.map((r) => r.path)).toEqual([
        "/api/sessions",
        "/api/sessions/heartbeat",
      ]);
    } finally {
      f.input.end();
      await done;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("prepares transient context in the foreground without persisting task text", async () => {
    const f = fixture();
    const done = startSetupSession({
      ...f.options,
      voiceFrontend,
      request: f.request(),
    });
    const send = async (id: string, command: string, args = {}) => {
      f.input.write(JSON.stringify({ id, command, args }) + "\n");
      await vi.waitFor(() =>
        expect(f.messages.some((m) => m.id === id)).toBe(true),
      );
      return f.messages.find((m) => m.id === id);
    };
    try {
      await vi.waitFor(() => expect(f.messages[0]?.event).toBe("ready"));
      await send("status", "status");
      expect(
        await send("prepare", "prepare_voice_presentation", {
          requestId: "voice-request",
          preparation: {
            version: 1,
            context: "transient-task-description",
            targets: [],
          },
        }),
      ).toMatchObject({ ok: true, result: { prepared: true } });
      const saved = readFileSync(
        join(f.root, "runs", `${f.runId}.setup.json`),
        "utf8",
      );
      expect(saved).not.toContain("transient-task-description");
      expect(JSON.parse(saved).effects).not.toHaveProperty("prepare");
    } finally {
      f.input.end();
      await done;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["add", "remove"])(
    "refuses to %s realtime voice on a saved run before HTTP",
    async (change) => {
      const f = fixture();
      secureWrite(join(f.root, "runs", `${f.runId}.json`), {
        schemaVersion: 1,
        runId: f.runId,
        projectRoot: f.root,
        adapter: "codex",
        session: {
          id: "session",
          ...(change === "remove" ? { voiceFrontend } : {}),
        },
        token: "synthetic-session",
      });
      try {
        await expect(
          startSetupSession({
            ...f.options,
            ...(change === "add" ? { voiceFrontend } : {}),
            request: f.request(),
          }),
        ).rejects.toThrow("immutable");
        expect(f.requests).toEqual([]);
      } finally {
        f.input.end();
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it("preserves a registration rejected by an older peer without silently using legacy voice", async () => {
    const f = fixture();
    try {
      await expect(
        startSetupSession({
          ...f.options,
          voiceFrontend,
          request: f.request(false),
        }),
      ).rejects.toThrow("did not confirm");
      expect(f.requests.map((r) => r.path)).toEqual(["/api/sessions"]);
      expect(
        JSON.parse(
          readFileSync(join(f.root, "runs", `${f.runId}.json`), "utf8"),
        ),
      ).toMatchObject({
        token: "synthetic-session",
        session: { id: "session" },
      });
      expect(f.messages).toEqual([]);
    } finally {
      f.input.end();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe("voice presentation client boundary", () => {
  const preparation = {
    version: 1,
    context: "Synthetic task data",
    geometryGeneration: "geometry",
    contentRevision: "content",
    targets: [
      {
        id: "focus",
        label: "Fixture area",
        rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      },
    ],
  };
  const status = {
    version: 1,
    sessionId: "s",
    deviceId: "d",
    leaseId: "l",
    revision: 0,
    state: "live",
    surface: { kind: "display", id: "2", displayId: 2 },
    sourceFrameId: "frame",
    capturedAt: Date.now(),
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

  it.each([
    "stale",
    "changed_content",
    "paused",
    "uncertain",
    "invalid_receipt",
    "ok",
  ])("handles %s preparation without retries", async (mode) => {
    const calls: string[] = [];
    const client = new ClawdTimeClient(
      "https://fixture.invalid",
      "synthetic",
      (async (_url, init) => {
        calls.push(init?.method ?? "GET");
        if (init?.method === "POST") {
          if (mode === "uncertain") throw new Error("Synthetic timeout");
          return new Response(
            JSON.stringify({
              version: 1,
              prepared: true,
              expiresAt: Date.now() + 300000,
              targetIds: mode === "invalid_receipt" ? ["other"] : ["focus"],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            ...status,
            ...(mode === "stale" ? { geometryGeneration: "old" } : {}),
            ...(mode === "changed_content" ? { contentRevision: "new" } : {}),
            ...(mode === "paused" ? { state: "paused" } : {}),
          }),
        );
      }) as typeof fetch,
    );
    const result = executeConversationCommand(
      client,
      "prepare_voice_presentation",
      { requestId: "request", preparation },
    );
    if (mode === "ok")
      await expect(result).resolves.toMatchObject({ prepared: true });
    else await expect(result).rejects.toThrow();
    expect(calls).toEqual([
      "GET",
      ...(["stale", "changed_content", "paused"].includes(mode)
        ? []
        : ["POST"]),
    ]);
  });

  it("rejects unbound or oversized targets before any network request", async () => {
    const request = vi.fn();
    const client = new ClawdTimeClient(
      "https://fixture.invalid",
      "synthetic",
      request,
    );
    await expect(
      client.prepareVoicePresentation("request", {
        ...preparation,
        geometryGeneration: undefined,
      }),
    ).rejects.toThrow("Invalid");
    await expect(
      client.prepareVoicePresentation("request", {
        ...preparation,
        context: "x".repeat(2001),
      }),
    ).rejects.toThrow("Invalid");
    expect(request).not.toHaveBeenCalled();
  });
});
