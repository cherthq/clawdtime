# Handset retest blocked by provider readiness before dialing

The first authorized audio-only handset call failed silently and was cleaned up.
The user then explicitly authorized one additional retest and another temporary
ClawdTime-only standby/restoration window. That retest stopped at provider readiness
**before any native dial submission**. No second handset call was placed.

ElevenLabs agent-readiness GETs timed out, including independent Python and Node
read-only checks with 12-second limits. The official status page also reported API
latency/errors. Preserve the undialed attempt and its receipts; do not revive its
expired operator plan. Resume only with the provider ready and the human currently
available under the same one-call scope. Do not call unattended after this window.
Steps d/e remain blocked by the c.1 physical audio gate.

## Latest retest attempt (no handset call)

- Fresh native identity, idle line, exclusive standby deployment and preserved
  settings were verified. Persistent inspector authority checks took 91–129ms;
  full native readiness checks took 640–681ms.
- The provider preflight failed after approximately four seconds, before native
  dialing or provider conversation startup. The media-prepare phase retained an
  unknown receipt, followed by confirmed local closure. There is no native-dial
  receipt or provider call ID. Do not rewrite the historical phase receipt.
- Independent read-only checks connected with verified TLS but received no agent
  response within 12 seconds. No retry of a mutation or handset call occurred.
- Protected receipts are in `retest-2/` within the qualification directory. Its
  `operator.json` and attempt directory are used records, not a reusable launcher.
- Latest restoration is confirmed: the live deployment is successful, the standby
  instance is removed, and every original configuration value is restored. Fresh
  runtime checks report live mode, traffic enabled, zero active calls and zero
  pending/unknown effects. All local test ports are closed and the owner lock is
  released. Recheck these facts before any later standby window.

## First handset attempt (historical result)

- The handset connected but heard no opening; the user reported that it hung up
  without saying anything.
- Native evidence: `audio:true, video:false`, `active` and `bridge_ready`, followed
  10 seconds later by ending; terminal detail `bridge_remote_audio_timeout`.
  The provider conversation never bound and no media activation receipt exists.
- Native cleanup and local media closure are confirmed. The end submission itself
  retained an unknown receipt; subsequent exact native `cleanup_complete` proves
  the call closed. Preserve both facts. No redial occurred.
- The hosted backend was restored successfully. Its complete configuration matches
  the pre-test snapshot, its existing source/deployment metadata is preserved, and
  runtime reports live mode, traffic enabled, zero active calls and zero pending or
  unknown backend effects. Standby and prior live instances are removed. The image
  was rebuilt by Railway during each settings redeployment; do not claim the image
  digest stayed unchanged.
- Local task/voice/media services exited and their owner lock was released. The
  authoritative task remains `review_ready` with its original fixture pairing and
  independently verified run history; it was never relabeled as a handset pairing.

## Diagnosis and changes

Prepared audio already emitted continuous silence. The native worker requires
non-silent audio within 10 seconds of connection. The old operator path opened
fresh SSH connections for each of two authorization checks before voice activation;
this is consistent with the timeout, but prior diagnostics cannot establish the
exact last admission failure.

The revised path opens one read-only inspector connection before calling, then
performs fresh exact ownership/pairing checks over bounded JSON-lines RPC. The
read-only hosted probe took 1.279 seconds to connect and 93/92/87 milliseconds per
request; all three correctly refused authority because the backend had already
returned to live mode. This was not another call or positive call-readiness test.

Activation now records bounded encrypted phase timings, refreshes exact native
connection evidence after authority checks, and refuses before effect submission
if admission takes over four seconds. Bounded Stop provenance and numeric audio
frame acceptance counters make future diagnosis possible without recordings,
transcripts, credentials or arbitrary error text. Counters prove SDK acceptance,
not handset audibility.

## Next live test

1. Confirm the provider has recovered and the human is currently available. The
   authorized additional call was not placed; preserve that one-call scope and
   the approved temporary ClawdTime-only standby/restoration procedure. Do not change Apple Teams or sibling
   chert-facetime, deploy demo source, enable screen capture, presentation or control.
2. Read current protected task readiness and exact paired destination; preserve all
   original task IDs/run IDs, receipts and the prior unsuccessful attempt.
3. Verify idle native ownership and zero conflicting work, journal the authorized
   standby change once, and establish the exact new standby deployment with every
   prior dispatcher removed. Keep current settings for exact restoration.
4. Prepare a **new** owner-only operator configuration, attempt directory and fresh
   authorization ID under the protected qualification directory. Do not reuse
   `handset-operator.json`, its expired plan, or its consumed authorization. Its
   old standby deployment ID is also intentionally invalid after restoration.
5. Bundle `scripts/task-native-inspect.ts` with the installed esbuild, externalizing
   `zod`, and run `npx tsx scripts/task-handset.ts PRIVATE_CONFIG`. Startup opens a
   read-only inspector and local controls; it does not prepare a room or dial.
   Open `http://127.0.0.1:13324` for Stop. The explicit stdin command `start` performs
   fresh preflight, silent preparation and the one call. `stop`, local Stop, handset
   hangup, voice end, expiry and failure all join cleanup; uncertain effects never
   replay. Keep the foreground owner alive until cleanup is reconciled.
6. Obtain physical observations for clear task opening, status discussion, deliberate
   interruption, 20 seconds of quiet and spoken hangup. Record machine and human
   evidence separately. Restore hosted settings only after exact native and local
   cleanup are proven.
7. Only after actual c.1 acceptance: required checks, commit/tag/push `step-c1-done`,
   then implement d and e. Current completed tags remain a, b and c.

Protected state: `/Users/garygao/.local/share/clawdtime-coding-demo-qualification`.
Only the lead handles it. Existing private records include exact standby/restore
intent and receipts, scoped transport configuration, the consumed attempt's task
call/voice records, native outcome and cleanup evidence, and the read-only RPC
probe. Do not copy their secrets or personal destination details into Git or logs.

Worktree: `/Users/garygao/clawdtime-coding-demo`, branch `demo/coding-flow`.
The original `/Users/garygao/clawdtime` checkout and its untracked drafts remain
untouched. See BUILD_LOG.md for exact checks and checkpoint commits.
