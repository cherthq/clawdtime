// What the caller sees on the video.
//  - With no screen on the call: a calm dark picture with the stone large in the middle. The stone blinks,
//    breathes, looks about, and its eyes beat while ClawdTime speaks. Its rim shows the state. A short bar
//    slides under it, so a frozen video is easy to see.
//  - With the screen on the call: the screen, and the stone small in the bottom right corner on a dark plate.
// The background is drawn once. Each frame redraws only the box of the stone and the bar, so a 1280 by 720
// picture at 10 frames a second costs little.
import {
  bounds,
  channels,
  drawMascot,
  drawPlate,
  pose,
  STATE_COLORS,
  STATES,
  styleName,
} from "./mascot.mjs";
import { FPS, HEIGHT, WIDTH } from "./screen.mjs";

export const BACKGROUND = 0x111317;
const TRACK = 0x1f232a;
const PLATE_EDGE = 0x2c313a;

const known = (state) => (STATES.includes(state) ? state : "idle");

/** The top left corner of a figure box of `size`, so that the middle of the stone is at (cx, cy). */
function boxAt(style, cx, cy, size) {
  const box = bounds(style),
    unit = size / 200;
  return {
    x: cx - ((box.left + box.right) / 2) * unit,
    y: cy - ((box.top + box.bottom) / 2) * unit,
  };
}

/**
 * Puts the stone on a frame, in place: small, in the bottom right corner, on a dark plate with round corners,
 * so it stays clear on any content. It has the same life as the large one. Call it on a copy of the screen
 * frame, once for each frame. It changes pixels only inside the plate, and the plate stays inside the frame.
 * @param {Uint8Array} pixels width * height * 4 RGBA bytes
 * @param {{ tick?: number, state?: string, style?: string, size?: number, margin?: number, fps?: number }} [options]
 * @returns {{ x: number, y: number, width: number, height: number }} the plate
 */
export function drawOverlay(pixels, width, height, options = {}) {
  const style = styleName(options.style),
    state = known(options.state);
  const side = Math.max(
    0,
    Math.floor(Math.min(options.size ?? 150, width, height)),
  );
  const margin = Math.max(
    0,
    Math.min(options.margin ?? 24, (width - side) / 2, (height - side) / 2),
  );
  const x = Math.round(width - margin - side),
    y = Math.round(height - margin - side);
  drawPlate(pixels, width, height, x, y, side, side, side * 0.22, PLATE_EDGE);
  drawPlate(
    pixels,
    width,
    height,
    x + 1.5,
    y + 1.5,
    side - 3,
    side - 3,
    side * 0.22 - 1.5,
    BACKGROUND,
  );
  const size = side * 0.94,
    at = boxAt(style, x + side / 2, y + side / 2, size);
  drawMascot(pixels, width, height, {
    ...pose((options.tick ?? 0) / (options.fps ?? FPS), state),
    x: at.x,
    y: at.y,
    size,
    style,
    state,
  });
  return { x, y, width: side, height: side };
}

/**
 * The picture of the call. `frame(tick, state, shot)` gives the same buffer each time, width * height * 4 RGBA.
 * `tick` counts frames. `state` is idle, listening, thinking or speaking. With `shot` (a full screen frame),
 * the frame is that screen with the small stone on it. `shot` itself is not changed.
 * @param {{ width?: number, height?: number, fps?: number, style?: string }} [options]
 */
export function makePicture(options = {}) {
  const width = options.width ?? WIDTH,
    height = options.height ?? HEIGHT,
    fps = options.fps ?? FPS;
  const style = styleName(options.style);
  const [red, green, blue] = channels(BACKGROUND);
  const base = new Uint8Array(width * height * 4);
  for (let i = 0; i < base.length; i += 4) {
    base[i] = red;
    base[i + 1] = green;
    base[i + 2] = blue;
    base[i + 3] = 255;
  }
  const bar = {
    wide: Math.round(width * 0.25),
    tall: Math.max(2, Math.round(height / 180)),
    y: Math.round(height * 0.93),
  };
  bar.x = Math.round((width - bar.wide) / 2);
  bar.slider = bar.wide * 0.22;
  drawPlate(
    base,
    width,
    height,
    bar.x,
    bar.y,
    bar.wide,
    bar.tall,
    bar.tall / 2,
    TRACK,
  );
  const pixels = Uint8Array.from(base);

  const size = Math.round(Math.min(width, height) * 0.78);
  const at = boxAt(style, width / 2, height * 0.47, size);
  const inside = (x0, y0, x1, y1) => ({
    x0: Math.max(0, Math.floor(x0)),
    y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(width, Math.ceil(x1)),
    y1: Math.min(height, Math.ceil(y1)),
  });
  // The parts of the picture that change: the box of the stone, with room for its bounce, and the bar.
  const slack = size * 0.05;
  const changing = [
    inside(
      at.x - slack,
      at.y - slack,
      at.x + size + slack,
      at.y + size + slack,
    ),
    inside(bar.x - 1, bar.y - 1, bar.x + bar.wide + 1, bar.y + bar.tall + 1),
  ];
  const restore = ({ x0, y0, x1, y1 }) => {
    for (let y = y0; y < y1; y++) {
      const from = (y * width + x0) * 4;
      pixels.set(base.subarray(from, (y * width + x1) * 4), from);
    }
  };
  let screenShown = false;
  return {
    width,
    height,
    frame(tick = 0, state = "idle", shot = null) {
      const now = known(state);
      if (shot && shot.length === pixels.length) {
        pixels.set(shot);
        screenShown = true;
        drawOverlay(pixels, width, height, { tick, state: now, style, fps });
        return pixels;
      }
      if (screenShown) {
        pixels.set(base);
        screenShown = false;
      } else changing.forEach(restore);
      drawMascot(pixels, width, height, {
        ...pose(tick / fps, now),
        x: at.x,
        y: at.y,
        size,
        style,
        state: now,
      });
      // The bar slides from side to side, once in 3.2 seconds.
      const phase = (tick / fps / 1.6) % 2,
        slide = phase < 1 ? phase : 2 - phase;
      drawPlate(
        pixels,
        width,
        height,
        bar.x + (bar.wide - bar.slider) * slide,
        bar.y,
        bar.slider,
        bar.tall,
        bar.tall / 2,
        STATE_COLORS[now],
        0.8,
      );
      return pixels;
    },
  };
}
