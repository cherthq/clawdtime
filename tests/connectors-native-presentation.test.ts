import { describe, expect, it, vi } from "vitest";
import {
  NativePresentationExecutor,
  validateNativePresentationAuthority,
} from "../connectors/shared/native-presentation-executor.js";
import type { NativePresentationOperation } from "../src/native-presentation-contracts.js";

function fixture() {
  const now = 10_000;
  const operation: NativePresentationOperation = {
    version: 1,
    operationId: "operation",
    sceneId: "scene",
    generation: 1,
    action: "activate_app",
    window: {
      appId: "com.apple.finder",
      windowId: "12",
      ownerPid: 71,
      displayId: 2,
    },
    expected: {
      requestId: "request",
      sessionId: "session",
      leaseId: "lease",
      epoch: 3,
      cursor: 4,
      policyRevision: 1,
      displayId: 2,
    },
  };
  const owner = {
    requestId: "request",
    sessionId: "session",
    executor: "native",
    state: "working",
    epoch: 3,
    cursor: 4,
    acknowledgedCursor: 4,
    policyRevision: 1,
    pendingDelivery: false,
    viewingStopped: false,
    hold: { active: false },
    leases: [
      {
        id: "lease",
        state: "active",
        sessionId: "session",
        requestId: "request",
        executor: "native",
        executorEpoch: 3,
        policyRevision: 1,
        displayId: "2",
        expiresAt: 30_000,
      },
    ],
    actions: [] as { state: string }[],
  };
  const camera = {
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
    source: {
      width: 1000,
      height: 800,
      originX: 0,
      originY: 0,
      pointWidth: 1000,
      pointHeight: 800,
      displayOriginX: 0,
      displayOriginY: 0,
      displayPointWidth: 1000,
      displayPointHeight: 800,
    },
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
  const observation = {
    window: operation.window,
    observedAt: now,
    processIdentity: "process-71-start-1",
    windowBounds: { x: 100, y: 100, width: 500, height: 400 },
    appActive: false,
    windowFocused: false,
    windowOnScreen: false,
  };
  let records: unknown[] = [];
  let latest: unknown = null;
  const journal = {
    read: () => structuredClone(records),
    write: vi.fn((next: unknown[]) => {
      records = structuredClone(next);
    }),
  };
  const terminal = (op: NativePresentationOperation, fingerprint: string) => ({
    operationId: op.operationId,
    state: "returned",
    reason: "native_call_returned",
    terminalEvidence: {
      receiptId: "host-receipt",
      operationId: op.operationId,
      fingerprint,
      hostId: "host",
      completedAt: now,
    },
    observation: {
      ...observation,
      appActive: true,
      windowFocused: true,
      windowOnScreen: true,
    },
  });
  const host = {
    capabilities: () => ({
      hostId: "host",
      actions: ["activate_app", "raise_window"] as (
        "activate_app" | "raise_window"
      )[],
      activationObserved: false,
      terminalEvidence: true,
    }),
    qualify: vi.fn(async (_op: NativePresentationOperation) =>
      structuredClone(observation),
    ),
    dispatch: vi.fn(
      async (
        op: NativePresentationOperation,
        fingerprint: string,
      ): Promise<unknown> => {
        expect((journal.read()[0] as any).phase).toBe("dispatching");
        latest = terminal(op, fingerprint);
        return structuredClone(latest);
      },
    ),
    receipt: vi.fn(
      async (_id: string, _fingerprint: string): Promise<unknown> =>
        structuredClone(latest),
    ),
  };
  const options = {
    journal,
    host,
    executionStatus: vi.fn(async () => structuredClone(owner)),
    cameraStatus: vi.fn(async () => structuredClone(camera)),
    clock: () => now,
  };
  const executor = new NativePresentationExecutor(options);
  return {
    operation,
    owner,
    camera,
    observation,
    journal,
    host,
    options,
    executor,
    terminal,
    setRecords: (value: unknown[]) => {
      records = structuredClone(value);
    },
    setLatest: (value: unknown) => {
      latest = value;
    },
  };
}

describe("qualified original-chat native presentation executor", () => {
  it("prepares without input and durably reserves one dispatch before verifying exact observed result", async () => {
    const f = fixture();
    const prepared = await f.executor.prepare(f.operation);
    expect(prepared.phase).toBe("prepared");
    expect(f.host.dispatch).not.toHaveBeenCalled();
    const result = await f.executor.executePrepared("operation");
    expect(result.phase).toBe("verified");
    expect((f.executor.status() as any).capabilities.activationObserved).toBe(
      false,
    );
    expect(await f.executor.executePrepared("operation")).toEqual(result);
    expect(await f.executor.prepare(f.operation)).toEqual(result);
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    await expect(
      f.executor.prepare({ ...f.operation, action: "raise_window" }),
    ).rejects.toThrow("different immutable");
  });
  it("allows a separately prepared raise after terminal app activation without claiming exact-window success", async () => {
    const f = fixture();
    f.host.dispatch.mockImplementation(async (operation, fingerprint) => {
      const reserved: any = f.journal
        .read()
        .find(
          (entry: any) => entry.operation.operationId === operation.operationId,
        );
      expect(reserved.phase).toBe("dispatching");
      if (operation.action === "activate_app") {
        Object.assign(f.observation, { appActive: true, windowOnScreen: true });
        return {
          ...f.terminal(operation, fingerprint),
          observation: structuredClone(f.observation),
        };
      }
      expect(f.observation.appActive).toBe(true);
      return f.terminal(operation, fingerprint);
    });
    await f.executor.prepare(f.operation);
    const activated = await f.executor.executePrepared(f.operation.operationId);
    expect(activated.phase).toBe("returned");
    expect(activated.hostResult?.observation).toMatchObject({
      appActive: true,
      windowFocused: false,
    });
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    const raise: NativePresentationOperation = {
      ...f.operation,
      operationId: "raise-exact-window",
      action: "raise_window",
    };
    await f.executor.prepare(raise);
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    const raised = await f.executor.executePrepared(raise.operationId);
    expect(raised.phase).toBe("verified");
    expect(f.host.qualify).toHaveBeenCalledTimes(4);
    expect(f.host.dispatch).toHaveBeenCalledTimes(2);
    expect(f.executor.status(f.operation.operationId)).toEqual(activated);
    expect(await f.executor.executePrepared(raise.operationId)).toEqual(raised);
    expect(f.host.dispatch).toHaveBeenCalledTimes(2);
  });
  it("refuses an inactive app before preparing a raise or dispatching a previously prepared raise", async () => {
    const f = fixture();
    const raise: NativePresentationOperation = {
      ...f.operation,
      action: "raise_window",
    };
    await expect(f.executor.prepare(raise)).rejects.toThrow("frontmost");
    expect(f.host.dispatch).not.toHaveBeenCalled();
    f.observation.appActive = true;
    await f.executor.prepare(raise);
    f.observation.appActive = false;
    const rejected = await f.executor.executePrepared(raise.operationId);
    expect(rejected.phase).toBe("rejected");
    expect(rejected.reason).toBe("pre_dispatch_guard_rejected");
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });
  it("retains terminal unverified evidence when a raised app loses foreground afterward", async () => {
    const f = fixture();
    const raise: NativePresentationOperation = {
      ...f.operation,
      action: "raise_window",
    };
    f.observation.appActive = true;
    f.host.dispatch.mockImplementation(async (operation, fingerprint) => ({
      ...f.terminal(operation, fingerprint),
      observation: { ...f.observation, appActive: false },
    }));
    await f.executor.prepare(raise);
    const result = await f.executor.executePrepared(raise.operationId);
    expect(result.phase).toBe("returned");
    expect(result.hostResult?.terminalEvidence).toBeDefined();
    expect(await f.executor.executePrepared(raise.operationId)).toEqual(result);
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { executor: "none" },
    { epoch: 4 },
    { sessionId: "other" },
    { requestId: "other" },
    { cursor: 5 },
    { pendingDelivery: true },
    { hold: { active: true } },
    { policyRevision: 2 },
    { viewingStopped: true },
    { state: "uncertain" },
    { actions: [{ state: "unknown" }] },
  ])("refuses invalid authority before preparing: %j", async (patch) => {
    const f = fixture();
    Object.assign(f.owner, patch);
    await expect(f.executor.prepare(f.operation)).rejects.toThrow();
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });
  it("bounds the authority grant by current lease expiry and rejects expired leases", () => {
    const f = fixture();
    f.owner.leases[0]!.expiresAt = 10_500;
    expect(
      validateNativePresentationAuthority(
        f.operation,
        f.owner,
        f.camera,
        10_000,
      ).expiresAt,
    ).toBe(10_500);
    f.owner.leases[0]!.expiresAt = 10_000;
    expect(() =>
      validateNativePresentationAuthority(
        f.operation,
        f.owner,
        f.camera,
        10_000,
      ),
    ).toThrow();
  });
  it("rechecks native ownership after awaited target qualification and camera reads", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.host.qualify.mockImplementation(async () => {
      f.owner.epoch++;
      return structuredClone(f.observation);
    });
    expect((await f.executor.executePrepared("operation")).phase).toBe(
      "rejected",
    );
    expect(f.host.dispatch).not.toHaveBeenCalled();
    const g = fixture();
    g.options.cameraStatus.mockImplementation(async () => {
      g.owner.viewingStopped = true;
      return structuredClone(g.camera);
    });
    await expect(g.executor.prepare(g.operation)).rejects.toThrow();
    expect(g.host.dispatch).not.toHaveBeenCalled();
  });
  it("internally rejects denied apps, foreign windows, stale witnesses and windows crossing the display", async () => {
    const f = fixture();
    await expect(
      f.executor.prepare({
        ...f.operation,
        window: { ...f.operation.window, appId: "com.openai.codex" },
      }),
    ).rejects.toThrow();
    f.observation.window = { ...f.operation.window, windowId: "13" };
    await expect(f.executor.prepare(f.operation)).rejects.toThrow(
      "target identity",
    );
    f.observation.window = f.operation.window;
    f.observation.observedAt = 7999;
    await expect(f.executor.prepare(f.operation)).rejects.toThrow(
      "target identity",
    );
    f.observation.observedAt = 10000;
    f.observation.windowBounds.x = -10;
    await expect(f.executor.prepare(f.operation)).rejects.toThrow(
      "target identity",
    );
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });
  it("refuses PID reuse or target geometry change between preparation and dispatch", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.observation.processIdentity = "different-process-start";
    expect((await f.executor.executePrepared("operation")).phase).toBe(
      "rejected",
    );
    expect(f.host.dispatch).not.toHaveBeenCalled();
    const g = fixture();
    await g.executor.prepare(g.operation);
    g.observation.windowBounds.width++;
    expect((await g.executor.executePrepared("operation")).phase).toBe(
      "rejected",
    );
    expect(g.host.dispatch).not.toHaveBeenCalled();
  });
  it("preserves a timeout as uncertain and reconciles only the original host receipt", async () => {
    const f = fixture();
    const prepared = await f.executor.prepare(f.operation);
    f.host.dispatch.mockRejectedValueOnce(new Error("synthetic lost response"));
    expect((await f.executor.executePrepared("operation")).phase).toBe(
      "uncertain",
    );
    expect((await f.executor.executePrepared("operation")).phase).toBe(
      "uncertain",
    );
    await expect(
      f.executor.prepare({ ...f.operation, operationId: "replacement" }),
    ).rejects.toThrow("unresolved");
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
    f.setLatest(f.terminal(f.operation, prepared.fingerprint));
    const reconciled = await f.executor.reconcile("operation");
    expect(reconciled.phase).toBe("returned");
    expect(reconciled.reason).toBe("host_terminal_reconciled_not_ui_verified");
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });
  it("keeps Stop during dispatch uncertain while preserving authentic host completion evidence", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.host.dispatch.mockImplementation(async (op, fingerprint) => {
      f.owner.viewingStopped = true;
      return f.terminal(op, fingerprint);
    });
    const result = await f.executor.executePrepared("operation");
    expect(result.phase).toBe("uncertain");
    expect(result.hostResult?.terminalEvidence?.operationId).toBe("operation");
    expect(f.owner.viewingStopped).toBe(true);
  });
  it("does not accept unmatched terminal identity or API return as UI verification", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.host.dispatch.mockImplementation(async (op, fingerprint) => ({
      ...f.terminal(op, fingerprint),
      terminalEvidence: {
        ...f.terminal(op, fingerprint).terminalEvidence,
        hostId: "other-host",
      },
    }));
    expect((await f.executor.executePrepared("operation")).phase).toBe(
      "uncertain",
    );
    const g = fixture();
    await g.executor.prepare(g.operation);
    g.host.dispatch.mockImplementation(async (op, fingerprint) => ({
      ...g.terminal(op, fingerprint),
      observation: g.observation,
    }));
    expect((await g.executor.executePrepared("operation")).phase).toBe(
      "returned",
    );
  });
  it("recovers an interrupted reserved dispatch as uncertain and never replays it", async () => {
    const f = fixture();
    const prepared = await f.executor.prepare(f.operation);
    f.setRecords([{ ...prepared, phase: "dispatching" }]);
    const restarted = new NativePresentationExecutor(f.options);
    expect((await restarted.executePrepared("operation")).phase).toBe(
      "uncertain",
    );
    expect(f.host.dispatch).not.toHaveBeenCalled();
  });

  it("does not bypass uncertain state using preserved terminal evidence or a replacement ID", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.host.dispatch.mockImplementation(async (op, fingerprint) => {
      f.owner.viewingStopped = true;
      return f.terminal(op, fingerprint);
    });
    await f.executor.executePrepared("operation");
    f.owner.viewingStopped = false;
    await expect(
      f.executor.prepare({ ...f.operation, operationId: "replacement" }),
    ).rejects.toThrow("unresolved");
    expect(f.host.dispatch).toHaveBeenCalledTimes(1);
  });

  it("a host return without post-observation is terminal but never visually verified", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.host.dispatch.mockImplementation(async (op, fingerprint) => {
      const { observation: _, ...result } = f.terminal(op, fingerprint);
      return result;
    });
    expect((await f.executor.executePrepared("operation")).phase).toBe(
      "returned",
    );
  });
  it("does not dispatch if the pre-effect journal flush fails", async () => {
    const f = fixture();
    await f.executor.prepare(f.operation);
    f.journal.write.mockImplementationOnce(() => {
      throw new Error("synthetic flush failure");
    });
    await expect(f.executor.executePrepared("operation")).rejects.toThrow(
      "persistence failed",
    );
    expect(f.host.dispatch).not.toHaveBeenCalled();
    await expect(f.executor.executePrepared("operation")).rejects.toThrow(
      "journal is unavailable",
    );
  });

  it.each(["hostId", "operationId", "fingerprint"] as const)(
    "rejects restored completion evidence with mismatched %s",
    async (field) => {
      const f = fixture();
      const prepared = await f.executor.prepare(f.operation);
      const result = f.terminal(f.operation, prepared.fingerprint);
      result.terminalEvidence[field] =
        field === "fingerprint" ? "0".repeat(64) : "other";
      f.setRecords([{ ...prepared, phase: "uncertain", hostResult: result }]);
      expect(() => new NativePresentationExecutor(f.options)).toThrow(
        "terminal evidence",
      );
      expect(f.host.dispatch).not.toHaveBeenCalled();
    },
  );
});
