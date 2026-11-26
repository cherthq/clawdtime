import { phoneTurn } from "./phone-turn.js";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { secureRead, secureWrite } from "../shared/state.js";
import type { ProactiveCallCoordinator } from "../../src/attention/proactive-coordinator.js";
import type { ProactivePolicyAuthority } from "../../src/attention/proactive-policy.js";
import type {
  CallChannel,
  CallSource,
  CallTrigger,
  ProactiveCallIntent,
} from "../../src/attention/proactive-contracts.js";
import type { AgentSession } from "./types.js";
import { DecisionDesk, type DecisionRequest } from "./decisions.js";
import type {
  ProactiveSourceEvidence,
  ProactiveViewRequest,
} from "../../src/control/proactive-preparation.js";
import type { Incident } from "./watch.js";
import { incidentSentence } from "./watch.js";
import {
  sessionKey,
  ProactiveSessions,
  ScopedSupervision,
  type EnrolledSessionRun,
} from "./proactive-sessions.js";
import type { JobFacts } from "./jobs.js";
import { JobReviews } from "./job-review.js";
import type { VerificationPlan } from "../../src/control/task-verification.js";
import { title } from "./render.js";

export type WatchChannel = "chat" | CallChannel;
export function requestedWatchChannel(words: string): WatchChannel {
  if (
    /\b(?:tell|message|text|notify)\s+me\s+(?:here|in\s+(?:this\s+)?chat)\b/i.test(
      words,
    )
  )
    return "chat";
  if (/\b(?:call|facetime|ring)(?:\s+and\s+show)?\s+me\b/i.test(words))
    return /\b(?:show|walk(?:through|\s+me\s+through)|screen)\b/i.test(words)
      ? "phone_walkthrough"
      : "phone_alert";
  return "chat";
}
const phoneWatchSchema = z.object({
  version: z.literal(2),
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  runId: z.string().nullable(),
  sessionKey: z.string().nullable(),
  projectRoot: z.string().nullable(),
  channel: z.enum(["phone_alert", "phone_walkthrough"]),
  trigger: z.literal("completion"),
  policyId: z.string().nullable(),
  askedAt: z.number(),
  expiresAt: z.number(),
  state: z.enum(["watching", "needs_setup", "queued", "canceled", "expired"]),
  reason: z.string().optional(),
  intentId: z.string().optional(),
});
export type PhoneWatch = z.infer<typeof phoneWatchSchema>;

/** The feed only submits exact source evidence. The service owns preparation/dialing. */
export class ProactiveSourceAdapter {
  readonly sessions: ProactiveSessions;
  readonly supervision: ScopedSupervision;
  private readonly file: string;
  private readonly now: () => number;
  private jobs: (() => JobFacts[]) | undefined;
  private jobReviews: JobReviews | undefined;
  constructor(
    private readonly options: {
      root: string;
      coordinator: ProactiveCallCoordinator;
      authority: ProactivePolicyAuthority;
      now?: () => number;
      views?: (intent: ProactiveCallIntent) => ProactiveViewRequest[];
      jobVerification?: {
        projectRoot: string;
        plan: VerificationPlan;
        plansByRun?: Record<string, VerificationPlan>;
        authorize: () => void;
      };
    },
  ) {
    this.now = options.now ?? Date.now;
    this.file = join(options.root, "agents", "phone-watches-v2.json");
    this.sessions = new ProactiveSessions(options.root);
    this.supervision = new ScopedSupervision(options.root, this.now);
  }
  attachJobs(jobs: () => JobFacts[]) {
    this.jobs = jobs;
    if (this.options.jobVerification)
      this.jobReviews = new JobReviews({
        root: this.options.root,
        ...this.options.jobVerification,
        jobs,
        generation: (job) => this.jobRun(job)?.runId ?? null,
        terminal: (job) =>
          ["completed", "failed"].includes(this.jobRun(job)?.state ?? ""),
      });
  }
  beforeLaunch(input: {
    jobId: string;
    runId: string;
    launchId: string;
    projectRoot: string;
    agent: string;
  }) {
    // A project policy can enroll new supported jobs; session-only policies cannot.
    const policies = this.options.authority
      .list()
      .filter(
        (p) =>
          p.scope.projectRoot === input.projectRoot &&
          !p.scope.sessionId &&
          !p.scope.taskId &&
          p.revokedAt === undefined &&
          p.expiresAt > this.now() &&
          p.triggers.includes("decision"),
      );
    if (policies.length === 1)
      this.enroll({
        policyId: policies[0]!.id,
        projectRoot: input.projectRoot,
        jobRunId: input.runId,
        expiresAt: policies[0]!.expiresAt,
      });
  }
  private jobRun(job: JobFacts): EnrolledSessionRun | null {
    const p = job.provenance;
    if (!p || !p.launcherPid || job.status === "retired_unknown") return null;
    const observed = this.sessions
      .list()
      .filter((r) => r.jobRunId === p.runId && r.projectRoot === p.projectRoot);
    if (observed.length > 1) return null;
    if (observed.length === 1) return observed[0]!;
    // Registered headless Jobs retain launcher identity even without a board process.
    if (p.exitCode === null) return null;
    return {
      version: 1,
      sessionKey: sessionKey(`job:${p.runId}`),
      runId: p.runId,
      agent: p.agent,
      projectRoot: p.projectRoot,
      pids: [p.launcherPid],
      startedAt: job.startedAt,
      at: job.startedAt,
      state: p.exitCode === 0 ? "completed" : "failed",
      jobRunId: p.runId,
    };
  }
  private pumpJobs() {
    if (!this.jobs) return;
    if (this.jobReviews) void this.jobReviews.pump().catch(() => {});
    for (const job of this.jobs()) {
      const p = job.provenance;
      if (!p || p.sharedTask || job.status === "retired_unknown") continue;
      const run = this.jobRun(job);
      if (!run || run.state === "canceled" || run.state === "ended") continue;
      if (
        this.watches().some(
          (w) =>
            w.sessionKey === run.sessionKey &&
            w.runId === run.runId &&
            ["watching", "needs_setup", "queued"].includes(w.state),
        )
      )
        continue;
      if (!p.resultDigest) {
        if (p.exitCode !== null)
          this.enqueue(
            run,
            {
              kind: "job",
              sessionId: run.sessionKey,
              runId: run.runId,
              jobId: job.id,
              launchId: p.launchId,
            },
            "failure",
            "phone_alert",
            `${job.job}: the launcher exited without a bounded result. Its effects remain unknown; no work was replayed.`,
            this.now() + 12 * 60 * 60 * 1000,
          );
        continue;
      }
      const review = this.jobReviews?.get(job);
      if (!review || review.state !== "checked" || !review.verification)
        continue;
      const passed =
        review.verification.state === "passed" &&
        (p.exitCode === 0 ||
          (p.exitCode === null && run.state === "completed"));
      const trigger = passed ? "review" : "failure";
      const channel = this.policy(
        run.projectRoot,
        run.sessionKey,
        trigger,
        "phone_walkthrough",
      )
        ? "phone_walkthrough"
        : "phone_alert";
      this.enqueue(
        run,
        {
          kind: "job",
          sessionId: run.sessionKey,
          runId: run.runId,
          jobId: job.id,
          launchId: p.launchId,
          resultDigest: p.resultDigest,
          verificationId: review.verification.id,
        },
        trigger,
        channel,
        `${job.job}: ${passed ? "independent checks passed" : "the result is blocked or its checks failed"}. ${job.result ?? "No result explanation."}`,
        this.now() + 12 * 60 * 60 * 1000,
      );
    }
  }
  watches(): PhoneWatch[] {
    if (!existsSync(this.file)) return [];
    return z.array(phoneWatchSchema).parse(secureRead(this.file));
  }
  private save(items: PhoneWatch[]) {
    secureWrite(this.file, items);
  }
  private policy(
    projectRoot: string,
    sessionId: string,
    trigger: CallTrigger,
    channel: CallChannel,
  ) {
    const choices = this.options.authority
      .list()
      .filter(
        (p) =>
          p.scope.projectRoot === projectRoot &&
          (!p.scope.sessionId || p.scope.sessionId === sessionId) &&
          !p.scope.taskId &&
          p.revokedAt === undefined &&
          p.expiresAt > this.now() &&
          p.triggers.includes(trigger) &&
          p.channels.includes(channel),
      );
    const exact = choices.filter((p) => p.scope.sessionId === sessionId);
    const selected = exact.length ? exact : choices;
    return selected.length === 1 ? selected[0] : undefined;
  }
  watch(
    session: AgentSession,
    channel: CallChannel,
  ): { ok: boolean; said: string } {
    if (phoneTurn.getStore()?.sharedTask)
      return {
        ok: false,
        said: "This shared task needs the shared callback service. No dedicated-owner call was queued.",
      };
    const watches = this.watches();
    const existing = watches.find(
      (w) =>
        w.sessionId === session.id &&
        w.channel === channel &&
        ["watching", "needs_setup", "queued"].includes(w.state),
    );
    if (existing)
      return {
        ok: true,
        said: `The ${channel === "phone_walkthrough" ? "walkthrough call" : "phone call"} watch is already retained for ${title(session)}${existing.reason ? `: ${existing.reason}` : "."}`,
      };
    const run = this.sessions.resolve(session);
    const policy = run
      ? this.policy(run.projectRoot, run.sessionKey, "completion", channel)
      : undefined;
    const reason = !run
      ? "needs setup: this session has no exact supported hook/run registration; a board state cannot prove completion"
      : !policy
        ? "needs setup: no unambiguous active calling policy authorizes this session and channel"
        : undefined;
    watches.push({
      version: 2,
      id: randomUUID(),
      sessionId: session.id,
      title: title(session),
      sessionKey: run?.sessionKey ?? null,
      runId: run?.runId ?? null,
      projectRoot: session.cwd,
      channel,
      trigger: "completion",
      policyId: policy?.id ?? null,
      askedAt: this.now(),
      expiresAt: Math.min(
        this.now() + 12 * 60 * 60 * 1000,
        policy?.expiresAt ?? Infinity,
      ),
      state: reason ? "needs_setup" : "watching",
      ...(reason ? { reason } : {}),
    });
    this.save(watches);
    return {
      ok: true,
      said: reason
        ? `Retained the requested ${channel === "phone_walkthrough" ? "walkthrough call" : "phone call"} watch for ${title(session)}; ${reason}. It will not be replaced by a chat notification.`
        : `Registered a ${channel === "phone_walkthrough" ? "prepared walkthrough call" : "phone call"} for the exact current run of ${title(session)} when its terminal hook reports completion. Independent verification remains separate.`,
    };
  }
  watching() {
    return this.watches()
      .filter((w) => ["watching", "needs_setup", "queued"].includes(w.state))
      .map((w) => w.title);
  }
  unwatch(session: AgentSession) {
    const watches = this.watches();
    let changed = false;
    for (const watch of watches)
      if (
        watch.sessionId === session.id &&
        ["watching", "needs_setup", "queued"].includes(watch.state)
      ) {
        if (watch.intentId)
          this.options.coordinator.cancel(watch.intentId, "watch_canceled");
        watch.state = "canceled";
        changed = true;
      }
    if (changed) this.save(watches);
    return changed;
  }
  private enqueue(
    run: EnrolledSessionRun,
    source: CallSource,
    trigger: CallTrigger,
    channel: CallChannel,
    brief: string,
    expiresAt: number,
    policyId?: string,
  ) {
    const policy = policyId
      ? this.options.authority.get(policyId)
      : this.policy(run.projectRoot, run.sessionKey, trigger, channel);
    if (!policy) return null;
    return this.options.coordinator.enqueue({
      source,
      scope: { ...policy.scope, sessionId: run.sessionKey },
      policyId: policy.id,
      trigger,
      channel,
      brief,
      expiresAt: Math.min(expiresAt, policy.expiresAt),
    });
  }
  /** Heartbeat is independent of panel reads. Revoked/expired policy releases hooks. */
  heartbeat() {
    this.supervision.refresh((record) => {
      const policy = this.options.authority.get(record.policyId);
      return (
        !!policy &&
        policy.revokedAt === undefined &&
        policy.expiresAt > this.now() &&
        policy.scope.projectRoot === record.projectRoot
      );
    });
  }
  /** Register before starting work, or explicitly enrolling a current exact session. */
  enroll(input: {
    policyId: string;
    projectRoot: string;
    sessionKey?: string;
    jobRunId?: string;
    expiresAt: number;
    responseSeconds?: number;
  }) {
    const p = this.options.authority.get(input.policyId);
    if (
      !p ||
      p.revokedAt !== undefined ||
      p.expiresAt <= this.now() ||
      !p.triggers.includes("decision") ||
      !!p.scope.taskId ||
      p.scope.projectRoot !== input.projectRoot ||
      (p.scope.sessionId && p.scope.sessionId !== input.sessionKey)
    )
      throw new Error("Scoped supervision lacks current exact calling policy.");
    this.supervision.register({
      ...input,
      expiresAt: Math.min(input.expiresAt, p.expiresAt),
      responseSeconds: input.responseSeconds ?? 540,
    });
  }
  pump(input: {
    pending: DecisionRequest[];
    incidents: Incident[];
    sessions: AgentSession[];
    away: boolean;
  }) {
    this.heartbeat();
    this.pumpJobs();
    const pendingIds = new Set(input.pending.map((p) => p.id));
    for (const intent of this.options.coordinator.list())
      if (
        intent.source.kind === "decision" &&
        !pendingIds.has(intent.source.decisionId) &&
        ["queued", "preparing", "ready"].includes(intent.state)
      )
        this.options.coordinator.cancel(intent.id, "decision_resolved");
    for (const request of input.pending) {
      const run = this.sessions.get(request.sessionKey);
      if (
        !run ||
        run.projectRoot !== request.cwd ||
        !["running", "waiting"].includes(run.state)
      )
        continue;
      if (
        !input.away &&
        !this.supervision.match(request.cwd, request.sessionKey, run.jobRunId)
      )
        continue;
      const channel = this.policy(
        run.projectRoot,
        run.sessionKey,
        "decision",
        "phone_walkthrough",
      )
        ? "phone_walkthrough"
        : "phone_alert";
      this.enqueue(
        run,
        {
          kind: "decision",
          sessionId: run.sessionKey,
          runId: run.runId,
          decisionId: request.id,
        },
        "decision",
        channel,
        `${request.summary}${request.answerInTerminal ? " Approval must be completed in the native terminal." : ""}`,
        request.holdUntil,
      );
    }
    if (input.away)
      for (const incident of input.incidents) {
        if (incident.kind !== "waiting" && incident.kind !== "failed") continue;
        const session = input.sessions.find((s) => s.id === incident.sessionId);
        const run = session ? this.sessions.resolve(session) : null;
        if (!run || input.pending.some((p) => p.sessionKey === run.sessionKey))
          continue;
        this.enqueue(
          run,
          {
            kind: "session",
            sessionId: run.sessionKey,
            runId: run.runId,
            enrollmentId: run.sessionKey,
            terminalEventId: incident.id,
          },
          incident.kind === "waiting" ? "waiting" : "failure",
          "phone_alert",
          incidentSentence(incident, this.now()),
          this.now() + 10 * 60_000,
        );
      }
    const watches = this.watches();
    let changed = false;
    for (const watch of watches) {
      if (!["watching", "needs_setup"].includes(watch.state)) continue;
      if (this.now() >= watch.expiresAt) {
        watch.state = "expired";
        watch.reason = "watch_expired_without_terminal_evidence";
        changed = true;
        continue;
      }
      if (!watch.sessionKey || !watch.runId) continue;
      const run = this.sessions.get(watch.sessionKey);
      if (!run || run.runId !== watch.runId) {
        watch.state = "canceled";
        watch.reason = "watched_run_changed_or_unavailable";
        changed = true;
        continue;
      }
      if (run.state === "canceled" || run.state === "ended") {
        watch.state = "canceled";
        watch.reason = "run_canceled_or_ended_without_completion";
        changed = true;
        continue;
      }
      if (run.state !== "completed" && run.state !== "failed") continue;
      const result = this.enqueue(
        run,
        {
          kind: "session",
          sessionId: run.sessionKey,
          runId: run.runId,
          enrollmentId: watch.id,
          terminalEventId: `${run.runId}:${run.at}`,
        },
        run.state === "failed" ? "failure" : "completion",
        watch.channel,
        `${watch.title}: the exact run ${run.state === "failed" ? "failed" : "reported completion"}. Its effects have not been independently verified.`,
        watch.expiresAt,
        watch.policyId ?? undefined,
      );
      if (result) {
        watch.intentId = result.record.id;
        watch.state = "queued";
        delete watch.reason;
        changed = true;
      }
    }
    if (changed) this.save(watches);
  }
  inspectSource(intent: ProactiveCallIntent): ProactiveSourceEvidence {
    const pending = new DecisionDesk(this.options.root, this.now).pending();
    const current = this.validate(intent, pending),
      source = intent.source;
    const bounded = (value: string) =>
      value.replace(/\p{C}/gu, " ").trim().slice(0, 2000) ||
      "No explanation available.";
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const evidence: ProactiveSourceEvidence = {
      current,
      sourceFingerprint: digest(source),
      goal: bounded(intent.brief),
      status: "unverified",
      summary: bounded(intent.brief),
      checks: [],
      artifacts: [],
      views: current ? (this.options.views?.(intent) ?? []) : [],
    };
    if (source.kind === "decision") {
      const request = pending.find((p) => p.id === source.decisionId);
      if (request) {
        evidence.status = "decision";
        evidence.goal = bounded(request.summary);
        evidence.question = bounded(
          request.answerInTerminal
            ? `${request.summary} Approval must be completed in the native terminal.`
            : request.summary,
        );
        evidence.choices = request.options;
      }
    } else if (source.kind === "job") {
      const job = this.jobs?.().find((j) => j.id === source.jobId),
        review = job ? this.jobReviews?.get(job) : null;
      if (job) {
        evidence.goal = bounded(job.job);
        evidence.summary = bounded(
          job.result ??
            job.statusDetail ??
            "The job has no bounded result; effects remain unknown.",
        );
      }
      if (review?.state === "checked" && review.verification) {
        evidence.status =
          review.verification.state === "passed" &&
          (job?.provenance?.exitCode === 0 ||
            (job?.provenance?.exitCode === null &&
              this.jobRun(job)?.state === "completed"))
            ? "verified"
            : "failed";
        evidence.checks = review.verification.checks.map((check, index) => ({
          id: `${review.verification!.id}:${index}`,
          name: bounded(check.name),
          status:
            check.state === "passed"
              ? "passed"
              : check.state === "failed"
                ? "failed"
                : "unknown",
          resultDigest: digest(check),
        }));
      } else evidence.status = "failed";
    } else if (intent.trigger === "failure") evidence.status = "failed";
    evidence.sourceFingerprint = digest({
      source,
      goal: evidence.goal,
      status: evidence.status,
      summary: evidence.summary,
      question: evidence.question,
      choices: evidence.choices,
      checks: evidence.checks,
    });
    return evidence;
  }
  status() {
    return {
      watches: this.watches().map((w) => ({
        id: w.id,
        sessionId: w.sessionId,
        runId: w.runId,
        channel: w.channel,
        state: w.state,
        reason: w.reason,
        expiresAt: w.expiresAt,
        intentId: w.intentId,
      })),
      supervision: this.supervision.records().map((r) => ({
        policyId: r.policyId,
        sessionKey: r.sessionKey,
        jobRunId: r.jobRunId,
        revoked: r.revoked,
        expired: r.expiresAt <= this.now(),
        heartbeatFresh: this.now() - r.heartbeatAt < 6000,
      })),
      jobs: (this.jobs?.() ?? []).map((job) => ({
        id: job.id,
        agent: job.provenance?.agent ?? null,
        registered: !!job.provenance,
        reason: !job.provenance
          ? "legacy_job_has_no_exact_launch_provenance"
          : !this.jobRun(job)
            ? "no_authoritative_terminal_receipt"
            : !job.provenance.resultDigest
              ? "no_bounded_result_digest"
              : !this.jobReviews
                ? "independent_verification_not_configured"
                : (this.jobReviews.get(job)?.state ??
                  "awaiting_independent_verification"),
      })),
      jobVerification: {
        configured: !!this.jobReviews,
        blocker: this.jobReviews?.blocker() ?? null,
        records:
          this.jobReviews?.records().map((r) => ({
            id: r.id,
            jobId: r.jobId,
            runId: r.runId,
            state: r.state,
            reason: r.reason,
            verificationState: r.verification?.state,
          })) ?? [],
      },
    };
  }
  validate(intent: ProactiveCallIntent, pending: DecisionRequest[]): boolean {
    const jobSource = intent.source;
    if (jobSource.kind === "job") {
      const job = this.jobs?.().find((j) => j.id === jobSource.jobId),
        run = job ? this.jobRun(job) : null;
      if (
        !job?.provenance ||
        !run ||
        run.runId !== jobSource.runId ||
        run.sessionKey !== jobSource.sessionId ||
        run.projectRoot !== intent.scope.projectRoot ||
        job.provenance.launchId !== jobSource.launchId
      )
        return false;
      if (!jobSource.resultDigest)
        return (
          job.provenance.resultDigest === null &&
          job.provenance.exitCode !== null
        );
      const review = this.jobReviews?.get(job);
      return (
        job.provenance.resultDigest === jobSource.resultDigest &&
        review?.state === "checked" &&
        review.verification?.id === jobSource.verificationId &&
        ["completed", "failed"].includes(run.state)
      );
    }
    const run = this.sessions.get(intent.source.sessionId);
    if (
      !run ||
      run.runId !== intent.source.runId ||
      run.projectRoot !== intent.scope.projectRoot
    )
      return false;
    const source = intent.source;
    if (source.kind === "decision")
      return pending.some(
        (p) =>
          p.id === source.decisionId &&
          p.sessionKey === run.sessionKey &&
          p.holdUntil > this.now(),
      );
    if (intent.source.kind === "session")
      return intent.trigger === "waiting"
        ? run.state === "waiting"
        : run.state === "completed" || run.state === "failed";

    return false;
  }
}
