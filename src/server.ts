import { serve } from "@hono/node-server";
import { createRuntime } from "./runtime.js";
function startRuntime() {
  try {
    return createRuntime();
  } catch {
    // Configuration validators may include parsed input. Never print their cause.
    throw new Error(
      "ClawdTime startup refused. Check protected configuration, ownership evidence and storage permissions; configuration values were withheld.",
    );
  }
}
const runtime = startRuntime();
const port = Number(process.env.CLAWDTIME_PORT ?? 3310),
  hostname = process.env.CLAWDTIME_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid port.");
if (
  (process.env.CLAWDTIME_MODE ?? "simulation") === "simulation" &&
  hostname !== "127.0.0.1"
)
  throw new Error("Simulation binds loopback only.");
const server = serve({ fetch: runtime.app.fetch, port, hostname }, () =>
  console.log(
    `ClawdTime listening on ${hostname}:${port}; ${runtime.transport.mode}; physical acceptance unverified.`,
  ),
);
const interval = setInterval(() => void runtime.tick(), 1000);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    await Promise.all([
      runtime.stop(),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    runtime.store.close();
    process.exit(0);
  });
