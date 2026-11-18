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
