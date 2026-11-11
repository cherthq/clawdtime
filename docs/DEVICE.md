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
media/.venv/bin/python -m pip install -r media/requirements.txt
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
