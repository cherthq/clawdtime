import { cli, defineAgent, ServerOptions } from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { RoomServiceClient } from "livekit-server-sdk";
import { callEntry } from "./agent.mjs";
import { makeSharedDesk } from "./shared-desk.mjs";
import { sharedRooms } from "./shared-rooms.mjs";

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
  let roomService;
  const claimedRooms = sharedRooms({
    // The worker's own media server credentials; read only when the ledger is full.
    live: async (names) => {
      roomService ??= new RoomServiceClient(
        process.env.LIVEKIT_URL,
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET,
      );
      return (await roomService.listRooms(names)).map((room) => room.name);
    },
  });
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      port,
      agentName: process.env.AGENT_NAME,
      requestFunc: async (job) => {
        // The coordinator's registered room is authoritative, not job metadata.
        if (!(await claimedRooms.claim(job.room?.name))) {
          await job.reject();
          return;
        }
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
