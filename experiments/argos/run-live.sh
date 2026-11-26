#!/bin/sh
set -eu
LAB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec env -i HOME="$HOME" PATH=/usr/bin:/bin:/opt/homebrew/bin PYTHON_DOTENV_DISABLED=1 \
  "$LAB_DIR/.venv/bin/python" "$LAB_DIR/live-call.py" "$@"
