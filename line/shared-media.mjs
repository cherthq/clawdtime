import {
  AccessToken,
  RoomServiceClient,
  AgentDispatchClient,
} from "livekit-server-sdk";

/** One room per call. Tokens remain transient; audio/video are warm before accept. */
export function sharedMedia(
  config,
  {
    rooms = new RoomServiceClient(config.url, config.key, config.secret),
    dispatch = new AgentDispatchClient(config.url, config.key, config.secret),
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  return {
    async prepare({ roomId, expiresAt, deadlineAt, video, signal }) {
      if (
        signal?.aborted ||
        now() >= deadlineAt ||
        expiresAt <= now() ||
        expiresAt > now() + 7200000
      )
        throw Error("shared_media_deadline");
      await rooms.createRoom({
        name: roomId,
        emptyTimeout: 20,
        maxParticipants: 2,
      });
      if (signal?.aborted || now() >= deadlineAt)
        throw Error("shared_media_deadline");
      await dispatch.createDispatch(roomId, config.agentName);
      let ready = false;
      while (!signal?.aborted && now() < deadlineAt) {
        const people = await rooms.listParticipants(roomId);
        ready =
          people.length === 1 &&
          people[0].identity === "shared-agent" &&
          people[0].tracks.filter((t) => t.type === 0 && !t.muted).length ===
            1 &&
          (!video || people[0].tracks.some((t) => t.type === 1 && !t.muted));
        if (ready) break;
        await sleep(100);
      }
      if (!ready || signal?.aborted || now() >= deadlineAt)
        throw Error("shared_media_not_ready");
      const token = new AccessToken(config.key, config.secret, {
        identity: "shared-bridge",
        ttl: Math.floor((expiresAt - now()) / 1000),
      });
      token.addGrant({
        roomJoin: true,
        room: roomId,
        canPublish: true,
        canSubscribe: true,
      });
      return {
        livekit_url: config.url,
        participant_token: await token.toJwt(),
        remote_participant_identity: "shared-agent",
      };
    },
    async cleanup(roomId) {
      if ((await rooms.listRooms([roomId])).length)
        await rooms.deleteRoom(roomId);
      return (await rooms.listRooms([roomId])).length === 0;
    },
    async activate(roomId) {
      // Existing voice startup reads this mark; it never greets on room join.
      const room = (await rooms.listRooms([roomId]))[0];
      if (!room) throw Error("shared_room_missing");
      let metadata = {};
      try {
        metadata = JSON.parse(room.metadata || "{}");
      } catch {}
      if (metadata.chert_bridge_ready !== true)
        await rooms.updateRoomMetadata(
          roomId,
          JSON.stringify({ ...metadata, chert_bridge_ready: true }),
        );
    },
  };
}
