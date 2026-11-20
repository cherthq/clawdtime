# Coding demo desktop panel

The native floating panel uses the existing independent task service. It can
submit a coding job, show worker and independent-check progress, answer a product
decision, request a scoped revision, accept a verified result, and separately
cancel a task. Worker-supplied answer choices fill the composer; **Send answer**
is still required. Closing or quitting the panel leaves the service running.

## Desktop appearance

The companion is one mascot on the desktop and one board that opens out of it. It
follows the Chert design system: cream paper in light mode and warm charcoal in
dark mode, Fraunces for the headline, Instrument Sans for the interface and
JetBrains Mono for times and paths. The three typefaces ship inside the app
under the SIL Open Font License.

The mascot is the Chert mark in three dimensions: a stone in the sunset strata of
the mark, the white ring in orbit around it, and a spark that rides the ring. It
is built in code, so it is sharp at every size. Its eyes follow the pointer and
blink. The spark is the status light: cream at rest, blue and fast while agents
work, amber when something waits for the person, red while the screen is shared.
A sheen crosses the stone on a click, as in the command-line intro.

- Click the mascot: it presses, springs back, and the board opens out of it.
  Click again or click anywhere else to close the board.
- Point at the mascot: two buttons appear. **Close** hides it; it stays in the
  menu bar. **Side** tucks it against the nearer screen edge, where it keeps
  watching. A drag that ends against the left or right edge also tucks it.
- A tucked mascot comes out further when something waits for the person. Click
  it to bring it back.
- When an agent or the task waits for the person and the board is closed, the
  mascot hops and a bubble says what waits. A click on the bubble opens that
  session's terminal, or the board when more than one thing waits.
- Drag the mascot anywhere. Its place is kept between starts.

The board's headline says the most urgent thing in words, for example "1 agent
needs you" or "All quiet". A task that waits for an answer comes before the
agents. The task field is one line at rest and opens when the person clicks it.

A small bar hangs under the mascot. At rest it holds two buttons: **Chat** opens
the chat screen beside the mascot, and **Talk** starts a spoken conversation. In
a conversation the bar opens with a spring into a microphone switch, the level
of the voice as moving bars, a speaker switch and an end button. While you talk
with the chat closed, the mascot's bubble shows what it heard and what it
answered. The board and the chat share the place beside the mascot, so one is
open at a time. See [Talk to ClawdTime](SUPERVISOR.md#talk-to-clawdtime).

**Stop sharing** and **Stop call** join that bar, sit as a bar at the top of
the board, and are items in every menu, whenever either can be stopped. A tucked
mascot comes out when a Stop control appears. They reflect the actual service
permissions. Closing or tucking does not stop sharing or a call, and nothing here
starts sharing. There is no new sharing toggle or permission change.

Motion uses springs: a press sinks in 90 ms and releases with a slight overshoot,
and the board is 95 percent open within 220 ms. macOS Reduce Motion removes
drift, hops, scaling and the sheen; states then change at once.

The app is an accessory: it has no Dock icon and never takes focus when it
starts or when the board opens. The board becomes the key window only when the
person clicks into a text field. Explicit Quit is in the menus and leaves the
task service running. This does not install a login item or a background daemon.

Task input, choices, revisions, checks, acceptance and separate cancellation use
the same service and durable receipts as before. Changing the appearance, moving,
tucking or closing the mascot does not submit an action, cancel work or grant
screen access.

The user authorized step-e implementation while deferring remaining step-d
handset rehearsals. This is a local implementation checkpoint, not a completed
phone-acceptance gate. No call, line handoff, deployment, capture or permission
grant occurs when launching the standalone panel.

## Agent board

The panel lists every coding-agent session on this Mac above the task area:
Claude Code, Codex, pi and other command-line agents, with the ones that wait for
you first. A click on a row brings that session's terminal to the front. The
board only reads state. It sends nothing to a session, and it is separate from
the task, its receipts and the Stop controls. When a session waits for you, the
mascot's spark turns amber and its bubble names the session.

The task service keeps the board in a separate scanner process and serves it on
`GET /desktop/agents` to the private panel credential. `--agents false` turns
the board off. `--tucked true` opens the panel as the mascot without taking
focus. See the [agent board guide](AGENT_BOARD.md).

## Build and open

Requires Node 24+, the repository's installed dependencies, macOS 14+, Swift,
and the existing authenticated Codex CLI for real coding. No new provider key is
needed for the desktop UI.

```sh
cd mac
swift test
swift build --product ClawdTimeTaskPanel
cd ..
npm run task:desktop -- --state /absolute/private-state --project /absolute/project
```

This defaults to **simulation**, clearly labeled in the panel. Simulation tasks
remain queued; it does not invent worker progress or passing checks. State must
be owner-only and outside the selected project. The launcher creates a missing
state directory with mode 0700 and refuses an unsafe existing directory.

For a real scoped Codex worker, supply an explicit independent verification plan:

```sh
npm run task:desktop -- \
  --state /absolute/private-state \
  --project /absolute/project \
  --worker codex \
  --checks /absolute/private-checks/checks.json
```

The checks file and its parent must be owner-only (0600/0700), outside the worker
project. It is a JSON array of `{ "name": "...", "command": ["/absolute/tool", ...] }`
entries using the existing verification contract. Select meaningful assertions
and a build check. Native worker approvals remain declined; the panel cannot
grant additional worker permissions.

The default port is 13326; `--port NUMBER` selects another loopback port.
For an already-authorized session in the same task store, optional
`--session-file /absolute/private/session.json` attaches its existing `{token}`
capability instead of registering a local-only session. The file is private,
outside the worker project, and bound into the configuration fingerprint.
Authentication, selected project, execution permission and expiry are checked;
it neither changes pairing/permissions nor renews a session. Changing this
selection on an existing desktop binding is refused. Use this explicit mode
when preparing a future desktop-originated task for an already paired handset.

`--panel-binary /absolute/executable` selects a built panel. The optional
`bash mac/scripts/package-task-panel.sh` creates
`mac/build/ClawdTime Task Panel.app`, with a local ad-hoc signature. It is not an
installer or notarized distribution. Its executable accepts `--config PATH`;
opening an unconfigured bundle alone does not create a project or service.

Run the same launcher command to reopen. It authenticates the existing service,
compares the project, worker, verification fingerprint and owner identity, then
opens the panel. A same-configuration duplicate raises the existing window via
a local UI-only notification. The menu-bar item also offers **Show ClawdTime**.
**Quit panel** quits only the interface. No LaunchAgent is installed.

## Task behavior and recovery

There is one selected project and one current task. A decision belongs to the
current terminal run; an answer starts a new run on that same task. Acceptance
requires matching task/run/revision and independently passing checks. A worker's
summary never establishes verification. The panel labels missing connectivity,
expired authorization and unknown outcomes explicitly.

The private UI capability differs from session/operator credentials. Only the
three `/desktop` routes accept it. All requests are loopback-only; browser Origin
requests are rejected and redirects are refused. Private files remain outside
the worker project. Backend operation receipts are encrypted; native receipts
store only operation metadata and payload digests, not task text or tokens.

Every action reserves a stable operation identity before sending. Reopening,
connection loss and service restart reconcile that identity by **GET**. A missing
or unknown receipt is not permission to send again. Do not delete state, receipt
files or ownership locks to force a retry. An interrupted worker remains unknown
until its original outcome is reconciled; restarting the service does not replay
it. A 24-hour task-session expiry is not silently renewed by opening the panel.

The detached service intentionally outlives the UI. Operator shutdown is a
separate action: inspect the authenticated current task and exact service owner
first. Do not terminate an active/unknown worker or another owner's process.
Preserve all task and receipt files. Reopening the same state after confirmed
idle shutdown preserves desktop/task identity and checks the same configuration.

## Stop during a separately authorized handset attempt

The standalone local fixture has no phone binding, so **Stop sharing** and
**Stop call** are disabled. **Cancel task** is separate and asks for confirmation.
Cancellation remains requested until the worker's actual terminal outcome is
known; it does not claim an uncertain execution has stopped.

For a separately authorized call, the existing handset operator may opt into
`"desktopPanel": true` in its private configuration. It creates
`ATTEMPT_DIRECTORY/desktop-panel.json`; launch the native executable with
`--config` pointing there. This attaches to the operator's existing task,
session, engine, call and presentation receipts. It creates no second service,
new task session, call permission or capture grant. The attached panel is pinned
to that task and cannot submit a different job.

Stop controls target exactly that attempt: sharing Stop uses the owned
presentation cleanup path; call Stop uses the existing call monitor. Neither
cancels coding. They remain independent of pending task mutations and task
authorization expiry. Unknown Stop receipts are retained without automatic
repetition. Task actions retire before operator engine shutdown, while cleanup
remains available. During media cleanup, the display follows the durable call
receipt rather than mistaking the continuing worker for a connected call.

The persistent local desktop service and handset operator use the same exclusive
database owner lock. **Never run them concurrently against one state directory.**
A desktop-to-phone rehearsal needs an explicitly authorized task session,
prepared current views, a fresh call grant, and the usual exclusive-line checks.
The launcher defaults to a local-only
session; its explicit existing-session option can attach a previously authorized
paired session, but cannot upgrade a local session to phone access.
The desktop service now supports prepared decision and final-review calls in the
same process through opt-in `--calls-config PRIVATE_FILE`. It retains the same
task engine, session, desktop capability and owner lock throughout both calls;
no database handoff or panel replacement is needed. Startup is dormant. Each
call needs a fresh protected operator request bound to the selected task's exact
run/revision and prepared views. The panel displays readiness and owns Stop;
its capability cannot authorize calls. See [desktop call integration](CODING_DEMO_DESKTOP_CALLS.md)
for configuration, operator requests and the remaining physical gates.

## Validation boundaries

Automated tests cover API scoping, durable deduplication, stale revisions,
restart/unknown behavior, close-independent service lifetime, config binding,
expiry-safe cleanup, native response validation and UI state decisions. The local
qualification uses a disposable fixture and real Codex runs; its test/build and
rendered result are separate observations. Screens and audio remain transient.

Handset timing, interruption, sharing clearance and the three complete two-call
rehearsals remain physical acceptance work. Each call needs specific permission;
the desktop build does not reuse any historical call authorization.
