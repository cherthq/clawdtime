import {
  readinessReasons,
  type ReadinessReason,
} from "../../connectors/shared/readiness.js";
import { presentationFor } from "../attention/presentation.js";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClawdTime } from "../attention/service.js";
import type {
  AgentSession,
  AttentionRequest,
  CallSession,
  ControlLease,
  ExecutionOwnership,
} from "../contracts.js";
import type { ControlCoordinator } from "./coordinator.js";
import { localPolicySchema, type PolicyDevice } from "./execution.js";

const commandSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    sessionId: z.string().min(1),
    callId: z.string().min(1),
    type: z.enum(["pause", "mute", "unmute", "end"]),
  })
  .strict();
export interface PanelDevice extends PolicyDevice {
  panel(deviceId: string, payload: Record<string, unknown>): Promise<unknown>;
}
/** Authenticated device metadata only. Commands never grant capture or control. */
export class PanelSynchronizer {
  private busy = false;
  constructor(
    readonly service: ClawdTime,
    readonly control: ControlCoordinator,
  ) {}
  async tick() {
    const device = this.control.device as typeof this.control.device &
      Partial<PanelDevice>;
    if (this.busy || !device.readiness || !device.panel) return;
    this.busy = true;
    presentationFor(this.service).prune();
    try {
      for (const r of this.service.store.all<AttentionRequest>("attention")) {
        const s = this.service.store.get<AgentSession>("session", r.sessionId);
        const c = this.service.store.get<CallSession>("call", r.callId ?? "");
        if (
          s?.protocolVersion !== 2 ||
          s.state === "stopped" ||
          c?.state !== "connected" ||
          !["connected", "awaiting_input"].includes(r.state)
        )
          continue;
        const p = this.service.pairing(r.pairingId);
        const local = await device.readiness(
          p.deviceId,
          p.memberId,
          p.displayId,
        );
        const policy = localPolicySchema.parse(local);
        if (
          !policy.armed ||
          !policy.available ||
          !policy.screenPermission ||
          !policy.displayAttached ||
          !policy.viewAllowed
        )
          presentationFor(this.service).clear(r.id);
        let e = this.service.store.get<ExecutionOwnership>("execution", r.id);
        const lease = this.service.store
          .all<ControlLease>("lease")
          .find((l) => l.requestId === r.id && l.state === "active");
        const invalidate = async () => {
          this.service.store.saveState(`view-stopped:${r.id}`, true);
          presentationFor(this.service).clear(r.id);
          if (e) {
            e = {
              ...e,
              epoch: e.epoch + 1,
              state: e.executor === "none" ? "paused" : "uncertain",
              updatedAt: this.service.clock(),
            };
            this.service.store.put("execution", e);
          }
          await this.control.stopPairing(p.id);
        };
        if (lease && lease.policyRevision !== policy.policyRevision)
          await invalidate();
        const parsed = commandSchema.safeParse(local.panelCommand);
        let acknowledgedCommandId: string | undefined;
        if (parsed.success) {
          const command = parsed.data;
          if (command.sessionId !== s.id || command.callId !== c.id) continue;
          const key = `panel-command:${p.deviceId}:${command.id}`;
          const previous = this.service.store.state<{
            command: typeof command;
            state: string;
          }>(key);
          if (
            previous &&
            JSON.stringify(previous.command) !== JSON.stringify(command)
          )
            continue;
          if (!previous) {
            // Persist intent before effects. Never replay a command interrupted by restart.
            this.service.store.saveState(key, { command, state: "running" });
            if (command.type === "mute" || command.type === "unmute")
              this.service.store.saveState(
                `muted:${r.id}`,
                command.type === "mute",
              );
            else {
              await invalidate();
              if (command.type === "end")
                this.service.endConversationFromPanel(r.id, s.id, c.id);
            }
            this.service.store.saveState(key, { command, state: "done" });
          }
          if (!previous || previous.state === "done")
            acknowledgedCommandId = command.id;
        }
        const turns = this.service.store
          .all<{ requestId: string; state: string }>("conversation_turn")
          .filter((t) => t.requestId === r.id);
        const executionState =
          e?.state === "uncertain"
            ? "uncertain"
            : turns.some((t) => t.state === "uncertain")
              ? "uncertain"
              : turns.some((t) => t.state === "pending_approval")
                ? "pending_approval"
                : e?.state === "working" ||
                    turns.some((t) => t.state === "executing")
                  ? "working"
                  : "waiting";
        // The panel expiry and helper checks prevent stale status from authorizing anything.
        const currentRequest = this.service.store.get<AttentionRequest>(
          "attention",
          r.id,
        );
        const currentCall = this.service.store.get<CallSession>("call", c.id);
        const ended =
          currentCall?.state !== "connected" ||
          !currentRequest ||
          !["connected", "awaiting_input"].includes(currentRequest.state);
        const reason: ReadinessReason | undefined =
          this.service.clock() - (s.lastSeenAt ?? s.createdAt) >= 20000
            ? "agent_stale"
            : !policy.armed
              ? "sharing_disabled"
              : !policy.available
                ? "gateway_unavailable"
                : !policy.screenPermission
                  ? "screen_permission"
                  : !policy.displayAttached || !policy.viewAllowed
                    ? "binding_mismatch"
                    : executionState === "uncertain"
                      ? "unresolved_effect"
                      : executionState === "pending_approval"
                        ? "native_approval"
                        : undefined;
        await device.panel(p.deviceId, {
          ...(local.presentationVersion === 1
            ? {
                presentationVersion: 1,
                activity: presentationFor(this.service).projection(r.id),
                ...(reason
                  ? {
                      readiness: {
                        reason,
                        checkedAt: new Date(this.service.clock()).toISOString(),
                        nextAction: readinessReasons[reason].nextAction,
                      },
                    }
                  : {}),
              }
            : {}),
          sessionId: s.id,
          callId: c.id,
          memberId: p.memberId,
          displayId: Number(p.displayId),
          expiresAt: new Date(this.service.clock() + 5000).toISOString(),
          agent: s.adapter,
          projectLabel: `${
            Array.from(basename(s.projectRoot).replace(/[\p{Cc}\p{Cs}]/gu, ""))
              .slice(0, 30)
              .join("") || "Project"
          } · Chat ${createHash("sha256").update(s.id).digest("hex").slice(0, 6)}`,
          personLabel: /^\+[1-9]\d{7,14}$/.test(p.recipient)
            ? `Paired contact ••${p.recipient.slice(-4)}`
            : "Paired contact",
          callState: ended
            ? "ended"
            : this.service.store.state(`muted:${r.id}`) === true
              ? "muted"
              : "connected",
          executionState,
          executor: e?.executor ?? "none",
          executorEpoch: e?.epoch ?? 0,
          policyRevision: policy.policyRevision,
          ...(acknowledgedCommandId ? { acknowledgedCommandId } : {}),
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
