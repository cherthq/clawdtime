import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneDesktop } from "../src/control/phone-desktop.js";
import type { DesktopExecutionSnapshot } from "../src/control/desktop-executor.js";

const active = (requestId: string): DesktopExecutionSnapshot => ({
  configured: true,
  mode: "native",
  state: "running",
  canStop: true,
  requestId,
  message: "Started; result not verified.",
});
const idle = (): DesktopExecutionSnapshot => ({
  configured: true,
  mode: "native",
  state: "idle",
  canStop: false,
  message: "Ready.",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const adapters: PhoneDesktop[] = [];
afterEach(() => {
  adapters.splice(0).forEach((adapter) => adapter.shutdown());
  vi.useRealTimers();
});
function fixture(
  options: {
    leaseMs?: number;
    maxCalls?: number;
    maxRequestsPerCall?: number;
  } = {},
) {
  let now = 1000;
  let current = idle();
  const runtime = {
    snapshot: vi.fn(() => ({ ...current })),
    submit: vi.fn(async (id: string, _text: string, _authority?: unknown) => {
      current = active(id);
      return { message: "Started; result not verified." };
    }),
    submitRead: vi.fn(
      async (
        id: string,
        _text: string,
        _reading: unknown,
        _authority?: { isLive(): boolean },
      ) => {
        current = active(id);
        return { message: "Started with reading." };
      },
    ),
    stop: vi.fn(() => {
      current = { ...current, state: "stopping", canStop: false };
      return { ...current };
    }),
    answer: vi.fn(async (_text: string) => ({ message: "Continuing." })),
    clear: vi.fn(() => ({ message: "Cleared locally." })),
  };
  const adapter = new PhoneDesktop(runtime, { now: () => now, ...options });
  adapters.push(adapter);
  return {
    runtime,
    adapter,
    set: (value: DesktopExecutionSnapshot) => {
      current = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("phone desktop execution ownership", () => {
  it("admits one call, renews its lease, and never reopens a closed identity", () => {
    const { adapter, advance } = fixture();
    expect(adapter.open("call-a")).toEqual({ ok: true, expiresAt: 31_000 });
    advance(1000);
    expect(adapter.open("call-a").expiresAt).toBe(31_000);
    expect(adapter.renew("call-a").expiresAt).toBe(32_000);
    expect(() => adapter.open("call-b")).toThrow("phone_call_in_use");
    expect(adapter.close("call-a")).toEqual({ ok: true });
    expect(adapter.close("call-a")).toEqual({ ok: true });
    expect(() => adapter.open("call-a")).toThrow("phone_call_closed");
    expect(adapter.open("call-b").ok).toBe(true);
  });

  it("scopes one native request, preserves the exact goal, and stops it on close", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    const text =
      "Open Messages and read the current conversation; do not send anything.";
    const result = await adapter.run("call-a", "request-a", text, async () => {
      expect(adapter.currentContext()).toMatchObject({
        callId: "call-a",
        requestId: "request-a",
        text,
      });
      expect(adapter.currentContext()?.isLive()).toBe(true);
      return adapter.execution.submit("model-selected-id", text);
    });
    expect(result.message).toContain("not verified");
    expect(runtime.submit).toHaveBeenCalledOnce();
    const [id, goal, authority] = runtime.submit.mock.calls[0]!;
    expect(id).toMatch(/^phone_[a-f0-9]+$/);
    expect(goal).toBe(text);
    expect(authority).toMatchObject({
      callId: "call-a",
      toolCallId: "request-a",
    });
    expect(adapter.currentContext()).toBeUndefined();
    adapter.close("call-a");
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("does not stop an unrelated local run after phone work completed", async () => {
    const { adapter, runtime, set } = fixture();
    adapter.open("call-a");
    await adapter.run("call-a", "request-a", "Open TextEdit", () =>
      adapter.execution.submit("ignored", "Open TextEdit"),
    );
    set(active("local-later"));
    adapter.close("call-a");
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("retains ownership of a prior phone run when the worker refuses a later submit as busy", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    await adapter.run("call-a", "request-a", "Open TextEdit", () =>
      adapter.execution.submit("ignored", "Open TextEdit"),
    );
    const prior = runtime.snapshot().requestId;
    runtime.submit.mockResolvedValueOnce({ message: "The worker is busy." });
    await adapter.run("call-a", "request-b", "Open Messages", () =>
      adapter.execution.submit("ignored", "Open Messages"),
    );
    expect(runtime.submit).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().requestId).toBe(prior);
    adapter.close("call-a");
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("allows a same-call follow-up and retains control of its new request", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    await adapter.run("call-a", "request-a", "Open TextEdit", () =>
      adapter.execution.submit("ignored", "Open TextEdit"),
    );
    const prior = runtime.snapshot().requestId;
    await adapter.run("call-a", "request-b", "Open Messages", () =>
      adapter.execution.submit("ignored", "Open Messages"),
    );
    expect(runtime.submit).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().requestId).not.toBe(prior);
    expect(runtime.snapshot().requestId).toBe(runtime.submit.mock.calls[1]![0]);
    adapter.close("call-a");
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("expires and stops exact phone work without a further request", async () => {
    vi.useFakeTimers();
    const { adapter, runtime, advance } = fixture({ leaseMs: 1000 });
    adapter.open("call-a");
    await adapter.run("call-a", "request-a", "Open TextEdit", () =>
      adapter.execution.submit("ignored", "Open TextEdit"),
    );
    advance(1001);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(() => adapter.renew("call-a")).toThrow("phone_call_expired");
    expect(() => adapter.open("call-a")).toThrow("phone_call_closed");
  });

  it("retains ordinary local submit, stop, answer and clear behavior", async () => {
    const { adapter, runtime } = fixture();
    await adapter.execution.submit("local-id", "Local work");
    expect(runtime.submit.mock.calls[0]?.[0]).toBe("local-id");
    await adapter.execution.answer!("yes");
    adapter.execution.stop();
    expect(adapter.execution.clear!()).toEqual({ message: "Cleared locally." });
    expect(runtime.answer).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.clear).toHaveBeenCalledOnce();
  });

  it("cannot answer, stop, or clear another local request from the phone", async () => {
    const { adapter, runtime, set } = fixture();
    set({ ...active("local-id"), state: "waiting_for_person" });
    adapter.open("call-a");
    await adapter.run("call-a", "read", "status", async () => {
      expect(adapter.execution.snapshot().canStop).toBe(false);
      adapter.execution.stop();
      expect(() => adapter.execution.answer!("yes")).toThrow(
        "phone_request_not_owned",
      );
      expect(() => adapter.execution.clear!()).toThrow(
        "phone_recovery_requires_local_review",
      );
      return "No unrelated work changed.";
    });
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.answer).not.toHaveBeenCalled();
    expect(runtime.clear).not.toHaveBeenCalled();
  });

  it("answers its own waiting request once, and preserves navigation readings", async () => {
    const { adapter, runtime, set } = fixture();
    adapter.open("call-a");
    await adapter.run("call-a", "start", "Open TextEdit", () =>
      adapter.execution.submitRead!("ignored", "Open TextEdit", {
        kind: "none",
      }),
    );
    expect(runtime.submitRead).toHaveBeenCalledOnce();
    set({ ...runtime.snapshot(), state: "waiting_for_person" });
    await adapter.run("call-a", "answer", "yes", async () => {
      await adapter.execution.answer!("yes");
      return adapter.execution.answer!("yes");
    });
    expect(runtime.answer).toHaveBeenCalledOnce();
  });

  it("reserves before supervisor invocation and returns identical duplicate outcomes", async () => {
    const { adapter } = fixture();
    const gate = deferred<string>();
    const say = vi.fn(() => gate.promise);
    adapter.open("call-a");
    const first = adapter.run("call-a", "request", "Open Messages", say, {
      kind: "sharing",
      applied: true,
    });
    const second = adapter.run("call-a", "request", "Open Messages", say, {
      kind: "sharing",
      applied: true,
    });
    expect(first).toBe(second);
    expect(() => adapter.run("call-a", "request", "Open Mail", say)).toThrow(
      "phone_request_conflict",
    );
    expect(() =>
      adapter.run("call-a", "request", "Open Messages", say, {
        kind: "sharing",
        applied: false,
      }),
    ).toThrow("phone_request_conflict");
    expect(() => adapter.run("call-a", "other", "Open TextEdit", say)).toThrow(
      "phone_request_in_progress",
    );
    gate.resolve("Observed result.");
    expect(await first).toBe("Observed result.");
    expect(await second).toBe("Observed result.");
    expect(say).toHaveBeenCalledOnce();
  });

  it("never repeats a callback after an unknown outcome and fences later requests", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    const say = vi.fn(async () => {
      await adapter.execution.submit("ignored", "Open Messages");
      throw Error("secret external error");
    });
    await expect(
      adapter.run("call-a", "request", "Open Messages", say),
    ).rejects.toThrow("phone_request_uncertain");
    await expect(
      adapter.run("call-a", "request", "Open Messages", say),
    ).rejects.toThrow("phone_request_uncertain");
    expect(() => adapter.run("call-a", "later", "Open TextEdit", say)).toThrow(
      "phone_request_uncertain",
    );
    expect(say).toHaveBeenCalledOnce();
    expect(runtime.submit).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it("keeps local calls outside an overlapping asynchronous phone context", async () => {
    const { adapter, runtime } = fixture();
    const gate = deferred<void>();
    adapter.open("call-a");
    const phone = adapter.run("call-a", "request", "status", async () => {
      await gate.promise;
      expect(adapter.currentContext()?.callId).toBe("call-a");
      adapter.execution.stop();
      return "Status.";
    });
    await adapter.execution.submit("local-id", "Local task");
    expect(runtime.submit.mock.calls[0]?.[0]).toBe("local-id");
    gate.resolve();
    await phone;
    expect(runtime.stop).not.toHaveBeenCalled();
  });

  it("rejects late native submission after hangup while the model was thinking", async () => {
    const { adapter, runtime } = fixture();
    const gate = deferred<void>();
    adapter.open("call-a");
    const phone = adapter.run(
      "call-a",
      "request",
      "Open Messages",
      async () => {
        await gate.promise;
        return adapter.execution.submit("ignored", "Open Messages");
      },
    );
    await Promise.resolve();
    adapter.close("call-a");
    gate.resolve();
    await expect(phone).rejects.toThrow("phone_request_uncertain");
    expect(runtime.submit).not.toHaveBeenCalled();
  });

  it("rejects detached work after a supervisor turn has already finished", async () => {
    const { adapter, runtime } = fixture();
    const gate = deferred<void>();
    let late: Promise<unknown> | undefined;
    adapter.open("call-a");
    await adapter.run("call-a", "request", "Open Messages", async () => {
      late = gate.promise.then(() =>
        adapter.execution.submit("ignored", "Open Messages"),
      );
      return "No action dispatched.";
    });
    gate.resolve();
    await expect(late).rejects.toThrow("phone_call_expired");
    expect(runtime.submit).not.toHaveBeenCalled();
  });

  it("refuses modified goals and deduplicates repeated submit within a turn", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    await adapter.run(
      "call-a",
      "request",
      "Open Messages; do not send",
      async () => {
        expect(() =>
          adapter.execution.submit("ignored", "Open Messages"),
        ).toThrow("phone_request_text_changed");
        const one = adapter.execution.submit(
          "first",
          "Open Messages; do not send",
        );
        const two = adapter.execution.submit(
          "second",
          "Open Messages; do not send",
        );
        expect(one).toBe(two);
        return one;
      },
    );
    expect(runtime.submit).toHaveBeenCalledOnce();
  });

  it("does not reopen expired calls or erase worker uncertainty on restart", async () => {
    const one = fixture();
    one.adapter.open("call-a");
    await one.adapter.run("call-a", "request", "Open Messages", () =>
      one.adapter.execution.submit("ignored", "Open Messages"),
    );
    const id = one.runtime.snapshot().requestId!;
    one.adapter.shutdown();
    const next = fixture();
    next.set({
      ...active(id),
      state: "uncertain",
      canStop: false,
      message: "Original input outcome unknown.",
    });
    expect(() =>
      next.adapter.run(
        "call-a",
        "request",
        "Open Messages",
        async () => "replay",
      ),
    ).toThrow("phone_call_expired");
    next.adapter.open("new-call");
    expect(
      await next.adapter.run("new-call", "new-request", "Open TextEdit", () =>
        next.adapter.execution.submit("ignored", "Open TextEdit"),
      ),
    ).toEqual({ message: "Original input outcome unknown." });
    expect(next.runtime.submit).not.toHaveBeenCalled();
    expect(next.runtime.clear).not.toHaveBeenCalled();
  });

  it("bounds tombstones and receipts without evicting used identities", async () => {
    const { adapter } = fixture({ maxCalls: 1, maxRequestsPerCall: 1 });
    adapter.open("call-a");
    await adapter.run("call-a", "request", "status", async () => "Ready.");
    expect(() =>
      adapter.run("call-a", "other", "status", async () => "Ready."),
    ).toThrow("phone_request_capacity");
    adapter.close("call-a");
    expect(() => adapter.open("call-b")).toThrow("phone_call_capacity");
    expect(() => adapter.open("call-a")).toThrow("phone_call_closed");
  });

  it("preserves raw text and makes a captured authority guard false after completion", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    const text = "  Open Messages\n  and read. Do not send.  ";
    let allowed: (() => boolean) | undefined;
    await adapter.run("call-a", "request", text, async () => {
      allowed = adapter.currentContext()!.isLive;
      expect(allowed()).toBe(true);
      return adapter.execution.submit("ignored", text);
    });
    expect(runtime.submit.mock.calls[0]?.[1]).toBe(text);
    expect(allowed!()).toBe(false);
    expect(() =>
      adapter.run("call-a", "request", text.trim(), async () => "changed"),
    ).toThrow("phone_request_conflict");
  });

  it("stops pending owned work immediately and fences late effects while keeping the call", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    const gate = deferred<void>();
    let allowed: (() => boolean) | undefined;
    const pending = adapter.run(
      "call-a",
      "request",
      "Open Messages",
      async () => {
        allowed = adapter.currentContext()!.isLive;
        await adapter.execution.submit("ignored", "Open Messages");
        await gate.promise;
        expect(allowed!()).toBe(false);
        return adapter.execution.submit("late", "Open Messages");
      },
    );
    await vi.waitFor(() => expect(runtime.submit).toHaveBeenCalledOnce());
    expect(adapter.stop("call-a").reply.text).toContain("Stop requested");
    expect(runtime.stop).toHaveBeenCalledOnce();
    gate.resolve();
    await expect(pending).rejects.toThrow("phone_request_cancelled");
    expect(runtime.submit).toHaveBeenCalledOnce();
    expect(
      await adapter.run("call-a", "status", "status", async () => "Stopped."),
    ).toBe("Stopped.");
    await expect(
      adapter.run("call-a", "request", "Open Messages", async () => "retry"),
    ).rejects.toThrow("phone_request_cancelled");
  });

  it("Stop before callback invocation prevents all effects and does not stop a local request", async () => {
    const { adapter, runtime, set } = fixture();
    adapter.open("call-a");
    set(active("local"));
    const callback = vi.fn(async () => "late");
    const pending = adapter.run("call-a", "request", "Open Messages", callback);
    expect(adapter.stop("call-a").reply.text).toContain(
      "No computer work owned",
    );
    await expect(pending).rejects.toThrow("phone_request_cancelled");
    expect(callback).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(
      await adapter.run(
        "call-a",
        "status",
        "status",
        async () => "Local running.",
      ),
    ).toBe("Local running.");
  });

  it("Stop cannot erase an uncertain request or grant a stale read authority", async () => {
    const { adapter, runtime } = fixture();
    adapter.open("call-a");
    await expect(
      adapter.run("call-a", "request", "Read Messages", async () => {
        await adapter.execution.submitRead!("ignored", "Read Messages", {
          kind: "app",
          name: "Messages",
        });
        throw new Error("lost result");
      }),
    ).rejects.toThrow("phone_request_uncertain");
    expect(runtime.submitRead.mock.calls[0]?.[3]?.isLive()).toBe(false);
    expect(adapter.stop("call-a").ok).toBe(true);
    expect(() =>
      adapter.run("call-a", "new", "status", async () => "ready"),
    ).toThrow("phone_request_uncertain");
    expect(runtime.clear).not.toHaveBeenCalled();
  });
});
