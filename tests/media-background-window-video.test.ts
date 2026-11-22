import { describe, it, expect, vi } from "vitest";
import jpeg from "jpeg-js";
import {
  BackgroundWindowVideo,
  type WindowPreviewRequest,
} from "../media/background-window-video.mjs";
import type { DriverImageResult } from "../media/driver-window-source.mjs";
const binding = {
  callId: "call",
  taskId: "task",
  driverGeneration: "driver",
  processIdentity: "process",
  windowId: "9",
  geometryGeneration: "geometry",
  expiresAt: 10_000,
  pid: 42,
  session: "ClawdTime",
};
const output = { width: 1280, height: 720 };
const jpeg64 = jpeg
  .encode({ data: Buffer.alloc(4 * 4 * 4, 255), width: 4, height: 4 }, 85)
  .data.toString("base64");
const reply = (): DriverImageResult => ({
  isError: false,
  degraded: false,
  structuredJson: JSON.stringify({
    pid: 42,
    window_id: 9,
    screenshot_width: 4,
    screenshot_height: 4,
    window_bounds: { x: 0, y: 0, width: 2, height: 2 },
    screenshot_scale: 2,
    screenshot_frame_valid: true,
    screenshot_mime_type: "image/jpeg",
  }),
  images: [{ mimeType: "image/jpeg", dataBase64: jpeg64 }],
});
function fixture() {
  let now = 100;
  const captureWindow = vi.fn(async (_request: WindowPreviewRequest) =>
    reply(),
  );
  const video = new BackgroundWindowVideo({
    captureWindow,
    verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
    clock: () => now,
    monotonicClock: () => now,
    transitionMs: 0,
  });
  video.bind(binding);
  return {
    video,
    captureWindow,
    setNow: (value: number) => {
      now = value;
    },
  };
}
describe("background window video bridge", () => {
  it("exposes binary original pixels and a small layout only after fixed scoped capture", async () => {
    const f = fixture();
    expect(f.video.latest(output)).toBeNull();
    await f.video.tick();
    const view = f.video.latest(output)!;
    expect(view.rgba.length).toBe(64);
    expect(view.layout.contentRect).toEqual({
      x: 280,
      y: 0,
      width: 720,
      height: 720,
    });
    expect(f.video.isCurrent(view)).toBe(true);
    expect(f.captureWindow.mock.calls[0]![0]).toMatchObject({
      pid: 42,
      window_id: 9,
      display_only: true,
      screenshot_format: "jpeg",
      include_accessibility_tree: false,
    });
    expect(Object.isFrozen(f.captureWindow.mock.calls[0]![0])).toBe(true);
  });
  it("rejects a view that expires during composition and clears stale pixels at consumption", async () => {
    const f = fixture();
    await f.video.tick();
    const queued = f.video.latest(output)!;
    f.setNow(1101);
    expect(f.video.isCurrent(queued)).toBe(false);
    expect(f.video.latest(output)).toBeNull();
    expect(f.video.status()).toBe("stale_frame");
  });
  it("Stop or hangup invalidates pixels and every already-issued response", async () => {
    const f = fixture();
    await f.video.tick();
    const queued = f.video.latest(output)!;
    f.video.revoke();
    expect(f.video.latest(output)).toBeNull();
    expect(f.video.isCurrent(queued)).toBe(false);
    expect(await f.video.tick()).toEqual({ status: "not_authorized" });
  });
  it("overview overrides zoom without changing original input coordinates", async () => {
    const f = fixture();
    await f.video.tick();
    const original = f.video.latest(output)!;
    expect(
      f.video.focus({
        ...binding,
        observationId: original.frameId,
        coordinates: "pixels",
        phase: "action",
        expiresAt: 900,
        bounds: { x: 1, y: 1, width: 1, height: 1 },
        cursor: { x: 1.5, y: 1.5 },
      }),
    ).toBe(true);
    expect(f.video.latest(output)!.layout.crop.width).toBe(2.5);
    expect(f.video.isCurrent(original)).toBe(false);
    f.video.overview();
    expect(f.video.latest(output)!.layout.crop.width).toBe(4);
    expect(f.video.latest(output)!.rgba).toBe(original.rgba);
  });
  it("resize and rebind discard prior targets and require a fresh captured frame", async () => {
    const f = fixture();
    await f.video.tick();
    const queued = f.video.latest(output)!;
    f.video.bind({ ...binding, geometryGeneration: "resized" });
    expect(f.video.latest(output)).toBeNull();
    expect(f.video.isCurrent(queued)).toBe(false);
    await f.video.tick();
    expect(f.video.latest(output)).not.toBeNull();
    f.setNow(500);
    f.captureWindow.mockImplementation(async () => {
      const r = reply();
      const meta = JSON.parse(r.structuredJson!);
      meta.window_bounds.width = 3;
      r.structuredJson = JSON.stringify(meta);
      return r;
    });
    expect(await f.video.tick()).toEqual({ status: "source_changed" });
    expect(f.video.latest(output)).toBeNull();
  });
  it("drops late captures for a previous binding without clearing the replacement", async () => {
    const f = fixture();
    let complete!: (r: DriverImageResult) => void;
    f.captureWindow.mockImplementationOnce(
      () =>
        new Promise((r) => {
          complete = r;
        }),
    );
    const old = f.video.tick();
    await Promise.resolve();
    await Promise.resolve();
    f.video.bind({ ...binding, taskId: "new-task" });
    complete(reply());
    expect(await old).toEqual({ status: "superseded" });
    await f.video.tick();
    expect(f.video.latest(output)).not.toBeNull();
  });
  it("capture failure removes last-good pixels rather than presenting them as live", async () => {
    const f = fixture();
    await f.video.tick();
    const old = f.video.latest(output)!;
    f.setNow(400);
    f.captureWindow.mockRejectedValue(new Error("private contents"));
    expect(await f.video.tick()).toEqual({
      status: "capture_error",
      code: "capture_failed",
    });
    expect(f.video.latest(output)).toBeNull();
    expect(f.video.isCurrent(old)).toBe(false);
  });
  it("a newer frame invalidates queued older output while rate-limited reads keep fresh pixels", async () => {
    const f = fixture();
    await f.video.tick();
    const old = f.video.latest(output)!;
    expect(await f.video.tick()).toEqual({ status: "rate_limited" });
    expect(f.video.isCurrent(old)).toBe(true);
    f.setNow(400);
    await f.video.tick();
    expect(f.video.isCurrent(old)).toBe(false);
  });
  it("rejects a queued action view after its focus expiry even while pixels remain fresh", async () => {
    const f = fixture();
    await f.video.tick();
    const original = f.video.latest(output)!;
    f.video.focus({
      ...binding,
      observationId: original.frameId,
      coordinates: "pixels",
      phase: "action",
      expiresAt: 500,
      bounds: { x: 1, y: 1, width: 1, height: 1 },
      cursor: { x: 1.5, y: 1.5 },
    });
    const queued = f.video.latest(output)!;
    queued.layout.validUntil = 99999; // caller cannot extend the internal deadline
    f.setNow(500);
    expect(f.video.isCurrent(queued)).toBe(false);
    expect(f.video.latest(output)!.layout.crop.width).toBe(4);
  });
  it("retains geometry continuity through a failed capture", async () => {
    const f = fixture();
    await f.video.tick();
    f.setNow(400);
    f.captureWindow.mockRejectedValueOnce(new Error("read failed"));
    await f.video.tick();
    f.setNow(700);
    f.captureWindow.mockImplementationOnce(async () => {
      const r = reply();
      const meta = JSON.parse(r.structuredJson!);
      meta.window_bounds.width = 3;
      r.structuredJson = JSON.stringify(meta);
      return r;
    });
    expect(await f.video.tick()).toEqual({ status: "source_changed" });
    expect(f.video.latest(output)).toBeNull();
  });
});
