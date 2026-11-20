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

# The agent name, as node reads it from .env.local: the last AGENT_NAME line, without quotes.
AGENT_NAME=$(sed -n 's/^[[:space:]]*AGENT_NAME[[:space:]]*=[[:space:]]*//p' .env.local | tail -n 1 | tr -d "\"'" | sed 's/[[:space:]]*$//')
AGENT_NAME=${AGENT_NAME:-clawdtime}

echo "The agent starts now. Next, in a second terminal:"
echo "  chert dev --agent \"$AGENT_NAME\""
exec node --env-file=.env.local agent.mjs start
