import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  lstatSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** A crash leaves this owner record in place. Never reclaim it by PID or age. */
export class BackgroundLifecycle {
  private held = false;
  private identity?: { dev: number; ino: number; bytes: string };
  private record?: { taskId: string; sessionId: string; driverPid: number };
  constructor(private path: string) {
    const parent = lstatSync(dirname(path));
    if (
      !path.startsWith("/") ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.mode & 0o077 ||
      parent.uid !== process.getuid?.()
    )
      throw Error("Background owner directory must be private");
  }
  acquire(record: { taskId: string; sessionId: string; driverPid: number }) {
    if (this.held) throw Error("Background daemon is already owned");
    record = z
      .object({
        taskId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
        sessionId: z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/),
        driverPid: z.number().int().positive().safe(),
      })
      .strict()
      .parse(record);
    const bytes = JSON.stringify({
      version: 1,
      nonce: randomUUID(),
      supervisorPid: process.pid,
      ...record,
    });
    const fd = openSync(this.path, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.syncParent();
    const stat = lstatSync(this.path);
    this.identity = { dev: stat.dev, ino: stat.ino, bytes };
    this.held = true;
    this.record = record;
  }
  assert(taskId: string, sessionId: string, driverPid: number) {
    if (
      !this.held ||
      this.record?.taskId !== taskId ||
      this.record.sessionId !== sessionId ||
      this.record.driverPid !== driverPid
    )
      throw Error("Background lifecycle is not owned");
    this.checkIdentity();
  }
  release(cleanupVerified: boolean) {
    if (!this.held || !cleanupVerified) return;
    this.checkIdentity();
    unlinkSync(this.path);
    this.syncParent();
    this.held = false;
    this.record = undefined;
  }
  private checkIdentity() {
    const stat = lstatSync(this.path);
    if (
      !stat.isFile() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.identity?.dev ||
      stat.ino !== this.identity?.ino ||
      readFileSync(this.path, "utf8") !== this.identity?.bytes
    )
      throw Error("Background owner record changed; recovery required");
  }
  private syncParent() {
    const fd = openSync(dirname(this.path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
