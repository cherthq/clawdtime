import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import type {
  IndependentTaskSession,
  TaskCommand,
  TaskVerification,
} from "../src/contracts.js";

const directory = mkdtempSync(join(tmpdir(), "clawdtime-task-simulation-"));
const path = join(directory, "tasks.sqlite");
const vault = new Vault(randomBytes(32).toString("hex"));
const session: IndependentTaskSession = {
  id: "fixture-session",
  version: 1,
  pairingId: "fixture-pairing",
  memberId: "fixture-member",
  deviceId: "fixture-device",
  hostId: "fixture-host",
  projectRoot: directory,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  permissions: {
    execute: true,
    voice: false,
    presentation: false,
    control: false,
  },
};
let store = new Store(path);
let ledger = new TaskLedger(store, vault);
let task = ledger.create(session, {
  eventId: "submission",
  goal: "SIMULATED fixture: add task filter and ask about empty state.",
}).task;
let sequence = 0;
function transition(
  command: Omit<TaskCommand, "eventId" | "expectedRevision">,
) {
  const value = {
    ...command,
    eventId: `event-${++sequence}`,
    expectedRevision: task.revision,
  } as TaskCommand;
  task = ledger.transition(session.id, task.id, value).task;
  assert.equal(ledger.transition(session.id, task.id, value).replayed, true);
}
function verify() {
  const verification: TaskVerification = {
    id: `verification-${sequence}`,
    runId: task.runs.at(-1)!.id,
    state: "passed",
    completedAt: Date.now(),
    checks: [
      {
        name: "SIMULATED test/build evidence",
        command: ["simulated-worker"],
        state: "passed",
        exitCode: 0,
        summary: "Synthetic fixture only; no real test/build evidence.",
      },
    ],
  };
  transition({ action: "verify_result", verification } as TaskCommand);
}
try {
  const first = task.runs.at(-1)!;
  transition({ action: "claim_run", runId: first.id } as TaskCommand);
  transition({
    action: "run_result",
    runId: first.id,
    dispatchId: first.dispatchId,
    outcome: "completed",
    summary: "SIMULATED filter added.",
    decision: "What should appear when no tasks match?",
  } as TaskCommand);
  verify();
  assert.equal(task.state, "needs_decision");
  transition({
    action: "decide",
    runId: first.id,
    instruction: "Show an empty state with a Clear filters button.",
  } as TaskCommand);
  store.close();
  store = new Store(path);
  ledger = new TaskLedger(store, vault);
  task = ledger.get(session.id, task.id);
  assert.equal(task.state, "queued");
  assert.equal(task.runs.length, 2);
  const second = task.runs.at(-1)!;
  transition({ action: "claim_run", runId: second.id } as TaskCommand);
  transition({
    action: "run_result",
    runId: second.id,
    dispatchId: second.dispatchId,
    outcome: "completed",
    summary: "SIMULATED empty state added.",
  } as TaskCommand);
  verify();
  assert.equal(task.state, "review_ready");
  transition({ action: "accept", runId: second.id } as TaskCommand);
  console.log(
    JSON.stringify({
      mode: "simulation",
      state: task.state,
      runs: task.runs.length,
      verificationReports: task.verifications.length,
      restartReload: true,
      duplicateEvents: "replayed without transitions",
      liveEffects: false,
      physicalAcceptance: false,
    }),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
