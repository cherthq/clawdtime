import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ActionReceipt,
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  DevicePort,
  Frame,
  InputAction,
  Pairing,
} from "../contracts.js";
import type { Store } from "../storage/store.js";

export const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("click"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("type"),
      text: z
        .string()
        .min(1)
        .max(512)
        .refine((t) => !/[\x00-\x1f\x7f]/.test(t)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      deltaY: z
        .number()
        .int()
        .min(-500)
        .max(500)
        .refine((n) => n !== 0),
    })
    .strict(),
]);
const id = () => `ctl_${randomUUID()}`;
const liveStates = ["connected", "awaiting_input"];

/** Exclusivity is persisted before awaiting any helper call. One process per DB. */
export class ControlCoordinator {
  private busy = new Set<string>();
  constructor(
    readonly store: Store,
    readonly device: DevicePort,
    readonly now = Date.now,
  ) {
    for (const lease of store.all<ControlLease>("lease")) {
      if (lease.state === "active")
        store.put("lease", { ...lease, state: "unknown" });
    }
    for (const receipt of store.all<ActionReceipt>("action")) {
      if (receipt.state === "pending")
        store.put("action", { ...receipt, state: "unknown" });
    }
  }
  context(requestId: string, memberId: string) {
    const request = this.store.get<AttentionRequest>("attention", requestId);
    const pairing =
      request && this.store.get<Pairing>("pairing", request.pairingId);
    const session =
      request && this.store.get<AgentSession>("session", request.sessionId);
    const call =
      request?.callId && this.store.get<CallSession>("call", request.callId);
    if (
      !request ||
      !pairing ||
      !session ||
      !call ||
      pairing.revokedAt ||
      pairing.memberId !== memberId ||
      !pairing.allowView ||
      !pairing.allowControl ||
      !liveStates.includes(request.state) ||
      request.deadline <= this.now() ||
      call.state !== "connected" ||
      !call.remoteParticipantQualified ||
      session.state !== "yielded" ||
      this.now() - (session.lastSeenAt ?? session.createdAt) > 20_000
    ) {
      throw new Error(
        "Control requires this paired member, an active private call and a cooperatively yielded agent.",
      );
    }
    return { request, pairing, session, call };
  }
  async acquire(requestId: string, memberId: string): Promise<ControlLease> {
    const { request, pairing, session, call } = this.context(
      requestId,
      memberId,
    );
    const ownedLeases = this.store
      .all<ControlLease>("lease")
      .filter(
        (l) =>
          l.deviceId === pairing.deviceId && l.displayId === pairing.displayId,
      );
    if (
      this.store
        .all<ActionReceipt>("action")
        .some(
          (a) =>
            ownedLeases.some((l) => l.id === a.leaseId) &&
            ["pending", "unknown"].includes(a.state),
        )
    )
      throw new Error(
        "Prior input outcome must be reconciled before another action.",
      );
    if (
      this.store
        .all<ControlLease>("lease")
        .some(
          (l) =>
            l.deviceId === pairing.deviceId &&
            l.displayId === pairing.displayId &&
            (l.state === "active" || l.state === "unknown") &&
            l.expiresAt > this.now(),
        )
    )
      throw new Error(
        "Display control is already reserved or release is uncertain.",
      );
    const lease: ControlLease = {
      id: id(),
      requestId,
      sessionId: session.id,
      pairingId: pairing.id,
      callId: call.id,
      deviceId: pairing.deviceId,
      displayId: pairing.displayId,
      memberId,
      mode: "control",
      epoch: session.controlEpoch + 1,
      expiresAt: Math.min(this.now() + 20_000, request.deadline),
      state: "active",
    };
    this.store.transaction(() => {
      this.store.put("session", { ...session, controlEpoch: lease.epoch });
      this.store.put("lease", lease);
    });
    try {
      await this.device.createLease(lease);
      this.check(lease.id, memberId);
      return lease;
    } catch (error) {
      this.store.put("lease", { ...lease, state: "unknown" });
      try {
        await this.release(lease.id);
      } catch {
        /* expiry remains authoritative */
      }
      throw error;
    }
  }
  check(leaseId: string, memberId: string) {
    const lease = this.store.get<ControlLease>("lease", leaseId);
    if (
      !lease ||
      lease.memberId !== memberId ||
      lease.state !== "active" ||
      lease.expiresAt <= this.now()
    )
      throw new Error("Control lease expired or stopped.");
    const { session } = this.context(lease.requestId, memberId);
    if (session.controlEpoch !== lease.epoch)
      throw new Error("Control ownership changed.");
    return lease;
  }
  async frame(leaseId: string, memberId: string) {
    const lease = this.check(leaseId, memberId);
    const raw = await this.device.frame(lease);
    const frame: Frame = {
      id: raw.id,
      capturedAt: raw.capturedAt,
      width: raw.width,
      height: raw.height,
    };
    this.check(leaseId, memberId);
    this.fresh(frame);
    this.store.saveState(`frame:${leaseId}`, frame);
    return frame;
  }
  private fresh(frame: Frame) {
    if (
      !frame.id ||
      !Number.isFinite(frame.capturedAt) ||
      frame.capturedAt > this.now() + 250 ||
      this.now() - frame.capturedAt > 2000 ||
      frame.width <= 0 ||
      frame.height <= 0
    )
      throw new Error("A fresh frame is required.");
  }
  async act(
    leaseId: string,
    memberId: string,
    actionId: string,
    frameId: string,
    input: InputAction,
  ) {
    const lease = this.check(leaseId, memberId);
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(actionId))
      throw new Error("Invalid action ID.");
    const action = actionSchema.parse(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ leaseId, frameId, action }))
      .digest("hex");
    const previous = this.store.get<ActionReceipt>("action", actionId);
    if (previous) {
      if (
        previous.leaseId !== leaseId ||
        this.store.state(`action-hash:${actionId}`) !== fingerprint
      )
        throw new Error("Action ID conflicts.");
      return previous;
    }
    if (this.busy.has(leaseId))
      throw new Error("An action is already in progress.");
    const frame = this.store.state<Frame>(`frame:${leaseId}`);
    if (!frame || frame.id !== frameId)
      throw new Error("Observe the current frame before acting.");
    this.fresh(frame);
    const receipt: ActionReceipt = {
      id: actionId,
      leaseId,
      frameId,
      state: "pending",
      createdAt: this.now(),
    };
    this.store.transaction(() => {
      this.store.put("action", receipt);
      this.store.saveState(`action-hash:${actionId}`, fingerprint);
      this.store.saveState(`frame:${leaseId}`, null);
    });
    this.busy.add(leaseId);
    try {
      this.check(leaseId, memberId);
      const result = await this.device.action(lease, frame, action, actionId);
      if (!result.submitted) throw new Error("Input outcome is unknown.");
      this.store.put("action", { ...receipt, state: "submitted" });
      const afterFrame = await this.frame(leaseId, memberId);
      if (
        afterFrame.id === frame.id ||
        afterFrame.capturedAt < frame.capturedAt
      )
        throw new Error("Post-action frame was not fresh.");
      return this.store.put("action", {
        ...receipt,
        state: "observed",
        afterFrame,
      });
    } catch (error) {
      const current = this.store.get<ActionReceipt>("action", actionId)!;
      if (current.state === "pending")
        this.store.put("action", { ...receipt, state: "unknown" });
      throw error;
    } finally {
      this.busy.delete(leaseId);
    }
  }
  async release(leaseId: string) {
    const lease = this.store.get<ControlLease>("lease", leaseId);
    if (!lease) throw new Error("Unknown lease.");
    if (lease.state === "released") return lease;
    this.store.put("lease", { ...lease, state: "unknown" });
    await this.device.release(lease);
    return this.store.put("lease", { ...lease, state: "released" });
  }
  async stopPairing(pairingId: string) {
    for (const lease of this.store
      .all<ControlLease>("lease")
      .filter((l) => l.pairingId === pairingId && l.state !== "released")) {
      try {
        await this.release(lease.id);
      } catch {
        /* retained unknown, no replacement */
      }
    }
  }
}

export class SimulatedDevice implements DevicePort {
  readonly leases = new Map<string, ControlLease>();
  readonly inputs: string[] = [];
  async createLease(l: ControlLease) {
    this.leases.set(l.id, l);
  }
  async frame(l: ControlLease): Promise<Frame> {
    if (!this.leases.has(l.id)) throw new Error("Stopped");
    return {
      id: `frame_${randomUUID()}`,
      capturedAt: Date.now(),
      width: 1280,
      height: 720,
    };
  }
  async action(l: ControlLease, _f: Frame, _a: InputAction, actionId: string) {
    if (!this.leases.has(l.id)) throw new Error("Stopped");
    this.inputs.push(actionId);
    return { submitted: true };
  }
  async release(l: ControlLease) {
    this.leases.delete(l.id);
  }
}
