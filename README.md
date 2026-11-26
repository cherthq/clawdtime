<h1 align="center">ClawdTime</h1>

<p align="center"><strong>A computer use agent for your Mac</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0-blue" alt="Version 0.4.0">
  <a href="https://www.clawdtime.com"><img src="https://img.shields.io/badge/ClawdTime-Website-black" alt="ClawdTime website"></a>
  <img src="https://img.shields.io/badge/status-internal_pilot-orange" alt="Internal pilot">
</p>

ClawdTime is a computer use agent that works on your Mac: it uses your apps,
web pages and accounts for you, and checks each action in code before it acts.
You reach it in its chat, by voice, by iMessage and on a FaceTime call through
a Chert line.

## What it does

- **Computer and browser use.** It clicks, types, scrolls and reads the screen
  in any app, and can drive a web page by its elements. A visible cursor glides
  to each place before it acts.
- **Plans for long tasks.** It splits a task into a few subgoals and checks
  each one on the screen.
- **A chat that acts.** Say what you want in the chat, by voice or on a call.
  It starts at once, and your next words steer the task.
- **Calls you back for a sign-in.** When it needs you, it calls you on your
  line, or texts you. You type passwords on the Mac yourself: it never asks
  for one.
- **Zoom on a call.** The call video follows its clicks. Say "zoom on the
  address bar" or "show the whole screen".
- **Routines.** "Every morning at 9, check my inbox and tell me" runs every
  day at 9.
- **Memory.** It keeps what you tell it about you and your work, when you turn
  memory on.
- **Any model provider.** OpenAI, Anthropic, Google Gemini, Mistral, Groq,
  OpenRouter and more, or your own endpoint.
- **Coding agents.** It lists the coding agent sessions on your Mac, answers
  their permission requests for you, and hands code work to a new session.

## Quick start

You need macOS 14 or later, Node 24 or later, Swift (the Xcode command line
tools) and an iPhone.

1. **Install** ClawdTime and the `chert` command:

   ```sh
   npm install -g @trychert/facetime@beta
   git clone https://github.com/cherthq/clawdtime.git ~/clawdtime
   cd ~/clawdtime && npm ci && npm run build && npm link
   (cd line && npm install)
   ```

2. **Connect** to Chert and get a line: `clawdtime connect`
3. **Turn on** computer use: `clawdtime computer on`
4. **Add a model key**: `clawdtime keys set openai`. It reads the key from a
   hidden prompt. For another provider, see
   [Models and keys](INSTRUCTIONS.md#5-models-and-keys).
5. **Start the desktop**, with `--project` set to the folder for code work:

   ```sh
   (cd mac && swift build --product ClawdTimeTaskPanel)
   CLAWDTIME_CHAT=agent npm run task:desktop -- \
     --state ~/.local/share/clawdtime/desktop --project ~/code/my-project
   ```

   The mascot appears. Click it to open the chat. In System Settings, Privacy
   & Security, give the panel Accessibility and Screen & System Audio
   Recording. Then run `clawdtime connect` once more, so that the desktop gets
   its calling policy.

`clawdtime computer doctor` says what is ready and what is missing.

## Opt-in previews

These parts are off until you select them. Tests cover them, but they still
need a check on a real Mac and phone before you rely on them.

- **Window sharing.** Share one window or one display on a call, and crop
  and zoom it. `npm run preview:camera` opens a local preview with no call.
- **Prepared walkthroughs.** The agent stages a walkthrough of two apps and
  raises each exact window in turn. `npm run prepare:presentation`, then
  `npm run test:presentation`.
- **Streaming voice.** A new session can use `--voice-frontend elevenlabs`.
  `npm run test:voice:camera` checks the path with no provider or phone.
- **Text sessions.** A paired person can control a scoped session by iMessage.
  You approve each grant on the Mac.

## Benchmarks

Measured on 26 November 2026. The harness is the same for every row; only the
model changes. The evals open no window and touch nothing on your screen.

| Model                  | Planner eval: right first action (38 screens, 2 runs) | Median answer | Request eval: tasks done (23 tasks of many steps) | Time for all 23 |
| ---------------------- | ----------------------------------------------------- | ------------- | ------------------------------------------------- | --------------- |
| gpt-6.2-astra          | 76/76                                                 | 2.6 s         | 23/23                                             | 393 s           |
| gpt-6.2-sol            | 75/76                                                 | 1.8 s         | 23/23                                             | 222 s           |
| gpt-5.4                | 76/76                                                 | 1.5 s         | 21/23                                             | 170 s           |
| claude-fable-5-2       | 74/76                                                 | 1.6 s         | 23/23                                             | 198 s           |
| claude-opus-5-5        | 74/76                                                 | 1.6 s         | 23/23                                             | 239 s           |
| claude-sonnet-5-5      | 74/76                                                 | 1.9 s         | 23/23                                             | 262 s           |
| gemini-3.1-pro-preview | 63/76                                                 | 4.2 s         | 23/23                                             | 734 s           |
| gemini-3.8-flash       | 63/76                                                 | 4.0 s         | 21/23                                             | 913 s           |

On a real Mac, on the real screen:

- 44 apps, one read-only task each (Calculator, Maps, System Settings, Safari,
  LibreOffice and more): 37 of 44 right on a full run of the newest build. 2
  of the misses were correct stops (a sign-in page, Mail with no account).
- 14 tasks of real work (reading the news, YouTube and a social feed,
  comparing prices on a shop, writing and saving an essay and a blog draft,
  a research note across two apps, Terminal, Finder): 11 of 14 right; 2 of
  the misses were apps that this Mac does not have.

Run the evals yourself, with a key for the provider:

```sh
npm run eval:computer:planner -- gpt-6.2-sol anthropic/claude-opus-5-5 --repeat 2
npm run eval:computer:request -- gpt-6.2-sol
```

Add `--check` to prove the checks with no model and no key.

## Read more

| Page                                                                             | What it covers                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [INSTRUCTIONS.md](INSTRUCTIONS.md)                                               | The full user guide: every command, setting and phrase          |
| [SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md)                                         | The Chert line step by step: calls, texts and the line agent    |
| [AGENTS.md](AGENTS.md)                                                           | Rules for coding agents that work in this repository            |
| [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md)                                     | How computer use works: the planner, the checks and the limits  |
| [docs/SUPERVISOR.md](docs/SUPERVISOR.md)                                         | The chat, voice, memory, the trove and answers to coding agents |
| [docs/AUTOMATIC_CALL_ZOOM.md](docs/AUTOMATIC_CALL_ZOOM.md)                       | Zoom on the call video                                          |
| [docs/AGENT_BOARD.md](docs/AGENT_BOARD.md)                                       | The coding agent sessions on this Mac                           |
| [docs/DESKTOP_SPACES.md](docs/DESKTOP_SPACES.md)                                 | Moves between desktops and apps                                 |
| [docs/CODING_DEMO_DESKTOP.md](docs/CODING_DEMO_DESKTOP.md)                       | The desktop service and the panel: options, recovery and limits |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                     | The parts and how they connect                                  |
| [docs/CONVERSATIONAL_CONTROL_RELEASE.md](docs/CONVERSATIONAL_CONTROL_RELEASE.md) | The opt-in voice, text and job previews, and their checks       |
| [docs/AUDIO_QUALIFICATION.md](docs/AUDIO_QUALIFICATION.md)                       | The audio test mode for a line                                  |
| [media/README.md](media/README.md)                                               | The media service, the camera preview and its checks            |
