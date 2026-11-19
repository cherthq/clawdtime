import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/storage/store.js";
import { ProtectedTaskStore } from "../src/storage/task-store.js";
import { Vault, hash } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskPresentationLedger } from "../src/attention/task-presentation-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { TaskPresentationService } from "../src/control/task-presentation-service.js";
import { TaskWalkthroughPresentation } from "../src/control/task-walkthrough-presentation.js";
import { createTaskApp } from "../src/control/task-app.js";
import { assertConnectedTaskWalkthroughVoice } from "../src/attention/task-audio-call.js";
import type { TaskEngine } from "../src/control/task-engine.js";
import type { TaskCommand } from "../src/contracts.js";
import {
  taskPresentationFingerprint,
  type TaskPresentationManifest,
  type TaskPresentationGrant,
  type TaskSceneFrame,
} from "../src/task-presentation-contracts.js";
import {
  taskWalkthroughFingerprint,
  type TaskWalkthroughPlan,
} from "../src/task-walkthrough-contracts.js";
import type { TaskWalkthroughVideoEvidence } from "../src/transport/task-audio.js";
import {
  taskHandsetMediaBinding,
  taskHandsetMediaFingerprint,
  taskWalkthroughSharingDiagnosticsSchema,
} from "../src/transport/task-audio.js";
import { taskWalkthroughExportGrantSchema } from "../src/task-walkthrough-contracts.js";
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
async function fixture(
  options: { continuity?: boolean; artifact?: boolean } = {},
) {
  const project = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-voice-authority-")),
  );
  const store = new Store();
  cleanups.push(() => {
    store.close();
    rmSync(project, { recursive: true, force: true });
  });
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
  const vault = new Vault("cd".repeat(32));
  const ledger = new TaskLedger(store, vault);
  const tasks = new TaskService(store, vault, ledger, {
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
  const taskId = tasks.create(session.token, {
    eventId: "task",
    goal: "Implement the fixture filter.",
  }).task.id;
  const get = () => ledger.get(session.session.id, taskId);
  let event = 0;
  const transition = (command: Record<string, unknown>) =>
    ledger.transition(session.session.id, taskId, {
      eventId: `event-${++event}`,
      expectedRevision: get().revision,
      ...command,
    } as TaskCommand).task;
  const terminal = (outcome = "completed", verification = "passed") => {
    const run = get().runs.at(-1)!;
    transition({
      action: "run_result",
      runId: run.id,
      dispatchId: run.dispatchId,
      outcome,
      summary: "Synthetic worker terminal receipt.",
    });
    if (outcome !== "unknown")
      transition({
        action: "verify_result",
        verification: {
          id: `verification-${event}`,
          runId: run.id,
          completedAt: Date.now(),
          state: verification,
          checks: [
            {
              name: "Fixture assertions",
              command: ["fixture-test"],
              state: verification,
              exitCode: verification === "passed" ? 0 : 1,
              summary: "Synthetic check outcome.",
            },
          ],
        },
      });
  };
  transition({ action: "claim_run", runId: get().runs.at(-1)!.id });
  terminal();
  const target = {
    appId: "fixture.app",
    windowId: "1",
    ownerPid: 1,
    processIdentity: hash("process"),
    displayId: 1,
    titleHash: hash("window"),
  };
  const artifactPath = join(project, "source.txt");
  if (options.artifact) writeFileSync(artifactPath, "prepared source");
  const manifest: TaskPresentationManifest = {
    version: 1,
    id: "presentation",
    sessionId: session.session.id,
    taskId,
    runId: get().runs.at(-1)!.id,
    taskRevision: get().revision,
    verificationId: get().verification!.id,
    kind: "review",
    opening: get().brief!.opening,
    fps: 15,
    scenes: [
      {
        id: "code",
        kind: "code",
        title: "Code",
        narration: get().brief!.opening,
        expectedOutcome: "Code visible",
        ...(options.artifact
          ? {
              artifact: {
                relativePath: "source.txt",
                sha256: hash("prepared source"),
              },
            }
          : {}),
        target,
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
      {
        id: "preview",
        kind: "preview",
        title: "Preview",
        narration: "The empty state is ready.",
        expectedOutcome: "Preview visible",
        target,
        focus: { x: 0, y: 0, width: 1, height: 1 },
        transitionMs: 550,
      },
    ],
  };
  const now = Date.now();
  const grant: TaskPresentationGrant = {
    version: 1,
    id: "grant",
    manifestFingerprint: taskPresentationFingerprint(manifest),
    sessionId: session.session.id,
    taskId,
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
    ...(options.continuity ? { continuity: "call" as const } : {}),
  };
  let frame: TaskSceneFrame;
  let observationPatch: Partial<TaskSceneFrame> = {};
  let evidencePatch: Partial<TaskWalkthroughVideoEvidence> = {};
  const host = {
    prepare: vi.fn(async () => ({ ready: true as const })),
    show: vi.fn(
      async (input: {
        presentationId: string;
        operationId: string;
        manifestFingerprint: string;
        sceneId: string;
        generation: number;
      }) => {
        const time = Date.now();
        frame = {
          ...input,
          target,
          sourceFrameId: `frame-${input.generation}`,
          geometryGeneration: "geometry",
          contentRevision: hash("content"),
          capturedAt: time,
          renderedAt: time,
          transitionCompletedAt: time,
          evidence: "local_frame_rendered_not_human_seen",
        };
        return frame;
      },
    ),
    observe: vi.fn(async () => ({ ...frame, ...observationPatch })),
    narrate: vi.fn(async () => ({
      completed: true as const,
      evidence: "playback_completed_not_audibility" as const,
    })),
    stop: vi.fn(async () => ({
      captureStopped: true as const,
      narrationStopped: true as const,
      outputCleared: true as const,
      childrenJoined: true as const,
    })),
  };
  const voiceLedger = new TaskVoiceLedger(store, vault, ledger);
  const engine = { onSettled: vi.fn(), start: vi.fn(), cancel: vi.fn() };
  let presenter: TaskWalkthroughPresentation;
  const voice = new TaskVoiceService(
    tasks,
    voiceLedger,
    engine as unknown as TaskEngine,
    () => presenter,
  );
  const opened = voice.openWalkthrough(
    session.token,
    taskId,
    {
      eventId: "voice-open",
      runId: manifest.runId,
      expectedRevision: manifest.taskRevision,
    },
    {
      mode: "handset_walkthrough",
      callAttemptId: "call",
      exportGrantId: "export",
      presentationId: manifest.id,
      manifestFingerprint: grant.manifestFingerprint,
    },
  );
  const plan: TaskWalkthroughPlan = {
    version: 1,
    mode: "handset_walkthrough",
    id: "call",
    taskSessionId: session.session.id,
    taskId,
    runId: manifest.runId,
    revision: manifest.taskRevision,
    voiceSessionId: opened.voice.id,
    pairingId: "real-pair",
    memberId: "real-member",
    deviceId: "real-device",
    lineId: "11111111-1111-4111-8111-111111111111",
    recipientHash: hash("synthetic"),
    mediaSessionId: "media",
    workerIdentity: "worker",
    agentIdentity: "agent",
    exportGrantId: "export",
    callKind: "review",
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
  let preparing = true;
  const initial = vi.fn(() => {
    if (!preparing) throw Error("Initial authority unavailable");
  });
  const ongoing = vi.fn(() =>
    assertConnectedTaskWalkthroughVoice(store, vault, opened.voice),
  );
  const captureBinding = options.continuity
    ? {
        callAttemptId: plan.id,
        voiceSessionId: opened.voice.id,
        exportGrantId: plan.exportGrantId,
        planFingerprint: taskWalkthroughFingerprint(plan),
        expiresAt: plan.expiresAt,
      }
    : undefined;
  const authorizeCapture = options.continuity
    ? vi.fn((record, binding) => {
        expect(binding).toEqual(captureBinding);
        expect(record.manifest.id).toBe(manifest.id);
        if (preparing) initial();
        else ongoing();
      })
    : undefined;
  const presentationLedger = new TaskPresentationLedger(
    store,
    vault,
    ledger,
    Date.now,
    authorizeCapture,
  );
  const presentation = new TaskPresentationService(
    tasks,
    presentationLedger,
    host,
    { manifest, grant },
    Date.now,
    captureBinding,
  );
  await presentation.prepare(session.token, taskId, {
    eventId: "prepare",
    manifest,
    grant,
  });
  const evidenceFor = vi.fn(
    (f: TaskSceneFrame): TaskWalkthroughVideoEvidence => ({
      evidence: "sdk_frame_accepted_not_remote_seen",
      presentationId: f.presentationId,
      manifestFingerprint: f.manifestFingerprint,
      sceneId: f.sceneId,
      generation: f.generation,
      sourceFrameId: f.sourceFrameId,
      geometryGeneration: f.geometryGeneration,
      capturedAt: f.capturedAt,
      renderedAt: f.renderedAt,
      acceptedAt: Date.now(),
      ...evidencePatch,
    }),
  );
  presenter = new TaskWalkthroughPresentation(
    presentation,
    plan,
    manifest,
    session.token,
    evidenceFor,
    { initial, ongoing, preparing: () => preparing },
  );
  const records = new ProtectedTaskStore<any>(
    store,
    vault,
    "coding-task-audio-call-v1",
  );
  const connect = () => {
    preparing = false;
    records.put({
      id: plan.id,
      plan,
      fingerprint: taskWalkthroughFingerprint(plan),
      state: "connected",
      stopRequested: false,
      mediaClosed: false,
      nativeCleanupComplete: false,
      providerCallId: "11111111-1111-4111-8111-111111111112",
      receipts: {
        native_dial: { id: "dial", state: "done" },
        media_activate: { id: "activate", state: "done" },
      },
      nativeObservation: {
        providerCallId: "11111111-1111-4111-8111-111111111112",
        state: "connected",
        cleanupComplete: false,
        observedAt: Date.now(),
      },
    });
  };
  const app = createTaskApp(
    tasks,
    "operator".repeat(8),
    engine as unknown as TaskEngine,
    voice,
    presentation,
    { taskId, voiceId: opened.voice.id, presentationId: manifest.id },
  );
  const base = `/tasks/${taskId}/voice/${opened.voice.id}`;
  const api = (suffix: string, body?: unknown, token = opened.token) =>
    app.request(base + suffix, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const bind = () => api("/bind", { providerConversationId: "provider" });
  const utterance = (
    id: string,
    text = "Show the preview.",
    patch: Record<string, unknown> = {},
  ) =>
    api("/utterances", {
      providerConversationId: "provider",
      utteranceId: id,
      runId: get().runs.at(-1)!.id,
      expectedRevision: get().revision,
      text,
      ...patch,
    });
  const opening = () =>
    api("/presentation/opening", { eventId: "opening_call" });
  const show = (
    eventId = "show",
    utteranceId = "speech",
    sceneId = "preview",
  ) => api("/presentation/show", { eventId, utteranceId, sceneId });
  return {
    app,
    artifactPath,
    store,
    vault,
    session,
    tasks,
    get,
    transition,
    terminal,
    voice,
    voiceLedger,
    opened,
    manifest,
    grant,
    plan,
    presentation,
    presentationLedger,
    presenter,
    host,
    records,
    engine,
    initial,
    ongoing,
    evidenceFor,
    api,
    bind,
    utterance,
    opening,
    show,
    connect,
    setPreparing: (value: boolean) => {
      preparing = value;
    },
    observation: (patch: Partial<TaskSceneFrame>) => {
      observationPatch = patch;
    },
    evidence: (patch: Partial<TaskWalkthroughVideoEvidence>) => {
      evidencePatch = patch;
    },
  };
}

describe("task-bound walkthrough HTTP presentation and acceptance", () => {
  it.each([false, true])(
    "round-trips real TS binding/context/export JSON through Python (continuity=%s)",
    async (continuity) => {
      const f = await fixture({ continuity });
      const context = await (await f.api("/context")).json();
      const opening = await (await f.opening()).json();
      const binding = taskHandsetMediaBinding(f.plan);
      const prepared = {
        presentationId: f.manifest.id,
        manifest: f.manifest,
        grant: f.grant,
        fingerprint: taskPresentationFingerprint(f.manifest),
      };
      const exportGrant = taskWalkthroughExportGrantSchema.parse({
        version: 1,
        mode: "handset_walkthrough",
        id: f.plan.exportGrantId,
        planFingerprint: taskWalkthroughFingerprint(f.plan),
        authorizationId: "wire-authorization",
        sourcePairingId: f.session.session.pairingId,
        projectRoot: f.session.session.projectRoot,
        authorizedAt: f.plan.dispatchExpiresAt - 240000,
        dispatchExpiresAt: f.plan.dispatchExpiresAt,
        expiresAt: f.plan.expiresAt,
        exportPreparedWindows: true,
        instructions: true,
        control: false,
        nativeActivation: false,
        maxCalls: 1,
      });
      const program = String.raw`
import asyncio, copy, json, socket, sys, time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from task_voice import VoiceError
from task_voice_livekit import fingerprint, validate_binding
from task_presentation import validate_prepare, TaskPresentationRuntime
from task_walkthrough_livekit import validate_walkthrough_binding, WalkthroughTaskAPI, TaskWalkthroughLiveKit
from task_walkthrough_livekit_local import validate_export
wire=json.load(sys.stdin)
def no_connection(*args, **kwargs):
    raise AssertionError('wire_test_forbids_network')
socket.create_connection=no_connection
socket.socket.connect=no_connection
b=validate_walkthrough_binding(wire['binding'],time.time())
p=validate_prepare(wire['prepared'])
validate_export(wire['exportGrant'],b,p,time.time())
def refused(fn):
    try:
        fn()
    except VoiceError:
        return True
    raise AssertionError('invalid_wire_accepted')
refused(lambda:validate_binding(b,time.time()))
bad=copy.deepcopy(b);bad['control']=True
refused(lambda:validate_walkthrough_binding(bad,time.time()))
bad=copy.deepcopy(wire['exportGrant']);bad['exportPreparedWindows']=False
refused(lambda:validate_export(bad,b,p,time.time()))
refused(lambda:validate_export(p['grant'],b,p,time.time()))
calls=[]
async def request(suffix,body=None):
    calls.append({'suffix':suffix,'body':body})
    if suffix=='/context':return wire['context']
    if suffix=='/presentation/opening':return wire['opening']
    return {'ended':True}
api=SimpleNamespace(task_id=b['taskId'],voice_id=b['voiceSessionId'],request=request)
WalkthroughTaskAPI(api,b).validate_context(wire['context'])
async def exercise():
    cleanup={'captureStopped':True,'narrationStopped':True,'outputCleared':True,'childrenJoined':True}
    source=SimpleNamespace(close=AsyncMock())
    presentation=TaskPresentationRuntime(p,SimpleNamespace(check=AsyncMock(return_value={'sceneEvidenceCurrent':True})),
        source,SimpleNamespace(prepare=Mock()))
    presentation.armed=True
    presentation.local_start=AsyncMock()  # Wire/metadata only: never start a source or capture pixels.
    provider=SimpleNamespace(readiness=AsyncMock(),open=AsyncMock(),close=AsyncMock())
    port=SimpleNamespace(prepare=AsyncMock(return_value={'livekit_url':'wss://example.invalid','participant_token':'synthetic',
        'remote_participant_identity':b['agentIdentity']}),stop_video=AsyncMock(return_value=True),close=AsyncMock(return_value=True))
    owner=TaskWalkthroughLiveKit(api,provider,port,SimpleNamespace(reserve=Mock(),record=Mock(),owns=Mock(return_value=True)),b,presentation)
    async def idle():await asyncio.Event().wait()
    owner.export_video=idle;owner.video_watchdog=idle
    owner.fresh_video=AsyncMock(return_value=(wire['opening']['videoEvidence'],wire['opening']['videoEvidence']))
    try:
        result=await owner.prepare(b)
        provider.open.assert_not_awaited()
        assert result['videoPublisherReady'] is True
        assert result['bindingFingerprint']==wire['mediaFingerprint']
        events=[call for call in calls if call['suffix']=='/presentation/opening']
        assert events==[{'suffix':'/presentation/opening','body':{'eventId':wire['openingEventId']}}]
    finally:
        await owner.close()
    source.close.assert_awaited_once()
    snapshot=owner.status()['sharingDiagnostics']
    presentation.last_source_at=time.time()*1000
    assert owner.status()['sharingDiagnostics']['pipelineAtStop']==snapshot['pipelineAtStop']
    return {'prepared':result['sharingDiagnostics'],'closed':snapshot}
diagnostics=asyncio.run(exercise())
print(json.dumps({'valid':True,'mediaFingerprint':fingerprint(b),'openingEventId':wire['openingEventId'],'rejections':4,'providerOpened':False,'diagnostics':diagnostics}))
`;
      const result = spawnSync(
        resolve("media/.venv/bin/python"),
        ["-c", program],
        {
          cwd: resolve("media"),
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH, PYTHONPATH: resolve("media") },
          input: JSON.stringify({
            binding,
            prepared,
            exportGrant,
            context,
            opening,
            mediaFingerprint: taskHandsetMediaFingerprint(f.plan),
            openingEventId: `opening_${f.plan.id}`,
          }),
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const { diagnostics, ...wireResult } = JSON.parse(result.stdout);
      expect(wireResult).toEqual({
        valid: true,
        mediaFingerprint: taskHandsetMediaFingerprint(f.plan),
        openingEventId: `opening_${f.plan.id}`,
        rejections: 4,
        providerOpened: false,
      });
      expect(
        taskWalkthroughSharingDiagnosticsSchema.parse(diagnostics.prepared),
      ).toEqual({
        firstStop: null,
        sourceFrames: 0,
        renderedFrames: 0,
        presentationFailure: null,
        pipelineAtStop: null,
      });
      const closedDiagnostics = taskWalkthroughSharingDiagnosticsSchema.parse(
        diagnostics.closed,
      );
      expect(closedDiagnostics).toEqual({
        firstStop: {
          reason: "call_closed",
          mediaState: "prepared",
          elapsedMs: expect.any(Number),
          lastFrameAgeMs: null,
        },
        sourceFrames: 0,
        renderedFrames: 0,
        presentationFailure: null,
        pipelineAtStop: {
          trigger: "call_closed",
          capturePhase: "idle",
          capturePhaseMs: expect.any(Number),
          sourceAgeMs: null,
          renderAgeMs: null,
          lastRenderMs: null,
          exportPhase: "idle",
          exportPhaseMs: expect.any(Number),
          candidateAgeMs: null,
          sdkPhase: null,
          sdkPhaseMs: null,
          lastSdkCaptureMs: null,
          lastDecodeMs: null,
        },
      });
    },
    20000,
  );
  it("scopes the operator router to one voice and read-only presentation authority", async () => {
    const f = await fixture(),
      before = f.get();
    const denied: [string, string][] = [
      ["POST", "/tasks"],
      ["POST", "/sessions"],
      ["POST", `/tasks/${f.plan.taskId}/run`],
      ["POST", `/tasks/${f.plan.taskId}/commands`],
      ["GET", `/tasks/${f.plan.taskId}`],
      ["POST", `/tasks/${f.plan.taskId}/voice-sessions`],
      ["GET", `/tasks/other/voice/${f.opened.voice.id}/context`],
      ["GET", `/tasks/${f.plan.taskId}/voice/other/context`],
      ["POST", `/tasks/${f.plan.taskId}/presentations`],
      ["POST", `/tasks/${f.plan.taskId}/presentations/${f.manifest.id}/scenes`],
      ["GET", `/tasks/${f.plan.taskId}/presentations/other/authority`],
      ["POST", `/tasks/${f.plan.taskId}/voice/${f.opened.voice.id}/context`],
    ];
    for (const [method, path] of denied) {
      const result = await f.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${f.session.token}`,
          "content-type": "application/json",
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(result.status, path).toBe(403);
    }
    expect((await f.app.request("/health")).status).toBe(200);
    expect(
      (
        await f.app.request(
          `/tasks/${f.plan.taskId}/presentations/${f.manifest.id}/authority`,
          {
            headers: { authorization: `Bearer ${f.session.token}` },
          },
        )
      ).status,
    ).toBe(200);
    expect((await f.api("/context")).status).toBe(200);
    expect(f.get()).toEqual(before);
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(f.engine.cancel).not.toHaveBeenCalled();
  });
  it("opens only the exact first scene during preparation and rejects task credential substitution", async () => {
    const f = await fixture();
    expect(
      (await f.api("/presentation/opening", { eventId: "wrong" })).status,
    ).toBe(403);
    expect(
      (
        await f.api(
          "/presentation/opening",
          { eventId: "opening_call" },
          f.session.token,
        )
      ).status,
    ).toBe(403);
    expect((await f.opening()).status).toBe(200);
    expect(f.host.show).toHaveBeenCalledTimes(1);
    expect(f.host.show.mock.calls[0]![0].sceneId).toBe("code");
    expect((await f.opening()).status).toBe(200);
    expect(f.host.show).toHaveBeenCalledTimes(1);
    f.connect();
    expect((await f.opening()).status).toBeGreaterThanOrEqual(400);
  });
  it("requires a finalized same-provider source, exact scene and connected call before show", async () => {
    const f = await fixture();
    await f.bind();
    expect((await f.show()).status).toBe(409);
    expect(
      (
        await f.utterance("speech", "Show the preview.", {
          providerConversationId: "other",
        })
      ).status,
    ).toBe(403);
    expect((await f.utterance("speech")).status).toBe(200);
    expect((await f.show()).status).toBe(403);
    f.connect();
    expect((await f.show("wrong-scene", "speech", "unprepared")).status).toBe(
      403,
    );
    expect((await f.show()).status).toBe(200);
    expect(f.host.show).toHaveBeenCalledTimes(1);
  });
  it("deduplicates durable request IDs while refusing changed scene or utterance", async () => {
    const f = await fixture();
    await f.bind();
    await f.utterance("speech");
    await f.utterance("other");
    f.connect();
    const first = await f.show();
    expect(first.status).toBe(200);
    expect((await f.show()).status).toBe(200);
    expect(f.host.show).toHaveBeenCalledTimes(1);
    expect(f.host.observe).toHaveBeenCalledTimes(2);
    expect((await f.show("show", "other")).status).toBe(409);
    expect((await f.show("show", "speech", "code")).status).toBe(409);
    expect(f.host.show).toHaveBeenCalledTimes(1);
  });
  it.each(["stale", "target", "operation", "fingerprint", "future"])(
    "rejects current frame %s even after show receipt completed",
    async (kind) => {
      const f = await fixture();
      await f.bind();
      await f.utterance("speech");
      f.connect();
      if (kind === "stale") f.observation({ capturedAt: Date.now() - 5000 });
      if (kind === "target")
        f.observation({
          target: { ...f.manifest.scenes[0]!.target, windowId: "99" },
        });
      if (kind === "operation") f.observation({ operationId: "other" });
      if (kind === "fingerprint")
        f.observation({ manifestFingerprint: hash("other") });
      if (kind === "future")
        f.observation({
          capturedAt: Date.now() + 5000,
          renderedAt: Date.now() + 5000,
        });
      expect((await f.show()).status).toBeGreaterThanOrEqual(400);
      expect(f.host.narrate).not.toHaveBeenCalled();
      expect(f.host.show).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "sourceFrameId",
    "geometryGeneration",
    "generation",
    "manifestFingerprint",
    "acceptedAt",
  ])("requires exact fresh SDK %s evidence", async (field) => {
    const f = await fixture();
    await f.bind();
    await f.utterance("speech");
    f.connect();
    f.evidence({
      [field]:
        field === "acceptedAt"
          ? Date.now() - 5000
          : field === "generation"
            ? 99
            : field === "manifestFingerprint"
              ? hash("other")
              : "other",
    });
    expect((await f.show()).status).toBeGreaterThanOrEqual(400);
    expect(f.host.narrate).not.toHaveBeenCalled();
  });
  it("new coding work invalidates sharing while voice/status remains active", async () => {
    const f = await fixture();
    await f.opening();
    await f.bind();
    f.connect();
    await f.utterance("change", "Change the empty state.");
    expect(
      (
        await f.api("/instructions", {
          eventId: "instruction",
          utteranceId: "change",
        })
      ).status,
    ).toBe(200);
    await f.presentation.reconcile();
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    const context = await (await f.api("/context")).json();
    expect(context.active).toBe(true);
    expect(context.sharingActive).toBe(false);
    expect(context.state).toBe("queued");
    expect(
      f.voiceLedger.get(f.session.session.id, f.opened.voice.id).endedAt,
    ).toBeUndefined();
    expect(f.engine.start).toHaveBeenCalledTimes(1);
    expect(
      (await f.show("stale-show", "change")).status,
    ).toBeGreaterThanOrEqual(400);
  });
  it("call continuity never substitutes a stale artifact for the strictly prepared initial opening", async () => {
    const f = await fixture({ continuity: true, artifact: true });
    writeFileSync(f.artifactPath, "changed after prepare before opening");
    expect((await f.opening()).status).toBeGreaterThanOrEqual(400);
    expect(f.host.show).not.toHaveBeenCalled();
    expect(f.evidenceFor).not.toHaveBeenCalled();
  });
  it("call continuity never starts a second local narrator or stops sharing when narration is refused", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    f.connect();
    const record = f.presentation.status(
      f.session.token,
      f.plan.taskId,
      f.manifest.id,
    );
    await expect(
      f.presentation.narrate(f.session.token, f.plan.taskId, f.manifest.id, {
        eventId: "second-narrator",
        expectedGeneration: record.generation,
        sceneId: "code",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.host.narrate).not.toHaveBeenCalled();
    expect(f.host.stop).not.toHaveBeenCalled();
    expect(
      f.presentation.status(f.session.token, f.plan.taskId, f.manifest.id),
    ).toEqual(record);
    expect((await (await f.api("/context")).json()).sharingActive).toBe(true);
  });
  it("call continuity keeps authorized scenes visible during a new run without replaying prepared-result narration", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    await f.bind();
    f.connect();
    expect((await (await f.api("/context")).json()).sceneEvidenceCurrent).toBe(
      true,
    );
    await f.utterance("revise", "Change the empty state.");
    expect(
      (
        await f.api("/instructions", {
          eventId: "revise",
          utteranceId: "revise",
        })
      ).status,
    ).toBe(200);
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    await f.presentation.reconcile();
    const context = await (await f.api("/context")).json();
    expect(context).toMatchObject({
      state: "running",
      active: true,
      exportActive: true,
      sharingActive: true,
      sceneEvidenceCurrent: false,
    });
    expect(f.host.stop).not.toHaveBeenCalled();
    await f.utterance("switch", "Show the preview.");
    const shown = await f.show("switch", "switch", "preview");
    expect(shown.status).toBe(200);
    const result = await shown.json();
    expect(result).toMatchObject({
      sceneId: "preview",
      sceneEvidenceCurrent: false,
    });
    expect(result.narration).not.toBe(f.manifest.scenes[1]!.narration);
    expect(result.expectedOutcome).not.toBe(
      f.manifest.scenes[1]!.expectedOutcome,
    );
    expect(f.host.show).toHaveBeenCalledTimes(2);
    expect((await f.show("switch", "switch", "preview")).status).toBe(200);
    expect(f.host.show).toHaveBeenCalledTimes(2);
    expect(
      (await f.show("switch", "switch", "code")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await f.show("foreign", "switch", "unprepared-window")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.host.show).toHaveBeenCalledTimes(2);
    expect(f.host.narrate).not.toHaveBeenCalled();
    expect(f.engine.start).toHaveBeenCalledTimes(1);
  });
  it("acceptance preserves opted-in sharing and exact run history until explicit sharing Stop", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    await f.bind();
    f.connect();
    const runs = f.get().runs;
    await f.utterance("accept", "I accept the result.");
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "accept" }))
        .status,
    ).toBe(200);
    await f.presentation.reconcile();
    expect(f.get().state).toBe("accepted");
    expect(f.get().runs).toEqual(runs);
    expect(await (await f.api("/context")).json()).toMatchObject({
      active: true,
      exportActive: true,
      sharingActive: true,
    });
    expect(f.host.stop).not.toHaveBeenCalled();
    expect(f.engine.start).not.toHaveBeenCalled();
    await f.utterance("switch", "Show the code.");
    expect((await f.show("switch", "switch", "code")).status).toBe(200);
    await f.utterance("stop", "Stop sharing.");
    expect(
      (
        await f.api("/presentation/stop", {
          eventId: "stop",
          utteranceId: "stop",
        })
      ).status,
    ).toBe(200);
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(await (await f.api("/context")).json()).toMatchObject({
      active: true,
      exportActive: false,
      sharingActive: false,
    });
    expect(
      (await f.show("after-stop", "stop", "preview")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.get().state).toBe("accepted");
  });
  it("changed artifact invalidates claims but preserves only the original authorized target", async () => {
    const f = await fixture({ continuity: true, artifact: true });
    await f.opening();
    await f.bind();
    f.connect();
    writeFileSync(f.artifactPath, "changed source during coding");
    await f.presentation.reconcile();
    expect(await (await f.api("/context")).json()).toMatchObject({
      exportActive: true,
      sharingActive: true,
      sceneEvidenceCurrent: false,
    });
    expect(f.host.stop).not.toHaveBeenCalled();
    await f.utterance("switch", "Show the code.");
    const shown = await f.show("switch", "switch", "code");
    expect(shown.status).toBe(200);
    expect((await shown.json()).sceneEvidenceCurrent).toBe(false);
    expect(f.host.show.mock.calls.at(-1)![0].sceneId).toBe("code");
    writeFileSync(f.artifactPath, "prepared source");
    expect((await (await f.api("/context")).json()).sceneEvidenceCurrent).toBe(
      false,
    );
  });
  it("continuous sharing cannot accept a newer result under the original review call", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    await f.bind();
    f.connect();
    await f.utterance("revise", "Change the empty state.");
    await f.api("/instructions", { eventId: "revise", utteranceId: "revise" });
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    f.terminal();
    await f.presentation.reconcile();
    expect((await (await f.api("/context")).json()).sharingActive).toBe(true);
    await f.utterance("switch", "Show the preview.");
    expect((await f.show("switch", "switch", "preview")).status).toBe(200);
    await f.utterance("accept", "I accept the result.");
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "accept" }))
        .status,
    ).toBe(403);
    expect(f.get().state).toBe("review_ready");
    expect(f.get().runs).toHaveLength(2);
    expect(f.engine.start).toHaveBeenCalledTimes(1);
  });
  it("call continuity still refuses stale observed frames during revised-task scene switching", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    await f.bind();
    f.connect();
    await f.utterance("revise", "Change the empty state.");
    await f.api("/instructions", { eventId: "revise", utteranceId: "revise" });
    await f.utterance("switch", "Show the preview.");
    f.observation({ capturedAt: Date.now() - 5000 });
    expect(
      (await f.show("switch", "switch", "preview")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.host.narrate).not.toHaveBeenCalled();
  });
  it("an explicit Stop during a continuous scene observation fences late frame publication", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    await f.bind();
    f.connect();
    await f.utterance("switch", "Show the preview.");
    const observe = f.host.observe.getMockImplementation()!;
    f.host.observe.mockImplementationOnce(async () => {
      const frame = await observe();
      await f.presentation.stop(f.session.token, f.plan.taskId, f.manifest.id, {
        eventId: "local-stop-during-frame",
      });
      return frame;
    });
    expect(
      (await f.show("switch", "switch", "preview")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(f.evidenceFor).toHaveBeenCalledTimes(1); // Opening only; late frame never reaches SDK proof.
    expect(await (await f.api("/context")).json()).toMatchObject({
      active: true,
      exportActive: false,
      sharingActive: false,
    });
    expect(f.host.narrate).not.toHaveBeenCalled();
  });
  it("continuous capture retires when the exact call receipt requests Stop", async () => {
    const f = await fixture({ continuity: true });
    await f.opening();
    await f.bind();
    f.connect();
    const record = f.records.get(f.plan.id)!;
    record.stopRequested = true;
    f.records.put(record);
    await f.presentation.reconcile();
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(await (await f.api("/context")).json()).toMatchObject({
      exportActive: false,
      sharingActive: false,
    });
    await f.utterance("switch", "Show the preview.");
    expect(
      (await f.show("switch", "switch", "preview")).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.host.show).toHaveBeenCalledTimes(1);
    expect(f.engine.start).not.toHaveBeenCalled();
  });
  it("local Stop sharing is separate from voice end and task cancellation", async () => {
    const f = await fixture();
    await f.opening();
    await f.bind();
    f.connect();
    await f.utterance("stop", "Stop sharing.");
    const before = f.get();
    const stopped = await f.api("/presentation/stop", {
      eventId: "stop",
      utteranceId: "stop",
    });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({
      sharingStopped: true,
      voiceEnded: false,
      taskCanceled: false,
    });
    expect(f.get()).toEqual(before);
    expect((await (await f.api("/context")).json()).active).toBe(true);
    expect(
      (
        await f.api("/presentation/stop", {
          eventId: "stop",
          utteranceId: "stop",
        })
      ).status,
    ).toBe(200);
    expect(f.host.stop).toHaveBeenCalledTimes(1);
  });
  it.each([
    "I do not accept the result.",
    "Looks good, but change the title.",
    "Maybe accept the result",
    "Do you think it looks good?",
    " ",
  ])("never treats negation/ambiguity as acceptance: %s", async (text) => {
    const f = await fixture();
    await f.bind();
    f.connect();
    await f.utterance("accept", text);
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "accept" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.get().state).toBe("review_ready");
  });
  it("accepts only stored explicit speech and deduplicates acceptance", async () => {
    const f = await fixture();
    await f.bind();
    f.connect();
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "missing" }))
        .status,
    ).toBe(409);
    await f.utterance("accept", "I accept the result.");
    expect(
      (
        await f.api("/accept", {
          eventId: "accept",
          utteranceId: "accept",
          text: "I accept the result",
        })
      ).status,
    ).toBe(400);
    const first = await f.api("/accept", {
      eventId: "accept",
      utteranceId: "accept",
    });
    expect(first.status).toBe(200);
    expect((await first.json()).replayed).toBe(false);
    const revision = f.get().revision;
    expect(f.get().state).toBe("accepted");
    const replay = await f.api("/accept", {
      eventId: "accept",
      utteranceId: "accept",
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    expect(f.get().revision).toBe(revision);
    expect(f.engine.start).not.toHaveBeenCalled();
    expect(
      (
        await f.api("/instructions", {
          eventId: "instruction",
          utteranceId: "accept",
        })
      ).status,
    ).toBe(409);
  });
  it("a speech receipt used for a coding instruction cannot also accept", async () => {
    const f = await fixture();
    await f.bind();
    f.connect();
    await f.utterance("same", "I accept the result.");
    expect(
      (
        await f.api("/instructions", {
          eventId: "instruction",
          utteranceId: "same",
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "same" }))
        .status,
    ).toBe(409);
    expect(f.get().runs).toHaveLength(2);
  });
  it("a decision call cannot accept even a currently passed result", async () => {
    const f = await fixture();
    await f.bind();
    f.connect();
    const record = f.records.get(f.plan.id)!;
    record.plan.callKind = "decision";
    record.fingerprint = taskWalkthroughFingerprint(record.plan);
    f.records.put(record);
    await f.utterance("accept", "I accept the result.");
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "accept" }))
        .status,
    ).toBe(403);
    expect(f.get().state).toBe("review_ready");
  });
  it("a later completed run requires its own prepared review call", async () => {
    const f = await fixture();
    await f.bind();
    f.connect();
    await f.utterance("revise", "Change the empty state.");
    await f.api("/instructions", { eventId: "revise", utteranceId: "revise" });
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    f.terminal();
    await f.utterance("accept", "I accept the result.");
    expect(
      (await f.api("/accept", { eventId: "accept", utteranceId: "accept" }))
        .status,
    ).toBe(403);
    expect(f.get().state).toBe("review_ready");
  });
  it("acceptance spoken while work is running cannot be reused when it becomes ready", async () => {
    const f = await fixture();
    await f.bind();
    f.connect();
    await f.utterance("revise", "Change the empty state.");
    await f.api("/instructions", { eventId: "revise", utteranceId: "revise" });
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    await f.utterance("premature", "I accept the result.");
    expect(
      (
        await f.api("/accept", {
          eventId: "premature",
          utteranceId: "premature",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    f.terminal();
    expect(
      (
        await f.api("/accept", {
          eventId: "premature",
          utteranceId: "premature",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.get().state).toBe("review_ready");
  });
  it("holds one finalized correction and releases it after verified completion even after voice end", async () => {
    const f = await fixture();
    await f.bind();
    f.connect();
    await f.utterance("revise", "Change the empty state.");
    await f.api("/instructions", { eventId: "revise", utteranceId: "revise" });
    f.transition({ action: "claim_run", runId: f.get().runs.at(-1)!.id });
    await f.utterance("correction", "Use plural tasks in the empty state.");
    const held = await f.api("/instructions", {
      eventId: "correction",
      utteranceId: "correction",
    });
    expect((await held.json()).state).toBe("held");
    await f.api("/end", { eventId: "end" });
    f.terminal();
    const settled = f.engine.onSettled.mock.calls[0]![0] as (
      id: string,
    ) => void;
    settled(f.plan.taskId);
    settled(f.plan.taskId);
    expect(f.get().runs).toHaveLength(3);
    expect(f.engine.start).toHaveBeenCalledTimes(2);
    expect(f.voiceLedger.heldForTask(f.plan.taskId)).toHaveLength(0);
  });
  it("rechecks preparation after a frame await before releasing opening narration", async () => {
    const f = await fixture();
    const observe = f.host.observe.getMockImplementation()!;
    f.host.observe.mockImplementation(async () => {
      const frame = await observe();
      f.setPreparing(false);
      return frame;
    });
    expect((await f.opening()).status).toBeGreaterThanOrEqual(400);
    expect(f.host.narrate).not.toHaveBeenCalled();
  });
});
