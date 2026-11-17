/** Local, view-only Finder review. Never opens a call or submits OS input. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { cameraSurfaceSchema } from "../src/camera-contracts.js";

const run = promisify(execFile);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--surface")) {
  throw new Error(
    "Use no arguments for the Finder review window, or --surface JSON for an explicitly selected window.",
  );
}
const binary = resolve("mac/.build/debug/ClawdTimeCompanion");
console.log("Building the local capture helper (no installation)…");
await run("swift", ["build", "--package-path", "mac"], {
  maxBuffer: 2 * 1024 * 1024,
});
let surface;
try {
  const raw = args.length
    ? args[1]!
    : (
        await run(
          binary,
          [
            "--camera-find-window",
            "--query",
            JSON.stringify({
              bundleId: "com.apple.finder",
              title: "ClawdTime Sharing Review",
            }),
          ],
          { timeout: 10000, maxBuffer: 16384 },
        )
      ).stdout;
  surface = cameraSurfaceSchema.parse(JSON.parse(raw));
  if (surface.kind !== "window")
    throw new Error("Select a window for this preview.");
} catch {
  throw new Error(
    "Open /tmp/ClawdTime Sharing Review in Finder and keep its window visible on one display, then retry. Screen Recording permission must already be granted. An explicit --surface must identify a window.",
  );
}
console.log(
  `Selected window ${surface.id} on display ${surface.displayId}. Confirm it is the intended Finder test window before Start; sharing follows that window's contents if you navigate.`,
);
const child = spawn(
  resolve("media/.venv/bin/python"),
  ["media/camera_preview.py", "--config-stdin"],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  },
);
child.stdin.end(
  JSON.stringify({
    mode: "actual",
    surface,
    nativeBinary: binary,
    surfaceLabel: args.length
      ? `Selected window ${surface.id}`
      : "Finder — ClawdTime Sharing Review",
  }) + "\n",
);
const lines = createInterface({ input: child.stdout });
let ready = false,
  failed = false;
const startup = setTimeout(() => {
  console.error("Window preview startup timed out.");
  failed = true;
  stop();
}, 20000);
const lifetime = setTimeout(
  () => {
    console.log("Local preview expired.");
    stop();
  },
  15 * 60 * 1000,
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill("SIGINT");
  const fallback = setTimeout(() => child.kill("SIGTERM"), 3000);
  fallback.unref();
}
lines.once("line", (line) => {
  clearTimeout(startup);
  try {
    const info = JSON.parse(line);
    const url = new URL(info.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.hash)
      throw new Error();
    ready = true;
    console.log(`Actual window preview: ${url.href}`);
    console.log(
      "Press Start sharing in the preview. Only the selected window is captured; no remote control or FaceTime. STOP ends sharing. Ctrl-C exits.",
    );
  } catch {
    console.error("Invalid local preview handshake.");
    failed = true;
    stop();
  }
});
// Avoid echoing captured data or request bodies from child diagnostics.
child.stderr.on("data", () => {});
child.on("error", () => {
  console.error("Could not start the local Python preview.");
  failed = true;
  stop();
});
child.once("close", (code) => {
  clearTimeout(startup);
  clearTimeout(lifetime);
  lines.close();
  if (!ready && !stopping)
    console.error("Local window preview exited before startup.");
  process.exitCode = failed || (!stopping && (!ready || code !== 0)) ? 1 : 0;
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
