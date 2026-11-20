import { describe, expect, it } from "vitest";
import { ClawdTime } from "../src/attention/service.js";
import { ConversationService } from "../src/attention/conversation.js";
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
async function fixture() {
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

describe("agent-owned ordered conversation", () => {
  it("refuses a reply based on an old cursor without creating speech, then accepts current acknowledged context", async () => {
    const f = await fixture();
    const a = f.receive("first", "Use the first group.");
    f.conversation.acknowledge(f.agent.token, f.request.id, a.id);
    const cursor = f.conversation.poll(f.agent.token, f.request.id).cursor;
    const b = f.receive("correction", "Actually use the second group.");
    const reply = {
      turnId: a.id,
      replyId: "stable",
      text: "I will use the second group.",
      expectedCursor: cursor,
    };
    await expect(
      f.conversation.reply(f.agent.token, f.request.id, reply),
    ).rejects.toMatchObject({ code: "reply_context_stale" });
    expect(f.store.all("conversation_reply")).toHaveLength(0);
    expect(f.transport.spoken).toHaveLength(0);
    await expect(
      f.conversation.reply(f.agent.token, f.request.id, {
        ...reply,
        expectedCursor: 2,
      }),
    ).rejects.toMatchObject({ code: "reply_context_stale" });
    f.conversation.acknowledge(f.agent.token, f.request.id, b.id);
    const current = { ...reply, expectedCursor: 2 };
    const receipt = await f.conversation.reply(
      f.agent.token,
      f.request.id,
      current,
    );
    f.receive("third", "One more instruction.");
    expect(
      await f.conversation.reply(f.agent.token, f.request.id, current),
    ).toEqual(receipt);
    expect(f.transport.spoken).toHaveLength(1);
    f.store.close();
  });

  it("safely rejects omitted and future cursors when they do not match the conversation", async () => {
    const f = await fixture();
    const a = f.receive("first"),
      b = f.receive("second");
    f.conversation.acknowledge(f.agent.token, f.request.id, a.id);
    f.conversation.acknowledge(f.agent.token, f.request.id, b.id);
    const reply = { turnId: a.id, replyId: "stable", text: "Synthetic reply." };
    for (const expectedCursor of [undefined, 3])
      await expect(
        f.conversation.reply(f.agent.token, f.request.id, {
          ...reply,
          expectedCursor,
        }),
      ).rejects.toMatchObject({ code: "reply_context_stale" });
    expect(f.transport.spoken).toHaveLength(0);
    f.store.close();
  });
  it("poll reconciliation refreshes unknown playback by receipt ID without original speech text", async () => {
    const f = await fixture(),
      turn = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, turn.id);
    let posts = 0,
      reads = 0;
    f.transport.speak = async () => {
      posts++;
      throw new Error("Lost acceptance.");
    };
    const reply = await f.conversation.reply(f.agent.token, f.request.id, {
      turnId: turn.id,
      replyId: "stable",
      text: "Synthetic response.",
    });
    f.transport.speechStatus = async (_r, _p, replyId) => {
      reads++;
      expect(replyId).toBe(reply.id);
      return { state: "completed" };
    };
    await f.conversation.reconcileReplies(f.agent.token, f.request.id);
    expect(
      f.conversation.poll(f.agent.token, f.request.id).replies[0]?.state,
    ).toBe("completed");
    await f.conversation.reconcileReplies(f.agent.token, f.request.id);
    expect([posts, reads]).toEqual([1, 1]);
    f.store.close();
  });

  it("starts explicitly authorized setup while active and refuses legacy physical verification", async () => {
    const f = await fixture();
    f.conversation.end(f.agent.token, f.request.id);
    await f.service.drain();
    const setup = new SetupService(f.service),
      test = setup.invite(f.agent.token).test;
    await f.service.drain();
    setup.authorize(f.agent.token, test.id, true);
    expect(f.service.authenticateSession(f.agent.token).state).toBe("active");
    expect(setup.start(f.agent.token).test.state).toBe("call_requested");
    expect(() => setup.verify(f.agent.token)).toThrow(
      "separately recorded physical acceptance",
    );
    f.store.close();
  });
  it("binds panel end to the exact v2 call and keeps cleanup idempotent", async () => {
    const f = await fixture(),
      call = f.store.all<CallSession>("call")[0]!;
    expect(() =>
      f.service.endConversationFromPanel(f.request.id, "foreign", call.id),
    ).toThrow("binding");
    expect(() =>
      f.service.endConversationFromPanel(
        f.request.id,
        f.agent.session.id,
        "foreign",
      ),
    ).toThrow("binding");
    expect(
      f.service.endConversationFromPanel(
        f.request.id,
        f.agent.session.id,
        call.id,
      ).state,
    ).toBe("completed");
    f.service.endConversationFromPanel(
      f.request.id,
      f.agent.session.id,
      call.id,
    );
    expect(f.store.effects().filter((e) => e.kind === "end_call")).toHaveLength(
      1,
    );
    f.store.close();
  });

  it("delivers several turns to one active session without ending its call or view", async () => {
    const f = await fixture();
    const call = f.store.all<CallSession>("call")[0]!;
    f.store.put<ControlLease>("lease", {
      id: "view",
      requestId: f.request.id,
      sessionId: f.agent.session.id,
      pairingId: f.paired.pairing.id,
      callId: call.id,
      deviceId: "mac",
      displayId: "display",
      memberId: "human",
      mode: "view",
      epoch: 0,
      expiresAt: 500000,
      state: "active",
    });
    const a = f.receive("first"),
      b = f.receive("second", "Correction: use the other fixture color.");
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    const poll = f.conversation.poll(f.agent.token, f.request.id, 0);
    expect(poll.turns.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(() =>
      f.conversation.acknowledge(f.agent.token, f.request.id, b.id),
    ).toThrow("earlier");
    f.conversation.acknowledge(f.agent.token, f.request.id, a.id);
    f.conversation.progress(f.agent.token, f.request.id, a.id, "executing");
    f.conversation.acknowledge(f.agent.token, f.request.id, b.id);
    expect(() =>
      f.conversation.progress(f.agent.token, f.request.id, b.id, "executing"),
    ).toThrow("earlier");
    await f.conversation.reply(f.agent.token, f.request.id, {
      turnId: a.id,
      replyId: "reply-a",
      text: "The fixture change is done.",
      expectedCursor: 2,
    });
    f.conversation.progress(f.agent.token, f.request.id, a.id, "completed");
    f.conversation.progress(
      f.agent.token,
      f.request.id,
      b.id,
      "pending_approval",
    );
    expect(
      f.conversation.poll(f.agent.token, f.request.id, 0).turns[0]?.text,
    ).toBeUndefined();
    expect(
      f.store.get<AgentSession>("session", f.agent.session.id)?.state,
    ).toBe("active");
    expect(f.store.get<ControlLease>("lease", "view")?.state).toBe("active");
    expect(f.store.all<CallSession>("call")[0]?.state).toBe("connected");
    expect(f.store.effect(`${f.request.id}:end`)).toBeUndefined();
    expect(f.transport.spoken).toHaveLength(1);
    f.store.close();
  });
  it("deduplicates delivery, refuses changed event/reply IDs, and plays a reply at most once", async () => {
    const f = await fixture(),
      a = f.receive("first");
    expect(f.receive("first")).toEqual(a);
    expect(() => f.receive("first", "Changed text.")).toThrow(
      "identity changed",
    );
    f.conversation.acknowledge(f.agent.token, f.request.id, a.id);
    const reply = {
      turnId: a.id,
      replyId: "stable",
      text: "A synthetic spoken response.",
    };
    const result = await f.conversation.reply(
      f.agent.token,
      f.request.id,
      reply,
    );
    expect(
      await f.conversation.reply(f.agent.token, f.request.id, reply),
    ).toEqual(result);
    await expect(
      f.conversation.reply(f.agent.token, f.request.id, {
        ...reply,
        text: "Different.",
      }),
    ).rejects.toThrow("identity changed");
    await expect(
      f.conversation.reply(f.agent.token, f.request.id, {
        ...reply,
        replyId: "replacement",
      }),
    ).rejects.toThrow("original identity");
    expect(f.transport.spoken).toHaveLength(1);
    expect(JSON.stringify(f.store.all("conversation_reply"))).not.toContain(
      reply.text,
    );
    expect(
      f.store.event<{ turnId: string }>("conversation:first")?.result,
    ).toEqual({ turnId: a.id });
    f.store.close();
  });
  it("reconnect retrieves the same cursor and unknown reply without resending speech", async () => {
    const f = await fixture(),
      a = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, a.id);
    const attempts: boolean[] = [];
    f.transport.speak = async (_r, _p, _id, _text, reconcileOnly = false) => {
      attempts.push(reconcileOnly);
      throw new Error("Synthetic transport response lost after submission");
    };
    const reply = { turnId: a.id, replyId: "stable", text: "Synthetic reply." };
    expect(
      (await f.conversation.reply(f.agent.token, f.request.id, reply)).state,
    ).toBe("unknown");
    const renewed = f.service.registerSession(f.paired.token, registration);
    const next = new ConversationService(f.service);
    expect(next.poll(renewed.token, f.request.id, 0).turns[0]?.id).toBe(a.id);
    expect((await next.reply(renewed.token, f.request.id, reply)).state).toBe(
      "unknown",
    );
    expect(attempts).toEqual([false, true]);
    expect(() => next.poll(f.agent.token, f.request.id, 0)).toThrow("revoked");
    expect(() => next.poll(renewed.token, f.request.id, 2)).toThrow("ahead");
    f.store.close();
  });
  it("keeps in-flight cancellation cooperative and restart outcomes uncertain", async () => {
    const f = await fixture(),
      a = f.receive("first");
    f.conversation.acknowledge(f.agent.token, f.request.id, a.id);
    f.conversation.progress(f.agent.token, f.request.id, a.id, "executing");
    expect(
      f.conversation.cancel(f.agent.token, f.request.id, a.id),
    ).toMatchObject({ state: "executing", cancellationRequestedAt: 100000 });
    const restarted = new ConversationService(f.service);
    expect(
      restarted.poll(f.agent.token, f.request.id, 0).turns[0],
    ).toMatchObject({ state: "uncertain" });
    expect(() =>
      restarted.progress(f.agent.token, f.request.id, a.id, "executing"),
    ).toThrow("cannot be replayed");
    expect(() =>
      restarted.progress(f.agent.token, f.request.id, a.id, "completed"),
    ).toThrow("cannot be replayed");
    // An unresolved action prevents replay, not the original agent explaining it.
    expect(
      (
        await restarted.reply(f.agent.token, f.request.id, {
          turnId: a.id,
          replyId: "uncertain-status",
          text: "The previous outcome is uncertain; I will not repeat it.",
        })
      ).state,
    ).toBe("completed");
    const b = f.receive("second");
    restarted.acknowledge(f.agent.token, f.request.id, b.id);
    expect(
      restarted.progress(f.agent.token, f.request.id, b.id, "pending_approval")
        .state,
    ).toBe("pending_approval");
    expect(f.conversation.cancel(f.agent.token, f.request.id, b.id).state).toBe(
      "canceled",
    );
    f.store.close();
  });
  it("keeps an unread answer readable after the human hangs up, then redacts it once delivered", async () => {
    const f = await fixture();
    const answer = f.receive("answer", "Use the blue heading.");
    f.service.observeCall(f.request.id, "ended");
    expect(
      f.store.get<AttentionRequest>("attention", f.request.id)?.state,
    ).toBe("disconnected");
    // The one-second runtime tick prunes before the agent's next poll.
    f.conversation.prune();
    const unread = f.conversation.poll(f.agent.token, f.request.id).turns[0];
    expect(unread).toMatchObject({
      id: answer.id,
      state: "received",
      delivery: "pending",
      text: "Use the blue heading.",
    });
    // A restart must not drop it either.
    expect(
      new ConversationService(f.service).poll(f.agent.token, f.request.id)
        .turns[0]?.text,
    ).toBe("Use the blue heading.");
    f.conversation.acknowledge(f.agent.token, f.request.id, answer.id);
    f.conversation.prune();
    const delivered = f.conversation.poll(f.agent.token, f.request.id).turns[0];
    expect(delivered).toMatchObject({
      id: answer.id,
      state: "canceled",
      delivery: "acknowledged",
    });
    expect(delivered).not.toHaveProperty("text");
    f.store.close();
  });
  it("drops the unread answer when the session stops after the hangup", async () => {
    const f = await fixture();
    const answer = f.receive("answer", "Use the blue heading.");
    f.service.observeCall(f.request.id, "ended");
    f.conversation.prune();
    f.service.disconnect(f.agent.token);
    f.conversation.prune();
    const stored = f.store.get<{ state: string; text?: string }>(
      "conversation_turn",
      answer.id,
    );
    expect(stored).toMatchObject({ state: "canceled" });
    expect(stored).not.toHaveProperty("text");
    f.store.close();
  });
  it("drops an unread answer after 24 hours even when it was never delivered", async () => {
    const f = await fixture();
    const answer = f.receive("answer", "Use the blue heading.");
    f.service.observeCall(f.request.id, "ended");
    f.advance(24 * 60 * 60 * 1000);
    f.conversation.prune();
    const stored = f.store.get<{ state: string; text?: string }>(
      "conversation_turn",
      answer.id,
    );
    expect(stored).toMatchObject({ state: "canceled" });
    expect(stored).not.toHaveProperty("text");
    f.store.close();
  });
  it("requires exact session and qualified voice without substituting for native approval", async () => {
    const f = await fixture(),
      a = f.receive("first");
    const other = f.service.registerSession(f.paired.token, {
      ...registration,
      externalSessionId: "other",
    });
    expect(() => f.conversation.poll(other.token, f.request.id, 0)).toThrow(
      "does not belong",
    );
    expect(() =>
      f.conversation.receive({
        eventId: "voice",
        requestId: f.request.id,
        memberId: "human",
        lineId: "line",
        conversationId: "message-thread",
        channel: "voice",
        text: "Synthetic approval.",
        callId: f.store.all<CallSession>("call")[0]!.id,
        qualifiedRemoteAudio: true,
        kind: "approval",
      }),
    ).toThrow("native agent approval");
    expect(() =>
      f.conversation.progress(f.agent.token, f.request.id, a.id, "executing"),
    ).toThrow("Acknowledge");
    expect(() => f.service.resume(f.agent.token, f.request.id, 0)).toThrow(
      "legacy resume",
    );
    expect(() =>
      f.service.registerSession(f.paired.token, {
        ...registration,
        protocolVersion: 1,
      }),
    ).toThrow("differs");
    expect(() =>
      f.service.registerSession(f.paired.token, {
        ...registration,
        externalSessionId: "bad",
        capabilities: { cooperativePause: true, polling: false },
      }),
    ).toThrow("bounded polling");
    f.store.close();
  });
  it("renews the active coding session beyond five minutes and closes only on explicit end", async () => {
    const f = await fixture();
    for (let i = 0; i < 80; i++) {
      f.advance(5000);
      f.service.heartbeat(f.agent.token);
    }
    expect(
      f.store.get<AttentionRequest>("attention", f.request.id)?.deadline,
    ).toBe(800000);
    const turn = f.receive("last");
    const ended = f.conversation.end(f.agent.token, f.request.id);
    expect(ended.request.state).toBe("completed");
    expect(ended.cleanupPending).toBe(true);
    expect(f.store.effect(`${f.request.id}:end`)?.state).toBe("pending");
    expect(
      f.conversation.poll(f.agent.token, f.request.id).turns[0],
    ).toMatchObject({ id: turn.id, state: "canceled" });
    await f.service.drain();
    expect(f.conversation.end(f.agent.token, f.request.id).cleanupPending).toBe(
      false,
    );
    expect(f.transport.ended).toHaveLength(1);
    f.store.close();
  });
  it.each(["hangup", "heartbeat", "revocation", "stop"] as const)(
    "closes authority on %s without replaying pending content",
    async (reason) => {
      const f = await fixture(),
        a = f.receive("first");
      if (reason === "hangup") f.service.observeCall(f.request.id, "ended");
      if (reason === "heartbeat") {
        f.advance(20000);
        f.service.expireSessions();
      }
      if (reason === "revocation") f.service.disconnect(f.agent.token);
      if (reason === "stop")
        f.store.saveState(`listening-stopped:${f.request.id}`, true);
      expect(() => f.receive("second")).toThrow();
      // A hangup keeps the unread turn for delivery; see the hangup test above.
      if (reason === "heartbeat" || reason === "revocation") {
        f.conversation.prune();
        expect(
          f.store.get<{ text?: string }>("conversation_turn", a.id)?.text,
        ).toBeUndefined();
      }
      f.store.close();
    },
  );
});
