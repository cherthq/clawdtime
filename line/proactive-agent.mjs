// One explicitly configured attempt per dedicated worker. Never the incoming host.
import { cli, defineAgent, ServerOptions } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { callEntry } from "./agent.mjs";
import {
  createProactiveCallClient,
  readProactiveConfig,
} from "./proactive-outbound.mjs";

const config = () =>
  readProactiveConfig(process.env.CLAWDTIME_PROACTIVE_CONFIG);
export async function proactiveEntry(ctx) {
  const c = config();
  if (ctx.job?.room?.name !== c.roomName || Date.now() >= c.expiresAt)
    throw Error("proactive_job_mismatch");
  await callEntry(ctx, { proactive: createProactiveCallClient(c) });
}
export default defineAgent({ entry: proactiveEntry });

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const c = config();
  const port = Number(process.env.CLAWDTIME_LINE_PORT);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(process.env.AGENT_NAME ?? ""))
    throw Error("Dedicated proactive worker name required");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw Error("Dedicated proactive worker port required");
  let accepted = false;
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: process.env.AGENT_NAME,
      port,
      requestFunc: async (job) => {
        let metadata;
        try {
          metadata = JSON.parse(job.job.metadata);
        } catch {}
        if (
          accepted ||
          job.room?.name !== c.roomName ||
          metadata?.clawdtimeAttemptId !== c.attemptId ||
          Date.now() >= c.expiresAt
        )
          return job.reject();
        accepted = true; // A lost acceptance never admits a replacement job.
        return job.accept("ClawdTime", c.agentIdentity);
      },
    }),
  );
}
