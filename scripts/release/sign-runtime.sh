#!/bin/bash
# Signs the code of a release runtime ad hoc. The runtime builder runs it
# after the audit and before the manifest, so the manifest lists the signed
# files.
#
#   scripts/release/sign-runtime.sh RUNTIME
#
# Node and the two native helpers get the hardened runtime. macOS then ignores
# DYLD_ variables such as DYLD_INSERT_LIBRARIES for them, so no other library
# runs inside the panel that holds the Accessibility and Screen Recording
# permissions of the person, or inside Node. Each one gets only the
# entitlements that it needs:
#   app/native/ClawdTimeTaskPanel    audio-input: it listens while the person talks to it
#   app/native/ClawdTimeTaskCapture  none
#   node/bin/node                    allow-jit and allow-unsigned-executable-memory:
#                                    it compiles JavaScript as it runs.
#                                    disable-library-validation: it loads the
#                                    native addons of app/node_modules, which
#                                    are signed ad hoc
# Node gets no allow-dyld-environment-variables and no get-task-allow.
# Each .node and .dylib file is signed ad hoc. Any other Mach-O file stops it,
# so each piece of code in the runtime has a signature that this file chose.
set -euo pipefail

fail() {
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}
[ $# -eq 1 ] && [ -d "$1" ] || {
  printf 'Use: %s RUNTIME\n' "$0" >&2
  exit 2
}
runtime=$(cd "$1" && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/clawdtime-sign.XXXXXX")
trap 'rm -rf "$work"' EXIT

entitlements() {
  local name=$1 key
  shift
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<plist version="1.0"><dict>\n'
    for key in "$@"; do printf '<key>%s</key><true/>\n' "$key"; done
    printf '</dict></plist>\n'
  } >"$work/$name.plist"
}
entitlements node com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory \
  com.apple.security.cs.disable-library-validation
entitlements panel com.apple.security.device.audio-input

# Every Mach-O file, by its first four bytes: thin 64-bit or universal.
export LC_ALL=C
thin=$'\xcf\xfa\xed\xfe' universal=$'\xca\xfe\xba\xbe'
libraries=() unknown=() found=" "
while IFS= read -r -d '' file; do
  magic=""
  IFS= read -r -n 4 -d '' magic <"$file" || true
  [ "$magic" = "$thin" ] || [ "$magic" = "$universal" ] || continue
  path=${file#"$runtime"/}
  case $path in
    node/bin/node | app/native/ClawdTimeTaskPanel | app/native/ClawdTimeTaskCapture) found+="$path " ;;
    *.node | *.dylib) libraries+=("$path") ;;
    *) unknown+=("$path") ;;
  esac
done < <(find "$runtime" -type f -print0)
[ ${#unknown[@]} = 0 ] || fail "an executable with no signing rule: ${unknown[*]}"
executables=(node/bin/node app/native/ClawdTimeTaskPanel app/native/ClawdTimeTaskCapture)
for path in "${executables[@]}"; do
  case $found in *" $path "*) ;; *) fail "$path is missing, or it is not a Mach-O file." ;; esac
done

for path in ${libraries[@]+"${libraries[@]}"}; do
  codesign --force --sign - "$runtime/$path" 2>"$work/codesign.log" ||
    fail "codesign of $path did not finish: $(cat "$work/codesign.log")"
done
for path in "${executables[@]}"; do
  plist=()
  case $path in
    node/bin/node) plist=(--entitlements "$work/node.plist") ;;
    app/native/ClawdTimeTaskPanel) plist=(--entitlements "$work/panel.plist") ;;
  esac
  codesign --force --sign - --options runtime ${plist[@]+"${plist[@]}"} "$runtime/$path" 2>"$work/codesign.log" ||
    fail "codesign of $path did not finish: $(cat "$work/codesign.log")"
done

# Check what macOS will read: a valid signature, and the hardened runtime
# without the entitlements that let DYLD_ variables or a debugger in.
for path in ${libraries[@]+"${libraries[@]}"} "${executables[@]}"; do
  codesign --verify --strict "$runtime/$path" 2>/dev/null || fail "the signature of $path does not verify."
done
for path in "${executables[@]}"; do
  details=$(codesign -dv "$runtime/$path" 2>&1)
  case $details in *"flags=0x"*"runtime"*) ;; *) fail "$path has no hardened runtime." ;; esac
  granted=$(codesign -d --entitlements - --xml "$runtime/$path" 2>/dev/null || true)
  case $granted in
    *allow-dyld-environment-variables* | *get-task-allow*) fail "$path may be given DYLD_ variables or a debugger." ;;
  esac
done
printf 'Signed ad hoc with the hardened runtime: %s.\n' "$(printf '%s, ' "${executables[@]}" | sed 's/, $//')"
printf 'Signed ad hoc: %d native libraries.\n' "${#libraries[@]}"
