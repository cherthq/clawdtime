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
 * --check needs no model and no key. For each case it plays scripted paths
 * through the same agent: the ideal one, whose first call is the expected
 * one, must pass (so the tool exists in that state and the gate lets it
 * through); a wrong one (a question back, or a call where words were right,
 * or no task to stop) must fail; and a broken one (the ideal first answer,
 * then a model that fails) must fail too. So it proves that each case can
 * pass and that its check tells right from wrong.
 *
 * A turn in which a call of the model failed is never right, even when its
 * first call was the expected one: the owner got no answer of the model.
 *
 * With no flag it asks the chat's own model (CLAWDTIME_SUPERVISOR_MODEL, the
 * key in CLAWDTIME_OPENAI_API_KEY or the key of that provider, from the
 * environment or the key store). It costs one or two model calls a case. It
 * also counts the answers that ask before acting.
 *
 * Some cases also judge the words of the answer (`reply`): how ClawdTime
 * talks. A start is one short line, a result keeps its exact numbers and
 * ends with no offer, a question is one question, a failure says the next
 * step, and no apology comes twice. In --check their ideal path answers with
 * good words (`ideal`), and their wrong path takes the same first action and
 * answers with bad ones (`wrongReply`): the check of the words alone must
 * catch it. With a model, the model's own answer is judged.
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
import { ProcessDesk } from "../connectors/system/act.js";
import { SystemProbes } from "../connectors/system/probes.js";
import {
  call,
  chatWorld,
  FakeComputer,
  FakeJobs,
  scriptedModel,
  tempRoot,
} from "./chat-agent-fixture.js";
import { fakeHost } from "./connectors-system-fixture.js";
import { holdOpen } from "./computer-eval-report.js";

type Setup =
  "idle" | "running" | "approval" | "question" | "job" | "done" | "failed";
type Expect = string[] | "stop" | "words";
/** A check of the words of the answer: null when they are right, else why not. */
type ReplyCheck = (text: string) => string | null;
interface Case {
  name: string;
  say: string;
  setup: Setup;
  expect: Expect;
  memory?: boolean;
  history?: { role: "user" | "assistant"; text: string }[];
  /** The arguments of the ideal call, when the message is not the right one. */
  args?: Record<string, unknown>;
  /** How the owner talks: the chat (default) or by voice. */
  via?: "chat" | "voice";
  /** The words of the answer must pass this check too. */
  reply?: ReplyCheck;
  /** --check: the words of the ideal path. */
  ideal?: string;
  /** --check: the wrong path takes the ideal first action and answers with these words. */
  wrongReply?: string;
  /**
   * --check: more wrong paths, each a script of the model: a known way to
   * get the case wrong. Each one must be caught too.
   */
  wrongPaths?: Step[][];
}
/** One answer of a scripted model. */
type Step = { text?: string; calls?: LoopCall[] };

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** Checks of the words. Each returns null when the words pass it. */
const talk = {
  /** One or two sentences of 20 words or fewer. */
  short: (text: string) =>
    sentencesOf(text).length > 2
      ? "more than two sentences"
      : sentencesOf(text).some((part) => wordsOf(part) > 20)
        ? "a sentence of more than 20 words"
        : null,
  oneSentence: (text: string) =>
    sentencesOf(text).length > 1 ? "more than one sentence" : null,
  noFiller: (text: string) =>
    /^(?:sure|great question|absolutely|of course|certainly|happy to help|no problem|i'?d be happy)\b/i.test(
      text.trim(),
    )
      ? "opens with filler"
      : null,
  noOffer: (text: string) =>
    /(?:want me to|should i|shall i|would you like|do you want|let me know|anything else|need anything)[^.!?]*[.!?]?\s*$/i.test(
      text.trim(),
    )
      ? "ends with an offer"
      : null,
  /** A start line needs no sentence about what has not happened yet. */
  noHedge: (text: string) =>
    sentencesOf(text).some((part) =>
      /\b(?:yet|so far)\b|\b(?:has|have|is|are)n['’]?t\b.*\b(?:been|happened|started|placed|sent|done|open)\b/i.test(
        part,
      ),
    )
      ? "a sentence about what has not happened yet"
      : null,
  noApology: (text: string) =>
    /\b(?:sorry|apolog\w*)\b/i.test(text) ? "apologizes again" : null,
  oneQuestion: (text: string) =>
    (text.match(/\?/g) ?? []).length > 1 ? "more than one question" : null,
  /** No answer of its own: no number, as a digit or a word. */
  noNumber: (text: string) =>
    /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.test(
      text,
    )
      ? "gives an answer of its own"
      : null,
  /**
   * The owner already talks to ClawdTime: it never sends them to the panel
   * or to another ClawdTime screen to ask there.
   */
  noOtherSurface: (text: string) =>
    /\b(?:open|use|check|go\s+to|switch\s+to|ask\s+(?:in|from|on))\s+(?:the\s+|your\s+)?(?:clawdtime\s+(?:panel|app|window|menu(?:\s+bar)?)|panel|menu\s+bar|task\s+list)\b|\bclawdtime\s+(?:panel|app|window|menu)\b/i.test(
      text,
    )
      ? "sends the owner to another ClawdTime screen"
      : null,
  /** The number as the tool gave it, and no word that rounds it. */
  exact: (value: string) => (text: string) =>
    !text.includes(value)
      ? `does not give ${value} exactly`
      : /\b(?:about|around|roughly|approximately|nearly|almost)\b|~/i.test(text)
        ? "rounds the number"
        : null,
  /** It says that the task did not work. */
  saysNo: (text: string) =>
    /\b(?:no|not|couldn['’]?t|could not|didn['’]?t|did not|failed|unable)\b/i.test(
      text,
    )
      ? null
      : "does not say that it did not work",
  /** A sentence that tells the owner what to do next. */
  nextStep: (text: string) =>
    /(?:^|[.!?,;:]\s+)(?:or\s+)?(?:you can|install|tell me|say|try|open|ask|use|type|check|add|choose|pick)\b/i.test(
      text,
    )
      ? null
      : "gives no next step",
};
/** Every check: null when all pass, else every reason. */
const all =
  (...checks: ReplyCheck[]): ReplyCheck =>
  (text) =>
    checks
      .map((check) => check(text))
      .filter(Boolean)
      .join("; ") || null;

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
  // A goal in other words can add a step that the owner did not say ("like",
  // "send", "order"), and the gate then refuses the task: a lost turn. The
  // goal keeps the owner's own words.
  {
    name: "search: similar places, in the owner's words",
    say: "find hotels in Lisbon similar to the one we had in Porto",
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
    name: "app: let someone know, in the owner's words",
    say: "let Ada know on Riverchat that the review moved to 3 pm",
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
  // A yes in other words answers the question that waits: no look at the
  // tasks first.
  {
    name: "approval: yes in other words",
    say: "go ahead",
    setup: "approval",
    expect: ["answer_question"],
  },
  {
    name: "question: choice",
    say: "the black one",
    setup: "question",
    expect: ["answer_question"],
  },
  // A terminal the owner wants to see on the screen is computer work.
  {
    name: "screen: open the terminal and run a command",
    say: "open Terminal, run echo hello there, and tell me what it printed",
    setup: "idle",
    expect: ["computer_do"],
  },
  {
    name: "screen: show me the terminal",
    say: "open a terminal window and show me the files in my Downloads folder",
    setup: "idle",
    expect: ["computer_do"],
  },
  // A question about the screen as it is now: only the computer task can see
  // it. The task list and the process level cannot, and the owner already
  // talks to ClawdTime, so it never sends them to the panel to ask there.
  // A wrong path reads the task list, or says it cannot see, or starts the
  // look and still sends the owner to the panel.
  {
    name: "screen: which app is in front, after a task ended",
    say: "Which app is in front right now? Answer with its name only.",
    setup: "done",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noOtherSurface),
    ideal: "Checking which app is in front.",
    wrongPaths: [
      [
        { calls: [call("tasks")] },
        {
          text: "I can't read the front app from the task list. Open the ClawdTime panel and ask there.",
        },
      ],
      [
        { calls: [call("computer_do", { goal: "Which app is in front?" })] },
        { text: "Open the ClawdTime panel to see the front app." },
      ],
    ],
  },
  {
    name: "screen: which app is in front",
    say: "which app is in front?",
    setup: "idle",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noOtherSurface),
    ideal: "Checking which app is in front.",
    wrongPaths: [
      [{ text: "I can't see your screen. Open the ClawdTime panel and ask." }],
      [
        { calls: [call("system_look", { what: "processes" })] },
        { text: "Mail runs." },
      ],
    ],
  },
  {
    name: "screen: what a window says",
    say: "what does this window say?",
    setup: "idle",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noOtherSurface),
    ideal: "Reading the window in front.",
    wrongPaths: [
      [{ calls: [call("tasks")] }, { text: "No task shows a window." }],
    ],
  },
  {
    name: "screen: whether an app is open",
    say: "is Mail open?",
    setup: "idle",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noOtherSurface),
    ideal: "Checking whether Mail is open.",
    wrongPaths: [
      [
        { calls: [call("system_look", { what: "processes" })] },
        { text: "Mail runs." },
      ],
      [{ text: "Check the ClawdTime panel to see your apps." }],
    ],
  },
  {
    name: "screen: the title of a tab",
    say: "what is the title of this tab?",
    setup: "idle",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noOtherSurface),
    ideal: "Reading the title of the tab in front.",
    wrongPaths: [
      [{ calls: [call("computer_status")] }, { text: "No task runs now." }],
    ],
  },
  {
    name: "screen: what a document says, while a job runs",
    say: "what does the open Stonepad document say at the top?",
    setup: "job",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noOtherSurface),
    ideal: "Reading the top of the Stonepad document.",
    wrongPaths: [
      [{ calls: [call("job_status")] }, { text: "The job fixes a test." }],
    ],
  },
  {
    name: "screen: which window is in front, by voice",
    say: "which window is in front?",
    setup: "idle",
    via: "voice",
    expect: ["computer_do"],
    reply: all(talk.oneSentence, talk.noOtherSurface),
    ideal: "Checking the window in front.",
    wrongPaths: [[{ text: "Open the ClawdTime app and ask there." }]],
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
  // Debugging the Mac: the process level first, never the screen.
  {
    name: "debug: a slow Mac",
    say: "why is my Mac so slow right now?",
    setup: "idle",
    expect: ["system_look"],
    args: { what: "processes" },
  },
  {
    name: "debug: a port",
    say: "what's running on port 4173?",
    setup: "idle",
    expect: ["system_look"],
    args: { what: "ports", port: 4173 },
  },
  {
    name: "debug: a crash",
    say: "why did Riverchat crash this morning?",
    setup: "idle",
    expect: ["system_look"],
    args: { what: "crashes", name: "Riverchat" },
  },
  {
    name: "debug: memory",
    say: "what is eating all my memory?",
    setup: "idle",
    expect: ["system_look"],
    args: { what: "memory" },
  },
  {
    name: "debug: a frozen app",
    say: "Stonepad is frozen, restart it",
    setup: "idle",
    expect: ["process_act", "system_look"],
    args: { action: "restart", name: "Stonepad" },
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
  // How it talks: the words of the answer are judged too.
  {
    name: "talk: a start is one short line of what it does now",
    say: "find a quiet cafe with wifi near Union Square",
    setup: "idle",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noFiller, talk.noHedge, talk.noOffer),
    ideal: "Searching for quiet cafes with wifi near Union Square.",
    wrongReply:
      "Sure! Searching for quiet cafes near Union Square, but I don't have any results yet.",
  },
  {
    name: "talk: a start gives no answer of its own",
    say: "google how many moons Neptune has",
    setup: "idle",
    expect: ["computer_do"],
    reply: all(talk.short, talk.noNumber),
    ideal: "Searching for how many moons Neptune has.",
    wrongReply: "Neptune has 16 known moons. The search is still running.",
  },
  {
    name: "talk: a result keeps the exact number",
    say: "how much were they?",
    setup: "done",
    expect: ["tasks", "computer_status"],
    reply: all(talk.short, talk.exact("1,199"), talk.noOffer),
    ideal: "The Aero 7 headphones start at 1,199 dollars.",
    wrongReply: "They cost around 1,200 dollars.",
  },
  {
    name: "talk: a result ends with no offer",
    say: "what did you find?",
    setup: "done",
    expect: ["tasks", "computer_status"],
    reply: all(talk.short, talk.noOffer),
    ideal: "The Aero 7 headphones start at 1,199 dollars.",
    wrongReply:
      "The Aero 7 headphones start at 1,199 dollars. Want me to add a pair to your cart?",
  },
  {
    name: "talk: a failure says what went wrong and the next step",
    say: "did it work?",
    setup: "failed",
    expect: ["tasks", "computer_status"],
    reply: all(talk.short, talk.saysNo, talk.nextStep),
    ideal:
      "No, Stonepad is not on this Mac, so the Q3 report did not open. Install Stonepad, or tell me another app to use.",
    wrongReply: "Unfortunately, it didn't work.",
  },
  {
    name: "talk: one clear question when the words say nothing",
    say: "I need a hand with something",
    setup: "idle",
    expect: "words",
    reply: all(talk.short, talk.noFiller, talk.oneQuestion),
    ideal: "What do you need?",
    wrongReply: "Sure, what is it? Is it on the Mac, or is it code?",
  },
  {
    name: "talk: no apology loop after a correction",
    say: "still the wrong site, I said brightwave.co",
    setup: "done",
    history: [
      { role: "user", text: "open brightwave.co" },
      {
        role: "assistant",
        text: "Sorry, I opened bright5.co by mistake. The page shows: This site can't be reached.",
      },
    ],
    expect: ["computer_do"],
    args: { goal: "Open brightwave.co" },
    reply: all(talk.short, talk.noApology),
    ideal: "Opening brightwave.co.",
    wrongReply: "I'm so sorry again! Opening brightwave.co now.",
  },
  {
    name: "talk: by voice, one sentence with the exact price",
    say: "what was the price?",
    setup: "done",
    via: "voice",
    expect: ["tasks", "computer_status"],
    reply: all(talk.oneSentence, talk.exact("1,199")),
    ideal: "They start at 1,199 dollars.",
    wrongReply: "They start at 1,199 dollars. Other models cost more.",
  },
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
  /** A call of the model failed in the turn, so the turn ended with no reply of its own. */
  modelFailed: boolean;
  /** Why the words of the answer fail the case's check. Null when they pass or the case has none. */
  words?: string | null;
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
  if (setup === "failed")
    computer
      .run("open the Q3 report in Stonepad")
      .finish(
        "I could not finish. Stonepad is not on this Mac. Tell me another way to try, or do this step yourself.",
        "blocked",
      );
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
  let modelFailed = false;
  const watched: LoopModel = {
    async next(request, signal) {
      trail.push("model");
      try {
        const answer = await model.next(request, signal);
        firstCalls ??= answer.calls;
        return answer;
      } catch (error) {
        modelFailed = true;
        throw error;
      }
    },
  };
  const records: { name: string; refused?: string }[] = [];
  const agent = new ChatAgent({
    world,
    model: watched,
    root,
    routines,
    // A made-up Mac at the process level: no program runs, no signal goes out.
    system: new ProcessDesk(new SystemProbes(fakeHost()), { trust: false }),
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
  const answer = await agent.answer(history, item.say, item.via ?? "chat");
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
    modelFailed,
    words: item.reply ? item.reply(answer.text) : null,
  };
}

/** The model, until it has answered `count` calls: each later call fails, as a service that answers 400. */
const failsAfter = (model: LoopModel, count: number): LoopModel => {
  let calls = 0;
  return {
    async next(request, signal) {
      calls += 1;
      if (calls > count) throw new Error("The language model answered 400.");
      return model.next(request, signal);
    },
  };
};

// A turn whose model failed is never right: its first call may be right,
// but the owner gets no answer of the model.
const passes = (item: Case, outcome: Outcome) =>
  !outcome.modelFailed &&
  (item.expect === "stop"
    ? outcome.first === "stop"
    : item.expect === "words"
      ? outcome.first === "words"
      : item.expect.includes(outcome.first) && outcome.refused === null) &&
  !outcome.words;

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

// A retry wait of the chat's model must not end the run. Each way out of
// this script is a process.exit, which ends the hold too.
holdOpen();

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
          ? [{ text: item.ideal ?? "Okay." }]
          : [
              { calls: [call(name, idealArgs(item, name))] },
              { text: item.ideal ?? "On it." },
            ],
      ),
    );
    // The wrong path: a question back where an action was right, an action
    // where words were right, and no task to stop where a stop was right.
    // A case of the words keeps the right first action and says bad words.
    // A case may name more wrong paths; each one must be caught too.
    const wrong = item.wrongReply
      ? await play(
          item,
          scriptedModel(
            item.expect === "words" || item.expect === "stop"
              ? [{ text: item.wrongReply }]
              : [
                  { calls: [call(name, idealArgs(item, name))] },
                  { text: item.wrongReply },
                ],
          ),
        )
      : item.expect === "stop"
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
    // The broken path: the ideal first answer, then a model that fails, so
    // the turn ends with no reply of its own. A stop runs in code before
    // any model, so it has no broken path.
    const broken =
      item.expect === "stop"
        ? null
        : await play(
            item,
            failsAfter(
              scriptedModel(
                item.expect === "words"
                  ? [{ text: "Okay." }]
                  : [{ calls: [call(name, idealArgs(item, name))] }],
              ),
              item.expect === "words" ? 0 : 1,
            ),
          );
    // A case may name more wrong paths: each one must be caught too.
    const wrongs = [wrong];
    for (const path of item.wrongPaths ?? [])
      wrongs.push(await play(item, scriptedModel(path)));
    const good = passes(item, ideal);
    const told =
      wrongs.every((outcome) => !passes(item, outcome)) &&
      (!broken || !passes(item, broken));
    if (good) ok++;
    if (told) caught++;
    console.log(
      `${good && told ? "ok  " : "FAIL"} ${item.name}: expected ${expected}; ideal ${ideal.first}${ideal.refused ? ` (refused: ${ideal.refused})` : ""}${ideal.words ? ` (words: ${ideal.words})` : ""}; wrong ${wrongs.map((outcome) => `${outcome.first}${outcome.words ? ` (words: ${outcome.words})` : ""}${passes(item, outcome) ? " (passed)" : ""}`).join(", ")}${broken ? `; broken ${broken.first}${passes(item, broken) ? " (passed)" : ""}` : ""}`,
    );
    results.push({
      name: item.name,
      expected,
      ideal,
      wrong: wrongs,
      broken,
      good,
      told,
    });
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
        modelFailed: false,
      };
    }
    const good = passes(item, outcome);
    if (good) ok++;
    if (outcome.askedFirst && Array.isArray(item.expect)) asked++;
    console.log(
      `${good ? "ok  " : "FAIL"} ${item.name}: expected ${expected}; got ${outcome.first}${outcome.refused ? ` (refused: ${outcome.refused})` : ""}${outcome.modelFailed ? " (a later call of the model failed)" : ""}${outcome.words ? ` (words: ${outcome.words})` : ""}. Reply: ${outcome.reply.slice(0, 120)}`,
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
