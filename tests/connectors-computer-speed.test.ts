import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerJournal,
  setComputerSwitch,
} from "../connectors/computer/journal.js";
import {
  handsChangeCheckMs,
  handsCostHeader,
  HandsTimeout,
  handsWaitLimitMs,
  PanelHands,
  parseHandsCost,
  type HandsClock,
} from "../connectors/computer/panel-hands.js";
import { handsNextSchema } from "../connectors/computer/ports.js";
import {
  buildComputer,
  computerPort,
  offComputerPort,
} from "../connectors/computer/service.js";
import {
  readTimings,
  recordTiming,
  timingLine,
} from "../connectors/computer/timing.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import type { TaskService } from "../src/control/task-service.js";
import { DomainError } from "../src/storage/security.js";
import { ScriptedPlanner } from "./connectors-computer-fixture.js";

/** A clock that moves only when the test moves it. */
class TestClock implements HandsClock {
  time = 0;
  private timers: { at: number; fire: () => void; id: number }[] = [];
  private count = 0;
  now() {
    return this.time;
  }
  later(fire: () => void, ms: number) {
    const id = ++this.count;
    this.timers.push({ at: this.time + ms, fire, id });
    return id;
  }
  cancel(timer: unknown) {
    this.timers = this.timers.filter((item) => item.id !== timer);
  }
  /** Moves the time on and fires every timer that is due, in order. */
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((item) => item.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((item) => item !== due);
      this.time = due.at;
      due.fire();
    }
    this.time = end;
  }
  get pending() {
    return this.timers.length;
  }
}

/** Whether a promise has settled, after every callback that is due ran. */
async function settled(promise: Promise<unknown>) {
  let over = false;
  promise.then(
    () => (over = true),
    () => (over = true),
  );
  await new Promise((done) => setImmediate(done));
  return over;
}

const click = {
  kind: "click",
  x: 10,
  y: 20,
  button: "left",
  count: 1,
} as const;

describe("a held read of the next command", () => {
  it("answers as soon as a command waits, and the panel then reads it with no wait", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock });
    const held = hands.wait(0, 1000);
    clock.advance(400);
    expect(await settled(held)).toBe(false);
    const running = hands.run(click, "Click Save");
    // No time passed: the read is answered at the moment the command is queued.
    expect(await settled(held)).toBe(true);
    expect(clock.time).toBe(400);
    // Only the time limit of the command is left; the held read left no timer.
    expect(clock.pending).toBe(1);
    // The held read served nothing: Stop could still take the command back.
    expect(hands.next(0)).toEqual({
      seq: 1,
      command: click,
      label: "Click Save",
    });
    expect(hands.result({ seq: 1, ok: true })).toBe(true);
    expect(await running).toEqual({ seq: 1, ok: true });
    expect(hands.takeCost()).toEqual({ pollWaitMs: 0 });
  });

  it("answers at once when a command waits already, and holds for a command that the panel ran", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 5, clock });
    void hands.run(click, "Click").catch(() => {});
    expect(await settled(hands.wait(0, 1000))).toBe(true);
    // Number 5 is the one that the panel ran: nothing waits above it.
    const above = hands.wait(5, 1000);
    expect(await settled(above)).toBe(false);
    clock.advance(1000);
    expect(await settled(above)).toBe(true);
    hands.withdraw();
  });

  it("ends after its time when nothing comes, and never holds more than two seconds", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock });
    const held = hands.wait(0, 1000);
    clock.advance(999);
    expect(await settled(held)).toBe(false);
    clock.advance(1);
    expect(await settled(held)).toBe(true);
    expect(clock.pending).toBe(0);
    const long = hands.wait(0, 60_000);
    clock.advance(handsWaitLimitMs - 1);
    expect(await settled(long)).toBe(false);
    clock.advance(1);
    expect(await settled(long)).toBe(true);
    // No wait, or a wait that is not a number, answers at once.
    for (const ms of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(await settled(hands.wait(0, ms))).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it("answers when what runs changes, at the next look, with no busy loop", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock });
    let state = "running";
    let asked = 0;
    const held = hands.wait(0, 1000, {
      changed: () => {
        asked++;
        return state !== "running";
      },
    });
    clock.advance(250);
    expect(await settled(held)).toBe(false);
    // A look every 100 ms: two so far, and one timer for the next look and one for the end.
    expect(asked).toBe(2);
    expect(clock.pending).toBe(2);
    state = "waiting_for_person";
    clock.advance(handsChangeCheckMs);
    expect(await settled(held)).toBe(true);
    expect(clock.time).toBe(350);
    expect(asked).toBe(3);
    expect(clock.pending).toBe(0);
  });

  it("ends at once when the panel gives up the read, and then serves nothing", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock });
    const gone = new AbortController();
    const held = hands.wait(0, 1000, { signal: gone.signal });
    gone.abort();
    expect(await settled(held)).toBe(true);
    expect(clock.pending).toBe(0);
    // The command that comes after is not taken by the read that was given up.
    const running = hands.run(click, "Click");
    expect(hands.withdraw()).toBe(true);
    expect((await running).error).toBe("stopped_by_person");
    // A read that was given up before it began does not wait either.
    expect(await settled(hands.wait(0, 1000, { signal: gone.signal }))).toBe(
      true,
    );
  });

  it("keeps the time limit of a command on the same clock", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock, timeoutMs: 100 });
    const running = hands.run(click, "Click");
    clock.advance(99);
    expect(await settled(running)).toBe(false);
    clock.advance(1);
    await expect(running).rejects.toEqual(new HandsTimeout(false));
  });
});

describe("what the hands spent on a step", () => {
  it("counts the wait of each command from its queue to its first read", async () => {
    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock });
    const first = hands.run(click, "Click");
    clock.advance(120);
    hands.next(0);
    // A second read of the same command adds nothing.
    clock.advance(80);
    hands.next(0);
    hands.result({ seq: 1, ok: true });
    await first;
    const second = hands.run({ kind: "key", combo: "return" }, "Press return");
    clock.advance(3);
    hands.next(1);
    hands.result({ seq: 2, ok: true });
    await second;
    expect(hands.takeCost()).toEqual({ pollWaitMs: 123 });
    // Taken once: the next step counts from zero.
    expect(hands.takeCost()).toEqual({});
  });

  it("takes the cost header of the panel as numbers only, and only with the result of the command", async () => {
    expect(
      parseHandsCost("capture=93;encode=21;bytes=183422;walk=412;glide=360"),
    ).toEqual({
      captureMs: 93,
      encodeMs: 21,
      imageBytes: 183_422,
      walkMs: 412,
      glideMs: 360,
    });
    // A part that this service does not know is left out, also a name of the language itself.
    expect(parseHandsCost("walk=4;zoom=9;constructor=1;proto=2")).toEqual({
      walkMs: 4,
    });
    for (const header of [
      undefined,
      null,
      "",
      "walk",
      "walk=-1",
      "walk=1.5",
      "walk=4;;glide=2",
      "walk=999999999",
      "Walk=4",
      `walk=4;${"glide=1;".repeat(40)}`,
      "walk=4 glide=2",
    ])
      expect(parseHandsCost(header)).toBeNull();

    const clock = new TestClock();
    const hands = new PanelHands({ first: 1, clock });
    const look = hands.run(
      { kind: "observe", image: true, elements: true },
      "Look at the screen",
    );
    hands.next(0);
    // A result for another number is not taken, and nor is its cost.
    expect(hands.result({ seq: 9, ok: true }, "capture=500")).toBe(false);
    expect(hands.result({ seq: 1, ok: true }, "capture=90;walk=300")).toBe(
      true,
    );
    await look;
    const act = hands.run(click, "Click");
    hands.next(1);
    // A header that is not one changes nothing in the result.
    expect(hands.result({ seq: 2, ok: true }, "glide=a lot")).toBe(true);
    await act;
    const key = hands.run({ kind: "key", combo: "return" }, "Press return");
    hands.next(2);
    hands.result({ seq: 3, ok: true }, "walk=40;glide=0");
    await key;
    expect(hands.takeCost()).toEqual({
      captureMs: 90,
      walkMs: 340,
      glideMs: 0,
      pollWaitMs: 0,
    });
    expect(handsCostHeader).toBe("x-clawdtime-hands-cost");
  });

  it("is kept in the timing record and printed with the step", () => {
    const root = mkdtempSync(join(tmpdir(), "clawdtime-computer-speed-"));
    roots.push(root);
    recordTiming(
      root,
      {
        step: 3,
        kind: "click_element",
        lookMs: 410,
        planMs: 1800,
        actMs: 520,
        captureMs: 91.4,
        encodeMs: 18,
        imageBytes: 162_000,
        walkMs: 287,
        glideMs: 352,
        pollWaitMs: -3,
      },
      () => Date.UTC(2026, 10, 25, 9),
    );
    const [kept] = readTimings(root);
    expect(kept).toEqual({
      at: Date.UTC(2026, 10, 25, 9),
      step: 3,
      kind: "click_element",
      lookMs: 410,
      planMs: 1800,
      actMs: 520,
      captureMs: 91,
      encodeMs: 18,
      imageBytes: 162_000,
      walkMs: 287,
      glideMs: 352,
      pollWaitMs: 0,
    });
    expect(timingLine(kept!)).toBe(
      "2026-11-25T09:00:00.000Z step 3 click_element: look 410 ms, plan 1800 ms, act 520 ms (hands: capture 91 ms, encode 18 ms, image 158 KB, walk 287 ms, glide 352 ms, poll wait 0 ms)",
    );
    // A part that the step did not have is not in the record.
    recordTiming(
      root,
      {
        step: 4,
        kind: "type",
        lookMs: 0,
        planMs: 900,
        actMs: 80,
        glideMs: 0,
        walkMs: Number.NaN,
      },
      () => Date.UTC(2026, 10, 25, 9, 1),
    );
    expect(timingLine(readTimings(root)[1]!)).toBe(
      "2026-11-25T09:01:00.000Z step 4 type: look 0 ms, plan 900 ms, act 80 ms (hands: glide 0 ms)",
    );
  });

  it("goes from the hands of the service into the record of each step", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawdtime-computer-speed-"));
    roots.push(root);
    setComputerSwitch(root, true);
    const built = buildComputer({
      root,
      env: { CLAWDTIME_OPENAI_API_KEY: "k", CLAWDTIME_COMPUTER_TIMING: "on" },
    });
    const inside = built.worker as unknown as {
      hands: PanelHands;
      timing: (entry: unknown) => void;
    };
    const looked = inside.hands.run(
      { kind: "observe", image: true, elements: true },
      "Look at the screen",
    );
    const served = built.port.next(0).command!;
    expect(
      built.port.result({ seq: served.seq, ok: true }, "capture=88;walk=120"),
    ).toBe(true);
    await looked;
    inside.timing({
      step: 1,
      kind: "click_element",
      lookMs: 230,
      planMs: 0,
      actMs: 400,
    });
    const [kept] = readTimings(root);
    expect(kept).toMatchObject({ step: 1, captureMs: 88, walkMs: 120 });
    expect(kept!.pollWaitMs).toBeGreaterThanOrEqual(0);
    // Taken with that step: the next step starts from zero.
    inside.timing({ step: 2, kind: "done", lookMs: 0, planMs: 0, actMs: 0 });
    expect(readTimings(root)[1]).not.toHaveProperty("captureMs");
  });
});

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const panel = "p".repeat(40);
const desktop = {
  authorizePanel(value: string) {
    if (value !== panel)
      throw new DomainError(401, "Desktop authorization required.");
  },
} as TaskDesktopService;

function routes(port: Parameters<typeof createTaskApp>[10]) {
  const app = createTaskApp(
    {} as TaskService,
    "o".repeat(40),
    undefined,
    undefined,
    undefined,
    undefined,
    desktop,
    undefined,
    undefined,
    undefined,
    port,
  );
  return async (path: string): Promise<Response> =>
    app.request(path, { headers: { authorization: `Bearer ${panel}` } });
}

describe("the route of the next command, held", () => {
  it("answers when the worker queues its first command, and says that it held the read", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-speed-"));
    roots.push(home);
    const hands = new PanelHands({ first: 1, timeoutMs: 5000 });
    const worker = new ComputerWorker({
      hands,
      planner: new ScriptedPlanner([]),
      journal: new ComputerJournal(home),
    });
    const get = routes(computerPort(worker, hands));
    const began = Date.now();
    const held = get("/desktop/hands/next?after=0&wait=1000");
    expect(await settled(held)).toBe(false);
    await worker.submit("r1", "Save the note");
    const answer = await held;
    // The command came long before the time of the read ran out.
    expect(Date.now() - began).toBeLessThan(900);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-clawdtime-hands-wait")).toBe("1000");
    const read = handsNextSchema.parse(await answer.json());
    expect(read.command?.command).toEqual({
      kind: "observe",
      image: true,
      elements: true,
    });
    expect(read.run.active).toBe(true);
    // A read with no wait is as before: at once, with no such header.
    const plain = await get("/desktop/hands/next?after=0");
    expect(plain.headers.get("x-clawdtime-hands-wait")).toBeNull();
    expect(handsNextSchema.parse(await plain.json()).command).toEqual(
      read.command,
    );
    // A wait that is not one is refused, as a number after that is not one.
    for (const wait of ["", "abc", "-1", "1.5", "2001", "99999"])
      expect(
        (await get(`/desktop/hands/next?after=0&wait=${wait}`)).status,
      ).toBe(400);
    worker.stop();
  });

  it("answers when what runs changes, also with no command", async () => {
    const home = mkdtempSync(join(tmpdir(), "clawdtime-computer-speed-"));
    roots.push(home);
    const hands = new PanelHands({ first: 1, timeoutMs: 5000 });
    const worker = new ComputerWorker({
      hands,
      planner: new ScriptedPlanner([]),
      journal: new ComputerJournal(home),
    });
    const get = routes(computerPort(worker, hands));
    await worker.submit("r1", "Save the note");
    const first = handsNextSchema.parse(
      await (await get("/desktop/hands/next?after=0")).json(),
    );
    const seq = first.command!.seq;
    // The panel ran the command; its next read is held until the run stops.
    const held = get(`/desktop/hands/next?after=${seq}&wait=2000`);
    expect(await settled(held)).toBe(false);
    const began = Date.now();
    worker.stop();
    const read = handsNextSchema.parse(await (await held).json());
    expect(Date.now() - began).toBeLessThan(1500);
    expect(read.command).toBeNull();
    expect(read.run.state).not.toBe("running");
  });

  it("is not held where no worker runs", async () => {
    const get = routes(offComputerPort("Off."));
    const began = Date.now();
    const answer = await get("/desktop/hands/next?after=0&wait=1000");
    expect(Date.now() - began).toBeLessThan(500);
    expect(answer.headers.get("x-clawdtime-hands-wait")).toBeNull();
    expect(handsNextSchema.parse(await answer.json()).command).toBeNull();
  });
});
