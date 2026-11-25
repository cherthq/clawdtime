import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
  type ToolCall,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import type { JobPort } from "../connectors/agents/jobs.js";
import {
  computerOffReply,
  roadOf,
  type Road,
} from "../connectors/agents/route.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";

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

const startedText =
  "Started. I look at the screen and take one checked action at a time. Say stop to stop me.";
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
              return { message: startedText };
            },
            submitRead: async (_id: string, text: string) => {
              events.push(`engine: ${text}`);
              return { message: startedText };
            },
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
      expect(f.events).toEqual([`engine: ${words}`]);
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
