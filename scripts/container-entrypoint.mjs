import { chownSync, chmodSync, mkdirSync } from "node:fs";

// Railway mounts volumes as root. Prepare only our mount, then drop privileges
// before loading application code or opening the database.
if (process.getuid?.() === 0) {
  mkdirSync("/data", { recursive: true, mode: 0o700 });
  chownSync("/data", 1000, 1000);
  chmodSync("/data", 0o700);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
process.umask(0o077);
await import("../dist/src/server.js");
