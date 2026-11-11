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
function harness(store = new Store(), device = new SimulatedDevice()) {
  const transport = new SimulationTransport(),
    service = new ClawdTime(store, transport),
    control = new ControlCoordinator(store, device),
    human = new HumanRouter(service, control, {
      plan: async (_task, lease) => ({
        action: { kind: "click", x: 0.5, y: 0.5 },
        frame: await control.frame(lease.id, lease.memberId),
      }),
    });
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
    expect(result.body.response.text).toBe("Use blue.");
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
        (await next.feedback(r.id, "uncertain-input", "type: uncertain"))
          .status,
      ).toBe(409);
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
      await next.send(`/api/attention/${r.id}/ack`, agent.token, {
        responseId: answer.body.response.id,
      });
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
  it("drops incidental, stale or foreign audio before feedback can reach the agent", async () => {
    const h = harness(),
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
    const incidental = await h.send(`/media/${id}/segments`, media, speech);
    expect(incidental.body.captured).toBe(false);
    expect(
      (
        await h.send(`/media/${id}/segments`, media, {
          ...speech,
          text: "ClawdTime, answer: blue",
          source: "agent_tts",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.send(`/media/${id}/segments`, media, {
          ...speech,
          text: "ClawdTime, answer: blue",
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
      text: "ClawdTime, answer: blue",
    });
    expect(response.status).toBe(200);
    expect(
      (await h.send(`/api/attention/${r.id}/result`, agent.token)).body.response
        .text,
    ).toBe("blue");
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
    await h.send(`/api/attention/${r.id}/ack`, agent.token, {
      responseId: a.body.response.id,
    });
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 1,
        })
      ).status,
    ).toBe(409);
    h.device.release = async () => {};
    await h.control.release(lease.id);
    expect(
      (
        await h.send(`/api/attention/${r.id}/resume`, agent.token, {
          controlEpoch: 1,
        })
      ).status,
    ).toBe(200);
  });
});
