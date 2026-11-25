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
page, a hover that opens a menu, a choice by the text of its option, keys, a
wait for words, the list of the tabs and a switch, and pages that change
built-in functions to forge the answer.

Without the switch, or when the browser does not answer, the worker uses the
screen for web pages.

### ClawdTime's own browser

`CLAWDTIME_COMPUTER_BROWSER=own` drives a browser that ClawdTime starts
itself, in place of the browser in front. It needs no setting in your browser
and no Automation right of macOS.

- It is Google Chrome, or else Chromium, Brave or Edge, from `/Applications`
  or `~/Applications`. `CLAWDTIME_OWN_BROWSER_PATH` names another program of
  that family.
- It has its own profile, in `computer/browser-profile` of the state folder,
  for its owner only. Your usual browser and its profile are not touched. Sign
  in to your sites in this browser once. The profile keeps you signed in.
- It starts at the first browser step, with its window, and closes when the
  desktop service stops.
- It reads a page with the same page script and the same numbers as the other
  driver. The script runs in a world of its own in the page, so the page's
  scripts cannot see its state or change what it calls. It clicks, types and
  presses keys with the browser's own input, so the page sees trusted events.
- Before a click, the page script says whether a pointer at the element's
  centre reaches it and nothing else. When another element covers it, when a
  frame lies there (the click would land in another page, maybe of another
  site), when another control lies inside it there, or when the page replaced
  the browser's hit test, nothing is sent.
- Before a key, the page script says where the focus is. In a password field
  or in a frame, no key is pressed.
- After an open, a click, a key or back, it waits until the page has loaded
  and the network is quiet, for at most 5 seconds, or 10 after an open.
- It can also hover, pick an option by its label, press one key, wait for a
  text, list the tabs and switch to one.
- It connects only to the port that this browser wrote in its profile, on
  127.0.0.1. Then it checks that the browser on that port is the process that
  it started, or, after a restart of the service, the process that holds the
  profile. It refuses any other program.
- A read may start the browser again after it closed. An input never does, and
  an input whose answer did not come back is never sent again: the request
  becomes uncertain.
- It never types into a password field and never reads one.

`clawdtime computer doctor`, run with the same variable, says whether a
browser program is there, whether the profile folder can be written, and
whether a running own browser answers. `npm run test:computer:own-browser`
runs the driver in Chromium with no window, against pages of a server on this
computer.

## One request, one action at a time

1. The worker asks the hands for a look: an image of the screen and the
   elements that the Accessibility tree names.
2. It gives the planner the goal, the last 12 steps, the useful elements, the
   image and the plan of the request. The planner answers with exactly one
   action, or with a change of its plan.
3. The worker checks that action in code. An action that is not valid is
   refused and not run, and the planner is told why.
4. When the action needs your yes, the worker asks and waits.
5. Just before an input, the worker looks again, with no image. It finds the
   same element again by its role, its name and its place, and it checks the
   action again against that look. If another window is in front or the target
   is gone, nothing is sent.
6. The action goes to the hands or to the browser. Then the worker looks again
   and the planner picks the next action.

Each step that the planner reads names the element that it was on, by its role
and its name, as in `click_element on AXButton "Export": ok`. A click at a
point also says the point. The name is the one that the journal keeps, cut to
60 characters, and it is left out when it looks like a secret. The line never
gives an element number: that number is from an old look.

A look takes the picture and walks the Accessibility tree at the same time,
so the slower of the two sets its time. The picture is 1280 pixels on its
longer side, a JPEG of quality 0.5, written off the main thread. The walk
reads the tree in its own order, leaves out each part of the window that does
not show (a long list gives only the rows in view), and stops at 2000
elements, 60 levels or 0.6 seconds. When more than 400 elements remain, the
field with the keyboard, a password field and the controls that can be used
stay first, in the order of the tree. The look just before an input takes no
picture.

One request runs at a time. A request ends after 40 actions or 15 minutes,
whichever comes first. A request with a plan of 3 subgoals or more may take 80
actions (see [Plans and multi-step tasks](#plans-and-multi-step-tasks)). The 15
minutes hold the time that it waits for you.

### What you hear first, and on the way

No request opens with a fixed sentence. The code is in
`connectors/computer/opening.ts`.

- The start answers with no words (`submit` gives an empty message). The
  outline that the planner writes after the first look also holds `say`: one
  line in your language, in the first person and the present tense, about what
  it does first for this request on the screen it sees, such as "Opening Notes
  and searching for the budget note.". The worker sends that line through the
  chat once, as soon as the outline is there. It is the first message that you
  see or hear.
- When the outline fails, or has no line within 4 seconds, the line is made
  from the planner's own reason for its first action: "Open Notes to find the
  note" becomes "Opening Notes to find the note.". A reason that does not read
  as an act on the screen gives no line; the reasons of the first three
  actions are tried. A question or the end that comes first is the first
  message, and no start line follows it.
- A line has at most 120 characters (a longer one is cut to its first
  sentence, or dropped). A line that looks like a secret, that opens with
  "Done." or that names subgoals, steps or the planner is dropped.
- On the way there is no message for each step. When the planner revises its
  plan, the first revision of a request that can be said gives one line in
  the planner's own words. The end is the planner's own summary, as before.
- The chat of the panel, a spoken reply and a phone call have one answer for
  the message that started the request. That answer is the worker's first
  words: the supervisor waits up to 8 seconds for them (`firstWords`). The
  line is in the chat once: a reply that repeats the line that the worker
  already wrote there is not written again. On a call the phone adapter
  (`src/control/phone-desktop.ts`) reads the first words of the request that
  the call started, and the line speaks them. When no words came in time, the
  chat writes no answer, and the line comes a moment later by itself.
- The state when nothing runs is a fact, not an invitation: "Computer use is
  on. No computer task runs now.".

What you say while a request runs is for that request, and the request goes
on by itself. "open it in the browser", "not social.example, shop.example", "no, the
other one", "hmm try the search box", "that's wrong, go back": each one steers
the task, and the task keeps going. No magic word is needed to go on. Your
words start no second request. The worker keeps them in order and gives them
to the planner with its next action, marked as what you said after the start,
so that your newest word wins. An action that was chosen before you spoke did
not have your words: it is not sent, also when it was already on its way, and
the planner chooses again. The answer is one short sentence that says where
your words are now, for example "Got it. I take that into the task that
runs.". It never says that something was done. Every action after it goes
through the same checks. One request takes 8 such additions of 600 characters
each, and none that holds a password or a key. The same message a second time
adds nothing and starts nothing.

### Words while a task runs

The worker reads each message with `readMidTask` in
`connectors/computer/orders.ts`. One of five things happens.

- **Stop.** Any stop word anywhere in the message (`stop`, `stopp`, `stahp`,
  `cancel`, `abort`, `halt`, `quit it`, `kill it`, also inside polite or
  casual forms such as "can you stop?", "pls stop", "actually stop", "i said
  stop", "wait, stop", or a screen phrase such as "cancel the dialog" or "stop
  the video", and also with a typo: see Casual words and typos) stops the
  request at once. This holds in every state: while the first reading or the
  first look is in flight, while the planner chooses, while an input is with
  the hands, at a pause, at a question, at the step limit, at the 8-addition
  cap, when the record cannot be written, and when the words also look like a
  secret. The word `enough` is not a stop word, so "scroll down enough to see
  the button" does not cancel the task.
- **Pause.** The message only asks to wait, or says that you do it yourself:
  "wait", "hold on", "hang on", "pause", "one sec", "give me a minute", "not
  yet", "don't touch anything", "let me do it", "let me check", "I'll take it
  from here", "hang on, I'm checking something", "my turn", "brb", a raised
  hand. A yes, a no or a thanks may stand beside it ("no wait", "ok, hold
  on"). The worker pauses before the next input and says "Paused. Your next
  message goes on with it.". An action that was on its way is held back. The
  words of a pause carry nothing for the planner. When you move the mouse or
  press a key while the hands work, the worker pauses in the same way.
- **Status.** A question about how the task goes, as the whole message: "are
  you done?", "what are you doing?", "how's it going?", "where are you?", "is
  it done yet?", "done?", "r u stuck?". The answer is one short sentence:
  'Still working on "open the editor", at step 3, and it is not done yet.'.
  Nothing is kept, and nothing pauses.
- **Go.** "continue", "go on", "ok", "thanks", a thumbs up: nothing to steer
  with. The task goes on, and the words are not kept.
- **Steer.** Everything else. Negations, doubts, remarks, time words, other
  questions and orders all steer: "don't click that", "is that the right
  page?", "do it later", "wait for the page to load", "pause the video". A
  wait inside other words steers too: "wait, not that one, the blue one".

**Going on after a pause.** Any next message ends a pause. Words that steer go
into the task, and the task goes on after a fresh look. A go word and a
status question go on too. Another wait keeps the pause, and so do words that
hold a secret. A stop stops. The chat's answer at a pause (`answer`) is read
in the same way. With the owner's trust (see The owner's trust), a pause with
no message ends by itself after 60 seconds (`resumeMs` of the worker): the
pause says so, and the worker says when it goes on. Without trust a pause
waits for your next message, within the time limit of the request.

**At a question.** A yes and an answer come through `answer` (see Questions
and answers). Words that come through `submit` are no yes and no answer.
Words that steer set aside what waited, and the planner chooses again with
them. A wait sets it aside and pauses. "continue" or "ok" at a yes is no yes:
the question still waits. At a question of the planner a go word sets it
aside, and the task goes on. A status question gets the question that waits.

**At the start.** While the planner reads whether the request is a one-step
move, or while the first look is in flight, words steer as always: the
planner plans with them, and a one-step move read from the first words is not
made. Once a one-step move is on its way, words are not taken, and the reply
says that the task is at its end. A wait still holds the next input then.

**Secrets.** Words that hold a password, passcode, passphrase, PIN, secret,
token, API key, credential, `pw`, `pwd`, `2fa`, `ssn`, `cvv`, `cvc`, or a
short numeric code (including contractions, `"set to <value>"`, `"saved as
<value>"`, `"<noun> for <target> is <value>"`, value-before-noun forms such as
`"type 4821 as the pin"`, quoted or bare values after secret nouns, spaced PIN
digits, full-width digits or a colon after NFKC normalization, one- or
two-sided invisible format or combining joiner characters around
`is`/`was`/`:`/`=`, tokens split across indented line breaks, a word between
the noun and its value as in "my pin number is 4821", a value typed into a
secret field as in "type hunter22 in the password field" or "fill the pin with
4821", a misspelled secret noun as in "my pasword is hunter22", and 13 to 19
digit payment card numbers) are refused: they are written nowhere and never
sent to the planner. A secret split over two messages is refused too: right
after words that name a secret or a field for one ("type my pin in the pin
field"), or a question of the planner that does, a short value on its own (a
number of 3 to 12 digits, or one word with a letter and a digit or a symbol,
such as "4821" or "hunter22") is a secret. Words with a secret pause nothing
and change nothing else: the reply says that the words were not kept, a
running task goes on, a pause stays a pause, and a question still waits.
Plain state or location remarks ("the password is already filled", "the
password is the same", "the password is on my phone", "the token is expired")
and UI labels ("open password generator", "click password recovery") are not
treated as secrets.

**Limits and scope.** Words that cannot be kept (past the step limit, past 8
additions, longer than 600 characters, or when the record cannot be written)
get a reply that says so, and the task goes on. A wait still pauses in all of
these. When the task is past its deadline or its call authority ended,
non-stop words are not taken. Words come only from where the request was
started: the same call, or the chat on both sides. A request that is stopping
takes none. Words that were read as a one-step move to another desktop or to
the app before are a request of their own, and wait as before.

**The chat.** While a task runs or is paused, the chat hands each message to
the worker in your own words, with no offer and no question back, and the
worker reads it as above. A question gets its answer from the state of the
task instead: the narrow questions ("are you stuck?", "are you done?", "is it
open?", "what are you doing?") from code, the others from the language model
with the state. A thanks, a greeting or a bare yes is a reply of the chat
while the task runs. At a pause every message goes to the worker, and it goes
on. Words for other work keep their own road: a session of the board by its
name, code by what it names (a file, a repository, a branch, a commit, a test),
the work of the supervisor (agents, jobs, builds, deploys, logs), work to find
something out, and words for a session ("tell Claude to run the tests").
Words with a verb of code work ("open the app and add dark mode", "add it to
the cart") go to the language model first: it starts a job, or hands them to
the task.

### The strict reader of stops and orders

`readWords` in `connectors/computer/orders.ts` reads stops for every reader:
the worker, the chat and the reach. It also reads a strict screen order, which
the chat uses at a question that waits for a yes, and it reads words that hold
work back before a request starts (`defersWork`). Its reading of a hold no
longer pauses a task that runs.

- **Screen order (`order`).** The last sentence of the message (with no stop
  word in any sentence) matches a strict screen-order shape: optional
  fillers, an optional polite lead (`can you`, `could you`, `would you`,
  `will you`, `can u`, `pls`; only with that lead may the sentence end with
  `?`, and questions with `or`, `should I`, `yet`, `is it`, `do I`, or a
  behaviour adverb such as `automatically` hold), a screen verb (`open`,
  `click`, `press`, `hit`, `tap`, `type`, `enter` with an object, `select`,
  `choose`, `pick`, `scroll up/down`, `drag`, `use`, `try`, `search for`,
  `close`, `go to`, `go back`, `switch to`), and a concrete screen object
  (pronoun, ordinal, key name, screen noun, web address or `localhost:port`,
  quoted label for non-`type` verbs, known browser or app name, common UI
  button label for click verbs, capitalized name after `open`, `switch to`,
  `close`, `click` or `select`, `<words> in/on/with <browser or app>`, or a
  single bare word after `open`, `close` or `switch to` that is not an
  everyday physical object or person word). A person's name after `to` or
  `for` or in possessive form holds. No remark may follow the order after a
  comma, dash or semicolon except a filler (`please`, `thanks`, `bro`, `now`,
  `then`). A second action joined by `and` or `then` is allowed only when it
  is also a screen verb with a screen object. Any cue of holding, waiting,
  delay, doubt, refusal, negation, self-takeover or a time anywhere in any
  sentence holds, with one narrow exception for an earlier sentence that only
  reports what the person sees or does not see ("It didn't load. Use the
  other tab.").
- **Continue (`continue`).** A standalone continue phrase (`continue`, `go
on`, `go ahead`, `resume`, `carry on`, `keep going`, `proceed`) after
  optional fillers, with no question mark.
- **Hold (`hold`).** Everything else.

### Casual words and typos

Both readers read the words as written first, then a casual form of the same
words with the same rules. The casual form is for the reading only: what you
wrote is what is kept, sent to the planner and checked for secrets.

- Marks and emoji: smart quotes become plain quotes. A run of three or more of
  one letter becomes one or two ("pleeease", "stooop", "noooo"). A run of
  marks becomes one mark, and a run with a question mark stays a question mark
  ("open chrome?!" is a question). A star around a word goes. Emoji that only
  decorate (such as folded hands, thumbs up, a check mark) go. A question
  emoji counts as a question mark.
- Casual forms: `u`, `ur`, `n`, `&`, `+`, `w/`, `plis` and its kin, `thx`,
  `k`, `kk`, `okie`, `aight`, `yup`, `rn`, `asap`, `btn`, `msg`, `pg`, `dwn`,
  `opn`, `goto`, `teh`, and "ClawdTime" named at the start or the end ("hey
  clawdtime open chrome"). A bare "search cats" reads as "search for cats".
- Typos: the screen verbs, the screen nouns, the key names and the known app
  and browser names take one typo in a word of 4 letters or more, and two in a
  word of 8 or more. A typo is two neighbouring letters swapped, a letter hit
  with a neighbouring key, a letter left out, or one letter too many. It is
  never at the first letter, and one letter too many at the end is only a
  repeated letter, so "opens", "typed" and "clicked" are never read as the
  verb. A word that the rules read, a capitalized name inside a sentence, a
  word with two equally near screen words, and a short deny list of English
  words stay as they are.
- Stops: a stop word with one typo stops (`stp`, `srop`, `sttop`, `stoop`,
  `stpo`, `cancle`, `canceel`, `abortt`, `haltt`), and so do a long `stooop`
  and the stop sign or stop button emoji. Ordinary words near a stop word
  ("step", "shop", "atop", "stow", "top") do not stop, and a short deny list
  ("hat", "half", "stomp") stays as it is. The chat reads a stop word with a
  typo the same way, and stops the task.
- Waits: a wait with a typo or in a casual form pauses (`wiat`, `hol up`,
  `holdon`, `brb`, `1 sec`, `gimme a minute`, `lemme do it`, `ill take it from
here`), and so do a pause button and an hourglass.
- Lookalike letters and apostrophes: letters of another script that look like
  Latin letters (a Cyrillic `о` in `stоp`, a Cyrillic `ѕ`, Greek capitals),
  small capitals and accents read as the Latin letter, and other marks for the
  apostrophe (an acute accent, a backtick, a modifier letter apostrophe, a
  prime) read as the apostrophe. This reading can only add a stop or a wait.
- A question about what ClawdTime can do, with a generic object and no target
  ("Can you click buttons on my screen?", "can u use my mac?"), is answered as
  a question by the chat, and starts no task. "Can you click the Send button?"
  is an order.

**After you said more.** Only the request itself can say that a send,
terminal work or the loss of unsaved changes was asked for, and only until you
say more. After the first addition such an action asks again, whatever the
addition says.

## When the task does not move on

The worker does not end at the first odd screen. It tries other ways first,
and it asks you before it gives up. Each way here only looks, waits or asks.
None of them sends an input again by itself, and every action still goes
through all the checks.

- **A screen that does not hold still.** Three actions in a row can be held
  back for the same reason: the target moved or went away, the screen
  changed, another window came to the front, a list lies over the place, or
  the page changed. Five held actions in a row for mixed reasons count the
  same way. Then the worker sends nothing and waits. It looks at the screen
  every 0.4 seconds, with no input, until two looks in a row show the same
  app, window and elements, and the same page when a page was held. It looks
  8 times or for 6 seconds at most. Then the planner chooses again from a new
  look, with a note that the screen settled. This happens twice at most in
  one request. When the screen does not settle, or a third such row comes,
  the request ends with what happened and what you can do: "What I tried to
  use kept moving or disappearing before I could act, also after I waited
  for the window to settle, so nothing was sent. Wait until the window
  settles, then ask again." An action that the panel could not run for
  another reason ends the row as before.
- **Steps that go in circles.** `progress.ts` reads each step: the action, a
  digest of the screen before and after it, and whether an input went out.
  It finds a swing: the same two or three actions twice in a row, with no new
  screen in the second round (open, close, open, close). It also finds a
  still screen: four inputs of more than one action after which the screen
  showed nothing that the request had not seen before. A screen that is new,
  also after a wait or a reading, is progress. The first two times, the
  planner reads a note with other ways that fit what is in front: the
  browser reading when a page is in front and the browser was not used, the
  keys (Tab, Return, Escape, a menu shortcut), a scroll, a search field,
  `open_url` when your words hold a web address, and `open_app`. The third
  time the worker asks you one short question: "I keep going back and forth,
  and the screen shows nothing new. What should I try next? Say it in a few
  words, or say no to stop." Your answer goes to the planner, as the answer
  to a question of the planner does. A plain no or a stop word ends the
  request. After two such questions the next circle ends the request. One
  and the same action again and again asks nothing: after three tries that
  changed nothing the planner reads that in its last step, and the same
  action once more ends the request.
- **A page that did not load.** Spoken words are often misheard: a name
  such as "Brightwave" can come out as "Bright5", and the browser then shows its own error page.
  That page is never a result (`error-page.ts`). The worker knows it by the
  browser's own words, on the page that it read or on the screen while a
  browser is in front: "This site can't be reached", `ERR_NAME_NOT_RESOLVED`,
  `DNS_PROBE`, "server IP address could not be found", "Safari Can't Find the
  Server", "This page isn't working", a 404 or "Not Found" title, Chrome's
  error address and an empty tab at a web address. After an `open_url` or a
  `browser_open`, the line of that step says that the page did not load and
  that the address may be misheard: search the web for the name, open the
  site that fits, then check that it loaded. A done while such a page is in
  front goes back to the planner once with the same note; a second done is
  taken. A goal about an error itself ("why does the shop show a 404?") is
  not read this way. The planner reads only a fixed label, never the text of
  the page.
- **A quit at the end of the goal.** A request that ends with "Then quit
  Tips." often ended with done while the app was still open. A done while
  the app that the end of the goal asks to quit is in front goes back to the
  planner once: "The goal also asks to quit Tips; it is still open." The app
  is known by the name that it shows, by its bundle identifier, or as the
  app that `open_app` found for that name, so "Colour" in the language of the
  Mac is the "Color" that you said. Only the app in front is seen; a second
  done is taken. The same option as the check of a done after an input that
  changed nothing turns it on (`quit-done.ts`).
- **A way that did not work, long ago.** The planner reads only the last 12
  steps, and a request may take 80 actions. So the worker keeps a list of the
  ways that did not work in the request (`failed-ways.ts`): the kind of
  action, the role and the name of its element, a few fixed words for why
  (refused, held back, the screen did not change, the page did not load) and
  how often. One way is one row, and the newest 12 stay. With every turn
  the planner reads the ways that are older than the steps that it sees, as
  data: try one again only when the screen shows that it can work now. A
  request of 12 steps or fewer reads the same words as before. A way never
  holds typed text or a name that looks like a secret, and a step held back
  for you is no failed way. Your new words start the list again. Nothing of it
  is written to disk.
- **A give_up.** The first give_up of a request goes back to the planner
  with the ways that it did not try, and the planner chooses again. A
  give_up about you, an account, a permission, a password, a secret, money
  or a risk ends at once, as before. The second give_up ends the request: "I
  could not finish. (the reason) Tell me another way to try, or do this step
  yourself."
- **Trouble of the planner.** The planner says what went wrong with its
  call. After a short failure that it already tried again, such as a busy or
  slow service, the worker waits 3 seconds, or the time that the service
  asked for up to 15 seconds. Then the planner chooses again from a new
  look. That happens 3 times at most in one request, and always within the
  15 minutes. No quota left, or a key that the service refuses, ends the
  request at once and says what to do. An answer with no usable action, or a
  refusal of the model, ends the request after two in a row, as before. Each
  call to the planner gets a signal, and the worker aborts it when it stops
  waiting for the answer: at Stop, at a hold, at the time limit and at the
  end.

Stop wins here too: during a wait for the screen, during a wait for the
planner, and while a question waits. A hold pauses a wait at once. Every end
text says what happened first, and then what you can say or do next.

## Plans and multi-step tasks

A task of several steps is planned first: sign in, find a thing, change it,
confirm it, report it. The code is in `connectors/computer/plan.ts`.

1. After the first look, the worker asks the planner once for an outline:
   1 to 8 subgoals, in order. Each has a check: what the screen shows when it
   is met. A task of one step gets a plan of one subgoal. The outline runs
   beside the first turn, so nothing waits for it: the plan comes with the
   first turn after it arrived. It goes through the same retries, repair and
   abort as every other call to the model. It gets a small picture: the
   elements carry the names. The outline also holds `say`, the first line for
   the person (see [What you hear first, and on the way](#what-you-hear-first-and-on-the-way)).
2. With every turn after that, the planner gets the plan: each subgoal as
   open, done with what the screen showed, or skipped with why, and the one to
   work on now.
3. The planner calls `plan_update` alone, or together with its next action
   in the same answer. It marks the current subgoal done, with what on the
   screen shows it, or skipped, with why. Or it replaces the rest of the plan,
   when the screen shows that the plan was wrong. Nothing goes to the Mac for
   it, and it is not one of the 40 actions. With the action in the same
   answer, the plan is marked first and the action goes on in the same turn:
   alone, it cost one more turn of the model for each subgoal. Two actions in
   one answer are never taken.
4. `plan_update` can also keep up to 3 short facts that the planner found: an
   order number, a name, a link. A fact has at most 200 characters. A fact that
   looks like a password, a code or a key is dropped, with the same check that
   keeps such words out of the journal (`looksSecretStrict`). The planner reads
   the facts at its next turns. The last message adds the facts that it does
   not hold already: "Noted on the way: ...".
5. A `done` is taken at once, also while subgoals are open. A note before
   a done cost one more turn of the model in every request of the request
   test, and the time of a request doubled with it, so it was removed.

The planner's rules for the outline and for each turn with a plan say:

- Plan the whole task before acting.
- Get past something that blocks the way and that the goal does not mention:
  a cookie banner, a what's new sheet, an update prompt that can be postponed,
  a page that still loads. Use the least harmful way and ask nothing: Not Now,
  Later, Close, Reject All, or wait. Every other dialog that the goal does not
  speak about stays as it is. The checks still ask where they ask, for example
  before a close.
- Carry the task to its natural end: after a post, see the post; after a save
  or a change of a setting, see the saved state.
- When a password, a code or another secret is needed, ask, and say what is
  needed and where. The person types it on the Mac. A name or an email
  address that only the person knows is no secret: the planner asks for it
  and types it itself. The rule that made the person type every part of a
  sign-in left the request test asking 7 times in a row for a work email.

The outline alone also reads two lines on `say`: one line in the language of
the goal, in the first person and the present tense, about what the planner
does first, in at most 120 characters, with no promise of success, no secret
and no word about subgoals, steps, checks or how it works.

A turn with no plan reads the rules as before, so the planner test measures
the same rules.

| Bound                                                  | Value                     |
| ------------------------------------------------------ | ------------------------- |
| Subgoals of an outline, or of a new rest               | 8                         |
| Subgoals of one request in all                         | 12                        |
| Revisions of the rest of the plan                      | 3                         |
| `plan_update` calls in one request                     | 16                        |
| `plan_update` calls with no action between them        | 3                         |
| Facts from one `plan_update`                           | 3                         |
| Facts of one request                                   | 8, of 200 characters each |
| Actions of a request with a plan of 3 subgoals or more | 80                        |

While no `plan_update` may come, the planner is not offered it. A planner that
sends it anyway two times in a row ends the request: "The planner changed its
plan again and again and chose no action, so I stopped."

The plan never ends a request by itself. An outline that fails, that cannot be
used or that comes after the time limit leaves the request with no plan, as
before. Stop does not wait for the outline, and its call is aborted. After a
hold during the outline, the worker asks for it again. A request that only
opens one address gets no outline.

Nothing of the plan is written to disk. A `done` that got the note is in the
journal as a step with the outcome `plan_open`, with no subgoal and no fact.

The request test has three requests of several steps: find a note by a word,
copy its number into another note and say the number; sign in while the
person types the password, then turn on a setting; fill a form of three pages,
send it and say its reference. Each has an ideal path and two wrong paths for
`--check`. The ideal path of the first keeps the invoice number as a fact of
the plan, and types it from there into the other note. They are not measured
with a model yet.

## Turn it on

```sh
clawdtime computer on        # the switch. It is off by default
clawdtime computer status    # on or off, and the last request
clawdtime computer doctor    # what is ready and what is missing
clawdtime computer off       # off again. A request that runs stops
clawdtime computer clear     # after a request with an unknown result
clawdtime keys set anthropic # a key of any provider, from a hidden prompt
clawdtime computer model     # the model of the planner, or choose one
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
   - A key for the language model is in the environment of the service, or
     in its key store: `CLAWDTIME_OPENAI_API_KEY`, `OPENAI_API_KEY`, or the
     key of another provider. See [Models and keys](#models-and-keys).
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

With a key of OpenAI and no other choice, the model is `gpt-5.4`.
`CLAWDTIME_COMPUTER_MODEL` changes it. When the service says that a key may
not use `gpt-5.4`, the planner goes to `gpt-4.1`, the model before it, and
stays there. A model that you chose is never replaced.

### Models and keys

The planner can use the language model of any of these providers. A key in
the environment of the service wins over a stored key.

| Provider      | Id           | Key variables                                                  | Address                                                   | Default model     |
| ------------- | ------------ | -------------------------------------------------------------- | --------------------------------------------------------- | ----------------- |
| OpenAI        | `openai`     | `CLAWDTIME_OPENAI_API_KEY`, `OPENAI_API_KEY`                   | `https://api.openai.com/v1`                               | `gpt-5.4`         |
| Anthropic     | `anthropic`  | `CLAWDTIME_ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY`             | `https://api.anthropic.com`, through its official library | `claude-opus-5-5` |
| Together AI   | `together`   | `CLAWDTIME_TOGETHER_API_KEY`, `TOGETHER_API_KEY`               | `https://api.together.xyz/v1`                             | you choose        |
| OpenRouter    | `openrouter` | `CLAWDTIME_OPENROUTER_API_KEY`, `OPENROUTER_API_KEY`           | `https://openrouter.ai/api/v1`                            | you choose        |
| Groq          | `groq`       | `CLAWDTIME_GROQ_API_KEY`, `GROQ_API_KEY`                       | `https://api.groq.com/openai/v1`                          | you choose        |
| Fireworks AI  | `fireworks`  | `CLAWDTIME_FIREWORKS_API_KEY`, `FIREWORKS_API_KEY`             | `https://api.fireworks.ai/inference/v1`                   | you choose        |
| xAI           | `xai`        | `CLAWDTIME_XAI_API_KEY`, `XAI_API_KEY`                         | `https://api.x.ai/v1`                                     | you choose        |
| Google Gemini | `gemini`     | `CLAWDTIME_GEMINI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | you choose        |
| Mistral       | `mistral`    | `CLAWDTIME_MISTRAL_API_KEY`, `MISTRAL_API_KEY`                 | `https://api.mistral.ai/v1`                               | you choose        |
| DeepSeek      | `deepseek`   | `CLAWDTIME_DEEPSEEK_API_KEY`, `DEEPSEEK_API_KEY`               | `https://api.deepseek.com`                                | you choose        |
| Custom        | `custom`     | `CLAWDTIME_CUSTOM_API_KEY`, which it may also go without       | the base address that you give                            | you choose        |

Every provider but Anthropic gets the chat completions route of its address,
with one exception: the newest models of OpenAI, whose name starts with
`gpt-6` or `gpt-5.6` (such as `gpt-6.2-astra` and `gpt-6.2-sol`), get its
Responses route, `https://api.openai.com/v1/responses`. On chat completions
those two answer 400 to functions with a reasoning effort, and refuse the
effort `none` (measured 26 Nov 2026). `CLAWDTIME_OPENAI_API=responses` or
`chat` chooses the route for any model of OpenAI, the chat's model too. Any
other value stops the planner, and the doctor says why.

**Set a key.**

```sh
clawdtime keys set anthropic         # a hidden prompt: the key is not shown
pbpaste | clawdtime keys set groq    # or from standard input
clawdtime keys list                  # set or not set, and where it comes from
clawdtime keys remove anthropic
```

The key store is `computer/keys.json` in the state folder: a file for its
owner only (mode 600) in a folder for its owner only (mode 700). It is written
whole and then renamed. A store that is not a regular file of this user for
its owner only is not read and not overwritten, and the doctor says why. The
desktop service reads the store when it starts: start it again after a change.
No command prints a key, not even a part of it. A key never goes to a log, an
error, the journal or the timing record.

**Choose a model.**

```sh
clawdtime computer model                               # the model now, and where its key comes from
clawdtime computer model anthropic/claude-opus-5-5
clawdtime computer model together/MODEL                # a provider with no default needs one
clawdtime computer model custom/MODEL --base-url http://127.0.0.1:8080/v1
clawdtime computer model auto                          # back to the first provider with a key
```

The choice is `computer/model.json` in the state folder, with the same rules
as the key store. `CLAWDTIME_COMPUTER_MODEL` takes the same `provider/model`
and wins over the stored choice. A bare model, such as `gpt-4.1`, means
OpenAI, as before. With no choice, the planner takes the first provider that
has a key, in this order: OpenAI, Anthropic, then the rest of the table, with
its default model. Only OpenAI and Anthropic have a default. For any other
provider, choose a model that reads pictures. `clawdtime computer doctor`
says so when one is missing. The fallback from `gpt-5.4` to `gpt-4.1` is only
for OpenAI with no chosen model.

The base address of a custom service must use https, or http to this Mac
only (`localhost`, `127.0.0.1` or `[::1]`), with no name, password or query in
it. `CLAWDTIME_CUSTOM_BASE_URL` wins over the stored address. With no key, the
request goes with no key header.

Run the planner test before you rely on a new model. Both tests take
`provider/model`, and `@effort` after it for a reasoning effort. On the
Responses route the effort goes out as `reasoning.effort`, on chat
completions as `reasoning_effort`, and Anthropic takes `@low`, `@medium` or
`@high`:

```sh
npm run eval:computer:planner -- anthropic/claude-opus-5-5 together/MODEL
npm run eval:computer:planner -- gpt-6.2-astra gpt-6.2-astra@medium gpt-6.2-sol
npm run eval:computer:request -- anthropic/claude-opus-5-5 gpt-6.2-astra@low
CLAWDTIME_OPENAI_API=chat npm run eval:computer:planner -- gpt-6.1-terra@none
```

**What each provider gets.**

- **OpenAI**, as before: one forced function call and the large picture,
  the small picture for the outline. It
  gets `reasoning_effort` only when you set an effort, and only on a model
  that takes it: the `gpt-5` and `gpt-6` models that are not chat models,
  and the `o` models.
- **OpenAI on its Responses route**, for the `gpt-6` and `gpt-5.6` models or
  with `CLAWDTIME_OPENAI_API=responses`. It takes the same request in its own
  form. The rules are `instructions`. The turn is one `input` item of the
  person: the text as `input_text`, and each picture as `input_image` with a
  base64 data address and its `detail` (large for a step, small for the
  outline). Each function has `type: "function"`, its `name`, `description`
  and `parameters` at the top, and `strict: false`: not strict, as on chat
  completions, because the schemas have optional fields. The model, the rules
  and the functions come first, the same bytes in every step. The tool choice
  is `required` with `parallel_tool_calls` as on chat completions (two calls
  only with a plan). When the service refuses a forced choice (a 400 that
  names `tool_choice`), the choice is `auto` from then on, and the repair
  handles an answer with no call. On a model that reasons, the effort always
  goes out as `reasoning: {effort}`: yours, or `low` for a step and `medium`
  for the outline and the chat. Nothing is stored on the service (`store` is
  `false`), so the reasoning of an answer comes back encrypted (`include`
  names `reasoning.encrypted_content`), only for its repair. The repair sends
  the answer back as it came, then a `function_call_output` for each of its calls
  that says what was wrong, or those words as a message of the person when it
  had no call. A reasoning item with no encrypted content does not go back,
  and then neither do the ids of the service. The answer is read from the
  `output` items: `function_call` (its name and its arguments as JSON) and
  `message` (its words, and `refusal`, which is `refused`). A status
  `incomplete` for `max_output_tokens` is an answer cut at its limit, and gets
  the repair; one for `content_filter` is `refused`. A status `failed` with
  `server_error` or `rate_limit_exceeded` is asked again. The statuses of a
  failure mean what they mean on chat completions, and the fallback from
  `gpt-5.4` to `gpt-4.1` works there too. The use of tokens comes with the
  ones from the cache.
- **Anthropic**, through its official library (`@anthropic-ai/sdk`) and its
  Messages interface. Each picture is a base64 image block: the screen, and
  the closer look as a second one when there is one. Each function is a tool
  with `strict: true` on the models that take it, inside the limits of the
  service: 20 strict tools, 24 optional parameters and 16 parameters with a
  union type in one request. A tool past those limits goes without strict,
  and the limits that a strict tool cannot have (a smallest or a largest
  number, a length) are left out of it. The worker checks every action in
  code anyway. The tool choice is `auto`, with one call at most: current
  models refuse a forced choice, and the repair handles an answer with no
  call. No temperature and no thinking setting go out. The library never
  retries, so the planner's own retries are the only ones.
- **Refusal fallback of Anthropic.** On `claude-fable-5-2`, `claude-fable-5-1`,
  `claude-opus-5-5`, `claude-opus-5` and `claude-sonnet-5-5`, each request turns
  on the server-side refusal fallback (`fallbacks: "default"`, with the beta
  `server-side-fallback-2026-07-01`). When the model declines for a policy
  reason, the service runs the same request on its own fallback model, in the
  same call. When the whole chain declines, the answer is `refused`.
- **Every other provider** gets its chat completions route, with the key as a
  bearer token. It gets no forced tool choice and no effort: each takes these
  in its own way. An answer with no call, or with several, gets the repair.

**Speed.** Almost all of the time of a step is the answer of the model.

- The rules and the functions come first in every request, the same bytes
  from step to step. Only the turn after them changes. OpenAI keeps such a
  first part in its cache by itself. For Anthropic the rules carry one cache
  marker, so the functions and the rules come from the cache after the first
  step.
- Each answer tells how many tokens of the request came from the cache. The
  planner gives them, with the input and output tokens, to its `onUsage`
  callback.
- `CLAWDTIME_COMPUTER_EFFORT` is `low`, `medium` or `high`. Anthropic gets it
  as `output_config.effort`, and `low` when you set none, on the models that
  take it. OpenAI gets it as `reasoning_effort` when you set one. With none,
  the request of OpenAI stays as it was measured above. On the Responses route
  it is `reasoning.effort`, with `low` for a step and `medium` for the outline
  when you set none. Any other value stops the planner, and the doctor says
  why. An effort is no speed lever for `gpt-5.4`: on the planner test of 26
  Nov 2026 it was right 76 of 76 times with no effort (median 1893 ms), 75 of
  76 with `none` (1864 ms), and the service refused `low` with the functions
  (400). When the service refuses an effort, the same request goes out once
  more with none, and the planner sends none after that.
- `CLAWDTIME_COMPUTER_SPEED=fast` turns on fast mode (`speed: "fast"`) on
  `claude-opus-5-5`, `claude-fable-5-2` and `claude-mythos-5-2`. It costs more
  for each token. On any other model it does nothing, and the doctor says so.

The command that starts the desktop service passes every key variable of the
table, `CLAWDTIME_COMPUTER_MODEL`, `CLAWDTIME_COMPUTER_EFFORT`,
`CLAWDTIME_COMPUTER_SPEED`, `CLAWDTIME_CUSTOM_BASE_URL` and
`CLAWDTIME_OPENAI_API` to it.

### The planner test

`npm run eval:computer:planner -- gpt-4.1 gpt-5.4` measures a model before it
becomes the planner. Each argument is `provider/model`, or a bare model of
OpenAI. Each task is one decision: a goal and a rendered screen
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

Two of the small drawn targets, the x and the stars, also count a closer
look near them as a right step. One more task comes with a closer picture of
the stars, as after `look_closer`: the test renders it as the hands take it,
three times larger, and the right answer is a click on the third star, in the
closer picture or in the first one. In `--check`, a click in the closer
picture goes through the planner's own mapping, and the same point read as a
point of the first picture is a wrong answer.

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
delete that cannot be undone asks first, a switch turns, a dialog closes, a form signs in. A check of
what the app holds at the end says whether the request was done, so a "Done"
that the app does not confirm counts as a failure. The person of the test
answers the worker's questions, and types the password into the field when the
worker hands that over.

Some requests meet trouble on the way, as a real Mac and a real service give
it. A fault layer puts it in front of the planner's network call and of the
hands, and changes nothing in the worker or the planner: a rate limit (429
with a retry-after) and an outage (503) at chosen calls, an answer with no
function call, an answer whose arguments are not JSON, a window that moves at
its first four looks and then settles, a New note button that never works
while Command-N does, and a switch that ignores the first click. One more
request needs a fact that only the person knows (their work email): the
right way is a question, not a give up. These requests measure recovery. A
request counts as done only when the app holds the result at the end, as for
every other request.

`--new-actions` adds requests for the actions of the next planner: a menu
that opens only while the pointer rests on it, a card dragged to another
column, a slider dragged to 80 percent, one long scroll down a list, a list
of choices on a web page, a page that shows its result after a moment, and
the right one of three browser tabs. The browser requests drive tabs of the
headless browser with the browser driver and the page script of the product.
The planner test has the same flag for the same kinds of decision.

`--check` runs both tests with no model and no key. Each request plays
scripted paths through the same worker, apps, hands, faults and checks: an
ideal path must end done, and a wrong path (a guess, a done too early, the
wrong row) must not. Each planner task does the same with an ideal answer and
wrong answers. So the check proves that each case can be done and that its
check tells right from wrong, before any model is measured. A path that needs
an action that this build does not offer yet is skipped, and the line says
which. The transport of the scripted paths answers the outline of each
request with one subgoal, the goal itself, so every request runs with a plan,
and a done comes again after the note about an open subgoal. The hands of the
request test take a closer look too: the request with the drawn stars has a
path that looks closer first and clicks in the closer picture. Run it after
every change to a test or an app:
`npx tsx tests/computer-request.eval.ts --check --new-actions`.

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
  as before. Since November 25 a close asks only while the window shows
  unsaved changes: see "The guards".
- Text was typed with no text field in focus, went nowhere, and the request
  ended as done. The planner now reads "sent, but no text field had the focus"
  as the outcome of such a step, and looks for the text.
- Known limit: for "four of five drawn stars" the planner sometimes clicks the
  third star, and then says that four are filled (1 of 3 runs).

A real run showed one more thing, and the planner test now covers it: with a
sheet of another app left open ("Do you want to keep this new document?"), a
request about another app ("open Calculator and compute...") first pressed
"Delete" on that sheet to get it out of the way, 10 times in 10. The check
asked each time, so nothing was lost, but a yes would have thrown the document
away. One rule for the planner fixed it (a dialog that the goal does not speak
about is left as it is): the two new tasks are right 10 of 10, the planner
test 145 of 145 with 5 repeats, and the request test 38 of 39.

A second real run showed that "select all the text and replace it" typed with
no selection, so the word was added at the end, and the request ended as done.
The request test reproduced it 5 times in 5. The planner's `type` tool now says
where typed text goes (at the caret, added to what is there, in place of a
selection) and how to replace text (focus, Command+A, type). The new request
is done 3 times in 3, and the two new planner tasks are right 10 of 10.

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
and the action. A step also says, in fixed words, what the worker did to get
moving before it, and how long it waited: `To get moving: transient, settled,
waited 3400 ms`. The words are `nudge_swing`, `nudge_still`, `ask_swing`,
`ask_still`, `end_swing`, `end_still`, `give_up_nudge`, `settled`,
`unsettled` and `transient`. When the request ends before a next step, one
more line of the kind `end` says them.

The panel also says where its part of the step went, and the line then ends
with it: `(hands: capture 91 ms, encode 3 ms, image 158 KB, walk 287 ms, glide
352 ms, poll wait 0 ms)`. Capture is taking the picture, encode is writing it
as a JPEG, image is its size, walk is the Accessibility tree of every look of
the step, glide is the cursor before each input, and poll wait is how long the
commands of the step waited before the panel read them. Each part is there
only when the step had it. The panel sends these numbers in a header of the
result, `X-ClawdTime-Hands-Cost`. A service that does not know the header
takes the result as before.

`npm run bench:computer:speed` shows the same parts with no screen: the real
worker does one request with a planner that thinks for no time, over made-up
hands that act out the costs of the panel before this change and now. The
glide, the wait at the target and the read of the next command are the
panel's own rules; the picture and the walk are assumptions that the output
names. It opens no window and calls no language model.

The panel needs two permissions in System Settings, Privacy & Security:
Accessibility, and Screen & System Audio Recording. When one is missing, the
request ends as `blocked` and the message names the permission to grant.

### Repeats, the held split and a comparison

Both tests take the same flags. `--repeat N` runs every case N times (the
planner test runs 2 by default and the request test 1; `REPEATS` still
works). The output gives each case its passes out of N with a 95 percent
interval and its median and 90th percentile time, then the pass rate of each
model with its interval, and the flaky cases: those that passed in some runs
and not in all. The interval is the score interval of a share. 2 of 2 is 34 to
100 percent, so a case with few runs proves little.

A fixed quarter of the cases of each test is held (`held: true` on the case),
chosen once by a hash of its name. `--split dev`, `--split held` or `--split
all` (the default) runs those cases. The rule: tune prompts and rules only on
dev, and judge a change on held. A new case is held when `heldByHash` in
`tests/computer-eval-stats.ts` says so.

`--out FILE.json` writes the result of each case and every run.
`--compare A.json B.json` reads two such files and runs nothing. It prints the
pass rate before and after for all, dev and held cases, the difference with
its 95 percent interval, the median time, and each case whose pass rate
changed. A difference of the pass rate is beyond the noise when its interval
leaves out zero. A single case is beyond the noise only when its two intervals
do not overlap. When a change wins by a small margin, run both again with more
repeats before you keep it. `--check` takes `--repeat`, `--split` and `--out`
too, with no network, and a check that does not give the same verdict in every
run fails.

```sh
npm run eval:computer:planner -- gpt-6.2-sol --repeat 3 --out before.json
npm run eval:computer:planner -- gpt-6.2-sol --repeat 3 --out after.json
npx tsx tests/computer-planner.eval.ts --compare before.json after.json --split held
```

### Give it a task

Talk to ClawdTime: in the chat of the panel, by voice, or on a phone call. Your
own words are the task. Three ways lead to the worker, and all are code in
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
- **When the code reads the road.** With the worker on and free, the code
  reads which road your words take, before the language model (see "Which
  road a request takes" in [the supervisor page](SUPERVISOR.md)). Work in an
  app, on a web page or in an account goes to the worker, also when your words
  do not name the screen: "follow up on my latest X posts", "reply to Sam on
  Slack", "book the 3pm slot". The worker gets your words whole, and plans.
  Code work goes to a job, and a message with both parts starts the job first
  and then hands the screen part to the worker.

A question, a bare yes or no, a request for the state and a sentence about a
session or an agent are never handed over, whatever the model asks. A question
about what ClawdTime can do, in the form of a polite request with a generic
object and no target ("Can you click buttons on my screen?", "can u use my
mac?", "are you able to open apps", "can you look things up?"), is answered
and starts nothing, on every road to the worker (`asksWhatItCanDo` in
`orders.ts`). "Can you click the Send button?" and "can you search running
shoes?" name a target and start a task. A
question that asks for a reading of an app or a page ("did Sam reply on
Slack?") goes to the worker by the code's road.

The supervisor also has a tool for the browser that runs (reload, back,
forward, tabs, read a page) and one that reads the screen from a picture.
While the worker is on, neither is offered to its language model, and a call
of one goes to the worker. They stay for when the worker is off.

The result of a task is the last word: the chat says it in one line and
offers no next step after it. A result that shows a problem, such as a page
that did not load, is for the worker to handle before it ends.

**From a phone call.** A call asks through `clawdtime chat TEXT`. That command
now hands the text to the running desktop service, so a caller's request
reaches the worker as the same words in the panel's chat do. See "One message
from a command, and the desktop service" in [the supervisor page](SUPERVISOR.md)
for how the command finds the service, and what it does when none answers.

## The actions

The planner answers with one of these actions. `ports.ts` holds their exact
shapes.

On the screen:

- `click_element` and `click_at`: a click on an element by its number, or on a
  point of the picture. A double click and a right click too.
- `type`: one line of text at the caret, or into a field by its number.
- `key`: one key with its modifiers, for example `cmd+s`.
- `scroll`: at an element or at the middle of the screen. `amount` says how
  far, from 1 to 10 notches of the wheel. Without it the wheel turns 5 notches.
- `hover`: the pointer goes to an element or to a point and rests there, with
  no click. A menu or a tooltip that shows on hover opens. The planner gives an
  element or a point, never both.
- `drag`: the hands press at one end, move to the other end and let go. Each
  end is an element or a point. It is for a card, a slider, a file or a window
  that must move.
- `open_app`, `quit_app` and `open_url`: an app or a web address by its name,
  with no pointer and no key.
- `look_closer`: a larger picture of one part of the screen around a point,
  for the next turn. It sends nothing to an app. See
  [A closer look](#a-closer-look).
- `wait`, `ask`, `done` and `give_up`.

In the browser, when the driver is on:

- `browser_read`, `browser_open`, `browser_click`, `browser_type`,
  `browser_scroll` and `browser_back`.
- `browser_hover`: the pointer rests on an element of the page, with no click.
  The page hears the events of a pointer that comes and goes.
- `browser_select`: picks one option of a list of choices by the text that the
  option shows. A select of the page takes the choice and hears input and
  change, as with a person. In a list that the page draws itself, the option is
  pressed.
- `browser_key`: one key in the element of the page that has the focus: Enter,
  Escape, Tab, Shift+Tab, the arrow keys, PageUp, PageDown, Home, End,
  Backspace or Space. A key event of a script does nothing by itself, so the
  page script does what the browser does: Enter in a field of a form submits
  the form, Enter or Space presses a button, Space sets a checkbox, Tab moves
  the focus, Backspace takes away one character, and the scroll keys move the
  page. The page can stop the key, as with a person.
- `browser_wait`: reads the page until its text holds the words, or until the
  time runs out, from 100 to 10000 milliseconds. With no words it waits until
  the page has loaded and holds still. It changes nothing. The planner reads
  whether the words came.
- `browser_tabs`: lists the tabs of the front window, with a number for each.
  It changes nothing.
- `browser_switch_tab`: brings one tab of the last list to the front of its
  window. The browser itself does not come forward.

The planner gets a browser action only when the driver has its method:
`browserMethods` in `guards.ts` reads them from the driver. The checks refuse
an action whose method the driver lacks.

### A closer look

A small thing that has no element in the Accessibility tree (one star of a
rating, a small icon, a check box, a thin line) can be hard to tell apart in
the picture of the whole screen. The planner can then call `look_closer` at a
point of the picture. The code is in `connectors/computer/closer.ts`.

- **The part.** A quarter of the picture's width and of its height around the
  point, moved inside the picture near an edge.
- **The picture.** The hands take that part of the screen, three times
  larger than the same part of the last picture (command `zoom`). The
  windows of ClawdTime are left out, as in every picture. Nothing is sent to
  an app, and no question is asked.
- **The next turn.** The planner gets the closer picture as a second picture,
  with the part of the first picture that it shows, for that one turn only.
  To click a thing in it, the planner calls `click_at` with `closer` true and
  a point of the second picture. The planner turns that point into a point of
  the first picture, so the worker and its checks see an ordinary click, and
  all of them run as for any click. A `click_at` with `closer` in a turn with
  no closer picture, or with a point outside it, goes back to the model once
  as a malformed answer. The point is never guessed.
- **A look, not an input.** A zoom whose result never comes back makes
  nothing uncertain: the request stops as for a silent panel. The person's
  mouse during it pauses nothing.
- **A few for each request.** A request sends at most 6 closer looks. The
  next one is refused, and the planner reads why.
- **No password field.** A part with a password field in it, or within 8
  points of one, is refused before the zoom. When the look after the zoom
  finds a password field in the part, the closer picture never goes to the
  planner, and the planner reads why.
- **The same screen.** The closer picture goes to the planner only with a
  look of the screen it was taken of: the same app and window in front, the
  same display and the same size of picture. When another app came to the
  front, the picture stays back, and the planner reads why.

The panel scales the part to the asked size (`scalesToFit`): without it, the
part stays at its own size in a corner and the rest of the picture is empty.
A capture on the laptop showed the difference.

## The guards

The planner's output is an untrusted single-action plan. These rules are code
in `guards.ts` and `worker.ts`. None of them depends on the prompt.

### When the worker asks for your yes

A question can reach you while you are away, by a FaceTime call or by a
message. So the worker asks only before an action that cannot be undone and
costs money, data or trust. It does everything else with no question. One
table in `guards.ts`, `askPolicy`, holds the rows, and every question comes
from one of them.

| Row      | Asks before                                                                                                                                                                                                                                                                                                                                                                                                                     | No question when your request                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| pay      | Buy, Pay, Place order, Subscribe, Donate, Send money, Book, Rent, a button that is only a price, a Confirm or a Submit while the screen shows a total, a Continue where the screen says that it charges ("your card will be charged"), a Transfer of an amount, and the same names in other languages ("Jetzt kaufen", "Pagar", "Payer")                                                                                        | (always asks)                                                                                            |
| loss     | Delete forever, Empty Trash, Erase, Delete account, Uninstall, Terminate, Factory reset, Revoke, Overwrite, Shut down, a log out of the Mac, a Delete, Remove or OK where the screen says that it cannot be undone, a Replace of a file that exists, a terminal command that deletes for good (`rm`, `find -delete`, a delete in a script, a move to `/dev/null`), and a terminal move of files that your request does not name | (always asks)                                                                                            |
| unsaved  | Don't Save, Discard, Revert, every button but Save of a sheet that asks to save (also its Delete for a new document that was never saved, where the sheet says that it cannot be undone), and a quit or a close while the window shows unsaved changes ("Report (Edited)")                                                                                                                                                      | asks to lose the changes: "without saving", "discard", "throw away"                                      |
| send     | Send, Reply, Reply All, Forward, Post, Comment, Publish, Submit, Share, Return in a messages or mail app, the submit of a message box, a terminal command that publishes (`git push`), and an address with a long part that you did not write                                                                                                                                                                                   | asks for a send of that kind, to the people that the screen shows. A long part of an address always asks |
| public   | Like, Follow, Repost, Upvote                                                                                                                                                                                                                                                                                                                                                                                                    | asks to like, follow or repost                                                                           |
| account  | a change of a password, two-factor, recovery, privacy or visibility, a switch of the security and privacy settings of macOS, and a terminal command that runs as an administrator (`sudo`), changes the security of the Mac or runs code from the web                                                                                                                                                                           | (always asks)                                                                                            |
| grant    | Allow, OK, Approve or Trust in a permission dialog of macOS, of a site, of a sign-in that asks for access to your account, or of ClawdTime, and a name that grants access ("Grant access", "Open Anyway")                                                                                                                                                                                                                       | (always asks)                                                                                            |
| terms    | Agree or Accept for terms that bind you                                                                                                                                                                                                                                                                                                                                                                                         | (always asks). A cookie banner with no words of binding terms is no such terms                           |
| terminal | typing or a key in a terminal, a paste into one, and a drop onto one                                                                                                                                                                                                                                                                                                                                                            | asks for terminal work: a command, a script, a build, a test, git. A paste asks always                   |
| trash    | a drag that drops onto the Trash                                                                                                                                                                                                                                                                                                                                                                                                | (always asks)                                                                                            |
| secret   | a drag that starts in a password field                                                                                                                                                                                                                                                                                                                                                                                          | (always asks)                                                                                            |

These need no yes: opening and quitting an app, closing a window, a tab, a
banner, a sheet or a dialog that loses nothing, an OK or an Approve of a dialog
whose effect is in no row, a cookie banner (the planner picks the choice that
shares the least), a download, a move, a drag that does not end on the Trash,
a cart and the pages of a checkout up to its last step, a plain Delete that
can be undone (Move to Trash), a log out of a site, a switch of a desktop or a
tab, a scroll, a hover, a link, and any site that the task needs.

How the rows read a name:

- **Whole words.** "Sender", "Postpone" and "Formatting" ask nothing. A word
  of a send counts at the start of a name: "Send" and "Send now" ask,
  "Resend code" and "Send to Back" do not.
- **An ellipsis.** A menu item of macOS that ends with one ("Empty
  Trash...") only opens a dialog. It asks nothing: the button of the dialog
  asks. The Restart, Shut Down and Log Out items of the Apple menu ask: their
  dialog acts by itself after a minute. A web page writes its labels as it
  likes, so on a page, and on any button, an ellipsis lifts nothing: "Place
  order..." asks.
- **Other languages.** The names of a payment, a delete and a send in the
  languages that shops and apps use most ask too: "Jetzt kaufen",
  "Zahlungspflichtig bestellen", "Comprar ahora", "Endgültig löschen",
  "Senden".
- **The screen around it.** A total on the screen makes a Confirm a payment.
  "You can't undo this action" makes a Delete, a Remove or an OK a loss. "Do
  you want to save" makes every button of the sheet but Save a loss of
  changes. A permission request ("would like to access your contacts") makes
  Allow and OK a yes in your place. "Don't Allow" asks nothing: it shares
  less.
- **Your request.** It asks for a send when one of its parts starts with a
  verb of a send: "Reply to Sam", "read it and reply". A noun is no verb
  ("read my messages"), and a denial asks for nothing ("do not reply"). Words
  that turn to ClawdTime ask for no send: "text me when it is done", "message
  me the total", "answer the question". A verb lifts only a send of its own
  kind: "Reply to Sam" lifts Reply and Send, not Reply All, Forward or Share,
  which need their own verb. When the request names a person and the screen
  shows who a message goes to ("To: Jane"), each of them must be named in the
  request. Only the request itself counts, and only until you say more. After
  your first added words such an action asks again, whatever the words say.
  A request that holds the work back, puts it off or makes it hang on
  something ("hang on, reply to Sam", "reply to Sam tomorrow", "reply to Sam
  but wait for me") says no yes ahead of time: every action of the table asks.
- **A text field.** A click that only gives a text field the focus asks
  nothing.
- **A point or an icon.** For a point with no named element, for a control
  with no name (an icon chosen by its number, on the screen or on the page),
  and for a large element that only holds others, the planner's own reason is
  read for the same words. It can add a question. It never removes one.
- **A terminal line.** The worker cannot see what is typed on the line
  already, so text that starts with the end of a command that deletes or
  moves is read as that command too: "r", then "m -rf ~", asks.
- **Return and Space.** They ask while a button, a menu item or the element
  with the focus could take the key and would ask, unless a text field has the
  focus. In a page Enter and Space ask while any control of the page would
  ask.
- **Keys.** Command with Shift and Q logs you out of the Mac and asks. So do
  Command with Option and Delete, and Command with Shift and Delete, in
  Finder: they delete at once and empty the Trash. Command with Q and Command
  with W ask only while the window shows unsaved changes. Command with Control
  and Q only locks the screen, and asks nothing. The power key and the media
  keys are never sent.
- **The same action again.** It asks nothing. The row of tries that changed
  nothing and the progress guard answer a loop (see "When the task does not
  move on").

Each question is short enough for a phone call. It says what the action does,
where, and what it costs or loses, and it ends with "Say yes or no.":

> Click "Place order" on shop.example? It spends your money: 48 dollars for 2
> items. Say yes or no.

The cost is the total that the screen or the page shows, else the price on the
button. A question of the screen names the app in front ("in Finder"), a
question of a page names its site. A no ends the request.

### The other rules

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
- **A quit.** The planner quits an app by its name (`quit_app`). The hands ask
  the app to quit the polite way, as its own Quit does: no key goes out and
  nothing is forced. An app that asks about work that is not saved stays open,
  and the planner reads that and looks. It works for an app with no window
  too, where no key can be sent. The worker asks first only while the app is
  in front and shows unsaved changes.
- **A submit in the browser.** Enter in a field submits its form. It asks when
  a control of the page would ask ("Place order"), or when the field is a
  message box and your request does not ask to send. A search asks nothing.
- **Keys that edit text go to text.** Select all (Command+A), cut, paste and
  delete a word (Option+Delete) are held back when the look just before them
  names elements and none of them takes typing with the focus. The planner
  reads "No text field has the focus. Click into the text first." It counts
  as a refusal. A look that names no element cannot say where the focus is,
  and the key goes as before. A text field is not the only thing that takes
  typing: a spreadsheet cell or its sheet (AXCell, AXTable), a grid
  (AXGrid), the canvas of a document (AXLayoutArea), a web page that draws
  its own editor (AXWebArea, as web sheets and slides do) and the view of a
  document (AXScrollArea) count too, and so do they for the note "sent, but
  no text field had the focus" after typed text. Return and Space still
  count only a text field: a list or a sheet with the focus passes them on
  to the default button of the window.
- **You take over.** When the hands report that you moved the mouse or pressed
  a key, the worker pauses. Your next message goes on with it, and a stop
  stops it.
- **Done is checked.** `done` counts only after an observation that came after
  the last action.
- **Links.** Only http and https links are opened, with no login in the link.
  An address that the task needs opens with no question, also when your
  request does not name its site: a shop, a feed, a page to read. Only an
  address with a long path or query (more than 120 characters) that you did
  not write asks first: such a part could carry what the screen shows to the
  site. After you said more during a task, such an address always asks.
- **Opening an address.** A request that only opens one address ("open
  example.com", also with the name of a browser after it) opens it as its
  first step, with no model, no pointer and no key, in the browser that you
  named or in the usual one. The planner opens every other address with
  `open_url` too, never through the address bar. A bare name with an ending
  that files have too ("MANIFEST.in") goes to the planner unless a browser is
  named. The sent address is not the page: the worker looks at the screen
  again before it says done.
- **The browser.** The planner names a browser only when you named one. The
  hands look for it only among the apps in the usual app folders that open web
  addresses.
- **Typed text is one line.** A line break or a tab in typed text is refused.
  Return and Tab are keys of their own, so the key rules see them.
- **A hover.** It sends no click and no key, so it needs no yes. It may rest on
  a disabled element, whose tooltip can say why it is off. The look just before
  it finds the same element again, or the same thing under the point.
- **A drag.** Each end is checked as a click: the element must be in the last
  observation, enabled and on the screen, and a point must be inside the last
  image. The two ends must be at least 4 points apart. The worker asks first
  when the drag ends on the Trash or on a terminal app, when a terminal is in
  front, when it starts in a password field, and when either end has a name
  that a click asks about ("Delete forever"). It never drops onto a password
  field: what is dropped there is typed there. For an end with no named
  element, the planner's own reason is read for the same words. The look just
  before the drag finds both ends again. When either one moved or is gone,
  nothing is sent.
- **A choice in the page.** It follows the rule of a click: an option whose text
  asks ("Delete permanently") asks. The element must be a list of choices that
  is not disabled. Just before the choice the page is read again and the same
  list is found again.
- **A key in the page.** Enter and Space can press what has the focus, and a
  reading does not say what has the focus. So either key asks while any
  control of the page that is not a field would ask on a click ("Pay now",
  "Send"). The page script never presses a key while a password field has the
  focus. Just before the key the page is read again and the checks run again:
  when the page changed what the key can press, no key goes.
- **A wait and a list of the tabs.** They change nothing. They need no yes,
  they count as no repeat, and a wait or a list with no answer makes nothing
  uncertain.
- **A tab switch.** It needs no yes. Its number must be in the last list of the
  tabs. Just before the switch the worker lists the tabs again and finds the
  same tab by its address and its title. When it is gone, or two tabs could be
  it, nothing is sent.

## The owner's trust

With `CLAWDTIME_COMPUTER_TRUST=on` in the environment of the desktop service,
the worker asks no question before an action of the ask policy: it pays,
deletes, sends and grants as the request and the screen lead it, and the
record keeps which row of the policy each such action passed
(`trusted_pay`, `trusted_loss`, ...). With trust a pause also ends by itself:
after 60 seconds with no message, the task goes on (see Words while a task
runs). It is off unless the owner turns it on.
What stays: Stop, the hands bar and holding Escape; the last look before an
input; no input sent again when its result is not known; the checks that
refuse (a password field gets no typed text, the power key is never sent);
and a password or a code is still typed by the person, by a call when the
person is away. A page or a screen can hold words written to lead the
planner. With trust on, nothing stops such an action before it goes out.

## Questions and answers

A question shows in the chat. Your next message is its answer. The worker reads
a yes or a no with the same conservative reader that reads a yes on a phone
call (`interpret` in `connectors/agents/call.ts`). Words that are not a clear
yes or no change nothing, and the question is said again. A no ends the request.

A pause is no question. Any next message ends it, and words that steer go into
the task: see Words while a task runs.

A yes is for what you were asked. The worker looks again after your answer. If
the screen is another one by then, it sends nothing and the planner starts
again from a new look. When the planner then chooses the same action, with the
same question, in the same app and window, your yes still holds: you are not
asked the same thing again. That is so for one minute and for two tries at
most. Any other action, and the same button in another app or window, asks
anew. On a real Mac the question itself changes what is in front, so before
this rule an approved click was never sent and the question came again without
end.

A sheet, the dialog that hangs from a window ("Do you want to save?"), is a
window that the hands can act on. It has no title of its own, so it is known by
its app and its frame as the top window.

A small window of the same app in front of the focused window does not take the
window away from the hands. A browser shows the suggestions of its address bar
in such a window. A card and a status line are windows like it. The focused
window stays the window that the hands act on, when each window in front is of
the same app, touches the focused window and is not a window in its own right.
Accessibility says what each window of the app is. Only a window of the kind
"unknown" and a help tag are parts of another window. A standard window, a
dialog, a sheet and every other kind stand alone: one of those in front is
another window, and the hands then send nothing. At most four such windows may
lie in front, and together they may hide at most 90 percent of the focused
window.

- **A click.** No click, drag or scroll goes to a place under a window in
  front: the look does not say what is there. The hands report that the target
  is not visible. The planner can use the keyboard there: the arrow keys,
  Return, Escape.
- **One key.** The windows in front must be as they were at the look. A list
  that opened, closed or changed after the look is not the list that the
  planner saw: the key is not sent and the worker looks again.
- **Typed text.** It goes on while a list of suggestions changes its size.
- **Where the keys go.** To the focused window of the app, which is the window
  of the hands. It is read again before every key and every few typed
  characters. A window in front that took the keyboard would be the focused
  window, and nothing more is sent.
- **After the first event.** The first press of a double click can open a
  list. The second press still goes only when its place is under no window in
  front.
- **A window that shows nothing.** It is kept with how solid it is. One that
  starts to show between the look and a click or a key stops that input.
- **The look.** The picture shows the windows in front. The list of elements
  is whole: the worker reads it to know what Return would press.

Some apps keep a window in front that shows nothing: a status line that is
empty now, a layer for a part that comes later. A person works through it. It
is no cover, its size does not count, and a click under it goes. It must still
be of the same app and no window in its own right. The strip that a
full-screen app keeps over the top of its window is no cover either.

A move to another app or to another desktop keeps the old rule: it starts only
from a focused window with nothing of its app in front.

Before this rule the focused window always had to be the top window of the
list of the window server. With the list of an address bar open there was no
window for the hands, every look said that the desktop had changed, and nothing
was sent after the first key in an address bar.

Text for a field that has the focus goes in with no click before it. A click
moves the caret and drops a selection, so "select all, then type" added the
text in place of replacing what was selected.

The other way round, a key that edits text needs a text field with the focus.
With the closer look in the planner, the request test "replace the text of a
note" clicked the note in the list and then pressed Command+A before a click
into the note, in 2 of 3 runs: in a list, Command+A selects the rows, and the
text typed next goes nowhere. The worker now holds such a key back
(`text-keys.ts`) and tells the planner to click into the text first. A unit
test with a scripted planner covers it. The request test has not run again
since.

`clawdtime computer timing` also says why a step was held back, in the
worker's own fixed words: "Not sent: Another app or window came to the front."

A question of the planner starts with "The task asks:". Its answer goes back to
the planner as text and allows nothing in code. An answer that holds a password
or a key is not passed on: type it into the field on the Mac yourself.

When an agent's request waits on the desk at the same time, your message
answers neither. Answer the agent's request first, in the panel or in its
terminal.

On a phone call nothing says a question by itself. Ask "computer status": the
answer is the question that waits. Then say yes or no. Both go to the desktop
service through `clawdtime chat TEXT`.

### When you are not at the chat

A question that waits too long in the chat reaches you by itself. The code is
in `connectors/computer/reach.ts`.

1. The worker asks a yes, a sign-in, a code or a choice. The reach reads that
   from the worker's own status, as the panel does.
2. When nobody answers in the chat for 45 seconds, ClawdTime calls you once on
   the Chert line. It says the question in one or two plain sentences. A
   request that came from a call, from a text or from a routine does not wait:
   the reach goes at once. `CLAWDTIME_COMPUTER_REACH_SECONDS` in the
   environment of the desktop service sets the wait, from 0 to 600.
3. What you say on that call goes to the worker as an answer in the chat does.
   A question that waits for your yes takes only the strict yes of the chat
   ("yes", "yes, go ahead", "approve it") or a plain no ("no", "don't send
   it"). Words with a doubt, a condition, a delay, a refusal that is no plain
   no, or a thanks ("ok, hold off", "yes, but later", "yes, only if it is
   under 20 dollars", "ok thanks") approve nothing: the question waits, and
   the call or the text says it again. A no ends the request. Stop stops it,
   also through the stop tool of the call.
4. When the call fails, is not answered, is not dialed within a minute, or the
   line is not set up for calls, ClawdTime texts you once: the question, and
   how to answer it. Your reply to that text goes to the worker the same way.
5. When the request ended blocked, the call or the text says why, and what
   you can do. Nothing runs from your answer to it.

What holds every time:

- One call and one text at most for one question, also after a restart.
  There is no second call, whatever came of the first one. A call that you
  picked up gets no text after it.
- A newer question replaces an older one. A call for the older one that was
  not dialed yet is taken back.
- An answer in the chat, Stop, or the end of the request takes back a call
  that was not dialed, and ends a call that rings for it. No text follows.
- A sign-in or a code is never asked for by voice or by text. The call and
  the text say what is needed and where, the site or the app, and that you
  sign in on the Mac or once in ClawdTime's own browser profile. Words that
  look like a password or a code (also a bare run of digits) are not passed
  on, so they never reach the planner.
- A card, bank or identity number is never asked for either: a card number, a
  CVV, a social security number, a routing or account number, an IBAN, a
  passport or a tax number. The call and the text say only that you enter it
  on the Mac yourself, then say done. A reply that holds such a number is
  refused and never passed on. For a question that asks for one, a reply with
  any digit is refused.
- The call goes through one of two call paths (see "Which call path" below):
  one spoken alert for one question, with the same rule against a redial. It
  shares no screen, so the worker keeps the screen while it rings and can take
  the answer that you say on it.
- Every attempt and its outcome is kept in `computer/reach.json`: the kind of
  question, the times and one fixed word for each outcome. Never a question,
  an answer or a typed text.

The reach is on when the worker is on. `CLAWDTIME_COMPUTER_REACH=off` turns it
off.

#### Which call path

The desktop service gives the reach one call path when it starts:

- **The retained provider** (`chert-dev-retained-v1`), when `proactive.json`
  of the desktop service names it and the service could load it. It also
  needs one active calling policy of the project with the `decision` trigger
  and the `phone_alert` channel (and `failure` for a request that ended
  blocked). This provider runs only with one pinned build of
  `@trychert/facetime` and of Node.
- **The Chert Calls API** (`chert-calls-api`, in
  `connectors/computer/calls-api.ts`), in every other case. It works with any
  build of the chert command. It is ready when these are there: the project
  API key (`chert-key.json`, or `CHERT_API_KEY` with `CHERT_PROJECT_ID`), the
  line of the project (`calls.json`, which `clawdtime connect` writes, or
  `CHERT_LINE_ID`), your number with your yes (`owner.json`), and the LiveKit
  keys, `OPENAI_API_KEY` and `AGENT_NAME` in `line/.env.local`.

`clawdtime computer doctor` says which path is ready ("calls to you: ready
(Chert Calls API)"), or the exact piece that is missing.

#### A call over the Chert Calls API

1. The desktop service makes a new LiveKit room for the question, in the
   LiveKit project of `line/.env.local`, and sends the line agent into it
   through the agent dispatch API of LiveKit. The job metadata is
   `{kind: "reach", requestId, questionId, question, answerOrigin}`. It holds
   no key and no token. The line agent reads its capability for this one call
   from an owner-only file, `computer/reach-calls/<questionId>.json`.
2. The line agent joins, publishes its audio and says that it is ready. Only
   when LiveKit shows it alone in the room, with one audio track that is not
   muted, is the call placed. When it does not come within 25 seconds, no
   call is placed and the text goes.
3. The call: `POST /api/v1/calls` of `https://facetime.trychert.com`
   (`CHERT_CALLS_API_BASE` changes it), `mode: customer_managed`, your number,
   the line, audio always and video only when the line has video, a bridge
   token for this one room with its own identity (15 minutes), and the
   identity of the line agent. The idempotency key belongs to the question. A
   request that got no answer at all is sent again, at most twice, with the
   same body and the same key, so it can never place a second call. Any
   answer of Chert ends the retries.
4. The desktop service reads the call and its events about once a second. On
   `bridge_ready` it sets `chert_bridge_ready: true` in the room metadata, and
   the line agent greets with the question.
5. The line agent posts your words to `POST /computer/reach/call/<questionId>`
   of the desktop service, with its capability. They go to the reach as an
   answer said on a call, only once FaceTime is ready: the line agent greets
   on the ready mark alone. Stop stops the computer task. The line agent never
   asks for a password, a code, a card or another private number: a question
   that asks for one, or names one, is not said, as a second check after the
   reach's own. The copy of the question in the LiveKit job has no long
   numbers; the line agent says the one that the desktop service gives it.
6. Once your answer settles the question, the line agent says a short
   goodbye and leaves, and the call ends (`POST /api/v1/calls/{id}/end`, with
   its own idempotency key). A call also ends when it rings 90 seconds without
   FaceTime being ready, 4 minutes after it was ready, or when the question
   goes away.
7. The outcome goes to the reach: answered (you picked up), no answer, failed
   (no call reached you) or unknown. The text then goes exactly as with the
   other path. An unknown outcome stays unknown and is never placed again,
   also after a restart. A call that Chert had allocated when the desktop
   service stopped is ended when it starts again. `computer/reach-calls.json` keeps ids, states and
   fixed codes, never a number, a key, a token or a word of the question.

The line agent must run the code of this checkout with the same LiveKit keys,
and with the same state folder (`CLAWDTIME_CONFIG_HOME`) as the desktop
service. Restart it after an update. A line that is in another call gets no
reach call: the text goes instead.

#### Texts

It texts when the settings of the
text channel (`CHERT_API_KEY`, `CHERT_PROJECT_ID`, `CLAWDTIME_OWNER_PHONE`,
and `CHERT_LINE_ID` or a first text from you) are in the environment of the
desktop service. `clawdtime computer doctor` says for both whether they can
reach you, and why not.

`clawdtime connect` sets up both, step by step, and says what is still missing.
See "Connect to Chert in one command" in [the setup guide](../SETUP_CLAWDTIME.md).

A text of yours reaches the worker only when `clawdtime texts run` hands it to
the desktop service. It does that first now, as `clawdtime chat TEXT` does for
a call, and it marks the text, so that the service knows these exact words
came by text.

## Routines

A routine is one request that the worker gets at a time of day. Say or type
it, in the chat, on a call or by text:

> every morning at 9, follow up on my latest X posts and tell me

Or run it:

```sh
clawdtime routine add every morning at 9, follow up on my latest X posts
clawdtime routine list
clawdtime routine pause ID
clawdtime routine resume ID
clawdtime routine remove ID
```

The time reads as "every day", "every morning", "every evening", "every
weekday" or a day by name, with "at" and an hour, as in "at 9", "at 8:30 am",
"at 6pm", "at noon". "every morning" alone means 09:00 and "every evening"
18:00. In the chat you can also say "list my routines", "pause routine ID" and
"remove routine ID".

- Routines are off until you add one. They live in `computer/routines.json` in
  the state folder, for its owner only. A request that looks like a password
  or a key is not kept.
- At its time the routine hands its request to the worker in your words, as a
  request of its own. Every rule of the worker holds for it.
- It starts only when no other request runs and no call is live on the line.
  Otherwise it waits once, up to five minutes, then skips that time and texts
  you that it skipped.
- A time that passed more than 15 minutes ago, while the Mac slept or the
  service was stopped, is not run late. The next time counts.
- The same time never starts a second request: the id of the run is made from
  the routine and its time.
- When the request ends, the routine texts you its result. When the request
  needs you on its way, the reach calls or texts at once. With no text
  settings, the result is said in the chat.
- Pause and remove do not stop a request that already runs. Stop does.

The desktop service runs the routines, with the worker on.

The chat of the panel stays open when you send a message. A click on the mascot
opens it. The panel closes the chat only when a run really starts, so that it is
not in the way of the hands. It reads which engine the service has from
`GET /desktop/computer`, every few seconds.

The panel shows no status of a run and no running message. A small window beside
the mascot shows only while a question of the worker waits for you (`waiting` is
`approval` or `question`, or the engine holds an action for a yes): the question,
**Approve** and **No**. **Approve** and **No** send "yes" and "no" through the chat,
the same gate as typed words, once for each question. The window hides at once when
nothing waits. A pause because you took over the Mac is no question: the bar says
"Waiting for you".

## Stop

Three ways: say `stop` in the chat, by voice or on a call, press **Stop** on the
bar at the top of the screen (or hold Escape), or run `clawdtime computer off`.
The button uses the existing route `POST /desktop/execution/stop`. That route
belongs to the engine that the service picked: the worker has it only when it is
the engine.

During every run the panel shows one thing with a Stop button: the bar at the top
of the screen, "ClawdTime is using this Mac". The panel's own hands show it while
the worker runs. For another engine the panel shows the same bar while that engine
reports work that can stop, and until a Stop of yours is confirmed.

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

Before the hands click, hover, scroll, drag, type, press a key, or open an app
or a link, a cursor glides to the place and says what happens there. Only then does
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
- **The look.** The cursor is ClawdTime's own: a small solid arrow in the
  orange accent of the panel, with three short rays at its tip, as a click is
  drawn. The arrow points up and to the left. All its corners are round, and
  its back has a short notch. The rays fan out from just beyond the tip: to the
  left, up and to the left, and up, 45 degrees apart. A soft orange glow is
  around the arrow and the rays. A thin darker edge and a very soft shadow keep
  the arrow clear on a white window. The orange is that of the theme: `#FF8040`
  in light, `#FF8A50` in dark. `GuidedCursorArt` draws the pictures.
- **The tip is the place.** The tip of the arrow is its hot spot: the point
  where the hands act is exactly at the tip. The tip is round, so the hot spot
  is not the corner of the outline. It is the front of the round tip, on the
  line that halves the corner, `r / sin(a / 2) - r` inside it (`r` is the
  radius of the tip, `a` its angle). Each picture has the hot spot at its exact
  middle, on a pixel border, and the view puts the middle of each layer at the
  tip on a whole pixel. So the tip is within half a pixel of the place. Tests
  render the arrow at 1, 1.5, 2 and 3 pixels a point and find its painted tip
  within 1 point of the place.
- **Two pointers.** The pointer of the Mac stays the person's. When the hands
  bring it to the place for a click, a scroll or a drag, its tip meets the tip
  of the arrow. Both point at the same spot.
- **The label.** Each command for the hands comes with a short label from the
  worker: `Click "Save"`, `Type in "Search"`, `Press cmd+s`, `Scroll down`,
  `Open Notes`, `Hover over "File"`, `Drag "Card" to "Done"`. The cursor shows
  it in a pill just below and to the right of the arrow, as one line of at
  most 44 characters. Near the right edge of the screen the pill goes to the
  left of the tip. Near the bottom edge it goes over the tip, clear of the
  rays. The pill is always whole on the screen and never lies on the arrow.
  The label of typed text never holds that text. The label of a key names the
  key, and the label of a click names the element as the screen names it.
- **The glide.** The cursor goes on from where it is. The first time it comes
  out of the mascot. A glide takes 0.15 seconds, and 1 ms more for each 4
  points of the way, up to 0.26 seconds: the usual way of 150 to 400 points
  takes 0.19 to 0.25 seconds. The cursor then waits 0.10 seconds at the
  target. So a glide and its wait take 0.38
  seconds at most, where they took up to one second before. The picture of a
  call defaults to 20 frames a second, so the shortest glide is in three of
  them. The cursor stays 3 seconds after the command and then fades: longer
  than a look and a plan, so it goes from one action to the next.
- **The same place.** When the cursor already points at the target (the next
  key in the same field, or more text in it), it does not glide. It waits
  0.05 seconds, one frame of a call, for a new label, and not at all when the
  label is the same. After the glide the real pointer of the Mac travels
  there too, as a hand moves it: on a slight curve, in 0.15 to 0.24 seconds
  (0.18 to 0.22 for a usual way), so you see it go, before a click, a scroll
  or a drag. Its events carry a mark, so the watch never takes them for yours.
- **The click.** The arrow and the rays stay still. At a click, a copy of the
  rays opens out from the tip to 1.6 times their size and fades, once, in 0.32
  seconds. Nothing else moves at the place, so the frame clock stops after the
  glide.
- **Typed keys.** A command that types names no place. The cursor goes to the
  field that has the keyboard: to the lower edge of a field of one line, so
  the pointer is under the text. With no field known it stays where it last
  pointed. The checks for a password field and for ClawdTime's own windows run
  again after the glide, just before the first key.
- **The size.** For a screen that a phone shows as a picture of 1280 by 720
  pixels: an arrow about 24 points high and letters of 20 points in the pill.
  The colors and the typeface of the pill are those of the panel.
- **Reduce Motion.** With the macOS setting Reduce Motion the cursor jumps to
  the target with no glide and waits 0.12 seconds. A click has no pulse.
  Nothing moves.

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

## What it remembers

Computer use reads notes from ClawdTime's [memory](SUPERVISOR.md#memory) and
keeps notes in it. It does this only while memory is on. Memory is off until
you turn it on. Turn it on when you need it, not by default:

```sh
clawdtime memory on
clawdtime computer doctor   # the memory line says whether memory feeds computer use
clawdtime memory show       # what is kept
clawdtime memory forget ID  # removes a note for good
```

While memory is off, computer use reads nothing from it and writes nothing to
it.

Before a request:

- The worker searches memory with the words of your request. It uses the
  memory's own search, with no model.
- Up to 5 notes that fit go to the planner, each cut to 300 characters. A note
  of one project folder does not go.
- The brief says that the notes are data from earlier requests. Each note is in
  quotes on its own line. A note never overrides your request, your words, the
  checks or a question of the program. A note that holds a secret never goes.
- With no note, the brief is the same as before, byte for byte. The rules and
  the functions do not change with notes, so the cached part of the prompt
  stays the same.

After a request, it keeps what you taught in it, at most 3 notes:

- What you said for the request while it ran, and your answers to its
  questions. Each note has the request as context. It is kept as a preference.
  When there are more, the newest are kept.
- The outcome in one line: the sites and apps that it opened, and how it ended.
  It is kept as an episode, so it expires after 14 days.

For example:

```text
For the request "Find a phone case", the owner said: not social.example, shop.example.
Opened shop.example for the request "Find a phone case". It was done.
```

What it never keeps:

- Words that teach nothing alone, such as "ok", "wait" or "go on".
- A secret. The strict secret checks of computer use read each note. A note
  that holds or names a password, a pin, a code or a key is dropped. A request
  that holds a secret keeps nothing. Memory itself refuses a credential too.
- Text that was typed, the text of a page, a picture or the planner's words. A
  note is made from your words, fixed words and the names of sites and apps.
- The outcome of a one-step switch to a desktop or an app.

## What is kept and what is not

The journal is `computer/journal.json` in the state folder. The folder and the
file are for their owner only. It keeps the last 30 requests:

- The request in your words, cut to 300 characters. A request that holds a
  credential is replaced by a marker.
- What you said for the request while it ran, each cut to 300 characters, with
  the time. These are in `computer/guidance.json`, beside the journal, for as
  long as the journal keeps their request (pruned when old requests drop from
  the journal). The file also keeps a bounded list of ids only (never text)
  for stops and refused words so that a replay after a restart starts nothing.
  `clear()` sets aside an unreadable `guidance.json` under a new name, as it
  does for `journal.json`. A build that does not know them reads the journal
  as before.
- Its state and one word for how it got there: `done`, `stopped`, `restart`.
- Each step as the kind of action, the name of the element and one word for
  the outcome. For a link it keeps the site, not the path.

The journal never holds an image, typed text, the text of a page, a question,
an answer or the planner's words. With memory on, memory keeps the notes of
[what it remembers](#what-it-remembers).

Beside the journal, for their owner only: `reach.json` keeps the last 50
questions that the reach worked on, as a digest, the request id, the kind and
the outcome words, and what the service last said about calls and texts.
`text-turn.json` keeps the time and a digest of the last text that the text
channel handed over. `routines.json` keeps each routine with its request in
your words.

The chat keeps what the worker said to you: its questions and its last message.
The last message of a finished request is the planner's summary, cut to 900
characters. It can repeat words from the screen.

The language model of the provider that you chose receives, for each action,
and no other service does: your request, what you said for it while it ran,
the notes from memory while memory is on, the plan with the facts that it kept,
the last 12 steps with the text that was typed, the ways that did not work, the names and values of up to
150 elements, the image of the screen, and the text of the page when the
browser read it. The value of a secure field is never sent. Nothing of this is written to disk by
ClawdTime. Close what you do not want in the picture before you start a task.

## Routes

All three need the panel credential, as the other `/desktop/` routes do. They
refuse a browser origin.

| Route                             | What it is                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /desktop/hands/next?after=N` | The command that waits for the hands, when its number is above `N`, and what runs. Shape `handsNextSchema`. With `&wait=MS` (up to 2000) the read is held, see below |
| `POST /desktop/hands/result`      | What came of one command. Shape `handResultSchema`, body up to 6 megabytes (MB). Answers `{ "ok": false }` when no command waits for it                              |
| `GET /desktop/computer`           | `enabled`, `state`, `message`, `step`, `goal` and `question`. Shape `computerStatusSchema` in `worker.ts`                                                            |

While a request runs, `GET /desktop/computer` can also carry `guidance`, what
you said for the request after its start, and `waiting`, why it waits for you:
`takeover`, `approval` or `question`. The snapshot of the engine that the chat
reads carries the same two, with the `goal`.

The same command is served until its result arrives, with the same number. The
panel must never run one number twice. The numbers start at the time of the
service start in milliseconds, so they stay above those of an earlier run.

The panel holds its read of the next command: it asks with `wait=1000`, and
the service answers as soon as a command waits, as soon as what runs changes
(a look every 0.1 seconds), or after the second. The answer then has the
header `X-ClawdTime-Hands-Wait`, and the panel reads again at once, never more
often than 50 times a second. So no command waits for the next read: before,
the panel read every 0.12 seconds and slept 0.12 seconds after each result,
and each command of a step waited 0.06 to 0.12 seconds for it. A held read
serves nothing by itself and runs nothing: its answer is the same as an
ordinary read. A read that the panel gives up ends at once. The check just
before an input reads with no wait. A service that does not know `wait`
answers at once, and the panel then reads at the old pace.

A service where no worker runs still answers all three, with `enabled` false,
no command, and the reason in `message`. That holds for a service with another
engine, with the switch off, with no key, and for one that a test started.

## When the language model has trouble

A call to the language model has no effect on the Mac, so the planner may
send it again. It is the only thing that is sent again by itself. Every
action on the Mac keeps its rule: no blind retry.

- **Busy or out of reach.** A 408, 409, 425, 429, 500, 502, 503 or 504, a
  reset connection or another error of the network, an answer that is not
  JSON, or a request with no answer after 45 seconds is transient. The
  planner sends the same request again after a wait: a random part of 400
  milliseconds, then of 800 milliseconds, then of 1.6 seconds, never more than
  8 seconds. When the service sends `retry-after-ms` or `Retry-After` (in
  seconds or as a date), the planner waits that long. It does not wait more
  than 20 seconds: the call fails and says how long the service asked for.
  One answer gets 4 requests at most.
- **Budget.** The requests, the waits and the repair of one call share 75
  seconds. A retry starts only when 2 seconds are left after its wait.
- **No retry.** A 429 with `insufficient_quota` or a billing code is `quota`.
  A 401 is `auth`. A 403 or a 404 for the default model of OpenAI goes once
  to the model before it, as before. After that a 403 is `auth` and a 404 is
  `other`. Every other status is `other`. None of these goes out again.
- **Anthropic.** The errors of its library map the same way, by their status.
  A 529 (overloaded) is transient too. A `billing_error` and a 429 with
  `enforced_spend_limit_reached` (the spend cap) are `quota`. An answer that
  stops with `refusal` is `refused`, after the refusal fallback where it is
  on. The message names the status and the error type of the service only.
- **An answer that cannot be used.** No tool call, more than one tool call,
  arguments that are not one JSON object, a function that was not offered, or
  arguments that do not fit the action, or an answer that stopped at its
  length limit, so that a call in it can be cut short: nothing runs. The planner sends the
  request once more, with the answer of the model and a short message. The
  message says what was wrong and asks for exactly one of the offered
  functions. A second such answer fails as `malformed`. A refusal of the model
  fails as `refused`, with no second request. The reading of a request for a
  move gets no repair: a second try could guess a move.
- **Breaker.** After 8 transient failures in a row, across calls, the planner
  fails each call at once for 30 seconds, and says how much of that time is
  left. Then one request goes through. An answer closes the breaker. A failure
  opens it again.
- **Stop.** The caller can give the planner an abort signal. It ends a wait or
  a request at once, and nothing goes out again after it.

Each failure is a `PlannerError` with its trouble: `transient`, `quota`,
`auth`, `malformed`, `refused` or `other`. The message names a status, an
error code of the service or a code of the network. It never holds the
request, the picture, the key or the body of an answer.

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
| Additions to one request       | 8, of 600 characters each                   |
| Actions for one request        | 40, or 80 with a plan of 3 subgoals or more |
| Time for one request           | 15 minutes                                  |
| One command to the hands       | 20 seconds, more for a wait and a long text |
| One request to the model       | 45 seconds                                  |
| One call to the language model | 75 seconds, 4 requests, one repair          |
| One answer of Anthropic        | 16000 tokens, its thinking included         |
| Planner failures in a row      | 2 end the request                           |
| Breaker of the planner         | 30 seconds, after 8 failures in a row       |
| Waits after a short failure    | 3 in one request, of 3 to 15 seconds        |
| Waits for the screen to settle | 2 in one request, of 8 looks or 6 seconds   |
| Steps that go in circles       | 2 notes to the planner, then 2 questions    |
| One call to the browser        | 30 seconds                                  |
| Typed text                     | 4000 characters, one line                   |
| Elements in one observation    | 400, of which the planner gets 150          |
| The picture of the screen      | 1280 pixels on its longer side, JPEG 0.5    |
| One walk of the tree           | 2000 elements, 60 levels, 0.6 seconds       |
| A glide of the cursor and wait | 0.38 seconds at most                        |
| One held read of the panel     | 1 second, at most 2                         |
| A result that the panel posts  | 6 MB                                        |
| Requests in the journal        | 30                                          |

## What is tested and what is not

Tested, with made-up hands, a scripted planner, a scripted language model and
a made-up browser. No test moves the real mouse, presses a real key, captures
the real screen, draws the cursor or calls a language model.

405 tests in `tests/connectors-computer-*.test.ts`:

- `guards` (88): every check above, one by one.
- `worker` (56): a task that completes; Stop before, during and after an
  action; each question with yes and with no; the screen that changed while you
  answered; you take over; both missing permissions; a restart; a lost result;
  the step and time limits; `done` before a fresh observation; the journal
  holds no typed text. Also: a screen that settles and one that never does,
  Stop during each wait, steps that swing, a still screen, a first give_up,
  each trouble of the planner, and the signal that Stop aborts.
- `progress` (18): the swing of two and of three actions, the still screen,
  no alarm while the screen changes, the order of notes, questions and the
  end, and the other ways that fit what is in front.
- `browser-script` (49) and `browser` (30): the page script in a made-up page,
  and the driver over a scripted command runner.
- `own-browser` (31): ClawdTime's own browser over a made-up launcher and
  DevTools pipe: the start and the port from the profile, the refusal of any
  other address and of a process that it did not start, reuse, a new start for
  a read and never for an input, no input sent twice, a covered click, the
  keys, the password field, the waits, the tabs, the doctor and the close.
- `talk` (26): the person's next message answers the worker; and each of
  "click the blue Send button", "type hello in the search field", "refresh the
  browser", "scroll down in Slack" and "read my Slack messages" reaches the
  engine in the person's own words, at once or through the tool of a scripted
  language model. A question, a state and a bare yes do not.
- `autonomy` (131): a table of 50 messages while a task runs and what each one
  does (steer, stop, pause, status, go, a refused secret); any next message
  ends a pause; a pause that ends by itself with trust on the injected clock,
  and none without trust; a stop in every state; secrets kept nowhere in every
  state; and the chat that hands the words to a real worker.
- `routes` (16): the three routes and the stop route through the real route
  code, with and without the panel credential, with a 6 MB body; and three
  real desktop services on free ports that this test started, which have no
  worker and no hands whatever the switch and the key say.
- `engine` (8): the choice of the engine through the real route code: the chat
  connection first, the bundled runtime next, both, the worker with one whole
  task and with Stop, a test's service, the switch off, no key, actors and no
  board.
- `hands` (10), `journal` (12), `planner` (12), `cli` (9).
- `plan` (29): the states of a plan, its bounds, the facts with secrets, the
  plan in the brief; the outline and `plan_update` through the planner's
  repair; and in the worker: one outline beside the first turn, an update
  that sends nothing, a done that is taken at once, a failed outline, Stop
  during the outline, facts that never reach the journal, and 80 actions only
  with a plan of 3 subgoals or more.
- `opening` (14): the line for the person and the line from a reason, with
  secrets, long text and words of the machinery; `say` in the outline's
  function and rules; and in the worker: the outline's line once as the first
  message, the reason when the outline fails or is late, a secret dropped, a
  question first, no fixed start sentence, one line on a revision; the chat
  that writes the line once, and the call that speaks it through the phone
  adapter.
- `reach` (37): no call for a question answered in the chat in time; one
  call for an unanswered one; the spoken yes, no, stop and unclear words that
  the worker reads itself; one text after a call that failed, rang out, had
  an unknown outcome, was not dialed or was not set up; a text reply; no
  redial and no second text, also after a restart; a newer question; Stop; a
  sign-in and a code that ask for no secret and pass none on; a request from
  a call, a text or a routine at once; a blocked end; the record and one
  that cannot be read; the real coordinator of proactive calls and its
  preparation; and one text with one key over a scripted service.
- `routines` (16): the words, the next time, add, list, pause, resume and
  remove in an owner-only file, a start at its time with a result by text, a
  wait and a skip when busy, never during a live call, no late run, no second
  start, the chat line with no text settings, a real worker request, and the
  command.
- `speed` (13): the held read of the next command with a clock of the test:
  at once when a command comes, after its time, at a change of what runs, and
  when the panel gives it up; the wait of each command for the panel; the cost
  header; the parts in the timing record and its line; and the held route
  over a real worker.
- `providers` (45): the table of providers; `provider/model` and a bare
  model; the order of the choice; the request of each chat provider (address,
  key header, functions, picture, effort) and of Anthropic through its
  library over a scripted network (cached rules, strict tools inside the
  limits, image, `auto`, effort, fast mode, refusal fallback); one call back;
  429, 529, 5xx, 401, 403, billing, the spend cap, quota and refusal; the
  repair that sends the answer back unchanged; the use of tokens; the same
  bytes from step to step; the closer look, a plan turn and the outline
  through both transports.
- `keys` (13): set, list and remove; the modes of the file and the folder; a
  store that others can read, a link, a file of another user and a file that
  is not valid, none of which is read or overwritten; the environment that
  wins; `clawdtime computer model` and the doctor; a key that never appears
  in a message or in the output.
- `planner-resilience` (45): each status with and without a retry,
  Retry-After in its three forms, errors of the network, the timeout of one
  request, the budget, an abort during a wait and during a request, each kind
  of repair, a refusal, the breaker from closed to open to closed, the model
  fallback with retries, and errors that never hold the key or the goal.
- `actions` (15): a hover, a drag and a scroll by an amount through the real
  worker, with the question before a drag onto Trash and the look that holds
  back a drag or a hover whose target moved; and each newer browser action,
  with the new reading before it, the question before Enter, the wait that did
  not see its words, the switch to a tab that moved, a driver that lacks the
  method, and a key with no answer, which is uncertain.

15 tests in `tests/connectors-agents-desktop-chat.test.ts`: where
`clawdtime chat TEXT` looks for the service, each reason to answer by itself,
an option that is never sent as a message, the message that is never said
twice, and one real desktop service that this test started.

51 pure tests of the panel's side in `mac/Tests/TaskPanelCoreTests/`: the
contract, the last check before an event, the key plans, the picture and the
elements, and for the cursor the
time and the start of the glide, the jump with Reduce Motion, the sizes in a
picture 720 pixels high, the place of the pill at every edge of the screen,
the place for typed keys, and the rule of the window. For the look: the size
of the picture for common screens, the JPEG, the walk that leaves out what
does not show and stops at its limits, the order of the elements that are
kept, the pace of the held read, and the cost header.

7 pure tests of the panel's windows in `MascotClickTests.swift` and
`ExecutionAskTests.swift`: a click on the mascot opens the chat and never a board,
a bubble opens its one session or else the chat, the question window shows only
while a question waits, the reason to wait decodes, one question takes one
answer, Approve and No work only when the answer can go, and the bar with Stop
stays up during every run.

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
- The retries against the real service. No test shows which headers and
  error codes the real service sends when it is busy or out of quota.
- ClawdTime's own browser with its window, in Google Chrome, Brave or Edge,
  and with your sign-ins. `npm run test:computer:own-browser` runs it with no
  window, in the Chromium of Playwright only, and `npm test` does not run it.
- The planner against the real language model. Its request has the shape that
  the tests check. No test shows that the model picks good actions, for any
  provider. No test calls a provider: the library of Anthropic runs against a
  scripted network. Which models of the other providers read pictures and
  follow the functions is known only from the planner test.
- The supervisor's language model. No test shows which tool the real model
  picks for a sentence that the code does not route by itself.
- A phone call that reaches the worker. `clawdtime chat TEXT` is tested
  against a service with no engine. The line agent that calls the command is
  not part of these tests.
- A call or a text of the reach on a real line. The call and the text sides
  are made-up in the tests. No test shows that a phone rings, that the line
  agent says the question well, or that a text arrives. The lines of
  `scripts/task-server.ts` that wire the reach, the routines and the chat are
  checked by the type checker only.
- A whole task on a real Mac. There is no physical acceptance yet.

## Known gaps

- The checks read names and the words on the screen. An OK asks only when its
  dialog says that it cannot be undone, asks to save, or asks for a
  permission in words that the checks know. Names and words in other
  languages are not known.
- The request is read for its verbs. A send that it asks for in other words
  ("let Sam know") still asks.
- A terminal command is read one typed line at a time. A command that comes
  in pieces, or from the history of the shell, is judged by the pieces that
  were typed.
- A point with no named element under it is judged by the planner's own words
  only.
- The terminal rule knows a list of terminal apps. Another app that runs typed
  text as code is not covered.
- Return in a single-line text field can press the default button of a dialog.
  That case is not asked about.
- The worker does not judge where a link leads, or what a page does with a
  click on a plain name.
- A hover in the page sends the events of a pointer. A menu that only a style
  rule of the page opens on hover does not open that way: `hover` on the
  screen opens it.
- Enter and Space in a page ask while any control of the page has a name that
  a click asks about, also when the focus is in a search field. A page that
  sends on Enter with no such button, as some chats do, is not asked about.
- Between the look just before an input and the input itself, the screen can
  still change. The hands are the last place that can refuse. The glide of the
  cursor and its wait add up to 0.38 seconds to that time. A command for the
  hands names a point, not an element, so the hands cannot check what is under
  the point just before the click.
- A question reaches you in the chat first. A call of the line says it after
  45 seconds, or a text when the call does not get through. During a call that
  you started, nothing says it on that call by itself: ask "computer status".
  A request that came from such a call is reached at once, and while that call
  is live the line is busy, so the reach texts.
- When the worker asks a second question while the call about the first one is
  still on the line, the second question goes by text: the line is busy, and
  words said on a call are taken only for the question that the call is about.
- A call that you picked up gets no text after it, also when no clear answer
  came on it. The question still waits in the chat.
- The service knows a live call of the line from its own outbound calls and
  from an open phone conversation of the worker. A call that only uses
  `clawdtime chat TEXT` is not seen, so a routine can start during it.
- A text counts as a reply to the reach only while the text channel runs on
  the same Mac and in the same state folder as the desktop service.
- The reach reads a sign-in from the worker's own words: a password field, or
  a question of the planner that names a sign-in, a password or a code. A
  sign-in page that the planner does not name is a plain question.
- The place of a sign-in is a site address or a capitalized name in the words.
  When neither is there, the call and the text name no place.
- A request that ended blocked is reached after 45 seconds also when you sit
  at the Mac and read it. Start a new request in that time, and no call comes.
- The road of a message is read from its words, in English. A sentence that
  can be code work or screen work ("make the button blue", "open the login
  page and add a forgot password link") goes to the language model, and which
  tool it picks for it is not fixed in code. An app that the reader does not
  know by name counts only after "on", "from", "via" or "using", with a
  capital letter.
- With another engine than ClawdTime's own worker (the bundled runtime, the
  connection to a chat), the supervisor's language model still chooses
  between that engine and the browser tool and the tool that reads the
  screen from a picture.
- A message with code work and screen work starts the screen part right after
  the job starts. It does not wait for the answer of the job.
- The route before the language model has no check for a request of an agent
  that waits at the desk. "Click the Approve button" goes to the worker. The
  worker then asks for your yes before the click, because of the name.
- The words refresh, reload and press pass the hand-off with any object, when
  the language model picks the tool: "refresh the board" can go to the worker.
- A second desktop service of the same user builds a second worker. The switch
  and the journal are one for each user, so its start marks a request of the
  first as uncertain.
- `clawdtime chat TEXT` sends the panel credential with its first read, before
  the service has shown that it is the one that wrote the files. A process of
  the same user that takes the port after a crash would get it.
- The window with a question of the worker has no field for a free answer. For a
  question that needs more than a yes or a no, open the chat and type the answer.
- The planner reports each retry to an `onAttempt` callback, but the service
  records none of them yet. A retry is not shown to you.
- The cursor is the only window of ClawdTime in a screen share during a run.
  The mascot that it comes out of is not in the share.
