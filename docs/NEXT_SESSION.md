# Step d: local accepted; handset integration awaiting physical qualification

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
Handset integration checkpoint `d7bacf8` is pushed. Latest completed step remains
`59b8e24`, annotated `step-c1-done`. The Deepgram audio-only handset test passed
and the hosted backend was restored. The subsequent first visual call was
submitted once, but the native provider reports `outbound_not_answered` with no
connected/bridge-ready event or speech output. The human's handset observation
is pending. All cleanup is confirmed and the backend is restored to live with
traffic enabled, zero pending/unknown effects and no active calls. Original
checkout and drafts remain untouched.

The user confirmed the annotated three-scene local walkthrough:
**“Audio clear; visuals good.”** All six show/narration effects completed. Visible
Stop blanked the preview and all four cleanup flags passed. The presentation host
and task server are stopped; task revision 11 remains review-ready. The viewport
fix keeps the caption and Stop visible. Keep frames and audio transient.

## Current implementation

The new explicit `handset_walkthrough` mode composes the existing coordinator,
global call fence and encrypted receipts with one Deepgram dialogue, prepared
scene renderer and LiveKit screen publisher. Historical c.1 schemas and hashes
remain separate. An immutable export grant binds exact task/run/revision,
verification, presentation, capture grant, destination, line and conversation.
No local-only grant can export by itself.

Preparation validates exact native targets and fresh SDK frame acceptance before
dialing. The same voice owns opening, conversation and scene explanations. Scene
tools select prepared IDs; finalized instructions create one scoped run or a held
correction. Only a fresh review call can accept its exact verified result. A new
run invalidates old sharing, while conversation and coding continue. Sharing Stop
joins capture and publishes blank-only frames; call end never cancels admitted
coding. The scoped operator API cannot launch other tasks. Unknown outcomes keep
their receipts and ownership fence.

Read [the operator guide](CODING_DEMO_HANDSET_WALKTHROUGH.md) and the latest
[build log](BUILD_LOG.md) for the exact checkpoint validation. The handset media
path has offline automated evidence only: SDK acceptance does not prove human
visibility, audibility or remote clearance.

## Resume

1. Reconcile the human's observation of the first visual call. Inspect the preserved
   `visual-1/` metadata if necessary; never replay it. Verify the current checkpoint
   is committed/pushed and its checks passed. Use the compact external-dependency
   inspector bundle and an owner-only verification-plan file as documented.
2. Obtain fresh specific authorization for one visual handset call and, if
   required, a temporary ClawdTime-backend-only standby/restore window. Prior
   audio-only permissions are spent and do not authorize visual export.
3. Prepare fresh exact preview/code/verification windows and grants, resolve the
   paired destination privately, and check exclusive idle line ownership.
4. Run the specifically authorized call, collect physical observations, confirm
   native/local cleanup and restore the previous backend settings. If coding is
   still active, preserve its service until the worker and watcher settle.
5. Prepare the fresh result for a separately authorized final-review call. Finish
   the plan's rehearsals and measured interruption/zoom/timing gates before
   tagging step d or starting the desktop entry point (step e).

Do not rerun used local attempts. Exact source windows can become offscreen after
returning to chat; fresh target validation is mandatory. Browser automation cannot
open the private local-file launcher, so any further local preview launch needs
the user's click. No visibility guard was relaxed.

Protected task/provider/session files remain beneath
`/Users/garygao/.local/share/clawdtime-coding-demo-qualification` (owner-only).
Never print credentials or include them in commands, logs or Git. Preserve
original task pairing and all unknown receipts. Apple Teams and sibling
chert-facetime remain untouched. No new call, line operation or deployment is
authorized by this handoff; new work defaults to simulation/standby.
