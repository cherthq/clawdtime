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
