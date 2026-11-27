/**
 * The real Mac behind the setup engine's ports. Every check here is read
 * only: the panel's `--check-access` and the capture helper's `--preflight`
 * ask macOS without a prompt, and `--list-displays` reads display metadata
 * with no screen image. Starting the desktop and the shared connection are the
 * only effects, and the engine asks for each first.
 */
import { execFile, spawn } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  desktopStateFolder,
  findDesktopService,
} from "../../connectors/agents/desktop-chat.js";
import { inspectDesktopReadiness } from "../../connectors/agents/desktop-readiness.js";
import { readDesktopPrivateJSON } from "../control/task-desktop-config.js";
import type { Provider } from "../../connectors/computer/providers.js";
import {
  readPrivateJSON,
  writePrivateJSON,
} from "../../connectors/shared/private-file.js";
import { findNativeHelper } from "../native-helpers.js";
import { processLockHolder } from "../process-lock.js";
import type { OnboardPorts, PermissionFacts } from "./engine.js";
import {
  listSharedDisplays,
  resolveSharedDisplay,
  sharedConnectionLock,
  sharedPairingPaths,
} from "./pairing.js";

const run = (binary: string, args: string[], timeout = 10_000) =>
  new Promise<string>((done, fail) =>
    execFile(
      binary,
      args,
      { timeout, maxBuffer: 64 * 1024 },
      (error, stdout) =>
        error ? fail(Error("check_unavailable")) : done(stdout),
    ),
  );

/** Darwin 23 is macOS 14. */
export function darwinMajor(platform = process.platform, version = release()) {
  if (platform !== "darwin") return null;
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : null;
}

async function appleSilicon() {
  if (process.arch === "arm64") return true;
  // An Intel Node under translation still runs on Apple silicon.
  try {
    return (
      (await run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"])).trim() ===
      "1"
    );
  } catch {
    return false;
  }
}

/** Checks a key with its provider's list of models: one GET, the key in a header. */
export async function checkProviderKey(
  provider: Provider,
  key: string,
  request: typeof fetch = fetch,
): Promise<"valid" | "refused" | "unchecked"> {
  let url: string;
  let headers: Record<string, string>;
  if (provider.id === "anthropic") {
    url = "https://api.anthropic.com/v1/models";
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  } else if (provider.endpoint?.endsWith("/chat/completions")) {
    url = provider.endpoint.replace(/\/chat\/completions$/, "/models");
    headers = { authorization: `Bearer ${key}` };
  } else return "unchecked";
  try {
    const response = await request(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) return "refused";
    return response.ok ? "valid" : "unchecked";
  } catch {
    return "unchecked";
  }
}

/**
 * The record of the managed connection. `processStart` and `command` are what
 * `ps` said of the process right after it started: a process id is reused
 * after its process ends, so a signal goes to the id only while `ps` still
 * says the same of it.
 */
const recordSchema = z
  .object({
    version: z.literal(2),
    pid: z.number().int().positive(),
    instanceId: z.string().min(1).max(200),
    startedAt: z.number(),
    processStart: z.string().min(1).max(100),
    command: z.string().min(1).max(8192),
  })
  .strict();
type ConnectionRecord = z.infer<typeof recordSchema>;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** One process as `ps` shows it: when it started, and its whole command line. */
export interface ProcessIdentity {
  start: string;
  command: string;
}

/**
 * What `ps` says of one process now, or null when it is gone or `ps` cannot
 * tell. The start time is to the second, in a fixed format.
 */
export function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  return new Promise((done) =>
    execFile(
      "/bin/ps",
      ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)],
      {
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin", TZ: "UTC" },
      },
      (error, stdout) => {
        const found =
          !error &&
          /^(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}) +(\S.*)$/.exec(
            stdout.trim(),
          );
        done(found ? { start: found[1]!, command: found[2]! } : null);
      },
    ),
  );
}

const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** The start time of `processIdentity` (in UTC) in milliseconds, or NaN. */
export function processStartMs(start: string) {
  const parts = /^\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})$/.exec(
    start,
  );
  const month = parts ? months.indexOf(parts[1]!) : -1;
  if (!parts || month < 0) return Number.NaN;
  return Date.UTC(
    Number(parts[6]),
    month,
    Number(parts[2]),
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
  );
}

const sameProcess = async (record: ConnectionRecord) => {
  const now = await processIdentity(record.pid);
  return (
    !!now && now.start === record.processStart && now.command === record.command
  );
};

/**
 * The shared connection that setup manages: one `clawdtime shared run` in
 * the background, bound to one desktop lifetime. Its record is an owner-only
 * file beside the pairing. It holds no credential.
 */
export function managedConnection(input: {
  home: string;
  /** The command that runs `clawdtime`: node, its flags and the entry file. */
  command: { executable: string; args: string[] };
  env: Record<string, string | undefined>;
}): OnboardPorts["connection"] {
  const { directory } = sharedPairingPaths(input.home);
  const file = join(directory, "onboard-connection.json");
  /**
   * The record, only while its process runs: the same start time and the
   * same command as when it started. A record of an earlier release, or of
   * a process that has ended (its id may belong to another process now), is
   * cleared without a signal. A file that is not private is left as it is.
   */
  const live = async (): Promise<ConnectionRecord | null> => {
    const loaded = readPrivateJSON(file);
    if (loaded.problem || loaded.value === undefined || loaded.value === null)
      return null;
    const parsed = recordSchema.safeParse(loaded.value);
    if (parsed.success && (await sameProcess(parsed.data))) return parsed.data;
    rmSync(file, { force: true });
    return null;
  };
  return {
    status: async (instanceId) => {
      const record = await live();
      if (!record) return "stopped";
      return record.instanceId === instanceId ? "running" : "stale";
    },
    holder: async () => {
      const held = processLockHolder(sharedConnectionLock(input.home));
      if (!held) return null;
      const record = await live();
      return {
        instanceId:
          typeof held.instanceId === "string" ? held.instanceId : null,
        managed: !!record && held.pid === record.pid,
      };
    },
    stop: async () => {
      const record = await live();
      if (!record) return;
      // Shared run closes its calls and its capture on SIGTERM. Only the
      // moment between the check above and this signal is left: macOS hands
      // out process ids in turn, so an id comes back only after the others.
      process.kill(record.pid, "SIGTERM");
      const deadline = Date.now() + 15_000;
      while (await sameProcess(record)) {
        if (Date.now() > deadline) throw Error("connection_did_not_stop");
        await new Promise((done) => setTimeout(done, 200));
      }
      rmSync(file, { force: true });
    },
    start: async (instanceId) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const log = openSync(
        join(directory, "connection.log"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        0o600,
      );
      let exited = false;
      try {
        const child = spawn(
          input.command.executable,
          [...input.command.args, "shared", "run"],
          {
            detached: true,
            stdio: ["ignore", log, log],
            env: input.env as NodeJS.ProcessEnv,
          },
        );
        child.once("exit", () => {
          exited = true;
        });
        await new Promise<void>((done, fail) => {
          child.once("spawn", done);
          child.once("error", () => fail(Error("connection_did_not_start")));
        });
        child.unref();
        // What ps says of it now is what a later stop compares before any
        // signal. Without it the process could never be stopped safely.
        const identity = await processIdentity(child.pid!);
        if (!identity) {
          child.kill("SIGTERM");
          throw Error("connection_not_identified");
        }
        writePrivateJSON(file, {
          version: 2,
          pid: child.pid!,
          instanceId,
          startedAt: Date.now(),
          processStart: identity.start,
          command: identity.command,
        } satisfies ConnectionRecord);
        // A connection that the coordinator refuses ends at once.
        await new Promise((done) => setTimeout(done, 2000));
        if (exited) throw Error("connection_ended");
      } finally {
        closeSync(log);
      }
    },
  };
}

/** The lock of a `clawdtime start --foreground` that owns the desktop. */
const foregroundLock = "desktop-owner.lock";

/**
 * Ends the desktop service of this Mac with SIGTERM and waits until it has
 * left and removed its owner lock. The panel stays: it finds the next service
 * of the same desktop by itself. A desktop that a foreground owner runs (the
 * Mac app) is left to that owner.
 */
export async function stopDesktopService(
  system: { env: Record<string, string | undefined>; home: string },
  options: { waitMs?: number } = {},
) {
  const folder = desktopStateFolder(system);
  if (!folder) return;
  if (processLockHolder(join(folder, foregroundLock)))
    throw Error("desktop_owned_in_foreground");
  let pid: number;
  try {
    pid = z
      .object({ pid: z.number().int().positive() })
      .strict()
      .parse(readDesktopPrivateJSON(join(folder, "owner.lock"))).pid;
  } catch {
    return;
  }
  // The service writes its lock once, as it starts. The process with that id
  // is the service only when it began before the lock was written and runs
  // the task server; else the id belongs to another process now, and it gets
  // no signal. The lock is left to the person: setup never takes it.
  const identity = await processIdentity(pid);
  if (!identity) return;
  let written: number;
  try {
    written = statSync(join(folder, "owner.lock")).mtimeMs;
  } catch {
    return;
  }
  if (
    !(processStartMs(identity.start) <= written) ||
    !/[/\\]task-server\.(?:ts|js)(?:\s|$)/.test(identity.command)
  )
    throw Error("desktop_not_verified");
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + (options.waitMs ?? 20_000);
  while (alive(pid) || existsSync(join(folder, "owner.lock"))) {
    if (Date.now() > deadline) throw Error("desktop_did_not_stop");
    await new Promise((done) => setTimeout(done, 200));
  }
}

/** The ports of the real Mac. */
export function macPorts(input: {
  env: Record<string, string | undefined>;
  home: string;
  root: string;
  command: { executable: string; args: string[] };
  /** Starts the desktop. `tucked`: the panel, when one opens, takes no focus. */
  startDesktop: (
    log: (message: string) => void,
    options?: { tucked?: boolean },
  ) => Promise<void>;
  request?: typeof fetch;
}): OnboardPorts {
  const request = input.request ?? fetch;
  const where = { root: input.root, env: input.env };
  const panel = () => findNativeHelper("ClawdTimeTaskPanel", where);
  const capture = () => findNativeHelper("ClawdTimeTaskCapture", where);
  const system = { env: input.env, home: input.home };
  return {
    mac: async () => ({
      darwinMajor: darwinMajor(),
      appleSilicon: await appleSilicon(),
    }),
    helpers: () => ({ panel: !!panel(), capture: !!capture() }),
    desktop: {
      status: () => inspectDesktopReadiness(system),
      instanceId: async () => {
        const folder = desktopStateFolder(system);
        return (folder ? findDesktopService(folder) : null)?.instanceId ?? null;
      },
      start: (log) => input.startDesktop(log),
      stop: () => stopDesktopService(system),
      // An open panel stays and finds the new service by itself; a new one
      // opens tucked, so the restart takes no focus.
      restart: async (log) => {
        await stopDesktopService(system);
        await input.startDesktop(log, { tucked: true });
      },
    },
    permissions: async (): Promise<PermissionFacts> => {
      const panelPath = panel();
      const capturePath = capture();
      const facts: PermissionFacts = {
        panel: {
          ...(panelPath ? { path: panelPath } : {}),
          accessibility: false,
          screenRecording: false,
        },
        capture: {
          ...(capturePath ? { path: capturePath } : {}),
          screenRecording: false,
        },
      };
      if (panelPath) {
        const access = z
          .object({ accessibility: z.boolean(), screenRecording: z.boolean() })
          .passthrough()
          .parse(JSON.parse(await run(panelPath, ["--check-access"])));
        facts.panel.accessibility = access.accessibility;
        facts.panel.screenRecording = access.screenRecording;
      }
      if (capturePath) {
        const access = z
          .object({ screenPermission: z.boolean() })
          .passthrough()
          .safeParse(
            JSON.parse(
              await run(capturePath, ["--preflight"]).catch(() => "{}"),
            ),
          );
        facts.capture.screenRecording =
          access.success && access.data.screenPermission;
      }
      return facts;
    },
    displays: {
      capture,
      list: async () => {
        const binary = capture();
        return binary ? listSharedDisplays(binary) : [];
      },
      resolve: async (displayId) => {
        const binary = capture();
        if (!binary) throw Error("capture_missing");
        return resolveSharedDisplay(binary, displayId);
      },
    },
    connection: managedConnection({
      home: input.home,
      command: input.command,
      env: input.env,
    }),
    validateKey: (provider, key) => checkProviderKey(provider, key, request),
    request,
  };
}

/** The version of this package, from its package.json. */
export function packageVersion(root: string) {
  try {
    const file = join(root, "package.json");
    if (!existsSync(file)) return "unknown";
    const value = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown;
    };
    return typeof value.version === "string" ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}
