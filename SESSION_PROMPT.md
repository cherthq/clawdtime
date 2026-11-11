# New coding session prompt: implement ClawdTime with agent teams

You are working in `/Users/garygao/clawdtime`. The user has approved the implementation plan. Context yourself, then carry it out using a coordinating lead and parallel specialist agents.

## Read first

1. Read `/Users/garygao/clawdtime/IMPLEMENTATION_PLAN.md` completely. It contains the approved product scope, migration map, README requirements, agent-team plan, live-line handoff, and acceptance criteria.
2. Read applicable parent/project `AGENTS.md` instructions. Create ClawdTime-specific instructions during foundation work.
3. Inspect `/Users/garygao/apple-teams/AGENTS.md`, its current Git status, and the relevant source/docs listed in the plan. The audited baseline is `be47b11fe1317c4747db4121bec37896998b5201`; do not overwrite subsequent work or silently migrate unreviewed changes.
4. Relevant source context includes `gateway/README.md`, `devices/README.md`, `docs/DEVICE_PILOT.md`, the latest relevant entries in `docs/STATUS.md`, `docs/DEPLOYMENT.md`, `docs/TRANSPORT.md`, and source/tests for calling, media, device control, and receipts. Some older documentation describes superseded gates; prefer current code plus dated evidence and fresh read-only checks.
5. Check current official Claude Code and Codex integration documentation and installed versions before selecting hooks, MCP behavior, or session-control APIs. Do not invent APIs or assume a skill alone can resume arbitrary running sessions.

## Product and scope

Build **ClawdTime: your agent can FaceTime you** as an independent project, not a rename of Apple Teams.

One-time setup: text the number → install/pair the Mac companion with Screen Recording and Accessibility for CUA → run one command to connect Claude Code or Codex.

Launch Mode 1: the user works in their usual coding agent; it requests attention when blocked, needing a decision/approval, or finished; ClawdTime calls and shows the relevant screen; the human responds by voice/text or requests CUA; the exact agent session continues; the result returns to Messages.

Include human-directed click/type/scroll and bounded AI-directed CUA in the MVP. Ordinary authorized actions should not require repetitive confirmation codes. Preserve explicit permission/pairing/session authorization, frame freshness, post-action observation, native agent policies, and local Stop. Coordinate exclusive control so the coding agent and CUA cannot race the screen. Do not treat silence, unrelated audio, or agent TTS as approval.

Mode 2 (general tasks initiated from Messages), cloud sandboxes, public line pooling, groups, billing/referrals, and broad marketing/email/video integrations are later phases. Preserve the existing single-action CUA scope; the external coding agent runs its own multi-step work.

## Execution instructions

- Initialize this local Git repository and work on `codex/` branches. Preserve the handoff files.
- Create `README.md`, `AGENTS.md`, and the architecture/migration/status/acceptance/line-handoff docs specified in the plan.
- Selectively copy source and matching tests from Apple Teams. Keep the TypeScript/Python/Swift stack initially. Extract narrow interfaces instead of copying the whole workspace engine and unrelated providers.
- Do not copy production databases, customer messages, OAuth grants, `.env`, `.data`, recovery secrets, installed configurations, `node_modules`, or build artifacts.
- Use independent application IDs, ports, secrets, state paths, service names, and deployment volumes. Default to simulation/standby.
- Run connector feasibility spikes early. Prove a cooperative attention request and response inside a real agent session before building broad automatic hooks.
- Define shared typed contracts for pairing, agent sessions, attention requests, calls, human responses, and control leases before parallel coding.
- Use durable request/result handling with bounded waits or supported async/polling. MCP timeout, restart, or retry must not repeat a call or consume an answer twice.
- Implement pairing/install/doctor/disconnect with configuration preservation. `npx clawdtime connect` is proposed UX only: verify package ownership before publication or execution; a pinned local/bundled command is acceptable for the internal demo.
- Support and physically validate Claude Code and Codex on explicitly documented surfaces/versions. Do not promise arbitrary desktop-session takeover or untested adapters.
- Preserve all existing authority, receipt, deduplication, and unknown-outcome safeguards.

## Mandatory agent-team organization

Use a lead plus up to three concurrent specialists, in dependency-aware waves. Use isolated worktrees where possible, or explicit non-overlapping file ownership. The lead owns shared contracts, integration, manifests/lockfiles, secrets, deployment, and live handoff.

Wave A: transport/storage extraction; Mac/gateway/media migration; connector feasibility/contracts.

Wave B: attention/pairing backend; voice/CUA arbitration; CLI/skills and Claude Code/Codex adapters.

Wave C: end-to-end/failure testing; installer/onboarding/README; independent security/recovery review.

Each specialist reports files changed, verification, remaining gaps, and integration dependencies. Do not let specialists independently change live routing, enable traffic, or deploy competing versions. Resolve contract changes centrally.

## Test number and existing services

The user wants to reuse the **Liam Davis** number for testing. Resolve its exact private provider and logical-line identity; do not guess or commit the phone number.

Apple Teams and ClawdTime must not concurrently own, poll, dispatch, or answer on that line. Complete independent work first. Then follow `LINE_HANDOFF.md`: inspect current ownership/cursors/calls/jobs; use an idle window; drain/pause the source owner; establish a non-replaying event boundary; allowlist the tester; enable ClawdTime; verify; retain or roll back ownership with event reconciliation.

Do not discard unknown outcomes or restore an old cursor blindly. Preserve Apple Teams data and receipts. Do not silently deploy ClawdTime over Apple Teams or modify/deploy sibling `chert-facetime`.

The implementation plan is approved: continue within it without asking for permission at every routine step. If the current line has conflicting activity/ownership, an upstream change is required, or a new paid commitment is needed, finish independent work and surface the specific issue rather than assuming authorization or stopping prematurely.

## README requirements

Include tags: AI agents, FaceTime, iMessage, human-in-the-loop, computer use, CUA, MCP, Claude Code, Codex, macOS, remote work.

Use the motivation draft in the plan: wanting to work on the go while agents get stuck on coding, email, video, marketing, CUA, or watcher/scheduler tasks. Explain how calling the human with a visible screen unblocks work while preserving existing tools.

Document setup, Mode 1 as the launch workflow, Mode 2 as planned, the feature list, actual client compatibility, permissions/Stop, local development, and migration provenance. Distinguish implemented, physically verified, and planned capabilities. Do not advertise future use cases as supported integrations.

## Definition of done

Complete relevant TypeScript/Python/Swift checks, browser onboarding checks, real Claude Code and Codex integration checks, and the physical call/screen/response/CUA/continuation/result demo. Exercise replay, timeout, unanswered call, wrong session, revocation, lock/sleep, stale frames, disconnect, and restart. Verify line rollback.

Record source/deployment/installation versions, what was physically observed, request-to-ring and response-to-continuation timings, and remaining gaps in `docs/STATUS.md`. Do not claim old Apple Teams test counts as ClawdTime coverage or blocked hosted CI as passed.

Internal demo packaging may be locally signed with limitations disclosed; external downloads require distribution signing/notarization and clean-install verification. Keep secrets and real customer/screen data out of Git and logs.

Persist through implementation and integration. If an external credential, signing entitlement, real-device action, or unsupported client capability blocks full acceptance, complete everything else, state the exact blocker and next action, and leave a runnable, documented project. Do not claim the demo is ready until the required live path is actually verified.
