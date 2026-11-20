#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${CLAWDTIME_LOCAL_ONLY:-0}" in
  0) app_name="ClawdTime Companion"; bundle_id="com.clawdtime.companion" ;;
  1) app_name="ClawdTime Local Control"; bundle_id="com.clawdtime.local-control" ;;
  *) printf 'CLAWDTIME_LOCAL_ONLY must be 0 or 1.\n' >&2; exit 2 ;;
esac
swift build -c release
output="$PWD/build/$app_name.app"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources"
cp .build/release/ClawdTimeCompanion "$output/Contents/MacOS/ClawdTimeCompanion"
cat > "$output/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ClawdTimeCompanion</string>
<key>CFBundleIdentifier</key><string>$bundle_id</string>
<key>CFBundleName</key><string>$app_name</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.1</string>
<key>CFBundleVersion</key><string>3</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Capture your selected screen for an authorized ClawdTime call or an explicitly enabled local task.</string>
</dict></plist>
PLIST
identity="${CLAWDTIME_SIGNING_IDENTITY:--}"
codesign --force --options runtime --sign "$identity" "$output"
codesign --verify --deep --strict "$output"
printf 'Built %s\n' "$output"
if [[ "$identity" == "-" ]]; then
  printf 'Ad-hoc signed for local qualification only; not notarized or distribution-signed.\n'
fi
