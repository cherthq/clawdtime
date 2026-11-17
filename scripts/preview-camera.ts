/** Disposable local integration: connector → real backend policy → media → fake helper.
 * No installed configuration, provider, agent runner, or OS input is used. */
import { serve } from "@hono/node-server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

const args = process.argv.slice(2);
if (
  args.some(
    (a, i) => !["--smoke", "--port"].includes(a) && args[i - 1] !== "--port",
  )
)
  throw new Error(
    "Use --smoke and/or --port PORT. Actual capture uses the separately opt-in Python preview.",
  );
const port = args.includes("--port")
  ? Number(args[args.indexOf("--port") + 1])
  : 3348;
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid local port.");
const origin = `http://127.0.0.1:${port}`,
  mediaToken = randomBytes(32).toString("hex");
const store = new Store();
const service = new ClawdTime(store, new SimulationTransport());
let python: ChildProcessWithoutNullStreams | undefined;
let remote: MediaDevicePort | undefined;
let preview:
  | { origin: string; token: string; url?: string; previewUrl?: string }
  | undefined;
let shuttingDown = false;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
class PreviewPort implements DevicePort {
  async readiness(deviceId: string, memberId: string, displayId: string) {
    if (remote) return remote.readiness(deviceId, memberId, displayId);
    return {
      cameraVersion: 1,
      controlPolicy: "agent_tools_with_fallback",
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
          mode: "synthetic",
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
    displayId: "1",
  }).token,
  deviceId: "preview_device",
  displayId: "1",
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
  capabilities: {
    cooperativePause: true,
    polling: true,
    screenCameraVersion: 1,
  },
  screenCamera: {
    version: 1,
    surface: { kind: "display", id: "1", displayId: 1 },
  },
});
const request = service.requestAttention(agent.token, {
  taskId: "preview",
  idempotencyKey: "preview",
  reason: "review",
  question: "Synthetic local camera",
  timeoutSeconds: 900,
});
await service.drain();
service.observeCall(request.id, "connected", true);
const app = createApp(service, control, human, {
  origin,
  simulation: true,
  mediaToken,
  screenCameraEnabled: true,
});
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
const tick = setInterval(() => {
  service.heartbeat(agent.token);
  void viewing.tick();
}, 500);
async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
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
  server.close();
  store.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void close());
const expiry = setTimeout(() => void close(), 900000);
try {
  await viewing.tick();
  const client = new ClawdTimeClient(origin, agent.token);
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
  assert.equal(
    status?.state,
    "live",
    "Real backend/media path must produce a fresh synthetic frame",
  );
  console.log(
    `Synthetic camera preview: ${preview?.url ?? preview?.previewUrl ?? `${preview!.origin}/#${mediaToken}`}`,
  );
  console.log(
    "Local simulation only. Stop clears capture. Session expires after 15 minutes. Ctrl-C exits.",
  );
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
