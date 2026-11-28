# AGENTS.md

Rules for coding agents that work in this repository.

## Purpose

ClawdTime is an assistant on the Mac that you talk to, by chat or by voice, and
that uses the computer for you: a computer use agent. A desktop service plans
each action with a language model and checks it in code, a native panel sees the
screen and sends the input, and a line agent puts ClawdTime on a FaceTime and
iMessage line through Chert. It also supervises the coding agent sessions on
the Mac. This file says where the code lives, how to build and test it, and the
rules that every change keeps. The user guides are [README.md](README.md),
[INSTRUCTIONS.md](INSTRUCTIONS.md) and [SETUP_CLAWDTIME.md](SETUP_CLAWDTIME.md).
Read [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the approved plan) and
[SESSION_PROMPT.md](SESSION_PROMPT.md) (the first session brief) for the scope
and its history.

## Repository map

| Folder                                         | What lives there                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                                         | The backend: `contracts.ts`, `server.ts`, `app.ts`, and `control/`, `storage/`, `transport/`, `pairing/`, `attention/`                                         |
| `cli/`                                         | The `clawdtime` command (`main.ts`): `connect`, `computer`, `keys`, `routine`, `agents`, the chat, and the desktop launcher (`task-desktop.ts`)                |
| `connectors/computer/`                         | Computer use: the worker, the planner and its providers, the guards, the browser drivers, the reach and routines. `ports.ts` is the contract between the parts |
| `connectors/agents/`                           | The supervisor: the chat and the chat agent, the agent board, memory, the trove, jobs, speech and texts                                                        |
| `connectors/claude-code/`, `connectors/codex/` | The adapters for the coding agents                                                                                                                             |
| `connectors/shared/`                           | The backend client, the MCP server, the setup bridge and the private connection state                                                                          |
| `skills/`                                      | Skills for coding agents: `clawdtime` (a call with this coding session) and `chert` (the line)                                                                 |
| `line/`                                        | The line agent: the voice agent on the Chert line, the call video and zoom, and `host.sh`                                                                      |
| `mac/`                                         | Swift: the panel (`ClawdTimeTaskPanel`, with the hands and the cursor), its pure rules (`TaskPanelCore`), the companion and capture                            |
| `media/`, `gateway/`                           | Python: the media and device relay, and the gateway                                                                                                            |
| `scripts/`                                     | The task server (`task-server.ts`), qualification, packaging and backup                                                                                        |
| `public/`                                      | The web pages of the backend                                                                                                                                   |
| `tests/`                                       | The Vitest tests (`*.test.ts`), the browser tests (`*.browser.ts`) and the evals (`*.eval.ts`)                                                                 |
| `docs/`                                        | Design notes, guides and status. [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md) and [docs/SUPERVISOR.md](docs/SUPERVISOR.md) are the main ones                   |

## Build and test

Node 24 or later. Install with `npm ci`.

```sh
npm run check                     # typecheck, every test, build
npx vitest run                    # every test
npx vitest run tests/connectors-computer-guards.test.ts   # one file
npx prettier --check FILE         # formatting; --write fixes it
(cd mac && swift test)            # the Swift panel and helpers
```

**The line tests.** `line/` has its own dependencies. Install them with
`npm --prefix line install`, then run `cd line && npm test`. `npx vitest run`
runs the line tests too, and skips the three that need `line/node_modules`
when it is missing (it prints a warning).

**Python.** The media, gateway and helper tests run with `unittest`. The setup
of the virtual environment is in [docs/DEVICE.md](docs/DEVICE.md):

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
```

**The evals.** They measure the planner and the chat. The computer evals need
the Chromium of Playwright (`npm run cua:install-browser`).

```sh
npm run eval:computer:planner -- --check                 # no model, no key: each task's check tells right from wrong
npm run eval:computer:request -- --check --new-actions   # the same for whole requests, with the newer actions
npm run eval:computer:planner -- gpt-5.4 anthropic/claude-opus-5-5   # real model calls: needs a key
npm run eval:computer:request -- gpt-5.4
npm run eval:chat -- --check                             # scripted model: no key, no network
npm run eval:chat                                        # the chat's own model
```

Run the `--check` modes after every change to an eval, its apps or its
checks. Run the model evals before you change the planner's rules, and before
you rely on a new model.

`npm run test:computer:browser` and `npm run test:computer:own-browser` run the
browser drivers in a real browser with no window. `npm test` does not run them.

## Rules

**Scope.**

- Work only in this repository. Never modify a sibling repository or another
  checkout from here. Never copy customer or runtime data into it.
- External prerequisites must be concrete: name the exact tool, version,
  permission or file.

**The lead and file ownership.**

- Default to simulation or standby.
- Only the coordinating lead may integrate shared contracts and manifests,
  handle secrets, deploy, or hand off live lines.
- No concurrent live line ownership.
- When agents work in parallel, each owns these files. Request shared contract
  changes from the lead. Do not edit another owner's files.
  - Lead: `src/contracts.ts`, `src/server.ts`, `src/app.ts`, `src/control/`,
    `scripts/`, `public/`, the root manifests, configuration and docs (except
    the docs assigned below), integration and acceptance.
  - Transport specialist: `src/storage/`, `src/transport/`, `src/pairing/`,
    `src/sessions/`, `src/attention/`, `tests/backend*`, `docs/TRANSPORT.md`.
  - Mac specialist: `mac/`, `media/`, `gateway/`, `tests/media*`,
    `docs/DEVICE.md`, `docs/MEDIA_INTEGRATION.md` and
    `docs/MIGRATION_MEDIA.md`.
  - Connector specialist: `cli/`, `connectors/`, `skills/`,
    `tests/connectors*`, `docs/CONNECTORS.md`.

**Effects and evidence.**

- Preserve cursors, receipts and unknown outcomes.
- No blind retries of external effects.
- Never claim that submitted input proves UI success.
- Tests are not physical acceptance.

**Screen control.**

- Explicit session and identity authorization, local Stop, frame freshness
  and exclusive control are mandatory.
- For v2, claim exclusive native or fallback execution before shared-screen
  input, and release it afterward. Ordinary reasoning and file work stays
  active during sharing. Only legacy v1 uses the global yield, acknowledge and
  resume.
- Model output is an untrusted single-action plan.
- Keep screens and audio transient.

**Stack and data.**

- Node 24+, TypeScript, Python, Swift. `npm run check` verifies the backend
  and the connectors. The component READMEs document the Python and Swift
  validation.
- Keep secrets and personal data out of tracked files, logs and test
  fixtures.

## Branches, commits and pull requests

- Do not create or use `codex/` branches. Give each branch a short descriptive
  name, for example `fix-speech`. Preserve unmerged work when you rename or
  remove an old branch.
- Make one change per pull request, and keep it small: one thing that builds
  and passes its own tests. Rebase on `main` before you push.
- Commit messages are plain sentences that say what changed. No tool, model or
  session name, and no trailer.
- A pull request description has three headings, in this order: What, Why,
  How. Every line under them is a bullet. What: one bullet for each
  observable change. Why: the problem or its root cause. How: the mechanism,
  then a `Release:` bullet and a `Tests:` bullet.

## Public repository

- This repository is public. Use made-up examples only, such as
  `shop.example`, Stonepad, Riverchat or +1 415 555 0100. Never put a real
  conversation, a real person's name, a customer, a phone number, an email
  address, an internal host or a key in code, tests, docs, commits or pull
  requests.
- Name no outside product or person as the source or inspiration of a change.
- User docs are self serve: they never tell the reader to contact anyone, or
  that someone sets things up for them. Write plain short sentences in active
  voice, with no em dash or en dash.
