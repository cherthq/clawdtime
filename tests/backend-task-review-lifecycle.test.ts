import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { deskTasks } from "../connectors/agents/tasks.js";
import { CodexTaskWorker } from "../connectors/codex/task-worker.js";
import type {
  AppServerConnection,
  AppServerMessage,
} from "../connectors/codex/app-server.js";
import { Store } from "../src/storage/store.js";
import { Vault } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { TaskDesktopService } from "../src/control/task-desktop-service.js";
import { TaskReviewService } from "../src/control/task-review-service.js";
import type { TaskReviewCallbackRecord } from "../src/attention/task-review-callback-ledger.js";
import type { DesktopCallRequest } from "../src/control/task-desktop-calls-config.js";
import { taskPresentationFingerprint } from "../src/task-presentation-contracts.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";

/** Disposable protocol host: no process, capture, messages or external effects. */
class LongRunningHost implements AppServerConnection {
  listeners = new Set<(message: AppServerMessage) => void>();
  requests: string[] = [];
  inputs: unknown[] = [];
  closed = false;
  constructor(readonly sequence: number) {}
  async request(method: string, params: unknown): Promise<any> {
    this.requests.push(method);
    if (method === "config/read") return { config: {} };
    if (method === "thread/start")
      return {
        thread: { id: `thread-${this.sequence}` },
        approvalPolicy: "on-request",
        sandbox: {
          type: "workspaceWrite",
          networkAccess: false,
          writableRoots: [],
        },
      };
    if (method === "mcpServerStatus/list")
      return { data: [], nextCursor: null };
    if (method === "turn/start") {
      this.inputs.push(params);
      queueMicrotask(() =>
        this.event("turn/started", { turn: { id: `turn-${this.sequence}` } }),
      );
      return { turn: { id: `turn-${this.sequence}` } };
    }
    if (method === "turn/interrupt") this.complete("interrupted");
    return {};
  }
  event(method: string, extra: Record<string, unknown>) {
    for (const listener of this.listeners)
      listener({
        method,
        params: {
          threadId: `thread-${this.sequence}`,
          turnId: `turn-${this.sequence}`,
          ...extra,
        },
      });
  }
  complete(status = "completed") {
    this.event("turn/completed", {
      turn: {
        id: `turn-${this.sequence}`,
        status,
        items: [
          {
            type: "agentMessage",
            text: JSON.stringify({
              summary: "The fixture draft is ready.",
              decision: null,
            }),
          },
        ],
      },
    });
  }
  subscribe(listener: (message: AppServerMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  respond() {}
  close() {
    this.closed = true;
  }
}
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done();
  vi.useRealTimers();
});

function preparedRequest(record: TaskReviewCallbackRecord): DesktopCallRequest {
  const now = Date.now();
  const manifest: DesktopCallRequest["prepared"]["manifest"] = {
    version: 1,
    id: `presentation_${record.id}`,
    sessionId: record.sessionId,
    taskId: record.taskId,
    runId: record.runId,
    taskRevision: record.reviewRevision,
    verificationId: record.verificationId,
    kind: record.kind,
    opening: record.opening,
    fps: 15,
    scenes: [
      {
        id: "preview",
        kind: "preview",
        title: "Disposable fixture",
        narration: record.opening,
        expectedOutcome: "Fixture result is visible",
        target: {
          appId: "test.disposable",
          windowId: "1",
          ownerPid: 1,
          processIdentity: "ab".repeat(32),
          displayId: 1,
          titleHash: "cd".repeat(32),
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  return {
    eventId: `delivery_${record.id}`,
    taskId: record.taskId,
    runId: record.runId,
    expectedRevision: record.reviewRevision,
    authorizationId: `authorization_${record.id}`,
    authorizedAt: now,
    expiresAt: now + 60_000,
    callDurationMs: 120_000,
    userAuthorizedOneCall: true,
    userAuthorizedPreparedWindowExport: true,
    userAuthorizedTaskInstructions: true,
    standby: {
      deploymentId: "00000000-0000-4000-8000-000000000001",
      restoreRecord: "synthetic_fixture",
    },
    prepared: {
      manifest,
      grant: {
        version: 1,
        id: `grant_${record.id}`,
        manifestFingerprint: taskPresentationFingerprint(manifest),
        sessionId: record.sessionId,
        taskId: record.taskId,
        runId: record.runId,
        taskRevision: record.reviewRevision,
        hostId: "host",
        authorizedAt: now,
        expiresAt: now + 300_000,
        localOnly: true,
        capture: true,
        presentation: true,
        control: false,
        nativeActivation: false,
        calls: false,
        continuity: "call",
      },
    },
  };
}

function simulatedDelivery(reviews: TaskReviewService) {
  const request = vi.fn((input: unknown) => {
    const call = input as DesktopCallRequest;
    const record = reviews.ledger
      .list(call.prepared.manifest.sessionId, call.taskId)
      .find((value) => value.runId === call.runId)!;
    reviews.ledger.prepared(record.sessionId, record.id, {
      manifestFingerprint: call.prepared.grant.manifestFingerprint,
      opening: record.opening,
    });
    const attemptId = `simulated_${record.id}`;
    reviews.ledger.reserve(record.sessionId, record.id, attemptId);
    reviews.ledger.outcome(record.sessionId, record.id, attemptId, "in_review");
    return {
      attempt: {
        id: attemptId,
        eventId: call.eventId,
        taskId: call.taskId,
        runId: call.runId,
        revision: call.expectedRevision,
        callKind: record.kind,
        state: "active" as const,
        cleanupConfirmed: false,
      },
      replayed: false,
    };
  });
  return { request };
}

function fixture(autoDelivery = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T18:00:00Z"));
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-review-cycle-")),
  );
  const store = new Store(),
    vault = new Vault("ab".repeat(32));
  const ledger = new TaskLedger(store, vault);
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "mac",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const service = new TaskService(store, vault, ledger, {
    projectRoots: [directory],
    simulation: false,
  });
  const registration = service.register({
    eventId: "registration",
    pairingId: "pair",
    hostId: "host",
    projectRoot: directory,
    voice: true,
  });
  const hosts: LongRunningHost[] = [];
  const worker = new CodexTaskWorker({
    enabled: true,
    projectRoots: [directory],
    connectionFactory: () => {
      const host = new LongRunningHost(hosts.length + 1);
      hosts.push(host);
      return host;
    },
  });
  const verify = vi.fn(async (_root: string, runId: string) => ({
    id: `verification-${runId}`,
    runId,
    state: "passed" as const,
    completedAt: Date.now(),
    checks: [
      {
        name: "independent fixture verification",
        command: ["fixture-check"],
        state: "passed" as const,
        exitCode: 0,
        summary: "Independent fixture result.",
      },
    ],
  }));
  const engine = new TaskEngine(
    service,
    worker,
    [{ name: "fixture", command: ["fixture-check"] }],
    verify,
  );
  const token = "desktop-only-fixture-token-".repeat(3);
  const desktop = new TaskDesktopService(service, engine, {
    desktopId: "desktop",
    instanceId: "instance",
    configurationFingerprint: "fixture",
    worker: "codex",
    token,
    sessionToken: registration.token,
  });
  const reviews = new TaskReviewService(
    service,
    registration.token,
    engine,
    autoDelivery,
  );
  const delivery = simulatedDelivery(reviews);
  const preparation = {
    prepare: vi.fn(async (record: TaskReviewCallbackRecord) =>
      preparedRequest(record),
    ),
  };
  if (autoDelivery) reviews.configureDelivery(delivery, preparation);
  desktop.reviews = reviews;
  const port = deskTasks(desktop, token);
  const world: SupervisorWorld = {
    now: Date.now,
    board: () => null,
    desk: new DecisionDesk(directory),
    focus: async () => ({ ok: false }),
    send: async () => ({ ok: false, route: "unavailable" }),
    clis: () => [],
    tasks: port,
    // The intent reader is a switch of the service. This lifecycle is driven through it, so it is on.
    semanticTasks: true,
  };
  // Classifier fixture is structured output only; real service authorization and
  // worker protocol handling remain under test. It cannot rewrite task prose.
  const model: ModelClient = {
    complete: async () => ({ text: "No operation.", toolCalls: [] }),
    classifyIntent: async ({ text }) => ({
      source: text,
      kind:
        text === "Make the landing page blue."
          ? "revision"
          : text === "I accept the result."
            ? "accept"
            : "new_task",
    }),
  };
  const supervisor = new Supervisor(world, model);
  const current = () =>
    ledger.get(registration.session.id, port.current()!.identity!.id);
  const enterReview = async () => {
    // Let settlement's production preparation/pump finish. No direct staging or
    // reservation here: the injected authorized-view resolver owns preparation.
    await reviews.pump();
    await vi.advanceTimersByTimeAsync(0);
    const task = current();
    const record = reviews.ledger
      .list(task.sessionId, task.id)
      .findLast((value) => value.runId === task.runs.at(-1)!.id)!;
    expect(record.state).toBe("in_review");
    return { record, attemptId: record.attemptId! };
  };
  cleanup.push(async () => {
    reviews.close();
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    supervisor,
    hosts,
    current,
    engine,
    verify,
    reviews,
    registration,
    port,
    enterReview,
    desktop,
    token,
    store,
    vault,
    ledger,
    service,
    delivery,
    preparation,
  };
}

describe("natural task to durable verified review lifecycle simulation", () => {
  it("works past three minutes, verifies, reviews, revises the same task, verifies again and accepts only the current result", async () => {
    const f = fixture(true);
    const goal =
      "Hey GPT, build a draft landing page for Chert, call me when ready, and don't deploy or send it.";
    const admitted = await f.supervisor.reply([], goal, "voice");
    expect(admitted).toContain("Coding run admitted");
    expect(admitted).toContain("Calling requires fresh authorized views");
    await vi.advanceTimersByTimeAsync(0);
    const original = f.current();
    expect(original.goal).toBe(goal);
    expect(original.state).toBe("running");
    const host = f.hosts[0]!;
    host.event("item/started", {
      item: { id: "reasoning", type: "reasoning" },
    });
    await vi.advanceTimersByTimeAsync(181_000);
    expect(f.current().state).toBe("running");
    expect(f.current().runs[0]!.progress?.phase).toBe("reasoning");
    expect(host.requests).not.toContain("turn/interrupt");
    expect(host.closed).toBe(false);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.reviews.ledger.list(original.sessionId)).toEqual([]);
    host.complete();
    await f.engine.wait(original.id);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.current().state).toBe("review_ready");
    expect(
      f.current().runs[0]!.endedAt! - f.current().runs[0]!.startedAt!,
    ).toBeGreaterThan(180_000);
    const first = await f.enterReview();
    expect(f.reviews.snapshot(f.current()).state).toBe("in_review");
    expect(f.current().state).not.toBe("accepted");
    f.reviews.ledger.outcome(
      original.sessionId,
      first.record.id,
      first.attemptId,
      "delivered",
    );
    const revision = await f.supervisor.reply(
      [],
      "Make the landing page blue.",
      "voice",
    );
    expect(revision).toContain("Coding run admitted");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.current().id).toBe(original.id);
    expect(f.current().goal).toBe(goal);
    expect(f.current().runs).toHaveLength(2);
    expect(f.reviews.snapshot(f.current()).state).toBe("revising");
    expect(JSON.stringify(f.hosts[1]!.inputs)).toContain(
      "don't deploy or send it",
    );
    f.hosts[1]!.complete();
    await f.engine.wait(original.id);
    expect(f.verify).toHaveBeenCalledTimes(2);
    const second = await f.enterReview();
    expect(second.record.id).not.toBe(first.record.id);
    expect(second.record.runId).not.toBe(first.record.runId);
    expect(second.record.goal).toBe(goal);
    expect(() =>
      f.ledger.transition(original.sessionId, original.id, {
        eventId: "stale-acceptance",
        expectedRevision: f.current().revision,
        action: "accept",
        runId: original.runs[0]!.id,
      }),
    ).toThrow(/current result/);
    expect(
      await f.supervisor.reply([], "I accept the result.", "voice"),
    ).toContain("Result accepted");
    expect(f.current().state).toBe("accepted");
    expect(f.current().runs).toHaveLength(2);
    expect(f.reviews.snapshot(f.current()).message).toContain(
      "Deployment remains a separate action",
    );
    f.reviews.ledger.outcome(
      original.sessionId,
      second.record.id,
      second.attemptId,
      "delivered",
    );
    f.reviews.refresh();
    expect(f.reviews.ledger.list(original.sessionId)).toHaveLength(2);
    expect(f.hosts).toHaveLength(2);
    expect(f.preparation.prepare).toHaveBeenCalledTimes(2);
    expect(f.delivery.request).toHaveBeenCalledTimes(2);
    await f.reviews.pump();
    expect(f.delivery.request).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("explicit Stop confirms worker interruption and creates no completion callback", async () => {
    const f = fixture();
    await f.supervisor.reply(
      [],
      "Build a disposable draft; don't deploy.",
      "chat",
    );
    await vi.advanceTimersByTimeAsync(0);
    const task = f.current();
    await f.supervisor.reply([], "Stop", "voice");
    await f.engine.wait(task.id);
    expect(f.current().state).toBe("canceled");
    expect(f.current().runs[0]!.state).toBe("canceled");
    expect(
      f.hosts[0]!.requests.filter((method) => method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.reviews.ledger.list(task.sessionId)).toEqual([]);
  });

  it("disconnection preserves uncertainty and does not verify, callback, or replay the original run", async () => {
    const f = fixture();
    await f.supervisor.reply(
      [],
      "Build a disposable draft; don't deploy.",
      "chat",
    );
    await vi.advanceTimersByTimeAsync(0);
    const task = f.current();
    f.hosts[0]!.event("clawdtime/disconnected", { reason: "process_exit" });
    await f.engine.wait(task.id);
    expect(f.current().state).toBe("unknown");
    expect(f.current().runs[0]!.reasonCode).toBe("process_exit");
    expect(f.verify).not.toHaveBeenCalled();
    f.reviews.refresh();
    expect(f.reviews.ledger.list(task.sessionId)).toEqual([]);
    await f.supervisor.reply([], "Build it again.", "chat");
    expect(f.hosts).toHaveLength(1);
    expect(f.current().runs).toHaveLength(1);
  });
});

async function readyFixture() {
  const f = fixture();
  await f.supervisor.reply(
    [],
    "Build a disposable draft; don't deploy.",
    "chat",
  );
  await vi.advanceTimersByTimeAsync(0);
  f.hosts[0]!.complete();
  await f.engine.wait(f.current().id);
  const record = f.reviews.ledger.list(f.current().sessionId)[0]!;
  return { ...f, record, request: preparedRequest(record) };
}

describe("supervisor prepared delivery pump", () => {
  it("rolls back preparation if its exact delivery envelope cannot be committed", async () => {
    const f = await readyFixture();
    const before = f.reviews.ledger.get(f.record.sessionId, f.record.id);
    const put = f.store.put.bind(f.store);
    f.store.put = ((kind: string, value: { id: string }) => {
      if (kind === "coding-review-delivery-v1")
        throw new Error("synthetic persistence failure");
      return put(kind, value);
    }) as Store["put"];
    expect(() => f.reviews.stage(f.record.id, f.request)).toThrow(
      /persistence failure/,
    );
    expect(f.reviews.ledger.get(f.record.sessionId, f.record.id)).toEqual(
      before,
    );
    expect(f.delivery.request).not.toHaveBeenCalled();
    f.store.put = put;
    expect(f.reviews.stage(f.record.id, f.request)).toMatchObject({
      state: "queued",
      replayed: false,
    });
  });

  it("preserves a known settled callback when restart finds a stale submitting queue receipt", async () => {
    const f = await readyFixture();
    f.reviews.stage(f.record.id, f.request);
    f.delivery.request(f.request);
    const callback = f.reviews.ledger.get(f.record.sessionId, f.record.id);
    f.reviews.ledger.outcome(
      f.record.sessionId,
      f.record.id,
      callback.attemptId!,
      "delivered",
    );
    const rows = new ProtectedTaskStore<any>(
      f.store,
      f.vault,
      "coding-review-delivery-v1",
    );
    rows.put({ ...rows.get(f.record.id), state: "submitting" });
    f.reviews.close();
    const restored = new TaskReviewService(
      f.service,
      f.registration.token,
      undefined,
      true,
    );
    cleanup.push(() => restored.close());
    const calls = simulatedDelivery(restored);
    restored.configureDelivery(calls);
    await restored.pump();
    expect(calls.request).not.toHaveBeenCalled();
    expect(restored.ledger.get(f.record.sessionId, f.record.id).state).toBe(
      "delivered",
    );
    expect(restored.stage(f.record.id, f.request)).toMatchObject({
      state: "unknown",
      replayed: true,
    });
  });

  it("stages an exact prepared result once and refuses changed or mismatched envelopes", async () => {
    const f = await readyFixture();
    expect(() =>
      f.reviews.stage(f.record.id, { ...f.request, runId: "another_run" }),
    ).toThrow(/exact callback/);
    expect(f.reviews.stage(f.record.id, f.request)).toMatchObject({
      state: "queued",
      replayed: false,
    });
    expect(f.reviews.stage(f.record.id, f.request)).toMatchObject({
      state: "queued",
      replayed: true,
    });
    expect(() =>
      f.reviews.stage(f.record.id, {
        ...f.request,
        authorizationId: "new_authority",
      }),
    ).toThrow(/different prepared/);
    f.reviews.configureDelivery(f.delivery);
    await Promise.all([f.reviews.pump(), f.reviews.pump()]);
    expect(f.delivery.request).toHaveBeenCalledTimes(1);
    expect(f.reviews.stage(f.record.id, f.request)).toMatchObject({
      state: "dispatched",
      replayed: true,
    });
    await f.reviews.pump();
    expect(f.delivery.request).toHaveBeenCalledTimes(1);
  });

  it("resumes an unsubmitted queued envelope across restart exactly once", async () => {
    const f = await readyFixture();
    f.reviews.stage(f.record.id, f.request);
    f.reviews.close();
    const restored = new TaskReviewService(
      f.service,
      f.registration.token,
      undefined,
      true,
    );
    cleanup.push(() => restored.close());
    const calls = simulatedDelivery(restored);
    restored.configureDelivery(calls);
    await restored.pump();
    await restored.pump();
    expect(calls.request).toHaveBeenCalledTimes(1);
    expect(restored.stage(f.record.id, f.request)).toMatchObject({
      state: "dispatched",
      replayed: true,
    });
    expect(restored.ledger.get(f.record.sessionId, f.record.id).state).toBe(
      "in_review",
    );
  });

  it("fences a crash during submission in both queue and callback without blind resubmission", async () => {
    const f = await readyFixture();
    f.reviews.stage(f.record.id, f.request);
    const rows = new ProtectedTaskStore<any>(
      f.store,
      f.vault,
      "coding-review-delivery-v1",
    );
    rows.put({ ...rows.get(f.record.id), state: "submitting" });
    f.reviews.close();
    const restored = new TaskReviewService(
      f.service,
      f.registration.token,
      undefined,
      true,
    );
    cleanup.push(() => restored.close());
    const calls = simulatedDelivery(restored);
    restored.configureDelivery(calls);
    await restored.pump();
    expect(calls.request).not.toHaveBeenCalled();
    expect(restored.stage(f.record.id, f.request)).toMatchObject({
      state: "unknown",
      replayed: true,
    });
    expect(restored.ledger.get(f.record.sessionId, f.record.id).state).toBe(
      "unknown",
    );
    expect(() =>
      restored.ledger.prepared(f.record.sessionId, f.record.id, {
        opening: f.record.opening,
        manifestFingerprint: f.request.prepared.grant.manifestFingerprint,
      }),
    ).toThrow(/retired/);
  });

  it("does not replay a synchronous admission refusal", async () => {
    const f = await readyFixture();
    f.reviews.stage(f.record.id, f.request);
    const request = vi.fn(() => {
      throw new Error("synthetic admission refusal");
    });
    f.reviews.configureDelivery({ request });
    await f.reviews.pump();
    await f.reviews.pump();
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.reviews.stage(f.record.id, f.request)).toMatchObject({
      state: "refused",
      replayed: true,
    });
    expect(f.reviews.ledger.get(f.record.sessionId, f.record.id)).toMatchObject(
      {
        state: "blocked",
        reason: "prepared_delivery_refused",
      },
    );
  });

  it("retains uncertainty after reservation followed by an exception", async () => {
    const f = await readyFixture();
    f.reviews.stage(f.record.id, f.request);
    const request = vi.fn(() => {
      f.reviews.ledger.prepared(f.record.sessionId, f.record.id, {
        opening: f.record.opening,
        manifestFingerprint: f.request.prepared.grant.manifestFingerprint,
      });
      f.reviews.ledger.reserve(
        f.record.sessionId,
        f.record.id,
        "original_attempt",
      );
      throw new Error("synthetic failure after reservation");
    });
    f.reviews.configureDelivery({ request });
    await f.reviews.pump();
    await f.reviews.pump();
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.reviews.stage(f.record.id, f.request)).toMatchObject({
      state: "unknown",
      replayed: true,
    });
    expect(f.reviews.ledger.get(f.record.sessionId, f.record.id)).toMatchObject(
      {
        state: "unknown",
        attemptId: "original_attempt",
      },
    );
  });

  it("Stop retires staged work before any call effect", async () => {
    const f = await readyFixture();
    f.reviews.stage(f.record.id, f.request);
    await f.supervisor.reply([], "Stop", "voice");
    f.reviews.configureDelivery(f.delivery);
    await f.reviews.pump();
    expect(f.delivery.request).not.toHaveBeenCalled();
    expect(f.reviews.ledger.get(f.record.sessionId, f.record.id).state).toBe(
      "canceled",
    );
  });

  it("Stop during asynchronous view preparation prevents the prepared envelope from dialing", async () => {
    const f = await readyFixture();
    let resolve!: (value: DesktopCallRequest) => void;
    f.reviews.configureDelivery(f.delivery, {
      prepare: () =>
        new Promise<DesktopCallRequest>((done) => {
          resolve = done;
        }),
    });
    const pumping = f.reviews.pump();
    await f.supervisor.reply([], "Stop", "voice");
    resolve(f.request);
    await pumping;
    expect(f.delivery.request).not.toHaveBeenCalled();
    expect(f.reviews.ledger.get(f.record.sessionId, f.record.id).state).toBe(
      "canceled",
    );
  });
});
