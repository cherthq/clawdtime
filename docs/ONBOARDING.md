# Onboarding

`clawdtime onboard` sets up ClawdTime on a Mac, step by step, and then opens
the chat. One setup engine runs the steps. Two interfaces drive it: the
terminal wizard and the JSON protocol, which the Mac app uses. Both run the
same operations.

The first run asks only for what you need to talk to ClawdTime on this Mac: a
model key (setup finds one when you have one), your yes to computer use, and
two permissions. Calls on your phone are a later step: `--phone`.

## The command

```sh
clawdtime onboard [--phone] [--local] [--coordinator HTTPS_ORIGIN] [--json] [--app]
```

| Option          | What it does                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--phone`       | Gets calls on your phone: verifies your phone, pairs this Mac and connects it. See [Routes](#routes). Not with `--local`.    |
| `--local`       | Takes the first run only, also on a Mac that is paired already.                                                              |
| `--coordinator` | The https origin of the shared number's coordinator, for example `https://coordinator.example`. Only the phone steps use it. |
| `--json`        | Speaks the protocol below on standard input and output.                                                                      |
| `--app`         | The Mac app drives setup and owns the desktop and the connection. It goes with `--json`. See [Owners](#owners).              |

Without `--json`, the command needs a terminal. When standard input is no
terminal, it opens `/dev/tty`. With no terminal at all, it prints
`Run clawdtime onboard in Terminal to finish setup.` and exits with code 3. It
never reads a key from a pipe.

The terminal wizard reads the terminal only while a question is open. Before
each question it drops everything typed so far, so a yes typed twice by
mistake never answers the next question. At a yes or no consent question,
Return alone means no.

SIGTERM, SIGINT (Ctrl+C outside a question) and SIGHUP stop setup as a cancel
does. A desktop start that runs then goes to its end, and setup ends the
desktop of that start before it leaves, in Terminal too. Setup never leaves a
desktop half started with no owner.

The desktop launcher holds `desktop-launch.lock` with a lock that the kernel
ends with its process. A launcher that is gone, also after a kill, never
blocks the next launch.

| Exit code | Meaning                                   |
| --------- | ----------------------------------------- |
| 0         | Setup is done.                            |
| 1         | The person stopped setup.                 |
| 2         | Setup ended, but a step is not ready.     |
| 3         | No terminal. Run the command in Terminal. |

Run the command again to continue. Each step checks the real state of the Mac
first. A step that is ready is checked again, not repeated.

## Routes

Each run takes the steps of one route, always in the fixed order of the step
ids. Only the steps of the run come as `pending`, and only they are in the
report.

| Route | When                                    | Steps                                                                            |
| ----- | --------------------------------------- | -------------------------------------------------------------------------------- |
| First | `clawdtime onboard`, or with `--local`  | `preflight`, `model`, `desktop`, `computer`, `permissions`, `ready`              |
| Phone | `clawdtime onboard --phone`             | `preflight`, `desktop`, `permissions`, `phone`, `pairing`, `connection`, `ready` |
| All   | A rerun on a Mac that is paired already | Every step, so that the Mac stays connected as before                            |

The first run reads no coordinator and sends no text. In the Mac app, the
phone route is **Get calls on your phone**: a button on the last screen and in
the status window, and an item of the app's menu bar menu.

## The end of setup

A first run that is ready opens the conversation. The chat opens with the keys,
and it offers one first request. The request pays, deletes and sends nothing:

- With computer use on: `Open Calculator and calculate 15 percent of 240.`
- With computer use off: `What can you do on this Mac?`

A click on the request sends it. Nothing is sent by itself.

- **Terminal.** The `desktop` step starts the panel tucked, so the person can
  answer setup. When setup ends ready, it runs `clawdtime start --chat`. A
  panel that is open already opens its chat. The `ready` line says `Try:` and
  the request.
- **The Mac app.** The last screen has **Start talking**. It starts the
  desktop with `clawdtime start --chat --foreground`, so the panel opens with
  the chat. When the app runs the desktop already, the button is **Done**. A
  quiet check at a later launch opens no chat.

## The coordinator

Only the phone steps use a coordinator. Setup takes its origin from the first
of these that is set:

1. The `--coordinator` option.
2. The `CLAWDTIME_COORDINATOR` variable.
3. The `coordinator` field of `release.json` in the package root.

Setup never guesses an origin. It uses only an `https:` origin with no path,
query, name or password. It reads `GET /health` once. It uses the coordinator
only when the answer has `"service": "shared-number"`, a `protocol` that this
release speaks (today `1`), and a mode other than `standby`.

In every other case setup runs in local mode and says why: no coordinator is
set, the origin is not https, the coordinator did not answer, it is in
standby, or its protocol is older or newer. Local use works with no
coordinator. Run `clawdtime onboard --phone` again later to pair a phone.

## The steps

The step ids and their order are fixed.

| Id            | What it does                                                                                                                                                                                                                                                                                                                                                                  | Skip |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `preflight`   | Checks macOS 14 or later, Apple silicon and the installed panel. In the phone and all routes, also the coordinator's `/health` and protocol.                                                                                                                                                                                                                                  | yes  |
| `model`       | Uses a key that is set already. Then a key in the shell settings, with no question (see [Keys that setup finds](#keys-that-setup-finds)). Otherwise it asks for the provider (OpenAI is the default), then the key with hidden entry. It checks the key with the provider and stores it in the protected key store of `clawdtime keys`.                                       | yes  |
| `desktop`     | Uses a desktop that runs already, with its project and its work. Otherwise it starts the desktop as `clawdtime start` does, and waits for its authenticated readiness check.                                                                                                                                                                                                  | yes  |
| `computer`    | Asks for consent to computer use, then turns on the switch of `clawdtime computer on`. A no keeps it off. A desktop that started before the yes starts again while it is idle, so that it uses computer use now.                                                                                                                                                              | yes  |
| `permissions` | Reads Accessibility and Screen Recording of the exact installed panel, and Screen Recording of the capture helper in shared mode. It names each list of System Settings and each binary as the person sees them there, offers the System Settings pane, and checks again. With `--json` it also checks again by itself every 2 seconds, and goes on when the switches are on. | yes  |
| `phone`       | Asks for the person's own number, then a yes. Only after the yes does the coordinator text one sign-in code. Then it asks for the code. A paired Mac sends no text.                                                                                                                                                                                                           | yes  |
| `pairing`     | Asks for the display, then separate answers for view, computer actions and reports, then a final yes. It reuses a valid pairing. It replaces another Mac only on the person's explicit choice.                                                                                                                                                                                | yes  |
| `connection`  | Starts one shared connection in the background, bound to the running desktop. It reuses a connection of the same desktop. A connection of an earlier desktop ends first. With `--app` it starts none: see [Owners](#owners).                                                                                                                                                  | yes  |
| `ready`       | One readiness report. It never places a call or sends a text. In Terminal, a first run that is ready opens the chat.                                                                                                                                                                                                                                                          | no   |

When the coordinator is not used, `phone`, `pairing` and `connection` are
skipped. With computer use off in local mode, `permissions` is skipped too. In
the phone route, the computer switch says whether `permissions` checks the
panel too.

## Keys that setup finds

The Mac app starts from Finder, with no shell variables. So a key that you
exported in Terminal is not in its environment. Before it asks, the `model`
step reads the shell startup files of the person as text. It runs no shell.

- zsh: `.zshenv`, `.zprofile`, `.zshrc` (in `ZDOTDIR` when it is set). bash:
  `.bash_profile`, `.bashrc`, `.profile`. The shell comes from `SHELL`.
- Only a plain assignment of a key variable of an offered provider counts,
  such as `export OPENAI_API_KEY=...`, with or without quotes. A later
  assignment wins, as in the shell. An empty value clears it.
- A value with `$`, a backtick or a backslash is left alone: it needs a shell.
- Only a regular file of this user, 256 KiB or smaller, is read.
- The provider checks the key first. A refused key is not used, and setup
  asks. A key that is used goes to the protected key store, as a pasted key
  does. The report says
  `ClawdTime found your OpenAI key in your shell settings.` The key and the
  file never show in an event or a log.

## Skip

Nobody is stuck at setup. Every step but `ready` can be skipped: at a
question, at a failure, and while the desktop starts.

- A skip is never a yes. At a consent question it means no, and grants
  nothing: no text, no pairing, no connection, computer use off.
- A skipped step says in one line what does not work and the command that
  finishes it, for example
  `No model key is stored, so ClawdTime cannot plan or chat yet. To add one later, run clawdtime onboard, or clawdtime keys set PROVIDER.`
  A phone step names `clawdtime onboard --phone`.
- A skip of the desktop while it starts lets that start end, then ends the
  desktop that it made. No process is left.
- `clawdtime onboard` asks a skipped step again on the next run.
- The report lists each skipped step with its line, and the `ready` row
  names the steps that the person skipped. It is not a failure. `ready` is
  false only when ClawdTime cannot work: the check, the model key or the
  desktop was skipped. Then the `ready` row is `skipped` and the exit code
  is 2. In the phone route, `ready` is false also when calls from the phone
  cannot reach the Mac: the phone, the pairing or the connection is not
  ready.
- In Terminal, type `skip` (or `s`) at any prompt. Each prompt says
  `Type skip to do this later`.
- In the app, **Skip for now** is on every step screen.

## When the desktop does not start

The `desktop` step says why, in plain words, and offers the recovery that
fits. Its details name the desktop folder and the service log. The service
writes its output to `desktop-start.log` in the desktop folder, for its owner
only, with keys, tokens, phone numbers and email addresses masked. A log over
256 KiB moves to `desktop-start.log.1` at the next start.

- **ClawdTime runs from another install.** Its desktop holds the port of
  this desktop (13326 unless an earlier start chose another). Setup asks:
  **Use the running ClawdTime**, **Stop it and try again**, or **Try again**.
  Use saves the folder of that desktop in `desktop-link.json` in the state
  folder, so every command of this install uses it. Stop ends it only when
  the owner lock and the descriptor of its folder name its process and the
  port, and never while its app or a foreground Terminal holds it. When its
  own files do not confirm it, setup offers only Try again.
- **Another program holds the port.** A desktop with no explicit `--port`
  moves to the next free port after 13326, keeps it in `desktop-port.json`,
  and keeps its identity. With an explicit port the step says which program
  holds it.
- **The task session expired.** It lasts 24 hours. A start after that renews
  it with the same identity while no task, call or voice is open, and the log
  says so. While one is open, nothing is changed, and the details give the
  command that moves the desktop folder aside to start a new one.
- **Any other stop.** The step names what the service said, with its paths
  in the details.

## Owners

The desktop and the shared connection run long after setup. Each has one
owner.

- **Terminal.** Setup starts the desktop with its panel, as `clawdtime start`
  does, and one `clawdtime shared run` in the background. Both keep running
  after setup ends.
- **The Mac app.** The app passes `--app`. Setup starts the desktop service
  with no panel, so that it can check it, and starts no connection. The
  `connection` step asks the person, then reports ready with
  `ClawdTime connects this Mac to the shared number when setup ends.` When
  setup ends, the app runs `clawdtime start --chat --foreground` (Start
  talking) or `clawdtime start --tucked true --foreground` (a quiet check at a
  later launch). It takes over the running service and opens the panel, and
  then runs `clawdtime shared run`. When the app runs the desktop already, a
  connection that the phone route made ready starts beside it. A background
  connection that Terminal setup started ends first. When the person stops
  setup in the app, setup ends the desktop that it started.
- **A no to the connection.** In Terminal and in the app, a no (or a skip)
  ends a background connection that Terminal setup started, after the same
  check of its process. The report then says that it ended. When it does not
  stop, the step fails with Try again, and a skip reports that it still runs.

One connection runs on a Mac at a time. `clawdtime shared run` holds a lock
(`~/.config/clawdtime/shared/connection.lock`) for its whole life, and a
second one stops at once with
`Another clawdtime shared run connects this Mac already.` The kernel ends the
lock with its process, so a crash leaves no stale lock. Setup never starts a
connection next to the one that holds the lock: it uses a connection of the
running desktop, and it stops with a recovery when the holder serves an
earlier desktop.

## The protocol

With `--json`, the engine writes one JSON object per line on standard output.
Nothing else goes to standard output. Human logs go to standard error. The
interface writes one command per line on standard input. The end of standard
input is a cancel.

A cancel, or the end of standard input, stops setup before its next effect,
at any step: while it checks the Mac or a key, starts the desktop, or waits
for an answer. Setup checks for it before each effect (a key check, the key
store, a desktop start or restart, the computer switch, a sign-in text, a
code check, a pairing request, a connection start or stop), not only at a
question. A command that came before the cancel and is not used yet is
dropped. Only an outcome that an effect returned already is still saved, for
example a pairing that the coordinator made.

### Events

```json
{"type":"hello","protocol":2,"version":"0.4.0"}
{"type":"step","id":"model","state":"needs_input","title":"Model key","detail":"Paste your OpenAI API key. It is not shown.","question":"Wm3dQ0sJ9xVfK2aT","input":{"kind":"secret","prompt":"OpenAI API key"}}
{"type":"log","level":"info","message":"The desktop runs already. It reads the new key the next time it starts."}
{"type":"done","ready":true,"report":[{"id":"model","state":"ready","detail":"A key for OpenAI is in the protected key store."}]}
```

- `hello` comes first. Then each step comes once as `pending`, in order.
- `step` has `state`: `pending`, `in_progress`, `needs_input`, `ready`,
  `failed` or `skipped`. It may have a `detail`, `details`, a `recovery` and
  an `input`. The `detail` is plain words with no file path. `details` holds
  lines that an interface shows only when the person asks, such as the full
  path of each binary that needs a permission.
- `recovery` has a `label` and an `action`: `retry`, `open_settings` or
  `open_url`, with a `url` for the last two. The interface opens the URL. The
  key question offers the page where the provider makes keys, for example
  `Get a key from OpenAI`. The terminal prints its address.
- `question` is the one-time id of the question that the step asks. A
  `needs_input` step has one. A `failed` step that waits for a retry or a skip
  has one too. An `in_progress` step has one while it may be skipped (the
  desktop start): its only answer is a skip. Each question has a new id, also
  when the same question comes again.
- `input` has a `kind`: `secret`, `text`, `choice`, `confirm`, `phone` or
  `code`, a `prompt`, and for a choice its `options`, each with an `id`, a
  `label` and an optional `detail`. A choice may have a `default`: the option
  that an interface shows chosen, so that Return takes it. `consent: true`
  marks a question whose answer gives or refuses consent: computer use, a
  sign-in text, view, computer actions, reports, the pairing, a replacement
  and the connection. Such a question never has a `default`, and an interface
  gives it no default answer.
- `done` comes last, with `ready` and one report row for each step. With
  `--app` it has `setupDesktop`: true while a desktop service that setup
  started runs and no owner holds it. A cancelled run with `--app` ends that
  service, also when an earlier run started it.

### Commands

```json
{"type":"input","id":"model","question":"Wm3dQ0sJ9xVfK2aT","value":"..."}
{"type":"action","id":"permissions","question":"pR7cLw0eYb4nHs1M","action":"recheck"}
{"type":"cancel"}
```

- `input` answers the question that is open. The value is a string, a
  boolean for `confirm`, or an array of option ids for a choice with
  `multiple`.
- `action` is `retry`, `recheck` or `skip`. Every step but `ready` accepts
  `skip`.
- Every `input` and `action` names the `question` it answers. A command for
  an earlier question, a repeated answer, an unknown id or no id is ignored
  with a warning and has no effect. So a double click or a second Return
  never answers the next question.
- Each question takes one answer. When the answer cannot be used (a value
  that does not fit, or a skip that the step refuses), the step asks again
  with a new id.
- A command for another step is ignored with a warning. A line that is not a
  command is ignored with a fixed warning that never quotes the line.
- The terminal wizard uses the same ids.

### What each question waits for

| Step and state                        | Answer                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Any step, `failed`                    | `action` `retry`, or `skip` where the step accepts it                  |
| `permissions`, `needs_input`          | Open the `recovery` URL, then `action` `recheck` or `input` `true`     | yes |
| `phone`, `confirm` to send a code     | `input` `true` sends one text. `false` sends nothing and skips         |
| `phone`, `code`                       | `input` with the digits. `action` `retry` asks for a new code          |
| `pairing`, choice for a paired number | `replace` pairs this Mac in place of the other. `keep` changes nothing |

## Secrets

- A secret input goes only to the provider's key check and the protected key
  store. It never appears in an event, a log, an argument or a file. A key
  that setup finds in the shell settings takes the same path.
- A phone number goes only to the coordinator. A sign-in code goes only to
  the coordinator. Neither appears in an event or a log.
- The device credential goes only to the owner-only pairing file.
- An error from an operation reaches the interface only as a fixed sentence.

## Recovery

- **Expired code.** The step fails with `Send a new code`. A retry asks for a
  new yes before the next text.
- **Wrong code.** The step asks again. After five tries it asks for a new code.
- **Denied permission.** The step says what the person sees in System
  Settings: open Privacy & Security, then the list (Accessibility, and Screen
  & System Audio Recording, or Screen Recording on macOS 14), then the name
  of each binary in it (`ClawdTimeTaskPanel`, `ClawdTimeTaskCapture`). The
  full path of each binary is in `details`. The step checks again after the
  person acts.
- **Coordinator unavailable or older.** Setup runs in local mode.
- **Number already paired.** The step shows what a replacement does: the
  other Mac loses access at once, its open call ends, and its tasks get no
  callback. Nothing is replaced without the choice.
- **Lost pairing answer.** The step fails and says the Mac may be paired. A
  retry asks for a new invitation, and a pairing that exists then needs the
  person's choice before it is replaced. No uncertain request is repeated.

## Files

Setup writes only what its steps make:

| File                                                 | Step                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `~/.local/share/clawdtime/computer/keys.json`        | `model`                                                                                    |
| `~/.local/share/clawdtime/computer/model.json`       | `model`, only when the chosen provider would not plan by default                           |
| `~/.local/share/clawdtime/computer/config.json`      | `computer`                                                                                 |
| `~/.config/clawdtime/shared/connection.json`         | `pairing`                                                                                  |
| `~/.config/clawdtime/shared/onboard-connection.json` | `connection`, the process, its start and command, and the desktop it serves, no credential |
| `~/.config/clawdtime/shared/onboard-desktop.json`    | `desktop`, the desktop service that setup started, its start and command, no credential    |
| `~/.config/clawdtime/shared/connection.log`          | `connection`, the output of the connection                                                 |
| `~/.config/clawdtime/shared/connection.lock`         | `clawdtime shared run`, the process that holds the one connection                          |

Every file is for its owner only. `CLAWDTIME_CONFIG_HOME` moves the first
three.

The pairing saves the path of the capture helper. In an installed release it
goes through the `current` link of the runtime folder, for example
`~/Library/Application Support/ClawdTime/runtime/current/app/native/ClawdTimeTaskCapture`,
so the pairing still works after an update removes the version that setup
ran from.

A process id comes back after its process ends, so a saved id alone never
gets a signal. Setup stops the connection only when `ps` shows the start time
and the command that it saved when the connection started. A record of a
process that has ended, or of an earlier release, is cleared with no signal.
Setup stops the desktop service only when its process began before the
service wrote its owner lock and runs the task server. Otherwise it sends no
signal and leaves the lock.

## Limits

- The desktop builds its computer worker when it starts. When computer use is
  on and the running desktop has no worker, the `computer` step stops the
  desktop service and starts it again, in both routes. It does so only while
  the desktop is idle: no task runs, no action is unresolved and no shared
  connection serves it. An open panel stays open and finds the new service.
  A busy desktop keeps running, and the step says that it uses computer use
  from its next start.
- Shared calls have passed automated checks only. The coordinator's `/health`
  reports `physicalAcceptance: false`.
