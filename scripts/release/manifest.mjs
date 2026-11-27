// Writes runtime/manifest.json: the name, version, commit, architecture and
// Node version of a release runtime, and the SHA-256 of every file in it.
//
//   node scripts/release/manifest.mjs RUNTIME VERSION COMMIT NODE_VERSION
//
// It refuses a link, a device or any file that is not a regular file or a
// folder: the archive and the installer carry regular files only.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [runtime, version, commit, node] = process.argv.slice(2);
if (!runtime || !version || !commit || !node) {
  console.error("Use: node manifest.mjs RUNTIME VERSION COMMIT NODE_VERSION");
  process.exit(2);
}
if (!/^[a-f0-9]{40}$/.test(commit)) {
  console.error("The commit must be a full 40-character Git commit.");
  process.exit(2);
}

const files = {};
const walk = (folder) => {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    const key = relative(runtime, path).split(sep).join("/");
    const stat = lstatSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile()) {
      if (key === "manifest.json") continue;
      files[key] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    } else {
      console.error(`Not a regular file: ${key}. The runtime holds no links.`);
      process.exit(1);
    }
  }
};
walk(runtime);

writeFileSync(
  join(runtime, "manifest.json"),
  JSON.stringify(
    { name: "clawdtime", version, commit, arch: "arm64", node, files },
    null,
    2,
  ) + "\n",
  { mode: 0o644 },
);
console.log(`manifest.json: ${Object.keys(files).length} files`);
