import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { phoneGuard, phoneTurn } from "../connectors/agents/phone-turn.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { fakeSystem } from "./connectors-agents-fixture.js";
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(complete: ModelClient["complete"]) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-phone-turn-"));
  roots.push(root);
  const start = vi.fn<NonNullable<SupervisorWorld["jobs"]>["start"]>(
    async () => ({
      ok: true,
      said: "Requested a new terminal session; launch not verified.",
    }),
  );
  const openApp = vi.fn<NonNullable<SupervisorWorld["openApp"]>>(async () => ({
    ok: true,
    said: "Opened Messages.",
  }));
  const world: SupervisorWorld = {
    now: Date.now,
    board: () => null,
    desk: new DecisionDesk(root),
    focus: async () => ({ ok: true }),
    send: async () => ({ ok: true, route: "terminal" }),
    clis: () => [],
    jobs: { start, recent: () => [] },
    openApp,
  };
  return {
    supervisor: new Supervisor(world, { complete }),
    start,
    openApp,
    world,
    root,
  };
}
const applied = {
  phonePresentation: { kind: "sharing", action: "hide", applied: true },
} as const;
it("returns actual presentation state before eager routes can create a job", async () => {
  const complete = vi.fn<ModelClient["complete"]>(async () => ({
    text: JSON.stringify({ intent: "presentation_only" }),
    toolCalls: [],
  }));
  const f = fixture(complete);
  expect(await f.supervisor.reply([], "Hide my screen", "voice", applied)).toBe(
    "Screen sharing is off.",
  );
  expect(f.start).not.toHaveBeenCalled();
  expect(f.openApp).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]?.[0]?.tools).toEqual([]);
});
it("preserves compound original words and dispatches the additional work", async () => {
  const complete = vi.fn<ModelClient["complete"]>(async (input) =>
    input.tools.length === 0
      ? {
          text: JSON.stringify({ intent: "additional_request" }),
          toolCalls: [],
        }
      : {
          text: "",
          toolCalls: [
            {
              id: "job",
              name: "start_job",
              arguments: JSON.stringify({ agent: "claude" }),
            },
          ],
        },
  );
  const f = fixture(complete),
    text =
      "Hide my screen and start a new Claude session to build a calculator.";
  await f.supervisor.reply([], text, "voice", applied);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0]?.[0]).toBe(text);
  expect(complete.mock.calls[0]![0].messages).toEqual([
    { role: "user", content: text },
  ]);
});
it.each(["unclear", "malformed", "failure"])(
  "does not dispatch after %s classification",
  async (kind) => {
    const f = fixture(async () => {
      if (kind === "failure") throw Error("unavailable");
      return {
        text: kind === "malformed" ? "hello" : JSON.stringify({ intent: kind }),
        toolCalls: [],
      };
    });
    expect(
      await f.supervisor.reply(
        [],
        "Hide my screen and do that",
        "voice",
        applied,
      ),
    ).toContain("separate request");
    expect(f.start).not.toHaveBeenCalled();
    expect(f.openApp).not.toHaveBeenCalled();
  },
);
it("a caller zoom that found nothing stays call video: it opens no app and starts no job", async () => {
  const complete = vi.fn<ModelClient["complete"]>(async () => ({
    text: JSON.stringify({ intent: "presentation_only" }),
    toolCalls: [],
  }));
  const f = fixture(complete);
  expect(
    await f.supervisor.reply(
      [],
      "Zoom on the Send button in Stonepad",
      "voice",
      {
        phonePresentation: { kind: "zoom", action: "zoom", applied: false },
      },
    ),
  ).toMatch(/did not find what the caller named/);
  expect(f.start).not.toHaveBeenCalled();
  expect(f.openApp).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]?.[0]?.tools).toEqual([]);
  // Another presentation that was not applied keeps its earlier meaning.
  const g = fixture(complete);
  await g.supervisor.reply([], "Hello", "voice", {
    phonePresentation: { kind: "sharing", action: "show", applied: false },
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]?.[0]?.system).not.toContain(
    "Classify the user's entire",
  );
});
it("does not classify ordinary turns", async () => {
  const complete = vi.fn<ModelClient["complete"]>(async () => ({
      text: "Hello.",
      toolCalls: [],
    })),
    f = fixture(complete);
  await f.supervisor.reply([], "Hello", "voice");
  expect(
    complete.mock.calls.every(
      (call) => !call[0]?.system.includes("Classify the user's entire"),
    ),
  ).toBe(true);
});
it("refuses actions after a model completes following hangup", async () => {
  let live = true;
  const complete = vi.fn<ModelClient["complete"]>(async () => {
    live = false;
    return {
      text: "",
      toolCalls: [
        {
          id: "open",
          name: "open_app",
          arguments: JSON.stringify({ name: "Messages" }),
        },
      ],
    };
  });
  const f = fixture(complete);
  const reply = await f.supervisor.reply(
    [],
    "Could you show me the Messages application?",
    "voice",
    { isLive: () => live },
  );
  expect(reply).toContain("call ended");
  expect(f.openApp).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});
it("refuses eager actions on an already expired call", async () => {
  const f = fixture(async () => ({ text: "", toolCalls: [] }));
  expect(
    await f.supervisor.reply(
      [],
      "Start a new Claude session to build a calculator",
      "voice",
      { isLive: () => false },
    ),
  ).toContain("call ended");
  expect(f.start).not.toHaveBeenCalled();
});
it("keeps independent turns isolated and checks every subprocess invocation after awaits", async () => {
  let live = true;
  const calls: string[] = [];
  const run = phoneGuard(async (name: string) => {
    calls.push(name);
    if (name === "probe") live = false;
  });
  await phoneTurn.run({ isLive: () => live }, async () => {
    await run("probe");
    expect(() => run("late-effect")).toThrow("phone_call_expired");
  });
  await phoneTurn.run({}, async () => run("local-effect"));
  expect(calls).toEqual(["probe", "local-effect"]);
});
it("BoardFeed forwards the phone context to its supervisor", async () => {
  const f = fixture(async () => ({ text: "", toolCalls: [] }));
  const run = vi.fn(async () => ({ status: 0, stdout: "ok" }));
  const feed = new BoardFeed({
    root: f.root,
    project: f.root,
    runner: run,
    model: null,
    system: fakeSystem({ now: Date.now() }),
  });
  expect(
    (
      await feed.say("Start a new Claude session", "voice", {
        isLive: () => false,
      })
    ).text,
  ).toContain("call ended");
  expect(run).not.toHaveBeenCalled();
});

it("routes explicit new Claude sessions with window wording and restrictive instructions to Jobs", async () => {
  const f = fixture(async () => ({ text: "", toolCalls: [] }));
  const text =
    "Start a new Claude Code session in a separate terminal window. For this smoke test, only reply READY; do not edit files or run commands.";
  const submit = vi.fn(async () => ({ message: "wrong destination" }));
  const reading = vi.fn(async (source: string) => ({
    intent: { kind: "none" as const },
    work: false,
    codingSession: { source, agent: "claude" as const },
  }));
  const supervisor = new Supervisor(
    {
      ...f.world,
      execution: {
        snapshot: () => ({
          configured: true,
          mode: "native",
          state: "idle",
          canStop: false,
          message: "Ready",
        }),
        submit,
        stop: () => ({
          configured: true,
          state: "idle",
          canStop: false,
          message: "Stopped",
        }),
        answer: async () => ({ message: "ok" }),
      },
    },
    { reading, complete: async () => ({ text: "", toolCalls: [] }) },
  );
  const reply = await supervisor.reply([], text, "voice", {
    isLive: () => true,
  });
  expect(reply).toContain("launch not verified");
  expect(reading).toHaveBeenCalledExactlyOnceWith(text);
  expect(f.start).toHaveBeenCalledExactlyOnceWith(
    text,
    expect.objectContaining({ agent: "claude" }),
  );
  expect(submit).not.toHaveBeenCalled();
  expect(f.openApp).not.toHaveBeenCalled();
});

it.each([
  "Do not start a new Claude Code session.",
  'The document says "start a new Claude Code session in a separate window". What does that mean?',
])(
  "does not create a session for negated or reported content: %s",
  async (text) => {
    const f = fixture(async () => ({
      text: "No session started.",
      toolCalls: [],
    }));
    const submit = vi.fn(async () => ({ message: "wrong destination" }));
    const supervisor = new Supervisor(
      {
        ...f.world,
        execution: {
          snapshot: () => ({
            configured: true,
            mode: "native",
            state: "idle",
            canStop: false,
            message: "Ready",
          }),
          submit,
          stop: () => ({
            configured: true,
            state: "idle",
            canStop: false,
            message: "Stopped",
          }),
        },
      },
      {
        reading: async () => ({ intent: { kind: "none" }, work: false }),
        complete: async () => ({ text: "No session started.", toolCalls: [] }),
      },
    );
    await supervisor.reply([], text, "voice");
    expect(f.start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

it("does not fall through to native or conversational dispatch for a malformed session interpretation", async () => {
  const f = fixture(async () => ({ text: "", toolCalls: [] }));
  const submit = vi.fn(async () => ({ message: "wrong destination" })),
    complete = vi.fn<ModelClient["complete"]>(async () => ({
      text: "",
      toolCalls: [{ id: "job", name: "start_job", arguments: "{}" }],
    }));
  const supervisor = new Supervisor(
    {
      ...f.world,
      execution: {
        snapshot: () => ({
          configured: true,
          mode: "native",
          state: "idle",
          canStop: false,
          message: "Ready",
        }),
        submit,
        stop: () => ({
          configured: true,
          state: "idle",
          canStop: false,
          message: "Stopped",
        }),
      },
    },
    {
      reading: async () => ({
        intent: { kind: "none" },
        work: false,
        codingSession: { source: "rewritten request", agent: "claude" },
      }),
      complete,
    },
  );
  expect(
    await supervisor.reply(
      [],
      "Start a new Claude session; do not edit files.",
      "voice",
    ),
  ).toContain("No session was started");
  expect(f.start).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
