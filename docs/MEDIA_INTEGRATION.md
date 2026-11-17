# Attention media integration

The current source adds [asynchronous GPT-Live conversation](#asynchronous-conversation-frontend-november-13-source)
and [text-session control](#text-session-control-route), both default-off and awaiting
provider/physical qualification. The existing paths below remain compatibility
behavior for sessions that did not negotiate the new capability.

The Python media service is a separately runnable selective migration with no
workspace engine. It retains LiveKit room lifecycle, qualified worker audio,
Deepgram STT/TTS, a stable screen video track, bounded device inputs, speech/action
receipts, gateway WSS, encrypted-ledger export, and terminal cleanup. Default
configuration has no credentials and cannot place or join a live call.

## Experimental two-way voice — source implementation

The new v2 path can keep qualified input/STT open during TTS and interrupt playback.
It is **off by default and not physically qualified**. Admission requires all of:

- media `MEDIA_TWO_WAY_VOICE_ENABLED=true`;
- an original-agent session negotiating `voiceInteractionVersion:1`;
- backend policy `voiceInteractionVersion:1`, `voiceMode:"two_way"` and
  `remoteAudioIsolated:true`, with the existing fresh call identity/consent checks.

The backend supplies these only under its own explicit feature/isolation configuration.
`remoteAudioIsolated` is an operator qualification assertion, not something these
tests establish. Trace the actual FaceTime worker/handset audio path and qualify
speakerphone and headset echo before enabling it. There is no fabricated echo
canceller or automatic acoustic-isolation claim. Missing gates retain half duplex.

Capture and playback have independent generations. TTS does not reset an admitted
duplex capture stream. Outgoing chunks and playout barriers carry playback generation;
cancellation invalidates late chunks, drains application/SDK queues and cancels TTS.
Already published audio cannot be recalled. Closed/muted/revoked/stale policy and
foreign-track behavior remain fail-closed. Source/timing tests use synthetic audio.

A constant-memory detector requires 120 ms sustained normalized RMS >=0.012,
with 200 ms quiet to rearm. This is a conservative **activity candidate**, not proof
of speech or command intent. Candidate activity cancels audio locally without a
model/poll round trip. Fresh sustained activity can refresh the action hold once
per second; quiet does not. At most one callback is in flight, and failed callbacks
are not retried. Final recognized utterances still use normal ordered delivery.

`POST /media/:id/interrupt` carries `{callId,participantIdentity,interruptionId,
playbackGeneration,at}`. The timestamp is fixed at observation. Backend admission
enforces exact call/participant, bounded age and a two-second hold; duplicate IDs
cannot extend it. No transcript, input command or outcome assertion is carried.
Holding future actions is distinct from canceling a native action already running.

Negotiated speech requests include `expectedRevision` from the original turn cursor.
Media compares it against fresh `conversationRevision` before accepting/playing;
the fingerprint binds text and revision. Policy revision changes also cancel playing
stale replies. Existing sessions without the capability keep the old request shape.
Interrupted/unknown receipts are preserved and never replayed as new speech.

Phone captions show “Speaking · still listening” only when media admitted duplex;
default mode continues to show “Agent speaking · mic paused.” The Mac panel uses
the compatible neutral “Agent speaking” label because its old enum does not carry
the independently verified microphone mode.

New bounded diagnostic events include `speech_onset`, `interruption_detected`,
`playback_cleared`, callback acknowledgment/uncertainty, `tts_requested`,
`tts_first_byte`, `audio_first_published` and `audio_last_published`. Reply correlations
and playback generation prevent mixed measurements. Publication means submission
to the SDK, not handset audibility. `event_loop_lag` is the maximum scheduling delay
of ten 100 ms heartbeat probes, emitted about once per second; provider/capture awaits
are not mislabeled as event-loop stalls. Queue depth is bounded numeric metadata.
No raw audio, transcript, file paths or provider exception text enters telemetry.

The detailed pilot/rollout gates are in [VOICE_INTERACTION_PLAN.md](VOICE_INTERACTION_PLAN.md).
The half-duplex descriptions below describe the compatibility/default path and
historical releases; only the explicitly admitted path above changes that behavior.

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

- `GET /media/:id/policy`: `{state:"listening"|"paused"|"ended",callId,expiresAt,captionsEnabled}`.
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
  wrong tracks/participants fail closed. Legacy/unnegotiated TTS suspends STT and
  changes its capture generation; explicitly qualified two-way v2 preserves it.
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

Interim audio durations are provisional: a final result can cover a shorter
window. Assembly tracks provisional word/region metadata rather than requiring
that the final duration reach the largest interim duration. A newer provisional
region cannot be cleared by an older final. Noise-only SpeechStarted events have
a separate 1.5-second grace period; they do not start a request's 30-second budget
or cause an empty final to discard already finalized words. Known retracted
interim words still invalidate the request rather than allowing a partial action.

Assembly is transient and resets on capture generation changes, pause, TTS,
disconnect and policy loss. Duplicate audio offsets are suppressed within a
connection. Requests exceeding 30 seconds, 8000 characters or 128 fragments are
discarded at a boundary instead of executing a truncated command. Retracted
interim speech also discards an incomplete prefix. Literal priority Stop and
the recognized pause command bypass assembly immediately on final transcription.
V2 speech is canceled before playback if a new utterance is assembling or being
delivered; its durable canceled receipt cannot replay. This does not enable
barge-in once playback has begun. VAD alone defers a reply for at most 1.5 seconds
instead of permanently cancelling it. Before playback, policy, generation and
newly delivered turn count are rechecked; real continuation still cancels stale
output without replaying its receipt. The caption scene shows “Agent speaking · mic
paused” during TTS, with agent subtitles composited over the shared-screen video.

`lifecycleDiagnostics.lastUtterance` exposes only fragment count, assembly/settle
durations, discard flag and timestamps. No text or audio is added to diagnostics.
`lifecycleDiagnostics.speech` adds versioned stage counters, current assembly
phase and a bounded 64-event timeline. It records audio frame/byte/nonzero counts,
frames sent, provider event categories and numeric offsets, utterance emission or
discard, queue acceptance/rejection, callback outcomes and playback arbitration.
Generation, segment sequence, relative times, character counts and fixed reasons
locate a stall without retaining transcripts, audio, provider bodies or exception
strings. Nonzero audio counts do not prove intelligible speech. Normal persistence
and `speech_pipeline` structured logs are throttled to once per two seconds;
transitions such as capture close and playback outcomes flush immediately. Logs
include the new bounded event batch plus cumulative counters. The latest snapshot
survives close/restart in the existing lifecycle diagnostics table; no new database
table is needed. Backend status validation strips unknown fields and rejects
unknown categories, oversized histories and unbounded values. Missing final or
endpoint events remain fail-closed and visible as waiting/quarantined assembly;
no timeout executes a partial instruction.

The deterministic `test_utterances.py` and loopback `test_utterance_delivery.py`
suites cover assembly, continuation, empty/retracted finals, duplicate events,
policy generations, priority Stop and at-most-once playback cancellation.
`test_speech_pipeline.py` additionally exercises synthetic audio through a real
local WebSocket, capture tasks, assembly and a real local HTTP callback across
five consecutive requests, malformed provider events and capture reset. It checks
redacted diagnostics after service restart. `test_speech_diagnostics.py` covers
log bounds, throttling, redaction and persistence failure; the backend schema tests
cover the matching status contract. These tests never contact a transcription
provider, open a microphone or place a call.

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

## In-call subtitles and delivery feedback

The backend enables captions under the same active-call policy as listening.
The shared-screen publisher composites a portrait-safe subtitle panel over the
existing desktop video; screen visibility, permission indicators and local Stop
remain intact. The panel also works while the desktop is connecting or stopped.

Qualified provisional transcription appears immediately as “You · hearing
(partial)”; it is display-only and never becomes an executable turn. Final
assembly shows “You · sending”, then “You · received” only after the backend
returns `captured:true`. This confirms backend receipt, not execution or completion
by the coding agent. Unknown delivery and incomplete capture have explicit states.
The most recent 500 transcript characters remain visible, with the latest lines
shown in the compact panel. Older callbacks cannot overwrite newer speech.

The exact bounded TTS text appears as agent subtitles during playback. Long
messages page every five seconds inside the phone-safe region; this is readable
pagination, not word-aligned karaoke. The last agent message remains readable
while the panel says “Listening · your turn”, until new speech arrives. During TTS
it explicitly says “Agent speaking · mic paused”. Private text clears on mute,
revocation, wrong-call policy, expiry, disconnect or close, and failed TTS clears
its subtitle. Subtitle text is memory-only and absent from logs and diagnostics.

For authorized, unmuted v2 recording calls, activation says “Hey, this is your
agent.” once. This fixed connection notice supplies the audible output required
by the worker's ten-second startup check; a silent v2 setup call failed with
`bridge_remote_audio_timeout` in the November 13 physical test. It creates no
human turn or agent reply receipt. Fresh exact-call policy is required, policy
polling remains active during the notice, and mute, Stop, revocation and close
can cancel it. The notice has a six-second bound and is never replayed after
uncertainty. Actual replies then omit the repeated introduction. Call-only and
muted calls remain silent; those cases are not qualified against this worker's
audio requirement. Half-duplex callers should wait for the brief greeting to
finish before speaking. Duplex qualification gates remain unchanged.
The bounded attention-question dispatch remains once-only, without the
“Your agent asks” wrapper; legacy v1 retains its activation greeting.

`test_caption_experience.py` covers live provisional/final transitions, confirmed
and uncertain delivery, subtitle/voice agreement, greeting deduplication, policy
refresh and revocation, stale callbacks, bounds, pagination, composite video and
non-persistence. Local synthetic frame inspection checks portrait cropping and
screen visibility. Neither is a physical FaceTime acceptance test.

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

V2 activation uses the policy-gated connection notice described above.
Capture still requires exact-call backend authorization. Diagnostics do not grant
capture authority. Old calls without this instrumentation
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

V2 has no separate spoken screen-sharing announcement. The first actual message
begins “Hey, this is your agent.” Listening still pauses during synthesized speech; this does not claim full duplex or instant model
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

## Improvements presentation and diagnostic capability

New media requests advertise `X-ClawdTime-Presentation: 1`. For v2 only, the
backend returns `presentationBinding` (exact session/member/device/display) and
`presentationSequence` in policy. Old callers receive the original policy shape.
Panel metadata still travels over the existing authenticated device path; it grants
no screen or input authority. Local helper capability controls optional forwarding.

The phone validates the binding, policy freshness, five-second panel expiry,
monotonic sequence and text expiry before showing visual activity. Stable sequence
replay cannot restore cleared text. Backend acceptance, agent acknowledgment,
working, native approval and observed/unverified/unresolved outcomes remain separate.
The same projection supplies the native panel. Current summaries are distinct from
recent history, and a task outcome never ends the call. See
[media checks and preview commands](../media/README.md) and
[local implementation evidence](STATUS.md).

Speech diagnostics add a random 32-hex monotonic process scope and 24-hex opaque
segment/reply correlation. Backend conversation stages use the same correlations
for causal inspection. Process reset/24-hour rollover starts a fresh scope; clocks
across processes are never subtracted into a latency claim.
`npx tsx scripts/inspect-session.ts` defaults to an isolated fixture and accepts only
explicit file input/export, with an allowlisted report rather than a raw response
dump. No production configuration is discovered implicitly.

## Asynchronous conversation frontend (November 13 source)

New sessions may negotiate `conversationVersion:1` and
`conversationFrontend:"gpt_live"`. This is additive to protocol 2; existing sessions
retain their recorded speech behavior. The media gate requires
`MEDIA_GPT_LIVE_ENABLED=true`, the existing two-way/isolated-remote-audio gates,
a direct `OPENAI_API_KEY`, and exactly `livekit-agents==1.8.12` plus
`livekit-plugins-openai==1.8.12`, with `openai==3.50.0`. These pins are in `media/requirements-live.txt`.
The optional container build argument is `ENABLE_GPT_LIVE=true`. Neither flag is
enabled by default. Missing prerequisites reject activation, never silently switch
an active session's speech owner.

The real optional adapter uses LiveKit `AgentSession` with
`openai.realtime.GPTLiveModel(model="gpt-live-1", delegation="client")` and custom
bounded input/output connected to the existing authenticated FaceTime track. It
keeps the same room and existing screen compositor. No video is sent to GPT-Live.
Legacy STT/turn-TTS is bypassed for these calls; the existing once-only bounded
connection greeting finishes before the new speech owner starts. Recorded audio,
transcripts, and SDK session hosting are disabled. No automatic provider reconnect
replays work; a provider close fails the media session conservatively.

`delegation_created` supplies correlation metadata, not executable arguments. The
frontend now aggregates bounded SDK speech fragments in source order. A turn needs
all fragments finalized and at least 1,000 ms of actual quiet PCM (RMS below .003)
after the last text change before submission. This is a local endpoint heuristic,
not a provider commit or proof that the speaker has finished their intended request.
The public AudioInput consumes every frame through this gate, including synthetic
probe input. Non-silent audio cannot advance its quiet window; wall time cannot
release a hold. Late finals join the pending turn; retired source identities cannot
repeat an effect. Oversized/incomplete speech remains held rather than truncated.

Every settled turn goes to authenticated `POST /media/:id/conversation/turn`, even
without model delegation. This lets the backend explicitly adjudicate trailing
chit-chat before releasing a verified completion. General context uses
`delegation_id:null`; provider delegation IDs remain correlated where available.
Up to eight public chat messages (3000 total characters), excluding the current
aggregated source items, accompany the text as untrusted transient context. Neither
model history nor delegation grants permission. Backend intent/approval rules stay
authoritative. Callbacks serialize in spoken order; executor work is asynchronous.
Independent jobs polling reports current verified facts through `append_commentary`.

New audio activity blocks old narration immediately. New transcript changes hold
reports and supersede an in-flight older reply. Quiet, stale, duplicate and unknown
backend responses do not silently release a semantic hold. A valid current backend
interpretation does. Timed-out submissions never retry under replacement IDs.
Workers never send independent TTS. The quiet endpoint adds a one-second software
budget after the last input/text change; provider lag and backend interpretation
can add more. It is not evidence of the two-second audible p95 target.

Speech interruption clears the application/SDK output queue and holds the existing
execution path through the interruption callback; it does not cancel a job. SDK
interruption cannot establish downstream silence: FaceTime worker and handset
buffered audio remain outside this queue. The prior playback-generation timing fix
is retained. The custom output sink now binds in-flight audio and drain completion
to their original playback generation: old frames cannot adopt a newer generation,
and an old drain cannot clear a newer speaking state. First audio publication
remains different from handset audibility.

The pinned SDK's public `openai_client_event_queued` and
`openai_server_event_received` hooks correlate commentary appends with their
`client_event_id` acknowledgments. Bounded `lifecycleDiagnostics.voiceCommentary`
metadata records queued, acknowledged, rejected, unknown, pending and lastAckMs;
no content or IDs are persisted. A missing acknowledgment becomes unknown after
30 seconds or closure and is never automatically retried. An acknowledgment is
context acceptance, not spoken delivery. SDK diagnostics are scrubbed because
disabling recording alone does not prevent SDK error paths from logging transcripts
or provider error content. Provider startup is awaited explicitly; TLS validation
uses certifi, and shutdown releases transient audio/chat references.

### Ordinary voice promotion audit

These hardening changes have a real pinned-SDK loopback proof: provider transcript
delta and `session.delegation.created` → SDK final speech item → authenticated local
HTTP turn submission → queued commentary acknowledgment → authoritative fixture job
state → independently-verified-result commentary acknowledgment. The test also
rejects an unverified completion and duplicate delegation, and now includes a
nondelegated trailing utterance that must get a second backend interpretation
before the verified completion context ACK. It feeds non-silent PCM across the
SDK’s provisional final boundary and verifies fragments remain one request. Its backend/provider are
local fixtures; it is not a production execution or handset acceptance result.

The SDK's `is_final` is a segmentation heuristic, not an OpenAI commit event: it
finalizes after 800 ms of pushed input audio without another transcript fragment,
or a transcript-timestamp gap. Continuous non-silent input still advances that
timer. The new independent PCM-quiet gate covers that concrete failure; delayed
transcripts and real background noise still need workload qualification before
ordinary voice execution is promoted. The SDK similarly resumes interrupted playback at inferred
output silence/gap boundaries; this is not a provider truncation or handset flush
acknowledgment. The execution-disabled acoustic latch remains unchanged.

The November 13 speakerphone record contains one qualitative deliberate cutoff,
no noticeable echo reported, 265 ms notice-request-to-first-publication, 5,191 ms
notice-last-publication-to-model-first-publication, and 0 ms detected-onset-to-local
clear at millisecond resolution. It contains no quantified handset cutoff, source
tap/AEC provenance, repeatability cohort or headphone comparison. Those metadata
cannot establish `remoteAudioIsolated:true`, safe post-interruption resumption or
the target handset latency percentiles. Keep ordinary voice/control/isolation gates
off until the specific route and complete tool/correction/interruption workflow
have passed fresh supervised acceptance.

Official references checked against downloaded and isolated-installed 1.8.12 wheels:
[GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
and [LiveKit GPT-Live](https://docs.livekit.io/agents/models/realtime/gpt-live/).
The earlier optional SDK deployment and authenticated silent-session
qualification used successful media deployment `c197bb86-a198-4f72-906a-7f6ab1d97f83`,
with source manifest SHA-256
`1d658394b7349003083d7d1c1bd99cfd1e94d3c0b0006dd607432076eb5746aa`.
Its qualified runtime is Python 3.12.16, LiveKit Agents/OpenAI plugin 1.8.12,
OpenAI SDK 3.50.0, websockets 15.0.1 and certifi 2026.10.23. At that stage runtime
feature flags remained false; installing dependencies did not enable voice or control.
The scoped OpenAI project service-account credential expires December 13, 2026.

`media/probe_live.py` confirmed authenticated `gpt-live-1` client-delegation
session acceptance locally in 1.3177 seconds and in the deployed cloud runtime in
1.2347 seconds. Both sessions confirmed `session.closed` with `close_requested`;
neither sent audio, executed work or placed a call. The probe uses one attempt,
bounded startup and close waits, verified TLS, no SDK/error-body logging, and
sanitized metadata output. Run details and exact interpretation are in
[media README](../media/README.md).

These results establish credential/model session access, not handset readiness.
The execution-disabled qualification mode below is now deployed as described in
the current release evidence. Physical acceptance remains outstanding. Real continuous
audio, echo isolation, interruption timing and downstream worker/handset flush
acceptance remain **unqualified**. Loopback SDK tests establish adapter
API/runtime compatibility only.

### Execution-disabled acoustic qualification

Current release: source **0.3.1**, manifest SHA-256
`9e50e96d4db5aa9746ca2e7d4679dcbd3eef073fa41628a8a0e151030cfa4768`.
Backend deployment `2dc6293e-81c1-49a2-b97d-21c8249f8b36` and media deployment
`b683019a-6bae-4ac2-be65-ec540cf1d22a` both reached SUCCESS. The lead verified
matching hashes for 74 JavaScript, 18 Python and 10 public files; state and
cursors were preserved. Post-deployment checks found zero active calls, media
sessions, pending effects or unknown outcomes. Only the new qualification flags
are enabled; ordinary voice/control flags remain false and
`remoteAudioIsolated` remains false. Controller preflight reports `ready:true`
and `executionDisabled:true`.

The exact qualification startup configuration was accepted by authenticated
provider checks locally in **1202.0 ms** and in the cloud in **832.4 ms**
(cloud total **2285 ms**). Both confirmed provider closure, with no input audio or
calls. These are session startup measurements, not conversational or handset
latency. Automated validation was **271 passed + 12 skipped** out of 283 media
tests, plus **27 passed** in the qualified SDK environment. The release is ready
for a supervised one-interruption handset test; **no physical acceptance has been
performed**. Use the [supervised qualification runbook](AUDIO_QUALIFICATION.md)
for fresh call authorization, the local Stop controller and acceptance records.

`MEDIA_AUDIO_QUALIFICATION_ENABLED` defaults false, independent of ordinary
duplex/GPT-Live/control flags. New preparation must include
`audioQualification:true,captions:false,screen:false`; an existing session cannot
change mode. A dedicated solid black 640×360 H.264 video track preserves the
FaceTime handshake. There is no CaptionScene, ScreenController, desktop capture,
presentation binding or device lease.

Authenticated policy must retain the exact call binding, protocol version 2,
`voiceMode:"audio_qualification"`, truthful `remoteAudioIsolated:false`,
`captionsEnabled:false` and
`audioQualification:{version:1,executionDisabled:true,expiresAt:<ISO timestamp>}`.
Expiry is fixed at admission and within five minutes. Screen/presentation/
conversation fields, paused/muted state, changed call or expiry, missing authority
and mode upgrades are refused. A monotonic watchdog revokes audio at expiry or
after two seconds without fresh policy, including blocked policy I/O. The foreground
controller's local Stop and heartbeat loss revoke backend policy. The Mac helper
is not armed or involved; its panel Stop is not claimed for this mode. Handset
hangup closes the bound session. Old call approval and reconnect cannot revive it.

The fixed notice “ClawdTime audio test. Execution is disabled.” is serialized once
before provider startup, within the existing six-second notice bound. The separate
`acoustic.py` frontend uses OpenAI SDK 3.50.0 public Live WebSocket events with
client delegation, `store:false`, verified TLS and zero retries. It converts
LiveKit's 48 kHz PCM to/from documented mono PCM16LE 24 kHz provider audio. The
fixed prompt discusses only acoustic testing. It creates no agent chat history,
broker, task poller or tools. Transcript and delegation payloads are discarded.
External `/speak`, legacy transcript submission and per-call device actions are
blocked. Media's callback boundary permits only policy and failure callbacks for
qualification, never conversation, segments or interruption callbacks.

Local speech onset clears application/LiveKit output queues and latches further
model output off until the call ends. This permits **one interruption measurement
per call**, not resumable conversation after interruption. Interruption during the
notice also latches later model output. Zero PCM, elapsed time and instruction
acknowledgments never re-enable playback. Primary Live WebSockets provide no
reliable output-turn-complete or downstream flush acknowledgment. Local PCM and
queue state are only a speaking heuristic, never handset silence evidence. Caller
audio may contain echo; isolation stays false and execution remains disabled.

Protected `GET /audio-qualification/readiness` performs no connection or capture
and returns `{version:1,enabled,directKeyConfigured,sdk,websocketQualified}`. Key
presence is not fresh provider access proof. `lifecycleDiagnostics.audioQualification`
contains only bounded metadata: version, executionDisabled, started, finalized,
outputLatched, elapsedMs, inputFrames, outputChunks, discardedOutputChunks,
discardedDelegations, discardedTranscriptEvents and cutoffs. Existing monotonic
speech diagnostics retain onset, queue-clear and publication timing. No screens,
audio, transcripts or provider error payloads are retained.

Official contracts rechecked: [Live WebSocket formats](https://developers.openai.com/api/docs/guides/voice-websockets#choose-the-audio-format)
and [playback controls](https://developers.openai.com/api/docs/guides/voice-server-controls#control-playback-when-needed).
The pinned SDK/RTC loopback test covers exact startup configuration, bidirectional
synthetic PCM, ignored delegation/transcripts and confirmed cleanup. It uses no
provider credential or handset. The lead ran `media/probe_live.py
--audio-qualification` with protected credentials to validate the identical startup
configuration without input audio or playback, with results above. Neither test proves physical echo,
audibility, interruption latency or upstream queue flushing.

## Text-session control route

`MEDIA_TEXT_CONTROL_ENABLED=true` independently enables the authenticated
`/devices/:device/text-grants` proposal/status routes and `/text-leases` execution
routes. These create no call, room, participant, or FaceTime identity. A proposal
is pending until the person reviews it on the Mac. Protocol-3 leases omit `callId`
and carry exact `authority:{kind:"text_session",grantId,projectId}`, where projectId
is the selected absolute project root. See [device grant documentation](DEVICE.md#text-session-local-control-grants).
The gateway/helper enforce scope, local Enable, policy revision, exclusive lease,
frame freshness, action bounds and receipts. Media persists only lease/action IDs,
bindings/hashes and states; raw frames and typed text stay transient. Unknown
creation/input remains blocked across restart and cannot switch to another adapter.
Release during uncertain creation cannot prove quiescence; it retains unknown even
if an overtaking DELETE was acknowledged. There is no automatic expiry reconciliation
for that media tombstone in this release.

Reproducible SDK compatibility commands are in [media README](../media/README.md).
The fixture uses actual pinned SDK session/runtime and PCM plumbing against a local
WebSocket server with synthetic credentials. It cannot establish provider model
access, live response latency or verified task success. Physical trial counts for
this new voice frontend and text-only grant path are zero as of this source change;
no native/custom latency default is selected from simulated tests.


### Scoped document first-page preview (source, not physical acceptance)

Document-only preparation is immutable: `documentOnly:true`, exact
`documentSessionId`, `captions:true`, `screen:false`. This mode constructs no
ScreenController or desktop lease, even if device support is enabled. The selected
local document adapter supplies a bounded first-page PNG; the backend binds its
source SHA-256 and image SHA-256 to the selected artifact, read-only grant, coding
session and call. Media receives `documentPreview` policy metadata and fetches
`GET /media/:mediaId/document-preview/:previewId` with existing media authentication.

The compositor checks exact call/session, first-page marker, hashes, PNG type,
2 MiB byte cap, image dimensions and a fixed maximum two-minute lifetime. It uses
the existing H.264 video publication, labels the selected filename and “First page
preview”, and sends no image to GPT-Live. Pixels are memory-only and clear on policy
loss, expiry, replacement, local Stop or call end. A revoked/expired preview ID
cannot reacquire automatically. A fresh preview request needs a new identity.
Rendering/upload/source selection and attachment-send receipts belong to the local
adapter/backend; publishing a video frame is not proof the handset displayed it or
that a résumé was sent. No actual résumé or handset preview was used in media tests.


Verified document jobs use the backend-constructed `job.report` for candidate
names, selected preview status and transfer receipts. Raw worker summaries cannot
substitute for those reports. In particular, provider acceptance remains distinct
from confirmed delivery. The same verified-result, revision and speech-hold checks
apply. Reports are capped at 1,200 characters and sent as ordered, labeled context
chunks of at most 480 UTF-8 bytes each, preserving non-ASCII filenames within the
provider append budget. Context ACKs still do not prove spoken or handset delivery.

## Argos camera and annotations (local source)

The default-off `CLAWDTIME_SCREEN_CAMERA_ENABLED` gate adds a version-negotiated
camera to the existing ScreenController/CaptionPublisher. Camera-aware policy uses
`X-ClawdTime-Camera:1`; unsupported peers cannot receive a selected-window session
as a legacy full-display stream. Native source frames remain pristine for observation;
cropped/annotated outgoing frames are separate. A bounded context/caption footer
sits outside the source viewport. Mutation IDs/revisions and short-lived annotations
are transient; unknown input receipts retain their existing durable semantics.

The local preview uses the production gateway, source controller, camera handlers
and compositor with synthetic pixels or an explicitly selected development capture
source. Its input sink is synthetic and actual mode submits no OS input. Full
connector/API smoke validation, physical capture coverage and remaining acceptance
steps are recorded in [IMPLEMENTATION_ARGOS_REVIEW.md](IMPLEMENTATION_ARGOS_REVIEW.md).
No FaceTime/live-media acceptance or deployment is implied. See [media README](../media/README.md#general-screen-camera-argos-local-slice)
for precise limits, preview and cleanup commands.

For isolated native CUA review, actual preview can advertise `agent_tools_only`
with explicit `nativeControl: true` and authenticated loopback-backend configuration.
This lets the real ownership broker coordinate the original agent's native tools
while media continues to capture only the selected window. Preview input remains
absent, including a pre-receipt rejection of all actual-mode fallback actions.
Default actual mode stays view-only. Native-host qualification, native tool results,
and UI verification belong to the original agent; the media readiness response is
not proof of those properties. No FaceTime connection or installed-service update is
performed by this local mode.

## Same-chat ElevenLabs streaming frontend

The optional `elevenlabs` frontend connects one continuous bidirectional voice
stream to the existing authenticated FaceTime participant. It keeps the original
coding chat as executor and uses the existing screen camera and CUA ownership
broker. It is independent of the older `gpt_live` API-managed executor negotiation.
There is one speech owner per call; frontend selection cannot change during a call,
and missing prerequisites fail activation instead of selecting legacy half-duplex.

`media/elevenlabs_frontend.py` independently implements the published
[ElevenLabs Agents WebSocket protocol](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
using the already pinned aiohttp/LiveKit dependencies. No Argos upstream source was
copied. Provider configuration is read and validated before obtaining one signed
WebSocket URL. URL authority is restricted to the official ElevenLabs WSS endpoint;
redirects, authentication failures, incompatible audio formats, tool drift and
unexpected provider disconnects fail closed. There is no reconnect or automatic
effect retry. Reads of backend progress may retry while current policy remains valid.

Provider audio arrives in synthesis bursts, independently of the 20 ms publication
cadence. A provider-only synthetic probe reproduced rejection of a valid 79,882-byte
PCM event (about 2.5 seconds) by the former 88,000-character base64 limit. This
reproduces a frontend failure mode; the earlier call's generic `capture_loop`
failure metadata alone did not identify its exact exception. That lifecycle category
also includes voice frontend background tasks and does not by itself identify a
screen-camera failure.

The adapter now bounds each PCM16/16 kHz event to ten seconds (320,000 bytes),
the WebSocket message to 512 KiB, and queued plus currently converted source PCM
to twenty seconds (640,000 bytes) and 1,024 events. A single event's resampled
48 kHz buffer is additionally bounded to approximately 960 KiB; the existing
two-second outgoing publication queue remains separate. The socket reader never
waits for playout, so interruptions can clear queued speech immediately. Cutoff
invalidates the output generation, clears transient source buffers, and ensures
an old in-flight chunk cannot decrement a newer generation's byte count or play
after cancellation. Malformed audio, capacity overflow, stale authority and task
failure remain fail-closed; no provider reconnect or speech replay is added.
`voice_frontend_failed` logs contain only a fixed task stage, allowlisted failure
code and queue counts, never exception text, transcripts or audio. See the
provider-only probe instructions in `media/README.md`; these tests do not establish
physical handset audibility or duplex acceptance.

The coordinating lead's fixed provider-only probe passed for 26,511 ms: largest
base64 event 109,740 characters / 82,304 decoded bytes, peak queued source PCM
82,304 bytes, 216 paced publication frames, no frontend failure, no tool effects,
and zero queued bytes/events after Stop. The legacy probe rejected a valid
79,882-byte event. Local validation passed 45 frontend tests, ten lifecycle tests
and five speech-diagnostic tests, including real-time paced synthetic burst drain,
in-flight interruption, event/queue bounds and log privacy. This supports the
packet-limit diagnosis as a likely explanation for the earlier call failure;
that call's exact exception was not retained.

Authenticated `GET /voice/elevenlabs/readiness` returns only `configured`,
`agentValidated` and `ready` booleans with `Cache-Control: no-store`. Within a
six-second overall deadline it reads the selected agent and any referenced tool
definitions; it does not obtain a signed URL, open a provider session, send audio,
use model credits or dial. Disabled/missing configuration skips provider reads.
Activation repeats the same validation to reject intervening drift. Passing this
read-only check does not establish WebSocket permission, provider session startup
or physical audio acceptance.

Runtime prerequisites, all explicit and disabled by default:

- The backend enables `CLAWDTIME_ELEVENLABS_ENABLED=true`,
  `CLAWDTIME_TWO_WAY_VOICE_ENABLED=true` and qualified
  `CLAWDTIME_REMOTE_AUDIO_ISOLATED=true`. The exact protocol-2 coding session
  registers `voiceFrontend:{version:1,provider:"elevenlabs"}` and
  `voiceInteractionVersion:1`; it must not select an API-managed conversation runner.
- Media enables `MEDIA_ELEVENLABS_ENABLED=true` and
  `MEDIA_TWO_WAY_VOICE_ENABLED=true`, with its separately protected
  `ELEVENLABS_API_KEY` and explicit `ELEVENLABS_AGENT_ID`. The key must be able to
  read the selected agent/tool definitions and obtain authenticated conversation
  URLs. Runtime activation verifies the selected agent; a configured key alone
  does not establish readiness.
- Existing backend/media authentication, LiveKit, caller identity qualification
  and fresh policy requirements still apply. The short existing connection notice
  uses Deepgram before the ElevenLabs owner starts, so `DEEPGRAM_API_KEY` remains a
  prerequisite in this source. Legacy STT and ordinary TTS do not run alongside the
  streaming frontend. Audio isolation flags require operator qualification, not an
  inference from passing local tests.
- Screen tools additionally require the existing screen-camera gates, exact
  selected surface and current lease. The original coding agent prepares bounded
  target IDs and annotations through the authenticated session API. IDE support
  remains optional. No voice tool gains general desktop-input authority.

Generate a reviewable creation payload for a **new dedicated agent** locally:

```sh
media/.venv/bin/python media/elevenlabs_agent_config.py --voice-id YOUR_EXPLICIT_VOICE_ID > /tmp/clawdtime-elevenlabs-agent.json
```

The builder reads no environment or credentials and makes no network request.
It validates Gemini 2.5 Flash, Eleven Flash v2, 16 kHz PCM input/output, authenticated
access, prompt/first-message overrides, disabled recording, zero retention and
exactly seven client tools. The existing two-tool Argos lab agent is incompatible
with this contract and must not be modified implicitly. Creating/configuring a
provider agent is a separate operator action; no deployment or provider mutation
is performed by this local implementation. Agent GET responses may supply inline
tools or tool IDs; IDs are resolved with read-only GETs and every definition is
validated. Matching inline and ID-resolved tool definitions may coexist after
normalizing documented inactive defaults. Active workflows, external tools, MCP,
procedures and built-in actions are refused; the provider's inert single start
node is allowed only with no edges, parents, subgraphs or frames. Provider queueing
is explicitly disabled in the builder and checked at readiness.

The tools are `send_to_agent({text})`, `show_target({target_id})`,
`show_overview({})`, `annotate_target({target_id})`, `clear_annotations({})`,
`stop_sharing({})` and `end_call({})`. A coding handoff must quote the latest actual
human transcript exactly. The media adapter forwards that transcript, never a
model-rewritten instruction, with a stable event ID into the original chat's
ordered turn/acknowledgment flow. A tool result reports queued/accepted/refused or
unconfirmed, never invented execution success. Unknown handoffs are not retried,
including when the model supplies another tool ID. Task cancellation goes through
the same original-chat instruction path; it is distinct from speech interruption.

Camera tools accept only currently advertised prepared target IDs. The backend
rechecks prepared geometry/content revision and the exact camera lease before
focus or annotations. Overview, marks and smooth focus are presentation changes;
they do not move windows, navigate an IDE, type, click or switch selected surfaces.
The original coding agent still claims/releases native or fallback ownership for
real desktop input. Stop sharing revokes viewing/input while preserving the voice
conversation. End-call requires a direct current human hangup phrase; quoted,
conditional and negated mentions are refused. Native approval remains in its
original supported surface.

Progress is read from authenticated `/media/:id/voice/context` snapshots and sent
as passive contextual updates only; it never separately triggers narration.
Verified agent replies sent through the existing `/speak` endpoint become bounded
context for this sole voice owner. The existing durable speech receipt is terminal
`unknown` with reason `frontend_context_submitted` after a successful socket write,
or `frontend_context_unconfirmed` after uncertainty. A contextual update has no
causal playback acknowledgment, so it cannot truthfully become `completed`.
Duplicate or restarted requests only reconcile the existing receipt.

To allow completion narration while the caller is quiet, a verified report also
queues one explicitly labelled application `user_message` at the next quiet pause.
Only an explicit original-agent `/speak` reply creates this trigger. Unsaid replies
are coalesced to the newest one, and only one report may be in flight through local
audio drain. If output remains unconfirmed after ten seconds, queued reports are
dropped and further triggers wait for new human input; they are never retried.
That trigger is not human input: its echoed transcript is ignored and **all tool
dispatch is blocked until a distinct actual human transcript arrives**. New human
speech supersedes unsaid reports; queued reports expire after 15 seconds. Neither
lost context nor a lost report trigger is resent. This preserves an honest receipt
even if the provider never speaks the report. Provider output remains untrusted.

Audio uplink uses continuous 100 ms PCM chunks, including silence. Output is
resampled to the existing 48 kHz publication queue. Local speech onset and provider
interruptions clear current playback; late audio for the interrupted response
cannot restore it. Audio and text stay in memory. Input, output, tools, context and
report queues are bounded; oversized data fails closed rather than silently
truncating an instruction. Older provider transcript events without `event_id`
receive a local per-socket identity; immediately repeated identical no-ID text is
conservatively coalesced. This may require a differently worded explicit new
request, and prevents an ambiguous duplicate from becoming a second effect.

Allowlisted diagnostics measure latest transcript receipt to first subsequent
provider PCM (`voice_response_audio`) and tool callback to backend receipt
(`callback_*`). IDs are hashed and durations are monotonic/process scoped. The
first metric is observational, not proof of causal pairing with that utterance;
neither metric measures handset playback or physical user-perceived latency.

Local validation:

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_elevenlabs_frontend.py'
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
```

The focused suite includes a real loopback WebSocket with synthetic provider data,
streaming audio while a backend handoff is blocked, interruption/revocation,
exact-transcript authority, prepared targets, report-trigger isolation, durable
unknown replies and no reconnect. It uses no real provider, handset, microphone,
desktop capture or call. The new combined frontend has **no physical acceptance
evidence yet**. Actual provider schema/config access, audio isolation, audible
reporting, barge-in/recovery, camera responsiveness during work and cleanup still
require a separately authorized supervised trial. Local test success is not
Argos-equivalent handset-experience acceptance.
