# Agent-owned conversation release record

Prepared November 12, 2026 (America/New_York). Version 0.2.0.

**Rollout update:** the user subsequently approved the exact release `8efbacc`
and all listed component updates. Deployment is complete; see [STATUS.md](STATUS.md)
for exact deployments, preserved state, signing correction and the historical-input
reconciliation blocker. No live call has been performed. The preparation and
approval rules below remain the release record.

## Prepared scope

Branch `codex/agent-owned-conversation`, based on `82ab868` (the inspected remote
main matched that commit). The approved and deployed source is
`8efbacc7407a6bad0bbe96f2eb422d0221195a8d`; verification results are recorded in
STATUS.md. The original implementation request authorized preparation only. The
subsequent user approval authorized the listed deployment and component updates;
it did not authorize a live call or promotion to main.

New version-2 connector sessions own ordered conversation turns, replies and normal
coding work throughout a call. ClawdTime transports media and holds durable receipt
and permission boundaries. Native shared-surface tools require explicit capability
attestation; fallback is a tool for that same agent, default off. The Mac Control
Panel defaults to Agent tools only; prior pairing control is not fallback consent.
View-only policy forbids both delegated native and fallback input. Native permission
prompts retain their normal client behavior.

## Compatibility and migration

- Missing or explicit version 1 retains the old controller/ack/resume lifecycle.
  Its eighth model step remains reply-only; queued speech/lifetime fixes remain.
- A run's version/capabilities cannot change on reconnect. New runs default v2;
  `--protocol-version 1` explicitly selects the compatibility controller.
- Stop and finish old sessions, reconcile all call/media/input outcomes, and retain
  their cursors/receipts before creating new v2 runs. Never reinterpret old records
  or reuse a consumed call approval. No destructive schema migration is required.
- Deploy backend, media, gateway and helper as a coordinated reviewed release.
  Old helpers lack v2 local-policy authority and cannot safely grant v2 sharing.
  New helper defaults also restrict legacy input until locally permitted; document
  this change before upgrading. Permissions and local Enable remain separate.
- The current foreground JSONL bridge supports conversation and suitable native
  tools, but not fallback screenshots/input: it has no transient native image
  rendering channel. Fallback requires image-capable MCP. Browser-only native
  tools qualify only their actual visible shared surface, never the whole desktop.

## Approved deployment scope

The existing independent Railway project is
`9fafdcf9-c7eb-4465-8387-ec3f8acbaefa`, production environment
`8f5a3eb3-37e1-480a-ad07-6e89968a1b8c`:

| Target                      | Existing service                       | Artifact                                                       |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Backend / www.clawdtime.com | `b4af7a8c-c6b1-4b1c-af2f-dbaedad618ea` | Root Dockerfile, tracked source archive                        |
| Media                       | `07eabf9a-c8fd-46da-8210-54c7d2f868fb` | media/Dockerfile, same source commit                           |
| Mac companion               | Existing independent ClawdTime app     | Reviewed Swift build, separately approved install/signing plan |
| Gateway                     | Existing independent ClawdTime relay   | gateway source from same commit, separately approved restart   |
| Connector                   | Current project integration            | Bundled build and updated skill, new run after old cleanup     |

Approval must identify the exact commit and which targets may change. Do not
replace the user's companion or restart a gateway merely because hosted deployment
is approved. No line transfer, new number, environment secret rotation, new hosting
purchase, public package publication or sibling service change is part of this
release. Validate current target/idle ownership read-only immediately before any
approved rollout; this document is not current production observation.

Prepare a tracked `git archive` from the reviewed commit, never upload workspace
`.data`, private configs, media or installed state. Preserve encrypted backups,
SQLite WAL, event cursor, unknown effects, helper action receipts and media speech
ledger. Use one backend process/volume and one live owner. Gate new sessions during
the coordinated transition; do not alter active sessions' architecture.

## Rollback

The known prior production source is `424367c8682b9db1483eb0712233cefb527da73e`;
`82ab868` adds its documentation. Confirm actual deployed source before rollout.
After explicit rollback approval, stop accepting new v2 sessions, drain/end owned
calls, reconcile unknown speech/input and confirm capture release before changing
binaries. Preserve all ledgers and cursor state. Restore the previously verified
backend/media artifacts and the preserved exact gateway/helper binaries/configs
without restoring an old database or cursor. New connector runs must explicitly
use v1 against the old backend. Do not launch calls to prove health or silently
re-enable capture. Unresolved effects block an unsafe handoff, not retention.

## Physical qualification still required

Obtain separate approval for one specifically scoped call, after deployment and
installation are approved and verified. Qualify Codex and Claude independently:

1. Exact existing session handles multiple voice/text turns and supplies speech.
2. Visible native control acts on the intended shared surface under native approvals.
3. Screen sharing survives ordinary reasoning/file work and safe executor handoff.
4. Local view-only/default/fallback policy and Stop during action behave correctly;
   unresolved native actions remain visible rather than asserted canceled.
5. Speech at most once, corrections, mute, hangup, disconnect/reconnect, stale owner,
   lock/sleep and pairing revocation preserve receipts and do not replay input.
6. The connected call stays active beyond five minutes, then ends intentionally
   with media/capture/native-call cleanup reconciled.

Synthetic tests and observed input receipts do not establish handset rendering,
intended UI success, real native cancellation or sustained physical connection.
The later historical call reported by the user ended intentionally before five
minutes; it does not qualify this redesign. No further call is authorized here.

## Validation and review

`npm run check`: 561 tests / 33 files, typecheck and build passed. Media: 138;
gateway: 29; Swift: 19 plus build; Mac onboarding scripts: 21. Built-app browser
onboarding and formatting passed. Both installed CLI synthetic probes passed;
see the exact surface/version matrix in CONNECTORS.md.

Reciprocal subsystem reviews and a fresh independent integrated review have no
remaining blocking findings. Reported asynchronous authority, cross-request native
ownership, local Stop/ACL, speech reconciliation and panel-status findings were
fixed with regressions. See STATUS.md for the review record.

The originally prepared ad-hoc companion artifact is preserved. The installed
release uses the original installed Apple Distribution identity, with unchanged
executable code and restored permission recognition. It is not notarized. Public
distribution still requires notarization and clean-install verification. Source
archives contain tracked files only. The local release manifest records both
companion artifacts, source hashes and deployment verification. Exact prior helper
and gateway source are retained privately for rollback; do not restore old ledgers
or cursors.
