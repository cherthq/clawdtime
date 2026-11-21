import assert from "node:assert/strict";
import { makeCallerRequestBinding } from "./desktop-intent.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

test("forwards arbitrary navigation phrasing unchanged for backend interpretation", async () => {
  for (const text of [
    "Could you bring my Messages conversation back into view?",
    "Take me back to the app I was just using.",
    "Let's peek at the workspace immediately to our right.",
    "Return to the desktop we just left, please.",
    "Passe au bureau à gauche, s’il te plaît.",
    "Bring the Draft window in TextEdit forward.",
    'Explain what "move one desktop right" means, without doing it.',
    "Do not switch apps; tell me what the task is doing.",
    "Move two desktops and open Safari.",
  ]) {
    const binding = makeCallerRequestBinding();
    binding.add(text);
    assert.deepEqual(await binding.take(text), { ok: true, text });
    // Transport does not turn quotations, negation or compounds into commands;
    // the goal-only semantic interpreter receives the complete human request.
  }
});

test("forwards original whitespace and spends the utterance before delivery", async () => {
  const binding = makeCallerRequestBinding();
  const text = "  Bring Messages\n forward, please.  ";
  binding.add(text);
  assert.deepEqual(await binding.take("Bring Messages forward, please."), {
    ok: true,
    text,
  });
  // Even if network delivery then throws, this utterance is spent.
  assert.equal((await binding.take(text)).ok, false);
});

test("rejects model paraphrase, different targets, omitted negation and quoted substrings", async () => {
  for (const [spoken, generated] of [
    ["Move one desktop left", "Move one desktop right"],
    ["Could you bring Messages forward?", "Open Messages"],
    ["Do not switch to Safari", "switch to Safari"],
    ['Explain "Move one desktop right"', "Move one desktop right"],
    ["What is the status of the task?", "task status"],
    ["Return to the previous app", "Return to the previous desktop"],
  ]) {
    const binding = makeCallerRequestBinding();
    binding.add(spoken);
    assert.equal((await binding.take(generated)).ok, false);
    assert.equal((await binding.take(spoken)).ok, false);
  }
});

test("a model cannot manufacture navigation from unrelated human words", async () => {
  const binding = makeCallerRequestBinding();
  binding.add("What is the computer status?");
  assert.equal((await binding.take("Bring Safari forward")).ok, false);
});

test("waits for a final and permits only one simultaneous tool call", async () => {
  const binding = makeCallerRequestBinding();
  const text = "Please bring the app I was just using back.";
  binding.add("Please bring", false);
  const first = binding.take(text);
  const second = binding.take(text);
  binding.add(text, true);
  assert.deepEqual(await first, { ok: true, text });
  assert.equal((await second).ok, false);
});

test("a partial retires old authority; a correction does not authorize a stale tool", async () => {
  const binding = makeCallerRequestBinding();
  binding.add("Bring Safari forward");
  binding.add("Actually Messages", false);
  const result = binding.take("Bring Safari forward");
  binding.add("Actually Messages, please", true);
  assert.equal((await result).ok, false);
});

test("SDK empty nonfinal speech-start events retire the preceding utterance", async () => {
  const binding = makeCallerRequestBinding({ waitMs: 1 });
  binding.add("Bring Messages forward", true, { itemId: "earlier" });
  binding.add("", false);
  assert.equal((await binding.take("Bring Messages forward")).ok, false);
});

test("distinct final utterances can independently request the same action", async () => {
  const binding = makeCallerRequestBinding();
  for (let step = 0; step < 2; step++) {
    binding.add("Move one desktop right", true, { itemId: `turn-${step}` });
    assert.equal((await binding.take("Move one desktop right")).ok, true);
  }
});

test("duplicate or corrected final callbacks cannot reauthorize a consumed item", async () => {
  const binding = makeCallerRequestBinding();
  binding.add("Bring Messages forward", true, { itemId: "human-1" });
  assert.equal((await binding.take("Bring Messages forward")).ok, true);
  binding.add("Bring Messages forward", true, { itemId: "human-1" });
  assert.equal((await binding.take("Bring Messages forward")).ok, false);
  binding.add("Bring Safari forward", true, { itemId: "human-1" });
  assert.equal((await binding.take("Bring Safari forward")).ok, false);
});

test("stale and out-of-order final events cannot replace a newer utterance", async () => {
  const binding = makeCallerRequestBinding({ now: () => 100, maxAgeMs: 20 });
  binding.add("Bring Messages forward", true, { itemId: "new", createdAt: 95 });
  binding.add("Bring Safari forward", true, { itemId: "old", createdAt: 90 });
  binding.add("Go right", true, { itemId: "stale", createdAt: 10 });
  binding.add("Go left", true, { itemId: "future", createdAt: 101 });
  assert.deepEqual(await binding.take("Bring Messages forward"), {
    ok: true,
    text: "Bring Messages forward",
  });
});

test("missing, expired and backwards-clock transcripts authorize nothing", async () => {
  let now = 10;
  for (const change of [null, 31, 9]) {
    const binding = makeCallerRequestBinding({
      now: () => now,
      maxAgeMs: 20,
      waitMs: 1,
    });
    now = 10;
    if (change !== null) {
      binding.add("Move one desktop right");
      now = change;
    }
    assert.equal((await binding.take("Move one desktop right")).ok, false);
  }
});

test("ended calls cancel pending binding and cannot accept later callbacks", async () => {
  const binding = makeCallerRequestBinding();
  const result = binding.take("Bring Messages forward");
  binding.stop();
  binding.add("Bring Messages forward");
  assert.equal((await result).ok, false);
  assert.equal((await binding.take("Bring Messages forward")).ok, false);
});

test("exact emergency Stop bypasses missing, partial and consumed transcripts immediately", async () => {
  for (const state of ["missing", "partial", "consumed"]) {
    let timers = 0;
    const binding = makeCallerRequestBinding({
      setTimer: () => {
        timers++;
        throw new Error("Stop must not wait");
      },
    });
    if (state === "partial") binding.add("Bring Messages", false);
    if (state === "consumed") {
      binding.add("Bring Messages forward");
      await binding.take("Bring Messages forward");
    }
    for (const text of [
      "stop",
      "Please cancel computer task!",
      "abort execution",
      "stop sharing",
    ])
      assert.deepEqual(await binding.take(text), { ok: true, text });
    assert.equal(timers, 0);
  }
});

test("emergency Stop cancels a tool waiting for transcription", async () => {
  const binding = makeCallerRequestBinding();
  const pending = binding.take("Bring Messages forward");
  assert.equal((await binding.take("stop")).ok, true);
  binding.add("Bring Messages forward", true);
  assert.equal((await pending).ok, false);
});

test("invalid model arguments fail without registering a wait", async () => {
  const binding = makeCallerRequestBinding({
    setTimer: () => {
      throw new Error("must not wait");
    },
  });
  for (const request of [null, {}, "", " ", "a".repeat(16001)])
    assert.equal((await binding.take(request)).ok, false);
});
