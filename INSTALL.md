# Install ClawdTime

ClawdTime is a computer use agent for your Mac. This page installs it and sets
it up. You need a Mac with Apple silicon and macOS 14 or later. You do not need
Node, Git or Xcode: the release brings its own runtime.

## Install with one command

Run this in Terminal:

```sh
curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh
```

It does this, and it never uses sudo:

1. It checks the Mac: macOS 14 or later, and Apple silicon.
2. It reads the newest release, downloads it and checks its SHA-256. A
   download that does not match is not installed, and nothing changes.
3. It unpacks the release in
   `~/Library/Application Support/ClawdTime/runtime/VERSION`, checks every
   file, and switches the link `current` there to it in one step. A release
   with a file that its manifest does not list is not installed, and nothing
   changes.
4. It links `~/.local/bin/clawdtime` to that release. When `~/.local/bin` is
   not on your PATH, it prints the one line that adds it. Run that line. When
   that link runs a source build, it keeps the link and says so. To point it
   at the release, run:
   `curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | CLAWDTIME_REPLACE_SOURCE=1 sh`
5. It starts the guided setup, `clawdtime onboard`, in the same Terminal
   window. When it runs with no Terminal, it says to run `clawdtime onboard`
   in Terminal to finish setup.

The guided setup asks for your model key in a hidden prompt, gives the panel
its permissions, verifies your phone and pairs this Mac. Run
`clawdtime onboard` again at any time: it checks each step that is ready and
goes on where it stopped. ClawdTime works on this Mac before the phone is
paired.

## Update

Run the same command again. It installs the newest release next to the one
you have, then switches `current` to it. Your settings, keys and pairing stay
where they are. An older release that still runs stays until it stops, and
the installer says so. The release before stays on the Mac, also when you run
the command again for the same release, so you can go back to it:

```sh
ln -sfh 0.4.0 ~/Library/Application\ Support/ClawdTime/runtime/current
```

When you run it again for the release that you have, it checks every file.
It removes a file that the release does not list, and it installs the release
again when a file changed. It says what it did.

The installer does not install a release that is older than the one you have.
It stops and says so. When the link `current` is gone, the one you have is the
newest version folder in `runtime`. To install the older release on purpose, set
`CLAWDTIME_ALLOW_DOWNGRADE=1`:

```sh
curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | CLAWDTIME_ALLOW_DOWNGRADE=1 sh
```

macOS gives each panel build its own permissions. After an update, give the
new panel Accessibility and Screen & System Audio Recording again. The guided
setup checks this.

## Set it up by hand

When the installer lists three steps instead of the guided setup, do them in
Terminal:

1. **Add a model key.** Run `clawdtime keys set openai`. It reads the key from
   a hidden prompt and never shows it. For another provider, run
   `clawdtime keys help`, or see
   [Models and keys](INSTRUCTIONS.md#5-models-and-keys).
2. **Give the panel two permissions.** Open System Settings, Privacy &
   Security. In Accessibility, and in Screen & System Audio Recording, press
   **+** and choose the panel file that the installer named, such as
   `~/Library/Application Support/ClawdTime/runtime/0.4.0/app/native/ClawdTimeTaskPanel`
   (press Command+Shift+G to type the path).
3. **Start it.** Run `clawdtime start`. The mascot appears. Click it to open
   the chat. The first start makes `~/clawdtime-work`, the folder for code
   work. To choose another folder, use `clawdtime start --project PATH` the
   first time.

## Paste this into your coding agent

Open Claude Code or Codex on the Mac, and paste this:

```text
Install and set up ClawdTime on this Mac. Do each step yourself. Ask me only where a step says "ask me".

1. Install: run curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh
   Never use sudo. If it prints a PATH line, run it. If it says that it kept another clawdtime command, ask me before you replace it.
2. Setup: ask me to run clawdtime onboard in my own Terminal. It asks me for my model key in a hidden prompt, my permissions and my phone. I answer each question myself. Never ask me for a key or a code in this chat. If the installer listed three steps instead, ask me to do steps 1 and 2 of "Set it up by hand" in INSTALL.md, then run clawdtime start.
3. Check: run clawdtime computer doctor. Fix each line that you can. Tell me each line that only I can fix, in its own words.
4. Report in a few lines: what is ready, what is not, and a first request to type in the chat: "open wikipedia and tell me today's featured article".
```

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
| `hands`: a task says that the panel lacks a permission | Do step 2 of "Set it up by hand". Then choose Quit ClawdTime in the mascot's menu, and run `clawdtime start`     |
| `calls to you` not ready                               | Run `clawdtime onboard`, or `clawdtime connect` for a dedicated line: it does the missing step                   |

## Build from the source

To build ClawdTime from its source, with a dedicated line, add `--source`:

```sh
curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh -s -- --source
```

In a checkout, run `sh scripts/install.sh --source`. The source build needs
Node 24 or later, Git and Swift 6 or later (the Xcode command line tools). It
checks each one and says how to get what is missing. It puts ClawdTime in
`~/clawdtime`, builds it, and adds the `clawdtime` and `chert` commands. Then:

1. **Connect a line.** Run `clawdtime connect`. It signs you in to Chert in the
   browser and gets you a line, one step at a time.
2. **Add a model key** and **give the panel its permissions** as in "Set it up
   by hand". The panel of a source build is
   `~/clawdtime/mac/.build/debug/ClawdTimeTaskPanel`.
3. **Start it.** Run `clawdtime computer on`, then `clawdtime start`. Then run
   `clawdtime connect` once more, so that the desktop gets its calling policy.

To use an existing shared number with your own Mac, follow
[shared setup](docs/SHARED_NUMBER_SETUP.md). The full guide is
[INSTRUCTIONS.md](INSTRUCTIONS.md). The line in detail is in
[SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md).
