import { afterEach, describe, expect, it, vi } from "vitest";
import { BundledCuaRuntime } from "../src/control/bundled-cua-runtime.js";
import { LineRuntime } from "../src/control/line-runtime.js";
import {
  bundledCuaConfigSchema,
  type CuaDevice,
  type CuaPlanner,
} from "../src/control/cua-contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";

const token = "test-line-capability-".repeat(3);
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

function fixture() {
  const store = new Store();
  const vault = new Vault("8".repeat(64));
  let now = 1_000_000;
  let frames = 0;
  let effects = 0;
  const device = {
    open: vi.fn<CuaDevice["open"]>(async () => {}),
    observe: vi.fn<CuaDevice["observe"]>(async () => ({
      id: `frame_${++frames}`,
      capturedAt: now,
      width: 800,
      height: 600,
      imageDataUrl: "data:image/png;base64,RklYVFVSRQ==",
      fingerprint: `fixture_${effects}`,
      context: "Disposable test surface",
    })),
    authorize: vi.fn<CuaDevice["authorize"]>(async () => "allowed"),
    execute: vi.fn<CuaDevice["execute"]>(async () => {
      effects++;
    }),
    stop: vi.fn<CuaDevice["stop"]>(async () => {}),
  };
  const planner: CuaPlanner = {
    plan: async ({ observation, previousActions }) =>
      previousActions.length
        ? {
            kind: "done",
            observationId: observation.id,
            summary: "Fixture changed",
          }
        : {
            kind: "action",
            observationId: observation.id,
            action: { type: "type", text: "fixture only" },
            description: "Edit the disposable fixture",
          },
    verify: async () => ({
      verified: true,
      summary: "Fixture change independently observed",
    }),
  };
  const config = bundledCuaConfigSchema.parse({
    version: 1,
    mode: "browser",
    model: "fixture-model",
    timeoutMs: 60_000,
    browser: {
      startUrl: "http://127.0.0.1:8767",
      allowedOrigins: ["http://127.0.0.1:8767"],
    },
  });
  const runtime = new BundledCuaRuntime(
    store,
    vault,
    config,
    planner,
    () => device,
    undefined,
    () => now,
  );
  let bridge = new LineRuntime(store, vault, token, runtime, () => now);
  cleanups.push(async () => {
    await runtime.close();
    store.close();
  });
  return {
    runtime,
    device,
    command: (action: string, extra = {}) =>
      bridge.command(token, { action, callId: "fixture_call", ...extra }),
    expire: () => {
      now += 30_001;
      bridge.expire();
    },
    restartBridge: () => {
      bridge = new LineRuntime(store, vault, token, runtime, () => now);
    },
  };
}

describe("phone bridge and computer runtime recovery together", () => {
  it("reports known busy rejection while canceled work is still cleaning up, without creating an uncertain request", async () => {
    const f = fixture();
    const cleanup = gate();
    f.device.stop.mockImplementationOnce(async () => cleanup.promise);
    await f.command("open");
    await f.command("execute", { requestId: "first", text: "Edit fixture" });
    await vi.waitFor(() => expect(f.device.stop).toHaveBeenCalledTimes(1));
    await f.command("stop");
    expect(f.runtime.snapshot().state).toBe("canceled");
    const second = { requestId: "second", text: "Edit fixture again" };
    expect((await f.command("execute", second)).state).toBe("blocked");
    cleanup.release();
    await f.runtime.waitForIdle();
    expect((await f.command("execute", second)).state).toBe("blocked");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    await f.command("execute", {
      requestId: "third",
      text: "Make a new fixture edit",
    });
    await f.runtime.waitForIdle();
    expect((await f.command("status")).state).toBe("completed");
    expect(f.device.execute).toHaveBeenCalledTimes(2);
  });

  it("retains unknown input after call expiry, prevents reopening, and blocks a later caller from replaying it", async () => {
    const f = fixture();
    const dispatched = gate();
    f.device.execute.mockImplementationOnce(async () => dispatched.promise);
    await f.command("open");
    await f.command("execute", { requestId: "first", text: "Edit fixture" });
    await vi.waitFor(() => expect(f.device.execute).toHaveBeenCalledTimes(1));
    f.expire();
    expect(f.runtime.snapshot().state).toBe("uncertain");
    dispatched.release();
    await f.runtime.waitForIdle();
    f.restartBridge();
    await expect(f.command("open")).rejects.toThrow("ended");
    await f.command("open", { callId: "later_call" });
    expect(
      (
        await f.command("execute", {
          callId: "later_call",
          requestId: "new",
          text: "Edit fixture",
        })
      ).state,
    ).toBe("blocked");
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("closes authority on bridge restart while an action awaits permission, without dispatch or resurrection", async () => {
    const f = fixture();
    const permission = gate();
    f.device.authorize.mockImplementationOnce(async () => {
      await permission.promise;
      return "allowed";
    });
    await f.command("open");
    await f.command("execute", { requestId: "first", text: "Edit fixture" });
    await vi.waitFor(() => expect(f.device.authorize).toHaveBeenCalledTimes(1));
    f.restartBridge();
    permission.release();
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("canceled");
    expect(f.device.execute).not.toHaveBeenCalled();
    await expect(f.command("open")).rejects.toThrow("ended");
    await expect(
      f.command("execute", { requestId: "first", text: "Edit fixture" }),
    ).rejects.toThrow("ended");
  });
});
