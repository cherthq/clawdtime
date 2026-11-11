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
  ) {}
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
        } catch {
          this.store.put("lease", { ...lease, state: "unknown" });
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
