# IMPLEMENTATION_ARGOS review

## November 17, 2026 — first streaming-voice call and audio correction

One newly authorized demo call reached the phone; the user reported that it hung
up. Backend diagnostics record a media `capture_loop` task failure shortly after
the first ElevenLabs response audio began. This category covers voice ingress and
frontend tasks; it is not evidence that Finder capture failed. Seven fresh Finder
frames reached media and 212 video frames were emitted before cleanup. Handset
screen visibility was not confirmed. Call ended, view lease released, services
idle with no pending/unknown effects; local sharing was stopped. No redial occurred.

A provider-only synthetic probe reproduced a concrete defect: a valid 79,882-byte
PCM chunk (106,512 base64 characters, about 2.5 seconds) exceeded the old per-event
limit. The old two-second total queue was also too small for normal faster-than-
playback synthesis. Updated handling accepts bounded ten-second events with a
512 KiB WebSocket envelope and a twenty-second queued PCM budget, includes the
in-flight chunk in accounting, and keeps interruption/Stop independent of the
queue. Oversized/invalid data still fails closed. New fault diagnostics expose
only allowlisted stage/code/count metadata, never exception text or audio.

The corrected real-provider synthetic probe completed in 26,511 ms with 216 paced
frames, a valid 82,304-byte audio chunk, no failure and empty queues after Stop.
No phone call, microphone, speaker playback or backend tool effect was used.
Independent review and 45 focused frontend tests passed. The complete media suite
passed 376 tests (13 optional SDK tests skipped) in 52.206 seconds. The original production
exception was generic, so this reproduction identifies a real compatibility bug,
not forensic proof that it was the only cause of the hang-up. Physical acceptance
and the prepared zoom/annotation walkthrough remain incomplete.

The correction is committed/pushed as `0a1424a` and deployed to media as
`9106feea-eb70-4058-b5cf-58ba56bbaf59` (SUCCESS). Running frontend SHA-256
`0c3049b639ad7ff3df8fad3a74e2a55a836b81a83d97102bf14dd6f4fff61b37`
exactly matches tested source. Voice readiness reports configured, agent validated,
and ready. All seven existing media ledger tables match the same-volume pre-deploy
snapshot; environment values are unchanged. Both services are idle. Backend,
Mac installation, line assignment and provider software remain unchanged.

An initial deployment upload incorrectly selected the root backend Dockerfile.
Deployment `5faa0936-73d3-4745-91d9-3d733255a27b` was canceled and confirmed
REMOVED while the previous media deployment remained SUCCESS and healthy. The
successful deployment used the frozen commit's `media/` directory as its root.
No additional call was placed; a newly authorized handset test remains next.


## Demo preflight completed — November 17, 2026

Both previously recorded verification gaps are resolved. Read-only production
metadata confirms the new dedicated project has no recipient-verification policy;
no code exchange or verification bypass is needed. Worker release manifest,
installed executable and exact-line heartbeat agree on `97823a1…` from clean
`5d70b571…`. Independent review confirms the previously qualified process-isolation
source remains unchanged. No provider software was modified or reinstalled.

Configuration-only backend deployment `ae254fac-7cb2-4af3-b160-5d074f91ce32` enables
duplex and remote-isolation assertions. Exact line resumed, inbound reject policy
preserved. Fresh same-chat ElevenLabs session selects only the harmless Finder
window and preserves native input ownership. Companion restarted using the existing
paired configuration to load its already-authorized controller membership; no
permission expansion, configuration rewrite or pairing replacement occurred.

At this checkpoint the only failing readiness check is local Enable. The user was
asked to enable locally after computer-use actions yielded to their interaction.
No new call has been placed yet; physical latency, screen arrival, prepared zooms,
annotations and interruption still require the upcoming supervised demo.


## New-project connection verified — November 17, 2026

The requested **Clawdtime** project now owns line ending 9741, and the ClawdTime
backend uses that project's credential. Configuration-only deployment
`5248f2f4-a38a-48d7-85a1-179902292d29` succeeded at 14:45 UTC using the existing
backend image. Only the Calls `projectId` and `projectKey` changed. This supersedes
the old-project visibility blocker recorded below; it does not establish call readiness.

The lead retained a same-volume database/configuration snapshot, staged one environment
variable, and verified the running process received the intended configuration.
Entities, events, effects, messaging cursor, receipts and unknown-outcome metadata
match the snapshot. Native identity and event-anchor checks pass. Media configuration,
Mac pairing and native messaging credentials were unchanged. Both services are idle;
the connected Mac is disarmed with effective screen/control permissions and no lease
or unresolved input. No application code changed, so verification used deployed
configuration/state comparisons and GET-only readiness checks rather than rerunning
unrelated unit suites.

The exact line session acknowledges assignment generation 8, declares media readiness
and has a fresh confirmed heartbeat. Calls remain paused. Fourteen of fifteen
transport preflight checks pass; `calls_worker` remains failed because the paused
line is not available. ElevenLabs agent configuration readiness passes independently.

The team's independent review identified two remaining checks before physical testing:

- Recipient verification is project/assignment-bound. Prior HackPton verification
  cannot be presumed valid in the new project. Current line UI omits the documented
  recipient-verification card, and no safe public call-admission dry-run is available.
  Do not probe by attempting a call or reset existing records to work around this.
- Current worker binary `97823a1da14c605b8f78c2f9330192b0c0014e1d0ab0cedd262ac8f4e245e6de`
  is not the previously qualified isolation build. Reviewed audio source remains
  unchanged, but exact binary-to-source provenance and current route selection must
  be established before enabling backend duplex/remote-isolation assertions. They
  remain false; provider software was not modified.

Next acceptance remains a fresh explicit same-chat ElevenLabs session, deliberate
line activation and a separately authorized call measuring audio latency, screen
arrival, prepared zoom/annotations and response-to-continuation. No new call or
message was placed in this continuation. Existing records and other lines are intact.


## Authorized dedicated voice rollout — November 17, 2026

The user authorized provider configuration and ClawdTime deployment for 9741,
without changing the assignment or existing records and without another FaceTime
call. This section supersedes earlier statements that build 6 was local-only.

### Changes and deployed evidence

Provider creation first received a definitive HTTP 422 for missing string-parameter
descriptions. The rejected intent/response was retained privately, a fresh agent
inventory confirmed no matching creation, and the corrected request created one
new dedicated agent. The existing Argos lab agent was read only and unchanged.
The dedicated agent has exactly seven client tools, authenticated connections,
Gemini 2.5 Flash / Eleven Flash v2, 16 kHz PCM, no provider queueing, recording off
and zero-day retention. No conversation, signed session URL, WebSocket or call was
created as part of configuration validation.

Compatibility correction `89e6816` accepts only inert empty workflow metadata,
rejects active workflows/MCP/procedures, compares inline and resolved tool schemas,
and provides required parameter descriptions. A deployed GET-only preflight then
exposed partial HTTP chunk parsing. Correction `f4ffe03` accumulates through EOF
under the existing timeout and 128 KiB cap; three real loopback HTTP regressions
cover split JSON strings, invalid trailing content and fragmented overflow.

- Backend deployment: `79f6575c-0676-45a4-9c61-4be251d860a8`, SUCCESS,
  source `89e6816` (backend source unchanged by the subsequent media-only fix).
- Final media deployment: `c3ad1969-28f7-4376-bba5-48db57296512`, SUCCESS,
  source `f4ffe03`; supersedes the first media deployment `198a52fe-7d66-434b-b8a9-096fbab3282f`.
- Authenticated production `/voice/elevenlabs/readiness` returned
  `configured:true, agentValidated:true, ready:true` at 13:36 UTC. This validates
  configuration, not physical latency, duplex interruption or handset playback.
- Companion build 6 installed at the existing stable application path, hash
  `924621661e8d441a4dbe836070f7fd3c695f402deb296f82a055878088b0acfa`.
  Prior app/state/plist backed up privately; gateway uses its existing arguments.
  Explicit custom helper configuration preserved. Only ClawdTime's stale
  Screen Recording/Accessibility approvals and app registration were refreshed;
  no global TCC reset. Both effective permissions true, armed false, no lease,
  unresolved inputs zero. Existing 37 observed/4 unverified historical outcomes
  were retained, not replayed or reclassified.

### Preservation and limits

Backend entities, events and effects were compared against the same-volume
pre-rollout SQLite snapshot and are identical. Retained cursor/receipt/unknown
metadata matches. Media sessions, speech, device_actions, screen_diagnostics,
lifecycle_diagnostics, text_leases and text_actions all match their snapshot.
Live line configuration and local helper/gateway/pairing configuration are
byte-identical. Existing databases/encryption material, credentials, line assignment,
provider software and shared lines were not replaced. Operational readiness caches
may refresh normally; no business event or external effect was created.

Both services are healthy/idle, gateway connected, active calls/media zero,
pending/unknown effects zero. Backend ElevenLabs selection is enabled, but backend
**two-way voice and remote-audio-isolation assertions remain false**: a fresh GET of
Chert's project-scoped Calls inventory returns HTTP 200 with `total:0` for the saved
HackPton project. The existing dashboard session, after refreshing sign-in, reports
platform-admin access required. Therefore current 9741 assignment/worker/session
and qualified build cannot be freshly verified. Historical digital-isolation
qualification alone cannot authorize a newly invisible route. Nothing was reassigned
or granted to work around this. Resolve project visibility for the existing binding,
then verify fresh exact identity, accepting heartbeat and qualified process-isolated
build before enabling duplex. Physical audio/zoom/annotation acceptance still needs
a separately authorized call and fresh explicit same-chat ElevenLabs session.

Local validation for these rollout fixes: 40 focused ElevenLabs tests passed;
the final full media suite ran 371 tests in 48.748 seconds: **358 passed and 13
optional SDK skips**, no failures. Prior integrated release evidence remains 978 TypeScript tests, 59 Swift tests, 40 gateway tests and
the real Finder/local prepared-camera checks in the next section.

Private deployment intents/receipts and metadata evidence are retained under the
operator recovery directory, outside Git. Secrets, provider IDs, transcript data,
screens and audio are excluded from this review.

## Argos same-chat integration implemented locally — November 17, 2026

The user authorized pushing the existing checkpoint and using agent teams to finish
voice, prepared camera tools, and capture repair, with local testing first and **no
new FaceTime call**. Checkpoint `3e03421` was pushed to the existing remote
`ArgosClawd` branch. No codex branch was created. The following source changes are
the local implementation that replaces the earlier audit's missing pieces.

### Implemented path

- A fresh explicit `--voice-frontend elevenlabs` session selects streaming voice
  independently of `session.conversation`. The current coding chat remains the
  executor, with native CUA capability, ordered delivery, existing approvals and
  exclusive input ownership. Old runs cannot silently add/remove this selection.
- One ElevenLabs WebSocket owns speech. It streams 100 ms input chunks during
  output, clears output on interruption, sends exact observed human transcripts
  to this chat without a second task-planning model, and returns queue acceptance
  promptly. No auto-reconnect or effect retry is introduced.
- Verified progress is background context. Explicit coding replies trigger bounded
  application-report narration; synthetic report text cannot become a human task
  or tool authority. A context send does not prove playback: its speech receipt is
  deliberately `unknown`, not `completed`, and cannot be replayed.
- `prepare_voice_presentation` supplies transient task context and up to 12 labeled
  regions, bound to the selected lease, geometry and observed content revision.
  The voice model can focus/overview, annotate/clear and stop sharing. It cannot
  submit coordinates, select another surface, receive a session bearer, or execute
  OS input. Focus uses the existing smooth 450 ms transition; user pinning wins.
  Old pixels, geometry changes, expired preparation, wrong calls and Stop reject
  new presentation effects. Up to 512 durable camera event markers per call retain
  unknown outcomes without unbounded admission or retries.
- Stop-sharing removes the image and prepared targets while conversation/hangup
  remain available. The existing stronger local helper Stop behavior is preserved.
- Native capture waits for both start acknowledgment and the complete frame before
  stopping, and retains the stream through stop acknowledgment/deadline. This fixes
  the reproduced lifecycle race without introducing persistent capture or retries.
  Camera HTTP reads allow 3 seconds for bounded native cleanup; returned-frame
  freshness remains 2 seconds, and input/lease timeouts remain 1.5 seconds.
- Backend doctor, call admission and native transport validate the selected
  dedicated voice frontend before dialing. Media validates it again at activation.
  Default-off gates and legacy behavior remain unchanged for unselected sessions.

### Local acceptance evidence

- Actual harmless Finder capture: **76 consecutive frames in 30.128 seconds** in
  one process; no pixels saved. Earlier code failed after four frames.
- Actual Finder preview inspected visually through the browser; selected-window
  pixels were visible. Stop disabled presentation controls and removed the image.
  The disposable preview was then shut down, leaving no local test capture running.
- `npm run test:voice:camera`: same-chat preparation → authenticated voice route →
  real Python media compositor, using synthetic pixels. Focus settled in about
  **496–505 ms** including the designed 450 ms animation; annotation, overview, clear,
  duplicate suppression and Stop passed. This is local presentation timing, not
  speech or handset latency.
- Native build: 59 Swift tests passed; release build and strict signature check
  passed. Review artifact: `mac/build/ClawdTime Companion.app`, 0.4.0/build 6,
  executable SHA-256 `924621661e8d441a4dbe836070f7fd3c695f402deb296f82a055878088b0acfa`.
  The installed build was not replaced during this local verification.
- Full gateway regression: 40 tests passed, including a 1.6-second successful fresh
  camera fetch and rejection of a three-second-old frame.
- Final backend/connectors: `npm run check` passed **978 tests in 59 files**,
  typecheck and build, including pre-dial refusal and once-only initial task narration
  through the confirmed ElevenLabs owner.
- Full media regression: **366 tests run, including 13 expected skips** for optional
  GPT-Live/acoustic SDK qualification dependencies. All **35 ElevenLabs tests** ran
  and passed, including real loopback WebSocket framing, synthetic resampled audio
  while task acceptance is blocked, report-only narration, interruption, pre-dial
  configuration checks and no retries. No real provider connection was made.

### Before the next phone test

The local code is not yet a deployed or physically accepted Argos-equivalent phone
experience. No provider session was opened, microphone recorded, FaceTime call
placed, live service deployed, line reassigned, or sibling project modified here.
The earlier live services still run their prior release.

The existing lab agent has two synthetic camera tools and is intentionally **not**
reused or altered. A new dedicated agent must match the seven-tool contract,
Gemini 2.5 Flash / Eleven Flash v2, 16 kHz PCM, authenticated sessions, permitted
prompt override and zero recording/retention. A local, network-free configuration
builder is supplied in `media/elevenlabs_agent_config.py`; exact activation flags,
private credential names and validation are in `docs/MEDIA_INTEGRATION.md` under
“Same-chat ElevenLabs streaming frontend.” No provider key belongs in Git.

After this local review: configure that dedicated agent, deploy the reviewed
ClawdTime components and install build 6 preserving local configuration; register
one fresh same-chat voice/camera session and prepare its first stable targets.
Then obtain specific permission for the next phone test. Measure actual response
latency, barge-in, prepared zooms/annotations, sustained sharing and same-chat CUA.
Local fakes, provider configuration checks and published PCM cannot prove that
physical experience or acoustic isolation. IDE support remains optional.

## Post-checkpoint Argos experience audit — November 17, 2026

Checkpoint `1e5e140` commits all pending implementation and diagnostic work. The
user asked to commit first, then check and verify the experience. This follow-up
is a source comparison and local validation, not another deployment or phone call.
Three specialists independently reviewed Mac capture, connector ownership, and
voice/media integration. **Experience parity fails the audit.**

| Experience | Argos evidence | Current ClawdTime finding |
| --- | --- | --- |
| Responsive voice frontend | The accepted lab trial used ElevenLabs Conversation with Gemini 2.5 Flash / Eleven Flash v2 and streaming PCM. | The demo used finalized speech segments and separate replies from this chat. The planned ElevenLabs adapter is absent. |
| Voice while work proceeds | Original Argos execution bridge queues work and returns immediately, supplying results asynchronously. The phone lab did not qualify real coding execution. | Existing realtime GPT frontend is gated on an API-managed executor distinct from this chat. Enabling two-way audio alone cannot connect it to this chat's tools. |
| Prepared focus and overview | Lab tools directly select prepared synthetic camera regions. | Local general camera, transitions and annotations exist; the voice frontend has no camera tools or prepared target catalog. |
| Real application sharing | Argos lab was synthetic, not desktop capture. | Local Finder review passed, but the phone attempt failed after its first frame. Repeated native stream-stop failure is reproduced; diagnostics are not a fix. |
| Duplex/interruption quality | Concurrent audio exists in source; handset interruption quality was not separately confirmed. | The requested combined experience has no physical qualification. Unit tests do not establish perceived latency or visibility. |

Source anchors: integration plan section 5 already requires an ElevenLabs adapter;
`src/contracts.ts` defines `session.conversation` as `api_managed`;
`src/app.ts` requires that field and hardcodes `conversationFrontend: "gpt_live"`;
`media/conversational.py` defines no camera tools. The optional GPTLive work gate
also waits for 1,000 ms of quiet PCM and polls work every 500 ms. These are code
intervals, not measured phone response times, and that optional frontend was not
the one used in the failed demo. The coordinating chat's delayed polling/reply
also contributed to the slow interaction; provider/model choice is not the only
issue. No reliable end-of-speech-to-first-audio measurement was collected.

Read-only comparison used `/Users/garygao/argos-lab/README.md`, `create-agent.py`,
`media_trial.py`, and `source/escalation_mcp/voice/eleven_agent.py`. No sibling
project, provider configuration, credentials, or live call was changed by this
audit. The lab implementation is evidence of its own limited acceptance, not a
license to copy its transcript logging or editor-specific execution behavior.

Required corrective implementation:

1. Select a single streaming ElevenLabs voice frontend independently of the
   execution host on a fresh session. Keep this original chat as the executor;
   preserve ordered turns, native approvals, and exclusive CUA ownership.
2. Feed it bounded, current task/presentation context and geometry-bound prepared
   focus targets. Add presentation-only focus, overview and annotation tools
   through the existing authenticated camera controller. Reject stale targets,
   Stop, wrong call/surface, and duplicate effects. Never give it unrestricted
   desktop tools or a session bearer token.
3. Queue work promptly and deliver verified progress/results asynchronously, so
   the voice conversation does not wait on a coding-model/tool round trip. Keep
   one speech owner and clear both provider and media queues on interruption.
4. Fix and sustain-test native capture before another handset demo, preserving
   exact window identity, frame freshness, cleanup and local Stop.
5. Test the combined path locally: audio input during output, interruption,
   asynchronous same-chat handoff, voice-tool-to-rendered camera changes, stale
   context rejection and effect deduplication. Instrument user-speech-end to first
   audio and camera-command to first changed frame using comparable clock scopes.
   Then separately qualify the actual phone experience on one authorized call.

Validation at the checkpoint: `npm run check` passed again (950 tests in 58 files,
typecheck and build). The Mac specialist verified 55 Swift tests and a Swift build;
4 gateway camera tests passed. The prior reviewed release also passed 12 preview
tests. No tests establish Argos-equivalent handset behavior. The checkpoint is
committed locally, not pushed; the audit adds no runtime feature or flag change.

## First authorized 9741 camera call — November 17, 2026

The user authorized live activation and one Finder FaceTime demo, then explicitly
requested restoring their existing HackPton admin membership **persistently**.
The audited membership routine restored that exact account/project role; the
existing recipient verification became valid again. The line, assignment
generation, provider binary and other projects/lines were unchanged.

Backend live activation: `cc7e5656-802c-4d7e-90a9-c237db5e57f4` (SUCCESS).
The fresh database was initialized through the adapter's verified retained event
anchor before activation, without replaying earlier messages. The earlier no-camera
foreground bridge was closed cleanly; a fresh same-chat v2 bridge registered the
exact harmless Finder window and native desktop capability. Local Enable was
confirmed and every transport/device readiness check passed before requesting
one call with a stable idempotency key.

**Physical result: audio connected, screen sharing failed.** The human confirmed
they could hear the agent. Spoken turns arrived in this same coding chat; a spoken
reply completed playback according to its receipt. The camera emitted its first
frame, then the helper returned HTTP 503 and media correctly cleared the screen
and released the lease. The human reported no visible screen share. No zoom,
annotation or CUA handset acceptance was achieved. The attempt was explicitly
ended; provider reports ended, backend call ended and media closed. No redial.

A bounded local reproduction against the installed helper captured four frames,
then returned `Selected camera stream did not stop cleanly; frame discarded.` in
107 ms. The temporary view-only diagnostic lease was released; no OS input or
screenshots were saved. This is a native stream-stop failure, not a permission or
line-assignment problem. New diagnostic source changes preserve the primary error
and expose bounded categories; they are not yet a proven capture fix or installed
release. The gateway's separate 1.5-second timeout mismatch also needs review.

**Experience gap acknowledged:** the deployed demo used the older half-duplex
voice path. Realtime GPT voice and two-way voice flags remained disabled. The user
expects the Argos experience: a fast duplex voice model calling tools, prepared
camera movement/zoom/annotations, combined with ClawdTime's general cross-app
capture and CUA. This parity is not implemented/physically verified by the above
call. Agent-team source comparison follows the requested commit checkpoint;
corrective implementation remains outstanding; do not describe readiness as experience parity.

The user requested committing all current changes before that audit. Private
credentials, runtime databases, captured media and operational receipts stay out
of Git. No push was requested. Backend remains live on the same selected line;
no active call/capture remains. Additional calls require specific permission.


## Authorized deployment and fresh pairing — November 17, 2026

The user explicitly approved deploying ClawdTime and finishing Mac pairing.
The backend and media release is now deployed; **runtime remains standby** with
live traffic disabled. No setup-test notice, message, FaceTime call, capture lease
or OS input was submitted. The native provider upgrade remains withdrawn.
9741 remains in HackPton with assignment generation 4 and no competing connector;
no Chert provider software, line assignment or other shared line was changed.

- Backend: `41f8ee37-ab4b-4ded-b852-dae6f33c57e4`, SUCCESS, version 0.4.0.
- Media: `b8f97d2c-3871-42e4-afb5-d415745949ec`, SUCCESS, healthy,
  gateway connected, zero active sessions.
- Companion: 0.4.0/build 5 installed at the existing stable app path. Existing
  helper/gateway configuration, keys, receipt histories and control policy were
  preserved byte-for-byte; only the ClawdTime gateway was restarted.
- Fresh exact-line pairing claimed once with viewing/control permission. A new
  v2 foreground bridge in this same chat is registered and heartbeating;
  `connectionReady:true`, `liveReady:false` correctly reflects standby. Existing
  MCP configuration/runs were preserved and are not claimed to have hot-reloaded.

The fresh line uses a separate database and encryption key with explicit
`standard_once`. Old database/config pairs remain on the existing volume, with
an additional same-volume archive of the prior active database/configuration.
Old business entities, events and effects match the pre-rollout archive. Old
cursors and receipt metadata also match; only heartbeat/readiness cache entries
changed while the previous runtime finished shutting down. The fresh database contains one pairing and one session, zero calls, setup tests,
leases, actions or effects. No native event cursor was seeded or advanced.

Two rollout problems were resolved without replaying effects: native transport
construction requires truthful ownership evidence even in standby; and the
private source archive's 0600 file modes prevented the container's unprivileged
runtime from reading package/assets. The reviewed source-only deployment context
was normalized to files 0644/directories 0755 under its protected parent; all
347 source hashes remain unchanged. The original archive and failed deployment
records are retained. Do not normalize permissions on runtime/configuration files.

macOS showed saved permission switches enabled while the new ad-hoc signed build
reported denial. Re-adding only the exact installed ClawdTime app in Accessibility
and Screen Recording repaired both. Authenticated running-helper checks now report
`screenPermission:true`, `controlPermission:true`, `cameraVersion:1`, `armed:false`
and zero unresolved input. macOS Quit & Reopen selected the default view-only
configuration; the lead relaunched with the retained control-capable configuration
and verified both viewer and controller ACLs. No global TCC reset was used.

The current foreground session has native desktop capability but no camera surface
selection. The previously reviewed Finder window was no longer a verifiable visible
surface; no full-desktop substitute was selected. Before the production demo:
select a visible harmless window in a fresh camera-configured session, refresh and
seed a verified retained event boundary in the new database, enable live dispatch,
then obtain permission for the specific FaceTime call. Pairing/deployment alone do
not establish physical acceptance or authorize a call. Local Enable remains off.

Validation reused the reviewed 950-test/58-file source release, typecheck/build,
12 preview tests, 3 gateway camera tests and 53 Swift tests. Deployment health,
exact-line claim, session heartbeat, matching loaded ACLs and permission checks
were verified after rollout. Changes remain uncommitted and unpushed.


November 16, 2026 · Real Finder sharing accepted locally · No FaceTime acceptance

## Current demo preparation — November 17, 2026

The native provider upgrade is **dropped**. Its candidate is marked withdrawn in
the private preparation record; do not install it. Keep the existing 9741 line
within HackPton and preserve its provider service and assignment.

ClawdTime now supports explicit `textTransport: "standard_once"`. It verifies
the exact native identity, submits one request to the existing `/send` endpoint,
and accepts only HTTP 200 with a real message GUID and positive native send
evidence. Timeout, queued/202, malformed response or missing evidence becomes
unknown and is never requeued or resubmitted by ClawdTime, even after restart.
There is no automatic fallback to another route. The provider retains its own
queue behavior; a provider acknowledgement is not handset-delivery proof.
Omitted mode keeps the strict receipt adapter for existing configurations.

The generic `native_text_transport` readiness check reflects the explicitly
selected adapter. The standard adapter does not require the strict receipt
endpoint or new native software. Configuration validation and fingerprints bind
the mode. Tests exercise the actual durable dispatcher through repeated drains
and database restart, not only a mocked send helper. Independent connector review
found no critical issue.

Validation: `npm run check` passed **950 tests in 58 files**, typecheck and build.
Fresh component checks passed **12 preview, 3 gateway camera and 53 Swift tests**.
The current companion was release-built as **0.4.0/build 5** with strict local
signature verification; packaging now derives the version from package.json.
It is ad-hoc signed and has not been installed or release-qualified.

An owner-only 9741 configuration draft is staged with live traffic disabled and
source ownership deliberately uncommitted. Six GET-only adapter preparation
requests in an in-memory store verified exact identity, retained event boundary,
project-scoped line, availability, worker heartbeat and media/gateway health.
No effect was created, no message sent, and no production cursor advanced.
The two expected blockers are the disabled live gate and the uncommitted
ownership activation. This is not a claim of completed Mac pairing or handset
acceptance.

The matched source archive, hash manifest and companion are retained privately
under `prod-demo-release` in the dated recovery directory. They contain source
and build artifacts only, not runtime records or credentials. Remaining rollout:
activate matching ClawdTime backend/media and local camera components; use a new
9741 database/configuration while retaining the old pair together; claim a fresh
exact-line Mac pairing via the operator route without sending a setup-test notice;
then verify same-chat readiness. A FaceTime demo requires separate call permission.
No provider software, installed service, deployment, line assignment or old record
was changed during this preparation. New work remains uncommitted and unpushed.

The camera rendering and command paths are integrated with existing session,
viewing, media and CUA code. They are off by default and require no IDE plugin.
The synthetic preview works. The follow-up now captures real Finder pixels locally;
see the current Finder validation below for its tested scope and remaining limits.
This is a local source checkpoint, not a deployment or FaceTime readiness claim.

## User review and local commit authorization

At joint review, the user accepted the appearance of annotations and zoom in the
synthetic preview and requested that all pending work be committed and logged.
That instruction supersedes this handoff's earlier leave-uncommitted stopping
condition. The local checkpoint includes the pre-existing conversation, document,
CUA, media and website work along with the Argos implementation and reload fix;
these earlier changes are preserved, not attributed solely to this camera slice.
Nothing is pushed or deployed by this checkpoint.

The preview is a developer harness displaying generated images, not the user's
screen. Its mapped fake click only reports inverse presentation coordinates; it
does not submit OS input or replace ClawdTime's existing CUA executor. Synthetic
zoom/annotation review does not accept actual capture, click targeting, or FaceTime.

Next work identified at that checkpoint (Finder progress is recorded below):

1. Make explicit selected-window capture repeatable on a disposable Finder folder,
   diagnose geometry/visibility invalidations, and retain exact identity checks.
2. Provide an understandable actual-share preview with explicit surface selection,
   live/unavailable state and Stop. Clearly separate synthetic diagnostics and keep
   mapped fake input out of the ordinary review flow.
3. Qualify sustained Finder, IDE and paused-video-editor capture, movement/resize,
   close/minimize, revocation and Stop. IDE extensions remain optional.
4. Verify camera-coordinate integration through existing CUA on disposable targets;
   selected-window fallback stays disabled until exact click targeting is reliable.
5. Review local results before separately authorized FaceTime/handset acceptance.

The subsequent real-Finder request below separately authorizes local implementation.
No live testing or rollout is authorized.

Pre-commit validation rerun: `npm run check` passed typecheck, **901 tests in 58
files**, and build; `media/.venv/bin/python -m unittest discover -s media -p
'test_camera_preview.py'` passed **4 tests**. `git diff --check` is clean. The
checkpoint includes all 163 inventoried pending source/test/document/asset paths;
temporary preview images, development state and ignored files are not included.

## Actual Finder sharing follow-up (after checkpoint `f8a5a2a`)

The user authorized local real-window sharing on a harmless Finder window, with
no FaceTime. Prepared `/tmp/ClawdTime Sharing Review` containing only disposable
folders/text. Added `npm run preview:camera:window` to build the development helper,
resolve only the exact Finder app/title, and launch explicit-Start view-only capture.
Added bounded metadata-only window lookup/inspection for geometry diagnosis and a
distinct actual-sharing page without synthetic fixtures or mapped fake input.

The user opened and confirmed the disposable Finder window. The capture fix uses
an app-initialized, screen-only ScreenCaptureKit stream and its first complete frame,
then requires successful stream-stop acknowledgement within 350 ms before publishing.
No image is published on stop error/timeout. Exact window ID/PID and lifecycle checks
remain in force. Public AX main/focused-window witnesses handle missing on-screen
flags only when both the AX and selected native geometry are unambiguous.

Initial selection must fit wholly on its chosen display. Once bound, a window may
move partly or entirely off-screen without widening its desktop-independent window
filter. Crossing onto another active display is refused. Mid-capture geometry changes
return a typed 425 read result: discard pixels/marks/input authority, recheck the same
lease, and capture that exact surface again. Input is never retried by this path.

Actual local evidence: 15 consecutive native captures succeeded in 0.319–0.467 s,
with 1840×872 source pixels. A 20-second preview sample received 39 distinct frames
and three content revisions; adding a disposable file after sharing began changed
the captured content. The browser displayed the real Finder rows and a rectangle
annotation. Freeze showed Paused, Resume restored Live, and Stop removed the image
and returned server `stopped: true`. Real source screenshots were inspected only
transiently. One session retired during a helper rebuild; a fresh finished-build
session captured successfully.

Final browser checks on the finished build: live Focus region settled at normalized
crop approximately `(0.16, 0.20, 0.55, 0.38)` and visibly enlarged the real Finder rows.
Freeze retained this crop; Resume restored Live; Overview returned the whole window.
Translation-only window motion now preserves focus/easing while clearing marks and
invalidating old geometry references; resize still resets presentation. Paused UI
only enables Resume/Clear, normal polling no longer flickers disabled controls, and
command failures remain visible instead of leaving a misleading older receipt.
The user-facing session was left live in Overview for their own review.

Validation on this follow-up: `npm run check` passed typecheck, **904 tests in 58
files**, and build. Media **314 passed / 13 optional skips**, gateway **37 passed**,
and Swift **53 passed**. After the final translation/UI changes, **21 focused
camera/preview tests** passed (including two new translation tests); the full media
count above predates those two added tests. Synthetic smoke passed, and the synthetic
browser suite was rerun successfully after the final UI changes: authentication,
focus, annotations/context, freeze/resume, clear and Stop/reload, no script errors. The actual preview uses the real gateway, ScreenController and camera
compositor with a local policy stub; the synthetic smoke separately exercises the
connector/backend integration. No installed helper or live service changed.

At joint review on November 16, 2026, the user confirmed “real sharing looks good”
and requested that these changes be committed and logged. This accepts the local
view-only Finder sharing milestone and supersedes the follow-up's leave-uncommitted
state. The changes are recorded in the local commit `feat: enable real local window
sharing` following `f8a5a2a`, on `ArgosClawd`. No push or deployment is authorized.

Next, qualify move/resize/minimize/close, permission loss, lock and Stop across
Finder, an IDE without extensions, and a disposable paused video-editor project.
Then qualify camera-coordinate integration through the existing CUA executor on
harmless targets, independently observing actual outcomes. A supervised FaceTime
trial follows only after review and separate authorization.

The longer
Finder lifecycle/multidisplay matrix, IDE and paused video-editor acceptance, real
CUA targeting and FaceTime/handset acceptance are still pending. Selected-window
fallback input stays disabled; this preview is view-only and needs no IDE plugin.

## Native CUA integration follow-up (after `440919b`)

The user asked to integrate the accepted real sharing with existing CUA, then
move toward FaceTime. Added `npm run preview:camera:cua`: the existing connector
and backend now drive the actual selected-window preview in a disposable local
native-only review. Capture starts explicitly from this command after exact
Finder selection. It retains simulation transport and an in-memory pairing/session;
there is no phone call, installed configuration or live-service change. The original
chat performs native actions; no replacement coding runner or input executor is added.

Physical local check: this chat's CUA tool observed the exact disposable Finder
window and its file URLs. Through the connector/backend, the lead read an empty
turn queue (cursor zero), fresh exact camera metadata and idle ownership, claimed
`native` at epoch 1, and rechecked ownership/hold/cursor before input. One native
click selected **02 Drafts**. A new native AX observation independently confirmed
the selected row; a later camera frame changed content revision, and the browser
visibly displayed the selected Drafts row. Ownership released to `none`, epoch 2,
state `idle`, with no unresolved action. No typing, file modification, or global
coordinate fallback was used for that action.

Browser Stop removed the frame; subsequent camera access and native claim were
refused. Native ownership remained idle. The isolated review process was then
closed. This proves the one native Finder-selection path, not arbitrary app input,
camera-to-global-coordinate targeting or forced cancellation of native tools.

Added gateway preflight refusal of selected-window fallback before helper dispatch
or receipt creation. Actual preview input routes remain disabled even in native
review mode; explicit native readiness requires authenticated literal-loopback
configuration. Default actual previews remain view-only. Native ownership is a
cooperative permission: the host must still target and freshly observe the exact
window, check Stop/turns before each action, and preserve uncertain outcomes.

Validation: `npm run check` passed **910 tests**, typecheck and build; focused
camera/execution/control suites passed **72 tests**; gateway **38 passed** and
preview **12 passed**. Synthetic connector/backend/media/fake-input smoke and browser regression
(authentication, focus, annotations, pause/resume and Stop) passed.
The preceding native capture build and actual pixel path also ran successfully.

FaceTime readiness is blocked by a concrete authentication prerequisite: both
MCP `connection_status` and CLI `doctor --require-live true` returned **401 invalid
or revoked credential** for this project's configured connection. No new pairing,
permission grant, line change, install, deployment or call was attempted. Preserve
existing checkpoints/receipts; restore a valid authorized project connection via
the supported setup flow before verifying the actual installed backend/media/
gateway/helper camera capabilities, local policy and exclusive line readiness.
Then conduct one supervised bounded call to the confirmed paired recipient and
verify handset pixels, native action outcomes, hangup and capture/ownership cleanup.
The broader IDE/video-editor and lifecycle matrix remains pending.

Changes in this follow-up are uncommitted for review. Prior accepted milestones
remain in `f8a5a2a` and `440919b`.

## Connection recovery inspection — November 17, 2026

The user authorized handling reconnection and continuing. Read-only inspection
confirmed that the saved project connection, successful setup checkpoint and
companion claim agree on the credential and pairing. The local record is not
marked revoked; this does not establish current server authorization. Fresh CLI
live doctor still returns 401. Public health checks on the configured canonical
origin and documented backend return HTTP 200 (`ok: true`, mode `live`), which
confirms reachability only, not the availability of camera or call capabilities.

The supported `setup --existing true` path reuses the saved credential; it cannot
renew a server-rejected credential. New setup requires an operator-issued one-use
link, and refuses overwriting the existing project binding/checkpoint. Existing
registration intents with unknown outcomes were found and preserved. Their local
snapshots do not prove remote cleanup. No token was printed, replaced or copied;
no disconnect, claim, pairing change, service change or call was attempted.

Requested the missing fresh recovery/setup authorization or an identified
operator-access route. The next step is operator reconciliation of the original
pairing/session records, followed by the supported authorized setup flow and live
doctor. This is an authorization prerequisite, not a reason to reset local state,
restore a database or bypass authentication. The local CUA implementation remains
available independently; its validation evidence above is unchanged.

## Setup reply and live readiness inspection — November 17, 2026

After the user sent the advertised onboarding greeting, read-only CUA inspection
found delivery but no setup reply. The signed-in provider dashboard showed no
assigned line for ClawdTime. The advertised number belongs to shared infrastructure;
the dashboard explicitly leaves customer routing unverified. Historical welcome
text is not proof of its current routing and does not authorize moving that line.

The existing signed-in Railway console provides operator access; the user does
not need to locate an operator credential. The credential stayed inside the
deployment environment. Authenticated canonical readiness returned HTTP 200,
live mode, zero pending/unknown effects and zero active calls. This coarse endpoint
does not establish transport readiness. Read-only SQLite inspection found a failed
heartbeat and failing logical identity, occupancy, Calls worker and heartbeat
checks. A fresh GET using the configured project credential returned HTTP 200
with zero lines and no configured line. The inbound ownership gate therefore
blocks polling. Native identity and retained cursor checks were passing.

The saved local pairing is absent from the active backend database. Its sole
current pairing matches the Mac/display but grants viewing only; all ten recorded
sessions are stopped. Do not relabel the old pairing, copy credentials between
bindings, widen the current grant, or erase local unknown registration outcomes.
The current runtime/database differs from the historical handoff documentation;
that older document cannot authorize restoring prior routing.

Setup remains incomplete. First reconcile the provider's missing ClawdTime line
visibility and exclusive ownership without taking over another shared-line tenant.
Then reconcile the preserved local pairing/checkpoints and establish an explicitly
authorized current connection. A fresh invite alone cannot repair the transport
failure. No provider assignment, deployment, runtime record, credential, message,
call or input grant was changed during this inspection. No runtime data or screen
capture was copied into the repository.

## Authorized repair follow-up — November 17, 2026

**Superseding decision:** the user dropped the native messaging upgrade. The
prepared provider worker/helper candidate is withdrawn and must not be installed.
Use the existing 9741/HackPton service and adapt ClawdTime's selected text
transport locally. Preserve ambiguous delivery as unknown; do not automatically
resubmit it or fall back to another send route. Strict receipt lookup remains
appropriate for the old strict adapter but is not a universal camera/CUA
requirement. Continue production-demo preparation without a FaceTime call.

**Latest user correction:** use the existing service number ending **9741**;
do not reassign any line. The proposed alternate-line/provider-software repair
was withdrawn and never executed. Read-only verification found that 9741 is
enabled and available with a fresh worker heartbeat. Its current customer
project and assignment audit identify HackPton; the ClawdTime customer project
has no assigned line. The audit's reservation extends through November 18.
The five saved Mac connections inspected contain only older line identities,
not 9741. The prior recovery credential therefore does **not** establish a
9741 connection. The user subsequently confirmed that HackPton is the intended
project and identified the prior “Compare Argos with ClawdTime” chat. No updated
prompt is needed. That history and the operational Argos README establish the
successful November 16 verification/audio/synthetic-camera test and its isolated
messaging configuration. Temporary test membership/login were removed afterward.
No reassignment, provider modification, call, message, or credential relabeling
was performed during this follow-up. The connector, transport, and Mac agents
independently reviewed recovery prerequisites.

Authenticated GET probes using the existing protected 9741 configuration now
confirm both the exact healthy native identity and project-scoped Calls access:
HTTP 200, matching line/phone, available and unoccupied. The receipt lookup
required by ClawdTime returns generic HTTP 404 `Not found`, instead of the
receipt protocol's `found: false` response. Native status reports no trusted
message bridge installed. This is an integration compatibility gap, not a failed
line assignment or a failure of the earlier Argos verification test. The working
9741 messaging service and callback configuration were left unchanged. The live
ClawdTime backend has not been rebound, and this Mac is not yet paired to 9741.

Local transport preflight now checks `native_text_receipts` with an authenticated,
GET-only lookup for a fresh native-valid operation origin. Only the exact
structured HTTP 404 missing-receipt response qualifies; generic 404, malformed
identity, unexpected statuses and network failure block readiness. The runtime
also gates inbound polling on this check, before consuming messages or creating
welcome effects. Existing unknown outcomes and cursor values remain unchanged.
Regression coverage includes malformed responses and a real runtime tick with
an unsupported receipt endpoint, asserting zero polls, sends and new effects.

Validation: `npm run check` passed **923 tests in 58 files**, typecheck and build.
An in-memory diagnostic using the built transport against the selected 9741
service performed exactly two GETs: identity passed, receipt compatibility
blocked, no cursor was created and no effect recorded. Read-only remote service
metadata confirmed that the isolated launch agent uses the host's existing
mac-server binary. No worker/helper was replaced or restarted. A matching strict
text worker/helper package and guarded account-only installation must be prepared
and reviewed before changing that working service; an older source qualification
is not proof that a compatible installable package is available now.

The Mac specialist subsequently prepared a local review candidate from the pinned
historical source without editing any provider checkout. Both worker/helper builds
and seven strict-text test targets passed; the worker was relinked with static
Opus after read-only inspection found the target lacks the Homebrew Opus dylib.
The isolated codec fixture and local signature checks passed. All 400 extracted
source files still match the archive. Candidate artifacts, hashes and logs are
retained privately under the dated recovery directory's `native-9741-candidate`.
They are development-signed, not installed or physically qualified. The actual
9741 helper-load check and an account-specific guarded install/rollback remain
necessary. The existing executable is shared: never overwrite it; any approved
installation must use a new 9741-private path and change only its launch agent.
No security settings were changed. Independent connector review found no critical
issue in the ClawdTime readiness fix; the final runtime suite passed 10 tests and
the final build passed after its diagnostic wording update.

The user authorized live ClawdTime line repair and Mac reconnection, preserving
existing records and other shared lines, with no FaceTime. This supersedes the
earlier prohibition on ClawdTime configuration changes; it does not authorize
taking over another tenant's connector or weakening receipt/ownership checks.

The previous migration's protected receipt identified a different, valid local
connection for this same Mac/display. Authenticated doctor confirmed that its
pairing still exists and retains viewing-only permission. Reused that grant for
this project in a new owner-only recovery connection, and changed only the exact
owned MCP block's connection-file pointer. No old pairing fields or tokens were
rewritten. All **137 files** in the old connection directory, including setup
checkpoints and unknown registration records, remained byte-for-byte unchanged.
The original project config and before/after audit remain in the private recovery
directory; neither credentials nor runtime records are documentation fixtures.

CLI doctor against the repaired connection now reports **connectionReady: true**.
Owned MCP configuration, launcher, skill, current pairing, paired Mac/display,
screen permission and media gateway checks pass. **liveReady remains false**:
the provider cannot expose the configured line to ClawdTime, and local sharing
is intentionally disabled. The already-running MCP process may retain its old
credential until the host reloads it; its in-memory connection was not claimed
repaired. No coding client was restarted and no replacement agent was launched.

Earlier provider inspection established that the old line is now shared
infrastructure with six live connector records. Its retained shared allocations
were not deleted, expired, reassigned or rewritten. The alternate unassigned
dedicated line has no active Calls sessions, queued commands, connector leases or
shared allocations, and its messaging account has no sender routes or active
project integration. Authenticated native identity succeeds. However, its strict
text receipt lookup returns generic HTTP 404 `Not found`; the existing qualified
line returns the protocol's explicit `found: false` receipt response for the same
unused sentinel. The candidate is therefore **not qualified for ClawdTime's
receipt-preserving message transport**. No test message was sent to discover this.

The earlier Mac credential change passed project configuration/doctor checks
for its original line only; it did not reconnect 9741. No provider line, shared allocation, worker,
deployment or runtime database was changed. Completing the line repair requires
qualifying the existing 9741 service for ClawdTime's message receipt contract
before an audited configuration change within HackPton. The alternate-line
proposal is withdrawn. Do not solve it by moving any line, replaying old setup effects,
rebinding an existing database, or switching to an unreceipted send endpoint.
The local camera/CUA implementation and its prior tests are unchanged. Validation
for this operational edit is authenticated doctor, exact configuration checks,
private before/after file hashes, scoped read-only provider probes and diff checks.

## Starting state and preservation

- Branch remains `ArgosClawd`; starting HEAD before this local checkpoint:
  `43441adea70044bbd69c83f807b03543d59b2a2d`.
- The initial inventory contained 137 modified/untracked source files, including
  conversation, CUA, documents, website and the Argos handoff. Baseline source
  copies and SHA-256 inventory are in `/tmp/clawdtime-argos-baseline/` for comparing
  this work against the actual dirty tree, rather than HEAD alone.
- During implementation no pre-existing file was removed, reset, cleaned or stashed. Existing
  conversation/document/website work remains. Of the 137 original dirty files, 105
  remain byte-for-byte identical; the other 32 received scoped integration/docs
  changes. Staging/committing was deferred until the explicit joint-review request
  above. No push, deployment, live configuration, installed service change,
  provider session, Messages send or call occurred.
- Apple Teams, chert-facetime and the operational argos-lab were not modified.
  No credentials, runtime/customer records, real screenshots or audio were copied.
- Context was read across the coordinating lead and scoped Mac/media, connector
  and transport specialists, including the specified handoff, project plans,
  current code/tests, execution-host distinctions and pinned Argos reference.
  This is an independent implementation of rectangle/easing/crop behavior; no
  upstream camera code, VS Code settings edits or marker detection were vendored.

## Run and review locally

From `/Users/garygao/clawdtime`:

```sh
npm run preview:camera
```

Open the printed `http://127.0.0.1:.../#...` URL. The temporary fragment token is
removed from browser history and retained in tab-scoped session storage until the
preview expires or access is cleared, so reloading the same tab keeps working.
Stop or an authorization failure clears that credential and stops polling; opening
the bare URL in a separate browser context requires the original token-bearing link.
Preview is synthetic by default, binds only to
loopback, expires after 15 minutes, and uses an in-memory backend plus temporary
media/gateway ledgers. Stop is visible; a stopped selection cannot resume.
Ctrl-C stops capture and waits for Python cleanup, closing only the development processes. No production `.env` is loaded.

This entry point constructs a real ClawdTime simulation session and drives the
production connector, API, viewing policy, MediaDevicePort, Gateway,
ScreenController and compositor. The helper supplies synthetic pixels and input
ends in a fake sink. It creates no real call or agent runner. The UI's mapped-click
button is explicitly a mapping diagnostic, not OS input or UI-success evidence.

```sh
npm run preview:camera -- --smoke
npm run test:camera:browser
media/.venv/bin/python media/preview_camera_images.py /tmp/clawdtime-argos-camera-review
```

The smoke check also claims the existing fallback executor, observes a pristine
frame, submits one mapped click through the real receipt path to a fake sink,
observes afterward, releases ownership and verifies Stop refuses further access.
The browser check uses installed Chrome with a disposable profile; it writes only
synthetic PNGs to `/tmp/clawdtime-argos-review` and shuts down its fixture processes.

For the disposable real Finder review, open `/tmp/ClawdTime Sharing Review` in
Finder, keep the window visible, and run `npm run preview:camera:window`. Open the
printed full URL, press **Start sharing**, then use Focus region, annotations,
Freeze/Resume and Stop. Selecting another row in Finder should appear in the preview.
The title chooses a window; it does not confine Finder navigation to that folder.
Keep this window on disposable content. The preview lasts at most 15 minutes.

For other explicit selected capture, build the development binary and obtain bounded
surface metadata. This does not read installed helper configuration or grant TCC:

```sh
swift build --package-path mac
mac/.build/debug/ClawdTimeCompanion --camera-list
media/.venv/bin/python media/camera_preview.py --mode actual \
  --surface '{"kind":"window","id":"SELECTED_ID","displayId":1,"ownerPid":123}'
```

Replace every example identity with the intended disposable surface's actual
metadata. Press **Start sharing** in the local UI. An explicit display
object is also supported: `{"kind":"display","id":"DISPLAY_ID","displayId":123}`
with matching numeric identity. Actual mode never supplies OS input and never
exports captures. A missing/closed/minimized or cross-display target becomes unavailable;
it does not widen to the desktop. Surface switching requires a new explicitly
selected session/process. Stop cannot be undone by Resume.

## Review follow-up: preview reload authentication

The review screenshot exposed a reproducible 401: refreshing after the URL fragment
was removed discarded the page-memory token. Fixed the local preview to retain a
bounded credential in tab-scoped sessionStorage, tighten its expiry from server
metadata, and clear it on Stop, expiry or authentication failure. Missing/rejected
access now shows recovery instructions, disables controls and halts polling. No
backend authorization or session lifetime was relaxed. In-flight responses cannot
restore credentials or pixels after Stop.

Validation: four preview HTTP tests passed; TypeScript typecheck passed. Browser
regression covers authenticated reload, a separate unauthenticated browser context,
401/403/410 responses, absence of repeated unauthorized requests, camera controls,
and Stop followed by reload, with no page errors. The original 401 was reproduced
in the review tab, then the repaired preview was reloaded successfully in that tab.

## Architecture and contracts

The existing media `ScreenController` owns the ephemeral camera alongside its
pristine source frame; there is no second agent, executor, call owner or backend
pixel store. The existing activity/status presentation remains separate context
from camera marks; camera labels are transient display content, never evidence of
an edit or authority to execute.

Negotiation requires all of:

1. Backend and media `CLAWDTIME_SCREEN_CAMERA_ENABLED=true` (default false).
2. A new protocol-2 session with immutable `screenCamera: {version:1,surface}` and
   `capabilities.screenCameraVersion:1`. The surface must match the paired display;
   windows additionally bind exact window ID and owner PID. Audio/document-only
   sessions cannot opt in; old runs cannot upgrade by reconnecting.
3. Current helper/gateway readiness advertising `cameraVersion:1`, exact local
   policy revision, active lease, permission, local Enable and session freshness.
4. Media sends `X-ClawdTime-Camera:1` to backend policy. An old peer receives no
   camera selection, preventing accidental full-display fallback for a window.

The existing MCP and JSONL command registries expose `screen_camera_status` and
`screen_camera_command`; REST uses GET/POST
`/api/attention/:id/conversation/camera`. Media uses GET/POST
`/sessions/:id/screen/camera`. Status is bounded metadata, not screenshots.
See `src/camera-contracts.ts` and `docs/CONNECTORS.md` for exact schemas/CLI flags.

Every mutation carries a stable command ID, expected presentation revision, exact
source-frame ID and geometry generation. Commands are `focus_region`, `zoom_out`,
`overview`, `pin`, `unpin`, `freeze`, `resume`, `annotation_upsert`,
`annotation_remove`, `clear`, and `context`. Camera motion is latest-intent wins;
pinning suppresses automatic focus, not explicit manual commands or lifecycle loss.
A pin identifies coordinates, not a semantic object.

| Boundary | Implemented bound |
| --- | --- |
| Source pixels | Up to 8192 per axis, 32 million pixels, 2 MiB JPEG; fail instead of silently downscaling |
| Camera metadata header | At most 2048 characters through authenticated relay |
| Focus rectangles | Finite normalized source coordinates, minimum width/height 0.01, wholly within source |
| Animation | 0–1500 ms, default 450 ms; output renders at 15 fps for camera selections |
| Source polling | Existing maximum 5 fps; not full-motion video qualification |
| Annotations | At most 16, plain text up to 160 UTF-16 units, TTL 100–10000 ms |
| Mutation rate | At most 20 accepted commands/second |
| Command receipts | Last 256 fingerprints/metadata; old revisions reject evicted duplicate commands |
| Freshness | Existing two-second source/policy limit; short lease/session checks remain authoritative |
| Output | 1280×720; aspect-preserving crop/letterbox, reserved header and caption/context footer |

Source content changes conservatively clear marks/context. Geometry changes clear
camera focus/pinning/freeze state as well. Duplicate mutations cannot extend TTL
or revive expired content. Frozen content survives only while ongoing source
capture and viewing authorization stay fresh. Stop, revoke, disconnect, expiry,
closed/changed surface and executor transitions invalidate appropriate source and
presentation state. In-flight callbacks cannot restore stopped pixels.

Apple's current sample requires macOS 15, so implementation retains this project's
macOS 14 ScreenCaptureKit APIs. Window capture gets complete native window pixels
and crops locally because `sourceRect` is ignored for single-window capture.
References: [Apple capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
and [sourceRect](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect).

## CUA behavior and limits

`/screen/frame` and `observe_shared_screen` remain pristine. Source metadata
survives backend observation and is checked against the lease's surface and actual
pixel dimensions; images are never persisted in backend frame metadata.

Existing `act_on_shared_screen` optionally accepts
`presentation:{revision,geometryGeneration,sourceFrameId}` for click/scroll.
Its point is normalized in outgoing-video space. Media maps through the exact
pixel-quantized crop and letterbox to source coordinates while holding the same
frame lock used by camera mutations and input dispatch. Native display coordinates
retain the existing display origin/point-scale mapping. No new mouse API exists.
Without that reference, existing pristine-source coordinates retain their meaning.
Type actions cannot contain a presentation point reference.

Current executor ownership, local fallback permission, interaction cursor, fresh
observation, stable action ID/fingerprint, post-action observation and release are
still required. Moving, frozen, stale, consumed and mismatched views refuse input.
A repeated exact action reconciles its existing receipt; changed arguments cannot
replay it. A submitted/observed receipt does not establish intended UI success.

**Selected-window fallback input is deliberately unavailable.** Independent window
capture may show a window behind another app; global input could hit the covering
app. Backend transition and media preflight reject this before reserving input,
with a helper backstop. Viewing/zoom/annotations work for windows. Existing display
fallback is retained. A separately qualified native agent may use its own actual
host tools under existing ownership; camera support does not attest those tools.

## Validation actually run

| Command/check | Result |
| --- | --- |
| Initial `npm run check` | Passed: typecheck, 872 tests / 55 files, build |
| Final `npm run check` | Passed: typecheck, 901 tests / 58 files, build |
| Backend camera + control/execution/presentation regression | 63 tests / 4 files passed, including 20 new camera integration cases |
| Focused connector/MCP/JSONL regression | 33 tests / 6 files passed, including real stdio MCP against a synthetic HTTP fixture |
| `npm run preview:camera -- --smoke` | Passed complete local connector/API/policy/gateway path and fake CUA claim→observe→act→observe→release |
| `npm run test:camera:browser` | Passed focus, marks/context, pause/resume, clear, Stop/no stale-image restoration; zero page script errors |
| `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'` | 319 run: 306 passed, 13 optional dependency skips |
| `media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'` | 37 passed |
| `python3 -m unittest discover -s mac/scripts -p 'test_*.py'` | 21 passed |
| `cd mac && swift test` | 47 passed |
| `cd mac && ./scripts/package.sh` | Release build and ad-hoc signing passed; not installed or notarized |
| Focused Python camera checks after final validation changes | 11 passed |
| `git diff --check` | Passed |

Tests cover malformed/nonfinite geometry, Retina and negative origins, window
metadata, letterboxing, smooth supersession, pinning, receipt/rate/count/text/TTL
bounds, source/content changes, stale/foreign frames, Stop and lease races,
capability downgrade, pristine observation, exclusive CUA, no duplicate input,
unknown receipts, and old peer behavior. Tests are not physical acceptance.

One early browser launch found Playwright's bundled Chromium missing. The browser
check uses installed Chrome instead; no browser download or user profile was used.
The first smoke run exposed a fixture lease-epoch precheck against old policy; it
was fixed and the complete path rerun successfully. These were implementation/test
findings, not ignored failures or production changes.

## Visual and actual-app evidence

Synthetic artifacts reviewed locally:

- `/tmp/clawdtime-argos-review/overview.png`, `focus-annotated.png`, `paused.png`,
  `stopped.png`: actual browser preview captures.
- `/tmp/clawdtime-argos-camera-review/contact-sheet.png`: coding, Finder-like and
  paused-timeline fixtures before/after crop; companion PNGs/GIFs show motion,
  pause and clearing. These are explicitly synthetic, not real-app acceptance.

Labels are readable at local output size, marks clip to the source viewport, and
context/captions occupy a separate footer. Handset readability was not tested.

The development binary's Screen Recording preflight succeeded. One direct,
explicitly selected disposable Finder-window capture succeeded at **1840×872**
native pixels; bytes were parsed in memory and discarded. Repeated streaming
attempts were refused when that window changed geometry or became off the selected
display/Space. No whole-display fallback occurred and no real screenshots were
retained. This is partial actual-capture evidence, not successful Finder streaming
or annotation/Stop acceptance.

Cursor launch commands targeted only a disposable TypeScript fixture, but no stable
on-screen fixture window was obtained for capture. No IDE capture passed. iMovie
was detected installed, but no disposable paused project was prepared/captured;
video-editor acceptance is pending. No actual CUA click, typing or scroll input was submitted to any app; fixture
creation and window activation/positioning used their ordinary app interfaces.
The disposable fixture folder is `/tmp/clawdtime-argos-camera-fixture`.

## Independent review and resolved findings

The connector and transport specialists reviewed the lead/source/frame/ownership
boundaries independently; the Mac specialist reviewed capture/rendering/Stop caches.
Resolved findings include:

- Require exact camera metadata/surface/dimensions in the core observation store.
- Explicit media capability header; Stop and exact surface checks in policy.
- Preserve the full bounded native observation through MCP (2 MiB raw image budget).
- Reject paused/moving/old source input before creating an action receipt.
- Reject window fallback input before effects; do not rely on global click geometry.
- Clear camera source/marks on consumed input and executor changes.
- Use bounded rolling receipts without permanently exhausting Resume/Clear.
- Quantize render and inverse-map crop consistently.
- Require explicit actual-preview selection; prevent late browser fetches restoring
  pixels after Stop; plain-text labels and exact shared schema bounds.

No remaining known automated safety blocker is being represented as passed.
Selected-window input and actual cross-app/handset qualification remain explicit
capability/acceptance limits.

## Change inventory and dependencies

Lead-owned additions: `src/camera-contracts.ts`, `src/control/camera.ts`,
`scripts/preview-camera.ts`, `scripts/check-camera-preview.ts`, this review.
Integration changes: `src/contracts.ts`, `src/app.ts`, `src/runtime.ts`,
`src/control/{viewing,execution,coordinator,planner}.ts`, `media/device-port.ts`,
`package.json`, `.env.example`, `README.md`, and the Argos integration plan.

Connector changes: `cli/main.ts`,
`connectors/shared/{client,conversation,mcp,protocol,setup-session}.ts`,
`docs/CONNECTORS.md`, new camera/MCP tests, and existing conversation/bridge tests.
Backend registration/tests: `src/attention/service.ts`,
`tests/backend-camera.test.ts`, `docs/TRANSPORT.md`.

Native/media additions: `CameraCapture.swift`, `CameraPolicyTests.swift`,
`media/{camera,camera_http,camera_preview,preview_camera_images,test_camera,test_camera_preview}.py`,
`gateway/test_camera.py`. Integration changes: native App/Capture/Policy;
media devices/captions/server/device_actions/device_relay/Dockerfile/test_devices;
gateway service/relay; component READMEs and DEVICE/MEDIA_INTEGRATION docs.

No dependency versions or package lock changed for this slice. It depends on the
pre-existing dirty v2 conversation/execution and document-aware runtime files;
a clean HEAD-only checkout is not an equivalent build. Compare against the
saved baseline before later staging or splitting commits. The existing package
script only built a development artifact; it did not replace the installed app.

## Cleanup, rollback and later supervised checklist

Stop the local preview, then Ctrl-C its terminal. Synthetic scripts delete their
temporary media/gateway ledgers and close their local listeners. Review PNGs/GIFs
and the disposable source folder may be deleted after review. Native source bytes
and annotation text are process memory only. No live rollback is necessary.
For a later source rollback, remove only this slice's additions and reverse its
changes against the saved dirty-tree baseline; do not reset to HEAD or remove
unrelated untracked files. Keep any actual unresolved action/call receipts intact.

Later, with the user present:

1. Select stationary disposable IDE, Finder and paused video-editor windows; prove
   native capture, readable focus, labels, resize/move/minimize/close behavior and
   Stop without widening capture or altering app settings.
2. Qualify display presentation-to-input mapping using a disposable control UI,
   including Retina, negative origins, letterbox rejection, zoom races and local
   Stop. Independently verify actual UI outcomes. Window CUA needs additional
   exact hit-target/focus qualification before enabling it.
3. Review further changes before publishing; the local synthetic and Finder
   milestones have already received explicit commit authorization.
4. Only after separate authorization, establish current live line ownership and
   exact recipient/session readiness for a supervised view-only FaceTime trial.
   Measure handset delay/readability and stale-display clearing separately from
   local frame publication. Voice changes, proactive calls and IDE semantics are
   later milestones, not part of this implementation.
