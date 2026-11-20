import type {
  CommandResult,
  FileFacts,
  System,
} from "../connectors/agents/system.js";

export interface FakeFile {
  text: string;
  mtimeMs?: number;
}
export interface FakeProcess {
  pid: number;
  ppid: number;
  tty?: string;
  /** Epoch ms. Printed the way ps prints lstart, in local time. */
  startedAt: number;
  exe: string;
  command?: string;
  foreground?: boolean;
  cwd?: string;
}

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
const pad = (value: number) => String(value).padStart(2, "0");
export const lstart = (time: number) => {
  const date = new Date(time);
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
};

export function psListings(processes: FakeProcess[]) {
  const stats = processes
    .map(
      (process) =>
        `${String(process.pid).padStart(5)} ${String(process.ppid).padStart(5)} ${(process.tty ?? "??").padEnd(8)} ${process.foreground === false ? "S " : "S+"}   ${lstart(process.startedAt)}       0:01.50 ${process.exe}`,
    )
    .join("\n");
  const commands = processes
    .map(
      (process) =>
        `${String(process.pid).padStart(5)} ${process.command ?? process.exe}`,
    )
    .join("\n");
  return { stats, commands };
}

export interface FakeOptions {
  now: number;
  home?: string;
  env?: Record<string, string | undefined>;
  processes?: FakeProcess[];
  files?: Record<string, FakeFile>;
  /** Answers for commands other than ps and lsof. */
  commands?: (command: string, args: string[]) => CommandResult | undefined;
}

export function fakeSystem(options: FakeOptions): System & {
  calls: string[];
} {
  const files = options.files ?? {};
  const processes = options.processes ?? [];
  const calls: string[] = [];
  const file = (path: string) => files[path];
  return {
    calls,
    now: () => options.now,
    home: options.home ?? "/Users/tester",
    env: options.env ?? { PATH: "/opt/homebrew/bin:/usr/bin" },
    run(command, args) {
      calls.push([command, ...args].join(" "));
      if (command === "/bin/ps") {
        const listings = psListings(processes);
        return {
          status: 0,
          stdout: args.includes("pid=,command=")
            ? listings.commands
            : listings.stats,
        };
      }
      if (command === "/usr/sbin/lsof") {
        const wanted = new Set((args.at(-1) ?? "").split(",").map(Number));
        return {
          status: 0,
          stdout: processes
            .filter((process) => wanted.has(process.pid) && process.cwd)
            .map((process) => `p${process.pid}\nfcwd\nn${process.cwd}`)
            .join("\n"),
        };
      }
      return options.commands?.(command, args) ?? { status: null, stdout: "" };
    },
    readText(path, maxBytes = 262_144) {
      const found = file(path);
      return !found || found.text.length > maxBytes ? null : found.text;
    },
    readTail(path, maxBytes) {
      const found = file(path);
      if (!found) return null;
      if (found.text.length <= maxBytes) return found.text;
      const cut = found.text.slice(-maxBytes);
      return cut.slice(cut.indexOf("\n") + 1);
    },
    readHead(path, maxBytes) {
      const found = file(path);
      return found ? found.text.slice(0, maxBytes) : null;
    },
    list(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const name of Object.keys(files))
        if (name.startsWith(prefix))
          names.add(name.slice(prefix.length).split("/")[0]!);
      return [...names];
    },
    stat(path): FileFacts | null {
      const found = file(path);
      if (found)
        return {
          mtimeMs: found.mtimeMs ?? options.now,
          size: found.text.length,
          isFile: true,
          isDirectory: false,
        };
      const prefix = `${path}/`;
      return Object.keys(files).some((name) => name.startsWith(prefix))
        ? { mtimeMs: options.now, size: 0, isFile: false, isDirectory: true }
        : null;
    },
  };
}

export const jsonl = (...records: unknown[]) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
