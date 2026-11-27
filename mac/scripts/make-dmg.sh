#!/bin/bash
# Makes the download: a compressed DMG with ClawdTime.app and an Applications link.
#   mac/scripts/make-dmg.sh --app <dir>/ClawdTime.app --out <dir> [--unsigned]
# It writes ClawdTime-<version>-arm64.dmg (or ...-arm64-unsigned.dmg) and its
# .sha256, and prints the DMG's path on the last line.
set -euo pipefail

usage() { printf 'Use: %s --app PATH/ClawdTime.app --out DIR [--unsigned]\n' "$(basename "$0")"; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
app="" out="" suffix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) app="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --unsigned) suffix="-unsigned"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$app" ] && [ -n "$out" ] || { usage >&2; exit 2; }
[ -d "$app/Contents" ] || fail "No app at $app."
[ "$(basename "$app")" = "ClawdTime.app" ] || fail "The app must be named ClawdTime.app."
mkdir -p "$out"
out="$(cd "$out" && pwd)"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "The app version $version is not three numbers."
codesign --verify --deep --strict "$app" || fail "$app is not signed. Run sign-and-notarize.sh first."

dmg="$out/ClawdTime-$version-arm64$suffix.dmg"
staging="$(mktemp -d "$out/.dmg-staging.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
ditto "$app" "$staging/ClawdTime.app"
ln -s /Applications "$staging/Applications"
rm -f "$dmg" "$dmg.sha256"
hdiutil create -quiet -volname "ClawdTime" -srcfolder "$staging" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$dmg"
hdiutil verify -quiet "$dmg"
(cd "$out" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
printf '%s\n' "$dmg"
