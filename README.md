<h1 align="center">ClawdTime</h1>
<p align="center"><strong>Your coding agent can FaceTime you.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/backend-0.2.0-blue" alt="Backend 0.2.0">
  <img src="https://img.shields.io/badge/Mac_companion-0.2.1-blue" alt="Mac companion 0.2.1">
  <a href="https://www.clawdtime.com"><img src="https://img.shields.io/badge/ClawdTime-Website-black" alt="ClawdTime website"></a>
  <img src="https://img.shields.io/badge/agents-Claude_Code_%2B_Codex-8b5cf6" alt="Claude Code and Codex integrations">
  <img src="https://img.shields.io/badge/status-internal_pilot-orange" alt="Internal pilot">
</p>

You step away. Your agent needs a decision. Your phone rings.

ClawdTime lets your existing coding session call you on FaceTime, show your Mac
screen, hear your answer, and keep working. **The same Codex or Claude session
owns the conversation and uses its own tools throughout the call.** ClawdTime
provides the call, speech, screen sharing and control coordination.

## The flow

**Work → reach a question → use the ClawdTime skill → FaceTime → answer → watch the agent continue.**

“Use the blue heading.” “Change that sentence.” “Send the message.”

The agent receives ordered voice or text turns and supplies the replies you hear.
Screen sharing can continue while it reasons, edits files or uses a permitted
computer tool. It remains in your original chat and follows its normal approvals.

## Native computer use and optional fallback

**Native tools are the default.** The agent uses the computer/browser tools already
available in that chat, on the visible shared surface. ClawdTime coordinates
exclusive input ownership around those tool calls. Tool availability and app
restrictions still apply; the tested native tool cannot control the Codex app itself.

**ClawdTime fallback is optional and off by default.** When you enable it locally,
the same agent can use ClawdTime's observe/click/type/scroll tools. Fallback changes
the execution tool, not the conversational agent. It needs an image-capable MCP
connection; the foreground JSONL bridge supports native tools but cannot carry
fallback screenshots/input. Unknown actions are reconciled rather than replayed.

## The Mac Control Panel

The companion shows the paired connection and project/session, selected display,
permission and sharing status, active call, listening/speaking state, and current
executor or pending work. It provides **Enable locally**, **Stop sharing and
control**, **Mute**, **End call**, and **Request pause**.

| Computer-control mode                   | Behavior                                                 |
| --------------------------------------- | -------------------------------------------------------- |
| **View only**                           | Share the screen; no delegated native or fallback input. |
| **Agent tools only** — default          | Use the coding session's verified native tools.          |
| **Agent tools with ClawdTime fallback** | Also allow the same agent to use ClawdTime input tools.  |

Calling, sharing and input are separate permissions. Saved preferences do not
grant a call or macOS access. Local Stop ends ClawdTime capture/input immediately;
cancellation of an already-running native tool depends on that tool. Historical
unverified outcomes remain visible without being presented as successful actions.

## Get started

1. **Say hey.** Use [Text it](https://www.clawdtime.com) to message ClawdTime from
   your invited iMessage handset.
2. **Paste the returned setup prompt into your coding chat.** Your agent prepares
   the companion and project integration in that same chat.
3. **Grant permissions and enable sharing locally.** Select the intended display
   and control mode, then authorize one test call.
4. **Keep working normally.** Invoke the project skill when a decision or visual
   review would help. Speak naturally on the call; the original agent continues.

The pilot uses a trusted local build and existing pairing. Public npm installation,
notarized public downloads and general tasks initiated from Messages are planned.
The skill does not automatically detect every blocked process or bypass approvals.

## What has been verified

The hosted backend/media and gateway run the agent-owned protocol; companion
0.2.1 fixes the historical receipt migration. In a real Codex desktop chat, spoken
instructions drove native typing and a send in Messages. The human confirmed
seeing the result on the phone and intentionally hung up.

Both CLI clients passed synthetic multi-turn checks. Claude's physical flow,
ClawdTime fallback, broader native control, reconnect and calls beyond five minutes
remain unqualified. Voice is half-duplex. A screen-frame timeout was recorded near
the latest hangup, so long-duration sharing reliability is still an open check.
This is a deployed internal pilot, not a generally qualified public release.

[Short filmed demo](docs/FILMED_DEMO.md) · [Setup & development](docs/GUIDE.md) ·
[Current status](docs/STATUS.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Release record](docs/AGENT_OWNED_RELEASE.md)

## Scope and provenance

Built for decisions that interrupt work while you are away. Coding is the pilot;
email, video, marketing, purchases and watcher-driven work are future use cases,
not qualified integrations. General work started from Messages is planned Mode 2.

ClawdTime is independent of Apple Teams, selectively derived from source baseline
`be47b11fe1317c4747db4121bec37896998b5201`. See the
[implementation plan](IMPLEMENTATION_PLAN.md) and [development guide](docs/GUIDE.md).

**Topics:** AI agents · FaceTime · iMessage · human-in-the-loop · computer use · CUA ·
MCP · Claude Code · Codex · macOS · remote work.
