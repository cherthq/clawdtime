# Desktop navigation and verified window activation

Track A, November 21, 2026. Implemented for the native panel computer worker;
physical acceptance is pending. This is foreground work: the person cannot use
another Space independently while these hands control the Mac.

## Directional navigation

The native worker interprets **separate, complete requests** dynamically. These
are examples, not a phrase grammar:

- “Switch to the desktop on the left.”
- “Move one desktop right.”
- “Go back to the previous desktop.”

These use `switch_desktop { direction: left | right | previous }`, separate from
`open_app`. A goal-only structured model call interprets the original human
request before screen observation. Screen/page data and the ordinary action
planner cannot authorize desktop navigation. Ambiguous or compound directional
requests produce a clarification; each request permits at most one transition. No target
application is activated to approximate left/right. A successful request ends
immediately; it never enters the planner loop or sends follow-up input.

`previous` means the inverse of the last independently verified directional
transition in this panel session, with a verified return to that prior surface.
It is not macOS's global most-recently-used Space. External surface changes,
Stop, disconnection, or missing history make it unavailable. Starting the panel
or making an app-activation request does not manufacture history. Ordinary idle
between requests preserves verified history. Ask for left or right when no
previous destination is known.

## Previous app

Requests such as “take me back to the app I was just using” resolve to
`switch_previous_app`. The native panel sends Command–Tab once and releases both
keys, then requires a different foreground app and a stable verified visible
window. It does not cycle through apps, infer a destination from desktop history,
or promise that a named app is the most recently used one. Generic keyboard
commands cannot bypass this verified path. A missing or ambiguous destination
after dispatch remains unknown and is not retried.

The app switcher shows regular apps only. With no regular app besides the one
in front, the keys would change nothing, so the panel refuses before anything
is sent (`DesktopAppSwitch`). The worker says "There is no other app to go back
to." and nothing locks.

See [the navigation plan](APP_DESKTOP_NAVIGATION_PLAN.md) for semantic routing,
caller transcript binding and the combined acceptance matrix.

### Explicit prerequisite: user-configured shortcuts

In **System Settings → Keyboard → Keyboard Shortcuts → Mission Control**, the
operator must enable **Move left a space** and **Move right a space** and record
their actual combinations. Configure the separately launched panel environment
with those exact combinations, for example **only if those are your settings**:

```sh
CLAWDTIME_SPACE_LEFT_SHORTCUT=ctrl+left
CLAWDTIME_SPACE_RIGHT_SHORTCUT=ctrl+right
```

There are no default combinations and ClawdTime never writes macOS settings.
The environment is the operator's attestation mapping a combination to its
named Mission Control action. Immediately before dispatch, the native panel
checks that both mappings are distinct, parsable, and present/enabled in the
public `CopySymbolicHotKeys` inventory. That API does not label actions: it
cannot independently confirm the operator mapped the combination to the correct
action. Do not map arbitrary app shortcuts or direct desktop-number shortcuts.
If prerequisites cannot be established, `desktop_shortcut_unavailable` is a
predispatch refusal. Setting environment variables in a shell does not configure
an already-running panel. Arrange a separate test launch; do not restart the
live installation to try this PR.

Each request authorizes **one key-down/key-up pair**, not a desktop search.
Verification requires a post-dispatch `activeSpaceDidChange` notification and
a distinct, independently observed on-screen surface, stable for at least
600 ms/three samples within five seconds, followed by fresh bracketed capture
and AX evidence. Notification or dispatch alone is insufficient. A shortcut
disabled during dispatch, identical visible surfaces after a Space change,
missing window evidence, conflicting shortcut, animation timeout, or
interruption can leave `transition_unknown`. No blind retry occurs, including
after Stop/restart. Inspect the desktop and reconcile the journal before another
request. A predispatch refusal and a possibly completed transition are different
outcomes.

There is a third outcome: **not moved** (`desktop_unchanged`). The key went out,
no Space change was reported, and every look of the whole five-second wait
showed the same surface as before. That is the last desktop on that side, or a
shortcut that did nothing. It is known, so it is not `transition_unknown` and
nothing locks. The worker says "The desktop did not change. There may be no
desktop on that side." One look that shows nothing or another surface, one
Space change, Stop or a takeover in the wait, and the result stays unknown.

A fourth outcome is an arrival on **a desktop with no window**. No window can
be the evidence there, so the evidence is the window server itself: exactly one
Space change was reported, no window of the app in front was read, and the
window server lists no ordinary window on the display, for four looks in a row
over one second. A window, a look that is not empty, a second Space change or a
new epoch starts the count again. The observation of such a desktop gives no
lease for input, as before; an app can be opened from it. A desktop with no
window can also be left: the arrival is then a window that holds, by the rule
of every arrival. "Previous desktop" is not available from it, and a move
between two desktops that both have no window stays unknown: they look the
same. Before this, a move to an empty desktop ended as unknown and locked new
work, and a move from one was refused.

## Target-window activation

Ask the native worker to “switch to the TextEdit window” or “bring the TextEdit
window named Disposable Spaces Fixture forward.” Its `open_app` action accepts
an app name or bundle ID and an optional `window` title.

"Arrived" has one definition, in the panel (`DesktopArrival`) and in the worker
(`verifiedActivation`). The panel finds one app for the name, by its bundle
identifier, the name of the running app, its file name or its name in Finder,
and reports the bundle identifier of that app with the result. The worker
accepts the result when that app is in front, whichever form of the name was
used: "iTerm" opens an app that calls itself "iTerm2". A window title is
compared after the cleaning that every observation gets, on both sides: a
no-break space or a format character counts as a space, and a title over 200
characters is cut the same way. Two windows with the same cleaned title are
ambiguous. A validated plain app-opening request
handled by the supervisor also goes through this worker when it is the selected
native engine. URL opening, terminal-session selection, and other execution
engines retain their existing routes.

A request has one of two meanings, and "arrived" follows it.

**Only an app is named** ("open Chrome", "go to Slack"). The panel sends one
open request to macOS, as a click on the app's icon in the Dock does. A running
app comes forward with the window that it chooses, and an app that does not run
starts. Arrived means: that app is in front. The panel reads which app is in
front for up to 6 seconds, then takes the picture and the tree with the same
app in front before and after. The number of displays, the number of windows of
the app and a window that lies partly off the screen do not matter. An app that
restored two windows is in front all the same. Only an app that is not in front
when the wait is over leaves the result unknown.

**A window title is named.** The panel selects the one standard AX window with
that title, restores it if minimized, and requests supported activation/raise
operations. It never selects a sibling merely because that window is already
visible, and a title that fits more than one window blocks without choosing the
first. This path needs one display. For an absent running app it may launch the
installed application once and reads its windows for up to 6 seconds; a launch
that does not yield the verifiable window is an unknown outcome, not success.
A running app that shows no window with that title gets a definite refusal, and
nothing is activated to look for one.

An app or a window that cannot be resolved before any external effect gets a
definite refusal. A refusal of `open_app` does not end the request and does not
lock. The worker gives the planner the reason as a refused action, so that it
can use the name that this Mac knows ("Chrome" is "Google Chrome" here), leave
the title out, or tell the person why it cannot be done. That holds for a name
that matches no app, an ambiguous name or title, a title that no window has, a
named window with more than one display, and activation that is turned off.
Three refusals in a row end the request as blocked, with the last reason. A
missing Accessibility or Screen Recording right still ends the request at once,
with the sentence that names the right. A refused desktop switch or previous-app
switch still ends its request: the planner cannot send those.

For a named window, readiness requires the same AX window to be focused, its app
to be frontmost, and a unique matching on-screen Quartz window to agree on owner,
title and geometry. The selected window must be the front verified window and
wholly on the main display. Full-screen matching permits at most one same-app auxiliary
top strip under narrow geometry checks and only when AX does not expose that
strip as a window/dialog. Other overlays remain blocking. Repeated observations must agree for at least 600 ms, with
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
The worker has the same step as a method, `clear()`, so that the supervisor can
take the words "clear the computer task" from a person who has no terminal: on
a call, or away from the Mac. Every message of the worker about an unknown
result names both ways. Clearing is reconciliation, not permission to replay
the original request.

## Freshness and interruption

The previous screenshot, coordinates, and browser page are retired before
any app activation, previous-app or directional switching. Observations carry a native `surfaceEpoch`; a changed or missing
epoch prevents the worker from adapting an old plan to a newly observed screen,
even if the app and window titles look identical. Display size/scale changes
also refuse old-frame actions. Only a change of the desktop or of the display,
the session going away, and a move of the hands to another app or desktop move
`surfaceEpoch` (`DesktopObservationLease.retire`). A new window of the app in
front, the first window of an app, a list in front of it, a look with no window
and an app that comes forward by itself retire only the input lease of the
panel: the worker finds its target again in the newer look by app, window,
role, name and place, and tells the planner "Another app or window came to the
front" where the window changed. A step held for a real change of the desktop
or the display is no try of its action; a change that keeps coming gets the
wait for the screen to settle. A successful activation returns its verified
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
`75193d9` (PR #52); the branch includes that main update.
The original implementation was based on `e82bf2c`. PR #53 zoom was inspected
separately and remains an independent draft. The native engine and its existing
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

**Target-window activation has no shortcut-search fallback.** Directional
navigation is an independent, explicitly authorized operation with configured
shortcuts, not a strategy for finding an app. No gesture synthesis, private CGS
API, Space IDs, desktop-number guessing, or blind cycling is used. Apple documents
Control-Left/Right as a user mechanism, but this implementation requires the
operator's actual configured combination instead of assuming those defaults.

The worker refuses standard Control-Left/Right and Control-number desktop
chords in code. Immediately before native key dispatch, the panel also reads
the configured symbolic-hotkey inventory through `CopySymbolicHotKeys` and
refuses matching enabled system shortcuts, using the active keyboard layout.
Because that API does not identify actions, this conservatively reserves **all**
those system shortcuts, including non-Space shortcuts. If the inventory cannot
be read, modified/function shortcuts are refused; plain editing remains
available. This is a guard against a generic key action bypassing verification,
not the dedicated `switch_desktop` command. Only that command can dispatch the explicitly configured directional combination. No shortcut settings are changed.

A desktop switch, a previous-app switch and a named window support
distinguishable ordinary windows and positively verified full-screen app windows
on **one active main display**. A request that names only an app has none of
these limits. Full-screen acceptance
requires `AXFullScreen` plus full-width, near-full-height geometry. Split View,
multiple displays, off-main/partly off-screen windows, missing AX/CG evidence,
ambiguous duplicate windows and identical destination surfaces remain unsupported.
Stage Manager and unusual window managers need separate acceptance. This is an
implemented verification path; physical full-screen acceptance is still pending.
App activation also depends on macOS settings and application behavior.

The access menu's navigation setup reports permissions, configured/enabled
left/right shortcuts and the saved Mission Control app-to-Space preference.
An unreadable preference is explicitly unknown; the application never changes
these settings. Confirm “When switching to an application, switch to a Space with
open windows for the application” in System Settings when named-app activation
cannot reach the intended window.

Set `CLAWDTIME_DESKTOP_SWITCHING=off` in the **panel's** launch environment to
disable activation independently of video zoom. The default is enabled only
inside the already opted-in native computer engine. This variable does not
enable computer use, start a service, or change the installed environment. Input
freshness/Stop checks remain active when desktop activation is disabled. The
single-display and independently verified window checks apply
to a desktop switch, a previous-app switch and a named window, not to unrelated
input and not to a request that names only an app. Existing input can still use a fresh
visible main-display window on multi-display or full-screen configurations;
that does not qualify Space switching in those configurations.

## Automatic zoom integration

Track B owns the presentation-event wire contract and renderer. Track A adds
only `HandsController.onDesktopTransition(phase, epoch)`, with phases
`switching`, `waiting`, `ready`, and `blocked`. The callback is synchronous and
optional; it carries no window title, text, pixels, crop, or authorization.

An integration must **latch** widening and retire presentation targets on
switching, waiting, or blocked; suppress the ordinary target/context heartbeat
throughout settling, and release only on ready for fresh native geometry. A
one-shot hint that a polling consumer might miss is insufficient. Ready is not a crop and does not revive an old action target. Track B
must also widen on independently observed app/window/display changes and expire
stale events without this branch. Control's `surfaceEpoch` can invalidate old
observations but does not define a competing video-event schema. There is no cross-PR runtime dependency or combined-system acceptance here.

PR #53's additive producer seam is `HandsPresentation.transition()` via
`HandsController.presentationTransition()`. Call `presentation.begin(commandSeq)`
before emitting a transition. Wire the lifecycle callback to a latched producer
transition; never call `camera.control("overview")`, which is the person's
persistent manual latch. The coordinated PR #53 extension supplies an additive `presentationTransition(phase:epoch:)` latch using
`CallPresentationTransitionPhase(rawValue: phase.rawValue)`. Its v1 wire metadata
is owned by Track B and has no desktop epoch. Integration must retain these invalidation semantics without creating a
second presentation schema. Ready must never restore a saved crop.

### Screen-sharing continuity

Authorized main-display capture stays running through a same-display transition;
the command neither ends sharing nor restarts capture. In this independently
buildable PR the legacy `line/screen.mjs` path replaces its latest frame as
ffmpeg emits complete frames and returns no screen after **500 ms without a
fresh complete frame**. The renderer then shows the mascot instead of a frozen
desktop. Exit/stop clears frames and late bytes cannot resurrect capture.
Fresh frame receipt alone cannot prove the pixels show the destination: physical
screen-sharing acceptance remains required.

PR #53 replaces this legacy production path with `continuous-screen.mjs` and
`call-video.mjs`, also using a 500 ms expiry, full-display capture and no restart
for ordinary same-display Space changes. Its main-display source must match the
controlled display; numeric/non-main overrides do not qualify automatic targeting.
Display-ID/size/scale changes stop sharing and require an explicit show request.
The supported sharing route is the existing `line/agent.mjs` full-display share
with its local desktop service selecting this native ComputerWorker. The separate
v2 actors/conversation screen-control path does not instantiate this worker and
is **not** covered. Other execution engines are refused rather than substituted.
Phone tool calls must bind to a one-use final caller turn by provider identity
and SDK response handle, never by matching the model's wording. The line forwards
the complete original transcript; the model supplies no replacement instruction.
Neither branch expands a window-scoped grant to desktop capture. Use only an
already authorized full-main-display sharing session for the directional test.
For the legacy line, explicitly set `CLAWDTIME_LINE_SCREEN_DEVICE` to the sole
screen's enumerated AVFoundation device (commonly `Capture screen 0`), not an
unverified numeric camera index. [FFmpeg documents device names and enumeration](https://ffmpeg.org/ffmpeg-devices.html#avfoundation).
The existing legacy default is unchanged; it is not proof of the selected display.

Likely merge overlap: `HandsController.swift`, `HandsInput.swift`,
`HandsContract.swift`, `connectors/computer/{ports,planner,guards,worker}.ts`,
and `connectors/agents/brain.ts`. Most new behavior lives in `HandsDesktop.swift`,
`TaskPanelCore/DesktopTransition.swift`, and `connectors/computer/desktop.ts`.
The only Track A line changes are legacy `line/screen.mjs` freshness and
`line/line.test.mjs` regressions, agreed with Track B. No live installation or
root manifest change is included.

## Verification and acceptance arrangement

Final automated results for the directional extension (November 21, 2026):

- `npm run check`: typecheck, **3,809 tests in 121 files**, and build passed.
- `npm --prefix line test`: **66 tests passed**, including the final-transcript
  intent tests now included in the line test script.
- `swift test --package-path mac`: **251 tests passed**.
- `swift build --package-path mac --product ClawdTimeTaskPanel`: passed.
- `node --check line/agent.mjs` and `git diff --check`: passed.

These historical tests
covered whole-request direction parsing (now replaced by goal-only model interpretation), model-command exclusion, one dispatch,
repeat requests with fresh observation, refusal/unknown classification,
Stop/takeover, missing/stale evidence, receipt non-replay and capture expiry.
Swift tests exercise native direction/history, settling and shortcut validation.
These are synthetic tests and do not constitute physical acceptance.

The first `npm run check` found an absent per-worktree `media/.venv/bin/python`
in two pre-existing TS/Python wire tests. Create this worktree's isolated venv and
install `media/requirements.txt` before rerunning; do not borrow installed runtime
state. Run `npm run check`, `cd mac && swift test`, and
`swift build --product ClawdTimeTaskPanel`. Builds do not launch or install.

**Historical PR #51 acceptance status:** the coordinating chat was
asked for the explicit exclusive test arrangement after implementation and
checks; it confirmed no exclusive Mac-control handoff has been granted. No
Mac control, capture, app activation, live install/service change, or phone use
was performed by this implementation session. The following remains pending.
Arrange an explicit exclusive
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
5. Enable and explicitly map the actual left/right shortcuts. From desktop A,
   ask right once; independently verify desktop B in person and on the shared
   video. Ask left once and verify A. Repeat as separate requests; test previous.
   Confirm a harmless unsent TextEdit edit lands after a new observation.
6. At the left/right boundary, send one request and record the outcome not
   moved: the worker says that the desktop did not change, nothing locks, and
   there is never a second automatic dispatch. Send one request toward an empty
   desktop and record it as unknown. Reconcile that one before continuing.
7. With a shortcut disabled before dispatch, verify definite refusal. With custom
   enabled shortcuts and matching environment, verify both directions. Change a
   shortcut after preflight if practicable and ensure uncertainty/no retry.
8. Exercise actual realtime final/partial transcript ordering, opposite-direction
   model requests, repeated tool calls for one utterance, and Stop during transcript
   wait. Missing/new transcript evidence must refuse rather than reuse old speech.
9. Set `CLAWDTIME_DESKTOP_SWITCHING=off` for a separate fixture panel launch.
   Check directional/activation refusal and normal click/type still working.
10. During an arranged already-authorized full-display share, verify the phone
    follows both transitions, continues moving/live on arrival, widens during
    transition when integrated with PR #53, and cannot reuse the old zoom target.
    Pause disposable capture delivery to verify the old picture disappears after
    500 ms; resume and verify a fresh destination view. No outgoing call is a test.
11. Verify ordinary-to-full-screen and full-screen-to-ordinary transitions, named
    full-screen app activation, and previous-app switching. Confirm Split View and
    multi-display refusal of a named window and of a desktop switch separately,
    and that a request that names only an app still works there. Reconcile any
    unknown result before new work.

Record app/OS/build identities, independently observed target/geometry, result
classification, and whether the harmless edit landed correctly; retain no screen
captures or document contents in Git. Clean up only disposable fixtures. The
coordinator owns any later combined zoom/phone test, deployment, or service change.

Mission Control's **Automatically rearrange Spaces based on most recent use**
changes the desktop order; left/right means current adjacent order, not creation
order or a numbered desktop. Turn it off manually for reproducible two-desktop
acceptance. The app-switching setting affects target activation, not the
operator's explicit directional shortcut. **Displays have separate Spaces**,
Stage Manager and Split View require separate qualification. Full-screen support
is implemented but awaits physical acceptance; settings are never changed. Record all settings in the
acceptance evidence, plus actual shortcut mappings and the display capture source.

Current integration changes, checks and physical observations are recorded in
[SPACES_ZOOM_INTEGRATION.md](SPACES_ZOOM_INTEGRATION.md).
