import assert from "node:assert/strict";
import { endSharedRoom, sharedRooms } from "./shared-rooms.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");

const names = (count, prefix = "shared_old") =>
  Array.from({ length: count }, (_, i) => `${prefix}_${i}`);

test("admits new rooms after 10,000 earlier rooms ended", async () => {
  const lookups = [];
  const rooms = sharedRooms({
    live: async (batch) => {
      lookups.push(batch.length);
      return [];
    },
  });
  for (const room of names(10000)) assert.equal(await rooms.claim(room), true);
  assert.equal(await rooms.claim("shared_new"), true);
  assert.deepEqual(lookups, [100]); // one bounded lookup, oldest rooms first
  assert.ok(rooms.size < 10000);
  assert.equal(await rooms.claim("shared_new"), false); // still live here
});

test("reads past live rooms until it finds an ended one", async () => {
  const live = new Set(names(150));
  const rooms = sharedRooms({
    limit: 200,
    live: async (batch) => batch.filter((room) => live.has(room)),
  });
  for (const room of names(200)) assert.equal(await rooms.claim(room), true);
  assert.equal(await rooms.claim("shared_new"), true);
  assert.equal(rooms.size, 151);
});

test("keeps live rooms and refuses a duplicate or a room past the cap", async () => {
  const live = new Set(names(3));
  const rooms = sharedRooms({
    limit: 3,
    live: async (batch) => batch.filter((room) => live.has(room)),
  });
  for (const room of names(3)) assert.equal(await rooms.claim(room), true);
  assert.equal(await rooms.claim("shared_old_1"), false);
  assert.equal(await rooms.claim("shared_new"), false);
  live.delete("shared_old_1");
  assert.equal(await rooms.claim("shared_new"), true);
  assert.equal(await rooms.claim("shared_old_0"), false);
  assert.equal(await rooms.claim(undefined), false);
});

test("fails closed while the room lookup fails", async () => {
  let reachable = false;
  const rooms = sharedRooms({
    limit: 2,
    live: async () => {
      if (!reachable) throw Error("media server unavailable");
      return [];
    },
  });
  for (const room of names(2)) assert.equal(await rooms.claim(room), true);
  assert.equal(await rooms.claim("shared_new"), false);
  assert.equal(rooms.size, 2);
  reachable = true;
  assert.equal(await rooms.claim("shared_new"), true);
});

test("claims one room once when two requests race a prune", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let lookups = 0;
  const rooms = sharedRooms({
    limit: 1,
    live: async () => {
      lookups++;
      await gate;
      return [];
    },
  });
  assert.equal(await rooms.claim("shared_old"), true);
  const first = rooms.claim("shared_new");
  const second = rooms.claim("shared_new");
  release();
  assert.deepEqual((await Promise.all([first, second])).sort(), [false, true]);
  assert.equal(lookups, 1);
});
test("ending a shared call removes exactly its room, then stops the job", async () => {
  const steps = [];
  await endSharedRoom({
    roomId: "room-a",
    rooms: { deleteRoom: async (room) => steps.push(`delete ${room}`) },
    shutdown: () => steps.push("shutdown"),
  });
  assert.deepEqual(steps, ["delete room-a", "shutdown"]);
  // A failed removal still stops the job; the coordinator removes the room too.
  const stopped = [];
  await endSharedRoom({
    roomId: "room-b",
    rooms: {
      deleteRoom: async () => {
        throw Error("media unavailable");
      },
    },
    shutdown: () => stopped.push("shutdown"),
  });
  assert.deepEqual(stopped, ["shutdown"]);
});
