# Standalone runtime qualification — November 20, 2026

PR #7 (`bundled-cua-runtime`) is undergoing the user-authorized native test and
installation. Automated TypeScript validation passes 1,681 tests. Browser
standalone qualification passed earlier; actual native input has not yet passed.
Current fixes preserve keyboard focus while approving, distinguish definite
no-input refusals from uncertain effects, bind changed frames to exact native
AX targets, and activate only observed existing windows in an explicit app
allowlist. Native screenshots remain transient.

The package now includes a distinct Local Control helper instead of overwriting
an installed call companion. It refuses call configuration/APIs and competing
known helper processes. Keep old service configuration and receipts for rollback;
only migrate after the native fixture/Stop test. No phone or deployment authority
is included in this task. See [runtime details](BUNDLED_CUA.md).

The capture investigation below is historical call-workflow evidence and remains
separate from this standalone desktop qualification.

## Historical pre-speech freshness investigation

## Local investigation authorized — November 19, 2026

The user subsequently authorized local capture testing and repair before any
further phone call. This authorizes fresh, bounded capture of the same prepared
views for local diagnosis, not a handset call or deployment. No need to request
the same local-test permission again.

Local test setup is saved privately under the rehearsal root's
`local-capture-20261119/`. `prepare.mts` reads the current task, resolves each
exact prepared window anew, and creates a fresh short-lived local grant and
protected probe configuration. Each probe configuration is single-use, including
failed runs. Keep its `.used` intent file; prepare a new configuration for a new
measurement. The probe captures only to memory, can be stopped with SIGINT or
SIGTERM, joins the native child on cleanup, and has no room/provider/call action.
Its pipeline mode uses the production renderer and unconnected SDK conversion,
but substitutes read-only task checks for presentation/voice authority and uses a
local exporter/watchdog. Do not claim it qualifies the whole production call.

Actual capture has now reproduced the stall. A native-only probe captured 368
frames over 75.193 seconds before all three windows went offscreen. A pipeline
probe then failed freshness at 100.755 seconds while windows still resolved,
but concurrent synthetic jobs were a load confound. With every team job paused,
an isolated probe failed at 20.875 seconds: native I/O was pending for 845 ms,
Python loop lag was at most 9 ms, task checks at most 14 ms, and rendering/SDK
publication remained responsive. Exact windows still resolved afterward.

Opt-in native phase telemetry now measures guard, shareable-content enumeration,
validation, screenshot, JPEG and pipe stages using bounded numeric metadata.
Writes are nonblocking and dropped rather than retried; the private reader detects
observed sequence gaps. A missing final marker remains possible even without an
observed gap. The first profiled pipeline passed 60 seconds (295 source frames,
885 SDK submissions, maximum accepted source age 523 ms). A subsequent switching
attempt stopped at 10.667 seconds because all three windows went offscreen,
before its first switch. Neither result establishes a repair. A subsequent
240.004-second run passed
11 view switches (1,192 source frames, 3,573 SDK submissions, maximum accepted
source age 660 ms). The following run refused after the post-capture validation
marker
at 27.191 seconds, before JPEG encoding; the exact guard is not yet known. Last
accepted source age was 320 ms and all three windows resolved again immediately
afterward. This did not reproduce the prior long native I/O wait. A profiler-off
comparison also stopped on a source refusal at 88.510s after
four switches. The expanded trace then reproduced the freshness stall at 27.738s:
`capture_image` pending about 843 ms, last shared source age 1,045 ms, responsive
render/SDK loops, no observed telemetry gaps. Cleanup joined. This implicates the
one-shot screenshot interval; the separate post-validation refusal is not yet
isolated. Capture is stopped and the user need not keep the desktop in front.
No call was placed.

The user authorized one further test call; that authorization remains unused.
A new ClawdTime-only standby/restore deployment window has not been authorized.
Keep the call on hold until local capture qualification is resolved. Fresh local
probe grants remain covered by the existing local-testing permission.

Read-only task endpoint baseline: 100 requests at 25/s, p50 1.82 ms, p95 3.93 ms,
maximum 6.18 ms. This excludes the production voice-context handler. Synthetic
2042×1792 annotated rendering: 120 samples, p50 16 ms, p95 22 ms, maximum 39 ms.
The approximate local pipeline survived injected 100/300 ms capture delays but
retired at 450 ms with four 10 ms authority checks per source cycle; a newer
rendered source was still unexported when the previous exported source aged out.
This isolates a timing-pressure scenario, not the actual native cause or a fix.
The separate production-owner benchmark (real prepare/export/watchdog and
ExportAuthority, renderer and unconnected SDK; injected capture/API) also passed
300 ms acquisition for ten seconds, then failed both 450 ms trials during prepare
at 1.830/1.832 seconds. At retirement the newer render was only 0–3 ms old and
the prior SDK submission only 49–54 ms earlier. Waking on the render alone cannot
guarantee recovery within the existing 15 fps and one-second limits. No production
behavior was changed based on these synthetic results.

## Next local experiment

Diagnostic checkpoint `9a92445` is pushed. Default acquisition still uses
`SCScreenshotManager.captureImage`; no reliability repair is claimed. An optional
`--capture-stream` candidate is now implemented, independently reviewed and
built. It obtains a newly completed exact-window frame, joins stream stop, then
applies unchanged post-capture checks. All 68 Swift tests, 1,308 TypeScript tests
and 33 affected Python presentation tests passed.
Idle stream events and cached images cannot renew freshness; native timestamps,
identity, geometry, expiry and the one-second export limit must be preserved.
Do not enable the candidate by default or dial until it passes local qualification.
The first preparation attempt found the fixture offscreen; no candidate capture
started. The private preparer now accepts `--capture-stream-candidate`, selecting
`stream-capture-candidate` as helperBinary in a fresh config. Use the V6 probe
reader with the new stream/refusal phase enum; V4/V5 cannot parse those phases.
First qualify 60s local capture/switching, then the actual-owner probe for a longer
run and Stop. All team tests/benchmarks must be idle during these measurements.
Reuse neither `.used` configurations nor previous capture grants.

The protected `local-capture-20261119/clawdtime_owner_native_probe.py` extends
local testing to actual Python owner prepare/export/watchdog/scene-switch/Stop
loops with real native capture and unconnected SDK conversion. It uses synthetic
voice context backed by read-only task GET, hard-refuses calls/provider activation
and task mutations, and creates separate local journals beside a fresh single-use
configuration. Five offline harness tests passed; actual native owner capture is
not yet run. This still does not establish production voice authority or handset
acceptance. Tests live beside the private script, not in the repository.

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
never silently renew it. The lead gracefully refreshed the idle owner at
`9ab7047`, loading the `093cfb7` diagnostic schema. PID 59794 replaced PID 98302
only after the original listener and store lock were released. Both task histories,
all six closed admissions and static configuration hashes were unchanged.
Do not rerun the private one-shot refresh script or start a second owner.

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
relaxing permission or repeatedly trying calls. One phone-call authorization remains unused; the temporary standby/restore
window still requires specific deployment authorization before live execution.

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
