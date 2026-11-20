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
clawdtime agents pending                             # what waits
clawdtime agents approve 1                           # or: approve 1 --always
clawdtime agents deny 1 --message "Not before review."
clawdtime agents answer 1 2                          # the second choice of a question
```

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
first plain word (`git push`, `npm test`), every other tool by its name. A
command with pipes, lists or substitutions gets the bare key `Bash`, and the bare
key cannot become a rule. An answer given in the terminal is not in the trove,
because ClawdTime does not see which answer it was.

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
clawdtime setup --agent claude-code --project PATH ...   # the existing pairing
clawdtime agents call connect --agent claude-code --project PATH
clawdtime agents away on
```

- Only clear words count. "Approve", "yes", "go ahead" allow. "Deny", "no",
  "stop" deny, and your words become the reason for the agent. Unclear words, both
  at once, silence or other sound never approve: the call asks again, up to three
  times.
- One request places one call. An unanswered call leaves the request for the
  panel and the terminal.
- The supervisor claims no screen and no input for the call. It only talks.

## Talk to ClawdTime

ClawdTime is also an agent that you can talk to. It sees what the board sees and
acts through the same desk and trove. There are three ways, and they share one
conversation:

| Way | How |
|---|---|
| Text | The chat button on the bar under the mascot, or `clawdtime chat`. `clawdtime chat "what needs me?"` answers one question and exits. |
| Voice on the Mac | The talk button on the bar, or `clawdtime talk`. You speak, it answers aloud. |
| FaceTime | `clawdtime agents call me`. ClawdTime calls you through the linked pairing and you talk to it. Say goodbye to end the call. |

What it can do when you ask:

- Say what every agent does and what waits for you.
- Allow or deny a waiting request, or answer a question with one of its choices.
- Bring a session's terminal to the front.
- Type your words into a session's terminal.
- Search the trove, and keep a critical decision that you state.
- Turn away mode on or off.
- List the agent commands on this Mac and their use.

Two rules are in the code, not in the model's instructions:

- A request is allowed or denied only when your own last message says so. "What
  does it want?" allows nothing. "Yes, approve it" allows it. The same reading
  of your words is used on a call.
- Text is typed into a terminal only when it is part of what you said.

A critical decision is kept in your words. When the model rewords it with a word
that you did not say, your own sentence is stored.

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

| Variable | Default | Use |
|---|---|---|
| `CLAWDTIME_SUPERVISOR_MODEL` | `gpt-4.1-mini` | Chooses tools and writes the answers |
| `CLAWDTIME_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | Turns your speech into text |
| `CLAWDTIME_SPEAK_MODEL` | `gpt-4o-mini-tts` | Speaks the answer |
| `CLAWDTIME_VOICE` | `alloy` | The voice |

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

The board snapshot still holds no request text. Request text reaches the panel
only through `GET /desktop/decisions`, under the private panel credential.

## Limits

- Away mode needs a paired project and a live backend. The call path is tested
  against the protocol with a scripted backend; a real call needs your approval
  for that call.
- Codex decides its approvals through its hook only after you trust the hook
  with `/hooks`.
- Tab selection and typing through AppleScript (Terminal, iTerm2, Ghostty 1.4)
  and the browser commands are tested with a recorded command runner. tmux input
  is run for real.
- Chat, the guards, the trove and a full voice round trip (speech to text, the
  answer, text to speech) are run for real against the OpenAI API. The
  microphone in the panel and a conversation on a real FaceTime call are tested
  with a scripted backend only: the first needs your consent for the
  microphone, the second your approval for that call.
- The first time you talk, macOS asks to use the microphone. The request names
  the app that started ClawdTime, for example your terminal.
