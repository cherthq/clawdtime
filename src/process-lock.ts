/**
 * A lock that the kernel holds for one process: a file opened with O_EXLOCK.
 * The lock ends when its process ends, also when the process is killed, so a
 * stale lock never needs to be taken over. The file holds a small record of
 * the holder for the readers. It is macOS only, as ClawdTime is.
 */
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";

// <sys/fcntl.h> on Darwin. Node does not export them.
const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

const busy = (error: unknown) =>
  ["EAGAIN", "EWOULDBLOCK"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  );

function open(path: string, lock: number, create: boolean) {
  if (process.platform !== "darwin") throw Error("process_lock_needs_macos");
  return openSync(
    path,
    (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      lock,
    0o600,
  );
}

function ownerOnly(fd: number) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.mode & 0o077 || stat.uid !== process.getuid?.()) {
    closeSync(fd);
    throw Error("process_lock_not_private");
  }
}

export interface HeldLock {
  release(): void;
}

/** Takes the lock and writes the record, or returns null when another process holds it. */
export function takeProcessLock(
  path: string,
  record: Record<string, unknown>,
): HeldLock | null {
  let fd: number;
  try {
    fd = open(path, O_EXLOCK, true);
  } catch (error) {
    if (busy(error)) return null;
    throw error;
  }
  ownerOnly(fd);
  ftruncateSync(fd, 0);
  writeSync(fd, JSON.stringify(record), 0);
  let held = true;
  return {
    release: () => {
      if (!held) return;
      held = false;
      closeSync(fd);
    },
  };
}

/**
 * The record of the process that holds the lock now, or null when none does.
 * It never waits, never makes the file and never takes the lock from its
 * holder. A record that cannot be read is an empty object: someone holds the
 * lock all the same.
 */
export function processLockHolder(
  path: string,
): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = open(path, O_SHLOCK, false);
  } catch (error) {
    if (!busy(error)) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  // Nobody holds it: the shared lock was free.
  closeSync(fd);
  return null;
}
