# Handset audio passed; continue with presentation choreography

The authorized Deepgram fallback handset retest passed on November 18, 2026.
The user confirmed all requested checks: clear task-specific opening, accurate
status dialogue, interruption, 20 seconds of quiet and explicit spoken hangup.
One audio-only call was placed. No screen capture, presentation or control was
used, and no automatic redial occurred.

The c.1 physical gate is satisfied by the human's report, separately from machine
evidence. Machine receipts show preparation, native dial, media activation, native
end and media closure all completed. Native cleanup and local media closure are
confirmed. All local ports closed and the task owner lock was released. Automated
status correctly retains `physicalAcceptance:false`; a machine status is not a
human attestation and was not rewritten to manufacture one.

The backend has been restored: every original configuration value matches, the
standby instance is removed, and fresh runtime checks show live mode with traffic
enabled, zero active calls and zero pending/unknown effects. Deployment restoration
evidence is retained privately; no demo source was deployed.

## Next work

Continue step d of `docs/CODING_DEMO_IMPLEMENTATION_PLAN.md`: prepare real code and
preview scenes, verify exact windows, synchronize narration with visible scenes,
and build the local walkthrough from verified task results. Start at 15 fps.
The original implementation authorization covers this offline work. Later live
presentation calls require their own specific authorization; the successful
voice-only retest does not authorize another call, screen capture or control.
Step e follows the completed presentation step.

Keep the existing authoritative task and original fixture pairing. The task remains
`review_ready` with its independently verified run history; handset destination
identity was admitted through a separate immutable grant, not by relabeling the
original task. Deepgram currently supports only handset status and hangup. The
ElevenLabs local path remains the separately qualified coding-instruction path;
do not assume the new fallback supports spoken coding runs or presentation tools.

## Checkpoints and evidence

- Steps a, b and c retain their existing tags; step c is `46a64fb`.
- `6db733a` added guarded handset testing and activation checks.
- `067c513` records the earlier provider-blocked, undialed retest and restoration.
- `a1707f5` adds the explicit Deepgram fallback, independently reviewed and checked
  with 826 TypeScript tests plus typecheck/build and 265 media tests.
- The current acceptance checkpoint records c.1 and its restoration. See
  `docs/BUILD_LOG.md` and the annotated `step-c1-done` tag after release.

Protected evidence is in `retest-3-deepgram/` beneath
`/Users/garygao/.local/share/clawdtime-coding-demo-qualification`. It includes the
one-time mutation intents/results, exact deployment comparison, immutable operator
attempt, cleanup summary and separate human acceptance record. The provider key
lives only in the owner-only provider file. Do not print or commit it.

All operator configurations, plans and authorizations from earlier attempts are
used historical records. Never reuse them or replay unknown receipts. The first
handset call failed silently; the next attempt stopped at ElevenLabs readiness
before dialing. Preserve both histories. ElevenLabs was still unavailable during
this retest; the user expressly authorized the Deepgram fallback.

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
The original checkout and its untracked drafts remain untouched. Never modify
Apple Teams or sibling chert-facetime. Default new work to simulation/standby.
