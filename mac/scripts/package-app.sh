#!/bin/bash
# Builds ClawdTime.app around a release runtime.
#   mac/scripts/package-app.sh --runtime <dir>/runtime --out <dir> [--binary PATH] [--no-self-test]
# The runtime has the layout that scripts/release/build-runtime.sh makes. The
# app is signed ad hoc so it can be checked here; sign-and-notarize.sh signs it
# for release. It never installs anything.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
mac="$(cd "$here/.." && pwd)"
usage() { printf 'Use: %s --runtime DIR/runtime --out DIR [--binary PATH] [--no-self-test]\n' "$(basename "$0")"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }

runtime="" out="" binary="" self_test=1
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --binary) binary="${2:?}"; shift 2 ;;
    --no-self-test) self_test=0; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$runtime" ] && [ -n "$out" ] || { usage >&2; exit 2; }
[ -d "$runtime" ] || fail "No runtime folder at $runtime."
runtime="$(cd "$runtime" && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

# The layout of the runtime, its manifest and every file's hash.
for executable in bin/clawdtime node/bin/node; do
  [ -x "$runtime/$executable" ] || fail "The runtime has no executable $executable."
done
for file in app/package.json app/release.json manifest.json; do
  [ -f "$runtime/$file" ] || fail "The runtime has no $file."
done
# The panel draws with its own fonts. Bundle.module finds them next to the
# panel, so the bundle stays in app/native/ beside it.
fonts=("$runtime"/app/native/*_ClawdTimeTaskPanel.bundle)
[ -d "${fonts[0]}" ] || fail "The runtime has no font bundle next to the panel (app/native/*_ClawdTimeTaskPanel.bundle)."
read -r version commit < <(/usr/bin/python3 -I - "$runtime" <<'PY'
import hashlib, json, os, re, sys
root = sys.argv[1]
real = os.path.realpath(root) + os.sep
manifest = json.load(open(os.path.join(root, "manifest.json")))
def fail(message):
    sys.exit(f"The runtime manifest is not valid: {message}.")
if manifest.get("name") != "clawdtime": fail("name is not clawdtime")
if manifest.get("arch") != "arm64": fail("arch is not arm64")
version = manifest.get("version")
if not isinstance(version, str) or not re.fullmatch(r"(0|[1-9][0-9]{0,3})(\.(0|[1-9][0-9]{0,3})){2}", version):
    fail("version must be three numbers")
commit = manifest.get("commit")
if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{7,40}", commit): fail("commit is not a git revision")
files = manifest.get("files")
if not isinstance(files, dict) or not files: fail("it lists no files")
for path, digest in files.items():
    parts = path.split("/")
    if path.startswith("/") or any(part in ("", ".", "..") for part in parts): fail(f"unsafe path {path}")
    full = os.path.join(root, path)
    if not os.path.realpath(full).startswith(real): fail(f"{path} leaves the runtime")
    with open(full, "rb") as handle:
        if hashlib.sha256(handle.read()).hexdigest() != digest: fail(f"{path} differs from its hash")
# Every link stays inside the runtime and is relative, as a signed bundle needs.
for folder, dirs, names in os.walk(root):
    for name in dirs + names:
        path = os.path.join(folder, name)
        if os.path.islink(path):
            target = os.readlink(path)
            if target.startswith("/") or not os.path.realpath(path).startswith(real):
                sys.exit(f"The runtime link {os.path.relpath(path, root)} points outside the runtime.")
print(version, commit)
PY
)
[ -n "${version:-}" ] || fail "The runtime manifest could not be read."

if [ -z "$binary" ]; then
  (cd "$mac" && swift build -c release --product ClawdTime --arch arm64)
  binary="$(cd "$mac" && swift build -c release --product ClawdTime --arch arm64 --show-bin-path)/ClawdTime"
fi
[ -x "$binary" ] || fail "No app binary at $binary."
lipo -archs "$binary" | tr ' ' '\n' | grep -qx arm64 || fail "$binary is not built for arm64."

app="$out/ClawdTime.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/ClawdTime"
chmod 755 "$app/Contents/MacOS/ClawdTime"
icon=""
if [ -f "$mac/Resources/AppIcon.icns" ]; then
  cp "$mac/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
  icon="AppIcon"
fi
ditto --norsrc --noextattr --noqtn "$runtime" "$app/Contents/Resources/runtime"
printf 'APPL????' > "$app/Contents/PkgInfo"

build_number="${CLAWDTIME_BUILD_NUMBER:-1}"
[[ "$build_number" =~ ^[1-9][0-9]{0,4}$ ]] || fail "CLAWDTIME_BUILD_NUMBER must be a whole number from 1 to 99999."
source_revision="$(git -C "$mac" rev-parse HEAD 2>/dev/null || printf unknown)"
/usr/bin/python3 -I - "$app/Contents/Info.plist" "$version" "$build_number" "$commit" "$source_revision" "$icon" <<'PY'
import plistlib, sys
path, version, build, commit, source, icon = sys.argv[1:7]
info = {
    "CFBundleDevelopmentRegion": "en",
    "CFBundleDisplayName": "ClawdTime",
    "CFBundleExecutable": "ClawdTime",
    "CFBundleIdentifier": "com.clawdtime.app",
    "CFBundleInfoDictionaryVersion": "6.0",
    "CFBundleName": "ClawdTime",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": version,
    "CFBundleVersion": build,
    "LSApplicationCategoryType": "public.app-category.productivity",
    "LSArchitecturePriority": ["arm64"],
    "LSMinimumSystemVersion": "14.0",
    "NSHighResolutionCapable": True,
    "NSPrincipalClass": "NSApplication",
    "NSSupportsAutomaticTermination": False,
    "NSSupportsSuddenTermination": False,
    "NSMicrophoneUsageDescription": "ClawdTime listens only while you talk to it, and sends what you said to be turned into text.",
    "NSAppleEventsUsageDescription": "ClawdTime works in an app on this Mac only for a task you asked for.",
    "ClawdTimeRuntimeVersion": version,
    "ClawdTimeRuntimeCommit": commit,
    "ClawdTimeSourceRevision": source,
}
if icon:
    info["CFBundleIconFile"] = icon
with open(path, "wb") as handle:
    plistlib.dump(info, handle)
PY
plutil -lint "$app/Contents/Info.plist" >/dev/null

CLAWDTIME_SIGN_IDENTITY="" CLAWDTIME_NOTARY_PROFILE="" "$here/sign-and-notarize.sh" --app "$app" --sign-only
codesign --verify --deep --strict "$app"

if [ "$self_test" = 1 ]; then
  "$app/Contents/MacOS/ClawdTime" --self-test || fail "The self-test of $app failed."
fi
printf 'Built %s (version %s, build %s, runtime %s).\n' "$app" "$version" "$build_number" "$commit"
[ -n "$icon" ] || printf 'No mac/Resources/AppIcon.icns yet: the app has the default icon.\n'
