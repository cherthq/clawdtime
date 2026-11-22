import { describe, it, expect, vi } from "vitest";
import jpeg from "jpeg-js";
import {
  DriverWindowSource,
  decodeWindowPreview,
  type DriverImageResult,
  type OverlayQualification,
} from "../media/driver-window-source.mjs";
const binding = {
  callId: "call",
  taskId: "task",
  driverGeneration: "driver",
  processIdentity: "pid:start",
  windowId: "9",
  geometryGeneration: "geom",
  expiresAt: 10_000,
  pid: 42,
  session: "ClawdTime-fixture",
};
const encoded = jpeg
  .encode(
    {
      data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]),
      width: 2,
      height: 1,
    },
    85,
  )
  .data.toString("base64");
const meta = {
  pid: 42,
  window_id: 9,
  screenshot_width: 2,
  screenshot_height: 1,
  window_bounds: { x: 10, y: 20, width: 1, height: 0.5 },
  screenshot_scale: 2,
  screenshot_frame_valid: true,
  screenshot_mime_type: "image/jpeg",
};
const response = (change = {}): DriverImageResult => ({
  isError: false,
  degraded: false,
  structuredJson: JSON.stringify({ ...meta, ...change }),
  images: [{ mimeType: "image/jpeg", dataBase64: encoded }],
});
function fixture() {
  let now = 100;
  const callTool = vi.fn(async (_name: string, _args: string) => response());
  const verifyBinding = vi.fn(() => ({ valid: true, onCurrentSpace: true }));
  const source = new DriverWindowSource({
    callTool,
    verifyBinding,
    clock: () => now,
  });
  source.bind(binding);
  return {
    source,
    callTool,
    verifyBinding,
    setNow: (n: number) => {
      now = n;
    },
  };
}
describe("bounded driver window preview", () => {
  it("decodes exact target JPEG to RGBA without inventing overlay evidence", () => {
    const d = decodeWindowPreview(response(), binding);
    expect(d.width).toBe(2);
    expect(d.rgba.length).toBe(8);
    expect(d.overlay).toBe("unknown");
    expect(d.windowWidth).toBe(1);
  });
  it("refuses wrong target, invalid geometry, oversized frame and off-Space backing store", () => {
    for (const change of [
      { pid: 43 },
      { window_id: 10 },
      { screenshot_width: 8000, screenshot_height: 8000 },
      { screenshot_frame_valid: false },
      { screenshot_scale: 0 },
      { screenshot_error: {} },
      { on_current_space: false },
      { degraded: true },
      { screenshot_width: 3 },
    ])
      expect(() => decodeWindowPreview(response(change), binding)).toThrow();
  });
  it("refuses corrupt/extra/non-JPEG image data and malformed metadata", () => {
    for (const r of [
      { ...response(), isError: true },
      { ...response(), structuredJson: "{" },
      { ...response(), images: [] },
      { ...response(), images: [...response().images, ...response().images] },
      {
        ...response(),
        images: [{ mimeType: "image/png", dataBase64: encoded }],
      },
      {
        ...response(),
        images: [{ mimeType: "image/jpeg", dataBase64: "not base64" }],
      },
      {
        ...response(),
        images: [{ mimeType: "image/jpeg", dataBase64: "/9j/AA==" }],
      },
    ])
      expect(() => decodeWindowPreview(r, binding)).toThrow();
  });
  it("uses display-only read without mutating the planner snapshot and stamps host time", async () => {
    const f = fixture();
    const r = await f.source.next();
    expect(r.status).toBe("frame");
    expect(r.status === "frame" && r.frame.capturedAt).toBe(100);
    expect(f.verifyBinding).toHaveBeenCalledTimes(2);
    const args = JSON.parse(f.callTool.mock.calls[0]![1] as string);
    expect(args).toMatchObject({
      session: binding.session,
      pid: 42,
      window_id: 9,
      display_only: true,
      include_accessibility_tree: false,
      include_screenshot: true,
      screenshot_format: "jpeg",
      max_dimension: 1280,
    });
    expect(args).not.toHaveProperty("screenshot_out_file");
    expect(await f.source.next()).toEqual({ status: "rate_limited" });
  });
  it("suppresses capture after expiry or failed identity verification", async () => {
    const f = fixture();
    f.setNow(10_000);
    expect(await f.source.next()).toEqual({ status: "not_authorized" });
    expect(f.callTool).not.toHaveBeenCalled();
    const g = fixture();
    g.verifyBinding.mockReturnValue({ valid: false, onCurrentSpace: false });
    expect(await g.source.next()).toEqual({ status: "target_unavailable" });
    expect(g.callTool).not.toHaveBeenCalled();
  });
  it("drops a late frame after Stop/rebind and never queues a second capture", async () => {
    let release!: (r: DriverImageResult) => void;
    const callTool = vi.fn(
      () =>
        new Promise<DriverImageResult>((r) => {
          release = r;
        }),
    );
    const source = new DriverWindowSource({
      callTool,
      verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
      clock: () => 100,
    });
    source.bind(binding);
    const first = source.next();
    await Promise.resolve();
    expect(await source.next()).toEqual({ status: "capture_in_progress" });
    source.revoke();
    source.bind({ ...binding, driverGeneration: "new" });
    release(response());
    expect(await first).toEqual({ status: "target_unavailable" });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it("reports slow/error captures without stale last-good fallback or raw error leakage", async () => {
    const f = fixture();
    f.callTool.mockImplementation(async () => {
      f.setNow(1500);
      return response();
    });
    expect(await f.source.next()).toEqual({ status: "stale_capture" });
    f.setNow(2000);
    f.callTool.mockRejectedValue(new Error("sensitive window contents"));
    expect(await f.source.next()).toEqual({
      status: "capture_error",
      code: "capture_failed",
    });
  });
  it("caps rate and permits a fresh stream frame after the interval", async () => {
    expect(
      () =>
        new DriverWindowSource({
          callTool: async () => response(),
          verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
          fps: 20,
        }),
    ).toThrow();
    const f = fixture();
    const first = await f.source.next();
    f.setNow(350);
    const second = await f.source.next();
    expect(
      first.status === "frame" &&
        second.status === "frame" &&
        first.frame.id !== second.frame.id,
    ).toBe(true);
  });
  it("defaults to epoch frame timestamps and requires positive current-Space witness", async () => {
    const source = new DriverWindowSource({
      callTool: async () => response(),
      verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
    });
    const before = Date.now();
    source.bind({ ...binding, expiresAt: before + 1000 });
    const r = await source.next();
    expect(r.status === "frame" && r.frame.capturedAt >= before).toBe(true);
    const f = fixture();
    f.verifyBinding.mockReturnValue({ valid: true, onCurrentSpace: false });
    expect(await f.source.next()).toEqual({ status: "target_unavailable" });
    expect(f.callTool).not.toHaveBeenCalled();
  });
  it("bounds hung reads and keeps the pending transport fenced until it settles", async () => {
    let finish!: (r: DriverImageResult) => void;
    const source = new DriverWindowSource({
      callTool: () =>
        new Promise((r) => {
          finish = r;
        }),
      verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
      clock: () => 100,
      maxFrameAgeMs: 50,
    });
    source.bind(binding);
    expect(await source.next()).toEqual({ status: "capture_timeout" });
    source.bind({ ...binding, driverGeneration: "new" });
    expect(await source.next()).toEqual({ status: "capture_in_progress" });
    finish(response());
  });
  it("an old capture timer cannot revoke a replacement target binding", async () => {
    let finish!: (r: DriverImageResult) => void;
    let calls = 0;
    const source = new DriverWindowSource({
      callTool: async () => {
        calls++;
        if (calls === 1)
          return new Promise((r) => {
            finish = r;
          });
        return response();
      },
      verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
      clock: () => 100,
      maxFrameAgeMs: 50,
    });
    source.bind(binding);
    const old = source.next();
    await Promise.resolve();
    await Promise.resolve();
    source.bind({ ...binding, driverGeneration: "replacement" });
    expect(await old).toEqual({ status: "capture_timeout" });
    finish(response());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const current = await source.next();
    expect(current.status).toBe("frame");
    expect(current.status === "frame" && current.frame.driverGeneration).toBe(
      "replacement",
    );
  });
  it("requires trusted pinned release evidence and the current generation before overlay exclusion", async () => {
    const qualification: OverlayQualification = {
      driverVersion: "0.55.0",
      artifactSha256:
        "faf11948f8f9b410a76750e65ae14cb1d95cc321aa61fc158f70de8a68c270b1",
      driverGeneration: binding.driverGeneration,
      osBuild: "synthetic-os-build",
      capturePipeline: "get_window_state/jpeg/display_only",
      qualificationId: "synthetic-evidence-only",
      result: "excluded",
      qualifiedAt: 0,
      expiresAt: 2000,
    };
    let now = 100;
    const source = new DriverWindowSource({
      callTool: async () =>
        response({ agent_overlay_capture: { excluded: true } }),
      verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
      clock: () => now,
      overlayQualification: qualification,
    });
    source.bind(binding);
    let r = await source.next();
    expect(r.status === "frame" && r.frame.overlay).toBe("excluded");
    qualification.expiresAt = 99999; // caller mutation cannot extend evidence
    now = 1000;
    r = await source.next();
    expect(r.status === "frame" && r.frame.overlay).toBe("unknown");
    now = 100;
    source.bind({ ...binding, driverGeneration: "replacement-driver" });
    r = await source.next();
    expect(r.status === "frame" && r.frame.overlay).toBe("unknown");
    expect(
      () =>
        new DriverWindowSource({
          callTool: async () => response(),
          verifyBinding: () => ({ valid: true, onCurrentSpace: true }),
          overlayQualification: {
            ...qualification,
            driverVersion: "unqualified",
          } as unknown as OverlayQualification,
        }),
    ).toThrow("Invalid overlay qualification");
    expect(
      decodeWindowPreview(
        response({ agent_overlay_capture: { excluded: true } }),
        binding,
      ).overlay,
    ).toBe("unknown");
  });
});
