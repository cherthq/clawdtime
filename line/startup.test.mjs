import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobContext, initializeLogger } from "@livekit/agents";
import {
  LocalVideoTrack,
  LocalAudioTrack,
  TrackKind,
  ParticipantKind,
  RoomEvent,
  TrackSource,
  VideoSource,
  dispose,
} from "@livekit/rtc-node";
import agent from "./agent.mjs";
import { settings } from "./desk.mjs";
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

// Real entrypoint/SDK output and native synthetic tracks; only the room boundary
// is fake. A local recall barrier stops caller cases before any model can start.
async function fixture(run, { configHome } = {}) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-startup-"));
  const prior = {
    home: process.env.CLAWDTIME_CONFIG_HOME,
    key: process.env.OPENAI_API_KEY,
    desktop: process.env.CLAWDTIME_DESKTOP_STATE,
    log: console.log,
    command: settings.clawdtime,
  };
  const command = join(home, "recall-wait.sh");
  writeFileSync(
    command,
    '#!/bin/sh\ntouch "$0.started"\nwhile [ ! -e "$0.go" ]; do sleep 0.02; done\n',
    { mode: 0o700 },
  );
  settings.clawdtime = command;
  process.env.CLAWDTIME_CONFIG_HOME = configHome ?? home;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CLAWDTIME_DESKTOP_STATE;
  const events = [];
  console.log = (line) => {
    try {
      const value = JSON.parse(line);
      if (value.clawdtime_line) events.push(value);
    } catch {}
  };
  const room = new EventEmitter();
  room.isConnected = false;
  room.remoteParticipants = new Map();
  room.metadata = JSON.stringify({ chert_warm: true });
  room.name = "synthetic-startup-room";
  room.connect = async () => {
    room.isConnected = true;
  };
  const calls = [],
    policies = new Map(),
    subscribed = Promise.withResolvers();
  room.localParticipant = {
    trackPublications: new Map(),
    publishTrack: async (track, options) => {
      const kind = track instanceof LocalAudioTrack ? "audio" : "camera";
      assert.ok(
        track instanceof LocalAudioTrack || track instanceof LocalVideoTrack,
      );
      assert.equal(
        options.source,
        kind === "audio"
          ? TrackSource.SOURCE_MICROPHONE
          : TrackSource.SOURCE_CAMERA,
      );
      calls.push(kind);
      await policies.get(kind)?.();
      const publication = {
        sid: kind,
        name: kind === "audio" ? "roomio_audio" : "agent-video",
        kind: kind === "audio" ? TrackKind.KIND_AUDIO : TrackKind.KIND_VIDEO,
        source: options.source,
        muted: false,
        track,
        waitForSubscription: () => subscribed.promise,
      };
      room.localParticipant.trackPublications.set(kind, publication);
      room.emit(
        RoomEvent.LocalTrackPublished,
        publication,
        room.localParticipant,
      );
      return publication;
    },
    unpublishTrack: async (sid) => {
      room.localParticipant.trackPublications.delete(sid);
      room.emit(RoomEvent.LocalTrackUnpublished);
    },
  };
  const ctx = new JobContext(
    {},
    {
      job: {
        id: "synthetic-startup-job",
        room: { name: room.name },
        metadata: room.metadata,
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
      .map((event) => event.code);
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
  const depart = (value) => {
    room.remoteParticipants.delete(value.identity);
    room.emit(RoomEvent.ParticipantDisconnected, value);
  };
  const until = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), "startup stage reached");
  };
  try {
    await run({
      room,
      ctx,
      events,
      diagnostics,
      participant,
      add,
      depart,
      disconnect,
      calls,
      until,
      setPublish: (kind, fn) => policies.set(kind, fn),
      start: () => {
        assert.equal(task, undefined);
        task = agent.entry(ctx).then(
          () => ({ error: null }),
          (error) => ({ error }),
        );
        return task;
      },
      result: () => task,
      release: () => writeFileSync(`${command}.go`, ""),
      recalled: () => existsSync(`${command}.started`),
      flush: () => new Promise((resolve) => setImmediate(resolve)),
    });
  } finally {
    disconnect();
    subscribed.resolve();
    writeFileSync(`${command}.go`, "");
    for (const cleanup of ctx.shutdownCallbacks) await cleanup();
    if (task) await task;
    console.log = prior.log;
    settings.clawdtime = prior.command;
    for (const [key, value] of [
      ["CLAWDTIME_CONFIG_HOME", prior.home],
      ["OPENAI_API_KEY", prior.key],
      ["CLAWDTIME_DESKTOP_STATE", prior.desktop],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test("warm room publishes static synthetic audio/video before waiting, without model or caller authority", async () => {
  await fixture(async (f) => {
    f.start();
    await f.until(() => f.diagnostics().includes("caller_waiting"));
    assert.deepEqual(f.calls, ["audio", "camera"]);
    assert.equal(f.room.localParticipant.trackPublications.size, 2);
    assert.ok(
      f.diagnostics().indexOf("media_ready") <
        f.diagnostics().indexOf("caller_waiting"),
    );
    for (const forbidden of [
      "caller_resolved",
      "call_bound",
      "video_created",
      "session_starting",
    ])
      assert.equal(f.diagnostics().includes(forbidden), false);
    assert.equal(f.recalled(), false);
    assert.equal(f.room.metadata, JSON.stringify({ chert_warm: true }));
    f.disconnect();
    assert.equal((await f.result()).error, null);
    endedOnce(f);
  });
});

for (const alreadyPresent of [false, true])
  test(`caller ${alreadyPresent ? "already present" : "joining warmed room"} reuses publications and starts authority only after readiness`, async () => {
    await fixture(async (f) => {
      const caller = f.participant();
      if (alreadyPresent)
        f.room.remoteParticipants.set(caller.identity, caller);
      f.start();
      if (!alreadyPresent) {
        await f.until(() => f.diagnostics().includes("caller_waiting"));
        f.add(caller);
      }
      await f.until(f.recalled);
      assert.deepEqual(f.calls, ["audio", "camera"]);
      assert.ok(
        f.diagnostics().indexOf("call_bound") >
          f.diagnostics().indexOf("media_ready"),
      );
      assert.equal(f.diagnostics().includes("session_starting"), false);
      f.depart(caller);
      f.release();
      assert.equal((await f.result()).error, null);
      endedOnce(f);
    });
  });

for (const kind of ["audio", "camera"])
  test(`${kind} publication failure never creates caller authority or model`, async () => {
    await fixture(async (f) => {
      f.setPublish(kind, async () => {
        throw Error("private-data");
      });
      assert.match(
        (await f.start()).error?.message,
        /^Call startup failed at /,
      );
      assert.deepEqual(
        f.calls,
        kind === "audio" ? ["audio"] : ["audio", "camera"],
      );
      assert.equal(f.diagnostics().includes("media_ready"), false);
      assert.equal(f.diagnostics().includes("call_bound"), false);
      assert.equal(JSON.stringify(f.events).includes("private-data"), false);
      endedOnce(f);
    });
  });

test("another agent does not activate warm media's caller-only services", async () => {
  await fixture(async (f) => {
    f.start();
    await f.until(() => f.diagnostics().includes("caller_waiting"));
    f.add(f.participant("other-agent", ParticipantKind.AGENT));
    await f.flush();
    assert.equal(f.diagnostics().includes("caller_resolved"), false);
    assert.equal(f.recalled(), false);
    f.disconnect();
    assert.equal((await f.result()).error, null);
    endedOnce(f);
  });
});

test("caller leaving before the waiter resumes starts no caller services", async () => {
  await fixture(async (f) => {
    f.start();
    await f.until(() => f.diagnostics().includes("caller_waiting"));
    const caller = f.participant();
    f.add(caller);
    f.depart(caller);
    assert.equal((await f.result()).error, null);
    assert.equal(f.diagnostics().includes("call_bound"), false);
    assert.equal(f.recalled(), false);
    endedOnce(f);
  });
});

test("warm publication loss ends startup without waiting for a caller", async () => {
  await fixture(async (f) => {
    f.start();
    await f.until(() => f.diagnostics().includes("caller_waiting"));
    await f.room.localParticipant.unpublishTrack("audio");
    assert.equal((await f.result()).error, null);
    assert.equal(f.diagnostics().includes("media_lost"), true);
    assert.equal(f.diagnostics().includes("call_bound"), false);
    assert.equal(f.recalled(), false);
    endedOnce(f);
  });
});

for (const kind of ["audio", "camera"])
  for (const departure of ["caller", "room"])
    test(`${departure} departure during warm ${kind} publication fences late completion`, async () => {
      await fixture(async (f) => {
        const finish = Promise.withResolvers();
        f.setPublish(kind, () => finish.promise);
        f.start();
        await f.until(() => f.calls.includes(kind));
        const caller = f.participant();
        f.add(caller);
        await f.flush();
        if (departure === "caller") f.depart(caller);
        else f.disconnect();
        finish.resolve();
        assert.equal((await f.result()).error, null);
        await f.flush();
        assert.equal(f.diagnostics().includes("media_ready"), false);
        assert.equal(f.diagnostics().includes("call_bound"), false);
        assert.equal(f.recalled(), false);
        endedOnce(f);
      });
    });

test("relative preferences stay in memory and do not affect media warming", async () => {
  const relative = `clawdtime-startup-relative-${process.pid}`;
  await fixture(
    async (f) => {
      f.start();
      await f.until(() => f.diagnostics().includes("caller_waiting"));
      const caller = f.participant();
      f.add(caller);
      await f.until(f.recalled);
      assert.deepEqual(
        f.events
          .filter((event) => event.clawdtime_line === "zoom_settings")
          .map((event) => event.code),
        ["memory_only"],
      );
      f.depart(caller);
      f.release();
      await f.result();
      endedOnce(f);
    },
    { configHome: relative },
  );
  assert.equal(existsSync(resolve(relative)), false);
});

for (const failing of ["first", "every"])
  test(`${failing} avatar frame failure observes the bounded warm camera requirement`, async () => {
    const capture = VideoSource.prototype.captureFrame;
    let frames = 0;
    VideoSource.prototype.captureFrame = function (...args) {
      frames++;
      if (failing === "every" || frames === 1) throw Error("private-data");
      return capture.apply(this, args);
    };
    try {
      await fixture(async (f) => {
        f.start();
        if (failing === "every") {
          assert.ok((await f.result()).error);
          assert.equal(frames, 9);
          assert.equal(f.diagnostics().includes("media_ready"), false);
          assert.equal(f.diagnostics().includes("warm_frame_failed"), true);
          assert.equal(f.diagnostics().includes("call_bound"), false);
          assert.equal(f.recalled(), false);
          endedOnce(f);
          return;
        }
        await f.until(() => f.diagnostics().includes("caller_waiting"));
        assert.equal(frames, 9);
        assert.equal(
          f
            .diagnostics()
            .includes(failing === "every" ? "warm_frame_failed" : "warm_frame"),
          true,
        );
        const caller = f.participant();
        f.add(caller);
        await f.until(() => frames >= 10);
        assert.deepEqual(f.calls, ["audio", "camera"]);
        assert.equal(
          f.diagnostics().filter((code) => code === "first_frame_failed")
            .length,
          1,
        );
        assert.equal(
          f.events.filter((event) => event.clawdtime_line === "frame_failed")
            .length,
          failing === "every" ? 1 : 0,
        );
        assert.equal(JSON.stringify(f.events).includes("private-data"), false);
        f.depart(caller);
        f.release();
        await f.result();
        endedOnce(f);
      });
    } finally {
      VideoSource.prototype.captureFrame = capture;
    }
  });
