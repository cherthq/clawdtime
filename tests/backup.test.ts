import { it, expect } from "vitest";
import { Store } from "../src/storage/store.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
it("encrypted consistent backup restores receipts into a fresh file and refuses overwrite/wrong key", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawdtime-backup-test-"));
  try {
    const source = join(dir, "state.sqlite"),
      sealed = join(dir, "backup.enc"),
      target = join(dir, "restored.sqlite"),
      store = new Store(source);
    store.putEffect({
      id: "effect",
      kind: "message",
      state: "unknown",
      payload: { private: "fixture" },
      createdAt: 1,
    });
    const run = (args: string[], key = "a".repeat(64)) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("scripts/backup.ts"),
          ...args,
        ],
        {
          env: { ...process.env, CLAWDTIME_BACKUP_KEY: key },
          encoding: "utf8",
        },
      );
    expect(run(["create", source, sealed]).status).toBe(0);
    expect(readFileSync(sealed).includes(Buffer.from("fixture"))).toBe(false);
    expect(run(["restore", sealed, target], "b".repeat(64)).status).not.toBe(0);
    expect(run(["restore", sealed, target]).status).toBe(0);
    expect(run(["restore", sealed, target]).status).not.toBe(0);
    const restored = new Store(target);
    expect(restored.effect("effect")?.state).toBe("unknown");
    restored.close();
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
