# ClawdTime: approved implementation and migration plan

Prepared November 11, 2026, America/New_York.

## Status and authority

The user approved this plan. This handoff session creates the directory and planning documents only; it does not implement the application, install a helper, create hosting, or change live traffic. The next coding session should context itself and execute the plan using agent teams.

- New project: `/Users/garygao/clawdtime`.
- Source project: `/Users/garygao/apple-teams`.
- Audited source baseline: `be47b11fe1317c4747db4121bec37896998b5201` on `main`.
- Source remote: `https://github.com/cherthq/apple-teams.git`.
- Apple Teams was clean at handoff. Preserve any subsequent changes and active worktrees.
- The new directory initially contains this plan and `SESSION_PROMPT.md`. No new Git repository, remote, package publication, services, or runtime state has been created by this handoff.
- Read applicable parent instructions and create project-specific `AGENTS.md` during implementation. `/Users/garygao/AGENTS.md` references `orangeslice-docs/AGENTS.md`; those service instructions apply when those services are used, not as a reason to introduce unrelated dependencies.
- The user's approval covers the agreed implementation scope. Do not repeatedly ask for authorization already given. Separate that authorization from prerequisites that still need evidence: exact line identity, an idle handoff window, supported agent APIs, signing credentials, and any genuinely new scope or paid commitment.

## Product decision

**ClawdTime — your agent can FaceTime you.**

ClawdTime connects an existing agent to its human through iMessage and FaceTime. The agent works in its usual environment, calls when it needs help or has something to show, displays the relevant screen, receives spoken or text feedback, and continues. Human-directed computer use is part of the first demo.

Apple Teams remains the group-first product: group conversations, shared context, scheduling, notes, and group calls. ClawdTime is a separate product and codebase for agent-to-human attention, visual oversight, and remote intervention. Group workflows can be introduced later without forcing them into the first coding demo.

The user specifically requested that a human can direct the agent to act through CUA as a default capability. Interpret that as available during an authorized session after explicit pairing and macOS permissions, without a confirmation-code ritual for every ordinary click/type/scroll request. It does not mean silently granting Accessibility, permanently capturing the screen, overriding local Stop, or bypassing the connected agent's permission policy.

### Why this exists

The user's motivation: wanting to keep working on the go while agents get stuck on coding, sending emails, editing videos, marketing, and other automation—especially work requiring computer use or schedulers/watchers. ClawdTime should let the agent bring the work to the human, obtain the needed input, and continue in the existing tools.

Those examples describe the long-term product. The first release must distinguish its verified coding workflow from future integrations and use cases.

## Approved onboarding and modes

### One-time setup

1. Text the ClawdTime test number.
2. Receive a private installation/pairing link. Install the Mac companion, grant Screen Recording, and grant Accessibility for CUA. Select the intended display and explicitly enable the paired session behavior.
3. Run one command to connect Claude Code or Codex. It installs/configures the appropriate skill and tool, binds the agent/project/session to the paired Mac and messaging identity, and checks readiness.

Target command UX: `npx clawdtime connect`. This is a proposed command, not an assertion that the package exists or is available to publish. Verify package ownership and distribution. Use a bundled command or pinned local build for the internal demo if publication is not available. Never install an unrelated package with that name by assumption.

Setup is **install once, then use existing tools**, not zero-install. The user does not move their normal coding workflow into a new editor. Local companion setup is still necessary.

### Mode 1: agent initiates the call — launch scope

- Keep working in Claude Code or Codex as usual.
- A ClawdTime skill/tool lets the agent request attention for a blocker, a decision, an approval request, or a completed result.
- ClawdTime calls the paired person and shows the associated screen.
- The person speaks or texts an instruction, or directs CUA while watching.
- The instruction returns to the exact task/session, and the agent continues when permitted.
- A concise result and relevant artifact/link return to the same Messages conversation.

Demo story: **“My coding agent FaceTimed me because it needed me.”**

Do not claim that installing a skill automatically detects every blocked process or intercepts every native approval. Begin with explicit agent tool invocation and supported hooks; verify each supported client/version.

### Mode 2: human starts work in Messages — next phase

- Text “fix the login bug” or “show me my screen.”
- ClawdTime starts or resumes work through the paired agent and offers FaceTime oversight.
- Cloud-computer fallback is a later subsystem, not an existing MVP capability.

Basic session feedback and CUA over Messages are MVP. General initiation of arbitrary coding tasks from Messages is Mode 2 and must not creep into the first release.

### Subsequent use cases

- Coding: blockers, decision points, pre-push review, finished UI walkthroughs.
- Marketing: visual review of a video edit or social post before publication.
- Reports/articles: layout and content review before release.
- Browsing/buying: review a cart before a specifically authorized checkout.
- Schedulers/watchers: bring an event requiring attention to the human.
- Groups: later, work with Apple Teams-style group conversations and group FaceTime.

Do not advertise email sending, video editing, checkout, watchers, or group screen control as implemented merely because the underlying computer-control primitives exist.

## Existing evidence and gaps

These are dated observations from Apple Teams, not a fresh health check of ClawdTime.

| Capability | Existing evidence | What ClawdTime must add or verify |
| --- | --- | --- |
| Outbound FaceTime | Implemented for requested and scheduled calls; requesting a screen can already ring the user | External-agent attention trigger and exact session continuation |
| FaceTime screen display | Enrolled Mac helper → authenticated gateway → media video path | Rebrand, migrate, pair reliably, bind each request to the correct screen |
| CUA | Bounded typing/click/scroll code; explicit typing physically observed | Physical click/scroll and natural-language control qualification; agent/CUA arbitration |
| AI computer action | Single-action planning and direct-text authorization implemented and pilot enabled | Reliable voice/text routing into that path and end-to-end acceptance |
| Voice | Transcription, meeting controls, recaps, reviewed spoken scheduling | Bound human feedback to a waiting coding task and controlled CUA dispatch |
| Coding-agent connectors | No `facetime_me` or `npx chert connect` implementation established in this repo | Build CLI, pairing, skills/tools, supported hooks, durable result delivery |
| Shared number | Current workspace is resolved from its dedicated authenticated line | Use one owner at a time for the internal test; public multi-tenant pooling deferred |
| Runtime | Single-node SQLite pilot, durable jobs and conservative unknown outcomes | Preserve these properties; do not claim horizontal scalability |
| Mac installation | Local Swift helper with permission setup and Stop controls | Independent identity/config; distribution signing/notarization for external testing |
| Cloud computers | Not implemented | Deferred |
| Billing/quotas/referrals | Proposed in earlier brainstorming, not established | Deferred |

Earlier live inspection on November 11 found: backend view/control/video/AI-task gates enabled; media healthy with gateway connected; one local Mac/display registered; Screen Recording and Accessibility granted; helper locally disarmed; no active calls. Tailscale was running, but the configured helper used loopback and the gateway used outbound WSS. Recheck everything before a live test.

The recorded source validation was 546 tests across 51 files, TypeScript/build and formatting passing. Those are Apple Teams results, not ClawdTime results. GitHub Actions was blocked before execution by account billing/spending restrictions; do not label those runs passed.

### Current transport and device boundaries to retain

- The helper listens only on loopback or an explicitly allowed Tailscale address, never a public/wildcard address.
- Preferred deployment is local helper plus outbound authenticated gateway WSS to media. Railway does not need tailnet enrollment. Tailscale remains optional for approved remote routing.
- Viewing and controlling a device are different permissions.
- Existing screen control is private/single-member, not group control.
- Device/call/member/display/mode-bound leases are short-lived. Current backend uses rolling 20-second leases with a maximum helper lease of 30 seconds.
- Inputs require a current frame. A submitted OS event is not proof the target application performed the intended action; observe afterward.
- Unknown inputs/calls are reconciled using existing identifiers, never blindly replayed with new keys.
- Local Stop, lock, sleep, revocation, or terminal session loss stop sharing. Reconnect must not silently revive a revoked selection.
- Screen frames and typed content are transient, not copied into logs or migration artifacts.

The background companion may remain connected and ready for requests. That is distinct from capturing or controlling the screen. A session may start sharing under explicit prior pairing/session authorization; do not turn the last observed `armed:false` into a blanket request to silently rearm it.

## Phase 1 — independent project foundation

1. Initialize Git in `/Users/garygao/clawdtime`, with `main` and a `codex/` implementation branch. Preserve these planning files.
2. Record the source baseline and a migration manifest of copied files and modifications.
3. Retain the established TypeScript, Python, and Swift stack initially. This is extraction/adaptation of an established system, not a framework rewrite. Optional eve compatibility in the source is not a reason to make eve a new MVP dependency.
4. Create project-specific `AGENTS.md`, `.gitignore`, config examples, local simulation commands, test commands, and build scripts.
5. Use independent database paths, secrets, ports, service names, app identifiers, local storage directories, and deployment volumes. Configure live traffic off by default.
6. Initialize a local repository only as the starting point. Do not assume a GitHub organization, npm namespace, domain purchase, or hosting plan has already been created. Document any external setup still needed.

Proposed structure (adjust only when implementation evidence makes a simpler layout preferable):

```text
clawdtime/
  README.md
  AGENTS.md
  IMPLEMENTATION_PLAN.md
  SESSION_PROMPT.md
  docs/
    ARCHITECTURE.md
    MIGRATION.md
    DEMO_ACCEPTANCE.md
    LINE_HANDOFF.md
    STATUS.md
  src/
    pairing/
    sessions/
    attention/
    transport/
    control/
  connectors/
    shared/
    claude-code/
    codex/
  cli/
  skills/
  media/
  gateway/
  mac/
  public/
  tests/
```

## Phase 2 — selective migration

| Apple Teams source | Retain/adapt | Boundary |
| --- | --- | --- |
| `src/chert/` | Messaging, outbound calls, authenticated callbacks, native result reconciliation | Introduce ClawdTime ownership/session interfaces; do not duplicate active ownership of the live line |
| `media/` | Media bridge, speech/transcription, screen video, captions/status scenes, cleanup | Independent service/config and retained outcome semantics |
| `gateway/` | Outbound WSS, helper routing, lease lifecycle, action receipts | New installation/config namespace; no unrelated Chert changes |
| `devices/` | Swift capture, input, permission UI, indicator, local Stop | Rebrand into `mac/`; new bundle identity may require fresh macOS grants |
| `src/devices.ts`, `src/device-tasks.ts` | Screen selection, CUA, fresh-frame validation, single-action vision planning | Extract the domain dependencies; preserve deterministic authorization |
| `src/store.ts`, `src/security.ts`, worker/receipt patterns | Transactions, durable jobs, encryption, deduplication | Build a smaller ClawdTime domain instead of importing the entire workspace engine |
| `src/agent-model.ts`, relevant brain/turn code | Only model/provider and narration/planning pieces actually needed | Keep coding execution in the connected agent; no accidental provider/model migration |
| `scripts/readiness.ts`, monitoring/backup/recovery | Operational verification and recovery | Adapt paths and services; do not overwrite installed Apple Teams agents |
| Matching tests in `tests/`, `media/`, `gateway/`, `devices/` | Permission, isolation, replay, failure, call, and device contracts | Port relevant assertions; do not claim source test counts as new-project coverage |

Do not wholesale copy `.data`, `.env`, databases, provider grants, session tokens, recovery copies, customer history, native receipt ledgers, build products, `node_modules`, or installed helper configuration. Migrate code, not production customer state.

Leave Google Calendar, team management, group enrollment/scheduling, GitHub/Linear/Notion business tools, and the full context dashboard in Apple Teams. If a desired module imports those components, extract the small shared interface rather than importing the whole dependency chain.

Preserve required licensing/provenance. Do not perform a blanket search-and-replace across retained protocol fields or receipt IDs; identifiers with operational meaning require explicit migration decisions.

## Phase 3 — shared contracts and connectors

Define typed shared contracts before parallel implementation:

- `Pairing`: verified messaging identity, device identity, scoped credentials, revocation.
- `AgentSession`: adapter type/version, project, session identity, local host, capabilities.
- `AttentionRequest`: stable request ID, originating session/task, reason, question, recipient, deadline, intended screen.
- `CallSession`: request binding, call outcome, media authorization, active participant checks.
- `HumanResponse`: request ID, response identity/channel, sequence, interpretation and delivery acknowledgment.
- `ControlLease`: active call/device/display/member, mode, freshness, expiry, ownership.

Use an explicit durable state machine. Example attention progression:

`requested → queued → ringing → connected → awaiting_input → response_delivered → resumed/completed`

Represent declined, unanswered, canceled, expired, disconnected, failed, and unknown outcomes separately. Never treat timeout or silence as approval. Delivery acknowledgment and actual agent continuation are different facts.

### Pairing/CLI

- Pairing tokens must be expiring, one-use, and bound to the intended verified messaging identity and device.
- Verify possession through the authenticated messaging flow; a supplied phone number is not authentication.
- Store local secrets in an appropriate protected store/file. Never place long-lived credentials in a command printed in chat or shell history.
- Detect supported agent clients and versions, preserve existing configuration, explain needed restart/reload, and provide `doctor` and disconnect/uninstall behavior.
- Install a scoped skill/tool plus supported hooks where useful. Do not silently relax global sandbox/approval policies.
- Prevent a nearby unrelated project/session from stealing an attention response.

### Agent tools and continuation

Proposed API names such as `request_attention`, `attention_status`, and `attention_result` are design placeholders to finalize, not existing upstream methods.

- First prove a cooperative explicit tool call inside a real Claude Code or Codex session.
- A skill teaches the agent when to call; supported lifecycle hooks can cover native approvals/completion later within the MVP where verified.
- Do not rely on an indefinitely blocked MCP invocation. Use durable requests with bounded waiting, async completion, or supported polling appropriate to each tested client.
- A tool timeout/reconnect must not start a new call or lose a committed human answer.
- For Codex, investigate supported MCP and App Server mechanisms. The existence of thread resume/steer APIs does not prove arbitrary takeover of an already-open desktop session.
- For Claude Code, verify MCP/hook/permission semantics against the installed client. Different surfaces may have different tool lifetimes and approval constraints.
- Do not emulate continuation by indiscriminately typing into whichever terminal is focused.
- Preserve native agent permissions. A spoken statement must not silently become a blanket permission bypass.
- Explicitly document which CLI/desktop surfaces and versions are supported. Do not advertise untested Cursor/OpenClaw compatibility.

Primary references consulted during planning; recheck exact APIs before implementation:

- https://learn.chatgpt.com/docs/app-server
- https://code.claude.com/docs/en/mcp
- https://code.claude.com/docs/en/hooks

## Phase 4 — voice, CUA, and control ownership

### Spoken and text feedback

Deliver a human response to the exact pending attention request. Distinguish a conversational correction, a CUA request, an answer to a question, and an approval of a specific operation.

Only use the remote participant's qualified audio path for instructions. Avoid interpreting agent TTS, echo, recorded content, screen text, or incidental speech as new authorization. Display/acknowledge what was heard; ask a short clarification when ambiguous. Text remains a fallback when audio is unclear.

A private call and a paired endpoint provide session context; they do not establish biometric speaker identity. For sensitive native approvals, use the supported approval mechanism and exact pending operation, with authenticated text confirmation when necessary. Do not expand this into administrative voice commands or group voice authorization.

### CUA as a first-class MVP capability

- Include direct human requests to click, type, scroll, and perform a single AI-directed screen action.
- After explicit pairing/permission/session opt-in, routine requests do not need repeated confirmation codes.
- Preserve fresh-frame binding, bounded action shapes, member/device/call checks, and post-action observation.
- Never claim an OS-submitted receipt proves the UI changed correctly.
- Finish physical typing, click, scroll, and AI-action acceptance on a disposable fixture.
- Add voice-to-CUA only through the same deterministic authorization and receipt path as text-to-CUA.

### Agent/CUA arbitration

Both the connected agent and the human-directed controller may act on the same computer. Introduce explicit ownership so they cannot race the UI or continue against an obsolete state.

1. Request/pause coordinated agent activity before a conflicting CUA action.
2. Acquire control of the intended display/session.
3. Observe a fresh frame, execute the bounded request, and verify the new state.
4. Release control and deliver the result/context before the coding agent resumes.

If an adapter cannot establish that coordination, refuse the conflicting action with a useful explanation; do not assume the screen is idle.

### Companion readiness

Keep the connector/gateway ready in the background after pairing. Screen capture/control stays gated by explicit local permissions and session authorization. Retain visible sharing/control indicators and a local kill switch. Lock, sleep, Stop, or revoked pairing must invalidate active control; resuming the app must not revive stopped leases.

## Phase 5 — reuse the Liam Davis test number

The user explicitly requested the same Liam Davis number for testing. The previous session did not verify which private provider identity that label denotes. **Do not guess the number or equate a display name with a line binding.** Resolve the exact identity through existing private operator configuration and read-only provider evidence.

One application owns the line at a time. Do not start an independent ClawdTime poller/dispatcher while Apple Teams still processes that line.

### Preflight

- Record the exact native and logical line binding, current application owner/routing, current cursor/anchor, active calls, pending jobs, and unknown outcomes privately.
- Complete local/simulated migration and connector checks first.
- Keep ClawdTime live traffic off until the handoff prerequisites are satisfied.
- Prepare rollback with the exact previous configuration and event-boundary treatment. Preserve all Apple Teams ledgers.

### Handoff

1. Use an idle test window; do not interrupt an active call or abandon unresolved native actions.
2. Drain and pause Apple Teams ownership of this specific line.
3. Establish a safe ClawdTime event baseline so historical messages cannot become new commands.
4. Provision a fresh ClawdTime test account bound to the verified line and allowlisted tester.
5. Enable ClawdTime and conduct the supervised demo.
6. Either retain ClawdTime ownership or restore Apple Teams according to the agreed testing outcome.

This temporarily pauses Apple Teams use of the selected line. If that is no longer acceptable due to current activity/ownership, complete all independent work and ask only about that concrete handoff conflict.

### Rollback

- Disable ClawdTime dispatch and confirm call/media/device cleanup.
- Preserve uncertain outcomes and action receipts; do not erase state to force retries.
- Reconcile events received during the handoff interval before restoring Apple Teams. Restoring a stale cursor alone risks replaying already-handled messages.
- Restore only the approved line routing/configuration and verify a healthy integration heartbeat without generating unsolicited customer effects.

Do not copy production customer data to make handoff convenient. Reuse only explicitly needed transport access through protected configuration, and generate fresh application encryption/authentication secrets. No additional number is required for the internal MVP.

Do not edit or deploy sibling `chert-facetime` under this plan. The integration should use existing supported APIs. If implementation discovers a missing upstream capability, document it and request scope expansion rather than modifying the sibling silently.

## Phase 6 — implement with agent teams

**Mandatory execution instruction:** use a coordinating lead agent and parallel specialist agents. The user explicitly requested agent teams. Do not execute the entire project as a single undifferentiated coding task.

The lead must define shared contracts, dependencies, acceptance gates, and file ownership before parallel implementation. Use isolated worktrees/branches where possible; otherwise assign non-overlapping directories and avoid concurrent edits to shared manifests. The lead owns integration, dependency/lockfile changes, live secrets, deployment, and test-line handoff. Specialists may not independently enable traffic or change provider routing.

For four available concurrency slots, use one lead and three specialists in waves:

| Wave | Specialist A | Specialist B | Specialist C |
| --- | --- | --- | --- |
| A: foundations | Transport, storage, and receipt extraction | Mac helper, gateway, and media migration | Claude/Codex compatibility spikes and shared connector contracts |
| B: demo implementation | Attention/session backend and pairing APIs | Voice routing, screen readiness, CUA arbitration | Pairing CLI, skills/tools, and both agent adapters |
| C: acceptance/release | End-to-end and failure tests | Installer/onboarding, README, operational documentation | Independent authorization, isolation, recovery, and migration review |

Adapt the wave assignments to available concurrency without reducing the requirement for delegated implementation and independent review. Avoid having multiple agents own the same cross-cutting file. Each agent returns changed files, validation performed, remaining gaps, and integration notes.

### Suggested dependency order

1. Inventory source; establish the new repo and migration manifest.
2. Define contracts and run connector feasibility spikes.
3. Port transport/media/helper primitives and relevant tests in parallel.
4. Implement pairing, attention lifecycle, and one adapter end-to-end.
5. Add the second adapter, feedback routing, and CUA ownership.
6. Finish installation UX and independent review.
7. Validate locally and in isolated deployment with traffic off.
8. Perform the controlled live-line handoff and physical demo acceptance.
9. Record exact release evidence and leave a reproducible handoff.

Do not hide a failed feasibility spike behind a mock. If a supported agent surface cannot resume the intended session, state the precise limitation and propose the smallest supported alternative without changing the product silently.

## Phase 7 — demo acceptance and release

### Functional acceptance

- A fresh intended tester can install, grant permissions, pair, and connect without manually editing private JSON/configuration files.
- A real Claude Code task invokes ClawdTime, rings the intended tester, shows the correct screen, receives feedback, and continues in the correct session.
- The same essential loop succeeds in Codex on a documented supported surface/version.
- Spoken feedback reaches the exact pending request; text fallback works.
- Human-directed typing, clicking, scrolling, and one AI-directed action visibly succeed on a disposable demo app.
- The external agent and CUA do not simultaneously act on a conflicting screen/task.
- Completion is sent to the correct Messages conversation with factual results.
- Viewing/control ends on call termination and local Stop; access remains off after revocation.

### Failure and isolation acceptance

- Duplicate events/tool calls cannot produce duplicate calls, replies, or input actions.
- No answer/decline/timeout does not approve work or trigger blind redial.
- A wrong member/device/project/session cannot obtain the screen or response.
- A resumed agent cannot consume another session's answer.
- Provider/model timeout, lost gateway, helper lock/sleep, lost media, stale frames, and reconnect behave conservatively.
- Restart after a committed effect reports/reconciles its receipt without replaying it.
- Echo/agent TTS and unrelated speech do not become executable human commands.
- Expired/reused pairing links are rejected.
- The line handoff and rollback preserve event ownership and unknown-outcome records.

### Test and evidence expectations

- Run TypeScript checks/build and relevant behavior tests for migrated/new code.
- Run Python media/gateway suites and Swift helper tests/build where relevant.
- Perform browser checks of installation/pairing pages.
- Run real agent integration tests against installed, recorded versions.
- Qualify on actual handsets/Macs; mocks are not call delivery or physical UI evidence.
- Retain only consented demonstration recordings and sanitized logs. Do not commit secrets, personal conversations, screens, or real phone numbers.
- Record source commit, deployment IDs, installed helper/connector versions, checks, and remaining gaps in `docs/STATUS.md`.
- Measure request-to-ring, answer-to-visible-screen, and human-response-to-continuation. Treat sub-minute goals as targets until measured.

Internal demo packaging may be locally signed with its limitations documented. External download testing requires distribution signing/notarization and a clean installation check; lack of credentials must be reported, not presented as a completed public installer.

Separate ClawdTime backend/media services and volumes should start in standby. Do not deploy ClawdTime over Apple Teams. No new paid hosting plan, domain, package namespace, or external account is implied to exist already; surface a concrete prerequisite if required.

## README requirements and proposed content

Create an actual `README.md` during implementation. Keep it honest about status; describe the target product while explicitly distinguishing built, verified, and planned features.

### Title and tags

```markdown
# ClawdTime

Your agent can FaceTime you.

**Tags:** AI agents · FaceTime · iMessage · human-in-the-loop · computer use · CUA · MCP · Claude Code · Codex · macOS · remote work
```

These are README tags. GitHub topics can be added if/when a remote repository is created; do not imply that was already done.

### Overview / motivation draft

> I wanted to keep working while away from my desk, but my agents kept getting stuck: a coding decision, an email that needed review, a video edit, a marketing task, or an automation that needed someone to look at the screen.
>
> ClawdTime connects those agents to you through iMessage and FaceTime. Your agent calls when it needs attention, shows its screen, and receives your response. You can also direct computer actions while watching, then let the agent continue in the tools you already use.

### Setup section

Explain: text the number → install/pair the Mac companion and grant screen/control permissions → run the supported connection command for Claude Code or Codex. Include actual tested commands when implemented, a readiness check, disconnect/uninstall, and macOS/client requirements.

### Two modes section

Lead with Mode 1: use the agent normally; it calls for a blocker/decision/review/result; respond by voice/text or direct CUA; it continues; receive a result in Messages.

Document Mode 2 as planned until implemented: start work from Messages and hand it to the paired agent. Mark cloud fallback as future.

### Feature list

- Agent-initiated private FaceTime attention requests.
- Screen viewing from the paired Mac.
- Spoken and text feedback tied to the correct agent task.
- Human-directed CUA: click, type, scroll, and bounded AI-directed screen actions.
- Claude Code and Codex skills/tools, with tested surface/version compatibility.
- Durable request, response, and action receipts.
- Visible control state, local Stop, revocation, and disconnect.
- iMessage completion recaps/results.

Label each feature according to actual evidence. Add future use cases for marketing, reports/articles, browsing/buying, watchers/schedulers, and groups without asserting those integrations are finished.

### Additional README sections

- What this solves and who the initial demo is for.
- How the components connect, including optional—not required—Tailscale.
- Privacy/data flow, screen and audio handling, and permission requirements.
- Development, simulation, tests, and build/package instructions.
- Source provenance and migration links.
- Current limitations and planned work.

## Explicitly deferred from this MVP

- General Mode 2 task initiation from Messages.
- A cloud computer per new visitor and zero-install public onboarding.
- Public multi-tenant shared-line pooling or horizontal backend scaling.
- Arbitrary multi-step autonomous CUA implemented by ClawdTime itself. The connected coding agent can continue its own work; this does not turn the existing single-action CUA planner into an autonomous loop.
- Cursor/OpenClaw and other untested adapters.
- Group screen control, group voice authorization, and group FaceTime expansion.
- Email/video/marketing/checkout integrations beyond what a specifically connected agent actually supports.
- General-purpose scheduler/watcher product features.
- Pricing, free-minute quotas, referrals, payments, and subscription enforcement.

## Completion deliverables

1. Independent, usable local ClawdTime repository with provenance and project instructions.
2. Real README with tags, motivation, setup, both modes, features, and honest status.
3. Selectively migrated calling/media/gateway/helper/control components with retained regression coverage.
4. Working pairing CLI and documented Claude Code/Codex integrations.
5. A demonstrated Mode 1 call → screen → human response/CUA → continuation → Messages result loop.
6. A verified, reversible handoff of the specifically identified test line, if the live prerequisites are available.
7. Recorded tests, physical acceptance, deployment/installation evidence, rollback instructions, and explicit remaining blockers.

If the live line, signing, agent-client, account, or physical testing prerequisite is unavailable, complete all independent implementation and validation, explain exactly what remains, and do not claim the full live demo is ready.
