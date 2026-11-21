# Background controller qualification — 2026-11-21

Status: qualification stopped at the user’s request. Implementation is being published for review; it is not ready for a real phone acceptance call. Unit tests are not physical FaceTime acceptance.

At this checkpoint, local Stop is confirmed, the helper is disabled, the driver daemon is shut down, and there is no active control session or unresolved shared control ownership. Historical uncertain action records remain preserved. The original phone task runtime is offline; the staged background runtime has not been selected. No further UI qualification or cutover was performed.

## Pinned implementation

Cua Driver and JavaScript SDK are pinned to 0.55.0 (MIT). Official source release: `8f484f30586eef722bede7a5ce315de1148cca96`. Universal macOS archive SHA-256: `faf11948f8f9b410a76750e65ae14cb1d95cc321aa61fc158f70de8a68c270b1`.

Installed driver is Apple-notarized with Developer ID team `YCK386LBJ7`, bundle `com.trycua.driver`. The supported daemon owns its own Accessibility and Screen Recording grants. Both were observed true in the daemon. No embedded runtime or foreground input fallback is used. SDK clients connect only to an explicit private Unix socket. The immutable private capability manifest and user policy limit apps and background operations; desktop capture, scripts, shell, foreground retries, submissions and sends are unavailable.

References: [official driver documentation](https://cua.ai/docs/cua-driver), [SDK guide](https://cua.ai/docs/cua-driver/guides/use-the-sdk), [permissions](https://cua.ai/docs/cua-driver/guides/permissions).

## Physical capability matrix

| Capability | Evidence | Status |
| --- | --- | --- |
| TextEdit disposable editing, v1.20 | Explicit background typing; independent AX text and exact-window screenshot matched synthetic text | Verified on same desktop |
| Covered-window capture | Exact authorized TextEdit window remained capturable behind foreground app | Verified |
| Messages, v14.0 | Designated conversation navigation qualified; integrated already-selected read independently verified with 11 valid preview frames; no send | Verified read on same desktop |
| Codex, bundle com.openai.codex, v26.1027.61615 | Native File → New Chat action; exact harmless draft observed in unsent composer and intended destination | Manual draft verified; assembled workflow pending |
| Codex sidebar New chat | Native element and pixel attempts did not visibly change state | Unsupported route; no retry/fallback in workflow |
| Foreground non-interference | Pre/post foreground app, pointer and clipboard change count unchanged; user separately confirmed normal typing and pointer behavior | Verified for tested draft |
| Agent cursor mapping | Driver session cursor position matched original editor center in screen points and Retina screenshot transform | Verified local mapping |
| Other Spaces | Target binding/input failed or could not establish reliable current state | Blocked by first-release contract |
| Minimized window | Driver refused window-pointer/keyboard route as minimized/hidden | Blocked |
| Window recreation | Synthetic identity and stale-frame checks; physical recreation still pending | Not fully qualified |
| Exact-window capture performance | Seven frames in 2.545 seconds, 1280×828, approximately 2.75 delivered fps | Measured fixture, phone tuning pending |
| Phone overlay inclusion | Driver exact-window frames omit overlay inclusion metadata | Unknown; synthetic cursor suppressed pending qualification |
| Driver restart | Controlled graceful shutdown; new daemon cursor state had no previous position | Cursor retirement observed; integrated failure test pending |
| Email | Selected signed-in Gmail account identified in Chrome; inbox and account identity readable through this coding chat’s browser tool only | Phone adapter remains unqualified |
| Real FaceTime audio/video | Existing transport preserved; new controller not physically tested over a call | Pending |

No message was sent and no Codex prompt was submitted. Private contacts, accounts, screenshots, conversation content and credentials are not included here.

## Authority and recovery

The background runtime is selected by a separate owner-only `background-cua.json`, retaining the old native configuration for rollback. Every task requires admitted call/tool identities. A durable owner file and an updated helper controller fence are created before any driver session. The helper's backward-compatible unknown sentinel prevents an older helper from accepting competing work after rollback. Stop, expiry, hangup and crash never clear an unknown outcome. Driver session labels are not generation barriers; no automatic daemon restart or stale-lock reclamation is permitted.

Only exact qualified Messages navigation and Codex draft controls receive short-lived positive grants. Model output chooses a bounded intent and corroborates visible evidence; it cannot name arbitrary tools, app paths, scripts, coordinates, recipients or send actions. Every effect receives an encrypted receipt before dispatch and requires independent post-action verification. Screenshot corroboration is followed by a fresh unchanged original frame and new native token before dispatch.

Video is transient exact-window capture. The original observation remains the input coordinate space. Presentation uses modest 1.6× zoom and 400 ms transitions, expires stale frames, and checks call/task/driver/process/window/geometry identity. Spoken overview changes presentation only. A stopped or invalid view returns the mascot rather than a stale image or desktop fallback.

## Installation and update handling

A private versioned local artifact, including pinned driver SDK and separate phone agent code, is staged. The previous code and protected state are preserved; no database rollback is allowed. A private update hold prevents the scheduled updater from replacing this local integration while review/acceptance is pending. The updated ad-hoc helper was launched while the original runtime and helper were idle; its own fresh status reported both permissions available, and local Enable remains a separate human action. Its protected application allowlist now includes the two qualified app IDs. Rollback must restore the prior allowlist as well as code/backend selection, while retaining all receipt databases.

Readiness still requires assembled workflow review and physical tests, cursor overlay qualification, local Stop/disconnect/restart checks, a final artifact digest inventory, idle cutover, and fresh correct-line listener/voice-agent health.

## Integration findings

The initial helper allowlist correctly blocked launch before any input; its exact app scope was corrected. The Messages adapter now recognizes an already selected conversation from exact toolbar identity plus independent screenshot verification, so a sidebar row scrolled offscreen does not require a redundant click. The local integrated read passed.

Codex exposed a concrete API omission: native menu expansion requires `full_output:true`. The corrected observer uses bounded 10,000 elements, depth 40 and a 2-second walk budget, retaining the 5-second freshness bound and rejection of truncated/degraded observations. A real read-only inspection produced the exact native New Chat menu action with a nontruncated tree. The initial launch-only uncertain result was reconciled from independent signed app/window observation and exact inactive-session cleanup; its original encrypted uncertain record was retained with a separate reconciliation record, and the shared fence was explicitly resolved. No Codex click or typing occurred in that failed integrated attempt.

The helper initially disarmed without an intentional user Stop. Added lastStopReason/lastStopAt diagnostics later identified a display notification; the diagnosed fix and its limits are recorded below.

Final publishing validation: `npm run check` passed 2,321 tests in 119 files, typecheck, and build. The unchanged standalone line and Swift components previously passed 56 and 203 tests respectively. These checks do not replace the remaining physical acceptance gates.

The later integrated Codex navigation attempt returned from native New Chat, then failed the independent empty-draft check before any typing. Its original encrypted receipt remains uncertain. Exact driver session cleanup was independently confirmed. Current UI observation cannot distinguish a no-op from subsequent human navigation, so no success or not-dispatched claim is made. A separate operator-only retirement protocol preserves this unknown navigation, prohibits replay, and keeps older helpers blocked. New reservations retain a content-free action class; production recovery rejects unclassified, text, pixel, or mixed action histories. The historical isolated qualification store is not retroactively reclassified or admitted again.

Native `invoke_menu` is not an alternate background route in pinned macOS 0.55.0: although its schema accepts delivery mode, the implementation chooses delivery from app foreground state. The integration retains explicit background AXPress and independent UI postconditions.

The one-off historical Codex navigation controller was retired through the separately reviewed helper endpoint after matching its driver process lifetime, confirming the exact session inactive, and confirming the original supervisor dead. The helper reports zero unresolved control ownership. The original isolated task store and owner record remain unchanged and permanently blocked; no legacy action was backfilled with a new classification. Updated helper installation resets local Enable by design. The user enabled it for subsequent qualification; it is now explicitly stopped.

A staged artifact contains an earlier checked build, pinned SDK, updated helper and phone agent. It does not include all final verifier and cleanup fixes published in this review; a fresh build and digest inventory are required before installation acceptance. Its packaged Node and SDK passed the daemon inventory probe with both permissions confirmed. Backend selection has not been changed; the original runtime remains stopped during exclusive qualification. The updater hold remains in place. Required remaining gates are integrated Codex draft success, recreated-window and overlay capture qualification, installed cancellation/restart checks, and correct-line warm-listener validation before cutover.

Subsequent diagnostics captured the automatic disarm reason as `screen_parameters_changed`. The updated helper compares two complete content-free display signatures: identical configuration notifications preserve Enable; changed or unavailable metadata retains full Stop. The comparison covers active/online identity, main display, physical bounds, mode, scaling, pixels, refresh, rotation and mirroring. Dock/menu-bar work-area insets are excluded because they do not change the display coordinate space; exact window geometry is independently rechecked. A safe counter records ignored stable notifications. The installed revision remained enabled through subsequent tests until explicit local Stop. A controlled physical duplicate-notification acceptance test remains pending. No auto-rearm was added.

Codex New Chat now allows at most four fresh read-only observations within three seconds for the empty composer to appear. This is observation settling, never an input retry; wrong/ambiguous/stale targets and Stop still halt the workflow. Native return preceding renderer navigation is a plausible timing explanation, not a proven cause of the earlier attempt.

A separately bounded Cua Chrome observation was refused as outside the capability manifest for the requested application process; no email input occurred and no desktop capture fallback was used. The coding-chat browser can identify the selected account, but that does not qualify phone email access.

The updated helper accepted local Enable and remained armed during the next artifact test. That test found Codex on a different Space and dispatched no click or typing. The launch-only receipt was reconciled with an independent live code-signature/version/window-owner witness plus exact inactive session; its original isolated encrypted record remains retained without replay. Running-app verification is now separate from current-Space input eligibility: unavailable or ambiguous work windows produce a blocked task after verified launch. Independent review and six worker regressions confirm that launch verification creates no target, preview or action grant. The user subsequently arranged the same desktop. Further artifact attempts stopped before clicking when screenshot corroboration failed; integrated Codex drafting has not passed.


## Final stopped checkpoint

The final read-only Codex screenshot verifier returned corroborated after correcting the provider’s strict response schema: the closed diagnostic reason field is required and nullable, and navigation verification does not require a destination that is only meaningful after opening the draft. This proves the read-only verifier worked for that observation; no subsequent assembled draft test was run. Diagnostics retain fixed phases and reason codes rather than model output or private screen contents.

An aborted read-only preview previously caused a false cleanup uncertainty. The adapter now distinguishes read-only observation from mutation, while still requiring exact inactive-session evidence and successful SDK shutdown. Failed mutation or cleanup remains uncertain. The isolated historical attempt was reconciled separately; original receipts were preserved.

Remaining acceptance gates: integrated unsent Codex drafting; separate email adapter qualification; physical window recreation; cursor-overlay inclusion and phone presentation; installed cancellation and restart checks; real phone audio/video; final artifact inventory and idle cutover with correct-line listener health. The private updater hold remains in place to preserve this stopped checkpoint.
