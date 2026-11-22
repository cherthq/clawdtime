import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { screenLayout } from "./layout.mjs";
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

test("manual terminal crop wins over auto and holds through identity changes", () => {
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
  // The view is the person's choice. It does not widen, not even for a frame.
  assert.deepEqual(r.camera.crop(), manual);
  r.at(1800);
  assert.deepEqual(r.camera.crop(), manual);
  assert.equal(r.camera.status().manual, true);
});

test("manual crop holds through transition, Stop and the end of an action; it never releases the overview latch", () => {
  for (const kind of ["transition", "reset", null]) {
    const r = rig(),
      manual = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 };
    r.camera.control("overview");
    r.send(1);
    r.camera.manual(manual);
    r.at(1400);
    assert.deepEqual(r.camera.crop(), manual);
    if (kind) r.send(2, { kind, surface: undefined, target: undefined });
    else r.camera.event(null);
    assert.deepEqual(r.camera.crop(), manual);
    r.at(1800);
    assert.deepEqual(r.camera.crop(), manual);
    // A later action of the agent does not move the person's view either.
    r.send(3);
    r.at(2200);
    assert.deepEqual(r.camera.crop(), manual);
    assert.equal(r.camera.status().overview, true);
    // Only the person ends it. The overview that was latched before is still on.
    r.camera.manual(null);
    r.at(2600);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
    r.send(4);
    r.at(3000);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
    assert.equal(r.camera.status().overview, true);
  }
});

test("a manual crop holds when an action target expires and when the frame has another shape", () => {
  const r = rig(),
    manual = { x: 0.1, y: 0.2, w: 0.8, h: 0.5 };
  r.camera.manual(manual);
  r.send(1);
  r.at(1400);
  assert.deepEqual(r.camera.crop(), manual);
  // The hint of the action runs out without a newer one.
  r.at(2500);
  assert.deepEqual(r.camera.crop(), manual);
  assert.equal(r.camera.status().manual, true);
  r.at(2900);
  assert.deepEqual(r.camera.crop(), manual);
  // A frame of another shape than the screen of the action.
  r.send(2);
  assert.deepEqual(r.camera.crop({ width: 900, height: 1440 }), manual);
  assert.equal(r.camera.status().manual, true);
  r.at(3300);
  assert.deepEqual(r.camera.crop(), manual);
  // Hide and a capture gap reset the camera.
  r.camera.reset();
  assert.equal(r.camera.status().manual, true);
  r.at(3700);
  assert.deepEqual(r.camera.crop(), manual);
  // The person's own commands end it.
  r.camera.control("resume");
  assert.equal(r.camera.status().manual, false);
  r.camera.manual(manual);
  r.camera.control("overview");
  assert.equal(r.camera.status().manual, false);
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

test("latched transition heartbeats finish widening and fresh arrival context cannot restore retired framing", () => {
  const r = rig();
  r.send(1, { kind: "typing" });
  r.at(1400);
  assert.ok(r.camera.crop().w < 1);
  const transition = {
    kind: "transition",
    surface: undefined,
    target: undefined,
  };
  r.send(2, transition);
  r.at(1750);
  r.send(3, transition);
  r.at(1800);
  // A refreshed transition must not restart the 400 ms widening animation.
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  for (let seq = 4; seq <= 12; seq++) {
    r.at(1750 + (seq - 3) * 350);
    r.send(seq, transition);
    assert.deepEqual(r.camera.crop(), OVERVIEW);
  }
  r.at(5300);
  r.send(13, { kind: "context", target: undefined });
  assert.equal(r.camera.event(event(1000, 1, { kind: "typing" })), false);
  r.at(5700);
  assert.deepEqual(r.camera.crop(), OVERVIEW);
  // Ready releases the producer, but only a new action may establish a crop.
  r.send(14, { target: { x: 1100, y: 650, w: 30, h: 30 } });
  r.at(6100);
  assert.ok(r.camera.crop().w < 1);
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

// A screen that is red, with one blue window in its right quarter. The middle
// of the outgoing picture is red for the whole screen, and blue for the window.
const windowView = { x: 0.75, y: 0, w: 0.25, h: 1 };
const twoPartScreen = () => {
  const width = 16,
    height = 10,
    data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data[(y * width + x) * 3 + (x < 12 ? 0 : 2)] = 255;
  return { width, height, data };
};
const middle = (pixels) => {
  const { box } = screenLayout(1280, 720, "wide");
  const i =
    (Math.floor(box.y + box.h / 2) * 1280 + Math.floor(box.x + box.w / 2)) * 4;
  return pixels[i] > 200 ? "screen" : pixels[i + 2] > 200 ? "window" : "other";
};
const sharing = async () => {
  const s = { at: 1000, shot: twoPartScreen(), send: null, captures: 0 };
  s.call = makeCallVideo({
    since: 1000,
    now: () => s.at,
    capture: () => {
      s.captures++;
      return {
        supportsAutomaticZoom: true,
        latest: () => s.shot,
        started: async () => true,
        stop() {},
      };
    },
    presentation: ({ onEvent }) => {
      s.send = onEvent;
      return { stop() {} };
    },
  });
  assert.equal(await s.call.show(), true);
  assert.equal(middle(s.call.frame()), "screen");
  s.call.manual(windowView);
  s.at += 400;
  assert.equal(middle(s.call.frame()), "window");
  return s;
};

test("the one-window view holds when a computer-use action starts, ends or is stopped", async () => {
  const s = await sharing();
  // An action of the agent gives automatic zoom a target.
  s.send(event(s.at));
  assert.equal(middle(s.call.frame()), "window");
  s.at += 400;
  assert.equal(middle(s.call.frame()), "window");
  // The action ends: the presentation source clears its event.
  s.send(null);
  assert.equal(middle(s.call.frame()), "window");
  s.at += 400;
  assert.equal(middle(s.call.frame()), "window");
  // Stop, and a change of app or desktop.
  for (const [sequence, kind] of [
    [2, "reset"],
    [3, "transition"],
  ]) {
    s.send(
      event(s.at, sequence, { kind, surface: undefined, target: undefined }),
    );
    assert.equal(middle(s.call.frame()), "window");
    s.at += 400;
    assert.equal(middle(s.call.frame()), "window");
  }
  // The settings of the call are read again and again. Unchanged, they change nothing.
  s.call.settings({ enabled: true, overview: false });
  assert.equal(middle(s.call.frame()), "window");
  assert.equal(s.call.status().manual, true);
  // The person asks for the whole screen again.
  s.call.manual(null);
  s.at += 400;
  assert.equal(middle(s.call.frame()), "screen");
  assert.equal(s.call.status().manual, false);
  s.call.close();
});

test("the one-window view holds through hide and show, with no frame of the whole screen", async () => {
  const s = await sharing();
  s.call.hide();
  assert.equal(s.call.frame(), null);
  assert.equal(s.call.status().manual, true);
  s.at += 5000;
  assert.equal(await s.call.show(), true);
  assert.equal(s.captures, 2);
  // The first frame after the show is the window already.
  assert.equal(middle(s.call.frame()), "window");
  s.at += 400;
  assert.equal(middle(s.call.frame()), "window");
  // A new view of the person replaces it.
  s.call.manual({ x: 0, y: 0, w: 0.5, h: 1 });
  s.at += 400;
  assert.equal(middle(s.call.frame()), "screen");
  assert.equal(s.call.status().manual, true);
  s.call.close();
});

test("the one-window view holds through a capture gap", async () => {
  const s = await sharing();
  const shot = s.shot;
  // The capture drops a frame that is older than half a second.
  s.shot = null;
  assert.equal(s.call.frame(), null);
  s.at += 600;
  assert.equal(s.call.frame(), null);
  s.shot = shot;
  assert.equal(middle(s.call.frame()), "window");
  s.at += 400;
  assert.equal(middle(s.call.frame()), "window");
  assert.equal(s.call.status().manual, true);
  assert.equal(s.captures, 1);
  s.call.close();
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

test("a relative state folder keeps the zoom preferences in memory and writes nothing", () => {
  const name = `clawdtime-zoom-relative-${process.pid}`;
  const store = makeZoomSettings({ env: { CLAWDTIME_CONFIG_HOME: name } });
  assert.equal(store.durable, false);
  assert.deepEqual(store.read(), { enabled: true, overview: false });
  const set = store.set("overview");
  assert.equal(set.overview, true);
  assert.equal(set.action, "overview");
  assert.match(set.revision, /^[a-f0-9-]{36}$/);
  assert.deepEqual(store.read(), set);
  store.set("disable");
  assert.equal(store.read().enabled, false);
  assert.equal(store.read().overview, true);
  assert.notEqual(store.read().revision, set.revision);
  // The call video takes them as it takes the ones from the file.
  const video = makeCallVideo({ enabled: true, overview: false });
  video.settings(store.read());
  assert.equal(video.status().overview, true);
  assert.equal(video.status().enabled, false);
  store.set("resume");
  video.settings(store.read());
  assert.equal(video.status().overview, false);
  assert.equal(video.status().enabled, true);
  video.close();
  assert.throws(() => store.set("anything"), /Unknown zoom control/);
  // Memory lasts for one store, which is one call. The next one starts from the defaults.
  assert.deepEqual(
    makeZoomSettings({
      env: { CLAWDTIME_CONFIG_HOME: name, CLAWDTIME_LINE_AUTO_ZOOM: "off" },
    }).read(),
    { enabled: false, overview: false },
  );
  assert.equal(existsSync(resolve(name)), false);
  const root = mkdtempSync(join(tmpdir(), "clawdtime-zoom-"));
  try {
    assert.equal(
      makeZoomSettings({ env: { CLAWDTIME_CONFIG_HOME: root } }).durable,
      true,
    );
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
