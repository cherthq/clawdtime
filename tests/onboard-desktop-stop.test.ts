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
import { macPorts, stopDesktopService } from "../src/onboard/system.js";
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

/** The real ports, with a desktop start that starts a stand-in service. */
function portsWith(base: string, state: string, app: boolean) {
  const started: ReturnType<typeof spawn>[] = [];
  const ports = macPorts({
    env: { CLAWDTIME_DESKTOP_STATE: state },
    home: base,
    root: base,
    app,
    command: { executable: process.execPath, args: [] },
    startDesktop: async () => {
      started.push(await service(state));
    },
  });
  return { ports, started };
}

it("remembers the desktop that an app setup started, by its process, and stops only that one", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-stop-")));
  folders.push(base);
  const state = join(base, "desktop");
  mkdirSync(state, { mode: 0o700 });
  const { ports, started } = portsWith(base, state, true);
  expect(await ports.desktop.setupStarted!()).toBe(false);
  await ports.desktop.start(() => {});
  const ours = started[0]!;
  // A later setup run (a new process with new ports) knows it too.
  const later = portsWith(base, state, true).ports;
  expect(await later.desktop.setupStarted!()).toBe(true);
  // While a foreground owner holds it, it is that owner's.
  const owner = takeProcessLock(join(state, "desktop-owner.lock"), {
    pid: process.pid,
  });
  expect(await later.desktop.setupStarted!()).toBe(false);
  owner!.release();
  const ended = new Promise((done) => ours.once("exit", done));
  await later.desktop.stop!();
  await ended;
  expect(await later.desktop.setupStarted!()).toBe(false);
}, 20_000);

it("never stops a desktop that setup did not start, and Terminal setup leaves none to adopt", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-stop-")));
  folders.push(base);
  const state = join(base, "desktop");
  mkdirSync(state, { mode: 0o700 });
  // The person's own desktop runs: setup found it, it did not start it.
  const own = await service(state);
  try {
    const { ports } = portsWith(base, state, true);
    expect(await ports.desktop.setupStarted!()).toBe(false);
    await ports.desktop.stop!();
    await new Promise((done) => setTimeout(done, 300));
    expect(own.exitCode).toBeNull();
    expect(own.signalCode).toBeNull();
  } finally {
    const ended = new Promise((done) => own.once("exit", done));
    own.kill("SIGTERM");
    await ended;
  }
  // Terminal setup starts a desktop that is the person's: no app run adopts
  // it, but a Stop while it starts still ends it.
  const terminal = portsWith(base, state, false);
  await terminal.ports.desktop.start(() => {});
  expect(await terminal.ports.desktop.setupStarted!()).toBe(false);
  expect(await portsWith(base, state, true).ports.desktop.setupStarted!()).toBe(
    false,
  );
  const ended = new Promise((done) => terminal.started[0]!.once("exit", done));
  await terminal.ports.desktop.stop!();
  await ended;
}, 20_000);
