import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import { executeConversationCommand } from "../connectors/shared/conversation.js";
import {
  protocolOptions,
  sessionCapabilities,
} from "../connectors/shared/protocol.js";
import { startSetupSession } from "../connectors/shared/setup-session.js";
import { canonicalProject, secureWrite } from "../connectors/shared/state.js";

const selection = {
  version: 1 as const,
  surface: { kind: "display" as const, id: "2", displayId: 2 },
};
const intent = {
  commandId: "stable-command",
  planId: "plan",
  sceneId: "scene",
  generation: 0,
  window: {
    appId: "com.apple.finder",
    windowId: "12",
    ownerPid: 71,
    displayId: 2,
  },
  focus: { rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, durationMs: 450 },
  annotation: { kind: "label", text: "transient-private-label" },
};
const status = {
  version: 1,
  available: true,
  requestId: "request",
  generation: 0,
  planId: null,
  sceneId: null,
  unresolvedCommandId: null,
};
const receipt = {
  version: 1,
  commandId: intent.commandId,
  state: "accepted",
  reason: "target_presentation_applied",
  fingerprint: "a".repeat(64),
  receiptId: "receipt",
  observation: {
    window: intent.window,
    observedAt: 100,
    processIdentity: "process-start",
    windowBounds: { x: 0, y: 0, width: 100, height: 100 },
    appActive: true,
    windowFocused: true,
    windowOnScreen: true,
  },
  camera: {
    revision: 1,
    sourceFrameId: "frame",
    geometryGeneration: "geometry",
    contentRevision: "content",
    capturedAt: 100,
  },
};

describe("explicit production live presentation connector", () => {
  it("defaults off and requires an explicitly selected same-chat display session", () => {
    expect(sessionCapabilities(protocolOptions({}))).not.toHaveProperty(
      "livePresentationVersion",
    );
    const options = protocolOptions({
      "live-presentation": "true",
      "screen-camera": "true",
      "camera-display": "2",
    });
    expect(sessionCapabilities(options)).toMatchObject({
      screenCameraVersion: 1,
      livePresentationVersion: 1,
      nativeControl: "none",
    });
    expect(() =>
      sessionCapabilities({
        livePresentation: true,
        screenCamera: selection,
        conversation: {
          version: 1,
          runnerId: "remote-codex-app-server",
          executionSession: "api_managed",
        },
      }),
    ).toThrow("same-chat");
  });
  it.each([
    { "live-presentation": "maybe" },
    { "live-presentation": "true" },
    {
      "live-presentation": "true",
      "screen-camera": "true",
      "camera-display": "2",
      "camera-window": "12",
      "camera-owner-pid": "71",
    },
    {
      "live-presentation": "true",
      "screen-camera": "true",
      "camera-display": "2",
      "protocol-version": "1",
    },
    {
      "live-presentation": "true",
      "screen-camera": "true",
      "camera-display": "2",
      runner: "remote-codex-app-server",
      "execution-session": "api_managed",
    },
  ] as Record<string, string>[])(
    "rejects incompatible explicit capability flags: %j",
    (flags) => {
      expect(() => protocolOptions(flags)).toThrow();
    },
  );

  it("preflights the exact capability, writes once and reads a receipt without camera/input fallback", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const request = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify(
          String(url).endsWith("/presentation") && init?.method === "GET"
            ? status
            : receipt,
        ),
      );
    });
    const client = new ClawdTimeClient(
      "https://fixture.invalid",
      "synthetic",
      request as typeof fetch,
    );
    expect(
      await executeConversationCommand(client, "present_prepared_scene", {
        requestId: "request",
        intent,
      }),
    ).toEqual(receipt);
    expect(
      await executeConversationCommand(client, "live_presentation_receipt", {
        requestId: "request",
        commandId: intent.commandId,
      }),
    ).toEqual(receipt);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls[1]?.body).toEqual(intent);
    expect(
      calls.every((c) => c.url.includes("/conversation/presentation")),
    ).toBe(true);
  });

  it.each(["unsupported", "foreign", "unresolved"])(
    "refuses %s capability state before any write",
    async (kind) => {
      const request = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              kind === "unsupported"
                ? {}
                : {
                    ...status,
                    ...(kind === "foreign"
                      ? { requestId: "other" }
                      : { unresolvedCommandId: "old-command" }),
                  },
            ),
          ),
      );
      const client = new ClawdTimeClient(
        "https://fixture.invalid",
        "synthetic",
        request as typeof fetch,
      );
      await expect(
        client.presentPreparedScene("request", intent),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["http409", "malformed", "foreign-command", "foreign-window"])(
    "preserves an unknown %s post outcome without retry",
    async (kind) => {
      const request = vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.method === "GET"
                ? status
                : kind === "malformed"
                  ? {}
                  : kind === "foreign-command"
                    ? { ...receipt, commandId: "other" }
                    : kind === "foreign-window"
                      ? {
                          ...receipt,
                          observation: {
                            ...receipt.observation,
                            window: { ...intent.window, windowId: "99" },
                          },
                        }
                      : {},
            ),
            {
              status: init?.method === "POST" && kind === "http409" ? 409 : 200,
            },
          ),
      );
      const client = new ClawdTimeClient(
        "https://fixture.invalid",
        "synthetic",
        request as typeof fetch,
      );
      await expect(
        client.presentPreparedScene("request", intent),
      ).rejects.toThrow("outcome is unknown");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects a receipt lookup with a mismatched command identity", async () => {
    const client = new ClawdTimeClient(
      "https://fixture.invalid",
      "synthetic",
      async () =>
        new Response(JSON.stringify({ ...receipt, commandId: "other" })),
    );
    await expect(
      client.livePresentationReceipt("request", intent.commandId),
    ).rejects.toThrow("another command");
  });

  function bridgeFixture(echo = true, failPost = false) {
    const root = canonicalProject(
      mkdtempSync(join(tmpdir(), "clawdtime-live-connector-")),
    );
    const connection = join(root, "connection.json"),
      runId = "synthetic-live-presentation-chat";
    secureWrite(connection, {
      schemaVersion: 1,
      projectRoot: root,
      adapter: "codex",
      adapterVersion: "synthetic",
      hostId: "host",
      baseUrl: "https://fixture.invalid",
      token: "synthetic-pairing",
      pairing: { id: "pair" },
    });
    const input = new PassThrough(),
      output = new PassThrough(),
      messages: any[] = [],
      calls: { path: string; method: string; body: any }[] = [];
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += String(chunk);
      while (buffer.includes("\n")) {
        const i = buffer.indexOf("\n");
        messages.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    const request = (async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      const result =
        path === "/api/sessions"
          ? {
              session: {
                ...body,
                id: "session",
                capabilities: {
                  ...body.capabilities,
                  ...(!echo ? { livePresentationVersion: undefined } : {}),
                },
              },
              token: "synthetic-session",
            }
          : path === "/api/conversation/inbox"
            ? { requests: [{ id: "request", sessionId: "session" }] }
            : path.endsWith("/presentation") && method === "GET"
              ? status
              : path.includes("/presentation")
                ? receipt
                : {};
      return new Response(JSON.stringify(result), {
        status:
          failPost && path.endsWith("/presentation") && method === "POST"
            ? 409
            : 200,
      });
    }) as typeof fetch;
    return {
      root,
      connection,
      runId,
      input,
      output,
      messages,
      calls,
      options: {
        connection,
        project: root,
        adapter: "codex" as const,
        runId,
        input,
        output,
        request,
        screenCamera: selection,
        livePresentation: true,
      },
    };
  }

  it("registers capability and preserves marker-only foreground receipts without replay after unknown POST", async () => {
    const f = bridgeFixture(true, true),
      done = startSetupSession(f.options);
    try {
      await vi.waitFor(() => expect(f.messages[0]?.event).toBe("ready"));
      expect(f.calls[0]?.body.capabilities.livePresentationVersion).toBe(1);
      f.input.write(
        JSON.stringify({
          id: "present",
          command: "present_prepared_scene",
          args: { requestId: "request", intent },
        }) + "\n",
      );
      await vi.waitFor(() =>
        expect(f.messages.find((m) => m.id === "present")?.error).toContain(
          "unknown",
        ),
      );
      f.input.write(
        JSON.stringify({
          id: "present",
          command: "present_prepared_scene",
          args: { requestId: "request", intent },
        }) + "\n",
      );
      await vi.waitFor(() =>
        expect(f.messages.filter((m) => m.id === "present")).toHaveLength(2),
      );
      expect(
        f.calls.filter(
          (c) => c.path.endsWith("/presentation") && c.method === "POST",
        ),
      ).toHaveLength(1);
      const saved = readFileSync(
        join(f.root, "runs", `${f.runId}.setup.json`),
        "utf8",
      );
      expect(saved).not.toContain("transient-private-label");
      expect(JSON.parse(saved).effects.present).not.toHaveProperty("rejected");
    } finally {
      f.input.end();
      await done;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("preserves a registration that fails to echo the selected capability", async () => {
    const f = bridgeFixture(false);
    try {
      await expect(startSetupSession(f.options)).rejects.toThrow(
        "did not confirm",
      );
      const saved = JSON.parse(
        readFileSync(join(f.root, "runs", `${f.runId}.json`), "utf8"),
      );
      expect(saved.token).toBe("synthetic-session");
      expect(f.calls.filter((c) => c.path === "/api/sessions")).toHaveLength(1);
    } finally {
      f.input.end();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
