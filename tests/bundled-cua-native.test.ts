import { afterEach, describe, expect, it, vi } from "vitest";
import { BundledCuaNative } from "../src/control/bundled-cua-native.js";
import {
  CuaInputNotDispatched,
  type BundledCuaConfig,
} from "../src/control/cua-contracts.js";

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
            "x-local-targets": Buffer.from(
              JSON.stringify({ untrusted: true, targets: [] }),
            ).toString("base64"),
          },
        });
      if (path.endsWith("/revalidate")) {
        const input = JSON.parse(String(init.body));
        return json({
          valid: true,
          proofId: "proof_1",
          plannedFrameId: input.plannedFrameId,
          currentFrameId: input.currentFrameId,
        });
      }
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

describe("native capture drain for phone ownership", () => {
  it("checks an idle updated helper without starting capture or a lease", async () => {
    const f = fixture();
    await expect(f.native.assertReviewIdle()).rejects.toThrow(
      "confirmed idle capture",
    );
    Object.assign(f.status, { nativeCaptureDrain: true, captureActive: false });
    await expect(f.native.assertReviewIdle()).resolves.toBeUndefined();
    Object.assign(f.status, { captureActive: true });
    await expect(f.native.assertReviewIdle()).rejects.toThrow(
      "confirmed idle capture",
    );
    expect(f.calls("/sessions")).toHaveLength(0);
    expect(f.calls("/frame")).toHaveLength(0);
  });
  it("refuses an older helper before acquiring any local lease", async () => {
    const f = fixture();
    const native = new BundledCuaNative(
      config,
      f.request,
      () => 1_000_000,
      true,
    );
    await expect(native.open(f.task, f.signal)).rejects.toThrow(
      "confirmed capture drain",
    );
    expect(f.calls("/sessions")).toHaveLength(0);
  });
  it("requires explicit captureStopped proof after lease revocation", async () => {
    const f = fixture();
    Object.assign(f.status, { nativeCaptureDrain: true });
    const native = new BundledCuaNative(
      config,
      f.request,
      () => 1_000_000,
      true,
    );
    await native.open(f.task, f.signal);
    await expect(native.stop()).rejects.toThrow("capture drain is unconfirmed");
    f.dispatch.mockImplementation(async () =>
      json({ stopped: true, captureStopped: true }),
    );
    await expect(native.stop()).resolves.toBeUndefined();
  });
});

function windowsFixture() {
  const f = fixture();
  const catalog = {
    untrusted: true,
    windows: [
      { id: "window_1", app: "Fixture App", title: "Existing fixture window" },
    ],
  };
  const normal = f.dispatch.getMockImplementation()!;
  f.dispatch.mockImplementation(async (url, init) => {
    const response = await normal(url, init);
    if (url.endsWith("/frame"))
      response.headers.set(
        "x-local-windows",
        Buffer.from(JSON.stringify(catalog)).toString("base64"),
      );
    return response;
  });
  return { ...f, catalog };
}

describe("app-owned native helper adapter", () => {
  it("requires an exact window catalog and proof before activation POST", async () => {
    const f = windowsFixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    const action = { type: "activate" as const, targetId: "window_1" };
    expect(await f.native.authorize(action, current)).toBe("confirm");
    await expect(
      f.native.execute(
        { actionId: "without_proof", observationId: current.id, action },
        f.signal,
      ),
    ).rejects.toBeInstanceOf(CuaInputNotDispatched);
    expect(f.calls("/actions")).toHaveLength(0);
    expect(await f.native.revalidate(action, planned, current, f.signal)).toBe(
      true,
    );
    await f.native.execute(
      { actionId: "action_1", observationId: current.id, action },
      f.signal,
    );
    expect(JSON.parse(String(f.calls("/actions")[0]![1]!.body))).toMatchObject({
      type: "activate",
      targetId: "window_1",
      localProofId: "proof_1",
    });
  });

  it("does not activate without a helper window catalog", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    const action = { type: "activate" as const, targetId: "window_1" };
    expect(await f.native.authorize(action, current)).toBe("refused");
    expect(await f.native.revalidate(action, planned, current, f.signal)).toBe(
      false,
    );
    await expect(
      f.native.execute(
        { actionId: "action_1", observationId: current.id, action },
        f.signal,
      ),
    ).rejects.toBeInstanceOf(CuaInputNotDispatched);
    expect(f.calls("/revalidate")).toHaveLength(0);
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it.each(["planned", "current"])(
    "requires activation window identity in the %s catalog",
    async (missing) => {
      const f = windowsFixture();
      await f.native.open(f.task, f.signal);
      if (missing === "planned") f.catalog.windows = [];
      const planned = await f.native.observe(f.signal);
      f.catalog.windows =
        missing === "current"
          ? []
          : [
              {
                id: "window_1",
                app: "Fixture App",
                title: "Existing fixture window",
              },
            ];
      f.advance(300);
      const current = await f.native.observe(f.signal);
      expect(
        await f.native.revalidate(
          { type: "activate", targetId: "window_1" },
          planned,
          current,
          f.signal,
        ),
      ).toBe(false);
      expect(f.calls("/revalidate")).toHaveLength(0);
      expect(f.calls("/actions")).toHaveLength(0);
    },
  );

  it("does not reuse activation proof for a different observed window", async () => {
    const f = windowsFixture();
    f.catalog.windows.push({
      id: "window_2",
      app: "Fixture App",
      title: "Another existing window",
    });
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    expect(
      await f.native.revalidate(
        { type: "activate", targetId: "window_1" },
        planned,
        current,
        f.signal,
      ),
    ).toBe(true);
    await expect(
      f.native.execute(
        {
          actionId: "action_1",
          observationId: current.id,
          action: { type: "activate", targetId: "window_2" },
        },
        f.signal,
      ),
    ).rejects.toBeInstanceOf(CuaInputNotDispatched);
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it.each([
    { untrusted: false, windows: [] },
    {
      untrusted: true,
      windows: [{ id: "bad/id", app: "App", title: "Window" }],
    },
    {
      untrusted: true,
      windows: [
        { id: "w", app: "App", title: "Window", launchCommand: "invented" },
      ],
    },
    {
      untrusted: true,
      windows: Array.from({ length: 21 }, (_, i) => ({
        id: `w_${i}`,
        app: "App",
        title: "Window",
      })),
    },
  ])(
    "rejects malformed or overbroad native window catalog %j",
    async (catalog) => {
      const f = fixture();
      await f.native.open(f.task, f.signal);
      const normal = f.dispatch.getMockImplementation()!;
      f.dispatch.mockImplementation(async (url, init) => {
        const response = await normal(url, init);
        if (url.endsWith("/frame"))
          response.headers.set(
            "x-local-windows",
            Buffer.from(JSON.stringify(catalog)).toString("base64"),
          );
        return response;
      });
      await expect(f.native.observe(f.signal)).rejects.toThrow();
      expect(f.calls("/actions")).toHaveLength(0);
    },
  );

  it("bounds the native window header before decoding it", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (url.endsWith("/frame"))
        response.headers.set("x-local-windows", "A".repeat(32769));
      return response;
    });
    await expect(f.native.observe(f.signal)).rejects.toThrow();
  });

  it("refuses activation after Stop even when its proof was valid", async () => {
    const f = windowsFixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    const action = { type: "activate" as const, targetId: "window_1" };
    expect(await f.native.revalidate(action, planned, current, f.signal)).toBe(
      true,
    );
    await f.native.stop();
    await expect(
      f.native.execute(
        { actionId: "action_1", observationId: current.id, action },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(0);
  });

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

  it("binds a native target proof to the exact planned/current frames and action", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    const action = { type: "click" as const, x: 0.5, y: 0.5 };
    expect(await f.native.revalidate(action, planned, current, f.signal)).toBe(
      true,
    );
    expect(JSON.parse(String(f.calls("/revalidate")[0]![1]!.body))).toEqual({
      plannedFrameId: planned.id,
      currentFrameId: current.id,
      action,
    });
    expect(await f.native.authorize(action, current)).toBe("confirm");
    await f.native.execute(
      { actionId: "action_1", observationId: current.id, action },
      f.signal,
    );
    expect(JSON.parse(String(f.calls("/actions")[0]![1]!.body))).toMatchObject({
      frameId: current.id,
      localProofId: "proof_1",
    });
  });

  it.each([
    { plannedFrameId: "wrong_frame" },
    { currentFrameId: "wrong_frame" },
    { proofId: "invalid/proof" },
    { valid: "true" },
  ])("rejects an unbound or malformed proof echo: %j", async (mismatch) => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      return url.endsWith("/revalidate")
        ? json({ ...(await response.json()), ...mismatch })
        : response;
    });
    await expect(
      f.native.revalidate(
        { type: "click", x: 0.5, y: 0.5 },
        planned,
        current,
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it("does not downgrade a valid proof to unproved input for a different action", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    expect(
      await f.native.revalidate(
        { type: "click", x: 0.5, y: 0.5 },
        planned,
        current,
        f.signal,
      ),
    ).toBe(true);
    await expect(
      f.native.execute(
        {
          actionId: "action_1",
          observationId: current.id,
          action: { type: "click", x: 0.2, y: 0.2 },
        },
        f.signal,
      ),
    ).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it("replaces an old target proof after a new capture and final revalidation", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const first = await f.native.observe(f.signal);
    const action = { type: "click" as const, x: 0.5, y: 0.5 };
    expect(await f.native.revalidate(action, planned, first, f.signal)).toBe(
      true,
    );
    f.advance(300);
    const final = await f.native.observe(f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      return url.endsWith("/revalidate")
        ? json({ ...(await response.json()), proofId: "proof_final" })
        : response;
    });
    expect(await f.native.revalidate(action, planned, final, f.signal)).toBe(
      true,
    );
    await f.native.execute(
      { actionId: "action_1", observationId: final.id, action },
      f.signal,
    );
    expect(
      JSON.parse(String(f.calls("/actions")[0]![1]!.body)).localProofId,
    ).toBe("proof_final");
  });

  it("refuses a valid-looking target proof arriving after Stop", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const planned = await f.native.observe(f.signal);
    f.advance(300);
    const current = await f.native.observe(f.signal);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => {
      if (url.endsWith("/revalidate")) await held;
      return normal(url, init);
    });
    const proof = f.native.revalidate(
      { type: "click", x: 0.5, y: 0.5 },
      planned,
      current,
      f.signal,
    );
    await f.native.stop();
    release();
    await expect(proof).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(0);
  });

  it.each([
    { untrusted: false, targets: [] },
    { untrusted: true, targets: [{ id: "t", role: "button", x: 2, y: 0.5 }] },
    {
      untrusted: true,
      targets: [
        {
          id: "t",
          role: "input",
          value: "private field value",
          x: 0.5,
          y: 0.5,
        },
      ],
    },
  ])(
    "rejects unbounded or authority-bearing target catalog data: %j",
    async (targets) => {
      const f = fixture();
      await f.native.open(f.task, f.signal);
      const normal = f.dispatch.getMockImplementation()!;
      f.dispatch.mockImplementation(async (url, init) => {
        const response = await normal(url, init);
        if (url.endsWith("/frame"))
          response.headers.set(
            "x-local-targets",
            Buffer.from(JSON.stringify(targets)).toString("base64"),
          );
        return response;
      });
      await expect(f.native.observe(f.signal)).rejects.toThrow();
    },
  );

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

  it("recognizes the helper's exact authenticated no-dispatch refusal without replay", async () => {
    const f = fixture();
    await f.native.open(f.task, f.signal);
    const frame = await f.native.observe(f.signal);
    const normal = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) =>
      url.endsWith("/actions")
        ? json({ code: "input_not_dispatched" }, 409)
        : normal(url, init),
    );
    const input = {
      actionId: "action_1",
      observationId: frame.id,
      action: { type: "click" as const, x: 0.5, y: 0.5 },
    };
    await expect(f.native.execute(input, f.signal)).rejects.toBeInstanceOf(
      CuaInputNotDispatched,
    );
    await expect(f.native.execute(input, f.signal)).rejects.toThrow();
    expect(f.calls("/actions")).toHaveLength(1);
  });

  it.each([
    { body: { error: "input_not_dispatched" }, status: 409 },
    { body: { code: "another_conflict" }, status: 409 },
    { body: { code: "input_not_dispatched" }, status: 500 },
  ])(
    "keeps generic or nonmatching helper failures uncertain: %j",
    async (failure) => {
      const f = fixture();
      await f.native.open(f.task, f.signal);
      const frame = await f.native.observe(f.signal);
      const normal = f.dispatch.getMockImplementation()!;
      f.dispatch.mockImplementation(async (url, init) =>
        url.endsWith("/actions")
          ? json(failure.body, failure.status)
          : normal(url, init),
      );
      await expect(
        f.native.execute(
          {
            actionId: "action_1",
            observationId: frame.id,
            action: { type: "click", x: 0.5, y: 0.5 },
          },
          f.signal,
        ),
      ).rejects.not.toBeInstanceOf(CuaInputNotDispatched);
      expect(f.calls("/actions")).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "requires full binding for a rejected input receipt (mismatch=%s)",
    async (mismatch) => {
      const f = fixture();
      await f.native.open(f.task, f.signal);
      const frame = await f.native.observe(f.signal);
      const normal = f.dispatch.getMockImplementation()!;
      f.dispatch.mockImplementation(async (url, init) => {
        const response = await normal(url, init);
        if (!url.endsWith("/actions")) return response;
        return json({
          ...(await response.json()),
          state: "rejected",
          evidence: "input_not_dispatched",
          ...(mismatch ? { executorId: "other_executor" } : {}),
        });
      });
      const promise = f.native.execute(
        {
          actionId: "action_1",
          observationId: frame.id,
          action: { type: "click", x: 0.5, y: 0.5 },
        },
        f.signal,
      );
      if (mismatch)
        await expect(promise).rejects.not.toBeInstanceOf(CuaInputNotDispatched);
      else await expect(promise).rejects.toBeInstanceOf(CuaInputNotDispatched);
    },
  );

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
