# Working production installation and rollback baseline

Captured November 22, 2026, before proactive-calling implementation. The operator
confirmed the repaired incoming FaceTime call worked. This baseline preserves
that installation; automatic outgoing walkthroughs are not yet part of it.

## Private checkpoint

Checkpoint directory on the installation Mac:

```text
~/.local/share/clawdtime-host/checkpoints/working-20261122T183852Z
```

`checkpoints/latest-working` contains its path. Preserve the dated checkpoint even
if a later checkpoint changes that pointer. The directory is owner-only (`0700`);
protected configuration copies are `0600`. Do not commit, upload or print them.

Contents:

- `source.bundle` and `source.tar`: exact committed source and Git history.
- `runtime/`: source, built `dist/`, backend dependencies and voice dependencies.
- `ClawdTime Supervisor.app`: exact installed signed application bundle.
- `node` and `chert-cli/`: installed Node executable and Chert CLI package/dependencies.
- `private/`: environment file, desktop launcher, global CLI wrapper, installation
  record, desktop configuration/identity files, computer-enabled setting, update
  hold and gateway launch-agent configuration. `manifest.json` records missing
  optional files explicitly; absence is part of the baseline.
- `manifest.json`: versions, original paths and modes, source/config hashes,
  observed service identity, shortcut settings, signing information and update state.
- `checksums.json`: content hashes or symlink targets for every captured file.
- `verification.json`: checksum comparison with the installed originals, bundle
  verification, saved app-signature verification and privacy-mode checks.

This is a code/configuration checkpoint. No task database, WAL, call journal,
cursor, job result, conversation, screen or audio data was copied. Existing
provider credentials and macOS permission records remain in their original stores.

## Exact working setup

| Component                      | Recorded baseline                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Installed source               | `~/clawdtime-host`, branch `fix-phone-dispatch`, clean at `e76989e7d54b883dba97f2410b9c4213f13d34bb`    |
| Repository main                | `0b3d5189251ac9f81fbb72208d6aa6a6475c5d0b`; merging main did not replace the installed runtime          |
| Phone startup repair           | `3915f40`                                                                                               |
| Qualified native desktop build | `3ba05cc`                                                                                               |
| Application                    | `~/Applications/ClawdTime Supervisor.app`                                                               |
| App identity                   | `com.clawdtime.supervisor.owner`, ad-hoc signature, no distribution Team ID                             |
| Node                           | `v24.22.1`, original executable under `~/.nvm/versions/node/v24.22.1/bin/node`                          |
| Chert CLI                      | `0.1.0-beta.19`; original package under the same Node installation                                      |
| tmux                           | `3.6a`; phone session `clawdtime-line`                                                                  |
| macOS                          | `15.8.1`, build `24H32`                                                                                 |
| Global CLI wrapper             | `~/.nvm/versions/node/v24.22.1/bin/clawdtime` runs the installed `dist/cli/main.js`                     |
| Desktop launcher               | `~/.local/share/clawdtime-host/launch-desktop.py`                                                       |
| Desktop service                | `127.0.0.1:13416`, state `~/.local/share/clawdtime-host/desktop`, selected project `~/clawdtime-owner`  |
| Supervisor settings            | `~/.local/share/clawdtime-supervisor-owner/supervisor`                                                  |
| Phone configuration            | Installed `line/.env.local`; protected contents are in the checkpoint only                              |
| Phone control                  | Installed `line/host.sh start`, `stop`, `status`; runtime records under `~/.local/share/clawdtime/line` |
| Automatic updates              | No update cron entry; `~/.local/share/clawdtime/line/update-hold` exists                                |

The desktop launcher explicitly sets `CLAWDTIME_SIMULATION_JOBS=on`,
`CLAWDTIME_JOB_AGENT=claude`, `CLAWDTIME_COMPUTER_TIMING=on`,
`CLAWDTIME_DESKTOP_SWITCHING=on`, and shortcuts `ctrl+left` / `ctrl+right`.
It starts the existing Supervisor app tucked and selects the protected desktop
state above. It passes no `--worker codex`, `--checks`, `--session-file`, or
`--calls-config`: the managed task service is simulation while the separate Jobs
path launches real Claude sessions. Do not confuse those two paths on restore.

The incoming agent name is `clawdtime`; capture device is `Capture screen 0`.
The configuration has no release override, semantic-task override, custom voice
model/reader/planner override, greeting-mode override, framing override, FPS
override or barge-in override. Preserve the saved environment and pinned source
defaults together. Optional saved zoom preferences, Away-mode file and outbound
supervisor link are absent: Away and automatic outgoing calling are off.

Read-only installed access preflight passed Accessibility, Screen Recording,
desktop-switch enablement and shortcut availability. Mission Control shortcut
entries 79–82 were enabled; their exact observed settings are in the manifest.
Earlier right/left movement and the incoming FaceTime retry have physical evidence
in `PHONE_DISPATCH_REPAIR.md`. No new input or call was sent for this checkpoint.

The old `installation.json` top-level `automaticUpdates` string still describes
a historic 15-minute schedule. Its nested repair records, current host status,
absent cron entry and update-hold file establish the actual held state. Retain
this discrepancy as evidence; do not recreate that old schedule during restore.

Other qualification/rehearsal task services and the separate gateway were present
on this Mac. They are not the desktop service at port 13416. Their presence is not
permission to stop or replace them. The gateway launch configuration is retained
for reference; do not reload it during an incoming-host rollback without an
identified relevant change. Never use broad process-name termination commands.

## Deployment requirements that keep rollback possible

1. Preserve this checkpoint and current source/dependency paths. Build the new
   release alongside them. Record exact launcher/app/config changes in a deployment
   manifest before switching production to the completed release.
2. Keep storage changes additive and backward-compatible, or ship a tested
   compatibility reader for the baseline. Exercise the baseline against synthetic
   post-upgrade receipts before deployment. Never make rollback depend on restoring
   an old database or forgetting an unknown outgoing-call outcome.
3. Immediately before deployment, record configuration drift and current service
   ownership. Make a new private config checkpoint if needed, retaining this
   known-working version. Credentials may rotate; preserve usable current secrets
   instead of blindly overwriting them with older copies.
4. Require an idle, reconciled call/input boundary for the production switch.
   Install directly once implementation and checks pass, as the operator requested;
   no separate scoped-call test or new deployment-confirmation step is required.

## Post-deployment retention correction

The proactive deployment on November 22 installed a pinned journal-retention
adapter. The historical stop/start commands below describe the captured baseline;
**do not run its unguarded host wrapper after this migration**. Keep the new
immutable release's `line/host.sh` and retention preload. To select baseline agent
code, supply `CLAWDTIME_LINE_RELEASE=~/clawdtime-host/line`, the original
`CLAWDTIME_LINE_ENV_FILE`, and the installed protected
`CLAWDTIME_LINE_RETENTION_CONFIG`. Disable new admissions and reconcile ownership
before switching. Restore the desktop's original configuration fingerprint only
at an idle offline boundary, preserving IDs, credentials and all current state.
The original/new fingerprint and exact source/config hashes are in the private
`proactive-v1/deployment.json`. See [PROACTIVE_CALLS_STATUS.md](PROACTIVE_CALLS_STATUS.md)
and [MEDIA_INTEGRATION.md](MEDIA_INTEGRATION.md) for the installed interface.

## Rollback procedure

1. Disable new proactive-call admissions in the new release. Let an active call
   and input operation finish or stop them through their owned controls. Reconcile
   any uncertain dispatch/cleanup before acquiring the line elsewhere. Keep current
   event cursors, calls, tasks and results in place.
2. Resolve the exact dated checkpoint above, verify `checksums.json`, verify its
   Git bundle, and run `codesign --verify --deep --strict` on the saved app. Confirm
   that the target OS/architecture and dependency paths remain compatible.
3. Inspect the current desktop-service descriptor and live command line. Stop only
   this installation's host (`~/clawdtime-host/line/host.sh stop` when
   that is the active launcher), desktop launcher/service and matching panel at an
   idle boundary. Wait for confirmed exit. Do not reuse a historical PID, restore
   a stale `desktop-service.json`, or terminate unrelated services.
4. Restore the release selection/launcher and signed app from the checkpoint's
   exact artifacts. If restoring files to the original source directory, first
   preserve the failed release and any uncommitted work, then restore the complete
   source, `dist`, and matching dependency directories together. Keep `.env.local`
   and protected state outside source replacement. Do not rebuild the saved app
   with a different identity when the original signed bundle is available.
5. Compare the saved protected configs with current configs privately. Restore the
   launch paths and settings changed by the deployment. Retain valid current
   credentials and ledger-linked identity whenever required; an older token or
   registration cannot be restored independently of its current authority. Apply
   the tested compatibility path if schema changed. Preserve the update hold and
   absence of automatic outgoing calling from this baseline.
6. Start the desktop using the saved launcher and then start the phone host using
   its saved `host.sh start`. Let startup regenerate live descriptors/PIDs. Confirm
   only one phone owner, the intended port/project/config identities, enabled
   computer worker and current TCC grants. Restore only the relevant shortcut
   entries if changed; do not overwrite unrelated macOS preferences.
7. Confirm phone warm startup and server-observed audio/video publications, inspect
   health and original receipt cleanup, and monitor the next normal incoming call.
   Record restored versions and outcome. Do not label restoration as physically
   verified until an actual user call supplies that evidence.

Restoration has not been executed against the working installation. File and
artifact integrity can be verified without interrupting it. The checkpoint cannot
undo a call already placed, restore expired credentials, guarantee macOS will
retain permissions after an OS change, or make old code read a future incompatible
ledger. The compatibility and idle-handoff requirements above are what preserve
a practical rollback throughout the upcoming work.
