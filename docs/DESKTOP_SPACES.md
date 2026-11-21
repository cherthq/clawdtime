# Verified desktop activation

Track A, November 21, 2026. Implemented for the native panel computer worker;
physical acceptance is pending. This is foreground work: the person cannot use
another Space independently while these hands control the Mac.

## Behavior

Ask the native worker to “switch to the TextEdit window” or “bring the TextEdit
window named Disposable Spaces Fixture forward.” Its `open_app` action accepts
an app name or bundle ID and an optional **exact** `window` title. App-only
selection requires one matching ordinary window. Multiple matching apps or
windows block without choosing the first. A validated plain app-opening request
handled by the supervisor also goes through this worker when it is the selected
native engine. URL opening, terminal-session selection, and other execution
engines retain their existing routes.

The panel selects the AX window, restores it if minimized, and requests supported
activation/raise operations. It never selects a sibling merely because that
window is already visible. For an absent running app it may launch the installed
application once; a launch that does not yield a verifiable ordinary window is
an unknown outcome, not success. An app or exact target that cannot be resolved
before any external effect gets a definite refusal.

Readiness requires the same AX window to be focused, its app to be frontmost,
and a unique matching on-screen Quartz window to agree on owner, title and
geometry. The selected window must be the front ordinary window and wholly on
the main display. Repeated observations must agree for at least 600 ms, with
at least three samples within five seconds. Space-generation changes reset
settling. A fresh screenshot and accessibility observation are bracketed by
identity checks before success is reported. A successful API call or a Space
notification alone is never readiness.

The bar reports switching, waiting for the target, verified, or blocked. No
subsequent click/type is dispatched during settling. Each activation/restoration/
raise effect is attempted at most once; subsequent work only observes. If an
effect was submitted and verification, permissions, Stop, takeover, or connection
checks fail, the result is `transition_unknown`. The worker preserves that
uncertainty across restart and blocks new work until the person inspects the
screen and explicitly clears the journal through `clawdtime computer clear`.
Clearing is reconciliation, not permission to replay the original request.

## Freshness and interruption

The previous screenshot, coordinates, and browser page are retired before
activation. Observations carry a native `surfaceEpoch`; a changed or missing
epoch prevents the worker from adapting an old plan to a newly observed screen,
even if the app and window titles look identical. Display size/scale changes
also refuse old-frame actions. A successful activation returns its verified
observation, and the worker still obtains a new full observation for its next
plan. Older panels that only acknowledge `open_app` without this evidence cannot
claim success with the new worker.

The panel retains one transient observation lease. Space, app, display, sleep,
session, Stop, and service changes invalidate it. Window identity and geometry
are checked around capture, after the guided cursor, and before input. The
lease expires after two seconds; a normal input consumes it without pretending
that every focus click changes the desktop identity. No presentation coordinates
enter this path.

Takeover before meaningful input remains a pause/continue decision. If typing,
clicking, scrolling, or dragging already began and then fails, `input_unknown`
preserves the possibly partial effect and blocks automatic replay. Real Stop
takes priority over a simultaneous takeover before dispatch.

Accessibility, Screen Recording, the active unlocked console session, the
listening takeover tap, local Stop, and the service's running state are required.
Polling and waits do not suppress local Stop. A held mouse button/key is still
released when input is interrupted. The existing computer switch and selected
execution engine remain the admission boundary; this feature does not create a
second controller or grant a session new authority.

## Supported mechanisms and limits

Research host: macOS **15.8.1 (24H32)**. This is OS inspection, not physical
qualification. Current main was freshly fetched at
`e82bf2ce3648b3b80aff7b64a90f1781861f2ee4`; it matched the historical baseline.
Recent merged PRs through #50 were inspected. The native engine and its existing
post-cursor Stop checks are retained. The separate background-control branch and
draft [PR #38](https://github.com/cherthq/clawdtime/pull/38) are not dependencies.

- Apple's [Spaces guide](https://support.apple.com/en-ae/guide/mac-help/mh14112/27/mac/27)
  documents application-driven desktop changes and the Mission Control setting
  that controls them. The implementation does not change that setting.
- [NSRunningApplication activation](<https://developer.apple.com/documentation/appkit/nsrunningapplication/activate(options:)>)
  requests app activation; it does not attest to a particular target window.
  [AXRaise](https://developer.apple.com/documentation/applicationservices/kaxraiseaction)
  brings a window forward subject to the app's circumstances.
- Quartz's [on-screen window list](https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenonly)
  supplies an independent front-to-back visibility witness. It is not a public
  enumeration of all Spaces or a target-Space address.
- [Keyboard shortcuts can be changed or conflict](https://support.apple.com/en-gb/guide/mac-help/mchlp2864/27/mac/27).
  The installed public SDK's `CarbonEvents.h`, `CopySymbolicHotKeys` documentation
  says its returned dictionaries cannot be mapped to particular Keyboard settings
  actions. They expose keycode/modifiers/enabled, not a reliable target-to-Space
  mapping. Reading private Dock/symbolic-hotkey IDs would not supply supported
  window-to-Space addressing either.

**No shortcut fallback is enabled.** Research did not establish a reliable
configured shortcut plus independently addressable destination. Control-Left/
Right are not assumed configured, and no trackpad gestures, private CGS APIs,
desktop-number guesses, or blind cycling are used. If activation cannot reach
the target, the task stops with an explanation. A future bounded fallback needs
an explicitly identified destination, verified shortcut configuration, independent
arrival evidence, and its own qualification; setting a retry limit alone is
insufficient.

The worker refuses standard Control-Left/Right and Control-number desktop
chords in code. Immediately before native key dispatch, the panel also reads
the configured symbolic-hotkey inventory through `CopySymbolicHotKeys` and
refuses matching enabled system shortcuts, using the active keyboard layout.
Because that API does not identify actions, this conservatively reserves **all**
those system shortcuts, including non-Space shortcuts. If the inventory cannot
be read, modified/function shortcuts are refused; plain editing remains
available. This is a guard against a generic key action bypassing verification,
not a desktop-switching fallback. No shortcut settings are changed.

Initial scope is ordinary windows on **one active main display**. Full-screen,
Split View, multiple displays, off-main/partly off-screen windows, missing AX/CG
metadata, and ambiguous duplicate windows are not qualified. Known unsupported
configurations are refused. Stage Manager and unusual window managers also need
separate acceptance. Do not infer coverage from a successful ordinary-desktop
case. App activation depends on macOS and application behavior, so a documented
API does not guarantee it can reach every cross-Space window.

The defensive `AXFullScreen` attribute read and full-display geometry check
are not a portable public Space classifier. They reject known full-screen
surfaces; they do not qualify every full-screen/Split View implementation.

Set `CLAWDTIME_DESKTOP_SWITCHING=off` in the **panel's** launch environment to
disable activation independently of video zoom. The default is enabled only
inside the already opted-in native computer engine. This variable does not
enable computer use, start a service, or change the installed environment. Input
freshness/Stop checks remain active when desktop activation is disabled.

## Automatic zoom integration

Track B owns the presentation-event wire contract and renderer. Track A adds
only `HandsController.onDesktopTransition(phase, epoch)`, with phases
`switching`, `waiting`, `ready`, and `blocked`. The callback is synchronous and
optional; it carries no window title, text, pixels, crop, or authorization.

An integration should widen and discard presentation targets on switching,
waiting, or blocked, then establish a target from fresh native geometry after
ready. Ready is not a crop and does not revive an old action target. Track B
must also widen on independently observed app/window/display changes and expire
stale events without this branch. Control's `surfaceEpoch` can invalidate old
observations but does not define a competing video-event schema. There is no
cross-PR runtime dependency, video-code edit, or combined-system acceptance here.

Likely merge overlap: `HandsController.swift`, `HandsInput.swift`,
`HandsContract.swift`, `connectors/computer/{ports,planner,guards,worker}.ts`,
and `connectors/agents/brain.ts`. Most new behavior lives in `HandsDesktop.swift`,
`TaskPanelCore/DesktopTransition.swift`, and `connectors/computer/desktop.ts`.
No root manifest, runtime wiring, `line/`, or live installation changes are needed.

## Verification and acceptance arrangement

Final automated checks on this branch: `npm run check` passed typecheck,
**3,678 tests in 119 files**, and build. `swift test --package-path mac` passed
**243 tests**; `swift build --package-path mac --product ClawdTimeTaskPanel`
passed. `git diff --check` passed. Focused connector
regressions cover exact targeting, explicit refusals, verified-evidence requirements,
unknown outcomes across Stop/restart, mailbox non-replay, stale coordinates after
a Space round trip, and focus-click/typing interruption. Swift tests cover settling,
identity generations, observation consumption/expiry, and failure classification.
These tests use synthetic data, temporary state, and no real screen/input.

The first `npm run check` found an absent per-worktree `media/.venv/bin/python`
in two pre-existing TS/Python wire tests. Create this worktree's isolated venv and
install `media/requirements.txt` before rerunning; do not borrow installed runtime
state. Run `npm run check`, `cd mac && swift test`, and
`swift build --product ClawdTimeTaskPanel`. Builds do not launch or install.

**Physical acceptance has not been performed.** Arrange an explicit exclusive
desktop-testing handoff in the coordinating chat after review. Prefer a disposable
macOS login or spare Mac with no other active desktop controller; the running
installation must not be replaced or restarted for this test. The tester grants
Accessibility and Screen Recording to a separately built panel in that test
environment, bound to private fixture state and a separate loopback port, with
the native computer worker selected and no phone/line integration. Keep Stop
visible. No coding-agent job, real message, email, or submission is a fixture.

Prepare two ordinary desktops on the sole display and disposable TextEdit
documents with distinct titles, including `Disposable Spaces Fixture`. Arrange
the target on the other desktop and a disposable unrelated window in front.
The tester verifies arrival and a harmless unsent edit, then exercises:

1. Target already frontmost; target on another desktop; minimized target.
2. Multiple distinct windows with an exact title; no title; duplicate titles;
   missing app/window. Record definite refusal versus unknown after dispatch.
3. Window movement or Space change during planning/cursor travel; ensure the
   former-frame click and subsequent typing never land elsewhere.
4. Local Stop, service Stop, human mouse/key takeover, lock, permission loss,
   and a display change during transition. Confirm no subsequent switching/input
   and preserve any unknown receipt before clearing it.
5. Activation-setting off and disabled/custom Mission Control shortcuts. Confirm
   no shortcut is sent and a failed arrival never triggers automatic retry.
6. Full-screen, Split View, and multi-display refusal as separate cases. Successful
   ordinary-window tests do not qualify these configurations.

Record app/OS/build identities, independently observed target/geometry, result
classification, and whether the harmless edit landed correctly; retain no screen
captures or document contents in Git. Clean up only disposable fixtures. The
coordinator owns any later combined zoom/phone test, deployment, or service change.
