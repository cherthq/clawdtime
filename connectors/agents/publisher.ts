import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoardScanner } from "./board.js";
import { realSystem } from "./system.js";

/**
 * A separate process that scans and prints one board snapshot on each line.
 * The scan starts other programs and waits for them. It stays out of the
 * process that serves the panel and calls, so it can never delay them.
 */
export function runPublisher(options: {
  intervalMs: number;
  scan: (intervalMs: number) => unknown;
  write: (line: string) => boolean;
  /** False ends the loop: the reader is gone. */
  alive: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}) {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return (async () => {
    while (options.alive()) {
      let line: string | undefined;
      try {
        line = JSON.stringify(options.scan(options.intervalMs));
      } catch {
        // One failed scan is skipped. The reader sees the board go stale.
      }
      if (line !== undefined && !options.write(`${line}\n`)) return;
      await sleep(options.intervalMs);
    }
  })();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const requested = Number(process.argv[2] ?? 3000);
  const intervalMs =
    Number.isInteger(requested) && requested >= 1000 && requested <= 60_000
      ? requested
      : 3000;
  const scanner = new BoardScanner(realSystem());
  const parent = process.ppid;
  let open = true;
  process.stdout.on("error", () => {
    open = false;
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => process.exit(0));
  void runPublisher({
    intervalMs,
    scan: (interval) => scanner.scan(interval),
    write: (line) => {
      if (open) process.stdout.write(line);
      return open;
    },
    // When the reader ends without closing the pipe, the parent pid changes.
    alive: () => open && process.ppid === parent,
  }).then(() => process.exit(0));
}
