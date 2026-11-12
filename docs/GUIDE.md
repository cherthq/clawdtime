# ClawdTime pilot guide

The deployed backend/media/gateway use the agent-owned v2 protocol. Companion
0.2.1 and the installed skill include the native-control repair. The existing
coding session receives human turns, uses its normal tools and supplies spoken
replies; it remains active during sharing. Legacy v1 behavior is documented
separately in [CONNECTORS.md](CONNECTORS.md#legacy-v1-setup-and-recovery-reference).

One real Codex desktop task passed: a spoken request drove native typing and a
send in Messages, and the human confirmed seeing it on the handset. Both CLI
clients passed synthetic multi-turn tests. Claude physical use, ClawdTime fallback,
reconnect and calls beyond five minutes remain unqualified. A screen timeout near
the latest intentional hangup remains a long-duration reliability observation.
See [STATUS.md](STATUS.md) for exact versions, checks and limits.

## Set up once

1. Use [Text it](https://www.clawdtime.com) from the invited handset and paste the
   returned setup prompt into the coding chat you want to keep using.
2. The agent uses the trusted local build to prepare the companion and project
   integration. Public npm installation and notarized downloads are not ready.
3. Grant Screen Recording and, for computer input, Accessibility. Choose the
   selected display and control mode, then click **Enable locally** in the panel.
4. Authorize one call in that same chat. Installation, pairing and local Enable
   are separate from permission to call. During the call, speak naturally and
   let each short spoken reply finish before answering.

An existing pairing can be reused; its old call/session must be terminal and its
receipts preserved. Never reclaim a consumed setup link or reuse a stopped run.
General work initiated from Messages and inbound FaceTime are future features.
The skill is invoked cooperatively, not an automatic interceptor for every blocker.

## Native tools and the Control Panel

The native Control Panel shows the paired connection, coding project/session,
selected display, permissions, sharing state, active call and executor/progress.
It provides local Enable/Stop, mute, end call and pause request. Calling, viewing
and input remain separate. The local policy is authoritative:

| Mode                                | Input allowed                                                    |
| ----------------------------------- | ---------------------------------------------------------------- |
| View only                           | None; conversation and viewing can continue.                     |
| Agent tools only (default)          | The current coding chat's verified native tools.                 |
| Agent tools with ClawdTime fallback | Also the same agent's ClawdTime observe/click/type/scroll tools. |

Native input uses the ordinary tool in the coding chat after exclusive ownership
is acquired. The tool must operate the actual shared display or visible browser;
a hidden browser context does not qualify. The tested native tool blocks the
Codex app itself, so use a permitted target such as TextEdit or Messages.

Fallback requires an image-capable MCP connection and explicit local enablement.
The foreground bridge supports native coordination and conversation, but refuses
fallback screenshots/input. Neither fallback nor unavailable native tools select
a second conversational model. Unknown input blocks unsafe handoff or replay.
Local Stop ends ClawdTime capture/input immediately; native cancellation is
cooperative and depends on the tool. Ordinary file work needs no input ownership.

## Use the trusted internal build

Requirements: Node 24+, macOS 14+, and the configured companion/gateway. Building
the Mac app additionally needs Swift 6/Xcode tools; media/gateway use Python 3.12+.
Personal setup links are credentials: keep them in private owner-only files.

```sh
npm ci
npm run build
node /absolute/path/to/clawdtime/dist/cli/main.js setup --agent codex --project /absolute/path/to/project --setup-link-file /absolute/private/setup-link.txt --origin https://TRUSTED-SERVICE --allow-view true --allow-control true --pilot-installed true
```

Use `claude-code` for that adapter. Permission flags reflect actual user choices.
`--pilot-installed true` applies only to the approved internal app. For an existing
connection, use `--existing true` instead of the setup-link option; do not recreate
pairing to work around a receipt or permission problem. [Mac installation](../mac/README.md)
and [deployment operations](DEPLOYMENT.md) cover provisioning. Keep the installed
signing identity stable; ad-hoc rebuilds can break macOS permission recognition.

## A call in this same chat

Read the installed skill. Verify the native tool and intended shared surface before
registration; capabilities are immutable for that run. For a verified desktop tool:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-session --agent codex --project /absolute/path/to/project --run-id FRESH_STABLE_CURRENT_CHAT_ID --native-control desktop --shared-surface true --native-cancellation false
```

Use `browser` only for a verified visible browser, or `none`/`--shared-surface false`
when no suitable tool is available. These are capability declarations, not consent.
Keep this foreground JSONL process and stdin alive; it is a bridge, not another
coding agent. Do not rely on MCP hot reload or launch a replacement chat.

1. Read `status`: confirm live readiness, protocol 2 and actual capabilities.
2. `invite` sends an informational setup notice. `authorize` binds actual one-call
   user consent to the returned test ID. `start` places that one call. V2 does not
   use legacy global yield/resume.
3. Poll `conversation_turns` with the exact request and ordered cursor (at most
   20 seconds per poll). Acknowledge delivery separately. Adjacent speech fragments
   can form one instruction; process them in sequence rather than executing a
   later fragment ahead of unfinished earlier ones.
4. Report progress and use ordinary tools. For shared-screen input, inspect
   `execution_status`, claim `native` using the current epoch with conflicting
   actors stopped, perform and observe the native action, then release to `none`
   with its truthful outcome. Unrelated file work can continue while sharing.
5. Supply a concise `conversation_reply` with stable turn/reply IDs. Let playback
   finish before another reply; uncertain speech is read/reconciled, never replayed
   under a new ID. Mark completed work accurately and continue polling.
6. End explicitly with `end_conversation` when requested; confirm call/capture/
   lease cleanup before closing the bridge. A new call needs fresh approval.

See the [operation reference](CONNECTORS.md#operations-and-lifecycle) for exact
arguments and the [short filmed demo](FILMED_DEMO.md) for one simple scenario.
There is no automatic v2 completion-message promise: return results through the
chat/call, and send Messages only when specifically requested through available
native tools. Legacy v1 has its own completion recap operation.

## Architecture and privacy

The coding chat connects through scoped MCP or the foreground bridge to the
ClawdTime backend. Calling and speech use the media service; the paired Mac sends
transient screen frames through its outbound authenticated gateway. The helper
listens on loopback (or an explicitly configured private route). Tailscale is
optional. One backend owns the SQLite pilot and dedicated line.

V2 uses the originating agent for reasoning; it does not invoke ClawdTime's legacy
standalone conversation model. Legacy provider/model configuration applies only
to the explicitly versioned v1 controller; see [ARCHITECTURE.md](ARCHITECTURE.md).

Screens/raw audio are transient. Turn text has bounded retention and is redacted
after terminal handling; scoped call/action/reply receipts remain for reconciliation.
No screen text, incidental speech, echo or silence grants new permission. Preserve
native client approvals, local Stop, selected-display binding and unknown outcomes.
The audited legacy migration closes proven old ownership without erasing original
receipts or inventing application success. It is not an automatic clearing path
for new unknown actions.

## Development and validation

```sh
npm ci
npm run dev                 # loopback :3310, simulation by default
npm run demo                # synthetic legacy v1 attention/feedback/control/result flow
npm run check               # TypeScript, behavior tests, build
npm run test:onboarding:browser
npx tsx tests/connectors-conversation-spike.ts claude-code
npx tsx tests/connectors-conversation-spike.ts codex
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
