import { z } from "zod";
import { DomainError, equal, hash } from "../storage/security.js";
import { ProtectedTaskStore } from "../storage/task-store.js";
import type { Store } from "../storage/store.js";
import type { Vault } from "../storage/security.js";

export interface DesktopExecutionSnapshot {
  configured: boolean;
  state: string;
  canStop: boolean;
  message: string;
}
export interface DesktopExecutorPort {
  snapshot(): DesktopExecutionSnapshot;
  submit(eventId: string, text: string): Promise<{ message: string }>;
  stop(): DesktopExecutionSnapshot;
}
export const desktopExecutorConfigSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string().uuid(),
    token: z.string().min(32).max(256),
    binary: z.string().startsWith("/"),
    clientPath: z.string().startsWith("/"),
    origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/),
  })
  .strict();
export type DesktopExecutorConfig = z.infer<typeof desktopExecutorConfigSchema>;
const identity = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
export const executorCommandSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("inbox"), threadId: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal("claim"),
      threadId: z.string().uuid(),
      id: identity,
    })
    .strict(),
  z
    .object({
      action: z.literal("check"),
      threadId: z.string().uuid(),
      id: identity,
    })
    .strict(),
  z
    .object({
      action: z.literal("finish"),
      threadId: z.string().uuid(),
      id: identity,
      state: z.enum(["completed", "blocked", "canceled", "uncertain"]),
      summary: z.string().trim().min(1).max(1600),
      observed: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reconcile"),
      threadId: z.string().uuid(),
      id: identity,
      state: z.enum(["completed", "canceled"]),
      summary: z.string().trim().min(1).max(1600),
      observed: z.literal(true),
    })
    .strict(),
]);
type State =
  | "dispatching"
  | "queued"
  | "running"
  | "stop_requested"
  | "completed"
  | "blocked"
  | "canceled"
  | "uncertain";
interface Record {
  id: string;
  threadId: string;
  fingerprint: string;
  text: string;
  state: State;
  createdAt: number;
  expiresAt: number;
  claimed: boolean;
  message: string;
  resultFingerprint?: string;
  reconciliationFingerprint?: string;
  priorMessage?: string;
}
const terminal = new Set<State>(["completed", "blocked", "canceled"]);

/** An explicit handoff to one existing host chat, never an input executor itself. */
export class DesktopExecutor implements DesktopExecutorPort {
  private records: ProtectedTaskStore<Record>;
  constructor(
    store: Store,
    vault: Vault,
    private config: DesktopExecutorConfig,
    private dispatch: (id: string) => Promise<"queued" | "uncertain">,
    private notify: (text: string) => void = () => {},
    private now: () => number = Date.now,
  ) {
    desktopExecutorConfigSchema.parse(config);
    this.records = new ProtectedTaskStore(store, vault, "desktop-executor-v1");
    for (const record of this.records.all())
      if (!terminal.has(record.state) && record.state !== "uncertain") {
        this.records.put({
          ...record,
          state: "uncertain",
          message:
            "The connection restarted before the result was confirmed. Work will not be repeated; reconcile the original request.",
        });
      }
  }
  private refresh(record: Record): Record {
    if (
      this.now() < record.expiresAt ||
      terminal.has(record.state) ||
      record.state === "uncertain"
    )
      return record;
    return this.records.put({
      ...record,
      state: record.claimed ? "uncertain" : "canceled",
      message: record.claimed
        ? "The work deadline passed without a confirmed result. No further actions are authorized."
        : "The request expired before the agent claimed it.",
    });
  }
  private active() {
    return this.records
      .all()
      .map((r) => this.refresh(r))
      .find((r) => !terminal.has(r.state));
  }
  snapshot(): DesktopExecutionSnapshot {
    const record = this.active() ?? this.records.all().at(-1);
    return {
      configured: true,
      state: record?.state ?? "idle",
      canStop:
        !!record &&
        (["dispatching", "queued", "running"].includes(record.state) ||
          (record.state === "uncertain" && !record.claimed)),
      message:
        record?.message ??
        "Connected to your selected Codex chat. Computer work uses that chat's tools and approvals.",
    };
  }
  async submit(eventId: string, text: string) {
    identity.parse(eventId);
    z.string().trim().min(1).max(2000).parse(text);
    const fingerprint = hash(JSON.stringify([this.config.threadId, text]));
    const previous = this.records.get(eventId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError(409, "Request identity conflicts.");
      return { message: this.refresh(previous).message };
    }
    if (this.active())
      return {
        message:
          "Computer work is already pending or unresolved. Check its status or stop it before starting another request.",
      };
    this.records.put({
      id: eventId,
      threadId: this.config.threadId,
      fingerprint,
      text,
      state: "dispatching",
      claimed: false,
      createdAt: this.now(),
      expiresAt: this.now() + 15 * 60_000,
      message:
        "Sending your request to the connected Codex chat; execution is not yet confirmed.",
    });
    let outcome: "queued" | "uncertain" = "uncertain";
    try {
      outcome = await this.dispatch(eventId);
    } catch {
      /* Never repeat an uncertain enqueue. */
    }
    const current = this.records.get(eventId)!;
    // A fast agent or Stop may have changed the record while queueing awaited.
    if (current.state === "dispatching")
      this.records.put({
        ...current,
        state: outcome === "queued" ? "queued" : "uncertain",
        message:
          outcome === "queued"
            ? "Your request is queued for the connected Codex chat. It has not confirmed execution yet."
            : "Delivery or resumption could not be confirmed. The request will not be sent again automatically.",
      });
    return { message: this.records.get(eventId)!.message };
  }
  stop() {
    const current = this.active();
    if (
      current &&
      current.state !== "stop_requested" &&
      (current.state !== "uncertain" || !current.claimed)
    )
      this.records.put({
        ...current,
        state: current.claimed ? "stop_requested" : "canceled",
        message: current.claimed
          ? "Stop requested; an action already underway may finish. Waiting for the agent to confirm."
          : "Stopped before the agent claimed the request.",
      });
    return this.snapshot();
  }
  command(token: string, raw: unknown) {
    if (!equal(token, this.config.token))
      throw new DomainError(401, "Executor authorization required.");
    const command = executorCommandSchema.parse(raw);
    if (command.threadId !== this.config.threadId)
      throw new DomainError(403, "Wrong executor chat.");
    if (command.action === "inbox")
      return {
        requests: this.records
          .all()
          .map((r) => this.refresh(r))
          .filter(
            (r) => r.threadId === command.threadId && !terminal.has(r.state),
          )
          .map((r) => ({
            id: r.id,
            state: r.state,
            claimed: r.claimed,
            expiresAt: r.expiresAt,
          })),
      };
    let record = this.records.get(command.id);
    if (!record || record.threadId !== command.threadId)
      throw new DomainError(404, "Executor request unavailable.");
    record = this.refresh(record);
    if (command.action === "claim") {
      if (
        record.claimed ||
        !["dispatching", "queued", "uncertain"].includes(record.state) ||
        this.now() >= record.expiresAt
      )
        return {
          id: record.id,
          state: record.state,
          canAct: false,
          message:
            "This request cannot be claimed again. Reconcile its existing outcome; do not repeat work.",
        };
      record = this.records.put({
        ...record,
        claimed: true,
        state: "running",
        message:
          "The connected Codex chat is working. Its native permissions still apply.",
      });
      return {
        id: record.id,
        state: record.state,
        canAct: true,
        task: record.text,
        expiresAt: record.expiresAt,
      };
    }
    if (command.action === "check")
      return {
        id: record.id,
        state: record.state,
        canAct: record.state === "running",
        message: record.message,
        expiresAt: record.expiresAt,
      };
    const resultFingerprint = hash(
      JSON.stringify([command.state, command.summary, command.observed]),
    );
    if (command.action === "reconcile") {
      if (record.reconciliationFingerprint) {
        if (record.reconciliationFingerprint !== resultFingerprint)
          throw new DomainError(409, "Reconciliation already exists.");
        return { id: record.id, state: record.state, recorded: true };
      }
      if (!record.claimed || record.state !== "uncertain")
        throw new DomainError(
          409,
          "Only an uncertain claimed outcome can be reconciled.",
        );
      this.records.put({
        ...record,
        state: command.state,
        text: "",
        priorMessage: record.message,
        message: command.summary,
        reconciliationFingerprint: resultFingerprint,
      });
      this.notify(command.summary);
      return { id: record.id, state: command.state, recorded: true };
    }
    if (record.resultFingerprint) {
      if (record.resultFingerprint !== resultFingerprint)
        throw new DomainError(409, "A different result already exists.");
      return { id: record.id, state: record.state, recorded: true };
    }
    if (!record.claimed || terminal.has(record.state))
      throw new DomainError(409, "No claimed work can finish.");
    if (
      command.state === "completed" &&
      (!command.observed || record.state !== "running")
    )
      throw new DomainError(
        409,
        "Completion requires observed results and current authority.",
      );
    if (
      record.state !== "running" &&
      !["canceled", "uncertain"].includes(command.state)
    )
      throw new DomainError(
        409,
        "Stopped or uncertain work requires reconciliation.",
      );
    this.records.put({
      ...record,
      state: command.state,
      text: "",
      message: command.summary,
      resultFingerprint,
    });
    // Persist first: a crash may lose the notification but cannot duplicate work.
    this.notify(command.summary);
    return { id: record.id, state: command.state, recorded: true };
  }
}
