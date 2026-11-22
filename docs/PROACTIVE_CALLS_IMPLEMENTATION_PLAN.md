# Proactive calls and prepared walkthroughs

Draft: November 22, 2026. Source baseline: main `0b3d518`.
This is a proposed implementation and rollout plan. No calling, permissions,
runtime configuration or deployment is changed by this document.

Operator direction: after implementation and automated/integration checks pass,
deploy directly to the production Mac. Do not introduce a separate scoped call
test, pilot rollout, or another deployment-confirmation step. Preserve a verified
checkpoint of the currently working installation before changing it. Production
call identity, permissions, exclusive ownership and Stop remain requirements.

## Intended experience

The person assigns work and chooses whether ClawdTime should call when it needs
input, when a checked result is ready, or both. ClawdTime retains that request,
works independently, prepares the relevant explanation and authorized views,
then calls once. The person can discuss a decision or review the result, give
instructions, stop sharing, or hang up. Work continues only under its existing
permissions. The supervisor remains active without this Codex chat polling.

Keep three distinct choices: chat notification, spoken phone alert, and phone
walkthrough. An explicit "call me" must never become only a chat notification.
A phone alert does not implicitly authorize exporting the screen.

## What exists and what is missing

| Area                         | Existing implementation                                                                                                                        | Required integration                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Blocked agent requests       | `connectors/agents/hooks.ts`, `decisions.ts`, `feed.ts`, `call.ts` can call about an exact pending request in Away mode.                       | Configure the outbound connection; persist shared scheduling and preserve native approval boundaries.                               |
| Session incidents            | `watch.ts` detects waiting, failure, stalling and completion; default calling covers waiting/failure.                                          | Route eligible incidents through the same durable call queue, with explicit user preferences.                                       |
| Requested completion notices | `brain.ts` exposes `watch_session`; `sessionnews.ts` stores watches and writes chat news.                                                      | Preserve requested channel, run identity and independent delivery receipts.                                                         |
| Launched coding jobs         | `jobs.ts` starts real Claude/Codex terminal sessions with launch/result receipts; `jobnews.ts` reports results in chat.                        | Connect job provenance, independent checks and prepared reviews. An answer file is not verification.                                |
| Managed task reviews         | `TaskReviewService` and `TaskReviewCallbackLedger` retain callback intent for known checked results.                                           | Supply authorized preparation and delivery automatically. The resolver is optional and currently unwired.                           |
| Visual calling               | `TaskDesktopCalls`, `task-handset-runtime.ts`, presentation services and media code implement exact-result/window validation and call cleanup. | Connect these to the installed supervisor and common line owner; replace manual setup steps with bounded policy-backed preparation. |

Read-only installation audit: Away is off; the supervisor has no outbound phone
link; the desktop launcher omits managed-worker checks and calls configuration.
The desktop task service reports simulation mode, while its separate Jobs path
launches real Claude sessions. Those are different execution paths. The current
connector's outbound readiness also reports retained uncertain state and a paired
helper binding mismatch. Incoming FaceTime succeeded; that does not qualify this
outbound flow. Recheck these findings before implementation or installation.

## 1. Establish call policy and one durable coordinator

Add a protected, revocable policy for the exact person, device, project and task
or explicitly enrolled session. Record trigger types, delivery channel, expiry,
allowed hours, rate/call limits, permitted view scope and any alert-only fallback.
Expose a simple setup/task option: "Call when you need me", "Call for review", or
both. Away mode controls broad unattended alerts; an explicit task-specific call
request follows its recorded policy even when global Away is off. Quiet hours,
revocation and line availability still apply.

That task-specific mode also needs scoped hook supervision. Today `superviseAway`
and `agent-hook.ts` depend on global desk attendance/Away; an unattended hook is
not held, and Away-off holding has a short deadline. Register enrolled-session
attendance before work starts, with a fresh supervisor heartbeat and a bounded
phone-response deadline. Panel closure must not remove that scoped supervision.
Revocation, expiry or heartbeat loss releases the wait through the agent's normal
permission flow; unrelated sessions keep their existing behavior.

Existing requests require `userAuthorizedOneCall: true` and exact export grants.
Implement a versioned policy authorization path that issues a fresh, bounded
attempt grant from explicit recorded consent. Do not reuse an old one-call
approval, fabricate its boolean flags, or treat worker/model output as consent.
Call permission, screen viewing and input permissions remain separate. Existing
single-call operator envelopes remain supported without being upgraded silently.

Route decision requests, incidents, explicit watches, job results and managed
reviews through one service-owned coordinator. Reuse the durable receipt and
unknown-outcome behavior of the existing review/call ledgers; replace the
connector paths' in-memory-only deduplication. Use discriminated source bindings:
exact decision ID, job/launcher/run identity, enrolled session/run identity, or
task/run/revision/verification identity. A title or PID alone is insufficient.

Persist queued, preparing, ready, dispatching, connected and ended states, plus
canceled, expired, refused and unknown outcomes. Reserve an attempt atomically
before any dial. A lost response or restart during dispatch requires reconciling
that receipt; never redial automatically. Delivery does not mean result acceptance.

Prioritize a still-pending question over failure alerts and finished reviews.
Suppress the matching generic waiting incident. A locally resolved question
cancels its queued call. Never preempt an active call or deliver its answer to a
different request. Revalidate source state and policy immediately before dispatch.

## 2. Connect completion watching and real job evidence

Extend `watch_session`, its deterministic request routing and persisted watches
with a stable watch ID, exact subject/run, trigger, delivery channel, policy ID,
expiry and state. Keep legacy watches chat-only. "Tell me here" stays chat;
"call me when this finishes" creates a phone intent; "call and show me" requires
the configured walkthrough policy. Resolve ambiguous session names before arming
the watch. Cancellation revokes pending delivery without losing old receipts.

Give new Jobs stable provenance linking the launch receipt, project, agent,
observed session, run generation and result digest. Keep the installed Claude
launcher working. Add a job-result verification adapter and a typed external-job
review subject; do not turn an arbitrary observed session into a fabricated
managed Codex task or start a replacement session. Run bounded independent checks
only within the authorized project, preserving existing execution ownership.

Use authoritative terminal/hook events where available. Board idle, process
disappearance or `result.md` can establish an observation, not verified success.
Unknown/stale work gets an honest status or blocked notice, never a success
walkthrough. Continue excluding generic headless sessions from board incidents;
explicitly registered headless Jobs use their receipts and the same dedupe key.
An explicit completion watch must also work for a short job; it should not inherit
the generic incident watcher's three-minute minimum. A watch timeout is an expired
watch, not proof that work completed or failed.

For new managed Codex tasks, wire the existing real worker and verification plan
instead of simulation when that workflow is selected. Do not switch all Claude
jobs to Codex as a shortcut. Task, Job and session adapters converge at the review
coordinator, while each retains its own lifecycle and permission model.

## 3. Automate preparation before dialing

Build a bounded review packet from current evidence: goal, changes or blocker,
verification status, question/choices, narration, artifact references, exact
authorized views and an ordered walkthrough. A blocked mid-run permission or
question has its own decision binding; it does not require inventing a completed
result or successful verification. User cancellation does not trigger a completion
call. Failures explain what failed and what decision is needed.

Separate preparation into two stages:

1. An effectful, authorized preparation service creates or selects the approved
   result/check views, validates artifact and window identities, and obtains
   fresh bounded grants through the policy authority. Any view opening or capture
   follows existing exclusive-control and capture rules.
2. The existing read-only `ReviewPreparationPort` resolves that already-prepared
   packet for delivery. Keep its prohibition on capture, spawning, dialing and
   minting authority. `TaskReviewService.configureDelivery` then receives it.

Reuse manifest/grant validation, local presentation and handset preparation.
Require fresh source frames and transport readiness before dialing. Bind every
packet to the exact run/result revision and invalidate it when work changes.
Keep screens/audio transient; durable records hold bounded metadata and receipts.
Failed preparation remains visibly blocked. Only a separately authorized policy
may downgrade a requested walkthrough to a spoken alert.

`TaskDesktopCalls.request` currently requires the task selected in the panel.
Introduce a policy-bound call context for automatic reviews, or an explicit
equivalent admission mode, so another selected task cannot redirect the call.
Preserve the current selection rule for manual panel calls. Do not silently
change the selected task merely to pass this check.

## 4. Connect outbound delivery to the installed line

First reconcile the original uncertain outbound receipts and helper binding
mismatch using their exact identities and cleanup evidence. Keep unresolved
records intact. A healthy incoming host is not evidence that the older outbound
connection is correctly bound.

Connect the supervisor's protected outbound pairing and review configuration.
Verify destination, service/helper identity, provider/model readiness, permissions,
session lifetime, local Stop and actual line ownership. Do not start a competing
poller or another live owner alongside the incoming `chert dev` host.

Use one line coordinator for inbound and outbound admission. Inspect the existing
provider control and handoff interfaces before implementation: if the current
incoming owner cannot support outbound calls, add a reversible idle-boundary
handoff through supported interfaces. Do not assume that an idle line is an
unowned line. Inbound arrival during preparation must defer the unsent outbound
intent; an uncertain outbound submission holds the line until reconciled.
Restore incoming ownership only after confirmed call/capture cleanup.

The current handset runtime also depends on a Railway-backed readiness inspector
and exact standby/restore evidence. Validate and configure that dependency, or
introduce an equivalent tested local readiness port preserving its identity,
cursor, ownership and authorization checks. Never insert placeholder evidence.
Changes requiring the sibling provider repository are a separately reviewed
dependency; this plan does not authorize modifying it.

Preserve the recent warm-media fix for incoming calls. Before declaring outbound
readiness, verify stable publication identity, actual remote audio/video receipt,
greeting, capture freshness and cleanup. A local publication ACK is insufficient.

## 5. Continue the right session and expose truthful status

Route phone decisions back to the exact pending request or enrolled task/run.
Recheck that the question is still pending before applying an answer. Preserve
native agent approvals; phone dialogue cannot silently approve unsupported
permission requests. Existing arbitrary Codex chats are cooperative and cannot
be universally woken or interrupted. Supported Jobs/hooks and managed workers
need explicit continuation paths and recorded outcomes.

After a revision, retain allowed call-scoped sharing but invalidate obsolete
result claims. A newly checked revision gets fresh review preparation. Acceptance
applies only to the reviewed result and never authorizes deployment. Hangup ends
the call; it does not implicitly cancel independently running work. Stop sharing,
Stop work, Stop calling and hangup remain distinct controls.

Show states such as watching, preparing walkthrough, waiting for line, calling,
needs setup and outcome unknown. Acknowledge what was actually registered. Provide
a read-only proactive-call doctor covering policy, source adapter, outbound link,
preparer, line owner and recovery blockers. Do not announce "I'll call" when no
phone intent was retained or configuration prevents delivery.

## 6. Validate, then deploy directly to production

Implement in dependency order: durable coordinator/policy → source adapters →
prepared views and authority → line integration → installed enablement. Complete
all three requested paths before production deployment. These are implementation
dependencies, not separate user-facing pilot or scoped-call rollout stages.

Extend the existing agent call/watch/session-news, review callback/lifecycle,
desktop call, handset runtime and presentation tests. Cover:

- Exact channel survives restart; chat delivery cannot consume phone delivery.
- One blocked request yields one call across hook, watcher and Job observations.
- An opted-in blocked task works with Away off and the panel closed; lost scoped
  supervision or revoked policy releases the hook without approving it.
- Real Claude Jobs and managed Codex results retain distinct truthful evidence.
- Missing result, failed checks, canceled run and changed revision cannot produce
  a success claim or stale walkthrough.
- Revoke/expire policy during preparation; exhaust call budget; resolve a question
  locally; retain a busy line without dialing or consuming the wrong request.
- Crash before/after reservation, lost dispatch response and restart preserve
  unknown outcomes without duplicate calls or silent redial.
- Wrong selected task, wrong helper, stale frame, duplicate tracks, capture drain
  failure and call-time revision remain fenced.
- Stop/hangup clears capture and restores line ownership only after confirmed
  cleanup; ordinary coding can continue under its original authority.

Run `npm run check`, `npm --prefix line test`, Swift tests/build, and the relevant
media/gateway suites for changed components. Use synthetic fixtures for automated
integration coverage. Do not require a separate real-phone rehearsal or scoped
call-test approval before deployment.

Preserve the current working installation using the
[production rollback baseline](PRODUCTION_ROLLBACK_BASELINE.md). Stage the
completed release beside it, then install directly in production during an idle,
reconciled boundary. Preserve protected credentials, task history, configuration
and receipts; never overwrite live stores with checkpoint-era data. Migrate
watches/ledgers without upgrading historical consent or replaying pending work.
Enable the requested proactive behavior under its explicit calling/viewing policy
as part of that production deployment. This rollout is already authorized; do
not ask for another deployment confirmation merely because development finished.
Keep automatic source updates held so the release and rollback target stay pinned.

After deployment, run read-only production health checks and monitor the actual
production workflows below. They are operational verification, not a predeployment
scoped-test gate. Record which have actually been observed; deploying successfully
does not by itself prove handset playback or screen visibility.

1. A real Claude task needs input: one call, correct question/view, valid answer
   reaches the same task, and work resumes.
2. A real task finishes: independent checks, prepared result views, one outgoing
   call, readable walkthrough and exact-result acceptance.
3. "Call me when this session finishes" actually rings; "tell me here" stays chat.
4. Missed call, busy/incoming line, Stop, hangup and service restart do not duplicate
   calls, resurrect capture or lose pending/unknown receipts.
5. Incoming FaceTime continues to work after outbound cleanup.

Record the installed versions, observed handset results and remaining limitations.
Rollback disables new outbound admission and restores the checkpoint's code and
compatible configuration after reconciling current effects; retain all newer
receipts and task state. Require additive/backward-compatible storage changes or
a tested compatibility reader before deployment so rollback remains usable.

## Completion criteria

All three requested paths use the shared coordinator. New supported work can
produce a real blocked-work or result-review call with no per-call operator JSON
or active Codex chat required, within explicit configured policy. The complete
release is installed directly in production after checks pass, with health and
rollback integrity verified. Record handset-observed acceptance separately as
normal production usage occurs. Unsupported external sessions and preparation
failures have concrete visible explanations, and incoming calling is monitored
for regressions.
