# ClawdTime

Your agent can FaceTime you.

**Tags:** AI agents · FaceTime · iMessage · human-in-the-loop · computer use · CUA · MCP · Claude Code · Codex · macOS · remote work

I wanted to keep working while away from my desk, but my agents kept getting
stuck: a coding decision, an email that needed review, a video edit, a marketing
task, or an automation that needed someone to look at the screen.

ClawdTime connects those agents to you through iMessage and FaceTime. Your agent
calls when it needs attention, shows its screen, and receives your response. You
can also direct computer actions while watching, then let the agent continue in
the tools you already use.

**Current status: independently hosted pilot; full control acceptance is pending.**
The physical Codex chat → FaceTime → Mac screen → authenticated Messages feedback
→ same-chat continuation → Messages recap path passed on the intended handset.
Computer control did not pass: typing reached the Codex reply box after the planned
focus click failed. A planner/failure-handling repair is locally verified; correct
click/type/scroll/AI targeting still needs physical acceptance. Natural conversational voice/text and continuous viewing during actions are implemented and locally tested; their updated physical flow and the Claude Code call loop remain
unverified. See [STATUS](docs/STATUS.md).

[Open the landing page](https://backend-production-ee686906.up.railway.app).
Agent instructions are at `/agents`, and personal setup links use `/setup`.
The legacy `/pair` page remains compatible; an operational dashboard is not implemented.

## Who this is for

The initial pilot is for one intended tester with an existing coding agent and a
Mac. Keep your editor, repository and coding workflow. ClawdTime brings a blocked
decision or visual review to your phone and routes the answer back to the exact
waiting session. Setup is install once, then use your tools; it is not zero-install.

Coding is the initial supported integration target. Email, video editing,
marketing, reports/articles, browsing/buying, watchers/schedulers and groups explain
the longer-term motivation; they are not finished ClawdTime integrations.

## Onboarding

The setup message does the handoff to your existing coding agent:

1. **Text the pilot number.** ClawdTime replies with the prompt itself:
   “Set up ClawdTime for this project. Follow [service]/agents using my setup link: [personal link].”
2. **Paste it into your current Claude Code or Codex session.** Your agent installs
   the integration and prepares the Mac companion, keeping the private binding
   internal. There is no separate pairing-file download in this flow.
3. **Answer the setup questions in that same session.** Choose the actual attached
   display, grant Screen Recording, separately grant Accessibility for computer
   control, and enable sharing locally. The workflow stays active while waiting
   for your answers or permissions until verified or explicitly canceled.
4. **Run the one authorized setup call.** The agent uses your explicit authorization
   in the current setup chat, texts a heads-up, yields conflicting work and calls.
   There is no additional SMS code or repeated confirmation for ordinary control.
5. **Talk naturally while watching.** Ask “Click that textbox and type hello,”
   “Scroll down,” or give the coding agent your decision. The same conversational
   agent chooses tools and observes between actions. It can suggest landscape for
   a larger view. When you are ready to continue coding, it returns your feedback
   to the exact session, releases control, and sends the result through Messages.
   Setup verification requires actual positive screen feedback and the full live
   evidence chain; there is no prescribed phrase or automatic redial.

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
It needs no new coding client or MCP reload. The agent uses its native question
UI while waiting and continues after the answer. A host crash or hard session
limit remains possible; saved identity and receipts prevent an unsafe replacement
or blind retry. Future agent sessions can use the installed MCP/skill normally.

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-session --agent codex --project /absolute/path/to/project --run-id CURRENT_CHAT_STABLE_ID
node /absolute/path/to/clawdtime/dist/cli/main.js doctor --agent codex --project /absolute/path/to/project
```

Legacy `connect --pairing-file`, `run` and `disconnect` remain supported.
`disconnect` revokes remote access before removing unchanged ClawdTime-owned
configuration. Use local Stop before quitting the companion and retain action
ledgers for recovery. See [connector documentation](docs/CONNECTORS.md).

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
clean installation check. See [device setup](mac/README.md).

## Two modes

**Mode 1 — the agent calls you (launch scope).** Work normally in your coding agent.
When blocked, needing a decision/approval/review, or ready to show a result, it
explicitly invokes ClawdTime. It yields conflicting activity, calls the paired
human, and shows the intended screen. Respond by voice or text, or direct typing,
clicking, scrolling or a bounded sequence of human-directed screen actions. After feedback is
acknowledged and control released, the exact agent session continues under its
native permission policy and sends a factual completion recap through Messages.

The demo story is: **“My coding agent FaceTimed me because it needed me.”** A skill
alone does not detect every blocked process or intercept every native approval.

**Mode 2 — start work in Messages (planned).** Text “fix the login bug” or “show me
my screen” to start/resume work through the paired agent. General task initiation
and cloud-computer fallback are future work. Text feedback/CUA for an existing
pending attention request belongs to Mode 1.

## Features and evidence

| Feature                                                       | Implementation status                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Private agent-initiated FaceTime attention                    | Physical outbound video call answered on the intended handset                                                     |
| Screen viewing from the paired Mac                            | Physical fixture video confirmed on handset; full fresh-install distribution acceptance pending                   |
| Voice and text feedback for the exact task                    | Authenticated Messages feedback resumed the exact Codex session; spoken feedback unverified                       |
| Human-directed click/type/scroll and bounded compound actions | Implemented with fresh frames and exclusive leases; wrong-target typing observed, full control acceptance pending |
| Claude Code and Codex MCP tools/skills                        | Both CLI synthetic workflows passed; physical Codex same-chat loop passed, Claude physical loop pending           |
| Durable requests, responses and action receipts               | SQLite/backend and migrated helper/gateway/media ledgers; replay/restart tests                                    |
| Visible state, local Stop, revocation/disconnect              | Implemented with fail-closed policy tests; physical lock/sleep/Stop verification required                         |
| iMessage completion result                                    | Factual completion recap confirmed received on the intended handset                                               |

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
Standby does not dispatch. `doctor`/health and passing mocks are not live readiness.

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
Keep one owner on the test line. [LINE_HANDOFF](docs/LINE_HANDOFF.md) records the
controlled preflight, non-replaying event boundary and rollback/reconciliation
procedure. No specialist may enable traffic or deploy. Public hosting/package
publication, paid commitments and existing service replacement are not implied.

## Provenance and remaining work

ClawdTime is an independent project selectively extracted from Apple Teams commit
`be47b11fe1317c4747db4121bec37896998b5201`, with new pairing/attention/agent domains.
The source repository and sibling `chert-facetime` remain separate. Production
customer data, credentials and receipt databases are not copied. See
[MIGRATION](docs/MIGRATION.md), [media migration manifest](docs/MIGRATION_MEDIA.md)
and [ARCHITECTURE](docs/ARCHITECTURE.md).

The initial MVP excludes general Mode 2 task starts, cloud sandboxes, public line
pooling, billing/referrals, groups and arbitrary multi-step autonomous CUA. Future
marketing, reports, buying and scheduler use cases depend on separately qualified
agent integrations. [DEMO_ACCEPTANCE](docs/DEMO_ACCEPTANCE.md) and
[STATUS](docs/STATUS.md) distinguish built code, automated verification and remaining
live prerequisites. Demo readiness requires the actual complete physical path.
