# ClawdTime implementation status

November 11, 2026 — America/New_York.

**Independent pilot. Welcome delivery passed; the latest control-enabled call lost its screen stream after a gateway timeout. Current voice/control acceptance remains pending.**
The earlier supervised Codex → FaceTime → Mac screen → authenticated Messages
feedback → same-chat continuation → Messages recap path passed on the original
pilot line. Correct control targeting, natural voice and the Claude Code physical
call loop remain unverified. Historical evidence below does not qualify the new
line or the later conversational harness.

## Control-enabled timeout and deliberate chat handoff — November 11

The user explicitly enabled display-1 control and authorized one test. The fresh
pairing, installed companion, actual Screen Recording/Accessibility grants and
local Enable were retained. Media received 18 screen frames, from 01:07:54.383
through 01:08:10.749 UTC on November 12. Screen video emission continued through
01:08:12.604; emission alone does not establish handset rendering. At
01:08:13.713 a gateway frame request timed out after 2,001ms. The screen selection
then stopped with `gateway_unavailable`. No computer input was recorded.

Two qualified voice turns retain `not_started/context_expired`. The user heard
that the active call was unavailable and no input was sent. The router used that
same error for a stopped screen selection even while the call remained connected;
qualified voice ingress requires a connected call. Thus the wording did not prove
the call had ended, and it was not a safety judgment about the requested input.
The historical turn records lack timestamps, so their precise ordering against
the frame timeout cannot be reconstructed independently.

Media closed at 01:08:42.764 and the native call subsequently ended. Terminal
acknowledgement released the original agent for diagnosis without human approval.
At the user's explicit chat handoff, the foreground bridge closed; fresh read-only
inspection finds its session stopped, the test/request canceled, all three calls
ended, both leases released, zero actions, and all nine effects done. The original
run must remain closed. Its pairing, permissions, receipts and event cursor remain
intact; another call requires fresh explicit authorization and a new audited run.

The retained gateway log has one untimestamped reconnect timeout and no per-request
timing. It cannot distinguish helper latency, local scheduling, media scheduling
or transport delay. The exact frame-timeout trigger remains unresolved. Increasing
timeouts, relaxing freshness or retrying capture would not be an evidence-based
repair. The follow-up preserves those limits and adds bounded correlated timing
metadata across the media/gateway boundary, with no frames, audio or payloads.
The backend now retains the first authenticated screen-stop reason and bounded
turn timestamps, and distinguishes a lost screen connection from unavailable
call/session context. It preserves the same fail-closed authority checks.

At handoff, backend deployment `f06f6be1-17f7-4c85-8a2c-08507b51af2e` and media
deployment `cb7aac1e-551c-4fbb-acdb-a617fd06d12c` ran the previously reviewed
`c6de85d` source. Follow-up validation passes 418 backend/connector tests plus
TypeScript/build, 108 media tests and 24 gateway tests. Independent review passed,
including real local HTTP/WSS delay and late-helper-completion regressions,
diagnostic transaction isolation, and preservation of failure history during
readiness polling. Formatting checks and skill validation passed. The installed
companion is unchanged. No new call, recap or physical acceptance has been claimed.

## Fresh onboarding and answered-call failure — November 11

The user confirmed that the website greeting sent as iMessage and that the welcome
with setup prompt arrived. An initial greeting from the user's original handset
was outside the previous pilot allowlist; the user selected that handset, the
allowlist was corrected without replay, and one fresh greeting succeeded. Backend
deployment `2fc5ca13-0e57-4415-a9c9-32b00a53e7ca` retains the existing code image.

This same Codex chat consumed the new setup link once, installed the project skill
and connection, and configured display 1 for explicit view-only sharing. The old
companion configuration and receipts were preserved. The existing app retained its
signature and macOS grants; the user enabled it locally. The fresh gateway connected
through media deployment `d78ee3d0-e57a-42b2-af0d-c223086ea64f`; scoped live checks passed.

The user authorized one outbound call and Messages recap, with no control exercise.
That call rang, and the user reported it ended when answered. Provider events show
active at 00:01:20 UTC on November 12, caller video published at 00:01:23, bridge
ready at 00:01:24, then ClawdTime requested closure. Media closed at 00:01:23.759
with zero Mac frames received. No screen, voice, continuation or recap acceptance
was established. The worker confirmed cleanup, leases were empty, and the original
connector accepted terminal acknowledgement without treating it as human approval.

Source inspection found that the media subscription callback closes the session
for any non-audio track, including video from the exact expected worker. This is
consistent with the observed failure timing; the callback did not retain a reason
code, so the historical event cannot independently prove that branch fired.
The corrected handler unsubscribes and ignores video from the exact worker while
retaining rejection of foreign participants, unsupported track kinds, conflicting
audio tracks and failed unsubscription. All 89 media tests pass, including seven
new callback regression tests; independent review found no actionable issue.
Media deployment `34d078b5-2f13-46df-9fab-20e2e701b3aa` succeeded from `3acd183`;
the previous deployment is removed, the live server hash matches the reviewed
source, and scoped readiness passed before the separately authorized follow-up below.

## Voice fallback and screen recovery — November 11

A second, separately approved view-only call stayed connected through startup on
the corrected media build. It emitted Mac screen video from 00:35:17 through
00:35:44 UTC on November 12 and received 42 frames. Six qualified voice turns
reached the conversation harness: three completed, two failed with
`frame_unavailable`, and one failed with `planner_unavailable`. The user reported
repeated “I couldn't safely act on that request” replies. That sentence was a
fixed error fallback, not evidence of a model safety refusal. The user subsequently clarified that they had asked for clicks and typing,
although this pairing and the approved setup test were explicitly view-only. No
computer input was recorded. The lead canceled the unsuccessful test;
worker/media cleanup, released viewing lease and terminal acknowledgement are
confirmed. Screen visibility, feedback continuation and Messages recap acceptance
remain unverified for this attempt.

The screen loop could silently return when policy freshness elapsed during an
HTTP 200 frame response. A subsequent valid policy for the same lease did not
restart that completed task. The corrected loop clears stale pixels and waits
without capture or renewal, then resumes its single existing task only with fresh
policy and an unexpired helper grant. It also rechecks authority after renewal
before requesting another frame. Expired grants, Stop and binding changes remain
terminal; no input or lease creation is replayed.

The last conversation failure discarded its underlying cause, so it cannot be
attributed retrospectively to a provider outage. Synthetic requests using the
actual deployed model/key succeeded for a greeting and an observe/image tool loop.
New bounded diagnostics distinguish API failure, timeout (including wrapped SDK
step timeouts), invalid final reply and other errors. Only status codes, step
counts, durations and allowlisted categories are retained; raw errors, prompts,
screens and audio remain excluded. Spoken/text fallback wording now describes
processing, timeout or missing-frame failure instead of implying unsafe intent.
The harness now passes trusted pairing capabilities into the conversation agent;
view-only sessions expose no click/type/scroll tools and explain that limitation.
Missing capability metadata defaults to view-only. The router still independently
enforces permission, so model output cannot expand it.

Validation: 408 backend/connector tests plus TypeScript/build pass; 101 media tests
pass, including delayed frame/renewal responses, same-lease recovery, Stop and
expiry regressions. Independent review found no remaining actionable issue;
backend deployment `f06f6be1-17f7-4c85-8a2c-08507b51af2e` and media deployment
`5eb45f25-498c-4c3f-a228-9f1a44d17b04` succeeded from `c6de85d`. Live source
hashes match the reviewed build and scoped readiness passes. A synthetic model
request to click/type under view-only permission returned a natural limitation
reply with zero tool calls. These checks do not establish physical acceptance or
authorize another call.

## Service-number correction — November 11

The user identified Mia's current number as different from the configured number.
Read-only checks confirmed that the provider inventory, running native API and
ClawdTime binding still reported the previous number. The Mac account lists both
aliases; that alone does not establish current Apple reachability. Earlier healthy
checks established configuration agreement and receipt availability, not handset
delivery to the correct number. The user subsequently confirmed that an unsent
draft to the corrected number shows blue/iMessage; no greeting was sent.

ClawdTime was put in standby and its obsolete public link removed before the
correction. The user ran the reviewed configuration-only installer with local
administrator authentication. It updated the existing worker/helper sender,
retained the installed binaries and original settings, and verified unchanged
native state, operation journals and event head before leaving admission paused.
The same provider inventory row and ClawdTime binding were then corrected; the
logical line, account, credentials, database and exact cursor 5 remained intact.
The original Lucas archive and historical hashes were also rechecked unchanged.

Deployment `2337484e-815d-4b9d-8191-4783f0a3f79f` succeeded using the existing
`f6177c0` image; prior standby deployments are removed. The exact owned maintenance
fence was released once. Transport checks pass, and the live browser verifies all
four prefilled Messages links and the visible fallback use the corrected number.
The pre-reopening audit had no pairing, message effect, call or native backlog.
No message or call was sent by the correction. The fresh greeting/welcome and
setup-call path still require handset acceptance.

The correction passed independent review and 43 offline checks. Physical
installation is confirmed by its bounded success receipt and fresh API identity;
this is not proof of message delivery or FaceTime acceptance. No sibling source,
other account, tunnel, local companion permission or receipt journal was replaced.

## Website-to-agent setup alignment — November 11

Before the pause, the website published the explicitly enabled service line as a Messages
link with “Hey ClawdTime.” It remains an invited iMessage pilot, not public signup.
A first message receives a warm welcome and the setup prompt in one durable reply.
The current-chat integration stays pending through permissions; its default test
is one approved video call, screen visibility, natural voice or text, same-session
continuation, and a Messages recap. Computer-control exercises are optional.

Backend deployment `38fecab0-bb83-46b2-b447-b23a119fd7d8` (code `f6177c0`) succeeded
before the standby correction above. TypeScript/build and 376 tests pass, as do the
built-app onboarding browser checks and 14 focused media checks. A live browser
check before the pause confirmed four prefilled Messages links, no preview interception and no JS
errors. Native Messages greeting prefill and the fresh Mia handset loop still
require human observation; browser links alone are not delivery evidence.

The README and setup skill now distinguish limitations: no automatic tapback,
standalone progress-message tool, inbound FaceTime, or general phone-originated
questions/work outside an active request. Audio is half-duplex. Public signed Mac
downloads and automatic fresh-device gateway provisioning are not available.
The current test uses the existing approved companion and lead-managed gateway.

## Dedicated-line migration — November 11

- The original Lucas line returned exclusively to Apple Teams after ClawdTime's
  dispatcher stopped. All five calls ended, all 23 leases released, and original
  entities/effects/events hashes remained unchanged. Its cursor, unknown outcomes,
  private configuration and encrypted consistent backup are preserved.
- Mia is assigned to an independent ClawdTime provider project with a scoped
  credential. Native identity matches the assigned logical line. A fresh database
  and encryption key isolate it from the historical Lucas runtime; event baseline
  5 was verified without replaying retained messages.
- Backend deployment `2313e4ae-fe0a-4031-bb9d-1341bc696d5a` is SUCCESS using the
  existing `e08eca1` image, live on Mia's separate database. Prior standby deployment
  `695f2901-4f62-488b-92cb-e588a7c43596` is REMOVED. Media and the installed local
  companion were unchanged. The provider acknowledged activation generation 6.
- Fixed provider receipt 503: the old helper lacked a text journal and its launch
  configuration lacked the sender field required by strict sending. The scoped
  installed worker/helper update uses reviewed source
  `742b40685d80eaba6fe584e135e1732c4153499f`; first-use initialization uses the same
  production journal implementation with zero operation rows. Original absence
  evidence and launch files remain available; no historical outcome was inferred.
- Receipt status/whoami now report available and the unused-origin lookup returns
  404/found=false. All transport preflight checks pass. Live runtime inspection
  reports zero pending/unknown effects and active calls, with no migrated pairing.
  No message, call or screen input was sent for this migration. Fresh Mia onboarding
  and handset acceptance remain unperformed; prior permissions and Stop are intact.
- Installation receipt: `FT-INSTALL-CLAWDTIME-MIA-REPAIR-20261111`. The reviewed
  installer passed 52 offline recovery tests; the separate journal initializer
  passed seven tests. Existing journals, other account PIDs and unchanged ingress
  were verified after installation. Rollback preserves the initialized journal.
  Two initial preflight refusals made no live changes; the final verified installer
  supports the documented per-account database path and a missing sender field.
  No sibling source or other account was modified.

See [the ownership and recovery record](LINE_HANDOFF.md). This migration does not
repeat handset acceptance or reuse an earlier one-call authorization.

## Conversational harness revision — November 11

User feedback requested natural voice/text, compound tool use, continuous video,
landscape guidance and removal of scripted confirmations. Implemented with three
parallel specialists and independent review:

- One model tool loop interprets qualified voice and authenticated Messages. No
  production command-prefix parser or required wake phrase. Observe, click, type,
  scroll, nonterminal visibility reporting, feedback and Stop are tools. Turns
  are bounded to eight model steps, four input attempts and 45 seconds. Each
  action is validated independently; changed images return to the same model for
  reconsideration before input. Unknown outcomes never replay.
- Screen capture uses one continuous authorized lease while the coding agent
  stays yielded. Input consumes its frame identity without blanking still-fresh
  video. Permission/identity/expiry checks, local Stop and confirmed release
  before continuation remain mandatory. No installed companion replacement or
  permission reset is required.
- Qualified speech reaches the conversation agent without a wake phrase; bounded
  model replies use durable at-most-once speech receipts. Speech remains
  half-duplex: listening pauses during synthesized speech, so barge-in is not
  implemented. Stale/busy/uncertain speech is not replayed.
- The agent can suggest landscape when the desktop looks small; it does not
  claim access to handset orientation telemetry.
- New setup notices do not contain SMS approval codes. The originating connector
  attests actual explicit authorization for one exact, unexpired test already
  given in the native chat. This does not invent approval or reuse a consumed
  one-call authorization. Historical SMS tests/receipts remain compatible.
- Natural visibility reports stay bound to their original authenticated turn,
  request, call, pairing and session. They do not end the call; later feedback
  can return to coding without repeating an exact confirmation phrase. Model
  delay cannot move a pre-capture report after capture for verification.

Validation: `npm run check` passes **365 tests in 23 files**, TypeScript and build;
format checking passes. The media suite passes **82 tests**, including synthetic
HTTP/WSS and priority voice Stop. Swift's **13 tests** pass with no native source
change. The built onboarding browser check and scripted simulation demo pass.
Independent review covered authorization, unknown effects, interrupted tool turns,
voice/text Stop, visibility evidence and cursor concurrency. Live read-only checks
found all prior calls ended, all leases released, and the existing explicit
conversation provider/model/key configured; no provider-generation test was run.

Long model turns maintain viewing and service priority Stop ingress with serialized
cursor polling. Call-end observation remains read-only; only durably queued owned
cleanup may dispatch. Voice Stop can bypass serial transcript handling while
listening; agent TTS still suspends listening. A helper grant cannot be reused
before its acknowledgement, and Stop during grant creation prevents readiness.

Historical pre-migration deployment snapshot: **`e08eca1`**, including the
conversational harness in `0672468`. The current line/deployment state is above.

- Backend: `f395c13f-0054-4f05-9950-af69732b1872` — SUCCESS.
- Media: `acf01bae-c9c5-471d-85e7-cbe0c21b355a` — SUCCESS.
- Both public health checks return HTTP 200. Canonical `/agents` serves the new
  natural-language setup protocol. Media reports zero active sessions and a
  connected device gateway; transport preflight and backend heartbeat pass.
- Local companion reports `armed:false`, `available:false`, both macOS permissions
  true, and no active lease. Device readiness is therefore blocked until the Mac
  is available and locally enabled; it was not silently rearmed. No reinstall or
  permission reset was performed.
- Before/after metadata matches: five ended calls, four retained observed input
  receipts, 23 released leases, and the same historical unknown notice/inbound/
  effect states. No new message invitation, phone call or screen input was sent.
- Deployment packaging correction: candidate `f8006440-7db0-42e5-8a60-fb0978898369`
  used the wrong build context and was canceled before replacing the active media
  image. Media must upload the archived **media/** directory; backend uploads
  the archived root. Candidate `c45b1447-cefc-4b38-9a32-29aa66a9f1d7` was superseded
  during rollout to include the natural-speech introduction. The media restart
  window had no active calls; final gateway reconnection was verified.
- Prior rollback images remain identified: backend
  `70698b6a-1994-4d74-8d93-74da1d813a62` (code `4550c12`) and media
  `62fe9a11-63e6-4f42-a705-7b7cf00ef2aa` (code `b93b28b`). Restore code/images only
  if necessary; preserve current ledgers/cursors and never restore an old DB.

This revision has **no new handset acceptance**: the user requested no further
call. Earlier physical results do not establish this revised voice/CUA flow.
Historical unknown outcomes, event cursors and receipts were preserved. Voice is
turn-based; native helper frame protection can hold a fresh video frame briefly
while authorizing input, although ordinary actions no longer blank the stream.

## Historical implementation baseline and source identities

This section records initial installation and release evidence. Later entries and
the current migration summary supersede its deployment and acceptance state.

- Apple Teams audited and inspected baseline: `be47b11fe1317c4747db4121bec37896998b5201`.
  Source main stayed clean at that commit; its five existing worktrees were preserved.
- ClawdTime canonical repository: https://github.com/cherthq/clawdtime, with
  releases integrated into `main`. Implementation was developed on
  `codex/implementation` with its history preserved. The user explicitly authorized
  publishing to this remote and `main`. No public npm package or GitHub topics
  have been published. The README covers the product hook, complete setup and
  everyday user flow, two modes, requirements and remaining acceptance gaps.
- Independent Railway project: `9fafdcf9-c7eb-4465-8387-ec3f8acbaefa`.
- Backend live deployment: `bc0f8032-d316-4b7f-a952-927160d0a38d`, from
  clean commit `f1f1320cc2d64d053871355aa55ea3292cad77ea`.
- Media deployment: `4d18c8d9-1ce4-421a-abd0-5f3bb65daf6e`.
- Source paused using its existing image: `e54088af-d19e-4378-8aa6-d2b4ac12acd4`.
  No source code or sibling deployment was changed.
- Companion: `com.clawdtime.companion`, internal 0.1.0, ad hoc signed.
  Binary SHA-256: `abfdeb7eb0228ac2b4ae9d1f35d1fdd89da3c3ac7b1d6aff226c312aa0e858dd`.
  `codesign --verify --deep --strict` passed. No Developer ID/TeamIdentifier or notarization.
- Client versions: Claude Code **2.1.311**; Codex CLI **0.166.0-alpha.5.1**.
- Validation runtime: Node **24.22.1**, Python **3.14.0**, Swift **6.2.4**.
- Companion installed at `/Users/garygao/Applications/ClawdTime Companion.app`.
  Separate bootstrap configuration has empty display ACLs. The user granted the
  initial build permissions; its relaunch repair changed the ad hoc signature.
  The user authorized replacing only ClawdTime’s stale entries. Current-build
  Screen Recording and Accessibility now report true through the authenticated
  companion doctor; local Enable remains off. The verified browser pairing was applied to display 1;
  both view/control ACLs are now loaded and the display is attached.
- Independent `com.clawdtime.gateway` LaunchAgent connected to the hosted media
  service. Fresh helper/gateway/operator/media/encryption secrets and separate volumes.
- No screen capture, input or FaceTime call has yet been accepted as physical evidence.

## Executed evidence

| Boundary                                  | Evidence                                                        | Meaning                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| TypeScript and build                      | `npm run check` passes; exact final test count recorded below   | Backend, CLI, connectors and integration type-check/build                                             |
| Browser → API → SQLite → export           | Built-app Playwright/Google Chrome checks passed                | Required consent, fragment clearing, same-tab invite, one-use/expired links, export and mobile layout |
| Export → compiled CLI                     | connect → doctor → disconnect passed in disposable project/home | Private credential storage, unrelated config preservation, owned skill removal                        |
| Claude Code → MCP → domain → continuation | Actual CLI print-mode model/tool run passed                     | register/yield/request/result/ack/resume/complete; one simulated call and one simulated result        |
| Codex → MCP → domain → continuation       | Actual CLI exec-mode model/tool run passed                      | Same exact cooperative sequence; native client permission policy preserved                            |
| Domain → device → completion              | HTTP E2E and simulation demo passed                             | click/type/scroll and injected single-action planner; exact response and epoch; one result            |
| Media                                     | 57 Python tests passed                                          | Real migrated code, synthetic/fake transport; not handset delivery                                    |
| Gateway                                   | 18 Python tests passed                                          | Leases, routing, replay, release and failure contracts                                                |
| Setup generator                           | 9 Python tests passed                                           | Private independent config, refusal of overwrite, actual display selection                            |
| Swift                                     | 11 policy/HTTP/receipt/relaunch tests passed; release app built | Permission/control/Stop policy and ad hoc packaging; not actual TCC/physical input                    |
| Backup                                    | Encrypted SQLite snapshot/restore regression passed             | Consistent snapshot, authenticated encryption, fresh destination, unknown receipts retained           |
| Docker                                    | Railway Docker builds and live process health passed            | Independent containers and volumes; backend DB owned by non-root UID 1000                             |
| Actual phone/FaceTime/CUA/line rollback   | **Not run**                                                     | Required live acceptance remains open                                                                 |

Synthetic Python failure tests intentionally log caption/media failure messages.
The suite also emitted an unclosed SQLite test-connection ResourceWarning; all
assertions passed. Neither is represented as physical acceptance.

Real-client probes use the client's existing signed-in default model and a temporary
MCP configuration with fixture-only tool approval. Installed user configuration and
native policies were not changed. No arbitrary open desktop/IDE session was taken over.
Interactive approval/reload behavior is a separate acceptance step.

## Implemented safeguards and review

Shared contracts preceded three parallel specialists with non-overlapping ownership.
A separate specialist reviewed authorization, asynchronous effects and recovery.
Fixes/tests cover exact member/device/project/session isolation, expiring single-use
pairing, durable calls/results, atomic effect claims, native cursor anchors, unknown
outcomes, read-only recovery of retained provider call IDs, native cleanup reservations,
qualified voice, TTS suppression, bounded polling, concurrent CUA exclusion, fresh
frames, no persisted pixels, post-input observation, confirmed release, control epochs,
view restoration, Stop/revocation latches and standby-only cleanup.

A five-second connector heartbeat maintains session liveness. Twenty seconds of
silence stops the session and begins owned-call cleanup; late heartbeats cannot
revive it. Media policy and control independently check freshness. This is cooperative
session control; it cannot forcibly pause unrelated external programs. The agent
must attest conflicting background actors are stopped before yielding.

The optional vision provider supports explicit OpenAI or Gateway selection with
fresh independent keys and a configured model. No model fallback is implicit. The
single-action planner is tested with injected output and frame changes; a real
provider acting on a physical fixture remains unverified.

## Exact remaining acceptance steps

1. **Pairing and native reply reconciliation.** Actual current-build Mac permission
   checks now pass. The verified inbound created an invite after the configuration
   normalization fix. Its outgoing notice has an unknown outcome; the existing
   provider receipt lookup returns HTTP 503, `text operation unavailable`. No retry
   was sent. Browser pairing succeeded and its private file was recovered through the browser
   download API after the in-app download UI stopped. The companion has both ACLs
   loaded; Codex and Claude Code connections were installed in the disposable project.
   Only native receipt recovery and explicit local Enable block live readiness.
2. **Supervised handset loop.** The user confirmed the Liam Davis alias against
   the exact native/logical/inventory binding and selected a sole demo recipient.
   The private handoff record preserves the source cursor and pause evidence.
   Test call, visible screen, voice/text, click/type/scroll, bounded AI action,
   exact agent continuation, Messages result, Stop and rollback are still pending.
3. **AI action physical qualification.** A fresh independent Gateway key has a $1
   non-renewing cap and 7-day expiry. The initially selected model required funded
   credits, so the lead explicitly selected catalog-verified `openai/gpt-4o-mini`.
   Its real structured-output connectivity test passed with existing credits;
   no top-up or model fallback was enabled. Real image/action qualification remains.

4. **Public distribution.** Developer ID, notarization, external clean installation
   and npm namespace/publication remain unverified. Use the bundled internal CLI.

Production operator authentication is resolved: the previous 401 used the demo
key. Current native/logical identity, exact cursor, worker, independent media and
connected gateway preflight checks all pass. Source pause was observed across an
idle interval exceeding 10 seconds, with no pending/unknown jobs, no active calls,
a stable retained cursor and no intervening events. One historical source failed
start-call job remains preserved. No runtime/customer database was copied.

Rollback must reconcile the complete handoff interval. Never advance the source
past unrelated events. Prefer preserving its original cursor and marking only
reconciled test-owned direct messages in its compatible event ledger; alternatively
CAS-advance only when every intervening actionable event is fully reconciled.
See LINE_HANDOFF.md and TRANSPORT.md. No physical rollback has yet been claimed.

## Timing and acceptance

Request-to-ring: **unmeasured**. Answer-to-visible-screen: **unmeasured**.
Human-response-to-real-agent-continuation during a phone call: **unmeasured**.
Sub-minute goals are targets, not results. See DEMO_ACCEPTANCE.md for the physical
matrix. No recordings or private user screens were retained.

## Reproduce locally

`npm ci`, `npm run check`, `npm run demo`, `npm run dev`.
Browser: `npm run test:onboarding:browser`.
Real synthetic CLI probes: `npm run test:connectors:real`.
Python/Swift commands and setup are in README.md and component READMEs.

## Final local release check

- `npm run check`: **111 tests across 14 files**, TypeScript and production build passed.
- `npm run format:check`: passed.
- Built browser/onboarding/compiled-CLI checks: passed.
- Real Claude Code and Codex synthetic probes passed again with heartbeat enabled.
- Python: 57 media + 18 gateway + 9 setup tests passed; Swift: 11 tests and release
  packaging passed. No physical tests are included in those counts.
- `npm run demo`: completed with one simulated call, input, response and Messages result.
- Dependency audit: zero reported vulnerabilities at install; no source secret or
  real configured line number found in tracked/candidate files.
- Independent Railway backend/media Docker builds, volumes and runtime health passed.

## Follow-up diagnosis — November 11, 2026

The live path was never attempted; no failed phone call or screen session was
observed. The implementation remained in simulation without independent hosted
services or installed/authorized ClawdTime companion configuration. The initial
readiness authentication failure was an investigator credential-selection error,
not an unavailable production key. See LINE_HANDOFF.md for corrected evidence.

Landing page `/` and private pairing page `/pair` return HTTP 200 and were checked
in Chrome. `/dashboard` returns 404: no operational dashboard has been implemented.
For this diagnosis the lead started an in-memory simulation at
`http://127.0.0.1:3310`; it has no live credentials and cannot use the test line.
This is a temporary local preview, not a deployed public website.

## Follow-up fixes and hosting — November 11, 2026

Hosted landing: https://backend-production-ee686906.up.railway.app
Private pairing route: `/pair`; no operational dashboard is implemented.
The prior local-only diagnosis above records the earlier state, superseded here.

Readiness now distinguishes pairing, real line/media/device evidence and physical
acceptance. Tests cover missing handoff evidence before polling, stale/config-bound
helper checks, cleanup-only recovery after interrupted call allocation, shutdown
drain, malformed-secret error redaction, and rejection of falsy live config.
Both actual CLI synthetic probes now explicitly verify their exact run identity.

The Mac gateway's missing Python CA bundle was fixed with pinned trusted Certifi
roots and mandatory TLS/hostname checks; no global trust or source gateway changed.
Normal companion reopening now uses only its validated private default config and
never re-arms automatically. Current-build permission reconciliation is complete.

Current handoff pause point: both hosted services and the independent gateway are
healthy. The original verified `pair` inbound initially failed strict invite parsing
because protected tester metadata was spread into the binding. Commit `f1f1320`
assigns the schema-normalized tester list. Recovery used a transaction requiring
exactly that one unknown inbound, no invite/notice/effect, and the exact allowlisted
sender, line, direct conversation and command. It retained the original encrypted
payload and cursor and recorded recovery evidence.

The inbound is now done and an invite exists. The outgoing notice is unknown;
read-only lookup of its stable native origin returns HTTP 503 (`text operation
unavailable`). This does **not** prove the send was absent. No notice was resent,
no cursor was reset and no FaceTime call was placed. `local_recovery` correctly
blocks new live dispatch. The provider must restore a valid read-only journal result
for that original origin before a lead can reconcile it. No sibling source or service
was modified. The private link was opened directly from the verified inbound's
encrypted notice. The user selected view/control and paired successfully. The
private Blob download initially stopped in the in-app browser; its download API
saved the existing file, now owner-only, without a second pairing request. The
claim was applied preserving secrets/ledgers. Relaunch retained both actual Mac
permissions and loaded display 1 view/control ACLs. Both connector installations
succeeded in the disposable project; doctor reports only `local_recovery` and
`local_arm` failures. No agent client, capture, input or call was started.

The user's later handset correction supersedes the initial tester choice; only the
corrected recipient is allowlisted. Apple Teams remains paused. Its retained cursor
and all ClawdTime unknown outcomes must be reconciled before any ownership reversal.

Implementation fixes are committed as `4f6e540`. Separate concurrent landing/pricing
changes in the working tree were preserved and excluded from that commit and the
audited hosted backend image. Disposable acceptance fixture is available locally
at `http://127.0.0.1:3315`; it is not a screenshot or input acceptance result.

## Notice audit follow-up

Local follow-up retains sanitized native acknowledgement receipts and the stable
operation origin for pairing notices. Failures retain phase/code and HTTP status
without raw provider errors or content. Interrupted notices remain unknown; no
automatic retry was added. Seven runtime cases and the full 111-test check pass.
The pre-existing live unknown remains unresolved; local receipt improvements do
not establish its outcome. Hosted release identity above remains authoritative.

## Provider receipt diagnosis — November 11, 2026

The user ran a scoped read-only administrator diagnostic on the exact provider
account. Its `.chert-rpc` directory exists, is canonical, and has the required
owner and mode 0700. The helper readiness marker names a live process and bridge
version 1. **`text-operations.sqlite` and its WAL/SHM files do not exist.**
This establishes the immediate receipt-lookup failure: Chert's read-only opener
requires an existing secure journal, returns nil when it is absent, and the HTTP
route maps that to 503 (`text operation unavailable`). General provider health
does not verify this journal. This is distinct from an existing journal with no
matching receipt, which would return 404.

The helper log contains a `send-text-once` invocation, but the original response
was not retained by the initial ClawdTime notice implementation. The send code
checks request/account/chat identity before opening the journal. An early refusal
is consistent with these observations; the exact failed send predicate is not
proven. Do not infer safe resend from a currently absent journal, create an empty
journal to erase uncertainty, or report an acknowledged/delivered message.

The diagnostic changed no provider service, journal, permission or routing.
ClawdTime remains paired, with its Mac locally stopped and no call placed.

## Same-session setup implementation — November 11, 2026

The revised onboarding sends the setup prompt itself by Messages. The prompt links
`/agents` and a private `/setup` link. The CLI claims and stores the binding
internally, configures the existing project, and reports native permission/local
Enable steps. The foreground JSONL setup bridge keeps the current coding chat's
identity and heartbeat; native question UI handles waiting. No client restart or
replacement coding agent is required. Host process/session failure remains a real
limit; unknown registration/effects are preserved, never automatically replayed.

The setup invitation requires fresh readiness and an authenticated SMS YES before
one call. Verification requires qualified live connection evidence, a fresh frame,
explicit positive screen confirmation, same-session acknowledgement/continuation,
and an acknowledged Messages result. Simulation cannot mark setup verified.
Public signed/notarized downloads and automatic new-device gateway enrollment are
still unavailable; the existing approved pilot companion is supported without
replacement or TCC reset. Legacy `/pair` and Railway origins remain compatible.

Independent review found and fixed explicit pilot-build trust, local readiness
failures being recorded as unknown effects, missing owned-skill refresh, exact
loaded ACL checks, capture-after-Stop races, and recovery audit preconditions.
The approved landing-page work from the parallel website chat is included in the
coordinated release; canonical setup origin is `https://www.clawdtime.com`.

The latest exact-target Chert diagnostic returned `reply_map_thread` refusal.
This is a stale per-chat reply-thread reference rejected before the strict send
opens its journal. The provider's RPC client consumes/deletes the original reply,
and its strict HTTP adapter drops non-acknowledged dispositions; the historical
message outcome therefore remains unknown. The existing dedicated-worker
maintenance action can clear only the exact stale map entry when no Messages
window is visible. It never sends, touches drafts, or changes the journal.

A lead-only obsolete-notice retirement is implemented for this exact historical
case. It proves the original legacy pairing-only payload, token hash, consumed
and expired invite, unique resulting pairing/binding/timestamp, original inbound,
and absence of other in-flight work. An insert-only audit hashes those records.
It preserves the original `unknown` notice byte-for-byte and never resends it.
Only that exact spent-link notice can stop blocking new work. Every other unknown
notice/effect/call/control uncertainty continues blocking; readiness reports the
retained unknown and retired count separately. A late old text is still possible,
but its link cannot grant authority. Retirement is not delivery reconciliation.

Live maintenance, retirement, deployment and physical acceptance outcomes are
recorded below as they occur; this implementation section alone proves none of them.

Current release validation: **152 tests across 16 TypeScript test files**, typecheck,
production build and formatting passed. Revised built-browser overview/protocol
checks and legacy browser/compiled-CLI regression passed. **21 Mac Python tests**
passed. Current-chat CLI setup reused the actual pilot pairing, refreshed its owned
skill, preserved the installed companion and confirmed both actual macOS grants.
The user executed the exact-target provider maintenance; before was
`reply_map_thread/accepted:false`, repair and independent after inspection were
`accepted:true`. No message was sent and provider journals were untouched.

## First supervised call and capture investigation

Release `848102c` deployed as backend
`0d4075e0-160a-43b6-a0a8-35c8f12d9a83`. Canonical www HTTPS and all public setup
routes return 200; legacy Railway origins remain accepted. GoDaddy HTTP apex
forwarding is verified; apex HTTPS/deep-link forwarding is not qualified, so use
www directly. The old notice was retired through its exact immutable evidence
checks; its delivery stays unknown and no resend occurred. The new setup invitation
has an acknowledged Chert receipt and read-only receipt lookup returned HTTP 200.
The user's authenticated SMS YES approved exactly one test from the current Codex
chat, with its stable run identity and a yielded coding session.

The actual FaceTime call reached the intended handset. The user saw ClawdTime's
connecting/status video and heard speech, but did not see the Mac screen. No fresh
Mac frame was recorded by backend setup verification, and no input actions ran.
The lead canceled the test, observed native call ended/media closed, view lease
released and all three current effects done. No redial occurred. The native coding
chat stayed active for diagnosis; the first bridge was closed after cleanup because
the original protocol lacked an unsuccessful-request cleanup acknowledgement.

Follow-up implements explicit terminal-ack so future failed tests can release the
same connector session after confirmed cleanup without inventing human approval,
completion or another call. Read-only diagnostics are scoped to the exact request.
Media retains only bounded phases, timestamps, counts and error categories, never
screen pixels or audio. A deterministic test exposed policy refresh canceling the
pending screen-stop notification; tracked, shielded cleanup now delivers it once.
This is a confirmed cleanup bug, not proof of the original capture failure.
Real HTTP and TLS/WebSocket synthetic-frame tests pass, including refusal and cold
capture timeout. A separately approved further diagnostic call is still required.

Follow-up release `b93b28b` deployed successfully as backend
`41bf01a8-34cb-4aae-a5d3-4fb833fb4aec` and media
`62fe9a11-63e6-4f42-a705-7b7cf00ef2aa`. The independent gateway was restarted
after confirmed call cleanup to load sanitized diagnostics; the installed Mac
companion was preserved. Existing-project setup checks confirm both macOS grants,
local enablement, no active helper lease, matching installed skill and live
transport readiness. Validation passed 171 TypeScript tests, typecheck, build and
formatting, plus 66 media and 19 gateway Python tests. These checks do not establish
screen delivery.

The user approved one additional diagnostic call in this same native chat. The
new attempt's invitation failed before any call: its retained provider receipt
returns HTTP 200, `found:true`, `state:attempted`; exact native GUID evidence and
message lookup both return 404. The user reports no invitation received. The
effect remains unknown, was not resent, and the second call has not been placed.
The foreground connector remains active while diagnosis continues. This is
distinct from the earlier missing-journal 503 and stale pre-journal target refusal.
Chert reserves the receipt before constructing/sending the message, and retains
no stage information distinguishing construction failure from post-send GUID or
acknowledgement failure. A 404 does not prove no send. Existing read-only target
inspection cannot recover that historical distinction; another administrator
password check would not resolve it. Narrow upstream diagnostic/repair scope is
requested because project instructions prohibit sibling source modification.

Independent Mac review reproduced a timestamp precision bug: default Swift ISO
formatting removed fractional seconds from capture-start time, potentially adding
almost one second of apparent age and rejecting a genuinely fresh frame at the
gateway's two-second limit. Source now preserves fractional capture-start time,
conservatively floored to milliseconds. The age limit remains unchanged. All 13
Swift tests and the release build pass, including precision/boundary regressions.
The installed companion has not been replaced; macOS grants remain intact. This
reproduction identifies a real defect but does not prove it caused the first call's
missing screen. Slow first capture remains another unproven possibility.

The user explicitly extended scope to repair Chert's strict text path for the
approved test line. Subsequent deployment inspection found that a separate task
installed Chert `f1f186ed` on that account at 19:01 UTC, between our two attempts.
Its reservation-before-target change means `attempted` also covers initial target
refusal. The running executable path matches that candidate. A fresh read-only
inspection at 14:25 Eastern returned `reply_map_thread/accepted:false` again.
That stage alone does not distinguish ordinary account-qualified DM routing from
a real reply thread. Independent source tests reproduced rejection of an exact
ordinary account/peer mapping. Candidate `742b4068` in isolated
`/Users/garygao/chert-clawdtime-text-path` fixes only strict text acceptance while
preserving all bridge checks and non-text behavior. Tests failed before and pass
after; independent review, signed paired build and isolated target contracts pass.
Guarded account-only installation is being prepared; no new message/call occurred.
The failed invitation expired without approval or a call, and its unknown effect
remains unchanged. The original foreground bridge is still heartbeating in this
same native coding chat.

## Scoped text repair and same-chat recovery follow-up

Chert candidate `742b4068` was installed by the owner using the guarded account-only
installer. Its exact-target inspection now accepts the ordinary DM route; receipt
health and identity checks pass. The installer reported unchanged journals and
other-account job PIDs, with the previous paired artifacts retained for rollback.
The stopped ingress job required one recorded kickstart. Its command exceeded the
script's twelve-second wait, but subsequent independent read-only inspection found
the tunnel process running and public status/identity endpoints returning healthy
HTTP 200 responses. No second kickstart, message or call was used for this check.
The old attempted invitation remains unknown and must never be replayed.

A narrowly audited retirement can now exclude that exact expired, never-approved
legacy invitation from readiness while preserving its original effect, receipt and
cursor. Recovery creates a distinct invitation in the same active backend session
only after explicit new-invitation authorization, current readiness and immutable
identity checks. Each new invitation requires its own authenticated `YES <code>`;
a delayed old YES cannot authorize it. The one-shot helper preserves the original
foreground bridge and its heartbeat. Tests include running the frozen prior bridge
against the recovery API, lost-response reconciliation and unknown-outcome refusal.

The fractional capture timestamp fix `f57798c` is installed in the existing
companion path with a stable signing identity and a retained rollback bundle.
Sharing was stopped before replacement and stays stopped. The signature transition
requires fresh macOS grants, which the owner has been asked to provide. This is an
internal signed pilot build, not notarized public distribution. No second physical
call or screen/control/continuation/result acceptance has occurred.

Recovery release `5e54a68` passed 219 TypeScript tests, typecheck and build and
was deployed successfully as backend `894ad81e-3c4f-40d1-b935-023b02776e7a`.
Both actual Mac permissions now pass after replacing only ClawdTime's stale
entries, and the owner enabled the app locally. During deployment the old backend
session stopped after a heartbeat gap; it was not resurrected. The native coding
chat remained active. After exact audited invitation retirement and confirmed
idle cleanup, the obsolete bridge closed and a new foreground transport session
registered in that same chat, preserving all prior checkpoints and unknown receipts.
This is native-chat continuity, not preservation of the expired backend session.
The user's explicitly authorized fresh invitation has a provider-acknowledged
receipt; a new exact-code reply is still required before the approved second call.

The second physical call attempt was acknowledged by the provider and rang, but
ended automatically as the user answered. Diagnostics recorded zero Mac frames,
no input actions and no view lease. The exact cause is reproducible: setup expiry
remained ten minutes from invitation creation after authenticated approval and call
start. Approval arrived near that boundary, so the setup timer canceled a new call
that still had almost its entire five-minute request deadline remaining. Native
call ended and media closed; terminal acknowledgement returned the same transport
session to active without fabricating a human answer. No further call is authorized
automatically. A stage-specific timer fix preserves the initial approval window,
starts a bounded ten-minute ready window at the first authenticated YES, and uses
the call request's five-minute deadline once started. Duplicate YES/start requests
must not extend timers; expired tests and prior receipts remain unchanged.

Release `5880c38` (223 TypeScript tests, typecheck/build, independent review) was
successfully deployed as backend `1e762fb9-2b5a-4927-ab53-ecd2426faffd`. With new
explicit call authorization and an authenticated coded reply, the next physical
call showed the disposable fixture on the intended handset. Media recorded 302
fresh frames and emitted screen video; the first screen video was approximately
27.7 seconds after the attention request, after the spoken introduction. The user
confirmed the screen in this chat and through authenticated Messages feedback.
All view/control leases were released, the exact backend session acknowledged the
response and resumed at its current control epoch, and this native coding chat
wrote a real continuation artifact. A factual completion recap was acknowledged
by the provider and the user confirmed receiving it on the handset. Setup's basic
screen/feedback/continuation/result verifier passed. The call ended and media closed.

CUA acceptance did not pass. The first AI focus request acquired/released control
without an action receipt. A later direct typing request has an observed receipt
and post-action frame, but the user confirmed the text landed in the Codex reply
textbox. Do not describe this as correct targeting or completed control acceptance.
A static synthetic-image reproduction against the configured AI provider returns
HTTP 400 because Zod's discriminated union emits unsupported `oneOf` in the
structured-output schema. The actual historical exception was discarded, so its
specific provider error was not retained. This is a concrete failure of the same
configured planning path. The corrected provider schema must retain strict local
action validation; failed planning must explicitly report no input and prevent
follow-on typing from silently using old focus. No click/scroll/AI-action physical
pass, spoken-feedback pass, or full Claude Code physical loop is claimed.

The CUA repair passed independent review and 247 TypeScript tests, typecheck and
build. Provider output now uses supported `anyOf` with unchanged strict local
validation and exact fresh-frame comparison. A live synthetic-image probe returned
one bounded click in about 1.8 seconds; it executed no computer input. Missing or
throwing SDK output becomes a sanitized pre-input failure. Proven pre-input failures
produce an explanatory Messages notice, preserve deterministic command IDs and
restore prior viewing only after confirmed releases in the same active context.
Failed planning blocks typing until a separate explicit click has an observed
receipt. Stop races, uncertain releases and submitted/unobserved input prevent
restoration or reacquisition. Historical unknown records remain unchanged.
This repair is not physical CUA acceptance. Subsequent tests must leave the Mac
fixture foregrounded and use handset feedback to avoid desktop-chat focus changes.

CUA repair release `8cd5621` deployed successfully as backend
`16b9297b-3f31-449f-8553-32e3512a0c46`. The preceding verified transport
bridge was closed before deployment; no live call or lease remained. The Mac app
and media service were unchanged. Further physical calls require fresh approval;
no additional control pass is implied by this deployment.

A further explicitly authorized call on `8cd5621` again showed the fixture. The
user reported repeated `screen_changed` refusals; no action receipts were created.
The refusal notices and view restoration worked. Authenticated screen confirmation
returned to the exact native chat, leases released, control resumed at epoch 4,
an actual continuation artifact was updated and a factual recap was queued. The
basic setup verifier passed again; native call ended, media closed and 237 frames
were received. This is not successful computer control.

The exact changed pixels were not retained. Cursor/caret/clock changes and control
indicator compositing are hypotheses, not established causes. Static synthetic
JPEG re-encoding is deterministic. The next bounded diagnostic change requires
two distinct identical captures before planning, waits at most twice for capture
settling, and still requires exact image equality after planning. Remaining lease
time bounds waits and inference; existing two-second input freshness is unchanged.
Failure telemetry contains only whitelisted timing, pixel counts and a coarse
4-by-3 tile map; screenshots, image hashes, text, prompts and raw provider errors
are not retained. Diagnostics never authorize input, including when pixels match
but encoding differs. Independent review and 278 TypeScript tests, typecheck/build
pass. Live qualification remains pending; no new call is implicit.

Bounded-settling/diagnostic release `bcd4b23` deployed successfully as backend
`3d8423d9-3f4f-4f62-8ffd-78570564107d`. No helper/media update or permission
change was made. Read-only prior control metadata contains two `planning_refused`
and two `screen_changed` results, all `not_started`, with zero action receipts.
No model clarification or changed-pixel evidence was retained for those attempts.

Readiness after the settling deployment exposed an unknown `end_call` effect for
the completed retest. The recap was independently acknowledged under its original
native operation ID; it was not the unknown effect. Exact Calls GET events confirmed
worker `cleanup_complete`, and media diagnostics confirmed closed/alive false.
The existing poller had closed local media without reconciling the unknown hangup
acknowledgement, then skipped closed sessions forever.

A reviewed repair reconciles only the independently proven cleanup goal using
GET-only exact call/media evidence. It atomically preserves the original unknown
effect and binding/evidence audit, then records cleanup confirmed while explicitly
retaining `nativeEndAcknowledgementUnknown`. It never resends hangup or rewrites
unrelated unknown outcomes. Negative, concurrent-change, idempotency and rollback
tests pass. The exact-session diagnostics endpoint now exposes the last sanitized
pre-input failure. A separately requested observed/released bounded AI click can
clear the typing latch; uncertain clicks and AI typing cannot. Integrated validation:
308 tests, typecheck/build, independent review. No new physical test is claimed.

Release `4550c12` deployed successfully as backend
`70698b6a-1994-4d74-8d93-74da1d813a62`. The old end-call effect reconciled
through the reviewed GET-only path: cleanup confirmed, original unknown body
retained in its audit, and `nativeEndAcknowledgementUnknown:true`. Readiness now
passes. A fresh read-only ownership audit confirms Apple Teams disabled, no active
source calls or pending/unknown source jobs, provider idle and the original source
cursor retained. No additional call has been placed under this release.

## User-requested wrap-up — November 11

The final authorized diagnostic call on `4550c12` again delivered a live screen,
authenticated Messages feedback and continuation in the same native Codex chat.
Three input receipts reached observed state, but correct fixture targeting remains
unverified. The user initially reported direct actions appeared to work; subsequent
local calibration established that the user was using the in-app browser fixture
while the operator inspected a separate Chrome copy. Coordinates grounded to that
Chrome layout therefore cannot establish correct targeting in the in-app pane.
No direct-control physical pass is inferred from confirmation texts or receipts.

The bounded AI action refused before inference during screen settling: 2,374 decoded
pixels changed across five coarse regions in a 1,108-by-720 frame over 4,641ms.
This rules out encoding-only variation for that comparison. The changing coding
chat beside the in-app fixture is a possible contributor, not a proven sole cause.
The authenticated response was acknowledged, all leases released, the exact session
resumed at epoch 4, and a real continuation artifact was updated. A factual recap
was queued. The test's basic verifier was called after its deadline and returned
expired; it was not reopened. Earlier verified basic-loop acceptance remains valid.

The user requested no further tests and asked to wrap up. No additional call is
authorized or scheduled. The last native call is ended, media closed, sharing
stopped and the foreground transport bridge closed. The installed companion and
backend remain available for explicitly authorized future use. The separately
hosted pilot is runnable. Full CUA, spoken-feedback and Claude Code physical-loop
acceptance remain unverified; no full demo-readiness claim is made. Current code
validation remains 308 passing TypeScript tests plus typecheck/build/format and
independent review.
