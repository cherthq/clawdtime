#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build --product ClawdTimeTaskPanel
output="$PWD/build/ClawdTime Task Panel.app"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources"
cp .build/debug/ClawdTimeTaskPanel "$output/Contents/MacOS/ClawdTimeTaskPanel"
for resources in .build/debug/*ClawdTimeTaskPanel.bundle; do
  if [ -d "$resources" ]; then cp -R "$resources" "$output/Contents/Resources/"; fi
done
cat > "$output/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ClawdTimeTaskPanel</string>
<key>CFBundleIdentifier</key><string>com.clawdtime.task-panel</string>
<key>CFBundleName</key><string>ClawdTime Task Panel</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>ClawdTime listens only while you talk to it, and sends what you said to be turned into text.</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --options runtime --sign - "$output"
codesign --verify --deep --strict "$output"
printf 'Built %s\nLocal ad-hoc signature; not installed or notarized.\n' "$output"
