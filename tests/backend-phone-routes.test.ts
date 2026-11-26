import { describe, expect, it } from "vitest";
import { createTaskApp, type AgentBoardPort } from "../src/control/task-app.js";
import { PhoneDesktop } from "../src/control/phone-desktop.js";
import { DomainError } from "../src/storage/security.js";
import type { TaskService } from "../src/control/task-service.js";
import type { TaskDesktopService } from "../src/control/task-desktop-service.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";

function fixture() {
  let state: DesktopExecutionSnapshot = {
    configured: true,
    mode: "native",
    state: "idle",
    canStop: false,
    message: "Ready",
  };
  const received: unknown[] = [];
  const runtime = {
    snapshot: () => state,
    async submit(id: string) {
      state = { ...state, requestId: id, state: "running", canStop: true };
      return { message: "Started" };
    },
    stop() {
      state = { ...state, state: "canceled", canStop: false };
      return state;
    },
  };
  const scope = new PhoneDesktop(runtime);
  const agents = {
    async say(text: string, via: unknown, context: unknown) {
      received.push({ text, via, context });
      await scope.execution.submit("model-request", text);
      return {
        role: "assistant",
        text: "Started; completion is not yet verified.",
      };
    },
  } as unknown as AgentBoardPort;
  const desktop = {
    authorizePanel(value: string) {
      if (value !== "p".repeat(40))
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
    agents,
    undefined,
    undefined,
    undefined,
    { scope, instanceId: "service-one" },
  );
  const post = (
    operation: string,
    data: unknown,
    token = "p".repeat(40),
    origin?: string,
  ) =>
    app.request(`/desktop/phone/${operation}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(data),
    });
  const call = { instanceId: "service-one", callId: "call-one" };
  return { post, call, received, runtime };
}

describe("authenticated phone-to-desktop routes", () => {
  it("binds shared launch ownership to the exact call and service and rejects changed task replay", async () => {
    const f = fixture();
    await f.post("open", f.call);
    const sharedTask = {
      taskId: "task-one",
      callId: f.call.callId,
      desktopInstanceId: f.call.instanceId,
    };
    const chat = {
      ...f.call,
      requestId: "shared-turn",
      text: "Build a sample page",
      sharedTask,
    };
    expect(
      (
        await f.post("chat", {
          ...chat,
          sharedTask: { ...sharedTask, callId: "other" },
        })
      ).status,
    ).toBe(409);
    expect(f.received).toHaveLength(0);
    expect((await (await f.post("chat", chat)).json()).ok).toBe(true);
    expect(f.received[0]).toMatchObject({ context: { sharedTask } });
    expect(
      (
        await (
          await f.post("chat", {
            ...chat,
            sharedTask: { ...sharedTask, taskId: "changed" },
          })
        ).json()
      ).ok,
    ).toBe(false);
    expect(f.received).toHaveLength(1);
  });
  it("rejects unauthenticated, browser-origin and previous-instance commands", async () => {
    const f = fixture();
    expect((await f.post("open", f.call, "wrong")).status).toBe(401);
    expect(
      (await f.post("open", f.call, undefined, "http://example.invalid"))
        .status,
    ).toBe(403);
    expect(
      await (
        await f.post("open", { ...f.call, instanceId: "old-service" })
      ).json(),
    ).toEqual({ ok: false, code: "service_changed" });
    expect(f.received).toEqual([]);
  });

  it("dispatches exact text and presentation context once and releases owned input on close", async () => {
    const f = fixture();
    expect((await (await f.post("open", f.call)).json()).ok).toBe(true);
    const presentation = { kind: "sharing", action: "show", applied: true };
    const chat = {
      ...f.call,
      requestId: "request-one",
      text: "Show the screen and open Messages; do not send anything.",
      presentation,
    };
    const first = await (await f.post("chat", chat)).json();
    expect(first).toEqual({
      ok: true,
      reply: { text: "Started; completion is not yet verified." },
    });
    expect(await (await f.post("chat", chat)).json()).toEqual(first);
    expect(f.received).toEqual([
      {
        text: chat.text,
        via: "voice",
        context: {
          phonePresentation: presentation,
          isLive: expect.any(Function),
        },
      },
    ]);
    expect(f.runtime.snapshot().state).toBe("running");
    expect((await (await f.post("close", f.call)).json()).ok).toBe(true);
    expect(f.runtime.snapshot().state).toBe("canceled");
    expect(
      (await (await f.post("chat", { ...chat, requestId: "later" })).json()).ok,
    ).toBe(false);
    expect(f.received).toHaveLength(1);
  });

  it("refuses conflicting presentation receipts and malformed original words", async () => {
    const f = fixture();
    await f.post("open", f.call);
    const chat = {
      ...f.call,
      requestId: "request-one",
      text: "Show the screen",
      presentation: { kind: "sharing", action: "show", applied: true },
    };
    await f.post("chat", chat);
    expect(
      (
        await (
          await f.post("chat", {
            ...chat,
            presentation: { ...chat.presentation, applied: false },
          })
        ).json()
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.post("chat", {
          ...chat,
          requestId: "request-two",
          text: "bad\u0000text",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.post("chat", {
          ...chat,
          requestId: "request-two",
          text: "a".repeat(2001),
        })
      ).status,
    ).toBe(400);
    expect(f.received).toHaveLength(1);
  });
});
