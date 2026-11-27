import { Store } from "../storage/store.js";
import type { SharedCallbackOwnership } from "../shared-number-contracts.js";
import type { SharedNumber } from "./shared-number.js";

interface Attempt {
  id: string;
  phase:
    | "handoff"
    | "media"
    | "undialed"
    | "requeued"
    | "dial"
    | "active"
    | "cleanup"
    | "restore"
    | "ended"
    | "unknown";
  providerCallId?: string;
  /** Room removals or provider reads that did not settle this attempt. */
  retries?: number;
  retryAt?: number;
}
const attempts = "shared_callback_attempt";
// Unsettled attempts are read again after 1, 2, 4, 8 and 16 s, then every 30 s.
const retryDelay = (retries: number) =>
  Math.min(30_000, 1000 * 2 ** Math.min(retries - 1, 15));

/** One coordinator-owned outbound attempt. Ports must provide observed owner,
 * provider and media evidence. No default adapter and no timer enables dialing.
 * A failure before the dial sent nothing: the room is removed, the slot frees
 * and the callback waits in the queue again. A dial that may have gone out is
 * unknown. It keeps the shared slot, is never retried, and frees the slot only
 * when its provider call is read as terminal and cleaned up. */
export class SharedCallbacks {
  private busy = false;
  constructor(
    private router: SharedNumber,
    private store: Store,
    private ports: {
      ready(): Promise<boolean>;
      acquire(id: string): Promise<void>;
      verify(id: string): Promise<boolean>;
      prepare(callback: SharedCallbackOwnership): Promise<unknown>;
      /** The recipient is the member's number, opened only for this dial. */
      dial(
        callback: SharedCallbackOwnership,
        media: unknown,
        recipient: string,
      ): Promise<{ providerCallId: string }>;
      /** A read for reconciliation passes `activate` false: it never answers. */
      inspect(
        callback: SharedCallbackOwnership,
        providerCallId: string,
        activate?: boolean,
      ): Promise<{ terminal: boolean; cleanupComplete: boolean }>;
      closeMedia(callback: SharedCallbackOwnership): Promise<boolean>;
      restore(id: string): Promise<boolean>;
    },
    private now: () => number = Date.now,
  ) {
    store.db.exec(
      `CREATE INDEX IF NOT EXISTS ${attempts}_phase
       ON entities(kind, json_extract(body, '$.phase'))
       WHERE kind = '${attempts}'`,
    );
    // A restart before the dial sent nothing. From the dial on, it is unknown.
    for (const attempt of this.select(
      "'handoff', 'media', 'dial', 'cleanup', 'restore'",
    )) {
      if (["handoff", "media"].includes(attempt.phase))
        store.put(attempts, { ...attempt, phase: "undialed" });
      else if (["dial", "cleanup", "restore"].includes(attempt.phase)) {
        store.put(attempts, { ...attempt, phase: "unknown" });
        router.callbackUnknown(attempt.id);
      }
    }
  }
  /** Attempts in the given phases, read through the phase index. Ended and
   * requeued attempts are never read again. */
  private select(phases: string) {
    return this.store.db
      .prepare(
        `SELECT body FROM entities WHERE kind = '${attempts}'
         AND json_extract(body, '$.phase') IN (${phases}) ORDER BY rowid`,
      )
      .all()
      .map((row) => JSON.parse(String(row.body)) as Attempt);
  }
  private put(attempt: Attempt) {
    return this.store.put<Attempt>(attempts, attempt);
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      const all = this.select("'active', 'undialed', 'unknown'");
      // Inspect known active calls before allowing any new allocation.
      const active = all.find((a) => a.phase === "active");
      if (active) return await this.inspect(active);
      for (const attempt of all) {
        if (attempt.phase === "undialed") await this.withdraw(attempt);
        else if (attempt.phase === "unknown" && attempt.providerCallId)
          await this.reconcile(attempt);
      }
      await this.claim();
    } finally {
      this.busy = false;
    }
  }
  private async inspect(attempt: Attempt) {
    const callback = this.router.callback(attempt.id);
    const observed = await this.ports
      .inspect(callback, attempt.providerCallId!)
      .catch(() => null);
    if (!observed || !observed.terminal || !observed.cleanupComplete) return;
    try {
      await this.finish(callback, attempt);
    } catch {
      this.put({ ...attempt, phase: "unknown", retries: 0 });
      this.router.callbackUnknown(callback.id);
    }
  }
  /** The provider reported the call terminal and cleaned up: remove its room,
   * restore the incoming route, then free the slot. */
  private async finish(callback: SharedCallbackOwnership, attempt: Attempt) {
    const providerCallId = attempt.providerCallId;
    this.put({ id: callback.id, phase: "cleanup", providerCallId });
    if (!(await this.ports.closeMedia(callback)))
      throw Error("cleanup_unknown");
    this.put({ id: callback.id, phase: "restore", providerCallId });
    if (!(await this.ports.restore(callback.id)))
      throw Error("restore_unknown");
    this.router.callbackClean(callback.id);
    this.put({ id: callback.id, phase: "ended", providerCallId });
  }
  /** A dial that may have gone out, with a provider call ID to read. Nothing
   * is answered, activated or dialed again. An unread, live or uncleaned call
   * keeps the slot. */
  private async reconcile(attempt: Attempt) {
    if ((attempt.retryAt ?? 0) > this.now()) return;
    const callback = this.router.callback(attempt.id);
    try {
      const observed = await this.ports.inspect(
        callback,
        attempt.providerCallId!,
        false,
      );
      if (observed.terminal && observed.cleanupComplete)
        return await this.finish(callback, attempt);
    } catch {
      /* an unread provider or room state keeps the slot */
    }
    const retries = (attempt.retries ?? 0) + 1;
    this.put({
      ...attempt,
      phase: "unknown",
      retries,
      retryAt: this.now() + retryDelay(retries),
    });
  }
  /** No dial was submitted. Remove the room, then free the slot and put the
   * callback back in the queue. A room that may remain keeps the slot. */
  private async withdraw(attempt: Attempt) {
    if ((attempt.retryAt ?? 0) > this.now()) return;
    const callback = this.router.callback(attempt.id);
    let removed = false;
    try {
      removed = !callback.roomId || (await this.ports.closeMedia(callback));
    } catch {
      /* retried below; the slot stays held */
    }
    if (removed) {
      try {
        this.router.callbackUndialed(callback.id);
        this.put({ id: callback.id, phase: "requeued" });
        return;
      } catch {
        /* the callback moved on elsewhere; the slot stays held, read later */
      }
    }
    const retries = (attempt.retries ?? 0) + 1;
    this.put({
      ...attempt,
      retries,
      retryAt: this.now() + retryDelay(retries),
    });
  }
  private async claim() {
    if (!this.router.hasQueuedCallback() || !(await this.ports.ready())) return;
    const callback = this.router.claimCallback();
    if (!callback) return;
    let attempt = this.put({ id: callback.id, phase: "handoff" });
    let dialed = false;
    try {
      await this.ports.acquire(callback.id);
      if (!(await this.ports.verify(callback.id))) throw Error("owner_unknown");
      attempt = this.put({ id: callback.id, phase: "media" });
      const media = await this.ports.prepare(callback);
      if (!(await this.ports.verify(callback.id))) throw Error("owner_changed");
      // Recheck the Mac, then mark the dial. From here it may reach the provider.
      this.router.callbackDialing(callback.id);
      const recipient = this.router.callbackRecipient(callback.id);
      dialed = true;
      attempt = this.put({ id: callback.id, phase: "dial" });
      const result = await this.ports.dial(callback, media, recipient);
      // Save the returned identity before binding it to a voice worker.
      attempt = this.put({
        id: callback.id,
        phase: "dial",
        providerCallId: result.providerCallId,
      });
      this.router.bindCallback(callback.id, result.providerCallId);
      this.put({ ...attempt, phase: "active" });
    } catch {
      if (!dialed) {
        await this.withdraw(this.put({ id: callback.id, phase: "undialed" }));
        return;
      }
      this.put({ ...attempt, phase: "unknown" });
      this.router.callbackUnknown(callback.id);
    }
  }
}
