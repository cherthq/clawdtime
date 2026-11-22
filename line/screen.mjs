// The Mac's main screen as RGBA frames, for the call's video. ffmpeg reads the screen only while a caller asked
// to see it. It needs ffmpeg on the PATH and the Screen Recording permission for the program that starts it.
import { spawn } from "node:child_process";
import { screenFilter } from "./layout.mjs";

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FPS = 10;
const FRAME_BYTES = WIDTH * HEIGHT * 4;

/** The avfoundation device of the main screen. `ffmpeg -f avfoundation -list_devices true -i ""` lists them. */
export const screenDevice = process.env.CLAWDTIME_LINE_SCREEN_DEVICE || "1";

/**
 * Takes complete frames out of a byte stream. It keeps only the newest complete frame: a slow reader must
 * never queue old pictures. `rest` is the start of the next frame, for the next call.
 */
export function splitFrames(pending, chunk, size = FRAME_BYTES) {
  let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk,
    newest = null;
  while (buffer.length >= size) {
    newest = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
  }
  return { newest, rest: buffer };
}

/**
 * Starts the capture. The screen, or the one part of it in `view`, is fitted into the box of the `layout` with
 * its shape kept, so text keeps its shape. A new view or layout needs a new capture: stop this one, start one.
 *  - `latest()` gives the newest full frame, or null before the first one and after the stop. With
 *    `maxFrameAgeMs`, a frame older than that is dropped too: a capture that stalls shows no old picture.
 *    Without it a frame has no age limit, so a still screen stays on the call.
 *  - `started(ms)` resolves true at the first frame, or false when none came in that time or ffmpeg stopped.
 *  - `stop()` ends ffmpeg.
 * @param {object} [options]
 * @param {(code: number | null) => void} [options.onExit] called when ffmpeg stops by itself
 * @param {string} [options.command] the ffmpeg program
 * @param {string} [options.device] the avfoundation screen device
 * @param {string} [options.layout] "upright" or "wide": see layout.mjs
 * @param {{ x: number, y: number, w: number, h: number } | null} [options.view] one part of the screen, in shares
 * @param {number} [options.maxFrameAgeMs] the oldest frame that `latest()` gives, at most 5000
 * @param {() => number} [options.now] the clock, for a test
 * @param {number} [options.frameBytes] the size of one frame, for a test
 * @param {typeof spawn} [options.start] starts the program, for a test
 */
export function startScreen(options = {}) {
  const size = options.frameBytes ?? FRAME_BYTES;
  const now = options.now ?? Date.now;
  const maxFrameAgeMs = options.maxFrameAgeMs;
  if (
    maxFrameAgeMs !== undefined &&
    (!Number.isFinite(maxFrameAgeMs) ||
      maxFrameAgeMs <= 0 ||
      maxFrameAgeMs > 5000)
  )
    throw Error("Invalid frame freshness bound.");
  const child = (options.start ?? spawn)(
    options.command || "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "avfoundation",
      "-capture_cursor",
      "1",
      "-framerate",
      "30",
      "-pixel_format",
      "uyvy422",
      "-i",
      `${options.device ?? screenDevice}:none`,
      "-vf",
      screenFilter({
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        layout: options.layout,
        view: options.view,
      }),
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let frame = null,
    capturedAt = null,
    pending = Buffer.alloc(0),
    stopped = false,
    ended = false;
  const waiting = new Set();
  const settle = (value) => {
    for (const done of waiting) done(value);
    waiting.clear();
  };
  child.stdout.on("data", (chunk) => {
    if (stopped || ended) return;
    const cut = splitFrames(pending, chunk, size);
    // The frame is a copy: the next chunk must not change a picture that is on its way to the call.
    if (cut.newest) {
      frame = new Uint8Array(cut.newest);
      capturedAt = now();
      settle(true);
    }
    pending = cut.rest;
  });
  const end = (code) => {
    if (ended) return;
    ended = true;
    frame = null;
    settle(false);
    if (!stopped) options.onExit?.(code);
  };
  child.on("exit", (code) => end(code));
  child.on("error", () => end(null));
  return {
    latest: () => {
      if (maxFrameAgeMs === undefined) return frame;
      const at = now();
      if (
        capturedAt === null ||
        !Number.isFinite(at) ||
        at < capturedAt ||
        at - capturedAt > maxFrameAgeMs
      ) {
        frame = null;
        return null;
      }
      return frame;
    },
    started(ms = 4000) {
      if (frame) return Promise.resolve(true);
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
      settle(false);
      if (!ended) child.kill("SIGTERM");
    },
  };
}
