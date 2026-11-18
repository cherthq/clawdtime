# Prepared handset walkthrough operator path

The local three-scene walkthrough is human accepted: clear audio, useful labels
and highlights, and working visible Stop. The handset adapter is a separate,
offline-tested integration. One connected handset attempt received positive
visual feedback, but voice became unresponsive after a revision retired sharing.
A later connected review received positive preview feedback and explicit result
acceptance/hangup confirmation. Full handset polish, revision continuity and
remote Stop timing remain unqualified. The audio-only
`step-c1-done` test remains a separate completed gate.

## Scope and entry point

`npx tsx scripts/task-handset.ts /absolute/private/operator.json` uses the existing
single call coordinator, global ownership fence, native inspector and receipt
store. It starts in a ready state and requires the operator's `start` on stdin.
Startup does not dial, open a provider conversation or capture pixels. `stop`
requests joined call cleanup; it is never a redial command.

The default mode remains `handset_audio_smoke`. A walkthrough requires
`mode: "handset_walkthrough"` and this additional configuration:

```json
{
  "walkthrough": {
    "presentationFile": "/absolute/private/prepared-presentation.json",
    "helperBinary": "/absolute/worktree/mac/.build/debug/ClawdTimeTaskCapture",
    "checksFile": "/absolute/private/checks.json",
    "callDurationMs": 900000,
    "userAuthorizedPreparedWindowExport": true,
    "userAuthorizedTaskInstructions": true
  }
}
```

This is an illustrative fragment, not an authorization or complete runnable
configuration. The existing protected configuration also supplies task state,
session, provider and LiveKit files, exact destination and native line identity,
the read-only inspector bundle, standby deployment/restore evidence, and a fresh
one-call authorization identifier. See the strict schema in
[`src/control/task-handset-runtime.ts`](../src/control/task-handset-runtime.ts). Only the coordinating
lead handles these files, credentials or line operations.

Build the read-only inspector as a compact ESM bundle, with the deployed backend's
installed dependencies external. A dependency-inlined bundle can exceed the SSH
command transport's practical size even though it runs locally:

```sh
node_modules/.bin/esbuild scripts/task-native-inspect.ts --bundle --platform=node --format=esm --packages=external --minify --outfile=/absolute/private/native-inspector.mjs
chmod 600 /absolute/private/native-inspector.mjs /absolute/private/checks.json
```

Verify the inspector's exact `{ready:true,version:1}` read-only handshake before
starting the operator. The verification plan is also owner-only, even though it
contains no provider credential. These preparation checks do not dial.

`presentationFile` contains exactly `{manifest, grant}` using the current task
presentation schemas. The immutable manifest includes the task/run/revision,
verification, exact window/process/display identities, bounded camera regions,
and optional highlights/labels. Its first narration equals the task-specific
opening. The capture grant is still local-only; a separate explicit export grant
binds it to this one call. Used or expired manifests/grants must not be replayed.
The operator, provider, session, verification and attempt files must be private,
outside the coding worker's selected project. Each attempt directory is new.

Dispatch and activation have a five-minute maximum. The explicit call duration
may be thirty seconds to thirty minutes. The capture grant retains its own
shorter expiry; it cannot be silently renewed by the call. Prepare fresh grants
only when the approved live window is ready.

## Admission and cleanup

Before dialing, the operator checks exact pairing/view authority and an idle,
exclusively owned standby line. Native readiness must prove the exact worker's
audio/video protocol and current screen/video-resource checks. Media then
inspects the exact prepared windows and publishes a fresh rendered frame into the
private room. Native dialing remains blocked until that frame has an SDK
acceptance receipt. The connected provider uses the same voice for the prepared
opening, questions, scene explanations and instructions.

The loopback task API admits only this voice session and the prepared
presentation's read-only authority endpoint. It cannot create arbitrary tasks,
start another task, register sessions or expose generic task commands. Spoken
changes are finalized-utterance receipts, creating one scoped run or a held
correction. A held correction can apply after hangup when the prior run has a
known terminal outcome and independent verification. Explicit acceptance requires
a fresh review call bound to the current verified result.

The local page at `http://127.0.0.1:13324` has separate **Stop sharing** and
**Stop call** controls. Sharing Stop joins capture and switches to blank-only
video, while conversation and coding continue. A new task run also retires the
old presentation. The source cannot restart within that attempt. Call cleanup
ends voice and joins media/native cleanup, but keeps the task service alive until
admitted coding and verification settle. Task cancellation is a separate action.
Unknown outcomes retain their receipts and ownership fence; never delete state
or retry a call to make progress.

## Next physical test

After a passing checkpoint, obtain fresh specific authorization for one visual
call to the paired handset and, if still required, one ClawdTime-backend-only
standby/restore window. Previous voice-only authorizations do not cover this.
Apple Teams and sibling chert-facetime remain untouched.

Prepare current app-preview, source and concise verification windows, then
revalidate them in the visible desktop. Test the task-specific opening, prepared
scene requests and labels, a scoped spoken revision, responsive status during
the run, Stop sharing while voice continues, and explicit hangup. Confirm native
and local cleanup and restore the original backend settings. If the task keeps
running, let its owned service finish verification before closing it. A later
final-review call requires a fresh prepared result and separate authorization.

SDK receipts do not prove remote visibility, audibility or clearance. Record the
human observations separately. Full step d still requires the plan's three
two-call rehearsals, twenty interruption/zoom trials and measured timing targets.
Do not tag step d complete until its acceptance gate passes. The user explicitly
authorized step-e desktop implementation while deferring these physical gates;
that implementation does not replace the remaining handset qualification.
