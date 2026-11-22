# Agent connectors

Current as of November 12, 2026. The v2 backend/media (`8efbacc`) are deployed;
the installed companion is 0.2.1 (`d10c801`) and the project skill is updated. One
voice-directed native Messages task passed in the originating Codex desktop chat
through the foreground bridge. See [STATUS.md](STATUS.md) for the release and
physical evidence; the client/surface limits below still apply.

## Agent-owned protocol v2 (default for new sessions)

ClawdTime transports human turns and speaks replies authored by the exact existing
coding session. It does not start a replacement agent or silently use the legacy
standalone conversational model. New MCP and foreground bridge registrations send
`protocolVersion: 2`. Existing protected runs preserve their recorded session and
capabilities; missing protocolVersion means v1. `--protocol-version 1` explicitly
selects compatibility for a new run. Never migrate an active call in place.

The implementation uses supported request-driven stdio MCP polling, bounded to
20 seconds. It does not promise unsolicited message injection, arbitrary desktop
chat takeover, background resumption, or interrupting a running native tool.
While a poll/tool is outstanding, new human speech waits as an ordered turn. The
agent must keep its own conversation loop engaged. Native tool approvals are
unchanged. Speech playback remains half duplex; full-duplex barge-in is unverified.

### Operations and lifecycle

MCP and foreground JSONL share operation names and validation, except fallback
image/input operations: the foreground bridge refuses `observe_shared_screen`,
`act_on_shared_screen` and claiming the `clawdtime` executor because JSONL has no
transient native image channel. Use a suitable native tool or an image-capable MCP
connection qualified before the session; never replace a live session to bypass
an unresolved outcome. MCP observations return native image content, not base64
text or a file.

| Operation               | Arguments and meaning                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation_turns`    | requestId, after sequence (default 0), waitSeconds (0–20). Returns ordered turns, cursor and existing reply receipts. Reads never consume. Re-read from an earlier cursor to reconcile changed outcomes. |
| `acknowledge_turn`      | requestId, turnId. Delivery acknowledgement only; does not execute, complete, stop sharing, or end call.                                                                                                 |
| `conversation_progress` | requestId, turnId, state: executing, pending_approval, completed, canceled, uncertain. Never report a native tool as canceled/completed without evidence.                                                |
| `conversation_reply`    | requestId, turnId, stable replyId, text ≤900 characters, expectedCursor from the latest poll. One reply per turn; stale context is rejected before speech. Reconcile existing receipts without replay.   |
| `cancel_turn`           | requestId, turnId. Cooperative cancellation; running tool outcomes may remain unresolved.                                                                                                                |
| `end_conversation`      | requestId. Explicit conversation/call cleanup; inspect final receipts.                                                                                                                                   |
| `execution_status`      | requestId. Current executor, epoch and unresolved state.                                                                                                                                                 |
| `transfer_execution`    | requestId, expectedEpoch, executor (native, clawdtime, none), previousOutcome (idle, completed, uncertain), backgroundActorsStopped:true. Exact ownership transfer, never recovery from unknown input.   |
| `observe_shared_screen` | requestId, epoch. Transient observation under current fallback permission and ownership.                                                                                                                 |
| `act_on_shared_screen`  | requestId, epoch, stable actionId, fresh frameId, action. Existing `kind: click` x/y, `kind: type` text, or `kind: scroll` x/y/deltaY. Receipt is not proof of intended UI success.                      |

REST uses `/api/attention/:id/conversation/turns?after=N` and POST siblings
`ack`, `progress`, `reply`, `cancel`, `end`, `execution`, `observe`, `act`.
GET `execution` reads ownership. REST callers still need the exact session bearer.
No new global credential or automatic authorization is introduced.

Before replying or performing an external action, drain a zero-wait poll and
acknowledge all queued continuations/corrections. A new reply requires the latest
`expectedCursor` and no unacknowledged turns. Older clients omitting the cursor
can reply only when their target is the latest turn and all turns are acknowledged.
An HTTP 409 `reply_context_stale` reserves no receipt and submits no speech: read
the new context before deciding what to say. An existing receipt remains
reconcilable with its original arguments after more turns arrive. `reply_exists`
means reconcile that turn's original reply, never replace it with another ID.
Native tool approval and execution ownership remain separate requirements.

Readiness now includes `setup_reservation`. For v2, a terminal request stops
blocking a fresh same-chat run only after call, media, effect, lease and input
cleanup are confirmed. Expiry alone cannot release an unresolved call or
invitation. Setup creation and direct call start check the same reservation
predicate; only the exact approved setup test can start its reserved call.
History is preserved. A structured `setup_reserved` conflict tells the connector
to reconcile cleanup, without exposing arbitrary server errors or retrying a call.

Acknowledge turns in order, report execution, use normal tools and publish replies,
then poll again. Sharing and the call survive an individual acknowledgement,
reply, and unrelated coding/file work. **Do not use legacy yield/resume for v2.**
Only conflicting shared-surface input needs an executor. Native tools are the
preferred path when they actually address the human's selected shared display.

Fallback is off by default. Native browser control does not establish desktop
control; invisible browser state does not establish a visible shared surface.
New connector capability defaults are `nativeControl:none`, `sharedSurface:false`,
`nativeCancellation:false`. Exact verified adapters may explicitly attest per run
on `mcp` or `setup-session` with
`--native-control browser|desktop --shared-surface true` and, only if proven,
`--native-cancellation true`. These flags record capability evidence, not consent
or permission grants. Reconnecting a run never changes its immutable capabilities. The `run` wrapper
rejects protocol/capability flags because it cannot safely change the client
configuration that starts MCP; it uses the existing owned MCP configuration.
Set explicit v1/capabilities on the MCP command or foreground bridge before the
new session is registered. Newly generated acceptance plans use v2; old plan files
are preserved and rejected rather than silently retargeted.
The native panel's current local policy, revision, pairing, live session, freshness
and executor checks remain authoritative. Existing `allowControl:true` never
becomes new fallback consent.

A native timeout with uncertain effects must be reported as uncertain. Do not
claim release, switch to fallback, replay input or generate fresh IDs. Local Stop
stops ClawdTime capture/input and further delegation; it is not a guaranteed
system-wide kill switch for unverified native tools. Pending/unknown outcomes
remain for reconciliation. Lost heartbeat, pairing revocation and actual hangup
retain terminal cleanup. Reconnect within the live window retains the same session,
cursor and outcomes; stopped sessions cannot be revived with new heartbeats.

The conversation service retains bounded human text for active delivery, removes
text from terminal turns and retains minimal state/IDs/receipts. After a hangup,
a turn not yet acknowledged remains readable by the same live session; it is
content for the original task and carries no call, reply or screen authority. It does not store
a duplicate unrestricted agent context. V2 bridge effects persist a hash/receipt
marker, not speech text, screenshots or observation payloads; replaying a bridge
command returns the marker and asks for a fresh scoped status read. Initial
observations are transient. Raw audio/screens must never enter fixtures or logs.

### Native tools in the current chat

Before registering a new session, identify the native tool and shared surface
available in this same coding chat. Use existing session evidence; inspect the
surface only if its mapping is unclear. For example, an available `cua_repl`
desktop tool may operate the selected shared display, while a hidden browser or a
different display does not. This is not a new tool, replacement agent or universal
claim about Codex/Claude. Native permissions and approval rules remain unchanged.

For a verified desktop surface, the foreground launch is:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-session --agent codex --project /absolute/project --run-id STABLE_CURRENT_CHAT_ID --native-control desktop --shared-surface true --native-cancellation false
```

Use `browser` for a verified visible browser surface, or `none` with
`--shared-surface false` when no suitable surface is verified. Select the actual
adapter. Keep cancellation false unless interruption is known to work. These
flags record capabilities, not permission to act; a viewing exercise can still
record an available native tool. Flags apply to initial `setup-session`/MCP
registration, not pairing `setup` or the `run` wrapper. Check the returned
`status.session.capabilities` or MCP `connection_status` before calling.

After `transfer_execution(executor=native, ...)` succeeds, use the chat's ordinary
native tool directly, verify its result, then release ownership with the current
epoch and actual outcome. Foreground fallback refusal does not prohibit native
CUA. The tested native desktop tool blocks control of the Codex app itself; a
Codex input box is not a supported demo target. Respect that tool restriction and
use an allowed surface for an authorized task. Existing runs retain their original
capabilities: changing flags cannot upgrade them, and an active session must not be patched/replaced to evade a
refusal or unknown outcome. Reconcile it before a later authorized call.

### Foreground setup v2

The existing `setup-session` command stays in this chat and defaults v2 for new
runs. Supply the matching initial native capability flags above and keep its
foreground process/stdin alive. Read `status` to confirm the registered
capabilities, then use `invite` and `authorize` with the exact testId and actual
one-call user authorization, then `start` (without `yield`). Continue with the
conversation operations above, using JSONL command names identical to MCP. Each effect needs a stable `id`; turn/reply/action IDs are
separate durable identities. Unknown effects are never resubmitted. EOF stops
heartbeats and attempts owned-test cancellation once.

Human speech can arrive as several ordered transcript segments for one
instruction. Keep their context in this coding chat, acknowledge in sequence, and
resolve earlier segments before marking a later one executing. A repeated or
trailing fragment does not authorize repeating an already completed action.

Setup `verify` deliberately refuses to apply the old v1 response/resume evidence
chain to v2. Current physical acceptance is recorded from the actual test and
human observations. In the latest separately approved test, this same Codex chat
claimed native ownership, used its ordinary computer tool to send the requested
message once, observed it in Messages and released ownership. The human confirmed
seeing the send on the handset and intentionally hanging up. This qualifies that
native task and observed screen outcome, not recipient readership, every desktop
app, or Claude. The call lasted under two minutes; connection beyond five minutes
remains unqualified. The last spoken reply was canceled during cleanup, so its
complete playback is not established. Earlier v2 replies completed in a separate
voice/viewing test. Each future call still needs its own applicable authorization;
the completed runs and their consent must not be reused.

### Client capability evidence — November 12, 2026

| Client/surface                                                                    | Observed                                                                                                                                                                                                                                                              | Unverified or unsupported boundary                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex desktop, originating chat with foreground v2 bridge and native desktop tool | Live voice segments reached the same chat; native ownership claim → one requested Messages send → observed UI result → release. Human confirmed visible send on handset and intentional hangup. Earlier same-chat v2 voice/viewing test had completed spoken replies. | Tested tool blocks the Codex app itself. Latest call under two minutes; no >5-minute qualification. Last reply canceled at cleanup. Native interruption and live client reconnect remain unverified. |
| Codex CLI 0.166.0-alpha.5.1 (`exec`, disposable project, read-only sandbox)       | Three synthetic ordered MCP turns, two context-preserving replies, native disposable file read, explicit end.                                                                                                                                                         | No physical CLI call/shared-input qualification; desktop evidence does not qualify the CLI.                                                                                                          |
| Claude Code 2.1.311 (`-p`, isolated MCP configuration, native Read tool)          | Same synthetic three-turn/two-reply sequence with native Read and retained context, explicit end.                                                                                                                                                                     | No Claude physical call, visible control, native cancellation or live reconnect qualification.                                                                                                       |
| Codex IDE and other interactive/desktop client surfaces                           | Integration uses that existing chat's available MCP or foreground bridge; no arbitrary chat takeover.                                                                                                                                                                 | Each surface needs its own evidence. The tested Codex desktop chat does not establish universal native tools or permission support.                                                                  |
| ClawdTime fallback through image-capable MCP                                      | Implemented scoped observation/input, explicit local opt-in and durable receipts; deterministic local tests.                                                                                                                                                          | Not physically qualified. Foreground JSONL has no fallback image/input/ownership path; it can coordinate native tools.                                                                               |

`tests/connectors-conversation-spike.ts` is an opt-in disposable real-client
feasibility probe (`npx tsx tests/connectors-conversation-spike.ts codex` or
`claude-code`). It does not call phones, use capture/input, change installed
configuration, or retain transcripts. Its MCP fixture models sharing as a boolean;
that is explicitly synthetic, not video evidence. The checked-in MCP integration
regression additionally reconnects the connector with the same run and proves
ordered delivery, separate ack/execution, session isolation and no repeated speech.
The native tool's Codex-app denial was observed in the desktop test. Broader
native approval behavior, physical cancellation and live reconnect remain
acceptance items; no approval policy is weakened by installation.

Official references checked for the supported request/permission boundaries:
[Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP](https://code.claude.com/docs/en/mcp), and
[Claude Code permissions](https://code.claude.com/docs/en/permissions).
These establish MCP configuration and native policies, not physical acceptance.
Capability claims above rely on the separately listed tests and human observations.

## Legacy v1 setup and recovery reference

The remainder is the historical v1 workflow/reference, including its dated
compatibility evidence and pairing/recovery operations. Its
yield/result/ack/resume/completion sequence applies **only to v1**; use the v2 sequence above for new default sessions. Legacy capabilities are not
silently upgraded, and the standalone controller is never used as a hidden v2
fallback.

ClawdTime 0.1.0 introduced project-scoped stdio MCP tools and a bundled CLI for
cooperative attention in Claude Code and Codex. It leaves the coding task in the
client and never types into an arbitrary terminal or takes over a desktop chat.

### Prompt-driven setup in the current chat

Setup stays in the coding chat that received the user's request. It requires no
coding-client restart, new chat, child coding agent or manual pairing JSON download.
The installed project MCP configuration/skill remains available for future use;
the current chat uses a foreground JSONL command bridge through its own shell tool.

The setup URL is a short-lived one-use pairing authorization, not a global service
credential. The agent writes it to a private owner-only file using native file
tools, without echoing it or placing its token in a command argument/history. The
caller supplies an independently trusted HTTPS origin. The canonical setup origin
is `https://www.clawdtime.com`. The legacy Railway origin,
`https://backend-production-ee686906.up.railway.app`, remains compatible for existing
links and connections; use the independently trusted origin matching the supplied
link. Only `/setup` (or legacy `/pair`) with fragment `token`, `device` and `display`
is accepted. Redirects, query credentials, duplicate fields and a different origin
are rejected.

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup --agent codex --project /absolute/project --setup-link-file /absolute/private/setup-link.txt --origin https://www.clawdtime.com --allow-view true --allow-control false
```

Use `--agent claude-code` for Claude Code. Explicit view/control flags must reflect
the user's permission. `--allow-control false` pairs view only. The claim intent is
saved before its single HTTP attempt; its result is saved mode 0600 before any
configuration. Interrupted/unknown claims are never automatically retried. The
lead must reconcile the saved checkpoint. A successful checkpoint is reused safely.

The first test requires screen sharing and feedback by voice or text, followed by
same-chat continuation and a Messages recap. It does not require a clicking,
typing, scrolling or AI-control exercise. Request control only if the user wants
that capability; enabling it is not permission to exercise it during setup.

For an existing authorized connection, omit the link and use `--existing true`:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup --agent codex --project /absolute/project --existing true --allow-view true --allow-control true --pilot-installed true
```

`--pilot-installed true` is an explicit trust choice for the already-installed
local ad-hoc pilot bundle. It is never injected automatically. Official release
setup instead accepts `--manifest LOCAL_MANIFEST --trusted-team-id TEAM_ID` where
the signing team is obtained independently from that manifest. Optional `--app`,
`--directory`, `--relay-url` and `--gateway-python` select local companion inputs.
`--check-only true` makes the companion phase read-only; pairing/CLI configuration
still follow the requested setup operation. The Mac script never silently enables
permissions, arms a device, starts a helper or replaces the running pilot.

The structured result includes the local companion report plus remote readiness
and config-integrity checks. A backend failure retains the actionable companion
report. Existing unchanged owned skills can upgrade safely; user-modified skills
and configuration are preserved and reported. An interrupted installation marker
does not count as installed: missing files fail the local checks. Resolve the exact
reported issue in this chat, using its native question/user-input tool for human
permission/local Enable steps. Ask an ordinary question only if that client lacks
such a tool. Do not end the interaction or call setup complete while waiting.

#### Existing Mac, fresh line pairing

An installed companion can be reused, but a pairing belongs to its original line,
member, device and display. A fresh line requires its own newly texted setup link.
`--existing true` means the same pairing, not merely the same app or project.
The CLI refuses a fresh link over a prior connection/checkpoint; the companion
also refuses replacing a different claimed binding. Neither token is transferable.

Before the lead replaces an old project's owned entries, preserve its protected
connection/run checkpoints and companion configuration/receipts, and establish
known cleanup and revocation of the old authorization. The normal `disconnect`
command revokes and removes its local connection directory, so archival must
precede it. Do not delete an unknown claim, use another config root to bypass an
owned project entry, or rewrite the old token. This migration is an operator
prerequisite, not something the setup prompt silently performs.

After the lead has prepared that clean project binding, the fresh setup command
can reuse the existing explicitly trusted pilot app and a new private companion
directory:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup --agent codex --project /absolute/project --setup-link-file /absolute/private/new-line-setup.txt --origin https://www.clawdtime.com --allow-view true --allow-control false --pilot-installed true --app "/absolute/ClawdTime Companion.app" --directory /absolute/private/new-companion --relay-url wss://TRUSTED_MEDIA_ORIGIN/device-gateway --gateway-python /absolute/path/to/clawdtime/gateway/.venv/bin/python
```

Use the actual trusted link origin if it is the compatible legacy origin. Keep
the same permissions when rerunning `setup --existing true` with the same companion
arguments. Setup prepares configuration, not a running gateway: the lead must
stop the old owned helper/gateway, preserve their state, provision the new device
gateway mapping, and activate the new configuration without concurrent ownership.
The installed app needs an explicit `--config NEW_DIRECTORY/helper.json` launch
for a nondefault directory; ordinary Quit/Reopen does not select it. Follow the
companion report for native permission and local Enable steps. No reinstall or
TCC reset is implied. See [device setup](DEVICE.md) for the Mac-owned procedure.

Then run the foreground `setup-session` below in this same coding chat, with a
fresh stable run ID for this authorized attempt. No native client restart, new
chat, `run` wrapper or separate acceptance client is needed. Preserve old runs;
do not revive a stopped one. The installed project skill remains reusable after
setup. Codex discovers project skills from `.agents/skills`; in a multi-folder
desktop project, automatic discovery uses the primary folder. The current chat
can read the installed skill directly and use the bridge without claiming MCP
hot reload. [Official skill guidance](https://learn.chatgpt.com/docs/customization/overview#skills),
[project discovery](https://learn.chatgpt.com/docs/projects#use-local-projects-for-folders-and-codebases).

#### Foreground setup-session protocol

Choose and retain one non-secret run ID for this existing chat (16–100 letters,
digits, underscores or hyphens), then use the chat's persistent shell process tool:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-session --agent codex --project /absolute/project --run-id current-chat-unique-identifier
```

This starts only a Node command bridge. It does not spawn Codex, Claude, a shell
executor, another agent or a daemon. Retain its shell process handle and keep stdin
open. For a PTY-based shell tool, send JSONL lines with its write-stdin operation;
ignore terminal input echo and parse the JSON response objects. Do not use a closed
pipe, `nohup`, background daemon, new coding chat or client restart. The ready event
contains the exact localRunId/sessionId. Heartbeats run every five seconds while
the foreground process lives; backend expiry remains authoritative after loss.

Each input is one JSON object per line. Responses are `{id,ok,result}` or
`{id,ok:false,error,retryPolicy}`. Use stable IDs for effects and fresh IDs for
repeated status reads. The bridge does not accept shell commands or arbitrary URLs.

```jsonl
{"id":"status-1","command":"status"}
{"id":"invite","command":"invite"}
{"id":"status-2","command":"status"}
{"id":"authorize","command":"authorize","args":{"testId":"RETURNED_TEST_ID","userAuthorizedCall":true}}
{"id":"yield","command":"yield","args":{"backgroundActorsStopped":true}}
{"id":"start","command":"start"}
{"id":"result-1","command":"result","args":{"requestId":"RETURNED_REQUEST_ID","waitSeconds":20}}
{"id":"ack","command":"ack","args":{"requestId":"RETURNED_REQUEST_ID","responseId":"RETURNED_RESPONSE_ID"}}
{"id":"resume","command":"resume","args":{"requestId":"RETURNED_REQUEST_ID","controlEpoch":0}}
{"id":"complete","command":"complete","args":{"requestId":"RETURNED_REQUEST_ID","text":"Factual result after this same chat resumed."}}
{"id":"verify","command":"verify"}
```

These are sequential examples, not a script to blindly feed at startup. `invite`
queues one informational setup notice; it does not call or require a handset code.
New tests use `approvalMode=native_session`. Once the user has explicitly authorized
this one call in the originating coding chat, send `authorize` with that exact
test ID and `userAuthorizedCall:true`. Honor existing explicit authorization without
asking again. Never infer it from setup intent, readiness, silence or a previous
call's permission. If it is missing, ask through the native question tool before
calling. Backend approval records `approvalSource=native_session`; it is a client
attestation of the actual user's request, not independent SMS evidence.

The command is bound to the current unexpired test, session and pairing. It has a
durable stable intent and cannot authorize a consumed or replacement test. Only
backend `test.state=approved` permits start; legacy stored tests retain their old
SMS approval semantics. The backend also requires the informational notice's
confirmed receipt before starting a live test. Stop/join conflicting actors before
`yield`; `start` requires that same yielded session. Only the lead initiates the
live pilot. A closed test cannot be replaced by choosing another run. Call request
IDs remain backend-stable; no confirmation change permits replaying unknown effects.

`result` waits at most 20 seconds of polling (each HTTP request has its own 12-second
deadline). Check exact request/session, feedback and released control receipts;
replace the example epoch with the actual current controlEpoch. While yielded,
perform only bridge status/diagnostics/result/ack/resume/cancel/terminal-ack and
nonmutating human questions, plus the explicitly authorized `authorize`/`start`
transition for this setup test. These exceptions permit no coding or local UI work.
After successful `resume`, perform the authorized native continuation, then send
`complete` once. A queued result is not handset delivery. Only `verify` returning
`test.state=verified` establishes the backend's real call + observed screen +
acknowledged human feedback + continuation + Messages delivery evidence chain.
Simulation cannot verify. Physical click/type/scroll/AI-action qualification is
additional evidence; this setup test does not silently establish all CUA coverage.
The human describes screen visibility in their own words. The conversation service
can record `screenVisible` only from authentic feedback bound to this call; the
coding agent must not submit or invent that evidence. A model interpretation is
not proof that video rendered. Verification still requires actual capture, qualified
call, human feedback, acknowledged continuation and a confirmed Messages receipt.
Negative or unclear feedback cannot pass by being rewritten into a positive phrase.

#### Natural conversation during the call

The human speaks or texts ordinary requests, such as “click the textbox,” “scroll
down a little,” “I can see the page,” or “use the blue version and continue.” No
command prefix, wake phrase or prescribed confirmation sentence is needed. A
visibility report does not itself request agent continuation. Each computer action
still needs human direction, explicit paired control permission, fresh-frame checks
and a single-action receipt. Observation does not prove application success or
correct focus; visually verify the intended textbox before typing. Local Stop and
conversation Stop remain authoritative. Suggest landscape orientation when useful.

Keep the coding chat/bridge active, but conduct in-call dialogue through the phone.
Do not open a native question UI on the shared Mac or refocus the coding client
while CUA is active. Use the native question tool for pre-call setup/permission
steps. Qualified remote voice and authenticated Messages share the conversational
intent path; a screen, transcript, model output or unrelated participant cannot
supply permission. Continuous video is a presentation requirement, not permission
to issue another action while an input or release outcome is unknown. These are
implementation contracts; physical qualification remains recorded separately in
`docs/STATUS.md` and `docs/DEMO_ACCEPTANCE.md`.

For a missing screen or failed media phase, inspect read-only bounded diagnostics
without stopping the bridge or continuing conflicting work:

```jsonl
{
  "id": "diagnostics-1",
  "command": "diagnostics",
  "args": {
    "requestId": "RETURNED_REQUEST_ID"
  }
}
```

This GET is bound to the exact current setup test request. It creates no effect
intent and changes no run/checkpoint state. The backend returns phase metadata,
without screenshots, audio or chat content. It is permitted while yielded like
status/result polling. Diagnostic phases are observations, never authorization to
type, click, scroll or request an AI action; those inputs remain human-directed.

Each registration and effect intent is protected before HTTP. A repeated completed
command ID returns its stored result, without another effect. Unknown results
require `status`/`result` reconciliation; a changed ID cannot retry the same setup
operation. Definitive 400/401/403/404/409/422 rejection allows an explicit same-ID
retry after its prerequisite is fixed, including `verify` while delivery is pending.
Never fabricate evidence or change a run to bypass an unknown result. Cancel with:

```jsonl
{
  "id": "cancel",
  "command": "cancel"
}
```

Keep the bridge and chat alive while approval, call, feedback or verification is
pending; never recommend a final response/stop as the next setup step. A failed or
canceled call uses an explicit release path before diagnosis:

```jsonl
{"id":"cancel","command":"cancel"}
{"id":"cleanup-status-1","command":"result","args":{"requestId":"ORIGINAL_REQUEST_ID","waitSeconds":0}}
{"id":"terminal-ack","command":"terminal-ack","args":{"requestId":"ORIGINAL_REQUEST_ID","controlEpoch":0}}
```

Poll the original result until cleanup is known, replacing the example epoch with
the current one. Check returned leases/actions; an empty response is not approval.
`terminal-ack` requires a closed unsuccessful request, every owned call/media session
ended, every screen lease released, no pending/unknown dispatch or input, the exact
session and current epoch. The backend rejects unknown outcomes and stopped sessions.
The acknowledgement leaves the unsuccessful request unchanged and returns
`humanApproval:false`; it creates no answer, result message, new call or native
permission. Only after it succeeds may this same chat diagnose the failure. Keep
the heartbeat alive throughout cleanup and diagnosis instead of closing the bridge
to regain control. A definitive rejection can be retried with the same command ID
after its prerequisite is fixed. If the rejected epoch was wrong, use a distinct
corrective intent ID for the newly observed epoch; an unknown acknowledgement may
never be replaced by another intent.

Once diagnosis is done and no setup work remains pending, or after verified
completion, close stdin. EOF/SIGINT/SIGTERM stops heartbeats
and attempts one owned-test cancellation when applicable. It never repeats an
unknown cancellation; conservative backend expiry/cleanup remains in force. No
daemon remains. A closed run cannot be silently reopened/revived.

If the bridge already closed and the backend session stopped, preserve its receipt
IDs and establish known cleanup with the lead. A recovery attempt is a separately
authorized test, with a new attempt/run ID explicitly recorded against the prior
request in **the same existing native coding chat**. Do not launch another coding
client/chat. Existing test records remain immutable; there is no automatic new
trial, retry loop, migration of an old token or revival of the stopped session.
The user must explicitly approve another test, and the new invitation still
requires its own explicit one-call authorization. Unknown call/input/cleanup
forbids replacement attempts. The narrow operator-audited invitation exception
below does not change those call/control rules.

##### User-requested handoff to another chat

An explicit user request to move the work to a new chat is a narrow exception to
the same-chat recovery rule. It does not transfer the old live session or its
authorization. First establish that the old bridge is closed, its session is
stopped, its call/media are terminal, every lease is released, and no pending or
unknown input/dispatch remains for that attempt. Preserve all old tokens,
checkpoints, receipts and responses. Do not reopen the old run, read an old answer
as the new chat's feedback, repeat pairing/onboarding, change permissions or rearm.

Before any separately approved new test, the lead records an immutable private
audit linking the predecessor request/test/run and cleanup evidence to the
user's handoff instruction and a fresh stable run ID for the new chat. This audit
is an operator prerequisite, not an API that changes old test records. The new
chat uses the existing authorized connection with the ordinary foreground
`setup-session` command; it registers its own session and keeps stdin open.
Fresh explicit one-call authorization is required before its invitation/test
workflow. The previous call's authorization is consumed. Its actual feedback,
continuation and recap must belong to this new attempt.

Do not use `retry` or `setup-retry` for this handoff: those commands only recover
the narrowly retired, never-called legacy invitation described below in its
original live session. If ordinary new-run readiness or ownership guards refuse
the handoff, diagnose the exact remaining state; never rewrite identity fields,
delete receipts or change run IDs again to bypass the refusal.

#### Explicit recovery of an expired legacy invitation

An **expired, never-approved legacy invitation with no call** can have a successor
in the same live session only when the lead has inserted the backend's immutable,
identity-bound retirement audit and the user explicitly authorizes a new invitation.
Retirement retains the original effect as unknown, preserves its receipt and event
cursor, and does not establish either delivery or non-delivery. It never permits
resending that effect. This is not a general retry, a way around an uncertain call
or input, or permission to start another coding client/chat.

After `status` identifies the exact current predecessor, new bridge code accepts:

```jsonl
{
  "id": "retry-invitation-1",
  "command": "retry",
  "args": {
    "previousTestId": "EXPIRED_OWNED_TEST_ID",
    "authorizeNewInvitation": true,
    "operatorRetirementConfirmed": true
  }
}
```

The command refuses a different owner/test, any approval or call request, absent
explicit authorization, missing retirement evidence or failed live readiness.
It persists one stable intent before POST and updates its test binding only after
a valid same-session successor response. Keep the same command ID after a definite
rejection has been corrected; unknown outcomes require read-only status inspection
and cannot be retried under a replacement ID. A new invitation still requires
explicit authorization for this one test from the actual user in the same chat.
Authorization to resend an invitation is not authorization to call. Record the
current test's consent with `authorize`; do not reuse consumed consent. Never invoke
`retry` automatically merely because an invitation timed out.

For a foreground bridge already running code without `retry`, there is no hot
reload. With the same explicit authorization and audit, the lead can execute the
following one-shot helper while retaining the existing bridge process handle:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-retry --agent codex --project /absolute/project --run-id EXISTING_CHAT_RUN_ID --previous-test-id EXPIRED_OWNED_TEST_ID --authorize-new-invitation true
```

This helper verifies the private PID lock, an alive same-user `setup-session`
process whose command includes the exact run ID, protected run/checkpoint identity,
and a fresh matching backend session. It sends only the scoped recovery POST using
the existing session credential. It never registers a session, sends heartbeats,
launches another coding client, stops the bridge or writes the old bridge's files.
A separate fingerprinted owner-only intent records the existing native identity
and predecessor. A lost POST reply is reconciled via GET status; a second POST is
never sent while that outcome remains unknown. Its output explicitly leaves
invitation delivery unverified.

After the helper returns, send `status` to the **original** bridge; that old code
already learns the backend's current test from status. Keep waiting in this chat
for explicit one-call consent, then use its existing yield/start/result flow only
after backend approval. An old bridge lacks `authorize`; it cannot hot reload or
self-authorize. The lead must arrange a reviewed exact-session authorization path
or report that compatibility limitation. Do not call
the old bridge's cached `invite` to learn the successor. Do not close stdin or
restart anything. The one-shot operation is restricted to a live original bridge
and cannot revive a stopped session. The human/lead must keep concurrent mutation
commands out of this narrow recovery window.

`tests/connectors-setup-retry.test.ts` freezes the pre-retry bridge source from
`f57798c`, runs that Node bridge against an in-memory synthetic backend, loses the
accepted retry response, and proves GET-only reconciliation followed by old
status/yield/start on the new test in the same session. It checks unchanged old
checkpoint/run files until the old process handles status, one registration,
unchanged cursor/unknown predecessor, and no restart. These are synthetic protocol
tests, not a native coding-client, live line, delivery or screen acceptance claim.

Validation: `npx vitest run tests/connectors-setup.test.ts` exercises same-process
registration → informational notice → explicit synthetic native-session consent → yield → one simulated
call → feedback → ack/resume → Messages result, along with rejected physical
verification, EOF cleanup and unknown-outcome recovery. It starts no coding client
and does not establish physical acceptance or current-chat native question-tool
qualification; the lead records those actual-client observations separately.

### Verified compatibility — November 11, 2026

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

### Legacy downloaded-file connection (optional)

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

### Session identity and reconnects

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

### Cooperative tool contract

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

### Disconnect and uninstall

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

### Source and documentation decisions

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

### Connector liveness

The stdio server sends an immediate authenticated session heartbeat and then one
every five seconds, with no overlapping request. Closing stdio stops the timer.
After twenty seconds without a heartbeat the backend stops the session and begins
call/control cleanup. Late heartbeats or a reused run identity cannot resurrect
that stopped session. Response reads do not extend it. Start a new native client
run in the same native chat only after known cleanup and explicit new-attempt
authorization; reconcile old effects and do not replay attention.

### Actionable live readiness and supervised acceptance preparation

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

The historical v1 prompt used yield/result/ack/resume and a Messages recap.
Current `acceptance-plan` generates v2 instructions: it checks protocol and exact
run identity, receives ordered turns, uses normal native tools, publishes replies
and ends explicitly. Existing legacy plan files are preserved and rejected rather
than silently rewritten as v2. It never supplies synthetic human feedback.
Actual handset observations, native outcomes and delivery are separate evidence.

This separate-client qualification helper is not required for an existing chat's
foreground bridge. Use the current v2 guidance at the top of this document for
same-chat operation. Control qualification and untested channels remain separate.

Both real synthetic CLI probes now also assert that the backend's registered session
matches the wrapper's exact run ID. This passed for the recorded Claude/Codex versions.
No actual live acceptance was performed by these probes or plan preparation.

### Incoming surfaces and limits

Incoming Messages can establish onboarding and supply authenticated feedback to
an owned active request/call. They do not create arbitrary coding tasks in a
desktop chat or resume a stopped agent session. The skill is cooperative: the
active coding agent invokes its tools when attention is needed; it does not
intercept every native approval automatically. User-initiated inbound FaceTime
is not the supported setup path. Mode 2, which starts work from the phone, remains
deferred.

The outbound setup test must record actual handset screen rendering, the feedback
channel used, same-session continuation and Messages delivery. Passing it does not
qualify CUA, the other feedback channel, all client surfaces, or inbound FaceTime.
Voice currently uses half-duplex replies: listening pauses while the service
speaks. Local Stop and supported phone Stop remain available; voice barge-in while
speech is playing is not claimed.

# Independent coding task CLI (coding demo, step a)

`npm run cli -- task help` exposes the dedicated local task service. It does not
attach to the original Codex chat or reuse the original-chat connector credential.
The service defaults to `http://127.0.0.1:3320`; select another loopback origin with
`CLAWDTIME_TASK_URL`. Keep service credentials in the environment or an owner-only
session file, never command arguments.

With an explicitly selected pairing, host, project and operator credential in
`CLAWDTIME_TASK_TOKEN`, register an independent session:

```sh
npm run cli -- task register --pairing-id PAIRING_ID --host-id HOST_ID \
  --project /absolute/selected/project --event-id register-1 \
  --save /absolute/private/task-session.json
npm run cli -- task create --session-file /absolute/private/task-session.json \
  --goal 'Implement the agreed fixture' --event-id submit-1
npm run cli -- task status --session-file /absolute/private/task-session.json --id TASK_ID
```

The local simulation launcher creates a protected `operator.json` in its selected
state directory. Pass `--operator-file /absolute/state/operator.json` on registration
instead of setting the environment variable. Its `local-demo-pairing` is explicitly
a local fixture, not a physical phone pairing or live-call authorization.

Registration writes the returned session credential to a mode-600 file and prints
only the session metadata and file location. All other commands use that file or
an exact session token in `CLAWDTIME_TASK_TOKEN`. The CLI refuses remote origins,
credential-bearing URLs and cross-origin session-file reuse.

`task command --id TASK_ID --json JSON --session-file PRIVATE_FILE` submits an
explicit versioned lifecycle command. Every mutation carries its original event ID
and commands carry `expectedRevision`; read status before choosing the revision.
Simulation is explicitly labeled and direct worker results are a simulation-only
surface. Registration requests no voice, presentation or screen-control authority.
This CLI never retries a write after a missing response. Preserve the original
event ID and task/run receipts for reconciliation; a timeout does not mean that
the service rejected the operation.

The step-a simulation establishes local task lifecycle and restart behavior only.
It does not establish real Codex execution, microphone dialogue, call delivery or
handset behavior. Native worker approval requests are never voice approvals.

### Next-session readiness and explicit reauthorization

Read readiness before resuming an existing task:

```sh
npm run cli -- task readiness --id TASK_ID \
  --session-file /absolute/private/task-session.json
```

This GET uses the saved task credential and remains available for a known expired
session. It reports sanitized task/run state, verification, session expiry,
unended voices and blockers. It does not renew authority, dispatch work, create a
voice session or place a call. Handset dispatch remains disabled. Task status and
execution still require an active session.

Task sessions last 24 hours. If explicit reauthorization is needed, the operator
must provide the same pairing, host, project and voice permission:

```sh
npm run cli -- task reauthorize \
  --session-file /absolute/private/task-session.json \
  --operator-file /absolute/private/state/operator.json \
  --pairing-id PAIRING_ID --host-id HOST_ID --project /absolute/selected/project \
  --voice true --event-id reauthorize-1
```

The session file determines the session ID and exact service origin; the separate
operator file authorizes this POST. Both files are required, and `--voice` must be
explicit. The service renews the same session for 24 hours while preserving its
token and tasks; the CLI leaves the existing credential file unchanged. Changed
identity or permissions, unended voice, active execution and unresolved outcomes
block renewal. No instruction or unknown effect is replayed. This command never
retries a lost response; preserve its event ID and inspect readiness before any
further action. Reauthorization does not authorize a handset call.

Restart the service with the same private state directory, project and verification
plan. Known terminal tasks persist; interrupted running/verifying work becomes
unknown and requires reconciliation. Never delete a stale owner lock until prior
process shutdown is confirmed. Voice capabilities last at most 30 minutes and
cannot reconnect to an old provider session. Expiry does not prove audio stopped:
an unended voice continues to block fresh admission. Confirm runtime cleanup and
explicitly end the old voice while authorized; do not silently clear its receipt.

## Scoped Codex task worker (coding demo, step b)

`connectors/codex/task-worker.ts` implements `TaskWorker` for the authoritative task
engine. `task run --id TASK_ID --session-file PRIVATE_FILE` requests nonblocking
execution; poll `task status` for its result. The engine durably claims the exact
run before invoking the adapter and independently verifies tests/build afterward.
The adapter's `completed` result is a known terminal execution outcome, not verified
task success. It keeps the model's bounded summary and unresolved decision as
untrusted context. A later instruction uses a new run and a new ephemeral thread;
there is no `turn/steer`, native approval bridge or original-chat dependency.

The stdio transport is selectively extracted from ArgosClawd `815d51b`:
`connectors/codex/app-server.ts`. The task worker reuses the reviewed lifecycle,
approval refusal and unresolved-tool guards from that baseline's `runner.ts`,
without importing its old broker/job types, document host or `file_contains`
completion requirement. The associated environment regression was extracted and
strengthened to require an explicit OS/path/locale/Codex-home allowlist. No provider,
frontend, database, arbitrary secret or API-key environment variables enter the
worker. It uses the existing Codex login, with no credential change.

Before any model turn, the adapter checks the returned `workspaceWrite` sandbox,
disabled command networking, `on-request` approval policy and selected writable
root. It disables inherited MCP/plugin entries, apps, browser/computer use, hooks,
goals, memories, additional agents and web search through task-local configuration.
It then checks the exact thread's MCP inventory and refuses execution unless every
entry is disabled. A policy mismatch is a blocked initialization, never permission
to loosen the worker sandbox.

Command/file approval requests receive `decline`; additional permission requests
receive an empty turn-scoped grant; unsupported interactive requests are rejected.
Cancellation or a permission block requests interruption once and waits for the
original `turn/completed` receipt with no outstanding tool execution. Acknowledging
the interrupt RPC, disconnecting, or reaching a timeout never proves the worker
stopped. Unknown results poison the local worker and preserve the service's original
run receipt without resubmission. Final structured output uses a bounded JSON
schema; malformed output is a known terminal block requiring independent checks
and human review.

API compatibility was checked against installed `codex-cli 0.166.0-alpha.5.1`, its
generated App Server schemas, and the official [App Server documentation](https://learn.chatgpt.com/docs/app-server)
and [configuration reference](https://developers.openai.com/codex/config-reference/).
The November 18 initialization-only preflight confirmed `on-request`,
`workspaceWrite`, networking disabled, no additional writable roots, and all three
inherited MCP entries disabled. It submitted **zero model turns** and closed the
isolated App Server. Real end-to-end worker/watcher evidence is recorded separately
in `docs/BUILD_LOG.md`; initialization tests do not establish coding or handset
acceptance.

## Task-bound local voice (coding demo, step c)

Opt in to voice when creating a fresh independent task session with
`task register ... --voice true`. An existing session cannot be upgraded silently.
When a task has a prepared brief, bind a local audio conversation to its exact
current task, run and revision:

```sh
npm run cli -- task voice-start --id TASK_ID --run-id RUN_ID --revision REVISION \
  --event-id opening-1 --session-file /absolute/private/task-session.json \
  --save /absolute/private/task-voice.json
npm run cli -- task voice-status --voice-file /absolute/private/task-voice.json
npm run cli -- task voice-stop --voice-file /absolute/private/task-voice.json \
  --event-id end-1
```

`voice-start` writes a separate mode-600 capability file containing
`version`, `taskOrigin`, `taskId`, `voiceSessionId` and `voiceToken`. Its output
contains session metadata and the saved file path, never the token. The runtime
uses this narrower voice credential; it does not receive the operator token or
original task session token. Provider credentials are a separate protected
runtime prerequisite, not fields collected or printed by this CLI.

`voice-stop` ends the conversation only. It does not cancel a coding task. Use the
separate task cancellation command when that is the intended action. Voice routes
offer no capture, presentation, shared-screen input, native worker approval or
original-chat forwarding capability. The local microphone/speaker runtime and its
component qualification are documented in MEDIA_INTEGRATION.md. Software checks
are not spoken-dialogue or handset acceptance; the c.1 phone call still requires
specific authorization after step c passes.

## Prepared local walkthrough CLI (step d)

The independent task CLI accepts a separate, operator-installed local presentation
grant. Existing task and voice permissions are unchanged. The grant fixes one
manifest, task/run/revision, host and expiry, with local capture/presentation enabled
and native activation, input control and calling disabled. Creating a manifest or
running `walkthrough-prepare` does not authorize window enumeration or start capture.
The service binds the exact manifest through its metadata-only host preparation
port. Local setup must select the real editor/preview windows first; the local
Start action checks those native targets before scene capture begins.

```sh
npm run cli -- task walkthrough-prepare --id TASK_ID \
  --plan-file /absolute/private/manifest.json \
  --grant-file /absolute/private/presentation-grant.json \
  --project /absolute/selected/project \
  --session-file /absolute/private/task-session.json \
  --event-id prepare-walkthrough-1 --save /absolute/private/walkthrough.json
npm run cli -- task walkthrough-start \
  --walkthrough-file /absolute/private/walkthrough.json \
  --session-file /absolute/private/task-session.json
npm run cli -- task walkthrough-status \
  --walkthrough-file /absolute/private/walkthrough.json \
  --session-file /absolute/private/task-session.json
npm run cli -- task walkthrough-stop \
  --walkthrough-file /absolute/private/walkthrough.json \
  --session-file /absolute/private/task-session.json
```

Use the schemas in `src/task-presentation-contracts.ts`. A manifest contains the
authoritative prepared opening, 15 fps output, ordered scenes with exact app/window,
PID/process identity, display and title hash, window-relative focus, 450–650 ms
transition, bounded narration and expected visible result. Any artifact names an
explicit project-relative regular file and its SHA-256 hash. The CLI checks these
files before preparation and again before starting; it rejects traversal, symbolic
links and files larger than 4 MiB. The project must match the current task exactly.
The service independently rechecks current task authority and artifacts.

The saved walkthrough file is owner-only and contains no credential. It records
the deterministic presentation ID, manifest fingerprint and all scene/narration/Stop
event IDs before requests. Start reserves a durable single-use claim before the first
scene effect. For each scene it requests display, reads the original render proof,
then requests narration; the service obtains a fresh host observation before speech.
The final scene remains visible until Stop or authority invalidation. A duplicate
start, uncertain response or partial walkthrough is never automatically resumed or
replayed. Preserve the file and receipts; use status to inspect the original ID.
If preparation's response is lost, that same ID remains available for reconciliation.

Status is read-only and requires an active task credential because the full record
contains protected task prose. Stop does not require a preceding status read and
accepts the original credential after expiry for cleanup only; its response contains
just identity/state/generation and cleanup evidence. Stop also uses one preallocated
event ID and is not retried automatically. The local host's Stop remains the direct
way to end capture and narration when network or service cleanup is uncertain.

Render receipts establish host frame output, not human visibility or correctness.
Narration receipts establish local playback completion, not audibility. A local
walkthrough still needs transient inspection of actual editor/preview pixels and
observed transition/Stop behavior. No raw frames or audio belong in the CLI journal.
This path imports no original-chat runtime and makes no external call; local tests
do not qualify handset video, narration timing or a complete decision/review call.

### Separate handset walkthrough authority

`cli/task-walkthrough-authority.ts` provides an operator-composition boundary;
it is not a new public dispatch command. `TaskAudioAuthority` and the c.1
audio-only plan/fingerprint remain separate. A local presentation grant alone
cannot authorize export. The walkthrough authority requires the exact prepared
manifest, local capture grant, and an explicit `handset_walkthrough` export grant
bound to the full call-plan fingerprint and destination identity.

`assertInitial(plan, authorization)` requires the original known terminal run,
independent verification, matching prepared opening and still-valid local capture
and dispatch grants. It admits both verified review and prepared decision paths.
`assertOngoing(plan, authorization)` requires the same task/session/voice/export
authority and a trusted exact connected, unstopped call-receipt callback. The
callback defaults to refusal; fresh native destination proof remains the operator
composition's responsibility. A later authorized run, held correction, or expiry
of the original local presentation grant does not end this conversation. Old
frames still require their own unexpired presentation authority. Legacy grants
stop sharing when the task advances. An explicit `continuity: "call"` local grant,
installed with the exact internal call/voice/export binding, permits the same
immutable prepared windows and scene IDs to remain visible during a revision or
after acceptance. It does not authorize a new target, extend expiry or restart
sharing after Stop. When the task or prepared artifact changes,
`sceneEvidenceCurrent: false` separates the visible window from verified-result
claims; stale prepared narration and annotations must not describe it as a
completed current result. A later run still requires its own exact verified
review call for acceptance. Cancellation, unknown outcomes, revoked ownership,
Stop and the separately authorized conversation expiry deny continuation.
New desktop call requests require this explicit continuity grant. An exact replay
of an older request only returns its historical receipt; adding continuity under
the same event conflicts and cannot upgrade that call.

The helper does not dispatch calls, release held instructions, mutate task state,
or turn voice permission into native worker approval. Source pairing remains
unchanged when a distinct verified capture device receives explicit export
authority. Synthetic authority tests establish these boundaries, not handset
presentation acceptance.

## Agent board commands

`clawdtime agents` lists every coding-agent session on this Mac with its state
(needs you, working, idle, unknown) and its terminal. `agents watch` is the live
view, `agents focus ID|NAME` brings a session's terminal forward, `agents --json`
prints the snapshot contract, and `agents doctor` states how exactly each agent's
state is known. `agents hooks install --agent codex` adds the hook that reports
Codex approval prompts. The commands read state only. They need no pairing, no
connection file and no backend. See the [agent board guide](AGENT_BOARD.md).

## Independent task desktop launcher

Build the native panel before launching it:

```sh
swift build --package-path mac --product ClawdTimeTaskPanel
npm run task:desktop -- --state /absolute/private/task-state --project /absolute/selected-project
```

The launcher uses simulation by default, on `http://127.0.0.1:13326`. Simulation
submissions remain queued; no real worker, phone call, screen capture, or control
is enabled. To explicitly use Codex, add `--worker codex --checks
/absolute/private/checks.json`; the verification plan must be a bounded owner-only
file in a private directory outside the selected project. The state directory
must also be owner-only and outside that project. `--port` selects another
loopback port. `--panel-binary` may select an absolute native executable; the
default is `mac/.build/debug/ClawdTimeTaskPanel` in this checkout.

`cli/task-desktop.ts` launches the existing task server in a detached process and
opens the native panel separately. Closing or quitting the panel never sends
Cancel, Stop, or a signal to the service. Repeating the same command reuses the
service only after its private descriptor, owner PID, selected project, worker,
verification-plan fingerprint and authenticated desktop identity all agree. The
native panel owns a separate singleton lock; its Show Panel menu restores a
hidden window. Repeating the command also requests that exact panel to show via
a UI-only notification after its singleton binding matches. No daemon, launch
agent or system setting is installed.

The UI credential is read from protected `desktop-panel.json`, never from an
argument or printed output. Readiness requests carry no browser Origin, reject
redirects, are bounded, and only read `/desktop/state`. Child processes inherit
OS/path/locale variables and the explicit Codex home, not arbitrary environment
credentials. The UI capability is separate from operator and task credentials.
Opening the panel does not register a new task, retry an operation, change a
project binding or renew an expired task session.

For an already-authorized session in the same task store, add `--session-file
/absolute/private/session.json` on the first desktop launch. The bounded private
file's bytes become part of the immutable desktop configuration fingerprint. The
service authenticates that existing capability and uses its task history, with no
new session registration or renewal. The native UI still receives only its
separate desktop token. Reopening requires the same file contents; changing them
or omitting the flag does not silently rebind an existing desktop. This enables an
explicit idle ownership handoff to the handset operator using the same session;
it does not perform a handoff, stop a service, start a call, or authorize export.

For the opt-in prepared-call integration, also supply `--calls-config
/absolute/private/desktop-calls.json` with `--worker codex`, an explicit checks
file, and `--session-file`. This static configuration follows
`src/control/task-desktop-calls-config.ts`: provider/LiveKit file references,
inspector and helper paths, a private attempt root, and exact native destination
and line-readiness configuration. Its bounded owner-only bytes are hashed into
the desktop binding; the file and its parent must be private and outside the
worker project. Only its path is passed to the service. Configuring or reopening
the launcher does not start a provider, capture, allocate a room, or request a call.

Each prepared call separately requires an operator-authorized request to
`POST /operator/desktop-calls`, bound to the current task/run/revision and fresh
prepared presentation. The panel credential cannot authorize it. A new final
review requires a new authorization; a static config is never a recurring call
grant. Per-call requests do not change the desktop fingerprint, UI token, or
service owner. Changing the static configuration refuses attachment to the old
binding instead of silently upgrading its authority. No live readiness or handset
acceptance is implied by this launcher option.

`desktop-launch.lock` serializes launcher startup; the service retains its own
`owner.lock`. An unreachable existing service, mismatched configuration, or stale
lock is a refusal, not permission to start another worker or remove ownership.
A timed-out startup is unconfirmed and is preserved. Establish prior process
quiescence before any manual stale-lock recovery. Restarted in-flight work is
reported unknown by the task ledger and is never automatically replayed. If the
panel fails to start after service readiness, the service remains available for
an explicit reopen. The launcher does not install restart supervision.

The Codex worker can return two or three short decision choices with an unresolved
question. Choices are model-provided task data, bounded to 500 characters each,
trimmed and checked for duplicates. Free-text questions and older results without
choices remain supported. Choices without a decision are not exposed, and malformed
choice output is blocked without replaying the run. The panel must display the
recorded choices as-is; it must not invent defaults or infer a human selection.

## Long coding runs and semantic task admission (November 20, 2026)

The managed Codex worker has no overall coding-turn deadline. The former
180-second timer is removed, not increased. Individual app-server RPCs retain
bounded waits (15 seconds by default), and explicit Stop retains a bounded
terminal-confirmation wait (5 seconds by default). The worker keeps reading
`turn/completed`; an interrupt RPC acknowledgement is not proof that execution
stopped. A completed notification that races a slow `turn/start` response remains
authoritative. If `turn/started` established admission, a slow start response does
not terminate healthy work. No command, start, or interrupt is blindly replayed.

Fixed progress phases distinguish connection setup, acceptance, reasoning,
editing, completed tools, permission blocking, and interruption. Fixed diagnostic
reason codes distinguish process exit, connection loss, unconfirmed submission,
unconfirmed interruption, invalid lifecycle events, unresolved effects, and known
terminal results. A disconnected run remains an unknown effect and fences reuse;
it is not labeled canceled. The task ledger retains restart uncertainty and the
original run identity. Thread and turn identities are persisted as soon as the
worker reports them, before terminal completion, so crash recovery can inspect
the original dispatch. Progress receipt failure fences an admitted run and never
logs the underlying error. These changes do not reconcile the historical interrupted
landing-page run or infer its success from existing files.

The OpenAI-backed supervisor now classifies the latest utterance into a bounded
structured intent before conversational generation: new task, revision, status,
cancellation, acceptance, callback, deployment, computer action, clarification,
confirmation, or ordinary conversation. The classifier receives current task facts
and one live pending proposal, never chat history or assistant-authored goals.
Its output is schema-validated and must echo the exact current input. The task
service still enforces identity, current state, supported capabilities,
idempotency, and unresolved effects. A task snapshot change or Stop invalidates
an in-flight classification. The conversation model cannot invoke task mutations
after the classifier chose conversation.

Clear software requests go directly to task-service admission. Greetings and polite
questions need no special task keyword. The full original request, including
"don't deploy", "draft only", and "don't send", becomes the goal. Revisions carry
the person's complete text to the current task; the task engine also retains the
original goal and earlier human revision instructions. The worker accepts at most
300000 characters of assembled context, enough for the ledger's bounded revision
history; oversized context is refused rather than truncated. A request above
8000 characters is refused instead of truncated.
The chat log retains bounded requests intact; oversized messages get an explicit
non-admission marker. The offline/no-classifier compatibility path remains a
conservative phrase-based fallback, not a semantic capability claim.

A clarification can create one pending proposal bound to the current task snapshot.
It expires after two minutes, on task change, on Stop, or on process restart.
A subsequent confirmation consumes it once and appends the human clarification
without dropping the original constraints. Without this live proposal, "Yes,
start building now" cannot reconstruct work from old chat. Acceptance remains a
separate explicit action against the current review; deployment is not provided by
this route. Callback requests use the supervisor's task-linked callback service,
and missing capability is reported rather than promised.

Validation includes synthetic-clock work continuing beyond three minutes and a
further hour, terminal completion, Stop races, slow RPC responses, disconnect and
process exit, invalid/late events, and semantic admission/confirmation/revision
regressions. These are simulated protocol tests, not a paid-model accuracy
qualification or physical call/screen acceptance. Codex CLI observed locally:
`0.166.0-alpha.5.1`. Terminal semantics were checked against the
[official app-server lifecycle documentation](https://learn.chatgpt.com/docs/app-server#lifecycle-overview).

## Background workflow admission (staged, November 21)

`connectors/agents/background-workflow-policy.ts` adds a separate positive-capability
admission gate for the proposed background backend. It does not weaken the existing
native adapter's global-focus contract and is not yet connected to the installed
controller. Passing its tests does not qualify a real app or establish phone readiness.

Only a trusted, physically qualified app adapter may create a grant. A model's
classification, a screenshot label, an accessibility role, or a claimed qualification
ID cannot establish which controls are safe. The controller supplies the qualification
records binding each qualification to its workflow, app bundle and driver release,
and binds the selected account/conversation/project independently. The gate
compares the call, task, stable tool call, driver instance and generation, bundle ID,
PID and process start identity, exact window, observation ID and fingerprint against
both the requested action and fresh native evidence. Grants expire within five seconds;
Stop, clock rollback, changed identity or destination, and unqualified mappings refuse.

Capabilities name exact observation-scoped element tokens for tested navigation,
search, draft editing, or reading scroll operations. Text must exactly equal the
trusted grant's bounded text. Read-only Messages/email grants cannot create draft
capabilities. A native key adapter must independently prove keyboard focus belongs
to the granted element token before delivering a key; a window-only key API does
not establish this. There are no pixel-click, send, submit, Return/Enter, shortcut, arbitrary
launch, script or shell capabilities. Strict schemas reject extra arguments and action
sequences. The only accepted delivery is explicit background. Each action still needs
the service's live lease, exclusive execution owner, durable receipt and duplicate
checks, plus driver admission at dispatch. An admitted action is permission to attempt
input, never evidence that input succeeded. Receipts and uncertainty handling remain
the controller's responsibility; this pure policy does not execute or retry anything.

Integrate this gate immediately before dispatch, using an independent re-observation
of the destination and identity. Do not create grants by feeding untrusted labels into
a generic "safe control" classifier. Real Messages conversation navigation and the
installed Codex composer still need qualified mappings and observed postconditions.
Email additionally needs its own selected signed-in account and qualification.

A separately qualified `pixel-draft` capability covers the documented Electron
text route: one `pixel-type` plan becomes one explicitly background `type_text`
call that focuses the exact editor point and types. It does not grant generic pixel
clicks. Admission requires `pixelDraft:true` on the matching qualification, exact
trusted draft text, independently matching current editor geometry, and the exact
center of that editor in the original screenshot. Zero-size, non-finite, off-image,
changed or model-supplied geometry refuses. The qualification must establish that
this point belongs only to the composer, with no overlapping submit control.
The positive gate alone cannot establish that visual fact.

Release `0.55.0`'s generated `TypeTextInput` omits `delivery_mode`, element tokens
and pixel fields. A production adapter must use a fixed `callTool("type_text", ... )`
wrapper with locally validated, bounded arguments; passing extra JavaScript fields
to `typeText` may silently drop them. Never expose that generic method directly to
a planner. Official scroll `amount` is wheel notches, not the policy's abstract
`deltaY`; any adapter must define and qualify that conversion explicitly.

The official [Cua SDK documentation](https://cua.ai/docs/cua-driver/guides/use-the-sdk)
documents `CuaDriver.connect(socketPath)` as the explicit daemon connection without
embedded fallback. Input must name the exact window, use the current element token,
and request background delivery. `ActionInterrupted` distinguishes `NotStarted`,
`Completed` and `Unknown`; an unknown or timed-out effect must not be replayed. A
fresh post-action observation establishes the workflow outcome separately from the
returned driver action status.

### Codex handoff boundary

The prior native-tool denial of the Codex app is historical evidence for that tool,
not proof of a Cua Driver denial. Preserve any actual driver refusal; do not substitute
private desktop sockets or a different controller to bypass it.

The official [Codex App Server documentation](https://developers.openai.com/codex/app-server)
provides an owned stdio service with initialization, `thread/start`, and a separate
`turn/start` that begins agent work. It also documents authenticated WebSocket
configuration, while labeling that transport experimental. The installed CLI reports
`0.166.0-alpha.5.1` and advertises the stdio and authentication flags. No task was
submitted during this documentation/preflight check. The existing
`connectors/codex/task-worker.ts` already uses an isolated owned stdio process and
checks its sandbox before a model turn. This is a possible separately authorized
coding-task integration, not evidence that the desktop application's New chat draft
can be populated or that an existing desktop chat can be taken over. The reviewed
public API does not establish a desktop-composer draft endpoint; that capability
remains unqualified until the actual supported UI or an explicitly documented route
is verified.

### Isolated daemon diagnostic

`cli/cua-driver-probe.ts` takes one absolute path to a private JSON configuration
with `sdkDirectory`, `socketPath`, `executablePath`, `expectedPid`,
`manifestSha256`, `policySha256`, and explicit `targets` records containing
`bundleId`, `pid`, and `executablePath`. It loads only
`@trycua/cua-driver` version `0.55.0` from that isolated SDK directory. This package
is not a production dependency yet.

The diagnostic verifies the current-user private socket, pinned package metadata,
exact executable path, bounded CLI status and loaded policy hashes before calling
`connect`. It checks daemon permission attribution, PID, executable and bundle;
missing Accessibility or Screen Recording returns `permissions_required` without
app enumeration. With both present, it checks the configured process executable and app bundle
identity, then calls `list_windows(pid)` only for those exact processes, returning
IDs and availability flags without window titles. It never calls `list_apps`: in
this release that API requires desktop display scope, which is intentionally absent.
It does not request permissions, capture images, inspect conversation content,
launch an app, invoke input, stop the daemon, or submit Codex work. A permission
preflight is explicitly not direct capture or app workflow qualification.

The only generic SDK call is the fixed `check_permissions` tool with `prompt:false`
and `probe_direct_capture:false`, because this release has no typed permission
method. The caller cannot supply a tool name or arbitrary arguments. The driver
client is shut down and its native handle destroyed after success or failure.
Unit tests cover wrong topology, release, permission owner, hashes, unverified processes,
foreign windows, cancellation, missing permissions and cleanup without retries.

### Fixed-call background port and intent planner

`CuaDriverBackgroundPort` exposes named-session start/end, exact configured app
launch, original window observations, display-only previews, element clicks,
qualified navigation-point clicks, element text, qualified pixel draft text and
bounded element scrolling. Input always requests `scope:window` and explicit
background delivery. Launch accepts only an allowed bundle ID; there are no URLs,
application arguments, shells, arbitrary tools, foreground fallback or key shortcuts.
The SDK is private to the port. Each effect gets one bounded attempt, with in-memory
same-client duplicate protection supplementing the service's required encrypted
receipts. A returned action never establishes workflow completion.

Protected `allowedApps` contains bundle IDs and exact executable paths independently
of optional read-only `targets` probe snapshots. A newly launched PID and its window
IDs are only candidates. The required supervisor `host.withLease` must independently
verify the new process kernel lifetime, exact window and observation, positive
workflow permission, and durable reservation. The port supplies the expected
executable from protected configuration. It checks the socket identity and remote
SDK metadata's actual daemon PID/version before requesting the final host lease.
After the host's final witness, only synchronous Stop/admission checks precede
the single SDK dispatch. These checks alone
are not an atomic generation guarantee: the supervisor must hold its lifecycle and
execution ownership until the effect and cleanup outcomes are known.

The pinned driver's session implementation creates missing public labels on first
admitted use; its lifecycle records and tombstones are process-local. A label is
therefore **not** a daemon restart barrier. The release's `end_session` reports
pending/partial cleanup separately; the port requires the exact session's
`active:false` receipt. Abort signals request cancellation but cannot undo input
already posted to macOS. Unknown input poisons the port, remains unknown after
cleanup, and must keep the shared durable unresolved-input barrier in place. An
in-flight read-only `get_window_state` cancellation does not by itself poison
quiescence: the port waits for it and still requires exact session closure and
successful SDK shutdown. This does not clear any unknown launch/input/session
mutation or any unresolved host receipt. Host
cleanup admission must remain available for this exact reserved session after
Stop/hangup without authorizing new input. None of these interfaces independently
qualifies physical Stop or driver-crash recovery.

`capturePreview` uses `display_only:true` and `include_accessibility_tree:false`,
which the pinned driver implements without replacing planner tokens or its pixel
frame. Both preview and original observations remain transient. Preview capture is
serialized with input; callers must show an unavailable/stale state when it cannot
capture, rather than reuse an old frame as live.

`BackgroundIntentPlanner` accepts only a Messages-read intent, an unsent Codex draft,
or a blocked result. It cannot choose controls, app paths, recipients, projects or
actions. Exact supplied draft text is compared byte-for-byte after classification;
control characters and multiline text refuse. A conservative precheck blocks clear
send/submit/execute requests before generation. This improves intent handling but
does not replace deterministic runtime permission checks. Verification receives the
original observation, expected destination and draft text; it limits Messages
summaries to the selected right-hand conversation pane and distinguishes an unsent
composer from submitted agent work. Existing configured model/reasoning settings
are retained; storage and automatic model retries remain disabled.

### Deterministic qualified workflows

`QualifiedBackgroundWorkflow` is a single-use worker for the two explicitly
configured app/version mappings. Private configuration supplies contact and project
names; neither comes from model-generated actions. The classifier receives those
authorized destinations and blocks requests for a different contact or project.
The runner starts the named daemon session, reserves the exact bundle launch,
then calls `verifyLaunchedApplication` for an independent signed running-app witness
matching the configured version/path and a correctly owned returned window before
verifying the launch receipt. This proves launch only and does not require the app
window to be on the current Space or uniquely eligible for input. Those stricter
checks remain in `bindFreshTarget` before observation and every action. An off-Space
or ambiguous input window, or later unavailable/truncated observation, blocks the
workflow without changing a known app-launch outcome back to uncertain. A failed
signed-app witness leaves the original launch unresolved.

If Messages already shows the configured conversation, an exact `AXWindow` title
plus one enabled `AXPopUpButton` header beginning with that contact and a comma-space,
inside the top quarter of the original screenshot, allows a read without clicking.
Independent screenshot corroboration must confirm that the right pane is selected;
a sidebar label or body text does not establish selection. This handles a selected
conversation whose sidebar row has scrolled out of view.

Otherwise, Messages selection accepts one `AXStaticText` row whose label begins with the
configured contact followed by a comma. It uses the screenshot rectangle's center,
not AXPress, after independent original-image corroboration. Codex accepts only the
native `AXMenuItem` named `New Chat` with `AXPress`; sidebar buttons are not equivalent.
A fresh observation must then contain one empty `AXTextArea` labelled `Do anything`
in the configured project before a single background pixel-targeted draft insertion.
The draft remains one line of at most 512 characters. There is no Send, Return,
shortcut, shell, submit, or task-start operation in this runner.

Original observations request `full_output:true`, at most 10,000 AX nodes, depth
40, and a two-second walk budget. The pinned release collapses native menus unless
full output or a query is requested; a larger node cap alone does not expose New Chat.
The runner still rejects truncated/degraded snapshots, malformed frame metadata,
more than 4 MB of structured content, or frames five seconds old. It does not infer
control uniqueness from a partial tree. `summarizeBackgroundObservation` and
`QualifiedBackgroundObservationError.flags` report fixed boolean failure reasons
without image data, labels, text, process IDs, or snapshot identifiers.

The pinned driver's element `frame` is in screen points while `screenshot_frame`
is in delivered screenshot pixels. The runner independently cross-checks their
conversion using original window bounds and delivered width, rejects degenerate or
out-of-frame rectangles, and passes only the exact qualified rectangle center.
The model's `verifySurface` output is one corroboration boolean; it cannot mint a
grant, choose a coordinate, or choose an app. After vision finishes, a fresh target
binding and observation must show the same native control signature. Every coordinate
action retains its full non-token signature and requires unchanged original image bytes. The only
image-equality exception is the configured Codex draft workflow's unique native
`AXMenuItem` named `New Chat`: old and fresh controls must both be explicitly enabled,
include `AXPress`, and retain every semantic attribute, exact process lifetime,
window, app version and driver binding. For this native control only, snapshot-local
`element_index` and `parent_index` may change. Each snapshot must independently
resolve unique indexes through the exact qualified ancestor shape: New Chat →
unlabelled `AXMenu` → `AXMenuBarItem` labelled/titled File → unlabelled `AXMenuBar`
root. Missing or duplicate indexes, cycles or a different menu shape refuse input.
Control and ancestor semantics are compared after excluding only tokens and those
two local enumeration indexes. `QualifiedNativeMenuError.diagnostics` reports fixed
flags and allowlisted changed-field names, never native values or arbitrary keys. This tolerates unrelated pixels changing in
the current chat without granting any general token-click exemption. A fresh empty
composer and selected project must still be independently verified before typing.
The runner uses the new token and grant, expiring within five seconds; mismatches
block without retrying input. Coordinate actions can still reject dynamic or
blinking surfaces and do not relax their original-image postconditions.

The host owns final live-call/helper/lifecycle fencing. `armGrant` installs exactly
one transient capability, and `admitQualifiedGrant` compares its action ID, target,
operation, exact action, generation and time at dispatch. It supplements the host's
trusted version qualification and durable ownership checks. `present` receives the
original observation, optional exact pixel rectangle, and explicit action/typing
phase. Previews use JPEG quality 85 with `max_dimension:1280`, display-only mode;
the integrating host serializes preview calls with workflow calls and gives workflow
calls priority. Preview frames do not replace the original action observation.

Every input receipt remains returned/unresolved until a separate fresh AX and
original-screenshot postcondition passes. Messages summaries cover only the selected
right conversation pane. Codex verifies the exact text remains in the unsent composer.
Unknown outcomes are never retried or erased by cleanup. `stop` closes admission;
`close` only ends the exact driver session, leaving the host responsible for retaining
or releasing the durable ownership fence based on all receipts. Unit tests exercise
these contracts but do not establish physical acceptance, multi-Space support,
process-crash recovery or phone-path readiness.

The pinned macOS source does not make a menu AXPress a reliable New Chat
postcondition. `click` resolves the observed token and applies the explicit
background AX-semantic gate; `scope:"window"` does not convert this native action
into a coordinate click. An application-menu descendant is accepted by the driver's
ancestry gate even when it has no own AXWindow. Generic click does not establish
that the requested window is both the application's focused and main menu context,
and the driver's background key-window priming explicitly excludes Electron apps.
A returned native menu action is normally `effect:"unverifiable"`, not evidence
that navigation occurred. The runner therefore keeps the independent fresh empty
composer/project check and retains an unresolved navigation receipt on failure.
After exactly one returned New Chat press, it allows at most four fresh observation
reads within three seconds, with bounded cancellable delays. Only valid same-target
frames with no expected empty composer are eligible for another read; ambiguity,
stale/degraded evidence, changed identity, Stop or expired call authority stop the
loop. The exact empty-composer labels remain unchanged. Once a candidate appears,
the existing independently bounded screenshot/project verification must pass before
navigation is resolved or typing can begin. This is observation settling, never an
input retry. Renderer IPC finishing after a native AX return is a timing hypothesis,
not a proven explanation of any failed physical run.

The official `invoke_menu` API is not an interchangeable background-only remedy in
0.55.0. Its background implementation uniquely resolves a live menu path, checks
both AXFocusedWindow and AXMainWindow before dispatch, and still reports ordinary
menu effects as unverifiable. However, the pinned macOS implementation accepts but
does not consult its `delivery_mode` field: it selects a foreground route when the
app is already frontmost on the current Space, where it can focus/raise the target
window and open menus. The generated SDK documentation explicitly describes this
platform limitation. Consequently this connector does not add `invoke_menu`, switch
to AXPick, or retry a returned New Chat command as recovery. Such changes require
separate qualification and cannot resolve the original unknown result.

Surface-verifier diagnostics are optional and content-free. The planner factory's
`onSurfaceDiagnostic` callback receives only a fixed phase and one fixed result:
`corroborated`, `negative_model_verdict`, `provider_failure`,
`invalid_model_output`, `aborted`, or `invalid_observation`. Unsupported phases
are reported as `unknown`; image data, native labels, destination names, model
responses and exception details never enter this event. A callback exception cannot
change the verification result. A negative verdict may additionally carry one closed
reason: `application_mismatch`, `native_control_mismatch`, `destination_mismatch`,
`geometry_mismatch`, `draft_not_empty`, `already_submitted_or_running`,
`ambiguous_or_unreadable`, `stale`, or `other`. The model's strict Responses schema requires the reason field but accepts `null`;
a negative `null` becomes `other`. Omitted or free-text reasons fail parsing and
are not reported. Positive verdicts do not expose
a refusal reason. These diagnostics distinguish an explicit negative visual verdict
from an unavailable or invalid model result without authorizing input.

The `codex-new-chat` visual phase checks the intended Codex app and qualified native
menu control only. It omits the expected project from the model request and does
not require a project to be selected or visible before global New Chat navigation.
The `codex-empty` and `codex-draft` phases still require the exact configured project;
all Messages phases still require the configured conversation. This phase distinction
does not add a new action or relax the independent checks before text insertion.

## Proactive source adapters

The desktop service can inject one `ProactiveSourceAdapter` into `BoardFeed`.
With that adapter present, decision hooks, eligible Away-mode incidents, explicit
completion watches and independently checked Jobs submit to the shared durable
call coordinator. The old in-memory automatic dialing path is bypassed. Phone
submission, preparation and line cleanup remain service-owned.

`watch_session` derives its channel from the latest human request. "Tell me here"
uses the existing chat watch file. "Call me" retains a phone-alert watch;
"call and show me" retains a walkthrough watch. Phone watches live in a separate
owner-only version-2 file with watch ID, exact hook session/run, policy, expiry,
channel and state. Chat delivery cannot consume them. Missing hook enrollment or
policy stays visible as `needs_setup`; the response does not claim a phone was
scheduled when no phone-watch service exists. A timeout expires the watch. Board
idle, disappearance and an answer file alone are not verified completion.

New hook sidecars record a hashed native session identity and a new run generation
at `UserPromptSubmit`/`BeforeAgent`. Terminal hooks establish observed completion,
failure or cancellation; they do not establish independent verification. Short
explicit watches do not use the generic incident watcher's three-minute minimum.
A changed run cancels an unsent old watch. Pending questions bind to their exact
decision ID and cancel unsent delivery after local resolution.

The existing Claude/Codex Jobs launcher remains in use. New launch receipts add
project, agent, launch and run provenance. The launched process inherits the exact
ClawdTime state root and run ID. Explicit project policy can register bounded
scoped supervision before the terminal opens. Hook attendance is refreshed by the
service without panel reads, even with Away off; lost heartbeat, revocation or
expiry releases the hook without granting permission. Native approval rules remain
in force. One project policy can enroll several distinct runs without overwriting
their attendance.

`JobReviews` runs only a protected, configured independent verification plan under
the service's execution guard. Exact terminal hook or launcher-exit evidence and
bounded result digest are required before checks. Check intent is written before
execution; lost responses and interrupted checks remain unknown and are not
rerun automatically. The result digest and hook run are checked again afterward.
Registered headless Jobs use their launch/exit receipts without generic board
completion notifications. Legacy Jobs without provenance and arbitrary unhooked
sessions report concrete limitations instead of becoming fabricated managed tasks.
No adapter can universally wake an idle Codex chat.

Hook compatibility was checked against installed Claude Code 2.1.311 and
codex-cli 0.166.0-alpha.5.1 and the current primary references:
[Claude hooks](https://code.claude.com/docs/en/hooks) and
[Codex hooks](https://learn.chatgpt.com/docs/hooks). Claude registers
`UserPromptSubmit`, `Stop`, `StopFailure`, tool-result and session lifecycle
events in addition to its existing decision hooks. Codex registers
`UserPromptSubmit`, `Stop`, `Interrupt`, session lifecycle and tool-result events;
it does not register Claude's unsupported `StopFailure` event. Lifecycle reporters
run synchronously with short timeouts so a later completion cannot overtake its
run-start record. Codex interrupt/end handlers respect the documented three-second
maximum. Decision holds remain separately bounded below their native hook timeout.

Installation must apply the updated hook plan and the person must trust Codex
hooks through `/hooks`; launch enrollment alone does not install or trust hooks.
The installer preserves other hooks and upgrades only its own command groups.
For a supervisor using a nondefault state directory, pass
`clawdtime agents hooks install --agent claude-code --state-root /absolute/state`
(or `--agent codex`). The generated command pins that state directory instead of
depending on a terminal's environment. Use the same option for status/uninstall.
Installation migrates only the old unbound commands for the same executable and
hook script; it preserves other hook commands, settings and file permissions.
It refuses a configuration changed since its initial read. Different previous
release paths require explicit identification and removal of their own groups;
the installer never guesses which unrelated commands may be removed.
Existing chats must load the changed hook configuration according to their native
client behavior. A `Stop` event observes the end of a turn, not acceptance of its
result: another Stop hook can request further work. Fresh source checks invalidate
the old completion when resumed activity is observed. Independent result checks
and explicit phone policy are still required for a verified review.

The protected operator CLI provides `clawdtime proactive doctor`, `intents`,
`policy`, `enroll`, `revoke` and `stop`; use `proactive help` for exact arguments.
It reads the operator credential from an owner-only file and contacts an explicit
loopback origin. It never accepts a token in arguments or retries an uncertain
write. Version-2 policy registration requires explicit calling/viewing consent;
legacy single-call authorization is not upgraded. Doctor output reports watch,
supervision and verification state without printing credentials or result text.

All new source files and receipt fields are additive. Legacy chat watches remain
chat-only, and old Jobs retain their original receipts and unknown outcomes.
Synthetic connector tests cover channel preservation, short completion, restart,
changed runs/results, exact decision cancellation, scoped hook release, headless
failure receipts and verification uncertainty. These tests do not establish
handset playback, visible screen delivery or live agent continuation.
