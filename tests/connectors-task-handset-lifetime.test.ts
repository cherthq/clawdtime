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
    voice: true,
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

describe("handset shutdown preserves owned coding work", () => {
  it("idle shutdown refuses claimed, running, verifying and terminal-but-unsettled jobs without abort", async () => {
    const result = deferred<TaskWorkerResult>(),
      verification = deferred<TaskVerification>();
    let workerSignal: AbortSignal | undefined,
      verifySignal: AbortSignal | undefined;
    const worker = {
      run: vi.fn<TaskWorker["run"]>(async (_request, _emit, signal) => {
        workerSignal = signal;
        return result.promise;
      }),
    };
    const verify = vi.fn<typeof runTaskVerification>(
      async (_root, _run, _plan, signal) => {
        verifySignal = signal;
        return verification.promise;
      },
    );
    const f = fixture(worker, verify),
      task = f.create();
    f.engine.start(task.sessionId, task.id);
    // The durable claim exists before the worker's asynchronous invocation.
    expect(f.get(task).state).toBe("running");
    expect(f.engine.closeIfIdle()).toBe(false);
    await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(1));
    expect(workerSignal!.aborted).toBe(false);
    expect(f.engine.closeIfIdle()).toBe(false);
    result.resolve(completed);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    expect(f.get(task).state).toBe("verifying");
    expect(f.engine.closeIfIdle()).toBe(false);
    expect(verifySignal!.aborted).toBe(false);
    let terminalObserved = false;
    const transition = f.ledger.transition.bind(f.ledger);
    vi.spyOn(f.ledger, "transition").mockImplementation(
      (sessionId, taskId, command) => {
        const value = transition(sessionId, taskId, command);
        if (command.action === "verify_result") {
          expect(value.task.state).toBe("review_ready");
          terminalObserved = true;
          expect(f.engine.closeIfIdle()).toBe(false);
          expect(workerSignal!.aborted).toBe(false);
          expect(verifySignal!.aborted).toBe(false);
        }
        return value;
      },
    );
    verification.resolve(report(f.get(task).runs.at(-1)!.id));
    await f.engine.wait(task.id);
    expect(terminalObserved).toBe(true);
    expect(f.engine.closeIfIdle()).toBe(true);
    expect(workerSignal!.aborted).toBe(false);
    expect(verifySignal!.aborted).toBe(false);
    const next = f.create();
    expect(() => f.engine.start(next.sessionId, next.id)).toThrow(/stopping/);
    expect(f.get(next).state).toBe("queued");
  });
  it("an active second task prevents engine shutdown after the first task is terminal", async () => {
    const pending = deferred<TaskWorkerResult>();
    let signal: AbortSignal | undefined;
    const worker = {
      run: vi
        .fn<TaskWorker["run"]>()
        .mockResolvedValueOnce(completed)
        .mockImplementationOnce(async (_request, _emit, value) => {
          signal = value;
          return pending.promise;
        }),
    };
    const f = fixture(worker, async (_root, runId) => report(runId));
    const first = f.create();
    f.engine.start(first.sessionId, first.id);
    await f.engine.wait(first.id);
    const second = f.create();
    f.engine.start(second.sessionId, second.id);
    await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(2));
    expect(f.get(first).state).toBe("review_ready");
    expect(f.engine.closeIfIdle()).toBe(false);
    expect(signal!.aborted).toBe(false);
    pending.resolve(completed);
    await f.engine.wait(second.id);
    expect(f.engine.closeIfIdle()).toBe(true);
    expect(signal!.aborted).toBe(false);
  });
});
