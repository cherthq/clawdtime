# ClawdTime

Independent agent-to-human attention project. Read IMPLEMENTATION_PLAN.md and
SESSION_PROMPT.md. Source provenance: Apple Teams be47b11fe1317c4747db4121bec37896998b5201.
Never modify Apple Teams or sibling chert-facetime. Never copy customer/runtime data.

Do not create or use `codex/` branches. Use `main` for this work; when a separate
branch is needed, use a generic descriptive name (for example, `fix-speech`).
Preserve unmerged work when renaming or removing old branches.

Default simulation/standby. Only the coordinating lead may
integrate shared contracts/manifests, handle secrets, deploy, or hand off live lines.
No concurrent live line ownership. Preserve cursors, receipts and unknown outcomes.
No blind retries of external effects. Tests are not physical acceptance.

Parallel file ownership for this implementation:

- Lead: src/contracts.ts, src/server.ts, src/app.ts, src/control/, scripts/, public/,
  root manifests/config/docs (except assigned docs below), integration and acceptance.
- Transport specialist: src/storage/, src/transport/, src/pairing/, src/sessions/,
  src/attention/, tests/backend*, docs/TRANSPORT.md.
- Mac specialist: mac/, media/, gateway/, tests/media*, docs/DEVICE.md,
  docs/MEDIA_INTEGRATION.md and docs/MIGRATION_MEDIA.md.
- Connector specialist: cli/, connectors/, skills/, tests/connectors*,
  docs/CONNECTORS.md.
  Request shared contract changes from the lead. Do not edit another owner's files.

Explicit session/identity authorization, local Stop, frame freshness and exclusive
control are mandatory. For v2, claim exclusive native/fallback execution before
shared-screen input and release it afterward; ordinary reasoning/file work stays
active during sharing. Only legacy v1 uses global yield/acknowledge/resume. Model
output is an untrusted single-action plan.
Never claim submitted input proves UI success. Keep screens/audio transient.

Node 24+, TypeScript, Python, Swift. npm run check verifies the backend/connectors;
component READMEs document Python/Swift validation. Keep secrets and personal data
out of tracked files, logs and test fixtures. External prerequisites must be concrete.
