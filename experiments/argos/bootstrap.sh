#!/bin/sh
# Fetch only the audited public source. No fork, push, keys, or live services.
set -eu
LAB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REV=7ee7310da8c902f3770861b27bdaf0941b301589
if [ -e "$LAB_DIR/source" ]; then
  test "$(git -C "$LAB_DIR/source" rev-parse HEAD)" = "$REV"
  test -z "$(git -C "$LAB_DIR/source" status --porcelain --untracked-files=normal)"
else
  git clone --no-checkout https://github.com/US3R070/HackUTA_Argos.git "$LAB_DIR/source"
  git -C "$LAB_DIR/source" checkout --detach "$REV"
fi
python3.12 -m venv "$LAB_DIR/.venv"
"$LAB_DIR/.venv/bin/python" -m pip install -r "$LAB_DIR/requirements-live.lock.txt"
