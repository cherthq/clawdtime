# Conversational control: source release and acceptance

## Latest rollout result: 0.4.0 implemented; hosting promotion blocked — November 13, 2026, 23:25 UTC

**The résumé recording demo is not ready in production.** Voice completion reporting
and the scoped document discovery/preview/send flow are implemented and validated
as source 0.4.0. Railway failed all three submitted release uploads before a build
could start: `Failed to snapshot repository. Please try again in a few minutes.`
Each failed deployment has `snapshotId:null`; no new application image ran.

Restored and verified production **0.3.2** using its prior image and custom
variables. Backend `51db1940-dcbd-46ca-836b-d3d484a1ca4e` is SUCCESS; media
`7c884f0c-02af-4f0a-92bd-43a33acb084e` remains SUCCESS. All 74 JavaScript,
18 Python and 10 public asset hashes match prior manifest
`c7c6e9c65653d7c42c6f09414340a58a3e888034e5e3f2bc2f1705f833a6419d`.
Running configuration, database entities/events/effects/Messages cursors and media
ledgers are unchanged. No database restore occurred. Normal conversation/document/
voice/desktop admission remains disabled; the previous execution-disabled audio
test remains available. Both services' separately staged new feature flags were reset to false after
verifying that rollback restored running configuration but retained staged edits.
No additional service restart was needed. No pending rollout remains.

The validated 0.4.0 source archive is retained with manifest
`913b60d7f52a249335bebe536135041ae2044c55acf6ad1f73b4da208d889140`, archive SHA-256
`6ef5ec3603beb1589e6db96c03f58a378e171243ab051b30279a1fd37b9ad8c6`.
Checkout `npm run check`: **872 tests / 55 files**, typecheck and build pass.
Exact isolated archive: **851 tests / 53 files**, typecheck/build pass. Media:
**294 passed, 13 optional skips**; qualified SDK suite **63 passed**. This release
also fixes actual-provider document prompt compatibility, Stop/grant expiry cleanup,
document-only presentation policy and confirmed GPT-Live speech ownership.

Two real GPT-Live → text model → HTTP broker → Codex trials independently verified
file results, acknowledged their completion context and closed the provider. One
trial deliberately delayed execution by fifteen seconds; a concurrent spoken
status turn returned current backend state in **3 ms**. Completion context ACKs
were **721 ms** and **645 ms** after observation/queueing respectively. Total trials
were 25.534 s and 43.391 s including synthetic speech and deliberate waiting.
These are individual fixtures, not handset playback latency or controlled p95.
The real text-model document flow verified all three jobs: discovery **1,417 ms**,
preview **1,959 ms**, transfer preparation **1,694 ms**, total **7,140 ms** with a
simulated attachment provider. Private Chrome preview loaded in **66 ms**.
The first two real-model document probes failed before any job due to a second
system-role message; consolidation into the provider instructions fixed it.

Local authorized read-only preflight rendered **4/4 supported documents** (one
Word, three Pages), 116–248 ms each. No real document was uploaded, sent or changed.
The user explicitly **skipped the synthetic attachment delivery test**. Real
provider attachment acceptance/handset delivery, FaceTime preview readability,
resumed duplex and audible completion remain unaccepted. The earlier physical
speakerphone result remains one execution-disabled cutoff/no-noticeable-echo trial.

Installed digital audio-route provenance is now established independently of
physical echo acceptance: running build `262acc83…` maps to `cd19dc255…`; its
inclusive UID/path/generation-validated FaceTime/avconferenced taps exclude the
worker and fail closed. Fresh exact-line session health proves the line-session
branch is enabled even though the customer API omits its protocol capability.
This supports the process-isolation assertion when 0.4.0 is successfully deployed.
No upstream files or runtime state were copied or modified.

Final health: zero active calls/media, pending/unknown effects and unresolved
execution ownership; gateway connected. No new managed production session, call,
sample message or résumé send occurred. Exact current pairing credentials and the
local folder were checked read-only. A bounded foreground document-worker launcher
is prepared locally, but was not started against the restored older backend.
A fresh user readiness statement is still required before any call.

Fresh encrypted backups `/data/backup-before-documents-040-20261113.enc` on both
volumes passed offline integrity checks. Private metadata-only rollout, failure,
source, test, route and restoration evidence is in `.data/document-demo-20261113/`.
The exact remaining gap is Railway source snapshot creation for this project;
retry the retained archive after that facility recovers, keeping one backend
SQLite writer and rechecking idle ownership first. Reapply only the documented
0.4.0 flags after successful source deployment; verify hashes before starting a
fresh local root grant. No fresh account, GPT-Live key or helper upgrade is needed.

Both conversational planning/handoff files and the unrelated phone-control plan
remain untracked and unstaged. No files were committed or staged; unrelated website
work is preserved and excluded from the deployment archive. See
[release details](CONVERSATIONAL_CONTROL_RELEASE.md) and
[document host setup](CONNECTORS.md).

## 0.4.0 document and voice completion release — November 13, 2026

Source implementation is complete; the latest rollout result above records the
provider snapshot failure and verified restoration to 0.3.2. This release adds a deterministic, read-only local document host over
the shared asynchronous broker. A human-selected folder gets an immutable,
expiring session grant; discovery, first-page preview and exact selected-file
transfer each have independently checked outcomes. Only a distinct explicit send
instruction can authorize the paired iMessage attachment. No arbitrary recipient,
model-supplied path, automatic retry or desktop control is granted.

Preview PNGs and original transfer bytes are transient. Private preview links use
a short-lived fragment capability, cleared from browser history; voice reports
never include that capability. A document-only FaceTime scene publishes the
selected first-page image without capturing or controlling the desktop. Stop,
expiry, revoked pairing and disconnect revoke access and pending work; previously
attempted external effects retain their original unknown/receipt state.

Voice submission now waits for finalized speech items plus measured quiet PCM,
not the SDK's provisional transcript gap. Nondelegated trailing speech is also
adjudicated, so it cannot leave a verified completion permanently held. Completion
updates use authoritative broker verification and are correlated with GPT-Live
metadata acknowledgments. ACK is provider context receipt, not audible playback.

One real GPT-Live → actual text model → HTTP broker → Codex → independent file
verification trial passed, including the verified completion ACK and clean
provider closure. Startup 1,933 ms; text interpretation 2,115 ms; executor acceptance
282 ms after dispatch; verification 9,772 ms after durable acceptance; final
completion ACK 721 ms after the probe observed verified state. Total 25,534 ms
includes synthetic instruction playback. This is one fixture observation, not a
latency percentile or a controlled success-rate estimate. No handset was involved.

A second real voice trial deliberately delayed execution by fifteen seconds and
spoke a status question while the executor was running. Both turns were accepted;
the backend returned current status in 3 ms without waiting for execution. The job
then independently verified, the completion update was acknowledged (645 ms), and
the provider closed cleanly. Four updates were queued and acknowledged with zero
rejected/unknown receipts; no calls or Messages were used. Total 43,391 ms includes
synthesized speech and the deliberate wait. These two voice trials are distinct
fixtures, not the plan's controlled 30-trial performance matrix.

A separate actual HTTP worker/QuickLook/Chrome test verified all three document
jobs, expiry, revocation and duplicate-send suppression with a simulated attachment
provider. The latest scripted-front-end sample took 981 ms total, including 108 ms
browser image load. A further real text-model trial passed discovery, preview and
transfer in 1,417 / 1,959 / 1,694 ms (7,140 ms overall, 66 ms image load). Two
initial real-model attempts failed before any job: provider instructions rejected
a second system-role message. Consolidating document context into the single
instructions field fixed that concrete defect; no external effect was retried. Local authorized file preflight rendered one Word document
and three Pages documents successfully (116–248 ms each); no original was changed,
uploaded or sent. Full-document review, FaceTime visibility and handset delivery
are separate physical acceptance steps.

### Deployment and rollback

Keep simulation/standby as development defaults. Production uses an explicit fast
text model (`gateway`, `openai/gpt-6-luna`) and separate conversation, document and
attachment admission gates. The installed digital return route is qualified by exact build provenance and
fresh line-session health: binary `262acc83…` maps to `cd19dc255…`, whose owned
FaceTime/avconferenced inclusive taps exclude the worker and fail closed on process
identity change. This establishes process isolation, not handset echo/tail or
resumed-conversation acceptance. General
Codex/desktop grants remain independent of the document-only demo.

Use the fresh bounded setup/worker commands in CONNECTORS.md. Local Ctrl-C revokes
the document grant; a worker cannot awaken this desktop chat or inherit its native
CUA. The session expires within one hour and is never silently rearmed. Start a
new grant near the actual demo rather than extending old approval. No call is
placed until the user gives fresh readiness.

Before deployment: exact scoped archive, npm run check, component validation,
idle ownership and fresh encrypted volume snapshots with offline verification.
Use one backend SQLite writer: stop the idle prior backend, deploy media, then
backend. Preserve the newer database/cursors/attachment receipts on rollback;
never restore a stale database to replay a send. Disable new admission and Stop
first; unresolved effects require reconciliation before code rollback. Private
metadata-only operational evidence is under `.data/document-demo-20261113/`.
The two conversational handoff files, unrelated phone-control plan and unrelated
website work are excluded from staging and the deployment archive.

## 0.3.2 tool correctness patch — November 13, 2026

This patch was deployed at 22:43 UTC. Backend `2e5a67d8-cf69-4370-944d-6349d2b024bf`
and media `7c884f0c-02af-4f0a-92bd-43a33acb084e` are SUCCESS; deployed hashes
match source manifest `c7c6e9c65653d7c42c6f09414340a58a3e888034e5e3f2bc2f1705f833a6419d`.
See the latest STATUS entry for complete real-provider probe outcomes. It does not
promote unqualified conversational/desktop admission or certify the résumé demo.
The exact source retains the existing gated deployment policy. The earlier physical speakerphone test exercised an execution-disabled, one-shot
output cutoff; it did not execute tools or test conversational recovery.

The broker rechecks session authorization, interpretation holds and executor
availability immediately before invocation. Newer instructions hold completion
reports until interpretation is resolved. Admission and Stop inspect all owned
jobs, including older unresolved work outside the status page window.

The voice frontend binds delegation to an observed speech item, preserves callback
ordering, retains authoritative job tracking across superseded spoken replies and
records provider commentary context acknowledgments separately from execution or
handset playback. Reordered/stale transcripts cannot submit an older command.
Provider errors and transcripts remain transient and suppressed from SDK logs.
Executor subprocesses exclude frontend/control-plane credential namespaces;
existing Codex login or explicit CODEX_API_KEY provides executor authentication.

Actual local HTTP pull-worker lifecycle validation used Codex
0.166.0-alpha.5.1: executor acceptance 480 ms, concurrent status 3.375 ms,
independently verified result 13.555 s, confirmed cancellation 109 ms. Revision
stopped the old task, required explicit renewed confirmation and independently
verified the new result. These are single-fixture observations, not percentiles;
transport and conversation input were scripted in that lifecycle proof.

The requested résumé demo needs functionality this release does not provide:
read-only candidate discovery and exact file/digest selection, document preview,
bounded transfer, a selection/recipient-bound attachment effect, and attachment
receipt reconciliation. The existing text outbox cannot certify a sent document.
Upstream attachment idempotency must be qualified independently; do not retry an
ambiguous attachment send. A folder selected by the user is not a desktop control
grant or authorization to send an unspecified file. No résumé is uploaded by this
patch. Remote-only audio, reliable utterance finality and resumed duplex conversation
still require acceptance. The installed SDK can finalize on an 800 ms transcript
gap even while PCM continues; a synthetic success cannot qualify general command
finality. Keep normal voice admission disabled until that boundary is qualified.

Validation before packaging: npm run check passed 811 tests/51 files, typecheck
and build. Full media: 275 passed and 13 optional skips; qualified SDK suite:
44 passed, including actual SDK wire decoding, callback HTTP, verification gating
and commentary acknowledgment correlation. Those wire tests simulate the provider.

Rollout keeps the existing identity, ledgers, SQLite volumes and admission flags.
Create fresh encrypted snapshots, verify them offline, and compare the exact
isolated source archive to deployed files. Roll back code only after standby and
quiescence, retaining newer ledgers/unknown outcomes. No handset call or message is
part of this rollout. The two conversational planning files and unrelated native
phone-control plan remain outside the archive and Git index.


November 13, 2026. Source package 0.3.1, uncommitted implementation atop `a5af1f3`
on `improvements`. The two approved planning/handoff files and the unrelated phone
control plan remain untracked and unstaged. No sibling project was changed.

## First speakerphone qualification — November 13, 2026, 22:26 UTC

One fresh user-authorized speakerphone call ran on deployed 0.3.1. The listener
reported that output went quiet **after deliberately interrupting**, with **no
noticeable echo**. This is one qualitative physical trial, not a latency percentile,
repeatability result, headphone comparison or ordinary conversational acceptance.

The dedicated GPT-Live session started, received audio and published audio. One
speech-onset interruption was detected; output latched off and remained muted as
designed. Stop ended the exact call. Native and media cleanup are confirmed;
zero active calls/media sessions and zero pending/unknown effects remain. No redial
was attempted. The visible foreground controller also confirmed cleanup.

Same-process metadata: connection-notice TTS request to first publication **265 ms**;
last notice publication to first model-audio publication **5,191 ms**; detected onset
to local queue clear **0 ms at millisecond resolution**, with 10 queued frames at
onset. These are server publication/queue timings, not handset audibility or cutoff.
The user did not supply a measured audible tail; the <=300 ms handset target remains
unproven. The first-model publication interval also needs further investigation;
it is not an end-of-user-utterance measurement.

The final `cutoffs:3` counter includes cleanup clears, not three human interruptions.
All 77 transcript events were discarded; no transcript/audio/screen content was
retained. Private metadata-only evidence:
`.data/audio-speaker-test-20261113-222414/result.json` and observations. Physical
findings do not enable any normal conversation, desktop-control or isolation gate.
A further call requires fresh readiness/authorization.

## Audio-only qualification deployed — November 13, 2026, 22:05 UTC

**Source 0.3.1 is ready for a supervised handset test. No call was placed.** This is
an execution-disabled acoustic test, not acceptance of ordinary full-duplex work.
The user must still explicitly state readiness for each new call.

- Backend: `2dc6293e-81c1-49a2-b97d-21c8249f8b36`, SUCCESS, Node 24.22.3.
- Media: `b683019a-6bae-4ac2-be65-ec540cf1d22a`, SUCCESS, Python 3.12.16.
- Isolated uncommitted source manifest:
  `9e50e96d4db5aa9746ca2e7d4679dcbd3eef073fa41628a8a0e151030cfa4768`,
  atop `a5af1f3` on preserved `improvements`; unrelated website work excluded.
- Verified 74 deployed JS, 18 Python and 10 public-asset hashes. The only protected
  configuration changes are the two dedicated audio-qualification admission flags.
  Normal broker/runner/desktop/GPT-Live/duplex/isolation gates remain off. The
  existing helper 0.2.1 and local gateway were not replaced or restarted.
- Backend entity/event/effect/cursor hashes and all existing media ledger tables
  are preserved. Final health: zero active calls/media sessions, pending/unknown
  effects or unresolved execution ownership; gateway connected. No new managed
  session, invitation, message, screen lease or desktop grant was created.

The mode has a fresh immutable session identity, no executor/broker/approval path,
no screen capture/captions, a three-minute foreground controller (five-minute hard
ceiling), and independent local Stop. It discards all model delegation/transcript
events. Ordinary Messages instructions are suppressed during the test. The native
call path retains exact line/member preflight and once-only effect receipts while
skipping unnecessary desktop permissions. Stop during preparation closes media
before dial; unconfirmed cleanup remains unknown. Heartbeats cannot renew expiry.

The readonly deployed controller check reports `ready:true` and
`executionDisabled:true`. Actual identical GPT-Live test configuration started in
**1,202.0 ms locally** and **832.4 ms on the cloud host**; both received confirmed
provider closure (cloud total 2,285 ms). No input audio, handset or FaceTime call
was used. These are two access checks, not speech latency or a reliability cohort.

Validation: checkout `npm run check` **801 tests / 50 files**, typecheck and build
passed. Exact isolated deployment archive: **780 tests / 48 files**, typecheck and
build passed. New coverage includes 41 backend/native qualification regressions
and five controller tests. Media: **271 passed + 12 optional skips** (283 total);
qualified SDK/RTC/probe suite: **27 passed**. Tests initially exposed two real
edge cases (Stop during media preparation and malformed heartbeat); both were fixed
before the final passing runs. Mac helper/gateway code did not change in this phase;
prior component validation remains separate evidence.

**One interruption measurement per call:** local output clears and remains latched
off until the call ends. No automatic resume is claimed. The upstream output has
no verified handset playback-flush acknowledgment. Audible startup, echo, false
interruptions and the actual cutoff/tail must be measured on the handset. Physical
acceptance and latency/success targets remain unproven.

[AUDIO_QUALIFICATION.md](AUDIO_QUALIFICATION.md) gives exact controller commands,
foreground Stop, fresh-call readiness and headphone/speakerphone procedure. The
owner-only operator configuration is prepared locally; it contains no new account
credential and is ignored by Git. API access remains qualified, with key expiry
December 13, 2026. Both protected planning files and the unrelated phone-control
plan remain untracked/unstaged; no implementation files were staged or committed.

Rollback artifacts and metadata are in `.data/audio-qualification-20261113/`.
Encrypted consistent backups on each service volume are
`/data/backup-before-audio-031-20261113.enc`; both decrypted and passed offline
integrity checks without touching the live databases. Previous backend `f8932374`
and media `c197bb86` exact source archives were verified against their running
hashes before replacement. Disable qualification, Stop and reconcile ownership
before any rollback. Retain newer code disabled while outcomes are unknown;
never restore an older database/cursor or redial as recovery.

## GPT-Live access and SDK deployment — November 13, 2026, 21:47 UTC

With the user's explicit authorization, created the **ClawdTime** OpenAI project
and project service-account key `clawdtime-media-gpt-live`, expiring **December 13,
2026**. Stored the secret only in Railway production media `OPENAI_API_KEY`; no
secret was printed, committed or written into repository files. The key has inherited
project API read/write permissions, not organization administration permissions.
No further credential setup is needed from Gary. Rotate the key before expiry.

Media deployment **`c197bb86-a198-4f72-906a-7f6ab1d97f83`** is SUCCESS, replacing
the earlier gated image and intermediate key-only deployment. Its isolated source
manifest is `1d658394b7349003083d7d1c1bd99cfd1e94d3c0b0006dd607432076eb5746aa`,
source version 0.3.0. Backend `f8932374-b6a1-4039-9a43-d15697633713` is unchanged.
The media image includes Python 3.12.16, LiveKit RTC 1.2.1/API 1.2.2,
Agents/plugin 1.8.12, OpenAI 3.50.0 and WebSockets 15.0.1. Build-only
`ENABLE_GPT_LIVE=true` installs dependencies; all voice, duplex and text-control
runtime admission gates remain **off**.

Real `gpt-live-1` client-delegation sessions, each one bounded attempt with no audio,
started in **1,317.7 ms locally** and **1,234.7 ms on the deployed server**. Both
received provider-confirmed `close_requested` closure; cloud total elapsed time was
2,674.4 ms. The first local probe failed before connecting because Python lacked its
default CA bundle. The corrected probe explicitly uses certifi with hostname and
certificate verification enabled. That failed attempt is retained in the evidence.
These two successes are access checks, not a reliability cohort, audible response
measurement or physical acceptance. The actual LiveKit SDK was separately checked
against a loopback provider, not a real handset conversation.

Media validation now passes **266 tests with 10 optional skips** in the base
environment; the qualified optional environment passes all **10 SDK/probe tests**.
The earlier full TypeScript, gateway and Swift validation remains applicable.
No call, audio capture, test message, desktop grant or control input was issued.
Post-deploy verification matched all 17 deployed Python files to the source archive.
Backend deployment/configuration, runtime media policies and every existing durable
ledger/cursor hash are unchanged. Final health reports zero active calls/media
sessions, pending/unknown effects or unresolved ownership; gateway connected.
Key/configuration and deployment evidence is retained privately under
`.data/gpt-live-access-20261113/`; source-only archives permit exact code rollback
without restoring old data. The preceding 0.3.0 source archive also remains available.

**API access is ready; handset testing is not yet ready.** The execution-disabled,
unisolated-audio qualification mode is still missing. Actual remote-only routing,
echo and downstream interruption/flush behavior remain unqualified. Do not bypass
isolation flags. Complete the software qualification path before asking Gary to
prepare for a fresh, explicitly approved call. The older rollout record below is
historical where it describes missing credentials/dependencies.

## Authorized gated deployment — November 13, 2026, 21:32 UTC

The user authorized rollout but explicitly withheld readiness for any call. Deployed
an isolated **0.3.0** source snapshot with manifest SHA256
`3302d324035ddf69be3ee78a4ce4a59b274d250f54dac7354b2e475b36081a56`.
This is an uncommitted snapshot atop `a5af1f3`, not a new Git commit. The separate
website sprint, including its mixed shared-file hunks, was excluded without modifying
that work. Both protected conversational planning files, the phone-control plan and
all other untracked plans remain unstaged/uncommitted. Nothing was staged or committed.

| Component            | Deployed / prepared                    | Observed state                                           |
| -------------------- | -------------------------------------- | -------------------------------------------------------- |
| Backend              | `f8932374-b6a1-4039-9a43-d15697633713` | SUCCESS; package 0.3.0, Node 24.22.3; 72 JS hashes match |
| Media                | `720d1ffa-fd1c-4d8b-bf79-996074e3d4e5` | SUCCESS; Python 3.12.16; 16 Python hashes match          |
| Public assets        | Existing website from scoped snapshot  | 10 hashes match; website sprint not deployed             |
| Companion            | Prepared 0.3.0 build 4                 | Ad hoc signed and verified; not installed/notarized      |
| Installed Mac helper | 0.2.1                                  | Unchanged; no local gateway/helper restart               |

The new broker admission, hosted Codex runner, text control, GPT-Live and duplex/
isolation gates all remain **off**. The inherited legacy pilot retains its existing
live configuration and binding; no line was transferred. `/api/jobs` and the text
control-grant route return disabled (409). This is a gated code deployment, not an
enabled new conversational service or physical acceptance. No call, invitation,
managed live session, desktop grant or outbound test message was created.

Final health: zero active calls/media sessions, pending/unknown transport effects
or unresolved execution ownership; media configured and gateway connected. Backend
entity/event/effect/cursor hashes and every existing media ledger table hash match
pre-rollout. Protected service configuration hashes are unchanged. Encrypted
consistent backups remain on each service volume at
`/data/backup-before-conversation-030-20261113.enc`; both decrypted and passed
integrity checks in an isolated temporary file/in memory without restoring live data.

Previous exact code is retained for rollback: backend `7f1b687` (prior deployment
`c5fcff89-ca61-463b-b0a1-24e04bc9fdae`) and media `f7611d2` (prior deployment
`cb123fed-509f-499b-93b5-a30b88a2d3cc`). Those predecessors are now REMOVED. Their
source was rebuilt and matched against pre-rollout running file hashes. Rollback
is a **code** redeployment with preserved current volumes/configuration, never a
routine restore of an older database/cursor. The standby/quiescence rules below
apply before rollback after any new feature has been enabled.

Private metadata and source-only archives are retained under
`.data/conversation-rollout-20261113/`: `proof.json`, `installed.json`,
`backup-verification.json`, `release.json`, `validation.json`, the scoped source
archive, rollback source archive and prepared companion ZIP. Temporary build paths
in the metadata are not durable; re-extract the retained archives if needed.
The companion ZIP SHA256 is
`4693021b9e9ea84a810f87103f9fe4a9932e78eab2bcffc0616840e90fe7d08b`.
Do not deploy the mixed working tree as if it were this snapshot.

The exact archive passed 734 tests/46 files, typecheck and build. A separate check
of the mixed checkout passed 755 tests/48 files, typecheck and build after one
synthetic screenshot-test timeout; that test also passed its focused 8-test rerun.
Media/gateway/Swift validation is recorded below. No new handset latency or physical
success-rate samples were collected during deployment.

At the initial 21:32 rollout, media had LiveKit RTC 1.2.1 and API 1.2.2. GPT-Live Agents/plugin/
OpenAI packages and a direct OpenAI key were then absent. The later access/SDK
rollout above resolves those prerequisites. Audio-route qualification,
execution-disabled echo testing and fresh user readiness remain prerequisites.
Backend/media health alone is not a GPT-Live readiness probe.

## Behavior and execution hosts

The optional broker owns durable acceptance, dispatch receipts, instruction order,
revisions, cancellation and unknown outcomes. Job instructions/history/images are
transient. Restart marks queued payloads as needing clarification and in-flight
work unknown. A running revision requests cooperative stop and waits for renewed
clarification after quiescence; it never automatically replays the revised task.
Terminal results retain fixed summaries and bounded verification metadata. Late remote results are retained separately for explicit reconciliation and never silently overwrite an unknown job. If the session credential is already invalid, the worker retains its local result ledger for operator review.

A text model proposes bounded intent; deterministic code validates binding and
capability. One frontend owns the output outbox. It can clarify and report actual
state while execution continues. Voice uses the same broker and state through
`/media/:id/conversation/turn` and `/jobs`. Speech interruption does not cancel work;
qualified interruption holds new desktop input pending finalized intent. Native
approvals stay at the host. The current managed adapter reports approval wait,
declines the pending native request and interrupts; remote approval UI is unavailable.

Supported source routes:

- Local broker → installed Codex App Server, exact allowed local project root.
- Hosted broker → explicitly started authenticated local executor worker → Codex
  App Server. The worker uses a protected run/connection and its own dispatch ledger.
- Bounded custom desktop route → media → outbound gateway → Swift helper, under a
  separately locally accepted text-session grant. Source implemented; not installed
  or physically qualified in this change.
- Native adapter lifecycle can wrap a qualified supplied port. No programmatic
  native shared-Mac provider was established for this managed host. It is unavailable.

Codex App Server `0.166.0-alpha.5.1` was actually tested. It starts a separately
identified managed thread and does not attach to this desktop chat. Its normal
workspace sandbox/on-request policy remains; installed tool configuration is
host-owned, not an advertised deterministic file-only tool allowlist. Claude Code
legacy connectors remain; no new Claude managed-runner capability is claimed.

## Run and configure

```sh
npm ci
npm run check
npx tsx tests/connectors-runner-spike.ts
npx tsx tests/connectors-broker-spike.ts
```

The two opt-in probes start an actual managed Codex agent in a disposable project,
then remove only that fixture. They do not call a phone or drive desktop UI. The
broker probe labels its scripted frontend and Messages transport as synthetic.

For a local development backend, supply credentials through protected environment
configuration, not command arguments or tracked files:

```sh
export CLAWDTIME_MODE=simulation
export CLAWDTIME_CONVERSATION_ENABLED=true
export CLAWDTIME_TEXT_PROVIDER=gateway
export CLAWDTIME_TEXT_MODEL=openai/gpt-6-luna
export CLAWDTIME_CODEX_RUNNER_ENABLED=true
export CLAWDTIME_EXECUTOR_PROJECT_ROOTS='["/absolute/explicitly-authorized/project"]'
npm run dev
```

`CLAWDTIME_AI_GATEWAY_KEY` supplies the existing scoped Gateway credential. Direct
OpenAI text uses `CLAWDTIME_TEXT_PROVIDER=openai`, an explicit model, and
`CLAWDTIME_OPENAI_API_KEY`. There is no model fallback or automatic retry of effects.
The example model is a measured candidate, not a universally fastest default.
`CLAWDTIME_CODEX_BINARY` optionally specifies the installed executable. Its actual
version and root availability are probed before advertising execution.

New registration must include protocol 2 and immutable
`conversation:{version:1,runnerId:"codex-app-server",executionSession:"api_managed"}`.
Use `--runner codex-app-server --execution-session api_managed` on a new connector
registration, or `remote-codex-app-server` for the explicit local worker. Do not
resume an old run with changed architecture. See CONNECTORS.md for exact CLI flow.
No live registration, message, call, installed helper or line ownership was changed
by these development commands.

Session-authenticated `GET /api/jobs` returns state, capabilities and monotonic
process timing. `POST /api/conversation/turn` accepts `{eventId,text}`. Stable event
IDs deduplicate delivery; separately sent identical text is a new request. Text
`/sessions` and `/use SESSION_ID` choose an eligible session. A stopped/expired
selection does not silently select another session. `status`, `cancel task`, and
`stop speaking` have distinct deterministic behavior.

Text control additionally requires `CLAWDTIME_TEXT_CONTROL_ENABLED=true`, existing
explicit AI-action provider/model configuration, media `MEDIA_TEXT_CONTROL_ENABLED=true`,
and the new helper/gateway. Session-authenticated `POST /api/control-grants` takes
`grantId`, `actions`, `durationSeconds` (30–900), `policyRevision`, and the current
`localEnableGeneration` from helper readiness. It only proposes a grant. Accept it
locally, then `GET /api/control-grants/:id` validates and records the exact grant.
The selected whole display is the permitted surface; a requested app/field remains
an action target, not an OS-enforced app sandbox. Request the custom adapter
explicitly. `auto` has no qualified desktop default.

GPT-Live uses optional `media/requirements-live.txt` (Agents/plugin 1.8.12). Build
media with `ENABLE_GPT_LIVE=true` only after provider/session access qualification.
It needs `OPENAI_API_KEY`, `MEDIA_GPT_LIVE_ENABLED=true`, existing two-way/isolation
gates, and a newly negotiated conversational session. The protected media
configuration now has a qualified direct OpenAI project key and deployed SDK. AI
Gateway access alone does not establish GPT-Live access. Do not change isolation
flags to make a test pass; runtime admission remains disabled.

## Evidence and measurements

Pre-rollout audit on November 13 found backend
`c5fcff89-ca61-463b-b0a1-24e04bc9fdae` (same `7f1b687` image after configuration
redeploys) and media `cb123fed-509f-499b-93b5-a30b88a2d3cc` (`f7611d2`).
Current configuration, database path and transport binding were audited directly;
older deployment IDs and line assumptions are historical. Both services were idle,
with no executing legacy turns, broker jobs, grants or unresolved execution ownership.
The current rollout record below supersedes this pre-rollout baseline.

| Real measurement                                        | Evidence                                                                                                     | Limitation                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Actual Codex runner                                     | Acceptance 309 ms, verified file result 8.362 s                                                              | One disposable trial, no desktop input            |
| Broker + real slow runner                               | Status 0.654 ms while running; total 20.688 s                                                                | Scripted frontend, simulated Messages             |
| Authenticated HTTP broker + local worker + actual Codex | Acceptance 415 ms, HTTP status 2.155 ms, independent result 11.975 s, total 12.002 s                         | Scripted frontend, simulated Messages; zero calls |
| Real text frontend + actual slow runner                 | Clarified, queued, independently verified, completion reported in 18.146 s; status 0.889 ms during execution | Messages simulated; no handset                    |
| Gateway `openai/gpt-6-luna`                             | 5/5 expected intent choices; 1,988–3,337 ms                                                                  | Synthetic text, no provider message delivery      |
| Gateway `openai/gpt-6.1-terra`                          | 5/5 expected intent choices; 2,402–2,870 ms                                                                  | Synthetic text, no provider message delivery      |
| LiveKit GPT-Live                                        | Actual 1.8.12 SDK client-delegation lifecycle against loopback WebSocket                                     | No authenticated OpenAI session or audio/handset  |

The text-model target of p95 ≤2 s is **not established**; these measurements already
exceed it before Messages transport. The real full slice establishes execution,
not phone delivery. Prior handset speech/text tests belong to the deployed legacy
release and are not acceptance of this architecture.

No new native/custom physical benchmark has been run. The native managed-host
adapter is unavailable; the new custom helper is not installed or locally granted.
Therefore zero comparable physical cohorts meet the required 30 trials/backend/
operation/call condition. No speed/success ranking or default was selected.
`npx tsx scripts/benchmark-control.ts METADATA.jsonl` summarizes the strict
metadata-only schema in that script, including every failure/cancel/unknown,
missing timings, version, fixture, frame age, cost and handset measurements.
Interleave identical fixtures for click/type/scroll/grounded tasks, with and
without calls. Never substitute the synthetic adapter safety tests for trials.

## Validation

`npm run check` on the exact isolated rollout archive: 734 TypeScript tests across
46 files, typecheck and build passed. Three additional regressions cover truthful
legacy/local-managed/remote-managed setup guidance. The first archive check found
one test requires Git history; rerunning with the repository Git directory available
passed all tests. Git metadata is excluded from the deployment upload.
Media: 257 tests with one optional SDK skip; that SDK test passed separately in the
isolated environment. Gateway: 35 passed. Swift: 44 passed. Mac setup scripts:
21 passed. Swift release build passed. Source companion packaging is 0.3.0 build 4;
installed companion remains 0.2.1. These are software checks, not physical acceptance.

## Migration, rollout and rollback

Keep admission flags off until capability/provider checks pass. No SQL table is
dropped or legacy session relabeled. Backend additive entity/event/outbox kinds
include conversation_job, job_dispatch, stream/hold, remote dispatch/result and
text grant/ownership/action receipts. Media adds separate text lease/action tables;
gateway/helper preserve protocol 1/2 and add protocol 3 without a fake call ID.
Preserve all of these ledgers, including unknown receipts, on rollback.

Before rollout: inspect exact dedicated binding, active sessions/calls, pending
and unknown effects; take encrypted consistent backups; stage matching backend,
media/gateway and signed helper artifacts; keep old sessions immutable. No new paid
account or line is implied. Managed-worker registration is explicit and uses an
exact project allowlist. Install helper only in an idle supervised window with
stable signing and retained previous build/configuration/receipts.

Rollback starts with backend standby while retaining protected configuration, stops
new conversational admission and workers, requests cooperative
cancellation/revocation, and reconciles call/media/helper cleanup. Wait for known
quiescence; unresolved effects remain unknown and block ownership transfer. Keep
new data with the matching newer release for inspection. Do not roll back a cursor,
erase a ledger, recreate dispatch IDs, or restart an old call. Disabling the conversation flag alone does not stop pending broker outbox messages;
standby must precede outbox inspection. Inspect legacy executing turns, broker jobs,
remote results, desktop ownership/actions, text grants and helper protocol-3 ledgers
as well as transport effects. Old code cannot enforce new unknown ownership. Do not
restore the old helper after protocol-3 receipts exist without compatibility
qualification. Disable new flags for subsequent sessions; old v1/v2 negotiation
remains compatible.

Required remaining acceptance: execution-disabled acoustic qualification mode;
actual remote audio isolation and speakerphone/headset echo; handset interruption
tail and audible-startup tests; explicit new-call readiness; supervised helper
installation/local text grant; native host qualification or honest unavailable
cohorts; 30-trial control matrix and provider/handset Messages delivery. External
FaceTime worker/handset output flush acknowledgement is not a supported measured
contract here; its queue capacity is not latency. Do not edit the sibling service
or redial using an earlier approval. This source is not production-ready.

## Current upstream contracts checked

- [Codex App Server](https://developers.openai.com/codex/app-server/): programmatic
  threads/turns, notifications, steering, interruption and approval boundaries.
- [GPT-Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation):
  delegation metadata is not task text; construct context from final transcript
  events and authoritative application state.
- [LiveKit GPT-Live](https://docs.livekit.io/agents/models/realtime/gpt-live/):
  audio-only GPTLiveModel, client delegation, model-controlled turns and limitations.
- [Installed AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data):
  generateText with Output.object; local strict schema validation still applies.

Account availability cannot be inferred from those documents. Five-trial model
samples and an SDK loopback handshake are not production availability or reliability.

## Operator handoff: GPT-Live and handset qualification

### What Gary needs to do

1. **API setup is complete.** The dedicated project service-account key is stored in
   Railway media and has passed real local/cloud GPT-Live session checks. No key
   needs to be pasted or supplied. The current key expires December 13, 2026; rotate
   it securely before that date. Keep runtime voice/control gates off.
2. **Wait for software readiness.** The execution-disabled audio qualification mode
   is not implemented yet. The lead must complete that path; Gary should not change
   audio-isolation assertions to bypass the missing capability.
3. Once the lead confirms software readiness, for the physical window, have this Mac unlocked, the ClawdTime panel visible,
   the paired iPhone charged and reachable, headphones available, and a quiet place
   for a separate speakerphone pass. Say **“I'm ready for one test call; headphones
   ready”** (or explain speakerphone-only). Until then there is no call, no invitation
   and no reuse of an earlier call approval. A failed/ended call does not authorize
   an unattended redial.
4. For desktop acceptance, use a disposable document with an explicitly identified
   field. The lead will install the prepared matching gateway/helper in the supervised
   window, preserve the existing identity/receipts, and ask you to enable locally and
   review the exact short-lived text-control grant. Do not enable screen control just
   to obtain GPT-Live access. File-only worker tests do not need a display grant.

### What the lead must complete before/during that window

- Fresh managed worker registration, exact authorized project, ready heartbeat and
  session selection; no native desktop capability claim. Keep all execution disabled
  during acoustic qualification. There is currently **no execution-disabled,
  unisolated-audio qualification mode** in this release, and no upstream handset
  playback-flush acknowledgment. Those are software/transport prerequisites, not
  settings Gary should bypass. Do not assert `remoteAudioIsolated=true` to unlock
  the test. Establish the real remote-only route before enabling conversational work.
- First measure one greeting, intelligibility, false speech/echo and assistant
  self-triggering with headphones, then speakerphone. Retain metadata, not audio.
  The handset observer confirms actual sound; server playback receipts do not pass.
- After qualification, exercise clarification → submit → actual slow execution →
  independent verification → report. While a deliberately 20-second job runs, ask
  status, add a correction, and say “stop speaking”; verify the job remains active
  until an explicit “cancel task.” Use iMessage and voice in the same fresh session
  and verify instruction ordering and actual terminal results.
- Measure end-of-utterance to useful audible response (target p95 ≤2 s), interruption
  to audible quiet including downstream tail (≤300 ms), text ingress to provider
  submission (≤2 s; handset arrival separately), durable accepted-job receipt
  (≤250 ms), and identified-field typing to visible verified result (≤3 s).
- Interleave at least 30 trials per available backend/operation/call condition with
  identical fixtures, including every failure/cancel/unknown. Native managed-Mac CUA
  is unavailable, so report that cohort unavailable rather than inventing a comparison
  or selecting an automatic default. Test local Stop/hangup and reconcile zero active
  ownership; preserve unknown receipts without retry.

Official references: [GPT-Live setup](https://developers.openai.com/api/docs/guides/live),
[client delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[model](https://developers.openai.com/api/docs/models/gpt-live-1), and
[LiveKit integration](https://docs.livekit.io/agents/models/realtime/gpt-live/).
