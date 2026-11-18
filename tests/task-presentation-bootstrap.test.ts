import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function layout() {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-private-boundary-"));
  dirs.push(root);
  const project = join(root, "project"),
    state = join(root, "state");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  return { root, project, state };
}
function launch(state: string, project: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("scripts/task-server.ts"),
      "--state",
      state,
      "--project",
      project,
      ...extra,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
}
it("rejects a state directory named with two leading dots inside the worker project", () => {
  const f = layout();
  const result = launch(join(f.project, "..private"), f.project);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Private task state must be outside");
});
it("rejects operator presentation configuration in a two-dot project descendant", () => {
  const f = layout();
  const dir = join(f.project, "..private");
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, "presentation.json");
  writeFileSync(file, "{}", { mode: 0o600 });
  const result = launch(f.state, f.project, ["--presentation-config", file]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Presentation configuration must be owner-only and outside",
  );
});
