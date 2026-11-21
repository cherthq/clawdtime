// node --test words.test.mjs
// No network, no screen, no installed dependency.
import assert from "node:assert/strict";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const { makeWords, WIDE_WORDS } = await import("./words.mjs");

/** A clock and timers that a test moves by hand. */
function clock(start = 1_000_000) {
  let now = start;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(run, ms) {
      const timer = { run, at: now + ms };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    pass(ms) {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
    },
    timers: () => timers.size,
  };
}

test("the words for a wide picture are the caller's, in the forms that a transcription gives", () => {
  for (const said of [
    "My phone is sideways now.",
    "I turned it side ways",
    "It's in landscape",
    "I rotated the phone",
    "I am turning my phone",
    "make the picture wide please",
    "Can I get a wider picture?",
    "Make it bigger",
    "use the full width",
  ])
    assert.ok(WIDE_WORDS.test(said), said);
  for (const said of [
    "Show me the screen.",
    "What are my agents doing?",
    "Zoom in on the terminal that runs the tests",
    "Hello",
    "go back to the whole screen",
  ])
    assert.equal(WIDE_WORDS.test(said), false, said);
});

test("a check passes at once on words of the last moments, and not on old words", async () => {
  const time = clock();
  const words = makeWords(time);
  words.add("Hello ClawdTime.");
  time.pass(1000);
  words.add("My phone is sideways now.");
  assert.equal(await words.said(WIDE_WORDS), true);
  assert.equal(time.timers(), 0, "no wait was needed");
  // 25 seconds later the sentence is no longer what the caller just said.
  time.pass(25_000);
  const later = words.said(WIDE_WORDS);
  time.pass(2500);
  assert.equal(await later, false);
  assert.equal(words.recent(60_000).includes("sideways"), true);
  time.pass(10_000);
  words.add("ok");
  assert.equal(words.recent(60_000), "ok", "old sentences are dropped");
});

test("a check waits for words that arrive a moment after the model acted, and gives up after the wait", async () => {
  const time = clock();
  const words = makeWords(time);
  const waited = words.said(WIDE_WORDS);
  time.pass(800);
  // A piece that is not final counts, and the final piece replaces it.
  words.add("my phone is side", false);
  words.add("my phone is sideways", false);
  assert.equal(await waited, true);
  words.add("My phone is sideways.", true);
  assert.equal(words.recent(), "My phone is sideways.");
  assert.equal(time.timers(), 0);
  // No such words: false after the wait, and no timer is left.
  const other = makeWords(time);
  other.add("Show me the screen.");
  const none = other.said(WIDE_WORDS, { waitMs: 2000 });
  time.pass(1999);
  other.add("and tell me what runs");
  time.pass(1);
  assert.equal(await none, false);
  assert.equal(time.timers(), 0);
});

test("text that is no speech is ignored, and a stop ends every wait", async () => {
  const time = clock();
  const words = makeWords(time);
  for (const bad of ["", "   ", null, undefined, 42]) words.add(bad);
  assert.equal(words.recent(), "");
  const waiting = words.said(WIDE_WORDS);
  words.stop();
  assert.equal(await waiting, false);
  words.add("sideways");
  assert.equal(await words.said(WIDE_WORDS), false, "nothing after the stop");
  assert.equal(time.timers(), 0);
});
