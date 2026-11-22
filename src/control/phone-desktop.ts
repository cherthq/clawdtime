import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { NavigationIntent } from "../../connectors/computer/navigation.js";
import { DomainError, hash } from "../storage/security.js";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutorPort,
} from "./desktop-executor.js";

const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const words = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value.trim().length > 0);
const blocked = new Set([
  "running",
  "waiting_for_person",
  "stopping",
  "uncertain",
]);
type Result = { message: string };
type NativeExecution = DesktopExecutorPort & {
  submitRead?(
    id: string,
    text: string,
    reading: NavigationIntent,
    authority?: Parameters<DesktopExecutorPort["submit"]>[2],
  ): Promise<Result>;
  answer?(text: string): Promise<Result>;
  clear?(): Result;
};
interface Receipt {
  fingerprint: string;
  result: Promise<unknown>;
}
interface Call {
  id: string;
  closed: boolean;
  uncertain: boolean;
  generation: number;
  expiresAt: number;
  pending?: string;
  owned: Set<string>;
  requests: Map<string, Receipt>;
}
export interface PhoneDesktopContext {
  callId: string;
  requestId: string;
  text: string;
  /** Recheck immediately before a supervisor effect after any model await. */
  isLive(): boolean;
}
interface Context extends Omit<PhoneDesktopContext, "isLive"> {
  call: Call;
  finished: boolean;
  generation: number;
  submitted?: { fingerprint: string; result: Promise<Result> };
  answered?: Promise<Result>;
}
export interface PhoneDesktopOptions {
  now?: () => number;
  leaseMs?: number;
  maxCalls?: number;
  maxRequestsPerCall?: number;
}

/**
 * Scopes the panel's native worker to an authenticated phone conversation.
 * Routes must authenticate the caller and bind every operation to the current
 * desktop service instance. Reconnecting an old call after restart is forbidden.
 * Call leases/receipts are process-local; the worker's durable journal retains
 * running/uncertain input across restart. This adapter never clears that journal.
 * Jobs run outside this port and may continue after a call ends.
 */
export class PhoneDesktop {
  readonly execution: NativeExecution;
  private readonly contexts = new AsyncLocalStorage<Context>();
  private readonly calls = new Map<string, Call>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxCalls: number;
  private readonly maxRequests: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly runtime: NativeExecution,
    options: PhoneDesktopOptions = {},
  ) {
    if (runtime.snapshot().mode !== "native")
      throw new DomainError(409, "phone_native_worker_required");
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxCalls = options.maxCalls ?? 256;
    this.maxRequests = options.maxRequestsPerCall ?? 512;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1000 ||
      this.leaseMs > 60_000
    )
      throw new Error("Invalid phone lease duration.");
    this.execution = {
      snapshot: () => this.snapshot(),
      submit: (id, text, authority) => {
        const context = this.contexts.getStore();
        return context
          ? this.submit(context, text)
          : this.runtime.submit(id, text, authority);
      },
      stop: () => {
        const context = this.contexts.getStore();
        if (!context) return this.runtime.stop();
        this.live(context);
        this.stopOwned(context.call);
        return this.snapshot();
      },
      ...(runtime.submitRead
        ? {
            submitRead: (
              id: string,
              text: string,
              reading: NavigationIntent,
              authority?: Parameters<DesktopExecutorPort["submit"]>[2],
            ) => {
              const context = this.contexts.getStore();
              return context
                ? this.submit(context, text, reading)
                : runtime.submitRead!(id, text, reading, authority);
            },
          }
        : {}),
      ...(runtime.answer
        ? {
            answer: (text: string) => {
              const context = this.contexts.getStore();
              if (!context) return runtime.answer!(text);
              this.live(context);
              const current = runtime.snapshot();
              if (
                !current.requestId ||
                !context.call.owned.has(current.requestId)
              )
                throw new DomainError(403, "phone_request_not_owned");
              return (context.answered ??= runtime.answer!(text));
            },
          }
        : {}),
      ...(runtime.clear
        ? {
            clear: () => {
              if (this.contexts.getStore())
                throw new DomainError(
                  403,
                  "phone_recovery_requires_local_review",
                );
              return runtime.clear!();
            },
          }
        : {}),
    };
    this.timer = setInterval(() => this.expire(), Math.min(this.leaseMs, 1000));
    this.timer.unref();
  }

  currentContext(): PhoneDesktopContext | undefined {
    const context = this.contexts.getStore();
    if (!context) return undefined;
    return {
      callId: context.callId,
      requestId: context.requestId,
      text: context.text,
      isLive: () => {
        this.expire();
        return (
          !context.finished &&
          !context.call.closed &&
          !context.call.uncertain &&
          context.generation === context.call.generation
        );
      },
    };
  }

  private get(callId: string): Call {
    identity.parse(callId);
    this.expire();
    const call = this.calls.get(callId);
    if (!call || call.closed) throw new DomainError(403, "phone_call_expired");
    return call;
  }

  open(callId: string) {
    identity.parse(callId);
    this.expire();
    const previous = this.calls.get(callId);
    if (previous?.closed) throw new DomainError(409, "phone_call_closed");
    if (previous) return { ok: true as const, expiresAt: previous.expiresAt };
    if ([...this.calls.values()].some((call) => !call.closed))
      throw new DomainError(409, "phone_call_in_use");
    // Keep closed IDs for this process lifetime. Never evict them and reopen a
    // used call; bounded capacity instead requires a deliberate idle restart.
    if (this.calls.size >= this.maxCalls)
      throw new DomainError(429, "phone_call_capacity");
    const call: Call = {
      id: callId,
      closed: false,
      uncertain: false,
      generation: 0,
      expiresAt: this.now() + this.leaseMs,
      owned: new Set(),
      requests: new Map(),
    };
    this.calls.set(callId, call);
    return { ok: true as const, expiresAt: call.expiresAt };
  }

  renew(callId: string) {
    const call = this.get(callId);
    call.expiresAt = this.now() + this.leaseMs;
    return { ok: true as const, expiresAt: call.expiresAt };
  }

  close(callId: string) {
    identity.parse(callId);
    const call = this.calls.get(callId);
    if (!call) throw new DomainError(403, "phone_call_expired");
    this.end(call);
    return { ok: true as const };
  }

  /** A reduction bypasses pending/uncertain conversation work, but never owns a local request. */
  stop(callId: string) {
    const call = this.get(callId);
    call.generation++;
    const current = this.runtime.snapshot();
    const owned =
      !!current.requestId &&
      call.owned.has(current.requestId) &&
      current.canStop;
    this.stopOwned(call);
    return {
      ok: true as const,
      reply: {
        text: owned
          ? "Stop requested for this call's computer work. Coding jobs may continue."
          : "No computer work owned by this call is running. Coding jobs may continue.",
      },
    };
  }

  expire() {
    for (const call of this.calls.values())
      if (!call.closed && call.expiresAt <= this.now()) this.end(call);
  }

  shutdown() {
    clearInterval(this.timer);
    for (const call of this.calls.values()) this.end(call);
  }

  private end(call: Call) {
    if (call.closed) return;
    call.closed = true;
    this.stopOwned(call);
  }

  private stopOwned(call: Call) {
    const current = this.runtime.snapshot();
    if (
      current.requestId &&
      call.owned.has(current.requestId) &&
      current.canStop
    )
      this.runtime.stop();
  }

  private live(context: Context) {
    this.expire();
    if (context.finished || context.call.closed)
      throw new DomainError(403, "phone_call_expired");
    if (context.call.uncertain)
      throw new DomainError(409, "phone_request_uncertain");
    if (context.generation !== context.call.generation)
      throw new DomainError(409, "phone_request_cancelled");
  }

  private snapshot(): DesktopExecutionSnapshot {
    this.expire();
    const context = this.contexts.getStore();
    const current = this.runtime.snapshot();
    if (!context) return current;
    this.live(context);
    return {
      ...current,
      canStop:
        current.canStop &&
        !!current.requestId &&
        context.call.owned.has(current.requestId),
    };
  }

  private submit(
    context: Context,
    text: string,
    reading?: NavigationIntent,
  ): Promise<Result> {
    this.live(context);
    if (words.parse(text) !== context.text)
      throw new DomainError(409, "phone_request_text_changed");
    const fingerprint = hash(JSON.stringify([context.text, reading ?? null]));
    if (context.submitted) {
      if (context.submitted.fingerprint !== fingerprint)
        throw new DomainError(409, "phone_execution_conflict");
      return context.submitted.result;
    }
    const current = this.runtime.snapshot();
    if (current.canStop || blocked.has(current.state))
      return Promise.resolve({ message: current.message });
    const id = `phone_${hash(JSON.stringify([context.callId, context.requestId]))}`;
    context.call.owned.add(id);
    // Native worker submit installs its journal/current request synchronously.
    // The final check also stops that exact request if an async adapter returned
    // after expiry. No unrelated request is stopped, including a later local run.
    const result = Promise.resolve()
      .then(() => {
        this.live(context);
        const authority = {
          callId: context.callId,
          toolCallId: context.requestId,
          isLive: () =>
            !context.call.closed &&
            !context.call.uncertain &&
            context.generation === context.call.generation &&
            this.now() < context.call.expiresAt,
        };
        return reading && this.runtime.submitRead
          ? this.runtime.submitRead(id, context.text, reading, authority)
          : this.runtime.submit(id, context.text, authority);
      })
      .finally(() => {
        if (
          context.call.closed ||
          context.call.uncertain ||
          context.generation !== context.call.generation ||
          this.now() >= context.call.expiresAt
        )
          this.stopOwned(context.call);
      });
    context.submitted = { fingerprint, result };
    return result;
  }

  run<T>(
    callId: string,
    requestId: string,
    text: string,
    callback: () => Promise<T>,
    signature?: unknown,
  ): Promise<T> {
    const call = this.get(callId);
    identity.parse(requestId);
    const original = words.parse(text);
    const fingerprint = hash(JSON.stringify([original, signature ?? null]));
    const previous = call.requests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError(409, "phone_request_conflict");
      return previous.result as Promise<T>;
    }
    if (call.uncertain) throw new DomainError(409, "phone_request_uncertain");
    if (call.pending) throw new DomainError(409, "phone_request_in_progress");
    if (call.requests.size >= this.maxRequests)
      throw new DomainError(429, "phone_request_capacity");
    const context: Context = {
      call,
      callId,
      requestId,
      text: original,
      finished: false,
      generation: call.generation,
    };
    call.pending = requestId;
    const result = Promise.resolve().then(() =>
      this.contexts.run(context, async () => {
        try {
          this.live(context);
          const answer = await callback();
          if (context.generation !== call.generation)
            throw new DomainError(409, "phone_request_cancelled");
          return answer;
        } catch {
          if (context.generation !== call.generation && !call.uncertain)
            throw new DomainError(409, "phone_request_cancelled");
          call.uncertain = true;
          this.stopOwned(call);
          throw new DomainError(409, "phone_request_uncertain");
        } finally {
          context.finished = true;
          if (call.pending === requestId) call.pending = undefined;
        }
      }),
    );
    // Reserve before callback invocation. Rejections remain cached and cannot
    // trigger another supervisor call; attach a handler even if a client leaves.
    call.requests.set(requestId, { fingerprint, result });
    void result.catch(() => {});
    return result;
  }
}
