import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { createSharedNumberApp } from "../src/shared-number-app.js";
import { SharedProvider } from "../src/control/shared-provider.js";
import { SharedCallbacks } from "../src/control/shared-callbacks.js";
import { SharedMac } from "../connectors/shared/shared-mac.js";
import { SharedPhoneIdentity } from "../src/pairing/shared-phone-identity.js";
import { sharedVerificationText } from "../src/transport/shared-verification-text.js";
import { Store } from "../src/storage/store.js";
import type { SharedCommand } from "../src/shared-relay-contracts.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const lineToken = "test-line-token-".repeat(4);
async function fixture(timeout = 2000, callbacksEnabled = false) {
  const store = new Store();
  cleanup.push(() => store.close());
  const codes = new Map<string, string>();
  const service = createSharedNumberApp({
    store,
    lineId: "line",
    proofKey: "aa".repeat(32),
    identityKey: "bb".repeat(32),
    lineToken,
    relayTimeoutMs: timeout,
    callbacksEnabled,
    invited: ["+14155550100", "+12125550100"],
    sendCode: async (phone, code) => {
      codes.set(phone, code);
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
  const origin = `http://127.0.0.1:${address.port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        service.close();
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const post = async (path: string, data: unknown, token = "") => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const pair = async (recipient: string) => {
    const challenge = await post("/auth/start", { recipient });
    const auth = await post("/auth/verify", {
      challengeId: challenge.body.challengeId,
      code: codes.get(recipient),
    });
    expect(auth.status).toBe(200);
    const account = auth.body.token as string;
    const invitation = await post("/account/invite", {}, account);
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
      account,
      recipient,
      credential: paired.body.credential as string,
      deviceId: paired.body.pairing.deviceId as string,
    };
  };
  const event = (
    providerCallId: string,
    kind: "incoming" | "cleanup_complete" = "incoming",
    caller?: string,
  ) => ({
    kind,
    eventId: `${providerCallId}:${kind}`,
    lineId: "line",
    providerCallId,
    roomId: `room:${providerCallId}`,
    participantId: `participant:${providerCallId}`,
    expiresAt: Date.now() + 60_000,
    ...(caller ? { caller } : {}),
  });
  // The member calls from their verified number. Their paired Mac asks for
  // the call code with its own device credential.
  const admit = async (
    device: { credential: string; recipient: string },
    providerCallId: string,
  ) => {
    const { credential } = device;
    const incoming = await post(
      "/line/event",
      event(providerCallId, "incoming", device.recipient),
      lineToken,
    );
    expect(incoming.status).toBe(200);
    const proof = await post(
      "/device/call-proof",
      { callId: incoming.body.id },
      credential,
    );
    expect(proof.status).toBe(200);
    const {
      kind: _kind,
      eventId: _eventId,
      ...binding
    } = event(providerCallId);
    const admitted = await post(
      "/line/proof-turn",
      { ...binding, turnId: "proof-turn", code: proof.body.code },
      lineToken,
    );
    expect(admitted.body.state).toBe("admitted");
    return admitted.body.call;
  };
  return { store, service, origin, post, pair, event, admit };
}

describe("shared coordinator over real HTTP with simulated line and Mac execution", () => {
  it("queues callbacks only with exact consent and serializes the original owner's call after another member", async () => {
    const f = await fixture(2000, true);
    const a = await f.pair("+14155550100"),
      b = await f.pair("+12125550100");
    const ac = await f.post(
      "/device/connect",
      { instanceId: "instance-a" },
      a.credential,
    );
    await f.post("/device/connect", { instanceId: "instance-b" }, b.credential);
    const callA = await f.admit(a, "call-a");
    const roomClaim = { roomId: callA.roomId, workerId: "voice-one" };
    expect(
      (await f.post("/line/room/claim", roomClaim, lineToken)).status,
    ).toBe(200);
    expect(
      (
        await f.post(
          "/line/room/claim",
          { ...roomClaim, workerId: "replacement" },
          lineToken,
        )
      ).status,
    ).toBe(409);
    f.service.router.createTask(callA.id, callA.scope.grantId, {
      taskId: "task-a",
      userTurnId: "turn-a",
      requestDigest: "a".repeat(64),
    });
    f.service.router.completeTask(
      a.credential,
      ac.body.id,
      "task-a",
      "result-a",
    );
    await f.post(
      "/line/callback-request",
      { callId: callA.id, grantId: callA.scope.grantId, taskId: "task-a" },
      lineToken,
    );
    await f.post(
      "/line/event",
      f.event("call-a", "cleanup_complete"),
      lineToken,
    );
    const callB = await f.admit(b, "call-b");
    const dial = vi.fn(async () => ({ providerCallId: "outbound-a" }));
    const inspect = vi.fn(async () => ({
      terminal: false,
      cleanupComplete: false,
    }));
    const closeMedia = vi.fn(async () => true),
      restore = vi.fn(async () => true);
    const worker = new SharedCallbacks(f.service.router, f.store, {
      ready: async () => true,
      acquire: async () => {},
      verify: async () => true,
      prepare: async () => ({}),
      dial,
      inspect,
      closeMedia,
      restore,
    });
    await worker.pump();
    expect(dial).not.toHaveBeenCalled();
    await f.post(
      "/line/event",
      f.event("call-b", "cleanup_complete"),
      lineToken,
    );
    await Promise.all([worker.pump(), worker.pump()]);
    expect(dial).toHaveBeenCalledOnce();
    const callback = (dial.mock.calls as unknown as [any, unknown][])[0]![0];
    expect(callback.scope.recipient).toBe("+14155550100");
    expect(callback.scope.deviceId).toBe(a.deviceId);
    const binding = await f.post(
      "/line/room",
      { roomId: callback.roomId },
      lineToken,
    );
    expect(
      (
        await f.post(
          "/device/call-proof",
          { callId: binding.body.id },
          b.credential,
        )
      ).status,
    ).toBe(409);
    const proof = await f.post(
      "/device/call-proof",
      { callId: binding.body.id },
      a.credential,
    );
    expect(proof.status).toBe(200);
    inspect.mockResolvedValue({ terminal: true, cleanupComplete: false });
    await worker.pump();
    expect(closeMedia).not.toHaveBeenCalled();
    inspect.mockResolvedValue({ terminal: true, cleanupComplete: true });
    await worker.pump();
    expect(closeMedia).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    await worker.pump();
    expect(dial).toHaveBeenCalledOnce();
    expect(f.service.router.callback(callback.id).state).toBe("ended");
    expect(callB.scope.deviceId).toBe(b.deviceId);
  });
  it("binds an answered provider callback to the original result and rejects a replaced desktop", async () => {
    const f = await fixture(2000, true),
      a = await f.pair("+14155550100");
    const connection = await f.post(
      "/device/connect",
      { instanceId: "original-instance" },
      a.credential,
    );
    const call = await f.admit(a, "original-call");
    f.service.router.createTask(call.id, call.scope.grantId, {
      taskId: "original-task",
      userTurnId: "turn",
      requestDigest: "a".repeat(64),
    });
    f.service.router.requestCallback(
      call.id,
      call.scope.grantId,
      "original-task",
    );
    f.service.router.completeTask(
      a.credential,
      connection.body.id,
      "original-task",
      "original-result",
    );
    await f.post(
      "/line/event",
      f.event("original-call", "cleanup_complete"),
      lineToken,
    );
    const media = {
      prepare: vi.fn(async () => ({
        livekit_url: "wss://media.example",
        participant_token: "transient",
        remote_participant_identity: "shared-agent",
      })),
      activate: vi.fn(async () => {}),
      cleanup: vi.fn(async () => true),
    };
    const observe = vi.fn(async () => ({
      answered: false,
      terminal: false,
      cleanupComplete: false,
    }));
    const dial = vi.fn(async () => ({ providerCallId: "callback-call" }));
    const provider = new SharedProvider({
      store: f.store,
      router: f.service.router,
      lineId: "line",
      webhookSecret: "s".repeat(32),
      media,
      event: f.service.providerEvent,
      api: { ready: async () => true, observe, dial },
    });
    await provider.pump();
    expect(dial).toHaveBeenCalledOnce();
    const callback = f.store.all<any>("shared_number_callback")[0];
    const getRoom = () =>
      f.post("/line/room", { roomId: callback.roomId }, lineToken);
    expect((await getRoom()).body.awaitingAnswer).toBe(true);
    await provider.pump();
    expect(media.activate).not.toHaveBeenCalled();
    observe.mockResolvedValue({
      answered: true,
      terminal: false,
      cleanupComplete: false,
    });
    await provider.pump();
    expect((await getRoom()).body.awaitingAnswer).toBe(false);
    const room = (await getRoom()).body;
    const proof = await f.post(
      "/device/call-proof",
      { callId: room.id },
      a.credential,
    );
    await f.post(
      "/device/connect",
      { instanceId: "replacement-instance" },
      a.credential,
    );
    const admitted = await f.post(
      "/line/proof-turn",
      {
        lineId: "line",
        providerCallId: room.providerCallId,
        roomId: room.roomId,
        participantId: room.participantId,
        turnId: "proof",
        code: proof.body.code,
        expiresAt: Date.now() + 10000,
      },
      lineToken,
    );
    expect(admitted.body.state).toBe("unauthorized");
    expect(() =>
      f.service.router.walkthrough(room.id, "invented-grant"),
    ).toThrow();
    observe.mockResolvedValue({
      answered: true,
      terminal: true,
      cleanupComplete: true,
    });
    await provider.pump();
    expect(f.service.router.callback(callback.id).state).toBe("ended");
  });
  it("retains an uncertain callback dial across restart and never repeats it", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100");
    const ac = await f.post(
      "/device/connect",
      { instanceId: "instance-a" },
      a.credential,
    );
    const call = await f.admit(a, "call-a");
    f.service.router.createTask(call.id, call.scope.grantId, {
      taskId: "task",
      userTurnId: "turn",
      requestDigest: "a".repeat(64),
    });
    f.service.router.completeTask(a.credential, ac.body.id, "task", "result");
    await f.post(
      "/line/event",
      f.event("call-a", "cleanup_complete"),
      lineToken,
    );
    expect(f.service.router.claimCallback()).toBeNull(); // No callback consent.
    // Consent must originate while the exact original call is authorized.
    expect(() =>
      f.service.router.requestCallback(call.id, call.scope.grantId, "task"),
    ).toThrow();
    const next = await f.admit(a, "call-next");
    f.service.router.createTask(next.id, next.scope.grantId, {
      taskId: "task-next",
      userTurnId: "turn-next",
      requestDigest: "b".repeat(64),
    });
    f.service.router.requestCallback(next.id, next.scope.grantId, "task-next");
    f.service.router.completeTask(
      a.credential,
      ac.body.id,
      "task-next",
      "result-next",
    );
    await f.post(
      "/line/event",
      f.event("call-next", "cleanup_complete"),
      lineToken,
    );
    const dial = vi.fn(async () => {
      throw Error("lost response");
    });
    const ports = {
      ready: async () => true,
      acquire: async () => {},
      verify: async () => true,
      prepare: async () => ({}),
      dial,
      inspect: async () => ({ terminal: false, cleanupComplete: false }),
      closeMedia: async () => true,
      restore: async () => true,
    };
    await new SharedCallbacks(f.service.router, f.store, ports).pump();
    await new SharedCallbacks(f.service.router, f.store, ports).pump();
    expect(dial).toHaveBeenCalledOnce();
    expect(f.store.all<any>("shared_callback_attempt")[0].phase).toBe(
      "unknown",
    );
    expect(f.service.router.claimCallback()).toBeNull();
  });

  it("routes two paired Macs independently, accepts same-call turns, and preserves completion owners", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100"),
      b = await f.pair("+12125550100");
    const seen: Record<string, SharedCommand[]> = { a: [], b: [] };
    let connected = 0;
    for (const [name, device] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const controller = new AbortController(),
        localStore = new Store();
      const client = new SharedMac({
        origin: f.origin,
        ...device,
        store: localStore,
        instanceId: `instance-${name}`,
        allowLoopback: true,
        request: async (url, init) => {
          const result = await fetch(url, init);
          if (String(url).endsWith("/device/connect") && result.ok) connected++;
          return result;
        },
        execute: async (command) => {
          seen[name]!.push(command);
          return command.operation.action === "chat"
            ? { ok: true, reply: { text: `${name}:${command.operation.text}` } }
            : { ok: true, expiresAt: Date.now() + 30_000 };
        },
        closeCall: async () => {},
      });
      const running = client.run(controller.signal).catch(() => {});
      cleanup.push(async () => {
        controller.abort();
        await running;
        localStore.close();
      });
    }
    // Wait on observable device readiness, not arbitrary sleeps.
    await vi.waitFor(() => {
      expect(connected).toBe(2);
    });
    const callA = await f.admit(a, "call-a");
    const command = (call: any, requestId: string, text: string) =>
      f.post(
        "/line/command",
        {
          callId: call.id,
          grantId: call.scope.grantId,
          requestId,
          operation: { action: "chat", requestId, text },
        },
        lineToken,
      );
    expect(
      (await command(callA, "one", "Click three times")).body.reply.text,
    ).toBe("a:Click three times");
    expect(
      (await command(callA, "two", "Search for blue whales")).body.reply.text,
    ).toBe("a:Search for blue whales");
    expect(seen.b).toHaveLength(0);
    await f.post(
      "/line/event",
      f.event("call-a", "cleanup_complete"),
      lineToken,
    );
    const callB = await f.admit(b, "call-b");
    expect(
      (await command(callB, "three", "Open a sample note")).body.reply.text,
    ).toBe("b:Open a sample note");
    const task = seen.a![0]!;
    const wrong = await f.post(
      "/device/completion",
      {
        connectionId: seen.b![0]!.connectionId,
        taskId: task.id,
        resultId: "result-a",
      },
      b.credential,
    );
    expect(wrong.status).toBe(403);
    expect(
      (
        await f.post(
          "/device/completion",
          {
            connectionId: task.connectionId,
            taskId: task.id,
            resultId: "result-a",
          },
          a.credential,
        )
      ).body.state,
    ).toBe("queued");
    const callbacks = f.store.all<any>("shared_number_callback");
    expect(callbacks[0].scope.deviceId).toBe(a.deviceId);
    expect(callbacks[0].scope.recipient).toBe("+14155550100");
    expect(JSON.stringify(f.store.all("shared_relay"))).not.toContain(
      "blue whales",
    );
  });

  it("gives a call code only to the paired Mac, never to a sign-in session", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100");
    const incoming = await f.post(
      "/line/event",
      f.event("call-a", "incoming", a.recipient),
      lineToken,
    );
    for (const path of ["/account/proof", "/account/pending-call"])
      expect(
        (await f.post(path, { callId: incoming.body.id }, a.account)).status,
      ).toBe(404);
    // A paired Mac that is not connected is not shown a code.
    expect((await f.post("/device/call-proof", {}, a.credential)).status).toBe(
      409,
    );
    await f.post("/device/connect", { instanceId: "instance-a" }, a.credential);
    const proof = await f.post("/device/call-proof", {}, a.credential);
    expect(proof.status).toBe(200);
    expect(proof.body.code).toMatch(/^\d{8}$/);
  });

  it("never lets one member take or block another member's waiting call", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100"),
      b = await f.pair("+12125550100");
    await f.post("/device/connect", { instanceId: "instance-a" }, a.credential);
    await f.post("/device/connect", { instanceId: "instance-b" }, b.credential);
    const incoming = await f.post(
      "/line/event",
      f.event("call-a", "incoming", a.recipient),
      lineToken,
    );
    const taken = await f.post(
      "/device/call-proof",
      { callId: incoming.body.id },
      b.credential,
    );
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("shared_call_not_waiting");
    const own = await f.post("/device/call-proof", {}, a.credential);
    expect(own.status).toBe(200);
  });

  it("tells the voice worker when an unverified call must end and lets it release one", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100");
    await f.post("/device/connect", { instanceId: "instance-a" }, a.credential);
    const incoming = await f.post(
      "/line/event",
      f.event("call-a", "incoming", a.recipient),
      lineToken,
    );
    const room = await f.post(
      "/line/room",
      { roomId: incoming.body.roomId },
      lineToken,
    );
    expect(room.body.verifyInMs).toBeGreaterThan(0);
    expect(room.body.verifyInMs).toBeLessThanOrEqual(120_000);
    const released = await f.post(
      "/line/release",
      { roomId: incoming.body.roomId },
      lineToken,
    );
    expect(released.body).toEqual({ ok: true, released: true });
    expect((await f.post("/device/call-proof", {}, a.credential)).status).toBe(
      409,
    );
    expect(
      (await f.post("/line/room", { roomId: incoming.body.roomId }, lineToken))
        .status,
    ).toBe(409);
    expect(
      (await f.post("/line/release", { roomId: "other" }, a.credential)).status,
    ).toBe(403);
  });

  it("rotates a device credential and re-pairs a Mac through authenticated routes", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100");
    const rotated = await f.post("/device/rotate", {}, a.credential);
    expect(rotated.status).toBe(200);
    const fresh = rotated.body.credential as string;
    expect(fresh).not.toBe(a.credential);
    expect(
      (await f.post("/device/connect", { instanceId: "mac" }, a.credential))
        .status,
    ).toBe(403);
    expect(
      (await f.post("/device/connect", { instanceId: "mac" }, fresh)).status,
    ).toBe(200);
    expect((await f.post("/device/rotate", {}, "forged.secret")).status).toBe(
      403,
    );
    // A replacement Mac needs the signed-in account and an explicit replace.
    expect((await f.post("/account/invite", {}, a.account)).status).toBe(409);
    const invitation = await f.post(
      "/account/invite",
      { replace: true },
      a.account,
    );
    expect(invitation.status).toBe(200);
    const paired = await f.post("/pair/accept", {
      invitation: invitation.body.invitation,
      acceptance: {
        localAccepted: true,
        displayId: "display",
        allowView: true,
        allowControl: false,
      },
    });
    expect(paired.status).toBe(200);
    expect(
      (await f.post("/device/connect", { instanceId: "mac" }, fresh)).status,
    ).toBe(403);
    // Revoking the pairing leaves the number free to pair again.
    expect((await f.post("/account/revoke", {}, a.account)).status).toBe(200);
    expect((await f.post("/account/invite", {}, a.account)).status).toBe(200);
  });

  it("checks the device credential before reading a device body and keeps device bodies small", async () => {
    const f = await fixture();
    const a = await f.pair("+14155550100");
    const raw = async (path: string, body: string, token: string) =>
      (
        await fetch(`${f.origin}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body,
        })
      ).status;
    // A body from a missing or forged credential is refused, never parsed.
    for (const path of ["/device/connect", "/device/poll", "/device/result"])
      expect(await raw(path, "{not json", "forged.credential")).toBe(403);
    expect(await raw("/device/result", "x".repeat(1_000_000), "")).toBe(403);
    const connection = await f.post(
      "/device/connect",
      { instanceId: "instance-a" },
      a.credential,
    );
    const padding = "x".repeat(64_000);
    expect(
      await raw(
        "/device/heartbeat",
        JSON.stringify({ connectionId: connection.body.id, padding }),
        a.credential,
      ),
    ).toBe(413);
    // Only a screen frame result may be large. It still meets its schema.
    expect(
      await raw(
        "/device/result",
        JSON.stringify({
          connectionId: connection.body.id,
          id: "missing",
          result: { ok: true, padding },
        }),
        a.credential,
      ),
    ).toBe(400);
  });

  it("rejects forged roles and cross-device replies, and never repeats an uncertain command", async () => {
    const f = await fixture(80);
    const a = await f.pair("+14155550100"),
      b = await f.pair("+12125550100");
    expect(
      (await f.post("/line/event", f.event("forged"), a.credential)).status,
    ).toBe(403);
    const ac = await f.post(
      "/device/connect",
      { instanceId: "instance-a" },
      a.credential,
    );
    const bc = await f.post(
      "/device/connect",
      { instanceId: "instance-b" },
      b.credential,
    );
    const call = await f.admit(a, "call-a");
    const payload = {
      callId: call.id,
      grantId: call.scope.grantId,
      requestId: "effect",
      operation: {
        action: "chat",
        requestId: "effect",
        text: "Open a sample note",
      },
    };
    const result = f.post("/line/command", payload, lineToken);
    const command = await f.post(
      "/device/poll",
      { connectionId: ac.body.id },
      a.credential,
    );
    expect(command.body.command.operation.text).toBe("Open a sample note");
    const wrong = await f.post(
      "/device/result",
      {
        connectionId: bc.body.id,
        id: command.body.command.id,
        result: { ok: true, reply: { text: "wrong" } },
      },
      b.credential,
    );
    expect(wrong.status).toBe(409);
    expect((await result).body.code).toBe("outcome_unknown");
    expect((await f.post("/line/command", payload, lineToken)).body.code).toBe(
      "outcome_unknown",
    );
    expect(f.store.all<any>("shared_relay")).toHaveLength(1);
    expect(
      (
        await f.post(
          "/device/heartbeat",
          { connectionId: ac.body.id },
          b.credential,
        )
      ).status,
    ).toBe(403);
    await f.post(
      "/device/connect",
      { instanceId: "replacement" },
      a.credential,
    );
    expect(
      (
        await f.post(
          "/line/command",
          { ...payload, requestId: "new" },
          lineToken,
        )
      ).status,
    ).toBe(403);
  });
});

describe("phone possession verification", () => {
  it("commits failed attempts, limits sends, and never reuses a consumed code", async () => {
    const store = new Store();
    cleanup.push(() => store.close());
    const sent: string[] = [];
    const identity = new SharedPhoneIdentity(store, {
      lineId: "line",
      key: "bb".repeat(32),
      invited: ["+14155550100"],
      send: async (_phone, code) => {
        sent.push(code);
        return true;
      },
    });
    const first = await identity.start("+14155550100");
    for (let i = 0; i < 5; i++)
      expect(() => identity.verify(first.challengeId, "wrong")).toThrow();
    expect(() => identity.verify(first.challengeId, sent[0]!)).toThrow();
    const next = await identity.start("+14155550100");
    const session = identity.verify(next.challengeId, sent[1]!);
    expect((await identity.alias(session.token)).recipient).toBe(
      "+14155550100",
    );
    expect(() => identity.verify(next.challengeId, sent[1]!)).toThrow();
    await identity.start("+14155550100");
    await expect(identity.start("+14155550100")).rejects.toThrow(
      "rate_limited",
    );
    expect(JSON.stringify(store.all("shared_identity_session"))).not.toContain(
      session.token,
    );
  });
  it("sends a code to the exact requested recipient with one stable delivery attempt", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 200 }));
    const send = sharedVerificationText({
      origin: "https://calls.example",
      projectId: "project",
      key: "key",
      lineId: "line",
      request,
    });
    expect(await send("+14155550100", "12345678", "attempt-one")).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://calls.example/api/v1/shared-messages");
    expect(JSON.parse(options.body as string).recipient).toBe("+14155550100");
    expect(options.redirect).toBe("error");
  });
});
