# App and desktop navigation with automatic zoom

Approved November 21, 2026. Implementation branch: `spaces-zoom-integration`.
This extends the combined PR #51/#53 plan; it retains both app navigation and
adjacent desktop navigation. Source/build checks precede a separately arranged
physical test. No installation replacement, phone-line handoff, or merge is part
of this implementation step.

## Intended behavior

| Human intent                                     | Action                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Reach a named application or a particular window | Activate that exact app/window and verify the visible destination.                        |
| Return to the previously used application        | Send Command–Tab once, then verify a different foreground app and fresh visible window.   |
| Move left or right one desktop                   | Send the explicitly configured Mission Control shortcut once and verify the destination.  |
| Return to the previous desktop                   | Invert the last verified adjacent move, only while its destination/history remains valid. |
| Ambiguous, compound, or multi-hop navigation     | Ask for clarification before navigation; do not guess or cycle.                           |

These are intents, not a list of recognized phrases. Requests are interpreted by
an isolated model call with a strict structured output. It receives the original
human request, not screenshots, page content, accessibility labels, tool results,
or previous planner steps. App names and window titles are data, not a hardcoded
list. Structured enums constrain executable actions; they do not constrain the
person's vocabulary. Invalid output or unavailable interpretation fails closed.
Model interpretation can still misunderstand language; automated schema tests do
not prove semantic accuracy for every utterance.

## Request routing and execution

1. Route native navigation semantically through the supervisor and worker.
   Remove the fixed directional phrase grammar from production paths.
2. Bind phone requests to one fresh, finalized caller transcript from the same
   call using provider utterance identity and the SDK response handle. Never
   require exact wording, punctuation, capitalization, fuzzy similarity, or a
   phrase list to match a model-generated request. The request tool takes no
   model-written instruction; it forwards the complete stored human transcript.
   Consume that request before dispatch, including delivery failures. New speech,
   duplicate/stale events, transcription failure, interruption and call end must
   not revive it. Local Stop remains available independently of transcription.
3. Resolve a worker navigation intent once, then perform at most one transition.
   Do not expose directional/previous-app commands to the screenshot planner.
4. Require permissions, exclusive control, fresh source evidence and local Stop
   checks. Retire old screenshots, browser context and coordinate targets when
   navigation begins. Preserve unknown effects and never retry them automatically.
5. For a named app with multiple candidate windows, require an unambiguous exact
   window target; explain ambiguity without choosing arbitrarily.
6. Some background apps expose an empty Accessibility window inventory until
   activated. For a named running app with no exact window requested, a successful
   empty inventory may permit one app activation, followed only by bounded window
   discovery and verification. An unreadable inventory or exact-window request
   must not use this path. Missing/ambiguous evidence after activation stays unknown.

## Native app and Space behavior

Keep the existing direct app/window activation path as the preferred method for
named destinations. Command–Tab is reserved for the previous-app intent; recent
app order is not a stable address for a named app. Previous app and previous
desktop have different histories and must never be substituted for one another.

Extend arrival verification to single-display full-screen app windows with
positive Accessibility evidence and matching visible Quartz geometry. Account
narrowly for macOS full-screen auxiliary strips; do not ignore arbitrary dialogs,
overlays or other-app windows. Continue rejecting unsupported/ambiguous Split
View, multiple displays, empty destinations and missing evidence. Verify a stable
visible target and a fresh observation before permitting later input.

The application does not maintain an inventory of all Spaces or assume that a
particular app lives at a fixed desktop number. Adjacent movement can reach a
full-screen Space. If verification fails after dispatch, report unknown arrival
and wait for reconciliation even when the OS visibly moved.

## Portable setup

Show navigation readiness in the existing setup UI: Accessibility, Screen
Recording, configured/enabled left/right shortcuts, and the Mission Control
setting that controls whether activating an app changes to its Space. Report an
unreadable setting as unknown. Do not change system preferences automatically.

Control–Left/Right are common macOS combinations, but each installation must
explicitly configure its actual enabled shortcuts. Read-only public shortcut
inventory checks validate the combinations, not their semantic action names.
The previous-app path uses the standard Command–Tab mechanism. Setup must explain
that disabled app-to-Space switching can prevent a named app from becoming visible.

## Sharing and automatic zoom

All app/desktop transitions use the same presentation lifecycle: widen at
transition start, remain wide through settlement, discard old targets, and allow
zoom only after fresh destination context. Stop, takeover, capture loss, unknown
arrival and call end retain their existing retirement behavior. Switching does
not grant a broader screen-sharing source or silently replace an authorized
window capture. The phone test must use the matching combined build and an
explicitly authorized capture source.

## Verification and handoff

Automated checks cover strict wire contracts, goal-only inference, paraphrases,
malformed/ambiguous output, caller transcript provenance, one-use dispatch,
Stop/takeover, stale observations, unknown outcomes, previous-app versus previous-
desktop behavior, exact-window ambiguity, full-screen evidence and zoom retirement.
Run `npm run check`, line tests, Swift tests/panel build, presentation Python tests,
and changed-file formatting/diff checks. Check compatibility with current main.

Physical acceptance then covers named apps (including multiple windows), previous
app, one left/right desktop move, full-screen destinations, and a harmless edit
only after verified arrival. During an arranged shared-video test, verify wide
transitions, fresh-context zoom, overview/resume, responsive voice and Stop. The
already observed left/right shortcut movement remains valid evidence, but is not
proof of automatic arrival verification or shared-video behavior.

Record implementation, automated results and remaining physical gaps in
[the integration record](SPACES_ZOOM_INTEGRATION.md). Open a reviewable PR targeting
main; do not merge or replace the installed application during this step.

## Speech validation correction after the first phone test

The November 21 phone test reached sharing and invoked the Mac request tool five
times, but delivered no requests to the desktop service. The exact-text binder
was independently reproduced rejecting punctuation/case changes between the
voice model and the separate transcript. Historical logs did not retain enough
reason metadata to prove each call's individual refusal.

The correction must bind identity rather than wording: wait for a successful
provider final for the current input item, explicitly generate its response, and
bind that SDK response handle (and its tool continuations) to the stored complete
transcript. Automatic VAD response creation must be disabled so a response cannot
race ahead of that binding. Failed transcription cannot authorize the SDK's
partial-text fallback. Proactive/greeting responses have no computer authority.
Use the same turn identity for screen sharing, zoom and picture framing, with
separate one-use capabilities so sharing can precede a computer request in the
same turn. Interpret zoom/framing dynamically rather than through phrase lists;
hide and emergency Stop remain authority-reducing operations. Log bounded
outcome/rejection codes, never transcripts, audio, or screen content.

Regression coverage must include the reported Codex textbox typing request,
free phrasing, punctuation/case variations, preservation of trailing negations,
SDK event ordering, duplicate callbacks/tools, late older finals, interruption,
call teardown, and delayed or failed transcription. No exact text-matching
requirement may be reintroduced as a shortcut for turn identity. A new physical
phone/typing/zoom test is still required after automated validation.
