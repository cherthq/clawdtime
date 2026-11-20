import { afterEach, describe, expect, it, vi } from "vitest";
import { BundledCuaNative } from "../src/control/bundled-cua-native.js";
import type { BundledCuaConfig } from "../src/control/cua-contracts.js";

const config: NonNullable<BundledCuaConfig["native"]> = {
  origin: "http://127.0.0.1:9988",
  token: "fixture-native-token".repeat(3),
  deviceId: "fixture_device",
  executorId: "fixture_executor",
  displayId: 1,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
function fixture() {
  let now = 1_000_000;
  let lease: Record<string, unknown> | undefined;
  let frame = 0;
  let focus = "a".repeat(64);
  const status = {
    deviceId: config.deviceId,
    localEnabled: true,
    armed: true,
    available: true,
    screenPermission: true,
    controlPermission: true,
    policyRevision: 3,
    activeSessionId: null as string | null,
    unresolvedActions: 0,
  };
  const dispatch = vi.fn(
    async (url: string, init: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path.endsWith("/status")) return json(status);
      if (path.endsWith("/sessions")) {
        lease = JSON.parse(String(init.body));
        return json(lease);
      }
      if (path.endsWith("/renew")) return json(JSON.parse(String(init.body)));
      if (path.endsWith("/stop")) return json({ stopped: true });
      if (path.endsWith("/frame"))
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          headers: {
            "content-type": "image/jpeg",
            "x-frame-id": `frame_${++frame}`,
            "x-captured-at": new Date(now).toISOString(),
            "x-frame-width": "1280",
            "x-frame-height": "800",
            "x-focus-identity": focus,
          },
        });
      if (path.endsWith("/actions")) {
        const input = JSON.parse(String(init.body));
        return json({
          ...lease,
          id: input.id,
          leaseId: lease!.id,
          state: "submitted",
        });
      }
      throw Error("Unexpected fake helper route");
    },
  );
  const request = vi.fn<typeof fetch>(async (input, init) =>
    dispatch(String(input), init!),
  );
  const native = new BundledCuaNative(config, request, () => now);
  const signal = new AbortController().signal;
  const task = {
    taskId: "fixture_task",
    sessionId: "fixture_session",
    expiresAt: now + 60_000,
  };
  cleanups.push(async () => {
    await native.stop().catch(() => {});
  });
  const calls = (suffix: string) =>
    request.mock.calls.filter(([url]) => String(url).endsWith(suffix));
  return {
    native,
    request,
    dispatch,
    status,
    task,
    signal,
    calls,
    lease: () => lease,
    advance: (ms: number) => {
      now += ms;
    },
    focus: (value: string) => {
      focus = value;
    },
  };
}

describe("app-owned native helper adapter", () => {
  it("uses authenticated loopback local-task leases without fabricated call identity", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    expect(f.lease()).toMatchObject({
      id: "local_fixture_session",
      sessionId: f.task.sessionId,
      taskId: f.task.taskId,
      executorId: config.executorId,
      deviceId: config.deviceId,
      policyRevision: 3,
    });
    expect(f.lease()).not.toHaveProperty("callId");
    expect(f.lease()).not.toHaveProperty("pairingId");
    for (const [url, init] of f.request.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:9988\/local\/v1\//);
      expect(new Headers(init!.headers).get("authorization")).toBe(
        `Bearer ${config.token}`,
      );
      expect(init!.redirect).toBe("error");
    }
  });

  it.each([
    "https://example.com",
    "http://localhost:9988",
    "http://127.0.0.1:9988/elsewhere",
  ])("rejects non-exact loopback origin %s", (origin) => {
    expect(
      () => new BundledCuaNative({ ...config, origin }, vi.fn()),
    ).toThrow();
  });

  it.each([
    { localEnabled: false },
    { armed: false },
    { available: false },
    { screenPermission: false },
    { controlPermission: false },
    { deviceId: "other_device" },
    { activeSessionId: "other_owner" },
    { unresolvedActions: 1 },
  ])(
    "does not allocate authority when readiness is invalid: %j",
    async (invalid) => {
      const f = fixture();
      Object.assign(f.status, invalid);
      await expect(f.native.open(f.task, f.signal)).rejects.toThrow();
      expect(f.calls("/sessions")).toHaveLength(0);
    },
  );

  it("requires the helper to echo the exact admitted lease", async () => {
    const f = fixture();
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) =>
      url.endsWith("/sessions")
        ? json({ ...JSON.parse(String(init.body)), deviceId: "wrong_device" })
        : normal(url, init),
    );
    await expect(f.native.open(f.task, f.signal)).rejects.toThrow();
  });

  it("binds observation fingerprints to focused control identity", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const before = await f.native.observe(f.signal);
    f.advance(300);
    f.focus("b".repeat(64));
    const after = await f.native.observe(f.signal);
    expect(after.imageDataUrl).toBe(before.imageDataUrl);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.imageDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(
      await f.native.authorize({ type: "click", x: 0.5, y: 0.5 }, after),
    ).toBe("confirm");
  });

  it("refuses absent focus identity and stale captured frames", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (url.endsWith("/frame")) response.headers.delete("x-focus-identity");
      return response;
    });
    await expect(f.native.observe(f.signal)).rejects.toThrow();
    f.advance(300);
    f.dispatch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (url.endsWith("/frame"))
        response.headers.set("x-captured-at", new Date(1).toISOString());
      return response;
    });
    await expect(f.native.observe(f.signal)).rejects.toThrow();
  });

  it("permits observation and click review with explicit no-focus but refuses typing", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    f.focus("none");
    const frame = await f.native.observe(f.signal);
    expect(JSON.parse(frame.context).focus).toBe("none");
    expect(
      await f.native.authorize({ type: "click", x: 0.5, y: 0.5 }, frame),
    ).toBe("confirm");
    expect(
      await f.native.authorize({ type: "type", text: "fixture" }, frame),
    ).toBe("refused");
    await expect(
      f.native.execute(
        {
          actionId: "action_1",
          observationId: frame.id,
          action: { type: "type", text: "fixture" },
        },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it("does not retry unknown input or reuse its capture", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const frame = await f.native.observe(f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      if (url.endsWith("/actions")) throw Error("Lost helper response");
      return normal(url, init);
    });
    const input = {
      actionId: "action_1",
      observationId: frame.id,
      action: { type: "click" as const, x: 0.5, y: 0.5 },
    };
    await expect(f.native.execute(input, f.signal)).rejects.toThrow();
    await expect(f.native.execute(input, f.signal)).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(1);
  });

  it.each([
    "id",
    "leaseId",
    "sessionId",
    "deviceId",
    "taskId",
    "executorId",
    "executorEpoch",
    "policyRevision",
  ])("rejects a receipt bound to a different %s", async (field) => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const frame = await f.native.observe(f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (!url.endsWith("/actions")) return response;
      return json({
        ...(await response.json()),
        [field]:
          field.endsWith("Epoch") || field === "policyRevision"
            ? 999
            : "wrong_identity",
      });
    });
    await expect(
      f.native.execute(
        {
          actionId: "action_1",
          observationId: frame.id,
          action: { type: "type", text: "fixture" },
        },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(1);
  });

  it("keeps Stop sticky if a status response arrives afterward", async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      if (url.endsWith("/status")) await held;
      return normal(url, init);
    });
    const opening = f.native.open(f.task, f.signal);
    await f.native.stop();
    release();
    await expect(opening).rejects.toThrow();
    expect(f.calls("/sessions")).toHaveLength(0);
  });

  it("waits for in-flight renewal before Stop and never renews again", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.native.open(f.task, f.signal);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      if (url.endsWith("/renew")) await held;
      return normal(url, init);
    });
    f.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls("/renew")).toHaveLength(1);
    const stopping = f.native.stop();
    expect(f.calls("/stop")).toHaveLength(0);
    release();
    await stopping;
    expect(f.calls("/stop")).toHaveLength(1);
    f.advance(20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.calls("/renew")).toHaveLength(1);
    await expect(f.native.observe(f.signal)).rejects.toThrow();
  });

  it("fences further observation after renewal returns another owner", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) =>
      url.endsWith("/renew")
        ? json({ ...JSON.parse(String(init.body)), executorEpoch: 123 })
        : normal(url, init),
    );
    f.advance(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(f.native.observe(f.signal)).rejects.toThrow();
    expect(f.calls("/frame")).toHaveLength(0);
  });

  it("does not send input from a frame older than the action freshness bound", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const frame = await f.native.observe(f.signal);
    f.advance(2_001);
    await expect(
      f.native.execute(
        {
          actionId: "action_1",
          observationId: frame.id,
          action: { type: "type", text: "fixture" },
        },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it("does not claim cleanup succeeded when helper Stop cannot be confirmed", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) =>
      url.endsWith("/stop") ? json({ stopped: false }) : normal(url, init),
    );
    await expect(f.native.stop()).rejects.toThrow();
    await expect(f.native.observe(f.signal)).rejects.toThrow();
  });
});
