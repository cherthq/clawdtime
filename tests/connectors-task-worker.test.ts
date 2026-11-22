import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTaskWorker } from "../connectors/codex/task-worker.js";
import type {
  AppServerConnection,
  AppServerMessage,
} from "../connectors/codex/app-server.js";

class Host implements AppServerConnection {
  listeners = new Set<(message: AppServerMessage) => void>();
  requests: Array<{ method: string; params: any }> = [];
  responses: unknown[] = [];
  onStart = () => this.complete();
  onInterrupt = () => this.complete("interrupted");
  closed = false;
  policy = {
    approvalPolicy: "on-request",
    sandbox: {
      type: "workspaceWrite",
      networkAccess: false,
      writableRoots: [] as string[],
    },
  };
  integrations = {
    data: [] as Array<{ runtimeStatus: string }>,
    nextCursor: null,
  };
  async request(method: string, params: any) {
    this.requests.push({ method, params });
    if (method === "config/read")
      return {
        config: {
          mcp_servers: { synthetic: { enabled: true } },
          plugins: { example: { enabled: true } },
        },
      };
    if (method === "thread/start")
      return {
        thread: { id: "thread" },
        ...this.policy,
      };
    if (method === "mcpServerStatus/list") return this.integrations;
    if (method === "turn/start") {
      queueMicrotask(() => {
        this.message("turn/started", { turn: { id: "turn" } });
        this.onStart();
      });
      return { turn: { id: "turn" } };
    }
    if (method === "turn/interrupt") this.onInterrupt();
    return {};
  }
  message(method: string, params: any = {}, id?: number) {
    for (const fn of this.listeners)
      fn({
        method,
        params: { threadId: "thread", turnId: "turn", ...params },
        ...(id === undefined ? {} : { id }),
      });
  }
  complete(
    status = "completed",
    output: unknown = {
      summary: "Fixture edited; independent verification pending.",
      decision: null,
    },
  ) {
    this.message("turn/completed", {
      turn: {
        id: "turn",
        status,
        items: [{ type: "agentMessage", text: JSON.stringify(output) }],
      },
    });
  }
  respond(id: number | string, result: unknown) {
    this.responses.push({ id, result });
  }
  reject(id: number | string) {
    this.responses.push({ id, rejected: true });
  }
  subscribe(listener: (message: AppServerMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    this.closed = true;
  }
}
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture(host = new Host()) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-codex-task-")),
  );
  directories.push(root);
  const worker = new CodexTaskWorker({
    enabled: true,
    projectRoots: [root],
    connectionFactory: () => host,
    interruptTimeoutMs: 10,
  });
  const input = {
    taskId: "task",
    runId: "run",
    revision: 1,
    projectRoot: root,
    context: "Edit only the disposable fixture.",
  };
  return {
    host,
    root,
    worker,
    input,
    run: (signal = new AbortController().signal) =>
      worker.run(input, () => {}, signal),
  };
}

describe("independent Codex task worker", () => {
  it("refuses unexpected sandbox or an enabled integration before a model turn", async () => {
    for (const mutate of [
      (host: Host) => {
        host.policy.sandbox.networkAccess = true;
      },
      (host: Host) => {
        host.policy.sandbox.type = "dangerFullAccess";
      },
      (host: Host) => {
        host.policy.sandbox.writableRoots = ["/"];
      },
      (host: Host) => {
        host.policy.approvalPolicy = "never";
      },
      (host: Host) => {
        host.integrations.data = [{ runtimeStatus: "connected" }];
      },
    ]) {
      const f = fixture();
      mutate(f.host);
      expect((await f.run()).outcome).toBe("blocked");
      expect(f.host.requests.some((r) => r.method === "turn/start")).toBe(
        false,
      );
    }
  });
  it("keeps a completed command with no process exit evidence unknown", async () => {
    const f = fixture();
    f.host.onStart = () => {
      f.host.message("item/started", {
        item: { id: "command", type: "commandExecution" },
      });
      f.host.message("item/completed", {
        item: {
          id: "command",
          type: "commandExecution",
          status: "completed",
          exitCode: null,
        },
      });
      f.host.complete();
    };
    expect((await f.run()).outcome).toBe("unknown");
  });
  it("reports completed execution independently of verification and closes its own thread", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      outcome: "completed",
      threadId: "thread",
      turnId: "turn",
    });
    expect(result).not.toHaveProperty("verification");
    expect(f.host.closed).toBe(true);
    expect(
      f.host.requests.find((r) => r.method === "thread/start")?.params,
    ).toMatchObject({
      cwd: f.root,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      ephemeral: true,
      config: {
        mcp_servers: { synthetic: { enabled: false } },
        plugins: { example: { enabled: false } },
        web_search: "disabled",
        "sandbox_workspace_write.network_access": false,
      },
    });
    expect(
      f.host.requests.find((r) => r.method === "turn/start")?.params,
    ).toMatchObject({
      clientUserMessageId: "run",
      outputSchema: {
        required: ["summary", "decision", "decisionOptions"],
        properties: {
          decisionOptions: {
            anyOf: [
              {
                type: "array",
                minItems: 2,
                maxItems: 3,
                items: { type: "string", minLength: 1, maxLength: 500 },
              },
              { type: "null" },
            ],
          },
        },
      },
    });
  });
  it("returns a bounded unresolved decision without inventing success", async () => {
    const f = fixture();
    f.host.onStart = () =>
      f.host.complete("completed", {
        summary: "Filter implemented.",
        decision: "Which empty state should appear?",
      });
    expect(await f.run()).toMatchObject({
      outcome: "completed",
      decision: "Which empty state should appear?",
    });
  });
  it("preserves concrete model-provided choices with the unresolved decision", async () => {
    const f = fixture();
    f.host.onStart = () =>
      f.host.complete("completed", {
        summary: "The empty-state copy needs a product choice.",
        decision: "Which empty-state wording should appear?",
        decisionOptions: [
          " No tasks match ",
          "No matching tasks",
          "Nothing matches your filters",
        ],
      });
    expect(await f.run()).toMatchObject({
      outcome: "completed",
      decision: "Which empty-state wording should appear?",
      decisionOptions: [
        "No tasks match",
        "No matching tasks",
        "Nothing matches your filters",
      ],
    });
    expect(
      f.host.requests.find((r) => r.method === "thread/start")?.params
        .developerInstructions,
    ).toContain("Do not invent choices when the decision requires free text");
    expect(
      f.host.requests.filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  });
  it.each([undefined, null])(
    "keeps a free-text decision without fabricated choices: %s",
    async (decisionOptions) => {
      const f = fixture();
      f.host.onStart = () =>
        f.host.complete("completed", {
          summary: "Needs copy.",
          decision: "What exact text should appear?",
          decisionOptions,
        });
      const result = await f.run();
      expect(result.outcome).toBe("completed");
      expect(result.decision).toBe("What exact text should appear?");
      expect(result).not.toHaveProperty("decisionOptions");
    },
  );
  it("never exposes choices without an unresolved decision", async () => {
    const f = fixture();
    f.host.onStart = () =>
      f.host.complete("completed", {
        summary: "Finished.",
        decision: null,
        decisionOptions: ["Choice one", "Choice two"],
      });
    const result = await f.run();
    expect(result.outcome).toBe("completed");
    expect(result).not.toHaveProperty("decision");
    expect(result).not.toHaveProperty("decisionOptions");
  });
  it.each(
    (
      [
        [],
        ["Only one"],
        ["a", "b", "c", "d"],
        [" ", "valid"],
        ["x".repeat(501), "valid"],
        ["same", "same"],
        ["Same", " same "],
        ["valid", 4],
      ] as unknown[]
    ).map((decisionOptions) => ({ decisionOptions })),
  )(
    "refuses malformed choices %j without retrying the worker",
    async ({ decisionOptions }) => {
      const f = fixture();
      f.host.onStart = () =>
        f.host.complete("completed", {
          summary: "Needs decision.",
          decision: "Which wording?",
          decisionOptions,
        });
      const result = await f.run();
      expect(result.outcome).toBe("blocked");
      expect(result).not.toHaveProperty("decisionOptions");
      expect(
        f.host.requests.filter((r) => r.method === "turn/start"),
      ).toHaveLength(1);
    },
  );
  it.each([
    {},
    { summary: "x", decision: null, extra: true },
    { summary: "x".repeat(4001), decision: null },
  ])(
    "blocks malformed result %j without losing known terminal outcome",
    async (output) => {
      const f = fixture();
      f.host.onStart = () => f.host.complete("completed", output);
      expect((await f.run()).outcome).toBe("blocked");
    },
  );
  it.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
  ])("denies %s and waits for terminal outcome", async (method) => {
    const f = fixture();
    f.host.onStart = () => f.host.message(method, {}, 7);
    expect((await f.run()).outcome).toBe("blocked");
    expect(
      f.host.requests.filter((r) => r.method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(f.host.responses).toEqual(
      method === "item/permissions/requestApproval"
        ? [{ id: 7, result: { permissions: {}, scope: "turn" } }]
        : method === "item/tool/requestUserInput"
          ? [{ id: 7, rejected: true }]
          : [{ id: 7, result: { decision: "decline" } }],
    );
  });
  it("does not treat cancellation RPC acknowledgement as worker termination", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.onStart = () => controller.abort();
    f.host.onInterrupt = () => {};
    expect((await f.run(controller.signal)).outcome).toBe("unknown");
    expect(
      (
        await f.worker.run(
          { ...f.input, runId: "followup" },
          () => {},
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("blocked");
    expect(
      f.host.requests.filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  });
  it("keeps in-flight tool effects unknown even after terminal interruption", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.onStart = () => {
      f.host.message("item/started", {
        item: { id: "effect", type: "commandExecution" },
      });
      controller.abort();
    };
    expect((await f.run(controller.signal)).outcome).toBe("unknown");
  });
  it("accepts cancellation only after terminal receipt with no unresolved tools", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.host.onStart = () => controller.abort();
    expect((await f.run(controller.signal)).outcome).toBe("canceled");
  });
  it("deduplicates run invocation and never steers or resumes a prior thread", async () => {
    const f = fixture();
    await f.run();
    expect((await f.run()).outcome).toBe("unknown");
    expect(
      f.host.requests.filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      f.host.requests.some(
        (r) => r.method === "turn/steer" || r.method === "thread/resume",
      ),
    ).toBe(false);
  });
  it("ignores another thread/turn and fences concurrent runs", async () => {
    const f = fixture();
    f.host.onStart = () => {
      f.host.message("turn/completed", {
        threadId: "other",
        turn: { id: "turn", status: "completed" },
      });
      f.host.message("turn/completed", {
        turnId: "other",
        turn: { id: "other", status: "completed" },
      });
      setTimeout(() => f.host.complete(), 10);
    };
    const pending = f.run();
    expect(
      (
        await f.worker.run(
          { ...f.input, runId: "second" },
          () => {},
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("blocked");
    expect((await pending).outcome).toBe("completed");
  });
  it("refuses an unselected root or pre-canceled input before submission", async () => {
    const f = fixture();
    expect(
      (
        await f.worker.run(
          { ...f.input, projectRoot: "/" },
          () => {},
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("blocked");
    expect((await f.run(AbortSignal.abort())).outcome).toBe("canceled");
    expect(f.host.requests).toHaveLength(0);
  });
  it("leaves disconnect unknown without retry", async () => {
    const f = fixture();
    f.host.onStart = () => f.host.message("clawdtime/disconnected");
    expect((await f.run()).outcome).toBe("unknown");
    expect(
      f.host.requests.filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
  });
  it("keeps healthy work active beyond three minutes without any interrupt", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.onStart = () => {};
    let settled = false;
    const run = f.run().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(181_000);
    expect(settled).toBe(false);
    expect(f.host.closed).toBe(false);
    expect(f.host.requests.some((r) => r.method === "turn/interrupt")).toBe(
      false,
    );
    f.host.message("item/started", {
      item: { id: "edit", type: "fileChange" },
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(settled).toBe(false);
    f.host.message("item/completed", {
      item: { id: "edit", type: "fileChange" },
    });
    f.host.complete();
    expect(await run).toMatchObject({
      outcome: "completed",
      reasonCode: "completed",
    });
  });
  it("keeps listening during Stop until terminal confirmation and accepts a completion racing Stop", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.onStart = () => {};
    f.host.onInterrupt = () => {};
    const controller = new AbortController();
    const run = f.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(f.host.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    f.host.complete();
    expect((await run).outcome).toBe("completed");
    expect(
      f.host.requests.filter((r) => r.method === "turn/interrupt"),
    ).toHaveLength(1);
  });
  it("preserves terminal completion arriving before a slow start RPC times out", async () => {
    const f = fixture();
    const request = f.host.request.bind(f.host);
    f.host.request = async (method, params) => {
      const answer = await request(method, params);
      if (method === "turn/start") throw new Error("executor_rpc_timeout");
      return answer;
    };
    expect((await f.run()).outcome).toBe("completed");
  });
  it("keeps running after a slow start RPC when the accepted event proves submission", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.host.onStart = () => {};
    const request = f.host.request.bind(f.host);
    f.host.request = async (method, params) => {
      const answer = await request(method, params);
      if (method === "turn/start") throw new Error("executor_rpc_timeout");
      return answer;
    };
    const run = f.run();
    await vi.advanceTimersByTimeAsync(181_000);
    expect(f.host.closed).toBe(false);
    f.host.complete();
    expect((await run).outcome).toBe("completed");
  });
  it("distinguishes process exit and ignores a late terminal event after uncertainty", async () => {
    const f = fixture();
    f.host.onStart = () => {
      f.host.message("clawdtime/disconnected", { reason: "process_exit" });
      f.host.complete();
    };
    expect(await f.run()).toMatchObject({
      outcome: "unknown",
      reasonCode: "process_exit",
    });
    expect(
      (
        await f.worker.run(
          { ...f.input, runId: "later" },
          () => {},
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("blocked");
  });
  it("reports genuine terminal failure separately from a disconnected run", async () => {
    const f = fixture();
    f.host.onStart = () => f.host.complete("failed");
    expect(await f.run()).toMatchObject({
      outcome: "failed",
      reasonCode: "worker_failed",
    });
  });
  it("emits authoritative thread and turn identities before terminal completion", async () => {
    const f = fixture();
    const progress: Array<{
      phase: string;
      threadId?: string;
      turnId?: string;
    }> = [];
    const result = await f.worker.run(
      f.input,
      (event) => progress.push(event),
      new AbortController().signal,
    );
    expect(result.outcome).toBe("completed");
    expect(progress).toContainEqual({
      phase: "connecting",
      threadId: "thread",
    });
    expect(progress).toContainEqual({
      phase: "accepted",
      threadId: "thread",
      turnId: "turn",
    });
  });
  it("blocks submission when the initial progress receipt cannot be persisted", async () => {
    const f = fixture();
    const result = await f.worker.run(
      f.input,
      () => {
        throw new Error("private-storage-error");
      },
      new AbortController().signal,
    );
    expect(result.outcome).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("private-storage-error");
    expect(
      f.host.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
  });
  it("fences admitted work if a progress callback fails without throwing from the event handler", async () => {
    const f = fixture();
    const result = await f.worker.run(
      f.input,
      (event) => {
        if (event.phase === "accepted")
          throw new Error("private-storage-error");
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      outcome: "unknown",
      reasonCode: "progress_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("private-storage-error");
    expect(f.host.closed).toBe(true);
  });
  it("preserves a bounded context containing all prior human revision constraints", async () => {
    const f = fixture();
    const context = JSON.stringify({
      goal: "Build a local page. Don't deploy.",
      priorHumanInstructions: Array.from(
        { length: 5 },
        (_, i) => `${i}: ${"constraint ".repeat(700)}Don't send or deploy.`,
      ),
      instruction: "Make it blue.",
    });
    expect(context.length).toBeGreaterThan(24_000);
    expect(
      (
        await f.worker.run(
          { ...f.input, context },
          () => {},
          new AbortController().signal,
        )
      ).outcome,
    ).toBe("completed");
    expect(
      f.host.requests.find((request) => request.method === "turn/start")?.params
        .input[0].text,
    ).toBe(context);
  });
  it("refuses an oversized revision context rather than truncating constraints", async () => {
    const f = fixture();
    const result = await f.worker.run(
      { ...f.input, context: "x".repeat(300_001) },
      () => {},
      new AbortController().signal,
    );
    expect(result.outcome).toBe("blocked");
    expect(f.host.requests).toEqual([]);
  });
});
