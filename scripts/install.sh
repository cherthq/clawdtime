#!/bin/sh
# Installs ClawdTime on this Mac, or updates it. It is safe to run again.
#
#   curl -fsSL https://raw.githubusercontent.com/cherthq/clawdtime/main/scripts/install.sh | sh
#   sh scripts/install.sh
#
# Settings, all optional:
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

main() {
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

# The whole file is read before anything runs, also under "curl | sh".
main "$@"
