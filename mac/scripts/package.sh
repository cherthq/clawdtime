#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(python3 - <<'PY'
import json
import re
from pathlib import Path

version = json.loads(Path('../package.json').read_text()).get('version')
if not isinstance(version, str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,3})(?:\.(?:0|[1-9][0-9]{0,3})){2}', version):
    raise SystemExit('package.json version must contain three numeric components (0–9999), without prerelease/build suffixes.')
print(version)
PY
)"
build_number="${CLAWDTIME_BUILD_NUMBER-5}"
if [[ ! "$build_number" =~ ^[1-9][0-9]{0,3}$ ]]; then
  printf 'CLAWDTIME_BUILD_NUMBER must be an integer from 1 to 9999.\n' >&2
  exit 1
fi
source_revision="$(git rev-parse HEAD)"
if [[ ! "$source_revision" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'A valid source Git revision is required.\n' >&2
  exit 1
fi
source_dirty="$(python3 - <<'PYDIRTY'
import subprocess
ignored={'docs/PRODUCTION_TEST_READINESS.md','docs/PRODUCTION_WALKTHROUGH_AGENT_PROMPT.md','docs/PRODUCTION_WALKTHROUGH_IMPLEMENTATION_PLAN.md'}
status=subprocess.check_output(['git','-C','..','status','--porcelain','--untracked-files=all'],text=True)
print('true' if any(line[3:] not in ignored for line in status.splitlines()) else 'false')
PYDIRTY
)"
swift build -c release
output="$PWD/build/ClawdTime Companion.app"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources"
cp .build/release/ClawdTimeCompanion "$output/Contents/MacOS/ClawdTimeCompanion"
cat > "$output/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ClawdTimeCompanion</string>
<key>CFBundleIdentifier</key><string>com.clawdtime.companion</string>
<key>CFBundleName</key><string>ClawdTime Companion</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$build_number</string>
<key>ClawdTimeSourceRevision</key><string>$source_revision</string>
<key>ClawdTimeSourceDirty</key><$source_dirty/>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Show your selected screen during an authorized ClawdTime call or explicitly approved text session.</string>
</dict></plist>
PLIST
identity="${CLAWDTIME_SIGNING_IDENTITY:--}"
codesign --force --options runtime --sign "$identity" "$output"
codesign --verify --deep --strict "$output"
printf 'Built %s (version %s, build %s)\n' "$output" "$version" "$build_number"
printf 'Local review artifact; build/signature checks do not establish release qualification.\n'
if [[ "$identity" == "-" ]]; then
  printf 'Ad-hoc signed for local qualification only; not notarized or distribution-signed.\n'
fi
