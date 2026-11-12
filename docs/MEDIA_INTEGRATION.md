# Attention media integration

The Python media service is a separately runnable selective migration with no
workspace engine. It retains LiveKit room lifecycle, qualified worker audio,
Deepgram STT/TTS, a stable screen video track, bounded device inputs, speech/action
receipts, gateway WSS, encrypted-ledger export, and terminal cleanup. Default
configuration has no credentials and cannot place or join a live call.

## Identity and lifecycle

`media/device-port.ts` exports `mediaSessionId(requestId)`, returning `ct_` plus the
first 40 hex SHA-256 characters. The same ID is used for local CallSession, room
preparation, callbacks and DevicePort routing. Native provider call IDs are separate.
All APIs below require the fresh media-only bearer key (minimum 32 characters).

1. `POST /sessions {id,meetingId:attentionRequestId,lineId,captions:true,screen:true}`
   creates `clawdtime-<hash>` with at most two participants and a silent publisher.
   `meetingId` is a retained wire field carrying an attention request ID, not a new
   meeting domain. Return: `{id,silentPublisherReady,videoPublisherReady,credentials}`.
2. Credentials contain `{livekit_url,participant_token,remote_participant_identity}`
   for the existing Chert customer-managed call API. Preparation is not an answer.
3. Only after native `bridge_ready`, call `POST /sessions/:id/activate {callId}`.
   `callId` is the local `ct_<hash>` identity; policy and screen leases use it too.
4. Call end, expiration, revocation or failure: `POST /sessions/:id/close {}` and
   request native end separately. Room deletion does not prove native cleanup.
5. GET `/sessions/:id` reconciles media status. Interrupted preparations stay
   interrupted and are never resurrected. Reuse stable IDs; do not create a new
   call because a network response was lost.

## Authenticated backend callbacks

Media uses the configured `BACKEND_URL` and its media-only bearer key:

- `GET /media/:id/policy`: `{state:"listening"|"paused"|"ended",callId,expiresAt}`.
  Expiry is ISO 8601. Listening requires an active exact request, paired member,
  qualified private call, consent and no revocation. Screen/control require their
  own independent permission and coordinated agent state.
- Optional `screenSelection` contains exactly `{leaseId,deviceId,alias,memberId,
callId,displayId,mode,expiresAt}`. Display is a numeric macOS uint32. Mode is view
  or control. All identity fields except alias match `[A-Za-z0-9_-]{1,160}`. Supply
  rolling 20-second expiry only while authorized; helper max is 30 seconds. Media
  fetches policy every 500 ms and clears stale policy/frame pixels within two seconds.
- `POST /media/:id/segments`: `{id,text,at,source:"remote_participant",callId,
participantIdentity:"worker-"+mediaId}`. Reply `{captured:boolean}`. IDs are stable
  within the non-resurrectable media session; duplicates must have one effect.
  No raw audio persists. The only subscribed audio is the exact room worker;
  wrong tracks/participants fail closed. TTS suspends STT and changes its generation.
- `POST /media/:id/failure {reason,category,at,elapsedMs}`: revoke screen/control
  and begin conservative call cleanup; keep the native call reservation until
  actual cleanup evidence. Metadata is an allowlisted first observed failure,
  never an exception string; legacy `{}` remains compatible.
- `POST /media/:id/screen-stopped {leaseId,reason}`: revoke the exact selection.
  A stopped lease cannot be silently reacquired; require a fresh explicit selection.

A private endpoint does not authenticate a biological speaker or distinguish all
background audio. Qualified callers can speak naturally or send authenticated text;
no wake phrase or command prefix is required. The conversation agent uses the
pending question and asks for clarification when intent is ambiguous. Agent TTS
is excluded from transcription and never grants native approval. Literal “Stop”
or “Stop listening” takes the fail-safe path described below.

Audio uses streaming transcription followed by bounded model turns and synthesized
replies. It is half-duplex: listening pauses during synthesized speech, including
the introduction, and resumes afterward only while policy permits it. This is
not a full-duplex realtime voice session and does not support voice barge-in.
Authenticated text Stop and local Stop remain available while speech plays.

Stable Deepgram `is_final` segments are assembled into one utterance rather than
delivered as separate instructions. Capture requests interim results, VAD events,
400ms endpointing and a 1000ms UtteranceEnd gap. A `speech_final` or valid
UtteranceEnd boundary starts a further 600ms continuation window. Resumed speech
cancels that window; interim words are never submitted. UtteranceEnd uses the
last finalized word timestamp, not trailing audio silence. These are initial
timing defaults requiring later handset qualification, not measured latency claims.

Assembly is transient and resets on capture generation changes, pause, TTS,
disconnect and policy loss. Duplicate audio offsets are suppressed within a
connection. Requests exceeding 30 seconds, 8000 characters or 128 fragments are
discarded at a boundary instead of executing a truncated command. Retracted
interim speech also discards an incomplete prefix. Literal priority Stop and
the recognized pause command bypass assembly immediately on final transcription.
V2 speech is canceled before playback if a new utterance is assembling or being
delivered; its durable canceled receipt cannot replay. This does not enable
barge-in once playback has begun. The caption scene shows “Agent speaking · mic
paused” during TTS; the screen-sharing video retains its existing presentation.

`lifecycleDiagnostics.lastUtterance` exposes only fragment count, assembly/settle
durations, discard flag and timestamps. No text or audio is added to diagnostics.
The deterministic `test_utterances.py` and loopback `test_utterance_delivery.py`
suites cover assembly, continuation, empty/retracted finals, duplicate events,
policy generations, priority Stop and at-most-once playback cancellation.

The implemented call workflow is agent-initiated outbound FaceTime. ClawdTime does
not implement inbound FaceTime handling or an `auto_reject` route. Historical
Apple Teams source-pause behavior does not establish either capability here.

A screen-only setup test needs no click, typing or scroll exercise. A natural
visibility report records handset evidence without ending ordinary conversation.
When the human gives substantive feedback or asks to return to coding, the agent
releases screen control and delivers the original utterance to the waiting coding
session. That session acknowledges, resumes and completes its result; completion
queues the Messages recap. A visibility report alone is not agent continuation or
proof of result delivery. CUA acceptance remains a separate supervised test.

## Control adapter

Ordinary human actions retain one exact call/session/display capture lease. A
pairing with explicit control permission uses a marked continuous control lease;
viewer-only pairings remain view-only. Reuse does not dispatch input. Every input
still requires a fresh frame, its own receipt, the current yielded agent epoch,
and exclusive action ownership. Background viewing and each screen tool may renew
an unexpired lease up to the existing 20-second bound. Expiry, local Stop, stale
heartbeat, revoked permissions, changed epoch, or call termination never renew or
recreate that grant. Uncertain input must be reconciled before another action.

An action consumes its input frame immediately. The video publisher can retain
that frame's pixels only while they remain within the existing two-second freshness
bound, while the next capture arrives. The consumed frame cannot authorize input
or satisfy post-action observation. This avoids a deliberate placeholder flash
without freezing an old screen or resetting the stream for each action.

`MediaDevicePort` implements the shared DevicePort. `createLease()` calls
`POST /sessions/:id/screen/lease {leaseId}`; this refreshes backend policy and rejects
any selection except the exact currently authorized lease. It does not bypass
policy or grant permissions. A subsequent bounded GET waits for a fresh frame.

`GET /sessions/:id/screen/frame` returns current binding, frame metadata, SHA-256
and transient JPEG base64. Observation briefly holds media frame polling so input
can reference the exact frame. `frameImage()` returns a transient data URL for the
lead's bounded vision planner. Never persist its pixels, put them in logs or pass
screen text as authority. Planning latency may stale a frame; reject and reobserve.

`POST /sessions/:id/screen/actions` uses `{id,leaseId,callId,memberId,deviceId,
displayId,frameId,type,...}`. Click uses normalized x/y, scroll uses normalized x/y
and integer nonzero deltaY within ±500, typing uses at most 512 printable UTF-16
units. No shell, clipboard, arbitrary keycodes or autonomous loop is provided.
All IDs and payload fingerprints are durable before dispatch. Unknown means
read-only reconcile with `GET /sessions/:id/screen/actions/:actionId`, not retry.
A submitted receipt means OS events were posted, not successful application change.
Observe afterward and deliver context before the agent resumes.

Authenticated segment callbacks may return a bounded `reply` string (at most
1,000 characters) with `captured:true`. Media rechecks current call policy and
speaks it once using a durable session/segment-derived utterance receipt. The
receipt retains a hash, never reply text. Closed or paused calls, replies crossing
a capture-generation boundary, and replies colliding with existing speech do not
play. Failed, cancelled, completed, or uncertain utterances are never replayed;
spoken output is not proof that the handset rendered or heard it.

Literal voice `Stop`, `Stop sharing`, `Stop control`, and `Stop listening`
(optionally addressed to ClawdTime) have a separate fail-safe lane. Only a fresh
final transcript from the qualified remote audio track and currently authorized
call can use it. Media immediately pauses capture, clears the screen selection,
discards queued ordinary segments, and sends the original segment exactly once
through the same authenticated callback route, with a five-second deadline. It
does not wait behind a conversational turn or invoke a model. An uncertain Stop
acknowledgement is never retried; local capture remains stopped. Other utterances
remain serialized. TTS is still half-duplex, so this does not promise voice
barge-in while ClawdTime is speaking; local Stop and authenticated text Stop
remain available independently.

`POST /sessions/:id/screen/stop {leaseId}` tombstones the selection, cancels polling,
awaits confirmed helper release and only then returns `released:true`. Uncertain
release stays unconfirmed until the longest sent expiry and prevents replacement.
Policy must stop renewing the released lease; a later explicit action needs a new
lease. The coordinator must block agent resume until its release/epoch handshake.

## Read-only readiness (follow-up)

`GET /health` includes `service:"clawdtime-media"` so a backend preflight can reject
an accidental Apple Teams media origin even though its older API shape is similar.
Authenticated `GET /devices/:deviceId/readiness/:memberId/:displayId` traverses
only registered gateway origins and authenticated helper metadata. It returns
`deviceId`, the exact requested `memberId`/string `displayId`, `viewAllowed`,
`controlAllowed`, `displayAttached`, `armed`, `available`, `screenPermission`,
`controlPermission`, `activeLease` and attached display IDs/dimensions. No lease,
permission prompt, capture or input occurs. The helper's new `/v1/permissions`
route supplies loaded display ACL metadata to the trusted gateway; only scoped
booleans leave the gateway. A device-only readiness route is diagnostic and cannot
establish member/display authorization. The API requires the media key; the gateway
key cannot access it. The corresponding gateway route uses the gateway-only key.

An independent helper bootstrap can deliberately return false ACL booleans before
verified messaging pairing. Do not treat existing macOS grants or local Enable as
an authorization substitute. Cache readiness only briefly and recheck actual call,
lease, frame and pairing authority at dispatch.

## Retained screen diagnostics

Authenticated `GET /sessions/:id` includes `screenDiagnostics`, one bounded SQLite
record per screen session, retained after close and process restart. It records
fixed lifecycle phases, notice start/completion, first selection/lease/frame
request times, frame counts and capture timestamps, gateway request duration/status
and fixed error categories, and whether desktop pixels reached the LiveKit video
source. It contains no screenshots, audio, screen text, request bodies, URLs,
exception messages, or credentials. `videoFramesEmitted` includes startup/status
video; only `screenVideoObserved` establishes desktop frames entered the publisher.
Neither proves handset display. `lastGatewayFailure` survives later cleanup;
gateway logs additionally distinguish the original helper HTTP refusal from its
normalized relay status. No automatic retry follows a capture failure. Terminal
release and stop notification run once in a tracked cleanup task, protected from
capture-loop cancellation during policy refresh. Unconfirmed release still blocks
replacement through the longest requested expiry.

The privacy notice still completes before activation and policy-driven capture.
Diagnostics do not grant capture authority. Old calls without this instrumentation
cannot be reconstructed from cleared frame fields. A new physical diagnostic call
requires separate approval; protocol tests are not physical acceptance.

`media/.venv/bin/python -m unittest discover -s media -p 'test_screen_wire.py'`
exercises real local HTTP and certificate-verified outbound WSS, the actual gateway
and media routes, and actual LiveKit VideoFrame FFI. Only OS capture and room
network publication are fixtures. Tests cover a valid frame, helper refusal,
cold capture timeout, no automatic reacquisition, and diagnostics after close.

### Relay timeout correlation

A frame response deadline proves the relay response did not arrive in time; it
cannot by itself distinguish helper capture, local relay scheduling, WSS transit,
or media scheduling. The latest control-enabled pilot received 18 frames before
that deadline and recorded no input. Its old logs lacked enough hop metadata to
identify the trigger. No timeout or freshness limit was relaxed for this diagnosis.

Future media timeout/disconnect diagnostics retain the generated relay request ID,
send-versus-response phase, UTC start time, bounded send duration and socket state.
The gateway retains its last 128 lease/frame/action hop events in a separate
`relay_diagnostics` table: receipt, local forwarding, helper completion/failure,
and response readiness/submission. It records only the opaque relay request ID,
fixed phase/error categories, timestamps, duration and HTTP status. Idle readiness
polls are excluded so they cannot evict a failed call's history before inspection.
No lease/member/frame IDs, URLs, payloads, screenshots or audio enter this table.
A sent WSS response is not evidence media received it; correlation is required.

Diagnostic writes leave receipt transactions alone and roll back only their own
failed transaction. A healthy request commits diagnostics twice; intermediate
stages are buffered and flushed at completion or failure. A process crash can
therefore retain only receipt of an unfinished request. Missing later stages are
unknown, not proof the helper was never invoked. Reconnect logs now include UTC
time while retaining their existing rate limit and content redaction.

Regression tests inject a late response across real HTTP and certificate-verified
WSS, correlate the media timeout to successful helper and late response-submission
stages, and verify one frame request, terminal cleanup, no input and no replay.
These are synthetic transport checks, not a diagnosis of the historical network
trigger or physical handset acceptance. Gateway source requires a lead-controlled
restart; the companion binary and its permission identity remain unchanged.

### Call termination diagnostics and transcription cleanup

Authenticated session status also returns `lifecycleDiagnostics` when a lifecycle
boundary has been recorded. Its `firstFailure` contains a fixed reason, task/event
category, UTC timestamp and bounded monotonic elapsed milliseconds. `closeRequested`
separately records the first close request and its fixed origin. Both survive media
process restart in a separate SQLite table. The callback route binds these records
to the existing session identity; no transcript, screen, audio, arbitrary exception
string, participant address or credential is included.

Direct room/worker disconnect handlers latch the first failure before scheduling
asynchronous cleanup. Managed tasks identify audio publication, segment delivery,
policy watching and capture separately. Later failures cannot replace the first
record. Normal backend/policy/shutdown close is recorded separately, and teardown
callbacks cannot invent a first failure. Diagnostic write errors cannot prevent
existing fail-closed cleanup or commit an unrelated receipt transaction. A timestamp
is an observed boundary, not proof of the underlying provider/network root cause.

An offline regression reproduced a transcription shutdown race: a deliberate
half-duplex pause closes the upstream socket before cancelling its in-flight audio
sender. The sender can fail during that close, and previously the obsolete capture
generation terminated the whole call. Errors from an explicitly superseded generation
now finish its cleanup without reporting a new fatal provider failure. Fresh listening
still requires current policy; there is no automatic retry of a current-generation
failure, relaxed timeout, input replay or changed screen authority. Three repeated
pause/resume cycles and a genuine current-generation failure are separately tested.
This defect is proven offline; it is not established as the cause of the historical
Astra disconnect. Sustained handset acceptance still requires a new supervised call.

### Ordinary speech delivery stays local to the turn

The delivery worker holds at most one waiting ordinary utterance behind the current
turn. Overflow is dropped with bounded metadata rather than terminating capture.
Before dispatch, it rejects malformed, older-than-ten-second, obsolete-generation
or locally unauthorized queued speech. Original timestamps and segment identities
are never changed. Screen freshness and input authority remain independently enforced.

Each admitted segment makes exactly one HTTP POST. Explicit stale-speech refusal,
other HTTP refusals, timeout, transport loss and malformed responses no longer escape
as a fatal media task error. A rejected or unconfirmed conversational turn leaves the
call and screen lifecycle intact. An uncertain acknowledgement discards already queued
follow-ups; it never replays the command. Native input receipts, backend deduplication,
busy-turn isolation and unknown-outcome checks still govern any later fresh request.

One bounded recovery notice can ask the human to repeat a definitely undispatched
request. An uncertain callback instead says to check the screen before asking again;
it does not claim no input occurred. Notices use the existing speech receipt and
policy recheck, are suppressed after Stop or lost authority, and never retry. A failed
notice or caption update cannot turn an accepted command into another dispatch.

`lifecycleDiagnostics.lastSegmentFailure` retains only a fixed reason, UTC and
monotonic timing, bounded utterance age and optional HTTP status. It contains no
utterance, body, URL, exception string or input contents. Stop remains a separate
priority lane and clears waiting speech even when an ordinary HTTP turn is blocked.
Actual room/STT loss, revocation and hangup retain their existing fail-closed behavior.

The activation notice is now a single direct privacy/Stop sentence. Listening still
pauses during synthesized speech; this does not claim full duplex or instant model
responses. Real loopback HTTP regressions cover a 27-second prior turn, expired queued
speech, subsequent fresh speech, permanent refusal without retries, uncertain late
completion without duplicate dispatch, bounded queues and priority Stop. These tests
are not handset acceptance.

### Active-call duration

Media no longer ends a healthy active call merely because 55 minutes have elapsed
since preparation. The backend's current call policy remains authoritative; an
ended policy closes media, and expired or unavailable policy stops capture, speech
and screen authorization under the existing short freshness bounds. Local Stop,
worker/room disconnection, revocation, receipt preservation and native cleanup remain
unchanged. A preparation that never activates still fails after 120 seconds.

Backend request deadlines are not part of the media preparation body. A renewable
backend deadline can therefore keep an already connected, authorized call open
without issuing new room credentials or extending helper grants beyond their
existing limits. Explicitly fixed backend deadlines still close through ended policy.

The existing LiveKit join tokens retain their 60-minute TTL. According to
[LiveKit's token lifecycle documentation](https://docs.livekit.io/frontends/reference/tokens-grants/),
expiry governs admission rather than forcing active participants off the call, and
connected SDK clients receive refreshed tokens. No token or provider configuration
was changed. This does not establish unlimited FaceTime/provider duration or physical
long-call acceptance; only the application's arbitrary active-call cutoff was removed.

## Agent-owned protocol 2

The backend keeps call/conversation policy active independently of screen selection.
A missing selection stops sharing without ending conversation. `muted:true` stops
transcription and speech playback while keeping the screen stream active. The
existing half-duplex TTS/STT rule remains; this does not establish barge-in.
A version-2 priority Stop retires the screen selection immediately. Only after
backend acknowledgement may conversation listening continue; the stopped lease is
never reacquired. Legacy pause-latch behavior is unchanged.

Screen selections carry protocol version, exact coding session, executor epoch,
local policy revision and executor. A higher epoch can renew the same helper lease
from view/native to control/ClawdTime or back without replacing the video track.
Old-frame input authority is discarded; still-fresh pixels may bridge only until
the next capture. A stale policy cannot restore an old executor. Lease creation
acknowledges the helper-applied epoch before the backend grants input. Each action
is checked against that session/epoch/revision at media, gateway and helper.

`POST /devices/:device/panel` transports bounded transient call/executor telemetry
to the fixed registered helper. Readiness returns local policy revision and pending
call controls to the backend. These are separate from capture authorization and
cannot mutate local preferences. Full wire and local restriction behavior is in
[the companion README](../mac/README.md#agent-owned-conversation-and-control-panel-protocol-2).
