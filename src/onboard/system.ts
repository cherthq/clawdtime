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

const recordSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    instanceId: z.string().min(1).max(200),
    startedAt: z.number(),
  })
  .strict();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  const read = () => {
    const loaded = readPrivateJSON(file);
    const parsed = recordSchema.safeParse(loaded.value);
    return !loaded.problem && parsed.success ? parsed.data : null;
  };
  return {
    status: async (instanceId) => {
      const record = read();
      if (!record || !alive(record.pid)) return "stopped";
      return record.instanceId === instanceId ? "running" : "stale";
    },
    holder: async () => {
      const held = processLockHolder(sharedConnectionLock(input.home));
      if (!held) return null;
      const record = read();
      return {
        instanceId:
          typeof held.instanceId === "string" ? held.instanceId : null,
        managed: !!record && held.pid === record.pid,
      };
    },
    stop: async () => {
      const record = read();
      if (!record || !alive(record.pid)) return;
      // Shared run closes its calls and its capture on SIGTERM.
      process.kill(record.pid, "SIGTERM");
      const deadline = Date.now() + 15_000;
      while (alive(record.pid)) {
        if (Date.now() > deadline) throw Error("connection_did_not_stop");
        await new Promise((done) => setTimeout(done, 200));
      }
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
        writePrivateJSON(file, {
          version: 1,
          pid: child.pid!,
          instanceId,
          startedAt: Date.now(),
        });
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
  if (!alive(pid)) return;
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
