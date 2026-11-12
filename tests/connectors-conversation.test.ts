import { main } from "../cli/main.js";
import { mcpOutput } from "../connectors/shared/mcp.js";
import { describe, it, expect, vi } from "vitest";
import {
  protocolOptions,
  sessionCapabilities,
} from "../connectors/shared/protocol.js";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import {
  conversationCommands,
  executeConversationCommand,
} from "../connectors/shared/conversation.js";

describe("agent-owned connector conversation", () => {
  it("rejects capability/protocol flags that the run wrapper cannot forward", async () => {
    await expect(
      main([
        "run",
        "--agent",
        "codex",
        "--project",
        process.cwd(),
        "--protocol-version",
        "1",
      ]),
    ).rejects.toThrow("not run");
    await expect(
      main([
        "run",
        "--agent",
        "codex",
        "--project",
        process.cwd(),
        "--native-control",
        "desktop",
        "--shared-surface",
        "true",
      ]),
    ).rejects.toThrow("not run");
  });
  it("caps a slow final poll by the remaining wait budget", async () => {
    const timeouts: number[] = [];
    const original = AbortSignal.timeout;
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        timeouts.push(ms);
        return original(ms);
      });
    let count = 0;
    const request = (async (_url: unknown, init?: RequestInit) => {
      if (++count === 1) return new Response(JSON.stringify({ turns: [] }));
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("bounded timeout")),
          { once: true },
        ),
      );
    }) as typeof fetch;
    try {
      const client = new ClawdTimeClient(
        "http://127.0.0.1:3310",
        "synthetic-token",
        request,
      );
      await expect(
        executeConversationCommand(client, "conversation_turns", {
          requestId: "r",
          after: 0,
          waitSeconds: 1,
        }),
      ).rejects.toThrow("bounded timeout");
      expect(count).toBe(2);
      expect(timeouts[0]).toBeLessThanOrEqual(1000);
      expect(timeouts[1]).toBeLessThanOrEqual(500);
    } finally {
      timeout.mockRestore();
    }
  });
  it("returns transient fallback frames as MCP images, never base64 text or persisted JSON", () => {
    const value = mcpOutput({
      frame: { id: "fresh" },
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
    });
    expect(value.content).toEqual([
      { type: "text", text: '{"frame":{"id":"fresh"}}' },
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    ]);
    expect(() =>
      mcpOutput({ dataUrl: "https://untrusted.invalid/image" }),
    ).toThrow("Invalid transient");
  });
  it("defaults to v2 without inventing native surface or cancellation capability", () => {
    const options = protocolOptions({});
    expect(options.protocolVersion).toBe(2);
    expect(sessionCapabilities(options)).toMatchObject({
      nativeControl: "none",
      sharedSurface: false,
      nativeCancellation: false,
    });
    expect(() => protocolOptions({ "shared-surface": "true" })).toThrow();
    expect(protocolOptions({ "protocol-version": "1" }).protocolVersion).toBe(
      1,
    );
    expect(
      protocolOptions({
        "native-control": "browser",
        "shared-surface": "true",
      }),
    ).toMatchObject({
      nativeControl: "browser",
      sharedSurface: true,
      nativeCancellation: false,
    });
  });
  it("uses ordered cursors and keeps delivery, progress, replies and call ending separate", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const request = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify({
            turns: [{ id: "turn-2", sequence: 2 }],
            conversation: { state: "open" },
          }),
        );
      },
    ) as unknown as typeof fetch;
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic-token",
      request,
    );
    await executeConversationCommand(client, "conversation_turns", {
      requestId: "request/1",
      after: 1,
      waitSeconds: 0,
    });
    await executeConversationCommand(client, "acknowledge_turn", {
      requestId: "request/1",
      turnId: "turn-2",
    });
    await executeConversationCommand(client, "conversation_progress", {
      requestId: "request/1",
      turnId: "turn-2",
      state: "pending_approval",
    });
    await executeConversationCommand(client, "conversation_reply", {
      requestId: "request/1",
      turnId: "turn-2",
      replyId: "reply-2",
      text: "Waiting for native approval.",
    });
    expect(seen.map((s) => s.url)).toEqual([
      "http://127.0.0.1:3310/api/attention/request%2F1/conversation/turns?after=1",
      "http://127.0.0.1:3310/api/attention/request%2F1/conversation/ack",
      "http://127.0.0.1:3310/api/attention/request%2F1/conversation/progress",
      "http://127.0.0.1:3310/api/attention/request%2F1/conversation/reply",
    ]);
    expect(seen[3]?.body).toEqual({
      turnId: "turn-2",
      replyId: "reply-2",
      text: "Waiting for native approval.",
    });
    expect(seen.some((s) => s.url.endsWith("/end"))).toBe(false);
    await executeConversationCommand(client, "end_conversation", {
      requestId: "request/1",
    });
    expect(seen.at(-1)?.url.endsWith("/end")).toBe(true);
  });

  it("bounds polling and exposes unknown outcomes without retry", async () => {
    expect(() =>
      conversationCommands.conversation_turns.schema.parse({
        requestId: "r",
        waitSeconds: 21,
      }),
    ).toThrow();
    expect(() =>
      conversationCommands.conversation_turns.schema.parse({
        requestId: "r",
        after: -1,
      }),
    ).toThrow();
    const request = vi.fn(async () => {
      throw new Error("transport lost after dispatch");
    }) as unknown as typeof fetch;
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic-token",
      request,
    );
    await expect(
      executeConversationCommand(client, "conversation_reply", {
        requestId: "r",
        turnId: "t",
        replyId: "stable",
        text: "reply",
      }),
    ).rejects.toThrow("transport lost");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requires stopped conflicting actors and exact input shape, without inventing fallback consent", async () => {
    expect(() =>
      conversationCommands.transfer_execution.schema.parse({
        requestId: "r",
        expectedEpoch: 1,
        executor: "clawdtime",
        previousOutcome: "idle",
        backgroundActorsStopped: false,
      }),
    ).toThrow();
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "fallback disabled" }), {
          status: 403,
        }),
    ) as unknown as typeof fetch;
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "synthetic-token",
      request,
    );
    await expect(
      executeConversationCommand(client, "act_on_shared_screen", {
        requestId: "r",
        epoch: 1,
        actionId: "stable-action",
        frameId: "fresh",
        action: { kind: "click", x: 1, y: 1 },
      }),
    ).rejects.toThrow("403");
    expect(request).toHaveBeenCalledTimes(1);
    expect(() =>
      conversationCommands.act_on_shared_screen.schema.parse({
        requestId: "r",
        epoch: 1,
        actionId: "a",
        frameId: "f",
        action: { kind: "type", text: "" },
      }),
    ).toThrow();
  });
});
