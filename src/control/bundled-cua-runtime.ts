import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hash, DomainError } from "../storage/security.js";
import type { Vault } from "../storage/security.js";
import type { Store } from "../storage/store.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import type {
  DesktopExecutorPort,
  DesktopExecutionSnapshot,
} from "./desktop-executor.js";
import {
  CuaInputNotDispatched,
  CuaSetupRequired,
  bundledCuaConfigSchema,
  cuaPlanSchema,
  type BundledCuaConfig,
  type CuaAction,
  type CuaDevice,
  type CuaObservation,
  type CuaPlanner,
} from "./cua-contracts.js";

type State =
  | "queued"
  | "running"
  | "pending_approval"
  | "completed"
  | "blocked"
  | "canceled"
  | "uncertain";
interface ActionReceipt {
  id: string;
  action: CuaAction;
  state: "reserved" | "submitted" | "observed_after" | "unknown" | "rejected";
  fingerprint: string;
}
interface TaskRecord {
  id: string;
  fingerprint: string;
  goal: string;
  sessionId: string;
  state: State;
  createdAt: number;
  expiresAt: number;
  steps: number;
  message: string;
  pendingAction?: { id: string; description: string };
  actions: ActionReceipt[];
}
const terminal = new Set<State>(["completed", "blocked", "canceled"]);
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const description = (action: CuaAction, observation: CuaObservation) => {
  if (action.type === "activate") {
    const windows = JSON.parse(observation.context).windows?.windows;
    const window = Array.isArray(windows)
      ? windows.find((value) => value.id === action.targetId)
      : undefined;
    const clean = (value: unknown, limit: number) =>
      typeof value === "string"
        ? value
            .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ")
            .slice(0, limit)
        : "";
    return `Bring the existing window ${JSON.stringify(clean(window?.title, 160))} in ${JSON.stringify(clean(window?.app, 80))} to the front. Window ID: ${action.targetId}`;
  }
  return action.type === "type"
    ? `Type this exact text into the currently focused control: ${action.text}`
    : action.type === "click"
      ? `Click the current surface at ${Math.round(action.x * 100)}% across and ${Math.round(action.y * 100)}% down.`
      : `Scroll the current surface by ${action.deltaY} at ${Math.round(action.x * 100)}%, ${Math.round(action.y * 100)}%.`;
};

/** App-owned sequential runtime. No Codex chat, daemon, MCP host or queue subprocess. */
export class BundledCuaRuntime implements DesktopExecutorPort {
  private records: ProtectedTaskStore<TaskRecord>;
  private flight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private currentId: string | undefined;
  private dispatching = false;
  private closed = false;
  private approval:
    { id: string; resolve: (allowed: boolean) => void } | undefined;
  constructor(
    store: Store,
    vault: Vault,
    private config: BundledCuaConfig,
    private planner: CuaPlanner,
    private createDevice: () => CuaDevice,
    private notify: (text: string) => void = () => {},
    private now: () => number = Date.now,
  ) {
    this.config = bundledCuaConfigSchema.parse(config);
    this.records = new ProtectedTaskStore(store, vault, "bundled-cua-task-v1");
    for (const record of this.records.all())
      if (!terminal.has(record.state) && record.state !== "uncertain") {
        this.records.put({
          ...record,
          state: "uncertain",
          pendingAction: undefined,
          actions: record.actions.map((a) =>
            a.state === "reserved" || a.state === "submitted"
              ? { ...a, state: "unknown" }
              : a,
          ),
          message:
            "The computer runtime restarted before confirmation. The original work is retained and will not be repeated. Reconcile it before starting more work.",
        });
      }
  }
  private latest() {
    return (
      this.records.all().find((r) => !terminal.has(r.state)) ??
      this.records.all().at(-1)
    );
  }
  snapshot(requestId?: string): DesktopExecutionSnapshot {
    const r = requestId ? this.records.get(requestId) : this.latest();
    return {
      ...(r ? { requestId: r.id } : {}),
      configured: true,
      mode: this.config.mode,
      state: r?.state ?? "idle",
      canStop: !!r && !terminal.has(r.state) && r.state !== "uncertain",
      message:
        r?.message ??
        (this.config.mode === "native"
          ? this.config.actionApproval === "automatic"
            ? "Computer tasks run without extra action confirmations. Local control must be enabled. Stop work remains available."
            : "Standalone computer control is configured. Enable the local companion to work in your apps; actions still require approval."
          : this.config.actionApproval === "automatic"
            ? "Browser tasks run without extra action confirmations. Stop work remains available."
            : "ClawdTime's own browser runtime is configured. It does not depend on a coding chat."),
      ...(r?.pendingAction ? { pendingAction: r.pendingAction } : {}),
    };
  }
  async submit(eventId: string, text: string) {
    identity.parse(eventId);
    z.string().trim().min(1).max(2000).parse(text);
    if (this.closed) throw new DomainError(409, "Computer runtime is closed.");
    const fingerprint = hash(JSON.stringify([text, this.config]));
    const existing = this.records.get(eventId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new DomainError(409, "Computer request identity conflicts.");
      return { message: existing.message };
    }
    const record: TaskRecord = {
      id: eventId,
      fingerprint,
      goal: text,
      sessionId: `cua_${randomUUID()}`,
      state: "queued",
      createdAt: this.now(),
      expiresAt: this.now() + this.config.timeoutMs,
      steps: 0,
      actions: [],
      message: "ClawdTime is starting its own computer runtime.",
    };
    if (this.flight || this.records.all().some((r) => !terminal.has(r.state))) {
      // Stop closes admission before asynchronous device cleanup finishes. A
      // request arriving in that interval is definitely not dispatched, but its
      // identity still needs a durable result for phone retries and restarts.
      record.state = "blocked";
      record.message =
        "Computer work is pending or unresolved. Stop or reconcile the original work first.";
      this.records.put(record);
      return { message: record.message };
    }
    this.records.put(record);
    this.currentId = record.id;
    this.controller = new AbortController();
    const controller = this.controller;
    this.flight = Promise.resolve()
      .then(() => this.run(record.id, controller))
      .finally(() => {
        this.flight = undefined;
        this.currentId = undefined;
        this.controller = undefined;
      });
    return { message: record.message };
  }
  private update(id: string, patch: Partial<TaskRecord>) {
    return this.records.put({ ...this.records.get(id)!, ...patch });
  }
  private guard(id: string, signal: AbortSignal) {
    const r = this.records.get(id)!;
    if (
      signal.aborted ||
      this.closed ||
      this.now() >= r.expiresAt ||
      terminal.has(r.state) ||
      r.state === "uncertain"
    )
      throw new Error("cua_authority_ended");
    return r;
  }
  private validObservation(observation: CuaObservation) {
    if (
      !observation.id ||
      !observation.fingerprint ||
      !Number.isFinite(observation.capturedAt) ||
      this.now() - observation.capturedAt > 2000 ||
      observation.capturedAt > this.now() + 1000 ||
      observation.width < 1 ||
      observation.height < 1 ||
      observation.imageDataUrl.length > 12_000_000
    )
      throw Error("cua_stale_observation");
  }
  decision(actionId: string, approve: boolean) {
    identity.parse(actionId);
    const r = this.latest();
    if (
      !r ||
      r.state !== "pending_approval" ||
      r.pendingAction?.id !== actionId ||
      this.approval?.id !== actionId ||
      this.now() >= r.expiresAt
    )
      throw new DomainError(
        409,
        "This exact computer action is no longer awaiting approval.",
      );
    const resolve = this.approval.resolve;
    this.approval = undefined;
    this.update(r.id, {
      pendingAction: undefined,
      state: approve ? "running" : "canceled",
      message: approve
        ? "The exact action was approved; ClawdTime will recheck the current surface before input."
        : "The action was denied. No input was authorized.",
    });
    resolve(approve);
    return this.snapshot();
  }
  stop() {
    if (this.currentId) {
      const r = this.records.get(this.currentId)!;
      if (!terminal.has(r.state) && r.state !== "uncertain")
        this.update(r.id, {
          state: this.dispatching ? "uncertain" : "canceled",
          pendingAction: undefined,
          message: this.dispatching
            ? "Stop requested during input. Its outcome is uncertain; it will not be repeated."
            : "Stop requested. ClawdTime is stopping capture and further actions.",
        });
    }
    this.controller?.abort();
    this.approval?.resolve(false);
    this.approval = undefined;
    return this.snapshot();
  }
  async close() {
    this.closed = true;
    this.stop();
    await this.flight;
  }
  async waitForIdle() {
    await this.flight;
  }
  private async run(id: string, controller: AbortController) {
    const signal = controller.signal;
    let device: CuaDevice | undefined;
    let cleanup: Promise<void> | undefined;
    const stopDevice = () =>
      (cleanup ??= Promise.resolve().then(() => device?.stop()));
    const onAbort = () => {
      void stopDevice().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => {
      controller.abort();
      this.approval?.resolve(false);
      this.approval = undefined;
    }, this.config.timeoutMs);
    deadline.unref();
    let state: State = "blocked",
      message = "Computer work stopped before a verified result.";
    try {
      device = this.createDevice();
      let r = this.guard(id, signal);
      await device.open(
        { taskId: r.id, sessionId: r.sessionId, expiresAt: r.expiresAt },
        signal,
      );
      this.guard(id, signal);
      this.update(id, {
        state: "running",
        message: "ClawdTime is observing the authorized surface.",
      });
      const previousActions: CuaAction[] = [];
      for (let step = 0; step < this.config.maxSteps; step++) {
        r = this.guard(id, signal);
        this.update(id, { steps: step + 1 });
        const observed = await device.observe(signal);
        this.guard(id, signal);
        this.validObservation(observed);
        const plan = cuaPlanSchema.parse(
          await this.planner.plan(
            { goal: r.goal, observation: observed, previousActions },
            signal,
          ),
        );
        this.guard(id, signal);
        if (plan.observationId !== observed.id)
          throw Error("cua_wrong_observation");
        if (plan.kind === "pause") {
          message = plan.reason;
          break;
        }
        const fresh = await device.observe(signal);
        this.guard(id, signal);
        this.validObservation(fresh);
        if (fresh.id === observed.id || fresh.capturedAt < observed.capturedAt)
          throw Error("cua_cached_observation");
        if (plan.kind === "done") {
          const verified = await this.planner.verify(
            { goal: r.goal, observation: fresh, proposedSummary: plan.summary },
            signal,
          );
          this.guard(id, signal);
          if (!verified.verified || !verified.summary.trim()) {
            message =
              "The computer result could not be verified from a fresh observation.";
            break;
          }
          state = "completed";
          message = verified.summary.slice(0, 1600);
          break;
        }
        // Changed pixels require an adapter proof of the original exact target.
        const matchesPlan = async (current: CuaObservation) =>
          (plan.action.type !== "activate" &&
            current.fingerprint === observed.fingerprint) ||
          (device?.revalidate
            ? (await device.revalidate(
                plan.action,
                observed,
                current,
                signal,
              )) === true
            : false);
        const firstMatch = await matchesPlan(fresh);
        this.guard(id, signal);
        if (!firstMatch) continue;
        const permission = await device.authorize(plan.action, fresh);
        this.guard(id, signal);
        if (permission !== "allowed" && permission !== "confirm") {
          message =
            "That action is outside the configured computer permissions.";
          break;
        }
        const actionId = `action_${randomUUID()}`;
        if (
          permission === "confirm" &&
          this.config.actionApproval !== "automatic"
        ) {
          this.update(id, {
            state: "pending_approval",
            pendingAction: {
              id: actionId,
              description: description(plan.action, fresh),
            },
            message:
              "Review the exact computer action, then approve or deny it. No input has been sent.",
          });
          const allowed = await new Promise<boolean>((resolve) => {
            this.approval = { id: actionId, resolve };
          });
          if (!allowed) {
            state = "canceled";
            message =
              "The pending action was stopped or denied; it was not dispatched.";
            break;
          }
          this.guard(id, signal);
        }
        const before = await device.observe(signal);
        this.guard(id, signal);
        this.validObservation(before);
        if (before.id === fresh.id || before.capturedAt < fresh.capturedAt)
          throw Error("cua_cached_observation");
        const finalMatch = await matchesPlan(before);
        this.guard(id, signal);
        if (!finalMatch) {
          message =
            "The surface changed before input. The old action and approval were discarded.";
          break;
        }
        const receipt: ActionReceipt = {
          id: actionId,
          action: plan.action,
          state: "reserved",
          fingerprint: hash(JSON.stringify([plan.action, before.fingerprint])),
        };
        this.update(id, {
          actions: [...this.records.get(id)!.actions, receipt],
          state: "running",
          pendingAction: undefined,
          message: "ClawdTime is performing one authorized computer action.",
        });
        this.guard(id, signal);
        this.dispatching = true;
        let submitted = false;
        try {
          await device.execute(
            { actionId, observationId: before.id, action: plan.action },
            signal,
          );
          submitted = true;
          this.update(id, {
            actions: this.records
              .get(id)!
              .actions.map((a) =>
                a.id === actionId ? { ...a, state: "submitted" } : a,
              ),
          });
          this.guard(id, signal);
          const after = await device.observe(signal);
          this.guard(id, signal);
          this.validObservation(after);
          if (after.id === before.id || after.capturedAt < before.capturedAt)
            throw Error("cua_cached_observation");
          this.update(id, {
            actions: this.records
              .get(id)!
              .actions.map((a) =>
                a.id === actionId ? { ...a, state: "observed_after" } : a,
              ),
          });
          this.dispatching = false;
        } catch (error) {
          const rejected = !submitted && error instanceof CuaInputNotDispatched;
          this.update(id, {
            actions: this.records
              .get(id)!
              .actions.map((a) =>
                a.id === actionId
                  ? { ...a, state: rejected ? "rejected" : "unknown" }
                  : a,
              ),
          });
          if (rejected) this.dispatching = false;
          throw Error("cua_input_uncertain");
        }
        previousActions.push(plan.action);
        if (step + 1 === this.config.maxSteps)
          message =
            "The computer task reached its step limit without a verified result.";
      }
    } catch (error) {
      const r = this.records.get(id)!;
      state =
        this.dispatching || r.state === "uncertain"
          ? "uncertain"
          : signal.aborted || r.state === "canceled"
            ? "canceled"
            : "blocked";
      message =
        state === "uncertain"
          ? "Computer input or its observation could not be confirmed. It will not be repeated; reconcile the original operation."
          : state === "canceled"
            ? "Computer work stopped. No further actions will run."
            : error instanceof CuaSetupRequired
              ? error.advice
              : "The computer runtime could not continue within its current permissions and observation limits.";
    } finally {
      clearTimeout(deadline);
      this.approval = undefined;
      signal.removeEventListener("abort", onAbort);
      try {
        await stopDevice();
      } catch {
        state = "uncertain";
        message =
          "Computer runtime cleanup could not be confirmed. New work is blocked pending reconciliation.";
      }
      const finalRecord = this.records.get(id)!;
      if (finalRecord.state === "uncertain") {
        state = "uncertain";
        message = finalRecord.message;
      } else if (finalRecord.state === "canceled" && state !== "uncertain") {
        state = "canceled";
        message = finalRecord.message;
      }
      this.dispatching = false;
      // Persist completion before notifying; notification failure never replays work.
      this.update(id, { state, message, pendingAction: undefined });
      try {
        this.notify(message);
      } catch {
        /* status remains authoritative */
      }
    }
  }
}
