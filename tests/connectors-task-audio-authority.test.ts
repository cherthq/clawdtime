import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TaskAudioAuthority,
  type TaskAudioAuthorityGrant,
} from "../cli/task-audio-authority.js";
import type {
  CodingTask,
  Pairing,
  TaskCommand,
  TaskVoiceSession,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import {
  taskAudioFingerprint,
  type TaskAudioPlan,
  type TaskAudioAuthorization,
} from "../src/transport/task-audio.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function fixture() {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-task-audio-authority-")),
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
  const voices = new TaskVoiceLedger(store, vault, ledger, clock);
  const voice = voices.open(
    session,
    {
      eventId: "handset",
      taskId,
      runId: run.id,
      expectedRevision: get().revision,
    },
    { callAttemptId: "one-call" },
  ).voice;
  const plan: TaskAudioPlan = {
    id: "one-call",
    taskSessionId: session.id,
    taskId,
    runId: run.id,
    revision: get().revision,
    voiceSessionId: voice.id,
    pairingId: "verified-destination",
    memberId: "verified-member",
    deviceId: "verified-device",
    lineId: "11111111-1111-4111-8111-111111111111",
    recipientHash: hash("+15550000001"),
    mediaSessionId: "media",
    workerIdentity: "incoming-worker",
    agentIdentity: "outgoing-agent",
    expiresAt: now + 240000,
    audio: true,
    video: false,
    screen: false,
    presentation: false,
    control: false,
    maxCalls: 1,
  };
  const grant: TaskAudioAuthorityGrant = {
    taskSessionId: session.id,
    taskId,
    runId: run.id,
    revision: get().revision,
    sourcePairingId: source.id,
    projectRoot: project,
    pairingId: plan.pairingId,
    memberId: plan.memberId,
    deviceId: plan.deviceId,
    lineId: plan.lineId,
    recipientHash: plan.recipientHash,
    planFingerprint: taskAudioFingerprint(plan),
    authId: "authorization",
    expiresAt: plan.expiresAt,
    audio: true,
    video: false,
    screen: false,
    presentation: false,
    control: false,
    maxCalls: 1,
  };
  const auth: TaskAudioAuthorization = {
    id: grant.authId,
    planFingerprint: grant.planFingerprint,
    authorizedAt: now,
    expiresAt: grant.expiresAt,
    oneCallAuthorized: true,
  };
  const authority = new TaskAudioAuthority(tasks, voices, grant, clock);
  return {
    store,
    vault,
    source,
    session,
    tasks,
    voices,
    voice,
    plan,
    grant,
    auth,
    authority,
    get,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    taskPatch: (patch: (task: CodingTask) => void) => {
      const task = get();
      patch(task);
      new ProtectedTaskStore<CodingTask>(store, vault, "coding-task-v1").put(
        task,
      );
    },
    voicePatch: (patch: Partial<TaskVoiceSession>) =>
      new ProtectedTaskStore<TaskVoiceSession>(
        store,
        vault,
        "coding-task-voice-v1",
      ).put({ ...voice, ...patch } as TaskVoiceSession),
  };
}

describe("same-task one-call delegated authority", () => {
  it("keeps the exact grant valid beyond 60 seconds through its bounded expiry", () => {
    const f = fixture();
    f.advance(61_000);
    expect(() => f.authority.assert(f.plan, f.auth)).not.toThrow();
    f.advance(179_000);
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow();
  });
  it("allows its own reserved call but fences another unresolved attempt", () => {
    const f = fixture();
    const records = new ProtectedTaskStore<{
      id: string;
      state: string;
      plan: TaskAudioPlan;
    }>(f.store, f.vault, "coding-task-audio-call-v1");
    records.put({ id: f.plan.id, state: "preparing", plan: f.plan });
    expect(() => f.authority.assert(f.plan, f.auth)).not.toThrow();
    records.put({
      id: "other-attempt",
      state: "unknown",
      plan: { ...f.plan, id: "other-attempt" },
    });
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow(
      "Another handset call",
    );
    records.put({
      id: "other-attempt",
      state: "closed",
      plan: { ...f.plan, id: "other-attempt" },
    });
    expect(() => f.authority.assert(f.plan, f.auth)).not.toThrow();
  });
  it("checks source task without mutating fixture identity or importing destination state", () => {
    const f = fixture(),
      before = f.store.query("SELECT * FROM entities"),
      task = f.get();
    f.authority.assert(f.plan, f.auth);
    expect(f.store.query("SELECT * FROM entities")).toEqual(before);
    expect(f.get()).toEqual(task);
    expect(f.store.get("pairing", f.source.id)).toEqual(f.source);
    expect(f.store.get("pairing", f.plan.pairingId)).toBeUndefined(); // Fresh destination readiness is separate.
  });
  it("copies the grant so later caller mutation cannot retarget its authority", () => {
    const f = fixture();
    f.grant.sourcePairingId = "changed";
    f.grant.recipientHash = "0".repeat(64);
    f.authority.assert(f.plan, f.auth);
  });
  it.each([
    { video: true },
    { screen: true },
    { presentation: true },
    { control: true },
    { maxCalls: 2 },
    { unexpected: true },
  ])("refuses broadened or unknown grant fields %j", (patch) => {
    const f = fixture();
    expect(
      () =>
        new TaskAudioAuthority(
          f.tasks,
          f.voices,
          { ...f.grant, ...patch } as TaskAudioAuthorityGrant,
          f.clock,
        ),
    ).toThrow();
  });
  it.each([
    "pairingId",
    "memberId",
    "deviceId",
    "recipientHash",
    "projectRoot",
    "sourcePairingId",
  ])("requires exact explicit grant %s", (key) => {
    const f = fixture();
    const grant = {
      ...f.grant,
      [key]: key === "recipientHash" ? "0".repeat(64) : "other",
    };
    expect(() =>
      new TaskAudioAuthority(f.tasks, f.voices, grant, f.clock).assert(
        f.plan,
        f.auth,
      ),
    ).toThrow();
  });
  it("refuses plan retargeting even with a matching caller-supplied authorization fingerprint", () => {
    const f = fixture(),
      plan = { ...f.plan, workerIdentity: "different-worker" };
    expect(() =>
      f.authority.assert(plan, {
        ...f.auth,
        planFingerprint: taskAudioFingerprint(plan),
      }),
    ).toThrow();
  });
  it.each([
    { id: "other" },
    { authorizedAt: NaN },
    { expiresAt: NaN },
    { authorizedAt: 1000001 },
    { authorizedAt: 939999 },
    { expiresAt: 1000000 },
    { oneCallAuthorized: false },
  ])("refuses invalid, stale or substituted authorization %j", (patch) => {
    const f = fixture();
    expect(() =>
      f.authority.assert(f.plan, {
        ...f.auth,
        ...patch,
      } as TaskAudioAuthorization),
    ).toThrow();
  });
  it("refuses expired grant and rechecks source session expiry/revocation", () => {
    const f = fixture();
    f.advance(240001);
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow();
    for (const patch of [
      { expiresAt: 1 },
      { revokedAt: 1 },
      { pairingId: "wrong" },
    ]) {
      const g = fixture();
      g.store.put("task-session", {
        id: g.session.id,
        sealed: g.vault.seal({ ...g.session, ...patch }),
      });
      expect(() => g.authority.assert(g.plan, g.auth)).toThrow();
    }
  });
  it.each([
    { revokedAt: 1 },
    { memberId: "different" },
    { deviceId: "different" },
  ])("rechecks original pairing %j", (patch) => {
    const f = fixture();
    f.store.put("pairing", { ...f.source, ...patch });
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow();
  });
  it.each([
    "revision",
    "running",
    "unknown",
    "verification",
    "run",
    "project",
    "call",
    "decision",
  ])("refuses changed task evidence: %s", (reason) => {
    const f = fixture();
    f.taskPatch((task) => {
      if (reason === "revision") task.revision++;
      if (reason === "running" || reason === "unknown") task.state = reason;
      if (reason === "verification") task.verification!.state = "failed";
      if (reason === "run") task.runs[0]!.state = "unknown";
      if (reason === "project") task.projectRoot = "/other";
      if (reason === "decision") task.runs[0]!.decision = "Unresolved";
      if (reason === "call")
        task.calls.push({
          id: "old",
          runId: task.runs[0]!.id,
          kind: "review",
          state: "unknown",
          opening: "Fixture",
          simulated: true,
        });
    });
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow();
  });
  it.each([
    { mode: "local_audio" },
    { instructionsAllowed: true },
    { callAttemptId: "other" },
    { sessionId: "other" },
    { taskId: "other" },
    { endedAt: 1 },
    { expiresAt: 1 },
    { openedRevision: 999 },
    { openedRunId: "other" },
  ])("rechecks exact status-only live voice %j", (patch) => {
    const f = fixture();
    f.voicePatch(patch as Partial<TaskVoiceSession>);
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow();
  });
  it("refuses held instructions without releasing or replaying them", () => {
    const f = fixture();
    const receipts = new ProtectedTaskStore<{
      id: string;
      receipt: { taskId: string; state: string };
    }>(f.store, f.vault, "coding-task-voice-instruction-v1");
    receipts.put({
      id: "held",
      receipt: { taskId: f.plan.taskId, state: "held" },
    });
    expect(() => f.authority.assert(f.plan, f.auth)).toThrow();
    expect(receipts.get("held")!.receipt.state).toBe("held");
    expect(f.get().runs).toHaveLength(1);
  });
});
