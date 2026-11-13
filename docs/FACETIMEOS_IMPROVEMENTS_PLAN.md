# FaceTimeOS-inspired ClawdTime improvements

Drafted November 13, 2026, America/New_York. **Implementation authorized November 13, 2026.**

## 1. Purpose, scope and authority

Make ClawdTime's existing agent-owned conversation easier to understand, diagnose
and recover. Borrow interaction patterns from FaceTimeOS while retaining the
original Codex/Claude session, native approvals, calling service, exclusive input
ownership and durable outcome handling.

The November 13 implementation request authorizes work packages A–F, isolated
validation, documentation, commits on exactly **`improvements`**, and pushing the
completed branch with `git push -u origin improvements`. This supersedes the
original drafting-only and “do not push” restrictions. Preserve these planning
files in the branch commits and verify the remote final commit. Do not merge to
main, force-push, deploy, install/restart live components, place calls, send
outbound messages, or exercise real native input. Physical acceptance needs
separate authorization. Package G remains deferred.

Screenshots supplied by the user are product context, not authorization to message
the people shown, operate their devices, launch agents, or implement every idea in
their discussion. Do not copy those screenshots or personal conversations into Git.

### Required implementation scope

Implement work packages A–F below: structured activity, compact UI, speech and
progress presentation, completion receipts, diagnostic timing, and readiness plus
qualification tooling. Package G is a deferred roadmap, not an instruction to
implement phone control, a second agent, or generalized Messages task initiation.

Keep the current TypeScript/Python/Swift architecture. Prefer adapting existing
protocols and tests over adding another service, Electron application, model,
database, or second conversation owner.

## 2. Review baseline and evidence limits

- FaceTimeOS: `dylanelu/FaceTimeOS`, main at
  **`97745aa62d37923a8dc8ccc5168a36797975bf65`**, verified through the GitHub tree API.
- ClawdTime: main at **`bf8f18ea8708fcdf16ba90f367757f6f52b94675`**; working tree was
  clean before these drafts. Recorded hosted release: `0814e50`.
- Review method: static inspection of first-party source, dependency manifests,
  licensing files, tests and documentation. No FaceTimeOS code was executed or
  installed. No comparative latency benchmark or live acceptance was performed.
- Downloaded selected source to temporary review directories outside this repo.
  Do not vendor those directories. Do not fetch their `.env`, private/runtime data,
  recordings, dependencies or binary artifacts.
- Main's status records speech/subtitle fixes as deployed but not physically
  qualified. `multi-device-relay` separately records a Claude screen/voice call;
  native control was not qualified in that record. Do not replace main's newer
  status with that branch's older release header or blindly merge the branch.
- A hackathon demo and source inspection establish implemented mechanisms, not
  sustained reliability, current operability, or how much was built during the event.

### Source map: what to borrow and what to avoid

All FaceTimeOS links below are pinned to the reviewed revision.

| Source                                                                                                                                                                                                                                                                                        | Observed implementation                                                                                                                                                              | Decision for ClawdTime                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Queue.tsx](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/frontend/src/_pages/Queue.tsx)                                                                                                                                                               | Current-action subscription, short status, expandable original-message history; new prompts stop the previous run; completion inferred from substrings such as `done` or `finished`. | Borrow compact status and expandable history. Preserve ordered turns; derive completion from explicit state, never prose matching.                                     |
| [QueueCommands.tsx](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/frontend/src/components/Queue/QueueCommands.tsx)                                                                                                                                     | Small movable activity bar with running indication, prompt field and Stop.                                                                                                           | Build a compact native view of existing controls. Keep Stop visible even with stale telemetry. Defer a new local prompt input.                                         |
| [WindowHelper.ts](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/frontend/electron/WindowHelper.ts)                                                                                                                                                     | Transparent, always-on-top window and content protection.                                                                                                                            | Borrow restrained presentation, not invisibility. Use our existing AppKit companion and phone video compositor.                                                        |
| [ApiServerHelper.ts](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/frontend/electron/ApiServerHelper.ts)                                                                                                                                               | HTTP current-action events forwarded through Electron IPC; wildcard CORS, payload logging and unbounded string accumulation in the reviewed handler.                                 | Borrow event-driven UI updates only. Retain authenticated, bounded existing metadata transport; add no unauthenticated UI bridge.                                      |
| [Agent-S app.py](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/Agent-S/src/s3/app.py) and [action_analysis_agent.py](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/Agent-S/src/s3/action_analysis_agent.py)     | Separate short visual and spoken summaries, recent-summary context and model-generated narration.                                                                                    | Borrow concise progress presentation. Use original-agent messages and deterministic labels; no additional model call on every action and no internal reasoning stream. |
| [backend/main.py](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/backend/main.py)                                                                                                                                                                       | Transcription → Agent-S → TTS; completion sends a screenshot to a global last-requester phone number; failed forwarding can return `queued` without a durable queue in that handler. | Borrow useful completion feedback. Bind every outcome to its exact request/turn/session; do not claim queued or delivered without the corresponding receipt.           |
| [ScreenshotHelper.ts](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/frontend/electron/ScreenshotHelper.ts)                                                                                                                                             | Writes screenshot files into application data and maintains small queues.                                                                                                            | Do not copy automatic screenshot persistence. Keep screen/audio transient; screenshots and outbound attachments remain outside this branch.                            |
| [grounding.py](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/Agent-S/src/s3/agents/grounding.py#L414-L449)                                                                                                                                             | `facetime://` launch, fixed-coordinate PyAutoGUI clicks and timed waits; notifies `call_started` before execution.                                                                   | Retain Chert service calls, provider events and confirmed cleanup. No UI-automation calling fallback.                                                                  |
| [call.py](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/backend/call.py) and [audio monitor](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/backend/audio_level_monitor.html)                                    | Audio activity instrumentation and playback interruption; amplitude threshold and silence timing.                                                                                    | Borrow visibility into capture/processing. Do not replace our speech assembler with an amplitude threshold or claim full-duplex support.                               |
| [imessage_bridge.py](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/backend/imessage_bridge.py)                                                                                                                                                         | Polls Messages SQLite, advances an in-memory cursor before delivery, sends through `imessage-ruby`.                                                                                  | Keep our authenticated messaging transport, transactional cursor/outbox and unknown outcomes.                                                                          |
| [VAD integration test](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/backend/test_vad_integration.py) and [audio-state test](https://github.com/dylanelu/FaceTimeOS/blob/97745aa62d37923a8dc8ccc5168a36797975bf65/backend/test_audio_output_states.py) | Service exercise scripts with generated audio, network requests and sleeps.                                                                                                          | Borrow scenario ideas, not execution assumptions. Our default suite must be isolated, assert behavior and never contact live services.                                 |

### Provenance and reuse policy

`frontend/LICENSE` and `Agent-S/LICENSE` contain Apache-2.0 license text. The
frontend README still identifies a Cluely-derived interface. No root/backend
license was present in the reviewed tree; this is not blanket permission to copy
everything. Default to independently implementing interaction ideas in our stack.
If direct code reuse is proposed, inspect the precise file's provenance and
applicable notices first, preserve required attribution/notices, record the pinned
source and modifications, and stop that copying step if permission is unclear.
Do not copy branding, credentials, recordings, user data, or unrelated template UI.

## 3. What already exists in ClawdTime

| Existing path                                                                                                           | Preserve and extend                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/attention/conversation.ts`, `connectors/shared/conversation.ts`, `src/app.ts`                                      | Ordered v2 inbox, acknowledgments, explicit progress, stable speech IDs and cursor checks.                                                   |
| `src/control/panel.ts`, `mac/Sources/DeviceCore/ControlPanel.swift`, `mac/Sources/ClawdTimeCompanion/{App,Setup}.swift` | Exact-session panel telemetry, native/fallback ownership, local controls, command acknowledgments and expiry.                                |
| `media/captions.py`, `media/server.py`                                                                                  | Screen plus captions, partial/final speech feedback, sending/received/unconfirmed states, transient agent text and paused-microphone status. |
| `media/speech_diagnostics.py`, `src/transport/speech-diagnostics.ts`                                                    | Bounded allowlisted pipeline events/counters, persistence and redaction tests.                                                               |
| `src/control/frame-diagnostics.ts`, `media/screen_diagnostics.py`, `gateway/relay_diagnostics.py`                       | Existing screen/relay diagnosis; do not invent a duplicate telemetry system.                                                                 |
| `connectors/shared/readiness.ts`, `cli/doctor.ts`, `mac/scripts/onboard.py`                                             | Readiness checks with next actions and resumable, permission-preserving setup.                                                               |
| `src/attention/service.ts`                                                                                              | Durable effects and unknown-outcome handling. Legacy `complete()` explicitly refuses v2; it sends a result message and ends the call for v1. |

The new panel should expose these facts coherently. It must not replace them with
an optimistic client-side status string or duplicate authority in a new store.

## 4. Product behavior and information model

### User-visible experience

Compact Mac panel: agent/project/chat label, selected Mac/display, concise current
activity, speech/delivery state, and accessible Stop sharing, Mute, Request pause,
End call and Details controls. For example:

```text
Codex · Demo project · Chat 12ab34
Working: checking the selected group
Instruction received by agent · Microphone listening
[Stop sharing] [Mute] [Request pause] [End call] [Details]
```

Details: a bounded in-memory list of recent user-facing activity and outcome
summaries. It is not a transcript archive, tool log or internal reasoning display.
The phone gets readable captions and a concise status strip in the existing video
composition, not a tiny desktop window it must zoom into.

### Independent dimensions, not one misleading status

- Connection: connected / stale / disconnected / ended.
- Capture: listening / assembling / paused for speech / muted / unavailable.
- Delivery: provisional / sending / accepted by backend / acknowledged by agent /
  unconfirmed / incomplete.
- Work: waiting / executing / pending native approval / completed / canceled /
  uncertain. Preserve current protocol semantics; add presentation mappings.
- Ownership: none / native / ClawdTime, plus current epoch and local policy.

Use actual acknowledgments for “Received by agent.” Existing “Received” after media
callback only means backend acceptance. An outcome can be completed while the call
remains connected. End call is a distinct intent; speech playback completion is
neither task completion nor call cleanup.

Uncertain outcomes and stale connection take precedence over a green success
indicator. Local Stop remains available without current remote telemetry. Request
pause is cooperative; show pending until acknowledged and do not promise that
native tools have stopped. Native permission dialogs stay in the coding client.

## 5. Work packages and acceptance

### A. Structured activity contract and projection — foundation

**Change:** Extend the existing progress/polling and panel paths with optional,
versioned presentation data, not a second task engine. Draft shape to finalize
against current schemas:

```ts
// Presentation-only extension; proposed names, not existing API guarantees.
type Activity = {
  version: 1;
  activityId: string; // stable within request/turn
  sequence: number; // server-assigned order
  kind: "status" | "approval_needed" | "outcome";
  summary: string; // <=160 Unicode characters AND <=640 UTF-8 bytes
  // Full session/call/request/turn binding inherited and validated by route.
};
```

Retain the existing `conversation_progress` state transition as the authority.
An optional activity describes that transition; activity alone cannot change
permissions, execution state, call state or ownership. Advertise support through
an additive capability/version field. New clients omit extensions when the server
does not support them; old clients and v1 remain usable.

Persist only existing durable states plus bounded activity IDs/fingerprints needed
for idempotency; keep summary text in a bounded transient cache. Initial limits:
20 entries per active request, 10 minutes maximum age, 100 active caches globally;
refuse/drop optional presentation data when capacity is reached, never drop a
human turn or alter effects. Clear sensitive text at terminal turn/call, Stop,
revocation, wrong binding or expiry. A completed outcome may remain visible while
the call is active only under package D's shorter explicit lifetime.

Retries with identical ID/content are no-ops; changed content under an existing ID
conflicts. Stale sequences cannot overwrite newer state. Do not renew expiry or
repopulate cleared text merely because an old update is replayed. Display-only
failures must not block Stop, end intent, receipts, or turn acknowledgment.

**Files:** `src/contracts.ts`, `src/attention/conversation.ts`, `src/app.ts`,
`connectors/shared/{conversation,client}.ts`, `src/control/panel.ts`, and corresponding
tests. Add a small pure projection module if that avoids cross-layer duplication.

**Acceptance:** wrong-session rejection; ordering; replay/conflict behavior;
unsupported-version behavior; no implicit state change; terminal/expiry clearing;
storage contains no new summary text; existing v1/v2 tests still pass.

### B. Compact native activity panel — highest visible benefit

**Change:** Add compact and expanded modes to the existing AppKit companion. Keep
the full permission/setup window. Reuse the current NSPanel where practical; do
not add Electron or a web server. Show the activity projection and recent summaries
from A, plus the current exact agent/session/device and persistent control buttons.

The compact panel should not steal keyboard focus during computer work. Respect
multiple displays and avoid clipping controls; movement must not select or grant
another display. Expanded details must have keyboard navigation, accessible names,
readable contrast and an option to collapse. No required animation. Do not hide
control indicators from the user or copy content-protection tricks to obscure
activity. Phone status comes from the compositor, regardless of desktop panel
capture behavior; check for duplicate visual overlays during later qualification.

Use five-second status freshness already emitted by `PanelSynchronizer`; when
expired show unavailable, clear task text and disable remote controls whose binding
cannot be established. Keep immediate local Stop. Stop sharing is not a universal
kill switch for arbitrary native coding tools. End/Mute/Request pause keep their
stable command IDs and pending/acknowledged distinction.

**Files:** `mac/Sources/DeviceCore/ControlPanel.swift`,
`mac/Sources/ClawdTimeCompanion/{App,Setup}.swift`, `src/control/panel.ts`,
`media/server.py`, `gateway/service.py` as required for bounded metadata forwarding.
Verify actual current forwarding schemas before changing them.

**Acceptance:** compact/expanded states rendered from synthetic data; long and
Unicode labels; two display geometries; stale/ended/uncertain/approval states;
pending command not shown as completed; no implicit Enable; local Stop unaffected.
Build and test without replacing or launching the installed companion. Supply a
separate synthetic preview path if UI inspection is needed.

### C. Consistent speech feedback and concise progress

**Change:** Connect A's agent acknowledgment/work states to the existing media
caption scene through authenticated bounded metadata. Keep provisional transcript
text within media; do not stream every interim word to the backend, helper or logs.
The Mac panel can show the latest agent-provided safe activity summary and delivery
state. The phone retains the existing transient human transcript and spoken reply.

Add explicit labels for backend acceptance versus agent acknowledgment, pending
native approval and uncertain outcome. Incomplete/discarded speech must visibly
request repetition rather than disappear into an endless listening indicator.
Clear captions and activity after policy loss, generation change or call cleanup;
late callbacks must never revive them. Mute and half-duplex capture remain honest.

Borrow the distinction between short visual status and useful spoken messages.
In this branch, intermediate activity is visual-only. Use the original agent's
existing `conversation_reply` for a meaningful answer, clarification or approval
request; do not create repeated progress speech IDs or relax the existing one-reply
rules to narrate every click. Update the source skill to report meaningful progress
and actual results. Do not modify ignored installed skill copies or install it.
No extra summarizer model and no raw chain-of-thought/tool-output display.

**Files:** `media/{captions,server,policy}.py`, backend/media metadata contracts,
`src/control/panel.ts`, `connectors/shared/conversation.ts`,
`skills/clawdtime/SKILL.md`, `docs/CONNECTORS.md`.

**Acceptance:** a synthetic utterance crosses partial → final → backend acceptance
→ agent acknowledgment → execution/approval → outcome. No state is invented after
a timeout. Repeat across five consecutive turns, correction during work, delayed
acknowledgment, stale speech reply, mute, Stop and close. Existing speech regression
replays and portrait caption rendering remain passing. Do not claim barge-in works.

### D. Bound completion receipts without ending the call

**Change:** Add optional bounded outcome presentation to terminal progress for an
individual v2 turn. It must not call legacy `complete()`, auto-end the conversation,
auto-send an iMessage, or take a screenshot.

Proposed outcome fields: stable outcome ID, outcome status derived from the actual
terminal turn state, short summary (same text limits as A), and verification
`agent_observed` / `not_verified` / `unknown`. An optional evidence kind may be
`ui_observation`, `test_result` or `artifact`; it describes what the agent reports,
not an independently verified server claim. Do not persist arbitrary evidence text,
URLs or filesystem paths in diagnostic records. Native approvals remain separate.

The UI distinguishes “Agent reports completed” from “Outcome unverified” and
“Outcome unresolved.” A reported UI success requires the original agent to observe
the resulting application state. An OS input receipt or completed TTS is inadequate.
Repeated reports return the same outcome; conflicting reports must be reconciled,
not used to replay the action. Terminal states remain terminal.

Make a concise receipt available in the existing polling/tool response so the
original agent can summarize it in its own chat. No unsolicited chat injection or
UI typing into Codex/Claude. Keep outcome text in memory for at most 60 seconds
while the exact call remains authorized, then clear; clear immediately on Stop,
revocation or call close. After restart retain only outcome metadata/fingerprint
and show that summary text is unavailable. The originating chat's normal retention
is governed by its host, not a new ClawdTime archive.

**Files:** `src/attention/conversation.ts`, shared contracts/connector schemas,
panel/caption projection, source skill and lifecycle tests.

**Acceptance:** task completed with call still connected; unverified and unknown
outcomes distinguishable; correct turn binding; duplicate report no duplicate
effect; restart loses transient text without losing outcome receipt; zero outbound
Messages effects and zero new screenshot capture caused by a completion report.

### E. Diagnostic timing and an isolated session inspector

**Change:** Extend existing diagnostics with a correlated stage timeline and a
sanitized local report. Reuse `/api/attention/:id/diagnostics` and existing storage
bounds; do not open a public debug endpoint or introduce a telemetry vendor.

Stages: capture observed, utterance finalized, callback accepted, agent delivery
acknowledged, execution/approval reported, reply accepted, playback started/ended,
outcome reported, end requested, provider cleanup confirmed. Use existing stable
request/turn/reply/segment IDs where available; add an explicit correlation field
where currently missing, with bounded validation on both TS and Python sides.
Separate intent, backend acceptance, native submission and observed result.

Keep monotonic durations within each process. Across processes use causal ordering
and labeled UTC observations; do not subtract unsynchronized clocks and call the
result precise latency. Reset/process generations must prevent negative or mixed
durations. Metrics must not invent a handset-ringing or visible-screen timestamp
from a backend dial response; those need provider evidence or human observation.

Report median, p95, sample count, failure/missing-stage count and measurement kind
(synthetic versus physical). Show unavailable for missing data; do not hide failures
by reporting successful samples alone. Benchmarks compare against the same local
scenario before/after, not an unmeasured claim about FaceTimeOS or Agent-S.

Provide a developer command or static local report using synthetic fixtures by
default. Production reads require explicit scoped credentials and request ID; no
implicit scan of installed configuration or customer databases. Export is an
explicit operation with schema allowlisting: no raw diagnostics response dump,
tokens, phone numbers, project paths, transcripts, screenshots or exception bodies.
Use short opaque correlation labels in shareable reports. Apply explicit retention
and global bounds to new metadata tables/caches, if any; prefer existing stores.

**Files:** `media/speech_diagnostics.py`, `src/transport/speech-diagnostics.ts`,
`src/app.ts`, `src/attention/conversation.ts`, `connectors/shared/conversation.ts`,
`cli/doctor.ts` or a focused `scripts/` report tool, relevant diagnostic tests.

**Acceptance:** missing/stale/out-of-order stages; process restart; clock skew;
correct quantiles on known fixtures; counters with denominators; capacity limits;
redaction of planted synthetic secrets; wrong-session access refused; no production
API or external model traffic in fixture/report tests.

### F. Readiness explanations and qualification harness

**Change:** Reuse existing readiness/check/nextAction fields to explain blockers
consistently in the panel, setup/doctor output and report. Audit current onboarding
before adding behavior: another branch already contains multi-device work. Do not
reset secrets, reinstall helpers or merge that branch merely to get a green check.

Fixed reason categories should cover stale/disconnected agent, locally disabled
sharing, missing screen/control permission, wrong device/display, gateway absent,
native approval pending and unresolved prior effect. Only claim “Mac asleep” when
an explicit local signal supports it; an unreachable gateway means unreachable.
Show a concrete next step and check timestamp. A read-only recheck must never call,
capture, input, enable, reset TCC, install software or acquire a new lease.

Ship a deterministic simulated full journey using fake transport/device/model
adapters and synthetic content: readiness failure → correction → request binding →
speech feedback → approval pending → observed outcome → explicit end → cleanup.
Inject connector/media/gateway restart, lost acknowledgments, stale generations,
wrong session, unknown outcomes, duplicate callbacks and capacity exhaustion.
No reconnect may silently rearm a stopped screen or repeat an external effect.

Extend the physical acceptance document for a later separately authorized run:

1. Fresh intended session and correct Mac/display; local Enable and readiness.
2. One explicitly authorized call; verify phone readability in portrait/landscape.
3. At least ten predefined speech turns covering pauses, continuation, correction,
   background noise, an approval request and a long reply. Log counts/timing only.
4. Native input only under exclusive ownership, against a disposable local fixture;
   verify the visible result. Do not send a real message as a fixture.
5. Local Stop, mute, explicit end and remote hangup; confirm cleanup and that the
   next conversation cannot inherit control, text or pending commands.
6. Separately authorized clean-install/upgrade and second-Mac session isolation.
   Do not combine this with the one-call script without explicit scope.

Proposed acceptance gate: all scripted turns accounted for, zero duplicates or
cross-session delivery, zero unauthorized effects, no false success state, correct
cleanup, and recorded latency distributions. This is a small acceptance sample,
not proof of production-wide reliability. Repeated multi-session and clean-install
qualification must precede general availability.

**Files:** existing readiness/doctor/onboarding code, `tests/` harness,
`docs/DEMO_ACCEPTANCE.md`, `docs/STATUS.md`, `docs/CONNECTORS.md`, `mac/README.md`.

**Acceptance:** isolated journey and fault suite pass; a fresh tester receives a
specific next step rather than generic “not ready”; documented live gates remain
marked unrun. Source tests/builds must not launch or replace the installed app.

### G. Deferred product expansion and public-release gates

Not required for the `improvements` implementation:

- Text-to-resume known sessions, then general Messages task initiation. Requires
  explicit session selection, authenticated routing and separate product scope.
- Optional screenshot/result delivery to Messages. Requires specific capture/send
  consent, correct recipient binding, attachment privacy and durable send receipts.
- A custom CUA executor or Agent-S default. Benchmark measured bottlenecks first;
  keep the original agent as owner and existing native/fallback policy intact.
- Full duplex/barge-in, touch-driven phone control, multiple agent VMs, new agent
  adapters, public line pooling, billing or broad multi-tenant deployment.
- Automatic spoken updates for every intermediate action. Would need a designed
  multi-reply speech protocol with cancellation and deduplication, not ad hoc IDs.

Public production gates also include stable signed/notarized distribution,
clean-install/upgrade/rollback evidence, per-device credential isolation (the
multi-device branch documents a shared gateway key), operator monitoring and
capacity/retention limits. Those gates are not satisfied by adding an attractive
panel. Document them; do not silently broaden this branch into an infrastructure
rewrite or rotate live credentials.

## 6. Implementation order, integration and compatibility

1. Record current commit/status and read current docs; compare relevant newer work
   without overwriting it. Create/use `improvements` only when implementation starts.
2. Baseline relevant isolated tests and capture a synthetic before report.
3. Implement A and compatibility tests; define exact TS/Python/Swift mappings and
   retention before wiring UI consumers. The lead integrates shared contracts.
4. Implement B and C on that contract; synthetic visual review on Mac and phone
   layouts. Include forwarding/version tests for gateway and helper.
5. Implement D without adding message/call effects; exercise receipt replay.
6. Implement E and F, compare synthetic timings and complete fault coverage.
7. Update docs, run final relevant checks, inspect diff for secrets/generated files,
   commit reviewable slices on `improvements`, and report physical gaps.

Old helpers/servers must degrade to existing status rather than reject an otherwise
valid conversation. Do not send optional fields until capability support is known;
test old/new combinations. A future deployment must coordinate backend/media and
helper/connector support, with rollback that preserves original effects, cursors,
receipts and uncertain outcomes. No destructive schema conversion or automatic
installed-component upgrade is authorized here.

If working with authorized specialists later, use existing file ownership and one
lead for shared contracts/manifests. This handoff does not itself launch another
agent; one implementer can execute dependency steps serially. Resolve any active
ownership conflicts before editing, and do not introduce concurrent live owners.

## 7. Verification and definition of done

Use Node 24+ and the repository's existing isolated environments. Do not install
into deployed or sibling environments. Relevant documented commands:

```sh
npm run check
npm run test:onboarding:browser
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
```

From `mac/`, run `swift test` and `swift build`. Packaging is optional validation;
it must not install/launch/restart the companion. Use focused tests while developing
and relevant complete suites once the integrated change is ready. Never run the
competitor's service-exercising scripts against this machine's live services.
Do not invoke `test:connectors:real` without checking its actual effects and separate
authorization for anything involving live calls, credentials or provider activity.

Required evidence beyond command exit status:

- Protocol fixtures cross TS/Python/Swift, old/new versions and stale epochs.
- Rendered synthetic panel/caption evidence: narrow phone view, long text, Unicode,
  large text, dark/light contrast, no stale private text after close.
- Integration assertions: no outbound calls/messages/input from metadata, outcomes,
  diagnostics or rechecks; terminal updates do not end a v2 call.
- Fault coverage: unknown/replayed/out-of-order states, retained receipts, restart,
  isolation, clearing, bounded memory/storage and log/export redaction.
- A status entry listing implemented, locally verified and physically unverified
  separately; no test count carried forward without rerunning that suite.
- An implementation summary with commits, tests, limitations and rollout prerequisites.

The authorized implementer must complete A–F, commit the intended source/tests/docs
on `improvements`, push using `git push -u origin improvements`, and verify the
remote commit. Stop before merge, installation, deployment or physical calls.
