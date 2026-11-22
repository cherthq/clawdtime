#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release --product ClawdTimeReviewWindow
output="$PWD/build/ClawdTime Review View.app"
mkdir -p "$output/Contents/MacOS"
cp .build/release/ClawdTimeReviewWindow "$output/Contents/MacOS/ClawdTimeReviewWindow"
cat > "$output/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ClawdTimeReviewWindow</string>
<key>CFBundleIdentifier</key><string>com.clawdtime.review-view</string>
<key>CFBundleName</key><string>ClawdTime Review View</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --options runtime --sign "${CLAWDTIME_SIGNING_IDENTITY:--}" "$output"
codesign --verify --deep --strict "$output"
printf 'Built %s\n' "$output"
