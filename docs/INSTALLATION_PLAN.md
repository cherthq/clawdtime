# Guided installation and Mac app plan

Draft, November 27, 2026. Reconciled with main at `4a73bc2`.
This document plans two installation routes. It does not implement either
route, publish a download, change line ownership or deploy the website.
Landing-page and setup-guide edits exist separately and are not included in
this plan-only commit.

Current main marks live shared calls as unqualified. Automated coverage and
an enabled coordinator do not establish handset audio, picture or input
readiness. Follow the current shared setup guide for release status.

## Intended experience

Offer two entry points that use one setup engine:

- One command with guided setup: install a selected release, then complete
  setup in Terminal. No coding agent is required.
- Downloadable Mac app: open the app and complete the same setup in a native
  window. Include the runtime so users need no developer tools.

Both pair a verified phone with its own Mac on the shared number. Provider,
voice and line credentials remain on the coordinator. Participants supply
only their model credentials and their explicit permissions. Allow local use
before phone pairing is complete. Optional coding integrations come afterward.

## Existing pieces and gaps

| Piece               | Exists today                                                                                 | Work needed                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Source installation | `scripts/install.sh` checks tools, builds the desktop and links commands                     | Select a pinned release; add shared participant mode; build capture; replace dedicated-line next steps         |
| Model credentials   | `cli/keys.ts` and protected provider storage                                                 | Reuse hidden entry, validation and redaction from both setup interfaces                                        |
| Desktop startup     | `cli/start.ts` and `cli/task-desktop.ts`                                                     | Expose readiness and startup to the setup engine; preserve an existing project and active work                 |
| Shared pairing      | `cli/shared.ts` and `cli/shared-sign-in.ts` verify phone and collect local permissions       | Extract reusable operations from terminal prompts; enumerate displays and locate bundled capture automatically |
| Shared connection   | `shared run` binds a connection to the current desktop lifetime                              | App-owned background lifecycle, exclusive ownership, reconnect and graceful shutdown                           |
| Call verification   | `shared prove` obtains a device-bound code through the live paired Mac, with no sign-in text | Present verification without a second Terminal; preserve exact call binding and expiration                     |
| Mac packaging       | Existing native app and bundled runtime scripts                                              | Produce a complete participant app with capture, production assets and no source checkout dependencies         |
| Distribution        | Local ad-hoc artifacts                                                                       | Developer ID signing, notarization, versioned downloads, upgrade and uninstall behavior                        |

The current installer builds only `ClawdTimeTaskPanel`, but shared screen
sharing also needs `ClawdTimeTaskCapture`. It installs the central line's
packages and the provider CLI even though shared participants do not need
them. The runtime packager does not yet constitute a complete participant app.
The current source installer requires macOS 14+, Node 24+, npm, Git and Swift 6+.

## First delivery: shared setup engine and guided command

1. Extract setup operations from `cli/shared.ts` into a reusable service,
   reusing the existing `cli/shared-sign-in.ts` pairing sign-in helper.
   Represent each step as ready, needs input, in progress or failed, with a
   concrete recovery action. Keep terminal input separate from operations.
   Use a new entry point such as `clawdtime onboard`; the existing `setup`
   command already configures a coding-agent connection.
2. Preflight the Mac, selected release and exact HTTPS coordinator origin.
   Read coordinator readiness, supported protocol and provider availability.
   Publish the intended public origin in release configuration only after it
   is verified. Do not guess it from a number or another installed service.
3. Add shared participant installation to `scripts/install.sh`. Build all
   required native helpers, omit central line dependencies, preserve existing
   installations and select an explicit release rather than moving `main`.
   Initially the guided command may use the existing source-build prerequisites;
   the later prebuilt package removes them from both entry points.
4. Launch interactive onboarding with a real terminal. The current piped
   installer reserves stdin for the script and runs children with `/dev/null`.
   Use a downloaded bootstrap file or explicit `/dev/tty` handoff. Stop with
   a resumable instruction when no terminal is available. Never read a key
   from the installer pipe or require an agent to handle it.
5. Collect model choice and key securely. Start the desktop in local mode,
   wait for actual readiness, and retain the selected project. Ask for computer
   use consent. Detect permissions on the exact installed panel and capture
   helper, open the correct settings pane and recheck after the user acts.
6. Verify phone ownership, enumerate displays, and obtain separate view,
   control and report-opening choices. Reuse a valid pairing on rerun.
   Handle expired verification, existing pairing and unavailable coordinator
   without replacing another Mac or repeating an uncertain enrollment. Reuse
   existing `shared pair --replace`, `shared rotate` and account revoke
   operations; expose their consequences explicitly in the setup UI. Preserve
   the Mac's own saved view/control answers and its local refusal checks.
7. Start one managed shared connection after the desktop is ready. Reconnect
   after network loss only within current authority. A new desktop lifetime
   needs a fresh connection and must invalidate old call/control leases.
   Never replay an uncertain action, resume stopped sharing, or redial during
   recovery. Show busy, offline and expired states distinctly.
8. Finish with one readiness report covering model, permissions, desktop,
   pairing, coordinator and connection. Offer an explicitly requested test
   call; installing or restarting must not send a text or place a call by
   itself. Sign-in texts still require the user's explicit request.

Persist only necessary progress and protected credentials outside the source
checkout. Reconcile remote effects before retrying after a timeout. Never put
keys, phone numbers or verification codes in logs, command arguments or metrics.

## Second delivery: downloadable Mac app

1. Package a stable `ClawdTime.app` identity, the Node runtime, compiled service,
   panel, capture helper, resource bundles and production dependencies. Audit
   launch paths for references to `npm`, `tsx`, source files and build folders.
   Include a browser only if the selected default requires it; account for its
   license and signatures. Shared participants do not ship central line secrets
   or need to host the central voice worker.
2. Add a first-launch window using the same setup operations and state as the
   CLI. Provide secure key entry, display selection, permission status, phone
   verification, recovery actions and a final readiness view. Surface the local
   Stop control before enabling any remote access.
3. Manage desktop and shared connection processes under the app, with one owner.
   Make start at login an explicit preference. Define quit, sleep, restart,
   update and uninstall behavior. Do not rely on an open terminal or chat.
4. Bring call verification into the native UI. Current `shared prove` gets a
   code from `/device/call-proof` using the paired Mac's credential and live
   connection. A phone sign-in alone cannot obtain that code. Preserve exact
   account, call and connection binding, single use and expiration, including
   the 90-second unverified-call window. Do not send the device credential to
   a phone browser or restore the older account-only proof flow.
   Verification while away from the Mac is an unresolved product and protocol
   design dependency. Specify and review a device-authorized remote flow before
   promising unattended callbacks away from the Mac. An HTTPS phone page alone
   does not solve this requirement; the existing endpoints do not authorize it.
5. Build for explicitly supported CPU architectures. Prefer Apple silicon first
   if Intel has not been built and checked; label the download accordingly.
   Sign all executables and helpers with a stable Developer ID identity,
   notarize, staple the ticket and verify a downloaded, quarantined artifact.
6. Publish a versioned DMG with a release manifest and integrity information.
   Define atomic upgrades, preservation of pairing/settings/receipts, idle
   activation and rollback. A manual signed replacement is sufficient for the
   first release; unattended updating is a separate feature.
7. Add disconnect and uninstall interfaces around the existing revoke and
   credential lifecycle operations. Revoke device access when online, stop
   local processes and explain pending revocation when offline. Never erase
   uncertain receipts to make an uninstall or rollback appear successful.

## Concrete prerequisites

| Requirement                                                                                                        | Needed for                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Exact public HTTPS coordinator origin, provider/worker readiness and current live-call qualification               | Pairing and live shared calls; verify deployment rather than infer it from source |
| Existing shared provider project with valid credentials, invited/member sign-in access and allowed recipients      | Delivery of sign-in texts and calls; central configuration only                   |
| macOS 14+ build host with Node 24+, npm, Git and Swift 6+                                                          | Current source builds and initial guided command                                  |
| Apple Developer Program access, Developer ID Application certificate and its private key                           | Signing the app and its nested executables                                        |
| Xcode tools containing `codesign`, `xcrun notarytool` and `xcrun stapler`, plus protected notarization credentials | Notarization and verification                                                     |
| Versioned HTTPS artifact hosting and release configuration                                                         | Stable installer/download destinations and integrity checks                       |
| Clean Mac user or test machine for every advertised architecture, plus an iPhone                                   | Installation, permissions, call verification and upgrade acceptance               |

Use a DMG for the initial download. A PKG would additionally require the
appropriate installer signing identity. Keep signing and provider credentials
outside tracked files and test fixtures.

## Validation and release sequence

Deliver small changes in order: shared setup operations, guided command,
connection lifecycle, native setup UI, packaging/distribution, then activation
of the corresponding website buttons. Keep dedicated-line support separate.

For the setup engine, test interrupted and repeated setup, expired phone codes,
existing installations, denied permissions, partial readiness and unknown
pairing outcomes. For lifecycle work, test network loss, duplicate startup,
desktop replacement, sleep, Stop, expired authority and unresolved effects.
Reuse the shared-provider, shared-display and shared-number tests. Run
`npm run check` for TypeScript integration and `(cd mac && swift test)` after
native changes. Run the line suite only when central voice code changes.

For the downloadable app, check a fresh installation without Node, Git or Xcode,
paths with spaces, quarantined launch, signatures, resources, permission prompts,
restart, manual upgrade, rollback and uninstall. Observe a real call's audio,
picture and requested action separately from automated checks. Current main's
shared setup guide marks live shared calls as unqualified and says not to
publish the number to real users while that status holds. Reconcile release
status with fresh evidence before enabling public shared-call onboarding.
Source installation and local-mode setup can progress independently.

The existing coordinator has one simultaneous call slot. Show busy state and
callback waiting honestly. Shared inbound texting is outside this plan. Neither
installation option increases call capacity or changes provider restrictions.

## Website rollout

The separate landing-page draft describes both routes as planned and links each
to its section in the setup guide. The guide links to current source and shared
setup. Those website edits are not part of this document's commit. Publish no
copy-command action or download link until its target is ready.

Activate the command only after the complete guided flow passes its checks.
Activate the Mac download only after a signed, notarized release passes clean
installation. Keep version, supported macOS/architecture and requirements next
to the applicable route. Before publication, reconcile the site's older pilot
availability and dedicated SMS entry points with shared-service capabilities;
do not advertise shared text enrollment that does not exist.
