# Implementer prompt: ClawdTime improvements

Copy the prompt below into the implementation chat. This file and the detailed
plan were prepared as uncommitted drafts on November 13, 2026. The user subsequently authorized implementation, commits and a push to
`origin/improvements`; they do not authorize a live test.

---

Work in `/Users/garygao/clawdtime`. Implement work packages **A–F** in
`docs/FACETIMEOS_IMPROVEMENTS_PLAN.md`, test them, and commit the completed work on
the branch named **`improvements`**. Never create or use a `codex/` branch.

Your objective is a clear, dependable agent-owned call experience: compact native
activity UI, trustworthy speech/delivery/work status, bounded completion receipts,
useful latency diagnostics and actionable readiness. Keep the existing coding
agent, call infrastructure and approval/control boundaries. Do the implementation,
not just another proposal.

## Read and establish the baseline

1. Read applicable `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, `SESSION_PROMPT.md`, the
   detailed improvements plan, `docs/ARCHITECTURE.md`, latest `docs/STATUS.md`,
   `docs/CONNECTORS.md`, `docs/MEDIA_INTEGRATION.md`, `docs/DEMO_ACCEPTANCE.md`, and
   the relevant Mac/gateway component documentation. Historical migration/live
   handoff instructions are background, not a request to rerun deployment or move
   the live line. This prompt's explicit scope is A–F only.
2. Inspect `git status`, current branch, worktrees and recent commits. The drafting
   baseline was main `bf8f18e`; do not assume it remains current. Preserve user and
   teammate work. The two planning files may be untracked; read and carry them into
   the implementation branch rather than discarding them.
3. Create `improvements` from the current intended main baseline if it does not
   exist. If it already exists, inspect its history and worktree ownership and
   continue it safely; do not reset, force-update or duplicate it as `codex/...`.
   Do not force-switch a dirty worktree or delete other branches. Keep unrelated
   user changes out of your commits. If an active owner prevents use of the exact
   branch, resolve that concrete conflict before proceeding with dependent edits.
4. Review relevant `multi-device-relay` changes and newer onboarding work read-only
   if needed. Main already preserved deployed routing changes; do not blindly
   merge the older branch or overwrite current status documentation.
5. Run the relevant baseline tests in isolated environments, inspect failures,
   and distinguish pre-existing failures from regressions.

## Implementation requirements

Follow the detailed plan's dependency order and file map. Finalize the proposed
schema names against current code; the plan's examples are design guidance, not
assertions that new fields/tools already exist.

- **A: Activity projection.** Extend existing conversation progress/polling and
  panel telemetry with bounded, versioned presentation data. Keep explicit state
  transitions authoritative, exact bindings, stable IDs, monotonic ordering,
  idempotency, capability negotiation and old-client compatibility. No new task
  engine. Store only necessary metadata/hashes durably; presentation text is
  transient with the plan's capacity and expiry limits.
- **B: Native panel.** Add compact and expanded activity views to the AppKit
  companion. Retain the full setup UI, exact session/device labels, immediate
  local Stop, and pending versus acknowledged Mute/End/Request pause. Avoid focus
  theft. Test accessibility, long text, display bounds, stale telemetry and unknown
  outcomes. A new Electron app or public local HTTP UI is out of scope.
- **C: Speech and progress.** Extend existing captions to distinguish backend
  acceptance, agent acknowledgment, execution, native approval and uncertain
  outcomes. Keep interim transcript text in media. Do not rebuild the repaired
  speech assembler or introduce a second summarizer model. Intermediate activity
  is visual-only; retain existing speech reply/deduplication rules and honest
  half-duplex status. Update the tracked source skill, not installed copies.
- **D: Outcome receipts.** Report outcomes for individual v2 turns without ending
  the call or invoking legacy `complete()`. Bind the report to the correct turn;
  distinguish agent-observed, unverified and unknown outcomes. Provide concise
  tool/poll results for the original agent to summarize in its own chat. Never
  infer UI success from submitted input. No screenshot capture, automatic iMessage,
  unsolicited chat injection or action replay. Apply the short transient outcome
  text lifetime and preserve metadata across restart.
- **E: Diagnostic timing.** Extend existing allowlisted diagnostics and add a
  fixture-first local inspector/report. Correlate stages with scoped IDs; measure
  process-local durations monotonically and label cross-process observations.
  Include sample/failure counts with median/p95. Sanitize export via an allowlist;
  never dump raw diagnostic responses or retain transcripts, screens, credentials,
  phone numbers, private paths or exception bodies. Do not silently read live config.
- **F: Readiness and qualification.** Reuse current check/nextAction fields and
  deterministic reason categories. Read-only rechecks cannot grant permission or
  trigger effects. Add an isolated full-journey/fault harness and update the manual
  handset/clean-install acceptance instructions. Keep those live checks unrun.

Review FaceTimeOS only as reference at
`97745aa62d37923a8dc8ccc5168a36797975bf65`; the plan links exact files. Independently
implement the UI/feedback ideas in ClawdTime's stack. Do not copy its fixed-coordinate
FaceTime automation, optimistic call flags, substring completion detection,
last-requester routing, stop-and-replace conversation behavior, raw logs or screen
storage. Do not execute its setup/test scripts. For any direct source reuse,
verify precise provenance/license coverage and retain applicable notices; the
subdirectory licenses do not establish root/backend licensing.

## Authority and non-goals

This is an implementation/test/commit task with an explicitly authorized push to
`origin/improvements` using `git push -u origin improvements`. Verify the remote
branch points to the final intended commit. This overrides the original no-push
restriction. **Do not merge to main,
deploy, install/restart the companion/gateway/connector, change live configuration,
place a call, send an outbound message, publish artifacts, or exercise real native
input.** A prior call authorization in another conversation is not reusable here.
Use synthetic fixtures and isolated transports. Do not read or copy production
databases/customer state to make tests convenient.

Do not modify Apple Teams or sibling `chert-facetime`. Preserve unknown outcomes,
cursors, effect receipts and session identity. Do not loosen native tool restrictions,
local Enable/Stop, freshness, control leases, executor epochs, policy revisions or
explicit approval requirements. Read-only telemetry never authorizes input.

Package G is deferred: no custom default CUA agent, full-duplex rewrite, generalized
Messages task launcher, screenshot messaging, phone control, VM orchestration,
new adapters, billing, public line pooling or infrastructure migration. Do not
add these to make the demo look broader. No additional agent is needed for this
handoff; respect current session instructions and any active file ownership.

Continue through routine implementation choices autonomously. If a concrete
external prerequisite blocks one part, complete independent work and document the
precise gap. Do not interpret that as permission to bypass a native restriction or
substitute a different control path.

## Validation and commits

During development run focused tests. Once integrated, run `npm run check`, the
onboarding browser suite when affected, relevant complete media/gateway/script
suites, and `swift test` plus `swift build` in `mac/`, using documented isolated
environments. Do not run live connector spikes without inspecting their effects
and obtaining any required separate authorization. Build/package commands must
not replace or launch installed components.

Add meaningful regression coverage for cross-language contracts, older components,
replay/conflicts, wrong sessions, stale text, unknown outcomes, interrupted commands,
restart, caption generations, privacy bounds and zero effects from status/reporting.
Inspect synthetic renderings for phone portrait/landscape and compact/expanded Mac
states. Tests are not physical acceptance. Record exact commands/results and
limitations in `docs/STATUS.md`; update relevant usage docs.

Before each commit inspect the staged diff and ensure it contains only intended
source/tests/docs, no secrets, screenshots, temporary upstream checkout, runtime
state, generated outputs or unrelated user changes. Use concise imperative commits,
for example:

- `feat: add scoped activity and outcome status`
- `feat(mac): show compact call activity and controls`
- `feat: show agent receipt and progress in call captions`
- `feat: report speech latency and actionable readiness`
- `test: cover call feedback and recovery journeys`

Choose commit boundaries that remain reviewable and coherent; do not force this
example list. Include the reviewed plan and implementer prompt in branch commits.
Verify the current branch is exactly `improvements` before committing. Finish with
all intended implementation changes committed and unrelated work preserved.

Your final response must state what changed, branch and commit hashes, tests and
visual checks actually run, any failed/blocked checks, physical acceptance still
needed, and remote branch link and verified remote hash, and confirmation that you did not
merge, deploy, install, restart live components, call, send outbound messages or
exercise real native input.
