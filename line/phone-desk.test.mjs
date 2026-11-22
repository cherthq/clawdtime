import assert from "node:assert/strict";
import { makePhoneDesk } from "./phone-desk.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const output = (value, ok = true) => ({ ok, stdout: JSON.stringify(value) });
function fixture(respond = () => output({ ok: true, expiresAt: 31000 })) {
  let now = 1000;
  const commands = [],
    codes = [],
    timers = new Set();
  const desk = makePhoneDesk({
    enabled: true,
    callId: "fixture-call",
    now: () => now,
    execute: async (args) => {
      commands.push(args);
      return respond(args);
    },
    fallback: () => {
      throw Error("Configured mode must never fall back.");
    },
    setTimer: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimer: (fn) => timers.delete(fn),
    diagnostic: (code) => codes.push(code),
  });
  return {
    desk,
    commands,
    codes,
    timers,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("only an unconfigured desktop uses standalone conversation", async () => {
  const received = [];
  const desk = makePhoneDesk({
    enabled: false,
    execute: () => {
      throw Error("No CLI calls expected.");
    },
    fallback: async (text) => {
      received.push(text);
      return "status";
    },
  });
  assert.equal(await desk.open(), true);
  assert.equal(await desk.ask("Give me the status."), "status");
  await desk.close();
  assert.deepEqual(received, ["Give me the status."]);
});

test("open, renew, original request and close use one exact call identity", async () => {
  const f = fixture((args) =>
    args[1] === "chat"
      ? output({
          ok: true,
          reply: { text: "Launch requested, not yet observed." },
        })
      : output({ ok: true, expiresAt: 31000 }),
  );
  assert.equal(await f.desk.open(), true);
  await f.desk.renew();
  const context = {
    requestId: "request-one",
    presentation: { kind: "sharing", action: "show", applied: true },
  };
  const text = "Show Messages and read the visible message. Do not send.";
  assert.equal(
    await f.desk.ask(text, context),
    "Launch requested, not yet observed.",
  );
  assert.deepEqual(f.commands[2], [
    "phone",
    "chat",
    "fixture-call",
    "request-one",
    JSON.stringify({ text, presentation: context.presentation }),
  ]);
  await f.desk.close();
  await f.desk.close();
  assert.deepEqual(
    f.commands.map((args) => args[1]),
    ["open", "renew", "chat", "close"],
  );
  assert.ok(f.commands.every((args) => args[2] === "fixture-call"));
  assert.equal(f.timers.size, 0);
});

test("configured missing or malformed desktop refuses without standalone fallback", async () => {
  for (const result of [
    output({ ok: false, code: "unavailable" }),
    { ok: false, stdout: "" },
    output({ ok: true }),
    output({ ok: true, expiresAt: 31000 }, false),
  ]) {
    const f = fixture(() => result);
    assert.equal(await f.desk.open(), false);
    assert.match(await f.desk.ask("Open Messages."), /unavailable/);
    await f.desk.close();
    assert.deepEqual(
      f.commands.map((args) => args[1]),
      ["open", "close"],
    );
  }
});

test("duplicate requests reuse unknown delivery and conflicting text never dispatches", async () => {
  const f = fixture((args) =>
    args[1] === "chat"
      ? { ok: false, stdout: "invalid response" }
      : output({ ok: true, expiresAt: 31000 }),
  );
  await f.desk.open();
  const first = await f.desk.ask("Start Claude.", { requestId: "same" });
  assert.match(first, /outcome is unknown/);
  assert.equal(await f.desk.ask("Start Claude.", { requestId: "same" }), first);
  assert.match(
    await f.desk.ask("Open Messages.", { requestId: "same" }),
    /unavailable/,
  );
  assert.equal(f.commands.filter((args) => args[1] === "chat").length, 1);
  await f.desk.close();
});

test("lost renewal retires admission and sends exactly one scoped close", async () => {
  const f = fixture((args) =>
    args[1] === "renew"
      ? output({ ok: false, code: "outcome_unknown" })
      : output({ ok: true, expiresAt: 31000 }),
  );
  await f.desk.open();
  await f.desk.renew();
  assert.match(await f.desk.ask("Open Messages."), /unavailable/);
  await f.desk.close();
  await f.desk.renew();
  assert.deepEqual(
    f.commands.map((args) => args[1]),
    ["open", "renew", "close"],
  );
  assert.ok(f.codes.includes("phone_renewal_failed"));
});

test("expired admission cannot dispatch even before the heartbeat runs", async () => {
  const f = fixture();
  await f.desk.open();
  f.advance(31000);
  assert.match(await f.desk.ask("Open Messages."), /unavailable/);
  await f.desk.renew();
  assert.deepEqual(
    f.commands.map((args) => args[1]),
    ["open", "close"],
  );
});

test("hangup during admission closes a late open and never starts a request", async () => {
  const pending = Promise.withResolvers();
  const f = fixture((args) =>
    args[1] === "open" ? pending.promise : output({ ok: true }),
  );
  const opening = f.desk.open();
  const closing = f.desk.close();
  assert.match(await f.desk.ask("Open Messages."), /unavailable/);
  pending.resolve(output({ ok: true, expiresAt: 31000 }));
  assert.equal(await opening, false);
  await closing;
  assert.deepEqual(
    f.commands.map((args) => args[1]),
    ["open", "close"],
  );
  assert.equal(f.timers.size, 0);
});

test("hangup closes owned work without resending a pending chat", async () => {
  const pending = Promise.withResolvers();
  const f = fixture((args) =>
    args[1] === "chat"
      ? pending.promise
      : output({ ok: true, expiresAt: 31000 }),
  );
  await f.desk.open();
  const chatting = f.desk.ask("Read Messages.", { requestId: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  await f.desk.close();
  assert.deepEqual(
    f.commands.map((args) => args[1]),
    ["open", "chat", "close"],
  );
  pending.resolve(output({ ok: false, code: "outcome_unknown" }));
  assert.match(await chatting, /outcome is unknown/);
  assert.match(
    await f.desk.ask("Read Messages.", { requestId: "one" }),
    /outcome is unknown/,
  );
});

test("server uncertainty and invalid success retire the admission without replay", async () => {
  for (const response of [
    output({ ok: false, code: "phone_request_uncertain" }),
    output({ ok: true, reply: { text: "Succeeded" } }, false),
    output({ ok: true }),
  ]) {
    const f = fixture((args) =>
      args[1] === "chat" ? response : output({ ok: true, expiresAt: 31000 }),
    );
    await f.desk.open();
    const result = await f.desk.ask("Open Messages.", { requestId: "one" });
    assert.match(result, /outcome is unknown/);
    assert.equal(
      await f.desk.ask("Open Messages.", { requestId: "one" }),
      result,
    );
    assert.match(
      await f.desk.ask("Open another app.", { requestId: "two" }),
      /unavailable/,
    );
    await f.desk.close();
    assert.deepEqual(
      f.commands.map((args) => args[1]),
      ["open", "chat", "close"],
    );
  }
});

test("Stop bypasses pending chat and affects only this call", async () => {
  const pending = Promise.withResolvers();
  const f = fixture((args) =>
    args[1] === "chat"
      ? pending.promise
      : args[1] === "stop"
        ? output({
            ok: true,
            reply: { text: "Stop requested for this call's computer work." },
          })
        : output({ ok: true, expiresAt: 31000 }),
  );
  await f.desk.open();
  const chat = f.desk.ask("Read Messages.", { requestId: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(await f.desk.stop(), /Stop requested/);
  assert.deepEqual(
    f.commands.map((args) => args[1]),
    ["open", "chat", "stop"],
  );
  assert.deepEqual(f.commands[2], ["phone", "stop", "fixture-call"]);
  pending.resolve(output({ ok: false, code: "phone_request_cancelled" }));
  assert.match(await chat, /already submitted may have taken effect/);
  assert.equal(f.timers.size, 1);
  await f.desk.close();
});
