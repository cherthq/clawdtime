import { localPolicySchema, type PolicyDevice } from "./execution.js";
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
      current.mode === lease.mode &&
      current.epoch === lease.epoch &&
      current.requestId === lease.requestId &&
      current.sessionId === lease.sessionId &&
      current.pairingId === lease.pairingId &&
      current.callId === lease.callId &&
      current.memberId === lease.memberId &&
      current.deviceId === lease.deviceId &&
      current.displayId === lease.displayId &&
      !!session &&
      (session.protocolVersion === 2
        ? session.state !== "stopped"
        : session.state === "yielded") &&
      Number.isFinite(session.lastSeenAt ?? session.createdAt) &&
      (session.lastSeenAt ?? session.createdAt) <= now + 1000 &&
      now - (session.lastSeenAt ?? session.createdAt) <= 20_000 &&
      session.controlEpoch === lease.epoch &&
      pairing?.revokedAt === undefined &&
      pairing?.allowView &&
      (lease.mode === "view" ||
        (lease.mode === "control" &&
          pairing.allowControl &&
          this.store.state(`continuous-view:${lease.id}`) === true)) &&
      session.pairingId === pairing.id &&
      lease.memberId === pairing.memberId &&
      lease.deviceId === pairing.deviceId &&
      lease.displayId === pairing.displayId &&
      call?.state === "connected" &&
      call.remoteParticipantQualified &&
      request &&
      request.sessionId === session.id &&
      request.pairingId === pairing.id &&
      request.callId === call.id &&
      call.requestId === request.id &&
      call.pairingId === pairing.id &&
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
        !this.captureAllowed(lease) ||
        current?.state !== "active" ||
        current.expiresAt <= now ||
        !session ||
        (session.protocolVersion === 2
          ? session.state === "stopped"
          : session.state !== "yielded") ||
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
          !!s &&
          (s.protocolVersion === 2
            ? s.state !== "stopped"
            : s.state === "yielded") &&
          Number.isFinite(s.lastSeenAt ?? s.createdAt) &&
          (s.lastSeenAt ?? s.createdAt) <= this.now() + 1000 &&
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
          (l) =>
            l.state === "active" &&
            (l.mode === "view" ||
              (l.mode === "control" &&
                this.store.state(`continuous-view:${l.id}`) === true)),
        );
        if (view) {
          if (!this.captureAllowed(view)) {
            this.store.put("lease", { ...view, state: "unknown" });
            this.store.saveState(`view-restore:${r.id}`, false);
            try {
              await this.device.release(view);
              this.store.put("lease", { ...view, state: "released" });
            } catch {
              /* Never renew or replace an expired/invalid grant. */
            }
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
        let policy: { policyRevision: number } | undefined;
        if (s.protocolVersion === 2) {
          const device = this.device as DevicePort & Partial<PolicyDevice>;
          if (!device.readiness) continue;
          try {
            policy = localPolicySchema.parse(
              await device.readiness(p.deviceId, p.memberId, p.displayId),
            );
          } catch {
            continue;
          }
          // Awaiting local metadata must not revive a stopped or superseded session.
          const current = this.store.get<AgentSession>("session", s.id);
          if (
            !current ||
            current.state === "stopped" ||
            current.controlEpoch !== s.controlEpoch ||
            this.store.state(`view-stopped:${r.id}`)
          )
            continue;
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
        }
        const lease: ControlLease = {
          id: `view_${randomUUID()}`,
          requestId: r.id,
          sessionId: s.id,
          pairingId: p.id,
          callId: c.id,
          deviceId: p.deviceId,
          displayId: p.displayId,
          memberId: p.memberId,
          mode:
            s.protocolVersion === 2
              ? "view"
              : p.allowControl
                ? "control"
                : "view",
          epoch:
            s.controlEpoch +
            (s.protocolVersion !== 2 && p.allowControl ? 1 : 0),
          ...(s.protocolVersion === 2
            ? {
                protocolVersion: 2 as const,
                executor: "none" as const,
                executorEpoch: 0,
                policyRevision: policy!.policyRevision,
              }
            : {}),
          expiresAt: Math.min(this.now() + 20_000, r.deadline),
          state: "active",
        };
        this.store.transaction(() => {
          if (lease.mode === "control")
            this.store.put("session", { ...s, controlEpoch: lease.epoch });
          this.store.saveState(`view-started:${r.id}`, true);
          this.store.saveState(`view-restore:${r.id}`, false);
          this.store.put("lease", lease);
          this.store.saveState(`continuous-view:${lease.id}`, true);
          this.store.saveState(`view-device-ready:${lease.id}`, false);
        });
        try {
          // Revalidate every binding after asynchronous readiness and before any capture effect.
          if (!this.captureAllowed(lease)) {
            this.store.put("lease", { ...lease, state: "released" });
            continue;
          }
          await this.device.createLease(lease);
          if (!this.captureAllowed(lease)) {
            this.store.put("lease", { ...lease, state: "unknown" });
            await this.device.release(lease);
            this.store.put("lease", { ...lease, state: "released" });
            continue;
          }
          this.store.saveState(`view-device-ready:${lease.id}`, true);
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
