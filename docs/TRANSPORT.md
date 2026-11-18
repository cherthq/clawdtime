# Transport and durable backend

## Independent coding-task ledger (step a)

The coding demo uses `src/attention/task-ledger.ts`, separately from the legacy
original-chat attention/session protocol. It reuses the existing transactional
`Store` and AES-256-GCM `Vault`; it does not import the Argos broker's transient
instruction store or relax its original-chat guards. The task service must have
one database owner and must authenticate the exact independent session before
every ledger operation.

Task goals, project references, scoped instructions, bounded worker summaries,
decisions, verification reports, call openings and event receipts are encrypted
at rest. Protected envelopes verify their record kind and identity after decrypting.
The service's protected key is required to reopen the database; a replacement key
does not recover old context. Screens and audio are never ledger content.

Every mutation checks the task revision and commits its event fingerprint and
result in one SQLite transaction. Identical delivery returns `replayed:true`; the
worker caller must never dispatch from a replayed claim. Changed content under the
same event identity fails. Each invocation has a different run and dispatch ID;
the original task ID persists through decisions and final review. Verification
and call histories remain intact across follow-up runs.

Only one worker or verifier can be unresolved globally. Running/unknown run
receipts and unknown call receipts independently fence new dispatch even when a
different lifecycle state changes. Startup turns in-flight execution, verification
and connected calls into unknown outcomes. Queued work stays queued. The exact
original worker dispatch can supply its terminal receipt; no new run, retry or
operator assertion substitutes for that evidence. Verification restart recovery
is deliberately fenced until a future exact verifier-receipt reconciliation path
is implemented.

Running cancellation records a request and waits for the original worker outcome;
it does not claim the worker stopped. Call lifecycle updates cannot overwrite a
newer run's state. A passed check requires exit code zero; empty or inconsistent
verification reports fail validation. Worker prose alone cannot reach review-ready.
All calls in step a are explicitly simulated; the ledger rejects live preparation.

Validation: `npx vitest run tests/backend-task-ledger.test.ts` covers encrypted
restart context, revision/event conflicts, exact session/dispatch binding, global
serialization, cancellation, call/execution races, unknown outcomes and transaction
rollback. These synthetic checks do not establish real worker or handset behavior.

Step b adds `src/control/task-engine.ts` over the same ledger. A service-owned
dispatch claim precedes each Codex invocation. Terminal worker results retain
bounded original thread/turn references. The watcher runs the explicitly configured
checks independently; an unavailable executable, interrupted process or unresolved
child cannot become passing evidence. Raw check output is discarded after counting
bytes and computing a bounded digest. A brief binds its opening and question to
the current run and verification report and is cleared when a revision queues the
next run. Preparing this brief neither dials nor grants presentation authority.
`tests/backend-task-engine.test.ts` additionally covers actual local verifier
processes and the HTTP run/decision path, including identical decision replay.

Step c adds `src/attention/task-voice-ledger.ts`. A local audio session opens only
against the current prepared task brief and explicit task-session voice permission.
Its provider conversation is write-once and cannot be reused by another session.
No screen, presentation, control or live phone authority is granted. An expired
record still requires an explicit end before another voice runtime is admitted;
expiry alone does not prove the previous provider connection ended.

Finalized human instructions bind the exact voice/provider conversation, utterance,
task, run and source revision. The trusted runtime first registers finalized text;
the model's instruction tool only references that registered identity. Identical
utterances cannot create another run even under a different model-tool event ID.
All retained text and provider identities are encrypted. The service can explicitly
reconcile finalized speech after same-run progress; it retains the original source
revision and cannot retarget the instruction to a later run.

One instruction may be held while execution or verification runs. The task and
utterance receipts commit atomically when the original run has a known terminal
outcome and completed verification. Unknown/canceled outcomes remain fenced. A
held instruction survives voice end because ending audio does not cancel authorized
task work, but current task-session authority is still required before release.
Restart never releases it automatically. New typed decisions are refused while a
held spoken instruction is waiting, preserving the order of admitted instructions.

`tests/backend-task-voice-ledger.test.ts` covers admission, provider binding,
cross-session isolation, encrypted context, utterance replay/conflicts, transactional
failure, same-run reconciliation, held work, cancellation and restart. These tests
do not establish microphone quality, provider audio or handset acceptance.

ClawdTime is a single-node SQLite pilot. Its database is independent from Apple
Teams, owner-only, WAL-mode and uses synchronous commits. No source runtime state
is imported. Node 24+ provides the SQLite runtime.

## Source migration

Reviewed/extracted from Apple Teams commit
`be47b11fe1317c4747db4121bec37896998b5201`:

- `src/store.ts` → `src/storage/store.ts`: synchronous transactions, entity/state
  storage and durable effect receipts; the workspace domain was removed.
- `src/security.ts` → `src/storage/security.ts`: random capabilities, hashes,
  constant-time comparison and AES-GCM credentials envelope.
- `src/chert/messages.ts` → `src/transport/native-messages.ts`: exact native
  identity, HMAC request signature, event anchor, sequence validation, observed
  iMessage DM normalization and phone-bound once-only text receipts.
- `src/chert/calls.ts` → `src/transport/native.ts`: explicit logical line,
  customer-managed call allocation, encrypted media credentials, silent/video
  publisher readiness, worker `bridge_ready` activation and cleanup reservation.

This is selective code and protocol adaptation, not a copy of source workspace,
calendar, group, membership, notes or customer data. Group/SMS/attachment/echo
observations never become ClawdTime prose commands.

## Domain and authorization

`ClawdTime` in `src/attention/service.ts` owns pairing invites, scoped credentials,
agent sessions, attention requests, human responses and durable effects. Invite
creation is an internal operation for an authenticated messaging identity, with a
prebound device/display. A caller-supplied phone number is not authentication.
Invites expire after at most 15 minutes and are consumed atomically once. Only
credential digests are stored. Reconnection preserves the external session/project/
host/adapter binding and replaces its credential. Revocation does not revive sessions.

Session credentials cannot read or acknowledge another session's response.
For legacy protocol v1, `result` is a repeatable non-consuming read; `ack` records delivery; `resume`
separately records agent continuation and requires a current control epoch and no
active/unknown lease or unknown input. This preserves native agent approval policy.
Legacy cooperative adapters yield before requesting attention. Protocol v2 keeps
the originating session active while a call and screen sharing continue. Conflicting
computer input still requires explicit execution ownership; reasoning and file work
do not require control of the display.

Voice feedback requires the exact active local call, qualified remote participant
and private member binding. A voice approval is rejected. HTTP/media callers must
add participant/source and explicit-addressing checks before calling the domain.
These checks are session context, not biometric speaker identification.

## Receipt and recovery semantics

Request keys are scoped to the exact session and fingerprinted. Reusing a key with
changed arguments fails. A call reservation and pending effect commit in the same
transaction as the request. Dispatch changes pending to running before a network
call. A timeout or restart during dispatch becomes unknown, never pending. Calling
drain again cannot replay an unknown effect. Unknown calls reserve the dedicated
line until reconciliation. New request keys do not escape that reservation.

Human event effects and native cursors commit in the same SQLite transaction.
The entire fetched page is checked for identity/sequence/head consistency before
any command runs. A changed/lost anchor or gap fails closed. `baseline()` refuses
to replace an existing cursor. Historical events never become new commands merely
because the service restarts.

Native allocation is not an answered call. Only authenticated worker
`bridge_ready` enables media, and only `cleanup_complete` releases an allocated
line reservation. Native terminal events close media immediately but preserve the
reservation while native cleanup is pending. End requests are not hangup proof.
Prepared calls canceled before any dispatch can release locally because no external
effect was attempted. Revoked or terminal screen leases remain unknown until the
control coordinator confirms helper release, preventing premature continuation.

`NativeTransport` uses `ct_` plus the first 40 SHA-256 hex characters of the attention
request ID as the media/local call ID. The provider's call ID is stored separately
for native Calls API reads/end requests. Media activation, policy, segments and
helper leases all bind to the local ID.

## Live gates

The runtime must supply an explicit `NativeTransportConfig` with enabled traffic,
exact native binding, current allowlisted tester, isolated media/project credentials,
fresh 32-byte encryption key, and a verified handoff record. That record contains
the exact logical/provider/instance identity, retained baseline and private rollback
record path, and records that the source owner is paused. This object records an
operator's verified handoff; it cannot independently stop another application.
Follow LINE_HANDOFF.md before producing it. Never infer exclusivity from a display
name or run two pollers against the same line.

No live number or secret belongs in this repository. Default execution uses
`SimulationTransport`; simulation receipts explicitly report simulated status and
are not FaceTime delivery evidence. No ClawdTime live call has been qualified by
the transport unit tests.

## Validation

`npx vitest run tests/backend.test.ts` exercises the local durable loop, repeat
calls/results, wrong sessions and identities, request key conflicts, expiry,
no-answer/decline/failure, voice gates, one-use pairing, control epoch arbitration,
revocation, interrupted dispatch, feed identity, atomic event/cursor handling and
sequence gaps. Real call/screen acceptance is recorded separately in STATUS.md.

### Read-only reconciliation and standby cleanup

`NativeTransport.pollCalls()` can recover an interrupted domain commit when the
media ledger already contains the exact provider call ID from a validated call
allocation response. It reads that ID's events, verifies `call_id`, then commits
the existing effect and domain call binding without issuing another dial. If the
allocation response itself was lost and no provider ID was retained, the outcome
remains unknown. No undocumented provider lookup or new call is substituted.

Unknown text-operation receipts retain their original operation origin. The
source adapter does not establish a read-only lookup contract for that API, so
ClawdTime cannot automatically clear them. Operator recovery must obtain exact
provider evidence for the retained origin before changing state. Do not replay a
send, reset a cursor, delete a ledger or invent a new idempotency key to unblock it.

Native hangup is attempted with its stable effect ID even if media close is
unavailable. Media closure and native cleanup are tracked independently. An end
request remains a reserved call until worker cleanup is observed. Standby cleanup
uses `service.drain({cleanupOnly:true})` and native call polling, with no new call,
message, or inbound-message processing. Standby is not permission to abandon an
already-owned native call.

The current operator recovery boundary for unknown helper actions/leases is
conservative: read the exact helper/gateway receipt and prove release/observation
before updating the associated local receipt. There is no public endpoint that
accepts a caller's claimed success. Unknown or submitted-but-unobserved input
blocks agent continuation. Automated operator reconciliation is not claimed.

### Attention question playback

After native `bridge_ready`, media activation finishes its consent notice before
ClawdTime submits a separate question utterance. The spoken question is bounded to
36 words and 280 characters. Its stable ID is `<attention-id>:question`, bound to
the exact local call/media session. A dispatch intent is persisted first. Accepted
or uncertain speech is reconciled only through GET of that exact media receipt;
there is no repeat POST after a timeout or restart. Media-source playout completion
is not proof that the handset was audible. Speech unavailability leaves viewing,
text feedback and call cleanup operational and the speech outcome marked unknown.

Setup calls omit this scripted question playback. The exact stored setup test must
match the attention request, session and pairing; an ordinary request or a
caller-supplied task label cannot suppress its question. Setup keeps neutral
conversation context without asking the human to perform a screen test. Existing
question speech receipts remain intact and are reconciled by GET only, including
uncertain playback from an earlier version. No absent utterance is marked spoken
or completed. This omission does not establish screen visibility or relax setup
verification, local Enable, or fresh one-call authorization.

### Connector liveness

Registration records `lastSeenAt`. The connector must explicitly heartbeat while
its native agent process is alive; ordinary status/result/authentication reads do
not renew liveness. The backend stops a session after 20 seconds without a heartbeat,
increments its control epoch, invalidates its leases and queues owned-call cleanup.
An expired/stopped session cannot be revived by a late heartbeat or by registering
the same external session ID. Native call reservations remain until confirmed cleanup.

New attention requests without an explicit timeout use a renewable five-minute
window once the exact call is connected and its remote participant qualified.
Only an explicit heartbeat from the same cooperatively yielded session extends
the still-unexpired request; setup expiration follows that deadline atomically.
The original consent, request, call and effect identifiers are preserved. Ringing
or unanswered calls retain their initial deadline. Explicit caller timeouts and
legacy requests without the internal renewal flag remain fixed.

Renewal refuses stopped/revoked or answered/terminal requests, local Stop, pending
termination, closing/unknown media, stale or mismatched active leases, and uncertain
inputs/effects. A heartbeat cannot revive an expired request. The independent
20-second connector-liveness timeout still stops orphaned calls; status reads do
not renew either lifetime. Completion, human hangup and control revocation retain
their existing cleanup and receipt rules. These automated checks do not establish
sustained handset acceptance.

### Native opt-out observation compatibility

The source's installed-feed exception for `lead_opted_out` is retained. A line-less
administrative observation advances the cursor only when its inbound source, exact
message GUID, event ID and recipient correlate to an earlier fully authenticated
message in the retained anchor or same page. It never executes as a command.
Conflicting supplied line identity, another recipient, or future-only correlation
is rejected. Validated cursor rows retain a fingerprint, allowing an administrative
row to remain the next poll's anchor while detecting changed evidence.

## Live setup preflight

`NativeTransport.preflight()` performs GET-only checks of native `/api/v1/whoami`,
the retained event anchor, project-scoped `/api/v1/lines`, and the independent media
`/health`. It neither consumes messages nor advances a cursor, creates a room,
places a call, captures a frame, or changes routing. The protected audit form
`new NativeTransport(store, config, fetch, {readOnly:true})` permits diagnosis before
a handoff is complete and rejects POST through all exposed provider clients.
Incomplete ownership remains a failed readiness check.

Required protected configuration remains `NativeTransportConfig` plus runtime
`testers` entries (`memberId`, `recipient`, `deviceId`, `displayId`). The handoff now
requires matching `phone`, `identityEvidence` and `sourcePauseEvidence` references
in addition to owner, source-paused flag, logical/provider/instance IDs, retained
baseline, finite non-future `checkedAt`, and `rollbackRecord`. References identify
private reviewed evidence; do not put personal identities, numbers or secrets in
tracked artifacts. The logical line is a UUID. The native `pl_` ID and native
inventory UUID are different domains; do not substitute one for the logical ID.

Calls inventory must contain the exact logical line, with confirmed worker identity
and a recent heartbeat. A null inventory phone number is allowed because the
reviewed private handoff supplies the native-to-logical join. A conflicting non-null
phone is rejected. Missing or contradictory logical identity, stale worker heartbeat,
foreign occupancy, or undeclared media capability blocks new effects. A raw
`audio_ready:false` is accepted only when the automatic `system_audio_capture`
check explicitly reports `at_call_start`; this is deferred verification, not audible
handset evidence. A known owned call can remain ready for result messaging; a new
allocation requires idle occupancy.

Media health must identify `service: clawdtime-media`, be configured, and report a
connected device gateway. Scoped helper metadata is read from
`/devices/:device/readiness/:member/:display`. Exact member/display ACLs, attached
display, permissions, availability and local Enable must agree. These are metadata
reads only. They never arm a device or begin screen capture.

`doctor()` reads cached checks no older than 30 seconds, bound to the exact pairing,
member/display and current provider configuration fingerprint. It distinguishes
simulation/standby from `readiness.liveReady`; pairing consent alone does not imply
live readiness. Missing evidence is unknown, never assumed ready. The runtime must
refresh preflight before ingestion and helper evidence for paired users. Call and
message dispatch independently recheck applicable evidence before provider effects.
A failure proven to be in read-only preflight leaves the existing effect pending
with a blocked reason; no external attempt is marked unknown or retried. Once an
external attempt is possible, the ordinary unknown-outcome rules still apply.

### Source pause and resume mechanics

At the audited Apple Teams commit, `LIVE_TRAFFIC_ENABLED=false` while preserving
`APP_MODE=live`, credentials and the existing database stops native message polling
and new worker scheduling/draining. New inbound calls are declined; owned-call
polling continues cleanup. SIGTERM waits for the in-flight integration tick before
closing storage. There is no per-line pause API; the deployment's dedicated-line
ownership must be established before applying its process-wide gate.

Verify `chert.enabled:false`, healthy subsequent heartbeats, zero pending/unknown
jobs and closed owned calls through protected readiness. Review failed jobs rather
than deleting them. Previously accepted incoming callbacks can retain their original
nine-second replay window, so an idle handoff should observe at least ten seconds
after the source pause before enabling another owner. Read the committed
`messages:<logical-line-id>` operational-state cursor in place through protected
operator access; the source does not expose a cursor mutation endpoint. Do not copy
its database or message history. Resuming source ownership requires reconciling all
intervening events and effects before any cursor update; source provisioning rejects
replacement of an existing baseline.

Target standby must call `pollCalls(observe,{cleanupOnly:true})`. This also handles
a crash between provider allocation and domain-receipt commit: retained provider IDs
are recovered only for cleanup, never media activation or question playback. Shutdown
can pass `shouldStop` to `service.drain()` to finish the current effect without
starting another. No deployment or routing changes are performed by these checks.

### Same-session setup test

An authenticated, allowlisted first private iMessage such as “Hey agent” receives
one warm welcome containing a copyable `/agents` instruction and expiring
`/setup#token=...&device=...&display=...` link. The human pastes the instruction
into the Claude Code or Codex chat already doing the work. Tokens remain in the URL
fragment. The existing one-use invite binds the member, line, conversation, Mac
and display; an arbitrary phone number never grants pairing authority.

The welcome is one durable notice, not multiple independently retried texts.
Native event identity and the committed cursor suppress repeated feed deliveries;
repeated polling does not create another invitation or send. An uncertain notice
stays unknown and is never automatically resent. A genuinely new inbound message
is a new event; before pairing it can create another scoped one-use invitation.
Once paired, a message with no pending attention request receives guidance back to
the connected coding agent, rather than creating a new agent or placing a call.

A like/tapback is **not implemented or claimed** in this welcome. Chert source has
strict once-only reaction routes, but they require separate receipt-journal and
exact target qualification. In particular, reaction dispatch still uses its own
strict chat-context predicate; a repaired text path is not reaction qualification.
No unreceipted `/react` fallback or cosmetic resend is permitted. Native ingestion
currently accepts private iMessage text only; ordinary carrier SMS, groups and
attachments are not a supported onboarding channel. Calling the number inbound is
not implemented: the test call originates from the exact connected agent session.

`SetupService` stores a setup test bound to the originating session. A new live
invitation requires fresh passing doctor evidence, and queues a normal durable
message with a stable ID. Repeated invitation calls return the same test, including
canceled/expired attempts. Another session cannot create an ambiguous pending test
for the same member, line and conversation. Normal setup never replaces an old
attempt; the narrow historical retirement/retry mechanism below remains separate.

New tests use native-session authorization: the originating connector attests the
human's actual explicit permission for one exact, unexpired test through
`POST /api/setup/test/authorize`. The welcome, a tapback, general setup intent and
an old call permission do not themselves authorize a new call. No new SMS code or
confirmation phrase is required. Existing coded and uncoded SMS approvals remain
supported only for their historical test records. Approval never dials on its own:
the same coding session must yield and explicitly start. Repeated start returns
the same attention request and call effect. The initial approval window is ten
minutes; authenticated approval starts a ten-minute readiness/start window, and
starting the call binds test expiration to its attention deadline. Duplicate
approval/start does not extend these windows. Cancellation, expiry, revocation and
session loss initiate owned cleanup while preserving unknown outcomes.

Verification is a separate evidence gate: live transport, qualified connected call,
a bound fresh screen frame, the authenticated human's later visibility report,
feedback to the originating session, normal continuation, completed work and an
acknowledged Messages result receipt. A visibility report alone does not end the
call. Its event, request, call, pairing, session and admission time are retained as
metadata; a later explicit report that the screen is not visible supersedes it.
Model latency cannot make an earlier human report count as post-frame evidence.
No exact spoken sentence is required. Simulation cannot produce a verified setup,
and screenshots remain transient. Unknown outcomes remain blocking except for
separately validated immutable supersession audits; setup never clears them.

During an origin migration, `CLAWDTIME_COMPATIBLE_ORIGINS` may contain at most eight
comma-separated exact HTTPS origins. The canonical `CLAWDTIME_ORIGIN` remains the
origin used in new setup prompts. Explicitly listed legacy origins retain their
pairing response base URL; arbitrary Host/Origin values never become connection
destinations. Outside live mode, HTTP `127.0.0.1` origins are also permitted. Paths,
credentials, query strings, fragments and wildcard origins are rejected.

### Obsolete pilot onboarding notice supersession

The lead-only retirement operation recognizes only the original installation-link
notice template. It proves the embedded token identifies a consumed, expired
invite, the full identity/device/display binding matches one successful pairing,
and the original authenticated `pair` inbound was handled. It refuses while
another external operation or unresolved control action may be in flight. Future
pairing claims also record the resulting pairing ID on the invite.

Retirement inserts an immutable audit; it never edits the notice, cursor, invite,
pairing or provider. The old delivery remains **unknown**, its stable origin and
sealed payload remain retained, and replay is forbidden. Readiness exempts only
the exact audited notice while its notice/invite/pairing hashes and eligibility
still match. Mutation or invalid audit restores blocking. Unknown counts and the
retirement count remain visible in preflight recovery metadata; every other
uncertain notice, effect, call, submitted/unknown input and unknown lease remains
blocking. This is supersession of a now-unusable pairing invitation, not evidence
of failed delivery and not a general recovery or retry mechanism.

### Agent acknowledgement after an unsuccessful request

`ClawdTime.acknowledgeTerminal(sessionToken, requestId, controlEpoch)` explicitly
releases the originating coding session after cancellation, failure, expiration,
decline, unanswered call or disconnection. It is distinct from normal `resume`,
which still requires an acknowledged human response. The unsuccessful request is
unchanged; no answer, approval, completed result or Messages effect is created.

Release requires the exact current epoch, confirmed ended calls and closed media,
released screen leases, reconciled input receipts, and no competing session
attention or uncertain call/end effect. An immutable acknowledgement records
`humanApproval:false`; duplicate acknowledgement is idempotent while all cleanup
conditions remain satisfied. Stopped or revoked sessions cannot be revived. This
does not authorize retrying a setup test or placing another call; another test
attempt requires its own explicit approval workflow.

### Read-only screen diagnosis

`NativeTransport.mediaStatus(requestId)` reads only the retained request's exact
media-session ID. The HTTP layer must first authenticate ownership of that
attention request. The result contains bounded lifecycle metadata: call/media
state, caption availability, screen selection/frame metadata and persisted
`screenDiagnostics`. It never returns credentials, caption text, pixels, raw
provider errors or arbitrary nested fields. Missing or malformed provider state
returns a fixed unavailable reason and never triggers preparation, activation,
capture leases, redial, cleanup or other effects.

Persisted diagnostic timestamps and counters distinguish notice playback, lease
creation, first frame reception and screen-video emission after the live media
object closes. Emission proves media processing, not rendering on the handset;
the separate human confirmation and setup-verification gates still apply.

Conversation preflight metadata distinguishes provider HTTP failure, timeout,
invalid final reply and local tool rejection. Gateway wrappers are inspected at
the model boundary because the SDK can replace authentication failures with an
error that omits their original status and cause. Only bounded status, duration,
step count and fixed categories survive; provider bodies, prompts, images and
tool arguments are never diagnostic fields. Error inspection is depth-limited
and guards malformed getters. It neither retries the model nor dispatches input.
Each failed human-command receipt keeps its sanitized diagnostic alongside the
request's latest summary, so a later turn cannot erase the earlier failure reason.

An `invalid_plan` records one fixed tool-preflight reason: overlapping operations,
operation limit, malformed action, action limit, missing observation or mismatched
frame identity. This explains which local check rejected the plan without relaxing
it. If an earlier input was already observed, a later rejection remains a partial
turn and retains that receipt; it must not claim that no input was sent. Older
records lacking these categories cannot establish the original failure cause.

### Expired legacy setup invitation supersession

The operator-authenticated `POST /internal/setup-invitations/retire` recognizes
only the original uncoded setup invitation. Its test must be expired, never
approved and never called. The exact session/pairing identity, historical message
payload, stable origin, provider `attempted` receipt fingerprint/GUID, retained
cursor and operator evidence digest must match. Retirement refuses other pending,
running or uncertain external operations and unresolved control, except an
independently validated obsolete onboarding notice. It does not contact providers.

The operation inserts an audit without modifying the original test, effect,
receipt, cursor or provider state. Delivery stays **unknown** and the original
origin must never be resent. The native preflight and session doctor exempt only
the unchanged audited effect; malformed or mutated evidence restores blocking.
Both retain total unknown counts and separately report
`retiredSetupInvitationCount`. Session heartbeat, control epoch and cooperative
state changes do not alter the immutable session identity proof.

After explicit user authorization, `POST /api/setup/test/retry` with
`{previousTestId}` may create one new invitation in the same active, freshly
heartbeating live session. It requires the exact current retired test, fresh
readiness and no other uncertain work. It does not re-register the agent, revive
stopped sessions, change the old record or place a call. Ordinary `invite` never
replaces a test. The new record preserves `previousTestId`; status chooses the
newest attempt deterministically. A duplicate retry is rejected rather than
creating another attempt; clients reconcile through GET status after uncertainty.

Historical coded setup invitations include an independent eight-character
approval code and require the exact verified DM `YES <code>` (case-insensitive).
An old bare `YES`, wrong code, reused event, unrelated sender/line/conversation or
reply before acknowledgement of the new invitation cannot approve it. Bare YES
remains compatible only with existing legacy uncoded tests. Exact NO/CANCEL stops
the current test; additional text is not a command. An approved test still needs
explicit agent yielding before a single call and the existing physical acceptance
chain before verification. Coded invitations are outside this narrow legacy
retirement mechanism.

### First termination evidence

New cleanup intents retain `call-termination:<request>` before the existing end
operation: a fixed source, time, existing request/call/session/effect identifiers,
request/session state, control epoch, last heartbeat time and bounded heartbeat
age. Sources distinguish media failure callbacks, connector expiry, setup
cancel/expiry, completion, pairing revocation, request expiry, terminal allocation,
worker termination, standby, integration-error cleanup and failed media health.
The first record survives later callbacks. Existing end receipts or retained
cleanup state are never backfilled with a later callback's alleged initiating
cause. Diagnostic persistence failure does not block the original cleanup.

The authenticated media failure callback also retains only fixed reason/category,
media timestamp and bounded elapsed milliseconds, with backend receipt time.
The media GET projection includes optional bounded `lifecycleDiagnostics` with
separate first failure and close-request evidence. Old media without these fields
remains readable; arbitrary exception strings, transcripts and unknown fields are
excluded. The first local termination intent is evidence of which code path
requested cleanup, not proof of the upstream physical or network cause.

An integration-tick exception can enter the existing cleanup-only polling path
and queue owned-call termination; this behavior is preserved and now identified
separately from a media failure. The latest historical disconnect lacks these
fields, so its trigger cannot be reconstructed merely from the later generic
media-task error. No retries, timeouts, cursors, receipts or authority gates were
changed by these diagnostics.

## Agent-owned conversation protocol v2

Registration explicitly supplies `protocolVersion:2` and bounded polling capability.
Omission or `1` retains the legacy controller and response/resume protocol. The
version, native target-surface declarations, project, host, adapter and external
session identity are immutable across reconnect. Registering the same exact live
session rotates its scoped credential; stopped sessions are never revived. There
is no architecture switch for an existing call.

`ConversationService` delivers qualified human text/voice to the original session,
without asking another conversational model to interpret it. One request can carry
many ordered turns. The connector polls `GET
/api/attention/:id/conversation/turns?after=N`; each call returns up to 100 turns,
a sequence cursor and retained reply receipts. Reading does not consume anything.
The server refuses a cursor beyond committed history. Replay/recovery reads can
start at an earlier cursor to reconcile progress changes to previously delivered
turns; a sequence cursor tracks arrival, not a version of execution status.

Scoped POST operations under that conversation path are:

- `ack` with `turnId`: records delivery in sequence order, without completing a
  turn, ending the call, or releasing the screen.
- `progress` with `turnId` and `state`: reports `executing`, `pending_approval`,
  `completed`, `canceled` or `uncertain`. Earlier nonterminal turns prevent starting
  or completing a later turn. An uncertain turn is frozen against replay but does
  not prevent a later explanation; computer input remains separately blocked by
  unresolved execution ownership/receipts. These are the original agent's reports, not proof of
  native tool approval or visible application success.
- `reply` with `turnId`, stable `replyId`, and up to 900 characters of agent-authored
  text: publishes speech to the same qualified connected call.
- `cancel` with `turnId`: cancels queued work. For executing work it records a
  cancellation request and keeps the executing outcome unresolved; native tool
  cancellation is client-dependent.
- `end` with an empty body: explicitly ends the conversation and queues owned-call
  cleanup. Submission is not proof that native hangup finished.

A new utterance during native work queues in order; it does not interrupt a native
approval dialog or tool. Corrections are ordinary ordered turns interpreted by the
original agent. The media path remains half-duplex: speech playback suppresses
transcription; full-duplex interruption is not claimed. Local and authenticated
Stop remain independent of any model. Native approvals are retained in the coding
client and are never granted by a turn acknowledgement or voice transcript.

A turn's delivery and execution states are separate. Acknowledgement leaves viewing
and call lifetime untouched. Active v2 connector heartbeats renew eligible default
connected requests, even while ordinary coding work continues or sharing alone has
stopped. Explicit timeouts, listening Stop, unhealthy/unknown effects, actual hangup,
pairing revocation and lost connector liveness retain conservative cleanup. Synthetic
renewal tests beyond five minutes do not qualify sustained physical connection.

### Speech and content retention

A turn event persists only one bounded text payload plus its ID, sequence, channel,
state and delivery timestamps. Event deduplication records a fingerprint and turn
pointer, never a second transcript copy. The queue admits at most 100 unresolved
turns. Terminal/uncertain turns lose their text immediately; idle pending content
expires within 24 hours when the runtime sweep runs. Closing the request, listening
Stop, revocation and heartbeat cleanup redact remaining turn text. Source inbound
v2 encrypted content is cleared once routed; unknown routing records retain their
original protected payload for reconciliation. Metadata and fingerprints remain
for deduplication. Screens/audio are never stored by this service. This provides
application-level retention, not a claim of forensic erasure from SQLite pages,
backups, provider records or the originating client's own context.

Replies retain a text fingerprint and playback status, not the reply prose. One
turn may have one stable spoken reply identity. Transactional claims commit before
network dispatch. A repeat or uncertain acceptance performs only GET of the exact
media speech receipt; even a missing receipt never authorizes another POST. Polling
refreshes up to four outstanding reply receipts through bounded parallel read-only
lookups, without requiring or retaining original speech text. A
changed ID cannot escape the per-turn reply reservation. Receipt states distinguish
accepted, playing, completed, canceled, failed and unknown; media completion still
does not prove handset audibility. Speech failure does not end the call.

After a backend restart, an executing turn becomes uncertain, and dispatching
speech becomes unknown. Uncertain turns cannot be re-executed or relabeled completed
through the ordinary progress API; reconciliation requires exact external evidence
and operator handling. No generic operator reconciliation endpoint is introduced.
Unknown input remains separately protected by execution ownership and native input
receipts.

### Migration and validation limits

Legacy response, acknowledge, resume and completion operations reject v2 requests.
Legacy sessions, setup tests, durable receipts and old speech remain unchanged.
Setup start supports active v2 sessions after the same explicit one-call consent
and notice-delivery gates. The legacy `verify` evidence chain cannot qualify v2;
it returns an explicit separately-recorded-physical-acceptance requirement. Do not
interpret that boundary as approval to place a test call.

`tests/backend-agent-conversation.test.ts` covers exact-session ordered delivery,
progress, duplicate/corrected events, repeated speech, unknown/reconnect, native
approval boundaries, cancellation, legacy migration, renewable lifetime, and
hangup/heartbeat/revocation/Stop. `tests/backend-native.test.ts` includes lost speech
acceptance and GET-only recovery, including an interrupted intent with no recorded
native dispatch. All tests are synthetic and produce no live call or message.

### Independent task c.1 audio-call preparation

`TaskAudioCallCoordinator` is an independent, encrypted one-call receipt ledger;
it does not construct a legacy AgentSession or weaken legacy call guards. Its
immutable plan binds task/session/run/revision, handset voice, pairing/member/device,
line, hashed recipient, media room and both participant identities. Explicit
one-call authorization expires within five minutes and matches the entire plan.
Audio is true; video, screen, presentation and control are false. Handset voice
admits status/end only and cannot finalize coding instructions.

Dispatch is disabled by default. Construction never prepares, dials, activates or
cleans up a call. Each external phase has a durable receipt before dispatch and is
attempted at most once; unknown outcomes keep the global reservation. Current
authority and fresh exclusive idle-line evidence are checked between preparation,
dial and activation. Activation additionally requires exact native connection
evidence. Fresh voice admissions and reauthorization remain blocked while a call
attempt is unresolved, even after the voice itself ended.

Explicit Stop remains available for an owned receipt in standby. Local media
closure and native `cleanup_complete` are separate facts. Delayed preparation,
dial or activation cannot release the reservation: running forward effects block
closure, and late media creation invalidates earlier local closure. Reconciliation
uses GET of the original identities, never a retry of uncertain POST operations.
No missing dial acknowledgement is replaced by a guessed call ID.

Concrete adapters are available but are not a composed production entrypoint:
`NativeTaskAudioCalls` uses the fixed Calls create/events/end paths, no redirects
or retries, and sends `media: {audio: true, video: false}`. The native worker token
is for the incoming worker; `remote_participant_identity` is the distinct outgoing
agent. `HttpTaskAudioMediaPort` talks only to a configured bearer-protected
`http://127.0.0.1:PORT` bridge using `/prepare`, `/activate`, `/status` and `/close`.
Its immutable room is `clawdtime-task-${mediaSessionId}` and every response must
match the room/binding fingerprint and audio-only flags. Local prepare/activate
have 35-second request budgets, close 45 seconds, status 5 seconds. Timeout stays
unknown; it does not trigger a retry. Existing native HTTP defaults remain 15 seconds.

Before a handset test, the coordinating operator still must assemble production
`authorize` and `readiness` ports with fresh exact pairing, recipient and exclusive
native-line ownership evidence, protected Calls/media configuration, an explicit
one-call grant and a working local media process. Synthetic readiness is never
production evidence. Neither these adapters nor the dry preflight claim physical
acceptance. The regression suite uses only fake transports: no call, deployment,
line handoff, video publisher, or desktop control occurs during this preparation.

`NativeTaskAudioReadiness` now supplies the native read-only evidence port. It
uses the existing signed native `/api/v1/whoami` and retained
`/api/v1/events/:sequence` endpoints, plus bounded project-scoped Calls
`/api/v1/lines` inventory. It requires the exact current pairing, a committed
cursor no earlier than the handoff baseline, a fresh (at most five minutes)
operator ownership attestation, an idle exact logical line and a recent confirmed
worker heartbeat. Ownership and cursor are rechecked after the reads. Pending or
unknown legacy effects and retained call/control ownership block admission.

The c.1 readiness adapter requires FaceTime sign-in, accessibility and native call
control readiness, but does not require video/screen publishing or the legacy
media/gateway services. An explicit worker `system_audio_capture: at_call_start`
readiness outcome is accepted as deferred audio evidence, as in the existing
native transport; handset audibility remains a physical acceptance check. Current
task/session/project and exact handset-voice authorization must still be composed
by the coordinating service around this evidence port. This adapter never alters
line ownership, cursors, receipts, or native configuration.

The native evidence reader accepts only the read methods `get`, `all`, `state`
and `effects`, so an inspector can query the hosted SQLite database in place with
`DatabaseSync(..., {readOnly: true})`. `NativeMessageReader` needs no storage and
exposes identity/anchor reads without a writable runtime. Do not copy the legacy
runtime database to satisfy this interface.

Audio admission additionally requires the worker's explicit
`session_health.capabilities.outbound_audio_protocol === 1`. Every required audio
prerequisite (`accessibility`, `facetime_signed_in`, `audio_devices`,
`facetime_selections`, `playback_renderer`, `configuration`, `control_plane_poll`)
must have one passed, fresh automatic check. Snapshot times must be ordered and
checks must fall within the current runtime/snapshot and be younger than 90
seconds. Duplicate check IDs, failed prerequisites or missing capability evidence
block even if a summary flag says audio is ready. Deferred capture alone is never
sufficient; its explicit `at_call_start` check has a null completion timestamp.

Activation admission retains at most 32 encrypted diagnostic entries with fixed
phase/state codes, timestamps and elapsed milliseconds. The phases cover the
initial native connection read, both authority checks, the final exact native
connection refresh and the admission budget. These entries contain no error
messages, raw responses or speech. Sanitized status exposes only those fixed
fields. A failed diagnostic does not claim an external effect or authorize a
retry. Activation is refused before its effect receipt if the exact call ended
during authorization or more than four seconds elapsed after the first confirmed
connection. Cleanup and unknown-effect handling remain independent.

The final activation gate also rechecks grant/plan expiry after the native refresh.
Media status may expose only bounded integer output counters
`audioOutput.preparedSilentFrames` and `audioOutput.speechFrames` (0 through
1,000,000), with required evidence label `sdk_acceptance_not_audibility`. These counts can support a private shutdown summary;
they contain no audio and do not establish that the handset heard speech.

### Independent task presentation ledger (step d, local only)

`TaskPresentationLedger` stores encrypted manifests, grants and bounded effect
receipts without dispatching capture, narration or task execution. A manifest
binds the exact task/session/run/revision, independent verification and prepared
opening. Up to twelve code/preview/verification scenes bind their window, process
launch identity, display, title hash, focus and narration. A separate expiring
local presentation grant authorizes view/capture only; existing task and handset
voice permissions remain unchanged. No native activation, input or call grant is
implied. Artifact hashes are binding metadata, not proof that rendered content
matches the verified result.

Scene selection increments a presentation generation and records its effect
before dispatch. Narration requires the original completed selection receipt and
a fresh frame from its exact scene/window/process/generation, captured after the
transition completed. Geometry must remain the same; current dynamic preview
pixels may have a newer content digest. Captured/rendered frame metadata must be
no more than two seconds old. Host-render evidence does not prove human visibility
or content correctness, and playback completion does not prove audibility.

Stop immediately invalidates forward admission and increments the generation.
A separate single cleanup receipt must confirm capture stopped, narration stopped,
output cleared and children joined. A running original effect prevents releasing
the global capture reservation. Late original results cannot restore a visible
scene after Stop. Restart marks in-flight effects and previously live output
unknown; no effect is replayed. Unknown cleanup is retained and cannot be retried
under a new operation ID. Historical unknown work can remain recorded after
independent joined cleanup establishes that the presentation is stopped.

Task execution remains independent: a spoken revision may create and run its next
scoped coding task. Any run/revision change immediately makes old presentation
admission invalid, and the coordinating presentation service stops the old output.
No mid-run approval bridge or old AgentSession guard is introduced.

`HTTPTaskPresentationHost` uses only a fixed bearer-protected loopback origin.
Its fixed POST endpoints are `/prepare`, `/show`, `/narrate`, `/stop`; GET
`/observe?presentationId=...` reads a current frame without replaying a scene.
Preparation is read-only metadata validation. The local host independently arms
capture and checks authority; the adapter neither starts capture on construction
nor follows redirects or retries uncertain submissions. Only exact prepared
narration is accepted. Responses retain strict identity and evidence schemas.
Tests use synthetic ports only and do not establish real-pixel or handset quality.

### Explicit handset walkthrough export (offline integration)

The historical c.1 audio plan, authorization, media binding and fingerprint remain
unchanged. A separate `handset_walkthrough` plan binds the opening presentation,
manifest digest, local grant provenance, verification, capture host/device and
exact voice/call/paired destination. An additional export grant is required;
`localOnly` presentation consent never becomes handset export consent. The initial
dispatch/activation deadline is at most five minutes, with a separately authorized
call lifetime of at most thirty minutes. Each grant still permits one call.

Both modes use `TaskAudioCallCoordinator`, the same encrypted
`coding-task-audio-call-v1` records, five effect phases and global unresolved-call
fence. Unknown effects are never replayed. `taskHandsetFingerprint` selects the
new schema only for its explicit discriminator and delegates historical plans to
the unchanged c.1 fingerprint. Native Calls receives `video:true` only after the
new plan schema validates. Startup never prepares, dials or activates a call.

`NativeTaskAudioReadiness.checkWalkthrough` additionally joins the exact line's
worker from bounded read-only `/api/v1/workers` pages. Both worker and line-session
capabilities and automatic readiness must agree: video support, outbound audio
and video protocol 1, matching build/device/config/runtime identities, current
heartbeats and fresh passed audio prerequisites plus `video_resources` and
`screen_capture`. Aggregate `video_ready` is insufficient. This proves native
video readiness only; the coordinator separately requires prepared presentation
readiness. The existing c.1 `check` keeps its original audio-only dependencies.

`HttpTaskHandsetMediaPort` delegates smoke requests to the unchanged audio adapter.
The new binding includes the full plan fingerprint, deadlines, export grant and
presentation provenance. Prepared video requires fresh exact source-frame metadata
and `sdk_frame_accepted_not_remote_seen` evidence. Fractional source timestamps
and geometry identities are preserved. Activation must recheck freshness before
the media runtime starts its single dialogue provider. SDK frame acceptance,
`bridge_ready`, and native `remote_video_ready` are distinct observations; none
establish physical handset visibility or audibility. Native video handoff evidence
is retained separately in sanitized call status.

`HTTPTaskWalkthroughPresentationHost` uses fixed loopback routes
`/presentation/prepare`, `/presentation/show`, `/presentation/observe` and
`/stop-sharing`. Preparation validates metadata without capture or room/provider
allocation. Show and observe return an exact rendered frame plus matching SDK
acceptance evidence; `evidenceFor(frame)` returns only the current checked pair.
The adapter refuses narration because the handset has one dialogue owner. Stop
sharing clears only the presentation/capture output and its children; the scoped
cleanup proof does not claim the voice room, call or coding task ended.

New finalized walkthrough instructions require a matching protected connected
call receipt and successful exact native connection observation no older than five
seconds. Failed reads, Stop, expiry, terminal/unknown calls and mismatched identity
refuse new admission. Original duplicate receipts are returned before this check.
Already approved held corrections still release only after their original worker
has a known terminal result and independent verification, including after hangup;
they never create parallel worker execution.

Final acceptance has a distinct encrypted receipt and shares the finalized
utterance use fence with instructions. Only the exact independently passed result
of a connected review call can be accepted: call run/revision/verification and the
saved utterance revision must match the current review. A decision call or an old
review call cannot accept a later result. Acceptance creates no run or deployment;
its original duplicate can still be read after hangup. Root service classification
must use explicit acceptance phrases from saved trusted utterances.

This section describes source implementation and synthetic regression evidence.
It does not authorize a live call, export, line handoff or deployment, and does not
claim handset walkthrough physical acceptance.
