import { spawn } from "node:child_process";

export const CAPTURE_WIDTH = 2560,
  CAPTURE_HEIGHT = 1440;
export const FRAME_MAX_AGE = 500;
export const videoFPS = (value) =>
  [10, 20, 30].includes(Number(value)) ? Number(value) : 20;
// Names select screens independently of the number of attached cameras.
// CGGetActiveDisplayList returns the main display first (Apple), as used by ffmpeg.
export const mainScreenDevice = "Capture screen 0";

/** PPM preserves the actual aspect/dimensions on EVERY frame. It needs no
 * guessed Retina factor or padding metadata. Bounded storage: header + one
 * partial RGB frame; a push retains only the newest complete frame. */
export function makeFrameDecoder() {
  let header = [],
    pixels = null,
    used = 0,
    width = 0,
    height = 0;
  return {
    push(chunk) {
      let offset = 0,
        newest = null;
      while (offset < chunk.length) {
        if (!pixels) {
          header.push(chunk[offset++]);
          if (header.length > 80) throw Error("Invalid frame header");
          if (header.at(-1) !== 10) continue;
          const text = Buffer.from(header).toString("ascii");
          const match = /^P6\n([0-9]{1,5}) ([0-9]{1,5})\n255\n$/.exec(text);
          if (!match) {
            if (header.filter((c) => c === 10).length >= 3)
              throw Error("Invalid frame header");
            continue;
          }
          width = Number(match[1]);
          height = Number(match[2]);
          if (
            !width ||
            !height ||
            width > CAPTURE_WIDTH ||
            height > CAPTURE_HEIGHT
          )
            throw Error("Frame exceeds capture budget");
          pixels = new Uint8Array(width * height * 3);
          used = 0;
          header = [];
        }
        const count = Math.min(pixels.length - used, chunk.length - offset);
        pixels.set(chunk.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used === pixels.length) {
          newest = { data: pixels, width, height };
          pixels = null;
          used = 0;
        }
      }
      return newest;
    },
    clear() {
      header = [];
      pixels = null;
      used = 0;
    },
  };
}

/** One stream for a whole sharing interval; zoom and layout never reach ffmpeg.
 * No audio capture. No stored media. Never return a frozen frame as live. */
export function startContinuousScreen({
  start = spawn,
  command = "ffmpeg",
  device = mainScreenDevice,
  fps = 20,
  now = Date.now,
  onExit,
} = {}) {
  const decoder = makeFrameDecoder();
  const child = start(
    command,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-capture_cursor",
      "1",
      "-framerate",
      String(videoFPS(fps)),
      "-pixel_format",
      "uyvy422",
      "-i",
      `${device}:none`,
      "-vf",
      `fps=${videoFPS(fps)},scale=${CAPTURE_WIDTH}:${CAPTURE_HEIGHT}:force_original_aspect_ratio=decrease`,
      "-threads",
      "1",
      "-c:v",
      "ppm",
      "-pix_fmt",
      "rgb24",
      "-f",
      "image2pipe",
      "-",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let frame = null,
    stopped = false,
    ended = false;
  const waiting = new Set();
  const settle = (value) => {
    for (const fn of waiting) fn(value);
    waiting.clear();
  };
  const end = (code) => {
    if (ended) return;
    ended = true;
    frame = null;
    decoder.clear();
    settle(false);
    if (!stopped) onExit?.(code);
  };
  child.stdout.on("data", (chunk) => {
    if (stopped || ended) return;
    try {
      const decoded = decoder.push(chunk);
      if (decoded) {
        frame = { ...decoded, at: now() };
        settle(true);
      }
    } catch {
      end(null);
      child.kill("SIGTERM");
    }
  });
  child.on("exit", end);
  child.on("error", () => end(null));
  const latest = () => {
    if (frame && (now() - frame.at > FRAME_MAX_AGE || now() < frame.at))
      frame = null;
    return frame;
  };
  return {
    latest,
    // Non-main custom devices may still be viewed, but must never receive main-display targets.
    supportsAutomaticZoom: device === mainScreenDevice,
    started(ms = 4000) {
      if (latest()) return Promise.resolve(true);
      if (stopped || ended) return Promise.resolve(false);
      return new Promise((resolve) => {
        const done = (value) => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve(value);
        };
        const timer = setTimeout(() => done(false), ms);
        waiting.add(done);
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      frame = null;
      decoder.clear();
      settle(false);
      if (!ended) child.kill("SIGTERM");
    },
  };
}
