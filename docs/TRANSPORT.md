# Transport and durable backend

## Local screen camera negotiation — Argos review slice

The optional camera uses the existing authenticated v2 attention session and its
viewing lease. New registrations must supply both `capabilities.screenCameraVersion:1`
and `screenCamera:{version:1,surface:{kind,id,displayId,ownerPid?}}`; window selections
include the owning process identity. The surface display must match the paired
display. Selection and capability are immutable for that exact session: reconnect
cannot opt in an old run or switch it to another window. Legacy registrations omit
both and retain their behavior. Read-only document and audio qualification sessions
cannot acquire this capability. Registration itself creates no call, capture or
input authority.

Camera rendering and transient annotations live with the media screen controller,
where pristine captured pixels already reside. The backend forwards bounded commands
only through a current authorized viewing/control lease; it does not persist screen
pixels or annotation prose in a new presentation database. Production capability
admission is separately default-off. Camera acknowledgements are not handset-display
receipts, and a mapped input still requires the existing exclusive executor and
fresh observation/action receipt path. See [Argos review](IMPLEMENTATION_ARGOS_REVIEW.md)
for local checks and the physical acceptance steps that remain pending.

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

### iMessage-first protocol v2

New clients explicitly register immutable
`interaction: {version: 1, commandChannel: "imessage_first", messageUpdates: true}`.
Omitted interaction retains historical delivery behavior; reconnect cannot silently
change an existing session's policy. Setting `messageUpdates: false` suppresses
routine notices but retains text commands and explicit agent replies.

Authenticated text and qualified final voice input share one ordered inbox. Replayed
event IDs return the same turn; identical text under two different message IDs stays
two separate instructions. Opted-in text turns enqueue recipient-bound accepted,
acknowledged, pending-approval and terminal notices through the existing effects
dispatcher. Newer status coalesces only unsent lower-priority notices for that turn.
A provider-acknowledged message is not handset delivery or proof of task success.

`conversation_reply` defaults to text for text input and speech for voice input in
these sessions; an explicit negotiated `channel` can override it. Text replies have
`channel: text`, a durable `effectId` and `delivery` of `queued`,
`transport_acknowledged`, `unconfirmed` or `not_sent`. They are reconciled against
message effects, never speech receipts. One reply identity per turn remains required.
New input invalidates a queued stale text reply before dispatch. Already dispatched
sends retain their actual/unknown outcome and are never recalled or blindly repeated.

Message dispatch rechecks exact request/session/turn/pairing, freshness, expiry,
policy and current reply cursor. Pending text expires after ten minutes; terminal
or unknown effects retain identifiers/fingerprints but redact the new message body.
Scope changes, Stop and revocation suppress pending sends. Existing historical
message effects retain their previous recovery semantics.

An already-running agent can discover text requests with `conversation_inbox`.
The authenticated paired person can send `/sessions` and `/use SESSION_ID` to select
an available exact session. Selection lasts ten minutes and does not wake a desktop
chat. If exactly one opted-in live session is available, ordinary text can bind to
it automatically; ambiguous, stale or unavailable sessions produce an explanation.
Event-to-request binding is durable, so a duplicate message cannot move to a newly
selected agent. A text-only request expires after five minutes and creates no call,
capture or control lease. Shared-screen input remains call-bound. Arbitrary idle
host resumption and attachment sending are not supplied by this routing feature.

`executionRevision` reports current and acknowledged inbox cursors. New opted-in
input requires the current cursor and all delivered turns acknowledged; this is
checked together with the separate execution hold and existing control authority.
This cannot revoke a native tool the host has already dispatched. Spoken replies
for the negotiated voice capability carry their validated expected revision to
media so an obsolete queued response can be refused there as well.

The conversation timeline includes `message_queued` and `message_acknowledged` in
the same bounded process-clock scope. Speech diagnostics accept playback-generation,
queue-depth and first/last audio publication measurements. Publication is server
evidence, not a handset timestamp. All timings remain synthetic/unclassified until
the physical qualification in `VOICE_INTERACTION_PLAN.md` is performed.

### Existing effect guarantees

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

## Explicit standard text compatibility

`NativeTransportConfig.textTransport` accepts `strict_receipts` (the default when
omitted) or the explicitly selected `standard_once`. The normalized mode is part
of the binding fingerprint; unknown values fail configuration validation. A failed
receipt probe never switches modes automatically. Existing line assignments,
databases, pairings, event boundaries and unknown outcomes remain unchanged.

Strict mode requires the signed, sender-bound GET receipt lookup to return HTTP 404
with exactly `{found:false,origin:<requested unused origin>}`. A generic 404 does
not qualify. The `native_text_transport` readiness check in `standard_once` instead
requires the explicitly configured mode and healthy exact native identity. Its
message states that send capability is untested and durable operation lookup is
unavailable; this is not physical message acceptance.

Standard mode sends one authenticated native `POST /send` containing the exact
paired `to`, `message`, stable effect-derived `idempotency_key`, and
`native_sms_disabled:true`. Fresh `/api/v1/whoami` evidence binds the configured
provider line, E.164 sender and instance before dispatch; the request is restricted
to the exact paired direct conversation. It does not use the public queued-send
endpoint, alternate routes, or an automatic fallback after an error.

Only HTTP 200 with `success:true`, a UUID `guid`, `delivery.isSent:true`, and
`delivery.error:0` qualifies as provider-reported acknowledgement. Queued,
duplicate, suppressed, contradictory identity, error, missing-GUID, malformed JSON
and timeout responses cannot supply that acknowledgement. A GUID is not proof of
handset delivery; no delivered state is inferred from this compatibility path.

The existing dispatcher commits a running intent before the single submission.
An ambiguous outcome remains unknown through repeated draining and restart, with
the original effect identity and cursor retained. ClawdTime never resubmits an
unknown operation or invents a receipt. The provider may manage its own internal
queue and retries; this mode guarantees no automatic ClawdTime resubmission, not
provider-wide exactly-once delivery. Text-only setup does not authorize a FaceTime
call. All compatibility validation is synthetic until a separately authorized
message is observed by the intended person.

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

## Conversational broker, explicit opt-in — November 13, 2026

New v2 registrations may additionally negotiate immutable
`conversation:{version:1,runnerId,executionSession:"api_managed"}`. This identifies
a separately selected programmatic executor; it does not grant control of an idle
desktop chat. Existing registrations, attention/call IDs, transport receipts and
legacy polling remain unchanged. `/sessions` and `/use` include these new sessions.
Selecting one creates no call or attention request and grants no desktop access.

`JobBroker` (`src/attention/jobs.ts`) uses the existing transactional SQLite store.
Submission commits a job, revision, source event fingerprint and pending dispatch
intent together. Text and voice share one session sequence. Deduplication uses the
actual channel/event identity, so separately sent identical instructions remain
separate events. Caller identity must match the paired member and the exact fresh
execution session. Jobs are bounded to 16 unresolved queued/running items per
session, 128 revisions per job and 10,000 retained job receipts per session; status
exports at most 100 jobs. These are single-process pilot limits.

Instruction text, verification contents and model history remain transient. The
job ledger keeps fixed progress labels, source IDs, result/verification metadata,
opaque unresolved receipt IDs and a fixed summary, not executor prose or files.
A restart makes undispatched queued work `waiting_clarification`; an in-flight
job and its original dispatch become `unknown`. Unknown outcomes block further
execution in that session, including adapter changes. No generic replay or
operator reconciliation shortcut is added. Preserve the database and dispatch IDs.

Dispatch is nonblocking and serializes each session. Available task kinds are checked
at submit, revise and dispatch: a standalone desktop adapter does not imply a
working file/coding host. Only actual runner acceptance
sets the accepted progress label. Success requires independently observed
verification with no unresolved effects. Cancellation stops a queued job before
submission; running cancellation requests cooperative stop and retains
`cancel_requested` until the executor establishes an outcome. A correction to a
running job advances its revision and requests stop; after confirmed quiescence it
requires explicit clarification/confirmation instead of automatically replaying
the changed instruction. Late old-revision success cannot complete the new revision.
A missing or malformed executor result is unknown, not permission to try another host.

Conversation interpretation places a session action hold. Only final interpretation
of the current sequence clears that hold; expiry or reconnect cannot authorize
input. The broker rechecks that hold, session authorization and runner readiness
immediately before invoking the runner, including the microtask after a durable
claim. Completion reporting also waits for finalized intent. Admission and local
Stop inspect all retained jobs; the 100-item status window never hides an older
unknown outcome or active task. Ordinary status/quiet replies leave job execution intact. Local Stop uses
`cancelAll`; stopping speech alone never calls it. Session expiry/revocation also
requests cooperative stop when the dispatch loop next observes it. All desktop
adapters still enforce their separate local-grant, freshness and exclusive-control
checks before every input.

The conversational frontend is the sole result publisher. Broker text replies use
the existing outbox and original provider receipt rules, without a fake attention
or FaceTime call. Dispatch rechecks pairing/member/session liveness, current
conversation sequence, job revision/state, expiry and text fingerprint immediately
before the provider request. A superseded unsent reply is closed without delivery;
a running/unknown reply is never retried. Terminal message text is redacted under
the existing outbox retention behavior. Worker completion does not send its own
message or TTS. Voice output stays with the qualified voice frontend.

Backend timing uses a bounded process-local monotonic `JobTiming` generation for
job acceptance, dispatch, actual executor acceptance, observation/input stages,
verification and completion. These are application-boundary observations, not
handset delivery, audible latency or physical UI acceptance.

Tests `backend-jobs.test.ts` and `backend-job-conversation.test.ts` cover durable
acceptance, event replay/conflict, unavailable hosts, wrong/expired sessions,
independent verification, pending/running cancellation, cross-channel revision,
unknown/restart, stale outbox suppression and a responsive frontend during a slow
synthetic executor. Connector real-spike evidence is documented separately in
CONNECTORS.md. These tests do not qualify physical messaging or speakerphone use.

Migration is additive: enable the frontend only for newly registered opt-in
sessions with explicitly configured runners. Rollback disables new frontend and
runner admission, requests cooperative stop, preserves the SQLite database and
unknown receipts, and leaves old sessions on their original semantics. Do not
remove broker metadata, restore an old cursor, or replay pending work to roll back.

### Scoped remote execution worker

The `remote-codex-app-server` route supports an explicitly started local worker for
an already selected API-managed session. Worker readiness is checked for that
exact session; another connected worker never makes an unrelated session ready.
The authenticated ready/next/event/command/result protocol carries the same job
and dispatch ID as the broker, with transient instruction payloads and durable
claim/result fingerprints. Retrying an identical poll identity returns only its
original still-pending dispatch; a different poll does not steal claimed work.
A result retry must have the same identity and fingerprint. A claimed timeout is
unknown, and no result retry, restart or new poll authorizes re-execution. The
worker's own once-only dispatch ledger remains necessary across local crashes.

`backend-remote-executor.test.ts` exercises session isolation, delivery/result
idempotency, timeout preservation and cancellation before/after worker claim.
These tests use an in-memory transport and do not establish local worker
installation, provider access, live iMessage delivery or physical acceptance.

### Execution-disabled audio qualification

The operator-only audio qualification route admits one fresh, explicitly authorized
30–300 second call, with an immutable matching marker on its session, attention
request and call. Its protocol-v2 session has no conversation, execution, polling,
control or screen authority. Ordinary registration cannot request or reconnect this
identity. A scoped session credential is returned only on first admission, for
heartbeat, status and disconnect; a lost response is reconciled through operator
status/Stop rather than minting another credential or redialing. Reusing the same
idempotency key returns the original request even after completion or restart.

Admission requires an idle pairing, line and device, with no active agent sessions,
setup reservations, calls, media, tasks, grants or unresolved effects. Pending and
unknown work blocks admission. Heartbeats cannot extend the absolute deadline.
Local Stop ends only the qualification session and retains the pairing. Unknown
dial or cleanup outcomes remain unknown and cannot be retried. Domain and API
fences reject task responses, conversation polling/replies, control, execution and
setup invitations. Messages during qualification cannot enqueue instructions or
send an agent notice; the runtime accepts only its exact Stop handling.

Native preparation requires provider/line/worker/media readiness and a fresh exact
qualification binding before and after media preparation. The paired-device gateway
and helper are not used in this mode. Media receives `audioQualification: true`,
`captions: false`, and `screen: false`, and publishes inert video. A Stop during
preparation closes allocated media before any native dial; an unacknowledged media
close preserves unknown cleanup. Status reports `cleanupConfirmed` only when the
call and media cleanup are established, separately from call-end submission.
The GET-only readiness projection and bounded lifecycle counters carry no raw
transcripts, instructions, audio or credentials.

`backend-audio-qualification.test.ts` and the qualification cases in
`backend-native.test.ts` exercise admission, API/domain fences, immutable expiry,
replay/restart, conflicts, malformed markers, Stop races and uncertain cleanup with
synthetic providers. These tests neither place a call nor establish handset audio,
echo suppression, interruption quality or physical acceptance.

### Read-only documents and selected-file attachment sending

Document sessions negotiate `documentAccess:{version:1,readOnly:true,expiresAt}`
with protocol 2 and the explicit `remote-documents` managed host. Access lasts at
most one hour, cannot be extended by reconnect/heartbeat, and binds the exact
project root, host, member and session through `document_root_grant`. Discovery,
first-page preview and selected-file transfer are asynchronous document jobs.
Validated structured results must match the submitted operation, candidate, grant
and transfer ID. A model's prose cannot substitute for a verified result.

The native call path may skip the desktop helper/gateway only for that exact live
read-only document grant. It checks the binding again immediately before dialing.
Media preparation carries immutable `documentOnly:true` and `documentSessionId`,
with `screen:false` and captions enabled. It creates a real attention/call; this
mode provides no desktop input authority. Grant revocation during preparation
closes media before dial. An uncertain media close remains unknown.

`AttachmentService` owns a separate `attachment_dispatch` ledger, not the legacy
text outbox. Human approval binds the current verified preview selection, candidate
ID, original name, SHA-256, MIME, size and paired iMessage recipient. Only PDF,
DOCX and modern Pages files within 10 MiB are accepted. The original file bytes
are checked again and held transiently; contents are never stored in the ledger.
The native provider canonicalizes names to ASCII. The sender preserves a normalized
title (`Résumé 2026.pdf` becomes `Resume_2026.pdf`); the selection retains the
original name, and the send receipt reports the actual outbound filename.

The inspected native provider contract uses a single base64 JSON staging POST to
`/api/v1/attachments`, then a metadata GET and a one-attachment POST to
`/api/v1/send`. Its attachment path bypasses the native text outbox. ClawdTime
therefore persists each stage/send claim before the POST, makes one attempt, and
never relies on the provider's accepted `idempotency_key` field as attachment retry
protection. No companion text is bundled with the file. A timeout or lost send
acknowledgment retains unknown; another event, adapter, session restart or selection
cannot silently resend it. A known staging acknowledgment followed by revoked
selection prevents sending and records a pre-send failure. Stop after a send claim
retains unknown even if a late response subsequently supplies evidence.

A validated native response establishes `delivery:provider_accepted`, not handset
delivery. An unknown send can be reconciled with a read-only, bounded event scan
from its original pre-send anchor. Exactly one matching attachment ID, metadata,
recipient, provider line and message GUID is required. Gaps, missing events or
multiple GUIDs leave the outcome unresolved. Reconciliation never changes the
shared Messages cursor or repeats a POST. A staged upload without an acknowledged
attachment ID cannot be reconciled by inventing an ID or uploading again.

Software validation covers authority changes across awaits, exact bytes and
recipient, event replay, upload/send Stop races, unknown restart, bounded shutdown,
long/native-normalized filenames and provider-event reconciliation using synthetic
providers. The local upstream source establishes an API contract, not the deployed
binary's capability or handset receipt. Production capability and real document
receipt need separate authorized evidence. No attachment or call is sent by these
tests.

Migration is additive (`document_root_grant`, `document_selection`, and
`attachment_dispatch` entities). Keep document/attachment admission gated, stop
local document hosts and await `AttachmentService.stop()` before closing storage.
Preserve all metadata, original anchors and unknown outcomes on rollback. Retain
the newer code in standby while any stage/send outcome remains uncertain; older
code cannot enforce these ledgers. Never restore a database or discard a dispatch
claim to make a demo retry possible.

### Prepared native activation reservations — November 17, 2026

New original-chat sessions may separately negotiate `nativeActivationVersion:1`.
This requires protocol v2, the display camera and live-presentation capabilities,
`nativeControl:"desktop"` and `sharedSurface:true`; reconnect cannot upgrade an
existing session. This negotiation alone never enables production admission or
arms the helper. Finder/TextEdit activation remains separate from fallback input.

The backend retains `native-activation` records in its existing FULL-synchronous
SQLite entities store. Preparation binds the operation fingerprint, original
expiry, exact agent/request/media/pairing/member/device/display, lease, native
ownership epoch, policy, cursor and scene generation. The prepared process/window
observation is write-once. Dispatch commits its once-only claim and at-most-two-
second deadline before invoking the helper. Neither a duplicate ID nor a retry
extends the original authority. Other operations cannot replace a reserved device,
including through another display, pairing, request or freshly registered session.
Exact session reconnect remains possible for read-only reconciliation.

Undispatched preparation can expire or be canceled safely. Dispatching/submitted
records become uncertain after backend restart and never expire into permission to
retry. Terminal results require matching operation/fingerprint evidence; `returned`
proves the actor returned without proving the UI outcome. A validated `verified`
result additionally carries the exact independently observed window. Lost receipt
persistence leaves the original reservation in place. Reconciliation reads the
same helper receipt and never submits the native effect again.

Admission, audio qualification and doctor inspect these device-wide reservations.
Preserve the ledger, original deadlines and unknown results during deployment and
rollback. Older binaries do not enforce this new ledger: keep a compatible binary
in standby whenever unresolved native work remains; do not restore an old database
or delete records to make a preflight pass.

`backend-native-activation-storage.test.ts` and `backend-native-activation.test.ts`
exercise synthetic production protocols, restart/persistence failure, exact
receipt binding, duplicate/conflicting identities, multi-client/device fences,
wrong authority, Stop at awaited boundaries, late replies, target replacement and
authenticated routes. They produce no real call or native input and do not prove
physical acceptance, handset delivery or production frame timing.
