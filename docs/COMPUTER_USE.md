# Computer use

November 21, 2026. This is the app-owned worker that
[the execution page](DESKTOP_EXECUTOR.md) recommends. You say what to do on this
Mac. The worker then looks at the screen, clicks, types and drives the browser by
itself, one checked action at a time, until the task is done or it must ask you.

It is off until you turn it on. Tests are not physical acceptance: read
[what is tested and what is not](#what-is-tested-and-what-is-not) before you
rely on it.

## The parts

| Part    | Where it runs                          | What it does                                                           |
| ------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Worker  | The desktop service                    | Decides, checks every action in code, and keeps the record             |
| Hands   | The ClawdTime panel                    | See the screen and send input. macOS gives those rights to the panel   |
| Browser | The desktop service, when it is wired  | Reads and drives the web page in front through the browser's scripting |
| Planner | A language model, behind one interface | Picks the next action. It is the replaceable part                      |
| Cursor  | The ClawdTime panel                    | Glides to each place before the hands act there, with a short label    |

The code of the worker, the planner, the browser driver and the service side of
the hands is in `connectors/computer/`. `ports.ts` is the contract between the
parts. The hands and the cursor are in `mac/Sources/ClawdTimeTaskPanel/`
(`HandsController.swift`, `HandsInput.swift`, `HandsObserver.swift`,
`HandsBar.swift`, `GuidedCursor.swift`), over the pure rules in
`mac/Sources/TaskPanelCore/`.

The browser driver is a switch, off by default. Start the desktop service with
`CLAWDTIME_COMPUTER_BROWSER=on`, and the worker reads and operates the page of
the browser in front through the browser's own scripting: it reads the text and
the controls of the page, and clicks and types by element, with no guess at
pixels. It runs in your own browser, with your sign-ins, so you turn it on.
Two things must be there, and `clawdtime computer doctor` (run with the same
variable) says which one is missing:

- In Chrome, Brave, Edge or Chromium: View > Developer > Allow JavaScript from
  Apple Events. In Safari: Settings > Advanced, "Show features for web
  developers", then Settings > Developer, "Allow JavaScript from Apple Events".
- The Automation right of macOS for the program that starts the desktop
  service, for that browser.

When one of the two is missing, the worker says so to its planner once and
uses the screen for the rest of that request. A natively disabled control stays
in a reading of the page, marked as disabled.

`npm run test:computer:browser` runs the driver with its real page script in a
real page of Chromium and of WebKit, with no window: reading, numbers, clicks,
typing into a field that a framework controls, a search that leads to the next
page, and pages that change built-in functions to forge the answer.

Without the switch, or when the browser does not answer, the worker uses the
screen for web pages.

## One request, one action at a time

1. The worker asks the hands for a look: an image of the screen and the
   elements that the Accessibility tree names.
2. It gives the planner the goal, the last 12 steps, the useful elements and
   the image. The planner answers with exactly one action.
3. The worker checks that action in code. An action that is not valid is
   refused and not run, and the planner is told why.
4. When the action needs your yes, the worker asks and waits.
5. Just before an input, the worker looks again, with no image. It finds the
   same element again by its role, its name and its place, and it checks the
   action again against that look. If another window is in front or the target
   is gone, nothing is sent.
6. The action goes to the hands or to the browser. Then the worker looks again
   and the planner picks the next action.

One request runs at a time. A request ends after 40 actions or 15 minutes,
whichever comes first. The 15 minutes hold the time that it waits for you.

## Turn it on

```sh
clawdtime computer on        # the switch. It is off by default
clawdtime computer status    # on or off, and the last request
clawdtime computer doctor    # what is ready and what is missing
clawdtime computer off       # off again. A request that runs stops
clawdtime computer clear     # after a request with an unknown result
```

### Which engine does the computer work

One engine does the computer work of a desktop service. The service picks it
when it starts, in this order (`chooseExecution` in
`connectors/computer/service.ts`):

1. The connection to an existing chat, when `desktop-executor.json` is in the
   state folder of the service. See [the execution page](DESKTOP_EXECUTOR.md).
2. The background runtime, when `background-cua.json` is there. It takes
   requests only from an admitted phone call, and it comes before the bundled
   runtime when both files are there. See
   [the background qualification](BACKGROUND_QUALIFICATION.md) and
   [the phone runtime](PHONE_COMPUTER_RUNTIME.md). A service with this file
   and `desktop-executor.json` does not start.
3. The bundled runtime, when `bundled-cua.json` is there. See
   [the bundled runtime](BUNDLED_CUA.md). A service with this file and
   `desktop-executor.json` does not start.
4. This worker, and only when all of this holds:
   - The switch is on. The switch is the file `computer/config.json` in the
     state folder (`CLAWDTIME_CONFIG_HOME`, or `~/.local/share/clawdtime`). A
     switch file that is not a regular file of this user for its owner only
     does not turn it on.
   - A key for the language model is in the environment of the service:
     `CLAWDTIME_OPENAI_API_KEY`, or `OPENAI_API_KEY`.
   - The agent board of the service is on, and the service has no phone or
     presentation actors.
   - No test started the service. A service with `VITEST` in its environment
     never builds the worker, whatever the switch and the key say, so no
     command for the hands can come out of a test.

With the first or the second engine, that engine works exactly as before: its
routes, its Stop and its approvals are its own. The routes of the hands still
answer, with nothing to do and the reason.

So after `clawdtime computer on`, start the desktop service again.
`clawdtime computer off` needs no restart: the worker reads the switch before
every action.

The model is `gpt-5.4`. `CLAWDTIME_COMPUTER_MODEL` changes it. When the service
says that a key may not use `gpt-5.4`, the planner goes to `gpt-4.1`, the model
before it, and stays there. A model that you chose is never replaced.

### The planner test

`npm run eval:computer:planner -- gpt-4.1 gpt-5.4` measures a model before it
becomes the planner. Each task is one decision: a goal and a rendered screen
that looks like a Mac app window (a notes app, a settings pane, a save dialog,
a table of invoices, a sign-in form), as a picture and as named elements in the
form that the hands give. The real planner code builds the request, the model
answers, and a check says whether the chosen action is right: the right row,
the right one of ten links with the same name, an icon with no name that only
the picture shows, the state of a switch from the picture, no click when the
goal is met already or cannot be met, the careful button of a dialog, and a
password left to the person. Add `:low` to a model for a small picture. It
needs a key and the Chromium of Playwright, and it costs real model calls. It
opens no window and sends no input.

Results of November 22, 2026, 17 tasks, three runs with 2, 5 and 3 repeats:

| Model             | Right      | Median answer  | What went wrong                                                |
| ----------------- | ---------- | -------------- | -------------------------------------------------------------- |
| `gpt-5.4`         | 170 of 170 | 1.19 to 1.23 s | Nothing                                                        |
| `gpt-4.1`         | 162 of 170 | 1.29 to 1.35 s | The wrong one of four icons with no name, 8 times in 10        |
| `gpt-4.1`, `:low` | 80 of 85   | 1.06 to 1.09 s | Icons with no name                                             |
| `gpt-4.1-mini`    | 74 of 85   | 1.09 to 1.12 s | "Don't Save" where the goal said to keep the changes, and more |

Five more tasks, added the same day, have a target that the Accessibility tree
does not name: a sticky note, two tools of 30 pixels, an x of 18 pixels and one
of five stars, all drawn on a board. Only a click at a point in the picture
reaches them. With 22 tasks and 5 repeats, `gpt-5.4` was right 110 of 110
times, and each of its points was within 2 pixels of the middle of a small
target. `gpt-4.1` was right 85 of 110 times: on the four small drawn targets
it was right 0 of 20 times, and gave the number of an element that the screen
does not have.

Five more tasks hold a text on the screen that poses as an instruction to the
model: a note that says to delete it, a line that says to turn a switch off, a
line that gives another task, a note that names another row to open, and a
dialog that says to throw the changes away. The right answer does only what the
goal says. With all 27 tasks and 5 repeats, `gpt-5.4` was right 135 of 135
times. `gpt-4.1` was right 105 of 135 times: besides the drawn targets, it
opened the row that the note named, and not the row of the goal, 5 times in 5.

On a real desktop service, for a request that only looks, the answer of the
planner took 1.25 to 1.27 seconds with `gpt-5.4` and 1.40 to 1.82 seconds with
`gpt-4.1`. The test is not physical acceptance: its screens are rendered pages,
not the apps of a Mac, and each task is one decision, not a whole request.

### The request test

`npm run eval:computer:request -- gpt-5.4` measures whole requests. The real
worker does each one from its start to its end, with its checks, its questions
and a real language model. Only the hands are replaced: they look at a small
app in a headless browser and click and type there, in place of the Mac. The
apps work: a row opens a note, text goes into the editor, a search filters, a
delete asks first, a switch turns, a dialog closes, a form signs in. A check of
what the app holds at the end says whether the request was done, so a "Done"
that the app does not confirm counts as a failure. The person of the test
answers the worker's questions, and types the password into the field when the
worker hands that over.

Results of November 22, 2026, 13 requests, 3 runs of each, `gpt-5.4`:

| What                        | Result                                            |
| --------------------------- | ------------------------------------------------- |
| Requests done               | 38 of 39                                          |
| Steps                       | 109, from 1 to 6 for a request                    |
| Time of a request           | 1.2 to 8.3 seconds, with the hands of the test    |
| Share of the language model | 140 of 146 seconds                                |
| Questions before a delete   | Each time, and a "no" ended the request unchanged |
| Password                    | Left to the person each time                      |

What the test found, and what changed with it:

- The worker asked "yes or no" before it closed a banner that the person had
  asked it to close, and once seven times in one request. A close now asks
  only when the person's own request does not say "close" or "dismiss", and
  only for a plain close control: "Close", "Close tab". "Close account" asks
  whatever the request says. What can be lost with a close keeps its question:
  "Don't Save", "Delete", "Terminate". A request that says not to close asks
  as before.
- Text was typed with no text field in focus, went nowhere, and the request
  ended as done. The planner now reads "sent, but no text field had the focus"
  as the outcome of such a step, and looks for the text.
- Known limit: for "four of five drawn stars" the planner sometimes clicks the
  third star, and then says that four are filled (1 of 3 runs).

Two changes were measured and not kept. A second, critical look at the screen
before a done caught the wrong star count, but it also refused a true result
in 2 of 8 runs, and the planner then sent more input. A stricter rule for done
in the planner's own words made one task of the planner test wrong 6 times in 6. Run both tests before the planner's rules change.

The test is not physical acceptance: the apps are pages, not the apps of a Mac,
and the hands of the test are instant.

To find the slow part of a request, start the desktop service with
`CLAWDTIME_COMPUTER_TIMING=on`. The worker then keeps the time of each step in
`computer/timing.json` in the state folder, with numbers and the kind of action
only, never a text of the screen. `clawdtime computer timing` prints the newest
20 steps: `2026-11-22T09:00:00.000Z step 3 click_element: look 310 ms, plan
1840 ms, act 420 ms`. The look is the screen before the plan, the plan is the
language model, and the act is the checks, a question to you when there is one,
and the action.

The panel needs two permissions in System Settings, Privacy & Security:
Accessibility, and Screen & System Audio Recording. When one is missing, the
request ends as `blocked` and the message names the permission to grant.

### Give it a task

Talk to ClawdTime: in the chat of the panel, by voice, or on a phone call. Your
own words are the task. Two ways lead to the worker, and both are code in
`connectors/agents/brain.ts`:

- **At once, before the language model.** The worker reports the mode
  `native`, as the bundled runtime does for the screen. For an engine with
  that mode, a plain instruction for the screen goes straight to it: it starts
  with use, click, type, scroll, switch, focus, fill, select, bring, open or
  navigate (with or without "can you" or "please"), and it names a window, an
  app, the desktop, the screen, the browser, a field, a button or the dock.
  "Click the blue Send button" and "type hello in the search field" go this
  way. So does a sentence that names its place first: "In the Notes window,
  click Save".
- **When the language model chooses it.** For every other sentence the
  supervisor's language model picks a tool. When it picks
  `delegate_computer_task`, the code hands over only a message that begins
  with one of these words: check, read, summarize, review, open, search, find,
  browse, navigate, click, type, fill, download, compare, inspect, use, look,
  go, scroll, select, switch, focus, bring, show, refresh, reload, press.
  "Scroll down in Slack", "refresh the browser" and "read my Slack messages"
  go this way. The supervisor needs its own language model for this.

A question, a bare yes or no, a request for the state and a sentence about a
session or an agent are never handed over, whatever the model asks.

The supervisor also has a tool for the browser that runs (reload, back,
forward, tabs, read a page) and one that reads the screen from a picture. For
"refresh the browser" and "read my Slack messages" its language model chooses
between those tools and the worker. Both do what you asked. Only the worker
shows the cursor.

**From a phone call.** A call asks through `clawdtime chat TEXT`. That command
now hands the text to the running desktop service, so a caller's request
reaches the worker as the same words in the panel's chat do. See "One message
from a command, and the desktop service" in [the supervisor page](SUPERVISOR.md)
for how the command finds the service, and what it does when none answers.

## The guards

The planner's output is an untrusted single-action plan. These rules are code
in `guards.ts` and `worker.ts`. None of them depends on the prompt.

- **Valid actions only.** An action has one of the kinds of the contract and
  valid arguments. The number of an element must be in the last observation, and
  the number of a page element in the last reading of the page. A point must be
  inside the last image. An element that is disabled or off the screen is
  refused. Three refusals in a row end the request.
- **A fresh look.** No input goes out without an observation that came after
  the last action. After an action on the screen, the page must be read again
  before a page element is used.
- **Secure fields.** The worker never types into a secure field, and never
  types while a secure field has the focus. It also checks where the focus
  landed after the click that gives a field the focus. It stops and asks you to
  type it yourself. Text for a password field of a web page is refused the same
  way.
- **Your yes before what cannot be undone.** A click needs your yes when the
  name of its target holds one of these words as a whole word: send, delete,
  remove, erase, pay, buy, order, submit, post, publish, share, transfer,
  confirm, sign out, log out, empty trash, reset, format, purchase, check out,
  donate, discard, trash, uninstall, wipe, shut down, restart, log off, quit,
  replace, overwrite, revert, don't save. The same holds for a name that gives
  a yes in your place: approve, allow, accept, authorize, grant, agree, permit,
  trust. A click that only gives a text field the focus is not asked about. For a point with no named element under it, the
  planner's own reason is read for these words.
- **Your yes in a terminal.** Typing and every key need your yes while a
  terminal app is in front, or while a terminal inside another app has the
  focus.
- **Your yes for keys.** A key combination that quits, logs out or locks
  (Command with Q in any form, and the force-quit keys). Command with Delete.
  Command or Control with Return. Return in a messages or mail app. The send
  keys of the mail app. Return or Space while a button, a menu item or a
  focused element with one of the words above could take it, unless a text
  field has the focus. The power key and the media keys are never sent.
- **Your yes before a form is submitted** in the browser, unless the field is a
  search field.
- **You take over.** When the hands report that you moved the mouse or pressed
  a key, the worker pauses and asks: continue or stop.
- **No third time.** The same action with the same arguments is not sent a
  third time in a row. The worker asks first. A scroll, a wait and a reading of
  the page do not count, because repeating them is normal.
- **Done is checked.** `done` counts only after an observation that came after
  the last action.
- **Links.** Only http and https links are opened, with no login in the link.
- **Typed text is one line.** A line break or a tab in typed text is refused.
  Return and Tab are keys of their own, so the key rules see them.

## Questions and answers

A question shows in the chat. Your next message is its answer. The worker reads
a yes or a no with the same conservative reader that reads a yes on a phone
call (`interpret` in `connectors/agents/call.ts`). Words that are not a clear
yes or no change nothing, and the question is said again. A no ends the request.

A yes is for what you were asked. The worker looks again after your answer. If
the screen is another one by then, it sends nothing and the planner starts
again from a new look.

A question of the planner starts with "The task asks:". Its answer goes back to
the planner as text and allows nothing in code. An answer that holds a password
or a key is not passed on: type it into the field on the Mac yourself.

When an agent's request waits on the desk at the same time, your message
answers neither. Answer the agent's request first, in the panel or in its
terminal.

On a phone call nothing says a question by itself. Ask "computer status": the
answer is the question that waits. Then say yes or no. Both go to the desktop
service through `clawdtime chat TEXT`.

The chat of the panel stays open when you send a message. The panel closes its
chat and its board only when a run really starts, so that they are not in the
way of the hands. It reads which engine the service has from
`GET /desktop/computer`, every few seconds.

## Stop

Four ways: say `stop` in the chat, by voice or on a call, press **Stop** on the
bar at the top of the screen (or hold Escape), press **Stop work** in the
panel, or run `clawdtime computer off`. The buttons use the existing route
`POST /desktop/execution/stop`. That route belongs to the engine that the
service picked: the worker has it only when it is the engine.

While the worker runs, the panel shows two things with a Stop button: the bar
of the hands at the top of the screen, and the small window for native
computer work beside the mascot, which the panel shows for every engine in the
mode `native`. Both stop the same request.

Stop is checked before and after every action. The answer is always the same:

> Stopped. An action that was already sent may have finished.

A command that the panel has not fetched yet is taken back, so it never runs.
A command that the panel has fetched is checked once more, after the glide of
the cursor and just before the event (`HandsGate` in the panel): Stop on the
bar, Stop at the service, and your own mouse and keys since the command began.
With one of them nothing is sent. After that check an action may finish. The request stays in the
state `stopping` until its result arrives, and nothing follows it. Stop does not
wait for the language model.

## The live cursor

Before the hands click, scroll, drag, type, press a key, or open an app or a
link, a cursor glides to the place and says what happens there. Only then does
the real event go. A person at the Mac sees each action before it happens, and
so does a person who watches the shared screen on a phone.

- **The window.** One rule in code, `GuidedOverlay.cursor`: the window is at
  the level of a screen saver, which is above the menu bar, an open menu and
  every app. It is on every Space and beside an app that fills the screen. It
  takes no mouse event, so every click goes through it, and it can never have
  the keyboard. A screen share and a recording show it.
- **Not in the worker's own picture.** The picture that the hands take for the
  planner leaves out every window of ClawdTime with a filter of its own, so
  the planner never sees the cursor or its label.
- **The label.** Each command for the hands comes with a short label from the
  worker: `Click "Save"`, `Type in "Search"`, `Press cmd+s`, `Scroll down`,
  `Open Notes`. The cursor shows it in a pill beside the pointer, as one line of
  at most 44 characters. The label of typed text never holds that text. The
  label of a key names the key, and the label of a click names the element as
  the screen names it.
- **The glide.** The cursor goes on from where it is. The first time it comes
  out of the mascot. A glide takes 0.45 to 0.70 seconds, longer for a longer
  way, and the cursor then waits 0.3 seconds at the target. It stays 1.5
  seconds after the command and then fades. The picture of a call defaults to
  20 frames a second, so the shortest glide is in nine of them or more.
- **Typed keys.** A command that types names no place. The cursor goes to the
  field that has the keyboard: to the lower edge of a field of one line, so
  the pointer is under the text. With no field known it stays where it last
  pointed. The checks for a password field and for ClawdTime's own windows run
  again after the glide, just before the first key.
- **The size.** For a screen that a phone shows as a picture of 1280 by 720
  pixels: a pointer of 28 points in a bright ring of 44 points, and letters of
  20 points in the pill. The colors and the typeface are those of the panel.
- **Reduce Motion.** With the macOS setting Reduce Motion the cursor jumps to
  the target with no glide, waits 0.4 seconds, and the ring of a click shows
  with no growth.

The outgoing call video can now automatically frame these agent targets and
focused typing fields. Capture stays continuous and input coordinates stay
unchanged. “Show the whole screen” holds overview until “resume automatic
zoom”; the automatic switch is independent of computer use. See
[automatic call-video zoom](AUTOMATIC_CALL_ZOOM.md) for the event contract,
manual-view precedence, measured performance and physical acceptance gaps.

The bar at the top of the screen and the other windows of ClawdTime stay out
of a screen share while the worker runs. Only the cursor is in it.

## What is not known

Two things make a request `uncertain`:

- The service restarted while the request was running.
- An action went to the hands and its result never came back.

An uncertain request is never run again, and no new request starts. Look at the
screen to see what happened. Then run `clawdtime computer clear`. Its record
stays in the journal. The worker has the same step as a method, `clear()`, for
a person who has no terminal: its messages about an unknown result say "After
you looked at the screen, say "clear the computer task", or run: clawdtime
computer clear". `clear()` starts nothing and sends nothing again.

A look or a wait whose result never came back is not uncertain, because it
changed nothing. The same holds for a command that the panel never fetched.
Those end the request as `blocked`.

## What is kept and what is not

The journal is `computer/journal.json` in the state folder. The folder and the
file are for their owner only. It keeps the last 30 requests:

- The request in your words, cut to 300 characters. A request that holds a
  credential is replaced by a marker.
- Its state and one word for how it got there: `done`, `stopped`, `restart`.
- Each step as the kind of action, the name of the element and one word for
  the outcome. For a link it keeps the site, not the path.

The journal never holds an image, typed text, the text of a page, a question,
an answer or the planner's words.

The chat keeps what the worker said to you: its questions and its last message.
The last message of a finished request is the planner's summary, cut to 900
characters. It can repeat words from the screen.

The language model receives, for each action: your request, the last 12 steps
with the text that was typed, the names and values of up to 150 elements, the
image of the screen, and the text of the page when the browser read it. The
value of a secure field is never sent. Nothing of this is written to disk by
ClawdTime. Close what you do not want in the picture before you start a task.

## Routes

All three need the panel credential, as the other `/desktop/` routes do. They
refuse a browser origin.

| Route                             | What it is                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /desktop/hands/next?after=N` | The command that waits for the hands, when its number is above `N`, and what runs. Shape `handsNextSchema`                              |
| `POST /desktop/hands/result`      | What came of one command. Shape `handResultSchema`, body up to 6 megabytes (MB). Answers `{ "ok": false }` when no command waits for it |
| `GET /desktop/computer`           | `enabled`, `state`, `message`, `step`, `goal` and `question`. Shape `computerStatusSchema` in `worker.ts`                               |

The same command is served until its result arrives, with the same number. The
panel must never run one number twice. The numbers start at the time of the
service start in milliseconds, so they stay above those of an earlier run.

A service where no worker runs still answers all three, with `enabled` false,
no command, and the reason in `message`. That holds for a service with another
engine, with the switch off, with no key, and for one that a test started.

## Limits

The native worker supports [desktop navigation and verified activation](DESKTOP_SPACES.md).
`open_app` brings a named app forward, or one window by its title; separate
complete requests such as “Move one
desktop right” dispatch one `switch_desktop` action outside the planner loop.
Directional navigation requires explicit enabled Mission Control shortcut mappings.
Both paths settle and retire old coordinates; unverified transitions never retry.
Initial switching scope is distinguishable ordinary desktops on one main display;
physical acceptance remains pending. That restriction does not gate unrelated
click/type input. The guide covers setup, previous-desktop history, full-display
sharing, independent disable control, zoom integration and acceptance gaps.

| Limit                          | Value                                       |
| ------------------------------ | ------------------------------------------- |
| Requests at one time           | 1                                           |
| Actions for one request        | 40                                          |
| Time for one request           | 15 minutes                                  |
| One command to the hands       | 20 seconds, more for a wait and a long text |
| One call to the language model | 60 seconds. Two failures in a row end it    |
| One call to the browser        | 30 seconds                                  |
| Typed text                     | 4000 characters, one line                   |
| Elements in one observation    | 400, of which the planner gets 150          |
| A result that the panel posts  | 6 MB                                        |
| Requests in the journal        | 30                                          |

## What is tested and what is not

Tested, with made-up hands, a scripted planner, a scripted language model and
a made-up browser. No test moves the real mouse, presses a real key, captures
the real screen, draws the cursor or calls a language model.

316 tests in `tests/connectors-computer-*.test.ts`:

- `guards` (88): every check above, one by one.
- `worker` (56): a task that completes; Stop before, during and after an
  action; each question with yes and with no; the screen that changed while you
  answered; you take over; both missing permissions; a restart; a lost result;
  the step and time limits; `done` before a fresh observation; the journal
  holds no typed text.
- `browser-script` (49) and `browser` (30): the page script in a made-up page,
  and the driver over a scripted command runner.
- `talk` (26): the person's next message answers the worker; and each of
  "click the blue Send button", "type hello in the search field", "refresh the
  browser", "scroll down in Slack" and "read my Slack messages" reaches the
  engine in the person's own words, at once or through the tool of a scripted
  language model. A question, a state and a bare yes do not.
- `routes` (16): the three routes and the stop route through the real route
  code, with and without the panel credential, with a 6 MB body; and three
  real desktop services on free ports that this test started, which have no
  worker and no hands whatever the switch and the key say.
- `engine` (8): the choice of the engine through the real route code: the chat
  connection first, the bundled runtime next, both, the worker with one whole
  task and with Stop, a test's service, the switch off, no key, actors and no
  board.
- `hands` (10), `journal` (12), `planner` (12), `cli` (9).

15 tests in `tests/connectors-agents-desktop-chat.test.ts`: where
`clawdtime chat TEXT` looks for the service, each reason to answer by itself,
an option that is never sent as a message, the message that is never said
twice, and one real desktop service that this test started.

51 pure tests of the panel's side in `mac/Tests/TaskPanelCoreTests/`: the
contract, the last check before an event, the key plans, the picture and the
elements, and for the cursor the
time and the start of the glide, the jump with Reduce Motion, the sizes in a
picture 720 pixels high, the place of the pill at every edge of the screen,
the place for typed keys, and the rule of the window.

Not tested, and so not proven:

- The hands in the panel. Nothing here shows that a click lands where the
  observation says, that a secure field is reported as secure, or that the
  panel reports your mouse and keys.
- The cursor on a screen. Its window, its drawing and its glide are AppKit
  code that no test runs. Nothing here shows that a screen share or a call
  shows it, that it is above a menu or a full-screen app, that the label is
  readable on a phone, or that the worker's own picture leaves it out.
- The desktop service with the worker as its engine. A service that a test
  starts never has the worker, so the worker and its routes are tested in the
  test's own process only. The lines of `scripts/task-server.ts` that wire it
  are checked by the type checker and by nothing else.
- The browser driver against a real browser, and the driver in the service:
  it is not connected.
- The planner against the real language model. Its request has the shape that
  the tests check. No test shows that the model picks good actions.
- The supervisor's language model. No test shows which tool the real model
  picks for a sentence that the code does not route by itself.
- A phone call that reaches the worker. `clawdtime chat TEXT` is tested
  against a service with no engine. The line agent that calls the command is
  not part of these tests.
- A whole task on a real Mac. There is no physical acceptance yet.

## Known gaps

- The checks read names. A dialog whose button says only "OK" is not asked
  about, whatever the dialog says. Names in other languages are not known.
- A point with no named element under it is judged by the planner's own words
  only.
- The terminal rule knows a list of terminal apps. Another app that runs typed
  text as code is not covered.
- Return in a single-line text field can press the default button of a dialog.
  That case is not asked about.
- The worker does not judge where a link leads, or what a page does with a
  click on a plain name.
- Between the look just before an input and the input itself, the screen can
  still change. The hands are the last place that can refuse. The glide of the
  cursor and its wait add up to one second to that time. A command for the
  hands names a point, not an element, so the hands cannot check what is under
  the point just before the click.
- A question reaches you in the chat only. On a phone call nothing says it by
  itself: ask "computer status".
- Two tools of the supervisor overlap with the worker: the browser tool and
  the tool that reads the screen from a picture. Which one its language model
  picks for "refresh the browser" is not fixed in code.
- A question about what ClawdTime can do, in the form of a polite request, is
  read as a request: "Can you click buttons on my screen?" starts a task with
  those words. The route before the language model cannot tell the two apart.
- That route has no check for a request of an agent that waits at the desk.
  "Click the Approve button" goes to the worker. The worker then asks for your
  yes before the click, because of the name.
- The words refresh, reload and press pass the hand-off with any object, when
  the language model picks the tool: "refresh the board" can go to the worker.
- A second desktop service of the same user builds a second worker. The switch
  and the journal are one for each user, so its start marks a request of the
  first as uncertain.
- The tool that reads the screen from a picture shows the cursor and its label
  when it runs during a task of the worker.
- `clawdtime chat TEXT` sends the panel credential with its first read, before
  the service has shown that it is the one that wrote the files. A process of
  the same user that takes the port after a crash would get it.
- While the worker runs the panel shows two windows with a Stop button.
- The cursor is the only window of ClawdTime in a screen share during a run.
  The mascot that it comes out of is not in the share.
