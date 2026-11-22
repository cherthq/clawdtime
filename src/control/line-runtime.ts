import { z } from "zod";
import { DomainError, equal, hash, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutorPort,
} from "./desktop-executor.js";

import type { BackgroundPresentationPort } from "./background-preview.js";

const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
export const lineRuntimeConfigSchema = z
  .object({
    version: z.literal(1),
    token: z.string().min(32).max(256),
  })
  .strict();
export const lineCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), callId: identity }).strict(),
  z.object({ action: z.literal("status"), callId: identity }).strict(),
  z.object({ action: z.literal("stop"), callId: identity }).strict(),
  z.object({ action: z.literal("close"), callId: identity }).strict(),
  z
    .object({
      action: z.literal("overview"),
      callId: identity,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("execute"),
      callId: identity,
      requestId: identity,
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export const sharedLineTokenText =
  "The phone runtime needs a credential of its own. The token in line-runtime.json is the same as the operator, panel or session token: write a new one.";
/**
 * The token of the phone runtime is never one of the other credentials of the
 * service: a phone process must not hold the operator, panel or session
 * capability. Every credential is compared, each in constant time, so the
 * check does not tell which one was the same.
 */
export function assertSeparateLineToken(
  lineToken: string,
  others: readonly (string | undefined)[],
) {
  let shared = false;
  for (const other of others)
    if (other !== undefined && equal(lineToken, other)) shared = true;
  if (shared) throw Error(sharedLineTokenText);
}
interface Call {
  id: string;
  state: "open" | "closed";
  expiresAt: number;
  requestId?: string;
}
interface Receipt {
  id: string;
  callId: string;
  clientRequestId: string;
  fingerprint: string;
  result?: DesktopExecutionSnapshot;
}
interface Runtime
  extends DesktopExecutorPort, Partial<BackgroundPresentationPort> {
  snapshot(requestId?: string): DesktopExecutionSnapshot;
}
const idle = (): DesktopExecutionSnapshot => ({
  configured: true,
  state: "idle",
  canStop: false,
  message:
    "The call is connected to the computer runtime. No computer task has been requested.",
});

/** A separate, local-only capability for the admitted phone process. No panel or shell authority. */
export class LineRuntime {
  private calls: ProtectedTaskStore<Call>;
  private receipts: ProtectedTaskStore<Receipt>;
  constructor(
    store: Store,
    vault: Vault,
    private token: string,
    private runtime: Runtime,
    private now: () => number = Date.now,
  ) {
    lineRuntimeConfigSchema.parse({ version: 1, token });
    this.calls = new ProtectedTaskStore(store, vault, "line-runtime-call-v1");
    this.receipts = new ProtectedTaskStore(
      store,
      vault,
      "line-runtime-request-v1",
    );
    // Process restart never restores a caller's authority or replays its command.
    for (const call of this.calls.all())
      if (call.state === "open") this.end(call);
  }
  private result(
    id?: string,
  ): DesktopExecutionSnapshot & { clientRequestId?: string } {
    if (!id) return idle();
    const receipt = this.receipts.get(id);
    if (receipt?.result)
      return { ...receipt.result, clientRequestId: receipt.clientRequestId };
    const snapshot = this.runtime.snapshot(id);
    return snapshot.requestId === id
      ? { ...snapshot, clientRequestId: receipt?.clientRequestId }
      : {
          configured: true,
          requestId: id,
          clientRequestId: receipt?.clientRequestId,
          state: "uncertain",
          canStop: false,
          message:
            "The request was recorded but execution was not confirmed. It will not be repeated. Inspect the original request locally.",
        };
  }
  private end(call: Call) {
    this.calls.put({ ...call, state: "closed" });
    const current = this.runtime.snapshot();
    if (
      call.requestId &&
      current.requestId === call.requestId &&
      current.canStop
    )
      this.runtime.stop();
  }
  expire() {
    for (const call of this.calls.all())
      if (call.state === "open" && call.expiresAt <= this.now()) this.end(call);
  }
  close() {
    for (const call of this.calls.all())
      if (call.state === "open") this.end(call);
  }
  /**
   * The capability check alone. A route makes it before it reads a body, so a
   * request with no token or a wrong one gets this one refusal, whatever it
   * carries.
   */
  authorize(token: string) {
    if (!equal(this.token, token))
      throw new DomainError(401, "Line runtime authorization required.");
  }
  private authorizeView(token: string, callId: string) {
    this.authorize(token);
    identity.parse(callId);
    this.expire();
    const call = this.calls.get(callId);
    if (!call || call.state !== "open" || !call.requestId)
      throw new DomainError(403, "No active call task.");
    return call.requestId;
  }
  async preview(token: string, callId: string) {
    const taskId = this.authorizeView(token, callId);
    const result = await this.runtime.preview?.(callId, taskId);
    if (this.authorizeView(token, callId) !== taskId)
      throw new DomainError(403, "Call task changed.");
    return result?.valid() ? result : null;
  }
  async command(
    token: string,
    input: unknown,
  ): Promise<DesktopExecutionSnapshot> {
    this.authorize(token);
    const value = lineCommandSchema.parse(input);
    this.expire();
    let call = this.calls.get(value.callId);
    if (value.action === "open") {
      if (call?.state === "closed")
        throw new DomainError(
          409,
          "This call has ended. It cannot be reopened.",
        );
      if (
        this.calls
          .all()
          .some((c) => c.state === "open" && c.id !== value.callId)
      )
        throw new DomainError(409, "Another call owns the phone runtime.");
      call = this.calls.put({
        ...call,
        id: value.callId,
        state: "open",
        expiresAt: this.now() + 30_000,
      });
      return this.result(call.requestId);
    }
    if (!call) throw new DomainError(403, "No admitted call session.");
    if (value.action === "close") {
      this.end(call);
      return this.result(call.requestId);
    }
    if (call.state !== "open")
      throw new DomainError(403, "The call session has ended or expired.");
    this.calls.put({ ...call, expiresAt: this.now() + 30_000 });
    if (value.action === "status") return this.result(call.requestId);
    if (value.action === "overview") {
      if (call.requestId)
        this.runtime.overview?.(call.id, call.requestId, value.enabled);
      return this.result(call.requestId);
    }
    if (value.action === "stop") {
      const current = this.runtime.snapshot();
      if (
        call.requestId &&
        current.requestId === call.requestId &&
        current.canStop
      )
        this.runtime.stop();
      return this.result(call.requestId);
    }
    if (value.action !== "execute" || !("text" in value))
      throw new DomainError(400, "Unknown line command.");
    const id = `line_${hash(JSON.stringify([call.id, value.requestId]))}`;
    const fingerprint = hash(value.text);
    const existing = this.receipts.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new DomainError(409, "Request identity conflicts.");
      return this.result(id);
    }
    // Reserve before the only dispatch. A crash/timeout cannot lead to a replay.
    this.receipts.put({
      id,
      callId: call.id,
      clientRequestId: value.requestId,
      fingerprint,
    });
    const current = this.runtime.snapshot();
    if (
      current.canStop ||
      current.state === "uncertain" ||
      this.receipts
        .all()
        .some((r) => r.id !== id && this.result(r.id).state === "uncertain")
    ) {
      const result = {
        ...idle(),
        requestId: id,
        state: "blocked",
        message:
          "Computer work is pending or unresolved. Inspect or stop the original task before requesting new work.",
      };
      this.receipts.put({
        id,
        callId: call.id,
        clientRequestId: value.requestId,
        fingerprint,
        result,
      });
      return this.result(id);
    }
    this.calls.put({ ...call, expiresAt: this.now() + 30_000, requestId: id });
    try {
      await this.runtime.submit(id, value.text, {
        callId: call.id,
        toolCallId: value.requestId,
        isLive: () => {
          const current = this.calls.get(value.callId);
          return (
            current?.state === "open" &&
            current.requestId === id &&
            current.expiresAt > this.now()
          );
        },
      });
    } catch {
      /* Keep the reserved identity; failure is not proof nothing ran. */
    }
    return this.result(id);
  }
}
