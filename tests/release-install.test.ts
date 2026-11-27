import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const installer = join(root, "scripts", "install.sh");
const commit = (n: number) => String(n).repeat(40).slice(0, 40);

const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

interface Release {
  version: string;
  commit?: string;
  onboard?: boolean;
  latest?: Record<string, unknown>;
  /** Files put in the archive after the manifest, so it does not list them. */
  unlisted?: Record<string, string>;
}

/**
 * A made-up release in `folder`, in the layout of the runtime builder: the
 * real launcher and the real manifest writer, with a stand-in for Node that
 * runs the Node of this test, and a small command in place of the build.
 */
function publish(folder: string, release: Release) {
  const stage = mkdtempSync(join(tmpdir(), "clawdtime-release-stage-"));
  folders.push(stage);
  const runtime = join(stage, "runtime");
  const file = (path: string, text: string, mode = 0o644) => {
    mkdirSync(join(runtime, path, ".."), { recursive: true });
    writeFileSync(join(runtime, path), text, { mode });
  };
  file("node/bin/node", `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, 0o755);
  file("node/LICENSE", "made-up license\n");
  mkdirSync(join(runtime, "bin"));
  copyFileSync(
    join(root, "scripts/release/launcher.sh"),
    join(runtime, "bin/clawdtime"),
  );
  chmodSync(join(runtime, "bin/clawdtime"), 0o755);
  file("app/native/ClawdTimeTaskPanel", "made-up panel\n", 0o755);
  // Stands in for the desktop service or a connection: it stays up.
  file("app/dist/scripts/task-server.js", "setInterval(() => {}, 1e6);\n");
  file(
    "app/dist/cli/main.js",
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const version = ${JSON.stringify(release.version)};
if (args[0] === "--help") { console.log("made-up clawdtime " + version); process.exit(0); }
if (args[0] === "onboard" && ${release.onboard ? "true" : "false"}) {
  if (args[1] === "--help") { console.log("onboard help"); process.exit(0); }
  fs.writeFileSync(process.env.HOME + "/onboard-ran.json", JSON.stringify({ tty: !!process.stdin.isTTY, version }));
  process.exit(0);
}
if (args[0] === "onboard") { console.error("Use --option value."); process.exit(1); }
console.log(JSON.stringify({ version, args, main: __filename }));
`,
  );
  const id = release.commit ?? commit(release.version.length);
  const written = spawnSync(
    process.execPath,
    [
      join(root, "scripts/release/manifest.mjs"),
      runtime,
      release.version,
      id,
      "v24.22.3",
    ],
    { encoding: "utf8" },
  );
  expect(written.status, written.stderr).toBe(0);
  for (const [path, text] of Object.entries(release.unlisted ?? {}))
    file(path, text);
  const archive = `clawdtime-${release.version}-darwin-arm64.tar.gz`;
  mkdirSync(folder, { recursive: true });
  const packed = spawnSync(
    "tar",
    [
      "--no-mac-metadata",
      "--no-xattrs",
      "-czf",
      join(folder, archive),
      "-C",
      stage,
      "runtime",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8" },
  );
  expect(packed.status, packed.stderr).toBe(0);
  const sha256 = createHash("sha256")
    .update(readFileSync(join(folder, archive)))
    .digest("hex");
  writeFileSync(
    join(folder, "latest.json"),
    JSON.stringify({
      version: release.version,
      commit: id,
      arch: "arm64",
      url: archive,
      sha256,
      minimumMacOS: "14.0",
      ...release.latest,
    }),
  );
  return { archive, sha256 };
}

/** A made-up home, a release folder and stand-ins that record any call. */
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-install-")));
  folders.push(base);
  const home = join(base, "home"),
    releases = join(base, "releases"),
    bin = join(base, "bin"),
    calls = join(base, "calls.log");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin);
  writeFileSync(calls, "");
  // None of these may run on the release route: no sudo and no developer tool.
  for (const name of ["sudo", "node", "npm", "npx", "git", "swift", "xcrun"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> '${calls}'\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  const runtimes = join(
    home,
    "Library",
    "Application Support",
    "ClawdTime",
    "runtime",
  );
  const install = (
    options: {
      args?: string[];
      env?: Record<string, string>;
      tty?: boolean;
      base?: string;
    } = {},
  ) =>
    new Promise<{ status: number | null; output: string }>((done) => {
      const command = ["sh", installer, ...(options.args ?? [])];
      // Detached: the install has no terminal, as under a pipe with no Terminal.
      // With tty, script(1) gives it one.
      const child = spawn(
        options.tty ? "script" : command[0]!,
        options.tty ? ["-q", "/dev/null", ...command] : command.slice(1),
        {
          cwd: base,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
            TMPDIR: join(base, "tmp") + "/",
            CLAWDTIME_RELEASE_BASE: options.base ?? `file://${releases}`,
            ...options.env,
          },
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("exit", (status) => done({ status, output }));
    });
  mkdirSync(join(base, "tmp"));
  const recorded = () => readFileSync(calls, "utf8");
  const current = () => readlinkSync(join(runtimes, "current"));
  const versions = () =>
    readdirSync(runtimes)
      .filter((name) => !name.startsWith("."))
      .sort();
  return {
    base,
    home,
    releases,
    runtimes,
    install,
    recorded,
    current,
    versions,
  };
}

// Each install starts Node a few times; a test runs up to five installs, and
// the whole suite runs at the same time.
describe("the release route of the installer", { timeout: 30_000 }, () => {
  it("installs the newest release with no Node, Git or Xcode, and never sudo", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    const result = await f.install();
    expect(result.status, result.output).toBe(0);
    expect(f.versions()).toEqual(["0.4.1", "current"]);
    expect(f.current()).toBe("0.4.1");
    const link = join(f.home, ".local", "bin", "clawdtime");
    expect(readlinkSync(link)).toBe(
      join(f.runtimes, "current", "bin", "clawdtime"),
    );
    // The linked command runs the runtime's own copy, through every link.
    const ran = spawnSync(link, ["status"], { encoding: "utf8" });
    expect(JSON.parse(ran.stdout)).toMatchObject({
      version: "0.4.1",
      args: ["status"],
      main: join(
        realpathSync(f.runtimes),
        "0.4.1",
        "app",
        "dist",
        "cli",
        "main.js",
      ),
    });
    expect(result.output).toContain("ClawdTime 0.4.1 is installed.");
    expect(result.output).toContain(
      `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`,
    );
    // No onboard command in this release: the steps end with clawdtime start.
    expect(result.output).toContain("Start it: clawdtime start");
    expect(result.output).toContain(
      join(f.runtimes, "0.4.1", "app", "native", "ClawdTimeTaskPanel"),
    );
    expect(f.recorded()).toBe("");
    expect(readdirSync(f.runtimes).filter((n) => n.startsWith("."))).toEqual(
      [],
    );
    expect(readdirSync(join(f.base, "tmp"))).toEqual([]);
  });

  it("updates in place: it keeps settings and pairing, switches current, and keeps the version before", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    expect((await f.install()).status).toBe(0);
    // Settings, keys and pairing of the person, which an update never touches.
    const kept = {
      [join(f.home, ".local/share/clawdtime/desktop/local-config.json")]:
        '{"projectRoot":"/made/up"}',
      [join(f.home, ".local/share/clawdtime/shared/pairing.json")]:
        '{"device":"made-up"}',
      [join(f.home, ".config/clawdtime/settings.json")]: '{"voice":"calm"}',
    };
    for (const [path, text] of Object.entries(kept)) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text, { mode: 0o600 });
    }
    const link = join(f.home, ".local", "bin", "clawdtime");
    const linked = lstatSync(link).ino;

    publish(f.releases, { version: "0.4.2" });
    const update = await f.install();
    expect(update.status, update.output).toBe(0);
    expect(update.output).toContain(
      "ClawdTime is updated from 0.4.1 to 0.4.2. Your settings, keys and pairing are kept.",
    );
    expect(f.current()).toBe("0.4.2");
    expect(f.versions()).toEqual(["0.4.1", "0.4.2", "current"]);
    for (const [path, text] of Object.entries(kept))
      expect(readFileSync(path, "utf8")).toBe(text);
    expect(lstatSync(link).ino).toBe(linked);
    expect(
      JSON.parse(spawnSync(link, [], { encoding: "utf8" }).stdout).version,
    ).toBe("0.4.2");

    // The same release again: every file checks out, so nothing downloads.
    rmSync(join(f.releases, "clawdtime-0.4.2-darwin-arm64.tar.gz"));
    const again = await f.install();
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain(
      "ClawdTime 0.4.2 is installed already, and every file checks out.",
    );
    expect(f.current()).toBe("0.4.2");
    // The release before stays for a rollback, also after a rerun.
    expect(f.versions()).toEqual(["0.4.1", "0.4.2", "current"]);

    // A third release: the oldest goes, the one before stays for a rollback.
    publish(f.releases, { version: "0.4.3" });
    expect((await f.install()).status).toBe(0);
    expect(f.versions()).toEqual(["0.4.2", "0.4.3", "current"]);
    expect(f.recorded()).toBe("");
  });

  it("never removes a version that still runs, and says what it kept", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    expect((await f.install()).status).toBe(0);
    // A process of 0.4.1 that stays up, started from its own folder as the
    // launcher starts it.
    const version = join(f.runtimes, "0.4.1");
    const live = spawn(
      join(version, "node", "bin", "node"),
      [join(version, "app", "dist", "scripts", "task-server.js")],
      { stdio: "ignore" },
    );
    const stopped = new Promise((done) => live.on("exit", done));
    try {
      publish(f.releases, { version: "0.4.2" });
      const second = await f.install();
      expect(second.status, second.output).toBe(0);
      expect(second.output).toContain(
        `ClawdTime 0.4.1 still runs (process ${live.pid}). It goes on until it stops. Then clawdtime start starts 0.4.2.`,
      );
      // 0.4.1 is older than the version before, but it runs: it stays.
      publish(f.releases, { version: "0.4.3" });
      const third = await f.install();
      expect(third.status, third.output).toBe(0);
      expect(f.versions()).toEqual(["0.4.1", "0.4.2", "0.4.3", "current"]);
      expect(third.output).toContain(
        `Kept ClawdTime 0.4.1: it still runs (process ${live.pid}). A later update removes it after it stops.`,
      );
      expect(existsSync(join(version, "app", "dist", "cli", "main.js"))).toBe(
        true,
      );
    } finally {
      live.kill();
      await stopped;
    }
    // Once it stops, the next update removes it.
    publish(f.releases, { version: "0.4.4" });
    const fourth = await f.install();
    expect(fourth.status, fourth.output).toBe(0);
    expect(f.versions()).toEqual(["0.4.3", "0.4.4", "current"]);
    expect(fourth.output).not.toContain("still runs");
  });

  it("refuses a release older than the installed one, unless CLAWDTIME_ALLOW_DOWNGRADE=1", async () => {
    const f = setup();
    publish(f.releases, { version: "0.10.0" });
    expect((await f.install()).status).toBe(0);
    // 0.9.0 is older than 0.10.0: the versions compare as numbers, not as text.
    publish(f.releases, { version: "0.9.0" });
    const older = await f.install();
    expect(older.status, older.output).toBe(1);
    expect(older.output).toContain(
      "Stopped: ClawdTime 0.10.0 is installed, and the newest release, 0.9.0, is older. Nothing changed. To go back to 0.9.0, run this again with CLAWDTIME_ALLOW_DOWNGRADE=1.",
    );
    expect(older.output).not.toContain("Downloading");
    expect(f.current()).toBe("0.10.0");
    expect(f.versions()).toEqual(["0.10.0", "current"]);

    const back = await f.install({ env: { CLAWDTIME_ALLOW_DOWNGRADE: "1" } });
    expect(back.status, back.output).toBe(0);
    expect(back.output).toContain(
      "Going back from ClawdTime 0.10.0 to 0.9.0: CLAWDTIME_ALLOW_DOWNGRADE=1.",
    );
    expect(back.output).toContain(
      "ClawdTime is back on 0.9.0 from 0.10.0. Your settings, keys and pairing are kept.",
    );
    expect(f.current()).toBe("0.9.0");
    expect(f.versions()).toEqual(["0.10.0", "0.9.0", "current"]);

    // A newer release needs no setting.
    publish(f.releases, { version: "0.10.1" });
    const forward = await f.install();
    expect(forward.status, forward.output).toBe(0);
    expect(forward.output).toContain(
      "ClawdTime is updated from 0.9.0 to 0.10.1.",
    );
    expect(f.current()).toBe("0.10.1");
  });

  it("finds the installed versions in the version folders when current is gone", async () => {
    const f = setup();
    publish(f.releases, { version: "0.10.0" });
    expect((await f.install()).status).toBe(0);
    rmSync(join(f.runtimes, "current"));
    publish(f.releases, { version: "0.9.0" });
    const older = await f.install();
    expect(older.status, older.output).toBe(1);
    expect(older.output).toContain(
      "Stopped: ClawdTime 0.10.0 is installed, and the newest release, 0.9.0, is older. Nothing changed. To go back to 0.9.0, run this again with CLAWDTIME_ALLOW_DOWNGRADE=1.",
    );
    expect(f.versions()).toEqual(["0.10.0"]);

    const back = await f.install({ env: { CLAWDTIME_ALLOW_DOWNGRADE: "1" } });
    expect(back.status, back.output).toBe(0);
    expect(back.output).toContain(
      "ClawdTime is back on 0.9.0 from 0.10.0. Your settings, keys and pairing are kept.",
    );
    expect(f.current()).toBe("0.9.0");
    expect(f.versions()).toEqual(["0.10.0", "0.9.0", "current"]);

    // An older folder with no current: an update from it, and it stays.
    const g = setup();
    publish(g.releases, { version: "0.4.1" });
    expect((await g.install()).status).toBe(0);
    rmSync(join(g.runtimes, "current"));
    publish(g.releases, { version: "0.4.2" });
    const update = await g.install();
    expect(update.status, update.output).toBe(0);
    expect(update.output).toContain(
      "ClawdTime is updated from 0.4.1 to 0.4.2.",
    );
    expect(g.versions()).toEqual(["0.4.1", "0.4.2", "current"]);
  });

  it("accepts no file that the manifest does not list, and says so", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    expect((await f.install()).status).toBe(0);
    // A file planted in the installed copy, where Node would find it.
    const planted = join(
      f.runtimes,
      "0.4.1",
      "app/dist/node_modules/made-up/index.js",
    );
    mkdirSync(join(planted, ".."), { recursive: true });
    writeFileSync(planted, 'module.exports = "planted";\n');
    symlinkSync("/made/up", join(f.runtimes, "0.4.1", "app", "made-up-link"));
    // Every listed file checks out: it removes the others in place, with no
    // download, so a process of this version keeps its files.
    const archive = join(f.releases, "clawdtime-0.4.1-darwin-arm64.tar.gz");
    const kept = readFileSync(archive);
    rmSync(archive);
    const rerun = await f.install();
    expect(rerun.status, rerun.output).toBe(0);
    expect(rerun.output).not.toContain("and every file checks out");
    expect(rerun.output).toContain(
      "ClawdTime 0.4.1 is installed already. Removed what its manifest does not list: app/dist/node_modules/made-up/index.js, app/made-up-link. Every other file checks out.",
    );
    expect(existsSync(planted)).toBe(false);
    expect(existsSync(join(f.runtimes, "0.4.1", "app", "made-up-link"))).toBe(
      false,
    );
    expect(f.current()).toBe("0.4.1");

    // A planted file next to a changed one: a fresh copy replaces the folder.
    writeFileSync(archive, kept);
    writeFileSync(planted, 'module.exports = "planted";\n');
    writeFileSync(join(f.runtimes, "0.4.1", "node", "LICENSE"), "changed\n");
    const changed = await f.install();
    expect(changed.status, changed.output).toBe(0);
    expect(changed.output).toContain(
      "ClawdTime 0.4.1 is on this Mac, but its files differ from the release manifest: changed: node/LICENSE. It is installed again from the release.",
    );
    expect(changed.output).toContain(
      "Replaced the earlier copy of ClawdTime 0.4.1.",
    );
    expect(existsSync(planted)).toBe(false);

    // A release whose archive holds a file that its manifest does not list.
    publish(f.releases, {
      version: "0.4.2",
      unlisted: { "app/dist/made-up-extra.js": "extra\n" },
    });
    const fresh = await f.install();
    expect(fresh.status, fresh.output).toBe(1);
    expect(fresh.output).toContain(
      "Stopped: the unpacked files do not match the release manifest: not in the manifest: app/dist/made-up-extra.js. Nothing changed.",
    );
    expect(f.current()).toBe("0.4.1");
    expect(f.versions()).toEqual(["0.4.1", "current"]);
  });

  it("refuses an archive whose SHA-256 differs and switches nothing", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    expect((await f.install()).status).toBe(0);
    publish(f.releases, {
      version: "0.4.2",
      latest: { sha256: "0".repeat(64) },
    });
    const result = await f.install();
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "Stopped: the download does not match the SHA-256 in latest.json. It is not installed, and nothing changed.",
    );
    expect(f.current()).toBe("0.4.1");
    expect(readdirSync(f.runtimes).sort()).toEqual(["0.4.1", "current"]);
    expect(readdirSync(join(f.base, "tmp"))).toEqual([]);

    // On a fresh Mac it leaves no runtime and no command.
    const fresh = setup();
    publish(fresh.releases, {
      version: "0.4.1",
      latest: { sha256: "f".repeat(64) },
    });
    expect((await fresh.install()).status).toBe(1);
    expect(existsSync(join(fresh.runtimes, "current"))).toBe(false);
    expect(existsSync(join(fresh.home, ".local", "bin"))).toBe(false);
  });

  it("refuses a release that is not for this Mac, and a base that is not https", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1", latest: { arch: "x86_64" } });
    const intel = await f.install();
    expect(intel.status).toBe(1);
    expect(intel.output).toContain(
      "Stopped: the newest release is not for Apple silicon.",
    );
    publish(f.releases, { version: "0.4.1", latest: { minimumMacOS: "99.0" } });
    const newer = await f.install();
    expect(newer.status).toBe(1);
    expect(newer.output).toContain(
      "ClawdTime 0.4.1 needs macOS 99.0 or later.",
    );
    publish(f.releases, { version: "0.4.1", latest: { url: "../elsewhere" } });
    expect((await f.install()).output).toContain(
      "latest.json has no valid url.",
    );
    const plain = await f.install({ base: "http://shop.example/releases" });
    expect(plain.status).toBe(1);
    expect(plain.output).toContain(
      "Stopped: CLAWDTIME_RELEASE_BASE must be an https URL with no user name or password",
    );
    expect(existsSync(join(f.runtimes, "current"))).toBe(false);
  });

  it("parses each URL strictly: https with no user name or password, and 127.0.0.1 alone for a local test", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    for (const base of [
      "http://127.0.0.1:80@shop.example/releases",
      "http://127.0.0.1@shop.example/releases",
      "http://127.0.0.1.shop.example/releases",
      "http://localhost:8080/releases",
      "https://made-up:secret@shop.example/releases",
      "https://shop.example:443@other.example/releases",
      "https://shop.example\\@other.example/releases",
      "https://shop.example/rel eases",
      "https:///releases",
      "https://shop.example:99999/releases",
      "https://-shop.example/releases",
      "ftp://shop.example/releases",
    ]) {
      const result = await f.install({ base });
      expect(result.status, base).toBe(1);
      expect(result.output, base).toContain(
        "Stopped: CLAWDTIME_RELEASE_BASE must be an https URL with no user name or password, such as https://downloads.example/clawdtime. A local test may use http://127.0.0.1:PORT or file:///PATH.",
      );
    }
    for (const url of [
      "http://127.0.0.1:80@shop.example/clawdtime-0.4.1-darwin-arm64.tar.gz",
      "https://made-up@shop.example/clawdtime-0.4.1-darwin-arm64.tar.gz",
      // An https archive for a release on file:///: another kind of URL.
      "https://shop.example/clawdtime-0.4.1-darwin-arm64.tar.gz",
      "clawdtime 0.4.1.tar.gz",
      "@shop.example",
    ]) {
      publish(f.releases, { version: "0.4.1", latest: { url } });
      const result = await f.install();
      expect(result.status, url).toBe(1);
      expect(result.output, url).toContain(
        "Stopped: latest.json has no valid url.",
      );
    }
    expect(existsSync(join(f.runtimes, "current"))).toBe(false);
    expect(f.recorded()).toBe("");
  });

  it("keeps the link of a source build unless CLAWDTIME_REPLACE_SOURCE=1, and says so either way", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    // A source build, linked by npm link in ~/.local as the source route links it.
    const checkout = join(f.base, "clawdtime");
    for (const path of ["cli/main.ts", "scripts/install.sh", "package.json"]) {
      mkdirSync(join(checkout, path, ".."), { recursive: true });
      writeFileSync(join(checkout, path), "made-up source\n");
    }
    mkdirSync(join(checkout, "dist", "cli"), { recursive: true });
    writeFileSync(join(checkout, "dist", "cli", "main.js"), "made-up build\n");
    const local = join(f.home, ".local");
    mkdirSync(join(local, "lib", "node_modules"), { recursive: true });
    symlinkSync(checkout, join(local, "lib", "node_modules", "clawdtime"));
    mkdirSync(join(local, "bin"));
    const link = join(local, "bin", "clawdtime");
    const npmLink = "../lib/node_modules/clawdtime/dist/cli/main.js";
    symlinkSync(npmLink, link);
    const launcher = join(f.runtimes, "current", "bin", "clawdtime");

    const kept = await f.install();
    expect(kept.status, kept.output).toBe(0);
    expect(readlinkSync(link)).toBe(npmLink);
    expect(kept.output).toContain(
      `Kept ${link}: it runs the source build in ${checkout}. To use this release there, run this again with CLAWDTIME_REPLACE_SOURCE=1. The command of this release is ${launcher}`,
    );
    expect(kept.output).toContain(`Start it: ${launcher} start`);
    expect(kept.output).not.toContain(`Ready: ${link}`);

    const replaced = await f.install({
      env: { CLAWDTIME_REPLACE_SOURCE: "1" },
    });
    expect(replaced.status, replaced.output).toBe(0);
    expect(readlinkSync(link)).toBe(launcher);
    expect(replaced.output).toContain(
      `Replaced ${link}, which ran the source build in ${checkout}: CLAWDTIME_REPLACE_SOURCE=1. To go back: cd ${checkout} && npm link`,
    );
    expect(replaced.output).toContain(`Ready: ${link} runs ClawdTime 0.4.1.`);
    expect(f.recorded()).toBe("");
  });

  it("never runs as root", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    const bin = join(f.base, "root-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    const result = await f.install({
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("Stopped: run this without sudo.");
    expect(existsSync(f.runtimes)).toBe(false);
  });

  it("downloads from a release server on 127.0.0.1", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    const server = createServer((request, response) => {
      const name = (request.url ?? "").replace(/^\/releases\//, "");
      const path = join(f.releases, name);
      if (name.includes("/") || !existsSync(path)) {
        response.statusCode = 404;
        return response.end();
      }
      response.end(readFileSync(path));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("no port");
      const result = await f.install({
        base: `http://127.0.0.1:${address.port}/releases`,
      });
      expect(result.status, result.output).toBe(0);
      expect(f.current()).toBe("0.4.1");
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  it("hands the terminal to clawdtime onboard when the release has it, and says how to finish without one", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1", onboard: true });
    const piped = await f.install();
    expect(piped.status, piped.output).toBe(0);
    expect(piped.output).toContain(
      "Run clawdtime onboard in Terminal to finish setup.",
    );
    expect(piped.output).not.toContain("Start it: clawdtime start");
    expect(existsSync(join(f.home, "onboard-ran.json"))).toBe(false);

    const terminal = await f.install({ tty: true });
    expect(terminal.status, terminal.output).toBe(0);
    expect(terminal.output).toContain("Guided setup (clawdtime onboard)");
    expect(
      JSON.parse(readFileSync(join(f.home, "onboard-ran.json"), "utf8")),
    ).toEqual({ tty: true, version: "0.4.1" });

    rmSync(join(f.home, "onboard-ran.json"));
    const skipped = await f.install({
      tty: true,
      env: { CLAWDTIME_NO_ONBOARD: "1" },
    });
    expect(skipped.status).toBe(0);
    expect(existsSync(join(f.home, "onboard-ran.json"))).toBe(false);
  });
});

describe("the source route of the installer", () => {
  it("keeps the source build with --source and with CLAWDTIME_FROM_SOURCE=1", async () => {
    const f = setup();
    publish(f.releases, { version: "0.4.1" });
    for (const options of [
      { args: ["--source"] },
      { env: { CLAWDTIME_FROM_SOURCE: "1" } },
    ]) {
      const result = await f.install(options);
      // The node stand-in answers nothing: the source build needs Node 24.
      expect(result.status).toBe(1);
      expect(result.output).toContain("Missing: Node 24 or later.");
      expect(result.output).toContain(
        "Stopped: install what is missing, then run this again.",
      );
      expect(existsSync(f.runtimes)).toBe(false);
    }
    // --help prints the whole comment at the top, with every setting.
    const help = await f.install({ args: ["--help"] });
    expect(help.status).toBe(0);
    for (const line of [
      "Installs ClawdTime on this Mac, or updates it.",
      "CLAWDTIME_ALLOW_DOWNGRADE",
      "CLAWDTIME_REPLACE_SOURCE",
      "uses sudo. The steps that need you come at the end.",
    ])
      expect(help.output).toContain(line);
    expect(help.output).not.toContain("set -eu");
    const unknown = await f.install({ args: ["--sauce"] });
    expect(unknown.status).toBe(1);
    expect(unknown.output).toContain("unknown option --sauce");
  });
});
