import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../src/runtime.js";
import { Store } from "../src/storage/store.js";
import { hash } from "../src/storage/security.js";
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
  it("cannot poll live traffic with incomplete ownership evidence even when other configuration exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-runtime-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(
        path,
        JSON.stringify({
          enabled: true,
          binding: {
            origin: "https://native.example.test",
            token: "fixture",
            signingSecret: "fixture",
            lineId: "line",
            providerLineId: "provider",
            phone: "+15550000002",
            instanceId: "instance",
          },
          callsOrigin: "https://calls.example.test",
          projectId: "fixture",
          projectKey: "fixture",
          mediaOrigin: "https://media.example.test",
          mediaKey: "fixture-independent-media-key-at-least-32",
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
            baseline: { sequence: 1, eventId: "fixture" },
            checkedAt: Date.now(),
            rollbackRecord: "fixture",
          },
        }),
        { mode: 0o600 },
      );
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(() =>
        createRuntime({
          CLAWDTIME_MODE: "live",
          CLAWDTIME_LIVE_TRAFFIC: "true",
          CLAWDTIME_LIVE_CONFIG: path,
          CLAWDTIME_DATABASE: join(dir, "state.sqlite"),
          CLAWDTIME_ORIGIN: "https://clawdtime.example.test",
          CLAWDTIME_OPERATOR_TOKEN: "fixture-operator-at-least-32-characters",
          CLAWDTIME_MEDIA_TOKEN:
            "fixture-media-callback-at-least-32-characters",
        }),
      ).toThrow("exclusive line handoff");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
            phone: "+15550000002",
            identityEvidence: "private-fixture-identity",
            sourcePauseEvidence: "private-fixture-pause",
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
  it("strips tester audit metadata before verified inbound pairing and sends its notice only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-runtime-pair-"));
    const lineId = "00000000-0000-4000-8000-000000000099",
      providerLineId = "pl_fixture",
      phone = "+15550000002",
      tester = "+15550000001",
      instanceId = "fixture-instance";
    const config = {
      enabled: true,
      binding: {
        origin: "https://native.example.test",
        token: "fixture-native-token-long-enough",
        signingSecret: "fixture-native-signature-long-enough",
        lineId,
        providerLineId,
        phone,
        instanceId,
      },
      callsOrigin: "https://calls.example.test",
      projectId: "fixture-project",
      projectKey: "fixture-project-key-long-enough",
      mediaOrigin: "https://media.example.test",
      mediaKey: "fixture-independent-media-key-long-enough",
      encryptionKey: "1".repeat(64),
      testerAllowlist: [tester],
      testers: [
        {
          memberId: "member",
          recipient: tester,
          deviceId: "mac",
          displayId: "1",
          authorization: {
            approvedBy: "fixture-owner",
            purpose: "test-only-audit-metadata",
          },
        },
      ],
      handoff: {
        owner: "clawdtime",
        sourceOwnerPaused: true,
        phone,
        identityEvidence: "private-fixture-identity",
        sourcePauseEvidence: "private-fixture-pause",
        lineId,
        providerLineId,
        instanceId,
        baseline: { sequence: 1, eventId: "fixture-boundary" },
        checkedAt: Date.now(),
        rollbackRecord: "private-fixture-rollback",
      },
    };
    const anchor = {
      sequence: 1,
      event_id: "fixture-boundary",
      type: "boundary",
      phone_line_id: providerLineId,
      payload: { phone_line_id: providerLineId },
    };
    const inbound = {
      sequence: 2,
      event_id: "recv:fixture-pair",
      type: "message_received",
      phone_line_id: providerLineId,
      payload: {
        phone_line_id: providerLineId,
        message: {
          guid: "fixture-pair",
          phone_line_id: providerLineId,
          role: "inbound",
          status: "received",
          service: "imessage",
          recipient: tester,
          chat_id: `iMessage;-;${tester}`,
          is_group: false,
          parts: [{ type: "text", text: "pair" }],
        },
      },
    };
    const sends: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url)),
          body = init?.body ? JSON.parse(String(init.body)) : undefined;
        let result: unknown;
        if (u.pathname === "/api/v1/whoami")
          result = {
            healthy: true,
            phone_line: {
              phone_line_id: providerLineId,
              phone_number: phone,
              instance_id: instanceId,
            },
          };
        else if (u.pathname === "/api/v1/events/1") result = anchor;
        else if (u.pathname === "/api/v1/events/2") result = inbound;
        else if (u.pathname === "/api/v1/events/catchup")
          result = {
            events:
              u.searchParams.get("since_sequence") === "1" ? [inbound] : [],
            head_sequence: 2,
            has_more: false,
          };
        else if (u.pathname === "/api/v1/lines")
          result = {
            data: {
              items: [
                {
                  id: lineId,
                  phone_number: null,
                  status: "available",
                  current_call_id: null,
                  worker_occupied: false,
                  session_health: {
                    line_id: lineId,
                    identity_confirmed: true,
                    status: "accepting",
                    last_heartbeat_at: new Date().toISOString(),
                    readiness: {
                      control_ready: true,
                      facetime_signed_in: true,
                      accessibility_ready: true,
                      screen_capture_ready: true,
                      audio_ready: true,
                      video_ready: true,
                      production_media_ready: true,
                    },
                  },
                },
              ],
              total: 1,
              limit: 100,
              offset: 0,
            },
          };
        else if (u.pathname === "/health")
          result = {
            service: "clawdtime-media",
            ok: true,
            configured: true,
            devicesConfigured: false,
            deviceGatewayConnected: false,
          };
        else if (u.pathname === "/api/v1/text-operations/v1") {
          sends.push(body);
          result = {
            ...body,
            fingerprint: hash(
              JSON.stringify([
                "chert-text-once-v1",
                body.from,
                body.to,
                body.text,
              ]).replaceAll("/", "\\/"),
            ),
            state: "acknowledged",
            preparedGuid: "00000000-0000-4000-8000-000000000001",
          };
        } else throw new Error(`Unexpected fixture endpoint ${u.pathname}`);
        return new Response(JSON.stringify(result));
      },
    );
    try {
      const runtime = createRuntime({
        CLAWDTIME_MODE: "live",
        CLAWDTIME_LIVE_TRAFFIC: "true",
        CLAWDTIME_LIVE_CONFIG_JSON: JSON.stringify(config),
        CLAWDTIME_DATABASE: join(dir, "state.sqlite"),
        CLAWDTIME_ORIGIN: "https://clawdtime.example.test",
        CLAWDTIME_OPERATOR_TOKEN: "fixture-operator-secret-at-least-32",
        CLAWDTIME_MEDIA_TOKEN: "fixture-media-callback-secret-at-least-32",
      });
      try {
        await runtime.tick();
        expect(
          runtime.store.all<{ state: string }>("inbound").map((i) => i.state),
        ).toEqual(["done"]);
        const invites = runtime.store.all<{ binding: Record<string, unknown> }>(
          "invite",
        );
        expect(invites).toHaveLength(1);
        expect(invites[0]!.binding).not.toHaveProperty("authorization");
        expect(invites[0]!.binding).toMatchObject({
          memberId: "member",
          recipient: tester,
          deviceId: "mac",
          displayId: "1",
          lineId,
          conversationId: `iMessage;-;${tester}`,
        });
        const notices = runtime.store.all<{
          state: string;
          pairing: Record<string, unknown>;
        }>("notice");
        expect(notices).toHaveLength(1);
        expect(notices[0]!.state).toBe("done");
        expect(notices[0]!.pairing).not.toHaveProperty("authorization");
        expect(sends).toHaveLength(1);
        expect(sends[0]!.to).toBe(tester);
        expect(String(sends[0]!.text)).toContain("/pair#token=");
        await runtime.tick();
        expect(sends).toHaveLength(1);
        expect(runtime.store.all("invite")).toHaveLength(1);
      } finally {
        await runtime.stop();
        runtime.store.close();
      }
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
