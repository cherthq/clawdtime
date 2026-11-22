# Proactive calls implementation and production boundary

November 22, 2026. Implementation is in the `clawdtime-merge` checkout on `main`,
based on `0b3d5189251ac9f81fbb72208d6aa6a6475c5d0b`. The retained production adapter is undergoing its authorized installation;
this document distinguishes source checks, installed health and handset evidence.

Candidate implementation commit: `952d49cd581bd237bfbd7e748d1ee7b37ac91523`.
Validation used Node `v24.22.1`, LiveKit agents `1.8.0`, and the directly pinned
LiveKit server SDK `2.20.1`. The locally packaged Review View executable SHA-256 is
`878b6ee558fcf35ad50b0060ec342070d4f5c525feb1aa6e2374c9b06e82d110`.
These are candidate artifacts; production versions below did not change.

## Implemented behavior

- Decision hooks, eligible incidents, explicit completion watches, Claude Jobs
  and managed reviews share an encrypted durable coordinator. Exact source/run,
  decision or result identities deduplicate observations. Dispatch is reserved
  before effects; interrupted preparation, allocation, dial and cleanup retain
  uncertainty instead of automatically retrying.
- Version-2 policies explicitly bind calling and optional viewing to a person,
  device, project and optional session/task. Bounded attempts have independent
  identities, expiry and revocation checks. They confer no input permission.
  The existing manual single-call path remains separate.
- Phone completion watches persist their requested channel, including short
  jobs. Legacy watches remain chat-only. Missing enrollment, policy or delivery
  appears as missing setup; a chat message cannot satisfy a requested phone call.
- Claude Jobs retain the existing launcher and gain run/launch provenance and
  separately configured independent checks. Missing results, mere CLI exit,
  board disappearance and timeouts cannot certify success. Interrupted checks
  remain unknown. Scoped hook supervision is registered before supported work
  starts and releases through normal native permission flow on lost heartbeat,
  revocation or expiry, including with Away off.
- Prepared calls contain a bounded question/result brief and exact authorized
  views. A plain-text app-owned Review View and existing TaskCapture helper
  supply transient exact-window frames. Freshness is checked again after slow
  handoff/media preparation. Changed results invalidate old narration; allowed
  call-scoped sharing can retain the same neutralized window.
- Answers to pending hooks and managed tasks use the exact still-current
  request/result. Managed acceptance and revisions use existing task machinery.
  Completion reports from external sessions do not claim to wake an idle chat;
  unsupported follow-up work directs the person to the supported native session.
  Stop sharing, Stop calling and call cleanup have separate effects.
- The generic transport reuses the native Calls adapter and incoming warm-media
  implementation, with one dedicated attempt/room/agent and exact caller binding.
  Each handoff, allocation, room operation, dial and cleanup has a durable receipt.
  A rejected promise is not evidence that an external operation did not occur.

`proactive.json` in the protected desktop state selects policy, a protected Job
verification plan, and protected review/capture binaries. Operator-only
`clawdtime proactive` commands expose policy, enrollment, intents, cancellation
and diagnosis. The default configuration grants nothing. Simulation managed
tasks cannot trigger real calls; real Claude Jobs remain a distinct path.
See [CONNECTORS.md](CONNECTORS.md), [DEVICE.md](DEVICE.md) and
[MEDIA_INTEGRATION.md](MEDIA_INTEGRATION.md) for component contracts and setup.

## Journal-preserving production adapter

The previous blocker is resolved in source by the ClawdTime-owned
`chert-dev-retained-v1` adapter. Installed provider beta.19 and reviewed beta.22
both delete clean binding state. Instead of upgrading on assumption or editing a
global package, the adapter pins beta.19's four relevant source hashes and Node
v24.22.1's executable hash. It intercepts only the pinned dev cleanup's deletion
of an exact scoped original journal directory and credentials. Provider drain,
revoke and release receipts still execute normally. Original state is never
copied, moved, reset or restored.

A lead-only migration installs that tracked guard into the exactly identified
running Node owner through its documented inspector interface, verifies the
acknowledgment and closes the inspector. Future dev processes preload the same
guard. A guarded unexpected exit does not automatically claim again.

The production factory loads protected native Calls configuration and CLI auth
in place, validates their destination, and connects the retained line owner,
dedicated LiveKit worker, room preparation, native dial, cleanup and incoming
restoration. The owner checks the exact tmux process, original journal scope,
provider binding and fresh release receipt. New incoming bindings retain lineage
to old revoked journals; they never replace their receipts or cursors. Source and
configuration changes, unfinished original work and uncertain effects refuse
handoff. Every effect has a durable reservation. Lost responses are not retried.

Before dialing, ownership and media are rechecked, then the actual view is
recaptured and its source/grant revalidated. Slow worker startup is bounded by
60 seconds and grant expiry, with prompt revocation polling. It never repeats
room creation. See [MEDIA_INTEGRATION.md](MEDIA_INTEGRATION.md) for exact pins,
migration commands and the retained-wrapper rollback requirement.

The unrelated older outbound backend's uncertain onboarding notice remains
untouched. Its ended calls and released leases do not prove that notice's exact
outcome. This adapter uses the configured native Calls interface directly and
does not adopt the old helper's identity or erase its evidence.

## Validation and compatibility

Final automated results:

| Check                                            | Result                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `npm run check`                                  | Passed: TypeScript, 6,731 tests in 174 files, production build                |
| `npm --prefix line test`                         | 279 passed                                                                    |
| Swift package tests                              | 378 passed                                                                    |
| Native builds                                    | TaskPanel, TaskCapture and Review View passed; Review View signature verified |
| Media / gateway suites                           | 383 / 29 passed                                                               |
| Saved-baseline synthetic compatibility           | Passed                                                                        |
| Changed-source formatting and `git diff --check` | Passed; supplied plan/baseline documents preserved verbatim                   |

Synthetic tests cover all source channels, duplicate observations, restart, lost
responses, incoming/busy lines, slow handoff, stale frames, changed results,
revocation, resolved decisions, Stop, cleanup and exact continuation boundaries.
Native review, panel and capture binaries build; the packaged review app passes
strict ad-hoc signature verification. Installed artifact and service evidence is recorded below after the production switch.

`scripts/verify-proactive-compatibility.ts` loads the saved baseline's actual built
Store, Vault, TaskLedger and TaskService against a newly created synthetic database.
The baseline authenticates its legacy session and preserves every encrypted
entity, unknown dispatch, transport receipt and cursor. Reopening with current
code retains the same records. It never opens or copies a production database:

```sh
npx tsx scripts/verify-proactive-compatibility.ts \
  /Users/garygao/.local/share/clawdtime-host/checkpoints/working-20261122T183852Z/runtime
```

This proves storage compatibility, not that old code enforces new policy. Before
any future rollback, stop new admissions and reconcile active or uncertain effects
under the new owner; preserve all new records when switching binaries.

## Production and rollback evidence

Release staging and the authorized direct deployment are in progress. Before the
switch, the original clean `e76989e7d54b883dba97f2410b9c4213f13d34bb` installation
remains available in `/Users/garygao/clawdtime-host`. The candidate is installed
alongside it rather than overwriting source, dependencies, the signed Supervisor
app or original environment file. Automatic source updates remain held.

Pre-switch read-only inspection confirmed the original incoming owner, no active
call, an available provider line and accepting worker with fresh audio/video
readiness. All 13 checkpoint configuration entries matched their original hashes
or absence. The original task database has one existing session and no coding
tasks; no runtime records were copied. Final installed versions and deployment
outcomes will replace this staging paragraph after the switch.

The private rollback checkpoint remains:

```text
/Users/garygao/.local/share/clawdtime-host/checkpoints/working-20261122T183852Z
```

Its verifier passed 28,613 entries, saved app signature and Git bundle checks.
Use its `RESTORE.md` together with the retained-wrapper correction in
[MEDIA_INTEGRATION.md](MEDIA_INTEGRATION.md): after migration, **keep the new
retention host wrapper/preload**, selecting the old incoming agent through
`CLAWDTIME_LINE_RELEASE=/Users/garygao/clawdtime-host/line`. Never revert to an
unguarded dev launcher. Disable new admissions, reconcile active/unknown effects,
then restore source selection and desktop configuration at an idle boundary.
Preserve the current database, original journals, all newer receipts and cursors.
The synthetic saved-baseline compatibility check passes; no production database
restore is involved.

The historical repaired incoming call was user-observed. New proactive ringing,
spoken alerts, screen visibility and phone-driven continuation are **not
handset-observed**. Automated readiness and integration tests do not establish
those physical behaviors. Codex hooks still require native client trust; arbitrary
idle external chats cannot be resumed by a completion report. Pending hooks and
managed-task reviews use their exact native continuation boundaries.
