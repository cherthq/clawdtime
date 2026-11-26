import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  DocumentRootGrant,
  DocumentCandidate,
} from "../../src/contracts.js";

export interface LocalDocumentSelection {
  candidateId: string;
  sha256: string;
}
const maxFileBytes = 10 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const safeName = (name: string) =>
  name !== "." &&
  name !== ".." &&
  basename(name) === name &&
  !/[\p{Cc}\p{Cs}]/u.test(name) &&
  name.length <= 180 &&
  !name.includes("\\");

/** Bounded ZIP directory inspection; no archive extraction or executable content. */
function zipEntries(bytes: Buffer): Set<string> | undefined {
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65_557);
    at--
  ) {
    if (
      bytes.readUInt32LE(at) === 0x06054b50 &&
      at + 22 + bytes.readUInt16LE(at + 20) === bytes.length
    ) {
      end = at;
      break;
    }
  }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    return;
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  if (
    count > 4096 ||
    count !== bytes.readUInt16LE(end + 8) ||
    start + size !== end
  )
    return;
  const names = new Set<string>();
  let at = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) return;
    const length = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30),
      comment = bytes.readUInt16LE(at + 32);
    const next = at + 46 + length + extra + comment;
    total += bytes.readUInt32LE(at + 24);
    if (
      next > end ||
      length > 4096 ||
      total > maxTotalBytes ||
      bytes.readUInt16LE(at + 8) & 1
    )
      return;
    const name = bytes.subarray(at + 46, at + 46 + length).toString("utf8");
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      names.has(name)
    )
      return;
    names.add(name);
    at = next;
  }
  return at === end ? names : undefined;
}
function documentType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    return "application/pdf";
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    return;
  const names = zipEntries(bytes);
  if (names?.has("[Content_Types].xml") && names.has("word/document.xml"))
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (
    names?.has("Index/Document.iwa") &&
    [...names].some((name) => name.startsWith("Metadata/"))
  )
    return "application/vnd.apple.pages";
}

/** Read-only flat directory access. No shell, network, UI input or agent-generated paths. */
export class LocalDocuments {
  private candidates = new Map<string, DocumentCandidate>();
  private readonly nonce = randomBytes(32);
  readonly grant: Readonly<DocumentRootGrant>;
  constructor(
    grant: DocumentRootGrant,
    private readonly authorize: () => void | Promise<void>,
    private readonly clock = Date.now,
  ) {
    if (
      !Number.isFinite(grant.expiresAt) ||
      !grant.id ||
      !grant.sessionId ||
      !grant.pairingId ||
      !grant.memberId ||
      !grant.hostId
    )
      throw new Error("Invalid document root authority.");
    this.grant = Object.freeze({ ...grant });
  }
  private async check(signal: AbortSignal, refresh = true) {
    if (
      this.grant.state !== "active" ||
      signal.aborted ||
      this.clock() >= this.grant.expiresAt
    )
      throw new Error("Document authority is stopped or expired.");
    if (refresh) await this.authorize();
    if (
      this.grant.state !== "active" ||
      signal.aborted ||
      this.clock() >= this.grant.expiresAt
    )
      throw new Error("Document authority is stopped or expired.");
    const stat = await lstat(this.grant.projectRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(this.grant.projectRoot)) !== this.grant.projectRoot
    )
      throw new Error(
        "Document root is no longer the exact authorized directory.",
      );
  }
  private async read(name: string, signal: AbortSignal): Promise<Buffer> {
    if (!safeName(name)) throw new Error("Invalid document name.");
    await this.check(signal);
    const path = join(this.grant.projectRoot, name);
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > maxFileBytes
    )
      throw new Error("Document is not a bounded regular file.");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer | undefined;
    try {
      const initial = await handle.stat();
      if (
        !initial.isFile() ||
        initial.size > maxFileBytes ||
        initial.dev !== before.dev ||
        initial.ino !== before.ino ||
        (await realpath(path)) !== path
      )
        throw new Error("Document identity changed before read.");
      bytes = Buffer.alloc(initial.size);
      let offset = 0;
      while (offset < bytes.length) {
        await this.check(signal, false);
        const result = await handle.read(
          bytes,
          offset,
          Math.min(64 * 1024, bytes.length - offset),
          offset,
        );
        if (result.bytesRead === 0)
          throw new Error("Document changed during read.");
        offset += result.bytesRead;
      }
      await this.check(signal);
      const after = await handle.stat(),
        current = await lstat(path);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        (await realpath(path)) !== path ||
        after.dev !== initial.dev ||
        after.ino !== initial.ino ||
        after.size !== initial.size ||
        after.mtimeMs !== initial.mtimeMs ||
        after.ctimeMs !== initial.ctimeMs ||
        current.dev !== after.dev ||
        current.ino !== after.ino ||
        current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs ||
        current.ctimeMs !== after.ctimeMs
      )
        throw new Error("Document changed during read.");
      return bytes;
    } catch (error) {
      bytes?.fill(0);
      throw error;
    } finally {
      await handle.close();
    }
  }
  async discover(signal: AbortSignal): Promise<DocumentCandidate[]> {
    await this.check(signal);
    const entries: string[] = [];
    const directory = await opendir(this.grant.projectRoot);
    let scanned = 0;
    for await (const entry of directory) {
      await this.check(signal);
      if (++scanned > 256)
        throw new Error("Document directory exceeds discovery bound.");
      if (!entry.isFile() || !safeName(entry.name)) continue;
      if (entries.length >= 32)
        throw new Error("Too many document candidates.");
      entries.push(entry.name);
    }
    const manifest: DocumentCandidate[] = [];
    let total = 0;
    for (const name of entries.sort()) {
      const bytes = await this.read(name, signal);
      try {
        total += bytes.length;
        if (total > maxTotalBytes)
          throw new Error("Document discovery exceeds total byte bound.");
        const sha256 = digest(bytes),
          mimeType = documentType(bytes);
        if (!mimeType) continue;
        const id =
          "doc_" +
          createHash("sha256")
            .update(this.nonce)
            .update(
              JSON.stringify([
                this.grant.id,
                this.grant.sessionId,
                name,
                sha256,
              ]),
            )
            .digest("hex");
        manifest.push({
          id,
          grantId: this.grant.id,
          name: name,
          byteLength: bytes.length,
          sha256,
          mimeType,
          previewSupport: process.platform === "darwin" ? "first_page" : "none",
        });
      } finally {
        bytes.fill(0);
      }
    }
    await this.check(signal);
    this.candidates = new Map(
      manifest.map((candidate) => [candidate.id, Object.freeze(candidate)]),
    );
    return manifest.map((candidate) => ({ ...candidate }));
  }
  /** The callback may consume bytes only under current exact selection authority; the buffer is erased afterward. */
  async withVerifiedDocument<T>(
    selection: LocalDocumentSelection,
    signal: AbortSignal,
    consume: (
      candidate: Readonly<DocumentCandidate>,
      bytes: Buffer,
      guard: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    await this.check(signal);
    const candidate = this.candidates.get(selection.candidateId);
    if (!candidate || candidate.sha256 !== selection.sha256)
      throw new Error("Exact current document selection required.");
    const bytes = await this.read(candidate.name, signal);
    try {
      if (
        bytes.length !== candidate.byteLength ||
        digest(bytes) !== candidate.sha256 ||
        documentType(bytes) !== candidate.mimeType
      )
        throw new Error(
          "Selected document content changed; discover and select again.",
        );
      await this.check(signal);
      return await consume(candidate, bytes, () => this.check(signal));
    } finally {
      bytes.fill(0);
    }
  }
}
