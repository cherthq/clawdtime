import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

/** A byte boundary in this exact append-only log, not a historical stopped row. */
export function hostLogBoundary(path) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("host_log_unavailable");
    return { device: stat.dev, inode: stat.ino, offset: stat.size };
  } finally {
    closeSync(fd);
  }
}

/** Read only new complete records. Rotation, truncation and overflow stay unknown. */
export function hostStopReceipt(path, boundary) {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(boundary.offset) ||
      boundary.offset < 0 ||
      stat.dev !== boundary.device ||
      stat.ino !== boundary.inode ||
      stat.size < boundary.offset ||
      stat.size - boundary.offset > 1024 * 1024
    )
      return { state: "unknown", reason: "host_log_changed" };
    const bytes = Buffer.alloc(stat.size - boundary.offset);
    const read = readSync(fd, bytes, 0, bytes.length, boundary.offset);
    const text = bytes.subarray(0, read).toString("utf8");
    let stopped = false;
    for (const line of text.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.code === "release_failed" || row.code === "cleanup_pending")
        return { state: "unknown", reason: "host_cleanup_unconfirmed" };
      if (row.code === "dev_stopped") {
        if (row.retained !== 0)
          return { state: "unknown", reason: "host_retained_work" };
        stopped = true;
      } else if (
        stopped &&
        [
          "dev_connected",
          "dev_reconnected",
          "call_preparing",
          "call_accepted",
        ].includes(row.code)
      ) {
        return { state: "unknown", reason: "host_restarted" };
      }
    }
    return stopped
      ? { state: "released", retained: 0, offset: boundary.offset + read }
      : { state: "waiting", reason: "host_release_pending" };
  } finally {
    closeSync(fd);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    if (process.argv[2] === "boundary") {
      console.log(JSON.stringify(hostLogBoundary(process.argv[3])));
    } else if (process.argv[2] === "released") {
      const receipt = hostStopReceipt(
        process.argv[3],
        JSON.parse(process.argv[4]),
      );
      process.exitCode = receipt.state === "released" ? 0 : 1;
    } else process.exitCode = 2;
  } catch {
    process.exitCode = 1;
  }
}
