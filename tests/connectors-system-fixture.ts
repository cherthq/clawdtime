/**
 * A made-up Mac for the process probes: every program's output comes from a
 * fixture in tests/fixtures/system, and the reports from its reports folder.
 * The processes, names, ports and reports are invented. Nothing here runs a
 * program or sends a signal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  RunLimits,
  RunResult,
  Signal,
  SystemHost,
} from "../connectors/system/host.js";
import { psColumns } from "../connectors/system/parse.js";

const folder = fileURLToPath(new URL("./fixtures/system/", import.meta.url));
export const fixture = (name: string) =>
  readFileSync(`${folder}${name}`, "utf8");

/** The time of the made-up Mac: 26 Nov 2026, 10:00 in the morning, Pacific. */
export const fakeNow = Date.parse("2026-11-26T10:00:00-08:00");
export const fakeHome = "/Users/sam";

/** When each made-up report was written. */
const reportTimes: Record<string, string> = {
  "Riverchat-2026-11-26-095800.ips": "2026-11-26T09:58:00-08:00",
  "Stonepad_2026-11-26-094500.hang": "2026-11-26T09:45:00-08:00",
  "JetsamEvent-2026-11-26-070000.ips": "2026-11-26T07:00:00-08:00",
  "backupd_2026-11-25-220000.cpu_resource.diag": "2026-11-25T22:00:00-08:00",
  "Ledgerly_2026-11-20-120000.crash": "2026-11-20T12:00:00-08:00",
};

const ok = (stdout: string, code = 0): RunResult => ({
  code,
  stdout,
  timedOut: false,
  cut: false,
  missing: false,
});

/** The one row of a pid in the made-up listing, as `ps -p PID` prints it. */
const psRow = (pid: string) =>
  fixture("ps-fields.txt")
    .split("\n")
    .filter((line) => line.trim().split(/\s+/)[0] === pid)
    .join("\n");

/** The default answers: the command line as one string, then its output. */
export function defaultOutputs(): Record<string, RunResult> {
  return {
    [`/bin/ps -axww -o ${psColumns}`]: ok(fixture("ps-fields.txt")),
    "/bin/ps -axww -o pid=,command=": ok(fixture("ps-commands.txt")),
    "/bin/ps -ww -o lstart=,command= -p 4242": ok(fixture("ps-detail.txt")),
    "/bin/ps -M -p 4242": ok(fixture("ps-threads.txt")),
    "/usr/sbin/lsof -n -P -p 4242 -F ftPnT": ok(fixture("lsof-process.txt")),
    "/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -F pcfnT": ok(
      fixture("lsof-listen.txt"),
    ),
    "/usr/sbin/lsof -nP -iTCP:4173 -F pcfnT": ok(fixture("lsof-port.txt")),
    "/usr/sbin/lsof -nP -iTCP:9999 -F pcfnT": ok("", 1),
    '/usr/bin/log show --last 5m --style compact --predicate process == "Stonepad"':
      ok(fixture("log-show.txt")),
    '/usr/bin/log show --last 5m --style compact --predicate process == "Riverchat"':
      ok("Timestamp               Ty Process[PID:TID]\n"),
    "/bin/launchctl list": ok(fixture("launchctl-list.txt")),
    "/usr/sbin/sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level vm.loadavg hw.ncpu":
      ok(fixture("sysctl.txt")),
    "/usr/bin/memory_pressure -Q": ok(fixture("memory-pressure.txt")),
    "/bin/df -kP / /System/Volumes/Data": ok(fixture("df.txt")),
    "/usr/bin/lsappinfo info -only pid -app com.example.stonepad":
      ok('"pid"=4242\n'),
    "/usr/bin/lsappinfo info -only pid -app com.example.riverchat": ok(""),
    "/usr/bin/lsappinfo info -only pid -app com.example.ledgerly":
      ok('"pid"=9100\n'),
    "/usr/bin/lsappinfo info -only pid -app com.example.notes":
      ok('"pid"=671\n'),
  };
}

export interface FakeHost extends SystemHost {
  /** Every program that ran, as one string each. */
  calls: string[];
  /** The limits that each of them ran with. */
  limits: RunLimits[];
  /** Every signal that was sent. */
  signals: { pid: number; signal: Signal }[];
  /** The answers by command line; a test may change them. */
  outputs: Record<string, RunResult>;
  /** Pids that are gone. A signal ends a pid when `signalEnds` says so. */
  gone: Set<number>;
  /** Which signals end a process at once. */
  signalEnds: Set<Signal>;
  /** The answer to the quit of an app, by pid: it then ends, or it stays. */
  quitEnds: Set<number>;
}

export function fakeHost(
  options: { outputs?: Record<string, RunResult>; now?: number } = {},
): FakeHost {
  const outputs = { ...defaultOutputs(), ...options.outputs };
  const calls: string[] = [];
  const limits: RunLimits[] = [];
  const signals: { pid: number; signal: Signal }[] = [];
  const gone = new Set<number>();
  const signalEnds = new Set<Signal>(["SIGKILL", "SIGTERM"]);
  const quitEnds = new Set<number>();
  const reports = fileURLToPath(
    new URL("./fixtures/system/reports/", import.meta.url),
  );
  const userReports = `${fakeHome}/Library/Logs/DiagnosticReports`;
  const host: FakeHost = {
    calls,
    limits,
    signals,
    outputs,
    gone,
    signalEnds,
    quitEnds,
    home: fakeHome,
    uid: 501,
    self: { pid: 8800, ppid: 8700 },
    now: () => options.now ?? fakeNow,
    async exec(file, args, limit) {
      const line = [file, ...args].join(" ");
      calls.push(line);
      limits.push(limit);
      if (file === "/bin/ps" && args[0] === "-ww" && args[2] === psColumns) {
        const pid = args[4]!;
        return gone.has(Number(pid)) ? ok("", 1) : ok(psRow(pid));
      }
      if (file === "/usr/bin/osascript") {
        const pid = Number(/WithProcessIdentifier\((\d+)\)/.exec(line)?.[1]);
        if (gone.has(pid)) return ok("gone\n");
        if (quitEnds.has(pid)) gone.add(pid);
        return ok("asked\n");
      }
      if (file === "/usr/bin/open") return ok("");
      return outputs[line] ?? ok("", 1);
    },
    files: {
      list: (dir) =>
        dir === userReports
          ? readdirSync(reports).filter((name) => name in reportTimes)
          : [],
      stat: (path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        const at = reportTimes[name];
        return at && path.startsWith(userReports)
          ? { mtimeMs: Date.parse(at), size: 4096 }
          : null;
      },
      head: (path, maxBytes) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return name in reportTimes
          ? readFileSync(`${reports}${name}`, "utf8").slice(0, maxBytes)
          : null;
      },
    },
    signal(pid, signal) {
      signals.push({ pid, signal });
      if (gone.has(pid)) return "gone";
      if (pid === 7100) return "denied";
      if (signalEnds.has(signal)) gone.add(pid);
      return "sent";
    },
    alive: (pid) => !gone.has(pid),
    sleep: async () => {},
  };
  return host;
}
