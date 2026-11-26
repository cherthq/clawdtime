import { SharedNumber } from "./shared-number.js";
import { Store } from "../storage/store.js";
import { DomainError, hash } from "../storage/security.js";
import { routingId } from "../shared-number-contracts.js";
import {
  sharedOperationSchema,
  sharedResultSchema,
  type SharedCommand,
  type SharedOperation,
  type SharedResult,
} from "../shared-relay-contracts.js";

interface Receipt {
  id: string;
  callId: string;
  connectionId: string;
  fingerprint: string;
  state: "pending" | "delivered" | "returned" | "unknown";
}
interface Pending {
  command: SharedCommand;
  grantId: string;
  fingerprint: string;
  promise: Promise<SharedResult>;
  resolve(result: SharedResult): void;
  timer: ReturnType<typeof setTimeout>;
  delivered: boolean;
}
const unknown: SharedResult = { ok: false, code: "outcome_unknown" };

/** Outbound HTTPS long polling. Text and replies exist only in memory.
 * Durable claim-before-delivery receipts prevent replay after a crash or a
 * lost poll response. A fresh device connection never inherits queued input. */
export class SharedNumberRelay {
  private pending = new Map<string, Pending>();
  private polling = new Set<string>();
  private wake = new Map<string, () => void>();
  constructor(
    private router: SharedNumber,
    private store: Store,
    private now = Date.now,
    private timeoutMs = 120_000,
  ) {
    for (const receipt of store.all<Receipt>("shared_relay"))
      if (receipt.state === "pending" || receipt.state === "delivered")
        store.put("shared_relay", { ...receipt, state: "unknown" });
  }
  dispatch(
    callId: string,
    grantId: string,
    requestId: string,
    raw: SharedOperation,
  ) {
    routingId.parse(requestId);
    const operation = sharedOperationSchema.parse(raw);
    const call = this.router.authorizeCall(
      callId,
      grantId,
      operation.action === "chat" ? "control" : "view",
    );
    const id = `relay_${hash(JSON.stringify([callId, requestId]))}`;
    const fingerprint = hash(JSON.stringify([grantId, operation]));
    const old = this.store.get<Receipt>("shared_relay", id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new DomainError(409, "relay_conflict");
      return this.pending.get(id)?.promise ?? Promise.resolve(unknown);
    }
    if (this.pending.size >= 256) throw new DomainError(429, "relay_capacity");
    const scope = call.scope!;
    const command: SharedCommand = {
      id,
      callId,
      connectionId: scope.connectionId,
      instanceId: scope.desktopInstanceId,
      deviceId: scope.deviceId,
      expiresAt: Math.min(
        call.authorizationExpiresAt!,
        this.now() +
          Math.min(
            this.timeoutMs,
            operation.action === "chat" ? 120_000 : 8000,
          ),
      ),
      operation,
    };
    if (operation.action === "walkthrough")
      command.walkthrough = this.router.walkthrough(callId, grantId);
    if (operation.action === "chat")
      this.router.createTask(callId, grantId, {
        taskId: id,
        userTurnId: operation.requestId,
        requestDigest: hash(JSON.stringify(operation)),
      });
    this.store.put<Receipt>("shared_relay", {
      id,
      callId,
      connectionId: scope.connectionId,
      fingerprint,
      state: "pending",
    });
    let resolve!: (result: SharedResult) => void;
    const promise = new Promise<SharedResult>((done) => {
      resolve = done;
    });
    const delivery = { promise, resolve };
    const timer = setTimeout(
      () => this.finish(id, unknown, "unknown"),
      Math.max(1, command.expiresAt - this.now()),
    );
    timer.unref();
    this.pending.set(id, {
      command,
      grantId,
      fingerprint,
      ...delivery,
      timer,
      delivered: false,
    });
    this.wake.get(scope.connectionId)?.();
    return delivery.promise;
  }
  private next(credential: string, connectionId: string) {
    const device = this.router.deviceConnection(credential, connectionId);
    for (const [id, item] of this.pending) {
      if (item.command.connectionId !== connectionId || item.delivered)
        continue;
      try {
        const call = this.router.authorizeCall(
          item.command.callId,
          item.grantId,
          item.command.operation.action === "chat" ? "control" : "view",
        );
        if (
          call.scope?.deviceId !== device.deviceId ||
          item.command.expiresAt <= this.now()
        )
          throw new Error("stale");
      } catch {
        this.finish(id, unknown, "unknown");
        continue;
      }
      const receipt = this.store.get<Receipt>("shared_relay", id)!;
      // Claim before returning bytes. A lost HTTP response remains unknown.
      this.store.put("shared_relay", { ...receipt, state: "delivered" });
      item.delivered = true;
      return item.command;
    }
    return null;
  }
  async poll(credential: string, connectionId: string, signal?: AbortSignal) {
    this.router.deviceConnection(credential, connectionId);
    if (this.polling.has(connectionId))
      throw new DomainError(409, "poll_already_active");
    this.polling.add(connectionId);
    try {
      const immediate = this.next(credential, connectionId);
      if (immediate) return immediate;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          this.wake.delete(connectionId);
          resolve();
        };
        timer = setTimeout(done, 10_000);
        this.wake.set(connectionId, done);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
      if (signal?.aborted) return null;
      return this.next(credential, connectionId);
    } finally {
      this.polling.delete(connectionId);
    }
  }
  respond(credential: string, connectionId: string, id: string, raw: unknown) {
    const device = this.router.deviceConnection(credential, connectionId);
    const item = this.pending.get(id);
    if (
      !item ||
      !item.delivered ||
      item.command.connectionId !== connectionId ||
      item.command.deviceId !== device.deviceId ||
      item.command.expiresAt <= this.now()
    )
      throw new DomainError(409, "relay_response_stale");
    this.router.authorizeCall(
      item.command.callId,
      item.grantId,
      item.command.operation.action === "chat" ? "control" : "view",
    );
    const result = sharedResultSchema.parse(raw);
    if (item.command.operation.action === "chat" && result.ok)
      result.taskId = item.command.id;
    if (
      result.frame &&
      (item.command.operation.action !== "frame" ||
        result.frame.capturedAt > this.now() + 500 ||
        this.now() - result.frame.capturedAt > 1500)
    )
      throw new DomainError(409, "shared_frame_stale");
    this.finish(id, result, "returned");
  }
  private finish(id: string, result: SharedResult, state: Receipt["state"]) {
    const item = this.pending.get(id);
    if (!item) return;
    const receipt = this.store.get<Receipt>("shared_relay", id)!;
    this.store.put("shared_relay", { ...receipt, state });
    this.pending.delete(id);
    clearTimeout(item.timer);
    item.resolve(result);
  }
  close() {
    for (const id of this.pending.keys()) this.finish(id, unknown, "unknown");
    for (const wake of [...this.wake.values()]) wake();
  }
}
