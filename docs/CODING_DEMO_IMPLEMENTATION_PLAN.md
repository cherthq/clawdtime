# ClawdTime: fastest coding demo

Prepared November 18, 2026. Product direction: [README](../README.md).

Updated after the approved branch audit: decisions happen between completed Codex runs; build the shared task contract first; start motion qualification at 15 fps on the handset.

**Build on the current ClawdTime. Start with one coding worker, one project, and one complete task-to-call-to-result flow.** This is an implementation plan, not a completed release or authorization to place calls.

**Polish is a requirement for the first demo.** Reuse the core transport, execution and safety logic, while substantially redesigning the desktop and call experience. Rebuild the conversational layer around ClawdTime as the independent agent. A connected call with working tools is not enough: the experience must feel prepared, clear and natural.

## 1. The demo

Tell ClawdTime a coding job → Codex runs to completion → the watcher verifies with tests/build → on failure or an unresolved decision, ClawdTime prepares a walkthrough and calls → your spoken instruction starts a new, scoped Codex run with the task context → the watcher re-verifies → ClawdTime calls for final review.

Use a small local web app. Example: “Add a filter to this task list.” Codex finishes its run and reports the work plus an unresolved product choice: what should appear when no tasks match? The watcher runs the agreed tests/build. ClawdTime prepares the relevant code and preview, calls, and receives “Show an empty state with a Clear filters button.” That answer starts a new run scoped to this change, carrying the original goal, current workspace, prior results and decision. After that run finishes, the watcher re-runs verification and ClawdTime presents the result.

Do not build mid-run approval or pause/resume for this demo. A run ends with a result, failure or explicit unresolved decision; a known terminal outcome is required before another run starts. A failed verification or unresolved decision triggers the prepared call. If both are clear, proceed directly to final review. Any deliberately seeded demo issue must be identified as a fixture, not portrayed as a production incident.

**Minimum scope:** one paired Mac and phone, one explicitly selected project, one Codex worker at a time, a simple desktop entry point, a decision/failure call, and a final review call. Include paired-text initiation if it appears in the demo. No dependence on this Codex chat staying open.

## 2. What we can reuse

The inspected working baseline is `ArgosClawd` at `815d51b82aa81e62e857b08713a9d0b4324a5a6f`. Before this documentation update, `main` was at `bf8f18e`, 40 commits behind that baseline. Publishing this plan does **not** merge those implementation commits.

The audit inspected `main` at `257348b` and the baseline above. **Selectively integrate ArgosClawd; do not merge the whole branch.** It contains 354 changed files relative to the common ancestor, and `f8a5a2a` bundles 163 files. Preserve other branches and uncommitted drafts. The paths below refer to that baseline; some do not yet exist on `main`.

| Existing piece | Reuse | Still needed |
| --- | --- | --- |
| Chert transport and attention service: `src/transport/`, `src/attention/service.ts` | Calling, messaging, call lifecycle, deduplication and receipts. | Bind automatic escalations and review calls to independent tasks. |
| Job broker and conversation router: `src/attention/jobs.ts`, `src/control/job-conversation.ts` | Submit, status, revise and cancel; task identity and execution results. | A persistent task plan, worker supervision, decisions and review lifecycle. Existing instructions are transient; restart currently can require clarification or mark execution unknown. |
| Codex executor: `connectors/codex/runner.ts`, `connectors/shared/executor-worker.ts` | API-managed execution, project allowlist, worker events and receipt ledger. | App-owned lifecycle, scoped sequential runs with task context, and independent tests/build verification. Existing verification is primarily a bounded file-content check; native approval requests are declined and execution interrupted. |
| Presentation: `connectors/shared/presentation-scenes.ts`, `src/control/camera.ts`, `src/control/native-activation.ts` | Scene primitives, target binding, camera zooms and window activation. | Redesign openings, scene composition, transitions and narration; prepare scenes automatically and make real-app presentation reliable. |
| Mac, gateway and media: `mac/`, `gateway/`, `media/` | Screen capture, media routing, permissions and local Stop. | Integrate the new task UI and qualify the complete phone experience. |
| Voice: `media/elevenlabs_frontend.py`, `media/voice_interaction.py` | Audited audio transport and provider adapters where useful. | Rebuild the conversational model integration, context, tools, turn-taking and progress delivery for the independent agent. Replace the original-chat relay behavior; qualify audio components individually before retaining them. |
| Pairing and connector tools: `src/pairing/`, `cli/`, `connectors/shared/mcp.ts` | Identity, scoped access, readiness and optional agent escalation. | Guided app setup later; verify how the proposed OTP flow fits existing pairing. |

Integrate these dependency groups with their shared contracts, routes, helper/gateway interfaces and regression tests:

- **Call reliability:** scoped fixes `4d980f5`, `f93d027` and regression coverage `7f1b687`.
- **Text and receipts:** relevant changes from `783be95` and `52eb2c5`; replace original-agent wording and routing.
- **Managed execution:** extract the broker, conversation router, remote runner, Codex adapter and worker from `f8a5a2a`; leave document/attachment and website features out.
- **Capture and presentation:** port the integrated capture lifecycle fixes and the `c7af884`/`89f7839` presentation foundation, with follow-ups `6c95170`, `e8a2935`, `c2dce09`, `1361a2a` and `4268918`. These are dependent changes, not an independent cherry-pick sequence.
- **Voice:** retain useful adapter/configuration/buffering mechanics from `3d7ef10` and its follow-ups; rebuild conversation, startup and interruption ownership. Keep experiment scripts and competing voice runtimes out of the production demo path.

**Contract gap to resolve first:** registration currently rejects managed conversation sessions combined with streaming voice, live presentation or native activation (`src/attention/service.ts`). Define an independent-task session contract that preserves authorization instead of removing these guards. The generic greeting also satisfies an audio-startup deadline (`media/server.py`); replace it with a prepared problem statement through the same voice path, rather than simply deleting it.

These are reusable components, not evidence that the new demo already works. The latest recorded call lasted about seven minutes, but the walkthrough stopped on an unclassified camera rejection. Window selection was subsequently demonstrated locally; the full live walkthrough and smooth duplex audio remain unqualified. The diagnostic repair preserves rejection reasons; it did not establish or fix the historical cause.

Source evidence: [baseline tree](https://github.com/cherthq/clawdtime/tree/815d51b82aa81e62e857b08713a9d0b4324a5a6f), [production status](https://github.com/cherthq/clawdtime/blob/815d51b82aa81e62e857b08713a9d0b4324a5a6f/docs/STATUS.md), and [managed-execution evidence](https://github.com/cherthq/clawdtime/blob/815d51b82aa81e62e857b08713a9d0b4324a5a6f/docs/CONVERSATIONAL_CONTROL_RELEASE.md).

## 3. What we need to build, in order

| Step | Concrete work | Runnable result at the end |
| --- | --- | --- |
| **a. One authoritative task state / session contract** | Integrate the necessary baseline dependencies. Define task, run, decision, verification and call identities; durable transitions; and permissions shared by execution, voice and presentation. | A local service and CLI can create a task, exercise its lifecycle with an explicitly simulated worker, reject duplicate/stale events, and reload task state after restart. No live dispatch. |
| **b. Task engine and watcher with Codex** | Run the existing adapter as an app-owned worker. Let each scoped run finish, independently run agreed tests/build, and prepare a failure/decision brief. A human decision creates a new run with bounded task context. | From the CLI, a real Codex run completes, verification produces a report, a typed decision starts exactly one follow-up run, and re-verification reaches review-ready. No original chat or phone required. |
| **c. Rebuilt voice on that contract** | Connect one streaming conversation session to the task service. Replace original-chat forwarding with task-bound tools/events; implement a prepared opening and coordinated interruption/playback. | A local audio session discusses the real task, receives a spoken instruction, starts one follow-up run and answers status while it works. Presentation tools are explicitly unavailable until step d. This is not handset acceptance. |
| **c.1. Live handset audio smoke test** | After step c, obtain specific authorization for one voice-only handset call through Chert. Keep screen capture, presentation and shared-screen control disabled. Check the prepared opening, two-way speech, interruption, a quiet pause, task-status dialogue and clean hangup. | Record handset-observed audio results and timings, with no repeated clipping, false interruptions or presence checks. Resolve blocking audio failures before starting step d. This smoke test does not replace the full acceptance checks in section 7. |
| **d. Presentation choreography** | Prepare real code/preview scenes and the opening before dialing. Verify exact windows, synchronize narration with visible scenes, and compose the final review from verified results. Start at the existing 15 fps camera output. | The CLI can run the complete prepared walkthrough locally with real app pixels. Then, under specific live authorization, the decision call and final review call work through Chert without setup talk or window hunting. |
| **e. Desktop entry point** | Add the focused floating panel over the same service: submit a job, answer selectable questions, see progress and Stop. Add paired-text initiation only if shown in the demo. | The complete two-call story starts from the desktop panel; closing it does not stop the task. The phone experience passes the measurable acceptance checks below. |

Keep every stage runnable before moving on. Implementer CLIs and diagnostics are development tools, never on-camera demo content. Verification, receipts, Stop and failure handling are part of each stage, not a final hardening phase.

Step c.1 is a required checkpoint before step d. Approval of this plan does not authorize the smoke-test call; obtain authorization for that specific call when ready. Do not automatically redial after a failed or uncertain attempt.

Suggested division during implementation: lead owns contracts, task orchestration and integration; connector specialist owns the Codex worker and event adapter; Mac specialist owns the panel, presentation and conversational-layer rebuild; transport specialist owns durable task records and attention delivery. Define shared interfaces before parallel work and retain existing file ownership.

## 4. Keep the architecture small

**Desktop chat / paired text → ClawdTime task engine and watcher → Codex worker.**

**Decision or verified result → walkthrough preparation → Chert FaceTime + presentation + voice → same task.**

- **Worker:** start with the existing Codex App Server adapter. Use one sequential, scoped run at a time. A spoken decision starts a new run with the task context; it does not resume an interrupted approval. Drive workers through supported APIs/CLIs and structured events, not clicks in their windows.
- **Reasoning model:** keep the model replaceable and use an already supported path for the demo. Grok evaluation or provider migration is later; the coding worker and voice provider are separate choices.
- **Computer use:** Agent-S remains the planned fallback for apps without suitable APIs or CLIs. It is not a dependency for this coding demo; existing presentation code handles zooms. Integrate Agent-S later through the same bounded control and verification rules.
- **Presentation:** reuse the Argos-inspired scene system already in ClawdTime. Avoid importing another complete runtime. Real application capture is required; the synthetic Argos editor is not acceptance evidence.
- **Conversation:** ClawdTime speaks as the agent responsible for the task. Its voice session uses the same authoritative task state as desktop chat and text. Rebuild the model context and tool loop rather than adding a new prompt to the original-chat bridge. Keep provider selection replaceable; changing models alone does not establish smooth audio.
- **Desktop UI:** keep the feature set small and finish the interactions carefully. Reuse the Mac companion and local UI infrastructure; redesign the user-facing copy, states and transitions. Defer mascot animation, extensive task history and public installer polish, not the quality of the demo's core flow.
- **Escalation integration:** preserve existing MCP/skill code, but defer a new public escalation interface. The independent task engine owns work started in ClawdTime.

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

Deliver worker events to the conversation asynchronously, so a long coding operation does not block a spoken status question. Bind every instruction and response to its task, run and revision, discard obsolete progress messages, and prevent duplicate execution. A spoken change received during an active run is held until its terminal outcome is known; it does not steer that run or approve a native operation.

Use one coordinated interruption/playback policy. Diagnose echo and overlapping cancellation paths, distinguish human interruptions from agent audio, and prevent competing speech queues from cutting each other off. Handle quiet periods intentionally. Preserve finalized human instructions even when speech playback is interrupted. Keep audio transient and measure timing with sanitized event metadata.

This is a conversation-runtime rebuild, not just a voice change or prompt rewrite. Retain existing audio plumbing only where it passes the new experience checks.

**First provider candidate:** retain the existing ElevenLabs streaming adapter, with one voice session, one playback owner and task-bound tools/events. The task engine remains the authority; no second conversational model needs to paraphrase every instruction. Use the same voice path for the prepared opening and subsequent dialogue.

**Voice estimate:** 5–8 focused engineering days, including handset tuning, for one developer after the task/session contract and event interface are runnable. This excludes task-engine and presentation work and assumes working provider/Chert access. If duplex slips, allow roughly 1–2 additional days for an explicitly turn-based fallback with short responses and clear listening pauses. It still uses real task execution, but does not satisfy the full-duplex acceptance target; report the shortfall rather than presenting it as qualified.

## 6. Task state and call rules

Use one task ID from submission through review, with a distinct run ID for every Codex invocation:

`queued → running (run 1) → verifying → needs_decision → walkthrough_ready → in_call → queued (run 2) → running → verifying → review_ready → review_call → accepted`

If verification passes and no decision is pending, go directly from verifying to review-ready. A failed check or decision after a later run returns to the same walkthrough loop. Review revisions create another scoped run and require re-verification.

Persist the task goal, project/workspace reference, run IDs and terminal outcomes, bounded result summaries, tests/build evidence, decisions, revisions and call receipts. The follow-up run receives only the context needed for the requested change. Use the decision/utterance receipt to deduplicate run creation. Record tests that could not execute as blocked or failed verification, never as passed.

Also represent blocked, canceled, failed and unknown outcomes explicitly. Do not build a mid-run approval UI or voice-approval bridge. Preserve native execution policy; if an unexpected native approval is requested, retain the adapter's refusal/interruption behavior and wait for confirmed termination before reporting the blocked result. Do not bypass approval or automatically retry. Detect stalls for operator diagnosis; silence alone is not failure, and an unresolved run cannot start the next one.

Store necessary task context securely; keep raw screens and audio transient. On restart, reconcile the original worker and receipts before continuing. Never turn an unresolved dispatch into an automatic rerun.

Prepare the brief and validate local targets before requesting a call. Revalidate live frames after connection. If preparation fails, report that state by text instead of dialing an unprepared walkthrough. An unanswered call leaves the task waiting for input; it does not authorize a decision or blind redial.

Viewing and controlling retain explicit pairing and session permission. Shared-screen input requires exclusive ownership, fresh frames and observed results. Voice cannot bypass native worker approvals. Local Stop ends sharing/control; hanging up can leave an authorized coding task running. Task cancellation is separate and must report whether the worker actually stopped.

## 7. Acceptance and later work

Before declaring the demo ready, verify:

- Desktop initiation, and paired text if included, reach the same task service; work continues without the original Codex chat.
- A completed run is independently checked; a failure or unresolved decision produces one prepared call, with the correct code or preview visibly shown and zoomed.
- One spoken instruction creates exactly one new scoped run for the same task; audible responses remain conversational during worker activity.
- The follow-up run completes, meaningful tests/build and the rendered result pass, and a separate final review call obtains explicit acceptance or another scoped revision.
- Duplicate events, missed calls, disconnects, worker restarts and unknown outcomes preserve task identity and do not replay external effects.
- Stop and cancellation work as described; rejected window/camera actions remain visible failures rather than claimed success.

**Polish is a release gate.** These are acceptance targets, not current performance claims. Measure on the actual handset, including speakerphone interruption behavior.

| Area | Acceptance target |
| --- | --- |
| Ringing | Warm, preflight-complete call request to handset ringing within **8 seconds**, excluding the person's answer time. |
| Answered call | Useful speech within **2 seconds** of connection; correct live work view within **3 seconds**. |
| Opening | First sentence states the actual issue or result; **zero** generic greetings, sharing announcements or “say begin” instructions. |
| Response | End of human speech to meaningful audible response: **median ≤1 second; no trial above 2 seconds** for ordinary questions/acknowledgments. Measure coding completion separately. |
| Interruption | Human speech onset to audible playback stop: **median ≤300 ms; maximum 500 ms** across **20 deliberate interruptions**. Queue cancellation alone is not evidence. |
| Audio continuity | A **10-minute conversation** without disconnects, repeated clipping or false interruptions during quiet listening. No unsolicited presence check during a deliberate **20-second pause**. |
| Zoom | **450–650 ms** transition; target lines fully visible and highlights aligned within **one line-height**, in **20/20 prepared transitions**. No oscillation or unexpected return to overview. |
| Motion | Start with a **15 fps handset check** across those transitions. Accept it if zooms are visibly smooth; require **≥24 presented fps only if zooms visibly stutter**, then repeat the handset check. No freeze longer than **150 ms** during zoom. Local preview speed does not establish handset quality. |
| Camera cleanliness | **Zero** raw terminals, debug overlays, setup cards, permission dialogs or unrelated windows. Use editor/preview scenes and a concise test-result view; preserve system privacy indicators. |
| Task correctness | Spoken revision starts **exactly one** new run for the correct task; tests/build and result verification precede completion narration and the final review call. |
| Stop | Local capture/control admission stops within **300 ms**; visible remote sharing clears within **1 second**. No silent restart. |

Qualify with **three complete two-call rehearsals**, plus the interruption and zoom trials above. Report median, worst case and failures; this establishes demo readiness, not production reliability. An audio or scene failure blocks acceptance even when backend checks pass. Each live rehearsal requires specific authorization.

Run `npm run check` and the affected Python/Swift checks after code changes. These checks are prerequisites; they do not replace handset acceptance. Keep services in simulation/standby until a specific live rehearsal is authorized. Only the lead handles secrets, deployment and live-line ownership.

**Later:** everything outside the visible coding story—Claude Code and additional workers, parallel jobs, mid-run decision/approval workflows, Agent-S/general desktop tasks, video editing, Grok comparisons or provider migration, arbitrary cross-app/Space navigation, elaborate pet animation, extensive task history, public installer/OTP onboarding polish, external MCP distribution, document attachments, scheduling, multi-user support, billing and website work. If texting is not shown, its new task-initiation UX is also later; preserve the existing transport.

Permissions, Stop, task identity, receipts and unknown-outcome handling remain prerequisites even when they are not visible in the recording.

**Fastest route: reuse the core logic, substantially redesign the user experience, rebuild conversation around the independent agent, and prove one polished coding job before broadening the product.**
