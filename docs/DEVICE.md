# ClawdTime companion and media status

Source baseline: `be47b11fe1317c4747db4121bec37896998b5201`; file hashes and changes
are in MIGRATION_MEDIA.md. This project does not install or alter Chert workers.

- Companion: macOS 14+, Swift 6, `com.clawdtime.companion`, executable
  `ClawdTimeCompanion`, loopback port 4213, independent
  `~/Library/Application Support/ClawdTimeCompanion/<deviceId>/action-receipts.json`.
- Gateway: Python, loopback HTTP 4214 or preferred outbound authenticated WSS.
  Keep its new SQLite receipt database. No Railway tailnet enrollment is required.
- Media: Python, port 4212, independent `.data/clawdtime-media.sqlite` (production
  volume `/data/media.sqlite` must be a new volume). Gateway/media/API/helper
  secrets are distinct. Credential field names are protocol configuration, not
  permission to reuse Apple Teams credentials or volume state.

Build/package with `./mac/scripts/package.sh`. This creates
`mac/build/ClawdTime Companion.app` and verifies an ad-hoc signature by default.
`CLAWDTIME_SIGNING_IDENTITY` can choose an installed Developer ID; notarization and
external clean installation are separate, unverified release requirements.
No build operation launches the app or changes macOS permissions.

See mac/README.md for the pairing-receipt configuration generator, metadata-only
display enumeration and launch. Installer refuses existing files and missing
attached displays. The internal operator must still provision its generated
media gateway secret securely; public gateway enrollment is not implemented.

## Verification commands

```sh
python3 -m venv media/.venv
media/.venv/bin/python -m pip install -r media/requirements.txt -r gateway/requirements.txt
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
(cd mac && swift test)
./mac/scripts/package.sh
```

Passing source tests do not establish Screen Recording, Accessibility, lock/sleep
notifications on this OS, actual input delivery, a visible FaceTime screen or phone
feedback. Fresh bundle identity requires fresh local grants. Physical acceptance
must observe viewing/Stop first, then typing/click/scroll and one bounded AI action
on a disposable fixture; repeat lock, sleep, disconnect and hangup. Keep capture
disarmed when not testing. No physical acceptance or installation is claimed here.

Stop/disconnect before rollback. Preserve helper/gateway/media ledgers and reconcile
unknown input by the same ID. Never import Apple Teams data or reset receipts to
force a retry. A restarted helper remains stopped; reconnect cannot rearm it.

## Local evidence, November 11, 2026

Python 3.14.0: 56 media tests (52 retained + 4 attention boundary tests), 13 gateway
tests and 3 new configuration-generator tests passed. Swift 6.2.4 on arm64:
7 DeviceCore tests passed, release app build and `codesign --verify --deep --strict`
passed. Four TypeScript MediaDevicePort tests passed. Media error logs during tests
are deliberate failure injections; no real provider request or handset call occurred.

The packaged executable SHA-256 is
`201acb9c54cdeeaf4c9f2f5ab1ce324ae642bcfe3837e2ee89bfd54c84ca31a7`.
Its identifier is `com.clawdtime.companion`, signature is ad hoc, TeamIdentifier
is unset. `--list-displays` metadata-only execution and configuration generation
against an attached display followed by the actual `--check-config` binary passed;
resulting files were mode 0600. The temporary fixture was deleted. Nothing was
installed, armed, granted Screen Recording/Accessibility or launched as a listener.

Apple Teams was rechecked read-only after migration: still clean on audited
`be47b11fe1317c4747db4121bec37896998b5201`. No production runtime state was imported.

## Independent installation follow-up

The current package supersedes the initial hash above:
`2eba7d21a77a011d1eea193292fc4714cb0d907d472db6d543fe94f9dd3c8647`.
It adds authenticated permission metadata and corrects setup wording to describe
agent-initiated attention. The release package and strict signature verification
passed. New scoped readiness tests bring counts to **57 media, 15 gateway and
9 setup/readiness tests**. Actual bootstrap configuration passed the packaged
binary's `--check-config`; gateway startup validation created no ledger or network
connection. These checks do not establish the later installation or TCC grants.

The coordinating lead performs these steps. No command here changes Apple Teams.
Do not replace an existing ClawdTime app/configuration without checking its active
leases and preserving its receipts. Commands assume the stable internal checkout.

```sh
# Build before installing; once permissions are granted keep the stable app path.
./mac/scripts/package.sh
mkdir -p /Users/garygao/Applications
test ! -e '/Users/garygao/Applications/ClawdTime Companion.app' && \
  ditto '/Users/garygao/clawdtime/mac/build/ClawdTime Companion.app' \
        '/Users/garygao/Applications/ClawdTime Companion.app'
codesign --verify --deep --strict '/Users/garygao/Applications/ClawdTime Companion.app'

# Empty ACL bootstrap allows metadata/permission setup, never viewing or control.
python3 mac/scripts/configure.py --bootstrap-device clawdtime_gary_mac \
  --directory '/Users/garygao/Library/Application Support/ClawdTimeCompanion/setup' \
  --relay-url wss://media-production-33fda109.up.railway.app/device-gateway \
  --app '/Users/garygao/Applications/ClawdTime Companion.app'

open '/Users/garygao/Applications/ClawdTime Companion.app' --args --config \
  '/Users/garygao/Library/Application Support/ClawdTimeCompanion/setup/helper.json'
python3 mac/scripts/doctor.py --config \
  '/Users/garygao/Library/Application Support/ClawdTimeCompanion/setup/helper.json'
```

The installed app's setup window has **Grant Screen Recording…** and **Grant
Accessibility…**. The tester must authorize **ClawdTime Companion** in the relevant
macOS Privacy & Security panes; grants to Apple Teams do not apply to this new
bundle. macOS may require quitting/reopening ClawdTime after Screen Recording.
Leave local Enable off during preparation. An empty bootstrap ACL still prevents
all capture/input if Enable is chosen, but it is not a verified messaging pairing.

After the controlled line handoff supplies a real authenticated pairing receipt:

```sh
chmod 600 /absolute/private/clawdtime-pairing.json
python3 mac/scripts/configure.py --claim /absolute/private/clawdtime-pairing.json \
  --activate-existing '/Users/garygao/Library/Application Support/ClawdTimeCompanion/setup' \
  --app '/Users/garygao/Applications/ClawdTime Companion.app'
```

Activation verifies the exact bootstrap device and attached display. It changes
only a never-paired empty ACL, saves `helper.pre-pair.json`, and preserves all
helper/gateway secrets and ledgers. Quit and relaunch only ClawdTime Companion
with the same `--config` path to load the verified ACL. It starts stopped. Then
choose **Enable locally** for the supervised test and rerun `doctor.py`. Doctor
returns exit 2 for incomplete readiness, 1 for unreachable/invalid metadata and 0
for view readiness. Its `readyForControl` field separately reports control readiness.
It requests only `/v1/status`, `/v1/displays` and `/v1/permissions`; no screen frame.

### Gateway startup

First securely provision `setup/media-gateway-secret.json`'s gateway-only key on
the **independent** ClawdTime media service, with `DEVICE_GATEWAY_RELAY=true` and
`MEDIA_DEVICES_ENABLED=true`. Never print the key or put it in a LaunchAgent plist.

```sh
/Users/garygao/clawdtime/media/.venv/bin/python /Users/garygao/clawdtime/gateway/start.py \
  --config '/Users/garygao/Library/Application Support/ClawdTimeCompanion/setup/gateway.json' \
  --check-config
python3 mac/scripts/prepare_launchagent.py \
  --config '/Users/garygao/Library/Application Support/ClawdTimeCompanion/setup/gateway.json' \
  --output '/Users/garygao/Library/LaunchAgents/com.clawdtime.gateway.plist'
```

The preparation script writes only the new ClawdTime plist, refuses overwrites,
and prints exact `launchctl bootstrap`, `print`, and `bootout` commands for the
lead. It does not start a process. Alternatively run `gateway/start.py --config …`
in a supervised foreground process. The wrapper validates owner-only config/map,
refuses another helper port or a symlink ledger, and locks its own process before
opening SQLite. Do not run direct `relay.py` alongside the wrapper.

Read media `/health`: `service` must be `clawdtime-media`, and
`deviceGatewayConnected:true` establishes only transport connectivity. Authenticated
`GET /devices/clawdtime_gary_mac/readiness/<memberId>/<displayId>` checks exact
loaded ACLs and permissions without capture. Backend doctor handles this scoped
request and reports missing steps. `activeSessions:0` and `activeLease:false` are
required during preparation. Phone identity and line ownership are separate gates.

Rollback: use local Stop, quit only ClawdTime Companion, and `launchctl bootout`
only `gui/<uid>/com.clawdtime.gateway`. Keep the setup directory, gateway SQLite
and companion receipt journal. Do not uninstall or alter the Apple Teams app,
LaunchAgents, port 3213, receipts or permissions.

Setup preflight now checks the exact app executable before creating a bootstrap
configuration directory. A missing app leaves no partial configuration; a new
regression test verifies this. This script fix does not alter or rebuild the
installed companion. The TypeScript metadata adapter has five passing tests,
including exact device/member/display read-only routing.

Gateway follow-up: the local framework Python installation had no default CA
bundle. Outbound WSS now loads the pinned certifi bundle explicitly while retaining
certificate and hostname verification. No system trust settings or Apple Teams
runtime are changed. Gateway tests now total 18, including offline rejection of an
untrusted TLS certificate. Install updated `gateway/requirements.txt` in the
independent gateway environment before the lead restarts its wrapper. The companion
binary and its established permission identity are unchanged by this Python fix.

### macOS Quit & Reopen repair

The tester's actual Screen Recording **Quit & Reopen** flow exposed lost launch
arguments. The repaired package defaults a no-argument launch to the independent
standard `ClawdTimeCompanion/setup/helper.json` path, with owner-only directory/file
checks and symlink-protected descriptor reads. It preserves explicit-path behavior,
never chooses another app's configuration, and never auto-arms or expands ACLs.
An empty-ACL bootstrap always opens Setup so the remaining Accessibility step stays
visible after Screen Recording is granted.

Four new Swift regression tests cover normal no-argument relaunch, explicit-path
precedence/failure, private permissions/symlink rejection, and unchanged ACL plus
stopped policy. **11 Swift tests passed**. Release build and strict signature
verification passed. New executable SHA-256:
`abfdeb7eb0228ac2b4ae9d1f35d1fdd89da3c3ac7b1d6aff226c312aa0e858dd`.
This supersedes the preceding package hash. The coordinating lead performs the
stable-path replacement and actual normal-reopen/TCC check; a changed ad-hoc
signature can require renewed macOS grants. No test grants or arms the helper.

### Permission identity diagnosis after the relaunch fix

Read-only inspection on November 11 found one running companion at the installed
`/Users/garygao/Applications/ClawdTime Companion.app` path. Its executable matched
the `abfdeb7e…` release build above, and strict signature verification passed.
The designated requirement was solely
`cdhash H"59feac9a1e76b41d5da86e2f2ef20151d026c84e"`, with no sandbox entitlements.
The Setup labels and authenticated status endpoint call the current process's
`CGPreflightScreenCaptureAccess()` and `AXIsProcessTrusted()` directly; empty
pairing ACLs and local Stop do not change these permission booleans.

LaunchServices contained the installed bundle with that current signature and a
second, launch-disabled build-path registration with an older signature. This is
evidence of stale registration, not proof that LaunchServices caused the failed
grant. The current process and LaunchServices executable path both identified the
installed bundle, so there was no observed wrong executable or separate helper
process receiving permissions. The TCC database was not inspected or changed by
this diagnosis.

If Settings shows enabled switches while both API checks remain false, the lead's
scoped recovery is to quit only ClawdTime, remove only its stale Screen Recording
and Accessibility entries through Settings, add the exact installed bundle using
the file chooser, and reopen that same bundle. Any macOS authentication and grant
remain the user's explicit actions. Recheck both Setup and authenticated status
after reopening; an enabled Settings row alone is insufficient. Preserve the
current executable while qualifying it. If launch-by-name still resolves the
build copy, the lead can unregister only that build-path LaunchServices entry and
force-register only the installed path; do not reset the whole database or other
apps' permissions. None of these recovery actions were performed by this review.

The suspected trigger is the changed ad-hoc signature, not a confirmed TCC
database diagnosis. Apple explains that ad-hoc code identities are unstable and
can cause TCC problems in its [development signing guidance](https://developer.apple.com/forums/thread/751658).
A stable Apple Development or Developer ID identity is the durable distribution
fix; switching identities during this acceptance attempt would require another
explicit grant cycle. See also Apple's [scoped permission reset documentation](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos).
