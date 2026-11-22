import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundOwnership } from "../src/control/background-ownership.js";
import type { BackgroundTaskContext } from "../src/control/background-runtime.js";

const config = {
  origin: "http://127.0.0.1:13347",
  token: "fixture-helper-token-".repeat(3),
  deviceId: "fixture-device",
  executorId: "fixture-executor",
  displayId: 1,
};
const context: BackgroundTaskContext = {
  taskId: "fixture-task",
  sessionId: "fixture-session",
  callId: "fixture-call",
  toolCallId: "fixture-tool",
  isLive: () => true,
  expiresAt: 50_000,
  reserve: () => {
    throw Error("not used by ownership");
  },
  returned: () => {},
  verified: () => {},
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  let lease: any;
  let receipt: any;
  const calls: Array<{ path: string; body: any }> = [];
  const status: any = {
    backgroundProtocol: 1,
    deviceId: config.deviceId,
    localEnabled: true,
    armed: true,
    available: true,
    screenPermission: true,
    controlPermission: true,
    policyRevision: 1,
    activeSessionId: null,
    unresolvedActions: 0,
    backgroundUnresolvedActions: 0,
  };
  const driver = {
    pid: 77,
    bundleId: "com.trycua.driver",
    processStart: "a".repeat(64),
  };
  let reserveReply: (value: any) => any = (value) => ({
    admitted: true,
    receipt: value,
  });
  let resolveReply: (value: any) => any = (value) => value;
  const request = vi.fn<typeof fetch>(async (url, options) => {
    const path = new URL(String(url)).pathname.replace("/local/v1", "");
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, body });
    if (path === "/status") return Response.json(status);
    if (path === "/background-driver") return Response.json(driver);
    if (path === "/sessions") {
      lease = body;
      status.activeSessionId = body.id;
      return Response.json(body);
    }
    if (path.endsWith("/background-actions")) {
      receipt = {
        reservation: body,
        lease,
        requestHash: "b".repeat(64),
        sentinelId: "background_fixture",
        state: "reserved",
        updatedAt: new Date(1000).toISOString(),
        resolution: null,
      };
      status.unresolvedActions = status.backgroundUnresolvedActions = 1;
      return Response.json(reserveReply(receipt));
    }
    if (path.endsWith("/resolve")) {
      receipt = { ...receipt, state: "resolved", resolution: body };
      status.unresolvedActions = status.backgroundUnresolvedActions = 0;
      return Response.json(resolveReply(receipt));
    }
    if (path.endsWith("/renew")) {
      lease = body;
      return Response.json(body);
    }
    if (path.endsWith("/stop")) {
      status.activeSessionId = null;
      return Response.json({ stopped: true });
    }
    if (path.endsWith("/background-target")) {
      if (typeof body.windowId !== "number")
        return new Response("invalid UInt32", { status: 400 });
      return Response.json({
        ...body,
        processStart: "c".repeat(64),
        bundleVersion: "1.0",
        executablePath: "/Applications/Fixture.app/Contents/MacOS/Fixture",
        onCurrentSpace: true,
        geometry: { x: 0, y: 0, width: 800, height: 600 },
        geometryGeneration: "d".repeat(64),
      });
    }
    throw Error(`Unexpected test helper route ${path}`);
  });
  const revoked = vi.fn();
  const ownership = new BackgroundOwnership(
    config,
    revoked,
    request,
    () => 1000,
  );
  cleanups.push(() => ownership.stop());
  return {
    ownership,
    calls,
    request,
    status,
    revoked,
    setReserveReply: (next: typeof reserveReply) => {
      reserveReply = next;
    },
    setResolveReply: (next: typeof resolveReply) => {
      resolveReply = next;
    },
  };
}

describe("background helper ownership wire contract", () => {
  it("opens an exact nested controller receipt before any driver work and uses only coordination routes", async () => {
    const f = fixture();
    expect(
      await f.ownership.open(context, 77, new AbortController().signal),
    ).toMatchObject({ driverProcessStart: "a".repeat(64) });
    expect(f.calls.map((call) => call.path)).toEqual([
      "/status",
      "/background-driver",
      "/sessions",
      "/sessions/local_fixture-session/background-actions",
    ]);
    expect(f.calls.at(-1)?.body).toMatchObject({
      kind: "controller",
      driverPid: 77,
      driverProcessStart: "a".repeat(64),
    });
    expect(
      f.calls.every(
        ({ path }) => !path.endsWith("/actions") && !path.endsWith("/frame"),
      ),
    ).toBe(true);
  });

  it("refuses old helper protocol, existing unresolved effects, and wrong fresh reservation evidence", async () => {
    const old = fixture();
    delete old.status.backgroundProtocol;
    await expect(
      old.ownership.open(context, 77, new AbortController().signal),
    ).rejects.toThrow();
    expect(old.calls).toHaveLength(1);
    const busy = fixture();
    busy.status.unresolvedActions = 1;
    await expect(
      busy.ownership.open(context, 77, new AbortController().signal),
    ).rejects.toThrow();
    expect(busy.calls).toHaveLength(1);
    for (const reply of [
      (receipt: any) => ({ admitted: false, receipt }),
      (receipt: any) => ({
        admitted: true,
        receipt: { ...receipt, lease: { ...receipt.lease, taskId: "other" } },
      }),
      (receipt: any) => ({
        admitted: true,
        receipt: {
          ...receipt,
          reservation: { ...receipt.reservation, driverPid: 88 },
        },
      }),
    ]) {
      const bad = fixture();
      bad.setReserveReply(reply);
      await expect(
        bad.ownership.open(context, 77, new AbortController().signal),
      ).rejects.toThrow();
    }
  });

  it("serializes exact numeric window identity for the native Swift target witness", async () => {
    const f = fixture();
    await f.ownership.open(context, 77, new AbortController().signal);
    const result = await f.ownership.target(
      "com.example.Fixture",
      88,
      "91",
      new AbortController().signal,
    );
    expect(result.windowId).toBe(91);
    expect(f.calls.at(-1)?.body.windowId).toBe(91);
    await expect(
      f.ownership.target(
        "com.example.Fixture",
        88,
        "91suffix",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it.each([
    "armed",
    "available",
    "screenPermission",
    "controlPermission",
    "localEnabled",
  ])("fails closed if %s is revoked after opening", async (field) => {
    const f = fixture();
    await f.ownership.open(context, 77, new AbortController().signal);
    f.status[field] = false;
    await expect(f.ownership.check()).rejects.toThrow();
    expect(f.status.unresolvedActions).toBe(1);
  });

  it("does not clear the durable fence on Stop or uncertain cleanup", async () => {
    const f = fixture();
    await f.ownership.open(context, 77, new AbortController().signal);
    f.ownership.stop();
    expect(await f.ownership.close(false, true)).toBe(false);
    expect(f.status.unresolvedActions).toBe(1);
    expect(f.calls.some(({ path }) => path.endsWith("/resolve"))).toBe(false);
  });

  it("requires exact resolved receipt and resolves once even when close is requested twice", async () => {
    const f = fixture();
    await f.ownership.open(context, 77, new AbortController().signal);
    const first = f.ownership.close(true, true);
    const second = f.ownership.close(true, true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(
      f.calls.filter(({ path }) => path.endsWith("/resolve")),
    ).toHaveLength(1);
    expect(f.calls.filter(({ path }) => path.endsWith("/stop"))).toHaveLength(
      1,
    );
    const bad = fixture();
    await bad.ownership.open(context, 77, new AbortController().signal);
    bad.setResolveReply((receipt) => ({
      ...receipt,
      state: "reserved",
      resolution: null,
    }));
    await expect(bad.ownership.close(true, true)).resolves.toBe(false);
  });
});
