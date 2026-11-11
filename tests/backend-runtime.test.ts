import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../src/runtime.js";
import { Store } from "../src/storage/store.js";
import { mediaSessionId } from "../src/transport/native.js";
import type { AttentionRequest, CallSession } from "../src/contracts.js";
afterEach(() => vi.unstubAllGlobals());
describe("runtime standby and mode boundaries", () => {
  it("rejects live startup without both handoff configuration and traffic gate", () => {
    expect(() => createRuntime({ CLAWDTIME_MODE: "live" })).toThrow(
      "explicit handoff",
    );
    expect(() =>
      createRuntime({ CLAWDTIME_MODE: "live", CLAWDTIME_LIVE_TRAFFIC: "true" }),
    ).toThrow("explicit handoff");
  });
  it("standby ends owned calls and polls cleanup without ingesting messages or dispatching new calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-runtime-"));
    try {
      const db = join(dir, "state.sqlite"),
        configPath = join(dir, "config.json"),
        requestId = "attention_fixture",
        localId = mediaSessionId(requestId),
        providerId = "00000000-0000-4000-8000-000000000001";
      writeFileSync(
        configPath,
        JSON.stringify({
          enabled: true,
          binding: {
            origin: "https://native.example.test",
            token: "fixture-token",
            signingSecret: "fixture-signature",
            lineId: "line",
            providerLineId: "provider",
            phone: "+15550000002",
            instanceId: "instance",
          },
          callsOrigin: "https://calls.example.test",
          projectId: "fixture-project",
          projectKey: "fixture-key",
          mediaOrigin: "https://media.example.test",
          mediaKey: "fixture-media-key-for-disposable-test-only",
          encryptionKey: "1".repeat(64),
          testerAllowlist: ["+15550000001"],
          testers: [
            {
              memberId: "member",
              recipient: "+15550000001",
              deviceId: "mac",
              displayId: "1",
            },
          ],
          handoff: {
            owner: "clawdtime",
            sourceOwnerPaused: true,
            lineId: "line",
            providerLineId: "provider",
            instanceId: "instance",
            baseline: { sequence: 1, eventId: "recv:baseline" },
            checkedAt: Date.now(),
            rollbackRecord: "private-fixture",
          },
        }),
        { mode: 0o600 },
      );
      const store = new Store(db);
      store.put("pairing", {
        id: "pair",
        memberId: "member",
        recipient: "+15550000001",
        conversationId: "iMessage;-;+15550000001",
        lineId: "line",
        deviceId: "mac",
        displayId: "1",
        createdAt: Date.now(),
        allowView: true,
        allowControl: true,
      });
      store.put<AttentionRequest>("attention", {
        id: requestId,
        sessionId: "agent",
        pairingId: "pair",
        taskId: "task",
        idempotencyKey: "once",
        reason: "decision",
        question: "Fixture",
        createdAt: Date.now(),
        deadline: Date.now() + 60000,
        state: "ringing",
        callId: localId,
      });
      store.put<CallSession>("call", {
        id: localId,
        requestId,
        pairingId: "pair",
        providerCallId: providerId,
        state: "ringing",
        remoteParticipantQualified: false,
        createdAt: Date.now(),
      });
      store.put("media", {
        id: localId,
        requestId,
        state: "allocated",
        providerCallId: providerId,
      });
      store.close();
      const urls: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        urls.push(url);
        const body = url.endsWith("/events")
          ? {
              data: {
                call_id: providerId,
                events: [
                  { id: "cleanup", type: "cleanup_complete", source: "worker" },
                ],
              },
            }
          : {};
        return new Response(JSON.stringify(body));
      });
      const runtime = createRuntime({
        CLAWDTIME_MODE: "standby",
        CLAWDTIME_LIVE_CONFIG: configPath,
        CLAWDTIME_DATABASE: db,
      });
      await runtime.tick();
      expect(urls.some((u) => u.endsWith(`/calls/${providerId}/end`))).toBe(
        true,
      );
      expect(urls.some((u) => u.includes("native.example.test"))).toBe(false);
      expect(urls.some((u) => new URL(u).pathname === "/api/v1/calls")).toBe(
        false,
      );
      expect(runtime.store.get<CallSession>("call", localId)?.state).toBe(
        "ended",
      );
      runtime.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses to conceal owned live sessions by switching to simulation without cleanup configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-runtime-"));
    try {
      const db = join(dir, "state.sqlite"),
        store = new Store(db);
      store.put("media", { id: "live-session", state: "unknown" });
      store.close();
      expect(() =>
        createRuntime({ CLAWDTIME_MODE: "simulation", CLAWDTIME_DATABASE: db }),
      ).toThrow("Owned live calls");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
