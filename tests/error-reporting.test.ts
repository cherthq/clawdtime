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
});
