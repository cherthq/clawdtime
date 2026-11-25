---
name: chert
description: Put ClawdTime, or any LiveKit agent, on a Chert line. Get a FaceTime and iMessage line with the chert command, connect the agent with chert dev, take calls with video, send and read texts, and fix what fails.
---

# Chert

Chert gives an agent a real phone line. A person calls the line on FaceTime or
texts it on iMessage, and the agent answers. ClawdTime uses its Chert line to
answer your calls, to call or text you when it needs you, and to text you the
results of its work.

This skill was read against `chert 0.1.0-beta.23` (npm package
`@trychert/facetime@beta`) and the public docs at https://docs.trychert.com on
26 November 2026. When the installed CLI says something else, the CLI wins: run
`chert --version`, `chert guide` and `chert context`.

## When to use it

- Someone sets up ClawdTime and needs a line, or the line does not answer.
- You connect a LiveKit agent to a Chert line.
- You place a call, or send or read texts, through the Chert API.
- A `chert` command stops with an error code.

For the conversation tools of ClawdTime itself (a call with this coding session,
the shared screen), use `skills/clawdtime/SKILL.md`.

## Rules for a coding agent

- The person signs in, joins the phone and pays in the browser. Run
  `chert login --device --json`, show the person `verification_url_complete`
  and `user_code` from the `login_code` record, and wait. Never approve a
  sign-in yourself.
- The person types every secret into `.env.local`. Never ask for a key in the
  chat. Never read aloud, print, log, paste or commit LiveKit values, a model
  key or a project API key. `chert doctor` checks the keys without showing them.
- Never pass `--takeover`, `--force` or `--no-prewarm` unless the person asks
  for it by name. Never pass `--restart` while an onboarding session is active.
- Stop `chert dev` with one Ctrl+C (SIGINT) or SIGTERM, then wait for
  `dev_stopped`. Never use SIGKILL: the line stays held until its lease lapses.
- Before an outbound call or text to anyone, show the exact recipient and
  purpose, and get a fresh yes. A yes to the setup is not a yes to a call.
- Never ask for payment details. A plan is bought only when the billing page
  shows it confirmed.
- Records are not proof. Only the person can confirm that a call had two-way
  audio or that the video showed.
- Never delete `~/.chert` to clear an error. It holds the sign-in and the call
  state.

## From nothing to a working line

1. Check Node: `node --version` must be 22.12 or later, 24 or 26. Install the
   CLI with `npm install -g @trychert/facetime@beta`, then run `chert --version`.
2. Get a line. Run `chert`. Signed out, it starts onboarding: the browser opens,
   the person makes an account, and sends a 6-digit code from their iPhone by
   iMessage. That joins the phone to the line. A coding agent runs
   `chert onboard --json --plan trial --stack demo` as a long-running process
   and reads its records until `onboarding_done`. It relays each `message` and
   `action_url` to the person.
3. With a project that has a line already, sign this computer in instead:
   `chert login`, then `chert whoami`. With several projects, pass
   `--project UUID` to `chert dev` and `chert doctor`.
4. Get an agent. For ClawdTime, follow `SETUP_CLAWDTIME.md`: the agent is in
   `line/`. For another agent, run `chert new my-agent`, let the person fill
   `.env.local`, then `npm install` and `npm start`.
5. Check. In the agent folder, run `chert doctor --agent NAME`. Exit 0 means
   ready. Each failed check says what to fix.
6. Connect. In the agent folder, run `chert dev` (for ClawdTime:
   `./host.sh start` in `line/`). Wait for the record `agent_warm`.
7. Call. FaceTime the number of the line from the joined iPhone: FaceTime Video
   for an agent with video, FaceTime Audio for a voice agent.
8. Texts are optional. See [imessage.md](imessage.md).

## Commands

| Command                       | What it does                                                      |
| ----------------------------- | ----------------------------------------------------------------- |
| `chert`                       | Runs onboarding or `chert dev`, as this computer needs            |
| `chert onboard`               | Account, phone, demo call, then the agent question                |
| `chert login`                 | Signs this computer in to one project for 30 days                 |
| `chert whoami`                | Who is signed in, and to which project                            |
| `chert plan [shared]`         | Plans, prices and the billing page. It never buys by itself       |
| `chert new DIR [--video]`     | A starter agent folder with `.env.local`                          |
| `chert livekit`               | Writes Chert's LiveKit keys into `.env.local`, where provided     |
| `chert agent on "SENTENCE"`   | Chert runs an agent on your line from one sentence, where enabled |
| `chert doctor [--agent NAME]` | Checks sign-in, LiveKit keys, the line and the agent              |
| `chert dev [--agent NAME]`    | Connects the agent to the line until Ctrl+C                       |
| `chert guide [TOPIC]`         | The handbook: `agent`, `video`, `line`, `fix`                     |
| `chert context [--write]`     | The rules for a coding agent, as an `AGENTS.md` block             |
| `chert setup`                 | Saves a project and an env file as defaults (advanced)            |
| `chert logout`                | Signs out and revokes this computer                               |

Every command takes `--json` (one record per line) and `--help`.
`chert --help --all` also lists the commands that run a connector by hand. A
ClawdTime line does not need them.

## Reference files

- [line.md](line.md): what a line is, the plans, getting a line, joining a
  phone, sharing a line.
- [connect-an-agent.md](connect-an-agent.md): `chert new`, `chert livekit`,
  `chert dev`, the waiting room, the rules for the agent, Chert's hosted agent.
- [calls-and-video.md](calls-and-video.md): the first call, video and framing,
  outbound calls with the Calls API, why a call ended.
- [imessage.md](imessage.md): texts, the project API key, joining a phone, the
  owner check, the reply window.
- [clawdtime-on-chert.md](clawdtime-on-chert.md): how ClawdTime uses its line:
  the line agent, texts, the reach, routines and away mode.
- [troubleshooting.md](troubleshooting.md): each error code and what to do.
