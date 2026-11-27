import { createHmac, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import { SharedProvider } from "../src/control/shared-provider.js";
import { UNVERIFIED_LIMIT_MS } from "../src/control/shared-number.js";
import { SharedMac } from "../connectors/shared/shared-mac.js";
import { sharedCallProof } from "../cli/shared.js";
import { makeSharedDesk } from "../line/shared-desk.mjs";
import { Store } from "../src/storage/store.js";
import type { SharedCommand } from "../src/shared-relay-contracts.js";

// Made-up numbers and hosts only. No real text, call, room or screen.
const memberA = "+14155550100";
const memberB = "+12125550100";
const stranger = "+13125550100";
const lineToken = "test-line-token-".repeat(4);
const webhookSecret = "w".repeat(32);
const publicOrigin = "https://coordinator.example";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("routes a signed incoming call to the caller's own paired Mac, gives other members no code, and releases a stranger after 90 s", async () => {
  let clock = Date.now();
  const now = () => clock;
  const lineId = randomUUID();
  const store = new Store();
  cleanup.push(() => store.close());
  const texts = new Map<string, string>();
  const service = createSharedNumberApp({
    store,
    lineId,
    proofKey: "aa".repeat(32),
    identityKey: "bb".repeat(32),
    lineToken,
    invited: [memberA, memberB],
    now,
    sendCode: async (recipient, code) => {
      texts.set(recipient, code);
      return true;
    },
  });
  const server = serve({
    fetch: service.app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const loopback = `http://127.0.0.1:${address.port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        service.close();
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  // The public HTTPS origin reaches this loopback server in the test only.
  const request = (url: string | URL | Request, init?: RequestInit) =>
    fetch(String(url).replace(publicOrigin, loopback), init);
  const post = async (path: string, data: unknown, token = "") => {
    const response = await request(`${publicOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  // The provider: signed webhooks in, room media and call state faked.
  const media = {
    prepare: vi.fn(async () => ({
      livekit_url: "wss://media.example",
      participant_token: "transient-token",
      remote_participant_identity: "shared-agent",
    })),
    activate: vi.fn(async () => {}),
    cleanup: vi.fn(async (_roomId: string) => true),
  };
  const ended = new Set<string>();
  const api = {
    ready: vi.fn(async () => true),
    observe: vi.fn(async (callId: string) =>
      ended.has(callId)
        ? { answered: true, terminal: true, cleanupComplete: true }
        : { answered: true, terminal: false, cleanupComplete: false },
    ),
    dial: vi.fn(async () => ({ providerCallId: randomUUID() })),
  };
  const provider = new SharedProvider({
    store,
    router: service.router,
    lineId,
    webhookSecret,
    media,
    api,
    event: service.providerEvent,
    now,
  });
  const incoming = async (from: string) => {
    const callId = randomUUID();
    const raw = JSON.stringify({
      event_id: randomUUID(),
      type: "call.incoming",
      created_at: new Date(clock).toISOString(),
      data: {
        call_id: callId,
        line_id: lineId,
        media: { audio: true, video: true },
        from,
      },
    });
    const answer = (await provider.webhook(
      raw,
      `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`,
    )) as { action: string };
    const roomId = store.get<{ roomId: string }>(
      "shared_provider_incoming",
      callId,
    )?.roomId;
    return { callId, roomId: roomId!, action: answer.action };
  };

  // Each member signs in and pairs one Mac with explicit local acceptance.
  const pair = async (recipient: string) => {
    const challenge = await post("/auth/start", { recipient });
    const auth = await post("/auth/verify", {
      challengeId: challenge.body.challengeId,
      code: texts.get(recipient),
    });
    const invitation = await post("/account/invite", {}, auth.body.token);
    const paired = await post("/pair/accept", {
      invitation: invitation.body.invitation,
      acceptance: {
        localAccepted: true,
        displayId: "display",
        allowView: true,
        allowControl: true,
      },
    });
    expect(paired.status).toBe(200);
    return {
      credential: paired.body.credential as string,
      deviceId: paired.body.pairing.deviceId as string,
    };
  };
  const a = await pair(memberA),
    b = await pair(memberB);

  // Each paired Mac keeps its own outbound device connection open.
  const seen: Record<string, SharedCommand[]> = { a: [], b: [] };
  let connected = 0;
  for (const [name, device] of [
    ["a", a],
    ["b", b],
  ] as const) {
    const controller = new AbortController(),
      local = new Store();
    const mac = new SharedMac({
      origin: loopback,
      allowLoopback: true,
      ...device,
      store: local,
      instanceId: `instance-${name}`,
      request: async (url, init) => {
        const result = await fetch(url, init);
        if (String(url).endsWith("/device/connect") && result.ok) connected++;
        return result;
      },
      execute: async (command) => {
        seen[name]!.push(command);
        return { ok: true, expiresAt: Date.now() + 30_000 };
      },
      closeCall: async () => {},
    });
    const running = mac.run(controller.signal).catch(() => {});
    cleanup.push(async () => {
      controller.abort();
      await running;
      local.close();
    });
  }
  await vi.waitFor(() => expect(connected).toBe(2));
  const prove = (device: { credential: string }) =>
    sharedCallProof(
      { origin: publicOrigin, credential: device.credential },
      undefined,
      request as typeof fetch,
    );

  // 1. Member A calls from A's verified number.
  const callA = await incoming(memberA);
  expect(callA.action).toBe("accept");
  const desk = await makeSharedDesk({
    origin: publicOrigin,
    token: lineToken,
    roomId: callA.roomId,
    request: request as (url: string, init: RequestInit) => Promise<Response>,
    now,
  });
  cleanup.push(() => desk.close());
  expect(await desk.bindCaller("shared-bridge")).toBe(true);
  expect(desk.greeting()).toMatch(/run clawdtime shared prove/);
  // Another member's Mac gets no code for A's call, and cannot block A.
  await expect(prove(b)).rejects.toThrow("shared_call_not_waiting");
  const code = (await prove(a)).code;
  expect(code).toMatch(/^\d{8}$/);
  // A says the code on the call. Only A's own Mac is opened.
  expect(await desk.ask(code, { requestId: "turn-proof" })).toMatch(
    /paired Mac is connected/,
  );
  const admitted = store
    .all<any>("shared_number_call")
    .find((call) => call.roomId === callA.roomId);
  expect(admitted.state).toBe("admitted");
  expect(admitted.scope.deviceId).toBe(a.deviceId);
  expect(seen.a!.map((c) => c.operation.action)).toContain("open");
  expect(seen.b).toHaveLength(0);
  await desk.close();
  ended.add(callA.callId);
  await provider.pump();
  expect(media.cleanup).toHaveBeenCalledWith(callA.roomId);

  // 2. A stranger calls. No member's Mac gets a code for it.
  const strangerCall = await incoming(stranger);
  expect(strangerCall.action).toBe("accept");
  await expect(prove(a)).rejects.toThrow("shared_call_not_waiting");
  await expect(prove(b)).rejects.toThrow("shared_call_not_waiting");
  await provider.pump();
  expect(media.cleanup).not.toHaveBeenCalledWith(strangerCall.roomId);
  expect(store.all<any>("shared_number_call")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ caller: stranger })]),
  );
  expect(JSON.stringify(store.all("shared_number_call"))).not.toContain(
    stranger,
  );

  // 3. After 90 s the stranger is released and the room removed. The slot
  // frees only after the provider reports the call ended and cleaned up.
  clock += UNVERIFIED_LIMIT_MS;
  await provider.pump();
  expect(media.cleanup).toHaveBeenCalledWith(strangerCall.roomId);
  expect((await incoming(memberA)).action).toBe("decline");
  ended.add(strangerCall.callId);
  clock += 1000;
  await provider.pump();
  expect(
    store.get<{ phase: string }>(
      "shared_provider_incoming",
      strangerCall.callId,
    )?.phase,
  ).toBe("ended");
  expect((await incoming(memberA)).action).toBe("accept");
}, 20_000);
