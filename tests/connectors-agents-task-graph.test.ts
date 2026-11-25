import {
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskGraph, graphViewLimit } from "../connectors/agents/task-graph.js";
import type { JournalRequest } from "../connectors/computer/journal.js";
import type { Routine } from "../connectors/computer/routines.js";
import type { ReachRecord } from "../connectors/computer/reach.js";
import type { DecisionRequest } from "../connectors/agents/decisions.js";
import { FakeComputer, tempRoot } from "./chat-agent-fixture.js";

const start = new Date(2026, 10, 26, 10, 0, 0).getTime();
const clock = () => {
  let now = start;
  return { now: () => now, step: (ms: number) => (now += ms) };
};

const journalEntry = (values: Partial<JournalRequest>): JournalRequest => ({
  id: "req_old",
  goal: "open X and like the newest post from NASA",
  state: "completed",
  reason: "done",
  createdAt: start - 600_000,
  updatedAt: start - 500_000,
  steps: [],
  ...values,
});

const routine = (values: Partial<Routine> = {}): Routine => ({
  id: "ab12cd34",
  request: "check my X mentions",
  days: [0, 1, 2, 3, 4, 5, 6],
  hour: 9,
  minute: 0,
  paused: false,
  createdAt: start - 86_400_000,
  nextAt: start + 3_600_000,
  ...values,
});

const deskRequest = (
  values: Partial<DecisionRequest> = {},
): DecisionRequest => ({
  version: 1,
  id: "0123456789abcdef",
  agent: "claude-code",
  sessionKey: "0".repeat(32),
  cwd: "/work/app",
  pids: [],
  kind: "permission",
  tool: "Bash",
  summary: "npm test",
  pattern: "npm test",
  options: [],
  createdAt: start,
  holdUntil: start + 600_000,
  ...values,
});

describe("the task graph", () => {
  it("follows a computer task from the engine: running, a question it waits on, the answer, the end", () => {
    const time = clock();
    const graph = new TaskGraph(tempRoot(), time.now);
    const computer = new FakeComputer().run(
      "search Aero 7 headphones on apple.com",
    );
    const request = graph.addRequest("Can you search Aero 7 headphones?");
    graph.observe({
      computer: { snapshot: computer.snapshot(), journal: [journalEntry({})] },
    });
    const task = graph.bySource(`computer:${computer.requestId}`)!;
    expect(task).toMatchObject({
      kind: "computer",
      state: "running",
      title: "search Aero 7 headphones on apple.com",
    });
    expect(graph.bySource("computer:req_old")).toMatchObject({ state: "done" });
    graph.link(task.id, "spawnedBy", request.id);

    time.step(30_000);
    computer.ask("approval", "Add to bag: Aero 7 headphones 256 GB?");
    graph.observe({ computer: { snapshot: computer.snapshot() } });
    const question = graph.nodes().find((node) => node.kind === "question")!;
    expect(question).toMatchObject({
      state: "waiting",
      title: "Add to bag: Aero 7 headphones 256 GB?",
    });
    expect(question.links.spawnedBy).toBe(task.id);
    expect(graph.get(task.id)).toMatchObject({
      state: "waiting",
      links: { waitsOn: [question.id] },
    });
    expect(graph.get(request.id)!.state).toBe("waiting");

    time.step(10_000);
    void computer.answer("yes");
    graph.observe({ computer: { snapshot: computer.snapshot() } });
    expect(graph.get(question.id)).toMatchObject({ state: "done" });
    expect(graph.get(task.id)!.state).toBe("running");

    time.step(60_000);
    computer.finish("Done. The Aero 7 headphones 256 GB is in your bag.");
    graph.observe({ computer: { snapshot: computer.snapshot() } });
    expect(graph.get(task.id)).toMatchObject({
      state: "done",
      result: "Done. The Aero 7 headphones 256 GB is in your bag.",
    });
    expect(graph.get(request.id)!.state).toBe("done");
    expect(graph.get(task.id)!.history.map((entry) => entry.state)).toEqual([
      "running",
      "waiting",
      "running",
      "done",
    ]);
  });

  it("reads a request whose result is not known as one that waits for the owner", () => {
    const graph = new TaskGraph(tempRoot(), clock().now);
    graph.observe({
      computer: {
        snapshot: null,
        journal: [
          journalEntry({ id: "req_x", state: "uncertain", reason: "restart" }),
        ],
      },
    });
    expect(graph.bySource("computer:req_x")).toMatchObject({
      state: "waiting",
      detail: expect.stringMatching(/not known/),
    });
  });

  it("is fed from jobs, routines, the reach and the desk, and settles what a source no longer lists", () => {
    const time = clock();
    const graph = new TaskGraph(tempRoot(), time.now);
    const computer = new FakeComputer().run("check my X mentions");
    graph.observe({
      computer: { snapshot: computer.snapshot() },
      jobs: [
        {
          id: "j-1",
          job: "fix the login test",
          startedAt: start,
          done: false,
          status: "awaiting_result",
          result: null,
        },
        {
          id: "j-2",
          job: "bump node",
          startedAt: start,
          done: true,
          status: "completed",
          result: "Bumped to 24.",
        },
        {
          id: "j-3",
          job: "run the build",
          startedAt: start,
          done: true,
          status: "exited_without_result",
          result: null,
        },
        {
          id: "j-4",
          job: "after that",
          startedAt: start,
          done: false,
          waiting: true,
          result: null,
        },
      ],
      routines: [routine({ lastRequestId: computer.requestId! })],
      reach: [
        {
          id: "a".repeat(24),
          requestId: computer.requestId!,
          kind: "approval",
          origin: "routine",
          seenAt: start,
          events: [{ at: start, what: "text_sent" }],
        } satisfies ReachRecord,
      ],
      desk: [deskRequest()],
    });
    const of = (source: string) => graph.bySource(source)!;
    expect(of("job:j-1").state).toBe("running");
    expect(of("job:j-2")).toMatchObject({
      state: "done",
      result: "Bumped to 24.",
    });
    expect(of("job:j-3").state).toBe("failed");
    expect(of("job:j-4").state).toBe("queued");
    const scheduled = of("routine:ab12cd34");
    expect(scheduled).toMatchObject({
      kind: "routine",
      state: "queued",
      detail: expect.stringMatching(/^every day at 09:00, next 11:00/),
    });
    expect(of(`computer:${computer.requestId}`).links.spawnedBy).toBe(
      scheduled.id,
    );
    expect(of(`reach:${"a".repeat(24)}`)).toMatchObject({
      kind: "reach",
      state: "done",
      links: { spawnedBy: of(`computer:${computer.requestId}`).id },
    });
    expect(of("desk:0123456789abcdef")).toMatchObject({
      kind: "question",
      state: "waiting",
      title: "claude-code asks to run: npm test",
    });

    time.step(60_000);
    graph.observe({ routines: [routine({ paused: true })], desk: [] });
    expect(of("routine:ab12cd34").state).toBe("waiting");
    expect(of("desk:0123456789abcdef").state).toBe("done");
    graph.observe({ routines: [] });
    expect(of("routine:ab12cd34")).toMatchObject({ state: "canceled" });
  });

  it("keeps the graph in one owner-only file, and reads it back after a restart", () => {
    const root = tempRoot();
    const time = clock();
    const graph = new TaskGraph(root, time.now);
    const request = graph.addRequest("follow up on my latest X posts");
    graph.observe({
      computer: {
        snapshot: new FakeComputer()
          .run("follow up on my latest X posts")
          .snapshot(),
      },
    });
    const task = graph.nodes().find((node) => node.kind === "computer")!;
    graph.link(task.id, "spawnedBy", request.id);
    expect(statSync(graph.file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(graph.file)).mode & 0o777).toBe(0o700);
    const again = new TaskGraph(root, time.now);
    expect(again.nodes()).toEqual(graph.nodes());
    // New ids go on from the old ones.
    expect(again.addRequest("next").id).not.toBe(request.id);
  });

  it("starts empty from a damaged file or one that others can read, and trusts nothing in it", () => {
    const root = tempRoot();
    const graph = new TaskGraph(root);
    graph.addRequest("hello");
    writeFileSync(graph.file, "{not json", { mode: 0o600 });
    expect(new TaskGraph(root).nodes()).toEqual([]);
    const other = tempRoot();
    const file = new TaskGraph(other).file;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, next: 2, nodes: [] }));
    chmodSync(file, 0o644);
    expect(new TaskGraph(other).nodes()).toEqual([]);
  });

  it("never keeps a credential in a title, a detail or a result", () => {
    const root = tempRoot();
    const graph = new TaskGraph(root);
    graph.addRequest("log in, my password is hunter22abc");
    graph.observe({
      jobs: [
        {
          id: "j-9",
          job: "use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx",
          startedAt: start,
          done: true,
          status: "completed",
          result: "token: ghp_abcdefghijklmnopqrstuvwxyz123",
        },
      ],
    });
    const text = readFileSync(graph.file, "utf8");
    expect(text).not.toMatch(
      /hunter22abc|sk-abcdefghijklmnop|ghp_abcdefghijklmnop/,
    );
    expect(text).toMatch(/withheld/);
  });

  it("shows the active work first, then the last few that ended, within its limit", () => {
    const time = clock();
    const graph = new TaskGraph(tempRoot(), time.now);
    const jobs = Array.from({ length: 30 }, (_, index) => ({
      id: `j-${index}`,
      job: `job number ${index} with a fairly long description of the code work to do`,
      startedAt: start + index,
      done: index % 2 === 0,
      status:
        index % 2 === 0 ? ("completed" as const) : ("awaiting_result" as const),
      result: index % 2 === 0 ? `answer ${index}` : null,
    }));
    graph.observe({ jobs });
    time.step(120_000);
    const view = graph.view();
    expect(view.length).toBeLessThanOrEqual(graphViewLimit);
    expect(view.startsWith("Active tasks:")).toBe(true);
    const active = view.indexOf("Active tasks:");
    const ended = view.indexOf("Ended lately:");
    const firstRunning = view.indexOf(" running ");
    expect(firstRunning).toBeGreaterThan(active);
    if (ended >= 0) expect(view.slice(ended)).not.toMatch(/ running /);
    expect(view).toMatch(/\(\d+ more lines; the tasks tool shows them\.\)/);
    expect(new TaskGraph(tempRoot()).view()).toBe("Tasks: none yet.");
  });

  it("gives one node in full: its words, links, history and result", () => {
    const time = clock();
    const graph = new TaskGraph(tempRoot(), time.now);
    const request = graph.addRequest("search flights to Lisbon");
    const computer = new FakeComputer().run(
      "search flights to Lisbon on Google Flights",
    );
    graph.observe({ computer: { snapshot: computer.snapshot() } });
    const task = graph.bySource(`computer:${computer.requestId}`)!;
    graph.link(task.id, "spawnedBy", request.id);
    const steer = graph.addRequest("only nonstop ones");
    graph.link(steer.id, "followsUp", task.id);
    graph.settle(steer.id, "done", "added to the running task");
    time.step(90_000);
    computer.finish("Done. The cheapest nonstop is 412 dollars.");
    graph.observe({ computer: { snapshot: computer.snapshot() } });
    const details = graph.details(task.id)!;
    expect(details).toMatch(new RegExp(`^${task.id} computer, done\\.`));
    expect(details).toMatch(
      /Title: "search flights to Lisbon on Google Flights"/,
    );
    expect(details).toMatch(
      /Result: Done\. The cheapest nonstop is 412 dollars\./,
    );
    expect(details).toMatch(new RegExp(`Spawned by: ${request.id} \\(request`));
    expect(details).toMatch(/History: 10:00 running; 10:01 done/);
    expect(graph.details(steer.id)).toMatch(
      new RegExp(`Follows up: ${task.id}`),
    );
    expect(graph.view()).toMatch(
      new RegExp(
        `- ${task.id} computer done 0s ago: "search flights to Lisbon on Google Flights" -> "Done\\. The cheapest nonstop is 412 dollars\\." \\[from ${request.id}\\]`,
      ),
    );
    expect(graph.details("c999")).toBeNull();
  });
});
