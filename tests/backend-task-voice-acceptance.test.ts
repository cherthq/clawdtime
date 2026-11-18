import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTaskResultAcceptance } from "../src/control/task-voice-acceptance.js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { createTaskApp } from "../src/control/task-app.js";
import {
  taskWalkthroughFingerprint,
  type TaskWalkthroughPlan,
} from "../src/task-walkthrough-contracts.js";
import type { TaskCommand } from "../src/contracts.js";

describe("bounded whole-utterance result acceptance", () => {
  it.each([
    "looks good",
    "Looks good!",
    "the result looks good.",
    "I accept the result",
    "I accept this result.",
    "I accept result",
    "accept the result",
    "accept this result",
    "approve the result",
    "approve this result",
    "I approve the result",
    "I approve this result",
    "it looks good",
    "I think it looks good",
    "Okay, I think the result looks good, thank you.",
    "Yes, I think this looks good to me.",
    "that looks good to me",
    "this looks good",
    "the result looks good to me",
    "Okay, looks good, thanks.",
    "Yes. I accept the result!",
    "Yeah! This looks good to me, thank you!",
    "Alright, sure, I approve this result.",
    "Well yes looks good please.",
    "OK, it looks good!",
    "Sure looks good.",
    "  yes,\n  that  looks\tgood  to me, thank you.  ",
  ])("accepts the complete bounded phrase: %s", (text) =>
    expect(isTaskResultAcceptance(text)).toBe(true),
  );
  it.each([
    "",
    " ",
    "yes",
    "okay",
    "thanks",
    "go ahead",
    "nice",
    "looks nice",
    "looks good?",
    "Does it look good?",
    "I do not accept the result",
    "I do not think it looks good",
    "I think it looks good, but change the color",
    "I think it looks good if the tests pass",
    "If it works, I think the result looks good",
    "I think I accept the result",
    "I don't accept the result",
    "No, looks good",
    "Not looks good",
    "Never approve the result",
    "If it works, I accept the result",
    "I accept the result if tests pass",
    "Looks good unless the tests fail",
    "Maybe looks good",
    "I might accept the result",
    '"looks good"',
    "'looks good'",
    "“looks good”",
    "You said looks good",
    "The message says I accept the result",
    "Looks good, but change the title",
    "Looks good. Change the title",
    "Looks good, if tests pass",
    "Yes, not yet",
    "Looks good and fix the filter",
    "Looks good; run another check",
    "I accept the result. Deploy it.",
    "The preview looks good",
    "The code looks good",
    "The app looks good",
    "The layout looks good",
    "This part looks good",
    "The result looks good visually",
    "Okay, yes, sure, looks good",
    "Thanks, looks good",
    "Looks good thanks thank you",
    "Looks good please please",
    "Looks good because it passed",
    "looks good: thanks",
    "looks good—thanks",
    "looks good\u0000",
    "okaylooks good",
    "looks goodthank you",
  ])("refuses ambiguous or additional speech: %s", (text) =>
    expect(isTaskResultAcceptance(text)).toBe(false),
  );
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function fixture() {
  const project = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-acceptance-")),
    ),
    store = new Store(),
    vault = new Vault("ab".repeat(32));
  const ledger = new TaskLedger(store, vault),
    tasks = new TaskService(store, vault, ledger, {
      projectRoots: [project],
      simulation: false,
    });
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "mac",
    recipient: "synthetic",
    conversationId: "synthetic",
    lineId: "synthetic",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const registered = tasks.register({
    eventId: "register",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: true,
  });
  let task = tasks.create(registered.token, {
    eventId: "create",
    goal: "Synthetic filter task",
  }).task;
  let sequence = 0;
  const change = (command: Record<string, unknown>) => {
    task = ledger.transition(task.sessionId, task.id, {
      eventId: `event-${sequence++}`,
      expectedRevision: task.revision,
      ...command,
    } as TaskCommand).task;
  };
  const run = task.runs[0]!;
  change({ action: "claim_run", runId: run.id });
  change({
    action: "run_result",
    runId: run.id,
    dispatchId: run.dispatchId,
    outcome: "completed",
    summary: "The filter works.",
  });
  change({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: run.id,
      state: "passed",
      completedAt: Date.now(),
      checks: [
        {
          name: "Synthetic assertion",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Passed.",
        },
      ],
    },
  });
  const worker = {
    run: vi.fn(async () => ({
      outcome: "completed" as const,
      summary: "Unexpected worker invocation",
    })),
  };
  const engine = new TaskEngine(tasks, worker, [
    { name: "Unused check", command: ["synthetic"] },
  ]);
  const voiceLedger = new TaskVoiceLedger(store, vault, ledger),
    voices = new TaskVoiceService(tasks, voiceLedger, engine);
  const opened = voices.openWalkthrough(
    registered.token,
    task.id,
    { eventId: "open", runId: run.id, expectedRevision: task.revision },
    {
      mode: "handset_walkthrough",
      callAttemptId: "call",
      exportGrantId: "export",
      presentationId: "presentation",
      manifestFingerprint: hash("manifest"),
    },
  );
  const plan: TaskWalkthroughPlan = {
    version: 1,
    mode: "handset_walkthrough",
    id: "call",
    taskSessionId: task.sessionId,
    taskId: task.id,
    runId: run.id,
    revision: task.revision,
    voiceSessionId: opened.voice.id,
    pairingId: "pair",
    memberId: "member",
    deviceId: "mac",
    lineId: "11111111-1111-4111-8111-111111111111",
    recipientHash: hash("synthetic"),
    mediaSessionId: "media",
    workerIdentity: "worker",
    agentIdentity: "agent",
    exportGrantId: "export",
    callKind: "review",
    presentationBinding: {
      presentationId: "presentation",
      manifestFingerprint: hash("manifest"),
      presentationGrantId: "local",
      verificationId: "verification",
      hostId: "host",
      captureDeviceId: "mac",
    },
    dispatchExpiresAt: Date.now() + 60000,
    expiresAt: Date.now() + 120000,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    instructions: true,
    control: false,
    nativeActivation: false,
    maxCalls: 1,
  };
  const records = new ProtectedTaskStore<{
    id: string;
    [key: string]: unknown;
  }>(store, vault, "coding-task-audio-call-v1");
  const connect = () =>
    records.put({
      id: plan.id,
      plan,
      fingerprint: taskWalkthroughFingerprint(plan),
      state: "connected",
      stopRequested: false,
      mediaClosed: false,
      nativeCleanupComplete: false,
      providerCallId: "22222222-2222-4222-8222-222222222222",
      receipts: {
        native_dial: { state: "done" },
        media_activate: { state: "done" },
      },
      nativeObservation: {
        providerCallId: "22222222-2222-4222-8222-222222222222",
        state: "connected",
        cleanupComplete: false,
        observedAt: Date.now(),
      },
    });
  const app = createTaskApp(tasks, "operator".repeat(8), engine, voices);
  const request = (suffix: string, body: unknown) =>
    app.request(`/tasks/${task.id}/voice/${opened.voice.id}${suffix}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opened.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  cleanups.push(async () => {
    await engine.close();
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  return {
    task,
    plan,
    worker,
    records,
    connect,
    request,
    get: () => ledger.get(task.sessionId, task.id),
  };
}

describe("decorated acceptance HTTP admission", () => {
  it("accepts stored decorated speech once without another run or deployment", async () => {
    const f = fixture();
    f.connect();
    expect(
      (await f.request("/bind", { providerConversationId: "provider" })).status,
    ).toBe(200);
    expect(
      (
        await f.request("/utterances", {
          providerConversationId: "provider",
          utteranceId: "speech",
          runId: f.task.runs[0]!.id,
          expectedRevision: f.task.revision,
          text: "Okay, yes, the result looks good to me, thank you.",
        })
      ).status,
    ).toBe(200);
    const body = { eventId: "accept", utteranceId: "speech" },
      first = await f.request("/accept", body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      accepted: true,
      replayed: false,
      deployed: false,
    });
    const accepted = f.get();
    expect(accepted.state).toBe("accepted");
    expect(accepted.runs).toHaveLength(1);
    expect(accepted.revision).toBe(f.task.revision + 1);
    const replay = await f.request("/accept", body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      accepted: true,
      replayed: true,
      deployed: false,
    });
    expect(f.get().revision).toBe(accepted.revision);
    expect(f.worker.run).not.toHaveBeenCalled();
  });
  it.each([
    "disconnected",
    "decision_call",
    "stale_revision",
    "additional_change",
  ])("keeps the %s guard despite normalization", async (kind) => {
    const f = fixture();
    f.connect();
    await f.request("/bind", { providerConversationId: "provider" });
    await f.request("/utterances", {
      providerConversationId: "provider",
      utteranceId: "speech",
      runId: f.task.runs[0]!.id,
      expectedRevision: f.task.revision,
      text:
        kind === "additional_change"
          ? "Okay, looks good, but change the title."
          : "Sure, that looks good to me, thanks.",
    });
    if (kind === "disconnected")
      f.records.put({ ...f.records.get(f.plan.id)!, state: "unknown" });
    if (kind === "decision_call" || kind === "stale_revision") {
      const plan =
        kind === "decision_call"
          ? { ...f.plan, callKind: "decision" as const }
          : { ...f.plan, revision: f.plan.revision - 1 };
      f.records.put({
        ...f.records.get(f.plan.id)!,
        plan,
        fingerprint: taskWalkthroughFingerprint(plan),
      });
    }
    expect(
      (await f.request("/accept", { eventId: "accept", utteranceId: "speech" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.get().state).toBe("review_ready");
    expect(f.get().runs).toHaveLength(1);
    expect(f.worker.run).not.toHaveBeenCalled();
  });
});
