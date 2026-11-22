import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const CUA_DRIVER_PROBE_VERSION = "0.55.0";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().min(1).refine(isAbsolute);
export const cuaDriverProbeTargetSchema = z
  .object({
    bundleId: z.string().regex(/^[A-Za-z0-9.-]+$/),
    pid: z.number().int().positive(),
    executablePath: absolute,
  })
  .strict();
export type CuaDriverProbeTarget = z.infer<typeof cuaDriverProbeTargetSchema>;
export const cuaDriverProbeConfigSchema = z
  .object({
    sdkDirectory: absolute,
    socketPath: absolute,
    executablePath: absolute,
    expectedPid: z.number().int().positive(),
    manifestSha256: digest,
    policySha256: digest,
    targets: z.array(cuaDriverProbeTargetSchema).max(8).default([]),
  })
  .strict();
export type CuaDriverProbeConfig = z.infer<typeof cuaDriverProbeConfigSchema>;

/** Minimal release-0.55.0 surface: this probe exposes no input/capture/launch. */
export interface CuaDriverProbePort {
  executionMode(): number;
  socketPath(): string;
  isAvailable(): boolean;
  metadata(options: {
    signal: AbortSignal;
  }): Promise<{ driverVersion: string; embedded: boolean; pid: number }>;
  checkPermissions(options: { signal: AbortSignal }): Promise<unknown>;
  verifyApplication(
    target: CuaDriverProbeTarget,
    signal: AbortSignal,
  ): Promise<boolean>;
  listWindows(
    input: { pid: number; onScreenOnly: false },
    options: { signal: AbortSignal },
  ): Promise<{
    windows: {
      windowId: bigint;
      pid?: number;
      isOnScreen: boolean;
      minimized?: boolean;
      onCurrentSpace?: boolean;
    }[];
  }>;
  shutdown(options: { signal: AbortSignal }): Promise<void>;
  destroy(): void;
}
const permissionSchema = z.object({
  accessibility: z.boolean(),
  screen_recording: z.boolean(),
  source: z.object({
    attribution: z.literal("driver-daemon"),
    pid: z.number().int().positive(),
    executable: z.string(),
    bundle_id: z.literal("com.trycua.driver"),
  }),
});

/** Release-pinned CLI status parser; an incomplete/changed format fails closed. */
export function verifyCuaDriverStatus(
  status: string,
  config: CuaDriverProbeConfig,
): boolean {
  const fields = new Map(
    status
      .split(/\r?\n/)
      .slice(1)
      .map((line) => {
        const split = line.indexOf(":");
        return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
      }),
  );
  return (
    status.startsWith("Cua Driver daemon is running\n") &&
    fields.get("socket") === config.socketPath &&
    fields.get("permission mode") ===
      "bounded (trusted_startup_configuration)" &&
    fields.get("user policy") === "configured=true, active=true, valid=true" &&
    fields.get("user policy sha256") === config.policySha256 &&
    fields.get("capability manifest") ===
      "configured=true, approved_at_startup=true, valid=true" &&
    fields.get("capability manifest sha256") === config.manifestSha256
  );
}

export async function inspectCuaDriverDaemon(
  config: CuaDriverProbeConfig,
  port: CuaDriverProbePort,
  daemonMode: number,
  signal: AbortSignal,
) {
  try {
    signal.throwIfAborted();
    if (
      port.executionMode() !== daemonMode ||
      port.socketPath() !== config.socketPath ||
      !port.isAvailable()
    )
      throw Error(
        "Explicit Cua daemon connection unavailable; no fallback attempted.",
      );
    const metadata = await port.metadata({ signal });
    // Confirmed against the pinned daemon: metadata.pid is its remote PID.
    if (
      metadata.driverVersion !== CUA_DRIVER_PROBE_VERSION ||
      metadata.pid !== config.expectedPid ||
      metadata.embedded
    )
      throw Error(
        "Cua SDK metadata does not match the pinned daemon topology.",
      );
    const permissions = permissionSchema.parse(
      await port.checkPermissions({ signal }),
    );
    if (
      permissions.source.pid !== config.expectedPid ||
      permissions.source.executable !== config.executablePath
    )
      throw Error(
        "Cua daemon permission owner does not match the expected process.",
      );
    const base = {
      version: CUA_DRIVER_PROBE_VERSION,
      daemonPid: permissions.source.pid,
      accessibility: permissions.accessibility,
      screenRecording: permissions.screen_recording,
      directCaptureVerified: false as const,
    };
    if (!permissions.accessibility || !permissions.screen_recording)
      return { ...base, status: "permissions_required" as const, apps: [] };
    signal.throwIfAborted();
    const apps = [];
    for (const app of config.targets) {
      const { bundleId } = app;
      if (!(await port.verifyApplication(app, signal))) {
        apps.push({
          bundleId,
          status: "process_identity_unverified",
          windows: [],
        });
        continue;
      }
      signal.throwIfAborted();
      const windows = await port.listWindows(
        { pid: app.pid, onScreenOnly: false },
        { signal },
      );
      if (
        windows.windows.some((window) => window.pid !== app.pid) ||
        !(await port.verifyApplication(app, signal))
      )
        throw Error(
          "Cua window inventory does not bind every window to the expected process.",
        );
      apps.push({
        bundleId,
        pid: app.pid,
        status: "resolved",
        windows: windows.windows.map((window) => ({
          windowId: window.windowId.toString(),
          isOnScreen: window.isOnScreen,
          minimized: window.minimized ?? null,
          onCurrentSpace: window.onCurrentSpace ?? null,
        })),
      });
    }
    return { ...base, status: "inventory_only" as const, apps };
  } finally {
    // Client shutdown does not stop the daemon. Never run `cua-driver stop` here.
    try {
      await port.shutdown({ signal: AbortSignal.timeout(5000) });
    } finally {
      port.destroy();
    }
  }
}

/** Exact operator-selected process; no global app or desktop discovery. */
export async function verifyProbeApplication(
  target: CuaDriverProbeTarget,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  if ((await realpath(target.executablePath)) !== target.executablePath)
    return false;
  const marker = target.executablePath.lastIndexOf(".app/Contents/MacOS/");
  if (marker < 0) return false;
  const bundle = target.executablePath.slice(0, marker + 4);
  const options = {
    timeout: 3000,
    maxBuffer: 8192,
    signal,
    env: { PATH: "/usr/bin:/bin" },
  };
  const [processPath, bundleIdentity] = await Promise.all([
    promisify(execFile)(
      "/bin/ps",
      ["-p", String(target.pid), "-o", "comm="],
      options,
    ),
    promisify(execFile)(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleIdentifier",
        join(bundle, "Contents", "Info.plist"),
      ],
      options,
    ),
  ]);
  return (
    processPath.stdout.trim() === target.executablePath &&
    bundleIdentity.stdout.trim() === target.bundleId
  );
}

export const driverRefusedInTest =
  "The installed driver is not used from a test.";
/**
 * A process that a test started never reaches the installed driver: no status
 * command, no SDK and no connection. So no input for the driver can come out
 * of a test, whatever configuration the test wrote.
 */
export function refuseDriverInTest(
  env: Record<string, string | undefined> = process.env,
) {
  if (env.VITEST) throw Error(driverRefusedInTest);
}

/** Lead-only local diagnostic: fixed official package and fixed read-only calls. */
export async function probePinnedCuaDaemon(
  rawConfig: unknown,
  signal: AbortSignal,
) {
  refuseDriverInTest();
  const config = cuaDriverProbeConfigSchema.parse(rawConfig);
  signal.throwIfAborted();
  const socket = await lstat(config.socketPath);
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    (socket.mode & 0o077) !== 0
  )
    throw Error("Cua socket must be private and owned by this user.");
  const packageRoot = join(
    config.sdkDirectory,
    "node_modules",
    "@trycua",
    "cua-driver",
  );
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    manifest.name !== "@trycua/cua-driver" ||
    manifest.version !== CUA_DRIVER_PROBE_VERSION ||
    manifest.license !== "MIT"
  )
    throw Error("Cua SDK package does not match the selected release.");
  if ((await realpath(config.executablePath)) !== config.executablePath)
    throw Error("Cua executable must be the exact verified real path.");
  const status = await promisify(execFile)(
    config.executablePath,
    ["status", "--socket", config.socketPath],
    {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      signal,
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
    },
  );
  if (!verifyCuaDriverStatus(status.stdout, config))
    throw Error("Cua daemon bounded mode or policy hashes do not match.");
  const sdk = await import(
    pathToFileURL(join(packageRoot, "dist", "index.js")).href
  );
  const driver = sdk.CuaDriver.connect(config.socketPath);
  const port: CuaDriverProbePort = {
    executionMode: () => driver.executionMode(),
    socketPath: () => driver.socketPath(),
    isAvailable: () => driver.isAvailable(),
    metadata: (options) => driver.metadata(options),
    // 0.55.0 has no typed checkPermissions method. This fixed, non-prompting
    // read-only tool is the sole generic SDK call; callers cannot choose tools.
    checkPermissions: async (options) => {
      const result = await driver.callTool(
        "check_permissions",
        '{"prompt":false,"probe_direct_capture":false}',
        options,
      );
      if (result.isError || result.degraded || !result.structuredJson)
        throw Error("Cua permission status unavailable.");
      return JSON.parse(result.structuredJson);
    },
    verifyApplication: verifyProbeApplication,
    listWindows: (input, options) => driver.listWindows(input, options),
    shutdown: (options) => driver.shutdown(options),
    destroy: () => driver.uniffiDestroy(),
  };
  return inspectCuaDriverDaemon(
    config,
    port,
    sdk.DriverExecutionMode.Daemon,
    signal,
  );
}
