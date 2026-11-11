# Agent connectors

ClawdTime 0.1.0 implements project-scoped stdio MCP tools and a bundled CLI for
cooperative attention in Claude Code and Codex. It leaves the coding task in the
client and never types into an arbitrary terminal or takes over a desktop chat.

## Verified compatibility — November 11, 2026

| Surface                              | Installed version                       | Evidence                                                                                         |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Claude Code terminal CLI, print mode | 2.1.311                                 | Real model invoked MCP request, consumed synthetic feedback, acknowledged, resumed and completed |
| Codex terminal CLI, exec mode        | 0.166.0-alpha.5.1                       | Same sequence using actual installed CLI and model                                               |
| Interactive terminal clients         | Same configuration implemented          | Interactive approval/reload and physical call acceptance still required                          |
| Desktop/IDE clients                  | Project MCP configuration may be shared | Not physically qualified; no arbitrary session takeover                                          |

Both real-client probes ran against the actual ClawdTime domain and SQLite store,
with `SimulationTransport` and explicitly synthetic human feedback. Each produced
one simulated call and one simulated Messages result, with the observed tool
sequence `register → yield → request → result → ack → resume → complete`.
These are **not phone, screen, voice, CUA or handset delivery receipts**.

Commands (run from the ClawdTime source checkout after `npm ci`):

```sh
npx tsx tests/connectors-spike.ts claude-code
npx tsx tests/connectors-spike.ts codex
npx vitest run tests/connectors.test.ts tests/connectors-mcp.test.ts
```

The probe creates a disposable local project, temporary owner-only credentials and
a loopback backend. It never edits installed user configuration. It uses the
signed-in client's current default model. The Claude invocation permits only the
fixture MCP tools; the Codex invocation supplies an approval override only for the
temporary simulated MCP server. These overrides are not installed by `connect`.
The first Codex probe without this temporary grant correctly refused execution
under noninteractive `approval_policy=never`. Real users retain their native tool
approval flow. The first Claude probe exposed an overbroad synthetic response
fixture rejected by strict backend validation; the corrected probe passed.

## Connect an existing project

Complete the private Mac pairing page first and download its connection JSON.
The file contains a credential: never paste it into a chat or shell argument.
Build this pinned local checkout; npm package ownership/publication is unverified,
so **do not run an assumed `npx clawdtime` package**.

```sh
npm ci
npm run build
node /absolute/path/to/clawdtime/dist/cli/main.js connect --agent codex --project /absolute/path/to/your/project --pairing-file /absolute/path/to/connection.json
```

Use `--agent claude-code` for Claude Code. Without `--pairing-file`, the command
prompts for the downloaded file's path. It protects that file with mode 0600,
checks backend readiness and installed client version, and stores the credential
under `~/.local/share/clawdtime/connections/`. `CLAWDTIME_CONFIG_HOME` is supported
for isolated test installations. It is a local storage override, not a credential.

The command adds only its own entry to `.mcp.json` (Claude Code) or
`.codex/config.toml` (Codex), plus the ClawdTime skill in `.claude/skills/` or
`.agents/skills/`. Existing unrelated settings are retained. An existing ClawdTime
entry or skill is never silently overwritten. Configuration contains a command
and file path, never the credential. No sandbox, tool-approval or native permission
policy is changed. Restart/reload the project in the client and approve its MCP
server under the client's normal project-trust policy.

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js doctor --agent codex --project /absolute/path/to/your/project
```

`doctor` checks scoped backend readiness and local configuration presence. It is
not evidence of Mac permissions, display readiness, call delivery or a working
handset. A connection registration is not an automatic blocked-process detector.

## Session identity and reconnects

Every MCP process gets its own random local session identity. This prevents two
simultaneously opened chats in the same project from sharing answers. Tokens are
bound by the backend to the pairing, project, adapter, host and session, and are
kept in owner-only run files. A different project/adapter cannot load a connection.

For a run that must survive MCP process reconnects, launch the ordinary client
through the bundled wrapper:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js run --agent codex --project /absolute/path/to/your/project
node /absolute/path/to/clawdtime/dist/cli/main.js run --agent claude-code --project /absolute/path/to/your/project
```

It prints a non-secret local run ID and passes it only to that client's MCP process.
Recover with `--run-id ID` **and the native client's exact resume arguments** after
stopping the original client. A process lock prevents concurrent use of a run.
Do not reuse a run ID for another chat. An ordinary client started without this
wrapper can still complete an attention workflow, but its new MCP process after
restart receives a new identity and cannot read the old process's responses.
Those responses remain durable on the backend; never redial to replace them.
Automatic client-to-thread rebinding is deliberately not claimed.

## Cooperative tool contract

- `connection_status`: scoped readiness, local run ID and current session.
- `yield_control`: explicit attestation that background actors have stopped; the
  backend records this session as yielded. The agent must stay paused.
- `request_attention`: stable `taskId` and `idempotencyKey`; request/call receipt is
  durable before dispatch. Retries with the same input return the original request.
- `attention_status` and `attention_result`: non-consuming reads. Result polling
  waits at most 20 seconds, with bounded HTTP requests and a 40-second Codex limit.
- `acknowledge_response`: records delivery to the exact session; this is not actual
  continuation or native approval.
- `resume_agent`: requires acknowledged response, current control epoch and released
  control. Unknown actions block continuation until reconciliation.
- `complete_attention`: queues one factual result to the same Messages conversation.

ClawdTime does not forcibly suspend arbitrary native/background processes. The
supported mode is a cooperative agent with all conflicting work stopped before
`yield_control`. Do not permit CUA when that condition cannot be established.
The skill forbids shell/file/computer mutations and delegation while yielded.
Native approval policy still decides whether subsequent agent operations may run.
A spoken “yes” is not a global permission bypass.

## Disconnect and uninstall

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js disconnect --agent codex --project /absolute/path/to/your/project
```

Disconnect revokes the pairing at the backend before removing owned local config,
skill and credentials. The pairing is shared with other sessions: revocation
invalidates those too. Changes made to the installed ClawdTime config/skill are
preserved for manual review instead of being overwritten. If cleanup stops after
remote revocation, `uninstall` can finish cleanup once the local edits are resolved.
Offline uninstall is refused while remote access remains unrevoked. Do not simply
delete credentials as a substitute for revocation.

## Source and documentation decisions

The connectors are new ClawdTime code, not copied from Apple Teams. Current official
references were fetched on November 11, 2026:

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
  supports stdio commands, project `.codex/config.toml` and bounded tool timeouts.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) provides explicit
  thread/turn APIs. Their existence does not establish control of an already-open
  desktop chat; the MVP uses cooperative MCP instead.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp) documents project entries,
  client approvals and tool lifetimes. Bounded polling avoids relying on indefinite
  tool calls or experimental background task behavior.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) were reviewed. The MVP
  does not install broad approval/completion hooks or claim universal interception.

No Cursor/OpenClaw adapter, desktop-session takeover, or automatic permission hook
is part of this release. Full physical acceptance and clean tester onboarding
remain separate gates in DEMO_ACCEPTANCE.md and STATUS.md.

## Connector liveness

The stdio server sends an immediate authenticated session heartbeat and then one
every five seconds, with no overlapping request. Closing stdio stops the timer.
After twenty seconds without a heartbeat the backend stops the session and begins
call/control cleanup. Late heartbeats or a reused run identity cannot resurrect
that stopped session. Response reads do not extend it. Start a new native client
session after terminal loss and reconcile old effects; do not replay attention.

## Actionable live readiness and supervised acceptance preparation

`doctor` now reports `readiness.status`, `connectionReady`, `liveReady`, individual
checks and next actions. A paired account or old `ready:true` flag cannot establish
line/media/helper readiness. Live evidence must be fresh (30 seconds), and all
reported checks must pass. Local checks verify the installed project entry, compiled
launcher, scoped skill and current agent version. Changed configuration is reported
and preserved. The backend reads provider/helper evidence separately; doctor does not
place calls or grant permissions. Physical acceptance remains a separate observation.

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js doctor --agent codex --project /absolute/disposable/project --require-live true
node /absolute/path/to/clawdtime/dist/cli/main.js acceptance-plan --agent codex --project /absolute/disposable/project --case-id codex-screen-feedback --output /absolute/private/codex-acceptance.json
```

`doctor --require-live true` exits 2 unless ready for a supervised live attempt.
Default simulation doctor can exit 0 while clearly labeled `simulation_only`;
failed local configuration or blocked live readiness exits 2. MCP `request_attention`
also checks readiness before dispatch and refuses unready non-simulation backends.
No client changes routing, permissions, local arming or live gates to fix readiness.

`acceptance-plan` is inert: it writes a private JSON plan and `.prompt.txt`, and prints
an ordinary interactive-client launch command as a command/argument array. It does
not launch the client, invoke a tool or call a phone. The plan preserves one run ID,
task ID and idempotency key for that case. The lead resolves readiness and completes
the controlled handoff, launches the intended client, then pastes the saved prompt.
Use `--agent claude-code` and a separate case/output for Claude Code.

The prompt checks the exact local run identity, yields control, requests one call,
waits for actual feedback/CUA, acknowledges the response and current control epoch,
resumes under native policy, writes a disposable result file, and queues a factual
Messages recap. It never supplies synthetic human feedback. The operator records
actual handset observations, native receipts and delivery separately. A completed
request or queued message is not itself handset delivery.

Both real synthetic CLI probes now also assert that the backend's registered session
matches the wrapper's exact run ID. This passed for the recorded Claude/Codex versions.
No actual live acceptance was performed by these probes or plan preparation.
