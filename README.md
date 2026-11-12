<h1 align="center">ClawdTime</h1>
<p align="center"><strong>Your coding agent can FaceTime you.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.0-blue" alt="Version 0.2.0">
  <a href="https://www.clawdtime.com"><img src="https://img.shields.io/badge/ClawdTime-Website-black" alt="ClawdTime website"></a>
  <img src="https://img.shields.io/badge/agents-Claude_Code_%2B_Codex-8b5cf6" alt="Agents: Claude Code and Codex">
  <img src="https://img.shields.io/badge/status-internal_pilot-orange" alt="Status: internal pilot">
</p>

You step away. Your agent gets stuck. Your phone rings.

ClawdTime gives Claude Code and Codex a way to call you on FaceTime, show your
Mac screen, and get your input. Talk or text naturally, then let the agent keep
working. After you help, the result arrives in Messages.

## The flow

**Code → FaceTime → see the screen → give feedback → agent continues → Messages result.**

“Skip that test.” “Use the second design.” “Click the title and type Hello.”

Your existing coding session receives ordered voice or text turns, uses its own
tools, and sends replies for ClawdTime to speak. Screen sharing stays on while
you work. Optional ClawdTime input tools run only when you enable fallback in
the Mac Control Panel; the same coding agent still makes the decisions.

## Get started

1. **Say hey.** Click [Text it](https://www.clawdtime.com) to open Messages with
   “Hey ClawdTime,” then send it from your invited iMessage handset.
2. **Give your agent the reply’s setup prompt.** Paste it into your current
   Claude Code or Codex chat. The agent sets up the companion and project skill.
   That same chat stays active through installation and permission questions.
3. **Take one test call.** Grant screen access, answer the approved FaceTime call,
   see your Mac, and talk or text back. Your agent continues and sends a Messages
   follow-up. Computer control is optional; setup has no clicking exercise.
4. **Go do your thing.** Keep using your agent normally. Its project skill lets it
   call for a decision or review and send the follow-up. Help it out from your phone.

No command prefixes or confirmation codes. Local **Stop** always stays available.

**Hosted private release 0.2.0:** the agent-owned conversation protocol and Mac
Control Panel are deployed. New connectors default to the agent-owned protocol;
existing sessions keep their original version. Physical qualification is pending.
Companion 0.2.1 resolves the historical receipt block. One voice-directed native
computer-use task passed in the originating Codex chat, with handset confirmation.

The Control Panel defaults to **Agent tools only**. Native control requires a
verified tool for the actual shared surface and the client's normal approvals.
**View only** and **Agent tools with ClawdTime fallback** are explicit local choices.
Sharing and calling are separate; stopping sharing does not end a v2 conversation.
ClawdTime can stop its own input immediately; cancellation of a native tool is
cooperative and may leave an unresolved outcome.

Both installed CLI clients passed local synthetic multi-turn polling checks.
Broader native CUA, client reconnect, and connection beyond five minutes remain
physically unqualified. Voice is half-duplex. No live
call was placed during rollout, and routing remains unchanged. Public downloads
and phone-initiated coding remain planned. See the [release checklist](docs/AGENT_OWNED_RELEASE.md).

[Setup & development](docs/GUIDE.md) · [Current status](docs/STATUS.md) · [Architecture](docs/ARCHITECTURE.md)
