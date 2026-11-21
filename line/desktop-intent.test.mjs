import assert from "node:assert/strict";
import { desktopDirection, makeDesktopIntent } from "./desktop-intent.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const commands = [
  ["Switch to the desktop on the left", "left"],
  ["Move one desktop right", "right"],
  ["Go back to the previous desktop", "previous"],
  ["Please move a space left!", "left"],
  ["switch right one desktop please.", "right"],
  ["What does switch to the desktop on the left mean?", undefined],
  ["Do not move one desktop right", undefined],
  ['Explain "Move one desktop right"', undefined],
  ["Move one desktop right and open Safari", undefined],
  ["Move two desktops right", undefined],
];
test("standalone line recognizes only the service's exact directional grammar", async () => {
  const service = process.env.VITEST
    ? (await import("../connectors/computer/desktop.ts")).desktopDirection
    : null;
  for (const [words, expected] of commands) {
    assert.equal(desktopDirection(words), expected);
    if (service) assert.equal(desktopDirection(words), service(words));
  }
});

test("forwards one exact final human utterance, never model wording, and consumes before dispatch", async () => {
  const intent = makeDesktopIntent();
  const text = "  Switch to the desktop on the left  ";
  intent.add(text, true);
  assert.deepEqual(await intent.take("Move one desktop left"), {
    ok: true,
    text,
  });
  // Even if the caller's subsequent network delivery throws, this turn is spent.
  assert.equal((await intent.take("Move one desktop left")).ok, false);
});

test("rejects opposite direction and app-activation substitution without falling back", async () => {
  for (const request of [
    "Move one desktop right",
    "Open Safari",
    "Go back to the previous desktop",
  ]) {
    const intent = makeDesktopIntent();
    intent.add("Switch to the desktop on the left");
    assert.equal((await intent.take(request)).ok, false);
    assert.equal((await intent.take("Move one desktop left")).ok, false);
  }
});

test("a model cannot manufacture direction from an unrelated final transcript", async () => {
  const intent = makeDesktopIntent();
  intent.add("What is the computer status?");
  assert.equal((await intent.take("Move one desktop right")).ok, false);
});

test("ordinary final requests retain existing non-direction tool wording", async () => {
  const intent = makeDesktopIntent();
  intent.add("What is the status of the task?");
  assert.deepEqual(await intent.take("task status"), {
    ok: true,
    text: "task status",
  });
});

test("waits for final transcript and permits only one of simultaneous tool calls", async () => {
  const intent = makeDesktopIntent();
  intent.add("Move one desktop", false);
  const first = intent.take("Move one desktop right");
  const second = intent.take("Move one desktop right");
  intent.add("Move one desktop right", true);
  assert.deepEqual(await first, { ok: true, text: "Move one desktop right" });
  assert.equal((await second).ok, false);
});

test("a partial utterance retires old direction; its corrected final controls dispatch", async () => {
  const intent = makeDesktopIntent();
  intent.add("Move one desktop left");
  intent.add("Move one desktop right", false);
  const result = intent.take("Move one desktop left");
  intent.add("Move one desktop right", true);
  assert.equal((await result).ok, false);
});

test("a new final request can authorize a second explicitly requested step", async () => {
  const intent = makeDesktopIntent();
  for (let step = 0; step < 2; step++) {
    intent.add("Move one desktop right");
    assert.equal((await intent.take("Move one desktop right")).ok, true);
  }
});

test("missing, stale and backwards-clock transcripts authorize no command", async () => {
  let now = 10;
  for (const change of [null, 31, 9]) {
    const intent = makeDesktopIntent({
      now: () => now,
      maxAgeMs: 20,
      waitMs: 1,
    });
    now = 10;
    if (change !== null) {
      intent.add("Move one desktop right");
      now = change;
    }
    assert.equal((await intent.take("Move one desktop right")).ok, false);
  }
});

test("Stop cancels pending transcript binding and prevents later requests", async () => {
  const intent = makeDesktopIntent();
  const result = intent.take("Move one desktop right");
  intent.stop();
  intent.add("Move one desktop right");
  assert.equal((await result).ok, false);
  assert.equal((await intent.take("Move one desktop right")).ok, false);
});

test("exact Stop commands bypass missing, partial and consumed directional transcripts immediately", async () => {
  for (const state of ["missing", "partial", "consumed"]) {
    let timers = 0;
    const intent = makeDesktopIntent({
      setTimer: () => {
        timers++;
        throw new Error("Stop must not wait");
      },
    });
    if (state === "partial") intent.add("Move one desktop right", false);
    if (state === "consumed") {
      intent.add("Move one desktop right");
      await intent.take("Move one desktop right");
    }
    for (const text of [
      "stop",
      "Please cancel computer task!",
      "abort execution",
      "stop sharing",
    ])
      assert.deepEqual(await intent.take(text), { ok: true, text });
    assert.equal(timers, 0);
  }
});

test("an immediate Stop also cancels a directional tool still waiting for transcription", async () => {
  const intent = makeDesktopIntent();
  const pending = intent.take("Move one desktop right");
  assert.equal((await intent.take("stop")).ok, true);
  intent.add("Move one desktop right", true);
  assert.equal((await pending).ok, false);
});
