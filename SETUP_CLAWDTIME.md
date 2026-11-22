# Set up ClawdTime on a FaceTime line

You call a FaceTime number. ClawdTime answers on your Mac. You see its mascot on
the video, and you talk to it:

- "What is every agent doing?" It says what each coding session does and what
  waits for you.
- "Show me the session that works on the login page." It shares the screen and
  brings that session's terminal to the front.
- "Make that window bigger." It fills the screen with that terminal, or makes
  its text bigger.
- "Build a landing page for the demo and give me the link." It starts a new
  coding session for the job and says the answer when the session is done.
- "Approve it." It answers a request that an agent waits on.

You can also text the same number and get the answers as text messages.

This page takes you from nothing to the first call. Each step is one you do
yourself.

## Let your coding agent set it up

Paste this into Codex or Claude Code on the Mac. It works through this page for
you, hosts ClawdTime, and keeps it on the newest `main`.

```text
Set up ClawdTime on a FaceTime line on this Mac, host it, and keep it up to date. Do every step yourself. Ask me only where a step says "ask me".

Source: https://github.com/cherthq/clawdtime, branch main. Read SETUP_CLAWDTIME.md and AGENTS.md there first. If this prompt and SETUP_CLAWDTIME.md disagree, the file wins.

1. Check the Mac: node --version (22.12 or later, 24 or 26), ffmpeg -version, tmux -V, chert --version, and claude --version or codex --version. Install what is missing (brew install ffmpeg tmux; npm install -g @trychert/facetime@beta) and tell me what you installed.
2. Get the newest main in ~/clawdtime. If that folder is a clean checkout of main, run git pull --ff-only there. If it does not exist, clone the repository there. Do not put it inside Documents, Desktop or Downloads: the scheduled update cannot read those folders. Never touch another checkout, its branch or its uncommitted work. Run npm ci and npm run build. If no clawdtime command exists (command -v clawdtime), run npm link. If one exists and points to another folder, ask me before you replace it. Prove it: "clawdtime agents" must list the coding sessions on this Mac.
3. The line: run chert whoami. If this Mac is not signed in, run chert login --device --json, show me the address and the code, and wait. Never approve the sign-in yourself. If I belong to several projects, ask me which one, and put its id in line/.env.local as CLAWDTIME_LINE_CHERT_PROJECT.
4. The line agent: in line/, run npm install. If line/.env.local does not exist, run cp .env.example .env.local and chmod 600 .env.local. Ask me to put the three LiveKit values and the OpenAI key into line/.env.local myself. Never ask for a key in this chat. Never print, log or commit that file.
5. Check: in line/, run chert doctor --agent clawdtime. Fix what you can. Tell me each failed check that only I can fix, in its own words.
6. Host it: in line/, run ./host.sh start. It runs the agent and chert dev in a tmux session named clawdtime-line. Read the records file that it names until agent_warm. Never pass --takeover or --force. Stop it only with ./host.sh stop.
7. Keep it up to date: in line/, run ./host.sh schedule, then ./host.sh update once, and show me its line. Every 15 minutes the schedule takes the newest main, builds it and restarts the agent. It acts only when main changed, the checkout is a clean main, and no call runs.
8. Tell me the number that chert dev shows in its records. Tell me that my phone must be joined to that line before I call, and how (SETUP_CLAWDTIME.md, step 1).
9. Wait for my FaceTime Video call. Then report from the records: call_incoming, call_accepted, call_media, call_ended. Say plainly what you did not verify.

Rules: this setup needs no ClawdTime backend, no deploy and no line handoff; do none of them. Do not change the repository's code. Do not set up text messages unless I ask. macOS asks for Screen Recording and Automation for the terminal app: tell me when it does. After a restart of the Mac, ./host.sh start must run again from a terminal. End with a short report: what runs, where its logs are, how to stop it (./host.sh stop) and how to remove the schedule (./host.sh unschedule).
```

The rest of this page is the same path by hand.

## What you need

| Thing                               | Check                                       |
| ----------------------------------- | ------------------------------------------- |
| A Mac that stays awake              | The agents and ClawdTime run on it          |
| Node 22.12 or later, 24 or 26       | `node --version`                            |
| `tmux`, to keep it running          | `tmux -V` (`brew install tmux`)             |
| `ffmpeg`, to share the screen       | `ffmpeg -version` (`brew install ffmpeg`)   |
| A coding agent that is signed in    | `claude --version` or `codex --version`     |
| An OpenAI API key with realtime use | It speaks on the call and chooses the tools |
| A LiveKit Cloud project             | Three values from its Settings, API keys    |
| The Chert command                   | `npm install -g @trychert/facetime@beta`    |
| An iPhone, or a Mac with FaceTime   | To place the call                           |

## 1. Get a line

A line is the phone number that you call. One line answers one call at a time.

**You are new to Chert.** Run `chert` and follow it. It opens the browser, you
make an account, and you send a 6-digit code from your iPhone by iMessage. That
joins your phone to a line. The free trial gives 50 FaceTime minutes, 5 minutes
for each call.

**You already have a project with lines.** Sign this Mac in and choose the
project:

```sh
chert login          # approve this Mac in the browser; choose the project
chert whoami         # the project that this Mac is signed in to
```

When you belong to several projects, name the one to use in step 4 with
`--project UUID`. The line of that project is the number that you call. Your
own phone must be joined to that line, or the call is declined.

## 2. Install ClawdTime

```sh
git clone https://github.com/cherthq/clawdtime.git
cd clawdtime
npm ci
npm run build
npm link             # puts the clawdtime command on your PATH
clawdtime agents     # the coding sessions on this Mac
```

Start one coding session in another terminal, so the list is not empty.

To let ClawdTime answer an agent's permission request for you, add its hooks
once: `clawdtime agents hooks install --agent claude-code` (and `--agent codex`).
See [the supervisor guide](docs/SUPERVISOR.md).

## 3. Set up the line agent

The line agent is the small program that answers the call. It is in `line/`.

```sh
cd line
npm install
cp .env.example .env.local && chmod 600 .env.local
```

Open `.env.local` and replace each `YOUR_` value:

| Value                | Where it comes from                            |
| -------------------- | ---------------------------------------------- |
| `LIVEKIT_URL`        | Your LiveKit Cloud project, Settings, API keys |
| `LIVEKIT_API_KEY`    | The same page                                  |
| `LIVEKIT_API_SECRET` | The same page                                  |
| `OPENAI_API_KEY`     | Your OpenAI account                            |
| `AGENT_NAME`         | Keep `clawdtime`, or a name that only you use  |

The other values in `.env.example` are optional. `CLAWDTIME_LINE_PROJECT` is
the folder that new coding sessions work in. `CLAWDTIME_LINE_MASCOT` picks the
stone on the video: `jet` (the default), `jade`, `lapis`, `amber`, `garnet` or
`amethyst`.

Never commit `.env.local`, and never paste its values into a chat.

## 4. Start it

In `line/`:

```sh
chert doctor --agent clawdtime     # each failed check says what to fix
./host.sh start                    # the agent and chert dev, in a tmux session
./host.sh status                   # what runs, and the last records
```

`host.sh start` keeps both programs running after you close the terminal. The
records of `chert dev` go to `~/.local/share/clawdtime/line/dev.jsonl`: they
show the number of your line and say `agent_warm` when the agent is in a
waiting room. `./host.sh stop` frees the line and stops the agent.

Both programs start again by themselves when they end. After a network drop
`chert dev` gives up and the agent's worker closes; ten seconds later each
starts again, and goes on until the network is back. Each such start is a line
in `~/.local/share/clawdtime/line/host.log`, and `./host.sh status` shows the
newest one.

When you belong to several projects, put the id of the one to use in
`.env.local` as `CLAWDTIME_LINE_CHERT_PROJECT`.

With no tmux, use two terminals: `./start.sh` in the first, and
`chert dev --agent clawdtime --env-file .env.local` in the second. Press Ctrl+C
in the second when you are done: that frees the line.

### Keep it on the newest main

```sh
./host.sh schedule      # every 15 minutes: take the newest main when it changed
./host.sh update        # the same, once, now
./host.sh unschedule    # stop that
```

An update pulls `main`, builds it, installs only when a lock file changed, and
restarts the agent. It does nothing when the checkout is not a clean `main`,
and it never restarts during a call. Its record is
`~/.local/share/clawdtime/line/update.log`. The schedule is one line in your
crontab. Keep the checkout outside Documents, Desktop and Downloads: a scheduled
job cannot read those folders. After a restart of the Mac, run
`./host.sh start` again from a terminal, so the screen share keeps its
permission.

## 5. Call it

Place a **FaceTime Video** call to the number that `chert dev` shows. ClawdTime
greets you when FaceTime is ready. Things to say:

| You say                                             | What happens                                               |
| --------------------------------------------------- | ---------------------------------------------------------- |
| "Give me the status."                               | What works, what is idle, what waits for you               |
| "Show me the screen."                               | The Mac's screen is the video, with the mascot in a corner |
| "Go to the session about the payment tests."        | That session's terminal comes to the front                 |
| "Make its text bigger." "Fill the screen with it."  | The window of that session changes                         |
| "Open a tunnel for port 3000 and give me the link." | A new coding session does it. ClawdTime says the answer    |
| "What did it find?"                                 | The answer of the newest job                               |
| "Approve it." "Deny it."                            | The request that an agent waits on is answered             |
| "Zoom in on the terminal that runs the tests."      | The video shows only that window                           |
| "Show the whole screen."                            | The video shows the whole screen again                     |
| "The sides of the picture are cut."                 | Everything is drawn in the middle of the picture           |
| "Hide the screen."                                  | The video is the mascot again                              |

How the call looks:

- What the caller sees is the Video framing of your line, on the line's page
  in the Chert dashboard. It is fixed for a call. Fit, the default, shows the
  whole picture. Fill turns the video upright and shows only the middle of the
  picture, so that it fills a phone held upright.
- With Fill, put `CLAWDTIME_LINE_FRAMING=fill` in `.env.local`. The mascot,
  and a shared screen, are then drawn in that middle strip: nothing is cut. A
  shared screen shows whole, and small.
- "Zoom in on the session that builds the page" shows only that one window on
  the video. "Show the whole screen" goes back.
- Automatic zoom follows native agent clicks and focused typing without changing
  input coordinates. Say "disable automatic zoom" to turn it off. "Show the
  whole screen" persists until "resume automatic zoom", including later calls.
  See [automatic call-video zoom](docs/AUTOMATIC_CALL_ZOOM.md) for local controls,
  capture-device configuration, manual-view precedence and acceptance limits.
- With Fit, the picture uses its whole width. If your phone cuts its sides,
  say so: everything is then drawn in the middle. "Make it wide again" goes
  back.
- Hang up and call back: ClawdTime knows what you said in the last day, and
  goes on from there.

How the call sounds:

- FaceTime needs some seconds to connect after you call. ClawdTime greets you
  as soon as the line says that FaceTime is ready, not before. It takes that
  from the line's own audio track in the room, which is there about two
  seconds before the ready mark. `CLAWDTIME_LINE_GREET_ON=mark` waits for the
  mark alone.
- While the agent waits for a call it sends nothing: its picture is ready, and
  goes out as the first thing of a call.
- After you asked for the middle picture, the wide one comes back only as an
  answer to something that you said ("make it wide"). The voice model cannot
  turn it on by itself, as in a greeting or the news of a job.
- ClawdTime does not listen while it speaks, nor for half a second after. On a
  phone line its own voice comes back, and it would stop itself or answer
  itself. Its answers are short: wait for the end of the sentence, then speak.
  For a line that brings no voice back, `CLAWDTIME_LINE_BARGE_IN=on` in
  `.env.local` lets you cut in.

## 6. Text it (optional)

The same number takes text messages. ClawdTime reads your texts every few
seconds, answers each one, and texts you the answer of every job that finishes.
A link that a job made arrives as text, so you can open it on your phone.

1. Make a project API key with read and write access on the developer page of
   your Chert project: https://app.trychert.com/developer. The key is shown
   once. `chert whoami --json` prints the project id as `project_id`.
2. On the messages page of your project, https://app.trychert.com/imessage,
   turn off joining by code, so no other phone can join your line.
3. Start the channel with the three values in its environment. Keep the key out
   of files that you share and out of your shell history:

```sh
export CHERT_API_KEY=...            # the project API key
export CHERT_PROJECT_ID=...         # the project id
export CLAWDTIME_OWNER_PHONE=...    # your own number, with the country code
export OPENAI_API_KEY=...
clawdtime texts check               # reads once, sends nothing
clawdtime texts run                 # answers until you press Ctrl+C
```

Run it in the folder that new coding sessions must work in.

What to know:

- A text counts when it comes from a phone that is joined to your project and
  whose number ends with the last four digits of `CLAWDTIME_OWNER_PHONE`.
  Answers go only to that number. The service gives no more of a sender than
  those four digits, so the phone list of your project is the real guard: keep
  it to your own phone.
- For a second check that ClawdTime holds itself, set `CLAWDTIME_TEXT_WORD` to
  a private word of four letters or more. A text then counts only when it
  starts with that word, and a text without it gets no answer.
- One `clawdtime texts run` answers the texts on a Mac. A second one does not
  start.
- One text gets one answer, also after a restart. A text that is more than ten
  minutes old when ClawdTime first sees it is not run.
- On the free trial, ClawdTime can text you only within 24 hours of your last
  text. A paid Shared plan has no such window.
- On a trial or Shared line, the first text after a quiet day can also get a
  second answer from the line's demo agent.

## 7. Let it work in apps (optional)

ClawdTime can work on the Mac itself: go to an app, move to another desktop,
click, type, and read what is on the screen. This is computer use. It is off
until you turn it on.

```sh
clawdtime computer on        # the switch. Then start the desktop service again
clawdtime computer doctor    # what is ready and what is missing
clawdtime computer status    # on or off, and the last request
clawdtime computer off       # off again. A request that runs stops
```

It needs three things, and `clawdtime computer doctor` names the one that is
missing:

- A key for the language model in the environment of the desktop service:
  `CLAWDTIME_OPENAI_API_KEY` or `OPENAI_API_KEY`.
- The ClawdTime panel, open. The panel looks at the screen and sends the input.
- Accessibility, and Screen & System Audio Recording, for the panel, in System
  Settings, Privacy & Security.

Things to say, on a call or with `clawdtime chat`:

| You say                                                    | What happens                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| "Go to Chrome."                                            | That app comes to the front                                    |
| "Take me back to the app before."                          | The app that was in front before comes back                    |
| "Move one desktop to the right."                           | The next desktop                                               |
| "Open TextEdit, make a new document and type hello in it." | It does each step, one at a time                               |
| "What is on the screen?"                                   | It looks and tells you. It sends no input                      |
| "Quit TextEdit."                                           | It asks first. Say yes or no                                   |
| "Stop."                                                    | It stops. A bar with Stop is also on the screen while it works |

How it works:

- One checked action at a time. Each click, key and text is checked in code
  before it goes out, and against a new look at the screen just before.
- It asks before what cannot be taken back: a send, a delete, a close, a quit,
  a form that it submits. It never types in a password field: you type there,
  then say yes.
- When you use the mouse or the keyboard, it pauses before its next input and
  asks "continue or stop". A request that only looks is not paused.
- After a request whose result nobody knows (the panel closed in the middle),
  it takes no new request until you looked at the screen and ran
  `clawdtime computer clear`.

To move between desktops, macOS must have the two shortcuts, and the panel must
know them. In System Settings, Keyboard, Keyboard Shortcuts, Mission Control,
turn on "Move left a space" and "Move right a space". Then give the same two
combinations to the panel in its environment, for example, only when these are
your settings:

```sh
CLAWDTIME_SPACE_LEFT_SHORTCUT=ctrl+left
CLAWDTIME_SPACE_RIGHT_SHORTCUT=ctrl+right
```

Web pages. Without more, ClawdTime works a web page by what it sees on the
screen. With `CLAWDTIME_COMPUTER_BROWSER=on` in the environment of the desktop
service it reads the page itself and clicks and types by element, in your own
browser with your sign-ins. That needs View > Developer > Allow JavaScript from
Apple Events in Chrome, Brave, Edge or Chromium (in Safari: Settings > Advanced, "Show features for web developers", then Settings > Developer), and the Automation right of macOS when it asks. It is off by
default. `clawdtime computer doctor`, run with the same variable, says whether
the browser can be driven.

More: [computer use](docs/COMPUTER_USE.md) and
[desktops and apps](docs/DESKTOP_SPACES.md).

## Permissions that macOS asks for

| When                                   | macOS asks                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------- |
| The first "show me the screen"         | Screen Recording, for the terminal that ran `start.sh`                      |
| The first time a session comes forward | Automation, to control Terminal or your terminal app                        |
| Computer use, at its first request     | Accessibility, and Screen & System Audio Recording, for the ClawdTime panel |

Grant them in System Settings, Privacy & Security, then start the agent again.

## Who can make your Mac do things

Say it plainly to yourself before you start:

- Anyone who can call or text your line from a joined phone talks to ClawdTime.
  Keep the phone list of your project to your own phone.
- A job is a real coding session on your Mac. It can do what your coding agent
  is allowed to do. ClawdTime adds no permission and removes none.
- ClawdTime starts a job only from your own sentence, never from text that a
  web page, a session or a job answer holds.
- With computer use on, a caller can make ClawdTime click and type on your
  Mac. It asks before what cannot be taken back, and it never types a password.

## When something fails

| What you see                                                   | What to do                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The call is declined                                           | Join your phone to the line first (step 1). Call with FaceTime                      |
| The call ends after ten seconds                                | The agent said nothing: look in terminal 1 for a model key or credit error          |
| ClawdTime stops in the middle of a sentence, or answers itself | Take the newest `main` (`./host.sh update`), and keep `CLAWDTIME_LINE_BARGE_IN` off |
| The greeting never comes                                       | The same update: sound at pickup no longer cancels the greeting                     |
| No video                                                       | Call with FaceTime Video, not Audio                                                 |
| "ClawdTime did not answer on this Mac"                         | `clawdtime agents` must work in a terminal. Run `npm link` again                    |
| The screen video is black                                      | Grant Screen Recording to your terminal app, then restart the agent                 |
| The wrong screen is shown                                      | Set `CLAWDTIME_LINE_SCREEN_DEVICE` (see `.env.example`)                             |
| `line_in_use` from `chert dev`                                 | Another session holds the line. Stop it there, or wait                              |
| A job starts but no answer comes                               | Look at its terminal window. `clawdtime jobs` lists every job                       |
| `clawdtime texts check` is refused                             | Make a new key with read and write access. Check the project id                     |
| "Computer use is off"                                          | `clawdtime computer on`, then start the desktop service again                       |
| "You moved the mouse or pressed a key, so I paused"            | Say "continue" or "stop". It asks before it sends input while you use the Mac       |
| A desktop switch is refused                                    | Turn on the two Mission Control shortcuts and give them to the panel (step 7)       |

More: [the supervisor guide](docs/SUPERVISOR.md), [the agent board](docs/AGENT_BOARD.md),
and `chert guide` for the line itself.
