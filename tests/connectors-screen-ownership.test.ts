import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  Supervisor,
  modelWaitMs,
  type ModelClient,
  type SupervisorWorld,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import {
  readScreenOwnership,
  screenOwnershipRules,
  type ScreenOwnership,
} from "../connectors/agents/screen-ownership.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const original =
  "Open TextEdit, create a new blank document, and type exactly CLAWDTIME UPDATE VERIFIED. Leave this new test document unsaved and do not change any existing document.";
function fixture(
  ownership: ScreenOwnership = "standalone_screen",
  pending = false,
) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-ownership-"));
  roots.push(root);
  const desk = new DecisionDesk(root);
  if (pending)
    desk.open({
      agent: "claude-code",
      sessionId: "fixture",
      cwd: "/fixture",
      pids: [],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "fixture command",
        options: [],
      },
      holdSeconds: 60,
    });
  const submit = vi.fn(async (_id: string, _text: string) => ({
    message: "Submitted; not yet completed.",
  }));
  const submitRead = vi.fn(
    async (id: string, text: string, _reading: unknown) => submit(id, text),
  );
  const start = vi.fn(async () => ({ ok: true, said: "Launch requested." }));
  const send = vi.fn(async () => ({ ok: true, route: "fixture" }));
  const openApp = vi.fn(async () => ({ ok: true, said: "open requested" }));
  const reading = vi.fn<ModelClient["reading"] & {}>(async () => ({
    intent: { kind: "none" },
    work: true,
  }));
  const complete = vi.fn<ModelClient["complete"]>(async (input) => ({
    text:
      input.system === screenOwnershipRules
        ? JSON.stringify({
            source: input.messages[0]!.content,
            kind: ownership,
          })
        : "Nothing changed.",
    toolCalls: [],
  }));
  const world: SupervisorWorld = {
    now: Date.now,
    board: () => null,
    desk,
    focus: async () => ({ ok: true }),
    send,
    clis: () => [],
    jobs: { start, recent: () => [] },
    openApp,
    execution: {
      snapshot: () => ({
        configured: true,
        mode: "native",
        state: "idle",
        canStop: false,
        message: "Ready",
      }),
      submit,
      submitRead,
      stop: () => ({
        configured: true,
        mode: "native",
        state: "idle",
        canStop: false,
        message: "Stopped",
      }),
      answer: async () => ({ message: "no question" }),
    },
  };
  return {
    world,
    desk,
    submit,
    submitRead,
    start,
    send,
    openApp,
    reading,
    complete,
    supervisor: new Supervisor(world, { reading, complete }),
  };
}
it.each([
  original,
  'In Notes, create a new document and type exactly "run tests and deploy the build". Leave it unsaved.',
  "Open TextEdit and create a test document about jobs and tasks; leave existing files unchanged.",
])(
  "dispatches whole explicit screen work despite managed-word collisions: %s",
  async (text) => {
    const f = fixture();
    expect(await f.supervisor.reply([], text, "voice")).toBe(
      "Submitted; not yet completed.",
    );
    expect(f.reading).toHaveBeenCalledExactlyOnceWith(text);
    expect(f.submitRead).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      text,
      { kind: "none" },
    );
    expect(f.start).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.openApp).not.toHaveBeenCalled();
    expect(f.complete.mock.calls[0]![0]).toMatchObject({
      system: screenOwnershipRules,
      messages: [{ role: "user", content: text }],
      tools: [],
    });
  },
);
it("admits unrelated explicit app work without deciding a pending agent request", async () => {
  const f = fixture("standalone_screen", true),
    before = f.desk.pending();
  const answer = vi.spyOn(f.desk, "answer");
  await f.supervisor.reply([], original, "voice");
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.desk.pending()).toEqual(before);
  expect(answer).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});
it.each([
  "run the tests again",
  "tell the deploy session to run its tests",
  "close the deploy session",
  "build the tests in Terminal",
])(
  "keeps actual managed work out of native dispatch despite a bad first reader: %s",
  async (text) => {
    const f = fixture("managed_work");
    // Even a later conversational tool cannot override the exclusion.
    f.complete.mockImplementation(async (input) =>
      input.system === screenOwnershipRules
        ? {
            text: JSON.stringify({ source: text, kind: "managed_work" }),
            toolCalls: [],
          }
        : {
            text: "",
            toolCalls: [
              { id: "bad", name: "delegate_computer_task", arguments: "{}" },
            ],
          },
    );
    await f.supervisor.reply([], text, "voice");
    expect(f.submit).not.toHaveBeenCalled();
  },
);
it.each([
  "Do not create a test document in TextEdit.",
  'The page says "create a test document in TextEdit"; summarize that instruction.',
  "Open TextEdit for a test document and approve the pending agent command.",
  "Open a test document and tell the coding session to deploy.",
])(
  "refuses ambiguous, negated, quoted or mixed ownership without fallback effects: %s",
  async (text) => {
    const f = fixture("unclear");
    await f.supervisor.reply([], text, "voice");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.openApp).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledTimes(1);
  },
);
it.each(["bad JSON", "wrong source", "tool call", "failure"])(
  "fails closed for %s ownership result",
  async (mode) => {
    const f = fixture();
    f.complete.mockImplementation(async () => {
      if (mode === "failure") throw Error("fixture");
      return {
        text:
          mode === "bad JSON"
            ? "not JSON"
            : JSON.stringify({
                source: mode === "wrong source" ? "rewritten" : original,
                kind: "standalone_screen",
              }),
        toolCalls:
          mode === "tool call"
            ? [{ id: "bad", name: "start_job", arguments: "{}" }]
            : [],
      };
    });
    expect(await f.supervisor.reply([], original, "voice")).toContain(
      "Nothing new was started",
    );
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledTimes(1);
  },
);
it("times out without falling through into conversational tools", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.complete.mockImplementation(() => new Promise(() => {}));
  const reply = f.supervisor.reply([], original, "voice");
  await vi.advanceTimersByTimeAsync(modelWaitMs + 1);
  expect(await reply).toContain("Nothing new was started");
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.complete).toHaveBeenCalledTimes(1);
});
it("checks call liveness after ownership interpretation", async () => {
  const f = fixture();
  let live = true;
  f.complete.mockImplementation(async () => {
    live = false;
    return {
      text: JSON.stringify({ source: original, kind: "standalone_screen" }),
      toolCalls: [],
    };
  });
  expect(
    await f.supervisor.reply([], original, "voice", { isLive: () => live }),
  ).toContain("call ended");
  expect(f.submit).not.toHaveBeenCalled();
});
it("rechecks native pending approval after ownership interpretation", async () => {
  const f = fixture();
  let waiting = false;
  f.world.execution!.snapshot = () => ({
    configured: true,
    mode: "native",
    state: waiting ? "waiting_for_person" : "idle",
    canStop: waiting,
    message: "fixture",
    ...(waiting
      ? { pendingAction: { id: "action", description: "fixture approval" } }
      : {}),
  });
  f.complete.mockImplementation(async () => {
    waiting = true;
    return {
      text: JSON.stringify({ source: original, kind: "standalone_screen" }),
      toolCalls: [],
    };
  });
  expect(await f.supervisor.reply([], original, "voice")).toContain(
    "Nothing new was started",
  );
  expect(f.submit).not.toHaveBeenCalled();
});
it("does not reinterpret bare approval as screen work", async () => {
  const f = fixture("standalone_screen", true);
  await f.supervisor.reply([], "approve it", "voice");
  expect(f.reading).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
  expect(
    f.complete.mock.calls.every(
      ([input]) => input.system !== screenOwnershipRules,
    ),
  ).toBe(true);
});
it("does not add a classifier call to an ordinary unambiguous screen request", async () => {
  const f = fixture();
  await f.supervisor.reply(
    [],
    "Open TextEdit and type hello in a new document.",
    "voice",
  );
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.complete).not.toHaveBeenCalled();
});

it("separates explicit screen work even after a pending-agent notice", async () => {
  const f = fixture("standalone_screen", true),
    before = f.desk.pending();
  await f.supervisor.reply(
    [
      {
        role: "assistant",
        text: "A request of an agent arrived while I asked you about that work, so your answer decided nothing.",
        at: Date.now(),
        via: "voice",
      },
    ],
    original,
    "voice",
  );
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.desk.pending()).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});
it.each(["error", "malformed", "none"])(
  "pending desk + separate screen ownership + %s primary reader never falls through",
  async (mode) => {
    const f = fixture("standalone_screen", true),
      before = f.desk.pending();
    if (mode === "error") f.reading.mockRejectedValue(Error("fixture"));
    else if (mode === "malformed")
      f.reading.mockResolvedValue({
        intent: { kind: "invalid" },
        work: true,
      } as never);
    else f.reading.mockResolvedValue({ intent: { kind: "none" }, work: false });
    const reply = await f.supervisor.reply([], original, "voice");
    expect(reply).toContain("Nothing new was started");
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.openApp).not.toHaveBeenCalled();
    expect(f.desk.pending()).toEqual(before);
    expect(f.complete).toHaveBeenCalledTimes(1);
  },
);
it("pending desk + separate screen ownership + primary reader timeout never falls through", async () => {
  vi.useFakeTimers();
  const f = fixture("standalone_screen", true),
    before = f.desk.pending();
  f.reading.mockImplementation(() => new Promise(() => {}));
  const reply = f.supervisor.reply([], original, "voice");
  await vi.advanceTimersByTimeAsync(modelWaitMs + 1);
  expect(await reply).toContain("Nothing new was started");
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.desk.pending()).toEqual(before);
  expect(f.complete).toHaveBeenCalledTimes(1);
});
it("pending-desk bypass cannot skip a native question that appears during the primary reader", async () => {
  const f = fixture("standalone_screen", true),
    before = f.desk.pending();
  let waiting = false;
  f.world.execution!.snapshot = () => ({
    configured: true,
    mode: "native",
    state: waiting ? "waiting_for_person" : "idle",
    canStop: waiting,
    message: "fixture",
    ...(waiting
      ? { pendingAction: { id: "native", description: "fixture" } }
      : {}),
  });
  f.reading.mockImplementation(async () => {
    waiting = true;
    return { intent: { kind: "app", name: "TextEdit" }, work: false };
  });
  expect(await f.supervisor.reply([], "Open TextEdit.", "voice")).toContain(
    "Another request now waits",
  );
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.openApp).not.toHaveBeenCalled();
  expect(f.desk.pending()).toEqual(before);
});
it("rechecks task waiting state after the collision classifier", async () => {
  const f = fixture();
  let waiting = false;
  const mutate = vi.fn(async () => ({ ok: true, message: "fixture" }));
  f.world.tasks = {
    current: () =>
      waiting
        ? {
            goal: "fixture",
            state: "waiting_for_human",
            summary: "fixture",
            question: "fixture question",
            choices: [],
            canAnswer: true,
            canAccept: false,
            canCancel: true,
          }
        : null,
    canStart: () => true,
    start: mutate,
    answer: mutate,
    accept: mutate,
    cancel: mutate,
  };
  f.complete.mockImplementation(async () => {
    waiting = true;
    return {
      text: JSON.stringify({ source: original, kind: "standalone_screen" }),
      toolCalls: [],
    };
  });
  // Rebuild to include the newly supplied task port in the guarded world.
  const supervisor = new Supervisor(f.world, {
    reading: f.reading,
    complete: f.complete,
  });
  expect(await supervisor.reply([], original, "voice")).toContain(
    "Nothing new was started",
  );
  expect(f.submit).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
});
it("Stop invalidates a pending ownership classifier without waiting for its answer", async () => {
  const f = fixture();
  f.complete.mockImplementation(() => new Promise(() => {}));
  const pending = f.supervisor.reply([], original, "voice");
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
  await f.supervisor.reply([], "stop", "voice");
  expect(await pending).toContain("Stopped");
  expect(f.submit).not.toHaveBeenCalled();
});
