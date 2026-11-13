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
