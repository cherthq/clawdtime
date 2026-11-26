import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobFacts } from "../agents/jobs.js";
import { hash } from "../../src/storage/security.js";
import type {
  SharedCommand,
  SharedResult,
} from "../../src/shared-relay-contracts.js";
import { sharedJobCompletions } from "./shared-job-completions.js";
import { privateFolder } from "./private-file.js";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Never interpret a job's result as a URL, shell command or instructions.
 * Render its exact result as inert text. The paired Mac grants report opening. */
export async function sharedWalkthrough(options: {
  command: SharedCommand;
  instanceId: string;
  jobs: JobFacts[];
  directory: string;
  allowOpen: boolean;
  signal: AbortSignal;
  inspect(callId: string): Promise<{ ok: boolean; expiresAt?: number }>;
  open(path: string): Promise<void>;
}): Promise<SharedResult> {
  const { command } = options;
  const binding = command.walkthrough;
  if (
    command.operation.action !== "walkthrough" ||
    !binding ||
    command.instanceId !== options.instanceId ||
    options.jobs.length > 1000
  )
    return { ok: false, code: "walkthrough_scope_mismatch" };
  const completion = sharedJobCompletions(
    options.jobs,
    options.instanceId,
  ).find((r) => r.taskId === binding.taskId);
  if (!completion || completion.resultId !== binding.resultId)
    return { ok: false, code: "walkthrough_result_changed" };
  const jobs = options.jobs.filter(
    (j) =>
      j.provenance?.sharedTask?.taskId === binding.taskId &&
      j.provenance.sharedTask.desktopInstanceId === options.instanceId,
  );
  const text = jobs
    .map((j) => `${j.job}\n${j.text ?? j.result ?? "No result text."}`)
    .join("\n\n")
    .slice(0, 18000);
  const live = async () => {
    if (options.signal.aborted || command.expiresAt <= Date.now())
      throw Error("expired");
    const lease = await options.inspect(command.callId);
    if (
      !lease.ok ||
      !lease.expiresAt ||
      lease.expiresAt <= Date.now() ||
      options.signal.aborted
    )
      throw Error("expired");
  };
  try {
    await live();
    if (!options.allowOpen)
      return { ok: true, walkthrough: { text, opened: false } };
    privateFolder(options.directory);
    const path = join(
      options.directory,
      `${hash(JSON.stringify([command.callId, binding]))}.html`,
    );
    // Exclusive creation plus the Mac delivery receipt fences repeated opening.
    writeFileSync(
      path,
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>ClawdTime task result</title><style>body{max-width:900px;margin:60px auto;padding:24px;font:20px system-ui;color:#172033;background:#f3f6fb}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:24px;border-radius:12px}small{color:#536176}</style><h1>Your task result</h1><small>The coding process exited successfully. Its report is shown below. This does not independently verify the work.</small><pre>${escape(text)}</pre></html>`,
      { mode: 0o600, flag: "wx" },
    );
    await live();
    await options.open(path);
    await live();
    return { ok: true, walkthrough: { text, opened: true } };
  } catch {
    return { ok: false, code: "walkthrough_outcome_unknown" };
  }
}
