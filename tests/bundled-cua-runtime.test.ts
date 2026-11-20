import { afterEach, describe, expect, it, vi } from "vitest";
import { BundledCuaRuntime } from "../src/control/bundled-cua-runtime.js";
import {
  CuaSetupRequired,
  bundledCuaConfigSchema,
  CuaInputNotDispatched,
  type CuaAction,
  type CuaDevice,
  type CuaObservation,
  type CuaPlan,
  type CuaPlanner,
} from "../src/control/cua-contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";

const action: CuaAction = { type: "type", text: "fixture only" };
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
  releases.splice(0).forEach((release) => release());
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(
  options: {
    allowed?: boolean;
    maxSteps?: number;
    windowCatalog?: boolean;
  } = {},
) {
  const store = new Store();
  const vault = new Vault("7".repeat(64));
  let now = 1_000_000;
  let capture = 0;
  let effects = 0;
  const observation = (): CuaObservation => ({
    id: `frame_${++capture}`,
    capturedAt: now,
    width: 800,
    height: 600,
    imageDataUrl: "data:image/png;base64,PRIVATE_TRANSIENT_PIXELS",
    fingerprint: `surface_${effects}`,
    context: options.windowCatalog
      ? JSON.stringify({
          windows: {
            untrusted: true,
            windows: [
              {
                id: "window_1",
                app: "Fixture App",
                title: "Existing fixture window",
              },
            ],
          },
        })
      : "Disposable fixture",
  });
  const device = {
    open: vi.fn<CuaDevice["open"]>(async () => {}),
    observe: vi.fn<CuaDevice["observe"]>(async () => observation()),
    authorize: vi.fn<CuaDevice["authorize"]>(async () =>
      options.allowed ? "allowed" : "confirm",
    ),
    execute: vi.fn<CuaDevice["execute"]>(async () => {
      effects++;
    }),
    stop: vi.fn<CuaDevice["stop"]>(async () => {}),
  };
  const planner = {
    plan: vi.fn<CuaPlanner["plan"]>(
      async ({ observation: frame, previousActions }) =>
        previousActions.length
          ? {
              kind: "done",
              observationId: frame.id,
              summary: "Fixture updated",
            }
          : {
              kind: "action",
              observationId: frame.id,
              action,
              description: "Type into the disposable fixture",
            },
    ),
    verify: vi.fn<CuaPlanner["verify"]>(async () => ({
      verified: true,
      summary: "Observed fixture update",
    })),
  };
  const config = bundledCuaConfigSchema.parse({
    version: 1,
    mode: "browser",
    model: "fixture-model",
    timeoutMs: 10_000,
    maxSteps: options.maxSteps ?? 6,
    browser: {
      startUrl: "http://127.0.0.1:8767",
      allowedOrigins: ["http://127.0.0.1:8767"],
      fixtureGrants: [],
      headless: true,
    },
  });
  const notify = vi.fn();
  const createDevice = vi.fn(() => device);
  const runtime = new BundledCuaRuntime(
    store,
    vault,
    config,
    planner,
    createDevice,
    notify,
    () => now,
  );
  cleanups.push(async () => {
    await runtime.close();
    store.close();
  });
  return {
    runtime,
    store,
    vault,
    config,
    device,
    planner,
    notify,
    createDevice,
    observation,
    advance: (ms: number) => {
      now += ms;
    },
    effects: () => effects,
  };
}
async function pending(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() =>
    expect(f.runtime.snapshot().pendingAction).toBeDefined(),
  );
  return f.runtime.snapshot().pendingAction!;
}

describe("app-owned CUA task engine", () => {
  it("waits for the exact action decision and does not treat model prose as approval", async () => {
    const f = fixture();
    await f.runtime.submit(
      "task_1",
      "Type fixture only into the disposable page",
    );
    const request = await pending(f);
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(() => f.runtime.decision("wrong_action", true)).toThrow();
    expect(f.device.execute).not.toHaveBeenCalled();
    f.runtime.decision(request.id, true);
    await f.runtime.waitForIdle();
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot().state).toBe("completed");
    expect(f.planner.verify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalled();
  });

  it("runs adapter-authorized fixture effects without another confirmation and verifies fresh results", async () => {
    const f = fixture({ allowed: true });
    await f.runtime.submit("task_1", "Update the fixture");
    await f.runtime.waitForIdle();
    expect(f.effects()).toBe(1);
    expect(f.runtime.snapshot().pendingAction).toBeUndefined();
    expect(f.runtime.snapshot().state).toBe("completed");
    const done = f.planner.plan.mock.calls.at(-1)![0].observation;
    const verified = f.planner.verify.mock.calls[0]![0].observation;
    expect(verified.id).not.toBe(done.id);
    expect(verified.fingerprint).toBe("surface_1");
    expect(JSON.stringify(f.store.all("bundled-cua-task-v1"))).not.toContain(
      "PRIVATE_TRANSIENT_PIXELS",
    );
  });

  it("denies an action without submitting input", async () => {
    const f = fixture();
    await f.runtime.submit("task_1", "Update fixture");
    f.runtime.decision((await pending(f)).id, false);
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("does not allow stale approval to authorize a changed surface", async () => {
    const f = fixture();
    await f.runtime.submit("task_1", "Update fixture");
    const request = await pending(f);
    f.device.observe.mockImplementation(async () => ({
      ...f.observation(),
      fingerprint: "changed_target",
    }));
    f.runtime.decision(request.id, true);
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("uses trusted target revalidation for changed pixels without bypassing exact approval", async () => {
    const f = fixture();
    f.device.observe.mockImplementation(async () => {
      const frame = f.observation();
      return { ...frame, fingerprint: `changing_background_${frame.id}` };
    });
    const revalidate = vi.fn<NonNullable<CuaDevice["revalidate"]>>(
      async () => true,
    );
    (f.device as CuaDevice).revalidate = revalidate;
    await f.runtime.submit("task_1", "Update fixture");
    const request = await pending(f);
    expect(f.device.execute).not.toHaveBeenCalled();
    f.runtime.decision(request.id, true);
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("completed");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls.length).toBeGreaterThanOrEqual(2);
    const original = f.planner.plan.mock.calls[0]![0].observation.id;
    expect(revalidate.mock.calls[0]![1].id).toBe(original);
    expect(revalidate.mock.calls[1]![1].id).toBe(original);
    expect(revalidate.mock.calls[1]![2].id).not.toBe(
      revalidate.mock.calls[0]![2].id,
    );
  });

  it("never asks for approval or dispatches when changed-target revalidation is refused", async () => {
    const f = fixture();
    f.device.observe.mockImplementation(async () => {
      const frame = f.observation();
      return { ...frame, fingerprint: frame.id };
    });
    (f.device as CuaDevice).revalidate = vi.fn(async () => false);
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().pendingAction).toBeUndefined();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("discards an exact approval if final target revalidation is refused", async () => {
    const f = fixture();
    f.device.observe.mockImplementation(async () => {
      const frame = f.observation();
      return { ...frame, fingerprint: frame.id };
    });
    const revalidate = vi
      .fn<NonNullable<CuaDevice["revalidate"]>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    (f.device as CuaDevice).revalidate = revalidate;
    await f.runtime.submit("task_1", "Update fixture");
    f.runtime.decision((await pending(f)).id, true);
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("does not accept a target proof arriving after Stop", async () => {
    const f = fixture({ allowed: true });
    f.device.observe.mockImplementation(async () => {
      const frame = f.observation();
      return { ...frame, fingerprint: frame.id };
    });
    const held = gate();
    const revalidate = vi.fn<NonNullable<CuaDevice["revalidate"]>>(async () => {
      await held.promise;
      return true;
    });
    (f.device as CuaDevice).revalidate = revalidate;
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalled());
    f.runtime.stop();
    held.release();
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("requires activation proof even when the screen fingerprints are identical", async () => {
    const f = fixture({ allowed: true });
    f.planner.plan.mockImplementation(
      async ({ observation }): Promise<CuaPlan> => ({
        kind: "action",
        observationId: observation.id,
        action: { type: "activate", targetId: "window_1" },
        description: "Activate existing fixture window",
      }),
    );
    await f.runtime.submit(
      "task_1",
      "Bring the existing fixture window forward",
    );
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().pendingAction).toBeUndefined();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("requires an exact approval and a second proof for activation on unchanged pixels", async () => {
    const f = fixture({ windowCatalog: true });
    f.planner.plan.mockImplementation(
      async ({ observation, previousActions }): Promise<CuaPlan> =>
        previousActions.length
          ? {
              kind: "done",
              observationId: observation.id,
              summary: "Existing window is visible",
            }
          : {
              kind: "action",
              observationId: observation.id,
              action: { type: "activate", targetId: "window_1" },
              description: "Activate fixture window",
            },
    );
    const revalidate = vi.fn<NonNullable<CuaDevice["revalidate"]>>(
      async () => true,
    );
    (f.device as CuaDevice).revalidate = revalidate;
    await f.runtime.submit(
      "task_1",
      "Bring the existing fixture window forward",
    );
    const request = await pending(f);
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(request.description).toContain("Existing fixture window");
    expect(request.description).toContain("Fixture App");
    expect(request.description).toContain("window_1");
    f.runtime.decision(request.id, true);
    await f.runtime.waitForIdle();
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(f.device.execute).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: { type: "activate", targetId: "window_1" },
      }),
      expect.any(AbortSignal),
    );
    expect(f.runtime.snapshot().state).toBe("completed");
  });

  it("cannot reuse the pre-approval activation proof when final proof is refused", async () => {
    const f = fixture({ windowCatalog: true });
    f.planner.plan.mockImplementation(
      async ({ observation }): Promise<CuaPlan> => ({
        kind: "action",
        observationId: observation.id,
        action: { type: "activate", targetId: "window_1" },
        description: "Activate existing fixture window",
      }),
    );
    const revalidate = vi
      .fn<NonNullable<CuaDevice["revalidate"]>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    (f.device as CuaDevice).revalidate = revalidate;
    await f.runtime.submit(
      "task_1",
      "Bring the existing fixture window forward",
    );
    f.runtime.decision((await pending(f)).id, true);
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("refuses a stale frame before dispatch", async () => {
    const f = fixture({ allowed: true });
    f.device.observe.mockImplementation(async () => ({
      ...f.observation(),
      capturedAt: 1,
    }));
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("fences a planner result that arrives after Stop", async () => {
    const f = fixture({ allowed: true });
    const held = gate();
    f.planner.plan.mockImplementation(async ({ observation: frame }) => {
      await held.promise;
      return {
        kind: "action",
        observationId: frame.id,
        action,
        description: "Fixture update",
      };
    });
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(f.planner.plan).toHaveBeenCalled());
    f.runtime.stop();
    await vi.waitFor(() => expect(f.device.stop).toHaveBeenCalledTimes(1));
    held.release();
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("preserves uncertainty if Stop races an already-dispatched action", async () => {
    const f = fixture({ allowed: true });
    const held = gate();
    f.device.execute.mockImplementation(async () => {
      await held.promise;
      throw Error("Unknown dispatch outcome");
    });
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(f.device.execute).toHaveBeenCalled());
    f.runtime.stop();
    await vi.waitFor(() => expect(f.device.stop).toHaveBeenCalledTimes(1));
    held.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    await f.runtime.submit("task_2", "Update again");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("does not finish from a verification response that arrives after Stop", async () => {
    const f = fixture({ allowed: true });
    const held = gate();
    f.planner.verify.mockImplementation(async () => {
      await held.promise;
      return { verified: true, summary: "Done" };
    });
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(f.planner.verify).toHaveBeenCalled());
    f.runtime.stop();
    held.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).not.toBe("completed");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("fences Stop during post-input observation without issuing another action", async () => {
    const f = fixture({ allowed: true });
    const held = gate();
    let inputSubmitted = false;
    let observationPending = false;
    f.device.execute.mockImplementation(async () => {
      inputSubmitted = true;
    });
    f.device.observe.mockImplementation(async () => {
      if (inputSubmitted) {
        observationPending = true;
        await held.promise;
      }
      return f.observation();
    });
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(observationPending).toBe(true));
    f.runtime.stop();
    held.release();
    await f.runtime.waitForIdle();
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("retains a durable action reservation after restart and never resumes it", async () => {
    const f = fixture({ allowed: true });
    const held = gate();
    f.device.execute.mockImplementation(async () => {
      await held.promise;
      throw Error("Interrupted action");
    });
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(f.device.execute).toHaveBeenCalled());
    // Copy the persisted crash-time image into a separate process/store analogue.
    const restoredStore = new Store();
    for (const row of f.store.all<{ id: string; ciphertext: string }>(
      "bundled-cua-task-v1",
    ))
      restoredStore.put("bundled-cua-task-v1", row);
    const freshDevice = vi.fn(() => f.device);
    const restored = new BundledCuaRuntime(
      restoredStore,
      f.vault,
      f.config,
      f.planner,
      freshDevice,
    );
    cleanups.push(async () => {
      await restored.close();
      restoredStore.close();
    });
    expect(restored.snapshot().state).toBe("uncertain");
    await restored.submit("task_1", "Update fixture");
    await restored.submit("task_2", "Update fixture again");
    await restored.waitForIdle();
    expect(freshDevice).not.toHaveBeenCalled();
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    held.release();
    await f.runtime.waitForIdle();
  });

  it("does not let model output override an adapter refusal", async () => {
    const f = fixture({ allowed: true });
    f.device.authorize.mockResolvedValue("refused");
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("rejects false completion even if the planning model says done", async () => {
    const f = fixture({ allowed: true });
    f.planner.verify.mockResolvedValue({
      verified: false,
      summary: "Requested result was not observed",
    });
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("requires a distinct observation before verifying a done proposal", async () => {
    const f = fixture({ allowed: true });
    const cached = f.observation();
    f.device.observe.mockResolvedValue(cached);
    f.planner.plan.mockResolvedValue({
      kind: "done",
      observationId: cached.id,
      summary: "Already done",
    });
    await f.runtime.submit("task_1", "Inspect the fixture result");
    await f.runtime.waitForIdle();
    expect(f.planner.verify).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("keeps input uncertain when the adapter returns its pre-input cached image", async () => {
    const f = fixture({ allowed: true });
    let submitted = false;
    let last: CuaObservation;
    f.device.observe.mockImplementation(async () => {
      if (!submitted) last = f.observation();
      return last;
    });
    f.device.execute.mockImplementation(async () => {
      submitted = true;
    });
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot().state).toBe("uncertain");
    expect(f.planner.verify).not.toHaveBeenCalled();
  });

  it("fails closed on an invalid adapter permission response", async () => {
    const f = fixture({ allowed: true });
    f.device.authorize.mockResolvedValue("unexpected" as "allowed");
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("says which setup step is missing, in the runtime's own fixed words, and nothing else for other failures", async () => {
    const advice =
      "ClawdTime's own browser is not installed. In the ClawdTime folder run: npm run cua:install-browser. Then give the task again.";
    const missing = fixture({ allowed: true });
    missing.device.open.mockImplementation(async () => {
      throw new CuaSetupRequired(advice);
    });
    await missing.runtime.submit("task_1", "Update fixture");
    await expect(missing.runtime.waitForIdle()).resolves.toBeUndefined();
    expect(missing.runtime.snapshot()).toMatchObject({
      state: "blocked",
      message: advice,
    });
    expect(missing.device.execute).not.toHaveBeenCalled();
    // Any other failure keeps the general sentence: its own text is never shown.
    const other = fixture({ allowed: true });
    other.device.open.mockImplementation(async () => {
      throw Error("private detail of a tool");
    });
    await other.runtime.submit("task_1", "Update fixture");
    await expect(other.runtime.waitForIdle()).resolves.toBeUndefined();
    expect(other.runtime.snapshot()).toMatchObject({
      state: "blocked",
      message:
        "The computer runtime could not continue within its current permissions and observation limits.",
    });
  });

  it("contains device construction failures without stranding the task flight", async () => {
    const f = fixture({ allowed: true });
    f.createDevice.mockImplementation(() => {
      throw Error("Device unavailable");
    });
    await f.runtime.submit("task_1", "Update fixture");
    await expect(f.runtime.waitForIdle()).resolves.toBeUndefined();
    expect(f.runtime.snapshot().state).toBe("blocked");
    expect(f.device.execute).not.toHaveBeenCalled();
  });

  it("does not publish completion when device cleanup is unknown", async () => {
    const f = fixture({ allowed: true });
    f.device.stop.mockRejectedValue(Error("Cleanup result unknown"));
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    await f.runtime.submit("task_2", "Update fixture again");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves a Stop arriving while final cleanup is still pending", async () => {
    const f = fixture({ allowed: true });
    const held = gate();
    f.device.stop.mockImplementation(async () => {
      await held.promise;
    });
    await f.runtime.submit("task_1", "Update fixture");
    await vi.waitFor(() => expect(f.device.stop).toHaveBeenCalled());
    f.runtime.stop();
    held.release();
    await f.runtime.waitForIdle();
    expect(f.device.stop).toHaveBeenCalledTimes(1);
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("reports the configured runtime mode without implying a native readiness probe", () => {
    const f = fixture();
    expect(f.runtime.snapshot()).toMatchObject({
      configured: true,
      mode: "browser",
      state: "idle",
    });
    expect(f.device.open).not.toHaveBeenCalled();
  });

  it("records definite no-input refusal without replay or permanently fencing new tasks", async () => {
    const f = fixture({ allowed: true });
    f.device.execute.mockRejectedValue(new CuaInputNotDispatched());
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("blocked");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    await f.runtime.submit("task_1", "Update fixture");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    await f.runtime.submit("task_2", "A separately requested update");
    await f.runtime.waitForIdle();
    expect(f.device.execute).toHaveBeenCalledTimes(2);
    expect(f.device.execute.mock.calls[1]![0].actionId).not.toBe(
      f.device.execute.mock.calls[0]![0].actionId,
    );
  });

  it("does not interpret a generic error mentioning no input as proof", async () => {
    const f = fixture({ allowed: true });
    f.device.execute.mockRejectedValue(Error("409 input_not_dispatched"));
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    await f.runtime.submit("task_2", "A separately requested update");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("cannot classify a post-input observation failure as no dispatch", async () => {
    const f = fixture({ allowed: true });
    let submitted = false;
    f.device.execute.mockImplementation(async () => {
      submitted = true;
    });
    f.device.observe.mockImplementation(async () => {
      if (submitted) throw new CuaInputNotDispatched();
      return f.observation();
    });
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    await f.runtime.submit("task_2", "A separately requested update");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("deduplicates a submitted identity and rejects changed task text", async () => {
    const f = fixture({ allowed: true });
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    await f.runtime.submit("task_1", "Update fixture");
    await expect(
      f.runtime.submit("task_1", "Different instruction"),
    ).rejects.toThrow();
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("expires authority while planning without submitting the late action", async () => {
    const f = fixture({ allowed: true });
    f.planner.plan.mockImplementation(async ({ observation: frame }) => {
      f.advance(11_000);
      return {
        kind: "action",
        observationId: frame.id,
        action,
        description: "Fixture update",
      };
    });
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });

  it("stops a planner loop at the configured action budget", async () => {
    const f = fixture({ allowed: true, maxSteps: 2 });
    f.planner.plan.mockImplementation(
      async ({ observation: frame }): Promise<CuaPlan> => ({
        kind: "action",
        observationId: frame.id,
        action,
        description: "Fixture update",
      }),
    );
    await f.runtime.submit("task_1", "Update fixture");
    await f.runtime.waitForIdle();
    expect(f.device.execute.mock.calls.length).toBeLessThanOrEqual(2);
    expect(f.runtime.snapshot().state).not.toBe("completed");
  });
});
