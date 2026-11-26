import { PanelSynchronizer } from "../src/control/panel.js";
import { mediaSessionId } from "../media/device-port.js";
import { describe, it, expect } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { ExecutionCoordinator } from "../src/control/execution.js";
import { Interruptions } from "../src/control/interruptions.js";
import { ControlTiming } from "../src/control/timing.js";
import { readFileSync } from "node:fs";
import { HumanRouter } from "../src/control/human-router.js";
import { Viewing } from "../src/control/viewing.js";
import { createApp } from "../src/app.js";
import type { ComputerControlPolicy, ControlLease } from "../src/contracts.js";

class Device extends SimulatedDevice {
  policy: ComputerControlPolicy = "agent_tools_only";
  revision = 1;
  controlAllowed = true;
  armed = true;
  presentationVersion: number | undefined;
  panelCommand: unknown;
  panels: Record<string, unknown>[] = [];
  async panel(_id: string, payload: Record<string, unknown>) {
    this.panels.push(payload);
  }
  async readiness() {
    return {
      presentationVersion: this.presentationVersion,
      controlAllowed: this.controlAllowed,
      armed: this.armed,
      available: true,
      screenPermission: true,
      viewAllowed: true,
      displayAttached: true,
      activeLease: this.leases.size > 0,
      activeLeaseId: this.leases.keys().next().value,
      controlPolicy: this.policy,
      policyRevision: this.revision,
      panelCommand: this.panelCommand,
    };
  }
}
async function fixture(native = true, interaction = false) {
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport()),
    device = new Device(),
    control = new ControlCoordinator(store, device),
    human = new HumanRouter(service, control),
    viewing = new Viewing(store, device);
  const p = service.claimPairing({
    token: service.createPairingInvite({
      memberId: "fixture",
      recipient: "fixture",
      conversationId: "fixture",
      lineId: "fixture",
      deviceId: "fixture",
      displayId: "1",
    }).token,
    deviceId: "fixture",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const s = service.registerSession(p.token, {
    protocolVersion: 2,
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "fixture",
    hostId: "fixture",
    ...(interaction
      ? {
          interaction: {
            version: 1 as const,
            commandChannel: "imessage_first" as const,
            messageUpdates: true,
          },
        }
      : {}),
    capabilities: {
      cooperativePause: true,
      polling: true,
      nativeControl: native ? "browser" : "none",
      sharedSurface: native,
      ...(interaction ? { voiceInteractionVersion: 1 as const } : {}),
    },
  });
  const app = createApp(service, control, human, {
    origin: "http://127.0.0.1",
    simulation: true,
    mediaToken: "m".repeat(64),
    twoWayVoiceEnabled: interaction,
    remoteAudioIsolated: interaction,
  });
  const execution = new ExecutionCoordinator(service, control);
  const r = service.requestAttention(s.token, {
    taskId: "fixture",
    idempotencyKey: "fixture",
    reason: "review",
    question: "fixture",
  });
  await service.drain();
  service.observeCall(r.id, "connected", true);
  await viewing.tick();
  const send = (eventId: string, text: string) =>
    human.receive({
      eventId,
      text,
      requestId: r.id,
      memberId: "fixture",
      lineId: "fixture",
      conversationId: "fixture",
      channel: "text",
    });
  const transition = (
    epoch: number,
    executor: "native" | "none" | "clawdtime",
    previousOutcome: "idle" | "completed" | "uncertain" = "idle",
  ) =>
    execution.transition(s.token, r.id, {
      expectedEpoch: epoch,
      executor,
      previousOutcome,
      backgroundActorsStopped: true,
    });
  const api = (suffix: string, body?: unknown) =>
    app.request(`/api/attention/${r.id}/conversation/${suffix}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${s.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    store,
    service,
    device,
    control,
    human,
    viewing,
    execution,
    r,
    s,
    send,
    transition,
    api,
    app,
  };
}
describe("interaction input and timing boundaries", () => {
  it("emits the same negotiated voice policy consumed by Python and retains legacy half duplex", async () => {
    const fixturePolicy = JSON.parse(
      readFileSync(
        new URL("./fixtures/voice-policy.json", import.meta.url),
        "utf8",
      ),
    );
    for (const opted of [false, true]) {
      const h = await fixture(true, opted);
      for (let n = 0; n < 3; n++)
        await h.send(`turn_${n}`, "Synthetic instruction.");
      const response = await h.app.request(
        `/media/${mediaSessionId(h.r.id)}/policy`,
        { headers: { authorization: `Bearer ${"m".repeat(64)}` } },
      );
      const policy = await response.json();
      const expected = { ...fixturePolicy };
      if (!opted) delete expected.voiceInteractionVersion;
      expect(policy).toMatchObject({
        ...expected,
        callId: h.service.status(h.s.token, h.r.id).callId,
        expiresAt: policy.expiresAt,
        voiceMode: opted ? "two_way" : "half_duplex",
        remoteAudioIsolated: opted,
      });
      if (!opted) expect(policy).not.toHaveProperty("voiceInteractionVersion");
      h.store.close();
    }
  });
  it("blocks stale and unread text at ownership acquisition, then permits the current acknowledged cursor", async () => {
    const h = await fixture(true, true);
    await h.send("first", "Choose the first fixture.");
    const body = {
      expectedEpoch: 0,
      executor: "native",
      previousOutcome: "idle",
      backgroundActorsStopped: true,
      expectedCursor: 1,
    };
    expect((await h.api("execution", body)).status).toBe(409);
    const poll = await (await h.api("turns")).json();
    expect((await h.api("ack", { turnId: poll.turns[0].id })).status).toBe(200);
    await h.send("correction", "Choose the second fixture.");
    expect((await h.api("execution", body)).status).toBe(409);
    const next = await (await h.api("turns")).json();
    await h.api("ack", { turnId: next.turns[1].id });
    expect(
      (await h.api("execution", { ...body, expectedCursor: 2 })).status,
    ).toBe(200);
    expect(h.device.inputs).toEqual([]);
    h.store.close();
  });
  it("rechecks a correction that arrives during asynchronous local preflight", async () => {
    const h = await fixture(true, true);
    const original = h.device.readiness.bind(h.device);
    let inject = true;
    h.device.readiness = async () => {
      if (inject) {
        inject = false;
        await h.send("during", "Wait for my correction.");
      }
      return original();
    };
    expect(
      (
        await h.api("execution", {
          expectedEpoch: 0,
          executor: "native",
          previousOutcome: "idle",
          backgroundActorsStopped: true,
          expectedCursor: 0,
        })
      ).status,
    ).toBe(409);
    expect((await (await h.api("execution")).json()).executor).toBe("none");
    h.store.close();
  });
  it("keeps a confirmed grant recoverable when a correction arrives during synchronization", async () => {
    const h = await fixture(true, true);
    const create = h.device.createLease.bind(h.device);
    let inject = true;
    h.device.createLease = async (lease) => {
      await create(lease);
      if (inject) {
        inject = false;
        await h.send("during_grant", "Wait for my correction.");
      }
    };
    expect(
      (
        await h.api("execution", {
          expectedEpoch: 0,
          executor: "native",
          previousOutcome: "idle",
          backgroundActorsStopped: true,
          expectedCursor: 0,
        })
      ).status,
    ).toBe(409);
    const ownership = await (await h.api("execution")).json();
    expect(ownership).toMatchObject({
      executor: "native",
      epoch: 1,
      state: "working",
    });
    expect(
      (
        await h.api("execution", {
          expectedEpoch: 1,
          executor: "none",
          previousOutcome: "completed",
          backgroundActorsStopped: true,
        })
      ).status,
    ).toBe(200);
    expect(h.device.inputs).toEqual([]);
    h.store.close();
  });
  it("accepts only qualified fresh interruptions and exposes the hold without generating a command", async () => {
    const h = await fixture(true, true);
    const sid = mediaSessionId(h.r.id),
      call = h.service.status(h.s.token, h.r.id).callId!;
    const payload = {
      callId: call,
      participantIdentity: `worker-${sid}`,
      interruptionId: "interrupt_1",
      playbackGeneration: 1,
      at: new Date().toISOString(),
    };
    const post = (body: unknown, token = "m".repeat(64)) =>
      h.app.request(`/media/${sid}/interrupt`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await post(payload, "wrong")).status).toBe(401);
    expect(
      (await post({ ...payload, participantIdentity: "wrong" })).status,
    ).toBe(403);
    expect(
      (
        await post({
          ...payload,
          at: new Date(Date.now() - 5000).toISOString(),
        })
      ).status,
    ).toBe(409);
    const receipt = await (await post(payload)).json();
    expect(await (await post(payload)).json()).toEqual(receipt);
    const state = await (await h.api("execution")).json();
    expect(state.hold.active).toBe(true);
    expect((await (await h.api("turns")).json()).turns).toEqual([]);
    expect(
      (
        await h.api("execution", {
          expectedEpoch: 0,
          executor: "native",
          previousOutcome: "idle",
          backgroundActorsStopped: true,
          expectedCursor: 0,
        })
      ).status,
    ).toBe(409);
    h.store.saveState(`muted:${h.r.id}`, true);
    expect((await post({ ...payload, interruptionId: "muted" })).status).toBe(
      403,
    );
    h.store.close();
  });
  it("expires candidate holds without extending them on replay or changing execution ownership", () => {
    const store = new Store();
    let now = 100_000;
    const service = new ClawdTime(store, new SimulationTransport(), {
      clock: () => now,
    });
    const interruptions = new Interruptions(service);
    const input = {
      callId: "call",
      participantIdentity: "worker",
      interruptionId: "once",
      playbackGeneration: 1,
      at: new Date(now).toISOString(),
    };
    const before = interruptions.accept("request", input);
    now += 2500;
    expect(interruptions.accept("request", input)).toEqual(before);
    expect(interruptions.status("request").active).toBe(false);
    expect(() =>
      interruptions.accept("request", { ...input, interruptionId: "stale" }),
    ).toThrow("stale");
    expect(store.all("execution")).toEqual([]);
    store.close();
  });
  it("captures one validated image instead of two and records observation timing", async () => {
    const h = await fixture();
    h.device.policy = "agent_tools_with_fallback";
    await h.transition(0, "clawdtime");
    let plain = 0,
      images = 0;
    const frame = h.device.frame.bind(h.device);
    h.device.frame = async (lease) => {
      plain++;
      return frame(lease);
    };
    Object.assign(h.device, {
      frameImage: async (lease: ControlLease) => {
        images++;
        return {
          frame: await frame(lease),
          dataUrl: "data:image/jpeg;base64,fixture",
        };
      },
    });
    const observed = await h.execution.observe(h.s.token, h.r.id, 1);
    expect(observed.frame.id).toBeTruthy();
    expect([plain, images]).toEqual([0, 1]);
    expect(
      h.control.timing.snapshot(h.r.id).events.map((e) => e.event),
    ).toContain("frame_completed");
    h.store.close();
  });
  it("bounds timing metadata and resets process scope on clock reversal", () => {
    let now = 100;
    const timing = new ControlTiming("synthetic", () => now);
    const correlation = timing.attempt("private-path-must-not-leak");
    timing.record("request", "frame_started", correlation);
    now += 23;
    timing.record("request", "frame_completed", correlation);
    const first = timing.snapshot("request");
    expect(first.events[1]!.elapsedMs - first.events[0]!.elapsedMs).toBe(23);
    expect(JSON.stringify(first)).not.toContain("private-path");
    for (let i = 0; i < 80; i++)
      timing.record("request", "frame_started", timing.attempt("request"));
    expect(timing.snapshot("request").events).toHaveLength(64);
    now = 10;
    expect(timing.snapshot("request").processId).not.toBe(first.processId);
    expect(timing.snapshot("request").events).toEqual([]);
  });
});

describe("version 2 sharing and execution", () => {
  it("delivers multiple turns to the active same session without invoking a controller or stopping sharing", async () => {
    const h = await fixture();
    expect(h.service.authenticateSession(h.s.token).state).toBe("active");
    const lease = h.store.all<ControlLease>("lease")[0]!;
    expect(lease.mode).toBe("view");
    await h.send("first", "inspect the fixture");
    await h.send("second", "correction: read its label");
    const poll = await (await h.api("turns?after=0")).json();
    expect(poll.turns.map((t: { sequence: number }) => t.sequence)).toEqual([
      1, 2,
    ]);
    expect((await h.api("ack", { turnId: poll.turns[0].id })).status).toBe(200);
    await h.viewing.tick();
    expect(h.store.get<ControlLease>("lease", lease.id)?.state).toBe("active");
    expect(h.service.status(h.s.token, h.r.id).state).toBe("awaiting_input");
    expect(h.device.inputs).toEqual([]);
    h.store.close();
  });
  it("refuses fallback by default and refuses an unverified native surface", async () => {
    const h = await fixture(false);
    await expect(h.transition(0, "clawdtime")).rejects.toThrow(
      "disabled locally",
    );
    await expect(h.transition(0, "native")).rejects.toThrow("unverified");
    expect(h.execution.status(h.s.token, h.r.id).executor).toBe("none");
    h.store.close();
  });
  it("hands off native to explicitly enabled fallback with generations while preserving the stream", async () => {
    const h = await fixture();
    const lease = h.store.all<ControlLease>("lease")[0]!;
    await h.transition(0, "native");
    await h.viewing.tick();
    expect(h.store.get<ControlLease>("lease", lease.id)?.state).toBe("active");
    await expect(h.transition(0, "none", "completed")).rejects.toThrow(
      "changed",
    );
    await expect(h.transition(1, "none")).rejects.toThrow("completion");
    h.device.policy = "agent_tools_with_fallback";
    const owner = await h.transition(1, "clawdtime", "completed");
    const observed = await h.execution.observe(h.s.token, h.r.id, owner.epoch);
    const receipt = await h.execution.act(h.s.token, h.r.id, {
      epoch: owner.epoch,
      actionId: "input1",
      frameId: observed.frame.id,
      action: { kind: "click", x: 0.2, y: 0.3 },
    });
    expect(receipt.state).toBe("observed");
    await h.transition(2, "native", "completed");
    await expect(
      h.execution.act(h.s.token, h.r.id, {
        epoch: 2,
        actionId: "input2",
        frameId: observed.frame.id,
        action: { kind: "click", x: 0.2, y: 0.3 },
      }),
    ).rejects.toThrow("ownership");
    expect(h.store.get<ControlLease>("lease", lease.id)?.mode).toBe("view");
    expect(h.device.inputs).toEqual(["input1"]);
    h.store.close();
  });
  it("blocks concurrent dispatch and handoff during input, and retains unknown outcome", async () => {
    const h = await fixture();
    h.device.policy = "agent_tools_with_fallback";
    await h.transition(0, "clawdtime");
    const observation = await h.execution.observe(h.s.token, h.r.id, 1);
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let reject!: () => void;
    h.device.action = async () => {
      entered();
      await new Promise<void>(
        (_, r) => (reject = () => r(new Error("uncertain"))),
      );
      return { submitted: true };
    };
    const action = {
      epoch: 1,
      actionId: "input",
      frameId: observation.frame.id,
      action: { kind: "click", x: 0.1, y: 0.1 },
    };
    const pending = h.execution.act(h.s.token, h.r.id, action);
    await started;
    await expect(h.transition(1, "native", "completed")).rejects.toThrow(
      "Unresolved",
    );
    await expect(
      h.execution.act(h.s.token, h.r.id, { ...action, actionId: "parallel" }),
    ).rejects.toThrow("Prior input");
    reject();
    await expect(pending).rejects.toThrow("uncertain");
    await expect(h.transition(1, "native", "completed")).rejects.toThrow(
      "Unresolved",
    );
    h.store.close();
  });
  it("honors local policy revisions and Stop without ending the conversation", async () => {
    const h = await fixture();
    h.device.policy = "agent_tools_with_fallback";
    await h.transition(0, "clawdtime");
    h.device.revision++;
    await expect(h.execution.observe(h.s.token, h.r.id, 1)).rejects.toThrow(
      "policy changed",
    );
    await h.send("stop", "stop sharing");
    expect(h.device.leases.size).toBe(0);
    expect(h.execution.status(h.s.token, h.r.id).state).toBe("uncertain");
    await h.send("after-stop", "continue explaining without input");
    expect(h.human.turns.poll(h.s.token, h.r.id).turns).toHaveLength(1);
    expect(h.service.status(h.s.token, h.r.id).state).toBe("awaiting_input");
    h.store.close();
  });
  it("preserves unknown native ownership across backend restart", async () => {
    const h = await fixture();
    await h.transition(0, "native");
    const recovered = new ExecutionCoordinator(h.service, h.control);
    expect(recovered.status(h.s.token, h.r.id).state).toBe("uncertain");
    await expect(
      recovered.transition(h.s.token, h.r.id, {
        expectedEpoch: 1,
        executor: "clawdtime",
        previousOutcome: "completed",
        backgroundActorsStopped: true,
      }),
    ).rejects.toThrow("Unresolved");
    h.store.close();
  });
  it("never dispatches a new view lease after hangup during readiness", async () => {
    const h = await fixture();
    // A fresh request has no previously granted lease; retain its exact bindings.
    for (const l of h.store.all<ControlLease>("lease"))
      h.store.put("lease", { ...l, state: "released" });
    h.device.leases.clear();
    h.store.saveState(`view-restore:${h.r.id}`, true);
    let dispatched = false;
    h.device.createLease = async () => {
      dispatched = true;
    };
    const read = h.device.readiness.bind(h.device);
    h.device.readiness = async () => {
      h.service.observeCall(h.r.id, "ended", false);
      return read();
    };
    await h.viewing.tick();
    expect(dispatched).toBe(false);
    h.store.close();
  });
  it("preserves the newer Stop generation when a handoff is awaiting helper acknowledgement", async () => {
    const h = await fixture();
    h.device.createLease = async () => {
      await h.send("stop-during-grant", "stop sharing");
    };
    await expect(h.transition(0, "native")).rejects.toThrow("uncertain");
    expect(h.execution.status(h.s.token, h.r.id).epoch).toBe(2);
    expect(
      h.store.all<ControlLease>("lease").every((l) => l.state === "released"),
    ).toBe(true);
    h.store.close();
  });

  it("scopes local panel commands, applies mute once, and reports end without stale listening", async () => {
    const h = await fixture();
    const panel = new PanelSynchronizer(h.service, h.control);
    const callId = h.service.status(h.s.token, h.r.id).callId!;
    h.device.panelCommand = {
      id: "wrong",
      sessionId: "another",
      callId,
      type: "end",
    };
    await panel.tick();
    expect(h.service.status(h.s.token, h.r.id).state).toBe("awaiting_input");
    h.device.panelCommand = {
      id: "mute",
      sessionId: h.s.session.id,
      callId,
      type: "mute",
    };
    await panel.tick();
    expect(h.store.state(`muted:${h.r.id}`)).toBe(true);
    expect(h.device.panels.at(-1)?.acknowledgedCommandId).toBe("mute");
    const response = await h.app.request(
      `/media/${mediaSessionId(h.r.id)}/segments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(64)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "muted-segment",
          text: "buffered fixture",
          source: "remote_participant",
          callId,
          participantIdentity: `worker-${mediaSessionId(h.r.id)}`,
          at: new Date().toISOString(),
        }),
      },
    );
    expect(await response.json()).toEqual({ captured: false, muted: true });
    expect(h.human.turns.poll(h.s.token, h.r.id).turns).toHaveLength(0);
    h.device.panelCommand = {
      id: "end",
      sessionId: h.s.session.id,
      callId,
      type: "end",
    };
    await panel.tick();
    expect(h.device.panels.at(-1)?.callState).toBe("ended");
    expect(h.service.status(h.s.token, h.r.id).state).toBe("completed");
    h.store.close();
  });
  it("refuses native ownership for a local viewer without controller membership", async () => {
    const h = await fixture();
    h.device.controlAllowed = false;
    await expect(h.transition(0, "native")).rejects.toThrow("viewing only");
    expect(h.execution.status(h.s.token, h.r.id).executor).toBe("none");
    h.store.close();
  });

  it("refuses ownership when hangup occurs during final local policy acknowledgement", async () => {
    const h = await fixture();
    const read = h.device.readiness.bind(h.device);
    let reads = 0;
    h.device.readiness = async () => {
      if (++reads === 2) h.service.observeCall(h.r.id, "ended", false);
      return read();
    };
    await expect(h.transition(0, "native")).rejects.toThrow("uncertain");
    expect(h.execution.status(h.s.token, h.r.id).state).toBe("uncertain");
    expect(
      h.store.all<ControlLease>("lease").some((l) => l.state === "active"),
    ).toBe(false);
    h.store.close();
  });
  it("does not let a new request bypass unresolved native ownership on the same display", async () => {
    const h = await fixture();
    await h.transition(0, "native");
    await h.send("stop-native", "stop sharing");
    h.human.turns.end(h.s.token, h.r.id);
    await h.service.drain();
    const next = h.service.requestAttention(h.s.token, {
      taskId: "next",
      idempotencyKey: "next",
      reason: "review",
      question: "fixture",
    });
    await h.service.drain();
    h.service.observeCall(next.id, "connected", true);
    await h.viewing.tick();
    expect(
      h.store
        .all<ControlLease>("lease")
        .some(
          (l) =>
            l.requestId === next.id &&
            l.state === "active" &&
            l.mode === "view",
        ),
    ).toBe(true);
    await expect(
      h.execution.transition(h.s.token, next.id, {
        expectedEpoch: 0,
        executor: "native",
        previousOutcome: "idle",
        backgroundActorsStopped: true,
      }),
    ).rejects.toThrow("Unresolved");
    h.device.policy = "agent_tools_with_fallback";
    await expect(
      h.execution.transition(h.s.token, next.id, {
        expectedEpoch: 0,
        executor: "clawdtime",
        previousOutcome: "idle",
        backgroundActorsStopped: true,
      }),
    ).rejects.toThrow("Unresolved");
    h.store.close();
  });

  it("refuses native ownership after local Stop before its backend callback arrives", async () => {
    const h = await fixture();
    const read = h.device.readiness.bind(h.device);
    let reads = 0;
    h.device.readiness = async () => {
      if (++reads === 2) {
        h.device.armed = false;
        h.device.leases.clear();
      }
      return read();
    };
    await expect(h.transition(0, "native")).rejects.toThrow("uncertain");
    expect(h.execution.status(h.s.token, h.r.id).state).toBe("uncertain");
    h.store.close();
  });
});

describe("activity qualification journey through actual routes and panel", () => {
  it("negotiates old/new helper, explains local readiness, forwards outcomes and ends only explicitly", async () => {
    const h = await fixture(),
      panel = new PanelSynchronizer(h.service, h.control);
    const effects = h.store.effects().length,
      leases = h.store.all("lease").length;
    await panel.tick();
    expect(h.device.panels.at(-1)?.activity).toBeUndefined();
    const policyUrl = `/media/${mediaSessionId(h.r.id)}/policy`;
    const oldPolicy = await (
      await h.app.request(policyUrl, {
        headers: { authorization: "Bearer " + "m".repeat(64) },
      })
    ).json();
    expect(oldPolicy.presentationBinding).toBeUndefined();
    const newPolicy = await (
      await h.app.request(policyUrl, {
        headers: {
          authorization: "Bearer " + "m".repeat(64),
          "X-ClawdTime-Presentation": "1",
        },
      })
    ).json();
    expect(newPolicy.presentationBinding).toMatchObject({
      sessionId: h.s.session.id,
      deviceId: "fixture",
      displayId: 1,
    });
    h.device.presentationVersion = 1;
    h.device.armed = false;
    await panel.tick();
    expect(h.device.panels.at(-1)?.readiness).toMatchObject({
      reason: "sharing_disabled",
    });
    expect(h.device.armed).toBe(false);
    expect(h.store.effects()).toHaveLength(effects);
    h.device.armed = true;
    await h.send("activity-first", "Inspect synthetic fixture");
    const turn = (await (await h.api("turns")).json()).turns[0];
    await h.api("ack", { turnId: turn.id });
    expect(
      (
        await h.api("progress", {
          turnId: turn.id,
          state: "pending_approval",
          presentation: {
            version: 1,
            activity: {
              activityId: "approval",
              kind: "approval_needed",
              summary: "Review in the coding client",
            },
          },
        })
      ).status,
    ).toBe(200);
    await panel.tick();
    expect(h.device.panels.at(-1)?.readiness).toMatchObject({
      reason: "native_approval",
    });
    expect(h.device.panels.at(-1)?.activity).toMatchObject({
      work: "pending_approval",
      delivery: "acknowledged",
    });
    const completed = await h.api("progress", {
      turnId: turn.id,
      state: "completed",
      presentation: {
        version: 1,
        outcome: {
          outcomeId: "result",
          summary: "Synthetic test observed",
          verification: "agent_observed",
          evidenceKind: "test_result",
        },
      },
    });
    expect(completed.status).toBe(200);
    await panel.tick();
    expect(h.device.panels.at(-1)?.activity).toMatchObject({
      work: "completed",
      outcome: { verification: "agent_observed" },
    });
    expect(h.store.effects()).toHaveLength(effects);
    expect(h.store.all("lease")).toHaveLength(leases);
    expect(h.device.inputs).toEqual([]);
    const wrong = await h.app.request(`/api/attention/${h.r.id}/diagnostics`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);
    expect((await h.api("end", {})).status).toBe(200);
    await h.service.drain();
    expect((h.service.transport as SimulationTransport).messages).toHaveLength(
      0,
    );
    expect((h.service.transport as SimulationTransport).ended).toHaveLength(1);
    h.store.close();
  });
});
