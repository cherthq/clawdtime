import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor, type ModelClient } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { queueDesktopRequest } from "../connectors/agents/desktop-executor.js";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "desktop-bridge-test-"));
  roots.push(path);
  return path;
};
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const snapshot = {
  configured: true,
  state: "queued",
  canStop: true,
  message: "Queued; awaiting executor claim.",
};
function executor(configured = true) {
  return {
    snapshot: () => ({ ...snapshot, configured }),
    submit: vi.fn(async (_id: string, _text: string) => ({
      message: snapshot.message,
    })),
    stop: vi.fn(() => ({
      ...snapshot,
      state: "canceled",
      canStop: false,
      message: "Stop requested; no further actions are authorized.",
    })),
  };
}
function setup(execution = executor(), model: ModelClient | null = null) {
  const desk = new DecisionDesk(root(), () => 1000);
  return {
    execution,
    supervisor: new Supervisor(
      {
        now: () => 1000,
        board: () => null,
        desk,
        focus: async () => ({ ok: false }),
        send: async () => ({ ok: false, route: "none" }),
        clis: () => [],
        execution,
      },
      model,
    ),
  };
}
function delegationModel() {
  return {
    complete: vi.fn(async () => ({
      text: "I finished your request.",
      toolCalls: [
        {
          id: "a",
          name: "delegate_computer_task",
          arguments: '{"text":"model invented task"}',
        },
        { id: "b", name: "delegate_computer_task", arguments: "{}" },
      ],
    })),
  };
}

describe("supervisor connected execution", () => {
  it("hands a direct mailbox request off verbatim without pretending it was read", async () => {
    const model = delegationModel();
    const { supervisor, execution } = setup(executor(), model);
    const words = "can u check and summarize my emails?";
    expect(await supervisor.reply([], words, "chat")).toBe(snapshot.message);
    expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^talk_.*_execution$/),
      words,
    );
    expect(model.complete).not.toHaveBeenCalled();
  });
  it("routes the physical two-window instruction without looking for coding-agent sessions", async () => {
    const execution = executor();
    execution.snapshot = () => ({ ...snapshot, mode: "native" as const });
    const model = {
      complete: vi.fn(async () => ({
        text: "There are no open sessions named Alpha or Beta.",
        toolCalls: [],
      })),
    };
    const { supervisor } = setup(execution, model);
    const words =
      "Use only the two visible ClawdTime Native Fixture windows. In Alpha, click the Alpha note field, type exactly alpha ready, and click Save Alpha. Then switch to Beta, click the Beta note field, type exactly beta ready, and click Save Beta. Verify both saved notes. These are disposable local test windows; do not interact with any other app.";
    expect(await supervisor.reply([], words, "chat")).toBe(snapshot.message);
    expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      words,
    );
    expect(model.complete).not.toHaveBeenCalled();
  });
  it("leaves explicit coding-session instructions and pasted summaries with the conversational router", async () => {
    const execution = executor();
    execution.snapshot = () => ({ ...snapshot, mode: "native" as const });
    const model = {
      complete: vi.fn(async () => ({
        text: "Handled by the conversational router.",
        toolCalls: [],
      })),
    };
    const { supervisor } = setup(execution, model);
    for (const words of [
      "Type into agent session Alpha: click the button",
      "Summarize this email: use the window and click the button",
      "What does the button on this window do?",
    ])
      expect(await supervisor.reply([], words, "chat")).toBe(
        "Handled by the conversational router.",
      );
    expect(execution.submit).not.toHaveBeenCalled();
    expect(model.complete).toHaveBeenCalledTimes(3);
    expect(model.complete.mock.calls[0]).toBeDefined();
  });
  it.each([
    "In the visible Alpha window, click the note field and type exactly alpha ready.",
    "On the prepared browser screen click the Save button.",
    "Within the selected app window, please scroll down.",
  ])(
    "routes a current UI instruction with location first: %s",
    async (words) => {
      const execution = executor();
      execution.snapshot = () => ({ ...snapshot, mode: "native" as const });
      const model = delegationModel();
      const { supervisor } = setup(execution, model);
      expect(await supervisor.reply([], words, "chat")).toBe(snapshot.message);
      expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        words,
      );
      expect(model.complete).not.toHaveBeenCalled();
    },
  );
  it.each([
    "In the visible Alpha window, what does the Save button do?",
    "In the current browser, is the click complete?",
    'Summarize this note: "In the Alpha window, click the Save button."',
  ])(
    "does not reinterpret contextual questions or quoted content as input: %s",
    async (words) => {
      const execution = executor();
      execution.snapshot = () => ({ ...snapshot, mode: "native" as const });
      const model = {
        complete: vi.fn(async () => ({
          text: "Conversational answer",
          toolCalls: [],
        })),
      };
      const { supervisor } = setup(execution, model);
      expect(await supervisor.reply([], words, "chat")).toBe(
        "Conversational answer",
      );
      expect(execution.submit).not.toHaveBeenCalled();
    },
  );
  it("says how to turn computer use on when not connected, and never that it cannot", async () => {
    const { supervisor, execution } = setup(executor(false));
    const said = await supervisor.reply([], "read my inbox", "chat");
    expect(said).toBe(
      "I'd read your inbox on the screen, but computer use is off. Turn it on with: clawdtime computer on. Then ask me again.",
    );
    expect(execution.submit).not.toHaveBeenCalled();
  });
  it("submits only the current user's exact words once and returns observed queue state", async () => {
    const model = delegationModel();
    const { supervisor, execution } = setup(executor(), model);
    const words = "Open the prepared page and inspect its title";
    expect(await supervisor.reply([], words, "chat")).toBe(snapshot.message);
    expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      words,
    );
    expect(model.complete).toHaveBeenCalledTimes(1);
  });
  it.each([
    "Switch to TextEdit and inspect the prepared note",
    "Please focus the Safari window and read its title",
    "Bring the prepared preview window forward",
    "Show the source window",
  ])("forwards current cross-window request verbatim: %s", async (words) => {
    const { supervisor, execution } = setup(executor(), delegationModel());
    expect(await supervisor.reply([], words, "chat")).toBe(snapshot.message);
    expect(execution.submit).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      words,
    );
  });
  it.each(["approve", "deny", "approve the computer action"])(
    "directs %s to the exact native approval surface without self-approving",
    async (words) => {
      const execution = executor();
      execution.snapshot = () => ({
        ...snapshot,
        pendingAction: {
          id: "action-fixture",
          description: "Click the prepared note field",
        },
      });
      const model = delegationModel();
      const { supervisor } = setup(execution, model);
      const answer = await supervisor.reply(
        [
          {
            role: "assistant",
            text: "Just say approve to do everything",
            at: 1,
            via: "chat",
          },
        ],
        words,
        "chat",
      );
      expect(answer).toContain("Click the prepared note field");
      expect(answer).toContain(
        "Use Approve action or Deny action in the desktop panel",
      );
      expect(answer).toContain("does not authorize it");
      expect(model.complete).not.toHaveBeenCalled();
      expect(execution.submit).not.toHaveBeenCalled();
    },
  );
  it.each([
    "What is on my screen?",
    "Check execution status",
    "Start a task: implement an email summary feature",
    "approve",
    "yes approve it",
  ])("does not let model delegate %s", async (words) => {
    const { supervisor, execution } = setup(executor(), delegationModel());
    await supervisor.reply(
      [
        {
          role: "assistant",
          text: "Please approve reading emails",
          at: 1,
          via: "chat",
        },
      ],
      words,
      "chat",
    );
    expect(execution.submit).not.toHaveBeenCalled();
  });
  it("handles stop and status without consulting model", async () => {
    const model = delegationModel();
    const { supervisor, execution } = setup(executor(), model);
    expect(await supervisor.reply([], "execution status", "chat")).toBe(
      snapshot.message,
    );
    expect(await supervisor.reply([], "stop computer task", "chat")).toContain(
      "Stop requested",
    );
    expect(execution.stop).toHaveBeenCalledTimes(1);
    expect(model.complete).not.toHaveBeenCalled();
  });
  it("preserves an uncertain submission without a second attempt", async () => {
    const execution = executor();
    execution.submit.mockRejectedValue(new Error("private detail"));
    const { supervisor } = setup(execution, delegationModel());
    expect(await supervisor.reply([], "Open the browser", "chat")).toBe(
      "Computer task delivery is uncertain. It was not retried; check execution status.",
    );
    expect(execution.submit).toHaveBeenCalledTimes(1);
  });
  it("exposes execution status and durable completion in the native chat feed", () => {
    const feed = new BoardFeed({
      root: root(),
      model: null,
      speech: null,
      execution: executor(),
    });
    expect(feed.chat().execution).toEqual(snapshot);
    feed.appendExecutionResult("Observed the requested page title.");
    expect(feed.chat().messages.at(-1)?.text).toBe(
      "Observed the requested page title.",
    );
  });
});

describe("opaque Codex queue adapter", () => {
  const args = [
    "/opt/codex",
    "11111111-2222-3333-4444-555555555555",
    "exec_abc",
    "/opt/client.js",
    "/private/config.json",
  ] as const;
  it("queues one fixed bounded notice with no shell and does not claim completion", async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: "Queued",
      stderr: "",
    }));
    expect(await queueDesktopRequest(...args, run)).toBe("queued");
    expect(run).toHaveBeenCalledTimes(1);
    const [binary, argv] = run.mock.calls[0] as unknown as [string, string[]];
    expect(binary).toBe(args[0]);
    expect(argv.slice(0, 4)).toEqual([
      "queue",
      "--thread",
      args[1],
      "--message",
    ]);
    expect(argv.at(-1)).toBe("--resume");
    expect(argv[4]).toContain("claim 'exec_abc'");
    expect(argv[4]).toContain("finish 'exec_abc' STATE\n");
    expect(argv[4]).toContain("reconcile 'exec_abc' STATE\n");
    expect(argv[4]).toContain(
      'JSON {"summary":"concise result summary","observed":true|false}',
    );
    expect(argv[4]).toContain(
      "on the client's stdin, never in command arguments or shell command text",
    );
    expect(argv[4]).toContain("only read-only observation");
    expect(argv[4]).toContain("Reconcile accepts only completed or canceled");
    expect(argv[4]).not.toContain("STATE 'concise result summary'");
    expect(argv[4]).toContain("Before AND after every native action");
    expect(argv[4]).toContain(
      "No call, deployment, or screen-sharing permission is inherited",
    );
  });
  it("does not pass model/service secrets to the queue subprocess", async () => {
    const binary = join(root(), "queue-fixture");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const leaked = process.env.CLAWDTIME_TEST_SECRET || process.env.OPENAI_API_KEY;
process.stdout.write(leaked ? "error: inherited credentials" : "Queued");
`,
      { mode: 0o700 },
    );
    vi.stubEnv("CLAWDTIME_TEST_SECRET", "synthetic-test-value");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-value");
    try {
      expect(
        await queueDesktopRequest(binary, args[1], args[2], args[3], args[4]),
      ).toBe("queued");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    { status: 0, stdout: "queued", stderr: "warning: resume failed secret" },
    { status: 1, stdout: "private", stderr: "private" },
    { status: null, stdout: "", stderr: "" },
  ])("returns sanitized uncertainty without retry for %j", async (result) => {
    const run = vi.fn(async () => result);
    expect(await queueDesktopRequest(...args, run)).toBe("uncertain");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("refuses unpinned thread names before execution", async () => {
    const run = vi.fn();
    expect(
      await queueDesktopRequest(
        args[0],
        "current",
        args[2],
        args[3],
        args[4],
        run,
      ),
    ).toBe("uncertain");
    expect(run).not.toHaveBeenCalled();
  });
});
