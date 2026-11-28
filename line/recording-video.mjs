// The caller's video of a recorded call, as MP4 files. ffmpeg encodes it: it reads raw I420 pictures on its input
// and writes one MP4 file. A timer sends the newest picture at a fixed rate, so a fast or slow track gives a file with
// the right length. When the size of the picture changes (a phone turns), the file ends and a new one starts.
// The agent's own picture (the stone or the shared screen) is not recorded.
import { spawn } from "node:child_process";
import { chmodSync, closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";

/** Pictures per second in a video file. */
export const VIDEO_FPS = 10;
/** At most this many video files for one call. */
export const VIDEO_PARTS = 20;

/**
 * Resolves true when the ffmpeg command answers. The line agent asks once, when the call starts, and does not wait
 * for the answer: the call's audio never waits for it.
 */
export function ffmpegAnswers(command = "ffmpeg", run = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = run(command, ["-hide_banner", "-version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(false);
    }, 5000);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** The ffmpeg arguments for one file. The output file is the last argument. */
export function encoderArguments({
  width,
  height,
  fps = VIDEO_FPS,
  file,
  platform = process.platform,
}) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "yuv420p",
    "-s",
    `${width}x${height}`,
    "-r",
    String(fps),
    "-i",
    "pipe:0",
    "-an",
    // H.264 needs an even width and height.
    "-vf",
    "crop=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    platform === "darwin" ? "h264_videotoolbox" : "libx264",
    "-b:v",
    "1500k",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    // The file is made first, for its owner only; ffmpeg writes into it and keeps that mode.
    "-y",
    file,
  ];
}

/**
 * The video side of one recording. `feed` takes each picture of the track; only the newest one waits. `stop` ends
 * the file that is open and gives the files that were made, or the reason that there are none.
 */
export function makeVideoCapture({
  folder,
  spawn,
  command = "ffmpeg",
  I420,
  fps = VIDEO_FPS,
  interval,
  log = () => {},
  closeMs = 15000,
}) {
  let newest = null,
    encoder = null,
    stopped = false,
    failed = null,
    cancel = null;
  const files = [];
  const finished = [];
  const end = (current) => {
    if (!current || current.ended) return;
    current.ended = true;
    finished.push(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            current.child.kill("SIGKILL");
          } catch {}
          resolve();
        }, closeMs);
        timer.unref?.();
        current.closed.then(() => {
          clearTimeout(timer);
          owned(current.file);
          resolve();
        });
        try {
          current.child.stdin.end();
        } catch {
          resolve();
        }
      }),
    );
  };
  /** For its owner only, also when an encoder made it with another mode. */
  const owned = (file) => {
    try {
      chmodSync(file, 0o600);
    } catch {}
  };
  const start = (width, height) => {
    if (files.length >= VIDEO_PARTS) {
      failed ??=
        "The call had too many video sizes. The first video parts are kept.";
      return null;
    }
    const name = `video-${files.length + 1}.mp4`;
    const file = join(folder, name);
    try {
      closeSync(
        openSync(
          file,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ),
      );
    } catch {
      failed ??= "The video file could not be made, so video is not recorded.";
      return null;
    }
    let child;
    try {
      child = spawn(command, encoderArguments({ width, height, fps, file }), {
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      failed ??= "ffmpeg did not start, so video is not recorded.";
      return null;
    }
    const closed = new Promise((resolve) => {
      child.on("close", (code) => {
        if (code !== 0 && !current.ended)
          failed ??= "ffmpeg stopped during the call. The video may be short.";
        resolve(code);
      });
      child.on("error", () => {
        failed ??= "ffmpeg did not start, so video is not recorded.";
        resolve(null);
      });
    });
    child.stdin.on?.("error", () => {});
    const current = {
      child,
      file,
      closed,
      width,
      height,
      ended: false,
      blocked: false,
    };
    files.push(name);
    log("recording_video", { code: "part_started" });
    return current;
  };
  const send = () => {
    if (stopped || !newest) return;
    let frame = newest;
    try {
      if (frame.type !== I420) frame = frame.convert(I420);
    } catch {
      return;
    }
    if (
      !encoder ||
      encoder.width !== frame.width ||
      encoder.height !== frame.height
    ) {
      end(encoder);
      encoder = start(frame.width, frame.height);
    }
    if (!encoder || encoder.ended || encoder.blocked) return;
    // A slow encoder skips pictures; it never makes the call wait.
    const ok = encoder.child.stdin.write(frame.data);
    if (!ok) {
      const current = encoder;
      current.blocked = true;
      current.child.stdin.once?.("drain", () => {
        current.blocked = false;
      });
    }
  };
  cancel = interval(send, 1000 / fps);
  return {
    feed(frame) {
      if (!stopped) newest = frame;
    },
    get started() {
      return files.length > 0;
    },
    async stop() {
      if (stopped) return { files, reason: failed };
      stopped = true;
      cancel?.();
      end(encoder);
      await Promise.all(finished);
      return { files, reason: failed };
    },
  };
}
