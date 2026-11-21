import { OVERVIEW } from "./camera.mjs";
import { screenLayout } from "./layout.mjs";

/** The SAME affine transform applies to screen pixels, captured cursor and
 * label. Source is an unletterboxed full-display frame, never an observation. */
export function videoTransform(
  sourceWidth,
  sourceHeight,
  width,
  height,
  layout,
  crop = OVERVIEW,
) {
  const source = {
    x: crop.x * sourceWidth,
    y: crop.y * sourceHeight,
    w: crop.w * sourceWidth,
    h: crop.h * sourceHeight,
  };
  const { box } = screenLayout(width, height, layout);
  const scale = Math.min(box.w / source.w, box.h / source.h);
  const destination = {
    x: box.x + (box.w - source.w * scale) / 2,
    y: box.y + (box.h - source.h * scale) / 2,
    w: source.w * scale,
    h: source.h * scale,
  };
  return {
    source,
    destination,
    scale,
    point: (x, y) => ({
      x: destination.x + (x - source.x) * scale,
      y: destination.y + (y - source.y) * scale,
    }),
  };
}

/** Bounded reusable RGBA output; bilinear RGB resampling avoids shimmering
 * text during fractional pans. It never mutates capture or input geometry. */
export function makeVideoRenderer(width = 1280, height = 720) {
  const pixels = new Uint8Array(width * height * 4);
  const words = new Uint32Array(pixels.buffer);
  const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const ground = little ? 0xff171311 : 0x111317ff;
  const xIndex = new Int32Array(width),
    xWeight = new Float64Array(width);
  return {
    render(frame, crop = OVERVIEW, layout = "wide") {
      const { data, width: sw, height: sh } = frame;
      if (
        !Number.isSafeInteger(sw) ||
        !Number.isSafeInteger(sh) ||
        sw <= 0 ||
        sh <= 0 ||
        data.length !== sw * sh * 3
      )
        throw Error("Invalid RGB frame");
      const { source: s, destination: d } = videoTransform(
        sw,
        sh,
        width,
        height,
        layout,
        crop,
      );
      words.fill(ground);
      const left = Math.max(0, Math.ceil(d.x)),
        right = Math.min(width, Math.floor(d.x + d.w));
      const top = Math.max(0, Math.ceil(d.y)),
        bottom = Math.min(height, Math.floor(d.y + d.h));
      for (let x = left; x < right; x++) {
        const sx = Math.min(
          sw - 1,
          Math.max(0, s.x + ((x + 0.5 - d.x) / d.w) * s.w - 0.5),
        );
        xIndex[x] = Math.floor(sx) * 3;
        xWeight[x] = sx - Math.floor(sx);
      }
      for (let y = top; y < bottom; y++) {
        const sy = Math.min(
          sh - 1,
          Math.max(0, s.y + ((y + 0.5 - d.y) / d.h) * s.h - 0.5),
        );
        const row = Math.floor(sy) * sw * 3,
          next = Math.min(sh - 1, Math.floor(sy) + 1) * sw * 3,
          fy = sy - Math.floor(sy);
        let out = (y * width + left) * 4;
        for (let x = left; x < right; x++, out += 4) {
          const i = xIndex[x],
            j = Math.min(i + 3, (sw - 1) * 3),
            fx = xWeight[x];
          for (let c = 0; c < 3; c++) {
            const a = data[row + i + c] * (1 - fx) + data[row + j + c] * fx;
            const b = data[next + i + c] * (1 - fx) + data[next + j + c] * fx;
            pixels[out + c] = Math.round(a * (1 - fy) + b * fy);
          }
        }
      }
      return pixels;
    },
  };
}
