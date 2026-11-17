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
The bundle version comes from the root `package.json` (three numeric components).
`CLAWDTIME_BUILD_NUMBER` selects an integer from 1 to 9999 and defaults to `5`;
invalid version/build values fail before compilation or packaging. For example,
`CLAWDTIME_BUILD_NUMBER=5 ./mac/scripts/package.sh` prepares the current `0.4.0`
local review bundle. The label alone does not establish compatibility with a
deployed stack: match exact artifact hashes and negotiated `cameraVersion:1`.
Packaging alone does not install or release-qualify the app, and it does not
contain or upgrade a native messaging provider.

Local packaging check, November 17, 2026: current source produced version `0.4.0`,
build `5`, arm64, with strict deep signature verification passing. Executable
SHA-256: `2b325885a18d1ffeb341b42cdb721f959a669f2a15ac9de2db1e4958c3dc188e`.
The signature is ad hoc with no Team ID. Bash syntax and seven invalid
version/build fixtures passed; invalid values refused before compilation.
This artifact includes selected-surface `cameraVersion:1` and existing native
ownership integration; selected-window fallback input remains refused. That
packaging check launched no app and performed no capture or installation; the
subsequent authorized installation is recorded below.

## Installed camera companion — November 17, 2026

The coordinating lead installed version **0.4.0, build 5** at the stable
`~/Applications/ClawdTime Companion.app` path. The existing private
`~/Library/Application Support/ClawdTimeCompanion/mia-control-20261111`
configuration, helper/gateway keys and receipt state were preserved. The helper
was explicitly relaunched with that directory's `helper.json`; its loaded ACL
contains both viewer and controller access for the same retained member and display.

After the ad-hoc bundle update, authenticated helper status initially reported
Screen Recording and Accessibility unavailable despite enabled Settings toggles.
The lead removed and re-added **only the exact ClawdTime Companion entries** through
macOS Settings. No global TCC reset occurred. Subsequent authenticated metadata
reported `screenPermission:true`, `controlPermission:true`, `cameraVersion:1`,
`armed:false` and `unresolvedActionCount:0`. Sharing remains stopped locally; these
checks establish permission/readiness metadata, not capture or input acceptance.

macOS **Quit & Reopen** dropped the custom configuration argument and loaded the
default view-only `setup/helper.json`. The lead corrected this by explicitly
relaunching the installed app with the retained custom control configuration and
verifying its loaded ACL. Until deliberately migrated, this installation requires
the same explicit `--config` path on each relaunch; ordinary opening does not
select the custom configuration.

Ad-hoc signed updates may require refreshing grants for the exact stable bundle.
Developer ID distribution, notarization and clean-install acceptance remain
unqualified. No screen capture, OS input or phone call was performed during this
installation/readiness check, and no native messaging provider was upgraded.

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
feedback. Fresh bundle identity requires fresh local grants. Screen-only setup
acceptance observes viewing, natural voice/text feedback, exact agent continuation,
the Messages result and sharing cleanup; it requires no click test. Full CUA
acceptance separately covers typing/click/scroll and one bounded AI action on a
disposable fixture, plus lock, sleep, disconnect and hangup. Keep capture disarmed
when not testing. Tests alone establish no physical acceptance or installation.

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

### Same-session onboarding orchestration

`mac/scripts/onboard.py` is the CLI-facing local setup boundary. It consumes the
CLI's owner-only verified claim file, uses the existing installed app, activates
an empty-ACL bootstrap or accepts an identical prior claim, and reports a
structured blocked/ready result. The CLI keeps its current agent session and
retries the same claim after the user completes a local permission step; neither
manual JSON transfer nor repeated TCC reset is part of this path. Details and
release-manifest contract are in [the Mac README](../mac/README.md#resumable-same-session-onboarding).

The orchestrator deliberately leaves local Enable to the person and gateway
start/provisioning to the lead. Its success is scoped to the local companion;
the backend doctor must confirm remote identity, ACL and gateway readiness too.
Twenty-one isolated Python script tests passed after the orchestration change,
including refusal to mark a running broader-than-paired ACL ready.
This change needs no companion rebuild or installed binary replacement: retain
the currently granted app hash and its stable path. No physical acceptance is
added by these tests.

## November 12: Control Panel and local execution policy

The existing Mac setup window is now the ClawdTime Control Panel. Native agent
tools are the default; optional ClawdTime input fallback requires the explicit
local **Agent tools with ClawdTime fallback** preference. Existing pairing
`allowControl` does not supply this new consent. **View only** restricts delegated
computer control while preserving authorized screen viewing. See
[the companion protocol](../mac/README.md#agent-owned-conversation-and-control-panel-protocol-2)
for secure preference storage, revision binding, same-lease execution transitions,
transient status and local call controls.

Local Stop immediately stops ClawdTime capture/input and disarms the companion.
Native cancellation is cooperative and client-dependent. Mute, End call and Request
pause remain visibly pending until the exact backend acknowledgement; status expires
rather than claiming success when disconnected. Unknown input blocks a new executor;
a fresh post-input frame means observation is available, not application success.
Changing policy stops sharing and requires a later local Enable. No build, test or
saved preference silently installs/restarts this companion or enables capture.

## Audited legacy receipt reconciliation (companion 0.2.1)

The initial protocol-2 companion incorrectly treated every older helper
`submitted` receipt as a current ownership blocker. Older helpers never wrote the
new post-input-frame marker even when the backend recorded a later frame. Those
old leases cannot legitimately be resumed merely to create that marker. Native
tools may remain available for ordinary work in the coding client, but ClawdTime
refuses shared-surface ownership while the historical receipt gate blocks it.
Availability of native tools neither bypasses the required ownership transfer
nor establishes the old application's outcome.

The repair preserves original receipts and separates three facts:

- **Unresolved input blocks computer control:** current unobserved submissions,
  pending/unknown dispatch and unreconciled historical submissions remain blocking.
- **Historical input with a later frame:** an exact backend observation is recorded
  as separate provenance, with ownership conclusively closed. It is not UI success.
- **Historical input with no verified result:** ownership closure may be audited
  without inventing an observation. The original submission remains unobserved and
  permanently nonreplayable, but it no longer represents a live executor.

New receipts carry their lease's protocol version. Missing version alone is never
migration eligibility. An explicit private pre-upgrade snapshot and a fresh
lead-prepared audit are required. The offline companion mode acquires the same
exclusive receipt lock as the running helper. It does not start AppKit, a listener,
a lease, capture or input, change local policy, or enable sharing:

```sh
"$COMPANION_EXECUTABLE" --reconcile-legacy-receipts \
  --config "$EXACT_HELPER_CONFIG" \
  --receipt-snapshot "$PRIVATE_PRE_UPGRADE_JOURNAL" \
  --receipt-audit "$PRIVATE_RECONCILIATION_AUDIT" --dry-run
```

After separately authorized shutdown and review, omitting `--dry-run` applies the
same audit. Dry-run validates all conditions and takes the lock but writes no
journal or reconciliation ledger. The journal path is fixed by the configured
device's normal Application Support directory; it cannot be redirected by an
operator flag. No network endpoint performs this migration. No live helper or
coding-client process may still own the affected surface. A failed ownership
attestation, held helper lock, pending/unknown input, selected protocol-2 receipt,
changed snapshot or mismatched receipt refuses the operation.

The version-1 audit schema contains:

- `auditId`, `deviceId`, `sourceSnapshotProtocol: 1`;
- exact raw-byte `preUpgradeSnapshotSHA256` and `expectedCurrentJournalSHA256`;
- `createdAt` in Unix milliseconds, with `helperStopped`,
  `conflictingActorsStopped`, and `currentOwnershipIdle` all explicitly true;
- a nonempty `receipts` list containing exact `id`, `leaseId`, `deviceId`,
  `memberId`, `callId` and `fingerprint` bindings;
- each receipt's `ownership`: `leaseState` (`released` or `expired`),
  `callState: ended`, `executorState: none`, `releaseEvidenceId`,
  `callEndEvidenceId`, and `evidenceSHA256` referencing the retained private
  closure evidence. Expired ownership additionally requires `leaseExpiresAt`
  in Unix milliseconds no later than the audit;
- optional `observation`: exact `actionId`, `leaseId`, `afterFrameId`, and
  `capturedAt` in Unix milliseconds at or after the helper submission timestamp
  and no later than the audit. Omission explicitly preserves an unobserved result.

IDs use the existing letters/digits/underscore/hyphen format, maximum 160 bytes;
digests are 64 lowercase hexadecimal characters. The first application needs an
audit no older than 15 minutes. An exact already-applied audit remains idempotent;
changed evidence under the same audit ID is refused. These are trusted operator
attestations backed by retained evidence, not a claim that the offline tool has
independently queried the backend, gateway or native client's current processes.
Prepare the final attestations only after fresh ownership inspection. If exact
closure proof is unavailable for a receipt, omit it and leave it blocking.

The sidecar `receipts-reconciliation.json`, beside `action-receipts.json`, records
receipt/audit/snapshot hashes and the separate closure/observation provenance.
Files and their directories must be regular owner-owned mode 0600/0700, without
symlinks. Both the original journal and snapshot remain byte-for-byte unchanged
by reconciliation and ordinary unchanged helper startup. Later new input retains
the frozen original reconciled record fields, including unknown extension fields.
The helper refuses reopening a reconciled historical lease, preserves duplicate-ID
checks, and continues to block genuine current or unknown input. It never rewrites
an old receipt to `observed` or labels an application result successful.

Preserve the sidecar, original journal, pre-upgrade snapshot and evidence audit in
backup/rollback. Do not remove the sidecar to bypass an integrity error or remove
receipts to permit replay. Startup fails closed if a reconciled record changes.
The native Control Panel distinguishes blocking input from historical observed or
unverified results. Existing `unresolvedActionCount` status now reports only
blocking input; separate historical counts are available from helper status.

## Text-session local control grants

New source supports explicit text-only grants independently of FaceTime. The helper
advertises `textControlVersion:1` and `localEnableGeneration` in readiness. The
backend proposes a `TextControlGrant` through the authenticated gateway; this only
creates a pending proposal. On the Mac, open the menu-bar companion and choose
**Review text control request…**, inspect the exact project, session, member,
display, actions and expiry, then select **Allow scoped session**. Reject and local
Stop retire the ID. A remote request cannot approve itself or open a confirmation
window automatically. The helper must already be enabled locally, with existing
viewer/controller ACLs and required macOS permissions.

The initial supported `surface` is exactly `display:<displayId>`: authorization
covers the selected whole display, not an application sandbox. The project root is
an exact binding, not a permission to execute arbitrary paths. Grants last at most
15 minutes and permit only the listed click/type/scroll actions. Each lease still
expires within 30 seconds and cannot outlive the grant. Native/fallback ownership
uses the same lease/epoch and local policy. The normal local fallback preference is
still required for helper input.

Protocol 3 is an additive wire variant: omit `callId`, include
`authority:{kind:"text_session",grantId,projectId}` and the existing exact
session/executorEpoch/policyRevision/executor fields. `projectId` is the absolute
project root, and the local approved grant identifies the same device/member/
session/display. Old call-bound leases/receipts keep their original semantics.
Text receipts record grant authority and session/epoch/revision; no fake call ID is
created. Local Stop, lock/sleep/session loss, expiry, policy change, and process
restart revoke the in-memory grant. A later Enable cannot revive it.

This implementation was built and tested without replacing the installed companion
or touching macOS permission grants. Physical text-only input, native/custom
comparison trials, and local UI acceptance require an authorized current grant and
freshly installed matching components. The local Stop controls ClawdTime's helper
path; it cannot forcibly kill arbitrary tools running independently in another
application. Native adapters must cooperate with the same broker ownership policy.

Authenticated DELETE of the exact text-grant ID narrows authority and returns
`{revoked:true}`; it cannot approve or replace a grant. Backend session loss or
revocation uses this route without waiting for a call. Lost revoke acknowledgements
remain unknown; local Stop and bounded lease/grant expiry still apply.

## Argos general camera local source

The opt-in general camera adds exact window/display selection and native-resolution
capture, using the existing helper authorization and gateway. Window identity
includes owning process and selected display, and cannot widen silently. Independent
window capture does **not** qualify window input: this slice refuses selected-window
fallback input until exact hit-target/focused-window qualification. The existing
authorized display click/type/scroll path is retained. [The companion README](../mac/README.md#selected-surface-camera-capture-local-argos-slice)
and [Argos review](IMPLEMENTATION_ARGOS_REVIEW.md) contain commands and current local
evidence. Building this source does not replace the installed companion or modify
its grants/configuration. Local Stop, lock/sleep and lease expiry retain their gates.

### Native CUA alongside selected-window viewing

The minimal local integration keeps independent-window capture as a presentation
source and uses the original agent's existing native tools as the executor. Before
an input, the agent must hold the current `native` executor epoch, satisfy current
cursor/hold and local authorization checks, and independently identify the exact
selected app/window in a fresh native-tool observation. Camera crops and annotations
do not select a native input target. After one harmless fixture action, inspect the
actual UI and the next shared frame; report verification separately from submission
and release ownership. A native timeout is uncertain and must not be retried or
converted into fallback input.

The helper's existing global `CGEvent` click/scroll path and focused-element bounds
check do not prove a selected-window hit target or focused-window identity. They
remain unavailable for selected-window fallback. Qualifying such a future path
requires exact target ownership/focus and occlusion checks, fresh geometry at dispatch,
secure-input refusal, and local physical acceptance; native sharing acceptance alone
is insufficient. Media, gateway and helper refuse this path before OS input; the
gateway also refuses it before creating a new action receipt.

Local Stop prevents further cooperating native dispatch, invalidates camera/control
authority, and clears presentation. It cannot forcibly cancel an unrelated tool
already running in the agent host; cancellation capability and uncertain outcomes
must be reported honestly. The isolated native-review readiness policy is not an
installed-device permission grant or evidence of handset/FaceTime acceptance.

### Current-display activation rehearsal — November 17, 2026

The lead physically verified prepared Finder → TextEdit → Finder activation on
one selected display, including independent foreground/focus/on-screen checks and
the outgoing preview. The original native CUA tool separately performed one
verified disposable document edit/save and file move. Stop left no native owner
and released the viewing lease. This qualifies normal windows on the current
display only: off-Space, full-screen, minimized and multiple-display behavior remain
unqualified. No installed helper, FaceTime path or handset was exercised. The
[media evidence matrix](MEDIA_INTEGRATION.md#local-physical-evidence--november-17-2026)
records measured cadence and limits.

Native qualification supports a missing `NSRunningApplication.launchDate` using
Apple's documented exact-PID `sysctl(KERN_PROC_PID)` process-start metadata; it
never substitutes a PID or observation time for a process lifetime. Missing or
changed lifetime evidence still refuses. Fixed qualification diagnostics identify
media/broker authority, app identity, CG matching or AX candidate-scan stages;
AX candidate failures do not necessarily identify the exact target as the cause.
