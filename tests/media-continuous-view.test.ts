import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import {
  ControlCoordinator,
  SimulatedDevice,
} from "../src/control/coordinator.js";
import { Viewing } from "../src/control/viewing.js";
import type { AgentSession, ControlLease, Pairing } from "../src/contracts.js";

async function fixture(allowControl = true, deferView = false) {
  let now = Date.now();
  const store = new Store(),
    service = new ClawdTime(store, new SimulationTransport());
  class Device extends SimulatedDevice {
    creates = 0;
    releases = 0;
    override async createLease(lease: ControlLease) {
      this.creates++;
      await super.createLease(lease);
    }
    override async release(lease: ControlLease) {
      this.releases++;
      await super.release(lease);
    }
    override async frame(lease: ControlLease) {
      return { ...(await super.frame(lease)), capturedAt: now };
    }
  }
  const device = new Device(),
    control = new ControlCoordinator(store, device, () => now),
    viewing = new Viewing(store, device, () => now);
  const invitation = service.createPairingInvite({
    memberId: "member",
    recipient: "fixture",
    lineId: "line",
    conversationId: "fixture",
    deviceId: "mac",
    displayId: "1",
  });
  const paired = service.claimPairing({
    token: invitation.token,
    deviceId: "mac",
    displayId: "1",
    allowView: true,
    allowControl,
  });
  const agent = service.registerSession(paired.token, {
    adapter: "codex",
    adapterVersion: "fixture",
    projectRoot: "/fixture",
    externalSessionId: "conversation",
    hostId: "host",
    capabilities: { cooperativePause: true, polling: true },
  });
  service.yieldSession(agent.token);
  const request = service.requestAttention(agent.token, {
    taskId: "task",
    idempotencyKey: "attention",
    reason: "decision",
    question: "Fixture",
    timeoutSeconds: 300,
  });
  await service.drain();
  service.observeCall(request.id, "connected", true);
  if (!deferView) await viewing.tick();
  return {
    store,
    service,
    device,
    control,
    viewing,
    request,
    agent,
    paired,
    advance(ms: number, heartbeat = true) {
      now += ms;
      if (heartbeat) {
        const session = store.get<AgentSession>("session", agent.session.id)!;
        store.put("session", { ...session, lastSeenAt: now });
      }
    },
    lease: () => store.all<ControlLease>("lease")[0]!,
  };
}

describe("continuous screen capture with exclusive human input", () => {
  it.each([false, true])(
    "cannot reuse an unacknowledged helper grant (Stop=%s)",
    async (stop) => {
      const f = await fixture(true, true);
      let begin!: () => void, finish!: () => void;
      const began = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const create = f.device.createLease.bind(f.device);
      f.device.createLease = async (lease) => {
        begin();
        await gate;
        await create(lease);
      };
      const pending = f.viewing.tick();
      await began;
      await expect(f.control.acquire(f.request.id, "member")).rejects.toThrow();
      expect(() => f.control.check(f.lease().id, "member")).toThrow();
      expect(f.device.inputs).toHaveLength(0);
      if (stop) f.store.saveState(`view-stopped:${f.request.id}`, true);
      finish();
      await pending;
      if (stop) {
        await expect(
          f.control.acquire(f.request.id, "member"),
        ).rejects.toThrow();
        expect(f.lease().state).toBe("released");
      } else
        expect((await f.control.acquire(f.request.id, "member")).id).toBe(
          f.lease().id,
        );
      f.store.close();
    },
  );
  it("keeps one lease and epoch through sequential observed inputs and renewal", async () => {
    const f = await fixture();
    try {
      const original = f.lease();
      expect(original.mode).toBe("control");
      expect(original.epoch).toBe(f.agent.session.controlEpoch + 1);
      expect(f.store.state(`continuous-view:${original.id}`)).toBe(true);
      for (let i = 0; i < 3; i++) {
        const lease = await f.control.acquire(f.request.id, "member");
        expect(lease.id).toBe(original.id);
        expect(lease.epoch).toBe(original.epoch);
        const frame = await f.control.frame(lease.id, "member");
        expect(
          (
            await f.control.act(lease.id, "member", `action_${i}`, frame.id, {
              kind: "click",
              x: 0.5,
              y: 0.5,
            })
          ).state,
        ).toBe("observed");
        f.advance(9000);
        await f.viewing.tick();
      }
      expect(f.device.creates).toBe(1);
      expect(f.device.releases).toBe(0);
      expect(f.lease().expiresAt).toBeGreaterThan(original.expiresAt);
      expect(f.device.inputs).toHaveLength(3);
    } finally {
      f.store.close();
    }
  });

  it("renews before a screen tool without recreating its capture stream", async () => {
    const f = await fixture();
    try {
      const before = f.lease();
      f.advance(9000);
      const after = await f.control.acquire(f.request.id, "member");
      expect(after.id).toBe(before.id);
      expect(after.expiresAt).toBeGreaterThan(before.expiresAt);
      expect(f.device.creates).toBe(1);
    } finally {
      f.store.close();
    }
  });

  it("a viewer-only pairing remains view-only", async () => {
    const f = await fixture(false);
    try {
      expect(f.lease().mode).toBe("view");
      expect(f.control.checkView(f.lease().id, "member").id).toBe(f.lease().id);
      expect(() => f.control.checkView(f.lease().id, "foreign")).toThrow();
      await expect(f.control.acquire(f.request.id, "member")).rejects.toThrow();
      expect(f.device.inputs).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });

  it("read-only checks cannot reinterpret a control lease or revive stale view authority", async () => {
    const controlled = await fixture();
    try {
      expect(() =>
        controlled.control.checkView(controlled.lease().id, "member"),
      ).toThrow();
    } finally {
      controlled.store.close();
    }
    const viewed = await fixture(false);
    try {
      viewed.store.saveState(`view-stopped:${viewed.request.id}`, true);
      expect(() =>
        viewed.control.checkView(viewed.lease().id, "member"),
      ).toThrow();
      viewed.store.saveState(`view-stopped:${viewed.request.id}`, false);
      viewed.advance(21000);
      expect(() =>
        viewed.control.checkView(viewed.lease().id, "member"),
      ).toThrow();
      expect(viewed.device.creates).toBe(1);
      expect(viewed.device.inputs).toHaveLength(0);
    } finally {
      viewed.store.close();
    }
  });

  it.each([
    "stop",
    "expired",
    "heartbeat",
    "epoch",
    "revoked",
    "call-ended",
    "control-revoked",
  ])("never renews or recreates after %s", async (kind) => {
    const f = await fixture();
    try {
      const before = f.lease(),
        session = f.store.get<AgentSession>("session", f.agent.session.id)!;
      if (kind === "stop")
        f.store.saveState(`view-stopped:${f.request.id}`, true);
      if (kind === "expired") f.advance(21000);
      if (kind === "heartbeat") f.advance(21000, false);
      if (kind === "epoch")
        f.store.put("session", {
          ...session,
          controlEpoch: session.controlEpoch + 1,
        });
      if (kind === "revoked" || kind === "control-revoked") {
        const pairing = f.store.get<Pairing>("pairing", before.pairingId)!;
        f.store.put("pairing", {
          ...pairing,
          ...(kind === "revoked"
            ? { revokedAt: Date.now() }
            : { allowControl: false }),
        });
      }
      if (kind === "call-ended") {
        const call = f.store.get<{ id: string }>("call", before.callId)!;
        f.store.put("call", { ...call, state: "ended" });
      }
      await f.viewing.tick();
      await f.viewing.tick();
      expect(f.lease().expiresAt).toBe(before.expiresAt);
      expect(f.lease().state).toBe("released");
      expect(f.device.creates).toBe(1);
      await expect(f.control.acquire(f.request.id, "member")).rejects.toThrow();
      expect(f.device.creates).toBe(1);
    } finally {
      f.store.close();
    }
  });

  it.each(["pending", "submitted", "unknown"])(
    "blocks lease reuse while %s input needs reconciliation",
    async (state) => {
      const f = await fixture();
      try {
        f.store.put("action", {
          id: "uncertain",
          leaseId: f.lease().id,
          state,
        });
        await expect(f.control.acquire(f.request.id, "member")).rejects.toThrow(
          "reconciled",
        );
        expect(f.device.creates).toBe(1);
        expect(f.device.inputs).toHaveLength(0);
      } finally {
        f.store.close();
      }
    },
  );

  it.each(["sessionId", "callId", "pairingId", "memberId", "epoch"])(
    "does not reuse a continuous lease with changed %s",
    async (field) => {
      const f = await fixture();
      try {
        f.store.put("lease", {
          ...f.lease(),
          [field]: field === "epoch" ? 999 : "foreign",
        });
        await expect(
          f.control.acquire(f.request.id, "member"),
        ).rejects.toThrow();
        expect(f.device.creates).toBe(1);
      } finally {
        f.store.close();
      }
    },
  );
});
