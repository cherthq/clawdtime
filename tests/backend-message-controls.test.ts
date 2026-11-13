import { describe, expect, it } from "vitest";
import { ClawdTime } from "../src/attention/service.js";
import { ConversationService } from "../src/attention/conversation.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import type { SessionRegistration } from "../src/contracts.js";

const interaction = {
  version: 1,
  commandChannel: "imessage_first",
  messageUpdates: true,
} as const;
function fixture(opted = true) {
  let now = 100_000;
  const store = new Store(),
    transport = new SimulationTransport();
  const service = new ClawdTime(store, transport, { clock: () => now });
  const invitation = service.createPairingInvite({
    memberId: "human",
    recipient: "fixture-recipient",
    conversationId: "fixture-thread",
    lineId: "fixture-line",
    deviceId: "mac",
    displayId: "screen",
  });
  const pairing = service.claimPairing({
    token: invitation.token,
    deviceId: "mac",
    displayId: "screen",
    allowView: true,
    allowControl: true,
  });
  const registration: SessionRegistration = {
    protocolVersion: 2,
    adapter: "codex",
    adapterVersion: "test",
    externalSessionId: "original-agent",
    hostId: "local",
    projectRoot: "/synthetic",
    capabilities: { cooperativePause: true, polling: true },
    ...(opted ? { interaction } : {}),
  };
  const agent = service.registerSession(pairing.token, registration);
  const conversation = new ConversationService(service);
  const event = (id: string, text = "Use the blue fixture.") => ({
    id,
    text,
    sender: pairing.pairing.recipient,
    lineId: pairing.pairing.lineId,
    conversationId: pairing.pairing.conversationId,
  });
  const route = (id: string, text?: string) =>
    conversation.resolveTextTarget(pairing.pairing.id, event(id, text));
  const receive = (requestId: string, id: string, text?: string) =>
    conversation.receive({
      eventId: id,
      requestId,
      memberId: pairing.pairing.memberId,
      lineId: pairing.pairing.lineId,
      conversationId: pairing.pairing.conversationId,
      channel: "text",
      text: text ?? "Use the blue fixture.",
    });
  return {
    store,
    transport,
    service,
    pairing,
    registration,
    agent,
    conversation,
    route,
    receive,
    event,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("iMessage-first controls", () => {
  it("allows explicit replies and inbox routing when routine updates are disabled", async () => {
    const f = fixture();
    const quiet = f.service.registerSession(f.pairing.token, {
      ...f.registration,
      externalSessionId: "quiet-agent",
      interaction: { ...interaction, messageUpdates: false },
    });
    f.route("selection", `/use ${quiet.session.id}`);
    const request = f.route("quiet").requestId!,
      turn = f.receive(request, "quiet");
    f.conversation.acknowledge(quiet.token, request, turn.id);
    f.conversation.progress(quiet.token, request, turn.id, "completed");
    expect(f.store.effects()).toHaveLength(0);
    await f.conversation.reply(quiet.token, request, {
      turnId: turn.id,
      replyId: "quiet-reply",
      text: "Here is the result.",
    });
    await f.service.drain();
    expect(f.transport.messages.map((message) => message.text)).toEqual([
      "Here is the result.",
    ]);
    expect(f.conversation.inbox(quiet.token).requests).toHaveLength(1);
    f.store.close();
  });

  it("orders voice and text together and propagates the exact cursor into speech", async () => {
    const f = fixture();
    const voiced = f.service.registerSession(f.pairing.token, {
      ...f.registration,
      externalSessionId: "voice-agent",
      capabilities: {
        ...f.registration.capabilities,
        voiceInteractionVersion: 1,
      },
    });
    const request = f.service.requestAttention(voiced.token, {
      taskId: "task",
      idempotencyKey: "call",
      reason: "decision",
      question: "Choose the fixture.",
    });
    await f.service.drain();
    f.service.observeCall(request.id, "connected", true);
    const call = f.service.store.get<{ callId: string }>(
      "attention",
      request.id,
    )!;
    const first = f.conversation.receive({
      eventId: "voice:first",
      requestId: request.id,
      memberId: "human",
      lineId: "fixture-line",
      conversationId: "fixture-thread",
      channel: "voice",
      text: "Use the blue fixture.",
      qualifiedRemoteAudio: true,
      callId: call.callId,
    });
    const second = f.receive(request.id, "text-second", "Actually use green.");
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    f.conversation.acknowledge(voiced.token, request.id, first.id);
    f.conversation.acknowledge(voiced.token, request.id, second.id);
    let revision: number | undefined;
    f.service.transport.speak = async (
      _r,
      _p,
      _id,
      _text,
      _lookup,
      expectedRevision,
    ) => {
      revision = expectedRevision;
      return { state: "completed" };
    };
    await f.conversation.reply(voiced.token, request.id, {
      turnId: first.id,
      replyId: "speech",
      text: "I heard your correction.",
      expectedCursor: 2,
    });
    expect(revision).toBe(2);
    expect(
      f.conversation.poll(voiced.token, request.id).replies[0]?.channel,
    ).toBe("voice");
    f.store.close();
  });

  it("refuses voice override without a connected call and closes stale queued text sends", async () => {
    const f = fixture(),
      request = f.route("m1").requestId!,
      turn = f.receive(request, "m1");
    f.conversation.acknowledge(f.agent.token, request, turn.id);
    await expect(
      f.conversation.reply(f.agent.token, request, {
        turnId: turn.id,
        replyId: "voice",
        text: "Synthetic speech.",
        channel: "voice",
      }),
    ).rejects.toThrow("connected call");
    await f.conversation.reply(f.agent.token, request, {
      turnId: turn.id,
      replyId: "text",
      text: "Private response.",
    });
    f.advance(20_000);
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(0);
    expect(JSON.stringify(f.store.effects())).not.toContain(
      "Private response.",
    );
    f.store.close();
  });

  it("opens an exact running agent inbox without calling or granting computer control", () => {
    const f = fixture(),
      routed = f.route("message-1");
    expect(routed.requestId).toBeTruthy();
    const turn = f.receive(routed.requestId!, "message-1");
    expect(f.conversation.inbox(f.agent.token).requests).toMatchObject([
      { id: routed.requestId, sessionId: f.agent.session.id },
    ]);
    expect(
      f.conversation.poll(f.agent.token, routed.requestId!).turns[0],
    ).toMatchObject({ id: turn.id, delivery: "pending" });
    expect(f.store.all("call")).toHaveLength(0);
    expect(f.store.all("lease")).toHaveLength(0);
    expect(f.store.effects().every((effect) => effect.kind === "message")).toBe(
      true,
    );
    f.store.close();
  });

  it("coalesces unsent status updates and delivers actual text replies once with honest receipt semantics", async () => {
    const f = fixture(),
      request = f.route("message-1").requestId!,
      turn = f.receive(request, "message-1");
    f.conversation.acknowledge(f.agent.token, request, turn.id);
    f.conversation.progress(
      f.agent.token,
      request,
      turn.id,
      "pending_approval",
    );
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(1);
    expect(f.transport.messages[0]!.text).toContain("waiting for approval");
    const input = {
      turnId: turn.id,
      replyId: "result",
      text: "The fixture is now blue.",
    };
    const queued = await f.conversation.reply(f.agent.token, request, input);
    expect(queued).toMatchObject({
      channel: "text",
      state: "accepted",
      delivery: "queued",
    });
    await f.service.drain();
    expect(
      await f.conversation.reply(f.agent.token, request, input),
    ).toMatchObject({
      channel: "text",
      state: "completed",
      delivery: "transport_acknowledged",
    });
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(2);
    expect(f.transport.messages[1]!.pairingId).toBe(f.pairing.pairing.id);
    expect(f.transport.spoken).toHaveLength(0);
    expect(JSON.stringify(f.store.effects())).not.toContain(input.text);
    expect(JSON.stringify(f.store.all("conversation_reply"))).not.toContain(
      input.text,
    );
    f.store.close();
  });

  it("preserves unknown sends across restarts and never probes speech for text receipts", async () => {
    const f = fixture(),
      request = f.route("m1").requestId!,
      turn = f.receive(request, "m1");
    f.conversation.acknowledge(f.agent.token, request, turn.id);
    const input = {
      turnId: turn.id,
      replyId: "reply",
      text: "Synthetic response.",
    };
    await f.conversation.reply(f.agent.token, request, input);
    let sends = 0,
      speechReads = 0;
    f.transport.message = async () => {
      sends++;
      throw new Error("Unknown external effect.");
    };
    f.transport.speechStatus = async () => {
      speechReads++;
      return { state: "completed" };
    };
    await f.service.drain();
    const restarted = new ConversationService(f.service);
    await restarted.reconcileReplies(f.agent.token, request);
    expect(await restarted.reply(f.agent.token, request, input)).toMatchObject({
      state: "unknown",
      delivery: "unconfirmed",
    });
    await f.service.drain();
    expect([sends, speechReads]).toEqual([1, 0]);
    expect(JSON.stringify(f.store.effects())).not.toContain(input.text);
    f.store.close();
  });

  it("refuses a stale queued text reply after a correction, without sending it", async () => {
    const f = fixture(),
      request = f.route("m1").requestId!,
      turn = f.receive(request, "m1");
    f.conversation.acknowledge(f.agent.token, request, turn.id);
    const input = {
      turnId: turn.id,
      replyId: "reply",
      text: "The old answer.",
    };
    await f.conversation.reply(f.agent.token, request, input);
    f.receive(request, "m2", "Actually use green.");
    await f.service.drain();
    expect(
      f.transport.messages.some((message) => message.text === input.text),
    ).toBe(false);
    expect(
      await f.conversation.reply(f.agent.token, request, input),
    ).toMatchObject({ state: "failed", delivery: "not_sent" });
    f.store.close();
  });

  it("binds selection and duplicate messages to their original request despite later selection", () => {
    const f = fixture();
    const second = f.service.registerSession(f.pairing.token, {
      ...f.registration,
      externalSessionId: "other-agent",
    });
    expect(f.route("ambiguous").reply).toContain("Choose");
    expect(f.store.all("attention")).toHaveLength(0);
    expect(f.route("list", "/sessions").reply).toContain(second.session.id);
    f.route("select1", `/use ${f.agent.session.id}`);
    const first = f.route("m1");
    f.route("select2", `/use ${second.session.id}`);
    const other = f.route("m2");
    expect(other.requestId).not.toBe(first.requestId);
    expect(f.route("m1")).toEqual(first);
    expect(() => f.route("m1", "Changed instruction.")).toThrow(
      "identity changed",
    );
    expect(
      f.conversation.inbox(f.agent.token).requests.map((r) => r.id),
    ).toEqual([first.requestId]);
    expect(() => f.conversation.poll(second.token, first.requestId!)).toThrow(
      "does not belong",
    );
    f.store.close();
  });

  it("rejects wrong message identity and unavailable sessions without recreating them", () => {
    const f = fixture();
    expect(() =>
      f.conversation.resolveTextTarget(f.pairing.pairing.id, {
        ...f.event("bad"),
        sender: "other",
      }),
    ).toThrow("identity");
    f.advance(20_000);
    expect(f.route("m1").reply).toContain("No available");
    expect(f.store.all("attention")).toHaveLength(0);
    expect(f.store.all("session")).toHaveLength(1);
    f.store.close();
  });

  it("does not silently enable messages for legacy omitted registrations or mutate registered preference", () => {
    const f = fixture(false);
    expect(f.route("m1").reply).toContain("No available");
    expect(f.store.effects()).toHaveLength(0);
    expect(() =>
      f.service.registerSession(f.pairing.token, {
        ...f.registration,
        interaction,
      }),
    ).toThrow("differs");
    expect(() =>
      f.service.registerSession(f.pairing.token, {
        ...f.registration,
        externalSessionId: "v1",
        protocolVersion: 1,
        interaction,
      }),
    ).toThrow("version 2");
    f.store.close();
  });

  it("gates input on the current acknowledged revision without blocking read-only polling", () => {
    const f = fixture(),
      request = f.route("m1").requestId!,
      first = f.receive(request, "m1");
    expect(() =>
      f.conversation.assertCurrentInput(f.agent.token, request, 1),
    ).toThrow("acknowledge");
    f.conversation.acknowledge(f.agent.token, request, first.id);
    expect(
      f.conversation.assertCurrentInput(f.agent.token, request, 1).cursor,
    ).toBe(1);
    const correction = f.receive(request, "m2", "Use green.");
    expect(
      f.conversation.poll(f.agent.token, request).executionRevision,
    ).toMatchObject({ cursor: 2, acknowledgedCursor: 1 });
    expect(() =>
      f.conversation.assertCurrentInput(f.agent.token, request, 1),
    ).toThrow("acknowledge");
    f.conversation.acknowledge(f.agent.token, request, correction.id);
    expect(() =>
      f.conversation.assertCurrentInput(f.agent.token, request, 1),
    ).toThrow("acknowledge");
    expect(
      f.conversation.assertCurrentInput(f.agent.token, request, 2).cursor,
    ).toBe(2);
    f.store.close();
  });

  it("deduplicates event identity while preserving identical text sent as distinct messages", () => {
    const f = fixture(),
      request = f.route("m1").requestId!;
    const first = f.receive(request, "m1"),
      replay = f.receive(request, "m1"),
      second = f.receive(request, "m2");
    expect(replay.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.sequence).toBe(2);
    expect(f.store.effects()).toHaveLength(2);
    f.store.close();
  });

  it("closes pending message authority on Stop and clears their private content", async () => {
    const f = fixture(),
      request = f.route("m1").requestId!,
      turn = f.receive(request, "m1");
    f.conversation.acknowledge(f.agent.token, request, turn.id);
    await f.conversation.reply(f.agent.token, request, {
      turnId: turn.id,
      replyId: "reply",
      text: "Private fixture response.",
    });
    f.store.saveState(`listening-stopped:${request}`, true);
    await f.service.drain();
    expect(f.transport.messages).toHaveLength(0);
    expect(JSON.stringify(f.store.effects())).not.toContain(
      "Private fixture response",
    );
    f.store.close();
  });
});
