#!/bin/bash
# Builds the prebuilt ClawdTime runtime for Macs with Apple silicon: Node, the
# compiled service and command, the production packages and the native
# helpers, in one folder that needs no Node, npm, Git or Xcode on the Mac.
#
#   scripts/release/build-runtime.sh --out DIR [--coordinator HTTPS_ORIGIN] [--download-base URL]
#
#   --out DIR             a new or empty folder. It gets runtime/, the archive,
#                         its .sha256, latest.json and install.sh
#   --coordinator ORIGIN  the coordinator that setup uses, written to
#                         app/release.json. Only an https origin (or
#                         http://127.0.0.1 for tests). Without it, setup asks
#                         for one or runs in local mode
#   --download-base URL   the folder of the release assets, for the absolute url
#                         in latest.json. Without it, the url is the archive's
#                         file name, which the installer reads next to latest.json
#
# It builds the commit at HEAD, from a clean export: uncommitted changes are
# not in the runtime. It downloads Node from nodejs.org once, checks it against
# the published SHASUMS256 (and the pinned SHA-256 of the default version), and
# keeps it in artifacts/cache/ of this checkout, which Git ignores. It puts no
# browser in the runtime: the computer browser stays a later, optional step.
# It signs Node and the native helpers ad hoc with the hardened runtime
# (scripts/release/sign-runtime.sh), so DYLD_ variables load no other library
# into them.
# The build host needs macOS on Apple silicon, Swift 6, Git, curl and network
# access to nodejs.org and the npm registry.
set -euo pipefail

node_version=${CLAWDTIME_NODE_VERSION:-24.22.3}
# The SHA-256 of node-v24.22.3-darwin-arm64.tar.gz in the SHASUMS256.txt of
# nodejs.org. Another version is checked against its SHASUMS256.txt alone.
pinned_node_version=24.22.3
pinned_node_sha256=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; }

out="" coordinator="" download_base=""
while [ $# -gt 0 ]; do
  case $1 in
    --out | --coordinator | --download-base)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value."
      case $1 in
        --out) out=$2 ;;
        --coordinator) coordinator=$2 ;;
        --download-base) download_base=${2%/} ;;
      esac
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown option $1. Run with --help." ;;
  esac
done
[ -n "$out" ] || fail "--out DIR is required. Run with --help."
if [ -n "$coordinator" ] &&
  ! [[ $coordinator =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ||
    $coordinator =~ ^http://127\.0\.0\.1(:[0-9]{1,5})?$ ]]; then
  fail "--coordinator must be an https origin with no path, such as https://coordinator.example (or http://127.0.0.1:PORT for tests)."
fi
if [ -n "$download_base" ] && ! [[ $download_base =~ ^https://[^[:space:]]+$ ]]; then
  fail "--download-base must be an https URL."
fi
[[ $node_version =~ ^24\.[0-9]+\.[0-9]+$ ]] || fail "CLAWDTIME_NODE_VERSION must be a Node 24 version, such as 24.22.3."

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] ||
  fail "build on a Mac with Apple silicon: the runtime is for darwin-arm64."
for tool in git swift curl shasum tar lipo codesign; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing on this build Mac."
done

root=$(cd "$(dirname "$0")/../.." && pwd)
case $out in /*) ;; *) out=$(pwd)/$out ;; esac
case $out/ in
  "$root"/artifacts/*) ;;
  "$root"/*) fail "put --out under $root/artifacts/ (Git ignores it) or outside the checkout." ;;
esac
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2>/dev/null)" ]; then
  fail "$out is not empty. Choose a new folder: a build never overwrites another."
fi
mkdir -p "$out"
out=$(cd "$out" && pwd)

commit=$(git -C "$root" rev-parse HEAD)
[ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] ||
  say "Note: this checkout has uncommitted changes. The runtime is built from commit $commit alone."

cache=${CLAWDTIME_RELEASE_CACHE:-$root/artifacts/cache}
work=$out/.work
rm -rf "$work"
mkdir -p "$work" "$cache/node"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

step "Node $node_version for darwin-arm64"
node_name=node-v$node_version-darwin-arm64
node_archive=$cache/node/$node_name.tar.gz
sums=$cache/node/SHASUMS256-v$node_version.txt
[ -s "$sums" ] || curl -fsSL --proto '=https' --tlsv1.2 -o "$sums" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" ||
  fail "SHASUMS256.txt of Node $node_version did not download."
expected=$(awk -v name="$node_name.tar.gz" '$2 == name { print $1 }' "$sums")
[[ $expected =~ ^[a-f0-9]{64}$ ]] || fail "SHASUMS256.txt of Node $node_version has no line for $node_name.tar.gz."
if [ "$node_version" = "$pinned_node_version" ] && [ "$expected" != "$pinned_node_sha256" ]; then
  fail "SHASUMS256.txt of Node $node_version differs from the SHA-256 pinned in this script."
fi
actual=$( [ -f "$node_archive" ] && shasum -a 256 "$node_archive" | cut -d' ' -f1 || true)
if [ "$actual" != "$expected" ]; then
  curl -fSL --proto '=https' --tlsv1.2 -o "$node_archive.part" "https://nodejs.org/dist/v$node_version/$node_name.tar.gz" ||
    fail "Node $node_version did not download."
  actual=$(shasum -a 256 "$node_archive.part" | cut -d' ' -f1)
  [ "$actual" = "$expected" ] || {
    rm -f "$node_archive.part"
    fail "the Node download does not match its SHA-256 in SHASUMS256.txt."
  }
  mv -f "$node_archive.part" "$node_archive"
fi
say "SHA-256 $actual matches SHASUMS256.txt."
mkdir -p "$work/node"
tar -xzf "$node_archive" -C "$work/node" --strip-components 1
node=$work/node/bin/node
[ "$("$node" --version)" = "v$node_version" ] || fail "the Node binary is not version $node_version."
# The build runs with this Node and its own npm, not the build Mac's.
export PATH="$work/node/bin:$PATH"
npm=("$node" "$work/node/lib/node_modules/npm/bin/npm-cli.js")

step "Source of commit $commit"
mkdir -p "$work/src"
git -C "$root" archive --format=tar "$commit" | tar -xf - -C "$work/src"
version=$("$node" -p 'require(process.argv[1]).version' "$work/src/package.json")
# The rule of the app's runtime check: three numbers, no leading zero, at most four digits.
[[ $version =~ ^(0|[1-9][0-9]{0,3})(\.(0|[1-9][0-9]{0,3})){2}$ ]] ||
  fail "package.json version $version is not MAJOR.MINOR.PATCH, each with no leading zero and at most four digits."
printf '{ "sourceRevision": "%s" }\n' "$commit" >"$work/src/release-source.json"
say "ClawdTime $version"

step "Compiling (npm ci, npm run build)"
(cd "$work/src" && "${npm[@]}" ci --ignore-scripts --no-audit --no-fund --loglevel=error) ||
  fail "npm ci did not finish."
(cd "$work/src" && "${npm[@]}" run --silent build) || fail "npm run build did not finish."

step "Native helpers (swift build -c release --arch arm64)"
for product in ClawdTimeTaskPanel ClawdTimeTaskCapture; do
  (cd "$work/src/mac" && swift build -c release --arch arm64 --product "$product") ||
    fail "swift build of $product did not finish."
done
swift_bin=$(cd "$work/src/mac" && swift build -c release --arch arm64 --show-bin-path)

step "Runtime in $out/runtime"
runtime=$out/runtime
app=$runtime/app
mkdir -p "$runtime/bin" "$runtime/node/bin" "$app/native"
cp "$work/src/scripts/release/launcher.sh" "$runtime/bin/clawdtime"
cp "$node" "$runtime/node/bin/node"
cp "$work/node/LICENSE" "$runtime/node/LICENSE"
cp "$work/src/package.json" "$work/src/package-lock.json" "$app/"
cp -R "$work/src/dist" "$app/dist"
# `clawdtime setup --agent` reads the skill of a coding agent from here.
cp -R "$work/src/skills" "$app/skills"
for product in ClawdTimeTaskPanel ClawdTimeTaskCapture; do
  cp "$swift_bin/$product" "$app/native/$product"
done
# The panel's fonts: Bundle.module looks next to the executable first.
for bundle in "$swift_bin"/*_ClawdTimeTaskPanel.bundle; do
  [ -d "$bundle" ] || fail "the panel's resource bundle is missing from $swift_bin."
  cp -R "$bundle" "$app/native/"
done
"$node" -e '
  const [file, version, commit, coordinator] = process.argv.slice(1);
  const release = { version, commit, ...(coordinator ? { coordinator } : {}) };
  require("fs").writeFileSync(file, JSON.stringify(release, null, 2) + "\n");
' "$app/release.json" "$version" "$commit" "$coordinator"
(cd "$app" && "${npm[@]}" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) ||
  fail "npm ci --omit=dev did not finish."
# Links to package commands. Nothing in the runtime runs them.
rm -rf "$app/node_modules/.bin"
chmod -R u=rwX,go=rX "$runtime"
chmod 755 "$runtime/bin/clawdtime" "$runtime/node/bin/node" "$app/native/ClawdTimeTaskPanel" "$app/native/ClawdTimeTaskCapture"

step "Audit of the launch paths"
problems=()
links=$(find "$runtime" -type l)
[ -z "$links" ] || problems+=("links: $links")
extra=$(find "$runtime/node" -type f ! -path "$runtime/node/bin/node" ! -path "$runtime/node/LICENSE")
[ -z "$extra" ] || problems+=("files besides node and its LICENSE in node/: $extra")
for name in tsx typescript vitest prettier esbuild @playwright/test @types/node; do
  [ ! -e "$app/node_modules/$name" ] || problems+=("development package $name")
done
for name in src cli connectors scripts mac tests line media public; do
  [ ! -e "$app/$name" ] || problems+=("source folder app/$name")
done
sources=$(find "$app" -path "$app/node_modules" -prune -o -type f \( -name '*.ts' ! -name '*.d.ts' -o -name '*.tsx' -o -name '*.swift' \) -print)
[ -z "$sources" ] || problems+=("source files: $sources")
builds=$(find "$runtime" -type d \( -name .build -o -name .git \) -print)
[ -z "$builds" ] || problems+=("build or Git folders: $builds")
[ -f "$app/dist/cli/main.js" ] && [ -f "$app/dist/scripts/task-server.js" ] ||
  problems+=("dist/cli/main.js or dist/scripts/task-server.js is missing")
baked=$(grep -rl --include='*.js' --include='*.json' -F "$work" "$app/dist" "$app/release.json" 2>/dev/null || true)
[ -z "$baked" ] || problems+=("build paths baked into: $baked")
for binary in "$runtime/node/bin/node" "$app/native/ClawdTimeTaskPanel" "$app/native/ClawdTimeTaskCapture"; do
  [ "$(lipo -archs "$binary" 2>/dev/null)" = arm64 ] || problems+=("$binary is not arm64 alone")
done
if [ ${#problems[@]} -gt 0 ]; then
  printf '  %s\n' "${problems[@]}" >&2
  fail "the runtime is not self-contained."
fi
say "No npm, npx, tsx, source file, build folder or link. Node and both helpers are arm64."

step "Signatures (ad hoc, with the hardened runtime)"
"$work/src/scripts/release/sign-runtime.sh" "$runtime" || fail "the runtime is not signed."

step "Manifest, archive and latest.json"
"$node" "$work/src/scripts/release/manifest.mjs" "$runtime" "$version" "$commit" "v$node_version"
archive=clawdtime-$version-darwin-arm64.tar.gz
(cd "$out" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --uid 0 --gid 0 --uname root --gname wheel \
  -czf "$archive" runtime)
sha256=$(shasum -a 256 "$out/$archive" | cut -d' ' -f1)
printf '%s  %s\n' "$sha256" "$archive" >"$out/$archive.sha256"
url=${download_base:+$download_base/}$archive
"$node" -e '
  const [file, version, commit, url, sha256] = process.argv.slice(1);
  const latest = { version, commit, arch: "arm64", url, sha256, minimumMacOS: "14.0" };
  require("fs").writeFileSync(file, JSON.stringify(latest, null, 2) + "\n");
' "$out/latest.json" "$version" "$commit" "$url" "$sha256"
cp "$work/src/scripts/install.sh" "$out/install.sh"
chmod 644 "$out/install.sh" "$out/latest.json" "$out/$archive" "$out/$archive.sha256"

say ""
say "ClawdTime $version ($commit), Node v$node_version, darwin-arm64."
say "Runtime:  $runtime ($(du -sh "$runtime" | cut -f1))"
say "Archive:  $out/$archive ($(du -h "$out/$archive" | cut -f1)), SHA-256 $sha256"
say "Assets to publish: $archive, $archive.sha256, latest.json, install.sh"
say "Check it: scripts/release/smoke-runtime.sh $runtime"
