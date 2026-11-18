# Step e: desktop implementation; remaining handset qualification deferred

The user explicitly authorized building the desktop panel and proceeding without
routine input, while moving on from the latest visual test. This overrides the
earlier step-e implementation gate, but does not declare step d physically passed.
Read [the desktop guide](CODING_DEMO_DESKTOP.md). The local floating panel uses
the independent task service with durable operation receipts, real scoped Codex
runs when explicitly selected, independent verification, decisions, review and
separate cancellation. Closing or quitting the UI leaves work running.

The standalone launcher defaults to a local-only task session; an explicit private
session file can attach an already-authorized session without renewal or permission
changes. It does not dial, capture,
deploy or upgrade pairing. The handset operator has an opt-in, attempt-bound
desktop attachment for the same owned task and exact Stop controls; it cannot
run alongside the standalone owner on one database. A future complete desktop
to phone rehearsal needs a paired session and a confirmed idle ownership handoff.
No new live call, line operation or deployment is authorized.

Local desktop qualification uses a separate disposable project/state under
`/Users/garygao/.local/share/clawdtime-desktop-qualification`. It must not be
confused with or copied over the accepted historical handset task below.

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
Latest completed step remains `59b8e24`, annotated `step-c1-done`. Repair
checkpoint `98c7355` was pushed before the latest supervised visual test. The
first visual call was unanswered; the second connected but failed voice
continuity after a revision. The third separately authorized call showed the
prepared preview and obtained final acceptance after an exact explicit phrase.
The human confirmed acceptance acknowledgment and hangup. Its initial natural
assent exposed an overly rigid phrase check, repaired in this checkpoint with
conservative full-utterance matching and clear recovery guidance.

The task is **accepted at revision 28**, with its independently verified result
unchanged and no new coding run during the final review. The task server is
stopped and all native/media/presentation cleanup is confirmed. The backend is
restored to exactly its previous variables and live operation with no active
calls or pending/unknown effects; restoration deployment is
`d2b307f4-65fc-4bfd-9895-4ebef4914bb1`.

All three calls' permissions are consumed. Do not reuse their attempts, grants
or manifests. Protected metadata is under `visual-1/`, `visual-2/`, `visual-3/`.
Original checkout, drafts, Apple Teams and sibling chert-facetime are untouched.

Local three-scene audio/visuals were accepted. Handset preview and explicit
result acceptance/hangup have positive human evidence. The latest call did not
exercise a new spoken revision, all scenes, or the full continuity/interruption/
zoom/Stop timing targets. Step d remains open; step e implementation is authorized. Future rehearsals
need a fresh task/result preparation and separate specific call authorization.
Keep screens/audio transient.

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
has positive preview and explicit acceptance/hangup evidence; the full repaired
revision-continuity path remains physically unqualified. SDK acceptance does not
prove human visibility, audibility or remote clearance.

The repair allows an admitted fresh finalized human turn to receive an ordinary
reply after sharing retirement, with bounded transient audio and stale-response
fencing. Its prompt now directs the voice agent to ask for missing replacement
text before submitting a vague confirmation; physical behavior needs retesting.
The worker context identifies an exact answered decision as historical without
duplicating the instruction. Acceptance now permits bounded conversational
phrasing while preserving negation/condition refusals and exact review guards.

## Resume

1. Read the latest build-log repair and validation results. Preserve `visual-1/`,
   `visual-2/` and `visual-3/` receipts; never replay an attempt. Verify the repair
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
   tagging step d or declaring the desktop-to-phone demo fully qualified.

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
