import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "line",
  "host.sh",
);

/**
 * A checkout of a small repository with the host script in it, its origin, and
 * stand-ins for npm, tmux, chert, crontab and sleep that only write down what
 * they were asked. Nothing here starts a session, a call or a real schedule.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "clawdtime-host-"));
  const bin = join(base, "bin");
  const state = join(base, "state");
  const calls = join(base, "calls.log");
  mkdirSync(bin);
  mkdirSync(state);
  symlinkSync(process.execPath, join(bin, "node"));
  const stand = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stand("npm", `echo "npm $* in $(basename "$PWD")" >> '${calls}'`);
  stand("chert", `echo "chert $*" >> '${calls}'`);
  stand("sleep", "exit 0");
  // tmux: a session exists while the file "session" does.
  stand(
    "tmux",
    `echo "tmux $1" >> '${calls}'
case "$1" in
  has-session) [ -f '${base}/session' ] ;;
  new-session) touch '${base}/session' ;;
  send-keys)
    if [ ! -f '${base}/no-release' ]; then
      if [ -f '${base}/retained' ]; then
        echo '{"code":"dev_stopped","retained":1}' >> '${state}/dev.jsonl'
      else
        echo '{"code":"dev_stopped","retained":0}' >> '${state}/dev.jsonl'
      fi
    fi ;;
  kill-session) rm -f '${base}/session' ;;
esac`,
  );
  stand(
    "crontab",
    `if [ "$1" = "-l" ]; then [ -f '${base}/crontab' ] && cat '${base}/crontab' || exit 1; else cat > '${base}/crontab'; fi`,
  );
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: base,
    CLAWDTIME_LINE_STATE: state,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = join(base, "origin.git");
  const upstream = join(base, "upstream");
  const clone = join(base, "clone");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], {
    env,
  });
  execFileSync("git", ["init", "--quiet", "-b", "main", upstream], { env });
  mkdirSync(join(upstream, "line"));
  copyFileSync(script, join(upstream, "line", "host.sh"));
  copyFileSync(
    resolve(script, "..", "host-receipts.mjs"),
    join(upstream, "line", "host-receipts.mjs"),
  );
  chmodSync(join(upstream, "line", "host.sh"), 0o755);
  writeFileSync(
    join(upstream, "line", "agent.mjs"),
    "// fixture agent; never executed\n",
  );
  writeFileSync(join(upstream, "package-lock.json"), "{}\n");
  writeFileSync(join(upstream, "line", "package-lock.json"), "{}\n");
  writeFileSync(join(upstream, "line", "package.json"), "{}\n");
  writeFileSync(join(upstream, ".gitignore"), "node_modules\n.env.local\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "--quiet", "-m", "first");
  git(upstream, "remote", "add", "origin", origin);
  git(upstream, "push", "--quiet", "origin", "main");
  execFileSync("git", ["clone", "--quiet", origin, clone], { env });
  // What a set-up line agent has: its settings and its dependencies.
  writeFileSync(join(clone, "line", ".env.local"), "AGENT_NAME=clawdtime\n");
  mkdirSync(join(clone, "line", "node_modules"));
  /** A new commit on main of the origin that changes these files. */
  const publish = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(upstream, name), text);
    git(upstream, "add", "-A");
    git(upstream, "commit", "--quiet", "-m", "next");
    git(upstream, "push", "--quiet", "origin", "main");
    return git(upstream, "rev-parse", "HEAD");
  };
  const run = (...args: string[]) => {
    const result = spawnSync(join(clone, "line", "host.sh"), args, {
      env,
      encoding: "utf8",
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  };
  const records = (...codes: string[]) =>
    writeFileSync(
      join(state, "dev.jsonl"),
      codes.map((code) => JSON.stringify({ code })).join("\n") + "\n",
    );
  const called = () =>
    existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return {
    env,
    base,
    clone,
    run,
    publish,
    records,
    called,
    head: () => git(clone, "rev-parse", "HEAD"),
    git: (...args: string[]) => git(clone, ...args),
  };
}

// These tests run real git and shell commands on a small repository. On a busy
// machine one of them can take longer than the usual five seconds.
describe("the host script of the line agent", { timeout: 60_000 }, () => {
  it("knows a call from its records: the newest call record decides", () => {
    const f = fixture();
    expect(f.run("in-call").out.trim()).toBe("no");
    f.records("agent_warm", "call_incoming", "call_accepted", "call_media");
    expect(f.run("in-call").out.trim()).toBe("yes");
    f.records(
      "call_incoming",
      "call_media",
      "call_ended",
      "runtime_observation",
    );
    expect(f.run("in-call").out.trim()).toBe("no");
    f.records("call_incoming", "call_declined");
    expect(f.run("in-call").out.trim()).toBe("no");
  });

  it("does nothing when main did not move", () => {
    const f = fixture();
    const before = f.head();
    expect(f.run("update").out).toContain("up to date");
    expect(f.head()).toBe(before);
    expect(f.called()).toEqual([]);
  });

  it("takes the newest main and builds it; it installs only when a lock file changed", () => {
    const f = fixture();
    const next = f.publish({ "notes.txt": "a change\n" });
    const first = f.run("update");
    expect(first.status).toBe(0);
    expect(f.head()).toBe(next);
    expect(f.called()).toEqual([
      "npm run --silent build in clone",
      "tmux has-session",
    ]);
    expect(first.out).toContain("not running, so nothing was restarted");
    const later = f.publish({
      "package-lock.json": '{"a":1}\n',
      "line/package-lock.json": '{"b":1}\n',
    });
    f.run("update");
    expect(f.head()).toBe(later);
    expect(f.called().slice(2)).toEqual([
      "npm ci --silent in clone",
      "npm run --silent build in clone",
      "npm install --silent in line",
      "tmux has-session",
    ]);
  });

  it("waits while a call runs, and restarts the agent when none runs", () => {
    const f = fixture();
    const before = f.head();
    const next = f.publish({ "notes.txt": "a change\n" });
    f.records("call_incoming", "call_accepted", "call_media");
    expect(f.run("update").out).toContain("a call runs: the update waits");
    expect(f.head()).toBe(before);
    expect(f.called()).toEqual([]);
    // The call ended. The agent runs: it is stopped the gentle way and started again.
    f.records("call_ended", "dev_stopped");
    writeFileSync(join(f.base, "session"), "");
    const done = f.run("update");
    expect(f.head()).toBe(next);
    expect(done.out).toContain("restarted on");
    expect(f.called()).toEqual([
      "npm run --silent build in clone",
      "tmux has-session",
      "tmux has-session",
      "tmux send-keys",
      "tmux kill-session",
      "tmux has-session",
      "tmux new-session",
      "tmux new-window",
    ]);
  });

  it("changes nothing in a checkout that is not a clean main", () => {
    const f = fixture();
    const before = f.head();
    f.publish({ "notes.txt": "a change\n" });
    writeFileSync(join(f.clone, "package-lock.json"), "my own change\n");
    expect(f.run("update").out).toContain("changes of its own");
    expect(f.head()).toBe(before);
    f.git("checkout", "--quiet", "--", "package-lock.json");
    f.git("checkout", "--quiet", "-b", "work");
    expect(f.run("update").out).toContain("not on main (work)");
    expect(f.head()).toBe(before);
    expect(f.called()).toEqual([]);
  });

  it("schedules the update once, keeps other lines of the crontab, and removes only its own line", () => {
    const f = fixture();
    writeFileSync(join(f.base, "crontab"), "0 9 * * * /usr/bin/true\n");
    f.run("schedule");
    f.run("schedule");
    const lines = readFileSync(join(f.base, "crontab"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("0 9 * * * /usr/bin/true");
    expect(lines[1]).toMatch(
      /^\*\/15 \* \* \* \* PATH='.+' '.+\/line\/host\.sh' update >> '.+update\.log' 2>&1 # clawdtime-line update$/,
    );
    expect(f.run("status").out).toContain("Updates are scheduled.");
    f.run("unschedule");
    expect(readFileSync(join(f.base, "crontab"), "utf8")).toBe(
      "0 9 * * * /usr/bin/true\n",
    );
  });

  it("starts chert dev again each time it ends, as after a lost connection, until the stop mark", () => {
    const f = fixture();
    const bin = join(f.base, "bin"),
      state = join(f.base, "state"),
      calls = join(f.base, "calls.log");
    writeFileSync(
      join(f.clone, "line", ".env.local"),
      "AGENT_NAME=clawdtime\nCLAWDTIME_LINE_CHERT_PROJECT=proj_1\n",
    );
    // chert dev ends at once with an error. During its third run the host is stopped.
    writeFileSync(
      join(bin, "chert"),
      `#!/bin/sh\necho "chert $*" >> '${calls}'\n[ "$(grep -c '^chert' '${calls}')" -lt 3 ] || : > '${state}/stopping'\necho '{"code":"transport_unavailable"}'\nexit 1\n`,
    );
    chmodSync(join(bin, "chert"), 0o755);
    const result = f.run("keep", "dev");
    expect(result.status).toBe(0);
    const run = `chert dev --agent clawdtime --env-file ${f.clone}/line/.env.local --project proj_1 --json`;
    expect(f.called()).toEqual([run, run, run]);
    const log = readFileSync(join(state, "host.log"), "utf8")
      .trim()
      .split("\n");
    expect(log).toHaveLength(2);
    for (const line of log)
      expect(line).toMatch(/Z dev ended; it starts again in 10 s$/);
    // The records of each run reach the same file.
    expect(
      readFileSync(join(state, "dev.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(3);
  });

  it("uses the original external env file and never automatically reclaims after guarded dev exits", () => {
    const f = fixture();
    const external = join(f.base, "original env.local");
    writeFileSync(
      external,
      "AGENT_NAME=synthetic-agent\nCLAWDTIME_LINE_CHERT_PROJECT=synthetic-project\n",
    );
    f.env.CLAWDTIME_LINE_ENV_FILE = external;
    f.env.CLAWDTIME_LINE_RETENTION_CONFIG = join(f.base, "retention.json");
    const node = join(f.base, "bin", "node");
    unlinkSync(node);
    writeFileSync(
      node,
      `#!/bin/sh\nif [ "$1" = --input-type=module ]; then echo /synthetic/provider; exit 0; fi\nprintf '%s\\n' "node $*" >> '${f.base}/calls.log'\nexit 1\n`,
    );
    chmodSync(node, 0o755);
    expect(f.run("keep", "dev").status).toBe(0);
    expect(f.called()).toEqual([
      `node --import ${f.clone}/line/provider-retention-preload.mjs /synthetic/provider/dist/src/cli/main.js dev --agent synthetic-agent --env-file ${external} --project synthetic-project --json`,
    ]);
    expect(readFileSync(join(f.base, "state", "host.log"), "utf8")).toContain(
      "guarded dev exited; ownership must be reconciled before another claim",
    );
  });

  it("starts the agent again when its worker closes, and knows only its two programs", () => {
    const f = fixture();
    const bin = join(f.base, "bin"),
      state = join(f.base, "state"),
      calls = join(f.base, "calls.log");
    unlinkSync(join(bin, "node"));
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\necho "node $* in $(basename "$PWD")" >> '${calls}'\n[ "$(grep -c '^node' '${calls}')" -lt 2 ] || : > '${state}/stopping'\nexit 1\n`,
    );
    chmodSync(join(bin, "node"), 0o755);
    expect(f.run("keep", "agent").status).toBe(0);
    const run = `node --env-file=${f.clone}/line/.env.local agent.mjs start in line`;
    expect(f.called()).toEqual([run, run]);
    expect(
      readFileSync(join(state, "host.log"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    const unknown = f.run("keep", "other");
    expect(unknown.status).toBe(2);
    expect(f.called()).toHaveLength(2);
  });

  it("runs the agent of a pinned release, from this folder, and starts nothing for a release that is not whole", () => {
    const f = fixture();
    const bin = join(f.base, "bin"),
      state = join(f.base, "state"),
      calls = join(f.base, "calls.log"),
      release = join(f.base, "release"),
      settings = join(f.clone, "line", ".env.local");
    unlinkSync(join(bin, "node"));
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\necho "node $* in $(basename "$PWD")" >> '${calls}'\n: > '${state}/stopping'\nexit 1\n`,
    );
    chmodSync(join(bin, "node"), 0o755);
    // A release with no dependencies is not whole: no session starts, and no agent runs.
    mkdirSync(release);
    writeFileSync(join(release, "agent.mjs"), "// fixture release\n");
    writeFileSync(
      settings,
      `AGENT_NAME=clawdtime\nCLAWDTIME_LINE_RELEASE=${release}\n`,
    );
    const partial = f.run("start");
    expect(partial.status).toBe(1);
    expect(partial.out).toContain("The selected agent release is incomplete.");
    expect(f.run("keep", "agent").status).toBe(0);
    expect(f.called().filter((line) => line.startsWith("node"))).toEqual([]);
    expect(f.called()).not.toContain("tmux new-session");
    // The keeper says why it ended, in one line of its record.
    const record = readFileSync(join(state, "host.log"), "utf8")
      .trim()
      .split("\n");
    expect(record).toHaveLength(1);
    expect(record[0]).toMatch(
      /Z the agent release is not whole: the agent is not started$/,
    );
    // A release must be an absolute folder.
    writeFileSync(
      settings,
      "AGENT_NAME=clawdtime\nCLAWDTIME_LINE_RELEASE=release\n",
    );
    const relative = f.run("start");
    expect(relative.status).toBe(1);
    expect(relative.out).toContain(
      "Agent release must be an absolute directory.",
    );
    // A whole release: its agent runs, with the settings of this folder.
    mkdirSync(join(release, "node_modules"));
    writeFileSync(
      settings,
      `AGENT_NAME=clawdtime\nCLAWDTIME_LINE_RELEASE=${release}\n`,
    );
    expect(f.run("keep", "agent").status).toBe(0);
    expect(f.called().filter((line) => line.startsWith("node"))).toEqual([
      `node --env-file=${f.clone}/line/.env.local ${release}/agent.mjs start in line`,
    ]);
    expect(f.run("start").out).toContain("Started in the tmux session");
  });

  it("rolls back agent code with an environment override while keeping the guarded host wrapper", () => {
    const f = fixture();
    const baseline = join(f.base, "baseline agent");
    mkdirSync(baseline);
    mkdirSync(join(baseline, "node_modules"));
    writeFileSync(join(baseline, "agent.mjs"), "// synthetic baseline\n");
    writeFileSync(
      join(f.clone, "line", ".env.local"),
      "CLAWDTIME_LINE_RELEASE=/missing/env-file-release\n",
    );
    f.env.CLAWDTIME_LINE_RELEASE = baseline;
    f.env.CLAWDTIME_LINE_RETENTION_CONFIG = join(f.base, "retention.json");
    const node = join(f.base, "bin", "node");
    unlinkSync(node);
    writeFileSync(
      node,
      `#!/bin/sh\nprintf '%s\\n' "node $*" >> '${f.base}/calls.log'\n: > '${f.base}/state/stopping'\n`,
    );
    chmodSync(node, 0o755);
    expect(f.run("keep", "agent").status).toBe(0);
    expect(f.called()).toEqual([
      `node --env-file=${f.clone}/line/.env.local ${baseline}/agent.mjs start`,
    ]);
    const tmux = join(f.base, "bin", "tmux");
    writeFileSync(
      tmux,
      `#!/bin/sh\n[ "$1" != has-session ] || exit 1\nprintf '%s\\n' "$*" >> '${f.base}/tmux-commands'\n`,
    );
    chmodSync(tmux, 0o755);
    expect(f.run("start").status).toBe(0);
    const commands = readFileSync(join(f.base, "tmux-commands"), "utf8");
    expect(commands).toContain(`CLAWDTIME_LINE_RELEASE='${baseline}'`);
    expect(commands).toContain(
      `CLAWDTIME_LINE_RETENTION_CONFIG='${f.base}/retention.json'`,
    );
    expect(commands).toContain(`'${f.clone}/line/host.sh' keep agent`);
    expect(commands).toContain(`'${f.clone}/line/host.sh' keep dev`);
    f.env.CLAWDTIME_LINE_RELEASE = "relative";
    expect(f.run("start").out).toContain(
      "Agent release must be an absolute directory.",
    );
    f.env.CLAWDTIME_LINE_RELEASE = "/" + "x".repeat(4096);
    expect(f.run("start").out).toContain("Agent release path is too long.");
  });

  it("marks the stop before it stops, and a start takes the mark away and starts both keepers", () => {
    const f = fixture();
    const state = join(f.base, "state");
    writeFileSync(join(f.base, "session"), "");
    f.records("agent_warm", "dev_stopped");
    expect(f.run("stop").out).toContain("Stopped.");
    expect(existsSync(join(state, "stopping"))).toBe(true);
    expect(f.run("start").out).toContain("Started in the tmux session");
    expect(existsSync(join(state, "stopping"))).toBe(false);
    expect(f.called()).toEqual([
      "tmux has-session",
      "tmux send-keys",
      "tmux kill-session",
      "tmux has-session",
      "tmux new-session",
      "tmux new-window",
    ]);
  });

  it("starts only with settings and dependencies in place, and prints its use for an unknown word", () => {
    const f = fixture();
    execFileSync("rm", ["-f", join(f.clone, "line", ".env.local")]);
    const missing = f.run("start");
    expect(missing.status).toBe(1);
    expect(missing.out).toContain("No .env.local");
    const use = f.run("nope");
    expect(use.status).toBe(2);
    expect(use.out).toContain("./host.sh update");
  });

  it("does not mistake historical clean release for this shutdown", () => {
    const f = fixture();
    writeFileSync(join(f.base, "session"), "");
    writeFileSync(join(f.base, "no-release"), "");
    writeFileSync(
      join(f.base, "state", "dev.jsonl"),
      '{"code":"dev_stopped","retained":0}\n',
    );
    const result = f.run("stop");
    expect(result.status).toBe(1);
    expect(result.out).toContain("cleanup remains unknown");
    expect(f.called()).not.toContain("tmux kill-session");
    expect(existsSync(join(f.base, "session"))).toBe(true);
  });

  it("retains the session when fresh shutdown reports unfinished call work", () => {
    const f = fixture();
    writeFileSync(join(f.base, "session"), "");
    writeFileSync(join(f.base, "retained"), "");
    f.records("agent_warm");
    expect(f.run("stop").status).toBe(1);
    expect(f.called()).not.toContain("tmux kill-session");
    expect(existsSync(join(f.base, "session"))).toBe(true);
  });

  it("does not restore incoming while an outbound ownership hold exists", () => {
    const f = fixture();
    writeFileSync(join(f.base, "state", "outbound-hold"), "fixture-receipt");
    expect(f.run("start").status).toBe(1);
    expect(f.called()).not.toContain("tmux new-session");
    expect(readFileSync(join(f.base, "state", "outbound-hold"), "utf8")).toBe(
      "fixture-receipt",
    );
  });
});
