import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

for (const kind of ["file", "dangling-link"]) {
  test(`scheduled updates honor a ${kind} release hold before touching git`, () => {
    const state = mkdtempSync(join(tmpdir(), "clawdtime-update-hold-"));
    try {
      const hold = join(state, "update-hold");
      if (kind === "file")
        writeFileSync(hold, "Local qualification in progress", { mode: 0o600 });
      else symlinkSync(join(state, "missing"), hold);
      // An empty PATH proves git/node/tmux cannot be invoked while held.
      // dirname and mkdir are needed before update dispatch, so provide only them.
      for (const name of ["dirname", "mkdir", "date"])
        symlinkSync(`/bin/${name}`, join(state, name));
      const result = spawnSync(
        "/bin/sh",
        [new URL("./host.sh", import.meta.url).pathname, "update"],
        {
          env: { ...process.env, PATH: state, CLAWDTIME_LINE_STATE: state },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /local release hold is active: nothing done/);
      assert.doesNotMatch(result.stderr, /git|node|tmux/);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
}
