import {
  documentOperationSchema,
  documentResultSchema,
} from "../document-contracts.js";
import { JobTiming } from "../control/job-timing.js";
import { z } from "zod";
import type {
  AgentSession,
  ConversationJob,
  ExecutionResult,
  ExecutionRunner,
  JobBinding,
  JobIntent,
  JobSource,
  RunnerCapabilities,
  RunnerEvent,
} from "../contracts.js";
import { DomainError, hash, id } from "../storage/security.js";
import type { ClawdTime } from "./service.js";

const identity = z.string().trim().min(1).max(512);
const bindingSchema = z
  .object({ sessionId: identity, pairingId: identity, memberId: identity })
  .strict();
const sourceSchema = z
  .object({ channel: z.enum(["text", "voice"]), eventId: identity })
  .strict();
const intentSchema = z
  .object({
    instruction: z.string().trim().min(1).max(8000),
    kind: z.enum(["file", "desktop", "document"]),
    document: documentOperationSchema.optional(),
    preference: z.enum(["auto", "native", "custom"]),
    target: z.string().trim().min(1).max(512).optional(),
    grantId: identity.optional(),
    verification: z
      .object({
        kind: z.literal("file_contains"),
        path: identity,
        expected: z.string().min(1).max(8000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.kind === "document") === !!value.document,
    "Document operation is required only for document jobs.",
  );
const final = new Set(["succeeded", "failed", "canceled", "unknown"]);
const inflight = new Set(["running", "waiting_approval", "cancel_requested"]);
const summaries: Record<ExecutionResult["outcome"], string> = {
  succeeded: "The executor independently verified the requested result.",
  failed: "The executor did not verify the requested result.",
  canceled: "The executor confirmed that execution stopped.",
  unknown:
    "The execution outcome is unresolved; it will not be repeated automatically.",
};

/** Durable job/dispatch metadata, transient instructions, one executor per session. */
export class JobBroker {
  readonly timing = new JobTiming();
  private intents = new Map<string, JobIntent>();
  private active = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  private closed = false;
  private detached = new Set<string>();
  private runners: Map<string, ExecutionRunner>;
  constructor(
    readonly service: ClawdTime,
    runners: ExecutionRunner[] = [],
  ) {
    this.runners = new Map(
      runners.map((runner) => [runner.capabilities().id, runner]),
    );
    if (this.runners.size !== runners.length)
      throw new Error("Duplicate execution runner identity.");
    service.store.transaction(() => {
      for (const job of service.store.all<ConversationJob>(
        "conversation_job",
      )) {
        if (inflight.has(job.state)) {
          if (job.dispatchId) {
            const prior = service.store.get<{ id: string }>(
              "job_dispatch",
              job.dispatchId,
            );
            service.store.put("job_dispatch", {
              ...prior,
              id: job.dispatchId,
              jobId: job.id,
              state: "unknown",
              interruptedAt: service.clock(),
            });
          }
          this.save({
            ...job,
            state: "unknown",
            progress: "process_interrupted",
          });
        } else if (job.state === "queued") {
          this.retirePendingDispatch(job, "waiting_clarification");
          this.save({
            ...job,
            state: "waiting_clarification",
            progress: "context_lost",
          });
        }
      }
    });
  }
  private owned(input: JobBinding): AgentSession {
    const binding = bindingSchema.parse({
      sessionId: input.sessionId,
      pairingId: input.pairingId,
      memberId: input.memberId,
    });
    const session = this.service.store.get<AgentSession>(
      "session",
      binding.sessionId,
    );
    const pairing = this.service.pairing(binding.pairingId);
    if (session) this.service.assertExecutionAllowed(session);
    if (
      !session ||
      session.pairingId !== pairing.id ||
      pairing.memberId !== binding.memberId
    )
      throw new DomainError(
        403,
        "Job identity does not match the selected session.",
      );
    if (
      session.protocolVersion !== 2 ||
      session.conversation?.version !== 1 ||
      session.conversation.executionSession !== "api_managed"
    )
      throw new DomainError(
        409,
        "This session has not negotiated asynchronous execution.",
      );
    if (
      session.state === "stopped" ||
      this.service.clock() - (session.lastSeenAt ?? session.createdAt) >=
        20_000 ||
      (session.lastSeenAt ?? session.createdAt) > this.service.clock() + 1000
    )
      throw new DomainError(
        409,
        "The selected execution session is unavailable.",
      );
    return session;
  }
  private key(binding: JobBinding) {
    return `job-stream:${binding.sessionId}`;
  }
  currentSequence(binding: JobBinding): number {
    this.owned(binding);
    return this.service.store.state<number>(this.key(binding)) ?? 0;
  }
  sequence(binding: JobBinding, input: JobSource): number {
    this.owned(binding);
    const source = sourceSchema.parse(input),
      key = `job-sequence:${binding.sessionId}:${source.channel}:${source.eventId}`;
    const fingerprint = hash(JSON.stringify({ binding, source }));
    return this.service.store.transaction(() => {
      const prior = this.service.store.event<{ sequence: number }>(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Conversation event identity changed.");
        return prior.result.sequence;
      }
      const sequence = this.currentSequence(binding) + 1;
      if (!Number.isSafeInteger(sequence))
        throw new DomainError(409, "Conversation sequence capacity reached.");
      this.service.store.saveState(this.key(binding), sequence);
      this.service.store.recordEvent(key, fingerprint, { sequence });
      return sequence;
    });
  }
  /** Hold conflicting actions while the current utterance is interpreted. Expiry is not permission. */
  hold(binding: JobBinding, input: JobSource, ttlMs = 10_000): number {
    const source = sourceSchema.parse(input);
    z.number().int().min(1).max(30_000).parse(ttlMs);
    return this.service.store.transaction(() => {
      const sequence = this.sequence(binding, source);
      if (sequence !== this.currentSequence(binding)) return sequence;
      const key = `job-hold-event:${binding.sessionId}:${source.channel}:${source.eventId}`;
      if (!this.service.store.event(key)) {
        this.service.store.saveState(`job-hold:${binding.sessionId}`, {
          sequence,
          active: true,
          expiresAt: this.service.clock() + ttlMs,
        });
        this.service.store.recordEvent(key, hash(JSON.stringify(source)), {
          sequence,
        });
      }
      return sequence;
    });
  }
  clearHold(binding: JobBinding, sequence: number) {
    this.owned(binding);
    const hold = this.service.store.state<{
      sequence: number;
      active: boolean;
    }>(`job-hold:${binding.sessionId}`);
    if (
      hold?.sequence === sequence &&
      sequence === this.currentSequence(binding)
    )
      this.service.store.saveState(`job-hold:${binding.sessionId}`, {
        sequence,
        active: false,
      });
  }
  capabilities(binding: JobBinding): RunnerCapabilities {
    const session = this.owned(binding),
      runnerId = session.conversation!.runnerId;
    return (
      this.runners.get(runnerId)?.capabilities(binding) ?? {
        id: runnerId,
        host: "unavailable",
        available: false,
        reason: "No programmatic execution host is connected.",
        version: "unavailable",
        nativeControl: "none",
        customControl: false,
        cancellation: "none",
      }
    );
  }
  private ownedJobs(binding: JobBinding): ConversationJob[] {
    this.owned(binding);
    return this.service.store
      .all<ConversationJob>("conversation_job")
      .filter(
        (job) =>
          job.sessionId === binding.sessionId &&
          job.pairingId === binding.pairingId &&
          job.memberId === binding.memberId,
      );
  }
  list(binding: JobBinding): ConversationJob[] {
    return this.ownedJobs(binding).slice(-100);
  }
  status(binding: JobBinding, jobId: string): ConversationJob {
    this.owned(binding);
    const job = this.service.store.get<ConversationJob>(
      "conversation_job",
      identity.parse(jobId),
    );
    if (
      !job ||
      job.sessionId !== binding.sessionId ||
      job.pairingId !== binding.pairingId ||
      job.memberId !== binding.memberId
    )
      throw new DomainError(404, "Job does not belong to this session.");
    return job;
  }
  private retirePendingDispatch(
    job: ConversationJob,
    state: "canceled" | "superseded" | "waiting_clarification",
  ) {
    const key = `${job.id}:${job.revision}`;
    const receipt = this.service.store.get<{ id: string; state: string }>(
      "job_dispatch",
      key,
    );
    if (receipt?.state === "pending")
      this.service.store.put("job_dispatch", {
        ...receipt,
        state,
        closedAt: this.service.clock(),
      });
  }
  private save(job: ConversationJob) {
    return this.service.store.put<ConversationJob>("conversation_job", {
      ...job,
      updatedAt: this.service.clock(),
    });
  }
  private operation(
    binding: JobBinding,
    source: JobSource,
    body: unknown,
    run: () => ConversationJob,
  ) {
    const key = `job-command:${binding.sessionId}:${source.channel}:${source.eventId}`;
    const fingerprint = hash(JSON.stringify({ binding, source, body }));
    return this.service.store.transaction(() => {
      const prior = this.service.store.event<{ jobId: string }>(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError(409, "Job event identity changed.");
        return this.status(binding, prior.result.jobId);
      }
      const job = run();
      this.service.store.recordEvent(key, fingerprint, { jobId: job.id });
      return job;
    });
  }
  private requireDocument(binding: JobBinding, intent: JobIntent) {
    if (intent.kind !== "document") return;
    const session = this.owned(binding),
      grantId = intent.document?.grantId;
    const grant =
      grantId &&
      this.service.store.get<import("../contracts.js").DocumentRootGrant>(
        "document_root_grant",
        grantId,
      );
    if (
      session.conversation?.runnerId !== "remote-documents" ||
      !session.documentAccess ||
      session.documentAccess.version !== 1 ||
      session.documentAccess.readOnly !== true ||
      session.documentAccess.expiresAt <= this.service.clock() ||
      !grant ||
      grant.id !== `docgrant_${hash(session.id).slice(0, 40)}` ||
      grant.state !== "active" ||
      grant.sessionId !== session.id ||
      grant.pairingId !== binding.pairingId ||
      grant.memberId !== binding.memberId ||
      grant.projectRoot !== session.projectRoot ||
      grant.hostId !== session.hostId ||
      grant.expiresAt !== session.documentAccess.expiresAt ||
      grant.expiresAt <= this.service.clock()
    )
      throw new DomainError(
        403,
        "Exact active read-only document root grant is required.",
      );
  }
  private requireCapability(caps: RunnerCapabilities, intent: JobIntent) {
    if (
      !caps.available ||
      (caps.taskKinds && !caps.taskKinds.includes(intent.kind))
    )
      throw new DomainError(
        409,
        "Selected programmatic executor is unavailable.",
      );
    if (
      intent.kind === "desktop" &&
      (intent.preference === "native"
        ? caps.nativeControl === "none"
        : intent.preference === "custom"
          ? !caps.customControl
          : caps.nativeControl === "none" && !caps.customControl)
    )
      throw new DomainError(
        409,
        "Selected executor cannot control the requested surface.",
      );
  }
  submit(
    binding: JobBinding,
    input: JobSource,
    rawIntent: JobIntent,
  ): ConversationJob {
    const session = this.owned(binding),
      source = sourceSchema.parse(input),
      intent = intentSchema.parse(rawIntent);
    return this.operation(binding, source, { op: "submit", intent }, () => {
      if (this.closed)
        throw new DomainError(409, "Execution broker is stopped.");
      this.requireDocument(binding, intent);
      this.requireCapability(this.capabilities(binding), intent);
      const jobs = this.ownedJobs(binding);
      if (
        this.service.store
          .all<ConversationJob>("conversation_job")
          .filter((job) => job.sessionId === binding.sessionId).length >= 10_000
      )
        throw new DomainError(
          409,
          "Job receipt capacity reached; reconcile and archive before another session.",
        );
      if (jobs.some((job) => job.state === "unknown"))
        throw new DomainError(
          409,
          "An unresolved execution blocks another dispatch.",
        );
      if (jobs.filter((job) => !final.has(job.state)).length >= 16)
        throw new DomainError(409, "Execution queue is full.");
      const now = this.service.clock();
      const job: ConversationJob = {
        ...binding,
        id: id("job"),
        version: 1,
        source,
        runnerId: session.conversation!.runnerId,
        revision: 1,
        instructionSequence: this.sequence(binding, source),
        kind: intent.kind,
        preference: intent.preference,
        state: "queued",
        createdAt: now,
        updatedAt: now,
        progress: "queued",
      };
      this.intents.set(job.id, intent);
      this.service.store.put("job_dispatch", {
        id: `${job.id}:1`,
        jobId: job.id,
        revision: 1,
        state: "pending",
        createdAt: now,
      });
      this.timing.record(job.id, "job_accepted", job.revision);
      return this.save(job);
    });
  }
  revise(
    binding: JobBinding,
    input: JobSource,
    jobId: string,
    expectedRevision: number,
    rawIntent: JobIntent,
  ): ConversationJob {
    this.owned(binding);
    const source = sourceSchema.parse(input),
      intent = intentSchema.parse(rawIntent);
    return this.operation(
      binding,
      source,
      { op: "revise", jobId, expectedRevision, intent },
      () => {
        const job = this.status(binding, jobId);
        this.requireDocument(binding, intent);
        this.requireCapability(this.capabilities(binding), intent);
        if (job.revision >= 128)
          throw new DomainError(409, "Job revision capacity reached.");
        if (job.revision !== expectedRevision || final.has(job.state))
          throw new DomainError(409, "Job revision is stale or terminal.");
        const running = inflight.has(job.state);
        const revised = this.save({
          ...job,
          revision: job.revision + 1,
          instructionSequence: this.sequence(binding, source),
          kind: intent.kind,
          preference: intent.preference,
          state: running ? "cancel_requested" : "queued",
          progress: running ? "revision_stop_requested" : "queued",
          result: undefined,
        });
        this.intents.set(job.id, intent);
        if (running) this.active.get(job.id)?.abort.abort();
        else {
          this.retirePendingDispatch(job, "superseded");
          this.service.store.put("job_dispatch", {
            id: `${job.id}:${revised.revision}`,
            jobId: job.id,
            revision: revised.revision,
            state: "pending",
            createdAt: this.service.clock(),
          });
        }
        return revised;
      },
    );
  }
  cancel(
    binding: JobBinding,
    input: JobSource,
    jobId: string,
    expectedRevision: number,
  ): ConversationJob {
    this.owned(binding);
    const source = sourceSchema.parse(input);
    return this.operation(
      binding,
      source,
      { op: "cancel", jobId, expectedRevision },
      () => {
        const job = this.status(binding, jobId);
        if (job.revision !== expectedRevision)
          throw new DomainError(409, "Job revision is stale.");
        if (final.has(job.state)) return job;
        const running = inflight.has(job.state);
        const next = this.save({
          ...job,
          instructionSequence: this.sequence(binding, source),
          state: running ? "cancel_requested" : "canceled",
          progress: running ? "stop_requested" : "canceled",
        });
        this.intents.delete(job.id);
        if (running) this.active.get(job.id)?.abort.abort();
        else this.retirePendingDispatch(job, "canceled");
        return next;
      },
    );
  }
  cancelAll(binding: JobBinding, input: JobSource): ConversationJob[] {
    this.owned(binding);
    const source = sourceSchema.parse(input);
    return this.service.store.transaction(() => {
      const key = `job-stop:${binding.sessionId}:${source.channel}:${source.eventId}`;
      const prior = this.service.store.event<{ jobIds: string[] }>(key);
      if (prior)
        return prior.result.jobIds.map((jobId) => this.status(binding, jobId));
      const sequence = this.sequence(binding, source);
      const jobs = this.ownedJobs(binding);
      for (const job of jobs) {
        if (final.has(job.state)) continue;
        const running = inflight.has(job.state);
        this.save({
          ...job,
          instructionSequence: sequence,
          state: running ? "cancel_requested" : "canceled",
          progress: running ? "stop_requested" : "canceled",
        });
        this.intents.delete(job.id);
        if (running) this.active.get(job.id)?.abort.abort();
        else this.retirePendingDispatch(job, "canceled");
      }
      this.service.store.recordEvent(
        key,
        hash(JSON.stringify({ binding, source })),
        { jobIds: jobs.map((job) => job.id) },
      );
      return this.list(binding);
    });
  }
  queueReply(
    binding: JobBinding,
    input: JobSource,
    sequence: number,
    text: string,
    jobId?: string,
  ) {
    this.owned(binding);
    const source = sourceSchema.parse(input);
    if (source.channel !== "text") return;
    if (
      this.service.store.state<{ active: boolean }>(
        `job-hold:${binding.sessionId}`,
      )?.active
    )
      throw new DomainError(409, "Conversation reply awaits finalized intent.");
    if (sequence !== this.currentSequence(binding))
      throw new DomainError(409, "Conversation reply is stale.");
    const content = z.string().trim().min(1).max(1200).parse(text);
    const job = jobId ? this.status(binding, jobId) : undefined;
    const effectId = `broker-reply:${hash(`${binding.sessionId}:${source.channel}:${source.eventId}`)}`;
    const previous = this.service.store.effect(effectId);
    if (previous) {
      if (previous.payload.textFingerprint !== hash(content))
        throw new DomainError(409, "Conversation reply identity changed.");
      return previous;
    }
    return this.service.store.putEffect({
      id: effectId,
      kind: "message",
      state: "pending",
      createdAt: this.service.clock(),
      payload: {
        brokerUpdate: 1,
        ...binding,
        sequence,
        source,
        text: content,
        textFingerprint: hash(content),
        expiresAt: this.service.clock() + 600_000,
        ...(job
          ? { jobId: job.id, jobRevision: job.revision, jobState: job.state }
          : {}),
      },
    });
  }
  dispatch(): void {
    if (this.closed) return;
    for (const [jobId, execution] of this.active) {
      const job = this.service.store.get<ConversationJob>(
        "conversation_job",
        jobId,
      )!;
      try {
        this.owned(job);
        const intent = this.intents.get(job.id);
        if (intent) this.requireDocument(job, intent);
      } catch {
        this.save({
          ...job,
          state: "cancel_requested",
          progress: "authorization_closed",
        });
        execution.abort.abort();
      }
    }
    for (const job of this.service.store.all<ConversationJob>(
      "conversation_job",
    )) {
      if (
        this.service.store.state<{ active: boolean }>(
          `job-hold:${job.sessionId}`,
        )?.active
      )
        continue;
      if (job.state !== "queued" || this.active.has(job.id)) continue;
      const sameSession = this.service.store
        .all<ConversationJob>("conversation_job")
        .filter((other) => other.sessionId === job.sessionId);
      if (
        sameSession.some(
          (other) =>
            other.id !== job.id &&
            (inflight.has(other.state) || other.state === "unknown"),
        )
      )
        continue;
      let session: AgentSession;
      try {
        session = this.owned(job);
      } catch {
        this.intents.delete(job.id);
        this.save({
          ...job,
          state: "canceled",
          progress: "authorization_closed",
        });
        continue;
      }
      const runner = this.runners.get(job.runnerId),
        intent = this.intents.get(job.id);
      if (!runner || !intent) {
        this.save({
          ...job,
          state: "waiting_clarification",
          progress: intent ? "runner_unavailable" : "context_lost",
        });
        continue;
      }
      try {
        this.requireDocument(job, intent);
        const capabilities = runner.capabilities(job);
        if (!capabilities.available)
          throw new DomainError(409, "Runner unavailable.");
        this.requireCapability(capabilities, intent);
      } catch {
        this.save({
          ...job,
          state: "waiting_clarification",
          progress: "runner_unavailable",
        });
        continue;
      }
      const abort = new AbortController(),
        dispatchId = `${job.id}:${job.revision}`;
      const claimed = this.service.store.transaction(() => {
        if (
          this.service.store.get<ConversationJob>("conversation_job", job.id)
            ?.state !== "queued"
        )
          return false;
        this.service.store.put("job_dispatch", {
          id: dispatchId,
          jobId: job.id,
          revision: job.revision,
          state: "dispatching",
          createdAt: this.service.clock(),
        });
        this.save({
          ...job,
          dispatchId,
          state: "running",
          progress: "dispatching",
        });
        return true;
      });
      if (!claimed) continue;
      this.timing.record(job.id, "dispatch_started", job.revision);
      const emit = (input: RunnerEvent) => {
        if (this.detached.has(job.id)) return;
        const parsedEvent = z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("accepted") }).strict(),
            z.object({ type: z.literal("waiting_approval") }).strict(),
            z
              .object({
                type: z.literal("progress"),
                stage: z.enum(["reasoning", "observing", "input", "verifying"]),
              })
              .strict(),
          ])
          .safeParse(input);
        if (!parsedEvent.success) return;
        const event = parsedEvent.data;
        const current = this.service.store.get<ConversationJob>(
          "conversation_job",
          job.id,
        )!;
        if (
          current.revision !== job.revision ||
          !inflight.has(current.state) ||
          abort.signal.aborted
        )
          return;
        if (event.type === "accepted")
          this.timing.record(job.id, "executor_accepted", job.revision);
        if (event.type === "progress" && event.stage === "verifying")
          this.timing.record(job.id, "verification_started", job.revision);
        if (event.type === "progress" && event.stage === "observing")
          this.timing.record(job.id, "observation_started", job.revision);
        if (event.type === "progress" && event.stage === "input")
          this.timing.record(job.id, "input_started", job.revision);
        if (event.type === "accepted")
          this.service.store.put("job_dispatch", {
            id: dispatchId,
            jobId: job.id,
            revision: job.revision,
            state: "accepted",
            acceptedAt: this.service.clock(),
          });
        this.save({
          ...current,
          state:
            event.type === "waiting_approval" ? "waiting_approval" : "running",
          progress: event.type === "progress" ? event.stage : event.type,
        });
      };
      const promise = Promise.resolve()
        .then(() => {
          const canceled = {
            outcome: "canceled" as const,
            summary: "",
            unresolvedEffectIds: [],
          };
          if (abort.signal.aborted) return canceled;
          // Admission and invocation are separated by a microtask. A correction,
          // Stop or worker disconnect can arrive before any external work begins.
          try {
            this.owned(job);
          } catch {
            return canceled;
          }
          const held = this.service.store.state<{ active: boolean }>(
            `job-hold:${job.sessionId}`,
          )?.active;
          let available = true;
          try {
            this.requireDocument(job, intent);
            this.requireCapability(runner.capabilities(job), intent);
          } catch {
            available = false;
          }
          if (held || !available) {
            this.service.store.transaction(() => {
              this.save({
                ...job,
                state: held ? "queued" : "waiting_clarification",
                progress: held ? "queued" : "runner_unavailable",
              });
              this.service.store.put("job_dispatch", {
                id: dispatchId,
                jobId: job.id,
                revision: job.revision,
                state: held ? "pending" : "waiting_clarification",
                createdAt: this.service.clock(),
              });
            });
            return undefined;
          }
          return runner.run(
            {
              job: { ...job, dispatchId },
              intent,
              projectRoot: session.projectRoot,
              externalSessionId: session.externalSessionId,
            },
            emit,
            abort.signal,
          );
        })
        .then(
          (result) => {
            if (result) this.finish(job, result, intent);
          },
          () =>
            this.finish(
              job,
              {
                outcome: "unknown",
                summary: "",
                unresolvedEffectIds: [dispatchId],
              },
              intent,
            ),
        )
        .finally(() => {
          this.active.delete(job.id);
        });
      this.active.set(job.id, { abort, promise });
    }
  }
  private finish(
    started: ConversationJob,
    rawResult: ExecutionResult,
    intent: JobIntent,
  ) {
    if (this.detached.has(started.id)) return;
    const parsed = z
      .object({
        outcome: z.enum(["succeeded", "failed", "canceled", "unknown"]),
        summary: z.string().max(8000),
        document: documentResultSchema.optional(),
        unresolvedEffectIds: z
          .array(z.string().regex(/^[A-Za-z0-9:_.-]{1,512}$/))
          .max(32),
        verification: z
          .object({
            verified: z.boolean(),
            method: z.enum([
              "file_read",
              "ui_observation",
              "document_digest",
              "attachment_receipt",
            ]),
            evidenceId: identity,
          })
          .strict()
          .optional(),
      })
      .strict()
      .safeParse(rawResult);
    const raw: ExecutionResult = parsed.success
      ? parsed.data
      : {
          outcome: "unknown",
          summary: "",
          unresolvedEffectIds: [`${started.id}:${started.revision}`],
        };
    const current = this.service.store.get<ConversationJob>(
      "conversation_job",
      started.id,
    )!;
    const operation = intent.document,
      document = raw.document;
    const documentVerified =
      intent.kind === "document" &&
      operation &&
      document &&
      operation.operation === document.operation &&
      raw.verification?.verified === true &&
      raw.verification.method ===
        (operation.operation === "prepare_transfer"
          ? "attachment_receipt"
          : "document_digest") &&
      (operation.operation === "discover"
        ? document.candidates?.every(
            (candidate) => candidate.grantId === operation.grantId,
          ) &&
          new Set(document.candidates.map((candidate) => candidate.id)).size ===
            document.candidates.length
        : JSON.stringify(operation.candidate) ===
            JSON.stringify(document.candidate) &&
          (operation.operation !== "prepare_transfer" ||
            operation.transferId === document.transferId));
    const outcome =
      current.state === "unknown" || raw.unresolvedEffectIds.length
        ? "unknown"
        : raw.outcome === "succeeded" &&
            (raw.verification?.verified !== true ||
              (intent.kind === "document" && !documentVerified) ||
              (intent.kind !== "document" && !!document))
          ? operation?.operation === "prepare_transfer"
            ? "unknown"
            : "failed"
          : raw.outcome;
    const result: ExecutionResult = {
      outcome,
      summary: summaries[outcome],
      ...(outcome === "succeeded" && documentVerified ? { document } : {}),
      unresolvedEffectIds: raw.unresolvedEffectIds.length
        ? raw.unresolvedEffectIds.slice(0, 32)
        : outcome === "unknown"
          ? [`${started.id}:${started.revision}`]
          : [],
      ...(raw.verification
        ? {
            verification: {
              verified: raw.verification.verified,
              method: raw.verification.method,
              evidenceId: hash(raw.verification.evidenceId),
            },
          }
        : {}),
    };
    this.service.store.transaction(() => {
      this.service.store.put("job_dispatch", {
        id: `${started.id}:${started.revision}`,
        jobId: started.id,
        revision: started.revision,
        state: outcome,
        result,
        finishedAt: this.service.clock(),
      });
      const revised = current.revision !== started.revision;
      this.save({
        ...current,
        state:
          current.state === "unknown" || outcome === "unknown"
            ? "unknown"
            : revised
              ? "waiting_clarification"
              : outcome,
        progress:
          revised && outcome !== "unknown"
            ? "revision_requires_confirmation"
            : outcome,
        ...(revised ? {} : { result }),
      });
    });
    if (raw.verification)
      this.timing.record(
        started.id,
        "verification_completed",
        started.revision,
      );
    this.timing.record(started.id, "finished", started.revision);
    this.intents.delete(started.id);
  }
  async stop(): Promise<void> {
    this.closed = true;
    for (const [jobId, execution] of this.active) {
      const job = this.service.store.get<ConversationJob>(
        "conversation_job",
        jobId,
      )!;
      this.save({
        ...job,
        state: "cancel_requested",
        progress: "shutdown_requested",
      });
      execution.abort.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(
        [...this.active.values()].map((execution) => execution.promise),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    for (const jobId of this.active.keys()) {
      this.detached.add(jobId);
      const job = this.service.store.get<ConversationJob>(
        "conversation_job",
        jobId,
      )!;
      this.save({ ...job, state: "unknown", progress: "shutdown_unconfirmed" });
    }
    this.intents.clear();
  }
}
