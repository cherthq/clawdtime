# Desktop-created tasks and prepared calls

The desktop service can carry a task through a decision call, a new scoped run,
independent verification, and a separate final-review call without closing the
panel service or handing its database to another process. One owner holds the
task store, worker engine and voice service. Attempt-local media, capture,
inspector and voice/presentation HTTP resources retire when that call ends.
The standalone handset script reuses the same runtime and remains available.

This checkpoint implements and tests the integration. It does not establish
handset acceptance or automatically authorize calls. Existing installed services
and private configuration are not changed by building it.

## Configure without dispatching

Use an already authorized paired task session for the selected project and an
explicit verification plan, both in protected files outside the worker project:

```sh
npm run task:desktop -- --state /absolute/private-state \
  --project /absolute/selected-project --worker codex \
  --checks /absolute/private/checks.json \
  --session-file /absolute/private/session.json \
  --calls-config /absolute/private/desktop-calls.json
```

All configuration files must be bounded, owner-only regular files with private
parent directories. The existing launcher fingerprints the exact static calls
configuration. Changing it against a running or prior binding is refused, not
silently applied. It never upgrades a local-only session, creates a pairing,
renews authorization or pauses a hosted dispatcher. No provider connection,
inspector, media process, screen capture or call starts on launch or reopen.

The strict configuration schema is `desktopCallsConfigSchema` in
`src/control/task-desktop-calls-config.ts`. It contains version 1, protected
provider/LiveKit file paths, the existing inspector bundle, Python and helper
executables, an existing owner-only attempt root, exact native destination
binding and Railway project/environment/service identity. Optional distinct
`ports: {task, media, stop}` override the scoped attempt defaults 13323, 3322 and
13324; none may overlap the desktop port. Executables and inspector must be
outside the worker project and protected from group/other writes. Do not put
credentials, a task ID, a reusable call authorization or mutable per-call grant
inside a public example or the worker project.

## Prepared authorization boundary

The operator-only routes on the existing loopback service are:

- `GET /operator/desktop-calls`: current selected task/run/revision, authoritative
  brief, verification ID and sanitized admission receipts.
- `POST /operator/desktop-calls`: one exact prepared call request; HTTP 202 means
  the request was recorded, not that a phone rang or a frame appeared.

Use the protected operator credential, not the UI or task-session capability.
Browser Origin requests are refused. Requests are bounded by the task API's
32 KiB JSON limit. Keep authorization headers out of shell history/output; read
them from the protected operator file inside the requesting process.

`desktopCallRequestSchema` defines the request: stable `eventId`, selected
`taskId`, current `runId` and `expectedRevision`, unique `authorizationId`,
`authorizedAt`, `expiresAt` (at most five minutes after authorization),
`callDurationMs` (30 seconds–15 minutes), explicit one-call/prepared-window-export/
task-instruction authorization, and `prepared: {manifest, grant}` using the
existing presentation contracts. The manifest must exactly match the current
brief/opening and verification. The local view grant must cover the call lifetime and new desktop requests must
include `continuity: "call"`. Sharing continues through task revisions and
acceptance; another prepared view replaces the current one after its first fresh
frame. Stale prepared result labels/narration are suppressed without clearing
live pixels. Explicit Stop, expiry, revoked authority or capture failure still
clears the picture and cannot silently restart.
The runtime derives one immutable attempt and separately scoped export grant.

Prepare current app, source and verification views using the existing exact-window
workflow before submitting. The panel reports when a verified result or product
decision needs a call, but this checkpoint does not add automatic window setup,
arbitrary window selection, broad export consent or unattended dialing. Native
identity checks and media first-frame preparation still precede the actual dial.
The existing read-only inspector must prove exclusive line ownership and current
authorized destination. A required standby deployment still needs its separate
authorization and must be restored afterward.

A matching duplicate request reads its original receipt and never starts another
attempt. Changed content with the same event ID is rejected, including changed
duration or grants. A final review uses fresh views and a new specifically
authorized request after the spoken follow-up run and independent checks finish.
An unanswered call does not authorize redial.

Each request also supplies `standby: {deploymentId, restoreRecord}` for that
specific authorized standby window. These changing fields are not part of the
desktop's permanent configuration or fingerprint. The native inspector verifies
the actual running deployment against this evidence before dialing; supplying
the fields does not itself establish readiness. Changing this evidence under an
existing event ID is a conflicting request, not permission to dispatch again.

## Stop, continuity and recovery

The same native panel exposes Stop call during preparation; stopping there latches
cancellation and prevents later dialing. Once active, Stop sharing and Stop call
target that exact attempt through the existing cleanup paths. Neither closes the
parent engine or cancels coding. UI close/reopen retains its capability and task.
Task cancellation remains a separate operation.

An encrypted admission receipt is written before voice admission or external
effects. On restart, starting/active admissions become unknown. No constructor,
poll or launcher replays them. An unknown admission blocks subsequent calls and
is surfaced in readiness; confirmed native, media and presentation cleanup is
required before another attempt. Never delete receipts, replace authorization
IDs or remove owner locks to force a retry. Reconciliation must inspect the
original attempt and its coordinator receipts; there is no generic force-clear
endpoint in this checkpoint.

## Remaining acceptance

Offline tests exercise the complete desktop/HTTP/task/voice lifecycle using
explicitly synthetic worker, verification and call ports. They are not phone or
real-pixel acceptance. Before tagging steps d/e complete, perform the plan's
three specifically authorized two-call rehearsals from the panel, verify the
rendered result, and measure ringing/opening/response, twenty interruptions,
twenty prepared zooms, ten-minute audio continuity, a twenty-second quiet pause,
and Stop clearance. Begin handset motion checks at 15 fps. Preserve explicit
authorization for every call, current scene grants and exclusive line ownership.
