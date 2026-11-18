import { serve } from "@hono/node-server";
import { createTaskAudioStopApp } from "../src/control/task-audio-stop.js";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { TaskAudioInspectorClient } from "../cli/task-audio-inspector-client.js";
import {
  readFileSync,
  writeFileSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  resolve,
  join,
  relative,
  isAbsolute,
  sep,
  basename,
  dirname,
} from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "../src/storage/store.js";
import { Vault, hash, token } from "../src/storage/security.js";
import { TaskLedger } from "../src/attention/task-ledger.js";
import { TaskService } from "../src/control/task-service.js";
import { TaskVoiceLedger } from "../src/attention/task-voice-ledger.js";
import { TaskVoiceService } from "../src/control/task-voice-service.js";
import { createTaskApp } from "../src/control/task-app.js";
import { TaskDesktopService } from "../src/control/task-desktop-service.js";
import { prepareHandsetDesktop } from "../src/control/task-desktop-config.js";
import {
  TaskAudioCallCoordinator,
  hasConnectedTaskWalkthroughCall,
} from "../src/attention/task-audio-call.js";
import { TaskAudioMonitor } from "../src/control/task-audio-monitor.js";
import { TaskAudioAuthority } from "../cli/task-audio-authority.js";
import { TaskWalkthroughAuthority } from "../cli/task-walkthrough-authority.js";
import { TaskEngine } from "../src/control/task-engine.js";
import { CodexTaskWorker } from "../connectors/codex/task-worker.js";
import type { VerificationPlan } from "../src/control/task-verification.js";
import { TaskPresentationLedger } from "../src/attention/task-presentation-ledger.js";
import { TaskPresentationService } from "../src/control/task-presentation-service.js";
import { TaskWalkthroughPresentation } from "../src/control/task-walkthrough-presentation.js";
import { HTTPTaskWalkthroughPresentationHost } from "../src/transport/task-presentation.js";
import {
  taskPresentationManifestSchema,
  taskPresentationGrantSchema,
  taskPresentationFingerprint,
} from "../src/task-presentation-contracts.js";
import {
  taskWalkthroughPlanSchema,
  taskWalkthroughAuthorizationSchema,
  taskWalkthroughExportGrantSchema,
  isTaskWalkthroughPlan,
  type TaskHandsetPlan,
  type TaskHandsetAuthorization,
} from "../src/task-walkthrough-contracts.js";
import {
  NativeTaskAudioCalls,
  HttpTaskHandsetMediaPort,
  taskHandsetFingerprint,
  taskHandsetMediaBinding,
  taskAudioPlanSchema,
  type TaskAudioReadiness,
} from "../src/transport/task-audio.js";

function privateJSON(path: string) {
  const s = lstatSync(path),
    parent = lstatSync(resolve(path, ".."));
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    s.mode & 0o077 ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077
  )
    throw Error("Owner-only configuration files and directory required.");
  return JSON.parse(readFileSync(path, "utf8"));
}
const text = z.string().min(1);
const configSchema = z
  .object({
    mode: z
      .enum(["handset_audio_smoke", "handset_walkthrough"])
      .default("handset_audio_smoke"),
    walkthrough: z
      .object({
        presentationFile: text,
        helperBinary: text,
        checksFile: text,
        callDurationMs: z.number().int().min(30_000).max(1_800_000),
        userAuthorizedPreparedWindowExport: z.literal(true),
        userAuthorizedTaskInstructions: z.literal(true),
      })
      .strict()
      .optional(),
    stateDirectory: text,
    desktopPanel: z.boolean().default(false),
    sessionFile: text,
    taskId: text,
    projectRoot: text,
    attemptDirectory: text,
    providerFile: text,
    livekitFile: text,
    inspectorBundle: text,
    python: text,
    native: z
      .object({
        callsOrigin: text,
        projectId: text,
        projectKey: text,
        recipient: text,
        lineId: z.string().uuid(),
      })
      .strict(),
    destination: z
      .object({
        pairingId: text,
        memberId: text,
        deviceId: text,
        lineId: z.string().uuid(),
        recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    railway: z
      .object({
        binary: text,
        projectId: z.string().uuid(),
        environmentId: z.string().uuid(),
        backendServiceId: z.string().uuid(),
        deploymentId: z.string().uuid(),
        restoreRecord: text,
      })
      .strict(),
    authorization: z
      .object({ id: text, userAuthorizedOneCall: z.literal(true) })
      .strict(),
  })
  .strict()
  .refine(
    (c) => (c.mode === "handset_walkthrough") === !!c.walkthrough,
    "Walkthrough mode requires separate explicit export and instruction authorization.",
  );
const setupCleanups: Array<() => void | Promise<void>> = [];
let setupCleanupFailed = false;
async function main() {
  const c = configSchema.parse(privateJSON(process.argv[2]!));
  if (c.walkthrough) {
    const project = realpathSync(c.projectRoot);
    const protectedPaths = [
      process.argv[2]!,
      c.stateDirectory,
      c.sessionFile,
      c.providerFile,
      c.livekitFile,
      c.walkthrough.presentationFile,
      c.walkthrough.checksFile,
    ];
    for (const path of protectedPaths) {
      const part = relative(project, realpathSync(path));
      if (
        part === "" ||
        (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part))
      )
        throw Error(
          "Walkthrough credentials and operator configuration must be outside the worker project.",
        );
    }
    const attempt = join(
      realpathSync(dirname(c.attemptDirectory)),
      basename(c.attemptDirectory),
    );
    const part = relative(project, attempt);
    if (
      part === "" ||
      (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part))
    )
      throw Error(
        "Walkthrough attempt state must be outside the worker project.",
      );
  }
  if (
    c.native.lineId !== c.destination.lineId ||
    hash(c.native.recipient) !== c.destination.recipientHash
  )
    throw Error(
      "Destination does not match protected native call configuration.",
    );
  mkdirSync(c.attemptDirectory, { mode: 0o700 }); // Exclusive new attempt; never reuse another directory.
  const put = (name: string, value: unknown) =>
    writeFileSync(join(c.attemptDirectory, name), JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
  const lockPath = join(c.stateDirectory, "owner.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  setupCleanups.push(() => {
    if (!setupCleanupFailed) {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  });
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const saved = privateJSON(join(c.stateDirectory, "local-config.json"));
  if (saved.projectRoot !== c.projectRoot) throw Error("Task project differs.");
  const capability = privateJSON(c.sessionFile);
  const store = new Store(join(c.stateDirectory, "tasks.sqlite"));
  setupCleanups.push(() => store.close());
  const vault = new Vault(saved.key),
    ledger = new TaskLedger(store, vault);
  const tasks = new TaskService(store, vault, ledger, {
    projectRoots: [c.projectRoot],
    simulation: false,
  });
  const voices = new TaskVoiceLedger(store, vault, ledger);
  const prepared = c.walkthrough
    ? z
        .object({
          manifest: taskPresentationManifestSchema,
          grant: taskPresentationGrantSchema,
        })
        .strict()
        .parse(privateJSON(c.walkthrough.presentationFile))
    : undefined;
  const engine = c.walkthrough
    ? new TaskEngine(
        tasks,
        new CodexTaskWorker({ enabled: true, projectRoots: [c.projectRoot] }),
        privateJSON(c.walkthrough.checksFile) as VerificationPlan,
      )
    : undefined;
  let presenter: TaskWalkthroughPresentation | undefined;
  let presentation: TaskPresentationService | undefined;
  const voiceService = new TaskVoiceService(
    tasks,
    voices,
    engine,
    () => presenter,
  );
  const session = tasks.authenticate(capability.token),
    task = ledger.get(session.id, c.taskId);
  const attemptId = `handset_${randomUUID()}`;
  const exportGrantId = `export_${randomUUID()}`;
  const admission = {
    eventId: attemptId,
    runId: task.runs.at(-1)!.id,
    expectedRevision: task.revision,
  };
  const admitted = prepared
    ? voiceService.openWalkthrough(capability.token, task.id, admission, {
        mode: "handset_walkthrough",
        callAttemptId: attemptId,
        exportGrantId,
        presentationId: prepared.manifest.id,
        manifestFingerprint: taskPresentationFingerprint(prepared.manifest),
      })
    : voiceService.openHandset(
        capability.token,
        task.id,
        {
          eventId: attemptId,
          runId: task.runs.at(-1)!.id,
          expectedRevision: task.revision,
        },
        attemptId,
      );
  setupCleanups.push(() => {
    voices.end(admitted.voice.id, `${attemptId}_setup_failed`);
  });
  const now = Date.now(),
    expiresAt = Math.min(
      now + (c.walkthrough?.callDurationMs ?? 300_000),
      session.expiresAt,
    ),
    dispatchExpiresAt = Math.min(now + 300_000, expiresAt);
  const permissions = {
    audio: true,
    video: false,
    screen: false,
    presentation: false,
    control: false,
    maxCalls: 1,
  } as const;
  const identityPlan = {
    id: attemptId,
    taskSessionId: session.id,
    taskId: task.id,
    runId: task.runs.at(-1)!.id,
    revision: task.revision,
    voiceSessionId: admitted.voice.id,
    ...c.destination,
    mediaSessionId: `media_${randomUUID()}`,
    workerIdentity: `worker_${randomUUID()}`,
    agentIdentity: `agent_${randomUUID()}`,
    expiresAt,
  };
  const plan: TaskHandsetPlan = prepared
    ? taskWalkthroughPlanSchema.parse({
        ...identityPlan,
        version: 1,
        mode: "handset_walkthrough",
        exportGrantId,
        callKind: prepared.manifest.kind,
        dispatchExpiresAt,
        presentationBinding: {
          presentationId: prepared.manifest.id,
          manifestFingerprint: taskPresentationFingerprint(prepared.manifest),
          presentationGrantId: prepared.grant.id,
          verificationId: prepared.manifest.verificationId,
          hostId: session.hostId,
          captureDeviceId: c.destination.deviceId,
        },
        audio: true,
        video: true,
        screen: true,
        presentation: true,
        instructions: true,
        control: false,
        nativeActivation: false,
        maxCalls: 1,
      })
    : taskAudioPlanSchema.parse({
        ...identityPlan,
        ...permissions,
      });
  const authorization: TaskHandsetAuthorization = {
    id: c.authorization.id,
    planFingerprint: taskHandsetFingerprint(plan),
    authorizedAt: now,
    expiresAt: dispatchExpiresAt,
    ...(isTaskWalkthroughPlan(plan) ? { callExpiresAt: expiresAt } : {}),
    oneCallAuthorized: true,
  } as const;
  const grant = isTaskWalkthroughPlan(plan)
    ? taskWalkthroughExportGrantSchema.parse({
        version: 1,
        mode: "handset_walkthrough",
        id: exportGrantId,
        planFingerprint: authorization.planFingerprint,
        authorizationId: authorization.id,
        sourcePairingId: session.pairingId,
        projectRoot: c.projectRoot,
        authorizedAt: now,
        dispatchExpiresAt,
        expiresAt,
        exportPreparedWindows: true,
        instructions: true,
        control: false,
        nativeActivation: false,
        maxCalls: 1,
      })
    : {
        taskSessionId: session.id,
        taskId: task.id,
        runId: plan.runId,
        revision: task.revision,
        sourcePairingId: session.pairingId,
        projectRoot: c.projectRoot,
        ...c.destination,
        planFingerprint: authorization.planFingerprint,
        authId: authorization.id,
        expiresAt,
        ...permissions,
      };
  put("plan.json", plan);
  put("authorization.json", authorization);
  put("grant.json", grant);
  put("binding.json", taskHandsetMediaBinding(plan));
  put("voice.json", {
    version: 1,
    taskOrigin: "http://127.0.0.1:13323",
    taskId: task.id,
    voiceSessionId: admitted.voice.id,
    voiceToken: admitted.token,
  });
  const controlToken = token();
  put("control.json", { token: controlToken });
  if (prepared)
    put("presentation.json", {
      prepare: {
        presentationId: prepared.manifest.id,
        manifest: prepared.manifest,
        grant: prepared.grant,
        fingerprint: taskPresentationFingerprint(prepared.manifest),
      },
      taskOrigin: "http://127.0.0.1:13323",
      taskToken: capability.token,
      helperBinary: c.walkthrough!.helperBinary,
      exportGrant: grant,
    });
  const authority = !isTaskWalkthroughPlan(plan)
    ? new TaskAudioAuthority(
        tasks,
        voices,
        grant as ConstructorParameters<typeof TaskAudioAuthority>[2],
      )
    : undefined;
  const walkthroughAuthority = isTaskWalkthroughPlan(plan)
    ? new TaskWalkthroughAuthority(
        tasks,
        voices,
        {
          ...prepared!,
          exportGrant: taskWalkthroughExportGrantSchema.parse(grant),
        },
        Date.now,
        (p) => hasConnectedTaskWalkthroughCall(store, vault, p),
      )
    : undefined;
  const assertInitial = () =>
    isTaskWalkthroughPlan(plan)
      ? walkthroughAuthority!.assertInitial(
          plan,
          taskWalkthroughAuthorizationSchema.parse(authorization),
        )
      : authority!.assert(plan, authorization);
  const media = new HttpTaskHandsetMediaPort({
    origin: "http://127.0.0.1:3322",
    token: controlToken,
  });
  const calls = new NativeTaskAudioCalls(c.native);
  const inspector = readFileSync(c.inspectorBundle, "utf8");
  let auditCount = 0;
  function audit(operation: string, outcome: string, durationMs?: number) {
    if (auditCount >= 96) return;
    try {
      writeFileSync(
        join(c.attemptDirectory, "operator-events.jsonl"),
        JSON.stringify({
          at: Date.now(),
          operation,
          outcome,
          ...(durationMs === undefined ? {} : { durationMs }),
        }) + "\n",
        { mode: 0o600, flag: auditCount++ === 0 ? "wx" : "a" },
      );
    } catch {
      auditCount = 96;
      console.log(JSON.stringify({ event: "diagnostic_write_unavailable" }));
    }
  }
  const inspectorClient = new TaskAudioInspectorClient({
    command: c.railway.binary,
    args: [
      "ssh",
      "-p",
      c.railway.projectId,
      "-s",
      c.railway.backendServiceId,
      "-e",
      c.railway.environmentId,
      "--",
      "node",
      "--input-type=module",
      "-e",
      inspector,
      "rpc",
    ],
    timeoutMs: 2000,
    startupTimeoutMs: 15000,
    maxPending: 2,
  });
  setupCleanups.push(() => inspectorClient.close());
  await inspectorClient.start();
  audit("inspector_start", "ready");
  const remote = async (authorityOnly = false) => {
    const started = Date.now(),
      operation = authorityOnly ? "authority" : "readiness";
    audit(operation, "started");
    try {
      const value = await inspectorClient.request({
        plan,
        authorization,
        deploymentId: c.railway.deploymentId,
        restoreRecord: c.railway.restoreRecord,
        authorityOnly,
      });
      audit(operation, "passed", Date.now() - started);
      return value as any;
    } catch {
      audit(operation, "refused_or_unavailable", Date.now() - started);
      throw Error("Read-only inspector proof unavailable.");
    }
  };
  const readiness = async () => {
    const result = (await remote()) as TaskAudioReadiness;
    if (Date.now() - result.checkedAt > 10_000)
      throw Error("Native evidence expired in transit.");
    if (presentation) {
      assertInitial();
      presentation.authority(capability.token, task.id, prepared!.manifest.id);
      // Prepared provenance only: actual target inspection and SDK frame acceptance
      // must separately complete in media_prepare before native dial admission.
      return { ...result, presentationReady: true };
    }
    return result;
  };
  const destinationProof = (value: unknown) => {
    const proof = z
      .object({
        authorized: z.literal(true),
        planFingerprint: z.literal(authorization.planFingerprint),
        checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(value);
    if (
      proof.checkedAt > Date.now() + 1000 ||
      Date.now() - proof.checkedAt > 10_000
    )
      throw Error("Fresh destination authority required.");
    return proof;
  };
  const coordinator = new TaskAudioCallCoordinator(
    store,
    vault,
    {
      authorize: async () => {
        assertInitial();
        destinationProof(await remote(true));
        assertInitial();
      },
      readiness,
      media,
      calls,
    },
    { dispatchEnabled: true, environment: "native" },
  );
  if (isTaskWalkthroughPlan(plan)) {
    const videoHost = new HTTPTaskWalkthroughPresentationHost({
      origin: "http://127.0.0.1:3322",
      token: controlToken,
      plan,
    });
    presentation = new TaskPresentationService(
      tasks,
      new TaskPresentationLedger(store, vault, ledger),
      videoHost,
      prepared!,
    );
    presenter = new TaskWalkthroughPresentation(
      presentation,
      plan,
      prepared!.manifest,
      capability.token,
      (frame) => videoHost.evidenceFor(frame),
      {
        initial: assertInitial,
        ongoing: () =>
          walkthroughAuthority!.assertOngoing(
            plan,
            taskWalkthroughAuthorizationSchema.parse(authorization),
          ),
        preparing: () => {
          const s = coordinator.status(plan.id);
          return (
            s.fingerprint === authorization.planFingerprint &&
            s.state === "preparing" &&
            s.receipts.media_prepare?.state === "running" &&
            !s.stopRequested
          );
        },
      },
    );
  }
  const monitor = new TaskAudioMonitor(
    coordinator,
    calls,
    plan,
    () => {
      const v = voices.get(session.id, admitted.voice.id);
      if (v.endedAt !== undefined || v.expiresAt <= Date.now()) return false;
      if (isTaskWalkthroughPlan(plan)) {
        try {
          const state = coordinator.status(plan.id).state;
          if (state === "connected")
            walkthroughAuthority!.assertOngoing(
              plan,
              taskWalkthroughAuthorizationSchema.parse(authorization),
            );
          else assertInitial();
        } catch {
          return false;
        }
      }
      return true;
    },
    Date.now,
    (reason) => audit("stop", reason),
  );
  let reserved = false,
    starting = false,
    ended = false,
    ready = false,
    lastState = "initializing",
    stopRequested = false;
  let desktopTasksRetired = false;
  const desktopSetup = c.desktopPanel
    ? prepareHandsetDesktop(tasks, {
        directory: c.attemptDirectory,
        sessionToken: capability.token,
        taskId: task.id,
        attemptId,
        worker: engine ? "codex" : "simulation",
      })
    : undefined;
  const assertDesktopControl = (controlId: string) => {
    if (controlId !== plan.id || ended)
      throw Error("The exact owned handset attempt is no longer available.");
  };
  const desktop = desktopSetup
    ? new TaskDesktopService(
        tasks,
        engine,
        desktopSetup.config,
        {
          snapshot: () => {
            // Read the owned receipt directly: cleanup remains usable after session expiry.
            let record;
            if (prepared && presentation) {
              try {
                record = presentation.ledger.get(
                  session.id,
                  prepared.manifest.id,
                );
              } catch {
                /* No capture receipt exists before preparation. */
              }
            }
            const sharingClean =
              record?.cleanup &&
              Object.values(record.cleanup).every((v) => v === true);
            return {
              controlId: ended ? null : plan.id,
              callActive:
                reserved &&
                !ended &&
                !coordinator.status(plan.id).cleanupConfirmed,
              sharingActive:
                !!record &&
                record.stoppedAt === undefined &&
                ["visible", "narrating"].includes(record.state),
              canStopCall: !ended && !stopRequested,
              canStopSharing:
                !!presenter && !!record && !ended && !sharingClean,
            };
          },
          stopCall: async (controlId, eventId) => {
            assertDesktopControl(controlId);
            await stop(`desktop_${eventId}`);
          },
          stopSharing: async (controlId, eventId) => {
            assertDesktopControl(controlId);
            if (!presenter) throw Error("This attempt has no sharing.");
            await presenter.stopLocal(`desktop_${hash(eventId)}`);
          },
        },
        () => !desktopTasksRetired,
      )
    : undefined;
  const taskServer = serve({
    fetch: createTaskApp(
      tasks,
      saved.operatorToken,
      engine,
      voiceService,
      presentation,
      {
        taskId: task.id,
        voiceId: admitted.voice.id,
        presentationId: prepared?.manifest.id,
      },
      desktop,
    ).fetch,
    hostname: "127.0.0.1",
    port: 13323,
  });
  setupCleanups.push(
    () => new Promise<void>((r) => taskServer.close(() => r())),
  );
  const child = spawn(
    c.python,
    [
      resolve(
        c.walkthrough
          ? "media/task_walkthrough_livekit_local.py"
          : "media/task_voice_livekit_local.py",
      ),
      ...(prepared
        ? ["--presentation-file", join(c.attemptDirectory, "presentation.json")]
        : []),
      "--binding-file",
      join(c.attemptDirectory, "binding.json"),
      "--voice-file",
      join(c.attemptDirectory, "voice.json"),
      "--provider-file",
      c.providerFile,
      "--livekit-file",
      c.livekitFile,
      "--control-file",
      join(c.attemptDirectory, "control.json"),
      "--journal",
      join(c.attemptDirectory, "media.sqlite"),
      "--port",
      "3322",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  let mediaJoined = false;
  const mediaJoin = new Promise<void>((r) =>
    child.once("close", () => {
      mediaJoined = true;
      r();
    }),
  );
  async function joinMedia() {
    if (mediaJoined) return;
    child.kill("SIGTERM");
    await Promise.race([mediaJoin, new Promise((r) => setTimeout(r, 2000))]);
    if (!mediaJoined) child.kill("SIGKILL");
    await Promise.race([mediaJoin, new Promise((r) => setTimeout(r, 2000))]);
    if (!mediaJoined)
      throw Error("Media process shutdown unconfirmed; preserve owner lock.");
  }
  setupCleanups.push(joinMedia);
  const presentationWatch = presentation
    ? setInterval(() => {
        void presentation!.reconcile().catch(() => {});
      }, 100)
    : undefined;
  setupCleanups.push(async () => {
    if (presentationWatch) clearInterval(presentationWatch);
    await presentation?.close();
    await engine?.close();
  });
  let callCleanupReported = false;
  const localOrigin = "http://127.0.0.1:13324";
  async function stop(reason = "operator_stop") {
    if (ended) return;
    stopRequested = true;
    audit("stop_request", reason);
    if (reserved) await monitor.stop(reason);
    else voices.end(admitted.voice.id, `${attemptId}_local_stop`);
  }
  const ui = createTaskAudioStopApp({
    origin: localOrigin,
    stop: () => stop("local_button"),
    status: () => ({ state: lastState, ended }),
    ...(presenter
      ? {
          stopSharing: async () => {
            await presenter!.stopLocal(`${attemptId}_local_sharing_stop`);
          },
        }
      : {}),
  });
  const uiServer = serve({
    fetch: ui.fetch,
    hostname: "127.0.0.1",
    port: 13324,
  });
  setupCleanups.push(() => new Promise<void>((r) => uiServer.close(() => r())));
  taskServer.on("error", () => handle(stop("task_server_error")));
  uiServer.on("error", () => handle(stop("stop_server_error")));
  child.on("error", () => handle(stop("child_spawn_error")));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let finishing: Promise<void> | undefined;
  function finish(): Promise<void> {
    if (finishing) return finishing;
    finishing = finishOwned().finally(() => {
      finishing = undefined;
    });
    return finishing;
  }
  async function finishOwned() {
    if (ended) return;
    if (reserved && !(await coordinator.inspect(plan.id)).cleanupConfirmed)
      return;
    voices.end(admitted.voice.id, `${attemptId}_operator_end`);
    stopRequested = true;
    await presentation?.close();
    if (engine) {
      // Ending the call never cancels a scoped coding run or an admitted correction.
      const current = ledger.get(session.id, task.id);
      if (
        ["queued", "running", "verifying"].includes(current.state) ||
        !engine.closeIfIdle()
      ) {
        await joinMedia();
        lastState = "Call ended; coding and independent verification continue";
        if (!callCleanupReported) {
          callCleanupReported = true;
          console.log(
            JSON.stringify({
              event: "call_cleanup_confirmed_task_continues",
              cleanupConfirmed: true,
              taskState: current.state,
            }),
          );
        }
        return;
      }
    }
    desktopTasksRetired = true;
    try {
      const observation = await media.inspect(plan);
      put("shutdown-summary.json", {
        at: Date.now(),
        ...(reserved
          ? { call: coordinator.status(plan.id) }
          : { undialed: true }),
        ...(observation.audioOutput
          ? { audioOutput: observation.audioOutput }
          : {}),
        physicalAcceptance: false,
      });
    } catch {
      audit("shutdown_summary", "unavailable");
    }
    await joinMedia();
    if (presentationWatch) clearInterval(presentationWatch);
    await engine?.close();
    await new Promise<void>((r) => taskServer.close(() => r()));
    await inspectorClient.close();
    ended = true;
    store.close();
    closeSync(lock);
    unlinkSync(lockPath);
    lastState = "Call ended; native and local cleanup confirmed";
    console.log(
      JSON.stringify({
        event: "finished",
        cleanupConfirmed: true,
        physicalAcceptance: false,
      }),
    );
    setTimeout(() => {
      uiServer.close();
      process.exit(0);
    }, 5000);
  }
  async function start() {
    if (!ready || starting || reserved || stopRequested || ended) {
      console.log(JSON.stringify({ event: "start_not_ready_or_already_used" }));
      return;
    }
    starting = true;
    try {
      if (presentation)
        await presentation.prepare(capability.token, task.id, {
          eventId: `${attemptId}_presentation_prepare`,
          manifest: prepared!.manifest,
          grant: prepared!.grant,
        });
      await coordinator.preflight(plan, authorization);
      coordinator.reserve(plan, authorization);
      reserved = true;
      console.log(
        JSON.stringify({
          event: "preflight_passed",
          audioOnly: !isTaskWalkthroughPlan(plan),
        }),
      );
      let s = await coordinator.prepare(plan.id);
      if (s.state !== "prepared")
        throw Error("Media preparation requires reconciliation.");
      if (stopRequested) throw Error("Stopped before dialing.");
      s = await coordinator.dial(plan.id);
      lastState = s.state;
      console.log(JSON.stringify({ event: "dial_result", state: s.state }));
    } catch {
      console.log(
        JSON.stringify({
          event: "start_refused_or_failed",
          reserved,
          outcomeKnown: !reserved,
        }),
      );
      await stop();
      if (!reserved) await finish();
    }
  }
  let polling = false;
  const interval = setInterval(async () => {
    if (ended || polling) return;
    polling = true;
    try {
      if (!reserved) {
        if (stopRequested || Date.now() >= dispatchExpiresAt) {
          await stop();
          await finish();
        }
        return;
      }
      if (coordinator.status(plan.id).cleanupConfirmed) {
        await finish();
        if (ended) clearInterval(interval);
        return;
      }
      if (
        isTaskWalkthroughPlan(plan) &&
        !coordinator.status(plan.id).cleanupConfirmed
      ) {
        try {
          destinationProof(await remote(true));
        } catch {
          await stop("destination_authority_unavailable");
        }
      }
      const s = await monitor.tick();
      if (s.state !== lastState) {
        lastState = s.state;
        console.log(
          JSON.stringify({
            event: "call_state",
            state: s.state,
            mediaClosed: s.mediaClosed,
            nativeCleanupComplete: s.nativeCleanupComplete,
          }),
        );
      }
      if (s.cleanupConfirmed) {
        await finish();
        if (ended) clearInterval(interval);
      }
    } catch {
      console.log(JSON.stringify({ event: "read_failed_preserve_receipts" }));
    } finally {
      polling = false;
    }
  }, 1000);
  setupCleanups.push(() => clearInterval(interval));
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => handle(stop("signal")));
  function handle(operation: Promise<unknown>) {
    void operation.catch(() => {
      stopRequested = true;
      console.log(
        JSON.stringify({ event: "cleanup_unconfirmed_preserve_owner" }),
      );
    });
  }
  child.once("exit", () => {
    if (!ended) {
      lastState = "Media process exited; stopping";
      handle(stop("child_exit"));
    }
  });
  const input = createInterface({ input: process.stdin });
  setupCleanups.push(() => input.close());
  input.on("line", (line) => {
    if (line === "start") handle(start());
    else if (line === "stop") handle(stop("stdin_stop"));
    else if (line === "status")
      console.log(JSON.stringify({ state: lastState, reserved, ended }));
  });
  input.once("close", () => handle(stop("stdin_eof")));
  for (let i = 0; i < 100; i++) {
    try {
      await media.inspect(plan);
      ready = true;
      lastState = "Ready for operator start";
      console.log(
        JSON.stringify({ event: "ready", stopURL: localOrigin, expiresAt }),
      );
      break;
    } catch {
      if (child.exitCode !== null || i === 99) {
        await stop();
        await finish();
        break;
      }
      await sleep(100);
    }
  }
}
main().catch(async () => {
  for (const cleanup of setupCleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      setupCleanupFailed = true;
    }
  }
  console.error(
    JSON.stringify({
      event: "setup_failed_before_call",
      cleanupConfirmed: !setupCleanupFailed,
      ownerRetained: setupCleanupFailed,
    }),
  );
  process.exitCode = 1;
});
