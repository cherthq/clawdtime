import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Memory, memoryDirectory } from "../connectors/agents/memory.js";
import {
  ComputerJournal,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import type { Action, Observation } from "../connectors/computer/ports.js";
import {
  computerMemory,
  lessonNotes,
  type ComputerMemory,
  type Lesson,
} from "../connectors/computer/remembered.js";
import { buildComputer } from "../connectors/computer/service.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

/**
 * Computer use with the person's memory. Everything runs on made-up hands and
 * a scripted planner in a fresh state folder: no model, no screen, no input.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-memory-"));
  roots.push(path);
  return path;
};
/** A state folder whose memory is on or off. */
const memoryOf = (on: boolean) => {
  const root = home();
  const memory = new Memory(root);
  memory.setEnabled(on);
  return { root, memory };
};
const current = (memory: Memory) =>
  memory.facts().filter((fact) => fact.current);
const factsFile = (root: string) => join(memoryDirectory(root), "facts.json");

const shop = observation([
  element(1, { title: "Search", role: "AXTextField" }),
]);
const done: Action = { kind: "done", summary: "A black case for 499 shows." };
const shopSite: Action = {
  kind: "open_url",
  url: "https://www.shop.example/search?q=phone+case",
};

function setup(
  script: ConstructorParameters<typeof ScriptedPlanner>[0],
  memory?: ComputerMemory,
  screens: Observation[] = [shop],
) {
  const root = home();
  const hands = new FakeHands(screens);
  const planner = new ScriptedPlanner(script);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal: new ComputerJournal(root),
    settleMs: 1,
    transientMs: 1,
    ...(memory ? { memory } : {}),
  });
  const waiting = () =>
    until(() => worker.snapshot().state === "waiting_for_person");
  return { hands, planner, worker, waiting };
}

describe("notes from memory before a computer request", () => {
  it("gives the planner at most 5 notes that fit the goal, only while memory is on", async () => {
    const { memory } = memoryOf(true);
    for (const text of [
      "Shop for a phone case on shop.example, not social.example.",
      "A phone case should be black.",
      "Pay for a phone case with the work card on file.",
      "A phone case is for an iPhone 15.",
      "A phone case order goes to the office address.",
      "Phone case links go to the chat, not by email.",
      "A phone case under 500 rupees is fine.",
      "The garden needs water on Fridays.",
    ])
      memory.remember({ text, kind: "preference" });
    const on = setup([done], computerMemory(memory));
    await on.worker.submit("r1", "Find a phone case");
    await on.worker.idle();
    const notes = on.planner.inputs[0]!.remembered!;
    expect(notes).toHaveLength(5);
    expect(notes.every((note) => /phone case/i.test(note))).toBe(true);
    expect(notes.every((note) => note.length <= 300)).toBe(true);
    expect(notes.join(" ")).not.toMatch(/garden/);

    // The same memory, turned off: nothing is read.
    memory.setEnabled(false);
    const off = setup([done], computerMemory(memory));
    await off.worker.submit("r1", "Find a phone case");
    await off.worker.idle();
    expect(off.planner.inputs[0]).not.toHaveProperty("remembered");
  });

  it("runs as before with no memory, and with a memory that fails", async () => {
    const without = setup([done]);
    await without.worker.submit("r1", "Find a phone case");
    await without.worker.idle();
    expect(without.planner.inputs[0]).not.toHaveProperty("remembered");
    expect(without.worker.snapshot().state).toBe("completed");

    const broken: ComputerMemory = {
      on: () => true,
      recall: () => {
        throw new Error("The memory file is damaged.");
      },
      learn: () => {
        throw new Error("The memory file is damaged.");
      },
    };
    const failing = setup([done], broken);
    await failing.worker.submit("r1", "Find a phone case");
    await failing.worker.idle();
    expect(failing.planner.inputs[0]).not.toHaveProperty("remembered");
    expect(failing.worker.snapshot()).toMatchObject({
      state: "completed",
      message: "Done. A black case for 499 shows.",
    });
  });

  it("never gives the planner a note that holds a secret", () => {
    const { memory } = memoryOf(true);
    // The loose check of memory lets a short pin through; the strict check of computer use does not.
    memory.remember({ text: "My phone pin is 4821." });
    memory.remember({ text: "A phone case should be black." });
    expect(computerMemory(memory).recall("phone case")).toEqual([
      "A phone case should be black.",
    ]);
  });
});

describe("what a computer request teaches memory", () => {
  it("keeps the owner's correction and the outcome, with the goal as context", async () => {
    const { root, memory } = memoryOf(true);
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    const run = setup([shopSite, done], computerMemory(memory));
    // The first look waits, and the owner corrects the request meanwhile.
    run.hands.answer = async (command) => {
      if (command.kind === "observe") await gate;
      return {};
    };
    await run.worker.submit("r1", "Find a phone case on shop.example");
    // The correction steers the task, and the task goes on by itself.
    await run.worker.submit("r2", "not social.example, shop.example");
    release();
    await run.worker.idle();
    expect(run.planner.inputs[0]).toMatchObject({
      guidance: ["not social.example, shop.example"],
    });
    expect(run.worker.snapshot().state).toBe("completed");
    expect(current(memory)).toMatchObject([
      {
        text: 'For the request "Find a phone case on shop.example", the owner said: not social.example, shop.example.',
        kind: "preference",
        source: "said",
      },
      {
        text: 'Opened shop.example for the request "Find a phone case on shop.example". It was done.',
        kind: "episode",
        source: "inferred",
      },
    ]);
    // What the planner said and what the page showed are not kept.
    // A word boundary: the digits of a time in the file are not the price.
    expect(readFileSync(factsFile(root), "utf8")).not.toMatch(/\b499\b|black/);

    // The next request reads what this one taught.
    const next = setup([done], computerMemory(memory));
    await next.worker.submit("r3", "Order a phone case");
    await next.worker.idle();
    expect(next.planner.inputs[0]!.remembered).toEqual(
      expect.arrayContaining([
        'For the request "Find a phone case on shop.example", the owner said: not social.example, shop.example.',
      ]),
    );
  });

  it("keeps the owner's answer to a question of the task, and no typed text", async () => {
    const { root, memory } = memoryOf(true);
    const run = setup(
      [
        { kind: "ask", question: "Which email should I use for the sign up?" },
        {
          kind: "type",
          text: "case for my iphone fifteen pro max",
          element: 1,
        },
        done,
      ],
      computerMemory(memory),
    );
    await run.worker.submit("r1", "Sign up for the phone shop newsletter");
    await run.waiting();
    expect((await run.worker.answer("use my work email")).message).toBe(
      "Thank you. The task continues.",
    );
    await run.worker.idle();
    expect(run.hands.sent.map((command) => command.kind)).toContain("type");
    expect(current(memory).map((fact) => fact.text)).toEqual([
      'For the request "Sign up for the phone shop newsletter", the owner said: use my work email.',
      'Worked on the request "Sign up for the phone shop newsletter". It was done.',
    ]);
    const kept = readFileSync(factsFile(root), "utf8");
    expect(kept).not.toMatch(/fifteen|Which email|\b499\b/);
  });

  it("keeps nothing while memory is off", async () => {
    const { root, memory } = memoryOf(false);
    const run = setup(
      [{ kind: "ask", question: "Which site should I use?" }, shopSite, done],
      computerMemory(memory),
    );
    await run.worker.submit("r1", "Find a phone case on shop.example");
    await run.waiting();
    await run.worker.answer("shop, never instagram");
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(existsSync(factsFile(root))).toBe(false);
    expect(memory.facts()).toEqual([]);
  });

  it("never writes a note that holds a secret", async () => {
    const { root, memory } = memoryOf(true);
    const run = setup(
      [
        { kind: "ask", question: "What should I type in the code field?" },
        done,
      ],
      computerMemory(memory),
    );
    await run.worker.submit("r1", "Log in to the phone shop");
    await run.waiting();
    // The worker refuses a credential as an answer: it is never taught.
    expect((await run.worker.answer("the password is hunter22")).message).toBe(
      "I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself.",
    );
    await run.worker.answer("ask me again later, I am away");
    await run.worker.idle();
    const kept = existsSync(factsFile(root))
      ? readFileSync(factsFile(root), "utf8")
      : "";
    expect(kept).not.toMatch(/hunter22/);

    // The notes themselves: a secret in the words or in the goal keeps nothing of it.
    const lesson = (values: Partial<Lesson>): Lesson => ({
      goal: "Log in to the phone shop",
      said: [],
      state: "completed",
      reason: "done",
      history: [],
      ...values,
    });
    for (const said of [
      "the password is hunter22",
      "my pin is 4821",
      "4821",
      "use the token sk-live1234567890abcdefgh",
      "type my pin yourself",
    ])
      expect(lessonNotes(lesson({ said: [said] }))).toEqual([]);
    expect(
      lessonNotes(
        lesson({
          goal: "Log in with password hunter22!",
          said: ["use shop"],
          history: [{ step: 1, action: shopSite, why: "", outcome: "ok" }],
        }),
      ),
    ).toEqual([]);
    // Memory refuses a credential too, as the last line of defence.
    expect(() =>
      memory.remember({ text: "token: sk-abcdefghijklmnop1234" }),
    ).toThrow(/credential/);
  });

  it("keeps at most 3 notes for one request, the newest words first, and no filler", () => {
    const notes = lessonNotes({
      goal: "Find a phone case",
      said: [
        "ok",
        "wait a second",
        "not instagram",
        "use shop",
        "black only",
        "yes go ahead",
        "under 500 rupees",
      ],
      state: "completed",
      reason: "done",
      history: [
        { step: 1, action: shopSite, why: "", outcome: "ok" },
        {
          step: 2,
          action: { kind: "open_app", name: "Safari" },
          why: "",
          outcome: "ok",
        },
        {
          step: 3,
          action: { kind: "open_url", url: "https://instagram.com/" },
          why: "",
          outcome: "did not run: failed",
        },
      ],
    });
    expect(notes.map((note) => note.text)).toEqual([
      'For the request "Find a phone case", the owner said: black only.',
      'For the request "Find a phone case", the owner said: under 500 rupees.',
      'Opened shop.example and Safari for the request "Find a phone case". It was done.',
    ]);
    // A one-step move to a desktop or an app, and a request with no step, keep no outcome.
    const plain = {
      goal: "Open Safari",
      said: [],
      state: "completed" as const,
    };
    expect(
      lessonNotes({ ...plain, reason: "desktop_switched", history: [] }),
    ).toEqual([]);
    expect(lessonNotes({ ...plain, reason: "done", history: [] })).toEqual([]);
    expect(
      lessonNotes({
        goal: "Find a phone case",
        said: [],
        state: "blocked",
        reason: "time_limit",
        history: [{ step: 1, action: done, why: "", outcome: "ok" }],
      }).map((note) => note.text),
    ).toEqual([
      'Worked on the request "Find a phone case". It did not finish.',
    ]);
  });
});

describe("the service", () => {
  /** Serves the commands of the hands through the port, as the panel does. */
  async function serve(
    built: ReturnType<typeof buildComputer>,
    screen: Observation,
  ) {
    let last = 0;
    for (
      let turn = 0;
      turn < 400 && built.worker!.snapshot().state === "running";
      turn++
    ) {
      const { command } = built.port.next(last);
      if (!command) {
        await new Promise((go) => setTimeout(go, 2));
        continue;
      }
      last = command.seq;
      built.port.result({
        seq: command.seq,
        ok: true,
        ...(command.command.kind === "observe"
          ? {
              observation: command.command.image
                ? screen
                : {
                    ...screen,
                    image: undefined,
                    imageWidth: undefined,
                    imageHeight: undefined,
                  },
            }
          : {}),
      });
    }
    await built.worker!.idle();
  }
  const withKey = { CLAWDTIME_OPENAI_API_KEY: "test-key-that-is-never-sent" };

  it("feeds the worker from the memory of its state folder, behind the memory's switch", async () => {
    const { root, memory } = memoryOf(true);
    setComputerSwitch(root, true);
    memory.remember({
      text: "Shop for a phone case on shop.example, not social.example.",
      kind: "preference",
    });
    const planner = new ScriptedPlanner([done]);
    const built = buildComputer({ root, env: withKey, planner, memory });
    await built.worker!.submit("r1", "Find a phone case");
    await serve(built, shop);
    expect(planner.inputs[0]!.remembered).toEqual([
      "Shop for a phone case on shop.example, not social.example.",
    ]);
    expect(built.worker!.snapshot().state).toBe("completed");
    expect(current(memory).map((fact) => fact.text)).toContain(
      'Worked on the request "Find a phone case". It was done.',
    );

    // A service with no memory store reads and keeps nothing.
    const bare = home();
    setComputerSwitch(bare, true);
    const alone = new ScriptedPlanner([done]);
    const plain = buildComputer({ root: bare, env: withKey, planner: alone });
    await plain.worker!.submit("r1", "Find a phone case");
    await serve(plain, shop);
    expect(alone.inputs[0]).not.toHaveProperty("remembered");
    expect(existsSync(memoryDirectory(bare))).toBe(false);
  });
});
