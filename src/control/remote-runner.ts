import type { ClawdTime } from "../attention/service.js";
import { DomainError } from "../attention/service.js";
import type {
  ExecutionResult,
  ExecutionRunner,
  JobBinding,
  RunnerCapabilities,
  RunnerEvent,
  RunnerRequest,
} from "../contracts.js";
import { hash } from "../storage/security.js";
interface Connection {
  at: number;
  version: string;
  projectRoot: string;
  externalSessionId: string;
}
interface Pending {
  request: RunnerRequest;
  emit: (event: RunnerEvent) => void;
  signal: AbortSignal;
  finish: (result: ExecutionResult) => void;
  claimed: boolean;
}
/** Authenticated pull worker, never a push into an idle desktop chat. Payloads stay transient. */
export class RemoteExecutionRunner implements ExecutionRunner {
  private connections = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  constructor(
    private service: ClawdTime,
    private enabled: boolean,
    readonly id:
      | "remote-codex-app-server"
      | "remote-documents" = "remote-codex-app-server",
  ) {}
  private owned(binding: JobBinding) {
    const session = this.service.store.get<
      import("../contracts.js").AgentSession
    >("session", binding.sessionId);
    const pairing = this.service.pairing(binding.pairingId);
    if (
      !session ||
      pairing.memberId !== binding.memberId ||
      session.pairingId !== pairing.id ||
      session.state === "stopped" ||
      session.conversation?.runnerId !== this.id ||
      session.conversation.executionSession !== "api_managed" ||
      this.service.clock() - (session.lastSeenAt ?? session.createdAt) >=
        20_000 ||
      (session.lastSeenAt ?? session.createdAt) > this.service.clock() + 1000
    )
      throw new DomainError(403, "Selected live worker binding required.");
    this.service.assertExecutionAllowed(session);
    if (this.id === "remote-documents") {
      const grant = this.service.store.get<
        import("../contracts.js").DocumentRootGrant
      >("document_root_grant", `docgrant_${hash(session.id).slice(0, 40)}`);
      if (
        !session.documentAccess ||
        session.documentAccess.expiresAt <= this.service.clock() ||
        !grant ||
        grant.state !== "active" ||
        grant.expiresAt <= this.service.clock() ||
        grant.sessionId !== session.id ||
        grant.pairingId !== binding.pairingId ||
        grant.memberId !== binding.memberId ||
        grant.projectRoot !== session.projectRoot
      )
        throw new DomainError(403, "The local document grant has closed.");
    }
    return session;
  }
  capabilities(binding?: JobBinding): RunnerCapabilities {
    if (binding) this.owned(binding);
    const connection = binding
      ? this.connections.get(binding.sessionId)
      : undefined;
    const available =
      this.enabled &&
      (binding
        ? !!connection && this.service.clock() - connection.at < 10_000
        : [...this.connections.values()].some(
            (c) => this.service.clock() - c.at < 10_000,
          ));
    return {
      id: this.id,
      host:
        this.id === "remote-documents" ? "local_documents" : "codex_app_server",
      version: connection?.version ?? "awaiting_worker",
      available,
      reason: available
        ? undefined
        : "Explicit local executor worker is disconnected.",
      taskKinds: this.id === "remote-documents" ? ["document"] : ["file"],
      nativeControl: "none",
      customControl: false,
      cancellation: "cooperative",
    };
  }
  ready(binding: JobBinding, details: Omit<Connection, "at">) {
    this.owned(binding);
    if (!this.enabled)
      throw new DomainError(409, "Remote executor admission disabled.");
    const session = this.service.store.get<
      import("../contracts.js").AgentSession
    >("session", binding.sessionId);
    if (
      !session ||
      session.pairingId !== binding.pairingId ||
      session.conversation?.runnerId !== this.id ||
      details.projectRoot !== session.projectRoot ||
      details.externalSessionId !== session.externalSessionId
    )
      throw new DomainError(
        403,
        "Worker identity does not match selected managed session.",
      );
    if (!this.connections.has(session.id) && this.connections.size >= 100)
      throw new DomainError(409, "Worker capacity reached.");
    this.connections.set(session.id, { ...details, at: this.service.clock() });
    return { ready: true };
  }
  next(binding: JobBinding, eventId: string) {
    if (!this.capabilities(binding).available)
      throw new DomainError(409, "Worker heartbeat is stale.");
    const key = `remote-claim:${binding.sessionId}:${eventId}`;
    const prior = this.service.store.event<{ dispatchId: string }>(key);
    if (prior) {
      const value = this.pending.get(prior.result.dispatchId);
      return value ? { dispatch: value.request } : {};
    }
    const pending = [...this.pending.values()].find(
      (p) => p.request.job.sessionId === binding.sessionId && !p.claimed,
    );
    if (!pending) return {};
    // Claim before response; a lost response is unknown, never re-issued to another worker.
    pending.claimed = true;
    this.service.store.recordEvent(key, hash(JSON.stringify(binding)), {
      dispatchId: pending.request.job.dispatchId,
    });
    return { dispatch: pending.request };
  }
  private dispatch(binding: JobBinding, dispatchId: string) {
    this.owned(binding);
    const p = this.pending.get(dispatchId);
    if (
      !p ||
      p.request.job.sessionId !== binding.sessionId ||
      p.request.job.pairingId !== binding.pairingId ||
      p.request.job.memberId !== binding.memberId ||
      !p.claimed
    )
      throw new DomainError(404, "Dispatch unavailable to this worker.");
    return p;
  }
  /** Read the exact claimed request; asset uploads cannot choose their own job or scope. */
  request(binding: JobBinding, dispatchId: string) {
    return this.dispatch(binding, dispatchId).request;
  }
  assertActive(binding: JobBinding, dispatchId: string) {
    const p = this.dispatch(binding, dispatchId);
    if (p.signal.aborted) throw new DomainError(409, "Execution was stopped.");
    return p.request;
  }
  event(binding: JobBinding, dispatchId: string, event: RunnerEvent) {
    const p = this.dispatch(binding, dispatchId);
    p.emit(event);
    return { accepted: true };
  }
  command(binding: JobBinding, dispatchId: string) {
    const p = this.dispatch(binding, dispatchId);
    return { cancelRequested: p.signal.aborted };
  }
  result(binding: JobBinding, dispatchId: string, result: ExecutionResult) {
    this.owned(binding);
    const key = `remote-result:${dispatchId}`,
      fingerprint = hash(JSON.stringify({ binding, result }));
    const previous = this.service.store.event(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new DomainError(409, "Result identity changed.");
      return { accepted: true };
    }
    const pending = this.pending.get(dispatchId);
    if (pending) this.dispatch(binding, dispatchId);
    else {
      const dispatch = this.service.store.get<{ jobId: string }>(
        "job_dispatch",
        dispatchId,
      );
      const job =
        dispatch &&
        this.service.store.get<import("../contracts.js").ConversationJob>(
          "conversation_job",
          dispatch.jobId,
        );
      if (
        !job ||
        job.sessionId !== binding.sessionId ||
        job.pairingId !== binding.pairingId ||
        job.memberId !== binding.memberId
      )
        throw new DomainError(404, "Original dispatch unavailable.");
    }
    this.service.store.transaction(() => {
      this.service.store.recordEvent(key, fingerprint, { received: true });
      this.service.store.put("remote_result_receipt", {
        id: dispatchId,
        sessionId: binding.sessionId,
        outcome: result.outcome,
        unresolvedEffectIds: result.unresolvedEffectIds,
        ...(result.verification ? { verification: result.verification } : {}),
        reconciliationRequired: !pending,
      });
    });
    // A late receipt is evidence, not permission to overwrite the durable unknown.
    pending?.finish(result);
    return {
      accepted: true,
      ...(!pending ? { reconciliationRequired: true } : {}),
    };
  }
  run(
    request: RunnerRequest,
    emit: (event: RunnerEvent) => void,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const dispatchId = request.job.dispatchId;
    if (
      !dispatchId ||
      !this.capabilities(request.job).available ||
      request.intent.kind !==
        (this.id === "remote-documents" ? "document" : "file")
    )
      return Promise.resolve({
        outcome: "failed",
        summary: "Worker unavailable.",
        unresolvedEffectIds: [],
      });
    if (this.pending.has(dispatchId))
      return Promise.resolve({
        outcome: "unknown",
        summary: "Dispatch already active.",
        unresolvedEffectIds: [dispatchId],
      });
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: ExecutionResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(cancelTimer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(dispatchId);
        resolve(result);
      };
      const unknown = () =>
        finish({
          outcome: "unknown",
          summary: "Worker outcome requires reconciliation.",
          unresolvedEffectIds: [dispatchId],
        });
      const timer = setTimeout(unknown, 120_000);
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        const p = this.pending.get(dispatchId);
        if (p && !p.claimed)
          finish({
            outcome: "canceled",
            summary: "Canceled before worker claim.",
            unresolvedEffectIds: [],
          });
        else cancelTimer = setTimeout(unknown, 10_000);
      };
      this.pending.set(dispatchId, {
        request,
        emit,
        signal,
        finish,
        claimed: false,
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
