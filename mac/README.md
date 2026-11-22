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

### Native automatic call-video presentation

The panel sends transient presentation hints to the authenticated
`POST /desktop/hands/presentation` route while its native hands run. These are
outgoing-video hints only; input and observation coordinates remain main-display
points measured from the top left. Click/scroll/drag targets are emitted before
the guided cursor moves. Typing uses the focused field bounds, refreshed off the
main thread every 350 ms while typing. No field values, labels, window titles,
screenshots or credentials appear in presentation events or logs.

Each hint carries a producer ID, monotonically increasing sequence, hands-command
sequence, 1.4-second lifetime, display size/Retina scale, front application bundle
ID, visible CG window ID and geometry, and the Reduce Motion preference. A changed
app/window/display/geometry retires the old target. Stop, takeover, service errors
and run completion reset presentation. One POST may be in flight; only the newest
unsent hint is retained, and expired hints are dropped without retry. Presentation
network failures do not delay input or alter its receipt.

A first click target on a changed surface is held for at most 900 ms, bound to
that command and exact geometry, until an independent matching observation
establishes stability (an 80 ms settling probe or the regular heartbeat). The
probe does not delay input. A changed command, moved window, Stop or expiry
discards it. An ongoing
typing command survives a geometry change as intent only: the next heartbeat
must reacquire fresh nonsecure field bounds before it can frame typing again.

`HandsController.presentationTransition()` remains a one-shot widening hint for
existing app/URL activation and known app/window or possible Mission Control
shortcuts. Desktop lifecycle integration instead calls
`presentationTransition(phase: CallPresentationTransitionPhase, epoch: Int)`:
switching, waiting and blocked hold repeated transition hints and suppress target
and context events. Ready permits only a fresh context read first; it never
restores old coordinates. Blocked requires a newer switching phase to reopen.
The bridge must use one monotonic epoch producer for the panel lifetime. Stop
and reset fence previously observed epochs; inactive callbacks are ignored.
Neither seam assumes a Space identifier, configures shortcuts or sends input.
Observed surface changes also widen independently of a desktop-switching branch.
See [automatic call zoom integration](../docs/AUTOMATIC_CALL_ZOOM.md) for the
phase bridge, freshness rules and remaining combined acceptance requirements.

The guided cursor window already opts into screen sharing; the video compositor
transforms it with the captured pixels rather than creating a second cursor or
label. Target regions include the action/field plus the planned painted pointer,
pulse and label bounds, so a long label is not clipped by an action-centred zoom.
Typing heartbeats read the currently visible painted bounds again; no label text
is sent and no transparent window padding is used as the presentation target.
Physical capture inclusion and handset readability still require an
exclusive, arranged test. The new pure Swift and loopback HTTP tests cover event
shape, coordinate bounds, Retina metadata, identity/geometry invalidation,
transition policy, authentication, and no retry/redirect. They do not prove
physical input, desktop switching or phone-video acceptance.

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
16 KiB. Transfer encoding, duplicate headers and pipelining are rejected.
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

## Independent task exact-window child

`ClawdTimeTaskCapture` is a separate local presentation child, not the menu-bar
helper or legacy display gateway. Build with `swift build --product
ClawdTimeTaskCapture`; validate pure identity/geometry policy with `swift test`.
It performs no app activation, input, audio capture, network listening, or TCC
permission request. The presentation host starts it only after local Start.

`--preflight` reports Screen Recording permission and unlocked console state.
`--resolve-target /absolute/private/query.json` resolves exactly one prepared
app bundle and exact window title from an owner-only query; it returns bound
window/PID/process-lifetime/display/title-hash metadata, never pixels or a window
inventory. Missing/ambiguous windows and windows not contained by exactly one
display are refused. A bounded geometry diagnostic may describe only that selected
window and active display bounds. Mirrored displays are not silently selected.

The `--config` child accepts bounded inspect/capture/stop requests on private
stdin. Each capture brackets one `SCScreenshotManager` exact-window snapshot with
identity, geometry, expiry, permission, and console checks. JPEG pixels are transient
stdout bytes consumed by the local host; there is no screen recording file or
full-display fallback. See [the task presentation setup](../docs/MEDIA_INTEGRATION.md#independent-task-walkthrough-local-candidate-step-d)
for configuration and qualification boundaries. Building and tests do not grant
permissions or establish real-pixel capture acceptance.

For a lead-coordinated local timing probe, the child also accepts
`--config /absolute/private/capture.json --profile-timing`. Profiling is off by
default. It adds only fixed phase names and bounded `elapsedMs` / `sequence`
integers to stderr; stdout retains its existing pixel protocol and generic
`exact_window_unavailable` refusal. No window titles, IDs, geometry, raw OS errors,
or screen bytes are included in the diagnostic stream.

The phases distinguish stdin receipt, pre/post snapshot window enumeration and
validation, the snapshot await, JPEG encoding, and stdout writes. Closed
`refused_*` markers identify the failed check; the preceding ordinary phase
identifies pre- versus post-capture inspection. Permission/console availability,
grant expiry, process identity/lifetime, window match/title/visibility/layer,
display geometry, pre/post geometry equality, image dimensions, and capture age
remain mandatory. Diagnostics neither retry nor relax a refusal.

A consumer must drain stderr concurrently with stdout and retain only bounded
metadata. Diagnostic writes are nonblocking, at most 128 bytes, and never retried;
sequence gaps mark incomplete telemetry. No observed gap does not rule out a
trailing dropped marker. This option is diagnostic instrumentation, not a stall
repair or evidence of physical acceptance.

### Experimental per-request stream acquisition

`--config /absolute/private/capture.json --capture-stream` selects an opt-in
acquisition candidate. It can be combined with `--profile-timing`; the default
remains `SCScreenshotManager`. Each capture request creates one screen-only
`SCStream` for the freshly inspected exact window, accepts at most one valid
`.complete` image buffer, and joins stream stop before the original post-capture
identity, geometry, image-size, and age checks. No stream or image is reused across
requests, and there is no retry or one-shot fallback.

The sample's WindowServer `displayTime` must fall between the request's native
host time and callback time. Its real host-clock age determines `capturedAt`;
receipt time does not renew old pixels. Idle, started, blank, invalid, wrong-size,
old, and future frames do not qualify. Apple's [frame-status documentation](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle)
explains that an idle event contains no newly generated frame; [Core Media's host-time conversion](<https://developer.apple.com/documentation/coremedia/cmclockmakehosttimefromsystemunits(_:)>)
converts the native `mach_absolute_time` units.

A 600 ms soft frame deadline rejects a request that has no admissible frame.
Start must settle and stop must complete before a result can return. If a lifecycle
callback remains unconfirmed after 1.25 seconds, or stop fails, the experimental
helper terminates itself rather than letting late capture survive into another
request. A native monotonic elapsed check also refuses completion if the deadline
callback itself was scheduled late. The parent observes EOF and joins its owned child; no success is inferred
from submitted cancellation. Parent Stop still terminates that exact child.
`stream_start`, `stream_wait`, and `stream_stop` profiling phases expose this path.
These bounds and lifecycle tests are not proof of native startup latency or a
repair; real exact-window qualification is required before changing the default.

## App-owned local desktop execution

The companion also supports an explicitly configured local task executor. This
path has task/session/executor identities, **no call or paired-member identity**,
and requires no media server or voice provider. It is implemented and covered by
policy/receipt tests; packaged native capture/input and approval-focus behavior
still require physical qualification. Building this code does not install it,
request macOS permissions, enable capture, or grant input.

An owner-only helper configuration may add:

```json
"localExecutors": [{ "executorId": "app-runtime", "displayId": 123456 }]
```

This is a separate display/control opt-in. It is accepted only with loopback
binding. Existing configurations without it retain the call-helper behavior.
Screen Recording, Accessibility, an unlocked active console session, a local
control policy other than View only, and **Enable locally** are still required.
The local and call paths share one execution slot and all unresolved receipt
stores block new control. Local Stop, policy change, display change, sleep, lock,
and session loss revoke local work too; wake/unlock does not resume it.

All routes require the existing private helper bearer; requests never arm the
helper or prompt for macOS permissions:

| Route                                          | Result                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /local/v1/status`                         | `deviceId`, `localEnabled`, `armed`, `available`, `screenPermission`, `controlPermission`, `policyRevision`, optional `activeSessionId`, `unresolvedActions`, `nativeCaptureDrain: true`, `captureActive`. `localEnabled` means configured; `activeSessionId` is the route lease ID. |
| `POST /local/v1/sessions`                      | Reserve a new exact local lease.                                                                                                                                                                                                                                    |
| `POST /local/v1/sessions/:id/renew`            | Change only expiration, at most 30 seconds from the helper clock.                                                                                                                                                                                                   |
| `GET /local/v1/sessions/:id/frame`             | Fresh transient JPEG and existing `X-Frame-*` headers, plus opaque `X-Focus-Identity` digest or `none`.                                                                                                                                                             |
| `POST /local/v1/sessions/:id/actions`          | Reserve and submit one bounded action; return its durable receipt.                                                                                                                                                                                                  |
| `GET /local/v1/sessions/:id/actions/:actionId` | Reconcile without repeating input, including after lease expiry.                                                                                                                                                                                                    |
| `POST /local/v1/sessions/:id/stop`             | Idempotently stop that previously reserved lease; never stop a different current owner.                                                                                                                                                                             |

A lease is `{id,deviceId,sessionId,taskId,executorId,executorEpoch,policyRevision,
displayId,expiresAt}`. Expiration is ISO 8601; responses use the helper's existing
whole-second ISO serialization. Renewal cannot change any identity, epoch,
policy, or display. Used lease IDs are durably retained and cannot be resumed
after restart. The session Stop endpoint revokes the lease, then waits up to
1.5 seconds for an outstanding native screenshot callback to finish. Confirmed
cleanup returns `stopped: true, captureStopped: true`; a stalled callback returns
503 and must remain unconfirmed. Combined local-execution/review-call services
require `nativeCaptureDrain: true` and the confirmed Stop result before starting
review capture. An older helper's `stopped: true` alone does not prove native
capture has finished. Input uses the existing click/type/scroll body, additionally
requiring `sessionId`, `executorEpoch`, and `policyRevision` to match the lease.
There are no new shell, clipboard, arbitrary-key, or application-launch actions.

Only local-mode screenshots omit the cursor and the explicitly identified
ClawdTime companion/panel apps (including the existing supervisor bundle).
The native input path refuses typing into those apps and refuses click/scroll
points covered by their on-screen windows, even if AX hit testing reports an
underlying app. It requires a non-ClawdTime AX target witness; unavailable
identity fails closed. Focus identity is checked before/after capture and before
input, with exact focused-element equality for typing. An approval click that
changes focus can therefore require a fresh observation and plan; it is never
hidden or bypassed. Unsigned/unidentified app behavior remains a qualification
constraint, not an automatic name-based exclusion.

Local receipts live in the helper's private `local-execution` journal. They store
identity, a payload hash, state, timestamps and fixed evidence, never typed text
or pixels. Dispatch is fsynced before native input; restart changes unfinished
dispatch to unknown. A submitted receipt means events were posted, not UI
success. Only a subsequent fresh frame records observation availability; unknown
outcomes remain blocking and are never replayed under another action ID.

The chat panel optionally displays an exact pending action with **Approve action**
and **Deny action**. Both send one decision for that action ID; an unconfirmed
response is reconciled by reads, not replayed. **Stop work** remains a separate
control while approval or chat/voice requests are pending. Its wording describes
a cooperative stop: an action already underway may finish.

For a service reporting `execution.mode: "native"`, submitting chat/voice work
withdraws only ClawdTime's editable chat/board windows before dispatch. A separate
non-key, non-main native panel shows work status, exact pending action decisions,
and Stop. It never activates or restores another application. Browser mode and
older services keep their existing editor behavior. Reopening an editor or any
other genuine focus change still invalidates the native target proof; the helper
never substitutes the former target. This UI handoff requires packaged physical
qualification and does not itself prove that target focus was restored.

Native target validation and event construction now run before the durable
input reservation and again at the final dispatch boundary. A definite refusal
before reservation returns HTTP 409 with fixed `code: "input_not_dispatched"`
only after exact binding and prior-receipt checks. A final pre-post validation
failure records `state: "rejected", evidence: "input_not_dispatched"`. These
outcomes do not create an unresolved-input fence, but the rejected action ID is
not replayable. After event posting begins, lost responses or persistence failure
remain uncertain; they cannot become a definite refusal.

### Separate local-only helper bundle

`CLAWDTIME_LOCAL_ONLY=1 CLAWDTIME_SIGNING_IDENTITY=- bash mac/scripts/package.sh`
creates `mac/build/ClawdTime Local Control.app` with bundle identity
`com.clawdtime.local-control`. The default command still creates the Companion
bundle. Packaging does not install, launch, arm, or grant macOS permissions.
The separate identity requires its own Screen Recording/Accessibility qualification.

Local Control loads only an explicit private `--config` or
`~/Library/Application Support/ClawdTimeLocalControl/setup/helper.json`, with the
same owner-only file checks. It requires loopback and an empty `displays` list,
rejects call-helper HTTP APIs, and keeps receipts in its separate support folder.
It refuses Enable/session admission and reports `available: false` while another
Companion or Local Control process runs. Reappearance of such a helper retires
local work on the periodic check and at request/input/capture boundaries. Stop
and receipt reconciliation remain available. This prevents concurrent use with
an independently installed call helper; it does not upgrade that helper.

### Bound native targets and existing-window activation

Local frames expose bounded untrusted `X-Local-Targets` control centers. The helper
retains up to eight transient catalogs and can issue a one-use proof through
`POST /local/v1/sessions/:id/revalidate` for an exact original/current frame pair
and action. Complete supported AX window semantics, process lifetime, geometry,
actual hit/focus witnesses and selection are rechecked before input; unsupported
or incomplete trees refuse proof. Screens and AX values are not journaled.

`localExecutors[].allowedApplications` optionally lists up to 20 exact application
bundle IDs. Its default is empty. Only those existing ordinary windows may appear
in the bounded untrusted `X-Local-Windows` catalog (`id`, `app`, `title`). The
`activate` action takes an observed `targetId` and always requires a one-use proof;
it cannot launch an app, unhide/minimize-restore it, or target a shell/security UI.
It retains Accessibility, non-secure-input and active-display gates, including
both pre-reservation and final preflight. AXRaise/application activation is a
submitted effect, not proof of the requested UI result; a fresh observation is
still required. Physical cross-window behavior remains a separate qualification.

Directly spawned applications may lack a Launch Services launch date. Local
witnesses then use the kernel's exact PID/start-time tuple; missing or invalid
lifetime evidence still refuses. The bounded window catalog combines actual
`AXWindows`, `AXMainWindow` and `AXFocusedWindow` references, deduplicates them,
and checks each owning PID. An empty `AXWindows` array is not replaced by a
fabricated window ID. Activation revalidation uses the same current membership
and unchanged geometry/title/document checks. On-screen control discovery still
requires its original on-screen CG window and complete AX semantic witness.

## Verified desktop activation and one-step switching in native hands

The native panel's `open_app` command accepts an optional exact `window` title.
`HandsDesktop.swift` resolves one ordinary AX window, restores it if minimized,
selects/raises that window with public Accessibility APIs, and activates its app.
It then waits for stable AX identity/geometry corroborated by the frontmost
on-screen Quartz window and fresh screenshot evidence. An API return alone is
never success. See [desktop scope and acceptance](../docs/DESKTOP_SPACES.md).

A separate `switch_desktop` command accepts `left`, `right`, or `previous`.
It emits **one** configured shortcut and never cycles or retries. Configure both
`CLAWDTIME_SPACE_LEFT_SHORTCUT` and `CLAWDTIME_SPACE_RIGHT_SHORTCUT` in the
**test panel's** launch environment with the exact keys that the tester has
independently checked in macOS Keyboard Shortcuts → Mission Control. There are
no defaults. This attests their action meanings; public `CopySymbolicHotKeys`
only verifies that the two distinct combinations are enabled, not what they do.
The panel changes no settings. Missing, disabled, identical, unresolved-layout,
or unsupported-modifier bindings return `desktop_shortcut_unavailable` before
input. Generic key actions cannot bypass this path through system shortcuts.

Readiness for a directional move requires one post-dispatch Space-change
notification, a different stable ordinary surface, and fresh screenshot/AX
verification within a five-second settling budget. Boundary/no-op moves, empty
or identically pinned-window desktops, and missing evidence remain unknown
rather than successful. `previous` reverses only the last verified step in this
panel session and verifies arrival at its prior surface. It has no global macOS
history: no record or a mismatched source returns `desktop_history_unavailable`.
External desktop/display/session changes, Stop, and failed attempts retire the
record; ordinary worker idle does not. Repeated app focus alone is not a Space
address, so opening/closing the panel chat does not invent or erase history.

Desktop transitions initially require an ordinary window wholly within the
main display and one active display. Full-screen and multiple-display transitions
are unsupported; physical ordinary-desktop qualification remains pending.
The optional `AXFullScreen` observation is defensive, not a documented Space
classifier. `CLAWDTIME_DESKTOP_SWITCHING=off` disables both transition commands
independently of video zoom and the existing computer-use switch. Generic
click/type freshness is separate: a visible full-screen or partly visible window
on the main display, including a multiple-display setup, is not refused merely
because it is outside the narrower transition scope. Input coordinates remain
in the existing main-display coordinate space.

Every native input requires a current observation lease. Space, app, display,
window-identity and geometry changes retire old coordinates. The hands recheck
identity after pointer travel and check Stop/takeover between events. A partially
submitted input returns `input_unknown`; an unverified transition returns
`transition_unknown`, including interruption after a shortcut was dispatched.
Neither is automatically replayed. Enabled system symbolic hotkeys remain
reserved from generic `key` commands; if that inventory cannot be read,
modified/function shortcuts fail closed without changing system preferences.

Validation remains `swift test` and `swift build --product ClawdTimeTaskPanel`
from `mac/`. Deterministic tests cover contract decoding, explicit shortcut
configuration and layout mapping, history inversion/invalidation, independent
Space-event evidence, settling/expiry, Stop/unknown classification, and the
separation of transition restrictions from generic input. These compile and
test code only; they do not activate apps, switch desktops, or establish physical
acceptance. Zoom owns its presentation API; the optional transition callback
carries only phase/epoch and introduces no dependency on the zoom branch.

### Read-only task panel access check

Run the exact deployed app executable with its normal shortcut environment and
only `--check-access`:

```sh
"/absolute/ClawdTime Supervisor.app/Contents/MacOS/ClawdTimeTaskPanel" --check-access
```

This exits before AppKit application/controller startup and reads no panel
configuration or receipts. It emits one JSON object with `version: 1`,
`accessibility`, `screenRecording`, `desktopSwitchingEnabled`, and
`desktopShortcutsAvailable`. The permission APIs are silent preflight checks;
the shortcut check reuses the controller's current-layout/public enabled-key
inventory validation without constructing an input source. It never captures,
posts input, requests permission, opens a window, or starts controller polling.

`desktopShortcutsAvailable: false` includes absent/invalid left-right mappings,
disabled combinations and unavailable inventory. The two combinations still
need the operator's existing attestation that they mean left/right Space;
enabled-key inventory does not identify their actions. The switching flag and
permission fields are independent facts, not physical acceptance. Exit 0 means
the probe completed, even when permissions are false; exit 1 is a probe error.
Combining `--check-access` with other arguments emits a bounded error and exits
2 rather than launching the panel. A bare build's permissions do not qualify a
different signed/installed app: probe the exact deployed executable.

For a source-window refusal, the exact deployed executable also supports the
standalone `--check-desktop` flag. It reads the current front window's AX and
Quartz metadata through the same source matcher used for desktop transitions.
Output contains only fixed reason codes, a display count and boolean facts:
front-app/visible-window agreement, ordinary/full-screen scope and containment.
It emits no app identities, titles, text, frames or images, and starts no input
tap, capture, service connection, configuration/receipt access or application UI.
The current surface must remain unchanged while it runs. `source_ready` is a
source preflight only; it does not verify a shortcut or a destination. Do not
combine the flag with launch arguments or `--check-access`.

Each native desktop-switch attempt also emits one notice-level unified-log
summary under subsystem `com.clawdtime.task-panel`, category
`desktop-transition`. It records command sequence, direction, dispatch status,
Space/environment deltas, observation counts, elapsed milliseconds and fixed
failure codes. The environment delta excludes the attempt's own failure
cleanup; `nativeFailure` preserves the error before an attempted effect becomes
`transition_unknown`. No app/window identities, titles, geometry, request words
or screen contents are logged. Read these summaries with:

```sh
log show --last 10m --style json --predicate 'subsystem == "com.clawdtime.task-panel" AND category == "desktop-transition"'
```

Diagnostics neither change settlement/Stop checks nor clear or retry an unknown
effect. A refusal before the desktop coordinator is called has no transition
summary; the worker's fixed refusal code remains the evidence in that case.

### Directional desktop evidence with app overlays

Explicit left/right moves can separately recognize a stable full-screen
composition when the focused AX parent uniquely matches its Quartz owner,
title and frame, and up to eight smaller ordinary windows of that same app
precede it. Every leading row must have complete, finite metadata and a unique
window ID. Overlay frames must intersect the sole display and be no wider or
taller than the contained full-screen parent. Their full, unclipped geometry
and ordering are retained, including partly offscreen edges; overlays are not
declared harmless or ignored. Foreign leading windows, duplicate IDs, missing
frames and oversized compositions remain unsupported.

A composite source must remain unchanged for three samples over 600 ms before
one shortcut can be sent. Arrival still requires exactly one Space event, a
different parent window, stable complete composition, and fresh capture
bracketed by matching evidence. If either endpoint uses this path, no input
lease or previous-desktop history is granted. App/window activation and
click/type targeting keep their original strict matcher. This fallback is not
used for “previous” or for departures from an empty desktop. The read-only
`--check-desktop` report adds `directionalCompositionEligible` when the strict
source matcher fails; it is a source preflight, not physical acceptance.
