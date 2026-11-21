import { describe, expect, it } from "vitest";
import {
  inspectCuaDriverDaemon,
  verifyCuaDriverStatus,
  type CuaDriverProbeConfig,
  type CuaDriverProbePort,
} from "../connectors/agents/cua-driver-probe.js";
const config: CuaDriverProbeConfig = {
  sdkDirectory: "/private/test/sdk",
  socketPath: "/private/test/driver.sock",
  executablePath: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
  expectedPid: 99,
  manifestSha256: "a".repeat(64),
  policySha256: "b".repeat(64),
  targets: [
    {
      bundleId: "com.example.TestEditor",
      pid: 5,
      executablePath: "/Applications/TestEditor.app/Contents/MacOS/TestEditor",
    },
  ],
};
const status = `Cua Driver daemon is running
  socket: ${config.socketPath}
  pid: unknown (no pid file)
  permission mode: bounded (trusted_startup_configuration)
  user policy: configured=true, active=true, valid=true
  user policy sha256: ${config.policySha256}
  capability manifest: configured=true, approved_at_startup=true, valid=true
  capability manifest sha256: ${config.manifestSha256}
`;
function fixture(overrides: Partial<CuaDriverProbePort> = {}) {
  const events: string[] = [];
  const port: CuaDriverProbePort = {
    executionMode: () => 1,
    socketPath: () => config.socketPath,
    isAvailable: () => true,
    metadata: async () => ({
      driverVersion: "0.55.0",
      embedded: false,
      pid: 99,
    }),
    checkPermissions: async () => ({
      accessibility: true,
      screen_recording: true,
      source: {
        attribution: "driver-daemon",
        pid: 99,
        executable: config.executablePath,
        bundle_id: "com.trycua.driver",
      },
    }),
    verifyApplication: async () => {
      events.push("verify");
      return true;
    },
    listWindows: async ({ pid, onScreenOnly }) => {
      events.push(`windows:${pid}:${onScreenOnly}`);
      return {
        windows: [
          {
            pid,
            windowId: 12n,
            isOnScreen: false,
            minimized: true,
            onCurrentSpace: false,
            title: "Private fixture title",
          },
        ],
      };
    },
    shutdown: async () => {
      events.push("shutdown");
    },
    destroy: () => {
      events.push("destroy");
    },
    ...overrides,
  };
  return {
    port,
    events,
    inspect: (signal = new AbortController().signal) =>
      inspectCuaDriverDaemon(config, port, 1, signal),
  };
}
describe("pinned read-only Cua daemon preflight", () => {
  it("checks exact bounded mode and loaded manifest/policy hashes", () => {
    expect(verifyCuaDriverStatus(status, config)).toBe(true);
    for (const changed of [
      status.replace("bounded", "standard"),
      status.replace(config.policySha256, "c".repeat(64)),
      status.replace("active=true", "active=false"),
      status.replace(config.socketPath, "/other.sock"),
      status.replace("approved_at_startup=true", "approved_at_startup=false"),
    ])
      expect(verifyCuaDriverStatus(changed, config)).toBe(false);
  });
  it("returns only allowlisted metadata, never titles/content, and releases the SDK client", async () => {
    const f = fixture();
    const result = await f.inspect();
    expect(result.status).toBe("inventory_only");
    expect(result.directCaptureVerified).toBe(false);
    expect(result.apps[0]?.windows).toEqual([
      {
        windowId: "12",
        isOnScreen: false,
        minimized: true,
        onCurrentSpace: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(f.events).toEqual([
      "verify",
      "windows:5:false",
      "verify",
      "shutdown",
      "destroy",
    ]);
  });
  it.each([
    { executionMode: () => 0 },
    { socketPath: () => "/different.sock" },
    { isAvailable: () => false },
    {
      metadata: async () => ({
        driverVersion: "0.54.0",
        embedded: false,
        pid: 99,
      }),
    },
    {
      metadata: async () => ({
        driverVersion: "0.55.0",
        embedded: true,
        pid: 99,
      }),
    },
    {
      checkPermissions: async () => ({
        accessibility: true,
        screen_recording: true,
        source: {
          attribution: "caller",
          pid: 99,
          executable: config.executablePath,
          bundle_id: "com.trycua.driver",
        },
      }),
    },
    {
      checkPermissions: async () => ({
        accessibility: true,
        screen_recording: true,
        source: {
          attribution: "driver-daemon",
          pid: 100,
          executable: config.executablePath,
          bundle_id: "com.trycua.driver",
        },
      }),
    },
  ])(
    "does not enumerate apps for wrong topology, release or permission owner",
    async (overrides) => {
      const f = fixture(overrides);
      await expect(f.inspect()).rejects.toThrow();
      expect(f.events).toEqual(["shutdown", "destroy"]);
    },
  );
  it("reports missing permissions without app inspection or prompting", async () => {
    const f = fixture({
      checkPermissions: async () => ({
        accessibility: false,
        screen_recording: false,
        source: {
          attribution: "driver-daemon",
          pid: 99,
          executable: config.executablePath,
          bundle_id: "com.trycua.driver",
        },
      }),
    });
    expect((await f.inspect()).status).toBe("permissions_required");
    expect(f.events).toEqual(["shutdown", "destroy"]);
  });
  it("does not use unverified processes or foreign windows", async () => {
    const f = fixture({ verifyApplication: async () => false });
    expect((await f.inspect()).apps[0]?.status).toBe(
      "process_identity_unverified",
    );
    expect(f.events).toEqual(["shutdown", "destroy"]);
    const badWindow = fixture({
      listWindows: async () => ({
        windows: [{ windowId: 1n, pid: 10, isOnScreen: true }],
      }),
    });
    await expect(badWindow.inspect()).rejects.toThrow("expected process");
  });
  it("cleans up on Stop or failed read without retries", async () => {
    const stopped = fixture();
    await expect(stopped.inspect(AbortSignal.abort())).rejects.toThrow();
    expect(stopped.events).toEqual(["shutdown", "destroy"]);
    let calls = 0;
    const failed = fixture({
      verifyApplication: async () => {
        calls++;
        throw Error("read failed");
      },
    });
    await expect(failed.inspect()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(failed.events).toEqual(["shutdown", "destroy"]);
  });
});
