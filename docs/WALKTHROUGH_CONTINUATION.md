# Completion walkthroughs and computer control

## What changed

A completed coding job can call with a checked result, share a selected Mac
display, and take spoken computer requests during that same call. The person can
ask it to click, type, navigate or search without opening another session.
Computer requests go to the existing native worker. They do not resume an idle
coding agent or start a new coding job.

The callback repairs also cover:

- English narration by default, unless the caller requests another language.
- Fresh capture of static screens. A temporary missing frame clears video
  without ending audio. A failed capture process is joined before replacement.
- Optional opening of an exact verified HTML result before screen sharing.
- Protected verification plans for individual launched runs.
- An explicit recovery operation for a refused review that never reserved a
  dial. It requires different verification evidence and confirmed cleanup.
- Bounded diagnostic codes for startup and cleanup, without saved speech,
  screen pixels, credentials or arbitrary worker output.
- Forwarding the configured line identity and API base to the desktop service
  so outbound texts use its selected line.

## Enable continuation

Use a protected proactive configuration outside the worker project. The desktop
must have a native computer worker and a `sharedDisplay` configuration with an
exact display identity. Prepared review windows and alert-only calls do not
enable computer control.

Register a new calling policy with explicit consent and
`allowComputerControl: true`. Include `phone_walkthrough` in its channels and
`selected-display` in its view scope. Retain the intended project, person,
device, expiry and remaining attempt budget. Retire the superseded project
policy so new jobs have one unambiguous policy to use. Existing enrollments
bound to a retired policy need a deliberate new enrollment.

Only a call about a result gets computer control: a job or a session that
finished. A call about a decision, a task review or a question of the computer
worker asks the caller its own question. It takes no computer input under any
policy, so a spoken yes there can only answer that question.

Policy identities and issued grants are immutable. Changing a configuration
field does not upgrade an existing policy or a running call. Install at an idle
boundary after call cleanup, then start a new authorized walkthrough.

The native worker still needs its normal macOS permissions and local Enable.
Do not bypass those checks to make a callback accept input.

## Completion and result preparation

Completion hooks must inherit the supervisor's `CLAWDTIME_CONFIG_HOME`. An
interactive coding process can remain open after completing its turn. Use its
exact hook receipt and checked result, not process exit or idle status alone.
The production hook correction is installation configuration, not an automatic
migration performed by these source changes.

`jobChecksByRunPath` points to a protected JSON object that maps launcher run
IDs to verification plans. Unlisted runs use the default `jobChecksPath` plan.
Changing a run's override changes its review identity; it cannot reuse a check
from the previous plan.

Optional `sharedDisplay.artifacts` entries contain `jobId`, source `runId`,
`resultDigest`, absolute HTML `path`, and file `sha256`. The source run ID can
differ from the launcher run ID used for verification plans. Bind each field
to the actual stored evidence.

Preparation checks the file inside the selected project and its digest, then
opens it before capture. It preserves an opening receipt and never repeats an
uncertain launch. This is explicit artifact selection, not automatic discovery
from result prose. An application launch acknowledgement does not prove that
the window is visible on the shared display.

## During the call

The `use_computer` voice tool forwards the original authenticated speech, with
no model-supplied replacement text. The current call grant, caller identity,
selected display owner and native worker lease must all agree before input.
Other local requests cannot acquire that screen through the walkthrough's
permission.

The tool waits up to 45 seconds for an observed result or a question. Longer
work may still be running when it replies. Acknowledgement alone is never
completion. Turn receipts prevent repeated input after delivery becomes
uncertain.

A new request while this call's own computer task runs does not start a second
task. The worker takes it as the caller's words for the running task: "no, the
other tab" or "open Messages instead" steers that task, as words in the chat
do (see "Words while a task runs" in [computer use](COMPUTER_USE.md)). The
reply says where the words went, for example "Got it. I take that into the
task that runs." It never says that something was done. Words from another
call or from the chat do not steer this call's task: they get the busy reply.
The same rule holds on an ordinary call to the line.

A spoken yes or no answers only the newest question that this call told the
caller, as a plain yes in the chat answers only the newest question the owner
saw. When the computer task asks a question after the caller's last words, for
example after a reply that said the request was still running, the next reply
tells that question, and those words answer nothing. A question that comes
again after an answer is told again before a yes can answer it.

Stop cancels only computer work owned by that call and leaves video on.
Hiding sharing, ending the call, revoking permission or losing the call lease
also stops its computer work. Independent coding jobs keep their own lifecycle.
The configured call deadline still applies; continuation does not extend it.

## Verification and remaining limits

Production phone observations confirmed English audio, the correct existing
demo page, and both clicking and navigation during one walkthrough call without
a new session. The completed coding job was reused rather than rerun.

The TypeScript build, line JavaScript syntax checks and capture-helper build
passed. Local test suites were not run at the operator's request. Phone
acceptance covers the observed actions, not every application or long task.

Automatic artifact discovery, resuming an idle coding chat, automatic redial,
and extending call permissions are outside this change. Preserve journals,
turn receipts and uncertain outcomes when upgrading or rolling back.
