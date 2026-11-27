import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const folders: string[] = [];
afterEach(() => {
  while (folders.length)
    rmSync(folders.pop()!, { recursive: true, force: true });
});
const temporary = () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "clawdtime-rt-")));
  folders.push(folder);
  return folder;
};

describe("the launcher of a release runtime", () => {
  it("runs the runtime's own Node on the compiled command, through links and folders with spaces", () => {
    const base = temporary();
    const runtimes = join(base, "Application Support", "ClawdTime", "runtime");
    const runtime = join(runtimes, "0.4.1");
    mkdirSync(join(runtime, "bin"), { recursive: true });
    mkdirSync(join(runtime, "node", "bin"), { recursive: true });
    mkdirSync(join(runtime, "app", "dist", "cli"), { recursive: true });
    copyFileSync(
      join(root, "scripts/release/launcher.sh"),
      join(runtime, "bin/clawdtime"),
    );
    spawnSync("chmod", ["755", join(runtime, "bin/clawdtime")]);
    // A stand-in Node that says it ran, then runs the Node of this test.
    writeFileSync(
      join(runtime, "node/bin/node"),
      `#!/bin/sh\nexport RAN_BY="runtime node"\nexec '${process.execPath}' "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(runtime, "app/dist/cli/main.js"),
      `console.log(JSON.stringify({ args: process.argv.slice(2), main: __filename, ranBy: process.env.RAN_BY, options: process.env.NODE_OPTIONS ?? null }));\n`,
    );
    symlinkSync("0.4.1", join(runtimes, "current"));
    const bin = join(base, "home", ".local", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(
      join(runtimes, "current", "bin", "clawdtime"),
      join(bin, "clawdtime"),
    );
    const ran = spawnSync("clawdtime", ["shared", "a b", "--json"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        NODE_OPTIONS: "--require /nonexistent/hook.js",
      },
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      args: ["shared", "a b", "--json"],
      main: join(runtime, "app", "dist", "cli", "main.js"),
      ranBy: "runtime node",
      options: null,
    });
  });
});

describe("the manifest of a release runtime", () => {
  const write = (runtime: string) =>
    spawnSync(
      process.execPath,
      [
        join(root, "scripts/release/manifest.mjs"),
        runtime,
        "0.4.1",
        "a".repeat(40),
        "v24.22.3",
      ],
      { encoding: "utf8" },
    );

  it("lists the SHA-256 of every file, and refuses a link", () => {
    const runtime = join(temporary(), "runtime");
    mkdirSync(join(runtime, "app", "native"), { recursive: true });
    writeFileSync(join(runtime, "app", "native", "ClawdTimeTaskPanel"), "p");
    writeFileSync(join(runtime, "app", "release.json"), "{}");
    expect(write(runtime).status).toBe(0);
    const sha = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    expect(
      JSON.parse(readFileSync(join(runtime, "manifest.json"), "utf8")),
    ).toEqual({
      name: "clawdtime",
      version: "0.4.1",
      commit: "a".repeat(40),
      arch: "arm64",
      node: "v24.22.3",
      files: {
        "app/native/ClawdTimeTaskPanel": sha("p"),
        "app/release.json": sha("{}"),
      },
    });
    symlinkSync("release.json", join(runtime, "app", "linked.json"));
    const refused = write(runtime);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Not a regular file: app/linked.json");
  });
});

describe("the runtime builder", () => {
  it("checks its options before it downloads or builds anything", () => {
    const base = temporary();
    const cache = join(base, "cache");
    const build = (...args: string[]) =>
      spawnSync(join(root, "scripts/release/build-runtime.sh"), args, {
        encoding: "utf8",
        env: { ...process.env, CLAWDTIME_RELEASE_CACHE: cache },
      });
    expect(build().stderr).toContain("--out DIR is required.");
    expect(
      build("--out", join(base, "a"), "--coordinator", "http://shop.example")
        .stderr,
    ).toContain("--coordinator must be an https origin with no path");
    expect(
      build(
        "--out",
        join(base, "a"),
        "--coordinator",
        "https://coordinator.example/path",
      ).stderr,
    ).toContain("--coordinator must be an https origin with no path");
    mkdirSync(join(base, "full"));
    writeFileSync(join(base, "full", "kept.txt"), "kept");
    const full = build("--out", join(base, "full"));
    expect(full.status).toBe(1);
    expect(full.stderr).toContain("is not empty");
    expect(readFileSync(join(base, "full", "kept.txt"), "utf8")).toBe("kept");
    expect(build("--out", join(root, "docs", "release")).stderr).toContain(
      "put --out under",
    );
    expect(existsSync(join(root, "docs", "release"))).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });
});
