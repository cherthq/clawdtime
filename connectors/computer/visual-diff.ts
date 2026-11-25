/**
 * Perceptual visual diff for desktop screenshots.
 *
 * Uses pure-JS `jpeg-js` to downsample JPEG frames into a 64x36 Y-channel
 * luminance grid and compute:
 * - A quantized perceptual digest (excluding only the top-right row-0 menu-bar
 *   clock strip) so menu-bar clock ticks and JPEG compression jitter do not
 *   look like screen changes while top-left window controls/tabs remain tracked.
 * - A region-masked luminance comparison with configurable cursor masking and
 *   strict target-area (`focusRect`) sensitivity.
 * - Non-JPEG strings (such as dummy fixtures in unit tests) safely return null
 *   so callers fall back cleanly.
 */
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";
import type { Observation } from "./ports.js";

export const DIFF_GRID_W = 64;
export const DIFF_GRID_H = 36;
export const DIFF_LUMA_THRESHOLD = 14;
export const DIFF_MIN_CELLS = 4;
/** First grid column of the top-right row-0 menu-bar clock/status strip. */
export const MENU_BAR_CLOCK_START_X = Math.floor(DIFF_GRID_W * 0.72);

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const CURSOR_MASK_RADIUS = 2;

export interface LuminanceGrid {
  width: number;
  height: number;
  cells: Uint8Array;
  digest: string;
}

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisualDiffOptions {
  cursorA?: { x: number; y: number } | null;
  cursorB?: { x: number; y: number } | null;
  screen?: { width: number; height: number } | null;
  /**
   * When false, do not mask cursor footprints so UI changes directly under the
   * pointer (toggles, highlights, checkboxes, popovers, in-place label swaps)
   * are always detected. Default true.
   */
  maskCursor?: boolean;
  /**
   * Optional screen-coordinate target rectangle(s). Any single changed cell in
   * the target neighborhood (with zero cursor masking and zero clock-strip
   * exemption) marks the diff as changed.
   */
  focusRect?: FocusRect | FocusRect[] | null;
  /**
   * Minimum number of changed cells required to mark the diff as changed.
   * Defaults to `DIFF_MIN_CELLS` (4) for noise-tolerant coarse comparisons;
   * callers like post-action `judge()` can pass `1` to detect tiny single-cell
   * controls (e.g. small switches or radio buttons).
   */
  minCells?: number;
}

export interface VisuallyChangedOptions {
  maskCursor?: boolean;
  focusRect?: FocusRect | FocusRect[] | null;
  minCells?: number;
}

export interface VisualDiffResult {
  comparable: boolean;
  changed: boolean;
  changedCells: number;
  totalCells: number;
  ratio: number;
  maxDelta: number;
}

function isMenuBarClockCell(gx: number, gy: number): boolean {
  return gy === 0 && gx >= MENU_BAR_CLOCK_START_X;
}

/**
 * Decodes a base64 JPEG into a 64x36 Y-channel luminance grid and quantized
 * 16-level perceptual SHA-256 digest (excluding only the top-right row-0
 * menu-bar clock strip).
 * Returns null for missing, oversized, non-JPEG, or corrupt inputs.
 */
export function decodeLuminanceGrid(base64: string): LuminanceGrid | null {
  if (
    !base64 ||
    base64.length > MAX_IMAGE_BASE64_LENGTH ||
    !base64.startsWith("/9j/")
  ) {
    return null;
  }
  let decoded: { width: number; height: number; data: Uint8Array } | null =
    null;
  try {
    decoded = jpeg.decode(Buffer.from(base64, "base64"), {
      useTArray: true,
      tolerantDecoding: true,
      maxResolutionInMP: 4,
      maxMemoryUsageInMB: 128,
    });
    const { width, height, data } = decoded;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      data.length < width * height * 4
    ) {
      return null;
    }
    const cells = new Uint8Array(DIFF_GRID_W * DIFF_GRID_H);
    const lumaAt = (px: number, py: number) => {
      const idx = (py * width + px) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      return (77 * r + 150 * g + 29 * b) >> 8;
    };
    for (let gy = 0; gy < DIFF_GRID_H; gy++) {
      const y0 = (gy * height) / DIFF_GRID_H;
      const y1 = ((gy + 1) * height) / DIFF_GRID_H;
      const sy0 = Math.min(height - 1, Math.floor(y0 + (y1 - y0) * 0.25));
      const sy1 = Math.min(height - 1, Math.floor(y0 + (y1 - y0) * 0.75));
      const rowOffset = gy * DIFF_GRID_W;
      for (let gx = 0; gx < DIFF_GRID_W; gx++) {
        const x0 = (gx * width) / DIFF_GRID_W;
        const x1 = ((gx + 1) * width) / DIFF_GRID_W;
        const sx0 = Math.min(width - 1, Math.floor(x0 + (x1 - x0) * 0.25));
        const sx1 = Math.min(width - 1, Math.floor(x0 + (x1 - x0) * 0.75));
        const sum =
          lumaAt(sx0, sy0) +
          lumaAt(sx1, sy0) +
          lumaAt(sx0, sy1) +
          lumaAt(sx1, sy1);
        cells[rowOffset + gx] = (sum + 2) >> 2;
      }
    }
    const quantized = new Uint8Array(cells.length);
    for (let gy = 0; gy < DIFF_GRID_H; gy++) {
      const rowOffset = gy * DIFF_GRID_W;
      for (let gx = 0; gx < DIFF_GRID_W; gx++) {
        const idx = rowOffset + gx;
        quantized[idx] = isMenuBarClockCell(gx, gy) ? 0 : cells[idx]! >> 4;
      }
    }
    const digest = createHash("sha256").update(quantized).digest("hex");
    return {
      width: DIFF_GRID_W,
      height: DIFF_GRID_H,
      cells,
      digest,
    };
  } catch {
    return null;
  } finally {
    decoded?.data.fill(0);
  }
}

function cursorCell(
  cursor: { x: number; y: number } | null | undefined,
  screen: { width: number; height: number } | null | undefined,
): { gx: number; gy: number } | null {
  if (
    !cursor ||
    !screen ||
    !(screen.width > 0) ||
    !(screen.height > 0) ||
    !Number.isFinite(cursor.x) ||
    !Number.isFinite(cursor.y)
  ) {
    return null;
  }
  const gx = Math.max(
    0,
    Math.min(
      DIFF_GRID_W - 1,
      Math.floor((cursor.x / screen.width) * DIFF_GRID_W),
    ),
  );
  const gy = Math.max(
    0,
    Math.min(
      DIFF_GRID_H - 1,
      Math.floor((cursor.y / screen.height) * DIFF_GRID_H),
    ),
  );
  return { gx, gy };
}

interface GridBox {
  gx0: number;
  gx1: number;
  gy0: number;
  gy1: number;
}

function focusBoxes(
  focusRect: FocusRect | FocusRect[] | null | undefined,
  screen: { width: number; height: number } | null | undefined,
): GridBox[] {
  if (!focusRect || !screen || !(screen.width > 0) || !(screen.height > 0)) {
    return [];
  }
  const rects = Array.isArray(focusRect) ? focusRect : [focusRect];
  const boxes: GridBox[] = [];
  for (const rect of rects) {
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.w) ||
      !Number.isFinite(rect.h)
    ) {
      continue;
    }
    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + Math.max(0, rect.w);
    const y1 = rect.y + Math.max(0, rect.h);
    const gx0 = Math.max(
      0,
      Math.min(
        DIFF_GRID_W - 1,
        Math.floor((x0 / screen.width) * DIFF_GRID_W) - 1,
      ),
    );
    const gx1 = Math.max(
      0,
      Math.min(
        DIFF_GRID_W - 1,
        Math.floor((x1 / screen.width) * DIFF_GRID_W) + 1,
      ),
    );
    const gy0 = Math.max(
      0,
      Math.min(
        DIFF_GRID_H - 1,
        Math.floor((y0 / screen.height) * DIFF_GRID_H) - 1,
      ),
    );
    const gy1 = Math.max(
      0,
      Math.min(
        DIFF_GRID_H - 1,
        Math.floor((y1 / screen.height) * DIFF_GRID_H) + 1,
      ),
    );
    boxes.push({ gx0, gx1, gy0, gy1 });
  }
  return boxes;
}

/**
 * Compares two 64x36 luminance grids, ignoring only the top-right row-0
 * menu-bar clock strip and (when `maskCursor` is not false) +/-2 cells around
 * both cursor footprints. Any cell inside `focusRect` is checked strictly with
 * zero cursor or clock masking.
 */
export function compareGrids(
  a: LuminanceGrid | null,
  b: LuminanceGrid | null,
  options: VisualDiffOptions = {},
): VisualDiffResult {
  if (
    !a ||
    !b ||
    a.width !== DIFF_GRID_W ||
    a.height !== DIFF_GRID_H ||
    b.width !== DIFF_GRID_W ||
    b.height !== DIFF_GRID_H ||
    a.cells.length !== DIFF_GRID_W * DIFF_GRID_H ||
    b.cells.length !== DIFF_GRID_W * DIFF_GRID_H
  ) {
    return {
      comparable: false,
      changed: false,
      changedCells: 0,
      totalCells: 0,
      ratio: 0,
      maxDelta: 0,
    };
  }
  const maskCursor = options.maskCursor !== false;
  const cA = maskCursor ? cursorCell(options.cursorA, options.screen) : null;
  const cB = maskCursor ? cursorCell(options.cursorB, options.screen) : null;
  const boxes = focusBoxes(options.focusRect, options.screen);

  let changedCells = 0;
  let focusChangedCells = 0;
  let totalCells = 0;
  let maxDelta = 0;
  for (let gy = 0; gy < DIFF_GRID_H; gy++) {
    const rowOffset = gy * DIFF_GRID_W;
    for (let gx = 0; gx < DIFF_GRID_W; gx++) {
      const inFocus = boxes.some(
        (box) =>
          gx >= box.gx0 && gx <= box.gx1 && gy >= box.gy0 && gy <= box.gy1,
      );
      if (!inFocus) {
        if (isMenuBarClockCell(gx, gy)) continue;
        if (
          (cA &&
            Math.abs(gx - cA.gx) <= CURSOR_MASK_RADIUS &&
            Math.abs(gy - cA.gy) <= CURSOR_MASK_RADIUS) ||
          (cB &&
            Math.abs(gx - cB.gx) <= CURSOR_MASK_RADIUS &&
            Math.abs(gy - cB.gy) <= CURSOR_MASK_RADIUS)
        ) {
          continue;
        }
      }
      totalCells++;
      const idx = rowOffset + gx;
      const delta = Math.abs(a.cells[idx]! - b.cells[idx]!);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > DIFF_LUMA_THRESHOLD) {
        changedCells++;
        if (inFocus) focusChangedCells++;
      }
    }
  }
  const minCells = options.minCells ?? DIFF_MIN_CELLS;
  const ratio = totalCells > 0 ? changedCells / totalCells : 0;
  return {
    comparable: true,
    changed: changedCells >= minCells || focusChangedCells >= 1,
    changedCells,
    totalCells,
    ratio,
    maxDelta,
  };
}

const gridCache = new WeakMap<Observation, LuminanceGrid | null>();

/** Memoized luminance grid for an Observation, or null when not a decodable JPEG. */
export function luminanceGridOf(obs: Observation | null): LuminanceGrid | null {
  if (!obs) return null;
  if (gridCache.has(obs)) return gridCache.get(obs) ?? null;
  const grid = obs.image ? decodeLuminanceGrid(obs.image) : null;
  gridCache.set(obs, grid);
  return grid;
}

/**
 * Returns true if two observations differ visually, false if visually
 * unchanged, or null when either frame lacks a decodable JPEG.
 */
export function visuallyChanged(
  a: Observation | null,
  b: Observation | null,
  options: VisuallyChangedOptions = {},
): boolean | null {
  if (!a || !b) return null;
  const gridA = luminanceGridOf(a);
  const gridB = luminanceGridOf(b);
  if (!gridA || !gridB) return null;
  const diff = compareGrids(gridA, gridB, {
    cursorA: a.cursor,
    cursorB: b.cursor,
    screen: b.screen,
    ...(options.maskCursor !== undefined
      ? { maskCursor: options.maskCursor }
      : {}),
    ...(options.focusRect !== undefined
      ? { focusRect: options.focusRect }
      : {}),
    ...(options.minCells !== undefined ? { minCells: options.minCells } : {}),
  });
  return diff.comparable ? diff.changed : null;
}
