#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
output="$PWD/build/ClawdTime Companion.app"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources"
cp .build/release/ClawdTimeCompanion "$output/Contents/MacOS/ClawdTimeCompanion"
cat > "$output/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ClawdTimeCompanion</string>
<key>CFBundleIdentifier</key><string>com.clawdtime.companion</string>
<key>CFBundleName</key><string>ClawdTime Companion</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Show your selected screen in your authorized ClawdTime call.</string>
</dict></plist>
PLIST
identity="${CLAWDTIME_SIGNING_IDENTITY:--}"
codesign --force --options runtime --sign "$identity" "$output"
codesign --verify --deep --strict "$output"
printf 'Built %s\n' "$output"
if [[ "$identity" == "-" ]]; then
  printf 'Ad-hoc signed for local qualification only; not notarized or distribution-signed.\n'
fi
