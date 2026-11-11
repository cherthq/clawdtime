import {
  PreflightBlocked,
  freshEvidence,
  type TransportReadiness,
  type DeviceReadiness,
  type ReadinessCheck,
} from "../transport/readiness.js";
import { z } from "zod";
import type {
  AgentSession,
  Pairing,
  AttentionRequest,
  HumanResponse,
  CallSession,
  ControlLease,
  ActionReceipt,
  Transport,
  RequestAttentionInput,
  SessionRegistration,
} from "../contracts.js";
import { Store } from "../storage/store.js";
import { DomainError, hash, id, token } from "../storage/security.js";
export { DomainError } from "../storage/security.js";

const nonempty = z.string().trim().min(1).max(512);
const registration = z
  .object({
    adapter: z.enum(["claude-code", "codex"]),
    adapterVersion: nonempty,
    projectRoot: nonempty,
    externalSessionId: nonempty,
    hostId: nonempty,
    capabilities: z
      .object({ cooperativePause: z.boolean(), polling: z.boolean() })
      .strict(),
  })
  .strict();
const attentionInput = z
  .object({
    taskId: nonempty,
    idempotencyKey: nonempty,
    reason: z.enum(["blocker", "decision", "approval", "review", "result"]),
    question: z.string().trim().min(1).max(8000),
    timeoutSeconds: z.number().int().min(10).max(3600).optional(),
  })
  .strict();
const textSchema = z.string().trim().min(1).max(8000);
const terminal = new Set([
  "completed",
  "declined",
  "unanswered",
  "canceled",
  "expired",
  "disconnected",
  "failed",
  "unknown",
]);
interface Credential {
  id: string;
  kind: "pairing" | "session";
  subjectId: string;
  revokedAt?: number;
}
interface Invite {
  id: string;
  binding: InviteInput;
  expiresAt: number;
  consumedAt?: number;
}
export interface InviteInput {
  memberId: string;
  recipient: string;
  conversationId: string;
  lineId: string;
  deviceId: string;
  displayId: string;
  ttlSeconds?: number;
}
export interface ResponseInput {
  eventId: string;
  requestId: string;
  memberId: string;
  lineId: string;
  conversationId: string;
  channel: "text" | "voice";
  text: string;
  kind?: HumanResponse["kind"];
  qualifiedRemoteAudio?: boolean;
  callId?: string;
}
export class ClawdTime {
  readonly clock: () => number;
  private draining = false;
  constructor(
    readonly store: Store,
    readonly transport: Transport,
    options: { clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    for (const e of store.effects("unknown")) {
      const request = store.get<AttentionRequest>(
        "attention",
        String(e.payload.requestId),
      );
      if (e.kind === "call" && request && !terminal.has(request.state))
        store.put("attention", { ...request, state: "unknown" });
    }
  }
  private issue(kind: Credential["kind"], subjectId: string) {
    const raw = token();
    this.store.put<Credential>("credential", {
      id: hash(raw),
      kind,
      subjectId,
    });
    return raw;
  }
  private credential(raw: string, kind?: Credential["kind"]) {
    if (typeof raw !== "string" || raw.length < 32)
      throw new DomainError(401, "Missing scoped credential.");
    const c = this.store.get<Credential>("credential", hash(raw));
    if (!c || c.revokedAt !== undefined || (kind && c.kind !== kind))
      throw new DomainError(401, "Credential is invalid or revoked.");
    return c;
  }
  pairing(id: string): Pairing {
    const p = this.store.get<Pairing>("pairing", id);
    if (!p || p.revokedAt !== undefined)
      throw new DomainError(403, "Pairing is unavailable or revoked.");
    return p;
  }
  authenticateSession(raw: string): AgentSession {
    const c = this.credential(raw, "session"),
      s = this.store.get<AgentSession>("session", c.subjectId);
    if (!s || s.state === "stopped")
      throw new DomainError(403, "Session is stopped.");
    this.pairing(s.pairingId);
    return s;
  }
  createPairingInvite(input: InviteInput) {
    const binding = z
      .object({
        memberId: nonempty,
        recipient: nonempty,
        conversationId: nonempty,
        lineId: nonempty,
        deviceId: nonempty,
        displayId: nonempty,
        ttlSeconds: z.number().int().min(30).max(900).optional(),
      })
      .strict()
      .parse(input);
    const raw = token(),
      expiresAt = this.clock() + (binding.ttlSeconds ?? 600) * 1000;
    this.store.put<Invite>("invite", { id: hash(raw), binding, expiresAt });
    return { token: raw, expiresAt };
  }
  claimPairing(input: {
    token: string;
    deviceId: string;
    displayId: string;
    allowView: boolean;
    allowControl: boolean;
  }) {
    const claim = z
      .object({
        token: nonempty,
        deviceId: nonempty,
        displayId: nonempty,
        allowView: z.boolean(),
        allowControl: z.boolean(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const invite = this.store.get<Invite>("invite", hash(claim.token));
      if (
        !invite ||
        invite.consumedAt !== undefined ||
        invite.expiresAt <= this.clock()
      )
        throw new DomainError(410, "Pairing link expired or already used.");
      if (
        invite.binding.deviceId !== claim.deviceId ||
        invite.binding.displayId !== claim.displayId
      )
        throw new DomainError(403, "Pairing device/display does not match.");
      if (!claim.allowView || (claim.allowControl && !claim.allowView))
        throw new DomainError(400, "Explicit viewing permission is required.");
      const { ttlSeconds: _ttl, ...binding } = invite.binding;
      const pairing = this.store.put<Pairing>("pairing", {
        ...binding,
        id: id("pair"),
        createdAt: this.clock(),
        allowView: claim.allowView,
        allowControl: claim.allowControl,
      });
      this.store.put("invite", { ...invite, consumedAt: this.clock() });
      return { pairing, token: this.issue("pairing", pairing.id) };
    });
  }
  registerSession(raw: string, input: SessionRegistration) {
    this.expireSessions();
    const c = this.credential(raw, "pairing"),
      p = this.pairing(c.subjectId),
      value = registration.parse(input);
    return this.store.transaction(() => {
      const previous = this.store
        .all<AgentSession>("session")
        .find(
          (s) =>
            s.pairingId === p.id &&
            s.externalSessionId === value.externalSessionId,
        );
      if (
        previous &&
        (previous.projectRoot !== value.projectRoot ||
          previous.adapter !== value.adapter ||
          previous.hostId !== value.hostId ||
          JSON.stringify(previous.capabilities) !==
            JSON.stringify(value.capabilities))
      )
        throw new DomainError(
          409,
          "Session binding differs from original registration.",
        );
      if (previous?.state === "stopped")
        throw new DomainError(403, "Stopped sessions cannot be revived.");
      const session = this.store.put<AgentSession>(
        "session",
        previous
          ? { ...previous, lastSeenAt: this.clock() }
          : {
              ...value,
              id: id("session"),
              pairingId: p.id,
              createdAt: this.clock(),
              lastSeenAt: this.clock(),
              state: "active",
              controlEpoch: 0,
            },
      );
      for (const credential of this.store.all<Credential>("credential"))
        if (
          credential.kind === "session" &&
          credential.subjectId === session.id &&
          credential.revokedAt === undefined
        )
          this.store.put("credential", {
            ...credential,
            revokedAt: this.clock(),
          });
      return { session, token: this.issue("session", session.id) };
    });
  }
  requestAttention(
    raw: string,
    input: RequestAttentionInput,
  ): AttentionRequest {
    const session = this.authenticateSession(raw),
      value = attentionInput.parse(input),
      pairing = this.pairing(session.pairingId);
    return this.store.transaction(() => {
      const key = `attention-key:${session.id}:${hash(value.idempotencyKey)}`;
      const old = this.store.state<{ fingerprint: string; requestId: string }>(
          key,
        ),
        fingerprint = hash(JSON.stringify(value));
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new DomainError(
            409,
            "Request key was reused with different arguments.",
          );
        return this.store.get<AttentionRequest>("attention", old.requestId)!;
      }
      if (session.capabilities.cooperativePause && session.state !== "yielded")
        throw new DomainError(
          409,
          "Yield agent activity before requesting attention.",
        );
      if (
        this.store
          .all<AttentionRequest>("attention")
          .some((r) => r.pairingId === pairing.id && !terminal.has(r.state))
      )
        throw new DomainError(
          409,
          "The paired person already has a pending attention request.",
        );
      if (this.store.all<CallSession>("call").some((c) => c.state !== "ended"))
        throw new DomainError(
          409,
          "The dedicated line is still reserved by an existing call.",
        );
      const request: AttentionRequest = {
        ...value,
        id: id("attention"),
        sessionId: session.id,
        pairingId: pairing.id,
        createdAt: this.clock(),
        deadline: this.clock() + (value.timeoutSeconds ?? 300) * 1000,
        state: "queued",
      };
      delete (request as AttentionRequest & { timeoutSeconds?: number })
        .timeoutSeconds;
      this.store.put("attention", request);
      this.store.saveState(key, { fingerprint, requestId: request.id });
      const effectId = `${request.id}:call`,
        callId = `ct_${hash(request.id).slice(0, 40)}`;
      this.store.put<CallSession>("call", {
        id: callId,
        requestId: request.id,
        pairingId: pairing.id,
        state: "prepared",
        remoteParticipantQualified: false,
        createdAt: this.clock(),
      });
      this.enqueue(effectId, "call", {
        requestId: request.id,
        pairingId: pairing.id,
        localCallId: callId,
      });
      return request;
    });
  }
  private owned(raw: string, requestId: string) {
    const session = this.authenticateSession(raw),
      request = this.store.get<AttentionRequest>("attention", requestId);
    if (
      !request ||
      request.sessionId !== session.id ||
      request.pairingId !== session.pairingId
    )
      throw new DomainError(
        404,
        "Attention request does not belong to this session.",
      );
    return { session, request };
  }
  status(raw: string, requestId: string) {
    this.expire();
    return this.owned(raw, requestId).request;
  }
  result(raw: string, requestId: string) {
    const request = this.status(raw, requestId),
      response = request.responseId
        ? this.store.get<HumanResponse>("response", request.responseId)
        : undefined;
    return {
      request,
      session: this.authenticateSession(raw),
      ...(response ? { response } : {}),
    };
  }
  ack(raw: string, requestId: string, responseId: string) {
    const { session, request } = this.owned(raw, requestId);
    if (request.responseId !== responseId)
      throw new DomainError(409, "Response does not match request.");
    const response = this.store.get<HumanResponse>("response", responseId);
    if (
      !response ||
      (response.acknowledgedSessionId &&
        response.acknowledgedSessionId !== session.id)
    )
      throw new DomainError(409, "Response is unavailable.");
    return this.store.transaction(() => {
      const r = this.store.put("response", {
        ...response,
        acknowledgedAt: response.acknowledgedAt ?? this.clock(),
        acknowledgedSessionId: session.id,
      });
      if (!terminal.has(request.state) && request.state !== "resumed")
        this.store.put("attention", {
          ...request,
          state: "response_delivered",
        });
      return r;
    });
  }
  heartbeat(raw: string) {
    this.expireSessions();
    const session = this.authenticateSession(raw);
    return this.store.put<AgentSession>("session", {
      ...session,
      lastSeenAt: this.clock(),
    });
  }
  expireSessions(ttlMs = 20_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new DomainError(
        400,
        "Heartbeat timeout must be a positive integer.",
      );
    let stopped = 0;
    for (const session of this.store.all<AgentSession>("session")) {
      if (
        session.state === "stopped" ||
        this.clock() - (session.lastSeenAt ?? session.createdAt) < ttlMs
      )
        continue;
      this.store.transaction(() => {
        this.store.put<AgentSession>("session", {
          ...session,
          state: "stopped",
          controlEpoch: session.controlEpoch + 1,
        });
        for (const request of this.store
          .all<AttentionRequest>("attention")
          .filter((r) => r.sessionId === session.id))
          this.failCall(request.id);
      });
      stopped++;
    }
    return { stopped };
  }
  yieldSession(raw: string) {
    const session = this.authenticateSession(raw);
    if (!session.capabilities.cooperativePause)
      throw new DomainError(409, "Adapter cannot establish cooperative pause.");
    return this.store.put<AgentSession>("session", {
      ...session,
      state: "yielded",
    });
  }
  resume(raw: string, requestId: string, controlEpoch: number) {
    const { session, request } = this.owned(raw, requestId);
    const response = request.responseId
      ? this.store.get<HumanResponse>("response", request.responseId)
      : undefined;
    if (
      !response?.acknowledgedAt ||
      response.acknowledgedSessionId !== session.id ||
      !["response_delivered", "resumed"].includes(request.state)
    )
      throw new DomainError(
        409,
        "An acknowledged human response is required before continuation.",
      );
    if (controlEpoch !== session.controlEpoch)
      throw new DomainError(
        409,
        "Screen context changed; fetch the current control epoch.",
      );
    const leases = this.store
      .all<ControlLease>("lease")
      .filter((l) => l.sessionId === session.id);
    if (
      leases.some((l) => l.state === "active" || l.state === "unknown") ||
      this.store
        .all<ActionReceipt>("action")
        .some(
          (a) =>
            leases.some((l) => l.id === a.leaseId) &&
            ["pending", "submitted", "unknown"].includes(a.state),
        )
    )
      throw new DomainError(
        409,
        "Control must be released and uncertain actions reconciled before continuation.",
      );
    return this.store.transaction(() => ({
      session: this.store.put<AgentSession>("session", {
        ...session,
        state: "active",
      }),
      request: this.store.put<AttentionRequest>("attention", {
        ...request,
        state: "resumed",
      }),
    }));
  }
  complete(raw: string, requestId: string, text: string) {
    const { request } = this.owned(raw, requestId),
      result = textSchema.parse(text);
    if (request.state === "completed") {
      if (request.result !== result)
        throw new DomainError(
          409,
          "Completion content differs from committed result.",
        );
      return request;
    }
    if (request.state !== "resumed")
      throw new DomainError(
        409,
        "Agent must acknowledge continuation before reporting completion.",
      );
    return this.store.transaction(() => {
      const next = this.store.put<AttentionRequest>("attention", {
        ...request,
        state: "completed",
        result,
      });
      this.enqueue(`${request.id}:result`, "message", {
        requestId: request.id,
        pairingId: request.pairingId,
        text: result,
      });
      this.endOwnedCall(request);
      this.revokeLeases(request.id);
      return next;
    });
  }
  receiveResponse(input: ResponseInput): HumanResponse {
    const value = z
      .object({
        eventId: nonempty,
        requestId: nonempty,
        memberId: nonempty,
        lineId: nonempty,
        conversationId: nonempty,
        channel: z.enum(["text", "voice"]),
        text: textSchema,
        kind: z.enum(["answer", "correction", "approval"]).optional(),
        qualifiedRemoteAudio: z.boolean().optional(),
        callId: nonempty.optional(),
      })
      .strict()
      .parse(input);
    const request = this.store.get<AttentionRequest>(
      "attention",
      value.requestId,
    );
    if (!request) throw new DomainError(404, "Unknown attention request.");
    const p = this.pairing(request.pairingId);
    if (
      p.memberId !== value.memberId ||
      p.lineId !== value.lineId ||
      p.conversationId !== value.conversationId
    )
      throw new DomainError(
        403,
        "Human feedback identity does not match pending request.",
      );
    const fingerprint = hash(JSON.stringify(value));
    return this.store.transaction(() => {
      const prior = this.store.event<HumanResponse>(value.eventId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Inbound event identity changed.");
        return prior.result;
      }
      if (
        terminal.has(request.state) ||
        request.deadline <= this.clock() ||
        request.responseId
      )
        throw new DomainError(
          409,
          "Attention request no longer accepts feedback.",
        );
      if (value.channel === "voice") {
        const call = this.store.get<CallSession>("call", request.callId ?? "");
        if (
          !value.qualifiedRemoteAudio ||
          !call ||
          call.id !== value.callId ||
          call.state !== "connected" ||
          !call.remoteParticipantQualified
        )
          throw new DomainError(
            403,
            "Voice must originate from the qualified remote participant of this active call.",
          );
        if (value.kind === "approval")
          throw new DomainError(
            403,
            "Sensitive approval requires authenticated text and native agent policy.",
          );
      }
      const response = this.store.put<HumanResponse>("response", {
        id: id("response"),
        requestId: request.id,
        memberId: p.memberId,
        channel: value.channel,
        sequence: 1,
        text: value.text,
        kind: value.kind ?? "answer",
        createdAt: this.clock(),
      });
      this.store.put("attention", {
        ...request,
        responseId: response.id,
        state: "awaiting_input",
      });
      this.store.recordEvent(value.eventId, fingerprint, response);
      return response;
    });
  }
  observeCall(
    requestId: string,
    state:
      | "connected"
      | "declined"
      | "unanswered"
      | "disconnected"
      | "failed"
      | "ended",
    qualified = false,
  ) {
    const request = this.store.get<AttentionRequest>("attention", requestId);
    if (!request) throw new DomainError(404, "Unknown attention request.");
    const call = this.store
      .all<CallSession>("call")
      .find((c) => c.requestId === requestId);
    if (!call) throw new DomainError(404, "Unknown call.");
    if (call.state === "ended") return call;
    return this.store.transaction(() => {
      if (state === "connected") {
        if (terminal.has(request.state) || request.deadline <= this.clock())
          throw new DomainError(409, "Attention request is terminal.");
        this.store.put("attention", {
          ...request,
          callId: call.id,
          state: request.responseId ? request.state : "awaiting_input",
        });
        return this.store.put<CallSession>("call", {
          ...call,
          state: "connected",
          remoteParticipantQualified: qualified,
        });
      }
      this.revokeLeases(request.id);
      if (!request.responseId && !terminal.has(request.state))
        this.store.put("attention", {
          ...request,
          state: state === "ended" ? "disconnected" : state,
        });
      return this.store.put<CallSession>("call", {
        ...call,
        state: "ended",
        remoteParticipantQualified: false,
        endedAt: this.clock(),
      });
    });
  }
  failCall(requestId: string) {
    const request = this.store.get<AttentionRequest>("attention", requestId);
    if (!request) throw new DomainError(404, "Unknown attention request.");
    return this.store.transaction(() => {
      this.revokeLeases(requestId);
      this.endOwnedCall(request);
      if (!request.responseId && !terminal.has(request.state))
        this.store.put("attention", { ...request, state: "failed" });
      return { cleanupPending: true };
    });
  }
  private revokeLeases(requestId: string) {
    for (const lease of this.store.all<ControlLease>("lease"))
      if (lease.requestId === requestId && lease.state === "active")
        this.store.put("lease", { ...lease, state: "unknown" });
  }
  private endOwnedCall(request: AttentionRequest) {
    const call = this.store
      .all<CallSession>("call")
      .find((c) => c.requestId === request.id);
    if (call && call.state !== "ended" && call.providerCallId)
      this.enqueue(`${request.id}:end`, "end_call", {
        requestId: request.id,
        pairingId: request.pairingId,
        callId: call.providerCallId,
      });
  }
  disconnect(raw: string) {
    const c = this.credential(raw),
      pairingId =
        c.kind === "pairing"
          ? c.subjectId
          : this.authenticateSession(raw).pairingId;
    return this.store.transaction(() => {
      const p = this.pairing(pairingId);
      this.store.put("pairing", { ...p, revokedAt: this.clock() });
      for (const s of this.store.all<AgentSession>("session"))
        if (s.pairingId === pairingId)
          this.store.put("session", {
            ...s,
            state: "stopped",
            controlEpoch: s.controlEpoch + 1,
          });
      for (const r of this.store.all<AttentionRequest>("attention"))
        if (r.pairingId === pairingId) {
          this.revokeLeases(r.id);
          this.endOwnedCall(r);
          if (!terminal.has(r.state))
            this.store.put("attention", { ...r, state: "canceled" });
        }
      return { revoked: true };
    });
  }
  expire() {
    for (const request of this.store.all<AttentionRequest>("attention"))
      if (
        !terminal.has(request.state) &&
        !["response_delivered", "resumed"].includes(request.state) &&
        !request.responseId &&
        request.deadline <= this.clock()
      )
        this.store.transaction(() => {
          this.store.put("attention", { ...request, state: "expired" });
          this.revokeLeases(request.id);
          this.endOwnedCall(request);
        });
  }
  private enqueue(
    id: string,
    kind: "call" | "message" | "end_call",
    payload: Record<string, unknown>,
  ) {
    if (!this.store.effect(id))
      this.store.putEffect({
        id,
        kind,
        payload,
        state: "pending",
        createdAt: this.clock(),
      });
  }
  async drain(
    options: { cleanupOnly?: boolean; shouldStop?: () => boolean } = {},
  ) {
    if (this.draining) return;
    this.draining = true;
    try {
      this.expire();
      for (const effect of this.store
        .effects("pending")
        .filter((e) => !options.cleanupOnly || e.kind === "end_call")) {
        if (options.shouldStop?.()) break;
        const request = this.store.get<AttentionRequest>(
            "attention",
            String(effect.payload.requestId),
          ),
          pairing = this.store.get<Pairing>(
            "pairing",
            String(effect.payload.pairingId),
          );
        if (
          !request ||
          !pairing ||
          (effect.kind !== "end_call" && pairing.revokedAt !== undefined) ||
          (effect.kind === "call" && request.state !== "queued")
        ) {
          this.store.putEffect({
            ...effect,
            state: "failed",
            result: { reason: "Authorization closed before dispatch." },
          });
          if (effect.kind === "call") {
            const call = this.store.get<CallSession>(
              "call",
              String(effect.payload.localCallId),
            );
            if (call?.state === "prepared" && !call.providerCallId)
              this.store.put("call", {
                ...call,
                state: "ended",
                endedAt: this.clock(),
              });
          }
          continue;
        }
        const claimed = this.store.transaction(() => {
          if (this.store.effect(effect.id)?.state !== "pending") return false;
          this.store.putEffect({ ...effect, state: "running" });
          return true;
        });
        if (!claimed) continue;
        try {
          let result: Record<string, unknown>;
          if (effect.kind === "call")
            result = await this.transport.call(request, pairing, effect.id);
          else if (effect.kind === "message")
            result = await this.transport.message(
              pairing,
              String(effect.payload.text),
              effect.id,
            );
          else
            result = await this.transport.endCall(
              String(effect.payload.callId),
              effect.id,
            );
          this.store.transaction(() => {
            this.store.putEffect({ ...effect, state: "done", result });
            if (
              effect.kind === "end_call" &&
              this.transport.mode === "simulation"
            )
              this.observeCall(request.id, "ended");
            if (effect.kind === "call") {
              if (result.accepted !== true || typeof result.callId !== "string")
                throw new Error("Call acceptance receipt missing.");
              const call = this.store.get<CallSession>(
                "call",
                String(effect.payload.localCallId),
              )!;
              this.store.put("call", {
                ...call,
                providerCallId: result.callId,
                state: "ringing",
              });
              const current = this.store.get<AttentionRequest>(
                "attention",
                request.id,
              )!;
              this.store.put("attention", {
                ...current,
                callId: call.id,
                state: terminal.has(current.state) ? current.state : "ringing",
              });
              if (
                terminal.has(current.state) ||
                this.store.get<Pairing>("pairing", pairing.id)?.revokedAt !==
                  undefined
              )
                this.endOwnedCall(current);
            }
          });
        } catch (error) {
          if (error instanceof PreflightBlocked) {
            this.store.putEffect({
              ...effect,
              state: "pending",
              result: {
                reason:
                  "Read-only readiness blocked dispatch; no external effect attempted.",
              },
            });
            continue;
          }
          this.store.putEffect({
            ...effect,
            state: "unknown",
            result: {
              reason:
                "External outcome uncertain; reconcile the existing effect ID.",
            },
          });
          if (effect.kind === "call") {
            this.store.put("attention", {
              ...this.store.get<AttentionRequest>("attention", request.id)!,
              state: "unknown",
            });
            const call = this.store.get<CallSession>(
              "call",
              String(effect.payload.localCallId),
            );
            if (call) this.store.put("call", { ...call, state: "unknown" });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
  doctor(raw: string) {
    const c = this.credential(raw),
      session =
        c.kind === "session" ? this.authenticateSession(raw) : undefined;
    const pairing = this.pairing(session?.pairingId ?? c.subjectId),
      now = this.clock();
    const unknownEffects = this.store
      .effects("unknown")
      .filter((e) => e.payload.pairingId === pairing.id).length;
    const checks: ReadinessCheck[] = [];
    const mode =
      this.store.state<string>("runtime:mode") ?? this.transport.mode;
    if (mode === "live") {
      const transport =
        this.store.state<TransportReadiness>("native-preflight");
      if (
        transport &&
        transport.bindingFingerprint ===
          this.store.state<string>("native-binding-fingerprint") &&
        freshEvidence(transport.checkedAt, now)
      )
        checks.push(...transport.checks);
      else
        checks.push({
          id: "transport_evidence",
          status: "unknown",
          message:
            "Fresh read-only transport preflight evidence is unavailable.",
          nextAction:
            "Run live preflight with the protected configuration; no call is needed.",
        });
      const device = this.store.state<DeviceReadiness>(
        `device-readiness:${pairing.id}`,
      );
      if (
        device &&
        device.deviceId === pairing.deviceId &&
        device.memberId === pairing.memberId &&
        device.displayId === pairing.displayId &&
        device.bindingFingerprint ===
          this.store.state<string>("native-binding-fingerprint") &&
        freshEvidence(device.checkedAt, now)
      )
        checks.push(...device.checks);
      else
        checks.push({
          id: "paired_device",
          status: "unknown",
          message:
            "Fresh evidence for this member's exact Mac/display is unavailable.",
          nextAction:
            "Run scoped helper readiness; grant permissions and enable locally if required.",
        });
    } else
      checks.push({
        id: "runtime_mode",
        status: "fail",
        message:
          mode === "simulation"
            ? "Simulation is available; no live line or handset delivery is verified."
            : "Standby permits owned cleanup and read-only checks, not new live work.",
        nextAction:
          "Complete the controlled handoff and explicit live gates before live acceptance.",
      });
    checks.push({
      id: "pairing_permission",
      status: pairing.allowView ? "pass" : "fail",
      message: "This pairing must explicitly authorize screen viewing.",
    });
    checks.push({
      id: "unknown_effects",
      status: unknownEffects === 0 ? "pass" : "fail",
      message:
        unknownEffects === 0
          ? "No uncertain effects are retained for this pairing."
          : "Uncertain effects require reconciliation before live readiness.",
      ...(unknownEffects
        ? {
            nextAction:
              "Inspect existing provider/action IDs; never retry with a new key.",
          }
        : {}),
    });
    checks.push({
      id: "session_heartbeat",
      status: !session
        ? "not_applicable"
        : now - (session.lastSeenAt ?? session.createdAt) < 20000
          ? "pass"
          : "fail",
      message: session
        ? "The exact connector session must maintain an explicit heartbeat."
        : "Connect an agent session after pairing readiness is established.",
    });
    const liveReady =
      mode === "live" &&
      checks.every((c) => c.status === "pass" || c.status === "not_applicable");
    return {
      mode,
      pairing,
      ...(session ? { session } : {}),
      ready: mode === "simulation" ? pairing.allowView : liveReady,
      unknownEffects,
      physicalAcceptance: false,
      readiness: { checkedAt: now, mode, liveReady, checks },
    };
  }
}
