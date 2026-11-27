import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { processLockHolder, takeProcessLock } from "../src/process-lock.js";

const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

it("lets one process hold the lock, and frees it when that process is killed", async () => {
  const folder = mkdtempSync(join(tmpdir(), "clawdtime-lock-"));
  folders.push(folder);
  const path = join(folder, "connection.lock");
  expect(processLockHolder(path)).toBeNull();
  // Reading who holds it makes no file.
  expect(() => statSync(path)).toThrow();
  const holder = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `const { takeProcessLock } = await import(${JSON.stringify(resolve("src/process-lock.ts"))});
       const lock = takeProcessLock(${JSON.stringify(path)}, { pid: process.pid, instanceId: "instance_made_up" });
       console.log(lock ? "held" : "busy");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const said = await new Promise<string>((done) =>
    holder.stdout.once("data", (chunk: Buffer) => done(chunk.toString())),
  );
  expect(said.trim()).toBe("held");
  expect(processLockHolder(path)).toEqual({
    pid: holder.pid,
    instanceId: "instance_made_up",
  });
  expect(takeProcessLock(path, { pid: process.pid })).toBeNull();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  holder.kill("SIGKILL");
  await new Promise((done) => holder.once("exit", done));
  // The kernel ended the lock with its process: nothing stale is left.
  expect(processLockHolder(path)).toBeNull();
  const mine = takeProcessLock(path, { pid: process.pid });
  expect(mine).not.toBeNull();
  expect(processLockHolder(path)).toEqual({ pid: process.pid });
  mine!.release();
  expect(processLockHolder(path)).toBeNull();
}, 20_000);
