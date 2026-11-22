# Phone dispatch and desktop connection repair

November 22, 2026. Local-first repair based on `abbbff2`.

## Problem and evidence

An incoming call delivered voice and video, and a status question reached the
supervisor. Subsequent action requests received spoken acknowledgements without
corresponding supervisor dispatch or a coding-job launch receipt. The installed
phone configuration also named a desktop directory with no running service.

The caller-turn code allowed a model to finish a spoken answer without invoking
the supervisor. A presentation-only tool could also finish a compound request
without dispatching its computer-work portion. Prompts asked the model to behave
correctly, but the execution boundary did not enforce that handoff.

This involved merged source plus incomplete local configuration. The code history
contains contributions from multiple authors; the evidence does not establish a
single-author regression. Source tests and a status check did not qualify actions.

A local action test also reproduced a second routing defect: asking to start a
new Claude Code session in a separate terminal window was consumed as desktop
navigation. No coding session was launched. Session creation needs its own
structured destination before an app/window interpretation can consume it.

## Local patch

- Require a tool on each authenticated caller response. Reuse one reserved
  supervisor dispatch for all tools and continuations of that original request.
- Forward complete validated words, including compound requests. Presentation
  tools provide bounded factual metadata about what they already did.
- Keep greetings and proactive announcements outside caller authority. Refuse
  failed or incomplete transcription and preserve uncertain dispatch without retry.
- Bind the phone to one authenticated desktop service instance and one expiring
  call admission. A missing service never falls back to another supervisor.
- Scope native input to that call. Close, expiry, and shutdown stop only its own
  active request; unrelated local work and already-launched coding jobs remain.
- Check call liveness before delayed supervisor effects, not only before model
  inference. Preserve local Stop, native permissions, and unknown-outcome fences.
- Report a requested session launch as requested until an observed launch receipt
  exists. Diagnose desktop connection, task admission, and computer execution
  separately. Resolve the CLI entrypoint through its installed symlink.
- Classify new coding-session creation separately from bringing an existing app
  or window forward. Preserve the complete request and its constraints when
  launching the selected coding agent.

The local rollout pauses automatic updates and preserves the previous code and
protected state. It neither resets old tasks nor copies their data into Git.

## Upstream plan

Prepare two reviewable changes from the locally verified patch:

1. **Dispatch and call ownership.** Include voice binding, scoped desktop
   transport, native ownership, session routing, liveness guards, and regressions as
   one compatible change. Deploy the CLI, service, and voice frontend together;
   a partial upgrade must refuse unsupported phone admission.
2. **Setup and truthful readiness.** Include the desktop doctor, installed CLI
   entrypoint repair, accurate launch acknowledgements, and the setup-guide
   acceptance checklist. Explain which actions need the panel and which do not.

Review duplicates, concurrent requests, service replacement, lost replies,
transcription failure, interruptions, compound presentation requests, and shutdown.
Do not use guessed completion from files or a terminal-open return code.

Do not merge, publish a package, or resume automatic source updates merely because
local checks pass. Resume updates only after the deployed repair is represented
upstream and its installation is verified. Rollback restores code and configuration
selection; it never restores an older ledger over newer receipts.

## Validation record

The installed panel retains Accessibility and Screen Recording permission.
The desktop doctor confirms the selected service, model, active task session,
task admission, enabled computer worker, and no uncertain native result.

A local request through the authenticated phone bridge opened Messages. The
worker reported verified foreground activation, and an independent macOS query
also identified Messages as the foreground application. No message was sent.
A separate compound TextEdit smoke request reached the worker and waited for
input; closing its admission canceled it. That test does not qualify document
creation.

After the routing repair, the same Claude-session request produced one requested
receipt, one launched receipt, and a new live Claude process under that launcher.
This verifies session launch, not completion of work inside the session. The
call admission closed without stopping the independently launched coding job.

Final automated validation:

- `npm run check`: TypeScript, 6,333 tests across 158 files, and build passed.
- `npm --prefix line test`: 173 tests passed.
- Swift `TaskPanelCoreTests`: 252 tests passed; panel build and installed access
  probe passed. Desktop Space shortcuts remain unconfigured.
- Changed-file formatting and `git diff --check` passed.

The local branch is `fix-phone-dispatch`. The repaired desktop and phone host
use it; automatic updates remain paused to avoid replacing the local repair.
No upstream merge or package publication has been performed.

The handset must still verify transcription-to-action, compound presentation and
work, Stop, and hangup. Reading message contents and broader app workflows remain
unverified. Local bridge checks do not imply phone acceptance.
