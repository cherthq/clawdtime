/**
 * `clawdtime connect`: connects ClawdTime on this Mac to Chert, so that it has
 * a phone line and can reach its owner on it.
 *
 * Ten steps, in order. Each one first looks at what is there and skips what is
 * done, so the command can run again at any time and goes on where it stopped.
 * Each step prints one plain line. Interactive commands of chert (sign-in,
 * onboarding, LiveKit keys) run in the person's own terminal.
 *
 * What it never does: print a key or a full phone number (a number is shown
 * by its last two digits), take a yes for the owner, or write a file that is
 * not an owner-only file of this user. `--check` changes nothing and starts
 * nothing: it only reports.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { stateRoot } from "../connectors/agents/hooks.js";
import { checkTexts } from "../connectors/agents/texts.js";
import { checkKey } from "../connectors/computer/keys.js";
import {
  chertKeyFile,
  normalizePhone,
  phoneEnding,
  readChertKey,
  readOwner,
  writeChertKey,
  writeOwner,
  type OwnerRecord,
} from "../connectors/shared/owner.js";
import {
  PrivateFileError,
  folderProblem,
  notPrivateFile,
  readPrivateJSON,
  writePrivateFile,
  writePrivateJSON,
} from "../connectors/shared/private-file.js";
import { computerCli } from "./computer.js";
import { proactivePolicySchema } from "../src/attention/proactive-policy.js";
import {
  findDesktopService,
  linkedDesktopFolder,
} from "../connectors/agents/desktop-chat.js";
import {
  connectPolicy,
  consentQuestion,
  desktopDescriptor,
  findOnPath,
  fitsReach,
  outboundFolder,
  pinProblem,
  pinShort,
  readProactiveConfig,
  retentionChecks,
  sendToService,
  setUpCallsApi,
  setUpOutbound,
  writeProactiveConfig,
  type RetentionChecks,
} from "./connect-calls.js";

export const connectHelp = `clawdtime connect: connect ClawdTime to Chert and get a phone line, one step at a time
  clawdtime connect [--check] [--yes] [--phone NUMBER] [--consent yes|no] [--api-key-env NAME]
Each step looks first and skips what is done. Run it again at any time: it goes on where it stopped.
  --check             report only. Nothing is changed and nothing is started
  --yes               take every default that needs no secret
  --phone NUMBER      your own mobile number, with the country code
  --consent yes|no    your answer to "${consentQuestion}"
  --api-key-env NAME  read the project API key from this variable, not from a hidden prompt
Exit: 0 all ready, 3 ready with optional parts still to do, 1 a needed part is missing, 2 wrong use.
See SETUP_CLAWDTIME.md, "Connect to Chert in one command".`;

export const installCommand = "npm install -g @trychert/facetime@beta";
export const developerPage = "https://app.trychert.com/developer";
export const messagesPage = "https://app.trychert.com/imessage";

export interface ChertRun {
  /** The exit code; null when it did not end by itself. */
  status: number | null;
  /** What it printed. Empty for an interactive run, which prints to the terminal. */
  stdout: string;
  /** No chert command is on the PATH. */
  missing?: boolean;
}
export interface ConnectDependencies {
  env?: Record<string, string | undefined>;
  home?: string;
  print?: (line: string) => void;
  /** One question in the terminal. Null: nobody can answer it here. */
  ask?: (question: string, hidden: boolean) => Promise<string | null>;
  /** A person is at this terminal, so interactive chert commands can run in it. */
  interactive?: boolean;
  /** Runs chert: a --json run is read, an interactive run uses the terminal. */
  chert?: (
    args: string[],
    options: { interactive: boolean; cwd: string },
  ) => ChertRun;
  request?: typeof fetch;
  now?: () => number;
  /** The folder of the line agent: line/ of this checkout. */
  lineDirectory?: string;
  /** The node that runs the call worker of the outbound line. */
  nodeBinary?: string;
  /** The pinned checks of the line's retention guard. */
  retention?: RetentionChecks | null;
}

interface Flags {
  check: boolean;
  yes: boolean;
  phone?: string;
  consent?: "yes" | "no";
  apiKeyEnv?: string;
}
class UsageError extends Error {}
function parseFlags(args: string[]): Flags | "help" {
  const flags: Flags = { check: false, yes: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (name === "--help" || name === "help" || name === "-h") return "help";
    if (seen.has(name)) throw new UsageError(`Give ${name} once.`);
    seen.add(name);
    if (name === "--check") flags.check = true;
    else if (name === "--yes") flags.yes = true;
    else if (["--phone", "--consent", "--api-key-env"].includes(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${name} needs a value.`);
      if (name === "--phone") {
        if (!normalizePhone(value))
          throw new UsageError(
            "--phone needs your full number with the country code, as +1 415 555 0100.",
          );
        flags.phone = value;
      } else if (name === "--consent") {
        if (value !== "yes" && value !== "no")
          throw new UsageError("Use --consent yes, or --consent no.");
        flags.consent = value;
      } else {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
          throw new UsageError(
            "--api-key-env takes the name of a variable, not a key.",
          );
        flags.apiKeyEnv = value;
      }
    } else
      throw new UsageError(
        `Unknown option ${name.startsWith("-") ? name : "(a value without an option)"}. Run: clawdtime connect --help`,
      );
  }
  return flags;
}

/** The terminal: a question, and a hidden one for a key. Null when stdin is no terminal. */
export async function askInTerminal(
  question: string,
  hidden: boolean,
): Promise<string | null> {
  const input = process.stdin;
  if (!input.isTTY) return null;
  if (!hidden) {
    const lines = createInterface({ input, output: process.stderr });
    try {
      return await lines.question(question);
    } finally {
      lines.close();
    }
  }
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const finish = (answer: string | null) => {
      input.off("data", typed);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      resolve(answer);
    };
    const typed = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish(value);
        if (character === "\u0003" || character === "\u0004")
          return finish(null);
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", typed);
  });
}

function defaultChert(env: Record<string, string | undefined>) {
  return (
    args: string[],
    options: { interactive: boolean; cwd: string },
  ): ChertRun => {
    const file = findOnPath("chert", env);
    if (!file) return { status: null, stdout: "", missing: true };
    const result = spawnSync(file, args, {
      cwd: existsSync(options.cwd) ? options.cwd : homedir(),
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: options.interactive ? "inherit" : ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
      ...(options.interactive ? {} : { timeout: 120_000 }),
    });
    return {
      status: result.status,
      stdout: options.interactive ? "" : (result.stdout ?? ""),
    };
  };
}

/** The JSON records that a chert --json run printed. */
function records(stdout: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object") found.push(value);
    } catch {
      // Not a record.
    }
  }
  return found;
}

/** Words of chert for the person: no number, no address, no control character, short. */
export function plain(text: unknown, largest = 240): string {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\s@]+@[^\s@]+/g, "your account")
    .replace(/\+?\d[\d\s().-]{5,}\d/g, "a number")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, largest);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const placeholder = (value: string | undefined) =>
  !value?.trim() || /^(wss:\/\/)?YOUR_/.test(value.trim());
const yesWord = (answer: string | null, preset: boolean) =>
  answer === null || !answer.trim() ? preset : /^(y|yes)$/i.test(answer.trim());

type Kind = "ready" | "todo" | "failed";
interface Step {
  kind: Kind;
  text: string;
}
const ready = (text: string): Step => ({ kind: "ready", text });
const todo = (text: string): Step => ({ kind: "todo", text });
const failed = (text: string): Step => ({ kind: "failed", text });

interface Context extends Flags {
  env: Record<string, string | undefined>;
  home: string;
  root: string;
  print: (line: string) => void;
  ask: (question: string, hidden: boolean) => Promise<string | null>;
  interactive: boolean;
  chert: NonNullable<ConnectDependencies["chert"]>;
  request: typeof fetch;
  now: () => number;
  lineDirectory: string;
  nodeBinary: string;
  retention: RetentionChecks | null | undefined;
  chertHome: string;
  desktopFolder: string;
  who?: Who;
  project?: { id: string; name: string };
  /** proactive.json changed: the desktop service reads it when it starts. */
  restart: boolean;
}

/** The folder line/ of this checkout, for the source and for the build. */
export function checkoutLineDirectory() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = here.endsWith("/dist/cli")
    ? resolve(here, "../..")
    : resolve(here, "..");
  return join(root, "line");
}

/** Runs the command. The result is the exit code. */
export async function connectCli(
  args: string[],
  deps: ConnectDependencies = {},
): Promise<number> {
  const print = deps.print ?? console.log;
  let flags: Flags | "help";
  try {
    flags = parseFlags(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    print(error.message);
    return 2;
  }
  if (flags === "help") {
    print(connectHelp);
    return 0;
  }
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const root = stateRoot({ env, home });
  const named = (value: string | undefined) =>
    value && isAbsolute(value) ? value : undefined;
  const ctx: Context = {
    ...flags,
    env,
    home,
    root,
    print,
    ask: deps.ask ?? askInTerminal,
    interactive: deps.interactive ?? !!process.stdin.isTTY,
    chert: deps.chert ?? defaultChert(env),
    request: deps.request ?? fetch,
    now: deps.now ?? Date.now,
    lineDirectory: deps.lineDirectory ?? checkoutLineDirectory(),
    nodeBinary: deps.nodeBinary ?? process.execPath,
    retention: deps.retention,
    chertHome: named(env.CHERT_HOME) ?? join(home, ".chert"),
    desktopFolder:
      named(env.CLAWDTIME_DESKTOP_STATE) ??
      linkedDesktopFolder(root) ??
      join(root, "desktop"),
    restart: false,
  };
  if (ctx.check)
    print("Checking only: nothing is changed and nothing is started.");
  const results: { n: number; kind: Kind; required: boolean }[] = [];
  const show = (n: number, title: string, step: Step, required: boolean) => {
    results.push({ n, kind: step.kind, required });
    print(`${n}. ${title}: ${step.text}`);
    return step;
  };
  const steps: [string, boolean, () => Promise<Step> | Step][] = [
    ["Chert command", true, () => chertInstalled(ctx)],
    ["Sign-in", true, () => signedIn(ctx)],
    ["Project", true, () => project(ctx)],
    ["Line", true, () => lineReady(ctx)],
    ["Line agent", true, () => lineAgent(ctx)],
    ["Your number", false, () => ownerPhone(ctx)],
    ["Calls and texts to you", false, () => consent(ctx)],
    ["Project API key", false, () => apiKey(ctx)],
    ["Outbound calls", false, () => outbound(ctx)],
  ];
  for (const [index, [title, required, run]] of steps.entries()) {
    let step: Step;
    try {
      step = await run();
    } catch (error) {
      step = failed(
        error instanceof PrivateFileError
          ? error.message
          : "this step stopped on an error. Nothing more was changed in it",
      );
    }
    show(index + 1, title, step, required);
    // Without the command, a sign-in and a project, no later step can be checked.
    if (index < 3 && step.kind !== "ready") return summary(ctx, results);
  }
  for (const row of await doctorRows(ctx)) {
    results.push({
      n: 10,
      kind: row.ready ? "ready" : "todo",
      required: false,
    });
    print(`10. ${row.name}: ${row.detail}`);
  }
  return summary(ctx, results);
}

function summary(
  ctx: Context,
  results: { n: number; kind: Kind; required: boolean }[],
): number {
  const needed = results.filter((r) => r.required && r.kind !== "ready");
  const optional = [
    ...new Set(
      results.filter((r) => !r.required && r.kind !== "ready").map((r) => r.n),
    ),
  ];
  if (ctx.restart)
    ctx.print(
      "Start the ClawdTime desktop service again, so that it reads its call settings (proactive.json and calls.json).",
    );
  if (needed.length) {
    ctx.print(
      `Not ready: step ${needed.map((r) => r.n).join(", ")}. Do what it says, then run clawdtime connect again.`,
    );
    return 1;
  }
  if (optional.length) {
    ctx.print(
      `Your line is ready. Still to do, when you want them: step ${optional.join(", ")}. Run clawdtime connect again after each.`,
    );
    return 3;
  }
  ctx.print("All ready: ClawdTime is on your Chert line and can reach you.");
  return 0;
}

// 1 ---------------------------------------------------------------------------
function chertInstalled(ctx: Context): Step {
  const run = ctx.chert(["--version"], {
    interactive: false,
    cwd: ctx.lineDirectory,
  });
  if (run.missing)
    return failed(
      `missing. Install it: ${installCommand}. Then run clawdtime connect again`,
    );
  if (run.status !== 0)
    return failed(
      `installed, but it did not run. Install it again: ${installCommand}`,
    );
  const version = /[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*/.exec(run.stdout)?.[0];
  return ready(version ? `installed, ${version}` : "installed");
}

// 2 ---------------------------------------------------------------------------
interface Who {
  signedIn: boolean;
  confirmed: boolean;
  projectId?: string;
  projectName?: string;
  expiresAt?: number;
}
function whoami(ctx: Context): Who {
  const run = ctx.chert(["whoami", "--json"], {
    interactive: false,
    cwd: ctx.lineDirectory,
  });
  const record = records(run.stdout).find(
    (r) => r.code === "whoami" || r.command === "whoami",
  );
  if (!record) return { signedIn: false, confirmed: false };
  return {
    signedIn: record.signed_in === true,
    confirmed: record.confirmed !== false,
    ...(typeof record.project_id === "string" && uuid.test(record.project_id)
      ? { projectId: record.project_id.toLowerCase() }
      : {}),
    ...(typeof record.project_name === "string"
      ? { projectName: plain(record.project_name, 80) }
      : {}),
    ...(typeof record.expires_at === "number"
      ? { expiresAt: record.expires_at }
      : {}),
  };
}
function signedIn(ctx: Context): Step {
  let who = whoami(ctx);
  let now = "";
  if (!who.signedIn) {
    if (ctx.check) return failed("not signed in. Run: chert login");
    if (!ctx.interactive)
      return failed(
        "not signed in. Run chert login in a terminal, then clawdtime connect again",
      );
    ctx.print(
      "   Signing in with chert login. Approve this Mac in your browser.",
    );
    ctx.chert(["login"], { interactive: true, cwd: ctx.lineDirectory });
    who = whoami(ctx);
    ctx.who = who;
    if (!who.signedIn)
      return failed(
        "not signed in: chert login did not finish. Run: chert login",
      );
    now = " now";
  }
  ctx.who = who;
  const soon =
    who.expiresAt !== undefined && who.expiresAt - ctx.now() < 3 * 86_400_000
      ? `. It ends on ${new Date(who.expiresAt).toISOString().slice(0, 10)}: run chert login again before then`
      : "";
  return ready(
    `signed in${now}${who.confirmed ? "" : " (Chert could not be reached to confirm it)"}${soon}`,
  );
}

// 3 ---------------------------------------------------------------------------
function project(ctx: Context): Step {
  const who = ctx.who;
  // The line runs on the project that line/.env.local names, when it names one.
  const read = readLineEnv(join(ctx.lineDirectory, ".env.local"));
  const named =
    read && "values" in read
      ? read.values.CLAWDTIME_LINE_CHERT_PROJECT?.trim().toLowerCase()
      : undefined;
  if (named && uuid.test(named) && named !== who?.projectId) {
    ctx.project = { id: named, name: "the project of line/.env.local" };
    return ready(
      `${named}, as line/.env.local names it${who?.projectId ? `. The sign-in of this Mac names ${who.projectId}` : ""}`,
    );
  }
  if (!who?.projectId)
    return failed(
      "this sign-in names no project. Run chert login again and choose the project",
    );
  ctx.project = { id: who.projectId, name: who.projectName || "your project" };
  return ready(`${ctx.project.name} (${ctx.project.id})`);
}

// 4 ---------------------------------------------------------------------------
function doctorLine(ctx: Context): Step {
  const run = ctx.chert(["doctor", "--json", "--project", ctx.project!.id], {
    interactive: false,
    cwd: ctx.lineDirectory,
  });
  // chert can print a notice with the same command before its checks: the
  // record that holds the checks is the one to read.
  const found = records(run.stdout);
  const record =
    found.find((r) => Array.isArray(r.checks)) ??
    found.find((r) => r.code === "doctor");
  const checks = Array.isArray(record?.checks)
    ? (record.checks as Record<string, unknown>[])
    : [];
  const chosen = checks.find((check) => check?.name === "project");
  if (chosen && chosen.status === "fail")
    return failed(
      `${plain(chosen.detail) || "this sign-in cannot use the project"} Run chert login and choose that project, or change CLAWDTIME_LINE_CHERT_PROJECT in line/.env.local`,
    );
  const line = checks.find((check) => check?.name === "line");
  if (!line) return failed("chert doctor did not report the line");
  if (line.status === "pass") return ready("ready");
  if (line.status === "warn") return ready(`ready. ${plain(line.detail)}`);
  const fix = plain(line.fix);
  return todo(`${plain(line.detail) || "not ready"}${fix ? ` ${fix}` : ""}`);
}
async function lineReady(ctx: Context): Promise<Step> {
  const first = doctorLine(ctx);
  if (first.kind !== "todo" || ctx.check) return first;
  // Onboarding gets a line for the project of the sign-in, never for another one.
  if (ctx.project!.id !== ctx.who?.projectId)
    return failed(
      `${first.text} The line agent names another project than the sign-in of this Mac, so clawdtime connect does not start chert onboard for it`,
    );
  if (!ctx.interactive)
    return failed(
      `${first.text} Run chert onboard in a terminal, then clawdtime connect again`,
    );
  const go =
    ctx.yes ||
    yesWord(
      await ctx.ask(
        `${first.text} Get a line now with chert onboard? It verifies your phone and places a short demo call. [Y/n] `,
        false,
      ),
      true,
    );
  if (!go)
    return failed(
      `${first.text} Run chert onboard, then clawdtime connect again`,
    );
  ctx.print(
    "   Getting a line with chert onboard. When it asks about your agent, choose your own LiveKit agent: ClawdTime is that agent.",
  );
  ctx.chert(["onboard"], { interactive: true, cwd: ctx.lineDirectory });
  const second = doctorLine(ctx);
  return second.kind === "ready"
    ? ready(`${second.text} now`)
    : failed(`${second.text}. Then run clawdtime connect again`);
}

// 5 ---------------------------------------------------------------------------
type EnvRead =
  | { text: string; values: Record<string, string | undefined> }
  | { problem: string }
  | null;
/** line/.env.local: for its owner only, in a folder that only its owner can write. */
function readLineEnv(file: string): EnvRead {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  const folder = folderProblem(dirname(file), "owner-writable");
  if (folder && folder !== "missing") return { problem: folder };
  const mine = process.getuid === undefined || stat.uid === process.getuid();
  if (!stat.isFile() || !mine || stat.nlink !== 1)
    return { problem: notPrivateFile(file) };
  if (stat.mode & 0o077)
    return {
      problem: `${file} is open to other users, so it is not read and not changed. Run: chmod 600 ${file}`,
    };
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { problem: notPrivateFile(file) };
  }
  try {
    const now = fstatSync(fd);
    if (now.ino !== stat.ino || now.size > 65536)
      return { problem: notPrivateFile(file) };
    const text = readFileSync(fd, "utf8");
    return { text, values: parseEnv(text) };
  } finally {
    closeSync(fd);
  }
}
/** Sets values that are not set. Other lines stay as they are. */
function withValues(text: string, values: Record<string, string>) {
  let lines = text.split("\n");
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  for (const [name, value] of Object.entries(values)) {
    const empty = new RegExp(`^\\s*${name}\\s*=\\s*$`);
    const index = lines.findIndex((line) => empty.test(line));
    if (index >= 0) lines[index] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}
/** Makes the file owner-only again when chert wrote it open. No link is followed. */
function closeFile(file: string) {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      const mine =
        process.getuid === undefined || stat.uid === process.getuid();
      if (stat.isFile() && mine && stat.nlink === 1 && stat.mode & 0o077)
        fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  } catch {
    // The next read says what is wrong.
  }
}
async function lineAgent(ctx: Context): Promise<Step> {
  const dir = ctx.lineDirectory;
  const file = join(dir, ".env.local");
  const short = "line/.env.local";
  const missing: string[] = [];
  const did: string[] = [];
  if (!existsSync(join(dir, "node_modules")))
    missing.push(`its packages: run npm install in ${dir}`);
  let read = readLineEnv(file);
  if (read === null) {
    if (ctx.check)
      return todo(
        [
          ...missing,
          `${short} is not there. clawdtime connect makes it from .env.example`,
        ].join("; "),
      );
    writePrivateFile(file, readFileSync(join(dir, ".env.example"), "utf8"), {
      folder: "owner-writable",
    });
    did.push(`made ${short} from .env.example, for you only`);
    read = readLineEnv(file);
  }
  if (!read) return failed(`${short} could not be made`);
  if ("problem" in read) return failed(read.problem);

  // The values that need no secret.
  const set: Record<string, string> = {};
  if (!read.values.AGENT_NAME?.trim()) set.AGENT_NAME = "clawdtime";
  const named = read.values.CLAWDTIME_LINE_CHERT_PROJECT?.trim();
  if (!named) set.CLAWDTIME_LINE_CHERT_PROJECT = ctx.project!.id;
  else if (named.toLowerCase() !== ctx.project!.id)
    missing.push(
      `CLAWDTIME_LINE_CHERT_PROJECT in ${short} names another project than the sign-in of this Mac. Change it to ${ctx.project!.id}, or sign in to that project`,
    );
  if (!read.values.CLAWDTIME_LINE_FRAMING?.trim()) {
    const answer =
      ctx.yes || ctx.check
        ? null
        : await ctx.ask(
            "The Video framing of your line, on its page in the Chert dashboard: fit or fill? [fit] ",
            false,
          );
    set.CLAWDTIME_LINE_FRAMING =
      answer?.trim().toLowerCase() === "fill" ? "fill" : "fit";
  }
  if (Object.keys(set).length) {
    // These have defaults that work, so a check only names them.
    if (ctx.check)
      did.push(`clawdtime connect would set ${Object.keys(set).join(", ")}`);
    else {
      writePrivateFile(file, withValues(read.text, set), {
        folder: "owner-writable",
      });
      did.push(
        `set ${Object.entries(set)
          .map(([name, value]) => `${name}=${value}`)
          .join(", ")}`,
      );
      read = readLineEnv(file);
      if (!read || "problem" in read)
        return failed(read?.problem ?? `${short} could not be read`);
    }
  }

  // The LiveKit keys: chert livekit writes them, in the person's terminal.
  const livekit = (values: Record<string, string | undefined>) =>
    !placeholder(values.LIVEKIT_API_KEY) &&
    !placeholder(values.LIVEKIT_API_SECRET) &&
    /^wss:\/\//.test(values.LIVEKIT_URL ?? "") &&
    !placeholder(values.LIVEKIT_URL);
  if (!livekit(read.values) && !ctx.check && ctx.interactive) {
    const use =
      ctx.yes ||
      yesWord(
        await ctx.ask(
          `Use Chert's LiveKit for this line? chert livekit writes its keys into ${short}. [Y/n] `,
          false,
        ),
        true,
      );
    if (use) {
      ctx.print("   Getting the LiveKit keys with chert livekit.");
      ctx.chert(["livekit", "--project", ctx.project!.id, "--env-file", file], {
        interactive: true,
        cwd: dir,
      });
      closeFile(file);
      const again = readLineEnv(file);
      if (!again || "problem" in again)
        return failed(again?.problem ?? `${short} could not be read`);
      read = again;
      if (livekit(read.values))
        did.push("chert livekit wrote the LiveKit keys");
    }
  }
  if (!livekit(read.values))
    missing.push(
      `the LiveKit keys: run chert livekit in ${dir}, or put the three values of your own LiveKit project in ${short}`,
    );
  // The line agent answers through the clawdtime command.
  const command = read.values.CLAWDTIME_LINE_CLAWDTIME?.trim() || "clawdtime";
  if (
    isAbsolute(command) ? !existsSync(command) : !findOnPath(command, ctx.env)
  )
    missing.push(
      `the clawdtime command for the line agent: run npm link in ${dirname(dir)}`,
    );
  if (placeholder(read.values.OPENAI_API_KEY))
    missing.push(
      `OPENAI_API_KEY: put your OpenAI key in ${short} yourself. Never paste it into a chat`,
    );
  const head = did.length ? `${did.join("; ")}. ` : "";
  return missing.length
    ? todo(`${head}missing: ${missing.join("; ")}`)
    : ready(`${head}ready`);
}

// 6 ---------------------------------------------------------------------------
function storedOwner(ctx: Context): OwnerRecord | null {
  const read = readOwner(ctx.root);
  if (read.problem) throw new PrivateFileError(read.problem);
  return read.owner;
}
async function ownerPhone(ctx: Context): Promise<Step> {
  const stored = storedOwner(ctx);
  let chosen: string | null = null;
  if (ctx.phone !== undefined) {
    chosen = normalizePhone(ctx.phone);
    if (!chosen)
      return failed(
        "the number in --phone is not a full number with the country code, as +1 415 555 0100",
      );
  }
  if (stored && (!chosen || chosen === stored.phone))
    return ready(`kept, ${phoneEnding(stored.phone)}`);
  if (!chosen) {
    const fromEnvironment = normalizePhone(ctx.env.CLAWDTIME_OWNER_PHONE ?? "");
    if (ctx.check)
      return todo(
        fromEnvironment
          ? `not stored yet. clawdtime connect can take the one in CLAWDTIME_OWNER_PHONE, ${phoneEnding(fromEnvironment)}`
          : "not stored yet. Run clawdtime connect, or give --phone",
      );
    if (fromEnvironment && ctx.yes) chosen = fromEnvironment;
    for (let attempt = 0; !chosen && attempt < 3; attempt++) {
      const answer = await ctx.ask(
        fromEnvironment
          ? `Your own mobile number, with the country code [the one in CLAWDTIME_OWNER_PHONE, ${phoneEnding(fromEnvironment)}]: `
          : "Your own mobile number, with the country code, as +1 415 555 0100: ",
        false,
      );
      if (answer === null) break;
      chosen = answer.trim() ? normalizePhone(answer) : fromEnvironment;
      if (!chosen)
        ctx.print(
          "   That is not a full number with the country code. Start with + and the country code.",
        );
    }
    if (!chosen)
      return todo(
        "not given. Run clawdtime connect in a terminal, or give --phone with your number",
      );
  }
  if (ctx.check) return todo(`not stored yet, ${phoneEnding(chosen)}`);
  // An answer belongs to its number: a new number is asked again.
  // The calling policy of the old number is taken back when the service runs.
  const revoke = [
    ...new Set([
      ...(stored?.revoke ?? []),
      ...(stored?.consent?.policyId ? [stored.consent.policyId] : []),
    ]),
  ];
  writeOwner(ctx.root, {
    version: 1,
    phone: chosen,
    ...(revoke.length ? { revoke } : {}),
  });
  // The outbound line calls the old number: it is off until a yes for the new one.
  if (stored) unpointOutbound(ctx);
  return ready(
    `${stored ? "changed" : "stored"}, ${phoneEnding(chosen)}, in ${join(ctx.root, "owner.json")}, for you only`,
  );
}

/**
 * Takes the outbound line of connect out of proactive.json, so that the
 * desktop service cannot call at all once it starts again. Its files stay.
 */
function unpointOutbound(ctx: Context) {
  const read = readProactiveConfig(ctx.desktopFolder);
  if (
    "problem" in read ||
    read.config.outbound?.provider !== "chert-dev-retained-v1" ||
    read.config.outbound.configurationFile !==
      join(outboundFolder(ctx.desktopFolder), "configuration.json")
  )
    return;
  const { outbound: _line, ...rest } = read.config;
  writeProactiveConfig(ctx.desktopFolder, rest);
  ctx.restart = true;
}

// 7 ---------------------------------------------------------------------------
const policyCopy = (ctx: Context) =>
  join(outboundFolder(ctx.desktopFolder), "policy.json");
/** The policy that connect last sent, from its private copy. */
function sentPolicy(ctx: Context, id: string | undefined) {
  if (!id) return undefined;
  const read = readPrivateJSON(policyCopy(ctx));
  const parsed = proactivePolicySchema.safeParse(read.value);
  return parsed.success && parsed.data.id === id ? parsed.data : undefined;
}
async function consent(ctx: Context): Promise<Step> {
  const owner = storedOwner(ctx);
  if (!owner) return todo("needs your number first (step 6)");
  const later = "To allow it later: clawdtime connect --consent yes";
  const now = ctx.now();
  const day = 86_400_000;
  const stored = owner.consent;
  const desktop = desktopDescriptor(ctx.desktopFolder);
  const running = !!findDesktopService(ctx.desktopFolder);
  const revoke = async (id: string) => {
    const sent = await sendToService(
      ctx.desktopFolder,
      { kind: "revoke", id },
      ctx.request,
    );
    return sent === "active" || sent === "unknown_policy";
  };
  // Policies that an earlier no, or a new number, left in force are taken back first.
  let pending = owner.revoke ?? [];
  if (pending.length && running && !ctx.check) {
    const left: string[] = [];
    for (const id of pending) if (!(await revoke(id))) left.push(id);
    if (left.length !== pending.length) {
      pending = left;
      owner.revoke = left.length ? left : undefined;
      writeOwner(ctx.root, owner);
    }
  }
  const last = sentPolicy(ctx, stored?.policyId);
  const live = last && last.expiresAt > now + day ? last : undefined;

  // The answer: a flag, the stored one, or the person now. An ended policy needs a new yes.
  let decision: "yes" | "no" | null = ctx.consent ?? null;
  let fresh = !!ctx.consent;
  if (!decision && stored?.answer === "no") decision = "no";
  if (!decision && stored?.answer === "yes" && (!stored.policyId || live))
    decision = "yes";
  if (!decision) {
    if (ctx.check)
      return todo(
        stored?.policyId
          ? "your yes ended with its calling policy. Run clawdtime connect to answer again"
          : "not answered. Run clawdtime connect, or give --consent yes",
      );
    const typed = await ctx.ask(
      `${consentQuestion} Calls and texts go only to your number, ${phoneEnding(owner.phone)}. Type yes to allow it: `,
      false,
    );
    if (typed === null)
      return todo(
        "not answered. Run clawdtime connect in a terminal, or give --consent yes",
      );
    decision = typed.trim().toLowerCase() === "yes" ? "yes" : "no";
    fresh = true;
  }

  // A service that runs keeps the outbound line it loaded until it starts again.
  const restartNow = running
    ? " The desktop service that runs now keeps the line it loaded: start it again now"
    : "";
  if (decision === "no") {
    if (ctx.check)
      return todo(
        `off: ClawdTime does not call or text you when it needs you. ${later}`,
      );
    // The policy of an earlier yes is taken back. Without the outbound line in
    // proactive.json the desktop service cannot call once it starts again.
    const left = [...pending];
    if (stored?.policyId && (!last || last.expiresAt > now))
      if (!(await revoke(stored.policyId))) left.push(stored.policyId);
    unpointOutbound(ctx);
    const all = [...new Set(left)];
    if (
      stored?.answer !== "no" ||
      stored.policyId ||
      all.length !== (owner.revoke?.length ?? 0)
    )
      writeOwner(ctx.root, {
        version: 1,
        phone: owner.phone,
        consent: {
          answer: "no",
          at: stored?.answer === "no" ? stored.at : now,
        },
        ...(all.length ? { revoke: all } : {}),
      });
    return todo(
      all.length
        ? `off. proactive.json names no outbound line now, so the desktop service cannot call you once it starts again. It did not confirm that it took the calling policy back: start it, then run clawdtime connect again to finish.${restartNow ? `${restartNow}.` : ""} ${later}`
        : `off: ClawdTime does not call or text you when it needs you.${restartNow ? `${restartNow}.` : ""} ${later}`,
    );
  }

  // Yes: the answer is kept with the number, then the calling policy is sent.
  const at = stored?.answer === "yes" && !fresh ? stored.at : now;
  const remember = (
    policyId?: string,
    revoke: string[] = owner.revoke ?? [],
  ) => {
    if (
      !ctx.check &&
      (stored?.answer !== "yes" ||
        stored.at !== at ||
        stored.policyId !== policyId ||
        revoke.length !== (owner.revoke?.length ?? 0))
    )
      writeOwner(ctx.root, {
        ...owner,
        consent: { answer: "yes", at, ...(policyId ? { policyId } : {}) },
        ...(revoke.length ? { revoke } : { revoke: undefined }),
      });
  };
  const allowed = fresh ? "allowed now" : "allowed";
  const until = (expiresAt: number) =>
    new Date(expiresAt).toISOString().slice(0, 10);
  if (!desktop) {
    remember(stored?.policyId);
    return todo(
      `${allowed}. The calling policy waits for the desktop service: start it with its state folder ${ctx.desktopFolder} (see docs/CODING_DEMO_DESKTOP.md), then run clawdtime connect again`,
    );
  }
  // A policy of the operator in proactive.json already lets the reach call: a second one would make two.
  const read = readProactiveConfig(ctx.desktopFolder);
  const other =
    "problem" in read
      ? undefined
      : read.config.policies.find((p) => fitsReach(p, desktop.projectRoot));
  if (other) {
    remember(stored?.policyId);
    return ready(
      `${allowed}. proactive.json already has a calling policy for questions in this project (${other.id}); clawdtime connect sends none`,
    );
  }
  let keep =
    live && live.scope.projectRoot === desktop.projectRoot ? live : undefined;
  let keepRevoked = false;
  if (keep && running && !ctx.check) {
    // The same policy again changes nothing in the service. It also registers
    // one whose first answer was lost. A taken-back one is refused.
    const sent = await sendToService(
      ctx.desktopFolder,
      { kind: "policy", file: policyCopy(ctx) },
      ctx.request,
    );
    if (sent === "revoked") {
      if (!fresh)
        return todo(
          `the calling policy was taken back (you said "stop calling" on a call, or it was revoked). ${later}`,
        );
      keep = undefined;
      keepRevoked = true;
    } else if (sent !== "active")
      return todo(
        `${allowed}, but the desktop service did not take the calling policy now. Run clawdtime connect again`,
      );
  }
  if (keep) {
    remember(keep.id);
    return ready(
      `${allowed}. The desktop service has the calling policy until ${until(keep.expiresAt)}${running ? "" : " (not checked now: the service does not run)"}`,
    );
  }
  if (ctx.check)
    return todo(`${allowed}. Run clawdtime connect to send the calling policy`);
  if (!running) {
    remember(stored?.policyId);
    return todo(
      `${allowed}. The calling policy goes to the desktop service while it runs: start it, then run clawdtime connect again`,
    );
  }
  // Two policies would make the reach refuse every call: an earlier one that
  // may still be in force is taken back first, and none is made before that.
  const earlier =
    stored?.policyId && !keepRevoked && (!last || last.expiresAt > now)
      ? [stored.policyId]
      : [];
  const left = [...pending];
  for (const id of earlier) if (!(await revoke(id))) left.push(id);
  if (left.length) {
    remember(undefined, [...new Set(left)]);
    return todo(
      `${allowed}, but the desktop service did not confirm that it took the earlier calling policy back, so no new one is made. Run clawdtime connect again`,
    );
  }
  const made = connectPolicy({
    projectRoot: desktop.projectRoot,
    consentAt: at,
    now,
  });
  // The policy is kept before it is sent: a lost answer is sent again as the same policy.
  writePrivateJSONIfChanged(policyCopy(ctx), made);
  remember(made.id, []);
  const sent = await sendToService(
    ctx.desktopFolder,
    { kind: "policy", file: policyCopy(ctx) },
    ctx.request,
  );
  if (sent !== "active")
    return todo(
      `${allowed}, but the desktop service did not confirm the calling policy. Run clawdtime connect again: it sends the same one`,
    );
  return ready(
    `${allowed}. The desktop service has the calling policy until ${until(made.expiresAt)}. It covers questions of the computer worker only, so it needs no enrollment`,
  );
}
function writePrivateJSONIfChanged(file: string, value: unknown) {
  const read = readPrivateJSON(file);
  if (!read.problem && JSON.stringify(read.value) === JSON.stringify(value))
    return;
  writePrivateJSON(file, value);
}

// 8 ---------------------------------------------------------------------------
async function apiKey(ctx: Context): Promise<Step> {
  const projectId = ctx.project!.id;
  const read = readChertKey(ctx.root);
  if (read.problem) return failed(read.problem);
  const base = (
    ctx.env.CHERT_API_BASE?.trim() || "https://app.trychert.com/api/v1"
  ).replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+/.test(base))
    return failed("CHERT_API_BASE must be an https address");
  const verify = (key: string) =>
    checkTexts(
      { base, key, project: projectId, owner: "+10000000000", line: null },
      ctx.request,
    );
  if (read.key?.projectId === projectId && !ctx.apiKeyEnv) {
    const state = await verify(read.key.apiKey);
    return state === "refused"
      ? todo(
          `the stored key was refused. Make a new key with read and write access on ${developerPage}, then run clawdtime connect again`,
        )
      : ready(
          `stored in ${chertKeyFile(ctx.root)}, for you only${state === "ok" ? "" : " (it could not be checked now)"}`,
        );
  }
  if (ctx.check)
    return todo(
      `not stored. Make a project API key with read and write access on ${developerPage}, then run clawdtime connect`,
    );
  let raw: string | null = null;
  if (ctx.apiKeyEnv) {
    raw = ctx.env[ctx.apiKeyEnv] ?? "";
    if (!raw.trim())
      return failed(`${ctx.apiKeyEnv} is empty in this environment`);
  } else {
    ctx.print(
      `   Make a project API key with read and write access on ${developerPage}. The key is shown once.`,
    );
    raw = await ctx.ask("Paste the project API key (it is not shown): ", true);
    if (raw === null)
      return todo(
        `not given. Run clawdtime connect in a terminal, or give --api-key-env NAME`,
      );
  }
  let key: string;
  try {
    key = checkKey(raw);
    if (key.length < 16) throw new Error("short");
  } catch {
    return failed("that is not a project API key. Nothing was stored");
  }
  // One read of the messages proves the key and the project. It sends nothing.
  const state = await verify(key);
  if (state === "refused")
    return failed(
      `the key was refused for this project. Make a key with read and write access on ${developerPage}. Nothing was stored`,
    );
  writeChertKey(ctx.root, { version: 1, projectId, apiKey: key });
  return ready(
    `stored in ${chertKeyFile(ctx.root)}, for you only${state === "ok" ? "" : " (it could not be checked now)"}. Keep joining by code off on ${messagesPage}, so that no other phone joins your line`,
  );
}

// 9 ---------------------------------------------------------------------------
async function outbound(ctx: Context): Promise<Step> {
  const owner = readOwner(ctx.root).owner;
  if (owner?.consent?.answer !== "yes")
    return todo("off: calls to you are not allowed (step 7)");
  const retention =
    ctx.retention === undefined
      ? await retentionChecks(ctx.lineDirectory)
      : ctx.retention;
  // The retained provider runs only with its pinned builds. Without them the
  // reach calls through the Calls API of Chert, which needs none of them.
  const pin = pinProblem(ctx.env, retention, ctx.lineDirectory);
  if (pin) {
    const key = readChertKey(ctx.root).key;
    if (!key || key.projectId !== ctx.project!.id)
      return todo("needs the project API key first (step 8)");
    const result = await setUpCallsApi({
      check: ctx.check,
      env: ctx.env,
      root: ctx.root,
      request: ctx.request,
      desktopFolder: ctx.desktopFolder,
      projectId: ctx.project!.id,
      apiKey: key.apiKey,
      phone: owner.phone,
      lineDirectory: ctx.lineDirectory,
      pinned: pinShort(ctx.env, retention),
    });
    if (result.changed) ctx.restart = true;
    return result.ready ? ready(result.text) : todo(result.text);
  }
  const desktop = desktopDescriptor(ctx.desktopFolder);
  if (!desktop)
    return todo(
      `waits for the desktop service: start it once with its state folder ${ctx.desktopFolder}, then run clawdtime connect again`,
    );
  const key = readChertKey(ctx.root).key;
  if (!key || key.projectId !== ctx.project!.id)
    return todo("needs the project API key first (step 8)");
  const result = await setUpOutbound({
    check: ctx.check,
    env: ctx.env,
    home: ctx.home,
    request: ctx.request,
    desktopFolder: ctx.desktopFolder,
    desktop,
    projectId: ctx.project!.id,
    apiKey: key.apiKey,
    phone: owner.phone,
    lineDirectory: ctx.lineDirectory,
    chertHome: ctx.chertHome,
    nodeBinary: ctx.nodeBinary,
    retention,
  });
  if (result.changed) ctx.restart = true;
  // The call path reads the sign-in of chert when the desktop service starts.
  const ends = ctx.who?.expiresAt
    ? `. The desktop service starts with it while the sign-in of chert lasts, until ${new Date(ctx.who.expiresAt).toISOString().slice(0, 10)}: run chert login before then`
    : "";
  const soon =
    ctx.who?.expiresAt !== undefined &&
    ctx.who.expiresAt - ctx.now() < 3 * 86_400_000;
  if (result.ready && soon)
    return todo(
      `${result.text}. The sign-in of chert ends on ${new Date(ctx.who!.expiresAt!).toISOString().slice(0, 10)}, and after that the desktop service does not start with this outbound line. Run chert login now, then clawdtime connect`,
    );
  return result.ready ? ready(`${result.text}${ends}`) : todo(result.text);
}

// 10 --------------------------------------------------------------------------
async function doctorRows(
  ctx: Context,
): Promise<{ name: string; detail: string; ready: boolean }[]> {
  const printed: string[] = [];
  try {
    await computerCli(["doctor", "--json"], {
      env: ctx.env,
      home: ctx.home,
      now: ctx.now,
      print: (line) => printed.push(line),
      request: ctx.request,
    });
    const report = JSON.parse(printed.join("\n")) as {
      checks?: { name: string; detail: string }[];
    };
    return ["calls to you", "texts to you"].map((name) => {
      const row = report.checks?.find((check) => check.name === name);
      const detail = row?.detail ?? "not reported";
      return {
        name: name === "calls to you" ? "Calls to you" : "Texts to you",
        detail,
        ready: detail.startsWith("ready"),
      };
    });
  } catch {
    return [
      {
        name: "Calls and texts to you",
        detail: "the doctor could not run. Run: clawdtime computer doctor",
        ready: false,
      },
    ];
  }
}
