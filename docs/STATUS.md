# ClawdTime implementation status

November 11, 2026 — America/New_York.

**Independently hosted pilot; controlled line handoff active. Not a verified live demo.** The actual
call → screen → feedback/CUA → agent continuation → Messages-result path has not
been observed on a handset. Apple Teams traffic is paused; ClawdTime exclusively
owns the confirmed test line while supervised onboarding is in progress.

## Source and release identities

- Apple Teams audited and inspected baseline: `be47b11fe1317c4747db4121bec37896998b5201`.
  Source main stayed clean at that commit; its five existing worktrees were preserved.
- ClawdTime local branch: `codex/implementation`; independent Git repository.
  Implementation release commit is the `feat: implement independent ClawdTime pilot`
  commit in this branch. No remote repository, public package or GitHub topics created.
- Independent Railway project: `9fafdcf9-c7eb-4465-8387-ec3f8acbaefa`.
- Backend live deployment: `bc0f8032-d316-4b7f-a952-927160d0a38d`, from
  clean commit `f1f1320cc2d64d053871355aa55ea3292cad77ea`.
- Media deployment: `4d18c8d9-1ce4-421a-abd0-5f3bb65daf6e`.
- Source paused using its existing image: `e54088af-d19e-4378-8aa6-d2b4ac12acd4`.
  No source code or sibling deployment was changed.
- Companion: `com.clawdtime.companion`, internal 0.1.0, ad hoc signed.
  Binary SHA-256: `abfdeb7eb0228ac2b4ae9d1f35d1fdd89da3c3ac7b1d6aff226c312aa0e858dd`.
  `codesign --verify --deep --strict` passed. No Developer ID/TeamIdentifier or notarization.
- Client versions: Claude Code **2.1.311**; Codex CLI **0.166.0-alpha.5.1**.
- Validation runtime: Node **24.22.1**, Python **3.14.0**, Swift **6.2.4**.
- Companion installed at `/Users/garygao/Applications/ClawdTime Companion.app`.
  Separate bootstrap configuration has empty display ACLs. The user granted the
  initial build permissions; its relaunch repair changed the ad hoc signature.
  The user authorized replacing only ClawdTime’s stale entries. Current-build
  Screen Recording and Accessibility now report true through the authenticated
  companion doctor; local Enable remains off. The verified browser pairing was applied to display 1;
  both view/control ACLs are now loaded and the display is attached.
- Independent `com.clawdtime.gateway` LaunchAgent connected to the hosted media
  service. Fresh helper/gateway/operator/media/encryption secrets and separate volumes.
- No screen capture, input or FaceTime call has yet been accepted as physical evidence.

## Executed evidence

| Boundary                                  | Evidence                                                        | Meaning                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| TypeScript and build                      | `npm run check` passes; exact final test count recorded below   | Backend, CLI, connectors and integration type-check/build                                             |
| Browser → API → SQLite → export           | Built-app Playwright/Google Chrome checks passed                | Required consent, fragment clearing, same-tab invite, one-use/expired links, export and mobile layout |
| Export → compiled CLI                     | connect → doctor → disconnect passed in disposable project/home | Private credential storage, unrelated config preservation, owned skill removal                        |
| Claude Code → MCP → domain → continuation | Actual CLI print-mode model/tool run passed                     | register/yield/request/result/ack/resume/complete; one simulated call and one simulated result        |
| Codex → MCP → domain → continuation       | Actual CLI exec-mode model/tool run passed                      | Same exact cooperative sequence; native client permission policy preserved                            |
| Domain → device → completion              | HTTP E2E and simulation demo passed                             | click/type/scroll and injected single-action planner; exact response and epoch; one result            |
| Media                                     | 57 Python tests passed                                          | Real migrated code, synthetic/fake transport; not handset delivery                                    |
| Gateway                                   | 18 Python tests passed                                          | Leases, routing, replay, release and failure contracts                                                |
| Setup generator                           | 9 Python tests passed                                           | Private independent config, refusal of overwrite, actual display selection                            |
| Swift                                     | 11 policy/HTTP/receipt/relaunch tests passed; release app built | Permission/control/Stop policy and ad hoc packaging; not actual TCC/physical input                    |
| Backup                                    | Encrypted SQLite snapshot/restore regression passed             | Consistent snapshot, authenticated encryption, fresh destination, unknown receipts retained           |
| Docker                                    | Railway Docker builds and live process health passed            | Independent containers and volumes; backend DB owned by non-root UID 1000                             |
| Actual phone/FaceTime/CUA/line rollback   | **Not run**                                                     | Required live acceptance remains open                                                                 |

Synthetic Python failure tests intentionally log caption/media failure messages.
The suite also emitted an unclosed SQLite test-connection ResourceWarning; all
assertions passed. Neither is represented as physical acceptance.

Real-client probes use the client's existing signed-in default model and a temporary
MCP configuration with fixture-only tool approval. Installed user configuration and
native policies were not changed. No arbitrary open desktop/IDE session was taken over.
Interactive approval/reload behavior is a separate acceptance step.

## Implemented safeguards and review

Shared contracts preceded three parallel specialists with non-overlapping ownership.
A separate specialist reviewed authorization, asynchronous effects and recovery.
Fixes/tests cover exact member/device/project/session isolation, expiring single-use
pairing, durable calls/results, atomic effect claims, native cursor anchors, unknown
outcomes, read-only recovery of retained provider call IDs, native cleanup reservations,
qualified voice, TTS suppression, bounded polling, concurrent CUA exclusion, fresh
frames, no persisted pixels, post-input observation, confirmed release, control epochs,
view restoration, Stop/revocation latches and standby-only cleanup.

A five-second connector heartbeat maintains session liveness. Twenty seconds of
silence stops the session and begins owned-call cleanup; late heartbeats cannot
revive it. Media policy and control independently check freshness. This is cooperative
session control; it cannot forcibly pause unrelated external programs. The agent
must attest conflicting background actors are stopped before yielding.

The optional vision provider supports explicit OpenAI or Gateway selection with
fresh independent keys and a configured model. No model fallback is implicit. The
single-action planner is tested with injected output and frame changes; a real
provider acting on a physical fixture remains unverified.

## Exact remaining acceptance steps

1. **Pairing and native reply reconciliation.** Actual current-build Mac permission
   checks now pass. The verified inbound created an invite after the configuration
   normalization fix. Its outgoing notice has an unknown outcome; the existing
   provider receipt lookup returns HTTP 503, `text operation unavailable`. No retry
   was sent. Browser pairing succeeded and its private file was recovered through the browser
   download API after the in-app download UI stopped. The companion has both ACLs
   loaded; Codex and Claude Code connections were installed in the disposable project.
   Only native receipt recovery and explicit local Enable block live readiness.
2. **Supervised handset loop.** The user confirmed the Liam Davis alias against
   the exact native/logical/inventory binding and selected a sole demo recipient.
   The private handoff record preserves the source cursor and pause evidence.
   Test call, visible screen, voice/text, click/type/scroll, bounded AI action,
   exact agent continuation, Messages result, Stop and rollback are still pending.
3. **AI action physical qualification.** A fresh independent Gateway key has a $1
   non-renewing cap and 7-day expiry. The initially selected model required funded
   credits, so the lead explicitly selected catalog-verified `openai/gpt-4o-mini`.
   Its real structured-output connectivity test passed with existing credits;
   no top-up or model fallback was enabled. Real image/action qualification remains.

4. **Public distribution.** Developer ID, notarization, external clean installation
   and npm namespace/publication remain unverified. Use the bundled internal CLI.

Production operator authentication is resolved: the previous 401 used the demo
key. Current native/logical identity, exact cursor, worker, independent media and
connected gateway preflight checks all pass. Source pause was observed across an
idle interval exceeding 10 seconds, with no pending/unknown jobs, no active calls,
a stable retained cursor and no intervening events. One historical source failed
start-call job remains preserved. No runtime/customer database was copied.

Rollback must reconcile the complete handoff interval. Never advance the source
past unrelated events. Prefer preserving its original cursor and marking only
reconciled test-owned direct messages in its compatible event ledger; alternatively
CAS-advance only when every intervening actionable event is fully reconciled.
See LINE_HANDOFF.md and TRANSPORT.md. No physical rollback has yet been claimed.

## Timing and acceptance

Request-to-ring: **unmeasured**. Answer-to-visible-screen: **unmeasured**.
Human-response-to-real-agent-continuation during a phone call: **unmeasured**.
Sub-minute goals are targets, not results. See DEMO_ACCEPTANCE.md for the physical
matrix. No recordings or private user screens were retained.

## Reproduce locally

`npm ci`, `npm run check`, `npm run demo`, `npm run dev`.
Browser: `npm run test:onboarding:browser`.
Real synthetic CLI probes: `npm run test:connectors:real`.
Python/Swift commands and setup are in README.md and component READMEs.

## Final local release check

- `npm run check`: **111 tests across 14 files**, TypeScript and production build passed.
- `npm run format:check`: passed.
- Built browser/onboarding/compiled-CLI checks: passed.
- Real Claude Code and Codex synthetic probes passed again with heartbeat enabled.
- Python: 57 media + 18 gateway + 9 setup tests passed; Swift: 11 tests and release
  packaging passed. No physical tests are included in those counts.
- `npm run demo`: completed with one simulated call, input, response and Messages result.
- Dependency audit: zero reported vulnerabilities at install; no source secret or
  real configured line number found in tracked/candidate files.
- Independent Railway backend/media Docker builds, volumes and runtime health passed.

## Follow-up diagnosis — November 11, 2026

The live path was never attempted; no failed phone call or screen session was
observed. The implementation remained in simulation without independent hosted
services or installed/authorized ClawdTime companion configuration. The initial
readiness authentication failure was an investigator credential-selection error,
not an unavailable production key. See LINE_HANDOFF.md for corrected evidence.

Landing page `/` and private pairing page `/pair` return HTTP 200 and were checked
in Chrome. `/dashboard` returns 404: no operational dashboard has been implemented.
For this diagnosis the lead started an in-memory simulation at
`http://127.0.0.1:3310`; it has no live credentials and cannot use the test line.
This is a temporary local preview, not a deployed public website.

## Follow-up fixes and hosting — November 11, 2026

Hosted landing: https://backend-production-ee686906.up.railway.app
Private pairing route: `/pair`; no operational dashboard is implemented.
The prior local-only diagnosis above records the earlier state, superseded here.

Readiness now distinguishes pairing, real line/media/device evidence and physical
acceptance. Tests cover missing handoff evidence before polling, stale/config-bound
helper checks, cleanup-only recovery after interrupted call allocation, shutdown
drain, malformed-secret error redaction, and rejection of falsy live config.
Both actual CLI synthetic probes now explicitly verify their exact run identity.

The Mac gateway's missing Python CA bundle was fixed with pinned trusted Certifi
roots and mandatory TLS/hostname checks; no global trust or source gateway changed.
Normal companion reopening now uses only its validated private default config and
never re-arms automatically. Current-build permission reconciliation is complete.

Current handoff pause point: both hosted services and the independent gateway are
healthy. The original verified `pair` inbound initially failed strict invite parsing
because protected tester metadata was spread into the binding. Commit `f1f1320`
assigns the schema-normalized tester list. Recovery used a transaction requiring
exactly that one unknown inbound, no invite/notice/effect, and the exact allowlisted
sender, line, direct conversation and command. It retained the original encrypted
payload and cursor and recorded recovery evidence.

The inbound is now done and an invite exists. The outgoing notice is unknown;
read-only lookup of its stable native origin returns HTTP 503 (`text operation
unavailable`). This does **not** prove the send was absent. No notice was resent,
no cursor was reset and no FaceTime call was placed. `local_recovery` correctly
blocks new live dispatch. The provider must restore a valid read-only journal result
for that original origin before a lead can reconcile it. No sibling source or service
was modified. The private link was opened directly from the verified inbound's
encrypted notice. The user selected view/control and paired successfully. The
private Blob download initially stopped in the in-app browser; its download API
saved the existing file, now owner-only, without a second pairing request. The
claim was applied preserving secrets/ledgers. Relaunch retained both actual Mac
permissions and loaded display 1 view/control ACLs. Both connector installations
succeeded in the disposable project; doctor reports only `local_recovery` and
`local_arm` failures. No agent client, capture, input or call was started.

The user's later handset correction supersedes the initial tester choice; only the
corrected recipient is allowlisted. Apple Teams remains paused. Its retained cursor
and all ClawdTime unknown outcomes must be reconciled before any ownership reversal.

Implementation fixes are committed as `4f6e540`. Separate concurrent landing/pricing
changes in the working tree were preserved and excluded from that commit and the
audited hosted backend image. Disposable acceptance fixture is available locally
at `http://127.0.0.1:3315`; it is not a screenshot or input acceptance result.

## Notice audit follow-up

Local follow-up retains sanitized native acknowledgement receipts and the stable
operation origin for pairing notices. Failures retain phase/code and HTTP status
without raw provider errors or content. Interrupted notices remain unknown; no
automatic retry was added. Seven runtime cases and the full 111-test check pass.
The pre-existing live unknown remains unresolved; local receipt improvements do
not establish its outcome. Hosted release identity above remains authoritative.

## Provider receipt diagnosis — November 11, 2026

The user ran a scoped read-only administrator diagnostic on the exact provider
account. Its `.chert-rpc` directory exists, is canonical, and has the required
owner and mode 0700. The helper readiness marker names a live process and bridge
version 1. **`text-operations.sqlite` and its WAL/SHM files do not exist.**
This establishes the immediate receipt-lookup failure: Chert's read-only opener
requires an existing secure journal, returns nil when it is absent, and the HTTP
route maps that to 503 (`text operation unavailable`). General provider health
does not verify this journal. This is distinct from an existing journal with no
matching receipt, which would return 404.

The helper log contains a `send-text-once` invocation, but the original response
was not retained by the initial ClawdTime notice implementation. The send code
checks request/account/chat identity before opening the journal. An early refusal
is consistent with these observations; the exact failed send predicate is not
proven. Do not infer safe resend from a currently absent journal, create an empty
journal to erase uncertainty, or report an acknowledged/delivered message.

The diagnostic changed no provider service, journal, permission or routing.
ClawdTime remains paired, with its Mac locally stopped and no call placed.
