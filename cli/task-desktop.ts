import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { desktopConfigurationFingerprint } from "../src/control/task-desktop-config.js";
import { desktopCallsConfigSchema } from "../src/control/task-desktop-calls-config.js";
import { validateVerificationPlan } from "../src/control/task-verification.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200);
const descriptorSchema = z
  .object({
    version: z.literal(1),
    instanceId: identity,
    pid: z.number().int().positive(),
    origin: z.string(),
    projectRoot: z.string(),
    worker: z.enum(["simulation", "codex"]),
    panelConfigPath: z.string(),
    configurationFingerprint: fingerprint,
  })
  .strict();
const panelSchema = z
  .object({
    version: z.literal(1),
    desktopId: identity,
    origin: z.string(),
    token: z.string().min(32).max(4096),
    projectRoot: z.string(),
    receiptDirectory: z.string(),
    configurationFingerprint: fingerprint,
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    desktopId: identity,
    instanceId: identity,
    configurationFingerprint: fingerprint,
    projectRoot: z.string(),
    worker: z.enum(["simulation", "codex"]),
    mode: z.enum(["simulation", "standby"]),
  })
  .passthrough();

function outside(project: string, path: string) {
  const part = relative(project, path);
  if (
    !part ||
    (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part))
  )
    throw Error(
      "Desktop private state and checks must be outside the selected project.",
    );
}
function privateDirectory(path: string, project: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw Error("Desktop state must be an owner-only directory.");
  outside(project, realpathSync(path));
}
function privateBytes(path: string, project: string, maximum = 65536): Buffer {
  privateDirectory(dirname(path), project);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      stat.size > maximum
    )
      throw Error(
        "Desktop configuration must be a bounded owner-only regular file.",
      );
    outside(project, realpathSync(path));
    const bytes = readFileSync(fd);
    if (bytes.length > maximum)
      throw Error("Desktop configuration is too large.");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function privateJSON(path: string, project: string): unknown {
  try {
    return JSON.parse(privateBytes(path, project).toString("utf8"));
  } catch {
    throw Error(
      "Desktop protected configuration is unavailable or invalid; preserve it for recovery.",
    );
  }
}
function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        [
          "HOME",
          "PATH",
          "USER",
          "LOGNAME",
          "SHELL",
          "TMPDIR",
          "LANG",
          "CODEX_HOME",
        ].includes(key) || key.startsWith("LC_"),
    ),
  );
}
async function responseJSON(response: Response) {
  if (!response.ok || !response.body)
    throw Error("Desktop service did not authenticate readiness.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      length += value.value.length;
      if (length > 131072)
        throw Error("Desktop readiness response is too large.");
      chunks.push(value.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function desktopCli(
  args: string[],
  dependencies: {
    spawn?: typeof spawn;
    request?: typeof fetch;
    root?: string;
    print?: (message: string) => void;
    startupMs?: number;
    pollMs?: number;
  } = {},
) {
  const print = dependencies.print ?? console.log;
  if (!args.length || args[0] === "--help") {
    print(
      "task:desktop --state PRIVATE_DIR --project SELECTED_PROJECT [--port 13326] [--session-file PRIVATE_FILE] [--worker codex --checks PRIVATE_FILE] [--calls-config PRIVATE_FILE] [--panel-binary ABSOLUTE_EXECUTABLE] [--agents false] [--tucked true]\nSimulation is the default. --tucked true starts the panel as the mascot and takes no focus. The panel also lists every coding-agent session on this Mac; --agents false turns that board off. Closing the panel leaves the service and task running. Startup does not call, capture, or renew authorization. Calls configuration requires Codex and an existing session; each call needs separate operator authorization.",
    );
    return;
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      ![
        "--state",
        "--project",
        "--port",
        "--worker",
        "--checks",
        "--session-file",
        "--calls-config",
        "--panel-binary",
        "--agents",
        "--tucked",
      ].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options[key] !== undefined
    )
      throw Error("Use each documented --option value once.");
    options[key] = value;
  }
  if (!options["--state"] || !options["--project"])
    throw Error(
      "An explicit private state directory and selected project are required.",
    );
  const projectRoot = realpathSync(options["--project"]);
  if (!lstatSync(projectRoot).isDirectory())
    throw Error("Selected project must be a directory.");
  const state = resolve(options["--state"]);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  privateDirectory(state, projectRoot);
  const port = Number(options["--port"] ?? 13326);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Invalid desktop port.");
  const worker = options["--worker"] ?? "simulation";
  if (
    !["simulation", "codex"].includes(worker) ||
    (options["--worker"] && worker !== "codex")
  )
    throw Error(
      "Only explicit --worker codex is supported; omit it for simulation.",
    );
  if ((worker === "codex") !== !!options["--checks"])
    throw Error(
      "Codex requires an explicit private verification plan; simulation does not accept checks.",
    );
  if (
    options["--calls-config"] &&
    (worker !== "codex" || !options["--session-file"])
  )
    throw Error(
      "Calls configuration requires Codex, checks, and an explicit existing session file.",
    );
  if (
    options["--agents"] !== undefined &&
    !["true", "false"].includes(options["--agents"])
  )
    throw Error("Use --agents true or --agents false.");
  if (
    options["--tucked"] !== undefined &&
    !["true", "false"].includes(options["--tucked"])
  )
    throw Error("Use --tucked true or --tucked false.");
  const checksPath = options["--checks"]
    ? resolve(options["--checks"])
    : undefined;
  let checksFingerprint: string | null = null;
  if (checksPath) {
    const bytes = privateBytes(checksPath, projectRoot);
    try {
      validateVerificationPlan(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw Error("The explicit desktop verification plan is invalid.");
    }
    checksFingerprint = createHash("sha256").update(bytes).digest("hex");
  }
  const sessionPath = options["--session-file"]
    ? resolve(options["--session-file"])
    : undefined;
  let sessionFingerprint: string | undefined;
  if (sessionPath) {
    const bytes = privateBytes(sessionPath, projectRoot);
    try {
      z.object({ token: z.string().min(32).max(4096) })
        .passthrough()
        .parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw Error("The explicit desktop session file is invalid.");
    }
    sessionFingerprint = createHash("sha256").update(bytes).digest("hex");
  }
  const callsPath = options["--calls-config"]
    ? resolve(options["--calls-config"])
    : undefined;
  let callsFingerprint: string | undefined;
  if (callsPath) {
    const bytes = privateBytes(callsPath, projectRoot);
    try {
      desktopCallsConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw Error("The explicit desktop calls configuration is invalid.");
    }
    callsFingerprint = createHash("sha256").update(bytes).digest("hex");
  }
  const root =
    dependencies.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const panelBinary =
    options["--panel-binary"] ??
    join(root, "mac/.build/debug/ClawdTimeTaskPanel");
  if (!isAbsolute(panelBinary))
    throw Error("Panel binary must be an absolute path.");
  if (!lstatSync(panelBinary).isFile())
    throw Error("Build the native ClawdTimeTaskPanel executable first.");
  accessSync(panelBinary, constants.X_OK);
  const configurationFingerprint = desktopConfigurationFingerprint({
    projectRoot,
    worker: worker as "simulation" | "codex",
    checksFingerprint,
    port,
    ...(sessionFingerprint ? { sessionFingerprint } : {}),
    ...(callsFingerprint ? { callsFingerprint } : {}),
  });
  const origin = `http://127.0.0.1:${port}`;
  const panelPath = join(state, "desktop-panel.json");
  const descriptorPath = join(state, "desktop-service.json");
  const ownerPath = join(state, "owner.lock");
  const launchPath = join(state, "desktop-launch.lock");
  let launch: number;
  try {
    launch = openSync(launchPath, "wx", 0o600);
  } catch {
    throw Error(
      "Another desktop launch or an unresolved launch lock exists. Do not steal the lock; establish prior process quiescence first.",
    );
  }
  const spawnProcess = dependencies.spawn ?? spawn;
  const request = dependencies.request ?? fetch;
  let serviceChild: ChildProcess | undefined;
  let serviceFailed = false;
  try {
    writeFileSync(launch, JSON.stringify({ pid: process.pid }));
    const attach = existsSync(ownerPath);
    if (!attach) {
      const serviceArgs = [
        "--import",
        "tsx",
        join(root, "scripts/task-server.ts"),
        "--state",
        state,
        "--project",
        projectRoot,
        "--port",
        String(port),
        "--desktop",
        "true",
      ];
      if (worker === "codex")
        serviceArgs.push("--worker", "codex", "--checks", checksPath!);
      if (sessionPath) serviceArgs.push("--session-file", sessionPath);
      if (callsPath) serviceArgs.push("--calls-config", callsPath);
      if (options["--agents"])
        serviceArgs.push("--agents", options["--agents"]);
      serviceChild = spawnProcess(process.execPath, serviceArgs, {
        cwd: root,
        detached: true,
        stdio: "ignore",
        env: childEnvironment(),
      });
      serviceChild.once("error", () => {
        serviceFailed = true;
      });
      serviceChild.once("exit", () => {
        serviceFailed = true;
      });
      serviceChild.unref();
    }
    const deadline = Date.now() + (dependencies.startupMs ?? 10000);
    let ready = false;
    do {
      if (serviceFailed)
        throw Error(
          "Desktop service startup failed. Private receipts and owner state are preserved.",
        );
      try {
        const owner = z
          .object({ pid: z.number().int().positive() })
          .strict()
          .parse(privateJSON(ownerPath, projectRoot));
        const descriptor = descriptorSchema.parse(
          privateJSON(descriptorPath, projectRoot),
        );
        const panel = panelSchema.parse(privateJSON(panelPath, projectRoot));
        if (
          descriptor.pid !== owner.pid ||
          (!attach && descriptor.pid !== serviceChild?.pid) ||
          descriptor.origin !== origin ||
          panel.origin !== origin ||
          descriptor.projectRoot !== projectRoot ||
          panel.projectRoot !== projectRoot ||
          descriptor.worker !== worker ||
          descriptor.panelConfigPath !== panelPath ||
          descriptor.configurationFingerprint !== configurationFingerprint ||
          panel.configurationFingerprint !== configurationFingerprint
        )
          throw Error(
            "Desktop service binding differs from the selected configuration.",
          );
        if (!isAbsolute(panel.receiptDirectory))
          throw Error("Invalid desktop receipt directory.");
        privateDirectory(panel.receiptDirectory, projectRoot);
        const value = stateSchema.parse(
          await responseJSON(
            await request(`${origin}/desktop/state`, {
              headers: { authorization: `Bearer ${panel.token}` },
              redirect: "error",
              signal: AbortSignal.timeout(2000),
            }),
          ),
        );
        if (
          value.instanceId !== descriptor.instanceId ||
          value.desktopId !== panel.desktopId ||
          value.configurationFingerprint !== configurationFingerprint ||
          value.projectRoot !== projectRoot ||
          value.worker !== worker ||
          value.mode !== (worker === "simulation" ? "simulation" : "standby")
        )
          throw Error(
            "Desktop authenticated readiness does not match the selected instance.",
          );
        const ownerAfter = z
          .object({ pid: z.number().int().positive() })
          .strict()
          .parse(privateJSON(ownerPath, projectRoot));
        if (ownerAfter.pid !== owner.pid)
          throw Error("Desktop service ownership changed during readiness.");
        ready = true;
      } catch {
        if (attach)
          throw Error(
            "Existing desktop service cannot be authenticated for this exact project/configuration. No replacement or renewal was attempted.",
          );
      }
      if (!ready)
        await new Promise((done) =>
          setTimeout(done, dependencies.pollMs ?? 100),
        );
    } while (!ready && Date.now() < deadline);
    if (!ready)
      throw Error(
        "Desktop service startup is unconfirmed. Preserve its owner lock and state; no replacement was started.",
      );
    // Tucked: the panel starts as the mascot and takes no focus.
    const panelArgs = ["--config", panelPath];
    if (options["--tucked"] === "true") panelArgs.push("--tucked");
    const panel = spawnProcess(panelBinary, panelArgs, {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: childEnvironment(),
    });
    await new Promise<void>((done, reject) => {
      panel.once("spawn", done);
      panel.once("error", () =>
        reject(
          Error(
            "Native panel could not start. The task service remains available.",
          ),
        ),
      );
    });
    panel.unref();
    print(
      `Desktop panel requested for ${projectRoot}. Task service remains running at ${origin} when the panel closes. Simulation: ${worker === "simulation"}.`,
    );
  } finally {
    const owned = fstatSync(launch);
    closeSync(launch);
    if (existsSync(launchPath)) {
      const current = lstatSync(launchPath);
      if (current.dev === owned.dev && current.ino === owned.ino)
        unlinkSync(launchPath);
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  desktopCli(process.argv.slice(2)).catch(() => {
    console.error(
      "Desktop launch refused or unconfirmed. Preserve private state and ownership locks; check the explicit project, private configuration, service readiness and native panel build.",
    );
    process.exitCode = 1;
  });
}
