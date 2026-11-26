import {
  timelineFor,
  ConversationTimeline,
} from "../src/transport/conversation-timeline.js";
import { inspectSession } from "../connectors/shared/inspection.js";
import { describe, expect, it } from "vitest";
import { ClawdTime } from "../src/attention/service.js";
import { readFileSync } from "node:fs";
import {
  presentationFor,
  activityProjectionSchema,
} from "../src/attention/presentation.js";
import {
  ConversationService,
  type ConversationTurn,
} from "../src/attention/conversation.js";
import { SetupService } from "../src/pairing/setup.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
} from "../src/contracts.js";

const registration = {
  protocolVersion: 2 as const,
  adapter: "codex" as const,
  adapterVersion: "fixture",
  projectRoot: "/disposable",
  externalSessionId: "same-native-session",
  hostId: "local",
  capabilities: {
    cooperativePause: true,
    polling: true,
    nativeControl: "browser" as const,
    sharedSurface: false,
  },
};
export async function fixture() {
  const store = new Store(),
    transport = new SimulationTransport();
  let now = 100_000;
  const service = new ClawdTime(store, transport, { clock: () => now });
  const invite = service.createPairingInvite({
    memberId: "human",
    recipient: "fixture",
    conversationId: "message-thread",
    lineId: "line",
    deviceId: "mac",
    displayId: "display",
  });
  const paired = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "display",
    allowView: true,
    allowControl: true,
  });
  const agent = service.registerSession(paired.token, registration);
  const request = service.requestAttention(agent.token, {
    taskId: "task",
    idempotencyKey: "one-call",
    reason: "review",
    question: "Review the disposable fixture.",
  });
  await service.drain();
  service.observeCall(request.id, "connected", true);
  const conversation = new ConversationService(service);
  const receive = (eventId: string, text = "Synthetic fixture instruction.") =>
    conversation.receive({
      eventId,
      requestId: request.id,
      memberId: "human",
      lineId: "line",
      conversationId: "message-thread",
      channel: "text",
      text,
    });
  return {
    store,
    transport,
    service,
    agent,
    paired,
    request,
    conversation,
    receive,
    advance: (ms: number) => (now += ms),
  };
}

describe("bounded activity and outcome journey", () => {
  it("runs five ordered turns, correction, approval, observed result and explicit cleanup without result messages", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      const turn = f.receive(
        `event-${i}`,
        i === 2
          ? "Correction: use the second synthetic fixture."
          : "Inspect synthetic fixture.",
      );
      expect(
        f.conversation.poll(f.agent.token, f.request.id).activity.delivery,
      ).toBe("pending");
      f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
      const activity = {
        version: 1 as const,
        activity: {
          activityId: `work-${i}`,
          kind: "status" as const,
          summary: "Checking fixture 🧪",
        },
      };
      f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "executing",
        activity,
      );
      f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "pending_approval",
        {
          version: 1,
          activity: {
            activityId: `approve-${i}`,
            kind: "approval_needed",
            summary: "Approve in the coding client",
          },
        },
      );
      const outcome = {
        version: 1 as const,
        outcome: {
          outcomeId: `done-${i}`,
          summary: "The synthetic fixture matches.",
          verification: "agent_observed" as const,
          evidenceKind: "test_result" as const,
        },
      };
      const result = f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "completed",
        outcome,
      );
      expect(activityProjectionSchema.safeParse(result.activity).success).toBe(
        true,
      );
      expect(result.activity.outcome).toMatchObject({
        status: "completed",
        verification: "agent_observed",
        summary: outcome.outcome.summary,
      });
      expect(
        f.conversation.progress(
          f.agent.token,
          f.request.id,
          turn.id,
          "completed",
          outcome,
        ),
      ).toEqual(result);
      expect(f.store.all<CallSession>("call")[0]?.state).toBe("connected");
      expect(f.transport.messages).toHaveLength(0);
    }
    expect(f.transport.calls).toHaveLength(1);
    expect(f.store.all("action")).toHaveLength(0);
    expect(f.store.effects().filter((e) => e.kind === "end_call")).toHaveLength(
      0,
    );
    f.conversation.end(f.agent.token, f.request.id);
    expect(
      f.conversation
        .poll(f.agent.token, f.request.id)
        .activity.entries.every((e) => !e.summary),
    ).toBe(true);
    await f.service.drain();
    expect(f.transport.ended).toHaveLength(1);
    f.store.close();
  });
  it("does not persist presentation text; restart retains the exact outcome receipt", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    const p = {
      version: 1 as const,
      outcome: {
        outcomeId: "result",
        summary: "SYNTHETIC_PRIVATE_SUMMARY",
        verification: "not_verified" as const,
      },
    };
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      turn.id,
      "completed",
      p,
    );
    expect(
      JSON.stringify(f.store.query("SELECT body FROM entities")),
    ).not.toContain(p.outcome.summary);
    expect(
      JSON.stringify(f.store.query("SELECT body FROM operational_state")),
    ).not.toContain(p.outcome.summary);
    const restarted = new ConversationService(f.service);
    expect(
      restarted.poll(f.agent.token, f.request.id).activity.outcome,
    ).toMatchObject({ outcomeId: "result", verification: "not_verified" });
    expect(
      restarted.progress(f.agent.token, f.request.id, turn.id, "completed", p)
        .activity.outcome?.summary,
    ).toBeUndefined();
    expect(() =>
      restarted.progress(f.agent.token, f.request.id, turn.id, "completed", {
        ...p,
        outcome: { ...p.outcome, summary: "changed" },
      }),
    ).toThrow("identity changed");
    f.store.close();
  });
  it("expires summaries without renewal on replay and keeps uncertainty dominant", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    const p = {
      version: 1 as const,
      outcome: {
        outcomeId: "uncertain",
        summary: "Outcome unresolved",
        verification: "unknown" as const,
      },
    };
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      turn.id,
      "uncertain",
      p,
    );
    f.advance(60001);
    f.store.put("session", { ...f.agent.session, lastSeenAt: 160001 });
    expect(
      f.conversation.poll(f.agent.token, f.request.id).activity.outcome
        ?.summary,
    ).toBeUndefined();
    expect(
      f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "uncertain",
        p,
      ).activity.outcome?.summary,
    ).toBeUndefined();
    const next = f.receive("next");
    f.conversation.acknowledge(f.agent.token, f.request.id, next.id);
    f.conversation.progress(f.agent.token, f.request.id, next.id, "completed");
    expect(f.conversation.poll(f.agent.token, f.request.id).activity.work).toBe(
      "uncertain",
    );
    f.store.close();
  });
  it("validates bounds/version/state without changing authority or work", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    for (const presentation of [
      { version: 2 },
      {
        version: 1,
        activity: {
          activityId: "a",
          kind: "status",
          summary: "😀".repeat(161),
        },
      },
      {
        version: 1,
        activity: { activityId: "a", kind: "status", summary: "secret\nline" },
      },
      {
        version: 1,
        outcome: {
          outcomeId: "a",
          summary: "done",
          verification: "agent_observed",
        },
      },
      {
        version: 1,
        activity: {
          activityId: "a",
          kind: "approval_needed",
          summary: "approval",
        },
      },
    ])
      expect(() =>
        f.conversation.progress(
          f.agent.token,
          f.request.id,
          turn.id,
          "executing",
          presentation as any,
        ),
      ).toThrow();
    expect(
      f.store.get<ConversationTurn>("conversation_turn", turn.id)?.state,
    ).toBe("received");
    expect(f.store.all("action")).toHaveLength(0);
    expect(f.store.all("execution")).toHaveLength(0);
    f.store.close();
  });
  it("clears on Stop, cancel and revocation, never revives old text", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    const p = {
      version: 1 as const,
      activity: {
        activityId: "a",
        kind: "status" as const,
        summary: "Private work",
      },
    };
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      turn.id,
      "pending_approval",
      p,
    );
    f.conversation.cancel(f.agent.token, f.request.id, turn.id);
    expect(
      f.conversation.poll(f.agent.token, f.request.id).activity.entries[0]
        ?.summary,
    ).toBeUndefined();
    const next = f.receive("next");
    f.conversation.acknowledge(f.agent.token, f.request.id, next.id);
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      next.id,
      "executing",
      p,
    );
    f.store.saveState(`view-stopped:${f.request.id}`, true);
    expect(
      f.conversation
        .poll(f.agent.token, f.request.id)
        .activity.entries.every((e) => !e.summary),
    ).toBe(true);
    f.store.saveState(`view-stopped:${f.request.id}`, false);
    expect(
      f.conversation
        .progress(f.agent.token, f.request.id, next.id, "executing", p)
        .activity.entries.every((e) => !e.summary),
    ).toBe(true);
    f.store.put("pairing", { ...f.paired.pairing, revokedAt: 100001 });
    expect(
      presentationFor(f.service)
        .projection(f.request.id)
        .entries.every((e) => !e.summary),
    ).toBe(true);
    f.store.close();
  });
  it("bounds per-turn fingerprints and reserves a durable outcome slot under capacity pressure", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    for (let i = 0; i < 50; i++)
      f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "executing",
        {
          version: 1,
          activity: {
            activityId: `a-${i}`,
            kind: "status",
            summary: `Step ${i}`,
          },
        },
      );
    expect(
      f.store.get<ConversationTurn>("conversation_turn", turn.id)?.presentation,
    ).toHaveLength(19);
    const result = f.conversation.progress(
      f.agent.token,
      f.request.id,
      turn.id,
      "completed",
      {
        version: 1,
        outcome: {
          outcomeId: "end",
          summary: "Not verified",
          verification: "not_verified",
        },
      },
    );
    expect(result.presentation).toHaveLength(20);
    expect(result.activity.outcome?.summary).toBe("Not verified");
    expect(f.transport.messages).toHaveLength(0);
    f.store.close();
  });
  it("rejects wrong session and new terminal receipt IDs; legacy progress remains supported", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    const other = f.service.registerSession(f.paired.token, {
      ...registration,
      externalSessionId: "other",
    });
    expect(() =>
      f.conversation.progress(other.token, f.request.id, turn.id, "executing", {
        version: 1,
      }),
    ).toThrow("does not belong");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    f.conversation.progress(f.agent.token, f.request.id, turn.id, "completed");
    expect(() =>
      f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "completed",
        {
          version: 1,
          outcome: {
            outcomeId: "late",
            summary: "late",
            verification: "agent_observed",
          },
        },
      ),
    ).toThrow("revived");
    expect(
      f.conversation.poll(f.agent.token, f.request.id).capabilities
        .presentationVersion,
    ).toBe(1);
    f.store.close();
  });
});

describe("presentation capacity and diagnostic boundaries", () => {
  it("limits global active caches without dropping turns or creating effects", async () => {
    const f = await fixture(),
      original = f.store.all<CallSession>("call")[0]!;
    for (let i = 0; i < 101; i++) {
      const requestId = `synthetic-request-${i}`,
        callId = `synthetic-call-${i}`;
      f.store.put("attention", {
        ...f.store.get<AttentionRequest>("attention", f.request.id)!,
        id: requestId,
        callId,
      });
      f.store.put("call", { ...original, id: callId, requestId });
      const turn: ConversationTurn = {
        id: `synthetic-turn-${i}`,
        requestId,
        sessionId: f.agent.session.id,
        sequence: 1,
        channel: "text",
        kind: "answer",
        createdAt: 100000,
        updatedAt: 100000,
        delivery: "acknowledged",
        state: "executing",
      };
      f.store.put("conversation_turn", turn);
      const display = presentationFor(f.service);
      display.record(
        turn,
        display.prepare(turn, "executing", {
          version: 1,
          activity: {
            activityId: "status",
            kind: "status",
            summary: "Bounded synthetic summary",
          },
        }),
      );
    }
    expect(
      presentationFor(f.service).projection("synthetic-request-99").entries[0]
        ?.summary,
    ).toBeDefined();
    expect(
      presentationFor(f.service).projection("synthetic-request-100").entries[0]
        ?.summary,
    ).toBeUndefined();
    expect(f.store.all("conversation_turn")).toHaveLength(101);
    expect(f.transport.messages).toHaveLength(0);
    expect(f.transport.calls).toHaveLength(1);
    f.store.close();
  });
  it("measures actual synthetic backend stages and preserves bounded metadata across faults", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    f.conversation.progress(f.agent.token, f.request.id, turn.id, "executing");
    f.conversation.progress(f.agent.token, f.request.id, turn.id, "uncertain", {
      version: 1,
      outcome: {
        outcomeId: "unknown",
        summary: "Unresolved synthetic effect",
        verification: "unknown",
      },
    });
    const report = inspectSession(
      { conversationTimeline: timelineFor(f.service).snapshot(f.request.id) },
      "synthetic",
    );
    expect(
      report.metrics.find((m) => m.name === "backend_to_agent")?.sampleCount,
    ).toBe(1);
    expect(JSON.stringify(report)).not.toContain("Unresolved synthetic effect");
    expect(JSON.stringify(report)).not.toContain(f.request.id);
    expect(() =>
      f.conversation.progress(
        f.agent.token,
        f.request.id,
        turn.id,
        "executing",
      ),
    ).toThrow("cannot be replayed");
    f.transport.speak = async () => ({ state: "unknown" });
    await f.conversation.reply(f.agent.token, f.request.id, {
      turnId: turn.id,
      replyId: "unknown-reply",
      text: "Synthetic unknown reply",
    });
    expect(
      timelineFor(f.service)
        .snapshot(f.request.id)
        .events.some((e) => e.event === "reply_accepted"),
    ).toBe(false);
    f.conversation.end(f.agent.token, f.request.id);
    await f.service.drain();
    expect(
      timelineFor(f.service)
        .snapshot(f.request.id)
        .events.map((e) => e.event),
    ).toContain("cleanup_confirmed");
    f.store.close();
  });
  it("bounds timeline caches, expires data and separates process restarts", () => {
    let now = 0;
    const timeline = new ConversationTimeline("synthetic", () => now);
    for (let r = 0; r < 101; r++)
      for (let e = 0; e < 70; e++)
        timeline.record(`r-${r}`, "callback_accepted", `c-${e}`);
    expect(timeline.snapshot("r-0").events).toHaveLength(64);
    expect(timeline.snapshot("r-100").events).toHaveLength(0);
    now = 600001;
    expect(timeline.snapshot("r-0").events).toHaveLength(0);
    expect(new ConversationTimeline("synthetic").processId).not.toBe(
      timeline.processId,
    );
  });
});

describe("cross-language presentation fixtures", () => {
  it("agrees on Unicode, versions, sequence and outcome receipt shape", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/presentation-v1.json", import.meta.url),
        "utf8",
      ),
    );
    for (const value of fixture.valid)
      expect(activityProjectionSchema.safeParse(value).success).toBe(true);
    for (const value of fixture.invalid)
      expect(activityProjectionSchema.safeParse(value).success).toBe(false);
  });
  it("keeps active approval visible through a correction and omits prior outcomes", async () => {
    const f = await fixture(),
      first = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, first.id);
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      first.id,
      "pending_approval",
      {
        version: 1,
        activity: {
          activityId: "approve",
          kind: "approval_needed",
          summary: "Native approval required",
        },
      },
    );
    const correction = f.receive("correction");
    let projected = f.conversation.poll(f.agent.token, f.request.id).activity;
    expect(projected).toMatchObject({
      work: "pending_approval",
      delivery: "pending",
      currentSummary: "Native approval required",
    });
    expect(activityProjectionSchema.safeParse(projected).success).toBe(true);
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      first.id,
      "completed",
      {
        version: 1,
        outcome: {
          outcomeId: "done",
          summary: "Completed first only",
          verification: "agent_observed",
        },
      },
    );
    f.conversation.acknowledge(f.agent.token, f.request.id, correction.id);
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      correction.id,
      "executing",
    );
    projected = f.conversation.poll(f.agent.token, f.request.id).activity;
    expect(projected.work).toBe("executing");
    expect(projected.outcome).toBeUndefined();
    expect(projected.currentSummary).toBeUndefined();
    expect(activityProjectionSchema.safeParse(projected).success).toBe(true);
    f.store.close();
  });
  it("rotates clock scopes instead of fabricating zero-duration samples", () => {
    let now = 0;
    const t = new ConversationTimeline("synthetic", () => now),
      before = t.processId;
    now = 86400001;
    t.record("r", "callback_accepted", "c");
    now += 250;
    t.record("r", "agent_acknowledged", "c");
    expect(t.processId).not.toBe(before);
    expect(
      inspectSession({ conversationTimeline: t.snapshot("r") }).metrics.find(
        (m) => m.name === "backend_to_agent",
      )?.medianMs,
    ).toBe(250);
    const process = t.processId;
    now = 0;
    t.record("r", "callback_accepted", "c");
    expect(t.processId).not.toBe(process);
    expect(t.snapshot("r").events).toHaveLength(1);
  });
});

it("reconciles an existing outcome after end without restoring text or effects", async () => {
  const f = await fixture(),
    turn = f.receive("first");
  f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
  const p = {
    version: 1 as const,
    outcome: {
      outcomeId: "result",
      summary: "Synthetic completed result",
      verification: "agent_observed" as const,
    },
  };
  const first = f.conversation.progress(
    f.agent.token,
    f.request.id,
    turn.id,
    "completed",
    p,
  );
  const restarted = new ConversationService(f.service);
  expect(
    restarted.poll(f.agent.token, f.request.id).activity.sequence,
  ).toBeGreaterThan(first.activity.sequence);
  f.conversation.end(f.agent.token, f.request.id);
  await f.service.drain();
  const effects = f.store.effects().length;
  expect(
    restarted.progress(f.agent.token, f.request.id, turn.id, "completed", p)
      .activity.outcome?.summary,
  ).toBeUndefined();
  expect(f.store.effects()).toHaveLength(effects);
  expect(f.transport.messages).toHaveLength(0);
  f.store.close();
});
