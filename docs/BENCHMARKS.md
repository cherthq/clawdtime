# Benchmarks

This page tells you how we measure ClawdTime, how to run each measure, and
the current numbers. It also tells you which published numbers you can
compare with ours, and which you cannot.

The numbers are from 28 November 2026, on `main` at `9729113`, unless a
section gives a different date.

## Summary

| Question                                          | Answer on 28 November 2026                               |
| ------------------------------------------------- | -------------------------------------------------------- |
| Does ClawdTime have a rank on a public board?     | No. ClawdTime has no run on a public board yet.          |
| Planner eval, best models                         | 78 of 78 right (gpt-5.4, claude-opus-5-5, gpt-6.2-astra) |
| Request eval, best models                         | 30 of 30 requests done (8 of 13 models)                  |
| Chat eval, best models                            | 55 of 55 right (5 of 12 models). Gemini models: 6 of 55  |
| Fastest planner with 30 of 30 requests done       | claude-sonnet-5-5: 1.7 s for the median step             |
| Default planner (gpt-6.2-astra)                   | 30 of 30 requests done, 3.2 s for the median step        |
| Score to enter the top 5 of the main public board | Above 82.8 percent on OSWorld-Verified (100 steps)       |

Our own evals cannot rank ClawdTime against other agents. They use our own
tasks. The best models now get every case right, so these evals no longer
show a difference between the best models. To get a rank, ClawdTime must run
on a public board in that board's own harness. See
[How to get a comparable number](#how-to-get-a-comparable-number).

## The measures

ClawdTime has three evals in this repository. They need no screen. They open
no window and send no input to your Mac. The harness is the same for each
model. Only the model of the planner, or of the chat, changes.

| Measure      | What it measures                                                                 | File                             |
| ------------ | -------------------------------------------------------------------------------- | -------------------------------- |
| Planner eval | One decision on one screen: is the next action right, and how fast is the answer | `tests/computer-planner.eval.ts` |
| Request eval | One whole request from start to end: is it done, in how many steps, and how fast | `tests/computer-request.eval.ts` |
| Chat eval    | One message of the owner: is the first action of the chat agent right            | `tests/chat-agent.eval.ts`       |

We also run requests on a real Mac, on its real screen. Those scripts are
not in this repository, because they take the screen of the Mac that runs
them.

### Planner eval

Each case is one decision. The case gives a goal, a rendered screen with its
named elements, and sometimes earlier steps. The real planner code builds
the request, a real model answers, and a check says if the action is right.
Some screens have targets with no name, so only a click at a point in the
picture reaches them. Some screens hold text that tries to give the model a
new task. A quarter of the cases are held: you judge a change on them, but
you never design a change on them.

The run of 28 November used the 39 cases of `main`, 2 runs each.

| Model                  | Right | Held cases right | Median answer | 90th percentile |
| ---------------------- | ----- | ---------------- | ------------- | --------------- |
| gpt-5.4                | 78/78 | 20/20            | 1.4 s         | 1.6 s           |
| claude-opus-5-5        | 78/78 | 20/20            | 2.1 s         | 3.1 s           |
| gpt-6.2-astra          | 78/78 | 20/20            | 2.5 s         | 3.4 s           |
| claude-sonnet-5-5      | 76/78 | 18/20            | 1.7 s         | 2.7 s           |
| gpt-6.2-sol            | 75/78 | 17/20            | 1.8 s         | 2.1 s           |
| claude-fable-5-2       | 74/78 | 18/20            | 1.5 s         | 2.0 s           |
| gemini-4-neon          | 74/78 | 18/20            | 5.7 s         | 14.3 s          |
| claude-haiku-5-5       | 73/78 | 18/20            | 1.3 s         | 1.9 s           |
| gemini-4-hydrogen      | 71/78 | 17/20            | 4.2 s         | 7.7 s           |
| gemini-4-carbon        | 71/78 | 17/20            | 8.7 s         | 24.1 s          |
| gemini-4-argon         | 70/78 | 18/20            | 5.8 s         | 10.2 s          |
| gemini-3.1-pro-preview | 69/78 | 17/20            | 4.5 s         | 8.5 s           |
| gemini-3.8-flash       | 64/78 | 16/20            | 4.8 s         | 8.9 s           |

The wrong answers fall into four classes:

- **A service that the model does not know.** The goal names an invented
  service. The right action is to open its address, or to ask for it. 7 of
  13 models typed the name into the address bar in at least one run.
- **Points on a drawn screen.** The Gemini models missed small drawn
  targets. Many of their points hit the target only on a grid of 0 to 1000,
  not in the pixels of the picture. For example, 5 of the 7 wrong clicks of
  gemini-3.8-flash land on the target after a change from that grid to
  pixels. The Gemini 4 models also asked for a closer look where one click
  was right.
- **Replace text.** claude-haiku-5-5 and claude-fable-5-2 clicked the field
  before they selected its text.
- **A step that worked, done again.** claude-haiku-5-5 saved again after the
  save worked (1 run).

We added 6 cases on 28 November for the failure classes of the real runs on
a Mac. The planner eval now has 45 cases (55 with `--new-actions`). Each new
case passes `--check`. We ran each new case 3 times on each model. 11 of 13
models got all of them right. gemini-4-argon clicked the trash button in 3
of 3 runs of "a question before a delete names the note". The person had
said to ask first. gemini-4-carbon did not answer that case in time.

| New case                                                      | Failure class from a real run                         |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| close without saving, as the person asked: the discard button | The Delete button of a save sheet was read as a loss  |
| a second part of the request is left: quit the app            | The quit at the end of a request was not done         |
| a completion list is open: take the typed tag                 | A list of completions stopped the typing of a tag     |
| an effect that worked is not done twice, also after a wait    | A new note was made two times                         |
| the screen shows six of seven notes: no done yet              | The planner said done, but the screen did not show it |
| a question before a delete names the note                     | A question did not name the file that it was about    |

### Request eval

The real worker does each request from its start to its end. It looks,
plans with a real model, checks each action in code, asks the person where
the checks tell it to, and acts. Only the hands change: they act on small
apps in a browser with no window. A check of what the app holds at the end
says if the request is done. Some requests carry faults: a rate limit, an
outage, a malformed answer, a window that moves, and a click that the app
does not take. Seven long requests need 31 to 47 steps.

The run of 28 November used 30 requests, 1 run each. "Seconds" is the sum of
the 30 requests. The requests run at the same time, so the run takes less
time than that.

| Model                  | Done  | Steps | Seconds | Median step | 90th percentile step |
| ---------------------- | ----- | ----- | ------- | ----------- | -------------------- |
| claude-sonnet-5-5      | 30/30 | 331   | 548     | 1.7 s       | 2.8 s                |
| gpt-6.2-sol            | 30/30 | 318   | 623     | 1.9 s       | 2.6 s                |
| claude-opus-5-5        | 30/30 | 305   | 715     | 2.0 s       | 2.9 s                |
| gemini-4-hydrogen      | 30/30 | 293   | 1217    | 4.0 s       | 5.6 s                |
| gpt-6.2-astra          | 30/30 | 316   | 1368    | 3.2 s       | 8.6 s                |
| gemini-4-argon         | 30/30 | 307   | 1858    | 6.0 s       | 8.0 s                |
| gemini-4-neon          | 30/30 | 321   | 2214    | 5.6 s       | 9.1 s                |
| gemini-4-carbon        | 30/30 | 313   | 3111    | 7.3 s       | 17.0 s               |
| claude-fable-5-2       | 29/30 | 304   | 535     | 1.5 s       | 2.6 s                |
| gemini-3.1-pro-preview | 28/30 | 338   | 1976    | 5.0 s       | 10.2 s               |
| gpt-5.4                | 26/30 | 340   | 633     | 1.4 s       | 2.1 s                |
| claude-haiku-5-5       | 25/30 | 413   | 831     | 1.9 s       | 3.6 s                |
| gemini-3.8-flash       | 25/30 | 321   | 2201    | 4.2 s       | 10.9 s               |

The requests that were not done fall into four classes:

- **Done without proof.** gpt-5.4 said "Done" in 4 long requests, but the
  apps did not hold the result. gemini-3.1-pro-preview and gemini-3.8-flash
  did this one time each.
- **The step limit on long requests.** claude-haiku-5-5 (3 requests) and
  claude-fable-5-2 (1 request) used all their steps. Most of the steps went
  between two apps.
- **The same effect two times.** claude-haiku-5-5 made the same note two
  times in 2 requests, after a wait.
- **The time limit on drawn targets.** gemini-3.1-pro-preview and
  gemini-3.8-flash ran out of time on drawn stars, a drawn x, or a copy
  between two notes.

The default planner is gpt-6.2-astra. It gets 30 of 30 done, but its median
step takes 3.2 s. claude-sonnet-5-5, gpt-6.2-sol and claude-opus-5-5 also get
30 of 30 done, with a median step of 1.7 s to 2.0 s.

### Chat eval

Each case is one message of the owner in a fixed state of the Mac: nothing
runs, a task runs, a task waits for a yes, a job runs, or a task ended. The
check reads the first action of the chat agent: a tool call, a stop in code,
or words with no call. The agent runs with its real rules and tools, over
fakes of the computer and the jobs.

The run of 28 November used 55 cases. A turn in which a call of the model
failed counts as not right (see the Gemini models below).

| Model                                                                                      | Right |
| ------------------------------------------------------------------------------------------ | ----- |
| claude-opus-5-5, claude-fable-5-2, claude-haiku-5-5, gpt-6.2-sol, gpt-5.4                  | 55/55 |
| gpt-6.2-astra                                                                              | 54/55 |
| claude-sonnet-5-5                                                                          | 52/55 |
| gemini-3.1-pro-preview, gemini-3.8-flash, gemini-4-argon, gemini-4-hydrogen, gemini-4-neon | 6/55  |

The misses:

- **Gemini as the chat model.** After a tool call, the next call of a Gemini
  model fails with status 400. This happened in 48 or 49 of 55 turns for
  each Gemini model. The chat then says "I couldn't reach my language model
  just now, so nothing new started." That reply is false when the first call
  already started a task. Before 28 November the eval read only the first
  call, so it showed 54 or 55 of 55 for these models. gemini-4-carbon gave
  the same failure.
- **A goal in other words.** claude-sonnet-5-5 wrote the goal in its own
  words 3 times. Its words added a step that the owner did not say ("like",
  "order", "send"). The gate refused each one, so the turn needed one more
  model call.
- **A look before the answer.** gpt-6.2-astra read the task list before it
  answered a yes to a waiting question.
- **Words where an action was right.** Three Gemini models answered with words
  in one case each.

We added 3 cases on 28 November: two requests where other words add a risky
step, and a yes in other words ("go ahead"). The chat eval now has 58 cases.
Each OpenAI and Anthropic model got all 3 right. Each Gemini model got 0 of
3, because of the failure after a tool call. In a second run of the full
eval, gpt-6.2-sol added the word "book" to one goal, and the gate refused it
(57 of 58). claude-opus-5-5 got 58 of 58.

### Real Mac runs

These runs take the screen of a real Mac. They were last run on 26 November 2026. They are not repeated here, because they take the screen.

- **44 apps, one read-only task each.** 42 of 44 right on build `a130e0d`.
  The other 2 were correct stops: a sign-in page, and Mail with no account.
- **14 tasks of real work.** 9 of 14 right on build `a154af7`. Of the 5
  misses, 2 were pauses because the owner used the Mac, and 1 was a correct
  question before an overwrite.
- **Safety checks.** 7 passed. 1 failed because of the test method: the
  script moved the pointer with synthetic events, and ClawdTime ignores
  synthetic input by design.

We also run a subset of a public macOS benchmark on a real Mac. Its task
data has a non-commercial license, so we do not publish that score.

## Run the evals

You need Node 24 and `npm ci`. The computer evals also need the Chromium of
Playwright: run `npm run cua:install-browser` one time.

First, prove the checks. These commands call no model and need no key:

```sh
npm run eval:computer:planner -- --check
npm run eval:computer:request -- --check
npm run eval:chat -- --check
```

Then measure a model. Put the key of its provider in the environment, or
store it with `clawdtime keys set <provider>`. Each run costs real model
calls.

```sh
npm run eval:computer:planner -- gpt-6.2-astra anthropic/claude-opus-5-5 --repeat 2 --split all --out planner.json
npm run eval:computer:request -- anthropic/claude-sonnet-5-5 --out request.json
CLAWDTIME_SUPERVISOR_MODEL=gpt-6.2-sol OUT=chat.json npm run eval:chat
```

Useful flags of the two computer evals:

- `--repeat N` runs each case N times. The result gives a 95 percent
  interval.
- `--split dev`, `--split held` or `--split all` selects the cases. Design a
  change on the dev cases. Judge it on the held cases.
- `--only WORDS` runs only the cases whose name contains the words.
- `--compare a.json b.json` shows what changed between two runs. It calls no
  model.

Rules for a new case:

- Add a case for each new failure class that a real run shows.
- Never make a case easier. Never remove a wrong answer from a case.
- Run `--check` after each change to a case. The ideal answer must pass, and
  each wrong answer must fail.

## Compare with published agents

These are the published results that a comparison can use. We read each one
on its primary page on 28 November 2026. No board changed after 26 November.

**OSWorld-Verified.** Desktop tasks on Ubuntu, run by the board team, 100
steps, 1 run. The board has had no new row since 8 August 2026. Source:
<https://osworld-v1.xlang.ai/static/data/osworld_verified_results.xlsx>.

| Rank | Agent                        | Score |
| ---- | ---------------------------- | ----- |
| 1    | An agent framework           | 90.2  |
| 2    | claude-fable-5, single model | 86.0  |
| 3    | An agent framework, Opus 4.7 | 83.6  |
| 4    | claude-opus-5, single model  | 83.4  |
| 5    | An agent                     | 82.8  |

**OSWorld 2.0.** Long desktop tasks, up to 500 steps. The best full-set
score for one model is 44.33 percent (Claude Opus 5, strict pass). Source:
<https://osworld-v2.xlang.ai/static/data/leaderboard/official-results.json>,
updated 14 November 2026.

**MacAgentBench.** 676 macOS tasks in a macOS container, Pass@1, MIT
license. The board does not give the step budget. The top 4 rows are 73.7,
66.9, 63.3 and 60.7 percent; each one is a model inside an agent framework.
Source: <https://jetastra.github.io/MacAgentBench/>, data of 21 June 2026.

**macOSWorld.** 202 macOS tasks on fresh virtual machines, 15 screenshots.
The best published result is 44.4 percent in English, for a model of 2025.
No model of 2026 has a published result. The license is non-commercial
(CC BY-NC 4.0). Source: <https://arxiv.org/html/2506.04135v4>.

Vendors also publish results for their own models. Those results are
self-reported, and the vendors use different task sets and run counts. Do
not put them in the same table as board results.

## What is not comparable, and why

- **Our evals use our own tasks.** A score of 30 of 30 on the request eval
  does not mean a score on a public board.
- **A model is not an agent.** A board result for a model (for example
  claude-opus-5) measures that model in the board's harness. It does not
  measure ClawdTime with that model as its planner.
- **The operating system.** OSWorld runs Ubuntu. ClawdTime runs on macOS,
  with native hands. It cannot run on OSWorld now.
- **The step budget.** One model can get very different scores with 15, 50
  or 100 steps. Compare only results with the same budget.
- **The start state.** The public boards restore a fresh machine before each
  task. Our real Mac runs use a Mac that a person also uses.
- **Single runs and best of N.** Some results take the best of several
  runs. Ours are single runs.
- **Our macOS subset.** It uses 39 of the 202 macOSWorld tasks, our own
  files and our own checks. Its score is an indication only. It is not a
  macOSWorld score.

## How to get a comparable number

1. **Run MacAgentBench.** Its tasks are on macOS and its license is MIT. Its
   top rows are 60.7 to 73.7 percent. It runs macOS in a container on a
   Linux host. First, prove that ClawdTime and its hands install and run
   inside that container.
2. **Run macOSWorld in its own harness.** It needs fresh macOS virtual
   machines. Its license is non-commercial: decide if we can publish a score
   before the run.
3. **Do not plan on OSWorld now.** It needs hands for Linux.
4. **Make our own evals harder.** The best models get every case right. Add
   cases from each new failure on a real Mac, and add long requests until
   the best models stop at a clear ceiling.
5. **Make each step faster.** The default planner takes 3.2 s for the median
   step. Three other planners take 1.7 s to 2.0 s, with the same 30 of 30
   requests done.
6. **Fix the faults that the evals found.** A Gemini model cannot be the chat
   model now: its call after a tool call fails. Gemini models also give
   points that do not match the pixels of the picture.
