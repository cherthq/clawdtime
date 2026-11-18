# Coding demo build log

## November 18, 2026 — source audit and step a

Branch: `demo/coding-flow`, isolated worktree `/Users/garygao/clawdtime-coding-demo`.
Fetched `origin`; approved main remains `8c8cf76`. Argos baseline is
`815d51b82aa81e62e857b08713a9d0b4324a5a6f`. Existing checkouts and untracked
product/walkthrough drafts were preserved. No merge, deployment, live call,
line operation or installed configuration change is authorized by this work.

Lead owns shared contracts, task service/routes, scripts, manifests and integration.
Connector specialist owns CLI/worker and connector tests. Transport specialist owns
encrypted task ledger and backend tests. Media specialist audits voice requirements
and independently reviews the step-a boundary; voice implementation waits for b.

Source audit confirmed that the old broker retains instructions only transiently,
the Codex runner conflates terminal execution with limited file-content checks,
and managed sessions conflict with streaming voice/presentation. Existing call
evidence includes a 422-second call and an unclassified camera failure, not a
qualified coding flow or duplex handset acceptance.

Decision: reuse main's SQLite transactions/receipts and AES-GCM Vault. Introduce
independent task sessions rather than weakening legacy original-chat guards.
Persist bounded task context encrypted, preserve run/check/call histories, and
reserve dispatch before invocation. Restarted active execution or verification
remains unknown; there is no automatic replay or generic force-success endpoint.
One unresolved worker fences dispatch globally in the small demo service.

The development service uses an explicitly labeled local fixture pairing, an
owner-only state directory, exclusive process lock, encrypted context, hashed
session credentials and an exact project allowlist. It does not establish phone
pairing acceptance. Live task calls, screen capture and control are disabled.
Step a accepts simulated worker events; later real mode restricts these to the
service. Developer CLI output is not on-camera content.

No Argos commits have been merged. Its runner and voice mechanics will be selectively
extracted only at their required stage; document/website/experimental features are
excluded. Presentation and desktop work remain gated behind physical c.1.

Validation and checkpoint results will be recorded here before committing.

### Step a checkpoint validation

- `npm run check`: passed TypeScript, 38 test files / 599 tests, and build.
- `npm run task:simulate`: passed; two distinct simulated runs, duplicate
  receipts, restart reload, independent synthetic reports, and explicit acceptance.
- `npm run task:service -- --state PRIVATE_DIR --project DISPOSABLE_PROJECT
  --port 13320`, then `npm run cli -- task register`, `task create`, and
  `task status`: observed working over local HTTP; graceful shutdown/restart
  preserved the task and session. Credential files remained outside the project.
- Independent connector review: 20 ledger/CLI tests passed. Independent media
  authority review: 24 authority/ledger tests passed. Fixed stale prior-call events
  overwriting a newer run and independently fenced unknown call receipts.
- No Python/Swift source changed; component checks are not applicable to this step.
- `git diff --check`: an extra documentation EOF blank line was found and removed.
  Reviewed changed/new source for scope, secrets and authorization boundaries.

Runnable entry points: `npm run task:simulate` and `npm run task:service --
--state PRIVATE_DIR --project DISPOSABLE_PROJECT`; CLI details in CONNECTORS.md.
Step a is software/simulation evidence only. The tag `step-a-done` will identify
this checkpoint; its commit hash will be recorded in the next checkpoint.

## Step b — app-owned Codex runs and independent watcher

Step-a checkpoint: `6b976e0`, annotated `step-a-done`, both pushed to origin.
Selective extraction: `connectors/codex/app-server.ts` from Argos `815d51b`;
new task worker adapts its runner's terminal/approval/in-flight effect handling.
The old broker, remote document worker and website features were not imported.

Installed Codex is `0.166.0-alpha.5.1`; connector specialist checked local generated
App Server schema and official App Server documentation. A no-turn preflight
confirmed `on-request`, workspace-write, network disabled and all three inherited
MCP integrations disabled. OS environment allowlist excludes app/provider secrets.
Each run uses a new ephemeral thread; unexpected approvals are declined and the
adapter waits for actual terminal evidence. Unknown outcomes fence later dispatch.

The service owns dispatch and verification; public session clients cannot forge
worker or verification events in real-worker mode. A typed decision receipt starts
one new scoped run. Its response is nonblocking, so status remains responsive.
Context is bounded; native approval is not a human task decision. Verification
commands are explicit argv arrays with no shell, isolated environment, bounded
output hashes, timeouts and process-group cleanup. A submitted kill is not proof of
quiescence: unresolved descendants remain unknown. Prepared briefs cite current
run/check identities, and obsolete briefs clear before follow-up execution.

Runnable entry points:

```
npm run task:fixture -- /tmp/NEW_DISPOSABLE_DIRECTORY
npm run task:service -- --state /tmp/NEW_DISPOSABLE_DIRECTORY/state --project /tmp/NEW_DISPOSABLE_DIRECTORY/project --worker codex --checks /tmp/NEW_DISPOSABLE_DIRECTORY/checks.json
npm run cli -- task help
```

Register with the private operator file, create a task, then `task run --id ID`.
`task command` with `decide` creates and launches a scoped follow-up. After restart,
existing queued work requires explicit `task run`; unknown execution is never
replayed. The fixture has a deliberately unresolved empty state and independent
assertions outside the worker's writable project. It is not a production incident.

Independent reviews caught and fixed validation occurring after an earlier check,
kill-submission being mistaken for process termination, oversized context metadata,
and inherited environment secrets. Native approval boundaries remain intact.

### Step b validation and locally observed result

- `npm run check`: passed typecheck, **42 files / 642 tests**, and build.
- `npm run task:fixture -- /tmp/clawdtime-real-demo-20261118`, local service
  with `--worker codex --checks .../checks.json`, CLI register/create/run/command:
  two actual Codex invocations completed in **23,421 ms** and **24,181 ms**.
  First watcher report: independent filter/empty-state assertions failed, JavaScript
  syntax passed. The worker separately reported the seeded unresolved empty-state
  decision. A typed instruction created a distinct second run on the same task;
  replaying the exact decision returned `replayed:true` and retained two runs.
  Second watcher report: all six behavior assertions and syntax passed;
  authoritative state became `review_ready`. Task receipt/state retained privately
  outside the repository. No phone, screen capture, control or deployment occurred.
- `vitest` targeted engine/ledger/worker/verifier run: 57 tests passed. Media
  specialist ran 9 real-child-process verification tests; connector review checked
  current policy and native permission behavior. No remaining reviewed blocker.
- `npm run typecheck` and `git diff --check`: passed after final integration.
- No Python or Swift source changed; those component checks are not applicable.

The worker's own claim that its local checks passed did not overrule the first
independent failed report. Output hashes/exit codes are watcher evidence; these
checks do not prove browser/handset rendering or product acceptance. The real
fixture used a locally authorized synthetic pairing, not a phone-paired session.
`step-b-done` identifies this passing checkpoint; hash follows in next entry.

Final pre-commit rerun: `npm run check` passed **42 files / 643 tests** including
prepared-brief regression, typecheck and build. Independent diff review passed.
