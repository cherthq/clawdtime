# Media presentation and isolated checks

The descriptions below cover the legacy/default path. New source also includes
an optional same-chat ElevenLabs frontend, asynchronous GPT-Live frontend and separate text-only control grants;
[read the qualification status](../docs/MEDIA_INTEGRATION.md#asynchronous-conversation-frontend-november-13-source)
before enabling either feature.

For the Argos-style streaming voice owner that preserves the **current coding
chat**, see [same-chat ElevenLabs integration](../docs/MEDIA_INTEGRATION.md#same-chat-elevenlabs-streaming-frontend).
The existing GPT-Live frontend remains a separately selected managed-executor path.
Neither frontend is enabled by default, and a negotiated frontend never silently
falls back to legacy speech.

Build a reviewable **new dedicated agent** configuration locally (no provider
request, environment/credential access, call, microphone or screen capture):

```sh
media/.venv/bin/python media/elevenlabs_agent_config.py --voice-id YOUR_EXPLICIT_VOICE_ID > /tmp/clawdtime-elevenlabs-agent.json
media/.venv/bin/python -m unittest discover -s media -p 'test_elevenlabs_frontend.py'
```

The builder validates its seven client tools, Gemini 2.5 Flash / Eleven Flash v2,
16 kHz PCM, authenticated access, prompt overrides and disabled recording/retention.
It does not create an agent or change the existing Argos lab agent. The focused
test suite uses synthetic credentials, a loopback WebSocket and fake backend;
it does not contact ElevenLabs, LiveKit or Chert. The adapter uses the existing
pinned `aiohttp` and `livekit` dependencies; no optional SDK install is required.

The existing compositor displays ephemeral human captions and one spoken reply per
turn. “Backend accepted” means the media callback was accepted; “Received by agent”
requires the coding session's acknowledgment. Visual-only activity, native approval,
and reported/unverified/unresolved outcomes use authenticated panel metadata. They
never dispatch speech, input, Messages, or call cleanup.

Activity version 1 requires the latest fresh policy's exact presentation binding
(session, call, member, device, display). Unsupported or malformed optional activity
is ignored; unknown fields are stripped. At most 20 summaries of 160 Unicode code
points and 640 UTF-8 bytes are accepted. The JSON request envelope is bounded to 64 KiB (including escaped Unicode); field
limits remain unchanged. The outer panel freshness lasts at most five
seconds. Repeated identical metadata refreshes connection freshness only: it cannot
extend the fixed text expiry or restore cleared text. Outcome summaries last at most
60 seconds; ordinary summaries at most ten minutes. Policy loss, mute, Stop and
close clear transient content; no presentation text enters the media ledger.

The gateway advertises presentation support only when the helper reports version 1.
When forwarding to older helpers it strips optional presentation fields. Readiness
queries remain metadata-only, and never grant capture or input authority.

Speech diagnostics retain a 64-event allowlisted ring and bounded counters. A random
`processId` distinguishes monotonic clock scopes, with `generation` separating
capture resets. A backward monotonic clock or 24-hour elapsed-time bound starts
a fresh process scope instead of clamping durations. A segment's opaque `correlationId` is the first 24 hex characters of
SHA-256 over `mediaSessionId + ':' + segmentId`; reply playback uses the utterance
ID instead. UTC observations establish cross-process order, not precise latency.
No transcripts, audio, error bodies, phone numbers or paths are accepted by the new
fields.

Run isolated checks from the repository root:

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
media/.venv/bin/python media/preview_activity.py /tmp/clawdtime-phone-preview
```

The preview writes only synthetic portrait/landscape PNGs with light/dark desktop
backgrounds. It does not import a server, read installed configuration, access a
microphone/screen, or connect to a service. Keep generated images outside Git.
Review the generated contact sheet and full landscape images for readability.
Physical handset readability, audio timing, barge-in, real native input, and cleanup
remain separate acceptance work. Half-duplex remains the default. Experimental v2
continuous listening requires `MEDIA_TWO_WAY_VOICE_ENABLED=true`, negotiated
`voiceInteractionVersion:1`, backend `voiceMode:"two_way"`, and explicitly qualified
`remoteAudioIsolated:true`. See [media integration](../docs/MEDIA_INTEGRATION.md)
for interruption, revision, measurement semantics and the physical echo gate.

Optional asynchronous GPT-Live and text-only local grants are implemented behind
separate default-off gates. See [the source integration and explicit blockers](../docs/MEDIA_INTEGRATION.md#asynchronous-conversation-frontend-november-13-source).
Install `requirements-live.txt` only in an isolated qualification environment first;
`test_live_sdk.py` otherwise skips honestly. No key or provider session is needed
for the loopback SDK compatibility fixture. This is not physical audio acceptance.

Reproduce the optional SDK compatibility check in a disposable environment (the
running service environment and protected configuration are not used):

```sh
media/.venv/bin/python -m venv /tmp/clawdtime-livekit-qualification
/tmp/clawdtime-livekit-qualification/bin/python -m pip install -r media/requirements.txt -r media/requirements-live.txt
PYTHONPATH=media /tmp/clawdtime-livekit-qualification/bin/python -m unittest media/test_live_sdk.py
PYTHONPATH=media /tmp/clawdtime-livekit-qualification/bin/python -m unittest media/test_probe_live.py
```

The test uses a local WebSocket fixture and a synthetic credential; it verifies
actual client-mode session startup and input PCM transmission through the pinned
SDK. It does not contact OpenAI, dial a phone, record audio, or qualify production.
The qualified optional dependency set is Agents/OpenAI plugin 1.8.12, OpenAI SDK
3.50.0, LiveKit RTC 1.2.1/API 1.2.2 and aiohttp 3.14.5.

`probe_live.py` is a separate, no-handset provider access check. The lead injects
the protected `OPENAI_API_KEY` into its process environment, then runs:

```sh
PYTHONPATH=media /tmp/clawdtime-livekit-qualification/bin/python media/probe_live.py
```

The qualification environment already used on this development host is
`/tmp/clawdtime-livekit-venv/bin/python`; the commands above create a fresh one.
The probe additionally uses pinned `websockets==15.0.1` from `requirements-live.txt`
for the OpenAI SDK's public Live connection API. It uses one connection attempt,
client delegation and `store:false`, with no input audio, tools, transcript or
execution callback. It waits up to 12 seconds for actual `session.started`, then
up to 3 seconds for `session.closed`, and always attempts bounded transport cleanup.
HTTP and WebSocket retries are both zero. The official WSS connection uses an explicit verified TLS context
from certifi's CA bundle, retaining hostname and certificate validation without
changing the machine's trust store; plain HTTP is allowed only for synthetic
loopback fixtures. SDK logs and exception bodies are
suppressed; output contains only bounded metadata, safe error code/field identifiers,
connection stage, exception class names, numeric HTTP/TLS/OS codes and timing.
An unconfirmed close is not success and must not be blindly retried.
Exit zero / `ready_for_audio_test:true` establishes only successful credential and
model session startup plus confirmed closure. It grants no call authority and does
not establish handset readiness, conversational execution, audibility, echo
isolation or interruption latency. Actual credentials and calls remain lead-only.

The separate default-off acoustic qualification frontend is documented in
[media integration](../docs/MEDIA_INTEGRATION.md#execution-disabled-acoustic-qualification).
It cannot execute tasks and permits one local interruption measurement per call;
output remains latched off afterward. Add `--audio-qualification` to the probe
command above to check its exact startup configuration without input audio or
playback (lead-managed credentials only).

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_acoustic.py'
PYTHONPATH=media /tmp/clawdtime-livekit-venv/bin/python -m unittest media/test_acoustic.py media/test_acoustic_sdk.py media/test_probe_live.py
```

The SDK fixture uses loopback, synthetic credentials and synthetic PCM only. No
phone, real model session, screen, microphone or execution agent is accessed.

## General screen camera (Argos local slice)

`CLAWDTIME_SCREEN_CAMERA_ENABLED=true` is an independent, default-off media gate.
An opted-in protocol-2 session must select an exact `screenCamera` surface and the
helper must advertise `cameraVersion:1`. Camera-aware media sends
`X-ClawdTime-Camera:1` on backend policy requests. Old media receives no selection
for camera sessions; it cannot accidentally widen a selected window to a display.
Old sessions retain their existing capture and 5 fps publication. Camera-enabled
publication renders at 15 fps while the existing source capture remains bounded
to 5 fps; animation smoothness is separate from app-video playback qualification.

The existing `ScreenController` owns one ephemeral `ScreenCamera`. Native pixels
(up to 8192 per axis, 32 million pixels, 2 MiB JPEG) survive helper/gateway relay
before cropping and final output resize. Oversized native captures fail explicitly;
select a smaller window. Window IDs include the process ID and exact display.
Closed/minimized windows, windows intersecting another display, changed owners, screen changes,
lock, stale policy/frame, Stop, release and disconnect clear presentation. Resizing
or moving within the display invalidates geometry and annotations. There is no
silent whole-display fallback and no IDE extension requirement.

The authenticated `GET/POST /sessions/:id/screen/camera` shares the contracts in
`src/camera-contracts.ts`. Mutations need the exact source frame, geometry generation,
presentation revision and stable command ID. Commands support focus, smooth zoom,
overview, pin/unpin, freeze/resume, annotation upsert/remove/clear and context.
Limits: 20 accepted updates/second, 16 marks, 160-character labels, TTL 100–10000 ms,
256 recent idempotent receipts. Monotonic revision rejects evicted old commands.
Duplicate receipts cannot revive expired marks. Any source-content hash change
clears annotations conservatively; pinning holds coordinates, not semantic tracking.
Frozen pixels remain only while ongoing capture and viewing authorization are fresh.

`/screen/frame` remains pristine. Optional action `presentation` references map
output coordinates through pixel-quantized crop and letterbox back to source
coordinates. Moving/frozen/consumed/stale frames refuse input; commands and input
share the existing frame lock. Existing executor ownership, receipts and local Stop
remain mandatory. **Selected-window fallback input is intentionally refused** at
the helper because independent window capture can show content beneath another app;
exact native hit-target qualification remains pending. Display fallback retains the
existing click/type/scroll path. No camera command submits input.

Local preview, without credentials or calls:

```sh
media/.venv/bin/python media/camera_preview.py
media/.venv/bin/python media/preview_camera_images.py /tmp/clawdtime-argos-camera-review
```

Open the printed token-fragment URL. The UI removes the token from the address bar
and keeps it only in this browser tab's `sessionStorage`, so reloading the same tab
continues the authorized preview. The stored credential expires no later than the
server's fixed preview deadline (at most 15 minutes); reload cannot renew it.
A new URL fragment takes precedence over any stored credential. Stop, rejected
authentication or expiry clears the tab credential, removes displayed pixels and
halts polling. Missing access shows instructions to reopen the full printed URL;
it never starts capture or repeats unauthorized requests. No localStorage or cookie
is used. Closing the tab removes its session storage. The preview expires after
15 minutes and binds only to literal loopback. Synthetic coding/Finder/timeline are clearly labeled
fixtures. It exercises the real Gateway, ScreenController, compositor and camera
HTTP handlers with an isolated temporary ledger. Input tests terminate in a fake
sink. The backend/connector-integrated entry point is `npm run preview:camera`;
its smoke command is documented in the Argos review report.

For explicitly selected actual capture, build the development helper, list surface
IDs (metadata only), then pass one exact object returned by that command:

```sh
swift build --package-path mac
mac/.build/debug/ClawdTimeCompanion --camera-list
media/.venv/bin/python media/camera_preview.py --mode actual \
  --surface '{"kind":"window","id":"SELECTED_ID","displayId":1,"ownerPid":123}'
```

Replace all example IDs with the selected disposable window's metadata. Press
**Start sharing** locally; Stop is always visible and cannot resume the
retired preview selection. Start a new preview process after Stop. Missing Screen
Recording permission is reported without prompting/resetting TCC. Actual mode has
no OS input route and retains no captures. The development binary reads no installed
configuration and does not restart or replace any installed service. Only synthetic
images may be exported with the image-rendering command above. These commands do
not establish real IDE/Finder/video-editor or handset acceptance by themselves.

The actual preview labels **Actual window sharing** (or display sharing), shows the
selected source label (identity and receipts are in collapsed Diagnostics), and leaves capture off until **Start sharing**. It hides synthetic
fixture selection and fake-input controls; actual-mode requests to the fake-input
endpoint are refused. Focus and annotations enable only after a fresh selected
frame arrives. A lost selected window reports its bounded capture reason, clears
the image and requires a fresh preview session; it never switches to another window
or to the full display. Start requires the window wholly within the chosen display;
afterward the exact window may be occluded or off-screen while that display remains
active, provided it does not intersect another display. Window metadata describes
the whole window; the selected display is an anchor, not a crop. Display-source
metadata retains containment, and window OS input stays disabled. A geometry
change during capture clears pixels and annotations and retries only a fresh capture
of the same selection under unchanged Stop/expiry gates. The metadata-only native lookup/inspect commands in the Mac README
help diagnose Spaces, window placement and geometry without saving screenshots.

Window translation alone preserves normalized zoom and its in-progress easing when
native/point dimensions and selected-display metadata remain unchanged. Current
geometry generation and revision still advance; marks/context are cleared and old
input references are rejected. A frozen view keeps its original pixels and frame
identity until Resume; actual resize or display-geometry change resets presentation.
Paused preview controls offer Resume and Clear only. Camera command failures remain
visible separately from live status, and an earlier receipt is cleared before each
new command so it cannot be mistaken for the new command's result.

The isolated native-review harness may set `nativeControl: true` in its stdin
configuration only with actual selected-surface capture and an authenticated
literal-loopback backend. Its readiness then advertises `agent_tools_only` and
native-control eligibility to that local broker; it does not qualify an arbitrary
agent host. The default actual preview remains `view_only`. Native review retains
`inputSink: none`: every actual-preview fallback action is refused before a receipt
is created, and fake-click routes remain unavailable. Capture still needs Start or
the launcher's explicit capture opt-in; native capability alone never starts it.
Stop removes control eligibility. The original agent's native tools must obtain
exclusive broker ownership, observe the exact window through their own fresh native
state, perform one authorized action, verify the UI separately, and release ownership.
No installed helper/service configuration or FaceTime line is changed by this mode.
