# ClawdTime: fastest coding demo

Prepared November 18, 2026. Product direction: [README](../README.md).

**Build on the current ClawdTime. Start with one coding worker, one project, and one complete task-to-call-to-result flow.** This is an implementation plan, not a completed release or authorization to place calls.

**Polish is a requirement for the first demo.** Reuse the core transport, execution and safety logic, while substantially redesigning the desktop and call experience. Rebuild the conversational layer around ClawdTime as the independent agent. A connected call with working tools is not enough: the experience must feel prepared, clear and natural.

## 1. The demo

Tell ClawdTime a coding job → it delegates to Codex → the watcher detects a decision point → it prepares a walkthrough → FaceTimes you and zooms in → you give one spoken instruction → Codex continues → ClawdTime verifies the result and calls for final review.

Use a small local web app. Example: “Add a filter to this task list.” The worker implements the feature, then encounters an unresolved product choice: what should appear when no tasks match? ClawdTime shows the relevant code and preview, asks the question, receives “Show an empty state with a Clear filters button,” and sends that instruction back to the same task. It runs the agreed checks and presents the finished behavior.

A failing test is another valid trigger when the worker cannot resolve it within a bounded repair attempt. Ordinary failures should first go back to the worker; they should not all cause phone calls. Any deliberately seeded demo issue must be identified as a fixture, not portrayed as a production incident.

**Minimum scope:** one paired Mac and phone, one explicitly selected project, one Codex worker, desktop chat and text task submission, a blocker call, and a final review call. No dependence on this Codex chat staying open.

## 2. What we can reuse

The inspected working baseline is `ArgosClawd` at `815d51b82aa81e62e857b08713a9d0b4324a5a6f`. Before this documentation update, `main` was at `bf8f18e`, 40 commits behind that baseline. Publishing this plan does **not** merge those implementation commits.

At implementation start, review and integrate the required changes and dependencies from that baseline into `main`. Preserve other branches and uncommitted drafts. The paths below refer to that baseline; some do not yet exist on `main`.

| Existing piece | Reuse | Still needed |
| --- | --- | --- |
| Chert transport and attention service: `src/transport/`, `src/attention/service.ts` | Calling, messaging, call lifecycle, deduplication and receipts. | Bind automatic escalations and review calls to independent tasks. |
| Job broker and conversation router: `src/attention/jobs.ts`, `src/control/job-conversation.ts` | Submit, status, revise and cancel; task identity and execution results. | A persistent task plan, worker supervision, decisions and review lifecycle. Existing instructions are transient; restart currently can require clarification or mark execution unknown. |
| Codex executor: `connectors/codex/runner.ts`, `connectors/shared/executor-worker.ts` | API-managed execution, project allowlist, worker events and receipt ledger. | App-owned background lifecycle, richer coding/test results and continuation after a decision. Existing verification is primarily a bounded file-content check. |
| Presentation: `connectors/shared/presentation-scenes.ts`, `src/control/camera.ts`, `src/control/native-activation.ts` | Scene primitives, target binding, camera zooms and window activation. | Redesign openings, scene composition, transitions and narration; prepare scenes automatically and make real-app presentation reliable. |
| Mac, gateway and media: `mac/`, `gateway/`, `media/` | Screen capture, media routing, permissions and local Stop. | Integrate the new task UI and qualify the complete phone experience. |
| Voice: `media/elevenlabs_frontend.py`, `media/voice_interaction.py` | Audited audio transport and provider adapters where useful. | Rebuild the conversational model integration, context, tools, turn-taking and progress delivery for the independent agent. Replace the original-chat relay behavior; qualify audio components individually before retaining them. |
| Pairing and connector tools: `src/pairing/`, `cli/`, `connectors/shared/mcp.ts` | Identity, scoped access, readiness and optional agent escalation. | Guided app setup later; verify how the proposed OTP flow fits existing pairing. |

These are reusable components, not evidence that the new demo already works. The latest recorded call lasted about seven minutes, but the walkthrough stopped on an unclassified camera rejection. Window selection was subsequently demonstrated locally; the full live walkthrough and smooth duplex audio remain unqualified. The diagnostic repair preserves rejection reasons; it did not establish or fix the historical cause.

Source evidence: [baseline tree](https://github.com/cherthq/clawdtime/tree/815d51b82aa81e62e857b08713a9d0b4324a5a6f), [production status](https://github.com/cherthq/clawdtime/blob/815d51b82aa81e62e857b08713a9d0b4324a5a6f/docs/STATUS.md), and [managed-execution evidence](https://github.com/cherthq/clawdtime/blob/815d51b82aa81e62e857b08713a9d0b4324a5a6f/docs/CONVERSATIONAL_CONTROL_RELEASE.md).

## 3. What we need to build, in order

| Step | Concrete work | Done when |
| --- | --- | --- |
| **1. Establish the baseline** | Integrate reviewed dependencies, run existing checks, choose the demo project and record installed worker versions. Keep live dispatch off. | One reproducible checkout contains the reusable pieces and passes its relevant checks. |
| **2. Own the task** | Extend the broker with task goal, plan, worker binding, decision, verification and review state. Run the local worker as an app-owned background process. Build a focused floating chat panel with clear task status, selectable questions and Stop; remove developer-facing setup and transport details from ordinary interactions. Route paired text messages into the same task service. | A desktop request and a text request can each start an authorized task without this chat. Closing the panel does not stop work. |
| **3. Watch the worker** | Consume structured worker events, test exit codes and bounded log excerpts. Detect failures, explicit questions, approval waits and stalled progress. Retry recoverable coding fixes within a limit; escalate unresolved decisions once. | A fixture decision produces one task-bound attention event; duplicate events do not create duplicate calls. Silence alone is not treated as failure. |
| **4. Prepare the walkthrough** | Build a short brief: what happened, relevant evidence, exact question/options and the intended code/preview scenes. Prepare a task-specific opening, open the target app, verify the exact window and rehearse scene transitions locally before dialing. Replace generic sharing announcements and startup slates with the prepared work view. | The problem and screen are ready before the call; after answer, fresh capture and zoom are verified before narration claims they are visible. No “begin” ritual or visible window hunting. |
| **5. Rebuild the conversation experience** | Build an independent-agent voice session with the task brief, current scene, pending decision and live worker events. Replace original-chat forwarding with task-bound tools and asynchronous progress delivery. Rework interruption, echo handling, silence behavior and playback scheduling together. | One spoken instruction changes the intended job once; the agent remains responsive while work runs, with intelligible speech, natural pauses and no repetitive presence checks. |
| **6. Verify and review** | Run a predefined test/build command and check the actual rendered behavior. Save concise result evidence, prepare completion scenes and request the final review call. | The user sees the verified result, can request a revision, and can explicitly accept it. Ending a call alone is not acceptance. |
| **7. Qualify the full flow and polish** | Run local integration checks, then an explicitly authorized physical rehearsal of both calls. Review the opening, scene transitions, interruptions, waiting periods and ending as well as correctness. Record the exact code/build and observed outcomes. | The complete story works on the phone and passes the experience criteria below. Choppy speech or an awkward setup sequence blocks demo acceptance. |

Suggested division during implementation: lead owns contracts, task orchestration and integration; connector specialist owns the Codex worker and event adapter; Mac specialist owns the panel, presentation and conversational-layer rebuild; transport specialist owns durable task records and attention delivery. Define shared interfaces before parallel work and retain existing file ownership.

## 4. Keep the architecture small

**Desktop chat / paired text → ClawdTime task engine and watcher → Codex worker.**

**Decision or verified result → walkthrough preparation → Chert FaceTime + presentation + voice → same task.**

- **Worker:** start with the existing Codex App Server adapter. Add Claude Code after this flow passes. Drive workers through supported APIs/CLIs and structured events, not clicks in their windows.
- **Reasoning model:** try Grok behind a replaceable task-engine model adapter. First verify credentials, provider compatibility and structured decision output in a local spike. Keep the existing supported model path available if that spike blocks the demo. The coding worker and voice provider are separate choices.
- **Computer use:** Agent-S remains the planned fallback for apps without suitable APIs or CLIs. It is not a dependency for this coding demo; existing presentation code handles zooms. Integrate Agent-S later through the same bounded control and verification rules.
- **Presentation:** reuse the Argos-inspired scene system already in ClawdTime. Avoid importing another complete runtime. Real application capture is required; the synthetic Argos editor is not acceptance evidence.
- **Conversation:** ClawdTime speaks as the agent responsible for the task. Its voice session uses the same authoritative task state as desktop chat and text. Rebuild the model context and tool loop rather than adding a new prompt to the original-chat bridge. Keep provider selection replaceable; changing models alone does not establish smooth audio.
- **Desktop UI:** keep the feature set small and finish the interactions carefully. Reuse the Mac companion and local UI infrastructure; redesign the user-facing copy, states and transitions. Defer mascot animation, extensive task history and public installer polish, not the quality of the demo's core flow.
- **Escalation integration:** keep the existing MCP/skill as an optional entry point. The independent task engine owns work started in ClawdTime.

## 5. The polished experience we are building

Use FaceTimeOS and Argos as references for direct interaction and focused walkthroughs. ClawdTime should feel like an agent calling with something ready to discuss. Their demos are experience references, not proof that our integration is qualified.

| Moment | Intended experience |
| --- | --- |
| **Before dialing** | Diagnose the issue, prepare the question and opening, arrange the relevant app, and check local presentation and voice readiness. All ordinary preparation happens before the phone rings. |
| **When answered** | Open on the relevant work as soon as live capture is verified. Say something useful: “The filter is working. I need your choice on what to show when nothing matches—here are the two options.” Remove ClawdTime-authored “ClawdTime is sharing screen” announcements, generic welcome scripts and routine setup cards. |
| **Walkthrough** | Show one relevant area at a time, with readable text, restrained highlights and smooth zooms. Match narration to the scene actually visible. Avoid desktop flashes, debug overlays, repeated recentering and unexplained window switches. |
| **Conversation** | Accept interruptions and corrections, answer questions about the current work, and continue naturally. No repeated “are you there?”, requests to say “begin,” or narration of internal tool calls. |
| **While work runs** | Acknowledge the instruction once, show meaningful progress and allow follow-up questions. Use brief updates when something changes; comfortable silence is allowed. Never fill every pause with chatter or claim unverified progress. |
| **Ending and review** | State the decision and next step, then end the call when appropriate. For final review, lead with the finished result and verification, ask for acceptance or revisions, and close clearly. |
| **If something fails** | Give a short, specific explanation and preserve the task. Use text or a clear recovery state when needed; never conceal a failure behind a polished animation or stale screen. |

Remove redundant product announcements, not permission or visibility protections. Keep macOS/FaceTime system indicators, consent flows, a clear sharing/control state and accessible local Stop. Platform-controlled UI is outside the scope of cosmetic removal.

### Rebuild the voice layer around the independent agent

The conversation model receives the task goal, verified progress, active decision, current presentation scene and recent dialogue. Its tools can inspect task status, submit a decision or revision, request a scene, stop sharing and end the call. The task engine validates each request and coordinates execution; conversational output is not execution authority.

Deliver worker events to the conversation asynchronously, so a long coding operation does not block a spoken status question. Bind every instruction and response to its task and revision, discard obsolete progress messages, and prevent duplicate execution. Native worker approvals still use their supported approval path.

Use one coordinated interruption/playback policy. Diagnose echo and overlapping cancellation paths, distinguish human interruptions from agent audio, and prevent competing speech queues from cutting each other off. Handle quiet periods intentionally. Preserve finalized human instructions even when speech playback is interrupted. Keep audio transient and measure timing with sanitized event metadata.

This is a conversation-runtime rebuild, not just a voice change or prompt rewrite. Retain existing audio plumbing only where it passes the new experience checks.

## 6. Task state and call rules

Use one task ID from submission through review:

`queued → running → needs_decision → walkthrough_ready → in_call → running → verifying → review_ready → accepted`

Also represent waiting for native approval, canceled, failed and unknown outcomes explicitly. Persist the worker/session reference, revisions, decisions, call receipts and verification results. Store only necessary task context securely; keep raw screens and audio transient. On restart, reconcile the original worker and receipts before continuing. Never turn an unresolved dispatch into an automatic rerun.

Prepare the brief and validate local targets before requesting a call. Revalidate live frames after connection. If preparation fails, report that state by text instead of dialing an unprepared walkthrough. An unanswered call leaves the task waiting for input; it does not authorize a decision or blind redial.

Viewing and controlling retain explicit pairing and session permission. Shared-screen input requires exclusive ownership, fresh frames and observed results. Voice cannot bypass native worker approvals. Local Stop ends sharing/control; hanging up can leave an authorized coding task running. Task cancellation is separate and must report whether the worker actually stopped.

## 7. Acceptance and later work

Before declaring the demo ready, verify:

- Both desktop and paired-text initiation reach the same task service; work continues without the original Codex chat.
- A real worker decision produces one prepared call, with the correct code or preview visibly shown and zoomed.
- One spoken instruction reaches the correct task once; audible responses remain conversational during worker activity.
- The worker resumes, meaningful tests and the rendered result pass, and a separate final review call obtains explicit acceptance or a revision.
- Duplicate events, missed calls, disconnects, worker restarts and unknown outcomes preserve task identity and do not replay external effects.
- Stop and cancellation work as described; rejected window/camera actions remain visible failures rather than claimed success.

**Polish is a release gate.** On the actual phone, verify a task-specific opening without generic sharing announcements or setup rituals; readable scenes with narration aligned to the view; sustained, intelligible speech without repeated clipping or false interruptions; natural interruption and recovery; a responsive status answer during coding; a quiet pause without a presence check; and a clear handoff and ending. Exercise both the blocker call and final review. Measure answer-to-useful-view, speech-to-response and interruption-to-playback-stop; record observed timings and failures rather than promising unmeasured speed. An audio or scene failure blocks acceptance even when backend checks pass.

Run `npm run check` and the affected Python/Swift checks after code changes. These checks are prerequisites; they do not replace handset acceptance. Keep services in simulation/standby until a specific live rehearsal is authorized. Only the lead handles secrets, deployment and live-line ownership.

Defer the public one-click installer and OTP onboarding polish, multiple simultaneous workers, Claude Code support, general Agent-S tasks, video editing, billing and broad model comparisons. Text task initiation stays in this demo; it is another entry point to the same bounded coding workflow.

**Fastest route: reuse the core logic, substantially redesign the user experience, rebuild conversation around the independent agent, and prove one polished coding job before broadening the product.**
