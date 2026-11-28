// Call recording for a line: an internal switch for experiments with clear consent. It is off unless the line's
// .env.local says CLAWDTIME_LINE_RECORDING=on. docs/RECORDING.md is the guide.
//
// How one call is recorded:
//  1. The greeting asks the agent to say the consent line first (CONSENT_LINE). Nothing is recorded yet.
//  2. The first audio frame of the agent after that request is the consent line as it starts to play. The recording
//     starts with it: the call folder, the caller's voice (its own audio stream), the agent's voice (a copy of each
//     frame that goes to the call), the transcript (the session's conversation items) and, when the caller sends
//     video and ffmpeg is on this Mac, the caller's video.
//  3. "Stop recording" in the caller's final transcript, or the stop_recording tool, stops every part at once. The
//     call goes on. What was recorded before the stop is kept.
//  4. When the call ends, the files are closed, the two voices are mixed into one more file, and the record of the
//     call gets its end time.
// Without a greeting (no ready signal) there is no consent line, and nothing of the call is recorded.
// The log of the line gets codes only, never a word of the call.
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  RECORDING_RATE,
  RecordingError,
  makeCallFolder,
  makeTrackWriter,
  mixWav,
  newCallId,
  openRecordingsRoot,
  privateFolder,
  pruneRecordings,
  writeJSON,
} from "./recording-store.mjs";
import { ffmpegAnswers, makeVideoCapture } from "./recording-video.mjs";

/** The words that the agent says first on a recorded call. */
export const CONSENT_LINE =
  "This call is recorded. Say stop recording to turn it off.";
/** What the stop_recording tool gives the agent to say. */
export const STOPPED_LINE =
  "Recording is off. Nothing more of this call is recorded.";

/** What the voice model is told on a recorded call. */
const INSTRUCTIONS =
  "This call is recorded, and the caller heard a notice about it. When the caller asks to stop recording, call stop_recording, then say its result. Do not use ask_clawdtime for that request.";

const STOP =
  /\b(?:(?:stop|end|pause|cancel)\s+(?:the\s+|this\s+)?recording|turn\s+(?:off\s+(?:the\s+)?recording|(?:the\s+)?recording\s+off)|(?:do\s+not|don't|dont)\s+record)\b/i;

/** True when the caller's words ask to stop the recording. A wrong match only stops a recording, never starts one. */
export function asksToStopRecording(text) {
  return typeof text === "string" && STOP.test(text.replace(/[’]/g, "'"));
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const THIS_CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

/** The real path of `path`, also when its last parts are not made yet. */
function realNearest(path) {
  const rest = [];
  let at = resolve(path);
  while (!existsSync(at)) {
    rest.unshift(basename(at));
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  try {
    return join(realpathSync(at), ...rest);
  } catch {
    return resolve(path);
  }
}

const within = (parent, child) => {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
};

/**
 * The recording settings of this line, from its .env.local. Off unless CLAWDTIME_LINE_RECORDING is exactly "on". A
 * setting that is not valid turns recording off and gives a code: the call itself goes on as before.
 */
export function recordingSettings(
  env = process.env,
  { home = homedir(), repo = THIS_CHECKOUT } = {},
) {
  const value = env.CLAWDTIME_LINE_RECORDING;
  if (value === undefined || value === "" || value === "off")
    return { on: false, code: "off" };
  if (value !== "on") return { on: false, code: "setting_invalid" };
  const state =
    env.CLAWDTIME_LINE_STATE || join(home, ".local/share/clawdtime/line");
  const root = env.CLAWDTIME_LINE_RECORDING_DIR || join(state, "recordings");
  if (!isAbsolute(root)) return { on: false, code: "folder_not_absolute" };
  if (within(realNearest(repo), realNearest(root)))
    return { on: false, code: "folder_in_checkout" };
  const daysText = env.CLAWDTIME_LINE_RECORDING_DAYS ?? "30";
  const days = /^[0-9]{1,3}$/.test(daysText) ? Number(daysText) : NaN;
  if (!(days >= 1 && days <= 365)) return { on: false, code: "days_invalid" };
  const video = env.CLAWDTIME_LINE_RECORDING_VIDEO ?? "on";
  if (!["on", "off"].includes(video))
    return { on: false, code: "video_setting_invalid" };
  const line =
    env.CLAWDTIME_LINE_RECORDING_LABEL || env.AGENT_NAME || "clawdtime";
  if (!LABEL.test(line)) return { on: false, code: "label_invalid" };
  return {
    on: true,
    root: resolve(root),
    days,
    video: video === "on",
    line,
    ffmpeg: env.CLAWDTIME_LINE_FFMPEG || "ffmpeg",
  };
}

const iso = (at) => new Date(at).toISOString();
const quiet = async (step) => {
  try {
    return await step();
  } catch {
    return undefined;
  }
};

/**
 * The recording of one ordinary call, or null when recording is off for this line.
 * `media` holds the classes and constants of the voice library: the line agent passes them, so this file loads no
 * library itself and its tests run anywhere.
 */
export function makeCallRecording({
  settings = recordingSettings(),
  room,
  callerIdentity,
  callStarted = Date.now(),
  media = {},
  spawn = spawnProcess,
  ffmpegReady = ffmpegAnswers,
  interval = (run, ms) => {
    const timer = setInterval(run, ms);
    timer.unref?.();
    return () => clearInterval(timer);
  },
  now = Date.now,
  log = () => {},
}) {
  if (!settings?.on) {
    if (settings?.code && settings.code !== "off")
      log("recording", { code: settings.code });
    return null;
  }
  const {
    AudioStream,
    VideoStream,
    KIND_AUDIO,
    KIND_VIDEO,
    I420,
    events = {},
  } = media;
  // waiting: no consent request yet. armed: the greeting asked for the consent line. recording. stopped: the caller
  // or the call ended it. declined: the caller said stop before it started. failed: the folder could not be used.
  let state = "waiting",
    startMs = 0,
    stoppedAt = 0,
    stoppedBy = null,
    folder = null,
    id = null,
    record = null,
    callerTrack = null,
    agentTrack = null,
    video = null,
    finishing = null,
    closing = null,
    session = null,
    output = null,
    original = null;
  const turns = [];
  const missing = [];
  const readers = new Set();
  const subscribedByUs = new Set();
  const videoTracks = new Set();
  let audioTrack = null;
  // Null until ffmpeg answered. Unknown at the start counts as there: a failed start of ffmpeg gives its own reason.
  let ffmpegThere = null;
  if (settings.video)
    Promise.resolve()
      .then(() => ffmpegReady(settings.ffmpeg))
      .then(
        (answer) => {
          ffmpegThere = answer === true;
        },
        () => {
          ffmpegThere = false;
        },
      );

  const writeTranscript = () => {
    if (!folder) return;
    try {
      // No wait for the disk here: this runs during the call.
      writeJSON(
        join(folder, "transcript.json"),
        { version: 1, turns },
        { sync: false },
      );
    } catch {
      log("recording", { code: "transcript_write_failed" });
    }
  };
  const turn = (who, text, at = now(), interrupted = false) => {
    turns.push({
      who,
      text,
      at: iso(at),
      offsetMs: Math.max(0, at - startMs),
      ...(interrupted ? { interrupted: true } : {}),
    });
    writeTranscript();
  };
  const writeRecord = (changes = {}, sync = true) => {
    record = { ...record, ...changes };
    try {
      writeJSON(join(folder, "call.json"), record, { sync });
    } catch {
      log("recording", { code: "record_write_failed" });
    }
  };

  const readAudio = (track) => {
    if (audioTrack || state !== "recording" || !AudioStream) return;
    audioTrack = track;
    let reader;
    try {
      reader = new AudioStream(track, {
        sampleRate: RECORDING_RATE,
        numChannels: 1,
      }).getReader();
    } catch {
      log("recording", { code: "caller_audio_unavailable" });
      return;
    }
    readers.add(reader);
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || state !== "recording") break;
        callerTrack?.write(value, now());
      }
    })()
      .catch(() => {})
      .finally(() => readers.delete(reader));
  };
  const readVideo = (track) => {
    if (
      !video ||
      state !== "recording" ||
      !VideoStream ||
      videoTracks.has(track)
    )
      return;
    videoTracks.add(track);
    let reader;
    try {
      reader = new VideoStream(track).getReader();
    } catch {
      return;
    }
    readers.add(reader);
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || state !== "recording") break;
        video?.feed(value.frame);
      }
    })()
      .catch(() => {})
      .finally(() => readers.delete(reader));
  };
  const look = (publication) => {
    if (state !== "recording" || !publication) return;
    if (publication.kind === KIND_AUDIO && publication.track)
      readAudio(publication.track);
    if (publication.kind === KIND_VIDEO && video) {
      if (
        !publication.track &&
        typeof publication.setSubscribed === "function"
      ) {
        try {
          publication.setSubscribed(true);
          subscribedByUs.add(publication);
        } catch {}
      }
      if (publication.track) readVideo(publication.track);
    }
  };
  const fromCaller = (participant) => participant?.identity === callerIdentity;
  const onSubscribed = (track, publication, participant) => {
    if (!fromCaller(participant)) return;
    if (track?.kind === KIND_AUDIO) readAudio(track);
    if (track?.kind === KIND_VIDEO) readVideo(track);
  };
  const onPublished = (publication, participant) => {
    if (fromCaller(participant)) look(publication);
  };

  const begin = () => {
    startMs = now();
    try {
      const root = openRecordingsRoot(settings.root);
      id = newCallId(startMs);
      folder = makeCallFolder(root, id);
      record = {
        version: 1,
        id,
        line: settings.line,
        status: "recording",
        callStartedAt: iso(callStarted),
        recordingStartedAt: iso(startMs),
        recordingEndedAt: null,
        endedAt: null,
        durationMs: null,
        recordedMs: null,
        stoppedBy: null,
        consent: CONSENT_LINE,
        keepUntil: iso(startMs + settings.days * 86_400_000),
        parts: [],
        missing: [],
        pid: process.pid,
      };
      // The first audio frame waits for this: no wait for the disk.
      writeRecord({}, false);
      callerTrack = makeTrackWriter(join(folder, "caller.wav"), { startMs });
      agentTrack = makeTrackWriter(join(folder, "agent.wav"), { startMs });
    } catch (error) {
      state = "failed";
      log("recording", {
        code: error instanceof RecordingError ? error.code : "start_failed",
      });
      return;
    }
    state = "recording";
    turn("note", "Recording started.", startMs);
    if (!settings.video)
      missing.push({
        part: "video",
        reason: "Video recording is off for this line.",
      });
    else if (!VideoStream || ffmpegThere === false)
      missing.push({
        part: "video",
        reason: "ffmpeg is not on this Mac, so video is not recorded.",
      });
    else
      video = makeVideoCapture({
        folder,
        spawn,
        command: settings.ffmpeg,
        I420,
        interval,
        log,
      });
    if (events.TrackSubscribed) room.on(events.TrackSubscribed, onSubscribed);
    if (events.TrackPublished) room.on(events.TrackPublished, onPublished);
    const caller = room.remoteParticipants?.get?.(callerIdentity);
    for (const publication of caller?.trackPublications?.values?.() ?? [])
      look(publication);
    log("recording", { code: "started" });
  };

  /** Ends every part at once. The files close in the background; `finishing` waits for them. */
  const halt = (by) => {
    if (state === "armed" || state === "waiting") {
      state = by === "caller" ? "declined" : "closed";
      log("recording", { code: by === "caller" ? "declined" : "not_started" });
      return Promise.resolve();
    }
    if (state !== "recording") return finishing ?? Promise.resolve();
    state = "stopped";
    stoppedAt = now();
    stoppedBy = by === "caller" ? "caller" : null;
    if (events.TrackSubscribed)
      room.off?.(events.TrackSubscribed, onSubscribed);
    if (events.TrackPublished) room.off?.(events.TrackPublished, onPublished);
    for (const reader of readers) void quiet(() => reader.cancel());
    for (const publication of subscribedByUs) {
      try {
        publication.setSubscribed(false);
      } catch {}
    }
    turn(
      "note",
      stoppedBy === "caller"
        ? "The caller stopped the recording."
        : "The call ended.",
      stoppedAt,
    );
    log("recording", {
      code: stoppedBy === "caller" ? "stopped_by_caller" : "call_ended",
    });
    const callerSize = quiet(() => callerTrack.close());
    const agentSize = quiet(() => agentTrack.close());
    const parts = [];
    finishing = (async () => {
      const add = async (part, file, size) => {
        const bytes = await size;
        if (typeof bytes === "number") parts.push({ part, file, bytes });
      };
      parts.push({ part: "transcript", file: "transcript.json", bytes: null });
      await add("caller-audio", "caller.wav", callerSize);
      await add("agent-audio", "agent.wav", agentSize);
      await add(
        "mixed-audio",
        "mixed.wav",
        quiet(() =>
          mixWav(
            [join(folder, "caller.wav"), join(folder, "agent.wav")],
            join(folder, "mixed.wav"),
          ),
        ),
      );
      if (video) {
        const made = await video.stop();
        for (const file of made.files) {
          const bytes = await quiet(() => statSync(join(folder, file)).size);
          if (typeof bytes === "number")
            parts.push({ part: "video", file, bytes });
        }
        if (made.reason) missing.push({ part: "video", reason: made.reason });
        else if (!made.files.length)
          missing.push({ part: "video", reason: "The caller sent no video." });
      }
      const transcriptBytes = await quiet(
        () => statSync(join(folder, "transcript.json")).size,
      );
      parts[0].bytes = transcriptBytes ?? 0;
      writeRecord({
        recordingEndedAt: iso(stoppedAt),
        recordedMs: stoppedAt - startMs,
        stoppedBy,
        parts,
        missing,
      });
    })().catch(() => log("recording", { code: "finish_failed" }));
    return finishing;
  };

  const onItem = (event) => {
    const item = event?.item;
    if (state !== "recording" || item?.type !== "message") return;
    const who =
      item.role === "user"
        ? "caller"
        : item.role === "assistant"
          ? "agent"
          : null;
    const text =
      typeof item.textContent === "string" ? item.textContent.trim() : "";
    if (!who || !text) return;
    turn(
      who,
      text,
      Number.isFinite(item.createdAt) ? item.createdAt : now(),
      item.interrupted === true,
    );
  };
  const onHeard = (event) => {
    if (event?.isFinal && asksToStopRecording(event.transcript))
      void halt("caller");
  };

  return {
    /** The state of the recording, for tests and the log. */
    state: () => state,
    /** What the voice model is told about the recording. */
    instructions: INSTRUCTIONS,
    /** The greeting with the consent line first. Only the first greeting of a call asks for it. */
    greet(base) {
      if (state !== "waiting") return base;
      state = "armed";
      log("recording", { code: "armed" });
      return `Before anything else, say exactly these words: "${CONSENT_LINE}" Then: ${base}`;
    },
    /** Listens to the session's words and copies the agent's audio frames. Before the session starts. */
    attach(value, audio) {
      session = value;
      session.on("conversation_item_added", onItem);
      session.on("user_input_transcribed", onHeard);
      if (audio && typeof audio.captureFrame === "function") {
        output = audio;
        original = audio.captureFrame;
        audio.captureFrame = function (frame) {
          try {
            if (state === "armed") begin();
            if (state === "recording") agentTrack?.write(frame, now());
          } catch {
            /* The call's audio never waits for the recording. */
          }
          return original.call(this, frame);
        };
      }
    },
    /** The stop_recording tool for the voice model. `binding` releases the caller's turn, as stop_computer does. */
    tools(tool, binding) {
      return [
        tool({
          name: "stop_recording",
          description:
            "Stop the recording of this call at once, when the caller asks to stop recording. It only stops the recording; the call goes on.",
          parameters: z.object({}).strict(),
          execute: async () => {
            try {
              binding?.cancel?.();
            } catch {}
            // The caller's words may have stopped it a moment before: the answer is the same.
            await halt("caller");
            return STOPPED_LINE;
          },
        }),
      ];
    },
    /** Stops the recording for the caller. */
    stop: () => halt("caller"),
    /** The call ended: closes every file and writes the end of the record. It never throws. */
    close(reason) {
      if (closing) return closing;
      const endedAt = now();
      const halted = halt(reason ?? "call_ended");
      closing = (async () => {
        await halted;
        session?.off?.("conversation_item_added", onItem);
        session?.off?.("user_input_transcribed", onHeard);
        if (output && original) output.captureFrame = original;
        if (!record) return;
        writeRecord({
          status: "complete",
          endedAt: iso(endedAt),
          durationMs: endedAt - callStarted,
        });
        log("recording", { code: "finished" });
      })()
        .catch(() => log("recording", { code: "finish_failed" }))
        .then(() => {
          // Old calls go after the call, never while its audio runs.
          if (!privateFolder(settings.root)) return;
          const pruned = pruneRecordings(settings.root, now());
          if (pruned.length)
            log("recording", { code: "pruned", calls: pruned.length });
        })
        .catch(() => log("recording", { code: "prune_failed" }));
      return closing;
    },
  };
}
