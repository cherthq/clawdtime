<h1 align="center">ClawdTime</h1>

<p align="center"><strong>Your Agent for Long-Running Work</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.0-blue" alt="Version 0.2.0">
  <a href="https://www.clawdtime.com"><img src="https://img.shields.io/badge/ClawdTime-Website-black" alt="ClawdTime website"></a>
  <img src="https://img.shields.io/badge/status-internal_pilot-orange" alt="Internal pilot">
</p>

ClawdTime is your agent for long-running work. Give it a task and it runs it end to end, delegating to specialist agents and tools such as Codex, Claude Code, and other apps as needed. When it needs your judgment or has a result to review, it prepares a walkthrough and FaceTimes you.

You don't babysit Codex. You hand the job to ClawdTime, and it calls you when it matters.

## How people would use it

Setup: Install one desktop app → connect models and tools (essentially need to give Clawdtime context on the tools that it has access to via CUA, CLIs and APIs where available, computer use for the rest) → grant Mac permissions → pair your phone via OTP texting.

The goal is a simple, one-click installation followed by guided setup.

1. **Chat from the desktop or phone.** A floating companion or command bar lives on your desktop. Click it to open chat, assign a task, and answer clarifying questions through selectable options. You can also text it a task.
2. **Let it work.** ClawdTime plans the task, chooses tools or agents, and tracks progress. It drives workers through APIs and command-line tools by default, with computer use for apps that need it. You can request a call to watch it perform a task.
3. **Resolve issues together.** When it needs human input, it diagnoses the problem and prepares the walkthrough before calling. During FaceTime, it shares the live screen, zooms in on the relevant area, and explains the decision. You discuss the fix while it coordinates edits or computer actions and verifies the result.
4. **Continue and review.** Once the issue is resolved, it ends the call and continues working. When the task is finished, it prepares a final walkthrough and calls for your review and confirmation. Text remains available for questions, updates, and requesting another walkthrough.

During a call, the voice layer handles conversation while the task engine coordinates the work. Ending the call does not have to end the task.

## Technical details

The [long-running task and review guide](docs/TASK_REVIEW_LIFECYCLE.md) describes
semantic task admission, coding runs without an overall timer, independent
verification, durable review callbacks, exact-result acceptance and exclusive
capture handoff. Phone setup and fresh authorized result views are required before
delivery; missing setup is reported when work is admitted. The installed pilot
has not yet been upgraded, and handset capture continuity remains unqualified.

Coding-demo implementation: the [native desktop panel guide](docs/CODING_DEMO_DESKTOP.md)
documents the runnable local task workflow, explicit Codex setup and current
handset acceptance limits.

Agent board: the desktop panel and `clawdtime agents` list every coding-agent
session on this Mac (Claude Code, Codex, pi and more), show which ones wait for
you, and bring a session's terminal forward. It reads state only and never sends
input to a session. `clawdtime hosts add NAME SSH_TARGET` adds the sessions of
another Mac, such as a Mac mini, over ssh. See the
[agent board guide](docs/AGENT_BOARD.md).

Supervisor: ClawdTime can also answer an agent for you. Approve or deny a
permission request from the panel, the mascot's bubble, a command, or a FaceTime
call when you are away. It keeps each decision in a trove, repeats an answer only
where you made a rule, types into a session's terminal on request, and reports
the agent commands you use as a slide deck. You can also talk to it: in a chat
screen, by voice on the Mac, where it answers aloud, or on a FaceTime call. It has a memory for what you tell it about
yourself and your work, which is off until you turn it on. Its watcher follows
every session and tells you when one has waited for you too long, hangs, ended
badly or is done. See the
[supervisor guide](docs/SUPERVISOR.md).

Desktop computer tasks have an opt-in app-owned runtime that works without an
open Codex chat. It bundles an isolated browser adapter, a local Mac adapter,
exact-action approvals, result verification and **Stop work**. The standalone
browser fixture and a native two-app activation/type/save/Stop flow are verified
on the qualification Mac. This is bounded internal acceptance, not a claim that
every application or computer is supported.
Native mode now includes a focus-preserving approval panel and explicit activation
of allowlisted existing app windows. The standalone package uses a separate
Local Control helper so it does not overwrite an installed call companion.
See [bundled runtime setup and limitations](docs/BUNDLED_CUA.md). An
[existing-chat adapter](docs/DESKTOP_EXECUTOR.md) remains available separately.

During an authorized visual call, keep the current prepared window shared through
spoken requests, coding, verification and acceptance. If another prepared view is
requested, replace it mid-call when its first fresh frame is ready; do not blank
or end sharing between views. Sharing ends on explicit **Stop sharing**, call
end, or loss of capture permission, source freshness or call authority. Changed
work stays visible, but outdated result narration and verification labels are
suppressed. New desktop calls use call-scoped sharing; historical grants keep
their original limits. See the [implementation plan](docs/CODING_DEMO_IMPLEMENTATION_PLAN.md)
for scope and the remaining handset continuity test.

### Technical implementation

Long-running work should continue without depending on an existing Codex chat staying active.

The opt-in app-owned runtime uses a replaceable model planner, isolated Chromium
and the Mac companion. Agent-S remains a candidate, not an installed dependency.
The presentation layer renders walkthrough zooms. Shared-screen actions retain
explicit permissions, exclusive control, fresh-screen checks and visible Stop.

### Model Choice: lets try Grok first.

Grok is a reasonable demo candidate, not an established winner.

[https://github.com/dylanelu/FaceTimeOS](https://github.com/dylanelu/FaceTimeOS) is a useful reference for combining a floating interface, Agent-S, and phone interaction.

Its launcher ([https://github.com/dylanelu/FaceTimeOS/blob/main/run.sh](https://github.com/dylanelu/FaceTimeOS/blob/main/run.sh) ) distinguishes the recommended Grok-only setup from the recorded demo configuration ([https://github.com/dylanelu/FaceTimeOS/blob/main/Agent-S/run_demo_fast.sh](https://github.com/dylanelu/FaceTimeOS/blob/main/Agent-S/run_demo_fast.sh) ), which uses Grok with UI-TARS to locate screen targets. Reproduce and test a pinned configuration on our Mac before selecting it. Keep the model replaceable.

### The initial demo

Start with one coding-agent integration and a small demo project. Prepare the walkthrough before dialing, show the relevant code or failing test, apply the spoken instruction through the worker, and verify the result before the final review call. Add more worker integrations after this complete flow works reliably.

## Comparisons

1. General assistants (Grok Bot, OpenClaw, Sentient OSSentient OS, TurnstoneTurnstone, TaskletTasklet): They do everyday tasks themselves and check in by text or chat.
2. Coding-agent managers (herdrherdr, Boxes.devBoxes.dev, Agent RelayAgent Relay): They keep coding agents running, coordinated and visible, then alert you through a dashboard or message.
3. FaceTime projects:
   1. FaceTimeOS: You call your Mac to control it.
   2. Argos: A single-purpose watcher for ML training.
