import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { voice, initializeLogger } from "@livekit/agents";
import { RoomEvent, TrackKind, TrackSource } from "@livekit/rtc-node";
import { makeWarmMedia } from "./warm-media.mjs";
const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
initializeLogger({ pretty: false, level: "silent" });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture({
  audioPending = false,
  cameraPending = false,
  timeoutMs = 1000,
  audioFailure = false,
  settlePending = false,
  frameResults,
} = {}) {
  const room = new EventEmitter();
  room.isConnected = true;
  room.remoteParticipants = new Map();
  const camera = {},
    codes = [],
    unpublished = [],
    captures = [],
    delays = [];
  const audioAck = Promise.withResolvers(),
    cameraAck = Promise.withResolvers(),
    subscribed = Promise.withResolvers(),
    delayAck = Promise.withResolvers();
  let starts = 0,
    closes = 0,
    failures = 0,
    signal;
  const put = (publication) => {
    room.localParticipant.trackPublications.set(publication.sid, publication);
    room.emit(
      RoomEvent.LocalTrackPublished,
      publication,
      room.localParticipant,
    );
    return publication;
  };
  const audioPublication = {
    sid: "audio",
    name: "roomio_audio",
    kind: TrackKind.KIND_AUDIO,
    source: TrackSource.SOURCE_MICROPHONE,
    muted: false,
    track: {},
  };
  const videoPublication = {
    sid: "video",
    name: "agent-video",
    kind: TrackKind.KIND_VIDEO,
    source: TrackSource.SOURCE_CAMERA,
    muted: false,
    track: camera,
  };
  room.localParticipant = {
    trackPublications: new Map(),
    publishTrack: async (track, options) => {
      assert.equal(track, camera);
      assert.equal(options.source, TrackSource.SOURCE_CAMERA);
      if (cameraPending) await cameraAck.promise;
      return put(videoPublication);
    },
    unpublishTrack: async (sid) => {
      unpublished.push(sid);
      room.localParticipant.trackPublications.delete(sid);
    },
  };
  const output = {
    start: async (value) => {
      starts++;
      signal = value;
      if (audioFailure) throw Error("private failure");
      if (audioPending) await audioAck.promise;
      put(audioPublication);
      if (!signal.aborted) await subscribed.promise;
    },
    close: async () => {
      closes++;
    },
  };
  const media = makeWarmMedia({
    room,
    camera,
    firstFrame: () => {
      captures.push(
        room.localParticipant.trackPublications.has("video")
          ? "published_avatar"
          : "avatar",
      );
      return frameResults?.[captures.length - 1] ?? true;
    },
    createOutput: () => output,
    diagnostic: (code) => codes.push(code),
    onFailure: () => {
      failures++;
    },
    timeoutMs,
    delay: async (ms) => {
      delays.push(ms);
      if (settlePending) await delayAck.promise;
    },
  });
  return {
    room,
    media,
    output,
    codes,
    captures,
    delays,
    delayAck,
    unpublished,
    audioAck,
    cameraAck,
    subscribed,
    audioPublication,
    videoPublication,
    starts: () => starts,
    closes: () => closes,
    failures: () => failures,
    signal: () => signal,
    put,
  };
}

test("warm preparation publishes once without waiting for a subscriber, then reuses output", async () => {
  const f = fixture();
  const one = f.media.prepare(),
    two = f.media.prepare();
  assert.equal(one, two);
  assert.equal(await one, f.output);
  assert.equal(f.starts(), 1);
  assert.deepEqual(f.captures, [
    "avatar",
    ...Array(8).fill("published_avatar"),
  ]);
  assert.deepEqual(f.delays, Array(8).fill(250));
  assert.equal(f.media.isReady(), true);
  assert.deepEqual(f.codes, [
    "audio_publishing",
    "audio_published",
    "first_frame",
    "camera_publishing",
    "camera_published",
    "warm_frame",
    "media_ready",
  ]);
  assert.equal(f.room.localParticipant.trackPublications.size, 2);
  // The SDK-owned source has not produced speech and no caller/session was made.
  await f.media.close();
  await f.media.close();
  assert.equal(f.closes(), 1);
  assert.equal(f.signal().aborted, true);
  assert.deepEqual(f.unpublished.sort(), ["audio", "video"]);
  assert.equal(f.media.isReady(), false);
  f.subscribed.resolve();
  await flush();
  assert.equal(f.codes.filter((code) => code === "media_ready").length, 1);
});

test("SDK RoomIO preserves supplied output and does not publish/start/close a second output", async () => {
  const f = fixture();
  await f.media.prepare();
  const session = new EventEmitter();
  session.input = { audio: null };
  session.output = { audio: f.output, transcription: null };
  const io = new voice.RoomIO({
    agentSession: session,
    room: f.room,
    inputOptions: { audioEnabled: false, textEnabled: false },
    outputOptions: { audioEnabled: false, transcriptionEnabled: false },
  });
  io.start();
  await flush();
  assert.equal(session.output.audio, f.output);
  assert.equal(io.audioOutput, f.output);
  assert.equal(f.starts(), 1);
  assert.equal(f.room.localParticipant.trackPublications.size, 2);
  await io.close();
  assert.equal(f.closes(), 0);
  await f.media.close();
});

test("warm readiness waits for both publication acknowledgements", async () => {
  const f = fixture({ cameraPending: true });
  const prepared = f.media.prepare();
  await flush();
  assert.equal(f.media.isReady(), false);
  assert.equal(f.codes.includes("media_ready"), false);
  assert.deepEqual(f.captures, ["avatar"]);
  f.cameraAck.resolve();
  await prepared;
  assert.deepEqual(f.captures, [
    "avatar",
    ...Array(8).fill("published_avatar"),
  ]);
  assert.ok(
    f.codes.indexOf("camera_published") < f.codes.indexOf("warm_frame"),
  );
  assert.ok(f.codes.indexOf("warm_frame") < f.codes.indexOf("media_ready"));
  assert.equal(f.media.isReady(), true);
  await f.media.close();
});

test("closing during transport settling cancels the burst before readiness or further frames", async () => {
  const f = fixture({ settlePending: true });
  const preparing = f.media.prepare();
  const rejected = assert.rejects(preparing, /retired/);
  await flush();
  assert.equal(f.codes.includes("camera_published"), true);
  assert.equal(f.media.isReady(), false);
  assert.deepEqual(f.captures, ["avatar"]);
  assert.equal(f.codes.includes("media_ready"), false);
  await f.media.close();
  await rejected;
  f.delayAck.resolve();
  await flush();
  assert.deepEqual(f.captures, ["avatar"]);
  assert.equal(f.codes.includes("media_ready"), false);
  assert.deepEqual(f.unpublished.sort(), ["audio", "video"]);
});

test("warm readiness requires at least one successful delayed frame, tolerating partial misses", async () => {
  const missing = fixture({ frameResults: [true, ...Array(8).fill(false)] });
  await assert.rejects(missing.media.prepare(), /frames unavailable/);
  assert.equal(missing.media.isReady(), false);
  assert.equal(missing.codes.includes("media_ready"), false);
  await missing.media.close();
  const partial = fixture({
    frameResults: [true, false, false, true, ...Array(5).fill(false)],
  });
  assert.equal(await partial.media.prepare(), partial.output);
  assert.equal(partial.media.isReady(), true);
  assert.equal(partial.captures.length, 9);
  await partial.media.close();
});

for (const pending of ["audio", "camera"])
  test(`closing during ${pending} publication fences and retires late acknowledgement`, async () => {
    const f = fixture({
      audioPending: pending === "audio",
      cameraPending: pending === "camera",
    });
    const prepared = f.media.prepare();
    const refused = assert.rejects(prepared, /retired/);
    await flush();
    await f.media.close();
    await refused;
    f.audioAck.resolve();
    f.cameraAck.resolve();
    await flush();
    await flush();
    assert.equal(f.media.isReady(), false);
    assert.equal(f.codes.includes("media_ready"), false);
    assert.equal(f.closes(), 1);
    assert.equal(f.signal().aborted, true);
    assert.deepEqual(
      [...new Set(f.unpublished)].sort(),
      f.unpublished.slice().sort(),
    );
    assert.equal(f.room.localParticipant.trackPublications.size, 0);
    assert.equal(f.room.listenerCount(RoomEvent.LocalTrackPublished), 0);
  });

test("publication failure and missing acknowledgement refuse without retry", async () => {
  for (const options of [
    { audioFailure: true },
    { audioPending: true, timeoutMs: 5 },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.media.prepare());
    await f.media.close();
    await assert.rejects(f.media.prepare());
    assert.equal(f.starts(), 1);
    assert.equal(f.codes.includes("media_ready"), false);
    f.room.isConnected = false;
    f.room.emit(RoomEvent.Disconnected);
    assert.equal(f.room.listenerCount(RoomEvent.LocalTrackPublished), 0);
  }
});

test("pre-existing or extra publications never count as a ready single-publisher contract", async () => {
  const existing = fixture();
  existing.put(existing.audioPublication);
  await assert.rejects(existing.media.prepare(), /already has tracks/);
  assert.equal(existing.starts(), 0);
  await existing.media.close();
  const duplicate = fixture({ audioPending: true });
  const prep = duplicate.media.prepare();
  const refusal = assert.rejects(prep, /Unexpected|roster changed/);
  duplicate.put({ ...duplicate.audioPublication, sid: "extra" });
  duplicate.audioAck.resolve();
  await refusal;
  await duplicate.media.close();
  assert.equal(duplicate.codes.includes("media_ready"), false);
});

test("close before prepare cannot create an output or publish", async () => {
  const f = fixture();
  await f.media.close();
  await assert.rejects(f.media.prepare(), /retired/);
  assert.equal(f.starts(), 0);
  assert.equal(f.room.localParticipant.trackPublications.size, 0);
});

test("loss or duplication of a ready track retires readiness before a caller", async () => {
  for (const change of ["remove", "mute", "duplicate"]) {
    const f = fixture();
    await f.media.prepare();
    if (change === "remove") {
      f.room.localParticipant.trackPublications.delete("audio");
      f.room.emit(RoomEvent.LocalTrackUnpublished, f.audioPublication);
    }
    if (change === "mute") {
      f.audioPublication.muted = true;
      f.room.emit(RoomEvent.TrackMuted, f.audioPublication);
    }
    if (change === "duplicate") f.put({ ...f.audioPublication, sid: "extra" });
    assert.equal(f.media.isReady(), false);
    assert.equal(f.failures(), 1);
    await f.media.close();
  }
});
