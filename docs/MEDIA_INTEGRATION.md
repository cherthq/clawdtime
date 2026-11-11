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
- `POST /media/:id/failure {}`: revoke screen/control and begin conservative call
  cleanup; keep the native call reservation until actual cleanup evidence.
- `POST /media/:id/screen-stopped {leaseId,reason}`: revoke the exact selection.
  A stopped lease cannot be silently reacquired; require a fresh explicit selection.

A private endpoint does not authenticate a biological speaker or distinguish all
background audio. Backend must accept only explicit wake-addressed feedback, require
clarification for ambiguity, and never interpret native blanket approval or agent
TTS as human authorization. The notice explains this. “Hey ClawdTime, stop
listening” latches capture off locally in media; the backend must also pause policy.

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
