const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import assert from "node:assert/strict";
import { startRuntimeWindow } from "./runtime-window.mjs";
const flush = () => new Promise((resolve) => setImmediate(resolve));
const frame = (at) => ({
  width: 2,
  height: 2,
  frameId: "f",
  capturedAt: at,
  expiresAt: at + 500,
  rgba: new Uint8Array(16).fill(200),
  layout: {
    visible: true,
    frameId: "f",
    crop: { x: 0, y: 0, width: 2, height: 2 },
    contentRect: { x: 0, y: 0, width: 2, height: 2 },
    cursor: null,
  },
});
test("work video expires at action deadline even when pixel age is under one second", async () => {
  let now = 1000;
  const screen = startRuntimeWindow({
    runtime: { windowFrame: async () => frame(now) },
    width: 2,
    height: 2,
    now: () => now,
  });
  await flush();
  assert.equal(screen.latest()?.length, 16);
  now = 1500;
  assert.equal(screen.latest(), null);
  screen.stop();
});
test("stop drops already pending work-window transport and never restarts it", async () => {
  let resolve,
    calls = 0;
  const screen = startRuntimeWindow({
    runtime: {
      windowFrame: () => {
        calls++;
        return new Promise((r) => (resolve = r));
      },
    },
    width: 2,
    height: 2,
    now: () => 1000,
  });
  screen.stop();
  resolve(frame(1000));
  await flush();
  assert.equal(screen.latest(), null);
  assert.equal(calls, 1);
});
test("mismatched source metadata is never composed as phone video", async () => {
  const wrong = frame(1000);
  wrong.layout.frameId = "another";
  const screen = startRuntimeWindow({
    runtime: { windowFrame: async () => wrong },
    width: 2,
    height: 2,
    now: () => 1000,
  });
  await flush();
  assert.equal(screen.latest(), null);
  screen.stop();
});
test("capture transport failure shows no cached frame", async () => {
  const screen = startRuntimeWindow({
    runtime: {
      windowFrame: async () => {
        throw Error("unavailable");
      },
    },
    width: 2,
    height: 2,
    now: () => 1000,
  });
  await flush();
  assert.equal(screen.latest(), null);
  screen.stop();
});
