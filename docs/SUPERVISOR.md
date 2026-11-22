# Supervisor

ClawdTime supervises the coding agents on this Mac. The [agent board](AGENT_BOARD.md)
shows them. This page is about what ClawdTime can do for you: answer an agent,
remember your decisions, reach you by phone, talk with you in text or by voice,
type into a terminal, report on the agent commands you use, and work with the
browser.

Every action here starts with you: a click, a command, or your voice on a call.
The one exception is a standing rule, and only you can make one.

## Answer an agent without its terminal

An agent that needs permission, asks a question, or has a plan to approve puts a
request on the desk. You answer it in the panel, on the mascot's bubble, in
`agents watch`, with a command, or on a call. The agent's own hook hands your
answer to the agent. Nothing is typed into its terminal.

```sh
clawdtime agents hooks install --agent claude-code   # once
clawdtime agents hooks install --agent codex         # once, then /hooks in Codex
clawdtime agents pending                             # what waits, each with its id
clawdtime agents approve 3f9a1c2e                    # or: approve 3f9a1c2e --always
clawdtime agents deny 3f9a --message "Not before review."
clawdtime agents answer 3f9a 2                       # the second choice of a question
```

A request is named by its id, or by its first four characters or more, as
`agents pending` prints it. A place in the list ("approve 1") is refused, and
the message shows the ids: the list changes while you type, so a number could
mean another request a moment later.

How it behaves:

- A hook waits only while someone attends the desk: the panel, or `agents watch`.
  With nobody there it says nothing, and the agent works exactly as it does with
  no hook.
- For a permission request, Claude Code shows its own prompt at the same time.
  You can still answer in the terminal. The first answer wins, and a request
  that the terminal answered leaves the desk at once.
- A question or a plan is different. Its hook runs before the dialog, and the
  agent waits for the hook. So the dialog of a question or a plan shows in the
  terminal only after the hold: 45 seconds at the desk, 9 minutes in away mode.
  An answer in ClawdTime ends the hold at once and stands in for the dialog.
  With nobody at the desk there is no hold, and the dialog shows at once.
- A request waits 45 seconds on the desk. After that only the terminal answers.
  In away mode it waits up to 9 minutes.
- A request that you cannot see whole is allowed only in its terminal. ClawdTime
  shows 600 characters of a request, on one line. A request with more text, or a
  command with a line break, is marked (`answerInTerminal` in
  `GET /desktop/decisions`). The panel, a command, the chat and a call all refuse
  to allow it, and say that its terminal shows it whole. You can still deny it
  from ClawdTime. A plan is marked only when it is longer than what is shown.
- A call reads 220 characters of a command. A longer command is approved in the
  panel or in its terminal, not on the call. The live view `agents watch` shows
  90 characters, and takes an approval only for a request that fits.
- Supported: Claude Code permission requests, single-choice questions and plans;
  Codex approval requests. A question with several parts stays in the terminal.

| Agent       | Permission | Question | Plan | Notes                                       |
| ----------- | ---------- | -------- | ---- | ------------------------------------------- |
| Claude Code | yes        | yes      | yes  | Settings change applies to running sessions |
| Codex       | yes        | no       | no   | Codex runs a hook only after `/hooks` trust |

## The trove: decisions as a playbook

Each answer you give through ClawdTime is kept: who asked, in which project,
what, what you answered, and through which channel. The trove then:

- shows what you answered before to the same kind of request in the same
  project ("You allowed this 3 times here");
- repeats an answer only where you made a rule (`--always`, or **Always in this
  project** in the panel). A rule allows one request pattern for one agent in one
  project. It never crosses projects, and it never denies;
- keeps the critical decisions you write down.

```sh
clawdtime trove                      # the last decisions
clawdtime trove search push codex    # every word must match
clawdtime trove note "Never push to main without a review."
clawdtime trove rules                # standing rules
clawdtime trove forget RULE          # remove one
clawdtime trove playbook --out playbook.md
```

A request is grouped by a narrow key: a shell command by its program and its
first plain word (`git push`, `npm test`), every other tool by its name. The key
is made from the command as the agent sent it, before it is cut for the screen.

A rule never covers more than the command that you saw:

- A command with pipes, lists or substitutions, a command with a line break, a
  command longer than the 600 characters that you are shown, and a command whose
  program is a path (`./git status`) all get the bare key `Bash`. The bare key
  cannot become a rule and no rule matches it.
- A key that is the program alone (`rm` from `rm build/tmp.txt`, `ls` from
  `ls -la`) counts your past answers, but it cannot become a rule: it would
  cover every use of that program.
- A rule for a file tool (Edit, MultiEdit, Write, NotebookEdit, Read) covers
  only a file inside the rule's project folder, also when a link leads out of
  it. A request for a file outside the folder cannot be remembered.

The panel offers **Always in this project** only where a rule can be made, and
`approve ID --always` says so when it cannot.

An answer given in the terminal is not in the trove, because ClawdTime does not
see which answer it was.

## Memory

The trove keeps what you decided. Memory keeps what you tell ClawdTime about
yourself and your work: a preference, a constraint, what you work on, something
that holds for a while. **It is off until you turn it on.** While it is off,
nothing is read, nothing is written, and ClawdTime has no memory tools.

```sh
clawdtime memory on                  # or the menu: Memory: keep what I tell ClawdTime
clawdtime memory remember "Never force push to main."
clawdtime memory remember "Use pnpm here." --kind preference --project .
clawdtime memory remember "The demo is on Friday." --kind episode --days 3
clawdtime memory show                # every fact, with what replaced what
clawdtime memory search push main
clawdtime memory forget ID           # or words from the fact. It is removed for good
clawdtime memory off
```

How it works:

- One fact is one sentence that stands alone. The same fact again adds no copy:
  it counts for more. A preference that you repeat rises to the top.
- A newer fact can replace an older one ("I work on the Mac fleet now"). The
  older one stays as history, marked as replaced, and is not used.
- An episode expires: after 14 days, or after the days you give. A fact holds
  until it changes.
- A fact can belong to one project. It never shows for another project.
- A credential is never kept. Text that holds a key, a token or a password with
  its value is refused: the usual key shapes, a name with a value
  (`CLIENT_SECRET=...`, `db-password: ...`), an address with a password in it,
  and the same as you say it ("my password is ..."). A message that holds one
  is also not written to the chat file: a short marker stands in its place.
  The check reads shapes. A password that is one short plain word in a sentence
  looks like any other word, so do not tell ClawdTime a password.
- With memory on, ClawdTime starts each conversation from a small summary: at
  most ten lasting lines and six recent ones. It can search the rest by words.
  No model and no index is used to search.
- When you say "remember ...", your own words are kept. After an answer,
  ClawdTime may also keep up to three facts from your message. A fact that it
  worded itself is marked as inferred, and an inferred fact never decides
  anything.
- "Forget ..." removes a fact only when you ask for it yourself.
- A waiting request shows what you said before about it ("You said: Never force
  push to main."): in the panel, in `clawdtime agents pending`, and in the
  question on a call.

Memory is a set of plain files on this Mac. It has no service of its own. With
an OpenAI key, the step that keeps facts after an answer sends your message to
the language model, as the chat itself does. With memory off, nothing more is
sent than before.

## Away: answer by phone

Away mode turns a waiting request into a FaceTime call through the ClawdTime
backend and its Chert line. The call says who asks and what, for example "Claude
Code in app asks to run the command: npm test. Say approve or deny." Your spoken
answer goes to the agent through the same desk as a click.

```sh
# 1. Pair the project once. The setup link comes from the person who runs the line.
clawdtime setup --agent claude-code --project PATH \
  --setup-link-file PRIVATE_FILE --origin HTTPS_ORIGIN \
  --allow-view true --allow-control false
# 2. Point the supervisor at that pairing.
clawdtime agents call connect --agent claude-code --project PATH
# 3. Ask the backend whether a call would work now. No call is placed.
clawdtime agents call check
# 4. Turn away mode on, or let ClawdTime call you to talk.
clawdtime agents away on
clawdtime agents call me
```

`agents call check` prints the backend's own readiness for the pairing, one line
for each check, and says whether a phone would ring: in live mode it does, in
simulation or standby it does not.

- Only clear words count. "Approve", "yes", "go ahead" allow. "Deny", "no",
  "stop" deny, and your words become the reason for the agent. Nothing else
  approves, and the call asks again, up to three times. That holds for unclear
  words, yes and no together, silence or other sound, an approval with "not" in
  the sentence ("I would not allow that"), a hedge ("not sure", "maybe", "I
  think"), words that ask for time ("wait", "hold on") and a question ("is it
  safe to allow", with or without a question mark). A sentence that opens with
  its refusal ("No, why would it do that?") still denies.
- What you say in one go is read together, so a sentence that arrives in parts
  is one sentence. The same reading is used in the chat, with or without a
  language model.
- One request places one call. An unanswered call leaves the request for the
  panel and the terminal.
- Away mode needs no panel. With a phone link, the desktop service attends the
  desk by itself, so a request is held and called also when the panel is closed
  or macOS slows it while the screen is off.
- The phone is one line, so calls go one at a time, the oldest request first.
  An agent that waits comes before news: an incident is told only when no
  request waits for its call.
- A failed or unconfirmed call is not automatically retried. A missing backend
  response can mean that a call was already dispatched. The request stays
  available in the panel and terminal; reconcile the original call outcome
  before authorizing another attempt.
- The supervisor claims no screen and no input for the call. It only talks.

## Watcher

The board says what each session does now. The watcher follows every session
from one scan to the next and tells you the four things that you want to hear
about without looking:

| Incident   | When                                                                                            | What it says                                                       |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `waiting`  | A session has needed you for longer than the wait limit (2 minutes)                             | "deploy fix has waited for you for 5m."                            |
| `stalled`  | A session is in work and has shown no sign of life for longer than the stall limit (10 minutes) | "deploy fix has shown no sign of life for 12m."                    |
| `failed`   | A session stopped on an error, or its process ended in the middle of its work                   | "deploy fix is gone: its process ended in the middle of its work." |
| `finished` | A session went from work to idle after at least 3 minutes of work                               | "deploy fix is done after 12m."                                    |

Where you see an incident:

- The mascot's bubble shows the newest one when nothing else waits for you. A
  click opens that session. The close button tells ClawdTime that you have seen
  it. A stalled or failed session makes the mascot ask for attention; finished
  work makes it jump once.
- `clawdtime agents` and `clawdtime agents watch` print the open incidents above
  the sessions, most urgent first. `clawdtime agents incidents` lists the open
  ones and the recent ones.
- ClawdTime names them when you ask it what is going on, in chat, by voice or on
  a call.
- In away mode, with a phone link, one call says an incident and ends when you
  say a word. Only the kinds in the `call` rule place a call: `waiting` and
  `failed` at the start. There is one call for one incident, and never a second
  call while one is in flight.

How it knows:

- A sign of life is the newest time in a session's own evidence: the time of its
  status, the last change of its session file, its last hook record. Only the
  time of a file is read, never its text. A session whose evidence carries no
  time is never called stalled. A session that only waits for a background
  shell is not stalled.
- A session is `failed` as gone only when it was in work or needed you, it is
  missing from two scans in a row, and its process no longer exists. A session
  that you closed while it was idle, a one-shot run, and a session that you
  interrupted are never reported.
- For a remote Mac that does not answer, the watcher says nothing about its
  sessions until it answers again.
- An incident is raised once. A wait or a stall stays while it lasts. A failed
  or finished one stays for 10 minutes, or until you dismiss it.

Change the limits:

```sh
clawdtime agents watch-rules                  # print the rules
clawdtime agents watch-rules set wait 5m      # also: stall, finished
clawdtime agents watch-rules set call failed,stalled   # or: none
```

A limit under 30 seconds is refused: it would fire on every pause.

The watcher only reads. It never sends input to a session and never answers
anything. An incident holds names and times, as the board does: no prompt, no
reply and no command. It runs inside the desktop service; with no service,
`clawdtime agents watch` runs it for as long as that view is open.

## Talk to ClawdTime

The supervisor has no direct mailbox or email-provider integration. With the
optional [desktop execution connection](DESKTOP_EXECUTOR.md), it can delegate your
exact inbox/browser request to a selected existing Codex chat; that chat's actual
tools and permissions determine what it can do. Without that connection it can
summarize email text you provide. Approval cannot create missing capabilities.
Approval prompts must refer to an actual waiting request. The tested connection
requires an active chat; automatic idle-chat wake remains unqualified.

ClawdTime is also an agent that you can talk to. It sees what the board sees and
acts through the same desk and trove. There are three ways, and they share one
conversation:

| Way              | How                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Text             | The chat button on the bar under the mascot, or `clawdtime chat`. `clawdtime chat "what needs me?"` answers one question and exits. |
| Voice on the Mac | The talk button on the bar, or `clawdtime talk`. You speak, it answers aloud.                                                       |
| FaceTime         | `clawdtime agents call me`. ClawdTime calls you through the linked pairing and you talk to it. Say goodbye to end the call.         |

What it can do when you ask:

- Say what every agent does and what waits for you.
- Allow or deny a waiting request, or answer a question with one of its choices.
- Bring a session's terminal to the front. You can name the session, or say
  what it works on: "show the session that checks the lines". See "Find a
  session" below.
- Make a session's terminal window fill the screen, put it back, or change its
  text size.
- Open an application, or a web address in it: "open Chrome", "go to
  example.com in Chrome". It opens at once. Your own words must name the
  application and give the site of the address.
- On a call, choose what the video shows: "zoom in on the session that checks
  the lines" shows only that window, "show the whole screen" goes back. The
  session's tab comes to the front first. `clawdtime view` prints the view.
- Act in the browser that runs: "refresh the browser", "go back", "which tabs
  are open", "bring tab three forward", "read this page". It uses the
  browser's own scripting: no key and no click, and it starts no browser.
  Reading the text of a page needs the browser's own setting View, Developer,
  Allow JavaScript from Apple Events.
- Read what is on the screen, in any application: "read through my Slack
  messages", "what does that error say". ClawdTime takes one picture of the
  main screen and a vision model reads it for your question. See "What it
  sees" below.
- Hand any other work to a new coding session and say its answer when it is
  done. See "Give it a job" below.
- Type your words into a session's terminal.
- Search the trove, and keep a critical decision that you state.
- Turn away mode on or off.
- List the agent commands on this Mac and their use.
- Take a task from you, say how it goes, pass your answer to its question,
  and accept or cancel it. See "Give it a task" below.

These rules are in the code, not in the model's instructions:

- A request is allowed or denied only when your own last message says so. "What
  does it want?" allows nothing. "Yes, approve it" allows it. The same reading
  of your words is used on a call.
- A bare "yes" or "no" is read against ClawdTime's own last question. After
  a question about a denial ("Should I deny it?", "Do you want to approve or
  deny it?"), a "yes" approves nothing and a "no" denies nothing: only your
  own word ("approve it", "deny it") decides there.
- A bare word answers what ClawdTime said last. When ClawdTime said
  something before your message (its message is the last one, or it is
  younger than five minutes) and one request waits, a bare "yes", "ok",
  "sure", "go ahead" or "no" decides that request only when ClawdTime's
  message is the last one and put the request before you. Two forms count.
  The first is ClawdTime's own sentence about the request ("One request
  waits for your answer: ... Say approve or deny to answer it.") at the end
  of the message, with no question before it. The second is its offer to
  approve the request as the last sentence ("Should I approve it?", "Want me
  to approve it?", "Approve it?", "Should I let it run?"), where the
  sentence before says what runs, by a word of the head of the request's
  text (the program, or what it works on), or the offer names the request
  by such a word; the text is then one short simple command. "The branch is
  main. Should I approve it?" does not say what runs, so a yes to it
  approves nothing. The message must
  be on the same channel and younger than five minutes, and no task may be
  live. After any other message ("Should I keep an eye on the tests?", "docs
  is idle."), a bare word decides nothing, and ClawdTime says so. Your own
  word decides at any time ("approve it", "deny it"), and so does a word of
  the request ("ok, push it"; a verb for any work, such as "make" or "test",
  names it only as "the make one"). A bare word that follows no message of
  ClawdTime belongs to the one request that waits, as before.
- When the gate refuses a bare word, the model is told that your word
  answered its own last message, so that it answers that in words ("Got it,
  I'll watch the tests") and does not ask you for "approve" in its place. It
  is told to call no tool for that word and not to say that it did what it
  offered. With no model you get the gate's sentence itself. A call that the
  gate refused did nothing: an answer that then says that work started is
  checked like any other. When the model's answer after such a refusal
  speaks of nothing that its last message spoke of (the request alone,
  mostly), it answers once more; a second such answer is said as it is.
- ClawdTime checks its answer for a decision that no tool made. When the
  answer says that a request was approved or denied now ("I approved the
  push", "Approved.", "It's approved now", "as you allowed") or that the work
  of a waiting request is done or under way ("I pushed it", "The push is
  underway now"), and no request was decided in that turn, the model answers
  once more. When the second answer says it
  again, you get plain words: "Nothing was decided." and what waits. After a
  call that the gate refused, every such sentence counts. With no call, a
  sentence counts when it speaks of a request that still waits, by a word of
  its text; "I approved the push" about an earlier turn is said as it is. A
  sentence that says the opposite, that asks, or that speaks of an earlier
  time is no such claim. After a call that the gate refused, other words
  for an approval count too ("I let it through", "Permission granted",
  "Okay, pushing", "I'll let the push run", "The branch is pushed"), and so
  does a sentence whose subject is the request and that says that it went,
  is done or may go ("The push goes out", "The push has landed", "The push
  is live", "The push is good to go", "The push can go through now"). What
  is only possible is no such claim ("The push would go to origin main"). A sentence that says what the request is or does, or that
  it still waits, is said as it is ("The push updates main", "The push
  still waits"), and so is one that names a session. 'Say "approve" to let it
  push' in an answer asks you for a word of decision: it offers no words to
  type into a session ('Say "yes" to docs' does, when docs is a session).
- A bare "yes", "ok" or "no" with no request on the desk gets the sentence
  "There is no pending request to approve or deny." only when it answers no
  question. When ClawdTime's own last message ends with a question ("Should
  I keep an eye on the tests?"), on the same channel and younger than five
  minutes, your word is the answer to that question, and the model replies
  to it. A yes to an offer of work in ClawdTime's own words starts nothing:
  say the work yourself. "Please do", "yes please", "sure, go for it", "ok
  thanks" and "sure thing" are a yes too: they hold no work, so no job and
  no task starts with them, wherever you say them. "Yes, start it", "ok,
  continue" and "do the job" are a yes with no work only as the answer to
  ClawdTime's own offer ("Want me to start a job for the footer?"), with no
  news of a job after it; after a job's answer, "please continue" is work on
  that job, as before.
  A yes to an offer to tell a session something types nothing: only your
  own words are typed.
  When that question of ClawdTime names a session ("Deploy fix has been
  quiet. Want me to tell you what it last did?"), the code reads the state
  before the language model answers your word, as it does for a question
  about the state: the answer is about that session. This also holds while
  a request waits, and it decides nothing.
- A yes to ClawdTime's offer to open one session opens that session ("Want
  me to open the docs session?", then "yes", "ok", "go ahead"). The offer is
  the last sentence of ClawdTime's last message; it names one session on
  the board by its whole name, or it says "it" after a sentence that names
  exactly one session and says only its state ("Docs is idle. Want me to
  open it?"; after "Docs wrote a summary file", "it" is the file, and no
  session opens); the message names no other session; no task is live; and
  no computer action waits for the panel. The code opens it before the
  model, and it opens no other session for that message.
- After ClawdTime's own offer to tell a session something or to open one,
  it checks its answer to your bare word for typing or opening that did not
  happen. When the answer says that it told or typed a session something
  ("I told it to go on", "I let the agent know", "Sent.") and the turn typed
  nothing, or that it opened a session ("Opened docs.") and the turn did not
  open that session, the model answers once more. The one that is told or
  opened is a session, by its name, the name of its agent, "it", "them",
  "the session" or "the agent". A thing of a session is none ("I pulled up
  deploy fix's output"), and neither is "As I told you", "I typed nothing",
  or what a session did ("I see deploy fix opened a pull request"); quoted
  words are not read. A word about a turn of the last ten minutes stands
  when it names no other session than the one of that turn. When the second
  answer says it again, you get plain words: "Nothing was started or
  changed for that message. Say what I should do, and I do it.", or, when a
  tool of the turn acted, what it did and what did not happen ("Opened
  docs. I typed nothing into a session for that message. ..."). After any
  other question of ClawdTime ("Want me to check on deploy fix?") a yes
  asks for no typing and no opening, and the answer is not checked this
  way. Neither is a turn that decided a request, nor your own question
  ("did you tell deploy fix?").
- A "yes" is your denial in one case: ClawdTime offered to deny the one
  request that waits. Its message is the last one, on the same channel and
  younger than five minutes, and it ends with the offer itself: "Should I",
  "Shall I", "Can I", "May I", "Do you want me to", "Want me to" or "Would
  you like me to", then deny, reject, refuse or decline, then "it", "that",
  "the request", "the command" or a word of the head of the request's text,
  and "?". A question about the past, a reason or another thing is no offer
  ("Did you deny it?", "Should I decline the meeting?"). When the offer
  says "it" or "the request", the sentence right before it speaks of the
  request, by a word of its text. The request waited before the message, and
  no task is live. Your
  message is a yes and nothing else ("yes", "ok, do it", "yes, deny it");
  "go ahead" is not one, because it can mean that the command goes ahead.
  The model still calls the tool with "deny": the yes alone decides nothing.
- When your message decides the one request that waits and the model answers
  with a question or a claim in place of the tool, ClawdTime asks the model
  once more to call the tool. That happens only when ClawdTime's last message
  ends with its own sentence about that request ("One request waits for your
  answer: ... Say approve or deny to answer it.") and the text of the request
  is one short simple command, or when your message is the yes above. The code decides nothing there. A second answer that claims
  a decision that no tool made is replaced by "Nothing was decided." and
  what waits.
- One message decides one request. The model names a request by its id, never
  by its place in a list, so an answer cannot move to another request when the
  list changes. The facts of each turn give the model the ids of the requests
  that wait, and never their texts: an agent writes the text of its request. When more than one request waits, your words must say which
  one: a word of what it asks, of its project or of its agent that the other
  requests do not have ("approve the npm test one"). Otherwise nothing is
  decided, and ClawdTime asks you which one.
- When two requests wait and your message is a decision and nothing else
  ("approve it", "yes, approve it", "deny that one"), ClawdTime asks which
  one, in fixed words, and decides nothing. An agent writes the text of its
  request, and you read or hear the question, so ClawdTime asks this only
  where the question cannot mislead: two plain permission requests, each
  text short, shown whole, and one simple command. A simple command has
  parts between single spaces; each part is made of plain letters and
  digits and of . _ / : = @ ~ + % -, and ends with a letter, a digit or
  "/". So it holds no quote mark, no question mark, no comma and no mark of
  the shell that joins two commands. Its first part is the bare name of a
  program in one word of letters and digits, so the word that you say is
  the whole name of the program that runs: "./git status", "PATH=/tmp/x git
  status" and "git-status-x status" get no question. It also holds none of the words and,
  then, also, plus, or, request, wait, which, approve, deny, allow, after,
  before, next, with, and one bare number at most. "git push origin main"
  and "chmod +x run.sh" are simple commands; "make build && git status"
  and "ls | grep x" are not. ClawdTime does not ask while a task is live.
  In every other case the model answers, as before, and you say the
  decision and the request in one message.
- Your next message can then name one request: "the push one". The
  decision is the one that you said in the message before the question. A
  request is named by a word of the head of its text: its first two parts
  that are no flags ("git push", "rm dist"), each only when it is one word
  of letters and digits ("x.sh" and "node_modules" are named by no word),
  and where the other text does not hold that word. What follows the head can be written by an agent
  to sound like another request, so a word from there names nothing. Each
  of the two requests must have such a word, or ClawdTime does not ask. A
  word that says a place in the list or an opinion ("the main one", "the
  latter", "the safe one") names no request. The folder, the agent and the
  id of a request are not a name here, because the question does not show
  them.
- That name decides only when the question is the last message, your
  decision is the message just before it, both are on the same channel and
  the question is younger than five minutes; when the requests that wait
  are exactly the two of the question; and when your message is a name and
  nothing else: words of that one text, with "the", "that" or "this" before
  them, and "one", "request", "command" or "thing" and "please" after
  them. Any other word or mark decides nothing there: a word of decision or
  of stopping ("stop the push one", "ok the push one"), a hedge, a "not", a
  question, a time, both requests, "!push". The model and the usual gate
  read such a message, as always. A request that must be answered in its
  terminal gets no such question.
- Text is typed into a terminal only when your own last message asks for it
  ("type", "tell", "send", "say", "reply" or "answer"), names the session, and
  holds the text as whole words, one after the other ("Tell deploy fix: run the
  tests again"). A part of a word is never typed, and neither are words that
  follow a "not" in your sentence.
- "Tell deploy fix: run the tests again", with the full name of one session
  before the colon, is typed at once, by the same rules. ClawdTime does not
  ask you again. This holds only while no task, request or computer action
  waits for your answer, and only when the words after the colon are one
  clause of plain words: no comma, full stop, dash, bracket or other mark
  stands before more words, and no word in it can take it back, hedge it or
  tie it to you ("no", "not", "wait", "stop", "never mind", "actually",
  "when I say so"). A question mark at the end counts only for a question
  ("did the tests pass?"). Any other message is read as before, and ClawdTime
  can ask you.
- "Tell deploy fix to run the tests again", as you say it, is typed at once
  too, with "tell" or "ask". The conditions are those of the form with a
  colon, and some more, because speech has no marks:
  - The clause that speaks to the session is the last one of your message.
    Before it stands nothing but a filler ("um, ...", "ok so can you ...") or
    a request to see a session ("show me docs and tell deploy fix to ...").
  - The words before "to" are the full name of one session, or a part of its
    name with "one" or "session" that fits no other session ("the deploy
    one"). A part of a name alone ("fix"), "it", "everyone", "a docs agent"
    and the name of a coding agent name no session here.
  - The words after "to" are one clause of plain words, and no word in it can
    take it back, hedge it, or begin a question or a second thought: "would
    that help", "is that a good idea", "thanks", "uhh", "you". A "please" at
    the end is not typed, and neither is the full stop of your sentence.
  - The message has no question mark and takes nothing back.

  Only for exactly these words, and only while nothing else waits for your
  answer, "ask" counts as a request to type and a part of a name counts as
  the name. "Let me tell docs to wait", "don't tell docs to wait" and "tell
  docs to wait, or should I?" are not typed this way: ClawdTime reads them as
  before, and can ask you.

- "Tell it to run the tests" is typed too, by the same conditions, when "it",
  "that one" or "that session" can mean one session only. Two things say
  that, and nothing else does:
  - ClawdTime opened or typed into exactly one session in its answer to your
    message just before, on the same channel, and that answer names no other
    session. It keeps a small record of what it did in its state folder (the
    sessions, the channel and a digest of your message, not the message).
  - Or that answer opens with the full name of one session and its state
    ("docs is idle", "the payments tests session has been running for 3
    minutes"), and names no other session.

  A name in your own message says nothing here ("forget docs, how is the
  build?"), and neither does a name that is a part of another thing ("the
  docs build fails"). After another exchange, after ten minutes, while a job
  of ClawdTime runs or right after one started, and while a task is not over,
  "it" names no session, and ClawdTime asks you which one. "Tell it to the
  team" and "tell it to Marketing" are not typed: words that open with "the", "my",
  "everyone", "both" or a capital letter are an audience, not an instruction.

- "Tell deploy fix to run the tests and push the branch": ClawdTime types
  the first part ("run the tests") into deploy fix, and neither sends nor
  starts the rest. The rest can be more words for that session, or work of
  its own: the sentence does not say which. The answer names the rest and
  says how to go on: "tell it to push the branch" sends it to the same
  session, and the rest alone starts it as new work. This holds only for a
  narrow form: only a filler stands before "tell", the first part passes the
  conditions above, the rest is joined by "and" or "then", and each part of
  the rest opens with a verb of software work from a short list (push,
  commit, merge, rebase, deploy, release, tag, build, lint, format, test,
  fix, update, write, add, review, clean up, refactor). The list says what is
  taken, because a list of what must not be taken is never complete. A rest
  with a time or a condition, with a word that points back or a word of the
  first part again, with the name of a session, with something of ClawdTime
  itself (a size, the screen, the browser, memory, notes, the trove, away),
  with a quote or with something that looks like a key is not taken either.
  For every other message of this kind, ClawdTime types nothing by itself
  and reads the whole message as before. Once ClawdTime typed words of a
  message by itself, no job starts for that same message.
- Words for a session that runs never start a job or a task: "show me docs
  and tell deploy fix to run the tests again" opens docs and types into
  deploy fix, and "ask deploy fix if the tests pass" starts nothing. Work of
  its own in another clause still starts: "build the page and tell docs to
  wait", "tell docs to wait and build a landing page".
- Your words are typed as you said them. "Tell deploy fix to pull main and
  run the tests" types "pull main and run the tests": ClawdTime never turns
  your words into a shell command. An answer that offers a sentence to type
  with other words than yours ('Say "tell deploy fix: git pull && npm test"')
  is not said: ClawdTime works it out once more, and if it still cannot, it
  offers your own words or says so in plain words. A message that asks,
  hedges, takes the words back or puts them off ("... or should I wait",
  "... never mind", "... tomorrow") gets a question, and nothing is typed.
- Words with a time in them ("tell deploy fix to run the tests tomorrow",
  "... after lunch", "... in an hour") are not typed by ClawdTime by itself:
  it asks you.
- Nothing is typed when your message hedges the request, asks about it or
  takes it back: before the words ("maybe tell deploy fix to push", "should
  I tell deploy fix to push", "don't tell deploy fix to push", "not yet,
  tell deploy fix to push"), after them
  ("... push the branch, or should I wait?", "... never mind", "... maybe"),
  or at their end ("... push the branch, would that help"). The tool that
  types refuses then, whatever the language model chose, and ClawdTime asks
  you. A time after the words ("... later") puts them off, and nothing is
  typed. A clause before the request that only hedges, or that opens with
  a word of doubt, hedges it too ("better not, tell deploy fix to push",
  "maybe hold off on that, tell deploy fix to push"). A clause before the
  request with your own business in it does not hedge it ("do not wait,
  tell deploy fix to push now", "maybe it's done, tell deploy fix to check
  the build"), and "no, tell deploy fix to push" corrects ClawdTime: these
  are typed. A polite word
  after the words ("please", "thanks") is nothing. A
  question for the session is typed ("tell deploy fix: why is it failing?",
  "tell payments tests: did the tests pass?"): only a question about you
  ("should I", "can we") or about the words ("would that help") is one to
  ClawdTime. Words that add another session as a second target ("..., and
  the docs one too") are not typed as a whole; words that only speak of
  another session ("copy the config from docs") are.
- One message types the same words into a session once. A choice of a task
  is never typed into a session: a click on it answers the task.
- Words that you take back at the end of the same message are not typed, and
  ClawdTime says so: "tell deploy fix: delete the release branch, never mind"
  gets "Okay. Nothing is typed into deploy fix."
- "Then ask it", after your question about one session, types nothing.
  ClawdTime answers with the sentence that sends it, made of that session's
  name and your own question: say it, and it is typed. It offers that
  sentence only for a question of one clause.
- Nothing is typed into a session that has a request on the desk. Return in its
  terminal would answer the prompt that shows there. ClawdTime says that the
  request must be answered first.
- Away mode changes only on your own words, because it holds agents for minutes
  and places calls. "Away", "leaving", "stepping out" or "call me" turn it on.
  "Back" or "I am here" turn it off, and so does "away mode off". A question
  about away mode changes nothing.

A critical decision is kept in your words. When the model rewords it with a word
that you did not say, your own sentence is stored.

What it keeps of the conversation: the language model reads the last 30
messages in full. From the 370 messages before them it reads only what you
said, your statements and instructions, at most the newest 40 lines of 240
characters. It never reads there an answer of ClawdTime, a question, a bare yes
or no, a message that held a credential, or a message of more than 600
characters, which is pasted text. So a fact from the start of a long
conversation, or from yesterday, is still known. None of those older lines can
start, open, type or approve anything: the checks in code read your last
message only. For what must last longer, turn [memory](#memory) on.

A question about the sessions, the agents or what waits is answered from the
state, which ClawdTime reads before the model answers. When the model service
is busy or the connection drops, ClawdTime asks it once more before it falls
back to the plain answer. A request with no answer after 15 seconds is stuck:
ClawdTime ends it and asks once more, for 30 seconds at most. With a reasoning
effort set, the one request keeps 45 seconds. When the model does not answer
at all and your message was not about the state, ClawdTime says so, says that
nothing was done, and gives the state. When the model stops after your words
already decided a request in that message, ClawdTime says that decision
("Allowed. The agent continues."), says that nothing else was done, names a
request that still waits, and does nothing more with those words.

A job is only work that ClawdTime started. When you ask about jobs and it
started none, it says so, and then says what your own sessions do.

ClawdTime cannot stop, close or restart a session: it has no tool for that.
"Stop all my sessions" gets that answer, and the offer to open a session so
that you stop it there.

When you asked for no action, ClawdTime still checks one thing in its
answer: a sentence that says that work started or is under way ("I started a
job to push the branch", "On it", "I'll start a job for that"), in a turn
where no tool acted. It reads the sentence against the work that did start.
Work that runs is a job that still works or that started in the last hour,
and the live task. Work of the day is that, and a job of the last day that
is done. A sentence that claims new work and names it ("a job to push the
branch", "a new session for the tests") must share a word with work that
runs, by its first five letters, with a last "s" left out. Every other
sentence can speak of work that exists, and is said as it is while work
runs: "I kicked off the homepage work", "Yes, I started it", "On it". A job
of the day that is done makes only a word about the past true ("I started
the landing page job this morning, and it is done"), never a word about now
or later ("On it", "I'll start it", "Job started", "I started it a minute
ago"). Such a report must also name that job when it names work: "I started
the push" is not the landing page job. With no work of the
day, every such sentence is sent back: an older job that is done makes no
claim true. A sentence that is sent back goes to the model once more,
with no tool named, because you asked for none. When the second answer says
it again, you get plain words: "Nothing was started or changed for that
message. Say what I should do, and I do it." "I started to look at that"
and "I started with the header" are a way to speak, and no start of work.

ClawdTime checks its own answer when you asked for work, for a window to
change, or to see a session. When the answer says
that it did something ("I added that to the job") and no tool that acts ran in
that turn, the model answers once more and can then do it, through the same
checks as always. When the second answer claims it again, you get plain words:
"I have not done that: nothing was started or changed for it. Say it once
more." An answer about an earlier time ("the job I started is still running",
"I started that two minutes ago") is said as it is. An answer that says it
happens now counts too, with "I am" or with no "I" at all: "Starting a job to
add a dark mode", "I'm opening docs", "On it, adding the form", "Started a job
for that", "Job started", "Working on it". So does a promise with no
condition: "I'll start a job for that", "Let me add the form". "Starting a
job would need the page", "Adding a form is not possible from here", "I'll
start it once you say go" and "Adding the form. Which page?" claim nothing,
and are said as they are. When your message speaks of a session that runs
("deploy fix needs a dark mode"), the check asks only for a true answer: it
names no tool, so that no new agent starts for it.

### Give it a task

While the desktop service runs, you can hand ClawdTime a task in the same
conversation, typed, spoken or on a call. It goes to the same task service as
the task field of the board, with the same receipts. In simulation the task is
recorded and stays queued; no coding worker starts.

| You say                                                                              | What happens                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| "Start a task: fix the login test" or "New task: ..." or "I have a job for you: ..." | A task starts. Its goal is your words after "task" or "job". |
| "How is the task?"                                                                   | It says where the task is and what it asks. Nothing changes. |
| One of the offered choices, or your answer in a sentence                             | Your answer goes to the question that the task asks.         |
| "Accept the result"                                                                  | The result is accepted, when the task is ready for that.     |
| "Cancel the task"                                                                    | The task is canceled.                                        |

When the task asks a question with choices, ClawdTime says them, and the chat
screen shows them as buttons under its message. A click sends that choice as
your message.

The rules, again in the code:

- A task starts only when your own last message asks for one. The goal is your
  words. When the model rewords the goal, your own sentence is sent.
- An answer, accept and cancel go through only when your own last message says
  so. A question about the task changes nothing.
- One message never starts two tasks: each turn has its own event id, and the
  task service acts once for an id. While a task is active the service refuses
  a second one.
- A sentence that names the task is about the task. "Cancel the task" never
  denies an agent that waits for you; a plain "approve" or "deny" still goes to
  that agent.
- ClawdTime has no way to stop sharing or to stop a call from a conversation.
  Those stay on the mascot's bar, the board and the menus.

In a plain terminal with no desktop service (`clawdtime chat` alone) there is no
task service to reach. A task that you ask for there starts as a job. With a
desktop service, `clawdtime chat TEXT` reaches its task service: see the next
section.

### One message from a command, and the desktop service

`clawdtime chat TEXT` answers one message and exits. A FaceTime call on the
line uses this command for what the caller asks. When a desktop service runs on
this Mac, the service answers the message. It has the task, the engine for
computer work and the conversation of the panel, and the command alone has none
of them. So "click the blue Send button", said on a call, reaches the same
place as the same words typed in the chat of the panel.

How the command finds the service:

1. The folder is `CLAWDTIME_DESKTOP_STATE`, a full path, when that variable is
   set. Otherwise it is the folder `desktop` in the state folder
   (`CLAWDTIME_CONFIG_HOME`, or `~/.local/share/clawdtime`). Start the desktop
   service with `--state` on that folder, or name its folder in the variable.
2. The command reads `desktop-service.json`, `desktop-panel.json` and
   `owner.lock` there. Each must be a regular file of this user for its owner
   only, in a folder for its owner only. The files must agree, the address
   must be `http://127.0.0.1` with a port, and the process that wrote them must
   run.
3. It reads `GET /desktop/state` and `GET /desktop/chat` with the panel
   credential, and waits 2 seconds at most for both. The state must name the
   same instance as the files. The chat says whether the service has a
   language model.
4. It sends the text once, to `POST /desktop/chat`, and prints the answer. The
   text is cut at 2,000 characters.

The command answers by itself, as it does with no service, in these cases:

- One of the steps 1 to 3 fails.
- The service has no chat (`--agents false`).
- The service has no language model and the command has a key for one. Such a
  service could only tell the state, so the command alone answers better.
  Start the desktop service with `CLAWDTIME_OPENAI_API_KEY` in its
  environment and it takes the messages.

Words that start with a dash are an option of the command, such as
`clawdtime chat --recent 12`. They are never sent as a message.

After step 3 the message may be with the service. When no answer comes back
then, within 110 seconds, the command says so and stops. It does not send the
message again and it does not answer it by itself: two brains must not act on
one sentence.

What changes for a call when the service answers: a job that the caller asks
for runs in the project of the desktop service, not in the folder of the line,
and the language model is the one of the service.

The credential goes to the loopback address of the service and nowhere else.
It is never printed.

`clawdtime chat` with no text keeps its own conversation in the terminal, as
before.

### Find a session

A board name such as `work-13` says nothing about the job. Claude Code gives
each session a short title and shows it in the title bar of its terminal.
ClawdTime reads that title from the end of the session file. It reads only
lines of that one kind: never a prompt, an answer or a tool result. The title
stays out of the board snapshot.

When you ask for a session, your own words decide:

1. A name that you said in full wins.
2. Otherwise ClawdTime counts how many of your words stand in each session's
   name or title. One session with the most words is the answer when at least
   two words fit, or when every word that you gave fits. Words agree but for a
   plain ending ("lines" and "line"). The start of a word is not that word,
   and what you rule out ("not the billing one") is not counted.
3. When your words fit several sessions, or only one word of several fits,
   ClawdTime names them and asks which one. It opens none.
4. When the language model chose another session than your words describe,
   ClawdTime names both and asks. The model's choice stands only where your
   words name no single session, as in "open it".
5. A session that has a window is not hidden by a better fit that has none.

ClawdTime also says how exactly it landed. "Opened" means the tab or the pane.
When only the terminal application came forward, it says so.

A session comes to the front only when your own words ask to see it: "show me
the payments one", "open deploy fix", "switch to docs", "can I see payments?",
"bring it up". The words must open their part of the sentence, and what they
ask to see must be a session:

- its name, and nothing else: "payments", "the deploy fix one";
- a word that points at one: "it", "that one", "the other one that's still
  working";
- a description whose head is a word for a session: "the Terminal session
  with the Claude Code checking the lines", "the one that fixes the login
  bug".

So these open nothing:

- A question about a session: "what's the payments one doing", "does it show
  errors?". You get words. A window that comes forward takes your screen.
- The same words in another sense, and work: "in my view", "the show must go
  on", "open a pull request", "open a new terminal and run the tests", "look
  at the payments logs and fix the bug".
- "Show me the status" and "show me what waits": you asked for words.
- "Don't open it", and a request that you take back in the same message:
  "open payments, actually never mind". "Open payments, no, docs" is a
  correction, and "open payments but don't type anything" is still a request.
- Words for a session: "tell docs: open the file".
- A request for later, with something to wait for or a time: "show me
  payments, when it is done", "open docs, once the build passes", "open it in
  ten minutes". ClawdTime has nothing that opens a session later, so it opens
  nothing now. "Show me payments, if you can" and "open docs, before I
  forget" wait for nothing, and open at once.

When the part of your sentence that asks names exactly one session by its own
name, it opens at once: ClawdTime does not wait for the model to choose it,
and "show me the deploy fix one and make it bigger" does both. Another part of
the sentence does not choose the session: "show me the other one, payments is
done" does not open payments. One message opens a session once. The common typos count:
"shwo me the payments one", "opne docs", and a long name with one wrong letter
("the paymnts one").

"The other one", "another one" and "a different one" never mean the session
that you asked to see just before: that one does not open again.

Speech has fillers, and they do not hide a request: "um, can you like go back
to the deploy fix one" opens it. After a question about the sessions in the
same message ("what's waiting on me? open it"), ClawdTime makes sure that the
second part is not left out.

Shorthand means what the long form means: "lemme see docs", "gimme the login
page one", "yo pull up docs real quick", "show docs plz" open the session, and
"k can u tell deploy fix to push the branch pls" types "push the branch". A
question in shorthand is a question ("yo wats everyone doin", "bro r the
tests done"): it gets the state, and it never starts work. "Lemme tell docs
to wait" is what you do yourself, and "gimme a sec" asks for nothing: nothing
opens and nothing is typed for those. "Give me that" can ask for words, so it
opens no session: after "gimme" and "give me", say which session. "Nvm" and
"nm" take a request back, as "never mind" does.

When you ask what the sessions do ("what's everyone up to?"), the answer
names each session that works or waits, so that you can ask for one of them.

"Ok show me", with nothing after it, can open one session only: the one that
you and ClawdTime just spoke of. Your last message and its answer must name
exactly one session, by its full name or as "the payments one". "Show me"
can also ask for words ("what did the job find?", then "show me"), so
ClawdTime decides from the conversation whether to open that session; no
other session can open for it. Right after a job started, and while a task is
not over, "show me" means that work and opens no session. A question mark
makes it a question, and "no, show me" is not read this way. A bare "show me"
never starts work.

When a request to see fits more than one session ("show me the one that's
still working", "open the payments one"), and it is your whole message,
ClawdTime asks in a fixed form: "Which one: deploy fix or payments tests?".
Answer with a name, or with its place: "the second one", "the first", "the
last one", "the latter". A place is read only against that question, while it
is the last message and at most ten minutes old. For a list in ClawdTime's
free words, a place opens nothing, also with more words after it ("the
second one you listed"): say the name. ClawdTime does not ask this
question when you ask for several sessions ("the payments ones"), or when the
exchange just before names one of them ("show me the payments one again").

"No wait, the other one that's still working", after a request to see one
session, opens the one other session in that state. With two sessions in all,
"the other one" is the other. When two fit, ClawdTime works out which one you
mean, or asks. Words that take it back at the end ("the other one, no wait")
open nothing.

Right after you asked to see a session, your next message can be only the
session, within ten minutes: "no wait, the other one", "and the docs one",
"the web one" as the answer to "which one?". A remark is none: "now the docs
one is stuck".

### The window of a session

| You ask for            | Terminal                   | Ghostty                    |
| ---------------------- | -------------------------- | -------------------------- |
| Fill the screen        | Yes                        | Yes                        |
| Back to its own size   | Yes                        | Yes                        |
| Bigger or smaller text | No: it is a shared profile | Yes, for that one terminal |

This uses each terminal's own scripting. It sends no key and no text to the
session, and it needs no Accessibility permission. ClawdTime changes a window
only when your own last words ask for it. Ghostty offers only a switch between
two sizes, so ClawdTime reads the size of the window first and sends the switch
only when the size is not the one you asked for. When it cannot read the size,
it changes nothing. Other terminal applications get a plain "I cannot".

### What it sees

When you ask ClawdTime to look, it takes one picture of the main screen, makes
it smaller, and sends it with your question to the vision model
(`CLAWDTIME_VISION_MODEL`, by default `gpt-4.1-mini`). The picture is written
to a private folder, read once and removed. Nothing of it is kept.

- A picture is taken only when your own last words ask to look: read, look,
  see, check, describe, "what does it say". The language model alone takes
  none, and one message takes one picture.
- The question is your own sentence.
- What the screen says is data. ClawdTime says it. It follows no instruction
  that a page, a message or a window holds.
- macOS asks once for Screen Recording permission, for the application that
  started ClawdTime.
- Close what you do not want in the picture before you ask.

### Give it a job

ClawdTime answers and decides. It does not build, run or browse by itself. When
you ask for work that none of its own tools does, it starts a new session of
your coding agent in a terminal window that you can see, with your request as
its first message. Build or fix software, run a command, start a server, open
a tunnel and get its link, find something out: all of these are jobs.

- The job is your own sentence. The language model chooses the tool. It does
  not choose the words.
- Work that you asked for starts with no round of confirmation. When the
  language model only offers the work ("I see no session about that. Should
  I start a job to look into it?"), the code asks it once more to start the
  work. The tool that starts a job still decides from your own words. This
  check runs only in a turn in which nothing happened yet and nothing waits
  for your answer, and only for a message that is new work for sure: it
  opens with a verb of work, names no session and speaks of no state. A
  question to ClawdTime, a request to watch, words for a session, "check
  what's running" and "open the settings page" are none. An offer is a
  question with a word of starting or with your own verb ("Should I start a
  job for it?", "Should I fix it now?"). A question that you must answer
  ("staging or production?", "Should I update the docs too?") stands. When
  the second answer starts nothing either, you get the first one: the offer
  was true.
- "Build me a status page", "make us a pricing page" and "and build me a
  small dashboard" start at once, as "build a landing page" does. In this
  form only a short list of things starts by itself: a site, an app, a
  dashboard, a bot, a CLI, an API, an endpoint, a landing page; and a page,
  a script, a test, a file, a config, a tool or code only with a software
  word beside it ("a status page", "a config file", "a unit test", "a cli
  tool") or, for a script, with what it does ("a script that renames the
  files"). Only the thing itself counts, not what stands after it. Any other
  request of this form is read by ClawdTime as before, and can still start:
  "build me a library for parsing dates". "Make me a table of the tests",
  "write me a script for my presentation", "make us a hiring workflow",
  "write me the status", "update me" and "build me a page when you have
  time" start nothing by themselves.
- Name the agent and it gets the job: "open Claude and build a landing page",
  "use Codex to fix the tests", "fix the tests with Codex". "Not with Codex"
  gives the job to the other one, and so do "no Codex" and "avoid Codex". The
  name also counts in fast or sloppy words ("opn codex nd write the tests"),
  as long as it stands in your message: that sentence starts at once, too. A
  session whose name stands in the work ("... write tests for the login page",
  with a session named "login page") does not hold the job back: you asked
  for a new agent. Work that speaks to a session ("open Codex and tell login
  page to ...") is routed as before, and so is work that names a session of
  the same agent ("use Claude to fix the bug in payments", with a Claude
  session named payments): you can mean that session. With no agent in the sentence, the agent of
  `CLAWDTIME_JOB_AGENT` takes it. "Open Claude and build ..." starts at once,
  also while sessions of that agent run. "Tell Claude to ..." and "open my
  Claude session and ..." can mean a session that runs, so ClawdTime works out
  which one you mean.
- A sentence with a "don't" in it can be a limit of the work ("build a landing
  page, don't use a framework") or a refusal ("don't, I changed my mind"). No
  program can tell these apart safely. So such a sentence starts nothing:
  ClawdTime asks one question that names the work, and starts it only when
  your next message is a plain yes, on the same channel, within five minutes.
  "Okay" or "sure" alone is not a yes. Any other answer starts nothing; say
  the work again to start it.
- While that question is open, no answer of yours decides a request of an
  agent. When a request arrives then, ClawdTime says what it is, and only
  "approve" or "deny" decides it. A request whose text looks like a password
  or a key is not said: read it in the agent's terminal.
- A job can read what you said before it, from a file in its folder, so "fix
  that one" has a meaning there. Only your own messages go into that file,
  never an answer of ClawdTime. When your sentence points back ("that one",
  "it", "again") and the job before it finished in the last 30 minutes, the
  new job also gets the path of that job's answer. An answer that holds a
  password or a key is not passed on.
- When your sentence is more work on the thing of the job before it ("add a
  contact form to it", "make them blue", "fix that one") and that job still
  runs, the new job waits for it: two sessions that change the same files at
  one time lose work. The word must stand at the start of the sentence, before
  any "and", "then", "that" or comma: "find the big files and list them" is
  other work and starts beside the running job, as before.
- A correction to a job that still runs waits for it too: "wait no, it's a
  cafe not a bakery". A job that runs cannot be changed, so the correction
  is a job of its own that starts after the first. Two forms count: a
  contrast that names a word of the job's request ("cafe, not bakery",
  "instead of a bakery"), and, as your next message after the request, a
  word of correction ("wait", "no", "sorry", "I meant") before a statement
  about the thing ("it's a cafe", "the name is ..."). Other work that opens
  with such a word ("actually, find the big files") starts at once, as
  before. This rule only decides the wait: your words still pass the same
  gate before anything starts.
- A change of mind about the job that your last message started, said as
  an instruction about the thing, is started by the code itself as a job
  that waits: "nah make the buttons bigger instead", "change the mode
  instead", "actually make that a cafe instead of a bakery". The list is
  short on purpose. It must be your next message after the request; it
  opens (after "nah", "no", "actually" and the like) with make, add,
  change, use, fix, update, remove, rename, replace, write, build or
  create; right after that verb it names a thing of software with "the",
  "its", "that", "this", "these" or "those" (the buttons, that header), or
  it holds a word that is the job's own (the bakery of a bakery page); and
  nothing in it stops, delays or gives a time ("make it stop", "do it
  later", "after lunch"). Everything else is read by the language model:
  "set an alarm instead", "write a text to my mom instead" and "use a
  serif font instead". A job that the model starts for such a message
  waits too. A job that starts this way goes through the same gate as
  every job, and ClawdTime says that it starts when the job before it is
  done. The first job is not stopped: no tool does that, and ClawdTime
  never says that a job was cancelled or changed.
- A job that waits opens its terminal window at once and shows that it
  waits. ClawdTime says that it waits, and the state says so until it starts.
  It starts when the job before it wrote its answer, or when you press Return
  in its window. When the job before it wrote no answer in two hours, the job
  that waits does not start: it says so as its answer, and a job that waits
  for that one does the same. A job that waits counts as one of the four
  jobs.
- The job is written to a file and is never part of a shell command. No spoken
  word can become one. The start script holds only paths that ClawdTime made.
  The job reaches the agent as one argument: other users of this Mac can see
  that argument in the process list while the session runs.
- The session runs under your own agent settings. ClawdTime adds no permission
  and removes none. Whoever can talk to ClawdTime can start a job, so a job can
  do on this Mac what your coding agent is allowed to do.
- A question, a thank-you, a request for the state, a sentence that takes work
  back ("never mind", "do not"), a bare yes or no, and one or two words start
  no job. One message starts one job. At most four jobs run at one time.
  Praise alone starts nothing, and praise that goes on with an instruction
  starts it: "nice, now add a dark mode to it".
- A question stays a question behind a word of correction or a joining
  word: "wait what did the first one say again", "and which file was the
  biggest", "so how long did it take", "well is it done". Such a message
  starts no work, whatever the language model chooses. An instruction
  behind the same words is still work: "wait, make the buttons bigger
  instead", "so when you are done, run the tests", "then have it deploy",
  "ok so what I want is a landing page".
- While an agent's request waits for your answer, a sentence starts no work
  unless it names a task or a job. "Yes, update the config" answers the
  request and does nothing else.
- A request that holds a password or a key starts no job.
- The session writes a short answer to a file. ClawdTime says that answer when
  you ask, and it shows in the status for one day. "Is it done?", as your
  next message after you started a job, is about that job. The answer is data:
  ClawdTime does not follow instructions inside it. An answer that holds a
  password or a key is not said and not sent: read it in the job's terminal.
- A question while ClawdTime started a job in the last day starts from the
  jobs' answers: the code reads the job list before the language model
  answers, unless it read the state (which shows the jobs) or your words
  fit a session. With no answer in front of it, the model made one up
  ("the biggest file is large_video.mp4").
- No tool stops a job. When you tell ClawdTime to stop one that still
  works or waits ("actually cancel that", "stop it", "kill the bakery
  job"), the code answers itself, with no language model: it cannot, the
  job runs in its own terminal window, and you stop it by closing that
  window. It also says that the job then writes no answer, so it stays
  listed as working for up to a day. With several jobs it names each one
  that is not done. Words that name the job count at any time ("the job",
  "the bakery one"). A word that only points ("it", "that", "the build",
  or a bare "cancel") counts only when ClawdTime's last message was about
  a job and nothing else waits for a stop: a request of an agent, a
  computer task. A task that is live owns every stop, and so does a
  session that your words fit. After ClawdTime's own yes or no question,
  "cancel that" is a no.
- An offer to cancel, stop or restart a job is never said: no tool does
  that. When an answer about the jobs or the state makes such an offer
  while a job works or waits, the language model answers once more without
  it, and a second such answer loses the sentence with the offer and keeps
  the rest. When what is left is nothing, or only a "yes" or "sure", it
  says what is known of the jobs instead. Only a sentence that speaks of a
  job counts: the word "job", a word of a job's request before "one" or
  "job" ("the bakery one"), or, when you asked about a job, a word of a
  request or "it". An offer in a sentence that names a session or the task
  is another matter, and "I cannot stop it" is no offer.
- With several jobs in the last day, "what did the first one find?" gets
  the first one's answer: the job tool gives the language model each job
  of the last day (the newest five), in the order in which they started,
  each with its answer or that it still works. The check of an answer
  about a job that still works then guards each such job in the list: a
  time is right when it fits the start of any listed job, and a second
  wrong answer is replaced by one sentence for each job that still works,
  with its request and the time it has run, and the newest finished job
  with its answer. The check reads only the jobs that the language model
  saw in that turn.
- When a job is done, the chat of the desktop panel says its answer by
  itself, once: a line "Done:" with your request, then the answer. The
  desktop service writes it into the conversation on its own rhythm, and
  the panel shows it while the chat is in view. The line waits while a
  question of ClawdTime, or a message of yours, waits for its answer, for
  at most five minutes, so that "the second one" still follows its
  question on the screen. The line is marked as news: no rule in code reads
  it as ClawdTime's answer to something, so a "yes" after it still answers
  the question before it, and the language model gets it as data from a
  session. A job that started before the service first kept this record
  is not said. An answer that holds a password or a key is not said, as
  before. In `clawdtime chat` with no desktop service nothing runs between
  your messages: ask "is it done?" there.
- After a job is done, its session is over. More work on what it made
  ("now make the header blue") is a new job, which reads the answer of the
  job before it. ClawdTime starts it and does not ask for a session to type
  into.
- While a job still works, ClawdTime knows its request and how long it has
  run, and nothing else: a job reports nothing until it writes its answer.
  A complaint about the time ("why is this taking so long?", "this is
  taking forever") is read as a question about the state: the code reads
  the state and the job before the language model answers, so the answer
  starts from the time the job has run. Only when a job is not done and
  the thing that takes long is that job: a word that points is the subject
  ("this", "it"), or the words name the job by a word of its own ("hows
  the downloads thing coming along"). "Look into why the login is slow" is
  work to do, and the state is not read for it. A question that names a
  job by a word of its own counts as a turn about that job, so its answer
  is checked. An answer about a job that was read
  in that turn is checked in code. When it says what the job does now ("it
  is going through the logs"), how far it is ("almost done"), another time
  than the job has run, or no time when you asked how long, or when it
  offers to look into the job, to speed it up or to stop it, the language
  model answers once more. A second such answer is replaced by a sentence
  with only what is known: that it still works, how long it has run, that
  it runs in its own terminal window where you can watch it, and that you
  can ask again for its answer.
- When the coding agent is not installed, the job ends at once and says so.

Jobs and applications work in `clawdtime chat` and in the chat of the desktop
panel. In the panel, a task that you ask for goes to the task service. When
that service runs with no coding worker, the task is only written down. Start
the desktop service with `CLAWDTIME_SIMULATION_JOBS=on` to send such a task to
a job. `CLAWDTIME_DESKTOP_WINDOWS=off` turns jobs and applications off in the
panel's chat.

```sh
clawdtime jobs           # the jobs and their answers
clawdtime jobs --json    # the same as data
```

| Variable                 | Default                   | Use                                   |
| ------------------------ | ------------------------- | ------------------------------------- |
| `CLAWDTIME_JOB_AGENT`    | `claude`                  | The coding agent: `claude` or `codex` |
| `CLAWDTIME_JOB_PROJECT`  | The folder of the command | The folder that the session works in  |
| `CLAWDTIME_JOB_TERMINAL` | `Terminal`                | The application that opens the window |

The files of a job are in `agents/jobs/` in the state folder, for their owner
only: the request, the start script, the answer, and what you said before the
request (`context.txt`). Work that waits for your yes is in `offer.json` there,
for five minutes at most.

### Hear when a session is done

ClawdTime answers when you ask. Two things it says later by itself, in the chat
of the desktop panel: the answer of a job that it started, and that a session
is done, when you asked to hear that.

- "Tell me when deploy fix is done", "keep an eye on deploy fix", "watch docs
  for me" and "let me know if deploy fix fails" ask for one session. When the
  request is said to ClawdTime and names one session in full right at the
  request, with nothing more named after it, the code takes the request by
  itself. "I'll watch docs", "watch the docs build logs" and "did you watch
  docs?" are none. For any other form the language model calls the tool
  `watch_session`. The tool takes a request only when your own last message
  asks to hear something later (a list of forms in code), is no question
  about it, is no words for a session and takes nothing back, and a session
  that your words name wins over one that the model names.
- "Let me know if anything breaks", "tell me when they're all done" and "keep
  an eye on everything" name no session. The code then takes each session
  that works now, and the answer says their names. A session that starts
  later is not in it. "Let me know if something breaks in production" speaks
  of something else, and the code takes nothing for it.
- A yes to ClawdTime's own offer takes the request: after "Want me to keep
  an eye on deploy fix?" or "Should I tell you when docs is done?", "yes"
  takes that session, under the same conditions as a yes to an offer to
  open a session. "It" in such an offer is the one session that the
  sentence before names, or the one session of your plain question before
  ("is deploy fix done?", "Not yet. Want me to tell you when it's done?",
  "yes"). After a question with a word of contrast ("apart from docs, is
  the other one done?") nothing is taken. "Them" is the sessions that
  ClawdTime's own answer names, two or more of them; with fewer names,
  nothing is taken. After "Docs wrote a summary file. Should I monitor it?"
  nothing is taken: "it" is the file.
- When the session stops working, the chat says one line, once: "As you
  asked: deploy fix is done and idle now." The line says how the work ended
  when the board knows it: done, stopped on an error, or interrupted. A
  session that waits for you is not done, so nothing is said then. A session
  that leaves the board is said after 30 seconds away. After 12 hours of
  work the chat says so once, and the request ends.
- A session that is idle already has nothing to wait for: ClawdTime says so
  and takes no request. The chat waits for 8 sessions at most.
- "Stop watching deploy fix" and "no need to tell me when docs is done" end
  the request. Only your own words end it. "Don't stop watching docs" and
  "you can stop watching docs once it's done" end nothing.
- "What are you watching?" is answered from the state, which lists the
  sessions that the chat waits for. For this question the code also gives
  the language model the fact in plain words before it answers: the sessions
  that it watches because you asked, and the sessions that work and that it
  does not watch. A session that works is not watched for that reason alone:
  nothing is said by itself about it until you ask for that.
- Only the chat of the desktop service says by itself when a session is
  done, and only it takes a request for that. Where another brain answers
  your message (`clawdtime chat` alone in a plain terminal, and a call while
  no desktop service runs), ClawdTime says that it cannot take such a
  request there, and it offers and promises nothing about the end of a
  session. The state says so there, and for a question or a request about
  watching the code gives the language model that fact before it answers.
  What the desktop service waits for is not visible from there. Ask again
  to hear how a session stands. The instructions of the language model say
  the same there for every message, so a request in any wording ("give me
  a heads up if docs changes") gets that answer: no offer, no promise, and
  no job or task that you did not ask for.
- "What did I miss?", "anything new?", "any news?" and "catch me up" are
  answered from the state and from the lines that the chat said by itself
  since your last message: that a session is done, or the answer of a job.
  The code gives both to the language model before it answers, so the
  answer is that news and not the list of jobs. With no such line it says
  that nothing was said. A message that opens with a verb of work ("find out
  what happened to the deploy") is work, and is not read this way.
- This only reads the board. It types nothing into a session, opens nothing
  and starts no work. The line holds the name of the session, as one plain
  line, and how its work ended, and no text from the session.
- The line waits while a question of ClawdTime, or a message of yours, waits
  for its answer, as the line of a job does, and it is marked as news in the
  same way.
- ClawdTime keeps no timer and no reminder, and it watches nothing else. It
  says so when you ask for one.
- An answer never promises to tell, watch or remind later with nothing
  behind it. "Got it, I'll remind you in ten minutes" and, after "is deploy
  fix done?", "Not yet. I'll let you know when it's done" go back to the
  language model once. A second such answer keeps what it says about now
  and loses the promise: you get "I keep no timer and no reminder. Ask me
  when you want to know.", or the offer "Want me to tell you when deploy
  fix is done?" for the one session that the promise named, and a yes then
  takes the request. A promise stands when it is true: this turn took the
  request, the chat already waits for that session, or away mode is on and
  the promise is not only about the end of the work (away mode calls for a
  request and for a failure). While a job that ClawdTime started still
  runs, a promise to tell when something is done stands: the chat says the
  answer of that job. When you asked for work and the answer only promises
  ("Sure, I'll report back when I know more."), the work starts first.
- The desktop service says the line on its own rhythm. In `clawdtime chat`
  with no desktop service nothing runs between your messages.

### The bar under the mascot

At rest the bar has two buttons: chat and talk. In a conversation it opens into
a microphone switch, the level of the voice as moving bars, a speaker switch and
an end button. The bars are blue while it listens and orange while it speaks,
and the mascot's light and mouth move with the voice. A pause of about one
second ends your sentence. ClawdTime does not listen while it speaks. The
speaker switch stops the voice at once; the answer still shows in the chat.

### The key and the models

Speech and the language model use the OpenAI API. Set `CLAWDTIME_OPENAI_API_KEY`
(or `OPENAI_API_KEY`) in the environment of the command that starts the desktop
service, `clawdtime chat` or `clawdtime talk`. Never put the key in an argument
or a file of the repository.

| Variable                         | Default                  | Use                                                                                |
| -------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `CLAWDTIME_SUPERVISOR_MODEL`     | `gpt-4.1-mini`           | Chooses tools and writes the answers                                               |
| `CLAWDTIME_SUPERVISOR_REASONING` | not set                  | The reasoning effort that this model gets. Some models take tools only with `none` |
| `CLAWDTIME_TRANSCRIBE_MODEL`     | `gpt-4o-mini-transcribe` | Turns your speech into text                                                        |
| `CLAWDTIME_SPEAK_MODEL`          | `gpt-4o-mini-tts`        | Speaks the answer                                                                  |
| `CLAWDTIME_VOICE`                | `alloy`                  | The voice                                                                          |

With no key ClawdTime still answers in text: it tells the state from the board,
and it takes a clear "approve" or "deny" when exactly one request waits. Voice
needs the key.

With a key, three things leave this Mac for the OpenAI API, and only when you
talk to ClawdTime: what you said or typed, your recording while it is turned
into text, and the state in words that the model asked for (session names and
the titles that sessions show in their terminals, project folder names, the
text of waiting requests, trove entries, the request and the answer of a job,
the text of a web page that you asked it to read, and a picture of the screen
when you asked it to look). Nothing is sent to the OpenAI API while you do not
talk to it.

The text channel is the one thing that works while you are silent. While
`clawdtime texts run` is on, it reads the messages of your project every few
seconds through the Chert service, and it sends the answer of each job that
finishes as a text to your own number. An answer can hold session names and
the text of a request. Stop the command to stop both.

## Terminal use

```sh
clawdtime agents send SESSION "run the tests again"
```

This types the text into that session's terminal and presses Return. It works
for a session in tmux, in Terminal, in iTerm2, and in Ghostty 1.4 or later.
Control characters are removed, so the text cannot carry an escape sequence. A
session in another terminal is refused with the reason.

With `--no-enter` the text stays on the line and nothing sends it: line breaks
in the text become spaces, because a line break in a terminal sends the line.

## Agent commands, use, and slides

```sh
clawdtime clis                 # installed agent commands, versions, sessions, last use
clawdtime report --open        # the same as a slide deck in the browser
```

Use is counted from the names and times of session files: Claude Code, Codex, pi
and dexter. No transcript is read. The deck is one file with no network: the
state now, each session, the agent commands and their use, the trove, the
playbook, and what to do next. Arrow keys move through it, and it prints.

## Browser use

```sh
clawdtime browser tabs         # every tab of the browsers that run
clawdtime browser open URL     # only http and https
clawdtime browser focus 3      # bring that tab forward
clawdtime browser text         # the visible text of the front page
```

Chrome, Safari, Arc, Brave and Edge. macOS asks once for permission to control
each browser. Reading page text also needs the browser's "Allow JavaScript from
Apple Events" setting. Work inside a page, such as filling a form, stays with an
agent that has a browser tool; ClawdTime supervises that agent.

## What is stored

Owner-only files under `~/.local/share/clawdtime/` (`CLAWDTIME_CONFIG_HOME`
moves it):

- `agents/decisions/pending/` and `answers/`: one small file for each request
  while it waits. It holds the request text, cut to 600 characters, so that you
  can see what you answer. Both files go when the hook is done.
- `trove/decisions.jsonl`, `trove/rules.json`, `trove/notes.jsonl`: the trove.
- `agents/decisions/call.json`: the link to a pairing for away mode. The pairing
  credential stays in its own connection file.
- `agents/chat.jsonl`: the conversation with ClawdTime, 2,000 characters for
  each message at most. A message that holds a credential is kept as a marker
  only.
- `agents/chat-watches.json`: the sessions that you asked to hear about, 8 at
  most: for each one its id, its name and when you asked. A request goes
  when its line is said or when you end it.
- `memory/settings.json` and `memory/facts.json`: whether memory is on, and the
  facts, 400 characters for each at most and 2,000 facts at most. Nothing is
  written there while memory is off.
- `agents/voice/`: one recording while it is turned into text, then it is
  removed; and the newest spoken answer only.
- `agents/watch.json`: the watcher's rules. `agents/watch-open.json`: the
  incidents that are open now. `agents/incidents.jsonl`: when each incident was
  raised, cleared or dismissed, the last 500 lines.

The board snapshot still holds no request text. Request text reaches the panel
only through `GET /desktop/decisions`, under the private panel credential.

## Limits

- Away mode needs a paired project and a live backend. The three call flows (a
  decision, a conversation, one sentence from the watcher) are tested against
  the real backend code with its simulated line, over HTTP. A call on a live
  line is not placed by a test: it needs your approval for that call.
- Codex decides its approvals through its hook only after you trust the hook
  with `/hooks`.
- Tab selection and typing through AppleScript (Terminal, iTerm2, Ghostty 1.4)
  and the browser commands are tested with a recorded command runner. tmux input
  is run for real.
- Chat, the guards, the trove and a full voice round trip (speech to text, the
  answer, text to speech) are run for real against the OpenAI API. The
  microphone in the panel is not tested: it needs your consent for the
  microphone.
- The first time you talk, macOS asks to use the microphone. The request names
  the app that started ClawdTime, for example your terminal.
