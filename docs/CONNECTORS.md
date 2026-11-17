# Agent connectors

## Scoped local document host

The `remote-documents` runner implements read-only discovery, first-page preview
and preparation of an explicitly selected attachment. It uses deterministic local
file access, not Codex prompts or generated scripts. It shares the conversational
broker and ordered voice/text instructions, but has no desktop control capability.
The hosted backend requires an authenticated local worker to access the selected
directory. It cannot read the Mac merely from a registered path.

Use a protected connection already authorized for the exact canonical directory
and a fresh managed session. Choose a fixed ISO expiry within the next hour (30
minutes recommended); do not renew an expired session by changing its saved file:

```sh
npm run cli -- setup-session --agent codex --project /absolute/authorized/documents --run-id NEW_DOCUMENT_RUN_ID --runner remote-documents --execution-session api_managed --document-access-until EXPLICIT_ISO_EXPIRY
npm run cli -- executor-worker --run /absolute/protected/connections/KEY/runs/RUN.json
```

The `codex` connector identity is retained for registration compatibility; this
worker starts no Codex subprocess. It fetches the server's exact root grant and
checks it again before each read/render/upload phase. No FaceTime call, screen
lease, filesystem write permission or arbitrary upload destination is granted.
Ctrl-C immediately starts the authenticated document Stop request and aborts local
work. Stop revokes the grant and pending transfers; an already attempted external
effect remains unknown until its original receipt is reconciled. A failed Stop
acknowledgment is reported honestly. Fixed expiry also bounds authorization if
the local process disappears. Reconnect does not rearm a revoked grant.

Discovery is flat and bounded: at most 256 directory entries, 32 regular files,
10 MiB per file and 64 MiB scanned bytes. Symlinks, package directories, unsafe
filenames and unsupported contents are excluded. PDF, OOXML DOCX and modern ZIP
Pages structures are recognized from bytes, including supported extensionless
files. Candidates have opaque manifest IDs, MIME, size and SHA-256; arbitrary
model-provided paths are never accepted. Reads use `O_NOFOLLOW`, exact canonical
root checks, descriptor/path identity checks and a fresh digest. Source changes
require discovery and selection again. Worker restart loses its transient
manifest, so old candidate IDs cannot silently select another file.

On macOS, fixed `/usr/bin/qlmanage` arguments render a private verified copy into
one bounded PNG (at most 2 MiB, 1280 pixels per dimension). This is a **first-page
preview**, not proof that every page is shown or reviewed. The adapter uses the
OS QuickLook service boundary; it does not claim an additional network-denying
sandbox. This host rejects nested `sandbox-exec`. No application UI is opened and
there is no fallback to agent scripts. Private copies and buffers are cleared
after use. PDF and DOCX rendering have been exercised with generated synthetic
documents. An authorized local read-only preflight also rendered four actual
documents successfully: one DOCX at 997×1280 in 189 ms, and three Pages documents
at 790×1024 in 248, 123 and 116 ms. Discovery took 10 ms; the complete preflight
took 705 ms. One unsupported binary regular file was excluded; no extensionless
regular document was present. Temporary copies were removed, and no original
files were changed, uploaded or sent. These samples establish bounded local
rendering for those documents, not full-document review or handset visibility.
Other unsupported QuickLook outputs still fail closed.

Sending requires a fresh selected preview and a distinct explicit send instruction
to the paired recipient. Original bytes are re-read and verified before a single
binary upload; metadata uses base64url UTF-8 JSON in `X-ClawdTime-Document`.
Preview/transfer assets are transient. Attachment receipts bind the exact selected
digest, size, candidate, session, paired recipient and stable effect ID. The worker
does not retry an ambiguous asset upload. Result acknowledgment retries preserve
the same result identity and never repeat execution. Provider acceptance is
reported separately from handset delivery. Neither discovery nor preview sends
the original document automatically.

Reproducible development proofs (synthetic documents only):

```sh
npx tsx tests/connectors-document-preview-spike.ts
npx tsx tests/connectors-document-http-spike.ts
# Optional: operator supplies the existing scoped text-model environment first.
npx tsx tests/connectors-document-http-spike.ts --real-model
```

The November 13 local HTTP proof used the actual worker, broker, document host and
QuickLook with a scripted frontend and simulated attachment provider: discovery
95 ms, preview 185 ms, transfer 97 ms, total 420 ms; 3/3 jobs accepted and verified,
one simulated stage/send, duplicate send suppressed and local Stop verified.
These are individual local development samples, not p95 measurements or physical
acceptance. The first attempt failed because its simulated provider compared a
`Uint8Array` with a `Buffer`; the resulting upload remained unknown as designed.
After correcting only that fixture assertion, the next fresh synthetic run passed.
No personal documents, external Messages sends, native desktop inputs or calls
were used. A real recipient receipt and handset preview/delivery remain separate
release acceptance steps.

The extended browser proof also opens the actual private preview page through
Playwright/Chrome, checks the synthetic filename and decoded 1280×640 image,
confirms the capability fragment is cleared, advances the page clock to prove
image removal, and verifies revoked access is refused. Its latest local sample
loaded the browser image in 108 ms; the preview phase including browser startup
and screenshot took 745 ms, and the whole three-job proof took 981 ms. The
synthetic screenshot is `.data/document-demo/synthetic-preview.png`; no preview
token is logged or placed in the image. This is browser UI validation, not native
CUA qualification or evidence of FaceTime handset visibility.

The HTTP harness defaults to its scripted frontend. `--real-model` selects
`configuredTextModel(process.env)` and labels the result accordingly; it never
loads credentials from files. This mode has a 90-second proof deadline and a
120-second local grant. Attachment delivery always remains simulated and all
documents remain newly generated fixtures. The coordinating lead's real-provider
trial passed all three jobs: discovery 1,417 ms, preview 1,959 ms and transfer
1,694 ms, total 7,140 ms, with a 66 ms browser image load. The first two attempts
failed before creating a job because document context was passed as a second
system-role message, rejected as `AI_InvalidPromptError`. Moving that context
into the single system prompt fixed the actual provider boundary; the successful
trial used real model intent, HTTP worker, QuickLook and browser UI with simulated
attachment receipts. It does not establish external attachment delivery or
FaceTime handset acceptance.

## Conversational broker and selected execution host — November 13 source

New sessions can explicitly select `conversation: {version: 1, runnerId:
"codex-app-server", executionSession: "api_managed"}`. This uses the shared broker
for responsive voice/text and a separate API-managed Codex execution session.
The original desktop chat is not taken over or silently replaced. Old sessions
retain the v1/v2 behavior documented below and cannot be upgraded in place.

The local runner uses the installed Codex App Server's documented stdio
`initialize`, `thread/start`, `turn/start`, progress notifications and
`turn/interrupt` protocol. It keeps an ephemeral managed thread per exact selected
session while the process is alive. It never connects to the desktop daemon's
socket. The runner advertises **no native desktop or browser CUA**: this chat's
native CUA tools are not available to its daemon. Claude Code's existing cooperative
MCP connector remains supported; an asynchronous Claude runner is not implemented.

Codex is enabled only when explicitly configured, its binary passes `--version`,
and operator configuration supplies allowed local project roots. The selected
project must exactly match a canonical allowlisted root on the executor host.
A hosted backend cannot run a project on the user's Mac merely because a connector
sent that path. The explicit `remote-codex-app-server` pull worker connects the
selected local project to an authenticated broker; cloud services do not need Codex or the Mac
workspace. It remains a separate API-managed session, never the original desktop
chat.

Fresh connector registration:

```sh
npm run cli -- setup-session --agent codex --project /absolute/allowed/project --run-id NEW_STABLE_RUN_ID --runner codex-app-server --execution-session api_managed
```

These flags only select a configured backend runner; they do not start a call,
provide a control grant, grant native approvals or install/start the local worker.
The same flags work on `mcp`; `run` refuses them because it cannot safely rewrite
the owned MCP configuration. Keep the foreground connection alive for heartbeats.
Managed sessions suppress legacy automatic progress replies; the conversational
frontend owns delivery. The existing `conversation_*` tools describe legacy
foreground execution; do not use them as a second output/execution owner for a
managed broker session.

Jobs preserve dispatch IDs and explicit acceptance. Process loss, lost acceptance,
timeout or an interrupted input lacking terminal input receipt returns `unknown`
and poisons the managed session. There is no automatic replay, second adapter or
new thread used to evade it. A turn interruption RPC acknowledgment alone is not
cancellation proof. Completed turns require an independent bounded file read with
a project-confined application-owned predicate; model prose is not verification.
Native approval requests emit `waiting_approval`, are declined (never approved by
conversation) and trigger cooperative interruption. This build has no remote
native-approval UI; an approval-dependent job therefore cannot complete unattended.
Raw prompts, tool text and files are not logged by this adapter. Ephemeral agent
context is lost on restart; the broker must clarify missing queued intent and
retain uncertain dispatched effects. It must not reconstruct and replay them.

### Explicit local pull worker for a hosted broker

Use a **fresh** registration selecting `--runner remote-codex-app-server
--execution-session api_managed`, preserving its protected run file. Then start
one foreground local worker:

```sh
npm run cli -- executor-worker --run /absolute/protected/connections/KEY/runs/RUN.json
```

The worker finds the matching protected `connection.json` one directory above
`runs`; pass `--connection PRIVATE_FILE` when using another owned layout. Never
pass tokens on the command line. It validates the saved session, project, adapter
and selected runner before startup, and does not call, install services, enable
capture or access this chat's native tools. Stop with Ctrl-C; retain the adjacent
`.executor.json` receipt ledger and any unknown effects. A second process using
the same run is rejected by an owner lock. The worker keeps the existing registered
session alive and polls authenticated scoped dispatches. The backend must have
conversational admission enabled; absent workers advertise unavailable.

Before executing, the worker saves the dispatch intent in an owner-only ledger,
then fsyncs both the file and its directory entry. A flush failure refuses execution.
It saves the exact structured result before sending it. Repeated dispatches only
reconcile that result; lost result acknowledgments retry the same result identity,
never the agent task. A worker restart converts an unfinished local receipt to
`unknown`. No prompt/file contents are stored in the ledger. Cancellation is
polled at most every 500 ms plus HTTP time; authorization/transport loss requests
cooperative stop, and uncertainty remains unknown. Receipt capacity is bounded at
1,000; reconcile and archive intentionally rather than deleting history to resume.

A late result from a still-authenticated worker is retained by the backend as a
`remote_result_receipt`, without overwriting an already-unknown job or permitting
another dispatch. Reconciliation must explicitly resolve the original outcome.
If credentials expired or were revoked, the protected local result ledger remains
the evidence; the worker does not obtain a new session or replay the task.

The worker implements `/api/executor/{ready,next,events,result,command}` with the
existing exact session bearer. A readiness heartbeat attests the actual local
Codex version and exact project/session identity. A daemon never uses MCP to wake
an idle native chat. Native approvals still cannot be granted through voice/text.

For a supervised hosted file demo, first select an explicitly authorized project
and a protected connection already bound to that exact canonical directory. A
disposable project is preferable for the initial proof; do not copy or relabel an
existing repository connection to broaden its scope silently. A coordinating
operator may create a new protected connection for a separately authorized root
using the same pairing credential; the backend pairing credential is not bound
to a project, but every new session and local worker is. Preserve the old
connection and omit its installed-MCP ownership metadata from the new connection.
With the current build,
run these in two foreground terminals:

```sh
node dist/cli/main.js setup-session --agent codex --project /CANONICAL/AUTHORIZED/DEMO --connection /PRIVATE/connection.json --run-id NEW_STABLE_16PLUS_ID --runner remote-codex-app-server --execution-session api_managed
node dist/cli/main.js executor-worker --run /PRIVATE/runs/NEW_STABLE_16PLUS_ID.json --connection /PRIVATE/connection.json
```

Keep the registration process open. Its ready event must identify
`currentChat:false`, `executionSession:api_managed`, and the remote runner. Before
submitting the file task, inspect authenticated `/api/jobs` and require
`runner.available:true` with the observed Codex version, then select that exact
session in Messages using `/sessions` and `/use SESSION_ID`. These commands do not
authorize a call or desktop control. The worker's exact project root is its
allowlist; it does not supply native CUA tools from the desktop chat.

An absent worker refuses submission. Readiness expires after ten seconds without
a worker heartbeat; queued work then needs clarification instead of remaining
queued indefinitely. A claimed dispatch with no result becomes `unknown` after
the bounded 120-second remote deadline. Keep that receipt and reconcile it; do
not submit the same effect through another runner. A separately running
registration heartbeat cannot substitute for worker readiness.

### Real executor qualification

Official docs checked against installed-generated schema:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).
Installed versions: Codex CLI `0.166.0-alpha.5.1`, Claude Code `2.1.311`.
The qualified model was the installed account default `gpt-6-astra`; no unsupported
model substitution was made. Opt-in local fixture proof:

```sh
npx tsx tests/connectors-runner-spike.ts
```

The Codex version probe and App Server child do not inherit ClawdTime,
media/backend, OpenAI frontend, AI Gateway, LiveKit, Deepgram, deployment or
database environment namespaces. The executor uses its existing Codex login or
explicit host `CODEX_API_KEY`; frontend `OPENAI_API_KEY` is intentionally not
forwarded. `HOME`, `PATH` and `CODEX_HOME` remain available for the executor's own
installation and authentication. This is scoped namespace redaction, not a
promise that arbitrary unrelated environment variables or host files are secret-free.

This makes an actual model request using existing Codex login and writes only a
new disposable project fixture. On November 13 the implementation accepted at
309 ms, emitted actual command progress at 4,096/6,998 ms, independently verified
the exact output file at 8,360 ms, and finished at 8,362 ms. A preceding direct
protocol proof accepted at 221 ms and independently verified at 13,481 ms.
Both passed; two samples are not a latency distribution, CUA benchmark or physical
handset acceptance. The fuller broker proof also passed:

```sh
npx tsx tests/connectors-broker-spike.ts
```

This uses a scripted **synthetic** clarification frontend and simulated Messages,
with the **real** managed Codex executor. Clarification preceded durable submission;
executor acceptance was 301 ms, a status question during deliberately slow work
returned in 0.654 ms, independent verification completed at 20,670 ms, and the
final result was reported through the simulated outbox. Total elapsed was 20,688
ms with three simulated message receipts and zero calls. This demonstrates
conversation/execution independence, not real text-model latency or provider delivery. No calls, Messages delivery, UI input, acoustic echo or native
CUA were exercised. Lifecycle tests cover unavailable host, identity, duplicate
dispatch, approval, cancellation, unknown outcomes and scoped verification.

The actual authenticated HTTP pull-worker path also passed:

```sh
npx tsx tests/connectors-remote-spike.ts
```

This runs the real application routes, shared broker and local worker against the
installed Codex executable. The frontend and Messages transport remain synthetic.
Executor acceptance reached the backend at 415 ms; concurrent status returned in
2.155 ms; independent file verification occurred at 11,975 ms; the result reached
the backend at 11,982 ms and was reported. Total elapsed was 12,002 ms, with zero
calls. The temporary server, runner and worker closed afterward. This is local
loopback HTTP qualification, not a hosted deployment or real iMessage delivery.

Use `npx tsx tests/connectors-remote-spike.ts --lifecycle` for the additional real
executor revision and cancellation probe. It revises an accepted job, independently
waits for original executor quiescence and explicit revision confirmation, checks
the revised file, then cancels another accepted job and checks that its
output is absent. An ambiguous cancellation is reported as `unknown` and fails
the qualification rather than replaying the work. The frontend remains scripted,
HTTP remains local, and Messages remain simulated.

On November 13, the `0.3.2` source lifecycle probe passed with installed Codex
`0.166.0-alpha.5.1`: acceptance 480 ms, concurrent status 3.375 ms, initial exact
file verification 13,555 ms and result receipt 13,572 ms. An accepted-job revision
canceled the original dispatch, waited for explicit confirmation, then verified
the revised file; correction-to-result took 7,439 ms. A separate accepted job
canceled in 109 ms with no unresolved effects and no output file. Total was
21,402 ms, with zero calls. These are individual local samples, not production
latency or handset acceptance. The first lifecycle harness expected automatic
revision continuation and timed out; it was corrected to exercise the existing
confirmation requirement, with no relaxation of broker policy.

The earlier Codex file-predicate probe did not cover document discovery, preview
selection or attachment transfer. Its verifier checks an explicitly expected
UTF-8 substring in a bounded file. Those operations now use the separate scoped
`remote-documents` host described above, including manifest, exact selection,
preview and attachment receipt contracts. A real résumé demo still requires an
authorized folder, a current exact-file/paired-recipient send instruction and
physical acceptance. No original résumé or real recipient was used by these
fixture probes.

For the independently orchestrated voice frontend proof, the lead can start
`npx tsx tests/connectors-voice-executor-spike.ts --handshake PRIVATE_NEW_FILE`
with the real configured text-model environment. It binds only loopback, writes
an exclusive mode-600 handshake containing a random fixture bearer, and runs for
at most 90 seconds before cleanup. The authenticated `/fixture/turn` endpoint
accepts the real `GPTLiveFrontend` callback shape; `/fixture/jobs` returns actual
broker state and `/fixture/finish` stops the fixture early. It connects the real
text model, broker, HTTP worker and installed Codex using a disposable project.
No transport drain runs, so no Messages or calls are dispatched. Output contains
only state, verification and timing metadata. The Python voice frontend and
provider path must be measured separately; launching this harness alone proves
neither voice delegation nor handset audio.

### Bounded desktop adapter qualification limits

`tests/connectors-desktop-adapters.test.ts` exercises the shared native/custom
policy lifecycle with supplied **synthetic** ports: one bounded action, local
grant rechecks, fresh observations, semantic verification, correction/Stop/hold,
exclusive ownership, unknown acquisition/input/release, stable dispatch identity
and no adapter fallback. It also checks the flat gateway/helper wire mapping.
These tests do not provide native desktop tools to the managed runner, measure
latency/success rates, qualify speakerphone behavior or satisfy controlled
physical trials. `auto` selection remains unavailable until those trials pass.

## iMessage-first interaction and timing — source implementation

New v2 MCP/foreground registrations request `interaction.version: 1`, command
channel `imessage_first`, and `messageUpdates: true`; `--message-updates false`
opts a fresh run out of automatic status updates. New v2 capabilities advertise
`voiceInteractionVersion: 1`. None of these fields enables capture/input or
qualifies duplex audio. Existing protected runs are never upgraded in place.

`conversation_inbox {}` discovers active requests for this already-running exact
session, including call-free text work. It does not wake an idle coding host.
The foreground bridge checks non-setup request IDs against this scoped inbox;
legacy setup-specific operations remain restricted to their saved setup request.
Text-only requests cannot acquire call-bound screen control.

`conversation_reply` accepts optional `channel: text|voice` when the poll advertises
`capabilities.interactionVersion: 1`; omission follows the incoming turn's channel
for negotiated sessions. An explicit unsupported channel fails before dispatch,
never silently falling back to speech. Stable reply IDs and unknown receipts remain
mandatory. New `expectedCursor` fields on `transfer_execution` and
`act_on_shared_screen` are negotiated and forwarded unchanged. Read and acknowledge
new turns, inspect cursor/pending delivery/hold, and recheck before native input.
Native cancellation remains host-dependent; a preflight check is not an atomic
lock over an external native tool. Polling returns promptly on `hold.active` even
before final recognized text exists; interim words never become actions.

`conversation_timing {requestId}` is a read-only local snapshot with no HTTP call.
It records start/completion/failure of connector HTTP poll, ack, progress, reply,
cancel, end, execution-status, ownership, observation and action requests. Each
attempt has an opaque unique correlation ID; memory is capped at 64 events per
request, 100 requests and ten minutes. Backward/24-hour monotonic clock changes
reset the scope; late completions cannot revive old data. Request text, response
content, credentials, image data and error bodies are absent.

Connector diagnostic reads automatically include this local `connectorTiming`;
the standalone timing tool is also available without a server read. Supply it alongside backend `controlTiming` and media
`speechPipeline` to the existing session inspector. It reports connector round
trips, ownership/frame/input intervals, TTS first byte/publication, interruption
clearing/reporting and event-loop lag. Samples never span processes/generations;
failures and missing stages remain counted. These boundaries do not measure hidden
native tool internals, model inference, handset audibility or phone screen lag.
Recorded source support and isolated tests do not establish physical acceptance.

## Legacy agent-owned protocol v2 (default without managed opt-in)

In legacy sessions, ClawdTime transports human turns and speaks replies authored by the exact existing
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
unchanged. Legacy playback remains half duplex. Negotiated duplex requires explicit media
policy and audio-isolation evidence; physical barge-in remains unqualified.

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
text from terminal turns and retains minimal state/IDs/receipts. It does not store
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

### Explicit realtime voice in the same chat

For a fresh v2 `setup-session` or MCP registration, `--voice-frontend elevenlabs`
selects immutable `voiceFrontend: {version: 1, provider: "elevenlabs"}`. It can
coexist with the selected screen camera and verified native desktop capability.
Omission preserves the existing voice path. The `run` wrapper refuses the flag;
managed `--runner`/`--execution-session` combinations are currently unsupported.
This selection does not create a coding agent or change the execution host.
Provider readiness and qualified duplex audio remain independently required.
An older backend that fails to echo the selection is rejected after preserving
its registration result; the connector never silently falls back to legacy voice.
Adding or removing the selection on an existing protected run is refused.

The realtime frontend owns streaming dialogue. This chat continues to receive
ordered work through `conversation_turns`, acknowledge it, use its normal tools,
and report progress/results. Native input still requires exclusive claim/release
and the latest execution state. Voice interpretation does not grant native
approval, prove execution, or wake a finalized coding chat.

Use `prepare_voice_presentation` with `{requestId, preparation}` to provide
transient task context and prepared camera moves. `preparation` is
`{version:1, context, geometryGeneration?, contentRevision?, targets}`. Context is at most 2,000
characters; up to 12 unique targets contain `{id,label,rect}` and optionally
`annotation:{kind,text?}`. Rectangles are normalized source coordinates. Annotation
kinds are `pointer`, `arrow`, `rectangle`, `highlight`, and `label`; labels require
text. With targets, first obtain `geometryGeneration` and `contentRevision` from
`screen_camera_status`. The connector checks both again before posting; the backend binds the
catalog to the current lease, geometry and content revision. Empty targets permit
context-only preparation without a camera. Context and labels are task data,
never instructions that change the voice model's authority.

Preparation replaces the in-memory catalog with a five-minute expiry. Neither
task text nor targets enter the foreground effect ledger. The returned strict
receipt contains only version, acceptance, expiry and target IDs; it does not
prove that the handset displayed a camera move. Preparation has no OS input and
is never automatically retried after an uncertain response. Stop, stale targets
and lost authority remain backend-enforced boundaries.
The voice tool `stop_sharing` ends camera sharing and shared-screen input while
the voice conversation continues. Local Stop retains its stronger pause behavior,
including blocking voice capture and new tool execution.

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
member, device and display. A fresh line requires its own one-use setup link,
issued through onboarding or the authenticated operator route below.
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

#### No-call production-demo staging

Use the user's confirmed existing provider project and line; do not reassign the
line. The current demo plan uses an explicitly selected
`NativeTransportConfig.textTransport: "standard_once"` with the existing messaging
service. A native receipt-service upgrade is not a prerequisite for this plan.
Omitting this setting retains `strict_receipts`; a failed receipt lookup never
switches adapters automatically. Standard mode submits an authorized text once
and requires a positive native acknowledgment. It has no durable receipt lookup:
timeouts, ambiguous responses and unknown outcomes remain unretryable. Its
read-only readiness result does not prove message sending or handset delivery.

The coordinating lead can prepare the connection without sending onboarding text:

1. Preserve the old database with its configuration, connection directories,
   companion receipts and unresolved runs. Stage the new exact line binding in
   separate protected state; never relabel an old pairing or copy its token into
   a different binding. Reuse an existing grant only if its line, member, recipient,
   device and display match the intended authorization.
2. With operator authentication, `POST /internal/pairing` creates a one-use link
   for the exact `memberId`, `recipient`, `conversationId`, `lineId`, `deviceId`
   and `displayId` (optional `ttlSeconds`, maximum 900). This route stores an
   invitation without queuing a text or call. Keep its response private. Claim
   it once through `POST /api/pairing/claim` with the matching device/display and
   explicitly authorized view/control permissions. Preserve an uncertain claim
   for reconciliation instead of attempting it again.
3. Save the resulting grant as a new owner-only connector `Connection`, bound to
   the actual canonical project, adapter and host. Its `installed` field is
   optional for the foreground bridge. Keep the existing project MCP entry and
   skill intact; a new private connection path does not refresh a running MCP
   process. Do not invoke `connect` or installation over existing owned entries.
   Reuse the installed Mac application and permissions, while preparing any new
   companion binding through the documented Mac procedure above.
4. Start the foreground bridge in this same chat with a fresh run ID and the
   verified connection. Select the actual camera surface and attest native tools
   only after verifying they operate that same surface:

```sh
node /absolute/path/to/clawdtime/dist/cli/main.js setup-session --agent codex --project /absolute/project --connection /absolute/private/new-connection.json --run-id NEW_CURRENT_CHAT_RUN_ID --native-control desktop --shared-surface true --native-cancellation false --screen-camera true --camera-display DISPLAY_ID --camera-window WINDOW_ID --camera-owner-pid OWNER_PID
```

Keep stdin open and inspect `status`; registration and heartbeats do not dial.
During this staging phase, do not issue `invite`, `authorize`, `start`,
`request_attention` or any call command. In particular, bridge `invite` means
`POST /api/setup/test`, which queues an informational text; it is distinct from
the operator pairing invitation above. This prepares the exact same-chat session
without a new agent or managed runner. Production camera transmission, native
claim/action/release and handset visibility still require the separately
authorized supervised call; staging does not establish that acceptance.

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

## Scoped activity and outcome receipts

V2 progress accepts optional `presentation` when the exact request's polling
response advertises `capabilities.presentationVersion: 1`. The connector probes
that read-only capability before its first extended progress write and omits the
extension for older servers. A timeout never triggers a second progress write or
legacy `complete()` fallback. Legacy clients can keep reporting state alone.

```json
{
  "requestId": "synthetic-request",
  "turnId": "synthetic-turn",
  "state": "completed",
  "presentation": {
    "version": 1,
    "outcome": {
      "outcomeId": "observed-result-1",
      "summary": "The synthetic test passed.",
      "verification": "agent_observed",
      "evidenceKind": "test_result"
    }
  }
}
```

Intermediate `presentation.activity` uses `activityId`, `kind` (`status` or
`approval_needed`) and `summary`. Summaries allow at most 160 Unicode scalars and
640 UTF-8 bytes. IDs are stable: identical retries reconcile the existing record;
changed content requires reconciliation, never action replay. Activity is visual
only; use the existing one-reply-per-turn speech protocol for useful answers or
clarifications. Do not expose tool dumps or internal reasoning.

The terminal turn determines outcome status. `agent_observed` is the originating
agent's report of an actual observation, not server certification. `not_verified`
means no verified result; `unknown` means unresolved. Submitted input and completed
speech are insufficient evidence of UI success. Inspect the returned/polled receipt
and summarize it in the original chat; there is no unsolicited chat injection.
Completing a turn leaves its call connected. End it explicitly when appropriate.

Activity text is transient (20 entries/request, 10 minutes, 100 active caches).
Outcome summary text lasts at most 60 seconds while the exact call remains
allowed. Stop, policy loss and call close clear it earlier. Metadata and
fingerprints survive restart; summary text does not. Replaying an old report does
not extend its lifetime or restore cleared text. The tracked source skill
contains this workflow; implementation validation does not update installed skills.

## Isolated session inspection

Run the deterministic synthetic report without credentials or live services:

```sh
npx tsx scripts/inspect-session.ts
npx tsx scripts/inspect-session.ts --export /tmp/clawdtime-synthetic-report.json
npx tsx scripts/inspect-session.ts --input /tmp/explicit-diagnostic-fixture.json --export /tmp/clawdtime-inspection.json
```

Export is explicit and creates a new owner-readable file; an existing file is
never overwritten. Input is limited to 1 MiB, three bounded sources and 64 events
per source. The tool never reads installed configuration, queries production,
contacts a model, or copies the raw response. A caller with separately authorized
scoped diagnostics access can provide an explicit local response file. Treat that
input file according to its original retention policy; the inspector does not
archive it. File input is labeled `unclassified`, never presumed physical.

The allowlisted report includes short opaque process/correlation labels, fixed
stages, monotonic offsets, validated UTC observations and aggregate timing.
Transcripts, arbitrary text, credential fields, phone numbers, project paths,
provider bodies and errors are excluded. Median uses the middle value (the mean
of the two middle values for an even count); p95 uses nearest rank. Each metric
includes attempted, successful, failed and missing-stage counts. Duplicated,
backwards or failed stages cannot produce a successful sample. Cross-process,
cross-generation and uncorrelated stages report missing/unavailable durations;
UTC observations are never subtracted to estimate precise latency. No dial
response is called handset ringing or screen visibility.

The default synthetic backend-to-agent fixture has five samples: median 300 ms,
p95 500 ms, zero failures and zero missing stages. This is a reproducible
calculation fixture, not a performance measurement of a real call or a comparison
with another product. Physical latency remains unqualified.

Readiness preserves existing check IDs/status/nextAction and adds fixed reason
categories plus the evidence timestamp: stale agent, locally stopped sharing,
screen/control permission, wrong binding, unreachable gateway, native approval
and unresolved prior effect. Reasons come from explicit categories/check IDs,
never prose or an inference that an unreachable Mac is asleep. Rechecks do not
call, capture, input, enable, install, reset permissions or grant a lease.

## Opt-in general screen camera v1 (local implementation)

The camera presents one explicitly selected display or window independently of an
IDE. It pans/crops the outgoing presentation; it does not change an app's zoom,
scroll, selection, or files. It adds no agent session and grants no native or
fallback input permission. The existing session and call remain the owners.

For a **new** v2 MCP or foreground `setup-session` registration, opt in with:

```sh
--screen-camera true --camera-display DISPLAY_ID
# Or one exact window on that display, with its current owner process:
--screen-camera true --camera-display DISPLAY_ID --camera-window WINDOW_ID --camera-owner-pid PID
```

IDs come from the local capture surface listing. The session stores immutable
`screenCamera:{version:1,surface:{kind,id,displayId,ownerPid?}}` and advertises
`capabilities.screenCameraVersion:1`. These flags record a selected capability;
local viewing permission, helper opt-in, current leases and Stop still govern
capture. Omission leaves the camera off. Protocol v1 and document-only runners
cannot opt in. `run` refuses these flags because it does not rewrite the owned MCP
configuration. Reopening a protected run with a changed camera selection fails;
finish its cleanup and explicitly select a new session to change surfaces. Never
replace a session to evade unresolved input or call receipts.

MCP and foreground JSONL expose the same commands:

- `screen_camera_status({requestId})` reads current metadata through authenticated
  `GET /api/attention/:id/conversation/camera`. It returns the exact session/device/
  lease, source frame and geometry identity, revision, live/paused/unavailable
  state, crop and output viewport. It contains no screenshot. Success requires a
  fully validated version-1 response from the current backend/media/helper path;
  a connector flag alone does not establish support.
- `screen_camera_command({requestId,command})` sends one strict command through
  `POST` at the same route. It probes status first when support is unknown. Old,
  unavailable or malformed peers fail without a legacy fallback or a mutation.

Every mutation carries `version:1`, stable `commandId`, `expectedRevision`,
`sourceFrameId`, and `geometryGeneration` from the status being acted on. The
operation is `focus_region`, `zoom_out`, `overview`, `pin`, `unpin`, `freeze`,
`resume`, `annotation_upsert`, `annotation_remove`, `clear`, or `context`.
Rectangles are normalized source coordinates (`x,y,width,height`) contained in
`[0,1]`, with minimum width/height 0.01. Focus transitions accept 0–1500 ms and
an optional `automatic` flag; zoom-out accepts a factor of 1–8. An annotation has
a stable `id`, `kind` (`pointer`, `arrow`, `rectangle`, `highlight`, `label`),
rectangle, optional text and `ttlMs`. Text is at most 160 characters without
control characters; TTL is 100–10000 ms. Context takes text and TTL. The renderer
bounds active annotations to 16. Full limits and lifecycle enforcement are in
the shared schema and camera engine. A pin preserves coordinates, not semantic
tracking of an app object.

```json
{
  "requestId": "synthetic-request",
  "command": {
    "version": 1,
    "commandId": "focus-1",
    "expectedRevision": 0,
    "sourceFrameId": "fresh-source-frame",
    "geometryGeneration": "current-geometry",
    "op": "focus_region",
    "rect": {"x": 0.2, "y": 0.2, "width": 0.4, "height": 0.4},
    "durationMs": 450
  }
}
```

Receipts report accepted/superseded command identity and revision, never handset
visibility. No connector automatically retries a camera write or input. After an
uncertain result, inspect status and reconcile the original command. Foreground
camera mutations are transient and do not append to its durable effect ledger;
server generation/revision and bounded command receipts determine duplicate
behavior. Camera labels, context and frame metadata are not written to protected
run files. A restart must revalidate current authority and source state.

`act_on_shared_screen` retains the existing executor, epoch, action ID, pristine
observation frame, fresh-input and verification requirements. Its optional
`presentation:{revision,geometryGeneration,sourceFrameId}` means click/scroll x/y
are normalized outgoing-video coordinates. The backend/media path checks the
exact current transform and maps into the existing source-input path. Letterbox,
stale or frozen-view input is rejected. Without `presentation`, the original
source-coordinate contract remains. The foreground JSONL bridge still refuses
fallback observation/input; use image-capable MCP or separately qualified native
tools under exclusive ownership. Camera-only commands never submit OS input.

Selected-window **viewing** is implemented; selected-window ClawdTime fallback
input is unavailable pending exact hit-target/occlusion qualification. A window
capture can show content behind another app, so global mouse input cannot safely
be inferred from its pixels. Use a separately authorized display camera for the
existing fallback path, or the actual connected agent's independently qualified
native tools. This is a capability limit, not permission to widen capture or
silently switch surfaces.

Connector checks for this slice:

```sh
npx vitest run tests/connectors-camera.test.ts tests/connectors-camera-mcp.test.ts tests/connectors-conversation-mcp.test.ts tests/connectors-conversation-bridge.test.ts tests/connectors-conversation.test.ts tests/connectors-interaction.test.ts
```

These include an actual stdio MCP process against a synthetic local HTTP peer,
immutable surface restart rejection, strict status/command negotiation, no camera
input, no retry after uncertain writes, and foreground transient-data checks.
They do not establish real-app capture, OS input or FaceTime acceptance.
