/**
 * The read-only probes of the process level: processes, one process,
 * listening ports, the log of one process, crash and hang reports, launchd
 * jobs, and memory, swap and disk.
 *
 * Each probe runs fixed programs through the host with a short timeout and a
 * cap on their output, and changes nothing. No probe reads an environment:
 * ps is never asked for one, and launchd jobs are read from `launchctl list`,
 * which prints none. Arguments and log lines leave here only through the
 * redaction of `words.ts`.
 */
import type { RunResult, SystemHost } from "./host.js";
import {
  argumentsOf,
  parseAppPid,
  parseCommands,
  parseDf,
  parseFreePercent,
  parseLaunchctl,
  parseLog,
  parseLsof,
  parsePs,
  parseReport,
  parseStart,
  parseSwap,
  parseSysctl,
  parseThreads,
  psColumns,
  type Job,
  type LogLine,
  type ProcessRow,
  type Report,
  type SocketRow,
} from "./parse.js";
import { redactArguments, redactLine, withoutHome } from "./words.js";

const second = 1000;
const quick = { timeoutMs: 3 * second, maxBytes: 4 * 1024 * 1024 };
const small = { timeoutMs: 2 * second, maxBytes: 64 * 1024 };

/** Why a probe has nothing: the program is missing, timed out or failed. */
export class ProbeFailed extends Error {}

const need = (result: RunResult, what: string) => {
  if (result.missing)
    throw new ProbeFailed(
      `${what} is not on this Mac, so this cannot be read.`,
    );
  if (result.timedOut)
    throw new ProbeFailed(`${what} did not answer in time. Try again.`);
  return result.stdout;
};

export interface ProcessView extends ProcessRow {
  /** Why it may not answer, in a few words, or null. */
  hint: string | null;
  /** The name was found in its arguments, not in its own name. */
  matchedIn?: "name" | "arguments";
}

/** What the state letter of ps means. */
export function stateWord(state: string): string {
  switch (state[0]) {
    case "R":
      return "running";
    case "S":
      return "sleeping";
    case "I":
      return "idle";
    case "T":
      return "stopped";
    case "U":
      return "waiting on the system";
    case "Z":
      return "ended, a zombie";
    default:
      return "in an unknown state";
  }
}

/**
 * Why a process may not answer: stopped, stuck in a call to the system,
 * ended but not collected, or at full CPU. Null when nothing points to it.
 * A process at 0 percent CPU is no sign by itself: most of them sleep.
 */
export function hintOf(row: ProcessRow): string | null {
  const reasons: string[] = [];
  if (row.state.startsWith("T"))
    reasons.push(
      "it is stopped and does nothing until it gets a signal to go on",
    );
  if (row.state.startsWith("U"))
    reasons.push("it is stuck in a call to the system");
  if (row.state.startsWith("Z"))
    reasons.push("it ended, and its parent did not collect it");
  if (row.cpu >= 90) reasons.push("it is at full CPU, busy or stuck in a loop");
  if (!reasons.length) return null;
  return row.isApp && !row.state.startsWith("Z")
    ? `It may not be responding: ${reasons.join("; ")}.`
    : `${reasons.join("; ").replace(/^./, (letter) => letter.toUpperCase())}.`;
}

const view = (row: ProcessRow): ProcessView => ({ ...row, hint: hintOf(row) });

export interface ProcessDetail {
  row: ProcessView;
  /** The start as ps writes it, in the Mac's time. */
  started: string | null;
  /** The arguments, with what looks like a credential hidden. */
  arguments: string;
  threads: number | null;
  files: number | null;
  sockets: SocketRow[];
  parent: string | null;
  /** The newest crash or hang report of its name, of the last day. */
  report: Report | null;
}

export interface PortOwner {
  pid: number;
  name: string;
  isApp: boolean;
  sockets: SocketRow[];
}

export interface LogLook {
  name: string;
  minutes: number;
  total: number;
  errors: number;
  faults: number;
  /** The lines that matter most, oldest first, already redacted. */
  lines: LogLine[];
  /** The log was longer than its cap: only its newest lines were read. */
  cut: boolean;
}

export interface MemoryLook {
  total: number | null;
  pressure: "normal" | "warning" | "critical" | null;
  freePercent: number | null;
  swap: { total: number; used: number } | null;
  load: number[] | null;
  cores: number | null;
  disk: { free: number; usedPercent: number } | null;
  top: ProcessView[];
}

export interface ServicesLook {
  total: number;
  running: number;
  jobs: Job[];
}

/** The two folders of crash, hang and resource reports. */
export const reportFolders = (home: string) => [
  `${home}/Library/Logs/DiagnosticReports`,
  "/Library/Logs/DiagnosticReports",
];

const reportEnding = /\.(ips|crash|hang|spin|diag)$/;
/** The name in a report's file name: what comes before its date. */
const reportName = (file: string) =>
  /^(.+?)[-_]\d{4}-\d{2}-\d{2}/.exec(file)?.[1] ?? null;

export class SystemProbes {
  constructor(readonly host: SystemHost) {}

  /** Every process, with its view. */
  async all(): Promise<ProcessView[]> {
    const result = await this.host.exec(
      "/bin/ps",
      ["-axww", "-o", psColumns],
      quick,
    );
    return parsePs(need(result, "ps")).map(view);
  }

  /** The whole command line of every process, held here only for matching and the checks. */
  async commands(): Promise<Map<number, string>> {
    const result = await this.host.exec(
      "/bin/ps",
      ["-axww", "-o", "pid=,command="],
      quick,
    );
    return parseCommands(need(result, "ps"));
  }

  /** One process by its pid, or null when none has it. */
  async one(pid: number): Promise<ProcessView | null> {
    const result = await this.host.exec(
      "/bin/ps",
      ["-ww", "-o", psColumns, "-p", String(pid)],
      small,
    );
    if (result.missing || result.timedOut) need(result, "ps");
    return (
      parsePs(result.stdout)
        .map(view)
        .find((row) => row.pid === pid) ?? null
    );
  }

  /**
   * The processes that use the most CPU or memory, or those whose name holds
   * the words. A name is also looked for in the arguments, which are never
   * returned here.
   */
  async processes(options: {
    sort: "cpu" | "memory";
    name?: string | null;
    limit: number;
  }): Promise<{ total: number; cpu: number; rows: ProcessView[] }> {
    const all = await this.all();
    const total = all.length;
    const cpu = all.reduce((sum, row) => sum + row.cpu, 0);
    let rows: ProcessView[] = all;
    if (options.name) {
      const query = options.name.toLowerCase();
      const commands = await this.commands().catch(
        () => new Map<number, string>(),
      );
      rows = all.flatMap((row): ProcessView[] => {
        if (
          row.name.toLowerCase().includes(query) ||
          row.app?.toLowerCase().includes(query)
        )
          return [{ ...row, matchedIn: "name" }];
        const args = redactArguments(
          argumentsOf(commands.get(row.pid) ?? "", row.path),
          this.host.home,
          row.path,
        ).toLowerCase();
        return args.includes(query) ? [{ ...row, matchedIn: "arguments" }] : [];
      });
    }
    rows = [...rows].sort((left, right) =>
      options.sort === "memory"
        ? right.rssKb - left.rssKb || right.cpu - left.cpu
        : right.cpu - left.cpu || right.rssKb - left.rssKb,
    );
    return { total, cpu, rows: rows.slice(0, options.limit) };
  }

  /** One process in detail: its command, start, threads, open files and ports. */
  async detail(row: ProcessView): Promise<ProcessDetail> {
    const pid = String(row.pid);
    const [start, threads, files, parent] = await Promise.all([
      this.host.exec(
        "/bin/ps",
        ["-ww", "-o", "lstart=,command=", "-p", pid],
        small,
      ),
      this.host.exec("/bin/ps", ["-M", "-p", pid], quick),
      this.host.exec("/usr/sbin/lsof", ["-n", "-P", "-p", pid, "-F", "ftPnT"], {
        timeoutMs: 5 * second,
        maxBytes: 4 * 1024 * 1024,
      }),
      row.ppid > 1
        ? this.one(row.ppid).catch(() => null)
        : Promise.resolve(null),
    ]);
    const started = parseStart(start.stdout);
    const lsof = parseLsof(files.stdout);
    const reports = await this.reports({
      name: row.app ?? row.name,
      days: 1,
      limit: 1,
    });
    return {
      row,
      started: started?.started ?? null,
      arguments: redactArguments(
        argumentsOf(started?.command ?? "", row.path),
        this.host.home,
        row.path,
      ),
      threads: parseThreads(threads.stdout),
      files:
        files.missing || files.timedOut
          ? null
          : (lsof.files.get(row.pid) ?? null),
      sockets: lsof.sockets.filter((socket) => socket.pid === row.pid),
      parent:
        row.ppid === 1 ? "launchd" : (parent?.app ?? parent?.name ?? null),
      report: reports.items[0] ?? null,
    };
  }

  /** The TCP ports that processes of this user listen on, or every socket on one port. */
  async ports(port: number | null): Promise<PortOwner[]> {
    const result = await this.host.exec(
      "/usr/sbin/lsof",
      port === null
        ? ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcfnT"]
        : ["-nP", `-iTCP:${port}`, "-F", "pcfnT"],
      { timeoutMs: 5 * second, maxBytes: 4 * 1024 * 1024 },
    );
    // lsof ends with 1 when it found nothing: that is an answer too.
    const { sockets } = parseLsof(need(result, "lsof"));
    if (!sockets.length) return [];
    const names = new Map(
      (await this.all().catch(() => [] as ProcessView[])).map((row) => [
        row.pid,
        row,
      ]),
    );
    const owners = new Map<number, PortOwner>();
    for (const socket of sockets) {
      const row = names.get(socket.pid);
      const owner = owners.get(socket.pid) ?? {
        pid: socket.pid,
        name: row ? (row.isApp ? row.app! : row.name) : `pid ${socket.pid}`,
        isApp: row?.isApp ?? false,
        sockets: [],
      };
      if (
        !owner.sockets.some(
          (item) =>
            item.address === socket.address && item.state === socket.state,
        )
      )
        owner.sockets.push(socket);
      owners.set(socket.pid, owner);
    }
    return [...owners.values()];
  }

  /**
   * The log of one process for the last minutes: the counts, and the lines
   * that matter most (the newest errors and faults, then the newest others),
   * each one redacted and cut to 200 characters.
   */
  async logs(name: string, minutes: number): Promise<LogLook> {
    const result = await this.host.exec(
      "/usr/bin/log",
      [
        "show",
        "--last",
        `${minutes}m`,
        "--style",
        "compact",
        "--predicate",
        `process == "${name}"`,
      ],
      // A log prints its oldest lines first: the newest are the ones kept.
      { timeoutMs: 20 * second, maxBytes: 8 * 1024 * 1024, keep: "tail" },
    );
    const lines = parseLog(need(result, "log"));
    const serious = (line: LogLine) => line.level === "E" || line.level === "F";
    const chosen = new Set([
      ...lines.filter(serious).slice(-12),
      ...lines.filter((line) => !serious(line)).slice(-6),
    ]);
    return {
      name,
      minutes,
      total: lines.length,
      errors: lines.filter((line) => line.level === "E").length,
      faults: lines.filter((line) => line.level === "F").length,
      lines: lines
        .filter((line) => chosen.has(line))
        .map((line) => ({
          ...line,
          text: redactLine(line.text, this.host.home).slice(0, 200),
        })),
      cut: result.cut,
    };
  }

  /**
   * The newest crash, hang and resource reports of the last days, of one
   * name or of all. File names are never returned: some hold the Mac's name.
   */
  async reports(options: {
    name?: string | null;
    days: number;
    limit: number;
  }): Promise<{ total: number; items: Report[] }> {
    const since = this.host.now() - options.days * 86_400_000;
    const query = options.name?.toLowerCase() ?? null;
    const found: {
      path: string;
      ext: string;
      name: string;
      at: number;
      size: number;
    }[] = [];
    for (const folder of reportFolders(this.host.home)) {
      for (const file of this.host.files.list(folder)) {
        const ending = reportEnding.exec(file);
        const name = reportName(file);
        if (!ending || !name) continue;
        if (query && name.toLowerCase() !== query) continue;
        const path = `${folder}/${file}`;
        const facts = this.host.files.stat(path);
        if (!facts || facts.mtimeMs < since) continue;
        found.push({
          path,
          ext: ending[1]!,
          name,
          at: facts.mtimeMs,
          size: facts.size,
        });
      }
    }
    found.sort((left, right) => right.at - left.at);
    const items: Report[] = [];
    for (const item of found) {
      if (items.length >= options.limit) break;
      const text = this.host.files.head(
        item.path,
        item.ext === "ips" ? 2 * 1024 * 1024 : 64 * 1024,
      );
      const report = text
        ? parseReport(text, item.ext, item.at, item.name)
        : null;
      if (!report) continue;
      items.push({
        ...report,
        name: withoutHome(report.name, this.host.home).slice(0, 80),
        what: report.what
          ? redactLine(report.what, this.host.home).slice(0, 160)
          : null,
        frames: report.frames.map((frame) =>
          redactLine(frame, this.host.home).slice(0, 100),
        ),
      });
    }
    return { total: found.length, items };
  }

  /** The launchd jobs of this user whose label holds the words, or those that failed. */
  async services(label: string | null): Promise<ServicesLook> {
    const result = await this.host.exec("/bin/launchctl", ["list"], quick);
    const jobs = parseLaunchctl(need(result, "launchctl"));
    const running = jobs.filter((job) => job.pid !== null).length;
    const picked = label
      ? jobs.filter((job) =>
          job.label.toLowerCase().includes(label.toLowerCase()),
        )
      : jobs
          .filter(
            (job) =>
              job.pid === null && job.status !== null && job.status !== 0,
          )
          .sort(
            (left, right) =>
              Number(left.label.startsWith("com.apple.")) -
              Number(right.label.startsWith("com.apple.")),
          );
    return { total: jobs.length, running, jobs: picked.slice(0, 12) };
  }

  /** Memory, pressure, swap, load, disk, and the processes that hold the most memory. */
  async memory(): Promise<MemoryLook> {
    const [sysctl, pressure, df, top] = await Promise.all([
      this.host.exec(
        "/usr/sbin/sysctl",
        [
          "hw.memsize",
          "vm.swapusage",
          "kern.memorystatus_vm_pressure_level",
          "vm.loadavg",
          "hw.ncpu",
        ],
        small,
      ),
      this.host.exec("/usr/bin/memory_pressure", ["-Q"], small),
      this.host.exec("/bin/df", ["-kP", "/", "/System/Volumes/Data"], small),
      this.processes({ sort: "memory", limit: 5 }).catch(() => null),
    ]);
    const values = parseSysctl(sysctl.stdout);
    const level = values.get("kern.memorystatus_vm_pressure_level");
    const mounts = parseDf(df.stdout);
    const data =
      mounts.find((mount) => mount.mount === "/System/Volumes/Data") ??
      mounts.find((mount) => mount.mount === "/") ??
      null;
    const load = values
      .get("vm.loadavg")
      ?.replace(/[{}]/g, " ")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Number.isFinite);
    const total = Number(values.get("hw.memsize"));
    const cores = Number(values.get("hw.ncpu"));
    return {
      total: Number.isFinite(total) && total > 0 ? total : null,
      pressure:
        level === "1"
          ? "normal"
          : level === "2"
            ? "warning"
            : level === "4"
              ? "critical"
              : null,
      freePercent: parseFreePercent(pressure.stdout),
      swap: parseSwap(values.get("vm.swapusage")),
      load: load?.length === 3 ? load : null,
      cores: Number.isFinite(cores) && cores > 0 ? cores : null,
      disk: data ? { free: data.free, usedPercent: data.usedPercent } : null,
      top: top?.rows ?? [],
    };
  }

  /**
   * The process that a pid or a name names. A name is an app's name first,
   * then an executable's name. Two or more that fit are all returned, so the
   * caller can ask which one: a name never picks one by chance.
   */
  async find(target: {
    pid?: number | null;
    name?: string | null;
  }): Promise<
    | { kind: "one"; row: ProcessView; all: ProcessView[] }
    | { kind: "many"; rows: ProcessView[] }
    | { kind: "none"; reason: string }
  > {
    const all = await this.all();
    if (target.pid) {
      const row = all.find((item) => item.pid === target.pid);
      return row
        ? { kind: "one", row, all }
        : { kind: "none", reason: `No process has pid ${target.pid} now.` };
    }
    const name = target.name?.toLowerCase();
    if (!name)
      return {
        kind: "none",
        reason: "Say which process: its name or its pid.",
      };
    const apps = all.filter(
      (row) => row.isApp && row.app?.toLowerCase() === name,
    );
    const exes = all.filter((row) => row.name.toLowerCase() === name);
    const parts = all.filter((row) => row.app?.toLowerCase() === name);
    for (const rows of [apps, exes, parts]) {
      if (rows.length === 1) return { kind: "one", row: rows[0]!, all };
      if (rows.length > 1) return { kind: "many", rows };
    }
    return {
      kind: "none",
      reason: `No process named ${target.name} runs now.`,
    };
  }

  /** The pid of a running app by its bundle id, from LaunchServices, or null. */
  async appPid(bundleId: string): Promise<number | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(bundleId)) return null;
    const result = await this.host.exec(
      "/usr/bin/lsappinfo",
      ["info", "-only", "pid", "-app", bundleId],
      small,
    );
    return parseAppPid(result.stdout);
  }
}
