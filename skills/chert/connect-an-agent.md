# Connect an agent

Read against `chert 0.1.0-beta.23` and https://docs.trychert.com, 26 November 2026. For the ClawdTime line agent, see
[clawdtime-on-chert.md](clawdtime-on-chert.md) and `SETUP_CLAWDTIME.md`.

There are two ways to put an agent on a line:

- **Chert runs it.** Describe the agent in one sentence. No LiveKit project,
  model key or agent folder.
- **You run it.** A LiveKit agent runs on your computer, and `chert dev`
  connects it to the line. ClawdTime works this way.

## Chert runs an agent from one sentence

```sh
chert agent on "A friendly guide to our bakery's opening hours" [--voice marin|cedar]
chert agent status       # on or off, its sentence, and who holds the line
chert agent off          # it no longer answers your line
```

- For a project owner or admin, on a trial or Shared line. Not every account
  has it yet. `chert onboard --describe "SENTENCE"` turns it on after the demo.
- Use the sentence that the person gives, word for word. Wait for "answering
  your line" before you invite a call.
- While `chert dev` holds the line, this agent waits. It answers again once
  `chert dev` stops. Stopping `chert dev` does not turn it off: run
  `chert agent off`.

## Your own agent: the folder

```sh
chert new my-agent           # a voice starter in my-agent/
chert new otter --video      # a video starter: it publishes a drawn face
cd my-agent && npm install
```

- `chert new` refuses a folder that already has files. It writes `.env.local`
  with `AGENT_NAME` filled in. `--agent NAME` sets another name.
- The starters are Node agents on `@livekit/agents` 1.8.0 with an OpenAI
  realtime model. They greet on the ready signal of the line (`greet.mjs`). The
  public docs give Node 22.23.2 or later, or 24, for the starter.
- Working examples are in the repository of the CLI: `examples/student-agent`
  (voice) and `examples/video-agent` (video).
- An existing LiveKit agent works too, in any language. It must keep the rules
  below. Put `.env.local` in its folder.
- `chert context --write` writes the rules block into `AGENTS.md` in the agent
  folder and makes `CLAUDE.md` import it. Your own text outside its marks stays.
  `chert context --check` exits 3 when the block is missing or out of date.

## Your own agent: the keys

The person fills `.env.local` and runs `chmod 600 .env.local`:

| Value                | Where it comes from                                         |
| -------------------- | ----------------------------------------------------------- |
| `LIVEKIT_URL`        | A LiveKit Cloud project, `wss://YOUR_PROJECT.livekit.cloud` |
| `LIVEKIT_API_KEY`    | The same LiveKit project                                    |
| `LIVEKIT_API_SECRET` | The same LiveKit project. It stays on this computer         |
| `OPENAI_API_KEY`     | The model provider of the starter, with realtime access     |
| `AGENT_NAME`         | Written by `chert new`. The name the agent registers with   |

- All three LiveKit values come from one project. The agent and `chert dev` use
  the same three.
- `chert livekit` writes Chert's LiveKit keys into `.env.local` instead, and
  keeps every other line. Only the project owner gets them, and only where
  Chert provides them (eligible paid Shared projects). The secret is never
  printed. It replaces values that you put there yourself only with `--force`:
  pass that only when the person asks.
- On a Shared plan with Chert rooms, the starters can leave all three LiveKit
  values empty. Calls then run in Chert's LiveKit, and the starters join each
  call with a token that `chert dev` hands them.
- LiveKit and the model provider bill their own use.

## What the agent must do

1. Register with a name: `agentName` in the Node SDK, `agent_name` in Python.
   Put the same name in `AGENT_NAME`, and choose one that no other team uses.
2. Use the LiveKit project whose three values are in `.env.local`.
3. Join the room at once, then wait for the caller before it opens a paid model
   session. `chert dev` keeps a room ready with the agent in it before any call.
4. Greet the caller within 10 seconds of `bridge_ready`, or the call ends
   (`remote_audio_timeout`). At `bridge_ready`, `chert dev` sets the room
   metadata to `{"chert_bridge_ready":true,...}` and prints "FaceTime is
   ready." Greet once on that, never because the caller joined: FaceTime may
   still be connecting. Without the signal, do not greet.
5. The caller joins the room as `chert-bridge-<call id>`.
6. Publish exactly one unmuted audio track. A second participant that
   publishes audio ends the call.
7. After a change to the agent, restart both terminals. A waiting room can
   still hold the old code.

## Check and connect

```sh
npm start                        # terminal 1: the agent (or python agent.py dev)
chert doctor                     # terminal 2, in the agent folder: the checks
chert doctor --agent my-agent    # also sends the agent a real test job
chert dev                        # holds the line and keeps a waiting room
```

- `chert doctor` checks sign-in, the project, the line, its availability and
  the LiveKit keys. Exit 0 means ready. `--agent NAME` runs a real agent job
  and times how long the agent takes to join. It can use provider credit.
- `chert dev` claims the line of the project and keeps a room ready with the
  agent in it: the waiting room. It answers each call with that agent.
- Wait for `agent_warm`: the agent is in a waiting room, and you can call.
  `agent_not_warm` means that every call would be declined: the agent does not
  run, or `AGENT_NAME` or the LiveKit project does not match.
- `--minutes N` (1 to 240) or `--until HH:MM` bounds the session. See
  [line.md](line.md).
- `--no-prewarm` makes the room only when a call arrives. Chert gives about 5
  seconds to answer, so calls can be declined. It is not for teams.
- The agent and `chert dev` must keep running to answer calls. Closing the
  terminal stops the answers.
- Stop with one Ctrl+C and wait for `dev_stopped` ("Stopped. The line no longer
  routes to this agent."). `release_failed` means that the line was not freed:
  sign in again, run `chert dev`, and stop it once.

## Records and exit codes

With `--json`, each command prints one JSON record per line, with
`schema_version: 1` and `command`. Errors go to standard error as
`{code, action}`: the action says what to do. When Chert refused a request, the
record also has `http_status`, `server_code`, `server_message` and
`request_id`.

Records of `chert dev`: `line_state`, `agent_warm`, `agent_not_warm`,
`slot_set`, `slot_ending`, `slot_over`, `call_incoming`, `call_accepted`,
`call_bridge_ready`, `call_media`, `call_declined`, `call_ended`,
`reconnecting`, `dev_reconnected`, `displaced`, `dev_stopped`,
`release_failed`.

Exit codes: 0 success, 1 internal, 2 usage, 3 not ready or not signed in, 4
state, 5 unsupported runtime, 6 network or server, 130 cancelled. Read the
records, not only the exit code.
