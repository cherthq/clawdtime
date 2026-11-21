# ClawdTime phone, navigation, and automatic zoom test handoff

Updated November 21, 2026, America/New_York. This is the continuation document
requested by the user after the latest phone test showed no avatar.

## Start here

**The integration code is implemented, but phone acceptance has failed twice.**
Do not call the feature complete or ask the person to retry until the current
startup failure is diagnosed and the matching test runtime is ready.

- Worktree: `/Users/garygao/clawdtime-spaces-zoom-integration`.
- Branch: `spaces-zoom-integration` (do not use a `codex/` branch).
- Draft integration PR: <https://github.com/cherthq/clawdtime/pull/56>.
- Current implementation commit: `481706be116b1eb7e1adc47067dd3f70986fa67e`.
- This handoff may be committed after that implementation commit; use the actual
  current Git head when recording subsequent work.
- Main incorporated through `fc2bfe4c2815b5acc1429b7f32059543da085658` (PRs #54/#55,
  including Anish's job-result reporting). Recheck remote changes before a later
  integration; do not silently discard branch work or replace the test version.
- PR #51 and #53 histories are integrated; PR #38 must remain untouched.
- Do not change `/Users/garygao/apple-teams` or sibling `chert-facetime`.
  Preserve unrelated work in `/Users/garygao/clawdtime` and other worktrees.

Read these files, in order, before continuing:

1. Applicable `AGENTS.md`, `IMPLEMENTATION_PLAN.md`, and `SESSION_PROMPT.md`.
2. This file (latest operational state takes precedence over older test notes).
3. `docs/APP_DESKTOP_NAVIGATION_PLAN.md`.
4. `docs/SPACES_ZOOM_INTEGRATION.md`.
5. `docs/DESKTOP_SPACES.md` and `docs/AUTOMATIC_CALL_ZOOM.md`.
6. Relevant current source in `line/`, `connectors/computer/`,
   `connectors/agents/`, `src/control/`, and `mac/`.
7. `docs/LINE_HANDOFF.md` for invariants, not its historical line identities.
   Its November 11 migration details are not the current November 21 BYOR setup.

The lead coordinates integration, secrets and all live operations. Use specialists
only with explicit file ownership under the repository instructions. No specialist
may independently claim the phone line or operate the Mac.

## What the user wants

The agent should work naturally on the Mac during a phone screen-sharing call:

- Activate a named app or exact window, including a qualified full-screen app.
- Return to the previous app with Command–Tab.
- Move one desktop left/right like the three-finger swipe, using the Mac's actual
  configured Mission Control shortcuts, and support verified previous-desktop
  history. Keep app switching and desktop switching as distinct operations.
- Type/click in the intended app, including an unsent Codex textbox.
- Show continuous screen video with Screen Studio-style automatic click/typing
  zoom, smooth movement, overview, explicit resume and aligned cursor labels.
- Widen during app/desktop transitions, retire old coordinates, and zoom again
  only after fresh destination context.
- Interpret ordinary language dynamically. **Never require exact wording,
  punctuation, capitalization, a phrase list, or fuzzy text similarity between
  the voice model and a speech transcript to authorize a request.**
- Preserve local Stop, exclusive control, freshness, one-use requests,
  post-action verification, and unknown-outcome protection.

The user initially qualified a background Cua Driver setup, but the current
integration is the newer Supervisor/native foreground-control architecture.
Do not revive the old driver or assume its permissions qualify another app.
Earlier Messages/email qualifications are historical and are not fixtures for
the current test. Use only disposable app content and unsent drafts for this
acceptance.

The user prefers action over repetitive confirmations. Existing authorization
covers isolated testing, reversible idle line handoff, fixing the branch,
checks, push and PR updates. It does not authorize sending a draft, merging,
replacing the normal installation, initiating outgoing calls, or overlapping
line/control owners. Ask only for an actual new prerequisite or hands-off interval.

## Implementation and commits

| Commit / source                                   | Purpose                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| PR #51 `6942cb51e88c8eaf8ead699217dedd9ddbda0540` | Verified app/window and desktop transition work                                   |
| PR #53 `420b08cb20fd182fec252c226b1bb5bb09b72327` | Continuous capture, automatic zoom, transition latch                              |
| `785d991`                                         | Original combined integration                                                     |
| `9ce7880`                                         | Handle inherent Fn bit in actual Control-arrow shortcut inventory                 |
| `26f18f3`, `ba19c25`                              | Dynamic navigation and task-question ownership fixes                              |
| `c9e4145`                                         | One bounded activation for a named running app with successful empty AX inventory |
| `e885381`                                         | Reject oversized transport requests without truncating trailing constraints       |
| `481706b`                                         | Replace exact speech-text matching with provider turn / SDK response identity     |

Native navigation uses goal-only structured model interpretation. Screen content,
job news and planner history cannot authorize navigation. Each standalone request
performs at most one checked transition. Generic key commands cannot bypass that
path. Named-window ambiguity remains refused. A successful empty AX inventory
allows one targeted app activation only for a running named app without an exact
window request; subsequent discovery is read-only. AX errors do not widen scope.

The current speech path is in:

- `line/desktop-intent.mjs`: provider input identity, successful final transcript,
  explicit response generation, SDK response-handle binding and parent-chain
  continuation, freshness, cancellation and diagnostic codes.
- `line/caller-tools.mjs`: actual argument-free `ask_clawdtime`, separate one-use
  sharing/zoom/framing capabilities, and authority-reducing Stop/hide tools.
- `line/call-end.mjs`: synchronous retirement when the exact caller leaves, the
  room disconnects or the SDK session closes, before asynchronous teardown.
- `line/agent.mjs`: current production wiring.
- `line/desktop-intent.test.mjs`: 22 binding/runtime cases, including actual SDK
  tool wrappers and response handles.

Important SDK findings (installed LiveKit 1.8.0):

- `RealtimeSession` exposes `openai_server_event_received` before SDK handlers.
- Raw speech-start `item_id` identifies the input. Only a successful provider
  transcription-completed event authorizes that input's full transcript.
- The SDK can synthesize `isFinal:true` from partial text after transcription
  failure. A generic `UserInputTranscribed` final is insufficient authority.
- Automatic VAD `create_response` is disabled. The successful final schedules
  `session.generateReply()` after the SDK inserts its user item (microtask).
- `generateReply()` returns a thenable `SpeechHandle`; bind it synchronously,
  **do not await it**. Tool execution exposes `opts.ctx.speechHandle`; tool
  continuations have a public `parent` chain.
- Tool-call IDs are not provider input IDs. Never use “latest text” as fallback
  authority for a greeting, proactive job notice or an unrelated response.
- A missing final times out after 15 seconds and produces an unbound,
  tool-disabled notice. There is no artificial delay after a successful final.
- Zoom and picture-framing runtime phrase gates were removed. The voice model
  selects bounded structured actions tied to the caller turn. Semantic accuracy
  still needs physical testing; the change does not make the model infallible.

Transport rejects raw requests over 2,000 characters before normalization or
routing. It never silently truncates an instruction. Direct task-service software
goals retain their existing complete 8,000-character support, with no oversized
fallthrough to native navigation. Failed forwarding must not invoke another
executor or replay the request.

## Evidence: what passed and what did not

### Automated and synthetic

At `481706b`:

- `npm run check`: **3,938 tests**, 126 files, typecheck/build passed.
- `npm --prefix line test`: **105 tests**, including 22 speech/runtime cases.
- Changed-file formatting and `git diff --check` passed.
- Independent source review found no remaining speech-path blocker.
- Native source unchanged since its **295 Swift tests and panel build** passed.
- Python presentation source unchanged since **36 tests** passed.
- Earlier headless navigation model smoke: **10/10** synthetic intents matched.
- Actual `gpt-realtime` + installed SDK synthetic audio smoke: direct Codex typing
  and sharing → typing both forwarded the complete provider transcript once,
  including the no-submission constraint. All effects were stubbed: **no phone
  call, capture, keyboard or mouse input**. This did not exercise caller joining,
  bridge readiness, avatar publication, or real handset video.
- Headless smoke provider/session cleanup was confirmed. Remaining harness
  runtime handles required ending the isolated process; do not mistake these
  synthetic checks for physical call teardown qualification.

Six pre-existing whole-repository formatting warnings were documented earlier;
do not reformat unrelated baseline files merely to obtain a clean global report.

### Local physical navigation: passed

Using isolated native binary `c9e4145`, one display, ordinary TextEdit and
full-screen Claude:

1. Named app request: TextEdit → Claude.
2. Previous-app request: Claude → original TextEdit window.
3. One desktop right: TextEdit → Claude.
4. One desktop left: Claude → TextEdit.

All four passed controller arrival verification, independent foreground/window
inspection, and the person's visual confirmation. Requests used natural
paraphrases. Earlier builds had unknown arrivals; each was reconciled before
new work. Their historical failures do not negate this later successful run.

Previous-desktop history, destination editing, live phone navigation/zoom and
Stop/takeover still require their own physical acceptance. Split View and
multi-display navigation remain unsupported. This is not background control
while the person works independently elsewhere.

### Phone test 1: sharing present, all Mac requests failed

November 21, **11:46:58–11:49:09 ET**:

- Sharing requested at 11:47:19.
- Five `ask_clawdtime` attempts; zero desktop chat requests; worker idle, step 0.
- User reported repeated “couldn't process” responses. They later recalled
  asking to type “Zoom” into the Codex textbox on the same desktop.
- Exact-text validation independently reproduced rejection for a missing period
  or capitalization difference. This was the leading explanation, not a proved
  per-request diagnosis: the old logs lacked rejection codes.
- `481706b` removes that exact-match design. Do not revert it to address the
  subsequent startup problem.

### Phone test 2: latest blocker — no avatar

The corrected test owner became ready at **12:38:53 ET**. Latest call:

| Time ET  | Observed event              |
| -------- | --------------------------- |
| 12:41:57 | Incoming and accepted       |
| 12:42:14 | Provider `call_media` event |
| 12:42:32 | Call ended                  |

The fresh agent log has worker/job-level entries and `call_ended`, but **no
`call_started`, greeting, speech binding, or request events**. The provider log
has **no `call_bridge_ready`** for this call. The user saw no avatar. The test
computer remained idle at step 0, with no current presentation event.

This fails before the speech-forwarding assertions exercised in the synthetic
smoke. **Root cause is unknown.** Health 200, `dev_connected`, `agent_warm`, and
provider `call_media` did not prove caller-visible video. Do not claim that the
avatar or bridge was ready from those signals.

The log wrapper intentionally drops arbitrary SDK message/error payloads and
retains only `code`, `clawdtime_line`, binding/call IDs, `retained`, and `level`.
The low-detail level-only entries cannot establish the missing stage or exception.
Improve bounded diagnostics rather than enabling broad speech/credential logs.

Priority investigation:

1. Trace actual agent entry → `ctx.connect` → `ctx.waitForParticipant` → exact
   caller resolution → new `bindCallEnd` wiring → `makeCallVideo` → `call_started`
   → first frame → camera-track publication → session start → bridge-ready/greet.
2. Determine whether waiting for the participant never completed, an exception
   occurred before `call_started`, the caller/room was mismatched, or provider
   bridge readiness failed. These are hypotheses, not findings.
3. Add stage codes and sanitized error names/codes/source locations, no raw
   transcripts, audio, screen images, tokens, identities or arbitrary error text.
4. Check provider job/worker/room ownership with fresh evidence and compare the
   unchanged known-working normal agent's startup wiring. Do not modify sibling
   services or assume the new lifecycle hook is guilty without reproduction.
5. Reproduce startup with an actual room/caller lifecycle or a faithful integrated
   harness. The prior synthetic standalone AgentSession test omitted this layer.

The actual installed SDK enum values for participant disconnect, room disconnect
and session Close were checked and exist. That narrow check does not validate
callback timing or the rest of startup.

## Runtime inventory and private evidence

These are local paths, not files to copy into Git. Never print credentials or
copy runtime customer/conversation data into tracked fixtures. Recheck PIDs and
ownership; do not reuse historical PIDs.

| Component                      | Location / setting                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Isolated native app            | `/Users/garygao/Applications/ClawdTime Integration Test.app`                                         |
| Test bundle ID                 | `com.clawdtime.supervisor.spaceszoomtest`                                                            |
| Test native binary version     | `c9e4145`; unchanged by later JS/TS fixes                                                            |
| Fixture root                   | `/Users/garygao/.local/share/clawdtime-spaces-zoom-test-20261121`                                    |
| Fixture service                | `state/`, loopback port **13376**, disposable `project/`                                             |
| Fixture control config         | `config/`; native worker configured, coding simulation, jobs off                                     |
| Fixture phone files            | `phone/agent.jsonl`, `phone/dev.jsonl`, `handoff.json`, `retest-offsets.json`                        |
| Fixture evidence               | `acceptance-state.json`, `physical-*.json`, `phone/call-trace.json`                                  |
| Normal native app              | `/Users/garygao/Applications/ClawdTime Supervisor.app`                                               |
| Normal service                 | port **13356**, state `/Users/garygao/.local/share/clawdtime-supervisor-anish/main-desktop-20261121` |
| Normal control config          | `/Users/garygao/.local/share/clawdtime-supervisor-anish/supervisor`                                  |
| Normal source                  | `/Users/garygao/.local/share/clawdtime/line-source`                                                  |
| Normal phone state             | `/Users/garygao/.local/share/clawdtime/line`                                                         |
| Normal tmux session            | `clawdtime-line`, windows `agent` and `dev`                                                          |
| Test tmux session              | `clawdtime-line-integration-test`, windows `agent` and `dev`                                         |
| Test phone agent name / health | `clawdtime-integration-test`, **8082**                                                               |
| Normal phone health            | **8081**                                                                                             |
| Node / Chert CLI               | `/Users/garygao/.nvm/versions/node/v24.22.1/bin/`                                                    |

The normal native app/service has not been replaced or restarted. Both TCC grants
were previously confirmed for the isolated test app, and its binary identity has
not changed. Do not ask for grants again unless a fresh check actually fails.
The older root `clawdtime-supervisor-anish/desktop-panel.json` pointing to port
13346 is stale; use the normal state path in the table.

Private helper scripts in fixture `phone/`:

- `check-ready.mjs`: read-only provider ownership/idle and desktop readiness;
  prints redacted booleans. It uses the latest matching dev receipt, not a
  display-name comparison. `draining` historical disconnected bindings may be
  present; inspect them without treating them as active connected owners.
- `launch-phone.mjs agent|dev`: launches pinned integration source, unique agent
  name and health port, fixture CLI/config/state/project. Dev claim is bounded to
  30 minutes. No `--takeover` or `--force`.
- `phone-cli.mjs`: forwards `chat` once to the exact fixture service; no fallback
  executor. Allows bounded read-only jobs/view/recent-chat commands.
- `release-original.mjs`, `release-test.mjs`: fresh idle/owner check, one Ctrl+C,
  wait for a **new** `dev_stopped` receipt with `retained:0`; no blind retry.
- `restart-test-service.mjs`: historical helper with a hardcoded old panel PID.
  **Do not run unchanged.** Reconcile current processes and credentials first.
- `speech-smoke.mjs`: headless real-model smoke using synthetic speech and stubbed
  effects. Reads protected credentials in memory, never a phone owner. Review
  before use; its process can retain SDK handles after explicit session close.

Protected configuration references (read only into memory, never print/copy):

- Phone env: `/Users/garygao/.local/share/clawdtime/line-source/line/.env.local`.
- Desktop model credential: `/Users/garygao/.local/share/clawdtime-supervisor-anish/model-credentials.json`.
- Provider CLI credential store: `~/.chert` (or configured `CHERT_HOME`).
- Fixture panel token: fixture `state/desktop-panel.json`.

Use no-follow file opening, regular-file/owner/mode checks for credentials.
The existing phone env's wrapper points at the **normal** desktop service;
launching the test line without the fixture overrides would test the wrong code.
The current separate `CLAWDTIME_LINE_RUNTIME_CONFIG` setting is unused by this
agent and is removed by the test launcher. Never pass the old runtime path as
proof of correct integration routing.

Read-only authenticated fixture routes:

- `GET /desktop/state`, `/desktop/chat`, `/desktop/computer`, `/desktop/presentation`.
- Never poll `/desktop/hands/next`; that consumes the native controller's command.
- `POST /desktop/chat` is an actual request and can cause computer input.
- Check `ComputerJournal` readability, unresolved outcomes and active requests
  before changing control ownership. Preserve all receipts. Do not clear an
  uncertain request until independently reconciled with the person/UI.

Avoid computer-use inspection that creates a system window-sharing overlay.
Earlier CUA inspection did this and disrupted qualification. Use the application's
own diagnostics and read-only AX/foreground checks; never mistake an inspection's
focus change for the test action succeeding.

## Handoff state and safe line procedure

At completion of this handoff, the failed test call has ended and the test owner
has released with **zero retained calls**. The final state was independently verified before this handoff:

- Normal phone agent restored as sole connected active owner.
- Normal computer switch restored to its prior enabled state (last native status
  was an idle blocked result, not a running action).
- Test phone processes stopped; test computer switch off.
- Isolated test app/service may remain running idle for later reuse.
- Capture is not active. No outgoing call was placed.

The normal owner was connected and warm; provider state was idle with one active
owner. Always re-run fresh readiness in a new session; do not treat this document as a
lease or as evidence that a later call is idle.

For another test:

1. Finish code fixes and checks first. Confirm one display and disposable target
   content; ask for an exclusive hands-off interval only when live input is next.
2. Check no active call and match the normal owner to its current dev receipt and
   configured project/line. Preserve rollback metadata and record current log
   byte offsets. Never copy secrets or the whole env into a new file.
3. Start only the uniquely named test agent in standby on 8082. Verify fresh
   startup and source, then release normal dev gracefully once. Require a new
   `dev_stopped retained:0` plus remote absence of an active owner before claim.
4. Gracefully stop normal agent. At an idle native boundary, disable normal
   computer control and enable only the fixture control.
5. Claim with the test `dev` launcher. Require fresh `dev_ready`, `dev_connected`,
   `agent_warm`, correct provider line/project/owner and matching fixture routing.
   Startup instrumentation still must establish actual caller/video readiness.
6. Tell the user when to place an incoming call to their existing contact.
   Never initiate an outgoing test call without a new explicit instruction.
7. End/reconcile the test and restore normal ownership with the same idle/release
   checks. Keep unknown results intact; no force, automatic input replay or
   simultaneous line/control owners.

**tmux pitfall:** the old normal `host.sh` uses prefix matching with
`tmux has-session -t clawdtime-line`. It can falsely report “already running” while
only `clawdtime-line-integration-test` exists. Use exact targets, e.g.
`=clawdtime-line:dev`, and confirm the test session has fully exited before the
old host's start. Do not kill an unrelated session to work around this.

The old `host.sh stop` also scans a short tail for `dev_stopped` and may see an old
receipt. Do not rely on it for this handoff; use fresh offsets and verify release.
No scheduled updater was present when inspected; an existing `update-hold` file
was preserved. Recheck if needed rather than assuming no future restart source.

## Remaining acceptance matrix

Proceed in layers; stop on failure and diagnose before involving the user again.

| Layer                       | Required checks                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup                     | Correct caller/room, avatar visible, audio greeting, bridge signal, no premature cleanup, bounded failure diagnostics                                                       |
| Speech forwarding           | Natural Codex/TextEdit typing request, punctuation/case independence, full no-submit constraint, exactly one delivery, same-turn sharing→typing                             |
| Native action               | Correct textbox/document, independently observed text, no Enter/submit, fresh frame, truthful completion/unknown result                                                     |
| Local navigation regression | Named app/exact window, previous app, left/right and previous desktop; verify destination before editing                                                                    |
| Phone navigation            | Same operations while sharing, including qualified full-screen pair; actual phone video follows destination                                                                 |
| Zoom                        | Agent click and focused typing, smooth 1.8×/400ms behavior, distant target, screen edges, long cursor labels, Retina mapping, Fit/Fill framing                              |
| Presentation controls       | Natural overview/disable/enable/resume wording, overview stays latched on enable alone, explicit resume releases; persistence across calls without stale target inheritance |
| Transition coordination     | Zoomed source widens before switch, stays wide while settling, retires old coordinates, resumes only after fresh destination context                                        |
| Safety/recovery             | Local Stop, spoken emergency Stop, takeover, disconnect/hangup, stale/missing/failed transcription, duplicates, late callbacks, unknown input and no retries                |
| Boundaries                  | No adjacent desktop, disabled/wrong shortcut, ambiguity, lock/sleep, capture loss, fresh restart; refusal without false success                                             |
| Performance                 | Real readability, voice responsiveness, latency, bandwidth, CPU/memory/thermals on a longer arranged call                                                                   |
| Cleanup                     | Capture clears on hide/hangup, no stuck actor/agent, no retained unknown calls lost, normal line restored with one owner                                                    |

Do not expand to Split View or multi-display navigation without a new scoped
implementation and qualification. Multi-display presentation behavior remains
unverified; report limits honestly. Do not claim synthetic render throughput or
unit-test success proves any handset acceptance item.

## Finish criteria for the next session

- Diagnose and fix the missing-avatar startup failure with concrete evidence.
- Keep the no-exact-matching speech design; test real SDK wiring, not only helper
  functions or stubs that omit the broken lifecycle.
- Run relevant line/backend checks after edits, and Swift/Python checks if those
  components change. Preserve unrelated work and regression coverage.
- Commit/push to `spaces-zoom-integration`, update draft PR #56 and these evidence
  documents around the final implementation. Do not merge or replace the normal
  installation without explicit instruction.
- Conduct the arranged physical matrix, record passes/failures/remaining limits,
  and always restore/reconcile line ownership. Never claim “ready to call” from
  health/registration alone if the actual media-startup defect remains unresolved.

## Startup investigation continuation — November 21, afternoon ET

Fresh read-only preflight found one connected active normal owner, no active
call, test computer disabled/idle at step zero, and normal computer enabled in
its prior blocked state. No phone ownership or native-control switch changed
while investigating.

The retained provider record for the 12:41:57 call reports `remote_ended`, with
incoming/answered/active/ended/cleanup events and **no bridge-ready event**. It
contains no failure explanation for the missing bridge. The discarded historical
`call_media.state` cannot be recovered from the wrapper log. In the installed
provider CLI, `call_media` is a delayed track assessment and can mean `no_audio`;
it is not evidence that the bridge joined.

The actual exported agent entrypoint, installed SDK `JobContext` participant
waiter, native RTC video source/track, picture renderer, and call-end hook were
exercised together. A standard caller joining reaches avatar publication. An
empty waiting room disconnect produces `call_ended` with no `call_started`, the
same historical log shape. **This identifies a plausible path, not the proved
historical root cause.** No deterministic failure in the new call-end hook or
video constructor reproduced.

A separate, reproduced startup race is fixed: a caller that joins and leaves
before the waiter continuation must not start video or a model session. Startup
now rechecks the exact participant object in the connected room. Repeated cleanup
awaits the same teardown, and an initial frame failure cannot proceed as if a
valid avatar frame existed. None of these findings justify claiming that the
12:41 missing-avatar cause has been fixed.

New bounded diagnostics cover entry, connection, resource preparation, caller
wait/resolution, call binding, first frame, camera publication, session start,
and bridge-signal wait. Room observations contain only connection/count fields.
Failures retain an allowlisted error class and source basename/line, never raw
error messages, identities, speech, screen pixels or credentials. The private
test launcher now preserves these fields and provider media verdicts. Startup
and health remain distinct from physical caller readiness.

`line/startup-smoke.mjs --env-file /absolute/protected.env` explicitly creates
one uniquely named LiveKit room/worker and a synthetic subscribing caller. It
uses isolated configuration, disables desktop CLI effects, publishes no caller
audio, and never claims a phone line. The real worker generated moving avatar
frames and greeting audio from the same publisher after a **synthetic** bridge
mark. Caller disconnect produced cleanup; the exact room was removed and the
worker exited. No frames/audio were recorded. This covers the lifecycle omitted
by the previous speech smoke; it still does not test FaceTime bridge arrival or
handset visibility. The smoke is opt-in and is not part of normal unit tests.

Validation: `npm run check` passed **3,946 tests in 127 files**, typecheck and
build. Standalone line tests passed **113 tests**. The eight new cases exercise
real SDK waiting/joining and RTC video construction, publication failure,
immediate/late departures, exactly-once cleanup and diagnostic sanitization.
Native/Python source is unchanged from the previously recorded passing checks.

Remote main advanced to `f495919` during this session (job conversation changes).
It has not been merged into this test branch or installed. Keep the startup
investigation on the pinned isolated version; reassess main integration separately.

The remaining prerequisite is an instrumented incoming-call observation of the
provider bridge/room boundary. Do not label it a fixed-startup acceptance run or
claim the full matrix passed. Begin with avatar/audio and no computer input;
only after observed startup proceed to the hands-off screen/control matrix.
If it fails, retain the stage and provider verdict, stop the run, and restore the
normal owner. Do not replay the call or computer requests automatically.
