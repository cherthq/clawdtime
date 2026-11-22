import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobContext, initializeLogger } from "@livekit/agents";
import {
  LocalVideoTrack,
  ParticipantKind,
  RoomEvent,
  TrackSource,
  dispose,
} from "@livekit/rtc-node";
import agent from "./agent.mjs";
import { startupError } from "./startup-diagnostics.mjs";

const runner = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const { test } = runner;
const afterAll = runner.afterAll ?? runner.after;
afterAll(() => dispose());

initializeLogger({ pretty: false, level: "silent" });

test("startup diagnostics retain only bounded error names and allowlisted source locations", () => {
  assert.deepEqual(
    startupError({
      name: "TypeError",
      message: "private transcript and credential",
      stack:
        "TypeError: private transcript and credential\n" +
        "    at handler (/private/account/customer/agent.mjs:123:45)",
      code: "private-account-id",
    }),
    { error_name: "TypeError", source: "agent.mjs:123" },
  );
  assert.deepEqual(
    startupError({
      name: "private-custom-error-name",
      stack:
        "private message\n" +
        "    at handler (/private/account/customer/private-file.mjs:10:20)",
    }),
    { error_name: "UnknownError" },
  );
  assert.deepEqual(
    startupError({
      name: "Error",
      stack:
        "Error: confidential\n" +
        "    at handler (/private/account/agent.mjs:12345678:1)\n" +
        "    at handler (/private/account/room.js:12:34) arbitrary payload",
    }),
    { error_name: "Error" },
  );
  assert.deepEqual(startupError(null), { error_name: "UnknownError" });
});

// Exercise the production entrypoint and installed SDK participant waiter. Only
// the room/network boundary is synthetic: avatar pixels, RTC source/track,
// caller lifecycle, and preference isolation use the real implementation.
// Every case stops before model creation, desktop lookup, or screen capture.
async function fixture(run, { configHome } = {}) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-startup-"));
  const priorHome = process.env.CLAWDTIME_CONFIG_HOME;
  const priorLog = console.log;
  const events = [];
  process.env.CLAWDTIME_CONFIG_HOME = configHome ?? home;
  console.log = (line) => {
    try {
      const event = JSON.parse(line);
      if (event.clawdtime_line) events.push(event);
    } catch {
      // No arbitrary SDK payload is retained by this fixture.
    }
  };
  const room = new EventEmitter();
  room.isConnected = false;
  room.remoteParticipants = new Map();
  room.metadata = JSON.stringify({ chert_warm: true });
  room.name = "synthetic-startup-room";
  room.connect = async () => {
    room.isConnected = true;
  };
  const publishFailure = new Error(
    "synthetic publication failure: private-data",
  );
  let publications = 0;
  let publish = async () => {
    throw publishFailure;
  };
  room.localParticipant = {
    publishTrack: async (track, options) => {
      publications++;
      assert.ok(track instanceof LocalVideoTrack);
      assert.equal(options.source, TrackSource.SOURCE_CAMERA);
      return publish();
    },
  };
  const ctx = new JobContext(
    {},
    {
      job: {
        id: "synthetic-startup-job",
        room: { name: room.name },
        metadata: JSON.stringify({ chert_warm: true }),
      },
      url: "wss://fixture.invalid",
      token: "synthetic-unused-token",
    },
    room,
    () => {},
    () => {},
    {},
  );
  let task;
  const diagnostics = () =>
    events
      .filter((event) => event.clawdtime_line === "startup")
      .map((e) => e.code);
  const disconnect = () => {
    room.isConnected = false;
    room.emit(RoomEvent.Disconnected);
  };
  const participant = (
    identity = "chert-bridge-synthetic-caller",
    kind = ParticipantKind.STANDARD,
  ) => ({ identity, info: { kind }, trackPublications: new Map() });
  const add = (value) => {
    room.remoteParticipants.set(value.identity, value);
    room.emit(RoomEvent.ParticipantConnected, value);
  };
  try {
    await run({
      room,
      ctx,
      events,
      diagnostics,
      participant,
      add,
      disconnect,
      publications: () => publications,
      setPublish: (value) => {
        publish = value;
      },
      start: () => {
        assert.equal(task, undefined);
        // Observe rejection immediately, even while a test waits for a stage.
        task = agent.entry(ctx).then(
          () => ({ error: null }),
          (error) => ({ error }),
        );
        return task;
      },
      result: () => task,
      publishFailure,
      flush: () => new Promise((resolve) => setImmediate(resolve)),
    });
  } finally {
    disconnect();
    for (const cleanup of ctx.shutdownCallbacks) await cleanup();
    if (task) await task;
    console.log = priorLog;
    if (priorHome === undefined) delete process.env.CLAWDTIME_CONFIG_HOME;
    else process.env.CLAWDTIME_CONFIG_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function endedOnce(f) {
  assert.equal(
    f.events.filter((event) => event.clawdtime_line === "call_ended").length,
    1,
  );
  assert.equal(f.diagnostics().includes("session_starting"), false);
}

test("an empty warm room waits without publishing and closes without a caller", async () => {
  await fixture(async (f) => {
    f.start();
    await f.flush();
    assert.ok(f.diagnostics().includes("caller_waiting"));
    assert.equal(f.publications(), 0);
    assert.equal(f.diagnostics().includes("caller_resolved"), false);
    f.disconnect();
    assert.equal((await f.result()).error, null);
    assert.ok(
      f.events.some((event) => event.clawdtime_line === "caller_wait_ended"),
    );
    endedOnce(f);
  });
});

for (const alreadyPresent of [false, true]) {
  test(`actual SDK caller ${alreadyPresent ? "inventory" : "join event"} reaches avatar publication`, async () => {
    await fixture(async (f) => {
      const caller = f.participant();
      if (alreadyPresent)
        f.room.remoteParticipants.set(caller.identity, caller);
      f.start();
      if (!alreadyPresent) {
        await f.flush();
        assert.equal(f.publications(), 0);
        f.add(caller);
      }
      assert.match(
        (await f.result()).error?.message,
        /^Call startup failed at /,
      );
      assert.equal(f.publications(), 1);
      const stages = f.diagnostics();
      for (const stage of [
        "room_connected",
        "video_prepared",
        "caller_waiting",
        "caller_resolved",
        "call_bound",
        "video_created",
        "first_frame",
      ])
        assert.ok(stages.includes(stage), stage);
      assert.ok(
        stages.indexOf("first_frame") > stages.indexOf("caller_resolved"),
      );
      assert.equal(stages.includes("camera_published"), false);
      const failure = f.events.find(
        (event) => event.clawdtime_line === "startup_failed",
      );
      assert.equal(failure?.code, "first_frame");
      assert.equal(failure?.error_name, "Error");
      assert.equal(JSON.stringify(f.events).includes("private-data"), false);
      f.room.emit(RoomEvent.ParticipantDisconnected, caller);
      f.disconnect();
      for (const cleanup of f.ctx.shutdownCallbacks) await cleanup();
      endedOnce(f);
    });
  });
}

test("a relative CLAWDTIME_CONFIG_HOME does not stop the call: the zoom preferences live in memory", async () => {
  const relative = `clawdtime-startup-relative-${process.pid}`;
  for (const configHome of [relative, undefined]) {
    await fixture(
      async (f) => {
        f.start();
        await f.flush();
        f.add(f.participant());
        // The call gets as far as every other call of this fixture: the camera publication, which is
        // synthetic here and fails.
        assert.match(
          (await f.result()).error?.message,
          /^Call startup failed at /,
        );
        assert.equal(f.publications(), 1);
        assert.equal(
          f.events.find((event) => event.clawdtime_line === "startup_failed")
            ?.code,
          "first_frame",
        );
        // One line says that nothing is kept for later calls. A usual folder gives no such line.
        assert.deepEqual(
          f.events
            .filter((event) => event.clawdtime_line === "zoom_settings")
            .map((event) => event.code),
          configHome ? ["memory_only"] : [],
        );
        endedOnce(f);
      },
      { configHome },
    );
  }
  assert.equal(existsSync(resolve(relative)), false);
});

test("another agent joining cannot start a call", async () => {
  await fixture(async (f) => {
    f.start();
    await f.flush();
    f.add(f.participant("synthetic-other-agent", ParticipantKind.AGENT));
    await f.flush();
    assert.equal(f.publications(), 0);
    assert.equal(f.diagnostics().includes("caller_resolved"), false);
    f.add(f.participant());
    assert.match((await f.result()).error?.message, /^Call startup failed at /);
    assert.equal(f.publications(), 1);
    endedOnce(f);
  });
});

test("a caller departing before the waiter resumes cannot publish or start voice", async () => {
  await fixture(async (f) => {
    f.start();
    await f.flush();
    const caller = f.participant();
    f.add(caller);
    f.room.remoteParticipants.delete(caller.identity);
    f.room.emit(RoomEvent.ParticipantDisconnected, caller);
    assert.equal((await f.result()).error, null);
    assert.equal(f.publications(), 0);
    assert.ok(
      f.events.some(
        (event) =>
          event.code === "caller_departed_before_start" ||
          event.clawdtime_line === "caller_departed_before_start",
      ),
    );
    endedOnce(f);
  });
});

for (const departure of ["caller", "room"]) {
  test(`${departure} departure during camera publication retires startup once`, async () => {
    await fixture(async (f) => {
      let finishPublish;
      f.setPublish(
        () =>
          new Promise((resolve) => {
            finishPublish = resolve;
            // Also settle during fixture cleanup if an assertion fails.
            f.room.once(RoomEvent.Disconnected, () => resolve({}));
          }),
      );
      const caller = f.participant();
      f.start();
      await f.flush();
      f.add(caller);
      await f.flush();
      assert.equal(f.publications(), 1);
      assert.equal(typeof finishPublish, "function");
      f.room.emit(RoomEvent.ParticipantDisconnected, {
        identity: "synthetic-unrelated-participant",
      });
      assert.equal(
        f.events.some((event) => event.clawdtime_line === "call_ended"),
        false,
      );
      if (departure === "caller") {
        f.room.remoteParticipants.delete(caller.identity);
        f.room.emit(RoomEvent.ParticipantDisconnected, caller);
      } else f.disconnect();
      // A late successful publish may settle, but must never start voice/tools.
      finishPublish({});
      assert.equal((await f.result()).error, null);
      f.disconnect();
      for (const cleanup of f.ctx.shutdownCallbacks) await cleanup();
      endedOnce(f);
      assert.equal(f.publications(), 1);
    });
  });
}
