import { afterEach, describe, expect, it, vi } from "vitest";
import { createTaskApp } from "../src/control/task-app.js";
import { BundledCuaRuntime } from "../src/control/bundled-cua-runtime.js";
import {
  bundledCuaConfigSchema,
  type CuaDevice,
  type CuaPlanner,
} from "../src/control/cua-contracts.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import type { TaskService } from "../src/control/task-service.js";
import { Store } from "../src/storage/store.js";
import { DomainError, Vault } from "../src/storage/security.js";

const panelToken = "p".repeat(40);
const operatorToken = "o".repeat(40);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pendingFixture() {
  const store = new Store();
  let now = 1_000_000;
  let captures = 0;
  const device: CuaDevice = {
    open: async () => {},
    stop: async () => {},
    observe: async () => ({
      id: `frame_${++captures}`,
      capturedAt: now,
      width: 800,
      height: 600,
      imageDataUrl: "data:image/png;base64,RklYVFVSRQ==",
      fingerprint: "fixture_target",
      context: "fixture",
    }),
    authorize: async () => "confirm",
    execute: vi.fn(async () => {}),
  };
  const planner: CuaPlanner = {
    plan: async ({ observation, previousActions }) =>
      previousActions.length
        ? {
            kind: "done",
            observationId: observation.id,
            summary: "Observed fixture",
          }
        : {
            kind: "action",
            observationId: observation.id,
            action: { type: "click", x: 0.5, y: 0.5 },
            description: "Fixture action",
          },
    verify: async () => ({ verified: true, summary: "Observed fixture" }),
  };
  const config = bundledCuaConfigSchema.parse({
    version: 1,
    mode: "browser",
    model: "fixture-model",
    timeoutMs: 10_000,
    browser: {
      startUrl: "http://127.0.0.1:8767",
      allowedOrigins: ["http://127.0.0.1:8767"],
    },
  });
  const runtime = new BundledCuaRuntime(
    store,
    new Vault("5".repeat(64)),
    config,
    planner,
    () => device,
    undefined,
    () => now,
  );
  cleanups.push(async () => {
    await runtime.close();
    store.close();
  });
  const desktop = {
    authorizePanel(token: string) {
      if (token !== panelToken)
        throw new DomainError(401, "Panel authorization required.");
    },
  } as TaskDesktopService;
  const app = createTaskApp(
    {} as TaskService,
    operatorToken,
    undefined,
    undefined,
    undefined,
    undefined,
    desktop,
    undefined,
    undefined,
    runtime,
  );
  await runtime.submit("fixture_task", "Click the disposable fixture");
  await vi.waitFor(() =>
    expect(runtime.snapshot().pendingAction).toBeDefined(),
  );
  const actionId = runtime.snapshot().pendingAction!.id;
  const post = (
    body: unknown,
    options: {
      token?: string;
      origin?: string;
      path?: string;
      contentType?: string;
    } = {},
  ) =>
    app.request(options.path ?? "/desktop/execution/decision", {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json",
        ...(options.token === ""
          ? {}
          : { authorization: `Bearer ${options.token ?? panelToken}` }),
        ...(options.origin ? { origin: options.origin } : {}),
      },
      body: JSON.stringify(body),
    });
  return {
    runtime,
    device,
    post,
    actionId,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("bundled CUA exact-action HTTP decisions", () => {
  it.each(["", operatorToken, "native-helper-credential"])(
    "rejects non-panel authority without changing the pending action (%s)",
    async (token) => {
      const f = await pendingFixture();
      expect(
        (await f.post({ actionId: f.actionId, approve: true }, { token }))
          .status,
      ).toBe(401);
      expect(f.runtime.snapshot().pendingAction?.id).toBe(f.actionId);
      expect(f.device.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["https://example.com", "http://127.0.0.1:8767", "null"])(
    "rejects browser-origin decisions even with the panel credential (%s)",
    async (origin) => {
      const f = await pendingFixture();
      expect(
        (await f.post({ actionId: f.actionId, approve: true }, { origin }))
          .status,
      ).toBe(403);
      expect(f.runtime.snapshot().pendingAction?.id).toBe(f.actionId);
      expect(f.device.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects another action ID without consuming the real decision", async () => {
    const f = await pendingFixture();
    expect(
      (await f.post({ actionId: "another_action", approve: true })).status,
    ).toBe(409);
    expect(f.runtime.snapshot().pendingAction?.id).toBe(f.actionId);
    expect(f.device.execute).not.toHaveBeenCalled();
  });

  it.each([
    { approve: "true" },
    { approve: true, taskText: "invented instruction" },
    { approve: true, action: { type: "click", x: 0, y: 0 } },
  ])("rejects malformed or extra authority fields: %j", async (invalid) => {
    const f = await pendingFixture();
    expect((await f.post({ actionId: f.actionId, ...invalid })).status).toBe(
      400,
    );
    expect(f.device.execute).not.toHaveBeenCalled();
  });

  it("requires JSON and prevents expiration from becoming a new approval", async () => {
    const f = await pendingFixture();
    expect(
      (
        await f.post(
          { actionId: f.actionId, approve: true },
          { contentType: "text/plain" },
        )
      ).status,
    ).toBe(415);
    f.advance(10_001);
    expect((await f.post({ actionId: f.actionId, approve: true })).status).toBe(
      409,
    );
    expect(f.device.execute).not.toHaveBeenCalled();
  });

  it("accepts one exact panel decision and rejects replay without another input", async () => {
    const f = await pendingFixture();
    const response = await f.post({ actionId: f.actionId, approve: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await f.runtime.waitForIdle();
    expect(f.device.execute).toHaveBeenCalledTimes(1);
    expect((await f.post({ actionId: f.actionId, approve: true })).status).toBe(
      409,
    );
    expect(f.device.execute).toHaveBeenCalledTimes(1);
  });

  it("allows exact denial without any input", async () => {
    const f = await pendingFixture();
    expect(
      (await f.post({ actionId: f.actionId, approve: false })).status,
    ).toBe(200);
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().state).toBe("canceled");
    expect(f.device.execute).not.toHaveBeenCalled();
  });

  it("keeps panel Stop sticky against a delayed approval", async () => {
    const f = await pendingFixture();
    expect((await f.post({}, { path: "/desktop/execution/stop" })).status).toBe(
      200,
    );
    expect((await f.post({ actionId: f.actionId, approve: true })).status).toBe(
      409,
    );
    await f.runtime.waitForIdle();
    expect(f.device.execute).not.toHaveBeenCalled();
  });

  it("does not expose the original-chat worker command endpoint for bundled execution", async () => {
    const f = await pendingFixture();
    expect(
      (
        await f.post(
          { action: "claim", id: "fixture_task" },
          { path: "/executor/command" },
        )
      ).status,
    ).toBe(404);
    expect(f.device.execute).not.toHaveBeenCalled();
  });
});
