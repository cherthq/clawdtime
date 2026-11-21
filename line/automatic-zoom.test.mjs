import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
import {
  CAMERA,
  OVERVIEW,
  frameTarget,
  interpolate,
  makeCamera,
  normalizedTarget,
} from "./camera.mjs";
import {
  makeFrameDecoder,
  startContinuousScreen,
  FRAME_MAX_AGE,
  videoFPS,
} from "./continuous-screen.mjs";
import { makeCallVideo } from "./call-video.mjs";
import { makeVideoRenderer, videoTransform } from "./video-transform.mjs";
import { makeZoomSettings, zoomIntent } from "./zoom-settings.mjs";
import { validPresentationEvent } from "./presentation-source.mjs";

const surface = {
  displayId: "1",
  width: 1440,
  height: 900,
  scale: 2,
  appId: "test.fixture",
  windowId: "9",
  window: { x: 0, y: 0, w: 1440, h: 900 },
};
const target = { x: 500, y: 350, w: 24, h: 24 };
const event = (at, sequence = 1, more = {}) => ({
  version: 1,
  producerId: "fixture",
  commandSeq: 10,
  sequence,
  at,
  expiresAt: at + 1400,
  kind: "target",
  reducedMotion: false,
  surface,
  target,
  ...more,
});
const rig = (options = {}) => {
  let now = 1000;
  const camera = makeCamera({ since: 1000, now: () => now, ...options });
  return {
    camera,
    at(value) {
      now = value;
    },
    send(seq, more) {
      return camera.event(event(now, seq, more));
    },
  };
};

test("Swift, service and standalone line share one synthetic v1 wire fixture", () => {
  const wire = JSON.parse(
    readFileSync(
      new URL("../tests/fixtures/call-presentation-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(validPresentationEvent(wire, { now: 1000, since: 1000 }), true);
  const r = rig();
  assert.equal(r.camera.event(wire), true);
  assert.ok(r.camera.crop().w < 1);
});

test("Retina screen points normalize once; interpolation is smooth and bounded", () => {
  assert.deepEqual(
    normalizedTarget(target, surface),
    normalizedTarget(target, { ...surface, scale: 1 }),
  );
  const end = frameTarget(normalizedTarget(target, surface));
  assert.deepEqual(interpolate(OVERVIEW, end, -1), OVERVIEW);
  assert.deepEqual(interpolate(OVERVIEW, end, 2), end);
  for (let i = 0; i <= 100; i++) {
    const crop = interpolate(OVERVIEW, end, i / 100);
    assert.ok(
      crop.x >= 0 &&
        crop.y >= 0 &&
        crop.x + crop.w <= 1.000001 &&
        crop.y + crop.h <= 1.000001,
    );
  }
  assert.ok(interpolate(OVERVIEW, end, 0.01).x < end.x * 0.001);
});

test("click zoom takes 400ms; nearby targets hold; contexts cannot keep old intent forever", () => {
  const r = rig();
  r.send(1);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  r.at(1200);
  const halfway = r.camera.crop();
  assert.ok(halfway.w < 1 && halfway.w > 1 / 1.8);
  r.at(1400);
  const held = r.camera.crop();
  assert.equal(held.w, 1 / 1.8);
  r.at(1500);
  r.send(2, { target: { ...target, x: 520 } });
  r.at(1900);
  assert.deepEqual(r.camera.crop(), held);
  for (let i = 0; i < 6; i++) {
    r.at(2000 + i * 500);
    r.send(3 + i, { kind: "context", target: undefined });
    r.camera.crop();
  }
  r.at(4900);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
});

test("typing renews framing, distant action widens before framing again", () => {
  const r = rig();
  r.send(1, { kind: "typing", target: { x: 0, y: 0, w: 150, h: 30 } });
  for (let i = 2; i < 20; i++) {
    r.at(1000 + i * 350);
    r.send(i, { kind: "typing", target: { x: 0, y: 0, w: 150, h: 30 } });
  }
  const before = r.camera.crop();
  assert.ok(before.w < 1);
  r.at(8000);
  r.send(20, { target: { x: 1410, y: 870, w: 20, h: 20 } });
  r.at(8400);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  r.at(8800);
  const after = r.camera.crop();
  assert.ok(after.x > before.x && after.y > before.y);
});

test("every edge crop contains its target and large fields widen for context", () => {
  for (const x of [0, 0.99])
    for (const y of [0, 0.99]) {
      const t = { x, y, w: 0.01, h: 0.01 },
        c = frameTarget(t);
      assert.ok(
        c.x <= x && c.y <= y && c.x + c.w >= x + t.w && c.y + c.h >= y + t.h,
      );
    }
  assert.equal(frameTarget({ x: 0.01, y: 0.1, w: 0.95, h: 0.3 }).w, 1);
});

test("expiry, missing metadata, wrong aspect, and old calls retire targets", () => {
  for (const invalid of [
    null,
    event(999),
    event(1000, 2, { expiresAt: 9999 }),
    event(1000, 2, { target: { ...target, x: -1 } }),
  ]) {
    const r = rig();
    r.send(1);
    r.at(1400);
    r.camera.crop();
    r.camera.event(invalid);
    r.at(1800);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
  }
  const r = rig();
  r.send(1);
  r.at(1400);
  r.camera.crop();
  r.at(2400);
  r.camera.crop();
  r.at(2800);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  const a = rig();
  a.send(1);
  a.at(1400);
  a.camera.crop({ width: 900, height: 1440 });
  a.at(1800);
  assert.deepEqual(a.camera.crop(), OVERVIEW);
});

test("app/window/geometry identity changes widen and require a new target", () => {
  for (const changed of [
    { appId: "test.other" },
    { windowId: "10" },
    { window: { x: 10, y: 0, w: 1430, h: 900 } },
  ]) {
    const r = rig();
    r.send(1);
    r.at(1400);
    r.camera.crop();
    r.send(2, {
      kind: "context",
      target: undefined,
      surface: { ...surface, ...changed },
    });
    r.at(1800);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
    r.send(3, { surface: { ...surface, ...changed } });
    r.at(2200);
    assert.ok(r.camera.crop().w < 1);
  }
});

test("manual overview survives events, Stop and enable; only resume restores automatic framing", () => {
  const r = rig();
  r.camera.control("overview");
  r.send(1);
  r.at(1400);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  r.camera.reset();
  r.camera.control("enable");
  r.send(2);
  r.at(1800);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  r.camera.control("resume");
  r.send(3);
  r.at(2200);
  assert.ok(r.camera.crop().w < 1);
  r.camera.control("disable");
  r.at(2600);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
});

test("manual terminal crop wins over auto and is retired on identity changes", () => {
  const r = rig(),
    manual = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 };
  r.camera.manual(manual);
  r.send(1);
  r.at(1400);
  assert.deepEqual(r.camera.crop(), manual);
  r.send(2, {
    kind: "context",
    target: undefined,
    surface: { ...surface, windowId: "new" },
  });
  r.at(1800);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
});

test("manual crop retires on explicit transition/Stop; temporary manual view never releases overview latch", () => {
  for (const kind of ["transition", "reset", null]) {
    const r = rig();
    r.camera.control("overview");
    r.send(1);
    r.camera.manual({ x: 0.1, y: 0.2, w: 0.8, h: 0.5 });
    r.at(1400);
    assert.equal(r.camera.crop().w, 0.8);
    if (kind) r.send(2, { kind, surface: undefined, target: undefined });
    else r.camera.event(null);
    r.at(1800);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
    r.send(3);
    r.at(2200);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
    assert.equal(r.camera.status().overview, true);
  }
});

test("repeated source events do not restart animations; reduce motion removes animation", () => {
  const r = rig();
  r.send(1);
  r.at(1200);
  r.send(1);
  r.at(1400);
  assert.equal(r.camera.crop().w, 1 / 1.8);
  const still = rig();
  still.send(1, { reducedMotion: true });
  assert.equal(still.camera.crop().w, 1 / 1.8);
});

test("Fit/Fill letterboxing maps cursor and label through the same Retina crop", () => {
  const crop = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
  for (const layout of ["wide", "upright"]) {
    const t = videoTransform(2880, 1800, 1280, 720, layout, crop);
    const tip = t.point(720 * 2, 450 * 2),
      label = t.point(760 * 2, 450 * 2);
    assert.ok(Math.abs(label.x - tip.x - 80 * t.scale) < 1e-8);
    assert.ok(
      tip.x >= t.destination.x && tip.x <= t.destination.x + t.destination.w,
    );
    if (layout === "upright")
      assert.ok(
        t.destination.x >= 474 && t.destination.x + t.destination.w <= 806,
      );
  }
});

test("rendered cursor pixels, crop, letterbox and RGB input stay aligned", () => {
  const data = new Uint8Array(160 * 100 * 3);
  // A disposable cursor and label painted into the source, as the native overlay is.
  for (let y = 40; y < 45; y++)
    for (let x = 60; x < 90; x++) data[(y * 160 + x) * 3] = 255;
  const original = data.slice(),
    renderer = makeVideoRenderer(320, 180),
    crop = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
  const pixels = renderer.render(
    { data, width: 160, height: 100 },
    crop,
    "wide",
  );
  const t = videoTransform(160, 100, 320, 180, "wide", crop),
    pt = t.point(70, 42);
  assert.ok(pixels[(Math.floor(pt.y) * 320 + Math.floor(pt.x)) * 4] > 240);
  assert.deepEqual(data, original);
  assert.deepEqual([...pixels.slice(0, 4)], [17, 19, 23, 255]);
});

const ppm = (w = 4, h = 2, color = 33) =>
  Buffer.concat([
    Buffer.from(`P6\n${w} ${h}\n255\n`),
    Buffer.alloc(w * h * 3, color),
  ]);
test("framed capture decodes arbitrary chunks/new dimensions and retains only latest", () => {
  const bytes = Buffer.concat([ppm(), ppm(3, 3, 55)]),
    decoder = makeFrameDecoder();
  let latest;
  for (let i = 0; i < bytes.length; i++)
    latest = decoder.push(bytes.subarray(i, i + 1)) ?? latest;
  assert.equal(latest.width, 3);
  assert.equal(latest.height, 3);
  assert.equal(latest.data[0], 55);
  assert.equal(makeFrameDecoder().push(bytes).data[0], 55);
  assert.throws(
    () => makeFrameDecoder().push(Buffer.from("P6\n99999 99999\n255\n")),
    /budget/,
  );
  assert.throws(() => makeFrameDecoder().push(Buffer.alloc(81, 65)), /header/);
});

test("capture never restarts for framing, expires frozen frames and discards all bytes on exit", async () => {
  let at = 1000,
    runs = 0,
    args;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  const capture = startContinuousScreen({
    now: () => at,
    start: (_, a) => {
      runs++;
      args = a;
      return child;
    },
  });
  child.stdout.emit("data", ppm());
  assert.equal(await capture.started(), true);
  assert.equal(capture.supportsAutomaticZoom, true);
  assert.equal(capture.latest().width, 4);
  assert.ok(args.includes("Capture screen 0:none"));
  assert.equal(
    args.some((s) => s.includes("crop=")),
    false,
  );
  at += FRAME_MAX_AGE + 1;
  assert.equal(capture.latest(), null);
  child.stdout.emit("data", ppm());
  assert.ok(capture.latest());
  child.emit("exit", 0);
  assert.equal(capture.latest(), null);
  child.stdout.emit("data", ppm());
  assert.equal(capture.latest(), null);
  capture.stop();
  assert.equal(runs, 1);
});

test("call video keeps one capture for zoom, manual view and layout; Stop/hangup reject delayed events", async () => {
  let at = 1000,
    runs = 0,
    stopped = 0,
    sent,
    sourceStops = 0,
    shot = { width: 16, height: 10, data: new Uint8Array(480), at };
  const call = makeCallVideo({
    since: 1000,
    now: () => at,
    capture: () => {
      runs++;
      return {
        supportsAutomaticZoom: true,
        latest: () => shot,
        started: async () => true,
        stop: () => stopped++,
      };
    },
    presentation: ({ onEvent }) => {
      sent = onEvent;
      return { stop: () => sourceStops++ };
    },
  });
  assert.equal(await call.show(), true);
  sent(event(at));
  at += 400;
  assert.equal(call.frame().length, 1280 * 720 * 4);
  call.layout("upright");
  call.manual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  call.frame();
  assert.equal(runs, 1);
  call.control("overview");
  call.hide();
  sent(event(at, 2));
  assert.equal(call.frame(), null);
  assert.equal(await call.show(), true);
  assert.equal(call.status().overview, true);
  shot = null;
  assert.equal(call.frame(), null);
  call.close();
  assert.equal(await call.show(), false);
  assert.equal(stopped, 2);
  assert.equal(sourceStops, 2);
});

test("display reconfiguration stops capture until explicitly shown; custom devices never consume targets", async () => {
  let emit,
    exits = 0;
  const fake = (supported) => () => ({
    supportsAutomaticZoom: supported,
    latest: () => null,
    started: async () => true,
    stop() {},
  });
  const call = makeCallVideo({
    since: 1000,
    now: () => 1000,
    capture: fake(true),
    onExit: () => exits++,
    presentation: ({ onEvent }) => {
      emit = onEvent;
      return { stop() {} };
    },
  });
  await call.show();
  emit(event(1000));
  emit(event(1000, 2, { surface: { ...surface, displayId: "2" } }));
  assert.equal(exits, 1);
  assert.equal(call.status().sharing, false);
  call.close();
  const custom = makeCallVideo({
    capture: fake(false),
    presentation: () => assert.fail("not the main display"),
  });
  await custom.show();
  custom.close();
});

test("a repeated local overview command retires temporary manual framing even when booleans did not change", () => {
  const video = makeCallVideo({ overview: true, revision: "one" });
  video.manual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  assert.equal(video.status().manual, true);
  video.settings({
    enabled: true,
    overview: true,
    revision: "two",
    action: "overview",
  });
  assert.equal(video.status().manual, false);
  assert.equal(video.status().overview, true);
  video.manual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  video.settings({ enabled: false, overview: true });
  assert.equal(video.status().manual, false);
  video.close();
});

test("overview and enable switches persist independently, and malformed settings fail wide", () => {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-zoom-"));
  try {
    const options = { env: { CLAWDTIME_CONFIG_HOME: root } },
      store = makeZoomSettings(options);
    assert.deepEqual(store.read(), { enabled: true, overview: false });
    store.set("overview");
    store.set("disable");
    store.set("enable");
    assert.equal(makeZoomSettings(options).read().enabled, true);
    assert.equal(makeZoomSettings(options).read().overview, true);
    const before = store.read().revision;
    store.set("overview");
    assert.notEqual(store.read().revision, before);
    store.set("resume");
    assert.equal(store.read().enabled, true);
    assert.equal(store.read().overview, false);
    writeFileSync(join(root, "line-presentation/zoom.json"), "bad");
    assert.deepEqual(store.read(), { enabled: false, overview: true });
    rmSync(join(root, "line-presentation"), { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "line-presentation"));
    assert.throws(() => store.set("resume"), /Private/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit final zoom requests have bounded meanings; negation/questions/content do not control video", () => {
  for (const words of [
    "Show the whole screen.",
    "please show me the entire desktop",
    "zoom out",
  ])
    assert.equal(zoomIntent(words), "overview");
  assert.equal(zoomIntent("resume automatic zoom"), "resume");
  assert.equal(zoomIntent("turn auto zoom on"), "enable");
  assert.equal(zoomIntent("disable automatic zoom"), "disable");
  for (const words of [
    "don't resume automatic zoom",
    "what is automatic zoom?",
    "type show the whole screen",
    "resume automatic zoom, never mind",
    "maybe enable auto zoom",
  ])
    assert.equal(zoomIntent(words), null);
  assert.equal(videoFPS("20"), 20);
  assert.equal(videoFPS("200"), 20);
  assert.equal(videoFPS("10"), 10);
});
