# Proactive calls implementation and production boundary

November 22, 2026. Implementation is in the `clawdtime-merge` checkout on `main`,
based on `0b3d5189251ac9f81fbb72208d6aa6a6475c5d0b`. This is a checked source
candidate, **not a production deployment or handset acceptance record**.

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

## Concrete production blocker

The installed `@trychert/facetime@0.1.0-beta.19` and latest published beta.22
delete the original per-binding journal during clean `chert dev` release. The
published guide documents deletion, and all reviewed exit paths reach it.
Neither exposes a supported in-place-retention switch or outbound call interface
on the already-owned incoming host. An idle provider line is still owned.

This conflicts directly with the requirement to keep journals, cursors, receipts
and unknown outcomes in place. No production stop, replacement host, competing
outbound worker, runtime-data copy or journal reset was attempted. Source hashes
and exact provider evidence are recorded in [MEDIA_INTEGRATION.md](MEDIA_INTEGRATION.md).

The generic transport has tested ports, but the desktop setup deliberately does
not manufacture a production `ProactiveLineOwnerPort`. Its current provider gate
reports `provider_journal_retention_unsupported` before any stop. Completing the
production path requires a supported provider release/ownership interface that
retains original state through release and reacquisition, then wiring and checking
that exact adapter. A future provider version is not presumed safe from its name.

The previously separate outbound backend also retains one uncertain onboarding
notice and a helper-binding mismatch. Read-only inspection found ended calls with
released leases and no unresolved call effects, but did not establish the exact
evidence required to retire that notice. It was left untouched. Its old credentials
or helper state are not treated as qualified authority for this installation.

After provider support exists, finish exact ownership integration, reconcile the
original outbound evidence where relevant, install the updated hook plan, supply
the selected project's explicit checks/policy and protected media configuration,
and install directly at a reconciled boundary under the existing deployment
authorization. Codex hook trust remains a native client prerequisite. No additional
pilot or deployment-approval gate is introduced by this implementation.

## Validation and compatibility

Final automated results:

| Check                                            | Result                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `npm run check`                                  | Passed: TypeScript, 6,682 tests in 171 files, production build                |
| `npm --prefix line test`                         | 248 passed                                                                    |
| Swift package tests                              | 378 passed                                                                    |
| Native builds                                    | TaskPanel, TaskCapture and Review View passed; Review View signature verified |
| Media / gateway suites                           | 383 / 29 passed                                                               |
| Saved-baseline synthetic compatibility           | Passed                                                                        |
| Changed-source formatting and `git diff --check` | Passed; supplied plan/baseline documents preserved verbatim                   |

Synthetic tests cover all source channels, duplicate observations, restart, lost
responses, incoming/busy lines, slow handoff, stale frames, changed results,
revocation, resolved decisions, Stop, cleanup and exact continuation boundaries.
Native review, panel and capture binaries build; the packaged review app passes
strict ad-hoc signature verification. No new app was installed or launched into
the production workflow.

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

Production remains clean at `e76989e7d54b883dba97f2410b9c4213f13d34bb`, branch
`fix-phone-dispatch`, in `/Users/garygao/clawdtime-host`. The installed provider
remains beta.19. No configuration, calling policy, native app, launcher, hook plan
or service was replaced. The desktop health endpoint at port 13416 still reports
simulation with live dispatch, presentation and control disabled. Its separate
Jobs launcher remains real Claude. The incoming `clawdtime-line` host is running,
with no active call at final read-only inspection. Updates remain held and
unscheduled. All 13 checkpoint configuration entries match their saved presence
and content hashes.

The private rollback checkpoint remains:

```text
/Users/garygao/.local/share/clawdtime-host/checkpoints/working-20261122T183852Z
```

Its read-only verifier passed all 28,613 integrity entries, saved application
signature and Git bundle checks during this implementation and again before
delivery. No services changed during verification. Restoration instructions are
`RESTORE.md` inside that directory; repository context is in
[PRODUCTION_ROLLBACK_BASELINE.md](PRODUCTION_ROLLBACK_BASELINE.md). Preserve the
dated checkpoint. Its older host-stop procedure must also respect the newly
identified journal-retention blocker; do not exercise it against the working host
merely to test rollback.

The historical repaired incoming call was user-observed. New proactive ringing,
spoken alerts, screen visibility and live phone-driven continuation were **not
handset-observed**. Automated publication metadata and synthetic checks do not
establish those behaviors. Production installation remains blocked as described
above; no deployment success is claimed.
