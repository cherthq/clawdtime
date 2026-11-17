#!/bin/sh
set -eu
LAB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec env -i PATH=/usr/bin:/bin:/opt/homebrew/bin PYTHON_DOTENV_DISABLED=1 ESCALATION_MODE=mock "$LAB_DIR/.venv/bin/python" "$LAB_DIR/local_demo.py" "$@"
