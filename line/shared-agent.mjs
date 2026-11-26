import { cli, defineAgent, ServerOptions } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { callEntry } from "./agent.mjs";
import { makeSharedDesk } from "./shared-desk.mjs";

export async function sharedEntry(ctx) {
  const roomId = ctx.job?.room?.name;
  if (!roomId) throw Error("shared_room_required");
  const shared = await makeSharedDesk({
    origin: process.env.CLAWDTIME_SHARED_ORIGIN,
    token: process.env.CLAWDTIME_SHARED_LINE_TOKEN,
    roomId,
  });
  await callEntry(ctx, { shared });
}
export default defineAgent({ entry: sharedEntry });
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(process.env.AGENT_NAME ?? ""))
    throw Error("shared_agent_name_required");
  const port = Number(process.env.CLAWDTIME_SHARED_WORKER_PORT ?? 3320);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("shared_worker_port_required");
  const claimedRooms = new Set();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      port,
      agentName: process.env.AGENT_NAME,
      requestFunc: async (job) => {
        // The coordinator's registered room is authoritative, not job metadata.
        const room = job.room?.name;
        if (!room || claimedRooms.has(room) || claimedRooms.size >= 10000) {
          await job.reject();
          return;
        }
        claimedRooms.add(room);
        try {
          await makeSharedDesk({
            origin: process.env.CLAWDTIME_SHARED_ORIGIN,
            token: process.env.CLAWDTIME_SHARED_LINE_TOKEN,
            roomId: job.room?.name,
            claim: false,
          });
          await job.accept("ClawdTime", "shared-agent");
        } catch {
          await job.reject();
        }
      },
    }),
  );
}
