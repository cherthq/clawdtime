import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerJournal } from "../connectors/computer/journal.js";
import { BrowserInputUnknown } from "../connectors/computer/own-browser.js";
import {
  BrowserClosed,
  type Action,
  type HandCommand,
  type Observation,
  type Planner,
} from "../connectors/computer/ports.js";
import {
  ComputerWorker,
  computerStatusSchema,
  stoppedText,
  type StepTiming,
} from "../connectors/computer/worker.js";
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
    browserMs?: number;
    home?: string;
    enabled?: () => boolean;
    settleMs?: number;
    settleLimit?: number;
    transientMs?: number;
    timing?: (entry: StepTiming) => void;
    fastReverify?: boolean;
    postActionSettleMs?: number;
    unchangedDone?: boolean;
    realClock?: boolean;
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
    now: options.realClock ? Date.now : () => clock.now,
    notify: (text) => said.push(text),
    ...(options.browser ? { browser: options.browser } : {}),
    ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
    ...(options.maxMs ? { maxMs: options.maxMs } : {}),
    ...(options.browserMs ? { browserMs: options.browserMs } : {}),
    ...(options.enabled ? { enabled: options.enabled } : {}),
    // The pauses of a wait for the screen to settle and after a short
    // failure of the planner: short here, so that a test takes no time.
    settleMs: options.settleMs ?? 1,
    transientMs: options.transientMs ?? 1,
    ...(options.settleLimit !== undefined
      ? { settleLimit: options.settleLimit }
      : {}),
    ...(options.timing ? { timing: options.timing } : {}),
    ...(options.fastReverify !== undefined
      ? { fastReverify: options.fastReverify }
      : {}),
    ...(options.postActionSettleMs !== undefined
      ? { postActionSettleMs: options.postActionSettleMs }
      : {}),
    ...(options.unchangedDone !== undefined
      ? { unchangedDone: options.unchangedDone }
      : {}),
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
    expect(started.message).toBe("");
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
      requestId: "talk_1_execution",
      configured: true,
      mode: "native",
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
      {
        step: 1,
        action: click,
        why: "step 1",
        outcome: "ok",
        target: "Save",
        role: "AXButton",
      },
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
    const { worker, planner, hands, journal } = setup([done]);
    // The first look waits until the test lets it go on.
    hands.answer = async () => {
      await gate;
      return {};
    };
    await worker.submit("r1", "First");
    expect(worker.snapshot()).toMatchObject({
      state: "running",
      canStop: true,
    });
    expect((await worker.submit("r1", "First")).message).toMatch(/Working on/);
    // Words that come during the first look steer the task, and it goes on.
    expect((await worker.submit("r2", "Second")).message).toBe(
      "Got it. I take that into the task that runs.",
    );
    expect(journal.get("r2")).toBeNull();
    release();
    await worker.idle();
    // The words came before the planner chose: its one choice had them.
    expect(planner.inputs).toHaveLength(1);
    expect(planner.inputs[0]).toMatchObject({ guidance: ["Second"] });
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
      requestId: "r1",
      configured: true,
      mode: "native",
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
    expect(worker.snapshot().requestId).toBe("r1");
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
    await worker.submit("r1", "Finish the draft");
    await waiting();
    expect(hands.sent).toEqual([]);
    const question = worker.snapshot().message;
    expect(question).toBe(
      'Click "Send" in Notes? It sends as you to other people. Say yes or no.',
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
    await worker.submit("r1", "Finish the draft");
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
    await worker.submit("r1", "Finish the draft");
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
    element(3, {
      role: "AXStaticText",
      title: "You can\u2019t undo this action.",
    }),
  ]);
  const edited = observation([element(1, { title: "Save" })], {
    app: {
      name: "TextEdit",
      bundleId: "com.apple.TextEdit",
      window: "Report \u2014 Edited",
    },
  });
  const cases: [string, Observation, Action, RegExp, HandCommand][] = [
    [
      "typing in a terminal",
      terminal,
      { kind: "type", text: "ls" },
      /^Type text in Terminal\? Text in a terminal runs as a command, and your request did not ask for one\. Say yes or no\.$/,
      { kind: "type", text: "ls" },
    ],
    [
      "a command that deletes for good",
      terminal,
      { kind: "type", text: "rm -rf build" },
      /^Type text in Terminal\? The command deletes files for good\. Say yes or no\.$/,
      { kind: "type", text: "rm -rf build" },
    ],
    [
      "Return in a terminal",
      terminal,
      { kind: "key", combo: "return" },
      /^Press return in Terminal\? Text in a terminal runs as a command/,
      { kind: "key", combo: "return" },
    ],
    [
      "a key that quits an app with unsaved changes",
      edited,
      { kind: "key", combo: "cmd+q" },
      /^Press cmd\+q in TextEdit\? "Report \u2014 Edited" shows changes that are not saved, which can be lost\. Say yes or no\.$/,
      { kind: "key", combo: "cmd+q" },
    ],
    [
      "a key that logs out",
      save,
      { kind: "key", combo: "shift+cmd+q" },
      /^Press cmd\+shift\+q in Notes\? It logs you out of the Mac/,
      { kind: "key", combo: "cmd+shift+q" },
    ],
    [
      "Return that can press a Delete that cannot be undone",
      dialog,
      { kind: "key", combo: "return" },
      /^Press return in Notes\? It can press "Delete"\. What it removes is gone for good\. Say yes or no\.$/,
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

  it("is not asked for the same action again: a loop is for the row of tries and the progress guard", async () => {
    const thrice = setup([click, click, click, done]);
    await thrice.worker.submit("r1", "Click it");
    await thrice.worker.idle();
    expect(thrice.hands.sent).toHaveLength(3);
    expect(thrice.said).toEqual(["Done. The note is saved."]);
    expect(thrice.worker.snapshot().state).toBe("completed");

    // A wait between two clicks asks nothing either.
    const waits = setup([click, { kind: "wait", ms: 1 }, click, click, done]);
    await waits.worker.submit("r1", "Click it");
    await waits.worker.idle();
    expect(waits.hands.sent).toHaveLength(3);
    expect(waits.worker.snapshot().state).toBe("completed");
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
    await worker.submit("r1", "Finish the draft");
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
    await worker.submit("r1", "Finish the draft");
    await waiting();
    clock.now += 15 * 60_000;
    expect((await worker.answer("yes")).message).toBe(
      "I stopped at the time limit of 15 minutes. The task is not finished. Ask again to go on from where it is now.",
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

describe("the time of each step", () => {
  it("goes to the listener with numbers and the kind of action, and with no text", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-timing-"));
    roots.push(home);
    const clock = { now: 5_000 };
    const hands = new FakeHands([save]);
    // The look takes 300 ms, the plan 1,200 ms and the action 80 ms.
    hands.answer = (command) => {
      clock.now += command.kind === "observe" && command.image ? 300 : 40;
      return undefined;
    };
    const planner = new ScriptedPlanner([
      () => {
        clock.now += 1_200;
        return click;
      },
      () => {
        clock.now += 900;
        return done;
      },
    ]);
    const heard: unknown[] = [];
    const worker = new ComputerWorker({
      hands,
      planner,
      journal: new ComputerJournal(home, () => clock.now),
      now: () => clock.now,
      timing: (entry) => heard.push(entry),
    });
    await worker.submit("r1", "Click the secret button named Save");
    await worker.idle();
    expect(heard).toEqual([
      // The click has a look just before it (40 ms) and the click itself (40 ms).
      { step: 1, kind: "click_element", lookMs: 300, planMs: 1_200, actMs: 80 },
      { step: 2, kind: "done", lookMs: 300, planMs: 900, actMs: 0 },
    ]);
    expect(JSON.stringify(heard)).not.toMatch(/Save|secret/);
  });
  it("says why a step was held back", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-timing-"));
    roots.push(home);
    const hands = new FakeHands([save]);
    // The look just before the click cannot read the screen.
    hands.answer = (command) =>
      command.kind === "observe" && !command.image
        ? { ok: false, error: "failed" }
        : undefined;
    const heard: { kind: string; held?: string }[] = [];
    const worker = new ComputerWorker({
      hands,
      planner: new ScriptedPlanner([click, done]),
      journal: new ComputerJournal(home),
      timing: (entry) => heard.push(entry),
    });
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(heard[0]).toMatchObject({
      kind: "click_element",
      held: "The screen could not be read just before the action.",
    });
    // The next step was sent: it has no such word.
    expect(heard[1]!.held).toBeUndefined();
  });
  it("changes nothing in the request when the listener fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-timing-"));
    roots.push(home);
    const worker = new ComputerWorker({
      hands: new FakeHands([save]),
      planner: new ScriptedPlanner([click, done]),
      journal: new ComputerJournal(home),
      timing: () => {
        throw new Error("no log");
      },
    });
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
  });
});

describe("a yes after which the action was not sent", () => {
  // The question itself changes what is in front: the look just before the
  // click has another generation than the planner's look.
  const warning = element(3, {
    role: "AXStaticText",
    title:
      "This item will be deleted immediately. You can\u2019t undo this action.",
  });
  const dialog = (surfaceEpoch: number) =>
    observation(
      [
        element(1, { title: "Cancel" }),
        element(2, { title: "Delete" }),
        warning,
      ],
      { surfaceEpoch },
    );
  const press: Action = { kind: "click_element", element: 2 };
  const questions = (said: string[]) =>
    said.filter((text) => text.startsWith('Click "Delete" in ')).length;

  it("holds for the same action: the person is not asked a second time", async () => {
    const { worker, hands, planner, said, waiting } = setup(
      [press, press, done],
      { screens: [dialog(1), dialog(2), dialog(2), dialog(2), dialog(2)] },
    );
    await worker.submit("r1", "Delete it");
    await waiting();
    expect((await worker.answer("yes")).message).toBe("Continuing.");
    await worker.idle();
    // The first try was held back, the planner looked again and chose the same click, and it went out.
    expect(planner.inputs[1]!.history[0]!.outcome).toMatch(
      /^not sent: The desktop or display changed/,
    );
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(questions(said)).toBe(1);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("is used once: the same action a second time asks again", async () => {
    const { worker, hands, said, waiting } = setup(
      [press, press, press, done],
      {
        screens: [dialog(1), dialog(2), dialog(2)],
      },
    );
    await worker.submit("r1", "Delete it twice");
    await waiting();
    await worker.answer("yes");
    await waiting();
    // One click went out with the first yes. The third plan of the click asks.
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(questions(said)).toBe(2);
    worker.stop();
  });

  it("comes back to the person when the action is held back again and again", async () => {
    // Every look has a new generation: nothing can be sent.
    let epoch = 0;
    const { worker, hands, said, waiting } = setup(
      [press, press, press, press, press, done],
      { screens: [dialog(0)] },
    );
    hands.answer = (command) =>
      command.kind === "observe" ? { observation: dialog(++epoch) } : undefined;
    await worker.submit("r1", "Delete it");
    await waiting();
    await worker.answer("yes");
    // The yes covered the first try (grace) and two more. The fourth plan asks again.
    await until(() => said.length === 2);
    expect(questions(said)).toBe(2);
    expect(hands.sent).toEqual([]);
    // Saying yes again still hits the same changing screen and ends the task on the third counted hold.
    await worker.answer("yes");
    await worker.idle();
    expect(said).toHaveLength(3);
    expect(said[2]).toBe(
      "The screen kept changing under me, also after I waited for the screen to settle, so nothing was sent. Close any open menu or list in front, then ask again.",
    );
    expect(worker.snapshot().state).toBe("blocked");
    expect(hands.sent).toEqual([]);
  });

  it("does not hold for a button of the same name in another app or window", async () => {
    const elsewhere = observation(
      [
        element(1, { title: "Cancel" }),
        element(2, { title: "Delete" }),
        warning,
      ],
      {
        surfaceEpoch: 2,
        app: {
          name: "Photos",
          bundleId: "com.apple.Photos",
          window: "Library",
        },
      },
    );
    const { worker, hands, said, waiting } = setup([press, press, done], {
      screens: [dialog(1), dialog(2), elsewhere],
    });
    await worker.submit("r1", "Delete it");
    await waiting();
    await worker.answer("yes");
    await waiting();
    // Another app is in front now. Its "Delete" is another deletion: the person is asked.
    expect(questions(said)).toBe(2);
    expect(hands.sent).toEqual([]);
    worker.stop();
  });

  it("does not hold for another action, nor after a minute", async () => {
    const other = observation(
      [
        element(1, { title: "Cancel" }),
        element(2, { title: "Remove" }),
        warning,
      ],
      { surfaceEpoch: 2 },
    );
    const changed = setup([press, press, done], {
      screens: [dialog(1), dialog(2), other],
    });
    await changed.worker.submit("r1", "Delete it");
    await changed.waiting();
    await changed.worker.answer("yes");
    await changed.waiting();
    // The screen now has another button under that number: a new question, for its name.
    expect(changed.worker.snapshot().message).toMatch(
      /^Click "Remove" in Notes\?/,
    );
    expect(changed.hands.sent).toEqual([]);
    changed.worker.stop();

    const late = setup(
      [
        press,
        () => {
          late.clock.now += 61_000;
          return press;
        },
        done,
      ],
      { screens: [dialog(1), dialog(2), dialog(2)] },
    );
    await late.worker.submit("r1", "Delete it");
    await late.waiting();
    await late.worker.answer("yes");
    await late.waiting();
    expect(questions(late.said)).toBe(2);
    expect(late.hands.sent).toEqual([]);
    late.worker.stop();
  });
});

describe("a quit by name", () => {
  const quit: Action = { kind: "quit_app", name: "TextEdit" };
  const edited = observation([element(1, { title: "Save" })], {
    app: {
      name: "TextEdit",
      bundleId: "com.apple.TextEdit",
      window: "Report \u2014 Edited",
    },
  });
  it("quits with no question when the app shows no unsaved work, and needs no look at a window", async () => {
    const { worker, hands, said } = setup([quit, done]);
    await worker.submit("r1", "Quit TextEdit");
    await worker.idle();
    expect(hands.sent).toEqual([{ kind: "quit_app", name: "TextEdit" }]);
    expect(said).toEqual(["Done. The note is saved."]);
    expect(worker.snapshot().state).toBe("completed");
  });
  it("asks while the app shows unsaved changes, and sends the quit after a yes", async () => {
    const { worker, hands, waiting } = setup([quit, done], {
      screens: [edited],
    });
    await worker.submit("r1", "Quit TextEdit");
    await waiting();
    expect(worker.snapshot().message).toBe(
      'Quit TextEdit? "Report \u2014 Edited" shows changes that are not saved, which can be lost. Say yes or no.',
    );
    expect(hands.sent).toEqual([]);
    await worker.answer("yes");
    await worker.idle();
    expect(hands.sent).toEqual([{ kind: "quit_app", name: "TextEdit" }]);
    expect(worker.snapshot().state).toBe("completed");
  });
  it("tells the planner when the app stayed open", async () => {
    const { worker, hands, planner } = setup([quit, done]);
    hands.answer = (command) =>
      command.kind === "quit_app" ? { ok: false, error: "failed" } : undefined;
    await worker.submit("r1", "Quit TextEdit");
    await worker.idle();
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "the quit was sent, but the app still runs: it may ask something first. Look at the screen.",
    );
  });
  it("sends nothing after a no", async () => {
    const { worker, hands, waiting } = setup([quit, done], {
      screens: [edited],
    });
    await worker.submit("r1", "Quit TextEdit");
    await waiting();
    await worker.answer("no");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().state).toBe("canceled");
  });
});

describe("typed text and the focus", () => {
  it("tells the planner when no text field had the focus, and says ok when one had", async () => {
    // No element of this screen has the focus.
    const nowhere = setup([{ kind: "type", text: "hello" }, done]);
    await nowhere.worker.submit("r1", "Write hello");
    await nowhere.worker.idle();
    expect(nowhere.hands.sent).toEqual([{ kind: "type", text: "hello" }]);
    expect(nowhere.planner.inputs[1]!.history[0]!.outcome).toBe(
      "sent, but no text field had the focus. Look for the text on the next screen: it may not be there.",
    );
    // The journal keeps one word, as for every step.
    expect(nowhere.journal.get("r1")!.steps[0]!.outcome).toBe("ok");
    // A text field has the focus: the text went there.
    const field = observation([
      element(1, { title: "Note", role: "AXTextArea", focused: true }),
    ]);
    const there = setup([{ kind: "type", text: "hello" }, done], {
      screens: [field],
    });
    await there.worker.submit("r1", "Write hello");
    await there.worker.idle();
    expect(there.planner.inputs[1]!.history[0]!.outcome).toBe("ok");
  });
  it("says ok for text typed into a cell, a sheet, a canvas or a web editor with the focus", async () => {
    for (const role of [
      "AXCell",
      "AXTable",
      "AXGrid",
      "AXLayoutArea",
      "AXWebArea",
      "AXScrollArea",
    ]) {
      const sheet = observation([
        element(1, { title: "Name Box", role: "AXComboBox", value: "A1" }),
        element(2, { title: "A1", role, focused: true }),
      ]);
      const { worker, planner, hands } = setup(
        [{ kind: "type", text: "10" }, done],
        { screens: [sheet] },
      );
      await worker.submit("r1", "Type 10 in A1");
      await worker.idle();
      expect(hands.sent, role).toEqual([{ kind: "type", text: "10" }]);
      expect(planner.inputs[1]!.history[0]!.outcome, role).toBe("ok");
    }
  });
  it("passes the person's request to the checks: a send that was asked for needs no question", async () => {
    const screen = observation([element(1, { title: "Send" })]);
    const said = setup([{ kind: "click_element", element: 1 }, done], {
      screens: [screen],
    });
    await said.worker.submit("r1", "Reply to Sam that I am late, and send it");
    await said.worker.idle();
    expect(said.worker.snapshot().state).toBe("completed");
    expect(said.hands.sent.map((command) => command.kind)).toEqual(["click"]);
    const other = setup([{ kind: "click_element", element: 1 }, done], {
      screens: [screen],
    });
    await other.worker.submit("r1", "Read my messages");
    await other.waiting();
    expect(other.worker.snapshot().message).toBe(
      'Click "Send" in Notes? It sends as you to other people. Say yes or no.',
    );
    expect(other.hands.sent).toEqual([]);
    other.worker.stop();
  });
  it("closes a window, a banner and a dialog with no question", async () => {
    const screen = observation([
      element(1, { title: "Close" }),
      element(2, { title: "OK" }),
    ]);
    const { worker, hands, said } = setup(
      [
        { kind: "click_element", element: 1 },
        { kind: "key", combo: "cmd+w" },
        { kind: "click_element", element: 2 },
        done,
      ],
      { screens: [screen] },
    );
    await worker.submit("r1", "Tidy up the screen");
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "click",
      "key",
      "click",
    ]);
    expect(said).toEqual(["Done. The note is saved."]);
  });
});

describe("a look that fails", () => {
  it("is tried once more after a short wait, and the planner then has the screen", async () => {
    const { worker, hands, planner } = setup([done]);
    let failures = 1;
    hands.answer = (command) =>
      command.kind === "observe" && command.image && failures-- > 0
        ? { ok: false, error: "failed" }
        : undefined;
    await worker.submit("r1", "What is in front?");
    await worker.idle();
    expect(hands.commands.map((command) => command.kind)).toEqual([
      "observe",
      "wait",
      "observe",
    ]);
    expect(hands.commands[1]).toEqual({ kind: "wait", ms: 300 });
    expect(planner.inputs).toHaveLength(1);
    expect(planner.inputs[0]!.observation).not.toBeNull();
    expect(worker.snapshot().state).toBe("completed");
  });
  it("goes to the planner without the screen only after the second look failed too", async () => {
    const { worker, hands, planner } = setup([done]);
    hands.answer = (command) =>
      command.kind === "observe" ? { ok: false, error: "failed" } : undefined;
    await worker.submit("r1", "What is in front?");
    await worker.idle();
    // Each turn of the planner has the two looks before it.
    expect(hands.commands.slice(0, 3).map((command) => command.kind)).toEqual([
      "observe",
      "wait",
      "observe",
    ]);
    expect(planner.inputs[0]!.observation).toBeNull();
  });
});

describe("the person takes over", () => {
  const interrupted = (hands: FakeHands) => {
    hands.answer = (command) =>
      command.kind === "click" ? { interrupted: true } : undefined;
  };
  // An action that was held back for the person: the pause says what it was.
  const held = (wanted: string) =>
    `You are using the Mac, so I paused. Next I wanted to ${wanted}. Your next message goes on with it.`;
  it("pauses, and any next message goes on: it needs no magic word", async () => {
    const { worker, hands, waiting, said, planner } = setup([click, done]);
    interrupted(hands);
    await worker.submit("r1", "Click it");
    await waiting();
    expect(worker.snapshot().message).toBe(
      "You moved the mouse or pressed a key, so I paused. Your next message goes on with it.",
    );
    expect(said).toHaveLength(1);
    expect(kinds(hands.commands)).toEqual(["observe", "look", "click"]);
    expect((await worker.answer("hmm")).message).toBe(
      "Got it. I go on with the task and take that into it.",
    );
    await worker.idle();
    expect(planner.inputs.at(-1)).toMatchObject({ guidance: ["hmm"] });
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
    expect(worker.snapshot().message).toBe(held('click "Save"'));
    worker.stop();
  });
  // The person works on the Mac while the worker looks at the screen to plan.
  const duringTheLook = (hands: FakeHands, times = 1) => {
    let left = times;
    hands.answer = (command) =>
      command.kind === "observe" && command.image && left-- > 0
        ? { interrupted: true }
        : undefined;
  };
  it("does not pause a request that only looks and answers", async () => {
    const { worker, hands, said } = setup([done]);
    duringTheLook(hands);
    await worker.submit("r1", "What is in front?");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(hands.sent).toEqual([]);
    expect(said).toEqual(["Done. The note is saved."]);
  });
  it("pauses before the next input, and goes on after continue", async () => {
    const { worker, hands, planner, waiting } = setup([click, click, done]);
    duringTheLook(hands);
    await worker.submit("r1", "Click it");
    await waiting();
    // Nothing went out: the question comes before the click.
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().message).toBe(held('click "Save"'));
    expect((await worker.answer("continue")).message).toBe("Continuing.");
    await worker.idle();
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "not sent: The person is using the Mac.",
    );
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(worker.snapshot().state).toBe("completed");
  });
  const shop = page([pageElement(5, { label: "Next" })]);
  it("lets a wait and a reading of the page through, and pauses before the input after them", async () => {
    const browser = new FakeBrowser(shop);
    const { worker, hands, waiting } = setup(
      [{ kind: "wait", ms: 200 }, { kind: "browser_read" }, click, done],
      { browser },
    );
    // The person is there at each look.
    duringTheLook(hands, 9);
    await worker.submit("r1", "Wait, read, then click");
    await waiting();
    expect(browser.calls).toEqual(["read"]);
    // The wait ran, and no input went out.
    const ran = hands.commands.map((command) => command.kind);
    expect(ran).toContain("wait");
    expect(ran).not.toContain("click");
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().message).toBe(held('click "Save"'));
    worker.stop();
  });
  it("keeps the person's input during a wait for the next input", async () => {
    const { worker, hands, waiting } = setup([
      { kind: "wait", ms: 200 },
      click,
      done,
    ]);
    hands.answer = (command) =>
      command.kind === "wait" ? { interrupted: true } : undefined;
    await worker.submit("r1", "Wait, then click");
    await waiting();
    // The wait did not pause the request. The click after it did.
    expect(hands.commands.map((command) => command.kind)).toEqual([
      "observe",
      "wait",
      "observe",
    ]);
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().message).toBe(held('click "Save"'));
    worker.stop();
  });
  it("pauses before a click on a page too", async () => {
    const browser = new FakeBrowser(shop);
    const { worker, hands, waiting } = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 5 }, done],
      { browser },
    );
    duringTheLook(hands, 9);
    await worker.submit("r1", "Next");
    await waiting();
    expect(browser.calls).toEqual(["read"]);
    expect(worker.snapshot().message).toBe(held('click "Next" on the page'));
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

describe("what the person says while a task runs", () => {
  const taken = "Got it. I take that into the task that runs.";
  const busy = /already running/;
  /** A step of the planner that waits until the test lets it go on. */
  const held = (action: Action) => {
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    return {
      step: async () => {
        await gate;
        return action;
      },
      release: () => release(),
    };
  };
  /** A task whose planner is choosing its first action. */
  const running = async (
    script: Script,
    options: Parameters<typeof setup>[1] = {},
    goal = "Open the editor",
  ) => {
    const made = setup(script, options);
    await made.worker.submit("r1", goal);
    await until(() => made.planner.inputs.length === 1);
    return made;
  };

  it("is taken into that task and not refused: kept in order, in the journal, and with the planner at its next step", async () => {
    const first = held({ kind: "wait", ms: 0 });
    const { worker, planner, journal, hands, clock } = await running([
      first.step,
      done,
    ]);
    expect(
      (await worker.submit("r2", "Can you open it in the browser?")).message,
    ).toBe(taken);
    clock.now += 5;
    expect((await worker.submit("r3", "Okay, just press return")).message).toBe(
      taken,
    );
    // No second task was started, and nothing went out for the words.
    expect(journal.all().map((request) => request.id)).toEqual(["r1"]);
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot()).toMatchObject({
      requestId: "r1",
      state: "running",
    });
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    // The action that was being chosen had the request only. The next one
    // has the words too, the newest last.
    expect(planner.inputs[0]).not.toHaveProperty("guidance");
    expect(planner.inputs[1]).toMatchObject({
      goal: "Open the editor",
      guidance: ["Can you open it in the browser?", "Okay, just press return"],
    });
    expect(journal.get("r1")).toMatchObject({
      goal: "Open the editor",
      state: "completed",
    });
    expect(journal.guidance("r1")).toEqual([
      { id: "r2", text: "Can you open it in the browser?", at: 1_000_000 },
      { id: "r3", text: "Okay, just press return", at: 1_000_005 },
    ]);
    // The journal itself is as a build before these words reads it.
    expect(readFileSync(journal.file, "utf8")).not.toContain("guidance");
  });

  it("takes the same words once, and never starts a task from them later", async () => {
    const first = held(done);
    const { worker, planner, journal, home } = await running([
      first.step,
      done,
    ]);
    expect((await worker.submit("r2", "Use the other tab")).message).toBe(
      taken,
    );
    // The same message a second time adds nothing: it gets the state.
    expect((await worker.submit("r2", "Use the other tab")).message).toMatch(
      /^Working on: "Open the editor"/,
    );
    expect(journal.guidance("r1")).toHaveLength(1);
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    // The task is over. The words that it took in are no task of their own.
    expect((await worker.submit("r2", "Use the other tab")).message).toBe(
      "Done. The note is saved.",
    );
    expect(journal.all().map((request) => request.id)).toEqual(["r1"]);
    expect(planner.inputs).toHaveLength(2);
    // After a restart the record still knows the words.
    const restarted = setup([click, done], { home });
    expect(
      (await restarted.worker.submit("r2", "Use the other tab")).message,
    ).toMatch(/^Computer use is on\./);
    expect(restarted.hands.commands).toEqual([]);
    expect(restarted.journal.all().map((request) => request.id)).toEqual([
      "r1",
    ]);
  });

  it("drops what the planner chose before the newest words: nothing is sent for it, and the planner chooses again with them", async () => {
    // A click that was chosen without the words does not go out.
    const first = held(click);
    const stale = await running([first.step, done]);
    await stale.worker.submit("r2", "Use the other tab");
    first.release();
    await stale.worker.idle();
    expect(stale.hands.sent).toEqual([]);
    expect(stale.planner.inputs).toHaveLength(2);
    expect(stale.planner.inputs[1]).toMatchObject({
      guidance: ["Use the other tab"],
      history: [],
    });
    // The look is still the newest one: no action went out since.
    expect(kinds(stale.hands.commands)).toEqual(["observe"]);
    expect(stale.journal.get("r1")!.steps).toMatchObject([{ kind: "done" }]);
    // A task does not end on a "done" that was chosen without the words.
    const second = held(done);
    const ending = await running([second.step, click, done]);
    await ending.worker.submit("r2", "Click it again");
    second.release();
    await ending.worker.idle();
    expect(ending.planner.inputs).toHaveLength(3);
    expect(ending.hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(ending.worker.snapshot().state).toBe("completed");
  });

  it("resumes a task that paused because the person took over, with the words and under the same checks", async () => {
    const { worker, hands, planner, waiting, journal } = setup([
      click,
      click,
      done,
    ]);
    let clicks = 0;
    hands.answer = (command) =>
      command.kind === "click" && clicks++ === 0
        ? { interrupted: true }
        : undefined;
    await worker.submit("r1", "Click it");
    await waiting();
    expect(worker.snapshot()).toMatchObject({
      message:
        "You moved the mouse or pressed a key, so I paused. Your next message goes on with it.",
      waiting: "takeover",
    });
    expect((await worker.submit("r2", "Click it again")).message).toBe(
      "Got it. I go on with the task and take that into it.",
    );
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["Click it again"],
    });
    // As after "continue": a new full look, and a look just before the click.
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "look",
      "click",
      "observe",
      "look",
      "click",
      "observe",
    ]);
    expect(journal.guidance("r1")).toMatchObject([
      { id: "r2", text: "Click it again" },
    ]);
  });

  it("steers a task that waits on refusal words, stops on stop words, and those words start nothing later", async () => {
    // At the pause after the person took over: a refusal without a stop goes
    // on with the words, and a stop cancels.
    const paused = setup([click, click, done]);
    paused.hands.answer = (command) =>
      command.kind === "click" ? { interrupted: true } : undefined;
    await paused.worker.submit("r1", "Click it");
    await paused.waiting();
    expect((await paused.worker.submit("r2", "no, not that")).message).toBe(
      "Got it. I go on with the task and take that into it.",
    );
    // The next click goes out with the words, and the person takes over again.
    await until(() => paused.hands.sent.length === 2);
    await paused.waiting();
    expect(paused.planner.inputs[1]).toMatchObject({
      guidance: ["no, not that"],
    });
    expect((await paused.worker.submit("r3", "ok stop")).message).toBe(
      stoppedText,
    );
    await paused.worker.idle();
    expect(paused.hands.sent).toHaveLength(2);
    expect(paused.worker.snapshot().state).toBe("canceled");
    // The same message a second time is no new task, here and after a restart.
    expect((await paused.worker.submit("r2", "no, not that")).message).toBe(
      stoppedText,
    );
    expect(paused.journal.all()).toHaveLength(1);
    expect(paused.journal.guided("r2")).toBe("r1");
    expect(paused.journal.guided("r3")).toBe("r1");
    const restarted = setup([click, done], { home: paused.home });
    await restarted.worker.submit("r2", "no, not that");
    expect(restarted.journal.all()).toHaveLength(1);
    expect(restarted.hands.commands).toEqual([]);
    // Before an action that waits for a yes: a refusal sets it aside, is no
    // yes, and the planner chooses again with the words. Nothing is sent.
    const send = observation([element(1, { title: "Send" })]);
    const asked = setup([click, done], { screens: [send] });
    await asked.worker.submit("r1", "Finish the draft");
    await asked.waiting();
    expect(
      (await asked.worker.submit("r2", "No, do not send it")).message,
    ).toBe(
      "Got it. I take that into the task and choose again. That was no yes: what waited for one is set aside.",
    );
    await asked.worker.idle();
    expect(asked.hands.sent).toEqual([]);
    expect(asked.planner.inputs).toHaveLength(2);
    expect(asked.planner.inputs[1]).toMatchObject({
      guidance: ["No, do not send it"],
    });
    await asked.worker.submit("r2", "No, do not send it");
    expect(asked.journal.all()).toHaveLength(1);
  });

  it("stops on words that open with stop, with or without a question that waits", async () => {
    const first = held(click);
    const { worker, hands, planner, journal } = await running([
      first.step,
      click,
      done,
    ]);
    expect(
      (await worker.submit("r2", "Stop that, it is the wrong window")).message,
    ).toBe(stoppedText);
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("canceled");
    expect(hands.sent).toEqual([]);
    expect(planner.inputs).toHaveLength(1);
    // The id is in the record (without text in said), and starts nothing later.
    expect(journal.guided("r2")).toBe("r1");
    expect(journal.guidance("r1")).toEqual([]);
    await worker.submit("r2", "Stop that, it is the wrong window");
    expect(journal.all()).toHaveLength(1);
    const send = observation([element(1, { title: "Send" })]);
    const asked = setup([click, done], { screens: [send] });
    await asked.worker.submit("r1", "Finish the draft");
    await asked.waiting();
    expect((await asked.worker.submit("r2", "please cancel")).message).toBe(
      stoppedText,
    );
    expect(asked.worker.snapshot().state).toBe("canceled");
    expect(asked.hands.sent).toEqual([]);
  });

  it("pauses a task that waits when the words ask to wait, and stops when they contain stop", async () => {
    const send = observation([element(1, { title: "Send" })]);
    const unclear = ["wait, not yet", "hold on", "give me a second"];
    // The pause after the person took over: no input follows such words.
    const paused = setup([click, click, done]);
    paused.hands.answer = (command) =>
      command.kind === "click" ? { interrupted: true } : undefined;
    await paused.worker.submit("r1", "Click it");
    await paused.waiting();
    const pause = paused.worker.snapshot().message;
    for (const [index, words] of unclear.entries())
      expect((await paused.worker.submit(`p${index}`, words)).message).toBe(
        "Still paused. Your next message goes on with it.",
      );
    expect(paused.worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      message: pause,
    });
    expect(paused.hands.sent).toHaveLength(1);
    expect(paused.planner.inputs).toHaveLength(1);
    expect(paused.journal.guidance("r1")).toEqual([]);
    // A question containing "stop" stops safely.
    expect(
      (await paused.worker.submit("pstop", "why did you stop?")).message,
    ).toBe(stoppedText);
    await paused.worker.idle();
    expect(paused.hands.sent).toHaveLength(1);
    // An action that waits for a yes, and a question that the task asked:
    // words that ask to wait set aside what waited and pause without input.
    for (const [index, words] of unclear.entries()) {
      const asked = setup([click, done], { screens: [send] });
      await asked.worker.submit("r1", "Finish the draft");
      await asked.waiting();
      expect((await asked.worker.submit(`a${index}`, words)).message).toBe(
        "Paused, and what waited for your yes is set aside. Your next message goes on with it.",
      );
      await until(
        () =>
          asked.worker.snapshot().state === "waiting_for_person" &&
          asked.worker.snapshot().waiting === "takeover",
      );
      expect(asked.hands.sent).toEqual([]);
      expect(asked.planner.inputs).toHaveLength(1);
      asked.worker.stop();
      await asked.worker.idle();
    }
    const free = setup([
      { kind: "ask", question: "Which note: Shopping or Work?" },
      done,
    ]);
    await free.worker.submit("r1", "Open my note");
    await free.waiting();
    expect((await free.worker.submit("f1", "hold on")).message).toBe(
      "Paused, and the question that waited is set aside. Your next message goes on with it.",
    );
    await until(
      () =>
        free.worker.snapshot().state === "waiting_for_person" &&
        free.worker.snapshot().waiting === "takeover",
    );
    expect(free.planner.inputs).toHaveLength(1);
    free.worker.stop();
    await free.worker.idle();
  });

  it("does not send an action that was on its way when the person said more, also after a yes", async () => {
    const send = observation([element(1, { title: "Send" })]);
    const { worker, hands, waiting, planner, said } = setup(
      [click, click, done],
      { screens: [send] },
    );
    // The look just before the click waits until the test lets it go on.
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    hands.answer = async (command) => {
      if (command.kind === "observe" && !command.image) await gate;
      return {};
    };
    await worker.submit("r1", "Finish the draft");
    await waiting();
    expect((await worker.answer("yes")).message).toBe("Continuing.");
    await until(() => hands.commands.length === 2);
    // The words are no question's answer now: the yes is given, and the
    // click is on its way. It still does not go out.
    expect((await worker.submit("r2", "Use the other draft")).message).toBe(
      taken,
    );
    release();
    await until(() => planner.inputs.length === 2);
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "not sent: The person said more before it went out.",
    );
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["Use the other draft"],
    });
    // The planner chose the same click again: the yes from before the words
    // does not hold, and the person is asked again.
    await waiting();
    expect(hands.sent).toEqual([]);
    expect(
      said.filter((text) => text.startsWith('Click "Send" in Notes?')),
    ).toHaveLength(2);
    worker.stop();
  });

  it("does not type or click on a page when the person said more just before it", async () => {
    // Text for a field: the click that gives the focus went out, and the
    // person spoke before the text followed.
    const field = observation([
      element(1, { role: "AXTextField", title: "Name" }),
    ]);
    const typing = setup([{ kind: "type", text: "Ada", element: 1 }, done], {
      screens: [field],
    });
    let release = () => {};
    const gate = new Promise<void>((open) => (release = open));
    let looks = 0;
    typing.hands.answer = async (command) => {
      if (command.kind === "observe" && !command.image && looks++ === 1)
        await gate;
      return {};
    };
    await typing.worker.submit("r1", "Fill the name");
    await until(() => typing.hands.commands.length === 4);
    expect(
      (await typing.worker.submit("r2", "Use the other field")).message,
    ).toBe(taken);
    release();
    await typing.worker.idle();
    expect(typing.hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(typing.planner.inputs[1]!.history[0]!.outcome).toBe(
      "clicked the field. The text was not typed: the person said more.",
    );
    // A click on a page: the person spoke while the page was read again.
    const browser = new FakeBrowser(page([pageElement(5, { label: "Next" })]));
    let open = () => {};
    const reading = new Promise<void>((done) => (open = done));
    const read = browser.read.bind(browser);
    browser.read = async () => {
      const current = await read();
      if (browser.calls.length === 2) await reading;
      return current;
    };
    const clicking = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 5 }, done],
      { browser },
    );
    await clicking.worker.submit("r1", "Next");
    await until(() => browser.calls.length === 2);
    expect(
      (await clicking.worker.submit("r2", "Use the other tab")).message,
    ).toBe(taken);
    open();
    await clicking.worker.idle();
    expect(browser.calls).toEqual(["read", "read"]);
    expect(clicking.planner.inputs[2]!.history.at(-1)!.outcome).toBe(
      "not sent: The person said more before it went out.",
    );
  });

  it("is no yes while an action waits for one: the action is not sent, the planner chooses again, and the same action asks again", async () => {
    const send = observation([element(1, { title: "Send" })]);
    const { worker, hands, waiting, planner, journal } = setup(
      [click, click, done],
      { screens: [send] },
    );
    await worker.submit("r1", "Finish the draft");
    await waiting();
    const question = worker.snapshot().message;
    expect(question).toMatch(/^Click "Send" in Notes\?/);
    expect(worker.snapshot()).toMatchObject({ waiting: "approval" });
    // The reader of a yes takes these words for a yes. As words for the
    // task they are none: what waited is set aside, and nothing is sent.
    expect(
      (await worker.submit("r2", "Okay, just please open it")).message,
    ).toBe(
      "Got it. I take that into the task and choose again. That was no yes: what waited for one is set aside.",
    );
    await until(() => planner.inputs.length === 2);
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["Okay, just please open it"],
      history: [],
    });
    // The planner chose the same click. The person is asked again.
    await waiting();
    expect(worker.snapshot().message).toBe(question);
    expect(hands.sent).toEqual([]);
    expect(journal.get("r1")).toMatchObject({
      state: "waiting_for_person",
      steps: [],
    });
    // The answer is read as before.
    expect((await worker.answer("yes")).message).toBe("Continuing.");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("is no answer to a question that the task asked: the question is set aside, and the planner chooses again", async () => {
    const { worker, waiting, planner } = setup([
      { kind: "ask", question: "Which note: Shopping or Work?" },
      done,
    ]);
    await worker.submit("r1", "Open my note");
    await waiting();
    expect(worker.snapshot()).toMatchObject({ waiting: "question" });
    expect((await worker.submit("r2", "Open the other note")).message).toBe(
      "Got it. I take that into the task and choose again. The question that waited is set aside.",
    );
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    // The words went to the planner as the person's words, not as an answer.
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["Open the other note"],
      history: [],
    });
  });

  it("keeps the step in the record when the words come in place of the yes for a password field", async () => {
    const login = observation([
      element(1, { role: "AXTextField", title: "Name" }),
      element(2, {
        role: "AXSecureTextField",
        title: "Password",
        secure: true,
      }),
    ]);
    const afterClick = observation([
      element(1, { role: "AXTextField", title: "Name" }),
      element(2, {
        role: "AXSecureTextField",
        title: "Password",
        secure: true,
        focused: true,
      }),
    ]);
    const { worker, hands, waiting, planner, journal } = setup(
      [{ kind: "type", text: "Ada", element: 1 }, done],
      { screens: [login, login, afterClick] },
    );
    await worker.submit("r1", "Fill the name");
    await waiting();
    // The click that gives the focus went out before the question.
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(worker.snapshot().message).toMatch(/password field/);
    expect((await worker.submit("r2", "Use the other field")).message).toBe(
      "Got it. I take that into the task and choose again. That was no yes: what waited for one is set aside.",
    );
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "not typed: that is a password field. The person said something else in place of a yes.",
    );
    expect(journal.get("r1")!.steps[0]).toMatchObject({
      kind: "type",
      target: "Name",
      outcome: "set_aside",
    });
    expect(readFileSync(journal.file, "utf8")).not.toContain("Ada");
  });

  it("ends a yes that was kept for an action that was not sent: after the words the same action asks again", async () => {
    // The question changes what is in front, so the first try is held back
    // and the yes is kept for the same action.
    const dialog = (surfaceEpoch: number) =>
      observation(
        [
          element(1, { title: "Cancel" }),
          element(2, { title: "Delete" }),
          element(3, { role: "AXStaticText", title: "You cannot undo this." }),
        ],
        { surfaceEpoch },
      );
    const press: Action = { kind: "click_element", element: 2 };
    const second = held({ kind: "wait", ms: 0 });
    const { worker, hands, planner, said, waiting } = setup(
      [press, second.step, press, done],
      { screens: [dialog(1), dialog(2), dialog(2), dialog(2), dialog(2)] },
    );
    await worker.submit("r1", "Delete it");
    await waiting();
    expect((await worker.answer("yes")).message).toBe("Continuing.");
    await until(() => planner.inputs.length === 2);
    expect(planner.inputs[1]!.history[0]!.outcome).toMatch(/^not sent: /);
    expect((await worker.submit("r2", "Use the other tab")).message).toBe(
      taken,
    );
    second.release();
    await waiting();
    expect(hands.sent).toEqual([]);
    expect(
      said.filter((text) => text.startsWith('Click "Delete" in Notes?')),
    ).toHaveLength(2);
    worker.stop();
  });

  it("is not taken by a task that waited past its time limit: the task ends, and the words start nothing", async () => {
    const send = observation([element(1, { title: "Send" })]);
    const { worker, hands, waiting, clock, journal } = setup([click, done], {
      screens: [send],
    });
    await worker.submit("r1", "Finish the draft");
    await waiting();
    clock.now += 15 * 60_000;
    expect((await worker.submit("r2", "Use the other tab")).message).toBe(
      "I stopped at the time limit of 15 minutes. The task is not finished. Ask again to go on from where it is now.",
    );
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().state).toBe("blocked");
    expect(journal.get("r1")).toMatchObject({ reason: "time_limit" });
    expect(journal.guidance("r1")).toEqual([]);
    expect(journal.get("r2")).toBeNull();
    // The same message a second time is no new task either.
    expect((await worker.submit("r2", "Use the other tab")).message).toBe(
      "I stopped at the time limit of 15 minutes. The task is not finished. Ask again to go on from where it is now.",
    );
    expect(journal.get("r2")).toBeNull();
    expect(hands.commands).toHaveLength(1);
  });

  it("has a bound: eight additions for one task, 600 characters for each, and no credential", async () => {
    const first = held(done);
    const { worker, journal } = await running([first.step, done]);
    expect(
      (
        await worker.submit(
          "long",
          `Scroll down on the ${"long ".repeat(130)}page`,
        )
      ).message,
    ).toBe(
      "That is longer than 600 characters, so I did not take it into the task that runs. Say it in fewer words.",
    );
    expect(journal.guidance("r1")).toEqual([]);
    const additions = Array.from(
      { length: 8 },
      (_, index) => `Open tab ${index + 1}`,
    );
    for (const [index, words] of additions.entries())
      expect((await worker.submit(`g${index + 1}`, words)).message).toBe(taken);
    expect((await worker.submit("g9", "Open tab 9")).message).toBe(
      "This task already took 8 additions from you, and it takes no more. I go on with the task.",
    );
    // A credential is refused, and the task goes on: it pauses for nothing.
    expect(
      (
        await worker.submit(
          "secret",
          "type my password correct-horse-battery in the search box",
        )
      ).message,
    ).toBe(
      "I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself. I go on with the task.",
    );
    // A mark that the cleaning takes away does not hide a credential.
    expect(
      (
        await worker.submit(
          "hidden",
          "open the page, my password is\u200bcorrect-horse-battery",
        )
      ).message,
    ).toContain("I do not take a password or a key in the chat.");
    expect(worker.snapshot().guidance).toEqual(additions);
    expect(journal.guidance("r1")).toHaveLength(8);
    expect(readFileSync(journal.guidanceFile, "utf8")).not.toContain(
      "correct-horse",
    );
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    // Words that were refused were words for that task. They start none later.
    for (const id of ["long", "secret", "hidden", "g9"])
      await worker.submit(id, "Open tab 1");
    expect(journal.all().map((request) => request.id)).toEqual(["r1"]);
  });

  it("says the question that still waits when it refuses words for a task that waits", async () => {
    const send = observation([element(1, { title: "Send" })]);
    const { worker, hands, waiting } = setup([click, done], {
      screens: [send],
    });
    await worker.submit("r1", "Finish the draft");
    await waiting();
    const question = worker.snapshot().message;
    expect(
      (
        await worker.submit(
          "long",
          `Scroll down on the ${"long ".repeat(130)}page`,
        )
      ).message,
    ).toBe(
      `That is longer than 600 characters, so I did not take it into the task that runs. Say it in fewer words. ${question}`,
    );
    expect(
      (
        await worker.submit(
          "secret",
          "type my password correct-horse-battery in the search box",
        )
      ).message,
    ).toBe(
      `I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself. ${question}`,
    );
    expect(worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      message: question,
    });
    expect(hands.sent).toEqual([]);
    worker.stop();
  });

  it("is not taken by a task that stops or by another owner, and steers during the initial navigation", async () => {
    const first = held(done);
    const { worker, journal } = await running([first.step]);
    let owned = true;
    worker.setOwnershipGuard(() => owned);
    owned = false;
    expect((await worker.submit("r2", "Use the other tab")).message).toContain(
      "held by the current phone",
    );
    owned = true;
    worker.stop();
    expect((await worker.submit("r3", "Use the other tab")).message).toMatch(
      busy,
    );
    first.release();
    await worker.idle();
    expect(journal.guidance("r1")).toEqual([]);
    expect(journal.all()).toHaveLength(1);
    // While a one-step move is doing its initial observe, words steer: the
    // move is not made, and the planner plans with the newest words.
    const move = setup([]);
    let look = () => {};
    const seen = new Promise<void>((open) => (look = open));
    move.hands.answer = async () => {
      await seen;
      return {};
    };
    await move.worker.submitRead("m1", "Back to the app before", {
      kind: "previous_app",
    });
    await until(() => move.hands.commands.length === 1);
    expect((await move.worker.submit("m2", "Use the other tab")).message).toBe(
      taken,
    );
    look();
    await move.worker.idle();
    expect(move.hands.sent).toEqual([]);
    expect(move.planner.inputs[0]).toMatchObject({
      guidance: ["Use the other tab"],
    });
    expect(move.journal.guidance("m1")).toMatchObject([{ id: "m2" }]);
    // While the worker still reads whether a request is a navigation move, words steer.
    const choosing = held(done);
    const reading = setup([choosing.step, done]);
    let read = (_intent: { kind: "none" }) => {};
    (reading.planner as Planner).navigation = () =>
      new Promise((open) => (read = open));
    await reading.worker.submit("n1", "Back to the app before");
    expect(
      (await reading.worker.submit("n2", "Use the other tab")).message,
    ).toBe(taken);
    read({ kind: "none" });
    await until(() => reading.planner.inputs.length === 1);
    expect(reading.planner.inputs[0]).toMatchObject({
      guidance: ["Use the other tab"],
    });
    expect(
      (await reading.worker.submit("n3", "Use the first tab")).message,
    ).toBe(taken);
    choosing.release();
    await reading.worker.idle();
    expect(reading.journal.guidance("n1")).toMatchObject([
      { id: "n2" },
      { id: "n3" },
    ]);
    // Words that were read as a move that the planner can never make are a
    // request of their own: they wait, as before.
    const first2 = held(done);
    const other = await running([first2.step]);
    expect(
      (
        await other.worker.submitRead("d1", "Move one desktop right", {
          kind: "desktop",
          direction: "right",
        })
      ).message,
    ).toMatch(busy);
    first2.release();
    await other.worker.idle();
    expect(other.journal.guidance("r1")).toEqual([]);
  });

  it("comes only from the surface that started the task: the same call, or no call on both sides", async () => {
    const call = (callId: string, live = true) => ({
      callId,
      toolCallId: "turn",
      isLive: () => live,
    });
    // A task from the chat at the Mac takes no words of a call.
    const first = held(done);
    const local = await running([first.step]);
    expect(
      (await local.worker.submit("r2", "Use the other tab", call("call")))
        .message,
    ).toMatch(busy);
    first.release();
    await local.worker.idle();
    expect(local.journal.guidance("r1")).toEqual([]);
    // A task of a call takes the words of that call while it is live, and
    // not the words of the chat or of another call.
    const second = held(done);
    const phone = setup([second.step]);
    await phone.worker.submit("p1", "Open the editor", call("call"));
    await until(() => phone.planner.inputs.length === 1);
    expect(
      (await phone.worker.submit("p2", "Use the other tab")).message,
    ).toMatch(busy);
    expect(
      (await phone.worker.submit("p3", "Use the other tab", call("other")))
        .message,
    ).toMatch(busy);
    expect(
      (
        await phone.worker.submit(
          "p4",
          "Use the other tab",
          call("call", false),
        )
      ).message,
    ).toBe(stoppedText);
    expect(
      (await phone.worker.submit("p5", "Use the other tab", call("call")))
        .message,
    ).toBe(taken);
    second.release();
    await phone.worker.idle();
    expect(phone.journal.guidance("p1")).toMatchObject([{ id: "p5" }]);
    expect(phone.journal.all()).toHaveLength(1);
  });

  it("ends the free send that the request asked for, and cannot add one: after any more words a send asks", async () => {
    const screen = observation([element(1, { title: "Send" })]);
    const press: Action = { kind: "click_element", element: 1 };
    // The request asked for a send. Whatever the person says after it, in
    // whatever words, the send asks again.
    for (const words of [
      "Do not close the window",
      "Leave the window open, I want it to stay",
      "Use the other tab",
    ]) {
      const first = held({ kind: "wait", ms: 0 });
      const back = await running(
        [first.step, press, done],
        { screens: [screen] },
        "Send the reply",
      );
      expect((await back.worker.submit("r2", words)).message).toBe(taken);
      first.release();
      await back.waiting();
      expect(back.worker.snapshot().waiting).toBe("approval");
      expect(back.worker.snapshot().message).toMatch(
        /^Click "Send" in Notes\?/,
      );
      expect(back.hands.sent).toEqual([]);
      // The yes is for the same action: the look just before it reads the same words.
      await back.worker.answer("yes");
      await back.worker.idle();
      expect(back.hands.sent.map((command) => command.kind)).toEqual(["click"]);
    }
    // The request asked for no send. Later words do not take the question away.
    const second = held({ kind: "wait", ms: 0 });
    const added = await running(
      [second.step, press, done],
      { screens: [screen] },
      "Tidy up the screen",
    );
    expect((await added.worker.submit("r2", "Close the popup")).message).toBe(
      taken,
    );
    second.release();
    await added.waiting();
    expect(added.worker.snapshot().message).toMatch(/^Click "Send" in Notes\?/);
    expect(added.hands.sent).toEqual([]);
    added.worker.stop();
  });

  it("shows what the task is, what was added and why it waits, to a chat that is asked what runs", async () => {
    const first = held(done);
    const { worker } = await running([first.step, done]);
    // Before any more words: the request, and nothing else that is new.
    expect(worker.snapshot()).toEqual({
      requestId: "r1",
      configured: true,
      mode: "native",
      state: "running",
      canStop: true,
      message: 'Working on: "Open the editor". Step 0 of at most 40.',
      goal: "Open the editor",
    });
    await worker.submit("r2", "Use the other tab");
    expect(worker.snapshot()).toMatchObject({
      goal: "Open the editor",
      guidance: ["Use the other tab"],
    });
    expect(worker.snapshot()).not.toHaveProperty("waiting");
    expect(computerStatusSchema.parse(worker.status())).toMatchObject({
      state: "running",
      goal: "Open the editor",
      guidance: ["Use the other tab"],
      question: null,
    });
    first.release();
    await worker.idle();
    // A task that ended runs no more: the fields of a running task are gone.
    expect(worker.snapshot()).toEqual({
      requestId: "r1",
      configured: true,
      mode: "native",
      state: "completed",
      canStop: false,
      message: "Done. The note is saved.",
    });
    expect(worker.status()).not.toHaveProperty("guidance");
  });

  it("stops on natural stop phrases after fillers and marks, also with an object, while running or waiting on a yes", async () => {
    for (const phrase of [
      "ok stop",
      "no stop",
      "wait stop",
      "hey stop",
      "please, stop now",
      "uh, um, hold on, please, halt",
      "stop the video",
    ]) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running([first.step, click, done]);
      expect((await run.worker.submit("s1", phrase)).message).toBe(stoppedText);
      first.release();
      await run.worker.idle();
      expect(run.worker.snapshot().state).toBe("canceled");
      expect(run.hands.sent).toEqual([]);
      expect(run.planner.inputs).toHaveLength(1);
    }
    const send = observation([
      element(1, { title: "Send" }),
      element(2, { title: "Next" }),
    ]);
    const asked = setup(
      [
        { kind: "click_element", element: 1 },
        { kind: "click_element", element: 2 },
        done,
      ],
      { screens: [send] },
    );
    await asked.worker.submit("r1", "Finish the draft");
    await asked.waiting();
    expect((await asked.worker.submit("s2", "ok stop")).message).toBe(
      stoppedText,
    );
    await asked.worker.idle();
    expect(asked.worker.snapshot().state).toBe("canceled");
    expect(asked.hands.sent).toEqual([]);
    expect(asked.planner.inputs).toHaveLength(1);
  });

  it("never approves on refusal or wait words while waiting for a yes: a refusal steers, a wait pauses", async () => {
    const send = observation([
      element(1, { title: "Send" }),
      element(2, { title: "Next" }),
    ]);
    const asked = () =>
      setup(
        [
          { kind: "click_element", element: 1 },
          { kind: "click_element", element: 2 },
          done,
        ],
        { screens: [send] },
      );
    for (const words of ["ok, no, do not send it", "yes, don't click that"]) {
      const run = asked();
      await run.worker.submit("r1", "Finish the draft");
      await run.waiting();
      expect((await run.worker.submit("g1", words)).message).toBe(
        "Got it. I take that into the task and choose again. That was no yes: what waited for one is set aside.",
      );
      await run.worker.idle();
      // Send never went out: the planner chose again with the words, and only Next went.
      expect(run.planner.inputs[1]).toMatchObject({ guidance: [words] });
      expect(run.hands.sent).toHaveLength(1);
      expect(run.worker.snapshot().state).toBe("completed");
    }
    for (const words of ["ok, wait", "wait"]) {
      const run = asked();
      await run.worker.submit("r1", "Finish the draft");
      await run.waiting();
      expect((await run.worker.submit("g1", words)).message).toBe(
        "Paused, and what waited for your yes is set aside. Your next message goes on with it.",
      );
      await until(
        () =>
          run.worker.snapshot().state === "waiting_for_person" &&
          run.worker.snapshot().waiting === "takeover",
      );
      expect(run.hands.sent).toEqual([]);
      expect(run.planner.inputs).toHaveLength(1);
      run.worker.stop();
      await run.worker.idle();
    }
  });

  it("keeps a takeover pause on words that ask to wait, and goes on with any other message", async () => {
    const { worker, hands, planner, waiting, journal } = setup([
      click,
      click,
      done,
    ]);
    let clicks = 0;
    hands.answer = (command) =>
      command.kind === "click" && clicks++ === 0
        ? { interrupted: true }
        : undefined;
    await worker.submit("r1", "Click it");
    await waiting();
    const pauseReply = "Still paused. Your next message goes on with it.";
    const waits = [
      "I'm typing",
      "hold up",
      "give me a few seconds",
      "ok, I'm typing",
      "wait",
      "one sec",
    ];
    for (const [index, words] of waits.entries())
      expect((await worker.submit(`n${index}`, words)).message).toBe(
        pauseReply,
      );
    expect(worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      waiting: "takeover",
    });
    expect(hands.sent).toHaveLength(1);
    expect(planner.inputs).toHaveLength(1);
    expect(journal.guidance("r1")).toEqual([]);
    // Any other message goes on with a fresh full look before input: no
    // screen order is needed, and no magic word.
    expect(
      (await worker.submit("go", "hmm, did you click that?")).message,
    ).toBe("Got it. I go on with the task and take that into it.");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["hmm, did you click that?"],
    });
    expect(kinds(hands.commands)).toEqual([
      "observe",
      "look",
      "click",
      "observe",
      "look",
      "click",
      "observe",
    ]);
  });

  it("steers on forbidding words while running or at a free question, and pauses only on words that ask to wait", async () => {
    for (const words of [
      "no, do not send it",
      "wait, not that one",
      "don't click that",
      "never click that",
      "no",
    ]) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running([first.step, click, done]);
      expect((await run.worker.submit("h1", words)).message).toBe(taken);
      first.release();
      await run.worker.idle();
      expect(run.journal.guidance("r1")).toMatchObject([{ id: "h1" }]);
      expect(run.planner.inputs[1]).toMatchObject({ guidance: [words] });
      expect(run.worker.snapshot().state).toBe("completed");
    }
    for (const words of ["wait", "hold on", "hold off"]) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running([first.step, click, done]);
      expect((await run.worker.submit("h1", words)).message).toBe(
        "Paused. Your next message goes on with it.",
      );
      first.release();
      await run.waiting();
      expect(run.hands.sent).toEqual([]);
      expect(run.planner.inputs).toHaveLength(1);
      // A request to pause carries nothing for the planner.
      expect(run.journal.guidance("r1")).toEqual([]);
      expect((await run.worker.answer("continue")).message).toBe("Continuing.");
      await run.worker.idle();
      expect(run.planner.inputs[1]).not.toHaveProperty("guidance");
      expect(run.worker.snapshot().state).toBe("completed");
    }
    // While waiting on a free question from the planner.
    for (const words of ["no, do not send it", "don't click that"]) {
      const free = setup([
        { kind: "ask", question: "Which row?" },
        click,
        done,
      ]);
      await free.worker.submit("r1", "Pick a row");
      await free.waiting();
      expect((await free.worker.submit("h1", words)).message).toBe(
        "Got it. I take that into the task and choose again. The question that waited is set aside.",
      );
      await free.worker.idle();
      expect(free.planner.inputs[1]).toMatchObject({ guidance: [words] });
      expect(free.journal.guidance("r1")).toMatchObject([{ id: "h1" }]);
      expect(free.worker.snapshot().state).toBe("completed");
    }
    // An observation report followed by a screen order goes on with all sentences.
    for (const words of [
      "It didn't load. Use the other tab.",
      "I don't still see it open. Can you open it on Chrome?",
    ]) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running([first.step, done]);
      expect((await run.worker.submit("c1", words)).message).toBe(taken);
      first.release();
      await run.worker.idle();
      expect(run.worker.snapshot().state).toBe("completed");
      expect(run.planner.inputs[1]).toMatchObject({ guidance: [words] });
    }
  });

  it("refuses secrets hidden with zero-width characters, plain-word passwords, sentence forms and short PIN/code/OTP values", async () => {
    const first = held({ kind: "wait", ms: 0 });
    const { worker, planner, journal } = await running([first.step, done]);
    const secrets = [
      ["s1", "use key sk-\u200b1234567890abcdefghij", "1234567890abcdefghij"],
      [
        "s2",
        "my pass\u200bword is correct-horse-battery",
        "correct-horse-battery",
      ],
      ["s3", "token ghp_abc\u200bdefghijklmnopqrstuvw", "defghijklmnopqrstuvw"],
      ["s4", "my password is swordfish", "swordfish"],
      ["s5", "my pin is 1234", "1234"],
      ["s6", "use code 482913", "482913"],
      ["s7", "otp 991234", "991234"],
      ["s8", "api key: mysecretvalue", "mysecretvalue"],
      ["s9", "credential = mysecretcred", "mysecretcred"],
    ] as const;
    for (const [id, words] of secrets)
      expect((await worker.submit(id, words)).message, words).toContain(
        "I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself.",
      );
    expect(journal.guidance("r1")).toEqual([]);
    // The task paused for none of them.
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]).not.toHaveProperty("guidance");
    const onDisk = readFileSync(journal.guidanceFile, "utf8");
    for (const [, , leaked] of secrets) expect(onDisk).not.toContain(leaked);
  });

  it("does not say Got it when the task is at its step limit or past its deadline or expired authority", async () => {
    // Sequence A: step limit reached while waiting on yes_no.
    const send = observation([element(1, { title: "Send" })]);
    const atAsk = setup([click, done], { screens: [send], maxSteps: 1 });
    await atAsk.worker.submit("r1", "Finish the draft");
    await atAsk.waiting();
    const askReply = (await atAsk.worker.submit("g1", "click draft instead"))
      .message;
    expect(askReply).not.toContain("Got it");
    expect(askReply).toContain(
      "The task is at its end, so it takes no more words. Ask again when it has ended.",
    );
    expect(atAsk.hands.sent).toEqual([]);
    expect(atAsk.planner.inputs).toHaveLength(1);
    expect(atAsk.journal.guidance("r1")).toEqual([]);
    atAsk.worker.stop();
    await atAsk.worker.idle();

    // Sequence B: step limit reached while final click is in flight.
    let releaseClick = () => {};
    const clickGate = new Promise<void>((open) => (releaseClick = open));
    const atClick = setup([click, done], { maxSteps: 1 });
    atClick.hands.answer = async (command) => {
      if (command.kind === "click") await clickGate;
      return {};
    };
    await atClick.worker.submit("r1", "Click it");
    await until(() => atClick.hands.sent.length === 1);
    const clickReply = (
      await atClick.worker.submit("g1", "now click the second button")
    ).message;
    expect(clickReply).toBe(
      "The task is at its end, so it takes no more words. Ask again when it has ended.",
    );
    expect(atClick.journal.guidance("r1")).toEqual([]);
    releaseClick();
    await atClick.worker.idle();
    expect(atClick.planner.inputs).toHaveLength(1);

    // Sequence C: deadline already passed while question is null.
    const first = held(click);
    const late = await running([first.step, done], { maxMs: 60_000 });
    late.clock.now += 120_000;
    const lateReply = (await late.worker.submit("g1", "use the other tab"))
      .message;
    expect(lateReply).not.toContain("Got it");
    expect(lateReply).toMatch(/time limit/);
    first.release();
    await late.worker.idle();
    expect(late.hands.sent).toEqual([]);
    expect(late.journal.guidance("r1")).toEqual([]);

    // Sequence C2: call authority expired while question is null.
    let live = true;
    const second = held(click);
    const expired = setup([second.step, done]);
    await expired.worker.submit("r1", "Click it", {
      callId: "call",
      toolCallId: "t1",
      isLive: () => live,
    });
    await until(() => expired.planner.inputs.length === 1);
    live = false;
    const authReply = (
      await expired.worker.submit("g1", "use the other tab", {
        callId: "call",
        toolCallId: "t2",
        isLive: () => true,
      })
    ).message;
    expect(authReply).toBe(stoppedText);
    second.release();
    await expired.worker.idle();
    expect(expired.hands.sent).toEqual([]);
    expect(expired.journal.guidance("r1")).toEqual([]);
  });

  it("holds back viaHands commands with send.look false (quit_app) when newer words arrive before dispatch", async () => {
    const quit: Action = { kind: "quit_app", name: "Notes" };
    const unsaved = observation([element(1, { title: "Save" })], {
      app: {
        name: "Notes",
        bundleId: "com.apple.Notes",
        window: "Shopping \u2014 Edited",
      },
    });
    const { worker, hands, waiting, planner, said } = setup(
      [quit, quit, done],
      { screens: [unsaved] },
    );
    await worker.submit("r1", "Quit Notes");
    await waiting();
    // Same event-loop turn: answer("yes") clears question and queues act(),
    // then submit("g1", ...) adds newer words before viaHands dispatches.
    const [answered, guided] = await Promise.all([
      worker.answer("yes"),
      worker.submit("g1", "open Safari instead"),
    ]);
    expect(answered.message).toBe("Continuing.");
    expect(guided.message).toBe(taken);
    await until(() => planner.inputs.length === 2);
    expect(hands.sent).toEqual([]);
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "not sent: The person said more before it went out.",
    );
    expect(planner.inputs[1]).toMatchObject({
      guidance: ["open Safari instead"],
    });
    // The approval from before the words does not carry over.
    await waiting();
    expect(hands.sent).toEqual([]);
    expect(said.filter((text) => text.startsWith("Quit Notes?"))).toHaveLength(
      2,
    );
    worker.stop();
    await worker.idle();
  });

  it("persists ids of refused words and of a stop at the 8-addition cap so replay after restart starts nothing", async () => {
    // Sequence A: refused ids (long and secret) survive restart without writing text.
    const first = held(done);
    const refused = await running([first.step, done]);
    await refused.worker.submit(
      "g_long",
      `Scroll down on the ${"long ".repeat(130)}page`,
    );
    await refused.worker.submit(
      "g_secret",
      "open the page, my password is swordfish",
    );
    first.release();
    await refused.worker.idle();
    expect(readFileSync(refused.journal.guidanceFile, "utf8")).not.toContain(
      "swordfish",
    );
    const restartedA = setup([click, done], { home: refused.home });
    await restartedA.worker.submit("g_long", "Click Save");
    await restartedA.worker.submit("g_secret", "Click Save");
    expect(restartedA.hands.sent).toEqual([]);
    expect(restartedA.journal.all().map((r) => r.id)).toEqual(["r1"]);

    // Sequence B: stop id after 8 valid additions survives restart.
    const second = held(click);
    const capped = await running([second.step, click, done]);
    for (let n = 1; n <= 8; n++)
      expect(
        (await capped.worker.submit(`g${n}`, `Open tab ${n}`)).message,
      ).toBe(taken);
    expect((await capped.worker.submit("g_stop", "stop")).message).toBe(
      stoppedText,
    );
    second.release();
    await capped.worker.idle();
    expect(capped.journal.guided("g_stop")).toBe("r1");
    expect(capped.journal.guidance("r1")).toHaveLength(8);
    const restartedB = setup([click, done], { home: capped.home });
    await restartedB.worker.submit("g_stop", "stop");
    expect(restartedB.hands.sent).toEqual([]);
    expect(restartedB.journal.all().map((r) => r.id)).toEqual(["r1"]);
  });

  it("clear() sets aside an unreadable guidance.json so future guidance works again", async () => {
    const first = held({ kind: "wait", ms: 0 });
    const run = await running([first.step, done]);
    mkdirSync(dirname(run.journal.guidanceFile), { recursive: true });
    writeFileSync(run.journal.guidanceFile, "not json");
    expect((await run.worker.submit("g1", "Use Safari")).message).toContain(
      "could not be written",
    );
    first.release();
    await run.worker.idle();
    expect(run.worker.clear().message).toMatch(
      /^The record of computer requests could not be read\. It was set aside as \S+guidance\.unreadable-1000000\.json and is not removed\. New work can start\.$/,
    );
    const second = held(done);
    const after = setup([second.step, done], { home: run.home });
    await after.worker.submit("r2", "Open the editor");
    await until(() => after.planner.inputs.length === 1);
    expect((await after.worker.submit("g2", "Use Safari")).message).toBe(taken);
    second.release();
    await after.worker.idle();
  });

  it("round 2 blocker 1, now: at a takeover pause a question, a contradiction or a remark goes on with the words, and a stop word in it stops", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);
    const phrases = [
      "continue?",
      "ok?",
      "yes?",
      "can you continue?",
      "ok, open it, no",
      "open Safari, I'm typing",
      "click it in a few seconds",
      "open Safari, not right now",
      "go away",
      "switch off",
      "press pause",
      "hit pause",
      "go on hold",
      "click it when I say so",
      "show me what you did",
      "type faster",
      "open the door for the delivery guy",
    ];
    for (const phrase of phrases) {
      const run = setup([click, click, done], { screens: [nextScreen] });
      let clicks = 0;
      run.hands.answer = (command) =>
        command.kind === "click" && clicks++ === 0
          ? { interrupted: true }
          : undefined;
      await run.worker.submit("r1", "Click it");
      await run.waiting();
      expect((await run.worker.submit("g1", phrase)).message, phrase).toBe(
        "Got it. I go on with the task and take that into it.",
      );
      await run.worker.idle();
      // The words went to the planner, and the next click went out after a new look.
      expect(run.planner.inputs[1], phrase).toMatchObject({
        guidance: [phrase],
      });
      expect(run.hands.sent, phrase).toHaveLength(2);
      expect(run.worker.snapshot().state, phrase).toBe("completed");
    }
    for (const phrase of ["continue or stop?", "ok, continue, stop"]) {
      const run = setup([click, click, done], { screens: [nextScreen] });
      run.hands.answer = (command) =>
        command.kind === "click" ? { interrupted: true } : undefined;
      await run.worker.submit("r1", "Click it");
      await run.waiting();
      expect((await run.worker.submit("g1", phrase)).message, phrase).toBe(
        stoppedText,
      );
      await run.worker.idle();
      expect(run.worker.snapshot().state, phrase).toBe("canceled");
      expect(run.hands.sent, phrase).toHaveLength(1);
      expect(run.planner.inputs, phrase).toHaveLength(1);
    }
  });

  it("round 2 blocker 2: stops on natural, polite, or casual stop phrases while running or waiting on a free question", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);
    const runningStops = [
      "can you stop?",
      "pls stop",
      "could you stop",
      "actually stop",
      "now stop",
      "yeah stop",
      "i said stop",
      "stahp",
    ];
    for (const phrase of runningStops) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running(
        [first.step, click, done],
        { screens: [nextScreen] },
        "Work on page",
      );
      expect((await run.worker.submit("s1", phrase)).message).toBe(stoppedText);
      first.release();
      await run.worker.idle();
      expect(run.worker.snapshot().state).toBe("canceled");
      expect(run.hands.sent).toEqual([]);
    }
    for (const phrase of ["can you stop?", "pls stop", "actually stop"]) {
      const free = setup(
        [{ kind: "ask", question: "Which row?" }, click, done],
        {
          screens: [nextScreen],
        },
      );
      await free.worker.submit("r1", "Work on page");
      await free.waiting();
      expect((await free.worker.submit("s1", phrase)).message).toBe(
        stoppedText,
      );
      await free.worker.idle();
      expect(free.worker.snapshot().state).toBe("canceled");
      expect(free.hands.sent).toEqual([]);
    }
  });

  it("round 2 blocker 3, now: while running a refusal steers and a wait pauses; at a yes neither approves", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);
    const steers = [
      "no no no",
      "no, no",
      "leave it",
      "no, wrong window",
      "no thanks",
      "nah",
    ];
    for (const phrase of steers) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running(
        [first.step, click, done],
        { screens: [nextScreen] },
        "Work on page",
      );
      expect((await run.worker.submit("h1", phrase)).message, phrase).toBe(
        taken,
      );
      first.release();
      await run.worker.idle();
      expect(run.planner.inputs[1], phrase).toMatchObject({
        guidance: [phrase],
      });
      expect(run.worker.snapshot().state, phrase).toBe("completed");
    }
    const waits = [
      "not right now",
      "pause",
      "one second",
      "I'm typing",
      "give me a few seconds",
    ];
    for (const phrase of waits) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running(
        [first.step, click, done],
        { screens: [nextScreen] },
        "Work on page",
      );
      expect((await run.worker.submit("h1", phrase)).message, phrase).toBe(
        "Paused. Your next message goes on with it.",
      );
      first.release();
      await run.waiting();
      expect(run.hands.sent, phrase).toEqual([]);
      expect(run.planner.inputs, phrase).toHaveLength(1);
      run.worker.stop();
      await run.worker.idle();
    }
    // A question about how it goes gets the state, and the task goes on.
    const asked = held({ kind: "wait", ms: 0 });
    const status = await running(
      [asked.step, click, done],
      { screens: [nextScreen] },
      "Work on page",
    );
    expect(
      (await status.worker.submit("h1", "hey wait, what are you doing"))
        .message,
    ).toBe('I am starting on "Work on page", and it is not done yet.');
    asked.release();
    await status.worker.idle();
    expect(status.worker.snapshot().state).toBe("completed");
    expect(status.journal.guidance("r1")).toEqual([]);
    const approvalScreen = observation([
      element(1, { title: "Send" }),
      element(2, { title: "Next" }),
    ]);
    const approval = () =>
      setup(
        [
          { kind: "click_element", element: 1 },
          { kind: "click_element", element: 2 },
          done,
        ],
        { screens: [approvalScreen] },
      );
    // A refusal at a yes is no yes: what waited is set aside, and Send never goes.
    for (const phrase of [
      "nah",
      "leave it",
      "wrong button",
      "huh?",
      "really?",
    ]) {
      const run = approval();
      await run.worker.submit("r1", "Finish it");
      await run.waiting();
      expect((await run.worker.submit("h1", phrase)).message, phrase).toBe(
        "Got it. I take that into the task and choose again. That was no yes: what waited for one is set aside.",
      );
      await run.worker.idle();
      expect(run.planner.inputs[1], phrase).toMatchObject({
        guidance: [phrase],
      });
      expect(run.hands.sent, phrase).toHaveLength(1);
    }
    // A wait at a yes sets it aside and pauses with no input.
    for (const phrase of ["pause", "not right now"]) {
      const run = approval();
      await run.worker.submit("r1", "Finish it");
      await run.waiting();
      expect((await run.worker.submit("h1", phrase)).message, phrase).toBe(
        "Paused, and what waited for your yes is set aside. Your next message goes on with it.",
      );
      await until(
        () =>
          run.worker.snapshot().state === "waiting_for_person" &&
          run.worker.snapshot().waiting === "takeover",
      );
      expect(run.hands.sent).toEqual([]);
      expect(run.planner.inputs).toHaveLength(1);
      run.worker.stop();
      await run.worker.idle();
    }
    // "continue" at a yes is no yes: the question still waits.
    const run = approval();
    await run.worker.submit("r1", "Finish it");
    await run.waiting();
    const question = run.worker.snapshot().message;
    expect((await run.worker.submit("h1", "continue")).message).toBe(
      `That was no yes, so it still waits. ${question}`,
    );
    expect(run.worker.snapshot()).toMatchObject({
      waiting: "approval",
      message: question,
    });
    expect(run.hands.sent).toEqual([]);
    run.worker.stop();
    await run.worker.idle();
  });

  it("round 2 blocker 4: stops at once during planner.navigation or initial navigate observe with zero input, and steers or pauses otherwise", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);
    // Sequence A: stop during planner.navigation
    for (const phrase of ["ok stop", "stop"]) {
      const run = setup([click, done], { screens: [nextScreen] });
      let resolveNav = (_intent: { kind: "none" }) => {};
      (run.planner as Planner).navigation = () =>
        new Promise((resolve) => (resolveNav = resolve));
      await run.worker.submit("r1", "Click Next");
      expect((await run.worker.submit("s1", phrase)).message).toBe(stoppedText);
      expect(run.journal.guided("s1")).toBe("r1");
      resolveNav({ kind: "none" });
      await run.worker.idle();
      expect(run.worker.snapshot().state).toBe("canceled");
      expect(run.hands.sent).toEqual([]);
    }
    // Sequence B: stop during navigate() initial observe
    const navStop = setup([], { screens: [nextScreen] });
    let releaseObserve = () => {};
    const observeGate = new Promise<void>((open) => (releaseObserve = open));
    navStop.hands.answer = async (command) => {
      if (command.kind === "observe") await observeGate;
      return {};
    };
    await navStop.worker.submitRead("r1", "Switch desktop right", {
      kind: "desktop",
      direction: "right",
    });
    await until(() => navStop.hands.commands.length === 1);
    expect((await navStop.worker.submit("s1", "stop")).message).toBe(
      stoppedText,
    );
    expect(navStop.journal.guided("s1")).toBe("r1");
    releaseObserve();
    await navStop.worker.idle();
    expect(navStop.worker.snapshot().state).toBe("canceled");
    expect(navStop.hands.sent).toEqual([]);

    // Words during planner.navigation steer: the first choice has them.
    const navSteer = setup([click, done], { screens: [nextScreen] });
    let resolveNav2 = (_intent: { kind: "none" }) => {};
    (navSteer.planner as Planner).navigation = () =>
      new Promise((resolve) => (resolveNav2 = resolve));
    await navSteer.worker.submit("r1", "Click Next");
    expect((await navSteer.worker.submit("h1", "open Safari")).message).toBe(
      taken,
    );
    resolveNav2({ kind: "none" });
    await navSteer.worker.idle();
    expect(navSteer.planner.inputs[0]).toMatchObject({
      guidance: ["open Safari"],
    });
    // A wait during planner.navigation pauses so no first input goes out.
    const navHold = setup([click, done], { screens: [nextScreen] });
    let resolveNav3 = (_intent: { kind: "none" }) => {};
    (navHold.planner as Planner).navigation = () =>
      new Promise((resolve) => (resolveNav3 = resolve));
    await navHold.worker.submit("r1", "Click Next");
    expect((await navHold.worker.submit("h1", "wait")).message).toBe(
      "Paused. Your next message goes on with it.",
    );
    resolveNav3({ kind: "none" });
    await navHold.waiting();
    expect(navHold.hands.sent).toEqual([]);
    navHold.worker.stop();
    await navHold.worker.idle();
  });

  it("round 2 blocker 5, now: a wait takes effect even at step limit, 8-addition cap or unwritable guidance.json, and words that cannot be kept say so truthfully", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);

    // Sequence A: step limit during pre-action look(). A wait holds the click back.
    let releaseLook = () => {};
    const lookGate = new Promise<void>((open) => (releaseLook = open));
    const atLimit = setup([click, done], {
      screens: [nextScreen],
      maxSteps: 1,
    });
    atLimit.hands.answer = async (command) => {
      if (command.kind === "observe" && !command.image) await lookGate;
      return {};
    };
    await atLimit.worker.submit("r1", "Click Next");
    await until(() =>
      atLimit.hands.commands.some(
        (command) => command.kind === "observe" && !command.image,
      ),
    );
    expect(
      (await atLimit.worker.submit("h0", "don't click that")).message,
    ).toBe(
      "The task is at its end, so it takes no more words. Ask again when it has ended.",
    );
    expect((await atLimit.worker.submit("h1", "wait")).message).toBe(
      "Paused. Your next message goes on with it.",
    );
    releaseLook();
    await atLimit.waiting();
    expect(atLimit.hands.sent).toEqual([]);
    atLimit.worker.stop();
    await atLimit.worker.idle();

    // Sequence B: 8-addition cap. More words are not kept; a wait still pauses.
    const step1B = held({ kind: "wait", ms: 0 });
    const atCap = await running([step1B.step, click, done], {
      screens: [nextScreen],
    });
    for (let n = 1; n <= 8; n++)
      expect(
        (await atCap.worker.submit(`g${n}`, `Open tab ${n}`)).message,
      ).toBe(taken);
    expect((await atCap.worker.submit("h9", "don't click that")).message).toBe(
      "This task already took 8 additions from you, and it takes no more. I go on with the task.",
    );
    expect((await atCap.worker.submit("h10", "hold on")).message).toBe(
      "Paused. Your next message goes on with it.",
    );
    step1B.release();
    await atCap.waiting();
    expect(atCap.hands.sent).toEqual([]);
    expect(atCap.journal.guidance("r1")).toHaveLength(8);
    atCap.worker.stop();
    await atCap.worker.idle();

    // Sequence C: unwritable guidance.json. The words are not kept; a wait still pauses.
    const step1C = held({ kind: "wait", ms: 0 });
    const broken = await running([step1C.step, click, done], {
      screens: [nextScreen],
    });
    mkdirSync(dirname(broken.journal.guidanceFile), { recursive: true });
    writeFileSync(broken.journal.guidanceFile, "not json");
    expect(
      (await broken.worker.submit("h1", "don't click that")).message,
    ).toContain("could not be written");
    expect((await broken.worker.submit("h2", "one sec")).message).toBe(
      "Paused. Your next message goes on with it.",
    );
    step1C.release();
    await broken.waiting();
    expect(broken.hands.sent).toEqual([]);
    broken.worker.stop();
    await broken.worker.idle();

    // Sequence D1: a benign password-state phrase inside a prohibition steers and keeps the words.
    const step1D1 = held({ kind: "wait", ms: 0 });
    const statePhrase = await running([step1D1.step, click, done], {
      screens: [nextScreen],
    });
    expect(
      (
        await statePhrase.worker.submit(
          "h1",
          "don't click that, the password is already filled",
        )
      ).message,
    ).toBe(taken);
    step1D1.release();
    await statePhrase.worker.idle();
    expect(statePhrase.journal.guidance("r1")).toMatchObject([{ id: "h1" }]);
    expect(statePhrase.planner.inputs[1]).toMatchObject({
      guidance: ["don't click that, the password is already filled"],
    });

    // Sequence D2: a real secret inside a prohibition is never kept, and the task goes on.
    const step1D2 = held({ kind: "wait", ms: 0 });
    const secretHold = await running([step1D2.step, click, done], {
      screens: [nextScreen],
    });
    const secretReply = (
      await secretHold.worker.submit(
        "h1",
        "don't click that, my password is swordfish",
      )
    ).message;
    expect(secretReply).toContain("do not take a password");
    expect(secretReply).toContain("I go on with the task.");
    step1D2.release();
    await secretHold.worker.idle();
    expect(secretHold.worker.snapshot().state).toBe("completed");
    expect(secretHold.journal.guidance("r1")).toEqual([]);
    expect(readFileSync(secretHold.journal.guidanceFile, "utf8")).not.toContain(
      "swordfish",
    );
    const heard = secretHold.planner.inputs.flatMap(
      (input) => input.guidance ?? [],
    );
    expect(heard.join(" ")).not.toContain("swordfish");
  });

  it("round 2 blocker 6: refuses all 14 credential shapes through worker.submit without writing to disk or sending to the planner", async () => {
    const first = held({ kind: "wait", ms: 0 });
    const { worker, planner, journal } = await running([first.step, done]);
    const secrets = [
      ["b1", "my passcode's 4821", "4821"],
      ["b2", "my password's swordfish", "swordfish"],
      ["b3", "passcode 4821", "4821"],
      ["b4", 'use password "hunter2"', "hunter2"],
      ["b5", "pin 1 2 3 4", "1 2 3 4"],
      ["b6", "use pin \uff11\uff12\uff13\uff14", "\uff11\uff12\uff13\uff14"],
      [
        "b7",
        "code \uff14\uff18\uff12\uff19\uff11\uff13",
        "\uff14\uff18\uff12\uff19\uff11\uff13",
      ],
      ["b8", "password\uff1aswordfish", "swordfish"],
      ["b9", "my card number is 4532 1234 5678 9010", "4532 1234 5678 9010"],
      ["b10", "card 4532-1234-5678-9010", "4532-1234-5678-9010"],
      ["b11", "use key sk-12345678\n90abcdefghij", "90abcdefghij"],
      ["b12", "token ghp_abcdef0123\n456789abcdef01", "456789abcdef01"],
      ["b13", "my pass\u200bword\u200bis\u200bswordfish", "swordfish"],
      ["b14", "my pass\u034fword is swordfish", "swordfish"],
    ] as const;
    for (const [id, words] of secrets)
      expect((await worker.submit(id, words)).message, words).toContain(
        "I do not take a password or a key in the chat.",
      );
    expect(journal.guidance("r1")).toEqual([]);
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]).not.toHaveProperty("guidance");
    const onDisk = readFileSync(journal.guidanceFile, "utf8");
    for (const [, , leaked] of secrets) expect(onDisk).not.toContain(leaked);
  });

  it("redesign review blocker 4: gives truthful replies during in-flight navigate command and after navigate hold resumes with an order", async () => {
    // Sequence A: in-flight one-step navigation command (switch_desktop)
    let releaseSwitch = () => {};
    const switchGate = new Promise<void>((open) => (releaseSwitch = open));
    const seqA = setup([]);
    const beforeScreen = observation([element(1, { title: "Save" })], {
      surfaceEpoch: 1,
    });
    const afterScreen = observation([element(1, { title: "Save" })], {
      surfaceEpoch: 2,
    });
    seqA.hands.answer = async (command) => {
      if (command.kind === "observe") return { observation: beforeScreen };
      if (command.kind === "switch_desktop") {
        await switchGate;
        return { observation: afterScreen };
      }
      return {};
    };
    await seqA.worker.submitRead("r1", "Switch desktop right", {
      kind: "desktop",
      direction: "right",
    });
    await until(() =>
      seqA.hands.sent.some((command) => command.kind === "switch_desktop"),
    );
    const midSwitchReply = (await seqA.worker.submit("g1", "wait")).message;
    expect(midSwitchReply).not.toContain("before the first action");
    expect(midSwitchReply).not.toContain("I hold now");
    expect(midSwitchReply).toBe(
      "The task is at its end, so it takes no more words. Ask again when it has ended.",
    );
    releaseSwitch();
    await seqA.worker.idle();
    expect(seqA.worker.snapshot().state).toBe("completed");
    expect(seqA.hands.sent).toHaveLength(1);
    expect(seqA.journal.guidance("r1")).toEqual([]);

    // Sequence B: resuming a navigate() hold pause with an order resets run.navigation
    let releaseObserve = () => {};
    const observeGate = new Promise<void>((open) => (releaseObserve = open));
    let releaseClick = () => {};
    const clickGate = new Promise<void>((open) => (releaseClick = open));
    let observes = 0;
    const seqB = setup([click, done]);
    seqB.hands.answer = async (command) => {
      if (command.kind === "observe" && observes++ === 0) {
        await observeGate;
        return { observation: beforeScreen };
      }
      if (command.kind === "click") {
        await clickGate;
        return {};
      }
      return {};
    };
    await seqB.worker.submitRead("r1", "Switch desktop right", {
      kind: "desktop",
      direction: "right",
    });
    await until(() => seqB.hands.commands.length === 1);
    expect((await seqB.worker.submit("h1", "wait")).message).toBe(
      "Paused. Your next message goes on with it.",
    );
    releaseObserve();
    await seqB.waiting();
    expect((await seqB.worker.submit("g1", "Open Safari")).message).toBe(
      "Got it. I go on with the task and take that into it.",
    );
    await until(() =>
      seqB.hands.sent.some((command) => command.kind === "click"),
    );
    const secondOrderReply = (
      await seqB.worker.submit("g2", "Click the Save button")
    ).message;
    expect(secondOrderReply).toBe(taken);
    expect(seqB.journal.guidance("r1").map((g) => g.id)).toEqual(["g1", "g2"]);
    releaseClick();
    await seqB.worker.idle();
    expect(seqB.worker.snapshot().state).toBe("completed");
  });

  it("redesign review blocker 5, now: an order holding a secret while running is never kept, and the task does not pause", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);
    for (const phrase of [
      "type my password swordfish in the box",
      "type my password swordfish in the search box",
      "enter my passcode 4821 in the field",
    ]) {
      const first = held({ kind: "wait", ms: 0 });
      const run = await running([first.step, done], {
        screens: [nextScreen],
      });
      const reply = (await run.worker.submit("s1", phrase)).message;
      expect(reply, phrase).toBe(
        "I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself. I go on with the task.",
      );
      first.release();
      await run.worker.idle();
      expect(run.worker.snapshot().state).toBe("completed");
      expect(run.hands.sent, phrase).toEqual([]);
      expect(run.journal.guidance("r1")).toEqual([]);
      expect(run.planner.inputs[1]).not.toHaveProperty("guidance");
      expect(readFileSync(run.journal.guidanceFile, "utf8")).not.toContain(
        "swordfish",
      );
      expect(readFileSync(run.journal.guidanceFile, "utf8")).not.toContain(
        "4821",
      );
    }
  });

  it("redesign review blocker 6: refuses all 19 credential bypass shapes through worker.submit without writing to disk or sending to the planner", async () => {
    const first = held({ kind: "wait", ms: 0 });
    const { worker, planner, journal } = await running([first.step, done]);
    const secrets = [
      ["c1", "my password is set to hunter2", "hunter2"],
      ["c2", "the password is saved as swordfish", "swordfish"],
      ["c3", "my pin is set to 4821", "4821"],
      ["c4", 'use token "my-live-token-9876"', "my-live-token-9876"],
      ["c5", 'use api key "abc123def456"', "abc123def456"],
      ["c6", "type my secret swordfish in the box", "swordfish"],
      ["c7", "enter token abcdef123456 in the field", "abcdef123456"],
      ["c8", "my pw is swordfish", "swordfish"],
      ["c9", "pwd: hunter2", "hunter2"],
      ["c10", "my 2fa is 482913", "482913"],
      ["c11", "my ssn is 123-45-6789", "123-45-6789"],
      ["c12", "my cvv is 482", "482"],
      ["c13", "use key sk-12345678\n  90abcdefghij", "90abcdefghij"],
      ["c14", "token ghp_abcdef0123\n  456789abcdef01", "456789abcdef01"],
      ["c15", "the password for Chrome is swordfish", "swordfish"],
      ["c16", "type 4821 as the pin in the box", "4821"],
      ["c17", "my pass\u200bword\u200bis swordfish", "swordfish"],
      ["c18", "my to\u200bken is\u200babcdef123456", "abcdef123456"],
      ["c19", "my p\u200bin\u200bis 4821", "4821"],
    ] as const;
    for (const [id, words] of secrets)
      expect((await worker.submit(id, words)).message, words).toContain(
        "I do not take a password or a key in the chat.",
      );
    expect(journal.guidance("r1")).toEqual([]);
    first.release();
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]).not.toHaveProperty("guidance");
    const onDisk = readFileSync(journal.guidanceFile, "utf8");
    for (const [, , leaked] of secrets) expect(onDisk).not.toContain(leaked);
  });

  it("redesign review blocker 7, now: words that arrive while a pause is pending end it and steer", async () => {
    let releaseWait = () => {};
    const waitGate = new Promise<void>((open) => (releaseWait = open));
    const run = setup([{ kind: "wait", ms: 0 }, click, done]);
    run.hands.answer = async (command) => {
      if (command.kind === "wait") await waitGate;
      return {};
    };
    await run.worker.submit("r1", "Work on page");
    await until(() =>
      run.hands.commands.some((command) => command.kind === "wait"),
    );
    expect((await run.worker.submit("h1", "hold on")).message).toBe(
      "Paused. Your next message goes on with it.",
    );
    // The pause has not begun yet: the next message ends it, as at a pause.
    expect((await run.worker.submit("g2", "Open Safari")).message).toBe(taken);
    releaseWait();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.journal.guidance("r1").map((g) => g.id)).toEqual(["g2"]);
    expect(run.planner.inputs[1]).toMatchObject({ guidance: ["Open Safari"] });
    // A second wait before the pause began keeps it pending.
    let releaseWait2 = () => {};
    const waitGate2 = new Promise<void>((open) => (releaseWait2 = open));
    const twice = setup([{ kind: "wait", ms: 0 }, click, done]);
    twice.hands.answer = async (command) => {
      if (command.kind === "wait") await waitGate2;
      return {};
    };
    await twice.worker.submit("r1", "Work on page");
    await until(() =>
      twice.hands.commands.some((command) => command.kind === "wait"),
    );
    await twice.worker.submit("h1", "hold on");
    await twice.worker.submit("h2", "one sec");
    releaseWait2();
    await twice.waiting();
    expect(twice.worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      waiting: "takeover",
      message: "Paused. Your next message goes on with it.",
    });
    expect(twice.hands.sent).toEqual([]);
    twice.worker.stop();
    await twice.worker.idle();
  });

  it("redesign review blockers 1 and 2, now: a takeover pause goes on with mixed holds and orders as words for the task", async () => {
    const nextScreen = observation([element(1, { title: "Next" })]);
    const phrases = [
      "Hold on, I'm typing. Open Notion.",
      "Wait a minute. Click the Save button.",
      "Pause for a second. Open Chrome.",
      "Not yet. Press enter.",
      "No, don't do that right now. Close the tab.",
      "I'm not ready yet. Click the button.",
      "open Safari, hang on",
      "open Safari, give me a second",
      "click it in 5 seconds",
      "open Safari, nah",
      "open Safari, I will do it",
      "click Save, nvm",
    ];
    for (const phrase of phrases) {
      const run = setup([click, click, done], { screens: [nextScreen] });
      let clicks = 0;
      run.hands.answer = (command) =>
        command.kind === "click" && clicks++ === 0
          ? { interrupted: true }
          : undefined;
      await run.worker.submit("r1", "Click it");
      await run.waiting();
      expect((await run.worker.submit("g1", phrase)).message, phrase).toBe(
        "Got it. I go on with the task and take that into it.",
      );
      await run.worker.idle();
      expect(run.planner.inputs[1], phrase).toMatchObject({
        guidance: [phrase],
      });
      expect(run.worker.snapshot().state, phrase).toBe("completed");
    }
  });

  it("handles continue while running or at a free question with no pause, and stops even at step limit, unwritable journal, or secret text", async () => {
    // "continue" while running changes nothing with a true reply.
    const step1 = held({ kind: "wait", ms: 0 });
    const run = await running([step1.step, done]);
    expect((await run.worker.submit("c1", "continue")).message).toBe(
      "I go on with the task.",
    );
    expect(run.journal.guidance("r1")).toEqual([]);
    expect(run.journal.guided("c1")).toBe("r1");
    step1.release();
    await run.worker.idle();
    expect(run.worker.snapshot().state).toBe("completed");
    expect(run.planner.inputs[1]).not.toHaveProperty("guidance");

    // "continue" at a free question sets it aside, and the task goes on.
    const free = setup([{ kind: "ask", question: "Which row?" }, click, done]);
    await free.worker.submit("r1", "Pick a row");
    await free.waiting();
    expect((await free.worker.submit("c2", "continue")).message).toBe(
      "The question that waited is set aside, and I go on with the task.",
    );
    await free.worker.idle();
    expect(free.worker.snapshot().state).toBe("completed");
    expect(free.planner.inputs).toHaveLength(3);
    expect(free.planner.inputs[1]).not.toHaveProperty("guidance");

    // "stop" stops even when words also look like a secret, or when guidance.json is unwritable, or at step limit.
    const stepS = held(click);
    const secStop = await running([stepS.step, click, done]);
    expect(
      (await secStop.worker.submit("s1", "stop, my password is swordfish"))
        .message,
    ).toBe(stoppedText);
    stepS.release();
    await secStop.worker.idle();
    expect(secStop.worker.snapshot().state).toBe("canceled");
    expect(secStop.hands.sent).toEqual([]);
    expect(readFileSync(secStop.journal.guidanceFile, "utf8")).not.toContain(
      "swordfish",
    );

    const stepU = held(click);
    const unwritableStop = await running([stepU.step, click, done]);
    mkdirSync(dirname(unwritableStop.journal.guidanceFile), {
      recursive: true,
    });
    writeFileSync(unwritableStop.journal.guidanceFile, "not json");
    expect((await unwritableStop.worker.submit("s2", "stop")).message).toBe(
      stoppedText,
    );
    stepU.release();
    await unwritableStop.worker.idle();
    expect(unwritableStop.worker.snapshot().state).toBe("canceled");
    expect(unwritableStop.hands.sent).toEqual([]);

    // "stop" at step limit during pre-action look() stops cleanly with 0 clicks sent.
    let releaseLook = () => {};
    const lookGate = new Promise<void>((open) => (releaseLook = open));
    const atLimitStop = setup([click, done], { maxSteps: 1 });
    atLimitStop.hands.answer = async (command) => {
      if (command.kind === "observe" && !command.image) await lookGate;
      return {};
    };
    await atLimitStop.worker.submit("r1", "Click Save");
    await until(() =>
      atLimitStop.hands.commands.some(
        (command) => command.kind === "observe" && !command.image,
      ),
    );
    expect((await atLimitStop.worker.submit("s3", "stop")).message).toBe(
      stoppedText,
    );
    releaseLook();
    await atLimitStop.worker.idle();
    expect(atLimitStop.worker.snapshot().state).toBe("canceled");
    expect(atLimitStop.hands.sent).toEqual([]);
  });
});

describe("an action that is not sent, or that moves nothing", () => {
  // A session with fakes: an address stands typed in the address bar, and
  // the planner presses Return again and again.
  const front = {
    name: "Browser",
    bundleId: "com.example.browser",
    window: "New Tab",
  };
  const bar = (surfaceEpoch = 1) =>
    observation(
      [
        element(1, {
          role: "AXTextField",
          title: "Address and search bar",
          value: "example.com/app",
          focused: true,
        }),
      ],
      { app: front, surfaceEpoch },
    );
  const enter: Action = { kind: "key", combo: "return" };
  const again = (action: Action, times: number): Action[] =>
    Array.from({ length: times }, () => action);
  const wanted = 'press return in "Address and search bar"';
  const hold = (next: string) =>
    `You are using the Mac, so I paused. Next I wanted to ${next}. Your next message goes on with it.`;
  const retired =
    "The desktop or display changed. Old coordinates were retired; nothing was sent.";
  const screenChangingEnd =
    "The screen kept changing under me, so nothing was sent. Close any open menu or list in front, then ask again.";
  /** The same, when the worker waited for the screen to settle and it never did. */
  const screenChangingWaitedEnd =
    "The screen kept changing under me, also after I waited for the screen to settle, so nothing was sent. Close any open menu or list in front, then ask again.";
  const frontChangingEnd =
    "Another app or window kept coming to the front, so nothing was sent. Bring the window you want to the front, then ask again.";
  const pageUnreadEnd =
    "The browser page could not be read before I acted, so nothing was sent. Check the browser window, then ask again.";
  const told = (times: number) =>
    `This action did not work ${times} times in a row: it was not sent, or the screen did not change after it. Choose another way. If you choose the same action again now, the task ends.`;
  /** What was tried, what the screen shows, and what the person can do. */
  const ending = (
    times: number,
    what: string,
    tried = "press return",
    next = wanted,
    app = "Browser",
  ) =>
    `I tried ${times} times to ${tried}, ${what} So I stopped: the task is not finished. ${app} is in front. You can ${next} yourself, or ask me again in other words.`;
  /** The person works in another window: every look has another generation of the screen. */
  const moving = (hands: FakeHands) => {
    let epoch = 1;
    hands.answer = (command) =>
      command.kind === "observe" ? { observation: bar(++epoch) } : undefined;
  };

  // The panel refuses a click whose place lies under a window of the app in
  // front: the suggestion list of an address bar, a card.
  const covered =
    "A list or a card of the app lies over that place, so nothing was sent. Use the keyboard there (Down, Return, Escape), or press Escape to close it.";
  const coveredEnd =
    "A list or a card of the app kept lying over the place I wanted to use, so nothing was sent. Press Escape to close it, then ask again.";
  const coveredHands = (hands: FakeHands) => {
    hands.answer = (command) =>
      command.kind === "click" || command.kind === "drag"
        ? { ok: false, error: "target_not_visible" }
        : undefined;
  };

  it("tells the planner in plain words that a list or a card lies over the place of a click", async () => {
    const { worker, planner, journal, hands } = setup(
      [
        { kind: "click_element", element: 1 },
        { kind: "key", combo: "escape" },
      ],
      { screens: [bar()] },
    );
    coveredHands(hands);
    await worker.submit("r1", "Click the address bar");
    await worker.idle();
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(`not sent: ${covered}`);
    expect(journal.get("r1")!.steps[0]).toMatchObject({
      kind: "click_element",
      outcome: "not_sent",
    });
  });

  it("ends after three clicks in a row under a list or a card, with what the person can do", async () => {
    const { worker, said, journal, hands } = setup(
      again({ kind: "click_element", element: 1 }, 10),
      { settleLimit: 0, screens: [bar()] },
    );
    coveredHands(hands);
    await worker.submit("r1", "Click the address bar");
    await worker.idle();
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: coveredEnd,
    });
    expect(said).toEqual([coveredEnd]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(journal.get("r1")!.steps).toHaveLength(3);
  });

  it("counts the click before a text the same way when a list or a card lies over the field", async () => {
    // A field with no focus: a click on it goes first, and the panel refuses it.
    const field = observation(
      [element(1, { role: "AXTextField", title: "Search", value: "" })],
      { app: front, surfaceEpoch: 1 },
    );
    const { worker, said, hands, journal } = setup(
      again({ kind: "type", element: 1, text: "phone" }, 10),
      { settleLimit: 0, screens: [field] },
    );
    coveredHands(hands);
    await worker.submit("r1", "Type phone into the search box");
    await worker.idle();
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: coveredEnd,
    });
    expect(said).toEqual([coveredEnd]);
    // The text was never typed.
    expect(hands.sent.filter((command) => command.kind === "type")).toEqual([]);
    expect(journal.get("r1")!.steps.map((step) => step.outcome)).toEqual([
      "not_sent",
      "not_sent",
      "not_sent",
    ]);
  });

  it("holds at once when the person took over, and says what it wanted to do next", async () => {
    const { worker, hands, planner, journal, said } = setup(again(enter, 7), {
      screens: [bar()],
    });
    // The person types in another window: the look just before each key sees it.
    hands.answer = (command) =>
      command.kind === "observe" && !command.image
        ? { interrupted: true }
        : undefined;
    await worker.submit("r1", "Press Return on the address that you wrote");
    await until(() => said.length === 1);
    expect(said[0]).toBe(hold(wanted));
    expect(worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      message: hold(wanted),
    });
    expect(planner.inputs).toHaveLength(1);
    // Continue with the hands still on the Mac: the same hold, and still no key.
    expect((await worker.answer("continue")).message).toBe("Continuing.");
    await until(() => said.length === 2);
    expect(said[1]).toBe(hold(wanted));
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      "not sent: The person took over.",
    );
    expect((await worker.answer("stop")).message).toBe(stoppedText);
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(journal.get("r1")).toMatchObject({
      state: "canceled",
      reason: "stopped",
      steps: [
        { kind: "key", target: "return", outcome: "not_sent_person" },
        { kind: "key", target: "return", outcome: "not_sent_person" },
      ],
    });
  });

  it("holds in the same words when the hands held the key back for the person", async () => {
    const { worker, hands, journal, said } = setup(again(enter, 3), {
      screens: [bar()],
    });
    // The hands refuse an input when the person acted since the command began.
    hands.answer = (command) =>
      command.kind === "key"
        ? { ok: false, error: "refused", interrupted: true }
        : undefined;
    await worker.submit("r1", "Press Return on the address that you wrote");
    await until(() => said.length === 1);
    expect(said[0]).toBe(hold(wanted));
    worker.stop();
    await worker.idle();
    expect(journal.get("r1")!.steps).toMatchObject([
      { kind: "key", target: "return", outcome: "not_sent_person" },
    ]);

    // The same for the click that gives a field the focus before the text.
    const field = observation([
      element(1, { role: "AXTextField", title: "Address and search bar" }),
    ]);
    const typing = setup(
      [{ kind: "type", text: "example.com/app", element: 1 }, done],
      { screens: [field] },
    );
    typing.hands.answer = (command) =>
      command.kind === "click"
        ? { ok: false, error: "refused", interrupted: true }
        : undefined;
    await typing.worker.submit("r2", "Write the address");
    await until(() => typing.said.length === 1);
    expect(typing.said[0]).toBe(hold('type in "Address and search bar"'));
    // The sentence holds the name of the field, and never the text.
    expect(typing.said[0]).not.toContain("example.com");
    typing.worker.stop();
    await typing.worker.idle();
    expect(typing.hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(typing.journal.get("r2")!.steps).toMatchObject([
      {
        kind: "type",
        target: "Address and search bar",
        outcome: "not_sent_person",
      },
    ]);

    // The click went out and the text was held back: the record says clicked.
    const half = setup(
      [{ kind: "type", text: "example.com/app", element: 1 }, done],
      { screens: [field] },
    );
    half.hands.answer = (command) =>
      command.kind === "type"
        ? { ok: false, error: "refused", interrupted: true }
        : undefined;
    await half.worker.submit("r3", "Write the address");
    await until(() => half.said.length === 1);
    expect(half.said[0]).toBe(hold('type in "Address and search bar"'));
    half.worker.stop();
    await half.worker.idle();
    expect(half.journal.get("r3")!.steps).toMatchObject([
      { kind: "type", target: "Address and search bar", outcome: "clicked" },
    ]);

    // Held-back inputs for takeover do not count toward the "already did this twice" repeat prompt.
    let heldCount = 2;
    const repeat = setup([enter, enter, enter, done], { screens: [bar()] });
    repeat.hands.answer = (command) =>
      command.kind === "key" && heldCount-- > 0
        ? { ok: false, error: "refused", interrupted: true }
        : undefined;
    await repeat.worker.submit("r4", "Press Return");
    await until(() => repeat.said.length === 1);
    expect(repeat.said[0]).toBe(hold(wanted));
    await repeat.worker.answer("continue");
    await until(() => repeat.said.length === 2);
    expect(repeat.said[1]).toBe(hold(wanted));
    await repeat.worker.answer("continue");
    await repeat.worker.idle();
    expect(repeat.said).toEqual([
      hold(wanted),
      hold(wanted),
      "Done. The note is saved.",
    ]);
  });

  it("ends after three held steps in a row with the same reason, telling the planner each time", async () => {
    const { worker, hands, planner, journal, said } = setup(again(enter, 10), {
      screens: [bar()],
    });
    moving(hands);
    await worker.submit("r1", "Press Return on the address that you wrote");
    await worker.idle();
    // Three plans, not forty, and no false pause blaming the person.
    expect(planner.inputs).toHaveLength(3);
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(`not sent: ${retired}`);
    expect(planner.inputs[2]!.history[1]!.outcome).toBe(`not sent: ${retired}`);
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: screenChangingWaitedEnd,
    });
    expect(said).toEqual([screenChangingWaitedEnd]);
    expect(said.join(" ")).not.toMatch(/\bdone\b/i);
    expect(hands.sent).toEqual([]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
      steps: [
        { kind: "key", target: "return", outcome: "not_sent" },
        { kind: "key", target: "return", outcome: "not_sent" },
        { kind: "key", target: "return", outcome: "not_sent" },
      ],
    });
    // The journal keeps only the original v1 fields so older builds still read it.
    const raw = JSON.parse(readFileSync(journal.file, "utf8")) as {
      version: number;
      requests: Record<string, unknown>[];
    };
    expect(Object.keys(raw).sort()).toEqual(["requests", "version"]);
    expect(Object.keys(raw.requests[0]!).sort()).toEqual([
      "createdAt",
      "goal",
      "id",
      "reason",
      "state",
      "steps",
      "updatedAt",
    ]);
    const steps = raw.requests[0]!.steps as Record<string, unknown>[];
    expect(Object.keys(steps[0]!).sort()).toEqual([
      "at",
      "kind",
      "n",
      "outcome",
      "target",
    ]);
    expect(readFileSync(journal.file, "utf8")).not.toContain('"changed"');
  });

  it("ends after three held steps with the same reason when the planner alternates type, key and open_app", async () => {
    const write: Action = {
      kind: "type",
      text: "example.com/shop",
      element: 1,
    };
    const focusBar: Action = { kind: "key", combo: "cmd+l" };
    const openBrowser: Action = { kind: "open_app", name: "Browser" };

    // Replay 1: alternating type and key while every look changes surfaceEpoch.
    const alternating = setup(
      [write, enter, write, enter, write, enter, done],
      { screens: [bar()] },
    );
    moving(alternating.hands);
    await alternating.worker.submit(
      "r1",
      "Open the browser and find an item on example.com",
    );
    await alternating.worker.idle();
    expect(alternating.planner.inputs).toHaveLength(3);
    expect(alternating.hands.sent).toEqual([]);
    expect(alternating.said).toEqual([screenChangingWaitedEnd]);
    expect(alternating.said.join(" ")).not.toMatch(/\bdone\b/i);
    expect(alternating.journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
      steps: [
        { kind: "type", target: "Address and search bar", outcome: "not_sent" },
        { kind: "key", target: "return", outcome: "not_sent" },
        { kind: "type", target: "Address and search bar", outcome: "not_sent" },
      ],
    });

    // Replay 2: type, key cmd+l, open_app (same front window, no change), type.
    const mixed = setup(
      [write, focusBar, openBrowser, write, focusBar, openBrowser, write, done],
      { screens: [bar()] },
    );
    let epoch = 1;
    mixed.hands.answer = (command) => {
      if (command.kind === "observe") return { observation: bar(++epoch) };
      if (command.kind === "open_app")
        return {
          ok: true,
          observation: bar(++epoch),
          resolvedBundleId: front.bundleId,
        };
      return undefined;
    };
    await mixed.worker.submit("r2", "Open the browser and search example.com");
    await mixed.worker.idle();
    expect(mixed.planner.inputs).toHaveLength(4);
    expect(mixed.said).toEqual([
      "The screen kept changing under me, also after I waited for the screen to settle, so nothing more was sent. Close any open menu or list in front, then ask again.",
    ]);
    expect(mixed.journal.get("r2")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
      steps: [
        { kind: "type", target: "Address and search bar", outcome: "not_sent" },
        { kind: "key", target: "cmd+l", outcome: "not_sent" },
        { kind: "open_app", target: "Browser", outcome: "ok" },
        { kind: "type", target: "Address and search bar", outcome: "not_sent" },
      ],
    });
  });

  it("counts held steps by reason: ends on three in a row of one reason, not mixed reasons", async () => {
    const otherWindow = observation(
      [
        element(1, {
          role: "AXTextField",
          title: "Address and search bar",
          focused: true,
        }),
      ],
      { app: { ...front, window: "Other" }, surfaceEpoch: 1 },
    );
    // Three in a row where another window kept coming to the front.
    const stealing = setup(
      [enter, { kind: "key", combo: "cmd+l" }, enter, done],
      { settleLimit: 0, screens: [bar(1)] },
    );
    stealing.hands.answer = (command) =>
      command.kind === "observe"
        ? { observation: command.image ? bar(1) : otherWindow }
        : undefined;
    await stealing.worker.submit("r1", "Press Return");
    await stealing.worker.idle();
    expect(stealing.planner.inputs).toHaveLength(3);
    expect(stealing.said).toEqual([frontChangingEnd]);
    expect(stealing.journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });

    // Mixed reasons (front changed, surface retired, front changed) do not end at 3.
    let preLooks = 0;
    const varied = setup(
      [enter, { kind: "key", combo: "cmd+l" }, enter, done],
      { settleLimit: 0, screens: [bar(1)] },
    );
    varied.hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: bar(1) };
      preLooks++;
      return {
        observation: preLooks === 2 ? bar(2) : otherWindow,
      };
    };
    await varied.worker.submit("r2", "Press Return");
    await varied.worker.idle();
    expect(varied.worker.snapshot().state).toBe("completed");
  });

  it("tells the planner after three tries that changed nothing, and ends when it chooses the same again", async () => {
    const { worker, hands, planner, journal, said } = setup(
      [...again(enter, 4), done],
      { screens: [bar()] },
    );
    await worker.submit("r1", "Type example.com/app in the address bar");
    // No question comes before the third time: the row tells the planner.
    await worker.idle();
    expect(hands.sent).toEqual(again(enter, 3));
    expect(planner.inputs).toHaveLength(4);
    // After two tries the planner reads no more than before. After three it is told.
    expect(planner.inputs[2]!.history.at(-1)!.outcome).toBe("ok");
    expect(planner.inputs[3]!.history.at(-1)!.outcome).toBe(
      `${told(3)} Last outcome: ok`,
    );
    const end = ending(3, "and I saw no change on the screen after it.");
    expect(worker.snapshot()).toMatchObject({ state: "blocked", message: end });
    expect(said).toEqual([end]);
    expect(said.join(" ")).not.toMatch(/\bdone\b/i);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
      steps: [
        { kind: "key", target: "return", outcome: "ok" },
        { kind: "key", target: "return", outcome: "ok" },
        { kind: "key", target: "return", outcome: "ok" },
        { kind: "key", target: "return", outcome: "not_sent_repeat" },
      ],
    });
  });

  it("counts tries that went out and tries that were not sent in one row, and says how many of each", async () => {
    const { worker, hands, planner, journal, said } = setup(
      [...again(enter, 4), done],
      { screens: [bar()] },
    );
    // The look just before the second key shows another window in front.
    let looks = 0;
    hands.answer = (command) =>
      command.kind === "observe" && !command.image && ++looks === 2
        ? { observation: { ...bar(), app: { ...front, window: "Other" } } }
        : undefined;
    await worker.submit("r1", "Type example.com/app in the address bar");
    await worker.idle();
    expect(hands.sent).toEqual(again(enter, 2));
    expect(planner.inputs).toHaveLength(4);
    expect(said).toEqual([
      ending(
        3,
        "and it did not work. Sent with no change on the screen that I saw: 2. Not sent: 1.",
      ),
    ]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
      steps: [
        { kind: "key", target: "return", outcome: "ok" },
        { kind: "key", target: "return", outcome: "not_sent" },
        { kind: "key", target: "return", outcome: "ok" },
        { kind: "key", target: "return", outcome: "not_sent_repeat" },
      ],
    });
  });

  it("does not count a step held for a change of the desktop or the display as a try of the action", async () => {
    const { worker, hands, planner, journal, said } = setup(
      [...again(enter, 4), done],
      { screens: [bar()] },
    );
    // The desktop changes once, just before the second key: that look and
    // every look after it have the new generation of the screen.
    let looks = 0;
    let epoch = 1;
    hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (!command.image && ++looks === 2) epoch = 2;
      return { observation: bar(epoch) };
    };
    await worker.submit("r1", "Type example.com/app in the address bar");
    await worker.idle();
    // The planner reads why, and the next look is a fresh one.
    expect(planner.inputs[2]!.history.at(-1)!.outcome).toBe(
      `not sent: ${retired}`,
    );
    expect(planner.inputs[2]!.observation?.surfaceEpoch).toBe(2);
    // The held step is no try: three keys went out before the row told the planner.
    expect(hands.sent).toEqual(again(enter, 3));
    expect(said).toEqual(["Done. The note is saved."]);
    expect(journal.get("r1")!.steps.map((step) => step.outcome)).toEqual([
      "ok",
      "not_sent",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("goes on when the planner chooses another way after it was told", async () => {
    const { worker, hands, planner, said } = setup(
      [...again(enter, 3), { kind: "click_element", element: 1 }, done],
      { screens: [bar()] },
    );
    await worker.submit("r1", "Type example.com/app in the address bar");
    await worker.idle();
    expect(said).toEqual(["Done. The note is saved."]);
    expect(planner.inputs[3]!.history.at(-1)!.outcome).toBe(
      `${told(3)} Last outcome: ok`,
    );
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "key",
      "key",
      "key",
      "click",
    ]);
    expect(worker.snapshot().state).toBe("completed");
  });

  it.each([
    ["tab", "the focus goes to the next field"],
    ["down", "only the picture shows the row that is chosen now"],
  ] as const)(
    "lets %s repeat while the screen moves with it: %s",
    async (combo, _how) => {
      const form = (step: number) =>
        observation(
          [1, 2, 3, 4, 5, 6].map((id) =>
            element(id, {
              role: "AXTextField",
              title: `Field ${id}`,
              focused: id === (combo === "tab" ? step : 1),
            }),
          ),
          combo === "tab"
            ? {}
            : { image: Buffer.from(`picture ${step}`).toString("base64") },
        );
      const key: Action = { kind: "key", combo };
      const { worker, hands, said } = setup([...again(key, 5), done], {
        screens: [form(1)],
      });
      // Each key moves something that the next look shows.
      hands.answer = (command) =>
        command.kind === "observe"
          ? { observation: form(1 + hands.sent.length) }
          : undefined;
      await worker.submit("r1", "Go to the sixth field");
      // The screen moves with each key: no question, and nothing ends the task.
      await worker.idle();
      expect(hands.sent).toEqual(again(key, 5));
      expect(said).toEqual(["Done. The note is saved."]);
      expect(worker.snapshot().state).toBe("completed");
    },
  );

  it("lets the same digit twice, different texts into one field, and scrolls and waits repeat freely", async () => {
    const keypad = (value: string) =>
      observation(
        [
          element(1, { role: "AXButton", title: "5" }),
          element(2, {
            role: "AXTextField",
            title: "Amount",
            value,
            focused: true,
          }),
        ],
        { app: front },
      );
    const fiveClick: Action = { kind: "click_element", element: 1 };
    const digitsClick = setup([fiveClick, fiveClick, done], {
      screens: [keypad("")],
    });
    digitsClick.hands.answer = (command) =>
      command.kind === "observe"
        ? { observation: keypad("5".repeat(digitsClick.hands.sent.length)) }
        : undefined;
    await digitsClick.worker.submit("r0a", "Enter 55");
    await digitsClick.worker.idle();
    expect(digitsClick.hands.sent).toHaveLength(2);
    expect(digitsClick.said).toEqual(["Done. The note is saved."]);

    const fiveKey: Action = { kind: "key", combo: "5" };
    const digitsKey = setup([fiveKey, fiveKey, done], {
      screens: [keypad("")],
    });
    digitsKey.hands.answer = (command) =>
      command.kind === "observe"
        ? { observation: keypad("5".repeat(digitsKey.hands.sent.length)) }
        : undefined;
    await digitsKey.worker.submit("r0b", "Type 55");
    await digitsKey.worker.idle();
    expect(digitsKey.hands.sent).toEqual([fiveKey, fiveKey]);
    expect(digitsKey.said).toEqual(["Done. The note is saved."]);

    const texts = setup(
      [
        ...["a", "b", "c", "d"].map((text): Action => ({
          kind: "type",
          text,
          element: 1,
        })),
        done,
      ],
      { screens: [bar()] },
    );
    await texts.worker.submit("r1", "Write four letters");
    await texts.worker.idle();
    expect(texts.hands.sent).toEqual(
      ["a", "b", "c", "d"].map((text) => ({ kind: "type", text })),
    );
    expect(texts.said).toEqual(["Done. The note is saved."]);

    const scrolls = setup([
      ...again({ kind: "scroll", direction: "down" }, 5),
      ...again({ kind: "wait", ms: 1 }, 5),
      done,
    ]);
    await scrolls.worker.submit("r1", "Scroll down and wait");
    await scrolls.worker.idle();
    expect(scrolls.hands.sent).toHaveLength(5);
    expect(scrolls.said).toEqual(["Done. The note is saved."]);
  });

  it("does not say that nothing changed when the screen could not be read", async () => {
    const link: Action = { kind: "open_url", url: "https://example.com/app" };
    const { worker, hands, journal, said } = setup(again(link, 4));
    hands.answer = (command) =>
      command.kind === "observe" ? { ok: false, error: "failed" } : undefined;
    await worker.submit("r1", "Open example.com/app and read its title");
    // With no look the worker cannot tell whether the link moved anything,
    // so it ends nothing itself, and asks nothing.
    await worker.idle();
    expect(hands.sent).toEqual(again(link, 4));
    expect(said.join(" ")).not.toMatch(/nothing changed|I already did/);
    expect(journal.get("r1")).toMatchObject({ reason: "gave_up" });
  });

  it("goes on in silence after one action that was not sent, and the journal keeps it as not sent", async () => {
    const screen = (surfaceEpoch: number) =>
      observation([element(1, { title: "Save" })], { surfaceEpoch });
    const { worker, hands, journal, said } = setup([click, click, done], {
      screens: [screen(1), screen(2)],
    });
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(said).toEqual(["Done. The note is saved."]);
    expect(journal.get("r1")).toMatchObject({
      state: "completed",
      reason: "done",
      steps: [
        { kind: "click_element", target: "Save", outcome: "not_sent" },
        { kind: "click_element", target: "Save", outcome: "ok" },
        { kind: "done", target: "", outcome: "ok" },
      ],
    });
  });

  it("counts a click on a page that was not sent, with readings of the page between", async () => {
    const browser = new FakeBrowser(page([pageElement(5, { label: "Next" })]));
    // The page cannot be read just before each click.
    let silent = false;
    const read = browser.read.bind(browser);
    browser.read = async () => {
      if (silent) throw new Error("The page did not answer.");
      return read();
    };
    const reading = (): Action => {
      silent = false;
      return { kind: "browser_read" };
    };
    const press = (): Action => {
      silent = true;
      return { kind: "browser_click", index: 5 };
    };
    const { worker, planner, journal, said } = setup(
      [reading, press, reading, press, reading, press, reading, press, done],
      { settleLimit: 0, browser },
    );
    await worker.submit("r1", "Go to the next page");
    await worker.idle();
    expect(browser.calls).not.toContain("click 5");
    // Readings send no input, so three held clicks in a row end the task at step 6.
    expect(planner.inputs).toHaveLength(6);
    expect(said).toEqual([pageUnreadEnd]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(
      journal
        .get("r1")!
        .steps.filter((step) => step.kind === "browser_click")
        .map((step) => step.outcome),
    ).toEqual(["not_sent", "not_sent", "not_sent"]);
  });

  it("ends after three tries that the panel did not run, and does not count refused tries as sent repeats", async () => {
    const { worker, hands, planner, journal, said } = setup(
      [click, click, click, click, done],
      { settleLimit: 0 },
    );
    hands.answer = (command) =>
      command.kind === "click"
        ? { ok: false, error: "stale_observation" }
        : undefined;
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(planner.inputs).toHaveLength(3);
    expect(said).toEqual([screenChangingEnd]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });

    // Two panel refusals followed by a real click do not trigger the "already did this twice" question.
    let refused = 2;
    const recovered = setup([click, click, click, done], { settleLimit: 0 });
    recovered.hands.answer = (command) =>
      command.kind === "click" && refused-- > 0
        ? { ok: false, error: "stale_observation" }
        : undefined;
    await recovered.worker.submit("r2", "Save the note");
    await recovered.worker.idle();
    expect(recovered.said).toEqual(["Done. The note is saved."]);
  });

  it("asks again for a yes when the hands held the action back for the person", async () => {
    const quit: Action = { kind: "quit_app", name: "TextEdit" };
    const edited = observation([element(1, { title: "Save" })], {
      app: {
        name: "TextEdit",
        bundleId: "com.apple.TextEdit",
        window: "Report \u2014 Edited",
      },
    });
    const { worker, hands, said } = setup([quit, quit, done], {
      screens: [edited],
    });
    let refusals = 1;
    hands.answer = (command) =>
      command.kind === "quit_app" && refusals-- > 0
        ? { ok: false, error: "refused", interrupted: true }
        : undefined;
    await worker.submit("r1", "Quit TextEdit");
    await until(() => said.length === 1);
    expect(said[0]).toMatch(/^Quit TextEdit\?/);
    await worker.answer("yes");
    // The person acted, so the panel sent nothing. The pause says what was held back.
    await until(() => said.length === 2);
    expect(said[1]).toBe(hold("quit TextEdit"));
    await worker.answer("continue");
    // Continue is no yes for the quit: the question comes again.
    await until(() => said.length === 3);
    expect(said[2]).toBe(said[0]);
    // Only the command that the panel refused was handed over.
    expect(hands.sent).toEqual([quit]);
    worker.stop();
  });

  it("gives the action one more try when the person answers after the planner was told", async () => {
    const { worker, hands, said } = setup(
      [
        ...again(enter, 3),
        { kind: "ask", question: "The page does not load. Try once more?" },
        enter,
        done,
      ],
      { screens: [bar()] },
    );
    await worker.submit("r1", "Type example.com/app in the address bar");
    await until(() => said.length === 1);
    expect(said[0]).toBe(
      "The task asks: The page does not load. Try once more?",
    );
    await worker.answer("try once more");
    // The key goes out again, with no question for a repeat.
    await worker.idle();
    expect(hands.sent).toEqual(again(enter, 4));
    expect(said).toHaveLength(2);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("does not end the task when another window is in front since the planner was told", async () => {
    let elsewhere = false;
    const { worker, hands, said } = setup(
      [
        ...again(enter, 3),
        () => {
          elsewhere = true;
          return { kind: "wait", ms: 1 };
        },
        enter,
        done,
      ],
      { screens: [bar()] },
    );
    hands.answer = (command) =>
      command.kind === "observe"
        ? {
            observation: {
              ...bar(1),
              app: elsewhere ? { ...front, window: "Example App" } : front,
            },
          }
        : undefined;
    await worker.submit("r1", "Press Return on the address that you wrote");
    // The planner was told after the third try, waited, and another window
    // came to the front. The key is tried there, with no question.
    await worker.idle();
    expect(said).toEqual(["Done. The note is saved."]);
    expect(hands.sent).toEqual(again(enter, 4));
    expect(worker.snapshot().state).toBe("completed");
  });

  it("does not end the task once the planner no longer reads the line that told it", async () => {
    const { worker, hands, said } = setup(
      [...again(enter, 3), ...again({ kind: "wait", ms: 1 }, 12), enter, done],
      { screens: [bar()] },
    );
    await worker.submit("r1", "Type example.com/app in the address bar");
    // Twelve waits later the line is out of the planner's view: the key is
    // tried again, with no question.
    await worker.idle();
    expect(said).toEqual(["Done. The note is saved."]);
    expect(hands.sent).toEqual(again(enter, 4));
    expect(worker.snapshot().state).toBe("completed");
  });

  it("keeps a browser action that may have gone out in no row", async () => {
    const browser = new FakeBrowser();
    // The browser fails after the link went out: the page did not settle.
    browser.open = async (url: string) => {
      browser.calls.push(`open ${url}`);
      throw new Error("The page did not settle.");
    };
    const link: Action = {
      kind: "browser_open",
      url: "https://example.com/app",
    };
    const { worker, said } = setup(again(link, 5), { browser });
    await worker.submit("r1", "Open example.com/app and read its title");
    // No sentence says that it was never sent, and no question comes for
    // the same address again.
    await worker.idle();
    expect(browser.calls).toHaveLength(5);
    expect(said.join(" ")).not.toMatch(/never sent|was not sent|I already did/);
  });

  it("drops a kept yes on takeover during pre-action look and enforces the shared pause rule", async () => {
    const notesDelete = observation(
      [
        element(1, { title: "Delete" }),
        element(2, { role: "AXStaticText", title: "You cannot undo this." }),
      ],
      { surfaceEpoch: 1 },
    );
    const press: Action = { kind: "click_element", element: 1 };
    const { worker, hands, said, waiting } = setup([press, press, done], {
      screens: [notesDelete],
    });
    let interruptedOnce = true;
    hands.answer = (command) => {
      if (command.kind === "observe" && !command.image && interruptedOnce) {
        interruptedOnce = false;
        return { observation: notesDelete, interrupted: true };
      }
      return undefined;
    };
    await worker.submit("r1", "Delete it");
    await waiting();
    expect(said[0]).toMatch(/^Click "Delete" in Notes\?/);
    await worker.answer("yes");
    // Pre-action look reported person takeover: pause with what it wanted next.
    await until(() => said.length === 2);
    expect(said[1]).toBe(hold('click "Delete"'));
    expect(hands.sent).toEqual([]);
    // Words that ask to wait keep the takeover pause, and send nothing.
    expect((await worker.submit("g1", "I am checking something")).message).toBe(
      "Still paused. Your next message goes on with it.",
    );
    expect(hands.sent).toEqual([]);
    const observesBefore = hands.commands.filter(
      (command) => command.kind === "observe" && command.image,
    ).length;
    await worker.answer("continue");
    // Must take a fresh look AND ask again before clicking Delete.
    await until(() => said.length === 3);
    expect(
      hands.commands.filter(
        (command) => command.kind === "observe" && command.image,
      ).length,
    ).toBeGreaterThan(observesBefore);
    expect(said[2]).toBe(said[0]);
    expect(hands.sent).toEqual([]);
    await worker.answer("yes");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("drops a kept yes from an earlier non-person hold when personNear triggers a takeover pause", async () => {
    const notesDelete = (surfaceEpoch: number) =>
      observation(
        [
          element(1, { title: "Delete" }),
          element(2, { role: "AXStaticText", title: "You cannot undo this." }),
        ],
        { surfaceEpoch },
      );
    const press: Action = { kind: "click_element", element: 1 };
    const { worker, hands, said, waiting } = setup(
      [press, press, press, done],
      { screens: [notesDelete(1)] },
    );
    let preLooks = 0;
    let planLooks = 0;
    hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) {
        planLooks++;
        // Second full look (after step 1 hold) reports person near the Mac.
        return planLooks === 2
          ? { observation: notesDelete(1), interrupted: true }
          : { observation: notesDelete(1) };
      }
      preLooks++;
      // Step 1 pre-action look bumps surfaceEpoch (non-person hold -> saves approval).
      return { observation: notesDelete(preLooks === 1 ? 2 : 1) };
    };
    await worker.submit("r1", "Delete it");
    await waiting();
    expect(said[0]).toMatch(/^Click "Delete" in Notes\?/);
    await worker.answer("yes");
    // Step 1 held by surfaceEpoch bump, step 2 planning observe saw personNear -> takeover pause.
    await until(() => said.length === 2);
    expect(said[1]).toBe(hold('click "Delete"'));
    expect(hands.sent).toEqual([]);
    await worker.answer("continue");
    // Step 3 must ask again instead of reusing step 1's kept yes.
    await until(() => said.length === 3);
    expect(said[2]).toBe(said[0]);
    expect(hands.sent).toEqual([]);
    await worker.answer("yes");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(worker.snapshot().state).toBe("completed");
  });

  it("does not say it was never sent in stuckText when a focus click went out", async () => {
    const searchField = (surfaceEpoch = 1) =>
      observation([element(1, { role: "AXTextField", title: "Search" })], {
        surfaceEpoch,
      });
    const empty = observation([], { surfaceEpoch: 1 });
    const safari = observation([], {
      app: { name: "Safari", bundleId: "com.apple.Safari", window: "Start" },
      surfaceEpoch: 1,
    });
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const { worker, hands, said, journal } = setup(
      [write, write, write, write, write, done],
      { screens: [searchField(1)] },
    );
    let preLooks = 0;
    hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: searchField(1) };
      preLooks++;
      // Step 1 pre-look: target gone.
      if (preLooks === 1) return { observation: empty };
      // Step 2 pre-look: matches, so focus click goes out; post-focus look bumps epoch (clickedOnly).
      if (preLooks === 2) return { observation: searchField(1) };
      if (preLooks === 3) return { observation: searchField(2) };
      // Step 3 pre-look: target gone.
      if (preLooks === 4) return { observation: empty };
      // Step 4 pre-look: Safari in front (frontChangedReason).
      return { observation: safari };
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual(["click"]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).not.toMatch(/never sent|Nothing was sent/i);
    expect(said[0]).toContain("Clicked the field without typing: 1.");
  });

  it("says nothing more was sent when earlier input went out before three held steps", async () => {
    const addressBar = (surfaceEpoch = 1) =>
      observation(
        [
          element(1, {
            role: "AXTextField",
            title: "Address",
            focused: true,
          }),
        ],
        { app: front, surfaceEpoch },
      );
    const write: Action = { kind: "type", element: 1, text: "example.com" };
    const { worker, hands, said, journal } = setup(
      [write, enter, enter, enter, done],
      { screens: [addressBar(1)] },
    );
    let step = 0;
    let epoch = 1;
    hands.answer = (command) => {
      if (command.kind === "type") {
        step = 1;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (step === 0) return { observation: addressBar(1) };
        return { observation: addressBar(++epoch) };
      }
      return undefined;
    };
    await worker.submit("r1", "Open example.com and read its title");
    await worker.idle();
    expect(hands.sent).toEqual([{ kind: "type", text: "example.com" }]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(said).toEqual([
      "The screen kept changing under me, also after I waited for the screen to settle, so nothing more was sent. Close any open menu or list in front, then ask again.",
    ]);
  });

  it("marks the observation stale after browser holds so the planner cannot finish on a stale screen", async () => {
    const chrome = observation([], {
      app: {
        name: "Google Chrome",
        bundleId: "com.google.Chrome",
        window: "Example",
      },
      surfaceEpoch: 1,
    });
    const notes = observation([], {
      app: { name: "Notes", bundleId: "com.apple.Notes", window: "Draft" },
      surfaceEpoch: 2,
    });
    const p1 = page([pageElement(1, { label: "Next" })]);
    const pMissing = page([]);

    // Case A: pageUnreadReason (browser.read rejects before click).
    const browserA = new FakeBrowser(p1);
    let readsA = 0;
    const readA = browserA.read.bind(browserA);
    browserA.read = async () => {
      readsA++;
      if (readsA === 2) throw new Error("tab closed");
      return readA();
    };
    const caseA = setup(
      [
        { kind: "browser_read" },
        { kind: "browser_click", index: 1 },
        { kind: "give_up", reason: "Chrome is no longer in front." },
      ],
      { browser: browserA, screens: [chrome, notes] },
    );
    await caseA.worker.submit("r1", "Click Next");
    await caseA.worker.idle();
    expect(
      caseA.hands.commands.filter(
        (command) => command.kind === "observe" && command.image,
      ),
    ).toHaveLength(2);
    expect(caseA.planner.inputs[2]!.observation?.app.name).toBe("Notes");

    // Case B: pageChangedReason (element disappeared before click).
    const browserB = new FakeBrowser(p1);
    let readsB = 0;
    const readB = browserB.read.bind(browserB);
    browserB.read = async () => {
      readsB++;
      if (readsB === 2) return pMissing;
      return readB();
    };
    const caseB = setup(
      [
        { kind: "browser_read" },
        { kind: "browser_click", index: 1 },
        { kind: "give_up", reason: "Chrome is no longer in front." },
      ],
      { browser: browserB, screens: [chrome, notes] },
    );
    await caseB.worker.submit("r2", "Click Next");
    await caseB.worker.idle();
    expect(
      caseB.hands.commands.filter(
        (command) => command.kind === "observe" && command.image,
      ),
    ).toHaveLength(2);
    expect(caseB.planner.inputs[2]!.observation?.app.name).toBe("Notes");
  });

  it("guards repeated clickedOnly focus clicks with stuck stop without a false repeat confirmation", async () => {
    const searchField = (surfaceEpoch = 1) =>
      observation([element(1, { role: "AXTextField", title: "Search" })], {
        surfaceEpoch,
      });
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const { worker, hands, said, journal } = setup(again(write, 12), {
      screens: [searchField(1)],
      maxSteps: 12,
    });
    let afterFocus = false;
    hands.answer = (command) => {
      if (command.kind === "click") {
        afterFocus = true;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (!command.image && afterFocus) {
          afterFocus = false;
          return { observation: searchField(2) };
        }
        return { observation: searchField(1) };
      }
      return undefined;
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    // 3 focus clicks happen without asking "already did this twice", then stops blocked / no_progress.
    expect(hands.sent).toHaveLength(3);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("I already did this twice in a row");
    expect(said[0]).toBe(
      'I clicked "Search" 3 times and could not type into it, so I stopped: the task is not finished. Notes is in front. You can type in "Search" yourself, or ask me again in other words.',
    );
    expect(said[0]).not.toMatch(/never sent/i);
  });

  it("merges targetGone and screenChanged in heldKey and caps alternating holds at five", async () => {
    // Part A: alternating targetGoneReason and screenChangedReason ends at 3.
    const base = observation([element(1, { title: "Save" })], {
      surfaceEpoch: 1,
    });
    const empty = observation([], { surfaceEpoch: 1 });
    const risky = observation(
      [element(1, { title: "Save" }), element(2, { title: "Delete forever" })],
      { surfaceEpoch: 1 },
    );
    const merged = setup([click, enter, click, enter, done], {
      settleLimit: 0,
      screens: [base],
      maxSteps: 12,
    });
    let preA = 0;
    merged.hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: base };
      preA++;
      // Step 1 (click): empty -> targetGoneReason.
      // Step 2 (return): a Delete forever button appeared -> risk mismatch -> screenChangedReason.
      // Step 3 (click): empty -> targetGoneReason -> 3rd in merged "target_changed" row!
      return { observation: preA === 2 ? risky : empty };
    };
    await merged.worker.submit("r1", "Save the note");
    await merged.worker.idle();
    expect(merged.hands.sent).toEqual([]);
    expect(merged.planner.inputs).toHaveLength(3);
    expect(merged.journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(merged.said).toEqual([
      "What I tried to use kept moving or disappearing before I could act, so nothing was sent. Wait until the window settles, then ask again.",
    ]);

    // Part B: alternating retiredReason and targetGoneReason with alternating actions ends at 5.
    const twoButtons = (surfaceEpoch = 1) =>
      observation(
        [element(1, { title: "Save" }), element(2, { title: "Cancel" })],
        { surfaceEpoch },
      );
    const alt = setup(
      [
        click,
        { kind: "click_element", element: 2 },
        click,
        { kind: "click_element", element: 2 },
        click,
        { kind: "click_element", element: 2 },
        done,
      ],
      { settleLimit: 0, screens: [twoButtons(1)], maxSteps: 12 },
    );
    let preB = 0;
    alt.hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: twoButtons(1) };
      preB++;
      return { observation: preB % 2 === 1 ? twoButtons(2) : empty };
    };
    await alt.worker.submit("r2", "Click buttons");
    await alt.worker.idle();
    expect(alt.hands.sent).toEqual([]);
    expect(alt.planner.inputs).toHaveLength(5);
    expect(alt.journal.get("r2")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(alt.said).toEqual([
      "5 of my last actions were held back and the window did not move on, so nothing was sent. Wait until the window settles, then ask again.",
    ]);
  });

  it("does not let no-op inputs reset heldRow, and compares open_app sameFront without the picture", async () => {
    const moreScreenChangingEnd =
      "The screen kept changing under me, so nothing more was sent. Close any open menu or list in front, then ask again.";
    const screen = (surfaceEpoch = 1, image = "aW1hZ2U=") =>
      observation([element(1, { title: "Save" })], { surfaceEpoch, image });

    // (a) Two holds + key "escape" with unchanged screen + 1 hold -> ends at step 4.
    const esc = setup(
      [click, click, { kind: "key", combo: "escape" }, click, done],
      { settleLimit: 0, screens: [screen(1)], maxSteps: 12 },
    );
    let preEsc = 0;
    esc.hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: screen(1) };
      preEsc++;
      // Step 3 (escape) succeeds; steps 1, 2, 4 bump surfaceEpoch.
      return { observation: screen(preEsc === 3 ? 1 : 2) };
    };
    await esc.worker.submit("r1", "Save");
    await esc.worker.idle();
    expect(esc.hands.sent).toEqual([{ kind: "key", combo: "escape" }]);
    expect(esc.planner.inputs).toHaveLength(4);
    expect(esc.journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(esc.said).toEqual([moreScreenChangingEnd]);

    // (b) Two holds + scroll with unchanged screen + 1 hold -> ends at step 4.
    const scroller = setup(
      [click, click, { kind: "scroll", direction: "down" }, click, done],
      { settleLimit: 0, screens: [screen(1)], maxSteps: 12 },
    );
    let preScroll = 0;
    scroller.hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: screen(1) };
      preScroll++;
      return { observation: screen(preScroll === 3 ? 1 : 2) };
    };
    await scroller.worker.submit("r2", "Save");
    await scroller.worker.idle();
    expect(scroller.hands.sent.map((command) => command.kind)).toEqual([
      "scroll",
    ]);
    expect(scroller.planner.inputs).toHaveLength(4);
    expect(scroller.journal.get("r2")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(scroller.said).toEqual([moreScreenChangingEnd]);

    // (c) Two holds + open_app("Notes") with identical app/window/elements and a 1-byte image change + 1 hold -> ends at step 4.
    const reopen = setup(
      [click, click, { kind: "open_app", name: "Notes" }, click, done],
      { settleLimit: 0, screens: [screen(1, "aW1hZ2U=")], maxSteps: 12 },
    );
    reopen.hands.answer = (command) => {
      if (command.kind === "open_app")
        return {
          ok: true,
          observation: screen(1, "aW1hZ2Uy"),
          resolvedBundleId: "com.apple.Notes",
        };
      if (command.kind === "observe")
        return {
          observation: command.image
            ? screen(1, "aW1hZ2U=")
            : screen(2, "aW1hZ2U="),
        };
      return undefined;
    };
    await reopen.worker.submit("r3", "Save");
    await reopen.worker.idle();
    expect(reopen.planner.inputs).toHaveLength(4);
    expect(reopen.journal.get("r3")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(reopen.said).toEqual([moreScreenChangingEnd]);

    // (d) Two browser_click holds (pageChangedReason) + browser_scroll returning unchanged page + 1 browser_click hold -> ends.
    const p1 = page([pageElement(1, { label: "Next" })]);
    const pEmpty = page([]);
    const browser = new FakeBrowser(p1);
    let reads = 0;
    browser.read = async () => {
      browser.calls.push("read");
      reads++;
      // Planning reads (1, 3, 5) return p1; pre-click reads (2, 4, 6) return pEmpty.
      return reads % 2 === 1 ? p1 : pEmpty;
    };
    browser.scroll = async (direction) => {
      browser.calls.push(`scroll ${direction}`);
      return p1;
    };
    const pageLoop = setup(
      [
        { kind: "browser_read" },
        { kind: "browser_click", index: 1 },
        { kind: "browser_read" },
        { kind: "browser_click", index: 1 },
        { kind: "browser_read" },
        { kind: "browser_scroll", direction: "down" },
        { kind: "browser_click", index: 1 },
        done,
      ],
      { settleLimit: 0, browser, screens: [screen(1)], maxSteps: 12 },
    );
    await pageLoop.worker.submit("r4", "Next");
    await pageLoop.worker.idle();
    expect(pageLoop.journal.get("r4")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(pageLoop.said).toEqual([
      "The page kept changing before I could act, so nothing more was sent. Wait until the page finishes loading or settles, then ask again.",
    ]);

    // (e) A real screen change after two holds still resets heldRow cleanly.
    const changedScreen = screen(1, "Y2hhbmdlZA==");
    const realMove = setup(
      [click, click, { kind: "key", combo: "escape" }, click, click, done],
      { settleLimit: 0, screens: [screen(1)], maxSteps: 12 },
    );
    let moved = false;
    let preReal = 0;
    realMove.hands.answer = (command) => {
      if (command.kind === "key") {
        moved = true;
        return { ok: true };
      }
      if (command.kind !== "observe") return undefined;
      if (command.image)
        return { observation: moved ? changedScreen : screen(1) };
      preReal++;
      return {
        observation:
          preReal === 3
            ? screen(1)
            : moved
              ? screen(2, "Y2hhbmdlZA==")
              : screen(2),
      };
    };
    await realMove.worker.submit("r5", "Save");
    await realMove.worker.idle();
    expect(realMove.worker.snapshot().state).toBe("completed");
  });

  it("does not override stop with repeated_hold when browser.read rejects on the third hold", async () => {
    const p1 = page([pageElement(5, { label: "Next" })]);
    const browser = new FakeBrowser(p1);
    let rejectThird = (_error: Error) => {};
    let readCount = 0;
    browser.read = async () => {
      browser.calls.push("read");
      readCount++;
      // Reads 1, 3, 5 are planner browser_read; reads 2, 4, 6 are pre-click reads.
      if (readCount % 2 === 1) return p1;
      if (readCount < 6) throw new Error("tab closed");
      return await new Promise<ReturnType<typeof page>>((_resolve, reject) => {
        rejectThird = reject;
      });
    };
    const reading: Action = { kind: "browser_read" };
    const press: Action = { kind: "browser_click", index: 5 };
    const { worker, journal, said } = setup(
      [reading, press, reading, press, reading, press, done],
      { browser },
    );
    await worker.submit("r1", "Click Next");
    await until(() => readCount === 6);
    worker.stop();
    rejectThird(new Error("tab closed"));
    await worker.idle();
    expect(journal.get("r1")).toMatchObject({
      state: "canceled",
      reason: "stopped",
    });
    expect(said).toEqual([]);
  });

  it("does not count focus-only clicks in the repeat streak on post-focus surface change", async () => {
    const searchField = (surfaceEpoch: number, focused = false) =>
      observation(
        [element(1, { role: "AXTextField", title: "Search", focused })],
        { surfaceEpoch },
      );
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const { worker, hands, said, journal } = setup(
      [write, write, write, done],
      {
        screens: [searchField(1)],
        maxSteps: 10,
      },
    );
    let planLooks = 0;
    let afterFocus = false;
    hands.answer = (command) => {
      if (command.kind === "click") {
        afterFocus = true;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (command.image) {
          planLooks++;
          return { observation: searchField(1, planLooks >= 3) };
        }
        if (afterFocus) {
          afterFocus = false;
          return { observation: searchField(2, false) };
        }
        return { observation: searchField(1, planLooks >= 3) };
      }
      return undefined;
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "click",
      "click",
      "type",
    ]);
    expect(said.join("\n")).not.toContain("I already did this twice in a row");
    expect(journal.get("r1")).toMatchObject({ state: "completed" });
  });

  it("does not ask a repeat question on post-focus type refusals and still stops at no_progress", async () => {
    const searchField = observation(
      [element(1, { role: "AXTextField", title: "Search" })],
      { surfaceEpoch: 1 },
    );
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const { worker, hands, said, journal } = setup(again(write, 10), {
      screens: [searchField],
      maxSteps: 10,
    });
    hands.answer = (command) => {
      if (command.kind === "type") return { ok: false, error: "refused" };
      return undefined;
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    expect(
      hands.sent.filter((command) => command.kind === "click"),
    ).toHaveLength(3);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("I already did this twice in a row");
    expect(said[0]).toBe(
      'I clicked "Search" 3 times and could not type into it, so I stopped: the task is not finished. Notes is in front. You can type in "Search" yourself, or ask me again in other words.',
    );
  });

  it("phrases mixedHeldEndText truthfully when a no-op sent action sits inside the 5-hold window", async () => {
    const notes = (surfaceEpoch = 1) =>
      observation(
        [element(1, { title: "Save" }), element(2, { title: "Cancel" })],
        { surfaceEpoch },
      );
    const empty = observation([], { surfaceEpoch: 1 });
    const safari = observation([element(1, { title: "Save" })], {
      app: { name: "Safari", bundleId: "com.apple.Safari", window: "Start" },
      surfaceEpoch: 1,
    });
    const { worker, hands, said, journal } = setup(
      [
        click,
        { kind: "click_element", element: 2 },
        click,
        { kind: "click_element", element: 2 },
        { kind: "key", combo: "escape" },
        click,
        done,
      ],
      { settleLimit: 0, screens: [notes(1)], maxSteps: 12 },
    );
    let preLooks = 0;
    hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: notes(1) };
      preLooks++;
      if (preLooks === 1 || preLooks === 4) return { observation: notes(2) };
      if (preLooks === 2 || preLooks === 6) return { observation: empty };
      if (preLooks === 3) return { observation: safari };
      return { observation: notes(1) };
    };
    await worker.submit("r1", "Click buttons");
    await worker.idle();
    expect(hands.sent).toEqual([{ kind: "key", combo: "escape" }]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(said).toEqual([
      "5 of my last actions were held back and the window did not move on, so nothing more was sent. Wait until the window settles, then ask again.",
    ]);
  });

  it("does not mark sentInput when viaBrowser fails with BrowserClosed", async () => {
    const screen = (surfaceEpoch = 1) =>
      observation([element(1, { title: "Save" })], { surfaceEpoch });
    const browser = new FakeBrowser(page([]));
    browser.open = async () => {
      throw new BrowserClosed("Chrome is not running.");
    };
    const { worker, hands, said, journal } = setup(
      [
        { kind: "browser_open", url: "https://example.com" },
        click,
        click,
        click,
        done,
      ],
      { settleLimit: 0, browser, screens: [screen(1)], maxSteps: 10 },
    );
    hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      return { observation: command.image ? screen(1) : screen(2) };
    };
    await worker.submit("r1", "Open example.com and read its title");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(browser.calls).toEqual([]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(said).toEqual([
      "The screen kept changing under me, so nothing was sent. Close any open menu or list in front, then ask again.",
    ]);
  });

  it("honors word hold and mid-task orders arriving during pre-action browser.read before counting repeated_hold", async () => {
    const p1 = page([pageElement(1, { label: "Next" })]);
    const pEmpty = page([]);
    const reading: Action = { kind: "browser_read" };
    const press: Action = { kind: "browser_click", index: 1 };

    // Variant 1: pre-click browser.read resolves with changed page after hold word.
    const browserA = new FakeBrowser(p1);
    let readsA = 0;
    let resolveThirdA = (_value: ReturnType<typeof page>) => {};
    browserA.read = async () => {
      readsA++;
      if (readsA % 2 === 1) return p1;
      if (readsA < 6) return pEmpty;
      return await new Promise<ReturnType<typeof page>>((resolve) => {
        resolveThirdA = resolve;
      });
    };
    const caseA = setup(
      [reading, press, reading, press, reading, press, done],
      { browser: browserA, maxSteps: 12 },
    );
    await caseA.worker.submit("r1", "Click Next");
    await until(() => readsA === 6);
    const holdReplyA = await caseA.worker.submit("g1", "wait, hold on");
    expect(holdReplyA.message).toBe(
      "Paused. Your next message goes on with it.",
    );
    resolveThirdA(pEmpty);
    await until(() => caseA.worker.status().state === "waiting_for_person");
    expect(caseA.worker.status()).toMatchObject({
      state: "waiting_for_person",
      question: "Paused. Your next message goes on with it.",
    });
    expect(caseA.said).toContain("Paused. Your next message goes on with it.");
    caseA.worker.stop();
    await caseA.worker.idle();

    // Variant 2: pre-click browser.read rejects after hold word.
    const browserB = new FakeBrowser(p1);
    let readsB = 0;
    let rejectThirdB = (_error: Error) => {};
    browserB.read = async () => {
      readsB++;
      if (readsB % 2 === 1) return p1;
      if (readsB < 6) throw new Error("tab closed");
      return await new Promise<ReturnType<typeof page>>((_resolve, reject) => {
        rejectThirdB = reject;
      });
    };
    const caseB = setup(
      [reading, press, reading, press, reading, press, done],
      { browser: browserB, maxSteps: 12 },
    );
    await caseB.worker.submit("r2", "Click Next");
    await until(() => readsB === 6);
    const holdReplyB = await caseB.worker.submit("g2", "hold on");
    expect(holdReplyB.message).toBe(
      "Paused. Your next message goes on with it.",
    );
    rejectThirdB(new Error("tab closed"));
    await until(() => caseB.worker.status().state === "waiting_for_person");
    expect(caseB.worker.status()).toMatchObject({
      state: "waiting_for_person",
      question: "Paused. Your next message goes on with it.",
    });
    caseB.worker.stop();
    await caseB.worker.idle();

    // Variant 3: non-hold mid-task order arrives during 3rd pre-click browser.read.
    const browserC = new FakeBrowser(p1);
    let readsC = 0;
    let resolveThirdC = (_value: ReturnType<typeof page>) => {};
    browserC.read = async () => {
      readsC++;
      if (readsC % 2 === 1) return p1;
      if (readsC < 6) return pEmpty;
      return await new Promise<ReturnType<typeof page>>((resolve) => {
        resolveThirdC = resolve;
      });
    };
    const caseC = setup(
      [reading, press, reading, press, reading, press, done],
      { browser: browserC, maxSteps: 12 },
    );
    await caseC.worker.submit("r3", "Click Next");
    await until(() => readsC === 6);
    const orderReplyC = await caseC.worker.submit("g3", "open Safari");
    expect(orderReplyC.message).toBe(
      "Got it. I take that into the task that runs.",
    );
    resolveThirdC(pEmpty);
    await caseC.worker.idle();
    expect(caseC.journal.get("r3")).toMatchObject({ state: "completed" });
    expect(
      caseC.planner.inputs.some((input) =>
        input.guidance?.includes("open Safari"),
      ),
    ).toBe(true);
  });

  it("uses action-neutral wording when held scrolls are blocked by a covering list or card", async () => {
    const listScreen = observation([element(1, { title: "List" })], {
      app: front,
      surfaceEpoch: 1,
    });
    const scroll: Action = { kind: "scroll", direction: "down", element: 1 };
    const { worker, said, journal, hands } = setup(again(scroll, 6), {
      settleLimit: 0,
      screens: [listScreen],
    });
    hands.answer = (command) =>
      command.kind === "scroll"
        ? { ok: false, error: "target_not_visible" }
        : undefined;
    await worker.submit("r1", "Scroll the list");
    await worker.idle();
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(said).toEqual([
      "A list or a card of the app kept lying over the place I wanted to use, so nothing was sent. Press Escape to close it, then ask again.",
    ]);
    expect(said[0]).not.toContain("click");
  });

  it("keeps the stuck repeat warning when a mid-task order arrives after remind", async () => {
    const refreshScreen = observation([element(1, { title: "Refresh" })], {
      surfaceEpoch: 1,
    });
    let releasePlan4 = () => {};
    let planCalls = 0;
    const { worker, hands, planner, said, journal } = setup(
      [
        click,
        click,
        click,
        async () => {
          planCalls++;
          if (planCalls === 1) {
            await new Promise<void>((resolve) => {
              releasePlan4 = resolve;
            });
          }
          return click;
        },
        click,
        done,
      ],
      { screens: [refreshScreen], maxSteps: 12 },
    );
    await worker.submit("r1", "Click Refresh");
    // After the 3rd click on an unchanged screen, remind() marks row.told and Step 4 starts planning.
    await until(() => planCalls === 1);
    const guideReply = await worker.submit(
      "g1",
      "try clicking Refresh one more time",
    );
    expect(guideReply.message).toBe(
      "Got it. I take that into the task that runs.",
    );
    releasePlan4();
    await worker.idle();
    // Mid-task orders do not clear row.told: choosing click again on the unchanged screen ends no_progress.
    expect(hands.sent).toHaveLength(3);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(
      planner.inputs.some((input) =>
        input.guidance?.includes("try clicking Refresh one more time"),
      ),
    ).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('I tried 3 times to click "Refresh"');
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
      expect((await worker.submit("r2", "Again")).message).toBe("");
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
      'An earlier computer task has an unknown result: "Pay the invoice". It is not run again. After you looked at the screen, say "clear the computer task", or run: clawdtime computer clear',
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
    ).not.toBe("");
    expect((await second.worker.submit("r3", "Something new")).message).toBe(
      "",
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
      'I sent this and its result never came back: Click "Save". It may have happened or not. I do not send it again. After you looked at the screen, say "clear the computer task", or run: clawdtime computer clear',
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

  it("clear() is the spoken clear: it marks the unknown result as seen, starts nothing and sends nothing again", async () => {
    const { worker, hands, planner, journal } = setup([click, click, done]);
    hands.answer = (command) => (command.kind === "click" ? "lost" : undefined);
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(worker.snapshot().state).toBe("uncertain");
    const commands = hands.commands.length;

    expect(worker.clear()).toEqual({
      message: 'Cleared: "Click it". New work can start.',
    });
    // Nothing ran because of it: no command, no plan, no request that runs.
    expect(hands.commands).toHaveLength(commands);
    expect(hands.sent).toHaveLength(1);
    expect(planner.inputs).toHaveLength(1);
    expect(worker.run().active).toBe(false);
    expect(worker.snapshot()).toMatchObject({ state: "idle", canStop: false });
    // The record stays, with the time of the look. Only the block is gone.
    expect(journal.get("r1")).toMatchObject({
      state: "uncertain",
      reason: "lost_result",
      clearedAt: expect.any(Number),
    });
    expect(journal.unresolved()).toBeNull();
    // The cleared request itself never starts again, under its own id.
    expect((await worker.submit("r1", "Click it")).message).not.toBe("");
    expect(hands.sent).toHaveLength(1);
    expect(worker.clear()).toEqual({ message: "Nothing to clear." });
    hands.answer = () => undefined;
    expect((await worker.submit("r2", "Other")).message).toBe("");
    await worker.idle();
  });

  it("clear() with nothing unknown says so and leaves a request that runs alone", async () => {
    const { worker, hands, waiting } = setup([
      { kind: "ask", question: "Which one?" },
      done,
    ]);
    expect(worker.clear()).toEqual({ message: "Nothing to clear." });
    await worker.submit("r1", "Click it");
    await waiting();
    const commands = hands.commands.length;
    expect(worker.clear()).toEqual({ message: "Nothing to clear." });
    expect(worker.snapshot().state).toBe("waiting_for_person");
    expect(hands.commands).toHaveLength(commands);
    await worker.answer("the first one");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
  });

  it("clear() names every request that it cleared, in one line", () => {
    const { worker, journal } = setup([done]);
    journal.open("a", "Pay the invoice");
    journal.set("a", "uncertain", "lost_result");
    journal.open("b", "Move one desktop right");
    journal.set("b", "uncertain", "transition_unknown");
    expect(worker.clear()).toEqual({
      message:
        'Cleared: "Pay the invoice". New work can start. Cleared: "Move one desktop right". New work can start.',
    });
    expect(worker.snapshot().state).toBe("idle");
  });

  it("clear() sets a record aside that cannot be read, as the command does, and answers in words when it cannot", async () => {
    const { worker, journal, hands } = setup([done]);
    mkdirSync(dirname(journal.file), { recursive: true });
    writeFileSync(journal.file, "not a journal");
    expect(worker.snapshot().state).toBe("uncertain");
    expect(worker.snapshot().message).toBe(
      'The record of computer tasks cannot be read, so I cannot tell whether an earlier task has an unknown result. Nothing new starts until it is cleared. After you looked at the screen, say "clear the computer task", or run: clawdtime computer clear',
    );
    expect(worker.clear().message).toMatch(
      /^The record of computer requests could not be read\. It was set aside as \S+journal\.unreadable-1000000\.json and is not removed\. New work can start\.$/,
    );
    // The clock of this test stands still, so the same name is taken: no throw, a plain line.
    writeFileSync(journal.file, "not a journal");
    expect(worker.clear()).toEqual({
      message:
        "The record of computer tasks could not be cleared now. Say it again in a moment.",
    });
    expect(hands.commands).toEqual([]);
  });

  it("every sentence that names the command also says the spoken way", async () => {
    const spoken =
      /After you looked at the screen, say "clear the computer task", or run: clawdtime computer clear$/;
    for (const error of ["input_unknown", "transition_unknown"] as const) {
      const { worker, hands } = setup([click, done]);
      hands.answer = (command) =>
        command.kind === "click" ? { ok: false, error } : undefined;
      await worker.submit("r1", "Click it");
      await worker.idle();
      expect(worker.snapshot().state).toBe("uncertain");
      expect(worker.snapshot().message).toMatch(spoken);
    }
    // A fault inside the worker: the journal breaks under a request that runs.
    const { worker, journal } = setup([click, done]);
    journal.step = () => {
      throw new Error("The disk is full.");
    };
    await worker.submit("r1", "Click it");
    await worker.idle();
    expect(worker.snapshot().state).toBe("uncertain");
    expect(worker.snapshot().message).toMatch(
      /^Something failed inside the worker/,
    );
    expect(worker.snapshot().message).toMatch(spoken);
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
    expect((await worker.submit("r2", "Again")).message).toBe("");
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
    // The request names the site, so the link needs no question.
    await worker.submit("r1", "Open the page of example.com from the note");
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
      message:
        "I stopped at the limit of 3 steps. The task is not finished. Ask again to go on from where it is now.",
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
        "I stopped at the time limit of 15 minutes. The task is not finished. Ask again to go on from where it is now.",
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
    // A question of the planner is marked as one. A question that the checks
    // ask before an action has no such mark, so the planner cannot pose as them.
    expect(worker.snapshot().message).toBe(
      "The task asks: Which note: Shopping or Work?",
    );
    expect(said).toEqual(["The task asks: Which note: Shopping or Work?"]);
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
      "I do not take a password or a key in the chat. I did not keep that: type it into the field on the Mac yourself.",
    );
    // Nothing went to the planner, and the question still waits.
    expect(planner.inputs).toHaveLength(1);
    expect(worker.snapshot().state).toBe("waiting_for_person");
    await worker.answer("I typed it");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
  });

  it("ends as blocked when the planner gives up a second time", async () => {
    const giveUp: Action = { kind: "give_up", reason: "There is no such app." };
    const { worker, said, planner } = setup([giveUp, giveUp]);
    await worker.submit("r1", "Open it");
    await worker.idle();
    const ended =
      "I could not finish. There is no such app. Tell me another way to try, or do this step yourself.";
    expect(planner.inputs).toHaveLength(2);
    expect(worker.snapshot()).toMatchObject({
      state: "blocked",
      message: ended,
    });
    expect(said).toEqual([ended]);
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
    expect(asked.worker.snapshot().message).toBe(
      'Click "Buy now" on example.com? It spends your money. Say yes or no.',
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

  it("ends uncertain when the browser lost the answer of a click that went out, and never clicks again", async () => {
    const browser = new FakeBrowser(shop);
    browser.click = async () => {
      browser.calls.push("click lost");
      throw new BrowserInputUnknown(
        "The page could not be read after the click. Its result is not known, and it is not sent again.",
      );
    };
    const { worker, planner, journal } = setup(
      [
        { kind: "browser_read" },
        { kind: "browser_click", index: 5 },
        { kind: "browser_click", index: 5 },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Next");
    await worker.idle();
    expect(browser.calls).toEqual(["read", "read", "click lost"]);
    // The planner never reads "did not run", and gets no turn to send it again.
    expect(planner.inputs).toHaveLength(2);
    expect(worker.snapshot().state).toBe("uncertain");
    expect(journal.get("r1")).toMatchObject({
      state: "uncertain",
      reason: "lost_result",
      steps: [
        { kind: "browser_read", outcome: "ok" },
        { kind: "browser_click", target: "Next", outcome: "lost" },
      ],
    });
  });

  it("goes on when the browser refused before anything went out, and reads the page again", async () => {
    const browser = new FakeBrowser(shop);
    browser.click = async () => {
      browser.calls.push("click refused");
      throw new Error("Next is disabled now.");
    };
    const { worker, planner } = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 5 }, done],
      { browser },
    );
    await worker.submit("r1", "Next");
    await worker.idle();
    // The planner reads why, on one line. The browser stays on offer.
    expect(planner.inputs[2]!.history[1]!.outcome).toBe(
      "did not run: Next is disabled now.",
    );
    expect(planner.inputs[2]!.page).toBeNull();
    expect(planner.inputs[2]!.browser).toBeUndefined();
    expect(worker.snapshot().state).toBe("completed");
  });

  it("never says that a scroll did not run when its answer was lost", async () => {
    const browser = new FakeBrowser(shop);
    browser.scroll = async () => {
      browser.calls.push("scroll lost");
      throw new BrowserInputUnknown("The answer did not come back.");
    };
    const { worker, planner } = setup(
      [
        { kind: "browser_read" },
        { kind: "browser_scroll", direction: "down" },
        done,
      ],
      { browser },
    );
    await worker.submit("r1", "Scroll");
    await worker.idle();
    expect(planner.inputs[2]!.history[1]!.outcome).toBe(
      "no result came back: The answer did not come back.",
    );
    expect(worker.snapshot().state).toBe("completed");
  });

  it("uses the screen for the rest of the request when only the person can open the browser", async () => {
    const browser = new FakeBrowser(shop);
    const closed =
      "Google Chrome does not take page scripts yet: in Google Chrome, choose View > Developer > Allow JavaScript from Apple Events.";
    browser.read = async () => {
      browser.calls.push("read refused");
      throw new BrowserClosed(closed);
    };
    const { worker, planner, journal } = setup(
      [{ kind: "browser_read" }, { kind: "browser_read" }, done],
      { browser },
    );
    await worker.submit("r1", "Read the page");
    await worker.idle();
    // The reason reaches the planner once, with what to do in its place.
    expect(planner.inputs[0]!.browser).toBeUndefined();
    expect(planner.inputs[1]!.history[0]!.outcome).toBe(
      `did not run: ${closed} The browser functions are off for this request. Use the screen.`,
    );
    // From then on the planner is told that there is no browser, and a browser action is refused unsent.
    expect(planner.inputs[1]!.browser).toBe(false);
    expect(planner.inputs[2]!.browser).toBe(false);
    expect(planner.inputs[2]!.history[1]!.outcome).toMatch(
      /^refused: No browser is connected/,
    );
    expect(browser.calls).toEqual(["read refused"]);
    // The journal keeps no text of the browser: only that the step failed.
    expect(JSON.stringify(journal.get("r1"))).not.toContain("Allow JavaScript");
    expect(worker.snapshot().state).toBe("completed");
    // The next request tries the browser again: the person may have opened it.
    browser.read = async () => {
      browser.calls.push("read");
      return shop;
    };
    const next = setup([{ kind: "browser_read" }, done], { browser });
    await next.worker.submit("r2", "Read the page");
    await next.worker.idle();
    expect(next.planner.inputs[0]!.browser).toBeUndefined();
    expect(next.planner.inputs[1]!.page).not.toBeNull();
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
      message: "Computer use is on. No computer task runs now.",
      step: 0,
      goal: "",
      question: null,
    });
    await worker.submit("r1", "Finish the draft");
    await waiting();
    expect(worker.run()).toEqual({
      active: true,
      goal: "Finish the draft",
      step: 1,
      state: "waiting_for_person",
    });
    expect(worker.status()).toMatchObject({
      enabled: true,
      state: "waiting_for_person",
      step: 1,
      goal: "Finish the draft",
      question: expect.stringMatching(/^Click "Send" in Notes\?/),
    });
    worker.stop();
    expect(worker.run()).toMatchObject({ active: false, state: "idle" });
    expect(worker.status()).toMatchObject({
      state: "canceled",
      question: null,
      goal: "Finish the draft",
    });
  });
});

it("checks call authority after a plan resolves and before dispatching input", async () => {
  let live = true;
  const { worker, hands, journal } = setup([
    () => {
      live = false;
      return click;
    },
    done,
  ]);
  await worker.submit("phone-turn", "Click Save", {
    callId: "call",
    toolCallId: "turn",
    isLive: () => live,
  });
  await worker.idle();
  expect(hands.sent).toHaveLength(0);
  expect(worker.snapshot()).toMatchObject({
    requestId: "phone-turn",
    state: "canceled",
  });
  expect(journal.get("phone-turn")).toMatchObject({
    state: "canceled",
    reason: "call_expired",
  });
});

it("refuses an already expired call before opening a worker request", async () => {
  const { worker, hands, journal } = setup([click, done]);
  await worker.submit("expired", "Click Save", {
    callId: "call",
    toolCallId: "turn",
    isLive: () => false,
  });
  await worker.idle();
  expect(hands.commands).toHaveLength(0);
  expect(journal.get("expired")).toBeNull();
});

describe("phone walkthrough execution ownership", () => {
  it("refuses new input and capture while the phone owns the screen", async () => {
    const { worker, hands } = setup([click, done]);
    worker.setOwnershipGuard(() => false);
    expect(
      (await worker.submit("call-owned-request", "Save the note")).message,
    ).toContain("held by the current phone");
    expect(hands.commands).toEqual([]);
  });
  it("rechecks ownership after the planner awaits and before dispatch", async () => {
    let allowed = true;
    const { worker, hands } = setup([
      async () => {
        allowed = false;
        return click;
      },
    ]);
    worker.setOwnershipGuard(() => allowed);
    await worker.submit("owner-changed-request", "Save the note");
    await worker.idle();
    expect(hands.commands.every((command) => command.kind === "observe")).toBe(
      true,
    );
    expect(worker.snapshot().state).toBe("blocked");
  });
});

describe("stackfix round 1 blockers and rests", () => {
  const enter: Action = { kind: "key", combo: "return" };
  const bar = (surfaceEpoch = 1) =>
    observation(
      [element(1, { role: "AXTextField", title: "Address", focused: true })],
      {
        app: {
          name: "Google Chrome",
          bundleId: "com.google.Chrome",
          window: "New Tab",
        },
        surfaceEpoch,
      },
    );
  const again = (action: Action, times: number): Action[] =>
    Array.from({ length: times }, () => action);

  it("blocker 1: mid-task order after remind does not clear stuck or ask a false repeat question", async () => {
    const refreshScreen = observation([element(1, { title: "Refresh" })], {
      surfaceEpoch: 1,
    });
    let releasePlan4 = () => {};
    let planCalls = 0;
    const { worker, hands, said, journal } = setup(
      [
        click,
        click,
        click,
        async () => {
          planCalls++;
          if (planCalls === 1) {
            await new Promise<void>((resolve) => {
              releasePlan4 = resolve;
            });
          }
          return click;
        },
        click,
        click,
        done,
      ],
      { screens: [refreshScreen], maxSteps: 12 },
    );
    await worker.submit("r1", "Click Refresh");
    await until(() => planCalls === 1);
    const guideReply = await worker.submit(
      "g1",
      "try clicking Refresh one more time",
    );
    expect(guideReply.message).toBe(
      "Got it. I take that into the task that runs.",
    );
    releasePlan4();
    await until(() => worker.status().state !== "running");
    // Must end blocked / no_progress immediately (never pause for a false repeat question).
    if (worker.status().state === "waiting_for_person") worker.stop();
    await worker.idle();
    expect(hands.sent).toHaveLength(3);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('I tried 3 times to click "Refresh"');
  });

  it("blocker 1: hold followed by continue after remind does not clear stuck", async () => {
    const refreshScreen = observation([element(1, { title: "Refresh" })], {
      surfaceEpoch: 1,
    });
    let releasePlan4 = () => {};
    let planCalls = 0;
    const { worker, hands, said, journal } = setup(
      [
        click,
        click,
        click,
        async () => {
          planCalls++;
          if (planCalls === 1) {
            await new Promise<void>((resolve) => {
              releasePlan4 = resolve;
            });
          }
          return click;
        },
        click,
        done,
      ],
      { screens: [refreshScreen], maxSteps: 12 },
    );
    await worker.submit("r1", "Click Refresh");
    await until(() => planCalls === 1);
    await worker.submit("h1", "hold on");
    releasePlan4();
    await until(() => worker.status().state === "waiting_for_person");
    expect(worker.status().question).toBe(
      "Paused. Your next message goes on with it.",
    );
    await worker.answer("continue");
    await until(() => worker.status().state !== "running");
    if (worker.status().state === "waiting_for_person") worker.stop();
    await worker.idle();
    expect(hands.sent).toHaveLength(3);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said.at(-1)).toContain('I tried 3 times to click "Refresh"');
  });

  it("blocker 1: no question for a repeat, also from the fourth time on: a no to the task's question goes to the planner", async () => {
    const { worker, hands, said, planner } = setup(
      [
        ...again(enter, 3),
        { kind: "ask", question: "The page does not load. Try once more?" },
        enter,
        done,
      ],
      { screens: [bar()] },
    );
    await worker.submit("r1", "Type example.com/app in the address bar");
    await until(() => said.length === 1);
    expect(said[0]).toBe(
      "The task asks: The page does not load. Try once more?",
    );
    await worker.answer("no");
    await worker.idle();
    expect(said.join(" ")).not.toMatch(/I already did/);
    expect(planner.inputs[4]!.history.at(-1)!.outcome).toBe(
      "the person answered: no",
    );
    expect(hands.sent).toEqual(again(enter, 4));
  });

  it("blocker 3: stops after 3 clickedOnly focus clicks even with wait/scroll/browser_read and transient list", async () => {
    const searchOnly = (surfaceEpoch = 1) =>
      observation([element(1, { role: "AXTextField", title: "Search" })], {
        surfaceEpoch,
      });
    const withSuggestions = (surfaceEpoch = 2) =>
      observation(
        [
          element(1, { role: "AXTextField", title: "Search" }),
          element(2, { role: "AXButton", title: "Suggestion 1" }),
        ],
        { surfaceEpoch },
      );
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const browser = new FakeBrowser(page([pageElement(1, { label: "Link" })]));
    const { worker, hands, said, journal } = setup(
      [
        write,
        { kind: "wait", ms: 10 },
        write,
        { kind: "scroll", direction: "down" },
        { kind: "browser_read" },
        write,
        { kind: "wait", ms: 10 },
        write,
        done,
      ],
      { browser, screens: [searchOnly(1)], maxSteps: 16 },
    );
    let epoch = 1;
    let popoverOpen = false;
    let afterFocus = false;
    hands.answer = (command) => {
      if (command.kind === "click") {
        afterFocus = true;
        popoverOpen = true;
        return { ok: true };
      }
      if (command.kind === "wait") {
        popoverOpen = false;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (!command.image && afterFocus) {
          afterFocus = false;
          return { observation: withSuggestions(++epoch) };
        }
        return {
          observation: popoverOpen ? withSuggestions(epoch) : searchOnly(epoch),
        };
      }
      return undefined;
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    expect(
      hands.sent.filter((command) => command.kind === "click"),
    ).toHaveLength(3);
    expect(
      hands.sent.filter((command) => command.kind === "type"),
    ).toHaveLength(0);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(
      'I clicked "Search" 3 times and could not type into it, so I stopped: the task is not finished. Notes is in front. You can type in "Search" yourself, or ask me again in other words.',
    );
  });

  it("blocker 3: 3x clickedOnly followed by wait that dismisses transient list cannot send a 4th click", async () => {
    const searchOnly = (surfaceEpoch = 1) =>
      observation([element(1, { role: "AXTextField", title: "Search" })], {
        surfaceEpoch,
      });
    const withSuggestions = (surfaceEpoch = 2) =>
      observation(
        [
          element(1, { role: "AXTextField", title: "Search" }),
          element(2, { role: "AXButton", title: "Suggestion 1" }),
        ],
        { surfaceEpoch },
      );
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const { worker, hands, said, journal } = setup(
      [
        write,
        write,
        write,
        { kind: "wait", ms: 10 },
        write,
        write,
        write,
        { kind: "wait", ms: 10 },
        write,
        done,
      ],
      { screens: [searchOnly(1)], maxSteps: 16 },
    );
    let epoch = 1;
    let popoverOpen = false;
    let afterFocus = false;
    hands.answer = (command) => {
      if (command.kind === "click") {
        afterFocus = true;
        popoverOpen = true;
        return { ok: true };
      }
      if (command.kind === "wait") {
        popoverOpen = false;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (!command.image && afterFocus) {
          afterFocus = false;
          return { observation: withSuggestions(++epoch) };
        }
        return {
          observation: popoverOpen ? withSuggestions(epoch) : searchOnly(epoch),
        };
      }
      return undefined;
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    expect(
      hands.sent.filter((command) => command.kind === "click"),
    ).toHaveLength(3);
    expect(
      hands.sent.filter((command) => command.kind === "type"),
    ).toHaveLength(0);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
    expect(said).toEqual([
      'I clicked "Search" 3 times and could not type into it, so I stopped: the task is not finished. Notes is in front. You can type in "Search" yourself, or ask me again in other words.',
    ]);
  });

  it("blocker 6: focus change on the 3rd clickedOnly click counts as progress and typed text resets the counter", async () => {
    const searchField = (surfaceEpoch = 1, focused = false) =>
      observation(
        [element(1, { role: "AXTextField", title: "Search", focused })],
        { surfaceEpoch },
      );
    const write: Action = { kind: "type", element: 1, text: "hello" };
    const { worker, hands, said, journal } = setup(
      [write, write, write, write, done],
      { screens: [searchField(1, false)], maxSteps: 12 },
    );
    let clicks = 0;
    let afterFocus = false;
    hands.answer = (command) => {
      if (command.kind === "click") {
        clicks++;
        afterFocus = true;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (!command.image && afterFocus) {
          afterFocus = false;
          return { observation: searchField(2, clicks >= 3) };
        }
        return { observation: searchField(1, clicks >= 3) };
      }
      return undefined;
    };
    await worker.submit("r1", "Search for hello");
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "click",
      "click",
      "click",
      "type",
    ]);
    expect(journal.get("r1")).toMatchObject({ state: "completed" });
    expect(said).toEqual(["Done. The note is saved."]);
  });

  it("blocker 6: focus change after 2 holds + 1 focus click counts as progress, and typed text resets focusClicks", async () => {
    const searchField = (surfaceEpoch = 1, focused = false) =>
      observation(
        [element(1, { role: "AXTextField", title: "Search", focused })],
        { surfaceEpoch },
      );
    const empty = observation([], { surfaceEpoch: 1 });
    const write1: Action = { kind: "type", element: 1, text: "hello" };
    const write2: Action = { kind: "type", element: 1, text: "world" };
    // Steps 1-2: target gone (2 holds). Step 3: focus click focuses Search. Step 4: types "hello" (resets counter).
    // Steps 5-6: field unfocused again, 2 more focus clicks then focuses on 2nd click -> Step 7 types "world" -> done.
    const { worker, hands, said, journal } = setup(
      [write1, write1, write1, write1, write2, write2, write2, done],
      { screens: [searchField(1, false)], maxSteps: 14 },
    );
    let preLooks = 0;
    let clicks = 0;
    let typed = 0;
    let afterFocus = false;
    hands.answer = (command) => {
      if (command.kind === "click") {
        clicks++;
        afterFocus = true;
        return { ok: true };
      }
      if (command.kind === "type") {
        typed++;
        return { ok: true };
      }
      if (command.kind === "observe") {
        if (!command.image) {
          if (afterFocus) {
            afterFocus = false;
            return { observation: searchField(2, false) };
          }
          preLooks++;
          if (preLooks === 1 || preLooks === 2) return { observation: empty };
          const isFocused =
            (typed === 0 && clicks >= 1) || (typed === 1 && clicks >= 3);
          return { observation: searchField(1, isFocused) };
        }
        const isFocused =
          (typed === 0 && clicks >= 1) || (typed === 1 && clicks >= 3);
        return { observation: searchField(1, isFocused) };
      }
      return undefined;
    };
    await worker.submit("r1", "Search twice");
    await worker.idle();
    expect(hands.sent.map((command) => command.kind)).toEqual([
      "click",
      "type",
      "click",
      "click",
      "type",
    ]);
    expect(journal.get("r1")).toMatchObject({ state: "completed" });
    expect(said).toEqual(["Done. The note is saved."]);
  });

  it("blocker 4: mixed window and page holds in a row of 5 use neutral wording", async () => {
    const notes = (surfaceEpoch = 1) =>
      observation(
        [element(1, { title: "Save" }), element(2, { title: "Cancel" })],
        { surfaceEpoch },
      );
    const empty = observation([], { surfaceEpoch: 1 });
    const safari = observation([element(1, { title: "Save" })], {
      app: { name: "Safari", bundleId: "com.apple.Safari", window: "Start" },
      surfaceEpoch: 1,
    });
    const p1 = page([pageElement(1, { label: "Next" })]);
    const pEmpty = page([]);
    const browser = new FakeBrowser(p1);
    let pageReads = 0;
    browser.read = async () => {
      pageReads++;
      return pageReads === 1 ? p1 : pEmpty;
    };
    const { worker, hands, said, journal } = setup(
      [
        click,
        { kind: "click_element", element: 2 },
        click,
        { kind: "click_element", element: 2 },
        { kind: "browser_read" },
        { kind: "browser_click", index: 1 },
        done,
      ],
      { settleLimit: 0, browser, screens: [notes(1)], maxSteps: 12 },
    );
    let preLooks = 0;
    hands.answer = (command) => {
      if (command.kind !== "observe") return undefined;
      if (command.image) return { observation: notes(1) };
      preLooks++;
      if (preLooks === 1 || preLooks === 4) return { observation: notes(2) };
      if (preLooks === 2) return { observation: empty };
      return { observation: safari };
    };
    await worker.submit("r1", "Click controls");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(said).toEqual([
      "5 of my last actions were held back and nothing moved on, so nothing was sent. Wait until things settle, then ask again.",
    ]);
  });

  it("blocker 5: silentText says nothing more was sent when earlier input already went out", async () => {
    const { worker, hands, said, journal } = setup([click, click, done]);
    let fullLooks = 0;
    hands.answer = (command) => {
      if (command.kind === "observe" && command.image && ++fullLooks === 2)
        throw new Error("panel silent");
      return undefined;
    };
    await worker.submit("r1", "Save twice");
    await worker.idle();
    expect(hands.sent).toHaveLength(1);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "hands_silent",
    });
    expect(said).toEqual([
      "The ClawdTime panel did not answer, so nothing more was sent. Open the panel and ask again.",
    ]);
  });

  it("rest 8: stop during a hung pre-action or explicit browser.read ends immediately", async () => {
    const p1 = page([pageElement(1, { label: "Next" })]);
    const browserA = new FakeBrowser(p1);
    let readsA = 0;
    browserA.read = async () => {
      readsA++;
      if (readsA === 1) return p1;
      return await new Promise<ReturnType<typeof page>>(() => {});
    };
    const caseA = setup(
      [{ kind: "browser_read" }, { kind: "browser_click", index: 1 }, done],
      { browser: browserA, browserMs: 400 },
    );
    await caseA.worker.submit("r1", "Click Next");
    await until(() => readsA === 2);
    const startA = Date.now();
    caseA.worker.stop();
    await caseA.worker.idle();
    expect(Date.now() - startA).toBeLessThan(150);
    expect(caseA.journal.get("r1")).toMatchObject({
      state: "canceled",
      reason: "stopped",
    });
    expect(caseA.said).toEqual([]);

    const browserB = new FakeBrowser(p1);
    let readsB = 0;
    browserB.read = async () => {
      readsB++;
      return await new Promise<ReturnType<typeof page>>(() => {});
    };
    const caseB = setup([{ kind: "browser_read" }, done], {
      browser: browserB,
      browserMs: 400,
    });
    await caseB.worker.submit("r2", "Read the page");
    await until(() => readsB === 1);
    const startB = Date.now();
    caseB.worker.stop();
    await caseB.worker.idle();
    expect(Date.now() - startB).toBeLessThan(150);
    expect(caseB.journal.get("r2")).toMatchObject({
      state: "canceled",
      reason: "stopped",
    });
    expect(caseB.said).toEqual([]);
  });
});

describe("a task that does not move on", () => {
  const two = observation([
    element(1, { title: "Open" }),
    element(2, { title: "Back" }),
  ]);
  const open: Action = { kind: "click_element", element: 1 };
  const back: Action = { kind: "click_element", element: 2 };
  const swing = [open, back, open, back];
  const swingQuestion =
    "I keep going back and forth, and the screen shows nothing new. What should I try next? Say it in a few words, or say no to stop.";
  const lastOutcome = (input: { history: { outcome: string }[] }) =>
    input.history.at(-1)!.outcome;

  it("tells the planner twice that it swings, then asks the person, and goes on with the answer", async () => {
    const entries: StepTiming[] = [];
    const { worker, planner, said, hands, journal, waiting } = setup(
      [...swing, ...swing, ...swing, done],
      { screens: [two], timing: (entry) => entries.push(entry) },
    );
    await worker.submit("r1", "Find the setting");
    await waiting();
    // Twelve clicks went out, each once: none is sent again on its own.
    expect(hands.sent).toHaveLength(12);
    expect(lastOutcome(planner.inputs[4]!)).toMatch(
      /^ok You went back and forth between the same 2 actions, and the screen showed nothing new\. Do not repeat them\. Try another way: keys: Tab, Return, Escape, a menu shortcut; scroll; a search field; open_app/,
    );
    expect(lastOutcome(planner.inputs[8]!)).toMatch(/^ok You went back/);
    expect(planner.inputs).toHaveLength(12);
    expect(worker.snapshot()).toMatchObject({
      state: "waiting_for_person",
      waiting: "question",
      message: swingQuestion,
    });
    expect(said).toEqual([swingQuestion]);
    expect((await worker.answer("use the search field")).message).toBe(
      "Thank you. I go on.",
    );
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs).toHaveLength(13);
    expect(planner.inputs[12]!.history.at(-1)).toMatchObject({
      action: { kind: "ask", question: swingQuestion },
      outcome: "the person answered: use the search field",
    });
    // The journal keeps no question and no answer.
    const text = readFileSync(journal.file, "utf8");
    expect(text).not.toContain("use the search field");
    expect(text).not.toContain("back and forth");
    expect(
      journal.get("r1")!.steps.filter((step) => step.kind === "ask"),
    ).toEqual([expect.objectContaining({ target: "", outcome: "answered" })]);
    // The timing record says what the worker did to get moving.
    expect(entries.flatMap((entry) => entry.recovery ?? [])).toEqual([
      "nudge_swing",
      "nudge_swing",
      "ask_swing",
    ]);
  });

  it("ends cleanly when the person says no to the question", async () => {
    const { worker, hands, journal, waiting } = setup(
      [...swing, ...swing, ...swing, done],
      { screens: [two] },
    );
    await worker.submit("r1", "Find the setting");
    await waiting();
    expect((await worker.answer("no")).message).toBe(
      "Canceled. The task is not finished.",
    );
    await worker.idle();
    expect(hands.sent).toHaveLength(12);
    expect(worker.snapshot()).toMatchObject({
      state: "canceled",
      message: "Canceled. The task is not finished.",
    });
    expect(journal.get("r1")).toMatchObject({
      state: "canceled",
      reason: "refused_by_person",
    });
  });

  it("ends after two notes and two questions, with what the person can do", async () => {
    const { worker, hands, said, journal, waiting } = setup(
      [...swing, ...swing, ...swing, ...swing, ...swing, done],
      { screens: [two] },
    );
    await worker.submit("r1", "Find the setting");
    await waiting();
    await worker.answer("try the menu");
    await until(() => hands.sent.length === 16);
    await waiting();
    await worker.answer("try the menu");
    await worker.idle();
    const end =
      "My last actions did not move the task on, also after I tried other ways and asked you, so I stopped. The task is not finished. Ask again in other words, or do the next step yourself.";
    expect(hands.sent).toHaveLength(20);
    expect(said).toEqual([swingQuestion, swingQuestion, end]);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "no_progress",
    });
  });

  it("tells the planner when inputs of several kinds change nothing on the screen", async () => {
    const { worker, planner } = setup(
      [
        open,
        { kind: "key", combo: "tab" },
        back,
        { kind: "key", combo: "down" },
        done,
      ],
      { screens: [two] },
    );
    await worker.submit("r1", "Find the setting");
    await worker.idle();
    expect(lastOutcome(planner.inputs[4]!)).toMatch(
      /^ok Your last 4 actions did not change the screen\. Do not repeat them\. Try another way: scroll; a search field; open_app/,
    );
  });

  it("says nothing while the screen changes with each step", async () => {
    // Each look of the planner shows another row: the clicks move on.
    const rows = (index: number) =>
      observation([
        element(1, { title: "Open" }),
        element(2, { title: "Back" }),
        element(3, { title: `Row ${index}` }),
      ]);
    const { worker, planner, hands } = setup([...swing, ...swing, done], {
      screens: [two],
    });
    let looks = 0;
    hands.answer = (command) =>
      command.kind === "observe"
        ? { observation: rows(command.image ? ++looks : looks) }
        : undefined;
    await worker.submit("r1", "Go through the rows");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(hands.sent).toHaveLength(8);
    for (const input of planner.inputs)
      for (const step of input.history) expect(step.outcome).toBe("ok");
  });
});

describe("a screen that does not hold still", () => {
  const empty = observation([]);
  const settleLabel = "Wait for the screen to settle";
  const waitedEnd =
    "What I tried to use kept moving or disappearing before I could act, also after I waited for the window to settle, so nothing was sent. Wait until the window settles, then ask again.";
  /** The look just before each click sees no target. The looks of a wait for the screen to settle see `settling`. */
  const gone = (
    hands: FakeHands,
    settling: () => Observation,
    targetAfter = Infinity,
  ) => {
    let before = 0;
    hands.answer = (command, index) => {
      if (command.kind !== "observe" || command.image) return undefined;
      if (hands.labels[index] === settleLabel)
        return { observation: settling() };
      before++;
      return { observation: before <= targetAfter ? empty : save };
    };
  };
  const settleLooks = (hands: FakeHands) =>
    hands.labels.filter((label) => label === settleLabel).length;

  it("waits with no input until the screen settles, then the input goes out once", async () => {
    const { worker, hands, planner, journal } = setup([
      click,
      click,
      click,
      click,
      done,
    ]);
    gone(hands, () => save, 3);
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(hands.sent).toEqual([
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
    ]);
    // Two looks in a row showed the same: it settled.
    expect(settleLooks(hands)).toBe(2);
    expect(lastOutcomeOf(planner.inputs[3]!)).toBe(
      "not sent: The screen changed: the target is no longer there. Nothing was sent. Then the worker waited with no input until the screen was still. Choose again from the new look: the target may be in another place now.",
    );
    expect(journal.get("r1")!.steps.map((step) => step.outcome)).toEqual([
      "not_sent",
      "not_sent",
      "not_sent",
      "ok",
      "ok",
    ]);
  });

  it("ends after the bound with a plain text when the screen never settles, and sends nothing", async () => {
    let shift = 0;
    const { worker, hands, planner, said, journal } = setup(
      Array.from({ length: 10 }, () => click),
    );
    gone(hands, () =>
      observation([element(1, { title: "Save", x: 100 + (shift++ % 2) * 50 })]),
    );
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(planner.inputs).toHaveLength(3);
    expect(settleLooks(hands)).toBe(8);
    expect(said).toEqual([waitedEnd]);
    expect(waitedEnd).not.toMatch(/^I cannot/);
    expect(journal.get("r1")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
  });

  it("waits twice at most in one request, and then ends", async () => {
    const { worker, hands, planner, said } = setup(
      Array.from({ length: 12 }, () => click),
    );
    gone(hands, () => save);
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(hands.sent).toEqual([]);
    expect(planner.inputs).toHaveLength(9);
    expect(settleLooks(hands)).toBe(4);
    expect(said).toEqual([waitedEnd]);
  });

  it("stops at once during a wait for the screen to settle", async () => {
    const { worker, hands, journal } = setup(
      Array.from({ length: 10 }, () => click),
      { settleMs: 60_000 },
    );
    gone(hands, () => save);
    await worker.submit("r1", "Save the note");
    await until(() => settleLooks(hands) === 1);
    await new Promise((done) => setTimeout(done, 5));
    worker.stop();
    await worker.idle();
    expect(worker.snapshot()).toMatchObject({
      state: "canceled",
      message: stoppedText,
    });
    expect(journal.get("r1")).toMatchObject({ reason: "stopped" });
    expect(settleLooks(hands)).toBe(1);
    expect(hands.sent).toEqual([]);
  });
});

/** The outcome of the last step that the planner read. */
const lastOutcomeOf = (input: { history: { outcome: string }[] }) =>
  input.history.at(-1)!.outcome;

describe("trouble of the planner", () => {
  const trouble = (kind: string, retryAfterMs?: number) => () => {
    throw Object.assign(new Error("The service failed."), {
      trouble: kind,
      ...(retryAfterMs ? { retryAfterMs } : {}),
    });
  };

  it("waits after a short failure and goes on, also twice in a row", async () => {
    const entries: StepTiming[] = [];
    const { worker, hands, planner } = setup(
      [trouble("transient"), trouble("transient"), click, done],
      { timing: (entry) => entries.push(entry) },
    );
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs).toHaveLength(4);
    expect(hands.sent).toHaveLength(1);
    expect(entries[0]!.recovery).toEqual(["transient", "transient"]);
  });

  it("waits three times at most, and then two failures in a row end it", async () => {
    const { worker, hands, planner, journal } = setup(
      Array.from({ length: 6 }, () => trouble("transient")),
    );
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(planner.inputs).toHaveLength(5);
    expect(hands.sent).toEqual([]);
    expect(worker.snapshot().message).toBe(
      "The planner did not answer after several tries, so I stopped. Nothing more was sent. Ask again in a moment.",
    );
    expect(journal.get("r1")).toMatchObject({ reason: "planner_failed" });
  });

  it("ends at once when no quota is left, or when the key does not work", async () => {
    const quota = setup([trouble("quota"), click, done]);
    await quota.worker.submit("r1", "Save the note");
    await quota.worker.idle();
    expect(quota.planner.inputs).toHaveLength(1);
    expect(quota.hands.sent).toEqual([]);
    expect(quota.worker.snapshot()).toMatchObject({
      state: "blocked",
      message:
        "The language model account has no quota left, so I stopped. Nothing more was sent. Add credit or raise the limit of the key, then ask again.",
    });
    expect(quota.journal.get("r1")).toMatchObject({ reason: "planner_quota" });

    const auth = setup([trouble("auth"), click, done]);
    await auth.worker.submit("r1", "Save the note");
    await auth.worker.idle();
    expect(auth.planner.inputs).toHaveLength(1);
    expect(auth.worker.snapshot().message).toBe(
      "The language model did not accept the key, so I stopped. Nothing more was sent. Check CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY of the desktop service, then ask again.",
    );
    expect(auth.journal.get("r1")).toMatchObject({ reason: "planner_auth" });
  });

  it("ends after two malformed answers in a row, as before, and says so", async () => {
    const { worker, planner } = setup([
      trouble("malformed"),
      trouble("malformed"),
      click,
    ]);
    await worker.submit("r1", "Save the note");
    await worker.idle();
    expect(planner.inputs).toHaveLength(2);
    expect(worker.snapshot().message).toBe(
      "The planner gave no usable action twice in a row, so I stopped. Nothing more was sent. Ask again, perhaps in other words.",
    );
  });

  it("stops at once during the wait after a short failure, and holds at once too", async () => {
    const stopped = setup([trouble("transient"), click], {
      transientMs: 60_000,
    });
    await stopped.worker.submit("r1", "Save the note");
    await until(() => stopped.planner.inputs.length === 1);
    await new Promise((done) => setTimeout(done, 5));
    stopped.worker.stop();
    await stopped.worker.idle();
    expect(stopped.worker.snapshot().state).toBe("canceled");
    expect(stopped.planner.inputs).toHaveLength(1);
    expect(stopped.hands.sent).toEqual([]);

    const held = setup([trouble("transient"), click, done], {
      transientMs: 60_000,
    });
    await held.worker.submit("r1", "Save the note");
    await until(() => held.planner.inputs.length === 1);
    await new Promise((done) => setTimeout(done, 5));
    await held.worker.submit("w1", "wait a moment");
    await held.waiting();
    expect(held.worker.snapshot().message).toBe(
      "Paused. Your next message goes on with it.",
    );
    await held.worker.answer("continue");
    await held.worker.idle();
    expect(held.worker.snapshot().state).toBe("completed");
    expect(held.hands.sent).toHaveLength(1);
  });

  it("aborts the signal of the planner call at Stop", async () => {
    let signal: AbortSignal | undefined;
    const { worker } = setup([
      (input) => {
        signal = (input as { signal?: AbortSignal }).signal;
        return new Promise<Action>(() => {});
      },
    ]);
    await worker.submit("r1", "Think long");
    await until(() => signal !== undefined);
    expect(signal!.aborted).toBe(false);
    worker.stop();
    expect(signal!.aborted).toBe(true);
    await worker.idle();
    expect(worker.snapshot().state).toBe("canceled");
  });

  it("gives the reading of the request a signal too, and aborts it at Stop", async () => {
    let signal: AbortSignal | undefined;
    const { worker, planner } = setup([done]);
    Object.assign(planner, {
      navigation: (_goal: string, given?: AbortSignal) => {
        signal = given;
        return new Promise(() => {});
      },
    });
    await worker.submit("r1", "Open my notes");
    await until(() => signal !== undefined);
    expect(signal!.aborted).toBe(false);
    worker.stop();
    expect(signal!.aborted).toBe(true);
    await worker.idle();
    expect(worker.snapshot().state).toBe("canceled");
  });
});

describe("a first give_up", () => {
  it("goes back to the planner with the ways it did not try", async () => {
    const chrome = observation([element(1, { title: "Next" })], {
      app: {
        name: "Google Chrome",
        bundleId: "com.google.Chrome",
        window: "Shop",
      },
    });
    const { worker, planner, journal } = setup(
      [{ kind: "give_up", reason: "The button you named does nothing." }, done],
      { screens: [chrome], browser: new FakeBrowser() },
    );
    await worker.submit("r1", "Find the price");
    await worker.idle();
    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs[1]!.history[0]).toMatchObject({
      action: { kind: "give_up" },
      outcome:
        "not ended: Do not give up yet. Try another way first: browser_read and the page elements; keys: Tab, Return, Escape, a menu shortcut; scroll; a search field; open_app for the right app or window. Give up only when none of them can work.",
    });
    expect(journal.get("r1")!.steps[0]).toMatchObject({
      kind: "give_up",
      outcome: "nudged",
    });
  });

  it("ends at once when only the person can change what stands in the way", async () => {
    for (const reason of [
      "The site asks for your password.",
      "Only the person can decide which plan to buy.",
      "The app needs the Accessibility permission.",
    ]) {
      const { worker, planner } = setup([{ kind: "give_up", reason }, done]);
      await worker.submit("r1", "Sign me up");
      await worker.idle();
      expect(planner.inputs).toHaveLength(1);
      expect(worker.snapshot()).toMatchObject({
        state: "blocked",
        message: `I could not finish. ${reason} Tell me another way to try, or do this step yourself.`,
      });
    }
  });
});

describe("perceptual visual diff, fast re-verify, and bounded post-action settle", () => {
  const makeJpeg = (
    width: number,
    height: number,
    options: {
      rects?: {
        x: number;
        y: number;
        w: number;
        h: number;
        r: number;
        g: number;
        b: number;
      }[];
    } = {},
  ) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const off = i * 4;
      data[off] = 220;
      data[off + 1] = 220;
      data[off + 2] = 220;
      data[off + 3] = 255;
    }
    for (const rect of options.rects ?? []) {
      const x0 = Math.max(0, Math.floor(rect.x));
      const y0 = Math.max(0, Math.floor(rect.y));
      const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
      const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const off = (y * width + x) * 4;
          data[off] = rect.r;
          data[off + 1] = rect.g;
          data[off + 2] = rect.b;
          data[off + 3] = 255;
        }
      }
    }
    return jpeg.encode({ data, width, height }, 85).data.toString("base64");
  };
  const frameBase = makeJpeg(320, 180, {
    rects: [
      { x: 260, y: 0, w: 50, h: 5, r: 15, g: 15, b: 15 },
      { x: 40, y: 60, w: 80, h: 40, r: 50, g: 100, b: 200 },
    ],
  });
  const frameClockTick = makeJpeg(320, 180, {
    rects: [
      { x: 260, y: 0, w: 50, h: 5, r: 245, g: 245, b: 245 },
      { x: 40, y: 60, w: 80, h: 40, r: 50, g: 100, b: 200 },
    ],
  });
  const frameChanged = makeJpeg(320, 180, {
    rects: [
      { x: 260, y: 0, w: 50, h: 5, r: 15, g: 15, b: 15 },
      { x: 40, y: 60, w: 80, h: 40, r: 50, g: 100, b: 200 },
      { x: 140, y: 80, w: 100, h: 60, r: 20, g: 180, b: 60 },
    ],
  });

  const realObs = (
    image: string,
    elements = [element(1, { title: "Save" })],
    extra: Partial<Observation> = {},
  ) =>
    observation(elements, {
      image,
      imageWidth: 320,
      imageHeight: 180,
      ...extra,
    });

  // A press on an element always walks the tree: its name may have changed
  // in place with no change that the picture shows. A hover shows the quick
  // picture.
  const hover: Action = { kind: "hover", element: 1 };

  it("skips the AX walk in fast pre-action visual re-verify when pixels are unchanged (even after a clock tick)", async () => {
    const initial = realObs(frameBase);
    // Fast image-only observe returns no elements and a ticked menu bar clock.
    const fastOnly = realObs(frameClockTick, []);
    const afterHover = realObs(frameChanged);
    const { worker, hands } = setup([hover, done], {
      screens: [initial, fastOnly, afterHover],
    });
    await worker.submit("fast_reverify_hit", "Show the tip of Save");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    expect(hands.sent).toEqual([{ kind: "move", x: 150, y: 212 }]);
    // Full initial observe -> image-only fast re-verify -> hover -> full post-action observe.
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: true, elements: false },
      { kind: "move", x: 150, y: 212 },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("falls back to full AX look when fast visual re-verify sees changed pixels", async () => {
    const initial = realObs(frameBase);
    const changedFast = realObs(frameChanged, []);
    const axFallback = realObs(frameChanged, [
      element(7, { title: "Save", x: 110, y: 200 }),
    ]);
    const afterHover = realObs(frameChanged, [
      element(7, { title: "Saved", x: 110, y: 200 }),
    ]);
    const { worker, hands } = setup([hover, done], {
      screens: [initial, changedFast, changedFast, axFallback, afterHover],
    });
    await worker.submit("fast_reverify_miss", "Show the tip of Save");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // A change away from the target and not large gets one more quick
    // look. It held there, so it is no region that keeps changing.
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: true, elements: false },
      { kind: "observe", image: true, elements: false },
      { kind: "observe", image: false, elements: true },
      { kind: "move", x: 150, y: 212 },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("reads the name and role of the target again before a click, and sends nothing when its label changed in place", async () => {
    // The pictures look the same on a grid of 64 by 36: a label swap of the
    // same length in a button of the same colour.
    const cancel = [element(1, { title: "Cancel" })];
    const deleted = [element(1, { title: "Delete" })];
    const plannerLook = realObs(frameBase, cancel);
    const quickSame = realObs(frameBase, []);
    const now = realObs(frameBase, deleted);
    for (const action of [
      click,
      // Inside element 1, as a point of the last image of 320 by 180.
      { kind: "click_at", x: 33, y: 42 } as Action,
    ]) {
      const { worker, hands, planner } = setup([action, done], {
        screens: [plannerLook, quickSame, now, now],
      });
      await worker.submit("label_swap", "Close the dialog");
      await worker.idle();
      expect(hands.sent, action.kind).toEqual([]);
      expect(hands.commands[1], action.kind).toEqual({
        kind: "observe",
        image: false,
        elements: true,
      });
      expect(planner.inputs[1]!.history[0]!.outcome, action.kind).toMatch(
        /target is no longer there\. Nothing was sent\./,
      );
    }
  });

  it("skips fast visual re-verify when fastReverify is false", async () => {
    const initial = realObs(frameBase);
    const axLook = realObs(frameBase);
    const afterClick = realObs(frameChanged);
    const { worker, hands } = setup([click, done], {
      screens: [initial, axLook, afterClick],
      fastReverify: false,
    });
    await worker.submit("fast_reverify_off", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("runs one bounded post-action visual follow-up and refreshes full observation when delayed UI change appears", async () => {
    const initial = realObs(frameBase);
    const fastSame = realObs(frameBase);
    const postStillSame = realObs(frameClockTick);
    const probeChanged = realObs(frameChanged, []);
    const refreshedFull = realObs(frameChanged, [
      element(1, { title: "Saved" }),
    ]);
    const { worker, hands, planner } = setup([click, done], {
      screens: [initial, fastSame, postStillSame, probeChanged, refreshedFull],
      postActionSettleMs: 10,
      unchangedDone: true,
    });
    await worker.submit("post_settle_delayed", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // Done was accepted immediately because refreshedFull showed the visual change.
    expect(planner.inputs).toHaveLength(2);
    expect(planner.inputs[1]!.observation?.elements[0]?.title).toBe("Saved");
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: true, elements: false },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("caps post-action visual follow-up at one probe when screen remains unchanged and triggers unchangedDone", async () => {
    const initial = realObs(frameBase);
    const fastSame = realObs(frameBase);
    const postSame = realObs(frameClockTick);
    const probeStillSame = realObs(frameClockTick, []);
    const { worker, hands, planner } = setup([click, done, done], {
      screens: [initial, fastSame, postSame, probeStillSame],
      postActionSettleMs: 10,
      unchangedDone: true,
    });
    await worker.submit("post_settle_still", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // First done was sent back because even after the bounded follow-up, only the clock ticked.
    expect(planner.inputs).toHaveLength(3);
    expect(planner.inputs[1]!.history[0]?.outcome).toMatch(
      /^sent, but the screen looks the same after it/,
    );
    expect(planner.inputs[2]!.history.at(-1)?.outcome).toMatch(
      /^not taken yet: the screen looks the same as before your last action/,
    );
    // At most one follow-up probe, no extra full observe refresh when unchanged.
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: true, elements: false },
    ]);
  });

  it("skips post-action follow-up when the first post-action observe already changed and enforces the 450ms hard cap", async () => {
    const initial = realObs(frameBase);
    const fastSame = realObs(frameBase);
    const postChanged = realObs(frameChanged);
    const started = Date.now();
    const { worker, hands } = setup([click, done], {
      screens: [initial, fastSame, postChanged],
      postActionSettleMs: 5_000, // far exceeds 450ms hard cap
      realClock: true,
    });
    await worker.submit("post_settle_cap", "Save the note");
    await worker.idle();
    const elapsed = Date.now() - started;

    expect(worker.snapshot().state).toBe("completed");
    // Hard-capped at 450ms (well under the 5000ms requested even under heavy parallel test load).
    expect(elapsed).toBeLessThan(2500);
    // No follow-up probe needed since first post-action observe already changed.
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("cancels post-action settle wait promptly on Stop", async () => {
    const initial = realObs(frameBase);
    const fastSame = realObs(frameBase);
    const { worker, hands } = setup([click, done], {
      screens: [initial, fastSame, realObs(frameBase)],
      postActionSettleMs: 400,
      realClock: true,
    });
    let clickDone!: () => void;
    const clicked = new Promise<void>((resolve) => {
      clickDone = resolve;
    });
    hands.answer = (command) => {
      if (command.kind === "click") setImmediate(clickDone);
      return undefined;
    };
    const started = Date.now();
    await worker.submit("post_settle_stop", "Save the note");
    await clicked;
    worker.stop();
    await worker.idle();
    const elapsed = Date.now() - started;

    expect(worker.snapshot().state).toBe("canceled");
    expect(elapsed).toBeLessThan(300);
  });

  it("uses image-only polls during settle() recovery on desktop surfaces with real JPEGs", async () => {
    const initial = realObs(frameBase);
    const missing = realObs(frameChanged, [element(2, { title: "Other" })]);
    const settledFrameA = realObs(frameBase, []);
    const settledFrameB = realObs(frameClockTick, []);
    const recovered = realObs(frameBase);
    const afterClick = realObs(frameChanged);

    // Three held click attempts trigger settle():
    // Each held attempt does: full observe (initial), then the walk of the
    // tree before a press on an element (missing) -> held.
    // Then settle() polls image-only twice (settledFrameA, settledFrameB -> visually unchanged -> settled!).
    // Then 4th click succeeds.
    const { worker, hands } = setup([click, click, click, click, done], {
      screens: [
        initial,
        missing,
        initial,
        missing,
        initial,
        missing,
        settledFrameA,
        settledFrameB,
        recovered,
        recovered,
        afterClick,
      ],
    });
    await worker.submit("visual_settle", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    const settleCommands = hands.commands.filter(
      (_, i) => hands.labels[i] === "Wait for the screen to settle",
    );
    expect(settleCommands).toEqual([
      { kind: "observe", image: true, elements: false },
      { kind: "observe", image: true, elements: false },
    ]);
  });

  it("treats real pixel change as progress in judge() even when AX elements did not change", async () => {
    const initial = realObs(frameBase);
    const fastSame = realObs(frameBase);
    // Same AX elements, but real pixel change in window body.
    const afterVisualChange = realObs(frameChanged);
    const { worker, planner } = setup([click, done], {
      screens: [initial, fastSame, afterVisualChange],
      unchangedDone: true,
    });
    await worker.submit("visual_progress", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    expect(planner.inputs).toHaveLength(2);
    expect(planner.inputs[1]!.history[0]?.outcome).toBe("ok");
  });

  it("always runs full AX look in reverify() for type and key actions (never skips AX walk)", async () => {
    const textField = element(1, {
      role: "AXTextField",
      title: "Note",
      focused: true,
    });
    const initial = realObs(frameBase, [textField]);
    const axLook = realObs(frameBase, [textField]);
    const afterAction = realObs(frameChanged, [textField]);

    const typeRun = setup([{ kind: "type", text: "hello" }, done], {
      screens: [initial, axLook, afterAction],
    });
    await typeRun.worker.submit("reverify_type_ax", "Write hello");
    await typeRun.worker.idle();
    expect(typeRun.worker.snapshot().state).toBe("completed");
    expect(typeRun.hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "type", text: "hello" },
      { kind: "observe", image: true, elements: true },
    ]);

    const keyRun = setup([{ kind: "key", combo: "escape" }, done], {
      screens: [initial, axLook, afterAction],
    });
    await keyRun.worker.submit("reverify_key_ax", "Dismiss dialog");
    await keyRun.worker.idle();
    expect(keyRun.worker.snapshot().state).toBe("completed");
    expect(keyRun.hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "key", combo: "escape" },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("always runs full AX look in reverify() after a user approval pause", async () => {
    const sendBtn = element(1, { title: "Send" });
    const initial = realObs(frameBase, [sendBtn]);
    const axLook = realObs(frameBase, [sendBtn]);
    const afterClick = realObs(frameChanged, [element(1, { title: "Sent" })]);
    const { worker, hands, waiting } = setup([click, done], {
      screens: [initial, axLook, afterClick],
    });
    await worker.submit("reverify_approval_ax", "Finish the draft");
    await waiting();
    await worker.answer("yes");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // Must go straight to full AX look (elements: true) after approval, never image-only fast re-verify.
    expect(hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("always runs full AX look in reverify() when observation is older than 8s or contains a secure element", async () => {
    const initial = realObs(frameBase);
    const axLook = realObs(frameBase);
    const afterClick = realObs(frameChanged);
    let advanceClock!: () => void;
    const staleRun = setup(
      [
        () => {
          advanceClock();
          return click;
        },
        done,
      ],
      { screens: [initial, axLook, afterClick] },
    );
    advanceClock = () => {
      staleRun.clock.now += 9_000;
    };
    await staleRun.worker.submit("reverify_stale_age", "Save the note");
    await staleRun.worker.idle();

    expect(staleRun.worker.snapshot().state).toBe("completed");
    expect(staleRun.hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
    ]);

    // When a secure element is present on screen, fast visual re-verify is also bypassed.
    const secureInitial = realObs(frameBase, [
      element(1, { title: "Save" }),
      element(2, { role: "AXTextField", title: "Password", secure: true }),
    ]);
    const secureRun = setup([click, done], {
      screens: [secureInitial, secureInitial, afterClick],
    });
    await secureRun.worker.submit("reverify_secure_present", "Save the note");
    await secureRun.worker.idle();

    expect(secureRun.worker.snapshot().state).toBe("completed");
    expect(secureRun.hands.commands).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
      { kind: "click", x: 150, y: 212, button: "left", count: 1 },
      { kind: "observe", image: true, elements: true },
    ]);
  });

  it("falls back to full AX look in reverify() when pixels change right at the click target even under the cursor", async () => {
    // Button 1 is at screen (110, 200, 80x24) -> center (150, 212) -> image (24..42, 40..45) on 320x180.
    // Cursor sits directly on top of the button at (150, 212)!
    const frameCancel = makeJpeg(320, 180, {
      rects: [{ x: 24, y: 40, w: 18, h: 5, r: 220, g: 220, b: 220 }],
    });
    const frameDeleteSwap = makeJpeg(320, 180, {
      rects: [{ x: 26, y: 40, w: 10, h: 5, r: 20, g: 20, b: 20 }],
    });
    const initial = realObs(frameCancel, [element(1, { title: "Cancel" })], {
      cursor: { x: 150, y: 212 },
    });
    const axSwapped = realObs(
      frameDeleteSwap,
      [element(1, { title: "Delete" })],
      { cursor: { x: 150, y: 212 } },
    );
    const { worker, hands } = setup([click, done], {
      screens: [initial, axSwapped, axSwapped],
    });
    await worker.submit("reverify_target_swap_under_cursor", "Click Cancel");
    await worker.idle();

    // The press on the button walks the tree at once, sees that the label
    // changed from Cancel to Delete, and withholds the click.
    expect(hands.sent).toEqual([]);
    expect(hands.commands.slice(0, 2)).toEqual([
      { kind: "observe", image: true, elements: true },
      { kind: "observe", image: false, elements: true },
    ]);
  });

  it("detects a small UI toggle right under the cursor in judge() as changed (not stillAfter)", async () => {
    // Button/toggle at screen (110, 200, 80x24) -> center (150, 212) -> image ~(33, 42) on 320x180.
    // After clicking it, the pointer rests at (150, 212) and a small 20x15px toggle fills right under the cursor.
    // Previously +/-2 cell cursor masking hid ~25x25px around the cursor and falsely flagged stillAfter!
    const toggleOff = makeJpeg(320, 180, {
      rects: [{ x: 24, y: 36, w: 20, h: 14, r: 220, g: 220, b: 220 }],
    });
    const toggleOn = makeJpeg(320, 180, {
      rects: [{ x: 24, y: 36, w: 20, h: 14, r: 30, g: 130, b: 240 }],
    });
    const initial = realObs(toggleOff, [element(1, { title: "Save" })], {
      cursor: { x: 150, y: 212 },
    });
    const fastSame = realObs(toggleOff, [element(1, { title: "Save" })], {
      cursor: { x: 150, y: 212 },
    });
    // Same AX elements, cursor sitting directly on the toggled widget, only pixels under cursor changed.
    const afterToggle = realObs(toggleOn, [element(1, { title: "Save" })], {
      cursor: { x: 150, y: 212 },
    });
    const { worker, planner } = setup([click, done], {
      screens: [initial, fastSame, afterToggle],
      unchangedDone: true,
    });
    await worker.submit("judge_toggle_under_cursor", "Toggle Save");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // Done was accepted on the first try (not rejected as stillAfter)!
    expect(planner.inputs).toHaveLength(2);
    expect(planner.inputs[1]!.history[0]?.outcome).toBe("ok");
  });
});

describe("a screen with small regions that keep changing", () => {
  // A made-up screen of 1440 by 900 points as a picture of 320 by 180
  // pixels: one cell of the 64 by 36 grid is 5 by 5 pixels.
  type Paint = { x: number; y: number; w: number; h: number; luma: number };
  const picture = (paints: Paint[]) => {
    const width = 320;
    const height = 180;
    const data = Buffer.alloc(width * height * 4, 220);
    for (const { x, y, w, h, luma } of paints)
      for (let py = y; py < Math.min(height, y + h); py++)
        for (let px = x; px < Math.min(width, x + w); px++) {
          const off = (py * width + px) * 4;
          data[off] = data[off + 1] = data[off + 2] = luma;
        }
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return jpeg.encode({ data, width, height }, 85).data.toString("base64");
  };
  const look = (paints: Paint[], elements = [element(1, { title: "Save" })]) =>
    observation(elements, {
      image: picture(paints),
      imageWidth: 320,
      imageHeight: 180,
    });
  /** The Save button of the fixture (110, 200, 80 by 24 points), drawn. */
  const saveButton: Paint = { x: 25, y: 40, w: 18, h: 6, luma: 60 };
  /** An animation well beside the button: a block that moves on in each frame. */
  const animation = (frame: number): Paint => ({
    x: 80 + (frame % 3) * 15,
    y: 30,
    w: 20,
    h: 40,
    luma: 30,
  });
  const animated = (frame: number, extra: Paint[] = []) =>
    look([saveButton, animation(frame), ...extra]);
  const frames = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => animated(from + i));
  const fullLook = { kind: "observe", image: true, elements: true };
  const quickLook = { kind: "observe", image: true, elements: false };
  const axLook = { kind: "observe", image: false, elements: true };
  const saveClick = { kind: "click", x: 150, y: 212, button: "left", count: 1 };
  // A press on an element always walks the tree (its name may have changed
  // in place), so the quick picture is shown with a hover.
  const hoverSave: Action = { kind: "hover", element: 1 };
  const saveHover = { kind: "move", x: 150, y: 212 };

  it("lets the hover go after one more quick look when only an animation beside the button changed", async () => {
    const { worker, hands } = setup([hoverSave, done], {
      screens: [animated(0), animated(1), animated(2), animated(0)],
    });
    await worker.submit("animated_beside", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // No walk of the tree: the target looked the same in all three looks.
    expect(hands.commands).toEqual([
      fullLook,
      quickLook,
      quickLook,
      saveHover,
      fullLook,
    ]);
  });

  it("clicks the button at once after a walk of the tree, whatever moves beside it", async () => {
    const { worker, hands } = setup([click, done], {
      screens: [animated(0), animated(1), animated(2)],
    });
    await worker.submit("animated_click", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // The name and role of the button are read again: no quick picture.
    expect(hands.commands).toEqual([fullLook, axLook, saveClick, fullLook]);
  });

  it("uses what it learned: the next hover on the same window needs no extra look", async () => {
    const { worker, hands } = setup([hoverSave, hoverSave, done], {
      screens: [
        animated(0),
        animated(1),
        animated(2),
        animated(0),
        animated(1),
        animated(2),
      ],
    });
    await worker.submit("animated_learned", "Save the note");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    expect(hands.commands).toEqual([
      fullLook,
      quickLook,
      quickLook,
      saveHover,
      fullLook,
      quickLook,
      saveHover,
      fullLook,
    ]);
  });

  it("settles on an animated page after the panel refused the click three times, then clicks", async () => {
    const { worker, hands, journal, said } = setup(
      [click, click, click, click, done],
      { screens: frames(60) },
    );
    let refused = 3;
    hands.answer = (command) =>
      command.kind === "click" && refused-- > 0
        ? { ok: false, error: "stale_observation" }
        : undefined;
    await worker.submit("animated_settle", "Save the note");
    await worker.idle();

    expect(said.at(-1)).toBe("Done. The note is saved.");
    expect(journal.get("animated_settle")).toMatchObject({
      state: "completed",
    });
    expect(hands.sent).toHaveLength(4);
    expect(
      hands.labels.filter((label) => label === "Wait for the screen to settle"),
    ).toHaveLength(3);
  });

  // The menu bar of the same screen: row 0 of the grid, 0 to 25 points.
  // The Stop button sits left of the clock strip, with a blinking
  // recording dot one cell beside it.
  const stop = element(1, {
    role: "AXMenuBarItem",
    title: "Stop Recording",
    x: 864,
    y: 2,
    w: 22,
    h: 20,
  });
  const stopIcon: Paint = { x: 193, y: 1, w: 4, h: 3, luma: 40 };
  const dot: Paint = { x: 182, y: 1, w: 6, h: 3, luma: 30 };
  /** A recording timer pill left of the dot that ticks: five cells. */
  const timer = (tick: number): Paint => ({
    x: 165,
    y: 0,
    w: 15,
    h: 5,
    luma: tick % 2 ? 30 : 200,
  });
  const menuBar = (frame: number, extra: Paint[] = []) =>
    look([saveButton, stopIcon, ...(frame % 2 ? [dot] : []), ...extra], [stop]);
  const stopClick = { kind: "click", x: 875, y: 12, button: "left", count: 1 };
  const clickStop: Action = { kind: "click_element", element: 1 };
  const hoverStop: Action = { kind: "hover", element: 1 };
  const stopHover = { kind: "move", x: 875, y: 12 };

  it("hovers over Stop Recording in the menu bar while the recording dot beside it blinks", async () => {
    const { worker, hands } = setup([hoverStop, done], {
      screens: [menuBar(0), menuBar(1), menuBar(0)],
    });
    await worker.submit("menu_bar_dot", "Stop the recording");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    // The check used the button's own cells: the dot beside it did not count.
    expect(hands.commands).toEqual([fullLook, quickLook, stopHover, fullLook]);
  });

  it("clicks Stop Recording after a walk of the tree while the recording dot blinks", async () => {
    const { worker, hands } = setup([clickStop, done], {
      screens: [menuBar(0), menuBar(1), menuBar(0)],
    });
    await worker.submit("menu_bar_dot_click", "Stop the recording");
    await worker.idle();

    expect(worker.snapshot().state).toBe("completed");
    expect(hands.commands).toEqual([fullLook, axLook, stopClick, fullLook]);
  });

  it("settles while a recording timer in the menu bar status area ticks, then clicks Stop", async () => {
    const { worker, hands, journal, said } = setup(
      [clickStop, clickStop, clickStop, clickStop, done],
      {
        screens: Array.from({ length: 60 }, (_, i) => menuBar(i, [timer(i)])),
      },
    );
    let refused = 3;
    hands.answer = (command) =>
      command.kind === "click" && refused-- > 0
        ? { ok: false, error: "stale_observation" }
        : undefined;
    await worker.submit("menu_bar_timer", "Stop the recording");
    await worker.idle();

    expect(said.at(-1)).toBe("Done. The note is saved.");
    expect(journal.get("menu_bar_timer")).toMatchObject({
      state: "completed",
    });
    expect(hands.sent).toHaveLength(4);
  });

  it("still takes a full look when the button itself changed beside the animation", async () => {
    const changedButton: Paint = { ...saveButton, luma: 200 };
    const { worker, hands } = setup([hoverSave, done], {
      screens: [
        animated(0),
        look([changedButton, animation(1)]),
        look([changedButton, animation(2)]),
        look([changedButton, animation(0)]),
      ],
    });
    await worker.submit("target_changed", "Save the note");
    await worker.idle();

    const clickAt = hands.commands.findIndex((c) => c.kind === "move");
    // The look just before the hover walked the tree again.
    expect(hands.commands.slice(0, clickAt)).toEqual([
      fullLook,
      quickLook,
      axLook,
    ]);
  });

  it("still takes a full look when the Stop button itself changed in the menu bar", async () => {
    const gone: Paint = { ...stopIcon, luma: 220 };
    const { worker, hands } = setup([hoverStop, done], {
      screens: [
        menuBar(0),
        look([saveButton, gone, dot], [stop]),
        look([saveButton, gone], [stop]),
      ],
    });
    await worker.submit("stop_changed", "Stop the recording");
    await worker.idle();

    const clickAt = hands.commands.findIndex((c) => c.kind === "move");
    expect(hands.commands.slice(0, clickAt)).toEqual([
      fullLook,
      quickLook,
      axLook,
    ]);
  });

  it("still takes a full look after a small change that came once and held", async () => {
    const badge: Paint = { x: 230, y: 100, w: 30, h: 20, luma: 40 };
    const { worker, hands } = setup([click, done], {
      screens: [
        look([saveButton]),
        look([saveButton, badge]),
        look([saveButton, badge]),
        look([saveButton, badge]),
      ],
    });
    await worker.submit("held_change", "Save the note");
    await worker.idle();

    const clickAt = hands.commands.findIndex((c) => c.kind === "click");
    expect(hands.commands[clickAt - 1]).toEqual(axLook);
    expect(
      hands.commands.slice(0, clickAt).filter((c) => c.kind === "observe"),
    ).not.toContainEqual(
      expect.objectContaining({ image: false, elements: false }),
    );
  });

  it("still takes a full look at once after a large change, with no extra quick look", async () => {
    const window: Paint = { x: 60, y: 20, w: 250, h: 150, luma: 90 };
    const { worker, hands } = setup([hoverSave, done], {
      screens: [
        look([saveButton]),
        look([saveButton, window]),
        look([saveButton, window]),
      ],
    });
    await worker.submit("large_change", "Save the note");
    await worker.idle();

    const clickAt = hands.commands.findIndex((c) => c.kind === "move");
    expect(hands.commands.slice(0, clickAt)).toEqual([
      fullLook,
      quickLook,
      axLook,
    ]);
  });

  it("does not settle while a large region keeps changing, and ends as before", async () => {
    const video = (frame: number): Paint => ({
      x: 60,
      y: 20,
      w: 250,
      h: 150,
      luma: frame % 2 ? 40 : 160,
    });
    const { worker, hands, journal } = setup(
      [click, click, click, click, done],
      {
        screens: Array.from({ length: 60 }, (_, i) =>
          look([saveButton, video(i)]),
        ),
      },
    );
    hands.answer = (command) =>
      command.kind === "click"
        ? { ok: false, error: "stale_observation" }
        : undefined;
    await worker.submit("large_video", "Save the note");
    await worker.idle();

    expect(journal.get("large_video")).toMatchObject({
      state: "blocked",
      reason: "repeated_hold",
    });
    expect(
      hands.labels.filter((label) => label === "Wait for the screen to settle"),
    ).toHaveLength(8);
  });
});
