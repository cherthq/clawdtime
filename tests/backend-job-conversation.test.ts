import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { JobBroker } from "../src/attention/jobs.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  JobConversation,
  type ConversationModel,
  type ProposedIntent,
} from "../src/control/job-conversation.js";
import { ConversationService } from "../src/attention/conversation.js";
import { createApp } from "../src/app.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import type {
  ExecutionResult,
  ExecutionRunner,
  TextControlGrant,
} from "../src/contracts.js";
const reply = (text: string): ProposedIntent => ({
  action: "reply",
  reply: text,
  instruction: null,
  kind: null,
  jobId: null,
  target: null,
  verification: null,
});
const submit: ProposedIntent = {
  ...reply("Queued"),
  action: "submit",
  kind: "file",
  instruction: "Create fixture.txt with SYNTHETIC",
  verification: {
    kind: "file_contains",
    path: "fixture.txt",
    expected: "SYNTHETIC",
  },
};
function fixture(model?: ConversationModel, available = true) {
  const store = new Store(),
    transport = new SimulationTransport(),
    service = new ClawdTime(store, transport);
  const invite = service.createPairingInvite({
    memberId: "human",
    recipient: "fixture",
    lineId: "line",
    conversationId: "messages",
    deviceId: "mac",
    displayId: "1",
  });
  const pairing = service.claimPairing({
    token: invite.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const agent = service.registerSession(pairing.token, {
    adapter: "codex",
    adapterVersion: "test",
    projectRoot: "/fixture",
    externalSessionId: "api-managed",
    hostId: "host",
    protocolVersion: 2,
    conversation: {
      version: 1,
      runnerId: "runner",
      executionSession: "api_managed",
    },
    capabilities: {
      polling: true,
      cooperativePause: true,
      voiceInteractionVersion: 1,
    },
  });
  const binding = {
    sessionId: agent.session.id,
    pairingId: pairing.pairing.id,
    memberId: "human",
  };
  let resolve!: (result: ExecutionResult) => void,
    calls = 0,
    aborted = false;
  const runner: ExecutionRunner = {
    capabilities: () => ({
      id: "runner",
      host: "codex_app_server",
      available,
      version: "fixture",
      nativeControl: "none",
      customControl: false,
      cancellation: "cooperative",
    }),
    run: async (_request, emit, signal) => {
      calls++;
      emit({ type: "accepted" });
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const broker = new JobBroker(service, [runner]),
    frontend = new JobConversation(service, broker, model);
  const control = new ControlCoordinator(store, new SimulatedDevice()),
    human = new HumanRouter(service, control);
  const app = createApp(service, control, human, {
    origin: "http://127.0.0.1:3310",
    simulation: true,
    conversation: frontend,
    mediaToken: "m".repeat(32),
    twoWayVoiceEnabled: true,
    remoteAudioIsolated: true,
  });
  return {
    store,
    transport,
    service,
    agent,
    pairing,
    binding,
    broker,
    frontend,
    app,
    calls: () => calls,
    aborted: () => aborted,
    finish: () =>
      resolve({
        outcome: "succeeded",
        summary: "Synthetic",
        verification: {
          verified: true,
          method: "file_read",
          evidenceId: "fixture",
        },
        unresolvedEffectIds: [],
      }),
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("shared text and voice conversational frontend", () => {
  it("clarifies first and remains responsive while an actual asynchronous adapter is pending", async () => {
    let turns = 0;
    const f = fixture({
      propose: async () =>
        ++turns === 1
          ? { ...reply("Which file should I change?"), action: "clarify" }
          : submit,
    });
    expect(
      (
        await f.frontend.receive(
          f.binding,
          { channel: "text", eventId: "unclear" },
          "Change it",
        )
      ).reply,
    ).toContain("Which file");
    expect(f.broker.list(f.binding)).toHaveLength(0);
    const result = await f.frontend.receive(
      f.binding,
      { channel: "text", eventId: "clear" },
      "Create fixture.txt containing SYNTHETIC",
    );
    expect(result.job?.state).toBe("queued");
    await settle();
    expect(f.calls()).toBe(1);
    const status = await f.frontend.receive(
      f.binding,
      { channel: "voice", eventId: "progress" },
      "status",
    );
    expect(status.reply).toContain("Completion is not yet verified");
    expect(f.broker.list(f.binding)[0]?.state).toBe("running");
    f.finish();
    await settle();
    expect(
      (
        await f.frontend.receive(
          f.binding,
          { channel: "text", eventId: "final" },
          "status",
        )
      ).reply,
    ).toContain("independently verified");
    f.store.close();
  });
  it("new text supersedes an unresolved voice proposal without dispatching stale work", async () => {
    let release!: (value: ProposedIntent) => void;
    const f = fixture({
      propose: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const voice = f.frontend.receive(
      f.binding,
      { channel: "voice", eventId: "voice" },
      "Make a file",
    );
    const status = await f.frontend.receive(
      f.binding,
      { channel: "text", eventId: "text" },
      "status",
    );
    expect(status.sequence).toBe(2);
    release(submit);
    expect((await voice).stale).toBe(true);
    expect(f.broker.list(f.binding)).toHaveLength(0);
    expect(f.calls()).toBe(0);
    f.store.close();
  });
  it("duplicate channel event does not run a model or submit twice", async () => {
    let models = 0;
    const f = fixture({
      propose: async () => {
        models++;
        return submit;
      },
    });
    const input = { channel: "text" as const, eventId: "same" };
    const first = await f.frontend.receive(f.binding, input, "Create fixture");
    expect(
      (await f.frontend.receive(f.binding, input, "Create fixture")).duplicate,
    ).toBe(true);
    expect(models).toBe(1);
    expect(f.broker.list(f.binding)).toHaveLength(1);
    await expect(
      f.frontend.receive(f.binding, input, "Changed text"),
    ).rejects.toThrow("content changed");
    await settle();
    f.finish();
    await settle();
    expect(f.broker.status(f.binding, first.job!.id).state).toBe("succeeded");
    f.store.close();
  });
  it("quieting speech does not cancel work but an explicit cancel requests quiescence", async () => {
    const f = fixture({ propose: async () => submit });
    await f.frontend.receive(
      f.binding,
      { channel: "text", eventId: "start" },
      "Create fixture",
    );
    await settle();
    const quiet = await f.frontend.receive(
      f.binding,
      { channel: "voice", eventId: "quiet" },
      "stop speaking",
    );
    expect(quiet.quiet).toBe(true);
    expect(f.aborted()).toBe(false);
    const canceled = await f.frontend.receive(
      f.binding,
      { channel: "text", eventId: "cancel" },
      "cancel task",
    );
    expect(canceled.job?.state).toBe("cancel_requested");
    expect(f.aborted()).toBe(true);
    f.finish();
    await settle();
    // Submitted work may finish; cancellation does not manufacture a canceled result.
    expect(f.broker.list(f.binding)[0]?.state).toBe("succeeded");
    f.store.close();
  });
  it("unavailable runner is reported without misleading queued work", async () => {
    const f = fixture({ propose: async () => submit }, false);
    const result = await f.frontend.receive(
      f.binding,
      { channel: "text", eventId: "start" },
      "Create fixture",
    );
    expect(result.reply).toContain("unavailable");
    expect(result.job).toBeUndefined();
    expect(f.broker.list(f.binding)).toHaveLength(0);
    await f.service.drain();
    expect(f.transport.messages[0]?.text).toContain("unavailable");
    f.store.close();
  });
  it("exposes jobs only to authenticated exact sessions and refuses unqualified voice", async () => {
    const f = fixture();
    expect((await f.app.request("/api/jobs")).status).toBe(401);
    expect(
      (
        await f.app.request("/api/jobs", {
          headers: { authorization: `Bearer ${f.agent.token}` },
        })
      ).status,
    ).toBe(200);
    const request = f.service.requestAttention(f.agent.token, {
      taskId: "fixture",
      reason: "review",
      question: "Fixture",
      idempotencyKey: "one",
    });
    await f.service.drain();
    const call = f.store
      .all<{ id: string; requestId: string }>("call")
      .find((c) => c.requestId === request.id)!;
    const response = await f.app.request(
      `/media/${call.id}/conversation/turn`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          eventId: "voice",
          text: "status",
          callId: call.id,
          qualifiedRemoteAudio: true,
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(f.broker.list(f.binding)).toHaveLength(0);
    f.store.close();
  });
  it("lists and selects new broker sessions without fabricating attention or call state", () => {
    const f = fixture(),
      legacy = new ConversationService(f.service);
    const event = {
      id: "select",
      sender: "fixture",
      lineId: "line",
      conversationId: "messages",
      text: `/use ${f.agent.session.id}`,
      sequence: 1,
    };
    expect(
      legacy.resolveTextTarget(f.pairing.pairing.id, event).reply,
    ).toContain("API-managed");
    expect(f.frontend.selected(f.pairing.pairing)?.id).toBe(f.agent.session.id);
    expect(f.store.all("attention")).toHaveLength(0);
    expect(f.store.all("call")).toHaveLength(0);
    f.store.close();
  });
  it("passes bounded voice context transiently and binds deduplication to its exact content", async () => {
    let observed: Parameters<ConversationModel["propose"]>[0] | undefined;
    const f = fixture({
      propose: async (input) => {
        observed = input;
        return reply("Which exact result do you want?");
      },
    });
    const context = [
      { role: "user" as const, text: "Synthetic voice context" },
      { role: "assistant" as const, text: "Synthetic conversational response" },
    ];
    const source = { channel: "voice" as const, eventId: "context-turn" };
    const received = await f.frontend.receive(
      f.binding,
      source,
      "Clarify my request",
      undefined,
      context,
    );
    expect(received.job).toBeUndefined();
    expect(observed?.history).toEqual(
      context.map((item) => ({ role: item.role, content: item.text })),
    );
    expect(
      JSON.stringify(f.store.query("SELECT * FROM entities")),
    ).not.toContain(context[0]!.text);
    expect(JSON.stringify(f.store.query("SELECT * FROM events"))).not.toContain(
      context[0]!.text,
    );
    expect(
      (
        await f.frontend.receive(
          f.binding,
          source,
          "Clarify my request",
          undefined,
          context,
        )
      ).duplicate,
    ).toBe(true);
    await expect(
      f.frontend.receive(f.binding, source, "Clarify my request", undefined, [
        { role: "user", text: "Changed context" },
      ]),
    ).rejects.toThrow("content changed");
    expect(f.broker.list(f.binding)).toHaveLength(0);
    f.store.close();
  });
  it("rejects oversized or unrecognized voice context before reserving an instruction sequence", () => {
    const f = fixture(),
      source = { channel: "voice" as const, eventId: "invalid-context" };
    const invalid = [
      Array.from({ length: 9 }, () => ({ role: "user" as const, text: "one" })),
      [{ role: "user" as const, text: "x".repeat(3001) }],
      [
        { role: "user" as const, text: "x".repeat(1501) },
        { role: "assistant" as const, text: "x".repeat(1500) },
      ],
      [{ role: "system" as "user", text: "Synthetic untrusted instructions" }],
    ];
    for (const context of invalid)
      expect(() =>
        f.frontend.receive(f.binding, source, "status", undefined, context),
      ).toThrow();
    expect(f.broker.currentSequence(f.binding)).toBe(0);
    expect(f.broker.list(f.binding)).toHaveLength(0);
    f.store.close();
  });
});

describe("text control grant requests", () => {
  it("a literal stop revokes a grant request that still waits for the owner on the Mac", async () => {
    const f = fixture();
    let local: { state: string; grant?: TextControlGrant } = {
      state: "pending",
    };
    const proposed: TextControlGrant[] = [];
    const textDevice = {
      proposeGrant: async (grant: TextControlGrant) => {
        proposed.push(grant);
      },
      grantStatus: async () => local,
      acquire: async () => {},
      observe: async () => {
        throw new Error("No screen in this test.");
      },
      input: async () => ({ submitted: false }),
      release: async () => {},
    };
    const control = new ControlCoordinator(f.store, new SimulatedDevice());
    const app = createApp(
      f.service,
      control,
      new HumanRouter(f.service, control),
      {
        origin: "http://127.0.0.1:3310",
        simulation: true,
        conversation: f.frontend,
        textDevice,
      },
    );
    const headers = {
      authorization: `Bearer ${f.agent.token}`,
      "content-type": "application/json",
    };
    const asked = await app.request("/api/control-grants", {
      method: "POST",
      headers,
      body: JSON.stringify({
        grantId: "grant-one",
        actions: ["click"],
        durationSeconds: 60,
        policyRevision: 1,
        localEnableGeneration: 1,
      }),
    });
    expect(asked.status).toBe(200);
    expect(proposed).toHaveLength(1);
    const stopped = await app.request("/api/conversation/turn", {
      method: "POST",
      headers,
      body: JSON.stringify({ eventId: "stop-one", text: "stop" }),
    });
    expect(stopped.status).toBe(200);
    // The owner approves on the Mac after the stop.
    local = { state: "active", grant: proposed[0] };
    const status = await app.request("/api/control-grants/grant-one", {
      headers,
    });
    expect(status.status).toBe(409);
    expect(
      f.store.get<TextControlGrant>("text_control_grant", "grant-one")?.state,
    ).toBe("revoked");
    f.store.close();
  });
});
