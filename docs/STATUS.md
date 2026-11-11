# ClawdTime implementation status

November 11, 2026 — America/New_York.

**Implemented, runnable local pilot. Not a verified live demo.** The actual
call → screen → feedback/CUA → agent continuation → Messages-result path has not
been observed on a handset. No ClawdTime live routing was enabled.

## Source and release identities

- Apple Teams audited and inspected baseline: `be47b11fe1317c4747db4121bec37896998b5201`.
  Source main stayed clean at that commit; its five existing worktrees were preserved.
- ClawdTime local branch: `codex/implementation`; independent Git repository.
  Implementation release commit is the `feat: implement independent ClawdTime pilot`
  commit in this branch. No remote repository, public package or GitHub topics created.
- Backend/media deployment IDs: **none**. No existing deployment was replaced.
- Companion: `com.clawdtime.companion`, internal 0.1.0, ad hoc signed.
  Binary SHA-256: `201acb9c54cdeeaf4c9f2f5ab1ce324ae642bcfe3837e2ee89bfd54c84ca31a7`.
  `codesign --verify --deep --strict` passed. No Developer ID/TeamIdentifier or notarization.
- Client versions: Claude Code **2.1.311**; Codex CLI **0.166.0-alpha.5.1**.
- Validation runtime: Node **24.22.1**, Python **3.14.0**, Swift **6.2.4**.
- No new companion installation/launch, permission grants, arming, capture, input,
  telephony/media-provider calls or customer data migration occurred. Metadata-only display
  discovery and generated-config validation ran on the actual Mac.

## Executed evidence

| Boundary                                  | Evidence                                                        | Meaning                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| TypeScript and build                      | `npm run check` passes; exact final test count recorded below   | Backend, CLI, connectors and integration type-check/build                                             |
| Browser → API → SQLite → export           | Built-app Playwright/Google Chrome checks passed                | Required consent, fragment clearing, same-tab invite, one-use/expired links, export and mobile layout |
| Export → compiled CLI                     | connect → doctor → disconnect passed in disposable project/home | Private credential storage, unrelated config preservation, owned skill removal                        |
| Claude Code → MCP → domain → continuation | Actual CLI print-mode model/tool run passed                     | register/yield/request/result/ack/resume/complete; one simulated call and one simulated result        |
| Codex → MCP → domain → continuation       | Actual CLI exec-mode model/tool run passed                      | Same exact cooperative sequence; native client permission policy preserved                            |
| Domain → device → completion              | HTTP E2E and simulation demo passed                             | click/type/scroll and injected single-action planner; exact response and epoch; one result            |
| Media                                     | 56 Python tests passed                                          | Real migrated code, synthetic/fake transport; not handset delivery                                    |
| Gateway                                   | 13 Python tests passed                                          | Leases, routing, replay, release and failure contracts                                                |
| Setup generator                           | 3 Python tests passed                                           | Private independent config, refusal of overwrite, actual display selection                            |
| Swift                                     | 7 policy/HTTP/receipt tests passed; release app built           | Permission/control/Stop policy and ad hoc packaging; not actual TCC/physical input                    |
| Backup                                    | Encrypted SQLite snapshot/restore regression passed             | Consistent snapshot, authenticated encryption, fresh destination, unknown receipts retained           |
| Docker                                    | CLI available, daemon unavailable                               | Dockerfile prepared; container image build/run **not verified**                                       |
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

## Exact blockers and next actions

1. **Liam Davis identity unresolved.** Read-only native whoami was healthy and
   matched the configured native line/phone/instance. Calls inventory matched the
   configured logical line but labeled it **iPhone control test**. No Liam/Davis
   match was returned. Resolve the intended identity through private operator
   evidence before any transfer. No real number is committed.
2. **Readiness credential issue resolved during diagnosis.** The previous 401
   resulted from using the local demo key against production. The existing
   production provisioning key returns HTTP 200. Fresh checks show a healthy
   heartbeat, zero pending/unknown jobs, no active calls, and one recorded failed
   job. Media is healthy, gateway connected and idle. Source health must be checked
   again and the failed job reviewed before a controlled handoff; no live ownership
   change occurred.
3. **Independent live services/secrets not provisioned.** New backend/media hosting,
   independent volumes and fresh application/media/gateway/provider credentials are
   required. Start in standby; never replace Apple Teams. No new paid plan was opened.
4. **Physical Mac/handset steps pending.** The new bundle identity needs its own
   Screen Recording/Accessibility grants, configured gateway, local Enable and an
   allowlisted consenting tester. Validate typing, click, scroll, AI action, lock,
   sleep, Stop, call teardown and actual Messages delivery on disposable content.
5. **Public distribution pending.** Internal ad hoc bundle exists; Developer ID,
   notarization and clean external installation are unverified. npm namespace
   ownership/publication is unverified; use the bundled CLI.
6. **Container runtime unavailable.** Start the local Docker daemon to verify the
   prepared independent container packaging; Node/Python/Swift run locally today.

The controlled handoff/rollback procedure is in LINE_HANDOFF.md. No handoff,
source pause, cursor transfer, live rollback or deployment was performed. Unknown
allocation outcomes lacking a retained provider ID and uncertain text/input effects
require evidence-based operator reconciliation; no automatic retry is provided.

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

- `npm run check`: **78 tests across 11 files**, TypeScript and production build passed.
- `npm run format:check`: passed.
- Built browser/onboarding/compiled-CLI checks: passed.
- Real Claude Code and Codex synthetic probes passed again with heartbeat enabled.
- Python: 56 media + 13 gateway + 3 setup tests passed; Swift: 7 tests and release
  packaging passed. No physical tests are included in those counts.
- `npm run demo`: completed with one simulated call, input, response and Messages result.
- Dependency audit: zero reported vulnerabilities at install; no source secret or
  real configured line number found in tracked/candidate files.
- No Docker daemon was available, so image build/run remains unverified.

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
