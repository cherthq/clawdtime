import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { ClawdTime } from "../src/attention/service.js";
import { Store } from "../src/storage/store.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { ScriptedConversationAgent } from "./backend-conversation-fixture.js";
import { HumanRouter } from "../src/control/human-router.js";
import { Viewing } from "../src/control/viewing.js";
import { VisionPlanner } from "../src/control/planner.js";
import { mediaSessionId } from "../media/device-port.js";
import type { ControlLease, Frame, InputAction } from "../src/contracts.js";

const op = "o".repeat(32),
  media = "m".repeat(32);
function pair(service: ClawdTime) {
  const invite = service.createPairingInvite({
    memberId: "member_review",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "line_review",
    deviceId: "device_review",
    displayId: "1",
  });
  const paired = service.claimPairing({
    token: invite.token,
    deviceId: "device_review",
    displayId: "1",
    allowView: true,
    allowControl: true,
  });
  const registered = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "fixture",
    hostId: "fixture",
    capabilities: { cooperativePause: true, polling: true },
  });
  service.yieldSession(registered.token);
  const request = service.requestAttention(registered.token, {
    taskId: "fixture",
    idempotencyKey: "fixture",
    reason: "decision",
    question: "Fixture",
  });
  return { paired, registered, request };
}
const post = (body: unknown, token: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});

async function controlFixture(device = new SimulatedDevice()) {
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport());
  const control = new ControlCoordinator(store, device),
    human = new HumanRouter(
      service,
      control,
      new ScriptedConversationAgent(device),
    ),
    viewing = new Viewing(store, device);
  const fixture = pair(service);
  await service.drain();
  service.observeCall(fixture.request.id, "connected", true);
  const input = {
    requestId: fixture.request.id,
    memberId: "member_review",
    lineId: "line_review",
    conversationId: "fixture",
    channel: "text" as const,
  };
  return { store, service, control, human, viewing, device, input, ...fixture };
}

describe("independent final safety review", () => {
  it("operator drain cannot dispatch newly queued calls in standby", async () => {
    const runtime = createRuntime({
      CLAWDTIME_MODE: "standby",
      CLAWDTIME_DATABASE: ":memory:",
      CLAWDTIME_OPERATOR_TOKEN: op,
    });
    try {
      pair(runtime.service);
      await runtime.app.request("/internal/drain", post({}, op));
      expect((runtime.transport as SimulationTransport).calls).toHaveLength(0);
    } finally {
      runtime.store.close();
    }
  });

  it("queued voice feedback cannot cross the stop-listening boundary", async () => {
    const runtime = createRuntime({
      CLAWDTIME_MODE: "simulation",
      CLAWDTIME_DATABASE: ":memory:",
      CLAWDTIME_OPERATOR_TOKEN: op,
      CLAWDTIME_MEDIA_TOKEN: media,
    });
    try {
      const fixture = pair(runtime.service);
      await runtime.service.drain();
      runtime.service.observeCall(fixture.request.id, "connected", true);
      const sid = mediaSessionId(fixture.request.id),
        base = {
          source: "remote_participant",
          callId: sid,
          participantIdentity: `worker-${sid}`,
          at: new Date().toISOString(),
        };
      const stopped = await runtime.app.request(
        `/media/${sid}/segments`,
        post(
          { ...base, id: "1", text: "Hey ClawdTime, stop listening" },
          media,
        ),
      );
      expect((await stopped.json()).stopped).toBe(true);
      await runtime.app.request(
        `/media/${sid}/segments`,
        post(
          { ...base, id: "2", text: "Hey ClawdTime, answer: proceed" },
          media,
        ),
      );
      expect(
        runtime.service.result(fixture.registered.token, fixture.request.id)
          .response,
      ).toBeUndefined();
    } finally {
      runtime.store.close();
    }
  });

  it("retains continuous viewing after successful CUA but preserves the stop latch", async () => {
    const f = await controlFixture();
    try {
      await f.viewing.tick();
      const before = f.store
        .all<ControlLease>("lease")
        .find((l) => l.state === "active")!;
      expect(before.mode).toBe("control");
      await f.human.receive({
        ...f.input,
        eventId: "type",
        text: "type: Fixture",
      });
      await f.viewing.tick();
      const after = f.store
        .all<ControlLease>("lease")
        .find((l) => l.state === "active")!;
      expect(after.mode).toBe("control");
      expect(after.id).toBe(before.id);
      await f.human.receive({ ...f.input, eventId: "stop", text: "stop" });
      await f.viewing.tick();
      await f.viewing.tick();
      expect(
        f.store.all<ControlLease>("lease").filter((l) => l.state === "active"),
      ).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });

  it("in-flight input followed by Stop never permits resume without observation", async () => {
    let finish!: () => void, started!: () => void;
    const pending = new Promise<void>((r) => (finish = r)),
      entered = new Promise<void>((r) => (started = r));
    class DelayedDevice extends SimulatedDevice {
      override async action(
        _l: ControlLease,
        _f: Frame,
        _a: InputAction,
        _id: string,
      ) {
        started();
        await pending;
        return { submitted: true };
      }
    }
    const f = await controlFixture(new DelayedDevice());
    try {
      const input = f.human
        .receive({ ...f.input, eventId: "typing", text: "type: Fixture" })
        .catch(() => undefined);
      await entered;
      await f.human.receive({ ...f.input, eventId: "stop", text: "stop" });
      const response = f.service.receiveResponse({
        ...f.input,
        eventId: "answer",
        text: "Continue",
      });
      f.service.ack(f.registered.token, f.request.id, response.id);
      const epoch = f.service.authenticateSession(
        f.registered.token,
      ).controlEpoch;
      expect(() =>
        f.service.resume(f.registered.token, f.request.id, epoch),
      ).toThrow();
      finish();
      await input;
      expect(() =>
        f.service.resume(f.registered.token, f.request.id, epoch),
      ).toThrow();
    } finally {
      finish();
      f.store.close();
    }
  });

  it("vision planning requires identical reobserved pixels and binds the fresh frame", async () => {
    const frame = (id: string) => ({
      id,
      capturedAt: Date.now(),
      width: 100,
      height: 100,
    });
    let index = 0;
    const device = {
      async frameImage() {
        return {
          frame: frame(`frame_${++index}`),
          dataUrl:
            index <= 2
              ? "data:image/jpeg;base64,AA=="
              : "data:image/jpeg;base64,AB==",
        };
      },
    };
    const generate = (async () => ({
      output: { action: { kind: "click", x: 0.5, y: 0.5 }, clarification: "" },
    })) as never;
    const planner = new VisionPlanner(
      device,
      {} as never,
      generate,
      async () => {},
    );
    await expect(
      planner.plan("Click the fixture button", {
        expiresAt: Date.now() + 20_000,
      } as ControlLease),
    ).rejects.toThrow("screen changed");
    index = 0;
    device.frameImage = async () => ({
      frame: frame(`frame_${++index}`),
      dataUrl: "data:image/jpeg;base64,AA==",
    });
    const planned = await planner.plan("Click the fixture button", {
      expiresAt: Date.now() + 20_000,
    } as ControlLease);
    expect(planned.frame.id).toBe("frame_3");
  });
});
