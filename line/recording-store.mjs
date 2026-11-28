// The files of a recorded call, on disk. This file is the contract between the line agent, which writes them, and
// the desktop service and the `clawdtime recordings` command, which read them (src/recordings/store.ts).
// docs/RECORDING.md describes the format.
//
// The rules that this file keeps:
//  - The recordings folder and the folder of each call are for their owner only (0700). Each file is for its owner
//    only (0600), is made new (never through a link), and a JSON file is written whole and then renamed into place.
//  - A call folder has a fixed name: YYYYMMDD-HHMMSS-xxxxxx. Nothing else in the recordings folder is touched.
//  - Each call keeps its own end date (`keepUntil`). The prune removes a call after that date, and nothing else.
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/** Every audio file is 16-bit PCM, one channel, at this rate. */
export const RECORDING_RATE = 24000;
/** The name of a call folder. */
export const CALL_ID = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
/** The names that a part of a call can have. */
export const PART_FILE =
  /^(?:transcript\.json|caller\.wav|agent\.wav|mixed\.wav|video-[1-9][0-9]?\.mp4)$/;
/** A WAV file stops growing here, far below the 4 GB limit of the format: about 11 hours at the rate above. */
export const WAV_LIMIT = 2 ** 31;

const HEADER = 44;
const mine = (stat) =>
  process.getuid === undefined || stat.uid === process.getuid();

/** A problem with a fixed code. It never holds a word of a call. */
export class RecordingError extends Error {
  constructor(code) {
    super(code);
    this.name = "RecordingError";
    this.code = code;
  }
}

/** True for a folder of this user that only its owner can open. */
export function privateFolder(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && mine(stat) && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Makes the recordings folder for its owner only, or checks the one that is there. */
export function openRecordingsRoot(root) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch {
    throw new RecordingError("folder_unavailable");
  }
  if (!privateFolder(root)) throw new RecordingError("folder_not_private");
  return root;
}

/** A new call id, sorted by its time: 20261128-101500-a1b2c3. */
export function newCallId(at = Date.now()) {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${randomBytes(3).toString("hex")}`;
}

/** Makes the folder of one call. It must be new. */
export function makeCallFolder(root, id) {
  if (!CALL_ID.test(id)) throw new RecordingError("call_id_invalid");
  const folder = join(root, id);
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch {
    throw new RecordingError("call_folder_unavailable");
  }
  if (!privateFolder(folder)) throw new RecordingError("folder_not_private");
  return folder;
}

const createFlags =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

/**
 * Writes one JSON file whole: a new file for its owner only, then a rename into place. `sync: false` does not wait
 * for the disk: a reader still never sees half a file.
 */
export function writeJSON(file, value, { sync = true } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, createFlags, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    if (sync) fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, file);
}

/** One JSON file of a call, or null when it is not a regular owner-only file or not valid JSON. */
export function readJSON(file) {
  try {
    const before = lstatSync(file);
    if (!before.isFile() || !mine(before) || before.mode & 0o077) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function header(dataBytes, rate = RECORDING_RATE) {
  const value = Buffer.alloc(HEADER);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(36 + dataBytes, 4);
  value.write("WAVE", 8, "ascii");
  value.write("fmt ", 12, "ascii");
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20); // PCM
  value.writeUInt16LE(1, 22); // one channel
  value.writeUInt32LE(rate, 24);
  value.writeUInt32LE(rate * 2, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36, "ascii");
  value.writeUInt32LE(dataBytes, 40);
  return value;
}

/**
 * One WAV file that grows during a call. Samples wait in memory for at most `flushBytes`, and the header is right
 * after each flush: a process that stops in the middle of a call leaves a file that plays up to its last flush.
 */
export function makeWavWriter(
  file,
  { rate = RECORDING_RATE, flushBytes = 96000 } = {},
) {
  const fd = openSync(file, createFlags, 0o600);
  writeSync(fd, header(0, rate));
  let samples = 0,
    written = 0,
    pending = [],
    pendingBytes = 0,
    closed = false,
    full = false;
  const flush = () => {
    if (!pendingBytes || closed) return;
    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    writeSync(fd, chunk, 0, chunk.length, HEADER + written);
    written += chunk.length;
    writeSync(fd, header(written, rate), 0, HEADER, 0);
  };
  const push = (buffer) => {
    if (closed || full) return;
    if (HEADER + written + pendingBytes + buffer.length > WAV_LIMIT) {
      full = true;
      return;
    }
    pending.push(buffer);
    pendingBytes += buffer.length;
    samples += buffer.length / 2;
    if (pendingBytes >= flushBytes) flush();
  };
  return {
    /** How many samples the file holds, with the ones that still wait. */
    get samples() {
      return samples;
    },
    /** Silence: `count` samples of zero. */
    pad(count) {
      if (count > 0) push(Buffer.alloc(Math.floor(count) * 2));
    },
    /** 16-bit samples of one channel. */
    write(int16) {
      if (!int16.length) return;
      push(Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2));
    },
    flush,
    /** Writes what waits and the final header. Gives the size of the file. */
    close() {
      if (closed) return HEADER + written;
      flush();
      closed = true;
      const size = fstatSync(fd).size;
      fsyncSync(fd);
      closeSync(fd);
      return size;
    },
  };
}

/** The samples of one frame as one channel at the rate of the files: the first channel, and a plain resample. */
export function monoAtRate(frame, rate = RECORDING_RATE) {
  const channels = Math.max(1, frame.channels || 1);
  const count =
    frame.samplesPerChannel ?? Math.floor(frame.data.length / channels);
  let mono = frame.data;
  if (channels > 1) {
    mono = new Int16Array(count);
    for (let index = 0; index < count; index++)
      mono[index] = frame.data[index * channels];
  }
  if (!frame.sampleRate || frame.sampleRate === rate) return mono;
  const length = Math.floor((count * rate) / frame.sampleRate);
  const out = new Int16Array(length);
  const step = frame.sampleRate / rate;
  for (let index = 0; index < length; index++) {
    const at = index * step,
      low = Math.floor(at),
      high = Math.min(low + 1, count - 1),
      part = at - low;
    out[index] = Math.round(mono[low] * (1 - part) + mono[high] * part);
  }
  return out;
}

/**
 * The audio of one side of the call, on the clock of the call: when a frame comes later than the file has reached,
 * silence fills the gap. A frame that comes early (the agent's audio is pushed up to 200 ms ahead) is written as it
 * comes. `slackMs` keeps small jitter from adding silence.
 */
export function makeTrackWriter(
  file,
  { startMs, rate = RECORDING_RATE, slackMs = 100 } = {},
) {
  const wav = makeWavWriter(file, { rate });
  const slack = (slackMs * rate) / 1000;
  return {
    write(frame, atMs) {
      const target = Math.floor(((atMs - startMs) * rate) / 1000);
      if (target - wav.samples > slack) wav.pad(target - wav.samples);
      wav.write(monoAtRate(frame, rate));
    },
    get samples() {
      return wav.samples;
    },
    close: () => wav.close(),
  };
}

/** Reads one WAV file of this format: its rate, its channels and its samples. For tests and checks. */
export function readWav(file) {
  const bytes = readFileSync(file);
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new RecordingError("wav_invalid");
  const data = bytes.readUInt32LE(40);
  const samples = new Int16Array(data / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = bytes.readInt16LE(HEADER + index * 2);
  return {
    rate: bytes.readUInt32LE(24),
    channels: bytes.readUInt16LE(22),
    samples,
  };
}

/**
 * Adds the WAV files into one new WAV file, sample by sample, with a limit at the loudest value. It reads and writes
 * in parts, and it waits for the disk without holding the call's event loop. Gives the size of the new file.
 */
export async function mixWav(
  files,
  out,
  { rate = RECORDING_RATE, chunk = 1 << 18 } = {},
) {
  const inputs = await Promise.all(files.map((file) => open(file, "r")));
  const output = await open(out, createFlags, 0o600);
  try {
    const sizes = await Promise.all(
      inputs.map(async (input) =>
        Math.max(0, (await input.stat()).size - HEADER),
      ),
    );
    const longest = Math.max(0, ...sizes.map((size) => size - (size % 2)));
    await output.write(header(longest, rate), 0, HEADER, 0);
    const sum = Buffer.alloc(chunk),
      part = Buffer.alloc(chunk);
    for (let at = 0; at < longest; at += chunk) {
      const length = Math.min(chunk, longest - at);
      const total = new Int32Array(length / 2);
      for (const [index, input] of inputs.entries()) {
        const have = Math.max(0, Math.min(length, sizes[index] - at));
        if (have < 2) continue;
        const { bytesRead } = await input.read(part, 0, have, HEADER + at);
        for (let sample = 0; sample < Math.floor(bytesRead / 2); sample++)
          total[sample] += part.readInt16LE(sample * 2);
      }
      for (let sample = 0; sample < total.length; sample++)
        sum.writeInt16LE(
          Math.max(-32768, Math.min(32767, total[sample])),
          sample * 2,
        );
      await output.write(sum, 0, length, HEADER + at);
    }
    await output.sync();
    return HEADER + longest;
  } finally {
    await output.close();
    await Promise.all(inputs.map((input) => input.close()));
  }
}

/** The call folders, newest first. Only folders with the fixed name count. */
export function listCallIds(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => CALL_ID.test(name))
    .filter((name) => {
      try {
        const stat = lstatSync(join(root, name));
        return stat.isDirectory() && mine(stat);
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/**
 * Removes each call whose own end date is past. A call folder with no readable record goes once its folder is older
 * than `fallbackDays`. Nothing that is not a call folder is removed. Gives the ids that went.
 */
export function pruneRecordings(
  root,
  now = Date.now(),
  { fallbackDays = 30 } = {},
) {
  const removed = [];
  for (const id of listCallIds(root)) {
    const folder = join(root, id);
    const record = readJSON(join(folder, "call.json"));
    let until = Date.parse(record?.keepUntil ?? "");
    if (!Number.isFinite(until)) {
      try {
        until = lstatSync(folder).mtimeMs + fallbackDays * 86_400_000;
      } catch {
        continue;
      }
    }
    if (now <= until) continue;
    try {
      rmSync(folder, { recursive: true, force: true });
      removed.push(id);
    } catch {
      /* The next prune tries again. */
    }
  }
  return removed;
}
