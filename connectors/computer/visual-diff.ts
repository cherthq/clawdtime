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
 * - A steady check (`steadyDiff`) for looks with no input between them: the
 *   target's own region strictly, the menu bar status area and the regions
 *   that keep changing by themselves (`keepsChanging`) left out.
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
/**
 * First grid column of the menu bar status area: the right half of row 0,
 * where status items, recording indicators and the clock sit. The steady
 * check leaves it out, except the own cells of a target in it.
 */
export const MENU_BAR_STATUS_START_X = Math.floor(DIFF_GRID_W / 2);
/** The most cells that may keep changing by themselves: a sixth of the screen. More is no small region. */
export const NOISE_MAX_CELLS = Math.floor((DIFF_GRID_W * DIFF_GRID_H) / 6);
/** The margin, in cells, around a region that keeps changing. */
export const NOISE_MARGIN = 1;
/** How far, in cells, a change may move from one pair of looks to the next and stay the same region. */
export const NOISE_REACH = 3;

const MAX_IMAGE_BASE64_LENGTH = 4_000_000;
const CURSOR_MASK_RADIUS = 2;
const GRID_CELLS = DIFF_GRID_W * DIFF_GRID_H;

/** One flag for each cell of the grid, row by row: 1 is set. */
export type CellMask = Uint8Array;

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

function isMenuBarStatusCell(gx: number, gy: number): boolean {
  return gy === 0 && gx >= MENU_BAR_STATUS_START_X;
}

function usableGrid(grid: LuminanceGrid | null): grid is LuminanceGrid {
  return (
    grid !== null &&
    grid.width === DIFF_GRID_W &&
    grid.height === DIFF_GRID_H &&
    grid.cells.length === GRID_CELLS
  );
}

/** True when a point of the screen lies in the menu bar row of the grid. */
export function inMenuBar(
  y: number,
  screen: { width: number; height: number } | null | undefined,
): boolean {
  return (
    !!screen &&
    screen.height > 0 &&
    Number.isFinite(y) &&
    y >= 0 &&
    y < screen.height / DIFF_GRID_H
  );
}

/**
 * The cells of the action's targets. A target in a window keeps a margin of
 * one cell around it, as `focusRect` does. A target in the menu bar gets its
 * own cells only: status items sit close together, and the one beside it may
 * blink.
 */
export function targetCells(
  rects: FocusRect | FocusRect[] | null | undefined,
  screen: { width: number; height: number } | null | undefined,
): CellMask {
  const mask = new Uint8Array(GRID_CELLS);
  if (!rects || !screen || !(screen.width > 0) || !(screen.height > 0))
    return mask;
  const col = (x: number) =>
    Math.max(
      0,
      Math.min(DIFF_GRID_W - 1, Math.floor((x / screen.width) * DIFF_GRID_W)),
    );
  const row = (y: number) =>
    Math.max(
      0,
      Math.min(DIFF_GRID_H - 1, Math.floor((y / screen.height) * DIFF_GRID_H)),
    );
  for (const rect of Array.isArray(rects) ? rects : [rects]) {
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.w) ||
      !Number.isFinite(rect.h)
    )
      continue;
    const w = Math.max(0, rect.w);
    const h = Math.max(0, rect.h);
    const own = inMenuBar(rect.y + h / 2, screen);
    // The right and bottom edges end inside the last cell that the target covers.
    const gx0 = own ? col(rect.x) : Math.max(0, col(rect.x) - 1);
    const gx1 = own
      ? col(Math.max(rect.x, rect.x + w - 0.001))
      : Math.min(DIFF_GRID_W - 1, col(rect.x + w) + 1);
    const gy0 = own ? row(rect.y) : Math.max(0, row(rect.y) - 1);
    const gy1 = own
      ? row(Math.max(rect.y, rect.y + h - 0.001))
      : Math.min(DIFF_GRID_H - 1, row(rect.y + h) + 1);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) mask[gy * DIFF_GRID_W + gx] = 1;
  }
  return mask;
}

/** The cells within `margin` cells of a set cell. */
export function growCells(mask: CellMask, margin = NOISE_MARGIN): CellMask {
  const grown = new Uint8Array(GRID_CELLS);
  for (let gy = 0; gy < DIFF_GRID_H; gy++)
    for (let gx = 0; gx < DIFF_GRID_W; gx++) {
      if (!mask[gy * DIFF_GRID_W + gx]) continue;
      for (
        let y = Math.max(0, gy - margin);
        y <= Math.min(DIFF_GRID_H - 1, gy + margin);
        y++
      )
        for (
          let x = Math.max(0, gx - margin);
          x <= Math.min(DIFF_GRID_W - 1, gx + margin);
          x++
        )
          grown[y * DIFF_GRID_W + x] = 1;
    }
  return grown;
}

/** How many cells of `mask` are set, and not set in `except`. */
export function countCells(mask: CellMask, except?: CellMask | null): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] && !except?.[i]) count++;
  return count;
}

export interface SteadyOptions {
  screen?: { width: number; height: number } | null;
  /** The action's targets (`targetCells`): one changed cell there is a change. */
  targets?: FocusRect | FocusRect[] | null;
  /** Cells that keep changing by themselves (`keepsChanging`). They never cover a target. */
  noise?: CellMask | null;
  /** Pointer places, left out with a margin as in `compareGrids`. Absent: the pointer counts. */
  cursorA?: { x: number; y: number } | null;
  cursorB?: { x: number; y: number } | null;
}

export interface SteadyDiff {
  comparable: boolean;
  /** A cell of a target changed. */
  targetChanged: boolean;
  /** The changed cells outside the targets, the menu bar status area, the pointer and the noise. */
  moved: CellMask;
  /** How many cells `moved` holds. */
  count: number;
}

/**
 * Compares two looks with no input between them. The target's own region is
 * checked strictly. The menu bar status area, the regions in `noise` and the
 * pointer places do not count anywhere else.
 */
export function steadyDiff(
  a: LuminanceGrid | null,
  b: LuminanceGrid | null,
  options: SteadyOptions = {},
): SteadyDiff {
  const moved = new Uint8Array(GRID_CELLS);
  if (!usableGrid(a) || !usableGrid(b))
    return { comparable: false, targetChanged: false, moved, count: 0 };
  const targets = targetCells(options.targets, options.screen);
  const cA = cursorCell(options.cursorA, options.screen);
  const cB = cursorCell(options.cursorB, options.screen);
  const nearCursor = (gx: number, gy: number) =>
    (cA !== null &&
      Math.abs(gx - cA.gx) <= CURSOR_MASK_RADIUS &&
      Math.abs(gy - cA.gy) <= CURSOR_MASK_RADIUS) ||
    (cB !== null &&
      Math.abs(gx - cB.gx) <= CURSOR_MASK_RADIUS &&
      Math.abs(gy - cB.gy) <= CURSOR_MASK_RADIUS);
  let targetChanged = false;
  let count = 0;
  for (let gy = 0; gy < DIFF_GRID_H; gy++)
    for (let gx = 0; gx < DIFF_GRID_W; gx++) {
      const idx = gy * DIFF_GRID_W + gx;
      if (Math.abs(a.cells[idx]! - b.cells[idx]!) <= DIFF_LUMA_THRESHOLD)
        continue;
      if (targets[idx]) {
        targetChanged = true;
        continue;
      }
      if (isMenuBarStatusCell(gx, gy) || options.noise?.[idx]) continue;
      if (nearCursor(gx, gy)) continue;
      moved[idx] = 1;
      count++;
    }
  return { comparable: true, targetChanged, moved, count };
}

/** Two looks show the same, by `steadyDiff`: the target as it was, and fewer than `DIFF_MIN_CELLS` other cells. */
export function steady(diff: SteadyDiff): boolean {
  return diff.comparable && !diff.targetChanged && diff.count < DIFF_MIN_CELLS;
}

/**
 * The regions that keep changing by themselves, from the changes (`moved`)
 * between looks in a row with no input between them, one mask for each pair
 * of looks. A changed cell keeps changing when another pair changed a cell
 * within `NOISE_REACH` of it: an animation, a video, a blinking indicator, a
 * spinner. A change that came once and held is no such region, also right
 * beside one. The regions get a margin of `NOISE_MARGIN`, and never cover a
 * cell of `targets`. Null when they are larger than `NOISE_MAX_CELLS`
 * together: that is no small region.
 */
export function keepsChanging(
  pairs: CellMask[],
  targets?: CellMask | null,
): CellMask | null {
  const reach = pairs.map((pair) => growCells(pair, NOISE_REACH));
  const again = new Uint8Array(GRID_CELLS);
  pairs.forEach((pair, i) => {
    for (let idx = 0; idx < GRID_CELLS; idx++)
      if (pair[idx] && reach.some((near, j) => j !== i && near[idx]))
        again[idx] = 1;
  });
  const noise = growCells(again);
  if (targets)
    for (let idx = 0; idx < GRID_CELLS; idx++) if (targets[idx]) noise[idx] = 0;
  return countCells(noise) > NOISE_MAX_CELLS ? null : noise;
}

/** The cells set in either mask. */
export function joinCells(
  one: CellMask | null | undefined,
  other: CellMask | null | undefined,
): CellMask {
  const joined = new Uint8Array(GRID_CELLS);
  for (let i = 0; i < GRID_CELLS; i++)
    if (one?.[i] || other?.[i]) joined[i] = 1;
  return joined;
}
