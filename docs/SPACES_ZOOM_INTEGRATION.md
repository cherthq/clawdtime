# Desktop switching and automatic zoom integration

November 21, 2026. Branch: `spaces-zoom-integration`.

The combined source and automated builds are ready for an arranged physical
acceptance session. No physical acceptance, app installation, service restart,
phone-line use, or merge into main was performed during integration.

## Sources and integration changes

- Main baseline: `75193d97c0a194de7b37aa1136477cdf4e4e349f`.
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

## Automated evidence

Run in an isolated worktree using Node 24.22.1, Apple Swift 6.2.4, and Python
3.14.0 with a per-worktree virtual environment:

| Check                                                                                  | Result                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npm run check`                                                                        | 3,852 tests in 124 files; typecheck and build passed |
| `npm --prefix line test`                                                               | 92 tests passed                                      |
| `cd mac && swift test`                                                                 | 284 tests passed                                     |
| `cd mac && swift build --product ClawdTimeTaskPanel`                                   | Passed                                               |
| `media/.venv/bin/python -m unittest discover -s media -p 'test_task_presentation*.py'` | 36 tests passed                                      |
| Actual line agent import and JavaScript syntax                                         | Passed without starting the agent                    |
| Integration diff/changed-file formatting                                               | Passed                                               |

Four new composed Swift regressions exercise desktop epoch/settlement policies
with the presentation latch: verified arrival/fresh context, unchanged boundary
timeout, Stop/stale callbacks, and destination invalidation during settlement.
Independent reviews found no blocking integration issue.

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

1. A sole display and two ordinary desktops, with no full-screen or Split View
   windows. Put distinct disposable TextEdit documents on the desktops, such as
   `Disposable Spaces Fixture A` and `Disposable Spaces Fixture B`. Use only
   throwaway content, and do not assign TextEdit to all desktops.
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

1. Verify one right move, one left move, and previous as separate requests.
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
[zoom acceptance](AUTOMATIC_CALL_ZOOM.md). Full-screen, Split View, multi-display,
and actual phone display-follow behavior remain unqualified until tested.

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
