/**
 * The chat eval: owner messages and the first action that each should get.
 *
 * Each case is one message of the owner in a fixed state of the Mac (nothing
 * runs, a computer task runs, it waits for a yes, it asks a question, a job
 * runs, a task ended), and the first action that the chat agent should take:
 * a tool call, a stop in code before any model, or words with no call (for a
 * vague message). The agent runs whole, with its real rules, tools and gate,
 * over fakes of the computer engine and the jobs: nothing reaches the screen.
 *
 *   npm run eval:chat -- --check
 *   npm run eval:chat
 *
 * --check needs no model and no key. For each case it plays two scripted
 * paths through the same agent: the ideal one, whose first call is the
 * expected one, must pass (so the tool exists in that state and the gate lets
 * it through); a wrong one (a question back, or a call where words were
 * right, or no task to stop) must fail. So it proves that each case can pass
 * and that its check tells right from wrong.
 *
 * With no flag it asks the chat's own model (CLAWDTIME_SUPERVISOR_MODEL, the
 * key in CLAWDTIME_OPENAI_API_KEY or the key of that provider, from the
 * environment or the key store). It costs one or two model calls a case. It
 * also counts the answers that ask before acting.
 *
 * ONLY names a part of a case's name; OUT names a file for every result.
 * It prints one line a case and a total, and exits with status 1 when one fails.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { LoopCall, LoopModel } from "../connectors/agents/agent-loop.js";
import type { ChatMessage } from "../connectors/agents/brain.js";
import { ChatAgent } from "../connectors/agents/chat-agent.js";
import { chatModelSetup } from "../connectors/agents/chat-model.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import { Routines } from "../connectors/computer/routines.js";
import {
  call,
  chatWorld,
  FakeComputer,
  FakeJobs,
  scriptedModel,
  tempRoot,
} from "./chat-agent-fixture.js";

type Setup = "idle" | "running" | "approval" | "question" | "job" | "done";
type Expect = string[] | "stop" | "words";
interface Case {
  name: string;
  say: string;
  setup: Setup;
  expect: Expect;
  memory?: boolean;
  history?: { role: "user" | "assistant"; text: string }[];
  /** The arguments of the ideal call, when the message is not the right one. */
  args?: Record<string, unknown>;
}

const cases: Case[] = [
  // Searches.
  {
    name: "search: question form",
    say: "Can you search Aero 7 headphones?",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "search: ramen",
    say: "search for the best ramen near me",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "search: weather",
    say: "look up the weather in Lisbon tomorrow",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "search: google a fact",
    say: "google how tall the Eiffel Tower is",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "search: flights",
    say: "find flights from SFO to JFK next Friday",
    setup: "idle",
    expect: ["computer_do"],
  },
  // Shopping.
  {
    name: "shop: reorder",
    say: "order more coffee beans on Amazon",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "shop: cart",
    say: "add AirPods Pro to my cart on apple.com",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "shop: compare",
    say: "compare prices for a Dyson V15 on Amazon and Best Buy",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "shop: package",
    say: "could you check if my Target package shipped?",
    setup: "idle",
    expect: ["computer_do"],
  },
  // X and Instagram.
  {
    name: "x: like",
    say: "like the latest post from NASA on X",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "x: follow up",
    say: "follow up on my latest X posts",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "x: post",
    say: "post on X: shipping the new build today",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "instagram: reply",
    say: "reply to the top comment on my last Instagram post with thanks!",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "instagram: dms",
    say: "check my Instagram DMs",
    setup: "idle",
    expect: ["computer_do"],
  },
  // Other apps.
  {
    name: "app: music",
    say: "open Spotify and play my Discover Weekly",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "app: slack",
    say: "tell Sam on Slack I'm running 5 minutes late",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "app: calendar",
    say: "what's on my calendar tomorrow?",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "app: mail",
    say: "read me my newest email",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "follow-up: same again",
    say: "do the same for the Pixel 10",
    setup: "done",
    expect: ["computer_do"],
    history: [
      { role: "user", text: "search Aero 7 headphones prices" },
      {
        role: "assistant",
        text: "Done. The Aero 7 headphones starts at 1,199 dollars.",
      },
    ],
    args: { goal: "search Pixel 10 prices" },
  },
  // A running task: follow-ups and corrections.
  {
    name: "running: how is it going",
    say: "how's it going?",
    setup: "running",
    expect: ["computer_status", "tasks"],
  },
  {
    name: "running: done yet",
    say: "is the search done yet?",
    setup: "running",
    expect: ["computer_status", "tasks"],
  },
  {
    name: "running: add to it",
    say: "also check the reviews",
    setup: "running",
    expect: ["computer_steer"],
  },
  {
    name: "correction: model",
    say: "no, I meant the Pro Max, not the Pro",
    setup: "running",
    expect: ["computer_steer"],
  },
  {
    name: "correction: browser",
    say: "actually use Safari instead",
    setup: "running",
    expect: ["computer_steer"],
  },
  {
    name: "correction: size",
    say: "make it the 256GB one",
    setup: "running",
    expect: ["computer_steer"],
  },
  // Stops.
  { name: "stop: bare", say: "stop", setup: "running", expect: "stop" },
  {
    name: "stop: don't click",
    say: "stop it, don't click that",
    setup: "running",
    expect: "stop",
  },
  {
    name: "stop: named",
    say: "cancel the computer task",
    setup: "running",
    expect: "stop",
  },
  // Status.
  {
    name: "status: working on",
    say: "what are you working on?",
    setup: "running",
    expect: ["tasks", "computer_status"],
  },
  {
    name: "status: last thing",
    say: "what happened with the last thing I asked?",
    setup: "done",
    expect: ["tasks", "computer_status"],
  },
  {
    name: "status: jobs",
    say: "any jobs running?",
    setup: "job",
    expect: ["job_status", "tasks"],
  },
  // Questions that wait for the owner.
  {
    name: "approval: yes",
    say: "yes, send it",
    setup: "approval",
    expect: ["answer_question"],
  },
  {
    name: "approval: no",
    say: "no, don't send it",
    setup: "approval",
    expect: ["answer_question"],
  },
  {
    name: "question: choice",
    say: "the black one",
    setup: "question",
    expect: ["answer_question"],
  },
  // Code.
  {
    name: "code: fix a test",
    say: "fix the failing login test in the api repo",
    setup: "idle",
    expect: ["start_job"],
  },
  {
    name: "code: pull request",
    say: "open a PR that bumps the node version to 24",
    setup: "idle",
    expect: ["start_job"],
  },
  {
    name: "code: script",
    say: "write a script that renames my screenshots by date",
    setup: "idle",
    expect: ["start_job"],
  },
  {
    name: "code: job result",
    say: "did the job finish?",
    setup: "job",
    expect: ["job_status", "tasks"],
  },
  // Memory.
  {
    name: "memory: preference",
    say: "remember that I prefer Safari over Chrome",
    setup: "idle",
    memory: true,
    expect: ["remember"],
    args: { fact: "The owner prefers Safari over Chrome." },
  },
  {
    name: "memory: fact",
    say: "my dentist is Dr. Lee, keep that in mind",
    setup: "idle",
    memory: true,
    expect: ["remember"],
    args: { fact: "The owner's dentist is Dr. Lee." },
  },
  {
    name: "memory: recall",
    say: "what do you remember about my coffee order?",
    setup: "idle",
    memory: true,
    expect: ["memory_search"],
    args: { query: "coffee order" },
  },
  // Routines.
  {
    name: "routine: add",
    say: "every morning at 9, check my X mentions",
    setup: "idle",
    expect: ["routine_add"],
  },
  {
    name: "routine: list",
    say: "what routines do I have?",
    setup: "idle",
    expect: ["routine_list"],
  },
  // Vague: words first, no action.
  {
    name: "vague: help",
    say: "can you help me with something?",
    setup: "idle",
    expect: "words",
  },
  // A site name that speech heard wrong, then the owner's short correction.
  {
    name: "correction: a short name after a site that did not load",
    say: "brightwave bro",
    setup: "done",
    history: [
      { role: "user", text: "Can you open bright5.co?" },
      {
        role: "assistant",
        text: "Opened bright5.co in Chrome. The page shows: This site can't be reached.",
      },
    ],
    expect: ["computer_do"],
    args: { goal: "Open brightwave (the owner corrected bright5.co)" },
  },
  {
    name: "correction: no to an offer, then the right name",
    say: "no, brightwave.co",
    setup: "done",
    history: [
      { role: "user", text: "open bright5.co" },
      {
        role: "assistant",
        text: "The site bright5.co can't be reached.",
      },
    ],
    expect: ["computer_do"],
    args: { goal: "Open brightwave.co" },
  },
  { name: "vague: hmm", say: "hmm", setup: "idle", expect: "words" },
  { name: "vague: thanks", say: "thanks!", setup: "idle", expect: "words" },
];

const asksFirst =
  /\b(?:should i|shall i|do you want me to|would you like me to|want me to (?:go ahead|start|do)|can i go ahead|ready for me to)\b/i;

/** The arguments of the ideal call: the owner's message where it is the right one. */
function idealArgs(item: Case, name: string): Record<string, unknown> {
  if (item.args) return item.args;
  switch (name) {
    case "computer_do":
      return { goal: item.say };
    case "computer_steer":
      return { words: item.say };
    case "answer_question":
      return { answer: item.say };
    case "start_job":
      return { work: item.say };
    case "remember":
      return { fact: item.say };
    case "memory_search":
      return { query: item.say };
    case "routine_add":
      return { schedule: item.say };
    default:
      return {};
  }
}

/** One run of one case: the first action, and whether the gate let it through. */
interface Outcome {
  first: string;
  refused: string | null;
  reply: string;
  askedFirst: boolean;
}

async function play(
  item: Case,
  model: LoopModel,
  setup: Setup = item.setup,
): Promise<Outcome> {
  const root = tempRoot();
  const trail: string[] = [];
  const computer = new FakeComputer(trail);
  const now = Date.now();
  const jobs = new FakeJobs(() => now);
  if (setup === "running")
    computer.run("search Aero 7 Pro prices on apple.com");
  if (setup === "approval")
    computer
      .run("send Sam the draft on Slack")
      .ask("approval", "Send this message to Sam on Slack?");
  if (setup === "question")
    computer
      .run("buy a phone case")
      .ask("question", "Which color, blue or black?");
  if (setup === "done")
    computer
      .run("search Aero 7 headphones prices")
      .finish("Done. The Aero 7 headphones starts at 1,199 dollars.");
  if (setup === "job") await jobs.start("fix the flaky checkout test");
  const world = chatWorld(root, {
    computer,
    jobs,
    ...(item.memory ? { memory: true } : {}),
  });
  if (item.memory)
    world.desk.memory.remember({
      text: "The owner's usual coffee order is an oat milk flat white.",
      kind: "preference",
    });
  const routines = new Routines({ root });
  let firstCalls: LoopCall[] | null = null;
  const watched: LoopModel = {
    async next(request, signal) {
      trail.push("model");
      const answer = await model.next(request, signal);
      firstCalls ??= answer.calls;
      return answer;
    },
  };
  const records: { name: string; refused?: string }[] = [];
  const agent = new ChatAgent({
    world,
    model: watched,
    root,
    routines,
    listener: (activity) => {
      if (activity.kind === "refused" && activity.name)
        records.push({ name: activity.name, refused: activity.text ?? "" });
      if (activity.kind === "tool_start" && activity.name)
        records.push({ name: activity.name });
    },
  });
  // A task that ran before the message is in the graph, as in the service.
  agent.refresh();
  const history: ChatMessage[] = (item.history ?? []).map((message, index) => ({
    ...message,
    at: now - 60_000 + index,
    via: "chat",
  }));
  const answer = await agent.answer(history, item.say, "chat");
  const calls: LoopCall[] = firstCalls ?? [];
  const first = trail[0] === "stop" ? "stop" : (calls[0]?.name ?? "words");
  const refusal =
    first !== "stop" && first !== "words"
      ? (records.find((record) => record.name === first)?.refused ?? null)
      : null;
  return {
    first,
    refused: refusal,
    reply: answer.text,
    askedFirst: asksFirst.test(answer.text),
  };
}

const passes = (item: Case, outcome: Outcome) =>
  item.expect === "stop"
    ? outcome.first === "stop"
    : item.expect === "words"
      ? outcome.first === "words"
      : item.expect.includes(outcome.first) && outcome.refused === null;

const args = process.argv.slice(2);
for (const flag of args)
  if (flag !== "--check")
    throw new Error(
      `Unknown flag ${flag}. Use --check, or no flag for the chat's model.`,
    );
const checking = args.includes("--check");
const only = process.env.ONLY?.toLowerCase();
const chosen = cases.filter(
  (item) => !only || item.name.toLowerCase().includes(only),
);

let real: LoopModel | null = null;
if (!checking) {
  const setup = chatModelSetup(
    process.env,
    stateRoot({ env: process.env, home: homedir() }),
  );
  if (!setup.ok) {
    console.error(setup.problem);
    process.exit(2);
  }
  real = setup.model;
  console.log(`Model: ${setup.name}`);
}

const results: Record<string, unknown>[] = [];
let ok = 0;
let caught = 0;
let asked = 0;
for (const item of chosen) {
  const expected =
    item.expect === "stop" || item.expect === "words"
      ? item.expect
      : item.expect.join("|");
  if (checking) {
    const name = Array.isArray(item.expect) ? item.expect[0]! : "computer_do";
    const ideal = await play(
      item,
      scriptedModel(
        item.expect === "words" || item.expect === "stop"
          ? [{ text: "Okay." }]
          : [
              { calls: [call(name, idealArgs(item, name))] },
              { text: "On it." },
            ],
      ),
    );
    // The wrong path: a question back where an action was right, an action
    // where words were right, and no task to stop where a stop was right.
    const wrong =
      item.expect === "stop"
        ? await play(item, scriptedModel([{ text: "Okay." }]), "idle")
        : item.expect === "words"
          ? await play(
              item,
              scriptedModel([
                { calls: [call("computer_do", { goal: item.say })] },
                { text: "Started." },
              ]),
            )
          : await play(
              item,
              scriptedModel([{ text: "Should I do that for you?" }]),
            );
    const good = passes(item, ideal);
    const told = !passes(item, wrong);
    if (good) ok++;
    if (told) caught++;
    console.log(
      `${good && told ? "ok  " : "FAIL"} ${item.name}: expected ${expected}; ideal ${ideal.first}${ideal.refused ? ` (refused: ${ideal.refused})` : ""}; wrong ${wrong.first}`,
    );
    results.push({ name: item.name, expected, ideal, wrong, good, told });
  } else {
    let outcome: Outcome;
    try {
      outcome = await play(item, real!);
    } catch (error) {
      outcome = {
        first: "error",
        refused: error instanceof Error ? error.message : "failed",
        reply: "",
        askedFirst: false,
      };
    }
    const good = passes(item, outcome);
    if (good) ok++;
    if (outcome.askedFirst && Array.isArray(item.expect)) asked++;
    console.log(
      `${good ? "ok  " : "FAIL"} ${item.name}: expected ${expected}; got ${outcome.first}${outcome.refused ? ` (refused: ${outcome.refused})` : ""}. Reply: ${outcome.reply.slice(0, 120)}`,
    );
    results.push({ name: item.name, expected, ...outcome, good });
  }
}
if (process.env.OUT)
  writeFileSync(process.env.OUT, `${JSON.stringify(results, null, 2)}\n`);
const total = chosen.length;
if (checking) {
  console.log(
    `${total} cases: ideal paths ${ok}/${total} pass, wrong paths ${caught}/${total} caught.`,
  );
  process.exit(ok === total && caught === total ? 0 : 1);
}
console.log(
  `${total} cases: ${ok}/${total} first actions right; ${asked} answers asked before acting.`,
);
process.exit(ok === total ? 0 : 1);
