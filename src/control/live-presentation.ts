/** Opt-in camera-only presentation. OS input remains with the original native host. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type {
  AgentSession,
  ExecutionOwnership,
  ControlLease,
  ActionReceipt,
} from "../contracts.js";
import { nativePresentationObservationSchema } from "../native-presentation-contracts.js";
import {
  livePresentationIntentSchema,
  livePresentationSchema,
  livePresentationResultSchema,
  livePresentationStatusSchema,
  type LivePresentation,
  type LivePresentationResult,
} from "../live-presentation-contracts.js";
import { localPolicySchema, type PolicyDevice } from "./execution.js";
import type { ScreenCamera } from "./camera.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
type RecordEntry = {
  id: string;
  requestId: string;
  sessionId: string;
  commandId: string;
  intentHash: string;
  planId: string;
  sceneId: string;
  generation: number;
  createdAt: number;
  phase: "qualifying" | "dispatching" | "accepted" | "rejected" | "uncertain";
  fingerprint?: string;
  qualificationHash?: string;
  result?: LivePresentationResult;
  hostResult?: LivePresentationResult;
};
const kind = "live-presentation";

export class LivePresentationCoordinator {
  private busy = new Set<string>();
  constructor(
    readonly service: ClawdTime,
    readonly camera: ScreenCamera,
    readonly options: {
      enabled: boolean;
      revision(requestId: string): {
        cursor: number;
        acknowledgedCursor: number;
        pendingDelivery: boolean;
      };
      assertClear(requestId: string): void;
    },
  ) {
    // A process restart never replays an incomplete command, even qualification.
    for (const r of service.store.all<RecordEntry>(kind))
      if (["qualifying", "dispatching"].includes(r.phase))
        service.store.put(kind, { ...r, phase: "uncertain" });
  }
  private records(requestId: string) {
    return this.service.store
      .all<RecordEntry>(kind)
      .filter((r) => r.requestId === requestId);
  }
  private identity(token: string | AgentSession, requestId: string) {
    const session =
      typeof token === "string"
        ? this.service.authenticateSession(token)
        : token;
    const request = this.service.store.get<{ sessionId: string }>(
      "attention",
      requestId,
    );
    if (!request || request.sessionId !== session.id)
      throw new DomainError(403, "Exact presentation session required.");
    return session;
  }
  private context(token: string | AgentSession, requestId: string) {
    const session = this.identity(token, requestId);
    if (
      !this.options.enabled ||
      session.capabilities.livePresentationVersion !== 1 ||
      session.conversation ||
      session.documentAccess ||
      session.audioQualification ||
      session.screenCamera?.surface.kind !== "display"
    )
      throw new DomainError(
        409,
        "Live presentation was not negotiated or enabled.",
      );
    const c = this.camera.context(session, requestId),
      now = this.service.clock();
    const owner = this.service.store.get<ExecutionOwnership>(
      "execution",
      requestId,
    ) ?? {
      sessionId: session.id,
      executor: "none",
      state: "idle",
      epoch: 0,
      policyRevision: c.lease.policyRevision,
    };
    if (this.service.nativeReservations.hasUnresolvedDevice(c.lease.deviceId))
      throw new DomainError(
        409,
        "Native operation unresolved before presentation.",
      );
    const revision = this.options.revision(requestId);
    this.options.assertClear(requestId);
    const leases = this.service.store
      .all<ControlLease>("lease")
      .filter((l) => l.requestId === requestId);
    if (
      !owner ||
      owner.sessionId !== session.id ||
      owner.executor !== "none" ||
      owner.state !== "idle" ||
      owner.epoch !== c.lease.executorEpoch ||
      owner.policyRevision !== c.lease.policyRevision ||
      c.lease.executor !== "none" ||
      c.lease.mode !== "view" ||
      revision.pendingDelivery ||
      revision.cursor !== revision.acknowledgedCursor ||
      this.service.store.state(`view-stopped:${requestId}`) ||
      session.state !== "active" ||
      now - (session.lastSeenAt ?? session.createdAt) > 20000 ||
      (session.lastSeenAt ?? session.createdAt) > now + 1000 ||
      leases.some((l) => l.state === "unknown") ||
      this.service.store
        .all<ActionReceipt>("action")
        .some(
          (a) =>
            leases.some((l) => l.id === a.leaseId) &&
            ["pending", "submitted", "unknown"].includes(a.state),
        )
    )
      throw new DomainError(
        409,
        "Released current presentation authority required.",
      );
    return {
      ...c,
      expected: {
        requestId,
        sessionId: session.id,
        leaseId: c.lease.id,
        epoch: owner.epoch,
        cursor: revision.cursor,
        policyRevision: c.lease.policyRevision!,
        displayId: Number(c.lease.displayId),
      },
    };
  }
  private async ready(token: string | AgentSession, requestId: string) {
    const before = this.context(token, requestId),
      device = this.camera.control.device as typeof this.camera.control.device &
        Partial<PolicyDevice>;
    if (
      !device.readiness ||
      !device.resolvePresentation ||
      !device.livePresentation
    )
      throw new DomainError(409, "Live presentation peer unavailable.");
    const local = localPolicySchema.parse(
      await device.readiness(
        before.lease.deviceId,
        before.lease.memberId,
        before.lease.displayId,
      ),
    );
    const after = this.context(token, requestId);
    if (
      !isDeepStrictEqual(before.expected, after.expected) ||
      local.livePresentationVersion !== 1 ||
      local.cameraVersion !== 1 ||
      !local.armed ||
      !local.available ||
      !local.screenPermission ||
      !local.viewAllowed ||
      !local.displayAttached ||
      !local.activeLease ||
      local.activeLeaseId !== after.lease.id ||
      local.policyRevision !== after.lease.policyRevision
    )
      throw new DomainError(409, "Fresh live presentation peer required.");
    return after;
  }
  async status(token: string, requestId: string) {
    await this.ready(token, requestId);
    const records = this.records(requestId),
      latest = records.at(-1);
    return livePresentationStatusSchema.parse({
      version: 1,
      available: true,
      requestId,
      generation: latest?.generation ?? 0,
      planId: latest?.planId ?? null,
      sceneId: latest?.sceneId ?? null,
      unresolvedCommandId:
        records.find((r) =>
          ["qualifying", "dispatching", "uncertain"].includes(r.phase),
        )?.commandId ?? null,
    });
  }
  receipt(token: string, requestId: string, commandId: string) {
    this.identity(token, requestId);
    const record = this.records(requestId).find(
      (r) => r.commandId === commandId,
    );
    if (!record) throw new DomainError(404, "Unknown presentation receipt.");
    return (
      record.result ?? {
        version: 1,
        commandId,
        state: "uncertain",
        reason: "presentation_completion_unknown",
        fingerprint: record.fingerprint ?? record.intentHash,
        receiptId: record.id,
      }
    );
  }
  hasUnresolved(requestId: string) {
    return (
      this.busy.has(requestId) ||
      this.records(requestId).some((r) =>
        ["qualifying", "dispatching", "uncertain"].includes(r.phase),
      )
    );
  }
  qualification(session: AgentSession, requestId: string, raw: unknown) {
    const q = raw as {
      commandId?: string;
      expected?: unknown;
      expiresAt?: number;
    };
    const c = this.context(session, requestId),
      r = this.records(requestId).at(-1),
      now = this.service.clock();
    if (
      !r ||
      r.phase !== "qualifying" ||
      r.commandId !== q?.commandId ||
      r.qualificationHash !== fingerprint(raw) ||
      !isDeepStrictEqual(c.expected, q.expected) ||
      typeof q.expiresAt !== "number" ||
      !Number.isFinite(q.expiresAt) ||
      q.expiresAt <= now ||
      q.expiresAt > now + 2000 ||
      q.expiresAt > c.lease.expiresAt
    )
      throw new DomainError(409, "Presentation qualification changed.");
    return { ...c.expected, expiresAt: q.expiresAt };
  }
  authority(session: AgentSession, requestId: string, raw: unknown) {
    const p = livePresentationSchema.parse(raw),
      c = this.context(session, requestId),
      records = this.records(requestId),
      r = records.at(-1);
    if (
      !r ||
      !["dispatching", "accepted"].includes(r.phase) ||
      r.commandId !== p.commandId ||
      r.fingerprint !== fingerprint(p) ||
      !isDeepStrictEqual(c.expected, p.expected) ||
      r.sessionId !== session.id ||
      this.service.clock() - r.createdAt > 8000
    )
      throw new DomainError(409, "Presentation authority changed.");
    return {
      ...c.expected,
      fingerprint: r.fingerprint,
      expiresAt: Math.min(c.lease.expiresAt, this.service.clock() + 2000),
    };
  }
  async present(
    token: string,
    requestId: string,
    raw: unknown,
  ): Promise<LivePresentationResult> {
    this.identity(token, requestId);
    const intent = livePresentationIntentSchema.parse(raw),
      intentHash = fingerprint(intent),
      old = this.records(requestId).find(
        (r) => r.commandId === intent.commandId,
      );
    if (old) {
      if (old.intentHash !== intentHash)
        throw new DomainError(409, "Presentation command ID already bound.");
      return this.receipt(
        token,
        requestId,
        intent.commandId,
      ) as LivePresentationResult;
    }
    if (this.hasUnresolved(requestId))
      throw new DomainError(409, "Prior presentation outcome unresolved.");
    this.busy.add(requestId);
    let record: RecordEntry | undefined;
    try {
      const c = await this.ready(token, requestId),
        records = this.records(requestId),
        last = records.at(-1);
      if (
        records.length >= 128 ||
        (last && intent.generation <= last.generation) ||
        intent.window.displayId !== c.expected.displayId
      )
        throw new DomainError(
          409,
          "A fresh scene generation on the selected display is required.",
        );
      record = {
        id: randomUUID(),
        requestId,
        sessionId: c.session.id,
        commandId: intent.commandId,
        intentHash,
        planId: intent.planId,
        sceneId: intent.sceneId,
        generation: intent.generation,
        createdAt: this.service.clock(),
        phase: "qualifying",
      };
      this.service.store.put(kind, record);
      let p: LivePresentation;
      try {
        const qualification = {
          commandId: intent.commandId,
          window: intent.window,
          expected: c.expected,
          expiresAt: Math.min(c.lease.expiresAt, this.service.clock() + 2000),
        };
        record.qualificationHash = fingerprint(qualification);
        this.service.store.put(kind, record);
        const observed = nativePresentationObservationSchema.parse(
          await this.camera.control.device.resolvePresentation!(
            c.lease,
            qualification,
          ),
        );
        this.qualification(c.session, requestId, qualification);
        if (
          !isDeepStrictEqual(observed.window, intent.window) ||
          !observed.appActive ||
          !observed.windowFocused ||
          !observed.windowOnScreen ||
          this.service.clock() - observed.observedAt > 2000 ||
          observed.observedAt > this.service.clock() + 250 ||
          !isDeepStrictEqual(
            this.context(token, requestId).expected,
            c.expected,
          )
        )
          throw new Error("Target changed.");
        p = livePresentationSchema.parse({
          ...intent,
          version: 1,
          processIdentity: observed.processIdentity,
          expected: c.expected,
        });
        record.fingerprint = fingerprint(p);
        record.phase = "dispatching";
        this.service.store.put(kind, record);
      } catch {
        record.phase = "rejected";
        record.result = {
          version: 1,
          commandId: intent.commandId,
          state: "rejected",
          reason: "presentation_qualification_failed",
          fingerprint: record.fingerprint ?? intentHash,
          receiptId: record.id,
        };
        this.service.store.put(kind, record);
        return record.result;
      }
      try {
        this.authority(c.session, requestId, p);
        const result = livePresentationResultSchema.parse(
          await this.camera.control.device.livePresentation!(
            c.lease,
            p,
            record.fingerprint!,
          ),
        );
        if (
          result.commandId !== intent.commandId ||
          result.fingerprint !== record.fingerprint
        )
          throw new Error("Receipt mismatch.");
        record.hostResult = result;
        if (result.state === "accepted") {
          const o = result.observation!,
            f = result.camera!,
            now = this.service.clock();
          if (
            !isDeepStrictEqual(o.window, intent.window) ||
            o.processIdentity !== p.processIdentity ||
            !o.appActive ||
            !o.windowFocused ||
            !o.windowOnScreen ||
            now - o.observedAt > 2000 ||
            o.observedAt > now + 250 ||
            now - f.capturedAt > 2000 ||
            f.capturedAt > o.observedAt
          )
            throw new Error("Fresh exact target result required.");
        }
        this.authority(c.session, requestId, p);
        record.phase = result.state;
        record.result = result;
        this.service.store.put(kind, record);
        return result;
      } catch {
        record.phase = "uncertain";
        record.result = {
          version: 1,
          commandId: intent.commandId,
          state: "uncertain",
          reason: "presentation_completion_unknown",
          fingerprint: record.fingerprint!,
          receiptId: record.id,
        };
        this.service.store.put(kind, record);
        return record.result;
      }
    } finally {
      this.busy.delete(requestId);
    }
  }
}
