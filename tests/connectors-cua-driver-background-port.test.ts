import { describe, expect, it } from "vitest";
import {
  CuaDriverBackgroundPort,
  type BackgroundPortHostWitness,
  type BackgroundPortLeaseScope,
  type PinnedBackgroundPortConfig,
} from "../connectors/agents/cua-driver-background-port.js";
const config: PinnedBackgroundPortConfig = {
  sdkDirectory: "/private/sdk",
  socketPath: "/private/driver.sock",
  executablePath: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  expectedPid: 99,
  manifestSha256: "a".repeat(64),
  policySha256: "b".repeat(64),
  targets: [
    {
      bundleId: "com.example.Editor",
      pid: 5,
      executablePath: "/Applications/Editor.app/Contents/MacOS/Editor",
    },
  ],
  allowedApps: [
    {
      bundleId: "com.example.Editor",
      executablePath: "/Applications/Editor.app/Contents/MacOS/Editor",
    },
  ],
  driverGeneration: "generation-one",
  session: "test-session",
  callTimeoutMs: 100,
};
const binding = {
  callId: "call-one",
  taskId: "task-one",
  toolCallId: "tool-one",
  driverInstanceId: "instance-one",
  driverGeneration: "generation-one",
  driverVersion: "0.55.0",
  bundleId: "com.example.Editor",
  pid: 5,
  processStartIdentity: "process-one",
  windowId: "12",
  observationId: "frame-one",
  observationFingerprint: "hash-one",
};
const element = { actionId: "action-one", binding, elementToken: "token-one" };
const geometry = {
  editorId: "composer",
  screenshotWidth: 1000,
  screenshotHeight: 500,
  bounds: { x: 100, y: 100, width: 200, height: 80 },
};
function fixture() {
  const calls: { tool: string; args: any; signal: AbortSignal }[] = [];
  const leases: BackgroundPortLeaseScope[] = [];
  let socket = true,
    version = "0.55.0",
    pid = 99,
    destroyed = false;
  let respond: (tool: string, signal: AbortSignal) => Promise<any> = async (
    tool,
  ) => ({
    isError: false,
    degraded: false,
    structuredJson: JSON.stringify(
      tool === "end_session"
        ? { session: config.session, active: false }
        : tool === "start_session"
          ? { session: config.session, active: true, revived: false }
          : { effect: "confirmed", verified: true },
    ),
  });
  let witness: BackgroundPortHostWitness["withLease"] = async (
    scope,
    _signal,
    run,
  ) => {
    leases.push(scope);
    return run();
  };
  let shutdown = async () => {};
  const sdk = {
    executionMode: () => 1,
    socketPath: () => config.socketPath,
    metadata: async () => ({ driverVersion: version, pid, embedded: false }),
    callTool: async (
      tool: any,
      args: string,
      { signal }: { signal: AbortSignal },
    ) => {
      calls.push({ tool, args: JSON.parse(args), signal });
      return respond(tool, signal);
    },
    shutdown: () => shutdown(),
    uniffiDestroy: () => {
      destroyed = true;
    },
  };
  const port = new CuaDriverBackgroundPort(
    config,
    sdk,
    { withLease: (...args) => witness(...args) },
    async () => socket,
  );
  return {
    port,
    calls,
    leases,
    get destroyed() {
      return destroyed;
    },
    setSocket: (value: boolean) => {
      socket = value;
    },
    setVersion: (value: string) => {
      version = value;
    },
    setPid: (value: number) => {
      pid = value;
    },
    setShutdown: (value: typeof shutdown) => {
      shutdown = value;
    },
    setRespond: (value: typeof respond) => {
      respond = value;
    },
    setWitness: (value: typeof witness) => {
      witness = value;
    },
  };
}
const signal = () => new AbortController().signal;

describe("fixed-call background daemon port", () => {
  it("keeps all methods on one named session and uses exact explicit background tool fields", async () => {
    const f = fixture();
    expect(await f.port.startSession(signal())).toBe(true);
    expect(await f.port.clickElement(element, signal())).toMatchObject({
      dispatch: "returned",
      effect: "confirmed",
      workflowVerified: false,
    });
    await f.port.typeElement(
      { ...element, actionId: "type", text: "Fixture" },
      signal(),
    );
    await f.port.typePixelDraft(
      { actionId: "pixel-type", binding, geometry, text: "Draft" },
      signal(),
    );
    await f.port.clickQualifiedPoint(
      { actionId: "point", binding, geometry },
      signal(),
    );
    await f.port.scrollElement(
      { ...element, actionId: "scroll", direction: "down", amount: 2 },
      signal(),
    );
    expect(f.calls.map((c) => c.tool)).toEqual([
      "start_session",
      "click",
      "type_text",
      "type_text",
      "click",
      "scroll",
    ]);
    for (const call of f.calls.slice(1))
      expect(call.args).toMatchObject({
        session: "test-session",
        pid: 5,
        window_id: 12,
        scope: "window",
        delivery_mode: "background",
      });
    expect(f.calls[3]!.args).toEqual({
      session: "test-session",
      pid: 5,
      window_id: 12,
      scope: "window",
      delivery_mode: "background",
      x: 200,
      y: 140,
      text: "Draft",
    });
    expect(f.leases[3]!.action).toEqual({
      type: "type-pixel-draft",
      geometry,
      text: "Draft",
    });
    expect(f.calls[5]!.args).toMatchObject({
      by: "line",
      amount: 2,
      direction: "down",
    });
    expect(await f.port.endSession()).toEqual({ quiescence: "known" });
    expect(f.destroyed).toBe(true);
  });
  it("does not expose generic tools, capture files or arbitrary launch arguments", async () => {
    const f = fixture();
    expect("callTool" in f.port).toBe(false);
    await f.port.startSession(signal());
    expect(
      (await f.port.typeElement({ ...element, text: "draft\n" }, signal()))
        .dispatch,
    ).toBe("not_started");
    expect(
      (
        await f.port.launchQualifiedApp(
          {
            actionId: "launch",
            bundleId: "com.example.Editor",
            urls: ["sms:anyone"],
          },
          signal(),
        )
      ).dispatch,
    ).toBe("not_started");
    expect(
      (
        await f.port.launchQualifiedApp(
          { actionId: "launch", bundleId: "com.example.Foreign" },
          signal(),
        )
      ).dispatch,
    ).toBe("not_started");
    const {
      observationId: _a,
      observationFingerprint: _b,
      ...target
    } = binding;
    await f.port.observe(target, signal());
    expect(f.calls[1]!.args).not.toHaveProperty("screenshot_out_file");
    expect(f.calls[1]!.args).toMatchObject({
      pid: 5,
      window_id: 12,
      include_screenshot: true,
      tree_format: "both",
    });
  });
  it("launches exactly one configured bundle without URLs or process arguments", async () => {
    const f = fixture();
    expect(
      (
        await f.port.launchQualifiedApp(
          { actionId: "launch", bundleId: "com.example.Editor" },
          signal(),
        )
      ).dispatch,
    ).toBe("returned");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.args).toEqual({ bundle_id: "com.example.Editor" });
    expect(
      (
        await f.port.launchQualifiedApp(
          { actionId: "launch", bundleId: "com.example.Editor" },
          signal(),
        )
      ).code,
    ).toBe("duplicate_attempt");
  });
  it.each(["socket", "version", "pid", "generation", "app", "window"])(
    "refuses changed %s before native dispatch",
    async (kind) => {
      const f = fixture();
      await f.port.startSession(signal());
      let input: any = element;
      if (kind === "socket") f.setSocket(false);
      if (kind === "version") f.setVersion("0.56.0");
      if (kind === "pid") f.setPid(100);
      if (kind === "generation")
        input = {
          ...element,
          binding: { ...binding, driverGeneration: "generation-two" },
        };
      if (kind === "app")
        input = { ...element, binding: { ...binding, bundleId: "other" } };
      if (kind === "window")
        input = { ...element, binding: { ...binding, windowId: "12suffix" } };
      expect((await f.port.clickElement(input, signal())).dispatch).toBe(
        "not_started",
      );
      expect(f.calls).toHaveLength(1);
    },
  );
  it("cannot dispatch before startup, after Stop, or twice with one action identity", async () => {
    const f = fixture();
    expect((await f.port.clickElement(element, signal())).dispatch).toBe(
      "not_started",
    );
    await f.port.startSession(signal());
    await f.port.clickElement(element, signal());
    expect(
      (
        await f.port.clickElement(
          { ...element, elementToken: "different" },
          signal(),
        )
      ).code,
    ).toBe("duplicate_attempt");
    const ending = f.port.endSession();
    expect(
      (
        await f.port.typeElement(
          { ...element, actionId: "later", text: "Draft" },
          signal(),
        )
      ).dispatch,
    ).toBe("not_started");
    await ending;
    expect(f.calls.filter((c) => c.tool === "click")).toHaveLength(1);
  });
  it.each([
    { tag: "ActionInterrupted", inner: { completion: 2, reason: "private" } },
    {
      tag: "Tool",
      inner: { errorCode: "background_unavailable", message: "private" },
    },
    { tag: "Transport", inner: { reason: "private" } },
    new Error("private failure"),
  ])(
    "preserves ambiguous input and poisons the port without retrying %j",
    async (error) => {
      const f = fixture();
      await f.port.startSession(signal());
      f.setRespond(async () => {
        throw error;
      });
      const result = await f.port.clickElement(element, signal());
      expect(result.dispatch).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(
        (await f.port.clickElement({ ...element, actionId: "next" }, signal()))
          .code,
      ).toBe("admission_closed");
      expect(f.calls).toHaveLength(2);
      expect((await f.port.endSession()).quiescence).toBe("unknown");
    },
  );
  it("only trusts explicit SDK NotStarted, never a generic refusal after pixel focus", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    f.setRespond(async () => {
      throw { tag: "ActionInterrupted", inner: { completion: 0 } };
    });
    expect((await f.port.clickElement(element, signal())).dispatch).toBe(
      "not_started",
    );
    f.setRespond(async () => ({
      isError: true,
      degraded: false,
      structuredJson: '{"effect":"refused"}',
    }));
    expect(
      (
        await f.port.typePixelDraft(
          { actionId: "pixel", binding, geometry, text: "Draft" },
          signal(),
        )
      ).dispatch,
    ).toBe("unknown");
  });
  it("never turns completed SDK interruption into verified UI success", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    f.setRespond(async () => {
      throw { tag: "ActionInterrupted", inner: { completion: 1 } };
    });
    expect(await f.port.clickElement(element, signal())).toMatchObject({
      dispatch: "returned",
      code: "interrupted_completed",
      driverVerified: false,
      workflowVerified: false,
    });
  });
  it.each(["observe", "capturePreview"] as const)(
    "canceled in-flight read %s does not poison exact successful cleanup",
    async (method) => {
      const f = fixture();
      await f.port.startSession(signal());
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.setRespond(async (tool, sig) => {
        if (tool === "get_window_state")
          return new Promise((_resolve, reject) => {
            sig.addEventListener(
              "abort",
              () => reject(Error("private read cancellation")),
              { once: true },
            );
            entered();
          });
        return {
          isError: false,
          degraded: false,
          structuredJson: JSON.stringify({
            session: config.session,
            active: false,
          }),
        };
      });
      const {
        observationId: _o,
        observationFingerprint: _f,
        ...scope
      } = binding;
      const reading = f.port[method](scope, signal()).catch((error) => error);
      await started;
      const ended = await f.port.endSession();
      expect(await reading).toBeInstanceOf(Error);
      expect(ended).toEqual({ quiescence: "known" });
      expect(f.destroyed).toBe(true);
      expect(f.calls.map((c) => c.tool)).toEqual([
        "start_session",
        "get_window_state",
        "end_session",
      ]);
    },
  );
  it.each(["end_session_failure", "sdk_shutdown_failure"])(
    "read cancellation still requires cleanup success: %s",
    async (failure) => {
      const f = fixture();
      await f.port.startSession(signal());
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.setRespond(async (tool, sig) => {
        if (tool === "get_window_state")
          return new Promise((_resolve, reject) => {
            sig.addEventListener(
              "abort",
              () => reject(Error("read canceled")),
              { once: true },
            );
            entered();
          });
        return {
          isError: failure === "end_session_failure",
          degraded: false,
          structuredJson: JSON.stringify({
            session: config.session,
            active: false,
          }),
        };
      });
      if (failure === "sdk_shutdown_failure")
        f.setShutdown(async () => {
          throw Error("shutdown failed");
        });
      const {
        observationId: _o,
        observationFingerprint: _f,
        ...scope
      } = binding;
      const reading = f.port
        .capturePreview(scope, signal())
        .catch((error) => error);
      await started;
      expect(await f.port.endSession()).toEqual({ quiescence: "unknown" });
      await reading;
    },
  );
  it("holds exclusive local admission during pending input and aborts it on end", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    f.setRespond(async (tool, sig) =>
      tool === "click"
        ? new Promise((_resolve, reject) =>
            sig.addEventListener(
              "abort",
              () =>
                reject({ tag: "ActionInterrupted", inner: { completion: 2 } }),
              { once: true },
            ),
          )
        : {
            isError: false,
            degraded: false,
            structuredJson: JSON.stringify({
              session: config.session,
              active: false,
            }),
          },
    );
    const pending = f.port.clickElement(element, signal());
    while (f.calls.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 1));
    expect(
      (await f.port.clickElement({ ...element, actionId: "other" }, signal()))
        .code,
    ).toBe("admission_closed");
    const ending = f.port.endSession();
    expect((await pending).dispatch).toBe("unknown");
    expect((await ending).quiescence).toBe("unknown");
    expect(f.calls.filter((c) => c.tool === "click")).toHaveLength(1);
  });
  it("stops before dispatch when the host rejects or revokes authority while awaiting its lease", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    const stopped = new AbortController();
    f.setWitness(async (_scope, _signal, run) => {
      stopped.abort();
      return run();
    });
    expect((await f.port.clickElement(element, stopped.signal)).dispatch).toBe(
      "not_started",
    );
    expect(f.calls).toHaveLength(1);
  });
  it("rejects an attempted second host callback rather than sending twice", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    f.setWitness(async (_scope, _signal, run) => {
      await run();
      return run();
    });
    expect((await f.port.clickElement(element, signal())).dispatch).toBe(
      "unknown",
    );
    expect(f.calls.filter((c) => c.tool === "click")).toHaveLength(1);
  });
  it("presentation capture preserves input snapshots and start/cleanup results require exact identities", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    const {
      observationId: _a,
      observationFingerprint: _b,
      ...target
    } = binding;
    await f.port.capturePreview(target, signal());
    expect(f.calls[1]!.args).toMatchObject({
      display_only: true,
      screenshot_format: "jpeg",
      screenshot_quality: 85,
      max_dimension: 1280,
      include_accessibility_tree: false,
      include_screenshot: true,
      full_output: true,
      max_elements: 10000,
      max_depth: 40,
      timeout_ms: 2000,
    });
    f.setRespond(async () => ({
      isError: false,
      degraded: false,
      structuredJson: '{"session":"wrong","active":false}',
    }));
    expect((await f.port.endSession()).quiescence).toBe("unknown");
    for (const response of [
      { isError: true, degraded: false },
      {
        isError: false,
        degraded: false,
        structuredJson: '{"session":"wrong","active":true,"revived":false}',
      },
      {
        isError: false,
        degraded: false,
        structuredJson: JSON.stringify({
          session: config.session,
          active: true,
          revived: true,
        }),
      },
    ]) {
      const bad = fixture();
      bad.setRespond(async () => response);
      expect(await bad.port.startSession(signal())).toBe(false);
      expect(await bad.port.startSession(signal())).toBe(false);
      expect(bad.calls).toHaveLength(1);
    }
  });
  it("permits independently witnessed new app lifetimes without trusting old probe PIDs or raw launch candidates", async () => {
    const f = fixture();
    await f.port.startSession(signal());
    f.setRespond(async () => ({
      isError: false,
      degraded: false,
      structuredJson: JSON.stringify({
        pid: 77,
        bundle_id: "com.example.Editor",
        windows: [{ window_id: 90, title: "private" }],
        self_activation_suppressed: true,
      }),
    }));
    const launch = await f.port.launchQualifiedApp(
      { actionId: "launch-fresh", bundleId: "com.example.Editor" },
      signal(),
    );
    expect(launch.launched).toEqual({
      pid: 77,
      bundleId: "com.example.Editor",
      windowIds: ["90"],
      selfActivationSuppressed: true,
    });
    const fresh = {
      ...element,
      actionId: "fresh",
      binding: {
        ...binding,
        pid: 77,
        windowId: "90",
        processStartIdentity: "fresh-lifetime",
      },
    };
    f.setWitness(async (scope, _signal, run) => {
      expect(scope.expectedExecutablePath).toBe(
        config.allowedApps[0]!.executablePath,
      );
      if (scope.target?.processStartIdentity !== "fresh-lifetime")
        throw Error("wrong process lifetime");
      return run();
    });
    expect((await f.port.clickElement(fresh, signal())).dispatch).toBe(
      "returned",
    );
    expect(
      (
        await f.port.clickElement(
          {
            ...fresh,
            actionId: "wrong",
            binding: { ...fresh.binding, processStartIdentity: "old" },
          },
          signal(),
        )
      ).dispatch,
    ).toBe("not_started");
  });
});
