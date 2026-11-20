import type { System } from "./system.js";

export interface ProcessFact {
  pid: number;
  ppid: number;
  tty: string | null;
  /** In the foreground process group of its terminal. */
  foreground: boolean;
  startedAt: number | null;
  cpuSeconds: number;
  /** Executable path, or the title a runtime gave the process. */
  exe: string;
  /** Arguments joined by spaces. Held in memory only, never published. */
  command: string;
}
export interface ProcessTree {
  byPid: Map<number, ProcessFact>;
  children: Map<number, number[]>;
}

const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const statsLine =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(\S+)\s+(.+)$/;
const commandLine = /^\s*(\d+)\s+(.*)$/;

/** ps prints cumulative CPU as [[days-]hours:]minutes:seconds. */
export function cpuSeconds(value: string) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return 0;
  return (
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4])
  );
}

/** Joins the two ps listings by pid. A process that ended between them is dropped. */
export function parseProcesses(stats: string, commands: string): ProcessFact[] {
  const commandByPid = new Map<number, string>();
  for (const line of commands.split("\n")) {
    const match = commandLine.exec(line);
    if (match) commandByPid.set(Number(match[1]), match[2]!.trim());
  }
  const result: ProcessFact[] = [];
  for (const line of stats.split("\n")) {
    const match = statsLine.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = commandByPid.get(pid);
    if (command === undefined) continue;
    const month = months.indexOf(match[5]!);
    const started =
      month < 0
        ? null
        : new Date(
            Number(match[10]),
            month,
            Number(match[6]),
            Number(match[7]),
            Number(match[8]),
            Number(match[9]),
          ).getTime();
    result.push({
      pid,
      ppid: Number(match[2]),
      tty: /^[A-Za-z0-9]{1,24}$/.test(match[3]!) ? match[3]! : null,
      foreground: match[4]!.includes("+"),
      startedAt: started !== null && Number.isFinite(started) ? started : null,
      cpuSeconds: cpuSeconds(match[11]!),
      exe: match[12]!.trim(),
      command,
    });
  }
  return result;
}

export function readProcesses(system: System): ProcessFact[] {
  // comm and command both have free width, so each comes last in its own listing.
  // The C locale: the parser expects the English month names of lstart.
  const stats = system.run(
    "/bin/ps",
    ["-axww", "-o", "pid=,ppid=,tty=,stat=,lstart=,time=,comm="],
    { cLocale: true },
  );
  const commands = system.run("/bin/ps", ["-axww", "-o", "pid=,command="], {
    cLocale: true,
  });
  if (stats.status !== 0 || commands.status !== 0) return [];
  return parseProcesses(stats.stdout, commands.stdout);
}

export function processTree(processes: ProcessFact[]): ProcessTree {
  const byPid = new Map<number, ProcessFact>();
  const children = new Map<number, number[]>();
  for (const process of processes) byPid.set(process.pid, process);
  for (const process of processes) {
    const siblings = children.get(process.ppid);
    if (siblings) siblings.push(process.pid);
    else children.set(process.ppid, [process.pid]);
  }
  return { byPid, children };
}

/** Parent first, then grandparent, up to the limit. A loop in bad data stops it. */
export function ancestors(tree: ProcessTree, pid: number, limit = 16) {
  const result: ProcessFact[] = [];
  const seen = new Set<number>([pid]);
  let current = tree.byPid.get(pid);
  while (current && result.length < limit) {
    const parent = tree.byPid.get(current.ppid);
    if (!parent || seen.has(parent.pid)) break;
    seen.add(parent.pid);
    result.push(parent);
    current = parent;
  }
  return result;
}

/** One lsof call for every pid. A pid that lsof cannot read has no entry. */
export function readWorkingDirectories(system: System, pids: number[]) {
  const result = new Map<number, string>();
  if (!pids.length) return result;
  const output = system.run(
    "/usr/sbin/lsof",
    ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")],
    { timeoutMs: 4000 },
  );
  // lsof exits 1 when any listed pid is gone; the rest of the output is still valid.
  let pid: number | undefined;
  for (const line of output.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined && line.length > 1)
      result.set(pid, line.slice(1));
  }
  return result;
}
