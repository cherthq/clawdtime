#!/bin/sh
# Hosts ClawdTime on a FaceTime line in a tmux session, so it keeps running after the terminal closes.
#   ./host.sh start       start the agent and connect it to the line
#   ./host.sh stop        free the line (Ctrl+C to chert dev, never a kill), then stop the agent
#   ./host.sh restart     stop, then start
#   ./host.sh status      what runs, and the last records
#   ./host.sh update      take the newest main: rebuild and restart only when it changed and no call runs
#   ./host.sh schedule    run "update" every 15 minutes (a line in your crontab)
#   ./host.sh unschedule  remove that line
# Settings come from .env.local in this folder (see .env.example). Nothing here holds a secret.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
STATE=${CLAWDTIME_LINE_STATE:-$HOME/.local/share/clawdtime/line}
SESSION=${CLAWDTIME_LINE_SESSION:-clawdtime-line}
MARK="# clawdtime-line update"
mkdir -p "$STATE"

# One value of .env.local, as node reads it: the last line of that name, without quotes.
setting() {
  [ -f "$DIR/.env.local" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$DIR/.env.local" | tail -n 1 | tr -d "\"'" | sed 's/[[:space:]]*$//'
}
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
running() { tmux has-session -t "$SESSION" 2>/dev/null; }

# True while a call runs: the newest call record of chert dev is not its end.
in_call() {
  [ -f "$STATE/dev.jsonl" ] || return 1
  last=$(tail -n 200 "$STATE/dev.jsonl" | grep -o '"code":"call_[a-z_]*"' | tail -n 1 || true)
  case "$last" in
    ''|'"code":"call_ended"'|'"code":"call_declined"') return 1 ;;
    *) return 0 ;;
  esac
}

start() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is not installed. Install it (brew install tmux), or use ./start.sh in two terminals." >&2; exit 1; }
  [ -f "$DIR/.env.local" ] || { echo "No .env.local in $DIR. Copy .env.example to .env.local and fill it in." >&2; exit 1; }
  [ -d "$DIR/node_modules" ] || { echo "No node_modules in $DIR. Run: npm install" >&2; exit 1; }
  if running; then echo "Already running. See: ./host.sh status"; return 0; fi
  agent=$(setting AGENT_NAME); agent=${agent:-clawdtime}
  project=$(setting CLAWDTIME_LINE_CHERT_PROJECT)
  # tee -i ignores Ctrl+C, so the last records of chert dev still reach the file.
  tmux new-session -d -s "$SESSION" -n agent "cd '$DIR' && node --env-file=.env.local agent.mjs start 2>&1 | tee -i -a '$STATE/agent.log'"
  sleep 3
  tmux new-window -t "$SESSION" -n dev "cd '$DIR' && chert dev --agent '$agent' --env-file .env.local ${project:+--project '$project'} --json 2>&1 | tee -i -a '$STATE/dev.jsonl'"
  echo "Started in the tmux session $SESSION. Records: $STATE/dev.jsonl"
}

stop() {
  running || { echo "Not running."; return 0; }
  tmux send-keys -t "$SESSION:dev" C-c 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    tail -n 5 "$STATE/dev.jsonl" 2>/dev/null | grep -q '"dev_stopped"' && break
    i=$((i + 1)); sleep 1
  done
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "Stopped."
}

status() {
  if running; then echo "Running in the tmux session $SESSION."; else echo "Not running."; fi
  in_call && echo "A call runs now." || echo "No call runs now."
  [ -f "$STATE/dev.jsonl" ] && tail -n 3 "$STATE/dev.jsonl" | grep -o '"code":"[a-z_]*"' | tr '\n' ' ' && echo
  crontab -l 2>/dev/null | grep -q "$MARK" && echo "Updates are scheduled." || echo "Updates are not scheduled."
}

# Takes the newest main. It changes nothing when the checkout is not a clean main, and it never restarts during a call.
update() {
  cd "$ROOT"
  branch=$(git rev-parse --abbrev-ref HEAD)
  [ "$branch" = main ] || { say "not on main ($branch): nothing done"; return 0; }
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { say "the checkout has changes of its own: nothing done"; return 0; }
  git fetch --quiet origin main || { say "the fetch failed: nothing done"; return 0; }
  old=$(git rev-parse HEAD); new=$(git rev-parse origin/main)
  [ "$old" != "$new" ] || { say "up to date at $(git rev-parse --short HEAD)"; return 0; }
  if in_call; then say "a call runs: the update waits"; return 0; fi
  git merge --quiet --ff-only origin/main || { say "main cannot be fast-forwarded: nothing done"; return 0; }
  say "main moved $(git rev-parse --short "$old") to $(git rev-parse --short "$new")"
  git diff --quiet "$old" "$new" -- package-lock.json || npm ci --silent
  npm run --silent build
  git diff --quiet "$old" "$new" -- line/package-lock.json line/package.json || (cd "$DIR" && npm install --silent)
  if running; then
    if in_call; then say "built; a call started meanwhile: restart with ./host.sh restart after it"; return 0; fi
    stop >/dev/null; start >/dev/null
    say "restarted on $(git rev-parse --short HEAD)"
  else
    say "built $(git rev-parse --short HEAD); not running, so nothing was restarted"
  fi
}

schedule() {
  command -v crontab >/dev/null 2>&1 || { echo "crontab is not available on this Mac." >&2; exit 1; }
  # cron starts with a short PATH: this line carries the PATH of this terminal, so node, npm, git, tmux and chert are found.
  line="*/15 * * * * PATH='$PATH' '$DIR/host.sh' update >> '$STATE/update.log' 2>&1 $MARK"
  # The other lines are read first, then the whole table is written once.
  kept=$(crontab -l 2>/dev/null | grep -v "$MARK" || true)
  { [ -z "$kept" ] || printf '%s\n' "$kept"; printf '%s\n' "$line"; } | crontab -
  echo "Scheduled: every 15 minutes. Its record: $STATE/update.log"
}

unschedule() {
  kept=$(crontab -l 2>/dev/null | grep -v "$MARK" || true)
  { [ -z "$kept" ] || printf '%s\n' "$kept"; } | crontab -
  echo "The schedule is removed."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  update) update ;;
  in-call) in_call && echo yes || echo no ;;
  schedule) schedule ;;
  unschedule) unschedule ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
