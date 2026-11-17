import { describe, expect, it, vi } from "vitest";
import { PresentationSceneController } from "../connectors/shared/presentation-scenes.js";
import { ApiError } from "../connectors/shared/client.js";
import type { CameraCommand, CameraStatus } from "../src/camera-contracts.js";
import type { LivePresentationIntent } from "../src/live-presentation-contracts.js";

function fixture(live = false) {
  let now = 10_000;
  const window = {
    appId: live ? "com.apple.finder" : "com.example.Fixture",
    windowId: "12",
    ownerPid: 71,
    displayId: 2,
  };
  const plan = {
    version: 1,
    id: "walkthrough",
    scenes: [
      {
        id: "first",
        title: "First scene",
        window,
        intent: "Show disposable folder",
        expectedOutcome: "Disposable folder is visible",
        annotation: { kind: "highlight" },
        ...(live
          ? {
              focus: {
                rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
                durationMs: 450,
              },
            }
          : {}),
      },
      {
        id: "second",
        title: "Second scene",
        window: {
          ...window,
          appId: live ? "com.apple.TextEdit" : "com.example.Second",
          windowId: "13",
        },
        intent: "Show second fixture",
        expectedOutcome: "Second fixture is visible",
        ...(live
          ? {
              focus: {
                rect: { x: 0.1, y: 0.1, width: 0.6, height: 0.6 },
                durationMs: 450,
              },
            }
          : {}),
      },
    ],
  };
  const camera: CameraStatus = {
    version: 1,
    sessionId: "session",
    deviceId: "device",
    leaseId: "lease",
    revision: 0,
    state: "live",
    surface: { kind: "display", id: "2", displayId: 2 },
    sourceFrameId: "frame",
    capturedAt: now,
    geometryGeneration: "geometry",
    contentRevision: "content",
    crop: { x: 0, y: 0, width: 1, height: 1 },
    source: null,
    output: {
      width: 1280,
      height: 720,
      viewport: { x: 0, y: 0, width: 1280, height: 720 },
    },
    pinned: false,
    moving: false,
    annotations: [],
    context: null,
  };
  const execution = {
    executor: "none",
    state: "idle",
    epoch: 2,
    cursor: 0,
    acknowledgedCursor: 0,
    pendingDelivery: false,
    hold: { active: false },
    leases: [] as { state: string }[],
    actions: [] as { state: string }[],
  };
  const commands: CameraCommand[] = [];
  const liveResult = (intent: LivePresentationIntent) => ({
    version: 1,
    commandId: intent.commandId,
    state: "accepted",
    reason: "live_frame_committed",
    fingerprint: "a".repeat(64),
    receiptId: "receipt",
    observation: {
      window: intent.window,
      observedAt: now,
      processIdentity: "process-start",
      windowBounds: { x: 10, y: 10, width: 400, height: 300 },
      appActive: true,
      windowFocused: true,
      windowOnScreen: true,
    },
    camera: {
      revision: ++camera.revision,
      sourceFrameId: camera.sourceFrameId,
      geometryGeneration: camera.geometryGeneration,
      contentRevision: camera.contentRevision,
      capturedAt: camera.capturedAt,
    },
  });
  const ports = {
    cameraStatus: vi.fn(async () => structuredClone(camera)),
    executionStatus: vi.fn(async () => structuredClone(execution)),
    presentLive: vi.fn(
      async (intent: LivePresentationIntent): Promise<unknown> =>
        liveResult(intent),
    ),
    cameraCommand: vi.fn(async (command: CameraCommand) => {
      commands.push(command);
      return {
        version: 1,
        commandId: command.commandId,
        revision: ++camera.revision,
        state: "accepted",
      };
    }),
  };
  const controller = new PresentationSceneController(plan, ports, () => now);
  const verification = () => ({
    sceneId: "first",
    generation: controller.status().generation,
    observedAt: now,
    window,
    windowBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    resultVerified: true,
    sourceFrameId: "frame",
    geometryGeneration: "geometry",
    contentRevision: "content",
    leaseId: "lease",
  });
  return {
    controller,
    ports,
    camera,
    execution,
    commands,
    verification,
    liveResult,
    setTime: (time: number) => {
      now = time;
    },
  };
}
const rect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
function attestation(f: ReturnType<typeof fixture>) {
  const {
    sourceFrameId: _,
    geometryGeneration: _g,
    contentRevision: _c,
    leaseId: _l,
    ...value
  } = f.verification();
  return value;
}

describe("agent-prepared presentation scenes", () => {
  it("presents immutable window-relative focus through the live port without caller frame hashes", async () => {
    const f = fixture(true);
    await f.controller.begin("first");
    f.camera.contentRevision = "latest-content";
    const result = await f.controller.presentLive();
    expect(result.phase).toBe("presented");
    expect(result.liveReceipt?.camera?.contentRevision).toBe("latest-content");
    const intent = f.ports.presentLive.mock.calls[0]![0];
    expect(intent).toMatchObject({
      planId: "walkthrough",
      sceneId: "first",
      window: f.verification().window,
      focus: { rect, durationMs: 450 },
      annotation: { kind: "highlight" },
    });
    expect(intent).not.toHaveProperty("sourceFrameId");
    expect(f.commands.map((command) => command.op)).toEqual([
      "clear",
      "overview",
    ]);
    await f.controller.presentLive();
    expect(f.ports.presentLive).toHaveBeenCalledTimes(1);
  });

  it("does not interpret a native task's expected outcome as live presentation authority", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await expect(f.controller.presentLive()).rejects.toThrow(
      "prepared window-relative",
    );
    expect(f.ports.presentLive).not.toHaveBeenCalled();
    const g = fixture(true);
    await g.controller.begin("first");
    g.execution.hold.active = true;
    await expect(g.controller.presentLive()).rejects.toThrow(
      "acknowledged context",
    );
    expect(g.ports.presentLive).not.toHaveBeenCalled();
  });

  it.each(["uncertain", "malformed", "wrong_window", "stale"])(
    "preserves unknown live outcomes without replacement: %s",
    async (kind) => {
      const f = fixture(true);
      await f.controller.begin("first");
      f.ports.presentLive.mockImplementation(async (intent) => {
        const result = f.liveResult(intent);
        if (kind === "uncertain") result.state = "uncertain";
        if (kind === "malformed") return {};
        if (kind === "wrong_window")
          result.observation.window = {
            ...result.observation.window,
            windowId: "999",
          };
        if (kind === "stale") result.camera.capturedAt = 7999;
        return result;
      });
      await expect(f.controller.presentLive()).rejects.toThrow("unknown");
      expect(() => f.controller.presentLive()).toThrow("unknown");
      expect(() =>
        f.controller.replan(
          { ...f.controller.status().plan, id: "replacement" },
          f.controller.status().generation,
        ),
      ).toThrow("unknown");
      expect(f.ports.presentLive).toHaveBeenCalledTimes(1);
    },
  );

  it("retains a definitive rejected receipt without misreporting an unknown effect", async () => {
    const f = fixture(true);
    await f.controller.begin("first");
    f.ports.presentLive.mockImplementation(async (intent) => ({
      ...f.liveResult(intent),
      state: "rejected",
      reason: "target_unavailable",
    }));
    await expect(f.controller.presentLive()).rejects.toThrow("was rejected");
    expect(f.controller.status()).toMatchObject({
      phase: "blocked",
      unknownCommandId: null,
      liveReceipt: { state: "rejected" },
    });
    expect(f.ports.presentLive).toHaveBeenCalledTimes(1);
  });

  it("interrupts a pending live presentation and clears it without advancing stale scenes", async () => {
    const f = fixture(true);
    await f.controller.begin("first");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.ports.presentLive.mockImplementation(async (intent) => {
      entered();
      await pending;
      return f.liveResult(intent);
    });
    const presenting = f.controller.presentLive();
    const failed = expect(presenting).rejects.toThrow("interrupted");
    await started;
    const interrupting = f.controller.interrupt();
    release();
    await failed;
    await interrupting;
    expect(f.controller.status().phase).toBe("interrupted");
    expect(f.commands.map((command) => command.op)).toEqual([
      "clear",
      "overview",
      "clear",
      "overview",
    ]);
  });

  it("completes and prepares a new walkthrough while preserving TTL, generation and command history", async () => {
    const f = fixture(true);
    const expiry = f.controller.status().expiresAt;
    await f.controller.begin("first");
    await f.controller.presentLive();
    expect(() => f.controller.complete()).toThrow("final planned scene");
    await f.controller.next();
    await f.controller.presentLive();
    expect(f.controller.complete().phase).toBe("completed");
    const oldGeneration = f.controller.status().generation;
    const replacement = { ...f.controller.status().plan, id: "followup" };
    const result = await f.controller.replan(replacement, oldGeneration);
    expect(result).toMatchObject({
      phase: "idle",
      scene: null,
      planCount: 2,
      expiresAt: expiry,
    });
    expect(result.generation).toBeGreaterThan(oldGeneration);
    expect(f.commands.slice(-2).map((command) => command.op)).toEqual([
      "clear",
      "overview",
    ]);
    const ids = [
      ...f.commands.map((c) => c.commandId),
      ...f.ports.presentLive.mock.calls.map(([intent]) => intent.commandId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => f.controller.replan(replacement, oldGeneration)).toThrow(
      "interrupted",
    );
    await f.controller.begin("first");
    await f.controller.presentLive();
    expect(f.ports.presentLive).toHaveBeenCalledTimes(3);
  });

  it("replans only after explicit completion or interruption and preserves the same display and lease", async () => {
    const f = fixture(true);
    await f.controller.begin("first");
    const replacement = { ...f.controller.status().plan, id: "followup" };
    await expect(
      f.controller.replan(replacement, f.controller.status().generation),
    ).rejects.toThrow("Complete or interrupt");
    await f.controller.interrupt();
    await expect(
      f.controller.replan(
        {
          ...replacement,
          scenes: replacement.scenes.map((s) => ({
            ...s,
            window: { ...s.window, displayId: 3 },
          })),
        },
        f.controller.status().generation,
      ),
    ).rejects.toThrow("same explicitly selected display");
    await f.controller.replan(replacement, f.controller.status().generation);
    f.camera.leaseId = "replacement-lease";
    await expect(f.controller.begin("first")).rejects.toThrow(
      "authority changed",
    );
  });

  it("bounds follow-up plans and refuses replaying an old plan ID", async () => {
    const f = fixture(true);
    for (let i = 2; i <= 8; i++) {
      await f.controller.begin("first");
      await f.controller.interrupt();
      await f.controller.replan(
        { ...f.controller.status().plan, id: `plan-${i}` },
        f.controller.status().generation,
      );
    }
    await f.controller.begin("first");
    await f.controller.interrupt();
    await expect(
      f.controller.replan(
        { ...f.controller.status().plan, id: "plan-9" },
        f.controller.status().generation,
      ),
    ).rejects.toThrow("revision bound");
    await expect(
      f.controller.replan(
        { ...f.controller.status().plan, id: "plan-8" },
        f.controller.status().generation,
      ),
    ).rejects.toThrow("already used");
  });

  it("invalidates an old queued presentation before installing a follow-up plan", async () => {
    const f = fixture(true);
    await f.controller.begin("second");
    await f.controller.presentLive();
    f.controller.complete();
    const queued = f.controller.presentLive();
    const canceled = expect(queued).rejects.toThrow("interrupted");
    await f.controller.replan(
      { ...f.controller.status().plan, id: "followup" },
      f.controller.status().generation,
    );
    await canceled;
    expect(f.ports.presentLive).toHaveBeenCalledTimes(1);
    expect(f.controller.status()).toMatchObject({
      phase: "idle",
      plan: { id: "followup" },
    });
  });

  it("samples and presents within one runtime without an external source round trip", async () => {
    const f = fixture();
    await f.controller.begin("first");
    const witness = attestation(f);
    expect((await f.controller.presentObserved(witness, rect)).phase).toBe(
      "presented",
    );
    expect(witness.observedAt).toBe(10_000);
    expect(f.commands.map((command) => command.op)).toEqual([
      "clear",
      "overview",
      "focus_region",
      "annotation_upsert",
    ]);
    await expect(f.controller.presentObserved(witness, rect)).rejects.toThrow(
      "current planned scene",
    );
    expect(f.commands).toHaveLength(4);
  });

  it("rejects stale original attestation or wrong scene before sampling", async () => {
    const f = fixture();
    await f.controller.begin("first");
    const reads = f.ports.cameraStatus.mock.calls.length;
    await expect(
      f.controller.presentObserved(
        { ...attestation(f), observedAt: 7999 },
        rect,
      ),
    ).rejects.toThrow("Original scene attestation is stale");
    await expect(
      f.controller.presentObserved(
        { ...attestation(f), sceneId: "second" },
        rect,
      ),
    ).rejects.toThrow("current planned scene");
    expect(f.ports.cameraStatus).toHaveBeenCalledTimes(reads);
  });

  it("cannot renew an original attestation that expires while sampling", async () => {
    const f = fixture();
    await f.controller.begin("first");
    const witness = attestation(f);
    f.ports.cameraStatus.mockImplementation(async () => {
      f.setTime(12_001);
      f.camera.capturedAt = 12_001;
      return structuredClone(f.camera);
    });
    await expect(f.controller.presentObserved(witness, rect)).rejects.toThrow(
      "verification is stale",
    );
    expect(witness.observedAt).toBe(10_000);
    expect(f.commands).toHaveLength(2);
  });

  it("still rejects changed content between internal sample and presentation", async () => {
    const f = fixture();
    await f.controller.begin("first");
    let reads = 0;
    f.ports.cameraStatus.mockImplementation(async () => {
      if (++reads > 1) f.camera.contentRevision = "changed";
      return structuredClone(f.camera);
    });
    await expect(
      f.controller.presentObserved(attestation(f), rect),
    ).rejects.toThrow("verification is stale");
    expect(f.commands).toHaveLength(2);
  });

  it("interruption during the internal sample invalidates the original attestation", async () => {
    const f = fixture();
    await f.controller.begin("first");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.ports.cameraStatus.mockImplementationOnce(async () => {
      entered();
      await pending;
      return structuredClone(f.camera);
    });
    const presenting = f.controller.presentObserved(attestation(f), rect);
    const failed = expect(presenting).rejects.toThrow("interrupted");
    await started;
    const interrupting = f.controller.interrupt();
    release();
    await failed;
    await interrupting;
    expect(f.commands.map((command) => command.op)).toEqual([
      "clear",
      "overview",
      "clear",
      "overview",
    ]);
  });

  it("requires a controller-sampled frame and focus inside agent-observed window bounds", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await expect(f.controller.present(f.verification(), rect)).rejects.toThrow(
      "sampled",
    );
    await f.controller.begin("first");
    await f.controller.observe();
    await expect(
      f.controller.present(f.verification(), { ...rect, x: 0 }),
    ).rejects.toThrow("window bounds");
    await expect(
      f.controller.present(
        { ...f.verification(), sourceFrameId: "invented-frame" },
        rect,
      ),
    ).rejects.toThrow("sampled");
    expect(f.commands.every((c) => c.op !== "focus_region")).toBe(true);
  });

  it("bounds observation history and invalidates samples on scene change", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    for (let i = 0; i < 8; i++) {
      f.camera.sourceFrameId = `frame-${i}`;
      await f.controller.observe();
    }
    await expect(f.controller.present(f.verification(), rect)).rejects.toThrow(
      "sampled",
    );
    await f.controller.begin("first");
    await expect(
      f.controller.present(
        { ...f.verification(), sourceFrameId: "frame-7" },
        rect,
      ),
    ).rejects.toThrow("sampled");
  });

  it("does not renew an old sampled frame by supplying a fresh witness timestamp", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    f.setTime(12_001);
    f.camera.capturedAt = 12_001;
    f.camera.sourceFrameId = "new-current-frame";
    await expect(f.controller.present(f.verification(), rect)).rejects.toThrow(
      "sampled",
    );
    expect(f.commands).toHaveLength(2);
  });

  it("clears before navigation, accepts newer same-content frames, and deduplicates exact presentation", async () => {
    const f = fixture();
    const started = await f.controller.begin("first");
    await f.controller.observe();
    expect(started.phase).toBe("awaiting_verification");
    expect(f.commands.map((c) => c.op)).toEqual(["clear", "overview"]);
    const verification = f.verification();
    f.camera.sourceFrameId = "newer-frame";
    await f.controller.present(verification, rect);
    expect(f.commands.map((c) => c.op)).toEqual([
      "clear",
      "overview",
      "focus_region",
      "annotation_upsert",
    ]);
    expect(f.commands[2]).toMatchObject({
      sourceFrameId: "newer-frame",
      contentRevision: "content",
      rect,
    });
    await f.controller.present(verification, rect);
    expect(f.commands).toHaveLength(4);
    await expect(
      f.controller.present(verification, { ...rect, x: 0.3 }),
    ).rejects.toThrow("do not replay");
    expect(f.commands).toHaveLength(4);
    expect((await f.controller.next()).scene?.id).toBe("second");
    expect(f.commands.slice(-2).map((c) => c.op)).toEqual([
      "clear",
      "overview",
    ]);
  });

  it.each(["leaseId", "geometryGeneration", "contentRevision"] as const)(
    "rejects a changed %s without focusing",
    async (field) => {
      const f = fixture();
      await f.controller.begin("first");
      await f.controller.observe();
      f.camera[field] = "changed";
      await expect(
        f.controller.present(f.verification(), rect),
      ).rejects.toThrow();
      expect(f.commands).toHaveLength(2);
    },
  );

  it("rejects wrong window, future/stale verification and stale frames", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    await expect(
      f.controller.present(
        {
          ...f.verification(),
          window: { ...f.verification().window, windowId: "99" },
        },
        rect,
      ),
    ).rejects.toThrow("exact window");
    await expect(
      f.controller.present({ ...f.verification(), observedAt: 10_001 }, rect),
    ).rejects.toThrow("stale");
    await f.controller.begin("first");
    await f.controller.observe();
    await expect(
      f.controller.present({ ...f.verification(), observedAt: 7_999 }, rect),
    ).rejects.toThrow("stale");
    f.camera.capturedAt = 7_999;
    await expect(f.controller.begin("first")).rejects.toThrow(
      "fresh live frame",
    );
    expect(f.commands.every((c) => c.op !== "focus_region")).toBe(true);
  });

  it.each([
    { executor: "native", state: "working" },
    { state: "paused" },
    { state: "uncertain" },
    { hold: { active: true } },
    { viewingStopped: true },
    { pendingDelivery: true },
    { cursor: 1 },
    { actions: [{ state: "unknown" }] },
    { leases: [{ state: "unknown" }] },
  ])(
    "refuses camera effects while execution is not idle: %j",
    async (patch) => {
      const f = fixture();
      Object.assign(f.execution, patch);
      await expect(f.controller.begin("first")).rejects.toThrow(
        "released native ownership",
      );
      expect(f.commands).toHaveLength(0);
    },
  );

  it("observes Stop during awaited camera readiness and submits no effect", async () => {
    const f = fixture();
    f.ports.cameraStatus.mockImplementation(async () => ({
      ...f.camera,
      state: "unavailable",
    }));
    await expect(f.controller.begin("first")).rejects.toThrow(
      "fresh live frame",
    );
    expect(f.commands).toHaveLength(0);
  });

  it.each([
    { executor: "native", state: "working" },
    { epoch: 3 },
    { cursor: 1, acknowledgedCursor: 1 },
    { hold: { active: true } },
  ])("rejects execution drift during camera readiness: %j", async (patch) => {
    const f = fixture();
    f.ports.cameraStatus.mockImplementation(async () => {
      Object.assign(f.execution, patch);
      return structuredClone(f.camera);
    });
    await expect(f.controller.begin("first")).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
  });

  it("interrupts an in-flight focus, suppresses its annotation, then clears and overviews", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.ports.cameraCommand.mockImplementation(async (command) => {
      f.commands.push(command);
      if (command.op === "focus_region") {
        entered();
        await waiting;
      }
      return {
        version: 1,
        commandId: command.commandId,
        revision: ++f.camera.revision,
        state: "accepted",
      };
    });
    const verification = f.verification();
    const presenting = f.controller.present(verification, rect);
    const failed = expect(presenting).rejects.toThrow("interrupted");
    await started;
    const interrupting = f.controller.interrupt();
    release();
    await failed;
    expect((await interrupting).phase).toBe("interrupted");
    expect(f.commands.map((c) => c.op)).toEqual([
      "clear",
      "overview",
      "focus_region",
      "clear",
      "overview",
    ]);
    expect(() => f.controller.present(verification, rect)).toThrow(
      "interrupted",
    );
  });

  it("reports only allowlisted HTTP status and command metadata after a failed camera write", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    f.ports.cameraCommand.mockRejectedValueOnce(
      new ApiError(409, "private upstream details"),
    );
    await expect(f.controller.present(f.verification(), rect)).rejects.toThrow(
      "focus_region, HTTP 409",
    );
    expect(f.controller.status().cameraFailure).toEqual({
      commandId: f.controller.status().unknownCommandId,
      op: "focus_region",
      httpStatus: 409,
    });
    expect(JSON.stringify(f.controller.status())).not.toContain(
      "private upstream details",
    );
    expect(f.ports.cameraCommand).toHaveBeenCalledTimes(3);
  });

  it("stops on an uncertain write and never retries it through present, next or interrupt", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    f.ports.cameraCommand.mockRejectedValueOnce(
      new Error("synthetic network loss"),
    );
    await expect(f.controller.present(f.verification(), rect)).rejects.toThrow(
      "unknown",
    );
    expect(f.controller.status().unknownCommandId).toMatch(/^scene-/);
    const count = f.ports.cameraCommand.mock.calls.length;
    expect(() => f.controller.next()).toThrow("unknown");
    expect(() =>
      f.controller.replan(
        { ...f.controller.status().plan, id: "followup" },
        f.controller.status().generation,
      ),
    ).toThrow("unknown");
    expect(() => f.controller.interrupt()).toThrow("unknown");
    expect(() => f.controller.present(f.verification(), rect)).toThrow(
      "unknown",
    );
    expect(f.ports.cameraCommand.mock.calls).toHaveLength(count);
  });

  it("revalidates after focus before adding marks and bounds the plan lifetime", async () => {
    const f = fixture();
    await f.controller.begin("first");
    await f.controller.observe();
    f.ports.cameraCommand.mockImplementation(async (command) => {
      f.commands.push(command);
      f.camera.contentRevision = "changed";
      return {
        version: 1,
        commandId: command.commandId,
        revision: ++f.camera.revision,
        state: "accepted",
      };
    });
    await expect(f.controller.present(f.verification(), rect)).rejects.toThrow(
      "stale",
    );
    expect(f.commands.at(-1)?.op).toBe("focus_region");
    f.setTime(910_000);
    expect(f.controller.status().phase).toBe("expired");
    expect(() => f.controller.begin("first")).toThrow("expired");
  });
});
