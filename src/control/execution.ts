import { z } from "zod";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type {
  ActionReceipt,
  AttentionRequest,
  CallSession,
  ComputerControlPolicy,
  ControlLease,
  ExecutionOwnership,
} from "../contracts.js";
import { actionSchema, ControlCoordinator } from "./coordinator.js";

export const executionTransition = z
  .object({
    expectedEpoch: z.number().int().nonnegative(),
    executor: z.enum(["none", "native", "clawdtime"]),
    previousOutcome: z.enum(["idle", "completed", "uncertain"]),
    backgroundActorsStopped: z.boolean(),
  })
  .strict();
export const localPolicySchema = z.object({
  controlPolicy: z.enum([
    "view_only",
    "agent_tools_only",
    "agent_tools_with_fallback",
  ]),
  policyRevision: z.number().int().nonnegative(),
  controlAllowed: z.boolean().default(false),
  armed: z.boolean().default(false),
  available: z.boolean().default(false),
  screenPermission: z.boolean().default(false),
  viewAllowed: z.boolean().default(false),
  displayAttached: z.boolean().default(false),
  activeLease: z.boolean().default(false),
  activeLeaseId: z.string().min(1).max(160).optional(),
});
export interface PolicyDevice {
  readiness(
    deviceId: string,
    memberId: string,
    displayId: string,
  ): Promise<Record<string, unknown>>;
}
export async function readLocalPolicy(
  control: ControlCoordinator,
  request: AttentionRequest,
) {
  const p = control.store.get<import("../contracts.js").Pairing>(
    "pairing",
    request.pairingId,
  )!;
  const device = control.device as typeof control.device &
    Partial<PolicyDevice>;
  if (!device.readiness)
    throw new DomainError(
      409,
      "This device has not verified version 2 local policy support.",
    );
  const raw = await device.readiness(p.deviceId, p.memberId, p.displayId);
  return localPolicySchema.parse(raw);
}

/** Cooperative ownership of only the selected shared surface, independent of reasoning/file work. */
export class ExecutionCoordinator {
  private busy = new Set<string>();
  constructor(
    readonly service: ClawdTime,
    readonly control: ControlCoordinator,
  ) {
    for (const e of service.store.all<ExecutionOwnership>("execution"))
      if (e.executor !== "none" && e.state !== "uncertain")
        service.store.put("execution", {
          ...e,
          state: "uncertain",
          updatedAt: service.clock(),
        });
  }
  private context(token: string, requestId: string, requireOpen = true) {
    const s = this.service.authenticateSession(token);
    const r = this.service.store.get<AttentionRequest>("attention", requestId);
    if (s.protocolVersion !== 2 || !r || r.sessionId !== s.id)
      throw new DomainError(
        403,
        "Exact version 2 conversation owner required.",
      );
    const p = this.service.pairing(r.pairingId);
    const call = this.service.store.get<CallSession>("call", r.callId ?? "");
    if (
      requireOpen &&
      (s.state === "stopped" ||
        !Number.isFinite(s.lastSeenAt ?? s.createdAt) ||
        this.service.clock() - (s.lastSeenAt ?? s.createdAt) > 20_000 ||
        (s.lastSeenAt ?? s.createdAt) > this.service.clock() + 1000 ||
        r.deadline <= this.service.clock() ||
        !["connected", "awaiting_input"].includes(r.state) ||
        call?.state !== "connected" ||
        !call.remoteParticipantQualified ||
        this.service.store.state(`view-stopped:${r.id}`))
    )
      throw new DomainError(409, "Shared surface is unavailable or stopped.");
    return { s, r, p };
  }
  status(token: string, requestId: string): ExecutionOwnership {
    const { s } = this.context(token, requestId, false);
    return (
      this.service.store.get<ExecutionOwnership>("execution", requestId) ?? {
        id: requestId,
        requestId,
        sessionId: s.id,
        executor: "none",
        epoch: 0,
        state: "idle",
        updatedAt: this.service.clock(),
      }
    );
  }
  private unresolved(requestId: string) {
    const request = this.service.store.get<AttentionRequest>(
      "attention",
      requestId,
    )!;
    const pairing = this.service.pairing(request.pairingId);
    const sameSurface = (id: string) => {
      const other = this.service.store.get<AttentionRequest>("attention", id);
      const paired =
        other &&
        this.service.store.get<import("../contracts.js").Pairing>(
          "pairing",
          other.pairingId,
        );
      return (
        paired?.deviceId === pairing.deviceId &&
        paired.displayId === pairing.displayId
      );
    };
    // A new request, new pairing, or expired call cannot make an old native tool idle.
    if (
      this.service.store
        .all<ExecutionOwnership>("execution")
        .some(
          (e) =>
            sameSurface(e.requestId) &&
            (e.state === "uncertain" ||
              (e.requestId !== requestId &&
                e.executor !== "none" &&
                !["idle", "paused"].includes(e.state))),
        )
    )
      return true;
    const leases = this.service.store
      .all<ControlLease>("lease")
      .filter(
        (l) =>
          l.deviceId === pairing.deviceId && l.displayId === pairing.displayId,
      );
    return (
      leases.some((l) => l.state === "unknown") ||
      this.service.store
        .all<ActionReceipt>("action")
        .some(
          (a) =>
            leases.some((l) => l.id === a.leaseId) &&
            ["pending", "submitted", "unknown"].includes(a.state),
        )
    );
  }
  async transition(token: string, requestId: string, raw: unknown) {
    const input = executionTransition.parse(raw);
    const { s, r, p } = this.context(token, requestId);
    if (this.busy.has(p.deviceId))
      throw new DomainError(409, "An ownership operation is in progress.");
    this.busy.add(p.deviceId);
    try {
      const before = this.status(token, requestId);
      if (before.epoch !== input.expectedEpoch)
        throw new DomainError(
          409,
          "Execution owner changed; read current state.",
        );
      if (before.state === "uncertain" || this.unresolved(requestId))
        throw new DomainError(409, "Unresolved input prevents handoff.");
      if (input.previousOutcome === "uncertain") {
        return this.service.store.put<ExecutionOwnership>("execution", {
          ...before,
          state: "uncertain",
          updatedAt: this.service.clock(),
        });
      }
      if (
        !input.backgroundActorsStopped ||
        (before.executor !== "none" && input.previousOutcome !== "completed")
      )
        throw new DomainError(
          409,
          "Acknowledge completion and stop conflicting actors before handoff.",
        );
      const policy = await readLocalPolicy(this.control, r);
      this.context(token, requestId);
      if (
        this.status(token, requestId).epoch !== before.epoch ||
        this.unresolved(requestId)
      )
        throw new DomainError(409, "Execution changed during preflight.");
      if (
        input.executor !== "none" &&
        (!p.allowControl ||
          !policy.controlAllowed ||
          policy.controlPolicy === "view_only")
      )
        throw new DomainError(
          403,
          "Local policy or pairing permits viewing only.",
        );
      if (
        input.executor !== "none" &&
        (!policy.armed ||
          !policy.available ||
          !policy.screenPermission ||
          !policy.viewAllowed ||
          !policy.displayAttached ||
          !policy.activeLease)
      )
        throw new DomainError(
          409,
          "The shared display is not locally enabled and available.",
        );
      if (
        input.executor === "native" &&
        (s.capabilities.nativeControl === undefined ||
          s.capabilities.nativeControl === "none" ||
          s.capabilities.sharedSurface !== true)
      )
        throw new DomainError(
          403,
          "Native control of this shared surface is unverified.",
        );
      if (
        input.executor === "clawdtime" &&
        policy.controlPolicy !== "agent_tools_with_fallback"
      )
        throw new DomainError(403, "ClawdTime fallback is disabled locally.");
      const lease = this.service.store
        .all<ControlLease>("lease")
        .find((l) => l.requestId === requestId && l.state === "active");
      if (
        !lease ||
        lease.protocolVersion !== 2 ||
        lease.expiresAt <= this.service.clock()
      )
        throw new DomainError(409, "A current shared surface is required.");
      const next: ExecutionOwnership = {
        ...before,
        executor: input.executor,
        epoch: before.epoch + 1,
        state: input.executor === "none" ? "idle" : "working",
        policyRevision: policy.policyRevision,
        updatedAt: this.service.clock(),
      };
      const grant: ControlLease = {
        ...lease,
        mode: input.executor === "clawdtime" ? "control" : "view",
        executor: input.executor,
        executorEpoch: next.epoch,
        policyRevision: policy.policyRevision,
      };
      this.service.store.transaction(() => {
        this.service.store.put("execution", next);
        this.service.store.put("lease", grant);
        this.service.store.saveState(`view-device-ready:${lease.id}`, false);
      });
      try {
        await this.control.device.createLease(grant);
        this.context(token, requestId);
        const fresh = await readLocalPolicy(this.control, r);
        this.context(token, requestId);
        const confirmed = this.service.store.get<ControlLease>(
          "lease",
          lease.id,
        );
        if (
          !confirmed ||
          confirmed.state !== "active" ||
          confirmed.expiresAt <= this.service.clock() ||
          confirmed.sessionId !== grant.sessionId ||
          confirmed.callId !== grant.callId ||
          confirmed.epoch !== grant.epoch ||
          confirmed.executorEpoch !== grant.executorEpoch ||
          confirmed.executor !== grant.executor ||
          confirmed.policyRevision !== grant.policyRevision ||
          confirmed.mode !== grant.mode
        )
          throw new Error(
            "Sharing grant changed during ownership acknowledgement.",
          );
        if (
          !fresh.armed ||
          !fresh.available ||
          !fresh.screenPermission ||
          !fresh.viewAllowed ||
          !fresh.displayAttached ||
          !fresh.activeLease ||
          fresh.activeLeaseId !== lease.id ||
          fresh.policyRevision !== policy.policyRevision ||
          fresh.controlPolicy !== policy.controlPolicy ||
          (next.executor !== "none" && !fresh.controlAllowed) ||
          this.status(token, requestId).epoch !== next.epoch ||
          this.status(token, requestId).state === "uncertain"
        )
          throw new Error("Local policy or ownership changed.");
        this.service.store.saveState(`view-device-ready:${lease.id}`, true);
        return next;
      } catch {
        const currentOwner = this.service.store.get<ExecutionOwnership>(
          "execution",
          requestId,
        );
        if (currentOwner)
          this.service.store.put("execution", {
            ...currentOwner,
            state: "uncertain",
            updatedAt: this.service.clock(),
          });
        const currentLease = this.service.store.get<ControlLease>(
          "lease",
          grant.id,
        );
        if (currentLease?.state === "active")
          this.service.store.put("lease", {
            ...currentLease,
            state: "unknown",
          });
        throw new DomainError(
          409,
          "Ownership synchronization is uncertain; do not dispatch or replay input.",
        );
      }
    } finally {
      this.busy.delete(p.deviceId);
    }
  }
  stop(requestId: string) {
    const e = this.service.store.get<ExecutionOwnership>(
      "execution",
      requestId,
    );
    if (e)
      this.service.store.put("execution", {
        ...e,
        epoch: e.epoch + 1,
        state: e.executor === "none" ? "paused" : "uncertain",
        updatedAt: this.service.clock(),
      });
  }
  private check(token: string, requestId: string, epoch: number) {
    const ctx = this.context(token, requestId);
    const e = this.status(token, requestId);
    if (
      e.epoch !== epoch ||
      e.executor !== "clawdtime" ||
      e.state !== "working"
    )
      throw new DomainError(
        403,
        "Current fallback execution ownership required.",
      );
    const lease = this.service.store
      .all<ControlLease>("lease")
      .find(
        (l) =>
          l.requestId === requestId &&
          l.state === "active" &&
          l.executorEpoch === epoch,
      );
    if (!lease) throw new DomainError(409, "Execution lease unavailable.");
    return { ...ctx, e, lease };
  }
  async observe(token: string, requestId: string, epoch: number) {
    const { p, r, e, lease } = this.check(token, requestId, epoch);
    const policy = await readLocalPolicy(this.control, r);
    if (
      !policy.armed ||
      !policy.available ||
      !policy.screenPermission ||
      !policy.viewAllowed ||
      !policy.displayAttached ||
      !policy.activeLease ||
      policy.activeLeaseId !== lease.id ||
      !policy.controlAllowed ||
      policy.controlPolicy !== "agent_tools_with_fallback" ||
      policy.policyRevision !== e.policyRevision
    )
      throw new DomainError(403, "Local fallback policy changed.");
    this.check(token, requestId, epoch);
    const frame = await this.control.frame(lease.id, p.memberId);
    const imageDevice = this.control.device as typeof this.control.device & {
      frameImage?: (
        lease: ControlLease,
      ) => Promise<{ frame: typeof frame; dataUrl: string }>;
    };
    if (imageDevice.frameImage) {
      const image = await imageDevice.frameImage(lease);
      this.check(token, requestId, epoch);
      this.control.store.saveState(`frame:${lease.id}`, image.frame);
      return image;
    }
    return { frame };
  }
  async act(token: string, requestId: string, raw: unknown) {
    const input = z
      .object({
        epoch: z.number().int().nonnegative(),
        actionId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
        frameId: z.string().min(1).max(160),
        action: actionSchema,
      })
      .strict()
      .parse(raw);
    const { p, r, e, lease } = this.check(token, requestId, input.epoch);
    const policy = await readLocalPolicy(this.control, r);
    if (
      !policy.armed ||
      !policy.available ||
      !policy.screenPermission ||
      !policy.viewAllowed ||
      !policy.displayAttached ||
      !policy.activeLease ||
      policy.activeLeaseId !== lease.id ||
      !policy.controlAllowed ||
      policy.controlPolicy !== "agent_tools_with_fallback" ||
      policy.policyRevision !== e.policyRevision
    )
      throw new DomainError(403, "Local fallback policy changed.");
    this.check(token, requestId, input.epoch);
    return this.control.act(
      lease.id,
      p.memberId,
      input.actionId,
      input.frameId,
      input.action,
    );
  }
}
