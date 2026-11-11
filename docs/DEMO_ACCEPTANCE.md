# Acceptance evidence and remaining live gate

**Not demo-ready.** Local/client/component tests passed as recorded in STATUS.md.
Simulation receipts prove code behavior, not phone delivery or physical input.

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

## Current physical onboarding evidence

The intended tester’s authenticated inbound reached ClawdTime. Both actual Mac
permission checks pass after scoped TCC repair. The user completed explicit
view/control pairing. Its private file was saved and applied; the companion reports
the selected display attached and both ACLs loaded. Both connectors are configured
in the disposable project. Local Enable remains off.
The outgoing pairing notice has an unknown native outcome; its stable-origin
read-only journal lookup returns HTTP 503. No retry or call was issued. Resolve
that provider prerequisite before live acceptance; see STATUS.md.

## Physical Mode 1 matrix — call loop pending

For each documented Claude Code/Codex CLI surface, use a disposable coding project:

1. A fresh intended tester texts the privately verified test number. Receive the
   correct private pairing link, install the companion, select an observed display,
   grant permissions and enable locally. Connect with the bundled command.
2. Run a real coding task. Agent yields conflicting work and explicitly requests
   attention. Record request-created and handset-ringing timestamps.
3. Answer FaceTime. Hear the request question and see the correct live Mac display.
   Record answer-to-visible-screen latency. Prove no unrelated display is shown.
4. Say "Hey ClawdTime, answer: ..." and verify text fallback. The exact session sees
   one response, acknowledges it and resumes with the current control epoch.
5. While watching, perform click, printable typing, scroll and one bounded AI action
   in the disposable fixture. Observe the application state, not merely a submitted
   receipt. Verify no coding-agent/background action races control.
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
