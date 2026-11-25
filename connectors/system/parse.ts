/**
 * The parsers of the probes: the text that ps, lsof, log, launchctl, sysctl,
 * memory_pressure and df print, and the crash and hang reports of macOS.
 * Pure functions: a line that does not parse is left out, never guessed.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  user: string;
  /** Percent of one core: 100 is one core at full use. */
  cpu: number;
  /** Percent of the memory of the Mac. */
  mem: number;
  rssKb: number;
  /** Seconds since it started. */
  elapsed: number;
  /** The state letters of ps: R, S, I, T, U or Z, then the flags. */
  state: string;
  /** The executable path, or the name that ps gives for a process with no path. */
  path: string;
  /** The executable's own name: the last part of the path. */
  name: string;
  /** The app that the executable belongs to: the outermost .app, without ".app". */
  app: string | null;
  /** The outermost .app folder, to open the app again. */
  appPath: string | null;
  /** The main executable of an app, not a helper inside one. */
  isApp: boolean;
}

/** The columns that every process listing asks ps for, in this order. */
export const psColumns =
  "pid=,ppid=,uid=,user=,%cpu=,%mem=,rss=,etime=,state=,comm=";

/** ps prints the time since the start as [[days-]hours:]minutes:seconds. */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4])
  );
}

/** The app of an executable path: the outermost .app, and whether it is that app's main executable. */
export function appOf(
  path: string,
): Pick<ProcessRow, "app" | "appPath" | "isApp"> {
  const outer = /^(.*?\/([^/]+)\.app)\//.exec(path);
  if (!outer) return { app: null, appPath: null, isApp: false };
  const rest = path.slice(outer[1]!.length);
  return {
    app: outer[2]!,
    appPath: outer[1]!,
    isApp: /^\/Contents\/MacOS\/[^/]+$/.test(rest),
  };
}

const rowLine =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

/** The listing of `ps -o psColumns`. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = rowLine.exec(line);
    if (!match) continue;
    const elapsed = parseElapsed(match[8]!);
    if (elapsed === null || !/^[A-Z]/.test(match[9]!)) continue;
    const path = match[10]!;
    const base = path.includes("/")
      ? path.slice(path.lastIndexOf("/") + 1)
      : path;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      user: match[4]!,
      cpu: Number(match[5]),
      mem: Number(match[6]),
      rssKb: Number(match[7]),
      elapsed,
      state: match[9]!,
      path,
      name: base.replace(/^\((.*)\)$/, "$1") || path,
      ...appOf(path),
    });
  }
  return rows;
}

/** The listing of `ps -o pid=,command=`: each pid with its whole command line. */
export function parseCommands(text: string): Map<number, string> {
  const commands = new Map<number, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!.trim());
  }
  return commands;
}

/** The arguments of a command line: what follows its executable path. */
export function argumentsOf(command: string, path: string): string {
  const trimmed = command.trim();
  if (path && trimmed.startsWith(path))
    return trimmed.slice(path.length).trim();
  // A process that set its own title: everything after the first word.
  const space = trimmed.indexOf(" ");
  return space < 0 ? "" : trimmed.slice(space + 1).trim();
}

/** `ps -o lstart=,command=` for one pid: the start, as ps writes it, and the command line. */
export function parseStart(
  text: string,
): { started: string; command: string } | null {
  const match =
    /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(
      text.split("\n")[0] ?? "",
    );
  return match
    ? { started: match[1]!.replace(/\s+/g, " "), command: match[2]!.trim() }
    : null;
}

/** `ps -M -p PID`: one line for each thread after the header. */
export function parseThreads(text: string): number | null {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 1 ? lines.length - 1 : null;
}

export interface SocketRow {
  pid: number;
  /** The address: "*:4173", "127.0.0.1:4173", "127.0.0.1:4173->127.0.0.1:61022". */
  address: string;
  /** LISTEN, ESTABLISHED, ... Null for a socket with no TCP state (UDP). */
  state: string | null;
  protocol: "TCP" | "UDP" | null;
}

/**
 * The fields of `lsof -F`: a line that starts with p opens a process, one
 * that starts with f opens a file of it. Returns every file's count and its
 * network sockets.
 */
export function parseLsof(text: string): {
  files: Map<number, number>;
  sockets: SocketRow[];
} {
  const files = new Map<number, number>();
  const sockets: SocketRow[] = [];
  let pid: number | null = null;
  let current: {
    type: string | null;
    protocol: string | null;
    name: string | null;
    state: string | null;
  } | null = null;
  const close = () => {
    if (pid === null || !current?.name) return;
    const network =
      current.type === "IPv4" ||
      current.type === "IPv6" ||
      current.protocol === "TCP" ||
      current.protocol === "UDP" ||
      current.state !== null;
    if (!network || !/:\d+|:\*/.test(current.name)) return;
    sockets.push({
      pid,
      address: current.name,
      state: current.state,
      protocol:
        current.protocol === "TCP" || current.protocol === "UDP"
          ? current.protocol
          : current.state !== null
            ? "TCP"
            : null,
    });
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      close();
      current = null;
      const next = Number(value);
      pid = Number.isInteger(next) && next > 0 ? next : null;
      if (pid !== null && !files.has(pid)) files.set(pid, 0);
    } else if (field === "f") {
      close();
      current = { type: null, protocol: null, name: null, state: null };
      if (pid !== null) files.set(pid, (files.get(pid) ?? 0) + 1);
    } else if (current) {
      if (field === "t") current.type = value;
      else if (field === "P") current.protocol = value;
      else if (field === "n") current.name = value;
      else if (field === "T" && value.startsWith("ST="))
        current.state = value.slice(3);
    }
  }
  close();
  return { files, sockets };
}

export interface LogLine {
  /** The time of the day, hh:mm:ss. */
  time: string;
  /** The level of compact style: Df, I, Db, E, F, A. */
  level: string;
  /** The subsystem and the message. */
  text: string;
}

const logLine =
  /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\.\d+\s+(\S+)\s+\S+?\[\d+:[0-9a-f]+\]\s?(.*)$/;

/** `log show --style compact`. A line that goes on from the last one joins it. */
export function parseLog(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const match = logLine.exec(raw);
    if (match) {
      lines.push({ time: match[1]!, level: match[2]!, text: match[3]!.trim() });
      continue;
    }
    const last = lines.at(-1);
    if (last && raw.trim() && !raw.startsWith("Timestamp"))
      last.text = `${last.text} ${raw.trim()}`.slice(0, 2000);
  }
  return lines;
}

export interface Report {
  kind: "crash" | "hang" | "spin" | "resource" | "memory" | "report";
  /** The process that the report is about. */
  name: string;
  /** When it was written: the file's time. */
  at: number;
  /** The exception or the event, in the report's own words. */
  what: string | null;
  /** The first frames of the thread that crashed, or the largest process of a memory event. */
  frames: string[];
  /** How long a hang or an event lasted, in the report's own words. */
  duration: string | null;
}

const field = (text: string, name: string) =>
  new RegExp(`^${name}:[ \\t]*(.+)$`, "m").exec(text)?.[1]?.trim() ?? null;

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
const string = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The first frames of the thread that crashed in the body of an .ips crash report. */
function ipsFrames(body: Json, limit: number): string[] {
  const threads = Array.isArray(body.threads) ? body.threads : [];
  const images = Array.isArray(body.usedImages) ? body.usedImages : [];
  const index =
    typeof body.faultingThread === "number" ? body.faultingThread : -1;
  const thread =
    object(threads[index]) ??
    object(threads.find((item) => object(item)?.triggered === true));
  const frames = Array.isArray(thread?.frames) ? thread.frames : [];
  return frames.slice(0, limit).flatMap((item) => {
    const frame = object(item);
    if (!frame) return [];
    const symbol = string(frame.symbol);
    if (symbol) return [symbol];
    const image =
      typeof frame.imageIndex === "number"
        ? string(object(images[frame.imageIndex])?.name)
        : null;
    return image ? [`a frame in ${image}`] : [];
  });
}

/** An .ips report: a JSON header line, then a JSON body. */
function parseIps(text: string, at: number, fallback: string): Report | null {
  const newline = text.indexOf("\n");
  let header: Json | null;
  try {
    header = object(JSON.parse(newline < 0 ? text : text.slice(0, newline)));
  } catch {
    return null;
  }
  if (!header) return null;
  let body: Json | null = null;
  try {
    body = newline < 0 ? null : object(JSON.parse(text.slice(newline + 1)));
  } catch {
    body = null;
  }
  const type = string(header.bug_type) ?? String(header.bug_type ?? "");
  const name =
    string(header.app_name) ??
    string(header.name) ??
    string(body?.procName) ??
    fallback;
  if (type === "309" || type === "109") {
    const exception = object(body?.exception);
    const termination = object(body?.termination);
    const kind = string(exception?.type);
    const signal = string(exception?.signal);
    const subtype = string(exception?.subtype);
    const what =
      [
        kind && signal ? `${kind} (${signal})` : (kind ?? signal),
        subtype,
        kind || signal ? null : string(termination?.indicator),
      ]
        .filter(Boolean)
        .join(", ") || null;
    return {
      kind: "crash",
      name,
      at,
      what,
      frames: body ? ipsFrames(body, 4) : [],
      duration: null,
    };
  }
  if (type === "298") {
    const largest = string(body?.largestProcess);
    return {
      kind: "memory",
      name: "memory",
      at,
      what: "Memory ran short, and macOS ended processes to free it.",
      frames: largest ? [largest] : [],
      duration: null,
    };
  }
  return { kind: "report", name, at, what: null, frames: [], duration: null };
}

/** The frames after "Thread N Crashed" in a text crash report. */
function crashFrames(text: string, limit: number): string[] {
  const start = /^Thread \d+ Crashed:.*$/m.exec(text);
  if (!start) return [];
  const frames: string[] = [];
  for (const line of text.slice(start.index + start[0].length).split("\n")) {
    if (!line.trim()) {
      if (frames.length) break;
      continue;
    }
    const match = /^\d+\s+(\S+)\s+0x[0-9a-f]+\s+(.+?)(?:\s+\+\s+\d+)?$/.exec(
      line.trim(),
    );
    if (!match) break;
    frames.push(match[2]!.trim() || `a frame in ${match[1]}`);
    if (frames.length >= limit) break;
  }
  return frames;
}

/**
 * One report of the DiagnosticReports folders. `ext` is the file's ending:
 * ips, crash, hang, spin or diag. `fallback` is the name in the file name.
 */
export function parseReport(
  text: string,
  ext: string,
  at: number,
  fallback: string,
): Report | null {
  if (ext === "ips") return parseIps(text, at, fallback);
  const name =
    field(text, "Process")?.replace(/\s*\[\d+\]$/, "") ??
    field(text, "Command") ??
    fallback;
  if (ext === "crash") {
    const what = [
      field(text, "Exception Type"),
      field(text, "Termination Reason"),
    ].filter(Boolean);
    return {
      kind: "crash",
      name,
      at,
      what: what.length ? what.join(", ") : null,
      frames: crashFrames(text, 4),
      duration: null,
    };
  }
  if (ext === "hang" || ext === "spin" || ext === "diag") {
    const event = field(text, "Event");
    return {
      kind:
        ext === "diag"
          ? "resource"
          : ext === "spin" || event === "spin"
            ? "spin"
            : "hang",
      name,
      at,
      what: event,
      frames: [],
      duration: field(text, "Duration"),
    };
  }
  return null;
}

export interface Job {
  label: string;
  pid: number | null;
  /** The last exit status. A negative one is the signal that ended it. */
  status: number | null;
}

/** `launchctl list`: PID, Status, Label, by tabs. */
export function parseLaunchctl(text: string): Job[] {
  const jobs: Job[] = [];
  for (const line of text.split("\n")) {
    const match = /^(-|\d+)\t(-|-?\d+)\t(\S.*)$/.exec(line.trim());
    if (!match) continue;
    jobs.push({
      label: match[3]!.trim(),
      pid: match[1] === "-" ? null : Number(match[1]),
      status: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return jobs;
}

/** `sysctl NAME ...`: each name with its value. */
export function parseSysctl(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([a-z0-9_.]+):\s*(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  return values;
}

const megabytes = (value: string | undefined) => {
  const match = /^([\d.]+)([KMGT])$/.exec(value ?? "");
  if (!match) return null;
  const scale = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[
    match[2] as "K" | "M" | "G" | "T"
  ];
  return Number(match[1]) * scale * 1024 * 1024;
};

/** vm.swapusage: "total = 4096.00M  used = 2394.88M  free = 1701.12M". Bytes. */
export function parseSwap(
  value: string | undefined,
): { total: number; used: number } | null {
  const total = megabytes(/total = (\S+)/.exec(value ?? "")?.[1]);
  const used = megabytes(/used = (\S+)/.exec(value ?? "")?.[1]);
  return total === null || used === null ? null : { total, used };
}

/** `df -kP`: the free bytes and the used percent of each mount. */
export function parseDf(
  text: string,
): { mount: string; free: number; usedPercent: number }[] {
  const mounts: { mount: string; free: number; usedPercent: number }[] = [];
  for (const line of text.split("\n")) {
    const match = /^\S.*?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\/.*)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    mounts.push({
      mount: match[5]!,
      free: Number(match[3]) * 1024,
      usedPercent: Number(match[4]),
    });
  }
  return mounts;
}

/** `memory_pressure -Q`: the percent of memory that is free. */
export function parseFreePercent(text: string): number | null {
  const match = /free percentage:\s*(\d+)%/i.exec(text);
  return match ? Number(match[1]) : null;
}

/** `lsappinfo info -only pid -app ID`: "pid"=4242. */
export function parseAppPid(text: string): number | null {
  const match = /"pid"\s*=\s*(\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}
