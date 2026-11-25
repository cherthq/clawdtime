# How ClawdTime uses its Chert line

Read against this repository and `chert 0.1.0-beta.23`, 26 November 2026. The
full path by hand, and a prompt that lets a coding agent do it, is in
`SETUP_CLAWDTIME.md`. Follow that file. This page says what each part does.

| Way                  | What happens                                             | Where                                       |
| -------------------- | -------------------------------------------------------- | ------------------------------------------- |
| You call the line    | The line agent answers and talks to the supervisor       | `line/`, `./host.sh start`                  |
| You text the line    | ClawdTime answers each text, and texts each job's answer | `clawdtime texts run`                       |
| The worker needs you | The reach calls you once, or texts when the call fails   | The desktop service, `docs/COMPUTER_USE.md` |
| A routine runs       | It texts you the result                                  | `clawdtime routine add ...`                 |
| An agent waits, away | Away mode calls you about the request                    | `clawdtime agents away on`                  |

## Connect ClawdTime to Chert

There is no single connect command for the line. `clawdtime connect` exists,
but it pairs a coding agent (`--agent codex|claude-code`) with a ClawdTime
backend from a private pairing file. It does not get or connect a Chert line.

The line path, in short (details in `SETUP_CLAWDTIME.md`):

```sh
chert whoami                      # signed in? else: chert login (or chert, when new)
cd line && npm install
cp .env.example .env.local && chmod 600 .env.local
# the person puts the three LiveKit values and OPENAI_API_KEY into .env.local
chert doctor --agent clawdtime    # each failed check says what to fix
./host.sh start                   # the agent and chert dev, in tmux
./host.sh status                  # what runs, and the last records
```

With several projects, put the id of the one to use in `line/.env.local` as
`CLAWDTIME_LINE_CHERT_PROJECT`. `./host.sh` passes it to `chert dev`.

## The line agent in `line/`

The line agent is the small LiveKit agent that answers a call. It speaks with
a realtime voice model. Every fact and every action comes from the `clawdtime`
command on this Mac. Its video is the ClawdTime stone until the caller asks to
see the screen.

It keeps the rules of a Chert line:

- It joins the room at once, and opens the model session only when a caller is
  there.
- It publishes one audio track and one camera track, both from itself.
- It greets once, on the signal that FaceTime is ready, within 10 seconds of
  it. The first signal is the line's own audio track (`facetime-remote-audio`)
  in the room. The second is the ready mark of `chert dev`, about two seconds
  later. `CLAWDTIME_LINE_GREET_ON=mark` waits for the mark alone.
- It does not listen while it speaks: on a phone line its own voice comes back.
  `CLAWDTIME_LINE_BARGE_IN=on` lets the caller cut in, for a line that brings
  no voice back.

`./host.sh`:

| Command                | What it does                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `./host.sh start`      | Runs the agent and `chert dev` in the tmux session `clawdtime-line`   |
| `./host.sh stop`       | Frees the line (Ctrl+C to `chert dev`, never a kill), stops the agent |
| `./host.sh status`     | What runs, and the last records                                       |
| `./host.sh update`     | Takes the newest `main`, only when it changed and no call runs        |
| `./host.sh schedule`   | Runs `update` every 15 minutes, as one line in your crontab           |
| `./host.sh unschedule` | Removes that line                                                     |

- The records of `chert dev` go to `~/.local/share/clawdtime/line/dev.jsonl`.
  They show the number of the line and say `agent_warm` when the agent is in a
  waiting room. `host.log` and `update.log` are in the same folder.
- Both programs start again by themselves when they end, ten seconds later.
- Never pass `--takeover` or `--force` to `chert dev`. Stop only with
  `./host.sh stop`.
- After a restart of the Mac, run `./host.sh start` again from a terminal, so
  that the screen share keeps its permission.
- With no tmux: `./start.sh` in one terminal and
  `chert dev --agent clawdtime --env-file .env.local` in another.
- When Chert's hosted agent is on (`chert agent on`), it waits while
  `chert dev` holds the line, and answers again once the line agent stops.
  Check with `chert agent status`.
- `agent_warm` proves the connection, not computer actions. Before a call that
  must act on the Mac, run `clawdtime computer doctor --json` with the same
  environment as the line.

## Texts

```sh
export CHERT_API_KEY=...            # the project API key, read and write
export CHERT_PROJECT_ID=...         # chert whoami --json: project_id
export CLAWDTIME_OWNER_PHONE=...    # your own number, with the country code
export OPENAI_API_KEY=...
clawdtime texts check               # reads once, sends nothing
clawdtime texts run                 # answers until Ctrl+C
```

- `CHERT_LINE_ID` names the line to listen on. Without it, ClawdTime uses the
  line of your own newest text.
- One `clawdtime texts run` answers the texts on a Mac. A second one does not
  start.
- When the desktop service runs on this Mac, a text goes to it first, as the
  words of a call do. So a text can answer a question of the computer worker.
- The owner check and the reply window are in [imessage.md](imessage.md).

## The reach: ClawdTime calls or texts you

When the computer worker asks a yes, a sign-in, a code or a choice, and nobody
answers in the chat for 45 seconds, the reach calls you once on the line and
says the question. A request that came from a call, a text or a routine does
not wait. When the call fails, is not answered, is not dialed within a minute,
or the line is not set up for calls, it texts you once. Your reply goes to the
worker as an answer in the chat does.

- It never asks for a password, a code, or a card, bank or identity number, by
  voice or by text. You enter those on the Mac yourself.
- One call and one text at most for one question, also after a restart.
- It calls when the line is set up for proactive calls: an outbound line in
  `proactive.json` of the desktop service, and one active calling policy of the
  project with the `decision` trigger and the `phone_alert` channel.
- It texts when the text settings above, with `CHERT_LINE_ID` or a first text
  from you, are in the environment of the desktop service.
- `CLAWDTIME_COMPUTER_REACH_SECONDS` (0 to 600) sets the wait.
  `CLAWDTIME_COMPUTER_REACH=off` turns the reach off.
- `clawdtime computer doctor` says whether a call and a text can reach you,
  and why not.

Details: "When you are not at the chat" in `docs/COMPUTER_USE.md`.

## Routines

```sh
clawdtime routine add every morning at 9, check my open pull requests
clawdtime routine list
```

At its time, a routine hands its request to the worker. When the request ends,
the routine texts you the result. When the request needs you on its way, the
reach calls or texts at once. With no text settings, the result goes to the
chat. See "Routines" in `docs/COMPUTER_USE.md`.

## Away mode

Away mode turns a request that an agent waits on into a FaceTime call through
a paired ClawdTime backend and its Chert line. You answer "approve" or "deny"
on the call. It needs that pairing first (`clawdtime setup`, then
`clawdtime agents call connect`). `clawdtime agents call check` says whether a
phone would ring, and places no call. See "Away: answer by phone" in
`docs/SUPERVISOR.md`.

## Who can make your Mac do things

- Anyone who can call or text your line from a joined phone talks to ClawdTime.
  Keep the phone list of your project to your own phone, and turn off joining
  by code.
- A job is a real coding session on your Mac. It can do what your coding agent
  may do. ClawdTime adds no permission and removes none.
- With computer use on, a caller can make ClawdTime click and type on your
  Mac. It asks before what cannot be taken back, and it never types a password.
