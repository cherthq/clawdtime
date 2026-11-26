import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ProactiveCallIntent } from "../attention/proactive-contracts.js";
import { DomainError } from "../storage/security.js";
import { secureWrite } from "../../connectors/shared/state.js";

// Only protected operator configuration may select a file to open. A result's
// prose and model output never become an application command or a URL.
export const walkthroughArtifactSchema = z
  .object({
    jobId: z.string().min(1).max(300),
    runId: z.string().min(1).max(300),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().startsWith("/").endsWith(".html").max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WalkthroughArtifact = z.infer<typeof walkthroughArtifactSchema>;

/** Bring the pinned result forward before capture starts. Never replay an
 * opening whose outcome is unknown. LaunchServices acknowledgement is not
 * evidence that the intended window is visible on the selected display. */
export async function openWalkthroughArtifact(
  artifacts: WalkthroughArtifact[],
  intent: ProactiveCallIntent,
  directory: string,
  authorizeIdle: () => void,
) {
  const source = intent.source;
  if (source.kind !== "job") return;
  const matches = artifacts.filter(
    (a) => a.jobId === source.jobId && a.runId === source.runId,
  );
  if (!matches.length) return;
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    !artifact ||
    artifact.resultDigest !== source.resultDigest
  )
    throw new DomainError(409, "walkthrough_artifact_result_changed");
  const root = realpathSync(intent.scope.projectRoot);
  const path = realpathSync(artifact.path);
  const rel = relative(root, path);
  const stat = lstatSync(artifact.path);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    path !== resolve(artifact.path) ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 10 * 1024 * 1024 ||
    createHash("sha256").update(readFileSync(path)).digest("hex") !==
      artifact.sha256
  )
    throw new DomainError(409, "walkthrough_artifact_changed");
  authorizeIdle();
  const receipt = join(
    directory,
    `artifact-open-${createHash("sha256").update(intent.id).digest("hex")}.json`,
  );
  if (existsSync(receipt)) {
    const previous = JSON.parse(readFileSync(receipt, "utf8"));
    if (
      previous.intentId === intent.id &&
      previous.artifactSha256 === artifact.sha256 &&
      previous.state === "launch_acknowledged"
    )
      return;
    throw new DomainError(409, "walkthrough_artifact_open_unknown");
  }
  // Exclusive creation also fences a restart or repeated preparation. Preserve
  // this receipt after capture cleanup, including on timeout or failed launch.
  writeFileSync(
    receipt,
    JSON.stringify({
      version: 1,
      intentId: intent.id,
      artifactSha256: artifact.sha256,
      state: "submitted",
      at: Date.now(),
    }),
    { flag: "wx", mode: 0o600 },
  );
  await promisify(execFile)("/usr/bin/open", [path], { timeout: 5000 });
  secureWrite(receipt, {
    version: 1,
    intentId: intent.id,
    artifactSha256: artifact.sha256,
    state: "launch_acknowledged",
    at: Date.now(),
  });
  authorizeIdle();
}
