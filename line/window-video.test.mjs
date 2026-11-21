import assert from "node:assert/strict";
import { composeWindow } from "./window-video.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const source = () => ({
  id: "frame",
  pixelWidth: 4,
  pixelHeight: 2,
  pixels: new Uint8Array(
    Array.from({ length: 8 }, (_, i) => [i * 20, 0, 0, 255]).flat(),
  ),
});
const layout = {
  visible: true,
  frameId: "frame",
  crop: { x: 2, y: 0, width: 2, height: 2 },
  contentRect: { x: 1, y: 0, width: 2, height: 2 },
  cursor: null,
  cursorStatus: "excluded",
};
test("crop samples original pixels and letterboxes without changing source", () => {
  const s = source(),
    before = s.pixels.slice();
  const out = composeWindow(s, layout, 4, 2);
  assert.deepEqual(
    [...out.slice(0, 12)],
    [17, 19, 23, 255, 40, 0, 0, 255, 60, 0, 0, 255],
  );
  assert.deepEqual(s.pixels, before);
});
test("missing, hidden, mismatched and out-of-bounds frames never render", () => {
  for (const l of [
    { ...layout, visible: false },
    { ...layout, frameId: "old" },
    { ...layout, crop: { x: 3, y: 0, width: 2, height: 2 } },
    { ...layout, contentRect: { x: 0, y: 0, width: NaN, height: 2 } },
  ])
    assert.equal(composeWindow(source(), l, 4, 2), null);
  assert.equal(
    composeWindow({ ...source(), pixels: new Uint8Array(1) }, layout, 4, 2),
    null,
  );
});
test("cursor draws only when captured overlay exclusion was qualified", () => {
  const base = composeWindow(source(), layout, 4, 2);
  for (const status of ["included", "unknown"])
    assert.deepEqual(
      composeWindow(
        source(),
        { ...layout, cursor: { x: 1, y: 0 }, cursorStatus: status },
        4,
        2,
      ),
      base,
    );
  assert.notDeepEqual(
    composeWindow(source(), { ...layout, cursor: { x: 1, y: 0 } }, 4, 2),
    base,
  );
});

test("a stalled live capture expires and stopped capture cannot return later pixels", async () => {
  const { EventEmitter } = await import("node:events");
  const { startScreen } = await import("./screen.mjs");
  let now = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const screen = startScreen({
    start: () => child,
    frameBytes: 4,
    now: () => now,
    maxFrameAgeMs: 1000,
  });
  child.stdout.emit("data", Buffer.from([1, 2, 3, 255]));
  assert.deepEqual([...screen.latest()], [1, 2, 3, 255]);
  now = 1001;
  assert.equal(screen.latest(), null);
  child.stdout.emit("data", Buffer.from([4, 5, 6, 255]));
  assert.deepEqual([...screen.latest()], [4, 5, 6, 255]);
  screen.stop();
  child.stdout.emit("data", Buffer.from([7, 8, 9, 255]));
  assert.equal(screen.latest(), null);
});
