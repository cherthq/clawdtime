#!/bin/bash
# Read-only production AX witness probe. Run with a disposable TextEdit document
# foregrounded. It neither starts a helper nor sends input or captures a screen.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build --target DeviceCore >/dev/null
build_path=$(swift build --show-bin-path)
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/clawdtime-target-probe.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
swiftc -parse-as-library -I "$build_path/Modules" \
  "$build_path"/DeviceCore.build/*.o \
  Sources/ClawdTimeCompanion/Capture.swift \
  Sources/ClawdTimeCompanion/LocalApplicationWindows.swift \
  Sources/ClawdTimeCompanion/LocalWindowWitness.swift \
  Sources/ClawdTimeCompanion/LocalTargetWitness.swift \
  scripts/diagnose-native-targets.swift -o "$probe_dir/diagnostic"
"$probe_dir/diagnostic"
