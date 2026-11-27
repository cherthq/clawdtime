# ClawdTime instructions

This guide shows how to use every part of ClawdTime. ClawdTime is a computer
use agent: it works on your Mac for you, and you reach it in its chat, by
voice, by text and on a FaceTime call. Every command in this guide is part of
the `clawdtime` command. `clawdtime help` lists them, and most commands take
`help` too, for example `clawdtime computer help`.

The examples use made-up names: `shop.example`, Stonepad and Riverchat stand
for any site or app.

## Contents

1. [Install](#1-install)
2. [Connect to Chert and get a line](#2-connect-to-chert-and-get-a-line)
3. [Start the desktop](#3-start-the-desktop)
4. [Computer use](#4-computer-use)
5. [Models and keys](#5-models-and-keys)
6. [The chat](#6-the-chat)
7. [What it asks before, and the owner's trust](#7-what-it-asks-before-and-the-owners-trust)
8. [Browsers](#8-browsers)
9. [Calls, texts and the reach](#9-calls-texts-and-the-reach)
10. [Zoom on a call](#10-zoom-on-a-call)
11. [Routines](#11-routines)
12. [Memory](#12-memory)
13. [Vocabulary for speech](#13-vocabulary-for-speech)
14. [Coding agents](#14-coding-agents)
15. [Stop it](#15-stop-it)
16. [Privacy](#16-privacy)
17. [Troubleshooting](#17-troubleshooting)
18. [Settings](#18-settings)

## 1. Install

What you need:

| Thing                                     | Check                                        |
| ----------------------------------------- | -------------------------------------------- |
| A Mac with macOS 14 or later              | Apple menu, About This Mac                   |
| Node 24 or later                          | `node --version`                             |
| Swift, from the Xcode command line tools  | `swift --version`                            |
| `ffmpeg`, to share the screen on a call   | `ffmpeg -version` (`brew install ffmpeg`)    |
| `tmux`, to keep the line agent running    | `tmux -V` (`brew install tmux`)              |
| An iPhone, to join your line and call it  | FaceTime and iMessage on                     |
| A key of a language model provider        | See [Models and keys](#5-models-and-keys)    |
| An OpenAI key, for voice and for the line | It speaks on a call and turns speech to text |

Install ClawdTime and the `chert` command:

```sh
npm install -g @trychert/facetime@beta
git clone https://github.com/cherthq/clawdtime.git ~/clawdtime
cd ~/clawdtime && npm ci && npm run build && npm link
(cd line && npm install)
```

`npm link` puts the `clawdtime` command on your PATH. Keep the folder outside
Documents, Desktop and Downloads: a scheduled update cannot read those folders.

To update later, run this in `~/clawdtime`. Then build the panel again and
start the desktop and the line agent again ([section 3](#3-start-the-desktop)).

```sh
git pull --ff-only && npm ci && npm run build && (cd line && npm install)
```

## 2. Connect to Chert and get a line

Chert gives ClawdTime a real phone line. You call the line on FaceTime or text
it on iMessage, and ClawdTime answers. ClawdTime also uses the line to call or
text you when it needs you.

```sh
clawdtime connect
```

It goes through ten steps. Each step checks first and skips what is done. It
prints one line for each step: done, or what is missing and the command that
does it.

| Step | What it does                                                                       |
| ---- | ---------------------------------------------------------------------------------- |
| 1    | Checks that the `chert` command is installed                                       |
| 2    | Signs this Mac in to Chert. If it is not, `chert login` runs                       |
| 3    | Picks the project: the one in `line/.env.local`, or the one of the sign-in         |
| 4    | Gets a line. If the project has none, `chert onboard` runs and gets you one        |
| 5    | Sets up the line agent in `line/`                                                  |
| 6    | Asks for your own mobile number, with the country code                             |
| 7    | Asks whether ClawdTime may call and text that number. Only a typed `yes` allows it |
| 8    | Asks for the project API key, in a prompt that does not show it                    |
| 9    | Sets up the outbound line that ClawdTime calls you on                              |
| 10   | Says whether calls to you and texts to you are ready                               |

Make the project API key with read and write access on
https://app.trychert.com/developer. It is shown once. `clawdtime connect` never
asks for the OpenAI key: put it in `line/.env.local` yourself, as
`OPENAI_API_KEY`.

Run it again at any time. It goes on where it stopped.

| Command                                                | What it does                                         |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `clawdtime connect`                                    | Does the next step that is not done                  |
| `clawdtime connect --check`                            | Reports only. Nothing is changed or started          |
| `clawdtime connect --yes`                              | Takes every default that needs no secret             |
| `clawdtime connect --phone +14155550100 --consent yes` | Gives your number and your answer with no question   |
| `clawdtime connect --api-key-env MY_KEY`               | Reads the project API key from the variable `MY_KEY` |
| `clawdtime connect --consent no`                       | ClawdTime stops calling and texting you              |

`--yes` never answers the question about calls and texts for you. The exit
code is 0 when all is ready, 3 when your line is ready and some optional steps
are still to do, and 1 when a needed step is missing.

Step 7 sends a calling policy to the desktop service, so the service must run
then. Start the desktop ([section 3](#3-start-the-desktop)), then run
`clawdtime connect` again. The policy lasts 30 days: run `clawdtime connect`
again to renew it.

[SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md) has every step in detail, the files
that `clawdtime connect` writes, and how to host the line agent.

## 3. Start the desktop

The desktop is two parts: the desktop service, which does the work, and the
panel, which shows the mascot, the chat and the cursor. The panel also holds
the hands: it looks at the screen and sends the clicks and keys.

Build the panel once, and after each update:

```sh
cd ~/clawdtime/mac && swift build --product ClawdTimeTaskPanel && cd ..
```

Start the desktop:

```sh
CLAWDTIME_CHAT=agent npm run task:desktop -- \
  --state ~/.local/share/clawdtime/desktop --project ~/code/my-project
```

- `--state` is a private folder for the service. Use this folder: the other
  commands look for the service there. It must be outside the project.
- `--project` is the folder where coding work runs.
- Settings go before the command, as `CLAWDTIME_CHAT=agent` does here. See
  [Settings](#18-settings).
- `--tucked true` starts the panel as the mascot alone, and takes no focus.

`clawdtime start` runs this command for you, with the same state folder. With
no `--project`, the first start uses `~/clawdtime-work`, and later starts keep
the project of the first one. `clawdtime start --tucked true` starts the
mascot alone. `clawdtime start --foreground` stays in the foreground and owns
the desktop: it prints `{"type":"ready"}` when the desktop is ready, and
Ctrl+C or SIGTERM closes the panel and stops the service.

The mascot appears on your desktop. Click it to open the chat. The bar under
the mascot has two buttons: **Chat** and **Talk**. The mascot's menu picks its
style and size.

Give the panel two permissions in System Settings, Privacy & Security:
Accessibility, and Screen & System Audio Recording. When one is missing, a task
ends and its message names the permission.

Closing or quitting the panel leaves the service running. Run the same command
again to open the panel again.

**Start it again.** Some changes take effect only when the desktop service
starts: `clawdtime computer on`, a new key or model, and every setting. To start
it again:

1. Check that nothing runs: `clawdtime computer status` and `clawdtime jobs`.
2. Stop the service. Its process id is `pid` in
   `~/.local/share/clawdtime/desktop/desktop-service.json`. Run `kill PID`: the
   service stops cleanly.
3. Run the start command again.

## 4. Computer use

Computer use is off until you turn it on.

| Command                     | What it does                                                          |
| --------------------------- | --------------------------------------------------------------------- |
| `clawdtime computer on`     | Turns it on. Then start the desktop again                             |
| `clawdtime computer off`    | Turns it off. A task that runs stops before its next action           |
| `clawdtime computer status` | On or off, and the last request                                       |
| `clawdtime computer doctor` | What is ready and what is missing. `--json` for a script              |
| `clawdtime computer clear`  | After a task with an unknown result, lets new work start              |
| `clawdtime computer timing` | The time of the newest steps: the look, the plan and the action       |
| `clawdtime computer model`  | Shows or chooses the model. See [Models and keys](#5-models-and-keys) |

It needs four things: the switch on, a model key, the desktop running, and the
two permissions of the panel. `clawdtime computer doctor` checks the first
three. A task says so when the panel lacks a permission.

### Give it a task

Say what you want in the chat, with the talk button, or on a call. Your own
words are the task:

- "Open Stonepad and make a new note that says hello."
- "Find a phone case on shop.example and put it in the cart."
- "Reply to Sam on Riverchat: I will be there at 3."
- "What is on the screen?" It looks and tells you. It sends no input.

### How it works

- **One checked action at a time.** It looks at the screen, picks one action,
  and checks it in code. Just before the input it looks again. If another
  window came to the front or the target moved, nothing is sent.
- **A cursor you can see.** Before each click, key or scroll, an orange cursor
  glides to the place with a short label, such as `Click "Save"`. Then the
  real event goes.
- **Plans for long tasks.** A task of several steps gets a plan of up to 8
  subgoals. Each subgoal has a check on the screen. It can note short facts on
  the way, such as an order number, and tells you them at the end.
- **It gets past small blocks.** A cookie banner, a "what's new" sheet or a
  slow page does not stop it. A dialog that the task does not speak about
  stays as it is.
- **It tries other ways.** When the screen does not change, it tries the
  keyboard, a search field or another route. After a few tries, it asks you
  what to try next.
- **You can take over.** When you move the mouse or press a key while it
  works, it pauses and asks "continue or stop".
- **Bounds.** One task runs at a time. A task ends after 40 actions (80 with a
  plan of 3 subgoals or more) or 15 minutes.

While macOS records the screen, or a call shows it, the cursor glides at a
calm pace: about half a second for each move, with a short trail and a pulse
at each click, so a recording or a phone shows each move. Set
`CLAWDTIME_CURSOR_PACE=calm` before the command that starts the desktop to keep
the calm pace at all times, or `CLAWDTIME_CURSOR_PACE=fast` to keep the fast
pace at all times. With Reduce Motion the cursor jumps at either pace.

### Words while a task runs

Talk to it while it works. Your words go into the task that runs, and the task
goes on with them. No magic word is needed.

| You say                                            | What happens                                  |
| -------------------------------------------------- | --------------------------------------------- |
| "stop", "cancel", "abort", also with a typo        | It stops at once                              |
| "wait", "hold on", "let me do it", "one sec"       | It pauses before its next input               |
| "how's it going?", "are you done?"                 | One sentence about where it is                |
| "continue", "ok", "thanks"                         | It goes on                                    |
| "not that one, the blue one", "use the search box" | It takes your words into the task and goes on |

Any next message ends a pause. Words that hold a password, a PIN, a code, a
key or a card number are refused: they are kept nowhere and never go to the
model.

### Desktops and apps

"Go to Stonepad", "take me back to the app before" and "move one desktop to
the right" are moves of their own. For a move between desktops, macOS needs
two shortcuts: in System Settings, Keyboard, Keyboard Shortcuts, Mission
Control, turn on "Move left a space" and "Move right a space". Then give the
same two combinations to the panel when you start the desktop, for example:

```sh
CLAWDTIME_SPACE_LEFT_SHORTCUT=ctrl+left CLAWDTIME_SPACE_RIGHT_SHORTCUT=ctrl+right \
  CLAWDTIME_CHAT=agent npm run task:desktop -- --state ~/.local/share/clawdtime/desktop --project ~/code/my-project
```

Use the combinations that your Mac has. See
[docs/DESKTOP_SPACES.md](docs/DESKTOP_SPACES.md).

### A result that is not known

When the service restarts during a task, or an action's result never comes
back, the task is `uncertain`. It is never run again, and no new task starts.
Look at the screen to see what happened. Then run `clawdtime computer clear`,
or say "clear the computer task".

## 5. Models and keys

The planner is the language model that picks each action. It can use any of
these providers.

| Provider      | Id           | Key variables                                                  | Default model     |
| ------------- | ------------ | -------------------------------------------------------------- | ----------------- |
| OpenAI        | `openai`     | `CLAWDTIME_OPENAI_API_KEY`, `OPENAI_API_KEY`                   | `gpt-5.4`         |
| Anthropic     | `anthropic`  | `CLAWDTIME_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY`             | `claude-opus-5-5` |
| Together AI   | `together`   | `CLAWDTIME_TOGETHER_API_KEY`, `TOGETHER_API_KEY`               | you choose        |
| OpenRouter    | `openrouter` | `CLAWDTIME_OPENROUTER_API_KEY`, `OPENROUTER_API_KEY`           | you choose        |
| Groq          | `groq`       | `CLAWDTIME_GROQ_API_KEY`, `GROQ_API_KEY`                       | you choose        |
| Fireworks AI  | `fireworks`  | `CLAWDTIME_FIREWORKS_API_KEY`, `FIREWORKS_API_KEY`             | you choose        |
| xAI           | `xai`        | `CLAWDTIME_XAI_API_KEY`, `XAI_API_KEY`                         | you choose        |
| Google Gemini | `gemini`     | `CLAWDTIME_GEMINI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | you choose        |
| Mistral       | `mistral`    | `CLAWDTIME_MISTRAL_API_KEY`, `MISTRAL_API_KEY`                 | you choose        |
| DeepSeek      | `deepseek`   | `CLAWDTIME_DEEPSEEK_API_KEY`, `DEEPSEEK_API_KEY`               | you choose        |
| Custom        | `custom`     | `CLAWDTIME_CUSTOM_API_KEY`, or no key                          | you choose        |

### Keys

```sh
clawdtime keys set anthropic         # a hidden prompt: the key is not shown
pbpaste | clawdtime keys set groq    # or from standard input
clawdtime keys list                  # set or not set, and where each key comes from
clawdtime keys remove anthropic
```

The key store is a file for you only. No command prints a key, not even a part
of it. A key variable in the environment of the desktop service wins over a
stored key. Start the desktop again after a change.

### Choose a model

```sh
clawdtime computer model                                  # the model now, and where its key comes from
clawdtime computer model anthropic/claude-opus-5-5
clawdtime computer model together/MODEL                   # a provider with no default needs a model
clawdtime computer model custom/MODEL --base-url http://127.0.0.1:8080/v1
clawdtime computer model auto                             # back to the first provider with a key
```

- With no choice, the planner takes the first provider that has a key, in the
  order of the table, with its default model.
- `CLAWDTIME_COMPUTER_MODEL=provider/model` in the environment wins over the
  stored choice. A bare model, such as `gpt-4.1`, means OpenAI.
- For a provider with no default, choose a model that reads pictures.
- With OpenAI and no choice, a key that may not use `gpt-5.4` falls back to
  `gpt-4.1`. A model that you chose is never replaced.
- A custom address must use https, or http to this Mac only (`localhost`,
  `127.0.0.1` or `[::1]`).

### The newest OpenAI models

OpenAI models whose name starts with `gpt-6` or `gpt-5.6` go to the OpenAI
Responses route (`https://api.openai.com/v1/responses`). Every other model
goes to the chat completions route of its provider. To choose the route for
any OpenAI model, set `CLAWDTIME_OPENAI_API=responses` or
`CLAWDTIME_OPENAI_API=chat`. This setting also applies to the chat's model.

### Effort and speed

| Setting                     | Values                  | What it does                                                            |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `CLAWDTIME_COMPUTER_EFFORT` | `low`, `medium`, `high` | The reasoning effort of the planner, on the models that take it         |
| `CLAWDTIME_COMPUTER_SPEED`  | `fast`, `standard`      | `fast` turns on the fast mode of the models that have it. It costs more |

Any other value stops the planner, and `clawdtime computer doctor` says why.

### The chat and voice models

| Setting                          | Default                  | What it does                                                          |
| -------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `CLAWDTIME_SUPERVISOR_MODEL`     | `gpt-4.1-mini`           | The model of the chat. With the chat agent it can be `provider/model` |
| `CLAWDTIME_SUPERVISOR_REASONING` | not set                  | The reasoning effort of the chat's model, such as `low`               |
| `CLAWDTIME_TRANSCRIBE_MODEL`     | `gpt-4o-mini-transcribe` | Turns your speech into text                                           |
| `CLAWDTIME_SPEAK_MODEL`          | `gpt-4o-mini-tts`        | Speaks the answer                                                     |
| `CLAWDTIME_VOICE`                | `alloy`                  | The voice                                                             |

Voice uses the OpenAI API. It needs `CLAWDTIME_OPENAI_API_KEY` or
`OPENAI_API_KEY` in the environment.

### Test a model first

Run the planner test before you rely on a new model. It needs the model's key
and the Chromium of Playwright (`npm run cua:install-browser`), and it makes
real model calls. It opens no window and sends no input.

```sh
npm run eval:computer:planner -- anthropic/claude-opus-5-5 together/MODEL
npm run eval:computer:request -- anthropic/claude-opus-5-5
```

Add `@low`, `@medium` or `@high` to a model for an effort, for example
`gpt-6.2-astra@medium`.

## 6. The chat

There are three ways to talk to ClawdTime. They share one conversation.

| Way              | How                                                                   |
| ---------------- | --------------------------------------------------------------------- |
| Text             | Click the mascot, or the **Chat** button. Or run `clawdtime chat`     |
| Voice on the Mac | The **Talk** button, or `clawdtime talk`. You speak, it answers aloud |
| A phone call     | Call your line on FaceTime. See [Calls](#9-calls-texts-and-the-reach) |

`clawdtime chat "what needs me?"` answers one message and exits. When the
desktop runs, the desktop service answers it, so the words reach the same place
as words typed in the panel.

### The chat agent

Set `CLAWDTIME_CHAT=agent` to use the chat agent. It is one agent loop: each
message goes to the model with the conversation and the task list, and the
model acts at once through its tools. "Can you search for Aero 7 headphones?"
starts the search. Set it in the environment of the command that starts the
desktop, and of `clawdtime chat`, `clawdtime talk` and `clawdtime texts`. With
no value, the older chat answers.

The chat agent can:

- start a task on the Mac, add your correction to it, stop it, and say how it
  goes;
- answer the question of a task, or the request of a coding agent;
- hand code work to a coding agent in a new terminal session, and read its
  answer;
- add, list, pause and remove routines;
- search memory and keep what you tell it, while memory is on;
- debug the Mac at the process level, and quit, force quit or restart an
  app (see [Debug the Mac](#debug-the-mac)).

Some rules are code, and no answer of the model changes them. A "stop" stops
the task before the model reads it. A yes to a question of a task is your own
newest message, read by a strict reader. A message that holds a password, a
key or a code never goes to the model or to memory.

### Debug the Mac

Ask the chat agent why the Mac is slow, what is on port 3000, why an app
crashed, what eats memory, or whether a build still runs. It reads the
process level of the Mac, not the screen: the top processes, one process in
detail, the listening ports, the recent log lines of one process, the newest
crash and hang reports, the launchd jobs, and the memory, swap and disk. A
look only reads, and changes nothing.

It never reads an environment variable. A value in the arguments of a
process or in a log line that looks like a password or a key is hidden
before the model sees it.

Say "quit Stonepad" or "restart Stonepad" and it acts at once: the app gets
the same request to quit as from the Dock, so it can save first. A force
quit can lose what is not saved, and so can a stop of a process that is no
app, so they ask first:

> Force quit Stonepad (pid 4242)? Changes that are not saved are lost. Say
> yes or no.

Your own clear yes in your next message lets it go. "Force quit Stonepad
without saving" needs no question, and neither does a force quit with trust
on (see [The owner's trust](#the-owners-trust)). It never ends a part of
macOS that keeps the Mac running, a process of another user, or ClawdTime
itself.

When a task on the screen finds an app that does not answer, the planner
also reads one line about its process, such as "Stonepad is at full CPU".

### A new chat, and the chats before

| To                     | Do                                                                             |
| ---------------------- | ------------------------------------------------------------------------------ |
| Start a new chat       | The new chat button in the header of the chat, or `clawdtime chat new`         |
| The same, in words     | Type "new chat", "clear the chat" or "start over"                              |
| List the chats before  | `clawdtime chat history`: the time, the number of messages and the first words |
| Open one of them again | `clawdtime chat open TIME`                                                     |

A new chat puts the current one aside. Nothing is deleted. Work that runs goes
on, and a question that waits for you is the first line of the new chat.

## 7. What it asks before, and the owner's trust

A question can reach you by a call or a text, so ClawdTime asks only before an
action that cannot be undone and costs money, data or trust. It does
everything else with no question.

| It asks before               | For example                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| A payment                    | Buy, Pay, Place order, Subscribe, Book, a Confirm while the screen shows a total |
| A loss for good              | Delete forever, Empty Trash, Erase, Uninstall, a terminal command that deletes   |
| A loss of unsaved changes    | Don't Save, Discard, a quit while the window shows unsaved changes, a force quit |
| A send                       | Send, Reply, Forward, Post, Publish, Share, `git push`                           |
| A public act                 | Like, Follow, Repost, Upvote                                                     |
| A change of account security | A password, two-factor or privacy change, `sudo`                                 |
| A grant of access            | Allow or Approve in a permission dialog, "Open Anyway"                           |
| Terms that bind you          | Agree, Accept                                                                    |
| Terminal input               | Typing, a key or a paste in a terminal                                           |
| The Trash, a password field  | A drag onto the Trash, a drag out of a password field                            |

Your own request can say yes ahead of time for some of these: "reply to Sam"
allows the reply, "close it without saving" allows the loss of changes, "run
the tests" allows terminal work, and "like the post" allows the like. A
payment, a loss for good, an account change, a grant, binding terms and a drop
onto the Trash always ask.

It needs no yes to open or quit an app, close what loses nothing, answer a
cookie banner (it picks the choice that shares the least), download, follow a
link, scroll, fill a cart up to the last step of a checkout, or use a Delete
that can be undone (Move to Trash).

Each question is short enough for a call, and ends with "Say yes or no.":

> Click "Place order" on shop.example? It spends your money: 48 dollars for 2
> items. Say yes or no.

A yes is for that one action. A no ends the task.

### The owner's trust

Start the desktop with `CLAWDTIME_COMPUTER_TRUST=on` to stop the questions.
Then ClawdTime pays, deletes, sends and grants as your request and the screen
lead it, and its record keeps which kind each such action was. A pause also
ends by itself after 60 seconds with no message. Trust is off until you turn
it on.

What stays with trust on: Stop, the bar and holding Escape; the look just
before each input; no input sent again when its result is not known; no typing
in a password field; and you still type every password and code yourself.

A web page or a screen can hold words that are written to lead the model.
With trust on, nothing stops such an action before it goes out. Turn trust on
only when you accept that.

## 8. Browsers

ClawdTime can work a web page in three ways. `CLAWDTIME_COMPUTER_BROWSER`
chooses one, in the environment of the command that starts the desktop.

| Value   | What it uses                                                                                |
| ------- | ------------------------------------------------------------------------------------------- |
| not set | The screen. It works the page by what it sees                                               |
| `on`    | The browser in front, your own, with your sign-ins. It reads the page and clicks by element |
| `own`   | A browser that ClawdTime starts itself, with its own profile                                |

**Your own browser (`on`).** It needs two things:

- In Chrome, Brave, Edge or Chromium: View > Developer > Allow JavaScript from
  Apple Events. In Safari: Settings > Advanced, "Show features for web
  developers", then Settings > Developer, "Allow JavaScript from Apple
  Events".
- The Automation right of macOS for the program that starts the desktop, for
  that browser. macOS asks the first time.

**ClawdTime's own browser (`own`).** It needs no setting in your browser.

- It starts Google Chrome, or else Chromium, Brave or Edge, from
  `/Applications` or `~/Applications`. `CLAWDTIME_OWN_BROWSER_PATH` names
  another browser of that family.
- It has its own profile, for you only. Your usual browser and its profile are
  not touched. Sign in to your sites in this browser once: the profile keeps
  you signed in.
- It starts at the first browser step and closes when the desktop service
  stops.

In every way, ClawdTime never types into a password field and never sends what
is in one. Run `clawdtime computer doctor` with the same setting to see whether
the browser can be driven:

```sh
CLAWDTIME_COMPUTER_BROWSER=on clawdtime computer doctor
```

The `browser` commands work the browsers that run (Chrome, Safari, Arc, Brave
and Edge), with no task. Reading the text of a page needs Allow JavaScript from
Apple Events.

```sh
clawdtime browser tabs         # every tab of the browsers that run
clawdtime browser open URL     # only http and https
clawdtime browser focus 3      # bring that tab forward
clawdtime browser text         # the visible text of the front page
```

## 9. Calls, texts and the reach

### Call ClawdTime

The line agent answers your call. It is in `line/`, and `clawdtime connect` set
it up. Put your OpenAI key in `line/.env.local` as `OPENAI_API_KEY`, then:

```sh
cd ~/clawdtime/line
chert doctor --agent clawdtime     # each failed check says what to fix
./host.sh start                    # the agent and the line, in a tmux session
./host.sh status                   # what runs, and the last records
```

The records in `~/.local/share/clawdtime/line/dev.jsonl` show the number of
your line. Place a FaceTime Video call to it from your joined iPhone.
ClawdTime greets you when FaceTime is ready. `./host.sh stop` frees the line
and stops the agent.

| You say                              | What happens                                   |
| ------------------------------------ | ---------------------------------------------- |
| "Give me the status."                | What runs, and what waits for you              |
| "Show me the screen."                | The Mac's screen is the video, with the mascot |
| "Hide the screen."                   | The video is the mascot again                  |
| "Open Stonepad and make a new note." | A task on the Mac, as in the chat              |
| "Computer status."                   | The question of the task that waits for you    |
| "Yes." "No."                         | The answer to that question                    |
| "Stop."                              | The task stops                                 |

To keep the line on the newest version, run `./host.sh schedule` in `line/`.
See [SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md) for the framing of the video, the
mascot on the call and more.

### Text ClawdTime

The same line takes iMessage texts. After `clawdtime connect`:

```sh
clawdtime texts check      # reads once, sends nothing
clawdtime texts run        # answers your texts until you press Ctrl+C
```

- A text counts only when it comes from a phone that is joined to your project
  and whose number ends with the last four digits of your number. Answers go
  only to your number. Keep the phone list of your project to your own phone.
- Turn off joining by code on https://app.trychert.com/imessage, so that no
  other phone joins your line.
- For a second check, set `CLAWDTIME_TEXT_WORD` to a private word of four
  letters or more. Then a text counts only when it starts with that word.
- When the desktop runs, a text goes to it first. So a text can start a task
  or answer the question of a task.
- On the free trial, ClawdTime can text you only within 24 hours of your last
  text.

### The reach: ClawdTime calls you

When a task needs you (a yes, a sign-in, a code or a choice) and nobody
answers in the chat for 45 seconds, ClawdTime calls you once on your line and
says the question. When the call does not get through, it texts you once. A
task that came from a call, a text or a routine reaches you at once.

- Answer on the call or by text, as you would in the chat. A plain "yes" or
  "no" counts. Words with a doubt or a condition approve nothing.
- It never asks for a password, a code or a card number by voice or by text.
  It says what is needed and where. You sign in on the Mac, or once in
  ClawdTime's own browser.
- One call and one text at most for each question, also after a restart.
- Once `clawdtime connect` stored your number in `owner.json`, it calls and
  texts only that number, and only with your yes (step 7 of
  `clawdtime connect`). That number wins over `CLAWDTIME_OWNER_PHONE`.
  `clawdtime texts run` uses the same number.
- When `owner.json` cannot be read, it sends no text, and no call goes through
  the Chert Calls API. Look at the file, then run `clawdtime connect`.
- `CLAWDTIME_COMPUTER_REACH_SECONDS` sets the wait, from 0 to 600 seconds.
  `CLAWDTIME_COMPUTER_REACH=off` turns the reach off.

The lines "calls to you" and "texts to you" of `clawdtime computer doctor` say
whether ClawdTime can reach you, and what is missing.

## 10. Zoom on a call

On a call that shows the screen, the video follows ClawdTime's clicks and
typing by itself. You can also move the video with your words. The phrases are
examples: say it your own way.

| You say on the call                               | What the video shows                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| "Zoom on the top right", "the bottom left corner" | That quarter of the screen                                                   |
| "The left half", "the top half"                   | That half of the screen                                                      |
| "The middle", "the dock", "the menu bar"          | That part of the screen                                                      |
| "Zoom on Stonepad", "this window"                 | That app's front window alone                                                |
| "The address bar", "the Send button"              | That thing, with room around it                                              |
| "Closer", "a bit closer", "2x"                    | A closer view, up to 4x                                                      |
| "Zoom out", "move right", "a bit up"              | A wider view, or the view moves that way                                     |
| "Zoom in on the session that runs the tests"      | That coding session's terminal window alone                                  |
| "Follow", "follow what you do"                    | It follows ClawdTime's clicks and typing again                               |
| "Show the whole screen"                           | The whole screen, also on later calls, until you say "resume automatic zoom" |
| "Disable automatic zoom", "enable automatic zoom" | Turns the automatic zoom off or on                                           |
| "Resume automatic zoom"                           | Ends the whole-screen view and turns automatic zoom on                       |

A zoom that you asked for holds until you say "follow" or "show the whole
screen". A new call starts without it.

The same controls work on the Mac with no call:

```sh
node line/zoom-settings.mjs status
node line/zoom-settings.mjs disable
node line/zoom-settings.mjs enable
node line/zoom-settings.mjs overview     # the whole screen
node line/zoom-settings.mjs resume
```

See [docs/AUTOMATIC_CALL_ZOOM.md](docs/AUTOMATIC_CALL_ZOOM.md).

## 11. Routines

A routine is one request that ClawdTime does at a time of day. Say or type it
in the chat, on a call or by text:

> every morning at 9, check my inbox and tell me what is new

Or use the command:

```sh
clawdtime routine add every morning at 9, check my inbox and tell me what is new
clawdtime routine list
clawdtime routine pause ID
clawdtime routine resume ID
clawdtime routine remove ID
```

- Times: "every day", "every morning" (09:00), "every evening" (18:00), "every
  weekday" or a day by name, with "at" and an hour: "at 9", "at 8:30 am", "at
  6pm", "at noon".
- In the chat you can also say "list my routines", "pause routine ID" and
  "remove routine ID".
- A routine starts only when no other task runs and no call is live. Otherwise
  it waits up to five minutes, then skips that time and texts you.
- A time that passed while the Mac slept is not run late.
- When it ends, it texts you the result. With no text settings, the result is
  in the chat.
- The desktop service runs the routines, with computer use on. Pause and
  remove do not stop a task that runs: Stop does.

## 12. Memory

Memory keeps what you tell ClawdTime about yourself and your work: a
preference, a constraint, what you work on. It is off until you turn it on.
While it is off, nothing is read and nothing is written.

```sh
clawdtime memory on
clawdtime memory remember "Never force push to main."
clawdtime memory remember "Use pnpm here." --kind preference --project .
clawdtime memory remember "The demo is on Friday." --kind episode --days 3
clawdtime memory show            # every fact
clawdtime memory search push main
clawdtime memory forget ID       # removes a fact for good
clawdtime memory off
```

- You can also say "remember ..." and "forget ..." in the chat.
- An episode expires after 14 days, or after the days you give. A fact holds
  until a newer fact replaces it.
- A fact with `--project` shows only for that project.
- A password, a key or a token is never kept.
- With memory on, computer use reads up to 5 notes that fit a task, and keeps
  up to 3 notes of what you taught it in the task.

## 13. Vocabulary for speech

Speech to text can mishear a name: "Brightwave" can come out as "Bright5",
and a task then opens a site that does not exist. Give ClawdTime your names:

```sh
export CLAWDTIME_VOCABULARY="Brightwave, Ledgerly"
```

Set it in the shell that starts the desktop, or that runs `clawdtime talk`.
Or keep the names in memory:

```sh
clawdtime memory remember "Vocabulary: Brightwave, Ledgerly"
```

The sites and apps of your last tasks are added too, and, while memory is on,
the names in your facts. The list has at most 60 words, and never a word that
looks like a secret.

## 14. Coding agents

ClawdTime also watches the coding agent sessions on this Mac, such as Claude
Code and Codex, and can answer them for you.

```sh
clawdtime agents                                    # every session, and what waits for you
clawdtime agents hooks install --agent claude-code  # once, to answer its requests from ClawdTime
clawdtime agents hooks install --agent codex        # once, then /hooks in Codex
clawdtime agents pending                            # the requests that wait, each with its id
clawdtime agents approve ID                         # or: approve ID --always, to make a rule
clawdtime agents deny ID --message "Not before review."
clawdtime jobs                                      # code work that ClawdTime handed to a new session
```

Ask in the chat to hand code work to a new session: "fix the flaky checkout
test". The mascot's bubble says when a session waits for you. See
[docs/SUPERVISOR.md](docs/SUPERVISOR.md) and
[docs/AGENT_BOARD.md](docs/AGENT_BOARD.md).

## 15. Stop it

| Way          | How                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------- |
| The Stop bar | While it works, a bar at the top of the screen says "ClawdTime is using this Mac". Press **Stop** |
| Escape       | Hold the Escape key                                                                               |
| Your words   | Say or type "stop" in the chat, by voice or on a call                                             |
| The switch   | `clawdtime computer off`                                                                          |

The answer is always the same:

> Stopped. An action that was already sent may have finished.

Stop is checked before and after every action, and once more just before each
event. A stopped task does not start again by itself.

Other stops:

- On a call, say "hide the screen": the video is the mascot again.
- **Stop sharing** and **Stop call** join the bar under the mascot, and its
  menu, whenever the service can stop either.
- `./host.sh stop` in `line/` stops the line agent.
- `clawdtime texts run` stops with Ctrl+C.

## 16. Privacy

### What ClawdTime keeps, and where

Everything is in `~/.local/share/clawdtime/` (`CLAWDTIME_CONFIG_HOME` moves
it). Each folder is for you only (mode 700), and each file too (mode 600).

| File                                         | What it holds                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `computer/journal.json`                      | The last 30 tasks: your words, the state, and each step as its kind and the name of its target |
| `computer/guidance.json`                     | What you said to a task while it ran                                                           |
| `computer/keys.json`                         | Your stored model keys                                                                         |
| `computer/model.json`                        | The model you chose                                                                            |
| `computer/routines.json`                     | Your routines, in your words                                                                   |
| `computer/reach.json`                        | Calls and texts to you: the kind of question, the times and the outcome                        |
| `computer/browser-profile/`                  | ClawdTime's own browser, with your sign-ins in it                                              |
| `agents/chat.jsonl`                          | The chat. Older chats are in `agents/chat-<time>.jsonl`                                        |
| `agents/voice/`                              | Your recording while it turns into text, then it is removed. The newest spoken answer          |
| `memory/facts.json`                          | Your memory, only while it is on                                                               |
| `trove/`                                     | Your answers to coding agents, and your rules                                                  |
| `owner.json`, `chert-key.json`, `calls.json` | Your number and your yes, the project API key, the line                                        |

The journal never holds a picture, typed text, the text of a page or the
model's words. A message that holds a credential is kept as a marker only.
`line/.env.local` holds the keys of the line agent. Git ignores it: never
commit it.

### What leaves the Mac

- **To the model provider that you chose, for each action:** your request,
  what you said during it, the plan, the last steps with the text that was
  typed, the names and values of the elements on the screen, a picture of the
  screen, and the text of the page when it read the page. With memory on, the
  notes that fit the task go too. Close what you do not want in the picture
  before you start a task.
- **To OpenAI, when you talk to ClawdTime:** what you said or typed, your
  recording while it turns into text, and the state that the model asks for.
- **Through Chert and the LiveKit project of your line:** your calls and
  texts, and the call video when you ask to see the screen.

### What never leaves the Mac

- The files in the table stay on this Mac. Only the parts named above go out.
- The value of a password field: ClawdTime never types into one and never
  sends what is in one.
- Your passwords, codes and card numbers: words that look like them are never
  sent to a model, never kept, and never asked for by voice or text.
- Your keys go only to their own provider. No command, log or record shows
  one.

Pictures of the screen and the call video are never written to disk.

## 17. Troubleshooting

Start with `clawdtime computer doctor`. Each line names one part:

| Line            | When it is not ready                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| desktop service | Start the desktop with `--state ~/.local/share/clawdtime/desktop`, or set `CLAWDTIME_DESKTOP_STATE` to its folder                                                   |
| desktop chat    | The service has no language model. Start the desktop with `CLAWDTIME_CHAT=agent` and a stored key, or with `OPENAI_API_KEY` in its environment                      |
| task session    | Only for coding tasks. It does not say whether computer use works                                                                                                   |
| executor        | "not configured": turn the switch on, add a key, start the desktop again. "uncertain": see unknown result                                                           |
| switch          | `clawdtime computer on`, then start the desktop again                                                                                                               |
| model key       | `clawdtime keys set PROVIDER`, or the key variable in the environment                                                                                               |
| model           | `clawdtime computer model PROVIDER/MODEL` for a provider with no default                                                                                            |
| effort, speed   | Fix or remove `CLAWDTIME_COMPUTER_EFFORT` or `CLAWDTIME_COMPUTER_SPEED`                                                                                             |
| state folder    | Run the `chmod 700` command that the line gives                                                                                                                     |
| journal         | It cannot be read: run `clawdtime computer clear`                                                                                                                   |
| unknown result  | Look at the screen, then `clawdtime computer clear`                                                                                                                 |
| memory          | Off: computer use reads and keeps nothing. `clawdtime memory on` turns it on                                                                                        |
| hands           | Give the panel Accessibility and Screen & System Audio Recording                                                                                                    |
| browser         | Turn on Allow JavaScript from Apple Events, and allow Automation. For `own`, set `CLAWDTIME_OWN_BROWSER_PATH` when no browser is found. See [Browsers](#8-browsers) |
| calls to you    | Run `clawdtime connect`: it does the missing step                                                                                                                   |
| texts to you    | Run `clawdtime connect`: it does the missing step                                                                                                                   |
| routines        | How many routines run and how many are paused                                                                                                                       |

Other problems:

| What you see                                        | What to do                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| "Computer use is off"                               | `clawdtime computer on`, then start the desktop again                        |
| "You moved the mouse or pressed a key, so I paused" | Say "continue" or "stop"                                                     |
| A task opens a site that does not exist             | The name was misheard. Add it to [the vocabulary](#13-vocabulary-for-speech) |
| A move to another desktop is refused                | Turn on the two Mission Control shortcuts and give them to the panel         |
| The call is declined                                | Join your phone to the line first. Call with FaceTime                        |
| No video on the call                                | Call with FaceTime Video, not Audio                                          |
| The screen on the call is black                     | Give Screen Recording to your terminal app, then start the line agent again  |
| `clawdtime texts check` is refused                  | Make a new project API key with read and write access                        |
| A change does nothing                               | Start the desktop again: the service reads its settings when it starts       |

For the line itself, run `chert doctor --agent clawdtime` in `line/`, or
`chert guide fix`.

## 18. Settings

Put a setting before the command that starts the desktop, as in
`CLAWDTIME_COMPUTER_TRUST=on npm run task:desktop -- ...`. The service reads
it when it starts. If you set `CLAWDTIME_CONFIG_HOME`, set it the same way for
every `clawdtime` command.

| Setting                                                           | Values                       | What it does                                                 |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| `CLAWDTIME_CHAT`                                                  | `agent`                      | The chat agent answers. Not set: the older chat              |
| `CLAWDTIME_COMPUTER_BROWSER`                                      | `on`, `own`                  | How it works web pages. See [Browsers](#8-browsers)          |
| `CLAWDTIME_OWN_BROWSER_PATH`                                      | a path                       | The program of ClawdTime's own browser                       |
| `CLAWDTIME_COMPUTER_TRUST`                                        | `on`                         | No question before a payment, a delete or a send             |
| `CLAWDTIME_COMPUTER_MODEL`                                        | `provider/model`             | The model of the planner                                     |
| `CLAWDTIME_COMPUTER_EFFORT`                                       | `low`, `medium`, `high`      | The reasoning effort of the planner                          |
| `CLAWDTIME_COMPUTER_SPEED`                                        | `fast`, `standard`           | The fast mode of the models that have it                     |
| `CLAWDTIME_OPENAI_API`                                            | `responses`, `chat`          | The route for OpenAI models                                  |
| `CLAWDTIME_CUSTOM_BASE_URL`                                       | an address                   | The address of a custom provider. Wins over the stored one   |
| `CLAWDTIME_COMPUTER_REACH`                                        | `off`                        | No calls and texts to you for a question                     |
| `CLAWDTIME_COMPUTER_REACH_SECONDS`                                | 0 to 600                     | How long a question waits in the chat before a call          |
| `CLAWDTIME_COMPUTER_TIMING`                                       | `on`                         | Keeps the time of each step, for `clawdtime computer timing` |
| `CLAWDTIME_SUPERVISOR_MODEL`                                      | a model, or `provider/model` | The model of the chat                                        |
| `CLAWDTIME_VOCABULARY`                                            | names, comma separated       | Your names for speech to text                                |
| `CLAWDTIME_VOICE`                                                 | a voice name                 | The voice of spoken answers                                  |
| `CLAWDTIME_SPACE_LEFT_SHORTCUT`, `CLAWDTIME_SPACE_RIGHT_SHORTCUT` | a key combination            | Your Mission Control shortcuts, for the panel                |
| `CLAWDTIME_CURSOR_PACE`                                           | `calm`, `fast`               | The pace of the cursor. Not set: calm on a recording or call |
| `CLAWDTIME_CONFIG_HOME`                                           | a full path                  | Moves the state folder from `~/.local/share/clawdtime`       |
| `CLAWDTIME_OPENAI_API_KEY`, `OPENAI_API_KEY`                      | a key                        | The OpenAI key, for voice, the older chat and the planner    |

Never put a key in a command argument or in a file of the repository.
`clawdtime keys set` reads a key from a hidden prompt.
