# Desktop switching and automatic zoom integration

November 21, 2026. Branch: `spaces-zoom-integration`.

The branch combines desktop navigation and automatic zoom, and now adds dynamic
app/desktop intent, previous-app switching and full-screen arrival verification.
See [the current navigation plan](APP_DESKTOP_NAVIGATION_PLAN.md). Local app and desktop round trips are now physically verified on the isolated
test build. Phone screen-sharing/zoom acceptance is being prepared separately.
The installed app has not been replaced.

## Sources and integration changes

- Original main baseline: `75193d97c0a194de7b37aa1136477cdf4e4e349f`.
- Main refreshed through `fc2bfe4` (PRs #54/#55); job-result reporting preserved.
- PR #51: `6942cb51e88c8eaf8ead699217dedd9ddbda0540`.
- PR #53: `420b08cb20fd182fec252c226b1bb5bb09b72327`.

Both PR histories are preserved. Conflicts in `HandsController.swift`,
`line/agent.mjs`, and `line/package.json` were resolved to retain both features.
The desktop lifecycle callback now feeds the persistent presentation latch after
command initialization. Verified arrival does not itself restore zoom: the
presentation producer must obtain fresh destination context. Stop, takeover,
failed/unknown input, and failed result delivery retire presentation without
weakening desktop input leases or replay protection.

The phone agent retains both final-transcript consumers, one-use directional
requests, zoom controls, and unified cleanup. A call-end check after waiting for
transcript binding prevents dispatch after teardown. The line test script runs
all test files, including both features.

The standard desktop launcher previously filtered out the shortcut environment.
It now forwards `CLAWDTIME_SPACE_LEFT_SHORTCUT`,
`CLAWDTIME_SPACE_RIGHT_SHORTCUT`, and `CLAWDTIME_DESKTOP_SWITCHING` to the panel
only. Missing settings remain missing; no shortcut defaults or macOS settings
changes are introduced. Tests cover initial launch and service reattachment.

## Dynamic app and desktop navigation

The fixed directional phrase grammar has been removed. The supervisor and worker
interpret the original human request with goal-only structured model calls;
screenshots, accessible text, page content and planner history cannot supply
navigation intent. Each standalone app, previous-app or desktop request executes
at most one transition. Ambiguous/multi-hop requests clarify; malformed responses
fail closed. Phone tools forward one fresh complete caller transcript, preserving
negations and qualifiers, with duplicate/stale/partial-speech retirement.

Named apps use existing exact app/window activation; multiple matches require an
exact target. Previous app uses Command–Tab once and requires a changed foreground
app plus stable fresh window evidence. Previous desktop retains its separate
verified-transition history. Generic key commands cannot bypass these paths.

Full-screen navigation now requires positive AXFullScreen evidence on one display
and matching full-width geometry. A narrow same-app system top strip may precede
the focused window only if it is not exposed as an AX window/dialog. Other overlays,
Split View, multiple displays, missing evidence and ambiguous windows remain
blocking. All transitions retain the existing wide-video latch and retire old
coordinates. The local full-screen/Command–Tab round trip passed below; phone video behavior
still needs physical testing.

The access/navigation setup menu reports permissions, explicit shortcut readiness
and the saved app-to-Space preference. That preference is advisory; an unreadable
value is unknown, and no system settings are changed.

## Automated evidence

Run in an isolated worktree using Node 24.22.1, Apple Swift 6.2.4, and Python
3.14.0 with a per-worktree virtual environment:

| Check                                                                                  | Result                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npm run check`                                                                        | 3,938 tests in 126 files; typecheck and build passed |
| `npm --prefix line test`                                                               | 105 tests passed                                     |
| `cd mac && swift test`                                                                 | 295 tests passed                                     |
| `cd mac && swift build --product ClawdTimeTaskPanel`                                   | Passed                                               |
| `media/.venv/bin/python -m unittest discover -s media -p 'test_task_presentation*.py'` | 36 tests passed                                      |
| Actual line agent import and JavaScript syntax                                         | Passed without starting the agent                    |
| Integration diff/changed-file formatting                                               | Passed                                               |

The original integration added four composed Swift regressions exercising desktop epoch/settlement policies
with the presentation latch: verified arrival/fresh context, unchanged boundary
timeout, Stop/stale callbacks, and destination invalidation during settlement.
Independent reviews found no blocking integration issue.

The navigation extension adds eight native policy tests and goal-only model,
transcript, Stop, task-question race and job-news isolation regressions. A headless
smoke check against the real default computer model (`gpt-4.1`) matched expected
intent on 10/10 synthetic requests: app/window and directional paraphrases,
previous app/desktop, negation, quoted text, a multi-step clarification and ordinary
job follow-ups. It sent no UI input. These samples do not guarantee interpretation
of every future request. Current-main job-result tests passed with the extension.

The repository-wide formatting check still reports six files unchanged from the
main baseline: `src/control/task-desktop-calls-config.ts`,
`tests/backend-task-voice-ledger.test.ts`, `docs/BUILD_LOG.md`,
`docs/CODING_DEMO_IMPLEMENTATION_PLAN.md`, `docs/DEVICE.md`, and
`docs/MEDIA_INTEGRATION.md`. These pre-existing formatting issues were not
rewritten as part of this integration. The changed desktop guide was formatted.
Synthetic performance figures remain those reported in the zoom PR; they are not
measurements of this combined build on a real call.

## Physical test handoff

One coordinating session owns all physical input. Other chats may continue file
work, but no other controller may act on the test Mac. Do not interpret passing
automated tests as permission to start capture, launch a second live line owner,
or replace the installed app.

The person prepares:

1. A sole display, a disposable TextEdit document, and a second named app. The
   second app may be full-screen for the new acceptance case. For the separate
   ordinary-desktop regression, use distinct disposable documents on adjacent
   ordinary desktops. Keep Split View off; use only throwaway content for edits.
2. In System Settings → Keyboard → Keyboard Shortcuts → Mission Control, enable
   Move left a space and Move right a space and report their exact combinations.
   The test launcher receives those values; do not assume Control-arrow defaults.
   For reproducibility, manually disable automatic Space rearrangement and note
   the setting. Do not change other display/Space settings during the first pass.
3. An exclusive hands-off interval. The person watches, uses Stop when requested,
   and tests takeover only at the agreed point. This is foreground control and
   cannot run while the person independently uses another Space.
4. Grant Accessibility and Screen & System Audio Recording to the exact test
   panel if macOS requests them. Old app grants may not cover the separate build.
5. After local acceptance, have the phone available for an arranged incoming
   call. Do not place the call until the coordinator confirms the single line
   owner and matching combined line build are ready.

The coordinator prepares the separately built panel at
`mac/.build/debug/ClawdTimeTaskPanel` and compiled service/CLI under `dist/`.
Use private fixture configuration/state, a disposable selected project, and a
free loopback port. Select the native computer worker with its explicit switch
and protected model credentials; keep the coding worker in simulation. Agent
board support is required for this native engine. Do not attach a bundled or
external executor, phone actors, or presentation actors to the fixture service.
The launch command and private paths must be checked before launch; use the
integration CLI so the explicit shortcut environment reaches the panel.

For the later phone stage, use the combined `line/` source, matching fixture
service discovery (`CLAWDTIME_DESKTOP_STATE`), intended private
`CLAWDTIME_CONFIG_HOME`, and `CLAWDTIME_LINE_SCREEN_DEVICE="Capture screen 0"`.
A phone test against the old installed service/line is not combined acceptance.
Arrange any required idle handoff separately, preserving existing configuration,
receipts, unknown outcomes, and rollback. Never run two owners for the line.

## Acceptance order and pass conditions

1. First verify named-app switching and previous-app switching, including an
   ordinary/full-screen pair. Then verify one right move, one left move, and
   previous desktop as separate requests.
   Independently confirm the actual destination before another request. After
   a fresh observation, make a harmless TextEdit edit in the intended document.
2. During a shared-video pass, start with an action zoomed in. Request a desktop
   transition: the camera must widen, remain wide through settlement, and never
   reuse source coordinates. Fresh destination actions can zoom afterward.
3. Check clicks, focused-field typing, distant targets, long cursor labels and
   screen edges in Fit and Fill. Large fields may intentionally reduce zoom;
   this tracks the field rather than the caret.
4. Say “show the whole screen”; subsequent actions and “enable automatic zoom”
   must leave overview latched. “Resume automatic zoom” releases it. Check a
   subsequent call does not inherit stale targets and does retain overview.
5. Test Stop/takeover and a boundary with no adjacent desktop. An unverified
   dispatched transition remains unknown; inspect and reconcile before the next
   request. Never retry it automatically. Check missing/disabled shortcuts refuse
   before dispatch, and that normal editing still works with switching disabled.
6. Verify capture loss retires the old picture, hide/hangup clears capture, and
   voice remains responsive. Run a longer call to assess readability, latency,
   memory, CPU, bandwidth and thermals. Do not retain private screens in Git.

Use the full matrices in [desktop acceptance](DESKTOP_SPACES.md) and
[zoom acceptance](AUTOMATIC_CALL_ZOOM.md). The tested single-display full-screen pair passed locally; actual phone
display-follow behavior remains unqualified. Split View and multi-display
navigation remain unsupported.

## Initial physical preflight findings

The first arranged Mac run exposed a real shortcut mismatch: the public Carbon
inventory includes `kEventKeyModifierFnMask` on the enabled Control–Left/Right
arrows. Commit `9ce7880` resolves that bit only for named adjacent arrows and
preserves it in dispatch flags. Unknown modifiers and unsupported explicit Fn
configurations remain refused; final inventory validation is still exact.

A separate window-sharing session exposed an AX dialog containing
`WindowSharingSessionButton` ahead of TextEdit's ordinary window. Exact-window
verification conservatively refused that arrangement. The control subsequently
disappeared; no exclusion for arbitrary dialogs was added. The person reconciled
the observed window activation. Subsequent initial-observation failures coincided
with externally observed Space/application changes and sent no desktop shortcut.

Initial observation failures now report bounded error codes, takeover, or missing
surface evidence separately. These diagnostics retain Stop/unknown safeguards.
The person subsequently confirmed three single-dispatch physical moves: right,
left, then right. Automatic arrival verification returned unknown each time;
no shortcut was retried, and each outcome was reconciled with the person before
new work. Read-only AX checks identified full-screen destination windows on the
left and final right attempts. These results establish physical directional input,
not verified arrival or safe continuation on the destination.

The fixture inventory then contained only one ordinary TextEdit window. The next
pass requires two distinct ordinary windows on adjacent ordinary desktops, with
full-screen Spaces outside that pair. The isolated test computer switch is off;
the installed Supervisor switch was restored to its recorded prior enabled state.
Receipts remain intact. Verified left/right/previous, destination editing, zoom,
and phone-video acceptance remain pending.

## Named-app physical preflight and follow-up

The first PR #56 named-app attempt interpreted the request correctly but refused
before activation: the running target had off-Space Quartz windows while its AX
window inventory successfully returned empty. No Command–Tab follow-up was sent.
The test controller was paused and normal Supervisor control restored.

The native follow-up permits one activation of a specifically named running app
only when no exact window was requested and its AX inventory was successfully
empty. It then performs bounded read-only discovery and verification, with no
second activation, restore or raise. AX errors, exact-window requests and
ambiguity do not widen into this path. A final authority check follows the last
AX read so takeover during that read prevents input. Three regression tests were
added; 295 Swift tests and the panel build passed. Physical verification of this follow-up passed as recorded below.

## Verified local round trips and phone preparation

On November 21, the isolated native test build at `c9e4145` completed these
one-step requests on one display with TextEdit on an ordinary desktop and a
full-screen second app:

- Bring the named app into view, then return to the previous app.
- Move one desktop right, then one desktop left.

Each request passed the controller's arrival verification. Independent native
foreground/window checks confirmed the destination, and the person confirmed
both visible round trips. The requests used natural paraphrases through the
model, not a scripted directional phrase match. No destination edit was made.
The test computer was switched off and the installed Supervisor's prior computer
setting restored afterward. Earlier unknown outcomes above remain historical
evidence, not the result of this later build.

For phone acceptance, stage the integration line agent with its own agent name
and health port, and pin its CLI to the isolated service/configuration/project.
An unavailable test service must refuse rather than fall back to another
controller. Reuse the existing protected credential source without copying it.
Verify the line is idle and the existing owner matches its receipt; gracefully
release that owner and confirm a new release event before claiming the same
line for the bounded test. Preserve the original source/configuration and
receipts for rollback. Do not place an outgoing call.

Phone video/zoom, destination editing, previous-desktop history, live takeover,
and longer-call performance remain pending. Local navigation success does not
qualify those paths or broader desktop arrangements.

Before the phone pass, the transport boundary was hardened to reject requests
over 2,000 characters before normalization or dispatch instead of silently
truncating a trailing prohibition. A refusal cannot fall back to another
executor. Direct task-service software goals retain their existing complete
8,000-character limit and cannot fall through into navigation when oversized.
The updated backend/typecheck/build and 98 line tests passed.

## First phone test and speech validation correction

The November 21 call ran from 11:46:58 to 11:49:09 America/New_York. The sharing
tool was invoked at 11:47:19; five Mac-request tool invocations followed. None
reached the desktop chat journal, and the computer worker remained idle at step
zero. The person reported repeated generic processing failures and recalls a
request to type a short word into the Codex textbox. Phone typing and zoom were
therefore not qualified.

The exact-text binder independently rejected harmless punctuation and case
differences between the separate transcription and voice model tool argument.
This is the leading explanation, not a proven per-request diagnosis: the
historical test log omitted binder/transport result codes. The correction removes
model-written request text from the tool and binds the complete final transcript
to its provider utterance and SDK response instead. See the updated
[navigation plan](APP_DESKTOP_NAVIGATION_PLAN.md). No speech-recognition phrase
list or fuzzy wording match replaces the removed comparison.

The test line released with zero retained calls. The original phone agent was
restored and independently confirmed as the sole connected owner; the test
computer switch is off and the installed Supervisor's prior switch is restored.
The correction needs a separately arranged repeat call; earlier local app and
desktop round-trip evidence remains valid.

For the repeat phone test, use a disposable unsent textbox or TextEdit document.
Ask naturally to show the screen, then ask to type a short test word without
pressing Enter or submitting it. Verify the actual text independently and inspect
the new reason codes if forwarding fails. Also exercise sharing followed by
typing within one utterance, natural zoom/overview/resume wording, a correction
during speech, and Stop. Do not replay an uncertain typing request automatically.
The implementation removes model-text comparison for every Mac request, not
only navigation; native post-action verification remains required.

The speech correction passed 105 line tests, including 22 runtime-wiring cases
using the actual SDK tool wrappers and response handles. A separate headless
smoke fed locally synthesized speech through the real `gpt-realtime` provider
and LiveKit SDK 1.8.0, with all Mac and sharing effects stubbed. Both the direct
Codex typing request and sharing-then-typing continuation forwarded the complete
provider transcript exactly once, retaining the no-submission constraint. This
used no phone call or computer input and is not handset/zoom acceptance.
The full backend/typecheck/build passed 3,938 tests; native and Python
presentation source are unchanged by this speech correction.

## Second phone test: avatar startup remains blocked

The corrected build was handed the idle line at 12:38:53 ET on November 21. The
next call was accepted at 12:41:57, reported provider media at 12:42:14, and ended
at 12:42:32. The person saw no avatar. No agent `call_started`, greeting, or
speech-binding event was recorded, and no provider bridge-ready event appeared.
This is an unresolved startup/media-readiness failure, not evidence that the
synthetic speech-forwarding checks failed. The test worker remained idle.

The test owner released with zero retained calls, and the normal owner was
restored and independently verified as sole connected owner. Test computer use
is off; normal control is restored. Continue from the comprehensive
[phone and zoom handoff](PHONE_ZOOM_TEST_HANDOFF.md), which records the runtime
paths, investigation boundary, rollback rules and remaining acceptance matrix.

## Startup lifecycle investigation and regression protection

The afternoon November 21 investigation reproduced successful actual SDK
entrypoint startup when a synthetic caller joins, and reproduced the historical
`call_ended`-without-`call_started` shape when an empty room disconnects. The
retained failed phone call has no bridge-ready event and ended remotely; its
historical root cause remains unresolved. Provider `call_media` alone is only a
media assessment, not caller readiness.

Startup now verifies the caller remains in the connected room after the wait,
prevents publication/model startup after an immediate departure, awaits shared
cleanup completion, and refuses to proceed after a failed initial avatar frame.
Bounded stage/room-count/error-source diagnostics make a subsequent provider
boundary failure distinguishable without retaining private content. The complete
transcript/provider-turn speech design is unchanged.

An opt-in isolated LiveKit room smoke exercised the real worker, receiving avatar
frames and audible greeting samples from the same publisher, then confirming
caller-disconnect cleanup, room deletion and worker exit. It used no phone line,
Mac input or screen capture; its bridge-ready mark was synthetic. Physical
avatar/audio, sharing and the remaining matrix still require observation.

Current checks: 3,946 backend/combined tests across 127 files, typecheck/build,
and 113 standalone line tests passed. Eight new startup cases use the actual
SDK waiter and real RTC video classes. Native/Python code remains unchanged.
See the [latest handoff](PHONE_ZOOM_TEST_HANDOFF.md) for scope and remaining gaps.
