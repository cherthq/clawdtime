import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundLifecycle } from "../src/control/background-lifecycle.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
const owner = {
  taskId: "fixture-task",
  sessionId: "fixture-session",
  driverPid: 77,
};
function fixture() {
  const folder = mkdtempSync(
    join(tmpdir(), "clawdtime-background-owner-test-"),
  );
  folders.push(folder);
  const path = join(folder, "driver-owner.json");
  return { folder, path, lifecycle: new BackgroundLifecycle(path) };
}
describe("durable background daemon lifecycle ownership", () => {
  it("allows exactly one owner and releases only after known cleanup", () => {
    const f = fixture();
    f.lifecycle.acquire(owner);
    const contender = new BackgroundLifecycle(f.path);
    expect(() => contender.acquire({ ...owner, taskId: "other" })).toThrow();
    f.lifecycle.assert(owner.taskId, owner.sessionId, owner.driverPid);
    f.lifecycle.release(false);
    expect(existsSync(f.path)).toBe(true);
    expect(() => contender.acquire(owner)).toThrow();
    f.lifecycle.release(true);
    expect(existsSync(f.path)).toBe(false);
    contender.acquire({ ...owner, taskId: "other" });
    contender.release(true);
  });
  it("retains a crashed owner's record even when its PID is absent or old", () => {
    const f = fixture();
    f.lifecycle.acquire(owner);
    const saved = JSON.parse(readFileSync(f.path, "utf8"));
    writeFileSync(
      f.path,
      JSON.stringify({ ...saved, supervisorPid: 2147483647 }),
    );
    const restarted = new BackgroundLifecycle(f.path);
    expect(() => restarted.acquire(owner)).toThrow();
    expect(existsSync(f.path)).toBe(true);
  });
  it("never clears a changed or replaced owner, including a same-task replacement", () => {
    const f = fixture();
    f.lifecycle.acquire(owner);
    unlinkSync(f.path);
    const replacement = new BackgroundLifecycle(f.path);
    replacement.acquire(owner);
    const bytes = readFileSync(f.path, "utf8");
    expect(() =>
      f.lifecycle.assert(owner.taskId, owner.sessionId, owner.driverPid),
    ).toThrow();
    expect(() => f.lifecycle.release(true)).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
    replacement.release(true);
  });
  it("detects in-place corruption at assertion and preserves evidence at release", () => {
    const f = fixture();
    f.lifecycle.acquire(owner);
    writeFileSync(f.path, "partial owner record");
    expect(() =>
      f.lifecycle.assert(owner.taskId, owner.sessionId, owner.driverPid),
    ).toThrow();
    expect(() => f.lifecycle.release(true)).toThrow();
    expect(readFileSync(f.path, "utf8")).toBe("partial owner record");
  });
  it("does not adopt a mutated caller object as a new task identity", () => {
    const f = fixture();
    const mutable = { ...owner };
    f.lifecycle.acquire(mutable);
    mutable.taskId = "unexpected-task";
    expect(() =>
      f.lifecycle.assert(owner.taskId, owner.sessionId, owner.driverPid),
    ).not.toThrow();
    expect(() =>
      f.lifecycle.assert(mutable.taskId, owner.sessionId, owner.driverPid),
    ).toThrow();
    f.lifecycle.release(true);
  });
  it.each([
    { ...owner, driverPid: 0 },
    { ...owner, driverPid: Number.NaN },
    { ...owner, sessionId: "" },
    { ...owner, taskId: "invalid/path" },
  ])(
    "rejects malformed identity before creating a durable owner: %j",
    (invalid) => {
      const f = fixture();
      expect(() => f.lifecycle.acquire(invalid)).toThrow();
      expect(existsSync(f.path)).toBe(false);
    },
  );
  it("never persists extra caller fields or follows a substituted owner symlink", () => {
    const f = fixture();
    const augmented = {
      ...owner,
      untrustedSurface: "Private fixture text must not be retained",
    };
    try {
      f.lifecycle.acquire(augmented);
    } catch {
      /* Strict rejection is also acceptable. */
    }
    if (!existsSync(f.path)) f.lifecycle.acquire(owner);
    expect(readFileSync(f.path, "utf8")).not.toContain("Private fixture");
    const target = join(f.folder, "unrelated.json");
    writeFileSync(target, "unrelated", { mode: 0o600 });
    unlinkSync(f.path);
    symlinkSync(target, f.path);
    expect(() =>
      f.lifecycle.assert(owner.taskId, owner.sessionId, owner.driverPid),
    ).toThrow();
    expect(() => f.lifecycle.release(true)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("unrelated");
  });
  it("requires a private actual owner directory", () => {
    const f = fixture();
    chmodSync(f.folder, 0o755);
    expect(() => new BackgroundLifecycle(f.path)).toThrow("private");
  });
});
