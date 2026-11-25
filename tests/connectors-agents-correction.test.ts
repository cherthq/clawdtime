import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
} from "../connectors/agents/brain.js";
import {
  correctedName,
  correctionMs,
  correctionRequest,
  openedTarget,
} from "../connectors/agents/correction.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import type { AgentSession } from "../connectors/agents/types.js";
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

/**
 * A short correction right after a computer request. On the owner's Mac a
 * misheard name was opened, and "<the right name> bro" got "I have not done
 * that". Made-up names only: Brightwave stands for the owner's company.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-correction-"));
  roots.push(path);
  return path;
};

describe("the words of a correction", () => {
  it.each([
    ["brightwave bro", "brightwave"],
    ["Brightwave", "Brightwave"],
    ["brightwave.co", "brightwave.co"],
    ["no, brightwave", "brightwave"],
    ["I mean brightwave", "brightwave"],
    ["brightwave dot co", "brightwave.co"],
    ["Brightwave Studio pls", "Brightwave Studio"],
    ["https://www.brightwave.co", "brightwave.co"],
  ])("reads %j as the name %j", (words, name) => {
    expect(correctedName(words)).toBe(name);
  });

  it.each([
    "no",
    "nope",
    "stop",
    "stop it",
    "wait",
    "hold on",
    "hang on",
    "go on",
    "not yet",
    "thanks bro",
    "ok cool",
    "nice one",
    "yes",
    "never mind",
    "what?",
    "brightwave?",
    "open brightwave",
    "reload it",
    "try again",
    "it",
    "5",
    "the brightwave dot co site please now",
    "",
  ])("reads %j as no correction", (words) => {
    expect(correctedName(words)).toBeNull();
  });

  it("knows what the last request opened, and corrects only a request that opened something", () => {
    expect(openedTarget("Open Bright5.co")).toBe("bright5.co");
    expect(openedTarget("open bright5.co in Chrome")).toBe("bright5.co");
    expect(openedTarget("Open Ledgerly in Safari")).toBe("Ledgerly");
    expect(openedTarget("go to the brightwave site")).toBe("brightwave site");
    expect(
      openedTarget("Open brightwave (the owner corrected bright5.co)"),
    ).toBe("brightwave");
    expect(openedTarget("search running shoes")).toBe("");
    expect(openedTarget("reply to Sam on Slack")).toBe("");
    expect(correctionRequest("brightwave bro", "Open Bright5.co")).toBe(
      "Open brightwave (the owner corrected bright5.co)",
    );
    expect(correctionRequest("brightwave bro", "search running shoes")).toBe(
      null,
    );
    // The same name again is no correction.
    expect(correctionRequest("bright5.co", "Open Bright5.co")).toBeNull();
  });
});

/** A Mac with a computer engine that records what it got. */
function mac(sessions: string[] = []) {
  const events: string[] = [];
  const clock = { now: Date.now() };
  const state: DesktopExecutionSnapshot = {
    configured: true,
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Nothing runs.",
  };
  const desk = new DecisionDesk(folder());
  const world: SupervisorWorld = {
    now: () => clock.now,
    board: () =>
      ({
        sessions: sessions.map((name) => ({ name }) as unknown as AgentSession),
      }) as unknown as ReturnType<SupervisorWorld["board"]>,
    desk,
    focus: async () => ({ ok: false }),
    send: async () => ({ ok: false, route: "none" }),
    clis: () => [],
    execution: {
      snapshot: () => state,
      submit: async (_id: string, text: string) => {
        events.push(`engine: ${text}`);
        return { message: "Opening it." };
      },
      submitRead: async (_id: string, text: string) => {
        events.push(`engine: ${text}`);
        return { message: "Opening it." };
      },
      stop: () => state,
      answer: async () => ({ message: "No question waits." }),
    },
  };
  return { world, events, state, clock };
}
/**
 * A model that hands a request to open something to the computer engine, as
 * the chat's model does, answers every other turn with the same words, and
 * keeps the words of each turn that it read.
 */
const model = (text = "Okay.") => {
  const calls: string[] = [];
  const client: ModelClient = {
    async complete(input) {
      const last = input.messages.at(-1);
      const said = String(last?.content ?? "");
      calls.push(said);
      if (last?.role === "user" && /^open\b/i.test(said))
        return {
          text: "",
          toolCalls: [
            { id: "c1", name: "delegate_computer_task", arguments: "{}" },
          ],
        };
      return { text, toolCalls: [] };
    },
  };
  return { client, calls };
};

describe("a short name right after a computer request", () => {
  it("starts a new request that opens the name and says what it corrects", async () => {
    const f = mac();
    const run = model();
    const supervisor = new Supervisor(f.world, run.client);
    await supervisor.reply([], "open bright5.co", "chat");
    expect(f.events).toEqual(["engine: open bright5.co"]);
    supervisor.computerEnded(f.clock.now);
    f.clock.now += 60_000;
    const asked = run.calls.length;
    expect(await supervisor.reply([], "brightwave bro", "chat")).toBe(
      "Opening it.",
    );
    expect(f.events.at(-1)).toBe(
      "engine: Open brightwave (the owner corrected bright5.co)",
    );
    // The code started it: the model was not asked.
    expect(run.calls).toHaveLength(asked);
    // A second correction reads the name of the first one.
    supervisor.computerEnded(f.clock.now);
    await supervisor.reply([], "brightwave.co", "chat");
    expect(f.events.at(-1)).toBe(
      "engine: Open brightwave.co (the owner corrected brightwave)",
    );
  });

  it("is no correction after a few minutes, before the end, while a task runs, or after a request that opened nothing", async () => {
    const late = mac();
    const lateSupervisor = new Supervisor(late.world, model().client);
    await lateSupervisor.reply([], "open bright5.co", "chat");
    lateSupervisor.computerEnded(late.clock.now);
    late.clock.now += correctionMs + 1;
    await lateSupervisor.reply([], "brightwave bro", "chat");
    expect(late.events).toEqual(["engine: open bright5.co"]);

    const early = mac();
    const earlySupervisor = new Supervisor(early.world, model().client);
    await earlySupervisor.reply([], "open bright5.co", "chat");
    // No result was heard yet.
    await earlySupervisor.reply([], "brightwave bro", "chat");
    expect(early.events).toEqual(["engine: open bright5.co"]);

    const busy = mac();
    const busySupervisor = new Supervisor(busy.world, model().client);
    await busySupervisor.reply([], "open bright5.co", "chat");
    busySupervisor.computerEnded(busy.clock.now);
    busy.state.state = "running";
    busy.state.canStop = true;
    await busySupervisor.reply([], "brightwave bro", "chat");
    expect(busy.events.filter((event) => event.includes("corrected"))).toEqual(
      [],
    );

    const search = mac();
    const searchSupervisor = new Supervisor(search.world, model().client);
    await searchSupervisor.reply([], "search running shoes", "chat");
    searchSupervisor.computerEnded(search.clock.now);
    await searchSupervisor.reply([], "brightwave bro", "chat");
    expect(
      search.events.filter((event) => event.includes("corrected")),
    ).toEqual([]);
  });

  it("leaves a stop, a thanks, a question and the name of a session to the chat", async () => {
    for (const words of ["stop", "thanks bro", "brightwave?", "docs"]) {
      const f = mac(["docs"]);
      const run = model();
      const supervisor = new Supervisor(f.world, run.client);
      await supervisor.reply([], "open bright5.co", "chat");
      supervisor.computerEnded(f.clock.now);
      await supervisor.reply([], words, "chat");
      expect([
        words,
        f.events.filter((event) => event.includes("corrected")),
      ]).toEqual([words, []]);
    }
  });

  it("is dropped with a new chat", async () => {
    const f = mac();
    const supervisor = new Supervisor(f.world, model().client);
    await supervisor.reply([], "open bright5.co", "chat");
    supervisor.computerEnded(f.clock.now);
    supervisor.newConversation();
    await supervisor.reply([], "brightwave bro", "chat");
    expect(f.events).toEqual(["engine: open bright5.co"]);
  });
});

describe("the owner's sequence on the worker", () => {
  it("an address that did not load, a no, then the right name: the name opens as a new request", async () => {
    const root = folder();
    const unreachable = observation(
      [
        element(1, {
          role: "AXStaticText",
          title: "This site can’t be reached",
        }),
      ],
      {
        app: {
          name: "Google Chrome",
          bundleId: "com.google.Chrome",
          window: "bright5.co",
        },
      },
    );
    const hands = new FakeHands([unreachable]);
    const shows =
      "Opened bright5.co in Chrome. The page shows a network error.";
    const planner = new ScriptedPlanner([
      { kind: "done", summary: shows },
      { kind: "done", summary: shows },
      { kind: "done", summary: "Brightwave is open." },
    ]);
    let feed: BoardFeed | undefined;
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(root),
      notify: (text) => feed?.appendExecutionResult(text),
    });
    const run = model("Okay.");
    feed = new BoardFeed({
      root,
      model: run.client,
      speech: null,
      execution: worker,
    });
    await feed.say("open bright5.co");
    await worker.idle();
    await until(() =>
      feed!.chat().messages.some((message) => message.text.startsWith("Done.")),
    );
    // The done on the error page went back once before it was taken.
    expect(planner.inputs[1]!.history.at(-1)!.outcome).toMatch(
      /^not taken yet: the page did not load/,
    );
    await feed.say("no");
    const reply = await feed.say("brightwave bro");
    await worker.idle();
    expect(planner.inputs.at(-1)!.goal).toBe(
      "Open brightwave (the owner corrected bright5.co)",
    );
    expect(reply.text).not.toMatch(/I have not done that/);
    feed.close();
  });
});
