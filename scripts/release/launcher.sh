#!/bin/sh
# The clawdtime command of a release runtime. The runtime builder copies this
# file to runtime/bin/clawdtime. It runs the runtime's own Node on the compiled
# command, so the Mac needs no Node, npm, Git or Xcode.
#
# It finds its runtime through any chain of links, such as
# ~/.local/bin/clawdtime -> .../runtime/current/bin/clawdtime, and works in
# folders with spaces, such as ~/Library/Application Support.
set -eu

self=$0
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=$(dirname "$self")/$target ;;
  esac
done
# -P resolves "current" to the version folder, so a running command keeps its
# own files when an update switches "current" to a newer version.
runtime=$(cd "$(dirname "$self")/.." && pwd -P)

# Options of a Node of the person's own must not change this runtime.
unset NODE_OPTIONS NODE_PATH
exec "$runtime/node/bin/node" "$runtime/app/dist/cli/main.js" "$@"
