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
- One message decides one request. The model names a request by its id, never
  by its place in a list, so an answer cannot move to another request when the
  list changes. When more than one request waits, your words must say which
  one: a word of what it asks, of its project or of its agent that the other
  requests do not have ("approve the npm test one"). Otherwise nothing is
  decided, and ClawdTime asks you which one.
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

ClawdTime checks its own answer when you asked for work, for a window to
change, or to see a session. When the answer says
that it did something ("I added that to the job") and no tool that acts ran in
that turn, the model answers once more and can then do it, through the same
checks as always. When the second answer claims it again, you get plain words:
"I have not done that: nothing was started or changed for it. Say it once
more." An answer about an earlier time ("the job I started is still running",
"I started that two minutes ago") is said as it is.

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
task service to reach. A task that you ask for there starts as a job.

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
- Name the agent and it gets the job: "open Claude and build a landing page",
  "use Codex to fix the tests", "fix the tests with Codex". "Not with Codex"
  gives the job to the other one, and so do "no Codex" and "avoid Codex". The
  name also counts in fast or sloppy words ("opn codex nd write the tests"),
  as long as it stands in your message. With no agent in the sentence, the agent of
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
- While an agent's request waits for your answer, a sentence starts no work
  unless it names a task or a job. "Yes, update the config" answers the
  request and does nothing else.
- A request that holds a password or a key starts no job.
- The session writes a short answer to a file. ClawdTime says that answer when
  you ask, and it shows in the status for one day. "Is it done?", as your
  next message after you started a job, is about that job. The answer is data:
  ClawdTime does not follow instructions inside it. An answer that holds a
  password or a key is not said and not sent: read it in the job's terminal.
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
