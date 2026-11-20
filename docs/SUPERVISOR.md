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
- Claude Code shows its own prompt at the same time. You can still answer in the
  terminal. The first answer wins, and a request that the terminal answered
  leaves the desk at once.
- A request waits 45 seconds on the desk. After that only the terminal answers.
  In away mode it waits up to 9 minutes.
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
  its value is refused.
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
- Bring a session's terminal to the front.
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
- Text is typed into a terminal only when it is part of what you said.

A critical decision is kept in your words. When the model rewords it with a word
that you did not say, your own sentence is stored.

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
task service to reach, and ClawdTime says so.

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

| Variable                     | Default                  | Use                                  |
| ---------------------------- | ------------------------ | ------------------------------------ |
| `CLAWDTIME_SUPERVISOR_MODEL` | `gpt-4.1-mini`           | Chooses tools and writes the answers |
| `CLAWDTIME_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | Turns your speech into text          |
| `CLAWDTIME_SPEAK_MODEL`      | `gpt-4o-mini-tts`        | Speaks the answer                    |
| `CLAWDTIME_VOICE`            | `alloy`                  | The voice                            |

With no key ClawdTime still answers in text: it tells the state from the board,
and it takes a clear "approve" or "deny" when exactly one request waits. Voice
needs the key.

With a key, three things leave this Mac for the OpenAI API, and only when you
talk to ClawdTime: what you said or typed, your recording while it is turned
into text, and the state in words that the model asked for (session names,
project folder names, the text of waiting requests, trove entries). Nothing is
sent while you do not talk to it.

## Terminal use

```sh
clawdtime agents send SESSION "run the tests again"
```

This types the text into that session's terminal and presses Return. It works
for a session in tmux, in Terminal, in iTerm2, and in Ghostty 1.4 or later.
Control characters are removed, so the text cannot carry an escape sequence. A
session in another terminal is refused with the reason.

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
  each message at most.
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
