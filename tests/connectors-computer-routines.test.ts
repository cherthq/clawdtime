import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { routineCli } from "../cli/routine.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type {
  ReachTextPort,
  TextOutcome,
} from "../connectors/computer/reach.js";
import { withOwnerWords } from "../connectors/computer/reach.js";
import {
  nextTime,
  readRoutineWords,
  Routines,
  routinesFile,
  scheduleText,
  type RoutineWorker,
} from "../connectors/computer/routines.js";
import { ComputerWorker } from "../connectors/computer/worker.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";
import {
  element,
  FakeHands,
  observation,
  ScriptedPlanner,
} from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function home() {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-routines-"));
  roots.push(path);
  return path;
}

/** The time of day on this Mac, on 25 November 2026 and the days after it. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute, 0, 0).getTime();

/** A worker that keeps what it was handed. The test sets what it says. */
class FakeWorker implements RoutineWorker {
  now: DesktopExecutionSnapshot = {
    configured: true,
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Computer use is on.",
  };
  readonly submitted: { id: string; text: string }[] = [];
  snapshot() {
    return this.now;
  }
  async submit(id: string, text: string) {
    this.submitted.push({ id, text });
    this.now = {
      requestId: id,
      configured: true,
      mode: "native",
      state: "running",
      canStop: true,
      message: `Working on: "${text}".`,
      goal: text,
    };
    return { message: "Started." };
  }
  set(state: string, message: string) {
    this.now = { ...this.now, state, message, canStop: state === "running" };
  }
}
class FakeText implements ReachTextPort {
  ready = { ready: true, reason: "ready" };
  readonly sent: { key: string; text: string }[] = [];
  readiness() {
    return this.ready;
  }
  async send(key: string, text: string): Promise<TextOutcome> {
    this.sent.push({ key, text });
    return "sent";
  }
}

function setup(start = at(25, 8, 0)) {
  const root = home();
  const clock = { now: start };
  const worker = new FakeWorker();
  const text = new FakeText();
  const said: string[] = [];
  let live = false;
  const routines = new Routines({
    root,
    worker,
    text,
    liveCall: () => live,
    notify: (line) => said.push(line),
    now: () => clock.now,
  });
  return {
    root,
    clock,
    worker,
    text,
    said,
    routines,
    call: (value: boolean) => (live = value),
    at: async (time: number) => {
      clock.now = time;
      await routines.tick();
    },
  };
}

describe("the words of a routine", () => {
  it("reads the time, the days and the request", () => {
    expect(
      readRoutineWords(
        "every morning at 9, follow up on my latest X posts and tell me",
      ),
    ).toEqual({
      request: "follow up on my latest X posts",
      days: [0, 1, 2, 3, 4, 5, 6],
      hour: 9,
      minute: 0,
    });
    expect(
      readRoutineWords("Every weekday at 8:30 am check my mail for invoices"),
    ).toMatchObject({ days: [1, 2, 3, 4, 5], hour: 8, minute: 30 });
    expect(
      readRoutineWords("every evening at 6, read my messages and let me know"),
    ).toMatchObject({ hour: 18, request: "read my messages" });
    expect(
      readRoutineWords("each monday at 10pm: summarize my open pull requests"),
    ).toMatchObject({ days: [1], hour: 22 });
    expect(readRoutineWords("every morning, open my calendar")).toMatchObject({
      hour: 9,
      request: "open my calendar",
    });
    expect(
      readRoutineWords("every day at noon, check the build"),
    ).toMatchObject({ hour: 12, minute: 0 });
  });

  it("reads no routine in other words", () => {
    for (const words of [
      "every time I open Slack it crashes",
      "click the blue Send button",
      "every day follow up on my posts",
      "every morning at 25, check my mail",
      "every morning at 9",
    ])
      expect(readRoutineWords(words)).toBeNull();
  });

  it("says the schedule plainly and finds the next time", () => {
    expect(
      scheduleText({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }),
    ).toBe("every day at 09:00");
    expect(scheduleText({ days: [1, 2, 3, 4, 5], hour: 8, minute: 30 })).toBe(
      "every weekday at 08:30",
    );
    const daily = { days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 };
    expect(nextTime(daily, at(25, 8, 0))).toBe(at(25, 9, 0));
    expect(nextTime(daily, at(25, 9, 0))).toBe(at(26, 9, 0));
    // 25 November 2026 is a Wednesday: the next Monday is the 30th.
    expect(nextTime({ days: [1], hour: 10, minute: 0 }, at(25, 8, 0))).toBe(
      at(30, 10, 0),
    );
  });
});

describe("the list of routines", () => {
  it("adds, lists, pauses, starts again and removes, in a file for its owner only", () => {
    const { routines, root } = setup();
    const added = routines.add(
      "every morning at 9, follow up on my latest X posts and tell me",
    );
    expect(added.ok).toBe(true);
    const id = added.routine!.id;
    expect(added.message).toBe(
      `I keep a routine ${id}: every day at 09:00, "follow up on my latest X posts". I text you the result each time. Pause or remove it with: clawdtime routine pause ${id}, or remove ${id}.`,
    );
    expect(routines.list()).toHaveLength(1);
    expect(routines.list()[0]).toMatchObject({
      request: "follow up on my latest X posts",
      paused: false,
      nextAt: at(25, 9, 0),
    });
    // The same routine twice is one routine.
    routines.add("every morning at 9, follow up on my latest X posts");
    expect(routines.list()).toHaveLength(1);
    expect(routines.pause(id)!.id).toBe(id);
    expect(routines.list()[0]!.paused).toBe(true);
    routines.resume(id);
    expect(routines.list()[0]!.paused).toBe(false);
    expect(routines.remove(id)!.id).toBe(id);
    expect(routines.list()).toEqual([]);
    expect(routines.pause("00000000")).toBeNull();
    const file = routinesFile(root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "computer")).mode & 0o777).toBe(0o700);
  });

  it("is off until the owner adds one: nothing is read or started", async () => {
    const { worker, at: run } = setup();
    await run(at(25, 9, 0));
    expect(worker.submitted).toEqual([]);
  });

  it("never keeps a request that looks like a password or a key", () => {
    const { routines, root } = setup();
    const added = routines.add(
      "every day at 9, log in with password: hunter2-secret-99",
    );
    expect(added.ok).toBe(false);
    expect(routines.list()).toEqual([]);
    expect(() => readFileSync(routinesFile(root), "utf8")).toThrow();
  });

  it("takes the owner's words in the chat, on a call or by text", async () => {
    const { routines } = setup();
    const say = withOwnerWords(async (words: string) => `brain: ${words}`, {
      routine: (words) => routines.fromWords(words),
      answered: (_words, reply) => reply,
    });
    expect(await say("every evening at 6, read my messages")).toMatch(
      /^I keep a routine [a-f0-9]{8}: every day at 18:00, "read my messages"\./,
    );
    const id = routines.list()[0]!.id;
    expect(await say("list my routines")).toContain(
      `${id}  every day at 18:00  next 2026-11-25 18:00  "read my messages"`,
    );
    expect(await say(`pause routine ${id}`)).toBe(
      `Paused routine ${id}. A request that it started goes on.`,
    );
    expect(await say(`remove routine ${id}`)).toBe(
      `Removed routine ${id}. A request that it started goes on.`,
    );
    expect(await say("open my calendar")).toBe("brain: open my calendar");
    // A stop word always goes on to the chat, where Stop wins.
    expect(await say(`stop routine ${id}`)).toBe(`brain: stop routine ${id}`);
    expect(await say("every morning at 9, stop the music")).toBe(
      "brain: every morning at 9, stop the music",
    );
  });
});

describe("a routine at its time", () => {
  it("hands its request to the worker at its time, once, and texts the result", async () => {
    const { routines, worker, text, at: run } = setup();
    const id = routines.add(
      "every morning at 9, follow up on my latest X posts and tell me",
    ).routine!.id;
    await run(at(25, 8, 59));
    expect(worker.submitted).toEqual([]);
    await run(at(25, 9, 0));
    expect(worker.submitted).toEqual([
      {
        id: `routine_${id}_${at(25, 9, 0).toString(36)}`,
        text: "follow up on my latest X posts",
      },
    ]);
    await run(at(25, 9, 1));
    expect(worker.submitted).toHaveLength(1);
    worker.set("completed", "Done. Two posts have new replies.");
    await run(at(25, 9, 10));
    expect(text.sent).toEqual([
      {
        key: `clawdtime-routine:routine_${id}_${at(25, 9, 0).toString(36)}`,
        text: 'Routine "follow up on my latest X posts" (every day at 09:00): Done. Two posts have new replies.',
      },
    ]);
    await run(at(25, 9, 20));
    expect(text.sent).toHaveLength(1);
    expect(routines.list()[0]).toMatchObject({
      nextAt: at(26, 9, 0),
      lastOutcome: "reported",
    });
    await run(at(26, 9, 0));
    expect(worker.submitted).toHaveLength(2);
  });

  it("waits once when another request runs, then starts when the way is free", async () => {
    const { routines, worker, at: run } = setup();
    routines.add("every morning at 9, check my mail");
    worker.now = {
      ...worker.now,
      requestId: "r0",
      state: "running",
      canStop: true,
    };
    await run(at(25, 9, 0));
    expect(worker.submitted).toEqual([]);
    worker.set("completed", "Done.");
    await run(at(25, 9, 2));
    expect(worker.submitted).toHaveLength(1);
  });

  it("skips and says so by text when the way stays taken", async () => {
    const { routines, worker, text, at: run } = setup();
    routines.add("every morning at 9, check my mail");
    worker.now = {
      ...worker.now,
      requestId: "r0",
      state: "waiting_for_person",
      canStop: true,
    };
    await run(at(25, 9, 0));
    await run(at(25, 9, 4));
    expect(text.sent).toEqual([]);
    await run(at(25, 9, 5));
    expect(worker.submitted).toEqual([]);
    expect(text.sent).toHaveLength(1);
    expect(text.sent[0]!.text).toBe(
      'Routine "check my mail" (every day at 09:00): I skipped it this time: another task or a call was running.',
    );
    expect(routines.list()[0]).toMatchObject({
      lastOutcome: "skipped_busy",
      nextAt: at(26, 9, 0),
    });
  });

  it("never starts during a live call of the line", async () => {
    const { routines, worker, text, call, at: run } = setup();
    routines.add("every morning at 9, check my mail");
    call(true);
    await run(at(25, 9, 0));
    await run(at(25, 9, 3));
    await run(at(25, 9, 6));
    expect(worker.submitted).toEqual([]);
    expect(text.sent).toHaveLength(1);
    call(false);
    await run(at(25, 9, 7));
    expect(worker.submitted).toEqual([]);
  });

  it("does not run a time that passed long ago", async () => {
    const { routines, worker, at: run } = setup();
    routines.add("every morning at 9, check my mail");
    await run(at(25, 11, 0));
    expect(worker.submitted).toEqual([]);
    expect(routines.list()[0]).toMatchObject({
      lastOutcome: "missed",
      nextAt: at(26, 9, 0),
    });
  });

  it("never starts the same time twice, also from a second process", async () => {
    const first = setup();
    first.routines.add("every morning at 9, check my mail");
    await first.at(at(25, 9, 0));
    const worker = new FakeWorker();
    const second = new Routines({
      root: first.root,
      worker,
      now: () => at(25, 9, 1),
    });
    await second.tick();
    expect(first.worker.submitted).toHaveLength(1);
    expect(worker.submitted).toEqual([]);
  });

  it("says the result in the chat when no text can be sent", async () => {
    const { routines, worker, text, said, at: run } = setup();
    text.ready = { ready: false, reason: "no_line" };
    routines.add("every morning at 9, check my mail");
    await run(at(25, 9, 0));
    worker.set("blocked", "I could not finish. The page did not load.");
    await run(at(25, 9, 5));
    expect(text.sent).toEqual([]);
    expect(said).toEqual([
      'Routine "check my mail" (every day at 09:00): I could not finish. The page did not load.',
    ]);
  });

  it("starts a real worker request with the owner's words, and the worker does the rest", async () => {
    const root = home();
    let now = at(25, 8, 0);
    const journal = new ComputerJournal(root, () => now);
    const hands = new FakeHands([
      observation([element(1, { title: "Inbox" })]),
    ]);
    const worker = new ComputerWorker({
      hands,
      planner: new ScriptedPlanner([{ kind: "done", summary: "No new mail." }]),
      journal,
      now: () => now,
    });
    const text = new FakeText();
    const routines = new Routines({
      root,
      worker,
      journal,
      text,
      now: () => now,
    });
    const id = routines.add("every morning at 9, check my mail").routine!.id;
    now = at(25, 9, 0);
    await routines.tick();
    await worker.idle();
    expect(
      journal.get(`routine_${id}_${at(25, 9, 0).toString(36)}`),
    ).toMatchObject({ goal: "check my mail", state: "completed" });
    now = at(25, 9, 1);
    await routines.tick();
    expect(text.sent.map((sent) => sent.text)).toEqual([
      'Routine "check my mail" (every day at 09:00): Done. No new mail.',
    ]);
  });
});

describe("clawdtime routine", () => {
  it("adds, lists, pauses, resumes and removes in the state folder", async () => {
    const root = home();
    const lines: string[] = [];
    const run = (args: string[]) =>
      routineCli(args, {
        env: { CLAWDTIME_CONFIG_HOME: root },
        now: () => at(25, 8, 0),
        print: (line) => lines.push(line),
      });
    await run(["list"]);
    expect(lines.pop()).toMatch(/^No routine yet\./);
    await run([
      "add",
      "every",
      "weekday",
      "at",
      "8:30,",
      "check",
      "my",
      "mail",
    ]);
    const id = /routine ([a-f0-9]{8})/.exec(lines.pop()!)![1]!;
    await run(["list"]);
    expect(lines.pop()).toBe(
      `${id}  every weekday at 08:30  next 2026-11-25 08:30  "check my mail"`,
    );
    await run(["pause", id]);
    expect(lines.pop()).toBe(
      `Paused routine ${id}. A request that it started goes on.`,
    );
    await run(["resume", id]);
    expect(lines.pop()).toBe(`Routine ${id} runs again.`);
    await run(["remove", id]);
    await run(["list"]);
    expect(lines.pop()).toMatch(/^No routine yet\./);
    await expect(run(["add", "click", "the", "button"])).rejects.toThrow(
      /did not read a routine/,
    );
    await expect(run(["pause", "nope"])).rejects.toThrow(/needs the id/);
  });
});
