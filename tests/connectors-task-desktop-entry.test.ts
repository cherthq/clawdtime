import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { executorEnvironment } from "../connectors/codex/app-server.js";
const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("runs desktop help through a stable installation-directory symlink", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "clawdtime-entry-link-"));
  try {
    const current = join(temporary, "runtime-current");
    symlinkSync(root, current, "dir");
    const result = await run(
      process.execPath,
      ["--import", "tsx", join(current, "cli/task-desktop.ts"), "--help"],
      { cwd: root, env: executorEnvironment(), timeout: 5000 },
    );
    expect(result.stdout).toContain("task:desktop --state PRIVATE_DIR");
    expect(result.stdout).toContain(
      "Startup does not call or capture. It renews the desktop's own expired task session only while no task, call or voice is open.",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it("allows an embedded import with a nonexistent argv entry without accidentally starting", async () => {
  const url = pathToFileURL(join(root, "cli/task-desktop.ts")).href;
  const result = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(url)}); console.log("import-only");`,
      "/nonexistent-clawdtime-entry-test",
    ],
    { cwd: root, env: executorEnvironment(), timeout: 5000 },
  );
  expect(result.stdout.trim()).toBe("import-only");
});
