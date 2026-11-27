#!/bin/bash
# Signs ClawdTime.app and every executable inside it, makes the DMG, notarizes
# it, staples the ticket and checks a quarantined copy.
#   mac/scripts/sign-and-notarize.sh --app <dir>/ClawdTime.app --out <dir>
#   mac/scripts/sign-and-notarize.sh --app <dir>/ClawdTime.app --sign-only
# Release signing needs both:
#   CLAWDTIME_SIGN_IDENTITY    a Developer ID Application identity in the keychain
#   CLAWDTIME_NOTARY_PROFILE   a keychain profile made with: xcrun notarytool store-credentials
# Without both it signs ad hoc, does not notarize, and names the DMG ...-unsigned.dmg.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
usage() { printf 'Use: %s --app PATH/ClawdTime.app (--out DIR | --sign-only)\n' "$(basename "$0")"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
app="" out="" sign_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --sign-only) sign_only=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$app" ] || { usage >&2; exit 2; }
[ "$sign_only" = 1 ] || [ -n "$out" ] || { usage >&2; exit 2; }
[ -x "$app/Contents/MacOS/ClawdTime" ] || fail "No ClawdTime app at $app."
app="$(cd "$app" && pwd)"

identity="${CLAWDTIME_SIGN_IDENTITY:-}"
profile="${CLAWDTIME_NOTARY_PROFILE:-}"
if [ -n "$identity" ] && [ -n "$profile" ]; then
  mode=release
  security find-identity -v -p codesigning | grep -Fq "\"$identity\"" ||
    fail "The keychain has no valid signing identity named $identity."
else
  mode=adhoc
  if [ -n "$identity$profile" ]; then
    printf 'Both CLAWDTIME_SIGN_IDENTITY and CLAWDTIME_NOTARY_PROFILE are needed for a release. Signing ad hoc.\n' >&2
  fi
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
entitlements() {
  local name="$1"; shift
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'
    for key in "$@"; do printf '<key>%s</key><true/>\n' "$key"; done
    printf '</dict></plist>\n'
  } > "$work/$name.plist"
}
# The app is the responsible process for what its children ask macOS for.
entitlements app com.apple.security.device.audio-input com.apple.security.automation.apple-events
# Node compiles JavaScript as it runs, and loads the native addons of its
# packages (.node and .dylib files), which another team signed. It never gets
# com.apple.security.get-task-allow: no other process may attach to it.
node_entitlements=(com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory com.apple.security.cs.disable-library-validation)
entitlements node "${node_entitlements[@]}"
# The panel listens while the person talks to it.
entitlements panel com.apple.security.device.audio-input

sign() {
  local file="$1" plist="${2:-}"
  if [ "$mode" = release ]; then
    if [ -n "$plist" ]; then
      codesign --force --timestamp --options runtime --entitlements "$work/$plist.plist" --sign "$identity" "$file"
    else
      codesign --force --timestamp --options runtime --sign "$identity" "$file"
    fi
  else
    # Ad hoc code cannot pass library validation, so it runs without the
    # hardened runtime. It is for checks on this Mac only. It gets the same
    # entitlements, so the checks below see what a release gets.
    if [ -n "$plist" ]; then
      codesign --force --entitlements "$work/$plist.plist" --sign - "$file"
    else
      codesign --force --sign - "$file"
    fi
  fi
}

# The entitlements that a signed file carries, one key per line.
signed_entitlements() {
  codesign -d --entitlements - --xml "$1" 2>/dev/null | /usr/bin/python3 -I -c '
import plistlib, sys
data = sys.stdin.buffer.read()
start = data.find(b"<?xml")
for key, value in (plistlib.loads(data[start:]) if start >= 0 else {}).items():
    if value is True: print(key)
'
}

xattr -cr "$app"
# Every Mach-O file inside the app, deepest first, so each signature seals the ones it holds.
nested="$work/nested.txt"
/usr/bin/python3 -I - "$app" > "$nested" <<'PY'
import os, struct, sys
app = sys.argv[1]
main = os.path.join(app, "Contents", "MacOS", "ClawdTime")
thin = {0xFEEDFACF, 0xCFFAEDFE, 0xFEEDFACE, 0xCEFAEDFE}
found = []
for folder, _, names in os.walk(os.path.join(app, "Contents")):
    for name in names:
        path = os.path.join(folder, name)
        if path == main or os.path.islink(path) or not os.path.isfile(path):
            continue
        with open(path, "rb") as handle:
            head = handle.read(8)
        if len(head) < 8:
            continue
        magic, count = struct.unpack(">II", head)
        # A universal binary; a Java class file shares its magic but has a large second word.
        if magic in thin or (magic in (0xCAFEBABE, 0xCAFEBABF) and 0 < count < 30):
            found.append(path)
for path in sorted(found, key=lambda item: (-item.count(os.sep), item)):
    print(path)
PY
count=0
while IFS= read -r file; do
  case "$file" in
    */runtime/node/bin/node) sign "$file" node ;;
    */runtime/app/native/ClawdTimeTaskPanel) sign "$file" panel ;;
    *) sign "$file" ;;
  esac
  count=$((count + 1))
done < "$nested"
sign "$app" app
codesign --verify --deep --strict "$app"
while IFS= read -r file; do codesign --verify --strict "$file"; done < "$nested"
node="$app/Contents/Resources/runtime/node/bin/node"
if [ -f "$node" ]; then
  granted="$(signed_entitlements "$node")"
  for key in "${node_entitlements[@]}"; do
    printf '%s\n' "$granted" | grep -qx "$key" || fail "Node is signed without $key."
  done
  ! printf '%s\n' "$granted" | grep -qx com.apple.security.get-task-allow || fail "Node is signed with get-task-allow."
fi
fonts=("$app"/Contents/Resources/runtime/app/native/*_ClawdTimeTaskPanel.bundle)
[ ! -e "$app/Contents/Resources/runtime/app/native/ClawdTimeTaskPanel" ] || [ -d "${fonts[0]}" ] ||
  fail "The panel's font bundle is not next to the panel."
printf 'Signed %s and %d nested executable(s) %s.\n' "$app" "$count" "$([ "$mode" = release ] && printf 'with %s' "$identity" || printf 'ad hoc')"
[ "$sign_only" = 1 ] && exit 0

if [ "$mode" = adhoc ]; then
  dmg="$("$here/make-dmg.sh" --app "$app" --out "$out" --unsigned | tail -n 1)"
  printf 'Made %s. It is not notarized: macOS blocks it when it is downloaded. Use it for checks on this Mac only.\n' "$dmg"
  exit 0
fi

dmg="$("$here/make-dmg.sh" --app "$app" --out "$out" | tail -n 1)"
codesign --force --timestamp --sign "$identity" "$dmg"
codesign --verify --strict "$dmg"
printf 'Sending %s to the notary service. This waits for its answer.\n' "$dmg"
result="$work/notary.json"
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait --output-format json > "$result" || true
status="$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$result" 2>/dev/null || true)"
if [ "$status" != "Accepted" ]; then
  submission="$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$result" 2>/dev/null || true)"
  [ -n "$submission" ] && xcrun notarytool log "$submission" --keychain-profile "$profile" >&2 || true
  fail "Notarization status: ${status:-unknown}. The DMG is not ready to publish."
fi
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
(cd "$(dirname "$dmg")" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")

# Check a copy as a browser leaves it: quarantined, then opened by Gatekeeper.
check="$work/check"
mkdir -p "$check/mount"
cp "$dmg" "$check/ClawdTime.dmg"
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;" "$check/ClawdTime.dmg"
spctl --assess --type open --context context:primary-signature -vv "$check/ClawdTime.dmg"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$check/mount" "$check/ClawdTime.dmg"
detach() { hdiutil detach -quiet "$check/mount" || true; }
trap 'detach; rm -rf "$work"' EXIT
codesign --verify --deep --strict "$check/mount/ClawdTime.app"
spctl --assess --type execute -vv "$check/mount/ClawdTime.app"
[ -L "$check/mount/Applications" ] || fail "The DMG has no Applications link."
printf 'Notarized, stapled and checked: %s\n' "$dmg"
