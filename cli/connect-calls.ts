/**
 * The calling side of `clawdtime connect`: the owner's calling policy in the
 * desktop service, and the outbound line that the reach calls through.
 *
 * The policy is a version-2 policy with the owner's own yes. It lets the reach
 * of the computer worker call about its questions in the selected project, and
 * nothing else: no coding session, no task, no view of the screen. It is kept
 * in `proactive.json` of the desktop service, which registers it when it
 * starts, and it is also sent once to a running service through the operator
 * route of `clawdtime proactive policy`.
 *
 * The outbound line is the `chert-dev-retained-v1` provider. Its configuration
 * file is made from what this Mac already has: the line agent, its private
 * `.env.local`, the sign-in of the chert command, the project API key, the
 * owner's number and the line of the project. `proactive.json` names it only
 * after the provider's own checks accept it, so the desktop service never
 * starts with a configuration that it refuses. No check of the provider is
 * changed or skipped here.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  accessSync,
  type Stats,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";
import { proactiveConfigSchema } from "../src/control/proactive-setup.js";
import {
  proactivePolicySchema,
  type ProactivePolicyInput,
} from "../src/attention/proactive-policy.js";
import { reachSession } from "../connectors/computer/reach.js";
import {
  createProductionDelivery,
  proactiveProductionConfigSchema,
  type ProactiveProductionConfig,
  type ProductionDeliveryContext,
} from "../src/control/proactive-production.js";
import { readDesktopPrivateJSON } from "../src/control/task-desktop-config.js";
import { hash } from "../src/storage/security.js";
import { findDesktopService } from "../connectors/agents/desktop-chat.js";
import {
  folderProblem,
  privateFolder,
  readPrivateJSON,
  writePrivateJSON,
} from "../connectors/shared/private-file.js";
import { proactiveCli } from "./proactive.js";

export const ownerPerson = "clawdtime-owner";
export const ownerDevice = "this-mac";
export const policyPrefix = "clawdtime-connect-";
export const consentQuestion =
  "May ClawdTime call and text this number when it needs you?";
const day = 86_400_000;
export const policyLifetimeMs = 30 * day;

export type ProactiveConfig = z.infer<typeof proactiveConfigSchema>;
export interface DesktopDescriptor {
  projectRoot: string;
  origin: string;
}

/** The executable of that name on the PATH of this environment, or null. */
export function findOnPath(
  name: string,
  env: Record<string, string | undefined>,
): string | null {
  for (const folder of (env.PATH ?? "").split(delimiter)) {
    if (!folder || !isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** What the desktop service wrote about itself: its project and its address. */
export function desktopDescriptor(folder: string): DesktopDescriptor | null {
  try {
    const value = z
      .object({
        origin: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/),
        projectRoot: z.string().startsWith("/").max(4096),
      })
      .passthrough()
      .parse(readDesktopPrivateJSON(join(folder, "desktop-service.json")));
    return { origin: value.origin, projectRoot: value.projectRoot };
  } catch {
    return null;
  }
}

const there = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export const proactiveFile = (folder: string) => join(folder, "proactive.json");

/** proactive.json of the desktop service: the default when it is not there. */
export function readProactiveConfig(
  folder: string,
): { config: ProactiveConfig; exists: boolean } | { problem: string } {
  const file = proactiveFile(folder);
  if (!there(file))
    return {
      config: proactiveConfigSchema.parse({ version: 2 }),
      exists: false,
    };
  try {
    return {
      config: proactiveConfigSchema.parse(readDesktopPrivateJSON(file)),
      exists: true,
    };
  } catch {
    return {
      problem: `${file} cannot be used: it is not an owner-only file of this user, or not a valid configuration. clawdtime connect does not change it. Look at it first`,
    };
  }
}
export function writeProactiveConfig(folder: string, config: ProactiveConfig) {
  writePrivateJSON(proactiveFile(folder), proactiveConfigSchema.parse(config));
}

/** A policy that the reach would use for a question of the computer worker in this project. */
export const fitsReach = (
  policy: ProactivePolicyInput,
  projectRoot: string,
): boolean =>
  policy.scope.projectRoot === projectRoot &&
  (!policy.scope.sessionId || policy.scope.sessionId === reachSession) &&
  !policy.scope.taskId &&
  policy.triggers.includes("decision") &&
  policy.channels.includes("phone_alert");

/** The policy that the owner's yes makes: calls about questions of the computer worker only. */
export function connectPolicy(input: {
  projectRoot: string;
  consentAt: number;
  now: number;
  id?: string;
}): ProactivePolicyInput {
  return proactivePolicySchema.parse({
    version: 2,
    id: input.id ?? `${policyPrefix}${randomUUID()}`,
    scope: {
      personId: ownerPerson,
      deviceId: ownerDevice,
      projectRoot: input.projectRoot,
      sessionId: reachSession,
    },
    triggers: ["decision", "failure"],
    channels: ["phone_alert"],
    expiresAt: input.now + policyLifetimeMs,
    maxAttempts: 100,
    minIntervalMs: 60_000,
    attemptLifetimeMs: 300_000,
    viewScope: [],
    alertFallback: false,
    consent: {
      actorId: ownerPerson,
      recordedAt: Math.min(input.consentAt, input.now),
      source: "human_request",
      statement: `The owner typed yes in clawdtime connect to: ${consentQuestion}`,
    },
  });
}

export type Submitted =
  | "active"
  | "no_service"
  | "revoked"
  | "unknown_policy"
  | "refused"
  | "unreachable";
/**
 * Sends one policy, or the revocation of one, to the running desktop service
 * through `clawdtime proactive`. It is sent once; a lost answer is not sent
 * again. "no_service": no desktop service runs with this state folder.
 * "revoked": the service has that policy, taken back (or another one by that
 * name). "unknown_policy": the service never registered that policy.
 */
export async function sendToService(
  folder: string,
  action: { kind: "policy"; file: string } | { kind: "revoke"; id: string },
  request?: typeof fetch,
): Promise<Submitted> {
  const service = findDesktopService(folder);
  if (!service) return "no_service";
  const send = async (args: string[]) => {
    try {
      await proactiveCli(
        [
          ...args,
          "--origin",
          service.origin,
          "--operator-file",
          join(folder, "operator.json"),
        ],
        { ...(request ? { request } : {}), print: () => {} },
      );
      return null;
    } catch (error) {
      return (
        /HTTP ([0-9]{3})/.exec(
          error instanceof Error ? error.message : "",
        )?.[1] ?? "lost"
      );
    }
  };
  const status = await send(
    action.kind === "policy"
      ? ["policy", "--file", action.file]
      : ["revoke", "--id", action.id],
  );
  if (status === null) return "active";
  if (status === "409") return "revoked";
  // A 404 is an unknown policy only when the operator routes are there.
  if (status === "404" && action.kind === "revoke")
    return (await send(["intents"])) === null ? "unknown_policy" : "refused";
  return status === "lost" ? "unreachable" : "refused";
}

// ---------------------------------------------------------------------------
// The outbound line.

export interface RetentionChecks {
  pin: { version: string; nodeVersion: string };
  /** True when the provider package in this folder is the pinned build. */
  provider(root: string): boolean;
  /** True when this node executable is the pinned build. */
  node(file: string): boolean;
}
/** The pinned checks of the line's own retention guard, read from the line agent. */
export async function retentionChecks(
  lineDirectory: string,
): Promise<RetentionChecks | null> {
  // The guard is code of this checkout: it runs only as a protected file of this user.
  if (!protectedFile(join(lineDirectory, "provider-retention.mjs")))
    return null;
  try {
    const guard = (await import(
      pathToFileURL(join(lineDirectory, "provider-retention.mjs")).href
    )) as typeof import("../line/provider-retention.mjs");
    return {
      pin: {
        version: guard.RETENTION_PIN.version,
        nodeVersion: guard.RETENTION_PIN.nodeVersion,
      },
      provider(root) {
        try {
          guard.inspectPinnedProvider(root);
          return true;
        } catch {
          return false;
        }
      },
      node(file) {
        try {
          return (
            guard.sha256(readFileSync(file)) === guard.RETENTION_PIN.nodeSha256
          );
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}

/** The folder of the installed chert package, found from the chert command or beside node. */
export function providerPackage(
  env: Record<string, string | undefined>,
): { root: string; version: string | null } | null {
  const starts: string[] = [];
  const chert = findOnPath("chert", env);
  if (chert)
    try {
      starts.push(dirname(realpathSync(chert)));
    } catch {
      // A link that leads nowhere.
    }
  const node = findOnPath("node", env);
  if (node)
    starts.push(
      join(
        dirname(dirname(node)),
        "lib",
        "node_modules",
        "@trychert",
        "facetime",
      ),
    );
  for (const start of starts) {
    let folder = start;
    for (let depth = 0; depth < 8; depth++) {
      try {
        const value = JSON.parse(
          readFileSync(join(folder, "package.json"), "utf8"),
        ) as { name?: unknown; version?: unknown };
        if (value.name === "@trychert/facetime")
          return {
            root: realpathSync(folder),
            version:
              typeof value.version === "string" &&
              /^[0-9A-Za-z.+-]{1,40}$/.test(value.version)
                ? value.version
                : null,
          };
      } catch {
        // No package here.
      }
      const up = dirname(folder);
      if (up === folder) break;
      folder = up;
    }
  }
  return null;
}

const mine = (stat: Stats) =>
  process.getuid === undefined || stat.uid === process.getuid();
/** A regular file of this user that only its owner can change (and run, when asked). */
export function protectedFile(file: string, executable = false) {
  try {
    const stat = lstatSync(file);
    return (
      stat.isFile() &&
      mine(stat) &&
      (stat.mode & 0o022) === 0 &&
      (!executable || (stat.mode & 0o100) !== 0)
    );
  } catch {
    return false;
  }
}
/** "ok", "missing", or "open": a file that is not an owner-only regular file. It is never read. */
function privateFileState(
  file: string,
  folder: "private" | "owner-writable" = "private",
): "ok" | "missing" | "open" {
  try {
    const stat = lstatSync(file);
    if (folderProblem(dirname(file), folder) !== null) return "open";
    return stat.isFile() &&
      mine(stat) &&
      (stat.mode & 0o077) === 0 &&
      stat.nlink === 1
      ? "ok"
      : "open";
  } catch {
    return "missing";
  }
}
const inside = (projectRoot: string, path: string) => {
  try {
    const part = relative(realpathSync(projectRoot), realpathSync(path));
    return (
      !part ||
      (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
    );
  } catch {
    return false;
  }
};

/** The last part of a private log, read with no link followed. */
function readTail(file: string, largest = 1_048_576): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !mine(stat) || stat.mode & 0o077) return null;
    const length = Math.min(stat.size, largest);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, stat.size - length);
    return bytes.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
/** The provider state folder of the newest claim of the line, from its records. */
function newestClaim(hostState: string): string | null {
  const text = readTail(join(hostState, "dev.jsonl"));
  if (!text) return null;
  let found: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"dev_ready"')) continue;
    try {
      const record = JSON.parse(line) as {
        code?: unknown;
        state_dir?: unknown;
      };
      if (
        record.code === "dev_ready" &&
        typeof record.state_dir === "string" &&
        isAbsolute(record.state_dir)
      )
        found = record.state_dir;
    } catch {
      // A record that was cut.
    }
  }
  return found;
}

const placeholder = (value: string | undefined) =>
  !value?.trim() || /^(wss:\/\/)?YOUR_/.test(value.trim());

/** The line of the project, read once with the project API key. It writes nothing. */
export async function projectLine(input: {
  origin: string;
  projectId: string;
  apiKey: string;
  request: typeof fetch;
}): Promise<{ lineId: string } | { reason: string }> {
  try {
    const response = await input.request(
      `${input.origin}/api/v1/lines?limit=100&offset=0`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "X-Chert-Project-Id": input.projectId,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 401 || response.status === 403)
      return {
        reason:
          "the project API key may not read the lines of the project. Make a key with read and write access (step 8)",
      };
    if (!response.ok)
      return { reason: "the lines of the project could not be read now" };
    const body = (await response.json()) as {
      data?: { items?: { id?: unknown }[] };
    };
    const items = Array.isArray(body?.data?.items) ? body.data.items : null;
    if (!items)
      return { reason: "the lines of the project could not be read now" };
    const ids = items
      .map((item) => item?.id)
      .filter(
        (id): id is string =>
          typeof id === "string" && z.string().uuid().safeParse(id).success,
      );
    if (ids.length !== 1 || items.length !== 1)
      return {
        reason: `the project has ${items.length} lines; calls to you need a project with one line`,
      };
    return { lineId: ids[0]! };
  } catch {
    return { reason: "the lines of the project could not be read now" };
  }
}

export interface OutboundInput {
  check: boolean;
  env: Record<string, string | undefined>;
  home: string;
  request: typeof fetch;
  desktopFolder: string;
  desktop: DesktopDescriptor;
  projectId: string;
  apiKey: string;
  phone: string;
  lineDirectory: string;
  chertHome: string;
  nodeBinary: string;
  retention: RetentionChecks | null;
}
export interface OutboundResult {
  ready: boolean;
  /** proactive.json changed: the desktop service reads it when it starts. */
  changed: boolean;
  text: string;
}

export const outboundFolder = (desktopFolder: string) =>
  join(desktopFolder, "outbound");

/**
 * Makes the configuration of the outbound line from what this Mac has, and
 * points proactive.json at it once the provider accepts it. Each value that
 * cannot be derived is named with the one command that finishes it.
 */
export async function setUpOutbound(
  input: OutboundInput,
): Promise<OutboundResult> {
  const folder = outboundFolder(input.desktopFolder);
  const files = {
    configuration: join(folder, "configuration.json"),
    native: join(folder, "native.json"),
    retention: join(folder, "retention.json"),
    attempts: join(folder, "attempts"),
    receipts: join(folder, "retention-receipts"),
    ownerState: join(folder, "owner-state.json"),
  };
  const missing: string[] = [];
  const done = (text: string, changed = false): OutboundResult => ({
    ready: true,
    changed,
    text,
  });
  const notYet = (): OutboundResult => ({
    ready: false,
    changed: false,
    text: `missing: ${missing.join("; ")}`,
  });

  const read = readProactiveConfig(input.desktopFolder);
  if ("problem" in read)
    return { ready: false, changed: false, text: read.problem };
  const outbound = read.config.outbound;
  if (
    outbound &&
    !(
      outbound.provider === "chert-dev-retained-v1" &&
      outbound.configurationFile === files.configuration
    )
  )
    return {
      ready: false,
      changed: false,
      text: `proactive.json already names another outbound line. clawdtime connect leaves it as it is`,
    };

  const projectRoot = input.desktop.projectRoot;
  const lineDirectory = input.lineDirectory;
  const envFile = join(lineDirectory, ".env.local");
  const hostScript = join(lineDirectory, "host.sh");
  const hostState =
    input.env.CLAWDTIME_LINE_STATE ||
    join(input.home, ".local", "share", "clawdtime", "line");
  const hostSession = input.env.CLAWDTIME_LINE_SESSION || "clawdtime-line";
  const providerState = join(input.chertHome, "dev");
  const credentials = join(input.chertHome, "credentials.json");

  // The line agent and its private settings.
  if (inside(projectRoot, lineDirectory))
    missing.push(
      `the line agent ${lineDirectory} is inside the project of the desktop service; the call path needs it outside`,
    );
  const sources = (() => {
    try {
      return [
        "package.json",
        "package-lock.json",
        ...readdirSync(lineDirectory).filter(
          (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"),
        ),
      ];
    } catch {
      return [];
    }
  })();
  if (
    ![
      "proactive-agent.mjs",
      "proactive-owner.mjs",
      "proactive-outbound.mjs",
    ].every((name) => sources.includes(name)) ||
    !sources.every((name) => protectedFile(join(lineDirectory, name)))
  )
    missing.push(
      `the files of ${lineDirectory} must be files of this user that only you can change. Run: chmod -R go-w ${lineDirectory}`,
    );
  if (!protectedFile(hostScript, true))
    missing.push(
      `${hostScript} must be a program of this user. Run: chmod 755 ${hostScript}`,
    );
  let agentName = "clawdtime";
  {
    const state = privateFileState(envFile, "owner-writable");
    const text = state === "ok" ? readPrivateText(envFile) : null;
    const values = text === null ? null : parseEnv(text);
    if (!values) missing.push(`${envFile} with its keys (step 5)`);
    else {
      if (
        !/^wss:\/\//.test(values.LIVEKIT_URL ?? "") ||
        placeholder(values.LIVEKIT_URL) ||
        placeholder(values.LIVEKIT_API_KEY) ||
        placeholder(values.LIVEKIT_API_SECRET) ||
        placeholder(values.OPENAI_API_KEY)
      )
        missing.push(
          `the LiveKit keys and OPENAI_API_KEY in ${envFile} (step 5)`,
        );
      if (values.AGENT_NAME?.trim()) agentName = values.AGENT_NAME.trim();
    }
  }
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(agentName))
    missing.push(
      `AGENT_NAME in ${envFile} may have only letters, digits, - and _`,
    );
  const nodeBinary = (() => {
    try {
      return realpathSync(input.nodeBinary);
    } catch {
      return input.nodeBinary;
    }
  })();
  if (!protectedFile(nodeBinary, true))
    missing.push(
      `${nodeBinary} must be a program of this user that only you can change, to start the call worker`,
    );

  // The sign-in of the chert command, read in place by the call path. It is never read here.
  const signIn = privateFileState(credentials);
  if (signIn !== "ok")
    missing.push(
      signIn === "missing"
        ? `the sign-in of the chert command in ${input.chertHome}. Run: chert login`
        : `${credentials} must be for its owner only. Run: chmod 700 ${input.chertHome} && chmod 600 ${credentials}`,
    );

  // The line of the project.
  let callsOrigin = "https://app.trychert.com";
  try {
    const base = new URL(
      input.env.CHERT_API_BASE?.trim() || "https://app.trychert.com/api/v1",
    );
    if (base.protocol !== "https:") throw Error("not encrypted");
    callsOrigin = base.origin;
  } catch {
    missing.push("CHERT_API_BASE must be an https address");
  }
  const line = await projectLine({
    origin: callsOrigin,
    projectId: input.projectId,
    apiKey: input.apiKey,
    request: input.request,
  });
  if ("reason" in line) missing.push(line.reason);
  const lineId = "lineId" in line ? line.lineId : null;

  // The line's retention guard: pinned to one build of the provider and of node.
  const provider = providerPackage(input.env);
  const node = findOnPath("node", input.env);
  let pinned = false;
  if (!input.retention)
    missing.push(
      `the retention guard of the line agent (${join(lineDirectory, "provider-retention.mjs")}) cannot be read`,
    );
  else if (!provider)
    missing.push(
      "the installed @trychert/facetime package cannot be found from the chert command",
    );
  else if (!input.retention.provider(provider.root))
    missing.push(
      `the line's retention guard works only with the pinned files of @trychert/facetime ${input.retention.pin.version}, and this Mac has ${provider.version === input.retention.pin.version ? "other files of that version" : (provider.version ?? "another build")}. No command here can change that safely; calls to you stay off, and texts still reach you`,
    );
  else if (!node || !input.retention.node(realpathSync(node)))
    missing.push(
      `the line's retention guard works only with the pinned build of Node ${input.retention.pin.nodeVersion} as node on the PATH, and this Mac has another one. Calls to you stay off, and texts still reach you`,
    );
  else pinned = true;

  for (const [path, what] of [
    [input.chertHome, "the folder of the chert command"],
    [hostState, "the records folder of the line"],
  ] as const) {
    const problem = folderProblem(path);
    if (problem === "missing")
      missing.push(
        `${what} (${path}) is not there yet. Start the line once: cd ${lineDirectory} && ./host.sh start`,
      );
    else if (problem) missing.push(problem);
  }
  if (!there(providerState))
    missing.push(
      `${providerState} is not there yet. Start the line once: cd ${lineDirectory} && ./host.sh start`,
    );
  else if (folderProblem(providerState))
    missing.push(folderProblem(providerState)!);
  if (inside(projectRoot, input.desktopFolder))
    missing.push(
      `${input.desktopFolder} is inside the project of the desktop service; the call path needs it outside`,
    );

  // Folders and the retention configuration that the guarded line needs first.
  const retentionValue =
    pinned && lineId && provider
      ? {
          version: 1,
          providerRoot: provider.root,
          chertHome: realpathSync(input.chertHome),
          projectId: input.projectId,
          lineId,
          receiptDirectory: files.receipts,
        }
      : null;
  if (!input.check && retentionValue) {
    privateFolder(folder);
    privateFolder(files.attempts);
    privateFolder(files.receipts);
    writeIfChanged(files.retention, retentionValue);
  }

  // The claim of the guarded line: its journal and its retention proof.
  let initialJournal: string | null = null;
  if (pinned && retentionValue) {
    const claim = newestClaim(hostState);
    const receipts = (() => {
      try {
        return readdirSync(files.receipts).filter((name) =>
          /^[0-9]+\.json$/.test(name),
        );
      } catch {
        return [];
      }
    })();
    const journal = claim ? join(claim, "journal.json") : null;
    if (
      claim &&
      journal &&
      there(journal) &&
      receipts.length > 0 &&
      dirname(claim) === providerState
    )
      initialJournal = journal;
    else
      missing.push(
        `the line must run with its retention guard${input.check ? " (clawdtime connect writes its configuration first)" : ""}. At a time with no call, run: cd ${lineDirectory} && ./host.sh stop && CLAWDTIME_LINE_RETENTION_CONFIG=${files.retention} ./host.sh start. Then give every later ./host.sh command the same CLAWDTIME_LINE_RETENTION_CONFIG, and do not use ./host.sh schedule`,
      );
  }

  if (missing.length || !lineId || !initialJournal) {
    // The configuration in place stays while its call path accepts it (a
    // read that failed now does not take it away). One that it refuses is
    // not left for the desktop service to start with.
    if (
      outbound &&
      !input.check &&
      acceptedByProvider(files.configuration, input.desktop)
    ) {
      const { outbound: _line, ...rest } = read.config;
      writeProactiveConfig(input.desktopFolder, rest);
      missing.push("proactive.json names no outbound line until then");
      return { ...notYet(), changed: true };
    }
    return notYet();
  }

  // Everything is known: the files of the provider.
  const existing = readPrivateJSON(files.configuration).value as {
    workerPort?: unknown;
  } | null;
  const desktopPort = Number(new URL(input.desktop.origin).port);
  const workerPort =
    typeof existing?.workerPort === "number" &&
    existing.workerPort !== desktopPort
      ? existing.workerPort
      : desktopPort === 13427
        ? 13428
        : 13427;
  const native = {
    native: {
      callsOrigin,
      projectId: input.projectId,
      projectKey: input.apiKey,
      recipient: input.phone,
      lineId,
    },
  };
  const configuration: ProactiveProductionConfig =
    proactiveProductionConfigSchema.parse({
      version: 1,
      nodeBinary,
      lineDirectory,
      lineEnvironmentFile: envFile,
      providerConfigFile: files.native,
      connectorCredentialFile: credentials,
      attemptDirectory: files.attempts,
      workerPort,
      destination: {
        personId: ownerPerson,
        deviceId: ownerDevice,
        projectRoot,
        lineId,
        recipientHash: hash(input.phone),
      },
      owner: {
        hostScript,
        hostStateDirectory: hostState,
        hostSession,
        agentName,
        retentionConfigFile: files.retention,
        providerStateDirectory: providerState,
        initialJournal,
        stateFile: files.ownerState,
      },
    });
  if (input.check) {
    const same =
      sameJSON(files.native, native) &&
      sameJSON(files.configuration, configuration) &&
      outbound?.configurationFile === files.configuration;
    if (!same)
      return {
        ready: false,
        changed: false,
        text: "everything it needs is there. Run clawdtime connect to write its configuration",
      };
  }
  // A new number or key changes these files: a service that runs has the old ones.
  const rewritten =
    !input.check &&
    [
      writeIfChanged(files.native, native),
      writeIfChanged(files.configuration, configuration),
    ].some(Boolean);
  // The provider checks its own configuration, as the desktop service does when it starts.
  const refusal = acceptedByProvider(files.configuration, input.desktop);
  if (refusal) {
    // The desktop service would not start with a configuration that its call path refuses.
    if (outbound && !input.check) {
      const { outbound: _line, ...rest } = read.config;
      writeProactiveConfig(input.desktopFolder, rest);
      return {
        ready: false,
        changed: true,
        text: `the call path refuses its configuration (${refusal}), so proactive.json names no outbound line now. Fix what the code names, then run clawdtime connect again`,
      };
    }
    return {
      ready: false,
      changed: false,
      text: `the call path refuses its configuration (${refusal}). ${outbound ? "Run clawdtime connect to take it out of proactive.json" : "proactive.json is not changed"}`,
    };
  }
  if (outbound)
    return done(
      rewritten
        ? "configured again with the new values, and proactive.json names it"
        : "configured, and proactive.json names it",
      rewritten,
    );
  if (input.check)
    return {
      ready: false,
      changed: false,
      text: "configured, but proactive.json does not name it yet. Run clawdtime connect",
    };
  writeProactiveConfig(input.desktopFolder, {
    ...read.config,
    outbound: {
      provider: "chert-dev-retained-v1",
      configurationFile: files.configuration,
    },
  });
  return done("configured now, and proactive.json names it", true);
}

/** Null when the provider accepts the configuration; else its fixed refusal code. */
export function acceptedByProvider(
  configurationFile: string,
  desktop: DesktopDescriptor,
): string | null {
  // Construction reads and checks every file in place. It starts no worker,
  // takes no line and places no call; nothing here is ever used to call.
  const unused = () => {
    throw Error("production_validation_only");
  };
  const context = {
    projectRoot: desktop.projectRoot,
    origin: desktop.origin,
    coordinator: {},
    sessions: {},
    packet: unused,
    current: () => false,
    sourceFingerprint: unused,
    cleanupViews: unused,
  } as unknown as ProductionDeliveryContext;
  try {
    createProductionDelivery(configurationFile, context);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /^production_[a-z_]+$/.test(message)
      ? message
      : "production_configuration_invalid";
  }
}

function readPrivateText(file: string): string | null {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) return null;
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
function sameJSON(file: string, value: unknown) {
  const read = readPrivateJSON(file);
  return !read.problem && JSON.stringify(read.value) === JSON.stringify(value);
}
function writeIfChanged(file: string, value: unknown) {
  if (sameJSON(file, value)) return false;
  writePrivateJSON(file, value);
  return true;
}
