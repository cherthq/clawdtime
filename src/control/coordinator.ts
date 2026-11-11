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
import { ControlPreflightError } from "./errors.js";

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
  private captureContext(requestId: string, memberId: string) {
    if (this.store.state(`view-stopped:${requestId}`))
      throw new ControlPreflightError("stopped");
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
      pairing.revokedAt !== undefined ||
      pairing.memberId !== memberId ||
      session.pairingId !== pairing.id ||
      call.requestId !== request.id ||
      call.pairingId !== pairing.id ||
      !pairing.allowView ||
      !liveStates.includes(request.state) ||
      request.deadline <= this.now() ||
      call.state !== "connected" ||
      !call.remoteParticipantQualified ||
      session.state !== "yielded" ||
      !Number.isFinite(session.lastSeenAt ?? session.createdAt) ||
      (session.lastSeenAt ?? session.createdAt) > this.now() + 1000 ||
      this.now() - (session.lastSeenAt ?? session.createdAt) > 20_000
    ) {
      throw new ControlPreflightError("context_expired");
    }
    return { request, pairing, session, call };
  }
  context(requestId: string, memberId: string) {
    const context = this.captureContext(requestId, memberId);
    if (!context.pairing.allowControl)
      throw new ControlPreflightError("context_expired");
    return context;
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
            ["pending", "submitted", "unknown"].includes(a.state),
        )
    )
      throw new Error(
        "Prior input outcome must be reconciled before another action.",
      );
    const reserved = ownedLeases.filter(
      (l) =>
        ["active", "unknown"].includes(l.state) && l.expiresAt > this.now(),
    );
    const continuous = reserved.length === 1 ? reserved[0] : undefined;
    if (
      continuous &&
      this.store.state(`continuous-view:${continuous.id}`) === true &&
      continuous.state === "active" &&
      continuous.mode === "control" &&
      continuous.requestId === request.id &&
      continuous.sessionId === session.id &&
      continuous.pairingId === pairing.id &&
      continuous.memberId === memberId &&
      continuous.callId === call.id &&
      continuous.epoch === session.controlEpoch
    ) {
      this.check(continuous.id, memberId);
      // Authorization renewal only: media refreshes the same helper lease. No
      // capture stream reset or input dispatch, and expired grants never revive.
      if (continuous.expiresAt - this.now() < 12_000) {
        return this.store.put<ControlLease>("lease", {
          ...continuous,
          expiresAt: Math.min(this.now() + 20_000, request.deadline),
        });
      }
      return continuous;
    }
    if (
      ownedLeases.some(
        (l) =>
          l.requestId === request.id &&
          this.store.state(`continuous-view:${l.id}`) === true,
      )
    )
      throw new ControlPreflightError("stopped");
    if (reserved.length)
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
    return this.checkMode(leaseId, memberId, "control");
  }
  /** Existing read-only capture grant only; never allocates or upgrades control. */
  checkView(leaseId: string, memberId: string) {
    return this.checkMode(leaseId, memberId, "view");
  }
  private checkMode(
    leaseId: string,
    memberId: string,
    mode: "view" | "control",
  ) {
    const lease = this.store.get<ControlLease>("lease", leaseId);
    if (
      !lease ||
      lease.memberId !== memberId ||
      lease.state !== "active" ||
      (this.store.state(`continuous-view:${lease.id}`) === true &&
        this.store.state(`view-device-ready:${lease.id}`) !== true) ||
      !Number.isFinite(lease.expiresAt) ||
      lease.expiresAt <= this.now()
    )
      throw new ControlPreflightError("stopped");
    const { session, pairing, call } =
      mode === "control"
        ? this.context(lease.requestId, memberId)
        : this.captureContext(lease.requestId, memberId);
    if (
      session.controlEpoch !== lease.epoch ||
      lease.mode !== mode ||
      lease.sessionId !== session.id ||
      lease.pairingId !== pairing.id ||
      lease.callId !== call.id ||
      lease.deviceId !== pairing.deviceId ||
      lease.displayId !== pairing.displayId
    )
      throw new ControlPreflightError("context_expired");
    return lease;
  }
  async frame(leaseId: string, memberId: string) {
    const lease = this.check(leaseId, memberId);
    let raw: Frame;
    try {
      raw = await this.device.frame(lease);
    } catch {
      this.check(leaseId, memberId);
      throw new ControlPreflightError("frame_unavailable");
    }
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
      throw new ControlPreflightError("frame_unavailable");
  }
  async act(
    leaseId: string,
    memberId: string,
    actionId: string,
    frameId: string,
    input: InputAction,
  ): Promise<ActionReceipt> {
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
      return this.store.put<ActionReceipt>("action", {
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
