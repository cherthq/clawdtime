import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingTask,
  Pairing,
  TaskCommand,
  TaskVoiceSession,
} from "../src/contracts.js";
import { Store } from "../src/storage/store.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import type { TaskEngine } from "../src/control/task-engine.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const operator = "synthetic-operator-credential-12345678901234567890";
const DAY = 24 * 60 * 60 * 1000;
function fixture() {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-readiness-service-")),
  );
  const store = new Store();
  cleanups.push(() => {
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
  let now = Date.now();
  const clock = () => now;
  const vault = new Vault("ef".repeat(32));
  const pairing: Pairing = {
    id: "pair",
    memberId: "member",
    deviceId: "device",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: now,
  };
  store.put("pairing", pairing);
  const ledger = new TaskLedger(store, vault, clock);
  const service = new TaskService(store, vault, ledger, {
    projectRoots: [project],
    simulation: false,
    clock,
  });
  const registration = {
    eventId: "registration",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: true,
  };
  const session = service.register(registration);
  const taskId = service.create(session.token, {
    eventId: "create",
    goal: "PRIVATE_SYNTHETIC_TASK_PROSE",
  }).task.id;
  const get = () => ledger.get(session.session.id, taskId);
  let sequence = 0;
  const change = (command: Record<string, unknown>) =>
    ledger.transition(session.session.id, taskId, {
      eventId: `change-${++sequence}`,
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
    summary: "PRIVATE_SYNTHETIC_SUMMARY",
  });
  change({
    action: "verify_result",
    verification: {
      id: "verification",
      runId: run.id,
      state: "passed",
      completedAt: now,
      checks: [
        {
          name: "Synthetic check",
          command: ["synthetic"],
          state: "passed",
          exitCode: 0,
          summary: "PRIVATE_CHECK_PROSE",
        },
      ],
    },
  });
  const voices = new TaskVoiceLedger(store, vault, ledger, clock);
  const engine = { start: vi.fn(), cancel: vi.fn(), onSettled: vi.fn() };
  const voice = new TaskVoiceService(
    service,
    voices,
    engine as unknown as TaskEngine,
  );
  const app = createTaskApp(
    service,
    operator,
    engine as unknown as TaskEngine,
    voice,
  );
  const api = (path: string, token = session.token, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const renew = (
    body: unknown = { ...registration, eventId: "renew" },
    token = operator,
  ) => api(`/sessions/${session.session.id}/reauthorize`, token, body);
  const readiness = () => api(`/tasks/${taskId}/readiness`);
  const patchTask = (patch: (task: CodingTask) => void) => {
    const task = get();
    patch(task);
    new ProtectedTaskStore<CodingTask>(store, vault, "coding-task-v1").put(
      task,
    );
  };
  return {
    project,
    store,
    vault,
    pairing,
    service,
    ledger,
    session,
    taskId,
    get,
    voices,
    voice,
    engine,
    api,
    renew,
    readiness,
    patchTask,
    registration,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    openVoice: () =>
      voice.open(session.token, taskId, {
        eventId: "voice",
        runId: get().runs[0]!.id,
        expectedRevision: get().revision,
      }),
  };
}

describe("readiness and reauthorization HTTP authority", () => {
  it("fences renewal on another session's unresolved handset attempt even after expiry", async () => {
    const f = fixture();
    const records = new ProtectedTaskStore<{
      id: string;
      state: string;
      plan: { taskSessionId: string; taskId: string; expiresAt: number };
    }>(f.store, f.vault, "coding-task-audio-call-v1");
    // Minimal encrypted diagnostic projection; no provider or native calls occur.
    records.put({
      id: "other-handset-attempt",
      state: "unknown",
      plan: {
        taskSessionId: "other-session",
        taskId: "other-task",
        expiresAt: f.clock() - 1,
      },
    });
    f.advance(DAY + 1);
    const before = f.get();
    const readiness = await (await f.readiness()).json();
    expect(readiness.blockedReasons).toContain("handset_cleanup_required");
    expect((await f.renew()).status).toBe(409);
    expect(f.get()).toEqual(before);
    expect(records.get("other-handset-attempt")?.state).toBe("unknown");
    expect(f.engine.start).not.toHaveBeenCalled();
  });

  it("allows expired credentials only sanitized readiness, never task prose or execution", async () => {
    const f = fixture();
    f.advance(DAY + 1);
    const response = await f.readiness();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      taskId: f.taskId,
      sessionId: f.session.session.id,
      sessionActive: false,
      taskState: "review_ready",
      verificationState: "passed",
      blockedReasons: ["session_expired"],
      handsetDispatch: false,
      permissions: { screen: false, control: false, presentation: false },
    });
    const serialized = JSON.stringify(body);
    for (const value of [
      "PRIVATE_",
      f.project,
      f.session.token,
      operator,
      "member",
      "recipient",
      "goal",
      "summary",
      "checks",
    ])
      expect(serialized).not.toContain(value);
    for (const [path, payload] of [
      [`/tasks/${f.taskId}`, undefined],
      [`/tasks/${f.taskId}/run`, {}],
      [
        `/tasks/${f.taskId}/commands`,
        {
          action: "accept",
          eventId: "accept",
          runId: f.get().runs[0]!.id,
          expectedRevision: f.get().revision,
        },
      ],
      [
        `/tasks/${f.taskId}/voice-sessions`,
        {
          eventId: "voice",
          runId: f.get().runs[0]!.id,
          expectedRevision: f.get().revision,
        },
      ],
      ["/tasks", { eventId: "another", goal: "Another task" }],
    ] as const)
      expect((await f.api(path, f.session.token, payload)).status).toBe(403);
    expect(f.engine.start).not.toHaveBeenCalled();
  });

  it.each([
    "wrong_session",
    "revoked_pairing",
    "member_changed",
    "device_changed",
    "revoked_session",
    "project_removed",
  ])("does not let expiry diagnostics bypass %s", async (variant) => {
    const f = fixture();
    const other = f.service.register({
      ...f.registration,
      eventId: "another-session",
    });
    if (variant === "revoked_pairing")
      f.store.put("pairing", { ...f.pairing, revokedAt: f.clock() });
    if (variant === "member_changed")
      f.store.put("pairing", { ...f.pairing, memberId: "other" });
    if (variant === "device_changed")
      f.store.put("pairing", { ...f.pairing, deviceId: "other" });
    if (variant === "revoked_session")
      f.store.put("task-session", {
        id: f.session.session.id,
        sealed: f.vault.seal({ ...f.session.session, revokedAt: f.clock() }),
      });
    if (variant === "project_removed") f.service.options.projectRoots = [];
    f.advance(DAY + 1);
    const response = await f.api(
      `/tasks/${f.taskId}/readiness`,
      variant === "wrong_session" ? other.token : f.session.token,
    );
    expect(response.status).toBe(variant === "wrong_session" ? 404 : 403);
    if (variant !== "wrong_session") expect((await f.renew()).status).toBe(403);
  });

  it("requires operator authority and exact pairing, host, project and voice permission", async () => {
    const f = fixture();
    f.advance(DAY + 1);
    expect((await f.renew(undefined, f.session.token)).status).toBe(401);
    for (const patch of [
      { pairingId: "another" },
      { hostId: "another" },
      { projectRoot: tmpdir() },
      { voice: false },
    ])
      expect(
        (await f.renew({ ...f.registration, eventId: "renew", ...patch }))
          .status,
      ).toBe(403);
    expect((await f.api(`/tasks/${f.taskId}`)).status).toBe(403);
  });

  it("renews the same token explicitly without changing task history or extending replay TTL", async () => {
    const f = fixture();
    const task = f.get();
    f.advance(DAY + 1);
    const response = await f.renew();
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first.session.id).toBe(f.session.session.id);
    expect(first.session.expiresAt).toBe(f.clock() + DAY);
    expect(first.replayed).toBe(false);
    expect(first).not.toHaveProperty("token");
    expect(f.get()).toEqual(task);
    expect((await f.api(`/tasks/${f.taskId}`)).status).toBe(200);
    f.advance(1000);
    const replay = await (await f.renew()).json();
    expect(replay.replayed).toBe(true);
    expect(replay.session.expiresAt).toBe(first.session.expiresAt);
    expect(f.service.authenticate(f.session.token).expiresAt).toBe(
      first.session.expiresAt,
    );
    const other = f.service.register({
      ...f.registration,
      eventId: "other-registration",
    });
    expect(
      (
        await f.api(`/sessions/${other.session.id}/reauthorize`, operator, {
          ...f.registration,
          eventId: "renew",
        })
      ).status,
    ).toBe(409);
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.get()).toEqual(task);
  });

  it.each([
    "queued",
    "running",
    "verifying",
    "unknown",
    "historical_unknown_run",
    "prepared_call",
    "connected_call",
    "unknown_call",
    "active_voice",
    "expired_voice",
    "held_instruction",
  ])("blocks reauthorization with unresolved %s", async (variant) => {
    const f = fixture();
    if (["queued", "running", "verifying", "unknown"].includes(variant))
      f.patchTask((task) => {
        task.state = variant as CodingTask["state"];
      });
    if (variant === "historical_unknown_run")
      f.patchTask((task) => {
        task.runs.unshift({
          ...task.runs[0]!,
          id: "older-run",
          state: "unknown",
        });
      });
    if (variant.endsWith("_call"))
      f.patchTask((task) => {
        task.calls.push({
          id: "call",
          runId: task.runs[0]!.id,
          kind: "review",
          state: variant.replace("_call", "") as
            "prepared" | "connected" | "unknown",
          opening: "Synthetic",
          simulated: true,
        });
      });
    if (variant.endsWith("_voice")) {
      const opened = f.openVoice();
      if (variant === "expired_voice") {
        new ProtectedTaskStore<TaskVoiceSession>(
          f.store,
          f.vault,
          "coding-task-voice-v1",
        ).put({ ...opened.voice, expiresAt: f.clock() - 1 });
      }
    }
    if (variant === "held_instruction")
      new ProtectedTaskStore(
        f.store,
        f.vault,
        "coding-task-voice-instruction-v1",
      ).put({ id: "held", receipt: { taskId: f.taskId, state: "held" } } as {
        id: string;
      });
    const before = f.get();
    expect((await f.renew()).status).toBe(409);
    expect(f.get()).toEqual(before);
    expect(f.engine.start).not.toHaveBeenCalled();
    const readiness = await (await f.readiness()).json();
    expect(readiness.blockedReasons.length).toBeGreaterThan(0);
    if (variant.endsWith("_voice"))
      expect(readiness.unendedVoices).toHaveLength(1);
  });
});
