import { expect, it, vi } from "vitest";
import { ConversationTimeline } from "../src/transport/conversation-timeline.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import {
  executeConversationCommand,
  conversationCommands,
} from "../connectors/shared/conversation.js";
import {
  inspectSession,
  inspectionFixture,
  quantiles,
} from "../connectors/shared/inspection.js";
import {
  explainReadiness,
  readinessReasons,
  summarizeReadiness,
} from "../connectors/shared/readiness.js";
import { inspectMain } from "../scripts/inspect-session.js";

const activity = {
  version: 1,
  activity: {
    activityId: "progress-1",
    kind: "status",
    summary: "Checking the synthetic fixture.",
  },
};
it.each([undefined, 1, 2])(
  "negotiates presentation version %s for the exact request without replaying effects",
  async (version) => {
    const calls: { url: string; body?: any }[] = [];
    const client = new ClawdTimeClient(
      "http://127.0.0.1:3310",
      "fixture",
      (async (url, init) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify(
            init?.method === "GET"
              ? { turns: [], capabilities: { presentationVersion: version } }
              : { turn: { state: "executing" } },
          ),
        );
      }) as typeof fetch,
    );
    await executeConversationCommand(client, "conversation_progress", {
      requestId: "r",
      turnId: "t",
      state: "executing",
      presentation: activity,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/r/conversation/turns");
    expect(calls[1]!.body.presentation).toEqual(
      version === 1 ? activity : undefined,
    );
    await executeConversationCommand(client, "conversation_progress", {
      requestId: "other",
      turnId: "t",
      state: "executing",
      presentation: activity,
    });
    expect(calls[2]!.url).toContain("/other/conversation/turns");
    expect(
      calls
        .filter((call) => call.body)
        .map((call) => call.url.endsWith("/progress")),
    ).toEqual([true, true]);
  },
);
it("never retries an uncertain progress write or falls back to a legacy completion", async () => {
  const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET")
      return new Response(
        JSON.stringify({ turns: [], capabilities: { presentationVersion: 1 } }),
      );
    throw new Error("uncertain write");
  });
  const client = new ClawdTimeClient(
    "http://127.0.0.1:3310",
    "fixture",
    request as typeof fetch,
  );
  await expect(
    executeConversationCommand(client, "conversation_progress", {
      requestId: "r",
      turnId: "t",
      state: "completed",
      presentation: {
        version: 1,
        outcome: {
          outcomeId: "o",
          summary: "Observed fixture.",
          verification: "agent_observed",
          evidenceKind: "test_result",
        },
      },
    }),
  ).rejects.toThrow("uncertain write");
  expect(request).toHaveBeenCalledTimes(2);
});
it("bounds Unicode summaries and rejects unsupported presentation versions", () => {
  const parse = (summary: string, version = 1) =>
    conversationCommands.conversation_progress.schema.parse({
      requestId: "r",
      turnId: "t",
      state: "executing",
      presentation: {
        ...activity,
        version,
        activity: { ...activity.activity, summary },
      },
    });
  expect(() => parse("😀".repeat(160))).not.toThrow();
  expect(() => parse("😀".repeat(161))).toThrow();
  expect(() => parse("valid", 2)).toThrow();
});
it("reports known quantiles and counts failures/missing rather than hiding them", () => {
  const fixture = inspectionFixture();
  const report = inspectSession(fixture, "synthetic");
  expect(
    report.metrics.find((m) => m.name === "backend_to_agent"),
  ).toMatchObject({
    sampleCount: 5,
    attemptedCount: 5,
    medianMs: 300,
    p95Ms: 500,
    missingCount: 0,
    failedCount: 0,
  });
  expect(quantiles([4, 1, 3, 2])).toEqual({ medianMs: 2.5, p95Ms: 4 });
  fixture.conversationTimeline.events.pop();
  fixture.conversationTimeline.events[1]!.elapsedMs = -1;
  const incomplete = inspectSession(fixture).metrics.find(
    (m) => m.name === "backend_to_agent",
  )!;
  expect(incomplete).toMatchObject({
    sampleCount: 3,
    missingCount: 2,
    attemptedCount: 5,
  });
});
it("rejects duplicate/reversed stages and never subtracts process, generation or UTC clocks", () => {
  const fixture = inspectionFixture();
  fixture.conversationTimeline.events =
    fixture.conversationTimeline.events.slice(0, 2);
  fixture.conversationTimeline.events[1]!.elapsedMs = 0;
  fixture.conversationTimeline.events[0]!.elapsedMs = 50;
  expect(
    inspectSession(fixture).metrics.find((m) => m.name === "backend_to_agent"),
  ).toMatchObject({ sampleCount: 0, failedCount: 1 });
  fixture.conversationTimeline.events[1]!.elapsedMs = 100;
  fixture.conversationTimeline.events.push({
    ...fixture.conversationTimeline.events[0]!,
  });
  expect(
    inspectSession(fixture).metrics.find((m) => m.name === "backend_to_agent")
      ?.failedCount,
  ).toBe(1);
  const start = fixture.conversationTimeline.events[0]!,
    end = {
      ...fixture.conversationTimeline.events[1]!,
      at: "2000-01-01T00:00:00Z",
    };
  const split = {
    conversationTimeline: { ...fixture.conversationTimeline, events: [start] },
    media: { speechPipeline: { processId: "b".repeat(32), events: [end] } },
  };
  expect(
    inspectSession(split).metrics.find((m) => m.name === "backend_to_agent"),
  ).toMatchObject({ sampleCount: 0, missingCount: 2 });
  const generation = {
    conversationTimeline: {
      ...fixture.conversationTimeline,
      events: [
        { ...start, generation: 1 },
        { ...end, generation: 2 },
      ],
    },
  };
  expect(
    inspectSession(generation).metrics.find(
      (m) => m.name === "backend_to_agent",
    ),
  ).toMatchObject({ sampleCount: 0, missingCount: 2 });
});
it("allowlists export, bounds input history and exposes legacy missing correlation", () => {
  const fixture = inspectionFixture();
  const dirty = {
    ...fixture,
    token: "PRIVATE_TOKEN",
    phone: "+15559998888",
    projectRoot: "/PRIVATE_PATH",
    conversationTimeline: {
      ...fixture.conversationTimeline,
      events: Array.from({ length: 100 }, (_, index) => ({
        ...fixture.conversationTimeline.events[index % 10]!,
        text: "PRIVATE_TRANSCRIPT",
        error: "PRIVATE_EXCEPTION",
      })),
    },
  };
  const report = inspectSession(dirty);
  expect(report.overflowCount).toBe(36);
  expect(report.timeline).toHaveLength(64);
  expect(JSON.stringify(report)).not.toMatch(
    /PRIVATE|15559998888|aaaaaaaaaaaaaaaa/,
  );
  expect(
    inspectSession({
      media: { speechPipeline: { events: [{ event: "callback_accepted" }] } },
    }).uncorrelatedCount,
  ).toBe(1);
});
it("uses fixtures by default and only exports sanitized data on explicit request", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawdtime-inspect-"));
  try {
    const output = join(directory, "report.json"),
      input = join(directory, "input.json");
    expect(JSON.parse(inspectMain([])).measurementKind).toBe("synthetic");
    writeFileSync(
      input,
      JSON.stringify({ ...inspectionFixture(), token: "PRIVATE" }),
    );
    const report = inspectMain(["--input", input, "--export", output]);
    expect(readFileSync(output, "utf8")).toBe(report);
    expect(report).not.toContain("PRIVATE");
    expect(JSON.parse(report).measurementKind).toBe("unclassified");
    expect(() => inspectMain(["--export", output])).toThrow();
    expect(() => inspectMain(["--live", "true"])).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it("explains fixed readiness reasons without granting or guessing sleep", () => {
  for (const reason of Object.keys(
    readinessReasons,
  ) as (keyof typeof readinessReasons)[]) {
    const check = explainReadiness(
      { id: "fixture", status: "fail", message: "Blocked", reason },
      1000,
    );
    expect(check.checkedAt).toBe(1000);
    expect(check.nextAction).toBe(readinessReasons[reason].nextAction);
  }
  const result = summarizeReadiness(
    {
      mode: "live",
      readiness: {
        mode: "live",
        checkedAt: 1000,
        checks: [
          { id: "session_heartbeat", status: "fail", message: "Unavailable" },
          { id: "gateway", status: "unknown", message: "Unreachable" },
        ],
      },
    },
    [],
    1000,
  );
  expect(result.checks[0]!.reason).toBe("agent_stale");
  expect(result.checks[1]!.reason).toBe("gateway_unavailable");
  expect(result.nextActions).toHaveLength(2);
  expect(result.liveReady).toBe(false);
});
it("attributes failures to their own metric and counts failures even without a start stage", () => {
  const fixture = inspectionFixture();
  fixture.conversationTimeline.events.push({
    sequence: 20,
    event: "playback_failed",
    correlationId: "0".repeat(24),
    elapsedMs: 600,
    at: "2026-11-13T12:00:00Z",
  });
  fixture.conversationTimeline.events.push({
    sequence: 21,
    event: "callback_refused",
    correlationId: "f".repeat(24),
    elapsedMs: 700,
    at: "2026-11-13T12:00:00Z",
  });
  const metrics = inspectSession(fixture).metrics;
  expect(metrics.find((m) => m.name === "backend_to_agent")).toMatchObject({
    sampleCount: 5,
    failedCount: 0,
  });
  expect(metrics.find((m) => m.name === "final_to_backend")).toMatchObject({
    attemptedCount: 6,
    failedCount: 1,
    missingCount: 5,
  });
  expect(metrics.find((m) => m.name === "playback")).toMatchObject({
    attemptedCount: 1,
    failedCount: 1,
    sampleCount: 0,
  });
});
it("exports only fixed readiness reasons, timestamp and catalog next actions", () => {
  const report = inspectSession({
    ...inspectionFixture(),
    readiness: {
      checkedAt: 1000,
      checks: [
        {
          id: "session_heartbeat",
          status: "fail",
          message: "PRIVATE_MESSAGE",
          nextAction: "PRIVATE_TOKEN",
        },
        {
          id: "gateway",
          reason: "gateway_unavailable",
          status: "unknown",
          nextAction: "/PRIVATE_PATH",
        },
        {
          id: "PRIVATE_ID",
          reason: "PRIVATE_REASON",
          status: "unknown",
          message: "+15559998888",
        },
      ],
    },
  });
  expect(report.readiness.checkedAt).toBe(1000);
  expect(report.readiness.checks).toEqual([
    {
      reason: "agent_stale",
      status: "fail",
      nextAction: readinessReasons.agent_stale.nextAction,
    },
    {
      reason: "gateway_unavailable",
      status: "unknown",
      nextAction: readinessReasons.gateway_unavailable.nextAction,
    },
  ]);
  expect(report.readiness.omittedCount).toBe(1);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|15559998888/);
});

it("inspects the actual backend timeline contract without raw request or turn identifiers", () => {
  let clock = 100;
  const timeline = new ConversationTimeline("synthetic", () => clock);
  timeline.record("PRIVATE_REQUEST", "callback_accepted", "PRIVATE_TURN");
  clock = 250;
  timeline.record("PRIVATE_REQUEST", "agent_acknowledged", "PRIVATE_TURN");
  const report = inspectSession(
    { conversationTimeline: timeline.snapshot("PRIVATE_REQUEST") },
    "synthetic",
  );
  expect(
    report.metrics.find((m) => m.name === "backend_to_agent"),
  ).toMatchObject({ sampleCount: 1, medianMs: 150, p95Ms: 150 });
  expect(report.timeline).toHaveLength(2);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE|processId|correlationId/);
});
