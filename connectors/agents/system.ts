import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";

export interface CommandResult {
  /** null when the command could not start or was stopped by the timeout. */
  status: number | null;
  stdout: string;
}
export interface FileFacts {
  mtimeMs: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

/** Every side effect of the board goes through here, so tests can replace it. */
export interface System {
  now(): number;
  home: string;
  env: Record<string, string | undefined>;
  run(
    command: string,
    args: string[],
    options?: {
      timeoutMs?: number;
      maxBuffer?: number;
      /** Run in the C locale, for output that is parsed as English text. */
      cLocale?: boolean;
    },
  ): CommandResult;
  /** A regular file's text, or null when it is missing, special or too large. */
  readText(path: string, maxBytes?: number): string | null;
  /** The last maxBytes of a regular file, starting at a line boundary. */
  readTail(path: string, maxBytes: number): string | null;
  /** The first maxBytes of a regular file, cut wherever the limit falls. */
  readHead(path: string, maxBytes: number): string | null;
  list(path: string): string[];
  stat(path: string): FileFacts | null;
}

function slice(path: string, maxBytes: number, from: "head" | "tail") {
  let fd: number | undefined;
  try {
    // Symbolic links are refused: a session file is a plain file of its owner.
    if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const position = from === "tail" ? stat.size - length : 0;
    const read = readSync(fd, buffer, 0, length, position);
    const value = buffer.subarray(0, read).toString("utf8");
    if (stat.size <= maxBytes) return value;
    // A cut tail starts in the middle of a line: drop that partial line.
    if (from === "head") return value;
    const line = value.indexOf("\n");
    return line < 0 ? "" : value.slice(line + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function realSystem(): System {
  return {
    now: () => Date.now(),
    home: homedir(),
    env: process.env,
    run(command, args, options = {}) {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 3000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        // Only on request: tmux, for one, changes its output in the C locale.
        env: options.cLocale
          ? { ...process.env, LC_ALL: "C", LANG: "C" }
          : process.env,
      });
      return {
        status: result.error ? null : result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
      };
    },
    readText(path, maxBytes = 262_144) {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > maxBytes) return null;
      } catch {
        return null;
      }
      return slice(path, maxBytes, "head");
    },
    readTail: (path, maxBytes) => slice(path, maxBytes, "tail"),
    readHead: (path, maxBytes) => slice(path, maxBytes, "head"),
    list(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    stat(path) {
      try {
        // Follows links: programs are often installed as links. Reads do not.
        const stat = statSync(path);
        return {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
        };
      } catch {
        return null;
      }
    },
  };
}
