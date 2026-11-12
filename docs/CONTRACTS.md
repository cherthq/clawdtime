# V1 implementation contracts

## Version 2 additions

Registration `protocolVersion:2` is immutable and negotiated per exact session;
missing/1 preserves all legacy routes below. Capabilities distinguish native
none/browser/desktop, actual shared-surface support and cancellation support.
New connectors default v2; no active session is upgraded in place.

Under `/api/attention/:id/conversation/` the session bearer scopes every operation:
GET `turns?after=N`; POST `ack {turnId}`; `progress {turnId,state}`;
`reply {turnId,replyId,text}`; `cancel {turnId}`; and explicit `end {}`.
Delivery acknowledgement, execution completion, call end and sharing release
are separate. Unknown replies reconcile through their existing receipt without
repeating speech. Pending text retention is bounded; receipts remain durable.

GET `execution` reports owner/epoch; POST `execution` requires expectedEpoch,
executor (none/native/clawdtime), previousOutcome and backgroundActorsStopped.
POST `observe {epoch}` and `act {epoch,actionId,frameId,action}` require current
fallback ownership and local revision. They never invoke a conversation model.
A native shared-surface capability is not macOS permission or approval bypass.

## Legacy version 1

Canonical types: src/contracts.ts. Times are Unix milliseconds. IDs are opaque.
Backend exports Store from src/storage/store.ts and ClawdTime from
src/attention/service.ts. Lead composes HTTP routes; specialists implement domain.
Backend specialist defines exact public method signatures early and tells lead and
connector specialist. No agent uses arbitrary terminal injection to resume work.

Agent HTTP API (bearer pairing credential for register; session credential afterward):

- POST /api/sessions {SessionRegistration} -> {session, token}
- POST /api/attention {RequestAttentionInput} -> {request}
- GET /api/attention/:id -> {request}
- GET /api/attention/:id/result -> {request, response?} (non-consuming read)
- POST /api/attention/:id/ack {responseId} -> response delivery acknowledgement
- POST /api/attention/:id/resume {controlEpoch} -> explicit continuation acknowledgement
- POST /api/attention/:id/complete {text} -> durable Messages result
- POST /api/sessions/yield -> {session} (cooperative pause, needed before CUA)
- POST /api/disconnect -> revokes current pairing and sessions
- GET /api/doctor -> scoped readiness, no secrets

Pairing API: authenticated inbound messaging produces expiring one-use link.
POST /api/pairing/claim {token, deviceId, displayId, allowView, allowControl}
requires exact prebound device (device binding established on creation).
No supplied phone number establishes identity. Simulation uses explicit fixture.

Effects commit before dispatch, use stable IDs, and become unknown after interrupted
running state; reconciliation only. Result reads are idempotent; acknowledgement
requires exact session and response ID. Live transport defaults off and requires an
operator handoff record, an allowlist and verified provider identity/event anchor.

Acceptance gates: backend and connector tests/build; Python/Swift suites; browser
pairing flow; real installed client cooperative MCP spike; separately actual phone,
screen, feedback/CUA, continuation, result and handoff/rollback evidence.

Session liveness: POST /api/sessions/heartbeat {} returns {session}. The MCP
process refreshes every five seconds. A 20-second gap stops the session, invalidates
control and requests cleanup; late heartbeats and same-run registrations cannot
revive it. Media/control policy also checks lastSeenAt independently of worker ticks.
