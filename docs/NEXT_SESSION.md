# Start here: handset voice test — November 19, 2026 morning

The user deferred the live handset test until tomorrow morning and asked for all
possible preparation without further input tonight. **No handset call is currently
authorized.** Do not dial on startup or infer authorization from this handoff.

## Verified checkpoint

Worktree: `clawdtime-coding-demo`, branch `demo/coding-flow`. Step c is pushed at
`46a64fb`, annotated tag `step-c-done`. Steps a and b are also tagged. The local
conversation started distinct real Codex runs, answered status while coding,
caught a wording error with independent checks, and accepted the spoken correction
after the failed run's verified terminal outcome, then verified that the new run
passed. The demo task is `review_ready`.

The final local session was stopped through the visible Stop button; the microphone
and audio context were released, and provider cleanup was confirmed. Spoken hangup,
handset quality, deliberate interruption and the quiet-pause check remain unqualified.
See [BUILD_LOG.md](BUILD_LOG.md) for separate human observations and machine evidence.

## Prepared overnight, with live dispatch still disabled

- `task readiness` reads sanitized state even after session expiry. Explicit operator
  `task reauthorize` preserves the same identity, task history and token, refuses
  unresolved outcomes, and never renews voice or call authority.
- The independent call coordinator now has one-call authorization, exact immutable
  bindings, encrypted phase receipts, global unknown-outcome fences, and separate
  local-media/native cleanup evidence. Its default is dispatch disabled.
- A separate LiveKit audio adapter and authenticated loopback controller prepare
  silence only, check the dedicated voice provider before dialing, and activate
  the task conversation only for the bound native call and expected audio worker.
  This smoke mode permits status/end, not coding changes or screen features.
- The TypeScript HTTP clients match that controller and use the existing Calls
  API with `audio:true, video:false`, without redirects or automatic retries.
- Synthetic component and real CLI standby checks are recorded in BUILD_LOG. They
  do not establish native-worker audio-only support or handset behavior.

The production task-authority/readiness implementation and composed operator
entry point still need the verified real pairing, native ownership evidence and
protected Chert/LiveKit configuration. Do not substitute the fixture or a fake
readiness callback. The libraries are preparation, not an enabled calling service.

## First actions when the user returns

1. Read the latest BUILD_LOG and this handoff. Inspect the current branch and changes;
   preserve all work and original Argos checkout drafts. Never use a `codex/` branch.
2. Read task readiness before any mutation. Keep the same protected task store,
   selected project and verification plan. Do not replay a run or old voice session.
3. If the task session expired, use explicit operator reauthorization with the exact
   original pairing, host, project and voice permission, after all prior outcomes are
   known. Do not automatically extend expiry, relabel a fixture pairing, or discard
   unknown receipts. An expired parent with an unended voice needs separate proven
   cleanup; renewal must not bypass that fence.
4. Obtain authorization for **one** voice-only FaceTime smoke-test call via Chert to
   the verified intended test handset. No screen capture, video/presentation, shared
   control, deployment, line reassignment or automatic redial is included.
5. Inspect fresh protected native line/worker identity, tester pairing, exclusive
   ownership, cursor and cleanup evidence. Historical line ownership is not current
   authority. The local fixture pairing is not a handset pairing.
6. Configure the separate task audio adapter and exact call binding in owner-only
   files outside Git. Validate readiness and the one-call authorization immediately
   before dispatch. If any effect becomes unknown, preserve its receipt and reconcile
   using read-only evidence; never try a new ID to escape an unresolved call.
7. During the call, check the prepared opening, two-way speech, status discussion,
   natural interruption, a deliberate 20-second quiet pause and spoken hangup. Keep
   local Stop available. Confirm both local media closure and native cleanup.
8. Record handset observations and timings honestly. Only after c.1 passes: run
   required checks, commit/tag/push `step-c1-done`, then begin d (presentation) and
   e (desktop entry). The physical test gate remains in force.

## Local task resume commands

Only the coordinating lead handles these private paths. Never print the credential
files or copy them into the repository. This directory contains demonstration task
state; it does not establish a real phone pairing or authorize a call.

```sh
QUALIFICATION_DIR="$HOME/.local/share/clawdtime-coding-demo-qualification"
npm run task:service -- \
  --state "$QUALIFICATION_DIR/task-state" \
  --project "$QUALIFICATION_DIR/coding-fixture/project" \
  --worker codex --checks "$QUALIFICATION_DIR/coding-fixture/checks.json" \
  --port 13323
```

Start only if its previous owner has shut down. Never delete an owner lock merely
because it exists. Use the private task-binding file for the task ID and the
existing task-session file for readiness/status. A new local voice session needs a
new admission event and private output file; all previous launchers are one-shot.
The owner-only `next-session.json` in the same qualification directory records the
exact original host/session identity and resume paths, without credentials. The
existing task session expires at 01:34 on November 19 (America/New_York), so the
morning resume should expect explicit same-scope operator reauthorization. This
routine action is already within the user's continuation request; no repeated
permission question is needed if the recorded identity and cleanup checks match.

```sh
npm run cli -- task readiness --id TASK_ID \
  --session-file "$QUALIFICATION_DIR/task-session.json"
npm run cli -- task reauthorize \
  --session-file "$QUALIFICATION_DIR/task-session.json" \
  --operator-file "$QUALIFICATION_DIR/task-state/operator.json" \
  --pairing-id local-demo-pairing --host-id ORIGINAL_HOST_ID \
  --project "$QUALIFICATION_DIR/coding-fixture/project" \
  --voice true --event-id NEW_EXPLICIT_REAUTHORIZATION_EVENT
```

Readiness is read-only, including after expiry. Reauthorization is an explicit
operator action and changes no task history, voice receipt or permissions. Use it
only when readiness and exact identity checks support it. It does not authorize
handset dispatch or convert the local fixture into a real pairing.

## External prerequisites to verify, not assume

- Fresh single-call authorization and exact tester/line identity.
- A real, current pairing; the local demo's `fixture` recipient/line are invalid
  for dialing. Preserve the local task rather than silently rebinding its identity.
- Protected Chert Calls/native ownership access and scoped LiveKit credentials;
  only ElevenLabs credentials were authorized and used for the completed local test.
- Audio-only customer-managed call support, exact worker/agent identities, and
  independent native cleanup evidence.
- A composed operator path connecting the task authority, call coordinator and
  local audio adapter. Offline component tests alone do not establish a live path.

No camera/helper/gateway permission should be requested for this voice-only test.
Do not route through the older call path that automatically enables screen/video.
Do not change Apple Teams or sibling chert-facetime. If current ownership or native
capability blocks the test, report that specific issue rather than weakening a guard.
