import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { secureRead, secureWrite } from "../shared/state.js";
import {
  runTaskVerification,
  validateVerificationPlan,
  type VerificationPlan,
} from "../../src/control/task-verification.js";
import type { TaskVerification } from "../../src/contracts.js";
import type { JobFacts } from "./jobs.js";

export interface ExternalJobReview {
  version: 1;
  id: string;
  jobId: string;
  runId: string;
  launchId: string;
  projectRoot: string;
  resultDigest: string;
  sessionRunId?: string;
  state: "verifying" | "checked" | "unknown" | "invalidated";
  verification?: TaskVerification;
  reason?: string;
}
/** Independent bounded checks. A worker answer and CLI exit alone never certify success. */
export class JobReviews {
  private active = false;
  private blocked: string | null = null;
  blocker() {
    return this.blocked;
  }
  constructor(
    private readonly options: {
      root: string;
      projectRoot: string;
      plan: VerificationPlan;
      /** Protected operator checks for an exact launched run, never worker-supplied. */
      plansByRun?: Record<string, VerificationPlan>;
      /** Called before each check, enforcing the service's existing execution ownership. */
      authorize: () => void;
      jobs: () => JobFacts[];
      terminal?: (job: JobFacts) => boolean;
      generation?: (job: JobFacts) => string | null;
      verify?: typeof runTaskVerification;
    },
  ) {
    validateVerificationPlan(options.plan);
    for (const plan of Object.values(options.plansByRun ?? {}))
      validateVerificationPlan(plan);
  }
  private file(id: string) {
    return join(this.options.root, "agents", "job-reviews", `${id}.json`);
  }
  private id(job: JobFacts) {
    const p = job.provenance!;
    const override = this.options.plansByRun?.[p.runId];
    return createHash("sha256")
      .update(
        `${p.runId}\0${p.resultDigest}\0${this.options.generation?.(job) ?? ""}${override ? `\0${JSON.stringify(override)}` : ""}`,
      )
      .digest("hex");
  }
  get(job: JobFacts): ExternalJobReview | null {
    if (!job.provenance?.resultDigest) return null;
    const file = this.file(this.id(job));
    if (!existsSync(file)) return null;
    const record = secureRead<ExternalJobReview>(file);
    if (
      record.version !== 1 ||
      record.runId !== job.provenance.runId ||
      record.resultDigest !== job.provenance.resultDigest
    )
      throw new Error("Job review receipt identity mismatch.");
    return record;
  }
  records(): ExternalJobReview[] {
    const dir = join(this.options.root, "agents", "job-reviews");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => secureRead<ExternalJobReview>(join(dir, name)));
  }
  async pump(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const unresolved = this.records().filter(
        (record) => record.state === "verifying" || record.state === "unknown",
      );
      for (const record of unresolved)
        if (record.state === "verifying")
          secureWrite(this.file(record.id), {
            ...record,
            state: "unknown",
            reason: "verification_interrupted; no blind retry",
          });
      if (unresolved.length) return;
      for (const job of this.options.jobs()) {
        const p = job.provenance ? { ...job.provenance } : undefined;
        if (
          !p ||
          !p.resultDigest ||
          p.projectRoot !== this.options.projectRoot ||
          (p.exitCode === null && !this.options.terminal?.(job)) ||
          p.launcherPid === null ||
          job.status === "retired_unknown"
        )
          continue;
        const old = this.get(job);
        if (old) {
          if (old.state === "verifying")
            secureWrite(this.file(old.id), {
              ...old,
              state: "unknown",
              reason: "verification_interrupted; no blind retry",
            });
          continue;
        }
        try {
          this.options.authorize();
          this.blocked = null;
        } catch {
          this.blocked = "verification_execution_ownership_unavailable";
          return;
        }
        const generation = this.options.generation?.(job);
        if (this.options.generation && !generation) continue;
        const record: ExternalJobReview = {
          version: 1,
          id: this.id(job),
          jobId: job.id,
          runId: p.runId,
          launchId: p.launchId,
          projectRoot: p.projectRoot,
          resultDigest: p.resultDigest,
          ...(generation ? { sessionRunId: generation } : {}),
          state: "verifying",
        };
        secureWrite(this.file(record.id), record);
        let verification: TaskVerification;
        try {
          verification = await (this.options.verify ?? runTaskVerification)(
            p.projectRoot,
            p.runId,
            this.options.plansByRun?.[p.runId] ?? this.options.plan,
            new AbortController().signal,
            this.options.authorize,
          );
        } catch {
          secureWrite(this.file(record.id), {
            ...record,
            state: "unknown",
            reason: "verification_response_lost",
          });
          continue;
        }
        const current = this.options
          .jobs()
          .find((item) => item.id === job.id)?.provenance;
        const unchanged =
          current?.runId === p.runId &&
          current.resultDigest === p.resultDigest &&
          (!this.options.generation ||
            this.options.generation(job) === generation) &&
          (!this.options.terminal || this.options.terminal(job));
        secureWrite(this.file(record.id), {
          ...record,
          state: unchanged ? "checked" : "invalidated",
          verification,
          ...(!unchanged
            ? { reason: "result_changed_during_verification" }
            : {}),
        });
      }
    } finally {
      this.active = false;
    }
  }
}
