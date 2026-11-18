import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingTask,
  TaskCommand,
  TaskVerification,
  TaskWorker,
  TaskWorkerResult,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { createTaskApp } from "../src/control/task-app.js";
import { runTaskVerification } from "../src/control/task-verification.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(worker: TaskWorker, verify?: typeof runTaskVerification) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-engine-")),
  );
  const store = new Store();
  const vault = new Vault("ab".repeat(32));
  let offset = 0;
  const clock = () => Date.now() + offset;
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "mac",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: clock(),
  });
  const ledger = new TaskLedger(store, vault, clock);
  const service = new TaskService(store, vault, ledger, {
    projectRoots: [directory],
    simulation: false,
    clock,
  });
  const registered = service.register({
    eventId: "registration",
    pairingId: "pair",
    hostId: "host",
    projectRoot: directory,
  });
  const engine = new TaskEngine(
    service,
    worker,
    [
      {
        name: "test fixture",
        command: [process.execPath, "-e", "process.exit(0)"],
      },
    ],
    verify,
  );
  cleanup.push(async () => {
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const create = () =>
    service.create(registered.token, {
      eventId: `submission-${sequence++}`,
      goal: "Add the task filter.",
    }).task;
  const get = (task: CodingTask) => ledger.get(registered.session.id, task.id);
  const command = (task: CodingTask, value: Record<string, unknown>) =>
    service.command(registered.token, task.id, {
      eventId: `human-${sequence++}`,
      expectedRevision: task.revision,
      ...value,
    } as TaskCommand).task;
  return {
    directory,
    store,
    vault,
    ledger,
    service,
    registered,
    engine,
    create,
    get,
    command,
    advance: (ms: number) => {
      offset += ms;
    },
  };
}

function report(
  runId: string,
  state: TaskVerification["state"] = "passed",
): TaskVerification {
  return {
    id: `v-${runId}`,
    runId,
    state,
    completedAt: Date.now(),
    checks: [
      {
        name: "Independent fixture",
        command: ["fixture-check"],
        state,
        exitCode: state === "passed" ? 0 : state === "failed" ? 1 : null,
        summary: "Observed check outcome.",
      },
    ],
  };
}

const completed: TaskWorkerResult = {
  outcome: "completed",
  summary: "Worker says the code is implemented.",
};

describe("service-owned task engine and independent watcher", () => {
  it("runs through HTTP and auto-starts one follow-up for a repeated decision receipt", async () => {
    const followup = deferred<TaskWorkerResult>();
    const worker = {
      run: vi
        .fn<TaskWorker["run"]>()
        .mockResolvedValueOnce({
          ...completed,
          decision: "What should the empty state show?",
        })
        .mockImplementationOnce(() => followup.promise),
    };
    const verify = vi.fn(async (_root: string, runId: string) => report(runId));
    const f = fixture(worker, verify);
    const app = createTaskApp(
      f.service,
      "synthetic-operator-" + "x".repeat(32),
      f.engine,
    );
    const post = (path: string, body: unknown, token = f.registered.token) =>
      app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const created = await post("/tasks", {
      eventId: "http-submission",
      goal: "Add the task filter.",
    });
    expect(created.status).toBe(200);
    let task = (await created.json()).task as CodingTask;
    expect((await post(`/tasks/${task.id}/run`, {}, "wrong")).status).toBe(401);
    expect((await post(`/tasks/${task.id}/run`, {})).status).toBe(200);
    await f.engine.wait(task.id);
    task = f.get(task);
    expect(task.state).toBe("needs_decision");
    const decision = {
      action: "decide",
      eventId: "http-spoken-revision",
      expectedRevision: task.revision,
      runId: task.runs[0]!.id,
      instruction: "Add a Clear filters button.",
    };
    const first = await post(`/tasks/${task.id}/commands`, decision);
    expect(first.status).toBe(200);
    expect((await first.json()).replayed).toBe(false);
    const repeated = await post(`/tasks/${task.id}/commands`, decision);
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).replayed).toBe(true);
    expect(worker.run).toHaveBeenCalledTimes(2);
    expect(f.get(task).runs).toHaveLength(2);
    expect(f.get(task).state).toBe("running");
    followup.resolve(completed);
    await f.engine.wait(task.id);
    expect(f.get(task).state).toBe("review_ready");
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("keeps status responsive and verifies only after the original worker finishes", async () => {
    const terminal = deferred<TaskWorkerResult>();
    const worker = { run: vi.fn(() => terminal.promise) };
    const verify = vi.fn(async (_root: string, runId: string) => report(runId));
    const f = fixture(worker, verify);
    const task = f.create();
    expect(f.engine.start(task.sessionId, task.id).state).toBe("running");
    f.engine.start(task.sessionId, task.id);
    await Promise.resolve();
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    expect(f.get(task).state).toBe("running");
    terminal.resolve(completed);
    await f.engine.wait(task.id);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(f.get(task).state).toBe("review_ready");
    expect(f.get(task).verification!.state).toBe("passed");
  });

  it("does not let a worker completion claim override failing independent checks", async () => {
    const verify = vi.fn(async (_root: string, runId: string) =>
      report(runId, "failed"),
    );
    const f = fixture({ run: async () => completed }, verify);
    const task = f.create();
    f.engine.start(task.sessionId, task.id);
    await f.engine.wait(task.id);
    expect(f.get(task).state).toBe("needs_decision");
    expect(f.get(task).runs[0]!.state).toBe("completed");
    expect(f.get(task).verification!.state).toBe("failed");
  });

  it("starts exactly one scoped follow-up with retained task context after a typed decision", async () => {
    const worker = {
      run: vi
        .fn<TaskWorker["run"]>()
        .mockResolvedValueOnce({
          ...completed,
          decision: "What should the empty state show?",
        })
        .mockResolvedValueOnce(completed),
    };
    const verify = vi.fn(async (_root: string, runId: string) => report(runId));
    const f = fixture(worker, verify);
    const original = f.create();
    f.engine.start(original.sessionId, original.id);
    await f.engine.wait(original.id);
    let task = f.get(original);
    expect(task.state).toBe("needs_decision");
    const decision: TaskCommand = {
      action: "decide",
      eventId: "typed-revision",
      expectedRevision: task.revision,
      runId: task.runs[0]!.id,
      instruction: "Show an empty state with a Clear filters button.",
    };
    const first = f.service.command(f.registered.token, task.id, decision);
    expect(first.replayed).toBe(false);
    expect(
      f.service.command(f.registered.token, task.id, decision).replayed,
    ).toBe(true);
    task = first.task;
    f.engine.start(task.sessionId, task.id);
    f.engine.start(task.sessionId, task.id);
    await f.engine.wait(task.id);
    task = f.get(task);
    expect(task.id).toBe(original.id);
    expect(task.state).toBe("review_ready");
    expect(task.runs).toHaveLength(2);
    expect(task.verifications).toHaveLength(2);
    expect(worker.run).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    const firstInput = worker.run.mock.calls[0]![0],
      nextInput = worker.run.mock.calls[1]![0];
    expect(nextInput.taskId).toBe(firstInput.taskId);
    expect(nextInput.runId).not.toBe(firstInput.runId);
    expect(nextInput.dispatchId).not.toBe(firstInput.dispatchId);
    const context = JSON.parse(nextInput.context);
    expect(context.goal).toBe(original.goal);
    expect(context.instruction).toBe(decision.instruction);
    expect(context.priorResults[0].runId).toBe(firstInput.runId);
    expect(context.decision.question).toBe("What should the empty state show?");
  });

  it("serializes another task until both worker and verifier are settled", async () => {
    const checked = deferred<TaskVerification>();
    let verificationRun = "";
    const verify = vi.fn(async (_root: string, runId: string) => {
      verificationRun = runId;
      return checked.promise;
    });
    const f = fixture({ run: async () => completed }, verify);
    const a = f.create(),
      b = f.create();
    f.engine.start(a.sessionId, a.id);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.get(a).state).toBe("verifying");
    expect(() => f.engine.start(b.sessionId, b.id)).toThrow(/unresolved/);
    checked.resolve(report(verificationRun));
    await f.engine.wait(a.id);
    expect(f.get(a).state).toBe("review_ready");
  });

  it("fences unknown worker outcomes and never invokes verification or a replacement run", async () => {
    const worker = {
      run: vi.fn(async () => {
        throw new Error("synthetic lost worker reply");
      }),
    };
    const verify = vi.fn(async (_root: string, runId: string) => report(runId));
    const f = fixture(worker, verify);
    const task = f.create();
    f.engine.start(task.sessionId, task.id);
    await f.engine.wait(task.id);
    expect(f.get(task).state).toBe("unknown");
    expect(verify).not.toHaveBeenCalled();
    expect(() => f.engine.start(task.sessionId, task.id)).toThrow(); // No replacement for the retained unknown dispatch.
    expect(() =>
      f.engine.start(f.registered.session.id, f.create().id),
    ).toThrow(/unresolved/);
    expect(worker.run).toHaveBeenCalledTimes(1);
  });

  it("records cancellation before abort and waits for original terminal evidence", async () => {
    const stopped = deferred<TaskWorkerResult>();
    let signal: AbortSignal | undefined;
    const worker = {
      run: vi.fn<TaskWorker["run"]>(async (_input, _emit, current) => {
        signal = current;
        return stopped.promise;
      }),
    };
    const verify = vi.fn(async (_root: string, runId: string) => report(runId));
    const f = fixture(worker, verify);
    let task = f.create();
    f.engine.start(task.sessionId, task.id);
    await Promise.resolve();
    task = f.command(f.get(task), { action: "cancel" });
    f.engine.cancel(task.id);
    expect(signal!.aborted).toBe(true);
    expect(task.state).toBe("running");
    expect(() => f.engine.start(task.sessionId, f.create().id)).toThrow(
      /unresolved/,
    );
    stopped.resolve({
      outcome: "canceled",
      summary: "Original worker confirmed terminal interruption.",
    });
    await f.engine.wait(task.id);
    expect(f.get(task).state).toBe("canceled");
    expect(verify).not.toHaveBeenCalled();
  });

  it("never dispatches for expired authority and preserves a result after revocation", async () => {
    const worker = { run: vi.fn(async () => completed) };
    const f = fixture(worker);
    const task = f.create();
    f.advance(24 * 60 * 60 * 1000 + 1);
    expect(() => f.engine.start(task.sessionId, task.id)).toThrow(/expired/);
    expect(worker.run).not.toHaveBeenCalled();
  });

  it("refuses watcher dispatch after pairing revocation during the worker run", async () => {
    const done = deferred<TaskWorkerResult>();
    const f = fixture({ run: () => done.promise });
    const task = f.create();
    f.engine.start(task.sessionId, task.id);
    await Promise.resolve();
    f.store.put("pairing", {
      ...f.store.get<{ id: string }>("pairing", "pair")!,
      revokedAt: Date.now(),
    });
    done.resolve(completed);
    await f.engine.wait(task.id);
    const latest = f.get(task);
    expect(latest.runs[0]!.state).toBe("completed");
    expect(latest.verification!.state).toBe("blocked");
    expect(latest.verification!.checks[0]!.summary).toContain(
      "authority unavailable",
    );
  });

  it("does not auto-run queued context when a new engine is constructed", async () => {
    const worker = { run: vi.fn(async () => completed) };
    const f = fixture(worker);
    const task = f.create();
    const restartedLedger = new TaskLedger(f.store, f.vault);
    const service = new TaskService(f.store, f.vault, restartedLedger, {
      projectRoots: [f.directory],
      simulation: false,
    });
    const second = new TaskEngine(service, worker, [
      { name: "fixture", command: ["node", "--test"] },
    ]);
    await Promise.resolve();
    expect(worker.run).not.toHaveBeenCalled();
    expect(restartedLedger.get(task.sessionId, task.id).state).toBe("queued");
    await second.close();
  });

  it("leaves a lost verification unknown instead of reporting success", async () => {
    const f = fixture({ run: async () => completed }, async () => {
      throw new Error("synthetic lost verifier");
    });
    const task = f.create();
    f.engine.start(task.sessionId, task.id);
    await f.engine.wait(task.id);
    expect(f.get(task).state).toBe("unknown");
    expect(f.get(task).verification!.state).toBe("unknown");
    expect(() => f.engine.start(task.sessionId, f.create().id)).toThrow(
      /unresolved/,
    );
  });
});

describe("independent verification process", () => {
  it("uses actual exit status and discards raw command output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-watcher-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const verification = await runTaskVerification(
      directory,
      "run-fixture",
      [
        {
          name: "passes",
          command: [
            process.execPath,
            "-e",
            "console.log('synthetic-private-output'); process.exit(0)",
          ],
        },
        { name: "fails", command: [process.execPath, "-e", "process.exit(2)"] },
      ],
      new AbortController().signal,
    );
    expect(verification.state).toBe("failed");
    expect(verification.checks.map((check) => check.state)).toEqual([
      "passed",
      "failed",
    ]);
    expect(
      verification.checks.map((check) => check.summary).join("\n"),
    ).not.toContain("synthetic-private-output");
    expect(verification.checks[1]!.exitCode).toBe(2);
  });

  it("marks unavailable executables blocked and interrupted checks non-passing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-watcher-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const unavailable = await runTaskVerification(
      directory,
      "run-missing",
      [{ name: "missing", command: ["/no-such-clawdtime-executable"] }],
      new AbortController().signal,
    );
    expect(unavailable.state).toBe("blocked");
    const timed = await runTaskVerification(
      directory,
      "run-timeout",
      [
        {
          name: "hang",
          command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          timeoutMs: 100,
        },
      ],
      new AbortController().signal,
    );
    expect(["blocked", "unknown"]).toContain(timed.state);
    expect(timed.checks[0]!.state).not.toBe("passed");
  });
});
