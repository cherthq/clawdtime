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
import { stateRoot } from "../connectors/agents/hooks.js";
import { desktopCli } from "./task-desktop.js";
import { findNativeHelper } from "../src/native-helpers.js";

export const defaultProjectName = "clawdtime-work";
/** The one command that installs the newest release, or updates to it. */
export const installCommand =
  "curl -fsSL https://github.com/cherthq/clawdtime/releases/latest/download/install.sh | sh";
export const startHelp = `clawdtime start: start the ClawdTime desktop, the service and the panel with the mascot
  clawdtime start [--project PATH] [--tucked true]
  --project PATH   the folder where coding work runs. The first start chooses it and
                   later starts keep it. Without it, the first start uses ~/${defaultProjectName}
  --tucked true    start the panel as the mascot alone, with no focus
It starts the desktop as the README does, with CLAWDTIME_CHAT=agent and the state folder
~/.local/share/clawdtime/desktop (CLAWDTIME_DESKTOP_STATE changes it). When the service
runs already, it opens the panel again.`;
const usage = "Use: clawdtime start [--project PATH] [--tucked true|false]";

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
    dependencies: { root: string; print: (line: string) => void },
  ) => Promise<void>;
}

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
  const print = dependencies.print ?? console.log;
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "help" || name === "--help" || name === "-h")
      return print(startHelp);
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
  const state = named || join(stateRoot({ env, home }), "desktop");

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
  await (dependencies.desktop ?? desktopCli)(
    [
      "--state",
      state,
      "--project",
      project,
      ...(tucked ? ["--tucked", tucked] : []),
      "--panel-binary",
      panel,
    ],
    { root, print },
  );
  print(
    "Click the mascot to open the chat. clawdtime computer doctor says what is ready.",
  );
}
