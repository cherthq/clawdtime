import { DomainError, hash, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
export type ProactiveTransportEffect =
  | "handoff"
  | "media_allocate"
  | "media_prepare"
  | "dial"
  | "end"
  | "views_close"
  | "media_close"
  | "restore"
  | "session_release"
  | "room_create"
  | "room_delete"
  | "worker_start"
  | "worker_stop";
export interface ProactiveTransportReceipt {
  id: string;
  intentId: string;
  attemptId: string;
  effect: ProactiveTransportEffect;
  state: "running" | "done" | "unknown";
  startedAt: number;
  updatedAt: number;
  providerCallId?: string;
  evidence?: string;
}
/** Durable, encrypted effect boundaries contain identities and receipts, never room
 * credentials or pixels. A pending effect after restart cannot be submitted again. */
export class ProactiveTransportLedger {
  private records: ProtectedTaskStore<ProactiveTransportReceipt>;
  constructor(
    private readonly store: Store,
    vault: Vault,
    private readonly clock: () => number = Date.now,
  ) {
    this.records = new ProtectedTaskStore(
      store,
      vault,
      "proactive-transport-effect-v1",
    );
    store.transaction(() => {
      for (const record of this.records.all())
        if (record.state === "running")
          this.records.put({
            ...record,
            state: "unknown",
            updatedAt: this.clock(),
            evidence: "restart_during_effect",
          });
    });
  }
  get(attemptId: string, effect: ProactiveTransportEffect) {
    return this.records.get(hash(JSON.stringify([attemptId, effect])));
  }
  list(attemptId?: string) {
    return this.records
      .all()
      .filter(
        (record) => attemptId === undefined || record.attemptId === attemptId,
      );
  }
  reserve(
    intentId: string,
    attemptId: string,
    effect: ProactiveTransportEffect,
  ) {
    return this.store.transaction(() => {
      if (this.get(attemptId, effect))
        throw new DomainError(
          409,
          "External effect already has a receipt; never blindly retry.",
        );
      const now = this.clock();
      return this.records.put({
        id: hash(JSON.stringify([attemptId, effect])),
        intentId,
        attemptId,
        effect,
        state: "running",
        startedAt: now,
        updatedAt: now,
      });
    });
  }
  settle(
    attemptId: string,
    effect: ProactiveTransportEffect,
    input: { providerCallId?: string; evidence: string },
  ) {
    return this.store.transaction(() => {
      const record = this.get(attemptId, effect);
      if (
        !record ||
        record.state === "done" ||
        !/^[a-zA-Z0-9_:-]{1,200}$/.test(input.evidence) ||
        (input.providerCallId &&
          !/^[a-zA-Z0-9_-]{1,200}$/.test(input.providerCallId))
      )
        throw new DomainError(
          409,
          "Exact running effect and bounded receipt required.",
        );
      return this.records.put({
        ...record,
        ...input,
        state: "done",
        updatedAt: this.clock(),
      });
    });
  }
  unknown(attemptId: string, effect: ProactiveTransportEffect) {
    return this.store.transaction(() => {
      const record = this.get(attemptId, effect);
      if (!record) throw new DomainError(409, "Effect was not reserved.");
      if (record.state !== "running") return record;
      return this.records.put({
        ...record,
        state: "unknown",
        updatedAt: this.clock(),
        evidence: "response_or_effect_unknown",
      });
    });
  }
}
