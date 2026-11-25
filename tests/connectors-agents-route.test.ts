import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Supervisor,
  type ChatMessage,
  type ModelClient,
  type SupervisorWorld,
  type ToolCall,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import type { JobPort } from "../connectors/agents/jobs.js";
import {
  computerOffReply,
  offersInsteadOfStarting,
  roadOf,
  type Road,
} from "../connectors/agents/route.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-route-"));
  roots.push(path);
  return path;
};

/**
 * The road that each message takes. "engine" is work on the screen, "reads"
 * is work on the screen that only looks, "job" is code work, a pair is both
 * roads in that order (the code part, then the screen part), and "answer" is
 * a message that the code leaves to the language model.
 */
type Expected = "engine" | "reads" | "job" | "answer" | [string, string];
const table: [string, Expected][] = [
  // The owner's own examples: the words do not name the screen.
  ["follow up on my latest X posts", "engine"],
  ["reply to Sam on Slack", "engine"],
  ["book the 3pm slot", "engine"],
  // X.
  ["post a thread on X about our launch", "engine"],
  ["like Sam's latest post", "engine"],
  ["retweet the post from Priya", "engine"],
  ["check my X notifications", "reads"],
  // Gmail and mail.
  ["check my gmail", "reads"],
  ["pls check my inbox", "reads"],
  ["go through my unread emails", "reads"],
  ["write an email to the team about the outage", "engine"],
  ["delete the spam emails", "engine"],
  ["unsubscribe from these newsletters", "engine"],
  ["any new emails?", "reads"],
  // Slack and chat.
  ["yo can u reply to mike on slack real quick", "engine"],
  ["catch me up on Slack", "reads"],
  ["read through my Slack messages", "reads"],
  ["did Sam reply on Slack?", "reads"],
  ["dm Priya on Instagram", "engine"],
  ["send the report to Sam on WhatsApp", "engine"],
  ["text Sam that I'm running late", "engine"],
  ["hey can you see what Priya said in the design channel", "reads"],
  ["who emailed me today?", "reads"],
  // Calendar.
  ["what's on my calendar today?", "reads"],
  ["schedule a meeting with Sam tomorrow at 3", "engine"],
  ["accept the invite from Jane", "engine"],
  ["reschedule my 2pm with Jane to Friday", "engine"],
  ["cancel my 3pm meeting", "engine"],
  ["join the standup on Zoom", "engine"],
  ["add Sam to the meeting", "engine"],
  // The browser and the web.
  ["refresh the browser", "engine"],
  ["summarize this page", "reads"],
  ["search Google for flights to Tokyo", "engine"],
  ["google the weather in Paris", "engine"],
  ["fill out the form on this page", "engine"],
  ["order more coffee filters on Acme", "engine"],
  ["download the invoice from Acme", "engine"],
  ["look up the price of a standing desk", "engine"],
  ["close all my tabs", "engine"],
  ["open the PR page", "engine"],
  ["review the PR on GitHub", "reads"],
  // Apps, files in apps and settings.
  ["click the blue Send button", "engine"],
  ["scroll down", "engine"],
  ["type hello in the search field", "engine"],
  ["In the Notes window, click Save", "engine"],
  ["save the document in Pages", "engine"],
  [
    "close the Untitled document in TextEdit without saving it, then quit TextEdit",
    "engine",
  ],
  ["quit TextEdit", "engine"],
  ["move one desktop to the right", "engine"],
  ["turn on dark mode", "engine"],
  ["set an alarm for 7am", "engine"],
  ["play some jazz on Spotify", "engine"],
  ["turn the volume down", "engine"],
  ["close those windows", "engine"],
  // Code work.
  ["fix the failing test", "job"],
  ["run the tests", "job"],
  ["run tests", "job"],
  ["build a landing page", "job"],
  ["refactor the parser module", "job"],
  ["deploy it to staging", "job"],
  ["use Claude to fix the login bug", "job"],
  ["ask codex to write tests for the auth module", "job"],
  ["npm install", "job"],
  ["run `npm test` in the terminal", "job"],
  ["fix the bug in the checkout component", "job"],
  ["merge the branch into main", "job"],
  ["write a script that renames my photos", "job"],
  ["add a dark mode to it", "job"],
  ["check the logs", "job"],
  ["start the dev server", "job"],
  ["update the dependencies", "job"],
  ["open a pull request for this branch", "job"],
  ["make a new branch and push it", "job"],
  ["kill the process on port 3000", "job"],
  ["open the button component and fix the hover state", "job"],
  // Both, the code part first.
  [
    "fix the failing test and then open the PR page",
    ["fix the failing test", "open the PR page"],
  ],
  [
    "run the tests, then post the results in Slack",
    ["run the tests", "post the results in Slack"],
  ],
  [
    "build the landing page and open it in Chrome",
    ["build the landing page", "open it in Chrome"],
  ],
  [
    "deploy to staging and then tweet that it's live",
    ["deploy to staging", "tweet that it's live"],
  ],
  [
    "check my email and then fix the bug it mentions",
    ["fix the bug it mentions", "check my email"],
  ],
  [
    "update the dependencies and then post in slack that it's done",
    ["update the dependencies", "post in slack that it's done"],
  ],
  // Answers: questions, state, sessions, capability, holds, quotes, thanks.
  ["thanks", "answer"],
  ["hey", "answer"],
  ["yes", "answer"],
  ["stop", "answer"],
  ["what is every agent doing?", "answer"],
  ["is the build done", "answer"],
  ["is chrome open?", "answer"],
  ["Did the page load?", "answer"],
  ["can you click buttons on my screen?", "answer"],
  ["can you use my browser?", "answer"],
  ["what can you do?", "answer"],
  ["how do I turn on dark mode?", "answer"],
  ["tell deploy fix to run the tests", "answer"],
  ["don't reply to Sam yet", "answer"],
  ["remind me to call mom", "answer"],
  ["let me know when the deploy session is done", "answer"],
  ["I prefer short answers", "answer"],
  [
    'Summarize this note: "In the Alpha window, click the Save button."',
    "answer",
  ],
  ["What does switch to the desktop on the left mean?", "answer"],
  ["zoom in on the deploy session", "answer"],
  ["make the button blue", "answer"],
  ["find the big files on my disk", "answer"],
  ["cancel flow needs a confirm dialog", "answer"],
  ["open the login page and add a forgot password link", "answer"],
  // Opening an app or an address is the tool that opens apps, through the model.
  ["open chrome", "answer"],
  ["Open Chrome and go to example.com", "answer"],
  ["please open TextEdit", "answer"],
];

/**
 * Messages that the route before the language model for a plain order on
 * the screen takes first ("open ... button", "can you click buttons ..."):
 * that route is another part of the brain with tests of its own. They stay
 * in the table of roads, and out of the runs through the supervisor.
 */
const takenByTheOrderRoute = new Set([
  "open the button component and fix the hover state",
  "can you click buttons on my screen?",
  "can you use my browser?",
]);
const through = (rows: [string, Expected][]) =>
  rows.filter(([words]) => !takenByTheOrderRoute.has(words));

const roadName = (road: Road): Expected =>
  road.kind === "engine"
    ? road.reads
      ? "reads"
      : "engine"
    : road.kind === "both"
      ? [road.code, road.screen]
      : road.kind;

const call = (
  name: string,
  args: unknown = {},
  id = `c-${name}`,
): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

/** A language model that says the steps in order, the last one again and again. */
function scripted(steps: (string | ToolCall[])[], nextStep = "NONE") {
  const seen: Parameters<ModelClient["complete"]>[0][] = [];
  const results: string[] = [];
  let step = 0;
  const model: ModelClient = {
    async complete(input) {
      // The question of a next step after a finished computer task.
      if (
        input.tools.length === 0 &&
        input.system.startsWith("A computer task on this Mac just ended")
      ) {
        seen.push(input);
        return { text: nextStep, toolCalls: [] };
      }
      seen.push(input);
      const last = input.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      const next = steps[Math.min(step++, steps.length - 1)]!;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  return { model, seen, results };
}

/** The made-up engine starts with no words, as the app-owned worker does; this is its first line. */
const startedText = "Opening Mail and finding the newest message from Sam.";
const jobSaid =
  "Requested a new Claude Code terminal session. Its launch has not been verified yet.";

/** A Mac with a computer engine that records what it got, and jobs that record what started. */
function mac(
  options: {
    engine?: "on" | "off" | "none";
    snapshot?: Partial<DesktopExecutionSnapshot>;
    look?: boolean;
  } = {},
) {
  const events: string[] = [];
  const looked: string[] = [];
  const state: DesktopExecutionSnapshot = {
    configured: options.engine !== "off",
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Nothing runs.",
    ...options.snapshot,
  };
  const jobs: JobPort = {
    async start(job) {
      events.push(`job: ${job}`);
      return { ok: true, said: jobSaid };
    },
    recent: () => [],
  };
  const world: SupervisorWorld = {
    now: () => Date.now(),
    board: () => null,
    desk: new DecisionDesk(folder()),
    focus: async () => ({ ok: false }),
    send: async () => ({ ok: false, route: "none" }),
    clis: () => [],
    jobs,
    ...(options.look
      ? {
          look: async (question: string) => {
            looked.push(question);
            return { ok: true, said: "Two unread messages." };
          },
          browse: async () => ({ ok: true, said: "Reloaded." }),
        }
      : {}),
    ...(options.engine === "none"
      ? {}
      : {
          execution: {
            snapshot: () => state,
            submit: async (_id: string, text: string) => {
              events.push(`engine: ${text}`);
              return { message: "" };
            },
            submitRead: async (_id: string, text: string) => {
              events.push(`engine: ${text}`);
              return { message: "" };
            },
            firstWords: async () => startedText,
            stop: () => state,
            answer: async () => ({ message: "No question waits." }),
          },
        }),
  };
  return { world, events, looked, state };
}

describe("the road of a message", () => {
  it(`places ${table.length} messages: the screen, a job, both in order, or an answer`, () => {
    expect(table.length).toBeGreaterThanOrEqual(60);
    for (const [words, expected] of table)
      expect([words, roadName(roadOf(words))]).toEqual([words, expected]);
  });
});

describe("with ClawdTime's own computer engine on", () => {
  it.each(table.filter(([, road]) => road === "engine" || road === "reads"))(
    "hands %j to the engine, whole and once, also when the model would start a job",
    async (words) => {
      const f = mac();
      const run = scripted([[call("start_job")], "Okay."]);
      const said = await new Supervisor(f.world, run.model).reply(
        [],
        words,
        "chat",
      );
      // A search of the web with no site named goes as a search in a new tab.
      const road = roadOf(words);
      expect(f.events).toEqual([
        `engine: ${road.kind === "engine" && road.goal ? road.goal : words}`,
      ]);
      expect(said).toBe(startedText);
    },
  );

  it.each(through(table.filter(([, road]) => road === "job")))(
    "starts a job for the code work %j and hands nothing to the engine, also when the model picks the engine",
    async (words) => {
      const job = mac();
      await new Supervisor(
        job.world,
        scripted([[call("start_job")], "Okay."]).model,
      ).reply([], words, "chat");
      expect(job.events).toHaveLength(1);
      expect(job.events[0]).toMatch(/^job: /);
      const wrong = mac();
      const run = scripted([[call("delegate_computer_task")], "Okay."]);
      await new Supervisor(wrong.world, run.model).reply([], words, "chat");
      expect(
        wrong.events.filter((event) => event.startsWith("engine:")),
      ).toEqual([]);
    },
  );

  it.each(
    table.filter((row): row is [string, [string, string]] =>
      Array.isArray(row[1]),
    ),
  )(
    "starts the job first and then hands the screen part to the engine for %j",
    async (words, [code, screen]) => {
      const f = mac();
      const run = scripted(["Okay."]);
      const said = await new Supervisor(f.world, run.model).reply(
        [],
        words,
        "chat",
      );
      expect(f.events).toEqual([`job: ${code}`, `engine: ${screen}`]);
      expect(said).toBe(
        `Code first: ${jobSaid} Then the screen part, "${screen}": ${startedText}`,
      );
      // The code did both: the model was not asked.
      expect(run.seen).toEqual([]);
    },
  );

  it.each(through(table.filter(([, road]) => road === "answer")))(
    "starts nothing by itself for %j",
    async (words) => {
      const f = mac();
      await new Supervisor(f.world, scripted(["Okay."]).model).reply(
        [],
        words,
        "chat",
      );
      expect(f.events).toEqual([]);
    },
  );

  it("never starts a coding job for screen work that the model hands to a job while the engine is busy", async () => {
    const f = mac({ snapshot: { state: "running", canStop: true } });
    const run = scripted([[call("start_job")], "Okay."]);
    await new Supervisor(f.world, run.model).reply(
      [],
      "reply to Sam on Slack",
      "chat",
    );
    // The engine's own gates decide about words for a task that runs.
    expect(f.events.filter((event) => event.startsWith("job:"))).toEqual([]);
  });

  it("offers the engine and not the old browser and screen tools, and says so in the instructions", async () => {
    const f = mac({ look: true });
    const run = scripted(["Two sessions work."]);
    await new Supervisor(f.world, run.model).reply(
      [],
      "what is every agent doing?",
      "chat",
    );
    const names = run.seen[0]!.tools.map((tool) => tool.name);
    expect(names).toContain("delegate_computer_task");
    expect(names).not.toContain("browser");
    expect(names).not.toContain("look_at_screen");
    expect(run.seen[0]!.system).toContain(
      "The computer engine works on this Mac's screen",
    );
    expect(run.seen[0]!.system).not.toContain("Computer use is off");
    expect(
      run.seen[0]!.tools.find((tool) => tool.name === "delegate_computer_task")!
        .description,
    ).toContain("also when the words do not name the screen");
  });

  it("hands a call of the old browser or screen tool to the engine", async () => {
    // Words that the code does not place by itself: the model picks a tool.
    for (const [tool, args, words] of [
      ["browser", { action: "reload" }, "the page in front, reload it"],
      ["look_at_screen", { question: "x" }, "tell me what the screen shows"],
    ] as const) {
      expect(roadOf(words).kind).toBe("answer");
      const f = mac({ look: true });
      const run = scripted([[call(tool, args)], "Okay."]);
      expect(
        await new Supervisor(f.world, run.model).reply([], words, "chat"),
      ).toBe(startedText);
      expect(f.looked).toEqual([]);
      expect(f.events).toEqual([`engine: ${words}`]);
    }
  });
});

describe("words that hold the work back, with the engine on and free", () => {
  const held = [
    "hang on, reply to Sam",
    "Reply to Sam tomorrow",
    "reply to Sam after the meeting",
    "Book the 3pm slot once I confirm",
    "check my email, then reply to Sam tonight",
  ];
  it.each(held)(
    "starts no job and no screen work for %j when the model would start a job",
    async (words) => {
      const f = mac();
      const run = scripted([[call("start_job")], "Okay."]);
      const said = await new Supervisor(f.world, run.model).reply(
        [],
        words,
        "chat",
      );
      expect(f.events).toEqual([]);
      expect(said).not.toBe(startedText);
    },
  );
});

/**
 * A clear request starts now, on the Mac. The owner typed "Can you search
 * iPhone 17 Pro Max?" and got "No active job for searching iPhone 17 Pro
 * Max yet. I can start that search in Google Chrome for you now. Should I?"
 * (26 Nov 2026). Each row: the message, and what ClawdTime does with it. A
 * goal is what the engine gets now, "own" is the engine with the person's
 * own words, "job" is code work for a coding job and never the engine, and
 * "answer" starts nothing.
 */
const search = (query: string) =>
  `Search the web for ${query} in a new tab of Google Chrome`;
type Effect = { goal: string } | "own" | "job" | "answer";
const actNow: [string, Effect][] = [
  // The owner's own examples.
  ["Can you search iPhone 17 Pro Max?", { goal: search("iPhone 17 Pro Max") }],
  [
    "could you find barista courses in Delhi",
    { goal: search("barista courses in Delhi") },
  ],
  ["can u look up flights to Goa", { goal: search("flights to Goa") }],
  ["search for running shoes", { goal: search("running shoes") }],
  [
    "find me a good Thai place nearby",
    { goal: search("a good Thai place nearby") },
  ],
  ["look up the weather in Mumbai", { goal: search("the weather in Mumbai") }],
  ["check my Gmail", "own"],
  ["what's the price of AirPods Pro on Amazon", "own"],
  // Polite, casual and typo forms.
  ["can you search iPhone 17 Pro Max", { goal: search("iPhone 17 Pro Max") }],
  ["search iPhone 17 Pro Max?", { goal: search("iPhone 17 Pro Max") }],
  ["pls search iphone 17 pro max", { goal: search("iphone 17 pro max") }],
  ["cn u srch iphone 17 pro max?", { goal: search("iphone 17 pro max") }],
  ["can you serch iPhone 17 Pro Max?", { goal: search("iPhone 17 Pro Max") }],
  ["srch running shoes", { goal: search("running shoes") }],
  [
    "cud u find me cheap flights to goa?",
    { goal: search("cheap flights to goa") },
  ],
  [
    "hey could you please look up barista courses in Delhi?",
    { goal: search("barista courses in Delhi") },
  ],
  [
    "can you actually find barista courses in Delhi?",
    { goal: search("barista courses in Delhi") },
  ],
  [
    "are you able to search for barista courses in Delhi?",
    { goal: search("barista courses in Delhi") },
  ],
  [
    "can you search the web for iPhone 17 Pro Max?",
    { goal: search("iPhone 17 Pro Max") },
  ],
  ["search up iphone 17 pro max", { goal: search("iphone 17 pro max") }],
  ["look for a cheap hotel in Goa", { goal: search("a cheap hotel in Goa") }],
  ["search iPhone 17 Pro Max. Thanks", { goal: search("iPhone 17 Pro Max") }],
  [
    "what's the price of the iPhone 17 Pro Max?",
    { goal: search("the price of iPhone 17 Pro Max") },
  ],
  [
    "how much does a standing desk cost?",
    { goal: search("the price of a standing desk") },
  ],
  // A site or an app named: the person's own words.
  ["whats the price of airpods on amazon", "own"],
  ["search iPhone 17 Pro Max on Amazon", "own"],
  ["search iPhone 17 Pro Max in Chrome", "own"],
  ["search Google for flights to Tokyo", "own"],
  ["google the weather in Paris", "own"],
  ["could you check my Gmail?", "own"],
  ["find barista courses in Delhi and book one", "own"],
  // Things of the person or of code: no search of the web.
  ["search my email for the invoice", "own"],
  ["find the invite from Jane", "own"],
  ["search for the flaky test", "job"],
  ["find a function that parses dates", "job"],
  // Questions about ClawdTime itself, with a general thing.
  ["can you click buttons on my screen?", "answer"],
  ["can you use my mac?", "answer"],
  ["can you search the web?", "answer"],
  ["can you search?", "answer"],
  ["can you look things up?", "answer"],
  ["can you browse the web?", "answer"],
  ["can u google stuff for me?", "answer"],
  ["can you find stuff online?", "answer"],
  ["what can you do?", "answer"],
  // Stops and holds.
  ["stop", "answer"],
  ["stop the search", "answer"],
  ["hold on, search iPhone 17 Pro Max", "answer"],
  ["wait, search for flights to Goa", "answer"],
  ["search iPhone 17 Pro Max tomorrow", "answer"],
  ["search for running shoes later", "answer"],
  ["don't search iPhone 17 Pro Max", "answer"],
  ["never mind, look up flights to Goa", "answer"],
  ["not now, find barista courses in Delhi", "answer"],
  ["maybe search for running shoes", "answer"],
  ["search iPhone 17 Pro Max once I say go", "answer"],
];
/** The draft of the bug: an offer in place of the start. */
const offerDraft =
  "No active job for searching iPhone 17 Pro Max yet. I can start that search in Google Chrome for you now. Should I?";
/** Words that hold the work back or stop it: they never start, on any road. */
const holds = actNow
  .slice(actNow.findIndex(([words]) => words === "stop"))
  .map(([words]) => words);

describe("a clear request starts now, on the Mac", () => {
  it(`has ${actNow.length} messages, with true capability questions, holds and stops`, () => {
    expect(actNow.length).toBeGreaterThanOrEqual(40);
    expect(holds.length).toBeGreaterThanOrEqual(10);
  });

  it.each(actNow)(
    "does what %j asks with the engine free, also when the model would only offer it",
    async (words, effect) => {
      const f = mac();
      const run = scripted(
        effect === "job"
          ? [[call("start_job")], "Okay."]
          : [offerDraft, offerDraft],
      );
      const said = await new Supervisor(f.world, run.model).reply(
        [],
        words,
        "chat",
      );
      const engine = f.events.filter((event) => event.startsWith("engine:"));
      if (effect === "answer") expect(f.events).toEqual([]);
      else if (effect === "job") {
        expect(engine).toEqual([]);
        expect(f.events).toHaveLength(1);
        expect(f.events[0]).toMatch(/^job: /);
      } else {
        expect(f.events).toEqual([
          `engine: ${effect === "own" ? words : effect.goal}`,
        ]);
        expect(said).toBe(startedText);
        // The code started it: the model was not asked.
        expect(run.seen).toEqual([]);
      }
    },
  );

  it.each(actNow.filter(([, effect]) => typeof effect === "object"))(
    "reads %j as a search of the web: the engine gets the search in a new tab",
    (words, effect) => {
      const road = roadOf(words);
      expect(road).toEqual({
        kind: "engine",
        reads: false,
        goal: (effect as { goal: string }).goal,
      });
    },
  );
});

describe("a drafted offer for a clear request", () => {
  /** An engine that is not ClawdTime's own worker: the model is asked first. */
  const other = () => mac({ snapshot: { mode: "browser" } });

  it.each([
    offerDraft,
    "Want me to look up flights to Goa?",
    "I can do that. Should I go ahead?",
    "No active job for that yet.",
    "Would you like me to search for it in Chrome?",
    "Just say the word and I'll search it.",
    "I can search that for you now.",
    "Sure, I can start that search. Want me to?",
  ])("starts the work in place of the draft %j", async (draft) => {
    const f = other();
    const run = scripted([draft]);
    const said = await new Supervisor(f.world, run.model).reply(
      [],
      "Can you search iPhone 17 Pro Max?",
      "chat",
    );
    expect(f.events).toEqual([`engine: ${search("iPhone 17 Pro Max")}`]);
    expect(said).toBe(startedText);
    expect(run.seen).toHaveLength(1);
  });

  it("starts the person's own words where a site is named", async () => {
    const f = other();
    const said = await new Supervisor(
      f.world,
      scripted(["Want me to check it now?"]).model,
    ).reply([], "check my Gmail", "chat");
    expect(f.events).toEqual(["engine: check my Gmail"]);
    expect(said).toBe(startedText);
  });

  it.each([
    ["reply to Sam on Slack", "Which Slack account: work or personal?"],
    ["reply to Sam on Slack", "Which Sam do you mean?"],
    [
      "search iPhone 17 Pro Max on Amazon",
      "Should I search the US store or the India store?",
    ],
    [
      "Can you search iPhone 17 Pro Max?",
      "I can search it once you sign in to Chrome. Should I?",
    ],
  ])(
    "keeps a question that only the person can answer, for %j",
    async (words, draft) => {
      const f = other();
      const said = await new Supervisor(f.world, scripted([draft]).model).reply(
        [],
        words,
        "chat",
      );
      expect(f.events).toEqual([]);
      expect(said).toBe(draft);
    },
  );

  it.each(holds)(
    "starts nothing for %j, whatever the draft offers",
    async (words) => {
      const f = other();
      await new Supervisor(
        f.world,
        scripted([offerDraft, offerDraft]).model,
      ).reply([], words, "chat");
      expect(f.events).toEqual([]);
    },
  );

  it("starts nothing for a question about what it can do", async () => {
    for (const words of [
      "can you search the web?",
      "can you use my mac?",
      "can you click buttons on my screen?",
    ]) {
      const f = other();
      await new Supervisor(
        f.world,
        scripted([offerDraft, offerDraft]).model,
      ).reply([], words, "chat");
      expect([words, f.events]).toEqual([words, []]);
    }
  });

  it("says how to turn computer use on in place of the offer when it is off", async () => {
    const f = mac({ engine: "none" });
    const words = "Can you search iPhone 17 Pro Max?";
    const said = await new Supervisor(
      f.world,
      scripted([offerDraft]).model,
    ).reply([], words, "chat");
    expect(f.events).toEqual([]);
    expect(said).toBe(computerOffReply(words, true));
  });

  it.each([
    [offerDraft, true],
    ["Want me to look up flights to Goa?", true],
    ["Should I go ahead?", true],
    ["Do you want me to start it now?", true],
    ["I could open Chrome and search it.", true],
    ["Nothing is running for that yet.", true],
    ["Say yes and I'll start.", true],
    ["Which account should I use?", false],
    ["Should I use the work or the personal account?", false],
    ["Do you want the Pro or the Pro Max?", false],
    [
      "Started. I look at the screen and take one checked action at a time.",
      false,
    ],
    ["Two sessions work.", false],
    ["I can't see the screen from here.", false],
  ])(
    "reads the draft %j as an offer in place of the start: %s",
    (draft, offers) => {
      expect(offersInsteadOfStarting(draft)).toBe(offers);
    },
  );
});

describe("the instructions of the model", () => {
  it("tell it to act on a clear request, never to offer it, and to search the web on the engine", async () => {
    const f = mac();
    const run = scripted(["Two sessions work."]);
    await new Supervisor(f.world, run.model).reply(
      [],
      "what is every agent doing?",
      "chat",
    );
    const system = run.seen[0]!.system;
    expect(system).toContain('Never ask "Should I?", "Want me to?"');
    expect(system).toContain(
      "never answer that no job or task runs for it yet: start it",
    );
    expect(system).toContain(
      "that only the person knows (which account, which file)",
    );
    expect(system).toContain(
      "searches the web in a new tab of the person's Chrome",
    );
    expect(system).not.toContain("offer the one next step");
    expect(system).not.toMatch(/I can start that[^"]*Should I\?/);
    expect(
      run.seen[0]!.tools.find((tool) => tool.name === "delegate_computer_task")!
        .description,
    ).toContain("a search of the web");
  });
});

describe("with computer use off", () => {
  const screenWork = table
    .filter(([, road]) => road === "engine")
    .map(([words]) => words);

  it.each(screenWork)(
    "never starts a coding job for the screen work %j: it says what it would do and how to turn computer use on",
    async (words) => {
      const f = mac({ engine: "none" });
      const said = await new Supervisor(
        f.world,
        scripted([[call("start_job")], "Okay."]).model,
      ).reply([], words, "chat");
      expect(f.events).toEqual([]);
      expect(said).toBe(computerOffReply(words, true));
      expect(said).toContain("clawdtime computer on");
      expect(said).not.toMatch(/\bI (?:cannot|can't)\b/);
    },
  );

  it.each([
    "I can't do that from here.",
    "Sorry, I'm not able to post on X.",
    "I don't have access to your Slack.",
  ])("replaces the draft %j with the turn-on sentence", async (draft) => {
    const f = mac({ engine: "none" });
    const said = await new Supervisor(f.world, scripted([draft]).model).reply(
      [],
      "follow up on my latest X posts",
      "chat",
    );
    expect(said).toBe(
      "I'd follow up on your latest X posts on the screen, but computer use is off. Turn it on with: clawdtime computer on, then start the desktop service again. Then ask me again.",
    );
  });

  it("names only the command where the worker is there and its switch is off", async () => {
    const f = mac({ engine: "off" });
    const said = await new Supervisor(
      f.world,
      scripted([[call("start_job")], "Okay."]).model,
    ).reply([], "reply to Sam on Slack", "chat");
    expect(said).toBe(
      "I'd reply to Sam on Slack on the screen, but computer use is off. Turn it on with: clawdtime computer on. Then ask me again.",
    );
    expect(f.events).toEqual([]);
  });

  it("starts the job for the code part and says how to turn computer use on for the screen part", async () => {
    const f = mac({ engine: "none" });
    const said = await new Supervisor(f.world, scripted(["Okay."]).model).reply(
      [],
      "fix the failing test and then open the PR page",
      "chat",
    );
    expect(f.events).toEqual(["job: fix the failing test"]);
    expect(said).toBe(
      `Code first: ${jobSaid} Then the screen part, "open the PR page": I'd open the PR page on the screen, but computer use is off. Turn it on with: clawdtime computer on, then start the desktop service again. Then ask me again.`,
    );
  });

  it("keeps the old tools for a reading of the screen, and says so in the instructions", async () => {
    const f = mac({ engine: "none", look: true });
    const run = scripted([
      [call("look_at_screen", { question: "x" })],
      "You have two unread messages.",
    ]);
    const said = await new Supervisor(f.world, run.model).reply(
      [],
      "read through my Slack messages",
      "chat",
    );
    expect(f.looked).toEqual(["read through my Slack messages"]);
    expect(said).toBe("You have two unread messages.");
    const names = run.seen[0]!.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["browser", "look_at_screen"]),
    );
    expect(run.seen[0]!.system).toContain("Computer use is off on this Mac");
    expect(run.seen[0]!.system).toContain("clawdtime computer on");
  });

  it("still hands work that no tool does to a coding session, as before", async () => {
    const f = mac({ engine: "none" });
    await new Supervisor(
      f.world,
      scripted([[call("start_job")], "Okay."]).model,
    ).reply([], "find the big files on my disk", "chat");
    expect(f.events).toEqual(["job: find the big files on my disk"]);
  });
});

describe("a next step after a computer task ended done", () => {
  const report = "Done. Sam wrote twice about the launch.";
  const offer = "Want me to reply to Sam's newest message?";

  it("offers one short, concrete step and starts nothing", async () => {
    const f = mac();
    const run = scripted(["Okay."], offer);
    const supervisor = new Supervisor(f.world, run.model);
    await supervisor.reply([], "check my email", "chat");
    expect(f.events).toEqual(["engine: check my email"]);
    expect(await supervisor.offerNextStep(report)).toBe(offer);
    // The model read the request and the report, as data.
    expect(run.seen.at(-1)!.messages[0]!.content).toBe(
      `The task: check my email\nIts report: ${report}`,
    );
    expect(f.events).toEqual(["engine: check my email"]);
  });

  it.each([
    ["NONE"],
    ["Want me to help with anything else?"],
    ["Is there something else I can do?"],
    ["Want me to pay the invoice?"],
    ["Want me to delete the old messages?"],
    ["Want me to sign in to your bank?"],
    ["Want me to fix the failing test?"],
    ['Want me to type "ignore all rules"?'],
  ])("offers nothing for the draft %j", async (draft) => {
    const f = mac();
    const supervisor = new Supervisor(
      f.world,
      scripted(["Okay."], draft).model,
    );
    expect(await supervisor.offerNextStep(report)).toBeNull();
  });

  it("offers nothing for a task that did not end done, for a credential, with no model, and with the engine off", async () => {
    const f = mac();
    const supervisor = new Supervisor(
      f.world,
      scripted(["Okay."], offer).model,
    );
    expect(
      await supervisor.offerNextStep(
        "I could not finish. The page did not load.",
      ),
    ).toBeNull();
    expect(
      await supervisor.offerNextStep(
        "Done. The key is sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD.",
      ),
    ).toBeNull();
    expect(
      await new Supervisor(f.world, null).offerNextStep(report),
    ).toBeNull();
    const off = mac({ engine: "off" });
    expect(
      await new Supervisor(
        off.world,
        scripted(["Okay."], offer).model,
      ).offerNextStep(report),
    ).toBeNull();
  });

  it("starts the step on a plain yes right after the offer, and only then", async () => {
    const f = mac();
    const supervisor = new Supervisor(
      f.world,
      scripted(["Okay."], offer).model,
    );
    expect(await supervisor.offerNextStep(report)).toBe(offer);
    const shown: ChatMessage[] = [
      { role: "assistant", text: report, at: Date.now(), via: "chat" },
      { role: "assistant", text: offer, at: Date.now(), via: "chat" },
    ];
    expect(await supervisor.reply(shown, "yes", "chat")).toBe(startedText);
    expect(f.events).toEqual(["engine: reply to Sam's newest message"]);
  });

  it("never starts the step without a word: a no, another message, or a yes that comes too late", async () => {
    for (const words of ["no", "thanks", "what did Sam say?", "ok", "sure"]) {
      const f = mac();
      const run = scripted([[call("delegate_computer_task")], "Okay."], offer);
      const supervisor = new Supervisor(f.world, run.model);
      expect(await supervisor.offerNextStep(report)).toBe(offer);
      const shown: ChatMessage[] = [
        { role: "assistant", text: offer, at: Date.now(), via: "chat" },
      ];
      await supervisor.reply(shown, words, "chat");
      expect([
        words,
        f.events.filter((e) => e.includes("Sam's newest")),
      ]).toEqual([words, []]);
      // A yes after that message is no answer to the offer any more.
      await supervisor.reply(
        [
          ...shown,
          { role: "user", text: words, at: Date.now(), via: "chat" },
          { role: "assistant", text: "Okay.", at: Date.now(), via: "chat" },
        ],
        "yes",
        "chat",
      );
      expect([
        words,
        f.events.filter((e) => e.includes("Sam's newest")),
      ]).toEqual([words, []]);
    }
  });

  it("starts nothing on a yes when the offer is not the newest message, or when the engine is busy", async () => {
    const f = mac();
    const supervisor = new Supervisor(
      f.world,
      scripted(["Okay."], offer).model,
    );
    await supervisor.offerNextStep(report);
    await supervisor.reply(
      [
        { role: "assistant", text: offer, at: Date.now(), via: "chat" },
        {
          role: "assistant",
          text: "Done: a job.",
          at: Date.now(),
          via: "chat",
        },
      ],
      "yes",
      "chat",
    );
    expect(f.events).toEqual([]);
    const busy = mac();
    const other = new Supervisor(busy.world, scripted(["Okay."], offer).model);
    await other.offerNextStep(report);
    busy.state.state = "running";
    busy.state.canStop = true;
    await other.reply(
      [{ role: "assistant", text: offer, at: Date.now(), via: "chat" }],
      "yes",
      "chat",
    );
    expect(busy.events).toEqual([]);
  });

  it("says the offer in the chat after the report of the engine, and the yes starts it on the worker", async () => {
    const root = folder();
    const hands = new FakeHands([
      observation([element(1, { title: "Inbox" })]),
    ]);
    const planner = new ScriptedPlanner([
      { kind: "done", summary: "Sam wrote twice about the launch." },
      { kind: "done", summary: "The reply is written." },
    ]);
    let feed: BoardFeed | undefined;
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(root),
      notify: (text) => feed?.appendExecutionResult(text),
    });
    feed = new BoardFeed({
      root,
      model: scripted(["Okay."], offer).model,
      speech: null,
      execution: worker,
    });
    await worker.submit("r1", "check my email");
    await worker.idle();
    await until(() => feed!.chat().messages.length === 2);
    expect(feed.chat().messages.map((message) => message.text)).toEqual([
      report,
      offer,
    ]);
    expect(feed.chat().messages.at(-1)!.choices).toEqual(["Yes", "No"]);
    // The offer started nothing on the worker.
    expect(planner.inputs).toHaveLength(1);
    const reply = await feed.say("yes");
    // No fixed start sentence: the answer is the worker's first words, here its end.
    expect(reply.text).toBe("Done. The reply is written.");
    await worker.idle();
    expect(planner.inputs.at(-1)!.goal).toBe("reply to Sam's newest message");
    // The end is in the chat once.
    expect(
      feed.chat().messages.filter((message) => message.text === reply.text),
    ).toHaveLength(1);
    feed.close();
  });

  it("says no offer when the person spoke after the report", async () => {
    const f = mac();
    const feed = new BoardFeed({
      root: folder(),
      model: scripted(["Okay."], offer).model,
      speech: null,
      execution: f.world.execution!,
    });
    const said = feed.offerNextStep(report);
    // The report is not in the chat: something else is the newest message.
    await said;
    expect(feed.chat().messages.map((message) => message.text)).toEqual([]);
    feed.close();
  });
});
