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

JPEG response headers: `X-Frame-Id`, `X-Captured-At` (capture request start),
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
commands without secrets. Existing configuration is refused rather than overwritten.
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
