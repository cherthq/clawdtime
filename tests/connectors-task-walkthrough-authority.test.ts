import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TaskWalkthroughAuthority,
  type PreparedWalkthroughAuthority,
} from "../cli/task-walkthrough-authority.js";
import type {
  CodingTask,
  Pairing,
  TaskCommand,
  TaskVoiceSession,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { TaskLedger, buildTaskBrief } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskPresentationGrant,
} from "../src/task-presentation-contracts.js";
import {
  taskWalkthroughFingerprint,
  type TaskWalkthroughPlan,
  type TaskWalkthroughAuthorization,
  type TaskWalkthroughExportGrant,
} from "../src/task-walkthrough-contracts.js";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function fixture(decision = false) {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-walkthrough-authority-")),
  );
  const store = new Store(),
    vault = new Vault("ab".repeat(32));
  cleanups.push(() => {
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  let now = 1000000;
  const clock = () => now;
  const source: Pairing = {
    id: "fixture-pair",
    memberId: "fixture-member",
    deviceId: "fixture-device",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: now,
  };
  store.put("pairing", source);
  const ledger = new TaskLedger(store, vault, clock);
  const tasks = new TaskService(store, vault, ledger, {
    projectRoots: [project],
    simulation: false,
    clock,
  });
  const session = tasks.register({
    eventId: "register",
    pairingId: source.id,
    hostId: "host",
    projectRoot: project,
    voice: true,
  }).session;
  const taskId = ledger.create(session, {
    eventId: "task",
    goal: "Synthetic fixture task",
  }).task.id;
  const get = () => ledger.get(session.id, taskId);
  let event = 0;
  const change = (command: Record<string, unknown>) =>
    ledger.transition(session.id, taskId, {
      eventId: `event-${++event}`,
      expectedRevision: get().revision,
      ...command,
    } as TaskCommand);
  const run = get().runs[0]!;
  change({ action: "claim_run", runId: run.id });
  change({
    action: "run_result",
    runId: run.id,
    dispatchId: run.dispatchId,
    outcome: "completed",
    summary: "Fixture implemented.",
  });
  change({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: run.id,
      completedAt: now,
      state: "passed",
      checks: [
        {
          name: "Synthetic assertion",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "Fixture checked.",
        },
      ],
    },
  });
  const taskPatch = (patch: (task: CodingTask) => void) => {
    const task = get();
    patch(task);
    new ProtectedTaskStore<CodingTask>(store, vault, "coding-task-v1").put(
      task,
    );
  };
  if (decision)
    taskPatch((task) => {
      task.state = "needs_decision";
      task.runs[0]!.decision = "Choose the empty state.";
      task.verification!.state = "failed";
      task.brief = buildTaskBrief(task);
    });
  const brief = buildTaskBrief(get());
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation",
    sessionId: session.id,
    taskId,
    runId: run.id,
    taskRevision: get().revision,
    verificationId: "verification",
    kind: brief.kind,
    opening: brief.opening,
    fps: 15,
    scenes: [
      {
        id: "scene",
        kind: "preview",
        title: "Result",
        narration: brief.opening,
        expectedOutcome: "Prepared result",
        target: {
          appId: "fixture.app",
          windowId: "1",
          ownerPid: 123,
          processIdentity: hash("process"),
          displayId: 1,
          titleHash: hash("fixture"),
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  const grant: TaskPresentationGrant = {
    version: 1,
    id: "local-grant",
    manifestFingerprint: taskPresentationFingerprint(manifest),
    sessionId: session.id,
    taskId,
    runId: run.id,
    taskRevision: get().revision,
    hostId: "host",
    authorizedAt: now,
    expiresAt: now + 120000,
    localOnly: true,
    capture: true,
    presentation: true,
    control: false,
    nativeActivation: false,
    calls: false,
  };
  const plan: TaskWalkthroughPlan = {
    version: 1,
    mode: "handset_walkthrough",
    id: "call",
    taskSessionId: session.id,
    taskId,
    runId: run.id,
    revision: get().revision,
    voiceSessionId: "voice",
    pairingId: "real-pair",
    memberId: "real-member",
    deviceId: "real-device",
    lineId: "11111111-1111-4111-8111-111111111111",
    recipientHash: hash("synthetic-destination"),
    mediaSessionId: "media",
    workerIdentity: "worker",
    agentIdentity: "agent",
    exportGrantId: "export",
    callKind: brief.kind,
    presentationBinding: {
      presentationId: manifest.id,
      manifestFingerprint: grant.manifestFingerprint,
      presentationGrantId: grant.id,
      verificationId: manifest.verificationId,
      hostId: "host",
      captureDeviceId: "real-device",
    },
    dispatchExpiresAt: now + 240000,
    expiresAt: now + 600000,
    audio: true,
    video: true,
    screen: true,
    presentation: true,
    instructions: true,
    control: false,
    nativeActivation: false,
    maxCalls: 1,
  };
  const auth: TaskWalkthroughAuthorization = {
    id: "auth",
    planFingerprint: taskWalkthroughFingerprint(plan),
    authorizedAt: now,
    expiresAt: plan.dispatchExpiresAt,
    callExpiresAt: plan.expiresAt,
    oneCallAuthorized: true,
  };
  const exportGrant: TaskWalkthroughExportGrant = {
    version: 1,
    mode: "handset_walkthrough",
    id: plan.exportGrantId,
    planFingerprint: auth.planFingerprint,
    authorizationId: auth.id,
    sourcePairingId: source.id,
    projectRoot: project,
    authorizedAt: now,
    dispatchExpiresAt: auth.expiresAt,
    expiresAt: auth.callExpiresAt,
    exportPreparedWindows: true,
    instructions: true,
    control: false,
    nativeActivation: false,
    maxCalls: 1,
  };
  const voices = new TaskVoiceLedger(store, vault, ledger, clock);
  const voice: TaskVoiceSession = {
    id: plan.voiceSessionId,
    sessionId: session.id,
    taskId,
    openedRunId: run.id,
    openedRevision: get().revision,
    opening: brief.opening,
    createdAt: now,
    expiresAt: now + 600000,
    mode: "handset_walkthrough",
    instructionsAllowed: true,
    callAttemptId: plan.id,
    exportGrantId: exportGrant.id,
    presentationId: manifest.id,
    manifestFingerprint: grant.manifestFingerprint,
    permissions: { screen: true, presentation: true, control: false },
  };
  const voiceStore = new ProtectedTaskStore<TaskVoiceSession>(
    store,
    vault,
    "coding-task-voice-v1",
  );
  voiceStore.put(voice);
  let connected = true;
  const prepared = { manifest, grant, exportGrant };
  const make = (value: PreparedWalkthroughAuthority = prepared) =>
    new TaskWalkthroughAuthority(tasks, voices, value, clock, () => connected);
  const authority = make();
  return {
    store,
    vault,
    tasks,
    voices,
    session,
    source,
    get,
    change,
    taskPatch,
    voice,
    voiceStore,
    plan,
    auth,
    prepared,
    authority,
    make,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

describe("explicit handset walkthrough authority", () => {
  it.each([false, true])(
    "admits exact initial verified %s path without importing destination identity",
    (decision) => {
      const f = fixture(decision),
        before = f.store.query("SELECT * FROM entities");
      f.authority.assertInitial(f.plan, f.auth);
      f.authority.assertOngoing(f.plan, f.auth);
      expect(f.store.query("SELECT * FROM entities")).toEqual(before);
      expect(f.store.get("pairing", f.plan.pairingId)).toBeUndefined();
    },
  );
  it("requires explicit export; local capture alone never exports", () => {
    const f = fixture();
    for (const value of [
      { manifest: f.prepared.manifest, grant: f.prepared.grant },
      { ...f.prepared, exportGrant: f.prepared.grant },
      {
        ...f.prepared,
        exportGrant: {
          ...f.prepared.exportGrant,
          exportPreparedWindows: false,
        },
      },
    ])
      expect(() => f.make(value as PreparedWalkthroughAuthority)).toThrow();
  });
  it("copies prepared inputs and requires a connected callback", () => {
    const f = fixture();
    f.prepared.manifest.opening = "Changed";
    f.prepared.exportGrant.sourcePairingId = "other";
    f.authority.assertInitial(f.plan, f.auth);
    const g = fixture();
    const authority = new TaskWalkthroughAuthority(
      g.tasks,
      g.voices,
      g.prepared,
      g.clock,
    );
    expect(() => authority.assertOngoing(g.plan, g.auth)).toThrow(/connected/);
    g.setConnected(false);
    expect(() => g.authority.assertOngoing(g.plan, g.auth)).toThrow(
      /connected/,
    );
  });
  it.each([
    "pairingId",
    "memberId",
    "deviceId",
    "exportGrantId",
    "taskId",
    "voiceSessionId",
    "workerIdentity",
  ])("refuses plan retargeting %s", (key) => {
    const f = fixture(),
      plan = { ...f.plan, [key]: "other" };
    expect(() => f.authority.assertInitial(plan, f.auth)).toThrow();
    expect(() => f.authority.assertOngoing(plan, f.auth)).toThrow();
  });
  it.each([
    "hostId",
    "captureDeviceId",
    "manifestFingerprint",
    "presentationGrantId",
    "verificationId",
  ])("refuses presentation binding %s", (key) => {
    const f = fixture(),
      plan = {
        ...f.plan,
        presentationBinding: { ...f.plan.presentationBinding, [key]: "other" },
      };
    expect(() => f.authority.assertInitial(plan, f.auth)).toThrow();
  });
  it.each(["projectRoot", "sourcePairingId", "authorizationId"])(
    "requires exact export %s",
    (key) => {
      const f = fixture();
      f.prepared.exportGrant = { ...f.prepared.exportGrant, [key]: "other" };
      expect(() => f.make().assertInitial(f.plan, f.auth)).toThrow();
    },
  );
  it("rejects a changed manifest even if its local grant is rehashed", () => {
    const f = fixture();
    f.prepared.manifest.scenes[0]!.title = "Changed";
    f.prepared.grant.manifestFingerprint = taskPresentationFingerprint(
      f.prepared.manifest,
    );
    expect(() => f.make().assertInitial(f.plan, f.auth)).toThrow();
  });
  it("allows later task runs and held corrections only for the connected ongoing conversation", () => {
    const f = fixture();
    f.change({
      action: "decide",
      runId: f.plan.runId,
      instruction: "Use a different empty state",
    });
    f.change({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    new ProtectedTaskStore<{
      id: string;
      receipt: { taskId: string; state: string };
    }>(f.store, f.vault, "coding-task-voice-instruction-v1").put({
      id: "held",
      receipt: { taskId: f.plan.taskId, state: "held" },
    });
    const before = f.get();
    expect(() => f.authority.assertInitial(f.plan, f.auth)).toThrow();
    f.authority.assertOngoing(f.plan, f.auth);
    expect(f.get()).toEqual(before);
    expect(f.voices.heldForTask(f.plan.taskId)).toHaveLength(1);
  });
  it("separates local presentation and dispatch expiry from explicit conversation lifetime", () => {
    const f = fixture();
    f.advance(250000);
    expect(() => f.authority.assertInitial(f.plan, f.auth)).toThrow();
    f.authority.assertOngoing(f.plan, f.auth);
    f.advance(350000);
    expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
  });
  it.each([
    { authorizedAt: NaN },
    { authorizedAt: 1000001 },
    { expiresAt: 1300001 },
    { callExpiresAt: 2800001 },
    { oneCallAuthorized: false },
    { unexpected: true },
  ])("rejects malformed or substituted explicit lifetime %j", (patch) => {
    const f = fixture();
    expect(() =>
      f.authority.assertOngoing(f.plan, {
        ...f.auth,
        ...patch,
      } as TaskWalkthroughAuthorization),
    ).toThrow();
  });
  it.each(["hostId", "projectRoot", "revokedAt", "expiresAt"])(
    "rechecks source session %s",
    (field) => {
      const f = fixture();
      f.store.put("task-session", {
        id: f.session.id,
        sealed: f.vault.seal({
          ...f.session,
          [field]: field.endsWith("At") ? 1 : "other",
        }),
      });
      expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
    },
  );
  it.each(["verification", "originalRun", "revision"])(
    "rejects corrupted task history %s",
    (field) => {
      const f = fixture();
      f.taskPatch((task) => {
        if (field === "verification") task.verification!.state = "unknown";
        if (field === "originalRun") task.runs[0]!.id = "substituted";
        if (field === "revision") task.revision--;
      });
      expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
    },
  );
  it.each(["unknown", "canceled", "cancelRequested"])(
    "stops ongoing authority on %s",
    (kind) => {
      const f = fixture();
      f.taskPatch((task) => {
        if (kind === "cancelRequested")
          task.runs.at(-1)!.cancelRequested = true;
        else task.state = kind as CodingTask["state"];
      });
      expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
    },
  );
  it.each([
    { endedAt: 1 },
    { expiresAt: 1 },
    { exportGrantId: "other" },
    { presentationId: "other" },
    { manifestFingerprint: hash("other") },
    { mode: "handset_audio_smoke" },
    { instructionsAllowed: false },
  ])("rejects changed voice %j", (patch) => {
    const f = fixture();
    f.voiceStore.put({ ...f.voice, ...patch } as TaskVoiceSession);
    expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
  });
  it.each([{ revokedAt: 1 }, { memberId: "other" }, { deviceId: "other" }])(
    "retains source pairing checks %j",
    (patch) => {
      const f = fixture();
      f.store.put("pairing", { ...f.source, ...patch });
      expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
    },
  );
  it("fences other unresolved calls and own Stop/unknown without expiring them away", () => {
    const f = fixture();
    const records = new ProtectedTaskStore<{
      id: string;
      state: string;
      plan: TaskWalkthroughPlan;
    }>(f.store, f.vault, "coding-task-audio-call-v1");
    records.put({ id: f.plan.id, state: "preparing", plan: f.plan });
    f.authority.assertInitial(f.plan, f.auth);
    records.put({ id: f.plan.id, state: "stopping", plan: f.plan });
    expect(() => f.authority.assertInitial(f.plan, f.auth)).toThrow();
    records.put({ id: f.plan.id, state: "closed", plan: f.plan });
    records.put({
      id: "other",
      state: "unknown",
      plan: { ...f.plan, id: "other", expiresAt: 1 },
    });
    expect(() => f.authority.assertOngoing(f.plan, f.auth)).toThrow();
  });
});
