# Step d: local accepted; handset integration awaiting physical qualification

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
Handset integration checkpoint `d7bacf8` and the first-call evidence checkpoint
`8a254f3` are pushed. Latest completed step remains `59b8e24`, annotated
`step-c1-done`. The Deepgram audio-only handset test passed. The first visual
call was not answered, as the user later confirmed. A separately authorized
second visual call connected: the user liked the walkthrough, but voice stopped
responding after a revision retired sharing. This is partial visual acceptance,
not a passed conversation-continuity or full step-d gate.

Both calls are closed. The backend is restored to its exact previous settings:
live mode, traffic enabled, zero active calls and no pending/unknown effects.
The final restoration deployment is `3e361f03-e4a2-4a9a-ad1a-90f2abc2e09d`.
Original checkout, drafts, Apple Teams and sibling chert-facetime remain untouched.

The user could not recall requesting different empty-state wording. The lead
stated the assumption to retain the last explicit requirement, **“No tasks
match,”** and removed the provisional wording through separate operator-scoped
runs. The last run completed; independent behavior and syntax checks passed.
Task revision **27** is **review-ready**, with no unresolved decision. The task
server is stopped cleanly after settlement. Do not reuse the old revision-11
presentation: refresh the app/code/result views and prepare a new exact manifest.

The local annotated three-scene walkthrough was accepted: **“Audio clear;
visuals good.”** Visible Stop blanked that local preview. Handset Stop timing,
conversation continuity after the repair, and the remaining measured polish
checks still need physical qualification. Keep frames and audio transient.

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
[build log](BUILD_LOG.md) for the exact checkpoint validation. The handset now
has partial human visual evidence, but the repaired dialogue path remains
unqualified physically. SDK acceptance does not prove human
visibility, audibility or remote clearance.

The repair allows an admitted fresh finalized human turn to receive an ordinary
reply after sharing retirement, with bounded transient audio and stale-response
fencing. Its prompt now directs the voice agent to ask for missing replacement
text before submitting a vague confirmation; physical behavior needs retesting. The worker context now identifies an
exact answered decision as historical without duplicating the instruction.

## Resume

1. Read the latest build-log repair and validation results. Preserve `visual-1/`
   and `visual-2/` receipts; never replay either attempt. Verify the repair
   checkpoint is committed/pushed and checks passed. Use the compact
   external-dependency inspector and owner-only verification-plan file.
2. Obtain fresh specific authorization for one visual handset call and, if
   required, a temporary ClawdTime-backend-only standby/restore window. Previous
   one-call authorizations are consumed and cannot authorize another call.
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
