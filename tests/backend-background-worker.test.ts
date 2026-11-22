import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTaskContext } from "../src/control/background-runtime.js";
import type { BackgroundConfig } from "../src/control/background-config.js";

const state = vi.hoisted(() => ({
  events: [] as string[],
  lifecycle: null as any,
  ownership: null as any,
  port: null as any,
  witness: null as any,
  runnerPort: null as any,
  host: null as any,
  video: null as any,
  videoOptions: null as any,
  run: null as any,
  connected: null as any,
  heldDriver: null as any,
}));
vi.mock("../src/control/background-lifecycle.js", () => ({
  BackgroundLifecycle: class {
    constructor() {
      return state.lifecycle;
    }
  },
}));
vi.mock("../src/control/background-ownership.js", async (original) => ({
  ...(await original<
    typeof import("../src/control/background-ownership.js")
  >()),
  BackgroundOwnership: class {
    constructor() {
      return state.ownership;
    }
  },
}));
vi.mock("../connectors/agents/cua-driver-background-port.js", () => ({
  connectPinnedBackgroundDaemon: async (config: any, witness: any) => {
    state.events.push("connect");
    state.witness = witness;
    state.connected(config);
    return state.port;
  },
}));
vi.mock("../connectors/agents/background-intent-planner.js", () => ({
  openAiBackgroundIntentPlanner: () => ({ verifySurface: async () => true }),
}));
vi.mock(
  "../connectors/agents/background-qualified-workflow.js",
  async (original) => ({
    ...(await original<
      typeof import("../connectors/agents/background-qualified-workflow.js")
    >()),
    QualifiedBackgroundWorkflow: class {
      constructor(_config: any, port: any, _planner: any, host: any) {
        state.runnerPort = port;
        state.host = host;
      }
      run(...args: any[]) {
        return state.run(...args);
      }
      stop() {
        state.events.push("runner-stop");
      }
    },
  }),
);
vi.mock("../media/background-window-video.mjs", () => ({
  BackgroundWindowVideo: class {
    constructor(options: any) {
      state.videoOptions = options;
      return state.video;
    }
  },
}));
import { QualifiedBackgroundWorker } from "../src/control/background-worker.js";

const config: BackgroundConfig = {
  version: 1,
  backend: "cua-driver-background",
  model: "fixture-model",
  timeoutMs: 30_000,
  native: {
    origin: "http://127.0.0.1:12345",
    token: "fixture".repeat(8),
    deviceId: "device",
    executorId: "executor",
    displayId: 1,
  },
  driver: {
    sdkDirectory: "/private/sdk",
    socketPath: "/private/driver.sock",
    executablePath: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    expectedPid: 77,
    manifestSha256: "a".repeat(64),
    policySha256: "b".repeat(64),
    targets: [],
  },
  messages: {
    bundleId: "com.apple.MobileSMS",
    executablePath: "/System/Applications/Messages.app/Contents/MacOS/Messages",
    bundleVersion: "1.0",
    destination: "Fixture Contact",
  },
  codex: {
    bundleId: "com.openai.codex",
    executablePath: "/Applications/Codex.app/Contents/MacOS/Codex",
    bundleVersion: "1.0",
    destination: "Fixture Project",
  },
};
const target = {
  bundleId: config.codex.bundleId,
  executablePath: config.codex.executablePath,
  bundleVersion: "1.0",
  pid: 88,
  windowId: 9,
  processStart: "c".repeat(64),
  onCurrentSpace: true,
  geometry: { x: 20, y: 30, width: 800, height: 600 },
  geometryGeneration: "d".repeat(64),
};
const candidate = {
  pid: 88,
  bundleId: config.codex.bundleId,
  windowIds: ["9"],
  selfActivationSuppressed: true,
};
const workers: QualifiedBackgroundWorker[] = [];
const releases: Array<() => void> = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
beforeEach(() => {
  state.events = [];
  state.connected = vi.fn();
  state.witness = null;
  state.host = null;
  state.runnerPort = null;
  state.lifecycle = {
    acquire: vi.fn(() => state.events.push("lifecycle-acquire")),
    assert: vi.fn(() => {}),
    release: vi.fn((known: boolean) =>
      state.events.push(`lifecycle-release:${known}`),
    ),
  };
  state.ownership = {
    open: vi.fn(async () => {
      state.events.push("helper-fence");
      return {
        driverGeneration: "driver-generation",
        driverProcessStart: "e".repeat(64),
      };
    }),
    beforeDispatch: vi.fn(async () => {}),
    target: vi.fn(async () => ({ ...target })),
    application: vi.fn(async (bundleId: string) => ({
      ...config.codex,
      bundleId,
    })),
    verifyCleanupDriver: vi.fn(async () =>
      state.events.push("verify-cleanup-driver"),
    ),
    stop: vi.fn(() => state.events.push("ownership-stop")),
    close: vi.fn(async (known: boolean, reconciled: boolean) => {
      state.events.push(`helper-resolve:${known}:${reconciled}`);
      return known && reconciled;
    }),
  };
  state.port = {
    startSession: vi.fn(async () => true),
    stop: vi.fn(() => state.events.push("port-stop")),
    endSession: vi.fn(async () =>
      state.witness.withLease(
        { operation: "end_session", driverGeneration: "driver-generation" },
        new AbortController().signal,
        async () => {
          state.events.push("driver-end");
          return { quiescence: "known" };
        },
      ),
    ),
    observe: vi.fn(async () => ({ isError: false })),
    capturePreview: vi.fn(async () => ({ isError: false, images: [] })),
    launchQualifiedApp: vi.fn(),
    clickElement: vi.fn(),
    clickQualifiedPoint: vi.fn(),
    typePixelDraft: vi.fn(),
  };
  const now = Date.now();
  const view = {
    rgba: new Uint8Array(16),
    width: 2,
    height: 2,
    frameId: "fixture-frame",
    capturedAt: now,
    layout: {
      visible: true,
      frameId: "fixture-frame",
      validUntil: now + 1000,
      crop: { x: 0, y: 0, width: 2, height: 2 },
      contentRect: { x: 0, y: 0, width: 720, height: 720 },
      cursor: null,
      cursorStatus: "unknown",
    },
  };
  state.video = {
    bind: vi.fn(),
    revoke: vi.fn(),
    overview: vi.fn(),
    focus: vi.fn(),
    complete: vi.fn(),
    tick: vi.fn(async () =>
      state.videoOptions.captureWindow({
        session: "fixture-session",
        pid: 88,
        window_id: 9,
      }),
    ),
    latest: vi.fn(() => view),
    isCurrent: vi.fn(() => true),
  };
  state.run = vi.fn(async () => ({
    verified: true,
    summary: "Read-only fixture observed",
  }));
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const worker of workers.splice(0)) await worker.close();
});
function fixture() {
  let live = true,
    next = 0;
  const context: BackgroundTaskContext = {
    callId: "fixture-call",
    toolCallId: "fixture-tool",
    taskId: "fixture-task",
    sessionId: "fixture-session",
    expiresAt: Date.now() + 30_000,
    isLive: () => live,
    reserve: vi.fn(() => `effect_${++next}`),
    returned: vi.fn(),
    verified: vi.fn(),
  };
  const worker = new QualifiedBackgroundWorker(
    config,
    "/private/fixture-owner",
    "fixture-key",
  );
  workers.push(worker);
  return {
    worker,
    context,
    run: () =>
      worker.run("Read fixture", context, new AbortController().signal),
    revoke: () => {
      live = false;
    },
  };
}
async function bind(context: BackgroundTaskContext) {
  return state.host.bindFreshTarget(
    "codex-draft",
    context,
    new AbortController().signal,
    candidate,
  );
}

describe("assembled background worker authority and cleanup", () => {
  it("verifies an off-Space launch without granting a target, preview, or input", async () => {
    const f = fixture();
    state.ownership.target.mockResolvedValue({
      ...target,
      onCurrentSpace: false,
    });
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        await state.host.verifyLaunchedApplication(
          "codex-draft",
          context,
          new AbortController().signal,
          candidate,
        );
        expect(state.video.bind).not.toHaveBeenCalled();
        expect(
          await f.worker.preview(context.callId, context.taskId),
        ).toBeNull();
        await expect(bind(context)).rejects.toThrow("exactly one qualified");
        expect(state.port.capturePreview).not.toHaveBeenCalled();
        expect(state.port.clickElement).not.toHaveBeenCalled();
        expect(state.port.typePixelDraft).not.toHaveBeenCalled();
        return {
          verified: false,
          summary: "Launch verified; current-Space input blocked",
        };
      },
    );
    await f.run();
  });
  it.each(["version", "executable", "signature", "candidate_app", "revoked"])(
    "does not verify launch with invalid independent evidence: %s",
    async (kind) => {
      const f = fixture();
      state.run.mockImplementation(
        async (_goal: string, context: BackgroundTaskContext) => {
          if (kind === "version")
            state.ownership.target.mockResolvedValue({
              ...target,
              bundleVersion: "unqualified",
            });
          if (kind === "executable")
            state.ownership.target.mockResolvedValue({
              ...target,
              executablePath: "/unqualified/app",
            });
          if (kind === "signature")
            state.ownership.target.mockRejectedValue(
              Error("Native signing witness refused"),
            );
          if (kind === "revoked")
            state.ownership.target.mockImplementation(async () => {
              f.revoke();
              return { ...target };
            });
          await expect(
            state.host.verifyLaunchedApplication(
              "codex-draft",
              context,
              new AbortController().signal,
              kind === "candidate_app"
                ? { ...candidate, bundleId: "other.application" }
                : candidate,
            ),
          ).rejects.toThrow();
          expect(state.video.bind).not.toHaveBeenCalled();
          expect(state.port.clickElement).not.toHaveBeenCalled();
          return { verified: false, summary: "Launch postcondition refused" };
        },
      );
      await f.run();
    },
  );
  it("reserves durable ownership before connecting and only releases after exact driver cleanup and helper resolution", async () => {
    const f = fixture();
    await f.run();
    expect(state.events.slice(0, 3)).toEqual([
      "lifecycle-acquire",
      "helper-fence",
      "connect",
    ]);
    expect(await f.worker.close()).toEqual({ quiescence: "known" });
    expect(state.events.indexOf("driver-end")).toBeLessThan(
      state.events.indexOf("helper-resolve:true:true"),
    );
    expect(state.events.indexOf("helper-resolve:true:true")).toBeLessThan(
      state.events.indexOf("lifecycle-release:true"),
    );
    await f.worker.close();
    expect(state.port.endSession).toHaveBeenCalledTimes(1);
    expect(state.ownership.close).toHaveBeenCalledTimes(1);
  });
  it("preserves both fences when an effect remains unknown even if daemon cleanup succeeds", async () => {
    const f = fixture();
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        const id = context.reserve({ type: "fixture" });
        context.returned(id, "unknown");
        return { verified: false, summary: "Unknown effect" };
      },
    );
    await f.run();
    expect(await f.worker.close()).toEqual({ quiescence: "unknown" });
    expect(state.ownership.close).toHaveBeenCalledWith(true, false);
    expect(state.lifecycle.release).toHaveBeenCalledWith(false);
  });
  it("does not connect the driver after Stop races helper admission", async () => {
    const f = fixture();
    const opening = gate();
    state.ownership.open.mockImplementation(async () => {
      await opening.promise;
      return {
        driverGeneration: "driver-generation",
        driverProcessStart: "e".repeat(64),
      };
    });
    const task = f.run();
    await vi.waitFor(() => expect(state.ownership.open).toHaveBeenCalled());
    f.worker.stop();
    opening.release();
    await expect(task).rejects.toThrow();
    expect(state.connected).not.toHaveBeenCalled();
  });
  it("rejects unqualified app versions and changed process/window identity before a driver callback", async () => {
    const f = fixture();
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        const { scope } = await bind(context);
        state.ownership.target.mockResolvedValue({
          ...target,
          processStart: "f".repeat(64),
        });
        const dispatch = vi.fn(async () => {});
        await expect(
          state.witness.withLease(
            {
              operation: "get_window_state",
              driverGeneration: "driver-generation",
              target: scope,
            },
            new AbortController().signal,
            dispatch,
          ),
        ).rejects.toThrow("changed");
        expect(dispatch).not.toHaveBeenCalled();
        state.ownership.target.mockResolvedValue({
          ...target,
          bundleVersion: "2.0",
        });
        await expect(bind(context)).rejects.toThrow();
        return { verified: false, summary: "Changed target blocked" };
      },
    );
    await f.run();
  });
  it("permits no unreserved launch or ungranted action through the shared dispatch witness", async () => {
    const f = fixture();
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        const { scope } = await bind(context);
        const dispatch = vi.fn(async () => {});
        await expect(
          state.witness.withLease(
            {
              operation: "launch_app",
              driverGeneration: "driver-generation",
              bundleId: config.codex.bundleId,
              expectedExecutablePath: config.codex.executablePath,
              actionId: "unreserved",
            },
            new AbortController().signal,
            dispatch,
          ),
        ).rejects.toThrow();
        await expect(
          state.witness.withLease(
            {
              operation: "click",
              driverGeneration: "driver-generation",
              target: scope,
              actionId: "unreserved",
              action: { type: "click-element", elementToken: "send" },
            },
            new AbortController().signal,
            dispatch,
          ),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
        return { verified: false, summary: "No side effect admitted" };
      },
    );
    await f.run();
  });
  it("renews helper ownership after a slow target witness before dispatch", async () => {
    const f = fixture();
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        const { scope } = await bind(context);
        let helperStopped = false;
        state.ownership.beforeDispatch.mockImplementation(async () => {
          if (helperStopped) throw Error("Helper stopped during target read");
        });
        state.ownership.target.mockImplementation(async () => {
          // Stop happened in the other process while the target read was pending;
          // its periodic status poll has not delivered revocation locally yet.
          await Promise.resolve();
          helperStopped = true;
          return { ...target };
        });
        const dispatch = vi.fn(async () => {});
        await expect(
          state.witness.withLease(
            {
              operation: "get_window_state",
              driverGeneration: "driver-generation",
              target: scope,
            },
            new AbortController().signal,
            dispatch,
          ),
        ).rejects.toThrow("Helper stopped");
        expect(dispatch).not.toHaveBeenCalled();
        return { verified: false, summary: "Stop prevented dispatch" };
      },
    );
    await f.run();
  });
  it("keeps preview call-scoped and invalidates a returned preview on Stop or hangup", async () => {
    const f = fixture();
    const working = gate();
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        await bind(context);
        await working.promise;
        return { verified: true, summary: "Read fixture" };
      },
    );
    const task = f.run();
    await vi.waitFor(() => expect(state.video.bind).toHaveBeenCalled());
    expect(await f.worker.preview("other-call", "fixture-task")).toBeNull();
    expect(await f.worker.preview("fixture-call", "other-task")).toBeNull();
    const frame = await f.worker.preview("fixture-call", "fixture-task");
    expect(frame?.valid()).toBe(true);
    f.worker.stop();
    expect(frame?.valid()).toBe(false);
    expect(state.video.revoke).toHaveBeenCalled();
    expect(await f.worker.preview("fixture-call", "fixture-task")).toBeNull();
    working.release();
    await task;
  });
  it("rechecks grant expiry after awaiting final helper renewal", async () => {
    const f = fixture();
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        const { scope } = await bind(context);
        const binding = {
          ...scope,
          observationId: "fixture-observation",
          observationFingerprint: "fixture-fingerprint",
        };
        const actionId = context.reserve({ type: "fixture" });
        const action = { type: "click-element", elementToken: "new-chat" };
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          state.host.armGrant({
            workflow: "codex-draft",
            qualificationId: "codex-unsent-same-desktop-055",
            appVersion: config.codex.bundleVersion,
            destination: config.codex.destination,
            actionId,
            action,
            binding,
            observedAt: now,
            expiresAt: now + 100,
          });
          state.ownership.beforeDispatch.mockImplementation(async () => {
            clock.mockReturnValue(now + 100);
          });
          const dispatch = vi.fn(async () => {});
          await expect(
            state.witness.withLease(
              {
                operation: "click",
                driverGeneration: "driver-generation",
                target: binding,
                actionId,
                action,
              },
              new AbortController().signal,
              dispatch,
            ),
          ).rejects.toThrow();
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          clock.mockRestore();
        }
        return { verified: false, summary: "Expired grant refused" };
      },
    );
    await f.run();
  });
  it("waits for an existing preview read before workflow use and skips further previews while workflow is queued", async () => {
    const f = fixture();
    const beginFlow = gate(),
      capture = gate();
    state.port.capturePreview.mockImplementation(async () => {
      await capture.promise;
      return { isError: false, images: [] };
    });
    state.run.mockImplementation(
      async (_goal: string, context: BackgroundTaskContext) => {
        const { scope } = await bind(context);
        await beginFlow.promise;
        await state.runnerPort.observe(scope, new AbortController().signal);
        return { verified: true, summary: "Read after preview" };
      },
    );
    const task = f.run();
    await vi.waitFor(() => expect(state.video.bind).toHaveBeenCalled());
    const preview = f.worker.preview("fixture-call", "fixture-task");
    await vi.waitFor(() =>
      expect(state.port.capturePreview).toHaveBeenCalledTimes(1),
    );
    beginFlow.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.port.observe).not.toHaveBeenCalled();
    expect(await f.worker.preview("fixture-call", "fixture-task")).toBeNull();
    capture.release();
    await preview;
    await task;
    expect(state.port.observe).toHaveBeenCalledTimes(1);
    expect(state.port.capturePreview).toHaveBeenCalledTimes(1);
  });
});
