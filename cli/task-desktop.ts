import { spawn, type ChildProcess } from "node:child_process";
import { findNativeHelper } from "../src/native-helpers.js";
import { takeProcessLock } from "../src/process-lock.js";
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
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { desktopConfigurationFingerprint } from "../src/control/task-desktop-config.js";
import { desktopCallsConfigSchema } from "../src/control/task-desktop-calls-config.js";
import { validateVerificationPlan } from "../src/control/task-verification.js";
import { plannerVariables } from "../connectors/computer/providers.js";
import {
  checkPort,
  defaultDesktopPort,
  descriptorPort,
  DesktopStartError,
  moveBindingPort,
  nextFreePort,
  openStartLog,
  portTools,
  readPortRecord,
  readStartOutput,
  startFailure,
  writePortRecord,
  type PortTools,
} from "../src/desktop-start.js";

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
export function childEnvironment(panel = false): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        [
          "HOME",
          "PATH",
          "PLAYWRIGHT_BROWSERS_PATH",
          "USER",
          "LOGNAME",
          "SHELL",
          "TMPDIR",
          "LANG",
          "CODEX_HOME",
          // Where the agent desk and the trove live, when the person moved them.
          "CLAWDTIME_CONFIG_HOME",
          // Route owner texts to the explicitly configured production line.
          // The project key and recipient stay in the protected state files.
          // Calls keep the line that `clawdtime connect` saved.
          "CHERT_LINE_ID",
          "CHERT_API_BASE",
          // The language model and speech of the ClawdTime agent.
          "CLAWDTIME_OPENAI_API_KEY",
          "OPENAI_API_KEY",
          "CLAWDTIME_SUPERVISOR_MODEL",
          // Which chat answers: "agent" for the chat agent, else the supervisor.
          "CLAWDTIME_CHAT",
          // The model that reads what a message asks of the screen.
          "CLAWDTIME_READER_MODEL",
          // The structured intent reader of the task service, when it is "on".
          "CLAWDTIME_SEMANTIC_TASKS",
          // The language model that plans each action of computer use.
          "CLAWDTIME_COMPUTER_MODEL",
          // The browser driver of computer use, when it is "on".
          "CLAWDTIME_COMPUTER_BROWSER",
          // One log line with the time of each step of computer use, when it is "on".
          "CLAWDTIME_COMPUTER_TIMING",
          // The owner's trust: no question before an action of the ask policy.
          "CLAWDTIME_COMPUTER_TRUST",
          // The call and the text to the owner for a question that waits.
          "CLAWDTIME_COMPUTER_REACH",
          "CLAWDTIME_COMPUTER_REACH_SECONDS",
          // The program of ClawdTime's own browser, when it is not found by itself.
          "CLAWDTIME_OWN_BROWSER_PATH",
          "CLAWDTIME_TRANSCRIBE_MODEL",
          // The owner's names for speech to text, comma separated.
          "CLAWDTIME_VOCABULARY",
          "CLAWDTIME_SPEAK_MODEL",
          "CLAWDTIME_VOICE",
          // Jobs and applications from the panel's chat: the coding agent, the
          // terminal, the switch for work in a service with no coding worker,
          // and the switch that turns both off.
          // The model that reads a picture of the screen.
          "CLAWDTIME_VISION_MODEL",
          "CLAWDTIME_JOB_AGENT",
          "CLAWDTIME_JOB_TERMINAL",
          "CLAWDTIME_SIMULATION_JOBS",
          "CLAWDTIME_DESKTOP_WINDOWS",
          // A service that a test started must know it: it then opens no
          // window on the person's screen.
          "VITEST",
        ].includes(key) ||
        // The keys, the model, the effort and the speed of the planner of
        // computer use, for every provider that it can use.
        plannerVariables.includes(key) ||
        (panel &&
          [
            "CLAWDTIME_SPACE_LEFT_SHORTCUT",
            "CLAWDTIME_SPACE_RIGHT_SHORTCUT",
            "CLAWDTIME_DESKTOP_SWITCHING",
            // The pace of the guided cursor: calm or fast.
            "CLAWDTIME_CURSOR_PACE",
            // The Mac app that owns this desktop. The panel then adds
            // Settings and Stop ClawdTime to its menu, and opens them there.
            "CLAWDTIME_APP_BUNDLE",
          ].includes(key)) ||
        key.startsWith("LC_"),
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

/**
 * The arguments of node that start the desktop service. A source checkout
 * keeps the TS loader. Installed artifacts hold dist JavaScript and production
 * dependencies only, so they never need tsx: the compiled service sits in
 * `scripts/` when root is the dist folder, and in `dist/scripts/` when root is
 * the package root of a release runtime.
 */
export function serviceEntry(root: string): string[] {
  const source = join(root, "scripts/task-server.ts");
  if (!existsSync(source))
    for (const compiled of [
      join(root, "scripts/task-server.js"),
      join(root, "dist/scripts/task-server.js"),
    ])
      if (existsSync(compiled)) return [compiled];
  return ["--import", "tsx", source];
}

/** What a launch leaves running: the service, and the panel it started. */
export interface DesktopLaunch {
  /** The service process; `child` only when this launch started it. */
  service: { pid: number; child?: ChildProcess };
  /** The panel that this launch started, if it started one. */
  panel?: ChildProcess;
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
    /** False: start or check the service alone, with no panel. */
    panel?: boolean;
    /** The caller stays in the foreground and owns the panel: it stays in the caller's process group. */
    foreground?: boolean;
    /** Who holds a port. Tests replace it, so that no test reads this Mac's ports. */
    ports?: PortTools;
  } = {},
): Promise<DesktopLaunch | undefined> {
  const print = dependencies.print ?? console.log;
  if (!args.length || args[0] === "--help") {
    print(
      "task:desktop --state PRIVATE_DIR --project SELECTED_PROJECT [--port 13326] [--session-file PRIVATE_FILE] [--worker codex --checks PRIVATE_FILE] [--calls-config PRIVATE_FILE] [--panel-binary ABSOLUTE_EXECUTABLE] [--agents false] [--tucked true | --chat true]\nSimulation is the default. --tucked true starts the panel as the mascot and takes no focus. A click on the mascot opens the chat. --chat true opens the chat with the keys and one suggested first request, also in a panel that is open already. The panel lists no coding-agent sessions; its bubble names one that waits for you, and --agents false turns that reading off. Closing the panel leaves the service and task running. Startup does not call or capture. It renews the desktop's own expired task session only while no task, call or voice is open. Without --port, a desktop whose port another program holds moves to a free port and keeps it. The service writes its output, masked, to desktop-start.log in the state folder. Calls configuration requires Codex and an existing session; each call needs separate operator authorization.",
    );
    return undefined;
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
        "--chat",
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
  const explicitPort = options["--port"] !== undefined;
  const requestedPort = Number(options["--port"] ?? defaultDesktopPort);
  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 1024 ||
    requestedPort > 65535
  )
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
  if (
    options["--chat"] !== undefined &&
    !["true", "false"].includes(options["--chat"])
  )
    throw Error("Use --chat true or --chat false.");
  if (options["--chat"] === "true" && options["--tucked"] === "true")
    throw Error("Use --chat true or --tucked true, not both.");
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
    findNativeHelper("ClawdTimeTaskPanel", { root }) ??
    join(root, "mac/.build/debug/ClawdTimeTaskPanel");
  if (!isAbsolute(panelBinary))
    throw Error("Panel binary must be an absolute path.");
  if (!lstatSync(panelBinary).isFile())
    throw Error("Build the native ClawdTimeTaskPanel executable first.");
  accessSync(panelBinary, constants.X_OK);
  const fingerprintAt = (port: number) =>
    desktopConfigurationFingerprint({
      projectRoot,
      worker: worker as "simulation" | "codex",
      checksFingerprint,
      port,
      ...(sessionFingerprint ? { sessionFingerprint } : {}),
      ...(callsFingerprint ? { callsFingerprint } : {}),
    });
  const panelPath = join(state, "desktop-panel.json");
  const descriptorPath = join(state, "desktop-service.json");
  const ownerPath = join(state, "owner.lock");
  const launchPath = join(state, "desktop-launch.lock");
  // The kernel holds the launch lock for this process alone and ends it when
  // the process ends, also on a kill. So a launcher that is gone never blocks
  // the next one, and a live one is never displaced: no process id is read.
  const launch = takeProcessLock(launchPath, {
    version: 2,
    pid: process.pid,
    startedAt: Date.now(),
  });
  if (!launch)
    throw Error(
      "Another desktop launch runs now. Wait until it ends, then try again.",
    );
  const spawnProcess = dependencies.spawn ?? spawn;
  const request = dependencies.request ?? fetch;
  let serviceChild: ChildProcess | undefined;
  let serviceFailed: (() => DesktopStartError) | undefined;
  let servicePid = 0;
  try {
    const attach = existsSync(ownerPath);
    // Without --port the desktop keeps the port that it chose before. A
    // running one is reached on the port that its own descriptor names.
    let port = explicitPort
      ? requestedPort
      : (readPortRecord(state) ??
        (attach ? descriptorPort(state) : null) ??
        defaultDesktopPort);
    if (!attach)
      port = await startPort({
        port,
        movable: !explicitPort,
        state,
        fingerprintAt,
        tools: dependencies.ports ?? portTools,
        print,
      });
    const configurationFingerprint = fingerprintAt(port);
    const origin = `http://127.0.0.1:${port}`;
    if (!attach) {
      const serviceArgs = [
        ...serviceEntry(root),
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
      // The service writes to the startup log itself, masked, so the log
      // outlives this launcher. What this start wrote says why it stopped.
      const log = openStartLog(state);
      const failure = (code?: number | null, signal?: string | null) =>
        startFailure(readStartOutput(log.path, log.offset), {
          port,
          state,
          log: log.path,
          code,
          signal,
        });
      try {
        serviceChild = spawnProcess(process.execPath, serviceArgs, {
          cwd: root,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...childEnvironment(), CLAWDTIME_SERVICE_OUTPUT: "log" },
        });
      } finally {
        closeSync(log.fd);
      }
      serviceChild.once("error", (error: NodeJS.ErrnoException) => {
        serviceFailed = () =>
          new DesktopStartError(
            "stopped",
            `The desktop service could not start${error.code ? ` (${error.code})` : ""}.`,
            [`The service log is ${log.path}.`],
          );
      });
      serviceChild.once("exit", (code, signal) => {
        serviceFailed = () => failure(code, signal);
      });
      serviceChild.unref();
    }
    const deadline = Date.now() + (dependencies.startupMs ?? 10000);
    let ready = false;
    do {
      // The service stopped as it started: say why, from its own words.
      if (serviceFailed) throw serviceFailed();
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
        servicePid = owner.pid;
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
    const service = {
      pid: servicePid,
      ...(serviceChild ? { child: serviceChild } : {}),
    };
    if (dependencies.panel === false) {
      print(
        `Desktop service ready for ${projectRoot} at ${origin}. No panel was opened. Simulation: ${worker === "simulation"}.`,
      );
      return { service };
    }
    // Tucked: the panel starts as the mascot and takes no focus. Chat: the
    // chat opens with the keys, also in a panel that is open already.
    const panelArgs = ["--config", panelPath];
    if (options["--tucked"] === "true") panelArgs.push("--tucked");
    if (options["--chat"] === "true") panelArgs.push("--chat");
    const panel = spawnProcess(panelBinary, panelArgs, {
      cwd: root,
      // A foreground owner keeps the panel in its own process group, so that
      // ending the group ends the panel. The service always has a session of
      // its own: a kill of the group never cuts its shutdown short.
      detached: dependencies.foreground !== true,
      stdio: "ignore",
      // Only the native panel consumes the operator's explicit Space mappings.
      // Preserve absence: the launcher must never invent shortcut defaults.
      env: childEnvironment(true),
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
    return { service, panel };
  } finally {
    // The file stays: removing it could let two launchers lock two files.
    launch.release();
  }
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves a symlinked entry module to its real path, while argv keeps
    // the installer's stable symlink. Compare identities, not lexical paths.
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // Importing from a test/embedding process with a missing argv path is not a launch.
    return false;
  }
}

/**
 * The port where this start runs its service. A ClawdTime desktop of another
 * install on it is named, never displaced. Another program on it moves a
 * desktop that has no explicit --port to the next free port, which is kept
 * for later starts, so two installs never fight over one port.
 */
async function startPort(input: {
  port: number;
  movable: boolean;
  state: string;
  fingerprintAt: (port: number) => string;
  tools: PortTools;
  print: (message: string) => void;
}): Promise<number> {
  const owner = await checkPort(input.port, input.tools);
  if (owner.state === "free") return input.port;
  if (owner.state === "clawdtime")
    throw new DesktopStartError(
      "other_install",
      "ClawdTime is already running from another install, on the port that this desktop uses.",
      [
        owner.other.verified
          ? `It runs as process ${owner.other.pid}, with the desktop folder ${owner.other.state}.`
          : `It listens on port ${input.port}${owner.other.pid ? ` as process ${owner.other.pid}` : ""}, and its own files could not confirm it.`,
        "To use it or stop it, run clawdtime onboard. Or quit it there, then start again.",
      ],
      owner.other,
    );
  const program = owner.name
    ? `another program (${owner.name})`
    : "another program";
  const taken = () =>
    new DesktopStartError(
      "port_in_use",
      `Port ${input.port} is in use by ${program}, so the desktop cannot start there. Quit that program, then try again.`,
      owner.pid ? [`That program runs as process ${owner.pid}.`] : [],
    );
  if (!input.movable) throw taken();
  const next = await nextFreePort(input.port, input.tools);
  if (next === null) throw taken();
  // A desktop that started before keeps its identity on the new port.
  if (
    existsSync(join(input.state, "desktop-binding.json")) &&
    !moveBindingPort(
      input.state,
      input.fingerprintAt(input.port),
      input.fingerprintAt(next),
    )
  )
    throw taken();
  writePortRecord(input.state, next);
  input.print(
    `Port ${input.port} is in use by ${program}. This desktop uses port ${next} from now on.`,
  );
  return next;
}

if (isMainEntry()) {
  desktopCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof DesktopStartError
        ? error.message
        : "Desktop launch refused or unconfirmed. Preserve private state and ownership locks; check the explicit project, private configuration, service readiness and native panel build.",
    );
    process.exitCode = 1;
  });
}
