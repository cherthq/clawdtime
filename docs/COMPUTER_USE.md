# Computer use

November 20, 2026. This is the app-owned worker that
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

The code is in `connectors/computer/`. `ports.ts` is the contract between the
parts. This change builds the worker, the planner and the service side of the
hands. The hands inside the panel and the browser driver are built by other
changes against the same contract.

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

The desktop service builds the worker when it starts, and only when all of
this holds:

- The switch is on. The switch is the file `computer/config.json` in the state
  folder (`CLAWDTIME_CONFIG_HOME`, or `~/.local/share/clawdtime`). A switch file
  that is not a regular file of this user for its owner only does not turn it
  on.
- A key for the language model is in the environment of the service:
  `CLAWDTIME_OPENAI_API_KEY`, or `OPENAI_API_KEY`.
- No connection to an existing chat is configured. With a
  `desktop-executor.json`, that connection keeps priority and works as before.
- The agent board of the service is on, and the service has no phone or
  presentation actors.

So after `clawdtime computer on`, start the desktop service again.
`clawdtime computer off` needs no restart: the worker reads the switch before
every action.

The model is `gpt-4.1`. `CLAWDTIME_COMPUTER_MODEL` changes it.

The panel needs two permissions in System Settings, Privacy & Security:
Accessibility, and Screen & System Audio Recording. When one is missing, the
request ends as `blocked` and the message names the permission to grant.

To give it a task, talk to ClawdTime in the chat of the panel. The supervisor
hands a message to the worker only when its language model chooses to, and only
when the message begins with one of these words, with or without "can you" or
"please": check, read, summarize, review, open, search, find, browse, navigate,
click, type, fill, download, compare, inspect, use, look, go, scroll, select.
That rule is the supervisor's and this change did not widen it. The supervisor
needs its own language model for this.

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
  replace, overwrite, revert, don't save. A click that only gives a text field
  the focus is not asked about. For a point with no named element under it, the
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

## Stop

Three ways: say `stop` in the chat or by voice, press **Stop work** in the
panel, or run `clawdtime computer off`. The panel's button uses the existing
route `POST /desktop/execution/stop`.

Stop is checked before and after every action. The answer is always the same:

> Stopped. An action that was already sent may have finished.

A command that the panel has not fetched yet is taken back, so it never runs.
An action that is already with the hands may finish. The request stays in the
state `stopping` until its result arrives, and nothing follows it. Stop does not
wait for the language model.

## What is not known

Two things make a request `uncertain`:

- The service restarted while the request was running.
- An action went to the hands and its result never came back.

An uncertain request is never run again, and no new request starts. Look at the
screen to see what happened. Then run `clawdtime computer clear`. Its record
stays in the journal.

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
no command, and the reason in `message`.

## Limits

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

Tested, with made-up hands, a scripted planner and a made-up browser. No test
moves the real mouse, presses a real key, captures the real screen or calls the
language model. 201 tests in `tests/connectors-computer-*.test.ts`:

- `guards` (78): every check above, one by one.
- `worker` (56): a task that completes; Stop before, during and after an
  action; each question with yes and with no; the screen that changed while you
  answered; you take over; both missing permissions; a restart; a lost result;
  the step and time limits; `done` before a fresh observation; the journal
  holds no typed text.
- `routes` (16): the three routes and the stop route through the real route
  code, with and without the panel credential, with a 6 MB body, and against
  three real desktop services on free ports: on with a key, off, and on with no
  key.
- `hands` (10), `journal` (12), `planner` (12), `talk` (8), `cli` (9).

Not tested, and so not proven:

- The hands in the panel. Nothing here shows that a click lands where the
  observation says, that a secure field is reported as secure, or that the
  panel reports your mouse and keys.
- The browser driver. The worker ran only against a made-up one.
- The planner against the real language model. Its request has the shape that
  the tests check. No test shows that the model picks good actions.
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
  still change. The hands are the last place that can refuse.
- A question reaches you in the chat only. On a phone call nothing says it yet.
