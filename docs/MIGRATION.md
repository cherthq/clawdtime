# Source provenance and migration

Audited source: `/Users/garygao/apple-teams`, remote
`https://github.com/cherthq/apple-teams.git`, commit
`be47b11fe1317c4747db4121bec37896998b5201`. It was clean at implementation start.
Its main branch and all pre-existing worktrees were preserved. The sibling
`chert-facetime` was neither edited nor deployed.

ClawdTime started from the two approved handoff documents, initialized local main,
then implemented on `codex/implementation`. There is no new remote or public
package publication. No production runtime data was migrated.

## Selective extraction

| Source                            | Destination                                                             | Decision                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/store.ts                      | src/storage/store.ts                                                    | SQLite transactions, durable effects/events, FULL sync and scoped domain entities; no workspace data                                                                |
| src/security.ts                   | src/storage/security.ts                                                 | Token hashes, constant-time comparison, fresh-key AES-GCM envelopes                                                                                                 |
| src/chert/messages.ts             | src/transport/native-messages.ts                                        | Exact native binding, signed requests, cursor anchor/page checks, authenticated DM normalization, stable text-operation receipts; group business logic excluded     |
| src/chert/calls.ts                | src/transport/native.ts                                                 | Scoped customer-managed outbound calls, media readiness, bridge activation, durable speech, native cleanup and GET-only recovery; incoming/group workflows excluded |
| src/devices.ts                    | src/control/coordinator.ts, viewing.ts                                  | Narrow authorization, frame freshness, lease/epoch and receipt invariants rewritten around agent sessions                                                           |
| src/device-tasks.ts               | src/control/human-router.ts, planner.ts                                 | Direct bounded input and one vision action, no workspace drafts or autonomous loop                                                                                  |
| src/agent-model.ts                | src/control/planner.ts                                                  | Explicit direct OpenAI or Gateway choice and configured model; no automatic fallback, independent credentials                                                       |
| media/, gateway/, devices/        | media/, gateway/, mac/                                                  | Tracked-source allowlist migration with per-file source hashes in MIGRATION_MEDIA.md                                                                                |
| tests/native, call, device suites | tests/backend*, control-safety, end-to-end and retained component tests | Relevant isolation/replay/receipt assertions adapted to new domain; source test counts not inherited                                                                |

New code: shared pairing/session/request/call/response/control contracts, cooperative
MCP connectors, CLI configuration lifecycle, browser pairing, HTTP API, inbound
outbox, runtime orchestration, view/agent ownership coordination and acceptance tests.
See [the component manifest](MIGRATION_MEDIA.md) for every copied Python/Swift file
and its source hash. Native wire identifiers remain deliberately unchanged where
required by existing supported APIs. Local application identifiers, ports, paths,
service names, database/backup namespaces and media room IDs are independent.

## Team execution

The lead defined contracts and directory ownership before parallel coding. Three
specialists implemented transport/storage/domain, Mac/media/gateway, and connectors.
They shared non-overlapping directories; only the lead edited shared contracts,
manifests, integrated changes and inspected live routing read-only. Later waves
added HTTP E2E, real-client probes, browser/installer QA, README and independent
security/recovery review. Review fixes include concurrent CUA exclusion, blocking
resume without post-action observation, stop latches, standby-only cleanup, source
feed failure cleanup, post-action view restoration and native hangup when media is down.

## Excluded source and retained boundaries

No source `.env`, `.data`, database, OAuth grant, customer message, screen, audio,
receipt ledger, installed config, recovery secret, node_modules or build product
was copied. Runtime source secrets were used only in memory for read-only native
identity and readiness checks; none was stored in this repository. New build
outputs, virtual environments and synthetic browser artifacts are ignored.

Calendar, team administration, group enrollment/scheduling, external business
providers, full workspace engine and context dashboard remain in Apple Teams.
Mode 2, cloud computers, public line pooling, billing and groups are out of scope.
The source repository contained no root LICENSE file at this baseline; no new
license or public redistribution right is asserted. Preserve provenance and resolve
licensing before any public distribution.
