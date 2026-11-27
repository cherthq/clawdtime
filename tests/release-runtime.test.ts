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

describe("the manifest and the app's runtime check", () => {
  const write = (runtime: string, version: string, commit = "b".repeat(40)) =>
    spawnSync(
      process.execPath,
      [
        join(root, "scripts/release/manifest.mjs"),
        runtime,
        version,
        commit,
        "v24.22.3",
      ],
      { encoding: "utf8" },
    );

  it("writes only what the app takes: three numbers, relative paths and lowercase SHA-256", () => {
    const runtime = join(temporary(), "runtime");
    mkdirSync(join(runtime, "app", "dist"), { recursive: true });
    writeFileSync(join(runtime, "app", "dist", "read me.txt"), "spaces");
    expect(write(runtime, "0.4.1").status).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(runtime, "manifest.json"), "utf8"),
    ) as { files: Record<string, string>; arch: string };
    expect(manifest.arch).toBe("arm64");
    for (const [path, sha] of Object.entries(manifest.files)) {
      expect(path).not.toMatch(/^\/|(^|\/)\.{0,2}(\/|$)/);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
    // The versions that the app refuses are refused here, before any archive.
    for (const version of [
      "0.4.1-beta.1",
      "01.4.1",
      "0.4",
      "10000.0.0",
      "v0.4.1",
    ]) {
      const refused = write(runtime, version);
      expect(refused.status, version).toBe(2);
      expect(refused.stderr).toContain("three numbers");
    }
    expect(write(runtime, "0.4.1", "ABC").status).toBe(2);
  });
});

// The signer needs codesign and a C compiler. xcode-select -p only reads the
// setting: it never asks macOS to install the command line tools.
const canCompile =
  process.platform === "darwin" &&
  spawnSync("xcode-select", ["-p"]).status === 0 &&
  spawnSync("xcrun", ["--find", "clang"]).status === 0;

describe("the runtime signer", () => {
  const entitlements = (file: string) =>
    [
      ...spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", file], {
        encoding: "utf8",
      }).stdout.matchAll(/<key>([^<]+)<\/key>/g),
    ]
      .map((match) => match[1])
      .sort();
  const flags = (file: string) =>
    /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(
      spawnSync("codesign", ["-dv", file], { encoding: "utf8" }).stderr,
    )?.[1];

  it.skipIf(!canCompile)(
    "signs the helpers and Node with the hardened runtime, so an injected library no longer runs in them",
    () => {
      const base = temporary();
      const compile = (name: string, source: string, ...options: string[]) => {
        writeFileSync(join(base, `${name}.c`), source);
        const built = spawnSync(
          "xcrun",
          [
            "clang",
            "-arch",
            "arm64",
            ...options,
            "-o",
            join(base, name),
            join(base, `${name}.c`),
          ],
          { encoding: "utf8" },
        );
        expect(built.status, built.stderr).toBe(0);
        return join(base, name);
      };
      // The library of the injection probe: it speaks before main and ends the process.
      const inject = compile(
        "inject.dylib",
        `#include <stdio.h>
#include <unistd.h>
__attribute__((constructor)) static void probe(void) { printf("INJECTED before main\\n"); fflush(stdout); _exit(0); }
`,
        "-dynamiclib",
      );
      // Stands in for each executable: it says that main ran, or loads the library it is given.
      const probe = compile(
        "probe",
        `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc > 1) { void *h = dlopen(argv[1], RTLD_NOW); printf(h ? "loaded\\n" : "refused\\n"); return 0; }
  printf("main ran\\n"); return 0;
}
`,
      );
      const addon = compile(
        "addon",
        "int made_up_addon(void) { return 1; }\n",
        "-dynamiclib",
      );
      const runtime = join(base, "Made Up", "runtime");
      const executables = [
        "node/bin/node",
        "app/native/ClawdTimeTaskPanel",
        "app/native/ClawdTimeTaskCapture",
      ];
      const libraries = [
        "app/node_modules/made-up-addon/build/addon.node",
        "app/node_modules/made-up-addon/lib/libmadeup.dylib",
      ];
      for (const [path, from] of [
        ...executables.map((path) => [path, probe] as const),
        ...libraries.map((path) => [path, addon] as const),
      ]) {
        mkdirSync(join(runtime, path, ".."), { recursive: true });
        copyFileSync(from, join(runtime, path));
      }
      writeFileSync(join(runtime, "app", "package.json"), "{}\n");
      const run = (path: string, ...args: string[]) =>
        spawnSync(join(runtime, path), args, {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", DYLD_INSERT_LIBRARIES: inject },
        }).stdout.trim();

      // The linker's ad hoc signature: the injected library runs before main.
      for (const path of executables)
        expect(run(path), path).toBe("INJECTED before main");

      const signed = spawnSync(
        join(root, "scripts/release/sign-runtime.sh"),
        [runtime],
        { encoding: "utf8" },
      );
      expect(signed.status, signed.stderr).toBe(0);

      for (const path of executables) {
        expect(run(path), path).toBe("main ran");
        expect(flags(join(runtime, path)), path).toBe("adhoc,runtime");
        const verified = spawnSync("codesign", [
          "--verify",
          "--strict",
          join(runtime, path),
        ]);
        expect(verified.status, path).toBe(0);
      }
      expect(entitlements(join(runtime, "node/bin/node"))).toEqual([
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
      ]);
      expect(
        entitlements(join(runtime, "app/native/ClawdTimeTaskPanel")),
      ).toEqual(["com.apple.security.device.audio-input"]);
      expect(
        entitlements(join(runtime, "app/native/ClawdTimeTaskCapture")),
      ).toEqual([]);
      // Node loads its native addons; the panel loads no library of another signer.
      for (const path of libraries) {
        expect(flags(join(runtime, path)), path).toBe("adhoc");
        expect(run("node/bin/node", join(runtime, path)), path).toBe("loaded");
        expect(
          run("app/native/ClawdTimeTaskPanel", join(runtime, path)),
          path,
        ).toBe("refused");
      }
      expect(signed.stdout).toContain(
        "Signed ad hoc with the hardened runtime: node/bin/node, app/native/ClawdTimeTaskPanel, app/native/ClawdTimeTaskCapture.",
      );
      expect(signed.stdout).toContain("Signed ad hoc: 2 native libraries.");
    },
    // It compiles three small programs and runs codesign about twenty times.
    60_000,
  );

  it.skipIf(!canCompile)(
    "stops at a Mach-O file that it has no rule for",
    () => {
      const runtime = join(temporary(), "runtime");
      mkdirSync(join(runtime, "app", "node_modules", "made-up"), {
        recursive: true,
      });
      copyFileSync(
        "/usr/bin/true",
        join(runtime, "app/node_modules/made-up/tool"),
      );
      const signed = spawnSync(
        join(root, "scripts/release/sign-runtime.sh"),
        [runtime],
        { encoding: "utf8" },
      );
      expect(signed.status).toBe(1);
      expect(signed.stderr).toContain(
        "an executable with no signing rule: app/node_modules/made-up/tool",
      );
    },
  );

  it("runs in the builder after the audit and before the manifest", () => {
    const builder = readFileSync(
      join(root, "scripts/release/build-runtime.sh"),
      "utf8",
    );
    const audit = builder.indexOf('step "Audit of the launch paths"');
    const sign = builder.indexOf('scripts/release/sign-runtime.sh" "$runtime"');
    const manifest = builder.indexOf("scripts/release/manifest.mjs");
    expect(audit).toBeGreaterThan(0);
    expect(sign).toBeGreaterThan(audit);
    expect(manifest).toBeGreaterThan(sign);
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
