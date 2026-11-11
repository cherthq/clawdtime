import { randomUUID } from "node:crypto";
import type { Store } from "../storage/store.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  Pairing,
  DevicePort,
} from "../contracts.js";

/** One explicit paired-session screen selection per attention request. Stop latches. */
export class Viewing {
  private busy = false;
  constructor(
    readonly store: Store,
    readonly device: DevicePort,
    readonly now = Date.now,
    readonly live = false,
  ) {}
  private captureAllowed(lease: ControlLease) {
    const current = this.store.get<ControlLease>("lease", lease.id);
    const session = this.store.get<AgentSession>("session", lease.sessionId);
    const call = this.store.get<CallSession>("call", lease.callId);
    const pairing = this.store.get<Pairing>("pairing", lease.pairingId);
    const request = this.store.get<AttentionRequest>(
      "attention",
      lease.requestId,
    );
    const now = this.now();
    return (
      current?.state === "active" &&
      current.expiresAt > now &&
      session?.state === "yielded" &&
      now - (session.lastSeenAt ?? session.createdAt) <= 20_000 &&
      session.controlEpoch === lease.epoch &&
      pairing?.revokedAt === undefined &&
      pairing?.allowView &&
      call?.state === "connected" &&
      call.remoteParticipantQualified &&
      request &&
      !request.responseId &&
      request.deadline > now &&
      ["connected", "awaiting_input"].includes(request.state) &&
      !this.store.state(`view-stopped:${lease.requestId}`)
    );
  }
  private async observeSetupFrame(lease: ControlLease) {
    if (
      !this.captureAllowed(lease) ||
      this.store.state(`setup-view:${lease.requestId}`) ||
      !this.store
        .all<{ requestId?: string }>("setup_test")
        .some((test) => test.requestId === lease.requestId)
    )
      return;
    try {
      const frame = await this.device.frame(lease);
      const current = this.store.get<ControlLease>("lease", lease.id);
      const session = this.store.get<AgentSession>("session", lease.sessionId);
      const call = this.store.get<CallSession>("call", lease.callId);
      const pairing = this.store.get<Pairing>("pairing", lease.pairingId);
      const request = this.store.get<AttentionRequest>(
        "attention",
        lease.requestId,
      );
      const now = this.now();
      if (
        !frame.id ||
        frame.width <= 0 ||
        frame.height <= 0 ||
        !Number.isFinite(frame.capturedAt) ||
        frame.capturedAt > now ||
        now - frame.capturedAt > 2000 ||
        current?.state !== "active" ||
        current.expiresAt <= now ||
        session?.state !== "yielded" ||
        now - (session.lastSeenAt ?? session.createdAt) > 20_000 ||
        session.controlEpoch !== lease.epoch ||
        pairing?.revokedAt !== undefined ||
        !pairing?.allowView ||
        call?.state !== "connected" ||
        !call.remoteParticipantQualified ||
        request?.responseId ||
        !request ||
        request.deadline <= now ||
        !["connected", "awaiting_input"].includes(request.state) ||
        this.store.state(`view-stopped:${lease.requestId}`)
      )
        return;
      // Metadata proves capture, not handset rendering; verified human feedback
      // and the result receipt remain separate setup acceptance requirements.
      this.store.saveState(`setup-view:${lease.requestId}`, {
        requestId: lease.requestId,
        callId: lease.callId,
        sessionId: lease.sessionId,
        pairingId: lease.pairingId,
        leaseId: lease.id,
        frameId: frame.id,
        capturedAt: frame.capturedAt,
        observedAt: now,
        live: this.live,
      });
    } catch {
      /* A later fresh observation may succeed; no input is replayed. */
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const r of this.store.all<AttentionRequest>("attention")) {
        const s = this.store.get<AgentSession>("session", r.sessionId),
          p = this.store.get<Pairing>("pairing", r.pairingId),
          c = this.store.get<CallSession>("call", r.callId ?? "");
        const open =
          p &&
          p.revokedAt === undefined &&
          p.allowView &&
          s?.state === "yielded" &&
          this.now() - (s.lastSeenAt ?? s.createdAt) <= 20_000 &&
          c?.state === "connected" &&
          c.remoteParticipantQualified &&
          r.deadline > this.now() &&
          ["connected", "awaiting_input"].includes(r.state) &&
          !this.store.state(`view-stopped:${r.id}`) &&
          !r.responseId;
        const leases = this.store
          .all<ControlLease>("lease")
          .filter((l) => l.requestId === r.id);
        if (!open) {
          for (const l of leases.filter(
            (l) => l.state === "active" || l.state === "unknown",
          )) {
            this.store.put("lease", { ...l, state: "unknown" });
            try {
              await this.device.release(l);
              this.store.put("lease", { ...l, state: "released" });
            } catch {
              /* retained until read-only reconciliation */
            }
          }
          continue;
        }
        const view = leases.find(
          (l) => l.mode === "view" && l.state === "active",
        );
        if (view) {
          if (view.expiresAt <= this.now()) {
            this.store.put("lease", { ...view, state: "unknown" });
            continue;
          }
          if (view.expiresAt - this.now() < 12_000)
            this.store.put("lease", {
              ...view,
              expiresAt: Math.min(this.now() + 20_000, r.deadline),
            });
          await this.observeSetupFrame(view);
          continue;
        }
        if (
          (leases.length || this.store.state(`view-started:${r.id}`)) &&
          !this.store.state(`view-restore:${r.id}`)
        )
          continue;
        // Reserve physical display across every paired session before network work.
        if (
          this.store
            .all<ControlLease>("lease")
            .some(
              (l) =>
                l.deviceId === p.deviceId &&
                l.displayId === p.displayId &&
                ["active", "unknown"].includes(l.state),
            )
        )
          continue;
        const lease: ControlLease = {
          id: `view_${randomUUID()}`,
          requestId: r.id,
          sessionId: s.id,
          pairingId: p.id,
          callId: c.id,
          deviceId: p.deviceId,
          displayId: p.displayId,
          memberId: p.memberId,
          mode: "view",
          epoch: s.controlEpoch,
          expiresAt: Math.min(this.now() + 20_000, r.deadline),
          state: "active",
        };
        this.store.saveState(`view-started:${r.id}`, true);
        this.store.saveState(`view-restore:${r.id}`, false);
        this.store.put("lease", lease);
        try {
          await this.device.createLease(lease);
          if (!this.captureAllowed(lease)) {
            this.store.put("lease", { ...lease, state: "unknown" });
            await this.device.release(lease);
            this.store.put("lease", { ...lease, state: "released" });
            continue;
          }
          await this.observeSetupFrame(lease);
        } catch {
          this.store.put("lease", { ...lease, state: "unknown" });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
