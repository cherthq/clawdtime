import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { z } from "zod";
import { hash } from "../storage/security.js";
import { readDesktopPrivateJSON } from "./task-desktop-config.js";
import { NativeTaskAudioCalls } from "../transport/task-audio.js";
import {
  ProactiveTransport,
  type ProactiveLineOwnerPort,
} from "./proactive-transport.js";
import type { ProactiveCallCoordinator } from "../attention/proactive-coordinator.js";
import type { ProactiveLineSessions } from "./proactive-line.js";
import type { ProactiveCallIntent } from "../attention/proactive-contracts.js";
import type { ProactiveReviewPacket } from "./proactive-preparation.js";
import type { RetainedOwnerConfig } from "../../line/proactive-owner.mjs";
import type {
  ProactiveMediaConfig,
  ProactiveMediaPorts,
  ProactiveOutboundMedia,
} from "../../line/proactive-outbound.mjs";

const path = z.string().startsWith("/").max(4096),
  identity = z.string().min(1).max(300),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export const proactiveProductionConfigSchema = z
  .object({
    version: z.literal(1),
    nodeBinary: path,
    lineDirectory: path,
    lineEnvironmentFile: path,
    providerConfigFile: path,
    connectorCredentialFile: path,
    attemptDirectory: path,
    workerPort: z.number().int().min(1024).max(65535),
    destination: z
      .object({
        personId: identity,
        deviceId: identity,
        projectRoot: path,
        lineId: z.string().uuid(),
        recipientHash: digest,
      })
      .strict(),
    owner: z
      .object({
        hostScript: path,
        hostStateDirectory: path,
        hostSession: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        agentName: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
        retentionConfigFile: path,
        providerStateDirectory: path,
        initialJournal: path,
        stateFile: path,
      })
      .strict(),
  })
  .strict();
export type ProactiveProductionConfig = z.infer<
  typeof proactiveProductionConfigSchema
>;
const nativeSchema = z
  .object({
    callsOrigin: z.string().url(),
    projectId: z.string().uuid(),
    projectKey: z.string().min(16).max(8192),
    recipient: z.string().regex(/^\+[1-9]\d{7,14}$/),
    lineId: z.string().uuid(),
  })
  .strict();
const safeSettings = [
  "CLAWDTIME_LINE_VOICE",
  "CLAWDTIME_LINE_BARGE_IN",
  "CLAWDTIME_LINE_FRAMING",
  "CLAWDTIME_LINE_GREET_ON",
  "CLAWDTIME_LINE_MASCOT",
  "CLAWDTIME_LINE_VIDEO_FPS",
  "CLAWDTIME_LINE_REDUCED_MOTION",
];

export interface ProductionWorker {
  pid: number;
  alive(): boolean;
  stop(): Promise<{ joined: boolean }>;
}
export interface ProductionDeliveryDependencies {
  loadOwner?(config: RetainedOwnerConfig): Promise<ProactiveLineOwnerPort>;
  loadMedia?(): Promise<
    (
      config: ProactiveMediaConfig,
      ports: ProactiveMediaPorts,
    ) => Promise<ProactiveOutboundMedia>
  >;
  launchWorker?(input: {
    nodeBinary: string;
    program: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<ProductionWorker>;
  request?: typeof fetch;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
}
export interface ProductionDeliveryContext {
  projectRoot: string;
  origin: string;
  coordinator: ProactiveCallCoordinator;
  sessions: ProactiveLineSessions;
  packet(intentId: string): ProactiveReviewPacket | undefined;
  current(intent: ProactiveCallIntent): boolean;
  sourceFingerprint(intent: ProactiveCallIntent): string;
  freshFrame?(
    intent: ProactiveCallIntent,
  ): Promise<{ capturedAt: number; sourceFingerprint: string } | null>;
  cleanupViews(intentId: string): Promise<{ confirmed: boolean }>;
}
function protectedFile(file: string, executable = false) {
  const stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022 ||
    (executable && !(stat.mode & 0o100))
  )
    throw Error("production_protected_source_required");
}
function privateDirectory(directory: string) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw Error("production_private_directory_required");
}
function environmentFile(file: string) {
  const parent = lstatSync(dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o022
  )
    throw Error("production_environment_parent_invalid");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 65536
    )
      throw Error("production_environment_private_required");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size)
      throw Error("production_environment_changed");
    return parseEnv(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
async function launchWorker(
  input: Parameters<
    NonNullable<ProductionDeliveryDependencies["launchWorker"]>
  >[0],
): Promise<ProductionWorker> {
  const child = spawn(input.nodeBinary, [input.program, "start"], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let joined = false;
  const exit = new Promise<void>((resolve) => {
    child.once("close", () => {
      joined = true;
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(Error("production_worker_spawn_unknown")));
  });
  if (!child.pid) throw Error("production_worker_identity_missing");
  let stopFlight: Promise<{ joined: boolean }> | undefined;
  return {
    pid: child.pid,
    alive: () =>
      !joined && child.exitCode === null && child.signalCode === null,
    stop() {
      if (stopFlight) return stopFlight;
      stopFlight = (async () => {
        if (joined) return { joined: true };
        child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exit,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 15000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        return { joined };
      })();
      return stopFlight;
    },
  };
}

/** Loads protected current credentials in place. Construction/probe never captures,
 * spawns a worker, allocates a room, changes ownership or places a call. */
export function createProductionDelivery(
  configurationFile: string,
  context: ProductionDeliveryContext,
  dependencies: ProductionDeliveryDependencies = {},
) {
  const config = proactiveProductionConfigSchema.parse(
    readDesktopPrivateJSON(configurationFile),
  );
  const project = realpathSync(context.projectRoot),
    now = dependencies.now ?? Date.now;
  if (realpathSync(config.destination.projectRoot) !== project)
    throw Error("production_project_scope_mismatch");
  const outside = (candidate: string) => {
    const target = realpathSync(candidate),
      part = relative(project, target);
    if (
      !part ||
      (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part))
    )
      throw Error("production_configuration_inside_worker_project");
  };
  for (const file of [
    configurationFile,
    config.nodeBinary,
    config.lineDirectory,
    config.lineEnvironmentFile,
    config.providerConfigFile,
    config.connectorCredentialFile,
    config.attemptDirectory,
    ...Object.entries(config.owner)
      .filter(
        ([key]) => !["hostSession", "agentName", "stateFile"].includes(key),
      )
      .map(([, value]) => value),
  ])
    outside(file);
  outside(dirname(config.owner.stateFile));
  protectedFile(config.nodeBinary, true);
  protectedFile(config.owner.hostScript, true);
  privateDirectory(config.attemptDirectory);
  const origin = new URL(context.origin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.origin !== context.origin ||
    !origin.port ||
    Number(origin.port) === config.workerPort
  )
    throw Error("production_loopback_origin_invalid");
  const sourceFiles = [
    "package.json",
    "package-lock.json",
    ...readdirSync(config.lineDirectory).filter(
      (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"),
    ),
  ].sort();
  if (
    sourceFiles.length > 256 ||
    !sourceFiles.includes("proactive-agent.mjs") ||
    !sourceFiles.includes("proactive-owner.mjs") ||
    !sourceFiles.includes("proactive-outbound.mjs")
  )
    throw Error("production_source_manifest_invalid");
  const sourceFingerprint = () =>
    hash(
      JSON.stringify(
        sourceFiles.map((name) => {
          const file = join(config.lineDirectory, name);
          protectedFile(file);
          return [name, hash(readFileSync(file, "utf8"))];
        }),
      ),
    );
  const pinnedSource = sourceFingerprint();
  const readNative = () => {
    const file = readDesktopPrivateJSON(config.providerConfigFile) as {
      native?: unknown;
    };
    const native = nativeSchema.parse(file.native ?? file);
    if (
      native.lineId !== config.destination.lineId ||
      hash(native.recipient) !== config.destination.recipientHash
    )
      throw Error("production_destination_binding_mismatch");
    return native;
  };
  const native = readNative();
  const pinnedNative = hash(JSON.stringify(native));
  const readCredentials = () => {
    const saved = readDesktopPrivateJSON(config.connectorCredentialFile) as {
      access_token?: unknown;
      expires_at?: unknown;
    };
    if (
      typeof saved.access_token !== "string" ||
      saved.access_token.length < 16 ||
      typeof saved.expires_at !== "number" ||
      saved.expires_at <= now()
    )
      throw Error("production_connector_credential_expired");
    return saved.access_token;
  };
  const readEnvironment = () => {
    const env = environmentFile(config.lineEnvironmentFile);
    if (
      !/^wss:\/\//.test(env.LIVEKIT_URL ?? "") ||
      !env.LIVEKIT_API_KEY ||
      !env.LIVEKIT_API_SECRET ||
      !env.OPENAI_API_KEY
    )
      throw Error("production_media_configuration_incomplete");
    return env;
  };
  const pinnedEnvironment = hash(JSON.stringify(readEnvironment()));
  const pinnedConfiguration = hash(JSON.stringify(config));
  const pinnedHost = hash(readFileSync(config.owner.hostScript, "utf8"));
  const assertConfiguration = () => {
    protectedFile(config.owner.hostScript, true);
    if (
      sourceFingerprint() !== pinnedSource ||
      hash(JSON.stringify(readNative())) !== pinnedNative ||
      hash(
        JSON.stringify(
          proactiveProductionConfigSchema.parse(
            readDesktopPrivateJSON(configurationFile),
          ),
        ),
      ) !== pinnedConfiguration ||
      hash(JSON.stringify(readEnvironment())) !== pinnedEnvironment ||
      hash(readFileSync(config.owner.hostScript, "utf8")) !== pinnedHost
    )
      throw Error("production_source_changed");
  };
  readCredentials();
  const stoppedAttempts = new Set<string>();
  let initialized:
    | Promise<{ owner: ProactiveLineOwnerPort; transport: ProactiveTransport }>
    | undefined;
  let last: { ready: boolean; reason?: string; checkedAt: number } = {
    ready: false,
    reason: "awaiting_probe",
    checkedAt: 0,
  };
  const initialize = () =>
    (initialized ??= (async () => {
      const ownerConfig: RetainedOwnerConfig = {
        ...config.owner,
        lineEnvironmentFile: config.lineEnvironmentFile,
        ...native,
        connectorToken: readCredentials(),
        getConnectorToken: readCredentials,
        assertConfiguration,
      };
      const owner = dependencies.loadOwner
        ? await dependencies.loadOwner(ownerConfig)
        : new (
            await import(
              pathToFileURL(join(config.lineDirectory, "proactive-owner.mjs"))
                .href
            )
          ).RetainedProactiveLineOwner(ownerConfig);
      const factory = dependencies.loadMedia
        ? await dependencies.loadMedia()
        : ((
            await import(
              pathToFileURL(
                join(config.lineDirectory, "proactive-outbound.mjs"),
              ).href
            )
          ).createProactiveOutboundMedia as (
            config: ProactiveMediaConfig,
            ports: ProactiveMediaPorts,
          ) => Promise<ProactiveOutboundMedia>);
      const calls = new NativeTaskAudioCalls(native, dependencies.request);
      const transport = new ProactiveTransport({
        ...context,
        line: owner,
        calls,
        destination: config.destination,
        now: dependencies.now,
        pause: dependencies.pause,
        media: async ({ config: attempt, agentName }) => {
          assertConfiguration();
          const intent = context.coordinator
            .list()
            .find((value) => value.attemptId === attempt.attemptId);
          const grant = intent?.grantId
            ? context.coordinator.authority.grant(intent.grantId)
            : undefined;
          if (
            !intent ||
            !grant ||
            !context.coordinator.authority.validateGrant(grant)
          )
            throw Error("production_attempt_authority_unavailable");
          const authorize = async () => {
            if (
              stoppedAttempts.has(attempt.attemptId) ||
              !context.coordinator.authority.validateGrant(grant) ||
              !["dispatching", "connected"].includes(
                context.coordinator.get(intent.id).state,
              )
            )
              throw Error("production_attempt_authority_ended");
          };
          const directory = join(config.attemptDirectory, attempt.attemptId);
          mkdirSync(directory, { mode: 0o700 });
          privateDirectory(directory);
          const runtimePath = join(directory, "runtime.json");
          writeFileSync(
            runtimePath,
            JSON.stringify({ ...attempt, origin: context.origin }),
            { flag: "wx", mode: 0o600 },
          );
          const env = readEnvironment(),
            journal = context.coordinator.transport;
          const room = await factory(
            {
              url: env.LIVEKIT_URL!,
              apiKey: env.LIVEKIT_API_KEY!,
              apiSecret: env.LIVEKIT_API_SECRET!,
              agentName,
              roomName: attempt.roomName,
              agentIdentity: attempt.agentIdentity,
              providerCallerIdentity: attempt.providerCallerIdentity,
              attemptId: attempt.attemptId,
              expiresAt: attempt.expiresAt,
            },
            {
              authorize,
              clock: now,
              sleep: dependencies.pause,
              reserveEffect: async (stage) =>
                journal.reserve(intent.id, attempt.attemptId, stage),
              recordEffect: async (stage, outcome) =>
                outcome === "unknown"
                  ? journal.unknown(attempt.attemptId, stage)
                  : journal.settle(attempt.attemptId, stage, {
                      evidence: `${stage}_confirmed`,
                    }),
            },
          );
          let worker: ProductionWorker | undefined,
            workerStarted = false,
            prepareFlight:
              | Promise<{
                  credentials: Awaited<
                    ReturnType<ProactiveOutboundMedia["prepare"]>
                  >["credentials"];
                }>
              | undefined,
            closeFlight: Promise<{ closed: boolean }> | undefined;
          const processEnv: NodeJS.ProcessEnv = {};
          for (const name of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"])
            if (process.env[name]) processEnv[name] = process.env[name];
          for (const name of [
            "LIVEKIT_URL",
            "LIVEKIT_API_KEY",
            "LIVEKIT_API_SECRET",
            "OPENAI_API_KEY",
            ...safeSettings,
          ])
            if (env[name]) processEnv[name] = env[name];
          Object.assign(processEnv, {
            AGENT_NAME: agentName,
            CLAWDTIME_LINE_PORT: String(config.workerPort),
            CLAWDTIME_PROACTIVE_CONFIG: runtimePath,
          });
          return {
            prepare() {
              return (prepareFlight ??= (async () => {
                await authorize();
                journal.reserve(intent.id, attempt.attemptId, "worker_start");
                workerStarted = true;
                try {
                  worker = await (dependencies.launchWorker ?? launchWorker)({
                    nodeBinary: config.nodeBinary,
                    program: join(config.lineDirectory, "proactive-agent.mjs"),
                    cwd: config.lineDirectory,
                    env: processEnv,
                  });
                  if (
                    !Number.isSafeInteger(worker.pid) ||
                    worker.pid <= 0 ||
                    !worker.alive()
                  )
                    throw Error("production_worker_start_unconfirmed");
                  journal.settle(attempt.attemptId, "worker_start", {
                    evidence: `worker_pid_${worker.pid}`,
                  });
                  writeFileSync(
                    join(directory, "worker-receipt.json"),
                    JSON.stringify({
                      version: 1,
                      attemptId: attempt.attemptId,
                      pid: worker.pid,
                      sourceFingerprint: pinnedSource,
                      at: now(),
                    }),
                    { flag: "wx", mode: 0o600 },
                  );
                } catch (error) {
                  journal.unknown(attempt.attemptId, "worker_start");
                  throw error;
                }
                await authorize();
                return room.prepare();
              })());
            },
            async inspect() {
              assertConfiguration();
              if (!worker?.alive()) return { ready: false };
              const rows = await room.inspect();
              const agent = rows.filter(
                (row) => row.identity === attempt.agentIdentity,
              );
              if (
                !worker.alive() ||
                rows.length > 2 ||
                agent.length !== 1 ||
                rows.some(
                  (row) =>
                    ![
                      attempt.agentIdentity,
                      attempt.providerCallerIdentity,
                    ].includes(row.identity),
                )
              )
                return { ready: false };
              const audio =
                  agent[0].tracks?.filter(
                    (track: { type: number }) => track.type === 0,
                  ) ?? [],
                video =
                  agent[0].tracks?.filter(
                    (track: { type: number }) => track.type === 1,
                  ) ?? [];
              return {
                ready:
                  audio.length === 1 &&
                  video.length === 1 &&
                  audio[0].muted === false &&
                  video[0].muted === false,
              };
            },
            close() {
              return (closeFlight ??= (async () => {
                await prepareFlight?.catch(() => {});
                const closed = await room
                  .close()
                  .catch(() => ({ closed: false }));
                let joined = !workerStarted;
                if (worker) {
                  journal.reserve(intent.id, attempt.attemptId, "worker_stop");
                  try {
                    joined = (await worker.stop()).joined;
                    if (!joined) throw Error("production_worker_join_unknown");
                    journal.settle(attempt.attemptId, "worker_stop", {
                      evidence: "worker_join_confirmed",
                    });
                    if (
                      journal.get(attempt.attemptId, "worker_start")?.state ===
                      "unknown"
                    )
                      journal.settle(attempt.attemptId, "worker_start", {
                        evidence: "worker_join_reconciled",
                      });
                  } catch {
                    journal.unknown(attempt.attemptId, "worker_stop");
                    joined = false;
                  }
                }
                if (closed.closed && joined) {
                  unlinkSync(runtimePath);
                  return { closed: true };
                }
                return { closed: false };
              })());
            },
          };
        },
      });
      return { owner, transport };
    })());
  const probe = async () => {
    try {
      assertConfiguration();
      readEnvironment();
      readCredentials();
      readNative();
      const { owner } = await initialize();
      const result = await owner.readiness();
      last = { ...result, checkedAt: now() };
    } catch (error) {
      last = {
        ready: false,
        reason:
          error instanceof Error && /^production_[a-z_]+$/.test(error.message)
            ? error.message
            : "production_readiness_unavailable",
        checkedAt: now(),
      };
    }
    return { ...last };
  };
  return {
    probe,
    diagnostics: () => ({
      ...last,
      configured: true,
      sourceFingerprint: pinnedSource,
      physicalAcceptance: false,
    }),
    async readiness(intent: ProactiveCallIntent) {
      const result = await probe();
      if (!result.ready) return result;
      const { transport } = await initialize();
      return transport.readiness(intent);
    },
    async deliver(
      intent: ProactiveCallIntent,
      grant: Parameters<ProactiveTransport["deliver"]>[1],
    ) {
      assertConfiguration();
      return (await initialize()).transport.deliver(intent, grant);
    },
    async stop(intent: ProactiveCallIntent) {
      if (intent.attemptId) stoppedAttempts.add(intent.attemptId);
      if (initialized) await (await initialized).transport.stop(intent);
    },
  };
}
