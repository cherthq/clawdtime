# Pre-speech freshness failure remains unresolved; backend restored

## Latest retest — November 19, 2026

The user authorized one more visual retest and the previously described temporary
ClawdTime-only standby/restore window. Both permissions are consumed. The user
reported “just hung up again.” Do not redial or reuse a prior request/grant.

The existing review task was legitimately unchanged and eligible; no new task or
worker was created. The three source/result/preview views were checked, exact
native targets resolved, and fresh call-continuity grants were prepared at
`2809bb0`. The new Python process loaded the capture-pacing repair. Current native
identity, idle-line and exclusive standby checks preceded one call.

Attempt `call_attempt_b0bfed97-240b-4fe2-9fc8-3137ccf87d84` completed media preparation
and native dialing. Sharing then retired while still prepared, before speech:

- First reason: **frame_stale**, elapsed 16,458 ms.
- Last successfully published source-frame age: 1,017 ms.
- Source frames: 54; rendered frames: 174; speech frames: 0.
- No presentationFailure metadata; no acceptance or coding instruction.
- Later activation remains **unknown** as originally recorded. Native end,
  media close and final cleanup are confirmed; all six admissions are closed.

This confirms freshness retirement but does not isolate source capture, render,
context checks, SDK publication or event-loop delay. The cadence fix passed its
specific offline regression but did **not** resolve this live failure. Continuous
sharing, scene switching, acceptance and explicit sharing Stop were not physically
exercised. The lead submitted one exact Stop during cleanup without redialing.

Restoration deployment `2197b683-d03e-4381-9c37-d8cda54d9a12` succeeded and matched
all original variables. Actual runtime/environment are live, traffic true, with
zero pending/unknown hosted effects and active calls. Standby deployment
`9ef7a104-6e6f-4aea-9780-6b7aea93a2b2` is removed. Private bounded metadata and
restore proofs: `continuity-retest-2-20261119/` under the rehearsal root below.

## Preserved tasks and local owner

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
Private rehearsal root:
`/Users/garygao/.local/share/clawdtime-desktop-call-rehearsal-20261118`.

Current selected task:

- `task_a3f116c1-d47f-44d6-ac43-ef5d7533b996`, **review_ready**, revision 3.
- One completed run: `run_2505bcd1-26a4-460d-a77a-8da63f441099`.
- Passing verification: `verification_218a8983-9323-4095-9173-d3a797fbdb4f`.
- Result: case-insensitive title filter, No tasks match and Clear filters.

Earlier accepted task `task_764461fc-cbc7-4829-8491-33b7947971ec` remains accepted
revision 12 with three historical runs. Its acceptance did not start another run.
Preserve both tasks and all historical unknown effects; confirmed cleanup does
not rewrite an unknown activation outcome into success.

Loopback 13336 owns the task store, worker, verification and call admissions.
Keep this same owner; never launch another operator on its database. Its fixture
source session and actual handset destination are separate identities joined by
the delegated export grant/native inspector. Verify session lifetime before reuse;
never silently renew it. The owner was last refreshed to `48b7b6f`; fresh Python
attempts loaded `2809bb0`. The subsequent diagnostic wire change also touches
TypeScript: gracefully refresh the idle owner before using that new media/schema
combination, preserving configuration, task state and receipts exactly.

Preview: `http://127.0.0.1:8767/`. TextEdit: `Rehearsal source.txt` and
`Rehearsal result.txt`, showing the current review task's revision 3. Recheck the
actual tab and document contents; TextEdit may retain old buffers. All three exact
windows must be on one desktop, with stable identities/geometry, before preparing
fresh grants. Used capture grants must never be replayed. Screens/audio remain
transient. The unrelated desktop task, original checkout, Apple Teams and sibling
chert-facetime remain untouched.

## Investigation before another handset test

The diagnostic update adds bounded, frozen first-stop pipeline timings that
distinguish watchdog versus publication failure and source/local-authority/voice-
context/render/SDK stages. It uses fixed enums and bounded elapsed/age values,
without errors, text, window names, screenshots or audio. Independent synthetic
stalls now check each stage, one-second freshness, sticky Stop and cleanup;
bounded normal jitter remains covered. These tests validate the diagnostics,
not physical capture reliability or the cause of the failed live call.

Before proposing another handset retest, complete local capture qualification on
the same prepared views under appropriate fresh capture authority. Preserve all
freshness checks; do not solve this by keeping a frozen frame, raising the timeout,
relaxing permission or repeatedly trying calls. The next phone call and any
standby/restore window require fresh explicit authorization.

For one future review call: preview → source → verification; say “I accept the
result” as a standalone utterance; confirm the picture remains visible; switch
source/preview again; Stop sharing; verify voice continues; End the conversation.
A coding change before acceptance requires a separate review of that new run.

The last fully qualified milestone remains `step-c1-done` at `59b8e24`. Steps d/e
are implemented but still need the approved three complete two-call rehearsals,
twenty interruption and zoom trials, ten-minute audio continuity, quiet pause
and measured response/startup/Stop targets. No d/e tag or production qualification
is claimed. After those checks, remove routine operator setup and qualify the
small one-Mac/handset/project/worker pilot's installation and recovery.

Guides: [desktop](CODING_DEMO_DESKTOP.md),
[desktop calls](CODING_DEMO_DESKTOP_CALLS.md),
[handset walkthrough](CODING_DEMO_HANDSET_WALKTHROUGH.md),
[approved plan](CODING_DEMO_IMPLEMENTATION_PLAN.md),
[build log](BUILD_LOG.md).
