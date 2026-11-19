# Step e: resumed decision flow passed; review activation remains open

## Latest checkpoint — November 19, 2026

The user authorized one decision call and one subsequent final-review call,
prepared app/source/result views, spoken task instructions, and a temporary
ClawdTime-backend-only standby/restore window. Both calls were submitted exactly
once. Both authorizations are consumed; no further call or deployment is authorized.

The existing desktop-created task was resumed, not recreated. It already had two
completed runs. Its current identity is:

- Task: `task_764461fc-cbc7-4829-8491-33b7947971ec`.
- Latest run: `run_d99a8dae-4394-4ea5-be80-8f12c08142d1`, completed.
- Current state: **review_ready, revision 11**; not accepted.
- Verification: `verification_39839898-156c-45d5-8e49-f6abda18ad99`, passed.

The decision call connected, showed the prepared preview and received a specific
spoken choice. Exactly one new scoped Codex run completed in 32,121 ms. Independent
filter/empty-state assertions and JavaScript syntax passed. The browser visibly
showed “No tasks match”; Clear filters restored both tasks; uppercase RELEASE
showed only the release-notes task. The user said the first call seemed to work,
but noticed the picture becoming dark after submitting the request. Sharing
retirement on a new run is intentional; explain it clearly before the next
rehearsal. After-clear voice continuity was not individually confirmed.

The separately authorized review call used fresh revision-11 views and grants.
The preview initially rendered and reached the SDK, but sharing retired while the
call was still preparing/ringing. Native connection/authority checks subsequently
passed; media activation failed before speech. The human reported automatic
hangup. The exact first retirement trigger was not recorded, so do not claim a
provider outage, offscreen-window cause, or successful review acceptance.

Both attempts have confirmed native/media cleanup and presentation Stop. The
backend was restored to exact original variables through deployment
`326891e4-d1cd-476f-ad7a-5806dd2ba36c`; actual runtime/environment are live with
traffic true, zero pending/unknown effects and zero active calls. Standby
deployment `742fd92f-ef9f-43dd-9cdb-98200ee8935b` is removed. The unknown historical
media-activation receipt remains preserved alongside confirmed cleanup.

A narrow diagnostic improvement now retains bounded first-sharing-stop metadata,
source/render counters and allowlisted presentation failure categories in the
shutdown summary. It stores no screens, audio or raw exception text and does not
change activation or capture guards. This is diagnostic coverage, not a physical
repair claim. See the latest [build log](BUILD_LOG.md) for validation and installation.

## Preserved local setup

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
The last fully qualified milestone remains `step-c1-done` at `59b8e24`.
Steps d/e implementation exists; full physical acceptance remains open.

Private rehearsal root:
`/Users/garygao/.local/share/clawdtime-desktop-call-rehearsal-20261118`.
Today's evidence is under `rehearsal-20261119/`; historical `standby-2/` and
attempt receipts must remain intact. Never replay an old request/grant or remove
an ownership lock to force progress.

The desktop service on loopback 13336 owns the task, worker, verification and call
admissions. Keep that same owner; do not launch a standalone handset operator on
its database. Its source fixture session and actual handset destination are
separate identities, connected only by the exact delegated export grant/native
inspector. Check session lifetime before reuse; it is not silently renewed.

The preview is on loopback 8767. Prepared TextEdit documents are
`Rehearsal source.txt` and `Rehearsal result.txt` (revision 11). Check that the
preview server is running, reload the actual page, and refresh/reopen documents
from current results before any future call. The local server was restarted
after the first call because its old process was no longer listening; the first
call had displayed the existing unchanged pre-revision page.

Exact target validation is metadata-only and requires current on-screen windows.
TextEdit can retain stale external-file contents; confirm the displayed revision
and source before preparing a manifest. Reopening changes window IDs. Keep all
prepared windows on one current desktop and leave the fixture in front while
ringing. Never relax visibility/freshness checks to make a rehearsal pass.

The original unrelated desktop service/task remains untouched. Earlier historical
handset task acceptance at revision 28 belongs to a different task and does not
accept this revision-11 desktop task. Apple Teams, sibling chert-facetime and the
original checkout remain unchanged.

## Next action

1. Read the final diagnostic checkpoint and verify current task/readiness, session
   lifetime, original closed receipts and exact local service version.
2. Prepare fresh current preview/source/result views. Obtain specific authorization
   for a new review call and any required standby/restore window. The user's two
   calls for this rehearsal have both been used.
3. Keep the exact views visible through ringing; collect the new bounded first-stop
   diagnostic if sharing retires. Do not infer handset visibility from SDK frames.
4. If the review connects, verify all requested scenes, acceptance without another
   coding run, clean end, and exact backend restoration. Preserve any unknown
   effect; no blind retries or automatic redial.
5. Complete the approved three full two-call rehearsals and measured timing,
   interruption, zoom, audio-continuity and Stop gates before tagging d/e complete.
   This resumed flow advanced the task, but its review failed and does not count
   as a completed two-call acceptance rehearsal.

Guides: [desktop](CODING_DEMO_DESKTOP.md),
[desktop calls](CODING_DEMO_DESKTOP_CALLS.md),
[handset walkthrough](CODING_DEMO_HANDSET_WALKTHROUGH.md), and
[approved acceptance plan](CODING_DEMO_IMPLEMENTATION_PLAN.md).
