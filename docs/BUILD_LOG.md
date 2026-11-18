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
