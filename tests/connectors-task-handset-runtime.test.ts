import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger, buildTaskBrief } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
} from "../src/task-presentation-contracts.js";
import {
  runHandsetAttempt,
  type HandsetConfig,
  type SharedHandsetOwner,
} from "../src/control/task-handset-runtime.js";

const boundary = vi.hoisted(() => ({
  preflight: vi.fn(),
  reserve: vi.fn(),
  prepare: vi.fn(),
  dial: vi.fn(),
  inspectorStart: vi.fn(async () => {}),
  inspectorClose: vi.fn(async () => {}),
  inspectorRequest: vi.fn(),
  mediaInspect: vi.fn(async () => ({})),
  spawn: vi.fn(),
  serve: vi.fn(),
  presentationPrepare: vi.fn(async () => ({ ready: true })),
  presentationStop: vi.fn(async () => ({
    captureStopped: true,
    narrationStopped: true,
    outputCleared: true,
    childrenJoined: true,
  })),
}));
vi.mock("@hono/node-server", () => ({ serve: boundary.serve }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: boundary.spawn,
}));
vi.mock("../cli/task-audio-inspector-client.js", () => ({
  TaskAudioInspectorClient: class {
    start = boundary.inspectorStart;
    close = boundary.inspectorClose;
    request = boundary.inspectorRequest;
  },
}));
vi.mock("../src/attention/task-audio-call.js", async (original) => ({
  ...(await original<typeof import("../src/attention/task-audio-call.js")>()),
  TaskAudioCallCoordinator: class {
    preflight = boundary.preflight;
    reserve = boundary.reserve;
    prepare = boundary.prepare;
    dial = boundary.dial;
    status() {
      return { state: "preparing", receipts: {}, cleanupConfirmed: false };
    }
    async inspect() {
      return this.status();
    }
  },
}));
vi.mock("../src/transport/task-audio.js", async (original) => ({
  ...(await original<typeof import("../src/transport/task-audio.js")>()),
  HttpTaskHandsetMediaPort: class {
    inspect = boundary.mediaInspect;
  },
  NativeTaskAudioCalls: class {},
}));
vi.mock("../src/transport/task-presentation.js", async (original) => ({
  ...(await original<typeof import("../src/transport/task-presentation.js")>()),
  HTTPTaskWalkthroughPresentationHost: class {
    prepare = boundary.presentationPrepare;
    stop = boundary.presentationStop;
  },
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function verifyStoppedRuntime(withDiagnostics: boolean) {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const sharingDiagnostics = {
    firstStop: {
      reason: "frame_stale",
      mediaState: "prepared",
      elapsedMs: 2100,
      lastFrameAgeMs: 1050,
    },
    sourceFrames: 8,
    renderedFrames: 24,
    presentationFailure: {
      phase: "source_capture",
      reason: "source_refused",
    },
  };
  const audioOutput = {
    evidence: "sdk_acceptance_not_audibility",
    preparedSilentFrames: 12,
    speechFrames: 0,
  };
  boundary.mediaInspect.mockImplementation(async () => ({
    state: "closed",
    closed: true,
    sharingActive: false,
    audioOutput,
    ...(withDiagnostics ? { sharingDiagnostics } : {}),
    unrelatedRawText: "UNTRUSTED_PROVIDER_OR_SOURCE_TEXT",
  }));
  const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "clawdtime-runtime-race-")),
    ),
    project = join(directory, "project"),
    state = join(directory, "private");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const put = (name: string, value: unknown) => {
    const path = join(state, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const ownerPath = put("owner.lock", {
      pid: process.pid,
      fixtureOwner: true,
    }),
    ownerBefore = readFileSync(ownerPath, "utf8");
  const store = new Store(join(state, "tasks.sqlite")),
    vault = new Vault("ce".repeat(32));
  store.put("pairing", {
    id: "pair",
    memberId: "member",
    deviceId: "device",
    recipient: "fixture",
    conversationId: "fixture",
    lineId: "fixture",
    displayId: "none",
    allowView: false,
    allowControl: false,
    createdAt: Date.now(),
  });
  const tasks = new TaskService(store, vault, new TaskLedger(store, vault), {
    projectRoots: [project],
    simulation: false,
  });
  const session = tasks.register({
    eventId: "session",
    pairingId: "pair",
    hostId: "host",
    projectRoot: project,
    voice: true,
  });
  const worker = {
    run: vi.fn(async () => ({
      outcome: "completed" as const,
      summary: "Synthetic completed work.",
    })),
  };
  const engine = new TaskEngine(
    tasks,
    worker,
    [{ name: "Synthetic", command: ["not-executed"] }],
    async (_project, runId) => ({
      id: `verification_${runId}`,
      runId,
      state: "passed",
      completedAt: Date.now(),
      checks: [
        {
          name: "Synthetic",
          command: ["not-executed"],
          state: "passed",
          exitCode: 0,
          summary: "Synthetic check",
        },
      ],
    }),
  );
  const task = tasks.create(session.token, {
    eventId: "task",
    goal: "Synthetic runtime lifecycle fixture.",
  }).task;
  engine.start(session.session.id, task.id);
  await engine.wait(task.id);
  const ready = tasks.ledger.get(session.session.id, task.id),
    brief = buildTaskBrief(ready),
    now = Date.now();
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation",
    sessionId: session.session.id,
    taskId: task.id,
    runId: ready.runs[0]!.id,
    taskRevision: ready.revision,
    verificationId: ready.verification!.id,
    kind: "review",
    opening: brief.opening,
    fps: 15,
    scenes: [
      {
        id: "preview",
        kind: "preview",
        title: "Synthetic preview",
        narration: brief.opening,
        expectedOutcome: "Synthetic window",
        target: {
          appId: "synthetic.app",
          windowId: "1",
          ownerPid: 1,
          processIdentity: hash("process"),
          displayId: 1,
          titleHash: hash("title"),
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  const voices = new TaskVoiceLedger(store, vault, tasks.ledger);
  let presenter: Parameters<SharedHandsetOwner["bindPresenter"]>[0];
  const voice = new TaskVoiceService(tasks, voices, engine, () => presenter);
  const shared: SharedHandsetOwner = {
    tasks,
    engine,
    voices,
    voice,
    sessionToken: session.token,
    operatorToken: "synthetic_operator_".repeat(3),
    attemptId: "runtime_attempt",
    authorizedAt: now,
    dispatchExpiresAt: now + 60000,
    prepared: {
      manifest,
      grant: {
        version: 1,
        id: "grant",
        manifestFingerprint: taskPresentationFingerprint(manifest),
        sessionId: session.session.id,
        taskId: task.id,
        runId: manifest.runId,
        taskRevision: manifest.taskRevision,
        hostId: "host",
        authorizedAt: now,
        expiresAt: now + 300000,
        localOnly: true,
        capture: true,
        presentation: true,
        control: false,
        nativeActivation: false,
        calls: false,
      },
    },
    bindPresenter: (value) => {
      presenter = value;
    },
  };
  const lineId = "00000000-0000-4000-8000-000000000001";
  const c: HandsetConfig = {
    mode: "handset_walkthrough",
    stateDirectory: state,
    desktopPanel: false,
    projectRoot: project,
    sessionFile: put("session.json", { token: session.token }),
    taskId: task.id,
    attemptDirectory: join(state, "attempt"),
    providerFile: put("provider.json", { synthetic: true }),
    livekitFile: put("livekit.json", { synthetic: true }),
    inspectorBundle: put("inspector.mjs", "synthetic"),
    python: "/never-run/python",
    native: {
      callsOrigin: "https://example.invalid",
      projectId: "project",
      projectKey: "synthetic",
      recipient: "fixture",
      lineId,
    },
    destination: {
      pairingId: "phone_pair",
      memberId: "member",
      deviceId: "capture",
      lineId,
      recipientHash: hash("fixture"),
    },
    railway: {
      binary: "/never-run/railway",
      projectId: lineId,
      environmentId: lineId,
      backendServiceId: lineId,
      deploymentId: lineId,
      restoreRecord: "synthetic",
    },
    authorization: { id: "one_call", userAuthorizedOneCall: true },
    walkthrough: {
      presentationFile: put("prepared.json", shared.prepared),
      helperBinary: "/never-run/helper",
      checksFile: put("checks.json", [
        { name: "Synthetic", command: ["never-run"] },
      ]),
      callDurationMs: 120000,
      userAuthorizedPreparedWindowExport: true,
      userAuthorizedTaskInstructions: true,
    },
  };
  const configPath = put("config.json", c);
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  boundary.serve.mockImplementation(() => {
    const server = new EventEmitter();
    const close = vi.fn((callback?: () => void) => {
      callback?.();
      return server;
    });
    closes.push(close);
    return Object.assign(server, { close });
  });
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", 0));
      return true;
    }),
  });
  boundary.spawn.mockReturnValue(child);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  boundary.preflight.mockReturnValue(blocked);
  const closeEngine = vi.spyOn(engine, "close"),
    closeIdle = vi.spyOn(engine, "closeIfIdle"),
    closeStore = vi.spyOn(store, "close");
  vi.spyOn(console, "log").mockImplementation(() => {});
  let handle: Awaited<ReturnType<typeof runHandsetAttempt>> | undefined;
  cleanup.push(async () => {
    release();
    await handle?.stop();
    await vi.advanceTimersByTimeAsync(1100);
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  handle = await runHandsetAttempt(c, configPath, shared);
  expect(boundary.reserve).not.toHaveBeenCalled();
  expect(boundary.dial).not.toHaveBeenCalled();
  const start = handle.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(boundary.preflight).toHaveBeenCalledOnce();
  let finished = false;
  void handle.finished.then(() => {
    finished = true;
  });
  await handle.stop("synthetic_local_stop");
  await vi.advanceTimersByTimeAsync(1100); // Monitor may observe Stop, but must not settle a still-running preflight.
  expect(finished).toBe(false);
  expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  release();
  await start;
  await expect(handle.finished).resolves.toEqual({ cleanupConfirmed: true });
  expect(boundary.reserve).not.toHaveBeenCalled();
  expect(boundary.prepare).not.toHaveBeenCalled();
  expect(boundary.dial).not.toHaveBeenCalled();
  const summaryText = readFileSync(
    join(c.attemptDirectory, "shutdown-summary.json"),
    "utf8",
  );
  const summary = JSON.parse(summaryText);
  expect(summary).toEqual({
    at: expect.any(Number),
    undialed: true,
    audioOutput,
    ...(withDiagnostics ? { sharingDiagnostics } : {}),
    physicalAcceptance: false,
  });
  expect(summaryText).not.toContain("UNTRUSTED_PROVIDER_OR_SOURCE_TEXT");
  expect(summaryText).not.toContain("unrelatedRawText");
  expect(boundary.inspectorClose).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  expect(closes).toHaveLength(2);
  expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  expect(closeEngine).not.toHaveBeenCalled();
  expect(closeIdle).not.toHaveBeenCalled();
  expect(closeStore).not.toHaveBeenCalled();
  expect(readFileSync(ownerPath, "utf8")).toBe(ownerBefore);
  expect(tasks.ledger.get(session.session.id, task.id)).toEqual(ready);
  expect(presenter).toBeUndefined();
  const revised = tasks.ledger.transition(session.session.id, task.id, {
    eventId: "after_call",
    action: "decide",
    runId: ready.runs[0]!.id,
    expectedRevision: ready.revision,
    instruction: "Make another scoped synthetic revision.",
  }).task;
  engine.start(session.session.id, revised.id);
  await engine.wait(revised.id);
  expect(worker.run).toHaveBeenCalledTimes(2);
  expect(tasks.ledger.get(session.session.id, task.id).state).toBe(
    "review_ready",
  );
}

it.each([false, true])(
  "joins stopped preflight and preserves bounded shutdown diagnostics when present (%s)",
  verifyStoppedRuntime,
);
