import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const project = "abcdefab-cdef-4abc-8def-abcdefabcdef";
// Values as node --env-file reads them: the last line of a name wins, quotes
// are taken off, and a # after an unquoted value starts a comment.
const envFile = [
  "AGENT_NAME=older-name",
  "AGENT_NAME=clawdtime-fixture # the name of my line",
  `CLAWDTIME_LINE_CHERT_PROJECT="${project}" # my project`,
  "",
].join("\n");

function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-setting-")));
  const bin = join(root, "bin");
  mkdirSync(bin);
  return {
    root,
    bin,
    path: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  };
}

test("host.sh gives chert dev the values of the env file as node reads them", () => {
  const f = folder();
  try {
    const file = join(f.root, "env.local");
    writeFileSync(file, envFile, { mode: 0o600 });
    const state = join(f.root, "state");
    mkdirSync(state, { mode: 0o700 });
    // The mark of ./host.sh stop: keep runs chert dev once and ends.
    writeFileSync(join(state, "stopping"), "");
    writeFileSync(
      join(f.bin, "chert"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${f.root}/chert-args'\n`,
    );
    chmodSync(join(f.bin, "chert"), 0o755);
    const result = spawnSync(
      "/bin/sh",
      [fileURLToPath(new URL("./host.sh", import.meta.url)), "keep", "dev"],
      {
        env: {
          PATH: f.path,
          HOME: f.root,
          CLAWDTIME_LINE_STATE: state,
          CLAWDTIME_LINE_SESSION: "clawdtime-setting-fixture",
          CLAWDTIME_LINE_ENV_FILE: file,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readFileSync(join(f.root, "chert-args"), "utf8").trim().split("\n"),
      [
        "dev",
        "--agent",
        "clawdtime-fixture",
        "--env-file",
        file,
        "--project",
        project,
        "--json",
      ],
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("start.sh names the agent of the env file as node reads it", () => {
  const f = folder();
  try {
    const line = join(f.root, "line");
    mkdirSync(join(line, "node_modules"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("./start.sh", import.meta.url)),
      join(line, "start.sh"),
    );
    writeFileSync(join(line, ".env.local"), envFile, { mode: 0o600 });
    // node runs as itself, except that the agent is not started.
    writeFileSync(
      join(f.bin, "node"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = agent.mjs ] && { echo "the agent would start"; exit 0; }; done\nexec '${process.execPath}' "$@"\n`,
    );
    chmodSync(join(f.bin, "node"), 0o755);
    const result = spawnSync("/bin/sh", [join(line, "start.sh")], {
      env: { PATH: f.path, HOME: f.root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /chert dev --agent "clawdtime-fixture"\n/);
    assert.match(result.stdout, /the agent would start/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
