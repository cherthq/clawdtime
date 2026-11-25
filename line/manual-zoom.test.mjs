import assert from "node:assert/strict";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import { OVERVIEW, makeCamera } from "./camera.mjs";
import { makeCallVideo } from "./call-video.mjs";
import {
  MANUAL_ZOOM,
  cropAt,
  frameArea,
  frameElement,
  frameWindow,
  magnification,
  namedArea,
  planZoom,
  zoomGeometry,
  zoomLevel,
  zoomMove,
} from "./manual-zoom.mjs";
import { requestRegion, validRegionAnswer } from "./presentation-source.mjs";

const wide = zoomGeometry({ aspect: 16 / 9, layout: "wide" });
const fill = zoomGeometry({ aspect: 16 / 9, layout: "upright" });
const inside = (r) =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001;
const close = (a, b, d = 0.002) => Math.abs(a - b) < d;

test("area words name parts of the screen; any other word is a thing for the Mac", () => {
  const cases = {
    "top right": { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    "the top left corner": { x: 0, y: 0, w: 0.5, h: 0.5 },
    "bottom right of the screen": { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    "lower left": { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    "the left half": { x: 0, y: 0, w: 0.5, h: 1 },
    "right side": { x: 0.5, y: 0, w: 0.5, h: 1 },
    top: { x: 0, y: 0, w: 1, h: 0.5 },
    "the bottom half": { x: 0, y: 0.5, w: 1, h: 0.5 },
    "the middle": { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    "Centre of the screen.": { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    "top middle": { x: 0.25, y: 0, w: 0.5, h: 0.5 },
    "middle left": { x: 0, y: 0.25, w: 0.5, h: 0.5 },
    "bottom bar": { x: 0.25, y: 0.88, w: 0.5, h: 0.12 },
    "the dock": { x: 0.25, y: 0.88, w: 0.5, h: 0.12 },
    "the menu bar": { x: 0.25, y: 0, w: 0.5, h: 0.12 },
    "top bar": { x: 0.25, y: 0, w: 0.5, h: 0.12 },
  };
  for (const [words, region] of Object.entries(cases))
    assert.deepEqual(namedArea(words)?.region, region, words);
  assert.equal(namedArea("top right").label, "the top right of the screen");
  for (const words of [
    "the address bar",
    "the top of the chart",
    "Stonepad",
    "the menu",
    "the screen",
    "half",
    "bar",
    "top top",
    "",
  ])
    assert.equal(namedArea(words), null, words);
});

test("framing keeps every crop inside the screen and within the magnification range", () => {
  for (const g of [wide, fill, zoomGeometry({ aspect: 1.6, layout: "wide" })])
    for (const m of [0.5, 1, 1.8, 2, 3, 4, 9])
      for (const x of [0, 0.3, 1])
        for (const y of [0, 0.7, 1]) {
          const c = cropAt({ x, y }, m, g);
          assert.ok(inside(c), JSON.stringify(c));
          const level = magnification(c, g);
          assert.ok(level >= 0.999 && level <= MANUAL_ZOOM.max + 0.01);
        }
  // Wide: the crop has the picture's shape. Fill: it is tall, as the upright strip.
  assert.deepEqual(cropAt({ x: 0.5, y: 0.5 }, 2, wide), {
    x: 0.25,
    y: 0.25,
    w: 0.5,
    h: 0.5,
  });
  const tall = cropAt({ x: 0.75, y: 0.5 }, 2, fill);
  assert.deepEqual(tall, { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.ok(close(magnification(tall, fill), 2));
  assert.ok(cropAt({ x: 0.5, y: 0.5 }, 4, fill).h < 1);
});

test("a named part, a window and a thing each frame by their own rule", () => {
  // A quarter is exact on the wide picture and fills the upright strip at the same 2x.
  assert.deepEqual(frameArea(namedArea("top right").region, wide), {
    x: 0.5,
    y: 0,
    w: 0.5,
    h: 0.5,
  });
  const strip = frameArea(namedArea("top right").region, fill);
  assert.ok(close(magnification(strip, fill), 2) && strip.x === 0.5);
  // A half cannot be larger on the wide picture: it shows alone, not as the whole screen.
  assert.deepEqual(frameArea(namedArea("left half").region, wide), {
    x: 0,
    y: 0,
    w: 0.5,
    h: 1,
  });
  // The bottom bar is twice as large and touches the bottom edge.
  const bar = frameArea(namedArea("bottom bar").region, wide);
  assert.ok(close(magnification(bar, wide), 2) && close(bar.y + bar.h, 1));
  // A window shows alone; a very small one grows to the largest zoom.
  const window = { x: 0.1, y: 0.05, w: 0.6, h: 0.8 };
  assert.deepEqual(frameWindow(window, wide), window);
  const small = frameWindow({ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, wide);
  assert.ok(inside(small) && close(magnification(small, wide), 4, 0.01));
  // A thing gets room around it and at most 3x: a small button does not fill the picture.
  const button = { x: 0.8, y: 0.9, w: 0.02, h: 0.02 };
  const framed = frameElement(button, wide);
  assert.ok(close(magnification(framed, wide), MANUAL_ZOOM.element, 0.01));
  assert.ok(
    framed.x <= button.x &&
      framed.y <= button.y &&
      framed.x + framed.w >= button.x + button.w &&
      framed.y + framed.h >= button.y + button.h,
  );
  const field = { x: 0.3, y: 0.02, w: 0.4, h: 0.03 };
  const fieldCrop = frameElement(field, wide);
  assert.ok(fieldCrop.w >= field.w + 0.1 && fieldCrop.y === 0);
});

test("levels step within 1x and 4x; moves stay inside the screen", () => {
  const two = cropAt({ x: 0.5, y: 0.5 }, 2, wide);
  assert.ok(
    close(magnification(zoomLevel(two, { level: "in" }, wide).crop, wide), 3),
  );
  assert.ok(
    close(
      magnification(
        zoomLevel(two, { level: "in", bit: true }, wide).crop,
        wide,
      ),
      2.5,
    ),
  );
  assert.ok(
    close(
      magnification(zoomLevel(two, { level: "out" }, wide).crop, wide),
      4 / 3,
    ),
  );
  assert.deepEqual(
    zoomLevel(cropAt({ x: 0.5, y: 0.5 }, 1.2, wide), { level: "out" }, wide)
      .crop,
    OVERVIEW,
  );
  const top = zoomLevel(
    cropAt({ x: 0.5, y: 0.5 }, 3, wide),
    { level: "in" },
    wide,
  );
  assert.equal(top.limit, "max");
  assert.ok(close(magnification(top.crop, wide), 4));
  assert.equal(zoomLevel(OVERVIEW, { level: "out" }, wide).limit, "min");
  assert.ok(
    close(magnification(zoomLevel(OVERVIEW, { times: 2 }, wide).crop, wide), 2),
  );
  assert.equal(zoomLevel(OVERVIEW, { times: 12 }, wide).limit, "max");
  // The level keeps the centre of what is shown.
  const corner = cropAt({ x: 0.9, y: 0.1 }, 2, wide);
  const nearer = zoomLevel(corner, { level: "in" }, wide).crop;
  assert.ok(
    close(nearer.x + nearer.w / 2, corner.x + corner.w / 2) &&
      close(nearer.y + nearer.h / 2, corner.y + corner.h / 2),
  );

  const right = zoomMove(two, "right");
  assert.deepEqual(right, {
    crop: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 },
    edge: false,
  });
  assert.equal(zoomMove(right.crop, "right").edge, true);
  assert.deepEqual(zoomMove(two, "up", true).crop, {
    x: 0.25,
    y: 0.125,
    w: 0.5,
    h: 0.5,
  });
  assert.deepEqual(zoomMove(two, "down").crop, {
    x: 0.25,
    y: 0.5,
    w: 0.5,
    h: 0.5,
  });
  assert.deepEqual(zoomMove(two, "left", true).crop, {
    x: 0.125,
    y: 0.25,
    w: 0.5,
    h: 0.5,
  });
});

const resolver = (answers) => {
  const asked = [];
  return {
    asked,
    resolve: async (name) => {
      asked.push(name);
      return answers[name] ?? { code: "no_match" };
    },
  };
};

test("a plan zooms on parts, things and windows, and says when nothing matched", async () => {
  const mac = resolver({
    "the address bar": {
      code: "found",
      match: "element",
      region: { x: 0.3, y: 0.02, w: 0.4, h: 0.03 },
    },
    Stonepad: {
      code: "found",
      match: "window",
      region: { x: 0, y: 0.05, w: 0.7, h: 0.9 },
    },
    "the chart": { code: "no_look" },
  });
  const geometry = wide;
  const area = await planZoom(
    { target: "top right" },
    { geometry, resolve: mac.resolve },
  );
  assert.deepEqual(area.crop, { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.match(area.said, /top right of the screen at about 2x/);
  assert.match(area.said, /follow or show everything/);
  // Area words never go to the Mac.
  assert.deepEqual(mac.asked, []);
  const bar = await planZoom(
    { target: "the address bar" },
    { geometry, resolve: mac.resolve },
  );
  assert.ok(bar.crop.w < 1 && bar.crop.y === 0);
  assert.doesNotMatch(bar.said, /address/);
  const app = await planZoom(
    { target: "Stonepad", times: 2 },
    { geometry, resolve: mac.resolve },
  );
  assert.ok(close(magnification(app.crop, geometry), 2));
  assert.match(
    (
      await planZoom(
        { target: "the chart" },
        { geometry, resolve: mac.resolve },
      )
    ).said,
    /no recent look/,
  );
  const none = await planZoom(
    { target: "the Send button" },
    { geometry, resolve: mac.resolve },
  );
  assert.equal(none.crop, null);
  assert.match(none.said, /Nothing in the last look/);
  const broken = await planZoom(
    { target: "the error message" },
    { geometry, resolve: async () => Promise.reject(Error("down")) },
  );
  assert.equal(broken.crop, null);
  assert.match(broken.said, /did not answer/);
  // Another display: the Mac's places describe only the main one. Parts still work.
  const other = resolver({});
  assert.equal(
    (
      await planZoom(
        { target: "Stonepad" },
        { geometry, resolve: other.resolve, mainDisplay: false },
      )
    ).crop,
    null,
  );
  assert.deepEqual(other.asked, []);
  assert.ok(
    (
      await planZoom(
        { target: "middle" },
        { geometry, resolve: other.resolve, mainDisplay: false },
      )
    ).crop,
  );
});

test("a plan applies target, level and move in order, and reports the limits", async () => {
  const geometry = wide;
  const resolve = async () => ({ code: "no_match" });
  const both = await planZoom(
    { target: "the middle", level: "in", move: "right", bit: true },
    { geometry, resolve },
  );
  // "A bit" is one word for the whole request: a bit closer, then a bit to the right.
  assert.ok(close(magnification(both.crop, geometry), 2.5));
  assert.ok(close(both.crop.x, 0.3 + 0.1));
  const max = cropAt({ x: 0.5, y: 0.5 }, 4, geometry);
  const atMax = await planZoom(
    { level: "in" },
    { current: max, geometry, resolve },
  );
  assert.equal(atMax.crop, null);
  assert.match(atMax.said, /largest zoom is 4x/);
  const out = await planZoom(
    { level: "out" },
    { current: OVERVIEW, geometry, resolve },
  );
  assert.equal(out.crop, null);
  assert.match(out.said, /already shows the whole screen/);
  const pan = await planZoom(
    { move: "left" },
    { current: OVERVIEW, geometry, resolve },
  );
  assert.equal(pan.crop, null);
  assert.match(pan.said, /nothing to move/);
  const edge = await planZoom(
    { move: "left" },
    { current: { x: 0, y: 0, w: 0.5, h: 0.5 }, geometry, resolve },
  );
  assert.match(edge.said, /left edge/);
  const twice = await planZoom(
    { times: 2 },
    { current: OVERVIEW, geometry, resolve },
  );
  assert.deepEqual(twice.crop, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  const back = await planZoom(
    { times: 1 },
    { current: twice.crop, geometry, resolve },
  );
  assert.deepEqual(back.crop, OVERVIEW);
  assert.match(back.said, /whole screen/);
});

const event = (at, sequence, target = { x: 1300, y: 800, w: 24, h: 24 }) => ({
  version: 1,
  producerId: "fixture",
  commandSeq: 10,
  sequence,
  at,
  expiresAt: at + 1400,
  kind: "target",
  reducedMotion: false,
  surface: {
    displayId: "1",
    width: 1440,
    height: 900,
    scale: 2,
    appId: "test.fixture",
    windowId: "9",
    window: { x: 0, y: 0, w: 1440, h: 900 },
  },
  target,
});

test("a manual zoom holds against automatic zoom until follow or show everything", () => {
  let now = 1000;
  const camera = makeCamera({ since: 1000, now: () => now });
  const zoomed = { x: 0.5, y: 0, w: 0.5, h: 0.5 };
  camera.manual(zoomed);
  now = 1400;
  assert.deepEqual(camera.crop(), zoomed);
  assert.deepEqual(camera.current(), zoomed);
  // Agent clicks elsewhere do not move it, nor a transition, nor the end of the hold time.
  for (let i = 1; i < 8; i++) {
    now = 1400 + i * 500;
    camera.event(event(now, i, { x: 10, y: 850, w: 20, h: 20 }));
    assert.deepEqual(camera.crop(), zoomed);
  }
  camera.event({
    ...event(now, 9),
    kind: "transition",
    surface: undefined,
    target: undefined,
  });
  camera.reset();
  camera.control("enable");
  now += 5000;
  assert.deepEqual(camera.crop(), zoomed);
  // Follow releases it: the next click frames again.
  camera.control("resume");
  now += 400;
  assert.deepEqual(camera.crop(), OVERVIEW);
  camera.event(event(now, 10));
  now += 400;
  assert.ok(camera.crop().w < 1);
  // Show everything also releases it, and latches the whole screen.
  camera.manual(zoomed);
  camera.control("overview");
  now += 400;
  assert.deepEqual(camera.crop(), OVERVIEW);
  camera.event(event(now, 11));
  now += 400;
  assert.deepEqual(camera.crop(), OVERVIEW);
  assert.equal(camera.status().overview, true);
});

test("the call video reports what the zoom starts from and holds it through hide and show", async () => {
  let at = 1000;
  const shot = { width: 32, height: 20, data: new Uint8Array(32 * 20 * 3) };
  const call = makeCallVideo({
    since: 1000,
    now: () => at,
    capture: () => ({
      supportsAutomaticZoom: true,
      latest: () => shot,
      started: async () => true,
      stop() {},
    }),
    presentation: () => ({ stop() {} }),
  });
  assert.deepEqual(call.view(), { crop: OVERVIEW, aspect: null, main: true });
  assert.equal(await call.show(), true);
  call.frame();
  assert.equal(call.view().aspect, 1.6);
  const zoomed = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  call.manual(zoomed);
  call.hide();
  assert.deepEqual(call.view().crop, zoomed);
  assert.equal(await call.show(), true);
  at += 400;
  call.frame();
  assert.deepEqual(call.view().crop, zoomed);
  assert.equal(call.status().manual, true);
  call.close();
  const other = makeCallVideo({ device: "1" });
  assert.equal(other.view().main, false);
});

test("the region client sends the panel credential, checks the service and accepts only a bare rectangle", async () => {
  const service = {
    origin: "http://127.0.0.1:4100",
    instanceId: "instance-1",
    token: "t".repeat(40),
  };
  const seen = [];
  const reply = (body) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  let answer = {
    version: 1,
    code: "found",
    match: "element",
    region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
  };
  let instanceId = "instance-1";
  const request = async (url, init) => {
    seen.push({ url, init });
    return url.endsWith("/desktop/state")
      ? reply({ instanceId })
      : reply(answer);
  };
  const ask = (name = "the Send button") =>
    requestRegion(name, { discover: () => service, request });
  assert.deepEqual(await ask(), {
    code: "found",
    match: "element",
    region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
  });
  const post = seen.at(-1);
  assert.equal(post.url, "http://127.0.0.1:4100/desktop/presentation/region");
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.redirect, "error");
  assert.equal(post.init.headers.authorization, `Bearer ${"t".repeat(40)}`);
  assert.deepEqual(JSON.parse(post.init.body), { name: "the Send button" });
  answer = { ...answer, label: "Send" };
  assert.deepEqual(await ask(), { code: "unavailable" });
  answer = {
    version: 1,
    code: "found",
    match: "element",
    region: { x: 0.9, y: 0, w: 0.3, h: 0.1 },
  };
  assert.deepEqual(await ask(), { code: "unavailable" });
  answer = { version: 1, code: "no_match", match: null, region: null };
  assert.deepEqual(await ask(), { code: "no_match" });
  instanceId = "another";
  const before = seen.length;
  assert.deepEqual(await ask(), { code: "unavailable" });
  // A different service instance never gets the name.
  assert.equal(seen.length, before + 1);
  assert.deepEqual(
    await requestRegion("x", { discover: () => null, request }),
    {
      code: "unavailable",
    },
  );
  assert.deepEqual(
    await requestRegion("x".repeat(121), { discover: () => service, request }),
    {
      code: "unavailable",
    },
  );
  assert.deepEqual(
    await requestRegion("x", {
      discover: () => service,
      request: async () => {
        throw Error("refused");
      },
    }),
    { code: "unavailable" },
  );
  assert.equal(
    validRegionAnswer({
      version: 1,
      code: "found",
      match: "app",
      region: { x: 0, y: 0, w: 1, h: 1 },
    }),
    null,
  );
});
