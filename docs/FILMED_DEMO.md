# Short filmed demo: one headline decision

Use the same Mac and Codex desktop surface as the successful native-control test.
The existing project pairing, companion 0.2.1 and gateway are already installed.
Use a new coding chat in this checkout and a fresh foreground call run. Do not
repeat installation, migration or old call approvals. This document itself does
not authorize a call; the user pasting the prompt below authorizes one new demo.

## Before recording

- Open the ClawdTime Control Panel. Both permissions should show Granted, the
  intended display should be online, and policy should be **Agent tools only**.
  Click **Enable locally** if needed. Enable is not a call by itself.
- Use only a simple disposable draft on screen. Close or hide private material
  before sharing. Keep the paired phone ready to answer FaceTime.
- Confirm the new chat has the native computer tool. The Codex app itself is
  blocked by that tool; TextEdit is the demo target. Fallback is not used.
- Start recording before submitting the prompt. Answer the call, say “Hi,” then
  choose “Use the first one.” After seeing the edit, say “Looks good, end the demo.”

Aim for roughly 45–60 seconds connected. This is a short decision-and-edit demo,
not a stability, reconnect, fallback or native-cancellation qualification. Previous
calls do not guarantee the next recording: readiness and native tools must pass;
a screen relay timeout was observed near the last intentional hangup. Do not
stage a successful result or redial automatically if something fails.

## Paste into the new chat

```text
Work in /Users/garygao/clawdtime. Use the installed ClawdTime skill in this exact
chat. This is a short filmed demo, using our existing pairing and installed app.
I authorize ONE outbound call to my paired handset for this demo and native
editing of the disposable TextEdit draft below.

Draft a tiny ClawdTime launch note in a uniquely named new scratch file under artifacts/demo/:
one placeholder headline and two short sentences. Open it in TextEdit using your
native computer tool. Do not modify the product or send anyone a message.

Work briefly, then stop at this real preference question: should the headline be
“Your agent can FaceTime you” or “Your work comes with you”?

Before dialing, show exactly this visible chat line:
Using ClawdTime skill

Check readiness and the actual native tool/shared display before registering a
fresh v2 call run with desktop capability. Do not reuse an old run or switch
agents. If sharing is off, ask me to click Enable locally; don't enable it yourself.
Use the same-chat foreground bridge if needed, following the installed skill.

Call once. When I answer and say hi, ask only the headline question. After my
choice, acquire native input ownership, edit the headline in TextEdit with your
normal computer tool, verify it visibly, release ownership, and say “Done—how
does that look?” Keep replies short and let speech finish before replying again.

Keep polling in this same chat while I watch. When I say “end the demo,” or after
about one minute connected, end the call and verify cleanup. If any step fails,
report it honestly and do not redial. No deployment, reinstall, fallback control,
third-party message, or extra call is authorized by this prompt.
```

## Operator details

Use the existing local `dist/cli/main.js setup-session` from this project. Choose
a new stable run ID for this chat and pass `--native-control desktop
--shared-surface true --native-cancellation false` only after verifying the actual
tool/display. Check `status.session.capabilities` before `invite` → `authorize`
with the exact returned test ID → `start`. Keep stdin/heartbeat alive.

The foreground bridge is the v2 tool transport; it does not create another agent.
Do not use legacy global yield/resume. Process voice fragments in order; combine
adjacent fragments into the user's one instruction without performing it twice.
For input use `execution_status`, epoch-checked `transfer_execution` to native,
the ordinary native tool, post-action observation and release to none. Read reply
receipts before another speech request; never replay an unknown outcome.

After ending, reconcile call/media/lease/executor state, then close the bridge.
Save only sanitized acceptance metadata, never screen/audio or a transcript.
The demo proves only what the human and agent actually observed.
