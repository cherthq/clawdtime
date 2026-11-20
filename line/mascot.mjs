// The ClawdTime stone as pixels, with no dependency.
// It is the same figure as the desktop mascot: one solid shape, an ink edge, a rim in the color of the state, and
// two bar eyes. All numbers are in the figure's own box of 200 by 200 with the origin at the top left, as in
// mac/Sources/ClawdTimeTaskPanel/FlatMascots.swift (StoneFlat). Keep the two files the same.
//
// How it draws: each outline becomes a grid of signed distances, made once for each style. A pixel reads its
// distance from the grid, and the distance gives the cover of the body, of the ink edge and of the rim. So every
// edge is soft, at any size and any place, and a frame costs little.

const BOX = 200;
const BASE = 176; // the figure squashes about this line
const EDGE = 3.5; // the ink edge reaches this far outside the outline
const RIM = 8.5; // the rim reaches this far outside the outline
const INK = 0x1c1a16;
const STEP = 0.5; // the spacing of the distance grid, in box units

/**
 * The six stones. `points` with `radius` is a polygon with round corners. `oval` (middle x, middle y, half
 * width, half height) and `curves` (cubic curves from `start`) are smooth outlines. `face` is the middle of
 * the face. Dark eyes, on a light stone, stay dark in every state.
 */
const CUTS = {
  jet: { oval: [100, 108, 66, 62], body: 0x1c1a16, face: [100, 104] },
  jade: {
    points: [
      [50, 48],
      [146, 38],
      [160, 146],
      [44, 160],
    ],
    radius: 28,
    body: 0x157a5c,
    face: [101, 98],
  },
  lapis: {
    points: [
      [92, 30],
      [158, 66],
      [150, 164],
      [54, 170],
      [34, 88],
    ],
    radius: 22,
    body: 0x2a4bb0,
    face: [97, 104],
  },
  amber: {
    start: [118, 26],
    curves: [
      [136, 52, 168, 86, 168, 120],
      [168, 152, 138, 174, 100, 174],
      [62, 174, 32, 152, 32, 120],
      [32, 84, 70, 62, 92, 50],
      [104, 44, 112, 36, 118, 26],
    ],
    body: 0xe3a32f,
    darkEyes: true,
    face: [100, 122],
  },
  garnet: {
    points: [
      [100, 22],
      [178, 166],
      [22, 166],
    ],
    radius: 26,
    body: 0x8e2440,
    face: [100, 124],
  },
  amethyst: {
    points: [
      [104, 22],
      [166, 78],
      [112, 180],
      [40, 86],
    ],
    radius: 20,
    body: 0x5a3aa6,
    face: [104, 92],
  },
};

export const STYLES = Object.keys(CUTS);
export const STATES = ["idle", "listening", "thinking", "speaking"];

/**
 * The state is one color, for the rim and for the pale eyes. Idle, listening and thinking use the colors of the
 * desktop figure (rest, work, needs the person). The desktop has no color for speech, so speaking has a green
 * of the same lightness. All four stay clear on each of the six stones.
 */
export const STATE_COLORS = {
  idle: 0xf7f5ef,
  listening: 0x86a8ff,
  thinking: 0xffb936,
  speaking: 0x7fdfa0,
};

const clamp = (value, low, high) =>
  value < low ? low : value > high ? high : value;
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** The red, green and blue parts of a color number. */
export const channels = (color) => [
  (color >> 16) & 255,
  (color >> 8) & 255,
  color & 255,
];

/** A style that exists: the name given, or CLAWDTIME_LINE_MASCOT, or jet. */
export function styleName(name = process.env.CLAWDTIME_LINE_MASCOT) {
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  return Object.hasOwn(CUTS, key) ? key : "jet";
}

/** The polygon moved inward by `distance` on every edge. */
function inset(points, distance) {
  const count = points.length;
  let area = 0;
  for (let i = 0; i < count; i++) {
    const [ax, ay] = points[i],
      [bx, by] = points[(i + 1) % count];
    area += ax * by - bx * ay;
  }
  const sign = area > 0 ? 1 : -1;
  const lines = points.map(([ax, ay], i) => {
    const [bx, by] = points[(i + 1) % count];
    const length = Math.max(0.0001, Math.hypot(bx - ax, by - ay));
    const nx = (-(by - ay) / length) * sign * distance,
      ny = ((bx - ax) / length) * sign * distance;
    return [ax + nx, ay + ny, bx + nx, by + ny];
  });
  return lines.map((second, i) => {
    const first = lines[(i + count - 1) % count];
    const ax = first[2] - first[0],
      ay = first[3] - first[1],
      bx = second[2] - second[0],
      by = second[3] - second[1];
    const det = ax * by - ay * bx;
    if (Math.abs(det) <= 0.0001) return [second[0], second[1]];
    const t = ((second[0] - first[0]) * by - (second[1] - first[1]) * bx) / det;
    return [first[0] + ax * t, first[1] + ay * t];
  });
}

/** The outline as a closed line of points, and the radius that rounds it. */
function outline(cut) {
  if (cut.oval) {
    const [cx, cy, rx, ry] = cut.oval,
      count = 144;
    return {
      radius: 0,
      points: Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * 2 * Math.PI;
        return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
      }),
    };
  }
  if (cut.curves) {
    const points = [],
      steps = 28;
    let [x0, y0] = cut.start;
    for (const [x1, y1, x2, y2, x3, y3] of cut.curves) {
      for (let i = 0; i < steps; i++) {
        const t = i / steps,
          u = 1 - t;
        const a = u * u * u,
          b = 3 * u * u * t,
          c = 3 * u * t * t,
          d = t * t * t;
        points.push([
          a * x0 + b * x1 + c * x2 + d * x3,
          a * y0 + b * y1 + c * y2 + d * y3,
        ]);
      }
      x0 = x3;
      y0 = y3;
    }
    return { radius: 0, points };
  }
  return { radius: cut.radius, points: inset(cut.points, cut.radius) };
}

/** The distance from a point to a closed line of points: below zero inside, above zero outside. */
function distance(flat, x, y) {
  let best = Infinity,
    inside = false;
  const last = flat.length - 2;
  let ax = flat[last],
    ay = flat[last + 1];
  for (let i = 0; i <= last; i += 2) {
    const bx = flat[i],
      by = flat[i + 1];
    const ex = bx - ax,
      ey = by - ay,
      wx = x - ax,
      wy = y - ay;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const dx = wx - ex * t,
      dy = wy - ey * t,
      far = dx * dx + dy * dy;
    if (far < best) best = far;
    if (ay > y !== by > y && x < ax + ((y - ay) * ex) / ey) inside = !inside;
    ax = bx;
    ay = by;
  }
  return inside ? -Math.sqrt(best) : Math.sqrt(best);
}

const fields = new Map();
/** The distance grid of a style, made at the first use. */
function field(style) {
  const ready = fields.get(style);
  if (ready) return ready;
  const { points, radius } = outline(CUTS[style]);
  const flat = Float64Array.from(points.flat());
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const [x, y] of points) {
    left = Math.min(left, x - radius);
    right = Math.max(right, x + radius);
    top = Math.min(top, y - radius);
    bottom = Math.max(bottom, y + radius);
  }
  const pad = RIM + 2;
  const x0 = Math.floor(left - pad),
    y0 = Math.floor(top - pad);
  const cols = Math.ceil((right + pad - x0) / STEP) + 2,
    rows = Math.ceil((bottom + pad - y0) / STEP) + 2;
  const data = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++)
      data[row * cols + col] =
        distance(flat, x0 + col * STEP, y0 + row * STEP) - radius;
  }
  const made = { x0, y0, cols, rows, data, left, top, right, bottom };
  fields.set(style, made);
  return made;
}

/** The box that holds a stone with its rim, in box units. Use it to put the middle of a stone at a point. */
export function bounds(style) {
  const { left, top, right, bottom } = field(styleName(style));
  return {
    left: left - RIM,
    top: top - RIM,
    right: right + RIM,
    bottom: bottom + RIM,
  };
}

/** Puts a color over a pixel. The color comes already multiplied by its cover `a`. */
function over(pixels, i, r, g, b, a) {
  const under = pixels[i + 3];
  if (under === 255) {
    const keep = 1 - a;
    pixels[i] = r + pixels[i] * keep + 0.5;
    pixels[i + 1] = g + pixels[i + 1] * keep + 0.5;
    pixels[i + 2] = b + pixels[i + 2] * keep + 0.5;
    return;
  }
  const rest = (under / 255) * (1 - a),
    total = a + rest;
  if (total <= 0) return;
  pixels[i] = (r + pixels[i] * rest) / total + 0.5;
  pixels[i + 1] = (g + pixels[i + 1] * rest) / total + 0.5;
  pixels[i + 2] = (b + pixels[i + 2] * rest) / total + 0.5;
  pixels[i + 3] = total * 255 + 0.5;
}

let cells = new Int32Array(0),
  parts = new Float32Array(0);

/**
 * Draws a stone into RGBA pixels, over what is there. Pixels outside the frame are left out.
 * @param {Uint8Array} pixels width * height * 4 bytes, rows from the top
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.x] the left side of the figure's box, in pixels
 * @param {number} [options.y] the top side of the figure's box, in pixels
 * @param {number} [options.size] the side of the figure's box, in pixels (200 draws one unit as one pixel)
 * @param {string} [options.style] jet, jade, lapis, amber, garnet or amethyst
 * @param {string} [options.state] idle, listening, thinking or speaking: the color of the rim and of pale eyes
 * @param {number} [options.blink] 0 is open and 1 is shut; a little below 0 opens the eyes wider
 * @param {number} [options.lookX] -1 looks left, 1 looks right
 * @param {number} [options.lookY] -1 looks down, 1 looks up
 * @param {number} [options.beat] the height of the eye bars, as a factor: speech makes them beat about 1
 * @param {number} [options.lift] how far the figure is off its place, upward, in box units
 * @param {number} [options.squash] above 1 is taller and thinner, below 1 is shorter and wider, about the base
 * @param {number} [options.scale] the size about the base, as a factor
 */
export function drawMascot(pixels, width, height, options = {}) {
  const style = styleName(options.style),
    cut = CUTS[style],
    shape = field(style);
  const state = STATES.includes(options.state) ? options.state : "idle";
  const size = options.size ?? BOX;
  if (!(size > 0) || !(width > 0) || !(height > 0)) return;
  const unit = size / BOX;
  const squash = clamp(options.squash ?? 1, 0.3, 3),
    scale = clamp(options.scale ?? 1, 0.1, 4);
  const wide = scale / Math.sqrt(squash),
    tall = scale * squash;
  // A point (u, v) of the box lands on the pixel (ax * u + bx, ay * v + by).
  const ax = unit * wide,
    bx = (options.x ?? 0) + unit * (BOX / 2) * (1 - wide);
  const ay = unit * tall,
    by = (options.y ?? 0) + unit * (BASE * (1 - tall) - (options.lift ?? 0));
  const sharp = Math.sqrt(ax * ay); // pixels for each unit, across an edge
  const [stateR, stateG, stateB] = channels(STATE_COLORS[state]);
  const [inkR, inkG, inkB] = channels(INK);
  const [bodyR, bodyG, bodyB] = channels(cut.body);

  // The stone: the rim in the color of the state, the ink edge, the body.
  const x0 = Math.max(0, Math.floor(ax * (shape.left - RIM) + bx - 1));
  const x1 = Math.min(width - 1, Math.ceil(ax * (shape.right + RIM) + bx + 1));
  const y0 = Math.max(0, Math.floor(ay * (shape.top - RIM) + by - 1));
  const y1 = Math.min(
    height - 1,
    Math.ceil(ay * (shape.bottom + RIM) + by + 1),
  );
  if (x1 >= x0 && y1 >= y0) {
    const span = x1 - x0 + 1,
      grid = 1 / STEP,
      { data, cols, rows } = shape;
    if (cells.length < span) {
      cells = new Int32Array(span);
      parts = new Float32Array(span);
    }
    for (let c = 0; c < span; c++) {
      const place = ((x0 + c + 0.5 - bx) / ax - shape.x0) * grid,
        cell = Math.floor(place);
      if (cell < 0 || cell >= cols - 1) {
        cells[c] = -1;
        continue;
      }
      cells[c] = cell;
      parts[c] = place - cell;
    }
    const inside = -0.5 / sharp,
      outside = RIM + 0.5 / sharp;
    for (let py = y0; py <= y1; py++) {
      const place = ((py + 0.5 - by) / ay - shape.y0) * grid,
        cell = Math.floor(place);
      if (cell < 0 || cell >= rows - 1) continue;
      const part = place - cell,
        upper = cell * cols,
        lower = upper + cols;
      let i = (py * width + x0) * 4;
      for (let c = 0; c < span; c++, i += 4) {
        const at = cells[c];
        if (at < 0) continue;
        const fx = parts[c];
        const above =
          data[upper + at] + (data[upper + at + 1] - data[upper + at]) * fx;
        const below =
          data[lower + at] + (data[lower + at + 1] - data[lower + at]) * fx;
        const far = above + (below - above) * part;
        if (far >= outside) continue;
        if (far <= inside) {
          pixels[i] = bodyR;
          pixels[i + 1] = bodyG;
          pixels[i + 2] = bodyB;
          pixels[i + 3] = 255;
          continue;
        }
        const rim = clamp(0.5 - (far - RIM) * sharp, 0, 1);
        const edge = clamp(0.5 - (far - EDGE) * sharp, 0, 1);
        const body = clamp(0.5 - far * sharp, 0, 1);
        const underEdge = rim * (1 - edge),
          underBody = 1 - body;
        over(
          pixels,
          i,
          (stateR * underEdge + inkR * edge) * underBody + bodyR * body,
          (stateG * underEdge + inkG * edge) * underBody + bodyG * body,
          (stateB * underEdge + inkB * edge) * underBody + bodyB * body,
          (underEdge + edge) * underBody + body,
        );
      }
    }
  }

  // The eyes: two bars with round ends. Shut, each is one short line.
  const open = clamp(1 - (options.blink ?? 0), 0, 1.25);
  let halfWide = 13,
    halfTall = 3,
    corner = 3;
  if (open >= 0.2) {
    const high = Math.max(
      7,
      38 * Math.min(1.15, open) * Math.max(0, options.beat ?? 1),
    );
    halfWide = 8;
    halfTall = high / 2;
    corner = Math.min(16, high) / 2;
  }
  const [eyeR, eyeG, eyeB] = cut.darkEyes
    ? [inkR, inkG, inkB]
    : [stateR, stateG, stateB];
  const lookX = clamp(options.lookX ?? 0, -1, 1) * 6,
    lookY = -clamp(options.lookY ?? 0, -1, 1) * 5;
  for (const side of [-1, 1]) {
    const cx = cut.face[0] + side * 20 + lookX,
      cy = cut.face[1] + lookY;
    const ex0 = Math.max(0, Math.floor(ax * (cx - halfWide) + bx - 1));
    const ex1 = Math.min(width - 1, Math.ceil(ax * (cx + halfWide) + bx + 1));
    const ey0 = Math.max(0, Math.floor(ay * (cy - halfTall) + by - 1));
    const ey1 = Math.min(height - 1, Math.ceil(ay * (cy + halfTall) + by + 1));
    for (let py = ey0; py <= ey1; py++) {
      const v = Math.abs((py + 0.5 - by) / ay - cy) - (halfTall - corner);
      let i = (py * width + ex0) * 4;
      for (let px = ex0; px <= ex1; px++, i += 4) {
        const u = Math.abs((px + 0.5 - bx) / ax - cx) - (halfWide - corner);
        const far =
          Math.hypot(Math.max(u, 0), Math.max(v, 0)) +
          Math.min(Math.max(u, v), 0) -
          corner;
        const cover = clamp(0.5 - far * sharp, 0, 1);
        if (cover > 0)
          over(pixels, i, eyeR * cover, eyeG * cover, eyeB * cover, cover);
      }
    }
  }
}

/** A rectangle with round corners in one flat color, with soft edges, over what is there. */
export function drawPlate(
  pixels,
  width,
  height,
  x,
  y,
  wide,
  tall,
  radius,
  color,
  alpha = 1,
) {
  if (!(wide > 0) || !(tall > 0)) return;
  const [r, g, b] = channels(color);
  const corner = Math.max(0, Math.min(radius, wide / 2, tall / 2)),
    cx = x + wide / 2,
    cy = y + tall / 2;
  const x0 = Math.max(0, Math.floor(x - 1)),
    x1 = Math.min(width - 1, Math.ceil(x + wide + 1));
  const y0 = Math.max(0, Math.floor(y - 1)),
    y1 = Math.min(height - 1, Math.ceil(y + tall + 1));
  for (let py = y0; py <= y1; py++) {
    const v = Math.abs(py + 0.5 - cy) - (tall / 2 - corner);
    let i = (py * width + x0) * 4;
    for (let px = x0; px <= x1; px++, i += 4) {
      const u = Math.abs(px + 0.5 - cx) - (wide / 2 - corner);
      const far =
        Math.hypot(Math.max(u, 0), Math.max(v, 0)) +
        Math.min(Math.max(u, v), 0) -
        corner;
      const cover = clamp(0.5 - far, 0, 1) * alpha;
      if (cover > 0) over(pixels, i, r * cover, g * cover, b * cover, cover);
    }
  }
}

const BLINKS = [1.6, 5.4, 9.0, 9.4]; // when a blink starts, in a cycle of 12.3 seconds; the last two are a pair
const glance = (cycle, from, to) =>
  smooth((cycle - from) / 0.25) * smooth((to - cycle) / 0.25);

/**
 * The life of the figure at a time, as options for drawMascot. It is a pure function of the time and the state,
 * so the same call always draws the same frame. The stone breathes and blinks in every state. Idle, it looks
 * about. Listening, its eyes are wide and still. Thinking, it looks up and from side to side. Speaking, its
 * eyes beat and it bounces a little.
 */
export function pose(seconds, state = "idle") {
  const t = Math.max(0, Number(seconds) || 0),
    cycle = t % 12.3;
  let blink = 0;
  for (const start of BLINKS)
    blink = Math.max(
      blink,
      clamp((0.15 - Math.abs(cycle - start - 0.1)) / 0.1, 0, 1),
    );
  let lookX = 0,
    lookY = 0,
    beat = 1,
    lift = 0;
  let squash = 1 + 0.012 * Math.sin(t * 1.4);
  if (state === "speaking") {
    const wave = Math.sin(t * 15),
      voice = 0.6 + 0.4 * Math.sin(t * 2.3);
    beat = 1 + 0.3 * voice * wave;
    lift = 3 * voice * Math.max(0, wave);
    squash *= 1 + 0.03 * voice * wave;
  } else if (state === "thinking") {
    lookX = 0.75 * Math.sin(t * 1.1);
    lookY = 0.8;
  } else if (state === "listening") {
    if (blink === 0) blink = -0.1;
  } else {
    const look = t % 11;
    lookX = 0.7 * glance(look, 7.4, 8.5) - 0.7 * glance(look, 2.8, 4.1);
  }
  return { blink, lookX, lookY, beat, lift, squash, scale: 1 };
}
