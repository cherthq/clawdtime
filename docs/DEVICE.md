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
  permission to reuse the source project's credentials or volume state.

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
unknown input by the same ID. Never import source project data or reset receipts to
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

The source project was rechecked read-only after migration: still clean on audited
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

The coordinating lead performs these steps. No command here changes the source project.
Do not replace an existing ClawdTime app/configuration without checking its active
leases and preserving its receipts. Commands assume the stable internal checkout.

```sh
# Build before installing; once permissions are granted keep the stable app path.
./mac/scripts/package.sh
mkdir -p /Users/you/Applications
test ! -e '/Users/you/Applications/ClawdTime Companion.app' && \
  ditto '/Users/you/clawdtime/mac/build/ClawdTime Companion.app' \
        '/Users/you/Applications/ClawdTime Companion.app'
codesign --verify --deep --strict '/Users/you/Applications/ClawdTime Companion.app'

# Empty ACL bootstrap allows metadata/permission setup, never viewing or control.
python3 mac/scripts/configure.py --bootstrap-device clawdtime_owner_mac \
  --directory '/Users/you/Library/Application Support/ClawdTimeCompanion/setup' \
  --relay-url wss://media.example.com/device-gateway \
  --app '/Users/you/Applications/ClawdTime Companion.app'

open '/Users/you/Applications/ClawdTime Companion.app' --args --config \
  '/Users/you/Library/Application Support/ClawdTimeCompanion/setup/helper.json'
python3 mac/scripts/doctor.py --config \
  '/Users/you/Library/Application Support/ClawdTimeCompanion/setup/helper.json'
```

The installed app's setup window has **Grant Screen Recording…** and **Grant
Accessibility…**. The tester must authorize **ClawdTime Companion** in the relevant
macOS Privacy & Security panes; grants to the source project do not apply to this new
bundle. macOS may require quitting/reopening ClawdTime after Screen Recording.
Leave local Enable off during preparation. An empty bootstrap ACL still prevents
all capture/input if Enable is chosen, but it is not a verified messaging pairing.

After the controlled line handoff supplies a real authenticated pairing receipt:

```sh
chmod 600 /absolute/private/clawdtime-pairing.json
python3 mac/scripts/configure.py --claim /absolute/private/clawdtime-pairing.json \
  --activate-existing '/Users/you/Library/Application Support/ClawdTimeCompanion/setup' \
  --app '/Users/you/Applications/ClawdTime Companion.app'
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
/Users/you/clawdtime/media/.venv/bin/python /Users/you/clawdtime/gateway/start.py \
  --config '/Users/you/Library/Application Support/ClawdTimeCompanion/setup/gateway.json' \
  --check-config
python3 mac/scripts/prepare_launchagent.py \
  --config '/Users/you/Library/Application Support/ClawdTimeCompanion/setup/gateway.json' \
  --output '/Users/you/Library/LaunchAgents/com.clawdtime.gateway.plist'
```

The preparation script writes only the new ClawdTime plist, refuses overwrites,
and prints exact `launchctl bootstrap`, `print`, and `bootout` commands for the
lead. It does not start a process. Alternatively run `gateway/start.py --config …`
in a supervised foreground process. The wrapper validates owner-only config/map,
refuses another helper port or a symlink ledger, and locks its own process before
opening SQLite. Do not run direct `relay.py` alongside the wrapper.

Read media `/health`: `service` must be `clawdtime-media`, and
`deviceGatewayConnected:true` establishes only transport connectivity. Authenticated
`GET /devices/clawdtime_owner_mac/readiness/<memberId>/<displayId>` checks exact
loaded ACLs and permissions without capture. Backend doctor handles this scoped
request and reports missing steps. `activeSessions:0` and `activeLease:false` are
required during preparation. Phone identity and line ownership are separate gates.

Rollback: use local Stop, quit only ClawdTime Companion, and `launchctl bootout`
only `gui/<uid>/com.clawdtime.gateway`. Keep the setup directory, gateway SQLite
and companion receipt journal. Do not uninstall or alter the source project's app,
LaunchAgents, port 3213, receipts or permissions.

Setup preflight now checks the exact app executable before creating a bootstrap
configuration directory. A missing app leaves no partial configuration; a new
regression test verifies this. This script fix does not alter or rebuild the
installed companion. The TypeScript metadata adapter has five passing tests,
including exact device/member/display read-only routing.

Gateway follow-up: the local framework Python installation had no default CA
bundle. Outbound WSS now loads the pinned certifi bundle explicitly while retaining
certificate and hostname verification. No system trust settings or source project
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
`/Users/you/Applications/ClawdTime Companion.app` path. Its executable matched
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

## Independent task desktop panel

`ClawdTimeTaskPanel` is a separate AppKit executable. It does not load the companion,
capture helper, browser view or provider credentials.

ClawdTime is a computer use agent. The panel is one mascot on the desktop and the
chat that opens out of it:

- A click on the mascot opens the chat. There you give ClawdTime work. Coding agents
  run only for code work, in the background.
- The panel lists no coding-agent sessions. There is no board, no menu item and no
  shortcut for one. `clawdtime agents` still lists them on the command line.
- A bubble about one session that waits for you opens that session's terminal. Every
  other bubble opens the chat.
- The panel shows no task section and no status of the work. Nothing says that
  ClawdTime is doing a task. You see the work on the screen itself.
- A small window shows beside the mascot only while a question of the worker waits
  for you: the question, **Approve** and **No**. It hides at once when nothing waits.
  For an action that the engine holds, the answer goes to that action's id. For a
  question of the worker, **Approve** and **No** send "yes" and "no" through the
  chat, as typed words would. Each question takes one answer. The panel never sends
  an answer twice.
- During every run the bar at the top of the screen says "ClawdTime is using this
  Mac" and holds **Stop**. Holding Escape stops too. The panel's own hands show the
  bar for the worker. For another engine the panel shows the same bar while that
  engine reports work that can stop.

Build and validate locally:

```sh
swift test --package-path mac
swift build --package-path mac --product ClawdTimeTaskPanel
mac/scripts/package-task-panel.sh
```

The optional package is `mac/build/ClawdTime Task Panel.app`, with a separate bundle
identity and a local ad-hoc signature. It is not installed or notarized. Quit the
panel before rebuilding its bundle. The CLI launcher uses the direct executable:

```sh
mac/.build/debug/ClawdTimeTaskPanel --config /absolute/private/desktop-panel.json
```

The lead-prepared config contains version 1, the exact desktop ID, loopback origin,
UI-only bearer token, selected project root, private receipt directory, configuration
fingerprint, and optional bound task ID. The config must be an owner-owned regular
0600 file inside a 0700 directory, outside the worker project. No token is put in
arguments or URLs. The client contacts only its configured `127.0.0.1` HTTP facade,
rejects redirects, uses bounded requests/responses, and never receives operator or
provider credentials. It cannot initiate calls, sharing, capture, or control.

Each mutation reserves a durable local event/digest record before its single POST.
The journal contains no task prose or credentials. Unconfirmed outcomes, including
`not_found`, reconcile through GET only and are never replayed. A completed action
receipt does not prove completed coding, independent checks, or physical cleanup.
Task actions remain gated until a new state read after mutation completion; a state
read already in flight cannot reopen stale affordances.

**Stop sharing** and **Stop call** remain separate, visible controls for the exact
configured existing call: on the bar under the mascot and in every menu. Their
request lanes remain independent of task-session expiry. Closing the chat or quitting
the panel sends none of these actions: the detached service and worker continue.
Reopen with the menu, Dock, or the same launcher command. A held owner-only panel lock permits an
exact same-config invocation to send only a UI reopen notification; a different
config is refused, and a live lock is never stolen. Process exit releases the lock.

Swift tests cover private storage, no-replay receipts, stale action gating,
independent Stop controls, exact receipt binding, real loopback HTTP redirect/POST
refusal behavior, the click on the mascot (the chat, never a board), the bubble that
opens the chat, the rule that the question window shows only while a question waits,
one answer for each question, and the Stop bar during every run. They do not
establish physical handset acceptance.

## Cua Driver qualification pin (November 21, 2026)

The staged background backend pins official Cua Driver and
`@trycua/cua-driver` **0.55.0**, source commit
`8f484f30586eef722bede7a5ce315de1148cca96`, under MIT. The
[official release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.55.0)
macOS universal archive has SHA-256
`faf11948f8f9b410a76750e65ae14cb1d95cc321aa61fc158f70de8a68c270b1`.
A freshly downloaded archive matched that digest. Its `CuaDriver.app` passed
`codesign --verify --deep --strict`; Gatekeeper accepted its stapled notarization
as Developer ID Application **Cua AI, Inc. (YCK386LBJ7)**. The app identifies as
`com.trycua.driver`, version 0.55.0. The manifest minimum is macOS 13.0 while the
[current supported setup](https://cua.ai/docs/cua-driver/quickstart) requires
macOS 14+; the qualification machine meets that requirement. The release publishes
a Sigstore bundle; that separate signature had not yet been verified at this
checkpoint. The TypeScript SDK's package license is MIT; optional perception-model
licenses in the source are separate and no such model was enabled by this work.

The separately installed daemon owns its Accessibility and Screen Recording grants.
Existing companion grants do not transfer. Connect with `CuaDriver.connect` to an
explicit protected socket; `create` can auto-start a standard daemon or fall back
to an embedded runtime, which is not this integration's contract. Use bounded
startup, an approved capability manifest and a narrowing policy; keep both outside
Git. In 0.55.0, `resources` belongs at the manifest root. Input policy requires
background delivery and exact PID/window, excludes control characters in text and
submission keys, and does not expose scripts, process killing or full desktop input.
These mechanical restrictions supplement the host's semantic read/draft-only check.

Start the installed app by its exact path with bounded flags and the intended
socket. The normal permission gate walks the person through System Settings.
`permissions status --json` performs a nonprompting own-app check, but
**`permissions grant` ignores a custom `--socket` and may start a standard daemon
on the default socket**; do not use it to configure this isolated backend. Socket
permissions are 0600 inside a 0700 directory. Session names label the supported
cursor; only `cua.default` is built in. No custom art is required.

Inspection of pinned macOS/core source found protected launch checks for the
driver's own bundle IDs and no hard-coded Codex bundle denylist. That is not proof
that Codex can be controlled: any runtime refusal remains authoritative, and actual
Messages/Codex workflows must pass separately before backend cutover. No historical
message request is replayed as qualification.

### Durable background-controller ownership

The helper now advertises `backgroundProtocol: 1` and a separate
`backgroundUnresolvedActions` count in authenticated `/local/v1/status`.
A missing protocol field is an unsupported helper, never implicit permission.
`POST /local/v1/background-driver` verifies the exact installed, signed pinned
driver and returns an opaque kernel-lifetime fingerprint. The active local lease
can request read-only `background-application` and `background-target` witnesses:
installed bundle/version/path, allowlisted running process, exact window membership,
geometry and conservative current-Space status. These routes do not activate apps,
read window contents, weaken native foreground checks or submit input.

Before starting a driver session or launching an app, the trusted controller reserves
`POST /local/v1/sessions/:lease/background-actions` with kind `controller`, stable ID,
fingerprint, driver generation/PID/lifetime and fresh observation time. Both a new
background journal and an unresolved sentinel in the existing local action journal
are committed before `admitted:true` returns. A duplicate returns `admitted:false`;
it authorizes status reconciliation only. The sentinel uses the old helper's unknown
receipt state, so rollback helpers still block native control rather than ignoring a
new journal they do not understand. Neither journal contains screenshots, typed text
or secrets; the runtime's encrypted receipts retain detailed action outcomes.

Stop and lease expiry release active ownership but never clear the durable fence.
Restart converts reserved controllers to unknown and repairs incomplete paired
journal writes conservatively. New local and legacy admission/input remain blocked.
The authenticated cleanup-only `background-actions/:id/resolve` route remains
available after Stop. It requires the exact receipt/driver identities, explicit
session quiescence, all detailed outcomes reconciled, a fresh observation ID/time
and an observed-completed or definite-not-dispatched outcome. The controller must
obtain this evidence; an acknowledgement, timeout or cursor disappearance is not
quiescence. Unknown effects remain unresolved. No helper route starts a process,
runs a command, or dispatches a driver action.

Swift failure tests cover paired-journal interruption, Stop/expiry cleanup, restart,
wrong-driver resolution, duplicates, unknown outcomes and the legacy local-store
fence. They are not physical Stop or driver-restart acceptance.

### Updating the staged helper

The current packaging script builds a new artifact and signs ad hoc unless an
explicit identity is supplied to `mac/scripts/package.sh`. The bundled-runtime
packager currently forces ad-hoc signing. The inspected installed local helper has
bundle ID `com.clawdtime.local-control`, no signing team, and a designated requirement
bound to its current code hash. Changing its executable changes that requirement;
keeping the path and bundle ID alone does not establish preserved TCC authorization.
Do not reset TCC or copy permission databases to work around this. An updated helper
requires permission/status requalification on this Mac; stable distribution signing
must be established separately before promising identity continuity across updates.

Only the coordinating lead may switch the idle installed runtime to a separately
built and verified version. Preserve the existing private configuration and both
receipt journals, retain the previous artifact for rollback, stop the exact former
controller/helper before starting its replacement, and reject helpers missing
`backgroundProtocol:1`. Ad-hoc build validation is not notarization, physical local
Stop acceptance, or proof that prior permission grants still apply.

After the lead installed the updated local helper, its read-only status reported
both required macOS permissions granted. This verifies retained grants for this
particular update; it does not change the ad-hoc signing limitation above. Local
Enable remained off at that observation, which is a separate user-controlled gate.

### Diagnosing an unexpected local disarm

`mac/scripts/background-session-event-witness.swift` is a bounded read-only
notification witness. Compile it outside the installed runtime and run with
`--helper-pid <exact-current-helper-pid> --seconds 300` (maximum 600 seconds).
It opens no window, requests no activation, reads no helper secrets/configuration
or screen content, and submits no input. Its stdout contains only fixed event names,
wall/elapsed timestamps and session/conflicting-helper availability booleans.
It watches the helper's screen-parameter, sleep/wake, session and lock/unlock events,
plus display-reconfiguration callbacks and 50 ms availability changes. The raw
availability observation does not expose the helper's private forced-unavailable
latch. Start it before local Enable and let startup notifications settle.

The previous helper's screen-parameter callback always called the full Stop path,
even when the current session remained available. The staged display-signature guard
below retains Stop for changed or uncertain display facts. Wake/unlock/restored
callbacks still require a fresh local Enable. A temporary unavailable session or competing helper
can similarly disarm through policy checks before a later status reads available.
By contrast, the local session-stop route and ordinary lease expiry release the
lease without explicitly disarming. These distinctions narrow the diagnosis but
do not identify an observed cause without matching event timestamps.

Apple documents [screen-parameter notifications](https://developer.apple.com/documentation/appkit/nsapplication/didchangescreenparametersnotification)
as display-configuration changes; the notification contains no cause payload.
The inspected pinned driver's exact-window capture uses capture APIs and software
image resizing, with no display-mode setter found on that path. The helper's status
panel uses a nonactivating floating panel. Neither finding proves what triggered a
particular notification. Preserve local Stop and all meaningful display/session
boundaries; do not automatically re-arm after a capture or notification.

### Operator retirement of one uncertain New Chat navigation

An uncertain navigation must not be relabeled as successful or never dispatched.
The authenticated operator-only route
`POST /local/v1/sessions/:lease/background-actions/:controller/retire-navigation`
accepts a narrow trusted attestation after the exact driver controller is quiescent.
It is separate from ordinary worker shutdown and generic resolution. It uses the
existing helper bearer, so this is a trusted operator boundary, not a second
cryptographic privilege. The coordinating runtime must first independently verify
its immutable encrypted action manifest: exactly the designated Codex New Chat
navigation, no text or submission dispatched, and no replay. The helper receives
only linked IDs/hashes and cannot inspect that manifest itself.

The request contains the original controller fingerprint, driver generation/PID/
process-start fingerprint, `driverQuiescent:true`, an observation ID/time, and
`evidence` with `kind:"codex_new_chat_navigation"`, exact session/task IDs,
action receipt ID/fingerprint, `originalOutcome:"unknown"`, `noReplay:true`, and
`noTextOrSubmissionDispatched:true`. Initial evidence must be fresh within five
seconds and after the reservation. Exact retries are idempotent; changing any
retained evidence is rejected. Generic resolve cannot create or reclassify this
retirement, and a resolved controller cannot become a retired unknown.

The background receipt becomes `retired_unknown_navigation` with a separate
`retirement` object, while its original reservation remains intact and no success
resolution is recorded. That record commits before the local sentinel changes to
state `unknown` with evidence
`background_controller_quiescent_retired_unknown_navigation`. The new helper
exempts the sentinel from active exclusivity only after validating the matching
durable background retirement in memory. A standalone local-journal reader or
older helper still counts it unresolved; rollback therefore fails closed without
inventing an old-format successful outcome. Restart reconstructs the exemption
only from the exact durable proof and repairs interrupted sentinel updates.

This cleanup neither arms the helper nor recreates a lease, dispatches input, clears
unknown application history, or authorizes replay. Runtime owner release occurs
last, after helper retirement and its own linked no-replay disposition are durable.
Tests cover Stop/expiry cleanup, exact retry/conflict, rejected classes/contexts,
missing assurances, both journal interruption orders, and old-reader blocking.

### Stable display-notification guard

`DisplayConfigurationGuard` distinguishes a duplicate screen-parameter notification
from an actual change by comparing complete, canonical display facts. The native
reader enumerates active and online display IDs, main-display identity, bounds,
mode ID/flags, logical and backing-pixel sizes, refresh rate, rotation, mirroring,
and NSScreen backing scale. It rejects incomplete/duplicate/mismatched IDs,
nonfinite/invalid geometry and changes in enumeration during a read. Two consecutive
complete identical reads are required before comparing against the prior baseline.
Ordering alone does not change the signature. The signature stays in memory; no
screen pixels, window titles, application content or device serial numbers are read.

A notification whose complete signature equals the baseline increments
`ignoredStableScreenNotifications` in authenticated status without disarming.
Any different signature still runs the full Stop path and clears old local frame/
target proofs. Missing or unstable metadata stops with
`screen_parameters_unavailable` and retires the baseline. Explicit local Enable
also checks two complete reads, refuses uncertainty and retires prior authority
before establishing an explicitly enabled changed configuration. No notification
arms the helper. Sleep/wake/lock/session events and explicit Stop remain unchanged.

NSScreen `visibleFrame` is intentionally excluded: Dock/menu-bar work-area insets can
change with application presentation without changing display identity, screenshot
bounds, pixel scale or absolute input coordinates. Exact target-window geometry is
still independently validated before input. This exception does not ignore display
origin/size, scaling, rotation, mirroring, online membership or mode changes.

Six regression tests cover stable duplicates, enumeration reordering, every stored
coordinate/mode fact, attachment/removal/main-display/active/mirror changes and
missing/unstable/invalid reads. The native reader returned two complete identical
snapshots on the qualification Mac. Local Enable followed by ordinary app switching
and an increased ignored-notification counter remains a physical acceptance check;
these tests do not establish that outcome or a specific cause of OS notifications.

## App-owned prepared review view

`mac/scripts/package-review-window.sh` builds and locally signs
`mac/build/ClawdTime Review View.app`, bundle ID `com.clawdtime.review-view`.
It does not install or launch it. The service starts its executable with
`--config /absolute/private/review.json`, where the owner-only configuration is:

```json
{
  "version": 1,
  "title": "ClawdTime review synthetic-attempt",
  "sections": [
    { "heading": "Decision", "text": "A bounded plain-text brief." }
  ],
  "expiresAt": 1800000060000
}
```

Expiry must be in the next 30 minutes. The renderer accepts no HTML, script,
navigation or capture commands. It displays literal text in one identified
window and emits bounded ready metadata. `ClawdTimeTaskCapture --resolve-target`
then independently resolves the exact app/title/process/window before any capture;
window creation alone is not capture or export authority. Keep each prepared page
short enough to read without scrolling. Local Stop, closing the window, expiry or
EOF on the controlling stdin pipe ends the view.

The only stdin command is a bounded JSON line
`{"id":"invalidate-one","op":"invalidate"}`. It permanently replaces old
content with a fixed notice that work changed and awaits a fresh checked review,
without changing the window identity. The acknowledgment
`{"id":"invalidate-one","invalidated":true}` follows main-thread layout and
display. A fresh independently captured frame is still required before resuming
sharing; this acknowledgment is not proof of handset visibility. Invalid commands
close the renderer. No arbitrary content replacement or native input is exposed.

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

### Native tool foreground readiness — November 17 follow-up

Native-tool UI access does not by itself qualify foreground presentation. In the
lead's no-call check, CUA selected exact Window-menu entries and invoked exposed
Raise actions; the disposable TextEdit window entered and exited fullscreen.
Independent metadata observations nevertheless reported `appActive:false` and
`windowOnScreen:false` in all 116 samples over about 25 seconds while fullscreen,
and all 84 samples over about 18 seconds after restoration. `windowFocused:true`
persisted. No document content was edited. This establishes an unresolved
foreground-readiness failure for that run, not successful cross-Space switching.

The observer requires both `NSRunningApplication.isActive` and exact
`NSWorkspace.frontmostApplication` identity for `appActive`; Apple documents the
latter as the app receiving key events. `windowFocused` compares this target
app's `AXFocusedWindow`, which is separate from global activation. The onscreen
flag comes from an exact CG window/PID/geometry witness and fails closed when that
witness or its flag is unavailable. Consequently, false flags do not establish a
particular Space, a virtual desktop, or the CUA provider's GUI-session identity.
The observer's console/login/lock checks do not establish that another tool uses
the same session. No such root cause has been proven.

For lead-operated metadata qualification only:

```sh
mac/.build/debug/ClawdTimeCompanion --native-observe --target '{"appId":"com.apple.TextEdit","windowId":"EXACT_WINDOW_ID","ownerPid":123,"displayId":1}'
```

Replace the example PID/window/display with freshly identified exact values. This
development command has a two-second watchdog, no capture/input verbs, and no
lease or execution authority. Its three booleans are sampled evidence, not a
persistent-foreground guarantee. Native input still needs current exclusive
ownership and target verification; presentation additionally needs the exact
window active, focused and onscreen in fresh independent observations. A tool's
rendered app image or successful AX action cannot substitute for those checks.

The read-only production resolver cannot activate a window. The original
background preview executor used AppKit cooperative activation; that request did
not establish foreground success in this run. The subsequent Accessibility
activation change and its bounded physical acceptance are recorded below. Keep
presentation unavailable when verification fails, without weakening guards or
retrying an uncertain action.
See Apple's [foreground-app definition](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)
and [cooperative activation contract](https://developer.apple.com/documentation/appkit/passing-control-from-one-app-to-another-with-cooperative-activation).

### Prepared native activation repair — verified fixture sequence

The lead subsequently verified Finder → TextEdit → Finder using three distinct
prepared operations, each triggered once through the local preview's authenticated
CUA button. All three receipts reached `verified` with `exact_window_observed` and
independent active/focused/onscreen flags true. The first Finder and TextEdit
preparations had active and onscreen false; the return Finder preparation was
inactive but onscreen. No manual window arrangement or repeated effect was needed
for this final sequence. Earlier uncertain receipts were retained unchanged.

The preview executor now uses one public Accessibility `AXFrontmost=true` setter
on the exact retained application. It first checks the root PID and whether that
attribute is writable, then rechecks the original qualification deadline,
permissions, app/process lifetime and exact AX window before dispatch. Setter
failure remains attempted/unknown; there is no AppKit fallback, relaunch or second
activation. Acknowledgment still requires independent post-effect verification.

During the unchanged 600 ms read-only settling period, only an explicitly
classified CG geometry transition may remain pending. The exact CG ID/PID,
process lifetime, retained AX reference/title, nonminimized state and original
display authority must remain intact. Pending clears earlier evidence; final
verification must reacquire the original bounds and all three foreground flags.
Identity loss, display/permission/Stop changes, original expiry or an unresolved
transition at the deadline remain unknown. The setter is never retried.

Ownership was released after each step. The final state was `none`/`idle` at epoch
6; local CUA Stop then produced `none`/`paused` at epoch 7, released the lease and
left no preview actors running. This was a local, no-call fixture acceptance with
the production gate off. It does not qualify every Space layout, fullscreen,
minimized or multiple-monitor cases, the cloud production path, or handset output.
The final source passed 98 Swift tests and independent safety review.

## Production native activation authority (staged, November 17)

`nativeActivationVersion: 1` advertises a separate narrow capability. Backend and
media admission require `CLAWDTIME_NATIVE_ACTIVATION_ENABLED=true`; its default is
off. Existing leases and sessions do not acquire input authority from this flag.
Only Finder/TextEdit activation and independently qualified window raise are
accepted under a current protocol-2 native/view selected-display lease, controller
ACL, local Enable, Accessibility, Screen Recording and native local policy.

Authenticated helper routes are `POST /v1/leases/{lease}/native/prepare`,
`POST .../native/dispatch` and read-only `GET .../native/{operation}`. The envelope
binds the existing operation/fingerprint to media session, pairing, device/member
and original planning expiry. Preparation observes current identity without input;
dispatch requalifies that exact process/window/bounds within its original two-second
native deadline. A new deadline cannot renew the same dispatched operation.

The installed parent owns policy and private fsynced reservations in
`<device>/native/receipts.json`. A disposable child executes the existing single
AXFrontmost/AXRaise behavior. It asks the parent through inherited pipes for local
authority immediately before the setter and throughout the existing 600 ms settle.
The parent serves these checks on its policy actor without running AX there. Stop
disarms and sends SIGKILL immediately; it never waits on AX or a cloud callback.
A later reply to the killed child meets a closed pipe and fails with EPIPE: the
companion ignores SIGPIPE, and the child's input pipe never raises it.
The asynchronous request joins the child before completing its receipt. An already
admitted OS request may have taken effect when Stop arrives; killed, interrupted or unconfirmed operations retain uncertainty rather than
claiming cancellation or verified UI success. A matching child response proves
that the host returned; if authority was lost before receipt completion, the
receipt is only `returned`, never `verified`. A child result cannot restore stopped policy.
A dispatch that ends before the child has the effect request (the child cannot
start, its qualification refuses or the target changed) sent no input, so its
receipt is `rejected` with reason `native_refused_before_effect` and clears the
fence. Any failure after the effect request stays uncertain.

Unknown receipts fence replacement leases, input and execution transfers. Read-only
receipt retrieval survives Stop and restart. Ledger write failure poisons local
admission, so an in-memory terminal result cannot clear the durable fence. Preserve
both action and native receipt directories during upgrade and rollback. An older
helper that cannot read native fences is not a safe rollback while any native
operation is unresolved.

New source tests cover exact scope/deadline checks, duplicate reservations, durable
restart uncertainty, competing helper locks and poisoned receipt writes. They are
not physical acceptance. See STATUS.md for lead-run local and production evidence.

The read-only production presentation resolver also runs in a separate child.
Helper policy, exact lease and Stop generation are checked before and after each
awaited read; Stop kills and asynchronously joins it. The parent's main actor
never performs the resolver's AX calls. The existing 180 ms read budget remains;
an idle child is retired at the last read’s original absolute authority expiry
(at most two seconds), and retirement owns the child slot until
its exact process/handles are joined and cleared. A simultaneous new read cannot
inherit or erase an older child's resources. The installed child's bounded 256-ID
history covers the existing admitted presentation lifetime; preview retains its
64-ID bound. Neither mode renews timestamps or authority to fit transport delays.
