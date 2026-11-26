# Proactive calls implementation and production boundary

## November 22: observed completion walkthrough

A real managed documentation task completed, passed the normal TypeScript and
repository checks, and automatically called the paired human. The human confirmed
ringing, the spoken completion summary, and the prepared review visible on the
phone. The exact task subsequently reached `accepted` through the phone path.
This establishes this managed-task completion/review flow; it does not establish
arbitrary external-session hooks or follow-on coding execution.

The live run exposed and corrected three issues:

- `479b442`: wait for the exact worker's authenticated readiness acknowledgement
  after LiveKit publications appear. Keep authority, liveness, fresh-frame and
  one-shot dial checks. Return only fixed, non-sensitive refusal codes.
- `4926009`: establish the hooks test fixture's intended mode with `chmod`.
  The production `077` umask correctly removed group-read during creation; the
  test had assumed another umask. Preserve both the production privacy settings
  and the permission-preservation assertion. The same fixture correction is
  installed in the selected project, with its other uncommitted work preserved.
- `682a1a6`: observe bounded provider idle/media-readiness convergence before
  reserving the incoming claim. No claim or host start is retried. Changed
  ownership, holds or journals still fail closed, and uncertainty retains the hold.

One capture refusal was explained by the human moving the review window partly
off-screen. Exact-window guards were retained unchanged. A later stationary review
was physically observed on the phone.

The completion call's restoration initially stopped before any incoming claim
reservation. Exact provider cleanup, unchanged retained journals, the original
hold, absent host/worker, completed media/capture receipts, and the absence of any
new claim reservation were verified before an audited reconciliation. One incoming
claim was then performed and confirmed; the original unknown history was retained
and its transport outcome reconciled from the new receipts. No call was redialed
as part of that recovery.

The installed runtime overlay is
`~/.local/share/clawdtime-host/releases/proactive-handoff-682a1a6`: backend base
`479b442`, with the owner adapter from `682a1a6`. `RELEASE_MANIFEST.json` records
the exact overlay. Later upstream conversation/planner changes are integrated on
main but are not silently included in this runtime overlay. The incoming host,
provider CLI, credentials, policy/session authority, update hold and journal guard
are retained. Temporary test diagnostics and their configuration fingerprint were
restored to the original check plan; raw diagnostic test output was removed after
recording the cause.

Final validation: TypeScript, build, formatting, 6,746 tests across 174 files
(`vitest run --maxWorkers=4`), and 282 line tests passed. Two earlier default-
parallelism runs each hit a different timing limit (browser targeting and the
local inspector fixture); the browser test passed separately and the complete
four-worker run passed without weakening assertions or timeouts. Fresh installed
doctor checks report provider ready and zero pending, active or unknown calls.
The final restoration wait was unit-tested and installed after the observed call;
no additional handset call was placed solely to exercise that wait.

Private installation/reconciliation evidence is under
`~/.local/share/clawdtime-host/proactive-v1/production-task-check`. Preserve the
current journals and receipts during rollback. At an idle, reconciled boundary,
the prior desktop release is `proactive-ready-479b442`; retain the corrected owner
adapter and existing retention guard when reverting desktop code. The older
baseline rollback requirements below still apply. Never reset the task ledger,
restore a stale cursor, or use an unguarded incoming host launcher.

## Initial production deployment

November 22, 2026. **Production deployed** from immutable source commit
`b680e896eb512cfffe875066c3a6bcbfe89d0fe6`. The original proactive implementation
is `952d49c`; retained delivery is `5b681c5`, with private-log and mapped-executable
fixes in `4f993bd` and `b680e89`. Main includes these commits. The working baseline
remains untouched in `~/clawdtime-host` at `e76989e`.

Validation and installation use Node `v24.22.1`, provider
`@trychert/facetime@0.1.0-beta.19`, LiveKit agents `1.8.0`, and LiveKit server SDK
`2.20.1`. Deployment health and physical phone evidence are separate below.

## Implemented behavior

- Decision hooks, eligible incidents, explicit completion watches, Claude Jobs
  and managed reviews share an encrypted durable coordinator. Exact source/run,
  decision or result identities deduplicate observations. Dispatch is reserved
  before effects. Interrupted preparation invalidates stale packets and requires
  fresh preparation; reserved delivery and cleanup effects retain uncertainty
  without retry.
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
| Changed-source formatting and `git diff --check` | Passed                                                                        |

Focused follow-up checks passed 8 retention tests (including the actual installed
provider runDev cleanup and Node inspector migration), 20 owner tests, 11 production
adapter tests, 27 transport tests and 16 host tests. The post-check changes were
limited to log umask and mapped-executable verification; their relevant suites and
the installed production build passed.

Synthetic tests cover all source channels, duplicate observations, restart, lost
responses, incoming/busy lines, slow handoff, stale frames, changed results,
revocation, resolved decisions, Stop, cleanup and exact continuation boundaries.
Native review, panel and capture binaries build; the packaged review app passes
strict ad-hoc signature verification. Installed artifact and service evidence is recorded below.

`scripts/verify-proactive-compatibility.ts` loads the saved baseline's actual built
Store, Vault, TaskLedger and TaskService against a newly created synthetic database.
The baseline authenticates its legacy session and preserves every encrypted
entity, unknown dispatch, transport receipt and cursor. Reopening with current
code retains the same records. It never opens or copies a production database:

```sh
npx tsx scripts/verify-proactive-compatibility.ts \
  ~/.local/share/clawdtime-host/checkpoints/working-20261122T183852Z/runtime
```

This proves storage compatibility, not that old code enforces new policy. Before
any future rollback, stop new admissions and reconcile active or uncertain effects
under the new owner; preserve all new records when switching binaries.

## Production and rollback evidence

The authorized direct switch completed at approximately 19:43 UTC; read-only
owner inspection at 19:44 UTC and continued installed monitoring through
19:45:42 UTC passed.
No scoped-call pilot or outbound rehearsal was used.

| Installed component | Version / evidence                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source              | `b680e896eb512cfffe875066c3a6bcbfe89d0fe6` at `~/.local/share/clawdtime-host/releases/proactive-20261122`                                                             |
| Provider            | Existing beta.19 unchanged; exact Node/source-pinned ClawdTime retention guard                                                                                        |
| Desktop             | Same port 13416, state directory, desktop ID, UI token, registration ID and task session; worker now `codex`, idle `standby`, existing computer enablement retained   |
| Incoming owner      | One active connected provider binding, exact guarded tmux process; fresh `dev_ready`/`dev_connected`; no active call                                                  |
| Original journal    | Same filesystem device, inode and SHA-256 after clean release and reacquisition; original receipts unchanged                                                          |
| Line readiness      | Actual fresh provider audio and video checks pass; incoming warm startup observed in host receipts                                                                    |
| Proactive doctor    | Delivery and preparation configured, provider ready, one policy, zero pending/active/unknown intents and no blockers                                                  |
| Review View         | Existing built artifact installed alongside release; SHA-256 `878b6ee558fcf35ad50b0060ec342070d4f5c525feb1aa6e2374c9b06e82d110`; strict signature verification passed |
| TaskCapture         | Release build SHA-256 `ea8d86975afe516bad5b2cfdcf6e71f16f0d2b65e3c0bbbe1976821fc4a95722`; screen permission, unlocked console and login preflight passed              |
| Supervisor app      | Original signed app unchanged                                                                                                                                         |
| Configuration       | Protected `~/.local/share/clawdtime-host/proactive-v1`; original native/provider credentials and `.env.local` referenced in place                                     |
| Hooks               | Nine Claude and seven Codex events installed with exact immutable script and explicit state root; Codex native `/hooks` trust remains required                        |
| Updates             | Existing update hold retained; no scheduled update; outbound ownership hold cleared only after confirmed restoration                                                  |

The initial guard migration kept the old owner alive, acknowledged installation,
and closed the inspector. The real retained owner then reserved the deployment
handoff, gracefully drained/revoked the old binding, required its fresh zero-work
release receipt and verified the original journal unchanged. It restored incoming
ownership through one new claim, retaining original binding lineage. There were
no competing owners, copied journals, removed receipts or bypassed unknown effects.
The read-only preflight found Darwin's `ps comm` was only `node`; before migration,
executable verification was corrected to use the mapped executable and its pinned
hash, with an actual bare-argv0 synthetic-process regression test.

All 13 baseline configuration entries matched before switching. Changes are the
new private configuration, exact desktop fingerprint for Codex plus checks, desktop
launcher, global ClawdTime CLI wrapper, own hook groups, installation record, and
private mode on the existing dev log. IDs, credentials and panel receipts were
preserved. The original desktop and panel exited at a confirmed idle boundary;
new startup replayed the existing registration without renewing its 24-hour
session. Existing task state was neither copied nor reset. The service retains
its normal session expiry/reauthorization boundary.

The policy covers only the selected project, all five requested trigger types,
100 bounded attempts over 30 days, at least 60 seconds between attempts, and
five-minute attempt authority. Walkthrough viewing is limited to `prepared-review`;
no input permission or silent alert fallback is granted. TypeScript and Vitest
checks are protected outside the worker project. New explicit Claude Jobs retain
the Claude launcher and enroll their exact run before launch. Managed tasks use
the real Codex worker. Existing legacy Jobs without launch provenance remain
ineligible; deployment does not invent their identities or call about them.

Private installation evidence includes `deployment.json`, `config-drift.json`,
`installed-health.json`, `owner-health.json`, the retained owner ledger, guard
receipts and exact configuration hashes under `proactive-v1`. It contains no copied
task database, journal, screen or audio. Original journals remain under `.chert/dev`.

The private rollback checkpoint remains:

```text
~/.local/share/clawdtime-host/checkpoints/working-20261122T183852Z
```

Its verifier passed 28,613 entries, saved app signature and Git bundle checks.
Use its `RESTORE.md` together with the retained-wrapper correction in
[MEDIA_INTEGRATION.md](MEDIA_INTEGRATION.md): after migration, **keep the new
retention host wrapper/preload**, selecting the old incoming agent through
`CLAWDTIME_LINE_RELEASE=~/clawdtime-host/line`. Never revert to an
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

Unknown handoff, worker, dial or cleanup outcomes can retain the outbound hold
and leave incoming calling unavailable until exact operator reconciliation.
There is no automatic redial or replacement claim after uncertainty. Preserve
the original effect evidence when resolving that operational state.
