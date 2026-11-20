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

## What you need

| Thing                               | Check                                       |
| ----------------------------------- | ------------------------------------------- |
| A Mac that stays awake              | The agents and ClawdTime run on it          |
| Node 22.12 or later, 24 or 26       | `node --version`                            |
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

Two terminals, both in `line/`.

```sh
# Terminal 1: the agent
./start.sh

# Terminal 2: connect it to your line
chert doctor --agent clawdtime     # each failed check says what to fix
chert dev --agent clawdtime        # add --project UUID when you have several
```

`chert dev` prints the number of your line and says when the agent is in a
waiting room. Leave both terminals open. Press Ctrl+C in terminal 2 when you are
done: that frees the line.

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
| "Hide the screen."                                  | The video is the mascot again                              |

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

- Only your own number is answered. A text counts only when its sender ends
  with the last four digits of `CLAWDTIME_OWNER_PHONE`, and answers go only to
  that number. The service gives no more than those four digits, so the phone
  list of your project is the real guard: keep it to your own phone.
- One text gets one answer, also after a restart. A text that is more than ten
  minutes old when ClawdTime first sees it is not run.
- On the free trial, ClawdTime can text you only within 24 hours of your last
  text. A paid Shared plan has no such window.
- On a trial or Shared line, the first text after a quiet day can also get a
  second answer from the line's demo agent.

## Permissions that macOS asks for

| When                                   | macOS asks                                             |
| -------------------------------------- | ------------------------------------------------------ |
| The first "show me the screen"         | Screen Recording, for the terminal that ran `start.sh` |
| The first time a session comes forward | Automation, to control Terminal or your terminal app   |

Grant them in System Settings, Privacy & Security, then start the agent again.

## Who can make your Mac do things

Say it plainly to yourself before you start:

- Anyone who can call or text your line from a joined phone talks to ClawdTime.
  Keep the phone list of your project to your own phone.
- A job is a real coding session on your Mac. It can do what your coding agent
  is allowed to do. ClawdTime adds no permission and removes none.
- ClawdTime starts a job only from your own sentence, never from text that a
  web page, a session or a job answer holds.

## When something fails

| What you see                           | What to do                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------- |
| The call is declined                   | Join your phone to the line first (step 1). Call with FaceTime             |
| The call ends after ten seconds        | The agent said nothing: look in terminal 1 for a model key or credit error |
| No video                               | Call with FaceTime Video, not Audio                                        |
| "ClawdTime did not answer on this Mac" | `clawdtime agents` must work in a terminal. Run `npm link` again           |
| The screen video is black              | Grant Screen Recording to your terminal app, then restart the agent        |
| The wrong screen is shown              | Set `CLAWDTIME_LINE_SCREEN_DEVICE` (see `.env.example`)                    |
| `line_in_use` from `chert dev`         | Another session holds the line. Stop it there, or wait                     |
| A job starts but no answer comes       | Look at its terminal window. `clawdtime jobs` lists every job              |
| `clawdtime texts check` is refused     | Make a new key with read and write access. Check the project id            |

More: [the supervisor guide](docs/SUPERVISOR.md), [the agent board](docs/AGENT_BOARD.md),
and `chert guide` for the line itself.
