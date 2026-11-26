import assert from "node:assert/strict";
import { sharedMedia } from "./shared-media.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
function fixture() {
  let time = Date.now(),
    created = 0,
    dispatched = 0,
    deleted = 0,
    metadata = "{}";
  let people = [
    {
      identity: "shared-agent",
      tracks: [
        { type: 0, muted: false },
        { type: 1, muted: false },
      ],
    },
  ];
  const rooms = {
    createRoom: async (input) => {
      assert.equal(input.maxParticipants, 2);
      created++;
    },
    listParticipants: async () => people,
    listRooms: async (names) => {
      assert.deepEqual(names, ["room"]);
      return deleted ? [] : [{ metadata }];
    },
    deleteRoom: async () => {
      deleted++;
    },
    updateRoomMetadata: async (_room, value) => {
      metadata = value;
    },
  };
  const media = sharedMedia(
    {
      url: "wss://media.example",
      key: "key",
      secret: "s".repeat(32),
      agentName: "shared-worker",
    },
    {
      rooms,
      dispatch: {
        createDispatch: async (room, name) => {
          assert.equal(room, "room");
          assert.equal(name, "shared-worker");
          dispatched++;
        },
      },
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  );
  return {
    media,
    input: {
      roomId: "room",
      expiresAt: time + 3600000,
      deadlineAt: time + 500,
      video: true,
    },
    counts: () => ({ created, dispatched, deleted }),
    setPeople: (p) => {
      people = p;
    },
    metadata: () => JSON.parse(metadata),
  };
}
test("warms only the pinned agent and emits a room-scoped bridge token before answer-gated activation", async () => {
  const f = fixture();
  const credentials = await f.media.prepare(f.input);
  const payload = JSON.parse(
    Buffer.from(
      credentials.participant_token.split(".")[1],
      "base64url",
    ).toString(),
  );
  assert.equal(payload.sub, "shared-bridge");
  assert.equal(payload.video.room, "room");
  assert.equal(payload.video.roomJoin, true);
  assert(payload.exp - payload.nbf <= 3600);
  assert.equal(credentials.remote_participant_identity, "shared-agent");
  assert.equal(f.metadata().chert_bridge_ready, undefined);
  await f.media.activate("room");
  assert.equal(f.metadata().chert_bridge_ready, true);
  assert.equal(await f.media.cleanup("room"), true);
  assert.equal(f.counts().deleted, 1);
});
test("refuses expired preparation before any allocation, and never accepts a missing video or extra publisher", async () => {
  const stale = fixture();
  await assert.rejects(() =>
    stale.media.prepare({ ...stale.input, deadlineAt: 0 }),
  );
  assert.equal(stale.counts().created, 0);
  for (const people of [
    [{ identity: "shared-agent", tracks: [{ type: 0, muted: false }] }],
    [
      {
        identity: "other",
        tracks: [
          { type: 0, muted: false },
          { type: 1, muted: false },
        ],
      },
    ],
    [
      {
        identity: "shared-agent",
        tracks: [
          { type: 0, muted: false },
          { type: 0, muted: false },
          { type: 1, muted: false },
        ],
      },
    ],
  ]) {
    const f = fixture();
    f.setPeople(people);
    await assert.rejects(() => f.media.prepare(f.input), /not_ready/);
    assert.equal(f.counts().dispatched, 1);
  }
});
