# ClawdTime companion helper

This is a separate, opt-in macOS menu-bar application above Chert. It does not
install or alter a Chert worker. Source builds and policy tests pass locally;
no real capture, input, permission prompt or device installation is implied.

The helper uses ScreenCaptureKit snapshots to return JPEG frames only when an
authorized gateway requests one. Screens are never written to disk. Local
permissions choose explicit display IDs and independent viewer/controller member
IDs. Launch starts **locally stopped**. The menu's Enable action permits new
requests; the menu and a floating Stop panel identify active viewing/control.
Local Stop, session switch, sleep and observed screen lock disarm the helper;
unlock/wake never resumes it. Remote lease expiry stops the current request.

A local **Device Setup** window opens at launch when a required macOS permission
is missing. It shows live permission status and the exact configured display IDs,
with separate Grant Screen Recording, Grant Accessibility, Enable locally and
Stop buttons. The compact 22-point menu-bar display icon opens **Device setup…**;
reopening the app also brings the window forward. Its tooltip and accessibility
label identify the current state. Setup never grants permissions or enables
sharing automatically. This is local device setup, not a workspace dashboard.

## Build and package

Requires macOS 14+, Xcode command-line tools and Swift 6. Run from `mac/`:

```sh
swift test
./scripts/package.sh
```

The package script builds `build/ClawdTime Companion.app` and signs it ad hoc by
default. Set `CLAWDTIME_SIGNING_IDENTITY` to an installed Developer ID identity
for distribution signing; notarization is a separate release step. Neither build
nor packaging launches or installs the app. Preserve a stable signed bundle path
when granting macOS privacy permissions. Changing signatures may require grants
again. The app is not sandboxed; TCC Screen Recording and Accessibility still
apply independently.

## Local configuration and launch

Do not include real secrets or member IDs in committed files. Create a private,
owner-owned regular JSON file with mode `0600` (parent directory `0700`):

```json
{
  "deviceId": "registered-device-id",
  "bind": "127.0.0.1",
  "port": 4213,
  "secret": "REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS",
  "displays": [
    { "displayId": 123456, "viewers": ["member-id"], "controllers": [] }
  ]
}
```

There is **no default display**. An empty `displays` array allows authenticated
metadata discovery but no capture or input. Use the actual display ID returned by
`GET /v1/displays` (metadata only), then explicitly choose
that display and restart with its ACL. A controller must also be a viewer.
Configuration is loaded only on launch; revoke immediately with local Stop, then
change configuration and restart. The secret is scoped to this helper and shared
only with the trusted gateway. It is not a customer-facing token.

```sh
chmod 600 /absolute/private/device.local.json
"build/ClawdTime Companion.app/Contents/MacOS/ClawdTimeCompanion" --config /absolute/private/device.local.json --check-config
open "build/ClawdTime Companion.app" --args --config /absolute/private/device.local.json
```

`--check-config` validates without starting a listener or prompting for permissions.
Launching is an installation/qualification action, not part of the build command.
Choose **Grant Screen Recording** locally for view; **Grant Accessibility** is
separate and only needed for control. macOS may require relaunch after a grant.
The helper never requests either grant because of a network request.

Only literal `127.0.0.1` or an explicit Tailscale IPv4 in `100.64.0.0/10` may bind.
There is no wildcard, LAN, hostname or public binding. HTTP relies on loopback or
Tailscale's encrypted transport: do not expose it through a public proxy. The
cloud/media service needs a trusted private gateway with actual tailnet reachability;
a public Railway container alone does not provide that route. Tailnet ACLs should
restrict access to that gateway. Binding an address does not install Tailscale.

## HTTP contract

Every route requires `Authorization: Bearer <secret>`. No CORS or browser UI is
provided. Requests are one HTTP/1.1 request per connection, JSON body at most
16 KiB (64 KiB for bounded `/v1/panel` metadata only). Transfer encoding, duplicate headers and pipelining are rejected.
Responses use `Cache-Control: no-store`; errors are JSON `{"error":"…"}`.

| Route                                    | Behavior                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /v1/status`                         | Device ID, boolean armed/available/permission flags, optional activeLeaseId.                                     |
| `GET /v1/permissions`                    | Loaded display viewer/controller ACL metadata; authenticated, no capture or prompt.                              |
| `GET /v1/displays`                       | `[{id,width,height}]`; metadata only, no capture permission prompt.                                              |
| `POST /v1/leases`                        | Full lease body below; one selected screen. Identical active request is idempotent.                              |
| `POST /v1/leases/{id}/renew`             | Same complete binding; only expiration can change. No upgrades, display switches or resurrecting stopped leases. |
| `DELETE /v1/leases/{id}`                 | Stop the selected lease. A later request needs a new ID.                                                         |
| `GET /v1/leases/{id}/frame`              | JPEG bytes, max 2 MiB and 1280×720 bounds, max five requests/second.                                             |
| `POST /v1/leases/{id}/actions`           | Bounded action body below; durable receipt.                                                                      |
| `GET /v1/leases/{id}/actions/{actionId}` | Receipt lookup works after lease expiry; never repeats input.                                                    |

Lease body: `{id,deviceId,memberId,callId,displayId,mode,expiresAt}`. IDs contain
letters, digits, underscores or hyphens, maximum 160 characters. `mode` is `view`
or `control`; `expiresAt` is ISO 8601, in the future and at most **30 seconds**
from the helper clock. Renew before expiry. Stop the old lease before switching
mode/display. Local Stop requires a new local Enable; remote requests cannot undo
it. Fresh helper starts retain receipts but start with no active lease.

JPEG response headers: `X-Frame-Id`, `X-Captured-At` (capture request start as
fractional-second ISO 8601, conservatively floored to milliseconds),
`X-Frame-Width`, `X-Frame-Height`. A frame completing more than two seconds after
capture began is rejected. Capture checks lease/generation both before and after
awaiting macOS. The gateway must immediately clear displayed frames on any
capture/authorization error, expiry, disconnect or selection change. Never freeze
an old private frame as a fallback. Metadata/capture is independent of Chert's
call and video qualification.

Actions use a flat JSON object:

- Click: `{id,frameId,type:"click",x,y}`; x/y normalized to [0,1].
- Scroll: `{id,frameId,type:"scroll",x,y,deltaY}`; point required, deltaY integer
  between -500 and 500, excluding zero.
- Type: `{id,frameId,type:"type",text}`; up to 512 printable UTF-16 units, no
  newlines/control characters. The accessible focused element must be wholly
  inside the selected display; secure-input mode refuses input.

Input requires a control lease, viewer + controller ACLs, Accessibility, an active
unlocked console session and the latest frame captured within two seconds. Every
submitted action invalidates that frame: acquire another before the next action.
No shell, clipboard, arbitrary keycodes or touching the FaceTime picture is wired.

Receipts contain `{id,leaseId,deviceId,memberId,callId,fingerprint,state,updatedAt,
evidence?}`. Fingerprint is opaque SHA-256 of sorted-key encoded action fields.
States are `dispatching`, `submitted` and `unknown`. **Submitted means events were
posted to macOS, not that the target app performed the intended action.** Verify
through a subsequent frame. Dispatch is fsync-journaled before any input; a crash
turns unfinished dispatch into unknown on restart. Reusing a matching ID returns
the retained receipt; changed payload or lease conflicts. Never retry unknown input
under another ID. The journal stores hashes and receipts, no typed text or frames.
At 10,000 receipts it refuses new actions until a deliberate archival process.

HTTP errors: 400 malformed, 401 authentication, 403 permissions, 404 missing,
409 binding/current-frame conflict, 410 expired, 423 locally stopped/session
unavailable, 429 frame pacing, 503 capture/storage failure. Failure must not trigger
an automatic new lease or repeated input.

## Qualification and installation boundary

A selected target Mac needs this app, a private configuration, the intended logged-in
account, explicit display selection, screen permission, reachable private gateway
and local Enable. Control additionally needs its independent ACL and Accessibility.
The private configuration generator below prepares helper/gateway files without installing a LaunchAgent; launch and local Enable remain explicit.

Before enabling a real target: check existing workload and port ownership; confirm
its running app/signature/config revision, selected account/display, permissions
and tailnet ACL. Test viewing and stopping before enabling control. Test both
portrait/landscape FaceTime, display disconnect, lock, sleep, lost gateway,
expired lease, local Stop, wrong member/call/display, stale frame and process
restart. Then test a click, scroll and printable text in a disposable document,
verify receipts and the result, and confirm a viewer cannot control it.

Lock protection uses public console/session/sleep signals plus macOS distributed
lock notifications and the available session lock flag. The lock notifications/flag
are OS behavior, not a promised public ScreenCaptureKit authorization contract.
Physical lock acceptance on each installed OS is required before qualifying remote
capture/control. This source test suite does not prove those notifications fire on
a particular Mac. Local Stop remains visible and is fail-closed across restarts.

Rollback: stop locally, exit the app, preserve its owner-only action ledger under
`~/Library/Application Support/ClawdTimeCompanion/<deviceId>/action-receipts.json`,
then replace the app/config. Never remove receipts to make an uncertain action
replayable. No Chert worker package or configuration changes are required.

Apple API references: [ScreenCaptureKit captureImage](<https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager/captureimage(contentfilter:configuration:completionhandler:)>),
[workspace session switching](https://developer.apple.com/documentation/appkit/nsworkspace/sessiondidresignactivenotification),
[console session flag](https://developer.apple.com/documentation/coregraphics/kcgsessiononconsolekey),
[Unicode keyboard events](<https://developer.apple.com/documentation/coregraphics/cgevent/keyboardsetunicodestring(stringlength:unicodestring:)>).

## Guided private configuration

The installer accepts the browser/CLI pairing receipt and never requires editing JSON:

```sh
./mac/scripts/package.sh
"mac/build/ClawdTime Companion.app/Contents/MacOS/ClawdTimeCompanion" --list-displays
chmod 600 /absolute/private/pairing.json
python3 mac/scripts/configure.py --claim /absolute/private/pairing.json \
  --directory "$HOME/Library/Application Support/ClawdTimeCompanion/setup" \
  --relay-url wss://YOUR-CLAWDTIME-MEDIA/device-gateway
```

`--list-displays` returns only IDs/dimensions, starts no listener, and requests no
capture permissions. Pair the observed display. The generator verifies it remains
attached, writes mode-0600 files in a new mode-0700 directory, and prints launch
commands without secrets. Conflicting configuration is refused rather than
overwritten. Repeating activation of the exact same claim is a no-op; interrupted
activation can finish only when the original bootstrap backup and staged files
match that same claim.
A new gateway-only key is saved in `media-gateway-secret.json`; the operator must
provision that key on the independent media service through protected configuration.
A public self-service gateway-key enrollment service is not implemented. The helper
and gateway secrets are distinct from each other and from the agent pairing token.

The companion remains stopped until the tester grants Screen Recording, separately
Accessibility for control, and chooses Enable locally. This command never grants
TCC, starts capture, installs over another app, or modifies Apple Teams. Disconnect
through ClawdTime and use local Stop before quitting the companion and gateway;
retain their receipt ledgers for reconciliation. `configure.py` does not implement
remote revocation by itself; active leases also expire within 30 seconds.

For preparation before messaging pairing, use `configure.py --bootstrap-device`
with a new registered ClawdTime device ID. This writes **empty display ACLs**.
After receiving the real verified pairing claim, `--claim ... --activate-existing`
changes only that never-paired bootstrap while preserving secrets and receipts.
Relaunch ClawdTime to load the ACL; local Enable remains a separate step. Complete
stable-path install, grant, gateway and read-only doctor commands are in
[the installation follow-up](../docs/DEVICE.md#independent-installation-follow-up).

## Normal reopening and macOS permission relaunch

Finder and macOS **Quit & Reopen** omit the original `--config` arguments. With
no `--config`, the companion now loads only
`~/Library/Application Support/ClawdTimeCompanion/setup/helper.json`. The setup
directory must belong to the current user with mode 0700; the regular configuration
file must belong to that user with mode 0600. The loader opens the validated file
descriptor with symlink protection and retains the exact configured ACL. An explicit
invalid `--config` fails without falling back to another path.

Opening the stable installed app normally therefore works for the standard setup
location. Empty-ACL bootstrap opens the Setup window even after Screen Recording
has been granted, keeping the Accessibility setup action discoverable. Every
launch remains locally stopped; permissions and pairing never automatically arm it.
An installation using a custom configuration path must continue supplying that
explicit path or deliberately move to the standard setup workflow.

## Resumable same-session onboarding

The CLI writes its authenticated pairing claim to a private file and invokes
`mac/scripts/onboard.py`; the tester does not download or edit JSON. The script
uses the installed `~/Applications/ClawdTime Companion.app` by default and never
replaces an existing app. The internal pilot requires explicit `--pilot-installed`
to use its existing ad-hoc signed app. The signature is checked before running
metadata-only display discovery or configuration validation.

```sh
python3 mac/scripts/onboard.py --claim /absolute/private/claim.json --pilot-installed
```

`--directory`, `--app`, and `--relay-url` are available for an explicitly selected
installation. A new setup requires the independent `wss://.../device-gateway`
relay URL. Existing bootstrap or paired configurations retain helper/gateway
secrets and ledgers. Another device/member/display/control grant is refused.
`--check-only` validates and checks metadata without activating pairing, installing
an app, or preparing a gateway definition. No mode captures screens, sends input,
resets macOS grants, launches/restarts the helper, or enables sharing.

Stdout contains one JSON object with `schema: clawdtime.onboarding/1`,
`scope: local_companion`, `status`, `code`, `nextAction`, and `instructions`.
Exit 2 / `status: blocked` / `nextAction: ask_user` means the current person must
finish a specific step: grant Screen Recording, grant Accessibility for a control
pairing, reload the exact companion configuration, unlock the intended session,
attach the already-paired display, or choose Enable locally. Missing release
artifacts require the pilot operator. Exit 1 / `status: error` refuses unsafe or
conflicting setup without printing exception bodies or credentials. Exit 0 /
`status: ready` establishes local permissions, loaded ACLs, attached display,
active console, and local Enable only. `remoteVerificationRequired: true` remains:
the CLI must also verify its backend/gateway binding before reporting setup done.
No setup status establishes physical call/media/CUA acceptance.

When the gateway Python environment exists, setup prepares only
`setup/com.clawdtime.gateway.plist`. Repeating setup preserves the same matching
file. It never loads that LaunchAgent or restarts an existing gateway. Public
self-service gateway enrollment is not implemented: a fresh pilot device still
needs the operator to provision its independent media mapping through protected
configuration. Existing provisioned devices keep that mapping and its credentials.

An optional `--manifest /path/release.json --trusted-team-id TEAMID` installs a
release **only if the app is absent**. The operator supplies the publisher team
identifier independently of the manifest. The manifest schema is:

```json
{
  "schema": "clawdtime.companion-release/1",
  "bundleId": "com.clawdtime.companion",
  "artifact": "/absolute/path/ClawdTime.zip",
  "sha256": "64 lowercase hexadecimal characters",
  "teamId": "TRUSTEDTEAM"
}
```

The installer verifies the ZIP checksum, bounded safe archive paths, exact bundle
identity, strict code signature, trusted team, and Gatekeeper assessment before
installation; it checks the installed copy again. Links inside archives are
currently refused. This supports a separately supplied signed/notarized release;
no official public artifact, download domain, signing identity, or notarization
receipt is asserted to exist. The pilot installed app is never rebuilt or replaced
by this flow, so its established TCC identity is preserved.

Run the isolated script tests with:

```sh
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
```

Tests cover idempotent activation, interrupted binding publication, preserved
credentials/unknown receipts, conflicting claims, check-only behavior, missing
permissions versus success, signature/team/checksum/archive refusal, and sanitized
unreachable-helper results. They use fixtures and never launch an installed app.

## Agent-owned conversation and Control Panel (protocol 2)

The existing window is now **ClawdTime Control Panel**. It shows the paired call's
coding client/project, current sharing display and macOS permissions, call state,
executor, pending native approval and unresolved input. Agent/session labels are
transient authenticated status, not permission grants. A stale status says unavailable;
it is never presented as proof that a native tool stopped or a UI action succeeded.

The local computer-control preference defaults to **Agent tools only**. The other
choices are **View only** and **Agent tools with ClawdTime fallback**. The previous
controller ACL (`allowControl: true` in pairing) does not opt into fallback. Native
agent permissions remain in the coding client. Fallback still requires the exact
pairing, local Enable, Accessibility, a fresh frame and exclusive current executor.
The owner-only `control-policy.json` beside the receipt journal retains the choice
and increasing revision. Restart never arms sharing. No network route changes this
preference. A mode change stops and disarms sharing; unresolved input prevents
widening policy, while View only and Stop remain available. Saving a choice does
not place a call, grant macOS access or start capture.

Protocol-2 leases append `protocolVersion:2`, `sessionId`, `executorEpoch`,
`policyRevision` and `executor` (`none`, `native`, `clawdtime`). An existing lease
may change executor/mode only with a higher epoch and current local revision.
The selected display, member, call and session cannot change. Input additionally
carries the exact session, epoch and local revision. Changing executor invalidates
the input frame but retains the capture session. Unknown or unobserved input
prevents handoff. A later fresh frame records observation availability only; it
does not assert that the intended application result occurred.

Authenticated `POST /v1/panel` accepts bounded, transient telemetry for that lease.
After sharing stops, status and controls can continue only for the exact previously
bound session/call/member/display and a nondecreasing executor epoch. It cannot
rearm, create a lease or authorize input. `/v1/status` adds `controlPolicy`,
`policyRevision`, `unresolvedActionCount`, and an optional `panelCommand` containing
one stable command ID and exact session/call binding. Mute, End call and Request
pause send cooperative requests; the UI keeps them pending until the same command
is acknowledged by the backend. The controls disable when status is stale.
Stop sharing still immediately disables ClawdTime's own capture/input path.
It is not a system-wide kill switch for native coding-client tools.

Old lease records remain readable and old receipt IDs retain their semantics.
A newly built companion nevertheless requires a fresh local fallback preference
before accepting even a legacy control lease. This is an intentional local
restriction, not conversion of old permission into new consent. Installing or
restarting this new companion is a separate operator action; builds and tests do
not update the installed app.

Panel labels may include a bounded transient `personLabel` (up to 80 UTF-8 bytes,
no control characters) and project/chat label; they are not written to the policy
or receipt stores. Media supplies actual speaking/listening state for the exact
call. Ended and muted status remain authoritative and are never replaced by a
status from another media session.

## Compact activity and synthetic preview

The existing floating NSPanel now has compact and expanded Details modes, with
persistent Stop sharing, Mute/Unmute, Request pause, End call and Setup controls.
It uses a nonactivating panel and does not select another display when moved.
The exact agent/chat and selected display stay visible; long labels truncate
without pushing controls offscreen. Details is keyboard-navigable and scrollable.
Native approvals remain in the coding client. A pending pause/end/mute request
keeps its stable ID and is never displayed as completed before acknowledgement.

`GET /v1/status` advertises `presentationVersion: 1`. Authenticated panel telemetry
may include `presentationVersion: 1` and an `activity` projection with version,
sequence, delivery, work, currentSummary, at most 20 entries, optional outcome and text expiry.
The compact view uses only the current turn’s summary; historical entries remain
in Details and cannot appear as the current result when another turn starts.
Summaries are capped at 160 Unicode scalars and 640 UTF-8 bytes, rejecting Unicode
control/surrogate categories while preserving valid ZWJ emoji. Unknown or malformed
optional presentation is dropped without preventing command acknowledgement.
Legacy telemetry remains supported. Delivery says **Received by agent** only for
acknowledged turns; outcomes distinguish agent reports, unverified and unresolved.

The helper retains presentation only in memory. It clears activity on outer status
expiry (the backend emits five seconds), Stop, policy/lease loss, wrong binding or
call end. Original text expiry also applies while status continues arriving; replay
of the same sequence cannot replace text, extend expiry or repopulate cleared text.
The outcome limit is 60 seconds and the activity limit is 10 minutes. A stopped
call's activity stays suppressed until a newly bound call. Stop remains enabled
when telemetry is stale; remote call controls require fresh exact binding.

Run the separate offscreen fixture executable from `mac/`:

```sh
swift run PanelPreview /tmp/clawdtime-panel-preview
```

It uses the production `ActivityPanelView` and generates 40 synthetic PNGs covering
compact/expanded, light/dark, narrow Unicode labels, larger text, pending commands,
approval, completed/unverified/uncertain, stale and ended states. It does not read
helper configuration, construct `DeviceApp`, open a listener, capture a display,
request permissions, invoke native input or launch the installed companion. Output
is deliberately outside the repository. `swift test` also checks two display
geometries, a narrow screen, status binding, replay/expiry and control semantics.
These renderings do not qualify actual handset readability, VoiceOver, focus behavior,
multiple physical displays, or the installed app; those remain separately authorized
physical acceptance steps.

Readiness metadata uses fixed reason categories and concrete local next steps; Details
shows the check timestamp. Unknown categories, stale timestamps and arbitrary
remote next-step text are not displayed. This read-only status never enables sharing
or requests macOS permissions.

New text-session control uses an explicit local review action and protocol-3 lease
with no call ID. See [Text-session local control grants](../docs/DEVICE.md#text-session-local-control-grants).
Building this source does not update the installed helper or grant control.

## Selected-surface camera capture (local Argos slice)

The helper advertises `cameraVersion:1`; camera capture occurs only for a new
protocol-2 lease with `cameraVersion:1,surface:{kind,id,displayId,ownerPid?}`.
Window selections require their owning process ID; display selections forbid it.
The surface is immutable for the lease. Native-resolution pixels are captured via
macOS-14 ScreenCaptureKit APIs, with single-window shadows disabled. Window
`sourceRect` is intentionally unused because Apple ignores it; the media compositor
crops the native frame before resizing. The original display-only path is unchanged.
`X-Camera-Frame` is bounded base64 JSON with version, exact surface, geometry hash,
content hash and pixel/point/display-origin geometry. Pixels remain transient.

Bounds are 8192 per dimension, 32 million pixels and 2 MiB JPEG. Large captures
fail; no downscale or wider-surface substitution occurs. Current owner and
verified lifecycle are checked before and after capture. Initial selection
requires wholly-contained authorized-display geometry; later window viewing remains
window-ID scoped when partly or fully off-screen. Movement/resize changes the
geometry hash. Closed/minimized or cross-display windows are unavailable. The existing lock, sleep, Stop and lease
checks remain authoritative.

Selected-window fallback input is refused: independent-window capture can show
content behind another window while global input would hit the occluder. Display
CUA remains available under existing ownership and permission rules; exact window
hit-target/focused-element qualification is a separate acceptance step.

Development-only `--camera-list` returns surface IDs and owning process IDs after
permission preflight. `--camera-frame --surface '<exact JSON>'` returns a single
bounded frame over stdout for the local preview. These modes read no helper config,
create no listener or receipt store, never grant privacy permissions, and submit no
input. They require the active unlocked session. See the media README for the local
preview with visible Start/Stop and synthetic fixtures.

For an explicitly authorized disposable surface, `--camera-probe --surface '<exact
JSON>'` repeatedly captures that same identity in one process, stopping at 120
frames or 30 seconds plus completion of the current bounded frame. Explicit
`--probe-seconds 90` extends one probe beyond the former 30-second limit;
accepted durations are integer 1–120 seconds, with at most four times that many
frames. It requires
initial display containment and rechecks the unlocked session and two-second
freshness for every capture. Output contains only frame count, elapsed time and
completion status; errors use fixed capture categories and bounded native numeric
codes. Runtime and freshness use a monotonic clock. A process deadline five seconds
after the selected duration (35 seconds by default) also bounds an unresponsive
framework call.
It never outputs/saves pixels, starts a listener or submits input. This
development probe uses the identical capture/start/stop implementation as helper
frame requests; it does not qualify the remote media or handset path.

For a disposable window, development lookup can resolve one exact app bundle and
window title without listing other titles or capturing pixels:

```sh
mac/.build/debug/ClawdTimeCompanion --camera-find-window \
  --query '{"bundleId":"com.apple.finder","title":"ClawdTime Sharing Review"}'
```

The command refuses absent, ambiguous, minimized, unverifiable or multi-display matches. It
returns only the selected `CameraSurface`; it never opens or activates an app.

### Persistent selected-display local preview

Development-only `--camera-stream --surface '<explicit display JSON>'` keeps one
ScreenCaptureKit display stream alive for the local preview. It rejects windows;
the existing selected-window mode and installed helper HTTP path are unchanged.
The parent sends one `frame\n` command at a time over inherited stdin and receives
one bounded JSON line using the existing frame shape. `stop\n` or EOF terminates
the process. There is no listener, configuration/credential access, disk capture,
input API or automatic restart. Use the media preview launcher rather than piping
frame output to a file or terminal.

The native stream targets at most 15 updates/second, uses Apple's three-buffer
queue minimum, and retains only its latest decoded sample. Source timestamps come
from the sample's host-clock presentation time; repeated samples keep their ID and
timestamp. When a static stream supplies no recent complete sample, a real
same-display screenshot obtains a new observation. Cached pixels are never
restamped as fresh. Payload limits remain 2 MiB JPEG, 8192 pixels per axis and
32 million pixels. The stream compares backing dimensions against the current
`CGDisplayMode.pixelWidth/pixelHeight` and logical placement against display bounds;
this preserves the Retina distinction (for example, 1512×982 points versus
3024×1964 backing pixels). Mode loss/change still refuses publication.
Geometry/display availability, Screen Recording and unlocked
local-session checks gate publication. Stream failure retires the process.

Commands are limited to 16 bytes, requests are serialized, a two-second idle
watchdog bounds lost parent authority, and the process lifetime is at most 15
minutes. Stop closes the sample slot before bounded native shutdown; late callbacks
cannot repopulate it. The preview independently clears its rendered/source state
and terminates a child that does not stop promptly. This source build does not
install or change the companion, preserve captures, or qualify physical Stop/lock
delivery. Apple API references: [frame interval](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/minimumframeinterval)
and [queue depth](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/queuedepth).
Backing-size API: [CGDisplayMode pixelWidth](https://developer.apple.com/documentation/coregraphics/cgdisplaymode/pixelwidth).
Failed stream output reports only fixed stage/refusal categories. The Python
preview forwards only its explicit allowlist from at most 256 stderr bytes;
arbitrary native text is replaced by `stream_unavailable`.
The first stream failure additionally preserves a bounded NSError code only when
its domain equals ScreenCaptureKit's declared error domain (normalized to
`screen_capture_kit`), plus whether a same-display screenshot was active and its
bounded count. This context can distinguish a native stream interruption from
the idle watchdog or local-session guard; overlap does not establish causation.
No localized error, userInfo, title or path is returned. Apple documents native
[stream-stop errors](<https://developer.apple.com/documentation/screencapturekit/scstreamdelegate/stream(_:didstopwitherror:)>);
in particular, a confirmed user-stop code remains terminal and is never retried.
`--camera-inspect --surface '<exact surface JSON>'` reports that identity's window
frame, ScreenCaptureKit filter content rectangle, pixel scale, display bounds and
on-screen flag. These are metadata-only diagnostics with no window title or pixels.
They do not relax capture's current ID/process/display checks or grant permission.

Window capture enumerates all ScreenCaptureKit windows, preserving the exact ID,
owner PID, layer and active selected-display anchor before and after each capture.
A visible or actively streaming window can be captured behind other apps. When both
`isOnScreen` and `isActive` are false, an existing Accessibility grant must provide
exactly one same-owner AX window with matching position/size and `AXMinimized=false`.
Public `AXWindows`, `AXMainWindow`, and `AXFocusedWindow` references are combined
and deduplicated by AX element identity; Finder can omit off-Space documents from
`AXWindows` while exposing the same document via its main/focused references.
The selected rectangle must also be unique among that owner’s layer-zero SCK windows.
Missing attributes, ambiguity, a hidden app, or a minimized window refuse capture;
AX only witnesses lifecycle and never selects the pixels. No private AX-to-window-ID
API is used. This supports eligible windows on another Space without broadening to
a display or changing the selected identity. Apple's [single-window capture
explanation](https://developer.apple.com/videos/play/wwdc2022/10155/) describes
occluded/off-screen capture and minimized-window suspension.

A geometry change between capture's before/after checks discards that image and
returns HTTP 425 (development CLI exit 75). Only this read-only camera race is
retryable: gateway/controller clear prior frame authority and annotations, then
capture the same authorized identity again after fresh policy/Stop/expiry checks.
Closed, hidden, minimized, cross-display or changed-owner failures remain terminal.

The capture-only development CLI runs a prohibited-activation `NSApplication`
event loop, without opening a window or reading installed configuration. A plain
`RunLoop` produced ScreenCaptureKit application-connection interruption (-3805)
on the test Mac. Selected windows use a screen-only `SCStream`, accept its first
complete frame, and request stream stop before publishing. Successful stop
acknowledgment must arrive within 350 ms; stop error/timeout discards pending pixels
and completes exactly once, even if a late callback arrives. A 1.5-second frame deadline
refuses an unavailable source; the preview also bounds the child process to 2.5
seconds. Display capture retains the existing `SCScreenshotManager` path. No audio
or child-window capture is requested. Exact identity and geometry are revalidated
after capture, and the existing two-second freshness gate remains unchanged.
The first complete frame waits for successful `startCapture` acknowledgment before
requesting stop. The stream remains strongly retained through stop acknowledgment
or its deadline; an early frame or asynchronous cleanup cannot release it midway.
Native failures expose only an allowlisted stage and bounded numeric code in
authenticated error headers; raw native error text/userInfo never crosses the gateway.

For window viewing, `source.display*` describes the active display selected at
initial authorization; it is an anchor, not a crop boundary. WindowServer may place
the same window partly or completely outside that rectangle during Space/visibility
transitions. Continued capture permits that geometry only for the exact selected
window with a positive lifecycle check and no intersection with another active
display. The filter always contains only that window, never a display fallback.
Initial helper lease creation and actual-preview Start still require the window
wholly inside its selected display. Display capture retains strict containment.
Selected-window fallback input remains disabled at every layer, so off-screen
geometry cannot become a global click/type target.

### Local preview native activation capability

The development binary's `--preview-native-executor` mode is an inherited-pipe
component for the explicitly enabled local preview broker. It is separate from
installed helper actions and never changes `/actions` policy. Do not invoke OS
effects from shell acceptance probes; the supported rehearsal trigger is the
preview's authenticated **Execute prepared operation** button through native CUA.
Only Finder and TextEdit are allowed; Codex and other targets are refused.

The broker/controller qualifies one exact app/window, checks current native
ownership and live selected-display authority again, reserves a durable receipt,
and submits one activation or one AXRaise. Each effect consumes a token bound to
its operation kind, original two-second qualification, exact session/lease/epoch,
policy, display and retained app/AX identity. Qualification correlates the exact
CG window ID/PID with unique same-bounds AX and CG witnesses; ambiguous, minimized,
outside-display or inaccessible windows refuse. Titles are hashed in memory and
never returned as text. App launch identity and focused/on-screen observations
are independently checked. No coordinates, keystrokes, text, scroll, app launch,
Space shortcut, all-window activation or action retry is implemented.

The activation operation uses one public
[`AXUIElementSetAttributeValue`](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)
write of `kAXFrontmostAttribute=true` on the exact application's AX root. It checks
the root PID and runtime attribute writability, then rechecks retained identity,
permissions and original authority immediately before that setter. This replaces
the earlier AppKit activation request in the preview executor only. Setter failure
is attempted/unknown, with no fallback, relaunch or second effect. API return alone
is never UI success: verification requires the same frontmost app, focused exact
window and on-screen window on the selected display. Activation and raise require
separate prepared operations. This cannot override the original native tool's
application restrictions.

The post-effect observer retains its 600 ms settling budget and original
two-second authority deadline. An explicitly classified CG geometry transition
may be pending only while exact CG ID/PID, unique CG witness, process lifetime,
retained AX reference/title, nonminimized state and unchanged selected-display
authority remain valid. Pending discards older observations. Geometry may return
during this check, but a subsequent strict resolution still must match the
original bounds and all three foreground flags. Missing/ambiguous identity,
Stop/permission/source loss or unresolved geometry at the deadline returns
unknown. These read-only waits neither repeat an effect nor qualify input or
relax the production resolver.

Input/output lines are capped at 8 KiB, one operation is processed at a time,
AX messages have a 100 ms timeout, each request has a two-second process watchdog,
and the process exits after at most 900 seconds. EOF/Stop or controller termination
ends the process; there is no relaunch or replay after uncertain dispatch. Unit
tests exercise admission and no-replay behavior without invoking OS effects.

`--camera-local-status` is a metadata-only diagnostic: it reads local console,
login/lock availability and preflight Screen Recording/Accessibility permissions,
without opening capture or submitting input. It emits fixed booleans and a fixed
session reason, never the session dictionary. Stream `authority_changed` reports
also carry an allowlisted `authority_stage` distinguishing those session reasons,
permission loss, local stream stop and missing stream geometry. This adds diagnosis
only; it does not change eligibility or restart a stopped source.

Native process lifetime identity prefers `NSRunningApplication.launchDate`. Apple
notes that this value may be absent for apps not launched through LaunchServices.
Only when it is absent, the local activation executor reads the exact PID through
`sysctl(CTL_KERN, KERN_PROC, KERN_PROC_PID, pid)` and uses the exported
`kinfo_proc.kp_proc.p_starttime` seconds/microseconds. Apple's
[sysctl(3) documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/sysctl.3.html)
documents this process query; the public SDK's `sys/proc.h` exports the start-time
field. No private libproc interface is used. The query must return the full
expected structure, matching PID and valid nonzero start time. Missing or malformed
identity refuses; PID alone and observation timestamps never substitute.

The opaque identity hash includes the provider, PID, bundle and original start
value. Qualification, pre-dispatch and post-dispatch observations recheck that
same identity; process reuse or switching identity providers refuses. No other
process metadata is retained or logged.

On November 17 the lead verified the normal current-display Finder → TextEdit →
Finder activation flow and outgoing preview, followed by separate original-native
CUA fixture work and clean Stop/release. Off-Space, full-screen, minimized and
multiple-display cases remain unqualified. See the
[physical evidence matrix](../docs/MEDIA_INTEGRATION.md#local-physical-evidence--november-17-2026).

In a subsequent final local rehearsal of the Accessibility activation repair,
Finder → TextEdit → Finder completed with three `verified` receipts and independent
active/focused/onscreen flags true. The first two targets began inactive and
offscreen; returning Finder began inactive and onscreen. Each prepared operation
was triggered once through CUA, without manual window arrangement or repeated
effects. Ownership was released after each step; final local Stop released the
lease and left no preview actors. Earlier unknown receipts remained unchanged.
This qualifies that exact fixture sequence only, not all Spaces, fullscreen,
minimized/multiple-monitor cases or the cloud production path. No call occurred;
the production gate stayed off. Final Swift validation: 98 tests passed.

### Read-only live presentation resolver

`--preview-presentation-resolver` is a separate inherited-pipe capability for
prepared camera presentation. It accepts only strict `resolve` requests and
returns fresh app-active/focused/on-screen window metadata; activation, raise,
click/type/scroll, action tokens and arbitrary fields refuse before resolution.
It shares the existing exact app/window/process-lifetime qualification code but
contains no native effect calls. The process binds one presentation's session,
lease, epoch, cursor, policy, display, window and process identity, and retains no
pixels or titles. Requests/responses are capped at 8 KiB, requests at 64 per
process, each native read at two seconds and process lifetime at 900 seconds.
The local presentation controller kills its resolver after failure, Stop or the
three-second presentation lifetime; a new prepared command uses a new resolver.

The exact-window candidate scan also includes the app's public AX main-window and
focused-window references, because Finder may omit a normal window from AXWindows.
References are deduplicated by AX element identity, never by geometry; the merged
list is capped at 32. A failed AXWindows lookup still refuses. Supplemental
references must pass the same unique CG/PID, geometry, title and lifetime checks.
They do not force Space changes or qualify off-Space presentation.

The installed helper source now exposes an authenticated, read-only
`POST /v1/leases/:id/presentation/resolve` capability. It uses the existing exact
CG/AX/process-lifetime resolver, requires a live selected-display camera lease,
view mode, executor `none`, matching agent session/epoch/policy/display and no
unresolved input, and checks local authority before and after observation. The
backend retains request/cursor authority; those fields are not falsely claimed
to be stored by the helper lease. Original expiry is mandatory. Only Finder and
TextEdit exact targets are supported. There is no production activation, raise,
click, type or scroll capability in this route.

Production selected-display capture remains `SCScreenshotManager` snapshots.
The preview-only mixed `SCStream`/snapshot experiment has intermittently reported
`-3805` (application connection interrupted); its underlying cause is unresolved
and that transport is not promoted by this change. Public cooperative activation
also does not guarantee a macOS Space switch; no private Space API, preference
change, broad capture or automatic action retry is introduced.

## Installed native walkthrough host

The authenticated installed helper now has a separate activation capability and
private native receipt ledger. Its disposable AX executor reads authority from the
installed parent at every native boundary; the parent remains responsive to local
Stop and kills/joins the child without waiting on AX in the UI handler. Existing
preview mode stays distinct. See [device authority](../docs/DEVICE.md#production-native-activation-authority-staged-november-17)
for preparation, dispatch, receipt and rollback rules. A source test or successful
OS setter is not evidence that the requested window was actually visible.
