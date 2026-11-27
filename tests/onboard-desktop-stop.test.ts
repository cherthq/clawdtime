import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
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

/** A stand-in service, run as the task server is: it removes its owner lock
 * on SIGTERM, then leaves. */
async function service(state: string) {
  const script = join(state, "..", "task-server.js");
  writeFileSync(
    script,
    `const { unlinkSync } = require("node:fs");
     process.on("SIGTERM", () => { setTimeout(() => { unlinkSync(process.argv[2]); process.exit(0); }, 50); });
     console.log("up"); setInterval(() => {}, 1000);`,
  );
  const child = spawn(process.execPath, [script, join(state, "owner.lock")], {
    stdio: ["ignore", "pipe", "inherit"],
  });
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

it("sends no signal when the owner lock names a process that is not the desktop service", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-stop-")));
  folders.push(base);
  const state = join(base, "desktop");
  mkdirSync(state, { mode: 0o700 });
  const system = { env: { CLAWDTIME_DESKTOP_STATE: state }, home: base };
  // A process of this user that began before the lock, but is no service.
  const before = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  await new Promise((done) => before.once("spawn", done));
  await new Promise((done) => setTimeout(done, 1100));
  writeFileSync(
    join(state, "owner.lock"),
    JSON.stringify({ pid: before.pid }),
    {
      mode: 0o600,
    },
  );
  // A process that took the id of an ended service: it runs a task server,
  // but it began after the lock was written.
  const after = spawn(process.execPath, [
    "-e",
    "setInterval(() => {}, 1000)",
    "scripts/task-server.js",
  ]);
  await new Promise((done) => after.once("spawn", done));
  try {
    await expect(stopDesktopService(system)).rejects.toThrow(
      "desktop_not_verified",
    );
    writeFileSync(
      join(state, "owner.lock"),
      JSON.stringify({ pid: after.pid }),
      { mode: 0o600 },
    );
    const written = Date.now() / 1000 - 5;
    utimesSync(join(state, "owner.lock"), written, written);
    await expect(stopDesktopService(system)).rejects.toThrow(
      "desktop_not_verified",
    );
    await new Promise((done) => setTimeout(done, 300));
    expect(before.exitCode).toBeNull();
    expect(before.signalCode).toBeNull();
    expect(after.exitCode).toBeNull();
    expect(after.signalCode).toBeNull();
    // The lock is not this setup's to remove.
    expect(existsSync(join(state, "owner.lock"))).toBe(true);
  } finally {
    before.kill("SIGKILL");
    after.kill("SIGKILL");
  }
}, 20_000);
