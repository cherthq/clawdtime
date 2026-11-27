#!/bin/bash
# Checks a built release runtime the way a Mac without developer tools runs it.
#
#   scripts/release/smoke-runtime.sh DIR/runtime
#
# It copies the runtime to a folder with spaces, links the command as the
# installer does, and runs it with an empty home folder and a PATH of the
# system folders only, where node, npm, npx and tsx are absent and git, swift,
# xcrun, python3 and the compilers are stand-ins that record any call. Then:
#   - clawdtime --help, clawdtime start --help, clawdtime keys list and
#     clawdtime computer doctor answer
#   - the capture helper answers --preflight (it reads the permission, never asks)
#   - the compiled desktop service starts from the package root, as clawdtime
#     start starts it, with no tsx, on a free port and with a stand-in panel,
#     and answers its authenticated readiness check. It is then stopped.
#   - no developer tool was called
# It shows no window, asks for no permission and leaves nothing behind.
set -euo pipefail

[ $# -eq 1 ] && [ -f "$1/manifest.json" ] || {
  printf 'Use: %s DIR/runtime\n' "$0" >&2
  exit 2
}
source_runtime=$(cd "$1" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/clawdtime-smoke.XXXXXX")
service=""
cleanup() {
  if [ -n "$service" ] && kill -0 "$service" 2>/dev/null; then
    kill -TERM -- "-$service" 2>/dev/null || kill -TERM "$service" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$service" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$service" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

failures=0
pass() { printf 'PASS  %s\n' "$*"; }
miss() {
  printf 'FAIL  %s\n' "$*"
  failures=$((failures + 1))
}

# The runtime in a folder with spaces, linked as the installer links it.
runtime="$tmp/Application Support/ClawdTime/runtime/0.0.0-smoke"
mkdir -p "$(dirname "$runtime")"
cp -Rc "$source_runtime" "$runtime" 2>/dev/null || cp -R "$source_runtime" "$runtime"
ln -s 0.0.0-smoke "$tmp/Application Support/ClawdTime/runtime/current"
home="$tmp/Smoke Home"
mkdir -m 700 "$home"
mkdir -p "$home/.local/bin" "$tmp/tmp"
ln -s "$tmp/Application Support/ClawdTime/runtime/current/bin/clawdtime" "$home/.local/bin/clawdtime"

# The system folders, without node, npm, npx or tsx, and with stand-ins for
# the developer tools that macOS offers to install when they are called.
bin="$tmp/bin"
log="$tmp/developer-tools.log"
: >"$log"
mkdir "$bin"
trapped=" git swift swiftc xcrun xcodebuild xcode-select clang clang++ cc c++ gcc make ld python3 pip3 lldb "
for folder in /bin /usr/bin /usr/sbin /sbin; do
  for tool in "$folder"/*; do
    name=${tool##*/}
    [ -x "$tool" ] && [ ! -e "$bin/$name" ] || continue
    case $name in node | npm | npx | tsx | corepack) continue ;; esac
    case $trapped in *" $name "*) continue ;; esac
    ln -s "$tool" "$bin/$name"
  done
done
for name in $trapped; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\nexit 127\n' "$name" "$log" >"$bin/$name"
  chmod 755 "$bin/$name"
done

run() {
  (cd "$tmp" && /usr/bin/env -i HOME="$home" PATH="$home/.local/bin:$bin" USER="${USER:-smoke}" \
    LOGNAME="${USER:-smoke}" SHELL=/bin/zsh TMPDIR="$tmp/tmp/" LANG=en_US.UTF-8 "$@")
}
expect() {
  local name=$1 want=$2 output status=0
  shift 2
  output=$(run "$@" 2>&1) || status=$?
  if [ "$status" = 0 ] && case $output in *"$want"*) true ;; *) false ;; esac then
    pass "$name"
  else
    miss "$name (exit $status): $(printf '%s' "$output" | head -n 5)"
  fi
}

printf 'Runtime: %s\nHome:    %s\n\n' "$runtime" "$home"
[ -z "$(PATH="$bin" command -v node npm npx tsx 2>/dev/null || true)" ] &&
  pass "no node, npm, npx or tsx on the PATH of the checks" || miss "node, npm, npx or tsx is on the PATH"

expect "clawdtime --help" "start [--project PATH]" clawdtime --help
expect "clawdtime start --help" "clawdtime start: start the ClawdTime desktop" clawdtime start --help
expect "clawdtime keys list" "" clawdtime keys list
expect "clawdtime computer doctor" "desktop service" clawdtime computer doctor
expect "ClawdTimeTaskCapture --preflight" '"screenPermission"' "$runtime/app/native/ClawdTimeTaskCapture" --preflight

for file in "$runtime/app/native/ClawdTimeTaskPanel" "$runtime/app/native/ClawdTimeTaskCapture" "$runtime/node/bin/node"; do
  if codesign --verify --strict "$file" 2>/dev/null; then pass "signature of ${file#"$runtime"/}"; else miss "signature of ${file#"$runtime"/}"; fi
done
if ls -d "$runtime/app/native/"*_ClawdTimeTaskPanel.bundle/Fonts >/dev/null 2>&1; then
  pass "the panel's fonts sit next to the panel"
else
  miss "the panel's resource bundle is not next to the panel"
fi

# The desktop service, started exactly as clawdtime start starts it (the
# package root as root), but on a free port and with a stand-in panel, so it
# shows no window and leaves any running desktop alone.
port=$(run "$runtime/node/bin/node" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
mkdir -p "$tmp/panel" "$home/project"
printf '#!/bin/sh\nexit 0\n' >"$tmp/panel/ClawdTimeTaskPanel"
chmod 755 "$tmp/panel/ClawdTimeTaskPanel"
state="$home/.local/share/clawdtime/desktop"
started=$(run "$runtime/node/bin/node" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const [entry, root, state, project, port, panel] = process.argv.slice(1);
  const { desktopCli } = await import(pathToFileURL(entry).href);
  await desktopCli(
    ["--state", state, "--project", project, "--port", port, "--panel-binary", panel, "--agents", "false"],
    { root, startupMs: 60000 },
  );
' "$runtime/app/dist/cli/task-desktop.js" "$runtime/app" "$state" "$home/project" "$port" "$tmp/panel/ClawdTimeTaskPanel" 2>&1) || true
service=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$state/owner.lock" 2>/dev/null || true)
command=$( [ -n "$service" ] && ps -o args= -p "$service" 2>/dev/null || true)
case $started in
  *"Task service remains running at http://127.0.0.1:$port"*) pass "desktop service ready on 127.0.0.1:$port" ;;
  *) miss "desktop service: $(printf '%s' "$started" | head -n 5)" ;;
esac
case $command in
  *"/app/dist/scripts/task-server.js --state"*)
    case $command in *tsx*) miss "the service runs with tsx: $command" ;; *) pass "service runs dist/scripts/task-server.js on the runtime's Node, no tsx" ;; esac ;;
  *) miss "service command: ${command:-not running}" ;;
esac

if [ -s "$log" ]; then miss "developer tools were called: $(tr '\n' ';' <"$log")"; else pass "no developer tool was called"; fi

printf '\n%s\n' "$([ "$failures" = 0 ] && echo "Smoke test passed." || echo "Smoke test failed: $failures checks.")"
[ "$failures" = 0 ]
