import type { ProactiveCallCoordinator } from "../attention/proactive-coordinator.js";
import type {
  CallAttemptGrant,
  ProactiveCallIntent,
} from "../attention/proactive-contracts.js";

/** A transport must prove both provider termination and capture/line cleanup. A
 * rejected promise is deliberately not such proof. */
export interface ProactiveDeliveryPort {
  readiness(
    intent: ProactiveCallIntent,
  ): Promise<{ ready: boolean; reason?: string }>;
  deliver(
    intent: ProactiveCallIntent,
    grant: CallAttemptGrant,
  ): Promise<{
    state: "ended" | "refused" | "unknown";
    cleanupConfirmed: boolean;
    reason?: string;
  }>;
  stop?(intent: ProactiveCallIntent): Promise<void>;
}
export interface ProactivePreparationPort {
  prepare(
    intent: ProactiveCallIntent,
  ): Promise<{ fingerprint: string } | { blocked: string }>;
  release?(intentId: string): Promise<{ confirmed: boolean }>;
  current(
    intent: ProactiveCallIntent,
    fingerprint: string,
  ): boolean | Promise<boolean>;
}

/** Service-owned scheduling, independent of the panel or an active coding chat.
 * Every source shares one durable admission and one delivery owner. */
export class ProactiveService {
  private pumping = false;
  private closed = false;
  constructor(
    readonly coordinator: ProactiveCallCoordinator,
    private readonly ports: {
      sourceCurrent(intent: ProactiveCallIntent): boolean;
      preparation?: ProactivePreparationPort;
      delivery?: ProactiveDeliveryPort;
    },
  ) {}
  async pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      for (const initial of this.coordinator.list()) {
        if (this.closed) break;
        if (!["queued", "preparing", "ready"].includes(initial.state)) continue;
        let record = this.coordinator.reconcile(initial.id, {
          current: this.ports.sourceCurrent(initial),
        });
        if (!["queued", "preparing", "ready"].includes(record.state)) continue;
        if (!this.ports.delivery || !this.ports.preparation) {
          this.coordinator.block(
            record.id,
            !this.ports.delivery
              ? "outbound_delivery_not_configured"
              : "walkthrough_preparer_not_configured",
          );
          continue;
        }
        // Unknown delivery from any source fences every later phone call.
        if (
          this.coordinator
            .list()
            .some((r) =>
              ["dispatching", "connected", "unknown"].includes(r.state),
            )
        )
          break;
        let preparationStarted = false;
        try {
          const policy = this.coordinator.authority.inspect(record);
          if (!policy.allowed) {
            this.coordinator.block(
              record.id,
              policy.reason ?? "policy_unavailable",
            );
            continue;
          }
          const readiness = await this.ports.delivery.readiness(record);
          if (!readiness.ready) {
            this.coordinator.block(
              record.id,
              readiness.reason ?? "waiting_for_line",
            );
            continue;
          }
          preparationStarted = true;
          this.coordinator.prepare(record.id);
          const prepared = await this.ports.preparation.prepare(record);
          if ("blocked" in prepared) {
            this.coordinator.block(record.id, prepared.blocked);
            continue;
          }
          if (this.closed) {
            this.coordinator.block(record.id, "service_stopping");
            break;
          }
          record = this.coordinator.reconcile(record.id, {
            current: this.ports.sourceCurrent(record),
          });
          if (!["preparing", "ready"].includes(record.state)) continue;
          if (
            !(await this.ports.preparation.current(
              record,
              prepared.fingerprint,
            ))
          ) {
            this.coordinator.block(record.id, "prepared_source_changed");
            continue;
          }
          this.coordinator.ready(record.id, prepared.fingerprint);
          // Incoming admission may have changed while preparing. Recheck it.
          const fresh = await this.ports.delivery.readiness(record);
          if (!fresh.ready || this.closed) {
            this.coordinator.block(
              record.id,
              fresh.reason ?? "waiting_for_line",
            );
            continue;
          }
          const packetCurrent = await this.ports.preparation.current(
            record,
            prepared.fingerprint,
          );
          if (this.closed) {
            this.coordinator.block(record.id, "service_stopping");
            break;
          }
          const reservation = this.coordinator.reserve(record.id, {
            sourceCurrent: this.ports.sourceCurrent(record) && packetCurrent,
            lineAvailable: fresh.ready,
            packetFingerprint: prepared.fingerprint,
          });
          if (reservation.replayed || !reservation.grant) continue;
          try {
            const result = await this.ports.delivery.deliver(
              reservation.record,
              reservation.grant,
            );
            this.coordinator.outcome(
              record.id,
              reservation.grant.attemptId,
              result.state,
              result,
            );
          } catch {
            this.coordinator.outcome(
              record.id,
              reservation.grant.attemptId,
              "unknown",
              { reason: "delivery_response_lost" },
            );
          }
        } catch {
          const latest = this.coordinator.get(record.id);
          if (["queued", "preparing", "ready"].includes(latest.state))
            this.coordinator.block(
              record.id,
              "preparation_or_readiness_unavailable",
            );
          // Preserve any already reserved outcome. Never put it back in the queue.
        } finally {
          if (preparationStarted && !this.coordinator.get(record.id).attemptId)
            await this.releasePreparation(record.id);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private async releasePreparation(intentId: string) {
    if (!this.ports.preparation?.release) return;
    try {
      if ((await this.ports.preparation.release(intentId)).confirmed) return;
    } catch {}
    this.coordinator.preparationUnknown(intentId);
  }
  doctor() {
    return {
      ...this.coordinator.doctor(),
      policyCount: this.coordinator.authority
        .list()
        .filter((p) => p.revokedAt === undefined && p.expiresAt > Date.now())
        .length,
      preparationConfigured: !!this.ports.preparation,
      deliveryConfigured: !!this.ports.delivery,
      physicalAcceptance: false,
    };
  }
  async stop(intentId: string) {
    const record = this.coordinator.get(intentId);
    if (["queued", "preparing", "ready"].includes(record.state)) {
      this.coordinator.cancel(intentId, "stop_calling");
      await this.releasePreparation(intentId);
      return this.coordinator.get(intentId);
    }
    if (["dispatching", "connected"].includes(record.state))
      await this.ports.delivery?.stop?.(record);
    return this.coordinator.get(intentId);
  }
  close() {
    this.closed = true;
  }
}
