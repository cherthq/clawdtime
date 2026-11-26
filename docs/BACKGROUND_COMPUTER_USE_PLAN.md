# ClawdTime background computer use implementation plan

Status: Draft for implementation review. Prepared November 21, 2026.

Build a reliable phone-controlled Mac assistant that can launch and use supported
apps, show the relevant work with automatic zoom, and display a distinct
ClawdTime cursor without taking over the user's mouse. Preserve the working
FaceTime connection and durable request handling. Adopt Cua Driver only after
it passes application-specific tests on this Mac.

This is a planning deliverable. It does not install a driver, grant permissions,
change live routing, or authorize sending messages.

## Current baseline and gaps

The local phone bridge now carries authenticated call requests into the bundled
computer runtime. A real TextEdit click/type task completed and its result was
independently observed. Legacy unfinished terminal jobs were stopped and retired
with their unknown outcomes preserved.

That result does not establish general Mac control. Recent call traces show:

| Area           | Current behavior                                             | Required outcome                                                                                                     |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Messages       | App absent from configured window inventory; request blocked | Launch or resolve the correct app and read a selected conversation when authorized                                   |
| Codex          | Window visible, but New chat control not recognized          | Open the app and complete a verified new-chat workflow, or use a supported agent handoff if UI control is prohibited |
| App control    | Narrow accessibility shapes and existing-window activation   | App discovery, launch, window binding, element input and verified results                                            |
| Video          | Fixed full-screen capture                                    | Share the bound work window, with automatic zoom and an overview option                                              |
| Cursor         | Physical desktop input                                       | A distinct session cursor with explicit background delivery                                                          |
| Communications | Planner pauses before sends                                  | Initially read/draft only; later exact-recipient/content approval and duplicate prevention                           |

The existing phone process does not inherit this coding chat's Gmail connector,
Codex app tools, computer-use permissions or background cursor.

## Architecture decision

Keep the call transport and add an opt-in Cua Driver execution backend:

```text
FaceTime caller
    -> existing Chert and LiveKit voice agent
    -> authenticated call-scoped command bridge
    -> durable task controller and authorization checks
    -> planner proposes one typed action
    -> Cua Driver adapter and exact app/window session
    -> fresh observation and independent result verification
    -> status and result returned to the call

Bound work-window frames + transient action locations
    -> video framing, zoom and cursor compositor
    -> existing LiveKit video track
```

Cua Driver supplies computer access, not the reasoning agent. Retain the existing
voice and planner models initially so that a driver change is not confounded by
a model migration. Extend the planner's typed actions and observations for the
new backend; do not expose a general script or shell tool.

On macOS, use a separately identifiable, pinned `CuaDriver.app` daemon with a
protected local connection. Explicitly connect to the intended instance and
verify its identity and policy. Do not accept silent in-process fallback: the
documented in-process route does not provide the same cursor overlay or permission
attribution. Package a ClawdTime-owned host later only if the initial integration
proves that embedding is needed. [Cua SDK guidance](https://cua.ai/docs/cua-driver/guides/use-the-sdk)

## Phase 1 — Prove the driver before committing to it

Owner: Mac specialist, coordinated by the lead.

1. Select an exact official driver and SDK release; record version, artifact
   identity, signature/hash, license and supported macOS version. Verify the
   documented TypeScript API against that release. Do not introduce cloud
   hosting, a paid account or a VM as an implicit prerequisite.
2. Prepare a bounded capability manifest for TextEdit, Messages and the installed
   Codex application. Identify apps by verified installed bundle/path identities,
   including aliases such as iMessage → Messages; never turn an arbitrary spoken
   path into a launch command. Keep driver configuration and credentials outside
   the repository.
3. During implementation, complete the required local installation and macOS
   permission steps. Check permission ownership, daemon identity, session close,
   local Stop and permission revocation before using real accounts.
4. Run isolated local probes: open an app, resolve its exact window, read a
   screenshot and accessibility state, type into a disposable document, and
   verify the result while the user works in another app.
5. Test Messages conversation navigation and Codex's New chat control against
   their actual installed versions. Use a designated test conversation and a
   harmless draft in a new chat; no message or research task is sent during this
   qualification unless separately authorized.
6. Check Codex host/self-target protection explicitly. If the driver refuses
   this host, preserve that boundary. Investigate a documented authenticated
   handoff; do not bypass the refusal, access private app sockets, or assume a
   chat can be resumed through an invented API.

**Exit gate:** record a capability matrix for each app and action, including
background input, capture, minimized windows, occlusion, other Spaces and Stop.
If a required Messages or Codex workflow fails, record the exact missing
capability and revise the design before replacing the installed backend.

Driver documentation describes background control and an agent cursor, but also
lists macOS limitations. Those claims are a reason to run this spike, not proof
that every workflow on this Mac will work. [Driver overview](https://cua.ai/docs/cua-driver),
[platform limits](https://cua.ai/docs/cua-driver/concepts/platform-support)

## Phase 2 — Integrate execution and truthful progress

Owners: lead for contracts/controller; connector specialist for driver adapter
and planner integration.

- Add a backend selector in protected local configuration. Keep the current
  native backend available for deliberate rollback, but never automatically
  switch to it or spawn terminal jobs when the driver refuses an action.
- Preserve call admission, stable tool-call IDs, encrypted request/action
  receipts, bounded leases, status polling and hangup cancellation. Bind every
  action to its call, task, driver generation, app process and exact window.
- Map the supported driver calls into typed actions: app discovery/launch,
  window selection, snapshot, element click, text entry, bounded key presses,
  scrolling and session termination. Admit only the methods needed for qualified
  workflows; do not expose raw scripts, permission changes or process killing.
- Treat this as a new window-scoped authority contract, not a replacement of
  the old adapter's input function. App launch is a separate trusted capability.
  Preserve the existing native adapter's global-focus and display protections;
  do not weaken them to simulate background support.
- Always request background delivery. If unavailable, return a specific blocked
  state. Foreground control must be an explicit later option, not an invisible
  retry that steals the user's mouse or focus.
- Treat element tokens as observation-scoped. Re-observe after a confirmed
  pre-dispatch stale-token refusal; never resend after a timeout or uncertain
  outcome without independent reconciliation. A driver completion response alone
  is not proof of the requested UI result.
- Share one execution arbiter across phone, desktop and legacy helper paths.
  Prevent competing controllers from operating the same target. Claim and
  release the required native/fallback ownership around input; reasoning and
  unrelated user work remain possible. Prove that competing agent sessions
  cannot bypass this arbiter.
- Expose meaningful states: queued, running, waiting for approval, blocked,
  completed, canceled and uncertain. Report the current step and specific
  blocker without inventing progress. Resolve “open app,” “read messages,” and
  “start a coding task” as different intents.

Use the driver's bounded mode and a narrowly scoped manifest. Driver authorization
supplements ClawdTime's task authorization; broad input permission is not
permission to send a message or run an arbitrary agent command. Keep screenshot
and accessibility contents transient; retain only necessary encrypted task
context and receipts. [Driver permissions](https://cua.ai/docs/cua-driver/guides/permissions)

**Exit gate:** a simulated admitted call completes a real, harmless app task,
returns its verified result, and releases ownership. Duplicate delivery,
disconnect and process restart do not replay actions or lose unknown outcomes.

## Phase 3 — Qualify Messages and Codex workflows

Owner: connector specialist, with lead acceptance.

Implement and test complete workflows instead of testing only app launch:

- **Messages:** resolve/open Messages, select a named test conversation, read
  visible requested information and return an accurate summary. Unread state
  and read receipts may change when opening a conversation; choose a test
  conversation whose read effects the user accepts, and avoid unrelated ones.
  Authentication and account setup remain user steps.
- **Codex:** resolve/open the installed app, enter a new chat, populate a
  harmless draft and verify it. A later explicit request to start work must
  identify the destination project/chat, submit once, retain its identity and
  report actual progress. Creating a chat, submitting a task and completing that
  task are separate outcomes.
- **Read-only email:** qualify one named, already signed-in app or browser
  account separately. The phone agent must not claim access to another chat's
  connectors. Existing-profile attachment, if needed, gets its own scoped grant.

External communications remain draft-only in the first release. A subsequent
send milestone must bind approval to the exact account, recipient and text,
invalidate approval when those change, reserve a send receipt before dispatch,
and verify the resulting sent state. “Yes” is meaningful only for the current
pending action in the authenticated call. An ambiguous send is never retried
blindly. A rollout test uses a recipient and message explicitly chosen by the
user, not a historical unfinished request.

**Exit gate:** each supported workflow has independent observed evidence. A
passing TextEdit test does not substitute for Messages, Codex or email acceptance.

## Phase 4 — Add window sharing and automatic zoom

Owners: Mac/media specialist for capture; lead for line-video integration.

Background work can occur in a covered window or on another Space. Cropping the
physical desktop would show the wrong content, so first provide a bounded,
read-only capture stream for the exact authorized work window. Verify that the
driver's capture interface can sustain the required rate; if not, add a native
window-capture adapter bound to the same process/window generation. Neither
capture route may acquire a competing input lease.

Proposed initial video behavior:

| Situation                                         | Presentation                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Caller asks to share                              | Overview of the authorized work window; retain mascot                            |
| Agent focuses a field or control                  | Smoothly zoom toward that action's observed bounds                               |
| Agent types                                       | Hold framing steady around the field                                             |
| Agent changes apps or finishes                    | Return to an overview before reframing                                           |
| Caller says “zoom out” or “show the whole screen” | Apply an explicit presentation override; desktop sharing is separately scoped    |
| Target disappears or frames become stale          | Hide the target view and show a neutral status; no stale frame presented as live |

Start with a configurable 1×–2× zoom and roughly 300–500 ms transitions, then tune
on a real phone. These are proposed defaults, not measured performance claims.
Use transient action locations tied to the current frame/window. Zoom changes
only the outgoing video; it does not resize apps or change macOS display scaling.

Keep window coordinates, screenshot scaling and video crop transforms explicit.
The planner receives the original observation, never the zoomed video. Remote
tap-to-click is outside this release; adding it later requires an independently
tested inverse transform and fresh-frame authorization.
Test Retina scaling, letterboxing, display changes and window recreation. A
changed source generation invalidates queued actions and presentation locations.

**Exit gate:** text is readable on the phone, zoom follows the correct target
without oscillation, and changing zoom cannot move an input action. Measure
frame age, capture/composition cost and audio/video behavior during a real call.

## Phase 5 — Add the ClawdTime cursor

Owner: Mac/media specialist, with connector support for session events.

Start with the driver's session cursor and a distinct supported theme. Label it
ClawdTime where the verified API permits; custom mascot artwork is a later
presentation enhancement if theme packaging requires additional work. Use the
driver's supported position and motion facilities rather than moving the user's
physical pointer to animate the overlay.

For phone video, composite the cursor from the same transient window-local
action state and apply the video crop transform. Verify whether each capture
route includes the driver's overlay, so the phone never shows two cursors. Do
not assume a cursor on another Space is visible on the user's current desktop.
An animated click means input was attempted; completion still comes from the
observed result. [Cursor API](https://cua.ai/docs/cua-driver/reference/mcp-tools/pointer-cursor-and-browser)

Hide or retire the cursor on Stop, hangup, expired authority and driver restart.
Prove that the user can move their mouse and type in another app without the
agent redirecting that input or altering the user's clipboard. Pause on
conflicting work in the same target. Opening an app for background work does
not implicitly authorize bringing it to the foreground.

**Exit gate:** the cursor, call video and action target agree; the real mouse and
foreground app remain unaffected for every advertised background workflow.

## Phase 6 — Install and accept the local release

Owner: coordinating lead; independent reviewer checks authorization and recovery.

Build a versioned local artifact with pinned dependencies and an installation
manifest. Preserve protected configuration, existing receipts and prior code.
Work in the existing main checkout or a permitted descriptive branch; retain
all current unmerged changes. Do not modify the source project or sibling services.

Before cutover, verify the line and both controllers are idle, no unresolved
input exists, and the previous controller has released ownership. Start the new
backend with control disabled until its permission checks pass. Only the lead
changes local live routing; no remote line-worker restart is part of this plan.

Run the relevant TypeScript, line, Swift and adapter tests, then conduct the
physical acceptance sequence:

1. Call the dedicated line; hear the agent and request screen sharing.
2. Open Messages and inspect the agreed test conversation without sending.
3. Open Codex and prepare a verified new-chat draft, subject to the Phase 1 gate.
4. Complete a disposable editing task while the user works in a different app.
5. Observe automatic zoom, overview override and the distinct cursor on phone
   video; verify background delivery does not take the user's mouse or focus.
6. Exercise spoken Stop, local Stop and hangup during work. Confirm no new input
   begins after revocation and classify any already-dispatched action accurately.
   Require local dispatch admission to close within one second of receipt of
   Stop; measure driver quiescence separately. The existing 30-second call lease
   bounds loss-of-contact detection. Do not advertise instant cancellation of
   an action already delivered to the OS.
7. Test call drop, duplicate tool call, expired call, driver crash, model timeout,
   stale token, moved/resized window, app exit, lock/sleep, permission revocation,
   other Spaces, minimized windows and missing capture. No automatic replay or
   unannounced foreground fallback is acceptable.

Record results per capability: verified, limited or blocked. Do not label the
whole system ready based on a single passing app. Describe any account, OS or
driver prerequisite concretely.

Rollback restores code/backend selection only after stopping and reconciling
the new session; it never restores an older database, discards receipts or
replays pending requests. Resolve the current updater's dirty-checkout skip with
an intentional release process and compatible schema/version checks before
resuming unattended updates.

## Work order and ownership

| Wave | Work                                                 | Dependency and deliverable                                                    |
| ---- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| A    | Driver feasibility and threat/recovery review        | Capability matrix and go/no-go decision; no live replacement                  |
| B    | Backend adapter, typed contracts and phone lifecycle | Phase 1 passed; verified local bridge execution                               |
| C    | Messages/Codex flows; window capture and zoom        | Stable action/window contracts; app-specific results and phone-video evidence |
| D    | Cursor integration and communication approval design | Shared frame/action mapping; independent background-input proof               |
| E    | Release, physical call acceptance and rollback drill | All advertised capabilities passed; signed-off local handoff                  |

The lead owns shared contracts, configuration, integration and deployment.
Connector and Mac/media specialists work in non-overlapping files after the
contracts are agreed. An independent reviewer covers replay, permissions,
protected-host boundaries and failure recovery. Candidate integration points
include `src/control/cua-contracts.ts`, `bundled-cua-runtime.ts`, `line-runtime.ts`,
`scripts/task-server.ts`, the planner and a new driver adapter under
`connectors/agents/`, and `line/agent.mjs`, `screen.mjs`, `picture.mjs` plus new
video-framing tests. Exact new filenames follow the Phase 1 API findings.

Do not promise a delivery date before the driver spike. Its output determines
whether this is a direct adapter integration or requires a different supported
route for a required app. The first useful release is verified background app
work with clear status; zoom and cursor polish follow the same evidence gates.
