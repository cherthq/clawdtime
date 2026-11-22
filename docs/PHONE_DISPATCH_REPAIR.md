# Phone dispatch and desktop connection repair

November 22, 2026. Local-first repair based on `abbbff2`.

## Problem and evidence

An incoming call delivered voice and video, and a status question reached the
supervisor. Subsequent action requests received spoken acknowledgements without
corresponding supervisor dispatch or a coding-job launch receipt. The installed
phone configuration also named a desktop directory with no running service.

The caller-turn code allowed a model to finish a spoken answer without invoking
the supervisor. A presentation-only tool could also finish a compound request
without dispatching its computer-work portion. Prompts asked the model to behave
correctly, but the execution boundary did not enforce that handoff.

This involved merged source plus incomplete local configuration. The code history
contains contributions from multiple authors; the evidence does not establish a
single-author regression. Source tests and a status check did not qualify actions.

A local action test also reproduced a second routing defect: asking to start a
new Claude Code session in a separate terminal window was consumed as desktop
navigation. No coding session was launched. Session creation needs its own
structured destination before an app/window interpretation can consume it.

## Local patch

- Require a tool on each authenticated caller response. Reuse one reserved
  supervisor dispatch for all tools and continuations of that original request.
- Forward complete validated words, including compound requests. Presentation
  tools provide bounded factual metadata about what they already did.
- Keep greetings and proactive announcements outside caller authority. Refuse
  failed or incomplete transcription and preserve uncertain dispatch without retry.
- Bind the phone to one authenticated desktop service instance and one expiring
  call admission. A missing service never falls back to another supervisor.
- Scope native input to that call. Close, expiry, and shutdown stop only its own
  active request; unrelated local work and already-launched coding jobs remain.
- Check call liveness before delayed supervisor effects, not only before model
  inference. Preserve local Stop, native permissions, and unknown-outcome fences.
- Report a requested session launch as requested until an observed launch receipt
  exists. Diagnose desktop connection, task admission, and computer execution
  separately. Resolve the CLI entrypoint through its installed symlink.
- Classify new coding-session creation separately from bringing an existing app
  or window forward. Preserve the complete request and its constraints when
  launching the selected coding agent.

The local rollout pauses automatic updates and preserves the previous code and
protected state. It neither resets old tasks nor copies their data into Git.

## Upstream plan

Prepare three reviewable changes, including their local verification evidence:

1. **Dispatch and call ownership.** Include voice binding, scoped desktop
   transport, native ownership, session routing, liveness guards, and regressions as
   one compatible change. Deploy the CLI, service, and voice frontend together;
   a partial upgrade must refuse unsupported phone admission.
2. **Setup and truthful readiness.** Include the desktop doctor, installed CLI
   entrypoint repair, accurate launch acknowledgements, and the setup-guide
   acceptance checklist. Explain which actions need the panel and which do not.

3. **Directional desktop verification.** Keep strict input-window matching, but
   qualify an explicitly requested adjacent desktop separately when a full-screen
   parent has bounded same-app overlay windows. Require one Space notification,
   changed parent identity, stable complete compositor evidence and fresh capture.
   Never grant an input lease or previous-desktop history from that evidence.
   Include the runtime diagnostic and physical switching evidence with the review.

Review duplicates, concurrent requests, service replacement, lost replies,
transcription failure, interruptions, compound presentation requests, and shutdown.
Do not use guessed completion from files or a terminal-open return code.

Do not merge, publish a package, or resume automatic source updates merely because
local checks pass. Resume updates only after the deployed repair is represented
upstream and its installation is verified. Rollback restores code and configuration
selection; it never restores an older ledger over newer receipts.

## Validation record

The installed panel retains Accessibility and Screen Recording permission.
The desktop doctor confirms the selected service, model, active task session,
task admission, enabled computer worker, and no uncertain native result.

A local request through the authenticated phone bridge opened Messages. The
worker reported verified foreground activation, and an independent macOS query
also identified Messages as the foreground application. No message was sent.
A separate compound TextEdit smoke request reached the worker and waited for
input; closing its admission canceled it. That test does not qualify document
creation.

After the routing repair, the same Claude-session request produced one requested
receipt, one launched receipt, and a new live Claude process under that launcher.
This verifies session launch, not completion of work inside the session. The
call admission closed without stopping the independently launched coding job.

Final automated validation:

- `npm run check`: TypeScript, 6,333 tests across 158 files, and build passed.
- `npm --prefix line test`: 173 tests passed.
- Swift `TaskPanelCoreTests`: 252 tests passed; panel build and installed access
  probe passed. Desktop Space shortcuts remain unconfigured.
- Changed-file formatting and `git diff --check` passed.

The local branch is `fix-phone-dispatch`. The repaired desktop and phone host
use it; automatic updates remain paused to avoid replacing the local repair.
No upstream merge or package publication has been performed.

The handset must still verify transcription-to-action, compound presentation and
work, Stop, and hangup. Reading message contents and broader app workflows remain
unverified. Local bridge checks do not imply phone acceptance.

## Newer upstream installation — November 22, 2026

Integrated upstream `2babb53` (15 commits after the previous `abbbff2` baseline)
with the local phone repair. The two source conflicts were resolved by keeping
the upstream reader-model fallback and native approval/timing changes together
with local exact session routing and call-authority checks. The installed panel
was rebuilt, its existing bundle identity retained, and the desktop restarted
against the same protected state. Previous app code is retained for rollback;
receipts and runtime databases were not reset.

Verification: `npm run check` passed with 6,427 tests across 158 files plus
TypeScript/build; all 173 voice tests and 354 Swift tests passed. The installed
panel reports Accessibility and Screen Recording access. Desktop service, chat,
task admission, and native worker readiness checks pass. Desktop Space shortcut
mappings remain unconfigured; those moves are not qualified on this installation.

The first compound TextEdit attempt paused on mouse/keyboard activity and was
canceled when its call admission closed. After the operator explicitly confirmed
a hands-off window, a new request completed: TextEdit opened a new unsaved
document and typed exactly `CLAWDTIME UPDATE VERIFIED`. An independent read-only
AppleScript query confirmed one document with exactly that content and TextEdit
as the foreground application. The scoped admission closed afterward. This
qualifies local compound app opening/document creation/typing through the phone
bridge; actual handset transcription remains unverified.

An existing upstream routing limitation remains: the phrase "test document"
triggers the conservative coding-work keyword filter, despite a correct model
classification for screen work. "New document" routes to the native worker.
Record this separately from installation readiness and retain it in upstream
follow-up. Physical phone acceptance still requires a handset test.

## Routing repair and Space setup — November 22, 2026

The routing limitation above is repaired locally. When a screen interpretation
collides with coding-work keywords, a bounded, no-effect ownership classifier
reads the complete original request. Only an unambiguous standalone app task
reaches the native worker. Real coding/session work stays with its existing
handler. Pending agent approvals cannot consume unrelated explicit app work;
pending native or coding-task questions still block conflicting input. Invalid
results, changed source text, disagreement, timeout, Stop, and expired call
authority refuse new effects. The full request and constraints are preserved.

`npm run check` passed with 6,456 tests across 159 files plus TypeScript/build.
The additional 29 regressions cover these routing and interruption boundaries.
Independent review found no blocking issue. Real model probes classify the
original "test document" request as standalone screen work and coding tests as
managed work; negated and mixed-approval requests do not authorize screen work.

System Settings visibly confirmed enabled **Move left a space: Control–Left**
and **Move right a space: Control–Right**. Those exact mappings are now set in
the private desktop launcher. The installed panel's access probe reports all
four checks true, including `desktopShortcutsAvailable`. The service and panel
were restarted with that configuration. No guessed shortcut or private desktop
API was used. Existing macOS shortcut settings did not need changes.

Installed service/model/task/worker readiness and scoped phone admission,
renewal, idle Stop, and close passed. Physical left/right arrival and the repaired
compound typing request still need a hands-off check or the handset acceptance
below. Mission Control's desktop inventory was not accessible through the setup
UI tool; the operator was asked to ensure at least two desktops before movement.

### FaceTime acceptance

Use a FaceTime Video call from the joined phone. Ensure two desktops exist and
leave the Mac mouse/keyboard untouched while requesting actions. Verify:

1. Status and screen sharing work, with a live picture.
2. "Open TextEdit, create a new test document, and type PHONE CHECK. Leave it
   unsaved and do not change existing documents." Verify the actual text.
3. Move one desktop right, then one left. Verify each arrival before continuing.
4. Start a harmless new Claude session; confirm its terminal and launch receipt.
5. Say Stop during a harmless app task, then test hangup during another. Confirm
   no later native inputs occur. Preserve any uncertain result; do not retry it.

These handset checks are outstanding. Ready for acceptance testing is not a
claim of unattended production qualification. Automatic updates remain held to
preserve the local repair until upstream contains and verifies it.

### Local switching attempt after two-desktop confirmation

The operator confirmed two desktops. The first rightward request reached the
native worker but was refused before dispatch; the old generic journal reason
was `desktop_not_sent`. No opposite move or blind retry followed. Read-only
checks confirmed the actual running panel's shortcut environment and an unlocked
console session. The worker now preserves only the allowlisted native refusal
code in its message and journal, so future failures can be diagnosed without
recording screen content. Unknown input outcomes retain their existing fences.
TypeScript, build, and all 6,461 tests passed after this diagnostic change.

After preparing a normal TextEdit window and restarting the idle service, the
next attempt detected external mouse/keyboard activity during its initial
observation and stopped before any switch. Both call admissions were closed.
Left/right switching therefore remains physically unverified; a fresh hands-off
window was requested. These refusals are not successful movement evidence.

A fresh hands-off attempt successfully brought TextEdit forward, then refused
the rightward move with `unsupported_desktop` before dispatch. A read-only native
`--check-desktop` probe was added and installed; it reports only fixed reasons,
counts, and booleans, with no screenshots, titles, input, or service access.
All 356 Swift tests passed. The probe confirmed one active display, permission
grants, and a contained/confirmed full-screen window, but rejected AX/Quartz
window matching. Visible metadata showed additional overlapping windows of the
full-screen foreground app. The existing source-window guard remains intact.
The operator was asked to exit Codex full-screen manually before the next test;
the computer-use tool does not permit operating Codex itself. No successful
desktop transition is claimed yet.

### Human-observed switches and remaining arrival verification

After leaving full-screen mode, two separately dispatched rightward checks
returned `transition_unknown`. The operator separately confirmed that each
visibly moved. Each exact uncertain receipt was marked observed only after its
corresponding confirmation; the original uncertain state and receipt remain in
the journal, and neither input was replayed. A leftward request between them
returned the known `desktop_unchanged` result and did not create an unknown.

This establishes that the configured rightward shortcut physically works. It
does not establish native arrival verification, leftward arrival, or handset
acceptance. A later read-only source probe returned `source_ready`; a separate
post-attempt snapshot had shown AX/Quartz disagreement. These later snapshots
do not prove what failed during the switch. Bounded runtime diagnostics are
being added before considering any change to the verifier. No target-matching
or input-lease safeguard has been relaxed.

The installed diagnostic build passed all 358 Swift tests and independent
review. It emits one fixed-field unified-log summary per native switch, without
window identities, titles, geometry, pixels, or request content. The fresh
rightward check recorded exactly one Space notification, no environment change,
and 27 rejected candidate samples, all ending in `ax_quartz_window_mismatch`.
The original failure was `target_not_visible` after 5.1 seconds, correctly
reported as `transition_unknown` after dispatch. No opposite move was sent.
This establishes the runtime failure rather than inferring it from a later
window snapshot. Destination matching remains the outstanding local repair.
