# ClawdTime Mac app

ClawdTime.app is the downloadable route of the guided setup. You download a
DMG, drag ClawdTime to Applications and open it. A native window takes you
through setup, step by step. No Terminal, Node, Git or Xcode is needed: the
app carries its own runtime.

Requirements: macOS 14 or later on a Mac with Apple silicon.

## Use the app

1. Open the DMG and drag ClawdTime to Applications.
2. Open ClawdTime from Applications.
3. Choose **Set up ClawdTime**. Each screen shows one step: its title, what it
   needs and why, and one field or choice.
4. Answer the step and choose **Continue**. A key goes in a secure field.
5. When a step needs a macOS permission, the screen names the list in
   System Settings, Privacy & Security, and the item to turn on in it.
   Choose **Open System Settings**, turn the item on, and come back. The app
   checks the step again when you return. **Check again** does the same.
   **Details** shows the full path of each item, when you need it.
6. **Skip for now** is on every step, also while the desktop starts. A skip
   is never a yes. Setup goes on, and the last screen says what each skipped
   step leaves undone and how to finish it. Run setup again to come back to
   it.
7. The last screen shows what is ready. Choose **Finish**.

**Stop** is at the top of the window from the first screen, before anything
can reach the Mac from outside. It ends setup and every process that
ClawdTime started. Nothing is shared after Stop. Stop stays available on the
last screen while the desktop that setup started runs and Finish has not
taken it over. Stop and Quit then end it, also after a second setup run.

ClawdTime has one item in the menu bar at a time. From the first launch, and
whenever the desktop does not run, it is the item of the app:

- **Open ClawdTime** shows the window with the readiness of each step.
- **Settings…** opens the Settings window. See [Settings](#settings).
- The status line says what runs: the desktop, and the phone connection.
- **Stop** ends setup, the connection and then the desktop. **Start** starts
  them again. Before setup is done, **Start** runs setup in its window.
  Nothing starts again by itself.
- **Quit ClawdTime** stops both and then quits.

After setup, while the desktop runs, the mascot's item takes its place. It
keeps all of its own rows, and adds **Settings…** (Command-comma) and **Stop
ClawdTime**, which open in the app. When the desktop stops, or you quit the
mascot while its work runs on, the item of the app comes back.

**Open ClawdTime when you log in** is off until you turn it on in the
readiness view. macOS may ask you to allow it in System Settings, Login Items.

The next time you open ClawdTime, it checks each step again without a window.
It shows the window only when a step needs you. A step that is ready is
checked again, not asked again.

The logs of the desktop and the connection are in `~/Library/Logs/ClawdTime/`.

## Settings

Open the Settings window in one of three ways: the gear at the top right of
the setup window, **Settings…** in the menu bar menu (of the app or of the
mascot), or Command-comma. The sections are on the left:

- **General**: the style and the size of the mascot, the eye on Flint, the
  pace of the cursor, **Open ClawdTime when you log in**, the keys to talk
  and chat, **Run setup again** and **Stop**.
- **Assistant**: **Speak replies**, the voice, the speaking speed, the names
  that speech to text must hear right, memory with **Forget everything**, and
  **Away: answer by phone**.
- **Models**: **Speed** (Fast, Balanced or Best), the model keys, and under
  **Advanced** the planner model and the chat model.
- **Computer use**: computer use on or off, **Ask before acting** (before
  risky actions, or never), and the browser.
- **Permissions**: Accessibility and Screen Recording of the panel and the
  capture helper. The page checks again every few seconds while it is open.
  A red dot on the section says that a permission is off.
- **Phone**: whether this Mac is paired, **Pair this Mac** or **Unpair…**,
  the end of your number, and the calls and texts when a question waits.
- **Privacy**: what ClawdTime keeps on this Mac, how much and where,
  **Open the folder**, and **Delete history…**.
- **About**: the versions of the app and its runtime, **Check now** for a
  newer release, and **Uninstall…**.

Use the keyboard:

- Up and Down move through the sections. Command-1 to Command-8 open one.
- Command-F goes to the search field. Type a word, such as "voice" or
  "unpair". Return opens the first result. Escape clears the search.
- Tab moves through the controls of a section.

A change of the mascot, of the speaking speed, of **Speak replies**, of
memory, of away and of turning computer use off works at once. Other changes
work when the desktop starts again. The window then says so. The desktop
starts again by itself only while it is idle: no task runs and the phone
connection is off. Otherwise the window shows **Restart now**, and the
desktop keeps running until you choose it. A desktop that is not running uses
the change when it starts.

A setting with a lock is set in the environment of the desktop service, for
example `CLAWDTIME_COMPUTER_BROWSER`. The variable wins over a choice here.
Change it where it is set.

**Speed** picks a planner model and a chat model from the tests of
ClawdTime. Each preset shows what the tests measured. Best is the default.
With an Anthropic key alone there are two presets, Fast and Best. A provider
that the tests did not measure has no preset: choose its models in
**Advanced**. A change in **Advanced** shows Speed as Custom.

## Uninstall

Open Settings, About, and choose **Uninstall…**. A sheet lists
what goes to the Trash and what stays. Check **Keep my settings and keys** to
keep your settings and model keys for a later install. Then choose
**Uninstall**. ClawdTime:

1. Stops setup, the phone connection and the desktop.
2. Unpairs this Mac from the shared number, when it is paired and the
   coordinator answers. When it does not answer, the pairing stays, and the
   sheet says how to finish.
3. Moves the runtime, the `clawdtime` command and, unless you keep them, the
   settings to the Trash. It deletes nothing. Receipts of actions whose
   outcome is unknown or pending stay where they are, and the sheet names
   them. Your project folder stays.
4. Takes out its login item.

The sheet shows the result. Choose **Move ClawdTime to the Trash and Quit**:
the app moves itself to the Trash and quits. To get it back, put it back from
the Trash. Your files stay in the Trash until you empty it.

## How the app works

### The bundle

```text
ClawdTime.app/Contents/
  Info.plist                 com.clawdtime.app, arm64, macOS 14.0 or later, the clawdtime: link scheme
  MacOS/ClawdTime            the SwiftUI app
  Resources/AppIcon.icns     from mac/Resources/AppIcon.icns, when it exists
  Resources/runtime/         the release runtime, exactly as the runtime builder makes it
```

The source is in `mac/Sources/ClawdTimeApp` (the window, the menu bar and the
app delegate) and `mac/Sources/ClawdTimeAppCore` (the protocol, the setup
state, the engine process, the runtime checks and the process owner). The tests
are in `mac/Tests/ClawdTimeAppTests`.

### Setup: the engine protocol

The app starts `Resources/runtime/bin/clawdtime onboard --json --app` and
speaks the setup protocol with it: one JSON object per line, events on the
engine's stdout and commands on its stdin. `--app` tells setup that the app
owns the desktop and the connection: setup checks the desktop service with no
panel, and starts no background connection.

- The app sends every answer on stdin. A key never goes on a command line, in
  the environment, in a file or in a log. A command prints as
  `input(model, <redacted>)`.
- `hello` must say protocol 2. Another protocol stops setup before any step.
  With no `hello` in 30 seconds, setup stops with a Try again button.
- The window shows the latest step that is not `pending`. Steps the app does
  not know are drawn from their event, after the known ones.
- Each question is a screen of its own, keyed by its `question` id. Every
  answer names that id. The buttons of a new question work 0.6 seconds after
  it appears, or longer with a slow double-click setting in macOS, so the
  second click of a double click never answers the next question. After one
  answer they stay disabled until the engine asks the next question.
- A consent question (computer use, a sign-in text, view, computer actions,
  reports, the pairing, a replacement, the connection) has no default
  button: Return does not answer it.
- The app offers a quiet **Skip for now** on every step but `ready`, while
  the engine reads a skip: at a question, at a failure, and on a step in
  progress that has a `question` id (the desktop start). The report marks
  each skipped step and shows its line.
- A recovery may open only a System Settings pane (`x-apple.systempreferences:`)
  or an `https` page. The app refuses any other link.
- A line that is not protocol JSON is counted and ignored. A line over 1 MB is
  dropped.
- If the engine ends before `done`, the window shows the last lines of its
  stderr and a Try again button. Stop sends `cancel` and closes stdin. Setup
  stops before its next effect as soon as it reads the cancel, also in the
  middle of a step. A desktop start that runs then goes to its end, and setup
  ends the desktop of that start before it leaves. The engine takes SIGTERM
  as a cancel too. The app sends SIGTERM only after 20 seconds and SIGKILL
  after 40 seconds, so that a slow first start never leaves a desktop with no
  owner. Quit and a new setup run wait until the engine has left.

### The desktop that setup starts

Setup starts the desktop service with no panel, so that it can check it.
Until **Finish** hands it to the owner, nothing else owns it:

- `done` has `"setupDesktop": true` while that service runs with no owner.
  An engine that leaves before `done` may have left one too.
- Stop or Quit then starts the engine and cancels it at once. With `--app`,
  a cancelled engine ends the desktop service that an app setup started, in
  this run or an earlier one, and only that one: setup remembers its process
  when it starts it, and checks the start time and the command before the
  signal. A desktop that the person started, or that a foreground owner
  holds, is never ended.
- **Finish** starts the owner, which takes the service over.

### After setup: one owner

The app is the one owner of the long-lived processes. **Finish** starts what
the final report says is ready:

| Process    | Command                                      | Starts when                                                  |
| ---------- | -------------------------------------------- | ------------------------------------------------------------ |
| Desktop    | `clawdtime start --tucked true --foreground` | `desktop` is ready                                           |
| Connection | `clawdtime shared run --owned`               | the desktop prints its ready line, and `connection` is ready |

- Each process starts in its own process group, with stdin from `/dev/null`.
- `clawdtime start --foreground` takes over the desktop service that setup
  started (or starts one), opens the panel in its own process group, and
  stays. It prints `{"type":"ready"}` on stdout when the service answers its
  authenticated readiness check, then only the panel line below. On SIGTERM it
  closes the panel and sends SIGTERM to the service, which closes its calls
  and its work. When the service ends by itself, it closes the panel and exits
  with status 1. When the app is gone, it stops the desktop too. One
  foreground owner holds a desktop at a time.
- The desktop counts as running when it prints `{"type":"ready"}` on stdout.
  With no ready line in 120 seconds, the app ends it and starts no connection.
- When the panel closes while the service runs on, `start --foreground`
  prints `{"type":"panel","state":"closed"}` on stdout. A panel that a stop
  closes is not reported.
- Stop and Quit send SIGTERM to the connection, then to the desktop. A process
  still there after 10 seconds gets SIGKILL with its whole group.
- When the desktop ends, the app ends the connection too: a connection belongs
  to one desktop lifetime.
- With `--owned`, the connection checks its parent. When the app is gone,
  also after a crash, it disconnects, frees the connection lock and leaves,
  as `clawdtime start --foreground` does. A connection that Terminal setup
  starts has no `--owned`: it keeps running after setup ends.
- Nothing restarts by itself. The menu says what ended, and Start is your
  choice.
- Sleep changes nothing in the app. The connection keeps its own rules for a
  lost network.

### One menu bar item

- The app starts the desktop with `CLAWDTIME_APP_BUNDLE` set to its own
  bundle. `clawdtime start --foreground` gives it to the panel alone, not to
  the service or the connection. With it, the panel adds **Settings…** and
  **Stop ClawdTime** to its menu. Only an absolute path to an `.app` bundle
  counts. A desktop started from Terminal or a source checkout has no such
  variable, and its panel menu has no Settings row.
- The app shows its own item unless setup is done, the desktop runs, its
  panel is open (from the ready line until the panel line), and the panel has
  the app's rows. It removes the item then, and adds it again as soon as one
  of these changes.
- The app answers three links: `clawdtime://open` (the setup window),
  `clawdtime://settings` (the Settings window) and `clawdtime://stop` (the
  same Stop as in its menu). The panel opens them in the app at
  `CLAWDTIME_APP_BUNDLE`, not in another copy. A link with a path, a query or
  another name does nothing. No link starts anything or changes a setting.

### Settings: the runtime commands

The Settings window reads and changes settings only through the runtime's own
commands and its two helpers. It reads their JSON, and it edits no file
itself:

| Section       | Reads                                                                                         | Changes                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every section | `clawdtime settings --json`                                                                   | `clawdtime settings set NAME VALUE --json`, `clawdtime settings reset NAME --json`                                                                                              |
| Assistant     | the same                                                                                      | `clawdtime settings forget-memory --yes --json`                                                                                                                                 |
| Models        | `clawdtime keys list --json`, `clawdtime computer model --json`                               | `clawdtime keys set PROVIDER` (the key on stdin), `clawdtime keys remove PROVIDER`, `clawdtime computer model PROVIDER/MODEL [--base-url URL]`, `clawdtime computer model auto` |
| Permissions   | `app/native/ClawdTimeTaskPanel --check-access`, `app/native/ClawdTimeTaskCapture --preflight` | nothing: **Open System Settings** opens `x-apple.systempreferences:` on the right list                                                                                          |
| Phone         | `clawdtime settings phone --json`                                                             | `clawdtime settings phone unpair --yes --json`, after the app ended the phone connection                                                                                        |
| Privacy       | `clawdtime settings privacy --json`                                                           | `clawdtime settings delete-history --yes --json`                                                                                                                                |
| About         | `clawdtime settings update --json`, only when you choose **Check now**                        | `clawdtime uninstall --yes [--keep-settings]`, after the app stopped what it owns                                                                                               |

`clawdtime settings` keeps each setting where its part reads it:

- Memory, away and computer use keep their own files in the state folder.
  The service reads them on each use.
- The mascot, **Speak replies** and the speaking speed are preferences of the
  panel. The runtime writes them with `defaults` into the panel's domain
  (`ClawdTimeTaskPanel`) and posts the Darwin notice
  `com.clawdtime.panel.settings`. A running panel reads them again at once.
- The planner model stays in `computer/model.json`.
- Every other setting goes to `settings.json` in the state folder, for its
  owner only. `clawdtime start` gives these to the service as the variables
  that it reads (`CLAWDTIME_VOICE`, `CLAWDTIME_COMPUTER_TRUST`, and the
  others). A variable that is set already wins. A damaged `settings.json` is
  never written over, and `start` reads past it.

Each answer of `settings set` says `applies`: `now`, or `restart` when the
desktop reads it at its start. After a `restart` change, the app reads
`clawdtime computer doctor --json`. It starts the desktop again, with its
connection as it was, only when the service answers, takes new work and runs
none, and the phone connection is off: the same rule as setup.

- A key goes to `clawdtime keys set PROVIDER` on stdin, and nowhere else: not
  in an argument, the environment, a file or a log. The field lets go of the
  key as soon as it is sent.
- No report of `clawdtime settings` holds a key, a device credential or a
  whole phone number. The phone report gives only the end of the number.
- The app checks a setting's name against the list, a choice against its
  choices, and refuses text that looks like a key, starts with a dash or
  holds a line break, before anything runs.
- A failed command shows its last line of stderr, a fixed sentence of the
  runtime. A line that holds the key is never shown.
- **Download** opens the release page only when it is an `https` address.
  **Open the folder** opens only the state folder or the folder of the logs.
- The permission checks ask macOS with no prompt. A helper that is not in the
  runtime shows **Not found**.

### The self-test

`ClawdTime.app/Contents/MacOS/ClawdTime --self-test` checks the app with no
window. It checks the runtime layout and manifest, hashes every file the
manifest lists, starts the engine, waits for `hello`, sends `cancel` and waits
for the engine to leave. It prints one JSON line and exits 0 when all of it
passes. `--runtime PATH` checks another runtime folder.

The self-test runs on every build, often from a shell with a real home and a
model key. So the engine runs as `onboard --json --app --local` in a new
empty home, with its own temporary folder. It gets only `PATH`, `HOME` and
`TMPDIR`: no key, no coordinator and no ClawdTime setting of the shell.
It never contacts the coordinator and never starts a desktop. A home that is
not empty after the engine left fails the self-test. The temporary folders
are removed at the end.

Signing puts a signature inside each Mach-O file, so those files no longer
match the hashes of the unsigned runtime. The self-test counts them as
`filesSigned`: the code signature of the app covers them.

## Build and release

Build the runtime, then the app, then the DMG. Run these from the repository
root on a Mac with Apple silicon, Xcode command line tools and Swift 6:

```sh
scripts/release/build-runtime.sh --out build/release --coordinator https://coordinator.example
mac/scripts/package-app.sh --runtime build/release/runtime --out build/release
mac/scripts/sign-and-notarize.sh --app build/release/ClawdTime.app --out build/release
```

- `package-app.sh` checks the runtime (layout, the panel's font bundle next
  to the panel, manifest, every hash, and that every link is relative and
  stays inside it), builds the app in release mode,
  writes `Info.plist`, copies the runtime, signs ad hoc, checks the signature
  and runs the self-test. `CLAWDTIME_BUILD_NUMBER` sets `CFBundleVersion`.
- `sign-and-notarize.sh` signs every Mach-O file in the app, deepest first:
  Node, both helpers in `native/`, and every `.node` and `.dylib` file under
  `app/node_modules`. Then it signs the app. With both `CLAWDTIME_SIGN_IDENTITY` (a Developer ID
  Application identity) and `CLAWDTIME_NOTARY_PROFILE` (a profile from
  `xcrun notarytool store-credentials`), it signs with the hardened runtime
  and a timestamp, makes the DMG, signs it, notarizes it, staples the ticket,
  and checks a quarantined copy with Gatekeeper.
- Without both, it signs ad hoc and makes `ClawdTime-<version>-arm64-unsigned.dmg`.
  macOS blocks that file when it is downloaded. Use it for checks on the Mac
  that built it.
- `make-dmg.sh --app PATH --out DIR` makes the DMG alone: the app, an
  Applications link, and a `.sha256` file.

The signatures carry these entitlements: the app may use the microphone and
send Apple events for its children, Node may compile JavaScript
(`allow-jit`, `allow-unsigned-executable-memory`) and load the native addons
of its packages (`disable-library-validation`), and the panel may use the
microphone. No file gets `get-task-allow`. An ad hoc signature carries the
same entitlements, with no hardened runtime. After signing, the script checks
the entitlements of Node and that the panel's font bundle
(`app/native/*_ClawdTimeTaskPanel.bundle`) is still next to the panel.

Publish the notarized `ClawdTime-<version>-arm64.dmg` on the release, and the
same file as `ClawdTime-arm64.dmg` for the download button.

### Check the packaging without a runtime build

`mac/scripts/make-fake-runtime.sh --out DIR` makes a fake runtime with the same
layout. Its engine says hello and leaves on cancel. Node and the native helpers
are tiny arm64 programs, so signing reaches every nested executable.

```sh
mac/scripts/make-fake-runtime.sh --out mac/build/app-check/fake
mac/scripts/package-app.sh --runtime mac/build/app-check/fake/runtime --out mac/build/app-check/out
mac/scripts/sign-and-notarize.sh --app mac/build/app-check/out/ClawdTime.app --out mac/build/app-check/out
codesign --verify --deep --strict mac/build/app-check/out/ClawdTime.app
```

### Tests

```sh
(cd mac && swift test --filter ClawdTimeAppTests)
python3 -m unittest discover -s mac/scripts -p 'test_package_app.py'
```

The Swift tests run the protocol, the window state, the engine process against
fake engine scripts, the runtime checks, the self-test and the process owner
with real child processes. They build the views off screen: no window opens.
To look at every setup screen and every Settings section in light and dark
mode, draw them into a folder:

```sh
(cd mac && CLAWDTIME_APP_SHOTS=/tmp/clawdtime-shots swift test --filter 'SetupScreenshotTests|SettingsScreenshotTests')
```

The settings tests run against a fake runtime. They check the arguments and
the stdin of each command: the key is only ever on stdin.

The script tests package a stub app around a fake runtime and check the
refusals and the unsigned DMG. Tests are not a check of a real call, a real
permission prompt or a real install.
