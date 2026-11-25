import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type ModelClient } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  lineFromWhy,
  openingLimits,
  spokenLine,
} from "../connectors/computer/opening.js";
import type {
  Outline,
  OutlineInput,
  Subgoal,
} from "../connectors/computer/plan.js";
import { OpenAIPlanner } from "../connectors/computer/planner.js";
import type { Action, Planner } from "../connectors/computer/ports.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import { PhoneDesktop } from "../src/control/phone-desktop.js";
import {
  element,
  FakeHands,
  observation,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
const adapters: PhoneDesktop[] = [];
afterEach(() => {
  adapters.splice(0).forEach((adapter) => adapter.shutdown());
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true }));
});
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-opening-"));
  roots.push(path);
  return path;
};

const subgoals: Subgoal[] = [
  { goal: "Save the note", check: "The title shows it is saved" },
];
const say = "Opening Notes and saving the budget note.";
const save: Action = { kind: "click_element", element: 1 };
const send: Action = { kind: "click_element", element: 2 };
const done: Action = { kind: "done", summary: "The note is saved." };
const pause: Action = { kind: "wait", ms: 60 };

/** A planner with an outline. Each turn gives its action with its own reason. */
class OpeningPlanner implements Planner {
  readonly outlines: OutlineInput[] = [];
  readonly turns: { action: Action; why: string }[];
  constructor(
    turns: [Action, string][],
    private readonly made: (
      input: OutlineInput,
    ) => Promise<Outline | Subgoal[]> = async () => ({ subgoals, say }),
  ) {
    this.turns = turns.map(([action, why]) => ({ action, why }));
  }
  outline(input: OutlineInput) {
    this.outlines.push(input);
    return this.made(input);
  }
  async next() {
    return (
      this.turns.shift() ?? {
        action: { kind: "give_up", reason: "The script ended." } as Action,
        why: "",
      }
    );
  }
}

function setup(planner: Planner, openingMs?: number) {
  const root = home();
  const hands = new FakeHands([
    observation([element(1, { title: "Save" }), element(2, { title: "Send" })]),
  ]);
  const said: string[] = [];
  const worker = new ComputerWorker({
    hands,
    planner,
    journal: new ComputerJournal(root),
    notify: (text) => said.push(text),
    ...(openingMs !== undefined ? { openingMs } : {}),
  });
  return { root, hands, said, worker };
}

describe("the line for the person", () => {
  it("is one plain line of at most 120 characters, with no secret and no word of the machinery", () => {
    expect(spokenLine(`  "${say}"  `)).toBe(say);
    expect(spokenLine("opening Notes and saving the note")).toBe(
      "Opening Notes and saving the note.",
    );
    expect(spokenLine("Opening Mail.\nThen writing to Sam.")).toBe(
      "Opening Mail. Then writing to Sam.",
    );
    // Too long: its first sentence, when that fits. Else nothing.
    expect(
      spokenLine(`Opening Mail to write to Sam. ${"Then more. ".repeat(12)}`),
    ).toBe("Opening Mail to write to Sam.");
    expect(spokenLine("a".repeat(openingLimits.length + 1))).toBeNull();
    // A secret, the engine's own openings, and words of how the worker works.
    expect(spokenLine("My password is hunter22, opening Mail.")).toBeNull();
    expect(spokenLine("Done. The note is saved.")).toBeNull();
    expect(spokenLine("Started. I look at the screen.")).toBeNull();
    expect(spokenLine("Working on subgoal 1 of the plan.")).toBeNull();
    expect(spokenLine("I take one checked action at a time.")).toBeNull();
    expect(spokenLine("")).toBeNull();
    expect(spokenLine(42)).toBeNull();
  });

  it("is made from the planner's reason as what the worker does now, or not at all", () => {
    expect(lineFromWhy("Open Notes to find the note")).toBe(
      "Opening Notes to find the note.",
    );
    expect(lineFromWhy("To search for the budget note")).toBe(
      "Searching for the budget note.",
    );
    expect(lineFromWhy("First, click the search field and type the name")).toBe(
      "Clicking the search field and typing the name.",
    );
    expect(lineFromWhy("I open the menu of the app")).toBe(
      "I open the menu of the app.",
    );
    expect(lineFromWhy("Typing the name of the note")).toBe(
      "Typing the name of the note.",
    );
    // No act of the worker: no line.
    expect(lineFromWhy("The person asked to open this address.")).toBeNull();
    expect(lineFromWhy("Search field is visible")).toBeNull();
    expect(lineFromWhy("step 1")).toBeNull();
    expect(lineFromWhy("turn 2")).toBeNull();
    expect(lineFromWhy("Type the password hunter22 here")).toBeNull();
  });
});

describe("the outline's line in the planner", () => {
  const network = (answer: unknown) => {
    const sent: {
      messages: { role: string; content: unknown }[];
      tools: {
        function: {
          name: string;
          parameters: {
            properties: Record<string, unknown>;
            required: string[];
          };
        };
      }[];
    }[] = [];
    const request = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(answer));
    }) as typeof fetch;
    return { sent, request };
  };
  const called = (args: unknown) => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "outline", arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
  const planner = (request: typeof fetch) =>
    new OpenAIPlanner({
      key: "sk-fixture-key-that-stays-hidden",
      request,
      sleep: async () => {},
    });
  const input = {
    goal: "Save the budget note",
    observation: observation([element(1, { title: "Save" })]),
    page: null,
  };

  it("asks for say beside the subgoals, and reads it back", async () => {
    const net = network(called({ subgoals, say, why: "One part" }));
    expect(await planner(net.request).outline(input)).toEqual({
      subgoals,
      say,
    });
    const tool = net.sent[0]!.tools[0]!.function;
    expect(tool.name).toBe("outline");
    expect(tool.parameters.required).toEqual(["subgoals", "say", "why"]);
    expect(tool.parameters.properties.say).toMatchObject({ type: "string" });
    const system = net.sent[0]!.messages[0]!.content as string;
    expect(system).toMatch(
      /Also write say: the one line that the person hears/,
    );
    expect(system).toMatch(/in the language of the goal/);
    expect(system).toMatch(/no promise that the task will succeed/);
  });

  it("reads an outline with no say as before", async () => {
    const net = network(called({ subgoals, why: "One part" }));
    expect(await planner(net.request).outline(input)).toEqual({ subgoals });
  });
});

describe("the first words of a request", () => {
  it("answers the start with no words, and says the outline's line once, as the first message", async () => {
    const planner = new OpeningPlanner([
      [save, "Click Save to keep the note"],
      [done, "The note is saved"],
    ]);
    const f = setup(planner);
    expect(await f.worker.submit("r1", "Save the budget note")).toEqual({
      message: "",
    });
    expect(await f.worker.firstWords("r1", 2000)).toBe(say);
    await f.worker.idle();
    expect(f.said).toEqual([say, "Done. The note is saved."]);
    expect(planner.outlines).toHaveLength(1);
    // The words of another id are none.
    expect(await f.worker.firstWords("other", 10)).toBe("");
  });

  it("makes the line from the first action's reason when the outline fails", async () => {
    const planner = new OpeningPlanner(
      [
        [save, "Click Save to keep the note"],
        [done, ""],
      ],
      async () => {
        throw new Error("The outline failed.");
      },
    );
    const f = setup(planner);
    await f.worker.submit("r1", "Save the budget note");
    await f.worker.idle();
    expect(f.said).toEqual([
      "Clicking Save to keep the note.",
      "Done. The note is saved.",
    ]);
  });

  it("makes the line from the reason when the outline says nothing in time, and a late line says nothing more", async () => {
    let late = () => {};
    const planner = new OpeningPlanner(
      [
        [save, "Click Save to keep the note"],
        [pause, "Wait for the note to save"],
        [done, ""],
      ],
      () =>
        new Promise((resolve) => {
          late = () => resolve({ subgoals, say });
        }),
    );
    const f = setup(planner, 5);
    // The wait takes real time, so the outline's time passes in it.
    f.hands.answer = (command) =>
      command.kind === "wait"
        ? new Promise((done) => setTimeout(() => done({}), 60))
        : undefined;
    await f.worker.submit("r1", "Save the budget note");
    expect(await f.worker.firstWords("r1", 2000)).toBe(
      "Clicking Save to keep the note.",
    );
    late();
    await f.worker.idle();
    expect(f.said).toEqual([
      "Clicking Save to keep the note.",
      "Done. The note is saved.",
    ]);
  });

  it("drops a line that holds a secret, and the reason stands in", async () => {
    const planner = new OpeningPlanner(
      [
        [save, "Open the note to save it"],
        [done, ""],
      ],
      async () => ({ subgoals, say: "My password is hunter22, opening Mail." }),
    );
    const f = setup(planner);
    await f.worker.submit("r1", "Save the budget note");
    await f.worker.idle();
    expect(f.said).toEqual([
      "Opening the note to save it.",
      "Done. The note is saved.",
    ]);
    expect(f.said.join(" ")).not.toMatch(/hunter22/);
  });

  it("says no start line after a question that came first", async () => {
    const planner = new OpeningPlanner(
      [[send, "Click Send to send the mail"]],
      () => new Promise(() => {}),
    );
    const f = setup(planner, 5);
    await f.worker.submit("r1", "Finish the draft");
    await until(() => f.worker.snapshot().state === "waiting_for_person");
    expect(await f.worker.firstWords("r1", 10)).toMatch(/^Click "Send"/);
    await new Promise((done) => setTimeout(done, 20));
    f.worker.stop();
    await f.worker.idle();
    expect(f.said).toHaveLength(1);
    expect(f.said[0]).toMatch(/^Click "Send" in Notes\?/);
  });

  it("starts with no fixed sentence: with nothing to say, the end is the first message", async () => {
    const planner: Planner = {
      next: async () => ({ action: done, why: "step 1" }),
    };
    const f = setup(planner);
    expect(f.worker.status().message).toBe(
      "Computer use is on. No computer task runs now.",
    );
    expect((await f.worker.submit("r1", "Save the note")).message).toBe("");
    await f.worker.idle();
    expect(f.said).toEqual(["Done. The note is saved."]);
  });

  it("says one line in the planner's own words when the plan is revised, once", async () => {
    const planner = new OpeningPlanner([
      [save, "Click Save to keep the note"],
      [pause, ""],
      [pause, ""],
      [done, ""],
    ]);
    const revise = (reason: string) => ({
      op: "revise",
      reason,
      subgoals: [{ goal: "Save it again", check: "It is saved" }],
    });
    const turns = [
      revise("The note was in another folder, so I look there first."),
      revise("Still another place."),
    ];
    const next = planner.next.bind(planner);
    planner.next = async () => {
      const turn = await next();
      const update = turn.action.kind === "wait" ? turns.shift() : undefined;
      return update ? { ...turn, update } : turn;
    };
    const f = setup(planner);
    await f.worker.submit("r1", "Save the budget note");
    await f.worker.idle();
    expect(f.said).toEqual([
      say,
      "The note was in another folder, so I look there first.",
      "Done. The note is saved.",
    ]);
  });

  it("holds no fixed start sentence in the code that answers a person", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return path.endsWith(".ts") ? [path] : [];
      });
    const root = join(__dirname, "..");
    for (const path of [
      ...files(join(root, "connectors")),
      ...files(join(root, "src")),
    ]) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/take one checked action at a time/);
      expect(text, path).not.toMatch(/Ask me to do something on this Mac/);
      expect(text, path).not.toMatch(/"Started\. I look at the screen/);
    }
  });
});

/** A model that hands every request to the computer, as the real one does for an action request. */
const delegating = (): ModelClient => ({
  complete: vi.fn(async () => ({
    text: "",
    toolCalls: [{ id: "a", name: "delegate_computer_task", arguments: "{}" }],
  })),
});

describe("the chat and the call show the first words", () => {
  it("the chat shows the outline's line as the first answer, written once", async () => {
    const root = home();
    const hands = new FakeHands([observation([element(1, { title: "Save" })])]);
    let feed: BoardFeed | undefined;
    const worker = new ComputerWorker({
      hands,
      planner: new OpeningPlanner([
        [save, "Click Save to keep the note"],
        [done, ""],
      ]),
      journal: new ComputerJournal(root),
      notify: (text) => feed?.appendExecutionResult(text),
    });
    feed = new BoardFeed({
      root,
      model: delegating(),
      speech: null,
      execution: worker,
    });
    const reply = await feed.say("save the budget note in Notes");
    expect(reply).toMatchObject({ role: "assistant", text: say });
    await worker.idle();
    expect(feed.chat().messages.map((message) => message.text)).toEqual([
      "save the budget note in Notes",
      say,
      "Done. The note is saved.",
    ]);
    // The line said while the task ran is marked as the engine's own; its end is not.
    expect(feed.chat().messages[1]).toMatchObject({ engine: true });
    expect(feed.chat().messages[2]!.engine).toBeUndefined();
    feed.close();
  });

  it("the call speaks the same line through the phone adapter, for its own request only", async () => {
    const root = home();
    const hands = new FakeHands([observation([element(1, { title: "Save" })])]);
    const worker = new ComputerWorker({
      hands,
      planner: new OpeningPlanner([
        [save, "Click Save to keep the note"],
        [done, ""],
      ]),
      journal: new ComputerJournal(root),
    });
    const phone = new PhoneDesktop(worker);
    adapters.push(phone);
    const supervisor = new Supervisor(
      {
        now: Date.now,
        board: () => null,
        desk: new DecisionDesk(root),
        focus: async () => ({ ok: false }),
        send: async () => ({ ok: false, route: "none" }),
        clis: () => [],
        execution: phone.execution,
      },
      delegating(),
    );
    phone.open("call_1");
    const words = "save the budget note in Notes";
    const spoken = await phone.run("call_1", "turn_1", words, () =>
      supervisor.reply([], words, "voice"),
    );
    expect(spoken).toBe(say);
    await worker.idle();
    // Outside the call the adapter reads the worker's own ids.
    expect(await phone.execution.firstWords!("talk_x_execution", 5)).toBe("");
  });
});
