/**
 * The read side of the call recordings of a line: the list, one call, its
 * files, a zip of one call, the delete and the prune. The line agent writes
 * the files (`line/recording-store.mjs`); docs/RECORDING.md has the format.
 *
 * The rules that this file keeps:
 * - Only a folder of this user for its owner alone is read. A file is served
 *   only when it is a part that the record of its call names, a regular file
 *   of this user for its owner alone, with one name, never through a link.
 * - A call id and a file name must have the fixed form. Nothing outside the
 *   folder of one call is read, and nothing that is not a call is removed.
 * - Each call keeps its own end date (`keepUntil`). A read of the list first
 *   removes the calls whose date is past.
 */
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { z } from "zod";

export const CALL_ID = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
export const PART_FILE =
  /^(?:transcript\.json|caller\.wav|agent\.wav|mixed\.wav|video-[1-9][0-9]?\.mp4)$/;
const DAY = 86_400_000;

/**
 * The recordings folder of the line on this Mac: CLAWDTIME_LINE_RECORDING_DIR,
 * else `recordings` in CLAWDTIME_LINE_STATE, else
 * ~/.local/share/clawdtime/line/recordings. Null when the setting is not an
 * absolute path. The line agent finds the same folder (line/recording.mjs).
 */
export function recordingsFolder(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string | null {
  const state =
    env.CLAWDTIME_LINE_STATE || join(home, ".local/share/clawdtime/line");
  const root = env.CLAWDTIME_LINE_RECORDING_DIR || join(state, "recordings");
  return isAbsolute(root) ? resolve(root) : null;
}

const partSchema = z
  .object({
    part: z.enum([
      "transcript",
      "caller-audio",
      "agent-audio",
      "mixed-audio",
      "video",
    ]),
    file: z.string().regex(PART_FILE),
    bytes: z.number().int().nonnegative().nullable(),
  })
  .passthrough();
const recordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(CALL_ID),
    line: z.string().max(64),
    status: z.enum(["recording", "complete"]),
    callStartedAt: z.string(),
    recordingStartedAt: z.string(),
    recordingEndedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    durationMs: z.number().nullable(),
    recordedMs: z.number().nullable(),
    stoppedBy: z.enum(["caller"]).nullable(),
    consent: z.string().max(400),
    keepUntil: z.string(),
    parts: z.array(partSchema).max(64),
    missing: z
      .array(
        z.object({ part: z.string().max(40), reason: z.string().max(400) }),
      )
      .max(16),
    pid: z.number().int().positive(),
  })
  .passthrough();
const turnSchema = z
  .object({
    who: z.enum(["caller", "agent", "note"]),
    text: z.string().max(20_000),
    at: z.string(),
    offsetMs: z.number().nonnegative(),
    interrupted: z.boolean().optional(),
  })
  .passthrough();
const transcriptSchema = z
  .object({ version: z.literal(1), turns: z.array(turnSchema).max(10_000) })
  .passthrough();

export type CallPart = z.infer<typeof partSchema>;
export type Turn = z.infer<typeof turnSchema>;
export interface CallSummary {
  id: string;
  line: string;
  /** recording: the call goes on now. incomplete: the line stopped during the call. */
  status: "recording" | "complete" | "incomplete";
  callStartedAt: string;
  recordingStartedAt: string;
  recordingEndedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  recordedMs: number | null;
  stoppedBy: "caller" | null;
  consent: string;
  keepUntil: string;
  parts: CallPart[];
  missing: { part: string; reason: string }[];
}
export interface CallFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

export const contentType = (name: string) =>
  name.endsWith(".wav")
    ? "audio/wav"
    : name.endsWith(".mp4")
      ? "video/mp4"
      : "application/json";

const mine = (stat: Stats) =>
  process.getuid === undefined || stat.uid === process.getuid();
const safeFile = (stat: Stats) =>
  stat.isFile() && mine(stat) && (stat.mode & 0o077) === 0 && stat.nlink === 1;
const safeFolder = (stat: Stats) =>
  stat.isDirectory() && mine(stat) && (stat.mode & 0o077) === 0;

/** A process of this person with that number runs. Signal 0 sends nothing. */
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class RecordingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingsError";
  }
}

export class Recordings {
  constructor(
    readonly root: string,
    private readonly options: {
      now?: () => number;
      alive?: (pid: number) => boolean;
    } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Null when the folder is fine or not made yet; otherwise a plain sentence. */
  problem(): string | null {
    try {
      return safeFolder(lstatSync(this.root))
        ? null
        : `The recordings folder ${this.root} is not a folder of this user for its owner only, so nothing is read from it. Run: chmod 700 ${this.root}`;
    } catch {
      return null;
    }
  }

  private ids(): string[] {
    if (this.problem()) return [];
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names
      .filter((name) => CALL_ID.test(name))
      .filter((name) => {
        try {
          return safeFolder(lstatSync(join(this.root, name)));
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  }

  private readOwnerFile(path: string, largest: number): Buffer | null {
    let before: Stats;
    try {
      before = lstatSync(path);
    } catch {
      return null;
    }
    if (!safeFile(before) || before.size > largest) return null;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const stat = fstatSync(fd);
      if (!safeFile(stat) || stat.ino !== before.ino) return null;
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private record(id: string): CallSummary | null {
    if (!CALL_ID.test(id) || this.problem()) return null;
    const bytes = this.readOwnerFile(join(this.root, id, "call.json"), 1 << 20);
    if (!bytes) return null;
    let parsed;
    try {
      parsed = recordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    } catch {
      return null;
    }
    if (!parsed.success || parsed.data.id !== id) return null;
    const value = parsed.data;
    const alive = this.options.alive ?? running;
    return {
      id,
      line: value.line,
      status:
        value.status === "recording" && !alive(value.pid)
          ? "incomplete"
          : value.status,
      callStartedAt: value.callStartedAt,
      recordingStartedAt: value.recordingStartedAt,
      recordingEndedAt: value.recordingEndedAt,
      endedAt: value.endedAt,
      durationMs: value.durationMs,
      recordedMs: value.recordedMs,
      stoppedBy: value.stoppedBy,
      consent: value.consent,
      keepUntil: value.keepUntil,
      parts: value.parts,
      missing: value.missing,
    };
  }

  /**
   * Removes each call whose end date is past. A call folder with no valid
   * record goes 30 days after its folder changed. Gives the ids that went.
   */
  prune(): string[] {
    const removed: string[] = [];
    const now = this.now();
    for (const id of this.ids()) {
      const folder = join(this.root, id);
      const record = this.record(id);
      let until = Date.parse(record?.keepUntil ?? "");
      if (!Number.isFinite(until)) {
        try {
          until = lstatSync(folder).mtimeMs + 30 * DAY;
        } catch {
          continue;
        }
      }
      if (now <= until || record?.status === "recording") continue;
      rmSync(folder, { recursive: true, force: true });
      removed.push(id);
    }
    return removed;
  }

  /** Every call, newest first, after the prune. */
  list(): CallSummary[] {
    this.prune();
    return this.ids()
      .map((id) => this.record(id))
      .filter((call): call is CallSummary => call !== null);
  }

  /** One call with its transcript, or null. */
  get(id: string): { call: CallSummary; transcript: Turn[] } | null {
    const call = this.record(id);
    if (!call) return null;
    const bytes = this.readOwnerFile(
      join(this.root, id, "transcript.json"),
      16 << 20,
    );
    let transcript: Turn[] = [];
    if (bytes) {
      try {
        const parsed = transcriptSchema.safeParse(
          JSON.parse(bytes.toString("utf8")),
        );
        if (parsed.success) transcript = parsed.data.turns;
      } catch {
        /* A transcript that is not valid shows as empty. */
      }
    }
    return { call, transcript };
  }

  /** One part of a call that its record names, as a safe file, or null. */
  file(id: string, name: string): CallFile | null {
    if (!PART_FILE.test(name)) return null;
    const call = this.record(id);
    if (!call?.parts.some((part) => part.file === name)) return null;
    const path = join(this.root, id, name);
    try {
      const stat = lstatSync(path);
      if (!safeFile(stat)) return null;
      return { name, path, size: stat.size, type: contentType(name) };
    } catch {
      return null;
    }
  }

  /** Every file of one call that can be served. */
  files(id: string): CallFile[] {
    const call = this.record(id);
    if (!call) return [];
    return [...new Set(call.parts.map((part) => part.file))]
      .map((name) => this.file(id, name))
      .filter((file): file is CallFile => file !== null);
  }

  /** Removes one call and every file in it. False when there is no such call. */
  delete(id: string): boolean {
    if (!CALL_ID.test(id) || this.problem()) return false;
    const folder = join(this.root, id);
    try {
      if (!safeFolder(lstatSync(folder))) return false;
    } catch {
      return false;
    }
    rmSync(folder, { recursive: true, force: true });
    return true;
  }
}

/** Opens a safe file for reading, checked again once it is open. */
export function openCallFile(
  file: CallFile,
  range?: { start: number; end: number },
) {
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stat = fstatSync(fd);
  if (!safeFile(stat)) {
    closeSync(fd);
    throw new RecordingsError("The file is not safe to read.");
  }
  return createReadStream("", {
    fd,
    ...(range ? { start: range.start, end: range.end } : {}),
  });
}

/** DOS time and date of a moment, for the zip headers. */
function dosTime(at: Date) {
  return {
    time:
      (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date:
      ((Math.max(1980, at.getFullYear()) - 1980) << 9) |
      ((at.getMonth() + 1) << 5) |
      at.getDate(),
  };
}

async function fileCrc(path: string) {
  let value = 0;
  for await (const chunk of createReadStream(path))
    value = crc32(chunk as Buffer, value);
  return value;
}

/**
 * A zip of files, with no compression (audio and video do not get smaller).
 * Each file is read twice: once for its checksum, once for its bytes. Files of
 * 4 GB or more are refused: they need a format that this writer does not make.
 */
export async function* zipFiles(
  files: { name: string; path: string; size: number }[],
  at = new Date(),
): AsyncGenerator<Buffer> {
  const { time, date } = dosTime(at);
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    if (file.size >= 0xffffffff)
      throw new RecordingsError("A file is too large for a zip.");
    const name = Buffer.from(file.name, "utf8");
    const crc = await fileCrc(file.path);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(file.size, 18);
    local.writeUInt32LE(file.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    yield Buffer.concat([local, name]);
    let sent = 0;
    for await (const chunk of createReadStream(file.path)) {
      sent += (chunk as Buffer).length;
      yield chunk as Buffer;
    }
    if (sent !== file.size)
      throw new RecordingsError("A file changed while the zip was made.");
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(file.size, 20);
    entry.writeUInt32LE(file.size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([entry, name]));
    offset += 30 + name.length + file.size;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([directory, end]);
}

/** The files of one call for its zip: the record, then each part. */
export function zipList(recordings: Recordings, id: string) {
  const call = join(recordings.root, id, "call.json");
  const stat = lstatSync(call);
  if (!safeFile(stat))
    throw new RecordingsError("The call record is not safe to read.");
  return [
    { name: `${id}/call.json`, path: call, size: stat.size },
    ...recordings.files(id).map((file) => ({
      name: `${id}/${file.name}`,
      path: file.path,
      size: file.size,
    })),
  ];
}

/** A short plain duration: 1 min 05 s, or 42 s. */
export function plainDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return "not known";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes
    ? `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`
    : `${seconds} s`;
}
