/**
 * `clawdtime uninstall`: takes ClawdTime off this Mac.
 *
 * 1. It stops the shared connection, the desktop service and the panel. Each
 *    gets a signal only after `ps` still says it is that process.
 * 2. It unpairs this Mac from the shared number with the Mac's own device
 *    credential (`POST /device/unpair`). When the coordinator does not answer,
 *    the pairing stays in place and the output says how to finish.
 * 3. It moves ClawdTime's own folders to the Trash: the runtime, the
 *    `clawdtime` command link and, unless --keep-settings, the settings. It
 *    deletes nothing.
 *
 * A receipt of an effect whose outcome is unknown or pending stays where it
 * is, and the output names it. A source checkout, the project folder, a link
 * that runs a source build and any path outside ClawdTime's own folders are
 * never moved. The list that it prints before it asks is the most it moves.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { stateRoot } from "../connectors/agents/hooks.js";
import { desktopStateFolder } from "../connectors/agents/desktop-chat.js";
import { sharedOrigin } from "../connectors/shared/shared-mac.js";
import { readDesktopPrivateJSON } from "../src/control/task-desktop-config.js";
import {
  readSharedPairing,
  sharedConnectionLock,
  sharedPairingPaths,
  type SharedConnection,
} from "../src/onboard/pairing.js";
import {
  managedConnection,
  processIdentity,
  processStartMs,
  stopDesktopService,
} from "../src/onboard/system.js";
import { processLockHolder } from "../src/process-lock.js";
import { checkoutRoot, defaultProjectName } from "./start.js";

export const uninstallHelp = `clawdtime uninstall: take ClawdTime off this Mac
  clawdtime uninstall [--keep-settings] [--yes] [--plan [--json]]
  --keep-settings  keep the settings and keys, so that a new install finds them
  --yes            do not ask first
  --plan           list what it would do, and change nothing. --json: as one JSON object
It stops the shared connection, the desktop service and the panel. It unpairs this Mac
from the shared number when the coordinator answers. Then it moves the runtime, the
clawdtime command and the settings to the Trash. It deletes nothing. Receipts with an
unknown or pending outcome, your project folder and any source checkout stay.`;
const usage =
  "Use: clawdtime uninstall [--keep-settings] [--yes] [--plan [--json]]";
export const noTerminalLine =
  "Run clawdtime uninstall in Terminal to confirm, or add --yes.";

/** What the uninstall needs from the Mac. Tests replace each one. */
export interface UninstallPorts {
  /** A reason that nothing may change now, such as an install that runs. */
  blocked: () => Promise<string | null>;
  /** Stops the shared connection, the desktop service and the panel, each
   * after its identity check. It says what it stopped. It throws with a plain
   * sentence when one cannot be stopped. */
  stop: () => Promise<string[]>;
  /** Moves one path to the Trash. */
  trash: (path: string) => Promise<void>;
  request: typeof fetch;
  /** Asks the question in a terminal. Null: there is no terminal. */
  confirm: (question: string) => Promise<boolean | null>;
  /** Other processes of this person that still run from these folders. */
  others: (folders: string[]) => Promise<number[]>;
}

export interface UninstallDependencies {
  env?: Record<string, string | undefined>;
  home?: string;
  uid?: number;
  print?: (line: string) => void;
  ports?: Partial<UninstallPorts>;
}

/** One path that the uninstall moves to the Trash. */
export interface UninstallItem {
  path: string;
  what: string;
  /** Part of the settings: --keep-settings keeps it. */
  settings: boolean;
  /** Only once the coordinator has unpaired this Mac. */
  afterUnpair?: boolean;
}
/** One path that stays, and why. */
export interface KeptPath {
  path: string;
  why: string;
  /** Kept by --keep-settings alone: a revoked pairing in it may still go. */
  settings?: boolean;
}
export interface UninstallPlan {
  unpair: { origin: string } | null;
  /** The pairing file cannot be used, so this Mac cannot unpair itself. */
  pairingProblem: string | null;
  move: UninstallItem[];
  keep: KeptPath[];
  notes: string[];
}

/** The folders of ClawdTime in this home folder. */
export function uninstallPaths(system: {
  env: Record<string, string | undefined>;
  home: string;
}) {
  const support = join(
    system.home,
    "Library",
    "Application Support",
    "ClawdTime",
  );
  return {
    support,
    runtime: join(support, "runtime"),
    link: join(system.home, ".local", "bin", "clawdtime"),
    state: stateRoot(system),
    config: join(system.home, ".config", "clawdtime"),
    logs: join(system.home, "Library", "Logs", "ClawdTime"),
    pairing: sharedPairingPaths(system.home).file,
    project: join(system.home, defaultProjectName),
  };
}

const inside = (path: string, folder: string) =>
  path === folder ||
  path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

const lstat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** A folder that holds the source of ClawdTime, or any git checkout. */
function isCheckout(folder: string) {
  return (
    existsSync(join(folder, ".git")) ||
    (existsSync(join(folder, "cli", "main.ts")) &&
      existsSync(join(folder, "scripts", "install.sh")))
  );
}

/** The source checkout that holds the file, or null. */
function checkoutOf(file: string) {
  for (let folder = dirname(file); dirname(folder) !== folder;) {
    if (isCheckout(folder)) return folder;
    folder = dirname(folder);
  }
  return null;
}

/**
 * Why a folder may not be moved as ClawdTime's own, or null when it may: a
 * real folder, not a link, named for ClawdTime, not the home folder or a
 * folder above it, not a checkout, and not one that holds the code that runs.
 */
function folderProblem(
  folder: string,
  home: string,
  /** False for a fixed folder inside one of ClawdTime's own, such as its runtime. */
  named = true,
): string | null {
  const stat = lstat(folder);
  if (!stat) return null;
  if (stat.isSymbolicLink())
    return "it is a link, so what it points to is not ClawdTime's to move";
  if (!stat.isDirectory()) return "it is not a folder";
  if (!isAbsolute(folder) || resolve(folder) !== folder)
    return "it is not an absolute path";
  if (inside(home, folder)) return "it holds your home folder";
  if (named && !/clawdtime/i.test(basename(folder)))
    return "it is not a folder of ClawdTime by its name";
  if (isCheckout(folder)) return "it is a source checkout";
  const running = checkoutRoot();
  if (isCheckout(running) && inside(running, folder))
    return "it holds the source checkout that runs this command";
  return null;
}

/** What to do with the `clawdtime` command link. */
function commandLink(
  link: string,
  runtime: string,
  home: string,
): UninstallItem | KeptPath | null {
  const stat = lstat(link);
  if (!stat) return null;
  if (!stat.isSymbolicLink())
    return { path: link, why: "it is a file of your own, not a link" };
  const target = resolve(dirname(link), readlinkSync(link));
  let physicalRuntime = runtime;
  try {
    physicalRuntime = realpathSync(runtime);
  } catch {
    // No runtime: only the path itself can match.
  }
  let real = target;
  try {
    real = realpathSync(link);
  } catch {
    // A link to nothing: its own target is all there is.
  }
  const release = (path: string, folder: string) =>
    inside(path, folder) && path.endsWith(`${sep}bin${sep}clawdtime`);
  if (release(target, runtime) || release(real, physicalRuntime))
    return { path: link, what: "the clawdtime command", settings: false };
  const checkout = checkoutOf(real) ?? checkoutOf(target);
  return {
    path: link,
    why: checkout
      ? `it runs the source build in ${tilde(checkout, home)}`
      : `it points to ${tilde(target, home)}, not to the ClawdTime runtime`,
  };
}

/** A path as the person reads it: ~ for the home folder, also through its real path. */
function tilde(path: string, home: string) {
  if (inside(path, home)) return `~${path.slice(home.length)}`;
  try {
    const real = realpathSync(home);
    if (inside(path, real)) return `~${path.slice(real.length)}`;
  } catch {
    // No home folder to name.
  }
  return path;
}

const uncertainStates = [
  "unknown",
  "outcome_unknown",
  "uncertain",
  "pending",
  "running",
  "started",
  "in_progress",
  "in_flight",
];
const receiptName = /receipt|operations|journal|ledger/i;
const pendingWhy = "it has receipts with an unknown or pending outcome";

/** Why a receipt database stays, or null when it holds no open receipt. */
function databaseProblem(file: string): string | null {
  let db: DatabaseSync;
  try {
    // With no write-ahead log the file is whole: open it as immutable, which
    // writes nothing beside it. Otherwise read the log as SQLite does.
    if (existsSync(`${file}-wal`))
      db = new DatabaseSync(file, { readOnly: true });
    else {
      const url = pathToFileURL(file);
      url.searchParams.set("immutable", "1");
      db = new DatabaseSync(url, { readOnly: true });
    }
  } catch {
    return "it cannot be read, so its receipts cannot be checked";
  }
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    );
    const list = uncertainStates.map(() => "?").join(",");
    let open = 0;
    if (tables.has("effects"))
      open += Number(
        db
          .prepare(
            `SELECT count(*) AS n FROM effects WHERE json_extract(body,'$.state') IN (${list})`,
          )
          .get(...uncertainStates)?.n ?? 0,
      );
    if (tables.has("entities"))
      open += Number(
        db
          .prepare(
            `SELECT count(*) AS n FROM entities WHERE json_extract(body,'$.state') IN (${list}) OR json_extract(body,'$.outcome') IN (${list}) OR json_extract(body,'$.result') IN (${list})`,
          )
          .get(...uncertainStates, ...uncertainStates, ...uncertainStates)?.n ??
          0,
      );
    return open ? pendingWhy : null;
  } catch {
    return "it cannot be read, so its receipts cannot be checked";
  } finally {
    db.close();
  }
}

/** True when a JSON value holds a state, outcome or result that is not settled. */
function hasOpenOutcome(value: unknown, depth = 0): boolean {
  if (depth > 24 || !value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((entry) => hasOpenOutcome(entry, depth + 1));
  const record = value as Record<string, unknown>;
  for (const key of ["state", "outcome", "result"])
    if (
      typeof record[key] === "string" &&
      uncertainStates.includes(record[key] as string)
    )
      return true;
  return Object.values(record).some((entry) =>
    hasOpenOutcome(entry, depth + 1),
  );
}

/** Why a JSON file stays, or null. */
function jsonProblem(file: string): string | null {
  const name = basename(file);
  let value: unknown;
  try {
    if (statSync(file).size > 4 << 20) throw Error("too_large");
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return receiptName.test(name)
      ? "it cannot be read, so its receipts cannot be checked"
      : null;
  }
  // Calling policies that a no took out while no service ran to take them back.
  if (
    name === "owner.json" &&
    Array.isArray((value as { revoke?: unknown })?.revoke) &&
    (value as { revoke: unknown[] }).revoke.length > 0
  )
    return "it holds calling policies that wait to be taken back";
  return hasOpenOutcome(value) ? pendingWhy : null;
}

/**
 * The receipts in these folders that must stay: a database or a file whose
 * receipt has an unknown or pending outcome, or one that cannot be read. A
 * source checkout inside them stays too. Links are never followed.
 */
export function receiptsToKeep(roots: string[], limit = 50_000): KeptPath[] {
  const kept: KeptPath[] = [];
  for (const root of roots) {
    const found: KeptPath[] = [];
    const stack = [root];
    let seen = 0;
    while (stack.length) {
      const path = stack.pop()!;
      if (++seen > limit) break;
      const stat = lstat(path);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (path !== root && isCheckout(path)) {
          found.push({ path, why: "it is a source checkout" });
          continue;
        }
        let names: string[];
        try {
          names = readdirSync(path);
        } catch {
          found.push({
            path,
            why: "it cannot be read, so it cannot be checked",
          });
          continue;
        }
        for (const name of names.sort().reverse()) stack.push(join(path, name));
        continue;
      }
      if (!stat.isFile()) continue;
      const why = /\.(sqlite3?|db)$/.test(path)
        ? databaseProblem(path)
        : path.endsWith(".json")
          ? jsonProblem(path)
          : null;
      if (why) found.push({ path, why });
    }
    if (seen > limit)
      kept.push({
        path: root,
        why: "it holds too many files to check each for receipts",
      });
    else kept.push(...found);
  }
  return kept;
}

/** The files that stay with a kept database: its log and its index. */
const companions = (path: string) =>
  /\.(sqlite3?|db)$/.test(path)
    ? [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]
    : [path];

/**
 * The paths to move for one item when some paths inside it stay: the item
 * itself when nothing in it stays, else each of its other entries.
 */
function expand(path: string, keep: string[]): string[] {
  if (keep.some((kept) => inside(path, kept))) return [];
  if (!keep.some((kept) => inside(kept, path))) return [path];
  const stat = lstat(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => expand(join(path, name), keep));
}

/** The project folder that the desktop is bound to, from its own file. */
function boundProject(system: {
  env: Record<string, string | undefined>;
  home: string;
}) {
  const folder = join(stateRoot(system), "desktop");
  try {
    const value = readDesktopPrivateJSON(join(folder, "local-config.json")) as {
      projectRoot?: unknown;
    };
    return typeof value.projectRoot === "string" &&
      isAbsolute(value.projectRoot)
      ? value.projectRoot
      : null;
  } catch {
    return null;
  }
}

/** Reads this Mac and says what the uninstall would do. It changes nothing. */
export function planUninstall(input: {
  env: Record<string, string | undefined>;
  home: string;
  keepSettings: boolean;
}): UninstallPlan {
  const { home } = input;
  const paths = uninstallPaths(input);
  const move: UninstallItem[] = [];
  const keep: KeptPath[] = [];
  const notes: string[] = [];

  // The runtime: the whole folder of ClawdTime when it holds the runtime alone.
  const support = lstat(paths.support);
  if (support) {
    const problem = folderProblem(paths.support, home);
    const names = problem
      ? []
      : readdirSync(paths.support).filter((name) => name !== ".DS_Store");
    if (problem) keep.push({ path: paths.support, why: problem });
    else if (names.every((name) => name === "runtime"))
      move.push({ path: paths.support, what: "the runtime", settings: false });
    else if (lstat(paths.runtime)) {
      const runtimeProblem = folderProblem(paths.runtime, home, false);
      if (runtimeProblem)
        keep.push({ path: paths.runtime, why: runtimeProblem });
      else
        move.push({
          path: paths.runtime,
          what: "the runtime",
          settings: false,
        });
    }
  }

  const link = commandLink(paths.link, paths.runtime, home);
  if (link && "what" in link) move.push(link);
  else if (link) keep.push(link);

  const settings: [string, string][] = [
    [paths.state, "settings, keys, chats and receipts"],
    [paths.config, "the pairing and its receipts"],
    [paths.logs, "logs"],
  ];
  for (const [path, what] of settings) {
    if (!lstat(path) || move.some((item) => inside(path, item.path))) continue;
    const problem = folderProblem(path, home);
    if (problem) keep.push({ path, why: problem });
    else if (input.keepSettings)
      keep.push({
        path,
        why: `${what}: --keep-settings keeps them`,
        settings: true,
      });
    else move.push({ path, what, settings: true });
  }

  // The pairing: this Mac unpairs itself first. A file that cannot be used
  // cannot unpair, so it stays.
  const pairing = readSharedPairing(paths.pairing);
  let unpair: UninstallPlan["unpair"] = null;
  let pairingProblem: string | null = null;
  if (pairing.kind === "paired") {
    unpair = { origin: pairing.connection.origin };
    move.push({
      path: paths.pairing,
      what: "the pairing of this Mac, once it is unpaired",
      settings: false,
      afterUnpair: true,
    });
  } else if (pairing.kind === "unusable") {
    pairingProblem =
      "the pairing file cannot be read, so this Mac cannot unpair itself";
    keep.push({ path: paths.pairing, why: pairingProblem });
  }

  // The person's own work.
  for (const project of new Set(
    [paths.project, boundProject(input)].filter(
      (path): path is string => !!path && existsSync(path),
    ),
  ))
    keep.push({ path: project, why: "your project folder" });

  keep.push(...receiptsToKeep(settingsRoots(move)));

  const hooks = [
    [
      join(
        input.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
        "settings.json",
      ),
      "claude-code",
    ],
    [join(input.env.CODEX_HOME || join(home, ".codex"), "hooks.json"), "codex"],
  ];
  for (const [file, agent] of hooks)
    try {
      if (readFileSync(file!, "utf8").includes("agent-hook.js"))
        notes.push(
          `${tilde(file!, home)} has hooks that run ClawdTime. To take them out first, run: clawdtime agents hooks uninstall --agent ${agent}`,
        );
    } catch {
      // No hooks of that agent.
    }
  if (!/\.app\/Contents\/Resources\/runtime\//.test(checkoutRoot() + sep))
    for (const app of [
      "/Applications/ClawdTime.app",
      join(home, "Applications", "ClawdTime.app"),
    ])
      if (existsSync(app))
        notes.push(
          `${tilde(app, home)} stays. To remove it and its login item, open it and choose Settings, About, Uninstall.`,
        );
  return { unpair, pairingProblem, move, keep, notes };
}

const settingsRoots = (move: UninstallItem[]) =>
  move.filter((item) => item.settings).map((item) => item.path);

/** What the coordinator said to the Mac's own unpair request. */
export type UnpairResult = "unpaired" | "refused" | "pending";

/**
 * Unpairs this Mac with its own device credential. "refused": the
 * coordinator does not accept the credential, so it gives this Mac no
 * access. Any other answer, or none, leaves the outcome open: "pending".
 */
export async function unpairThisMac(
  connection: Pick<SharedConnection, "origin" | "credential">,
  request: typeof fetch = fetch,
): Promise<UnpairResult> {
  let response: Response;
  try {
    response = await request(
      `${sharedOrigin(connection.origin)}/device/unpair`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${connection.credential}`,
        },
        body: "{}",
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return "pending";
  }
  if (response.status === 401 || response.status === 403) return "refused";
  if (!response.ok) return "pending";
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
  } | null;
  return body?.ok === true ? "unpaired" : "pending";
}

/** A `clawdtime shared run` by its command line, from the launcher or the entry file. */
export function isSharedRunCommand(command: string) {
  return /(?:^|[/\s])(?:main\.(?:js|ts)|clawdtime) shared run(?: --owned)?$/.test(
    command,
  );
}

/** The panel of this desktop: the panel binary with this exact configuration file. */
export function isPanelCommand(command: string, config: string) {
  const marker = ` --config ${config}`;
  const at = command.lastIndexOf(marker);
  if (at < 0) return false;
  const rest = command.slice(at + marker.length);
  return (
    command.slice(0, at).endsWith("/ClawdTimeTaskPanel") &&
    (rest === "" || rest === " --tucked")
  );
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** This person's processes: id and whole command line. */
function listProcesses(): Promise<{ pid: number; command: string }[]> {
  const uid = process.getuid?.() ?? -1;
  return new Promise((done) =>
    execFile(
      "/bin/ps",
      ["-axww", "-o", "pid=", "-o", "uid=", "-o", "command="],
      {
        timeout: 5000,
        maxBuffer: 8 << 20,
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      },
      (error, stdout) => {
        if (error) return done([]);
        const rows: { pid: number; command: string }[] = [];
        for (const line of stdout.split("\n")) {
          const found = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
          if (found && Number(found[2]) === uid)
            rows.push({ pid: Number(found[1]), command: found[3]! });
        }
        done(rows);
      },
    ),
  );
}

/** Thrown with a sentence for the person when a step may not go on. */
class Refusal extends Error {}

/** The shared connection: the one setup manages, or one that a person or the app started. */
async function stopSharedConnection(system: {
  env: Record<string, string | undefined>;
  home: string;
}) {
  const managed = managedConnection({
    home: system.home,
    command: { executable: process.execPath, args: [] },
    env: system.env,
  });
  const lock = sharedConnectionLock(system.home);
  const held = processLockHolder(lock);
  try {
    if (!held || (await managed.holder())?.managed) {
      await managed.stop();
      return !!held;
    }
  } catch {
    throw new Refusal("The shared connection did not stop.");
  }
  const record = z
    .object({ pid: z.number().int().positive(), startedAt: z.number() })
    .passthrough()
    .safeParse(held);
  const identity = record.success
    ? await processIdentity(record.data.pid)
    : null;
  if (
    !record.success ||
    !identity ||
    !isSharedRunCommand(identity.command) ||
    !(processStartMs(identity.start) <= record.data.startedAt)
  )
    throw new Refusal(
      "Another process holds the shared connection of this Mac, and it could not be identified as clawdtime shared run.",
    );
  process.kill(record.data.pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (processLockHolder(lock)) {
    if (Date.now() > deadline)
      throw new Refusal(
        `The shared connection (process ${record.data.pid}) did not stop.`,
      );
    await pause(200);
  }
  return true;
}

/** The desktop service, through the same identity check as setup. */
async function stopDesktop(system: {
  env: Record<string, string | undefined>;
  home: string;
}) {
  const folder = desktopStateFolder(system);
  if (!folder) return false;
  let pid: number | null = null;
  try {
    pid = z
      .object({ pid: z.number().int().positive() })
      .strict()
      .parse(readDesktopPrivateJSON(join(folder, "owner.lock"))).pid;
  } catch {
    pid = null;
  }
  const running = pid !== null && alive(pid);
  try {
    await stopDesktopService(system);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Refusal(
      code === "desktop_owned_in_foreground"
        ? "The ClawdTime app, or clawdtime start --foreground, runs the desktop. Quit it first, or uninstall from the app: Settings, About, Uninstall."
        : code === "desktop_did_not_stop"
          ? "The desktop service did not stop."
          : "The desktop service could not be identified, so it got no signal.",
    );
  }
  return running;
}

/** The panel of this desktop, by its exact configuration file. */
async function stopPanel(system: {
  env: Record<string, string | undefined>;
  home: string;
}) {
  const folder = desktopStateFolder(system);
  if (!folder) return false;
  const config = join(folder, "desktop-panel.json");
  const panels = (await listProcesses()).filter((row) =>
    isPanelCommand(row.command, config),
  );
  for (const { pid } of panels) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (panels.some(({ pid }) => alive(pid))) {
    if (Date.now() > deadline) throw new Refusal("The panel did not stop.");
    await pause(200);
  }
  return panels.length > 0;
}

/** Moves a path to the Trash with the file manager of macOS, which deletes nothing. */
const trashScript = `ObjC.import("Foundation");
function run(argv) {
  const files = $.NSFileManager.defaultManager;
  for (const path of argv)
    if (!files.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, null))
      throw new Error("not moved");
  return "moved";
}`;
export function macTrash(path: string) {
  return new Promise<void>((done, fail) =>
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", trashScript, path],
      { timeout: 60_000, maxBuffer: 64 * 1024 },
      (error) => (error ? fail(Error("trash_failed")) : done()),
    ),
  );
}

/** The ports of the real Mac. */
export function macUninstallPorts(system: {
  env: Record<string, string | undefined>;
  home: string;
}): UninstallPorts {
  const paths = uninstallPaths(system);
  return {
    blocked: async () => {
      try {
        const pid = Number(
          readFileSync(join(paths.runtime, ".install-lock", "pid"), "utf8"),
        );
        if (Number.isInteger(pid) && pid > 0 && alive(pid))
          return `An install runs now (process ${pid}). Wait for it to end, then run this again.`;
      } catch {
        // No install runs.
      }
      const folder = desktopStateFolder(system);
      if (folder && processLockHolder(join(folder, "desktop-owner.lock")))
        return "The ClawdTime app, or clawdtime start --foreground, runs the desktop. Quit it first, or uninstall from the app: Settings, About, Uninstall.";
      return null;
    },
    stop: async () => {
      // Remote access ends first, then the desktop and its panel.
      const stopped: string[] = [];
      if (await stopSharedConnection(system))
        stopped.push("the shared connection");
      if (await stopDesktop(system)) stopped.push("the desktop service");
      if (await stopPanel(system)) stopped.push("the panel");
      return stopped;
    },
    trash: macTrash,
    request: fetch,
    confirm: async (question) => {
      if (!process.stdin.isTTY) return null;
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (await terminal.question(question)).trim() === "yes";
      } finally {
        terminal.close();
      }
    },
    others: async (folders) => {
      const real = folders.flatMap((folder) => {
        try {
          return [folder, realpathSync(folder)];
        } catch {
          return [folder];
        }
      });
      return (await listProcesses())
        .filter(
          (row) =>
            row.pid !== process.pid &&
            real.some((folder) => row.command.includes(folder + sep)),
        )
        .map((row) => row.pid);
    },
  };
}

function planLines(plan: UninstallPlan, home: string) {
  const lines = ["clawdtime uninstall does this:"];
  lines.push(
    "  1. Stops the shared connection, the desktop service and the panel, when they run.",
  );
  lines.push(
    plan.unpair
      ? `  2. Unpairs this Mac from the shared number at ${plan.unpair.origin}. When the coordinator does not answer, the pairing stays in place.`
      : "  2. This Mac has no pairing with a shared number to undo.",
  );
  const moves = plan.move.filter((item) => !item.afterUnpair);
  const after = plan.move.filter((item) => item.afterUnpair);
  lines.push(
    moves.length || after.length
      ? "  3. Moves these to the Trash:"
      : "  3. Finds nothing of ClawdTime to move.",
  );
  for (const item of moves)
    lines.push(`       ${tilde(item.path, home)}  (${item.what})`);
  for (const item of after)
    if (
      !plan.move.some(
        (other) => other !== item && inside(item.path, other.path),
      )
    )
      lines.push(`       ${tilde(item.path, home)}  (${item.what})`);
  if (plan.keep.length) {
    lines.push("It keeps these where they are:");
    for (const kept of plan.keep)
      lines.push(`       ${tilde(kept.path, home)}: ${kept.why}`);
  }
  for (const note of plan.notes) lines.push(`Note: ${note}`);
  return lines;
}

export async function uninstallCli(
  args: string[],
  dependencies: UninstallDependencies = {},
): Promise<number> {
  const print = dependencies.print ?? ((line: string) => console.log(line));
  if (args.includes("--help") || args.includes("help")) {
    print(uninstallHelp);
    return 0;
  }
  const known = ["--keep-settings", "--yes", "--plan", "--json"];
  if (
    args.some((arg) => !known.includes(arg)) ||
    (args.includes("--json") && !args.includes("--plan"))
  ) {
    print(usage);
    return 2;
  }
  const uid = dependencies.uid ?? process.getuid?.() ?? -1;
  if (uid === 0) {
    print(
      "Run clawdtime uninstall without sudo. ClawdTime lives in your own home folder. Nothing changed.",
    );
    return 1;
  }
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const system = { env, home };
  const ports: UninstallPorts = {
    ...macUninstallPorts(system),
    ...dependencies.ports,
  };
  const keepSettings = args.includes("--keep-settings");
  const plan = planUninstall({ env, home, keepSettings });

  if (args.includes("--plan")) {
    const blocked = await ports.blocked();
    if (args.includes("--json")) {
      print(
        JSON.stringify({
          version: 1,
          unpair: plan.unpair,
          pairingProblem: plan.pairingProblem,
          move: plan.move.map((item) => ({
            path: item.path,
            display: tilde(item.path, home),
            what: item.what,
            settings: item.settings,
            ...(item.afterUnpair ? { afterUnpair: true } : {}),
          })),
          keep: plan.keep.map((kept) => ({
            path: kept.path,
            display: tilde(kept.path, home),
            why: kept.why,
          })),
          notes: plan.notes,
          blocked,
        }),
      );
      return 0;
    }
    for (const line of planLines(plan, home)) print(line);
    if (blocked) print(`It cannot run now: ${blocked}`);
    return 0;
  }

  const blocked = await ports.blocked();
  if (blocked) {
    print(`${blocked} Nothing changed.`);
    return 1;
  }
  for (const line of planLines(plan, home)) print(line);
  if (!args.includes("--yes")) {
    const answer = await ports.confirm("Type yes to uninstall ClawdTime: ");
    if (answer === null) {
      print(noTerminalLine);
      return 3;
    }
    if (!answer) {
      print("Stopped. Nothing changed.");
      return 1;
    }
  }
  // One empty line between the plan and what happened: the app shows the rest.
  print("");

  let stopped: string[];
  try {
    stopped = await ports.stop();
  } catch (error) {
    print(
      `${error instanceof Error && error.message ? error.message : "A process of ClawdTime did not stop."} Nothing was unpaired or moved.`,
    );
    return 1;
  }
  print(
    stopped.length
      ? `Stopped ${joinWords(stopped)}.`
      : "Nothing of ClawdTime was running.",
  );

  // Unpair, then decide the pairing file: it goes only when this Mac has no access.
  const extraKeep: KeptPath[] = [];
  let unpaired = false;
  const pairing = readSharedPairing(uninstallPaths(system).pairing);
  if (plan.unpair && pairing.kind === "paired") {
    const result = await unpairThisMac(pairing.connection, ports.request);
    if (result === "unpaired") {
      unpaired = true;
      print(
        `Unpaired this Mac from the shared number at ${plan.unpair.origin}.`,
      );
    } else if (result === "refused") {
      unpaired = true;
      print(
        `The coordinator at ${plan.unpair.origin} no longer accepts this Mac's credential, so this Mac has no access there.`,
      );
    } else {
      const file = uninstallPaths(system).pairing;
      extraKeep.push({
        path: file,
        why: "the pairing of this Mac, kept while the unpairing is pending",
      });
      print(
        `Unpairing is pending: the coordinator at ${plan.unpair.origin} did not confirm it. The pairing stays in ${tilde(file, home)}, and nothing on this Mac uses it now. To finish, pair another Mac with clawdtime shared pair --replace, which unpairs this one. Or install ClawdTime again and run clawdtime uninstall while this Mac is online.`,
      );
    }
  } else if (plan.pairingProblem)
    print(`This Mac was not unpaired: ${plan.pairingProblem}.`);

  // Check the receipts again now that nothing runs: a stop can leave more.
  const keep = [
    ...plan.keep,
    ...receiptsToKeep(settingsRoots(plan.move)).filter(
      (found) => !plan.keep.some((kept) => kept.path === found.path),
    ),
    ...extraKeep,
  ];
  const keepPaths = keep
    .filter((kept) => !kept.settings)
    .flatMap((kept) => companions(kept.path));
  const chosen = plan.move.filter((item) => !item.afterUnpair || unpaired);
  const targets = chosen
    .filter(
      (item) =>
        !chosen.some(
          (other) => other.path !== item.path && inside(item.path, other.path),
        ),
    )
    .flatMap((item) => expand(item.path, keepPaths));

  const paths = uninstallPaths(system);
  const runtimeTarget = (path: string) =>
    inside(path, paths.support) || inside(paths.runtime, path);
  const others = targets.some(runtimeTarget)
    ? await ports.others([paths.support])
    : [];
  const moved: string[] = [];
  const failed: string[] = [];
  for (const path of targets) {
    // The command link goes only when the runtime that it runs went too.
    if (path === paths.link && failed.some(runtimeTarget)) {
      failed.push(path);
      continue;
    }
    try {
      await ports.trash(path);
      if (lstat(path)) throw Error("still_there");
      moved.push(path);
    } catch {
      failed.push(path);
    }
  }

  if (moved.length) {
    print("Moved to the Trash:");
    for (const path of moved) print(`  ${tilde(path, home)}`);
  }
  if (failed.length) {
    print("Not moved, so still in place:");
    for (const path of failed) print(`  ${tilde(path, home)}`);
  }
  const shown = keep.filter((kept) => lstat(kept.path));
  if (shown.length) {
    print("Kept in place:");
    for (const kept of shown) print(`  ${tilde(kept.path, home)}: ${kept.why}`);
  }
  if (others.length)
    print(
      `Still running from the runtime, and left as they are: process ${others.join(", ")}. Each goes on until it ends.`,
    );
  for (const note of plan.notes) print(`Note: ${note}`);
  if (failed.length) {
    print(
      "ClawdTime is not fully uninstalled. Run clawdtime uninstall again to move what is left.",
    );
    return 1;
  }
  print("ClawdTime is uninstalled.");
  return 0;
}

function joinWords(words: string[]) {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
