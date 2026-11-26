import { hash } from "../../src/storage/security.js";
import type { JobFacts } from "../agents/jobs.js";

/** Completed launch receipts, never the newest job or a completion sentence.
 * A result reports that the coding process finished, not that its UI works. */
export function sharedJobCompletions(jobs: JobFacts[], instanceId: string) {
  const groups = new Map<string, JobFacts[]>();
  for (const job of jobs) {
    const binding = job.provenance?.sharedTask;
    if (!binding || binding.desktopInstanceId !== instanceId) continue;
    const group = groups.get(binding.taskId) ?? [];
    group.push(job);
    groups.set(binding.taskId, group);
  }
  return [...groups].flatMap(([taskId, group]) => {
    if (
      group.some(
        (job) =>
          !job.done ||
          job.status !== "completed" ||
          job.provenance?.exitCode !== 0 ||
          !job.provenance.launcherPid ||
          !job.provenance.resultDigest,
      )
    )
      return [];
    const resultId = hash(
      JSON.stringify(
        group
          .map((job) => [
            job.id,
            job.provenance!.runId,
            job.provenance!.launchId,
            job.provenance!.resultDigest,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ),
    );
    return [{ taskId, resultId }];
  });
}
