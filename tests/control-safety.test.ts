import { describe, it, expect } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { Viewing } from "../src/control/viewing.js";
import type { ActionReceipt, ControlLease } from "../src/contracts.js";
async function setup() {
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport()),
    device = new SimulatedDevice(),
    control = new ControlCoordinator(store, device),
    human = new HumanRouter(service, control),
    viewing = new Viewing(store, device);
  const binding = {
    memberId: "m",
    recipient: "+15555550100",
    conversationId: "iMessage;-;+15555550100",
    lineId: "l",
    deviceId: "d",
    displayId: "1",
  };
  const i = service.createPairingInvite(binding),
    p = service.claimPairing({
      token: i.token,
      deviceId: "d",
      displayId: "1",
      allowView: true,
      allowControl: true,
    }),
    s = service.registerSession(p.token, {
      adapter: "codex",
      adapterVersion: "test",
      projectRoot: "/fixture",
      externalSessionId: "session",
      hostId: "host",
      capabilities: { cooperativePause: true, polling: true },
    });
  service.yieldSession(s.token);
  const r = service.requestAttention(s.token, {
    taskId: "t",
    idempotencyKey: "k",
    reason: "decision",
    question: "fixture",
  });
  await service.drain();
  service.observeCall(r.id, "connected", true);
  const send = (eventId: string, text: string) =>
    human.receive({
      eventId,
      text,
      requestId: r.id,
      memberId: "m",
      lineId: "l",
      conversationId: binding.conversationId,
      channel: "text",
    });
  return { store, service, device, control, human, viewing, s, r, send };
}
describe("control safety across async boundaries", () => {
  it("blocks a second command without releasing input in flight", async () => {
    const h = await setup();
    let finish!: () => void, started!: () => void;
    const began = new Promise<void>((r) => (started = r)),
      hold = new Promise<void>((r) => (finish = r));
    h.device.action = async (_l, _f, _a, id) => {
      h.device.inputs.push(id);
      started();
      await hold;
      return { submitted: true };
    };
    const a = h.send("a", "click 0.5 0.5");
    await began;
    await expect(h.send("b", "type: raced")).rejects.toThrow("progress");
    expect(h.device.leases.size).toBe(1);
    expect(h.device.inputs).toHaveLength(1);
    finish();
    await a;
    expect(h.device.leases.size).toBe(0);
  });
  it("restores viewing after observed CUA, but never after Stop", async () => {
    const h = await setup();
    await h.viewing.tick();
    expect([...h.device.leases.values()][0]?.mode).toBe("view");
    await h.send("a", "click 0.5 0.5");
    await h.viewing.tick();
    expect([...h.device.leases.values()][0]?.mode).toBe("view");
    await h.send("stop", "stop");
    await h.viewing.tick();
    expect(h.device.leases.size).toBe(0);
    expect(h.store.state(`view-stopped:${h.r.id}`)).toBe(true);
  });
  it("does not persist pixels returned by a richer device adapter", async () => {
    const h = await setup(),
      raw = h.device.frame.bind(h.device);
    h.device.frame = async (l) => ({
      ...(await raw(l)),
      jpegBase64: "PRIVATE_PIXELS",
    });
    await h.send("a", "click 0.5 0.5");
    expect(
      JSON.stringify(h.store.query("SELECT body FROM operational_state")),
    ).not.toContain("PRIVATE_PIXELS");
    expect(JSON.stringify(h.store.all<ActionReceipt>("action"))).not.toContain(
      "PRIVATE_PIXELS",
    );
  });
  it("requires observation after a submitted input before resume", async () => {
    const h = await setup(),
      raw = h.device.frame.bind(h.device);
    let count = 0;
    h.device.frame = async (l) => {
      if (++count > 1) throw new Error("capture lost");
      return raw(l);
    };
    await expect(h.send("a", "click 0.5 0.5")).rejects.toThrow();
    expect(h.store.all<ActionReceipt>("action")[0]?.state).toBe("submitted");
    await h.send("answer", "answer: continue");
    const response = h.service.result(h.s.token, h.r.id).response!;
    h.service.ack(h.s.token, h.r.id, response.id);
    expect(() =>
      h.service.resume(
        h.s.token,
        h.r.id,
        h.service.authenticateSession(h.s.token).controlEpoch,
      ),
    ).toThrow("Control");
  });
  it("refuses stale frames and a stop during input cannot permit continuation", async () => {
    const h = await setup(),
      lease = await h.control.acquire(h.r.id, "m");
    h.store.saveState(`frame:${lease.id}`, {
      id: "old",
      capturedAt: Date.now() - 3000,
      width: 100,
      height: 100,
    });
    await expect(
      h.control.act(lease.id, "m", "a", "old", {
        kind: "click",
        x: 0.5,
        y: 0.5,
      }),
    ).rejects.toThrow("fresh");
    expect(h.device.inputs).toHaveLength(0);
    await h.control.release(lease.id);
    expect(h.store.all<ControlLease>("lease")[0]?.state).toBe("released");
  });
});
