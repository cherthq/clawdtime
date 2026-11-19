# Coding demo build log

## November 18, 2026 — source audit and step a

Branch: `demo/coding-flow`, isolated worktree `/Users/garygao/clawdtime-coding-demo`.
Fetched `origin`; approved main remains `8c8cf76`. Argos baseline is
`815d51b82aa81e62e857b08713a9d0b4324a5a6f`. Existing checkouts and untracked
product/walkthrough drafts were preserved. No merge, deployment, live call,
line operation or installed configuration change is authorized by this work.

Lead owns shared contracts, task service/routes, scripts, manifests and integration.
Connector specialist owns CLI/worker and connector tests. Transport specialist owns
encrypted task ledger and backend tests. Media specialist audits voice requirements
and independently reviews the step-a boundary; voice implementation waits for b.

Source audit confirmed that the old broker retains instructions only transiently,
the Codex runner conflates terminal execution with limited file-content checks,
and managed sessions conflict with streaming voice/presentation. Existing call
evidence includes a 422-second call and an unclassified camera failure, not a
qualified coding flow or duplex handset acceptance.

Decision: reuse main's SQLite transactions/receipts and AES-GCM Vault. Introduce
independent task sessions rather than weakening legacy original-chat guards.
Persist bounded task context encrypted, preserve run/check/call histories, and
reserve dispatch before invocation. Restarted active execution or verification
remains unknown; there is no automatic replay or generic force-success endpoint.
One unresolved worker fences dispatch globally in the small demo service.

The development service uses an explicitly labeled local fixture pairing, an
owner-only state directory, exclusive process lock, encrypted context, hashed
session credentials and an exact project allowlist. It does not establish phone
pairing acceptance. Live task calls, screen capture and control are disabled.
Step a accepts simulated worker events; later real mode restricts these to the
service. Developer CLI output is not on-camera content.

No Argos commits have been merged. Its runner and voice mechanics will be selectively
extracted only at their required stage; document/website/experimental features are
excluded. Presentation and desktop work remain gated behind physical c.1.

Validation and checkpoint results will be recorded here before committing.

### Step a checkpoint validation

- `npm run check`: passed TypeScript, 38 test files / 599 tests, and build.
- `npm run task:simulate`: passed; two distinct simulated runs, duplicate
  receipts, restart reload, independent synthetic reports, and explicit acceptance.
- `npm run task:service -- --state PRIVATE_DIR --project DISPOSABLE_PROJECT
--port 13320`, then `npm run cli -- task register`, `task create`, and
  `task status`: observed working over local HTTP; graceful shutdown/restart
  preserved the task and session. Credential files remained outside the project.
- Independent connector review: 20 ledger/CLI tests passed. Independent media
  authority review: 24 authority/ledger tests passed. Fixed stale prior-call events
  overwriting a newer run and independently fenced unknown call receipts.
- No Python/Swift source changed; component checks are not applicable to this step.
- `git diff --check`: an extra documentation EOF blank line was found and removed.
  Reviewed changed/new source for scope, secrets and authorization boundaries.

Runnable entry points: `npm run task:simulate` and `npm run task:service --
--state PRIVATE_DIR --project DISPOSABLE_PROJECT`; CLI details in CONNECTORS.md.
Step a is software/simulation evidence only. The tag `step-a-done` will identify
this checkpoint; its commit hash will be recorded in the next checkpoint.

## Step b — app-owned Codex runs and independent watcher

Step-a checkpoint: `6b976e0`, annotated `step-a-done`, both pushed to origin.
Selective extraction: `connectors/codex/app-server.ts` from Argos `815d51b`;
new task worker adapts its runner's terminal/approval/in-flight effect handling.
The old broker, remote document worker and website features were not imported.

Installed Codex is `0.166.0-alpha.5.1`; connector specialist checked local generated
App Server schema and official App Server documentation. A no-turn preflight
confirmed `on-request`, workspace-write, network disabled and all three inherited
MCP integrations disabled. OS environment allowlist excludes app/provider secrets.
Each run uses a new ephemeral thread; unexpected approvals are declined and the
adapter waits for actual terminal evidence. Unknown outcomes fence later dispatch.

The service owns dispatch and verification; public session clients cannot forge
worker or verification events in real-worker mode. A typed decision receipt starts
one new scoped run. Its response is nonblocking, so status remains responsive.
Context is bounded; native approval is not a human task decision. Verification
commands are explicit argv arrays with no shell, isolated environment, bounded
output hashes, timeouts and process-group cleanup. A submitted kill is not proof of
quiescence: unresolved descendants remain unknown. Prepared briefs cite current
run/check identities, and obsolete briefs clear before follow-up execution.

Runnable entry points:

```
npm run task:fixture -- /tmp/NEW_DISPOSABLE_DIRECTORY
npm run task:service -- --state /tmp/NEW_DISPOSABLE_DIRECTORY/state --project /tmp/NEW_DISPOSABLE_DIRECTORY/project --worker codex --checks /tmp/NEW_DISPOSABLE_DIRECTORY/checks.json
npm run cli -- task help
```

Register with the private operator file, create a task, then `task run --id ID`.
`task command` with `decide` creates and launches a scoped follow-up. After restart,
existing queued work requires explicit `task run`; unknown execution is never
replayed. The fixture has a deliberately unresolved empty state and independent
assertions outside the worker's writable project. It is not a production incident.

Independent reviews caught and fixed validation occurring after an earlier check,
kill-submission being mistaken for process termination, oversized context metadata,
and inherited environment secrets. Native approval boundaries remain intact.

### Step b validation and locally observed result

- `npm run check`: passed typecheck, **42 files / 642 tests**, and build.
- `npm run task:fixture -- /tmp/clawdtime-real-demo-20261118`, local service
  with `--worker codex --checks .../checks.json`, CLI register/create/run/command:
  two actual Codex invocations completed in **23,421 ms** and **24,181 ms**.
  First watcher report: independent filter/empty-state assertions failed, JavaScript
  syntax passed. The worker separately reported the seeded unresolved empty-state
  decision. A typed instruction created a distinct second run on the same task;
  replaying the exact decision returned `replayed:true` and retained two runs.
  Second watcher report: all six behavior assertions and syntax passed;
  authoritative state became `review_ready`. Task receipt/state retained privately
  outside the repository. No phone, screen capture, control or deployment occurred.
- `vitest` targeted engine/ledger/worker/verifier run: 57 tests passed. Media
  specialist ran 9 real-child-process verification tests; connector review checked
  current policy and native permission behavior. No remaining reviewed blocker.
- `npm run typecheck` and `git diff --check`: passed after final integration.
- No Python or Swift source changed; those component checks are not applicable.

The worker's own claim that its local checks passed did not overrule the first
independent failed report. Output hashes/exit codes are watcher evidence; these
checks do not prove browser/handset rendering or product acceptance. The real
fixture used a locally authorized synthetic pairing, not a phone-paired session.
`step-b-done` identifies this passing checkpoint; hash follows in next entry.

Final pre-commit rerun: `npm run check` passed **42 files / 643 tests** including
prepared-brief regression, typecheck and build. Independent diff review passed.

## Step c — local voice implementation, acceptance pending

Step-b checkpoint: `33526f9`, annotated `step-b-done`, branch and tag pushed.
The independent-task voice contract is separate from legacy AgentSession and uses
an additional voice-only credential. Explicit voice permission is immutable at task
session registration. Opening requires the exact current prepared brief; provider
conversation identity binds once and cannot reconnect/rebind. No phone call,
presentation, screen capture or shared-screen control capability is exposed.

The backend stores finalized utterances encrypted before a model tool can reference
them. Tools cannot substitute text, forge verification, or approve native permissions.
A finalized instruction is deduplicated by provider conversation and utterance,
independent of tool-call IDs. One instruction can wait during a run; it releases
only after the same run has a known terminal outcome and independent verification.
Hangup/voice Stop does not cancel already authorized coding. Restart never scans or
replays held instructions. Typed revisions cannot overtake an admitted held revision.

Review found a same-run timing race between transcription and worker completion.
Transcript storage now admits only monotonic source revisions for the same run;
finalization retains that original receipt and rechecks the current run/revision
inside the service. Newer-run rebinding and future/pre-opening revisions reject.
Unknown/canceled tasks can still hear status or hangup, but cannot start new work.

Media work uses a new local runtime and microphone/speaker page with one streaming
provider socket and one playback owner. Provider interruption owns normal speech
cancellation; local energy does not compete with it. Prepared first_message uses
the same provider/playback path as dialogue. Audio remains transient, and sink
scheduling is explicitly not handset audibility. Tool/status work is asynchronous.
No presentation code or step-d dependency was added.

External prerequisite: the existing original-chat ElevenLabs agent is not presumed
compatible with the independent task tool schema. A dedicated authenticated agent
with the reviewed task-only configuration and privately supplied credentials is
needed to run actual local speech. No ElevenLabs credential was read, provider changed, real
microphone started or handset called in this implementation. The user's prompt
requires authorization before credential/configuration work. Synthetic PCM and
protocol tests cannot complete step c, and `step-c-done` must not be created until
actual local spoken-session acceptance. Step c.1 and all later work remain gated.

### Step c candidate checks and observed local boundaries

- `npm run check`: passed **45 files / 668 tests**, typecheck and build.
- `media/.venv/bin/python -m unittest discover -s media -p 'test_task_voice.py'`:
  **20 passed**, including an actual localhost WebSocket with synthetic PCM and
  task HTTP callbacks. This is not a real ElevenLabs or human-speech session.
- Full media validation initially failed because existing `test_screen_wire`
  imports the gateway's `certifi` dependency. Installed the unchanged
  `gateway/requirements.txt` into the isolated venv. Rerun:
  `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'`:
  **211 passed**, no skips. Expected failure-fixture logs and an existing SQLite
  ResourceWarning were emitted; the suite ended `OK`.
- Local service + real CLI `task register --voice true`, synthetic worker lifecycle,
  `task voice-start`, `voice-status`, `voice-stop`: observed exact task/voice identity,
  prepared opening, false screen/presentation/control permissions and
  `{ended:true,taskCanceled:false}`. Temporary local service stopped cleanly.
- Independent connector review: eight voice-authority tests, voice CLI checks and
  20 Python runtime tests passed. Transport's integrated real TaskEngine/fake worker
  regression proves one held spoken revision releases after verification, including
  voice end, without replay. Unknown outcomes keep the held receipt blocked.
- No Swift source changed; Swift checks are not applicable. No gateway source
  changed; its existing dependency manifest was installed for media wire coverage.
- Reviewed source diff for credential handling, unrelated scope and weakened guards.
  `git diff --check` passed. No real secrets, audio, screenshots or personal messages
  were added to tracked files.

A final frozen-source full check will precede the partial step-c checkpoint.
The reviewable provider configuration is `media/task_voice_provider.example.json`;
local entry point and precise authorization prerequisite are in
`docs/MEDIA_INTEGRATION.md`. Recommended next action is authorization to create a
separate task-only ElevenLabs agent using the existing approved voice and to access
its protected credential for one local mic/speaker qualification. An already
configured compatible agent is an alternative that avoids provider changes.
Remaining synthetic-only preserves current safety but cannot complete c.
No c, c.1, d or e tag has been created.

Final frozen-source validation before the partial c commit: `npm run check` passed
45 files / 668 tests, typecheck and build; full media unittest passed 211 tests
with no skips. Original Argos checkout still has the same four untracked drafts;
no changes were made there. The partial-c commit is intentionally untagged.

## November 18, 2026 — authorized local voice qualification

The user explicitly authorized protected ElevenLabs credential use, a dedicated
independent-task agent, and local microphone/speaker qualification. This does not
authorize a handset call, line operation or deployment. Only the lead accessed the
owner-only provider configuration; existing provider agents remain unchanged.

Read-only schema and account preflight found concrete integration gaps: local Python
needed an explicit certifi trust store; provider tool schemas reject JSON Schema
`additionalProperties`; normalized agent reads use referenced tools plus inline
definitions and an inert start-only workflow. The first create returned a definite
422 and its rejected receipt was preserved. The corrected create returned 200;
its receipt and credentials are stored outside Git. No uncertain create was retried.
GET validation now fetches each of the three exact referenced tools, rejects mocks
or non-client behavior, compares complete normalized definitions and permits only
observed inert provider defaults. Privacy, overrides, TLS verification, absence of
active hooks/export destinations and explicit interruption settings remain checked.

A fresh real Codex run finished in 21,889 ms and independent checks found the
intentional unresolved empty state. The local opening projects the same verified
evidence as a concise question without developer fixture/check names. No worker,
report or task revision was replayed to update that wording. The task service was
restarted only while that run was known terminal and awaiting its decision.

Local qualification uses the existing Mac microphone/speaker only, explicit browser
Start, a separate voice capability and no screen capture. Application timing export
contains bounded counts and monotonic times, no transcripts/audio/credentials.
Browser onset/queue-clearing timing is not physical audibility or handset evidence.

First local audio attempt: the user heard the prepared introduction but reported
no response to speech. Application/provider metadata showed one agent turn and no
finalized human turn; no instruction or follow-up run was dispatched. The provider
reported a clean client disconnect and the local voice receipt ended. This is a
failed conversational qualification, not a completed step c. Input signal/transport
was not measured in that build, so the cause remains unproven.

Added content-free per-hop PCM counts and aggregate peak/RMS values, plus a
browser-only microphone label and live level meter. Neither microphone labels nor
raw PCM are retained. A real Chromium fake-microphone test exercised the actual
HTML/AudioWorklet, binary browser socket and local fake-provider base64 path with
matching nonzero chunks/bytes. It also exposed concurrent close callers observing
stopped admission before completed cleanup. Close now joins one shielded cleanup
task; the browser regression verifies the completed close event.

The second local attempt uses a fresh voice admission for the same terminal task
and new private diagnostic file. The previous voice is ended; its receipts remain
preserved. No uncertain external effect, coding instruction or run was replayed.

Second local attempt: closed after approximately 2.9 seconds, with zero PCM input
chunks and three scheduled output chunks. The subsequent playback acknowledgement
timed out. Both local end/close and provider done/client-disconnect receipts were
confirmed; no human transcript or new run exists. The user observed no microphone
meter movement and suspected a phone/Continuity microphone. This establishes a
local audio-path failure; provider ASR failure is not established. Read-only agent
inspection confirmed audio mode (`text_only:false`) and PCM 16 kHz input.

Rather than connect another provider conversation without microphone evidence,
the local page is being changed to check the selected microphone first, display
its signal/context state, and allow an explicit device choice before Start voice.
No system microphone preference or phone-line setting is changed automatically.

Validation before the microphone-preflight edits: `npm run check` passed 671 tests
in 45 files, typecheck and build. `media/.venv/bin/python -m unittest discover -s
media -p 'test_*.py'` passed all 217 tests in 51.981 seconds. Independent connector
review passed 26 task-voice tests including Chromium fake-mic transport, plus 42
backend authority tests and a concurrent-close cancellation probe. Review found
no permission/privacy weakening; it requested child-process cleanup on harness
timeout and opening with the actual question. Both are assigned for correction;
full frozen-source checks will be rerun before any commit.

The revised local page separates microphone qualification from provider startup:
Check microphone captures locally, offers explicit input selection, shows live
signal and audio state, and enables Start voice only with recent nonzero PCM,
a running context, and a live unmuted track. Suspended audio has an explicit
Resume control. Local Stop and device changes dispose old graphs; generation and
attempt tokens reject late device acquisition and old worklet samples. No preflight
samples leave the browser. Provider audio-only mode is now explicitly validated.
The synthetic browser regression also exercises suspended refusal, delayed device
acquisition/Stop/recheck, no provider opening before Start, and cleanup. Its owned
child process group is terminated/joined on timeout. No user Chrome process is killed.

The first sentence now directly states the actual decision question, as requested
by independent review. Projection changes no existing task or verification receipt.

Frozen-source validation for the local-audio diagnostic checkpoint:

- `npm run check`: 45 files / 671 tests passed, typecheck and build passed.
- `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'`:
  all 217 tests passed in 52.107 seconds, including final Chromium preflight code.
- Independent connector final review: no remaining actionable blocker in preflight,
  capture-generation/attempt fencing, Stop/recheck or permission/privacy boundaries;
  separately reran 25 runtime tests successfully. Media final targeted suite passed
  26 including actual Chromium with synthetic microphone and fake provider.
- No Swift/gateway source changed; Swift validation is not applicable.
- `git diff --check` passed; changed source reviewed for unrelated edits and literal
  credentials/provider identities/capability URLs. None were added.

A third local voice capability is admitted for the unchanged known-terminal task,
but the user is first checking microphone signal locally. This checkpoint remains
partial step c: no successful spoken instruction/follow-up-run acceptance yet,
no step-c tag, and no handset authorization or presentation work.

Local attempt three (after commit `6766062`): the user confirmed the selected
microphone meter moved and reported the conversation was good. The provider and
local metadata independently show two human turns, three agent turns, 245 PCM
chunks/784,000 bytes received and sent, and clean local/provider closure after
approximately 25 seconds. First output scheduling occurred at 893 ms; this is not
an audible-latency measurement. No client tool, instruction, or follow-up run was
created. Thus two-way local speech is observed, but the step-c coding handoff and
status-while-working result are still unqualified. Browser Stop ended this session;
voice hangup, deliberate interruption, and a 20-second quiet interval are not
independently established by its event trace.

The user requested continuation. A fourth, fresh local voice admission is prepared
for a focused instruction/status/coding-result test against the same task. The
third session was confirmed ended/done before preparing it. No prior speech or
external effect was replayed. Step c and c.1 remain untagged.

## November 18, 2026 — step c locally qualified

Runnable result observed on this Mac using the dedicated task-only provider agent
and real Codex worker: one voice conversation discussed the existing task, accepted
a spoken instruction, started exactly one distinct follow-up run and answered a
status question during that run. The user confirmed the status response while the
backend was running. The independently verified task is now `review_ready`.

Evidence, with content/credentials kept in owner-only storage outside Git:

- Initial known-terminal run: 21,889 ms, deliberately failed empty-state check.
- First spoken instruction: exactly one applied receipt and new run, 23,688 ms.
  Independent verification caught the singular text “No task match”; the Clear
  filters hook and syntax were present. The worker's completion claim did not pass
  verification or trigger a false ready state.
- A spoken correction in the same voice conversation created exactly one further
  applied receipt/new run after the previous run's verified terminal outcome.
  It completed in 13,656 ms. All six independent behavior assertions and JavaScript
  syntax passed; no unresolved decision remains. Two accepted instructions map to
  two distinct follow-up runs on the original task, without overlapping execution.
- Local runtime metadata: six finalized human turns, two instruction requests and
  two returns, one status request/return while the first follow-up run was active,
  2,120 PCM chunks / 6,784,000 bytes received and sent, no runtime failure event.
  First output scheduling was 762 ms after runtime start. This is application
  scheduling evidence only, not a measured audible-response latency.
- The user reported hearing the verified result and an ending. However, fresh
  browser/backend observations still showed live audio, and no
  end-call tool was recorded. The lead pressed visible Stop voice;
  mic tracks and audio context closed, the backend end receipt returned, the
  provider reported done/client-disconnect, and runtime cleanup completed. Spoken
  hangup remains unconfirmed; it is not claimed as a passed acceptance check.
- The session lasted approximately 212 seconds. Deliberate interruption latency,
  the quiet 20-second pause, ten-minute continuity and handset behavior remain
  unqualified. No handset call, screen capture, presentation, control or deployment
  was performed. No line ownership was changed.

Independent connector review checked the approved step-c runnable gate and the
same-task sequential revision semantics. A verifier failure followed by a correction
is an allowed task loop. Step c is locally qualified; this does not qualify the
c.1 handset smoke test or full release/polish acceptance. Media documentation was
updated separately by its owner; no runtime code changed after `6766062`.

Pre-commit validation:

- `npm run check`: 45 files / 671 tests passed, typecheck and build passed.
- `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'`:
  all 217 tests passed in 54.943 seconds, no skips.
- Swift and gateway sources unchanged; Swift checks not applicable.
- Only BUILD_LOG and MEDIA_INTEGRATION documentation changed in this checkpoint;
  no protected task transcripts, provider identities, credentials or raw audio are
  included. Diff/whitespace checks and independent connector documentation review passed.

Checkpoint will be committed and pushed with annotated `step-c-done`. The next
required gate is specifically authorized c.1: one voice-only handset smoke test
through Chert, after verifying the intended test handset and exclusive line
ownership. Presentation, screen capture and shared-screen control remain disabled.
No automatic redial or reuse of this local-audio authorization is permitted.

## November 18, 2026 — offline preparation for the deferred handset test

The user deferred c.1 to the morning of November 19 and explicitly asked for as
much preparation as possible without further input. This did not authorize a
call tonight or waive the c.1-before-d/e gate. No calls, deployments, live rooms,
line changes, screen capture or control were performed. The chat is flagged
“ClawdTime — Nov 19 handset voice test next”; `docs/NEXT_SESSION.md` is the morning
handoff. Step c remains `46a64fb` / `step-c-done`; no c.1/d/e tag is created here.

Concrete audit findings shaped the work: the existing independent task path was
local-audio only; the legacy native call route unconditionally enabled screen and
video. The gateway is a screen/input relay and is not required for voice-only
media. The local task used a fixture pairing, not a real handset identity. Its
24-hour session expires before the requested next-morning return. None of those
facts was bypassed or relabeled as handset readiness.

Implemented preparation:

- Read-only `task readiness` exposes sanitized ownership/expiry, task/run/revision,
  verification and unresolved cleanup state, even after expiry. It does not expose
  task prose or permit expired-session execution. Explicit operator reauthorization
  preserves exact pairing/member/device/host/project/voice authority and existing
  token/history; it refuses unresolved runs, held instructions, unended voices and
  any unresolved handset attempt. Replay does not extend TTL again. There is no
  automatic renewal or recovery of unknown execution.
- Separate handset voice admission is internal, immutable and status/end-only.
  Both backend and media refuse coding instructions. Context exposes its exact
  mode/call-attempt identity. Local voice retains its previously qualified behavior.
- Added an encrypted one-call coordinator and narrow Calls/local-media HTTP ports.
  Default dispatch is disabled; each phase is durably recorded before an external
  effect. One authorization binds the entire plan and expires within five minutes.
  Global unknown fences survive restart/voice end; read-only inspection never
  redials. Explicit Stop in standby can clean owned effects. Local media closed
  and native cleanup_complete are separate evidence. Delayed prepare/dial/activate
  cannot release the reservation early or recreate media unnoticed after Stop.
- Added a separate LiveKit audio-only adapter and loopback controller. Startup and
  GET status have no room/provider effects. Preparation validates the dedicated
  provider read-only, creates only a scoped silent audio publisher and never a
  camera/video track. Activation checks authoritative handset mode/attempt, exact
  connected call and incoming worker identity. Worker/agent token directions are
  distinct and validated. Interruption clears the one playback owner; cleanup is
  joined and preserves uncertain room-create outcomes. No legacy media/session
  guard, gateway or companion permission was weakened.
- Review openings now use the first product-result sentence plus the authoritative
  verification result, omitting later stale worker validation/pending claims.

Independent review found and fixed delayed-cleanup races and a cross-language
fingerprint mismatch for absent media status. Regression tests now cover those
cases. Connector reviewed transport/media/authority; transport independently
reviewed CLI changes. The initial broad TypeScript check found one old exact
permissions assertion missing the new local instructions:true field. It was fixed
with an exact assertion plus a new handset status-only/end authority regression;
no runtime guard was removed to satisfy that test.

Observed non-live runnable checks:

- Actual loopback-controller CLI started from new owner-only synthetic files;
  outbound Python sockets were prohibited. Authenticated GET reported absent,
  the room journal had zero attempt rows, and SIGTERM exited cleanly with code 0.
  No prepare/activate command was issued. Temporary test configuration was removed.
- The real local task service shut down, restarted against the same protected
  store/project/checks and returned readiness: review_ready, revision 11,
  verification passed, no unended voices or blockers, handsetDispatch:false.
  No Codex run or voice conversation was started. It was shut down cleanly again;
  ports 13323/3321 are closed and the task owner lock is absent.
- A private credential-free next-session record preserves exact resume identities
  and paths. Three completed runs and four ended local voice sessions are retained.
  No renewal was performed tonight. An expired parent with an unended voice would
  still require separate proven cleanup; renewal deliberately cannot bypass it.

Frozen-source pre-commit validation:

- `npm run check`: all 49 files / 722 tests passed; typecheck and build passed.
- `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'`:
  all 244 tests passed in 53.754 seconds, no skips.
- New handset media tests include real pinned SDK frame/resampler/token-shape
  checks without a live room, plus fake media/provider transport. Independent
  focused review ran 47 TypeScript and 27 handset-media tests successfully.
- No Swift or gateway source changed; Swift checks are not applicable.
- Original Argos checkout still has the same four untracked product/walkthrough
  drafts. No Apple Teams or sibling chert-facetime changes were made.

Remaining before the physical test is concrete: fresh specific one-call
permission; verified real pairing/tester, exact current native line ownership,
idle/cursor/cleanup evidence; protected Chert and LiveKit configuration; and the
production authority/readiness composition connecting these prepared components.
There is deliberately no enabled production entrypoint assembled from fixture or
synthetic evidence. The live worker's audio-only capability, spoken hangup,
handset acoustics/timing, quiet pause and interruption behavior remain unverified.
Presentation and desktop implementation remain gated on the actual c.1 result.

### c.1 live setup — November 18, 2026

The user returned and explicitly authorized one voice-only call to the paired
handset. A separate explicit approval permits temporarily redeploying only the
existing ClawdTime backend in standby and restoring its prior live settings after
confirmed cleanup. The prior hosted backend was live; `/internal/drain` is not a
pause API. No Apple Teams or sibling service change is included.

Added the composed operator entry `scripts/task-handset.ts`, a private immutable
one-call task-to-handset grant, an in-place read-only native inspector, exact
native audio-protocol/prerequisite checks, a temporary local Stop control, and a
monitor that closes both local audio and the native call on spoken end, handset
hangup, expiry, Stop or failure. The original fixture task/pairing/history stay
unchanged. The destination is revalidated independently before every forward
phase; it is not imported as a replacement task pairing. Private task state has
one owner, and all external phases retain durable unknown-outcome fences.

The native inspector executes bundled source against read-only SQLite in the
existing backend container. It requires the exact verified standby deployment,
current runtime mode, current pairing/allowlist, preserved native cursor, no
unresolved legacy work and fresh worker audio readiness. It exports only bounded
readiness evidence. The coordinator remains separate from the original-chat
voice route; no old session is repurposed.

LiveKit API calls now use verified certifi TLS, SDK failover disabled, exact
CreateRoom/DeleteRoom URLs and redirects disabled. A real installed-SDK regression
establishes one submission on HTTP 503 and no follow on HTTP 307. Review caught and
fixed the local Stop browser-global collision, cookie parsing, startup admission
race, duplicate-start rejection handling, cleanup confirmation/join ordering,
standby transport-vs-runtime mode distinction and connected native-hangup handling.

Validation so far: `media/.venv/bin/python -m unittest discover -s media -p
 'test_*.py'`: **245 passed in 55.525s**. `npx tsx
tests/task-audio-stop.browser.ts`: a real headless installed-Chrome click reached
authenticated Stop exactly once, with no call/media. Bundled Playwright Chromium
was absent; the test explicitly uses installed Chrome. Native source review
confirms microphone-source audio-only support; a fresh deployed inventory reports
`outbound_audio_protocol:1` and complete prerequisites, with actual system capture
explicitly deferred to call start. These are not physical handset acceptance.

Protected scoped Calls/LiveKit configuration was obtained for this authorized
setup without printing secrets or importing customer/runtime databases. The
standby configuration mutation is journaled privately before submission. Actual
call/cleanup results and the final full TypeScript check are recorded below when
known. Step c.1 is not yet complete; d/e remain gated.

#### First authorized handset attempt: failed, fully cleaned up

Exactly one Calls API creation was submitted. Native events show dialing at
15:35:33Z, active/bridge_ready at 15:35:46Z, ending at 15:35:56Z and
failed/cleanup_complete at 15:36:00Z on November 18. The call was explicitly
`audio:true, video:false`; native terminal detail was `bridge_remote_audio_timeout`.
The user reported: it hung up without saying anything. No provider conversation
bound, no media activation receipt was created, and c.1 did **not** pass.

Local silent room preparation succeeded. The native end submission retained an
unknown receipt, but exact read-only native cleanup evidence and local media
closure subsequently established that the call was closed. No effect was retried
and no second call was made. The local owner joined media shutdown and exited.

The existing hosted backend was restored after cleanup. Its new deployment is
successful, every preceding recent deployment is removed, the complete variable
snapshot matches the original, and runtime reports live/traffic enabled with
zero active calls and zero pending/unknown effects. Railway rebuilt the container
image during configuration-only redeployment; the image digest differs, while
source/manifest/volume metadata is preserved. No new source was uploaded.

Prepared silence already existed. Native source requires non-silent speech within
10 seconds after connection; starting fresh SSH processes for both authority checks
before activation was too expensive a design for this path. Evidence is consistent
with that latency, but the old uninstrumented failure cannot prove its exact cause.
Replaced that transport with a persistent read-only inspector, strict IDs/framing,
2-second request bound, no retries and joined owned-child cleanup. A real read-only
probe against the restored live backend took 1.279s startup and 93/92/87ms for three
correct authority refusals. It did not create a room, provider conversation or call.

Added bounded encrypted activation-stage timings, a four-second admission budget
and final exact native connection refresh; slow/refused/terminal admission cannot
start provider audio. Added fixed Stop provenance and numeric prepared-silence/
speech frame acceptance counters. No raw audio, screenshots, provider secrets or
arbitrary errors are retained. Counters are not evidence of physical audibility.

Before these post-test refinements, `npm run check` passed **796 tests / 53 files**,
typecheck and build; full media passed **245 tests in 55.525s**. Final post-refinement
checks and independent review are recorded next. A new call requires fresh explicit
permission; the consumed operator configuration and unknown end receipt remain
preserved. No c.1 tag, presentation work or desktop work is claimed.

#### Reviewed checkpoint after the failed physical test

- Final `npm run check`: **826 tests / 55 files passed**, typecheck and build
  passed (12.26s test run).
- `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'`:
  **247 tests passed in 54.222s**, no skips; this includes the final frame-counter
  and continuous-silence/transition changes.
- `npx tsx tests/task-audio-stop.browser.ts`: passed again with installed Chrome;
  actual button click submitted exactly one authenticated Stop to a synthetic
  callback, with no call or media.
- Two actual Node/tsx subprocess bootstrap tests explicitly deny networking and
  verify that setup failures end any admitted voice, leave the task unchanged,
  submit no call/media effect and release the owner lock only after cleanup.
- `git diff --check`: passed. Mac/Swift and gateway source did not change; no new
  Swift or gateway validation is claimed. The original Argos checkout still has
  exactly its four pre-existing untracked drafts.
- Connector, transport and media specialists independently reviewed their adjacent
  paths and the final integration. Findings were fixed before this checkpoint.
  Final exact native refresh rechecks authorization expiry, and strict HTTP audio
  counters match the actual Python evidence label and numeric bounds.

The revision is ready for another specifically authorized handset test, not
physically accepted. The local ports are closed, the original hosted backend is
restored, and step c.1 remains untagged. The consumed call and all unknown phase
receipts are retained. No further live call or standby window is authorized by
this checkpoint.

### Authorized retest: blocked before dialing by provider readiness

The user explicitly authorized one additional voice-only retest with the same
ClawdTime-only standby/restoration procedure. Fresh checks confirmed the exact
paired identity, idle line, outbound audio protocol 1, no backend pending/unknown
effects and no active calls. The existing backend entered a new verified standby
deployment, with its preceding instance removed and exactly the two approved mode/
traffic settings changed. Existing source/manifest/volume metadata was preserved.

A new immutable operator configuration, grant and attempt were created; no old
attempt was replayed. Persistent read-only authority checks passed in 91–129ms and
full native readiness checks in 640–681ms. Provider preflight then failed in about
four seconds. The attempt closed with **no native-dial receipt, no provider call
ID and no provider conversation**. No second handset call was submitted. The
media-prepare receipt remains unknown historically, while local closure is proven;
these are deliberately separate facts.

Read-only diagnosis: the runtime returned `provider_preflight_unavailable` after
4.197s. Independent Python and Node authenticated agent GETs timed out after
12.110s and 12.005s; Python established verified TLS in 51ms. Provider settings, credentials and policy guards were not changed to bypass
readiness.
The official [ElevenLabs global status page](https://status.elevenlabs.io/united-states)
also reported increased API latency/errors. That public report supports a provider
availability concern; it does not establish the exact cause of the earlier silent
handset call.

Restoration was submitted once after proving this attempt was undialed and locally
closed. Protected intent, result and readiness records remain in `retest-2/` under
the existing owner-only qualification directory. The additional call remains
unplaced; no unattended delayed call is scheduled. Final restoration evidence and
this documentation checkpoint's required check are recorded below.

#### Retest restoration and documentation checkpoint

The restoration deployment succeeded and the standby instance was removed. Full
configuration snapshots match exactly before/after the temporary window. A fresh
runtime check confirms live mode and enabled traffic with zero active calls,
pending effects and unknown effects. Local ports 13323/13324/3322 are closed and
the task owner lock is released. The original one-call retest scope remains
unplaced; no unattended call or automatic redial is scheduled.

Required documentation-checkpoint validation: `npm run check` passed **826 tests
in 55 files**, typecheck and build (12.01s test run); `git diff --check` passed.
Only BUILD_LOG.md and NEXT_SESSION.md changed, so no Python/Swift implementation
checks are newly applicable. The transport specialist reviewed the checkpoint;
the first-attempt evidence is now labeled historical so it cannot be mistaken for
the fresh retest restoration proof. No c.1 tag was created and d/e remain gated.

### Authorized Deepgram fallback preparation

The user asked for another ElevenLabs readiness check and explicitly authorized
Deepgram as the fallback for the still-unplaced one-call voice retest. ElevenLabs
readiness remained unavailable (bounded GET failed at 4.002s); its official status
page continued reporting API/agent issues. The backend stayed live while the
fallback was implemented and qualified; no handset call was used for development.

The fallback uses a separate native Deepgram protocol adapter, selected only by
an explicit owner-only provider file. Existing ElevenLabs behavior is preserved.
It exposes only task status and explicit hangup, with stored final-human-turn
provenance, deferred end-of-turn functions, cancellation and freshness fences.
It uses verified TLS, fixed service endpoints, a single connection attempt, no
redirect/reconnect, no history replay and no Think Live presence prompts. Audio
remains transient. Deepgram MIP opt-out is explicit; usage metadata and managed
LLM processing are distinct from that content-retention setting.

Protected read-only provider checks succeeded: auth/token HTTP 200 in 255ms,
model listing HTTP 200 in 372ms, selected managed model available. A synthetic
provider-only session using fixture task data and a discard sink completed the
real Welcome/SettingsApplied handshake and produced nonzero PCM in 494ms including
readiness. It closed cleanly; no microphone, handset or actual task receipt was
used. This is provider-startup evidence, not physical acceptance.

The connector specialist independently reviewed protocol/authority/cleanup guards
and ran 46 focused Deepgram/LiveKit tests successfully. Review caught and corrected
a playback dependency on an experimental-only event: standard assistant transcript
boundaries now reopen playback after interruption. Required `npm run check` passed
826 tests in 55 files (12.38s), plus typecheck and build. Final affected-media checks,
activation-deadline review and the live outcome are recorded below when available.

Final fallback checks: `media/.venv/bin/python -m unittest discover -s media -p
 'test_*.py'` passed **265 tests in 54.720s**. The connector independently approved
the final eight-second activation deadline (expected worker track through first
sink output, with joined cleanup), and all 48 focused tests passed in 2.350s.
No Swift source changed. A second synthetic provider session produced first audio
in 1.161s, then remained quiet for 23.47s after its opening, with no runtime failure
and confirmed close. `git diff --check` passed. The protected standby proof confirms
exactly the two approved variables changed, the preceding dispatcher was removed,
and current runtime is idle standby. The one handset call is still pending at
this code checkpoint; no c.1 tag is warranted yet.

### Step c.1 — physically accepted Deepgram handset retest

The user confirmed all five requested handset checks passed: clear prepared
opening, task-status answer, stopping speech when interrupted, 20 seconds of quiet,
and hangup after the explicit end-conversation request. This is the human's physical
acceptance report, not an inference from counters. Exactly one new audio-only call
was placed, with screen, video, presentation and control disabled throughout.

Machine evidence independently confirms all five effect phases completed:
media preparation 1.643s, native dial submission 622ms, media activation 576ms,
media closure 4ms and native end submission 289ms. Activation admission checks
completed before the provider opened; the live provider produced first sink output
in approximately 560ms from runtime startup. The status tool executed successfully.
Stop provenance is `voice_end`; native cleanup and local media closure are confirmed.
The SDK accepted 1,134 speech frames and 793 prepared silence frames; these counts
are not audibility claims. The operator closed all local services, joined the
inspector/media children, released its owner lock and exited. Ports 13323, 13324
and 3322 are closed. Machine `physicalAcceptance:false` markers remain untouched;
the human report is recorded separately.

After confirmed call cleanup, restoration was submitted exactly once. The restored
backend deployment `9345ff09-542b-4c10-b8c4-a8aac20ec5d0` is successful and the test
standby instance is removed. Every configuration value equals the pre-test snapshot;
source/manifest/volume metadata is preserved. Fresh runtime checks show live mode,
traffic enabled, zero active calls, zero pending effects and zero unknown effects.
Apple Teams and sibling chert-facetime were not modified. Protected immutable
receipts and the separate human report remain under `retest-3-deepgram/`.

Required acceptance-documentation check: `npm run check` passed **826 tests in
55 files** (12.04s), plus typecheck and build. No Python/Swift code changed after
the validated `a1707f5` checkpoint (265 media tests passed there). `git diff --check`
passed. The transport specialist independently reviewed the acceptance record.
The annotated `step-c1-done` tag belongs to this acceptance checkpoint. This opens
step d's offline implementation gate; no further live call or screen/control
session is authorized by this successful voice-only test.

### Step d — local presentation implementation checkpoint (not step complete)

Continued after accepted c.1 checkpoint `59b8e24` (`step-c1-done`) with the same
lead/transport/media/connector ownership. The fetched approved plan remains
`origin/main` at `8c8cf76`. No new call, line handoff, deployment or production
configuration change occurred. Step e has not started.

Implemented a separate local-only presentation grant bound to the exact task,
session, terminal run, revision, verification, immutable scene manifest and host.
The original independent-task session and handset smoke permissions remain
unchanged. The first scene must narrate the current prepared opening verbatim.
The operator installs the protected manifest/grant; a task bearer cannot create
its own capture authority. Durable show/narrate/Stop receipts reject conflicting
replays and preserve unknown outcomes. Task changes and artifact changes stop
presentation without canceling an authorized coding run. Unresolved capture fences
session reauthorization until joined cleanup is confirmed.

The CLI now prepares, starts, inspects and stops a local walkthrough. It saves
fixed operation IDs before effects, checks bounded project artifact hashes, and
never retries uncertain narration or capture with a fresh ID. The HTTP host
boundary is fixed loopback, rejects browser-origin operator requests and validates
exact response bindings. The task server accepts an owner-only presentation
configuration outside the worker project. A containment bug affecting descendants
named `..private` was corrected and covered by actual bootstrap subprocess tests.
Artifact checks open bounded regular files with O_NOFOLLOW and hash the descriptor.

The Mac helper captures only a specified app/window/PID/process lifetime/title
hash/display, checking exact identity and geometry before and after capture. It
has no OS input, activation, whole-display fallback or automatic permission prompt.
`ProcessLifetimeIdentity.swift` was selectively retained from ArgosClawd baseline
`815d51b`; the new independent-task boundary reuses the established scene focus /
easing approach without importing the incompatible original-chat runtime. Existing
Deepgram protocol and browser playback plumbing are reused. No sibling repository
or production data was copied.

The local renderer uses real window pixels in memory, normalized focus regions,
450–650 ms transitions and deadline-paced 15 fps output. Capture sampling is
approximately 5 fps before processing overhead, distinct from camera output.
Browser acknowledgements follow image decode and two animation frames; narration
requires a fresh matching paint acknowledgement and continues checking freshness.
A single local narration connection speaks the exact prepared text, with no
microphone or task tools; completion requires provider audio completion and actual
browser playback completion acknowledgements. Neither acknowledgement proves human
audibility. Local Stop blanks output and closes audio immediately, then joins child
capture, provider and loop cleanup. Stalled fetch/decode and late startup callbacks
cannot restore stopped output. Screens and audio stay transient.

Independent review caught and corrected stale-frame metadata, paint-before-speech,
late startup/Stop races, cleanup after partial failure, narration timeout mismatch,
expired status disclosure and effective frame cadence. The transport specialist
reviewed the task/receipt/security integration; the connector reviewed the local
media, Swift capture and CLI end-to-end boundaries. Tests include an actual CLI
through the task HTTP service and ledger with a synthetic host, plus actual Chrome
with synthetic frames/audio. These are integration tests, not real-pixel or handset
acceptance.

Local observations: the disposable task preview visibly shows “No tasks match.”
and Clear filters. Its actual `app.mjs` source and a concise verification-result
file were opened in TextEdit. The persisted historical worker summary contained
obsolete “verification pending” text; presentation now derives its opening from
the current verification projection via `/tasks/:id/brief`, without rewriting task
history. The visible result file was reloaded and confirms both independent checks
passed. No new worker run was started.

The capture helper preflight confirms Screen Recording permission and an unlocked,
logged-in console. Exact-window metadata finds the selected TextEdit result, but
macOS reports it offscreen. Initial bounds refusal, normal window centering and
normal Raise actions did not produce a capture-admissible visible target. Bounded
metadata diagnostics now distinguish permission, exact identity, visibility and
display geometry failures without revealing unrelated window titles. The user was
asked to bring the three prepared windows onto the current desktop. Actual helper
capture, complete real-pixel CLI narration and local speaker/Stop qualification
remain pending. No capture guard was weakened and no capture was falsely claimed.

Validation for this checkpoint:

- `npm run check`: **883 tests in 60 files**, 12.16s; typecheck and build passed.
- `media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'`:
  **283 tests passed**, 62.702s.
- Focused presentation suite: **18 tests passed**, 9.918s. The final real-Chrome
  synthetic cadence/stale-frame/Stop regression also passed independently, 2.112s.
- `cd mac && swift test`: **31 tests passed**.
- `cd mac && swift build --product ClawdTimeTaskCapture`: passed, 1.58s.
- `git diff --check`: passed. No secrets, raw screens or audio in tracked changes.

Remaining step d work: qualify the real local walkthrough, then compose a distinct
handset-walkthrough capability over the existing call coordinator and receipt
store. The current audio-smoke adapter explicitly refuses video and coding
instructions; the local narrator is not a handset conversation runtime. Preserve
one dialogue/playback owner, add scoped scene requests and finalized instructions,
and invalidate old presentation when a new run starts. Prepare a concrete one-call
plan before requesting specific visual-call authorization. Decision and review
calls need distinct fresh authorization and physical evidence. No `step-d-done`
tag is warranted at this checkpoint.

### Step d — exact-window visibility diagnosis

Local presentation implementation `9308013` is pushed to `demo/coding-flow`.
After the user reported the prepared windows visible, the exact helper still
refused them. Added a second metadata-only witness using the same exact window ID
in WindowServer's CG metadata and onscreen-ID list. Both APIs agree the two
TextEdit targets exist but are offscreen; exact owner/title/geometry match and the
app is not hidden or terminated. The Chrome page remains accessible through its
browser tab, but no exact native window with that title is available. This does
not establish a permission failure or justify loosening capture admission.

Normal UI inspection and a visible-tab preparation attempt did not resolve the
native visibility discrepancy; browser control timed out, then recovered without
creating a confirmed new fixture tab. The original fixture tab is retained. The
user was asked for one focused observation: click inside the exact TextEdit result
window on the Mac and leave it frontmost briefly. A bounded metadata-only sample
still reported no capture-admissible target while awaiting that response. No
capture, narration, provider connection, worker run or call started.

Diagnostics emit only fixed flags/counts and exact-query window rectangles; no
unrelated titles, screen pixels or Accessibility lookups are retained in the
helper. The connector specialist independently approved the final source and
privacy boundary. Capture admission is unchanged. `npm run check` passed **883
tests in 60 files** (12.18s), typecheck and build. `cd mac && swift test` passed
**31 tests**; `swift build --product ClawdTimeTaskCapture` passed (1.41s). Python
source is unchanged since the **283-test** passing checkpoint. `git diff --check`
passed. No completed-step tag is added.


### Step d — prepared framing and provider audio ordering

Exact-window checkpoint `dcbbaf3` is pushed. The user's focused local window
interaction subsequently made both TextEdit targets capture-admissible. A separate
native Chrome fixture window also resolved successfully. The user confirmed the
chat was not fullscreen; fullscreen was not established as the cause. No admission
guard was loosened.

The first real local attempt completed its preview show receipt, capturing six
source frames and rendering 28 output frames. Narration then failed closed in
about 1.14 seconds; its uncertain receipt remains preserved. All capture,
narration, output and child cleanup flags were confirmed. A browser paint receipt
is not evidence that the human saw the scene. The user requested a fresh attempt,
not a replay of that historical effect.

A synthetic provider-only probe (no microphone, speaker playback or screen
capture) isolated the failure: Deepgram delivered its first audio chunk before
ConversationText. The narrator previously rejected that ordering. Early PCM now
stays in a transient quarantine, bounded to 64 KB, 256 chunks and two seconds.
Playback admission requires the entire normalized assistant text to equal the
prepared cue. Prefix matches do not release audio. Missing/mismatched text,
capacity, timeout and Stop discard the buffer. Provider EOF and all browser
playback acknowledgements remain necessary for completion. A fresh synthetic
probe completed with 76 chunks / 72,960 bytes sent to a discard sink; one initial
chunk was quarantined and released after exact text confirmation, with no failure.
This establishes protocol compatibility, not human audibility.

Allowlisted phase/reason/counter diagnostics contain no provider bodies, exception
strings, narration, credentials or audio. The preview now observes terminal host
status, blanks its image, closes audio and shows a stopped message instead of
remaining misleadingly ready after a failure. The connector specialist approved
these changes independently, including exact-cue gating and joined Stop cleanup.

Prepared scenes may specify an optional overview enclosing the focus rectangle.
Transitions and inward-rounded pixel crops remain inside that overview, so browser
chrome outside the selected content never flashes during an opening zoom.
Existing omitted-overview manifests retain their prior schema/fingerprint behavior.
The transport specialist added five contract regressions; the connector reviewed
bounds and crop behavior independently.

Validation for the checkpoint: the complete media suite passed
**294 tests** in 63.989s using `media/.venv/bin/python -m unittest discover -s media
-p 'test_*.py'`. The focused presentation/browser suite passed **29 tests** in
8.797s; independent core presentation validation passed **28 tests** in 6.307s.
Swift source is unchanged since its 31-test passing checkpoint. `npm run check` passed **888 tests in 60 files** in 12.07s, plus typecheck
and build. `git diff --check` passed. Real three-scene local qualification remains pending;
no new call, line handoff, deployment or coding run has occurred.

### Step d — real local walkthrough result and remaining polish

Narration repair `042e0cc` is pushed. After the user opened the private launcher
and enabled local preview, the fresh attempt completed all three show and all
three narration effects. Show receipt durations were 1,051 / 1,328 / 926 ms;
narration durations were 7,667 / 8,648 / 9,933 ms. The host captured 106 source
frames and rendered 535 output frames. Three exact cues released three quarantined
initial chunks; all 761 audio chunks (729,600 transient PCM bytes) received playback
completion acknowledgements. No runtime/provider failure was recorded.

The lead visibly inspected readable code and verification views. Clicking visible
Stop removed the image and showed “Sharing and narration stopped.” Durable Stop
completed in 2 ms with captureStopped, narrationStopped, outputCleared and
childrenJoined all true. This receipt timing is not a measured remote Stop latency.
The presentation host and task server were then stopped; task revision 11 remains
review-ready, with no new worker run, call or deployment. Original unknown history
remains preserved. Metadata-only evidence is stored in protected local state;
no screen or audio was saved.

The user reported that zoom and screen sharing worked, then clarified that the
audio was crackly or distorted and noted missing annotations/text overlays. This is a successful real-pixel
and narration-path exercise, not complete polish acceptance. Investigating tiny
serial playback chunks and adding the plan's restrained highlights is authorized
implementation work. One optional prepared annotation rectangle and bounded label
will bind to the existing manifest/grant; no runtime model coordinates, controls,
arbitrary styles, or new framework. The label belongs in a fixed gutter so source
text remains readable. Handset acceptance and the full step-d tag remain pending.

The polish checkpoint adds a presentation-only audio sink; the existing voice
sink is unchanged. It schedules consecutive PCM16LE mono 16 kHz chunks on one
AudioContext timeline, rather than inserting a browser round trip between every
30 ms chunk. Admission is bounded to 140 ms PCM and eight receipts, with a 60 ms
initial cushion and a 200 ms browser scheduling ceiling. Every enqueue rechecks
current authority and epoch. Completion waits for every actual `onended` receipt;
Stop cancels queued samples and pending receipts. Source review found matching
provider/decoder formats; gap removal is a concrete repair, not proof that the
reported physical crackle is resolved. Relevant APIs were checked against the
[Web Audio scheduling documentation](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
and [Deepgram audio settings](https://developers.deepgram.com/docs/voice-agent-settings).

One optional `annotation` binds a normalized rectangle and at-most-100-character
plain label into the existing manifest fingerprint. The rectangle must stay
inside focus and follows the actual integer crop, resized tile dimensions and
letterbox placement. Its restrained outline is clipped to the image; the label
uses a separate bottom gutter. No runtime model coordinates, OS input or arbitrary
styles are accepted. The real fixture remains unchanged. Its prepared empty-state,
code-branch and verification highlights require fresh visual qualification.

Final media validation: `media/.venv/bin/python -m unittest discover -s media
-p 'test_*.py'` passed **299 tests**, 65.669s. Focused presentation tests passed
**34**, 10.719s; independent review ran the same 34 tests in 10.157s and approved.
Synthetic Chrome tests verify correct sample format and durations, contiguous
30 ms scheduling under simulated 8 ms message delay, bounded lead and cancellation
of future samples/late acknowledgements. Python tests cover actual-receipt EOF
completion, queue bounds, and 20 fractional annotation projections. Transport's
12 new annotation regressions cover containment, invalid labels/fields and grant
fingerprints. Swift is unchanged since its 31-test/helper-build passing checkpoint.
These automated results do not establish physical audio quality or handset polish.

At the final frozen source, `npm run check` passed **900 tests in 60 files**
(12.03s), typecheck and build. `git diff --check` passed. Independent review found
no blockers. A fresh protected three-scene manifest/grant is prepared for a local
relisten; earlier used and unused manifests remain historical records, with no
replayed external effects. Current source windows still resolve by exact identity
but become offscreen after returning to the chat; local Start must revalidate
visibility after the user opens the preview. Permission, console and unlock
preflight pass. No current-Space guard has been relaxed. No step-d tag is added.

### Step d — annotated local walkthrough accepted

Polish checkpoint `6d786c0` is pushed. The user started the fresh prepared local
preview and it completed all six show/narration effects. Show durations were
1,107 / 1,244 / 924 ms; narration durations were 8,015 / 7,987 / 8,959 ms. All
797 chunks (764,160 transient PCM bytes) received playback completion receipts;
three cues used one provider connection, with no runtime/provider failure.
The host captured 117 source frames and rendered 592 output frames. The lead
visibly checked the code and verification highlights and the bottom-gutter label.
The user explicitly confirmed: **“Audio clear; visuals good.”** This qualifies
this local three-scene exercise, not handset presentation or the full demo.

Visible Stop removed the image; durable Stop confirmed capture, narration, output
and child cleanup. The host and task server were stopped. No call, line operation,
deployment or new coding run occurred. Screens/audio remained transient.

The initial 1021×753 viewport placed the label below the fold. A small preview-only
layout correction now fits the entire 16:9 canvas in available height while keeping
Stop visible. Short screens retain scrolling with sticky controls. Playback,
capture and authorization code are unchanged. Actual Chrome synthetic layout
checks cover 1021×753, 1280×720, 390×844 and 360×320. Media's three browser tests
passed in 8.043s; independent layout validation passed in 1.196s and review approved.
The broader media baseline remains 299 tests passed at `6d786c0`; unchanged Swift
remains 31 tests/helper build passed. Step d remains open for handset composition
and specifically authorized decision/final-review calls.
For this viewport/acceptance checkpoint, `npm run check` passed **900 tests in
60 files** (12.12s), typecheck/build, and `git diff --check` passed. No step tag
was added because the required handset presentation calls are not yet implemented
or physically qualified.

### Step d — offline handset walkthrough composition

Local acceptance checkpoint `74d1abf` is pushed. Continued with the same three
specialists and explicit file ownership. The new `handset_walkthrough` branch
reuses the existing protected call coordinator, five effect receipts and global
ownership fence. Historical c.1 schemas and fingerprints remain unchanged; a
local presentation grant never implies export permission. A separate strict
export grant binds exact task/run/revision/verification, capture manifest/grant,
source host, real destination device, line and voice identities. Dispatch is at
most five minutes; the explicitly bounded conversation can last up to thirty
minutes. The capture grant retains its independent shorter expiry.

The root operator composes one scoped task engine, voice service, presentation
ledger and native inspector. Fresh readiness must prove exact worker audio/video
protocols and screen/video-resource checks. Media preparation validates the
exact prepared native windows, joins one private room and asks the root to
reserve the first scene. The root's callback shows that scene; only a fresh,
post-transition frame accepted by the SDK can admit native dialing. Activation
rechecks the frame before the single Deepgram provider's prepared opening.
This is SDK evidence, never a claim of remote visibility or audibility.

One dialogue/playback owner handles opening, scene explanations, questions and
finalized human instructions. There is no second handset narrator. Tools select
only immutable prepared scene IDs. A new instruction needs a fresh connected-call
receipt after duplicate lookup; already admitted held corrections can release
after hangup once the prior run and verification are known. Acceptance has its
own durable utterance fence and requires the exact fresh review call and current
verified result. A decision call or old review cannot accept a newer result.
Model arguments cannot replace the registered human instruction or acceptance.

Sharing Stop immediately closes source admission and switches the existing
publisher to blank-only frames while voice and coding continue. A one-second
source watchdog prevents stale scene persistence during a stalled authority
request. Automatic source failure retires the root presentation once; root Stop
does not recursively call itself. Full call cleanup blanks before potentially
slow voice-end receipts. Actual remote clearing time still needs handset evidence.

Independent review found and resolved three integration gaps: fresh scene output
must match the precise SDK receipt after asynchronous checks; ongoing destination
proof must use the same strict timestamp/fingerprint schema as initial admission;
and call cleanup must not abort a worker. The operator now exposes only its exact
voice and presentation-authority routes, and `TaskEngine.closeIfIdle` refuses to
close while any owned run or verifier is unsettled. The service stays alive for
admitted work after native/media cleanup, including a held correction. Unknown
outcomes remain fenced without automatic replay.

Connector review approved the root composition and 41 focused bootstrap,
scoped-HTTP, lifetime and Stop regressions. Actual deferred synthetic workers
exercise claimed/running/verifying, terminal-but-unsettled and second-owned-task
states. Cross-language coverage feeds the real TypeScript binding/fingerprint,
prepared manifest/export grant and Hono context/opening responses into Python
validators and the prepare flow. It verifies the exact opening event and matching
fingerprint, rejects four widened/misbound wires, blocks socket connections and
asserts the provider never opens. Transport independently reviewed all three new
media files, root callbacks and shared hooks; 24 focused Python tests passed in
7.63s, with no remaining blocker. No test dials, captures user windows or opens a
provider conversation.

Final voice review also found a delayed tool-response race: scene speech could
become eligible while its authoritative tool response was still being sent.
Playback now remains muted until that send completes, and a speech-generation
recheck prevents a barge-in during the send from reviving obsolete speech. A
deterministic blocked-send/interruption regression covers both cases.
Cached successful scene responses likewise revalidate current scene/generation
and export freshness before allowing speech; receipt reuse cannot revive old
scene narration after Stop or replay the original scene effect.

The runnable operator path and next one-call scope are documented in
`docs/CODING_DEMO_HANDSET_WALKTHROUGH.md`. No new call, credential change, line
operation or deployment occurred. Step d remains untagged; physical handset
presentation, spoken coding continuation, final acceptance and measured rehearsals
are still required. Step e remains gated. Fresh specific call/export and any
standby/restore authorization is the next external prerequisite.

Final frozen-source validation: `npm run check` passed **1,027 tests in 65 files**
(12.29s), typecheck and build. `media/.venv/bin/python -m unittest discover -s
media -v` passed **327 tests**, 77.174s; the focused walkthrough
suite passed 27 in 7.655s. Connector independently approved the final speech
ordering and cached-scene regressions. `cd mac && swift test && swift build --product
ClawdTimeTaskCapture` passed **31 tests** (0.089s) and the capture-helper build;
Swift source is unchanged. `git diff --check` passed. The final diff was reviewed
for unrelated changes and credentials; the only credential-pattern scan match
was the explicitly synthetic project key in a bootstrap test fixture. No secrets,
real screens/audio or runtime records are included.

### Step d — first visual call: native reports `outbound_not_answered`

Handset integration checkpoint `d7bacf8` is pushed. The user explicitly authorized
one visual call up to fifteen minutes, prepared-view export and spoken revisions,
with the proposed ClawdTime-backend-only standby/restore procedure. Fresh checks
confirmed the exact paired recipient/device, view permission, idle native line,
automatic audio/video prerequisites, no hosted pending/unknown effects, and
unchanged prepared artifacts. Both independent fixture checks passed again. The
user brought all three exact source windows onto the current desktop; metadata
resolution then passed without weakening the offscreen guard.

Two local setup failures occurred before any call: the existing verification-plan
file was mode 0644, so it was tightened to 0600; the initial inspector bundled
dependencies into a roughly 790 KB SSH argument, so it was rebuilt with installed
packages external and minification (21,590 bytes). The compact inspector's real
read-only backend handshake passed. Each failed setup confirmed cleanup and
released ownership; no media/call effect was replayed. The operator guide now
documents these concrete preparation requirements.

Exactly one new visual call was submitted. Media preparation completed in 3.573s
and the native dial submission in 854ms. The exact preview scene had a fresh SDK
frame acceptance receipt; this is not handset visibility evidence. The native
provider recorded dialing, ending, failed and cleanup_complete, with
`terminal_detail: outbound_not_answered`, no started timestamp and no bridge-ready
event. No media activation receipt or provider conversation was created; speech
frames were zero. The handset observation is requested separately and remains
pending at this checkpoint. Do not infer that the human saw a ring or rejected it.

Native end and media close both completed; capture, narration, output and child
cleanup are all confirmed. Ports 13323, 13324 and 3322 are closed and the task
owner lock is released. Task revision 11 remains review-ready with its same
verified run; no spoken revision or new coding run occurred. All metadata receipts
are preserved privately under `visual-1/`; no raw screen/audio was saved.

Restoration was submitted once after confirmed cleanup. Backend deployment
`a0b95d02-b545-4c7b-8c2f-4c150578d31a` is successful; the temporary standby instance
is removed. Every variable equals the pre-test snapshot. Fresh runtime evidence
reports live mode, traffic enabled, zero active calls, zero pending effects and
zero unknown effects. Apple Teams and sibling chert-facetime remain untouched.
The one-call authorization is consumed; no redial occurred. Step d remains open
and untagged, with a fresh specific call authorization needed for another attempt.

For this evidence/operator-documentation checkpoint, `npm run check` passed
**1,027 tests in 65 files** (12.13s), typecheck and build. Python and Swift source
are unchanged from `d7bacf8` (327 media tests and 31 Swift tests/helper build
passed there). `git diff --check` passed. Connector independently reviewed and
approved the evidence distinctions, cleanup/restore report and operator guidance.

### Step d — connected visual retest and post-sharing voice failure

The user clarified that the first visual call rang while they were on another
call and they did not answer. They then explicitly authorized one additional
visual call under the same fifteen-minute scope. Fresh window, artifact, pairing,
idle-line, automatic video-readiness and exclusive standby checks passed. Two
independent fixture checks passed before dialing. The compact inspector and
private verification-plan preparation worked without another setup failure.

Exactly one new call connected. All five phase receipts completed: media prepare
2.904s, native dial submission 793ms, media activation 250ms, media close 241ms,
native end submission 389ms. Preview and code scene effects completed with fresh
SDK frame evidence. The user reported the walkthrough “looked really nice,” then
said the screen went dark after speaking and voice stopped responding. This is
partial physical visual evidence and a failed conversation-continuity check,
not full handset polish acceptance.

Two distinct finalized utterances each produced one new scoped run. Both workers
completed; independent verification rejected their provisional empty-state text
against the retained expected wording, while syntax passed. These are separate
instruction receipts, not duplicate replay. The task reached needs-decision at
revision 19. A revision correctly retired the old presentation; however, source
review reproduced a voice bug: `scene_muted` could permanently discard ordinary
assistant replies until a successful tool response. Clarification and ordinary
follow-up speech could therefore remain silent. The media specialist is repairing
this with independent connector review; no capture guard is being relaxed.

The lead stopped the unresponsive call once. Native and local cleanup completed,
including capture, narration, output and child joins; the owner lock was released.
The backend was restored once afterward. Deployment
`3e361f03-e4a2-4a9a-ad1a-90f2abc2e09d` is successful, its temporary standby instance
is removed, every variable matches the pre-test snapshot, and runtime is live
with traffic enabled, zero active calls and no pending/unknown effects. Protected
metadata remains under `visual-2/`; screens/audio were transient. No further call
is authorized.

When asked for the replacement wording, the user could not recall a specific
change and thought they had only said to go ahead. The lead stated the assumption
to retain the last explicit requirement, “No tasks match,” and submitted one
separate operator-scoped continuation to remove the provisional wording. It is
not recorded as a new voice utterance or as fresh explicit replacement wording.
The existing verification expectation and all earlier receipts remain unchanged.

The restoration run completed and both independent checks passed, but it reported
the historical empty-state question again, keeping revision 23 needs-decision.
Inspection found that `TaskEngine.context` dropped the saved decision answer and
presented only its question to the next worker. The exact instruction was still
present, so this omission alone does not prove why that model repeated the
question. The minimal correction marks a decision answered only when its saved
answer exactly matches the current run instruction, references that existing
instruction instead of duplicating up to 8 KB, and identifies the question as
historical. A fake-worker regression requires this exact linkage to reach
review-ready, with two runs, two verifications and preserved duplicate receipts.
Transport independently reviewed the root change; all 14 engine tests passed.
The lead submitted one further scoped continuation to validate the resolved
decision using the corrected context, without changing the verification criteria.


The final real continuation completed with no remaining decision. Its independent
filter/empty-state assertion and JavaScript syntax checks both passed; task
revision 27 is review-ready. The private result receipt is preserved and the task
server was stopped cleanly only after the worker and watcher settled. This
validates the corrected context in one real run, without claiming deterministic
model behavior. Future presentation must use this fresh verified result, not the
retired revision-11 manifest or old displayed verification text.


The media repair admits ordinary replies after retirement only for a fresh,
finalized human turn with a successful transcript receipt and current authority.
It keeps one playback owner and a transient reply quarantine bounded to 64 KB,
256 chunks and two seconds; new speech, Stop, expiry, refusal or stale identity
cannot release that buffer. The first transcript POST uses fresh task context;
failed or unknown submissions are not retried or rebound. Cancellation of a
reply/tool waiter does not cancel its shared finalized-transcript registration.
Delayed status and historical receipts cannot reopen retired scene speech. A new
confirmed instruction or Stop result may acknowledge its own effect, with exact
result-shape, current-turn and suppression-epoch checks through response send.
Prepared-scene speech still requires its exact fresh frame. No sharing restart
or capture guard relaxation was introduced.

The prompt now directs the voice agent to clarify missing replacement text,
values or targets instead of submitting bare confirmation. This is dialogue
guidance plus unchanged exact-transcript routing, not a semantic backend guard
or physically established behavior. Deepgram has no per-chunk turn identity;
ordered provider boundaries and bounded admission are not independent proof of
each audio chunk's causal attribution. A newly authorized handset test remains
necessary. Transport approved the updated root handoff/evidence documentation;
connector and transport approved the answered-decision context regression.


Final repair checkpoint validation: `npm run check` passed **1,027 tests in
65 files** (12.05s), typecheck and build. Full
`media/.venv/bin/python -m unittest discover -s media -v` passed **344 tests in
76.426s**. The media specialist's focused walkthrough suite passed 44 tests in
9.775s; connector independently ran 29 dialogue plus 15 base Deepgram tests
(**44 passed in 2.570s**) and approved the final frozen source. Swift source and
interfaces are unchanged from `d7bacf8`, where 31 Swift tests and the helper build
passed; no new Swift execution is claimed. `git diff --check` passed; lead review
found no unrelated changes, literal credentials or relaxed capture/permission
checks. Native/media/task ports 3322, 13324 and 13323 are closed. This is a passing
repair checkpoint, not step-d completion; no step-d tag or step-e work follows.


### Step d — accepted final review and natural acceptance repair

Checkpoint `98c7355` was committed and pushed after the previous voice recovery
checks. The user then authorized one visual retest, up to fifteen minutes, with
the same temporary ClawdTime-only standby and restoration procedure. The lead
explained the actual capture path: ScreenCaptureKit selects the exact individual
window, independent of overlapping windows; prepared cropping, highlights and
550 ms zooms compose the 15 fps output. This is live app-window capture, not a
full-desktop crop or synthetic app. Hidden/offscreen and identity guards remain.

Before dialing, the fixture browser and editor were found displaying older text
with a trailing period. The browser was refreshed. TextEdit automation timed out
and did not reliably reopen files; the user manually reopened the source and the
updated revision-27 verification view. All three exact native window targets
then resolved successfully. Fresh behavior assertions and JavaScript syntax
checks passed, and a new manifest/grant bound the current verified review.

Exactly one call was placed after fresh exclusive standby/identity/readiness
checks. Media preparation took 2.881s, dial submission 795ms and media activation
281ms. These are local phase timings, not handset ringing/speech latencies. The
user reported that the walkthrough looked good, but the agent repeatedly said it
could not confirm the result. Two stored finalized replies contained positive
wording yet failed the old anchored acceptance grammar. No acceptance or new run
was manufactured from that report. One was ordinary conversational assent; the
other included negation and remains conservatively ambiguous.

The lead requested one explicit acceptance only if the human wanted to accept.
The user then confirmed that the agent acknowledged acceptance and hung up after
the explicit ending request. The durable task is **accepted at revision 28**,
with the same independently verified run and seven total runs; this review made
no new coding run. Presentation evidence contains the opening preview and its
Stop, not a complete three-scene or spoken-revision rehearsal. The user's
confirmation establishes acceptance/hangup behavior, not all remaining measured
polish targets or the full revision-continuity trial.

Native and local cleanup are confirmed. Media close took 5ms and native end
submission 307ms; capture, narration, output and children all joined, and the
owner lock is released. Restoration was submitted once after cleanup. Deployment
`d2b307f4-65fc-4bfd-9895-4ebef4914bb1` is successful; the temporary standby instance
is removed. Every variable matches the pre-call snapshot; fresh runtime evidence
reports live mode, traffic enabled, zero active calls and no pending/unknown
effects. Protected receipts remain under `visual-3/`; screens/audio were
transient. The one-call authorization is consumed. No redial occurred.

The acceptance repair uses a bounded whole-utterance grammar for common discourse
and courtesy words, current-result pronouns and a positive “I think” judgment.
It does not strip arbitrary clauses or search for approval inside a longer
sentence. Negation, conditions, questions, quotations, specific-view compliments
and additional revision requests remain rejected. Exact finalized provenance,
connected review, current task/run/revision, independent verification, held-work
and duplicate-use guards are unchanged. Synthetic API tests cover exactly-once
acceptance without a new run or deployment. No private transcript was copied into
tracked files or test fixtures. The accepted task was not rewritten to test the
new grammar; its existing successful receipt is preserved.


Failed/unconfirmed acceptance now performs one bounded authoritative status read
for that finalized utterance. Its cached recovery distinguishes already accepted,
the original review still waiting, a changed result requiring fresh review, and
unavailable status. It never repeats the mutation or invents which request caused
acceptance. Older status or a response crossing a retirement/interruption cannot
reopen stale speech. Prompt guidance explains that recovery once rather than
repeating confirmation failures. These repairs have automated evidence only.

An intermediate full TypeScript run exposed one stale test expectation rejecting
the deliberately supported positive “I think” form (1 failed / 1,104 passed).
Transport corrected that expectation and added synthetic bounded positives,
negated judgments, conditional judgments and added-change refusals; all 85 focused
acceptance tests passed. Connector independently approved the confined grammar;
transport reviewed the API integration and updated outcome/handoff documentation.


Final checkpoint validation: `npm run check` passed **1,112 tests in 66 files**
(12.53s), typecheck and build. Full
`media/.venv/bin/python -m unittest discover -s media -v` passed **351 tests in
75.111s**. The media specialist's 51 focused tests passed in 9.779s; connector
independently passed all 85 backend acceptance tests and seven media recovery
regressions (the recovery subset took 0.060s) and approved the frozen changes.
`git diff --check` passed; lead reviewed scope, credentials and guard preservation.
Swift code/interfaces remain unchanged from the passing 31-test/helper-build
checkpoint `d7bacf8`; no new Swift execution is claimed. Native/media/task ports
3322, 13324 and 13323 are closed. Step d remains untagged; step e has not begun.

## Step e — native desktop implementation checkpoint

The user explicitly asked to proceed with step e, build the desktop panel with
the same specialist team, and work without routine input. This supersedes the
earlier implementation-order hold while leaving the remaining step-d physical
gates deferred. Previous checkpoint `47ec697` is committed/pushed. No new call,
line operation, provider-secret change or deployment was performed. The previous
accepted handset task and restored backend were untouched. Steps d/e remain
untagged pending the complete authorized desktop-to-phone rehearsals and measured
physical acceptance.

Runnable entry: `npm run task:desktop -- --state PRIVATE_DIR --project PROJECT`.
Simulation is the default and honestly stays queued. Explicit `--worker codex
--checks PRIVATE_FILE` runs the existing scoped adapter and independent watcher.
`bash mac/scripts/package-task-panel.sh` builds a locally signed native bundle.
See [the desktop guide](CODING_DEMO_DESKTOP.md) for exact setup and recovery.

Lead integrated the task/session facade, private configuration, HTTP routes,
server/handset composition and root documentation. Connector implemented the
detached launcher, existing-session attachment, selectable worker outputs and
subprocess tests. Transport implemented ledger choice persistence, desktop
backend regressions and independent integration review. Mac implemented the
AppKit floating panel, Foundation client/receipt storage, Swift tests and device
documentation. File ownership remained separate; only lead handles integration,
checkpoint and any future live operations.

The native window provides one selected project, task input, meaningful progress,
independent checks, product decisions, explicit scoped revisions, review and
acceptance. Genuine worker-provided choices (2–3 distinct bounded strings) fill
the answer composer; selecting never submits. Cancel task has a separate exact
task/run/revision confirmation. Fixed bottom sharing/call Stop controls are
independent of task pending state. Close hides the window; Quit panel ends only
the UI. A UI-only notification raises an already-running matching panel.

The launcher starts a detached service or authenticates the exact existing owner.
Reopen compares project, worker, checks, optional session-file fingerprint and
desktop identity. Private config/receipt paths stay outside the worker project;
the UI token differs from session/operator capabilities. State reads and POSTs
reject browser Origin; the native client refuses redirects and bounds responses.
No new webview, framework, daemon installer, history browser or paired-text UX
was added. New optional fields preserve historical stored tasks and worker-test
responses.

Every mutation reserves a durable operation ID before external effects. Task
operations and task-pointer changes commit atomically; worker dispatch happens
after commit. Native persistence contains IDs/digests, not task prose or tokens.
Reconnect/restart performs receipt GETs, never rePOST. Unknown execution and
cleanup retain their original identity. Task authorization expiry hides task
prose and blocks task mutations but does not revoke exact existing cleanup. The
task-operation capacity cannot disable Stop. A successful admission receipt is
not labeled worker completion or confirmed remote cleanup.

The standalone default is local-only. `--session-file PRIVATE_FILE` can attach
an already authenticated same-project session in the same store, preserving its
ID, expiry and permissions without registration/renewal or granting phone access.
The existing handset operator optionally accepts `desktopPanel: true`: it creates
an attempt-bound private config using its existing session, task, engine,
coordinator and presentation. This panel cannot submit another job. Exact Stop
closures use the original monitor/presentation cleanup; task actions retire
before engine shutdown. Call state follows the durable cleanup receipt while a
worker continues. The database owner lock forbids concurrent standalone/handset
owners. A future phone rehearsal still needs a confirmed idle handoff, prepared
views and fresh specific authorization; automatic call dispatch is not added.

Review found and repaired these concrete issues before the checkpoint:

- Dispatch inside a ledger transaction could lose admitted work after rollback;
  dispatch now occurs only after commit and uncertain completion stays unknown.
- Clock-based task selection could switch after wall-clock rollback; a durable
  current-task pointer now owns selection.
- Session expiry originally hid all controls; UI/cleanup authority is separate
  while task disclosure and execution stay closed.
- Verification config hashing and parsing could read different bytes; a single
  bounded O_NOFOLLOW read supplies both, with private-file checks.
- A done POST could re-enable stale native task actions before a fresh snapshot;
  a request-generation barrier now waits for a read begun after mutation.
- The handset owner could admit a new run after `closeIfIdle`; a synchronous
  retirement fence now refuses task mutations before the next shutdown await.
- Preparing/cleanup was mislabeled connected; the panel now says Call active,
  and native cleanup is distinguished from service/worker lifetime.

Local qualification used a new disposable project, separate from the historical
handset fixture. Through the actual native UI, lead submitted a real filter task,
quit the panel during work, and reopened the same service/task at its unresolved
empty-state decision. The watcher correctly failed the seeded assertion. One
answer produced one new run; independent assertions and syntax check passed.
The browser displayed `No tasks match`; Clear filters restored both rows. Lead
accepted this disposable result in the panel. A confirmed idle service restart
preserved that accepted task and desktop identity.

A second real task exercised the updated structured choice path: two options
appeared, selecting one only filled the composer, and Send answer created one
follow-up run on the same task. The watcher passed; the browser displayed the
selected `No tasks found` wording and the working reset button. Lead accepted
that disposable result. Closing and reopening with the same command preserved
it. These are automated/local observations, not human handset acceptance.
Screens were transient. One panel screenshot read briefly failed with a native
capture error; a later native screenshot and AX inspection succeeded, without
changing visibility guards. No phone capture was started.

Validation before this checkpoint:

- `npm run check`: **1,187 tests in 69 files**, **12.11s**, plus successful
  TypeScript typecheck and build.
- `cd mac && swift test`: **46 tests**, zero failures (**0.193s** in lead run;
  final UI wording adjustment also passed all 46 in specialist run, **0.078s**).
- `cd mac && swift build --product ClawdTimeTaskPanel`: passed.
- `cd mac && swift build --product ClawdTimeTaskCapture`: passed. An initial
  mistyped `ClawdTimeCapture` product command failed because no such target
  exists; it was corrected, not recorded as a passing build.
- `bash mac/scripts/package-task-panel.sh`: build and ad-hoc signature
  verification passed. It installs no daemon and is not a notarized release.
- `media/.venv/bin/python -m unittest discover -s media -v`: **351 tests in
  74.654s**, OK. No media Python implementation was changed.
- Connector's 26 launcher tests include actual isolated detached-process reuse,
  idle restart, unknown-run nonreplay and existing-session preservation. The
  backend/ledger/worker focused suite passed 88 tests before the final full run.
- `git diff --check`: passed. Connector independently approved native lifecycle,
  ledger changes and handset integration; transport independently approved
  root scope/cleanup/config and worker choice mapping. Lead reviewed the complete
  diff for secrets, unrelated changes and weakened guards.

Remaining acceptance is explicit: complete the prepared two-call story starting
from a desktop task on the paired session, exercise native Stop in that call,
and finish the plan's three rehearsals and measured polish trials. Those require
new specific authorization. No step-d or step-e completion tag is warranted by
this local implementation alone.

## Desktop appearance — notch and persistent mascot

Following checkpoint `ce72347`, the user requested the supplied second image's
compact dark notch treatment while preserving the desktop functionality, plus
minimization to a pet or a circular monochrome logo. The user clarified that the
sharing controls mean the existing Stop sharing and Stop call actions. Lead chose
the explicitly offered monochrome badge option, using the supplied mascot PNG
unchanged; no image-generation service or animated-pet dependency was added.

Mac specialist implemented a 430-point top-centered pill and an independently
centered 560-point expandable dark translucent task surface. The toolbar retains
status, expand/collapse, Stop sharing, Stop call and minimize. The 62-point mascot
badge is draggable, restores the task panel on click, and keeps exact Stop actions
in its context menu. Close/Cmd-W tuck the interface into the badge; Cmd-Shift-M
toggles the task body. Menu Show and same-config launcher reopen still restore
the expanded panel. Windows use visible-screen bounds and join desktop Spaces;
explicit Quit remains available. This is desktop presence while the app runs,
not a newly installed login item or installer.

Lead integrated the resource manifest and documentation; the package copies the
asset into app Resources, with main-bundle loading before the SwiftPM development
fallback. The previous task service, credentials, operation receipts, task
actions and capture/call permissions are unchanged. Minimize, restore and drag
are UI-only. No call, capture, provider operation or deployment was performed.
There is no Share-on toggle or automatic restart of retired sharing.

Local CUA qualification exposed two issues and guided corrections. Applying a
background tint directly to NSVisualEffectView left the body light gray; a
separate noninteractive dark overlay above the native blur now produces the
intended charcoal surface with readable input placeholders. App reactivation
could expand a collapsed panel; unnecessary deminiaturization was removed, the
current window is explicitly made key/main, and reopen preserves an already
visible collapsed state. The initially full-width toolbar was narrowed to match
the compact reference while retaining the wider body.

Lead observed the final dark panel and compact notch, expanded it using the
chevron, minimized using the toolbar button, opened/restored through the mascot,
and inspected the mascot's Stop menu. An unsent synthetic draft survived
minimize/restore and was cleared without submission. A native drag gesture kept
the mascot minimized; exact cross-display placement/fullscreen behavior was not
physically measured. The accepted disposable task remained intact and no new
worker was submitted. Screens were transient; reference screenshots were not
copied into the repository. The supplied mascot alone is the bundled image.

Validation: `npm run check` passed **1,187 tests in 69 files in 12.14s**, typecheck
and build. Final `swift test --package-path mac` passed **50 tests in 0.092s**;
new tests cover display-mode/reopen transitions and bounded screen geometry.
`bash mac/scripts/package-task-panel.sh` passed the panel build and ad-hoc
signature verification. `git diff --check` passed. Connector independently
approved the UI lifecycle, Stop bindings, draft reuse, asset loading and final
geometry. Python/media code and interfaces were unchanged and were not rerun;
their previous 351-test result belongs to `ce72347`. Remaining handset gates are
still deferred and no new step-completion tag is claimed.

## Desktop motion and dragging

The user requested dragging the notch and animated expansion/retraction between
the circle and bar, with the text panel sliding down/up. This follows the pushed
appearance checkpoint `042e12e`. The change is confined to native presentation,
layout tests and documentation; task/operation contracts, media and backend
authority remain unchanged. No live call or deployment is involved.

Mac specialist owns the native implementation and motion/layout tests; connector
independently reviews transition races, drag/control separation and lifecycle.
Lead integrates, packages and performs the local UI check. The selected design
uses a shared position for badge/bar/body, screen-bounded group placement, a
short circle/pill morph, and a clipped body reveal that preserves text size and
editor state. Rapid changes must settle the latest requested mode; Reduce Motion
must avoid spatial movement. Validation and local observations follow below.

The native implementation uses one cancellable 290ms eased transition with a
generation fence. An inert glass shell morphs between circle and pill while the
real controls crossfade; the body reveals through a top-aligned viewport without
scaling text. Existing Stop selectors are also available in the application menu
during motion. Activation preserves either visible compact mode.

Local testing caught an actual drag lifecycle defect: AppKit's `performDrag`
returns before the gesture ends, so the previous immediate distance check could
mistake a drag for a click. Replaced this with owned mouse-down/drag/up handling,
global pointer deltas, a sticky movement threshold, release-time bounds checking
and continuous body following. No synthetic input or global input monitor was
added. Independent review approved the corrected implementation.

Validation: `npm run check` passed **1,187 tests in 69 files in 12.72s**, including
typecheck and build. Final `swift test --package-path mac` passed **56 tests in
0.092s** and compiled the executable; connector separately passed all **10 layout
tests** and reviewed event coordinates, click thresholds, release handling,
transition fencing and unchanged action bindings. The package script rebuilt
and ad-hoc signed the final app successfully; `git diff --check` passed.

In the rebuilt local app, a circle drag left it minimized, clicking restored the
body, and a toolbar drag left its controls intact. Rapid body toggles settled in
the requested expanded mode with the synthetic draft preserved; the draft was
then cleared and the compact bar left running. Screenshot endpoints and native
accessibility confirmed the final states. The automation exposes window-cropped
images without absolute position metadata, so precise drag displacement, live
body following, animation smoothness and cross-display gestures were not
physically measured. Reduce Motion is implemented but the user's system setting
was not changed to qualify it. These limits do not substitute for handset gates.

The fixture service kept the same instance/task, accepted revision 8, and zero
unresolved operations throughout; no task was submitted. No capture, call,
provider, deployment or installation setting changed. Python/media were
unchanged and were not rerun. No step-completion tag is claimed.

## Desktop finishing — light style and right-edge minimize

Following `2625eb7`, the user requested a lighter panel and rounded blue buttons
matching their supplied reference, the supplied red mascot, and spatial
minimization into a circle at the right of the bar rather than a fade. Mac
specialist owns native styling, bundled asset, transition geometry and tests;
connector independently reviews behavior and remaining demo integration. Lead
handles packaging, local observations, documentation and branch checkpoint.
This is a presentation-only change; no new call, capture, deployment, login item
or provider operation is authorized or needed. Validation follows below.

Plan review found a remaining integration boundary rather than only physical
testing: `scripts/task-server.ts` constructs the standalone desktop service
without the handset coordinator. The separate handset operator can attach to
the same task under an exclusive idle handoff, but the standalone launcher does
not yet orchestrate the approved desktop-to-prepared-call flow. The next step
is to connect known terminal decision/review states to preparation and the
existing coordinator under one owner, retaining per-call authorization and
durable receipts. Then qualify the complete two-call story and the plan's three
rehearsals and measured handset trials. There is no approved step f to begin.
Corrected an older walkthrough-document sentence that still prohibited step-e
implementation despite the user's explicit override; deferred physical gates
remain required. Connector independently reviewed these documentation changes.

`npm run check` passed **1,187 tests in 69 files in 12.11s**, with typecheck and
build. Native validation and local observations are recorded below after the
specialist's final implementation review.

The final UI uses light surfaces, dark text, blue enabled primary/Stop actions,
and gray disabled controls. The supplied red PNG replaces the bundled monochrome
resource unchanged (source/destination hashes matched). The actual toolbar now
retracts through a rounded viewport toward its right edge; its red mascot aligns
with the final circle. Controls remain full-size and alpha remains opaque. Badge
dragging maps back to the bar anchor; restore clamps to the usable screen when
needed. Background hit testing is explicit, buttons keep native semantics, and
Reduce Motion and generation fencing remain intact.

Local visual QA caught reversed gradient lighting on flipped button coordinates
and slightly truncated compact status text. Corrected top lighting/highlight and
bottom depth using `isFlipped`, and reduced padding only on small buttons. The
final running build shows the corrected blue action, full “Result accepted”
label, light toolbar and red mascot. Circle dragging kept the compact mode;
clicking restored the body with its synthetic draft intact. Test drafts were
cleared without submission and the final compact bar was left running. A toolbar
coordinate-drag attempt was rejected by the UI automation before dispatch with
`noWindowsAvailable`; no product result is inferred from that attempt. Cropped
window snapshots verify endpoints, not precise absolute displacement or measured
animation smoothness. No handset or live Stop check was performed.

Final `swift test --package-path mac` passed **57 tests in 0.080s**, compiling the
executable. Connector independently passed **11 layout tests** and approved the
final source, hit testing, redraw behavior, shading correction and documentation.
`bash mac/scripts/package-task-panel.sh` passed build and ad-hoc signature
verification. `git diff --check` passed. Lead reviewed scope, retained guards and
secrets; Python/media are unchanged and were not rerun. The fixture service
retained the same instance/task, accepted revision 8 and zero unresolved
operations. No task, call, capture or deployment was initiated. No completed-step
tag is claimed.

## Desktop-to-call integration in one task owner

The user authorized continuing desktop-created tasks into the prepared call
flow after `c03d8c8`. Lead owns the reusable attempt runtime, desktop orchestration,
operator routes, server composition and integration. Connector owns launcher
configuration and synthetic end-to-end tests. Transport owns encrypted admission
receipts and presentation-isolation tests. Mac specialist reviews media lifetime
and adds the small native call-readiness projection. No live call, provider
connection, credentials inspection or deployment is required for this checkpoint.

The launcher accepts optional protected `--calls-config`, bound into the existing
desktop fingerprint. It requires explicit Codex/checks and an existing task
session. No call resources start on launch/reopen. A protected operator request
supplies a fresh exact-task/run/revision one-call authorization and prepared
manifest/local view grant. The selected desktop task, opening, verification,
duration, destination and full normalized request digest are checked; the UI
credential cannot call the operator route. Separate review calls need separate
authorization. Preparation is reported in the panel without adding a call-grant
button or native worker approval bridge.

Extracted the existing handset script into a reusable attempt runtime. Shared
mode injects the existing store/vault/task engine/voice service and retains the
same owner lock, desktop identity and UI capability. Scoped voice HTTP, media,
inspector, monitor and presentation resources retire per attempt. Ending a call
does not close the parent engine; finalized held instructions still release
through its single existing voice listener. Standalone script behavior reuses
the runtime through a thin wrapper. Optional loopback ports remove the prior
hardcoded-port coupling while preserving scoped route allowlists.

Encrypted call admission precedes all attempt effects. Matching duplicate
requests read receipts; changed content or reused authorization is rejected.
Restarted admissions become unknown and fence calls/readiness without replay.
There is no force-clear recovery endpoint. Uncertain native or presentation
cleanup retains ownership and original receipts. Static configuration changes
cannot silently upgrade an existing desktop binding.

Review found and repaired three integration races: Stop during asynchronous
preparation now latches cancellation before an attempt handle exists; finish
cannot complete while start/preflight is still running; and presentation cleanup
and direct access are restricted to the exact manifest/host instead of iterating
or mutating other historical presentations. Exact unknown presentation cleanup
prevents claiming finished. Call readiness uses the desktop's durable selected
task pointer rather than list ordering.

The scope remains prepared-view coding calls. Current exact windows, artifacts
and export grants must still be prepared before each request; this does not add
general automatic window setup or unattended dialing. The next live qualification
needs an explicitly configured paired session, current prepared views, fresh
per-call authorization and exclusive-line proof. Three complete two-call
rehearsals and the measured handset targets remain required for d/e tags.
Validation results follow below.

Validation: final `npm run check` passed **1,237 tests in 73 files in 12.03s**,
typecheck and build. New tests cover launcher static-config binding; encrypted
admission/replay/restart; exact-host presentation isolation; and the complete
HTTP desktop submit → decision → synthetic call → finalized spoken instruction →
new run → independent verification → fresh review call → acceptance flow. That
flow preserves desktop/service/session/task identity and keeps the worker alive
after Stop. All call and worker effects in these new flow tests are explicitly
synthetic. The actual extracted-runtime regression holds preflight, issues Stop,
and proves no reserve/prepare/dial occurs after release while the shared
engine/store/owner remain usable. It mocks external process/provider boundaries.

The first extraction check caught four existing bootstrap tests expecting the
sanitized pre-runtime failure event; restored that output without treating an
unknown runtime cleanup as confirmed. Final review also tightened authorization
ID length to the downstream schema before admission; a 121-character request
now fails before creating any receipt or runtime effect.

`swift test --package-path mac` passed **58 tests in 0.085s**, including optional
bounded callFlow decoding and status priority without granting Stop authority.
The native executable built and `bash mac/scripts/package-task-panel.sh` passed
local ad-hoc signature verification. The rebuilt UI reconnected to the existing
local service; its current task was left untouched. This did not restart or
reconfigure the service or enable calls on its existing local-only binding.

`media/.venv/bin/python -m unittest discover -s media -v` passed **351 tests in
77.479s**, OK. No Python implementation or provider selection changed. Connector
independently reviewed/tested launcher and runtime lifetimes; transport approved
final orchestration, exact authority, recovery and documentation; Mac specialist
reviewed shared service ownership and cleanup. `git diff --check` passed; lead
reviewed scope and secrets. No live call, capture, standby deployment or line
handoff was performed, and no d/e completion tag is claimed.

## 2026-11-18 — Prepare the first desktop-created decision call

Preparation exposed a configuration lifetime mismatch: each authorized standby
window creates a new deployment ID, while the desktop fingerprints immutable
configuration. Moved deployment ID and restore record to the strict per-call
request. Static config retains the exact project/environment/service. Full request
deduplication covers the new evidence, and the native inspector still verifies
actual runtime identity and standby state before dialing. This does not assert
that a supplied record establishes readiness or authorize a deployment.

Prepared a separate disposable task-list project and fixture source session,
without copying a database, key or session row or impersonating handset pairing.
The existing delegated export boundary remains necessary for the real destination.
Submitted a task through the native desktop panel and observed one actual Codex
run reach needs_decision revision 3. The independent empty-state assertion failed
as deliberately seeded; JavaScript syntax passed. In the browser, an uppercase
filter rendered the matching release-notes task and an unmatched query rendered
the unfinished empty list. The current source and result snapshots opened in
TextEdit; all three prepared targets resolved successfully through the helper's
metadata-only exact-window lookup. Preflight reported unlocked console, complete
login and existing screen permission. No capture or export grant was started.

The original desktop service and its unrelated existing task were preserved.
The fresh service remains configured but dormant with zero call attempts. A
read-only backend lookup reported live mode, live traffic true and a successful
deployment. Fresh one-call and backend-only standby/restore permission are needed
next; no historical call authority or deployment evidence is reused. The private
source session expires and all window identities require revalidation at call time.

Validation: `npm run check` passed **1,239 tests in 73 files in 12.26s**, typecheck
and build. Tests cover distinct standby evidence across decision/review calls,
unchanged static configuration, same-event proof conflicts and missing/invalid
proof rejection before admission. Transport independently approved the final
change and ran the 52 focused integration/launcher/runtime tests plus typecheck.

Mac/media readiness checks: from `mac/`, `swift build --product
ClawdTimeTaskCapture` passed (build 0.13s), and `swift test --filter
TaskCapturePolicyTests` passed **3 tests, 0 failures in 0.002s**. From `media/`,
`.venv/bin/python -m unittest test_task_voice_livekit.RealSDKSmokeTests -v`
passed **2 tests in 0.098s** and `.venv/bin/python -m unittest
test_task_walkthrough.SDKTests -v` passed **2 tests in 0.195s**. These used
synthetic localhost/in-memory SDK boundaries with no actual room, provider or
capture. No Python or Swift implementation changed. `git diff --check` passed;
lead reviewed scope and secrets. No live call, deployment, line handoff or
physical acceptance occurred; d/e tags remain withheld.

## 2026-11-18 — Authorized desktop call preparation; no dial

The user authorized one visual call of at most 15 minutes, exporting only the
prepared app/source/result views and accepting a spoken task instruction, plus
temporary ClawdTime-backend-only standby and restoration. No second call or
automatic redial was authorized. Recorded the human scope privately.

Revalidated the exact ready task and three windows. The first read-only Railway
runtime probe timed out; a minimal SSH command succeeded and a later read-only
probe established live runtime with zero pending/unknown effects and zero active
calls. The native line inventory showed exactly one matching available line.
Python's system CA setup refused the inventory request; Node's normal verified
TLS succeeded without disabling certificate verification. Recorded the current
backend variables privately, then submitted the authorized standby change once.
Standby deployment and actual running standby/traffic-false state were verified.

The prepared request returned HTTP 400 before durable call admission. Read-only
status and the empty attempts directory confirmed no attempt or external effect.
Local validation isolated the cause: the configured venv Python symlink resolved
to a root-owned system executable with mode 0775. The Mac specialist replaced
only the ignored venv `bin/python` symlink with a byte-identical owner-protected
copy at the same path, mode 0700, and retained original symlink/checksum metadata
privately. Global Python, static configuration, worker state and security guards
were unchanged. Venv isolation and all six pinned dependencies were verified;
from `media/`, `.venv/bin/python -m unittest
test_task_voice_livekit.RealSDKSmokeTests test_task_walkthrough.SDKTests -v`
passed **4 tests in 0.229s**, exit 0.

Before resubmission, macOS again reported all three exact windows offscreen.
Metadata rechecks, selecting the prepared browser view, and native-window
selection did not establish stable current-desktop visibility. User activity
interrupted the final native selection; further desktop input stopped. No second
POST was made. No media/provider session, capture or native call was created.
Requested that the user return the prepared windows to the current desktop;
restored the backend rather than leaving the hosted dispatcher paused while
waiting. Preserve the rejected envelope/response and use fresh current views,
grants and deployment evidence when the user returns. The one-call human
authorization has no dial against it; no physical acceptance is claimed.

`npm run check` passed **1,239 tests in 73 files in 12.24s**, typecheck and build.
No tracked Python/Swift implementation changed. Restoration proof and independent
review are recorded below before this checkpoint is committed.

Restoration deployment `af2ba7ab-6d72-4010-b0fb-acd1884d9008` succeeded.
Read-only verification established exact equality with the original variable
snapshot, runtime/environment mode live, traffic true, zero pending/unknown
effects and zero active calls. The standby deployment was removed. The task
service remains awaiting_call_authorization with no admission receipts or attempt
directories. The original unrelated desktop task was untouched.

Transport independently approved the documentation against the observed
pre-admission refusal, local repair, visibility blocker and restoration facts.
Lead reviewed scope/secrets and `git diff --check` passed. No d/e tag is claimed.

## 2026-11-18 — Desktop-created visual call and explicit-choice clarification

After the user returned the prepared windows to the current desktop, all three
exact-window checks passed. Resumed the unused one-call authorization with fresh
task/view grants and a separately recorded standby window. Read-only inspection
confirmed the selected task at revision 3, one available bound line, and no
pending/unknown effects or active hosted calls. Standby deployment
`e8b28c63-d480-467d-87e9-b5c8bdd339d0` and actual running standby/traffic-false
state were verified before the single operator submission. HTTP 202 recorded one
admission; native connected evidence subsequently established an actual call.

The desktop retained one task/store/session owner through the call. A finalized
bare assent created a distinct second scoped Codex run. Sharing retired as that
run began, while the media runtime remained active and accepted additional speech
frames. The worker correctly refused to infer which of two designs was intended,
made no source change and returned the unresolved choice. The task now remains
needs_decision at revision 7, with two completed runs, passing syntax and the
deliberately unfinished empty-state assertion still failing. This is a demonstrated
spoken handoff, not a completed result/review rehearsal.

The user confirmed the opening/preview were clear and the call ended correctly
when requested, then explicitly asked to move on. No further call is planned or
authorized. Voice continuity after picture clearance, all three scenes, explicit
Stop-sharing timing and the full measured handset targets were not individually
confirmed. No d/e completion tag is claimed.

The original call receipt is closed with native cleanup complete and media closed.
Presentation cleanup confirms capture/narration stopped, output cleared and
children joined. Audio SDK metadata reports 1,583 prepared silent frames and 1,644
speech frames; those counters do not establish physical audibility. Restored the
backend to its exact original variables through deployment
`32849cef-53f3-48de-b23c-1ed73cc1760f`; read-only runtime proof confirms live mode,
traffic true and zero pending/unknown effects or active calls. No retry/redial or
second call occurred. Protected attempt/standby proofs remain private.

Repaired the ambiguity revealed by this call. For a current unresolved
multi-option decision, new bare assent/deictic instructions now return bounded
clarification instead of creating an instruction receipt, held correction or
worker run. An exact offered Yes/No choice remains valid. Historical instruction
receipts replay before the new guard, and a new explicit utterance retains its
exact human wording. Voice and worker context now include the recorded options
in original order, allowing an actual ordinal answer to retain its meaning.
The media runtime validates/caches clarification and supplies bounded guidance
to ask once for the exact choice without claiming work started. Epoch checks
prevent stale clarification from authorizing speech from a retired turn;
physical conversational behavior remains untested after this repair.

`npm run check` passed **1,252 tests in 73 files in 12.13s**, typecheck and build.
Transport and connector independently reviewed the shared service/context/media
changes and passed 61 focused TypeScript tests. Tests cover unchanged task and
receipt counts after repeated bare assent, a later explicit answer, genuine
Yes/No choices, preserved historical replay and ordered choice context. Connector
independently passed 79 focused Python tests in 10.046s. Full media regression
results follow below; no Swift code changed.

After confirmed cleanup and passing backend checks, gracefully refreshed only
the local rehearsal service to load the repair. The desktop identity, static
configuration, task/revision and closed call receipt were verified unchanged;
the fresh process remains dormant and requires fresh call authorization. This
did not restart the unrelated desktop service, renew the fixture session, choose
a task option or reopen media. The behavioral repair is offline-tested and has
not received another physical call test.

Final `.venv/bin/python -m unittest discover -s . -p 'test_*.py'` from `media/`
passed **354 tests in 75.176s**, OK, with output redirected to a temporary local
log. An earlier full run before final small prompt/bounds
changes had 354 tests in 92.219s with one existing synthetic-browser process
timeout (`test_stalled_frame_clears_and_stop_fences_delayed_start_and_decode`);
the final complete run passed without changing that test or its timeout. Final
focused media validation passed 79 tests in 2.840s. No failing run is counted as
passed. Independent source/doc reviews completed, lead reviewed scope/secrets,
and `git diff --check` passed. Only local source/service repair was installed;
no production code deployment or additional handset test is implied.

## 2026-11-19 — Resumed desktop decision flow; review activation failure

The user specifically authorized both calls in one desktop-to-two-call rehearsal,
prepared views and spoken task instructions, plus temporary ClawdTime-backend-only
standby/restoration. Resumed the existing desktop-created task instead of resetting
its history: it already contained two completed runs and an unresolved choice at
revision 7. Same service, project, task and source session remained authoritative.
Source session lifetime and idle receipts were checked; the paired native line
was available and the hosted owner had zero pending/unknown effects or active calls.
The media specialist passed the helper build, three capture-policy tests, four
pinned SDK smoke tests and three clarification regressions without live effects.

Refreshed the current source/result documents, verified displayed revision 7,
and waited for the user to place the exact windows on the current desktop. All
three metadata target checks passed. Standby deployment
`742fd92f-ef9f-43dd-9cdb-98200ee8935b` matched current variables and actual runtime
standby/traffic-false state. A new decision request was submitted exactly once;
HTTP 202 was followed by actual native connection and media activation evidence.

The specific spoken empty-state choice created exactly one additional scoped
Codex run. It completed in **32,121 ms**; independent filter/empty-state assertions
and JavaScript syntax passed, yielding **review_ready revision 11**. The user
reported that the first call seemed to work, with a dark picture after the
instruction. That retirement is expected when a new run invalidates old shared
views; voice continuity after clearance was not individually confirmed. The
picture transition needs clearer explanation in the product experience. Native
cleanup, media closure and presentation Stop completed without canceling coding.

The old preview server was no longer listening when the lead reloaded the page
after the first call. Restarted only that loopback fixture server and verified
the actual new browser result: “No tasks match,” Clear filters restoring both
rows, and uppercase RELEASE selecting only the release-notes row. The first
call had shown the existing unchanged pre-revision page. Rebuilt the source and
verification snapshots for revision 11. TextEdit initially retained older file
contents and one close operation timed out; metadata confirmed that window had
closed, and reopening through its native recent-files menu displayed the updated
source. The user restored the prepared windows to the current desktop before
fresh exact-window resolution and the review request.

The same authorized standby window covered the separately bound review call;
transport independently confirmed each runtime performs fresh native/deployment/
authority checks. New request, manifest, grants, authorization and attempt IDs
were used. A real prepared preview frame reached the SDK. Sharing retired while
media was still prepared/ringing, before conversation activation. Native
connection, authority checks and activation-budget checks subsequently passed;
media activation remained an unknown effect receipt and cleanup ended the call.
The human reported automatic hangup. **Zero speech frames** were accepted for
this review attempt. The exact first retirement trigger was not recorded; no
provider-outage, source-window, or underlying-repair claim is justified.

Both new admissions are closed with native cleanup complete and media closed.
The task remains **review_ready revision 11**, three completed runs in its total
history, with no acceptance and no additional run from the review attempt. This
was a resumed flow, and its failed review does **not** count as a completed
planned two-call acceptance rehearsal. Both call authorizations are consumed;
there was no redial or third call. Private request, receipt and bounded metadata
proofs remain under the rehearsal root's `rehearsal-20261119/` directory. Screens
and audio were not persisted.

Restoration deployment `326891e4-d1cd-476f-ad7a-5806dd2ba36c` succeeded. Read-only
checks established exact original variable equality, actual runtime/environment
live, traffic true and zero pending/unknown effects or active calls. The standby
deployment was removed. The historical unknown activation receipt is preserved
alongside confirmed cleanup; it was not rewritten as successful. Apple Teams,
sibling chert-facetime and the unrelated original desktop service/task were not
changed.

### Diagnostic checkpoint and verification

Added optional walkthrough-only sharing diagnostics. They retain the first
observed retirement reason, lifecycle phase, bounded elapsed time/frame age,
source/render counters, and allowlisted presentation failure categories through
cleanup. The strict TypeScript parser rejects arbitrary nested fields/reasons;
shutdown summaries retain only typed metadata. No pixels, audio, transcripts,
raw exception text or provider bodies are added. The first cause survives later
Stop/close calls. Activation, capture, freshness and authority guards are unchanged.
This improves the next diagnosis; it does not establish or fix this call's trigger.

Independent transport and connector reviews approved the change. Tests cover
source loss, stale frames, authority/task retirement, SDK export failure,
first-cause preservation after close, bounded metadata/no raw-text disclosure,
optional old responses, real Python-to-TypeScript wire validation and actual
runtime shutdown-summary retention while preserving the shared owner.

- Final `npm run check`: **1,268 tests in 73 files, 12.20s**, typecheck and build passed.
- Final full media discovery: **358 tests in 77.079s**, OK, exit 0.
- Focused media regression: **90 tests in 13.635s**; transport focused tests: **46 passed**.
- The first full TypeScript run exposed a cross-language test fake missing the
  newly used diagnostics/counters. Updated that fake to use real presentation
  diagnostics and validated both prepared/closed snapshots against the actual
  TypeScript schema. The final complete run passed; the earlier failure is not
  counted as a pass. No production fallback was added to conceal missing state.
- No Swift implementation changed. The non-live helper build and policy checks
  above remain the applicable Mac validation.

After all checks and confirmed cleanup, gracefully refreshed only the idle local
rehearsal service to load the diagnostics. The old process released its owner
lock naturally. Authenticated readiness confirmed unchanged task/revision,
desktop identity, configuration fingerprint and exact closed admissions. It is
awaiting fresh call authorization; no session renewal, worker replay, capture,
provider connection or call occurred. No production code update or d/e completion
tag is claimed. Lead scope/secret review and `git diff --check` passed.

## 2026-11-19 — Successful separately authorized desktop review retest

The user authorized one additional visual review call and a temporary
ClawdTime-backend-only standby/restore window. The team independently checked
unchanged checkpoint `1eadca5`, exact review acceptance guards and non-live media
readiness. The helper reported an unlocked logged-in console with screen
permission; protected Python and six pinned dependencies remained valid. No
runtime source changed and no provider/capture activity began during preflight.

Authenticated desktop status confirmed the intended task at review_ready revision
11 with passing verification, a sufficiently long-lived session and all prior
admissions closed with cleanup confirmed. The paired line was available; hosted
runtime had zero pending/unknown effects or active calls. Reloaded the actual
browser preview, restored its no-matches view, and confirmed TextEdit displayed
the current source and revision-11 verification. After the user returned all
three views to the current desktop, exact target resolution passed. No further
UI input or feedback prompt was issued while the call was ringing/connected.

Standby deployment `3f84ca74-c9f7-4d8f-81f7-37342af04bba` was verified against exact
variables and actual runtime. Submitted one new review request with fresh
manifest/grants/authorization, then observed native connection and media voice
activation with preview sharing still active. HTTP admission alone was not
counted as connection or physical visibility.

The task transitioned **review_ready revision 11 → accepted revision 12**.
Read-only protected receipt inspection found exactly one acceptance bound to this
review's voice session, task, latest run and expected revision 11; zero instruction
receipts belong to that voice. Ordered run IDs and total count (three historical
runs) remained unchanged. Latest run and passing verification were unchanged.
No worker was started and acceptance did not deploy code.

The user reported the picture becoming dark after submitting the request, with
“everything else” working perfectly. This request was recorded as acceptance;
the task revision invalidated the old shared presentation while voice continued.
Explained that transition and retained clearer end-of-sharing presentation as
remaining polish. Do not count individual source/code/result scenes or measurable
interruption/zoom/Stop thresholds as physically confirmed from that broad report.

Native end/cleanup, media closure and presentation clearance are confirmed.
Final bounded sharing diagnostics preserve first reason `remote_stop`, active
media phase, 56,765 ms elapsed and 345 ms frame age, with no presentation failure.
This reason does not identify the initiating actor; independent task/receipt
metadata establishes acceptance. SDK counts (155 source frames, 777 rendered
frames and 1,202 speech frames) do not establish physical timing or audibility.
No screens or audio were persisted.

Restoration deployment `256f40da-4b07-4112-8130-994c3507831b` succeeded. Exact
original variables matched, actual runtime/environment were live with traffic
true, and pending/unknown effects and active calls were all zero. The standby
deployment was removed. The single call authorization is consumed; no redial,
additional call, session renewal or local service restart occurred. All receipts,
including the earlier review's unknown activation outcome, remain preserved.
The unrelated desktop task, Apple Teams and sibling chert-facetime were untouched.

This completes the existing desktop-created task lifecycle across a resumed
decision call and successful review retest. It does not count as a clean complete
two-call rehearsal or close the plan's three-rehearsal/measured-acceptance gates.
The historical failed review's exact retirement cause remains unknown; success
with the diagnostics active does not establish a permanent repair. Private bounded
proofs are retained in `review-retest-20261119/`. No d/e completion tag is claimed.

Validation and final independent evidence review follow before this documentation
checkpoint is committed.

`npm run check` passed typecheck, **1,268 tests in 73 files in 12.14s**, and build.
No Python/Swift source changed; the prior full 358-test media result remains the
applicable regression baseline, rather than a newly claimed rerun. Connector
independently approved the exact acceptance/no-new-run conclusion; transport
reviewed the final documentation and restoration boundaries. Lead scope/secret
review and `git diff --check` passed.


## November 19, 2026 — keep prepared windows shared throughout a call

The user requested that sharing remain active after spoken requests and
acceptance, replacing the current view mid-call only when another view is
needed. Updated README, both implementation plans and the walkthrough/desktop
handoff guides. New desktop call admissions require an explicit call-continuity
capture grant. Historical grants and exact admission replays retain their
original semantics and receipts; the policy is enforced only for new effects.

Lead added trusted call/voice/export capture bindings and separated current
capture authority from the evidence used for prepared result claims. Transport
implemented durable binding validation and ongoing capture checks. Connector
added real TypeScript-to-Python wire cases, task/acceptance/Stop coverage and
legacy replay regressions. Media keeps the previous fresh prepared window until
the replacement's first exact frame, preserves freshness watchdogs, and cancels
stale scene speech without stopping video. An immutable manifest's outdated
labels/highlights/narration stay suppressed. The active voice conversation owns
call narration; the separate local narration path cannot compete with it.

Initial preparation and opening still require current task/artifact verification.
Continuous capture cannot change the prepared target catalog, mint another call,
extend permission, revive Stop, or accept a later result under an old review.
Task revisions and acceptance keep live pixels; explicit Stop/call end, capture
failure, stale frames, expiry and revoked authority still clear promptly.

Independent review found that requiring the new grant in the public input schema
would reject historical receipt lookups. Moved the requirement after exact prior
receipt replay/conflict handling and before any new claim/effect. Review also
added an opening-time artifact-change refusal so neutral live-view framing cannot
stand in for a verified opening.

No live call, deployment, credential change, daemon restart or state migration
was performed. The prior restored live backend and consumed call authorizations
remain unchanged. Physical handset continuity and measured view replacement/Stop
remain pending a newly authorized call; automated tests do not qualify them.
Validation results follow below.

Final validation: `npm run check` passed typecheck, **1,287 tests in 73 files
(12.58s)**, and build. Full media discovery passed **365 tests in 84.569s**.
A subsequent neutral narration wording adjustment avoids implying that an
acceptance-only revision erased valid task verification; all 39 presenter/wire
tests and build passed again. Transport independently reviewed root capture
lifecycle/Stop/initial proof; connector independently reviewed media and ledger.
All owners reported no remaining blocker. Lead scope/secret review and
`git diff --check` passed. No Swift source changed and no physical qualification
or d/e completion tag is claimed.


## November 19, 2026 — one continuous-sharing handset retest failed

The user authorized one visual retest and separately confirmed temporary
ClawdTime-only standby/restoration. The lead refreshed the idle local desktop
owner to `48b7b6f`, retaining identity, configuration, all receipts and the accepted
revision-12 task. Created a new task through the desktop operation API to review
the unchanged fixture. Its single real worker run completed and both independent
checks passed; browser inspection also confirmed uppercase RELEASE filtering,
No tasks match and Clear filters. Source matched the project; the result document
showed current revision 3. Native target resolution confirmed all three views
before the one submission.

Task `task_a3f116c1-d47f-44d6-ac43-ef5d7533b996` remains review-ready revision 3;
run `run_2505bcd1-26a4-460d-a77a-8da63f441099` and verification
`verification_218a8983-9323-4095-9173-d3a797fbdb4f` passed. Fresh call-continuity
capture/export grants and current standby/identity/exclusive-idle-line checks
preceded the single attempt. No prior grant or call request was replayed.

Attempt `call_attempt_34aa06c4-f4bd-4740-a991-0a960c0d1bb8` completed media prepare
and native dial, but sharing retired while prepared. Diagnostics: first reason
export_unavailable, elapsed 12,386 ms, last successful source-frame age 1,034 ms,
21 source frames, 119 rendered frames, no presentationFailure, zero speechFrames.
Activation subsequently recorded unknown; retain that historical effect even
though native end/media close and all cleanup are now confirmed. The lead also
submitted one exact local Stop request during cleanup, without retrying a dial.
The user reported only that it hung up. No acceptance/instruction/new run occurred;
this failed attempt did not physically exercise continuity or scene switching.

Standby deployment `540dcc71-0d5d-4491-9ab6-a303edfa8c73` was removed after restore.
Restored deployment `7ab45fa8-0e05-4f2f-bbaa-06e5384b1d2a` matched exact original
variables, runtime/environment live and traffic true, with zero pending/unknown
hosted effects and active calls. All five local admissions are closed with cleanup
confirmed. Original accepted task remains revision 12 with three historical runs.
No screen/audio was persisted. Private bounded proofs are in
`continuity-retest-20261119/`. Both one-call and standby authorization are consumed.

Team investigation found no new context-wire or ringing authority mismatch.
The generic export reason can include a one-second frame-age rejection; the
recorded last-successful-frame age alone does not prove the live trigger. Media
is reproducing the capture cadence separately while preserving all freshness
and authority limits. No repair claim is inferred from this failure.


Offline reproduction and narrow repair: the native helper timestamps before
SCScreenshotManager capture. Injecting 450 ms acquisition into the prepared/ringing
fixture reproduced premature retirement under the old loop: first stop at about
2.040 seconds, last frame age 1,015 ms, source count 5 / rendered count 28. The
loop added a full 200 ms sleep after work, aging the current frame unnecessarily.
Changed capture scheduling to a maximum 5 fps deadline cadence, accounting for
work and avoiding catch-up bursts. The same regression passed after the change;
connector independently reproduced the passing case. No timestamp, one-second
export limit, authority check or Stop fence was relaxed.

Explicit SDK publication frame-age errors now retain the existing `frame_stale`
category instead of collapsing into generic export_unavailable. Binding and
closure errors are separated from actual age failures. Added slow-capture,
no-catch-up, retained-first-cause and SDK diagnostic-category regressions.
Connector's five independent targeted checks passed; source review approved the
narrow change. This fixes a demonstrated scheduling defect but does not establish
that it caused this handset attempt or that the live experience is now repaired.

Final validation: `npm run check` passed typecheck, **1,287 tests in 73 files
(12.18s)** and build. Full media discovery passed **369 tests in 88.460s**.
Lead scope/secret review and `git diff --check` passed. Connector independently
reviewed the source and five targeted regressions; transport reviewed evidence
and handoff boundaries. No Swift source changed. This checkpoint has no new
handset acceptance or step-d/e qualification tag.


## November 19, 2026 — second continuity retest confirms freshness retirement

The user authorized one additional visual retest and the previously described
backend-only standby/restoration. Lead reused the legitimately review-ready task
at revision 3, preserving both historical task records and all receipts. No new
worker/run or acceptance occurred. Current preview, source and revision-3 result
were checked; all exact window targets resolved. Fresh one-call/export/capture
identities with continuity enabled, standby proof, native identity and exclusive
idle-line checks preceded one submission. Each attempt spawns fresh Python, so
this call loaded the `2809bb0` pacing/classification changes without restarting
the unchanged TypeScript parent.

Attempt `call_attempt_b0bfed97-240b-4fe2-9fc8-3137ccf87d84` completed media prepare
and native dial, then retired sharing while prepared: first reason frame_stale,
elapsed 16,458 ms, last successful source-frame age 1,017 ms, 54 source / 174
rendered frames, no presentationFailure and zero speechFrames. Later activation
remains unknown as recorded. Native end/media close/final cleanup are confirmed;
lead also submitted one exact local Stop during cleanup. All six admissions are
closed. User reported “just hung up again.” No physical continuity, view-switching,
acceptance or sharing-Stop qualification resulted.

Restored deployment `2197b683-d03e-4381-9c37-d8cda54d9a12` matched exact original
variables and actual live runtime/environment with traffic true and zero pending,
unknown hosted effects and active calls. Standby
`9ef7a104-6e6f-4aea-9780-6b7aea93a2b2` was removed. Private bounded proofs are in
`continuity-retest-2-20261119/`. No screens/audio were persisted. Call and standby
permissions are consumed; no automatic redial or broader capture was attempted.

The timing repair fixed its reproduced offline case but did not resolve the live
failure. The new reason establishes freshness retirement, not its upstream cause.
The last-successful-frame age alone cannot distinguish watchdog versus SDK
rejection or acquisition, render, context and event-loop delay. Team is adding
bounded first-stop pipeline timing metadata and independent synthetic fault cases,
without changing the one-second limit, capture authority, Stop or call admission.
Local capture qualification must precede another proposed handset test; synthetic
success alone is not a basis to repeat calls with the human.


Diagnostic-only follow-up: media now freezes an optional `pipelineAtStop` with
its first sharing-stop reason. It distinguishes watchdog/publication triggers
and capture-local-authority/voice-context/source, export-context/publication and
SDK validation/decode/capture/postcheck phases. Elapsed/age fields are bounded
milliseconds or null; no identifiers, window names, arbitrary errors, transcript,
pixels or audio are added. Candidate age means the most recent selected candidate,
not necessarily one currently in SDK publication. A snapshot reports observations
at retirement, not causal attribution by itself. Diagnostic collection failure
returns null and cannot prevent Stop.

Transport validates the optional strict shape, preserving old snapshots and the
existing audio-only stripping behavior. Connector exercised actual Python closed
status through the TypeScript parser and shutdown-summary retention. Fault tests
independently stall source capture, each authority path, rendering and publication,
assert guarded clearance/cleanup and frozen first evidence after close, and check
bounded normal jitter. Connector's independent eight-case matrix passed in
15.147s; its 89 focused integration checks passed. These synthetic cases isolate
the diagnostic behavior but do not qualify real Mac capture or repair this live
failure. No freshness, capture authority, call admission or retry guard changed.

The current parent process remains the previous build; the new strict TypeScript
parser must be loaded by an idle, state-preserving refresh before any future new
media process uses this wire shape. No extra call, local capture session, daemon
restart or deployment occurred during this diagnostic work.

Final validation: `npm run check` passed typecheck, 1,308 tests across 73 files
(12.09s), and build. The complete media suite passed 378 tests in 104.937s.
Independent transport/connector/media reviews and `git diff --check` passed.
This checkpoint preserves diagnostic evidence; it does not claim a live repair
or physical acceptance of continuous sharing.

## November 19, 2026 — local capture investigation, visibility prerequisite

User authorized local capture testing and fixing the stall before another phone
call, with the existing specialist team. Lead inspected the current task and
prepared source/result/fixture contents; revision 3 and all six closed admissions
are unchanged. No call, provider connection, deployment, daemon refresh or task
mutation occurred.

Media built a private, bounded local probe using the native exact-window helper,
production presentation renderer and an unconnected LiveKit SDK video source.
It requires a fresh exact grant, single-use configuration intent, current read-only
task proof and prompt signal-driven Stop with joined child cleanup. It emits only
sanitized timing/count summaries. Its local authority/export loop is explicitly
an approximation, not production call admission or handset evidence. Four private
harness tests passed in 4.019s, including replay refusal, Stop during an awaited
authority check with zero capture, cleanup and actual unconnected SDK conversion.
Connector independently reviewed the probe and passed three existing diagnostic
regressions in 3.734s. Private scripts and bounded measurements are saved under
`local-capture-20261119/` in the protected rehearsal root.

Read-only task API baseline: 100 requests at 25/s, p50 1.82 ms, p95 3.93 ms,
maximum 6.18 ms. This is not a measurement of the voice-context endpoint. At the
prepared window's 2042×1792 source dimensions, 120 annotated transition renders
took p50 16 ms, p95 22 ms and maximum 39 ms. The approximate pipeline passed
100/300 ms injected acquisition but failed at 450 ms with 10 ms authority checks.
The separate benchmark using actual TaskWalkthroughLiveKit prepare/export/
watchdog/ExportAuthority, real rendering and SDK conversion reproduced the same
pressure: 300 ms passed ten seconds; both 450 ms trials retired during prepare at
1.830/1.832s with last exported source ages 1,031/1,035 ms. New source ages were
517/537 ms, render ages 0/3 ms and last SDK accept was only 49/54 ms earlier.
Thus a render wakeup alone is not an evidenced reliable fix while respecting
15 fps and one-second freshness. These synthetic cases do not establish actual
native acquisition cost or explain the failed handset attempt conclusively.

Real capture remains pending: permission and unlocked-console preflight passed,
but both native window APIs marked all three prepared windows offscreen. The
attempt to foreground Chrome via its native Window menu timed out. Lead asked
the user to bring the prepared windows onto the current desktop. No capture
grant was created or capture started after that failed target resolution. Do not
relax the visibility/freshness guards or place another call. Measure actual
native acquisition, then the local pipeline, before selecting a production fix.

## November 19, 2026 — real local capture reproduces the stall

User requested one further test call. Lead held dialing because local qualification
reproduced the failure; that call authorization has not been consumed. No new
standby authorization was requested and no deployment changed. Read-only hosted
readiness still showed the restored live deployment with zero pending/unknown
effects and active calls.

The now-visible exact prepared windows allowed a fresh local-only native probe.
It captured 368 frames over 75.193s before source visibility was lost; immediate
metadata resolution marked all three prepared windows offscreen. Returned source
age was p50 100 ms, p95 139 ms and maximum 272 ms. Cleanup joined. This first
failure is distinct from freshness retirement.

After the user restored visibility, the local renderer/unconnected-SDK pipeline
failed at 100.755s with a watchdog age of 1,105 ms (488 source, 1,490 rendered and
1,477 accepted SDK frames). All three exact windows still resolved immediately
afterward. Maximum loop lag was 304 ms; the longest observed source-timestamp gap
was 797 ms. Other agents had been running synthetic checks during that interval,
so load was a confound, not an established cause.

A subsequent isolated probe ran with every team benchmark stopped and froze a
bounded numeric stage timeline at first failure. It retired at 20.875s: native
I/O was pending for 845 ms while Python's maximum loop lag was 9 ms, task checks
at most 14 ms, current rendering 14 ms and SDK publication about 3 ms. There were
98 source frames and 303 SDK submissions; the last shared source aged to 1,004
ms. Cleanup joined and the exact windows still resolved. This narrows that local
failure to the native helper/pipe path, not specifically a native API yet.

Lead gracefully refreshed the authenticated idle loopback owner to load the
current diagnostic parser. The original owner exited and released its lock
before replacement. Both task histories, all six closed admissions and all
static configuration bytes were verified unchanged; the new instance is still
the sole owner on 13336. No task, call, provider or remote room was started.

The Mac specialist added opt-in native phase telemetry. Default capture behavior
is unchanged. Telemetry uses closed phases, bounded elapsed time and sequence
numbers only, with small nonblocking stderr writes and no retries. The private
reader detects observed sequence gaps and preserves transient pixels in memory.
No observed gap does not rule out a lost final marker; phase attribution must also
consider the surrounding healthy reader/timeline. Independent review caught and
removed synchronous diagnostic backpressure before actual profiling.

The first native-phase probe completed 60s with 295 source frames and 885 SDK
submissions, maximum accepted source age 523 ms, and joined cleanup. This short
pass does not repair or disprove the intermittent failure. A fresh technical
grant under the existing local-test authorization is being used to measure
prepared-view switching.
Private one-shot grants, summaries and probe scripts remain under
`local-capture-20261119/`; no screenshots, recordings or transcripts were saved.

The longer profiled run completed 240.004s with joined cleanup, 1,192 source
frames and 3,573 SDK submissions. All 11 requested view replacements received
fresh matching scene/generation evidence; measured transition-to-receipt times
were 996–1,187 ms. Maximum accepted source age was 660 ms and maximum native
request time 431 ms. This validates that local run only, not handset continuity
or elimination of the intermittent native stall.

A second profiled switching run stopped after 27.191s with `source_stopped`,
133 source frames, 398 SDK submissions and one completed replacement. The last
accepted source was only 320 ms old. Its native trace returned a refusal after
the post-capture validation marker and before JPEG encoding; the exact guard
is not yet known and no sequence gap was observed. All three exact windows
resolved immediately afterward. This refusal does not reproduce the earlier
long native I/O wait. Cleanup
joined. A same-build profiler-off comparison follows to avoid treating diagnostic
timing changes as a behavioral fix.

The profiler-off comparison on the same helper build stopped at 88.510s with
`source_stopped`, 437 source frames, 1,312 SDK submissions and four completed
switches. Last accepted source age was 292 ms and cleanup joined. It does not
isolate the refused guard or establish a profiling observer effect. The Mac
specialist then added 21 fixed refusal markers covering the existing identity,
visibility, geometry, capture and encoding guards. Standard stdout and all guard
conditions remain unchanged. Independent connector review approved the change;
`swift test --package-path mac --filter TaskCaptureTimingTests` passed both tests
in 0.002s and rebuilt the helper. A fresh 90-second run uses the expanded reader.

The expanded native trace reproduced the freshness stall at 27.738s. The final
marker was `capture_image`, pending for about 843 ms, while the Python capture
request was pending 884 ms and last accepted source age reached 1,045 ms.
Rendering remained responsive (last render 13 ms, current render age 1 ms), and
SDK publication continued. The native reader reported neither failure nor an
observed sequence gap. There were 131 source frames, 405 SDK submissions and one
completed switch; cleanup joined. This localizes the observed wait to the
`SCScreenshotManager.captureImage` interval, subject to telemetry's missing-final-
marker caveat. The earlier post-validation refusals remain separately unresolved.
The user was released from holding the prepared desktop visible. No call or
standby deployment was made. The next implementation experiment must avoid
replaying cached pixels or extending the one-second freshness limit.

Diagnostic checkpoint validation: `npm run check` passed typecheck, all 1,308
TypeScript tests across 73 files (12.33s), and build. `swift test --package-path
mac` passed 60 tests (0.116s overall test-suite time). `media/.venv/bin/python
-m unittest discover -s media -p test_task_presentation.py` passed 33 tests in
7.016s. Independent connector source review and `git diff --check` passed.
Transport prepared an independently reviewed private actual-owner/native probe;
five offline tests passed in 13.052s, including single-use refusal, forbidden
external actions, actual owner switching/Stop and signal cleanup. It has not yet
performed actual native capture. No step completion tag or physical acceptance
is claimed by this diagnostic checkpoint.
