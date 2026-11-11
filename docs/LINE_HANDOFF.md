# Controlled test-line handoff

**Current gate: not handed off.** No ClawdTime live poller, deployment or routing
change has been activated. Apple Teams remains the existing owner. Do not equate
a display name with the requested Liam Davis identity.

## Evidence from this implementation session

Read-only provider queries using the source's protected configuration confirmed
`/api/v1/whoami` healthy and an exact match of native provider line ID, phone number
and instance. The project Calls inventory includes the configured logical line,
currently labeled **iPhone control test**. No Liam/Davis label was found in those
responses. This does not prove it is the user-requested Liam Davis line.

The existing local operator credential received HTTP 401 from Apple Teams'
`/internal/readiness`. Therefore current source calls, pending jobs, unknown
effects and cursor cannot be certified using that credential. Provider availability
alone is insufficient. No private identity/number/token is recorded in this file.

Required next evidence: resolve Liam Davis to the exact native and logical line
using authorized private operator inventory, and obtain current read-only source
readiness access. Do not change routing until both are established.

## Preflight record (private, mode 0600)

Record exact logical line UUID, native provider ID, native instance and phone,
provider project/integration/routing owner, current ownership generations, source
application/service/deployment IDs, confirmed tester identity, cursor sequence and
event ID, active calls/rooms, pending jobs and every unknown action. Record the
source config snapshot and its secret-store references, not secrets in Git.

The target backend/media/helper each need independent fresh secrets and durable
volumes. Deploy them in standby under new names. Do not overwrite Apple Teams.
Keep one backend process. Do not copy its database, messages or receipt ledgers.

## Handoff procedure

1. Complete local component/client/browser tests. Confirm the tester's Mac setup,
   explicit display, grants and local Enable; verify read-only helper readiness.
2. Inspect source readiness and provider call inventory in the same idle window.
   There must be no active call, pending effect or unresolved native action that
   could conflict. If there is activity, wait or ask about that exact conflict.
3. Drain and pause Apple Teams dispatch/poll/answer ownership for this specific
   line. Record the terminal committed cursor and source pause evidence. A variable
   change can restart a service: verify the actual pause and no competing process.
4. Reconcile any event arriving during the pause, using provider IDs and source
   receipts. Select a retained non-replaying sequence/event anchor, never just a
   timestamp or newest number. Preserve all source ledgers.
5. Produce a private `NativeTransportConfig` handoff record: owner `clawdtime`,
   sourceOwnerPaused `true`, exact lineId/providerLineId/instanceId, verified
   baseline `{sequence,eventId}`, checkedAt and rollbackRecord reference. Add only
   the intended tester to testerAllowlist and device/member mapping. This record
   is an operator attestation, not a distributed lock.
6. Start the independent target with its protected config and `CLAWDTIME_MODE=live`
   plus `CLAWDTIME_LIVE_TRAFFIC=true`. Startup verifies native identity and retained
   anchor before ingestion. Confirm source remains paused throughout qualification.
7. Run the supervised acceptance matrix. Record private receipts and sanitized
   outcomes/timings. Retain or roll back the line according to the agreed test.

## Rollback

1. Switch ClawdTime to standby **with its existing protected live config**. It stops
   new inbound polling/calls/results and requests cleanup of owned calls. Verify
   native cleanup_complete, media room closure and confirmed helper release.
2. Preserve unknown effects and all new native receipts. Reconcile all events
   observed between old and new ownership boundaries; do not restore a stale cursor.
3. Re-establish the source cursor only after each intervening event/effect has an
   ownership decision and receipt. Restore the recorded approved line routing and
   config. Confirm ClawdTime cannot dispatch before Apple Teams resumes.
4. Verify source heartbeat/native identity read-only. Do not send unsolicited
   messages or place extra calls merely to prove health.

No automatic production routing mutation script is provided: the source deployment
and exact requested line identity remain unverified. Runtime handoff guards and
cursor tests exercise the local contract; **live handoff and rollback are untested**.
