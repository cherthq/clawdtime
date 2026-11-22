#!/bin/sh
# Hosts ClawdTime on a FaceTime line in a tmux session, so it keeps running after the terminal closes.
#   ./host.sh start       start the agent and connect it to the line
#   ./host.sh stop        free the line (Ctrl+C to chert dev, never a kill), then stop the agent
#   ./host.sh restart     stop, then start
#   ./host.sh status      what runs, and the last records
#   ./host.sh update      take the newest main: rebuild and restart only when it changed and no call runs
#   ./host.sh schedule    run "update" every 15 minutes (a line in your crontab)
#   ./host.sh unschedule  remove that line
# Both programs start again by themselves when they end, until ./host.sh stop: see "keep" below.
# Settings come from .env.local in this folder (see .env.example). Nothing here holds a secret.
set -eu
umask 077
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
STATE=${CLAWDTIME_LINE_STATE:-$HOME/.local/share/clawdtime/line}
SESSION=${CLAWDTIME_LINE_SESSION:-clawdtime-line}
ENV_FILE=${CLAWDTIME_LINE_ENV_FILE:-$DIR/.env.local}
RETENTION_CONFIG=${CLAWDTIME_LINE_RETENTION_CONFIG:-}
case "$ENV_FILE" in /*) ;; *) echo "Agent env file must be absolute." >&2; exit 1 ;; esac
MARK="# clawdtime-line update"
# How long a program that ended waits before it starts again.
PAUSE=${CLAWDTIME_LINE_RETRY_SECONDS:-10}
mkdir -p "$STATE"

# One value of .env.local, as node reads it: the last line of that name, without quotes.
setting() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d "\"'" | sed 's/[[:space:]]*$//'
}
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
# Agent code: explicit environment override, then env-file setting, then this folder.
# The host wrapper and retention preload always remain in DIR, including source rollback.
release() {
  code=${CLAWDTIME_LINE_RELEASE:-$(setting CLAWDTIME_LINE_RELEASE)}; code=${code:-$DIR}
  [ "${#code}" -le 4096 ] || { echo "Agent release path is too long." >&2; return 1; }
  case "$code" in /*) ;; *) echo "Agent release must be an absolute directory." >&2; return 1 ;; esac
  [ -f "$code/agent.mjs" ] && [ -d "$code/node_modules" ] || { echo "The selected agent release is incomplete." >&2; return 1; }
  printf '%s\n' "$code"
}
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

# keep agent | keep dev: runs one of the two programs again each time it ends, until ./host.sh stop, or Ctrl+C in
# its window. A host must outlive a network drop: after one, chert dev gives up and ends, and the agent's worker
# closes, and nothing else starts them again. Each new start is one line in host.log.
keep() {
  stopped=""
  trap 'stopped=1' INT
  while :; do
    case "$1" in
      agent)
        # A private installed release may pin the agent code while credentials remain here. Without one, the
        # agent is the file in this folder, as before.
        program=agent.mjs
        if [ -n "${CLAWDTIME_LINE_RELEASE:-$(setting CLAWDTIME_LINE_RELEASE)}" ]; then
          # A release that is not whole is not run, and the reason is one line in host.log.
          code=$(release) || { say "the agent release is not whole: the agent is not started" >> "$STATE/host.log"; break; }
          program="$code/agent.mjs"
        fi
        (cd "$DIR" && node --env-file="$ENV_FILE" "$program" start 2>&1 | tee -i -a "$STATE/agent.log") || true ;;
      dev)
        agent=$(setting AGENT_NAME); agent=${agent:-clawdtime}
        project=$(setting CLAWDTIME_LINE_CHERT_PROJECT)
        # tee -i ignores Ctrl+C, so the last records of chert dev still reach the file.
        if [ -n "$RETENTION_CONFIG" ]; then
          provider=$(cd "$DIR" && node --input-type=module -e 'import {readRetentionConfig,inspectPinnedProvider} from "./provider-retention.mjs";console.log(inspectPinnedProvider(readRetentionConfig(process.argv[1]).providerRoot).providerRoot)' "$RETENTION_CONFIG") || break
          (cd "$DIR" && CLAWDTIME_LINE_RETENTION_CONFIG="$RETENTION_CONFIG" node --import "$DIR/provider-retention-preload.mjs" "$provider/dist/src/cli/main.js" dev --agent "$agent" --env-file "$ENV_FILE" ${project:+--project "$project"} --json 2>&1 | tee -i -a "$STATE/dev.jsonl") || true
        else
          (cd "$DIR" && chert dev --agent "$agent" --env-file "$ENV_FILE" ${project:+--project "$project"} --json 2>&1 | tee -i -a "$STATE/dev.jsonl") || true
        fi ;;
      *) echo "Use: ./host.sh keep agent, or ./host.sh keep dev" >&2; exit 2 ;;
    esac
    if [ "$1" = dev ] && [ -n "$RETENTION_CONFIG" ]; then
      say "guarded dev exited; ownership must be reconciled before another claim" >> "$STATE/host.log"
      break
    fi
    [ -z "$stopped" ] && [ ! -f "$STATE/stopping" ] || break
    say "$1 ended; it starts again in $PAUSE s" >> "$STATE/host.log"
    sleep "$PAUSE"
    [ -z "$stopped" ] && [ ! -f "$STATE/stopping" ] || break
  done
}

# tmux may have been launched with an older environment; explicitly pass only these paths/settings.
shell_quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\"'\"'/g"; printf "'"; }
host_command() {
  printf 'env CLAWDTIME_LINE_ENV_FILE=%s CLAWDTIME_LINE_RETENTION_CONFIG=%s CLAWDTIME_LINE_STATE=%s CLAWDTIME_LINE_SESSION=%s CLAWDTIME_LINE_RELEASE=%s %s' "$(shell_quote "$ENV_FILE")" "$(shell_quote "$RETENTION_CONFIG")" "$(shell_quote "$STATE")" "$(shell_quote "$SESSION")" "$(shell_quote "${CLAWDTIME_LINE_RELEASE:-}")" "$(shell_quote "$DIR/host.sh")"
}
start() {
  command -v tmux >/dev/null 2>&1 || { echo "tmux is not installed. Install it (brew install tmux), or use ./start.sh in two terminals." >&2; exit 1; }
  [ -f "$ENV_FILE" ] || { echo "No .env.local in $DIR. Copy .env.example to .env.local and fill it in." >&2; exit 1; }
  [ -d "$DIR/node_modules" ] || { echo "No node_modules in $DIR. Run: npm install" >&2; exit 1; }
  if running; then echo "Already running. See: ./host.sh status"; return 0; fi
  if [ -e "$STATE/outbound-hold" ] || [ -L "$STATE/outbound-hold" ]; then
    echo "Outbound ownership is retained; reconcile its receipt before restoring incoming." >&2
    return 1
  fi
  # A private installed release may pin the agent code while credentials remain here.
  release >/dev/null || exit 1
  rm -f "$STATE/stopping"
  tmux new-session -d -s "$SESSION" -n agent "$(host_command) keep agent"
  sleep 3
  tmux new-window -t "$SESSION" -n dev "$(host_command) keep dev"
  echo "Started in the tmux session $SESSION. Records: $STATE/dev.jsonl"
}

stop() {
  running || { echo "Not running."; return 0; }
  # The mark comes first, so that a program that ends now is not started again.
  : > "$STATE/stopping"
  boundary=$(node "$DIR/host-receipts.mjs" boundary "$STATE/dev.jsonl") || {
    echo "Cannot establish a fresh release boundary; host was not stopped." >&2
    return 1
  }
  tmux send-keys -t "$SESSION:dev" C-c 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    node "$DIR/host-receipts.mjs" released "$STATE/dev.jsonl" "$boundary" && break
    i=$((i + 1)); sleep 1
  done
  if ! node "$DIR/host-receipts.mjs" released "$STATE/dev.jsonl" "$boundary"; then
    echo "Release or cleanup remains unknown; session and receipts retained. No replacement owner may start." >&2
    return 1
  fi
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "Stopped."
}

status() {
  if running; then echo "Running in the tmux session $SESSION."; else echo "Not running."; fi
  in_call && echo "A call runs now." || echo "No call runs now."
  [ -f "$STATE/dev.jsonl" ] && tail -n 3 "$STATE/dev.jsonl" | grep -o '"code":"[a-z_]*"' | tr '\n' ' ' && echo
  [ -f "$STATE/host.log" ] && echo "Last start by itself: $(tail -n 1 "$STATE/host.log")"
  crontab -l 2>/dev/null | grep -q "$MARK" && echo "Updates are scheduled." || echo "Updates are not scheduled."
}

# Takes the newest main. It changes nothing when the checkout is not a clean main, and it never restarts during a call.
update() {
  # A locally qualified release must not be replaced by scheduled source updates.
  # Presence alone is fail-closed, including an unreadable file or a dangling link.
  if [ -e "$STATE/update-hold" ] || [ -L "$STATE/update-hold" ]; then
    say "local release hold is active: nothing done"
    return 0
  fi
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
  keep) keep "${2:-}" ;;
  schedule) schedule ;;
  unschedule) unschedule ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
