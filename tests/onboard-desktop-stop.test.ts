import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopDesktopService } from "../src/onboard/system.js";
import { takeProcessLock } from "../src/process-lock.js";

const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

/** A stand-in service: it removes its owner lock on SIGTERM, then leaves. */
async function service(state: string) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { unlinkSync } = require("node:fs");
       process.on("SIGTERM", () => { setTimeout(() => { unlinkSync(process.argv[1]); process.exit(0); }, 50); });
       console.log("up"); setInterval(() => {}, 1000);`,
      join(state, "owner.lock"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((done) => child.stdout.once("data", done));
  writeFileSync(join(state, "owner.lock"), JSON.stringify({ pid: child.pid }), {
    mode: 0o600,
  });
  return child;
}

it("ends the desktop service and waits for it, and leaves a desktop that a foreground owner runs", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-stop-")));
  folders.push(base);
  const state = join(base, "desktop");
  mkdirSync(state, { mode: 0o700 });
  const system = { env: { CLAWDTIME_DESKTOP_STATE: state }, home: base };
  const owned = await service(state);
  const owner = takeProcessLock(join(state, "desktop-owner.lock"), {
    pid: process.pid,
  });
  await expect(stopDesktopService(system)).rejects.toThrow(
    "desktop_owned_in_foreground",
  );
  expect(owned.exitCode).toBeNull();
  owner!.release();
  const ended = new Promise((done) => owned.once("exit", done));
  await stopDesktopService(system);
  await ended;
  expect(existsSync(join(state, "owner.lock"))).toBe(false);
  // Nothing runs now: a second stop has nothing to do.
  await stopDesktopService(system);
}, 20_000);
