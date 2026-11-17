# IMPLEMENTATION_ARGOS review

November 16, 2026 · Local source implementation · No live acceptance

The camera rendering and command paths are integrated with existing session,
viewing, media and CUA code. They are off by default and require no IDE plugin.
The synthetic developer preview works; usable real-window sharing remains pending.
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

Next work, in order:

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

No further implementation, live testing or rollout is started by this commit request.

Pre-commit validation rerun: `npm run check` passed typecheck, **901 tests in 58
files**, and build; `media/.venv/bin/python -m unittest discover -s media -p
'test_camera_preview.py'` passed **4 tests**. `git diff --check` is clean. The
checkpoint includes all 163 inventoried pending source/test/document/asset paths;
temporary preview images, development state and ignored files are not included.

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

For actual selected capture, first build the development binary and obtain bounded
surface metadata. This does not read installed helper configuration or grant TCC:

```sh
swift build --package-path mac
mac/.build/debug/ClawdTimeCompanion --camera-list
media/.venv/bin/python media/camera_preview.py --mode actual \
  --surface '{"kind":"window","id":"SELECTED_ID","displayId":1,"ownerPid":123}'
```

Replace every example identity with the intended disposable surface's actual
metadata. Press **Start selected surface** in the local UI. An explicit display
object is also supported: `{"kind":"display","id":"DISPLAY_ID","displayId":123}`
with matching numeric identity. Actual mode never supplies OS input and never
exports captures. A missing/closed/minimized/off-display target becomes unavailable;
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
3. Review the implementation and dirty-tree split before any commit or publishing.
4. Only after separate authorization, establish current live line ownership and
   exact recipient/session readiness for a supervised view-only FaceTime trial.
   Measure handset delay/readability and stale-display clearing separately from
   local frame publication. Voice changes, proactive calls and IDE semantics are
   later milestones, not part of this implementation.
