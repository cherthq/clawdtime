import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("a bin symlink executes the actual CLI help rather than silently exiting", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-cli-entry-"));
  try {
    const entry = join(directory, "clawdtime.ts");
    symlinkSync(resolve("cli/main.ts"), entry);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
        env: { PATH: process.env.PATH, VITEST: "true" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ClawdTime internal build");
    expect(result.stdout).toContain("computer status");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
