import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type {
  Action,
  HandCommand,
  Observation,
} from "../connectors/computer/ports.js";
import { ComputerWorker, stoppedText } from "../connectors/computer/worker.js";
import {
  element,
  FakeBrowser,
  FakeHands,
  observation,
  page,
  pageElement,
  ScriptedPlanner,
  terminalApp,
  until,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const save = observation([element(1, { title: "Save" })]);
type Script = ConstructorParameters<typeof ScriptedPlanner>[0];

function setup(
  script: Script,
  options: {
    screens?: Observation[];
    browser?: FakeBrowser;
    maxSteps?: number;
    maxMs?: number;
    home?: string;
    enabled?: () => boolean;
  } = {},
) {
  const home =
    options.home ?? mkdtempSync(join(tmpdir(), "clawdtime-computer-worker-"));
  if (!options.home) roots.push(home);
  const clock = { now: 1_000_000 };
  const hands = new FakeHands(options.screens ?? [save]);
  const planner = new ScriptedPlanner(script);
  const said: string[] = [];
  const journal = new ComputerJournal(home, () => clock.now);
  const worker = new ComputerWorker({
    hands,
    planner,
    journal,
    now: () => clock.now,
    notify: (text) => said.push(text),
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.maxMs ? { maxMs: options.maxMs } : {}),
    ...(options.enabled ? { enabled: options.enabled } : {}),
  });
  const waiting = () =>
    until(() => worker.snapshot().state === "waiting_for_person");
  return { home, clock, hands, planner, said, journal, worker, waiting };
}
const kinds = (commands: HandCommand[]) =>
  commands.map((command) =>
    command.kind === "observe"
      ? command.image
        ? "observe"
        : "look"
      : command.kind,
  );
const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "The note is saved." };

describe("a task", () => {
  it("looks, takes one checked action, looks again and ends on done", async () => {
    const { worker, hands, planner, said, journal } = setup([click, done]);
    expect(worker.snapshot()).toMatchObject({
      configured: true,
      state: "idle",
      canStop: false,
    });
    const started = await worker.submit("talk_1_execution", "Save the note");
    expect(started.message).toMatch(/^Started\./);
    await worker.idle();
    // A full look, a look just before the click, the click, and a full look after it.
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "look",
      "click",
      "observe",
    ]);
    expect(hands.sent).toEqual([
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
    ]);
    expect(hands.labels[2]).toBe('Click "Save"');
    expect(worker.snapshot()).toEqual({
      configured: true,
      state: "completed",
      canStop: false,
      message: "Done. The note is saved.",
    });
    expect(said).toEqual(["Done. The note is saved."]);
    // The planner saw the goal, a fresh observation each time, and its own last step.
    expect(planner.inputs).toHaveLength(2);
    expect(planner.inputs[0]).toMatchObject({
      goal: "Save the note",
      history: [],
      page: null,
    });
    expect(planner.inputs[0]!.observation?.image).toBe("aW1hZ2U=");
    expect(planner.inputs[1]!.history).toEqual([
      { step: 1, action: click, why: "step 1", outcome: "ok" },
    ]);
    expect(journal.get("talk_1_execution")).toMatchObject({
      goal: "Save the note",
      state: "completed",
      reason: "done",
      steps: [
        { n: 1, kind: "click_element", target: "Save", outcome: "ok" },
        { n: 2, kind: "done", target: "", outcome: "ok" },
      ],
    });
  });

  it("gives the planner the last 12 steps only", async () => {
    const script: Script = Array.from({ length: 14 }, (_, index) => ({
      kind: "wait" as const,
      ms: index,
    }));
    const { worker, planner } = setup([...script, done]);
    await worker.submit("r1", "Wait a lot");
    await worker.idle();
    expect(planner.inputs.at(-1)!.history).toHaveLength(12);
    expect(planner.inputs.at(-1)!.history[0]!.step).toBe(3);
  });

  it("looks again after a wait and after a scroll of the page: the screen may be another one", async () => {
    const browser = new FakeBrowser();
    const { worker, hands } = setup(
      [
        { kind: "wait", ms: 5 },
        { kind: "browser_scroll", direction: "down" },
        { kind: "browser_read" },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Wait for the page");
    await worker.idle();
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "wait",
      "observe",
      "observe",
    ]);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("does not start the same request twice, or a second request while one runs", async () => {
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    const { worker, planner, hands } = setup([
      async () => {
        await gate;
        return done;
      },
    ]);
    await worker.submit("r1", "First");
    expect(worker.snapshot()).toMatchObject({
      state: "running",
      canStop: true,
    });
    expect((await worker.submit("r1", "First")).message).toMatch(/Working on/);
    expect((await worker.submit("r2", "Second")).message).toMatch(
      /already running/,
    );
    release();
    await worker.idle();
    expect(planner.inputs).toHaveLength(1);
    expect(kinds(hands.commands)).toEqual(["observe"]);
    // The first id is known for good: it never runs again.
    expect((await worker.submit("r1", "First")).message).toBe(
      "Done. The note is saved.",
    );
    expect(planner.inputs).toHaveLength(1);
    await expect(worker.submit("../bad", "x")).rejects.toThrow();
    await expect(worker.submit("r3", "   ")).rejects.toThrow();
  });

  it("keeps no typed text, no image and no words of the planner in the journal", async () => {
    const field = observation([
      element(1, { role: "AXTextField", title: "Name" }),
    ]);
    const { worker, hands, journal } = setup(
      [
        { kind: "type", text: "private words", element: 1 },
        { kind: "done", summary: "Typed the private words." },
      ],
      { screens: [field] },
    );
    await worker.submit("r1", "Fill the name");
    await worker.idle();
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "look",
      "click",
      "look",
      "type",
      "observe",
    ]);
    expect(hands.sent.at(-1)).toEqual({ kind: "type", text: "private words" });
    const text = readFileSync(journal.file, "utf8");
    expect(text).not.toContain("private words");
    expect(text).not.toContain("aW1hZ2U=");
    expect(text).not.toContain("step 1");
    expect(journal.get("r1")!.steps[0]).toMatchObject({
      kind: "type",
      target: "Name",
      outcome: "ok",
    });
  });
});

describe("stop", () => {
  it("is checked before an action: what the planner chose after Stop is not sent", async () => {
    const { worker, hands, said, journal } = setup([
      click,
      () => {
        expect(worker.stop()).toMatchObject({
          state: "stopping",
          canStop: false,
          message: stoppedText,
        });
        return click;
      },
      click,
    ]);
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(worker.snapshot()).toEqual({
      configured: true,
      state: "canceled",
      canStop: false,
      message: "Stopped. An action that was already sent may have finished.",
    });
    expect(journal.get("r1")).toMatchObject({
      state: "canceled",
      reason: "stopped",
    });
    // The person who stopped it has the answer already: nothing more is said.
    expect(said).toEqual([]);
  });

  it("is checked after an action: an action in flight ends, and nothing follows it", async () => {
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    const { worker, hands, journal } = setup([click, click, done]);
    hands.answer = async (command) => {
      if (command.kind === "click") await gate;
      return {};
    };
    await worker.submit("r1", "Click it");
    await until(() => hands.sent.length === 1);
    expect(worker.stop()).toMatchObject({ state: "stopping", canStop: false });
    expect(worker.snapshot().message).toBe(stoppedText);
    // A new request waits until the action in flight has ended.
    expect((await worker.submit("r2", "Other")).message).toMatch(
      /already running/,
    );
    release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("canceled");
    expect(kinds(hands.commands)).toEqual(["observe", "look", "click"]);
    // The click was sent, so the record holds it.
    expect(journal.get("r1")!.steps).toMatchObject([
      { kind: "click_element", target: "Save", outcome: "ok" },
    ]);
  });

  it("does not wait for the planner", async () => {
    const { worker, hands } = setup([() => new Promise<Action>(() => {})]);
    await worker.submit("r1", "Think forever");
    await until(() => hands.commands.length === 1);
    worker.stop();
    await worker.idle();
    expect(worker.snapshot()).toMatchObject({
      state: "canceled",
      message: stoppedText,
    });
    expect(hands.sent).toEqual([]);
  });

  it("changes nothing when no request runs", async () => {
    const { worker } = setup([]);
    expect(worker.stop()).toMatchObject({ state: "idle", canStop: false });
  });
});

describe("the person's yes", () => {
  const send = observation([element(1, { title: "Send" })]);

  it("is asked before a click that cannot be undone: yes proceeds", async () => {
    const { worker, hands, said, waiting, journal } = setup([click, done], {
      screens: [send],
    });
    await worker.submit("r1", "Send the mail");
    await waiting();
    expect(hands.sent).toEqual([]);
    const question = worker.snapshot().message;
    expect(question).toBe(
      'Click "Send"? "Send" may be something that cannot be undone, or that speaks for you. Say yes to allow it, or no to stop.',
    );
    expect(said).toEqual([question]);
    expect(worker.snapshot().canStop).toBe(true);
    expect(worker.status().question).toBe(question);
    expect(journal.get("r1")!.state).toBe("waiting_for_person");
    // Words that are not a clear yes change nothing.
    for (const unclear of [
      "maybe later",
      "what does it do?",
      "yes, no, wait",
    ]) {
      const reply = await worker.answer(unclear);
      expect(reply.message).toBe(`I did not get a clear answer. ${question}`);
      expect(worker.snapshot().state).toBe("waiting_for_person");
    }
    expect(hands.sent).toEqual([]);
    expect((await worker.answer("yes, go ahead")).message).toBe("Continuing.");
    await worker.idle();
    expect(hands.sent).toEqual([
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
    ]);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("is asked before a click that cannot be undone: no cancels", async () => {
    const { worker, hands, waiting, journal, planner } = setup([click, done], {
      screens: [send],
    });
    await worker.submit("r1", "Send the mail");
    await waiting();
    expect((await worker.answer("no")).message).toBe(
      'Canceled. I did not do it: Click "Send".',
    );
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(planner.inputs).toHaveLength(1);
    expect(worker.snapshot()).toMatchObject({
      state: "canceled",
      canStop: false,
    });
    expect(journal.get("r1")).toMatchObject({
      state: "canceled",
      reason: "refused_by_person",
    });
  });

  it("does not send the click when the screen changed while the person answered", async () => {
    const other = observation([element(1, { title: "Send" })], {
      app: { ...send.app, window: "Another draft" },
    });
    const { worker, hands, waiting, planner } = setup([click, done], {
      screens: [send, other],
    });
    await worker.submit("r1", "Send the mail");
    await waiting();
    await worker.answer("yes");
    await worker.idle();
    // The yes was for the window that the person saw. It does not carry over.
    expect(hands.sent).toEqual([]);
    expect(planner.inputs[1]!.history[0]!.outcome).toMatch(
      /^not sent: Another app or window came to the front/,
    );
  });

  const terminal = observation([], { app: terminalApp });
  const dialog = observation([
    element(1, { title: "Cancel" }),
    element(2, { title: "Delete" }),
  ]);
  const cases: [string, Observation, Action, RegExp, HandCommand][] = [
    [
      "typing in a terminal",
      terminal,
      { kind: "type", text: "rm -rf build" },
      /^Type text\? This goes into a terminal/,
      { kind: "type", text: "rm -rf build" },
    ],
    [
      "Return in a terminal",
      terminal,
      { kind: "key", combo: "return" },
      /^Press return\? This goes into a terminal/,
      { kind: "key", combo: "return" },
    ],
    [
      "a key that quits",
      save,
      { kind: "key", combo: "cmd+q" },
      /^Press cmd\+q\? This key combination can quit an app, log out or lock the Mac\./,
      { kind: "key", combo: "cmd+q" },
    ],
    [
      "a key that logs out",
      save,
      { kind: "key", combo: "shift+cmd+q" },
      /^Press cmd\+shift\+q\?/,
      { kind: "key", combo: "cmd+shift+q" },
    ],
    [
      "a key that locks",
      save,
      { kind: "key", combo: "ctrl+cmd+q" },
      /^Press cmd\+ctrl\+q\?/,
      { kind: "key", combo: "cmd+ctrl+q" },
    ],
    [
      "Return that can press Delete",
      dialog,
      { kind: "key", combo: "return" },
      /^Press return\? This key can press "Delete"/,
      { kind: "key", combo: "return" },
    ],
  ];
  it.each(cases)(
    "is asked before %s: yes proceeds, no cancels",
    async (_name, screen, action, question, sent) => {
      const yes = setup([action, done], { screens: [screen] });
      await yes.worker.submit("r1", "Do it");
      await yes.waiting();
      expect(yes.worker.snapshot().message).toMatch(question);
      expect(yes.hands.sent).toEqual([]);
      expect((await yes.worker.answer("yes")).message).toBe("Continuing.");
      await yes.worker.idle();
      expect(yes.hands.sent).toEqual([sent]);
      expect(yes.worker.snapshot().state).toBe("completed");

      const no = setup([action, done], { screens: [screen] });
      await no.worker.submit("r1", "Do it");
      await no.waiting();
      expect((await no.worker.answer("no, do not")).message).toMatch(
        /^Canceled\. I did not do it: /,
      );
      await no.worker.idle();
      expect(no.hands.sent).toEqual([]);
      expect(no.planner.inputs).toHaveLength(1);
      expect(no.worker.snapshot().state).toBe("canceled");
    },
  );

  it("is asked before the same action goes out a third time in a row", async () => {
    const yes = setup([click, click, click, done]);
    await yes.worker.submit("r1", "Click it");
    await yes.waiting();
    expect(yes.hands.sent).toHaveLength(2);
    expect(yes.worker.snapshot().message).toBe(
      'I already did this twice in a row: Click "Save". Say yes to do it a third time, or no to stop.',
    );
    await yes.worker.answer("yes");
    await yes.worker.idle();
    expect(yes.hands.sent).toHaveLength(3);
    expect(yes.worker.snapshot().state).toBe("completed");

    const no = setup([click, click, click, done]);
    await no.worker.submit("r1", "Click it");
    await no.waiting();
    await no.worker.answer("no");
    await no.worker.idle();
    expect(no.hands.sent).toHaveLength(2);
    expect(no.worker.snapshot().state).toBe("canceled");

    // A wait between two clicks does not end the row. Another action does.
    const waits = setup([click, { kind: "wait", ms: 1 }, click, click]);
    await waits.worker.submit("r1", "Click it");
    await waits.waiting();
    expect(waits.hands.sent).toHaveLength(2);
    waits.worker.stop();
    const mixed = setup(
      [click, click, { kind: "click_element", element: 2 }, click, click, done],
      {
        screens: [
          observation([
            element(1, { title: "Save" }),
            element(2, { title: "Next" }),
          ]),
        ],
      },
    );
    await mixed.worker.submit("r1", "Click around");
    await mixed.worker.idle();
    expect(mixed.hands.sent).toHaveLength(5);
    expect(mixed.worker.snapshot().state).toBe("completed");
  });

  it("stops while it waits for an answer, with the plain answer", async () => {
    const { worker, hands, waiting } = setup([click], { screens: [send] });
    await worker.submit("r1", "Send the mail");
    await waiting();
    expect(worker.stop()).toMatchObject({
      state: "canceled",
      canStop: false,
      message: stoppedText,
    });
    await worker.idle();
    expect(hands.sent).toEqual([]);
    // An answer that comes after Stop finds nothing to answer.
    expect((await worker.answer("yes")).message).toBe(stoppedText);
    expect(hands.sent).toEqual([]);
  });

  it("is not taken after the time limit: a late yes sends nothing", async () => {
    const { worker, hands, waiting, clock, journal, said } = setup(
      [click, done],
      { screens: [send] },
    );
    await worker.submit("r1", "Send the mail");
    await waiting();
    clock.now += 15 * 60_000;
    expect((await worker.answer("yes")).message).toBe(
      "I stopped at the time limit of 15 minutes. The task is not finished.",
    );
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      canStop: false,
    });
    expect(journal.get("r1")).toMatchObject({ reason: "time_limit" });
    expect(said.at(-1)).toMatch(/time limit of 15 minutes/);
  });
});

describe("a secure field", () => {
  const login = observation([
    element(1, { role: "AXTextField", title: "Name" }),
    element(2, { role: "AXSecureTextField", title: "Password", secure: true }),
  ]);

  it("is never typed into: the person types, then says yes", async () => {
    const { worker, hands, waiting, planner, journal } = setup(
      [{ kind: "type", text: "hunter2", element: 2 }, done],
      { screens: [login] },
    );
    await worker.submit("r1", "Log in");
    await waiting();
    expect(worker.snapshot().message).toBe(
      'Type in "Password": that is a password field, and I never type there. Type it yourself, then say yes to go on, or no to stop.',
    );
    expect((await worker.answer("yes")).message).toBe("Continuing.");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]!.history[0]!.outcome).toMatch(/^not typed/);
    // The planner looks at the screen again after the person typed.
    expect(kinds(hands.commands)).toEqual(["observe", "observe"]);
    expect(readFileSync(journal.file, "utf8")).not.toContain("hunter2");
  });

  it("cancels on no", async () => {
    const { worker, hands, waiting } = setup(
      [{ kind: "type", text: "hunter2", element: 2 }, done],
      { screens: [login] },
    );
    await worker.submit("r1", "Log in");
    await waiting();
    expect((await worker.answer("no")).message).toBe(
      "Canceled. Nothing was typed.",
    );
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().state).toBe("canceled");
  });

  it("is not typed into when the focus lands in it after the click on another field", async () => {
    const afterClick = observation([
      element(1, { role: "AXTextField", title: "Name" }),
      element(2, {
        role: "AXSecureTextField",
        title: "Password",
        secure: true,
        focused: true,
      }),
    ]);
    const { worker, hands, waiting } = setup(
      [{ kind: "type", text: "Ada", element: 1 }, done],
      { screens: [login, login, afterClick] },
    );
    await worker.submit("r1", "Fill the name");
    await waiting();
    // The click that gives the focus went out. The text did not.
    expect(kinds(hands.commands)).toEqual(["observe", "look", "click", "look"]);
    expect(worker.snapshot().message).toMatch(/password field/);
    worker.stop();
  });

  it("is not typed into when it takes the focus between the look and the keys", async () => {
    const prompt = observation([
      element(1, { role: "AXTextField", title: "Name" }),
      element(9, {
        role: "AXSecureTextField",
        title: "Password",
        secure: true,
        focused: true,
      }),
    ]);
    const { worker, hands, waiting } = setup(
      [{ kind: "type", text: "Ada" }, done],
      { screens: [login, prompt] },
    );
    await worker.submit("r1", "Type the name");
    await waiting();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().message).toMatch(/password field/);
    worker.stop();
  });
});

describe("the person takes over", () => {
  const interrupted = (hands: FakeHands) => {
    hands.answer = (command) =>
      command.kind === "click" ? { interrupted: true } : undefined;
  };
  it("pauses and asks: continue goes on", async () => {
    const { worker, hands, waiting, said } = setup([click, done]);
    interrupted(hands);
    await worker.submit("r1", "Click it");
    await waiting();
    expect(worker.snapshot().message).toBe(
      "You moved the mouse or pressed a key, so I paused. Say continue to go on, or stop.",
    );
    expect(said).toHaveLength(1);
    expect(kinds(hands.commands)).toEqual(["observe", "look", "click"]);
    expect((await worker.answer("hmm")).message).toMatch(
      /^I did not get a clear answer\./,
    );
    expect((await worker.answer("continue")).message).toBe("Continuing.");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "look",
      "click",
      "observe",
    ]);
  });
  it("pauses and asks: stop ends it", async () => {
    const { worker, hands, waiting } = setup([click, click, done]);
    interrupted(hands);
    await worker.submit("r1", "Click it");
    await waiting();
    expect((await worker.answer("stop")).message).toBe(stoppedText);
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(worker.snapshot().state).toBe("canceled");
  });
  it("does not send an action when the look just before it was interrupted", async () => {
    const { worker, hands, waiting } = setup([click, done]);
    hands.answer = (command) =>
      command.kind === "observe" && !command.image
        ? { interrupted: true }
        : undefined;
    await worker.submit("r1", "Click it");
    await waiting();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().message).toMatch(/^You moved the mouse/);
    worker.stop();
  });
  it("ends as stopped when the hands say that the person stopped them", async () => {
    const { worker, hands } = setup([click, click, done]);
    hands.answer = (command) =>
      command.kind === "click"
        ? { ok: false, error: "stopped_by_person" }
        : undefined;
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(worker.snapshot()).toMatchObject({
      state: "canceled",
      message: stoppedText,
    });
    expect(hands.sent).toHaveLength(1);
  });
});

describe("a missing permission", () => {
  it.each([
    ["no_accessibility", /Privacy & Security, Accessibility/],
    [
      "no_screen_recording",
      /Privacy & Security, Screen & System Audio Recording/,
    ],
  ] as const)(
    "%s gives a blocked state that says what to grant",
    async (error, grant) => {
      const { worker, hands, planner, said, journal } = setup([click, done]);
      hands.answer = () => ({ ok: false, error });
      await worker.submit("r1", "Click it");
      await worker.idle();
      expect(worker.snapshot()).toMatchObject({
        configured: true,
        state: "blocked",
        canStop: false,
      });
      expect(worker.snapshot().message).toMatch(grant);
      expect(said).toEqual([worker.snapshot().message]);
      expect(planner.inputs).toHaveLength(0);
      expect(hands.sent).toEqual([]);
      expect(journal.get("r1")).toMatchObject({
        state: "blocked",
        reason: error,
      });
      // Nothing is unknown, so the next request can start.
      hands.answer = () => undefined;
      expect((await worker.submit("r2", "Again")).message).toMatch(/^Started/);
      await worker.idle();
    },
  );
});

describe("what is not known", () => {
  it("a restart turns a running request into uncertain: no replay, and new work waits for the person", async () => {
    const first = setup([click, done]);
    // The hands never answer the click: the service "dies" in the middle.
    first.hands.answer = (command) =>
      command.kind === "click" ? new Promise(() => {}) : undefined;
    await first.worker.submit("r1", "Pay the invoice");
    await until(() => first.hands.sent.length === 1);

    const second = setup([click, done], { home: first.home });
    expect(second.worker.snapshot()).toMatchObject({
      configured: true,
      state: "uncertain",
      canStop: false,
    });
    expect(second.worker.snapshot().message).toBe(
      'An earlier computer task has an unknown result: "Pay the invoice". It is not run again. Look at the screen to see what happened, then run: clawdtime computer clear',
    );
    // The same request and a new one: neither runs.
    for (const [id, text] of [
      ["r1", "Pay the invoice"],
      ["r2", "Something new"],
    ] as const)
      expect((await second.worker.submit(id, text)).message).toMatch(
        /unknown result/,
      );
    expect(second.worker.stop().state).toBe("uncertain");
    expect(second.planner.inputs).toHaveLength(0);
    expect(second.hands.commands).toEqual([]);
    expect(second.journal.get("r1")).toMatchObject({
      state: "uncertain",
      reason: "restart",
    });
    // The person clears it. The old request stays in the record and does not run.
    expect(second.journal.clear().cleared).toHaveLength(1);
    expect(second.worker.snapshot().state).toBe("idle");
    expect(
      (await second.worker.submit("r1", "Pay the invoice")).message,
    ).not.toMatch(/^Started/);
    expect((await second.worker.submit("r3", "Something new")).message).toMatch(
      /^Started/,
    );
    await second.worker.idle();
    expect(second.worker.snapshot().state).toBe("completed");
    expect(second.hands.sent).toHaveLength(1);
  });

  it("a lost result of an action is uncertain: it is not sent again", async () => {
    const { worker, hands, planner, said, journal } = setup([
      click,
      click,
      done,
    ]);
    hands.answer = (command) => (command.kind === "click" ? "lost" : undefined);
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(planner.inputs).toHaveLength(1);
    expect(worker.snapshot()).toMatchObject({
      state: "uncertain",
      canStop: false,
    });
    expect(worker.snapshot().message).toBe(
      'I sent this and its result never came back: Click "Save". It may have happened or not. I do not send it again. Look at the screen, then run: clawdtime computer clear',
    );
    expect(said).toEqual([worker.snapshot().message]);
    expect(journal.get("r1")).toMatchObject({
      state: "uncertain",
      reason: "lost_result",
      steps: [{ kind: "click_element", target: "Save", outcome: "lost" }],
    });
    expect((await worker.submit("r2", "Other")).message).toMatch(
      /unknown result/,
    );
    expect(hands.sent).toHaveLength(1);
  });

  it("a look that never came back is not uncertain: nothing was sent", async () => {
    const { worker, hands, planner } = setup([click, done]);
    hands.answer = () => "lost";
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(worker.snapshot().state).toBe("blocked");
    expect(worker.snapshot().message).toMatch(/nothing was sent/);
    expect(planner.inputs).toHaveLength(0);
    hands.answer = () => undefined;
    expect((await worker.submit("r2", "Again")).message).toMatch(/^Started/);
    await worker.idle();
  });
});

describe("what the planner may not do", () => {
  it("an element that the last observation does not hold is refused and not run", async () => {
    const { worker, hands, planner, journal } = setup([
      { kind: "click_element", element: 99 },
      done,
    ]);
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(kinds(hands.commands)).toEqual(["observe"]);
    expect(planner.inputs[1]!.history[0]).toMatchObject({
      step: 1,
      outcome: "refused: The last observation has no element 99.",
    });
    expect(journal.get("r1")!.steps[0]).toMatchObject({
      kind: "click_element",
      outcome: "refused",
    });
    expect(worker.snapshot().state).toBe("completed");
  });

  it("done before an observation that came after the last action is refused", async () => {
    const { worker, hands, planner, journal } = setup([click, done, done]);
    let looks = 0;
    // The full look after the click comes back with no observation in it.
    hands.answer = (command) =>
      command.kind === "observe" && command.image && ++looks === 2
        ? { observation: undefined }
        : undefined;
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(planner.inputs).toHaveLength(3);
    expect(planner.inputs[1]!.observation).toBeNull();
    expect(planner.inputs[2]!.history[1]).toMatchObject({
      step: 2,
      outcome:
        "refused: Done needs a view of the screen that is newer than the last action.",
    });
    expect(planner.inputs[2]!.observation).not.toBeNull();
    expect(worker.snapshot().state).toBe("completed");
    expect(journal.get("r1")!.steps.map((step) => step.outcome)).toEqual([
      "ok",
      "refused",
      "ok",
    ]);
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "look",
      "click",
      "observe",
      "observe",
    ]);
  });

  it("a link that is not http or https is refused and not opened", async () => {
    const { worker, hands, planner } = setup([
      { kind: "open_url", url: "file:///etc/passwd" },
      { kind: "open_url", url: "https://example.com/" },
      done,
    ]);
    await worker.submit("r1", "Open it");
    await worker.idle();
    expect(hands.sent).toEqual([
      { kind: "open_url", url: "https://example.com/" },
    ]);
    expect(planner.inputs[1]!.history[0]!.outcome).toMatch(
      /^refused: Only http/,
    );
  });

  it("output that is not one action is refused, and three refusals in a row end the request", async () => {
    const { worker, hands, planner, said } = setup([
      { kind: "format_disk" } as unknown as Action,
      { kind: "click_element", element: 99 },
      { kind: "key", combo: "power" },
      done,
    ]);
    await worker.submit("r1", "Break it");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(planner.inputs).toHaveLength(3);
    expect(worker.snapshot()).toMatchObject({ state: "blocked" });
    expect(said[0]).toMatch(/3 actions in a row that the checks refused/);
  });

  it("the step limit ends the request", async () => {
    const waits: Script = Array.from({ length: 10 }, () => ({
      kind: "wait" as const,
      ms: 1,
    }));
    const { worker, planner, journal } = setup(waits, { maxSteps: 3 });
    await worker.submit("r1", "Wait");
    await worker.idle();
    expect(planner.inputs).toHaveLength(3);
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: "I stopped at the limit of 3 steps. The task is not finished.",
    });
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "step_limit",
    });
  });

  it("has a limit of 40 steps and 15 minutes when none is given", async () => {
    const waits: Script = Array.from({ length: 60 }, () => ({
      kind: "wait" as const,
      ms: 1,
    }));
    const steps = setup(waits);
    await steps.worker.submit("r1", "Wait");
    await steps.worker.idle();
    expect(steps.planner.inputs).toHaveLength(40);
    expect(steps.worker.snapshot().message).toMatch(/limit of 40 steps/);

    const time = setup([
      () => {
        time.clock.now += 15 * 60_000;
        return click;
      },
      done,
    ]);
    await time.worker.submit("r1", "Click it");
    await time.worker.idle();
    // The time ran out while the planner chose: its action is not sent.
    expect(time.planner.inputs).toHaveLength(1);
    expect(time.hands.sent).toEqual([]);
    expect(time.worker.snapshot()).toMatchObject({
      state: "blocked",
      message:
        "I stopped at the time limit of 15 minutes. The task is not finished.",
    });
  });

  it("the time limit ends a request whose planner never answers", async () => {
    const { worker, hands, journal } = setup(
      [() => new Promise<Action>(() => {})],
      { maxMs: 30 },
    );
    await worker.submit("r1", "Think forever");
    await worker.idle();
    expect(worker.snapshot().state).toBe("blocked");
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "time_limit",
    });
    expect(hands.sent).toEqual([]);
  });

  it("a planner that fails twice in a row ends the request, with nothing sent", async () => {
    const { worker, hands, said } = setup([
      () => {
        throw new Error("The language model answered 500.");
      },
      () => {
        throw new Error("The language model answered 500.");
      },
      click,
    ]);
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().state).toBe("blocked");
    expect(said[0]).toMatch(/planner did not answer/);
    // The reason of the failure is not passed on: it can hold what was sent.
    expect(said[0]).not.toContain("500");
  });

  it("an action that the hands could not run is told to the planner, and the task goes on", async () => {
    const { worker, hands, planner } = setup([click, done]);
    hands.answer = (command) =>
      command.kind === "click" ? { ok: false, error: "not_found" } : undefined;
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "did not run: not_found",
    );
    expect(worker.snapshot().state).toBe("completed");
  });
});

describe("questions and endings of the planner", () => {
  it("passes a question to the person and the answer back to the planner", async () => {
    const { worker, hands, waiting, said, journal } = setup([
      { kind: "ask", question: "Which note: Shopping or Work?" },
      (input) => {
        expect(input.history.at(-1)!.outcome).toBe(
          "the person answered: the shopping one",
        );
        return done;
      },
    ]);
    await worker.submit("r1", "Open my note");
    await waiting();
    expect(worker.snapshot().message).toBe("Which note: Shopping or Work?");
    expect(said).toEqual(["Which note: Shopping or Work?"]);
    expect((await worker.answer("the shopping one")).message).toBe(
      "Thank you. I go on.",
    );
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    // The screen is read again after the person answered.
    expect(kinds(hands.commands)).toEqual(["observe", "observe"]);
    const text = readFileSync(journal.file, "utf8");
    expect(text).not.toContain("Shopping or Work");
    expect(text).not.toContain("the shopping one");
  });

  it("does not pass a credential on to the planner: the person types it on the Mac", async () => {
    const { worker, waiting, planner } = setup([
      { kind: "ask", question: "What is the password of the account?" },
      (input) => {
        expect(JSON.stringify(input.history)).not.toContain("hunter2-and-more");
        expect(input.history.at(-1)!.outcome).toBe(
          "the person answered: I typed it",
        );
        return done;
      },
    ]);
    await worker.submit("r1", "Log in");
    await waiting();
    expect(
      (await worker.answer("my password is hunter2-and-more")).message,
    ).toBe(
      "I do not take a password or a key in the chat. Type it into the field on the Mac yourself, then tell me to go on.",
    );
    // Nothing went to the planner, and the question still waits.
    expect(planner.inputs).toHaveLength(1);
    expect(worker.snapshot().state).toBe("waiting_for_person");
    await worker.answer("I typed it");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
  });

  it("ends as blocked when the planner gives up", async () => {
    const { worker, said } = setup([
      { kind: "give_up", reason: "There is no such app." },
    ]);
    await worker.submit("r1", "Open it");
    await worker.idle();
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: "I could not finish. There is no such app.",
    });
    expect(said).toEqual(["I could not finish. There is no such app."]);
  });
});

describe("the switch", () => {
  it("off: nothing starts", async () => {
    const { worker, hands } = setup([click], { enabled: () => false });
    expect(worker.snapshot()).toMatchObject({
      configured: false,
      canStop: false,
    });
    expect((await worker.submit("r1", "Click it")).message).toBe(
      "Computer use is off. Turn it on with: clawdtime computer on",
    );
    expect(hands.commands).toEqual([]);
  });
  it("turned off in the middle: the next action is not sent", async () => {
    let on = true;
    const { worker, hands, said } = setup(
      [
        click,
        () => {
          on = false;
          return click;
        },
      ],
      { enabled: () => on },
    );
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(said).toEqual([
      "Computer use was turned off, so I stopped. An action that was already sent may have finished.",
    ]);
  });
});

describe("the browser", () => {
  const shop = page([
    pageElement(1, { label: "Buy now" }),
    pageElement(2, { label: "Password", tag: "input", password: true }),
    pageElement(5, { label: "Next" }),
  ]);

  it("reads the page, finds the element again just before the click, and clicks it", async () => {
    const browser = new FakeBrowser(shop);
    const { worker, planner, journal, hands } = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 5 }, done],
      { browser },
    );
    await worker.submit("r1", "Go to the next page");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read", "click 5"]);
    expect(planner.inputs[1]!.page).toEqual(shop);
    expect(worker.snapshot().state).toBe("completed");
    expect(journal.get("r1")!.steps).toMatchObject([
      { kind: "browser_read", target: "", outcome: "ok" },
      { kind: "browser_click", target: "Next", outcome: "ok" },
      { kind: "done" },
    ]);
    // The text of the page is not in the record.
    expect(readFileSync(journal.file, "utf8")).not.toContain("Some text");
    // After the click on the page the screen is read again before done counts.
    expect(kinds(hands.commands)).toEqual(["observe", "observe"]);
  });

  it("asks before a click on a name that cannot be undone, and never types a password", async () => {
    const buy = new FakeBrowser(shop);
    const asked = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 1 }, done],
      { browser: buy },
    );
    await asked.worker.submit("r1", "Buy it");
    await asked.waiting();
    expect(asked.worker.snapshot().message).toMatch(
      /^Click "Buy now" on the page\?/,
    );
    await asked.worker.answer("no");
    await asked.worker.idle();
    expect(buy.calls).toEqual(["read"]);

    const login = new FakeBrowser(shop);
    const secure = setup(
      [
        { kind: "browser_read" },
        { kind: "browser_type", index: 2, text: "hunter2" },
        done,
      ],
      { browser: login },
    );
    await secure.worker.submit("r1", "Log in");
    await secure.waiting();
    expect(secure.worker.snapshot().message).toMatch(/password field/);
    await secure.worker.answer("yes");
    await secure.worker.idle();
    expect(login.calls).toEqual(["read"]);
    expect(secure.worker.snapshot().state).toBe("completed");
  });

  it("does not click when the page changed since it was read", async () => {
    const browser = new FakeBrowser(shop);
    const { worker, planner } = setup(
      [
        { kind: "browser_read" },
        () => {
          browser.current = page([pageElement(5, { label: "Delete account" })]);
          return { kind: "browser_click", index: 5 };
        },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Go to the next page");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read"]);
    expect(planner.inputs[2]!.history[1]!.outcome).toMatch(/^not sent/);
  });

  it("follows an element of the page to its new number, and never clicks what took its old number", async () => {
    const browser = new FakeBrowser(shop);
    const { worker } = setup(
      [
        { kind: "browser_read" },
        () => {
          // A row was added above: Next is number 6 now, and 5 is another button.
          browser.current = page([
            pageElement(5, { label: "Previous" }),
            pageElement(6, { label: "Next" }),
          ]);
          return { kind: "browser_click", index: 5 };
        },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Go to the next page");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read", "click 6"]);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("needs a new reading of the page after an action on the screen", async () => {
    const browser = new FakeBrowser(shop);
    const { worker, planner } = setup(
      [
        { kind: "browser_read" },
        click,
        { kind: "browser_click", index: 5 },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Mix");
    await worker.idle();
    expect(browser.calls).toEqual(["read"]);
    expect(planner.inputs[2]!.page).toBeNull();
    expect(planner.inputs[3]!.history[2]!.outcome).toMatch(
      /^refused: Read the page first/,
    );
  });

  it("refuses the browser actions where no browser is connected", async () => {
    const { worker, planner } = setup([{ kind: "browser_read" }, done]);
    await worker.submit("r1", "Read");
    await worker.idle();
    expect(planner.inputs[1]!.history[0]!.outcome).toMatch(
      /^refused: No browser is connected/,
    );
  });

  it("goes on when the browser fails, and reads the page again", async () => {
    const browser = new FakeBrowser(shop);
    browser.click = async () => {
      browser.calls.push("click failed");
      throw new Error("The script did not run.");
    };
    const { worker, planner } = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 5 }, done],
      { browser },
    );
    await worker.submit("r1", "Next");
    await worker.idle();
    expect(planner.inputs[2]!.history[1]!.outcome).toBe(
      "did not run: the browser failed",
    );
    expect(planner.inputs[2]!.page).toBeNull();
    expect(worker.snapshot().state).toBe("completed");
  });
});

describe("what the panel shows", () => {
  it("says what runs, for the banner and for the state route", async () => {
    const send = observation([element(1, { title: "Send" })]);
    const { worker, waiting } = setup([click, done], { screens: [send] });
    expect(worker.run()).toEqual({
      active: false,
      goal: "",
      step: 0,
      state: "idle",
    });
    expect(worker.status()).toEqual({
      version: 1,
      enabled: true,
      state: "idle",
      message:
        "Computer use is on. Ask me to do something on this Mac, and I take one checked action at a time.",
      step: 0,
      goal: "",
      question: null,
    });
    await worker.submit("r1", "Send the mail");
    await waiting();
    expect(worker.run()).toEqual({
      active: true,
      goal: "Send the mail",
      step: 1,
      state: "waiting_for_person",
    });
    expect(worker.status()).toMatchObject({
      enabled: true,
      state: "waiting_for_person",
      step: 1,
      goal: "Send the mail",
      question: expect.stringMatching(/^Click "Send"\?/),
    });
    worker.stop();
    expect(worker.run()).toMatchObject({ active: false, state: "idle" });
    expect(worker.status()).toMatchObject({
      state: "canceled",
      question: null,
      goal: "Send the mail",
    });
  });
});
