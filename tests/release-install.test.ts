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

describe("the release route of the installer", () => {
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
      "Stopped: CLAWDTIME_RELEASE_BASE must be an https URL.",
    );
    expect(existsSync(join(f.runtimes, "current"))).toBe(false);
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
    const unknown = await f.install({ args: ["--sauce"] });
    expect(unknown.status).toBe(1);
    expect(unknown.output).toContain("unknown option --sauce");
  });
});
