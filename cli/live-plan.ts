import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Adapter } from "../src/contracts.js";

export interface AcceptancePlan {
  schemaVersion: 1;
  protocolVersion: 2;
  caseId: string;
  adapter: Adapter;
  projectRoot: string;
  runId: string;
  taskId: string;
  idempotencyKey: string;
  nativePolicyUnchanged: true;
  automaticEffects: false;
  prompt: string;
  launch: { command: string; args: string[] };
}
/** Planning only. No credentials, provider calls, subprocesses or automatic client launch. */
export function acceptancePlan(options: {
  caseId: string;
  adapter: Adapter;
  projectRoot: string;
  executable: string;
  output: string;
}): AcceptancePlan {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.caseId))
    throw new Error(
      "Use a short alphanumeric acceptance case ID; no phone numbers or personal data.",
    );
  const file = resolve(options.output);
  if (existsSync(file)) {
    const prior = JSON.parse(readFileSync(file, "utf8")) as AcceptancePlan;
    if (
      prior.schemaVersion !== 1 ||
      prior.protocolVersion !== 2 ||
      prior.caseId !== options.caseId ||
      prior.adapter !== options.adapter ||
      prior.projectRoot !== options.projectRoot ||
      typeof prior.prompt !== "string" ||
      typeof prior.runId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(prior.runId)
    )
      throw new Error(
        "Existing acceptance plan is legacy or belongs to another case/project/adapter; preserve it and prepare a fresh v2 case.",
      );
    if (!existsSync(`${file}.prompt.txt`))
      writeFileSync(`${file}.prompt.txt`, `${prior.prompt}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    return prior;
  }
  if (existsSync(`${file}.prompt.txt`))
    throw new Error(
      "Existing acceptance prompt is preserved; choose its original plan path or a new case output.",
    );
  const runId = randomUUID();
  const suffix = createHash("sha256")
    .update(`${options.projectRoot}\0${options.adapter}\0${options.caseId}`)
    .digest("hex")
    .slice(0, 20);
  const taskId = `acceptance-${options.caseId}`,
    idempotencyKey = `acceptance-${suffix}`;
  const prompt = `Perform this supervised ClawdTime v2 acceptance case in this disposable project only. Case: ${options.caseId}. Expected adapter: ${options.adapter}. Expected localRunId: ${runId}.

Call connection_status first. Stop before calling unless localRunId matches, protocolVersion is 2 and readiness.liveReady is true. Readiness is not user consent or physical evidence. Obtain actual explicit approval for this one call before request_attention. Preserve native approval and sandbox policy.

Use request_attention once with taskId=${JSON.stringify(taskId)}, idempotencyKey=${JSON.stringify(idempotencyKey)}, reason="review", question="Review the disposable screen and tell this same coding agent your chosen label.", timeoutSeconds=900. Preserve its exact request ID; uncertain outcomes never authorize redial. V2 stays active: do not call yield_control or resume_agent.

Poll conversation_turns with waitSeconds=20 and the retained sequence cursor. Read each real human turn and acknowledge_turn in order. Ask the human through conversation_reply whether the intended screen is visible, then wait for their actual answer; never invent visibility evidence. Keep this same session engaged through multiple turns. Report conversation_progress executing or pending_approval before using native tools. File work can continue while sharing: when asked, create clawdtime-acceptance-${options.caseId}.txt with the human's chosen label, verify it, and publish a concise conversation_reply using one stable replyId for that turn. Mark the actual turn outcome completed. Preserve turns and receipts on reconnect; do not replay replies under new IDs.

Computer-control qualification requires an explicit requested exercise, verified matching shared surface, current local policy and execution_status/transfer_execution ownership. A browser-only tool is not desktop control and an invisible browser is not the shared display. Default fallback is disabled; an old pairing's allowControl is not fallback consent. Unknown effects block handoff. Never weaken native approvals, arm capture/control, install/restart the companion, or change live routing. Do not claim submitted input proves intended UI success.

With the separately approved scope, verify sharing survives normal native file work and multiple spoken replies. Record actual human observations and elapsed connection time; a test shorter than five minutes cannot qualify sustained connection beyond five minutes. Qualify Codex and Claude separately. Do not promise native tool interruption or full-duplex barge-in. On explicit ending use end_conversation and inspect cleanup; an individual acknowledgement/reply must not end sharing. Do not use legacy complete_attention or verify as v2 acceptance. Keep this chat active until the human confirms completion or cancels. Report only observed voice/text/display/control paths, native approval behavior, durations and unresolved outcomes. No unrelated actions or background workers.`;
  const plan: AcceptancePlan = {
    schemaVersion: 1,
    protocolVersion: 2,
    caseId: options.caseId,
    adapter: options.adapter,
    projectRoot: options.projectRoot,
    runId,
    taskId,
    idempotencyKey,
    nativePolicyUnchanged: true,
    automaticEffects: false,
    prompt,
    launch: {
      command: process.execPath,
      args: [
        options.executable,
        "run",
        "--agent",
        options.adapter,
        "--project",
        options.projectRoot,
        "--run-id",
        runId,
      ],
    },
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(`${file}.prompt.txt`, `${prompt}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return plan;
}
