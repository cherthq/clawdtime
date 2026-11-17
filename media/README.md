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

For an explicitly authorized provider-only synthetic burst check, run
`media/.venv/bin/python media/elevenlabs_burst_probe.py --seconds 30` with the
dedicated agent's `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` already supplied
privately in the environment. It creates one provider conversation and sends a
fixed synthetic folder question; this can use provider credits. It uses the actual
frontend with a paced 20 ms memory-only consumer, refuses backend effects and
never calls FaceTime, connects to LiveKit, captures a microphone/screen, plays
audio or saves provider content. Output contains only bounded counts, event
shape/size metadata and allowlisted failure codes. `--legacy-bound` reproduces the
old queue bounds in that probe process. On macOS Python installations missing a
default CA file, set `SSL_CERT_FILE` to a trusted CA bundle (for example the path
returned by `media/.venv/bin/python -m certifi`); never disable TLS verification.

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

Camera commands may additionally carry the observed `contentRevision`. This lets
a recently observed frame remain a presentation reference when a newer frame has
identical content and geometry. The camera retains at most 32 metadata-only frame
references, each younger than two seconds by capture time and monotonic residence.
Content/geometry changes, even changing away and back, and lifecycle clearing
invalidate targeting history. Only `clear` and `overview` may use a recent known
reference across content-only changes: its supplied content revision must match
the actual observed frame, its geometry/source must still match, and the current
source and presentation revision must remain valid. These operations remove marks
or return to the authorized overview; they never use an old target rectangle.
Their geometry-only index shares the same maximum 32 metadata records, retains
original ages, and clears on geometry/source/lifecycle changes. Overlay Clear
retains only the current source reference. Omitting the field preserves exact-current-frame behavior;
paused views and input coordinate mapping retain their strict existing references.
The optional field participates in command idempotency, and never permits a retry
or automatically substitutes a different target.

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

### Local selected-display stream and cadence measurements

An explicit `displayStream: true` in preview stdin configuration, or CLI
`--display-stream`, opts an **actual display** into one persistent development
capture process. Window selection refuses this option. Existing actual-window
snapshot capture and production helper/media defaults remain unchanged.

```sh
swift build --package-path mac
media/.venv/bin/python media/camera_preview.py --mode actual --display-stream \
  --surface '{"kind":"display","id":"EXACT_DISPLAY_ID","displayId":123}'
```

Replace both IDs with the same explicitly selected display returned by metadata
discovery. This selection exposes all visible content on that display; it never
widens a previous window selection. Capture remains off until local Start. Keep
the preview browser on a different display or hidden to avoid recapturing its own
output; the native Stop/preview Stop controls must remain reachable.

The local targets are `sourceFps:15` and `renderFps:30` (CLI `--source-fps` and
`--render-fps`). They are caps/targets, **not measured achieved rates**. Source
requests still traverse the real local gateway/controller and its authorization
checks; encoding, polling and rendering costs reduce throughput. Local source
cadence is bounded to 1–15, browser rendering to 1–30. Production defaults retain
five source requests/second and 15-fps camera output. The browser image fetch loop
is independent of metadata/control polling, with only one image request in flight.
Local rendering/JPEG encoding uses one worker with a detached presentation
snapshot and immutable source reference, keeping capture/Stop handling responsive.
Concurrent render requests are refused rather than queued; cancellation holds the
slot until its worker finishes. Stop, policy expiry, source age, authority generation
and presentation revision are rechecked before returning bytes. No late worker
result can restore a stopped or changed presentation. Production rendering remains
synchronous with the same resampling and pixels.

Authenticated `GET /preview/metrics` reports only counts/timings: source distinct
delivered frames and elapsed rate, mean pipe-read latency, current original source
age, image render count/rate and mean render cost. Rendered images count HTTP
responses generated, not browser paints or handset frames. Distinct delivered
source frames are not native callback counts. Static scenes may have low distinct
cadence while their same-display screenshot refreshes remain fresh. No pixels,
window names, text, tokens or audio enter these metrics.

Native transport retains one timestamped source sample and bounded pipes; idle
samples are never restamped. Stop immediately clears local presentation, retires
the child, and sends one existing authenticated `screen-stopped` callback to an
associated local backend. Its receipt distinguishes acknowledged/unknown callback
outcomes; unknown notifications are not retried. An acknowledged callback lets the
backend close broker ownership as well as preview capture. Native input remains separately coordinated and actual
preview fallback input stays unavailable.

Isolated coverage (no screen capture or native input):

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_preview_stream.py'
media/.venv/bin/python -m unittest discover -s media -p 'test_display_preview.py'
media/.venv/bin/python -m unittest discover -s media -p 'test_camera_preview.py'
swift test --package-path mac
```

### Explicit local native activation rehearsal

`nativePresentation:true` is a separate preview capability, requiring actual
selected-display capture, `nativeControl:true`, an authenticated literal-loopback
backend, a distinct backend-only `nativePresentationToken`, and an absolute
`nativeReceiptPath` in an existing owner-only directory. The receipt file is
owner-only and persists after preview cleanup. This does not enable production
fallback input. Click/type/scroll are not exposed by this capability.

The browser can read `/preview/native/status` and submit only a prepared operation
ID to `/preview/native/execute`. The backend prepares and journals the immutable
operation; `/sessions/:id/native/qualify`, `/execute` and `/receipts/:operationId`
require the separate host credential and reject browser Origin headers. The host
checks its own live camera/Stop and exact native selection before and after asking
the broker for scoped authority. The inherited native pipe consumes a fresh exact
target token once for activation or AXRaise. Each effect has a durable reservation
before pipe dispatch. Duplicate requests return the existing result; timeout,
cancellation, stopped capture and uncertain completion never cause retries.

Receipts distinguish rejected, returned, verified and uncertain results. A verified
result requires independent app-active, exact-window-focused and on-screen evidence;
activation's return value alone is insufficient. Unknown native results do not carry
terminal evidence. This mode neither grants screen permissions nor circumvents
native tool target restrictions. Physical acceptance must be led through the
prepared-operation browser control, with capture and exclusive native ownership
still valid; unit tests do not establish OS foregrounding success.

For selected-display refusals, `/preview/metrics` may additionally expose
`source.failureDiagnostic.authorityStage`: fixed session availability, permission,
or local-stream lifecycle categories. Unknown values and raw native messages are
not forwarded. A metadata-only local status check describes its observation time;
it cannot establish that an earlier transient refusal did not occur.

### Prepared live framing and annotations

The local backend-only `/sessions/:id/native/present` route accepts a complete
prepared scene presentation, its broker-bound fingerprint, a window-relative focus
rectangle and optional annotation. It generates camera frame references internally.
Authority requires owner-none/idle, exact current session/lease/epoch/cursor/display
and the current immutable prepared scene. The original camera command and input
reference rules remain unchanged. A persistent metadata-only receipt reserves each
command before work; duplicate IDs return their original outcome, including unknown
outcomes, without reapplying presentation or extending its lifetime.

Two read-only target observations bracket the selected source frame's original
capture timestamp and must agree on exact window, process lifetime and geometry.
The final authority check and staged focus/annotation transaction run under the
source frame lock. Pin/paused state, stale frames or any failed command refuse the
whole transaction. Metadata is copied for staging; source pixels remain immutable
and are not duplicated or retained in receipts.

Only this new target-bound presentation may survive content-only frame changes.
Its read-only monitor rechecks target identity, foreground/focus/on-screen state.
The last successful backend authorization may initiate another read only while
its original absolute expiry and exact command/fingerprint binding remain valid.
A fresh backend authorization after that read is mandatory before renewing the
target witness. Rendering requires a successful
witness no older than 250 ms using its original observation time, not reply time.
Movement, lost focus/authority, monitor failure, Stop or the monotonic three-second
lifetime clears both focus/motion and marks and increments camera revision, so a
late rendered snapshot cannot publish old targeting. It never re-anchors or retries
an expired presentation. Ordinary marks retain their content-change invalidation.

This is bounded observational evidence: a transient move away and back between
metadata observations may go undetected. It does not establish atomic OS geometry
or create input authority. Physical zoom/annotation walkthrough acceptance is
separate from the previously qualified activation-only current-display rehearsal.

### Gated production target presentation

`CLAWDTIME_LIVE_PRESENTATION_ENABLED=false` is the default. Matched backend,
media, gateway and helper sources add a read-only lease-bound resolver and
prepared zoom/annotation transactions. They use the existing selected-display
snapshot source (five requests/second ceiling, 15 fps media publication), not the
experimental preview stream. The production routes never activate apps or send
OS input; the original chat's separately owned native tools retain that job.

The helper capability `livePresentationVersion: 1` passes through readiness only
for an authorized attached display; media strips it when the gate is off. Initial
qualification rechecks backend authority before and after remote metadata. A
presentation brackets its current captured frame with matching native witnesses,
then commits focus/marks together. Original timestamps and the 150 ms final
callback, 200 ms monitor, 250 ms render-witness and three-second overlay budgets
are unchanged over the network. Delay/skew/Stop/ownership or window changes
refuse or clear the presentation; no restamping, re-anchoring or automatic retry.
An undetected move away and back between observations remains an explicit limit.

Namespaced `presentation_receipts` persist metadata/hash-only accepted, rejected
and uncertain outcomes in the existing media SQLite ledger, including across
Stop/restart. The encrypted online backup copies the entire SQLite database;
its verifier recognizes this optional table while retaining old-backup
compatibility. Unknown receipts are never deleted or replayed during upgrade.
Remote timing and outgoing-call video remain unqualified; keep the gate off until
matched artifacts and physical remote acceptance are recorded.

#### Cloud timing checks without a call

The monitor now avoids one redundant backend round trip by using its prior
unexpired authorization solely for the next read-only resolver request. Local
Stop/lease checks run before and after the remote read, the helper checks its
current lease, and a fresh backend callback after the observation still gates
every renewal. The initial transaction still performs both backend checks. No
timestamp is rewritten, expiry extended, or timed-out operation retried.

For backend callback RTT `B` and resolver RTT `R`, a monitor cycle needs roughly
`R + B < 200 ms` (previously `R + 2B`). The resolver itself must finish within
180 ms. Sustained targeting also requires that the preceding original witness
remain under 250 ms when the next renewal arrives. With symmetric resolver
transport, the approximate steady-state bound is `1.5R + 2B < 250 ms`, including
the previous resolver return leg and backend callback. Processing, scheduling,
asymmetric transport and clock offset consume additional margin. These formulas
are planning bounds, never substituted for the runtime freshness checks.

`test_presentation_timing.py` models outbound and return delay separately while
preserving the helper's original timestamp. A synthetic 90 ms callback / 30 ms
resolver sustains targeting after the optimization; the previous sequence would
exceed 200 ms. A 90/60 ms pair still clears because the original witness expires,
even though its individual monitor cycle fits. A 130/90 ms pair clears on the
200 ms cycle limit. Tests also retain the 150 ms final callback cutoff, reject
expired/wrong cached bindings before remote reads, and verify revocation and Stop
during an awaited read with no replay or receipt rewrite.

Authenticated media session status includes bounded
`screenDiagnostics.lastPresentationResult` and `lastPresentationFailure`: only a
fixed stage, timestamp, duration and optional `timeout`, `cancelled` or `refused`
category. This distinguishes final-callback failures from monitor-budget failures
without storing labels, window metadata, payloads or upstream exception text.

With the gate off and helper disarmed, the lead can time existing authenticated
health/readiness requests and inspect existing relay diagnostics without opening
a call or requesting a capture. Such measurements are transport proxies: readiness
includes different helper reads and cannot certify the resolver, active lease,
source frame, monitor or outgoing video. The actual resolve/presentation endpoints
require the existing authorized viewing session and current selected-display
lease; never manufacture one or widen freshness merely to produce a timing result.

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_presentation_timing.py'
```

### Production native activation

The new `CLAWDTIME_NATIVE_ACTIVATION_ENABLED` gate defaults off and is independent
of presentation. The production routes use the installed helper's real policy and
durable native ledger; they do not call the preview native controller. Preparation
is read-only, dispatch has one original two-second authority interval, and receipts
remain available after Stop/restart. See `docs/DEVICE.md` and
`docs/MEDIA_INTEGRATION.md` for the full envelope, local Stop and recovery boundary.

```sh
media/.venv/bin/python -m unittest discover -s media -p 'test_native_activation.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_native_activation.py'
swift test --package-path mac
```
