import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrivateJSON } from "../connectors/shared/private-file.js";
import { sharedPairingPaths } from "../src/onboard/pairing.js";
import { managedConnection } from "../src/onboard/system.js";

// Real processes of this user, made by the test, stand in for the shared run.
const folders: string[] = [];
const children: ChildProcess[] = [];
const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It has ended.
    }
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

function home() {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-connection-"));
  folders.push(path);
  return path;
}

/** An unrelated process of this user, as a reused process id would be. */
async function unrelated() {
  const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
  children.push(child);
  await new Promise((done) => child.once("spawn", done));
  return child;
}

const ended = (child: ChildProcess) =>
  new Promise<NodeJS.Signals | null>((done) =>
    child.once("exit", (_code, signal) => done(signal)),
  );

const recordFile = (folder: string) =>
  join(sharedPairingPaths(folder).directory, "onboard-connection.json");

/** A stand-in for `clawdtime shared run`: it stays up, as a live connection does. */
const standIn = {
  executable: process.execPath,
  args: ["-e", "setInterval(() => {}, 1e6)"],
};

describe("the connection that setup manages", () => {
  it("never signals a process whose start time or command differ from its record, and clears the record", async () => {
    const records = (pid: number) => [
      // A record of an earlier release, with no start time or command.
      { version: 1, pid, instanceId: "desktop_old", startedAt: 1 },
      // The same process id, but another start.
      {
        version: 2,
        pid,
        instanceId: "desktop_old",
        startedAt: 1,
        processStart: "Thu Jan  1 00:00:00 2026",
        command: "/bin/sleep 300",
      },
      // The same process id, but another command.
      {
        version: 2,
        pid,
        instanceId: "desktop_old",
        startedAt: 1,
        processStart: "",
        command: `${process.execPath} cli/main.js shared run`,
      },
    ];
    const other = await unrelated();
    for (const record of records(other.pid!)) {
      const folder = home();
      const connection = managedConnection({
        home: folder,
        command: standIn,
        env: {},
      });
      writePrivateJSON(recordFile(folder), record);
      expect(await connection.status("desktop_new")).toBe("stopped");
      expect(existsSync(recordFile(folder))).toBe(false);
      writePrivateJSON(recordFile(folder), record);
      await connection.stop();
      expect(existsSync(recordFile(folder))).toBe(false);
      expect(await connection.holder()).toBeNull();
    }
    // The unrelated process got no signal from any of them.
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    const gone = ended(other);
    other.kill("SIGTERM");
    expect(await gone).toBe("SIGTERM");
  }, 30_000);

  it("stops the connection that it started: the same process, checked before the signal", async () => {
    const folder = home();
    const connection = managedConnection({
      home: folder,
      command: standIn,
      env: { PATH: process.env.PATH },
    });
    await connection.start("desktop_1");
    const pid = (
      JSON.parse(readFileSync(recordFile(folder), "utf8")) as { pid: number }
    ).pid;
    started.push(pid);
    expect(await connection.status("desktop_1")).toBe("running");
    expect(await connection.status("desktop_2")).toBe("stale");
    await connection.stop();
    // It ended: the cleanup must not signal its id again.
    started.splice(started.indexOf(pid), 1);
    expect(await connection.status("desktop_1")).toBe("stopped");
    expect(existsSync(recordFile(folder))).toBe(false);
  }, 30_000);
});
