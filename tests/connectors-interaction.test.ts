import { describe, expect, it, vi } from "vitest";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import { executeConversationCommand } from "../connectors/shared/conversation.js";
import { inspectSession } from "../connectors/shared/inspection.js";
import {
  protocolOptions,
  sessionCapabilities,
  sessionInteraction,
} from "../connectors/shared/protocol.js";
import { ConnectorTiming } from "../connectors/shared/timing.js";

describe("iMessage-first connector negotiation", () => {
  it("negotiates new v2 only, with explicit message-update opt-out", () => {
    expect(sessionInteraction(protocolOptions({}))).toEqual({
      version: 1,
      commandChannel: "imessage_first",
      messageUpdates: true,
    });
    expect(
      sessionInteraction(protocolOptions({ "message-updates": "false" }))
        ?.messageUpdates,
    ).toBe(false);
    expect(
      sessionCapabilities(protocolOptions({})).voiceInteractionVersion,
    ).toBe(1);
    const legacy = protocolOptions({ "protocol-version": "1" });
    expect(sessionInteraction(legacy)).toBeUndefined();
    expect(sessionCapabilities(legacy).voiceInteractionVersion).toBeUndefined();
    expect(() => protocolOptions({ "message-updates": "perhaps" })).toThrow();
  });

  it.each([undefined, 1])(
    "never silently changes explicit text to voice on server version %s",
    async (version) => {
      const calls: { url: string; body?: unknown }[] = [];
      const client = new ClawdTimeClient(
        "http://127.0.0.1:3310",
        "private-token",
        (async (url, init) => {
          calls.push({
            url: String(url),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          return new Response(
            JSON.stringify(
              init?.method === "GET"
                ? { turns: [], capabilities: { interactionVersion: version } }
                : { state: "pending" },
            ),
          );
        }) as typeof fetch,
      );
      const task = executeConversationCommand(client, "conversation_reply", {
        requestId: "r",
        turnId: "t",
        replyId: "stable",
        text: "private-reply",
        expectedCursor: 2,
        channel: "text",
      });
      if (version === 1) {
        await expect(task).resolves.toEqual({ state: "pending" });
        expect(calls[1]?.body).toMatchObject({
          channel: "text",
          expectedCursor: 2,
        });
      } else {
        await expect(task).rejects.toThrow("not negotiated");
        expect(calls).toHaveLength(1);
      }
    },
  );

  it("forwards current cursor to guarded input exactly once and preserves unknown outcomes", async () => {
    const calls: unknown[] = [];
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "private",
      (async (_url, init) => {
        if (init?.method === "GET")
          return new Response(
            JSON.stringify({
              turns: [],
              capabilities: { interactionVersion: 1 },
            }),
          );
        calls.push(JSON.parse(String(init?.body)));
        throw new Error("uncertain native submission");
      }) as typeof fetch,
    );
    await expect(
      executeConversationCommand(client, "act_on_shared_screen", {
        requestId: "r",
        epoch: 1,
        actionId: "a",
        frameId: "f",
        expectedCursor: 3,
        action: { kind: "click", x: 0.2, y: 0.3 },
      }),
    ).rejects.toThrow("uncertain native");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ expectedCursor: 3, actionId: "a" });
    expect(
      client.conversationTiming("r").connectorTiming.events.at(-1)?.event,
    ).toBe("connector_act_failed");
  });

  it("returns a speech hold promptly even without a finalized turn", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ turns: [], hold: { active: true } })),
    );
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "private",
      fetcher as typeof fetch,
    );
    await expect(
      executeConversationCommand(client, "conversation_turns", {
        requestId: "r",
        waitSeconds: 20,
      }),
    ).resolves.toMatchObject({ hold: { active: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads inbox without a request id and inspects timing without HTTP traffic", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            requests: [{ id: "text-only", sessionId: "session" }],
          }),
        ),
    );
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "private",
      fetcher as typeof fetch,
    );
    expect(
      await executeConversationCommand(client, "conversation_inbox", {}),
    ).toMatchObject({ requests: [{ id: "text-only" }] });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/api/conversation/inbox",
    );
    await executeConversationCommand(client, "conversation_timing", {
      requestId: "text-only",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("connector timing evidence", () => {
  it("measures independent HTTP attempts, redacts content, and reports failures", () => {
    let now = 100;
    const clock = new ConnectorTiming(() => now);
    const first = clock.begin("PRIVATE_REQUEST", "observe");
    now = 350;
    first("completed");
    first("completed");
    const second = clock.begin("PRIVATE_REQUEST", "observe");
    now = 700;
    second("failed");
    const raw = { connectorTiming: clock.snapshot("PRIVATE_REQUEST") };
    const report = inspectSession(raw);
    expect(
      report.metrics.find((m) => m.name === "connector_observe_round_trip"),
    ).toMatchObject({
      sampleCount: 1,
      failedCount: 1,
      attemptedCount: 2,
      medianMs: 250,
    });
    expect(JSON.stringify(raw)).not.toContain("PRIVATE_REQUEST");
    expect(report.unmeasured).toContain("native_tool_internals");
  });

  it("bounds memory, expires requests, and refuses cross-clock finishes", () => {
    let now = 0;
    const timing = new ConnectorTiming(() => now);
    for (let i = 0; i < 40; i++) {
      const done = timing.begin("r", "poll");
      now++;
      done("completed");
    }
    expect(timing.snapshot("r").events).toHaveLength(64);
    const old = timing.begin("r", "act");
    const process = timing.snapshot("r").processId;
    now = -1;
    old("completed");
    expect(timing.snapshot("r").processId).not.toBe(process);
    expect(timing.snapshot("r").events).toEqual([]);
    for (let i = 0; i < 101; i++) timing.begin(`r${i}`, "poll")("completed");
    expect(timing.snapshot("r100").events).toEqual([]);
    now += 600_000;
    expect(timing.snapshot("r0").events).toEqual([]);
  });

  it("does not pair media, backend and connector clocks or expose unapproved metadata", () => {
    const event = (
      sequence: number,
      name: string,
      elapsedMs: number,
      other = {},
    ) => ({
      sequence,
      event: name,
      elapsedMs,
      correlationId: "1".repeat(24),
      ...other,
    });
    const report = inspectSession({
      controlTiming: {
        processId: "a".repeat(32),
        events: [
          event(1, "input_started", 10),
          event(2, "input_submitted", 30),
          event(3, "input_observed", 90),
        ],
      },
      connectorTiming: {
        processId: "b".repeat(32),
        events: [
          event(1, "connector_act_started", 0),
          event(2, "connector_act_completed", 120),
        ],
      },
      media: {
        speechPipeline: {
          processId: "c".repeat(32),
          events: [
            event(1, "tts_requested", 100),
            event(2, "tts_first_byte", 140),
            event(3, "audio_first_published", 160),
            event(4, "interruption_detected", 200),
            event(5, "playback_cleared", 220),
            event(6, "event_loop_lag", 230, {
              durationMs: 17,
              token: "SECRET",
              text: "PRIVATE",
            }),
          ],
        },
      },
    });
    expect(
      report.metrics.find((m) => m.name === "input_submission")?.medianMs,
    ).toBe(20);
    expect(
      report.metrics.find((m) => m.name === "input_observation")?.medianMs,
    ).toBe(60);
    expect(
      report.metrics.find((m) => m.name === "connector_act_round_trip")
        ?.medianMs,
    ).toBe(120);
    expect(
      report.metrics.find((m) => m.name === "tts_first_publication")?.medianMs,
    ).toBe(60);
    expect(
      report.metrics.find((m) => m.name === "interruption_clear")?.medianMs,
    ).toBe(20);
    expect(report.eventLoopLag).toMatchObject({ sampleCount: 1, medianMs: 17 });
    expect(JSON.stringify(report)).not.toMatch(/SECRET|PRIVATE/);
  });
});
