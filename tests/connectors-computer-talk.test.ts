import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type ModelClient } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { ComputerJournal } from "../connectors/computer/journal.js";
import type { Action } from "../connectors/computer/ports.js";
import { ComputerWorker, stoppedText } from "../connectors/computer/worker.js";
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
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-talk-"));
  roots.push(path);
  return path;
};

const click: Action = { kind: "click_element", element: 1 };
const done: Action = { kind: "done", summary: "The mail is sent." };
/** A model that hands every request to the computer, as the real one does for an action request. */
const delegating = (): ModelClient & {
  complete: ReturnType<typeof vi.fn>;
} => ({
  complete: vi.fn(async () => ({
    text: "",
    toolCalls: [{ id: "a", name: "delegate_computer_task", arguments: "{}" }],
  })),
});

function setup(model: ModelClient | null = delegating()) {
  const root = home();
  const hands = new FakeHands([observation([element(1, { title: "Send" })])]);
  const said: string[] = [];
  const worker = new ComputerWorker({
    hands,
    planner: new ScriptedPlanner([click, done]),
    journal: new ComputerJournal(root),
    notify: (text) => said.push(text),
  });
  const desk = new DecisionDesk(root);
  const supervisor = new Supervisor(
    {
      now: Date.now,
      board: () => null,
      desk,
      focus: async () => ({ ok: false }),
      send: async () => ({ ok: false, route: "none" }),
      clis: () => [],
      execution: worker,
    },
    model,
  );
  const waiting = () =>
    until(() => worker.snapshot().state === "waiting_for_person");
  return { root, hands, said, worker, desk, supervisor, model, waiting };
}

describe("the person talks to a computer worker that waits", () => {
  it("starts the work from the person's own words, and their next message answers its question", async () => {
    const f = setup();
    const model = f.model as ReturnType<typeof delegating>;
    expect(
      await f.supervisor.reply([], "Open the draft and send the mail", "chat"),
    ).toMatch(/^Started\./);
    expect(model.complete).toHaveBeenCalledTimes(1);
    await f.waiting();
    // The question came to the chat by itself.
    expect(f.said).toHaveLength(1);
    expect(f.said[0]).toMatch(/^Click "Send"\?/);
    expect(f.hands.sent).toEqual([]);
    // A plain yes is the answer to that question. The model is not asked.
    expect(await f.supervisor.reply([], "yes", "chat")).toBe("Continuing.");
    expect(model.complete).toHaveBeenCalledTimes(1);
    await f.worker.idle();
    expect(f.hands.sent).toHaveLength(1);
    expect(f.worker.snapshot().state).toBe("completed");
    expect(f.said.at(-1)).toBe("Done. The mail is sent.");
  });

  it("a no cancels, by voice as well", async () => {
    const f = setup(null);
    await f.worker.submit("r1", "Send the mail");
    await f.waiting();
    expect(await f.supervisor.reply([], "No, do not send it.", "voice")).toBe(
      'Canceled. I did not do it: Click "Send".',
    );
    await f.worker.idle();
    expect(f.hands.sent).toEqual([]);
    expect(f.worker.snapshot().state).toBe("canceled");
  });

  it("words that are not a clear answer change nothing, and the question is said again", async () => {
    const f = setup();
    const model = f.model as ReturnType<typeof delegating>;
    await f.worker.submit("r1", "Send the mail");
    await f.waiting();
    for (const words of ["hmm, what is in it?", "open the calendar", "maybe"]) {
      const reply = await f.supervisor.reply([], words, "chat");
      expect(reply).toMatch(/^I did not get a clear answer\. Click "Send"\?/);
    }
    // Nothing reached the model, so nothing new was started in the meantime.
    expect(model.complete).not.toHaveBeenCalled();
    expect(f.worker.snapshot().state).toBe("waiting_for_person");
    expect(f.hands.sent).toEqual([]);
    f.worker.stop();
  });

  it("stop still stops, and a question about the state still tells the state", async () => {
    const f = setup(null);
    await f.worker.submit("r1", "Send the mail");
    await f.waiting();
    expect(await f.supervisor.reply([], "computer status", "chat")).toMatch(
      /^Click "Send"\?/,
    );
    expect(f.worker.snapshot().state).toBe("waiting_for_person");
    expect(await f.supervisor.reply([], "Stop.", "chat")).toBe(stoppedText);
    expect(f.worker.snapshot().state).toBe("canceled");
    expect(f.hands.sent).toEqual([]);
  });

  it("takes no answer for the worker when it does not wait", async () => {
    const f = setup(null);
    const answer = vi.spyOn(f.worker, "answer");
    expect(await f.supervisor.reply([], "yes", "chat")).toBe(
      "There is no pending request to approve or deny. Nothing was authorized.",
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it("answers neither when an agent's request waits at the same time", async () => {
    const f = setup(null);
    await f.worker.submit("r1", "Send the mail");
    await f.waiting();
    const asked = f.desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "npm test",
        options: [],
      },
      holdSeconds: 45,
    });
    const reply = await f.supervisor.reply([], "yes", "chat");
    expect(reply).toBe(
      "The computer task and an agent's request both wait for you. Answer the agent's request first, in the panel or in its terminal. Then answer the computer task here.",
    );
    // The yes went to neither of them.
    expect(f.desk.take(asked.id)).toBeNull();
    expect(f.worker.snapshot().state).toBe("waiting_for_person");
    expect(f.hands.sent).toEqual([]);
    // Once the agent has its answer, the yes is the worker's.
    expect(f.desk.answer(asked.id, { decision: "deny", via: "panel" })).toBe(
      true,
    );
    expect(await f.supervisor.reply([], "yes", "chat")).toBe("Continuing.");
    await f.worker.idle();
    expect(f.hands.sent).toHaveLength(1);
  });

  it("leaves a connection that cannot take an answer as it was", async () => {
    const root = home();
    const execution = {
      snapshot: () => ({
        configured: true,
        state: "waiting_for_person",
        canStop: true,
        message: "Waiting.",
      }),
      submit: vi.fn(async () => ({ message: "Queued." })),
      stop: vi.fn(),
    };
    const supervisor = new Supervisor(
      {
        now: Date.now,
        board: () => null,
        desk: new DecisionDesk(root),
        focus: async () => ({ ok: false }),
        send: async () => ({ ok: false, route: "none" }),
        clis: () => [],
        execution,
      },
      null,
    );
    expect(await supervisor.reply([], "yes", "chat")).toBe(
      "There is no pending request to approve or deny. Nothing was authorized.",
    );
  });
});

describe("the chat of the panel", () => {
  it("shows the worker's state, its question and the reply to the person's answer", async () => {
    const root = home();
    const hands = new FakeHands([observation([element(1, { title: "Send" })])]);
    let feed: BoardFeed | undefined;
    const worker = new ComputerWorker({
      hands,
      planner: new ScriptedPlanner([click, done]),
      journal: new ComputerJournal(root),
      notify: (text) => feed?.appendExecutionResult(text),
    });
    feed = new BoardFeed({
      root,
      model: null,
      speech: null,
      execution: worker,
    });
    expect(feed.chat().execution).toMatchObject({
      configured: true,
      state: "idle",
      canStop: false,
    });
    await worker.submit("r1", "Send the mail");
    await until(() => worker.snapshot().state === "waiting_for_person");
    expect(feed.chat().execution).toMatchObject({
      state: "waiting_for_person",
      canStop: true,
    });
    const reply = await feed.say("yes");
    expect(reply).toMatchObject({ role: "assistant", text: "Continuing." });
    await worker.idle();
    expect(feed.chat().messages.map((message) => message.text)).toEqual([
      'Click "Send"? "Send" may be something that cannot be undone, or that speaks for you. Say yes to allow it, or no to stop.',
      "yes",
      "Continuing.",
      "Done. The mail is sent.",
    ]);
    expect(feed.chat().execution).toMatchObject({
      state: "completed",
      canStop: false,
    });
    feed.close();
  });
});
