import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const [operation, source, destination] = process.argv.slice(2);
const key = process.env.CLAWDTIME_BACKUP_KEY;
if (
  !["create", "restore"].includes(operation ?? "") ||
  !source ||
  !destination ||
  !key ||
  !/^[a-f0-9]{64}$/i.test(key)
)
  throw new Error(
    "Usage: backup create|restore SOURCE NEW_DESTINATION with independent CLAWDTIME_BACKUP_KEY (64 hex).",
  );
if (existsSync(destination))
  throw new Error("Destination already exists; never overwrite state.");
const dir = mkdtempSync(join(tmpdir(), "clawdtime-backup-")),
  snapshot = join(dir, "snapshot.sqlite");
try {
  if (operation === "create") {
    if (!statSync(source).isFile())
      throw new Error("Source must be an existing database.");
    const db = new DatabaseSync(source);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.prepare("VACUUM INTO ?").run(snapshot);
    } finally {
      db.close();
    }
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv),
      data = Buffer.concat([
        cipher.update(readFileSync(snapshot)),
        cipher.final(),
      ]);
    writeFileSync(
      destination,
      Buffer.concat([Buffer.from("CTDB001\n"), iv, cipher.getAuthTag(), data]),
      { flag: "wx", mode: 0o600 },
    );
  } else {
    const data = readFileSync(source);
    if (data.subarray(0, 8).toString() !== "CTDB001\n")
      throw new Error("Not a ClawdTime backend backup.");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      data.subarray(8, 20),
    );
    cipher.setAuthTag(data.subarray(20, 36));
    const plain = Buffer.concat([
      cipher.update(data.subarray(36)),
      cipher.final(),
    ]);
    writeFileSync(snapshot, plain, { mode: 0o600 });
    const db = new DatabaseSync(snapshot);
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new Error("Integrity check failed.");
    } finally {
      db.close();
    }
    writeFileSync(destination, plain, { flag: "wx", mode: 0o600 });
  }
  console.log(
    operation === "create"
      ? "Encrypted consistent backend backup created."
      : "Restored to a new offline file. Reconcile external effects and cursors before any traffic.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
