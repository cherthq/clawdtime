# Execution-disabled handset audio qualification

Source 0.3.1 adds a separate operator-only acoustic test. It is not an execution
session and cannot be upgraded into one. Deployment creates no call or session.
The deployed operator/controller reports ready; see STATUS.md for exact deployment
and software-test evidence. Physical handset acceptance remains outstanding.

## Authority and limits

A fresh explicit operator request creates one dedicated `audio-qualification`
session, attention request and call, all carrying the same immutable
`audioQualification:{version:1,executionDisabled:true,expiresAt}`. The maximum
lifetime is five minutes; the foreground controller requests three minutes.
Heartbeat cannot extend that deadline. Session heartbeat loss, Stop, policy loss,
expiry, mute or hangup ends authority. Duplicate requests reconcile the original
IDs and never supply a new credential or redial. Unknown outcomes block another
call until reconciled.

The operator admission flag `CLAWDTIME_AUDIO_QUALIFICATION_ENABLED` and media flag
`MEDIA_AUDIO_QUALIFICATION_ENABLED` default false. They enable only this specific
operator endpoint. Keep the normal conversation, executor, text-control, two-way
voice and `REMOTE_AUDIO_ISOLATED` gates unchanged/off. Policy truthfully reports
`remoteAudioIsolated:false`; it does not certify the acoustic route.

No jobs, approvals, transcript-to-command path, desktop input, screen selection,
caption capture, ordinary per-turn speech or broker is available. The separate
media frontend uses GPT-Live client delegation through the qualified OpenAI SDK
and LiveKit RTC, but discards delegation and transcript events. Input/output audio
is transient. The call publishes an inert video frame to satisfy transport readiness;
it never creates a desktop screen controller. A short once-only connection notice
precedes model startup to satisfy the existing worker's audible-startup deadline.

This version supports **one interruption measurement per call**. On detected human
interruption, local output and queues clear, and output stays muted until the call
ends. There is no automatic audio resume. GPT-Live output deltas have no reliable
turn-completion/flush acknowledgment here, and the external FaceTime worker has no
verified handset playback-flush acknowledgment. A local queue-clear timestamp is
not proof that the handset became quiet. An echo-triggered cutoff is a failed
acoustic observation, not permission to bypass the latch.

## Foreground controller and Stop

The lead prepares an owner-only JSON configuration containing `backendOrigin`,
`operatorToken` and the exact audited `pairingId`. Never paste it into chat or Git.
For the prepared configuration, the read-only command is:

```sh
npx tsx scripts/audio-qualification.ts --config .data/audio-test-operator.json --check
```

Only after Gary explicitly says he is ready for **one** call, run in a visible
foreground terminal:

```sh
npx tsx scripts/audio-qualification.ts --config .data/audio-test-operator.json --start --ready-for-one-call
```

Enter or Ctrl-C immediately submits Stop independently of any pending status
request. The phone's hangup is also available. This controller owns the local Stop
for this audio-only test; the Mac companion is not armed, and its screen-control
panel is not the audio-test controller. If the controller disappears, its heartbeat
expires in twenty seconds; media also enforces short policy freshness and the
absolute lifetime. Neither reconnect nor process restart resumes a stopped call.

The controller durably writes an intent before its single start request, retains
no raw session token in the intent, and never retries an ambiguous start/Stop.
Recovery may inspect the exact request through the authenticated operator status
route and submit a known request's idempotent Stop:

```sh
npx tsx scripts/audio-qualification.ts --config .data/audio-test-operator.json --stop ATTENTION_ID
```

Status must show `cleanupConfirmed:true`, not merely an ended call. Preserve unknown
transport effects and media cleanup. Do not create a new key/ID to retry an uncertain
call. A disconnected or failed call does not authorize an unattended redial.

## Handset procedure

1. Have the paired iPhone charged/reachable, the Mac awake and unlocked, and the
   foreground controller visible. Start with headphones; prepare a quiet room for
   a separately authorized speakerphone pass. No screen/control grants are needed.
2. Say you are ready for one call. Answer it and confirm whether the connection
   notice and model audio are intelligible. The model can discuss sound quality;
   instructions to run work must never execute anything.
3. During an audible model reply, interrupt once. Observe whether it becomes quiet,
   and measure the audible tail at the handset. Output then remains muted by design.
   Note echo, false interruptions and any assistant self-triggering. Hang up or Stop.
4. Reconcile zero active call/media ownership. Authorize another specific call only
   when ready for the other audio condition. Repeat controlled trials separately;
   one good greeting is not a latency percentile or production qualification.

Collect bounded metadata: versions/condition, startup and first-audio publication,
input/output counts, discarded delegation/transcript counts, detected onset, local
clear latency and playback generation, output latch, call termination and independently
observed handset audibility/cutoff. No raw audio, transcripts or screens are retained.
Targets remain p95 useful audible reply <=2 s and interruption quiet <=300 ms at the
handset. This mode enables measurement; it does not establish those targets or
unlock ordinary execution.

## Rollback

Stop admission, end the exact test and confirm native/media cleanup first. Preserve
all ledgers, cursors, stopped qualification sessions and unknown outcomes. Retain
0.3.1 with qualification disabled if cleanup is uncertain; older code cannot enforce
its new markers. Code rollback is allowed only after known quiescence, with both
qualification flags false, using the retained exact backend/media source archives.
Never restore an old database or reuse call approval as part of rollback.
