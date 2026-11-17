/** No-call integration harness. Synthetic backend authority; actual production helper path.
 * Only original-chat CUA may click the fixed trigger and perform fixture edits/moves.
 */
import { serve } from "@hono/node-server";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/store.js";
import { ClawdTime } from "../src/attention/service.js";
import { SimulationTransport } from "../src/transport/simulation.js";
import { ControlCoordinator } from "../src/control/coordinator.js";
import { HumanRouter } from "../src/control/human-router.js";
import { Viewing } from "../src/control/viewing.js";
import { createApp } from "../src/app.js";
import { MediaDevicePort, mediaSessionId } from "../media/device-port.js";
import { ApiError, ClawdTimeClient } from "../connectors/shared/client.js";
import { ProductionWalkthroughController } from "../connectors/shared/production-native.js";
import { startProductionNativeTrigger } from "../connectors/shared/production-native-trigger.js";
import { presentationScenePlanSchema } from "../src/presentation-scene-contracts.js";
import type { ControlLease, DevicePort } from "../src/contracts.js";

const [configPath, planPath] = process.argv.slice(2);
if (!configPath || !planPath)
  throw new Error(
    "Usage: production-walkthrough.ts PRIVATE_SYNTHETIC_HELPER_CONFIG PRIVATE_PLAN",
  );
const helper = JSON.parse(readFileSync(configPath, "utf8"));
if (
  !helper.deviceId?.startsWith("synthetic_") ||
  helper.bind !== "127.0.0.1" ||
  !Number.isInteger(helper.port) ||
  helper.port < 1 ||
  helper.port > 65535 ||
  typeof helper.secret !== "string" ||
  helper.secret.length < 32 ||
  helper.displays?.length !== 1 ||
  helper.displays[0].controllers?.length !== 1
)
  throw new Error("Isolated synthetic helper configuration required.");
const plan = presentationScenePlanSchema.parse(
  JSON.parse(readFileSync(planPath, "utf8")),
);
const display = helper.displays[0].displayId,
  member = helper.displays[0].controllers[0];
if (plan.scenes.some((s) => s.window.displayId !== display))
  throw new Error("Plan must match the isolated selected display.");
const directory = mkdtempSync(
  join(tmpdir(), "clawdtime-production-rehearsal-"),
);
const store = new Store(join(directory, "backend.sqlite")),
  service = new ClawdTime(store, new SimulationTransport());
let remote: MediaDevicePort;
const device = new Proxy({} as DevicePort, {
  get:
    (_target, key) =>
    (...args: unknown[]) => {
      const method = (remote as any)?.[key];
      if (typeof method !== "function")
        throw new Error("Isolated media not ready.");
      return method.apply(remote, args);
    },
});
const control = new ControlCoordinator(store, device),
  human = new HumanRouter(service, control);
const pair = service.claimPairing({
  token: service.createPairingInvite({
    memberId: member,
    recipient: "synthetic",
    conversationId: "synthetic",
    lineId: "synthetic",
    deviceId: helper.deviceId,
    displayId: String(display),
  }).token,
  deviceId: helper.deviceId,
  displayId: String(display),
  allowView: true,
  allowControl: true,
});
const agent = service.registerSession(pair.token, {
  protocolVersion: 2,
  adapter: "codex",
  adapterVersion: "isolated-production-rehearsal",
  projectRoot: "/synthetic",
  externalSessionId: "synthetic-walkthrough",
  hostId: "synthetic",
  capabilities: {
    cooperativePause: true,
    polling: true,
    screenCameraVersion: 1,
    livePresentationVersion: 1,
    nativeActivationVersion: 1,
    nativeControl: "desktop",
    sharedSurface: true,
  },
  screenCamera: {
    version: 1,
    surface: { kind: "display", id: String(display), displayId: display },
  },
});
const request = service.requestAttention(agent.token, {
  taskId: "synthetic",
  idempotencyKey: "synthetic",
  reason: "review",
  question: "Isolated no-call walkthrough",
  timeoutSeconds: 900,
});

async function diagnostic<T>(work: () => Promise<T>) {
  try {
    return { ok: true as const, value: await work() };
  } catch (error) {
    return {
      ok: false as const,
      error: "diagnostic_unavailable",
      httpStatus: error instanceof ApiError ? error.status : null,
    };
  }
}
function strictLoopback(value: unknown) {
  if (typeof value !== "string")
    throw new Error("Isolated loopback origin required.");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  )
    throw new Error("Isolated loopback origin required.");
  return url;
}
strictLoopback(`http://127.0.0.1:${helper.port}`);
let server: ReturnType<typeof serve> | undefined;
let python: ChildProcessWithoutNullStreams | undefined;
let childExited: Promise<void> | undefined;
let walkthrough: ProductionWalkthroughController | undefined;
let trigger:
  Awaited<ReturnType<typeof startProductionNativeTrigger>> | undefined;
let input: ReturnType<typeof createInterface> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let pendingTick: Promise<unknown> = Promise.resolve();
let tickRunning = false;
let closing: Promise<void> | undefined;
async function bounded(promise: Promise<unknown>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Harness cleanup did not finish.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function close(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    clearInterval(tick);
    clearTimeout(expiry);
    input?.close();
    walkthrough?.stop();
    store.saveState(`view-stopped:${request.id}`, true);
    const failures: string[] = [];
    try {
      await pendingTick;
    } catch {
      failures.push("viewing_tick");
    }
    try {
      await control.stopPairing(pair.pairing.id);
    } catch {
      failures.push("lease_cleanup");
    }
    try {
      await trigger?.close();
    } catch {
      failures.push("trigger_cleanup");
    }
    if (python && childExited) {
      if (python.exitCode === null && python.signalCode === null)
        python.kill("SIGINT");
      try {
        await bounded(childExited, 5000);
      } catch {
        python.kill("SIGKILL");
        try {
          await bounded(childExited, 5000);
        } catch {
          failures.push("media_process_not_joined");
        }
      }
    }
    if (server?.listening) {
      try {
        await bounded(
          new Promise<void>((done, fail) =>
            server!.close((error) => (error ? fail(error) : done())),
          ),
          5000,
        );
      } catch {
        failures.push("backend_listener_not_joined");
      }
    }
    const unresolvedLeases = store
      .all<ControlLease>("lease")
      .filter((l) => l.state !== "released").length;
    const unresolvedNative = service.nativeReservations
      .all()
      .filter((r) =>
        ["dispatching", "submitted", "uncertain"].includes(r.phase),
      ).length;
    if (!failures.length) store.close();
    console.log(
      JSON.stringify({
        closed: failures.length === 0,
        actorsStopped:
          failures.length === 0 &&
          unresolvedLeases === 0 &&
          unresolvedNative === 0,
        unresolvedLeases,
        unresolvedNative,
        cleanupFailures: failures,
        receiptsRetained: directory,
      }),
    );
    if (failures.length) process.exitCode = 1;
  })();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void close());
try {
  await service.drain();
  service.observeCall(request.id, "connected", true);
  const token = randomBytes(32).toString("hex"),
    port = 3368,
    origin = `http://127.0.0.1:${port}`;
  const app = createApp(service, control, human, {
    origin,
    simulation: true,
    mediaToken: token,
    screenCameraEnabled: true,
    livePresentationEnabled: true,
    nativeActivationEnabled: true,
  });
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  await new Promise<void>((done, fail) => {
    if (server!.listening) return done();
    server!.once("listening", done);
    server!.once("error", fail);
  });
  if (closing) {
    if (server.listening)
      await new Promise<void>((done) => server!.close(() => done()));
    throw new Error("Harness stopped during startup.");
  }
  python = spawn(
    resolve("media/.venv/bin/python"),
    ["media/production_walkthrough_harness.py"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  childExited = new Promise<void>((done) => {
    python!.once("exit", () => done());
    python!.once("error", () => done());
  });
  python.stdin.on("error", () => {});
  python.stderr.on("data", () => {}); // No private exception text or frame payloads in logs.
  const output = createInterface({ input: python.stdout });
  const started = new Promise<any>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error("Isolated media startup timed out.")),
      15000,
    );
    const failed = () => {
      clearTimeout(timer);
      fail(new Error("Isolated media exited before startup."));
    };
    python!.once("error", failed);
    python!.once("exit", failed);
    output.once("line", (line) => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(line);
        if (!info.origin || info.syntheticAuthority !== true)
          throw new Error("No isolated startup handshake.");
        done(info);
      } catch {
        fail(new Error("Invalid isolated handshake."));
      }
    });
  });
  python.stdin.end(
    JSON.stringify({
      directory,
      token,
      helperOrigin: `http://127.0.0.1:${helper.port}`,
      helperKey: helper.secret,
      deviceId: helper.deviceId,
      sessionId: mediaSessionId(request.id),
      callId: service.status(agent.token, request.id).callId,
      backendOrigin: origin,
    }) + "\n",
  );
  const media = await started;
  if (closing) throw new Error("Harness stopped during startup.");
  strictLoopback(media.origin);
  const preview = new URL(media.previewUrl);
  if (
    preview.origin !== media.origin ||
    preview.pathname !== "/" ||
    preview.search ||
    preview.username ||
    preview.password
  )
    throw new Error("Invalid isolated preview origin.");
  remote = new MediaDevicePort(media.origin, token);
  const viewing = new Viewing(store, device, Date.now, false, true);
  const client = new ClawdTimeClient(origin, agent.token);
  walkthrough = new ProductionWalkthroughController({
    client,
    requestId: request.id,
    sessionId: agent.session.id,
    plan,
    backgroundActorsStopped: () => true,
  });
  trigger = await startProductionNativeTrigger(walkthrough);
  if (closing) {
    await trigger.close();
    throw new Error("Harness stopped during startup.");
  }
  const info = join(directory, "local-access.json");
  writeFileSync(
    info,
    JSON.stringify({
      syntheticAuthority: true,
      triggerUrl: trigger.url,
      previewUrl: media.previewUrl,
      requestId: request.id,
      origin,
      sessionToken: agent.token,
    }),
    { mode: 0o600 },
  );
  tick = setInterval(() => {
    if (closing || tickRunning) return;
    tickRunning = true;
    pendingTick = (async () => {
      service.heartbeat(agent.token);
      await viewing.tick();
    })()
      .catch(() => {
        void close();
      })
      .finally(() => {
        tickRunning = false;
      });
  }, 500);
  expiry = setTimeout(() => void close(), 900000);
  input = createInterface({ input: process.stdin });
  pendingTick = viewing.tick();
  await pendingTick;
  if (closing) throw new Error("Harness stopped during startup.");
  console.log(
    JSON.stringify({ ready: true, syntheticAuthority: true, accessFile: info }),
  );
  for await (const line of input) {
    try {
      const cmd = JSON.parse(line);
      if (cmd.op === "prepare")
        console.log(
          JSON.stringify(
            await walkthrough.prepare(cmd.sceneId, cmd.operationId, cmd.action),
          ),
        );
      else if (cmd.op === "status") {
        const [owner, camera, mediaDiagnostics] = await Promise.all([
          diagnostic(() => client.conversationExecution(request.id)),
          diagnostic(() => client.screenCamera(request.id)),
          diagnostic(async () => {
            const response = await fetch(
              `${media.origin}/sessions/${mediaSessionId(request.id)}/screen/diagnostics`,
              {
                headers: { Authorization: `Bearer ${token}` },
                redirect: "error",
                signal: AbortSignal.timeout(4000),
              },
            );
            if (!response.ok)
              throw new ApiError(
                response.status,
                "Harness diagnostics unavailable.",
              );
            return response.json();
          }),
        ]);
        console.log(
          JSON.stringify({
            walkthrough: walkthrough.status(),
            owner,
            camera,
            mediaDiagnostics,
            backend: {
              ownership: store.get("execution", request.id) ?? null,
              native: service.nativeReservations.all(request.id),
              presentation: store
                .all<Record<string, unknown>>("live-presentation")
                .filter((record) => record.requestId === request.id)
                .map(
                  ({
                    id,
                    commandId,
                    planId,
                    sceneId,
                    generation,
                    phase,
                    fingerprint,
                    createdAt,
                    result,
                  }) => ({
                    id,
                    commandId,
                    planId,
                    sceneId,
                    generation,
                    phase,
                    fingerprint,
                    createdAt,
                    result:
                      result && typeof result === "object"
                        ? {
                            state: (result as Record<string, unknown>).state,
                            reason: (result as Record<string, unknown>).reason,
                            receiptId: (result as Record<string, unknown>)
                              .receiptId,
                          }
                        : null,
                  }),
                ),
              leases: store
                .all<ControlLease>("lease")
                .filter((lease) => lease.requestId === request.id)
                .map(
                  ({
                    id,
                    state,
                    mode,
                    executor,
                    executorEpoch,
                    policyRevision,
                    epoch,
                    expiresAt,
                  }) => ({
                    id,
                    state,
                    mode,
                    executor,
                    executorEpoch,
                    policyRevision,
                    epoch,
                    expiresAt,
                  }),
                ),
              viewStopped: store.state(`view-stopped:${request.id}`) === true,
            },
          }),
        );
      } else if (cmd.op === "complete")
        console.log(JSON.stringify(await walkthrough.scenes.complete()));
      else if (cmd.op === "replan")
        console.log(
          JSON.stringify(await walkthrough.replan(cmd.plan, cmd.generation)),
        );
      else if (cmd.op === "claim" || cmd.op === "release") {
        const owner: any = await client.conversationExecution(request.id);
        console.log(
          JSON.stringify(
            await client.conversationOperation(request.id, "execution", {
              expectedEpoch: owner.epoch,
              executor: cmd.op === "claim" ? "native" : "none",
              previousOutcome: cmd.op === "claim" ? "idle" : "completed",
              backgroundActorsStopped: true,
              expectedCursor: owner.cursor,
            }),
          ),
        );
      } else if (cmd.op === "stop") {
        await close();
        break;
      } else throw new Error("Unknown harness command.");
    } catch (error) {
      console.log(
        JSON.stringify({
          error:
            error instanceof Error ? error.message : "harness_command_failed",
        }),
      );
    }
  }
} finally {
  await close();
}
