import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { TaskDesktopService } from "../src/control/task-desktop-service.js";
import {
  prepareHandsetDesktop,
  prepareTaskDesktop,
  desktopConfigurationFingerprint,
} from "../src/control/task-desktop-config.js";
import { createTaskApp } from "../src/control/task-app.js";
import type {
  TaskVerification,
  TaskWorker,
  TaskWorkerResult,
} from "../src/contracts.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const completed: TaskWorkerResult = {
  outcome: "completed",
  summary: "Synthetic filter implemented.",
};
function fixture(real = false, controlsActive = false) {
  const project = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-desktop-")),
    ),
    store = new Store(),
    vault = new Vault("ab".repeat(32));
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "mac",
    recipient: "synthetic",
    conversationId: "synthetic",
    lineId: "synthetic",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const ledger = new TaskLedger(store, vault),
    service = new TaskService(store, vault, ledger, {
      projectRoots: [project],
      simulation: !real,
    });
  const registered = service.register({
    eventId: "registration",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: false,
  });
  const worker = {
    run: vi.fn<TaskWorker["run"]>().mockResolvedValue(completed),
  };
  const verify = vi.fn(
    async (_root: string, runId: string): Promise<TaskVerification> => ({
      id: `verify_${runId}`,
      runId,
      state: "passed",
      completedAt: Date.now(),
      checks: [
        {
          name: "Independent synthetic assertion",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Observed synthetic pass.",
        },
      ],
    }),
  );
  const engine = real
    ? new TaskEngine(
        service,
        worker,
        [{ name: "Synthetic check", command: ["synthetic"] }],
        verify,
      )
    : undefined;
  const config = {
    desktopId: "desktop",
    instanceId: "instance_one",
    configurationFingerprint: hash("synthetic-configuration"),
    token: "desktop-token-".repeat(4),
    sessionToken: registered.token,
    worker: real ? ("codex" as const) : ("simulation" as const),
  };
  let active = {
    controlId: controlsActive ? "owned_control" : (null as string | null),
    sharingActive: controlsActive,
    callActive: controlsActive,
    canStopSharing: controlsActive,
    canStopCall: controlsActive,
  };
  const controls = {
    snapshot: () => structuredClone(active),
    stopSharing: vi.fn(async (_controlId: string, _eventId: string) => {}),
    stopCall: vi.fn(async (_controlId: string, _eventId: string) => {}),
  };
  const desktop = new TaskDesktopService(service, engine, config, controls),
    operator = "operator-token-".repeat(4);
  const app = createTaskApp(
    service,
    operator,
    engine,
    undefined,
    undefined,
    undefined,
    desktop,
  );
  const request = (
    path: string,
    body?: unknown,
    token = config.token,
    origin?: string,
  ) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const state = () => desktop.snapshot(config.token);
  const get = (taskId: string) => ledger.get(registered.session.id, taskId);
  cleanups.push(async () => {
    await engine?.close();
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  return {
    project,
    store,
    vault,
    ledger,
    service,
    registered,
    worker,
    verify,
    engine,
    config,
    controls,
    desktop,
    operator,
    request,
    state,
    get,
    setControls: (value: typeof active) => {
      active = value;
    },
  };
}

describe("desktop capability and read-only state", () => {
  it("requires its separate UI bearer and refuses browser-origin access", async () => {
    const f = fixture();
    for (const token of ["wrong", f.operator, f.registered.token])
      expect(
        (await f.request("/desktop/state", undefined, token)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await f.request(
          "/desktop/state",
          undefined,
          f.config.token,
          "http://example.invalid",
        )
      ).status,
    ).toBe(403);
    const response = await f.request("/desktop/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 1,
      desktopId: f.config.desktopId,
      instanceId: f.config.instanceId,
      configurationFingerprint: f.config.configurationFingerprint,
      projectRoot: f.project,
      worker: "simulation",
      mode: "simulation",
      task: null,
      canSubmit: true,
    });
    expect(f.worker.run).not.toHaveBeenCalled();
  });
  it("missing operation reads are unresolved diagnostics and never create a task", async () => {
    const f = fixture();
    const result = await f.request("/desktop/operations/missing");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      eventId: "missing",
      state: "not_found",
    });
    expect(f.state().task).toBeNull();
    expect(f.worker.run).not.toHaveBeenCalled();
    expect(f.controls.stopCall).not.toHaveBeenCalled();
  });
  it("strictly rejects attempts to widen project or execution authority", async () => {
    const f = fixture();
    for (const payload of [
      {
        eventId: "extra",
        action: "submit",
        goal: "Synthetic goal",
        projectRoot: "/other",
      },
      {
        eventId: "worker",
        action: "claim_run",
        taskId: "task",
        runId: "run",
        expectedRevision: 0,
      },
      { eventId: "call", action: "start_call", controlId: "owned_control" },
      { eventId: "blank", action: "submit", goal: " " },
      { eventId: "long", action: "submit", goal: "x".repeat(8001) },
    ])
      expect(
        (await f.request("/desktop/operations", payload)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(f.state().task).toBeNull();
    expect(f.controls.stopCall).not.toHaveBeenCalled();
  });
});

describe("durable desktop task mutations", () => {
  it("simulation leaves an encrypted queued goal and recreates the panel facade without dispatch", async () => {
    const f = fixture(),
      goal = "Synthetic private desktop goal sentinel",
      input = { eventId: "submit", action: "submit", goal };
    const first = await f.desktop.submit(f.config.token, input);
    expect(first).toMatchObject({
      eventId: "submit",
      action: "submit",
      state: "done",
    });
    expect(f.state().task).toMatchObject({
      id: first.taskId,
      goal,
      state: "queued",
      checks: [],
    });
    expect(f.state().canSubmit).toBe(false);
    const restarted = new TaskDesktopService(
      f.service,
      undefined,
      { ...f.config, instanceId: "instance_two" },
      f.controls,
    );
    expect(restarted.snapshot(f.config.token).task?.id).toBe(first.taskId);
    expect(restarted.operation(f.config.token, "submit")).toEqual(first);
    expect(await restarted.submit(f.config.token, input)).toEqual(first);
    expect(f.ledger.list(f.registered.session.id)).toHaveLength(1);
    expect(f.worker.run).not.toHaveBeenCalled();
    const disk = JSON.stringify(
      f.store.db
        .prepare(
          "SELECT body FROM entities UNION ALL SELECT body FROM operational_state",
        )
        .all(),
    );
    expect(disk).not.toContain(goal);
    expect(disk).not.toContain(f.config.token);
    expect(disk).not.toContain(f.registered.token);
    await expect(
      restarted.submit(f.config.token, {
        ...input,
        goal: "Different synthetic goal",
      }),
    ).rejects.toThrow();
  });
  it("admits one real run and independently verifies it, with duplicate receipts unchanged", async () => {
    const f = fixture(true),
      terminal = deferred<TaskWorkerResult>();
    f.worker.run.mockReturnValueOnce(terminal.promise);
    cleanups.push(async () =>
      terminal.resolve({ outcome: "canceled", summary: "Test cleanup." }),
    );
    const input = {
      eventId: "real_submit",
      action: "submit",
      goal: "Add synthetic filter.",
    };
    const start = f.engine!.start.bind(f.engine);
    vi.spyOn(f.engine!, "start").mockImplementation((sessionId, taskId) => {
      expect(f.store.db.isTransaction).toBe(false);
      return start(sessionId, taskId);
    });
    const first = await f.desktop.submit(f.config.token, input);
    const taskId = first.taskId!;
    expect(first.state).toBe("done");
    expect(f.get(taskId).state).toBe("running");
    expect(f.verify).not.toHaveBeenCalled();
    expect(await f.desktop.submit(f.config.token, input)).toEqual(first);
    terminal.resolve(completed);
    await f.engine!.wait(taskId);
    expect(f.state().task).toMatchObject({
      id: taskId,
      state: "review_ready",
      canAccept: true,
    });
    expect(f.state().task?.checks).toEqual([
      {
        name: "Independent synthetic assertion",
        state: "passed",
        summary: "Observed synthetic pass.",
      },
    ]);
    expect(f.worker.run).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.desktop.operation(f.config.token, input.eventId)).toEqual(first);
  });
  it("preserves a committed task when post-commit dispatch acknowledgement is unavailable", async () => {
    const f = fixture(true);
    vi.spyOn(f.engine!, "start").mockImplementationOnce(() => {
      throw new Error("Synthetic dispatch unavailable");
    });
    const input = {
      eventId: "submit",
      action: "submit",
      goal: "Synthetic committed goal",
    };
    const operation = await f.desktop.submit(f.config.token, input);
    expect(operation.state).toBe("unknown");
    expect(f.get(operation.taskId!).state).toBe("queued");
    const restarted = new TaskDesktopService(
      f.service,
      f.engine,
      { ...f.config, instanceId: "instance_two" },
      f.controls,
    );
    expect((await restarted.submit(f.config.token, input)).state).toBe(
      "unknown",
    );
    expect(restarted.snapshot(f.config.token).canSubmit).toBe(false);
    expect(f.worker.run).not.toHaveBeenCalled();
    expect(f.ledger.list(f.registered.session.id)).toHaveLength(1);
    f.setControls({
      controlId: "owned_control",
      sharingActive: true,
      callActive: true,
      canStopSharing: true,
      canStopCall: true,
    });
    expect(
      (
        await restarted.submit(f.config.token, {
          eventId: "stop",
          action: "stop_call",
          controlId: "owned_control",
        })
      ).state,
    ).toBe("done");
    expect(f.controls.stopCall).toHaveBeenCalledTimes(1);
  });

  it("refuses stale task/run/revision and dispatches exactly one answered follow-up", async () => {
    const f = fixture(true);
    f.worker.run.mockResolvedValueOnce({
      ...completed,
      decision: "Which empty state should appear?",
    });
    const created = await f.desktop.submit(f.config.token, {
      eventId: "submit",
      action: "submit",
      goal: "Add filter",
    });
    await f.engine!.wait(created.taskId!);
    const task = f.get(created.taskId!),
      run = task.runs.at(-1)!;
    const valid = {
      eventId: "decision",
      action: "decide",
      taskId: task.id,
      runId: run.id,
      expectedRevision: task.revision,
      instruction: "Show a clear-filter button.",
    };
    for (const [label, patch] of Object.entries({
      task: { taskId: "another_task" },
      run: { runId: "another_run" },
      revision: { expectedRevision: task.revision - 1 },
    })) {
      const response = await f.desktop.submit(f.config.token, {
        ...valid,
        ...patch,
        eventId: `stale_${label}`,
      });
      expect(response.state).toBe("refused");
      expect(f.get(task.id).revision).toBe(task.revision);
    }
    expect(f.state().task?.canDecide).toBe(true);
    const changed = await f.desktop.submit(f.config.token, valid);
    expect(changed.state).toBe("done");
    await f.engine!.wait(task.id);
    expect(await f.desktop.submit(f.config.token, valid)).toEqual(changed);
    expect(f.get(task.id).state).toBe("review_ready");
    expect(f.get(task.id).runs).toHaveLength(2);
    expect(f.worker.run).toHaveBeenCalledTimes(2);
  });
  it("does not replace an active current task when two distinct submission IDs race", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.desktop.submit(f.config.token, {
        eventId: "first",
        action: "submit",
        goal: "First synthetic goal",
      }),
      f.desktop.submit(f.config.token, {
        eventId: "second",
        action: "submit",
        goal: "Second synthetic goal",
      }),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual([
      "done",
      "refused",
    ]);
    expect(f.ledger.list(f.registered.session.id)).toHaveLength(1);
    expect(f.state().task?.id).toBe(
      results.find((result) => result.state === "done")!.taskId,
    );
  });

  it("retains an unknown worker result without rerunning on polling or facade restart", async () => {
    const f = fixture(true);
    f.worker.run.mockRejectedValueOnce(
      new Error("Synthetic lost worker result"),
    );
    const operation = await f.desktop.submit(f.config.token, {
      eventId: "submit",
      action: "submit",
      goal: "Synthetic goal",
    });
    await f.engine!.wait(operation.taskId!);
    expect(f.get(operation.taskId!).state).toBe("unknown");
    const restarted = new TaskDesktopService(
      f.service,
      f.engine,
      { ...f.config, instanceId: "instance_two" },
      f.controls,
    );
    expect(restarted.snapshot(f.config.token).canSubmit).toBe(false);
    restarted.operation(f.config.token, "submit");
    restarted.snapshot(f.config.token);
    expect(
      (
        await restarted.submit(f.config.token, {
          eventId: "submit",
          action: "submit",
          goal: "Synthetic goal",
        })
      ).taskId,
    ).toBe(operation.taskId);
    expect(f.worker.run).toHaveBeenCalledTimes(1);
    expect(f.verify).not.toHaveBeenCalled();
  });

  it("accepts an independently verified result without a new run and allows a later new goal", async () => {
    const f = fixture(true),
      created = await f.desktop.submit(f.config.token, {
        eventId: "submit",
        action: "submit",
        goal: "Add filter",
      });
    await f.engine!.wait(created.taskId!);
    const task = f.get(created.taskId!),
      input = {
        eventId: "accept",
        action: "accept",
        taskId: task.id,
        runId: task.runs.at(-1)!.id,
        expectedRevision: task.revision,
      };
    expect((await f.desktop.submit(f.config.token, input)).state).toBe("done");
    expect(f.get(task.id).state).toBe("accepted");
    expect(f.state().canSubmit).toBe(true);
    expect(f.worker.run).toHaveBeenCalledTimes(1);
    const acceptedRevision = f.get(task.id).revision;
    await f.desktop.submit(f.config.token, input);
    expect(f.get(task.id).revision).toBe(acceptedRevision);
  });
  it("cancel records a request until the original worker confirms its terminal outcome", async () => {
    const f = fixture(true),
      terminal = deferred<TaskWorkerResult>();
    f.worker.run.mockReturnValueOnce(terminal.promise);
    cleanups.push(async () =>
      terminal.resolve({ outcome: "canceled", summary: "Test cleanup." }),
    );
    const created = await f.desktop.submit(f.config.token, {
        eventId: "submit",
        action: "submit",
        goal: "Add filter",
      }),
      task = f.get(created.taskId!);
    const input = {
      eventId: "cancel",
      action: "cancel",
      taskId: task.id,
      runId: task.runs.at(-1)!.id,
      expectedRevision: task.revision,
    };
    expect((await f.desktop.submit(f.config.token, input)).state).toBe("done");
    expect(f.get(task.id).state).toBe("running");
    expect(f.get(task.id).runs.at(-1)!.cancelRequested).toBe(true);
    expect(f.worker.run.mock.calls[0]![2].aborted).toBe(true);
    terminal.resolve({
      outcome: "canceled",
      summary: "Synthetic worker stopped.",
    });
    await f.engine!.wait(task.id);
    expect(f.get(task.id).state).toBe("canceled");
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.controls.stopCall).not.toHaveBeenCalled();
  });
});

describe("desktop selection and expired authority", () => {
  it("retains the newly submitted task identity even when the wall clock moves backward", async () => {
    const base = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(base + 10000);
    try {
      const f = fixture();
      const first = await f.desktop.submit(f.config.token, {
        eventId: "first",
        action: "submit",
        goal: "First synthetic goal",
      });
      const original = f.get(first.taskId!);
      await f.desktop.submit(f.config.token, {
        eventId: "cancel_first",
        action: "cancel",
        taskId: original.id,
        runId: original.runs[0]!.id,
        expectedRevision: original.revision,
      });
      clock.mockReturnValue(base);
      const second = await f.desktop.submit(f.config.token, {
        eventId: "second",
        action: "submit",
        goal: "New current synthetic goal",
      });
      expect(second.state).toBe("done");
      expect(f.state().task?.id).toBe(second.taskId);
      const restarted = new TaskDesktopService(
        f.service,
        undefined,
        { ...f.config, instanceId: "instance_two" },
        f.controls,
      );
      expect(restarted.snapshot(f.config.token).task?.id).toBe(second.taskId);
      expect(f.ledger.list(f.registered.session.id)).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["expired", "revoked"])(
    "keeps exact owned cleanup and receipt metadata available with %s task authority",
    async (kind) => {
      const f = fixture(false, true),
        goal = "Synthetic private expired-task goal";
      const operation = await f.desktop.submit(f.config.token, {
        eventId: "goal",
        action: "submit",
        goal,
      });
      const session = {
        ...f.registered.session,
        ...(kind === "expired"
          ? { expiresAt: Date.now() - 1 }
          : { revokedAt: Date.now() }),
      };
      f.store.put("task-session", {
        id: session.id,
        sealed: f.vault.seal(session),
      });
      const response = await f.request("/desktop/state");
      expect(response.status).toBe(200);
      const state = await response.json();
      expect(state).toMatchObject({
        sessionActive: false,
        task: null,
        canSubmit: false,
        controls: { canStopCall: true, canStopSharing: true },
      });
      expect(JSON.stringify(state)).not.toContain(goal);
      const receipt = await f.request("/desktop/operations/goal");
      expect(receipt.status).toBe(200);
      expect(await receipt.json()).toEqual(operation);
      const denied = await f.request("/desktop/operations", {
        eventId: "new_goal",
        action: "submit",
        goal: "Unauthorized new task",
      });
      if (denied.status === 200)
        expect((await denied.json()).state).toBe("refused");
      else expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(
        (
          await f.desktop.submit(f.config.token, {
            eventId: "cleanup",
            action: "stop_call",
            controlId: "owned_control",
          })
        ).state,
      ).toBe("done");
      expect(f.controls.stopCall).toHaveBeenCalledTimes(1);
      expect(f.ledger.list(session.id)).toHaveLength(1);
      expect(f.get(operation.taskId!).state).toBe("queued");
      expect(f.worker.run).not.toHaveBeenCalled();
    },
  );
});

describe("independent desktop Stop receipts", () => {
  it("keeps call Stop reachable while sharing Stop is pending and never cancels the task", async () => {
    const f = fixture(false, true),
      gate = deferred<void>();
    f.controls.stopSharing.mockImplementationOnce(() => gate.promise);
    await f.desktop.submit(f.config.token, {
      eventId: "goal",
      action: "submit",
      goal: "Synthetic ongoing goal",
    });
    const before = f.state().task!,
      input = {
        eventId: "sharing",
        action: "stop_sharing",
        controlId: "owned_control",
      };
    const pending = f.desktop.submit(f.config.token, input);
    await Promise.resolve();
    expect(f.desktop.operation(f.config.token, "sharing").state).toBe(
      "pending",
    );
    expect((await f.desktop.submit(f.config.token, input)).state).toBe(
      "pending",
    );
    expect(
      (
        await f.desktop.submit(f.config.token, {
          eventId: "call",
          action: "stop_call",
          controlId: "owned_control",
        })
      ).state,
    ).toBe("done");
    expect(f.controls.stopSharing).toHaveBeenCalledTimes(1);
    expect(f.controls.stopCall).toHaveBeenCalledTimes(1);
    expect(f.state().task).toEqual(before);
    gate.resolve();
    expect((await pending).state).toBe("done");
  });
  it("marks interrupted effects unknown, never replays them, and fences late completion", async () => {
    const f = fixture(false, true),
      gate = deferred<void>();
    f.controls.stopSharing.mockImplementationOnce(() => gate.promise);
    const input = {
      eventId: "interrupted",
      action: "stop_sharing",
      controlId: "owned_control",
    };
    const pending = f.desktop.submit(f.config.token, input);
    await Promise.resolve();
    expect(f.desktop.operation(f.config.token, input.eventId).state).toBe(
      "pending",
    );
    const restarted = new TaskDesktopService(
      f.service,
      f.engine,
      { ...f.config, instanceId: "instance_two" },
      f.controls,
    );
    expect(restarted.operation(f.config.token, input.eventId).state).toBe(
      "unknown",
    );
    expect((await restarted.submit(f.config.token, input)).state).toBe(
      "unknown",
    );
    expect(f.controls.stopSharing).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pending;
    expect(restarted.operation(f.config.token, input.eventId).state).toBe(
      "unknown",
    );
  });
  it("retains uncertain Stop and refuses a new operation that would repeat its external effect", async () => {
    const f = fixture(false, true);
    f.controls.stopCall.mockRejectedValueOnce(
      new Error("synthetic outcome unavailable"),
    );
    const input = {
      eventId: "stop",
      action: "stop_call",
      controlId: "owned_control",
    };
    expect((await f.desktop.submit(f.config.token, input)).state).toBe(
      "unknown",
    );
    expect((await f.desktop.submit(f.config.token, input)).state).toBe(
      "unknown",
    );
    expect(
      (
        await f.desktop.submit(f.config.token, {
          ...input,
          eventId: "new_stop",
        })
      ).state,
    ).toBe("refused");
    expect(f.controls.stopCall).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.desktop.snapshot(f.config.token))).not.toContain(
      "synthetic outcome unavailable",
    );
  });
  it("refuses foreign or unavailable controls before any effect", async () => {
    const f = fixture(false, true);
    expect(
      (
        await f.desktop.submit(f.config.token, {
          eventId: "foreign",
          action: "stop_call",
          controlId: "other_control",
        })
      ).state,
    ).toBe("refused");
    f.setControls({
      controlId: null,
      sharingActive: false,
      callActive: false,
      canStopSharing: false,
      canStopCall: false,
    });
    expect(
      (
        await f.desktop.submit(f.config.token, {
          eventId: "absent",
          action: "stop_sharing",
          controlId: "owned_control",
        })
      ).state,
    ).toBe("refused");
    expect(f.controls.stopSharing).not.toHaveBeenCalled();
    expect(f.controls.stopCall).not.toHaveBeenCalled();
  });
});

describe("handset-attached desktop scope", () => {
  it("attaches a private existing session file without registering or renewing its identity", () => {
    const f = fixture();
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-attached-session-")),
    );
    chmodSync(directory, 0o700);
    cleanups.push(async () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    const sessionPath = join(directory, "session.json");
    const sessionBytes = Buffer.from(
      JSON.stringify({
        token: f.registered.token,
        sessionId: f.registered.session.id,
      }),
    );
    writeFileSync(sessionPath, sessionBytes, { mode: 0o600 });
    const register = vi.spyOn(f.service, "register");
    const before = structuredClone(f.service.authenticate(f.registered.token));
    const input = {
      directory,
      projectRoot: f.project,
      worker: "simulation" as const,
      port: 13324,
      sessionPath,
      sessionBytes,
    };
    const first = prepareTaskDesktop(f.service, input);
    const second = prepareTaskDesktop(f.service, input);
    expect(register).not.toHaveBeenCalled();
    expect(first.config.sessionToken).toBe(f.registered.token);
    expect(second.config.sessionToken).toBe(f.registered.token);
    expect(second.config.desktopId).toBe(first.config.desktopId);
    expect(second.config.token).toBe(first.config.token);
    expect(first.config.token).not.toBe(f.registered.token);
    expect(f.service.authenticate(first.config.sessionToken)).toEqual(before);
    expect(first.config.configurationFingerprint).toBe(
      desktopConfigurationFingerprint({
        projectRoot: f.project,
        worker: "simulation",
        port: 13324,
        checksFingerprint: null,
        sessionFingerprint: hash(sessionBytes.toString("utf8")),
      }),
    );
    const bindingBefore = readFileSync(
      join(directory, "desktop-binding.json"),
      "utf8",
    );
    const panelBefore = readFileSync(first.descriptor.panelConfigPath, "utf8");
    expect(bindingBefore).not.toContain(f.registered.token);
    expect(panelBefore).not.toContain(f.registered.token);
    writeFileSync(
      sessionPath,
      JSON.stringify({ token: f.registered.token, changedMetadata: true }),
      { mode: 0o600 },
    );
    expect(() =>
      prepareTaskDesktop(f.service, { ...input, sessionBytes: undefined }),
    ).toThrow(/configuration differs/);
    expect(readFileSync(join(directory, "desktop-binding.json"), "utf8")).toBe(
      bindingBefore,
    );
    expect(readFileSync(first.descriptor.panelConfigPath, "utf8")).toBe(
      panelBefore,
    );
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses an existing session from another project before writing a desktop binding", () => {
    const f = fixture();
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-wrong-session-project-")),
    );
    chmodSync(directory, 0o700);
    cleanups.push(async () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    const sessionPath = join(directory, "session.json");
    writeFileSync(sessionPath, JSON.stringify({ token: f.registered.token }), {
      mode: 0o600,
    });
    const register = vi.spyOn(f.service, "register");
    expect(() =>
      prepareTaskDesktop(f.service, {
        directory,
        projectRoot: join(f.project, "other-project"),
        worker: "simulation",
        port: 13324,
        sessionPath,
      }),
    ).toThrow(/another project/);
    expect(() =>
      readFileSync(join(directory, "desktop-binding.json")),
    ).toThrow();
    expect(() => readFileSync(join(directory, "desktop-panel.json"))).toThrow();
    expect(register).not.toHaveBeenCalled();
  });

  it("preserves exact cleanup admission when the durable task-operation history is full", async () => {
    const f = fixture(false, true);
    const records = new ProtectedTaskStore<{
      id: string;
      sessionId: string;
      desktopId: string;
      instanceId: string;
      fingerprint: string;
      createdAt: number;
      eventId: string;
      action: "submit";
      state: "refused";
      message: string;
    }>(f.store, f.vault, "coding-desktop-operation-v1");
    f.store.transaction(() => {
      for (let i = 0; i < 4096; i++)
        records.put({
          id: `capacity_${i}`,
          sessionId: f.registered.session.id,
          desktopId: f.config.desktopId,
          instanceId: f.config.instanceId,
          fingerprint: hash(`capacity_${i}`),
          createdAt: i,
          eventId: `capacity_${i}`,
          action: "submit",
          state: "refused",
          message: "Synthetic refused admission",
        });
    });
    await expect(
      f.desktop.submit(f.config.token, {
        eventId: "over_capacity",
        action: "submit",
        goal: "Another task",
      }),
    ).rejects.toThrow(/capacity/);
    expect(records.all()).toHaveLength(4096);
    for (const action of ["stop_sharing", "stop_call"] as const) {
      const command = {
        eventId: `full_${action}`,
        action,
        controlId: "owned_control",
      };
      expect((await f.desktop.submit(f.config.token, command)).state).toBe(
        "done",
      );
      expect((await f.desktop.submit(f.config.token, command)).state).toBe(
        "done",
      );
    }
    expect(f.controls.stopSharing).toHaveBeenCalledTimes(1);
    expect(f.controls.stopCall).toHaveBeenCalledTimes(1);
    expect(f.ledger.list(f.registered.session.id)).toHaveLength(0);
  });

  it("refuses stale task actions after owner retirement while retaining exact cleanup controls", async () => {
    const f = fixture(false, true);
    let available = true;
    const task = f.service.create(f.registered.token, {
      eventId: "retirement_task",
      goal: "Keep the original task",
    }).task;
    const desktop = new TaskDesktopService(
      f.service,
      undefined,
      f.config,
      f.controls,
      () => available,
    );
    expect(desktop.snapshot(f.config.token).task?.canCancel).toBe(true);
    available = false;
    const snapshot = desktop.snapshot(f.config.token);
    expect(snapshot.canSubmit).toBe(false);
    expect(snapshot.task).toMatchObject({
      canCancel: false,
      canAccept: false,
      canDecide: false,
    });
    for (const action of ["cancel", "accept", "decide"] as const) {
      expect(
        (
          await desktop.submit(f.config.token, {
            eventId: `retired_${action}`,
            action,
            taskId: task.id,
            runId: task.runs[0]!.id,
            expectedRevision: task.revision,
            ...(action === "decide" ? { instruction: "A late change" } : {}),
          })
        ).state,
      ).toBe("refused");
    }
    expect(
      (
        await desktop.submit(f.config.token, {
          eventId: "retired_submit",
          action: "submit",
          goal: "Late goal",
        })
      ).state,
    ).toBe("refused");
    expect(f.get(task.id)).toEqual(task);
    expect(f.ledger.list(f.registered.session.id)).toHaveLength(1);
    for (const action of ["stop_sharing", "stop_call"] as const)
      expect(
        (
          await desktop.submit(f.config.token, {
            eventId: `retired_${action}`,
            action,
            controlId: "owned_control",
          })
        ).state,
      ).toBe("done");
    expect(f.controls.stopSharing).toHaveBeenCalledExactlyOnceWith(
      "owned_control",
      "retired_stop_sharing",
    );
    expect(f.controls.stopCall).toHaveBeenCalledExactlyOnceWith(
      "owned_control",
      "retired_stop_call",
    );
    expect(f.worker.run).not.toHaveBeenCalled();
  });

  it("pins the existing task and refuses other tasks or new submission even after cancellation", async () => {
    const f = fixture();
    const bound = f.service.create(f.registered.token, {
      eventId: "bound",
      goal: "Bound synthetic task",
    }).task;
    const other = f.service.create(f.registered.token, {
      eventId: "other",
      goal: "Other synthetic task",
    }).task;
    const desktop = new TaskDesktopService(
      f.service,
      undefined,
      {
        ...f.config,
        desktopId: "attached",
        token: "attached-token-".repeat(4),
        boundTaskId: bound.id,
      },
      f.controls,
    );
    const token = "attached-token-".repeat(4);
    expect(desktop.snapshot(token).task?.id).toBe(bound.id);
    expect(desktop.snapshot(token).canSubmit).toBe(false);
    for (const action of ["cancel", "accept", "decide"]) {
      const response = await desktop.submit(token, {
        eventId: `foreign_${action}`,
        action,
        taskId: other.id,
        runId: other.runs[0]!.id,
        expectedRevision: other.revision,
        ...(action === "decide" ? { instruction: "A synthetic change" } : {}),
      });
      expect(response.state).toBe("refused");
    }
    expect(f.get(other.id).revision).toBe(other.revision);
    expect(
      (
        await desktop.submit(token, {
          eventId: "new_goal",
          action: "submit",
          goal: "Forbidden third task",
        })
      ).state,
    ).toBe("refused");
    expect(
      (
        await desktop.submit(token, {
          eventId: "cancel_bound",
          action: "cancel",
          taskId: bound.id,
          runId: bound.runs[0]!.id,
          expectedRevision: bound.revision,
        })
      ).state,
    ).toBe("done");
    expect(desktop.snapshot(token).task?.state).toBe("canceled");
    expect(desktop.snapshot(token).canSubmit).toBe(false);
    expect(
      (
        await desktop.submit(token, {
          eventId: "after_cancel",
          action: "submit",
          goal: "Still forbidden",
        })
      ).state,
    ).toBe("refused");
    expect(f.ledger.list(f.registered.session.id)).toHaveLength(2);
    expect(f.worker.run).not.toHaveBeenCalled();
  });

  it("writes a separate private UI capability for the same task/session without registration", () => {
    const f = fixture(),
      task = f.service.create(f.registered.token, {
        eventId: "bound",
        goal: "Bound synthetic task",
      }).task;
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-handset-panel-")),
    );
    chmodSync(directory, 0o700);
    cleanups.push(async () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    const register = vi.spyOn(f.service, "register"),
      before = f.store.all("task-session").length;
    const prepared = prepareHandsetDesktop(f.service, {
      directory,
      sessionToken: f.registered.token,
      taskId: task.id,
      attemptId: "synthetic_attempt",
      worker: "simulation",
    });
    expect(register).not.toHaveBeenCalled();
    expect(f.store.all("task-session")).toHaveLength(before);
    expect(prepared.config.sessionToken).toBe(f.registered.token);
    expect(prepared.config.boundTaskId).toBe(task.id);
    expect(prepared.config.token).not.toBe(f.registered.token);
    expect(prepared.config.token).not.toBe(f.config.token);
    const bytes = readFileSync(prepared.panelConfigPath, "utf8"),
      panel = JSON.parse(bytes);
    expect(panel).toMatchObject({
      version: 1,
      origin: "http://127.0.0.1:13323",
      projectRoot: f.project,
      boundTaskId: task.id,
      token: prepared.config.token,
      configurationFingerprint: prepared.config.configurationFingerprint,
    });
    expect(bytes).not.toContain(f.registered.token);
    expect(bytes).not.toContain(task.goal);
    expect(statSync(prepared.panelConfigPath).mode & 0o077).toBe(0);
    expect(statSync(panel.receiptDirectory).mode & 0o077).toBe(0);
    const desktop = new TaskDesktopService(
      f.service,
      undefined,
      prepared.config,
    );
    expect(desktop.snapshot(prepared.config.token).task?.id).toBe(task.id);
    expect(() =>
      prepareHandsetDesktop(f.service, {
        directory,
        sessionToken: f.registered.token,
        taskId: task.id,
        attemptId: "synthetic_attempt",
        worker: "simulation",
      }),
    ).toThrow();
    expect(readFileSync(prepared.panelConfigPath, "utf8")).toBe(bytes);
  });

  it("refuses foreign-session task attachment before creating private panel files", () => {
    const f = fixture(),
      other = f.service.register({
        eventId: "other-session",
        pairingId: "pair",
        hostId: "host",
        projectRoot: f.project,
        voice: false,
      });
    const task = f.service.create(other.token, {
      eventId: "other-task",
      goal: "Other session task",
    }).task;
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-handset-panel-")),
    );
    cleanups.push(async () =>
      rmSync(directory, { recursive: true, force: true }),
    );
    expect(() =>
      prepareHandsetDesktop(f.service, {
        directory,
        sessionToken: f.registered.token,
        taskId: task.id,
        attemptId: "synthetic_attempt",
        worker: "simulation",
      }),
    ).toThrow();
    expect(
      () =>
        new TaskDesktopService(f.service, undefined, {
          ...f.config,
          boundTaskId: task.id,
        }),
    ).toThrow();
    expect(() => readFileSync(join(directory, "desktop-panel.json"))).toThrow();
  });
});
