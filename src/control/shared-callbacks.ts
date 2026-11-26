import { Store } from "../storage/store.js";
import type { SharedCallbackOwnership } from "../shared-number-contracts.js";
import type { SharedNumber } from "./shared-number.js";

interface Attempt {
  id: string;
  phase:
    | "handoff"
    | "media"
    | "dial"
    | "active"
    | "cleanup"
    | "restore"
    | "ended"
    | "unknown";
  providerCallId?: string;
}
/** One coordinator-owned outbound attempt. Ports must provide observed owner,
 * provider and media evidence. No default adapter and no timer enables dialing.
 * Unknown outcomes retain the shared slot and are never automatically retried. */
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
      dial(
        callback: SharedCallbackOwnership,
        media: unknown,
      ): Promise<{ providerCallId: string }>;
      inspect(
        callback: SharedCallbackOwnership,
        providerCallId: string,
      ): Promise<{ terminal: boolean; cleanupComplete: boolean }>;
      closeMedia(callback: SharedCallbackOwnership): Promise<boolean>;
      restore(id: string): Promise<boolean>;
    },
  ) {
    for (const attempt of store.all<Attempt>("shared_callback_attempt")) {
      if (!["active", "ended", "unknown"].includes(attempt.phase)) {
        store.put("shared_callback_attempt", { ...attempt, phase: "unknown" });
        router.callbackUnknown(attempt.id);
      }
    }
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    let callback: SharedCallbackOwnership | null = null;
    let attempt: Attempt | undefined;
    const phase = (
      value: Attempt["phase"],
      providerCallId = attempt?.providerCallId,
    ) => {
      attempt = this.store.put<Attempt>("shared_callback_attempt", {
        id: callback!.id,
        phase: value,
        ...(providerCallId ? { providerCallId } : {}),
      });
    };
    try {
      // Inspect known active calls before allowing any new allocation.
      attempt = this.store
        .all<Attempt>("shared_callback_attempt")
        .find((a) => a.phase === "active");
      if (attempt) {
        callback = this.router.callback(attempt.id);
        const observed = await this.ports
          .inspect(callback, attempt.providerCallId!)
          .catch(() => null);
        if (!observed) return;
        if (!observed.terminal || !observed.cleanupComplete) return;
        phase("cleanup");
        if (!(await this.ports.closeMedia(callback)))
          throw Error("cleanup_unknown");
        phase("restore");
        if (!(await this.ports.restore(callback.id)))
          throw Error("restore_unknown");
        this.router.callbackClean(callback.id);
        phase("ended");
        return;
      }
      if (!this.router.hasQueuedCallback() || !(await this.ports.ready()))
        return;
      callback = this.router.claimCallback();
      if (!callback) return;
      phase("handoff");
      await this.ports.acquire(callback.id);
      if (!(await this.ports.verify(callback.id))) throw Error("owner_unknown");
      phase("media");
      const media = await this.ports.prepare(callback);
      if (!(await this.ports.verify(callback.id))) throw Error("owner_changed");
      this.router.callbackDialing(callback.id);
      phase("dial");
      const result = await this.ports.dial(callback, media);
      // Save the returned identity before binding it to a voice worker.
      phase("dial", result.providerCallId);
      this.router.bindCallback(callback.id, result.providerCallId);
      phase("active");
    } catch {
      if (callback) {
        phase("unknown");
        this.router.callbackUnknown(callback.id);
      }
    } finally {
      this.busy = false;
    }
  }
}
