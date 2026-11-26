import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { secureRead, secureWrite } from "./state.js";

/** A successful write must be durable before the executor may dispatch a native effect. */
export interface NativeSceneJournal {
  read(): unknown[];
  write(receipts: unknown[]): void;
}

/** One foreground owner, bounded metadata only. Stale locks are retained for lead recovery. */
export class FileNativeSceneJournal implements NativeSceneJournal {
  private closed = false;
  private readonly lock: string;
  private readonly marker = `${process.pid}`;
  constructor(private readonly path: string) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Native operation journal requires an owner-only directory.",
      );
    this.lock = `${path}.lock`;
    const handle = openSync(
      this.lock,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(handle, this.marker);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }
  read(): unknown[] {
    if (this.closed) throw new Error("Native operation journal is closed.");
    if (!existsSync(this.path)) return [];
    if (lstatSync(this.path).size > 1024 * 1024)
      throw new Error(
        "Native operation journal exceeds its bound; preserve it for review.",
      );
    const saved = secureRead<{ version: number; receipts: unknown[] }>(
      this.path,
    );
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.receipts) ||
      saved.receipts.length > 256
    )
      throw new Error(
        "Invalid native operation journal; preserve it for review.",
      );
    return saved.receipts;
  }
  write(receipts: unknown[]): void {
    if (this.closed || receipts.length > 256)
      throw new Error("Native operation journal is closed or full.");
    const value = { version: 1, receipts };
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
      throw new Error("Native operation journal exceeds its byte bound.");
    secureWrite(this.path, value);
    const file = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    const directory = openSync(
      dirname(this.path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (readFileSync(this.lock, "utf8") !== this.marker)
      throw new Error("Native journal lock changed; preserve it for recovery.");
    rmSync(this.lock);
  }
}
