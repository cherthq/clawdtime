# ClawdTime pilot guide

Detailed setup, operation and implementation notes. For the overview, see the
[README](../README.md).

Keep using Claude Code or Codex as usual. When your agent needs a decision,
gets stuck, or has something to show you, it can call you on FaceTime with its
Mac screen. Talk to it naturally, direct computer actions while watching, then
let it continue the original task. The result comes back through Messages.

**The hook: “My coding agent FaceTimed me.”**

**Tags:** AI agents · FaceTime · iMessage · human-in-the-loop · computer use · CUA · MCP · Claude Code · Codex · macOS · remote work

## Why ClawdTime

I wanted to keep working while away from my desk, but my agents kept getting
stuck: a coding decision, an email that needed review, a video edit, a marketing
task, or an automation that needed someone to look at the screen.

ClawdTime gives an existing agent a way to bring that moment to its human.
You keep your editor, project and coding session. The integration adds a skill/tool
for requesting attention, showing the work, receiving feedback and continuing.
The first release focuses on coding; the other use cases are future integrations.

**Status: deployed internal pilot, with partial physical verification.** The
Codex → FaceTime → Mac screen → Messages feedback → same-session continuation →
Messages recap path has passed on a handset. The updated conversational voice and
compound-control flow is implemented and tested locally; its complete handset
acceptance is still pending. See [features and evidence](#features-and-evidence)
and [release status](STATUS.md).

[Landing page](https://www.clawdtime.com) ·
[Agent setup instructions](https://www.clawdtime.com/agents)

## Who this is for

The initial pilot is for one intended tester with an existing coding agent and a
Mac. Keep your editor, repository and coding workflow. ClawdTime brings a blocked
decision or visual review to your phone and routes the answer back to the exact
waiting session. Setup is install once, then use your tools; it is not zero-install.

Coding is the initial supported integration target. Email, video editing,
marketing, reports/articles, browsing/buying, watchers/schedulers and groups explain
the longer-term motivation; they are not finished ClawdTime integrations.

## Set up once

The setup message does the handoff to your existing coding agent:

1. **Click “Text it” on the landing page and send a text to ClawdTime.**
   ClawdTime replies in Messages with the setup prompt itself:
   “Set up ClawdTime for this project. Follow https://www.clawdtime.com/agents using my setup link: [personal link].”
2. **Paste it into your current Claude Code or Codex session.** Your agent installs
   the official ClawdTime integration as a skill/tool and prepares the Mac
   companion, keeping the private binding internal. The agent runs the connection
   command for you. There is no separate pairing-file download in this flow.
3. **Answer the setup questions in that same session.** Verify the selected attached
   display, grant Screen Recording, optionally grant Accessibility for computer
   control, and enable sharing locally. The workflow stays active while waiting
   for your answers or permissions until verified or explicitly canceled.
4. **Run the one authorized setup call.** The agent uses your explicit authorization
   in the current setup chat, texts a heads-up, yields conflicting work and calls.
   There is no additional SMS code or repeated confirmation for ordinary control.
5. **Talk or text naturally while watching.** Tell it whether you see the screen,
   ask a question, and give the coding agent your decision. This setup test has no
   clicking exercise; computer control is optional and qualified separately. Voice
   takes turns, and the agent can suggest landscape for a larger view. When you
   are ready to continue coding, it returns your feedback
   to the exact session, releases control, and sends the result through Messages.
   Setup verification requires actual positive screen feedback and the full live
   evidence chain; there is no prescribed phrase or automatic redial.

## Every day: your agent calls you

1. **Code normally.** Work in your existing Claude Code or Codex project. When
   the agent needs help, approval or review, it invokes the ClawdTime skill/tool.
2. **Answer FaceTime.** The agent asks its question and shows the selected Mac
   display. It yields conflicting computer activity before remote control starts.
3. **Speak or text naturally.** Say “Skip that test,” “Use the second design,” or
   ask about what you see. No wake word, command prefix or scripted reply is needed.
4. **Direct the screen when useful.** For example: “Click the title field, type
   Hello, then scroll down.” One conversational agent selects tools, observes the
   result between steps, and keeps viewing active during ordinary actions. It can
   suggest landscape for a larger view. Local Stop is always available.
5. **Return to coding.** Say that you are ready for the agent to continue. Your
   feedback returns to the exact waiting session; control is released and
   acknowledged before that agent resumes. Its normal permission policy still applies.
6. **Receive the result in Messages.** The same conversation gets a factual recap
   and any relevant artifact or link, so you can review the outcome away from your desk.

Setup stays active in the same coding session while waiting for permission or an
answer, until verified or explicitly canceled. Routine screen actions do not need
repeated confirmations. A new outbound test call still needs its own authorization;
silence does not authorize a call or an action.

## The catch: what you need today

This is an **internal Mac pilot**, with installation and explicit permissions.
The companion must be running on an available Mac, with its selected display and
local sharing enabled. The existing coding session must remain connected and
cooperate with yielding control. General work started from Messages is a later mode.

Voice is currently turn-based: listening pauses while ClawdTime speaks, so you
cannot interrupt its synthesized reply by talking over it. Computer actions are
bounded and checked against fresh frames; capture may briefly hold a fresh video
frame while authorizing input. Physical targeting and the revised natural-voice
flow still need acceptance; automated tests do not establish those outcomes.

Personal setup links use `/setup`. The older `/pair` page remains compatible;
an operational dashboard is not implemented.

### Run the internal pilot from this checkout

The current pilot uses a trusted local checkout and the approved installed Mac
companion. A public signed/notarized download and automatic fresh-device gateway
enrollment are **not available yet**. The proposed npm package is not published
or namespace-verified; do not install a package named `clawdtime` by assumption.
The personal link is an expiring credential; keep it in an owner-only private
file, never a command argument, project file, or log.

```sh
npm ci
npm run build
node /absolute/path/to/clawdtime/dist/cli/main.js setup --agent codex --project /absolute/path/to/project --setup-link-file /absolute/private/setup-link.txt --origin https://TRUSTED-SERVICE --allow-view true --allow-control true --pilot-installed true
```

Use `--agent claude-code` for Claude Code. Permission flags must reflect explicit
user consent. `--pilot-installed true` is only for the operator-approved existing
internal build. For an existing connection, use `--existing true` in place of the
setup-link option; it preserves grants, credentials and receipt ledgers.

The installed skill uses the foreground `setup-session` JSONL bridge in the
**current agent session**, with a stable run ID, heartbeats and durable intents.
It needs no new coding client or MCP reload. During installation and pre-call
setup, the agent uses its native question UI while waiting and continues after the
answer. During screen-control work, use your phone for dialogue so the Mac keeps
focus on the intended app. A host crash or hard session
limit remains possible; saved identity and receipts prevent an unsafe replacement
or blind retry. Future agent sessions can use the installed MCP/skill normally.

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-session --agent codex --project /absolute/path/to/project --run-id CURRENT_CHAT_STABLE_ID
node /absolute/path/to/clawdtime/dist/cli/main.js doctor --agent codex --project /absolute/path/to/project
```

Legacy `connect --pairing-file`, `run` and `disconnect` remain supported.
`disconnect` revokes remote access before removing unchanged ClawdTime-owned
configuration. Use local Stop before quitting the companion and retain action
ledgers for recovery. See [connector documentation](CONNECTORS.md).

### Mac installation for the internal pilot

Requirements: macOS 14+, Xcode command-line tools/Swift 6, Node 24+, Python 3.12+
and a signed-in supported agent CLI. The locally built app uses its own identity,
ports, configuration and receipt storage; it does not replace Apple Teams.

```sh
./mac/scripts/package.sh
"mac/build/ClawdTime Companion.app/Contents/MacOS/ClawdTimeCompanion" --list-displays
chmod 600 /absolute/private/clawdtime-pairing.json
python3 mac/scripts/configure.py --claim /absolute/private/clawdtime-pairing.json \
  --directory "$HOME/Library/Application Support/ClawdTimeCompanion/setup" \
  --relay-url wss://YOUR-CLAWDTIME-MEDIA/device-gateway
```

Pair the observed display ID. The generator prepares private helper/gateway
configuration without manual JSON editing, refuses overwrites, and prints launch
commands. The operator must provision its fresh gateway key on the independent
media service. Public gateway enrollment is not implemented. Launch the companion,
grant permissions, and choose Enable locally. Packaging is ad hoc signed by
default; external downloads require Developer ID signing, notarization and a
clean installation check. See [device setup](../mac/README.md).

## Two modes

**Mode 1 — the agent calls you (launch scope).** Work normally in your coding agent.
When blocked, needing a decision/approval/review, or ready to show a result, it
explicitly invokes ClawdTime. It yields conflicting activity, calls the paired
human, and shows the intended screen. Respond by voice or text, or direct typing,
clicking, scrolling or a bounded sequence of human-directed screen actions. After
feedback is acknowledged and control released, the exact agent session continues under its
native permission policy and sends a factual completion recap through Messages.

The demo story is: **“My coding agent FaceTimed me because it needed me.”** A skill
alone does not detect every blocked process or intercept every native approval.

**Mode 2 — start work in Messages (planned).** Text “fix the login bug” or “show me
my screen” to start/resume work through the paired agent. General task initiation
and cloud-computer fallback are future work. Text feedback/CUA for an existing
pending attention request belongs to Mode 1.

## Features and evidence

| Feature                                                       | Implementation status                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Private agent-initiated FaceTime attention                    | Physical outbound video call answered on the intended handset                                                                 |
| Screen viewing from the paired Mac                            | Physical fixture video confirmed on handset; full fresh-install distribution acceptance pending                               |
| Voice and text feedback for the exact task                    | Authenticated Messages feedback resumed the exact Codex session; spoken feedback unverified                                   |
| Human-directed click/type/scroll and bounded compound actions | Implemented with fresh frames and exclusive leases; earlier wrong-target typing observed, revised physical acceptance pending |
| Claude Code and Codex MCP tools/skills                        | Both CLI synthetic workflows passed; physical Codex same-chat loop passed, Claude physical loop pending                       |
| Durable requests, responses and action receipts               | SQLite/backend and migrated helper/gateway/media ledgers; replay/restart tests                                                |
| Visible state, local Stop, revocation/disconnect              | Implemented with fail-closed policy tests; physical lock/sleep/Stop verification required                                     |
| iMessage completion result                                    | Factual completion recap confirmed received on the intended handset                                                           |

Verified client probes: **Claude Code 2.1.311** terminal print mode and **Codex CLI
0.166.0-alpha.5.1** exec mode. Both invoked actual MCP tools, consumed synthetic
feedback, resumed and completed with one simulated call and result. Interactive
terminal approvals, desktop/IDE surfaces and phone workflows are separate gates.
No arbitrary desktop-session takeover or Cursor/OpenClaw support is claimed.

## How it connects

```text
Claude Code / Codex ←→ local scoped MCP connector ←→ ClawdTime backend + SQLite
                                                     ↕              ↕
                                                Messages       Calls + media
                                                                    ↕
Phone / FaceTime ←────────────────────────────────────────── LiveKit video/audio
                                                                    ↕
Paired Mac companion ← loopback helper API ← outbound authenticated WSS gateway
```

Live conversational feedback requires `CLAWDTIME_AI_ACTIONS=true`, an explicit
`CLAWDTIME_AI_PROVIDER`/`CLAWDTIME_AI_MODEL`, and its independent provider key.
Evaluate that exact model on disposable screen targets before accepting control:
API connectivity and fluent replies do not establish coordinate accuracy. The
screen harness presents the latest image separately from tool metadata, uses
screenshot-pixel coordinates at the model boundary, and preserves normalized
coordinates in the device protocol. Optional `CLAWDTIME_AI_REASONING=low|medium` and
`CLAWDTIME_AI_MAX_OUTPUT_TOKENS` (integer 800–4096) configure the generation budget;
omit them to retain unset reasoning and 800 output tokens. Supplied invalid values
fail startup. The token cap includes reasoning as well as visible/tool output;
qualify the exact model and settings together. Step/turn deadlines remain 12/45
seconds, with at most eight model steps and no automatic input retries.
The action loop refreshes the native frame stamp, sends the model-selected action,
and returns a screenshot. It does not require identical screenshot bytes or impose
a separate four-action counter or persisted focus block. The model judges focus
and visible results. Display geometry, current-session permission, local Stop,
exclusive control and unknown-input receipts remain enforced.
When disabled, natural-language interpretation fails closed; local Stop remains
available. `npm run demo` uses an explicitly scripted simulation without a model.

The helper stays on loopback; the gateway makes an outbound WSS connection to the
media service. Tailscale is optional for an explicitly configured private route,
not required for the preferred deployment. Backend/media volumes, application
secrets, ports and namespaces are independent from Apple Teams. A single backend
owns the SQLite pilot and dedicated line; horizontal scaling/public pooling is
not an MVP capability.

## Permissions, privacy and control

Viewing and control are separate permissions. A paired, authorized session may
show only its selected display. Screen frames and raw audio are transient; they
are not copied into logs or migration artifacts. Qualified remote participant
audio is transcribed through the configured provider; the backend retains scoped
human responses and action/call receipts. Treat paired screen/audio as potentially
sensitive and use only consented demo material.

Control requires the coding agent to yield and stop conflicting background actors.
The backend binds short-lived leases to member/device/display/call/session, checks
fresh frames and requires a post-action observation. A submitted OS event is not
proof the intended app changed correctly. ClawdTime cannot forcibly suspend
arbitrary outside processes: refuse control when cooperative coordination cannot
be established. Silence, echo, unrelated speech and agent TTS are not approval;
sensitive native approvals retain their supported client policy.

Local Stop, lock, sleep, revoked pairing and terminal session loss end access.
Reconnect does not silently rearm sharing. Unknown inputs/calls stay unknown and
are reconciled with their original IDs; never erase receipts or issue a fresh key
to force a retry.

## Development and validation

```sh
npm ci
npm run dev                 # loopback :3310, simulation by default
npm run demo                # synthetic attention/feedback/control/result flow
npm run check               # TypeScript, behavior tests, build
npm run test:onboarding:browser
npx tsx tests/connectors-spike.ts claude-code
npx tsx tests/connectors-spike.ts codex
```

Copy only the example configuration for local customization; never load an Apple
Teams `.env` or copy customer databases. Default state is `.data/clawdtime.sqlite`.
Live dispatch requires an explicit handoff configuration and separate live gate.
Standby does not start new calls or work; it can dispatch cleanup for calls it
already owns. `doctor`/health and passing mocks are not physical acceptance.

```sh
python3 -m venv media/.venv
media/.venv/bin/python -m pip install -r media/requirements.txt -r gateway/requirements.txt
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
(cd mac && swift test)
./mac/scripts/package.sh
```

Backend, helper, gateway and media have independent credentials and receipt stores.
Keep one owner on the test line. [LINE_HANDOFF](LINE_HANDOFF.md) records the
controlled preflight, non-replaying event boundary and rollback/reconciliation
procedure. No specialist may enable traffic or deploy. Public hosting/package
publication, paid commitments and existing service replacement are not implied.

## Provenance and remaining work

ClawdTime is an independent project selectively extracted from Apple Teams commit
`be47b11fe1317c4747db4121bec37896998b5201`, with new pairing/attention/agent domains.
The source repository and sibling `chert-facetime` remain separate. Production
customer data, credentials and receipt databases are not copied. See
[MIGRATION](MIGRATION.md), [media migration manifest](MIGRATION_MEDIA.md)
and [ARCHITECTURE](ARCHITECTURE.md).

The initial MVP excludes general Mode 2 task starts, cloud sandboxes, public line
pooling, billing/referrals, groups and arbitrary multi-step autonomous CUA. Future
marketing, reports, buying and scheduler use cases depend on separately qualified
agent integrations. [DEMO_ACCEPTANCE](DEMO_ACCEPTANCE.md) and
[STATUS](STATUS.md) distinguish built code, automated verification and remaining
live prerequisites. Demo readiness requires the actual complete physical path.
