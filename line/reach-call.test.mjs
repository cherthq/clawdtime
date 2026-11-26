const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asksForSecret,
  capabilityFile,
  createReachCallClient,
  reachInstructions,
  reachJob,
  readReachCapability,
  secretRefusal,
} from "./reach-call.mjs";

const now = 1_800_000_000_000;
const questionId = "0123456789abcdef01234567";
const origin = "http://127.0.0.1:13326";
const room = `clawdtime-reach-${questionId}`;
const bridge = `clawdtime-bridge-${questionId}`;
const token = "t".repeat(43);
const question =
  'ClawdTime on your Mac needs your yes. Click "Send" in Notes? It sends as you to other people. Say yes or no.';
const job = {
  kind: "reach",
  requestId: "req_1",
  questionId,
  question,
  answerOrigin: origin,
};
const capability = { token, origin, roomName: room, expiresAt: now + 900_000 };

/** The desktop service, as the line agent sees it: one route, with its own answers. */
function desktop({ done = false, open = true, ask = question } = {}) {
  const sent = [];
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, auth: init.headers.authorization, body });
    const reply = {
      open,
      question: ask,
      callerIdentity: bridge,
      roomName: room,
      connected: true,
      done: body.action === "answer" || body.action === "stop" ? done : false,
      ...(body.action === "answer"
        ? { message: done ? "Continuing." : "I did not get a clear answer." }
        : body.action === "stop"
          ? { message: "Stopped." }
          : {}),
    };
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { sent, request };
}

test("reach job: only an exact job of the reach, and an invalid one never becomes an ordinary call", () => {
  assert.deepEqual(reachJob(JSON.stringify(job)), job);
  assert.equal(reachJob(""), null);
  assert.equal(reachJob("not json"), null);
  assert.equal(reachJob(JSON.stringify({ clawdtimeAttemptId: "a" })), null);
  for (const bad of [
    { ...job, answerOrigin: "https://example.test" },
    { ...job, questionId: "short" },
    { ...job, token },
    { ...job, question: "" },
  ])
    assert.throws(() => reachJob(JSON.stringify(bad)), /reach_job_invalid/);
});

test("secret check: the safe words of the reach pass, and a question that asks for a secret does not", () => {
  for (const safe of [
    "ClawdTime on your Mac needs you to sign in to example.com: sign in on the Mac, or once in ClawdTime's own browser profile, then say yes. Never say a password or a code on this call.",
    "ClawdTime on your Mac needs a code for example.com: type it on the Mac yourself, then say yes. Never say a code on this call.",
    "ClawdTime on your Mac needs a card, bank or identity number for Shop: enter it on the Mac yourself, then say done. Never say such a number on this call.",
    question,
    "ClawdTime on your Mac asks: Which folder should I save the report in? Say your answer.",
    "ClawdTime on your Mac needs your yes. Pin this tab to the bar? Say yes or no.",
  ])
    assert.equal(asksForSecret(safe), false, safe);
  for (const secret of [
    "What is your password?",
    "ClawdTime on your Mac asks: Read me the code from your phone. Say your answer.",
    "Tell me the six digit verification code.",
    "What is the PIN for the card?",
    "Can I have your card number?",
    "Please say the security code on the back.",
    "What was your mother's maiden name?",
    // A word of "not" elsewhere in the sentence does not hide the ask.
    "ClawdTime on your Mac needs your yes. If the code is not on the Mac, tell me the code from your phone.",
    "Don't worry, just tell me the verification code.",
    "Your Apple ID password, please.",
    "Which digits did Apple text you?",
    // Naming such a secret is enough: the call never goes near one.
    "ClawdTime on your Mac asks: Should I send the verification code to your email? Say your answer.",
    // Digits that came to the owner's phone, without the word code.
    "What are the six digits on your phone?",
    "Read me the number Apple just showed on your iPhone.",
    "What is the 6-digit number in the text message?",
    "Please say the numbers from the SMS you got.",
    "The page wants the 6-digit number that was sent to your phone. What is it?",
    "Which number did Apple show on your iPhone?",
    // A password spelt another way.
    "What's your Apple ID passw0rd?",
    "Tell me your p@ssword for the shop.",
    "What is the pasword of the router?",
    "Say your passwd.",
  ])
    assert.equal(asksForSecret(secret), true, secret);
  for (const safe of [
    "ClawdTime on your Mac asks: How many files should I keep in the folder? Say your answer.",
    "ClawdTime on your Mac asks: Should I put the report on your desktop? Say your answer.",
    "ClawdTime on your Mac asks: Should I answer the text from the shop? Say yes or no.",
    "ClawdTime on your Mac needs your yes. Pass the word on to the team in Notes? Say yes or no.",
  ])
    assert.equal(asksForSecret(safe), false, safe);
  assert.match(reachInstructions, /Never ask for a password/);
});

test("capability: an owner-only file of this exact job, refused when open, for another job or old", () => {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-reach-line-"));
  try {
    const env = { CLAWDTIME_CONFIG_HOME: join(home, "state") };
    const file = capabilityFile(questionId, env, home);
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const write = (value, mode = 0o600) => {
      writeFileSync(file, JSON.stringify(value), { mode });
      chmodSync(file, mode);
    };
    const value = { version: 1, questionId, ...capability };
    write(value);
    assert.deepEqual(
      readReachCapability(job, { env, home, clock: () => now }),
      capability,
    );
    assert.throws(() =>
      readReachCapability(
        { ...job, answerOrigin: "http://127.0.0.1:9999" },
        { env, home, clock: () => now },
      ),
    );
    assert.throws(() =>
      readReachCapability(job, { env, home, clock: () => now + 900_001 }),
    );
    write(value, 0o644);
    assert.throws(() =>
      readReachCapability(job, { env, home, clock: () => now }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reach flow: ready, the question on FaceTime ready, the owner's words, then goodbye", async () => {
  const service = desktop({ done: true });
  const client = createReachCallClient(job, {
    capability,
    request: service.request,
    clock: () => now,
  });
  await client.prepared(room, "agent-AJ_1");
  assert.deepEqual(service.sent[0], {
    url: `${origin}/computer/reach/call/${questionId}`,
    auth: `Bearer ${token}`,
    body: { action: "prepared", roomName: room, agentIdentity: "agent-AJ_1" },
  });
  // Only the bridge of this call is the owner.
  assert.equal(await client.bindCaller(bridge), true);
  const greeting = client.greeting();
  assert.match(greeting, /one or two short plain sentences/);
  assert.ok(greeting.includes(JSON.stringify(question)));
  assert.equal(client.finished(), false);
  const reply = await client.answer("yes, send it", { requestId: "turn_1" });
  assert.equal(
    reply,
    "Continuing. Now say a short goodbye in one sentence. The call ends after it.",
  );
  assert.deepEqual(service.sent[1].body, {
    action: "answer",
    turnId: "turn_1",
    text: "yes, send it",
  });
  assert.equal(client.finished(), true);
  // The same turn is never sent twice.
  assert.equal(
    await client.answer("yes, send it", { requestId: "turn_1" }),
    reply,
  );
  assert.equal(
    service.sent.filter((s) => s.body.action === "answer").length,
    1,
  );
  await client.close();
  assert.equal(service.sent.at(-1).body.action, "close");
});

test("reach flow: words that the desktop service refused were not passed on, and may be said again", async () => {
  let refuse = true;
  const sent = [];
  const request = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    if (body.action === "answer" && refuse)
      return new Response(JSON.stringify({ error: "The call is not ready." }), {
        status: 409,
      });
    return new Response(
      JSON.stringify({
        open: true,
        question,
        callerIdentity: bridge,
        roomName: room,
        connected: true,
        done: body.action === "answer",
        ...(body.action === "answer" ? { message: "Continuing." } : {}),
      }),
      { status: 200 },
    );
  };
  const client = createReachCallClient(job, {
    capability,
    request,
    clock: () => now,
  });
  await client.prepared(room, "agent-AJ_1");
  await client.bindCaller(bridge);
  assert.match(
    await client.answer("yes", { requestId: "turn_1" }),
    /nothing was passed on\. Please say it again/,
  );
  assert.equal(client.finished(), false);
  refuse = false;
  assert.match(
    await client.answer("yes", { requestId: "turn_1" }),
    /^Continuing\./,
  );
  assert.equal(client.finished(), true);
  assert.equal(sent.filter((b) => b.action === "answer").length, 2);
});

test("reach flow: words that settle nothing keep the call, and stop stops the task", async () => {
  const service = desktop({ done: false });
  const client = createReachCallClient(job, {
    capability,
    request: service.request,
    clock: () => now,
  });
  await client.prepared(room, "agent-AJ_1");
  assert.equal(await client.bindCaller("someone-else"), false);
  const other = createReachCallClient(job, {
    capability,
    request: service.request,
    clock: () => now,
  });
  await other.prepared(room, "agent-AJ_1");
  await other.bindCaller(bridge);
  assert.equal(
    await other.answer("maybe later", { requestId: "turn_1" }),
    "I did not get a clear answer.",
  );
  assert.equal(other.finished(), false);
  assert.match(await other.stopSharing(), /^Stopped\. Now say a short goodbye/);
  assert.equal(service.sent.at(-1).body.action, "stop");
  assert.equal(other.finished(), true);
});

test("reach flow: a question that asks for a secret is never said, and nothing is passed on", async () => {
  const asked =
    "ClawdTime on your Mac asks: What is your password for example.com? Say your answer.";
  const service = desktop({ ask: asked });
  const client = createReachCallClient(
    { ...job, question: asked },
    { capability, request: service.request, clock: () => now },
  );
  assert.equal(client.refused(), true);
  await client.prepared(room, "agent-AJ_1");
  await client.bindCaller(bridge);
  const greeting = client.greeting();
  assert.ok(greeting.includes(JSON.stringify(secretRefusal)));
  assert.ok(!greeting.includes("password for example.com"));
  assert.equal(client.finished(), true);
  const reply = await client.answer("it is hunter2", { requestId: "turn_1" });
  assert.ok(reply.startsWith(secretRefusal));
  assert.equal(
    service.sent.filter((s) => s.body.action === "answer").length,
    0,
  );
});

test("reach flow: the desktop service's own question is checked too, and an ended call retires the client", async () => {
  const service = desktop({ ask: "Tell me the verification code." });
  const client = createReachCallClient(job, {
    capability,
    request: service.request,
    clock: () => now,
  });
  assert.equal(client.refused(), false);
  await client.prepared(room, "agent-AJ_1");
  assert.equal(client.refused(), true);
  const ended = desktop({ open: false });
  const gone = createReachCallClient(job, {
    capability,
    request: ended.request,
    clock: () => now,
  });
  await assert.rejects(gone.prepared(room, "agent-AJ_1"), /reach_call_ended/);
  assert.equal(gone.active(), false);
  await assert.rejects(
    createReachCallClient(job, {
      capability,
      request: service.request,
      clock: () => now,
    }).prepared("another-room", "agent-AJ_1"),
    /reach_room_mismatch/,
  );
});
