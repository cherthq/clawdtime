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
