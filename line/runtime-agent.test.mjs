// node --test runtime-agent.test.mjs
// The call entry of a line with the background computer runtime. It needs the voice library of the line.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { initializeLogger } from "@livekit/agents";
import { dispose } from "@livekit/rtc-node";
import { runtimeEntry } from "./runtime-agent.mjs";

const runner = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const { test } = runner;
const afterAll = runner.afterAll ?? runner.after;
afterAll(() => dispose());

initializeLogger({ pretty: false, level: "silent" });

/** A call's context with a room that has no caller. It writes down what the entry does with it. */
function waitingRoom(wait) {
  const room = new EventEmitter();
  room.metadata = "";
  room.remoteParticipants = new Map();
  const published = [];
  room.localParticipant = {
    publishTrack: async (track) => {
      published.push(track);
    },
  };
  const shutdown = [];
  return {
    published,
    shutdown,
    ctx: {
      room,
      connect: async () => {},
      waitForParticipant: wait,
      addShutdownCallback: (step) => shutdown.push(step),
    },
  };
}

test("a waiting room that closes before a caller came ends the runtime entry quietly, with nothing sent", async () => {
  const quiet = waitingRoom(async () => {
    throw new Error("Room disconnected while waiting for participant");
  });
  const lines = [];
  const write = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await runtimeEntry(quiet.ctx);
  } finally {
    console.log = write;
  }
  // No picture went out, no listener stays on the room, and the log has no call.
  assert.deepEqual(quiet.published, []);
  assert.deepEqual(quiet.shutdown, []);
  assert.equal(quiet.ctx.room.eventNames().length, 0);
  assert.equal(
    lines.some((line) => line.includes("call_started")),
    false,
  );
});

test("the runtime entry is taken only for a line that names the runtime's configuration", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
  // The usual agent loads the runtime entry by a dynamic import behind the setting, and nowhere else.
  assert.equal(source.match(/runtime-agent\.mjs/g).length, 2);
  assert.match(
    source,
    /process\.env\.CLAWDTIME_LINE_RUNTIME_CONFIG\s*\?\s*\(await import\("\.\/runtime-agent\.mjs"\)\)\.runtimeEntry\s*:\s*callEntry/,
  );
  assert.equal(/^import .*runtime-agent/m.test(source), false);
});
