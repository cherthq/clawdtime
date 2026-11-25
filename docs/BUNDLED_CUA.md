# App-owned computer runtime

ClawdTime can run bounded computer tasks in its own task service without a Codex
chat, queue, daemon or MCP connection. This is an opt-in internal runtime, not a
general-purpose production desktop agent. External coding agents remain optional
adapters. This implementation uses a replaceable Responses API planner and the
existing Mac companion; it does not bundle Agent-S.

## What runs

The desktop supervisor submits the user's task to an encrypted task ledger. A
task owns one browser or local Mac lease. The runtime observes, asks the model for
one click/type/scroll/existing-window activation plan, checks permission and fresh target identity, reserves
an action receipt, submits once, and observes again. A separate model verification
on a fresh observation must confirm the goal before completion. Receipt submission
alone never proves success. Limits are 30 actions and 15 minutes at most; defaults
are 20 actions and five minutes.

The browser adapter launches an isolated bundled Chromium context. It does not
attach to Chrome, import cookies, use a personal profile or inherit browser login.
Origins must be configured explicitly. Network requests are limited to GET/HEAD
on those origins; redirects are checked, while popups, dialogs, downloads,
file choosers, service workers and WebSockets are refused. GET is not inherently
effect-free: the origin allowlist must contain trusted task surfaces. By default, input
requires an exact action approval except explicitly configured disposable loopback
fixture grants; the operator can explicitly select automatic mode below. Sensitive input targets are refused. This release cannot log into
email or freely operate arbitrary websites.

The native adapter uses the companion's separate local-task lease API. It needs
an allowlisted executor/display, local Enable, Screen Recording, Accessibility,
and exclusive ownership. It shares the existing ownership slot with call control
and cannot take over a live call. Each action requires approval by default. Captures exclude
known ClawdTime control windows; input into or through those windows is refused
to prevent the agent approving its own actions. Native permission prompts, login
and arbitrary terminal execution are not automated. The native core flow has passed the bounded two-app qualification described below. Native approvals now use a
non-key window so reviewing an action does not steal the target’s keyboard focus.
Known refusals before input are recorded as rejected; effects with an unknown
outcome remain fenced and are never replayed.

## Protected configuration

Build with Node 24 or newer, `npm ci`, `npm run build`, and
`npm run cua:install-browser`. Create an owner-only state directory outside the
selected project. Put an owner-only `bundled-cua.json` file there:

```json
{
  "version": 1,
  "mode": "browser",
  "model": "gpt-4.1-mini",
  "maxSteps": 20,
  "timeoutMs": 300000,
  "browser": {
    "startUrl": "http://127.0.0.1:8767",
    "allowedOrigins": ["http://127.0.0.1:8767"],
    "headless": false,
    "fixtureGrants": []
  }
}
```

The URL is an example: start and inspect the intended local site first. Supply the
API key from a protected launcher as `CLAWDTIME_OPENAI_API_KEY`; do not put it in
arguments, repository files or logs. The example model was used for qualification,
not selected as a universal quality recommendation. Screens are sent transiently
to the configured model provider; they are not written to ClawdTime's task ledger.
Provider retention policies are separate from local storage.

Start `npm run task:desktop -- --state PRIVATE_STATE --project PROJECT
--port UNUSED_PORT --panel-binary ABSOLUTE_PANEL_EXECUTABLE`. The normal desktop
panel must be built first as documented in [the Mac guide](../mac/README.md).
The agent board must be enabled. `desktop-executor.json` and standalone local
presentation actors cannot coexist with bundled execution in this service.
Prepared phone review can share this service through the explicit ownership
handoff in [the review lifecycle guide](TASK_REVIEW_LIFECYCLE.md): local work and
capture must finish before phone preparation, and uncertain cleanup blocks reuse.
Combined native mode requires the updated helper's capture-drain capability;
an older installed helper is refused. Preserve an existing installation's configuration and receipts before
planning a migration; do not overwrite them or switch an active owner.

For native mode, replace `browser` with `native` containing `origin` (exact
`http://127.0.0.1:PORT`), protected helper `token`, `deviceId`, `executorId` and
numeric `displayId`. The helper's `localExecutors` allowlist must match. Optional
`allowedApplications` contains up to 20 exact bundle IDs whose existing standard
windows can be brought forward. Empty or omitted disables window activation. It
does not grant input approval or permission to launch apps, unhide them, restore
minimized windows, operate permission controls, or run terminal commands. See
[local execution](../mac/README.md) for the helper's configuration and policy.
Native mode is an internal pilot with bounded physical acceptance on one Mac.

## Approval, Stop and recovery

An operator can set `"actionApproval": "automatic"` in the protected
`bundled-cua.json` and restart an idle service to omit ClawdTime's per-action
confirmation prompts. This is appropriate only when the operator deliberately
chooses automatic execution for the local workflow. Omitted or `"ask"` keeps
the existing approval behavior. The setting does not change adapter refusals,
configured apps/origins, macOS permissions, target freshness, Stop, result
verification or unknown-outcome fences. It does not approve another agent's
native permission requests or authorize a phone call or deployment. Changing it
does not replay an old task or resolve an unknown action.

In confirmation mode, a small window beside the mascot shows the pending action
with **Approve** and **No**, only while it waits. The panel shows no other status
of the work.
Approval binds one action ID, not the whole task or future actions. Changed
pixels require a fresh proof of the original exact native target; unsupported
image, web, or virtualized surfaces refuse this semantic proof. Focus, target
identity, policy or expired authority refuse dispatch even after approval. Window
activation always requires a one-use proof bound to the same observed existing
window, process lifetime, display, lease and action. App/window titles are
untrusted display text, never instructions. **Stop**, on the bar at the top of the screen during every run, is independent of chat and model inference. It
aborts planning, stops capture/input and closes the owned surface. Already
submitted effects may remain uncertain; Stop does not fabricate a rollback.

Tasks, bounded action descriptions and receipts are encrypted at rest. Do not
put credentials in task instructions. Screens and observation context stay in
memory. One task runs at a time. An interrupted task becomes uncertain after a
service restart and blocks new work. No action is automatically replayed. This
initial bundled runtime has no operator reconciliation API: preserve its state,
inspect the actual outcome read-only, and resolve it through a reviewed recovery
change before reusing that executor. Do not delete the ledger to bypass the fence.
The runtime is not a sandbox against malicious processes running as the same user.

## Packaging and qualification

`npm run cua:package` creates `artifacts/ClawdTime-runtime` without installing or
launching it. The local artifact contains Node, compiled service/CLI, production
dependencies, pinned Chromium, local-control companion and panel apps.
The local helper has its own `com.clawdtime.local-control` identity and refuses
call/display configuration. It does not replace an existing call companion. Each
helper owns its own lease state: do not enable both for native input concurrently.
A new local helper identity can require its own macOS permission grants. The launcher pins the
bundled browser path. Configuration, credentials, profiles and user state are
excluded. Existing output directories are never overwritten. Native apps are
ad-hoc signed; this is not a notarized public installer. Use a protected launcher
and explicit state/project/panel settings for each installation.

`npm run cua:qualify -- MODEL` runs a paid-model test against a disposable localhost
fixture using only exact fixture grants. It launches a separate compiled service
with no Codex environment or chat queue. The fixture independently observes the
saved value, in addition to model verification. It retains only private result
metadata, not screens. Browser tests also exercise targeting, networking, Stop
and cleanup; native tests use fake HTTP and Swift policy/transport tests.

November 20 qualification with `gpt-4.1-mini` completed the isolated note/save
task and independently observed the exact saved value. The packaged Node/Chromium
artifact repeated that pass with a system-only PATH; its compiled CLI passed an
isolated startup/readiness check with a no-UI panel and confirmed cleanup. At that stage,
validation passed 1,630 TypeScript tests and 158 Swift tests. An earlier run proposed an
action outside its exact fixture grants and stopped for approval; the grants
were not broadened. Visible-control grounding was improved before the successful
run. That initial browser-only stage performed no personal inbox access, native
desktop input, call, deployment or installed-runtime migration. Broader native
application acceptance, authenticated account setup,
operator recovery UX, distribution signing/notarization and clean-install testing
remain production gates. Phone continuous-sharing qualification is separate.

The intermediate native follow-up passed 1,681 TypeScript tests and 175 Swift
tests. Independent reviewers covered the target/window proofs, preserved native
preflight guards, local-only helper identity and competing-helper refusal. The
physical gate at that stage was a two-app activation/type/save/Stop test; automated
success alone does not qualify desktop input or installation.

The first physical attempt stopped before native input because the fixture apps
had no Launch Services timestamp and exposed an empty AXWindows list. Native
witnesses now use a real kernel process-start tuple when necessary, and combine
actual AXWindows/MainWindow/FocusedWindow references with bounded type/PID checks.
A read-only probe of the exact source finds and revalidates both fixtures. Local
Stop was observed; activation/type/save acceptance had not yet passed.

The next native attempt surfaced both windows and independently exercised Stop
while an action awaited approval, but the small planner model repeatedly switched
windows instead of completing the task. The planner now consumes the actual
`context.targets.targets` catalog, prioritizes unfinished visible controls, and
pauses repeated activation-only loops. Optional `reasoningEffort` is forwarded
explicitly; omitted preserves provider defaults.

`npm run cua:qualify-native-planner -- MODEL [none]` runs a paid-model planning
check with two synthetic native-looking windows in isolated headless Chromium.
It performs no Mac input and captures no personal screen. It enforces exact
fixture effects, checks both saved values independently, then requests separate
model verification. GPT-4.1 mini failed this check at a typing action;
`gpt-6.1-terra` with `reasoningEffort: "none"` passed in five actions and 17.8
seconds. This matches its documented visual/computer-use role, but establishes
only this fixture result, not general reliability or native physical acceptance.
See [the official model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-terra).

### Native physical acceptance and local installation

On November 20 the packaged runtime, using GPT-6.1 Terra and explicit reasoning
effort none, activated Alpha, typed `alpha ready`, clicked Save, activated Beta,
typed `beta ready`, and clicked Save. The runtime separately verified completion;
the coordinator observed both native result labels and independently read the two
synthetic saved-value files. A subsequent pending-action Stop left both values
unchanged and added zero native action receipts. This proves the bounded two-app
flow; it does not establish arbitrary application, login or account workflows.

The successful run used exact disposable-fixture decisions through the normal
authenticated operator approval endpoint. Human approval buttons were exercised
in earlier activation attempts. A delayed human decision was safely refused when
the original observation expired; improve that UX without weakening fresh-target
checks. No personal app was modified, and no phone call or deployment occurred.

The authorized local installation preserves the existing project, worker checks,
hooks, protected credentials, history and encrypted receipts. The attached-chat
executor configuration was moved to a private rollback directory, and the
standalone config now selects native mode. The versioned artifact supplies Node,
compiled service and local helper. Installed readiness confirms both macOS
permissions, local Enable, idle ownership and zero unresolved actions. Reopening
reattaches to the same service. The original call companion is untouched and
stopped while local control runs; do not start competing native owners.

The launcher resolves its version symlink before starting compiled JavaScript.
The CLI also recognizes real-path-equivalent entry points, with a subprocess
regression for a symlinked installation root. Screens remain transient; acceptance
metadata and rollback paths are private installation records, not tracked user
data. The generic package manifest does not certify another Mac's physical setup.

Final source validation passes 1,694 TypeScript tests and 175 Swift tests.
