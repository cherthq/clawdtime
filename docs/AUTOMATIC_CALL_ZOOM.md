# Automatic call-video zoom

November 21, 2026. Track B started from freshly fetched `main`
`e82bf2ce3648b3b80aff7b64a90f1781861f2ee4`, then rebased onto
`75193d97c0a194de7b37aa1136477cdf4e4e349f` after PR #52 merged during
validation. Its job-status changes do not overlap zoom. Recent merged
chat-routing PRs #42–50 and open drafts #13, #38 and #51 were inspected.
No code from `background-computer-control` / #38 or the desktop-switching
branch is a dependency.

## Behavior and controls

The native hands publish the region of an agent action before its guided
cursor travels. Click/scroll/drag regions and focused typing fields include
the painted cursor and label bounds. The caller's video moves toward that
region; the Mac's desktop, windows, observations and input coordinates do not
change. The person's mouse is not a zoom source.

Default magnification is 1.8×, reduced when needed to keep the field and label
in view. Smoothstep transitions last 400 ms. A 12% inner margin holds nearby
actions steady; a distant target widens before reframing. A click holds for
2.8 seconds while fresh context remains available. Typing refreshes its field
from Accessibility rather than extrapolating a caret or reading text.

| Request on the call                     | Result                                                       |
| --------------------------------------- | ------------------------------------------------------------ |
| “Disable automatic zoom”                | Turns the automatic switch off independently of computer use |
| “Enable automatic zoom”                 | Turns the switch on; does not release manual overview        |
| “Show the whole screen”                 | Persistent overview, including later calls                   |
| “Resume automatic zoom”                 | Explicitly releases overview/manual framing and enables auto |
| Existing “zoom in on [session]” request | Uses the existing manual terminal-window view                |

These phrases are examples, not a required vocabulary. The voice model selects
a bounded `call_zoom` action from natural speech; the tool must belong to the
current finalized provider input and its SDK response handle. No exact wording
comparison or fixed phrase recognizer gates the runtime action. The prompt
requires caller intent and excludes negated or quoted requests; this remains
model interpretation, not a guarantee of semantic accuracy. Persistent overview
still requires an explicit resume action to release it. Proactive responses
cannot change presentation through these tools.

Local controls require no call, model, or screen permission:

```sh
node line/zoom-settings.mjs status
node line/zoom-settings.mjs disable
node line/zoom-settings.mjs enable
node line/zoom-settings.mjs overview
node line/zoom-settings.mjs resume
```

Preferences live in the owner-only `line-presentation/zoom.json` under
`CLAWDTIME_CONFIG_HOME` (default `~/.local/share/clawdtime`). They contain only
the switches and command revision. Each explicit command gets a new revision,
so repeating overview after a temporary manual view works. Active calls read
preferences every 500 ms. Corrupt/unreadable settings fall back to overview.
The file needs an absolute `CLAWDTIME_CONFIG_HOME`. With a relative one a call
still starts: it keeps the preferences in memory until it ends, so nothing
persists to later calls, and it logs `zoom_settings` with the code
`memory_only` once. The local controls then save nothing and exit with an
error.

Precedence: an explicit manual terminal view takes precedence, and it stays
until the person asks, on the call or with a local control, for another view,
the whole screen or automatic zoom; otherwise overview, then the automatic
switch, then fresh action hints. Manual view never releases the persistent
overview latch. A transition, Stop, loss of previously known context or
capture loss retires the action target, never the manual view: the end of an
agent action, hiding and showing the screen, and a capture gap all keep it.
Overview still applies until resume. Two more things end the manual view:
corrupt or unreadable settings, with their fallback to overview, and hangup.
A new call has no inherited targets or manual crop. With or without the
native worker running, the manual terminal view is a fixed crop of the
screen: it is not a window tracking API. No app title or terminal content
enters presentation metadata.

## Caller zoom by voice

November 26, 2026. At any time on the call, the caller can move the video onto
any part of the shared screen. The voice model calls `call_zoom` with action
`zoom` and the caller's words in its arguments: `target` (what to show),
`level` (`in` or `out`), `times` (an exact level), `move` (`left`, `right`,
`up`, `down`) and `bit` (a small step). One call can carry several of them;
they apply in that order: target, then level, then move. The agent says one
short line, for example "Zooming on the address bar."

| Request on the call                                                    | Result                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "Zoom on the top right", "the bottom left corner"                      | That quarter of the screen                                                       |
| "The left half", "the right side", "the top half"                      | That half of the screen                                                          |
| "The middle", "the top middle", "middle left"                          | A half-size part around that place                                               |
| "The bottom bar", "the dock", "the top bar", "the menu bar"            | The middle of that edge at 2x; a move goes along it                              |
| "Zoom on Stonepad", "the Riverchat window", "this window"              | The frontmost window of that app (or the front window), shown alone              |
| "The address bar", "the Send button", "the error message", "the chart" | That thing, from the hands' last look, with room around it, at most 3x           |
| "The Send button in Riverchat"                                         | That thing, only when the last look is of that app                               |
| "Closer", "zoom in more", "bigger"                                     | 1.5 times the current level, at most 4x                                          |
| "A bit closer"                                                         | 1.25 times the current level                                                     |
| "2x", "zoom to 3x"                                                     | Exactly that level, from 1x to 4x                                                |
| "Zoom out", "zoom out a bit"                                           | The level divided by 1.5, or by 1.25; near 1x the whole screen, still held       |
| "Move right", "a bit up"                                               | Half of the shown part that way, or a quarter for "a bit", inside the screen     |
| "Zoom on the address bar and move a bit right"                         | Both, in one call                                                                |
| "Follow", "follow what you do"                                         | `resume`: releases the held view and follows ClawdTime's clicks and typing again |
| "Show everything", "show the whole screen"                             | `overview`: releases the held view and keeps the whole screen until resume       |

The names are examples. Stonepad and Riverchat stand for any app on the Mac.
A level is the magnification against the whole screen in the same picture. On
the narrow "fill" framing the crop is tall: at 2x it is half of the screen
from top to bottom, so it fills the upright strip above the mascot.

Rules:

- A caller zoom is the same manual view as the one-window view of a session.
  It holds until the caller says follow or show everything, or uses a local
  control. Automatic zoom does not move it: agent clicks, typing, desktop
  transitions, Stop, hide and show and capture gaps all keep it. It is not
  saved, so a new call starts without it. It never releases the persistent
  overview latch by itself.
- Area words ("top right", "the middle", "bottom bar") are resolved in the line
  and never go to the Mac. A part that cannot be shown larger in this picture
  shape (a half on the wide picture) shows alone. Any other part shows as large
  as it fits, with what is around it in place of dark bands.
- Apps, windows and things on the screen go to the desktop service. A window
  shows alone, like the one-window view. A thing gets room around it and at
  most 3x; "closer" goes up to 4x.
- A thing is found by its name or its words in the hands' last look: the
  Accessibility names of the front window, the words of the texts on the
  screen and the contents of fields. A secure field is never a target, by any
  name. A word for the same thing ("url" for "address", "failed" for "error")
  counts, but less than the word itself. A word of a kind ("button", "field",
  "link", "tab", "menu", "text", "message", "image") must fit the thing, unless
  the name is exact. Only a kind with no name ("the button", "the picture")
  takes the largest thing of that kind; "the chart" with no chart named on the
  screen is not found. An app name wins over a thing that only carries the
  same word. "In" with an app name ("the Send button in Riverchat") needs a
  look of that app.
- The look is used for 60 seconds after it arrived, and only while its app has
  the front window in the system's window list. ClawdTime's own windows float
  above that list. When the window list cannot be read, the look is not used.
  With no usable look, things are not found; parts, apps, "this window",
  levels and moves still work. Without a match the tool says so and the view
  does not change.
- When the capture is not the main display (a custom
  `CLAWDTIME_LINE_SCREEN_DEVICE`), places from the Mac do not apply: only
  parts, levels and moves work.
- If the screen is not shown, a zoom that applied also shows it, in the same
  caller turn. The supervisor gets the caller's words with the presentation
  result `{kind: "zoom", action: "zoom", applied}`. Found or not, a caller zoom
  is call video only: the supervisor classifies the whole turn, answers with
  the result, and acts on the Mac only for other work in the same words.

`POST /desktop/presentation/region` answers where a named thing is. It takes
`{"name": "<the caller's words, 1 to 120 characters>"}` and the existing panel
credential, which is checked before the body is read. It rejects browser
origins, other content types and any other field. The answer is
`{version: 1, code, match, region}`: `code` is `found`, `no_look` or
`no_match`; `match` is `element` or `window`; `region` is a rectangle in
shares of the main display. It carries no label, title, value or app name.
The route only reads: the hands' last look, kept in service memory without its
picture when a hands result arrives, and the system's window list (owner and
place, no title, no permission needed). It queues no command for the hands,
sends no input, takes no picture and logs no name. The line verifies the
service instance first, as presentation polling does, and gives up after
3 seconds. Coverage: `line/manual-zoom.test.mjs`, the `call_zoom` cases in
`line/desktop-intent.test.mjs` and
`tests/connectors-computer-zoom-region.test.ts`. A physical call test of this
feature has not been run.

## Capture, geometry and privacy

`line/call-video.mjs` owns one continuous ffmpeg process per sharing interval.
Changing crop or Fit/Fill layout does not restart capture. The process captures
the full display without audio and emits bounded PPM RGB frames, up to
2560×1440. Each frame declares its actual dimensions, preserving aspect ratio
without guessing Retina padding. A partial frame and the latest complete frame
are retained; there is no frame history or animation queue. Frames older than
500 ms are discarded and the call returns to its animated mascot rather than
presenting a frozen screen as live. Nothing writes media to disk.

The renderer maps original top-left screen points to normalized display
coordinates once, then maps those into captured pixels and the outgoing
1280×720 picture. Bilinear sampling handles fractional crop motion. Fit uses
the wide picture; Fill fits into the existing 332×588 visible strip above the
mascot. Letterboxing is part of the final transform. Native guided cursor and
label pixels receive that same transform, once; no second cursor is drawn.
Native planned/current painted bounds keep long labels inside framing.

The default device is now `Capture screen 0`, rather than a numeric device
index that changes when cameras attach. Apple specifies that the first active
display is main, and ffmpeg selects named screens from that list. An explicit
numeric/non-main `CLAWDTIME_LINE_SCREEN_DEVICE` can still be viewed but disables
automatic targeting. For an existing configuration pinned to `1`, remove that
override or set `Capture screen 0` during a separately approved rollout.
No installed configuration was changed for this PR.

On an observed change of display ID, dimensions or scale, sharing stops and
requires an explicit show. Existing avfoundation input must not be assumed to
follow a changed main-display identity. App/window identity or window movement
widens and invalidates the previous target. Aspect mismatch also widens.
A manual view stays in each of these cases.
Multi-display and full-screen capture behavior require separate qualification.

`CLAWDTIME_LINE_REDUCED_MOTION=on` removes camera animation. Native macOS
Reduce Motion also removes it when native events arrive. The camera never
alters an input lease, action receipt, pause, approval, or unknown outcome.

## Presentation-event contract owned by Track B

`connectors/computer/presentation.ts` defines the strict v1 boundary. Swift's
`CallPresentationEvent` encodes it and the standalone line validates it without
requiring a root TypeScript build. The same synthetic wire fixture in
`tests/fixtures/call-presentation-v1.json` is tested in all three components.

`POST /desktop/hands/presentation` and `GET /desktop/presentation` require the
existing panel credential and reject browser origins. The POST is accepted
only for the current served hands command while the native worker is enabled
and running. The GET returns `{version: 1, event: EVENT_OR_NULL}`. Metadata is
latest-only in service memory; never journaled or logged.

| Field                    | Meaning                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `version`                | `1`                                                                                                                               |
| `producerId`, `sequence` | Opaque native producer and monotonically increasing event number                                                                  |
| `commandSeq`             | Existing served hands command, not an input authorization                                                                         |
| `at`, `expiresAt`        | Epoch milliseconds; native TTL 1,400 ms, accepted maximum 2,000 ms                                                                |
| `kind`                   | `target`, `typing`, `context`, `transition`, or `reset`                                                                           |
| `reducedMotion`          | Native accessibility preference                                                                                                   |
| `surface`                | Required except reset/transition: display ID, point width/height, Retina scale, bundle ID, CG window ID, clipped window rectangle |
| `target`                 | Only target/typing: action/field plus painted overlay region, in original top-left display points                                 |

Rectangles are `{x,y,w,h}`. No labels, window titles, field values, URLs,
credentials, messages or images are permitted. Invalid/out-of-bounds, expired,
wrong-command and replayed events cannot establish framing. Stop and takeover
retire presentation while the original action receipt can still be pending.

The native producer keeps one POST in flight and one latest unsent hint.
Delivery never blocks input or retries old hints. Context refresh is 350 ms;
typing reads happen off the main thread and are fenced by command and surface.
A newly discovered click on changed geometry has an independent 80 ms settling
probe and at most a 900 ms lifetime; geometry/command changes discard it.
The line polls at 150 ms with one request in flight, an 800 ms timeout,
bounded responses, no redirects and cancellation on hide/hangup. It verifies
the private desktop descriptor, owner lock, panel configuration and service
instance through the established loopback discovery path. Pre-call/share hints
cannot be inherited. Service loss clears the target, not replay fences.

The no-argument `HandsController.presentationTransition()` remains a one-shot
widening hint for native app opening and known surface-changing shortcuts.
Observed identity/geometry changes also widen without Track A.

Desktop switching draft [PR #51](https://github.com/cherthq/clawdtime/pull/51)
exposes `onDesktopTransition(phase, epoch)`. Its lifecycle must use the separate
latched overload, not the one-shot seam:

```swift
// In the combined HandsController, after presentation.begin(commandSeq).
if let presentationPhase = CallPresentationTransitionPhase(rawValue: phase.rawValue) {
  presentationTransition(phase: presentationPhase, epoch: epoch)
}
```

Switching/waiting/blocked retire deferred clicks and typing, cancel settlement,
and suppress targets and context. Every 350 ms heartbeat repeats a transition
hint, so latest-only delivery cannot overwrite it with ordinary context during
settling. Ready requires an active lifecycle and a nonstale epoch; blocked
requires a newer switching lifecycle before release. Ready does not supply
coordinates: a fresh native context must be observed before new action targets
can frame. An action arriving before that context read is conservatively used
only to refresh context; its target is discarded, so that first action may not
zoom. Later fresh targets can frame normally. In-flight AX reads and deferred
settlement are fenced across lifecycle changes. Stop/reset retire the latch
and reject callbacks through its observed
epoch watermark. Epochs must remain monotonic for this producer's lifetime.

The phase enum and latch belong to presentation; no Track A types or wire-schema
changes are required. The coordinator wires the callback when combining PRs.
This latch controls framing only: it does not verify Space arrival or prove the
capture pixels show the new desktop. Continuous display capture and its 500 ms
freshness limit remain unchanged; physical transition-following needs acceptance.

## Validation and measured performance

Run from this checkout, without installing or launching a service:

```sh
npm ci --ignore-scripts
python3 -m venv media/.venv
media/.venv/bin/python -m pip install -r media/requirements.txt
npm run check
npm --prefix line ci --ignore-scripts
npm --prefix line test
media/.venv/bin/python -m unittest discover -s media -p 'test_task_presentation*.py'
cd mac && swift test && swift build --product ClawdTimeTaskPanel
# From the repository root:
npm --prefix line run benchmark:zoom
```

Automated coverage includes interpolation/bounds, edge targets, Retina mapping,
Fit/Fill and pixel alignment, long labels, identity changes, typing continuity,
expiry/replay, persistent overview and independent switches, authentication,
Stop with an action receipt still pending, capture failure, backpressure,
reconfiguration, repeated transition heartbeats, blocked/stale lifecycle events,
in-flight typing generation fences, and delayed events after hide/hangup. Tests use disposable
files, local HTTP fixtures and synthetic pixels, not the installed state.

Final automated results on the rebased branch: `npm run check` passed
3,754 tests in 121 files, typecheck and build; standalone line tests passed
79 tests; Swift passed 254 tests and the panel product build; the relevant
Python presentation suite passed 36 tests. Importing the actual line agent with
its installed dependencies also passed without starting a runtime. The first
full attempt needed the fresh worktree's Python environment and a dual-runner
test import fix; those were resolved before the passing checks. During the
lifecycle-latch follow-up, one intermediate Swift run returned `unavailable`
from the unchanged AgentBoard loopback fixture; its isolated recheck and the
final full 254-test suite passed.

Benchmark on Apple M4 Pro, Node 24.22.1, ffmpeg 9.0.1: six three-second sweeps.
Synthetic 2560×1440 `testsrc2` → the actual decoder/camera/renderer/mascot →
1280×720 x264 ultrafast CRF23. The source is lavfi, never avfoundation. No
phone, LiveKit connection, screen capture or real audio is involved.

| FPS/layout  | Frames / scheduled | Render p95 ms | Node % of one core | Source % core | Encode % core | H.264 Mbps |
| ----------- | ------------------ | ------------- | ------------------ | ------------- | ------------- | ---------- |
| 10 / wide   | 30 / 30            | 15.17         | 17.77              | 5.63          | 3.92          | 1.34       |
| 10 / narrow | 30 / 30            | 4.83          | 9.64               | 6.72          | 4.21          | 0.38       |
| 20 / wide   | 60 / 60            | 9.86          | 27.19              | 10.82         | 7.53          | 2.18       |
| 20 / narrow | 60 / 60            | 1.41          | 13.08              | 10.71         | 6.96          | 0.61       |
| 30 / wide   | 90 / 90            | 8.48          | 37.20              | 15.23         | 10.65         | 2.77       |
| 30 / narrow | 86 / 90            | 6.21          | 20.13              | 16.84         | 10.21         | 0.76       |

At 20 fps the wide Node event-loop delay was p95 8.30 ms / max 12.40 ms;
narrow was p95 2.72 ms / max 4.24 ms. No frames were dropped at 20 fps;
two outputs per layout reused a still-fresh source frame while animating.
At 30 fps/narrow four frames were skipped under encoder backpressure.
Node RSS high-water across all sequential sweeps was 435.22 MiB, including
allocator retention; this is not the logical frame-buffer size or a long-run
memory plateau measurement.

The default is 20 fps: eight samples per 400 ms transition versus four at
10 fps, with lower measured CPU than 30. Set `CLAWDTIME_LINE_VIDEO_FPS` to
10, 20 or 30. Magnification remains 1.8× and transition duration 400 ms pending
phone tuning. These are synthetic software-pipeline measurements, not handset
bandwidth, glass-to-glass latency, AVFoundation/LiveKit encoder costs, thermal
acceptance, or evidence that real-time voice stayed responsive.

## Integration overlap and remaining acceptance

Likely Track A overlap: `HandsController.swift`; runtime overlap:
`connectors/computer/panel-hands.ts`, `service.ts`, `src/control/task-app.ts`,
and `TaskPanelCore/PanelClient.swift`. Track A's later caller-transcript binding
also overlaps `line/agent.mjs`; preserve that binding when reconciling the video
refactor. Its `line/desktop-intent.mjs` and legacy `line/screen.mjs` freshness fix
are independent of this PR's `continuous-screen.mjs`. Cursor-bound changes additionally touch
`GuidedCursor.swift` and `GuidedCursorLook.swift`. No worker/planner/input
contract or root manifest changes. The line package adds tests/benchmark only;
there are no new dependencies. Reconcile Track A first, then Track B, as planned.

Physical tests were not run and no installed source, service, line ownership,
settings or permissions were changed. The remaining arranged acceptance is:

1. Coordinate one exclusive desktop-test owner in the coordinating chat.
   Use a disposable TextEdit document; observe actual click landing, stable
   typing, long labels, screen edges, nearby/distant targets, window movement,
   app transitions, local Stop, takeover and capture loss. Keep pixels transient.
2. Under a separately arranged incoming test call, verify native cursor capture
   inclusion without duplication, readable text, Fit/Fill framing, overview
   persistence/resume, real voice responsiveness and end-to-end latency.
3. Measure actual capture/encoder CPU, bandwidth, memory plateau and thermal
   behavior over a longer call before final magnification/FPS tuning. Qualify
   full-screen and multiple displays separately; they are not accepted here.

No outbound call, real message, coding prompt submission, merge, deployment,
installation replacement, service restart or automatic physical retry is part
of preparing this draft PR.

## Official references consulted

- [Apple CGGetActiveDisplayList](<https://developer.apple.com/documentation/coregraphics/cggetactivedisplaylist(_:_:_:)>): main display is first.
- [Official ffmpeg AVFoundation source](https://www.ffmpeg.org/doxygen/trunk/avfoundation_8m_source.html): named screen selection and captured cursor behavior.

Editors of recorded video that zoom toward each click are the reference for
this behavior. This live camera uses only current/past native events and never
depends on future input.
