import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { ClawdTime } from "../src/attention/service.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { SetupService } from "../src/pairing/setup.js";
import { Viewing } from "../src/control/viewing.js";
import { ScriptedConversationAgent } from "./backend-conversation-fixture.js";
import type { ConversationTurn } from "../src/control/conversation.js";
import { HumanRouter } from "../src/control/human-router.js";
import type {
  ActionReceipt,
  ControlLease,
  Frame,
  InputAction,
} from "../src/contracts.js";
const operator = "operator-secret-for-disposable-test-only";
const media = "media-secret-for-disposable-test-only";
const binding = {
  memberId: "tester",
  recipient: "+15550000001",
  conversationId: "iMessage;-;+15550000001",
  lineId: "line",
  deviceId: "mac",
  displayId: "1",
};
const registration = {
  adapter: "codex",
  adapterVersion: "fixture",
  projectRoot: "/disposable-project",
  externalSessionId: "agent-run-1",
  hostId: "mac",
  capabilities: { cooperativePause: true, polling: true },
};
function harness(
  store = new Store(),
  device = new SimulatedDevice(),
  script?: (turn: ConversationTurn) => Promise<{ reply: string }>,
) {
  const transport = new SimulationTransport(),
    service = new ClawdTime(store, transport),
    control = new ControlCoordinator(store, device),
    human = new HumanRouter(
      service,
      control,
      new ScriptedConversationAgent(device, script, {
        plan: async (_task, lease) => ({
          action: { kind: "click", x: 0.5, y: 0.5 },
          frame: await control.frame(lease.id, lease.memberId),
        }),
      }),
    );
  const app = createApp(service, control, human, {
    origin: "http://127.0.0.1:3310",
    operatorToken: operator,
    mediaToken: media,
    simulation: true,
  });
  async function send(path: string, token?: string, body?: unknown) {
    const response = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await response.json()) as Record<string, any>;
    return { status: response.status, body: json };
  }
  async function connect(externalSessionId = "agent-run-1") {
    const invite = await send("/internal/pairing", operator, binding);
    expect(invite.status).toBe(200);
    const pair = await send("/api/pairing/claim", undefined, {
      token: invite.body.token,
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl: true,
    });
    expect(pair.status).toBe(200);
    const session = await send("/api/sessions", pair.body.token, {
      ...registration,
      externalSessionId,
    });
    expect(session.status).toBe(200);
    return {
      pairToken: pair.body.token,
      token: session.body.token,
      session: session.body.session,
      pairing: pair.body.pairing,
    };
  }
  async function attention(token: string) {
    expect((await send("/api/sessions/yield", token, {})).status).toBe(200);
    const created = await send("/api/attention", token, {
      taskId: "task",
      idempotencyKey: "once",
      reason: "decision",
      question: "Which color?",
    });
    expect(created.status).toBe(202);
    await send("/internal/drain", operator, {});
    expect(
      (
        await send("/internal/simulation/call", operator, {
          requestId: created.body.request.id,
          state: "connected",
          qualified: true,
        })
      ).status,
    ).toBe(200);
    return created.body.request as { id: string };
  }
  const feedback = (requestId: string, eventId: string, text: string) =>
    send("/internal/simulation/human", operator, {
      ...{
        memberId: binding.memberId,
        lineId: binding.lineId,
        conversationId: binding.conversationId,
      },
      requestId,
      eventId,
      channel: "text",
      text,
    });
  return {
    store,
    transport,
    service,
    control,
    human,
    device,
    app,
    send,
    connect,
    attention,
    feedback,
  };
}
describe("HTTP-to-domain-to-device-to-result acceptance (simulated)", () => {
  it("rejects aged new speech without ending the call and reconciles an exact accepted segment without replay", async () => {
    let turns = 0;
    const h = harness(undefined, undefined, async () => {
        turns++;
        return { reply: "Ready." };
      }),
      a = await h.connect(),
      r = await h.attention(a.token);
    const id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
    const speech = {
      id: "1",
      text: "Look at the page.",
      at: new Date().toISOString(),
      source: "remote_participant",
      callId: id,
      participantIdentity: `worker-${id}`,
    };
    const path = `/media/${id}/segments`;
    expect((await h.send(path, media, speech)).status).toBe(200);
    const receipt = h.store.state(`human-command:voice:${id}:1`);
    const old = { ...speech, at: new Date(Date.now() - 27_000).toISOString() };
    const replay = await h.send(path, media, old);
    expect(replay.status).toBe(200);
    expect(replay.body.accepted).toBe(true);
    expect(turns).toBe(1);
    expect(h.store.state(`human-command:voice:${id}:1`)).toEqual(receipt);
    const changed = await h.send(path, media, {
      ...old,
      text: "Different instruction.",
    });
    expect(changed.status).toBe(409);
    expect(changed.body.errorCode).toBe("segment_conflict");
    const stale = await h.send(path, media, { ...old, id: "2" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      errorCode: "stale_speech",
      captured: false,
    });
    expect(h.store.state(`human-command:voice:${id}:2`)).toBeUndefined();
    expect(h.store.get<any>("call", id).state).toBe("connected");
    expect(h.store.effects().filter((e) => e.kind === "end_call")).toHaveLength(
      0,
    );
    expect(
      (
        await h.send(path, media, {
          ...speech,
          id: "3",
          at: new Date().toISOString(),
        })
      ).status,
    ).toBe(200);
    expect(turns).toBe(2);
    expect(h.store.all("action")).toHaveLength(0);
    h.store.close();
  });

  it.each(["unqualified", "ended", "revoked"])(
    "rejects aged receipt reconciliation when current authority is %s",
    async (loss) => {
      let turns = 0;
      const h = harness(undefined, undefined, async () => {
        turns++;
        return { reply: "Ready." };
      });
      const a = await h.connect(),
        r = await h.attention(a.token),
        id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
      const speech = {
        id: "1",
        text: "Look at the page.",
        at: new Date().toISOString(),
        source: "remote_participant",
        callId: id,
        participantIdentity: `worker-${id}`,
      };
      const path = `/media/${id}/segments`;
      expect((await h.send(path, media, speech)).status).toBe(200);
      const receipt = h.store.state(`human-command:voice:${id}:1`);
      if (loss === "revoked")
        h.store.put("pairing", { ...a.pairing, revokedAt: Date.now() });
      else {
        const call = h.store.get<any>("call", id);
        h.store.put("call", {
          ...call,
          ...(loss === "ended"
            ? { state: "ended" }
            : { remoteParticipantQualified: false }),
        });
      }
      const retry = await h.send(path, media, {
        ...speech,
        at: new Date(Date.now() - 27_000).toISOString(),
      });
      expect(retry.status).toBeGreaterThanOrEqual(400);
      expect(turns).toBe(1);
      expect(h.store.state(`human-command:voice:${id}:1`)).toEqual(receipt);
      expect(h.store.all("action")).toHaveLength(0);
      h.store.close();
    },
  );

  it("reconciles a slow in-flight segment as unknown without repeating its model turn", async () => {
    let finish!: () => void,
      started!: () => void,
      turns = 0;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = harness(undefined, undefined, async () => {
      turns++;
      started();
      await pending;
      return { reply: "Done." };
    });
    const a = await h.connect(),
      r = await h.attention(a.token),
      id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
    const speech = {
      id: "1",
      text: "Look at the page.",
      at: new Date().toISOString(),
      source: "remote_participant",
      callId: id,
      participantIdentity: `worker-${id}`,
    };
    const first = h.send(`/media/${id}/segments`, media, speech);
    await ready;
    try {
      const retry = await h.send(`/media/${id}/segments`, media, {
        ...speech,
        at: new Date(Date.now() - 27_000).toISOString(),
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ accepted: false, state: "unknown" });
      expect(turns).toBe(1);
      expect(
        h.store.effects().filter((e) => e.kind === "end_call"),
      ).toHaveLength(0);
    } finally {
      finish();
      await first;
      h.store.close();
    }
  });

  it("retains the first authenticated media failure before cleanup without persisting arbitrary content", async () => {
    const h = harness(),
      a = await h.connect(),
      r = await h.attention(a.token);
    const id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
    const failure = {
      reason: "room_disconnected",
      category: "room_event",
      at: new Date().toISOString(),
      elapsedMs: 59000,
    };
    expect(
      (await h.send(`/media/${id}/failure`, "wrong", failure)).status,
    ).toBe(401);
    expect(h.store.state(`media-failure:${r.id}`)).toBeUndefined();
    expect(
      (
        await h.send(`/media/${id}/failure`, media, {
          ...failure,
          error: "PRIVATE_EXCEPTION",
          transcript: "PRIVATE_TEXT",
        })
      ).status,
    ).toBe(200);
    const first = h.store.state<any>(`media-failure:${r.id}`);
    expect(first).toEqual({ ...failure, receivedAt: expect.any(Number) });
    const termination = h.store.state<any>(`call-termination:${r.id}`);
    expect(termination).toMatchObject({
      source: "media_failure",
      effectId: `${r.id}:end`,
    });
    await h.service.drain();
    expect(
      (
        await h.send(`/media/${id}/failure`, media, {
          ...failure,
          reason: "task_failed",
          category: "failure_cleanup",
        })
      ).status,
    ).toBe(200);
    expect(h.store.state(`media-failure:${r.id}`)).toEqual(first);
    expect(h.store.state(`call-termination:${r.id}`)).toEqual(termination);
    expect(h.store.effects().filter((e) => e.kind === "end_call")).toHaveLength(
      1,
    );
    const diagnostic = await h.send(
      `/api/attention/${r.id}/diagnostics`,
      a.token,
    );
    expect(diagnostic.body.mediaFailure).toEqual(first);
    expect(diagnostic.body.callTermination).toEqual(termination);
    expect(JSON.stringify(diagnostic.body)).not.toContain("PRIVATE_");
    expect(h.transport.messages).toHaveLength(0);
    h.store.close();
  });

  it.each([
    {},
    {
      reason: "PRIVATE_REASON",
      category: "PRIVATE_TASK",
      at: "PRIVATE_TIME",
      elapsedMs: 1,
    },
    {
      reason: "task_failed",
      category: "capture_loop",
      at: new Date().toISOString(),
      elapsedMs: -1,
    },
  ])(
    "keeps legacy or malformed failure metadata from blocking cleanup %#",
    async (payload) => {
      const h = harness(),
        a = await h.connect(),
        r = await h.attention(a.token);
      const id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
      expect(
        (await h.send(`/media/${id}/failure`, media, payload)).status,
      ).toBe(200);
      expect(h.store.state(`media-failure:${r.id}`)).toEqual({
        reason: "unspecified",
        category: "unspecified",
        receivedAt: expect.any(Number),
      });
      expect(
        h.store.effects().filter((e) => e.kind === "end_call"),
      ).toHaveLength(1);
      await h.service.drain();
      expect(h.service.status(a.token, r.id).state).toBe("failed");
      h.store.close();
    },
  );

  it("scopes read-only diagnostics and acknowledges a canceled call's confirmed cleanup without inventing approval", async () => {
    const h = harness(),
      a = await h.connect(),
      r = await h.attention(a.token);
    const other = await h.send("/api/sessions", a.pairToken, {
      ...registration,
      externalSessionId: "foreign-diagnostics",
    });
    expect(
      (await h.send(`/api/attention/${r.id}/diagnostics`, other.body.token))
        .status,
    ).toBe(404);
    const before = h.store.effects().length;
    const diagnostic = await h.send(
      `/api/attention/${r.id}/diagnostics`,
      a.token,
    );
    expect(diagnostic.status).toBe(200);
    expect(diagnostic.body.media.state).toBe("simulation");
    expect(h.store.effects()).toHaveLength(before);
    h.service.failCall(r.id);
    h.store.put("attention", {
      ...h.service.status(a.token, r.id),
      state: "canceled",
    });
    expect(
      (
        await h.send(`/api/attention/${r.id}/terminal-ack`, a.token, {
          controlEpoch: 0,
        })
      ).status,
    ).toBe(409);
    await h.service.drain();
    const cleanup = await h.send(
      `/api/attention/${r.id}/terminal-ack`,
      a.token,
      { controlEpoch: 0 },
    );
    expect(cleanup.status).toBe(200);
    expect(cleanup.body.session.id).toBe(a.session.id);
    expect(cleanup.body.session.state).toBe("active");
    expect(cleanup.body.acknowledgement.humanApproval).toBe(false);
    expect(cleanup.body.request.state).toBe("canceled");
    expect(h.transport.messages).toHaveLength(0);
    h.store.close();
  });

  it("keeps the approved setup test bound to one HTTP session through screen, feedback and result without claiming physical verification", async () => {
    const h = harness(),
      a = await h.connect();
    const setup = new SetupService(h.service);
    expect((await h.app.request("/agents")).status).toBe(200);
    expect((await h.app.request("/setup")).status).toBe(200);
    expect((await h.send("/api/setup/test", undefined)).status).toBe(401);
    expect(
      (await h.send("/api/setup/test", a.token, { extra: true })).status,
    ).toBe(400);
    const invitation = await h.send("/api/setup/test", a.token, {});
    expect(invitation.status).toBe(200);
    await h.service.drain();
    expect(h.transport.messages).toHaveLength(1);
    expect((await h.send("/api/setup/test/start", a.token, {})).status).toBe(
      409,
    );
    expect(
      (
        await h.send("/api/setup/test/authorize", a.token, {
          testId: invitation.body.test.id,
          userAuthorizedCall: true,
        })
      ).status,
    ).toBe(200);
    await h.send("/api/sessions/yield", a.token, {});
    const started = await h.send("/api/setup/test/start", a.token, {});
    expect(started.status).toBe(200);
    const requestId = started.body.request.id;
    await h.service.drain();
    h.service.observeCall(requestId, "connected", true);
    const viewing = new Viewing(h.store, h.device);
    await viewing.tick();
    expect(h.store.state(`setup-view:${requestId}`)).toBeDefined();
    const answer = await h.feedback(
      requestId,
      "screen-confirmation",
      "answer: I can see my screen",
    );
    await viewing.tick();
    await h.send(`/api/attention/${requestId}/ack`, a.token, {
      responseId: answer.body.response.id,
    });
    const state = await h.send(`/api/attention/${requestId}/result`, a.token);
    expect(state.body.session.id).toBe(a.session.id);
    expect(
      (
        await h.send(`/api/attention/${requestId}/resume`, a.token, {
          controlEpoch: state.body.session.controlEpoch,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.send(`/api/attention/${requestId}/complete`, a.token, {
          text: "Same session continued; simulated result.",
        })
      ).status,
    ).toBe(200);
    await h.service.drain();
    expect(h.transport.messages).toHaveLength(2);
    expect(h.transport.calls).toHaveLength(1);
    expect((await h.send("/api/setup/test/verify", a.token, {})).status).toBe(
      409,
    );
    expect((await h.send("/api/setup/test", a.token)).body.test.state).toBe(
      "call_requested",
    );
    h.store.close();
  });

  it("pairs, binds agent, rings once, performs click/type/scroll/single AI action, returns exact response and sends one result", async () => {
    const h = harness(),
      agent = await h.connect(),
      r = await h.attention(agent.token);
    expect(h.transport.calls).toHaveLength(1);
    for (const [index, text] of [
      "click 0.5 0.5",
      "type: Hello fixture",
      "scroll 100 at 0.5 0.5",
      "do: select the center button",
    ].entries()) {
      const response = await h.feedback(r.id, `input-event-${index}`, text);
      expect(response.status).toBe(200);
      expect(response.body.receipt.state).toBe("observed");
      const duplicate = await h.feedback(r.id, `input-event-${index}`, text);
      expect(duplicate.body.receipt.id).toBe(response.body.receipt.id);
    }
    expect(h.device.inputs).toHaveLength(4);
    const answer = await h.feedback(r.id, "answer-event", "answer: Use blue.");
    expect(answer.status).toBe(200);
    const result = await h.send(`/api/attention/${r.id}/result`, agent.token);
    expect(result.body.response.text).toBe("answer: Use blue.");
    expect(result.body.actions).toHaveLength(4);
    expect(result.body.session.controlEpoch).toBe(4);
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 4,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await h.send(`/api/attention/${r.id}/ack`, agent.token, {
          responseId: result.body.response.id,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 0,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 4,
        })
      ).status,
    ).toBe(200);
    const complete = { text: "Changed the demo color to blue." };
    expect(
      (await h.send(`/api/attention/${r.id}/complete`, agent.token, complete))
        .status,
    ).toBe(200);
    await h.send("/internal/drain", operator, {});
    await h.send(`/api/attention/${r.id}/complete`, agent.token, complete);
    await h.send("/internal/drain", operator, {});
    expect(h.transport.messages).toHaveLength(1);
    expect(h.transport.messages[0]?.pairingId).toBe(agent.pairing.id);
    expect(h.transport.ended).toHaveLength(1);
    expect(
      (await h.send(`/api/attention/${r.id}`, agent.token)).body.request.state,
    ).toBe("completed");
  });
  it("rejects missing auth, wrong origin, another session and reused pairing link", async () => {
    const h = harness();
    expect((await h.send("/internal/pairing", undefined, binding)).status).toBe(
      401,
    );
    const agent = await h.connect(),
      r = await h.attention(agent.token);
    const other = await h.send("/api/sessions", agent.pairToken, {
      ...registration,
      externalSessionId: "other-run",
    });
    expect(
      (await h.send(`/api/attention/${r.id}/result`, other.body.token)).status,
    ).toBe(404);
    const foreign = await h.app.request("/api/sessions/yield", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agent.token}`,
        origin: "https://evil.example",
      },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const invite = await h.send("/internal/pairing", operator, binding);
    const claim = {
      token: invite.body.token,
      deviceId: "mac",
      displayId: "1",
      allowView: true,
      allowControl: true,
    };
    expect((await h.send("/api/pairing/claim", undefined, claim)).status).toBe(
      200,
    );
    expect((await h.send("/api/pairing/claim", undefined, claim)).status).toBe(
      410,
    );
  });
  it("deduplicates committed input after process restart and never replays an uncertain input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clawdtime-e2e-"));
    try {
      const path = join(dir, "state.sqlite"),
        h = harness(new Store(path)),
        agent = await h.connect(),
        r = await h.attention(agent.token);
      const result = await h.feedback(r.id, "stable-input", "type: once");
      expect(result.status).toBe(200);
      h.store.close();
      const next = harness(new Store(path));
      const replay = await next.feedback(r.id, "stable-input", "type: once");
      expect(replay.body.receipt.id).toBe(result.body.receipt.id);
      expect(next.device.inputs).toHaveLength(0);
      next.device.action = async () => {
        throw new Error("Input committed but response lost");
      };
      expect(
        (await next.feedback(r.id, "uncertain-input", "type: uncertain")).body
          .state,
      ).toBe("unknown");
      const uncertain = next.store
        .all<ActionReceipt>("action")
        .find((a) => a.state === "unknown");
      expect(uncertain).toBeDefined();
      const again = await next.feedback(
        r.id,
        "uncertain-input",
        "type: uncertain",
      );
      expect(again.body.state).toBe("unknown");
      const answer = await next.feedback(r.id, "answer", "answer: continue");
      expect(answer.body.response).toBeUndefined();
      expect(answer.body.state).toBe("unknown");
      const state = await next.send(
        `/api/attention/${r.id}/result`,
        agent.token,
      );
      expect(
        (
          await next.send(`/api/attention/${r.id}/resume`, agent.token, {
            controlEpoch: state.body.session.controlEpoch,
          })
        ).status,
      ).toBe(409);
      next.store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("disconnect invalidates sessions, stops control and denies future media policy", async () => {
    const h = harness(),
      agent = await h.connect(),
      r = await h.attention(agent.token);
    const lease = await h.control.acquire(r.id, binding.memberId);
    expect(h.device.leases.has(lease.id)).toBe(true);
    expect((await h.send("/api/disconnect", agent.token, {})).status).toBe(200);
    expect(h.device.leases.size).toBe(0);
    expect(
      (await h.send(`/api/attention/${r.id}/result`, agent.token)).status,
    ).toBe(403);
    const id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
    const policy = await h.send(`/media/${id}/policy`, media);
    expect(policy.body.state).toBe("ended");
    expect(policy.body.screenSelection).toBeUndefined();
  });
  it("accepts natural voice without a wake word and rejects stale, TTS or foreign audio", async () => {
    const h = harness(undefined, undefined, async (turn) => {
        await turn.tools.feedback({ kind: "answer" });
        return { reply: "I will pass that on." };
      }),
      agent = await h.connect(),
      r = await h.attention(agent.token),
      id = `ct_${createHash("sha256").update(r.id).digest("hex").slice(0, 40)}`;
    const speech = {
      id: "speech-1",
      text: "Use blue.",
      at: new Date().toISOString(),
      source: "remote_participant",
      callId: id,
      participantIdentity: `worker-${id}`,
    };
    const foreign = await h.send(`/media/${id}/segments`, media, {
      ...speech,
      participantIdentity: "other",
    });
    expect(foreign.status).toBe(403);
    expect(
      (
        await h.send(`/media/${id}/segments`, media, {
          ...speech,
          text: "Use blue.",
          source: "agent_tts",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.send(`/media/${id}/segments`, media, {
          ...speech,
          text: "Use blue.",
          at: "2000-01-01T00:00:00Z",
        })
      ).status,
    ).toBe(409);
    expect(
      (await h.send(`/api/attention/${r.id}/result`, agent.token)).body
        .response,
    ).toBeUndefined();
    const response = await h.send(`/media/${id}/segments`, media, {
      ...speech,
      text: "Use blue.",
    });
    expect(response.status).toBe(200);
    expect(
      (await h.send(`/api/attention/${r.id}/result`, agent.token)).body.response
        .text,
    ).toBe("Use blue.");
  });
  it("lost helper release blocks agent continuation until release is confirmed", async () => {
    const h = harness(),
      agent = await h.connect(),
      r = await h.attention(agent.token),
      lease = await h.control.acquire(r.id, binding.memberId);
    h.device.release = async () => {
      throw new Error("Gateway disconnected");
    };
    await expect(h.control.release(lease.id)).rejects.toThrow("disconnected");
    expect(h.store.get<ControlLease>("lease", lease.id)?.state).toBe("unknown");
    const a = await h.feedback(r.id, "answer", "answer: proceed");
    expect(a.body.response).toBeUndefined();
    expect(a.body.state).toBe("unknown");
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 1,
        })
      ).status,
    ).toBe(409);
    h.device.release = async () => {};
    await h.control.release(lease.id);
    const freshAnswer = await h.feedback(
      r.id,
      "answer-after-cleanup",
      "answer: proceed",
    );
    await h.send(`/api/attention/${r.id}/ack`, agent.token, {
      responseId: freshAnswer.body.response.id,
    });
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 1,
        })
      ).status,
    ).toBe(200);
  });
});
