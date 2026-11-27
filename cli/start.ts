/**
 * `clawdtime start`: starts the desktop, that is the desktop service and the
 * panel with the mascot. It runs the start command of the README:
 *
 *   CLAWDTIME_CHAT=agent npm run task:desktop -- \
 *     --state ~/.local/share/clawdtime/desktop --project PROJECT
 *
 * The state folder is the one that the other commands look in. The first start
 * chooses the project, and the service keeps it, so later starts use it again.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { linkedDesktopFolder } from "../connectors/agents/desktop-chat.js";
import { stateRoot } from "../connectors/agents/hooks.js";
import { desktopCli, type DesktopLaunch } from "./task-desktop.js";
import { findNativeHelper } from "../src/native-helpers.js";
import { takeProcessLock } from "../src/process-lock.js";

export const defaultProjectName = "clawdtime-work";
/** The one command that installs the newest release, or updates to it. */
export const installCommand =
  "curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh";
export const startHelp = `clawdtime start: start the ClawdTime desktop, the service and the panel with the mascot
  clawdtime start [--project PATH] [--tucked true] [--foreground]
  --project PATH   the folder where coding work runs. The first start chooses it and
                   later starts keep it. Without it, the first start uses ~/${defaultProjectName}
  --tucked true    start the panel as the mascot alone, with no focus
  --foreground     stay in the foreground and own the desktop: print {"type":"ready"} when it
                   is ready, {"type":"panel","state":"closed"} when the panel closes, and
                   stop the panel and the service on SIGTERM or Ctrl+C
It starts the desktop as the README does, with CLAWDTIME_CHAT=agent and the state folder
~/.local/share/clawdtime/desktop (CLAWDTIME_DESKTOP_STATE changes it, and so does the choice
of setup to use the ClawdTime of another install). When the service runs already, it opens
the panel again. When it does not start, it says why; the service log is desktop-start.log
in the state folder.`;
const usage =
  "Use: clawdtime start [--project PATH] [--tucked true|false] [--foreground]";
/** The line that --foreground writes on standard output when the desktop is ready. */
export const readyLine = JSON.stringify({ type: "ready" });
/** The line that --foreground writes when the panel closes while the desktop runs. */
export const panelClosedLine = JSON.stringify({
  type: "panel",
  state: "closed",
});
/** The lock of the one process that owns a desktop in the foreground. */
export const foregroundLockName = "desktop-owner.lock";

/** What --foreground needs from the process. Tests replace each one. */
export interface ForegroundHooks {
  /** Where SIGTERM, SIGINT and SIGHUP come from. */
  signals?: Pick<NodeJS.EventEmitter, "on" | "off">;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
  /** True when the program that started this one is gone. */
  orphaned?: () => boolean;
  /** Standard output, which carries the ready line alone. */
  write?: (line: string) => void;
  pollMs?: number;
  /** How long a stop waits for the service to leave. */
  stopMs?: number;
}

export interface StartDependencies {
  /** The environment. CLAWDTIME_CHAT is set on it, so the service gets it. */
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  /** The checkout (scripts/, mac/, node_modules) or the app/ folder of a release runtime (dist/, native/). */
  root?: string;
  print?: (line: string) => void;
  /** Starts the desktop. Tests replace it, so that no test starts a service or a panel. */
  desktop?: (
    args: string[],
    dependencies: {
      root: string;
      print: (line: string) => void;
      panel?: boolean;
      foreground?: boolean;
    },
  ) => Promise<DesktopLaunch | undefined | void>;
  /** False: start the service alone, with no panel. The Mac app's setup uses it. */
  panel?: boolean;
  foreground?: ForegroundHooks;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The checkout of this command: dist/cli/ and cli/ both sit in it. */
export function checkoutRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(`${sep}dist${sep}cli`)
    ? resolve(here, "../..")
    : resolve(here, "..");
}

/** The project that the desktop state is bound to, from its own owner-only file. */
function boundProject(state: string): string | undefined {
  const file = join(state, "local-config.json");
  if (!existsSync(file)) return undefined;
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(
      `${file} cannot be read. Look at it before you start the desktop.`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 65536
    )
      throw new Error(
        `${file} is not an owner-only file of this user. Look at it before you start the desktop.`,
      );
    // Only the project is taken. The keys of the file stay in it.
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const project =
      value && typeof value === "object"
        ? (value as { projectRoot?: unknown }).projectRoot
        : undefined;
    return typeof project === "string" && isAbsolute(project)
      ? project
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(
        `${file} cannot be read. Look at it before you start the desktop.`,
      );
    throw error;
  } finally {
    closeSync(fd);
  }
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Starts the desktop. Nothing here calls, captures or sends input. */
export async function startCli(
  args: string[],
  dependencies: StartDependencies = {},
) {
  const options: Record<string, string> = {};
  let foreground = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "help" || name === "--help" || name === "-h")
      return (dependencies.print ?? console.log)(startHelp);
    if (name === "--foreground") {
      const next = args[i + 1];
      if (foreground || (next !== undefined && !next.startsWith("--")))
        throw new Error(usage);
      foreground = true;
      continue;
    }
    const value = args[i + 1];
    if (
      !["--project", "--tucked"].includes(name) ||
      options[name] !== undefined ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(usage);
    options[name] = value;
    i++;
  }
  // In the foreground, standard output carries the ready line alone.
  const print =
    dependencies.print ??
    (foreground
      ? (line: string) => process.stderr.write(`${line}\n`)
      : console.log);
  const tucked = options["--tucked"];
  if (tucked !== undefined && tucked !== "true" && tucked !== "false")
    throw new Error("Use --tucked true or --tucked false.");
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const cwd = dependencies.cwd ?? process.cwd();
  const root = dependencies.root ?? checkoutRoot();

  const named = env.CLAWDTIME_DESKTOP_STATE;
  if (named && !isAbsolute(named))
    throw new Error("CLAWDTIME_DESKTOP_STATE must be an absolute path.");
  const configRoot = stateRoot({ env, home });
  // A link that setup saved names the desktop of another install to use.
  const state =
    named || linkedDesktopFolder(configRoot) || join(configRoot, "desktop");

  const panel = findNativeHelper("ClawdTimeTaskPanel", { root, env });
  if (!panel)
    throw new Error(
      // A release runtime has no mac/ folder to build in: it ships native/.
      existsSync(join(root, "mac"))
        ? `Build the panel first: cd ${join(root, "mac")} && swift build --product ClawdTimeTaskPanel`
        : `The panel is missing from ${join(root, "native")}. Install ClawdTime again: ${installCommand}`,
    );

  const bound = boundProject(state);
  let project: string;
  if (options["--project"] !== undefined) {
    const chosen = resolve(cwd, options["--project"]);
    if (!isDirectory(chosen))
      throw new Error(`The project folder ${chosen} does not exist.`);
    project = realpathSync(chosen);
    if (bound && bound !== project)
      throw new Error(
        `This desktop works in ${bound}. Start it without --project to use that folder.`,
      );
  } else if (bound) {
    if (!isDirectory(bound))
      throw new Error(
        `The project folder of this desktop is gone. Make it again: mkdir -p ${bound}`,
      );
    project = bound;
  } else {
    const fresh = join(home, defaultProjectName);
    mkdirSync(fresh, { recursive: true, mode: 0o700 });
    project = realpathSync(fresh);
    print(
      `Coding work runs in ${project}. To choose another folder, start with --project PATH the first time.`,
    );
  }
  const inside = relative(
    project,
    existsSync(state) ? realpathSync(state) : state,
  );
  if (
    !inside ||
    (inside !== ".." && !inside.startsWith(".." + sep) && !isAbsolute(inside))
  )
    throw new Error(
      `The project folder must not hold the state folder ${state}. Choose a folder of its own, such as ~/code/my-project.`,
    );

  // The chat agent answers in the panel, as in the start command of the README.
  if (!env.CLAWDTIME_CHAT) env.CLAWDTIME_CHAT = "agent";
  const launch = () =>
    (dependencies.desktop ?? desktopCli)(
      [
        "--state",
        state,
        "--project",
        project,
        ...(tucked ? ["--tucked", tucked] : []),
        "--panel-binary",
        panel,
      ],
      {
        root,
        print,
        ...(dependencies.panel === false ? { panel: false } : {}),
        ...(foreground ? { foreground: true } : {}),
      },
    );
  if (!foreground) {
    await launch();
    if (dependencies.panel !== false)
      print(
        "Click the mascot to open the chat. clawdtime computer doctor says what is ready.",
      );
    return;
  }
  await holdDesktop(state, launch, print, dependencies.foreground ?? {});
}

/**
 * --foreground: one owner holds the desktop for its whole life. It says
 * ready on standard output, then stops the panel and the service on SIGTERM,
 * SIGINT or SIGHUP, or when the program that started it is gone. When the
 * service ends by itself, the panel ends too and the command fails.
 */
async function holdDesktop(
  state: string,
  launch: () => Promise<DesktopLaunch | undefined | void>,
  print: (line: string) => void,
  hooks: ForegroundHooks,
) {
  const signals = hooks.signals ?? process;
  const kill = hooks.kill ?? ((pid, signal) => process.kill(pid, signal));
  const alive = hooks.alive ?? isAlive;
  const orphaned = hooks.orphaned ?? (() => process.ppid === 1);
  const write =
    hooks.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const pollMs = hooks.pollMs ?? 500;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = takeProcessLock(join(state, foregroundLockName), {
    version: 1,
    pid: process.pid,
    startedAt: Date.now(),
  });
  if (!lock)
    throw new Error(
      "Another ClawdTime runs this desktop in the foreground. Stop it there first.",
    );
  let stop = false;
  let wake = () => {};
  const onSignal = () => {
    stop = true;
    wake();
  };
  const names = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const name of names) signals.on(name, onSignal);
  const endPanel = (started: DesktopLaunch) => {
    const child = started.panel;
    if (child && child.exitCode === null && child.signalCode == null)
      child.kill("SIGTERM");
  };
  // While this owner holds the desktop, a panel that closes is told on
  // standard output: the Mac app then shows its own menu again.
  let holding = true;
  try {
    const started = await launch();
    if (!started) throw new Error("The desktop did not start.");
    const pid = started.service.pid;
    if (!stop) {
      print(
        "Click the mascot to open the chat. clawdtime computer doctor says what is ready.",
      );
      write(readyLine);
      const panel = started.panel;
      const closed = () => {
        if (holding && !stop) write(panelClosedLine);
      };
      if (panel)
        if (panel.exitCode !== null || panel.signalCode != null) closed();
        else panel.once("exit", closed);
    }
    const ending = await new Promise<"stop" | "ended">((done) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const check = () => {
        const result =
          stop || orphaned() ? "stop" : alive(pid) ? null : "ended";
        if (!result) return;
        if (timer) clearInterval(timer);
        wake = () => {};
        done(result);
      };
      wake = check;
      check();
      timer = setInterval(check, pollMs);
    });
    holding = false;
    endPanel(started);
    if (ending === "ended")
      throw new Error(
        "The desktop service ended. Start ClawdTime again to go on.",
      );
    // The service closes its calls and its work on SIGTERM, then leaves.
    kill(pid, "SIGTERM");
    const deadline = Date.now() + (hooks.stopMs ?? 9000);
    while (alive(pid) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, Math.min(pollMs, 100)));
    print(
      alive(pid)
        ? "The desktop service is still stopping. It ends by itself."
        : "The desktop stopped.",
    );
  } finally {
    holding = false;
    for (const name of names) signals.off(name, onSignal);
    lock.release();
  }
}
