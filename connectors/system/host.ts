/**
 * The process level of the Mac: the one door to it.
 *
 * Every probe and every action of `connectors/system/` goes through a
 * `SystemHost`, so tests replace it with made-up outputs. The real one runs a
 * program with `execFile`: no shell, a fixed path, its own short timeout and a
 * cap on what it may print. The child gets a fixed environment with a path
 * and the C locale only, so no variable of ClawdTime reaches it, and no probe
 * reads an environment.
 */
import { execFile } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";

export interface RunLimits {
  timeoutMs: number;
  /** The most bytes of output. More is cut, and the result says so. */
  maxBytes: number;
}

export interface RunResult {
  /** The exit status. Null when the program did not end by itself. */
  code: number | null;
  stdout: string;
  /** Stopped by its timeout. */
  timedOut: boolean;
  /** The output reached its cap: what came after is not here. */
  cut: boolean;
  /** The program is not on this Mac. */
  missing: boolean;
}

export type Exec = (
  file: string,
  args: readonly string[],
  limits: RunLimits,
) => Promise<RunResult>;

export interface FileFacts {
  mtimeMs: number;
  size: number;
}

/** What the reports need: a folder's names, a file's facts and its first bytes. */
export interface ReportFiles {
  list(dir: string): string[];
  /** A regular file that is no link, or null. */
  stat(path: string): FileFacts | null;
  head(path: string, maxBytes: number): string | null;
}

export type Signal = "SIGTERM" | "SIGKILL";

export interface SystemHost {
  exec: Exec;
  files: ReportFiles;
  home: string;
  /** The user id of the owner: a process of another user is not theirs to end. */
  uid: number;
  now(): number;
  /** ClawdTime's own process and its parent. */
  self: { pid: number; ppid: number };
  /** Sends a signal. `gone`: no such process. `denied`: macOS did not allow it. */
  signal(pid: number, signal: Signal): "sent" | "gone" | "denied";
  /** True while a process with this pid exists. */
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

/** The only environment that a probe's program gets. */
const childEnv = (home: string) => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
  HOME: home,
});

export function realExec(home: string): Exec {
  return (file, args, limits) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        {
          encoding: "utf8",
          timeout: limits.timeoutMs,
          maxBuffer: limits.maxBytes,
          killSignal: "SIGKILL",
          env: childEnv(home),
          windowsHide: true,
        },
        (error, stdout) => {
          const failure = error as
            (Error & { code?: unknown; killed?: boolean }) | null;
          const code = failure?.code;
          const cut = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          resolve({
            code: failure ? (typeof code === "number" ? code : null) : 0,
            stdout: typeof stdout === "string" ? stdout : "",
            timedOut: !!failure && failure.killed === true && !cut,
            cut,
            missing: code === "ENOENT",
          });
        },
      );
    });
}

export const realFiles: ReportFiles = {
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  stat(path) {
    try {
      const stat = lstatSync(path);
      return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
    } catch {
      return null;
    }
  },
  head(path, maxBytes) {
    let fd: number | undefined;
    try {
      if (lstatSync(path).isSymbolicLink()) return null;
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile()) return null;
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read).toString("utf8");
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

export function realHost(): SystemHost {
  const home = homedir();
  return {
    exec: realExec(home),
    files: realFiles,
    home,
    uid: process.getuid?.() ?? -1,
    now: () => Date.now(),
    self: { pid: process.pid, ppid: process.ppid },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
        return "sent";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
          ? "gone"
          : "denied";
      }
    },
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
