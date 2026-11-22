import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackgroundRuntime,
  type BackgroundTaskContext,
  type BackgroundTaskWorker,
} from "../src/control/background-runtime.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { LineRuntime } from "../src/control/line-runtime.js";
import type { BackgroundPreview } from "../src/control/background-preview.js";

const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
afterEach(async () => {
  vi.useRealTimers();
  releases.splice(0).forEach((release) => release());
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type SavedRecord = {
  id: string;
  state: string;
  actions: Array<{ id: string; state: string; fingerprint: string }>;
};
function fixture(timeoutMs = 30_000) {
  const store = new Store();
  const vault = new Vault("9".repeat(64));
  const worker = {
    run: vi.fn<BackgroundTaskWorker["run"]>(async (_goal, context) => {
      const id = context.reserve({
        type: "fixture-edit",
        text: "Private fixture draft",
      });
      context.returned(id, "returned");
      context.verified(id);
      return {
        verified: true,
        summary: "Independent fixture postcondition observed",
      };
    }),
    stop: vi.fn<BackgroundTaskWorker["stop"]>(() => {}),
    close: vi.fn<BackgroundTaskWorker["close"]>(async () => ({
      quiescence: "known",
    })),
    preview: vi.fn(async (): Promise<BackgroundPreview | null> => null),
  };
  let live = true;
  const authority = {
    callId: "fixture_call",
    toolCallId: "fixture_tool",
    isLive: () => live,
  };
  const create = vi.fn(() => worker);
  const notify = vi.fn();
  const runtime = new BackgroundRuntime(
    store,
    vault,
    create,
    timeoutMs,
    notify,
  );
  cleanups.push(async () => {
    await runtime.close();
    store.close();
  });
  return {
    store,
    vault,
    worker,
    create,
    notify,
    runtime,
    authority,
    revokeCall: () => {
      live = false;
    },
    submit: (id: string, goal: string) => runtime.submit(id, goal, authority),
    records: new ProtectedTaskStore<SavedRecord>(
      store,
      vault,
      "background-cua-task-v1",
    ),
  };
}

describe("background runtime recovery and admission", () => {
  it("drops a preview that finishes after Stop even when its producer still reports valid", async () => {
    const f = fixture();
    const work = gate();
    const capture = gate();
    f.worker.run.mockImplementation(async () => {
      await work.promise;
      return { verified: false, summary: "Stopped" };
    });
    f.worker.preview.mockImplementation(async () => {
      await capture.promise;
      // The runtime must enforce task lifetime independently of the producer.
      return { valid: () => true } as BackgroundPreview;
    });
    await f.submit("task_one", "Read fixture");
    await vi.waitFor(() => expect(f.worker.run).toHaveBeenCalledOnce());
    const pending = f.runtime.preview("fixture_call", "task_one");
    await vi.waitFor(() => expect(f.worker.preview).toHaveBeenCalledOnce());
    f.runtime.stop();
    capture.release();
    expect(await pending).toBeNull();
    expect(await f.runtime.preview("fixture_call", "task_one")).toBeNull();
    expect(f.worker.preview).toHaveBeenCalledOnce();
    work.release();
    await f.runtime.waitForIdle();
  });

  it("receives exact trusted call and tool identity from the real bridge and revokes it synchronously on hangup", async () => {
    const f = fixture();
    const pending = gate();
    let context!: BackgroundTaskContext;
    f.worker.run.mockImplementation(async (_goal, current) => {
      context = current;
      await pending.promise;
      expect(current.isLive()).toBe(false);
      return { verified: false, summary: "Call ended" };
    });
    const capability = "test-background-line-token-".repeat(2);
    const bridge = new LineRuntime(f.store, f.vault, capability, f.runtime);
    const command = (action: string, extra = {}) =>
      bridge.command(capability, {
        action,
        callId: "admitted_fixture_call",
        ...extra,
      });
    await command("open");
    await command("execute", {
      requestId: "trusted_tool_call",
      text: "Read fixture",
    });
    await vi.waitFor(() => expect(context).toBeDefined());
    expect(context.callId).toBe("admitted_fixture_call");
    expect(context.toolCallId).toBe("trusted_tool_call");
    expect(context.isLive()).toBe(true);
    await command("close");
    expect(context.isLive()).toBe(false);
    expect(() => context.reserve({ type: "late" })).toThrow();
    pending.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("canceled");
    await expect(command("open")).rejects.toThrow("ended");
  });

  it("blocks desktop submissions with no admitted call and preserves the original authority identity", async () => {
    const f = fixture();
    await f.runtime.submit("desktop", "Edit fixture");
    expect(f.runtime.snapshot("desktop").state).toBe("blocked");
    expect(f.create).not.toHaveBeenCalled();
    await f.submit("task_one", "Edit fixture");
    await f.runtime.waitForIdle();
    const context = f.worker.run.mock.calls[0]![1];
    expect(context.callId).toBe("fixture_call");
    expect(context.toolCallId).toBe("fixture_tool");
    await expect(
      f.runtime.submit("task_one", "Edit fixture", {
        ...f.authority,
        callId: "other_call",
      }),
    ).rejects.toThrow("conflicts");
    await expect(
      f.runtime.submit("task_one", "Edit fixture", {
        ...f.authority,
        toolCallId: "other_tool",
      }),
    ).rejects.toThrow("conflicts");
    expect(f.worker.run).toHaveBeenCalledTimes(1);
  });

  it("rechecks live call authority after asynchronous work before reserve, verification and completion", async () => {
    const f = fixture();
    const pending = gate();
    let context!: BackgroundTaskContext;
    let actionId!: string;
    f.worker.run.mockImplementation(async (_goal, current) => {
      context = current;
      actionId = context.reserve({ type: "fixture" });
      context.returned(actionId, "returned");
      await pending.promise;
      expect(context.isLive()).toBe(false);
      expect(() => context.reserve({ type: "late-effect" })).toThrow();
      expect(() => context.verified(actionId)).toThrow();
      return {
        verified: true,
        summary: "Late completion must not reopen authority",
      };
    });
    await f.submit("task_one", "Edit fixture");
    await vi.waitFor(() => expect(actionId).toBeDefined());
    f.revokeCall();
    pending.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    expect(context.isLive()).toBe(false);
  });

  it("does not create a worker when the call closes after queueing", async () => {
    const f = fixture();
    const submitted = f.submit("task_one", "Read fixture");
    f.revokeCall();
    await submitted;
    await f.runtime.waitForIdle();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).toBe("blocked");
  });

  it("settles Stop as canceled when later authoritative evidence proves no input began and cleanup is known", async () => {
    const f = fixture();
    const pending = gate();
    f.worker.run.mockImplementation(async (_goal, context) => {
      const id = context.reserve({ type: "fixture" });
      await pending.promise;
      context.returned(id, "not_started");
      return { verified: false, summary: "Refused before input" };
    });
    await f.submit("task_one", "Edit fixture");
    await vi.waitFor(() =>
      expect(f.records.get("task_one")?.actions).toHaveLength(1),
    );
    expect(f.runtime.stop().state).toBe("uncertain");
    pending.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("canceled");
    expect(f.records.get("task_one")?.actions[0]?.state).toBe("not_started");
  });

  it("requires independent verification and known cleanup, encrypts receipts, and never replays an identity", async () => {
    const f = fixture();
    await f.submit("task_one", "Private fixture goal");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot("task_one").state).toBe("completed");
    expect(f.records.get("task_one")?.actions[0]?.state).toBe("verified");
    const disk = JSON.stringify(f.store.all("background-cua-task-v1"));
    expect(disk).not.toContain("Private fixture");
    expect(disk).not.toContain("fixture-edit");
    await f.submit("task_one", "Private fixture goal");
    await expect(f.submit("task_one", "Changed goal")).rejects.toThrow(
      "conflicts",
    );
    expect(f.worker.run).toHaveBeenCalledTimes(1);
  });

  it.each(["reserved", "returned", "unknown"] as const)(
    "does not let a worker success claim settle an effect left %s",
    async (state) => {
      const f = fixture();
      f.worker.run.mockImplementation(async (_goal, context) => {
        const id = context.reserve({ type: "fixture" });
        if (state !== "reserved") context.returned(id, state);
        return { verified: true, summary: "Unsupported success claim" };
      });
      await f.submit("task_one", "Edit fixture");
      await f.runtime.waitForIdle();
      expect(f.runtime.snapshot("task_one").state).toBe("uncertain");
      expect(f.records.get("task_one")?.actions[0]?.state).toBe("unknown");
      await f.submit("task_two", "Another edit");
      expect(f.runtime.snapshot("task_two").state).toBe("blocked");
      expect(f.worker.run).toHaveBeenCalledTimes(1);
    },
  );

  it("does not publish completion when exact driver cleanup is unknown", async () => {
    const f = fixture();
    f.worker.close.mockResolvedValue({ quiescence: "unknown" });
    await f.submit("task_one", "Edit fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]?.[0]).toContain("uncertain");
  });

  it("refuses a second reservation or premature verification while prior input is unresolved", async () => {
    const f = fixture();
    f.worker.run.mockImplementation(async (_goal, context) => {
      const id = context.reserve({ type: "fixture" });
      expect(() => context.reserve({ type: "another" })).toThrow("unresolved");
      expect(() => context.verified(id)).toThrow();
      context.returned(id, "not_started");
      expect(() => context.returned(id, "returned")).toThrow();
      expect(() => context.verified(id)).toThrow();
      return { verified: false, summary: "Input refused before dispatch" };
    });
    await f.submit("task_one", "Edit fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("blocked");
    expect(f.records.get("task_one")?.actions[0]?.state).toBe("not_started");
  });

  it("Stop before queued startup never creates a worker or posts input", async () => {
    const f = fixture();
    const submitted = f.submit("task_one", "Edit fixture");
    f.runtime.stop();
    await submitted;
    await f.runtime.waitForIdle();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).toBe("canceled");
  });

  it("keeps Stop during input uncertain despite a late successful transport result", async () => {
    const f = fixture();
    const input = gate();
    f.worker.run.mockImplementation(async (_goal, context) => {
      const id = context.reserve({ type: "fixture" });
      await input.promise;
      context.returned(id, "returned");
      expect(() => context.verified(id)).toThrow();
      return { verified: true, summary: "Late input return is not success" };
    });
    await f.submit("task_one", "Edit fixture");
    await vi.waitFor(() =>
      expect(f.records.get("task_one")?.actions).toHaveLength(1),
    );
    expect(f.runtime.stop().state).toBe("uncertain");
    input.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    expect(f.records.get("task_one")?.actions[0]?.state).toBe("unknown");
  });

  it("reserves a durable blocked result during cleanup, then admits a distinct later request", async () => {
    const f = fixture();
    const cleanup = gate();
    f.worker.close.mockImplementationOnce(async () => {
      await cleanup.promise;
      return { quiescence: "known" };
    });
    await f.submit("task_one", "Edit fixture");
    await vi.waitFor(() => expect(f.worker.close).toHaveBeenCalledTimes(1));
    f.runtime.stop();
    await f.submit("task_two", "Edit another fixture");
    expect(f.runtime.snapshot("task_two").state).toBe("blocked");
    cleanup.release();
    await f.runtime.waitForIdle();
    await f.submit("task_two", "Edit another fixture");
    expect(f.worker.run).toHaveBeenCalledTimes(1);
    await f.submit("task_three", "A new fixture edit");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot("task_three").state).toBe("completed");
    expect(f.worker.run).toHaveBeenCalledTimes(2);
  });

  it("closes receipt admission as soon as the worker finishes, while cleanup is pending", async () => {
    const f = fixture();
    const cleanup = gate();
    let context!: BackgroundTaskContext;
    f.worker.run.mockImplementation(async (_goal, current) => {
      context = current;
      return { verified: true, summary: "Read-only fixture observed" };
    });
    f.worker.close.mockImplementationOnce(async () => {
      await cleanup.promise;
      return { quiescence: "known" };
    });
    await f.submit("task_one", "Read fixture");
    await vi.waitFor(() => expect(f.worker.close).toHaveBeenCalledTimes(1));
    expect(() => context.reserve({ type: "late-effect" })).toThrow();
    cleanup.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("completed");
    expect(f.records.get("task_one")?.actions).toHaveLength(0);
  });

  it("contains a throwing worker Stop and still completes cleanup without input", async () => {
    const f = fixture();
    const work = gate();
    f.worker.run.mockImplementation(async () => {
      await work.promise;
      return { verified: false, summary: "Stopped" };
    });
    f.worker.stop.mockImplementation(() => {
      throw Error("stop transport failed");
    });
    await f.submit("task_one", "Read fixture");
    await vi.waitFor(() => expect(f.worker.run).toHaveBeenCalledTimes(1));
    expect(() => f.runtime.stop()).not.toThrow();
    work.release();
    await f.runtime.waitForIdle();
    expect(f.worker.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("a durable restart retains unknown receipts and does not restore worker or task authority", async () => {
    const f = fixture();
    const input = gate();
    f.worker.run.mockImplementation(async (_goal, context) => {
      context.reserve({ type: "fixture" });
      await input.promise;
      return { verified: false, summary: "Interrupted" };
    });
    await f.submit("task_one", "Edit fixture");
    await vi.waitFor(() =>
      expect(f.records.get("task_one")?.actions).toHaveLength(1),
    );
    const recoveredStore = new Store();
    for (const row of f.store.all<{ id: string; ciphertext: string }>(
      "background-cua-task-v1",
    ))
      recoveredStore.put("background-cua-task-v1", row);
    const create = vi.fn(() => f.worker);
    const recovered = new BackgroundRuntime(recoveredStore, f.vault, create);
    cleanups.push(async () => {
      await recovered.close();
      recoveredStore.close();
    });
    expect(recovered.snapshot("task_one").state).toBe("uncertain");
    await recovered.submit("task_one", "Edit fixture", f.authority);
    await recovered.submit("task_two", "A new edit", f.authority);
    expect(recovered.snapshot("task_two").state).toBe("blocked");
    expect(create).not.toHaveBeenCalled();
    input.release();
    await f.runtime.waitForIdle();
  });

  it("timeout aborts the worker and contains a throwing Stop callback", async () => {
    vi.useFakeTimers();
    const f = fixture(1000);
    f.worker.run.mockImplementation(
      async (_goal, _context, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ verified: false, summary: "Deadline reached" }),
            { once: true },
          );
        }),
    );
    f.worker.stop.mockImplementation(() => {
      throw Error("stop callback failed");
    });
    await f.submit("task_one", "Read fixture");
    await Promise.resolve();
    expect(f.worker.run).toHaveBeenCalledTimes(1);
    await expect(vi.advanceTimersByTimeAsync(1001)).resolves.not.toThrow();
    await f.runtime.waitForIdle();
    expect(f.worker.close).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });
});
