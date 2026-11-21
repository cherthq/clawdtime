// node --test ears.test.mjs
// No network, no model, no installed dependency. Time is a list of timers that the test runs by hand.
import assert from "node:assert/strict";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const { FALLBACK_MS, GREETING_MS, makeEars, TAIL_MS } =
  await import("./ears.mjs");

/** Ears with a clock that the test moves. `log` holds every change of listening, in order. */
function ears(options = {}) {
  const log = [];
  let clock = 0;
  let timers = [];
  const made = makeEars({
    setListening: (on) => log.push(on),
    setTimer: (run, ms) => {
      const timer = { at: clock + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers = timers.filter((item) => item !== timer);
    },
    ...options,
  });
  const pass = (ms) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= clock);
      if (!due.length) break;
      const next = due.sort((a, b) => a.at - b.at)[0];
      timers = timers.filter((timer) => timer !== next);
      next.run();
    }
  };
  return { made, log, pass, timers: () => timers.length };
}

test("the agent does not listen before the call is ready, nor during its greeting", () => {
  const { made, log, pass } = ears();
  // It starts deaf: a sound of a call that still connects is not the caller.
  assert.deepEqual(log, [false]);
  made.state("listening");
  pass(5000);
  assert.deepEqual(log, [false]);
  made.ready();
  pass(900); // the model takes a moment before the first word
  assert.deepEqual(log, [false]);
  made.state("speaking");
  pass(2500);
  made.state("listening");
  // The greeting is over. The agent's last sound is still on the line for a moment.
  assert.deepEqual(log, [false]);
  pass(TAIL_MS - 1);
  assert.deepEqual(log, [false]);
  pass(1);
  assert.deepEqual(log, [false, true]);
  assert.equal(made.listening(), true);
});

test("the agent does not listen while it speaks, nor for a moment after: it never hears its own voice", () => {
  const { made, log, pass } = ears();
  made.ready();
  made.state("speaking");
  made.state("listening");
  pass(TAIL_MS);
  assert.deepEqual(log, [false, true]);
  // A thought is not speech: the caller can still add a word.
  made.state("thinking");
  assert.deepEqual(log, [false, true]);
  made.state("speaking");
  assert.deepEqual(log, [false, true, false]);
  pass(17000); // a long answer, as on the call of 21 November
  assert.deepEqual(log, [false, true, false]);
  made.state("listening");
  pass(TAIL_MS - 1);
  assert.deepEqual(log, [false, true, false]);
  // The agent speaks again before the moment is over: it stays deaf, and the moment starts again after.
  made.state("speaking");
  pass(5000);
  made.state("listening");
  pass(TAIL_MS);
  assert.deepEqual(log, [false, true, false, true]);
});

test("with no ready signal the agent listens after a wait, so the caller can speak first", () => {
  const { made, log, pass } = ears();
  pass(FALLBACK_MS - 1);
  assert.deepEqual(log, [false]);
  pass(1);
  assert.deepEqual(log, [false, true]);
  // A late signal changes nothing: the agent already listens.
  made.ready();
  pass(GREETING_MS);
  assert.deepEqual(log, [false, true]);
});

test("a greeting that never starts, or never ends, does not leave the agent deaf", () => {
  const silent = ears();
  silent.made.ready();
  silent.pass(GREETING_MS - 1);
  assert.deepEqual(silent.log, [false]);
  silent.pass(1);
  assert.deepEqual(silent.log, [false, true]);
  // It started and never ended: the agent is ready to listen, and does so when the speech ends.
  const stuck = ears();
  stuck.made.ready();
  stuck.made.state("speaking");
  stuck.pass(GREETING_MS);
  assert.deepEqual(stuck.log, [false]);
  stuck.made.state("listening");
  stuck.pass(TAIL_MS);
  assert.deepEqual(stuck.log, [false, true]);
});

test("speech before the ready signal is not the greeting", () => {
  const { made, log, pass } = ears();
  // The model said something before FaceTime was ready. That does not open the ears.
  made.state("speaking");
  made.state("listening");
  pass(TAIL_MS * 2);
  assert.deepEqual(log, [false]);
  made.ready();
  made.state("speaking");
  made.state("listening");
  pass(TAIL_MS);
  assert.deepEqual(log, [false, true]);
});

test("with barge-in the agent also listens while it speaks, but still not before the call is ready", () => {
  const { made, log, pass } = ears({ bargeIn: true });
  pass(3000);
  assert.deepEqual(log, [false]);
  made.ready();
  made.state("speaking");
  made.state("listening");
  assert.deepEqual(log, [false, true]);
  made.state("speaking");
  pass(9000);
  made.state("listening");
  assert.deepEqual(log, [false, true]);
});

test("after the call ended nothing changes and no timer is left", () => {
  const { made, log, pass, timers } = ears();
  made.ready();
  made.state("speaking");
  made.stop();
  made.state("listening");
  pass(60000);
  assert.deepEqual(log, [false]);
  assert.equal(timers(), 0);
});
