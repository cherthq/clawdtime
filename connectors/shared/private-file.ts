/**
 * Owner-only files: a regular file of this user, for its owner only, with one
 * name, in a folder of this user. A file that is anything else (a link, a file
 * with a second name, a file of another user, a file that others can read) is
 * not read and is never overwritten: the person looks at it first. A file is
 * written whole and then renamed into place, so a reader never sees half of it.
 *
 * Two kinds of folder: "private" is for its owner only (0700), as the state
 * folder of ClawdTime is. "owner-writable" may be read by others but written
 * only by its owner, as the `line/` folder of a checkout is: the file in it is
 * still for its owner only (0600).
 *
 * Every problem is a fixed sentence that names a file or a folder, never what
 * the file holds.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type FolderKind = "private" | "owner-writable";

/** A problem with a fixed sentence that holds no value of the file. */
export class PrivateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateFileError";
  }
}

const mine = (stat: Stats) =>
  process.getuid === undefined || stat.uid === process.getuid();

export const notPrivateFile = (file: string) =>
  `${file} is not a regular file of this user for its owner only, so it is not used and not changed. Look at it, then run: chmod 600 ${file}`;
const folderOpen = (folder: string, kind: FolderKind) =>
  kind === "private"
    ? `The folder ${folder} is not a folder of this user for its owner only, so nothing is read from it or written to it. Run: chmod 700 ${folder}`
    : `The folder ${folder} is not a folder of this user that only its owner can write, so nothing is read from it or written to it. Run: chmod go-w ${folder}`;

/** Null: the folder is fine. "missing": it is not there. Otherwise the problem. */
export function folderProblem(
  folder: string,
  kind: FolderKind = "private",
): string | "missing" | null {
  let stat: Stats;
  try {
    stat = lstatSync(folder);
  } catch {
    return "missing";
  }
  const closed = kind === "private" ? 0o077 : 0o022;
  return stat.isDirectory() && mine(stat) && (stat.mode & closed) === 0
    ? null
    : folderOpen(folder, kind);
}

const safeFile = (stat: Stats) =>
  stat.isFile() && mine(stat) && (stat.mode & 0o077) === 0 && stat.nlink === 1;

/**
 * The bytes of one owner-only file: null when it is not there. The file is
 * opened with no link followed and with no wait, so a link or a pipe in its
 * place is refused, and it is checked again once it is open.
 */
export function readPrivateBytes(
  file: string,
  options: { folder?: FolderKind; largest?: number } = {},
): { bytes: Buffer | null; problem: string | null } {
  const folder = folderProblem(dirname(file), options.folder ?? "private");
  if (folder === "missing") return { bytes: null, problem: null };
  if (folder) return { bytes: null, problem: folder };
  let before: Stats;
  try {
    before = lstatSync(file);
  } catch {
    return { bytes: null, problem: null };
  }
  if (!safeFile(before)) return { bytes: null, problem: notPrivateFile(file) };
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return { bytes: null, problem: notPrivateFile(file) };
  }
  try {
    const stat = fstatSync(fd);
    if (!safeFile(stat) || stat.ino !== before.ino || stat.dev !== before.dev)
      return { bytes: null, problem: notPrivateFile(file) };
    if (stat.size > (options.largest ?? 64 * 1024))
      return {
        bytes: null,
        problem: `${file} is too large, so it is not used and not changed.`,
      };
    return { bytes: readFileSync(fd), problem: null };
  } finally {
    closeSync(fd);
  }
}

/** One owner-only JSON file: null when it is not there. */
export function readPrivateJSON(
  file: string,
  options: { folder?: FolderKind } = {},
): { value: unknown; problem: string | null } {
  const read = readPrivateBytes(file, options);
  if (read.problem || !read.bytes)
    return { value: null, problem: read.problem };
  try {
    return { value: JSON.parse(read.bytes.toString("utf8")), problem: null };
  } catch {
    return {
      value: null,
      problem: `${file} is not valid, so it is not used and not changed. Look at it, and move it away to start again.`,
    };
  }
}

/**
 * Writes one owner-only file whole. A private folder that is not there is
 * made for its owner only. A folder or a file that is not safe is refused,
 * and the file in place is then not changed.
 */
export function writePrivateFile(
  file: string,
  text: string,
  options: { folder?: FolderKind } = {},
) {
  const kind = options.folder ?? "private";
  const folder = dirname(file);
  let problem = folderProblem(folder, kind);
  if (problem === "missing" && kind === "private") {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    problem = folderProblem(folder, kind);
  }
  if (problem === "missing")
    throw new PrivateFileError(`The folder ${folder} is not there.`);
  if (problem) throw new PrivateFileError(problem);
  const existing = (() => {
    try {
      return lstatSync(file);
    } catch {
      return null;
    }
  })();
  if (existing && !safeFile(existing))
    throw new PrivateFileError(notPrivateFile(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  // The file in place is checked again just before it is replaced.
  try {
    const now = lstatSync(file);
    if (
      !safeFile(now) ||
      (existing && (now.ino !== existing.ino || now.dev !== existing.dev))
    ) {
      unlinkSync(temporary);
      throw new PrivateFileError(notPrivateFile(file));
    }
  } catch (error) {
    if (error instanceof PrivateFileError) throw error;
    if (existing) {
      unlinkSync(temporary);
      throw new PrivateFileError(notPrivateFile(file));
    }
  }
  renameSync(temporary, file);
}

/** Writes one owner-only JSON file whole. */
export function writePrivateJSON(
  file: string,
  value: unknown,
  options: { folder?: FolderKind } = {},
) {
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Makes a folder for its owner only, or says why it cannot be used. */
export function privateFolder(folder: string) {
  let problem = folderProblem(folder);
  if (problem === "missing") {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    problem = folderProblem(folder);
  }
  if (problem)
    throw new PrivateFileError(
      problem === "missing" ? `The folder ${folder} is not there.` : problem,
    );
}
