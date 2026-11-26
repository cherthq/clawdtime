import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
export type JobTimingStage =
  | "conversation_started"
  | "conversation_completed"
  | "job_accepted"
  | "dispatch_started"
  | "executor_accepted"
  | "observation_started"
  | "observation_completed"
  | "input_started"
  | "input_submitted"
  | "verification_started"
  | "verification_completed"
  | "finished";
/** One monotonic process clock; never subtract events from another process. */
export class JobTiming {
  private generation = randomUUID();
  private start: number;
  private scopes = new Map<
    string,
    {
      at: number;
      events: { stage: JobTimingStage; revision: number; elapsedMs: number }[];
    }
  >();
  constructor(private clock = () => performance.now()) {
    this.start = clock();
  }
  record(scope: string, stage: JobTimingStage, revision: number) {
    const now = this.clock();
    if (now < this.start || now - this.start > 86_400_000) {
      this.scopes.clear();
      this.generation = randomUUID();
      this.start = now;
    }
    for (const [key, value] of this.scopes)
      if (now - value.at > 600_000) this.scopes.delete(key);
    if (!this.scopes.has(scope) && this.scopes.size >= 100) return;
    const value = this.scopes.get(scope) ?? { at: now, events: [] };
    value.at = now;
    value.events.push({
      stage,
      revision,
      elapsedMs: Math.round((now - this.start) * 100) / 100,
    });
    if (value.events.length > 64) value.events.shift();
    this.scopes.set(scope, value);
  }
  snapshot(scope: string) {
    return {
      version: 1,
      processGeneration: this.generation,
      boundary: "backend_process",
      handsetMeasured: false,
      events: this.scopes.get(scope)?.events.map((x) => ({ ...x })) ?? [],
    };
  }
}
