// The caller's own zoom on the call video: a named part of the screen ("top right"), a thing that the Mac names
// ("the address bar", "Stonepad"), a level ("closer", "2x") or a move ("a bit up"). Presentation only: every
// rectangle is a share of the main display, and none of them is ever an input coordinate or goes to the hands.
//
// The level of a crop is its magnification against the whole screen in the same picture: "2x" shows things
// twice as large as the whole screen does. The picture differs by the line's framing. On "fit" the screen goes
// into the wide picture; on "fill" it goes into the narrow upright strip above the stone, so a crop for "fill" is
// tall: at 2x it is the left or right half of the screen from top to bottom.
import { OVERVIEW } from "./camera.mjs";
import { screenLayout } from "./layout.mjs";
import { HEIGHT, WIDTH } from "./screen.mjs";

export const MANUAL_ZOOM = Object.freeze({
  /** The largest magnification that the caller can ask for. */
  max: 4,
  /** "Closer" and "zoom out" multiply or divide the magnification by this. */
  step: 1.5,
  /** "A bit closer", "zoom out a bit". */
  bit: 1.25,
  /** A named thing on the screen is shown at most this large: the caller says "closer" for more. */
  element: 3,
  /** Room around a named thing, in shares of the screen on each side. */
  margin: 0.06,
  /** A move goes this share of the part that the video shows; "a bit" goes half of it. */
  pan: 0.5,
  panBit: 0.25,
});
/** Below this magnification a named part shows whole, with dark bands, rather than with what is around it. */
const SMALL_GAIN = 1.15;
/** A crop never gets smaller than this on a side: the view of layout.mjs refuses one under 0.08. */
const SMALLEST_SIDE = 0.1;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => Math.round(n * 10000) / 10000;
const rounded = (r) => ({
  x: round(r.x),
  y: round(r.y),
  w: round(r.w),
  h: round(r.h),
});
const whole = (r) => r.w >= 0.999 && r.h >= 0.999;
const same = (a, b) =>
  ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) < 0.0005);
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * The shape of the picture for one call: `k` and `j` are such that a crop of shares (w, h) shows the screen
 * min(k / w, j / h) times as large as the whole screen does. `aspect` is the screen's width by its height.
 */
export function zoomGeometry({ aspect, layout = "wide" } = {}) {
  const { box } = screenLayout(WIDTH, HEIGHT, layout);
  const screen =
    typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0
      ? aspect
      : 16 / 9;
  const picture = box.w / box.h;
  return {
    k: Math.max(1, picture / screen),
    j: Math.max(1, screen / picture),
  };
}

/** How many times larger than the whole screen a crop shows. */
export const magnification = (crop, g) => Math.min(g.k / crop.w, g.j / crop.h);

/** The crop of the picture's own shape at magnification `m`, around a point, inside the screen. */
export function cropAt(point, m, g) {
  const level = clamp(m, 1, MANUAL_ZOOM.max);
  const w = Math.min(1, g.k / level),
    h = Math.min(1, g.j / level);
  return rounded({
    x: clamp(point.x - w / 2, 0, 1 - w),
    y: clamp(point.y - h / 2, 0, 1 - h),
    w,
    h,
  });
}

/** A named part: as large as the picture allows, with what is around it in place of dark bands. */
export function frameArea(region, g) {
  const m = magnification(region, g);
  if (m < SMALL_GAIN && region.w >= SMALLEST_SIDE && region.h >= SMALLEST_SIDE)
    return rounded(region);
  return cropAt(centre(region), m, g);
}

/** A window that the caller names shows alone, as the one-window view of a session does. */
export function frameWindow(region, g) {
  const m = magnification(region, g);
  if (
    m > MANUAL_ZOOM.max ||
    region.w < SMALLEST_SIDE ||
    region.h < SMALLEST_SIDE
  )
    return cropAt(centre(region), Math.min(m, MANUAL_ZOOM.max), g);
  return rounded(region);
}

/** A thing on the screen: with some room around it, and at most `MANUAL_ZOOM.element` times. */
export function frameElement(region, g) {
  const room = MANUAL_ZOOM.margin * 2;
  const m = clamp(
    magnification({ w: region.w + room, h: region.h + room }, g),
    1,
    MANUAL_ZOOM.element,
  );
  return cropAt(centre(region), m, g);
}

// Words of a named part of the screen. Any other word means the caller names a thing, not a part.
const AREA_FILLER = new Set([
  "the",
  "of",
  "on",
  "in",
  "a",
  "screen",
  "display",
  "desktop",
  "corner",
  "quarter",
  "part",
  "side",
  "section",
  "area",
  "portion",
  "region",
  "half",
  "edge",
]);
const VERTICAL = {
  top: "top",
  upper: "top",
  bottom: "bottom",
  lower: "bottom",
};
const HORIZONTAL = { left: "left", right: "right" };
const MIDDLE = new Set(["middle", "center", "centre", "central"]);

/**
 * A part of the screen by its place: "top right", "the left half", "the middle", "bottom bar". Null when the
 * words say anything else, so "the top of the chart" is a thing for the Mac to find.
 */
export function namedArea(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !AREA_FILLER.has(w));
  let vertical = null,
    horizontal = null,
    middle = false,
    bar = false;
  for (const word of words) {
    if (VERTICAL[word] && !vertical) vertical = VERTICAL[word];
    else if (HORIZONTAL[word] && !horizontal) horizontal = HORIZONTAL[word];
    else if (MIDDLE.has(word) && !middle) middle = true;
    else if (word === "bar" && !bar) bar = true;
    else if (word === "menu" && !vertical) vertical = "top";
    else if (word === "dock" && !vertical) {
      vertical = "bottom";
      bar = true;
    } else return null;
  }
  if (words.includes("menu") && !bar) return null;
  if (bar) {
    // The middle of the bar along that edge, twice as large; a move goes along it.
    if (!vertical || horizontal || middle) return null;
    return {
      label: `the ${vertical} bar`,
      region: { x: 0.25, y: vertical === "top" ? 0 : 0.88, w: 0.5, h: 0.12 },
    };
  }
  const x = horizontal === "right" ? 0.5 : middle && !horizontal ? 0.25 : 0;
  const y = vertical === "bottom" ? 0.5 : middle && !vertical ? 0.25 : 0;
  if (vertical && horizontal && !middle)
    return {
      label: `the ${vertical} ${horizontal} of the screen`,
      region: { x, y, w: 0.5, h: 0.5 },
    };
  if (vertical && !horizontal)
    return middle
      ? {
          label: `the ${vertical} middle of the screen`,
          region: { x: 0.25, y, w: 0.5, h: 0.5 },
        }
      : {
          label: `the ${vertical} half of the screen`,
          region: { x: 0, y, w: 1, h: 0.5 },
        };
  if (horizontal && !vertical)
    return middle
      ? {
          label: `the ${horizontal} middle of the screen`,
          region: { x, y: 0.25, w: 0.5, h: 0.5 },
        }
      : {
          label: `the ${horizontal} half of the screen`,
          region: { x, y: 0, w: 0.5, h: 1 },
        };
  if (middle && !vertical && !horizontal)
    return {
      label: "the middle of the screen",
      region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    };
  return null;
}

/** A level: "in" or "out", by the step or a bit, or an exact magnification such as 2 for "2x". */
export function zoomLevel(crop, { level, times, bit } = {}, g) {
  const now = magnification(crop, g);
  let next;
  if (typeof times === "number") next = times;
  else if (level === "in")
    next = now * (bit ? MANUAL_ZOOM.bit : MANUAL_ZOOM.step);
  else if (level === "out")
    next = now / (bit ? MANUAL_ZOOM.bit : MANUAL_ZOOM.step);
  else return { crop, limit: null };
  const limit =
    next > MANUAL_ZOOM.max + 0.001 ? "max" : next < 0.999 ? "min" : null;
  const kept = clamp(next, 1, MANUAL_ZOOM.max);
  // Near the whole screen, the whole screen: it stays the caller's own view until follow or show everything.
  return {
    crop: kept <= 1.05 ? { ...OVERVIEW } : cropAt(centre(crop), kept, g),
    limit,
  };
}

/** A move of the shown part: half of it, or a quarter for "a bit". `edge` when it cannot go further. */
export function zoomMove(crop, direction, bit = false) {
  const share = bit ? MANUAL_ZOOM.panBit : MANUAL_ZOOM.pan;
  const dx =
    direction === "left"
      ? -share * crop.w
      : direction === "right"
        ? share * crop.w
        : 0;
  const dy =
    direction === "up"
      ? -share * crop.h
      : direction === "down"
        ? share * crop.h
        : 0;
  const next = rounded({
    x: clamp(crop.x + dx, 0, 1 - crop.w),
    y: clamp(crop.y + dy, 0, 1 - crop.h),
    w: crop.w,
    h: crop.h,
  });
  const moved =
    Math.abs(next.x - crop.x) > 0.0005 || Math.abs(next.y - crop.y) > 0.0005;
  return { crop: next, edge: !moved };
}

const unfound = {
  no_match:
    "Nothing in the last look at the screen matches that name. The view did not change.",
  no_look:
    "There is no recent look at the screen to find that, and no open app matches it. The view did not change. A part of the screen such as top right, a level or a move still works.",
  unavailable:
    "ClawdTime on this Mac did not answer where that is. The view did not change. A part of the screen such as top right, a level or a move still works.",
};
const EDGE = { left: "left", right: "right", up: "top", down: "bottom" };

/**
 * One zoom request of the caller: an optional target, then a level, then a move, in that order.
 * `current` is the part that the video shows now. `resolve(name)` asks the Mac where a named thing is.
 * The result's crop is the new view, or null when nothing changed; `said` is data for the voice model.
 */
export async function planZoom(
  request,
  { current = OVERVIEW, geometry, resolve, mainDisplay = true },
) {
  const notes = [];
  let crop = { ...current },
    changed = false,
    what = null;
  if (request.target) {
    const area = namedArea(request.target);
    if (area) {
      crop = frameArea(area.region, geometry);
      what = area.label;
    } else if (!mainDisplay)
      return {
        crop: null,
        said: "This call shows another display than the main one, so only a part such as top right, a level or a move works. The view did not change.",
      };
    else {
      let found;
      try {
        found = await resolve(request.target);
      } catch {
        found = null;
      }
      if (found?.code !== "found")
        return {
          crop: null,
          said: unfound[found?.code] ?? unfound.unavailable,
        };
      crop =
        found.match === "window"
          ? frameWindow(found.region, geometry)
          : frameElement(found.region, geometry);
      what = found.match === "window" ? "that window" : "that thing";
    }
    changed = true;
  }
  if (typeof request.times === "number" || request.level) {
    const level = zoomLevel(crop, request, geometry);
    if (level.limit === "max")
      notes.push(`The largest zoom is ${MANUAL_ZOOM.max}x.`);
    if (!same(level.crop, crop)) {
      crop = level.crop;
      changed = true;
    } else if (level.limit === "min")
      notes.push("The video already shows the whole screen.");
  }
  if (request.move) {
    if (whole(crop))
      notes.push(
        "The video shows the whole screen, so there is nothing to move. Zoom in first.",
      );
    else {
      const moved = zoomMove(crop, request.move, request.bit === true);
      if (moved.edge)
        notes.push(
          `The view is already at the ${EDGE[request.move]} edge of the screen.`,
        );
      else {
        crop = moved.crop;
        changed = true;
      }
    }
  }
  if (!changed)
    return {
      crop: null,
      said: [...notes, "The view did not change."].join(" "),
    };
  const level = magnification(crop, geometry);
  const shown = whole(crop)
    ? "The video shows the whole screen."
    : `The video shows ${what ?? "that part of the screen"} at about ${Math.round(level * 10) / 10}x.`;
  return {
    crop,
    said: [
      shown,
      ...notes,
      "It stays until the caller says follow or show everything.",
    ].join(" "),
  };
}
