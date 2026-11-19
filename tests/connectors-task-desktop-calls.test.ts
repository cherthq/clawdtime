import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger, buildTaskBrief } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { TaskDesktopService } from "../src/control/task-desktop-service.js";
import {
  TaskDesktopCalls,
  type DesktopAttemptFactory,
  type DesktopHandsetAttempt,
} from "../src/control/task-desktop-calls.js";
import { createTaskApp } from "../src/control/task-app.js";
import type {
  DesktopCallsConfig,
  DesktopCallRequest,
} from "../src/control/task-desktop-calls-config.js";
import type { TaskWorkerResult, TaskWorker } from "../src/contracts.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
} from "../src/task-presentation-contracts.js";
import {
  taskWalkthroughFingerprint,
  type TaskWalkthroughPlan,
} from "../src/task-walkthrough-contracts.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-desktop-calls-")),
  );
  const project = join(directory, "project"),
    privateDir = join(directory, "private");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(privateDir, { mode: 0o700 });
  const store = new Store(join(privateDir, "tasks.sqlite")),
    vault = new Vault("bd".repeat(32));
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
  const second = deferred<TaskWorkerResult>();
  const run = vi.fn<TaskWorker["run"]>(async (_request, _emit, signal) => {
    if (run.mock.calls.length === 1)
      return {
        outcome: "completed",
        summary: "Filter implemented; empty state needs a choice.",
        decision: "What should appear with no matches?",
        decisionOptions: ["Show Clear filters", "Show an empty list"],
      };
    expect(signal.aborted).toBe(false);
    return second.promise;
  });
  let verification = 0;
  const verify = vi.fn(async (_project: string, runId: string) => ({
    id: `verify_${++verification}`,
    runId,
    state: "passed" as const,
    completedAt: Date.now(),
    checks: [
      {
        name: "Synthetic independent behavior",
        command: ["synthetic-check"],
        state: "passed" as const,
        exitCode: 0,
        summary: "Synthetic verifier passed.",
      },
    ],
  }));
  const engine = new TaskEngine(
    tasks,
    { run },
    [{ name: "Synthetic independent behavior", command: ["synthetic-check"] }],
    verify,
  );
  const closeEngine = vi.spyOn(engine, "close"),
    closeIdle = vi.spyOn(engine, "closeIfIdle");
  const voices = new TaskVoiceLedger(store, vault, tasks.ledger);
  let calls!: TaskDesktopCalls;
  const voice = new TaskVoiceService(
    tasks,
    voices,
    engine,
    () => calls.presentationPort,
  );
  const uiToken = "synthetic_ui_".repeat(4),
    operator = "synthetic_operator_".repeat(4);
  const file = (name: string, value: unknown) => {
    const path = join(privateDir, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return path;
  };
  const lineId = "00000000-0000-4000-8000-000000000001",
    recipient = "synthetic_destination";
  const config: DesktopCallsConfig = {
    version: 1,
    providerFile: file("provider.json", { synthetic: true }),
    livekitFile: file("livekit.json", { synthetic: true }),
    inspectorBundle: file("inspector.json", { synthetic: true }),
    python: file("python", { synthetic: true }),
    helperBinary: file("helper", { synthetic: true }),
    attemptRoot: join(privateDir, "attempts"),
    native: {
      callsOrigin: "https://calls.example.invalid",
      projectId: "project",
      projectKey: "synthetic_private_key",
      recipient,
      lineId,
    },
    destination: {
      pairingId: "phone_pair",
      memberId: "member",
      deviceId: "phone_device",
      lineId,
      recipientHash: hash(recipient),
    },
    railway: {
      binary: file("railway", { synthetic: true }),
      projectId: lineId,
      environmentId: lineId,
      backendServiceId: lineId,
    },
  };
  mkdirSync(config.attemptRoot, { mode: 0o700 });
  const configPath = file("calls.json", config),
    sessionPath = file("session.json", { token: session.token }),
    checksPath = file("checks.json", [
      { name: "Synthetic", command: ["synthetic-check"] },
    ]);
  // This injected port supplies synthetic native receipts; it never starts a subprocess or contacts a provider.
  const audio = new ProtectedTaskStore<any>(
    store,
    vault,
    "coding-task-audio-call-v1",
  );
  const attempts: Array<{
    plan: TaskWalkthroughPlan;
    opened: ReturnType<TaskVoiceService["openWalkthrough"]>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    finish: () => void;
  }> = [];
  const factory = vi.fn<DesktopAttemptFactory>(async (config, _path, owner) => {
    expect(owner.tasks).toBe(tasks);
    expect(owner.engine).toBe(engine);
    expect(owner.voice).toBe(voice);
    expect(owner.voices).toBe(voices);
    expect(owner.sessionToken).toBe(session.token);
    expect(config.desktopPanel).toBe(false);
    expect(calls.ledger.unresolved()).toHaveLength(1); // Admission is durable before factory effects.
    const { manifest, grant } = owner.prepared;
    const exportGrantId = `export_${attempts.length}`;
    const opened = voice.openWalkthrough(
      session.token,
      manifest.taskId,
      {
        eventId: owner.attemptId,
        runId: manifest.runId,
        expectedRevision: manifest.taskRevision,
      },
      {
        mode: "handset_walkthrough",
        callAttemptId: owner.attemptId,
        exportGrantId,
        presentationId: manifest.id,
        manifestFingerprint: grant.manifestFingerprint,
      },
    );
    const plan: TaskWalkthroughPlan = {
      version: 1,
      mode: "handset_walkthrough",
      id: owner.attemptId,
      taskSessionId: session.session.id,
      taskId: manifest.taskId,
      runId: manifest.runId,
      revision: manifest.taskRevision,
      voiceSessionId: opened.voice.id,
      ...config.destination,
      mediaSessionId: `media_${attempts.length}`,
      workerIdentity: "worker",
      agentIdentity: "agent",
      exportGrantId,
      callKind: manifest.kind,
      presentationBinding: {
        presentationId: manifest.id,
        manifestFingerprint: grant.manifestFingerprint,
        presentationGrantId: grant.id,
        verificationId: manifest.verificationId,
        hostId: "host",
        captureDeviceId: config.destination.deviceId,
      },
      dispatchExpiresAt: owner.dispatchExpiresAt,
      expiresAt: owner.authorizedAt + config.walkthrough!.callDurationMs,
      audio: true,
      video: true,
      screen: true,
      presentation: true,
      instructions: true,
      control: false,
      nativeActivation: false,
      maxCalls: 1,
    };
    let ended = false,
      sharing = true;
    const finished = deferred<{ cleanupConfirmed: true }>();
    const start = vi.fn(async () => {
      audio.put({
        id: plan.id,
        plan,
        fingerprint: taskWalkthroughFingerprint(plan),
        state: "connected",
        stopRequested: false,
        mediaClosed: false,
        nativeCleanupComplete: false,
        providerCallId: lineId,
        receipts: {
          native_dial: { id: "dial", state: "done" },
          media_activate: { id: "activate", state: "done" },
        },
        nativeObservation: {
          providerCallId: lineId,
          state: "connected",
          cleanupComplete: false,
          observedAt: Date.now(),
        },
      });
      voice.bind(opened.token, plan.taskId, opened.voice.id, {
        providerConversationId: `provider_${plan.id}`,
      });
    });
    const finish = () => {
      if (ended) return;
      ended = true;
      sharing = false;
      voices.end(opened.voice.id, `end_${plan.id}`);
      const prior = audio.get(plan.id);
      audio.put({
        ...prior,
        id: plan.id,
        state: "closed",
        stopRequested: true,
        mediaClosed: true,
        nativeCleanupComplete: true,
        nativeObservation: {
          providerCallId: lineId,
          state: "ended",
          cleanupComplete: true,
          observedAt: Date.now(),
        },
      });
      finished.resolve({ cleanupConfirmed: true });
    };
    const stop = vi.fn(async () => finish());
    const controls = {
      snapshot: () => ({
        controlId: plan.id,
        callActive: !ended,
        sharingActive: !ended && sharing,
        canStopCall: !ended,
        canStopSharing: !ended && sharing,
      }),
      stopCall: async (id: string) => {
        expect(id).toBe(plan.id);
        await stop();
      },
      stopSharing: async (id: string) => {
        expect(id).toBe(plan.id);
        sharing = false;
      },
    };
    attempts.push({ plan, opened, start, stop, finish });
    return {
      start,
      stop,
      controls,
      finished: finished.promise,
      presentationPort: undefined,
      status: () => ({
        state: ended ? "ended" : "connected",
        reserved: true,
        ended,
      }),
    } satisfies DesktopHandsetAttempt;
  });
  calls = new TaskDesktopCalls(
    tasks,
    engine,
    voices,
    voice,
    {
      config,
      configPath,
      stateDirectory: privateDir,
      projectRoot: project,
      sessionPath,
      sessionToken: session.token,
      checksPath,
      operatorToken: operator,
    },
    factory,
  );
  const desktop = new TaskDesktopService(
    tasks,
    engine,
    {
      desktopId: "desktop_stable",
      instanceId: "instance_stable",
      configurationFingerprint: hash("config"),
      token: uiToken,
      sessionToken: session.token,
      worker: "codex",
    },
    calls,
  );
  const app = createTaskApp(
    tasks,
    operator,
    engine,
    voice,
    undefined,
    undefined,
    desktop,
    calls,
  );
  calls.selectedTaskId = () => desktop.selectedTaskId();
  const api = (
    path: string,
    token: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const snapshot = async () => (await api("/desktop/state", uiToken)).json();
  const get = () => tasks.ledger.list(session.session.id).at(-1)!;
  const ready = async () => {
    expect(
      (
        await api("/desktop/operations", uiToken, {
          eventId: "submit",
          action: "submit",
          goal: "Add a filter to the synthetic task list.",
        })
      ).status,
    ).toBe(200);
    await engine.wait(get().id);
    expect(get().state).toBe("needs_decision");
    return get();
  };
  const request = (eventId = "decision_call"): DesktopCallRequest => {
    const task = get(),
      brief = buildTaskBrief(task),
      now = Date.now();
    const manifest: TaskPresentationManifest = {
      version: 1,
      id: `presentation_${eventId}`,
      sessionId: session.session.id,
      taskId: task.id,
      runId: task.runs.at(-1)!.id,
      taskRevision: task.revision,
      verificationId: task.verification!.id,
      kind: brief.kind,
      opening: brief.opening,
      fps: 15,
      scenes: [
        {
          id: "preview",
          kind: "preview",
          title: "Synthetic preview",
          narration: brief.opening,
          expectedOutcome: "Synthetic preview visible",
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
    return {
      eventId,
      taskId: task.id,
      runId: manifest.runId,
      expectedRevision: task.revision,
      authorizationId: `authorization_${eventId}`,
      authorizedAt: now,
      expiresAt: now + 60000,
      callDurationMs: 120000,
      userAuthorizedOneCall: true,
      userAuthorizedPreparedWindowExport: true,
      userAuthorizedTaskInstructions: true,
      standby: {
        deploymentId: lineId,
        restoreRecord: "synthetic_decision_restore",
      },
      prepared: {
        manifest,
        grant: {
          version: 1,
          id: `grant_${eventId}`,
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
    };
  };
  const speak = async (
    index: number,
    text: string,
    utteranceId: string,
    action: "instructions" | "accept",
  ) => {
    const a = attempts[index]!,
      task = get(),
      base = `/tasks/${task.id}/voice/${a.opened.voice.id}`;
    expect(
      (
        await api(`${base}/utterances`, a.opened.token, {
          providerConversationId: `provider_${a.plan.id}`,
          utteranceId,
          runId: task.runs.at(-1)!.id,
          expectedRevision: task.revision,
          text,
        })
      ).status,
    ).toBe(200);
    return api(`${base}/${action}`, a.opened.token, {
      eventId: utteranceId,
      utteranceId,
    });
  };
  cleanups.push(async () => {
    attempts.forEach((a) => a.finish());
    second.resolve({
      outcome: "completed",
      summary: "Synthetic follow-up complete.",
    });
    await calls.close().catch(() => {});
    await engine.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    api,
    app,
    snapshot,
    get,
    ready,
    request,
    speak,
    calls,
    factory,
    attempts,
    tasks,
    voices,
    voice,
    engine,
    run,
    verify,
    second,
    closeEngine,
    closeIdle,
    session,
    uiToken,
    operator,
    config,
    project,
    privateDir,
    configPath,
  };
}

describe("same-owner desktop task and prepared call integration", () => {
  it("clarifies bare assent and preserves recorded options for a later ordinal choice in the next worker context", async () => {
    const f = fixture();
    await f.ready();
    const options = ["Show Clear filters", "Show an empty list"];
    const before = f.get();
    expect(
      (await f.api("/operator/desktop-calls", f.operator, f.request())).status,
    ).toBe(202);
    await vi.waitFor(() => expect(f.attempts[0]?.start).toHaveBeenCalledOnce());
    const a = f.attempts[0]!;
    const unavailable = async () => {
      throw Error(
        "Synthetic presentation mutation is not part of this context test.",
      );
    };
    f.calls.presentationPort = {
      context: (voice) => {
        expect(voice.id).toBe(a.opened.voice.id);
        return { scenes: [], exportActive: true };
      },
      opening: unavailable,
      show: unavailable,
      stop: unavailable,
      retire: unavailable,
    };
    const contextResponse = await f.api(
      `/tasks/${before.id}/voice/${a.opened.voice.id}/context`,
      a.opened.token,
    );
    expect(contextResponse.status).toBe(200);
    const context = await contextResponse.json();
    expect(context.decisionOptions).toEqual(options);
    const clarification = await f.speak(
      0,
      "Yes.",
      "bare_assent",
      "instructions",
    );
    expect(clarification.status).toBe(200);
    expect(await clarification.json()).toEqual({
      state: "clarification_required",
      instructionSubmitted: false,
      taskId: before.id,
      question: "What should appear with no matches?",
      options,
    });
    expect(f.get()).toEqual(before);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.tasks.store.all("coding-task-voice-instruction-v1")).toHaveLength(
      0,
    );
    const explicit = await f.speak(
      0,
      "Use option two.",
      "explicit_ordinal",
      "instructions",
    );
    expect(explicit.status).toBe(200);
    expect((await explicit.json()).state).toBe("applied");
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    const workerContext = JSON.parse(f.run.mock.calls[1]![0].context);
    expect(workerContext.decision).toMatchObject({
      question: "What should appear with no matches?",
      options,
      answered: true,
      answerSource: "instruction",
    });
    expect(workerContext.instruction).toBe("Use option two.");
    expect(f.get().runs.at(-1)!.instruction).toBe("Use option two.");
    expect(f.get().runs).toHaveLength(2);
    f.second.resolve({
      outcome: "completed",
      summary: "Synthetic explicit choice completed.",
    });
    await f.engine.wait(before.id);
    expect(f.get().state).toBe("review_ready");
  });
  it("keeps one service/task/session through decision, spoken run, call Stop, fresh review and acceptance", async () => {
    const f = fixture(),
      initial = await f.snapshot();
    const staticConfigBytes = readFileSync(f.configPath, "utf8");
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    await f.ready();
    expect((await f.snapshot()).callFlow.state).toBe(
      "awaiting_call_authorization",
    );
    const envelope = f.request();
    const first = await f.api("/operator/desktop-calls", f.operator, envelope);
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(f.attempts[0]?.start).toHaveBeenCalledOnce());
    const replay = await f.api("/operator/desktop-calls", f.operator, envelope);
    expect((await replay.json()).replayed).toBe(true);
    expect(
      (
        await f.api("/operator/desktop-calls", f.operator, {
          ...envelope,
          callDurationMs: 90000,
        })
      ).status,
    ).toBe(409);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(
      (
        await f.api("/operator/desktop-calls", f.operator, {
          ...envelope,
          standby: { ...envelope.standby, restoreRecord: "changed_same_event" },
        })
      ).status,
    ).toBe(409);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(
      (
        await f.speak(
          0,
          "Show an empty state with a Clear filters button.",
          "spoken_answer",
          "instructions",
        )
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2));
    expect(f.get().state).toBe("running");
    expect(
      (
        await f.api("/desktop/operations", f.uiToken, {
          eventId: "stop_call",
          action: "stop_call",
          controlId: f.attempts[0]!.plan.id,
        })
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(f.calls.ledger.unresolved()).toHaveLength(0));
    expect(f.get().state).toBe("running");
    expect(f.run.mock.calls[1]![2].aborted).toBe(false);
    expect(f.closeEngine).not.toHaveBeenCalled();
    expect(f.closeIdle).not.toHaveBeenCalled();
    f.second.resolve({
      outcome: "completed",
      summary: "The requested empty state and Clear filters button are ready.",
    });
    await f.engine.wait(f.get().id);
    expect(f.get().state).toBe("review_ready");
    expect(f.verify).toHaveBeenCalledTimes(2);
    const reviewEnvelope = f.request("review_call");
    reviewEnvelope.standby = {
      deploymentId: "00000000-0000-4000-8000-000000000002",
      restoreRecord: "synthetic_fresh_review_restore",
    };
    expect(
      (await f.api("/operator/desktop-calls", f.operator, reviewEnvelope))
        .status,
    ).toBe(202);
    await vi.waitFor(() => expect(f.attempts[1]?.start).toHaveBeenCalledOnce());
    expect(
      (await f.speak(1, "I accept the result.", "accept_result", "accept"))
        .status,
    ).toBe(200);
    expect(f.get().state).toBe("accepted");
    f.attempts[1]!.finish();
    await vi.waitFor(() => expect(f.calls.ledger.unresolved()).toHaveLength(0));
    expect(new Set(f.attempts.map((a) => a.plan.id)).size).toBe(2);
    expect(new Set(f.attempts.map((a) => a.opened.voice.id)).size).toBe(2);
    expect(f.get().runs).toHaveLength(2);
    expect(new Set(f.get().runs.map((r) => r.id)).size).toBe(2);
    expect(f.attempts.map((a) => a.plan.callKind)).toEqual([
      "decision",
      "review",
    ]);
    expect(f.tasks.store.all("task-session")).toHaveLength(1);
    for (const key of [
      "desktopId",
      "instanceId",
      "configurationFingerprint",
      "projectRoot",
    ])
      expect((await f.snapshot())[key]).toEqual(initial[key]);
    expect(
      f.attempts.every(
        (a) =>
          a.plan.taskId === f.get().id &&
          a.plan.taskSessionId === f.session.session.id,
      ),
    ).toBe(true);
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.factory.mock.calls[0]![0].railway).toEqual({
      ...f.config.railway,
      ...envelope.standby,
    });
    expect(f.factory.mock.calls[1]![0].railway).toEqual({
      ...f.config.railway,
      ...reviewEnvelope.standby,
    });
    expect(readFileSync(f.configPath, "utf8")).toBe(staticConfigBytes);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("exposes sanitized callFlow only and refuses nonoperator or browser call requests", async () => {
    const f = fixture();
    await f.ready();
    const envelope = f.request();
    for (const token of [f.uiToken, f.session.token, "wrong_operator"])
      for (const body of [undefined, envelope])
        expect(
          (await f.api("/operator/desktop-calls", token, body)).status,
        ).toBe(401);
    expect(
      (
        await f.api("/operator/desktop-calls", f.operator, envelope, {
          origin: "http://127.0.0.1:13326",
        })
      ).status,
    ).toBe(403);
    expect(Object.keys((await f.snapshot()).callFlow).sort()).toEqual([
      "message",
      "state",
    ]);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("latches desktop Stop during delayed preparation without starting the returned attempt", async () => {
    const f = fixture();
    await f.ready();
    const release = deferred<void>(),
      original = f.factory.getMockImplementation()!;
    f.factory.mockImplementationOnce(async (...args) => {
      await release.promise;
      return original(...args);
    });
    expect(
      (await f.api("/operator/desktop-calls", f.operator, f.request())).status,
    ).toBe(202);
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce());
    const pending = f.calls.snapshot();
    expect(pending.canStopCall).toBe(true);
    try {
      const wrong = await f.api("/desktop/operations", f.uiToken, {
        eventId: "wrong_stop",
        action: "stop_call",
        controlId: "foreign_call",
      });
      expect((await wrong.json()).state).toBe("refused");
      const stop = await f.api("/desktop/operations", f.uiToken, {
        eventId: "stop_preparation",
        action: "stop_call",
        controlId: pending.controlId,
      });
      expect(stop.status).toBe(200);
    } finally {
      release.resolve();
    }
    await vi.waitFor(() => expect(f.calls.ledger.unresolved()).toHaveLength(0));
    expect(f.attempts).toHaveLength(1);
    expect(f.attempts[0]!.start).not.toHaveBeenCalled();
    expect(f.attempts[0]!.stop).toHaveBeenCalledOnce();
    expect(f.closeEngine).not.toHaveBeenCalled();
    expect(f.closeIdle).not.toHaveBeenCalled();
    expect(f.get().state).toBe("needs_decision");
  });

  it.each([
    "stale",
    "expired",
    "wrong-task",
    "wrong-grant",
    "authorization-id-too-long",
    "missing-standby",
    "invalid-standby",
    "no-export",
    "private-mode",
    "worker-project",
    "destination",
  ])("refuses %s before factory dispatch", async (kind) => {
    const f = fixture();
    await f.ready();
    const envelope = f.request();
    if (kind === "stale") envelope.expectedRevision--;
    if (kind === "expired") {
      envelope.authorizedAt -= 120000;
      envelope.expiresAt = Date.now() - 1;
    }
    if (kind === "wrong-task") envelope.taskId = "foreign_task";
    if (kind === "missing-standby") delete (envelope as any).standby;
    if (kind === "invalid-standby")
      envelope.standby.deploymentId = "not-a-deployment-id";
    if (kind === "wrong-grant") envelope.prepared.grant.hostId = "foreign_host";
    if (kind === "authorization-id-too-long")
      envelope.authorizationId = "a".repeat(121);
    if (kind === "no-export")
      (envelope as any).userAuthorizedPreparedWindowExport = false;
    if (kind === "private-mode") chmodSync(f.config.providerFile, 0o644);
    if (kind === "worker-project") {
      f.config.providerFile = join(f.project, "provider.json");
      writeFileSync(f.config.providerFile, "{}", { mode: 0o600 });
    }
    if (kind === "destination") f.config.native.recipient = "different";
    expect(
      (await f.api("/operator/desktop-calls", f.operator, envelope)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.calls.ledger.unresolved()).toHaveLength(0);
  });

  it("preserves unknown factory failure without replay or a fresh attempt", async () => {
    const f = fixture();
    await f.ready();
    f.factory.mockRejectedValueOnce(Error("Synthetic uncertain bootstrap"));
    const envelope = f.request();
    expect(
      (await f.api("/operator/desktop-calls", f.operator, envelope)).status,
    ).toBe(202);
    await vi.waitFor(() =>
      expect(f.calls.ledger.unresolved()[0]?.state).toBe("unknown"),
    );
    expect(
      (await f.api("/operator/desktop-calls", f.operator, envelope)).status,
    ).toBe(202);
    expect(
      (await f.api("/operator/desktop-calls", f.operator, f.request("fresh")))
        .status,
    ).toBe(409);
    expect((await f.snapshot()).callFlow.state).toBe("reconciliation_required");
    expect(
      f.tasks.readiness(f.session.token, f.get().id).blockedReasons,
    ).toContain("desktop_call_reconciliation_required");
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.get().state).toBe("needs_decision");
    await expect(f.calls.close()).rejects.toThrow(/reconciliation/);
  });
});
