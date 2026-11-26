#!/bin/sh
# Starts ClawdTime on a FaceTime line. Settings come from .env.local in this folder (see .env.example).
# This terminal runs the agent. A second terminal connects it to the line with the command that is printed here.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env.local ]; then
  echo "No .env.local here. Copy .env.example to .env.local and fill it in." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "No node_modules here. Run: npm install" >&2
  exit 1
fi

# The agent name of .env.local, read by node itself as node --env-file reads it for the agent: quotes, inline comments
# and the last AGENT_NAME line. Only the file counts, not this environment.
AGENT_NAME=$(env -i PATH="$PATH" node --env-file=.env.local -e 'process.stdout.write(process.env.AGENT_NAME ?? "")' 2>/dev/null || true)
AGENT_NAME=${AGENT_NAME:-clawdtime}

echo "The agent starts now. Next, in a second terminal:"
echo "  chert dev --agent \"$AGENT_NAME\""
exec node --env-file=.env.local agent.mjs start
