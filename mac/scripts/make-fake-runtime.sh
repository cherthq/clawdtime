#!/bin/bash
# Makes a fake release runtime with the layout of scripts/release/build-runtime.sh,
# for packaging checks only. Its engine speaks the setup protocol (hello, then it
# leaves on cancel); node and the native helpers are tiny arm64 programs, and a
# native addon is a Mach-O bundle, so signing reaches every nested executable.
#   mac/scripts/make-fake-runtime.sh --out <dir> [--version 0.4.0]
# It writes <dir>/runtime. It never downloads anything.
set -euo pipefail

usage() { printf 'Use: %s --out DIR [--version X.Y.Z]\n' "$(basename "$0")"; }
out="" version="0.4.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { usage >&2; exit 2; }
mkdir -p "$out"
root="$(cd "$out" && pwd)/runtime"
if [ -e "$root" ]; then
  printf '%s exists already. Choose an empty folder.\n' "$root" >&2
  exit 1
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$root/bin" "$root/node/bin" "$root/app/dist/cli" "$root/app/native" \
  "$root/app/node_modules/example-addon/build/Release" "$root/app/node_modules/.bin" "$root/app/node_modules/example-cli" \
  "$root/app/node_modules/example-sdk" "$root/app/native/ClawdTimeCompanion_ClawdTimeTaskPanel.bundle/Fonts"

cat > "$root/bin/clawdtime" <<'ENGINE'
#!/bin/sh
# Fake engine for packaging checks: it speaks protocol 2 and stores nothing.
case "$1 $2" in
  "onboard --json")
    echo '{"type":"hello","protocol":2,"version":"0.4.0"}'
    while IFS= read -r line; do
      case "$line" in *'"type":"cancel"'*) exit 0 ;; esac
    done
    exit 0 ;;
esac
echo "fake runtime: $*" >&2
exit 2
ENGINE
chmod 755 "$root/bin/clawdtime"

printf 'int main(void) { return 0; }\n' > "$work/stub.c"
printf 'int example_addon(void) { return 1; }\n' > "$work/addon.c"
cc -arch arm64 -mmacosx-version-min=14.0 -o "$root/node/bin/node" "$work/stub.c"
cc -arch arm64 -mmacosx-version-min=14.0 -o "$root/app/native/ClawdTimeTaskPanel" "$work/stub.c"
cc -arch arm64 -mmacosx-version-min=14.0 -o "$root/app/native/ClawdTimeTaskCapture" "$work/stub.c"
cc -arch arm64 -mmacosx-version-min=14.0 -bundle -o "$root/app/node_modules/example-addon/build/Release/example.node" "$work/addon.c"
cc -arch arm64 -mmacosx-version-min=14.0 -dynamiclib -o "$root/app/node_modules/example-sdk/libexample.dylib" "$work/addon.c"
# The panel's fonts sit next to it, where Bundle.module looks first.
printf 'Made-up font bytes.\n' > "$root/app/native/ClawdTimeCompanion_ClawdTimeTaskPanel.bundle/Fonts/MadeUp.ttf"
printf 'Made-up license text for the fake node.\n' > "$root/node/LICENSE"
printf '{"name":"clawdtime","version":"%s","type":"module"}\n' "$version" > "$root/app/package.json"
printf '{"version":"%s","commit":"0000000000000000000000000000000000000000"}\n' "$version" > "$root/app/release.json"
printf 'console.log("fake");\n' > "$root/app/dist/cli/main.js"
printf '#!/usr/bin/env node\nconsole.log("example");\n' > "$root/app/node_modules/example-cli/cli.js"
chmod 755 "$root/app/node_modules/example-cli/cli.js"
ln -s ../example-cli/cli.js "$root/app/node_modules/.bin/example-cli"
printf 'A file whose name has spaces.\n' > "$root/app/dist/read me.txt"

/usr/bin/python3 -I - "$root" "$version" <<'PY'
import hashlib, json, os, sys
root, version = sys.argv[1], sys.argv[2]
files = {}
for folder, _, names in os.walk(root):
    for name in names:
        path = os.path.join(folder, name)
        if os.path.islink(path):
            continue
        relative = os.path.relpath(path, root)
        with open(path, "rb") as handle:
            files[relative] = hashlib.sha256(handle.read()).hexdigest()
manifest = {"name": "clawdtime", "version": version, "commit": "0" * 40, "arch": "arm64", "node": "24.0.0", "files": files}
with open(os.path.join(root, "manifest.json"), "w") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
PY
printf 'Fake runtime at %s (version %s). It is for packaging checks only.\n' "$root" "$version"
