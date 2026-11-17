/** Local website QA only: simulation, disposable memory, no runtime ticking. */
import { serve } from "@hono/node-server";
import { createRuntime } from "../src/runtime.js";

const port = Number(process.env.CLAWDTIME_PREVIEW_PORT ?? 3337);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid preview port.");
const runtime = createRuntime({
  CLAWDTIME_MODE: "simulation",
  CLAWDTIME_DATABASE: ":memory:",
  CLAWDTIME_ORIGIN: `http://127.0.0.1:${port}`,
  CLAWDTIME_WEBSITE_ANALYTICS_ENABLED: "true",
  // Disposable preview fixture, never a production credential.
  CLAWDTIME_OPERATOR_TOKEN: "local-website-preview-not-a-production-key",
});
const server = serve(
  { fetch: runtime.app.fetch, hostname: "127.0.0.1", port },
  () => {
    console.log(
      `Website preview: http://127.0.0.1:${port} (simulation; in-memory counts; no calls)`,
    );
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => {
      runtime.store.close();
      process.exit(0);
    });
  });
