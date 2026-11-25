import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import {
  readMidTask,
  type MidTaskKind,
} from "../connectors/computer/orders.js";
import type { Action, Planner } from "../connectors/computer/ports.js";
import { ComputerWorker, stoppedText } from "../connectors/computer/worker.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
  until,
} from "./connectors-computer-fixture.js";

/**
 * The worker goes on by itself. While a task runs, every message that is not
 * a stop steers it, and the task keeps going. Only a plain request to pause
 * pauses, any next message ends that pause, and a stop always stops. Words
 * that hold a secret are never kept, and pause nothing.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const taken = "Got it. I take that into the task that runs.";
const resumed = "Got it. I go on with the task and take that into it.";
const paused = "Paused. Your next message goes on with it.";
const stillPaused = "Still paused. Your next message goes on with it.";
const goingOn = "I go on with the task.";
const secretLead = "I do not take a password or a key in the chat.";
const wait: Action = { kind: "wait", ms: 0 };
const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "The note is saved." };
const save = observation([element(1, { title: "Save" })]);

/** Words that tell the person to say a magic word to go on. None may be said. */
const magicWord =
  /\bsay (?:continue|stop)\b|\bcontinue to go on\b|\bor stop\b/i;

function worker(
  script: ConstructorParameters<typeof ScriptedPlanner>[0],
  options: {
    trust?: boolean;
    resumeMs?: number;
    maxSteps?: number;
    screens?: ReturnType<typeof observation>[];
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-autonomy-"));
  roots.push(home);
  const clock = { now: 1_000_000 };
  const hands = new FakeHands(options.screens ?? [save]);
  const planner = new ScriptedPlanner(script);
  const journal = new ComputerJournal(home, () => clock.now);
  const said: string[] = [];
  const run = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: (text) => said.push(text),
    settleMs: 1,
    transientMs: 1,
    ...(options.trust ? { trust: true } : {}),
    ...(options.resumeMs !== undefined ? { resumeMs: options.resumeMs } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
  });
  const waiting = () =>
    until(() => run.snapshot().state === "waiting_for_person");
  return { home, clock, hands, planner, journal, said, worker: run, waiting };
}

/**
 * A task at step 1 whose planner is choosing its second action, until the
 * test lets it go on. Then it waits once and is done.
 */
async function running(
  options: Parameters<typeof worker>[1] = {},
  extra: Action[] = [],
) {
  let release = () => {};
  const gate = new Promise<void>((open) => (release = open));
  const made = worker(
    [
      wait,
      async () => {
        await gate;
        return wait;
      },
      ...extra,
      done,
    ],
    options,
  );
  await made.worker.submit("r1", "Open the editor");
  await until(() => made.planner.inputs.length === 2);
  return { ...made, release };
}

/** A task paused at the person's word, before any input. */
async function pausedTask(options: Parameters<typeof worker>[1] = {}) {
  const made = await running(options);
  expect((await made.worker.submit("p0", "wait")).message).toMatch(/^Paused\./);
  await until(() => made.worker.snapshot().waiting === "takeover");
  made.release();
  return made;
}

type Effect = "steer" | "stop" | "pause" | "status" | "go" | "secret";

/** Mid-task messages and what each one does to the task. */
const table: Array<[string, Effect]> = [
  // Steer: the words go into the task, and it keeps going.
  ["Open shop.example, not social.example.", "steer"],
  ["not social.example, shop.example", "steer"],
  ["no, the other one", "steer"],
  ["hmm try the search box", "steer"],
  ["that's wrong, go back", "steer"],
  ["no", "steer"],
  ["don't click that", "steer"],
  ["wait, not that one, the blue one", "steer"],
  ["why did you open instagram?", "steer"],
  ["is that the right page?", "steer"],
  ["use the cheaper one instead", "steer"],
  ["the page looks weird", "steer"],
  ["add it to the cart", "steer"],
  ["do it later", "steer"],
  ["nah, try amazon.in", "steer"],
  ["wait for the page to load", "steer"],
  ["pause the video", "steer"],
  ["let me know when it is done", "steer"],
  ["can you continue?", "steer"],
  ["open it in a new tab please", "steer"],
  // Stop: at once, also with a typo, a lookalike letter or a stop sign.
  ["stop", "stop"],
  ["stpo", "stop"],
  ["stоp", "stop"],
  ["ok stop", "stop"],
  ["wait, stop", "stop"],
  ["no stop, that is wrong", "stop"],
  ["cancel it", "stop"],
  ["\u{1F6D1}", "stop"],
  // Pause: a plain request to wait, or to let the person do it.
  ["wait", "pause"],
  ["hold on", "pause"],
  ["pause", "pause"],
  ["one sec", "pause"],
  ["give me a minute", "pause"],
  ["let me do it", "pause"],
  ["I'll take it from here", "pause"],
  ["hang on, I'm checking something", "pause"],
  ["not yet", "pause"],
  ["brb", "pause"],
  ["✋", "pause"],
  // Status: a short answer, and nothing changes.
  ["are you done?", "status"],
  ["what are you doing?", "status"],
  ["how's it going?", "status"],
  ["r u stuck?", "status"],
  ["done yet?", "status"],
  // Go: nothing to steer with, and the task goes on.
  ["continue", "go"],
  ["ok", "go"],
  ["thanks \u{1F44D}", "go"],
  // A secret: never kept, never sent to the planner, and no pause.
  ["my password is swordfish", "secret"],
  ["type hunter22 in the password field", "secret"],
  ["my pin number is 4821", "secret"],
];

describe("autonomy: the reader of words while a task runs", () => {
  it("has a table of at least 40 messages", () => {
    expect(table.length).toBeGreaterThanOrEqual(40);
  });

  it.each(table.filter(([, effect]) => effect !== "secret"))(
    "reads %j as %s",
    (words, effect) => {
      expect(readMidTask(words)).toBe(effect as MidTaskKind);
    },
  );
});

describe("autonomy: each message while a task runs", () => {
  it.each(table)("%j: %s", async (words, effect) => {
    const run = await running();
    const reply = (await run.worker.submit("g1", words)).message;
    expect(reply).not.toMatch(magicWord);
    const secret = words.match(/swordfish|hunter22|4821/)?.[0];
    switch (effect) {
      case "steer": {
        expect(reply).toBe(taken);
        expect(run.journal.guidance("r1")).toMatchObject([
          { id: "g1", text: words },
        ]);
        run.release();
        await run.worker.idle();
        // It went on with the words, and never paused.
        expect(run.worker.snapshot().state).toBe("completed");
        expect(run.planner.inputs[2]).toMatchObject({ guidance: [words] });
        expect(run.said.join(" ")).not.toMatch(/Paused/);
        break;
      }
      case "stop": {
        expect(reply).toBe(stoppedText);
        run.release();
        await run.worker.idle();
        expect(run.worker.snapshot().state).toBe("canceled");
        expect(run.hands.sent).toEqual([]);
        expect(run.planner.inputs).toHaveLength(2);
        break;
      }
      case "pause": {
        expect(reply).toBe(paused);
        await until(() => run.worker.snapshot().waiting === "takeover");
        run.release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(run.worker.snapshot()).toMatchObject({
          state: "waiting_for_person",
          message: paused,
        });
        // A request to pause carries nothing for the planner.
        expect(run.journal.guidance("r1")).toEqual([]);
        expect(run.planner.inputs).toHaveLength(2);
        run.worker.stop();
        await run.worker.idle();
        break;
      }
      case "status": {
        expect(reply).toBe(
          'Still working on "Open the editor", at step 1, and it is not done yet.',
        );
        expect(run.journal.guidance("r1")).toEqual([]);
        run.release();
        await run.worker.idle();
        expect(run.worker.snapshot().state).toBe("completed");
        expect(run.planner.inputs[2]).not.toHaveProperty("guidance");
        break;
      }
      case "go": {
        expect(reply).toBe(goingOn);
        expect(run.journal.guidance("r1")).toEqual([]);
        run.release();
        await run.worker.idle();
        expect(run.worker.snapshot().state).toBe("completed");
        break;
      }
      case "secret": {
        expect(reply).toBe(
          `${secretLead} I did not keep that: type it into the field on the Mac yourself. ${goingOn}`,
        );
        run.release();
        await run.worker.idle();
        // No pause, and the words are nowhere.
        expect(run.worker.snapshot().state).toBe("completed");
        expect(run.journal.guidance("r1")).toEqual([]);
        expect(readFileSync(run.journal.guidanceFile, "utf8")).not.toContain(
          secret!,
        );
        const heard = run.planner.inputs.flatMap(
          (input) => input.guidance ?? [],
        );
        expect(heard.join(" ")).not.toContain(secret!);
        break;
      }
    }
  });
});

describe("autonomy: any next message ends a pause", () => {
  it.each([
    ["open shop.example instead", resumed, ["open shop.example instead"]],
    ["hmm", resumed, ["hmm"]],
    ["no, the other one", resumed, ["no, the other one"]],
    ["continue", "Continuing.", []],
    ["ok", "Continuing.", []],
    ["are you done?", 'I go on with "Open the editor" now, from step 1.', []],
  ] as const)(
    "goes on after %j, with no magic word",
    async (words, reply, guidance) => {
      const run = await pausedTask();
      expect((await run.worker.submit("n1", words)).message).toBe(reply);
      await run.worker.idle();
      expect(run.worker.snapshot().state).toBe("completed");
      const last = run.planner.inputs.at(-1)!;
      if (guidance.length) expect(last).toMatchObject({ guidance });
      else expect(last).not.toHaveProperty("guidance");
    },
  );

  it("goes on after the chat's answer too: the words go into the task", async () => {
    const run = await pausedTask();
    expect((await run.worker.answer("use the blue one")).message).toBe(resumed);
    await run.worker.idle();
    expect(run.planner.inputs.at(-1)).toMatchObject({
      guidance: ["use the blue one"],
    });
    expect(run.journal.guidance("r1")).toMatchObject([
      { text: "use the blue one" },
    ]);
  });

  it("goes on after any message when the person took over the Mac", async () => {
    const run = worker([click, click, done]);
    let clicks = 0;
    run.hands.answer = (command) =>
      command.kind === "click" && clicks++ === 0
        ? { interrupted: true }
        : undefined;
    await run.worker.submit("r1", "Click it");
    await run.waiting();
    expect(run.worker.snapshot()).toMatchObject({ waiting: "takeover" });
    expect(run.worker.snapshot().message).not.toMatch(magicWord);
    expect(
      (await run.worker.submit("n1", "try the other button")).message,
    ).toBe(resumed);
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.hands.sent).toHaveLength(2);
  });

  it("stays paused on another wait or on a secret, and stops on a stop", async () => {
    const run = await pausedTask();
    expect((await run.worker.submit("n1", "hold on")).message).toBe(
      stillPaused,
    );
    expect((await run.worker.submit("n2", "my pin is 4821")).message).toBe(
      `${secretLead} I did not keep that: type it into the field on the Mac yourself. ${stillPaused}`,
    );
    expect(run.worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      waiting: "takeover",
    });
    expect(run.journal.guidance("r1")).toEqual([]);
    expect((await run.worker.submit("n3", "stop")).message).toBe(stoppedText);
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toEqual([]);
  });
});

describe("autonomy: a pause ends by itself only with the owner's trust", () => {
  it("goes on by itself after the bounded time with trust, read on the injected clock", async () => {
    const run = await pausedTask({ trust: true, resumeMs: 60_000 });
    expect(run.worker.snapshot().message).toBe(
      `${paused} With no message, I go on by myself in 60 seconds.`,
    );
    run.clock.now += 59_999;
    expect(run.worker.status().state).toBe("waiting_for_person");
    run.clock.now += 1;
    expect(run.worker.status().state).toBe("running");
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.said).toContain(
      "No message came in 60 seconds, so I go on with the task.",
    );
    expect(run.hands.sent).toEqual([]);
  });

  it("waits with no trust, however long the clock runs within the time limit", async () => {
    const run = await pausedTask({ resumeMs: 60_000 });
    expect(run.worker.snapshot().message).toBe(paused);
    run.clock.now += 14 * 60_000;
    expect(run.worker.status().state).toBe("waiting_for_person");
    expect(run.worker.snapshot().waiting).toBe("takeover");
    run.worker.stop();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
  });

  it("lets the timer end the pause only when the clock says the time is up", async () => {
    const run = await pausedTask({ trust: true, resumeMs: 20 });
    // The clock stands still: the timer fires and looks again, and waits.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(run.worker.snapshot().state).toBe("waiting_for_person");
    run.clock.now += 20;
    // No read of the status: the timer alone ends the pause now.
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
  });

  it("goes on by itself after a takeover too, with trust", async () => {
    const run = worker([click, click, done], { trust: true, resumeMs: 1000 });
    let clicks = 0;
    run.hands.answer = (command) =>
      command.kind === "click" && clicks++ === 0
        ? { interrupted: true }
        : undefined;
    await run.worker.submit("r1", "Click it");
    await run.waiting();
    run.clock.now += 1000;
    run.worker.status();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.hands.sent).toHaveLength(2);
  });
});

describe("autonomy: stop stops at once in every state", () => {
  const stops = async (
    made: { worker: ComputerWorker; hands: FakeHands },
    words = "stop",
  ) => {
    expect((await made.worker.submit("s1", words)).message).toBe(stoppedText);
  };

  it("while the planner chooses", async () => {
    const run = await running();
    await stops(run);
    run.release();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toEqual([]);
  });

  it("while the request is read as a move or not", async () => {
    const run = worker([click, done]);
    let read = (_intent: { kind: "none" }) => {};
    (run.planner as Planner).navigation = () =>
      new Promise((resolve) => (read = resolve));
    await run.worker.submit("r1", "Click Save");
    await stops(run, "stpo");
    read({ kind: "none" });
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toEqual([]);
  });

  it("during the first look", async () => {
    const run = worker([click, done]);
    let look = () => {};
    const seen = new Promise<void>((open) => (look = open));
    run.hands.answer = async () => {
      await seen;
      return {};
    };
    await run.worker.submit("r1", "Click Save");
    await stops(run, "pls stop");
    look();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toEqual([]);
  });

  it("while an input is with the hands: nothing follows it", async () => {
    const run = worker([click, click, done]);
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    run.hands.answer = async (command) => {
      if (command.kind === "click") await gate;
      return {};
    };
    await run.worker.submit("r1", "Click Save");
    await until(() => run.hands.sent.length === 1);
    await stops(run, "ok stop");
    release();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toHaveLength(1);
  });

  it("at a pause on words", async () => {
    const run = await pausedTask();
    await stops(run, "cancel it");
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
  });

  it("at a pause after a takeover", async () => {
    const run = worker([click, click, done]);
    run.hands.answer = (command) =>
      command.kind === "click" ? { interrupted: true } : undefined;
    await run.worker.submit("r1", "Click it");
    await run.waiting();
    await stops(run, "stоp");
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toHaveLength(1);
  });

  it("at a question that waits for a yes", async () => {
    const run = worker([click, done], {
      screens: [observation([element(1, { title: "Send" })])],
    });
    await run.worker.submit("r1", "Finish the draft");
    await run.waiting();
    expect(run.worker.snapshot().waiting).toBe("approval");
    await stops(run, "no stop");
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toEqual([]);
  });

  it("at a question of the planner", async () => {
    const run = worker([{ kind: "ask", question: "Which row?" }, click, done]);
    await run.worker.submit("r1", "Pick a row");
    await run.waiting();
    await stops(run, "actually stop");
    expect(run.worker.snapshot().state).toBe("canceled");
    expect(run.hands.sent).toEqual([]);
  });

  it("at the cap of additions, with an unwritable record, with a secret, and at the step limit", async () => {
    const capped = await running();
    for (let n = 1; n <= 8; n++)
      expect(
        (await capped.worker.submit(`g${n}`, `Open tab ${n}`)).message,
      ).toBe(taken);
    await stops(capped);
    capped.release();
    await capped.worker.idle();
    expect(capped.worker.snapshot().state).toBe("canceled");

    const broken = await running();
    mkdirSync(dirname(broken.journal.guidanceFile), { recursive: true });
    writeFileSync(broken.journal.guidanceFile, "not json");
    await stops(broken);
    broken.release();
    await broken.worker.idle();
    expect(broken.worker.snapshot().state).toBe("canceled");

    const secret = await running();
    await stops(secret, "stop, my password is swordfish");
    secret.release();
    await secret.worker.idle();
    expect(secret.worker.snapshot().state).toBe("canceled");
    expect(readFileSync(secret.journal.guidanceFile, "utf8")).not.toContain(
      "swordfish",
    );

    const atLimit = await running({ maxSteps: 2 });
    atLimit.release();
    await until(() => atLimit.planner.inputs.length >= 2);
    await stops(atLimit);
    await atLimit.worker.idle();
    expect(atLimit.worker.snapshot().state).toBe("canceled");
  });
});

describe("autonomy: secrets are never kept, in any state", () => {
  const secrets = [
    ["my password is swordfish", "swordfish"],
    ["type hunter22 in the password field", "hunter22"],
    ["my pin number is 4821", "4821"],
  ] as const;

  const nowhere = (
    made: { journal: ComputerJournal; planner: ScriptedPlanner },
    secret: string,
  ) => {
    expect(made.journal.guidance("r1")).toEqual([]);
    expect(readFileSync(made.journal.guidanceFile, "utf8")).not.toContain(
      secret,
    );
    const heard = made.planner.inputs.flatMap((input) => input.guidance ?? []);
    expect(heard.join(" ")).not.toContain(secret);
  };

  it.each(secrets)(
    "keeps %j out while running, at a pause and at a question",
    async (words, secret) => {
      const live = await running();
      expect((await live.worker.submit("s1", words)).message).toContain(
        secretLead,
      );
      live.release();
      await live.worker.idle();
      nowhere(live, secret);

      const still = await pausedTask();
      expect((await still.worker.submit("s1", words)).message).toContain(
        stillPaused,
      );
      expect(still.worker.snapshot().waiting).toBe("takeover");
      expect((await still.worker.answer(words)).message).toContain(secretLead);
      expect(still.worker.snapshot().waiting).toBe("takeover");
      nowhere(still, secret);
      still.worker.stop();
      await still.worker.idle();

      const asked = worker([{ kind: "ask", question: "Which row?" }, done]);
      await asked.worker.submit("r1", "Pick a row");
      await asked.waiting();
      const question = asked.worker.snapshot().message;
      expect((await asked.worker.submit("s1", words)).message).toBe(
        `${secretLead} I did not keep that: type it into the field on the Mac yourself. ${question}`,
      );
      expect(asked.worker.snapshot()).toMatchObject({
        waiting: "question",
        message: question,
      });
      nowhere(asked, secret);
      asked.worker.stop();
      await asked.worker.idle();
    },
  );
});

describe("autonomy: the chat hands the words to the task that runs", () => {
  /** The chat in front of a real worker, with no language model. */
  const chat = (run: ComputerWorker, home: string) =>
    new Supervisor(
      {
        now: () => 1_000_000,
        board: () => null,
        desk: new DecisionDesk(home, () => 1_000_000),
        focus: async () => ({ ok: false }),
        send: async () => ({ ok: false, route: "none" }),
        clis: () => [],
        execution: run,
      },
      null,
    );

  it("steers the task with the owner's correction, and the task goes on", async () => {
    const run = await running();
    const words = "Open shop.example, not social.example.";
    expect(await chat(run.worker, run.home).reply([], words, "chat")).toBe(
      taken,
    );
    run.release();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.planner.inputs[2]).toMatchObject({ guidance: [words] });
    expect(run.said.join(" ")).not.toMatch(/Paused/);
  });

  it.each([
    "not social.example, shop.example",
    "no, the other one",
    "hmm try the search box",
    "that's wrong, go back",
  ])("hands %j to the task: no message is swallowed", async (words) => {
    const run = await running();
    expect(await chat(run.worker, run.home).reply([], words, "chat")).toBe(
      taken,
    );
    run.release();
    await run.worker.idle();
    expect(run.planner.inputs[2]).toMatchObject({ guidance: [words] });
  });

  it("pauses on a wait, goes on with the next message, and stops on a stop", async () => {
    const run = await running();
    const talk = chat(run.worker, run.home);
    expect(await talk.reply([], "hold on", "chat")).toBe(paused);
    await until(() => run.worker.snapshot().waiting === "takeover");
    run.release();
    expect(
      await talk.reply([], "not social.example, shop.example", "chat"),
    ).toBe(resumed);
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.planner.inputs.at(-1)).toMatchObject({
      guidance: ["not social.example, shop.example"],
    });

    const again = await pausedTask();
    expect(await chat(again.worker, again.home).reply([], "stop", "chat")).toBe(
      stoppedText,
    );
    await again.worker.idle();
    expect(again.worker.snapshot().state).toBe("canceled");
  });

  it("answers a question from the state of the task, and keeps going", async () => {
    const run = await running();
    const said = await chat(run.worker, run.home).reply(
      [],
      "are you done?",
      "chat",
    );
    expect(said).toMatch(/still runs: it has not reported that it is done/);
    expect(run.journal.guidance("r1")).toEqual([]);
    expect(run.worker.snapshot().state).toBe("running");
    run.release();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
  });

  it("keeps a secret away from the task and the planner, and the task goes on", async () => {
    const run = await running();
    await chat(run.worker, run.home).reply(
      [],
      "the password is hunter22, type it in",
      "chat",
    );
    run.release();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(readFileSync(run.journal.guidanceFile, "utf8")).not.toContain(
      "hunter22",
    );
    const heard = run.planner.inputs.flatMap((input) => input.guidance ?? []);
    expect(heard.join(" ")).not.toContain("hunter22");
  });
});
