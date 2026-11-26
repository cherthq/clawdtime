import assert from "node:assert/strict";
import { makeSharedDesk } from "./shared-desk.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
test("shared voice requires the exact caller and proof before remote actions, then keeps one call", async () => {
  const commands = [];
  const binding = {
    id: "call",
    lineId: "line",
    providerCallId: "provider",
    roomId: "room",
    participantId: "bridge",
  };
  const desk = await makeSharedDesk({
    origin: "https://coordinator.example",
    token: "t".repeat(32),
    roomId: "room",
    request: async (url, init) => {
      const input = JSON.parse(init.body);
      if (url.endsWith("/room/claim")) return Response.json({ ok: true });
      if (url.endsWith("/room")) return Response.json(binding);
      if (url.endsWith("/proof-turn")) {
        assert.equal(input.participantId, "bridge");
        assert.equal(input.code, "12345678");
        return Response.json({
          state: "admitted",
          call: { scope: { grantId: "grant" } },
        });
      }
      commands.push(input);
      return Response.json({
        ok: true,
        expiresAt: Date.now() + 30000,
        reply: { text: "Verified result." },
      });
    },
  });
  try {
    assert.equal(await desk.bindCaller("wrong"), false);
    assert.match(await desk.ask("Click", { requestId: "one" }), /unavailable/);
    assert.equal(await desk.bindCaller("bridge"), true);
    assert.match(await desk.ask("Click", { requestId: "two" }), /verification/);
    assert.equal(commands.length, 0);
    assert.match(
      await desk.ask("12345678", { requestId: "proof" }),
      /connected/,
    );
    await desk.ask("Click three times", { requestId: "three" });
    await desk.ask("Search for blue whales", { requestId: "four" });
    assert.deepEqual(
      commands.map((c) => c.operation.action),
      ["open", "chat", "chat"],
    );
    assert(commands.every((c) => c.callId === "call" && c.grantId === "grant"));
    assert.equal(commands[1].operation.text, "Click three times");
  } finally {
    await desk.close();
  }
});
test("callback waits for answer, opens the original result, and retains the latest task across lease renewal", async () => {
  const commands = [];
  let polls = 0;
  let consent;
  const binding = {
    id: "callback",
    lineId: "line",
    providerCallId: "provider",
    roomId: "room",
    participantId: "bridge",
    callbackTaskId: "original-task",
  };
  const desk = await makeSharedDesk({
    origin: "https://coordinator.example",
    token: "t".repeat(32),
    roomId: "room",
    request: async (url, init) => {
      const input = JSON.parse(init.body);
      if (url.endsWith("/room/claim")) return Response.json({ ok: true });
      if (url.endsWith("/room"))
        return Response.json({ ...binding, awaitingAnswer: ++polls < 2 });
      if (url.endsWith("/proof-turn"))
        return Response.json({
          state: "admitted",
          call: { scope: { grantId: "grant" } },
        });
      if (url.endsWith("/callback-request")) {
        consent = input;
        return Response.json({ ok: true });
      }
      commands.push(input);
      return Response.json({
        ok: true,
        expiresAt: Date.now() + 30000,
        taskId: "next-task",
        reply: { text: "Task started" },
        walkthrough: {
          text: "The original sample page is ready",
          opened: false,
        },
      });
    },
  });
  try {
    assert.equal(await desk.bindCaller("bridge"), true);
    assert.equal(polls, 2);
    assert.match(
      await desk.ask("12345678", { requestId: "proof" }),
      /original sample page/,
    );
    assert.deepEqual(
      commands.map((c) => c.operation.action),
      ["open", "walkthrough"],
    );
    await desk.ask("Create another sample page", { requestId: "next" });
    // Exercise the actual periodic lease renewal before requesting the callback.
    if (process.env.VITEST) {
      const { vi } = await import("vitest");
      // The native timer was installed before fake timers. Wait on its observable effect.
      await vi.waitFor(
        () => assert(commands.some((c) => c.operation.action === "renew")),
        { timeout: 6000, interval: 100 },
      );
    } else await new Promise((resolve) => setTimeout(resolve, 5100));
    assert.match(
      await desk.ask("Call me when it finishes", { requestId: "consent" }),
      /callback is requested/,
    );
    assert.equal(consent.taskId, "next-task");
    await desk.ask("Click three times", { requestId: "click" });
    assert(commands.every((c) => c.callId === "callback"));
  } finally {
    await desk.close();
  }
}, 10000);
