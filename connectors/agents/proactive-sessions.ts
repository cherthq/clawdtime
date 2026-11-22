import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureRead, secureWrite } from "../shared/state.js";
import type { AgentKind, AgentSession } from "./types.js";

const identitySchema = z.object({
  version: z.literal(1),
  sessionKey: z.string(),
  runId: z.string(),
  agent: z.string(),
  projectRoot: z.string(),
  pids: z.array(z.number()),
  startedAt: z.number(),
  at: z.number(),
  state: z.enum([
    "running",
    "waiting",
    "completed",
    "failed",
    "canceled",
    "ended",
  ]),
  jobRunId: z.string().optional(),
});
export type EnrolledSessionRun = z.infer<typeof identitySchema>;
export const sessionKey = (id: string) =>
  createHash("sha256").update(id).digest("hex").slice(0, 32);

/** Additive hook evidence, separate from legacy board files. No prompts or answers. */
export class ProactiveSessions {
  constructor(private readonly root: string) {}
  private file(key: string) {
    return join(this.root, "agents", "proactive-sessions", `${key}.json`);
  }
  get(key: string): EnrolledSessionRun | null {
    if (!/^[a-f0-9]{32}$/.test(key)) return null;
    try {
      return identitySchema.parse(secureRead(this.file(key)));
    } catch {
      return null;
    }
  }
  observe(
    agent: AgentKind,
    input: Record<string, unknown>,
    at: number,
    pids: number[],
    jobRunId?: string,
  ) {
    if (typeof input.session_id !== "string" || typeof input.cwd !== "string")
      return;
    const key = sessionKey(input.session_id);
    const old = this.get(key);
    if (old && old.at > at) return;
    const event = input.hook_event_name;
    const begins = event === "UserPromptSubmit" || event === "BeforeAgent";
    if (begins && old?.startedAt === at) return;
    const terminal =
      event === "Stop" || event === "AfterAgent"
        ? "completed"
        : event === "StopFailure"
          ? "failed"
          : event === "Interrupt"
            ? "canceled"
            : event === "SessionEnd"
              ? "ended"
              : null;
    // A hook first seen halfway through a turn cannot invent a run boundary.
    if (!begins && !old) return;
    const resolvedTerminal =
      terminal === "ended" &&
      old &&
      ["completed", "failed", "canceled"].includes(old.state)
        ? old.state
        : terminal;
    const value: EnrolledSessionRun = {
      version: 1,
      sessionKey: key,
      runId: begins ? randomUUID() : old!.runId,
      agent,
      projectRoot: input.cwd,
      pids: pids.slice(0, 3),
      startedAt: begins ? at : old!.startedAt,
      at,
      state:
        resolvedTerminal ??
        (begins
          ? "running"
          : event === "PermissionRequest" ||
              (event === "PreToolUse" &&
                (input.tool_name === "AskUserQuestion" ||
                  input.tool_name === "ExitPlanMode"))
            ? "waiting"
            : ["PostToolUse", "PostToolUseFailure", "PreToolUse"].includes(
                  String(event),
                )
              ? "running"
              : old!.state),
      ...(jobRunId
        ? { jobRunId }
        : old?.jobRunId
          ? { jobRunId: old.jobRunId }
          : {}),
    };
    secureWrite(this.file(key), value);
  }
  list(): EnrolledSessionRun[] {
    try {
      return readdirSync(
        join(this.root, "agents", "proactive-sessions"),
      ).flatMap((name) => {
        const item = this.get(name.replace(/\.json$/, ""));
        return item ? [item] : [];
      });
    } catch {
      return [];
    }
  }
  resolve(session: AgentSession): EnrolledSessionRun | null {
    if (session.host || session.pid === null || !session.cwd) return null;
    const found = this.list().filter(
      (item) =>
        item.agent === session.agent &&
        item.projectRoot === session.cwd &&
        item.pids.includes(session.pid!) &&
        item.at >= (session.startedAt ?? 0),
    );
    return found.length === 1 ? found[0]! : null;
  }
}

const attendanceSchema = z.object({
  version: z.literal(1),
  policyId: z.string(),
  projectRoot: z.string(),
  sessionKey: z.string().optional(),
  jobRunId: z.string().optional(),
  expiresAt: z.number(),
  responseSeconds: z.number().int().min(1).max(540),
  heartbeatAt: z.number(),
  revoked: z.boolean(),
});
export type ScopedAttendance = z.infer<typeof attendanceSchema>;
/** Only the service registers/refreshes these records after checking live policy. */
export class ScopedSupervision {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}
  private file(id: string) {
    return join(
      this.root,
      "agents",
      "scoped-supervision",
      `${sessionKey(id)}.json`,
    );
  }
  private recordKey(value: {
    policyId: string;
    projectRoot: string;
    sessionKey?: string;
    jobRunId?: string;
  }) {
    return JSON.stringify([
      value.policyId,
      value.projectRoot,
      value.sessionKey ?? null,
      value.jobRunId ?? null,
    ]);
  }
  register(
    value: Omit<ScopedAttendance, "version" | "heartbeatAt" | "revoked">,
  ) {
    if (!value.sessionKey && !value.jobRunId)
      throw new Error(
        "Supervision requires exact session or launched run identity.",
      );
    secureWrite(
      this.file(this.recordKey(value)),
      attendanceSchema.parse({
        ...value,
        version: 1,
        heartbeatAt: this.now(),
        revoked: false,
      }),
    );
  }
  records(): ScopedAttendance[] {
    try {
      return readdirSync(
        join(this.root, "agents", "scoped-supervision"),
      ).flatMap((name) => {
        try {
          return [
            attendanceSchema.parse(
              secureRead(join(this.root, "agents", "scoped-supervision", name)),
            ),
          ];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
  refresh(valid: (record: ScopedAttendance) => boolean) {
    for (const item of this.records()) {
      if (item.revoked || item.expiresAt <= this.now()) continue;
      const allowed = valid(item);
      secureWrite(this.file(this.recordKey(item)), {
        ...item,
        heartbeatAt: allowed ? this.now() : item.heartbeatAt,
        revoked: !allowed,
      });
    }
  }
  revoke(policyId: string) {
    for (const item of this.records())
      if (item.policyId === policyId)
        secureWrite(this.file(this.recordKey(item)), {
          ...item,
          revoked: true,
        });
  }
  match(
    projectRoot: string | null,
    key: string,
    jobRunId?: string,
  ): ScopedAttendance | null {
    const now = this.now();
    return (
      this.records().find(
        (item) =>
          !item.revoked &&
          item.projectRoot === projectRoot &&
          item.expiresAt > now &&
          item.heartbeatAt <= now &&
          now - item.heartbeatAt < 6000 &&
          (item.sessionKey
            ? item.sessionKey === key
            : !!jobRunId && item.jobRunId === jobRunId),
      ) ?? null
    );
  }
}
