import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProtectedTaskStore } from "../storage/task-store.js";
import { DomainError, hash, type Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import type {
  DesktopExecutionSnapshot,
  DesktopExecutorPort,
  DesktopExecutionAuthority,
} from "./desktop-executor.js";

import type { BackgroundPresentationPort } from "./background-preview.js";
import { BackgroundRecovery } from "./background-recovery.js";

const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
type State =
  "queued" | "running" | "blocked" | "completed" | "canceled" | "uncertain";
export interface BackgroundActionReceipt {
  id: string;
  fingerprint: string;
  operation?: "qualified_launch" | "codex_new_chat_navigation" | "other";
  applicationBundleId?: "com.openai.codex" | "com.apple.MobileSMS";
  state: "reserved" | "returned" | "verified" | "not_started" | "unknown";
}
export interface BackgroundTaskRecord {
  id: string;
  fingerprint: string;
  goal: string;
  state: State;
  sessionId: string;
  expiresAt: number;
  message: string;
  actions: BackgroundActionReceipt[];
}

/** Called only on trusted worker reservations, never on model text. */
function classifyBackgroundAction(action: unknown): BackgroundActionReceipt["operation"] {
  if (!action || typeof action !== "object") return "other";
  const a = action as { workflow?: unknown; operation?: unknown; bundleId?: unknown; action?: { type?: unknown }; binding?: { bundleId?: unknown } };
  if (a.operation === "launch_app" &&
      ((a.workflow === "codex-draft" && a.bundleId === "com.openai.codex") ||
       (a.workflow === "messages-read" && a.bundleId === "com.apple.MobileSMS"))) return "qualified_launch";
  if (a.workflow === "codex-draft" && a.operation === "codex_new_chat_navigation" &&
      a.binding?.bundleId === "com.openai.codex" && a.action?.type === "click-element") return "codex_new_chat_navigation";
  return "other";
}
function actionApplication(action: unknown): BackgroundActionReceipt["applicationBundleId"] {
  if (!action || typeof action !== "object") return undefined;
  const a = action as { bundleId?: unknown; binding?: { bundleId?: unknown } };
  const bundle = a.bundleId ?? a.binding?.bundleId;
  return bundle === "com.openai.codex" || bundle === "com.apple.MobileSMS" ? bundle : undefined;
}

const terminal = new Set<State>(["blocked", "completed", "canceled"]);
export interface BackgroundTaskContext {
  callId: string;
  toolCallId: string;
  isLive(): boolean;
  taskId: string;
  sessionId: string;
  expiresAt: number;
  /** Reserve encrypted identity before the shared helper reservation and driver call. */
  reserve(action: unknown): string;
  /** Only authoritative adapter evidence that no input began may use not_started. */
  returned(id: string, dispatch: "returned" | "not_started" | "unknown"): void;
  /** Requires fresh independent postcondition AND confirmed driver call completion. */
  verified(id: string): void;
}
export interface BackgroundTaskWorker extends Partial<BackgroundPresentationPort> {
  run(
    goal: string,
    context: BackgroundTaskContext,
    signal: AbortSignal,
  ): Promise<{ verified: boolean; summary: string }>;
  /** Stop admission immediately; no claim that an OS event already sent is canceled. */
  stop(): void;
  /** Keep shared unresolved-input fence until exact driver session quiescence. */
  close(): Promise<{ quiescence: "known" | "unknown" }>;
}

/** Separate window-scoped runtime. It never uses the foreground/native action schema. */
export class BackgroundRuntime implements DesktopExecutorPort {
  private records: ProtectedTaskStore<BackgroundTaskRecord>;
  private recovery: BackgroundRecovery;
  private flight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private worker: BackgroundTaskWorker | undefined;
  private currentId: string | undefined;
  private closed = false;
  constructor(
    store: Store,
    vault: Vault,
    private createWorker: () => BackgroundTaskWorker,
    private timeoutMs = 120000,
    private notify: (text: string) => void = () => {},
    private now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 300000
    )
      throw Error("Invalid background task duration");
    this.records = new ProtectedTaskStore(
      store,
      vault,
      "background-cua-task-v1",
    );
    this.recovery = new BackgroundRecovery(store, vault);
    for (const record of this.records.all())
      if (!terminal.has(record.state) && record.state !== "uncertain")
        this.records.put({
          ...record,
          state: "uncertain",
          actions: record.actions.map((a) =>
            ["reserved", "returned"].includes(a.state)
              ? { ...a, state: "unknown" }
              : a,
          ),
          message:
            "Background work was interrupted. Its original receipt remains unresolved; it will not be repeated.",
        });
  }
  async preview(callId: string, taskId: string) {
    if (
      this.closed ||
      this.currentId !== taskId ||
      this.snapshot(taskId).state !== "running"
    )
      return null;
    const worker = this.worker;
    const result = await worker?.preview?.(callId, taskId);
    if (
      this.closed ||
      this.worker !== worker ||
      this.currentId !== taskId ||
      this.snapshot(taskId).state !== "running" ||
      !result?.valid()
    )
      return null;
    return result;
  }
  overview(callId: string, taskId: string, enabled: boolean) {
    if (
      !this.closed &&
      this.currentId === taskId &&
      this.snapshot(taskId).state === "running"
    )
      this.worker?.overview?.(callId, taskId, enabled);
  }
  private latest() {
    return (
      this.records.all().find((r) => this.blocksAdmission(r)) ??
      this.records.all().at(-1)
    );
  }
  private blocksAdmission(record: BackgroundTaskRecord) {
    return !terminal.has(record.state) && !this.recovery.retired(record);
  }
  snapshot(requestId?: string): DesktopExecutionSnapshot {
    const r = requestId ? this.records.get(requestId) : this.latest();
    return {
      configured: true,
      mode: "background",
      ...(r ? { requestId: r.id } : {}),
      state: r?.state ?? "idle",
      canStop: !!r && !terminal.has(r.state) && r.state !== "uncertain",
      message:
        r && this.recovery.retired(r)
          ? "The original navigation outcome remains unknown and will not be replayed. An operator retired its inactive controller after confirming no text or submission was dispatched."
          : r?.message ??
        "Qualified background workflows are available. Sending and task submission are disabled.",
    };
  }
  async submit(
    id: string,
    goal: string,
    authority?: DesktopExecutionAuthority,
  ) {
    identity.parse(id);
    z.string().trim().min(1).max(2000).parse(goal);
    if (this.closed)
      throw new DomainError(409, "Background runtime is closed.");
    const fingerprint = hash(
        JSON.stringify([goal, authority?.callId, authority?.toolCallId]),
      ),
      old = this.records.get(id);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new DomainError(409, "Background request identity conflicts.");
      return { message: old.message };
    }
    const blocked =
      !authority ||
      !authority.isLive() ||
      !!this.flight ||
      this.records.all().some((r) => this.blocksAdmission(r));
    const r: BackgroundTaskRecord = {
      id,
      fingerprint,
      goal,
      state: blocked ? "blocked" : "queued",
      sessionId: `ClawdTime_${randomUUID()}`,
      expiresAt: this.now() + this.timeoutMs,
      message: blocked
        ? "Background work is pending or unresolved. Inspect the original request before starting more work."
        : "The background task is queued; no app action has completed.",
      actions: [],
    };
    this.records.put(r);
    if (blocked) return { message: r.message };
    this.currentId = id;
    const controller = (this.controller = new AbortController());
    this.flight = Promise.resolve()
      .then(() => this.run(r, controller, authority!))
      .finally(() => {
        this.flight = undefined;
        this.controller = undefined;
        this.currentId = undefined;
        this.worker = undefined;
      });
    return { message: r.message };
  }
  private update(id: string, patch: Partial<BackgroundTaskRecord>) {
    return this.records.put({ ...this.records.get(id)!, ...patch });
  }
  private check(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const r = this.records.get(id)!;
    if (this.closed || this.now() >= r.expiresAt || r.state !== "running")
      throw Error("Background authority ended");
    return r;
  }
  stop() {
    this.controller?.abort();
    this.stopWorker();
    if (this.currentId) {
      const r = this.records.get(this.currentId)!;
      if (!terminal.has(r.state) && r.state !== "uncertain")
        this.update(r.id, {
          state: r.actions.some((a) =>
            ["reserved", "returned", "unknown"].includes(a.state),
          )
            ? "uncertain"
            : "canceled",
          message:
            "Stop requested. Further input is closed; driver cleanup and any outstanding effects still require confirmation.",
        });
    }
    return this.snapshot();
  }
  async waitForIdle() {
    await this.flight;
  }
  async close() {
    this.closed = true;
    this.stop();
    await this.flight;
  }
  private stopWorker() {
    try {
      this.worker?.stop();
    } catch {
      // Abort already closed runtime admission. Only close() may establish
      // quiescence; an exception here must not escape a Stop/timer callback.
    }
  }
  private async run(
    initial: BackgroundTaskRecord,
    controller: AbortController,
    authority: DesktopExecutionAuthority,
  ) {
    const signal = controller.signal;
    let admitting = true;
    const admit = () => {
      if (!admitting || !authority.isLive())
        throw Error("Background task authority ended");
      return this.check(initial.id, signal);
    };
    let state: State = "blocked",
      message = "The background workflow did not establish a verified result.";
    const timer = setTimeout(() => {
      controller.abort();
      this.stopWorker();
    }, this.timeoutMs);
    timer.unref();
    try {
      this.update(initial.id, {
        state: "running",
        message: "Checking the authorized background application and window.",
      });
      admit();
      this.worker = this.createWorker();
      const context: BackgroundTaskContext = {
        callId: authority.callId,
        toolCallId: authority.toolCallId,
        isLive: () =>
          admitting &&
          !signal.aborted &&
          authority.isLive() &&
          this.now() < initial.expiresAt,
        taskId: initial.id,
        sessionId: initial.sessionId,
        expiresAt: initial.expiresAt,
        reserve: (action) => {
          const r = admit();
          if (
            r.actions.some((a) =>
              ["reserved", "returned", "unknown"].includes(a.state),
            )
          )
            throw Error("Previous effect is unresolved");
          const id = `background_${randomUUID()}`;
          this.update(r.id, {
            actions: [
              ...r.actions,
              {
                id,
                fingerprint: hash(JSON.stringify(action)),
                operation: classifyBackgroundAction(action),
                applicationBundleId: actionApplication(action),
                state: "reserved",
              },
            ],
          });
          return id;
        },
        returned: (id, dispatch) => {
          const r = this.records.get(initial.id)!;
          const a = r.actions.find((a) => a.id === id);
          if (!a || a.state !== "reserved")
            throw Error("Invalid effect receipt transition");
          this.update(r.id, {
            actions: r.actions.map((a) =>
              a.id === id
                ? {
                    ...a,
                    state:
                      dispatch === "returned"
                        ? "returned"
                        : dispatch === "not_started"
                          ? "not_started"
                          : "unknown",
                  }
                : a,
            ),
          });
        },
        verified: (id) => {
          const r = admit();
          const a = r.actions.find((a) => a.id === id);
          if (!a || a.state !== "returned")
            throw Error("No completed driver call to verify");
          this.update(r.id, {
            actions: r.actions.map((a) =>
              a.id === id ? { ...a, state: "verified" } : a,
            ),
          });
        },
      };
      const result = await this.worker.run(initial.goal, context, signal);
      admit();
      if (result.verified && result.summary.trim()) {
        state = "completed";
        message = result.summary.slice(0, 1600);
      } else message = result.summary.trim().slice(0, 1600) || message;
    } catch {
      state = signal.aborted ? "canceled" : "blocked";
      message = signal.aborted
        ? "Background work stopped. No further actions will run."
        : "The background workflow was blocked by its permissions, target checks, or supported capabilities.";
    } finally {
      admitting = false;
      clearTimeout(timer);
      let quiescent = true;
      this.stopWorker();
      try {
        quiescent =
          !this.worker || (await this.worker.close()).quiescence === "known";
      } catch {
        quiescent = false;
      }
      const r = this.records.get(initial.id)!;
      if (
        !quiescent ||
        r.actions.some((a) =>
          ["reserved", "returned", "unknown"].includes(a.state),
        )
      ) {
        state = "uncertain";
        message =
          "Background input or driver cleanup remains uncertain. The retained receipt and shared interlock prevent replay or another controller taking over.";
      } else if (signal.aborted || r.state === "canceled") {
        state = "canceled";
        message = "Background work stopped. No further input will run.";
      }
      this.update(r.id, {
        state,
        message,
        actions: r.actions.map((a) =>
          ["reserved", "returned"].includes(a.state)
            ? { ...a, state: "unknown" }
            : a,
        ),
      });
      try {
        this.notify(message);
      } catch {
        /* persisted result remains authoritative */
      }
    }
  }
}
