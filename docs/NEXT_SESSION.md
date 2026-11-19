# Continuity retest failed before speech; backend restored

## Latest physical attempt — November 19, 2026

User authorized one visual retest and separately authorized backend-only standby
and restoration. That authorization is consumed. The handset user reported “it
just hung up.” Do not redial or reuse this attempt's grants.

The local desktop owner was gracefully refreshed to `48b7b6f` while idle. Desktop
identity/configuration, old accepted task and all closed receipts were preserved.
A new desktop-created review task ran once, preserved the correct fixture, and
passed independent checks:

- Task `task_a3f116c1-d47f-44d6-ac43-ef5d7533b996`, `review_ready`, revision 3.
- Run `run_2505bcd1-26a4-460d-a77a-8da63f441099`, completed.
- Verification `verification_218a8983-9323-4095-9173-d3a797fbdb4f`, passed.

The actual browser passed RELEASE matching, empty-state and Clear filters checks.
TextEdit's result was updated to continuity retest revision 3; source matched the
fixture. All three exact targets resolved before submission. The fresh grant had
`continuity: "call"`. One attempt
`call_attempt_34aa06c4-f4bd-4740-a991-0a960c0d1bb8` completed media preparation and
native dialing, but sharing retired while media was still prepared: first reason
`export_unavailable`, elapsed 12,386 ms, last successful source-frame age 1,034 ms,
21 source / 119 rendered frames, no presentation failure detail. No speech frames
were emitted. Later activation remains an **unknown effect outcome**, preserved
as recorded; native end, media close and overall cleanup are confirmed.

The task stayed review-ready at revision 3 with one run; no acceptance or spoken
revision occurred. All five desktop admissions are closed/cleanup-confirmed.
Original accepted task remains revision 12 with its three runs unchanged.

Restoration deployment `7ab45fa8-0e05-4f2f-bbaa-06e5384b1d2a` succeeded and matched
all original variables. Actual runtime/environment are live, traffic true, with
zero pending/unknown hosted effects and active calls. Standby deployment
`540dcc71-0d5d-4491-9ab6-a303edfa8c73` is removed. Private bounded metadata and
restore proofs: `continuity-retest-20261119/` under the rehearsal root below.

The historical trigger is not yet proven. Export failures currently group context,
SDK and frame-age errors together; reported frame age is compatible with a stale
publication rejection but does not identify the rejected frame. Offline timing
investigation must retain the one-second freshness limit. Continuous sharing,
view switching, acceptance and Stop were **not physically tested** by this call.
Fresh authorization is needed for another call and standby/restore window.

A subsequent offline test reproduced premature retirement when native-style
captures take 450 ms: the old loop added an unnecessary 200 ms idle after work.
Capture now accounts for work within its maximum 5 fps period, without catch-up
bursts or relaxing the one-second frame limit. Explicit SDK stale-frame errors
retain the `frame_stale` diagnostic. The next attempt starts fresh media using
this patch; no additional call or deployment occurred while fixing it. This is
a reproduced robustness fix, not proof of the historical trigger or physical
qualification. Final validation passed 1,287 TypeScript tests, 369 media tests,
typecheck and build.



## Current implementation update — persistent call sharing

The user requested continuous sharing through instructions and acceptance.
The implementation now separates call-scoped capture from prepared result
proof: new desktop requests require `grant.continuity: "call"`, keep the current
exact window live, and replace it with a fresh prepared view mid-call. Old result
narration/highlights are suppressed after evidence changes. Explicit Stop,
call end and capture/authority failures still clear sharing. Existing grants
and historical receipts retain their old meaning.

Next physical check requires fresh authorization: verify the picture remains
live after a spoken revision and acceptance, app/source/result switches have no
blank interval, and Stop sharing/hangup still clear promptly. This change has
not yet been handset-qualified; do not reuse the consumed retest permission.
Automated validation passed 1,287 TypeScript tests, 365 media tests, typecheck
and build. This checkpoint preceded the physical attempt above. That attempt refreshed the
local owner; any subsequent runtime patch must be loaded before a fresh test.


## Prior successful review — November 19, 2026

The user separately authorized one visual review retest with temporary
ClawdTime-backend-only standby/restoration. That single call connected, spoke,
obtained acceptance and ended with confirmed cleanup. Its authorization is
consumed; no further call or deployment is authorized.

The existing desktop-created task has completed its lifecycle:

- Task: `task_764461fc-cbc7-4829-8491-33b7947971ec`.
- Current state: **accepted, revision 12**.
- Latest run: `run_d99a8dae-4394-4ea5-be80-8f12c08142d1`, completed.
- Verification: `verification_39839898-156c-45d5-8e49-f6abda18ad99`, passed.
- Three historical runs, unchanged by review. Exactly one acceptance receipt for
  the retest voice, expected revision 11; zero new instruction receipts or runs.

The earlier decision call created one new run implementing “No tasks match” and
Clear filters. Independent checks passed; the browser visibly confirmed the
empty state, clearing to both tasks and uppercase RELEASE selecting the matching
row. The initial review failed before speech after sharing retired while ringing.
Its exact first trigger remains unknown and its receipt is preserved. Diagnostic
checkpoint `1eadca5` added bounded first-sharing-stop metadata without changing
activation/capture/authority guards. The successful retest does not prove the
historical failure's cause or a permanent repair.

For the retest, the current page was reloaded, the empty-state view restored,
and the displayed source and revision-11 result were checked. The user put all
three exact windows on the current desktop and left the fixture in front.
Fresh manifest, grants and call authorization were used. The preview remained
shared through connection and voice activation. Acceptance changed the task to
revision 12, retiring the old presentation while voice continued. The user
reported the picture becoming dark after submitting the request, with everything
else working perfectly. This request was acceptance, not a new coding instruction.
At that checkpoint, the dark-picture transition required clearer explanation.
The subsequent persistent-sharing update above changes this behavior; it still
must not retain stale pixels to conceal capture loss or explicit Stop. Individual source/verification scene views
and full timing targets were not separately confirmed.

The call is closed with native cleanup complete and media closed. The final
sharing diagnostic records `remote_stop` while active, frame age 345 ms, and no
presentation failure. That classification does not identify who initiated Stop;
separate task/receipt evidence establishes acceptance. Screens/audio remain
transient. SDK counters are not physical audibility or visibility proof.

Restoration deployment `256f40da-4b07-4112-8130-994c3507831b` matches exact original
variables; actual runtime/environment are live, traffic true, with zero
pending/unknown effects or active calls. Standby deployment
`3f84ca74-c9f7-4d8f-81f7-37342af04bba` is removed. The local service preserves the
accepted task and all closed attempts; no service restart, worker replay or
session renewal occurred during this retest.

## Preserved local setup

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
The last fully qualified milestone remains `step-c1-done` at `59b8e24`.
Steps d/e implementation exists; full physical acceptance remains open.

Private rehearsal root:
`/Users/garygao/.local/share/clawdtime-desktop-call-rehearsal-20261118`.
Latest evidence is under `review-retest-20261119/`, including bounded acceptance
and restoration proofs. Preserve historical `rehearsal-20261119/`, `standby-2/`,
and every attempt/unknown receipt. Never replay an old request/grant or remove an
ownership lock to force progress.

The service on loopback 13336 owns the task, worker, verification and call
admissions. Keep that same owner; do not launch a standalone handset operator on
its database. Its fixture source session and actual handset destination are
separate identities connected only by the delegated export grant/native
inspector. Check session lifetime before reuse; it is not silently renewed.

The preview is on loopback 8767. Prepared TextEdit documents are
`Rehearsal source.txt` and `Rehearsal result.txt` (current continuity-retest task,
verified revision 3). The earlier task remains accepted at revision 12. None of
the used presentation grants may be reused. For a future
new rehearsal, check the preview server, reload the actual page, and regenerate
source/result documents from that new task's current result. TextEdit can retain
stale external-file contents; verify displayed text and re-resolve identities
after reopening. Exact metadata validation requires current on-screen windows.
Keep the views together on one desktop while ringing; never relax freshness or
visibility to make a test pass.

The unrelated original desktop service/task, historical accepted handset task
at revision 28, original checkout, Apple Teams and sibling chert-facetime remain
untouched. Do not confuse those task identities with this accepted desktop task.

## Next action

1. Record this as a completed desktop-created task lifecycle across a resumed
   decision call and review retest. It is not a clean, uninterrupted two-call
   rehearsal and does not satisfy the plan's three-rehearsal gate.
2. Finish the offline investigation of pre-speech export retirement without
   weakening freshness, then retest persistent sharing with fresh authorization.
3. Prepare a fresh desktop-created fixture for the next complete rehearsal. Obtain
   specific authorization for its calls and any required standby/restore window;
   all previous call permissions are consumed.
4. Complete the approved three full two-call rehearsals, twenty interruption and
   twenty zoom trials, ten-minute audio continuity, quiet pause and measured
   response/startup/Stop targets before tagging d/e complete. Explicitly verify
   all prepared scenes and after-clear voice behavior on the handset.
5. Keep the small production pilot scope: one Mac/handset/project/Codex worker,
   then remove routine operator setup and qualify installation/recovery. Demo
   acceptance does not establish public production readiness.

Guides: [desktop](CODING_DEMO_DESKTOP.md),
[desktop calls](CODING_DEMO_DESKTOP_CALLS.md),
[handset walkthrough](CODING_DEMO_HANDSET_WALKTHROUGH.md),
[approved acceptance plan](CODING_DEMO_IMPLEMENTATION_PLAN.md), and
[build log](BUILD_LOG.md).
