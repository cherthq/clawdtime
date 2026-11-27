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
5. When a step needs a macOS permission, choose **Open System Settings**,
   allow ClawdTime there, and come back. The app checks the step again when
   you return. **Check again** does the same.
6. You can skip your phone, the pairing, the connection and computer use, and
   come back to them later. ClawdTime then works on this Mac only.
7. The last screen shows what is ready. Choose **Finish**.

**Stop** is at the top of the window from the first screen, before anything
can reach the Mac from outside. It ends setup and every process that
ClawdTime started. Nothing is shared after Stop.

After setup, ClawdTime lives in the menu bar:

- **Open ClawdTime** shows the window with the readiness of each step.
- The status line says what runs: the desktop, and the phone connection.
- **Stop** ends the connection first, then the desktop. **Start** starts them
  again. Nothing starts again by itself.
- **Quit ClawdTime** stops both and then quits.

**Open ClawdTime when you log in** is off until you turn it on in the
readiness view. macOS may ask you to allow it in System Settings, Login Items.

The next time you open ClawdTime, it checks each step again without a window.
It shows the window only when a step needs you. A step that is ready is
checked again, not asked again.

The logs of the desktop and the connection are in `~/Library/Logs/ClawdTime/`.

## How the app works

### The bundle

```text
ClawdTime.app/Contents/
  Info.plist                 com.clawdtime.app, arm64, macOS 14.0 or later
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
- `hello` must say protocol 1. Another protocol stops setup before any step.
  With no `hello` in 30 seconds, setup stops with a Try again button.
- The window shows the latest step that is not `pending`. Steps the app does
  not know are drawn from their event, after the known ones.
- The app offers **Skip for now** only on `phone`, `pairing`, `connection` and
  `computer`.
- A recovery may open only a System Settings pane (`x-apple.systempreferences:`)
  or an `https` page. The app refuses any other link.
- A line that is not protocol JSON is counted and ignored. A line over 1 MB is
  dropped.
- If the engine ends before `done`, the window shows the last lines of its
  stderr and a Try again button. Stop sends `cancel`, closes stdin, and ends
  the engine after 2 seconds if it is still there.

### After setup: one owner

The app is the one owner of the long-lived processes. **Finish** starts what
the final report says is ready:

| Process    | Command                                      | Starts when                                                  |
| ---------- | -------------------------------------------- | ------------------------------------------------------------ |
| Desktop    | `clawdtime start --tucked true --foreground` | `desktop` is ready                                           |
| Connection | `clawdtime shared run`                       | the desktop prints its ready line, and `connection` is ready |

- Each process starts in its own process group, with stdin from `/dev/null`.
- The desktop counts as running when it prints `{"type":"ready"}` on stdout.
  With no ready line in 120 seconds, the app ends it and starts no connection.
- Stop and Quit send SIGTERM to the connection, then to the desktop. A process
  still there after 10 seconds gets SIGKILL with its whole group.
- When the desktop ends, the app ends the connection too: a connection belongs
  to one desktop lifetime.
- Nothing restarts by itself. The menu says what ended, and Start is your
  choice.
- Sleep changes nothing in the app. The connection keeps its own rules for a
  lost network.

### The self-test

`ClawdTime.app/Contents/MacOS/ClawdTime --self-test` checks the app with no
window. It checks the runtime layout and manifest, hashes every file the
manifest lists, starts the engine, waits for `hello`, sends `cancel` and waits
for the engine to leave. It prints one JSON line and exits 0 when all of it
passes. `--runtime PATH` checks another runtime folder.

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
The script tests package a stub app around a fake runtime and check the
refusals and the unsigned DMG. Tests are not a check of a real call, a real
permission prompt or a real install.
