import { describe, it, expect } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { createErrorReporter } from "../src/error-report.js";

const operatorToken = "fixture-operator-token-at-least-32-chars";
const secret = "PRIVATE human text +15550000001";

function fixture() {
  const lines: string[] = [];
  let now = 1_800_000_000_000;
  const runtime = createRuntime(
    {
      CLAWDTIME_MODE: "simulation",
      CLAWDTIME_DATABASE: ":memory:",
      CLAWDTIME_OPERATOR_TOKEN: operatorToken,
    },
    {
      reportError: createErrorReporter({
        write: (line) => lines.push(line),
        clock: () => now,
      }),
    },
  );
  const readiness = async () =>
    (await (
      await runtime.app.request("/internal/readiness", {
        headers: { authorization: `Bearer ${operatorToken}` },
      })
    ).json()) as { loop: { state: string; ageSeconds?: number } };
  return {
    runtime,
    lines,
    readiness,
    records: () => lines.map((l) => JSON.parse(l)),
    advance: (ms: number) => (now += ms),
  };
}

describe("unexpected error reporting", () => {
  it("records an unexpected request error once and returns its request ID without the message", async () => {
    const f = fixture();
    f.runtime.service.heartbeat = () => {
      throw new TypeError(secret);
    };
    const response = await f.runtime.app.request("/api/sessions/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fixture-session-token",
      },
      body: "{}",
    });
    const body = (await response.json()) as {
      error: string;
      requestId: string;
    };
    expect(response.status).toBe(409);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({
      level: "error",
      event: "request_failed",
      requestId: body.requestId,
      method: "POST",
      route: "/api/sessions/heartbeat",
      name: "TypeError",
    });
    expect(f.records()[0].frames.length).toBeGreaterThan(0);
    expect(f.lines.join("\n")).not.toContain("PRIVATE");
    expect(f.lines.join("\n")).not.toContain("+1555");
    expect(f.lines.join("\n")).not.toContain("fixture-session-token");
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    f.runtime.store.close();
  });

  it("does not record expected refusals", async () => {
    const f = fixture();
    const response = await f.runtime.app.request("/api/sessions/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).not.toHaveProperty("requestId");
    expect(f.lines).toHaveLength(0);
    f.runtime.store.close();
  });

  it("answers 400 to a malformed body and 413 to an oversize body without an error report", async () => {
    const f = fixture();
    const post = (body: string) =>
      f.runtime.app.request("/api/pairing/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    const malformed = await post(`{"token": "${secret}`);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Request body must be valid JSON.",
    });
    const oversize = await post(JSON.stringify({ token: "x".repeat(40_000) }));
    expect(oversize.status).toBe(413);
    expect(await oversize.json()).toEqual({
      error: "Request body is too large.",
    });
    expect(f.lines).toHaveLength(0);
    f.runtime.store.close();
  });

  it("still records a syntax error that the server raised on a valid body", async () => {
    const f = fixture();
    f.runtime.service.claimPairing = () => {
      throw new SyntaxError(secret);
    };
    const response = await f.runtime.app.request("/api/pairing/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await response.json()) as { requestId: string };
    expect(response.status).toBe(409);
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({
      event: "request_failed",
      requestId: body.requestId,
      route: "/api/pairing/claim",
      name: "SyntaxError",
    });
    expect(f.lines.join("\n")).not.toContain("PRIVATE");
    f.runtime.store.close();
  });

  it("records a failing loop once per minute and reports it through readiness", async () => {
    const f = fixture();
    expect((await f.readiness()).loop).toEqual({ state: "never" });
    await f.runtime.tick();
    expect((await f.readiness()).loop.state).toBe("fresh");
    f.runtime.service.expireSessions = () => {
      throw new RangeError(secret);
    };
    for (let i = 0; i < 5; i++) {
      await f.runtime.tick();
      f.advance(1000);
    }
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]).toMatchObject({
      level: "error",
      event: "loop_failed",
      name: "RangeError",
    });
    expect((await f.readiness()).loop.state).toBe("failed");
    f.advance(60_000);
    await f.runtime.tick();
    expect(f.records()).toHaveLength(2);
    expect(f.records()[1]).toMatchObject({ event: "loop_failed", repeats: 4 });
    expect(f.lines.join("\n")).not.toContain("PRIVATE");
    f.runtime.store.close();
  });

  it("still cleans up and records the failed pass when the reporter itself throws", async () => {
    const runtime = createRuntime(
      {
        CLAWDTIME_MODE: "simulation",
        CLAWDTIME_DATABASE: ":memory:",
        CLAWDTIME_OPERATOR_TOKEN: operatorToken,
      },
      {
        reportError: () => {
          throw new Error("standard error is closed");
        },
      },
    );
    const drains: unknown[] = [],
      drain = runtime.service.drain.bind(runtime.service);
    runtime.service.drain = (options) => {
      drains.push(options);
      return drain(options);
    };
    runtime.service.expireSessions = () => {
      throw new RangeError(secret);
    };
    await expect(runtime.tick()).resolves.toBeUndefined();
    // The cleanup drain ran, and the heartbeat is the last step of the pass.
    expect(drains).toEqual([{ cleanupOnly: true }]);
    expect(runtime.store.state("heartbeat")).toMatchObject({ ok: false });
    const readiness = (await (
      await runtime.app.request("/internal/readiness", {
        headers: { authorization: `Bearer ${operatorToken}` },
      })
    ).json()) as { loop: { state: string } };
    expect(readiness.loop.state).toBe("failed");
    runtime.store.close();
  });

  it("reports an error whose name or stack is not a string", () => {
    const lines: string[] = [];
    const report = createErrorReporter({ write: (l) => lines.push(l) });
    report(
      "loop_failed",
      Object.assign(new Error(secret), { name: undefined }),
    );
    report(
      "startup_refused",
      Object.assign(new Error(secret), { stack: [secret] }),
    );
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { event: "loop_failed", name: "Error" },
      { event: "startup_refused", name: "Error", frames: [] },
    ]);
    expect(lines.join("\n")).not.toContain("PRIVATE");
  });

  it("reports a loop that stopped writing its heartbeat as stale", async () => {
    const f = fixture();
    f.runtime.store.saveState("heartbeat", {
      ok: true,
      at: Date.now() - 120_000,
    });
    expect((await f.readiness()).loop).toMatchObject({ state: "stale" });
    expect((await f.readiness()).loop.ageSeconds).toBeGreaterThanOrEqual(120);
    f.runtime.store.close();
  });

  it("keeps a provider status and drops every other message", () => {
    const lines: string[] = [];
    const report = createErrorReporter({ write: (l) => lines.push(l) });
    report("loop_failed", new Error("Provider returned HTTP 503."));
    report("request_failed", secret);
    expect(JSON.parse(lines[0]!)).toMatchObject({ providerStatus: 503 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ name: "NonError" });
    expect(lines.join("\n")).not.toContain("PRIVATE");
  });

  it("writes only stack lines that end in a line and column position", () => {
    const lines: string[] = [];
    const report = createErrorReporter({ write: (l) => lines.push(l) });
    // The stack was read before the message or the name changed. Its first
    // line no longer matches, so the message lines stay in the stack text.
    const wrapped = new Error(`refused\n    at ${secret}`);
    void wrapped.stack;
    wrapped.message = `wrapped: ${wrapped.message}`;
    report("loop_failed", wrapped);
    const renamed = new TypeError(`refused\n    at ${secret}`);
    void renamed.stack;
    renamed.name = "TypeError [ERR_FIXTURE]";
    report("startup_refused", renamed);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("PRIVATE");
    expect(lines.join("\n")).not.toContain("+1555");
    for (const line of lines) {
      const { frames } = JSON.parse(line) as { frames: string[] };
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(frame).toMatch(/:\d+:\d+\)?$/);
    }
  });
});
