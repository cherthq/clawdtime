import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChatLog,
  Supervisor,
  chatMessageSchema,
  type ModelClient,
  type ModelMessage,
  type SupervisorWorld,
  type ToolCall,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import {
  deskTasks,
  taskStateWords,
  type DesktopTasks,
  type TaskFacts,
  type TaskPort,
  type TaskResult,
} from "../connectors/agents/tasks.js";
import type {
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";

const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-tasks-"));
const session: AgentSession = {
  id: "100-abc",
  pid: 100,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "deploy fix",
  project: "work",
  cwd: "/work/app",
  mode: "interactive",
  state: "working",
  detail: "turn_running",
  since: now - 90_000,
  source: "registry",
  startedAt: now - 3_600_000,
  spawnedBy: null,
  terminal: {
    tty: "ttys001",
    app: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    tmux: null,
    remote: false,
  },
  focus: "tab",
};
const board: BoardSnapshot = {
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: { needs_you: 0, working: 1, idle: 0, unknown: 0 },
  sessions: [session],
};

/** A model that follows a script: each step is the tool calls to make, or the final words. */
function scripted(steps: (ToolCall[] | string)[]) {
  const seen: { system: string; messages: ModelMessage[]; tools: string[] }[] =
    [];
  let step = 0;
  const model: ModelClient = {
    async complete(input) {
      seen.push({
        system: input.system,
        messages: structuredClone(input.messages),
        tools: input.tools.map((tool) => tool.name),
      });
      const next = steps[Math.min(step++, steps.length - 1)]!;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  /** What the tools answered in the model's second step. */
  const results = () =>
    seen[1]!.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
  return { model, seen, results };
}
const call = (
  name: string,
  args: unknown = {},
  id = `c-${name}`,
): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const blank: TaskFacts = {
  goal: "",
  state: "queued",
  summary: "Simulation only. No coding worker is running.",
  question: null,
  choices: [],
  canAnswer: false,
  canAccept: false,
  canCancel: true,
};
/** A task service in miniature: one task at a time, and an event id acts once. */
function fakeTasks(initial: Partial<TaskFacts> | null = null) {
  let task: TaskFacts | null = initial ? { ...blank, ...initial } : null;
  const calls: { kind: string; text?: string; eventId: string }[] = [];
  const receipts = new Map<string, TaskResult>();
  const once = (eventId: string, act: () => TaskResult) => {
    const prior = receipts.get(eventId);
    if (prior) return prior;
    const result = act();
    receipts.set(eventId, result);
    return result;
  };
  const port: TaskPort = {
    current: () => task,
    canStart: () =>
      task === null || ["accepted", "canceled", "failed"].includes(task.state),
    async start(goal, eventId) {
      calls.push({ kind: "start", text: goal, eventId });
      return once(eventId, () => {
        if (!port.canStart())
          return {
            ok: false,
            message:
              "Finish or reconcile the current task before starting another.",
          };
        task = { ...blank, goal };
        return {
          ok: true,
          message: "Simulation task recorded. No coding worker was started.",
        };
      });
    },
    async answer(text, eventId) {
      calls.push({ kind: "answer", text, eventId });
      return once(eventId, () => {
        task = {
          ...task!,
          question: null,
          choices: [],
          canAnswer: false,
          state: "queued",
        };
        return { ok: true, message: "Simulation task recorded." };
      });
    },
    async accept(eventId) {
      calls.push({ kind: "accept", eventId });
      return once(eventId, () => {
        task = { ...task!, state: "accepted", canAccept: false };
        return { ok: true, message: "Result accepted. Nothing was deployed." };
      });
    },
    async cancel(eventId) {
      calls.push({ kind: "cancel", eventId });
      return once(eventId, () => {
        task = { ...task!, state: "canceled", canCancel: false };
        return { ok: true, message: "Cancellation requested." };
      });
    },
  };
  return { port, calls, task: () => task };
}
function world(tasks?: TaskPort, directory = root()) {
  const desk = new DecisionDesk(directory, () => now);
  const value: SupervisorWorld = {
    now: () => now,
    board: () => board,
    desk,
    focus: async () => ({ ok: true }),
    send: async () => ({ ok: true, route: "tmux" }),
    clis: () => [],
    ...(tasks ? { tasks } : {}),
  };
  return { value, desk };
}
const asking: Partial<TaskFacts> = {
  goal: "migrate the users table",
  state: "needs_decision",
  question: "Which database first?",
  choices: ["Staging", "Production"],
  canAnswer: true,
};

describe("a task by talking, with a language model", () => {
  it("starts a task only when the person's last words ask for one, with the person's words", async () => {
    const tasks = fakeTasks();
    const { value } = world(tasks.port);
    // The person asks about a test. The model tries to start a task: refused.
    let run = scripted([
      [call("start_task", { goal: "fix the login test" })],
      "Do you want me to start a task?",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "what is the login test doing?",
      "chat",
    );
    expect(run.results()).toEqual([
      "The person did not ask for a task in their last message. Ask them.",
    ]);
    expect(tasks.calls).toEqual([]);
    expect(run.seen[0]!.tools).toEqual(
      expect.arrayContaining([
        "task_status",
        "start_task",
        "answer_task",
        "accept_task",
        "cancel_task",
      ]),
    );
    expect(run.seen[0]!.system).toContain(
      "Start a task only when their last message asks for one",
    );
    // No tool of this agent stops a call or sharing.
    expect(run.seen[0]!.tools.join(" ")).not.toMatch(/stop|shar/i);
    // The person asks for a task: it starts, with their words as the goal.
    run = scripted([
      [call("start_task", { goal: "fix the login test" })],
      "Started. The task waits to run.",
    ]);
    expect(
      await new Supervisor(value, run.model).reply(
        [],
        "Start a task: fix the login test",
        "voice",
      ),
    ).toBe("Started. The task waits to run.");
    expect(run.results()).toEqual([
      "Simulation task recorded. No coding worker was started.",
    ]);
    expect(tasks.calls).toHaveLength(1);
    expect(tasks.calls[0]).toMatchObject({
      kind: "start",
      text: "fix the login test",
    });
    expect(tasks.calls[0]!.eventId).toMatch(/^talk_[0-9a-f]{16}_start$/);
    expect(tasks.task()!.goal).toBe("fix the login test");
  });

  it("replaces a goal that the model reworded with the person's own sentence", async () => {
    const tasks = fakeTasks();
    const { value } = world(tasks.port);
    const run = scripted([
      [call("start_task", { goal: "Repair the authentication suite" })],
      "Started.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "I have a job for you: fix the login test and keep the old API.",
      "chat",
    );
    expect(tasks.calls[0]!.text).toBe(
      "fix the login test and keep the old API",
    );
    // Other ways to ask, each with the goal in the person's words.
    for (const [spoken, goal] of [
      [
        "Can you start a task to rename the config file?",
        "rename the config file",
      ],
      ["New task: write the release notes", "write the release notes"],
      ["task - add a health check", "add a health check"],
    ]) {
      const other = fakeTasks();
      await new Supervisor(
        world(other.port).value,
        scripted([
          [call("start_task", { goal: "something else entirely" })],
          "ok",
        ]).model,
      ).reply([], spoken!, "chat");
      expect(other.calls[0]!.text).toBe(goal);
    }
    // A request with no goal starts nothing.
    const empty = fakeTasks();
    const none = scripted([[call("start_task", { goal: "" })], "What is it?"]);
    await new Supervisor(world(empty.port).value, none.model).reply(
      [],
      "start a task",
      "chat",
    );
    expect(none.results()).toEqual([
      "The person gave no goal. Ask them what the task is.",
    ]);
    expect(empty.calls).toEqual([]);
  });

  it("changes nothing on a question about the task", async () => {
    const tasks = fakeTasks({ ...asking, canAccept: true });
    const { value } = world(tasks.port);
    const run = scripted([
      [
        call("answer_task", { text: "Staging" }),
        call("accept_task", {}, "c-2"),
        call("cancel_task", {}, "c-3"),
        call("start_task", { goal: "the task ask" }, "c-4"),
      ],
      "It asks which database first.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "What does the task ask, staging or production?",
      "chat",
    );
    expect(run.results()).toEqual([
      "The person asked a question. That is not an answer. Tell them what the task asks.",
      "The person did not clearly say to accept. Ask them.",
      "The person did not clearly say to cancel. Ask them.",
      "The person did not ask for a task in their last message. Ask them.",
    ]);
    expect(tasks.calls).toEqual([]);
    expect(tasks.task()).toMatchObject({ state: "needs_decision" });
  });

  it("passes an answer, an accept and a cancel only in the person's own words", async () => {
    // The person names a choice. The model names the other one: the person's wins.
    let tasks = fakeTasks(asking);
    let run = scripted([
      [call("answer_task", { text: "Production" })],
      "Passed on.",
    ]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "use staging first",
      "call",
    );
    expect(tasks.calls).toEqual([
      {
        kind: "answer",
        text: "Staging",
        eventId: expect.stringMatching(/^talk_[0-9a-f]{16}_answer$/),
      },
    ]);
    // No choices: a reworded answer is replaced by the person's sentence.
    tasks = fakeTasks({ ...asking, choices: [] });
    run = scripted([
      [call("answer_task", { text: "use the legacy interface" })],
      "ok",
    ]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "Keep the old API, but keep the new tests too.",
      "chat",
    );
    expect(tasks.calls[0]!.text).toBe(
      "Keep the old API, but keep the new tests too.",
    );
    // With no question waiting there is nothing to answer.
    tasks = fakeTasks({ goal: "x y" });
    run = scripted([[call("answer_task", { text: "yes" })], "ok"]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "yes do that",
      "chat",
    );
    expect(run.results()).toEqual(["The task asks nothing now."]);
    // Accept needs the person's word for it.
    tasks = fakeTasks({ goal: "x y", state: "review_ready", canAccept: true });
    run = scripted([[call("accept_task")], "ok"]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "hmm, show me the diff again",
      "chat",
    );
    expect(tasks.calls).toEqual([]);
    run = scripted([[call("accept_task")], "Accepted."]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "Yes, accept the result.",
      "chat",
    );
    expect(tasks.calls.map((item) => item.kind)).toEqual(["accept"]);
    expect(tasks.task()!.state).toBe("accepted");
    // "Looks good" accepts the task only when no agent waits for a yes of its own.
    tasks = fakeTasks({ goal: "x y", state: "review_ready", canAccept: true });
    const busy = world(tasks.port);
    busy.desk.attend();
    busy.desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "git push",
        options: [],
      },
      holdSeconds: 45,
    });
    run = scripted([[call("accept_task")], "ok"]);
    await new Supervisor(busy.value, run.model).reply([], "looks good", "chat");
    expect(tasks.calls).toEqual([]);
    run = scripted([[call("accept_task")], "ok"]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "looks good",
      "chat",
    );
    expect(tasks.calls.map((item) => item.kind)).toEqual(["accept"]);
    // Cancel needs the person's word, and "stop sharing" is not it.
    tasks = fakeTasks({ goal: "x y" });
    run = scripted([[call("cancel_task")], "ok"]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "stop sharing my screen",
      "chat",
    );
    expect(tasks.calls).toEqual([]);
    run = scripted([[call("cancel_task")], "Canceled."]);
    await new Supervisor(world(tasks.port).value, run.model).reply(
      [],
      "Cancel the task.",
      "chat",
    );
    expect(tasks.calls.map((item) => item.kind)).toEqual(["cancel"]);
  });

  it("never starts two tasks from one turn, and the next turn cannot start a second one", async () => {
    const tasks = fakeTasks();
    const { value } = world(tasks.port);
    const run = scripted([
      [
        call("start_task", { goal: "fix the login test" }),
        call("start_task", { goal: "add a health check" }, "c-2"),
      ],
      [call("start_task", { goal: "fix the login test" }, "c-3")],
      "Started one task.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "Start a task: fix the login test. Start a task: add a health check.",
      "chat",
    );
    // One turn reaches the task service once.
    expect(tasks.calls).toHaveLength(1);
    expect(run.results()).toEqual([
      "Simulation task recorded. No coding worker was started.",
      "Simulation task recorded. No coding worker was started.",
    ]);
    expect(tasks.task()!.goal).toBe("fix the login test");
    // Another turn is another event. The service refuses it while a task is active.
    const next = scripted([
      [call("start_task", { goal: "add a health check" })],
      "One task is already active.",
    ]);
    await new Supervisor(value, next.model).reply(
      [],
      "start a task: add a health check",
      "chat",
    );
    expect(next.results()).toEqual([
      "Finish or reconcile the current task before starting another.",
    ]);
    expect(tasks.calls).toHaveLength(2);
    expect(tasks.calls[1]!.eventId).not.toBe(tasks.calls[0]!.eventId);
    expect(tasks.task()!.goal).toBe("fix the login test");
  });

  it("says in the status what the task does and whether it waits for the person", async () => {
    expect(new Supervisor(world().value, null).status()).not.toContain("ask");
    expect(new Supervisor(world().value, null).status()).not.toMatch(/task/i);
    expect(
      new Supervisor(world(fakeTasks().port).value, null).status(),
    ).toContain("No task is active.");
    expect(
      new Supervisor(
        world(fakeTasks({ goal: "fix the login test" }).port).value,
        null,
      ).status(),
    ).toContain('Task: "fix the login test" is waiting to run.');
    expect(
      new Supervisor(world(fakeTasks(asking).port).value, null).status(),
    ).toContain(
      'Task: "migrate the users table" is waiting for your answer. It waits for the person and asks: Which database first? Choices: Staging, Production.',
    );
    expect(
      new Supervisor(
        world(
          fakeTasks({ goal: "x y", state: "review_ready", canAccept: true })
            .port,
        ).value,
        null,
      ).status(),
    ).toContain(
      'Task: "x y" is ready for your review. Its result waits for the person\'s review: they can accept it.',
    );
    expect(taskStateWords("verifying")).toBe("being checked");
    expect(taskStateWords("some_new_state")).toBe("some new state");
    // The task tool gives the same line, with the service's summary.
    const run = scripted([[call("task_status")], "It waits to run."]);
    await new Supervisor(
      world(fakeTasks({ goal: "fix the login test" }).port).value,
      run.model,
    ).reply([], "how is the task?", "chat");
    expect(run.results()).toEqual([
      'Task: "fix the login test" is waiting to run. Simulation only. No coding worker is running.',
    ]);
  });

  it("offers the task's choices with the answer, and the chat keeps them", async () => {
    const tasks = fakeTasks(asking);
    const { value } = world(tasks.port);
    const run = scripted([
      [call("task_status")],
      "The task asks which database first: staging or production.",
    ]);
    expect(
      await new Supervisor(value, run.model).answer(
        [],
        "what does the task need?",
        "chat",
      ),
    ).toEqual({
      text: "The task asks which database first: staging or production.",
      choices: ["Staging", "Production"],
    });
    // A turn that did not look at the task offers nothing.
    expect(
      await new Supervisor(value, scripted(["Hello."]).model).answer(
        [],
        "hello",
        "chat",
      ),
    ).toEqual({ text: "Hello.", choices: [] });
    // More than four choices, or a long one, are said but are not buttons.
    for (const choices of [
      ["a", "b", "c", "d", "e"],
      ["x".repeat(81), "short"],
    ]) {
      const many = fakeTasks({ ...asking, choices });
      expect(
        (
          await new Supervisor(
            world(many.port).value,
            scripted([[call("status")], "It asks."]).model,
          ).answer([], "status?", "chat")
        ).choices,
      ).toEqual([]);
    }
    // The feed stores the choices on ClawdTime's message, and the log keeps them.
    const directory = root();
    const feed = new BoardFeed({
      root: directory,
      now: () => now,
      model: scripted([[call("task_status")], "Staging or production?"]).model,
      speech: null,
      tasks: tasks.port,
    });
    const reply = await feed.say("what does the task ask");
    expect(reply).toEqual({
      role: "assistant",
      text: "Staging or production?",
      at: now,
      via: "chat",
      choices: ["Staging", "Production"],
    });
    expect(feed.chat().messages.at(-1)).toEqual(reply);
    expect(feed.chat().messages.at(-2)).not.toHaveProperty("choices");
    expect(new ChatLog(directory).recent(1)[0]!.choices).toEqual([
      "Staging",
      "Production",
    ]);
    // A click on a choice is the person's next message: it goes to the task.
    const picked = new BoardFeed({
      root: directory,
      now: () => now,
      model: scripted([
        [call("answer_task", { text: "Staging" })],
        "Passed on.",
      ]).model,
      speech: null,
      tasks: tasks.port,
    });
    expect(await picked.say("Staging")).toEqual({
      role: "assistant",
      text: "Passed on.",
      at: now,
      via: "chat",
    });
    expect(tasks.calls).toEqual([
      { kind: "answer", text: "Staging", eventId: expect.any(String) },
    ]);
    expect(
      chatMessageSchema.safeParse({
        role: "assistant",
        text: "x",
        at: 1,
        via: "chat",
        choices: ["a", "b", "c", "d", "e"],
      }).success,
    ).toBe(false);
  });

  it("says that tasks need the desktop service where there is none", async () => {
    const run = scripted([
      [
        call("start_task", { goal: "fix the login test" }),
        call("task_status", {}, "c-2"),
        call("answer_task", { text: "yes" }, "c-3"),
        call("accept_task", {}, "c-4"),
        call("cancel_task", {}, "c-5"),
      ],
      "I cannot take a task here.",
    ]);
    const sentence =
      "Tasks need ClawdTime's desktop service. It is not running here.";
    expect(
      await new Supervisor(world().value, run.model).answer(
        [],
        "start a task: fix the login test",
        "chat",
      ),
    ).toEqual({ text: "I cannot take a task here.", choices: [] });
    expect(run.results()).toEqual([
      sentence,
      sentence,
      sentence,
      sentence,
      sentence,
    ]);
  });
});

describe("a task by talking, with no language model", () => {
  const plain = (tasks?: TaskPort, directory?: string) => {
    const made = world(tasks, directory);
    return { ...made, agent: new Supervisor(made.value, null) };
  };

  it("starts a task on a plain ask and refuses an ask with no goal", async () => {
    const tasks = fakeTasks();
    const { agent } = plain(tasks.port);
    expect(await agent.reply([], "task: fix the flaky test", "chat")).toBe(
      "Simulation task recorded. No coding worker was started.",
    );
    expect(tasks.calls).toEqual([
      {
        kind: "start",
        text: "fix the flaky test",
        eventId: expect.stringMatching(/^talk_[0-9a-f]{16}_start$/),
      },
    ]);
    expect(await agent.reply([], "start a task", "chat")).toBe(
      "The person gave no goal. Ask them what the task is.",
    );
    expect(await agent.reply([], "Start a task: write the notes", "chat")).toBe(
      "Finish or reconcile the current task before starting another.",
    );
    expect(tasks.task()!.goal).toBe("fix the flaky test");
    // The state sentence names the task. A question starts nothing.
    expect(await agent.reply([], "what is the task doing?", "chat")).toBe(
      '1 working. Your task "fix the flaky test" is waiting to run.',
    );
    expect(tasks.calls).toHaveLength(2);
    // With no task service, the old sentence is unchanged and an ask is refused in words.
    const bare = plain();
    expect(await bare.agent.reply([], "status", "chat")).toBe("1 working.");
    expect(await bare.agent.reply([], "task: fix the flaky test", "chat")).toBe(
      "1 working.",
    );
  });

  it("passes a clear answer to the task's question, and only then", async () => {
    const tasks = fakeTasks(asking);
    const { agent } = plain(tasks.port);
    const state = await agent.answer([], "hmm", "chat");
    expect(state).toEqual({
      text: '1 working. Your task "migrate the users table" is waiting for your answer. It asks: Which database first? Choices: Staging, Production. Say your answer and I pass it to the task.',
      choices: ["Staging", "Production"],
    });
    // Neither a question nor both choices at once is an answer.
    await agent.reply([], "staging or production?", "chat");
    await agent.reply([], "staging and production", "chat");
    expect(tasks.calls).toEqual([]);
    // "The second one" names two of them to the reader of spoken answers, so it is not clear.
    await agent.reply([], "the second one", "voice");
    expect(tasks.calls).toEqual([]);
    expect(await agent.reply([], "the second, please", "voice")).toBe(
      "Simulation task recorded.",
    );
    expect(tasks.calls).toEqual([
      { kind: "answer", text: "Production", eventId: expect.any(String) },
    ]);
    // A question with no choices takes a sentence or a clear yes or no, not a stray word.
    const open = fakeTasks({ ...asking, choices: [] });
    const free = plain(open.port);
    await free.agent.reply([], "status", "chat");
    expect(open.calls).toEqual([]);
    await free.agent.reply([], "use the old API please", "chat");
    expect(open.calls.map((item) => item.text)).toEqual([
      "use the old API please",
    ]);
    const yes = fakeTasks({ ...asking, choices: [] });
    await plain(yes.port).agent.reply([], "yes", "chat");
    expect(yes.calls.map((item) => item.text)).toEqual(["yes"]);
  });

  it("gives an agent's request the first word, then the task", async () => {
    const tasks = fakeTasks({ ...asking, choices: [] });
    const { agent, desk } = plain(tasks.port);
    desk.attend();
    const request = desk.open({
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
    // "Approve" is for the agent that waits. The task's question is not touched.
    expect(await agent.reply([], "approve", "chat")).toBe(
      "Allowed. The agent continues.",
    );
    expect(desk.take(request.id)).toMatchObject({ decision: "allow" });
    expect(tasks.calls).toEqual([]);
    // While a request of an agent waits, a sentence is not sent to the task.
    desk.open({
      agent: "claude-code",
      sessionId: "s2",
      cwd: "/work/app",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "git push",
        options: [],
      },
      holdSeconds: 45,
    });
    expect(await agent.reply([], "use the old API please", "chat")).toContain(
      "One request waits for your answer: git push.",
    );
    expect(tasks.calls).toEqual([]);
    // A sentence that names the task is about the task: "cancel the task"
    // cancels the task and never denies the agent that waits.
    expect(await agent.reply([], "cancel the task", "chat")).toBe(
      "Cancellation requested.",
    );
    expect(tasks.calls.map((item) => item.kind)).toEqual(["cancel"]);
    expect(desk.pending().map((item) => item.summary)).toEqual(["git push"]);
    // With a model too: its wrong use of the request tool is refused.
    const live = fakeTasks({ goal: "fix the login test" });
    const both = world(live.port);
    both.desk.attend();
    const waiting = both.desk.open({
      agent: "claude-code",
      sessionId: "s3",
      cwd: "/work/app",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "rm -rf build",
        options: [],
      },
      holdSeconds: 45,
    });
    const run = scripted([
      [call("decide", { request: 1, decision: "deny" })],
      "Do you mean the task?",
    ]);
    await new Supervisor(both.value, run.model).reply(
      [],
      "cancel the task",
      "chat",
    );
    expect(run.results()).toEqual([
      "The person spoke about the task, not about this request. Use the task tools, or ask them.",
    ]);
    expect(both.desk.take(waiting.id)).toBeNull();
    // An ask for a new task wins over the words inside its goal.
    const fresh = fakeTasks();
    const third = plain(fresh.port);
    third.desk.attend();
    third.desk.open({
      agent: "claude-code",
      sessionId: "s4",
      cwd: "/work/app",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "npm publish",
        options: [],
      },
      holdSeconds: 45,
    });
    expect(
      await third.agent.reply(
        [],
        "start a task: approve and merge the deploy script",
        "chat",
      ),
    ).toBe("Simulation task recorded. No coding worker was started.");
    expect(fresh.calls[0]!.text).toBe("approve and merge the deploy script");
    expect(third.desk.pending()).toHaveLength(1);
  });

  it("accepts and cancels on the plain words for it", async () => {
    const review = fakeTasks({
      goal: "fix the login test",
      state: "review_ready",
      canAccept: true,
    });
    const first = plain(review.port);
    expect(await first.agent.reply([], "is it done?", "chat")).toBe(
      '1 working. Your task "fix the login test" is ready for your review. Say accept to take its result.',
    );
    expect(await first.agent.reply([], "accept", "chat")).toBe(
      "Result accepted. Nothing was deployed.",
    );
    expect(review.calls.map((item) => item.kind)).toEqual(["accept"]);
    // An accepted task is over: the state sentence no longer names it.
    expect(await first.agent.reply([], "status", "chat")).toBe("1 working.");
    const running = fakeTasks({ goal: "fix the login test" });
    const second = plain(running.port);
    await second.agent.reply([], "cancel", "chat");
    await second.agent.reply([], "should I cancel the task?", "chat");
    expect(running.calls).toEqual([]);
    expect(await second.agent.reply([], "cancel the task", "chat")).toBe(
      "Cancellation requested.",
    );
    expect(running.calls.map((item) => item.kind)).toEqual(["cancel"]);
  });
});

describe("the door to the desktop task service", () => {
  const shown = {
    id: "task_1",
    runId: "run_1",
    revision: 4,
    goal: "fix the login test",
    state: "needs_decision",
    summary: "The test fails on a missing fixture.",
    decision: { question: "Create the fixture?", options: ["Yes", "No"] },
    canDecide: true,
    canAccept: false,
    canCancel: true,
  };
  function desktop(task: typeof shown | null, canSubmit = true) {
    const sent: { credential: string; input: unknown }[] = [];
    let answer: () => { state: string; message: string } = () => ({
      state: "done",
      message: "Simulation task recorded. No coding worker was started.",
    });
    const service: DesktopTasks = {
      snapshot(credential) {
        if (credential !== "capability") throw new Error("refused");
        return { canSubmit, task };
      },
      async submit(credential, input) {
        sent.push({ credential, input });
        return answer();
      },
    };
    return {
      service,
      sent,
      answers: (next: typeof answer) => {
        answer = next;
      },
    };
  }

  it("shows the task as plain facts and sends each change with the task's own identity", async () => {
    const made = desktop(shown);
    const port = deskTasks(made.service, "capability");
    expect(port.current()).toEqual({
      goal: "fix the login test",
      state: "needs_decision",
      summary: "The test fails on a missing fixture.",
      question: "Create the fixture?",
      choices: ["Yes", "No"],
      canAnswer: true,
      canAccept: false,
      canCancel: true,
    });
    expect(port.canStart()).toBe(true);
    expect(await port.start("add a health check", "talk_1_start")).toEqual({
      ok: true,
      message: "Simulation task recorded. No coding worker was started.",
    });
    await port.answer("Yes", "talk_2_answer");
    await port.accept("talk_3_accept");
    await port.cancel("talk_4_cancel");
    const bound = { taskId: "task_1", runId: "run_1", expectedRevision: 4 };
    expect(made.sent).toEqual([
      {
        credential: "capability",
        input: {
          eventId: "talk_1_start",
          action: "submit",
          goal: "add a health check",
        },
      },
      {
        credential: "capability",
        input: {
          eventId: "talk_2_answer",
          action: "decide",
          ...bound,
          instruction: "Yes",
        },
      },
      {
        credential: "capability",
        input: { eventId: "talk_3_accept", action: "accept", ...bound },
      },
      {
        credential: "capability",
        input: { eventId: "talk_4_cancel", action: "cancel", ...bound },
      },
    ]);
  });

  it("turns a refusal into words and never throws", async () => {
    const made = desktop(shown, false);
    const port = deskTasks(made.service, "capability");
    expect(port.canStart()).toBe(false);
    made.answers(() => ({
      state: "refused",
      message: "Finish or reconcile the current task before starting another.",
    }));
    expect(await port.start("x y", "e1")).toEqual({
      ok: false,
      message: "Finish or reconcile the current task before starting another.",
    });
    // The service's own refusal keeps its sentence. Anything else stays unnamed.
    made.answers(() => {
      throw Object.assign(new Error("Desktop operation identity conflicts."), {
        status: 409,
      });
    });
    expect(await port.start("x y", "e2")).toEqual({
      ok: false,
      message: "Desktop operation identity conflicts.",
    });
    made.answers(() => {
      throw new Error("secret detail /private/path");
    });
    expect(await port.cancel("e3")).toEqual({
      ok: false,
      message: "The task service did not take that.",
    });
    // With no task there is nothing to answer, accept or cancel: nothing is sent.
    const empty = desktop(null);
    const none = deskTasks(empty.service, "capability");
    expect(none.current()).toBeNull();
    expect(await none.answer("Yes", "e4")).toEqual({
      ok: false,
      message: "No task is active.",
    });
    expect(empty.sent).toEqual([]);
    // A wrong capability shows nothing and starts nothing new.
    const wrong = deskTasks(made.service, "other");
    expect(wrong.current()).toBeNull();
    expect(wrong.canStart()).toBe(false);
  });
});
