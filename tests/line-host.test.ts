import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  kill-session) rm -f '${base}/session' ;;
esac`,
  );
  stand(
    "crontab",
    `if [ "$1" = "-l" ]; then [ -f '${base}/crontab' ] && cat '${base}/crontab' || exit 1; else cat > '${base}/crontab'; fi`,
  );
  const env = {
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
  chmodSync(join(upstream, "line", "host.sh"), 0o755);
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

describe("the host script of the line agent", () => {
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
});
