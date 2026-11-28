<h1 align="center">ClawdTime</h1>

<p align="center"><strong>Talk to your Mac. It does the work.</strong></p>

<p align="center">ClawdTime: a computer use agent you can FaceTime. <a href="https://www.trychert.com">Built on Chert</a>.</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0-blue" alt="Version 0.4.0">
  <a href="https://www.clawdtime.com"><img src="https://img.shields.io/badge/ClawdTime-Website-black" alt="ClawdTime website"></a>
  <img src="https://img.shields.io/badge/status-early_release-orange" alt="Early release">
</p>

ClawdTime is an assistant on your Mac. You ask it in plain words, by chat or
by voice. It uses your apps and your browser for you: it clicks, types and
reads the screen. It can also call you, and you can call it on FaceTime
(preview).

## Install

You need a Mac with Apple silicon and macOS 14 or later, and a key from a model
provider. Choose one of two ways. Both run the same setup.

**The Mac app.** [Download ClawdTime](https://www.clawdtime.com/download).
Drag it to Applications. Open it. Choose **Set up ClawdTime**.

**One command.** Paste this in Terminal:

```sh
curl -fsSL https://www.clawdtime.com/install.sh | sh
```

It installs ClawdTime for you only and never uses sudo. You do not need Node,
Git or Xcode. Setup starts in the same window.

**Or let your coding agent install it.** Give this prompt to Claude Code or
Codex. The agent runs the command. Then you run the setup in your own
Terminal, so the agent never sees your key.

```text
Install ClawdTime on this Mac. ClawdTime is a computer use agent. It uses the apps and the browser on this Mac for me.

1. Check that this Mac has Apple silicon and macOS 14 or later. If it does not, stop and tell me.
2. Run this command in your shell. It installs ClawdTime and does not start the setup:
   curl -fsSL https://www.clawdtime.com/install.sh | CLAWDTIME_NO_ONBOARD=1 sh
3. Do not run clawdtime onboard or clawdtime keys yourself. Never ask me for a key.
4. Tell me to open Terminal and run this command there:
   clawdtime onboard
   If the installer printed a command that adds clawdtime to PATH, tell me to run that command first.
   The setup asks for my model key at a hidden prompt. It also asks for macOS permissions that only I can give.
```

Setup asks for your model key, a yes to computer use, and two macOS
permissions: Accessibility and Screen Recording. Run setup again at any time. It checks each step and continues from where it stopped. [INSTALL.md](INSTALL.md) has
each step and the build from source.

[![Watch the ClawdTime demo](https://img.youtube.com/vi/1DTf_1M67aw/maxresdefault.jpg)](https://youtu.be/1DTf_1M67aw)

## What it does

- **Ask in plain words.** "Find a phone case on shop.example and put it in the
  cart."
- **It uses your apps.** It does one checked action at a time. An orange
  cursor moves to each place before it clicks or types.
- **It asks first.** It asks before a payment, a delete that you cannot undo,
  or a send that you did not ask for.
- **Routines.** "Every morning at 9, check my inbox and tell me what is new."
- **Memory.** It keeps what you tell it, when you turn memory on.
- **Your choice of model.** OpenAI, Anthropic, Google Gemini, Mistral, Groq,
  OpenRouter and more, or your own endpoint.
- **Phone calls (preview).** When a task needs your approval, it calls you once and asks. This needs a phone line from Chert and the source install.
- **Coding agents.** It lists the Claude Code and Codex sessions on your Mac,
  answers their requests when you approve, and starts a coding session for a job.

## First use

Click the mascot to open the chat. Type a first request:

> Open Wikipedia and tell me today's featured article.

ClawdTime opens the page, reads it and answers in the chat.

To speak, press **Talk**. Voice uses an OpenAI key, set as `OPENAI_API_KEY`
when ClawdTime starts. Typing works with every provider.

To stop it, press **Stop** in the bar at the top of the screen, hold Escape,
or say "stop".

When a part does not work, run `clawdtime computer doctor`. It says what is
missing.

## Give tasks from a coding agent

Give this prompt to Claude Code or Codex. Then the agent can hand a task to
ClawdTime, and see the coding agent sessions on this Mac. The last screen of
the app's setup has a button that copies it.

```text
ClawdTime runs on this Mac. It is a computer use agent. It uses the apps and the browser on this Mac for me.

To give ClawdTime a task, run this in your shell: clawdtime chat "TASK"
For example: clawdtime chat "Open Stonepad and make a note: buy milk."
ClawdTime answers in the shell. It can use the screen to do the task.

To see the coding agent sessions on this Mac, and which one waits for an answer, run:
clawdtime agents

To see every command, run: clawdtime help

Give ClawdTime one task at a time. If a command fails, show me its output. Never ask me for a key.
Now run clawdtime agents once, to check that the command works.
If your shell does not find clawdtime, use the full path: /Applications/ClawdTime.app/Contents/Resources/runtime/bin/clawdtime
```

## Settings

In the app, open **Settings** (Command-comma). It has four pages:

| Page          | What you do there                                         |
| ------------- | --------------------------------------------------------- |
| Model keys    | Add, replace or remove the key of each provider           |
| Planner model | Choose the model that plans each action                   |
| Permissions   | See Accessibility and Screen Recording, and open them     |
| General       | Open at login, run setup again, stop, uninstall, versions |

In Terminal, use these commands:

```sh
clawdtime keys set anthropic                       # asks for the key, and does not show it
clawdtime computer model anthropic/claude-opus-5-5
clawdtime keys list                                # which keys are set, never a key
```

Every setting is in [INSTRUCTIONS.md](INSTRUCTIONS.md#18-settings).

## Update and uninstall

**Update.** Download the app again, or run the install command again. Your
settings and keys stay. macOS asks for the two permissions again.

**Uninstall.** In the app, open Settings > General. Choose **Uninstall ClawdTime**. In Terminal, run `clawdtime uninstall`. It lists what it moves to
the Trash and asks first. It deletes nothing.

## Privacy

- ClawdTime keeps your tasks, chats and keys in `~/.local/share/clawdtime`, for you only.
- For each action, your request and a picture of the screen go to the model
  provider that you chose. ClawdTime never saves pictures of the screen to disk.
- ClawdTime never types into a password field. It never sends a password, a
  code or a card number to a model.

[INSTRUCTIONS.md](INSTRUCTIONS.md#16-privacy) lists each file and what leaves
the Mac.

## Benchmarks

Measured on 26 November 2026, on build `3821123`. Only the model changes. The
evals open no window and touch nothing on your screen.

| Model                  | Right first action (76 tries) | Median answer | Tasks done (23) | Time for 23 |
| ---------------------- | ----------------------------- | ------------- | --------------- | ----------- |
| gpt-6.2-astra          | 76/76                         | 3.1 s         | 23/23           | 358 s       |
| gpt-5.4                | 76/76                         | 1.5 s         | 22/23           | 230 s       |
| claude-opus-5-5        | 75/76                         | 1.7 s         | 23/23           | 231 s       |
| gpt-6.2-sol            | 74/76                         | 2.0 s         | 23/23           | 302 s       |
| claude-fable-5-2       | 74/76                         | 1.6 s         | 23/23           | 203 s       |
| claude-sonnet-5-5      | 74/76                         | 1.8 s         | 23/23           | 254 s       |
| gemini-3.1-pro-preview | 65/76                         | 4.3 s         | 21/23           | 920 s       |
| gemini-3.8-flash       | 62/76                         | 4.6 s         | 22/23           | 896 s       |

On a real Mac, 42 of 44 apps passed a read-only task. The other 2 were
correct stops: a sign-in page, and Mail with no account. 9 of 14 tasks of
real work were right. Of the 5 misses, 2 were pauses because the owner used
the Mac, and 1 was a correct question before an overwrite.
Run the evals with `npm run eval:computer:planner` and
`npm run eval:computer:request`. Add `--check` to test the checks with no
model and no key.

## Contributing

Read [AGENTS.md](AGENTS.md) first: the code map, the build and the rules.
Install Node 24 or later and run `npm ci`. Run `npm run check` before you
push. Make one small change in each pull request.

This repository is public. Use made-up examples only, such as `shop.example`,
Stonepad or +1 415 555 0100.

## Read more

| Page                                     | What it covers                                  |
| ---------------------------------------- | ----------------------------------------------- |
| [INSTALL.md](INSTALL.md)                 | Each install step, update, uninstall and source |
| [INSTRUCTIONS.md](INSTRUCTIONS.md)       | The full user guide: every command and setting  |
| [SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md) | Phone calls and texts on a Chert line           |
| [docs/MAC_APP.md](docs/MAC_APP.md)       | The Mac app: setup, Settings and how it works   |
| [docs/SUPERVISOR.md](docs/SUPERVISOR.md) | The chat, voice, memory and coding agents       |
