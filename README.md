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

**Current status: independently hosted pilot; not yet a verified live demo.** The
backend, Mac companion, media/gateway, pairing page, agent tools and simulation
are runnable. Real Claude Code and Codex CLI processes have completed cooperative
attention workflows against simulated calls and synthetic feedback. The actual
FaceTime → screen → voice/text/CUA → agent continuation → Messages result path
still requires controlled line handoff and physical acceptance. See
[STATUS](docs/STATUS.md) for current evidence and concrete blockers.

[Open the landing page](https://backend-production-ee686906.up.railway.app).
Private pairing is available at `/pair`; an operational dashboard is not implemented.

## Who this is for

The initial pilot is for one intended tester with an existing coding agent and a
Mac. Keep your editor, repository and coding workflow. ClawdTime brings a blocked
decision or visual review to your phone and routes the answer back to the exact
waiting session. Setup is install once, then use your tools; it is not zero-install.

Coding is the initial supported integration target. Email, video editing,
marketing, reports/articles, browsing/buying, watchers/schedulers and groups explain
the longer-term motivation; they are not finished ClawdTime integrations.

## Onboarding

The intended live flow is:

1. **Text the pilot number.** Its authenticated messaging flow sends a private,
   expiring pairing link. The number is shared privately after the controlled
   handoff; this repository does not publish a signup line.
2. **Install and pair the Mac companion.** Choose the actual attached display,
   grant Screen Recording, separately grant Accessibility for computer control,
   and explicitly enable locally. The companion starts stopped. Pairing alone
   does not grant macOS permissions or start screen capture.
3. **Connect Claude Code or Codex with one command.** Download the pairing file
   and run the bundled command below. It installs only its project MCP entry and
   skill, preserves other configuration, and checks scoped readiness.

This internal build uses a pinned local checkout. The proposed public command
`npx clawdtime connect` is not published or namespace-verified. Do not install a
package with that name by assumption.

```sh
npm ci
npm run build
node /absolute/path/to/clawdtime/dist/cli/main.js connect --agent codex --project /absolute/path/to/your/project --pairing-file /absolute/path/to/clawdtime-pairing.json
```

Use `--agent claude-code` for Claude Code. The pairing file contains a credential;
keep it private. The CLI protects it with mode 0600 and stores local credentials
in `~/.local/share/clawdtime/`. It never writes a credential into the project's
MCP configuration or changes native sandbox/approval settings. Reload the client
and approve the project MCP server through its normal trust flow.

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js doctor --agent codex --project /absolute/path/to/your/project
node /absolute/path/to/clawdtime/dist/cli/main.js run --agent codex --project /absolute/path/to/your/project
node /absolute/path/to/clawdtime/dist/cli/main.js disconnect --agent codex --project /absolute/path/to/your/project
```

`run` launches the usual client with a durable local run identity for MCP
reconnects. Recovery requires that ID and the native client's exact resume
arguments; a different chat must not reuse it. `disconnect` first revokes remote
access, then removes only unchanged ClawdTime config/skills and local credentials.
Use local Stop before quitting the companion. Preserve action ledgers for recovery.
[Connector documentation](docs/CONNECTORS.md) covers reconnects and uninstall.

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
clicking, scrolling or one bounded AI-directed screen action. After feedback is
acknowledged and control released, the exact agent session continues under its
native permission policy and sends a factual completion recap through Messages.

The demo story is: **“My coding agent FaceTimed me because it needed me.”** A skill
alone does not detect every blocked process or intercept every native approval.

**Mode 2 — start work in Messages (planned).** Text “fix the login bug” or “show me
my screen” to start/resume work through the paired agent. General task initiation
and cloud-computer fallback are future work. Text feedback/CUA for an existing
pending attention request belongs to Mode 1.

## Features and evidence

| Feature                                                | Implementation status                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Private agent-initiated FaceTime attention             | Durable backend and live transport adapter implemented; physical delivery pending                                    |
| Screen viewing from the paired Mac                     | Swift capture, authenticated gateway and media video migrated; fresh ClawdTime install/handset qualification pending |
| Voice and text feedback for the exact task             | Authenticated routing and isolated response receipts implemented; real voice/call qualification pending              |
| Human-directed click/type/scroll and bounded AI action | Explicit permissions, fresh frames, leases, receipts and planner implemented; physical qualification pending         |
| Claude Code and Codex MCP tools/skills                 | Actual CLI cooperative synthetic workflows verified on versions below                                                |
| Durable requests, responses and action receipts        | SQLite/backend and migrated helper/gateway/media ledgers; replay/restart tests                                       |
| Visible state, local Stop, revocation/disconnect       | Implemented with fail-closed policy tests; physical lock/sleep/Stop verification required                            |
| iMessage completion result                             | Durable queued adapter and simulated result verified; live handset result pending                                    |

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
