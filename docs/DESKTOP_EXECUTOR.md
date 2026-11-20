# Desktop chat to computer execution

November 20, 2026. This is an opt-in connection to one existing Codex chat,
not a new autonomous computer-use worker.

The supervisor now hands the person's exact computer request to a pinned Codex
chat. That chat uses its existing browser/desktop tools and native approval
policy, observes the result, and returns a receipt and concise answer to the
desktop chat. The scoped coding worker remains unchanged. An email integration
is not required when that connected chat can use the user's signed-in browser;
the connection alone does not establish mailbox access or authorize sending mail.

## What was demonstrated

The real supervisor model selected delegation for a disposable local browser
task. The exact original chat claimed it, opened the local fixture with its native
Chrome tool, entered a note, clicked Save note, and observed the saved confirmation.
The completion receipt and answer appeared in the service's desktop transcript.
No personal mail, external messages, phone calls or production deployment were
part of that test.

**Automatic wake did not pass.** The installed Codex CLI's `queue --resume`
reported uncertain delivery/resumption; its expected local daemon socket was
absent. The test used explicit polling from the already-active original chat.
Do not label queue success, a configured connection, or this active-chat test as
unattended execution. A stopped/closed host chat may leave work waiting.

## Protocol and configuration

The local task service reads optional `desktop-executor.json` from its private
state directory at startup. It must be owner-only, outside the worker project,
and contain version 1, the exact `threadId`, a separate random `token`, the
absolute installed Codex `binary`, the absolute built `clientPath`, and the
service's exact loopback `origin`. Never commit this file or print its token.
The feature is absent by default and cannot be enabled alongside phone or
presentation actors in this service. Configuration changes require a deliberate
idle service restart, not a silent session upgrade.

1. The supervisor reserves an encrypted request before attempting one opaque
   `codex queue --thread … --resume` notice. No task text or credentials are in
   that command. There is no automatic enqueue retry.
2. The selected chat uses `desktop-executor-client.js --config PRIVATE_FILE inbox`
   to discover opaque pending IDs, then `claim ID` exactly once. Its
   `CODEX_THREAD_ID` must match the configured chat; an independent executor
   bearer authenticates the HTTP request.
3. `check ID` must return `canAct:true` immediately before and after each native
   action. The request expires after 15 minutes. Existing native policy remains
   authoritative. This bridge grants no call, shared-screen input, deployment,
   login or blanket approval. Shared-screen input still needs its separately
   authorized execution lease.
4. Observe the actual result before reporting `finish ID completed`. Supply
   `{ "summary": "concise result", "observed": true }` as JSON on stdin, never
   as a process argument. Other finish states are blocked, canceled and uncertain.
   Do not retain screenshots, audio or raw page content in result summaries.
5. The pinned **Stop work** button uses the panel credential, independently of
   the executor credential and of pending chat/voice replies. Stop is cooperative:
   an already-submitted native action may finish. Stop prevents the next action,
   never fabricates physical interruption, and keeps unresolved input fenced.
6. Unknown outcomes survive restart and block new work. `reconcile ID
completed|canceled` accepts an observed, read-only reconciliation via the
   same stdin JSON. It never authorizes new input or repeats the old action.
   The original uncertain receipt and message are retained.

HTTP routes reject browser origins. `/executor/command` accepts only the executor
credential and exact chat identity. `/desktop/execution/stop` accepts only the
panel credential. A queue receipt is not a claim; a claim is not verified success.
If notification fails after a result was persisted, the status still holds the
result; do not replay the task to recover a chat bubble.

The helper is a cooperative agent protocol, not a sandbox for malicious code
running as the same OS user. Other independent computer actors still need to be
stopped or coordinated before native input. It cannot guarantee hard cancellation
of host tools that do not expose it.

## Product decision

**Recommendation: bundle a persistent execution runtime into ClawdTime, while
keeping external-agent connections optional.** The product promise is that work
continues without an existing Codex chat staying active. The observed wake gap
makes a chat connection a useful adapter, but an insufficient foundation for that
promise.

| Path                          | Strength                                                                     | Current limitation                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Existing native chat          | Reuses capable tools, login and native approvals; quickest supervised bridge | Depends on that host's lifecycle and supported wake/tool attachment                                                   |
| App-owned browser executor    | Deterministic tab identity, bounded operations and observable results        | Needs an explicit supported browser connection and account/session setup                                              |
| App-owned general desktop CUA | Reaches native apps and can continue independently                           | Requires packaged capture/input authority, permissions, fresh observations, Stop, recovery and physical qualification |

Use APIs/CLI where they fit, a browser adapter for websites, and desktop CUA for
apps that need it. Bundle the execution lifecycle and permission controls; keep
the model/planner replaceable. Agent-S is a candidate to evaluate, not a runtime
already installed or qualified by this change.

The next milestone is one app-owned worker completing a disposable browser and
native-app task after the originating chat closes, with verified Stop, restart
recovery and no blind replay. Then qualify a read-only signed-in inbox task.
Phone capture and continuous-sharing acceptance remain separate existing gates.
