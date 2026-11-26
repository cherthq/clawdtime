# Install ClawdTime

ClawdTime is a computer use agent for your Mac. This page installs it and sets
it up. You need a Mac with macOS 14 or later, Node 24 or later, the Xcode
command line tools and an iPhone. The installer checks each one and says how to
get what is missing.

## Paste this into your coding agent

Open Claude Code or Codex on the Mac, and paste this:

```text
Install and set up ClawdTime on this Mac, end to end. Do each step yourself. Ask me only where a step says "ask me".

1. Install: run curl -fsSL https://raw.githubusercontent.com/cherthq/clawdtime/main/scripts/install.sh | sh
   If it stops on a missing tool, install that tool the way its line says, then run the script again. xcode-select --install opens a dialog: ask me to finish it. Never use sudo. If the script prints a PATH line, run it. If it says that it kept another clawdtime command, ask me before you replace it.
2. Connect a line: ask me to run clawdtime connect in my own terminal. It opens the browser to sign me in to Chert, and it asks me for my number, my yes to calls and texts, and a project API key. I answer each question myself. When I say done, run clawdtime connect --check and tell me each step that is not ready, in its own words.
3. Add a model key: ask me which provider I use (openai, anthropic, gemini, or another one from clawdtime keys help). Then ask me to run clawdtime keys set PROVIDER in my own terminal and type the key into its hidden prompt. Never ask me for a key in this chat. Never read, print or store a key.
4. Permissions: ask me to give the panel two permissions in System Settings, Privacy & Security: Accessibility, and Screen & System Audio Recording. In each list I press + and choose the panel file that the installer named (by default ~/clawdtime/mac/.build/debug/ClawdTimeTaskPanel). Wait until I say done.
5. Start: run clawdtime computer on, then clawdtime start. Tell me to click the mascot to open the chat. Then run clawdtime connect once more, so that the desktop gets its calling policy. If it asks a question, ask me to run it in my own terminal.
6. Check: run clawdtime computer doctor. Fix each line that you can. Tell me each line that only I can fix, in its own words.
7. Report in a few lines: what is ready, what is not, and a first request to type in the chat: "open wikipedia and tell me today's featured article".
```

## Install by hand

1. **Install.** Run this in Terminal:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/cherthq/clawdtime/main/scripts/install.sh | sh
   ```

   It checks the Mac, puts ClawdTime in `~/clawdtime`, builds it, and adds
   the `clawdtime` and `chert` commands. When a tool is missing, it prints how
   to get it. When it prints a PATH line, run that line. Run it again at any
   time: it updates ClawdTime.

2. **Connect a line.** Run `clawdtime connect`. It signs you in to Chert in the
   browser and gets you a line, one step at a time. Run it again at any time:
   it goes on where it stopped.

3. **Add a model key.** Run `clawdtime keys set openai`. It reads the key from
   a hidden prompt and never shows it. For another provider, run
   `clawdtime keys help`, or see
   [Models and keys](INSTRUCTIONS.md#5-models-and-keys).

4. **Give the panel two permissions.** Open System Settings, Privacy &
   Security. In Accessibility, and in Screen & System Audio Recording, press
   **+** and choose `~/clawdtime/mac/.build/debug/ClawdTimeTaskPanel` (press
   Command+Shift+G to type the path).

5. **Start it.** Run `clawdtime computer on`, then `clawdtime start`. The
   mascot appears. Click it to open the chat. Then run `clawdtime connect` once
   more, so that the desktop gets its calling policy. The first start makes
   `~/clawdtime-work`, the folder for code work. To choose another folder, use
   `clawdtime start --project PATH` the first time.

## Check it works

```sh
clawdtime computer doctor
```

Each line names one part and says what is missing. When it is ready, click the
mascot and type a first request:

> open wikipedia and tell me today's featured article

ClawdTime opens the page, reads it and tells you the answer in the chat.

## When something is not ready

| `clawdtime computer doctor` says                       | What to do                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `desktop service` missing                              | Run `clawdtime start`                                                                                            |
| `switch` off                                           | Run `clawdtime computer on`, then [start the desktop again](INSTRUCTIONS.md#3-start-the-desktop)                 |
| `model key` missing                                    | Run `clawdtime keys set PROVIDER`, then [start the desktop again](INSTRUCTIONS.md#3-start-the-desktop)           |
| `executor` not configured                              | The service started before the switch or the key. [Start the desktop again](INSTRUCTIONS.md#3-start-the-desktop) |
| `hands`: a task says that the panel lacks a permission | Do step 4. Then choose Quit ClawdTime in the mascot's menu, and run `clawdtime start`                            |
| `calls to you` not ready                               | Run `clawdtime connect`: it does the missing step                                                                |

The full guide is [INSTRUCTIONS.md](INSTRUCTIONS.md). The line in detail is in
[SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md).
