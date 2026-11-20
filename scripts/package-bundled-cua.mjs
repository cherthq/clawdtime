import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { chromium } from "playwright";

// Local build artifact only. Never reads/copies installed configs or user profiles.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(
  process.argv[2] ?? join(root, "artifacts", "ClawdTime-runtime"),
);
if (existsSync(output))
  throw Error(
    "Choose a new artifact directory; existing bundles are never overwritten.",
  );
if (
  process.platform !== "darwin" ||
  Number(process.versions.node.split(".")[0]) < 24
)
  throw Error("Package on macOS with Node 24 or newer.");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) throw Error("Runtime packaging failed.");
};
const npm = join(
  dirname(realpathSync(process.execPath)),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
if (!existsSync(npm))
  throw Error("Use a Node installation with its matching npm CLI.");
run(process.execPath, [npm, "run", "build"]);
run("bash", ["mac/scripts/package.sh"], {
  env: { ...process.env, CLAWDTIME_SIGNING_IDENTITY: "-" },
});
run("bash", ["mac/scripts/package-task-panel.sh"]);
let browserDirectory = dirname(chromium.executablePath());
while (
  !/^chromium-\d+$/.test(basename(browserDirectory)) &&
  dirname(browserDirectory) !== browserDirectory
)
  browserDirectory = dirname(browserDirectory);
if (
  !/^chromium-\d+$/.test(basename(browserDirectory)) ||
  !existsSync(chromium.executablePath())
)
  throw Error(
    "Install the pinned Chromium first: npm run cua:install-browser.",
  );
const cache = dirname(browserDirectory);
mkdirSync(output, { recursive: true, mode: 0o700 });
cpSync(join(root, "dist"), join(output, "dist"), { recursive: true });
for (const name of ["package.json", "package-lock.json"])
  cpSync(join(root, name), join(output, name));
run(process.execPath, [
  npm,
  "ci",
  "--omit=dev",
  "--ignore-scripts",
  "--prefix",
  output,
]);
mkdirSync(join(output, "bin"), { mode: 0o700 });
cpSync(realpathSync(process.execPath), join(output, "bin", "node"));
const nodeLicense = join(
  dirname(realpathSync(process.execPath)),
  "..",
  "LICENSE",
);
if (!existsSync(nodeLicense))
  throw Error("The matching Node distribution license is required.");
cpSync(nodeLicense, join(output, "NODE-LICENSE"));
mkdirSync(join(output, "browsers"), { mode: 0o700 });
const registry = JSON.parse(
  readFileSync(
    join(root, "node_modules/playwright-core/browsers.json"),
    "utf8",
  ),
);
const copied = [];
for (const name of ["chromium", "chromium-headless-shell", "ffmpeg"]) {
  const entry = registry.browsers.find((b) => b.name === name);
  if (!entry) throw Error("Pinned browser registry entry unavailable.");
  const candidates = readdirSync(cache).filter(
    (value) =>
      value === `${name.replaceAll("-", "_")}-${entry.revision}` ||
      value === `${name}-${entry.revision}`,
  );
  if (candidates.length !== 1)
    throw Error("Pinned browser artifact missing or ambiguous.");
  cpSync(join(cache, candidates[0]), join(output, "browsers", candidates[0]), {
    recursive: true,
  });
  copied.push(candidates[0]);
}
for (const app of ["ClawdTime Companion.app", "ClawdTime Task Panel.app"])
  cpSync(join(root, "mac/build", app), join(output, app), { recursive: true });
writeFileSync(
  join(output, "Start ClawdTime.command"),
  `#!/bin/bash\nset -euo pipefail\nruntime_root="$(cd "$(dirname "$0")" && pwd)"\nexport PLAYWRIGHT_BROWSERS_PATH="$runtime_root/browsers"\nexec "$runtime_root/bin/node" "$runtime_root/dist/cli/task-desktop.js" --panel-binary "$runtime_root/ClawdTime Task Panel.app/Contents/MacOS/ClawdTimeTaskPanel" "$@"\n`,
  { mode: 0o700 },
);
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(
  join(output, "runtime-manifest.json"),
  JSON.stringify(
    {
      version: 1,
      source: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      dirty: !!execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      nodeSha256: digest(join(output, "bin/node")),
      browsers: copied,
      privateConfigIncluded: false,
      distributionSigned: false,
      nativePhysicalQualification: false,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Built local runtime artifact: ${output}. No installation or permission changes. Native apps are ad-hoc signed, not notarized.`,
);
