# Step d local presentation built; real-window qualification pending

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
Local implementation checkpoint `9308013` is pushed. Latest completed step remains
`59b8e24`, annotated `step-c1-done`. The Deepgram
handset audio test passed and the hosted backend was fully restored. No further
call or deployment has occurred. The original checkout and drafts are untouched.

## Resume here

The local walkthrough implementation is integrated and independently reviewed.
Required checks pass: 883 TypeScript tests plus typecheck/build, 283 media tests,
31 Swift tests and the capture-helper build. See `docs/BUILD_LOG.md` for commands
and the implementation checkpoint. This is not completion of step d.

The real disposable task remains review-ready with its verified run unchanged.
Chrome's `ClawdTime task fixture` visibly has the empty state and Clear filters.
TextEdit has actual `app.mjs` and `Verified result.txt`. The latter was reloaded
from the current verification projection, avoiding obsolete historical worker
wording. Exact-target native metadata finds the result window but marks it
`onScreen:false`; permission and console preflight pass. Normal centering and
Raise actions did not resolve this. The user reported the windows visible, but an independent exact-ID WindowServer
check agrees with ScreenCaptureKit that the two TextEdit targets are offscreen.
App identity/title/bounds match and the app is not hidden or terminated. A focused
question is pending: click inside the exact result window on the Mac and leave it
frontmost briefly. Recheck that exact target after the reply; do not assume the
prior broad visibility answer establishes native capture readiness.

Do not relax the current-Space/exact-window guard or substitute generated pixels.
Resolve each exact target using `ClawdTimeTaskCapture --resolve-target` with the
owner-only query files under the protected `local-walkthrough/` directory. Then
create a fresh short-lived local manifest/grant and protected host configuration.
Configure `scripts/task-server.ts --presentation-config`, start the Python local
host and use the private browser launcher with visible Start and Stop. Complete
CLI prepare/start/status/stop with real app pixels and exact prepared narration.
Keep the preview display in a separate window so it does not replace the captured
fixture tab. Screens/audio remain transient. Never reuse an uncertain effect ID
as a new attempt; reconcile and retain cleanup evidence.

Runnable CLI and configuration formats are in `docs/CONNECTORS.md`,
`docs/MEDIA_INTEGRATION.md` and `mac/README.md`. The grant authorizes local viewing
only; it never permits a call, OS input or native window activation. A task bearer
cannot mint this grant. First narration equals the prepared current task opening.

## Remaining work in step d

After local qualification, implement a separately scoped `handset_walkthrough`
mode over the existing coordinator and receipt store. Keep existing audio-smoke
schemas/fingerprints intact. Bind exact call, task, voice, immutable presentation,
real destination/line identity and expiry. Use one dialogue/playback owner for
both opening and conversation; do not run the local narrator concurrently.
Scene tools select only prepared scene IDs; finalized human instructions use the
existing deduplicated task path. Sharing Stop, voice end and task cancellation
remain separate. A new run invalidates the old presentation immediately.

Finish offline integration and failure checks, prepare an exact one-call plan,
then request specific visual-call authorization. No further call is currently
authorized. Decision and final-review calls require fresh bindings and separate
physical verification. Do not tag step d complete or start step e yet.

Protected task/provider/session files remain beneath
`/Users/garygao/.local/share/clawdtime-coding-demo-qualification` (owner-only).
Never print credentials or include them in commands, logs or Git. All earlier
handset grants are used historical records, not reusable authorization. Preserve
receipts, unknown outcomes and the original task pairing. Apple Teams and sibling
chert-facetime remain untouched; default all new work to simulation/standby.
