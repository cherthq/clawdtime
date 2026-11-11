# Transport and durable backend

ClawdTime is a single-node SQLite pilot. Its database is independent from Apple
Teams, owner-only, WAL-mode and uses synchronous commits. No source runtime state
is imported. Node 24+ provides the SQLite runtime.

## Source migration

Reviewed/extracted from Apple Teams commit
`be47b11fe1317c4747db4121bec37896998b5201`:

- `src/store.ts` → `src/storage/store.ts`: synchronous transactions, entity/state
  storage and durable effect receipts; the workspace domain was removed.
- `src/security.ts` → `src/storage/security.ts`: random capabilities, hashes,
  constant-time comparison and AES-GCM credentials envelope.
- `src/chert/messages.ts` → `src/transport/native-messages.ts`: exact native
  identity, HMAC request signature, event anchor, sequence validation, observed
  iMessage DM normalization and phone-bound once-only text receipts.
- `src/chert/calls.ts` → `src/transport/native.ts`: explicit logical line,
  customer-managed call allocation, encrypted media credentials, silent/video
  publisher readiness, worker `bridge_ready` activation and cleanup reservation.

This is selective code and protocol adaptation, not a copy of source workspace,
calendar, group, membership, notes or customer data. Group/SMS/attachment/echo
observations never become ClawdTime prose commands.

## Domain and authorization

`ClawdTime` in `src/attention/service.ts` owns pairing invites, scoped credentials,
agent sessions, attention requests, human responses and durable effects. Invite
creation is an internal operation for an authenticated messaging identity, with a
prebound device/display. A caller-supplied phone number is not authentication.
Invites expire after at most 15 minutes and are consumed atomically once. Only
credential digests are stored. Reconnection preserves the external session/project/
host/adapter binding and replaces its credential. Revocation does not revive sessions.

Session credentials cannot read or acknowledge another session's response.
`result` is a repeatable non-consuming read; `ack` records delivery; `resume`
separately records agent continuation and requires a current control epoch and no
active/unknown lease or unknown input. This preserves native agent approval policy.
Cooperative adapters yield before requesting attention; adapters without pause
capability cannot be used for conflicting CUA.

Voice feedback requires the exact active local call, qualified remote participant
and private member binding. A voice approval is rejected. HTTP/media callers must
add participant/source and explicit-addressing checks before calling the domain.
These checks are session context, not biometric speaker identification.

## Receipt and recovery semantics

Request keys are scoped to the exact session and fingerprinted. Reusing a key with
changed arguments fails. A call reservation and pending effect commit in the same
transaction as the request. Dispatch changes pending to running before a network
call. A timeout or restart during dispatch becomes unknown, never pending. Calling
drain again cannot replay an unknown effect. Unknown calls reserve the dedicated
line until reconciliation. New request keys do not escape that reservation.

Human event effects and native cursors commit in the same SQLite transaction.
The entire fetched page is checked for identity/sequence/head consistency before
any command runs. A changed/lost anchor or gap fails closed. `baseline()` refuses
to replace an existing cursor. Historical events never become new commands merely
because the service restarts.

Native allocation is not an answered call. Only authenticated worker
`bridge_ready` enables media, and only `cleanup_complete` releases an allocated
line reservation. Native terminal events close media immediately but preserve the
reservation while native cleanup is pending. End requests are not hangup proof.
Prepared calls canceled before any dispatch can release locally because no external
effect was attempted. Revoked or terminal screen leases remain unknown until the
control coordinator confirms helper release, preventing premature continuation.

`NativeTransport` uses `ct_` plus the first 40 SHA-256 hex characters of the attention
request ID as the media/local call ID. The provider's call ID is stored separately
for native Calls API reads/end requests. Media activation, policy, segments and
helper leases all bind to the local ID.

## Live gates

The runtime must supply an explicit `NativeTransportConfig` with enabled traffic,
exact native binding, current allowlisted tester, isolated media/project credentials,
fresh 32-byte encryption key, and a verified handoff record. That record contains
the exact logical/provider/instance identity, retained baseline and private rollback
record path, and records that the source owner is paused. This object records an
operator's verified handoff; it cannot independently stop another application.
Follow LINE_HANDOFF.md before producing it. Never infer exclusivity from a display
name or run two pollers against the same line.

No live number or secret belongs in this repository. Default execution uses
`SimulationTransport`; simulation receipts explicitly report simulated status and
are not FaceTime delivery evidence. No ClawdTime live call has been qualified by
the transport unit tests.

## Validation

`npx vitest run tests/backend.test.ts` exercises the local durable loop, repeat
calls/results, wrong sessions and identities, request key conflicts, expiry,
no-answer/decline/failure, voice gates, one-use pairing, control epoch arbitration,
revocation, interrupted dispatch, feed identity, atomic event/cursor handling and
sequence gaps. Real call/screen acceptance is recorded separately in STATUS.md.

### Read-only reconciliation and standby cleanup

`NativeTransport.pollCalls()` can recover an interrupted domain commit when the
media ledger already contains the exact provider call ID from a validated call
allocation response. It reads that ID's events, verifies `call_id`, then commits
the existing effect and domain call binding without issuing another dial. If the
allocation response itself was lost and no provider ID was retained, the outcome
remains unknown. No undocumented provider lookup or new call is substituted.

Unknown text-operation receipts retain their original operation origin. The
source adapter does not establish a read-only lookup contract for that API, so
ClawdTime cannot automatically clear them. Operator recovery must obtain exact
provider evidence for the retained origin before changing state. Do not replay a
send, reset a cursor, delete a ledger or invent a new idempotency key to unblock it.

Native hangup is attempted with its stable effect ID even if media close is
unavailable. Media closure and native cleanup are tracked independently. An end
request remains a reserved call until worker cleanup is observed. Standby cleanup
uses `service.drain({cleanupOnly:true})` and native call polling, with no new call,
message, or inbound-message processing. Standby is not permission to abandon an
already-owned native call.

The current operator recovery boundary for unknown helper actions/leases is
conservative: read the exact helper/gateway receipt and prove release/observation
before updating the associated local receipt. There is no public endpoint that
accepts a caller's claimed success. Unknown or submitted-but-unobserved input
blocks agent continuation. Automated operator reconciliation is not claimed.

### Attention question playback

After native `bridge_ready`, media activation finishes its consent notice before
ClawdTime submits a separate question utterance. The spoken question is bounded to
36 words and 280 characters. Its stable ID is `<attention-id>:question`, bound to
the exact local call/media session. A dispatch intent is persisted first. Accepted
or uncertain speech is reconciled only through GET of that exact media receipt;
there is no repeat POST after a timeout or restart. Media-source playout completion
is not proof that the handset was audible. Speech unavailability leaves viewing,
text feedback and call cleanup operational and the speech outcome marked unknown.

### Connector liveness

Registration records `lastSeenAt`. The connector must explicitly heartbeat while
its native agent process is alive; ordinary status/result/authentication reads do
not renew liveness. The backend stops a session after 20 seconds without a heartbeat,
increments its control epoch, invalidates its leases and queues owned-call cleanup.
An expired/stopped session cannot be revived by a late heartbeat or by registering
the same external session ID. Native call reservations remain until confirmed cleanup.

### Native opt-out observation compatibility

The source's installed-feed exception for `lead_opted_out` is retained. A line-less
administrative observation advances the cursor only when its inbound source, exact
message GUID, event ID and recipient correlate to an earlier fully authenticated
message in the retained anchor or same page. It never executes as a command.
Conflicting supplied line identity, another recipient, or future-only correlation
is rejected. Validated cursor rows retain a fingerprint, allowing an administrative
row to remain the next poll's anchor while detecting changed evidence.

## Live setup preflight

`NativeTransport.preflight()` performs GET-only checks of native `/api/v1/whoami`,
the retained event anchor, project-scoped `/api/v1/lines`, and the independent media
`/health`. It neither consumes messages nor advances a cursor, creates a room,
places a call, captures a frame, or changes routing. The protected audit form
`new NativeTransport(store, config, fetch, {readOnly:true})` permits diagnosis before
a handoff is complete and rejects POST through all exposed provider clients.
Incomplete ownership remains a failed readiness check.

Required protected configuration remains `NativeTransportConfig` plus runtime
`testers` entries (`memberId`, `recipient`, `deviceId`, `displayId`). The handoff now
requires matching `phone`, `identityEvidence` and `sourcePauseEvidence` references
in addition to owner, source-paused flag, logical/provider/instance IDs, retained
baseline, finite non-future `checkedAt`, and `rollbackRecord`. References identify
private reviewed evidence; do not put personal identities, numbers or secrets in
tracked artifacts. The logical line is a UUID. The native `pl_` ID and native
inventory UUID are different domains; do not substitute one for the logical ID.

Calls inventory must contain the exact logical line, with confirmed worker identity
and a recent heartbeat. A null inventory phone number is allowed because the
reviewed private handoff supplies the native-to-logical join. A conflicting non-null
phone is rejected. Missing or contradictory logical identity, stale worker heartbeat,
foreign occupancy, or undeclared media capability blocks new effects. A raw
`audio_ready:false` is accepted only when the automatic `system_audio_capture`
check explicitly reports `at_call_start`; this is deferred verification, not audible
handset evidence. A known owned call can remain ready for result messaging; a new
allocation requires idle occupancy.

Media health must identify `service: clawdtime-media`, be configured, and report a
connected device gateway. Scoped helper metadata is read from
`/devices/:device/readiness/:member/:display`. Exact member/display ACLs, attached
display, permissions, availability and local Enable must agree. These are metadata
reads only. They never arm a device or begin screen capture.

`doctor()` reads cached checks no older than 30 seconds, bound to the exact pairing,
member/display and current provider configuration fingerprint. It distinguishes
simulation/standby from `readiness.liveReady`; pairing consent alone does not imply
live readiness. Missing evidence is unknown, never assumed ready. The runtime must
refresh preflight before ingestion and helper evidence for paired users. Call and
message dispatch independently recheck applicable evidence before provider effects.
A failure proven to be in read-only preflight leaves the existing effect pending
with a blocked reason; no external attempt is marked unknown or retried. Once an
external attempt is possible, the ordinary unknown-outcome rules still apply.

### Source pause and resume mechanics

At the audited Apple Teams commit, `LIVE_TRAFFIC_ENABLED=false` while preserving
`APP_MODE=live`, credentials and the existing database stops native message polling
and new worker scheduling/draining. New inbound calls are declined; owned-call
polling continues cleanup. SIGTERM waits for the in-flight integration tick before
closing storage. There is no per-line pause API; the deployment's dedicated-line
ownership must be established before applying its process-wide gate.

Verify `chert.enabled:false`, healthy subsequent heartbeats, zero pending/unknown
jobs and closed owned calls through protected readiness. Review failed jobs rather
than deleting them. Previously accepted incoming callbacks can retain their original
nine-second replay window, so an idle handoff should observe at least ten seconds
after the source pause before enabling another owner. Read the committed
`messages:<logical-line-id>` operational-state cursor in place through protected
operator access; the source does not expose a cursor mutation endpoint. Do not copy
its database or message history. Resuming source ownership requires reconciling all
intervening events and effects before any cursor update; source provisioning rejects
replacement of an existing baseline.

Target standby must call `pollCalls(observe,{cleanupOnly:true})`. This also handles
a crash between provider allocation and domain-receipt commit: retained provider IDs
are recovered only for cleanup, never media activation or question playback. Shutdown
can pass `shouldStop` to `service.drain()` to finish the current effect without
starting another. No deployment or routing changes are performed by these checks.
