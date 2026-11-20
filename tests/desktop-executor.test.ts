import { afterEach, expect, it, vi } from "vitest";
import {
  DesktopExecutor,
  type DesktopExecutorConfig,
} from "../src/control/desktop-executor.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { DomainError } from "../src/storage/security.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskService } from "../src/control/task-service.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
const config: DesktopExecutorConfig = {
  version: 1,
  threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  token: "e".repeat(40),
  binary: "/bin/codex",
  clientPath: "/private/client.js",
  origin: "http://127.0.0.1:13346",
};
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(dispatch = vi.fn(async () => "queued" as const)) {
  const store = new Store();
  stores.push(store);
  const vault = new Vault("1".repeat(64));
  const notify = vi.fn();
  let now = 1000;
  const make = () =>
    new DesktopExecutor(store, vault, config, dispatch, notify, () => now);
  const executor = make();
  const command = (action: string, extra = {}, token = config.token) =>
    executor.command(token, {
      action,
      id: "request_1",
      threadId: config.threadId,
      ...extra,
    });
  return {
    executor,
    command,
    dispatch,
    notify,
    make,
    store,
    expire: () => {
      now += 16 * 60_000;
    },
  };
}
it("reserves before dispatch, deduplicates and requires an observed claimed result", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read the fixture");
  await f.executor.submit("request_1", "Read the fixture");
  expect(f.dispatch).toHaveBeenCalledTimes(1);
  await expect(f.executor.submit("request_1", "Other task")).rejects.toThrow(
    "conflicts",
  );
  expect(f.command("claim")).toMatchObject({
    task: "Read the fixture",
    canAct: true,
  });
  expect(f.command("claim")).toMatchObject({ canAct: false });
  expect(() =>
    f.command("finish", {
      state: "completed",
      summary: "Done",
      observed: false,
    }),
  ).toThrow("observed");
  const finish = {
    state: "completed",
    summary: "Observed fixture title",
    observed: true,
  };
  f.command("finish", finish);
  f.command("finish", finish);
  expect(f.notify).toHaveBeenCalledTimes(1);
  expect(f.executor.snapshot()).toMatchObject({
    state: "completed",
    canStop: false,
  });
  expect(JSON.stringify(f.store.all("desktop-executor-v1"))).not.toContain(
    "Read the fixture",
  );
});
it("authenticates the executor separately and fences the wrong chat", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  expect(() => f.command("claim", {}, "wrong")).toThrow("authorization");
  expect(() =>
    f.command("claim", { threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  ).toThrow("Wrong executor");
});
it("discovers opaque pending IDs only with the pinned executor identity", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Private request text");
  const inbox = f.executor.command(config.token, {
    action: "inbox",
    threadId: config.threadId,
  });
  expect(inbox).toMatchObject({
    requests: [{ id: "request_1", claimed: false }],
  });
  expect(JSON.stringify(inbox)).not.toContain("Private request text");
});
it("separates panel Stop and worker authentication at HTTP boundaries", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  const desktop = {
    authorizePanel(value: string) {
      if (value !== "panel")
        throw new DomainError(401, "Panel authorization required.");
    },
  } as TaskDesktopService;
  const app = createTaskApp(
    {} as TaskService,
    "o".repeat(40),
    undefined,
    undefined,
    undefined,
    undefined,
    desktop,
    undefined,
    undefined,
    f.executor,
  );
  const post = (path: string, token: string, body: unknown, origin?: string) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
  const claim = { action: "claim", id: "request_1", threadId: config.threadId };
  expect((await post("/executor/command", "panel", claim)).status).toBe(401);
  expect((await post("/desktop/execution/stop", config.token, {})).status).toBe(
    401,
  );
  expect(
    (
      await post(
        "/executor/command",
        config.token,
        claim,
        "https://example.com",
      )
    ).status,
  ).toBe(403);
  expect((await post("/executor/command", config.token, claim)).status).toBe(
    200,
  );
  expect((await post("/desktop/execution/stop", "panel", {})).status).toBe(200);
  expect(f.command("check").canAct).toBe(false);
});
it("stops unclaimed work and refuses late claims", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  expect(f.executor.stop().state).toBe("canceled");
  expect(f.command("claim").canAct).toBe(false);
});
it("cooperative Stop fences every subsequent check and completed claims", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  f.command("claim");
  expect(f.executor.stop().state).toBe("stop_requested");
  expect(f.command("check").canAct).toBe(false);
  expect(() =>
    f.command("finish", {
      state: "completed",
      summary: "Done",
      observed: true,
    }),
  ).toThrow();
  expect(
    (await f.executor.submit("request_2", "Read another fixture")).message,
  ).toContain("unresolved");
  f.command("finish", {
    state: "canceled",
    summary: "Stopped; no action was underway.",
    observed: false,
  });
  expect(f.executor.snapshot().state).toBe("canceled");
});
it("preserves uncertainty after restart, never dispatches again or permits reclaimed input", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  f.command("claim");
  const restarted = f.make();
  expect(restarted.snapshot().state).toBe("uncertain");
  expect(
    restarted.command(config.token, {
      action: "claim",
      threadId: config.threadId,
      id: "request_1",
    }).canAct,
  ).toBe(false);
  await restarted.submit("request_1", "Read fixture");
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
it("allows the original first claim after a lost enqueue response without repeating delivery", async () => {
  const f = fixture(
    vi.fn(async () => {
      throw Error("lost response");
    }),
  );
  await f.executor.submit("request_1", "Read fixture");
  expect(f.executor.snapshot().state).toBe("uncertain");
  expect(f.command("claim").canAct).toBe(true);
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
it("expires unclaimed and claimed work without silently renewing authority", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  f.expire();
  expect(f.command("claim").canAct).toBe(false);
  expect(f.executor.snapshot().state).toBe("canceled");
  const g = fixture();
  await g.executor.submit("request_1", "Read fixture");
  g.command("claim");
  g.expire();
  expect(g.command("check").canAct).toBe(false);
  expect(g.executor.snapshot().state).toBe("uncertain");
});
it("can stop an uncertain enqueue before a late first claim", async () => {
  const f = fixture(
    vi.fn(async () => {
      throw Error("resume uncertain");
    }),
  );
  await f.executor.submit("request_1", "Read fixture");
  expect(f.executor.snapshot().canStop).toBe(true);
  expect(f.executor.stop().state).toBe("canceled");
  expect(f.command("claim").canAct).toBe(false);
});
it("does not overwrite Stop during an in-flight enqueue", async () => {
  let done!: (value: "queued") => void;
  const f = fixture(
    vi.fn(
      () =>
        new Promise<"queued">((resolve) => {
          done = resolve;
        }),
    ),
  );
  const pending = f.executor.submit("request_1", "Read fixture");
  f.executor.stop();
  done("queued");
  await pending;
  expect(f.executor.snapshot().state).toBe("canceled");
});
it("retains uncertain receipts and requires observed read-only reconciliation before new work", async () => {
  const f = fixture();
  await f.executor.submit("request_1", "Read fixture");
  f.command("claim");
  f.command("finish", {
    state: "uncertain",
    summary: "Action result unknown",
    observed: false,
  });
  expect(f.make().snapshot().message).toBe("Action result unknown");
  expect(() =>
    f.command("reconcile", {
      state: "canceled",
      summary: "No effect found",
      observed: false,
    }),
  ).toThrow();
  f.command("reconcile", {
    state: "canceled",
    summary: "Read-only inspection confirmed no unresolved effect",
    observed: true,
  });
  expect(f.executor.snapshot().state).toBe("canceled");
  await f.executor.submit("request_2", "Read another fixture");
  expect(f.dispatch).toHaveBeenCalledTimes(2);
});
