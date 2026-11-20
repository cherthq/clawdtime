# Long-running tasks and supervisor review

November 20, 2026. Development branch `task-review-lifecycle`, based on
`direct-task-start` at `763ea9b` and main at `4a8b9d7`.

## What changed

The production supervisor classifies the latest human request into a structured
intent. It sends the complete original goal to the task service only after
deterministic capability, identity, state and idempotency checks. Revisions bind
to the current task. A short confirmation can refer only to one unexpired pending
proposal; assistant prose and old conversation history cannot supply a new goal.
Native permissions and the user's automatic ClawdTime action setting are unchanged.

The Codex coding worker has no overall elapsed-time deadline. Individual RPCs
remain bounded. Stop requests interruption, then waits for the authoritative
terminal event; missing confirmation preserves uncertainty. Progress phases,
fixed diagnostic codes, and outcome history are separate from the run's duration.
The independent verification plan runs only after a known worker result. A
worker's summary or files on disk do not establish verification or acceptance.

Every known checked result schedules a durable supervisor-owned callback record
bound to session, task, run, revision and verification. Failed/blocked results
prepare an honest decision brief; they are never described as successful.
Canceled tasks do not schedule completion callbacks. Original goals and their
restrictions remain in worker context and review context across revisions.
Acceptance applies to the current verified result and never deploys anything.

## Preparation and delivery

`TaskReviewService` prepares the result summary, independent check results,
narration, original goal and review question. Its view checklist covers the
current result, changed source and independent checks. This context is not proof
that a window has been captured or that a phone rang.

The existing exact-window presentation and handset runtime performs actual view
validation, first-frame preparation and dialing. The supervisor does not create
a second phone actor. An operator can stage a fresh, exact
`desktopCallRequestSchema` envelope at:

```text
POST /operator/review-callbacks/:callbackId/prepare
```

This route uses the protected operator token, rejects browser Origins, and
retains the existing bounded JSON body limit. The envelope includes the exact
manifest/grant, result identities, one-call authorization, authorized lifetime,
and specific standby/restore evidence. It is encrypted outside the worker project.
HTTP 202 means queued, not delivered. The supervisor pump dispatches it once
through `TaskDesktopCalls.request`. A matching duplicate reads the same receipt;
conflicting content is rejected. Queued envelopes survive restart. Submission
interrupted by restart becomes unknown and is never retried.

`ReviewPreparationPort` permits a read-only resolver to supply an already
authorized current envelope automatically. It must not spawn, capture, mint
authority, dial or perform other external effects; resolution can be repeated
after restart. Production defaults to the protected staged envelope queue. An
unattended current-window/line-authorization resolver is **not configured by
default**. Until exact views and phone authority are supplied, status reports
the concrete preparation blocker rather than promising a callback. This is an
external preparation gate in the current pilot, not a claim of zero-setup calling.

Each checked revision gets its own callback. Connected review, delivered review,
failed connection, and unknown delivery are retained separately. Neither no
answer nor uncertain delivery authorizes redial. The same task voice service
handles spoken revisions and exact-result acceptance. A revised result must pass
independent verification and receive its own fresh prepared review authority.

## Exclusive ownership and continuous views

Bundled execution and phone review can be configured in the same service. Before
phone preparation, the service synchronously fences new local execution and
requires all local work and capture cleanup to be confirmed. Native combined mode
requires a helper advertising `nativeCaptureDrain`; stop must return both
`stopped: true` and `captureStopped: true`. A legacy helper is refused before
acquiring a new local lease. Capture drain failure remains uncertain. Confirmed
call cleanup releases ownership; uncertain call receipts retain the fence across
restart. The existing external desktop-chat executor remains mutually exclusive.

Call-scoped sharing retains the current authorized view across task submission,
revision and acceptance. New views replace it only after fresh source frames
arrive. The media fix covers invalidation immediately followed by a scene switch.
Stop, revoked authority and real freshness failure still clear capture. Local
testing does not prove handset continuity or resolve the historical SDK/export
capture stalls.

## Existing interrupted run and installation

Read-only inspection confirmed that the installed coding run remains unknown and
has no independent verification. Its retained timing matches the old three-minute
cutoff. The worker created an ephemeral Codex thread; the desktop thread reader
could not retrieve a terminal record for that thread. The draft files remain
uncommitted in the selected project. Speech used a different product name than
the intended demo; this remains a transcription/content discrepancy, separate
from the timer and task-routing defects.

No task, receipt, cursor, configuration, credential or draft was deleted, retried,
marked completed, or copied into this repository. The installed supervisor and
helper were not restarted or replaced. The installed settings still select native
execution and automatic ClawdTime action confirmation; phone callback setup is
absent. Read-only helper status showed no active lease and zero unresolved input
actions, while the coding task's independent unknown-outcome fence remains.

Before installation, resolve that original run through reviewed recovery using
authoritative terminal evidence, or explicitly retain it as unresolved while
establishing a separate approved execution scope. Do not reset its ledger, infer
success from files, or silently replay the task. An idle process alone does not
resolve the run. The installation must preserve protected settings, model hooks,
credentials and all ledgers. The updated helper is required for combined native
execution/capture handoff.

Rollback: retain the current protected runtime release and symlink target; stage
the candidate beside it, never over it. Switch only during a reviewed idle handoff
after owner/capture/call cleanup is confirmed. If reverting code, keep the current
database and receipt history, verify that no callback is queued/inflight/unknown,
and keep dispatch disabled until old-version handling of new records is reviewed.
Never restore a stale database or cursor to make an old binary start.

## Validation boundaries

`npm run check` passed with 1,859 tests in 97 files, typechecking and production
build. Swift passed 181 tests; the full media suite passed 382 tests, with four
focused probe tests also passing on the final diagnostic code (three overlap
with the full suite). Gateway passed 29 and installer tests passed 21.
Independent connector and lifecycle review findings were addressed.

The local capture probe was actually attempted on disposable synthetic windows,
with no room/export/audio/input and no persisted pixels. One brief smoke passed;
an earlier extended attempt was interrupted and remains inconclusive. Subsequent
instrumented attempts failed the unchanged geometry guard. The latest attempt
stopped at native elapsed 7,579 ms with `refused_geometry`, after 36 source frames
and 107 rendered frames. Helper and fixture cleanup were confirmed. Read-only
geometry inspection also observed a fixture window outside the active display.
No screenshot-latency repair or four-minute local capture pass is established.
The next local test needs two stable exact fixture windows wholly inside the
active display for the full four-minute run. Keep the one-second freshness and
geometry guards intact; no handset test is prepared for dispatch from this result.

The runtime package was built locally without installation. The first development
package records its dirty source state accurately; use the final commit-pinned
candidate documented in the delivery report for a future reviewed installation.
All protected installed settings and the unknown historical run remain unchanged.

The simulated lifecycle uses the real supervisor, task engine, Codex adapter,
verifier boundary and callback orchestrator with isolated synthetic protocol and
call ports. Virtual time advances beyond 180 seconds before completion. Regression
cases cover revisions, exact acceptance, Stop, disconnect/process exit, delayed
events, restart, duplicate delivery and unknown outcomes. Separate native helper
and media tests check capture drain and scene continuity.

No live call, production deployment or remote screen share is authorized by this
development session. Handset visual acceptance remains a separate gate after
local capture qualification, exact current views, fresh phone authority and an
exclusive line handoff are ready. Historical consumed call permissions cannot be
reused.

Codex lifecycle semantics were checked against the
[official App Server documentation](https://learn.chatgpt.com/docs/app-server#lifecycle-overview):
interruption is followed by a terminal notification; sending interruption alone
does not prove the turn stopped.

## Integration choice

`origin/anishfyi/computer-use` was inspected after fetching remote refs. It is not
an ancestor of current main. Its `connectors/computer` worker, browser driver and
panel Hands controller introduce another bounded capture/input owner; merging it
wholesale would compete with the installed bundled runtime and omit some newer
native protections. Its task admission remains phrase-gated. This change retains
the existing task/voice/presentation architecture and bundled helper, adds semantic
intent to that supervisor, and leaves the independent branch/worktrees intact.
No Apple Teams or sibling chert-facetime files are modified.
