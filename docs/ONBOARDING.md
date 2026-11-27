# Onboarding

`clawdtime onboard` sets up ClawdTime on a Mac, step by step. One setup engine
runs the steps. Two interfaces drive it: the terminal wizard and the JSON
protocol, which the Mac app uses. Both run the same operations.

## The command

```sh
clawdtime onboard [--local] [--coordinator HTTPS_ORIGIN] [--json] [--app]
```

| Option          | What it does                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `--local`       | Sets up this Mac alone. The phone, pairing and connection steps are skipped.                                    |
| `--coordinator` | The https origin of the shared number's coordinator, for example `https://coordinator.example`.                 |
| `--json`        | Speaks the protocol below on standard input and output.                                                         |
| `--app`         | The Mac app drives setup and owns the desktop and the connection. It goes with `--json`. See [Owners](#owners). |

Without `--json`, the command needs a terminal. When standard input is no
terminal, it opens `/dev/tty`. With no terminal at all, it prints
`Run clawdtime onboard in Terminal to finish setup.` and exits with code 3. It
never reads a key from a pipe.

| Exit code | Meaning                                   |
| --------- | ----------------------------------------- |
| 0         | Setup is done.                            |
| 1         | The person stopped setup.                 |
| 2         | Setup ended, but a step is not ready.     |
| 3         | No terminal. Run the command in Terminal. |

Run the command again to continue. Each step checks the real state of the Mac
first. A step that is ready is checked again, not repeated.

## The coordinator

Setup takes the coordinator origin from the first of these that is set:

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
coordinator. Run the command again later to pair a phone.

## The steps

The step ids and their order are fixed.

| Id            | What it does                                                                                                                                                                                                                 | Skip |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `preflight`   | Checks macOS 14 or later, Apple silicon, the installed panel, and the coordinator's `/health` and protocol.                                                                                                                  | no   |
| `model`       | Uses a key that is set already. Otherwise it asks for the provider, then the key with hidden entry. It checks the key with the provider and stores it in the protected key store of `clawdtime keys`.                        | no   |
| `desktop`     | Uses a desktop that runs already, with its project and its work. Otherwise it starts the desktop as `clawdtime start` does, and waits for its authenticated readiness check.                                                 | no   |
| `computer`    | Asks for consent to computer use, then turns on the switch of `clawdtime computer on`. A no keeps it off. A desktop that started before the yes starts again while it is idle, so that it uses computer use now.             | yes  |
| `permissions` | Reads Accessibility and Screen Recording of the exact installed panel, and Screen Recording of the capture helper in shared mode. It names each missing permission, offers its System Settings pane, and checks again.       | no   |
| `phone`       | Asks for the person's own number, then a yes. Only after the yes does the coordinator text one sign-in code. Then it asks for the code. A paired Mac sends no text.                                                          | yes  |
| `pairing`     | Asks for the display, then separate answers for view, computer actions and reports, then a final yes. It reuses a valid pairing. It replaces another Mac only on the person's explicit choice.                               | yes  |
| `connection`  | Starts one shared connection in the background, bound to the running desktop. It reuses a connection of the same desktop. A connection of an earlier desktop ends first. With `--app` it starts none: see [Owners](#owners). | yes  |
| `ready`       | One readiness report. It never places a call or sends a text.                                                                                                                                                                | no   |

In local mode, `phone`, `pairing` and `connection` are skipped. With computer
use off in local mode, `permissions` is skipped too.

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
  setup ends, the app runs `clawdtime start --tucked true --foreground`,
  which takes over the running service and opens the panel, and then
  `clawdtime shared run`. A background connection that Terminal setup started
  ends first. When the person stops setup in the app, setup ends the desktop
  that it started.

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

### Events

```json
{"type":"hello","protocol":1,"version":"0.4.0"}
{"type":"step","id":"model","state":"needs_input","title":"Model key","detail":"Paste your OpenAI API key. It is not shown.","input":{"kind":"secret","prompt":"OpenAI API key"}}
{"type":"log","level":"info","message":"The desktop runs already. It reads the new key the next time it starts."}
{"type":"done","ready":true,"report":[{"id":"model","state":"ready","detail":"A key for OpenAI is in the protected key store."}]}
```

- `hello` comes first. Then each step comes once as `pending`, in order.
- `step` has `state`: `pending`, `in_progress`, `needs_input`, `ready`,
  `failed` or `skipped`. It may have a `detail`, a `recovery` and an `input`.
- `recovery` has a `label` and an `action`: `retry`, `open_settings` or
  `open_url`, with a `url` for the last two. The interface opens the URL.
- `input` has a `kind`: `secret`, `text`, `choice`, `confirm`, `phone` or
  `code`, a `prompt`, and for a choice its `options`, each with an `id`, a
  `label` and an optional `detail`.
- `done` comes last, with `ready` and one report row for each step.

### Commands

```json
{"type":"input","id":"model","value":"..."}
{"type":"action","id":"permissions","action":"recheck"}
{"type":"cancel"}
```

- `input` answers the step that waits. The value is a string, a boolean for
  `confirm`, or an array of option ids for a choice with `multiple`.
- `action` is `retry`, `recheck` or `skip`. Only `computer`, `phone`,
  `pairing` and `connection` accept `skip`.
- A command for another step, or a value that does not fit, is ignored with a
  warning. A line that is not a command is ignored with a fixed warning that
  never quotes the line.

### What each question waits for

| Step and state                        | Answer                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Any step, `failed`                    | `action` `retry`, or `skip` where the step accepts it                  |
| `permissions`, `needs_input`          | Open the `recovery` URL, then `action` `recheck` or `input` `true`     |
| `phone`, `confirm` to send a code     | `input` `true` sends one text. `false` sends nothing and skips         |
| `phone`, `code`                       | `input` with the digits. `action` `retry` asks for a new code          |
| `pairing`, choice for a paired number | `replace` pairs this Mac in place of the other. `keep` changes nothing |

## Secrets

- A secret input goes only to the provider's key check and the protected key
  store. It never appears in an event, a log, an argument or a file.
- A phone number goes only to the coordinator. A sign-in code goes only to
  the coordinator. Neither appears in an event or a log.
- The device credential goes only to the owner-only pairing file.
- An error from an operation reaches the interface only as a fixed sentence.

## Recovery

- **Expired code.** The step fails with `Send a new code`. A retry asks for a
  new yes before the next text.
- **Wrong code.** The step asks again. After five tries it asks for a new code.
- **Denied permission.** The step names the exact binary and its pane. It
  checks again after the person acts.
- **Coordinator unavailable or older.** Setup runs in local mode.
- **Number already paired.** The step shows what a replacement does: the
  other Mac loses access at once, its open call ends, and its tasks get no
  callback. Nothing is replaced without the choice.
- **Lost pairing answer.** The step fails and says the Mac may be paired. A
  retry asks for a new invitation, and a pairing that exists then needs the
  person's choice before it is replaced. No uncertain request is repeated.

## Files

Setup writes only what its steps make:

| File                                                 | Step                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `~/.local/share/clawdtime/computer/keys.json`        | `model`                                                            |
| `~/.local/share/clawdtime/computer/model.json`       | `model`, only when the chosen provider would not plan by default   |
| `~/.local/share/clawdtime/computer/config.json`      | `computer`                                                         |
| `~/.config/clawdtime/shared/connection.json`         | `pairing`                                                          |
| `~/.config/clawdtime/shared/onboard-connection.json` | `connection`, the process and the desktop it serves, no credential |
| `~/.config/clawdtime/shared/connection.log`          | `connection`, the output of the connection                         |
| `~/.config/clawdtime/shared/connection.lock`         | `clawdtime shared run`, the process that holds the one connection  |

Every file is for its owner only. `CLAWDTIME_CONFIG_HOME` moves the first
three.

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
