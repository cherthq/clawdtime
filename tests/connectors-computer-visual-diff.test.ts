import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { closerOutOfDate, closerScene } from "../connectors/computer/closer.js";
import {
  normalizeDynamicTitle,
  sameSurface,
  sameWindowTitle,
} from "../connectors/computer/desktop.js";
import {
  compareGrids,
  decodeLuminanceGrid,
  DIFF_GRID_H,
  DIFF_GRID_W,
  DIFF_LUMA_THRESHOLD,
  DIFF_MIN_CELLS,
  luminanceGridOf,
  visuallyChanged,
} from "../connectors/computer/visual-diff.js";
import { observation } from "./connectors-computer-fixture.js";

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  g: number;
  b: number;
};

/** Renders a solid RGBA frame with optional painted rectangles and encodes as base64 JPEG. */
function makeJpeg(
  width = 320,
  height = 180,
  options: {
    bg?: [number, number, number];
    rects?: Rect[];
    quality?: number;
  } = {},
): string {
  const [br, bg, bb] = options.bg ?? [220, 220, 220];
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    data[off] = br;
    data[off + 1] = bg;
    data[off + 2] = bb;
    data[off + 3] = 255;
  }
  for (const rect of options.rects ?? []) {
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const off = (y * width + x) * 4;
        data[off] = rect.r;
        data[off + 1] = rect.g;
        data[off + 2] = rect.b;
        data[off + 3] = 255;
      }
    }
  }
  const encoded = jpeg.encode({ data, width, height }, options.quality ?? 85);
  return encoded.data.toString("base64");
}

describe("perceptual visual diff (jpeg-js)", () => {
  it("decodes a real JPEG into a 64x36 luminance grid and sees identical frames as unchanged", () => {
    const img = makeJpeg(320, 180, {
      rects: [{ x: 40, y: 60, w: 80, h: 40, r: 40, g: 80, b: 180 }],
    });
    const gridA = decodeLuminanceGrid(img);
    const gridB = decodeLuminanceGrid(img);
    expect(gridA).not.toBeNull();
    expect(gridA!.width).toBe(DIFF_GRID_W);
    expect(gridA!.height).toBe(DIFF_GRID_H);
    expect(gridA!.cells.length).toBe(DIFF_GRID_W * DIFF_GRID_H);
    expect(gridA!.digest).toBe(gridB!.digest);

    const diff = compareGrids(gridA, gridB, {
      screen: { width: 1440, height: 900 },
    });
    expect(diff.comparable).toBe(true);
    expect(diff.changed).toBe(false);
    expect(diff.changedCells).toBe(0);
    expect(diff.maxDelta).toBe(0);
    expect(diff.ratio).toBe(0);
  });

  it("ignores JPEG re-encoding quality differences on the same frame", () => {
    const rects: Rect[] = [
      { x: 20, y: 40, w: 120, h: 60, r: 35, g: 95, b: 175 },
      { x: 180, y: 90, w: 90, h: 50, r: 240, g: 180, b: 50 },
    ];
    const highQ = decodeLuminanceGrid(
      makeJpeg(320, 180, { rects, quality: 92 }),
    );
    const lowQ = decodeLuminanceGrid(
      makeJpeg(320, 180, { rects, quality: 50 }),
    );
    expect(highQ).not.toBeNull();
    expect(lowQ).not.toBeNull();
    const diff = compareGrids(highQ, lowQ, {
      screen: { width: 1440, height: 900 },
    });
    expect(diff.comparable).toBe(true);
    expect(diff.changed).toBe(false);
  });

  it("ignores top-right row-0 menu-bar clock ticks while detecting top-left window tab changes", () => {
    const baseClock = makeJpeg(320, 180, {
      rects: [{ x: 260, y: 0, w: 55, h: 5, r: 10, g: 10, b: 10 }],
    });
    const tickedClock = makeJpeg(320, 180, {
      rects: [{ x: 260, y: 0, w: 55, h: 5, r: 250, g: 250, b: 250 }],
    });
    expect(baseClock).not.toBe(tickedClock);
    const gridA = decodeLuminanceGrid(baseClock);
    const gridB = decodeLuminanceGrid(tickedClock);
    expect(gridA).not.toBeNull();
    expect(gridB).not.toBeNull();
    expect(gridA!.digest).toBe(gridB!.digest);
    const clockDiff = compareGrids(gridA, gridB, {
      screen: { width: 1440, height: 900 },
    });
    expect(clockDiff.comparable).toBe(true);
    expect(clockDiff.changed).toBe(false);
    expect(clockDiff.changedCells).toBe(0);

    // Top-left window tab / title-bar change in row 0..1 MUST be detected in both digest and compareGrids.
    const tabChanged = makeJpeg(320, 180, {
      rects: [
        { x: 260, y: 0, w: 55, h: 5, r: 10, g: 10, b: 10 },
        { x: 10, y: 0, w: 60, h: 8, r: 20, g: 20, b: 20 },
      ],
    });
    const gridTab = decodeLuminanceGrid(tabChanged);
    expect(gridTab).not.toBeNull();
    expect(gridTab!.digest).not.toBe(gridA!.digest);
    const tabDiff = compareGrids(gridA, gridTab, {
      screen: { width: 1440, height: 900 },
    });
    expect(tabDiff.comparable).toBe(true);
    expect(tabDiff.changed).toBe(true);
    expect(tabDiff.changedCells).toBeGreaterThanOrEqual(DIFF_MIN_CELLS);
  });

  it("ignores pointer movement when maskCursor is default, and detects changes under the cursor when maskCursor is false", () => {
    // 320x180 image mapped onto 1440x900 screen:
    // cursorA at screen (270, 350) -> image (60, 70)
    // cursorB at screen (1080, 650) -> image (240, 130)
    const frameA = makeJpeg(320, 180, {
      rects: [{ x: 56, y: 66, w: 10, h: 10, r: 0, g: 0, b: 0 }],
    });
    const frameB = makeJpeg(320, 180, {
      rects: [{ x: 236, y: 126, w: 10, h: 10, r: 0, g: 0, b: 0 }],
    });
    const gridA = decodeLuminanceGrid(frameA);
    const gridB = decodeLuminanceGrid(frameB);

    const masked = compareGrids(gridA, gridB, {
      cursorA: { x: 270, y: 350 },
      cursorB: { x: 1080, y: 650 },
      screen: { width: 1440, height: 900 },
    });
    expect(masked.comparable).toBe(true);
    expect(masked.changed).toBe(false);
    expect(masked.changedCells).toBe(0);

    // With maskCursor: false, changes directly under the cursor are detected.
    const unmasked = compareGrids(gridA, gridB, {
      cursorA: { x: 270, y: 350 },
      cursorB: { x: 1080, y: 650 },
      screen: { width: 1440, height: 900 },
      maskCursor: false,
    });
    expect(unmasked.comparable).toBe(true);
    expect(unmasked.changed).toBe(true);
    expect(unmasked.changedCells).toBeGreaterThanOrEqual(DIFF_MIN_CELLS);
  });

  it("detects even a small single-cell change inside focusRect with zero cursor mask", () => {
    // Button at screen (110, 200, 80x24) -> image (24..42, 40..45) on 320x180.
    const before = makeJpeg(320, 180, {
      rects: [{ x: 24, y: 40, w: 18, h: 5, r: 220, g: 220, b: 220 }],
    });
    const after = makeJpeg(320, 180, {
      rects: [{ x: 28, y: 40, w: 8, h: 5, r: 20, g: 20, b: 20 }],
    });
    const gridA = decodeLuminanceGrid(before);
    const gridB = decodeLuminanceGrid(after);
    const diff = compareGrids(gridA, gridB, {
      cursorA: { x: 150, y: 212 },
      cursorB: { x: 150, y: 212 },
      screen: { width: 1440, height: 900 },
      maskCursor: false,
      focusRect: { x: 110, y: 200, w: 80, h: 24 },
    });
    expect(diff.comparable).toBe(true);
    expect(diff.changed).toBe(true);
    expect(diff.changedCells).toBeGreaterThanOrEqual(1);
  });

  it("detects a tiny 20x14px switch toggle on a 1280x831 canvas with minCells: 1 while still ignoring JPEG quality re-encoding noise", () => {
    const offRects: Rect[] = [
      { x: 400, y: 300, w: 20, h: 14, r: 190, g: 190, b: 190 },
    ];
    const onRects: Rect[] = [
      { x: 400, y: 300, w: 20, h: 14, r: 30, g: 140, b: 60 },
    ];
    const beforeImg = makeJpeg(1280, 831, {
      bg: [245, 245, 245],
      rects: offRects,
      quality: 85,
    });
    const afterImg = makeJpeg(1280, 831, {
      bg: [245, 245, 245],
      rects: onRects,
      quality: 85,
    });
    const beforeGrid = decodeLuminanceGrid(beforeImg);
    const afterGrid = decodeLuminanceGrid(afterImg);
    expect(beforeGrid).not.toBeNull();
    expect(afterGrid).not.toBeNull();

    // Default minCells (4) treats the tiny switch toggle as unchanged.
    const defaultDiff = compareGrids(beforeGrid, afterGrid, {
      screen: { width: 1280, height: 831 },
      maskCursor: false,
    });
    expect(defaultDiff.comparable).toBe(true);
    expect(defaultDiff.changedCells).toBeGreaterThanOrEqual(1);
    expect(defaultDiff.changedCells).toBeLessThan(DIFF_MIN_CELLS);
    expect(defaultDiff.changed).toBe(false);

    // minCells: 1 detects the tiny switch toggle even directly under the cursor.
    const strictDiff = compareGrids(beforeGrid, afterGrid, {
      cursorA: { x: 410, y: 307 },
      cursorB: { x: 410, y: 307 },
      screen: { width: 1280, height: 831 },
      maskCursor: false,
      minCells: 1,
    });
    expect(strictDiff.comparable).toBe(true);
    expect(strictDiff.changed).toBe(true);
    expect(strictDiff.changedCells).toBeGreaterThanOrEqual(1);

    const obsBefore = observation([], {
      image: beforeImg,
      imageWidth: 1280,
      imageHeight: 831,
      screen: { width: 1280, height: 831, scale: 1 },
      cursor: { x: 410, y: 307 },
    });
    const obsAfter = observation([], {
      image: afterImg,
      imageWidth: 1280,
      imageHeight: 831,
      screen: { width: 1280, height: 831, scale: 1 },
      cursor: { x: 410, y: 307 },
    });
    expect(
      visuallyChanged(obsBefore, obsAfter, { maskCursor: false, minCells: 1 }),
    ).toBe(true);

    // Re-encoding the identical frame at a different JPEG quality stays unchanged even with minCells: 1.
    const reencodedImg = makeJpeg(1280, 831, {
      bg: [245, 245, 245],
      rects: onRects,
      quality: 50,
    });
    const reencodedGrid = decodeLuminanceGrid(reencodedImg);
    expect(reencodedGrid).not.toBeNull();
    const reencodedDiff = compareGrids(afterGrid, reencodedGrid, {
      screen: { width: 1280, height: 831 },
      maskCursor: false,
      minCells: 1,
    });
    expect(reencodedDiff.comparable).toBe(true);
    expect(reencodedDiff.changed).toBe(false);
    expect(reencodedDiff.changedCells).toBe(0);

    const obsReencoded = observation([], {
      image: reencodedImg,
      imageWidth: 1280,
      imageHeight: 831,
      screen: { width: 1280, height: 831, scale: 1 },
      cursor: { x: 410, y: 307 },
    });
    expect(
      visuallyChanged(obsAfter, obsReencoded, {
        maskCursor: false,
        minCells: 1,
      }),
    ).toBe(false);
  });

  it("decodes 1600x1600 (2.56 MP) closer crops with maxResolutionInMP raised to 4", () => {
    const crop = makeJpeg(1600, 1600, { quality: 75 });
    const grid = decodeLuminanceGrid(crop);
    expect(grid).not.toBeNull();
    expect(grid!.width).toBe(DIFF_GRID_W);
    expect(grid!.height).toBe(DIFF_GRID_H);
  });

  it("detects real UI changes outside menu bar and cursor footprints", () => {
    const before = makeJpeg(320, 180);
    const after = makeJpeg(320, 180, {
      rects: [{ x: 100, y: 70, w: 60, h: 40, r: 20, g: 20, b: 20 }],
    });
    const obsA = observation([], {
      image: before,
      imageWidth: 320,
      imageHeight: 180,
      cursor: { x: 10, y: 10 },
    });
    const obsB = observation([], {
      image: after,
      imageWidth: 320,
      imageHeight: 180,
      cursor: { x: 10, y: 10 },
    });
    const diff = compareGrids(luminanceGridOf(obsA), luminanceGridOf(obsB), {
      cursorA: obsA.cursor,
      cursorB: obsB.cursor,
      screen: obsB.screen,
    });
    expect(diff.comparable).toBe(true);
    expect(diff.changed).toBe(true);
    expect(diff.changedCells).toBeGreaterThanOrEqual(DIFF_MIN_CELLS);
    expect(diff.maxDelta).toBeGreaterThan(DIFF_LUMA_THRESHOLD);
    expect(visuallyChanged(obsA, obsB)).toBe(true);
  });

  it("safely returns null for dummy, empty, oversized, or corrupt inputs", () => {
    expect(decodeLuminanceGrid("")).toBeNull();
    expect(decodeLuminanceGrid("aW1hZ2U=")).toBeNull();
    expect(decodeLuminanceGrid("not-a-jpeg")).toBeNull();
    expect(decodeLuminanceGrid("/9j/" + "A".repeat(4_000_001))).toBeNull();
    expect(decodeLuminanceGrid("/9j/corrupt!!!")).toBeNull();

    const dummyA = observation([], { image: "aW1hZ2U=" });
    const dummyB = observation([], { image: "b3RoZXI=" });
    expect(luminanceGridOf(dummyA)).toBeNull();
    expect(visuallyChanged(dummyA, dummyB)).toBeNull();
    expect(compareGrids(null, null)).toEqual({
      comparable: false,
      changed: false,
      changedCells: 0,
      totalCells: 0,
      ratio: 0,
      maxDelta: 0,
    });
  });

  it("memoizes luminanceGridOf per Observation via WeakMap", () => {
    const obs = observation([], {
      image: makeJpeg(160, 90),
      imageWidth: 160,
      imageHeight: 90,
    });
    const first = luminanceGridOf(obs);
    const second = luminanceGridOf(obs);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });
});

describe("resilient dynamic window-title normalization", () => {
  it("strips unread counts, dirty bullets, elapsed timers, download percentages, and tab counts", () => {
    expect(normalizeDynamicTitle("(3) Inbox - Mail")).toBe("Inbox - Mail");
    expect(normalizeDynamicTitle("[12+] Slack - #general")).toBe(
      "Slack - #general",
    );
    expect(normalizeDynamicTitle("• notes.md")).toBe("notes.md");
    expect(normalizeDynamicTitle("FaceTime 04:12")).toBe("FaceTime");
    expect(normalizeDynamicTitle("FaceTime - 01:04:12")).toBe("FaceTime");
    expect(normalizeDynamicTitle("Safari - Downloading 45%")).toBe(
      "Safari - Downloading",
    );
    expect(normalizeDynamicTitle("Google Chrome - 4 tabs")).toBe(
      "Google Chrome",
    );
  });

  it("never collapses a dynamic-only title to an empty string", () => {
    expect(normalizeDynamicTitle("(3)")).toBe("(3)");
    expect(normalizeDynamicTitle("04:12")).toBe("04:12");
    expect(normalizeDynamicTitle("45%")).toBe("45%");
    expect(sameWindowTitle("(3)", "(4)")).toBe(false);
    expect(sameWindowTitle("04:12", "04:13")).toBe(false);
  });

  it("matches dynamic updates of the same window and rejects genuinely different windows", () => {
    expect(sameWindowTitle("(3) Inbox - Mail", "(4) Inbox - Mail")).toBe(true);
    expect(sameWindowTitle("Inbox (3) - Gmail", "Inbox (4) - Gmail")).toBe(
      true,
    );
    expect(sameWindowTitle("• notes.md", "notes.md")).toBe(true);
    expect(sameWindowTitle("FaceTime 04:12", "FaceTime 04:13")).toBe(true);
    expect(
      sameWindowTitle("Call (04:12) - FaceTime", "Call (04:13) - FaceTime"),
    ).toBe(true);
    expect(
      sameWindowTitle("Call - 04:12 - FaceTime", "Call - 04:13 - FaceTime"),
    ).toBe(true);
    expect(
      sameWindowTitle("Google Chrome - 4 tabs", "Google Chrome - 5 tabs"),
    ).toBe(true);
    expect(sameWindowTitle("Downloads 45%", "Downloads 98%")).toBe(true);
    expect(sameWindowTitle("", "")).toBe(true);
    expect(sameWindowTitle("Inbox - Mail", "Compose - Mail")).toBe(false);
    expect(sameWindowTitle("", "Inbox")).toBe(false);
    // File copy suffixes before extensions and mid-title times must NOT be stripped.
    expect(sameWindowTitle("Report (1).pdf", "Report (2).pdf")).toBe(false);
    expect(sameWindowTitle("notes [1].txt", "notes [2].txt")).toBe(false);
    expect(
      sameWindowTitle("Report 10:00 Summary", "Report 11:00 Summary"),
    ).toBe(false);
  });

  it("keeps sameSurface and closerOutOfDate stable across dynamic window-title updates", () => {
    const before = observation([], {
      app: {
        name: "Mail",
        bundleId: "com.apple.mail",
        window: "(3) Inbox - Mail",
      },
    });
    const updated = observation([], {
      app: {
        name: "Mail",
        bundleId: "com.apple.mail",
        window: "(4) Inbox - Mail",
      },
    });
    const different = observation([], {
      app: {
        name: "Mail",
        bundleId: "com.apple.mail",
        window: "Compose New Message",
      },
    });

    expect(sameSurface(before, updated)).toBe(true);
    expect(sameSurface(before, different)).toBe(false);
    expect(closerOutOfDate(closerScene(before), updated)).toBe(false);
    expect(closerOutOfDate(closerScene(before), different)).toBe(true);
  });
});
