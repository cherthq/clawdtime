import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../src/runtime.js";
import { Store } from "../src/storage/store.js";
import { hash, Vault } from "../src/storage/security.js";
import { SetupService } from "../src/pairing/setup.js";
import { mediaSessionId } from "../src/transport/native.js";
import type { AttentionRequest, CallSession } from "../src/contracts.js";
afterEach(() => vi.unstubAllGlobals());
describe("runtime standby and mode boundaries", () => {
  it("accepts only exact configured compatible origins without broadening network schemes", async () => {
    const runtime = createRuntime({
      CLAWDTIME_DATABASE: ":memory:",
      CLAWDTIME_ORIGIN: "https://clawdtime.example.test",
      CLAWDTIME_COMPATIBLE_ORIGINS:
        "https://legacy.example.test, http://127.0.0.1:3310",
    });
    try {
      expect(
        (
          await runtime.app.request("https://clawdtime.example.test/health", {
            headers: { Origin: "https://legacy.example.test" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await runtime.app.request("https://clawdtime.example.test/health", {
            headers: { Origin: "https://unrelated.example.test" },
          })
        ).status,
      ).toBe(403);
    } finally {
      await runtime.stop();
      runtime.store.close();
    }
    for (const invalid of [
      "https://legacy.example.test/",
      "https://user:pass@legacy.example.test",
      "https://legacy.example.test/path",
      "https://legacy.example.test#fragment",
      "http://external.example.test",
      "ftp://127.0.0.1:3310",
      "https://legacy.example.test,",
    ])
      expect(() =>
        createRuntime({
          CLAWDTIME_DATABASE: ":memory:",
          CLAWDTIME_COMPATIBLE_ORIGINS: invalid,
        }),
      ).toThrow("exact HTTPS origins");
  });
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
  it.each(["acknowledged", "provider_503"] as const)(
    "strips tester audit metadata and preserves once-only notice outcome: %s",
    async (outcome) => {
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
            parts: [{ type: "text", text: "Hey agent" }],
          },
        },
      };
      const feed = [inbound];
      let catchupGate: Promise<void> | undefined;
      let activePolls = 0,
        maxPolls = 0;
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
          else if (/^\/api\/v1\/events\/[2-9]$/.test(u.pathname))
            result = feed.find(
              (e) => e.sequence === Number(u.pathname.split("/").at(-1)),
            );
          else if (u.pathname === "/api/v1/events/catchup") {
            activePolls++;
            maxPolls = Math.max(maxPolls, activePolls);
            if (catchupGate) await catchupGate;
            activePolls--;
            result = {
              events: feed.filter(
                (e) =>
                  e.sequence > Number(u.searchParams.get("since_sequence")),
              ),
              head_sequence: feed.at(-1)!.sequence,
              has_more: false,
            };
          } else if (u.pathname === "/api/v1/lines")
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
              devicesConfigured: true,
              deviceGatewayConnected: true,
            };
          else if (u.pathname === "/devices/mac/readiness/member/1")
            result = {
              deviceId: "mac",
              memberId: "member",
              displayId: "1",
              available: true,
              displayAttached: true,
              screenPermission: true,
              viewAllowed: true,
              armed: true,
              controlPermission: true,
              controlAllowed: true,
              activeLease: false,
            };
          else if (u.pathname === "/api/v1/text-operations/v1") {
            sends.push(body);
            if (outcome === "provider_503")
              return new Response(
                JSON.stringify({
                  error: "private provider diagnostic must never enter state",
                }),
                { status: 503 },
              );
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
          const invites = runtime.store.all<{
            binding: Record<string, unknown>;
          }>("invite");
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
            dispatch?: { operationOrigin: string };
            receipt?: {
              receiptId: string;
              status: string;
              operationOrigin: string;
              acknowledgedAt: number;
            };
            failure?: { phase: string; code: string; httpStatus?: number };
          }>("notice");
          expect(notices).toHaveLength(1);
          expect(notices[0]!.state).toBe(
            outcome === "acknowledged" ? "done" : "unknown",
          );
          if (outcome === "acknowledged") {
            expect(notices[0]!.receipt).toMatchObject({
              receiptId: "00000000-0000-4000-8000-000000000001",
              status: "acknowledged",
              operationOrigin: sends[0]!.origin,
            });
            expect(notices[0]!.receipt!.acknowledgedAt).toBeGreaterThan(0);
          } else {
            expect(notices[0]!.receipt).toBeUndefined();
            expect(notices[0]!.failure).toMatchObject({
              phase: "transport_dispatch",
              code: "transport_outcome_unknown",
              httpStatus: 503,
            });
            expect(JSON.stringify(notices[0]!.failure)).not.toContain(
              "private provider diagnostic",
            );
          }
          expect(notices[0]!.dispatch?.operationOrigin).toBe(sends[0]!.origin);
          expect(notices[0]!.pairing).not.toHaveProperty("authorization");
          expect(sends).toHaveLength(1);
          expect(sends[0]!.to).toBe(tester);
          expect(String(sends[0]!.text)).toContain("Hey! I'm ClawdTime.");
          expect(String(sends[0]!.text)).toContain("chat you're already using");
          expect(String(sends[0]!.text)).toMatch(
            /Set up ClawdTime for this project\. Follow https:\/\/clawdtime\.example\.test\/agents using my setup link: https:\/\/clawdtime\.example\.test\/setup#token=/,
          );
          expect(String(sends[0]!.text)).not.toMatch(
            /liked|tapback|call (?:placed|started)/i,
          );
          // Provider replay at a later sequence keeps the exact same native event identity.
          feed.push({ ...inbound, sequence: 3 });
          await runtime.tick();
          expect(sends).toHaveLength(1);
          expect(runtime.store.all("invite")).toHaveLength(1);
          if (outcome === "acknowledged") {
            const setupUrl = new URL(
              String(sends[0]!.text).match(
                /https:\/\/clawdtime\.example\.test\/setup#\S+/,
              )![0],
            );
            const params = new URLSearchParams(setupUrl.hash.slice(1));
            const paired = runtime.service.claimPairing({
              token: params.get("token")!,
              deviceId: "mac",
              displayId: "1",
              allowView: true,
              allowControl: true,
            });
            const noPending = {
              id: "fixture-paired-no-pending",
              lineId,
              sender: tester,
              conversationId: `iMessage;-;${tester}`,
              text: "Can you call me now?",
            };
            runtime.store.put("inbound", {
              id: noPending.id,
              sealed: new Vault(config.encryptionKey).seal(noPending),
              state: "pending",
            });
            await runtime.tick();
            expect(sends).toHaveLength(2);
            expect(String(sends[1]!.text)).not.toContain("/setup#token=");
            expect(runtime.store.all("invite")).toHaveLength(1);
            expect(runtime.store.all("pairing")).toHaveLength(1);
            expect(runtime.store.all("attention")).toHaveLength(0);
            expect(runtime.store.all("call")).toHaveLength(0);
            expect(runtime.store.effects()).toHaveLength(0);
            await runtime.tick();
            expect(sends).toHaveLength(2);
            const agent = runtime.service.registerSession(paired.token, {
              adapter: "codex",
              adapterVersion: "fixture",
              projectRoot: "/fixture",
              externalSessionId: "setup-session",
              hostId: "mac",
              capabilities: { cooperativePause: true, polling: true },
            });
            const setup = new SetupService(runtime.service);
            if ("preflightDevice" in runtime.transport)
              await runtime.transport.preflightDevice(paired.pairing);
            const test = setup.invite(agent.token).test;
            // Persisted legacy SMS approval records remain supported.
            runtime.store.put("setup_test", {
              ...test,
              approvalMode: undefined,
              approvalCode: "ABCDEF12",
            });
            await runtime.tick();
            expect(runtime.store.effect(test.invitationEffectId)?.state).toBe(
              "done",
            );
            expect(sends).toHaveLength(3);
            const approval = {
              id: "fixture-verified-yes",
              lineId,
              sender: tester,
              conversationId: `iMessage;-;${tester}`,
              text: "YES ABCDEF12",
            };
            runtime.store.put("inbound", {
              id: approval.id,
              sealed: new Vault(config.encryptionKey).seal(approval),
              state: "pending",
            });
            await runtime.tick();
            expect(setup.get(agent.token).test?.state).toBe("approved");
            expect(
              runtime.store.get<{ state: string }>("inbound", approval.id)
                ?.state,
            ).toBe("done");
            expect(runtime.store.all("attention")).toHaveLength(0);
            expect(runtime.store.all("notice")).toHaveLength(2);
            expect(sends).toHaveLength(3); // Approval is consumed before generic response handling.
            // A typed planner preflight refusal has sent no input. It should be
            // acknowledged to the human, not stranded as an unknown inbound.
            runtime.service.yieldSession(agent.token);
            const requestId = "fixture-connected-control-request",
              callId = "fixture-connected-call",
              now = Date.now();
            runtime.store.put<AttentionRequest>("attention", {
              id: requestId,
              sessionId: agent.session.id,
              pairingId: paired.pairing.id,
              taskId: "control-fixture",
              idempotencyKey: "control-fixture",
              reason: "decision",
              question: "fixture",
              createdAt: now,
              deadline: now + 300_000,
              state: "connected",
              callId,
            });
            runtime.store.put<CallSession>("call", {
              id: callId,
              requestId,
              pairingId: paired.pairing.id,
              state: "connected",
              remoteParticipantQualified: true,
              createdAt: now,
            });
            runtime.store.saveState(`view-started:${requestId}`, true);
            const command = {
              ...approval,
              id: "fixture-plan-refusal",
              text: "Focus the intended textbox.",
            };
            runtime.store.put("inbound", {
              id: command.id,
              sealed: new Vault(config.encryptionKey).seal(command),
              state: "pending",
            });
            await runtime.tick();
            expect(
              runtime.store.get<{ state: string }>("inbound", command.id)
                ?.state,
            ).toBe("done");
            expect(
              runtime.store.state<{ result: { state: string; code: string } }>(
                `human-command:${command.id}`,
              )?.result,
            ).toMatchObject({
              state: "not_started",
              code: "planner_unavailable",
            });
            expect(
              runtime.store.get<{ state: string }>(
                "notice",
                `${command.id}:notice`,
              )?.state,
            ).toBe("done");
            expect(sends).toHaveLength(4);
            expect(sends[3]?.text).toContain("conversation service failed");
            expect(sends[3]?.text).not.toContain("couldn't safely act");
            expect(sends[3]?.text).not.toContain("do:");
            expect(runtime.store.all("action")).toHaveLength(0);
            await runtime.tick();
            expect(sends).toHaveLength(4);

            // A model turn must not block the native inbox from delivering Stop.
            let began!: () => void, finish!: () => void;
            const modelBegan = new Promise<void>(
              (resolve) => (began = resolve),
            );
            const modelFinish = new Promise<void>(
              (resolve) => (finish = resolve),
            );
            let modelRuns = 0;
            Object.defineProperty(runtime.human, "conversation", {
              value: {
                observe: async () => {
                  throw new Error(
                    "No screen input should be attempted after Stop",
                  );
                },
                run: async (
                  turn: import("../src/control/conversation.js").ConversationTurn,
                ) => {
                  modelRuns++;
                  began();
                  await modelFinish;
                  await turn.tools.act("unseen", {
                    kind: "click",
                    x: 0.5,
                    y: 0.5,
                  });
                  return { reply: "Untrusted late success" };
                },
              },
            });
            const waiting = {
              ...command,
              id: "fixture-waiting-model",
              text: "Click the title field.",
            };
            runtime.store.put("inbound", {
              id: waiting.id,
              sealed: new Vault(config.encryptionKey).seal(waiting),
              state: "pending",
            });
            const processing = runtime.tick();
            await modelBegan;
            feed.push({
              ...inbound,
              sequence: 4,
              event_id: "recv:fixture-priority-stop",
              payload: {
                ...inbound.payload,
                message: {
                  ...inbound.payload.message,
                  guid: "fixture-priority-stop",
                  parts: [{ type: "text", text: "Stop" }],
                },
              },
            });
            feed.push({
              ...inbound,
              sequence: 5,
              event_id: "recv:fixture-ordinary-queued",
              payload: {
                ...inbound.payload,
                message: {
                  ...inbound.payload.message,
                  guid: "fixture-ordinary-queued",
                  parts: [{ type: "text", text: "Type later" }],
                },
              },
            });
            try {
              await vi.waitFor(
                () =>
                  expect(runtime.store.state(`view-stopped:${requestId}`)).toBe(
                    true,
                  ),
                { timeout: 2500 },
              );
            } catch (error) {
              finish();
              await processing;
              throw error;
            }
            const decoded = runtime.store
              .all<{ id: string; sealed: string; state: string }>("inbound")
              .map((i) => ({
                ...i,
                message: new Vault(config.encryptionKey).open<{ text: string }>(
                  i.sealed,
                ),
              }));
            const stopId = decoded.find((i) => i.message.text === "Stop")!.id;
            const ordinaryId = decoded.find(
              (i) => i.message.text === "Type later",
            )!.id;
            const stopState = runtime.store.get<{ state: string }>(
              "inbound",
              stopId,
            )?.state;
            const ordinaryState = runtime.store.get<{ state: string }>(
              "inbound",
              ordinaryId,
            )?.state;
            const queuedStopState = runtime.store.get<{ state: string }>(
              "notice",
              `${stopId}:notice`,
            )?.state;
            finish();
            await processing;
            expect(stopState).toBe("done");
            expect(ordinaryState).toBe("pending");
            expect(queuedStopState).toBe("pending");
            expect(modelRuns).toBe(1);
            expect(runtime.store.all("action")).toHaveLength(0);
            expect(
              runtime.store.state<any>(`human-command:${waiting.id}`).result
                .accepted,
            ).toBe(false);
            expect(
              runtime.store.get<{ state: string }>("notice", `${stopId}:notice`)
                ?.state,
            ).toBe("done");

            // A voice-triggered maintenance pass and normal tick share one inbox read.
            let releasePoll!: () => void;
            catchupGate = new Promise<void>(
              (resolve) => (releasePoll = resolve),
            );
            const maintenance = runtime.human.maintainViewing!();
            await vi.waitFor(() => expect(activePolls).toBe(1));
            const normal = runtime.tick();
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(activePolls).toBe(1);
            expect(maxPolls).toBe(1);
            releasePoll();
            catchupGate = undefined;
            await Promise.all([maintenance, normal]);
            expect(modelRuns).toBe(1);
          }
        } finally {
          await runtime.stop();
          runtime.store.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it("preserves interrupted notice intent as unknown without redispatch after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-notice-recovery-"));
    try {
      const db = join(dir, "state.sqlite"),
        store = new Store(db),
        dispatch = {
          startedAt: Date.now() - 1000,
          operationOrigin: "text_original_fixture_origin",
        };
      store.put("notice", {
        id: "fixture-notice",
        state: "running",
        sealed: "unchanged-encrypted-payload",
        pairing: { id: "fixture-pair" },
        dispatch,
      });
      store.close();
      const request = vi.fn();
      vi.stubGlobal("fetch", request);
      const runtime = createRuntime({
        CLAWDTIME_MODE: "simulation",
        CLAWDTIME_DATABASE: db,
      });
      try {
        await runtime.tick();
        const notice = runtime.store.get<{
          state: string;
          sealed: string;
          dispatch: unknown;
          failure: { phase: string; code: string };
        }>("notice", "fixture-notice")!;
        expect(notice.state).toBe("unknown");
        expect(notice.sealed).toBe("unchanged-encrypted-payload");
        expect(notice.dispatch).toEqual(dispatch);
        expect(notice.failure).toMatchObject({
          phase: "process_interrupted",
          code: "process_interrupted",
        });
        expect(request).not.toHaveBeenCalled();
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
