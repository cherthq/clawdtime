# Phone requests to the local computer runtime

The optional phone bridge sends a caller's exact computer task directly to
ClawdTime's installed native bundled runtime. It does not create a terminal
session or depend on Agent-S. The voice agent uses OpenAI Realtime; the
separate computer planner uses the model in the protected bundled-CUA config.

## Local installation

Use the existing desktop service's protected state and native helper. Do not
copy its databases, keys, permissions or action receipts into a source checkout.
Build and install updated code while the phone and desktop runtime are idle.
Retain the previous code artifact for rollback; never roll back state/receipts.

In the desktop service's owner-only state directory, create `line-runtime.json`
with `{ "version": 1, "token": "a-new-separate-random-capability" }` (0600).
It is accepted only with a native bundled runtime, not a legacy desktop adapter.
In an owner-only directory outside the checkout, create a separate client file
with `{ "version": 1, "origin": "http://127.0.0.1:13346", "token": "the-same-capability" }`
(0600). Set `CLAWDTIME_LINE_RUNTIME_CONFIG` to its absolute path in the private
line environment. Never use the desktop panel or operator credential here.
Restart the desktop service and the line agent when idle.

Keep the Chert project's joined-phone list limited to the intended user.
Configured mode binds authority to the ready Chert room metadata and the exact
matching bridge participant. A new authenticated local call lease is opened;
only that call may submit, inspect or stop its own computer work. The native
helper still requires its local Enable, Screen Recording, Accessibility,
exclusive lease, fresh target validation and local Stop. The phone cannot arm it.
After enabling, close the helper's setup window or keep it away from the target
app. Its own control windows deliberately block input at overlapping positions;
Stop remains available from its menu-bar control.

## Execution and recovery

`POST /line/command` uses its separate bearer credential and JSON operations
`open`, `execute`, `status`, `stop`, and `close`. Browser origins are rejected.
Execution IDs derive from the call identity and stable LiveKit tool-call ID.
Receipts are encrypted and reserved before dispatch. Duplicate requests return
their original state; conflicting text is rejected. The client never falls back
to terminal jobs when configured control is unavailable. Status renews a
30-second lease; hangup, revocation, restart or missing heartbeats closes it.
Only computer work owned by that call is stopped. Unknown input outcomes remain
unresolved and are never automatically replayed.

Phone `computer_status` reads progress; `stop_computer_work` stops owned work.
The call announces completed, blocked, canceled, pending-approval and uncertain
states. Merely submitting input never proves success. Screens are transient and
shared only on request. Results and on-screen text are data, not authority.

Legacy terminal jobs now distinguish launch requested, launch observed,
exited without result, launch failed, and unknown legacy progress. Missing a
result does not prove work is running. `clawdtime jobs retire ID --reason TEXT`
preserves an unresolved record and does not terminate its process. Verify and
stop an exact process separately before retiring it; never repeat an old send
request to find out whether it happened.

## Limits and acceptance

The native planner uses bounded click/type/scroll/window activation on observed
controls in allowed existing apps. It has no general shell or keyboard-shortcut
tool. Reading email requires a supported, already signed-in app and usable
screen controls; a connected Gmail plugin in a separate coding chat is not
inherited. Current planner policy pauses before sending communications, login,
credentials, uploads/downloads, purchases, deletions and account changes.
Sending email/messages needs a separate exact-recipient/content approval path;
this bridge does not enable it.

Local qualification on 2026-11-21 exercised the installed phone client, bridge,
native planner and helper against a disposable rich-text TextEdit document. It
entered the requested sentence, independently observed the exact text, and
released its lease with no unresolved native actions. TextEdit compatibility
includes its structural ruler/color/alignment controls and a narrowly scoped
unavailable-description case; focus/content/selection/geometry checks remain
required. This does not qualify browser or Mail workflows or the updated
FaceTime audio path.

Run root `npm run check` and `npm test --prefix line`. Before a real call, verify
the native helper is enabled and idle, then exercise a disposable local UI task,
observe its result, and verify hangup/Stop release control. Tests do not establish
physical FaceTime acceptance. Keep per-install test evidence and secrets outside
the repository. A safe first call asks to show the screen, operate a disposable
test window, and report its observed result.
