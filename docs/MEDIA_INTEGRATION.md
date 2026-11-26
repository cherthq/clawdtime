# Attention media integration

## Independent task walkthrough: handset adapter

`task_walkthrough_livekit.py`, `task_walkthrough_voice.py`, and
`task_walkthrough_livekit_local.py` add an explicit `handset_walkthrough` branch.
The audio-only c1 validator remains separate and rejects its video/capture flags.
The first connected supervised visual call showed prepared scenes and the user reported that
the walkthrough looked good. A spoken change started a new run, correctly retired
the old presentation, and left the screen dark. Voice then stopped responding.
That attempt does not qualify the integrated walkthrough; an offline recovery
repair followed. In a later separately authorized visual call, the user confirmed
good visuals; exact result acceptance was recorded and explicit hangup
worked. Polite acceptance variants exposed a separate confirmation-recovery issue,
addressed by the bounded recovery below. No additional call is implied by this
checkpoint; unmeasured timing and unexercised scenarios remain unqualified.

A separate export grant binds the immutable call plan, private room, exact worker
and agent identities, prepared manifest, capture grant and verified task revision.
A local capture grant alone never exports. Dispatch expires within five minutes;
the separately authorized conversation lasts at most thirty minutes. The original
capture grant retains its shorter expiry. `exportActive` authorizes prepared
capture; `sharingActive` describes an actually shown scene. Neither extends a grant.

An explicitly installed `grant.continuity:"call"` keeps the original authorized
window catalog available through coding, verification and task acceptance for
that one call. Omitted continuity retains the legacy revision-bound behavior.
Initial preparation still requires the exact current result; no historical grant
is silently upgraded. Ongoing root authority returns `sceneEvidenceCurrent`:
false keeps live pixels authorized while invalidating prepared result claims.
The renderer removes prepared annotations and replaces the title with a neutral
live-view label. Once invalidated, those claims stay disabled for this immutable
manifest, including after a delayed older authority response. Task/context changes
fence old scene speech without stopping video; current status and neutral scene
responses supply the conversation's new context. This does not guarantee a preview
app or editor has refreshed its own contents, and changing pixels do not prove
verification or acceptance.

The same call may switch among its immutable prepared scene IDs. During a
successful switch the renderer retains the previous fresh authorized view until
the replacement target supplies its first fresh exact-window frame. The existing
one-second export watchdog still applies; this is not permission to hold stale
pixels through failed capture. New windows, identities or arbitrary replacement
targets require separate authorization and are outside this implementation.
Explicit Stop, call end, expiry, revoked authority and capture/export failure
still retire sharing. Continuity is covered offline; physical behavior needs a
separately authorized trial.

The loopback controller starts without capture, room creation, or a provider
conversation. Authenticated `/prepare` inspects every exact prepared window,
checks provider readiness using read-only requests, creates one audio/video room
participant and calls the task service's internal `/presentation/opening`.
That service reserves the first show durably and calls back `/presentation/show`.
Only a fresh post-transition native frame accepted by the LiveKit SDK makes video
ready. Frame metadata retains the original source timestamp and exact generation.
SDK acceptance is explicitly **not evidence that the handset received or saw it**.
Activation requires the exact connected call, the exact incoming microphone
participant, and another fresh accepted frame before opening the one dialogue
provider and again before sending its prepared greeting.

The native worker token can publish microphone audio only. The agent token can
publish microphone audio and the screen-share video track. The existing renderer
supplies only the granted window crops and annotations, at a 15 fps deadline.
There is no handset `PresentationNarrator`: the same Deepgram conversation owns
listening, interruption and outgoing playback. It can request status, show a
prepared scene, stop sharing, submit a correction, accept a result, or end voice.
Every mutating human request uses an admitted finalized utterance ID; model tools
cannot replace instruction text. The service decides whether a correction runs
now or remains held. Speech interruption does not erase a submitted correction.
Scene explanations use the returned authoritative scene description after the
fresh-frame check. No automatic scene progression or desktop input is enabled.

Sharing Stop permanently revokes source admission, joins the capture child,
cancels old scene speech, and changes the existing video publisher to blank-only
frames while voice and coding continue. An independent one-second watchdog does
the same when source frames stop advancing, even while an authority request waits.
Automatic source/export failure then submits one durable presentation retirement;
a root-requested Stop never calls back recursively. Blank SDK acceptance is not
physical clearance proof. The eventual handset trial must confirm the visible
result. Full call cleanup additionally joins dialogue, tracks and room cleanup;
it never infers native call completion.

Retiring a scene fences its speech turn, rather than permanently muting the
conversation. A subsequent finalized human turn can admit a natural reply without
a status-tool call. The first transcript POST uses current task authority read
before that POST, preserving its original text and ID; refusals and unknown
outcomes are never retried or rebound. A late receipt from before Stop cannot
reopen speech. If current assistant text arrives while admission is pending, the
runtime retains only an opener marker and at most 64 KB/256 chunks of audio for
two seconds. Admission, current turn identity and suppression epoch must all
match before that buffer reaches the existing playback owner. Stop, a new onset,
expiry or overflow discards it without canceling the human receipt or an already
submitted instruction. Deepgram supplies no per-chunk turn ID: these checks use
ordered finalized-turn and assistant-text events, not a claim of independently
verified causal attribution for every PCM chunk.

Late status replies retain their original suppression epoch. A new confirmed
instruction or sharing-Stop receipt can acknowledge its own effect after retirement,
but must still match the current finalized turn and epoch after its response is
sent. Cached, refused and unknown results cannot establish a new speech epoch.

Dialogue guidance asks for missing replacement text, values or targets before
submitting an instruction. Bare confirmation does not authorize inventing the
assistant's proposed wording as human source text. This is prompt guidance in
addition to exact-transcript routing, not a new backend semantic classifier.

A failed or unconfirmed acceptance attempt performs one read-only task-status
check. Its cached recovery never repeats the acceptance POST or the status read
for the same finalized utterance. Current `accepted` status can be reported as
already recorded, without claiming the failed request caused it. An unchanged
original `review_ready` result permits one optional request for explicit result
acceptance; a changed result requires fresh review. Unavailable or older status
remains unknown. The response keeps the acceptance error distinct from status
facts and uses the read's original speech epoch. Prompt/tool guidance prohibits
repeated confirmation-error loops or inventing human acceptance wording.

An instruction response with `state:clarification_required` and
`instructionSubmitted:false` is a known request for clarification, not a new run
or an unknown coding effect. The runtime validates its bounded question/options,
caches it for that finalized utterance and supplies guidance to ask once for the
exact option or change. Only a new finalized human answer can make another
instruction request; the guidance does not guarantee the provider's spoken wording.
Bare “yes” or “go ahead” does not select an option unless it is itself an offered
option, such as an exact Yes/No choice. Assistant wording is never
substituted for the human's words. Clarification speech retains its original
turn/retirement epoch; a late or cached response cannot revive retired speech.
This response handling is covered offline; no further call is implied.

Walkthrough status includes bounded `sharingDiagnostics`: the first observed
sharing-stop reason and media lifecycle state, elapsed time, last exported source
frame age, source/render counts, and an allowlisted presentation failure summary.
The first observation survives later cleanup. Reasons distinguish observed task
revision change, retired export authority, remote Stop, local call closure,
stale-frame watchdog, stopped source, and otherwise unclassified export failure.
A remote Stop cannot by itself distinguish an operator request from root-service
reconciliation. No exception text, window titles, transcript, image or provider
body is included. The root saves this typed metadata before the media process
exits; the SQLite journals alone do not retain a retirement cause or timeline.
These diagnostics do not relax fresh-frame activation or authorize a voice-only
fallback. Earlier attempts without these fields cannot be diagnosed retroactively
from a generic export failure or a single completed show receipt.

Capture runs on a deadline-based maximum 5 fps cadence: acquisition and authority
work consume the period instead of adding a fixed 200 ms idle afterward. Overruns
reset the deadline without catch-up bursts. An offline regression with 450 ms
captures, timestamped before acquisition like the native helper, reproduced
premature retirement with the old cadence and remains fresh with the new one.
The one-second export/SDK acceptance limit is unchanged; genuine stalls still
blank and retire sharing. Explicit SDK frame-age refusals now report `frame_stale`
instead of generic `export_unavailable`; binding and closure failures remain
distinct. This repairs a reproduced timing defect, not an established explanation
of the historical ringing failures.

An optional `pipelineAtStop` freezes the first-stop observation before cleanup:
the trigger distinguishes watchdog, SDK stale rejection and other export paths;
capture phases distinguish the capture coroutine's local-authority request,
voice-authority request and native-source wait. Export phases belong only to the
export loop, so concurrent show/status requests cannot overwrite them. SDK phases
distinguish lock wait, pre-submit validation, JPEG decode, submission and post-submit
freshness validation. All phase durations use monotonic time; source/render ages
use original wall-clock frame timestamps. `candidateAgeMs` describes the most
recently selected export candidate, which may precede a currently blocked context
request. Last render/decode/submission durations and frame ages are bounded numeric
metadata, not proof that the observed stage caused the failure. Snapshot failure
returns null and never prevents Stop; no raw exception or media data is included.

Offline qualification injects bounded source/API jitter and separate source,
local-authority, voice-authority, exporter-context, publication and render stalls.
It verifies stage distinctions, first-snapshot retention, fresh-source versus
stale-output observations, joined cleanup and no late output. Real SDK adapter
tests distinguish pre/post-submit stale checks and lock wait without connecting a
room. These tests are diagnostic qualification only: the latest physical retest
still failed before speech, and its exact trigger remains unproven. No additional
phone call or native capture is implied by this checkpoint.

The new controller uses the same private binding, voice, provider, LiveKit,
control and journal flags as the audio controller, plus `--presentation-file`:

```json
{
  "prepare": {
    "presentationId": "prepared-id",
    "manifest": "EXACT_MANIFEST_OBJECT",
    "grant": "EXACT_CAPTURE_GRANT_OBJECT",
    "fingerprint": "ROOT_CANONICAL_SHA256"
  },
  "taskOrigin": "http://127.0.0.1:13323",
  "taskToken": "PROTECTED_TASK_CAPABILITY",
  "helperBinary": "/absolute/worktree/mac/.build/debug/ClawdTimeTaskCapture",
  "exportGrant": "EXACT_EXPORT_GRANT_OBJECT"
}
```

These are placeholders, not runnable credentials. Files must be owner-only in a
private directory outside the worker project. This branch accepts only the explicit
Deepgram provider file; the qualified c1 provider configuration is unchanged.
The operator bearer and exact loopback Host protect `/prepare`, `/activate`,
`/status`, `/close`, `/presentation/prepare`, `/presentation/show`,
`/presentation/observe` and `/stop-sharing`. Browser Origins are refused. There
is no frame download, public endpoint, dialing client or browser capture surface.

Offline validation uses synthetic exact-window frames and fake provider/room
ports, plus the installed SDK's actual RGBA video frame/source conversion without
network access:

```sh
media/.venv/bin/python -m unittest discover -s media -p test_task_walkthrough.py -v
```

## Independent task walkthrough: local candidate, step d

`task_presentation.py`, `task_presentation_local.py`, and the separate
`ClawdTimeTaskCapture` Swift executable implement an independent task presentation.
They do not use the original-chat gateway or widen the handset voice capability.
The supervised three-scene local walkthrough completed all six show/narration
effects with fresh native frames and playback receipts. After the first successful
visual walkthrough, the user reported crackly audio. A fresh annotated walkthrough
with scheduled playback again completed all six effects; the user confirmed
“Audio clear; visuals good.” Visible Stop blanked the preview, all four cleanup
flags were true, and the host/server were stopped. This is local human acceptance,
separate from machine receipts. It does not establish handset presentation
acceptance, complete step d, or authorize another phone call.

A prepared manifest binds the task/run/revision, verified artifacts, exact scene
text, and exact app/window/PID/process-lifetime/display/title hash. A separate
local-only grant expires within 15 minutes. It cannot place calls, activate apps,
or authorize computer input. The first scene's narration must equal the prepared
opening exactly.

`POST /prepare` validates metadata and current task authority only. The visible
**Start local preview** gesture opens local playback and starts the owned capture
child; it first inspects every selected target without acquiring pixels. A later
journaled `/show` captures only its exact window. There is no desktop overview or
fallback to another window/display. Geometry, process lifetime, console state,
expiry, and task authority are checked around capture. A target change, stale
source, failed authority, or Stop clears output and joins the child. Unknown
operations remain unknown across restart and are never replayed.

The renderer samples source windows at up to five frames per second and renders
camera motion on a 15 fps deadline. Render and browser pacing account for work
(including decode and paint acknowledgement), and overruns do not accumulate
catch-up frames. A 450–650 ms smooth zoom runs entirely
inside the selected window's pixels. An optional prepared `overview` rectangle
sets the initial content crop; `focus` must lie inside it. Every transition frame
stays within that overview, including inward rounding at fractional pixel edges.
Omitting it preserves the full selected-window starting frame. This is presentation
framing; it does not hide or change macOS/browser capture indicators. A scene may
include one prepared `annotation: {rect, label}`: the normalized rectangle must
stay inside focus, and the plain-text label is at most 100 characters. A fixed
three-pixel amber outline projects through the actual integer source crop and
resized tile, clipped to that tile. Its label stays in the bottom gutter, with
bounded font sizing; it never covers source content or loads HTML/styles/URLs. A scene receipt requires a new source frame
after the transition completes; original capture timestamps are never refreshed
on cached pixels. Browser image decoding and two animation frames produce a
separate bounded paint acknowledgement. Narration requires that current-scene
acknowledgement before startup, and fresh scene/paint evidence throughout playback.
Neither signal claims the human actually saw the frame.

`task_presentation_narrator.py` uses a separate Deepgram conversation and the
[documented InjectAgentMessage protocol](https://developers.deepgram.com/docs/voice-agent-inject-agent-message).
It has no microphone stream, greeting, or model tools. Only prepared scene text
is injected. The provider can deliver audio before its text event; at most 64,000
bytes are quarantined for at most two seconds, with no playback. The complete
normalized assistant text must equal the entire prepared cue before any audio
is released. Divergence, missing text, capacity, or Stop discards the quarantine.
Playback admits ordered chunks of at most 30 ms with at most 140 ms of PCM and
eight outstanding receipts. The browser schedules consecutive buffers on one
audio timeline with a 60 ms initial cushion and a 200 ms total lead cap. Authority
is checked before every enqueue. This removes the former per-chunk onended →
HTTP check → send → immediate-start gap. The user’s subsequent clear-audio report
is recorded separately above; code and receipts alone do not prove audibility. Signed PCM16 little-endian mono at 16 kHz is decoded without
sample replacement. Stop clears scheduled sources and fences old epoch receipts.
Completion requires the exact full cue, provider audio EOF, and every actual
browser `onended` acknowledgement; enqueue alone never completes narration. This is playback
completion, not audibility. Stop closes the provider and clears queued audio;
no reconnect or substitute speech is attempted. The local narration path has
been qualified in the supervised walkthrough; handset presentation remains separate.

The fixed loopback host defaults to `127.0.0.1:3323`. Operator routes require a
separate bearer and reject browser Origins: `/prepare`, `/show`, `/narrate`,
`/stop`, `/observe?presentationId=…`, and `/status`. The preview uses its own
HttpOnly SameSite cookie, exact Origin checks, and a private fragment capability.
No frame endpoint is available to the operator token. The page blanks stale images
independently of HTTP responses; Stop immediately clears local pixels/audio and
closes its socket before attempting bounded server cleanup. A bounded status poll
also detects an internal host Stop, blanks the preview, closes local playback,
and replaces the Ready label with a stopped/failure message. The responsive preview
uses the available viewport height, containing the complete 16:9 canvas and bottom
annotation gutter while keeping Stop visible. Very short viewports scroll, with
the controls held at the top; this layout change does not alter media or capture.

Host status includes content-free runtime and narrator diagnostics: an allowlisted
phase, the first fixed failure reason, bounded elapsed milliseconds, and saturated
protocol/playback counters. They contain no exception string, provider body, cue
text, credential, or audio. First failure survives cleanup; an unknown operation
receipt is never reset by these diagnostics.

The coordinating lead supplies owner-only files (0600; directory0700):

```json
{
  "prepare": {
    "presentationId": "prepared-id",
    "manifest": "EXACT_PREPARED_MANIFEST_OBJECT",
    "grant": "EXACT_LOCAL_GRANT_OBJECT",
    "fingerprint": "ROOT_CANONICAL_SHA256"
  },
  "taskOrigin": "http://127.0.0.1:13323",
  "taskToken": "PROTECTED_TASK_CAPABILITY",
  "helperBinary": "/absolute/worktree/mac/.build/debug/ClawdTimeTaskCapture",
  "controlToken": "SEPARATE_RANDOM_OPERATOR_CAPABILITY",
  "browserToken": "SEPARATE_RANDOM_PREVIEW_CAPABILITY"
}
```

The manifest/grant strings above are placeholders for full contract objects,
not runnable configuration. The provider file is exactly
`{"provider":"deepgram","deepgramApiKey":"PROTECTED_KEY"}`. Neither file,
the private preview link, nor the journal belongs in Git. The Python host compares
its full prepared configuration field by field and asks the authenticated task API
to confirm the canonical fingerprint; it does not invent a second JSON hash.

```sh
cd mac
swift build --product ClawdTimeTaskCapture
swift test
cd ..
media/.venv/bin/python media/task_presentation_local.py \
  --config-file /absolute/private/presentation.json \
  --provider-file /absolute/private/deepgram.json \
  --journal /absolute/private/presentation.sqlite --port 3323
```

Open `http://127.0.0.1:3323/#PRIVATE_PREVIEW_CAPABILITY` from a protected local
launcher. Do not print this link to logs. Starting the host creates no provider
conversation or capture child. The operator must prepare the exact authorized
manifest before local Start; app windows must already be arranged by ordinary
local interaction. The runtime never activates or moves them.

Concrete native prerequisites are an unlocked active console, Screen Recording
permission for the helper's actual execution identity, exact visible app windows
contained within one unambiguous active display, and a reachable local task API.
No Accessibility permission is needed. `ClawdTimeTaskCapture --preflight` reports
only permission/console/login/lock booleans and never requests TCC access.
`--resolve-target /absolute/private/query.json` accepts exactly
`{"appId":"com.example.app","title":"Exact selected title"}` and returns
one bound target or a fixed refusal reason. Query-specific refusal diagnostics
include only bounded matching counts and exact app/title matching geometry,
including visibility/layer flags. Exact-ID WindowServer metadata independently
reports onscreen-list membership, owner/title agreement, bounds, and app hidden
state. These diagnostics cannot override ScreenCaptureKit admission. Minimized
state must be inspected through the local UI; this helper performs no Accessibility
lookup or permission request. It never returns unrelated window titles,
a window inventory, or pixels. Display-geometry refusal may include only the queried window's bounds
and active display bounds/IDs; it does not select a replacement target.

Validation uses synthetic pixels, fake provider messages, and fake browser audio:

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_task_presentation*.py' -v
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
```

The browser test requires installed Chrome and the repository's `@playwright/test`.
It uses an isolated headless browser and tests stalled fetches, stale pixels,
delayed decode/Start, paint acknowledgement, and Stop during a hung cleanup POST.
These checks alone do not qualify macOS capture, actual provider narration,
speaker output, or a physical screen walkthrough. The separate local human result
is recorded above; handset presentation acceptance remains outstanding.

## Independent coding-task voice: locally qualified step c — November 18, 2026

`task_voice.py` and `task_voice_local.py` implement a separate, task-owned local
audio path. They do not import the legacy original-chat conversation, capture,
camera, device control or calling runtimes. Step c's local spoken task handoff has
been observed with the dedicated provider agent. The subsequent Deepgram c.1 handset retest was physically accepted by the user: prepared opening, task status, interruption, 20 seconds of quiet, and explicit hangup. See `BUILD_LOG.md` for the separate human report and confirmed cleanup. Step d is now in local qualification; step e remains gated.

In the successful local session, a spoken empty-state instruction started run 2
of the same task, and status remained available while that run was working. The
independent verifier rejected the singular text “No task match.” A spoken
correction in the same active voice conversation produced exactly one sequential
run 3, which reached `review_ready` with verification passed. This establishes
the observed voice-to-task handoff and correction loop. It does not establish
measured interruption latency, a 20-second quiet pause, or a ten-minute audio
conversation; those acceptance checks remain outstanding.

One immutable voice capability binds one task and one non-reconnectable provider
conversation. The backend prepares the opening from the verified task state. The
runtime rejects stale opening run/revision bindings before provider startup and
again after preflight. ElevenLabs receives that opening as `first_message`; it
uses the same provider audio and playback coordinator as subsequent dialogue.
There is no separate generic greeting in this local ElevenLabs path.

The only model tools are `task_status`, `submit_instruction`, and `end_call`.
Final provider transcripts are registered with the backend before instruction
submission. The model cannot supply replacement text, execution permissions or a
screen action. Duplicate tool calls and utterances retain one instruction receipt;
uncertain HTTP mutations are not retried. A status request runs independently of
instruction dispatch. A stale/refused transcript cannot execute but does not end
the status conversation. Ending voice does not cancel the task.

The current provider transcript sample lacks a stable event ID. When the provider
does supply an integer ID it is retained; otherwise the runtime assigns a local
sequence within the immutable provider conversation. Consecutive identical finals
without provider IDs are conservatively suppressed. A crash or socket loss never
reconnects or resets that sequence into the same voice session. This may require a
clarification for separately repeated identical speech; it does not permit replay.

Provider interruption events exclusively own speech cancellation. Local audio
energy never cancels playback. One coordinator fences queued audio by epoch and
provider event ID; finalized instruction receipts survive interruption. Playback
buffers are bounded, and local browser Stop immediately stops mic tracks and
scheduled audio before requesting backend cleanup. Browser scheduling or queue
clearing is not proof of audibility or handset interruption latency.

### Handset c.1 adapter and accepted supervised retest

`media/task_voice_livekit.py` adds the task-owned LiveKit audio bridge; it does not
import the legacy media server, captions, screen capture, device gateway or Mac
helper. The user accepted the separately authorized Deepgram voice-only retest described in `BUILD_LOG.md`. Software tests and counters remain distinct from that human report; another call still requires authorization.

The first separately authorized audio-only handset attempt was silent and failed
qualification. Native `bridge_ready` occurred, but the local ledger contained no
media activation receipt or provider binding. The native worker then reported
`bridge_remote_audio_timeout`; local and native cleanup were confirmed. That
native deadline requires non-silent speech after structural readiness, not merely
silent PCM. The adapter already emits continuous prepared silence, so adding
another silence producer would not resolve the missing activation. That failed attempt remains recorded separately from the subsequently accepted Deepgram retest.

The immutable binding contains `mediaSessionId`, `taskId`, `voiceSessionId`,
`callAttemptId`, `roomName`, `workerIdentity`, `agentIdentity`, `expiresAt` (Unix
milliseconds), `audio:true`, and `video`, `screen`, `presentation`, `control` all
false. The room name must be exactly `clawdtime-task-${mediaSessionId}`. The worker
identity owns incoming native-call audio and the worker JWT; the distinct agent
identity owns outgoing speech and `credentials.remote_participant_identity`.
Both tokens allow microphone publication only and disable data publication.

`TaskVoiceLiveKit.prepare(binding)` first verifies authoritative task/voice binding,
`mode:handset_audio_smoke`, the exact call attempt, and `permissions.instructions:false`.
It also checks the selected provider's readiness read-only. It then prepares one
scoped room and a silent audio publisher. It returns the binding fingerprint,
status and worker LiveKit credentials; it does not return task/provider secrets,
open a provider conversation, consume incoming audio or publish video.
`activate({callAttemptId,providerCallId,connected:true})` is reserved for the
coordinator after exact native connection evidence. It waits for the expected
worker audio track before starting the selected task-owned voice runtime.
Provider startup checks readiness and prepared task state. LiveKit room RPCs
use certifi with certificate and hostname verification, disable SDK failover retries
and redirects, and permit only the configured host’s CreateRoom/DeleteRoom paths.
The owned HTTP session is explicitly closed. Unexpected participants, conflicting
audio tracks and reconnects close the local session.
Video remains unsubscribed and no video stream is constructed.

The c.1 scope is status and hangup. In the ElevenLabs path the standard three provider tool names remain,
but both this adapter and the backend refuse instruction execution for handset
smoke sessions. Task context polling checks the current authority. Incoming audio
continues during outgoing speech; only provider interruption events clear output.
Bounded input is PCM16 mono at 16 kHz. The pinned SDK resamples output to the known
48 kHz room source; interruption discards both queued output and the old resampler
tail. Prepared silence runs every 20 ms and is canceled and joined before speech.
Local status exposes bounded numeric `audioOutput.preparedSilentFrames` and
`speechFrames`, incremented after SDK capture accepts each frame. These counters
retain no audio, text or identity; they do not establish RTP delivery, remote
rendering or handset audibility. They were added after the failed attempt and
cannot retrospectively establish its PCM delivery.

A private SQLite journal reserves the exact binding before room creation and keeps
interrupted/unknown tombstones across restart. Its process lock prevents duplicate
controllers. Preparation is joined before scoped deletion; uncertain creation
cannot become confirmed cleanup merely because an earlier delete acknowledged.
No automatic room recreation, provider reconnect, dial retry or unknown-effect
retry is implemented. Local cleanup sends one voice-end request for a prepared
attempt, closes capture/provider/output, disconnects and deletes only its journal-
bound room. `closed:true` describes local cleanup; `nativeCallClosed` remains false.
The coordinator must independently establish native `cleanup_complete` and the
voice-end receipt before reporting full call cleanup. Untouched controller startup
and shutdown do not issue a voice-end mutation.

`media/task_voice_livekit_local.py` provides the runnable controller on literal
127.0.0.1. It requires an exact Host, loopback peer and separate bearer, refuses
browser Origin headers, logs no HTTP access, and has no browser UI. Starting it
opens no room or provider session. Its routes are `GET /status`, `POST /prepare`
with the full configured binding, `POST /activate` with the activation object,
and `POST /close` with `{callAttemptId}`. Status before preparation is `absent`;
preparation returns `silentPublisherReady:true` and `videoPublisherReady:false`.
Shutdown joins scoped cleanup. The controller does not dial or establish whether
a submitted `connected:true` reflects genuine native evidence; that authority
belongs to the authenticated coordinator.

After the separately authorized call is ready to run, the coordinating lead can
supply owner-only files and start this controller:

```sh
media/.venv/bin/python media/task_voice_livekit_local.py \
  --binding-file /absolute/private/handset-binding.json \
  --voice-file /absolute/private/handset-voice.json \
  --provider-file /absolute/private/provider.json \
  --livekit-file /absolute/private/livekit.json \
  --control-file /absolute/private/controller.json \
  --journal /absolute/private/handset-media.sqlite --port 3322
```

The voice and provider files use the existing local voice schemas below. LiveKit
configuration is `{url,key,secret,allowedHosts}` with one fixed allowed WSS host;
controller configuration is `{token}`. The journal parent must be owner-only.
Never place these files in Git. The local task API must be reachable by this
process. A current task voice capability specifically admitted for the handset
attempt is required; a local voice capability cannot be substituted.

The remaining external prerequisites are explicit authorization for the one call,
the exact paired tester and task/run, fresh exclusive line/worker identity and
idle-state evidence, retained cursor/unknown-effect reconciliation, protected
native Calls and LiveKit credentials, and native worker support for
`audio:true,video:false`. The software preparation itself did not authorize a deployment, handset call or
line handoff; live attempts require separate authorization. The gateway, Mac screen permissions and companion Enable
are not audio-only prerequisites. No ten-minute qualification can be inferred from
a shorter attempt expiry; expiry still ends the media session.

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_task_voice_livekit.py'
```

These checks use fake room/event ports, an actual localhost fake provider socket,
and an unconnected real SDK audio source/resampler. They cover silence before
activation, exact identities and tokens, no video/capture before activation,
status/end-only authority, input during output, interruption fencing, revocation,
delayed preparation/activation cleanup, unknown outcomes, restart tombstones and
controller startup/refusal boundaries. They make no physical call or audio claim.

### Explicit Deepgram fallback for the handset qualification

`media/task_voice_deepgram.py` implements Deepgram's native Voice Agent protocol.
The operator must explicitly select the owner-only provider file
`{"provider":"deepgram","deepgramApiKey":"<protected test key>"}`. The existing
ElevenLabs file shape remains supported; there is no automatic provider switch or
reconnection. The backend task/voice capability, immutable native attempt, LiveKit
identities, local Stop and cleanup receipts remain unchanged. This fallback is
restricted to `handset_audio_smoke` with instructions disabled; it is not a
replacement for the locally qualified coding-instruction path.

Preparation performs bounded authenticated GETs to Deepgram's fixed auth/token and
think-model endpoints, requiring the selected managed model to be available.
Startup requires that check to be no older than five minutes. The websocket opens
only after native activation at `wss://agent.deepgram.com/v1/agent/converse`; TLS
and hostname verification remain enabled, redirects and repeat connection attempts
are refused. The actual `Welcome.request_id` is bound with a `deepgram_` prefix.
After Welcome, the runtime sends Settings with the exact backend opening as
`agent.greeting`, then waits for SettingsApplied before sending input PCM.
An eight-second outer activation deadline covers the expected worker track, task
recheck, provider startup and first sink-accepted output. Failure joins cleanup;
sink acceptance is not physical audibility. The runtime also bounds its own
context/socket setup through first output to seven seconds. These bounds do not
extend the native ten-second non-silent-audio deadline.
[Deepgram documents this message order and binary audio protocol](https://developers.deepgram.com/docs/voice-agent-message-flow).

The fixed configuration uses Nova-3 recognition, managed OpenAI `gpt-4o-mini`,
Aura-2 Thalia speech, and raw PCM16 at 16 kHz in both directions. It has only
client-side `task_status` and `end_call`, each with `defer_until_eot:true`; no remote
function endpoint, Think Live presence checks, provider arrays or history replay
are configured. `mip_opt_out:true` requests no retained audio/text/transcript
content; provider usage metadata remains subject to Deepgram's published policy.
[Configuration](https://developers.deepgram.com/docs/configure-voice-agent),
[data handling](https://developers.deepgram.com/trust-security/your-data).

Confirmed user ConversationText is admitted to the existing utterance ledger with
a conversation-local sequence. Tool arguments cannot supply a substitute transcript.
Hangup requires the current admitted explicit human request; new speech clears that
candidate, and cancelled function IDs cannot execute or receive a late response.
Status remains available when transcript admission fails. UserStartedSpeaking clears
the one playback queue; old binary tail is discarded until subsequent assistant
ConversationText. The runtime does not depend on experimental AgentStartedSpeaking.
When input PCM is absent, protocol KeepAlive is sent every eight seconds without
spoken presence prompts. [Turn confirmation](https://developers.deepgram.com/docs/voice-agent-speculative-replies),
[cancellation](https://developers.deepgram.com/docs/voice-agent-function-call-request),
[KeepAlive](https://developers.deepgram.com/docs/agent-keep-alive).

The lead's provider-only synthetic qualification observed authenticated readiness,
Welcome/binding, SettingsApplied, and first nonzero PCM in 494 ms including readiness,
then confirmed local close. Output was discarded; there was no microphone or handset
in that qualification. This does not establish c.1 audibility, interruption latency,
quiet-pause behavior or sustained call acceptance. Offline validation:

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_task_voice_deepgram.py'
media/.venv/bin/python -m unittest discover -s media -p 'test_task_voice_livekit.py'
```

### Local entry point and external prerequisite

The connector CLI `task voice-start` creates a mode-0600 voice-only capability
file. It is distinct from the full task session credential and contains
`version`, `taskOrigin`, `taskId`, `voiceSessionId`, and `voiceToken`. The task
session must already explicitly permit voice. No phone call occurs.

The reviewed offline provider body is
[`media/task_voice_provider.example.json`](../media/task_voice_provider.example.json).
It contains only a voice-ID placeholder, no credentials. The template can also
be printed without network access:

```sh
media/.venv/bin/python media/task_voice_local.py provider-template \
  --voice-id REPLACE_WITH_EXPLICIT_VOICE_ID
```

The user authorized protected credential access, creation of a **dedicated
independent-task ElevenLabs agent**, and local microphone/speaker qualification.
The coordinating lead created that agent and verified its read-only configuration
and exact tool definitions. The first two local sessions failed microphone
qualification and are confirmed ended. After adding local microphone preflight,
a subsequent session completed the spoken instruction, status, independent
verification failure, and spoken correction loop described above. See
[BUILD_LOG.md](../BUILD_LOG.md) for the acceptance and cleanup evidence. No handset
call or deployment occurred. The historical original-chat agent exposes
incompatible tools and must not be silently changed or reused.

The template requires authenticated access, the exact three client tools, no
server tools/MCP/workflows, PCM16 at 16 kHz, prompt/first-message overrides,
disabled silence termination and provider retention/recording disabled. Runtime
preflight reads and validates these settings; it never changes them. A differing
configuration fails closed. The selected first provider/model follows the audited
Argos adapter; no provider migration was added.

The provider's separate `turn_timeout` prompts another turn after silence. The
candidate sets its documented maximum of 30 seconds and disables soft-timeout
fillers, rather than retaining Argos's 10-second setting. This accommodates the
required 20-second pause at configuration level; it does not prove conversational
quiet or absence of presence checks beyond 30 seconds. Those remain observed
acceptance checks. See [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow).

For the authorized local qualification, the lead supplies an
owner-only provider JSON file with `elevenlabsAgentId` and `elevenlabsApiKey`, then:

```sh
media/.venv/bin/python media/task_voice_local.py run \
  --voice-file /absolute/private/voice.json \
  --provider-file /absolute/private/provider.json --port 3321
```

For an authorized local qualification, append
`--diagnostics-file /absolute/private/new-voice-timing.json`. The file must not
already exist and its parent must be owner-only. It contains bounded event counts,
monotonic first/last timestamps and recent timing events after shutdown, without
transcripts, raw audio, provider identities, URLs or credentials. Browser audio
onset detection is diagnostic only: only provider interruption events clear
playback. Browser scheduling, clearing and input-energy measurements remain
application observations; the person must confirm actual hearing and interruption.

Provider preflight uses the pinned certifi CA bundle with certificate and hostname
verification enabled. It resolves the exact referenced tool IDs read-only and
compares every definition against the inline and local tool contract, allowing
only observed inert provider defaults. Empty start-node workflow and unconfigured
webhook/export defaults do not grant any provider-side action. Real destinations,
subagents, data collection, unexpected tools or mocks remain refused. The provider
rejected `parameters.additionalProperties` in the creation body; it is omitted
from that provider schema while local tool requests still require exact empty
parameters.

The launcher prints a private local HTML file path, never its capability URL or
provider credentials. Open that file and follow its local link. Choose **Check
microphone** to grant local audio access, confirm the displayed microphone name,
and speak a short sentence. The input meter must move, the audio engine must be
running, and the current input track must be live and unmuted before **Start
voice** becomes available. Microphone checks do not open a provider connection.
If the browser selected a Continuity or other unwanted input, choose the built-in
microphone from the selector, then check again. Selection changes stop the previous
tracks and audio graph; device names and IDs are not written to diagnostics.
**Resume audio** explicitly resumes a paused local engine; speak again to qualify
its input. **Stop microphone** releases capture without consuming the one-shot
voice session. Closing the page releases the local microphone too.

Choose **Start voice** only after the microphone passes. This resumes the qualified
local graph under a user gesture and opens the provider session once. The page
requests `audio` with echo cancellation and `video:false`; it has no screen-capture
API. The server binds 127.0.0.1, checks Host/Origin and its fresh capability, disables
access logging, and admits one local WebSocket only. Closing the page, losing the
active audio engine, or choosing **Stop voice** ends voice. A fresh explicitly
admitted voice session is needed after disconnect; there is no automatic restart.

Audio, transcripts and provider context are transient in the media process.
The backend retains bounded finalized utterances and instruction receipts in
its encrypted ledger for identity, interpretation and deduplication. Use headphones for initial local qualification; actual
speakerphone echo/interruption remains a separate handset acceptance requirement.

### Validation and remaining acceptance limits

The complete media suite also imports the gateway relay. Install both existing
dependency manifests into the isolated environment:

```sh
python3 -m venv media/.venv
media/.venv/bin/python -m pip install -r media/requirements.txt -r gateway/requirements.txt
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
```

`media/.venv/bin/python -m unittest discover -s media -p 'test_task_voice.py'`
exercises an actual localhost provider WebSocket, synthetic PCM, task HTTP
callbacks, prepared first-message delivery, status during slow instruction
dispatch, duplicate/stale/unknown instruction handling, interruption fencing,
privacy/configuration refusals, local origin boundaries and teardown. The quiet
interval check advances a synthetic clock; it does not establish the actual
20-second listening pause, useful speech latency, a ten-minute conversation, or
physical audibility. Those must be measured with the authorized local provider
session and then the separate c.1 voice-only handset call.

The synthetic browser regression additionally requires the repository's npm
dependencies (`@playwright/test`) and an installed Google Chrome executable:

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_task_voice_browser.py'
```

It runs the actual HTML and AudioWorklet with Chromium's fake microphone against
a localhost fake provider. It checks suspended-input refusal, local check/stop/retry,
no provider opening before explicit Start, PCM delivery, playback and cleanup.
It does not access the hardware microphone or qualify physical audibility,
Continuity device selection, provider ASR, or conversational responsiveness.

Protocol references: [ElevenLabs Agent WebSocket API](https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket)
and [client WebSocket integration](https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets),
checked November 18, 2026. Existing Argos `815d51b` socket, configuration, bounded
buffer and no-retry patterns informed this narrow implementation; none of its
original-chat routing or presentation tools are used.

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
The source project's source-pause behavior does not establish either capability here.

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
an accidental media origin of the source project even though its older API shape is similar.
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

The deadlines nest so that the gateway answers a frame before media gives up. A
native camera frame takes up to 1.85 s on the helper, and the gateway waits 1.9 s
for it. The gateway relay forwards for 2 s, and media waits 2.5 s for a frame on
the relay and on the direct gateway path. Other relayed requests keep the 2 s
wait, and other direct requests keep 1.5 s. The two-second frame freshness check
is unchanged.

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

## Task callback integration — November 20, 2026

The supervisor's task review cycle must reuse `TaskPresentationRuntime` and
`TaskWalkthroughLiveKit` with the existing exact-window manifest and
`continuity: "call"` grant. Task submission, revision and acceptance invalidate
prepared result evidence, not the current view's capture authority. A replacement
scene becomes current only after its first fresh authorized source frame. The
scene-switch path now retains the current source when result invalidation has
just cleared its cached overlay, before the next render tick. This avoids treating
an overlay cache miss as a reason to clear the current authorized view. Source,
authority and export freshness limits remain unchanged; old pixels never acquire
a new capture timestamp.

The existing native helper lease and durable action receipts remain the control
boundary. Before preparing phone capture, the supervisor must await the local
executor's cleanup and confirm no active or unresolved local action. A pending or
uncertain cleanup cannot become permission to start capture or another executor.
The exact-window `ClawdTimeTaskCapture` process may coexist with an idle Local
Control app; it does not run the call Companion or acquire a helper input lease.
The task service must hold its review-ownership fence from preparation through
confirmed capture/call cleanup, including recovery of unknown admissions after a
restart. Merely seeing no helper lease is insufficient if a call is unresolved.
The alternate panel-owned HandsController in the unmerged computer-use branch
must not run beside the helper: its independent main-display capture/input loop
is not an acknowledgement of the helper's exclusive lease. This change does not
install or enable either loop.

Offline validation covers revision/acceptance continuity, fresh-frame switching,
Stop during pending capture, stale frames, authority loss and frozen first-stop
diagnostics. It does not explain or resolve the historical handset capture stalls.
No network screen sharing or handset call is authorized by this development
session. A local-only disposable capture probe is within the authorized local
testing scope; its exact synthetic windows and temporary grant are separate from
historical call grants.

Before proposing a handset retest, obtain fresh local-only capture authority for
exact prepared preview/source/verification windows and an idle local executor.
Use the local presentation command above with a new protected grant and journal;
keep pixels/audio transient. Run at 15 fps for at least four minutes, switch each
prepared view repeatedly, trigger result-evidence invalidation while switching,
and confirm uninterrupted fresh output. Then exercise Stop, permission loss and
capture delay, confirming output clears and cannot restart from late callbacks.
Retain only bounded first-stop timing/counter metadata and the source revision.
If any stage stalls, preserve that outcome and investigate locally; do not redial,
reuse a consumed grant, raise freshness limits or present an old successful call
as evidence for this build. A passing local run precedes a separately authorized
handset test and still does not constitute physical handset acceptance.

`media/qualify_task_capture.py` runs that local-only probe using one temporary
app with two synthetic windows. Compile `mac/scripts/task-capture-fixture.swift` and supply that fixture
and `ClawdTimeTaskCapture` paths; default duration is 240 seconds. It uses the real
native source and 15 fps renderer, checks one-second freshness continuously even
during scene switches, invalidates prepared evidence, and confirms helper cleanup.
It has no media room, network export, audio or input channel. Only bounded counters
and fixed failure reasons are printed; images remain in memory and temporary
metadata/journals/fixture bundles are removed after the attempt.

The local helper now advertises `nativeCaptureDrain: true` at
`GET /local/v1/status`. Its session Stop invalidates authority immediately, then
waits at most 1.5 seconds for any native screenshot callback to finish. Only then
can it return `{stopped:true,captureStopped:true}`. A stalled callback returns an
unconfirmed-cleanup error; it cannot authorize review capture. This bounded
cleanup wait is independent of coding-task duration. Older helpers lack the
capability and cannot qualify combined local-execution/review-capture handoff.

November 20 qualification evidence: read-only preflight reported Screen Recording
available, unlocked active console and completed login for the built helper.
A one-second disposable native smoke passed with 10 source frames, 27 rendered
frames and maximum measured source age 295 ms; helper cleanup was confirmed.
The first extended probe reached 41 seconds, two switches and 210 source frames,
including result-evidence invalidation, before the tool session was interrupted.
Its final outcome is inconclusive. Subsequent process inspection found no remaining
probe, capture helper or fixture processes; this is cleanup evidence, not a
four-minute qualification pass. A distinct follow-up probe retains only bounded
counters/final outcome in a local temporary log so interruption cannot erase the
completion evidence. None of these probes use historical call permissions.

The distinct 240-second follow-up attempt failed before its first 20-second
switch checkpoint with `capture_qualification_failed`. Helper shutdown and child
join were confirmed; no pixels were persisted and no call started. The retained
summary does not isolate the native capture or renderer stage, so the root cause
remains unresolved. The qualification runner now includes the runtime's bounded
first-failure phase/reason and frame counters for future investigation. The failure is preserved while subsequent instrumented attempts investigate
its cause; a later success cannot erase it. Unit tests and a brief smoke are not
substitutes for extended local qualification and handset acceptance.

The instrumented diagnostic isolated `refused_geometry` in the native helper,
1,957 ms after start (8 source frames, 22 renders), with cleanup confirmed.
A subsequent metadata-only check found a synthetic window at x=-1,554 outside
the only active display (0,0,1512,982). The fixture chooses the AppKit screen
matching `CGMainDisplayID` and joins active spaces; no production window, geometry,
permission or freshness check was changed. Subsequent attempts showed that this
alone did not keep the fixture on-screen reliably. A metadata-only run then resolved both
exact targets within the active display, with `captureStarted:false` and confirmed
fixture cleanup. `--resolve-only` provides this setup check without capture.
The helper also reports `captureActive` in local status so review handoff can
check idle capture and drain capability even for runs completed by older helpers.

The final stationary fixture attempt used one accessory app with two normal-layer
windows and AppKit's `canJoinAllApplications`/`stationary` collection behavior.
It still failed native `refused_geometry` at 7,579 ms after 36 source frames and
107 rendered frames. The exact window passed initial resolution but failed the
unchanged geometry guard later. Helper and fixture shutdown/join were confirmed;
no pixels were persisted or exported, and no audio or remote call was produced. This does not establish a screenshot
latency defect or justify switching the capture implementation. Local extended
qualification remains failed because the fixture's geometry was not admissible
throughout the run; a fresh instrumented investigation must distinguish actual
window movement, desktop transitions and inconsistent native window metadata.
The previous failures and interrupted attempt remain part of the evidence.

Next local qualification prerequisite: keep both exact synthetic fixture windows
wholly within the active display for the entire four-minute run, without desktop,
app-set or display transitions that move them out of bounds. Resolve both exact
targets first, use a fresh grant, and retain the existing geometry/freshness gates.
The script fails and joins its children if that prerequisite stops holding. Do not
propose a handset visual test until this extended local qualification passes.

## Staged work-window presentation (November 21, 2026)

`media/window-presentation.mjs` is a transient presentation controller for a future
qualified background capture source. It does not capture windows or submit input.
The caller binds a call/task, driver generation, process lifetime, exact window,
geometry generation and expiry. Each observed frame carries those identities plus
original pixel dimensions, window dimensions in points, capture time and a unique
observation ID. A changed source or geometry retires the binding; stale, missing or
invalid capture hides the view and drops old action positions.

`focus` accepts a target rectangle and cursor point from the exact fresh original
observation, explicitly in window points or screenshot pixels. `layout` returns the
source crop, output letterbox rectangle and optional ClawdTime cursor. It interpolates
to a configurable 1–2× crop (default 1.6×) over 400 ms, holds framing while typing,
and returns to overview on completion or a spoken overview override. The media
caller must apply these results only to outgoing video; planner/input coordinates
remain the original observation's coordinates. There is no remote tap-to-click API.

Cursor compositing requires capture metadata proven to exclude the driver overlay.
An included overlay is not drawn again; unknown capture behavior suppresses the
synthetic cursor and reports `capture_overlay_unqualified`. Stop/hangup must call
`revoke`; every `layout` also checks lease and frame expiry. A cursor is an action
location, not evidence that input succeeded.

`npx vitest run tests/media-window-presentation.test.ts` exercises Retina and
nonuniform point scaling, letterboxing, edge crops, smooth transitions, typing,
overview, stale captures, process/window/driver/geometry changes, duplicate cursor
suppression, completion and expiry. These tests establish presentation math and
failure behavior only. Exact-window capture, driver overlay inclusion, foreground
noninterference and phone readability still require physical qualification.

### Bounded exact-window preview source

`media/driver-window-source.mjs` uses the official generic SDK result envelope and
existing `jpeg-js` dependency. The source requests JPEG with `display_only:true` and
no AX walk, preserving the planner's action snapshot and tokens. It checks exact
PID/window, capture validity and decoded dimensions, caps encoded bytes (4 MiB),
pixels (4 MP) and decoder memory (64 MiB), and returns transient RGBA without retaining
frames or exposing raw provider errors. Unknown overlay inclusion stays unknown.

The default frame/lease clock is epoch milliseconds, matching the presentation and
helper contracts; elapsed capture time is checked separately using a monotonic clock.
Every capture requires positive driver/process/geometry/current-Space witnesses both
before and after it. Missing current-Space evidence is a refusal because the driver
omits that field for both true and unknown. Captures are serialized and rate limited
(default 4 fps); late results after revoke/rebind are discarded. A hung read returns
a bounded timeout, revokes its source binding, and keeps the pending transport fenced
until that operation settles. Consumers hide the view on capture failures; a rate-limited or already-in-flight
read may retain only a still-fresh frame. Presentation checks frame age again at
consumption.

A local disposable TextEdit window produced seven valid 1280×828 JPEG frames in
2.545 seconds across ten scheduled attempts; three attempts were rate limited.
Warm capture/identity/decode time was 213–282 ms; each JPEG was approximately 49 kB.
This measured about 2.75 delivered fps through the CLI bridge, not 10 fps or phone
video acceptance. No personal window was captured in that measurement. The
`media-driver-window-source` tests exercise identity/format/size refusal, rate and
freshness bounds, epoch timestamps, hang/revoke behavior and content-free errors.

### Transient video bridge

`media/background-window-video.mjs` combines the source and presentation modules.
The host supplies only `captureWindow(request)` for the fixed exact-window JPEG
preview and `verifyBinding(binding)` returning positive identity/current-Space
witnesses. It exposes no generic tool or input dispatch. `bind` retires the old view,
`tick` performs at most one bounded read, and `latest({width,height})` returns the
original RGBA pixels plus crop/letterbox/cursor layout. `focus`, `overview` and
`complete` change presentation only. `revoke` immediately drops retained pixels,
action positions and issued views on Stop, hangup or ownership loss.

An HTTP bridge can send RGBA as a binary body with small layout metadata in headers;
do not JSON/base64-expand raw pixels. The renderer must call `isCurrent(view)` just
before writing a composed or queued frame. That check rejects replaced/revoked
bindings, newer captures, changed presentation instructions, stale pixels and expired
action locations. The returned layout also includes `validUntil` for downstream
freshness enforcement. Failed reads discard pixels while preserving geometry
continuity, so a resize during a capture gap requires an explicit new binding.
Neither pixels nor layouts should enter logs, files or durable receipts.

The action observation ID here identifies the current preview solely for framing.
The trusted host must correlate the exact original-window point rectangle and
binding with that preview; it must never substitute a display-only preview ID for
the driver's planner snapshot or input authority token. Phone zoom does not change
input coordinates. Overlay inclusion remains unknown until separately qualified.

`npx vitest run tests/media-background-window-video.test.ts tests/media-driver-window-source.test.ts tests/media-window-presentation.test.ts`
passes 33 synthetic tests, including expiry during composition, action expiry,
late reads after rebind, Stop and a resize across failed capture. These checks do
not establish physical phone rendering or foreground noninterference.

### Cursor exclusion evidence and upstream capture limits

Pinned Cua Driver 0.55.0 source at commit
`8f484f30586eef722bede7a5ce315de1148cca96` routes exact-window capture as follows:

| Route                                                  | Target and overlay implication                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ScreenCaptureKit first on current Space                | A desktop-independent single-window filter, with hardware cursor disabled. Apple's [filter contract](<https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)>) specifies only the chosen window. |
| `screencapture -l` compatibility fallback              | Captures the specified window ID, without pointer or window shadow; does not intentionally composite the separate overlay window.                                                                                                                    |
| SkyLight last resort on current Space, first off-Space | Requests one window's backing store. This private API has no public exclusion guarantee; off-Space frames remain refused by our source.                                                                                                              |

The agent overlay is a separate driver-owned borderless `NSWindow`, explicitly
shareable for display recordings. It is not painted into the target application's
window. These source facts support exclusion for exact-window captures, but are not
physical proof. `get_window_state` reports neither the selected backend nor
`agent_overlay_capture`; the latter belongs to full-display capture. Do not infer
that full-display fallback behavior applies to an exact-window response.

Relevant pinned source is [capture.rs](https://github.com/trycua/cua/blob/8f484f30586eef722bede7a5ce315de1148cca96/libs/cua-driver/rust/crates/platform-macos/src/capture.rs),
[overlay.rs](https://github.com/trycua/cua/blob/8f484f30586eef722bede7a5ce315de1148cca96/libs/cua-driver/rust/crates/platform-macos/src/cursor/overlay.rs),
and [skylight.rs](https://github.com/trycua/cua/blob/8f484f30586eef722bede7a5ce315de1148cca96/libs/cua-driver/rust/crates/platform-macos/src/input/skylight.rs).
The supported window tool/config schema exposes no SCK-only or no-disk-fallback
option. Its deprecated `capture_mode` is ignored and does not select a backend.
The official `screencapture -l` fallback writes a PNG under a unique 0700 temporary
directory, reads it, then removes file/directory through `Drop`. A process crash can
leave that temporary file. ClawdTime's decoder and bridge retain pixels only in
memory, but this must not be described as a strictly memory-only driver pipeline.
No undocumented environment setting or driver patch is used to suppress fallback.

Physical qualification remains pending until local Enable. Use only a disposable
static fixture and the exact pinned daemon/session: after one authorized harmless
input, independently confirm that the driver cursor is visibly over the fixture;
collect transient exact-window previews while it is visible. Then use supported
`set_agent_cursor_enabled` with that explicit session and `enabled:false`, confirm
its visible pixels have disappeared (the acknowledgement alone is insufficient),
and collect unchanged-scene previews. Compare the cursor region while accounting
for caret blinking/JPEG differences; restore that session's prior setting afterward.
Do not capture the desktop or personal windows merely to compare overlays. Keep
foreground/pointer/clipboard witnesses and verify the phone does not double-draw.
An identical pair without independent proof that the overlay was visible is not
exclusion evidence. The stock API cannot force or identify every fallback route,
so record which cases remain unqualified; request upstream backend/exclusion
attestation if stronger route-specific assurance is required.

The optional `overlayQualification` constructor argument is for trusted host
configuration only. It requires the exact 0.55.0 release archive hash, current driver
generation, OS build, fixed `get_window_state/jpeg/display_only` pipeline, evidence
ID and qualification/expiry times. The host must validate its OS/release against
that evidence; this display adapter does not attest the installation itself.
Only matching, still-valid evidence can mark a frame `excluded`, and it must cover
the frame's entire freshness lifetime. Replaced generations, expired evidence and
all ordinary provider responses remain `unknown`. No qualification is enabled by
this change, and no planner/tool output may create this configuration. Synthetic
checks exercise expiry, generation mismatch, immutable evidence, release refusal
and rejection of provider-supplied exclusion claims.

## Proactive call media — November 22, 2026

`line/proactive-agent.mjs` is a dedicated, single-attempt worker. It reuses the
incoming worker's warm audio/video publication and transcript provenance, while
replacing its general desktop tools, conversation recall, job announcements and
screen capture with an authenticated exact-source client. Its protected config
binds attempt, room, agent, caller, source and packet fingerprints and expiry.
The worker accepts exactly one matching LiveKit dispatch. A different participant
cannot receive the brief or supply an answer.

`line/proactive-outbound.mjs` creates the dedicated room through the supported
LiveKit SDK, waits for exactly one expected participant and one unmuted audio and
video publication, and issues a bounded token for the provider's exact caller
identity. Creation/deletion must first be reserved through the service's durable
effect port. Lost creation responses remain unknown; repeated calls do not retry.
Cleanup joins late preparation before deleting only the reserved room and checks
its absence. These publications are server metadata evidence, not received media
or handset playback evidence. Native call submission and reconciliation remain
with the shared coordinator and existing Calls adapter.

The protected loopback `/proactive/line/:attemptId` API delivers the bounded
brief and routes each complete authenticated caller transcript with a stable turn
ID. A lost answer response is not resent. Alert calls have no screen-frame path.
Walkthroughs pull only exact prepared-view RGBA frames; source/packet/view identity,
pixel length and a one-second freshness bound are checked before rendering. The
whole authorized frame is letterboxed locally. There is no desktop fallback.
Stop sharing is sticky for the call; it does not cancel independent work. Hangup,
revocation, changed source, expired authority and heartbeat loss retire sharing.

### Local line release prerequisite

`line/local-readiness.mjs` makes bounded GET-only provider checks and validates
original local ownership evidence twice around the network reads. Connector
inventory uses the separate protected CLI account credential when needed; a
project API key does not imply connector-management access. BYOR v2 journals
have receipts rather than the older numeric message cursor. The receipt witness
reads the original private journal in place, rejects removed/changed receipts,
checks complete entry cleanup, and emits only hashes/counts. It never copies or
rewrites runtime data.

The installed `@trychert/facetime@0.1.0-beta.19` and the registry's latest
`0.1.0-beta.22` both delete the original per-binding journal after clean `dev`
release. Every exit path, including displaced/drained, reaches that cleanup. The
published `CLI_GUIDE.md` explicitly documents this behavior. No supported
preserve-state switch or outbound control interface on the existing `dev` host
was found. `assertIncomingReleaseSupported` therefore refuses this handoff
before a stop request; a future release is not presumed compatible.

Published beta.22 was downloaded for source inspection only, without replacing
any installed package. The registry tarball SHA-256 is
`e21acbc21595cc8fd685501ab0378dc5b30f4b826742b9dcd7736b9566e89363`.
Its `CLI_GUIDE.md` SHA-256 is
`7053326cea826eaf5b349db20e9e4dd6b9d79cb9d9be8a57b620ddbece83dc3d`;
`dist/src/dev/command.js` SHA-256 is
`7d35b1595ca77c103d652ffcf9371a7e48629f5a43d86d223eb1b22ccfc6e080`.
The guide's clean-stop rule is at line 57; source deletion is at lines 615–619.

The strengthened `host.sh stop` additionally requires a fresh `dev_stopped` with
zero retained work after the exact pre-stop log inode/byte boundary. Historical
records, rotation, lost release and retained cleanup cannot authorize killing the
session. An `outbound-hold` prevents incoming restart until the coordinating
service reconciles cleanup. These checks do not override the unsupported journal
retention prerequisite or turn an idle line into an unowned line.

### Pinned journal retention adapter (2026-11-22)

`line/provider-retention.mjs` is ClawdTime's explicit local adapter for installed
`@trychert/facetime@0.1.0-beta.19`, not an upstream provider retention feature.
The published beta.22 also deletes clean dev state and provides no retention
option. This adapter pins the installed Node v24.22.1 executable SHA-256 and four
provider source hashes (CLI entry, dev command, claim/release, journal) in
`RETENTION_PIN`. A version or byte mismatch refuses activation. No package,
global module, sibling repository, or provider API is patched.

The adapter changes only `fs.rmSync` calls from the pinned dev command for an
exact direct `dev/<binding>` directory or its corresponding credentials file.
It checks the original journal's project, line, binding and BYOR scope before
preserving those paths in place. Other deletion calls retain native behavior.
Normal provider drain, revoke, media cleanup and `dev_stopped` emission execute
unchanged. Node's documented
[`syncBuiltinESMExports`](https://nodejs.org/api/module.html#modulesyncbuiltinesmexports)
updates existing named imports; the test exercises the already-loaded actual
provider `runDev` with synthetic control dependencies and forbidden network.
No journal or credentials are copied, moved, rewritten or restored.

Private config (0600, owner-only canonical directories) has
`{version:1, providerRoot, chertHome, projectId, lineId, receiptDirectory}`.
The process proof contains PID, process start time, executable/hash, process
command hash, provider source hash, config hash and guard hash; no credential or
call content. The owner verifies that proof and the exact live provider binding.
For a zero-call process whose journal does not yet exist, the owner additionally
calls `authorizeRetentionBinding(configFile, pid, scope)` after verifying the
provider binding. This creates only a new scoped binding authorization record;
it never synthesizes an original journal or cursor. Missing or contradictory
scope evidence refuses cleanup rather than deleting anything.

The coordinating lead alone may migrate a running unguarded owner. From the
final immutable source release, first write the bounded process identity to a
new private file, then install against that exact identity:

```sh
umask 077
node line/provider-retention-migrate.mjs describe "$RETENTION_CONFIG" "$INCOMING_PID" > "$EXPECTED_IDENTITY"
node line/provider-retention-migrate.mjs install "$RETENTION_CONFIG" "$EXPECTED_IDENTITY"
```

`describe` is read-only. `install` verifies the pinned executable, exact CLI
entry/`dev` arguments, PID/start time, source and config again before signaling.
It rejects pre-existing inspector flags, any `NODE_OPTIONS`, and an occupied
loopback port 9229. The documented Node SIGUSR1 inspector activation keeps the
owner running. The utility verifies the inspector's PID/executable/CLI identity,
installs the same tracked guard using documented `process.getBuiltinModule` and
`createRequire`, requires its acknowledgment, and closes and checks the inspector.
An installation failure after verified attachment also closes it; uncertain
attachment or closure is an operational refusal, never permission to stop or
claim a replacement. No unrelated debugger is closed. Only after this completes
may the owner perform its ordinary graceful stop and require a fresh retained=0
release receipt plus original-journal witness.

Future incoming processes use `CLAWDTIME_LINE_RETENTION_CONFIG` with the scoped
`provider-retention-preload.mjs` loader; the agent process is unaffected.
`CLAWDTIME_LINE_ENV_FILE` points at the original private env file without copying
or linking it into the immutable release. Before a fresh claim, preload reads
original journals in place and applies the pinned provider's schema and
`complete()` predicate, refusing unfinished/unknown originals. A guarded dev
exit never triggers host.sh's automatic restart: the owner must reconcile the
release before another claim. A fresh binding remains distinct from its retained
predecessor; the owner records that lineage and never treats a new enrollment as
recovery of an old unknown outcome.

Synthetic validation: real named fs import, exact-path preservation, wrong-scope
refusal, unrelated deletion behavior, actual pinned `runDev` drain/revoke,
zero-call binding authorization, incomplete original refusal, inspector port
collision, failed-install closure and successful acknowledgment/closure.
These checks make no live calls and are not physical acceptance.

After a retained migration, source rollback keeps the new retention wrapper and
preload. Set `CLAWDTIME_LINE_RELEASE=~/clawdtime-host/line` when
starting the new immutable release's `line/host.sh`; this explicit environment
value overrides the env-file release setting and is passed to both tmux keepers.
The baseline agent then reads the original private env file while guarded dev
continues using the pinned retention adapter. The coordinating lead may restore
the original desktop launcher separately. Never use the unguarded baseline
`host.sh` to stop or start after migration: it could delete newer journals.
Rollback still requires confirmed cleanup, retained original journals and no
unknown outbound owner; selecting old source never clears the ownership fence.

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
qualification used successful media deployment `<deployment-id>`,
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
Backend deployment `<deployment-id>` and media deployment
`<deployment-id>` both reached SUCCESS. The lead verified
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

The November 17 selected-display prototype adds opt-in `displayStream:true` to
the isolated local preview. A persistent development-only SCK source, bounded
latest sample and inherited request/response pipes replace per-frame CLI launches
for this explicit display selection. Local source/render targets can reach 15/30
fps; actual rates require measurement and do not describe production defaults.
`GET /preview/metrics` exposes original source age, distinct delivered source rate,
render response rate and mean costs without content. Preview Stop also issues one
authenticated backend screen-stopped notification, with acknowledged versus
unknown outcome recorded and no retry. Installed helper/gateway/media services
are unchanged by this source prototype. See the [local stream workflow](../media/README.md#local-selected-display-stream-and-cadence-measurements)
for commands, bounds, measurement meanings and acceptance limits.

### Local physical evidence — November 17, 2026

The coordinating lead completed one selected-display rehearsal with normal
Finder and TextEdit windows on the current display. Prepared Finder activation,
TextEdit activation and return to Finder each verified the exact app active,
window focused and window on-screen, with the outgoing preview inspected.
The original native CUA tool separately changed/saved one disposable document
heading and moved one disposable file; UI and filesystem observations confirmed
the results. The new activation executor did not perform those edits or moves.

| Case                                                   | Evidence and limit                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Normal windows on current selected display             | Activation and outgoing preview passed in this rehearsal.                                                     |
| Original native CUA under current ownership            | One document edit/save and one file move verified; no general input capability added to the preview executor. |
| Off-Space, full-screen, minimized or multiple displays | Not qualified.                                                                                                |
| Stop and release                                       | Capture stopped cleanly, ownership returned to none/paused and the viewing lease released.                    |
| FaceTime, handset delivery or installed services       | Not exercised or deployed.                                                                                    |

Across approximately 417 seconds, metadata recorded 5,086 source requests, 3,020
distinct source samples and 11,186 rendered responses (about 26.82 fps), with no
source failure. The run was mostly static with some motion; these counts do not
establish sustained high-motion source cadence, 30 fps delivery or latency bounds.
All native calls returned. Private audit and durable operation receipts were
retained; no screen content or runtime identities are included here.

The default-off `CLAWDTIME_SCREEN_CAMERA_ENABLED` gate adds a version-negotiated
camera to the existing ScreenController/CaptionPublisher. Camera-aware policy uses
`X-ClawdTime-Camera:1`; unsupported peers cannot receive a selected-window session
as a legacy full-display stream. Native source frames remain pristine for observation;
cropped/annotated outgoing frames are separate. A bounded context/caption footer
sits outside the source viewport. Mutation IDs/revisions and short-lived annotations
are transient; unknown input receipts retain their existing durable semantics.

The local preview uses the production gateway, source controller, camera handlers
and compositor with synthetic pixels or an explicitly selected development capture
source. Its default input sink is synthetic; actual mode defaults to view-only.
The separately negotiated `nativePresentation:true` local capability adds only
prepared app activation and window raise, with a backend-only host credential,
persistent receipts and fresh native ownership. Actual fallback input still
refuses before dispatch. Full
connector/API smoke validation, physical capture coverage and remaining acceptance
steps are recorded in [IMPLEMENTATION_ARGOS_REVIEW.md](IMPLEMENTATION_ARGOS_REVIEW.md).
No FaceTime/live-media acceptance or deployment is implied. See [media README](../media/README.md#general-screen-camera-argos-local-slice)
for precise limits, preview and cleanup commands.

For isolated native CUA review, actual preview can advertise `agent_tools_only`
with explicit `nativeControl: true` and authenticated loopback-backend configuration.
This lets the real ownership broker coordinate the original agent's native tools
while media continues to capture only the explicitly selected surface. Without
the separate native-presentation capability, preview input remains absent;
all actual-mode fallback actions retain their pre-receipt rejection.
Default actual mode stays view-only. Native-host qualification, native tool results,
and UI verification belong to the original agent; the media readiness response is
not proof of those properties. No FaceTime connection or installed-service update is
performed by this local mode.

Selected-camera refusal diagnostics now distinguish the native guards that
previously shared HTTP 409. `CaptureRefusal` emits only the fixed
`X-ClawdTime-Camera-Refusal` code: exact window missing/owner/layer/geometry,
initial placement or another display, hidden/minimized or unverifiable/ambiguous
lifecycle evidence, capture busy/dimensions, changed authority/display, or stale
frame. Native messages, window IDs/titles, geometry and arbitrary exception text
are excluded from this header. Both pre-capture and post-capture target checks
preserve the typed 409; the gateway logs the allowlisted reason and still stops
the lease with HTTP 410. Its outbound relay forwards that fixed header only for
failed frame requests. Unknown codes are discarded. No retry, lease revival,
freshness extension or wider capture fallback is introduced.

The development binary supports `--camera-check --surface '<exact surface JSON>'`
to run the current target guards without capturing pixels. Its `captureAvailable`
result means only those target guards passed: it does not validate a lease, local
session authority, post-capture identity, frame freshness or successful capture.
The existing `--camera-probe` uses the same explicit surface and checks capture
for 30 seconds/120 frames by default; explicit `--probe-seconds 90` permits a
sustained check beyond the incident's approximately 35-second mark. Durations are
bounded to 1–120 seconds, at most four times that many frames, with a process
deadline five seconds later. Runtime/freshness use a monotonic clock. It returns
counts and fixed refusal codes without
printing or saving pixels. These development modes neither load installed helper
configuration nor arm sharing. The diagnostic source and local release build are
not an installed-helper update. The earlier production native 409's exact guard
remains unproven; two lead-run installed-helper probes passed 76 and 78 frames
over approximately 30 seconds each without reproducing it. The newly built
diagnostic binary also passed `--camera-check` and captured 77 frames in 30,109 ms;
no actual Space transition was verified during these probes. The local commands
are `mac/.build/release/ClawdTimeCompanion --camera-check --surface '<exact surface JSON>'`
and the same command with `--camera-probe`, only for the explicitly authorized
disposable surface. Validation passed
61 Swift tests, 42 gateway tests and 12 affected media-relay tests; independent
review found no blocking changes to the existing refusal/Stop boundaries.

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

A subsequent call retained the more specific `stage=output code=task_timeout`
failure. The frontend's former 300 ms publication-queue deadline was shorter than
the publisher's existing two-second SDK playout-barrier allowance. A regression
using the real `Session.publish` loop, a synthetic 550 ms SDK barrier and a
three-second audio burst reproduces that exact fault signature with the old
deadline, including zero remaining source-queue bytes after cleanup. It does not
establish which downstream operation delayed the actual call's publisher.

Output enqueue now waits at most three seconds for a continuously full publication
queue, rechecking fresh authorization and exact playback/output generations every
20 ms. Each successful enqueue is atomic with its authority check; no blocked
queue-put task survives cancellation or inserts old speech after a cutoff. This
applies to PCM frames, resampler tails and completion barriers. Unqueued barriers
are canceled on authority loss, Stop, cancellation or timeout. Sustained lack of
progress still fails closed as `playback_queue_stalled`; safe fault logs now also
include the integer publication-queue depth. No queue capacity, policy-freshness
limit, provider retry behavior or call-failure safeguard is relaxed. All 48
frontend tests pass, including the publisher-pause reproduction, the actual
three-second stall bound and authority/epoch/generation/close cancellation cases.

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

The builder sets the provider's independent conversation limit to 600 seconds
and disables ending on silence (`silence_end_call_timeout: -1`). Readiness and
activation require an explicit integer limit from 600 through 7,200 seconds and
disabled silence termination. Changing the source template does not update an
existing provider agent; the operator must update that dedicated agent before
readiness will pass. This limit remains a provider-side ceiling, separate from
backend request deadlines and active-call lifetime. There is no automatic
reconnection or replay when it expires. See ElevenLabs' [conversation flow
documentation](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow).

Provider failures log only a numeric WebSocket close code, a fixed close category,
monotonic socket lifetime and the validated provider limit alongside the existing
queue counters. Close reasons, provider bodies, transcripts and conversation IDs
are excluded. A normal provider close still stops the active frontend; it does
not prove that pending speech or tool effects completed. JSON ping events receive
an immediate matching pong, independently of queued audio and pending tools, as
specified by the [client events protocol](https://elevenlabs.io/docs/eleven-agents/customization/events/client-events).

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

### Prepared two-app presentation and production staging (November 17)

The coordinating lead completed a local snapshot-only, no-call rehearsal on the
current selected display: Finder → TextEdit → Finder, three verified native
activations and three accepted target presentations. Each outgoing preview crop
and label was visually observed. The entire two-scene plan was prepared first;
a same-session follow-up plan also completed (two plans, generation four).
Approximately 157 seconds produced 468 snapshot requests and 3,556 rendered frames
(about 22.7 fps), without capture failure. Stop ended with no owner, paused work,
epoch seven and the lease released. Pixels stayed transient. These observations
qualify normal current-display local preview only; they do not qualify FaceTime,
remote network budgets, cross-Space/fullscreen/minimized/multi-display behavior.

Production source now reuses that selected-display snapshot transport for a
separately gated read-only live-presentation capability. It adds no production
activation/input endpoint. The original chat's authorized native tools still
handle app switching and work. The helper's scoped readiness version, authenticated
backend authority, exact lease binding, original timestamps, bounded monitored
window witness, atomic camera commit and durable namespaced receipts must all
agree. `CLAWDTIME_LIVE_PRESENTATION_ENABLED` remains false by default; staging
matched artifacts does not establish physical remote acceptance.

The experimental preview-only persistent stream's `SCStreamErrorDomain -3805`
application-connection interruption remains unexplained. Snapshot success is not
reported as a persistent-stream repair. Public macOS cooperative activation also
cannot guarantee that a target moves from another Space into view. No broader
capture fallback, forced Space change or automatic action replay is introduced.

## Default-off production activation relay

The separate `CLAWDTIME_NATIVE_ACTIVATION_ENABLED` media gate defaults off.
`POST /sessions/{mediaSession}/screen/native/prepare|dispatch` requires exact
backend-authorized envelope, currently applied native execution epoch and the
selected display camera. The callback
`/media/{mediaSession}/native-activation-authority` is bounded by the original
expiry; it cannot extend the native two-second dispatch deadline. No call, lease,
local Enable or fallback action is created by these routes.

Media retains `native_activation_receipts` in its existing SQLite ledger. Gateway
retains `native_activations` and fences the whole device during dispatch/uncertainty.
Both reserve before forwarding an effect, never retry on timeout, and preserve the
operation identity across duplicates, Stop and restart. Preparation of a retired
operation cannot overwrite its result. Read-only receipt reconciliation is
available after session removal and validates the retained fingerprint, host,
operation and original completion interval before clearing an uncertainty fence.
Media checks the authority callback before it marks a dispatch, so a refused
callback sends nothing and leaves the row prepared. When a receipt read finds no
gateway record (404) two seconds after the dispatch deadline, the dispatch was
never sent: the gateway records a dispatch before it forwards one and refuses one
after the deadline. Media then stores the row as `rejected` with reason
`native_not_dispatched`, which clears its fence.
The online encrypted media backup includes and validates the new optional table.

Gateway WSS permits only the fixed native prepare/dispatch POSTs and receipt GETs.
The helper independently validates its actual enabled lease/Stop policy at native
boundaries. Cloud approval alone is insufficient. Older media/helper versions do
not advertise the activation capability; old connector sessions cannot upgrade
silently. Keep admission disabled until matched components and physical walkthrough
acceptance have been recorded by the coordinating lead.

Ownership changes that arrive during a capture discard that frame and still wait
one existing source interval before the next request. The discarded capture
already consumed the helper's five-request/second slot; skipping pacing previously
caused a second request immediately after native release, provoking rate refusal
and terminal cleanup. A deterministic regression reproduced a roughly 0.06 ms gap
before the repair and verifies at least 190 ms afterward. Original frame timestamps
and freshness remain unchanged; no native effect is retried.

`screenDiagnostics.lastPollFailure` now reports a fixed stage/category and optional
HTTP status for failure after an awaited gateway result. It can distinguish
capture, header, dimensions, JPEG decode, camera metadata and camera acceptance
failures without exception text, image bytes or titles. Stages reset their status
before each request so a capture exception never inherits renewal's HTTP 200.
