import { describe, it, expect, vi } from "vitest";
import { LineRuntime } from "../src/control/line-runtime.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskService } from "../src/control/task-service.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";

const token = "l".repeat(40);
function fixture() {
  const store = new Store(),
    vault = new Vault("4".repeat(64));
  let now = 1000;
  let current: DesktopExecutionSnapshot = {
    configured: true,
    state: "idle",
    canStop: false,
    message: "Idle",
  };
  const runtime = {
    snapshot: (id?: string) =>
      !id || id === current.requestId
        ? current
        : { ...current, requestId: undefined },
    submit: vi.fn(async (id: string, _text: string) => {
      current = {
        configured: true,
        requestId: id,
        state: "running",
        canStop: true,
        message: "Running",
      };
      return { message: current.message };
    }),
    stop: vi.fn(
      () =>
        (current = {
          ...current,
          state: "canceled",
          canStop: false,
          message: "Stopped",
        }),
    ),
  };
  let bridge = new LineRuntime(store, vault, token, runtime, () => now);
  const command = (action: string, extra = {}, auth = token) =>
    bridge.command(auth, { action, callId: "fixture_call", ...extra });
  return {
    store,
    runtime,
    command,
    set: (v: DesktopExecutionSnapshot) => {
      current = v;
    },
    advance: () => {
      now += 30_001;
      bridge.expire();
    },
    restart: () => {
      bridge = new LineRuntime(store, vault, token, runtime, () => now);
    },
    app: () =>
      createTaskApp(
        {} as TaskService,
        "o".repeat(40),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // The slot before the phone runtime is main's computer port.
        undefined,
        bridge,
      ),
  };
}
describe("phone computer runtime", () => {
  it("requires its own credential, an admitted call, and strict input", async () => {
    const f = fixture();
    await expect(f.command("open", {}, "wrong")).rejects.toThrow(
      "authorization",
    );
    await expect(
      f.command("execute", { requestId: "r1", text: "fixture" }),
    ).rejects.toThrow("admitted");
    await expect(f.command("open", { unknown: true })).rejects.toThrow();
    expect(f.runtime.submit).not.toHaveBeenCalled();
    f.store.close();
  });
  it("reserves exact requests and never replays duplicates or changed text", async () => {
    const f = fixture();
    await f.command("open");
    const request = { requestId: "r1", text: "fixture" };
    const first = await f.command("execute", request);
    expect(await f.command("execute", request)).toEqual(first);
    await expect(
      f.command("execute", { ...request, text: "changed" }),
    ).rejects.toThrow("conflicts");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    const db = f.store.all("line-runtime-request-v1");
    expect(JSON.stringify(db)).not.toContain("fixture");
    f.store.close();
  });
  it("stops only owned work at hangup, rejects commands and reopening", async () => {
    const f = fixture();
    await f.command("open");
    await f.command("execute", { requestId: "r1", text: "fixture" });
    expect((await f.command("close")).state).toBe("canceled");
    await f.command("close");
    expect(f.runtime.stop).toHaveBeenCalledTimes(1);
    await expect(f.command("open")).rejects.toThrow("ended");
    await expect(f.command("status")).rejects.toThrow("ended");
    f.store.close();
  });
  it("expires a lost call, does not restore authority after restart", async () => {
    const f = fixture();
    await f.command("open");
    await f.command("execute", { requestId: "r1", text: "fixture" });
    f.advance();
    expect(f.runtime.stop).toHaveBeenCalledTimes(1);
    f.restart();
    await expect(f.command("open")).rejects.toThrow("ended");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("does not stop unrelated panel work or expose its result", async () => {
    const f = fixture();
    await f.command("open");
    f.set({
      configured: true,
      requestId: "panel_task",
      state: "running",
      canStop: true,
      message: "Private panel result",
    });
    expect(
      (await f.command("execute", { requestId: "r1", text: "fixture" })).state,
    ).toBe("blocked");
    expect((await f.command("status")).message).not.toContain("Private");
    await f.command("stop");
    await f.command("close");
    expect(f.runtime.submit).not.toHaveBeenCalled();
    expect(f.runtime.stop).not.toHaveBeenCalled();
    f.store.close();
  });
  it("retains an uncertain dispatch and never retries it", async () => {
    const f = fixture();
    await f.command("open");
    f.runtime.submit.mockRejectedValueOnce(new Error("lost response"));
    const request = { requestId: "r1", text: "fixture" };
    expect((await f.command("execute", request)).state).toBe("uncertain");
    expect((await f.command("execute", request)).state).toBe("uncertain");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    expect(
      (await f.command("execute", { requestId: "r2", text: "new fixture" }))
        .state,
    ).toBe("blocked");
    expect(f.runtime.submit).toHaveBeenCalledTimes(1);
    f.store.close();
  });
  it("returns uncertain over HTTP when a reserved dispatch throws", async () => {
    const f = fixture();
    await f.command("open");
    f.runtime.submit.mockRejectedValueOnce(new Error("unknown dispatch"));
    const response = await f.app().request("/line/command", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "execute",
        callId: "fixture_call",
        requestId: "r1",
        text: "fixture",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "uncertain",
      clientRequestId: "r1",
    });
    f.store.close();
  });
  it("allows only one call and protects HTTP route from browser origins", async () => {
    const f = fixture();
    await f.command("open");
    await expect(f.command("open", { callId: "other_call" })).rejects.toThrow(
      "Another call",
    );
    const app = f.app();
    const request = (auth: string, origin?: string) =>
      app.request("/line/command", {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth}`,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ action: "status", callId: "fixture_call" }),
      });
    expect((await request("o".repeat(40))).status).toBe(401);
    expect((await request(token, "http://localhost")).status).toBe(403);
    expect((await request(token)).status).toBe(200);
    f.store.close();
  });
});
