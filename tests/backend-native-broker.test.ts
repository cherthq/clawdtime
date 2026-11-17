import { dirname } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewNativeBroker } from "../scripts/preview-native-broker.js";

const cleanup: PreviewNativeBroker[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const broker of cleanup.splice(0)) {
    await broker.close();
    rmSync(dirname(broker.journalPath), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function fixture() {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const window = {
    appId: "com.apple.finder",
    windowId: "12",
    ownerPid: 71,
    displayId: 2,
  };
  const scene = {
    generation: 1,
    phase: "awaiting_verification",
    scene: { id: "scene", window },
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
    actions: [],
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
        expiresAt: now + 60_000,
      },
    ],
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
    window,
    observedAt: now,
    processIdentity: "process-71-start-1",
    windowBounds: { x: 100, y: 100, width: 500, height: 400 },
    appActive: true,
    windowFocused: true,
    windowOnScreen: true,
  };
  const app = new Hono();
  const cameraStatus = vi.fn(async () => structuredClone(camera));
  let latest: any;
  let dispatchHook: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      expect(
        url.startsWith("http://synthetic.invalid/sessions/media/native/"),
      ).toBe(true);
      calls.push(url.split("/native/")[1]!);
      if (url.endsWith("/qualify")) return Response.json(observation);
      if (url.endsWith("/execute")) {
        const { operation, fingerprint } = JSON.parse(String(init?.body));
        const saved = JSON.parse(readFileSync(broker.journalPath, "utf8"));
        expect(saved.receipts[0].phase).toBe("dispatching");
        latest = {
          operationId: operation.operationId,
          state: "returned",
          reason: "native_call_returned",
          terminalEvidence: {
            receiptId: "host-receipt",
            operationId: operation.operationId,
            fingerprint,
            hostId: "clawdtime-local-native",
            completedAt: now,
          },
          observation,
        };
        await dispatchHook?.();
        return Response.json(latest);
      }
      if (url.includes("/receipts/")) return Response.json(latest);
      throw new Error("Unexpected synthetic host route");
    });
  const broker = new PreviewNativeBroker({
    app,
    mediaSessionId: "media",
    token: "bridge-token",
    nativeHostToken: "synthetic-host-token-32-characters-minimum",
    requestId: "request",
    sessionId: "session",
    displayId: 2,
    scenes: () => ({ status: () => structuredClone(scene) }) as any,
    executionStatus: async () => structuredClone(owner),
    cameraStatus,
    mediaOrigin: () => "http://synthetic.invalid",
    shuttingDown: () => false,
  });
  cleanup.push(broker);
  const prepare = () =>
    broker.prepare({
      operationId: "operation",
      sceneId: "scene",
      action: "activate_app",
      window,
    });
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`/local-native/media/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer bridge-token",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    broker,
    owner,
    scene,
    cameraStatus,
    prepare,
    request,
    calls,
    fetchMock,
    setDispatchHook: (hook: () => Promise<void>) => {
      dispatchHook = hook;
    },
  };
}

describe("local native broker with synthetic host only", () => {
  it("returns a fixed qualification refusal without exposing other response fields", async () => {
    const f = fixture();
    f.fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: "native_qualification_unavailable",
          reason: "ax_windows_unavailable",
          privateDetail: "synthetic-private-window-title",
        },
        { status: 409 },
      ),
    );
    await expect(f.prepare()).rejects.toThrow(
      "Native qualification refused (ax_windows_unavailable); no input dispatched.",
    );
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(f.broker.status().receipts.operations).toEqual([]);
  });

  it.each([
    {
      error: "native_qualification_unavailable",
      reason: "synthetic-private-window-title",
    },
    {
      error: "synthetic-private-window-title",
      reason: "ax_windows_unavailable",
    },
    {
      error: "native_qualification_unavailable",
      reason: { message: "synthetic-private-window-title" },
    },
    "synthetic-private-window-title",
  ])(
    "replaces unknown or malformed qualification response with a generic error",
    async (body) => {
      const f = fixture();
      f.fetchMock.mockResolvedValueOnce(
        typeof body === "string"
          ? new Response(body, { status: 409 })
          : Response.json(body, { status: 409 }),
      );
      await expect(f.prepare()).rejects.toThrow(
        "Native host request refused; inspect the original receipt.",
      );
      expect(f.fetchMock).toHaveBeenCalledTimes(1);
      expect(f.broker.status().receipts.operations).toEqual([]);
    },
  );

  it("admits only authenticated server requests and exact prepared IDs", async () => {
    const f = fixture();
    expect(
      (
        await f.request("status", undefined, {
          Authorization: "Bearer foreign",
        })
      ).status,
    ).toBe(401);
    expect(
      (await f.request("status", undefined, { Origin: "http://localhost" }))
        .status,
    ).toBe(403);
    expect(
      (await f.request("execute", { operationId: "foreign" })).status,
    ).toBe(409);
    await f.prepare();
    expect(f.broker.status().state).toBe("prepared");
    expect(
      (
        await f.request("execute", {
          operationId: "operation",
          action: "raise_window",
        })
      ).status,
    ).toBe(409);
    expect(f.calls).toEqual(["qualify"]);
    for (const [, init] of f.fetchMock.mock.calls)
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer synthetic-host-token-32-characters-minimum",
      );
  });

  it("reserves durable intent and does not replay duplicate prepared execution", async () => {
    const f = fixture();
    await f.prepare();
    const first = await f.request("execute", { operationId: "operation" });
    expect(first.status).toBe(200);
    expect((await first.json()).phase).toBe("verified");
    expect(
      (await f.request("execute", { operationId: "operation" })).status,
    ).toBe(200);
    expect(f.calls.filter((x) => x === "execute")).toHaveLength(1);
    await f.broker.close();
    expect(existsSync(f.broker.journalPath)).toBe(true);
    expect(
      JSON.parse(readFileSync(f.broker.journalPath, "utf8")).receipts[0].phase,
    ).toBe("verified");
  });

  it.each(["stop", "scene", "epoch"])(
    "refuses stale prepared authority after %s",
    async (change) => {
      const f = fixture();
      await f.prepare();
      if (change === "stop") f.owner.viewingStopped = true;
      if (change === "scene") f.scene.generation++;
      if (change === "epoch") f.owner.epoch++;
      expect(
        (await f.request("execute", { operationId: "operation" })).status,
      ).toBe(409);
      expect(f.calls).toEqual(["qualify"]);
    },
  );

  it("rejects authority changed during awaited camera status", async () => {
    const f = fixture();
    await f.prepare();
    const operation = f.broker.status().prepared!;
    f.cameraStatus.mockImplementationOnce(async () => {
      f.owner.viewingStopped = true;
      return f.cameraStatus.mock.results[0]!.value as Promise<any>;
    });
    expect((await f.request("authority", { operation })).status).toBe(409);
    expect(f.calls).toEqual(["qualify"]);
  });

  it("retains terminal evidence after Stop and blocks transfer until GET reconciliation", async () => {
    const f = fixture();
    await f.prepare();
    f.setDispatchHook(async () => {
      f.owner.viewingStopped = true;
    });
    const response = await f.request("execute", { operationId: "operation" });
    const result = await response.json();
    expect(result.phase).toBe("uncertain");
    expect(result.hostResult.terminalEvidence.receiptId).toBe("host-receipt");
    expect(f.broker.hasUnresolvedActor()).toBe(true);
    await f.broker.reconcile("operation");
    expect(f.broker.hasUnresolvedActor()).toBe(false);
    expect(f.calls.filter((x) => x === "execute")).toHaveLength(1);
    expect(f.calls.at(-1)).toBe("receipts/operation");
    expect(f.broker.status().receipts.operations[0].phase).toBe("returned");
  });

  it("waits for in-flight dispatch before closing its durable journal", async () => {
    const f = fixture();
    await f.prepare();
    const entered = deferred();
    const finish = deferred();
    f.setDispatchHook(async () => {
      entered.resolve();
      await finish.promise;
    });
    const request = f.request("execute", { operationId: "operation" });
    await entered.promise;
    let closed = false;
    const closing = f.broker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(existsSync(`${f.broker.journalPath}.lock`)).toBe(true);
    await expect(f.prepare()).rejects.toThrow("closed");
    finish.resolve();
    await request;
    await closing;
    expect(existsSync(`${f.broker.journalPath}.lock`)).toBe(false);
    expect(
      JSON.parse(readFileSync(f.broker.journalPath, "utf8")).receipts[0].phase,
    ).toBe("verified");
    expect(f.calls.filter((x) => x === "execute")).toHaveLength(1);
  });
});
