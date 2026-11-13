# Acceptance evidence and remaining live gate

**One Codex desktop native-control task is physically verified; full acceptance
remains incomplete.** The November 12 v2 call carried spoken instructions into
the originating chat, used native input, and produced a result the human confirmed
seeing on the phone. Companion 0.2.1 resolves the historical receipt blocker.

The [short filmed demo](FILMED_DEMO.md) uses this native path with a disposable
TextEdit draft; that exact scenario has not yet been rehearsed end to end. Fallback,
Claude physical use, broader native actions, reconnect and calls beyond five
minutes remain unqualified. A 2-second screen relay timeout occurred near the last
intentional hangup. See [current evidence](STATUS.md) for the limits. Local tests
and simulation receipts do not prove phone delivery or physical input.

## Reproducible local checks

```sh
npm ci
npm run check
npm run demo
npm run test:onboarding:browser
npm run test:connectors:real
media/.venv/bin/python -m unittest discover -s media -p 'test_*.py'
media/.venv/bin/python -m unittest discover -s gateway -p 'test_*.py'
python3 -m unittest discover -s mac/scripts -p 'test_*.py'
(cd mac && swift test)
./mac/scripts/package.sh
```

See component README for creating the independent Python virtual environment.
Real-client tests require authenticated installed Claude Code/Codex and use only
synthetic feedback/transport. Browser tests launch an isolated in-memory backend,
export a synthetic pairing, exercise compiled CLI connect/doctor/disconnect, and
preserve unrelated configuration in a temporary home/project. They never enroll
the actual user's device or modify live agent configuration.

## Earlier physical onboarding evidence — legacy v1

The intended tester completed authenticated onboarding and explicit view/control
consent. Both actual Mac permissions pass, and the owner enabled the companion
locally. The Chert test-line sender repair is installed; new invitation and recap
receipts were acknowledged and handset delivery confirmed. Historical unknown
notices remain preserved under exact retirement audits and must not be replayed.

A physical Codex same-chat call showed the disposable fixture, returned authenticated
Messages feedback to the exact session, released sharing, resumed actual work and
delivered the factual recap. Computer control failed qualification: a planned focus
click produced no action receipt, then direct typing reached the Codex reply textbox.
The configured planner's unsupported schema is reproduced and repaired; physical
click/type/scroll/AI targeting, spoken feedback and the Claude Code call loop remain
pending. See STATUS.md for release evidence and limitations.

## Legacy v1 physical Mode 1 matrix — remaining qualification

This matrix describes the legacy yield/acknowledge/resume and completion-message
flow. Current v2 uses ordered conversation turns and exclusive input ownership,
with no automatic completion message; follow [CONNECTORS.md](CONNECTORS.md) and
qualify each architecture separately. The newer native task above does not
retroactively pass this matrix.

During control testing, keep the fixture foregrounded and respond from the handset.
Answering desktop chat questions can move focus to the coding app. After each click,
visually verify the intended target before typing; an input receipt alone is not
proof of correct focus. If planning fails, typing is blocked until a separately
submitted explicit click is observed. No failed command is automatically replayed.

For each documented Claude Code/Codex CLI surface, use a disposable coding project:

1. A fresh intended tester texts the privately verified test number. Receive the
   correct private pairing link, install the companion, select an observed display,
   grant permissions and enable locally. Connect with the bundled command.
2. Run a real coding task. Agent yields conflicting work and explicitly requests
   attention. Record request-created and handset-ringing timestamps.
3. Answer FaceTime. Hear the request question and see the correct live Mac display.
   Record answer-to-visible-screen latency. Prove no unrelated display is shown.
4. Speak naturally without a wake phrase or prefix, and verify text fallback. The exact session sees
   one response, acknowledges it and resumes with the current control epoch.
5. While watching, request clicking, printable typing, scrolling and a bounded compound action
   in the disposable fixture. Observe the application state, not merely a submitted
   receipt. Verify smooth video through each action and no coding-agent/background
   action races control. Confirm spoken replies and a useful landscape suggestion.
6. Verify one factual completion in the same Messages conversation. Record
   human-response-to-agent-continuation latency.
7. Hang up and test local Stop, lock, sleep, helper/gateway loss and pairing revocation.
   Pixels and input stop; reconnect/wake does not silently re-enable sharing.

Retain only explicitly consented sanitized logs/recordings. Never commit phone
numbers, call tokens, user screens or actual conversation content.

## Failure tests

Automated coverage includes duplicate requests/events/results/input, exact response
ownership, expiring/reused pairing, changed origin, missing auth, wrong session,
stale frames, unknown input, crash recovery, unobserved submitted input, exclusive
CUA, view restoration, stop latches, native cleanup reservation, standby gating,
qualified voice and read-only allocation recovery. Migrated component tests cover
helper permission/lock/lease policy, stale capture, receipt reuse, media authorization,
wrong audio publishers, TTS suppression, disconnect, release uncertainty and restart.

Still qualify these on actual devices: missed/declined/busy/no-answer calls without
redial; actual local lock/sleep signals; screen orientation/framing; remote voice vs
echo/incidental speech; signed-install permissions; gateway dropout; provider outage;
call cleanup and Messages delivery; live handoff and rollback event reconciliation.

## Release record

Record repository commit, exact helper hash/signature, client/OS versions, native
worker build, separate backend/media deployment IDs, line ownership evidence,
measured timings and every remaining gap in STATUS.md plus private operator records.
Do not replace the word pending with passed until the actual observation exists.

## Improvements A–F qualification — unrun (November 13, 2026)

The `improvements` branch has isolated source/test authorization only, plus an
explicit push authorization. Nothing in its automated results qualifies installed
components or handset behavior. Package G remains deferred. Do not rerun legacy
calling, messaging, connector spikes or installation commands as part of local
validation. A future operator must obtain separate scope for each physical run.

For a separately authorized one-call run:

1. Record exact source/helper/client/OS versions and select the intended originating
   chat, paired Mac and display. Check readiness; permission changes and local
   Enable are explicit local actions. No recheck grants a lease or resets TCC.
2. Place only the authorized call. Verify compact/expanded Mac controls, no focus
   theft, keyboard/VoiceOver access, both display geometries, and phone portrait and
   landscape readability. Check for duplicate panel/phone overlays.
3. Account for ten predefined synthetic turns: short instruction; pause within a
   sentence; continuation after final recognition; correction while working;
   background noise followed by speech; a Unicode label; delayed agent receipt;
   native approval request; long spoken reply; observed result. Record counts,
   stage timings and failures only, never transcript/screens/audio in Git.
4. Native input needs exclusive ownership and separate explicit authorization,
   uses a disposable local fixture, and must be followed by observation of the
   actual result. No real message is a fixture. Submitted input is not success.
5. Verify local Stop, mute/unmute, cooperative pause and explicit end. Check pending
   versus acknowledged controls and actual provider cleanup. Test remote hangup in
   a separately scoped run if the one call has already ended. A later conversation
   must inherit no task text, command, executor or capture permission.

Separately authorize clean-install, upgrade/rollback, a second Mac, repeated
sessions, gateway loss/restart and long-call qualification; do not silently add
these to a single-call authorization. Record every scripted turn, zero duplicate
or cross-session delivery, zero unauthorized effects, no false success, cleanup,
median/p95 with denominators and missing/failure counts. Ten turns are a small
qualification sample, not a reliability claim. Signed/notarized distribution,
per-device credential isolation, monitoring and broader release gates remain open.

Offline commands added by this branch:

```sh
npx vitest run tests/backend-improvements.test.ts tests/connectors-improvements.test.ts
npx tsx scripts/inspect-session.ts
(cd mac && swift run PanelPreview /tmp/clawdtime-panel-preview)
media/.venv/bin/python media/preview_activity.py /tmp/clawdtime-visuals
```

The inspector defaults to a deterministic calculation fixture. Its example
median/p95 are not measured product latency or a comparison with FaceTimeOS.
