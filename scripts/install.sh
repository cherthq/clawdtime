#!/bin/sh
# Installs ClawdTime on this Mac, or updates it. It is safe to run again.
#
#   curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh
#
# It installs the newest prebuilt release for Macs with Apple silicon and
# macOS 14 or later. The Mac needs no Node, npm, Git or Xcode. The release goes
# to ~/Library/Application Support/ClawdTime/runtime/VERSION, the link
# "current" there switches to it in one step, and ~/.local/bin/clawdtime runs
# it. Settings, keys and pairing stay where they are. Then, in a terminal, it
# starts the guided setup: clawdtime onboard.
#
# Settings of the release, all optional:
#   CLAWDTIME_RELEASE_BASE  the folder of latest.json and the archive: an https
#                           URL with no user name or password. Default:
#                           https://github.com/cherthq/clawdtime/releases/latest/download
#   CLAWDTIME_NO_GLOBAL     1: no link in ~/.local/bin
#   CLAWDTIME_NO_ONBOARD    1: no guided setup after the install
#   CLAWDTIME_ALLOW_DOWNGRADE  1: install the newest release even when it is
#                           older than the installed one
#   CLAWDTIME_REPLACE_SOURCE   1: point ~/.local/bin/clawdtime at the release
#                           even when it runs a source build now
#
# To build from the source instead, as before (it needs Node 24, Git and Swift 6):
#   curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh -s -- --source
#   sh scripts/install.sh --source        (or CLAWDTIME_FROM_SOURCE=1)
# Settings of the source build, all optional:
#   CLAWDTIME_HOME       the folder of ClawdTime. Default: ~/clawdtime, or the
#                        checkout that holds this file when you run it from one
#   CLAWDTIME_REPO       the repository to clone. Default: the ClawdTime repository
#   CLAWDTIME_BRANCH     the branch. Default: main
#   CLAWDTIME_NO_GLOBAL  1: change nothing outside CLAWDTIME_HOME. No npm link and
#                        no install of the chert command
#
# It never asks for a key, and it never reads, prints or stores one. It never
# uses sudo. The steps that need you come at the end.

set -eu

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nStopped: %s\n' "$*" >&2
  exit 1
}
# Under "curl | sh" the script itself is standard input: no command may read it.
quiet() { "$@" </dev/null >/dev/null 2>&1; }
run() { "$@" </dev/null; }

# A whole number, or 0.
number() {
  case $1 in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$1" ;;
  esac
}

# The real file behind a path, with every link followed.
real() {
  node -e 'try { console.log(require("fs").realpathSync(process.argv[1])) } catch { console.log("") }' "$1" </dev/null
}

# True when npm can write to this folder: it is there and writable, or it can be made.
writable() {
  if [ -e "$1" ]; then [ -w "$1" ]; else [ -w "$(dirname "$1")" ]; fi
}

check_tools() {
  step "Checking this Mac"
  missing=0
  [ "$(uname -s)" = Darwin ] || fail "ClawdTime runs on a Mac with macOS 14 or later."
  macos=$(sw_vers -productVersion 2>/dev/null || echo 0)
  if [ "$(number "${macos%%.*}")" -lt 14 ]; then
    say "Missing: macOS 14 or later. This Mac has $macos. Update it in System Settings, General, Software Update."
    missing=1
  fi

  if command -v node >/dev/null 2>&1; then
    node_version=$(node --version 2>/dev/null </dev/null || echo v0)
    node_major=${node_version#v}
    if [ "$(number "${node_major%%.*}")" -lt 24 ]; then
      say "Missing: Node 24 or later. This Mac has $node_version. Get it from https://nodejs.org, or run: brew install node"
      missing=1
    elif ! command -v npm >/dev/null 2>&1; then
      say "Missing: npm, which comes with Node. Install Node again from https://nodejs.org"
      missing=1
    fi
  else
    say "Missing: Node 24 or later. Get it from https://nodejs.org, or run: brew install node"
    missing=1
  fi

  # /usr/bin/git and /usr/bin/swift only ask macOS to install the command line
  # tools when the tools are not there, so look for the tools first.
  tools=0
  quiet xcode-select -p && tools=1
  git_path=$(command -v git 2>/dev/null || true)
  if [ -n "$git_path" ] && { [ "$tools" = 1 ] || [ "$git_path" != /usr/bin/git ]; } && quiet git --version; then
    :
  else
    say "Missing: git. Install the Xcode command line tools: xcode-select --install"
    missing=1
  fi
  if [ "$tools" = 1 ] && quiet swift --version; then
    swift_major=$(swift --version 2>&1 </dev/null | sed -n 's/.*Swift version \([0-9][0-9]*\).*/\1/p' | head -n 1)
    if [ "$(number "$swift_major")" -lt 6 ]; then
      say "Missing: Swift 6 or later. Update Xcode or the command line tools in System Settings, General, Software Update."
      missing=1
    fi
  else
    say "Missing: Swift. Install the Xcode command line tools: xcode-select --install"
    missing=1
  fi

  [ "$missing" = 0 ] || fail "install what is missing, then run this again."
  say "macOS $macos, Node $node_version, git and Swift $swift_major: ready."
}

get_source() {
  step "Getting ClawdTime in $dir"
  case $dir in
    "$HOME"/Documents | "$HOME"/Documents/* | "$HOME"/Desktop | "$HOME"/Desktop/* | "$HOME"/Downloads | "$HOME"/Downloads/*)
      say "Note: $dir is in Documents, Desktop or Downloads. A scheduled update cannot read those folders. ~/clawdtime is a better place."
      ;;
  esac
  if [ -e "$dir/.git" ]; then
    origin=$(git -C "$dir" remote get-url origin 2>/dev/null </dev/null || true)
    case $origin in
      "$repo" | *[/:]cherthq/clawdtime | *[/:]cherthq/clawdtime.git) ;;
      *) fail "$dir is a checkout of another repository. Set CLAWDTIME_HOME to another folder." ;;
    esac
    current=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null </dev/null || echo unknown)
    if [ -n "$(git -C "$dir" status --porcelain </dev/null)" ]; then
      say "Kept $dir as it is: it has changes of your own. This builds what is there."
    elif [ "$current" != "$branch" ]; then
      say "Kept $dir as it is: it is on the branch $current, not $branch. This builds what is there."
    elif run git -C "$dir" pull --ff-only --quiet origin "$branch"; then
      say "Updated to the newest $branch: $(git -C "$dir" log -1 --format=%h </dev/null)."
    else
      say "Kept $dir as it is: the newest $branch does not fit on it. This builds what is there."
    fi
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    fail "$dir is there and is not a ClawdTime checkout. Move it, or set CLAWDTIME_HOME to another folder."
  else
    run git clone --quiet --branch "$branch" "$repo" "$dir" ||
      fail "git clone did not finish. Check the network, then run this again."
    say "Cloned $branch: $(git -C "$dir" log -1 --format=%h </dev/null)."
  fi
}

build() {
  cd "$dir"
  step "Installing the packages (npm ci)"
  run npm ci --no-audit --no-fund --loglevel=error ||
    fail "npm ci did not finish. The lines above say why. Then run this again."
  step "Building ClawdTime (npm run build)"
  run npm run --silent build || fail "the build did not finish. The lines above say why."
  step "Installing the line agent (npm install in line/)"
  (cd line && run npm install --no-audit --no-fund --loglevel=error) ||
    fail "npm install in line/ did not finish. The lines above say why. Then run this again."
  step "Building the panel (swift build in mac/)"
  (cd mac && run swift build --product ClawdTimeTaskPanel) ||
    fail "swift build did not finish. The lines above say why. Then run this again."
}

# The user folder for commands when npm may not write to its global folder.
user_prefix=$HOME/.local
path_line=""
need_path() {
  case ":$PATH:" in
    *":$user_prefix/bin:"*) ;;
    *) path_line="echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile && export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
}

# Runs a global npm command, in a user folder when npm may not write to its own.
npm_global() {
  global=$(npm prefix -g 2>/dev/null </dev/null || echo /nonexistent)
  if writable "$global/bin" && writable "$global/lib/node_modules" &&
    run npm "$@" --no-audit --no-fund --loglevel=error; then
    return 0
  fi
  say "npm may not write to $global. Using $user_prefix instead, with no sudo."
  mkdir -p "$user_prefix/bin" "$user_prefix/lib"
  run env NPM_CONFIG_PREFIX="$user_prefix" npm "$@" --no-audit --no-fund --loglevel=error || return 1
  need_path
}

link_command() {
  step "The clawdtime command"
  entry=$(real "$dir/dist/cli/main.js")
  if [ "$no_global" = 1 ]; then
    say "Skipped npm link: CLAWDTIME_NO_GLOBAL=1. To get the command later: cd $dir && npm link"
    unlinked=1
    return
  fi
  existing=$(command -v clawdtime 2>/dev/null || true)
  [ -n "$existing" ] || { [ -x "$user_prefix/bin/clawdtime" ] && existing=$user_prefix/bin/clawdtime; } || true
  if [ -n "$existing" ] && [ "$(real "$existing")" = "$entry" ]; then
    say "Ready: $existing runs this copy."
    case ":$PATH:" in *":$(dirname "$existing"):"*) ;; *) need_path ;; esac
    return
  fi
  if [ -n "$existing" ]; then
    say "Kept $existing: it runs another copy of ClawdTime. To use this copy: cd $dir && npm link"
    unlinked=1
    return
  fi
  npm_global link || fail "npm link did not finish. The lines above say why."
  say "Ready: clawdtime runs this copy."
}

chert_command() {
  step "The chert command"
  found=$(command -v chert 2>/dev/null || true)
  [ -n "$found" ] || { [ -x "$user_prefix/bin/chert" ] && found=$user_prefix/bin/chert; } || true
  if [ -n "$found" ]; then
    say "Ready: $found"
    case ":$PATH:" in *":$(dirname "$found"):"*) ;; *) need_path ;; esac
    return
  fi
  if [ "$no_global" = 1 ]; then
    say "Skipped: CLAWDTIME_NO_GLOBAL=1. Install it later: npm install -g @trychert/facetime@beta"
    return
  fi
  npm_global install -g @trychert/facetime@beta ||
    fail "the chert command did not install. The lines above say why."
  say "Installed @trychert/facetime@beta."
}

next_steps() {
  panel=$dir/mac/.build/debug/ClawdTimeTaskPanel
  say ""
  say "ClawdTime is installed in $dir."
  if [ -n "$path_line" ]; then
    say ""
    say "First put the commands on your PATH, now and in new terminals:"
    say "  $path_line"
  fi
  if [ "$unlinked" = 1 ]; then
    say ""
    say "The clawdtime command is not linked to this copy. Until it is, run"
    say "node $dir/dist/cli/main.js where the steps below say clawdtime."
  fi
  say ""
  say "Three steps need you. Run them in a terminal:"
  say "  1. Connect a line: clawdtime connect"
  say "     It signs you in to Chert and gets you a line, one step at a time."
  say "  2. Add a model key: clawdtime keys set openai"
  say "     It reads the key from a hidden prompt. Other providers: clawdtime keys help"
  say "  3. Give the panel two permissions in System Settings, Privacy & Security:"
  say "     Accessibility, and Screen & System Audio Recording. In each list, press +"
  say "     and choose $panel"
  say "     (press Command+Shift+G to type the path)."
  say ""
  say "Then start it:"
  say "  clawdtime computer on"
  say "  clawdtime start"
  say "The mascot appears. Click it to open the chat. Run clawdtime connect once more,"
  say "so that the desktop gets its calling policy."
  say ""
  say "Check it: clawdtime computer doctor"
  say "The guide: $dir/INSTALL.md"
}

source_main() {
  repo=${CLAWDTIME_REPO:-https://github.com/cherthq/clawdtime.git}
  branch=${CLAWDTIME_BRANCH:-main}
  no_global=${CLAWDTIME_NO_GLOBAL:-0}
  unlinked=0
  # Run from a checkout (sh scripts/install.sh), it installs that checkout.
  here=""
  case $0 in
    */install.sh) here=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || true) ;;
  esac
  if [ -n "${CLAWDTIME_HOME:-}" ]; then
    dir=$CLAWDTIME_HOME
  elif [ -n "$here" ] && [ -f "$here/cli/main.ts" ] && [ -f "$here/scripts/install.sh" ]; then
    dir=$here
  else
    dir=$HOME/clawdtime
  fi
  case $dir in
    /*) ;;
    *) dir=$(pwd)/$dir ;;
  esac

  check_tools
  get_source
  build
  link_command
  chert_command
  next_steps
}

# The release route: a prebuilt runtime, with no Node, Git or Xcode.

release_base=https://github.com/cherthq/clawdtime/releases/latest/download

# Letters and digits, listed one by one: in some locales a range such as a-z
# also matches other letters.
alnum=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789

# Prints the kind of a URL that the installer may download from, or fails:
#   https  a host name and an optional port: no user name, no password
#   http   127.0.0.1 and an optional port, for a local test release
#   file   an absolute path, for a local test release
# A URL has no space, query, fragment or backslash.
url_kind() {
  case $1 in '' | *[!"$alnum._~:/%+@-"]*) return 1 ;; esac
  case $1 in
    https://*) kind=https rest=${1#https://} ;;
    http://*) kind=http rest=${1#http://} ;;
    file:///*)
      echo file
      return 0
      ;;
    *) return 1 ;;
  esac
  authority=${rest%%/*}
  host=${authority%%:*}
  case $host in '' | *[!"$alnum.-"]* | [.-]* | *[.-]) return 1 ;; esac
  case $authority in
    *:*)
      port=${authority#*:}
      case $port in '' | *[!0-9]* | ??????*) return 1 ;; esac
      [ "$port" -le 65535 ] || return 1
      ;;
  esac
  [ "$kind" = https ] || [ "$host" = 127.0.0.1 ] || return 1
  echo "$kind"
}

check_mac() {
  step "Checking this Mac"
  [ "$(uname -s)" = Darwin ] || fail "ClawdTime runs on a Mac with macOS 14 or later."
  [ "$(id -u)" != 0 ] || fail "run this without sudo. ClawdTime installs in your own home folder."
  macos=$(sw_vers -productVersion 2>/dev/null || echo 0)
  macos_major=$(number "${macos%%.*}")
  [ "$macos_major" -ge 14 ] ||
    fail "ClawdTime needs macOS 14 or later. This Mac has $macos. Update it in System Settings, General, Software Update."
  # A shell under Rosetta says x86_64; the chip still is Apple silicon.
  if [ "$(uname -m)" != arm64 ] && [ "$(sysctl -in hw.optional.arm64 2>/dev/null)" != 1 ]; then
    fail "this release is for Macs with Apple silicon. On this Mac, build from the source: sh install.sh --source"
  fi
  for tool in curl tar shasum plutil; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing. It comes with macOS."
  done
  say "macOS $macos on Apple silicon: ready."
}

# Downloads $1 to the file $2. Only https, except a local test release.
fetch() {
  if [ -t 2 ]; then progress=--progress-bar; else progress=--silent; fi
  curl --fail --location --show-error "$progress" --retry 2 --proto "$protocols" --proto-redir "$protocols" \
    --output "$2" "$1" </dev/null
}

# A field of latest.json, or nothing.
field() { plutil -extract "$1" raw -o - "$tmp/latest.json" 2>/dev/null </dev/null || true; }

# MAJOR.MINOR.PATCH, each part a number of at most 9 digits.
valid_version() {
  case $1 in '' | *[!0-9.]* | .* | *. | *..* | *[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*) return 1 ;; esac
  [ "$(printf '%s' "$1" | tr -cd . | wc -c | tr -d ' ')" = 2 ]
}

# True when the valid version $1 is older than the valid version $2, part by
# part as numbers: 0.9.0 is older than 0.10.0.
older() {
  a=$1. b=$2.
  while [ -n "$a" ]; do
    x=${a%%.*} y=${b%%.*}
    [ "$x" -eq "$y" ] || {
      [ "$x" -lt "$y" ]
      return
    }
    a=${a#*.} b=${b#*.}
  done
  return 1
}

read_latest() {
  step "Finding the newest release"
  fetch "$base/latest.json" "$tmp/latest.json" ||
    fail "latest.json did not download from $base. Check the network, then run this again."
  version=$(field version)
  commit=$(field commit)
  sha256=$(field sha256)
  url=$(field url)
  minimum=$(field minimumMacOS)
  valid_version "$version" || fail "latest.json names no valid version."
  case $commit in *[!0-9a-f]* | '') fail "latest.json names no valid commit." ;; esac
  [ ${#commit} = 40 ] || fail "latest.json names no valid commit."
  case $sha256 in *[!0-9a-f]* | '') fail "latest.json has no valid SHA-256." ;; esac
  [ ${#sha256} = 64 ] || fail "latest.json has no valid SHA-256."
  [ "$(field arch)" = arm64 ] || fail "the newest release is not for Apple silicon."
  [ "$(number "${minimum%%.*}")" -le "$macos_major" ] ||
    fail "ClawdTime $version needs macOS $minimum or later. This Mac has $macos. Update it in System Settings, General, Software Update."
  # An absolute url of the same kind as the base, or a file name next to latest.json.
  case $url in
    *://*)
      [ "$(url_kind "$url" || true)" = "$base_kind" ] || fail "latest.json has no valid url."
      archive_url=$url
      ;;
    '' | .* | *[!"$alnum._-"]*) fail "latest.json has no valid url." ;;
    *) archive_url=$base/$url ;;
  esac
  say "ClawdTime $version ($(printf '%s' "$commit" | cut -c 1-7))."
}

# Checks every file of the runtime in $1 against its manifest, with the Node
# of that runtime. It needs nothing else on the Mac.
# shellcheck disable=SC2016 # JavaScript, not shell.
verify_js='
const [dir, version, commit] = process.argv.slice(1);
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const stop = (text) => { console.error(text); process.exit(1); };
let manifest;
try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); }
catch { stop("manifest.json cannot be read."); }
if (manifest.name !== "clawdtime" || manifest.version !== version ||
    manifest.commit !== commit || manifest.arch !== "arm64")
  stop("manifest.json is for another release.");
const files = Object.entries(manifest.files ?? {});
if (!files.length) stop("manifest.json lists no files.");
for (const [path, sha] of files) {
  if (path.startsWith("/") || path.split("/").includes("..")) stop(`Bad path: ${path}`);
  const stat = lstatSync(join(dir, path), { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) stop(`Missing: ${path}`);
  if (createHash("sha256").update(readFileSync(join(dir, path))).digest("hex") !== sha)
    stop(`Changed: ${path}`);
}
'
verify() {
  [ -x "$1/node/bin/node" ] && "$1/node/bin/node" -e "$verify_js" "$1" "$version" "$commit" </dev/null
}

take_lock() {
  lock=$runtimes/.install-lock
  if ! mkdir "$lock" 2>/dev/null; then
    other=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
      fail "another install runs now (process $other). Wait for it to end, then run this again."
    fi
    rm -rf "$lock"
    mkdir "$lock" || fail "$lock cannot be made."
  fi
  echo $$ >"$lock/pid"
}

cleanup() {
  [ -z "${incoming:-}" ] || rm -rf "$incoming"
  [ -z "${tmp:-}" ] || rm -rf "$tmp"
  [ -z "${lock:-}" ] || [ "$(cat "$lock/pid" 2>/dev/null)" != $$ ] || rm -rf "$lock"
}

# The newest version folder other than $1, or nothing.
newest_folder() {
  newest=""
  for folder in "$runtimes"/*; do
    name=${folder##*/}
    valid_version "$name" && [ -d "$folder" ] && [ ! -L "$folder" ] && [ "$name" != "$1" ] || continue
    [ -n "$newest" ] && ! older "$newest" "$name" || newest=$name
  done
  printf '%s\n' "$newest"
}

# An older release than the installed one goes in only on request. The
# installed one is the version that "current" names. When that link is gone
# or names no version folder, it is the newest version folder.
check_order() {
  installed=$(readlink "$runtimes/current" 2>/dev/null || true)
  if ! valid_version "$installed" || [ ! -d "$runtimes/$installed" ]; then
    installed=$(newest_folder "")
  fi
  downgrade=0
  valid_version "$installed" && older "$version" "$installed" || return 0
  [ "${CLAWDTIME_ALLOW_DOWNGRADE:-0}" = 1 ] ||
    fail "ClawdTime $installed is installed, and the newest release, $version, is older. Nothing changed. To go back to $version, run this again with CLAWDTIME_ALLOW_DOWNGRADE=1."
  downgrade=1
  say "Going back from ClawdTime $installed to $version: CLAWDTIME_ALLOW_DOWNGRADE=1."
}

install_runtime() {
  if [ -d "$runtimes/$version" ] && verify "$runtimes/$version" 2>/dev/null; then
    say "ClawdTime $version is installed already, and every file checks out."
    return
  fi
  step "Downloading ClawdTime $version"
  fetch "$archive_url" "$tmp/clawdtime.tar.gz" ||
    fail "the release did not download. Check the network, then run this again. Nothing changed."
  actual=$(shasum -a 256 "$tmp/clawdtime.tar.gz" | cut -d ' ' -f 1)
  [ "$actual" = "$sha256" ] ||
    fail "the download does not match the SHA-256 in latest.json. It is not installed, and nothing changed. Run this again later."
  say "SHA-256 $actual: it matches latest.json."

  step "Installing ClawdTime $version"
  incoming=$(mktemp -d "$runtimes/.incoming.XXXXXX")
  tar -xzf "$tmp/clawdtime.tar.gz" -C "$incoming" </dev/null ||
    fail "the release did not unpack. Nothing changed."
  verify "$incoming/runtime" || fail "the unpacked files do not match the release manifest. Nothing changed."
  "$incoming/runtime/bin/clawdtime" --help </dev/null >/dev/null 2>&1 ||
    fail "the new runtime does not start on this Mac. Nothing changed."
  if [ -e "$runtimes/$version" ]; then
    # An earlier copy of this version that is damaged: set it aside, then remove it.
    mv "$runtimes/$version" "$incoming/replaced"
  fi
  mv "$incoming/runtime" "$runtimes/$version"
  say "Unpacked and checked every file of ClawdTime $version."
}

# The ID of one process that runs from the version folder $1, or nothing.
# The launcher starts Node by the real path of its version folder, so that
# folder is in the command line of the command, the desktop service, the panel
# and a connection. ps runs alone: in a pipe with grep, it could list the grep.
running_from() {
  processes=$(ps -axww -o pid= -o args= 2>/dev/null || true)
  printf '%s\n' "$processes" | grep -F -- "$physical/$1/" | sed -n '1s/^ *\([0-9][0-9]*\) .*/\1/p'
}

switch_current() {
  # The version that ran before this install (check_order found it).
  previous=$installed
  if [ "$(readlink "$runtimes/current" 2>/dev/null || true)" != "$version" ]; then
    ln -s "$version" "$runtimes/.current.$$"
    # One rename: "current" names the old version or the new one, never neither.
    mv -fh "$runtimes/.current.$$" "$runtimes/current" ||
      fail "$runtimes/current cannot be switched. Move it away, then run this again."
  fi
  # Keep the new version and the one before it: the version that ran before,
  # or, on a rerun of the same version, the newest other one. Remove older
  # copies, but never one that still runs.
  before=$previous
  if [ "$before" = "$version" ] || ! valid_version "$before"; then
    before=$(newest_folder "$version")
  fi
  for old in "$runtimes"/*; do
    name=${old##*/}
    valid_version "$name" && [ -d "$old" ] || continue
    [ "$name" != "$version" ] && [ "$name" != "$before" ] || continue
    pid=$(running_from "$name")
    if [ -n "$pid" ]; then
      say "Kept ClawdTime $name: it still runs (process $pid). A later update removes it after it stops."
    else
      rm -rf "$old"
    fi
  done
  for old in "$runtimes"/.incoming.* "$runtimes"/.current.*; do
    [ -e "$old" ] || [ -L "$old" ] || continue
    [ "$old" = "${incoming:-}" ] || rm -rf "$old"
  done
  launcher=$runtimes/current/bin/clawdtime
}

# The real path of the file behind the link $1, through every link, or
# nothing when it is gone. Plain shell: the Mac may have no Node.
resolve() {
  file=$1 hops=0
  while [ -L "$file" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 40 ] || return 0
    next=$(readlink "$file")
    case $next in
      /*) file=$next ;;
      *) file=$(dirname "$file")/$next ;;
    esac
  done
  [ -e "$file" ] || return 0
  folder=$(cd -P "$(dirname "$file")" 2>/dev/null && pwd -P) || return 0
  printf '%s/%s\n' "$folder" "${file##*/}"
}

# The ClawdTime source checkout that holds the file $1, or nothing.
source_checkout() {
  [ -n "$1" ] || return 0
  folder=$(dirname "$1")
  while :; do
    if [ -f "$folder/cli/main.ts" ] && [ -f "$folder/scripts/install.sh" ]; then
      printf '%s\n' "$folder"
      return 0
    fi
    [ "$folder" != / ] && [ "$folder" != . ] || return 0
    folder=$(dirname "$folder")
  done
}

link_release() {
  step "The clawdtime command"
  if [ "${CLAWDTIME_NO_GLOBAL:-0}" = 1 ]; then
    say "Skipped the link in ~/.local/bin: CLAWDTIME_NO_GLOBAL=1. The command is $launcher"
    command_name=$launcher
    return
  fi
  link=$user_prefix/bin/clawdtime
  mkdir -p "$user_prefix/bin"
  command_name=clawdtime
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    say "Kept $link: it is a file of your own, not a link. The command of this release is $launcher"
    command_name=$launcher
    return
  fi
  points_to=$(readlink "$link" 2>/dev/null || true)
  if [ -L "$link" ] && [ "$points_to" != "$launcher" ]; then
    # A source build (sh install.sh --source) linked it: keep it unless asked.
    checkout=$(source_checkout "$(resolve "$link")")
    if [ -n "$checkout" ] && [ "${CLAWDTIME_REPLACE_SOURCE:-0}" != 1 ]; then
      say "Kept $link: it runs the source build in $checkout. To use this release there, run this again with CLAWDTIME_REPLACE_SOURCE=1. The command of this release is $launcher"
      command_name=$launcher
      return
    fi
    [ -z "$checkout" ] ||
      say "Replaced $link, which ran the source build in $checkout: CLAWDTIME_REPLACE_SOURCE=1. To go back: cd $checkout && npm link"
  fi
  if [ "$points_to" != "$launcher" ]; then
    ln -s "$launcher" "$user_prefix/bin/.clawdtime.$$"
    mv -fh "$user_prefix/bin/.clawdtime.$$" "$link"
  fi
  found=$(command -v clawdtime 2>/dev/null || true)
  case ":$PATH:" in
    *":$user_prefix/bin:"*)
      if [ -n "$found" ] && [ "$found" != "$link" ]; then
        say "Note: $found comes before $link on your PATH, and it runs another copy. Remove it to use this release."
      fi
      ;;
    *) need_path ;;
  esac
  say "Ready: $link runs ClawdTime $version."
}

release_next_steps() {
  say ""
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    if [ "$downgrade" = 1 ]; then
      say "ClawdTime is back on $version from $previous. Your settings, keys and pairing are kept."
    else
      say "ClawdTime is updated from $previous to $version. Your settings, keys and pairing are kept."
    fi
    pid=$(running_from "$previous")
    if [ -n "$pid" ]; then
      say "ClawdTime $previous still runs (process $pid). It goes on until it stops. Then $command_name start starts $version."
    fi
  else
    say "ClawdTime $version is installed."
  fi
  if [ -n "$path_line" ]; then
    say ""
    say "First put the command on your PATH, now and in new terminals:"
    say "  $path_line"
  fi
  say ""
  if [ "${CLAWDTIME_NO_ONBOARD:-0}" != 1 ] && "$launcher" onboard --help </dev/null >/dev/null 2>&1; then
    if (exec </dev/tty) 2>/dev/null; then
      step "Guided setup (clawdtime onboard)"
      "$launcher" onboard </dev/tty || {
        say ""
        say "Setup stopped before the end. To go on, run: $command_name onboard"
      }
    else
      say "Run $command_name onboard in Terminal to finish setup."
    fi
    return
  fi
  panel=$runtimes/$version/app/native/ClawdTimeTaskPanel
  say "Three steps need you. Run them in a terminal:"
  say "  1. Add a model key: $command_name keys set openai"
  say "     It reads the key from a hidden prompt. Other providers: $command_name keys help"
  say "  2. Give the panel two permissions in System Settings, Privacy & Security:"
  say "     Accessibility, and Screen & System Audio Recording. In each list, press +"
  say "     and choose $panel"
  say "     (press Command+Shift+G to type the path)."
  say "  3. Start it: $command_name start"
  say "The mascot appears. Click it to open the chat."
  say ""
  say "Check it: $command_name computer doctor"
}

release_main() {
  base=${CLAWDTIME_RELEASE_BASE:-$release_base}
  base=${base%/}
  base_kind=$(url_kind "$base") ||
    fail "CLAWDTIME_RELEASE_BASE must be an https URL with no user name or password, such as https://downloads.example/clawdtime. A local test may use http://127.0.0.1:PORT or file:///PATH."
  # curl takes this kind alone, also for each redirect.
  protocols="=$base_kind"
  check_mac
  runtimes="$HOME/Library/Application Support/ClawdTime/runtime"
  mkdir -p "$runtimes"
  # The path that ps shows, with every link of the home folder followed.
  physical=$(cd "$runtimes" && pwd -P)
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/clawdtime-install.XXXXXX")
  incoming="" lock=""
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  read_latest
  take_lock
  check_order
  install_runtime
  switch_current
  link_release
  release_next_steps
}

main() {
  from_source=${CLAWDTIME_FROM_SOURCE:-0}
  for argument in "$@"; do
    case $argument in
      --source) from_source=1 ;;
      -h | --help)
        # The comment at the top of this file. Under "curl | sh" there is no file.
        case $0 in
          *install.sh) sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' ;;
          *) say "See https://github.com/cherthq/clawdtime/blob/main/INSTALL.md" ;;
        esac
        return
        ;;
      *) fail "unknown option $argument. Use --source to build from the source." ;;
    esac
  done
  if [ "$from_source" = 1 ]; then source_main; else release_main; fi
}

# The whole file is read before anything runs, also under "curl | sh".
main "$@"
