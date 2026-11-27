import { spawn, type ChildProcess } from "node:child_process";
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
import { afterEach, describe, expect, it } from "vitest";
import { startCli } from "../cli/start.js";
import {
  linkDesktopFolder,
  linkedDesktopFolder,
} from "../connectors/agents/desktop-chat.js";
import { stopOtherInstall } from "../src/onboard/system.js";
import { takeProcessLock } from "../src/process-lock.js";

// A stand-in for the desktop of another install: a node process whose
// command line is a task server's, and a stand-in panel. Neither opens a
// window or a port. Made-up paths only.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function otherInstall() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-other-")));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const config = join(base, "config");
  const state = join(base, "other install", "desktop");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(config, { mode: 0o700 });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(join(base, "scripts"));
  const server = join(base, "scripts", "task-server.js");
  // It writes its owner lock after it starts, and removes it on SIGTERM.
  writeFileSync(
    server,
    `const { writeFileSync, rmSync } = require("node:fs");
const lock = ${JSON.stringify(join(state, "owner.lock"))};
writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
process.on("SIGTERM", () => { rmSync(lock, { force: true }); process.exit(0); });
setInterval(() => {}, 1000);
`,
  );
  const panel = join(base, "ClawdTimeTaskPanel");
  writeFileSync(
    panel,
    `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
    {
      mode: 0o700,
    },
  );
  const children: ChildProcess[] = [];
  cleanup.push(() => {
    for (const child of children)
      if (child.pid && alive(child.pid)) child.kill("SIGKILL");
  });
  const start = async () => {
    const service = spawn(
      process.execPath,
      [
        server,
        "--state",
        state,
        "--project",
        join(base, "work"),
        "--port",
        "13326",
        "--desktop",
        "true",
      ],
      { stdio: "ignore" },
    );
    const shownPanel = spawn(
      panel,
      ["--config", join(state, "desktop-panel.json"), "--tucked"],
      { stdio: "ignore" },
    );
    children.push(service, shownPanel);
    const deadline = Date.now() + 5000;
    while (!existsSync(join(state, "owner.lock")) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 20));
    // ps gives start times to the second: the lock is written after it.
    await new Promise((done) => setTimeout(done, 50));
    return { service, panel: shownPanel };
  };
  const system = { env: { CLAWDTIME_CONFIG_HOME: config }, home };
  return { base, home, config, state, system, start };
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((done) => child.once("exit", () => done()));

describe("the desktop of another install", () => {
  it("stops only after its own files confirm it, with its panel, and ends a link to it", async () => {
    const other = otherInstall();
    const { service, panel } = await other.start();
    linkDesktopFolder(other.config, other.state);
    expect(linkedDesktopFolder(other.config)).toBe(other.state);
    await stopOtherInstall(
      other.system,
      { port: 13326, pid: service.pid!, state: other.state, verified: true },
      { waitMs: 5000 },
    );
    await Promise.all([exited(service), exited(panel)]);
    expect(alive(service.pid!)).toBe(false);
    expect(alive(panel.pid!)).toBe(false);
    expect(existsSync(join(other.state, "owner.lock"))).toBe(false);
    expect(linkedDesktopFolder(other.config)).toBeNull();
  }, 20_000);

  it("is never stopped when it cannot be confirmed, or when a foreground owner holds it", async () => {
    const other = otherInstall();
    const { service, panel } = await other.start();
    await expect(
      stopOtherInstall(other.system, {
        port: 13326,
        pid: service.pid!,
        state: null,
        verified: false,
      }),
    ).rejects.toThrow("could not be confirmed as a ClawdTime desktop");
    const held = takeProcessLock(join(other.state, "desktop-owner.lock"), {
      version: 1,
      pid: process.pid,
    });
    try {
      await expect(
        stopOtherInstall(other.system, {
          port: 13326,
          pid: service.pid!,
          state: other.state,
          verified: true,
        }),
      ).rejects.toThrow("held by its app or by a Terminal");
    } finally {
      held?.release();
    }
    // Another process id than the one of its owner lock: nothing gets a signal.
    await expect(
      stopOtherInstall(
        other.system,
        { port: 13326, pid: 999_999, state: other.state, verified: true },
        { waitMs: 500 },
      ),
    ).rejects.toThrow("could not be confirmed as a ClawdTime desktop");
    await new Promise((done) => setTimeout(done, 200));
    expect(alive(service.pid!)).toBe(true);
    expect(alive(panel.pid!)).toBe(true);
  }, 20_000);

  it("clawdtime start uses the linked desktop folder, and its own once the folder is gone", async () => {
    const other = otherInstall();
    const checkout = join(other.base, "checkout");
    mkdirSync(join(checkout, "mac", ".build", "debug"), { recursive: true });
    writeFileSync(
      join(checkout, "mac", ".build", "debug", "ClawdTimeTaskPanel"),
      "synthetic executable, never run",
      { mode: 0o700 },
    );
    const states: string[] = [];
    const run = () =>
      startCli([], {
        env: { ...other.system.env },
        home: other.home,
        root: checkout,
        cwd: other.base,
        print: () => {},
        desktop: async (args) => {
          states.push(args[args.indexOf("--state") + 1]!);
        },
      });
    linkDesktopFolder(other.config, other.state);
    await run();
    rmSync(join(other.base, "other install"), { recursive: true, force: true });
    await run();
    expect(states).toEqual([other.state, join(other.config, "desktop")]);
  });
});
