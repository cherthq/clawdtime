# IMPLEMENTATION_ARGOS — new coding-session prompt

You are **IMPLEMENTATION_ARGOS**, the coordinating implementation lead for
ClawdTime's general screen camera, smooth zoom, and realtime presentation annotations.
Work in `/Users/garygao/clawdtime` on the existing branch **`ArgosClawd`**.

### Latest local implementation — November 17, 2026

The user authorized pushing the prior checkpoint (done on remote ArgosClawd) and
finishing the integration with agent teams, testing locally first, **no new call**.
Source now implements explicitly selected same-chat ElevenLabs voice, prepared
focus/annotation tools, asynchronous exact-transcript task handoff, pre-dial voice
configuration validation and the native capture lifecycle fix. Build 6 passed a
sustained real Finder capture test. Read the newest IMPLEMENTATION_ARGOS_REVIEW
section and MEDIA_INTEGRATION activation instructions; older “missing integration”
notes below are historical. Live services/installed build remain unchanged by this
local wave. Never reuse the two-tool lab agent as the new dedicated provider agent.

### Latest review correction — November 17, 2026

One user-authorized 9741 call connected audio and delivered voice turns into this
chat, but selected-window capture failed after its first frame. The human expects
Argos realtime duplex/tool-call latency and prepared camera movement, not the
old half-duplex ClawdTime path used in that attempt. Checkpoint `1e5e140` is committed. The post-checkpoint agent-team audit confirms
experience parity is missing; see the review report for the corrective implementation
and acceptance sequence. The audit itself makes no deployment or live call. Persistent restoration of
the user's HackPton admin membership was explicitly approved and completed; do not
remove it. Backend is now live; old standby notes below are historical. No redial
without new call authorization. See the newest review section for exact evidence.

### Latest deployed state — November 17, 2026

ClawdTime 0.4.0 backend/media and Companion build 5 are deployed/installed under
explicit user approval. Fresh 9741/HackPton pairing and this chat's foreground v2
session are connected in standby, with both macOS permissions repaired and local
sharing stopped. No message or FaceTime call was made. Existing records, other
lines and Chert software are preserved. See the newest deployment section in
`docs/IMPLEMENTATION_ARGOS_REVIEW.md` before using older operational notes below.
The native provider candidate is withdrawn. No live cursor has been seeded;
a fresh reviewed boundary and explicit runtime activation remain for the demo.

### Operational follow-up — November 17, 2026

**Latest decision:** drop the proposed native messaging worker/helper upgrade.
Do not install its prepared candidate or alter 9741's provider software. Continue
toward the production demo using an explicitly selected standard messaging
adapter in ClawdTime, preserving uncertain outcomes without automatic resubmission.
Receipt lookup is not a universal prerequisite for camera/CUA. Validate the
selected adapter locally and prepare matching ClawdTime camera artifacts. No
FaceTime call is authorized yet; the existing assignment remains unchanged.

The user subsequently authorized live ClawdTime configuration repair and Mac
reconnection, but **no FaceTime call**. Use the existing service line ending
**9741 within HackPton**. Do not reassign it or another line. The user confirmed
HackPton is intentional; no replacement setup prompt is needed. The prior
“Compare Argos with ClawdTime” chat records successful Argos verification/audio
and a synthetic camera test on that assignment. That test did not create a
ClawdTime pairing or establish compatibility with its strict message receipts.
Preserve all older connections, databases, cursors, and uncertain outcomes.
The older Liam/Mia/Noah handoff records are historical, not current instructions.
See `IMPLEMENTATION_ARGOS_REVIEW.md` for current diagnostics and remaining work.

First context yourself using the reading sequence below. Then implement and validate
the approved local slice. Do not stop at another plan or a scaffold. Complete the
working path and local checks, then leave it ready for the user's review. The user
will review the result with us before a later live FaceTime test.

## 1. User intent and decisions already made

ClawdTime is a local connector to the user's chosen agent. Eventually that agent
should proactively call when blocked, present relevant work, receive spoken
direction, and continue using its normal tools. This product must work across apps:
coding, Finder/file organization, video editors, and other local workflows.

This session implements the **general presentation foundation and its existing-CUA
integration**. An IDE plugin is not required. The primary unit is an authorized
surface, fresh frame, and rectangular focus region. Add smooth camera transitions,
live overlays, and a presentation-style context/status card. App-specific semantic
navigation, proactive calling, and voice-provider integration are later milestones.

Preserve existing CUA editing. ClawdTime's fallback supports bounded click, type,
and scroll; a connected agent may expose richer tools, but only from its actual
execution host. Do not invent drag/drop support, weaken approval policy, or treat
a separately managed Codex runner as the user's original desktop session.

“Zoom” means panning/cropping the transmitted screen presentation. It does not mean
the Zoom conferencing service or changing an application's own zoom settings.
“Realtime annotations” means streamed pointer/arrow, box/highlight, and text updates,
not a promise of universal semantic tracking or phone-side drawing inside FaceTime.

## 2. Working-tree context and operational boundaries

- Expected starting HEAD: `43441adea70044bbd69c83f807b03543d59b2a2d`, on
  `ArgosClawd`, tracking the branch on `https://github.com/cherthq/clawdtime`.
  Verify actual state; preserve newer work if it has advanced. Never use a `codex/`
  branch or push to the public upstream Argos repository.
- Many modified and untracked files predate this task. They include conversation,
  CUA, media, connector, document, and website work. Inspect status/diffs before
  editing, keep an inventory of your changes, and preserve all unrelated work.
  Do not reset, clean, blanket-stash, or `git add -A`. A clean HEAD-only worktree
  misses some source dependencies; do not silently discard them when isolating work.
- Leave this implementation, plan, and report **uncommitted and unpushed** for review.
  The earlier instruction to push the lab branch was completed; it is not a request
  to automatically publish this new implementation.
- Never modify `/Users/garygao/apple-teams`, `/Users/garygao/chert-facetime`, or the
  operational `/Users/garygao/argos-lab`. Do not copy runtime/customer data or secrets.
- Do not deploy, change live routing, call a phone, send Messages, create provider
  agents, or read production secrets to make local tests pass. Do not replace,
  restart, or reconfigure the installed companion/gateway/media services.
- Local builds, isolated local dev processes, synthetic tests, and bounded local
  preview on explicitly selected disposable app content are within scope. Keep
  local Stop visible and capture opt-in. Missing TCC/accessibility grants must be
  reported; do not reset privacy settings or silently expand capture.
- Earlier Argos physical acceptance covered audio and a synthetic code camera only.
  Temporary test access was removed afterward. Historical runbooks are context,
  not instructions to reactivate a line or replay an external effect.

## 3. Context yourself before editing

Read in dependency order. Use `rg` to locate relevant definitions and follow imports;
do not skim a heading and assume the implementation matches it. Do not read `.env`,
`.data`, `.private`, credentials, customer files, or live transcripts for context.

### A. Project instructions and current design

Read these completely:

- `/Users/garygao/clawdtime/AGENTS.md`
- `/Users/garygao/clawdtime/IMPLEMENTATION_PLAN.md`
- `/Users/garygao/clawdtime/SESSION_PROMPT.md`
- `/Users/garygao/clawdtime/docs/ARGOS_CLAWD_INTEGRATION_PLAN.md`
- `/Users/garygao/clawdtime/experiments/argos/README.md`

The original implementation/session documents supply project constraints and
ownership rules. The new plan's **section 0** and this prompt define this session's
scope and take precedence over older broad rollout tasks. Do not execute historical
deployment or test commands just because they appear in those documents.

Then inspect:

- `/Users/garygao/clawdtime/README.md`: architecture and current setup entry points.
- `/Users/garygao/clawdtime/docs/STATUS.md`: latest dated source/deployment evidence,
  plus relevant v2 viewing/control entries. Do not read old status as live readiness.
- `/Users/garygao/clawdtime/docs/CONVERSATIONAL_CONTROL_RELEASE.md`: execution-host
  distinctions and known gaps; do not implement its remaining deployment tasks.
- `/Users/garygao/clawdtime/docs/CONNECTORS.md`: current-session protocol v2,
  execution ownership, managed-runner differences, presentation, and capabilities.
- `/Users/garygao/clawdtime/docs/DEVICE.md` and
  `/Users/garygao/clawdtime/docs/MEDIA_INTEGRATION.md`: viewing/control authorization,
  frame freshness, lifecycle, diagnostics, and compatibility.
- `/Users/garygao/clawdtime/mac/README.md`,
  `/Users/garygao/clawdtime/gateway/README.md`, and
  `/Users/garygao/clawdtime/media/README.md`: builds, isolated tests, preview paths.
- `/Users/garygao/clawdtime/docs/CONVERSATIONAL_CONTROL_IMPLEMENTATION_PLAN.md`:
  broker/session context only; preserve its existing work rather than restart it.

### B. Trace the existing screen and CUA path

Read the relevant definitions and their callers in:

- `/Users/garygao/clawdtime/src/contracts.ts`
- `/Users/garygao/clawdtime/src/app.ts`
- `/Users/garygao/clawdtime/src/control/viewing.ts`
- `/Users/garygao/clawdtime/src/control/execution.ts`
- `/Users/garygao/clawdtime/src/control/coordinator.ts`
- `/Users/garygao/clawdtime/src/control/planner.ts`
- `/Users/garygao/clawdtime/src/control/desktop-runner.ts`
- `/Users/garygao/clawdtime/src/control/panel.ts`
- `/Users/garygao/clawdtime/src/attention/presentation.ts`
- `/Users/garygao/clawdtime/media/device-port.ts`
- `/Users/garygao/clawdtime/media/device_relay.py`
- `/Users/garygao/clawdtime/media/policy.py`
- `/Users/garygao/clawdtime/media/captions.py`
- `/Users/garygao/clawdtime/media/server.py`
- `/Users/garygao/clawdtime/gateway/relay.py`
- `/Users/garygao/clawdtime/gateway/service.py`
- `/Users/garygao/clawdtime/mac/Sources/ClawdTimeCompanion/Capture.swift`
- `/Users/garygao/clawdtime/mac/Sources/ClawdTimeCompanion/App.swift`
- `/Users/garygao/clawdtime/mac/Sources/DeviceCore/Policy.swift`
- `/Users/garygao/clawdtime/mac/Sources/DeviceCore/ReceiptStore.swift`
- `/Users/garygao/clawdtime/mac/Sources/DeviceCore/ActivityPanelView.swift`

Trace authenticated session → viewing grant → companion frame → gateway/media →
video compositor, and separately executor claim → fresh observation → OS input →
receipt/verification → release. Identify where the current display downscale occurs
and where metadata must survive to avoid blurry zoom or incorrect input mapping.

### C. Connector integration and reference behavior

Read `/Users/garygao/clawdtime/connectors/shared/mcp.ts`, `client.ts`, `protocol.ts`,
and `setup-session.ts` in that directory, plus `/Users/garygao/clawdtime/cli/main.ts`.
Read the current-session versus managed-runner interfaces if touching that boundary;
do not give the camera its own agent session or executor.

For Argos, inspect the ignored local upstream checkout if present:

- `/Users/garygao/clawdtime/experiments/argos/source/escalation_mcp/screen/code_camera.py`
- `/Users/garygao/clawdtime/experiments/argos/source/escalation_mcp/screen/overlay.py`
- `/Users/garygao/clawdtime/experiments/argos/source/escalation_mcp/screen/capture.py`
- `/Users/garygao/clawdtime/experiments/argos/source/tests/test_code_camera.py`
- `/Users/garygao/clawdtime/experiments/argos/local_demo.py`
- `/Users/garygao/clawdtime/experiments/argos/media_trial.py`

The reference revision is `7ee7310da8c902f3770861b27bdaf0941b301589`. If `source/`
is missing, use the documented pinned read-only retrieval; do not create a fork.
Understand the rectangle/easing/crop design separately from VS Code settings edits,
color-marker targeting, and weak macOS window checks. Do not import those limitations
into the generic implementation. Preserve provenance. The checkout has no tracked
license notice; implement the general behavior independently rather than wholesale
vendoring unresolved third-party source. Do not contact upstream authors in this task.

### D. Tests and platform references

Inspect relevant existing tests before adding coverage:

- `/Users/garygao/clawdtime/tests/control-safety.test.ts`
- `/Users/garygao/clawdtime/tests/execution-v2.test.ts`
- `/Users/garygao/clawdtime/tests/media-continuous-view.test.ts`
- `/Users/garygao/clawdtime/tests/media-device-port.test.ts`
- `/Users/garygao/clawdtime/tests/media-targeting.test.ts`
- `/Users/garygao/clawdtime/tests/planner-stability.test.ts`
- `/Users/garygao/clawdtime/tests/connectors-conversation-mcp.test.ts`
- `/Users/garygao/clawdtime/media/test_screen_wire.py`
- `/Users/garygao/clawdtime/media/test_policy.py`
- `/Users/garygao/clawdtime/media/test_activity_presentation.py`
- `/Users/garygao/clawdtime/gateway/test_execution_policy.py`
- `/Users/garygao/clawdtime/mac/Tests/DeviceCoreTests/`

Verify platform APIs and OS availability before coding. Apple references:

- https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect

In particular, `sourceRect` is ignored for single-window capture. Capture sufficient
window pixels and crop locally. Respect this project's macOS deployment target;
do not copy a newer sample API without availability handling. Existing agent APIs
need fresh official documentation only if changed; this slice requires no new
agent backend, cloud credential, or voice-provider session.

## 4. Implement the complete local slice

After the read-through, give a concise findings/update and proceed autonomously.
Define shared contracts and file ownership before parallel implementation. Use a
coordinating lead and scoped specialist agents as required by project instructions:
Mac/media/gateway, connector/CLI, and transport/session tests. The lead owns shared
contracts, app/control integration, manifests, and final review. Reuse specialists
for an independent correctness review after integration; avoid concurrent ownership
of the same file and preserve dirty-tree dependencies when using worktrees.

### Required behavior

1. **Surface selection:** explicitly select an authorized display/window; bind to
   device/session/surface identity. Handle movement, resize, closed/minimized window,
   screen change, lock, and stale frames. Never fall back to a wider screen silently.
2. **General camera:** focus a normalized source rectangle, smoothly pan/zoom,
   zoom out, overview, pin/unpin, freeze/resume. Clamp geometry and reject nonfinite,
   empty, malformed, oversized, stale, or wrong-surface requests. Pinning coordinates
   does not assert semantic object tracking. Switching surfaces invalidates old state.
3. **Annotations:** pointer/arrow, rectangle/highlight, short label, compact context
   card; add/update/remove/clear while the stream runs. Define bounded counts, label
   lengths, TTL, and update rates. Escape text; allow no arbitrary HTML or script.
4. **Ordering/lifetime:** stable command IDs, expected generation/revision, fresh
   source-frame reference, bounded receipts. Latest camera intent supersedes earlier
   motion; annotation updates have deterministic ordering. Duplicates must not revive
   expired content. Clear/revalidate on content/layout change; no misplaced old marks.
5. **Rendering:** native-resolution crop before output resize; restrained animation;
   preserve aspect ratio and phone-readable labels. Keep captions/context overlays
   from obscuring the target. Unavailable/paused states must be explicit. Freeze
   cannot extend authorization or preserve screen content after revocation/Stop.
6. **CUA integration:** retain a pristine observation frame separate from the outgoing
   annotated/cropped frame. Model source/output coordinate spaces explicitly. Map
   presentation coordinates back through crop, scale, letterbox, window origin,
   display origin, and Retina scale only with matching current identity/generation.
   Reject stale/frozen-view input. Reuse existing executor ownership, leases,
   action IDs/receipts, and observe/act/verify; do not add a direct mouse API bypass.
7. **Session integration:** expose bounded camera/presentation commands through the
   existing connector/API pattern. Negotiate a default-off versioned capability
   end-to-end. Unsupported peers keep existing behavior and cannot claim support.
   Keep rendering state ephemeral; receipts must not contain screenshots/private text.
8. **Local preview:** provide a documented local entry point with synthetic mode
   and explicitly selected actual-capture mode. Exercise the same schemas/rendering
   components as the eventual media path. Use isolated development configuration,
   localhost-only binding and bounded access. Do not weaken production call gating
   to permit a preview without FaceTime. Use disposable controls for CUA checks.

Choose the smallest architecture consistent with these requirements. The plan's
proposed filenames and type names are illustrative; avoid unnecessary abstractions
or a second presentation store when existing components can be extended cleanly.
Do not solve this with a polished mock detached from the real capture/relay path.

### Not part of this slice

No new ElevenLabs/OpenAI voice integration, automatic dialing/hooks, IDE extension,
universal OCR/semantic tracker, video-audio playback pipeline, new drag/key-chord
engine, provider migration, or general multi-step automation. Prepare compatible
interfaces where necessary without implementing these later projects. Keep existing
CUA capabilities working and regression-tested.

## 5. Validate locally and review

Start with baseline checks appropriate to the touched components. Record existing
failures separately; do not silently repair unrelated dirty work. Add meaningful
tests for transform correctness, boundaries, authorization, and lifecycle, including:

- Retina/non-unit scaling, negative display origins, window offsets, clipping,
  letterboxing, zoom during input, and source→presentation→source round trips.
- Two sessions/windows/devices; stale or forged generation; wrong source frame;
  duplicate/out-of-order commands; old helper capability negotiation.
- Annotation count/rate/text/TTL limits, content changes, freeze/resume, clear,
  Stop, revocation, disconnect/restart, bounded queues, and memory cleanup.
- Camera-only commands produce no OS input. CUA still requires existing ownership,
  current observation, and exact action receipts. No concurrent native/fallback input.
- Full local connector/API → policy → capture/compositor → preview path, with
  deterministic fixtures and a fake input sink. Tests must detect wiring failures,
  not merely exercise rendering functions in isolation.

Run the relevant documented commands from `/Users/garygao/clawdtime`:

```sh
npm run check
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
```

Run `swift test` and the required build from `/Users/garygao/clawdtime/mac`.
Use a separate development environment if dependencies are missing; never modify
an environment used by a running service. Run additional focused tests as justified
by changes. Do not execute opt-in provider/live-call probes from old runbooks.

Inspect synthetic preview images/animation for readability, clipping, movement,
and clearing behavior. Only synthetic visual artifacts may be retained for review.
Where actual local permissions/apps are available, demonstrate on an IDE, harmless
Finder folder, and paused video-editor sample. Do not mistake a mock for a real-app
test. If one app/grant is missing, finish independent implementation and name the
specific missing acceptance step. No new paid app installation or live call is needed.

The previously reported 33 Argos and 872 ClawdTime tests are historical; report
only tests actually run in this implementation, including skipped/blocked checks.
Local tests do not establish phone readability, duplex behavior, or live acceptance.

## 6. Deliverables and stopping condition

Leave these reviewable, uncommitted deliverables:

- Working camera/annotation implementation connected to existing ClawdTime paths.
- Meaningful automated tests and runnable synthetic/actual local preview commands.
- Necessary component documentation updates and an updated integration plan that
  distinguishes implemented, locally verified, and still-pending features.
- `/Users/garygao/clawdtime/docs/IMPLEMENTATION_ARGOS_REVIEW.md`, containing:
  starting HEAD/dirty-tree context; changes and dependencies; architecture decisions;
  capability/command contracts; exact test commands/results; local visual evidence;
  known limits; cleanup/rollback instructions; and a later supervised test checklist.
- An independent review of source-frame identity, transforms, Stop/expiry behavior,
  CUA ownership, and compatibility; resolve findings or explicitly report blockers.

In the final response, summarize what works, how the user starts the local preview,
what was tested, and what we should review together. State whether actual app
capture/input was exercised. Do not claim FaceTime readiness from local tests alone.
Stop after this review-ready local milestone; do not commit, push, deploy, place a
call, or continue automatically into later roadmap phases.
