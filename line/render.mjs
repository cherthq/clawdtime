// Writes the pictures of the call as PNG files, to look at them:   node render.mjs OUT_DIR
// It needs no dependency, no screen and no call. The files:
//   picture-idle.png, picture-listening.png, picture-thinking.png, picture-speaking.png   the full picture
//   picture-blink.png                                                                     one frame of a blink
//   overlay-screen.png, overlay-dark.png     the small stone on a light and on a dark screen (both made up)
//   styles.png                               the six stones, each in the four states
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  channels,
  drawMascot,
  drawPlate,
  pose,
  STATES,
  STYLES,
} from "./mascot.mjs";
import { BACKGROUND, drawOverlay, makePicture } from "./picture.mjs";
import { FPS, HEIGHT, WIDTH } from "./screen.mjs";

const table = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function part(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(
    checksum(out.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return out;
}

/** RGBA pixels as the bytes of a PNG file. */
export function encodePng(pixels, width, height) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8; // bits for each part of a color
  head[9] = 6; // red, green, blue and alpha
  const row = width * 4,
    lines = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++)
    Buffer.from(pixels.buffer, pixels.byteOffset + y * row, row).copy(
      lines,
      y * (row + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    part("IHDR", head),
    part("IDAT", deflateSync(lines)),
    part("IEND", Buffer.alloc(0)),
  ]);
}

/** A frame in one color. */
export function plain(width, height, color) {
  const [red, green, blue] = channels(color),
    pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = red;
    pixels[i + 1] = green;
    pixels[i + 2] = blue;
    pixels[i + 3] = 255;
  }
  return pixels;
}

/** A made-up screen: a title bar and lines of bars that look like text. The same picture each time. */
export function fakeScreen(
  width = WIDTH,
  height = HEIGHT,
  { paper = 0xf4f5f7, ink = 0x2b2f36, title = 0xdfe2e7 } = {},
) {
  const pixels = plain(width, height, paper);
  drawPlate(pixels, width, height, 0, 0, width, 44, 0, title);
  for (let dot = 0; dot < 3; dot++)
    drawPlate(pixels, width, height, 18 + dot * 22, 15, 14, 14, 7, ink, 0.35);
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 76; y < height - 30; y += 26) {
    const end = width - 60 - next() * width * 0.35;
    for (let x = 60 + (next() < 0.25 ? 40 : 0); x < end;) {
      const wide = 26 + next() * 120;
      if (end - x >= 20)
        drawPlate(
          pixels,
          width,
          height,
          x,
          y,
          Math.min(wide, end - x),
          11,
          3,
          ink,
        );
      x += wide + 14;
    }
  }
  return pixels;
}

async function main(dir) {
  await mkdir(dir, { recursive: true });
  const save = async (name, pixels, width = WIDTH, height = HEIGHT) => {
    await writeFile(join(dir, name), encodePng(pixels, width, height));
    console.log(join(dir, name));
  };
  const picture = makePicture();
  // Frames that show each state well: open eyes at rest, a look up while thinking, a high beat while speaking.
  const ticks = { idle: 5, listening: 5, thinking: 12, speaking: 1 };
  for (const state of STATES)
    await save(`picture-${state}.png`, picture.frame(ticks[state], state));
  let shut = 0;
  while (pose(shut / FPS).blink < 1) shut++;
  await save("picture-blink.png", picture.frame(shut, "idle"));

  const light = fakeScreen();
  drawOverlay(light, WIDTH, HEIGHT, {
    tick: ticks.speaking,
    state: "speaking",
  });
  await save("overlay-screen.png", light);
  const dark = fakeScreen(WIDTH, HEIGHT, {
    paper: 0x16181d,
    ink: 0xc9ced6,
    title: 0x23262d,
  });
  drawOverlay(dark, WIDTH, HEIGHT, {
    tick: ticks.listening,
    state: "listening",
  });
  await save("overlay-dark.png", dark);

  const cell = 220,
    sheet = plain(cell * STYLES.length, cell * STATES.length, BACKGROUND);
  STATES.forEach((state, row) =>
    STYLES.forEach((style, col) => {
      drawMascot(sheet, cell * STYLES.length, cell * STATES.length, {
        ...pose(ticks[state] / FPS, state),
        x: col * cell + 10,
        y: row * cell + 10,
        size: 200,
        style,
        state,
      });
    }),
  );
  await save("styles.png", sheet, cell * STYLES.length, cell * STATES.length);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2]) {
    console.error("Give the folder for the pictures: node render.mjs OUT_DIR");
    process.exit(2);
  }
  await main(resolve(process.argv[2]));
}
