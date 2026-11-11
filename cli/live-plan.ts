import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Adapter } from "../src/contracts.js";

export interface AcceptancePlan {
  schemaVersion: 1;
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
      prior.caseId !== options.caseId ||
      prior.adapter !== options.adapter ||
      prior.projectRoot !== options.projectRoot ||
      typeof prior.prompt !== "string" ||
      typeof prior.runId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(prior.runId)
    )
      throw new Error(
        "Existing acceptance plan belongs to another case/project/adapter; preserve it.",
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
  const prompt = `Perform this supervised ClawdTime acceptance case in this disposable project only. Case: ${options.caseId}. Expected adapter: ${options.adapter}. Expected localRunId: ${runId}.\n\nCall connection_status first. Abort before any call unless the localRunId matches and readiness.liveReady is true. Readiness is permission to attempt a supervised test, not physical acceptance evidence. Do not relax native approval or sandbox policy.\n\nStop and join every background actor that can change this project's screen. Call yield_control(backgroundActorsStopped=true). Remain paused except for ClawdTime status/result tools. Call request_attention exactly once with taskId=${JSON.stringify(taskId)}, idempotencyKey=${JSON.stringify(idempotencyKey)}, reason="review", question="ClawdTime supervised acceptance: review the disposable screen, test human-directed controls, then tell us your chosen label and when you want this coding agent to continue. Speak or text naturally; landscape may make the screen easier to see.", timeoutSeconds=900. Record the returned request ID. On timeout or uncertain outcome, inspect that exact request and stable key; never create a fresh call.\n\nPoll attention_result with waitSeconds=20. Do not fabricate feedback or treat silence as approval. The operator tests visible screen, voice/text, click/type/scroll and one bounded AI-directed action before asking this agent to continue with their chosen label. Do not refocus the shared Mac with a question UI during CUA. A visibility statement alone is not a request to continue. Read control receipts and the current controlEpoch. Acknowledge the exact response ID, then resume_agent using that epoch. Stay paused if control is active/unknown or native permission is required.\n\nOnly after resume succeeds, create the local disposable result file clawdtime-acceptance-${options.caseId}.txt containing the chosen label and a brief factual summary, using your native file tools under existing permissions. Verify the file. Then complete_attention once with the same request ID and a concise result including the selected label and file path. Do not claim handset delivery or physical CUA success unless the operator actually confirms it.\n\nKeep this exact chat active until the operator confirms handset delivery and the acceptance observations, or explicitly cancels the test; do not finalize while verification is pending. Then report request ID, response ID, resumed epoch, artifact path and the exact completion receipt state. If the tool only returns request.state=completed, describe the Messages result as queued, not delivered; operator evidence must establish native delivery. The operator separately records handset call/screen/CUA observations, Messages delivery and timings. No unrelated actions, background workers or delegation.`;
  const plan: AcceptancePlan = {
    schemaVersion: 1,
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
