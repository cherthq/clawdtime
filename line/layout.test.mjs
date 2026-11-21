// node --test layout.test.mjs
// No network, no screen, no installed dependency.
import assert from "node:assert/strict";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const {
  cleanView,
  layoutName,
  screenFilter,
  screenLayout,
  seenBox,
  STONE_ROOM,
} = await import("./layout.mjs");

test("a phone held upright with the video set to fill sees the middle strip of the picture", () => {
  // 720 tall on a 9 by 19.5 screen: 332 wide of 1280.
  assert.deepEqual(seenBox(1280, 720, "upright"), {
    x: 474,
    y: 0,
    w: 332,
    h: 720,
  });
  assert.deepEqual(seenBox(1280, 720, "wide"), { x: 0, y: 0, w: 1280, h: 720 });
  // Anything that is not a known layout is upright: the stone is then never cut.
  assert.equal(layoutName("sideways"), "upright");
  assert.equal(layoutName("WIDE"), "wide");
  assert.equal(layoutName(undefined), "upright");
});

test("a shared screen fits into what the caller sees, and the small stone has its own room", () => {
  const upright = screenLayout(1280, 720, "upright");
  assert.deepEqual(upright.box, { x: 474, y: 0, w: 332, h: 720 - STONE_ROOM });
  // The stone sits under the screen, inside the strip.
  assert.ok(upright.stone.y >= upright.box.h);
  assert.ok(
    upright.stone.x >= 474 && upright.stone.x + upright.stone.size <= 474 + 332,
  );
  assert.ok(upright.stone.y + upright.stone.size <= 720);
  const wide = screenLayout(1280, 720, "wide");
  assert.deepEqual(wide.box, { x: 0, y: 0, w: 1280, h: 720 });
  assert.deepEqual(wide.stone, { size: 150, x: 1106, y: 546 });
});

test("a view is a part of the screen in shares, kept inside the screen", () => {
  assert.deepEqual(cleanView({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }), {
    x: 0.1,
    y: 0.2,
    w: 0.5,
    h: 0.6,
  });
  // A window that hangs over the edge is cut to the screen.
  assert.deepEqual(cleanView({ x: 0.7, y: -0.1, w: 0.6, h: 0.5 }), {
    x: 0.7,
    y: 0,
    w: 0.3,
    h: 0.5,
  });
  for (const bad of [
    null,
    "x",
    {},
    { x: 0, y: 0, w: 0.01, h: 0.5 },
    { x: 0, y: 0, w: Number.NaN, h: 1 },
    { x: "0", y: 0, w: 1, h: 1 },
  ])
    assert.equal(cleanView(bad), null);
});

test("the filter fits the whole screen, or one window of it, into the box of the layout", () => {
  assert.equal(
    screenFilter({ width: 1280, height: 720, fps: 10, layout: "wide" }),
    "fps=10,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:0+(1280-iw)/2:0+(720-ih)/2:color=0x111317",
  );
  assert.equal(
    screenFilter({ width: 1280, height: 720, fps: 10, layout: "upright" }),
    "fps=10,scale=332:588:force_original_aspect_ratio=decrease,pad=1280:720:474+(332-iw)/2:0+(588-ih)/2:color=0x111317",
  );
  // One window: the crop comes first, in shares of the captured picture, whatever its size in pixels.
  assert.equal(
    screenFilter({
      width: 1280,
      height: 720,
      fps: 10,
      layout: "wide",
      view: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 },
    }),
    "crop=iw*0.5:ih*0.8:iw*0.25:ih*0.1,fps=10,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:0+(1280-iw)/2:0+(720-ih)/2:color=0x111317",
  );
  // A view that is no view shows the whole screen.
  assert.ok(
    !screenFilter({
      width: 1280,
      height: 720,
      fps: 10,
      view: { x: 0, y: 0, w: 0, h: 0 },
    }).includes("crop"),
  );
});
