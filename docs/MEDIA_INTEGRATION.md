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

The new controller uses the same private binding, voice, provider, LiveKit,
control and journal flags as the audio controller, plus `--presentation-file`:

```json
{
  "prepare": {"presentationId": "prepared-id", "manifest": "EXACT_MANIFEST_OBJECT", "grant": "EXACT_CAPTURE_GRANT_OBJECT", "fingerprint": "ROOT_CANONICAL_SHA256"},
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
  "prepare": {"presentationId": "prepared-id", "manifest": "EXACT_PREPARED_MANIFEST_OBJECT", "grant": "EXACT_LOCAL_GRANT_OBJECT", "fingerprint": "ROOT_CANONICAL_SHA256"},
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

For v2 calls, activation emits no generic “Sharing your screen…” announcement.
The first actual TTS message receives “Hey, this is your agent.” once, including
when a setup run suppresses its internal question and the coding agent speaks
later. Subsequent replies are read directly. Unknown playback is never retried.
The existing bounded attention-question dispatch remains once-only, without the
“Your agent asks” wrapper; legacy v1 retains a short greeting at activation.

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

V2 activation is silent; the first actual agent message carries the greeting.
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
