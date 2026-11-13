import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { NativeTransport } from "../src/transport/native.js";
import { Vault } from "../src/storage/security.js";
import type { AgentSession, AttentionRequest } from "../src/contracts.js";
import type { ConversationTurn } from "../src/attention/conversation.js";

afterEach(() => vi.unstubAllGlobals());

describe("runtime text routing compatibility", () => {
  it.each(["stopped", "stale"] as const)(
    "ignores a historical %s opted session when routing to the sole active legacy session",
    async (history) => {
      // Exercise the actual inbox/router with every provider boundary stubbed.
      // An unexpected external request fails the test; no physical line is used.
      const network = vi.fn(async () => {
        throw new Error("Unexpected network request in isolated routing test");
      });
      vi.stubGlobal("fetch", network);
      const lineId = "00000000-0000-4000-8000-000000000099";
      const recipient = "+15550000001";
      const config = {
        enabled: true,
        binding: {
          origin: "https://native.example.test",
          token: "fixture-native-token",
          signingSecret: "fixture-native-signature",
          lineId,
          providerLineId: "fixture-provider-line",
          phone: "+15550000002",
          instanceId: "fixture-instance",
        },
        callsOrigin: "https://calls.example.test",
        projectId: "fixture-project",
        projectKey: "fixture-project-key",
        mediaOrigin: "https://media.example.test",
        mediaKey: "fixture-independent-media-key-at-least-32",
        encryptionKey: "1".repeat(64),
        testerAllowlist: [recipient],
        testers: [
          { memberId: "human", recipient, deviceId: "mac", displayId: "1" },
        ],
        handoff: {
          owner: "clawdtime",
          sourceOwnerPaused: true,
          phone: "+15550000002",
          identityEvidence: "fixture-identity",
          sourcePauseEvidence: "fixture-pause",
          lineId,
          providerLineId: "fixture-provider-line",
          instanceId: "fixture-instance",
          baseline: { sequence: 1, eventId: "fixture-boundary" },
          checkedAt: Date.now(),
          rollbackRecord: "fixture-rollback",
        },
      };
      const runtime = createRuntime({
        CLAWDTIME_MODE: "live",
        CLAWDTIME_LIVE_TRAFFIC: "true",
        CLAWDTIME_LIVE_CONFIG_JSON: JSON.stringify(config),
        CLAWDTIME_DATABASE: ":memory:",
        CLAWDTIME_ORIGIN: "https://clawdtime.example.test",
        CLAWDTIME_OPERATOR_TOKEN: "fixture-operator-secret-at-least-32",
        CLAWDTIME_MEDIA_TOKEN: "fixture-media-callback-secret-at-least-32",
      });
      try {
        const transport = runtime.transport;
        if (!(transport instanceof NativeTransport))
          throw new Error("Expected native fixture");
        const checks = [
          "live_gate",
          "native_configuration",
          "service_configuration",
          "line_handoff",
          "handoff_boundary",
          "native_identity",
          "native_cursor",
          "logical_identity",
          "line_occupancy",
        ].map((id) => ({
          id,
          status: "pass" as const,
          message: "Isolated fixture",
        }));
        runtime.store.saveState("native-preflight", { checks });
        vi.spyOn(transport, "preflight").mockResolvedValue({
          checkedAt: Date.now(),
          mode: "live",
          liveReady: true,
          bindingFingerprint: "fixture",
          checks,
        });
        vi.spyOn(transport, "preflightDevice").mockResolvedValue({
          checkedAt: Date.now(),
          deviceId: "mac",
          memberId: "human",
          displayId: "1",
          bindingFingerprint: "fixture",
          checks: [],
        });
        vi.spyOn(transport.messages, "cursor").mockReturnValue(
          config.handoff.baseline,
        );
        vi.spyOn(transport.messages, "poll").mockResolvedValue(undefined);
        vi.spyOn(transport, "pollCalls").mockResolvedValue(undefined);
        const invite = runtime.service.createPairingInvite({
          memberId: "human",
          recipient,
          lineId,
          conversationId: `iMessage;-;${recipient}`,
          deviceId: "mac",
          displayId: "1",
        });
        const paired = runtime.service.claimPairing({
          token: invite.token,
          deviceId: "mac",
          displayId: "1",
          allowView: true,
          allowControl: true,
        });
        const registration = {
          protocolVersion: 2 as const,
          adapter: "codex" as const,
          adapterVersion: "fixture",
          projectRoot: "/synthetic",
          externalSessionId: "legacy-active",
          hostId: "mac",
          capabilities: { cooperativePause: true, polling: true },
        };
        // Existing v2 clients omit interaction negotiation and retain pending-request routing.
        const active = runtime.service.registerSession(
          paired.token,
          registration,
        );
        const old = runtime.service.registerSession(paired.token, {
          ...registration,
          externalSessionId: "historical-opted",
          interaction: {
            version: 1,
            commandChannel: "imessage_first",
            messageUpdates: true,
          },
        });
        runtime.store.put<AgentSession>("session", {
          ...old.session,
          state: history === "stopped" ? "stopped" : old.session.state,
          lastSeenAt: history === "stale" ? Date.now() - 60_000 : Date.now(),
        });
        const requestId = "fixture-legacy-pending";
        runtime.store.put<AttentionRequest>("attention", {
          id: requestId,
          sessionId: active.session.id,
          pairingId: paired.pairing.id,
          taskId: "fixture-task",
          idempotencyKey: "fixture-request",
          reason: "decision",
          question: "Choose a fixture",
          state: "awaiting_input",
          createdAt: Date.now(),
          deadline: Date.now() + 300_000,
        });
        const event = {
          id: "fixture-text",
          lineId,
          sender: recipient,
          conversationId: paired.pairing.conversationId,
          text: "Use the blue fixture.",
        };
        runtime.store.put("inbound", {
          id: event.id,
          sealed: new Vault(config.encryptionKey).seal(event),
          state: "pending",
        });
        await runtime.tick();
        expect(runtime.store.state("heartbeat")).toMatchObject({ ok: true });
        expect(
          runtime.store.all<ConversationTurn>("conversation_turn"),
        ).toEqual([
          expect.objectContaining({
            requestId,
            sessionId: active.session.id,
            text: event.text,
          }),
        ]);
        expect(runtime.store.get("inbound", event.id)).toMatchObject({
          state: "done",
          sealed: "",
        });
        expect(runtime.store.all("notice")).toHaveLength(0);
        expect(runtime.store.all("attention")).toHaveLength(1);
        expect(runtime.store.all("call")).toHaveLength(0);
        expect(network).not.toHaveBeenCalled();
      } finally {
        await runtime.stop();
        runtime.store.close();
      }
    },
  );
});
