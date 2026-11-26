/** Disposable connector/backend/media integration with synthetic or explicit window pixels.
 * No installed configuration, provider, replacement agent, or OS-input dispatch here. */
import { serve } from "@hono/node-server";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { ControlCoordinator } from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { Viewing } from "../src/control/viewing.js";
import { createApp } from "../src/app.js";
import { MediaDevicePort, mediaSessionId } from "../media/device-port.js";
import { ClawdTimeClient } from "../connectors/shared/client.js";
import { executeConversationCommand } from "../connectors/shared/conversation.js";
import type {
  ControlLease,
  DevicePort,
  Frame,
  InputAction,
} from "../src/contracts.js";
import type {
  CameraCommand,
  PresentationReference,
} from "../src/camera-contracts.js";
import { cameraSurfaceSchema } from "../src/camera-contracts.js";
import { presentationScenePlanSchema } from "../src/presentation-scene-contracts.js";
import { PreviewCommandQueue } from "./preview-command-queue.js";
import { PresentationSceneController } from "../connectors/shared/presentation-scenes.js";
import { PreviewNativeBroker } from "./preview-native-broker.js";
import { PreviewLivePresentationBroker } from "./preview-live-presentation.js";
import { dirname } from "node:path";

const args = process.argv.slice(2);
if (
  args.some(
    (a, i) =>
      ![
        "--smoke",
        "--voice-smoke",
        "--presentation-smoke",
        "--port",
        "--native-window",
        "--native-display",
        "--native-activation",
        "--snapshot-display",
      ].includes(a) &&
      !["--port", "--native-display"].includes(args[i - 1] ?? ""),
  )
)
  throw new Error(
    "Use --smoke, --port PORT, --native-window, or --native-display ID for explicit local native-tool review.",
  );
const voiceSmoke = args.includes("--voice-smoke");
const presentationSmoke = args.includes("--presentation-smoke");
const nativeWindow = args.includes("--native-window");
const nativeDisplay = args.includes("--native-display");
const nativeReview = nativeWindow || nativeDisplay;
const nativeActivation = args.includes("--native-activation");
// Explicit diagnostic transport, never an automatic retry after stream failure.
const snapshotDisplay = args.includes("--snapshot-display");
if (snapshotDisplay && !nativeDisplay)
  throw new Error(
    "Snapshot display review requires an explicitly selected display.",
  );
if (nativeActivation && !nativeDisplay)
  throw new Error(
    "Native activation review requires an explicitly selected display.",
  );
if (nativeWindow && nativeDisplay)
  throw new Error("Select one surface, not both display and window.");
if (args.filter((a) => a === "--native-display").length > 1)
  throw new Error("Select one display.");
if (
  nativeReview &&
  (args.includes("--smoke") || voiceSmoke || presentationSmoke)
)
  throw new Error("Native review never submits synthetic fallback input.");
const nativeBinary = resolve("mac/.build/debug/ClawdTimeCompanion");
let selectedSurface = cameraSurfaceSchema.parse({
  kind: "display",
  id: "1",
  displayId: 1,
});
if (nativeDisplay) {
  const value = args[args.indexOf("--native-display") + 1];
  selectedSurface = cameraSurfaceSchema.parse({
    kind: "display",
    id: value,
    displayId: Number(value),
  });
}
if (nativeReview) {
  const run = promisify(execFile);
  await run("swift", ["build", "--package-path", "mac"], {
    maxBuffer: 2 * 1024 * 1024,
  });
  if (nativeWindow) {
    const found = await run(
      nativeBinary,
      [
        "--camera-find-window",
        "--query",
        JSON.stringify({
          bundleId: "com.apple.finder",
          title: "ClawdTime Sharing Review",
        }),
      ],
      { timeout: 10000, maxBuffer: 16384 },
    );
    selectedSurface = cameraSurfaceSchema.parse(JSON.parse(found.stdout));
    if (selectedSurface.kind !== "window")
      throw new Error("Exact Finder window required.");
  }
}
const port = args.includes("--port")
  ? Number(args[args.indexOf("--port") + 1])
  : nativeReview
    ? 3350
    : 3348;
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid local port.");
const origin = `http://127.0.0.1:${port}`,
  mediaToken = randomBytes(32).toString("hex"),
  nativeHostToken = randomBytes(32).toString("hex");
const store = new Store();
const service = new ClawdTime(store, new SimulationTransport());
let python: ChildProcessWithoutNullStreams | undefined;
let remote: MediaDevicePort | undefined;
let preview:
  | { origin: string; token: string; url?: string; previewUrl?: string }
  | undefined;
let shuttingDown = false;
let scenes: PresentationSceneController | undefined;
let nativeBroker: PreviewNativeBroker | undefined;
let liveBroker: PreviewLivePresentationBroker | undefined;
let reviewInput: ReturnType<typeof createInterface> | undefined;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
class PreviewPort implements DevicePort {
  async readiness(deviceId: string, memberId: string, displayId: string) {
    if (remote) return remote.readiness(deviceId, memberId, displayId);
    return {
      cameraVersion: 1,
      controlPolicy: nativeReview
        ? "agent_tools_only"
        : "agent_tools_with_fallback",
      policyRevision: 1,
      controlAllowed: true,
      armed: true,
      available: true,
      screenPermission: true,
      viewAllowed: true,
      displayAttached: true,
      activeLease: false,
    };
  }
  async createLease(lease: ControlLease) {
    if (!python) {
      python = spawn(
        resolve("media/.venv/bin/python"),
        ["media/camera_preview.py", "--config-stdin"],
        {
          cwd: resolve("."),
          env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      // Errors are fixed operational messages; never relay a captured frame or request body.
      python.stderr.on("data", () => {});
      const lines = createInterface({ input: python.stdout });
      const started = new Promise<typeof preview>((resolveStarted, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Local camera preview startup timed out.")),
          20000,
        );
        python!.once("error", () => {
          clearTimeout(timeout);
          reject(new Error("Local Python preview could not start."));
        });
        python!.once("exit", (code) => {
          if (!shuttingDown) {
            clearTimeout(timeout);
            reject(new Error(`Local preview exited (${code}).`));
          }
        });
        lines.once("line", (line) => {
          clearTimeout(timeout);
          try {
            resolveStarted(JSON.parse(line));
          } catch {
            reject(new Error("Invalid local preview handshake."));
          }
        });
      });
      python.stdin.end(
        JSON.stringify({
          mode: nativeReview ? "actual" : "synthetic",
          ...(nativeReview
            ? {
                nativeBinary,
                nativeControl: true,
                nativePresentation: nativeActivation,
                ...(nativeActivation
                  ? {
                      nativePresentationToken: nativeHostToken,
                      nativeReceiptPath: nativeBroker?.nativeReceiptPath,
                    }
                  : {}),
                capture: true,
                displayStream: nativeDisplay && !snapshotDisplay,
                ...(nativeDisplay
                  ? { sourceFps: snapshotDisplay ? 5 : 15, renderFps: 30 }
                  : {}),
                surfaceLabel: nativeDisplay
                  ? "Selected display · two-app presentation review"
                  : "Finder — ClawdTime Sharing Review · native CUA review",
              }
            : {}),
          port: 0,
          token: mediaToken,
          sessionId: mediaSessionId(lease.requestId),
          agentSessionId: lease.sessionId,
          leaseId: lease.id,
          deviceId: lease.deviceId,
          memberId: lease.memberId,
          callId: lease.callId,
          surface: lease.surface,
          backendOrigin: origin,
          backendToken: mediaToken,
        }) + "\n",
      );
      preview = await started;
      if (!preview || !preview.origin || preview.token !== mediaToken)
        throw new Error("Preview handshake mismatch.");
      remote = new MediaDevicePort(preview.origin, mediaToken);
    }
    await remote!.createLease(lease);
  }
  frame(l: ControlLease) {
    return remote!.frame(l);
  }
  frameImage(l: ControlLease) {
    return remote!.frameImage(l);
  }
  cameraStatus(l: ControlLease) {
    return remote!.cameraStatus(l);
  }
  cameraCommand(l: ControlLease, c: CameraCommand) {
    return remote!.cameraCommand(l, c);
  }
  action(
    l: ControlLease,
    f: Frame,
    a: InputAction,
    id: string,
    p?: PresentationReference,
  ) {
    return remote!.action(l, f, a, id, p);
  }
  async release(l: ControlLease) {
    if (remote) await remote.release(l);
  }
}
const device = new PreviewPort(),
  control = new ControlCoordinator(store, device),
  human = new HumanRouter(service, control);
const viewing = new Viewing(store, device, Date.now, false, true);
const paired = service.claimPairing({
  token: service.createPairingInvite({
    memberId: "preview_member",
    recipient: "synthetic",
    conversationId: "synthetic",
    lineId: "synthetic",
    deviceId: "preview_device",
    displayId: String(selectedSurface.displayId),
  }).token,
  deviceId: "preview_device",
  displayId: String(selectedSurface.displayId),
  allowView: true,
  allowControl: true,
});
const agent = service.registerSession(paired.token, {
  protocolVersion: 2,
  adapter: "codex",
  adapterVersion: "synthetic-preview",
  projectRoot: "/synthetic",
  externalSessionId: "preview",
  hostId: "preview",
  ...(voiceSmoke
    ? {
        voiceFrontend: { version: 1 as const, provider: "elevenlabs" as const },
      }
    : {}),
  capabilities: {
    ...(voiceSmoke ? { voiceInteractionVersion: 1 as const } : {}),
    cooperativePause: true,
    polling: true,
    screenCameraVersion: 1,
    ...(nativeReview
      ? {
          nativeControl: "desktop" as const,
          sharedSurface: true,
          nativeCancellation: false,
        }
      : {}),
  },
  screenCamera: {
    version: 1,
    surface: selectedSurface,
  },
});
const request = service.requestAttention(agent.token, {
  taskId: "preview",
  idempotencyKey: "preview",
  reason: "review",
  question: nativeReview
    ? "Local selected-surface presentation and native CUA review; no external call"
    : "Synthetic local camera",
  timeoutSeconds: 900,
});
await service.drain();
service.observeCall(request.id, "connected", true);
const app = createApp(service, control, human, {
  origin,
  simulation: true,
  mediaToken,
  screenCameraEnabled: true,
  elevenLabsEnabled: voiceSmoke,
  twoWayVoiceEnabled: voiceSmoke,
  remoteAudioIsolated: voiceSmoke,
});
const client = new ClawdTimeClient(origin, agent.token);
if (nativeActivation) {
  nativeBroker = new PreviewNativeBroker({
    app,
    mediaSessionId: mediaSessionId(request.id),
    token: mediaToken,
    nativeHostToken,
    requestId: request.id,
    sessionId: agent.session.id,
    displayId: selectedSurface.displayId,
    scenes: () => scenes,
    executionStatus: () =>
      executeConversationCommand(client, "execution_status", {
        requestId: request.id,
      }),
    cameraStatus: () => client.screenCamera(request.id),
    mediaOrigin: () => preview?.origin,
    shuttingDown: () => shuttingDown,
  });
  liveBroker = new PreviewLivePresentationBroker({
    app,
    token: mediaToken,
    hostToken: nativeHostToken,
    mediaSessionId: mediaSessionId(request.id),
    requestId: request.id,
    sessionId: agent.session.id,
    displayId: selectedSurface.displayId,
    directory: dirname(nativeBroker.journalPath),
    scenes: () => scenes,
    executionStatus: () =>
      executeConversationCommand(client, "execution_status", {
        requestId: request.id,
      }),
    cameraStatus: () => client.screenCamera(request.id),
    mediaOrigin: () => preview?.origin,
    processIdentity: (window) => nativeBroker?.verifiedProcessIdentity(window),
    shuttingDown: () => shuttingDown,
  });
}
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
const tick = setInterval(() => {
  service.heartbeat(agent.token);
  void viewing.tick();
}, 500);
async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  reviewInput?.close();
  clearInterval(tick);
  clearTimeout(expiry);
  service.store.saveState(`view-stopped:${request.id}`, true);
  await control.stopPairing(paired.pairing.id).catch(() => {});
  if (python && python.exitCode === null) {
    const child = python;
    await new Promise<void>((done) => {
      const deadline = setTimeout(() => {
        child.kill("SIGTERM");
        done();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(deadline);
        done();
      });
      // asyncio handles SIGINT by canceling main and running its cleanup finally.
      child.kill("SIGINT");
    });
  }
  await nativeBroker?.close();
  await liveBroker?.close();
  server.close();
  store.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void close());
const expiry = setTimeout(() => void close(), 900000);
try {
  await viewing.tick();
  let status: any;
  for (let i = 0; i < 50; i++) {
    try {
      status = await executeConversationCommand(
        client,
        "screen_camera_status",
        { requestId: request.id },
      );
      if (status.state === "live") break;
    } catch {}
    await wait(100);
  }
  if (status?.state !== "live" && preview) {
    try {
      const diagnostics = await fetch(`${preview.origin}/preview/metrics`, {
        headers: { Authorization: `Bearer ${mediaToken}` },
        signal: AbortSignal.timeout(3000),
      });
      const metrics: any = await diagnostics.json();
      console.error(
        JSON.stringify({
          startup: "camera_unavailable",
          source: metrics.source,
          stopped: metrics.stopped,
        }),
      );
    } catch {
      /* Keep startup errors free of screen data and credentials. */
    }
  }
  assert.equal(
    status?.state,
    "live",
    "Backend/media path must produce a fresh selected frame",
  );
  if (!voiceSmoke && !presentationSmoke && !args.includes("--smoke"))
    console.log(
      `${nativeReview ? "Native CUA camera review" : "Synthetic camera preview"}: ${preview?.url ?? preview?.previewUrl ?? `${preview!.origin}/#${mediaToken}`}`,
    );
  console.log(
    "Local simulation only. Stop clears capture. Session expires after 15 minutes. Ctrl-C exits.",
  );
  if (nativeReview) {
    console.log(
      JSON.stringify({
        ready: true,
        surface: selectedSurface,
        requestId: request.id,
        ...(nativeBroker ? { nativeJournal: nativeBroker.journalPath } : {}),
        nativeInput:
          "Use this chat's verified native tool only after claim and fresh execution_status. This bridge never submits OS input.",
      }),
    );
    const input = createInterface({ input: process.stdin });
    reviewInput = input;
    const queue = new PreviewCommandQueue();
    const receipts = new Map<
      string,
      { fingerprint: string; result: unknown }
    >();
    const sceneCommands = new Set([
      "presentation_prepare",
      "presentation_status",
      "presentation_begin",
      "presentation_present",
      "presentation_present_observed",
      "presentation_present_live",
      "presentation_complete",
      "presentation_replan",
      "presentation_receipts",
      "presentation_next",
      "presentation_interrupt",
      "presentation_observe",
      "preview_metrics",
      "native_prepare",
      "native_status",
      "native_reconcile",
    ]);
    const allowed = new Set([
      ...sceneCommands,
      "execution_status",
      "transfer_execution",
      "conversation_turns",
      "screen_camera_status",
      "screen_camera_command",
    ]);
    input.on("line", (line) => {
      let incoming: any;
      try {
        if (line.length > 16384) throw new Error("Command too large.");
        incoming = JSON.parse(line);
        if (
          !incoming ||
          typeof incoming !== "object" ||
          Array.isArray(incoming) ||
          (incoming.args !== undefined &&
            (!incoming.args ||
              typeof incoming.args !== "object" ||
              Array.isArray(incoming.args)))
        )
          throw new Error("Command object required.");
        if (
          incoming.command === "presentation_interrupt" &&
          Object.keys(incoming.args ?? {}).length
        )
          throw new Error("Presentation interrupt takes no arguments.");
      } catch {
        console.log(JSON.stringify({ error: "Invalid local review command." }));
        return;
      }
      const isInterrupt = incoming.command === "presentation_interrupt";
      const isRelease =
        incoming.command === "transfer_execution" &&
        incoming.args?.executor === "none";
      const isMutation = ![
        "execution_status",
        "conversation_turns",
        "screen_camera_status",
        "presentation_status",
        "presentation_observe",
        "preview_metrics",
        "native_status",
        "presentation_receipts",
      ].includes(incoming.command);
      const handle = async () => {
        let id: unknown;
        try {
          if (line.length > 16384) throw new Error("Command too large.");
          const command = JSON.parse(line);
          id = command.id;
          if (
            typeof id !== "string" ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
            !allowed.has(command.command)
          )
            throw new Error("Invalid local review command.");
          if (
            command.args?.executor &&
            !["native", "none"].includes(command.args.executor)
          )
            throw new Error(
              "Only native ownership is available in this review.",
            );
          const fingerprint = JSON.stringify(command);
          const effect =
            command.command === "transfer_execution" ||
            command.command === "screen_camera_command" ||
            (sceneCommands.has(command.command) &&
              ![
                "presentation_status",
                "presentation_observe",
                "preview_metrics",
                "native_status",
                "presentation_receipts",
              ].includes(command.command));
          const old = receipts.get(id);
          if (old) {
            if (old.fingerprint !== fingerprint)
              throw new Error(
                "Command ID already used with different arguments.",
              );
            console.log(JSON.stringify(old.result));
            return;
          }
          const release =
            command.command === "transfer_execution" &&
            command.args?.executor === "none";
          if (effect && receipts.size >= (release ? 256 : 255))
            throw new Error(
              "Review mutation limit reached; status and one reserved ownership release remain available.",
            );
          // Reserve before dispatch: uncertain effects cannot be replayed.
          if (effect)
            receipts.set(id, {
              fingerprint,
              result: {
                id,
                error:
                  "Prior result unavailable; inspect ownership before continuing. Do not replay the effect.",
              },
            });
          let result: unknown;
          if (command.command === "presentation_receipts") {
            result = liveBroker?.status() ?? { enabled: false };
          } else if (
            ["native_prepare", "native_status", "native_reconcile"].includes(
              command.command,
            )
          ) {
            if (!nativeBroker)
              throw new Error(
                "Native activation capability is not enabled for this review.",
              );
            if (command.command === "native_prepare")
              result = await nativeBroker.prepare(command.args);
            else if (command.command === "native_reconcile")
              result = await nativeBroker.reconcile(command.args?.operationId);
            else result = nativeBroker.status();
          } else if (command.command === "preview_metrics") {
            const response = await fetch(`${preview!.origin}/preview/metrics`, {
              headers: { Authorization: `Bearer ${mediaToken}` },
              signal: AbortSignal.timeout(3000),
              redirect: "error",
            });
            if (!response.ok)
              throw new Error("Local preview metrics unavailable.");
            result = await response.json();
          } else if (command.command === "presentation_prepare") {
            if (scenes)
              throw new Error(
                "One prepared plan per review. Interrupt or start a fresh preview to change plans.",
              );
            const plan = presentationScenePlanSchema.parse(command.args?.plan);
            if (
              plan.scenes.some(
                (scene) => scene.window.displayId !== selectedSurface.displayId,
              )
            )
              throw new Error(
                "Every scene must remain on the explicitly selected display.",
              );
            if (selectedSurface.kind !== "display")
              throw new Error(
                "Multi-app presentation requires an explicit display session.",
              );
            scenes = new PresentationSceneController(plan, {
              cameraStatus: () => client.screenCamera(request.id),
              cameraCommand: (cameraCommand) =>
                client.screenCamera(request.id, cameraCommand),
              executionStatus: () =>
                executeConversationCommand(client, "execution_status", {
                  requestId: request.id,
                }),
              ...(liveBroker
                ? {
                    presentLive: (
                      intent: import("../src/live-presentation-contracts.js").LivePresentationIntent,
                    ) => liveBroker!.present(intent),
                  }
                : {}),
            });
            result = scenes.status();
          } else if (sceneCommands.has(command.command)) {
            if (!scenes)
              throw new Error("Prepare the presentation plan first.");
            if (command.command === "presentation_status")
              result = scenes.status();
            else if (command.command === "presentation_observe")
              result = await scenes.observe();
            else if (command.command === "presentation_begin")
              result = await scenes.begin(command.args?.sceneId);
            else if (command.command === "presentation_present")
              result = await scenes.present(
                command.args?.verification,
                command.args?.rect,
              );
            else if (command.command === "presentation_present_observed")
              result = await scenes.presentObserved(
                command.args?.attestation,
                command.args?.rect,
              );
            else if (command.command === "presentation_present_live")
              result = await scenes.presentLive();
            else if (command.command === "presentation_complete")
              result = await scenes.complete();
            else if (command.command === "presentation_replan")
              result = await scenes.replan(
                command.args?.plan,
                command.args?.expectedGeneration,
              );
            else if (command.command === "presentation_next")
              result = await scenes.next();
            else result = await scenes.interrupt();
          } else {
            if (
              command.command === "transfer_execution" &&
              (nativeBroker?.hasUnresolvedActor() ||
                liveBroker?.hasUnresolved())
            )
              throw new Error(
                "Native operation is unresolved; inspect its original receipt before ownership transfer.",
              );
            result = await executeConversationCommand(client, command.command, {
              ...command.args,
              requestId: request.id,
            });
          }
          const response = { id, result };
          if (effect) receipts.set(id, { fingerprint, result: response });
          console.log(JSON.stringify(response));
        } catch (error) {
          console.log(
            JSON.stringify({
              id,
              error:
                error instanceof Error
                  ? error.message
                  : "Review command failed; inspect state.",
            }),
          );
        }
      };
      // Only a well-formed, fresh interruption may invalidate queued effects.
      const interruptReady =
        isInterrupt &&
        scenes &&
        typeof incoming.id === "string" &&
        /^[A-Za-z0-9_-]{1,80}$/.test(incoming.id) &&
        !receipts.has(incoming.id) &&
        receipts.size < 255;
      void (
        interruptReady
          ? queue.interrupt(handle)
          : queue.run(handle, isMutation, isRelease)
      ).catch((error) => {
        console.log(
          JSON.stringify({
            id: typeof incoming.id === "string" ? incoming.id : undefined,
            error:
              error instanceof Error
                ? error.message
                : "Local review command failed.",
          }),
        );
      });
    });
    input.once("close", () => {
      void queue.settled().then(close);
    });
  }
  if (presentationSmoke) {
    const window = {
      appId: "local.fixture",
      windowId: "1",
      ownerPid: 1,
      displayId: 1,
    };
    const scenes = new PresentationSceneController(
      {
        version: 1,
        id: "integration_review",
        scenes: [
          {
            id: "folders",
            title: "Review folders",
            window,
            intent: "Show the synthetic folders",
            expectedOutcome: "Folders visible",
            annotation: { kind: "rectangle" },
          },
          {
            id: "document",
            title: "Review document",
            window: { ...window, windowId: "2" },
            intent: "Show the synthetic document",
            expectedOutcome: "Document visible",
            annotation: { kind: "highlight" },
          },
        ],
      },
      {
        cameraStatus: () => client.screenCamera(request.id),
        cameraCommand: async (command) => {
          try {
            return await client.screenCamera(request.id, command);
          } catch (error) {
            console.error(
              `Synthetic scene ${command.op} failed: ${error instanceof Error ? error.message : "unavailable"}`,
            );
            throw error;
          }
        },
        executionStatus: () =>
          executeConversationCommand(client, "execution_status", {
            requestId: request.id,
          }),
      },
    );
    const rect = { x: 0.16, y: 0.2, width: 0.55, height: 0.38 };
    async function presentCurrent() {
      const observation = await scenes.observe();
      const camera = observation.camera;
      const current = scenes.status().scene!;
      return scenes.present(
        {
          sceneId: current.id,
          generation: observation.generation,
          observedAt: observation.observedAt,
          window: current.window,
          windowBounds: { x: 0, y: 0, width: 1, height: 1 },
          resultVerified: true,
          sourceFrameId: camera.sourceFrameId,
          geometryGeneration: camera.geometryGeneration,
          contentRevision: camera.contentRevision,
          leaseId: camera.leaseId,
        },
        rect,
      );
    }
    await scenes.begin("folders");
    await presentCurrent();
    await wait(700);
    assert.equal(scenes.status().phase, "presented");
    assert.equal(
      ((await client.screenCamera(request.id)) as any).annotations.length,
      1,
    );
    await scenes.next();
    await presentCurrent();
    assert.equal(scenes.status().scene?.id, "document");
    await scenes.begin("document");
    const owner = await executeConversationCommand(client, "execution_status", {
      requestId: request.id,
    });
    const claimed = await executeConversationCommand(
      client,
      "transfer_execution",
      {
        requestId: request.id,
        expectedEpoch: owner.epoch,
        executor: "clawdtime",
        previousOutcome: "idle",
        backgroundActorsStopped: true,
      },
    );
    await assert.rejects(scenes.observe(), /released native ownership/);
    await executeConversationCommand(client, "transfer_execution", {
      requestId: request.id,
      expectedEpoch: claimed.epoch,
      executor: "none",
      previousOutcome: "completed",
      backgroundActorsStopped: true,
    });
    await scenes.interrupt();
    assert.equal(scenes.status().phase, "interrupted");
    const stopped = await fetch(`${preview!.origin}/preview/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mediaToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(stopped.ok, true);
    const stoppedOwner = await executeConversationCommand(
      client,
      "execution_status",
      { requestId: request.id },
    );
    assert.equal(stoppedOwner.viewingStopped, true);
    await assert.rejects(scenes.observe());
    console.log(
      "PASS: two prepared scenes → fresh observation → focus/annotation; ownership blocks presentation, interrupt returns overview, local Stop latches backend. Synthetic pixels and native-result witnesses only; no OS input or call.",
    );
    await close();
  }
  if (voiceSmoke) {
    const call =
      store.all<import("../src/contracts.js").CallSession>("call")[0]!;
    await executeConversationCommand(client, "prepare_voice_presentation", {
      requestId: request.id,
      preparation: {
        version: 1,
        context:
          "Synthetic prepared presentation; no physical call or provider connection.",
        geometryGeneration: status.geometryGeneration,
        contentRevision: status.contentRevision,
        targets: [
          {
            id: "review",
            label: "Review region",
            rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
            annotation: { kind: "highlight", text: "Prepared review" },
          },
        ],
      },
    });
    const invoke = async (
      eventId: string,
      action: string,
      targetId?: string,
    ) => {
      const started = performance.now();
      const response = await app.request(
        `/media/${mediaSessionId(request.id)}/voice/camera`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${mediaToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            eventId,
            callId: call.id,
            qualifiedRemoteAudio: true,
            action,
            ...(targetId ? { targetId } : {}),
          }),
        },
      );
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.accepted, true);
      return started;
    };
    const started = await invoke("voice_focus", "focus", "review");
    for (let i = 0; i < 40; i++) {
      status = await client.screenCamera(request.id);
      if (!status.moving && status.crop.width < 0.99) break;
      await wait(50);
    }
    assert.ok(status.crop.width < 0.99);
    assert.equal(status.moving, false);
    console.log(
      `Local prepared focus accepted-to-settled check: ${Math.round(performance.now() - started)}ms (not handset latency)`,
    );
    await invoke("voice_mark", "annotate", "review");
    status = await client.screenCamera(request.id);
    assert.equal(status.annotations[0]?.kind, "highlight");
    const revision = status.revision;
    await invoke("voice_mark", "annotate", "review");
    status = await client.screenCamera(request.id);
    assert.equal(status.revision, revision);
    await invoke("voice_wide", "overview");
    await wait(500);
    status = await client.screenCamera(request.id);
    assert.equal(status.crop.width, 1);
    await invoke("voice_clear", "clear");
    status = await client.screenCamera(request.id);
    assert.equal(status.annotations.length, 0);
    await invoke("voice_stop", "stop");
    await assert.rejects(client.screenCamera(request.id));
    console.log(
      "PASS: same-chat preparation → qualified voice camera route → real media compositor; smooth focus/annotation/overview/clear/deduplication/Stop. Synthetic source, no provider, phone or OS input.",
    );
    await close();
    clearTimeout(expiry);
  }
  if (args.includes("--smoke")) {
    let commandNumber = 0;
    const command = async (fields: Record<string, unknown>) => {
      status = await client.screenCamera(request.id);
      const payload = {
        version: 1,
        commandId: `smoke_${++commandNumber}`,
        expectedRevision: status.revision,
        sourceFrameId: status.sourceFrameId,
        geometryGeneration: status.geometryGeneration,
        ...fields,
      };
      console.log(`Smoke command: ${fields.op}`);
      return {
        payload,
        receipt: await executeConversationCommand(
          client,
          "screen_camera_command",
          { requestId: request.id, command: payload },
        ),
      };
    };
    await command({
      op: "focus_region",
      rect: { x: 0.2, y: 0.15, width: 0.5, height: 0.5 },
      durationMs: 100,
    });
    await wait(150);
    const annotation = await command({
      op: "annotation_upsert",
      annotation: {
        id: "mark",
        kind: "rectangle",
        rect: { x: 0.3, y: 0.25, width: 0.2, height: 0.2 },
        text: "Synthetic target",
        ttlMs: 1000,
      },
    });
    assert.deepEqual(
      await client.screenCamera(request.id, annotation.payload),
      annotation.receipt,
    );
    await command({ op: "freeze" });
    assert.equal(
      ((await client.screenCamera(request.id)) as any).state,
      "paused",
    );
    await command({ op: "resume" });
    await wait(300);
    await command({ op: "clear" });
    assert.equal(
      ((await client.screenCamera(request.id)) as any).annotations.length,
      0,
    );
    console.log("Smoke: claim fallback executor");
    const owner = await executeConversationCommand(
      client,
      "transfer_execution",
      {
        requestId: request.id,
        expectedEpoch: 0,
        executor: "clawdtime",
        previousOutcome: "idle",
        backgroundActorsStopped: true,
        expectedCursor: 0,
      },
    );
    console.log("Smoke: observe pristine frame");
    const observed = await executeConversationCommand(
      client,
      "observe_shared_screen",
      { requestId: request.id, epoch: owner.epoch },
    );
    status = await client.screenCamera(request.id);
    const viewport = status.output.viewport;
    const receipt = await executeConversationCommand(
      client,
      "act_on_shared_screen",
      {
        requestId: request.id,
        epoch: owner.epoch,
        actionId: "synthetic_click",
        frameId: observed.frame.id,
        expectedCursor: 0,
        presentation: {
          revision: status.revision,
          geometryGeneration: status.geometryGeneration,
          sourceFrameId: status.sourceFrameId,
        },
        action: {
          kind: "click",
          x: (viewport.x + viewport.width / 2) / status.output.width,
          y: (viewport.y + viewport.height / 2) / status.output.height,
        },
      },
    );
    assert.equal(receipt.state, "observed");
    await executeConversationCommand(client, "transfer_execution", {
      requestId: request.id,
      expectedEpoch: owner.epoch,
      executor: "none",
      previousOutcome: "completed",
      backgroundActorsStopped: true,
    });
    service.store.saveState(`view-stopped:${request.id}`, true);
    await assert.rejects(client.screenCamera(request.id));
    console.log(
      "PASS: connector → backend policy → media → gateway → synthetic helper; focus/annotation/dedupe/pause/resume/clear; claimed input → fake sink → observation → release; Stop denied.",
    );
    await close();
    clearTimeout(expiry);
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Local preview failed.",
  );
  await close();
  clearTimeout(expiry);
  process.exitCode = 1;
}
