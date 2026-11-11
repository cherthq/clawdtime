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
- Backend live deployment: `3929b7a9-9272-493f-84ed-cfe87e4865dd`, from audited
  standby build `aee250ae-90d3-438c-8aef-50ffa372da53`.
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
  Current-build TCC grants are being reconciled, not inferred from Settings switches.
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

1. **Current installed Mac permissions and pairing.** Normal app reopening is fixed.
   macOS retained old ad hoc signing requirements despite enabled Settings switches;
   reset only this bundle's stale entries, re-add the installed app, and verify actual
   `screenPermission`/`controlPermission` before capture. Empty bootstrap ACLs permit
   no viewing/input. Verified Messages pairing must explicitly grant display access.
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

- `npm run check`: **108 tests across 14 files**, TypeScript and production build passed.
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
never re-arms automatically. A current-build permission reconciliation is required.
