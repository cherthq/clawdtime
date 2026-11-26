# ArgosClawd: local agent connector, general screen presentation, and conversation

## Implementation plan — automatic alignment, native CUA and presentation

Prepared November 17, 2026, following the local rehearsal. This section is the
next implementation plan; it does not claim the capabilities below already work.
It supersedes treating manual desktop arrangement as an acceptance solution.
The user subsequently authorized implementation with agent teams and local tests,
starting with reliable window activation and native CUA. No new call is authorized.

The first work wave now includes an opt-in local Finder/TextEdit activation
capability, typed executor, persistent operation receipts and authenticated preview
control. Current-display Finder → TextEdit → Finder activation and native edit/save/
file move were physically verified. The complete presentation remains blocked by
framing refusals; other window configurations and repeated polished runs are open.
See the newest implementation review for evidence. The phases below are not marked
complete by unit tests or this narrower native-action milestone.

### Prepared walkthrough and live resolution — implemented local slice

The agent now prepares bounded scene intent, window-relative focus and annotation
before playback. Each step still resolves its exact live window and verifies the
foreground result. A read-only native resolver brackets a current source frame;
the media frame lock then commits clear, focus and annotation atomically. Pixel
changes alone do not invalidate that geometric presentation. Target movement,
focus loss, Stop, authority changes, stale observations or the three-second scope
limit clear both crop and marks. This scope never grants input authority or proves
semantic UI success.

After the final scene, `complete` permits `replan` in the same session for the next
request. Replanning invalidates queued old work, clears the prior view, preserves
the original session expiry and retains unknown receipts. Plans are bounded to
12 scenes each and eight per session. Unknown outcomes block replacement.

The local snapshot diagnostic verified both real apps with outgoing zooms/annotations,
then a follow-up plan in that same session, with three native activations and clean
Stop. The user initially placed the windows on the current Space. The updated AX resolver qualifies an
off-Space Finder through public main/focused-window references, but qualification
alone does not establish visible activation. Persistent SCK interruption remains
open; an explicit snapshot-only selected-display diagnostic is separate evidence.

### Intended experience

The user asks for a walkthrough. The original agent prepares scenes, brings the
right window into view, frames the relevant content, and explains it. The user can
then ask to edit text, click a control, move a file or switch apps. The agent does
that work through qualified native CUA and presents the verified result with the
same camera and annotation style. Routine window arrangement is automatic within
the authorized display and supported applications.

The agent decides what to do. Native code handles target resolution, focus,
coordinate conversion and input dispatch. The renderer handles animation. Known
targets should not require another visual-model planning request for each click.
Arbitrary language still needs agent interpretation, and unsupported controls may
need a fresh observation rather than a guessed action.

`prepare → claim → align window → observe target → act → verify → release → present`

### Starting point and constraints

Reuse the existing scene controller, execution broker, selected-display stream,
camera transforms, annotations, Stop propagation and recent-frame reset fix.
The existing scene controller choreographs camera commands; it is not a native
action executor. Local rendering reached about 28 fps in stationary-display tests.
That is not proof of smooth app transitions, typing, scrolling or drag operations.

Three concrete gaps drive the order of work: foreground activation is unverified;
SCK interruption `-3805` remains unexplained; and Stop can leave native ownership
uncertain with no cleanup-only reconciliation path. Preserve all existing receipts
and the historical Finder409 evidence while addressing these independently.

### Phase 1 — prove a supported native activation path

Build a small capability qualification harness before expanding orchestration.
Inventory the originating host's supported native activation, window selection,
click, typing, scrolling, cancellation and tool-completion evidence. Record which
capabilities are verified for each host/app combination; do not advertise the
whole native-control flow based on Accessibility access alone.

Resolve exact application identity, process lifetime, window identity and selected
display. Check a unique Accessibility-to-window match. Request app activation and
raise only the intended window, with separate bounded receipts. Verify frontmost
application, focused window, on-screen geometry and a fresh outgoing display frame.
Missing, ambiguous, minimized or wrong-display targets need explicit handling,
not title-only selection. Remember original layout when temporarily arranging a
window and restore only if it still matches the layout the agent applied.

Prefer a qualified host-native activation primitive. If absent, prototype a
separately negotiated, activation-only companion capability with an explicit
local grant and the same execution broker. It must preserve host target
restrictions and must not reuse fallback `/actions` under native ownership.
A local preview control can invoke a prepared operation during development;
the UI click itself is never authorization. Do not require a browser button or
another user click for every scene in the finished experience.

**Exit criterion:** activate Finder and TextEdit from an unrelated foreground app
without manual rearrangement, then verify the actual outgoing view. Separately
qualify other Spaces, fullscreen, minimized windows and multiple displays. Publish
the supported matrix; do not silently capture another display or force unsupported
Space transitions. If the host/OS cannot support this, foreground automation is a
product blocker, not a reason to repeat the same setup instructions to the user.

Apple makes activation a cooperative request; a successful call cannot guarantee
foregrounding. The implementation must prove the supported path rather than
rely on deprecated forced-activation options. See
[Apple's cooperative activation guidance](https://developer.apple.com/videos/play/wwdc2023/10054/).

### Phase 2 — reliable native clicks, typing, navigation and file operations

Put a typed native-executor adapter between the original agent and scene
orchestration. Its narrow operations resolve/activate a target, observe it,
perform one action, and return a completion receipt. Use stable operation IDs,
record dispatch before effects, and distinguish not-started, submitted, completed,
verified and uncertain outcomes. An adapter timeout must not cause redispatch.

Resolve accessible controls by their observed semantic identity. For coordinate
input, derive coordinates from a fresh source observation and the current window
bounds, scale and display origin. Re-resolve after movement, resizing, scrolling
or app switching. Outgoing zoom, padding and annotations must never become an
implicit coordinate system for native input. Keep camera and input transforms
separate and retain strict input freshness.

Start with Finder navigation and file moves plus TextEdit selection, typing and
saving. Verify the edited document through native observation; verify a move in
both source and destination. Use disposable fixtures and read-only filesystem
checks as additional evidence, never as a substitute for visible CUA acceptance.
Expand drag/drop, other apps and coordinate-only controls after these pass.

The existing helper action route requires control mode and the ClawdTime executor.
If ClawdTime's own native input backend is selected, negotiate its bounded local
policy explicitly and preserve those checks. Do not silently turn native-only
sessions into fallback sessions or add a second LLM executor. Only one qualified
executor may control the shared surface at a time.

**Exit criterion:** repeat the real Finder → TextEdit edit/save → Finder move flow
with correct destinations and no duplicate input. Moving the window between
observation and dispatch must cause re-observation or refusal before input.

### Phase 3 — capture stability and cleanup after interruption

Investigate `-3805` with bounded metadata: source-process lifetime, stream start/
stop, native ownership transitions, snapshot refresh, local Stop and system state.
Run controlled local comparisons for persistent capture alone, ownership changes,
native navigation and static-frame refresh. Change one condition per comparison;
retain no screen/audio content in diagnostics. Repair an evidenced cause and add
a regression test. Do not label a later successful run as a diagnosis.

Introduce cleanup-only native completion reconciliation, separately from claiming
control. Require the original bound actor, expected stopped epoch, independently
available terminal/joined host-tool evidence, no queued/running native dispatch,
and confirmed lease cleanup. If those proofs are unavailable, keep uncertainty
and report the exact prerequisite; do not substitute an agent's optimistic claim.

Append immutable evidence and retire current ownership only to none/paused.
Preserve original uncertain effects and unverified UI results, keep Stop asserted,
and never renew a lease, restart capture or replay an action through cleanup.
Stopped/revoked sessions require a separately authenticated operator audit path.
Any later capture begins with fresh explicit authority and generation.

**Exit criterion:** inject loss before dispatch, after submission, during an action
and during presentation. No late input/pixels may appear after Stop; no effect may
be repeated. Recovery must distinguish a finished actor from a verified UI result.

### Phase 4 — connect native execution to prepared and follow-up scenes

Extend the existing controller with explicit aligning, observing, acting,
verifying, presenting, interrupted and blocked states. A scene carries its
intended message, exact target binding, action intent, expected result, focus
target and annotation. Resolve coordinates at execution time.

Add an ephemeral queue of scene amendments for requests such as “rename that,”
“move it to Approved,” or “show the document again.” A correction invalidates
queued scenes and stale observations immediately. Join/cancel the current native
operation through the host's actual capabilities before transferring ownership.
Preserve uncertainty when cancellation cannot be confirmed. Ordinary reasoning
and file work continue while sharing; only surface input is exclusive.

Use the same path for the initial presentation and subsequent modifications.
Narration describes an action's result only after verification. An unavailable
target produces a useful status, not a fabricated success or an advancing scene.

**Exit criterion:** the user interrupts the prepared walkthrough, requests an edit
and a move, and receives verified results with matching framing in the same session.

### Phase 5 — presentation quality

Use one motion system for overview, target focus, annotations and return to
overview. Begin with the existing 450 ms focus transition; tune easing, zoom limits,
readable margins and dwell against actual text and window movement. Clear stale
marks during transitions and label any paused view. Display the verified action
result before beginning the next narration beat. Honor reduced-motion preferences.

Profile capture, rendering and UI latency separately under real motion. The current
15 fps source cap is a prototype budget; target 30 fps source and output for dynamic
production presentation if the measured capture/resource budget supports it.
Keep latest-frame buffers and rendering queues bounded. Do not raise output fps
alone and describe duplicated source frames as smoother native motion.

Measure distinct source cadence during scrolling/dragging, output cadence, p95
frame age, switch-to-verified-view latency, render time, CPU and memory. Set release
thresholds from the target-Mac profile before final acceptance, and compare the
actual playback against the requested Screen Studio-like quality bar. That bar
remains unmet if source motion is visibly choppy despite a passing render count.

### Phase 6 — acceptance and rollout

Use one scripted but genuinely native local walkthrough: discover both disposable
windows; activate Finder; zoom and label folders; open the notes; edit/save the
heading; return to Finder; move the sample brief; verify source and destination;
present the result; handle a mid-scene correction; stop. Require three consecutive
complete runs without user window setup, plus a ten-minute dynamic sharing run.
These are proposed release gates, not previously completed tests.

Cover wrong/closed/minimized targets, resize and movement, Retina/negative origins,
multiple displays, Spaces/fullscreen, capture loss, host timeout, duplicate request,
cursor/epoch change, lock/sleep and local Stop. Run backend/connector checks,
component tests and independent review. Preserve transient pixels, bounded
diagnostics and audit evidence throughout.

Only after local acceptance, prepare matching backend, connector, media and helper
artifacts behind capability negotiation. A lead-owned rollout must preserve
configuration, signing identity and prior receipts. A supervised handset call
requires separate explicit authorization; no call is part of this plan's local work.
Handset readability, motion and voice interruption remain separate acceptance.

### Team ownership and sequence

| Owner                       | Work                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Lead                        | Shared contracts, broker/recovery API, preview integration, acceptance and root docs.                   |
| Mac specialist              | Activation feasibility, native identity/input adapter, capture diagnosis, renderer and component tests. |
| Connector specialist        | Host capability/completion evidence, native adapter interface, scene amendments and connector tests.    |
| Safety/transport specialist | Receipt persistence, fault tests, cleanup reconciliation review and independent authority checks.       |

First wave: activation feasibility, host completion evidence and capture diagnosis
in parallel. Second wave: reviewed contracts, native actions and cleanup recovery.
Third wave: scene orchestration, polish and complete local acceptance. Shared
contracts remain lead-owned; specialists must not alter another owner's files.
Estimate delivery only after the first wave resolves host/OS capability limits.

## Approved direction — November 17, 2026: desktop presentation with native control

The user selected option 2: explicitly selected-display capture, native window
switching and CUA, with smooth video zooms and annotations. The original coding
agent prepares the presentation before the call and remains the reasoning/tool
owner during it. The requested quality bar is a polished Screen Studio-like
viewing experience; that is a design goal, not a claim of equivalent capability,
frame rate or physical acceptance. This direction supersedes treating isolated
Finder capture repair as the sole route to the next demo. Preserve selected-window
mode and its unresolved diagnostic evidence; do not relabel the old 409 as fixed.

### How the experience works

The agent prepares a short sequence of scenes: intended message, exact app/window,
focus target, optional native action, expected observable result, annotation and
return-to-overview point. Resolve available windows and target identities before
the call where possible. Store identifiers and intent, not screenshots or stale
coordinate promises. At execution, resolve the target against fresh state and
bind its camera/annotation geometry to the current frame/content revision.

The execution sequence is:

`select scene → claim native ownership if needed → activate exact window → verify
window/focus → perform authorized action → verify result → release ownership →
frame/zoom/annotate the verified result`

An ordinary presentation-only camera change does not need input ownership. Input
uses the original chat's qualified native tools and current broker authorization.
Prefer exact application/window/Accessibility actions over blind swipes or
repeated coordinate guesses where the host exposes them. Known target resolution,
input dispatch and camera animation should not require a separate visual-model
planning request for each step. Arbitrary natural-language intent still requires
agent interpretation; native tools alone do not decide what the human means.
The existing optional ClawdTime fallback is not silently enabled by this design.

One authorized display supplies the live source. Zoom, pointer emphasis, labels,
boxes and context are composed into outgoing video; a physical overlay window on
the Mac is not required. Preserve a pristine current source for native observations.
Display capture includes whatever is visible on that display: begin a new explicit
display selection/session, never broaden an existing window-bound lease or switch
silently to another display. No call or local Enable is implied by this approval.

### Presentation quality requirements

- Camera motion uses consistent easing, modest zoom, readable framing and deliberate
  pauses. Avoid chasing every cursor movement or continuous unnecessary zooming.
- Window activation and action verification precede focus; stale marks clear on
  layout/content changes. During a switch, use a current overview or explicit
  transition state, not a stale image represented as live. Wrong/absent targets
  pause the scene with a useful status rather than advancing blindly.
- Voice and visual scenes coordinate around observable readiness. Do not announce
  a demonstrated result before the window/action is verified. The agent supplies
  scene intent and factual results to the existing ElevenLabs frontend; the frontend
  does not gain arbitrary native input or become a replacement coding agent.
- Human interruption takes priority over queued presentation steps. Return to
  overview, change the scene or stop as requested. Every new action remains subject
  to fresh context, exclusive execution and native approvals. Unknown effects are
  reconciled, not retried to keep a demonstration moving.
- Keep capture/render/voice work independent so reasoning or tools do not freeze
  video. Existing source polling (up to 5 fps) and camera rendering (15 fps) are a
  prototype baseline, not proof of polished motion. Profile a sustained display
  stream and assess a bounded continuous-capture path before promising smooth
  30 fps output. Increasing render rate alone cannot smooth low-rate source motion.
- Frames/audio stay transient and bounded. Local Stop, revocation, lock/sleep,
  freshness limits and display/session binding remain authoritative at every rate.

### Implementation and acceptance sequence

The resumed local rehearsal exposed two prerequisites for reliable execution:

- **Verified foreground activation:** background Accessibility window selection is
  insufficient. Design a separately negotiated, bounded activate-prepared-window
  capability under native ownership; do not reuse fallback `/actions` or broaden
  its policy. Require exact app/window/process identity, current selected-display
  authority, a stable operation receipt, Stop checks, and independent foreground /
  focused-window / onscreen verification. macOS activation is cooperative; an API
  return cannot guarantee foreground visibility. Preserve native-tool target
  restrictions, including Codex. No shell-driven OS test or forced-activation
  workaround is authorized by this design note.
- **Cleanup after capture loss:** ordinary ownership release rejects uncertain or
  stopped contexts. A separate cleanup-only reconciliation needs terminal host
  tool evidence, actor quiescence, expected-epoch CAS and an immutable audit. It
  may retire current ownership to none/paused while keeping Stop asserted, but
  must retain original uncertain effects and unverified UI outcomes. It must not
  rearm, renew capture, replay input or treat a fresh session as reconciliation.
  The current host's terminal-tool evidence must be concretely available before
  implementing automatic recovery.

The captured SCK failure `-3805` narrows the category to application connection
interruption; its underlying cause is still unproven. No automatic stream restart
or speculative capture repair is approved by a successful stationary probe.

1. **Display foundation.** Audit existing display capture/render path, then create
   an isolated no-call prototype with disposable content on one explicitly chosen
   display. Measure sustained source/render cadence, latency and resource use;
   verify Stop/freshness/lock behavior. Choose any continuous capture change from
   that evidence. Preserve the current installed services during local review.
2. **Native scene navigation.** Resolve exact Finder and a second disposable app
   window; activate, observe and verify each through the original agent's supported
   native tool under existing exclusive ownership. Add bounded adapters only where
   a needed primitive is absent. Separately qualify Space transitions. No blind
   swipe loop or assumption that submitted input proves success.
3. **Agent-prepared scenes.** Extend the existing prepared-target/camera contracts
   only as necessary for scene ordering, app/window identity, expected outcomes,
   cancellation and revalidation. A planned scene is not authorization for its
   native effects. Keep shared contracts lead-owned and use non-overlapping Mac,
   connector and transport/test specialists during implementation.
4. **Presentation polish.** Tune one coherent motion/framing system, annotations,
   pointer emphasis, scene transitions and voice timing. Rehearse a concise Finder
   → second-app → Finder walkthrough, then interruption and recovery. Evaluate
   actual live output rather than only synthetic animation or static screenshots.
5. **Review, rollout and handset acceptance.** Independently review safety and run
   affected component checks. Preserve records/configuration/signing identity and
   reconcile predecessor bridges before lead-owned idle deployment and a fresh
   current-chat session. Use a frozen `media/` build root if media changes. Request
   fresh authorization for one demo call only when ready. Measure handset motion,
   readability, sustained sharing, duplex/interruption and visible CUA outcomes;
   tests and publisher frame counts do not establish physical acceptance.

Local implementation now includes the explicit display prototype, prepared scene
controller, camera choreography, interruption and Stop propagation. Automated
checks and a 45-second actual static-display probe pass. The integrated native
walkthrough remains open after an SCK stream interruption; edits/moves and motion
quality are not yet accepted. See the latest checkpoint in
[IMPLEMENTATION_ARGOS_REVIEW.md](IMPLEMENTATION_ARGOS_REVIEW.md). The original agent
must still perform and verify native actions; this controller never dispatches them.

Current operational checkpoint (November 17): the user-approved ClawdTime release
is deployed and this Mac has a fresh 9741/HackPton pairing in standby. Both macOS
permissions pass after refreshing the exact companion entries; capture stays off.
See `docs/IMPLEMENTATION_ARGOS_REVIEW.md` for deployment IDs and remaining demo
steps. Provider upgrade remains withdrawn; no reassignment or FaceTime call.

Draft: November 16, 2026. Revised for general app presentation and CUA.
First local implementation slice reviewed in simulation; local commit authorized.
Workspace: `/Users/garygao/clawdtime`, branch `ArgosClawd`.
Reference lab commit: `43441ad`; Argos upstream reference:
`7ee7310da8c902f3770861b27bdaf0941b301589`.

## 0. Current implementation handoff and scope

### Production-demo preparation — November 17, 2026

Use the existing 9741 assignment within HackPton. The user dropped the proposed
native messaging upgrade; its candidate must not be installed. ClawdTime now has
an explicit `standard_once` adapter for the existing send API, with durable unknown
outcomes and no automatic resubmission or route fallback. Strict receipt mode
remains the default for older configurations. Matched camera source and companion
artifacts are prepared locally; production rollout and a fresh exact-line Mac
pairing remain pending. Preserve all existing records and assignments. No FaceTime
call is authorized yet. See the current demo section of the implementation review
for 950-test validation, component checks and GET-only 9741 preflight evidence.

The next coding session is **IMPLEMENTATION_ARGOS**. Its executable handoff is
[IMPLEMENTATION_ARGOS_SESSION_PROMPT.md](IMPLEMENTATION_ARGOS_SESSION_PROMPT.md).
The user requested local implementation, followed by joint review and later live
testing. This section defines the current scope; later sections remain the broader
product roadmap and do not authorize implementing/deploying every phase at once.

### Local implementation review — November 16, 2026

The first local slice is integrated on `ArgosClawd`. The user reviewed synthetic
zoom and annotations and authorized committing all pending work locally; no push
or deployment is authorized. The subsequent local Finder-sharing request is now
implemented with real source pixels. The user accepted the real Finder-sharing
preview and requested a local commit and log on November 16, 2026. Cross-app,
broader CUA targeting and handset acceptance remain pending. A subsequent local
native-CUA check selected a disposable Finder row under exclusive ownership,
independently verified its UI/camera result, released ownership and verified Stop.
FaceTime preflight currently fails with an invalid/revoked project credential (401).
See [IMPLEMENTATION_ARGOS_REVIEW.md](IMPLEMENTATION_ARGOS_REVIEW.md)
for the exact change inventory, runnable preview, validation and acceptance gaps.

- Implemented: opt-in v1 camera within protocol-2 sessions; immutable explicit
  surface selection; native-resolution capture; smooth focus/overview/zoom out;
  pin/pause; bounded, ordered transient annotations/context; pristine observations
  and guarded presentation-coordinate input through existing CUA receipts.
- Locally verified: synthetic connector → backend policy → media → gateway → helper
  → compositor, including exclusive fake input and Stop; Python/Swift/Node checks;
  browser and rendered visual fixtures. Follow-up real Finder capture received
  39 distinct frames over 20 seconds and reflected newly added content; browser
  annotation, Freeze/Resume and Stop checks passed. No IDE extension is required.
- Restricted: selected-window fallback input is refused until actual hit-target
  identity is qualified. A selected window never expands to a display. A surface
  switch requires a new explicitly authorized selection/session.
- Still pending: longer Finder lifecycle/multidisplay qualification, actual IDE
  and paused-video-editor acceptance, real OS-input transform qualification,
  handset readability and all live call/voice work. The local Finder result
  does not establish cross-app acceptance.

The later roadmap sections remain future work. No deployment, installed service,
provider, live line, voice frontend, or FaceTime test was changed by this slice.

### Current project context

- Work in `/Users/garygao/clawdtime` on exactly `ArgosClawd`. At handoff, HEAD is
  `43441adea70044bbd69c83f807b03543d59b2a2d` and the branch has been pushed to
  `cherthq/clawdtime`. Nothing was pushed to the original Argos repository.
- The checkout contains substantial pre-existing modified/untracked conversation,
  connector, CUA, document, media, and website work. Start from the actual working
  tree, inventory it, and preserve it. A clean checkout of HEAD alone lacks some
  inspected functionality. Do not reset, clean, stash everything, or stage broadly.
- `experiments/argos/` contains the committed portable lab and patch artifact.
  Its ignored `source/` is an unmodified upstream checkout. The separate operational
  lab at `/Users/garygao/argos-lab` remains outside this implementation's write scope.
- The completed live lab test proved audible conversation and a synthetic camera,
  not general desktop capture/control. Temporary test access was removed. Historical
  line/credential/deployment notes are not current readiness or permission to dial.
- `docs/STATUS.md` and `docs/CONVERSATIONAL_CONTROL_RELEASE.md` contain dated source
  and deployment evidence; they must not be treated as current live configuration.
- Last recorded checks at the lab commit: 33 Argos tests and its mock preview passed;
  the current ClawdTime working tree passed typecheck, 872 tests, and build. These
  are historical results, not verification of forthcoming camera code.

### Required deliverable for this slice

Implement an app-independent camera/presentation capability in ClawdTime's existing
stack, with an executable local preview and connector/API integration:

1. Explicit authorized display/window selection, frame identity/freshness, and
   a local actual-capture adapter plus deterministic synthetic fixtures.
2. General `focus_region`, smooth pan/zoom, zoom out, overview, pin/unpin, and
   freeze/resume. Use explicit rectangles first; no editor plugin is required.
3. Realtime add/update/remove/clear of transient pointer/arrow, rectangle/highlight,
   and label annotations, plus a compact context/status card. Apply bounded payload,
   count, update-rate, and lifetime limits; declare/test the chosen values.
4. Bind presentation state to the exact session, selected surface, source frame,
   geometry generation, and presentation revision. Reject stale/wrong-session data.
   Define latest-intent behavior for camera changes and ordered/idempotent mutation
   behavior for annotations. A duplicate update cannot extend expired content.
5. Crop native-resolution content before final resize/encode. Keep raw observation
   frames distinct from composited outgoing presentation; account for scaling,
   crop, window offsets, and letterboxing in any inverse input mapping.
6. Reuse existing v2 native/fallback CUA ownership, helper/gateway permissions,
   click/type/scroll, and action receipts. Camera/annotation commands alone submit
   no OS input. Validate mapping and ownership with local disposable fixtures;
   missing native capability remains unavailable rather than silently substituted.
7. Wire the feature into the existing presentation/media path behind a negotiated,
   default-off capability. Provide local commands/UI using the same schemas and
   rendering path, not an unrelated demo that cannot be connected later.
8. Show live/paused/unavailable state truthfully. Stop, expiry, surface replacement,
   lock/revocation, and disconnect must invalidate affected views/annotations and
   queued output. Frozen views may remain only while the viewing grant is valid;
   resuming must obtain fresh state. Old helpers/sessions retain existing behavior.

“Realtime annotations” means updates visible as the stream runs. The initial
version does not promise automatic object tracking across every app or freehand
drawing from native FaceTime. A pinned camera region is not a tracked semantic
object. Clear/revalidate annotations when their target context changes.

### Local validation and stopping point

Build synthetic transform/lifecycle tests first, then exercise actual local capture
on disposable content when permissions and surfaces are available. Use an IDE,
Finder, and a paused video-editor project as the intended cross-app sample. If a
video editor or permission is unavailable, record that precise acceptance gap and
continue the rest; do not install a paid app, bypass a permission, or describe a
mock timeline as a successful real-app test. Do not record private screens/audio.

The developer preview may use isolated local simulation sessions and temporary
configuration, but must not disable production call/lease authorization or reuse
installed credentials. It must bind only locally and use bounded session access.
Do not restart/replace installed services, change macOS privacy settings, start
FaceTime calls, send Messages, provision providers, deploy, or move live lines.
Leave implementation changes uncommitted/unpushed for joint review. The requested
session ends with code, local validation evidence, exact preview commands, and a
review report, not with a live test or deployment.

Defer voice-provider replacement, proactive-call hooks/policies, semantic IDE
extensions, video playback/audio qualification, new drag/keyboard primitives,
and general multi-step execution automation. Preserve the existing execution path
and add only the camera/CUA integration necessary for this slice. Missing external
prerequisites do not justify stopping independent local work.

## 1. Product outcome

Connect ClawdTime once to a local agent and its authorized workspace/apps. Continue
working in the usual tools. When the agent needs a human decision, it proactively
FaceTimes the paired person, explains the problem, and presents the relevant part
of the real screen. The person can interrupt, direct the camera, ask for annotations,
and instruct the same agent to continue. Supported work includes coding, file
organization, video editing, and other local-app tasks as their execution adapters
are qualified.

The presentation foundation is application-independent: selected surface → fresh
frame → focus rectangle → smooth crop/zoom → transient annotations and status cards
→ FaceTime. IDE-aware file/line navigation is an optional adapter, not a prerequisite.
“Zoom” means guided pan/zoom over FaceTime; a separate Zoom meeting integration is
outside this rollout.

Recommendation: build the general presentation core first and validate it on a
small cross-app set. General viewing, rectangular zoom, and frame-bound annotations
are tractable without understanding every app. Reliable semantic targeting and
long-running multi-step editing are the larger engineering challenges and should
be added incrementally. Coding is one useful acceptance scenario, not the product
boundary or a required first implementation dependency.

Hosted services carry calls/media. The local connector owns agent/session binding,
workspace/app authorization, and the local execution adapters; the Mac companion
owns capture/input. Presentation may draw on the outgoing image without changing
the application. Execution changes files or application state through an authorized
agent tool or CUA adapter. A highlight is never evidence that an edit occurred.

### Coding example of the complete experience

1. Connect a supported agent session and the ClawdTime workspace in VS Code.
2. Enable “call when blocked” for this session and choose the permitted hours.
3. A failing test leaves two plausible fixes. The agent requests a decision with
   the test failure, source range, and two concise alternatives.
4. FaceTime rings once. On answer: “The parser test is failing. There are two ways
   to handle empty input. Let me show you.” The relevant source is already visible.
5. The camera moves from the selected editor overview to the highlighted function.
   A small card labels the blocker and the decision needed.
6. The person says “Show the caller,” “Zoom out,” then “Use the first option and run
   the test.” Camera requests are handled promptly; the actual instruction reaches
   the original session under its existing permissions.
7. The agent changes the real file. The person sees the edit, a before/after diff,
   and the test result. Conversation remains available during the test.
8. “Keep going” leaves the agent working. “Hang up” ends media. “Stop the task”
   requests execution cancellation and reports whether it actually stopped.

### Equally important non-code pilot scenarios

- Finder: present a folder, highlight two similarly named files, ask which belongs
  in the destination, then have the connected agent perform an authorized move and
  verify both locations. A filesystem tool can be preferable to UI dragging.
- Video editor: present a paused preview and timeline, zoom to the selected area,
  mark the proposed change, receive direction, and show the verified result. Start
  with a reversible action supported by the actual adapter; do not assume arbitrary
  timeline dragging or full-speed playback review already works.
- General app: move between explicitly authorized surfaces, pin a region, draw a
  pointer/rectangle/label, return to overview, and stop sharing promptly.

## 2. Baseline: reuse, gaps, and boundaries

This plan was inspected against the current working tree, which includes substantial
uncommitted ClawdTime work. Those files are implementation candidates, not proof
that every feature is in the published branch or running deployment. Inventory and
integrate them deliberately before shipping; preserve unrelated changes.

| Area                | Present in inspected source / evidence                                                     | Planned change                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Agent connection    | CLI setup, pairing, MCP, session identity, cooperative conversation tools                  | Package a simple local connection flow; add app/surface binding and proactive event adapters                   |
| Execution           | Cooperative current-session path; separate Codex App Server runner and local pull worker   | Prefer the selected existing session; expose managed execution as a clearly separate optional mode             |
| Calls               | Attention lifecycle, verified recipient, exclusive line checks, durable receipts           | Route all new triggers through this one lifecycle, with call preferences and deduplication                     |
| Screen              | Mac permission/lease checks, ScreenCaptureKit display screenshots, gateway and media relay | Selected-window capture, native-resolution crop, region targeting, optional semantic adapters, view transforms |
| Presentation        | Activity/status receipts, captions, document rendering                                     | A single presentation model for code, diff, test result, blocker card, and annotations                         |
| Argos camera        | Eased crop/zoom, highlighted cursor-line detection, file navigation, incident overlays     | Retain the interaction design; add robust macOS targeting and revision-aware annotations                       |
| Voice               | Argos ElevenLabs lab; ClawdTime optional GPT-Live frontend and conversation broker         | One provider-neutral voice interface; bridge the tested Argos voice path into the session broker               |
| Proactive detection | Cooperative attention tools; Argos process/training detectors                              | General coding blockers, supported lifecycle events, user-selectable escalation policy                         |
| Physical evidence   | User confirmed audio and synthetic code camera on the supervised lab call                  | Still prove real IDE viewing, interruption quality, exact-session continuation, and live edits                 |

Specific limitations found in the source:

- Argos's camera searches a limited file-extension list, temporarily edits workspace
  VS Code settings, navigates through `code -g`, and locates a colored band in pixels.
  Its macOS fallback treats the whole screen as the window and skips meaningful
  occlusion checks. This is useful prototype behavior, not sufficient identity proof.
- Argos accepts absolute locations without a workspace-containment check in
  `parse_location`; the production adapter must enforce its own path boundary.
- ClawdTime's `Capture.swift` currently reduces the display to at most 1280×720
  before transmission. Enlarging that image later loses text detail. Crop before
  downscaling; preserve an independently identified frame for any input mapping.
- The current managed runner starts its own API-managed session. It does not take
  over an existing desktop chat. Current-session attachment must remain explicit.
- Native approvals are not remotely fulfilled by the present managed runner. A
  normal spoken instruction must not be presented as approval of a native prompt.
- The accepted Argos test used a synthetic editor card, with execution disabled.
  It did not prove that a voice instruction can edit the user's actual project.

## 3. Setup and everyday behavior

### One guided connection

Extend the existing CLI rather than introduce a second installer. The intended UX
is `clawdtime connect` in the project, followed by a short guided flow. During the
pilot use the local packaged CLI; public npm availability is not assumed.

The flow selects the agent/session, canonical project/worktree, paired phone,
app/window or display, and call preferences. It installs only the owned connector pieces,
preserves existing MCP/hooks/settings, and requests the relevant macOS permissions.
The Mac companion handles capture. An optional editor extension adds semantic code
navigation; ordinary app presentation does not require an extension.

Default permissions are viewing and presentation. Editor navigation is separately
enabled because opening files and scrolling changes the user's UI. General desktop
input remains a separate control capability. After session authorization, routine
camera commands do not require repeated confirmation dialogs.

A compact local status surface shows: connected agent, project, camera target,
call policy, readiness, and Stop. Doctor distinguishes “can observe blockers,”
“can call,” “can show this surface,” and “can return instructions.” It must not mark
the whole setup ready when only one of those works. Use an explicit rehearsal for
the first connection, then leave the connector ready without recording screens.

### Call preferences and escalation

- Default pilot policy: call on a confirmed blocker/decision request; completion
  notifications are text/status unless the user opts into review calls.
- Session-scoped opt-in, quiet hours, snooze, maximum call budget, and an immediate
  “don't call again for this issue” option. Reconnection must not reset these.
- One incident per session/task/blocker generation. Duplicate hooks, retries, and
  repeated test failures update the same incident; they do not ring repeatedly.
- Proposed starting defaults: at most one attempt per incident, five-minute
  cooldown between separate automatic calls, and three automatic calls per hour.
  Tune from pilot evidence. Never redial on an unknown placement outcome.
- A missed/declined call leaves a concise authenticated message when that channel
  is enabled and authorized. The task remains blocked or proceeds only within its
  already authorized scope. Silence is not a decision.
- If the user is already on a call with the same session, add the new issue to the
  presentation queue. A different session cannot silently take over that call.

### What constitutes a roadblock

| Signal                                                         | Initial behavior                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Agent explicitly asks for a decision, clarification, or review | High-confidence incident; eligible for calling                          |
| Supported native approval/input event                          | Call to explain and show it; preserve the native approval mechanism     |
| Failed test/build/process                                      | Record evidence; ask the agent whether it can recover before escalating |
| Same failure after a bounded recovery attempt                  | Eligible once the agent marks itself blocked                            |
| No output for a while / ordinary turn completion               | Status signal only; no inferred blocker or automatic ring               |
| Agent/connector offline, provider outage, quota wait           | Show unavailable/recovery status; avoid call loops                      |

Start with an explicit agent tool/skill because it carries intent. Add qualified
adapter events next. Avoid blanket transcript scraping and broad filesystem/log
watchers. An optional process watcher should attach only to an explicitly selected
command, keep bounded transient evidence, and never rerun a failed command itself.

Claude Code's documented `Notification`, `PermissionRequest`, and
`PostToolUseFailure` events are candidate inputs, subject to installed-version
qualification. Hooks enqueue bounded local events and return; they must not wait
for a whole phone call or auto-approve anything. Notification timing varies by
surface, so it is not a universal immediate-blocker signal. See the official
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks).

For Codex, keep the existing cooperative exact-session tools first. A connector-owned
App Server session can use explicit turn events, steering, and interruption; qualify
those against the installed schema. `turn/steer` requires the active turn identity,
and an interrupt request must be followed by terminal evidence. These APIs do not
alone establish safe ownership of an already running desktop chat. See official
[Codex App Server turns](https://learn.chatgpt.com/docs/app-server#turns).

## 4. General screen camera and visual presentation

### Application-independent presentation core

Implement selected-window/display capture, `focus_region`, smooth pan/zoom,
overview, freeze/resume, and transient annotations before app-specific integrations.
A target is a rectangle on an identified fresh surface frame. It can come from a
bounded agent-supplied location, a local user's selection, or a qualified target
resolver. Crop/zoom changes only the transmitted presentation, not the app's zoom,
scroll position, selection, or cursor. Navigation within the app is a separate
operation requiring the appropriate execution authority.

Resolve targets in increasing sophistication:

1. Explicit frame-relative rectangle or named region selected locally.
2. Supported accessibility element/OCR or bounded visual grounding, with confidence,
   freshness, and ambiguity checks. A vision-model guess is not a stable identity.
3. Optional app adapter: source range, selected clip, inspector panel, or file item.

Ship level 1 and carefully qualified cases from level 2 first. If a target cannot
be located, ask for clarification or show the authorized overview. Do not make
support for every app's semantic objects a condition for generic zoom/annotation.

### Precise focus without blurry text or controls

Capture native-resolution pixels locally, then crop/compose before final resize
and encode. Retain Argos's smooth easing and overview/focus interaction. Start with
720p at roughly 10–15 fps for static app review; that is not a qualification for
full-motion video editing. Measure motion, CPU, bandwidth, and audio sync separately
before enabling higher frame rates or app-audio playback. Avoid feeding app playback
or our own voice back into the command recognizer.

ScreenCaptureKit supports selected display/app/window capture. Apple's `sourceRect`
is ignored for single-window capture, so the window path needs a local crop of
its captured native-resolution frame rather than assuming that configuration field
works for every source. See Apple's [capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
and [sourceRect documentation](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect).

Every view carries surface/window ID, geometry generation, source frame ID/time,
crop transform, and presentation generation. Account for Retina scale, multiple
monitors, window movement, occlusion, and view changes. If identity or geometry
becomes uncertain, stop following and show a safe overview or unavailable state.
Never expand from a selected app to the whole desktop without authorization.

Annotations compose into the outgoing video by default; they do not draw into
application documents or intercept mouse events. Keep an unannotated source frame
for CUA observation so the agent does not mistake its own overlay for application
UI. A requested click must map through the exact crop/scale/letterbox transform to
fresh source coordinates. Never execute against obsolete zoomed-frame coordinates.

### Optional code/IDE enrichment

After the generic core works, add a small authenticated local VS Code adapter for
workspace/worktree binding, document/buffer revision, file/range navigation, and
semantic decorations. VS Code's `revealRange` and `setDecorations` support that
semantic layer, but do not themselves supply a guaranteed pixel rectangle on the
phone. See the [TextEditor API](https://code.visualstudio.com/api/references/vscode-api#TextEditor).

Correlate an acknowledged range/revision with a fresh selected-window frame before
claiming line focus. Avoid Argos's permanent workspace-setting manipulation.
Dispose owned decorations on Stop; do not restore old settings over user edits.
Preserve unsaved buffers. Generic camera support continues when the extension is
absent; only the semantic code capabilities are unavailable.

### Camera controls and annotations

Initial general commands: show an authorized app/window, focus a region, zoom in/out,
overview, freeze/resume, pin target, point/highlight/label, and clear annotations.
App adapters later add file/range, caller, next diff hunk, test result, or timeline
selection commands.
Ambiguous “show that function” requests resolve to a specific symbol/file or ask
one short clarification. Camera commands are serial, bounded, and latest-intent
wins; superseded animations cannot pull the viewer back to an old target.

Initial overlays: line/range highlight, pointer, rectangle, short label, numbered
proposal, and required/optional badge. Semantic code annotations bind to buffer
revision and range; screen annotations bind to frame/geometry generation with a
short expiry. Reanchor from verified new state or clear on scrolling/editing/layout
change. Do not leave an arrow pointing to unrelated pixels.

Views share a consistent visual structure:

- Context card: what happened, why the agent called, decision requested.
- Live app: real selected surface, current source label, restrained annotations.
- Diff: actual before/after content for this task, with unsaved state identified.
- Result: executing/passed/failed/unknown based on tool or test evidence.

Rendered code/diff cards are useful fallback views but must be labelled as rendered
workspace content rather than live IDE footage. A frozen frame must say “Paused”
and show its age. Native FaceTime touch gestures are not assumed to become our
annotation events; voice-directed annotation is the initial phone interaction.
A separate touch companion, if useful later, is a distinct feature.

Automatic following should be calm: prefer a completed edit or meaningful agent
milestone over every keystroke. User-pinned focus overrides automatic following
until released. Diff attribution compares the task's captured baseline and current
revision; it must not call pre-existing dirty changes “edits I just made.”

### Qualify apps without gating the general camera

The initial presentation acceptance set includes an IDE, Finder, and a video editor
with a paused timeline/preview. Generic viewing/zoom/annotations should work without
plugins. Publish separate capability columns for viewing, semantic targeting, and
execution. A qualified camera does not imply a qualified editing workflow.

Add Cursor and other IDE semantics separately. Video timeline/clip operations and
app-specific export workflows need their own supported tools or CUA qualification.
View selection never silently expands to another app or display.

## 5. Conversation that controls the real agent

Introduce one voice frontend contract around the existing broker: start/stop,
qualified user utterance, speech interruption, camera intent, task intent, and
verified progress. Start the combined pilot with an ElevenLabs adapter matching
the successful Argos voice setup; retain ClawdTime's existing frontend as a
separately selectable fallback. One frontend owns speech for the whole call.
Do not hot-switch providers during a call or run duplicate listeners/executors.

Replace the synthetic demo persona with bounded context from the actual session:
blocker, active task, current presentation, exact decision, and verified progress.
The voice layer can explain supplied context immediately and ask the agent for
deeper reasoning. It cannot invent repository findings, edits, test results, or
approval authority. Code, comments, terminal output, and annotations are untrusted
context, never instructions to the voice controller.

Route intents separately:

| Human intent                                        | Owner and behavior                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| “Show the test,” “zoom out,” “highlight the return” | Presentation controller; no code execution                                                    |
| “Why did you change that?”                          | Answer from current verified context or request the selected agent's explanation              |
| “Use option one and rerun the test”                 | Exact-session instruction with ordered receipt; native policy still applies                   |
| Speaking over narration                             | Stop playback promptly, collect the new utterance; task continues unless told otherwise       |
| “Stop the task”                                     | Request cancellation, distinguish requested from confirmed stopped                            |
| “Stop sharing” / local Stop                         | Immediately revoke viewing and overlays; local Stop retains its stronger existing semantics   |
| “Hang up”                                           | End media and reconcile call cleanup; task disposition follows the established session policy |

Return spoken instructions to the originating session with stable turn/intent IDs
and an acknowledgement. A voice acknowledgement means received/queued, not executed.
Fresh task progress invalidates obsolete narration. Serialize conflicting edits;
retain cancellation and unknown-outcome receipts across disconnects.

For the first release, approval-dependent actions still use the original supported
approval surface. A future remote approval UI would need exact operation binding,
expiry, native adapter support, and separate qualification. Do not solve this by
typing “yes” into whichever terminal has focus.

### Existing CUA editing and the additional work it needs

Editing via CUA is part of the product. ClawdTime already has native-agent versus
ClawdTime-fallback execution ownership, explicit control permission, fresh-frame
checks, and post-action receipts. The built-in fallback currently exposes bounded
click, type, and scroll actions. Its planner proposes one ordinary action at a time.
It does not implement generic drag/drop, continuous mouse gestures, arbitrary key
chords, or a universal autonomous multi-step editor.

The connected native agent may have richer computer/file tools, but capability
must come from the actual connected execution host. A separate managed runner does
not inherit the desktop chat's tools. Existing source support is also not proof that
those tools are enabled or physically qualified in the current installation.

Longer workflows remain with the agent, using observe → act → verify cycles under
exclusive input ownership. Qualify additional primitives such as drag and shortcut
handling when a concrete app task needs them; do not approximate a drag with a
click. Preserve interruption/Stop and uncertainty receipts. App motion means exact
whole-frame equality can reject valid plans; before dynamic video-editor control,
qualify target-local stability checks without loosening identity or freshness gates.
File moves should use scoped filesystem tools when available, with source/destination
and collision behavior verified; CUA is available when the app itself must be used.

## 6. Architecture and proposed contracts

```text
Local agent session -- structured events --> Local ClawdTime connector
       ^                                      |        |
       | ordered instructions                 |        +--> Optional app adapter
       |                                      |               |
       +---------- Session/attention broker --+         semantic targets
                         |                                    |
                    Call lifecycle                    Mac companion
                         |                         capture/crop/annotations
                         |                                    |
                   FaceTime bridge <---- LiveKit/media <------+
                         |
                    Paired person
                         |
                  Voice frontend --> camera intents / session instructions
```

Extend existing contracts compatibly; names below are proposals, not existing APIs.

| Contract                | Minimum identity and behavior                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceBinding`      | Canonical allowed roots/worktree, session and device; explicit authorized app surfaces; no implicit cross-root access |
| `SurfaceBinding`        | Window/display/app identity, geometry generation, viewing grant; editor instance only when applicable                 |
| `AttentionIncident`     | Stable ID, originating session/task, cause/evidence references, blocker generation, call disposition                  |
| `PresentationTarget`    | Selected source type; relative file/range or authorized surface; buffer revision; freshness                           |
| `CameraIntent`          | Request ID, session/call, command, target, expected generation; bounded values and receipt                            |
| `Annotation`            | Owner, semantic range or frame/geometry reference, style enum, bounded label, expiry                                  |
| `PresentationReceipt`   | Requested, adapter-acknowledged where applicable, frame-confirmed, failed/stale; remote visibility separate           |
| `AgentProgress`         | Task/turn identity, revision, actual execution state, changed-file references, evidence kind                          |
| `ConnectorCapabilities` | Surface/version-qualified trigger, response, navigation, capture, cancellation abilities                              |

The camera is not a second call owner. The existing attention/call service owns
placement and cleanup, and existing control leases own capture/input authority.
Camera-only crop/annotation can run while the agent does file work. Editor
navigation and any OS input must coordinate with shared-surface execution ownership;
ordinary reasoning/file work remains active under protocol v2.

Paths resolve locally inside the allowed root, including symlink resolution.
Exclude `.env*`, private state, credentials, generated secrets, and configured
sensitive files from automatic source search/presentation. Support TypeScript/TSX
and actual project languages rather than inheriting Argos's narrow extension list.
The selected-window pilot also needs local presentation checks/redaction so private
tabs/terminal output are not inadvertently shown. Redaction is defense in depth,
not a promise that arbitrary full-desktop sharing is safe.

Keep screens/audio ephemeral. Durable records hold IDs, state, revisions/hashes,
and bounded receipts; avoid raw source, transcripts, secrets, and screenshots in
logs or test fixtures. Preserve the existing native approval and local Stop gates.

## 7. Implementation map and ownership

| Workstream           | Existing files to extend                                                                                                         | Proposed additions                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lead / integration   | `src/contracts.ts`, `src/app.ts`, `src/control/viewing.ts`, `src/control/execution.ts`, manifests                                | Shared camera/incident contracts; `src/control/presentation.ts`; capability flags                                                                            |
| Connector specialist | `cli/`, `connectors/shared/mcp.ts`, `protocol.ts`, `setup-session.ts`, client adapters, `skills/clawdtime/`                      | `connectors/shared/attention-events.ts`, `connectors/shared/presentation-bridge.ts`, optional `connectors/editor-vscode/`, adapter-specific trigger handlers |
| Transport specialist | `src/attention/service.ts`, `conversation.ts`, `presentation.ts`, `jobs.ts`, `src/sessions/`, storage                            | Incident dedupe/preferences, lifecycle state, bounded presentation metadata                                                                                  |
| Mac/media specialist | `mac/.../Capture.swift`, `App.swift`, DeviceCore policy, `gateway/`, `media/device_relay.py`, `captions.py`, `conversational.py` | Window-bound capture/crop, transform mapping, camera compositor, annotation lifecycle, ElevenLabs frontend adapter                                           |

Keep shared-contract edits with the lead and coordinate changes to the existing
presentation store with its owner. Use focused implementation/review waves under
the project agent-team rules when implementation begins. This draft does not
start those agents or modify product code.

Retain the Argos lab as a reproducible reference. Selectively integrate behavior
through ClawdTime interfaces rather than copy the complete watcher/fixer/voice
stack into a competing runtime. No tracked LICENSE/COPYING/NOTICE file was found
in the audited Argos checkout: preserve provenance and resolve reuse terms before
redistributing upstream implementation. Local comparison can continue; independent
implementation of the desired interaction is another route.

## 8. Rollout: small increments with explicit exit criteria

### Phase 0 — establish the integration baseline

- Inventory committed and uncommitted connector, conversation, and media changes;
  identify the minimum dependency set without sweeping unrelated work into commits.
- Record supported installed agent/editor versions and actual adapter capabilities.
- Specify shared contracts and a harmless test project. Keep live features off.
- Spike exact-session round-trip, selected-surface region targeting, and inverse
  camera-to-input coordinate mapping first. IDE semantics are an independent spike.

Exit for this local slice: session identity/authorization tests and a selected
region correctly identified in a fresh authorized app frame. Full spoken response
delivery to the exact agent remains a later combined-live milestone. A failed
capability must be exposed rather than replaced by a different session or fake view.

### Phase 1 — general screen presentation locally

- Add selected-window/display capture, native-resolution crop/zoom, highlights,
  pointers/labels, target pin, clear/Stop, and a local preview.
- Validate the same presentation engine on the actual ClawdTime workspace in an
  IDE, a harmless Finder folder, and a paused video-editor sample project.
- Start with explicit regions and qualified visible-element targeting. No editor
  extension is required, and no file/application edits occur during camera testing.

Exit: readable content, accurate regions and fresh annotations across all three
surfaces; Stop clears capture; no persistent app settings changes. Validate inverse
coordinate transforms on a disposable UI before connecting them to real input.

### Phase 2 — real cross-app presentation over FaceTime

- Feed the new camera through ClawdTime's authorized media path.
- Connect the voice frontend and camera commands; keep code execution disabled
  for this first combined live test.
- Revalidate recipient, line owner/readiness, current scoped credentials, and
  competing connectors. Prior lab success is not a current ownership grant.

Exit: the user confirms real app content is readable, voice is two-way, interruptions
work, commands select the intended view, and call cleanup is worker-confirmed.
Keep the existing line assignment unless a separate move is explicitly requested.

### Phase 3 — spoken direction and visible real edits

- Bind voice task intents to the original connected session. Add truthful result
  views, progress updates, and controlled camera follow. Validate a code change, a
  scoped file move, and one supported reversible app edit on disposable content.
- Reuse qualified native tools or bounded CUA. Implement missing gestures only as
  independently tested capabilities; do not claim full video editing from viewing.
- Validate in a disposable fixture/worktree before permitting normal ClawdTime
  development edits. Preserve the user's pre-existing dirty changes.
- Exercise one correction while work is running and one explicit task stop.

Exit: the same agent changes the intended file once, the phone shows the actual
change, an independent check verifies the result, and conversation remains usable.
An unresolved native approval is correctly shown as blocked.

### Phase 4 — proactive roadblock calls

- Ship explicit attention tool/skill, then supported adapter triggers, call
  preferences, deduplication, and missed-call behavior.
- Run a local shadow mode first: display “would call” with cause, no dialing.
- Enable one user, one session, one selected line after shadow-mode review.

Exit: a real unresolved blocker initiates exactly one authorized call; transient
failures, ordinary completion, hook replay, quiet hours, and offline states do not
produce unwanted calls. Spoken resolution returns to the correct blocked task.

### Phase 5 — polished pilot and deeper app adapters

- Bundle setup, doctor, reconnect, uninstall, camera preview, and local Stop.
- Add richer diff tours, test/terminal views, and semantic code or timeline targets.
- Qualify each app-specific adapter separately; publish viewing/targeting/execution
  capabilities, including motion/playback and any new drag/shortcut support.
- Roll out to a small opt-in group only after repeatable clean-install and recovery
  tests. Distribution signing/notarization and source-reuse terms gate packaging.

## 9. Acceptance and measurement

Automated checks support the rollout but cannot substitute for phone observation.
Use synthetic content in fixtures; keep real screen/audio out of test artifacts.

| Area            | Required cases                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact session   | Two agents/projects/windows; wrong-session response rejected; no silent managed-session substitution                                        |
| Trigger policy  | Duplicate/late hooks, repeated failures, quiet hours, busy line, missed call, restart; no repeated dial                                     |
| Camera          | TS/TSX and other project files, symlink escape, secret path, unsaved buffer, split view, wrapping, Retina, monitor change, minimized window |
| Visual truth    | Correct file/revision/range; dirty baseline attribution; actual diff; stale view visibly unavailable                                        |
| Annotations     | Scroll/edit/layout invalidation, expiry, out-of-order intents, user pin, safe clearing                                                      |
| Voice/execution | Barge-in, echo rejection, ambiguous intent, agent busy, approval pending, cancel requested vs confirmed, no duplicate execution             |
| Lifecycle       | Local Stop, lock/sleep, revocation, media/gateway/worker restart, unknown provider outcome, terminal cleanup                                |
| Installation    | Preserve unrelated settings; repeat setup; version mismatch; disconnect/uninstall removes only owned configuration                          |

Proposed pilot targets, to measure rather than advertise as achieved:

- Local camera intent acknowledgement p95 under 300 ms; stable focused view within
  1.5 s on an available selected surface, within 3 s for an authorized surface switch.
- Capture-to-handset visual delay target under 1 s on the pilot network. Measure
  handset observations separately from local publish timestamps.
- Audible barge-in cutoff target p95 under 500 ms; simple voice response starts
  within 1.5 s after utterance end. Report provider/network variability.
- Confirmed blocker to placement submission within 2 s after any configured
  debounce, excluding native notification delay; record actual ring/answer time.
- Local Stop prevents new frame publication immediately and clears queued media;
  remote stale-display duration is separately measured and bounded before release.
- Zero wrong-session dispatches, unauthorized-view fallbacks, duplicate call
  placement/execution, or unknown-outcome retries in the qualification scenarios.

Run `npm run check`, relevant Python media tests, Swift package tests, editor
extension tests, and actual-client connector spikes for the changed components.
Complete repeated physical end-to-end trials across reconnects and fresh sessions,
including speakerphone interruption. Do not inherit the synthetic lab's acceptance
as evidence for the integrated product.

## 10. Release controls, rollback, and deferred work

Introduce separate opt-in capabilities for screen camera, app adapters, annotations, voice
frontend, and proactive triggers. Negotiate on new sessions; preserve current
protocols and immutable run identities. Initially roll out in this order:
local preview → supervised view-only call → fixture edits → shadow triggers →
single-user proactive calls → small pilot.

Rollback stops new automatic incidents first, drains/reconciles an active call,
revokes presentation leases, disposes decorations, and leaves all uncertain call
and execution receipts intact. Revert to the previously qualified view/voice path
only on a new session; do not replay a pending task or replace a line's ownership.
Keep existing secret maps and other lines unchanged. No sibling repository changes
or backend deployment are implied by this planning document.

Deferred from the first integrated demo: universal IDE support, automatic control
of arbitrary idle desktop chats, remote native-approval bypass, mobile freehand
drawing inside FaceTime, group calls, cloud workspaces, automatic destructive fixes,
and broad always-on screen/transcript recording.

The first implementation slice after plan review is Phase 0 plus the general local
screen camera: exact surface binding, reliable region focus, readable crop, and live
annotations. Validate it in coding, Finder, and a paused video editor. Semantic IDE
integration is optional enrichment; live editing and proactive calls build on this
shared foundation.
