// Synthetic media only: no display, device, credentials, service or phone access.
// Run: npm --prefix line run benchmark:zoom
import { spawn, execFileSync } from "node:child_process";
import { cpus } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { startContinuousScreen } from "./continuous-screen.mjs";
import { makeCamera } from "./camera.mjs";
import { makeVideoRenderer } from "./video-transform.mjs";
import { makePicture } from "./picture.mjs";

const seconds = 3;
const percentile = (xs, p) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))
  ] ?? 0;
const rounded = (n) => Math.round(n * 100) / 100;
const completed = (child) =>
  new Promise((resolve, reject) => {
    let diagnostic = "";
    child.stderr.on("data", (b) => {
      diagnostic = (diagnostic + b).slice(-8000);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== 255) {
        reject(Error("Synthetic ffmpeg failed"));
        return;
      }
      const cpu = /utime=([\d.]+)s stime=([\d.]+)s rtime=([\d.]+)s/.exec(
        diagnostic,
      );
      resolve(
        cpu
          ? {
              cpuMs: (Number(cpu[1]) + Number(cpu[2])) * 1000,
              wallMs: Number(cpu[3]) * 1000,
            }
          : null,
      );
    });
  });

async function run(fps, layout) {
  let captureProcess, captureDone;
  const screen = startContinuousScreen({
    fps,
    start: () => {
      captureProcess = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-benchmark",
          "-loglevel",
          "info",
          "-re",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=2560x1440:rate=${fps}`,
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
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      captureDone = completed(captureProcess);
      return captureProcess;
    },
  });
  const encoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-benchmark",
      "-loglevel",
      "info",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      "1280x720",
      "-r",
      String(fps),
      "-i",
      "-",
      "-threads",
      "1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "h264",
      "-",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let bytes = 0;
  encoder.stdout.on("data", (b) => {
    bytes += b.length;
  });
  encoder.stdin.on("error", () => {});
  const encoded = completed(encoder);
  const timeout = setTimeout(() => {
    screen.stop();
    encoder.kill("SIGTERM");
  }, 15000);
  const renderer = makeVideoRenderer(),
    picture = makePicture({ fps, layout });
  const camera = makeCamera({ since: 0 });
  const s = {
    displayId: "1",
    width: 1280,
    height: 720,
    scale: 2,
    appId: "test.fixture",
    windowId: "1",
    window: { x: 0, y: 0, w: 1280, h: 720 },
  };
  const durations = [],
    delay = monitorEventLoopDelay({ resolution: 2 });
  let count = 0,
    dropped = 0,
    reused = 0,
    previous = null,
    sequence = 0;
  try {
    if (!(await screen.started(5000)))
      throw Error("Synthetic source did not start");
    const start = performance.now(),
      cpu = process.cpuUsage();
    delay.enable();
    for (let tick = 0; tick < fps * seconds; tick++) {
      await pause(Math.max(0, start + (tick * 1000) / fps - performance.now()));
      const f = screen.latest();
      if (!f || encoder.stdin.writableLength > 0) {
        dropped++;
        continue;
      }
      if (f === previous) reused++;
      previous = f;
      const now = Date.now();
      camera.event({
        version: 1,
        producerId: "benchmark",
        sequence: ++sequence,
        commandSeq: 1,
        at: now,
        expiresAt: now + 1400,
        kind: "typing",
        reducedMotion: false,
        surface: s,
        target: {
          x: 250 + Math.floor(tick / fps) * 180,
          y: 280,
          w: 180,
          h: 30,
        },
      });
      const before = performance.now();
      const out = picture.frame(
        tick,
        "speaking",
        renderer.render(f, camera.crop(f), layout),
      );
      durations.push(performance.now() - before);
      // Copy once for asynchronous encoding; at most one frame can wait on stdin.
      encoder.stdin.write(Buffer.from(out));
      count++;
    }
    const wall = performance.now() - start,
      used = process.cpuUsage(cpu);
    delay.disable();
    screen.stop();
    encoder.stdin.end();
    const [captureCPU, encodeCPU] = await Promise.all([captureDone, encoded]);
    return {
      fps,
      layout,
      frames: count,
      skipped: dropped,
      reusedSource: reused,
      renderMs: {
        p50: rounded(percentile(durations, 0.5)),
        p95: rounded(percentile(durations, 0.95)),
      },
      eventLoopDelayMs: {
        p95: rounded(delay.percentile(95) / 1e6),
        max: rounded(delay.max / 1e6),
      },
      nodeCorePercent: rounded(((used.user + used.system) / 1000 / wall) * 100),
      syntheticCaptureCorePercent:
        captureCPU && rounded((captureCPU.cpuMs / captureCPU.wallMs) * 100),
      softwareEncodeCorePercent:
        encodeCPU && rounded((encodeCPU.cpuMs / encodeCPU.wallMs) * 100),
      h264Mbps: rounded((bytes * 8) / (count / fps) / 1e6),
      animationSamples: fps * 0.4,
      maxRSSMiB: rounded(process.resourceUsage().maxRSS / 1024),
    };
  } finally {
    clearTimeout(timeout);
    delay.disable();
    screen.stop();
    encoder.stdin.end();
  }
}

console.log(
  JSON.stringify({
    fixture:
      "ffmpeg lavfi testsrc2, 2560x1440 RGB; 1280x720 RGBA; x264 ultrafast CRF23, no physical capture/network",
    node: process.version,
    cpu: cpus()[0].model,
    seconds,
    ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split(
      "\n",
    )[0],
  }),
);
for (const fps of [10, 20, 30])
  for (const layout of ["wide", "upright"])
    console.log(JSON.stringify(await run(fps, layout)));
