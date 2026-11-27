# Shared number routing implementation plan

This plan describes the design and the boundaries of shared-number routing.
It does not describe any deployment. A checkout does not prove what a host
runs. Keep deployment records outside this public repository. Setup and
operations are in [SHARED_NUMBER_SETUP.md](SHARED_NUMBER_SETUP.md).

## Status

The integrations are in the code. They are not qualified.
`clawdtime shared` says that shared calls remain unavailable until the
provider, media and callback integrations are qualified. `clawdtime shared
doctor` reports live shared-call acceptance as not qualified. No two-member,
two-Mac physical test has run.

Changes in progress: call proofs bound to the paired Mac, sign-in limits, call
liveness, re-pair and revoke.

Not built: email identities, shared inbound texting and a background
participant service. The older masked-number text poller must never be used
for shared routing.

## Provider integration

The service uses a signed HTTPS webhook integration with `customer_decides`
and no default Assistant. Outbound callbacks use the Calls API. The webhook
stays assigned during callbacks, so there is no per-call connector release
and reclaim. The previous dedicated connector releases the line once, at
migration. The optional custom BYOR handler is not the intended path.

## Components

- Phone sign-in, durable limits, hashed sessions and separate call proofs.
- One coordinator with private configuration, a durable SQLite call slot,
  exclusive process ownership and distinct account, device and line tokens.
- Outbound HTTPS Mac polling, pinned desktop lifetime, local leases and Stop,
  transient display frames and no replay after an uncertain command.
- Signed incoming webhook validation, bounded decision deadlines, replay
  fencing and transient room credentials. Unknown allocation keeps the slot.
- Provider readiness checks for the exact project, integration, line, worker
  and absence of a competing connector. No caller handle authorizes a Mac.
- Exact job launch and exit receipts, original-owner callback consent and
  completion reporting. Shared jobs bypass the dedicated-owner callback path.
- Callback room preparation and Calls submission with one stable effect ID.
  Worker `bridge_ready` gates narration. An allocated call is not an answer.
- Terminal provider cleanup, observed media removal and route checks before
  freeing the slot. Read failures retain ownership without redialing.
- Walkthrough reports bound to the exact task and result on the original Mac.
  The local user chooses whether reports may open. Reports contain escaped,
  inert text, not executable instructions or automatically followed URLs.
- Same-call computer actions after verification, including during callbacks.
  Routine lease renewal does not forget the callback task.
- A standby mode for the coordinator and a separate voice-worker
  configuration. In standby, health answers and every other route returns 503.

Each Mac needs the local desktop service, model credentials, native
permissions and an active `shared run` connection. The shared number has one
simultaneous call slot. Each participant verifies their phone and pairs only
their own Mac.

## Where the code lives

| Area                   | Files                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Contracts and domain   | `src/shared-number-contracts.ts`, `src/shared-relay-contracts.ts`, `src/control/shared-number.ts`           |
| Coordinator            | `scripts/shared-number-server.ts`, `src/shared-number-app.ts`, `src/control/shared-number-relay.ts`         |
| Phone sign-in          | `src/pairing/shared-phone-identity.ts`, `src/transport/shared-verification-text.ts`                         |
| Provider and callbacks | `src/control/shared-provider.ts`, `src/control/shared-callbacks.ts`, `src/transport/shared-provider-api.ts` |
| Voice worker           | `line/shared-agent.mjs`, `line/shared-desk.mjs`, `line/shared-media.mjs`                                    |
| Participant Mac        | `cli/shared.ts`, `connectors/shared/shared-*.ts`                                                            |
| Tests                  | `tests/*shared*.test.ts`, `line/shared-*.test.mjs`                                                          |

## Domain boundaries

The domain uses the existing SQLite `Store` and `Pairing` shape in a separate
`shared_number_*` namespace. It does not upgrade dedicated pairings or reuse
their credentials.

- Enrollment requires separate trusted account and alias verifier outputs.
  Exact aliases are exclusive to an account. Caller handles, hashes, masked
  digits and model-selected member IDs are not accepted as proof.
- Verified incoming events reserve the one line slot without granting a Mac.
  A trusted adapter must supply the exact provider call, room and expected
  participant. Duplicate event IDs retain their original binding.
- The authenticated account receives one eight-digit code for that call.
  It expires after at most two minutes and allows five distinct attempts.
  It is stored as a keyed digest with a separate 32-byte coordinator key.
  The code is accepted only through a separately verified original call turn.
  Duplicate turn delivery does not spend another attempt. Consumption and
  failed attempts persist transactionally. Reissuing a code is refused.
- Pairing invitations expire after five minutes and are consumed once.
  Local acceptance selects the display and separate view and control
  permissions. The server allocates the device ID and a random device secret.
  Only its digest is retained. Rotation invalidates the old credential.
  Account revocation invalidates the pairing and its credentials.
- Connection identity comes from that credential, never a device header.
  Heartbeats expire after 30 seconds. Replacement connections, credential
  rotation and coordinator recovery fence prior desktop admission. An offline
  member never selects another connected Mac.
- A successful proof binds an immutable member, pairing, device, display,
  desktop instance, connection and grant to the call. Authorization is bounded
  to one hour and rechecked before operations. These are routing checks, not
  substitutes for local Stop, fresh frames or exclusive screen ownership.
- Tasks record their call, original user-turn ID, request digest and exact
  owner before execution. Duplicate or changed task identities conflict.
  Completion must come from that device and original desktop instance, even
  after hangup. Callback records retain the original destination and result.
  They cannot use the most recent caller.
- Cleanup must be verified for the exact provider call, room and participant
  before releasing the slot. Media disconnect, expiry and unknown outcomes
  do not release it. Restart preserves unknown call state and task ownership.
- Verified cleanup received before incoming writes an ended call record. A
  delayed incoming delivery cannot reserve that call's slot, and cleanup for
  another call cannot release the current owner's slot.
- Event and original-turn fingerprints exclude verification expiry, which an
  adapter can refresh on redelivery. Every delivery still requires fresh
  verified evidence. A changed call identity or proof content conflicts. A
  retry cannot consume another failed attempt or reuse a successful proof.

The verifier outputs must never be parsed directly from untrusted HTTP JSON.
The coordinator wires them to its own phone sign-in sessions and to evidence
that only its provider handler creates. The test adapters are synthetic and
provide no production proof. The pairing acceptance is a terminal prompt in
`clawdtime shared pair`. A client boolean alone is not evidence of a native
acceptance UI.

## Open gates

1. Physical qualification with two distinct paired Macs, two authenticated
   members and the full acceptance matrix below.
2. An exact authenticated messaging identity path. Until it exists, shared
   texting stays unavailable.
3. Email identities, if they are wanted, with their own verifier, audience,
   issuer, expiry and revocation checks.
4. A background participant service. Today `shared run` must stay open in a
   terminal.

Keep the dedicated line owner, callbacks, walkthrough and same-call input path
usable until these gates and an idle reconciled handoff are satisfied. Nothing
here authorizes treating a queued callback or submitted input as observed
success.

## Goal and first release

One service number serves multiple people. Each authorized person reaches
their own paired Mac, tasks, screen, and walkthrough. The selected Mac remains
fixed throughout a call, including follow-up clicks and navigation.

The first release supports:

- One central owner of the shared line.
- One selected paired Mac per member.
- Multiple enrolled members, with one active call across the line.
- Incoming tasks, outgoing completion callbacks, and same-call computer use.
- Explicit unavailable or busy outcomes without routing to another Mac.
- Existing dedicated installations remaining usable during migration.

Multiple simultaneous calls on one number, group control, automatic selection
among several Macs, billing, and horizontal scaling are outside this release.

## Read first

Read `AGENTS.md`, `README.md`, `INSTALL.md` if present,
`SETUP_CLAWDTIME.md`, `IMPLEMENTATION_PLAN.md`, and `SESSION_PROMPT.md`.
The last two explain the original architecture and scope. Their deferral of
public shared-line routing describes the older release. The status section
of this plan says what exists now.

Then inspect `docs/ARCHITECTURE.md`, `docs/COMPUTER_USE.md`,
`docs/SUPERVISOR.md`, `docs/DEVICE.md`, and the applicable line handoff guide.
Follow current repository instructions and preserve unrelated work.

## Baseline before shared routing

| Area              | Existing foundation                                                                                    | Gap                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Dedicated desktop | One configured owner, a local desktop endpoint and one selected display                                | No central member-to-Mac router                                                |
| Pairing           | `src/contracts.ts` links member, recipient, conversation, line, device, display, and permissions       | Self-service verified enrollment and device credential isolation               |
| Incoming voice    | `line/agent.mjs`, `line/desk.mjs`, and `line/phone-desk.mjs` open a local desktop session              | Resolve and authorize the member before binding a remote desktop               |
| Texts             | `connectors/agents/texts.ts` polls messages for one configured owner                                   | Its masked last-four-digit comparison cannot authorize multiple members        |
| Native messages   | `src/transport/native-messages.ts` validates exact line, sender, conversation, and event fields        | Verify availability and trust of this event path for the shared deployment     |
| Relay             | `media/device_relay.py` routes declared device IDs and pins leases to sockets                          | Shared gateway credentials and legacy fallback do not provide member isolation |
| Desktop control   | `src/control/phone-desktop.ts` and `phone-desktop-routes.ts` provide call leases and request ownership | Bridge these local desktop operations over the authenticated device connection |
| Callbacks         | `src/control/proactive-*` and `line/proactive-owner.mjs` track call attempts and ownership             | Route each result to its original member and Mac through one line scheduler    |

The existing relay serves companion lease endpoints. It is not already a
remote adapter for the newer desktop phone endpoints. Treat that integration
as implementation work.

The job watcher in `line/desk.mjs` uses timing and previously observed jobs to
associate new work with a call. Shared routing needs explicit task ownership
instead of inferring ownership from timestamps or the latest active session.

Existing walkthrough and same-call computer-control behavior must remain
intact. Do not rebuild or rerun an existing demo merely to establish context.

## Provider facts and prerequisites

Provider documentation:

- [Limits and readiness](https://docs.trychert.com/facetime/limits): one
  provisioned line has one active call slot. Per-call room selection is
  supported. An outbound queue can wait for a slot; queue admission is not
  evidence that a call was allocated or placed.
- [Webhooks](https://docs.trychert.com/facetime/webhooks): incoming events can
  include `data.from`, containing an observed phone number or email. It can
  be absent or null. Delivery is at least once and incoming decisions have
  a short deadline. Signing must be explicitly enabled and verified.
- [Security](https://docs.trychert.com/facetime/security): an observed caller
  handle or caller hash does not prove ownership or authorize access.

Before routing real users, confirm the deployed provider interface exposes
the required events and call IDs. Confirm line readiness, recipient
verification rules, project capacity, and the chosen identity proof flow.
Provider webhook authenticity and human account authentication are separate.

Required infrastructure is one always-on coordinator with persistent state,
an HTTPS endpoint for webhooks, authenticated outbound HTTPS device
connections, and the existing call/media service. Inventory concrete deployment tooling,
versions, credentials, and permissions privately. Do not add infrastructure
or purchase capacity based on assumptions.

## Target architecture and invariants

```text
Shared FaceTime and messaging line
               |
Central coordinator: identity, pairing, call admission, callbacks
               |
Authenticated connection for the exact member and device
               |
Paired Mac: desktop service, local tasks, screen, local Stop
```

The coordinator holds provider secrets. Each Mac holds a separate revocable
device credential. Task execution and local model configuration remain on
the Mac. Devices cannot claim arbitrary device IDs through a header.

Bind each admitted call to an immutable member, pairing, device, desktop
instance, provider call, room, and authorization grant. Bind each task and
callback to that scope. Reuse existing contracts where possible. Persist
scope and receipts so restart recovery cannot silently change the target.

Screen viewing and computer input remain separately authorized. Preserve
fresh frames, bounded leases, exclusive input ownership, original user-turn
binding, local Stop, and permission revocation. Keep screen and audio content
transient. Do not introduce a generic remote shell endpoint.

## Implementation sequence

### 1. Prove identity and define the routing contract

- Trace actual incoming event and messaging paths in the installed version.
- Choose a verified member identity and separately verified phone or email
  aliases. Never authorize using masked digits, a caller hash, a spoken
  identity claim, or model-selected targets.
- Require proof bound to the specific incoming call before revealing a
  desktop. A short code delivered through the already authenticated paired
  account and presented on that call is one possible implementation. Define
  expiry, one-time consumption, attempt limits, and replay handling.
- If a provider supplies a stronger authenticated identity mechanism, verify
  its documented guarantees before replacing the additional proof step.
- Account for the incoming decision deadline. Any call answered for identity
  verification starts without a desktop, screen, or control grant.
- Define explicit states for unknown identity, unauthorized, offline, busy,
  admitted, ended, and outcome unknown.

Exit: the identity proof and call binding are concrete. A signed event alone
cannot grant desktop access. Missing provider capability is documented as a
specific dependency, not bypassed with a heuristic.

### 2. Implement enrollment and isolated device connections

- Issue short-lived, single-use pairing invitations after account proof.
- Require local pairing acceptance and register the selected device/display.
- Issue per-device credentials with rotation and revocation.
- Bind allowed device IDs on the server, independent of self-declared IDs.
- Extend the relay with the desktop operations needed for open, renew, chat,
  stop, close, status, and authorized screen delivery.
- Fence old desktop instances and connections after reconnect or restart.
- Disable implicit legacy/default-device routing in shared mode.
- Never replay input with an unknown outcome after a disconnect.

Exit: two enrolled Macs can connect independently. One cannot claim or act
on the other device, and an offline target never selects a fallback Mac.

### 3. Route incoming calls and messages

- Admit all shared-line traffic through one coordinator.
- Authenticate and authorize the caller, then select the registered Mac.
- Open a call-scoped desktop session and keep its route fixed until cleanup.
- Carry the original authenticated user turn through the existing desktop
  control path. Preserve same-call navigation and clicking.
- Isolate room tokens, transcripts, task records, responses, and display
  selection by member and call.
- Replace masked-owner text matching with an authorized exact identity path.
  If the available messaging API cannot provide that, keep shared texting
  disabled until the prerequisite is satisfied.
- Resolve reply destinations from persisted authorized scope, not free-form
  model output or request-supplied recipient fields.

Exit: each member reaches only their own desktop and conversation. Unknown
or unauthorized callers cannot obtain a screen or execute a task.

### 4. Route task completion and serialize line ownership

- Record member, device, initiating session, task, and result identifiers at
  task creation. Remove timestamp-based ownership inference from this path.
- Queue completion callbacks for the original owner and result.
- Use stable idempotency keys and durable receipts. Reconcile uncertain
  provider outcomes before retrying any call or input.
- Serialize incoming admissions and outgoing callbacks through one line
  owner. Do not start competing line processes on enrolled Macs.
- Preserve the existing retained-owner handoff and cleanup guarantees until
  an alternative provider lifecycle is proven.
- Bound queue age and retries. Distinguish queued, allocated, ringing,
  answered, failed, and unknown states.
- Resume admission only after observed cleanup, not merely media disconnect.
- Prepare the correct result and display before beginning its walkthrough.

Exit: another person's intervening call cannot redirect a callback. Busy
states and restarts do not duplicate callbacks or repeat completed work.

### 5. Package shared setup and release gradually

- Add a documented shared-service setup mode alongside dedicated mode. Any
  new CLI syntax is proposed until implemented and verified.
- Show paired identity, selected Mac, online status, permissions, and useful
  unavailable reasons in setup and diagnostics.
- Do not require every installer to claim the line or receive project-wide
  provider credentials.
- Introduce shared routing behind an explicit deployment setting.
- Prepare the coordinator in standby, then perform an idle, reconciled line
  handoff. Never run two live owners for the same number.
- Pilot with two separate members and Macs before widening enrollment.
- Document rollback that stops admissions, reconciles active and unknown
  effects, and restores the previous owner without rewinding event cursors.

## Verification and release evidence

Add meaningful automated coverage for authorization boundaries, exact
routing, call/task ownership, deduplication, and recovery. Use repository
checks in an execution environment permitted by the active user's testing
instructions. Record commands actually run and their results. Do not call
unexecuted tests passing, or automated checks physical acceptance.

The acceptance matrix must cover:

- Two members and two Macs, each with a distinct visible demo artifact.
- Similar or identical last-four phone digits and separately verified aliases.
- Unknown caller, missing identity, expired proof, proof replay, forged
  events, and a participant that does not match the admitted call.
- A device attempting to register or control another member's device.
- View-only permission, control permission, local Stop, and revocation.
- Correct walkthrough display and follow-up clicks/navigation in one call.
- Two tasks completing in a different order from their initiating calls.
- Busy line, missed call, duplicate completion event, and callback recovery.
- Offline Mac, sleep, service restart, stale connection, expired lease, and
  input whose outcome becomes unknown during a disconnect.
- No cross-member task, screen, audio, message, or conversation exposure.
- Dedicated-mode compatibility and reconciled rollback.

Physical acceptance requires distinct paired devices and authenticated user
participation. Report missing devices or permissions precisely. Do not
substitute simulated users for a claim that multi-user production works.

## Suggested delivery slices

Keep changes reviewable and independently buildable:

1. Identity proof, scoped routing contracts, and durable ownership records.
2. Enrollment, per-device authentication, and the desktop relay adapter.
3. Incoming call/message admission and remote walkthrough integration.
4. Completion callback routing and shared line scheduling.
5. Installer, diagnostics, release controls, and acceptance documentation.

Keep each pull request focused. Preserve unrelated work, use descriptive
branches, and rebase on current main before pushing as required by
`AGENTS.md`. Do not include personal identities, actual numbers, hostnames,
keys, or runtime records in tracked files or fixtures.

## Handoff checklist

- Re-read current source and inspect Git status before editing.
- Distinguish installed production state from the current checkout.
- Preserve any existing walkthrough fixes and demo artifacts.
- Implement the identity and isolation foundation before enabling shared
  routing on a live line.
- Continue independent implementation when an external prerequisite is
  unavailable, and report the exact remaining dependency.
- Update the status and open gates in this plan when a milestone lands. Keep
  deployment state, host details and test counts out of it.
