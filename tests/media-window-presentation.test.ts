import { describe, it, expect } from "vitest";
import {
  WindowPresentation,
  type WorkFrame,
  type WorkAction,
} from "../media/window-presentation.mjs";
const binding = {
  callId: "call",
  taskId: "task",
  driverGeneration: "driver-1",
  processIdentity: "pid:start",
  windowId: "21",
  geometryGeneration: "geometry-1",
  expiresAt: 10_000,
};
const frame: WorkFrame = {
  ...binding,
  id: "frame-1",
  capturedAt: 100,
  pixelWidth: 1600,
  pixelHeight: 1200,
  windowWidth: 800,
  windowHeight: 600,
  overlay: "excluded",
};
const action: WorkAction = {
  ...binding,
  observationId: frame.id,
  coordinates: "points",
  phase: "action",
  expiresAt: 900,
  bounds: { x: 350, y: 250, width: 100, height: 100 },
  cursor: { x: 400, y: 300 },
};
const output = { width: 1280, height: 720 };
function setup() {
  const p = new WindowPresentation({ zoom: 2 });
  p.bind(binding);
  expect(p.observe(frame, 100)).toBe(true);
  return p;
}
describe("window video presentation", () => {
  it("maps Retina window points through crop and letterbox without changing observations", () => {
    const p = setup();
    const original = structuredClone(frame);
    expect(p.focus(action, 100)).toBe(true);
    const before = p.layout(100, output),
      halfway = p.layout(300, output),
      after = p.layout(500, output);
    expect(before.visible && before.crop.width).toBe(1600);
    expect(halfway.visible && halfway.crop.width).toBe(1200);
    expect(after.visible && after.crop).toEqual({
      x: 400,
      y: 300,
      width: 800,
      height: 600,
    });
    expect(after.visible && after.contentRect).toEqual({
      x: 160,
      y: 0,
      width: 960,
      height: 720,
    });
    expect(after.cursor).toEqual({ x: 640, y: 360, label: "ClawdTime" });
    expect(frame).toEqual(original);
  });
  it("holds typing crop across fresh observations and permits overview override", () => {
    const p = setup();
    p.focus({ ...action, phase: "typing" }, 100);
    const settled = p.layout(500, output);
    p.observe({ ...frame, id: "frame-2", capturedAt: 510 }, 510);
    p.focus(
      {
        ...action,
        observationId: "frame-2",
        phase: "typing",
        bounds: action.bounds,
      },
      510,
    );
    const held = p.layout(600, output);
    expect(held.visible && held.crop).toEqual(settled.visible && settled.crop);
    p.overview(true, 600);
    const overview = p.layout(1000, output);
    expect(overview.visible && overview.crop.width).toBe(1600);
  });
  it("reframes when typing moves to a different field and retires rejected focus", () => {
    const p = setup();
    p.focus({ ...action, phase: "typing" }, 100);
    p.observe({ ...frame, id: "frame-2", capturedAt: 500 }, 500);
    p.focus(
      {
        ...action,
        phase: "typing",
        observationId: "frame-2",
        expiresAt: 1400,
        bounds: { x: 10, y: 10, width: 10, height: 10 },
        cursor: { x: 15, y: 15 },
      },
      500,
    );
    const view = p.layout(900, output);
    expect(view.visible && view.crop.x).toBe(0);
    expect(view.cursor).not.toBeNull();
    expect(p.focus({ ...action, driverGeneration: "old" }, 900)).toBe(false);
    expect(p.layout(900, output).cursor).toBeNull();
  });
  it("requires exact fresh observation and rejects other targets before framing", () => {
    const p = setup();
    for (const change of [
      { observationId: "old" },
      { windowId: "other" },
      { driverGeneration: "restarted" },
      { processIdentity: "reused-pid" },
      { coordinates: "desktop" },
      { bounds: { x: -1, y: 0, width: 5, height: 5 } },
      { cursor: { x: NaN, y: 0 } },
      { expiresAt: 20_000 },
    ])
      expect(p.focus({ ...action, ...change } as WorkAction, 100)).toBe(false);
    expect(p.layout(100, output).cursor).toBeNull();
  });
  it("retires authority on window recreation, process change, display or size change", () => {
    for (const change of [
      { windowId: "22" },
      { geometryGeneration: "geometry-2" },
      { driverGeneration: "driver-2" },
      { processIdentity: "pid:new-start" },
      { pixelWidth: 1700 },
    ]) {
      const p = setup();
      p.focus(action, 100);
      expect(
        p.observe({ ...frame, ...change, id: "frame-2", capturedAt: 150 }, 150),
      ).toBe(false);
      expect(p.layout(150, output).visible).toBe(false);
      expect(p.observe({ ...frame, id: "frame-3", capturedAt: 160 }, 160)).toBe(
        false,
      );
    }
  });
  it("hides stale and future frames; fresh capture can recover without old cursor", () => {
    const p = setup();
    p.focus(action, 100);
    expect(p.layout(1101, output)).toMatchObject({
      visible: false,
      cursor: null,
    });
    expect(p.observe({ ...frame, id: "new", capturedAt: 1200 }, 1200)).toBe(
      true,
    );
    expect(p.layout(1200, output).cursor).toBeNull();
    expect(p.observe({ ...frame, id: "future", capturedAt: 1500 }, 1400)).toBe(
      false,
    );
  });
  it("cannot hide a resize or replay behind a stale-frame gap", () => {
    const p = setup();
    p.layout(1101, output);
    expect(
      p.observe(
        { ...frame, id: "resized", capturedAt: 1200, pixelWidth: 1800 },
        1200,
      ),
    ).toBe(false);
    expect(p.layout(1200, output).visible).toBe(false);
    const q = setup();
    q.observe({ ...frame, id: "later", capturedAt: 500 }, 500);
    q.layout(1600, output);
    expect(q.observe({ ...frame, id: "earlier", capturedAt: 400 }, 1000)).toBe(
      false,
    );
  });
  it("does not draw a duplicate cursor or assume unqualified capture excludes it", () => {
    for (const overlay of ["included", "unknown"] as const) {
      const p = new WindowPresentation();
      p.bind(binding);
      p.observe({ ...frame, overlay }, 100);
      p.focus(action, 100);
      expect(p.layout(500, output).cursor).toBeNull();
    }
  });
  it("retires cursor on completion, action timeout, Stop/hangup, and lease expiry", () => {
    const p = setup();
    p.focus(action, 100);
    p.complete(200);
    expect(p.layout(300, output).cursor).toBeNull();
    p.focus(action, 300);
    expect(p.layout(900, output).cursor).toBeNull();
    p.revoke();
    expect(p.layout(901, output)).toMatchObject({
      visible: false,
      cursor: null,
    });
    p.bind({ ...binding, expiresAt: 500 });
    p.observe(frame, 100);
    p.focus({ ...action, expiresAt: 450 }, 100);
    expect(p.layout(500, output)).toMatchObject({
      visible: false,
      reason: "authority_expired",
      cursor: null,
    });
  });
  it("handles source edges and nonuniform point scaling without exposing off-window pixels", () => {
    const p = new WindowPresentation({ zoom: 2, transitionMs: 0 });
    p.bind(binding);
    p.observe({ ...frame, pixelHeight: 900 }, 100);
    p.focus(
      {
        ...action,
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        cursor: { x: 5, y: 5 },
      },
      100,
    );
    const result = p.layout(100, output);
    expect(result.visible && result.crop).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 450,
    });
    expect(result.cursor).toEqual({ x: 16, y: 12, label: "ClawdTime" });
  });
  it("rejects invalid configuration and video dimensions", () => {
    expect(() => new WindowPresentation({ zoom: 3 })).toThrow();
    expect(() => new WindowPresentation({ transitionMs: NaN })).toThrow();
    expect(() => setup().layout(100, { width: 0, height: 720 })).toThrow();
  });
});
