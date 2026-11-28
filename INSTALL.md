# Install ClawdTime

ClawdTime is an assistant on your Mac. You ask it in plain words, by chat or
by voice, and it uses your apps for you. This page installs it and sets it up.

You need:

- a Mac with Apple silicon and macOS 14 or later
- a key from a model provider, such as OpenAI or Anthropic

You do not need Node, Git or Xcode. The release brings its own runtime.

Choose one of two ways. Both run the same setup.

## Way 1: the Mac app

1. Download [ClawdTime](https://www.clawdtime.com/download).
2. Open the downloaded file. Drag ClawdTime to Applications.
3. Open ClawdTime from Applications. Choose **Set up ClawdTime**.
4. Choose your provider. Paste your key in the secure field.
5. Say yes to computer use.
6. Choose **Open System Settings**. Turn on ClawdTime in Accessibility, and in
   Screen Recording. Come back to setup. It checks again.
7. Choose **Finish**. The mascot appears on your desktop.

On macOS 15 and later, the Screen Recording list is named Screen & System
Audio Recording. **Skip for now** is on every step. The last screen says what a
skipped step leaves undone. [docs/MAC_APP.md](docs/MAC_APP.md) tells more about
the app.

## Way 2: one command

Paste this in Terminal and press Return:

```sh
curl -fsSL https://www.clawdtime.com/install.sh | sh
```

It does these steps. It never uses sudo.

1. It checks the Mac: macOS 14 or later, and Apple silicon.
2. It downloads the newest release and checks its SHA-256. When a download
   does not match, it installs nothing.
3. It unpacks the release in
   `~/Library/Application Support/ClawdTime/runtime/VERSION`. It checks every
   file. Then it points the link `current` to the new release in one step.
4. It links `~/.local/bin/clawdtime` to the release. When `~/.local/bin` is not
   on your PATH, it prints one line that adds it. Run that line.
5. It starts the setup, `clawdtime onboard`, in the same window.

The setup asks for your model key at a hidden prompt, and for a yes to
computer use. Then it asks you to turn on Terminal in Accessibility and in
Screen Recording. When you use another terminal app, turn on that app.

Run `clawdtime onboard` again at any time. It checks each step and continues from where it stopped.

**Another `clawdtime` command.** When `~/.local/bin/clawdtime` already runs a
source build, the installer keeps it and says so. To use the release instead,
run:

```sh
curl -fsSL https://www.clawdtime.com/install.sh | CLAWDTIME_REPLACE_SOURCE=1 sh
```

## Your first request

Click the mascot to open the chat. Type:

> open wikipedia and tell me today's featured article

ClawdTime opens the page, reads it and answers in the chat.

To speak instead, press **Talk**. Voice uses an OpenAI key, set as
`OPENAI_API_KEY` when ClawdTime starts. Typing works with every provider.

## Check it works

```sh
clawdtime computer doctor
```

Each line names one part and says what is missing.

| `clawdtime computer doctor` says                       | What to do                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `desktop service` missing                              | Run `clawdtime start`                                                                                            |
| `switch` off                                           | Run `clawdtime computer on`, then [start the desktop again](INSTRUCTIONS.md#3-start-the-desktop)                 |
| `model key` missing                                    | Run `clawdtime keys set PROVIDER`, then [start the desktop again](INSTRUCTIONS.md#3-start-the-desktop)           |
| `executor` not configured                              | The service started before the switch or the key. [Start the desktop again](INSTRUCTIONS.md#3-start-the-desktop) |
| `hands`: a task says that the panel lacks a permission | Do step 2 of "Set it up by hand". Then choose Quit ClawdTime in the mascot's menu, and run `clawdtime start`     |
| `calls to you` not ready                               | Phone calls are a preview. See [Build from the source](#build-from-the-source)                                   |

## Set it up by hand

When the installer lists three steps instead of the setup, do them in
Terminal:

1. **Add a model key.** Run `clawdtime keys set openai`. It reads the key at a
   hidden prompt and never shows it. For another provider, run
   `clawdtime keys help`.
2. **Give the panel two permissions.** Open System Settings, Privacy &
   Security. In Accessibility, and in Screen Recording, press **+**. Choose the
   panel file that the installer named, such as
   `~/Library/Application Support/ClawdTime/runtime/0.4.0/app/native/ClawdTimeTaskPanel`.
   Press Command+Shift+G to type the path.
3. **Start it.** Run `clawdtime start`. The mascot appears. The first start
   makes `~/clawdtime-work`, the folder for code work. To choose another
   folder, run `clawdtime start --project PATH` the first time.

## Let your coding agent install it

Open Claude Code or Codex on the Mac, and paste this:

```text
Install and set up ClawdTime on this Mac. Do each step yourself. Ask me only where a step says "ask me".

1. Install: run curl -fsSL https://www.clawdtime.com/install.sh | sh
   Never use sudo. If it prints a PATH line, run it. If it says that it kept another clawdtime command, ask me before you replace it.
2. Setup: ask me to run clawdtime onboard in my own Terminal. It asks me for my model key in a hidden prompt and for my permissions. I answer each question myself. Never ask me for a key or a code in this chat. If the installer listed three steps instead, ask me to do steps 1 and 2 of "Set it up by hand" in INSTALL.md, then run clawdtime start.
3. Check: run clawdtime computer doctor. Fix each line that you can. Tell me each line that only I can fix, in its own words.
4. Report in a few lines: what is ready, what is not, and a first request to type in the chat: "open wikipedia and tell me today's featured article".
```

## Update

**The app.** Download it again. Replace ClawdTime in Applications.

**The command.** Run the same command again. It installs the newest release
next to the one that you have. Then it points `current` to it. Your settings
and keys stay. The release before stays on the Mac, so you can go back to it:

```sh
ln -sfh 0.4.0 ~/Library/Application\ Support/ClawdTime/runtime/current
```

When you run it again for the release that you have, it checks every file. It
removes a file that the release does not list. It installs the release again
when a file changed. It says what it did.

The installer does not install a release that is older than yours. It stops
and says so. To install an older release on purpose, run:

```sh
curl -fsSL https://www.clawdtime.com/install.sh | CLAWDTIME_ALLOW_DOWNGRADE=1 sh
```

macOS gives each build of the panel its own permissions. After an update, turn
on the two permissions again. The setup checks this.

## Uninstall

In the app, open Settings > General. Choose **Uninstall ClawdTime**. In
Terminal, run:

```sh
clawdtime uninstall
```

It lists what it moves and what it keeps, and asks first. Add `--yes` to skip
the question, or `--plan` to see the list and change nothing. It never uses
sudo.

1. It stops the connection, the desktop service and the panel. When the app
   runs the desktop, quit the app first, or uninstall from the app.
2. It unpairs this Mac from a shared phone number, when the Mac is paired and
   the number's service answers. When the service does not answer, the
   pairing stays in `~/.config/clawdtime/shared`, and nothing on the Mac uses
   it. To finish later, install again and run `clawdtime uninstall` while the
   Mac is online.
3. It moves these to the Trash. It deletes nothing:
   - the runtime, `~/Library/Application Support/ClawdTime`
   - the command, `~/.local/bin/clawdtime`, when it runs that runtime
   - the settings and keys, `~/.local/share/clawdtime` and
     `~/.config/clawdtime`, and the logs, `~/Library/Logs/ClawdTime`

To keep your settings and keys for a later install, add `--keep-settings`.

It keeps these where they are, and says so:

- records of actions whose result is not known or still open
- your project folder, such as `~/clawdtime-work`
- a source checkout, and a `clawdtime` command that runs one
- the app, `ClawdTime.app`: uninstall it from its own Settings, which also
  removes its login item

## Build from the source

Use the source build for development, and for phone calls on a Chert line
(preview). Add `--source`:

```sh
curl -fsSL https://www.clawdtime.com/install.sh | sh -s -- --source
```

In a checkout, run `sh scripts/install.sh --source`. The source build needs
Node 24 or later, Git, and Swift 6 or later (the Xcode command line tools). It
checks each one and says how to get what is missing. It puts ClawdTime in
`~/clawdtime`, builds it, and adds the `clawdtime` and `chert` commands. Then:

1. **Connect a line.** Run `clawdtime connect`. It signs you in to Chert in the
   browser and gets you a line, one step at a time.
2. **Add a model key** and **give the panel its permissions** as in "Set it up
   by hand". The panel of a source build is
   `~/clawdtime/mac/.build/debug/ClawdTimeTaskPanel`.
3. **Start it.** Run `clawdtime computer on`, then `clawdtime start`. Then run
   `clawdtime connect` again, so that the desktop gets its calling policy.

To use a shared phone number with your own Mac, follow
[shared setup](docs/SHARED_NUMBER_SETUP.md). The full guide is
[INSTRUCTIONS.md](INSTRUCTIONS.md). The line in detail is in
[SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md).
