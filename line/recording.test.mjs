// node --test recording.test.mjs
// No network, no model, no installed dependency. The room, the session, the audio output, the streams, the clock
// and ffmpeg are fakes that the test drives by hand. Each test writes into its own temporary folder.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const {
  CONSENT_LINE,
  STOPPED_LINE,
  asksToStopRecording,
  makeCallRecording,
  recordingSettings,
} = await import("./recording.mjs");
const { RECORDING_RATE, newCallId, pruneRecordings, readWav } =
  await import("./recording-store.mjs");

const KIND_AUDIO = 1,
  KIND_VIDEO = 2,
  I420 = 4;
const events = {
  TrackSubscribed: "trackSubscribed",
  TrackPublished: "trackPublished",
  TrackUnsubscribed: "trackUnsubscribed",
};
const repo = fileURLToPath(new URL("..", import.meta.url));

/** A folder of its own for each test, outside the checkout. */
function folder() {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-recording-"));
  return {
    home,
    root: join(home, "recordings"),
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** One synthetic call: a room with the caller in it, a session, an audio output and a clock that the test moves. */
function call({ env = {}, video = false, ffmpeg = true, home } = {}) {
  let clock = Date.parse("2026-11-28T10:15:00.000Z");
  const now = () => clock;
  const pass = (ms) => {
    clock += ms;
  };
  const room = new EventEmitter();
  const audioPublication = {
    sid: "TR_audio",
    kind: KIND_AUDIO,
    name: "facetime-remote-audio",
    track: { sid: "TR_audio", kind: KIND_AUDIO },
  };
  const subscribed = [];
  const videoPublication = {
    sid: "TR_video",
    kind: KIND_VIDEO,
    name: "facetime-remote-video",
    track: null,
    setSubscribed(on) {
      subscribed.push(on);
      this.track = on ? { sid: "TR_video", kind: KIND_VIDEO } : null;
    },
  };
  const caller = {
    identity: "chert-bridge-synthetic",
    trackPublications: new Map([
      ["TR_audio", audioPublication],
      ...(video ? [["TR_video", videoPublication]] : []),
    ]),
  };
  room.remoteParticipants = new Map([[caller.identity, caller]]);
  const streams = [];
  class FakeAudioStream extends ReadableStream {
    constructor(track, options) {
      let controller;
      super({
        start(value) {
          controller = value;
        },
      });
      streams.push({
        track,
        options,
        // A stream that the recorder canceled takes no more frames.
        push: (frame) => {
          try {
            controller.enqueue(frame);
          } catch {}
        },
      });
    }
  }
  const videoStreams = [];
  class FakeVideoStream extends ReadableStream {
    constructor(track) {
      let controller;
      super({
        start(value) {
          controller = value;
        },
      });
      videoStreams.push({
        track,
        push: (frame) => {
          try {
            controller.enqueue({ frame });
          } catch {}
        },
      });
    }
  }
  const spawned = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    const out = args.at(-1);
    const written = [];
    child.stdin = Object.assign(new EventEmitter(), {
      write(chunk) {
        written.push(Buffer.from(chunk));
        return true;
      },
      end() {
        // An encoder may make its file with a mode that others can read.
        writeFileSync(out, Buffer.from("synthetic mp4"));
        chmodSync(out, 0o644);
        setImmediate(() => child.emit("close", 0));
      },
    });
    child.kill = () => child.emit("close", null);
    spawned.push({ command, args, written, out });
    return child;
  };
  const ticks = [];
  const interval = (run) => {
    ticks.push(run);
    return () => ticks.splice(ticks.indexOf(run), 1);
  };
  const session = new EventEmitter();
  const played = [];
  const output = {
    async captureFrame(frame) {
      played.push(frame);
    },
  };
  const logs = [];
  const settings = recordingSettings(
    { CLAWDTIME_LINE_RECORDING: "on", ...env },
    { home, repo },
  );
  const recording = makeCallRecording({
    settings,
    room,
    callerIdentity: caller.identity,
    callStarted: now(),
    media: {
      AudioStream: FakeAudioStream,
      VideoStream: FakeVideoStream,
      KIND_AUDIO,
      KIND_VIDEO,
      I420,
      events,
    },
    spawn,
    ffmpegReady: () => ffmpeg,
    interval,
    now,
    log: (event, detail) => logs.push({ event, ...detail }),
  });
  recording?.attach(session, output);
  const frame = (value, samples = 480) =>
    Object.assign(
      {
        data: new Int16Array(samples).fill(value),
        sampleRate: RECORDING_RATE,
        channels: 1,
        samplesPerChannel: samples,
      },
      {},
    );
  const videoFrame = (width, height) => ({
    width,
    height,
    type: I420,
    data: new Uint8Array((width * height * 3) / 2).fill(7),
    convert() {
      return this;
    },
  });
  const said = (role, text, at = now()) =>
    session.emit("conversation_item_added", {
      item: { type: "message", role, textContent: text, createdAt: at },
    });
  const heard = (text, isFinal = true) =>
    session.emit("user_input_transcribed", {
      transcript: text,
      isFinal,
      createdAt: now(),
    });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    recording,
    room,
    caller,
    audioPublication,
    videoPublication,
    subscribed,
    streams,
    videoStreams,
    spawned,
    ticks,
    output,
    played,
    session,
    logs,
    frame,
    videoFrame,
    said,
    heard,
    pass,
    now,
    flush,
  };
}

const calls = (root) =>
  existsSync(root)
    ? readdirSync(root).filter((name) => /^[0-9]{8}-/.test(name))
    : [];
const record = (root, id) =>
  JSON.parse(readFileSync(join(root, id, "call.json"), "utf8"));
const transcript = (root, id) =>
  JSON.parse(readFileSync(join(root, id, "transcript.json"), "utf8"));

test("the switch is off by default, and only the exact word on turns it on", () => {
  const { home, done } = folder();
  try {
    for (const value of [undefined, "", "off", "yes", "true", "1", "ON"])
      assert.equal(
        recordingSettings(
          value === undefined ? {} : { CLAWDTIME_LINE_RECORDING: value },
          { home, repo },
        ).on,
        false,
        `value ${value}`,
      );
    const on = recordingSettings(
      { CLAWDTIME_LINE_RECORDING: "on" },
      { home, repo },
    );
    assert.equal(on.on, true);
    assert.equal(on.root, join(home, ".local/share/clawdtime/line/recordings"));
    assert.equal(on.days, 30);
    assert.equal(on.video, true);
    assert.equal(on.line, "clawdtime");
    const state = recordingSettings(
      {
        CLAWDTIME_LINE_RECORDING: "on",
        CLAWDTIME_LINE_STATE: join(home, "state"),
        CLAWDTIME_LINE_RECORDING_DAYS: "7",
        CLAWDTIME_LINE_RECORDING_VIDEO: "off",
        CLAWDTIME_LINE_RECORDING_LABEL: "test-line",
      },
      { home, repo },
    );
    assert.equal(state.root, join(home, "state/recordings"));
    assert.equal(state.days, 7);
    assert.equal(state.video, false);
    assert.equal(state.line, "test-line");
  } finally {
    done();
  }
});

test("a bad folder or retention turns recording off with a code, never on", () => {
  const { home, done } = folder();
  try {
    const off = (env) =>
      recordingSettings(
        { CLAWDTIME_LINE_RECORDING: "on", ...env },
        { home, repo },
      );
    assert.equal(
      off({ CLAWDTIME_LINE_RECORDING_DAYS: "0" }).code,
      "days_invalid",
    );
    assert.equal(
      off({ CLAWDTIME_LINE_RECORDING_DAYS: "abc" }).code,
      "days_invalid",
    );
    assert.equal(
      off({ CLAWDTIME_LINE_RECORDING_DAYS: "366" }).code,
      "days_invalid",
    );
    assert.equal(
      off({ CLAWDTIME_LINE_RECORDING_DIR: "recordings" }).code,
      "folder_not_absolute",
    );
    const inRepo = off({
      CLAWDTIME_LINE_RECORDING_DIR: join(repo, "line", "recordings"),
    });
    assert.equal(inRepo.on, false);
    assert.equal(inRepo.code, "folder_in_checkout");
    assert.equal(
      off({ CLAWDTIME_LINE_RECORDING_LABEL: "bad/label" }).code,
      "label_invalid",
    );
  } finally {
    done();
  }
});

test("off by default: a whole call records nothing and writes no file", async () => {
  const { home, root, done } = folder();
  try {
    const recording = makeCallRecording({
      settings: recordingSettings({}, { home, repo }),
      room: new EventEmitter(),
      callerIdentity: "chert-bridge-synthetic",
      callStarted: Date.now(),
    });
    assert.equal(recording, null);
    const off = call({ env: { CLAWDTIME_LINE_RECORDING: "off" }, home });
    assert.equal(off.recording, null);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(join(home, ".local")), false);
  } finally {
    done();
  }
});

test("on: a synthetic call keeps its times, its whole transcript and the audio of both sides as WAV files", async () => {
  const { home, done } = folder();
  try {
    const f = call({
      home,
      env: { CLAWDTIME_LINE_RECORDING_LABEL: "test-line" },
    });
    const root = join(home, ".local/share/clawdtime/line/recordings");
    const greeting = f.recording.greet(
      "Greet the caller in one short sentence.",
    );
    assert.ok(greeting.includes(CONSENT_LINE));
    assert.ok(
      greeting.indexOf(CONSENT_LINE) < greeting.indexOf("Greet the caller"),
    );
    // The consent line starts to play: the recording starts with its first frame.
    await f.output.captureFrame(f.frame(1000));
    assert.equal(
      f.played.length,
      1,
      "the agent's audio still reaches the call",
    );
    assert.equal(calls(root).length, 1);
    assert.equal(f.streams.length, 1, "one stream reads the caller's voice");
    assert.equal(f.streams[0].track, f.audioPublication.track);
    assert.deepEqual(f.streams[0].options, {
      sampleRate: RECORDING_RATE,
      numChannels: 1,
    });
    f.said("assistant", `${CONSENT_LINE} Hi, I am ClawdTime on this Mac.`);
    f.pass(1000);
    f.streams[0].push(f.frame(-2000));
    await f.flush();
    f.said("user", "Open Stonepad, please.");
    f.pass(500);
    await f.output.captureFrame(f.frame(3000));
    f.said("assistant", "Stonepad is open.");
    await f.flush();
    f.pass(1500);
    await f.recording.close("caller_or_session_closed");
    const [id] = calls(root);
    const meta = record(root, id);
    assert.equal(meta.status, "complete");
    assert.equal(meta.line, "test-line");
    assert.equal(meta.callStartedAt, "2026-11-28T10:15:00.000Z");
    assert.equal(meta.recordingStartedAt, "2026-11-28T10:15:00.000Z");
    assert.equal(meta.endedAt, "2026-11-28T10:15:03.000Z");
    assert.equal(meta.durationMs, 3000);
    assert.equal(meta.recordedMs, 3000);
    assert.equal(meta.stoppedBy, null);
    assert.equal(meta.consent, CONSENT_LINE);
    assert.equal(meta.keepUntil, "2026-12-28T10:15:00.000Z");
    assert.deepEqual(
      meta.parts.map((part) => part.part),
      ["transcript", "caller-audio", "agent-audio", "mixed-audio"],
    );
    const turns = transcript(root, id).turns;
    assert.deepEqual(
      turns.map((turn) => [turn.who, turn.text, turn.offsetMs]),
      [
        ["note", "Recording started.", 0],
        ["agent", `${CONSENT_LINE} Hi, I am ClawdTime on this Mac.`, 0],
        ["caller", "Open Stonepad, please.", 1000],
        ["agent", "Stonepad is open.", 1500],
        ["note", "The call ended.", 3000],
      ],
    );
    const caller = readWav(join(root, id, "caller.wav"));
    const agent = readWav(join(root, id, "agent.wav"));
    const mixed = readWav(join(root, id, "mixed.wav"));
    for (const wav of [caller, agent, mixed]) {
      assert.equal(wav.rate, RECORDING_RATE);
      assert.equal(wav.channels, 1);
    }
    // The caller spoke one second in: silence first, then the voice.
    assert.equal(caller.samples.length, 24000 + 480);
    assert.equal(caller.samples[0], 0);
    assert.equal(caller.samples[24000], -2000);
    // The agent's second frame came 1.5 seconds in: silence fills the gap.
    assert.equal(agent.samples[0], 1000);
    assert.equal(agent.samples[480], 0);
    assert.equal(agent.samples[36000], 3000);
    assert.equal(
      mixed.samples.length,
      Math.max(caller.samples.length, agent.samples.length),
    );
    assert.equal(mixed.samples[0], 1000);
    assert.equal(mixed.samples[24000], -2000);
    assert.equal(mixed.samples[36000], 3000);
    for (const part of meta.parts)
      assert.equal(part.bytes, statSync(join(root, id, part.file)).size);
    // Owner-only: the folder of the call and each file in it.
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, id)).mode & 0o777, 0o700);
    for (const name of readdirSync(join(root, id)))
      assert.equal(statSync(join(root, id, name)).mode & 0o777, 0o600, name);
    // The log has codes only, never words of the call.
    assert.ok(f.logs.some((entry) => entry.code === "started"));
    assert.ok(!JSON.stringify(f.logs).includes("Stonepad"));
  } finally {
    done();
  }
});

test("consent comes first: nothing is recorded before the greeting asks for the consent line and it plays", async () => {
  const { home, done } = folder();
  try {
    const f = call({ home });
    const root = join(home, ".local/share/clawdtime/line/recordings");
    // Audio and words before the greeting are not recorded.
    await f.output.captureFrame(f.frame(500));
    f.said("user", "Hello?");
    assert.equal(calls(root).length, 0);
    assert.equal(f.streams.length, 0);
    f.recording.greet("Greet the caller.");
    // A second greeting does not ask for the line again.
    assert.equal(f.recording.greet("Greet the caller."), "Greet the caller.");
    assert.equal(calls(root).length, 0, "the request alone starts nothing");
    await f.output.captureFrame(f.frame(700));
    const [id] = calls(root);
    await f.recording.close("room_disconnected");
    const turns = transcript(root, id).turns;
    assert.equal(turns[0].text, "Recording started.");
    assert.ok(!turns.some((turn) => turn.text === "Hello?"));
    assert.equal(readWav(join(root, id, "agent.wav")).samples[0], 700);
  } finally {
    done();
  }
});

test("a call that never greets is never recorded", async () => {
  const { home, done } = folder();
  try {
    const f = call({ home });
    await f.output.captureFrame(f.frame(500));
    f.said("user", "Hello?");
    await f.recording.close("room_disconnected");
    assert.equal(
      calls(join(home, ".local/share/clawdtime/line/recordings")).length,
      0,
    );
    assert.ok(f.logs.some((entry) => entry.code === "not_started"));
  } finally {
    done();
  }
});

test("stop recording: the caller's words stop every part at once, and the call goes on", async () => {
  const { home, done } = folder();
  try {
    const f = call({ home });
    const root = join(home, ".local/share/clawdtime/line/recordings");
    f.recording.greet("Greet the caller.");
    await f.output.captureFrame(f.frame(100));
    f.said("assistant", CONSENT_LINE);
    f.pass(1000);
    f.streams[0].push(f.frame(200));
    await f.flush();
    f.heard("stop", false);
    assert.equal(
      f.recording.state(),
      "recording",
      "a partial transcript does not stop it",
    );
    f.heard("Please stop recording.");
    assert.equal(f.recording.state(), "stopped");
    // After the stop: no audio, no words.
    f.pass(1000);
    f.streams[0].push(f.frame(300));
    await f.output.captureFrame(f.frame(400));
    assert.equal(f.played.length, 2, "the agent still speaks on the call");
    f.said("user", "Please stop recording.");
    f.said("assistant", STOPPED_LINE);
    await f.flush();
    f.pass(5000);
    await f.recording.close("caller_or_session_closed");
    const [id] = calls(root);
    const meta = record(root, id);
    assert.equal(meta.stoppedBy, "caller");
    assert.equal(meta.recordedMs, 1000);
    assert.equal(meta.durationMs, 7000);
    assert.equal(meta.recordingEndedAt, "2026-11-28T10:15:01.000Z");
    const turns = transcript(root, id).turns;
    assert.deepEqual(
      turns.map((turn) => turn.text),
      ["Recording started.", CONSENT_LINE, "The caller stopped the recording."],
    );
    const caller = readWav(join(root, id, "caller.wav")).samples;
    assert.ok(!caller.includes(300));
    assert.ok(!readWav(join(root, id, "agent.wav")).samples.includes(400));
  } finally {
    done();
  }
});

test("the stop_recording tool stops at once, releases the caller turn, and says that recording is off", async () => {
  const { home, done } = folder();
  try {
    const f = call({ home });
    f.recording.greet("Greet the caller.");
    await f.output.captureFrame(f.frame(100));
    let canceled = 0;
    const tools = f.recording.tools((definition) => definition, {
      cancel: () => canceled++,
    });
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["stop_recording"],
    );
    assert.ok(f.recording.instructions.includes("stop_recording"));
    assert.equal(await tools[0].execute({}), STOPPED_LINE);
    assert.equal(canceled, 1);
    assert.equal(f.recording.state(), "stopped");
    assert.equal(await tools[0].execute({}), STOPPED_LINE);
    assert.equal(canceled, 2);
    await f.recording.close("caller_or_session_closed");
  } finally {
    done();
  }
});

test("stop recording before the consent line plays means nothing of the call is recorded", async () => {
  const { home, done } = folder();
  try {
    const f = call({ home });
    f.recording.greet("Greet the caller.");
    f.heard("Don't record this call.");
    await f.output.captureFrame(f.frame(100));
    await f.recording.close("caller_or_session_closed");
    assert.equal(
      calls(join(home, ".local/share/clawdtime/line/recordings")).length,
      0,
    );
  } finally {
    done();
  }
});

test("the stop phrase is found in plain speech, and other words do not stop it", () => {
  for (const said of [
    "stop recording",
    "Please stop the recording.",
    "Can you turn off the recording?",
    "turn the recording off",
    "Don't record this.",
    "do not record me",
    "End recording now",
  ])
    assert.equal(asksToStopRecording(said), true, said);
  for (const said of [
    "Open the recording app",
    "record a note",
    "stop",
    "",
    null,
  ])
    assert.equal(asksToStopRecording(said), false, String(said));
});

test("video: a caller's video track is subscribed and kept as MP4 parts, a new part for a new size", async () => {
  const { home, done } = folder();
  try {
    const f = call({ home, video: true });
    const root = join(home, ".local/share/clawdtime/line/recordings");
    f.recording.greet("Greet the caller.");
    await f.output.captureFrame(f.frame(100));
    assert.deepEqual(f.subscribed, [true]);
    // The library says that the subscription is there.
    f.room.emit(
      events.TrackSubscribed,
      f.videoPublication.track,
      f.videoPublication,
      f.caller,
    );
    assert.equal(f.videoStreams.length, 1);
    f.videoStreams[0].push(f.videoFrame(640, 480));
    await f.flush();
    for (const tick of [...f.ticks]) tick();
    f.videoStreams[0].push(f.videoFrame(480, 640));
    await f.flush();
    for (const tick of [...f.ticks]) tick();
    await f.recording.close("caller_or_session_closed");
    assert.deepEqual(
      f.subscribed,
      [true, false],
      "the subscription ends with the recording",
    );
    assert.equal(f.spawned.length, 2);
    assert.ok(f.spawned[0].args.includes("640x480"));
    assert.ok(f.spawned[1].args.includes("480x640"));
    assert.equal(f.spawned[0].written[0].length, (640 * 480 * 3) / 2);
    const [id] = calls(root);
    const meta = record(root, id);
    assert.deepEqual(
      meta.parts
        .filter((part) => part.part === "video")
        .map((part) => part.file),
      ["video-1.mp4", "video-2.mp4"],
    );
    for (const name of ["video-1.mp4", "video-2.mp4"])
      assert.equal(statSync(join(root, id, name)).mode & 0o777, 0o600, name);
    assert.deepEqual(meta.missing, []);
  } finally {
    done();
  }
});

test("video that cannot be recorded leaves a plain reason in the call record, and the rest is recorded", async () => {
  const { home, done } = folder();
  try {
    const root = join(home, ".local/share/clawdtime/line/recordings");
    const none = call({ home });
    none.recording.greet("Greet the caller.");
    await none.output.captureFrame(none.frame(100));
    await none.recording.close("caller_or_session_closed");
    const noTool = call({ home, video: true, ffmpeg: false });
    // The answer about ffmpeg comes before the greeting.
    await noTool.flush();
    noTool.recording.greet("Greet the caller.");
    await noTool.output.captureFrame(noTool.frame(100));
    await noTool.recording.close("caller_or_session_closed");
    assert.deepEqual(
      noTool.subscribed,
      [],
      "no video is subscribed without a way to keep it",
    );
    const off = call({
      home,
      video: true,
      env: { CLAWDTIME_LINE_RECORDING_VIDEO: "off" },
    });
    off.recording.greet("Greet the caller.");
    await off.output.captureFrame(off.frame(100));
    await off.recording.close("caller_or_session_closed");
    const reasons = calls(root)
      .map((id) => record(root, id))
      .map((meta) => {
        assert.ok(meta.parts.some((part) => part.part === "caller-audio"));
        return meta.missing
          .map((item) => `${item.part}: ${item.reason}`)
          .join();
      })
      .sort();
    assert.deepEqual(reasons, [
      "video: The caller sent no video.",
      "video: Video recording is off for this line.",
      "video: ffmpeg is not on this Mac, so video is not recorded.",
    ]);
  } finally {
    done();
  }
});

test("retention: each call keeps its own end date, and old calls go at the next recording", async () => {
  const { home, done } = folder();
  try {
    const root = join(home, ".local/share/clawdtime/line/recordings");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const old = newCallId(Date.parse("2026-10-01T09:00:00Z"));
    const recent = newCallId(Date.parse("2026-11-27T09:00:00Z"));
    for (const [id, keepUntil] of [
      [old, "2026-10-31T09:00:00.000Z"],
      [recent, "2026-12-27T09:00:00.000Z"],
    ]) {
      mkdirSync(join(root, id), { mode: 0o700 });
      writeFileSync(
        join(root, id, "call.json"),
        JSON.stringify({ version: 1, id, keepUntil }),
        {
          mode: 0o600,
        },
      );
    }
    mkdirSync(join(root, "not-a-call"), { mode: 0o700 });
    assert.deepEqual(
      pruneRecordings(root, Date.parse("2026-11-28T10:00:00Z")),
      [old],
    );
    assert.ok(!existsSync(join(root, old)));
    assert.ok(existsSync(join(root, recent)));
    assert.ok(
      existsSync(join(root, "not-a-call")),
      "a folder that is not a call is never removed",
    );
    // The end of a recorded call prunes too.
    writeFileSync(
      join(root, recent, "call.json"),
      JSON.stringify({
        version: 1,
        id: recent,
        keepUntil: "2026-11-01T00:00:00.000Z",
      }),
      {
        mode: 0o600,
      },
    );
    const f = call({ home, env: { CLAWDTIME_LINE_RECORDING_DAYS: "7" } });
    f.recording.greet("Greet the caller.");
    await f.output.captureFrame(f.frame(100));
    await f.recording.close("caller_or_session_closed");
    assert.ok(!existsSync(join(root, recent)));
    const [id] = calls(root);
    assert.equal(record(root, id).keepUntil, "2026-12-05T10:15:00.000Z");
  } finally {
    done();
  }
});

test("a recordings folder that others can read is not used: the call goes on and nothing is recorded", async () => {
  const { home, done } = folder();
  try {
    const root = join(home, "open");
    mkdirSync(root, { mode: 0o755 });
    const f = call({ home, env: { CLAWDTIME_LINE_RECORDING_DIR: root } });
    f.recording.greet("Greet the caller.");
    await f.output.captureFrame(f.frame(100));
    assert.equal(f.played.length, 1);
    await f.recording.close("caller_or_session_closed");
    assert.deepEqual(readdirSync(root), []);
    assert.ok(f.logs.some((entry) => entry.code === "folder_not_private"));
  } finally {
    done();
  }
});

test("the line agent wires the recording into ordinary calls only", () => {
  const source = readFileSync(new URL("./agent.mjs", import.meta.url), "utf8");
  for (const hook of [
    'from "./recording.mjs"',
    "recording = ordinaryCall\n      ? makeCallRecording(",
    "recording?.attach(session, audioOutput)",
    "recording?.greet(greeting) ?? greeting",
    "recording?.tools(llm.tool, callerRequest)",
    "recording?.instructions",
    "recording?.close(reason)",
  ])
    assert.ok(source.includes(hook), hook);
});
