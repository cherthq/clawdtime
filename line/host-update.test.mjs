import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const host = fileURLToPath(new URL("./host.sh", import.meta.url));

/**
 * A checkout of main one commit behind its origin, with this host.sh in its
 * line/ folder. npm and tmux are fakes: npm writes each call to a log and
 * fails its build while the file "build-fails" is there; tmux says that no
 * session runs, so nothing is started or stopped.
 */
function checkout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-update-")));
  const work = join(root, "work");
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(join(work, "line"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(state, { mode: 0o700 });
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    CLAWDTIME_LINE_STATE: state,
    CLAWDTIME_LINE_SESSION: "clawdtime-update-fixture",
    CLAWDTIME_LINE_ENV_FILE: join(root, "env.local"),
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd: work, env, encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/npm.log'\nif [ "$1" = run ] && [ -f '${root}/build-fails' ]; then exit 1; fi\nexit 0\n`,
  );
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "tmux"), 0o755);
  git("init", "--quiet", "--initial-branch=main");
  copyFileSync(host, join(work, "line", "host.sh"));
  chmodSync(join(work, "line", "host.sh"), 0o755);
  writeFileSync(join(work, "package-lock.json"), "{}\n");
  writeFileSync(join(work, "line", "package.json"), "{}\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  const first = git("rev-parse", "HEAD");
  git("clone", "--quiet", "--bare", work, join(root, "origin.git"));
  git("remote", "add", "origin", join(root, "origin.git"));
  // The next main changes the lock file, so it needs npm ci and a build.
  writeFileSync(join(work, "package-lock.json"), '{"lockfileVersion":3}\n');
  git("commit", "--quiet", "-am", "second");
  git("push", "--quiet", "origin", "main");
  git("reset", "--quiet", "--hard", first);
  const update = () => {
    rmSync(join(root, "npm.log"), { force: true });
    const result = spawnSync(
      "/bin/sh",
      [join(work, "line", "host.sh"), "update"],
      {
        env,
        encoding: "utf8",
      },
    );
    const npm = existsSync(join(root, "npm.log"))
      ? readFileSync(join(root, "npm.log"), "utf8").trim().split("\n")
      : [];
    return { ...result, npm };
  };
  return { root, git, update, first };
}

test("update: a build that failed after main moved is built again on the next run", () => {
  const f = checkout();
  try {
    writeFileSync(join(f.root, "build-fails"), "");
    const failed = f.update();
    assert.notEqual(failed.status, 0, failed.stdout);
    assert.deepEqual(failed.npm, ["ci --silent", "run --silent build"]);
    assert.match(failed.stdout, /build .*failed/);
    rmSync(join(f.root, "build-fails"));
    // main is at the new commit now; the build still runs, with npm ci, as
    // the last build that passed was of the first commit.
    const again = f.update();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(again.npm, ["ci --silent", "run --silent build"]);
    assert.match(again.stdout, /built [0-9a-f]+; not running/);
    // Once it built, nothing is left to do.
    const after = f.update();
    assert.equal(after.status, 0, after.stderr);
    assert.deepEqual(after.npm, []);
    assert.match(after.stdout, /up to date/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("update: a build that passes needs nothing on the next run", () => {
  const f = checkout();
  try {
    const built = f.update();
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.deepEqual(built.npm, ["ci --silent", "run --silent build"]);
    assert.notEqual(f.git("rev-parse", "HEAD"), f.first);
    const after = f.update();
    assert.deepEqual(after.npm, []);
    assert.match(after.stdout, /up to date/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
