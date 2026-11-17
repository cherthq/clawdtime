<h1 align="center">ClawdTime</h1>

The 0.4.0 source adds scoped résumé discovery, private first-page preview and
explicit paired-iMessage attachment sending, plus verified voice completion
reporting. See [release evidence and acceptance](docs/CONVERSATIONAL_CONTROL_RELEASE.md)
and [local document host setup](docs/CONNECTORS.md). Physical demo readiness is
reported separately from tests and deployment.
<p align="center"><strong>Your coding agent can FaceTime you.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/backend-0.3.1-blue" alt="Backend 0.3.1">
  <img src="https://img.shields.io/badge/Mac_companion-0.2.1-blue" alt="Mac companion 0.2.1">
  <a href="https://www.clawdtime.com"><img src="https://img.shields.io/badge/ClawdTime-Website-black" alt="ClawdTime website"></a>
  <img src="https://img.shields.io/badge/agents-Claude_Code_%2B_Codex-8b5cf6" alt="Claude Code and Codex integrations">
  <img src="https://img.shields.io/badge/status-internal_pilot-orange" alt="Internal pilot">
</p>

You step away. Your agent needs a decision. Your phone rings.

ClawdTime connects a paired person to coding and desktop work through iMessage
and FaceTime. Source version **0.3.1** adds a responsive conversational layer over
shared asynchronous jobs. Backend and media **0.3.1** are deployed with ordinary execution/voice gates off; the
existing foreground-chat pilot behavior remains active. Direct GPT-Live access is
qualified. The separate execution-disabled audio test mode is deployed and ready; handset
qualification remains required. See the [supervised audio test](docs/AUDIO_QUALIFICATION.md). See the [rollout and next steps](docs/CONVERSATIONAL_CONTROL_RELEASE.md).

## Conversational jobs — opt-in source implementation

Text and qualified voice frontends use the same submit/status/revise/cancel broker.
Conversation can continue while the executor works. A queued receipt, actual runner
acceptance, native approval, verified completion and unknown outcome are distinct.
A real local proof used the text model plus Codex App Server, independently checked
the result file, and answered status during deliberately slow execution. Messages
transport was simulated; there is no new handset qualification.

New sessions explicitly select an **API-managed execution session**, separate from
the original desktop conversation. The local Codex App Server runner uses an exact
project allowlist and preserves native approvals. An authenticated foreground
executor worker connects a hosted broker to the selected local project. It cannot
wake an idle chat or obtain this desktop chat's native CUA tools. Existing sessions
are immutable and keep the legacy workflow described below and in the guide.

GPT-Live client delegation is implemented behind gates with pinned optional LiveKit
packages now installed in media. Authenticated silent GPT-Live sessions passed
locally and on the deployed server, with provider-confirmed clean closure. Voice remains
unqualified for full-duplex speakerphone use. See [release evidence and rollout](docs/CONVERSATIONAL_CONTROL_RELEASE.md).

## Argos-style voice and presentation

The explicit same-chat ElevenLabs frontend now connects streaming conversation to
the current coding agent and prepared camera focus/annotations. It preserves native
CUA ownership and approval controls; IDE integration is optional. Native selected-
window capture also includes the start/stop lifecycle repair validated with sustained
Finder frames. These changes are locally tested, not yet phone-qualified or deployed.
See [the review and acceptance evidence](docs/IMPLEMENTATION_ARGOS_REVIEW.md) and
[voice setup](docs/MEDIA_INTEGRATION.md#same-chat-elevenlabs-streaming-frontend).

Run `npm run test:voice:camera` for a local synthetic end-to-end presentation check;
it does not connect a voice provider, microphone or phone. The provider protocol
loopback tests and a network-free dedicated-agent configuration builder are described
in [media checks](media/README.md). Existing sessions retain their selected voice path;
new voice sessions must explicitly use `--voice-frontend elevenlabs`.

## Local screen camera preview

The Argos slice adds explicit display/window capture, native-resolution
crop/zoom, transient annotations, pinning and pause/resume without an IDE plugin.
Run `npm run preview:camera` for a localhost-only synthetic preview using the real
backend/media/gateway path; `npm run preview:camera -- --smoke` checks the connector
and existing CUA ownership/receipt path with a fake input sink. No call is placed.
For the local Finder review, open the disposable `/tmp/ClawdTime Sharing Review`
folder in Finder, keep that window visible on one display, and run
`npm run preview:camera:window`. Open its printed URL and press **Start sharing**.
The window is selected by app identity and exact title; missing or ambiguous windows
are refused. Confirm it is the intended test folder before Start: title matching is
not a folder-access restriction, and sharing follows that window if you navigate.
The page uses real selected-window pixels, exposes Stop, and submits
no OS input. It is separate from the synthetic diagnostic above. Existing Screen
Recording permission is required; no helper is installed or live service changed.
Actual capture acceptance is recorded in [the review](docs/IMPLEMENTATION_ARGOS_REVIEW.md).
Selected-window fallback input remains unavailable pending exact hit-target
qualification; display CUA retains its existing permission and ownership gates.

## Production prepared-scene integration

The source now includes explicitly negotiated prepared-scene commands and a
read-only Mac target resolver over the authenticated gateway. Native window actions
remain with the original chat's qualified CUA. New backend/media admission defaults
off through `CLAWDTIME_LIVE_PRESENTATION_ENABLED`; existing sessions do not upgrade.
This capability is deployed with new admission off, pending remote timing and
handset qualification. The updated companion remains disarmed.
See [production staging](docs/DEPLOYMENT.md#prepared-live-presentation-staging).

## Local two-app presentation walkthrough

The local display prototype uses one selected-display capture stream, a bounded
agent-prepared scene plan, and the original chat's native tools. It can coordinate
scene changes, fresh focus/annotations, interruption and Stop. Native window
activation and edits still run through the chat's qualified desktop tool under
exclusive ownership; the scene controller never dispatches OS input itself.

```sh
npm run prepare:presentation
npm run test:presentation
# After preparing the disposable Finder/TextEdit windows and verifying this chat's native tool:
npm run preview:presentation -- --native-display 1
```

Replace `1` with the explicitly selected display. The last command starts capture
of that whole display immediately; it does not select or broaden an existing
window lease. Open the printed private local preview URL on another display or a
hidden viewer to avoid showing the preview inside itself. Stop is visible in the
preview; Ctrl-C closes the local processes. No installed configuration, provider,
FaceTime call or live deployment is used. The source/render targets are 15/30 fps;
actual results and outstanding native acceptance are recorded in the
[implementation review](docs/IMPLEMENTATION_ARGOS_REVIEW.md).

The bridge adds `presentation_prepare`, `presentation_status`,
`presentation_begin`, `presentation_observe`, `presentation_present`,
`presentation_next`, `presentation_interrupt`, and `preview_metrics` to the
native-review commands below. Each uses `{id, command, args}`. Prepare at most
12 scenes with exact current app/window/process/display identities. Begin a scene,
claim native ownership for any action, verify its actual result, release ownership,
then observe and present with the fresh window bounds and source metadata.
See [scene contracts](src/presentation-scene-contracts.ts) and
[controller workflow](docs/CONNECTORS.md#local-agent-prepared-scene-controller--november-17-2026).
An interrupted or changed source requires new observation. Unknown camera/input
outcomes block replay. Native computer-tool availability is an external prerequisite;
fixture readiness and synthetic tests do not prove real app outcomes.

The local native-activation mode now also supports `presentation_present_live`,
`presentation_complete`, `presentation_replan`, and `presentation_receipts`.
Prepare window-relative focus regions and annotations upfront. Before presenting
each scene, the runtime resolves the exact live window twice around a fresh frame,
then commits focus and annotation together. A short read-only monitor clears the
view if the target moves or loses focus. After completion, the next request can
install another bounded plan in the same session; unknown outcomes block replanning.
A local snapshot-display rehearsal verified Finder → TextEdit → Finder, all three
zooms/labels, and a second plan in the same session with clean Stop. The initial
windows were on the current Space; automatic cross-Space alignment and persistent
stream stability remain open. This is not yet a qualified phone walkthrough.

Use `--native-display 1 --native-activation` for the explicit local activation
review. Adding `--snapshot-display` selects a separate diagnostic transport using
fresh snapshots of that same display (5 fps source target, 30 fps render target).
It never automatically replaces or restarts a failed persistent stream. Passing
that diagnostic does not establish that the persistent-stream interruption is fixed.

For long scene plans, feed JSONL through a pipe: macOS terminals can truncate a
long pasted line before this bridge receives it. Keep the test windows on the
selected display's current desktop; Accessibility can read an off-screen window
without proving it is visible in the presentation.

Metadata-only performance commands:

```sh
media/.venv/bin/python scripts/measure-presentation.py
# Explicit actual display capture; pixels are discarded, no input is submitted:
media/.venv/bin/python scripts/probe-presentation-display.py --display 1 --seconds 45
```

The first command uses synthetic Retina-sized pixels only. The second measures
the chosen real display locally and checks capture cleanup. Neither establishes
handset smoothness or two-app native control acceptance.

## Desktop control

The new bounded workflow observes, proposes one action, checks a fresh matching
screen and current authority, submits once, independently verifies the visible
result, and releases ownership. Native and custom supplied adapters share these
rules. The managed Codex runner has **no qualified native desktop CUA adapter**.
Automatic adapter selection is disabled pending comparable physical trials.

Text-only desktop control uses a distinct device/session/project grant accepted in
the Mac's local Control Panel. It does not create a fake FaceTime call. The current
grant covers the selected whole display, with explicit allowed actions and expiry;
it is not application-level isolation. Local Stop, lock, policy change and restart
revoke it. Backend session loss also requests revocation once and preserves an
uncertain receipt. A submitted input or fresh frame alone is never UI success.

The deployed legacy path still supports the original chat's native tools and an
optional image-capable MCP custom path. Neither its old native default nor its
past physical evidence qualifies the new managed runner.

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
notarized public downloads and waking arbitrary idle chats from Messages are planned.
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

### Local native CUA and camera review

`npm run preview:camera:cua` explicitly starts capture of the disposable Finder
window titled **ClawdTime Sharing Review**, with a local in-memory backend,
simulation transport, real camera and native-only execution ownership. Run it
only after verifying that this same chat's desktop CUA tool can see that exact
window. It never loads installed credentials or places a call. Sharing follows
that window if Finder navigates; the title is not a folder-access restriction.

The foreground process accepts newline-delimited JSON commands on stdin:
`execution_status`, `conversation_turns`, `transfer_execution`,
`screen_camera_status`, and `screen_camera_command`. Each command has a unique
`id`, `command`, and `args`; the harness supplies its exact request ID. No image
bytes or OS-input commands are returned through this bridge. Read-only polling
is uncached; bounded mutation receipts reserve one final ownership release.

Before native input: read/drain turns, inspect the exact fresh camera and native
window, claim `native` with the current epoch/cursor, then recheck execution status.
Use this chat's normal CUA tool, inspect its actual result, and release to `none`
with `previousOutcome: completed` only when the tool is finished. On an uncertain
result, preserve uncertainty instead. Native targeting uses the tool's fresh
window observation, not global coordinates derived from the camera crop. Stop
clears capture and forbids the next claim; it does not forcibly cancel an already
running native tool. Window fallback input stays disabled.

The browser's Stop button and Ctrl-C end this disposable local review. It expires
after 15 minutes. This harness proves local wiring, not installed-stack readiness
or FaceTime acceptance; see `docs/IMPLEMENTATION_ARGOS_REVIEW.md`.

For the separately negotiated **local activation prototype**, use
`npm run preview:camera -- --native-display 1 --native-activation` after selecting
the intended display. This starts actual transient capture, with no external call.
Only Finder and TextEdit `activate_app` / `raise_window` are supported. The original
chat prepares a scene, begins it, claims native ownership, then sends
`native_prepare` with `{operationId, sceneId, action, window}`. `window` contains
the freshly resolved `appId`, `windowId`, `ownerPid` and `displayId`.

The preview's **Execute prepared operation** control invokes that immutable ID;
use the qualified native/browser CUA tool to click it. Preparation itself sends no
input. The host rechecks the exact scene, authority, fresh display and process/
window identity immediately before a single native effect. A returned API call
does not prove the intended window is visible. `native_status` inspects receipts;
`native_reconcile` reads the original host receipt without replaying an effect.

The printed `nativeJournal` directory retains owner-only adapter and host receipts
after shutdown; preserve it when a result is uncertain. Stop cancels the local
host and prevents further dispatch. The browser cannot submit editable native
operations, and host requests use a separate ephemeral credential. This prototype
does not add typing/clicking to the companion, enable fallback, or establish
production activation reliability. The browser control is a development harness;
the finished agent experience must not require a user click for each scene.

`presentation_present_observed` accepts `{attestation, rect}` to sample source
metadata and frame a verified result in the same runtime call. The attestation
contains `sceneId`, `generation`, the original `observedAt`, exact `window`,
normalized `windowBounds`, and `resultVerified: true`. This removes a transport
round trip while retaining the existing content/freshness checks. Actual framing
still hit HTTP 409 in the latest rehearsal; preserve unknown commands and do not
replay them. Native switching/edit/save/move passed locally, but the complete
polished presentation is not yet accepted.
