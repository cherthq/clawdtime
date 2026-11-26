/**
 * Computer use: routines.
 *
 * A routine is one request of the owner that the worker gets at a time of
 * day: "every morning at 9, follow up on my latest X posts and tell me". At
 * its time the routine hands the request to the worker as the owner's own
 * words, and texts the owner the result when the request ends. When the
 * request needs the owner on its way, the reach calls or texts at once.
 *
 * Rules that are code here:
 *
 * - Off until the owner adds one. With no routine, nothing is read or run.
 * - A routine starts only when no other request runs and no call is live on
 *   the line. Then it waits once, a few minutes, and when the way is still
 *   not free it skips that time and says so by text.
 * - A time that passed long ago (the Mac slept, the service was stopped) is
 *   not run late, also after a wait for the way. The next time counts.
 * - The request goes to the worker as put off, with the owner's whole
 *   sentence: they said it earlier, so it says no yes ahead of time.
 * - The id of each run is made from the routine and its time, so the same
 *   time never starts a second request, also from a second process.
 * - The file is `computer/routines.json` in the state folder, for its owner
 *   only. It holds the request in the owner's words, never one that looks
 *   like a password or a key.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DesktopExecutionSnapshot } from "../../src/control/desktop-executor.js";
import { secureRead, secureWrite } from "../shared/state.js";
import {
  computerDirectory,
  looksSecretStrict,
  type JournalRequest,
} from "./journal.js";
import type { ReachTextPort } from "./reach.js";

const dayNames = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
const everyDay = [0, 1, 2, 3, 4, 5, 6];
const workDays = [1, 2, 3, 4, 5];
/** A routine that is busy at its time waits this long once, then skips. */
const waitMs = 5 * 60_000;
/** A time that passed this long ago is not run late. */
const staleMs = 15 * 60_000;
const requestLength = 300;
const wordsLength = 400;
const maximumRoutines = 20;

const routineSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{8}$/),
    /** The request in the owner's words. */
    request: z.string().min(1).max(requestLength),
    /**
     * The owner's whole sentence, with the schedule. The worker reads the
     * request as put off by it. A routine of an older file has none: its
     * schedule says it.
     */
    words: z.string().min(1).max(wordsLength).optional(),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    paused: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    /** The next time it runs, in milliseconds. */
    nextAt: z.number().int().nonnegative(),
    /** It was busy at its time and waits once since then. */
    waitingSince: z.number().int().nonnegative().optional(),
    lastAt: z.number().int().nonnegative().optional(),
    /** The request of its last run. */
    lastRequestId: z
      .string()
      .regex(/^[A-Za-z0-9_:-]{1,160}$/)
      .optional(),
    /** One fixed word: started, skipped_busy, missed, not_started, reported. */
    lastOutcome: z
      .string()
      .regex(/^[a-z_]{1,40}$/)
      .optional(),
    /** The run whose result was told. */
    reportedRequestId: z
      .string()
      .regex(/^[A-Za-z0-9_:-]{1,160}$/)
      .optional(),
  })
  .strict();
export type Routine = z.infer<typeof routineSchema>;
const fileSchema = z
  .object({
    version: z.literal(1),
    routines: z.array(routineSchema).max(maximumRoutines),
  })
  .strict();

export const routinesFile = (root: string) =>
  join(computerDirectory(root), "routines.json");

/** The owner's sentence, as one clean line, the way the routine reads it. */
const cleanWords = (words: string) =>
  words
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[‘’]/g, "'");

/** The schedule and the request in a sentence of the owner, or null when it is no routine. */
export function readRoutineWords(words: string): {
  request: string;
  days: number[];
  hour: number;
  minute: number;
} | null {
  const text = cleanWords(words);
  const found =
    /^(?:(?:please|pls|ok|okay|hey)[,\s]+)?(?:(?:can|could|would) you\s+)?(?:every|each)\s+(day|morning|afternoon|evening|night|weekday|workday|(?:mon|tues|wednes|thurs|fri|satur|sun)day)s?(?:\s+(?:at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?|\s+at\s+(noon|midnight))?(?:\s*[,:;.]\s*|\s+)(?:then\s+|please\s+)?(.+)$/i.exec(
      text,
    );
  if (!found) return null;
  const when = found[1]!.toLowerCase();
  const suffix = (found[4] ?? "").replace(/\./g, "").toLowerCase();
  let hour: number;
  let minute = found[3] ? Number(found[3]) : 0;
  if (found[5]) {
    hour = found[5].toLowerCase() === "noon" ? 12 : 0;
    minute = 0;
  } else if (found[2] !== undefined) {
    hour = Number(found[2]);
    if (suffix === "pm" && hour < 12) hour += 12;
    else if (suffix === "am" && hour === 12) hour = 0;
    else if (
      !suffix &&
      hour >= 1 &&
      hour <= 11 &&
      ["afternoon", "evening", "night"].includes(when)
    )
      hour += 12;
  } else {
    // Only a part of the day has a time of its own.
    const usual: Record<string, number> = {
      morning: 9,
      afternoon: 14,
      evening: 18,
      night: 21,
    };
    if (usual[when] === undefined) return null;
    hour = usual[when]!;
  }
  if (hour > 23 || minute > 59 || (suffix && Number(found[2]) > 12))
    return null;
  const named = dayNames.indexOf(when as (typeof dayNames)[number]);
  const days =
    named >= 0
      ? [named]
      : ["weekday", "workday"].includes(when)
        ? workDays
        : everyDay;
  // Each result is told by text, so "and tell me" adds nothing to the request.
  const request = found[6]!
    .replace(
      /[,\s]+(?:and\s+)?(?:then\s+)?(?:tell|text|message|ping|notify|update)\s+me(?:\s+(?:about\s+it|the\s+result|what\s+you\s+find|how\s+it\s+went))?[.!]*$/i,
      "",
    )
    .replace(/[,\s]+(?:and\s+)?let\s+me\s+know[.!]*$/i, "")
    .replace(/^to\s+/i, "")
    .trim();
  // A time that did not read as one is no request: "every morning at 9".
  if (
    /^(?:at|@)\b/i.test(request) ||
    request.split(" ").length < 2 ||
    request.length > requestLength
  )
    return null;
  return { request, days, hour, minute };
}

/** The schedule in plain words: "every day at 09:00". */
export function scheduleText(
  routine: Pick<Routine, "days" | "hour" | "minute">,
) {
  const time = `${String(routine.hour).padStart(2, "0")}:${String(routine.minute).padStart(2, "0")}`;
  const days =
    routine.days.length === 7
      ? "every day"
      : routine.days.join(",") === workDays.join(",")
        ? "every weekday"
        : `every ${routine.days.map((day) => dayNames[day]!.replace(/^./, (c) => c.toUpperCase())).join(" and ")}`;
  return `${days} at ${time}`;
}

/** The first time after `after` on one of the days, by the clock of this Mac. */
export function nextTime(
  routine: Pick<Routine, "days" | "hour" | "minute">,
  after: number,
) {
  const start = new Date(after);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      routine.hour,
      routine.minute,
      0,
      0,
    );
    if (day.getTime() > after && routine.days.includes(day.getDay()))
      return day.getTime();
  }
  // Not reached for a valid schedule: a week holds every day.
  return after + 24 * 60 * 60_000;
}

/** What the routines need of the worker: its public surface. */
export interface RoutineWorker {
  snapshot(): DesktopExecutionSnapshot;
  /** Hands over a request that the owner put off to a time, with their words of the routine. */
  submitPutOff(
    eventId: string,
    text: string,
    said: string,
  ): Promise<{ message: string }>;
}

/** The words that put the request of a routine off to its time. */
export const routineWords = (routine: Routine) =>
  routine.words ?? `${scheduleText(routine)}, ${routine.request}`;

const live = new Set(["running", "waiting_for_person", "stopping"]);
const ended = new Set(["completed", "blocked", "canceled", "uncertain"]);

export interface RoutinesOptions {
  root: string;
  worker?: RoutineWorker;
  /** Reads the state of a request after the service lost sight of it. Read only. */
  journal?: { get(id: string): JournalRequest | null };
  /** How a result reaches the owner. */
  text?: ReachTextPort;
  /** The line is in a call now: no routine starts. */
  liveCall?: () => boolean;
  /** A line in the chat, when no text can be sent. */
  notify?: (text: string) => void;
  now?: () => number;
}

/** The routines of this Mac. The command line and the service share the same file. */
export class Routines {
  private readonly now: () => number;
  private ticking = false;
  constructor(private readonly options: RoutinesOptions) {
    this.now = options.now ?? Date.now;
  }

  private load(): Routine[] {
    const file = routinesFile(this.options.root);
    if (!existsSync(file)) return [];
    return fileSchema.parse(secureRead(file)).routines;
  }
  private save(routines: Routine[]) {
    secureWrite(
      routinesFile(this.options.root),
      fileSchema.parse({ version: 1, routines }),
    );
  }

  /**
   * Writes what a round changed, over the file as it is now: a routine that
   * the command line added, paused or removed meanwhile stays as it is there.
   */
  private merge(mine: Routine[]) {
    const byId = new Map(mine.map((routine) => [routine.id, routine]));
    this.save(
      this.load().map((routine) => {
        const changed = byId.get(routine.id);
        // A pause or a new start from the command line wins over the round.
        return changed
          ? {
              ...changed,
              paused: routine.paused,
              ...(routine.nextAt !== changed.nextAt && !routine.paused
                ? { nextAt: Math.max(routine.nextAt, changed.nextAt) }
                : {}),
            }
          : routine;
      }),
    );
  }

  list(): Routine[] {
    return this.load();
  }
  /** Adds one routine from the owner's words. The answer says what was kept, or why not. */
  add(words: string): { ok: boolean; message: string; routine?: Routine } {
    const read = readRoutineWords(words);
    if (!read)
      return {
        ok: false,
        message:
          'I did not read a routine in that. Say it like this: "every morning at 9, follow up on my latest posts".',
      };
    const said = cleanWords(words);
    if (looksSecretStrict(read.request) || looksSecretStrict(said))
      return {
        ok: false,
        message:
          "That holds a password or a key, so I did not keep it. A routine never holds one.",
      };
    const routines = this.load();
    if (routines.length >= maximumRoutines)
      return {
        ok: false,
        message: `There are ${maximumRoutines} routines already. Remove one first.`,
      };
    const now = this.now();
    const same = routines.find(
      (item) =>
        item.request.toLowerCase() === read.request.toLowerCase() &&
        item.hour === read.hour &&
        item.minute === read.minute &&
        item.days.join(",") === read.days.join(","),
    );
    if (same)
      return {
        ok: true,
        routine: same,
        message: `That routine is kept already: ${scheduleText(same)}, "${same.request}".`,
      };
    const routine: Routine = {
      id: createHash("sha256")
        .update(`${now}:${read.request}:${routines.length}`)
        .digest("hex")
        .slice(0, 8),
      request: read.request,
      ...(said.length <= wordsLength ? { words: said } : {}),
      days: read.days,
      hour: read.hour,
      minute: read.minute,
      paused: false,
      createdAt: now,
      nextAt: nextTime(read, now),
    };
    this.save([...routines, routine]);
    return {
      ok: true,
      routine,
      message: `I keep a routine ${routine.id}: ${scheduleText(routine)}, "${routine.request}". I text you the result each time. Pause or remove it with: clawdtime routine pause ${routine.id}, or remove ${routine.id}.`,
    };
  }
  private change(
    id: string,
    apply: (routine: Routine, all: Routine[]) => Routine[] | null,
  ): Routine | null {
    const routines = this.load();
    const routine = routines.find(
      (item) => item.id === id.trim().toLowerCase(),
    );
    if (!routine) return null;
    const next = apply(routine, routines);
    if (next) this.save(next);
    return routine;
  }
  pause(id: string) {
    return this.change(id, (routine, all) => {
      routine.paused = true;
      delete routine.waitingSince;
      return all;
    });
  }
  resume(id: string) {
    return this.change(id, (routine, all) => {
      routine.paused = false;
      routine.nextAt = nextTime(routine, this.now());
      return all;
    });
  }
  /** Removes one routine. A request that it started already goes on: Stop stops that. */
  remove(id: string) {
    return this.change(id, (routine, all) =>
      all.filter((item) => item !== routine),
    );
  }

  /**
   * Words of the owner in the chat, on a call or by text: a routine to add,
   * the list, or a pause, a start again or a removal by id. Null for any other
   * words, which then go on as before.
   */
  fromWords(words: string): string | null {
    const text = words.replace(/\s+/g, " ").trim();
    if (
      /^(?:(?:please|pls)\s+)?(?:list|show)(?:\s+me)?\s+(?:my\s+|the\s+)?routines[.!?]*$|^(?:what|which)\s+routines\s+(?:do\s+i\s+have|are\s+there)[.!?]*$/i.test(
        text,
      )
    ) {
      const routines = this.list();
      return routines.length
        ? routines.map((routine) => this.line(routine)).join("\n")
        : "There is no routine yet.";
    }
    const by =
      /^(?:(?:please|pls)\s+)?(pause|resume|remove|delete)\s+(?:the\s+)?routine\s+([a-f0-9]{8})[.!]*$/i.exec(
        text,
      );
    if (by) {
      const verb = by[1]!.toLowerCase();
      const routine =
        verb === "pause"
          ? this.pause(by[2]!)
          : verb === "resume"
            ? this.resume(by[2]!)
            : this.remove(by[2]!);
      if (!routine) return `There is no routine ${by[2]!.toLowerCase()}.`;
      return verb === "pause"
        ? `Paused routine ${routine.id}. A request that it started goes on.`
        : verb === "resume"
          ? `Routine ${routine.id} runs again: ${scheduleText(routine)}.`
          : `Removed routine ${routine.id}. A request that it started goes on.`;
    }
    if (!readRoutineWords(text)) return null;
    return this.add(text).message;
  }

  /** One routine as one line. */
  line(routine: Routine) {
    const next = new Date(routine.nextAt);
    const at = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")} ${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
    return `${routine.id}  ${scheduleText(routine)}  ${routine.paused ? "paused" : `next ${at}`}  "${routine.request}"${routine.lastOutcome ? `  last: ${routine.lastOutcome.replace(/_/g, " ")}` : ""}`;
  }

  /** The request id of a run, from the routine and its time. */
  static runId(routine: Pick<Routine, "id">, at: number) {
    return `routine_${routine.id}_${at.toString(36)}`;
  }

  private async tell(routine: Routine, key: string, words: string) {
    const text = `Routine "${routine.request.slice(0, 120)}" (${scheduleText(routine)}): ${words}`;
    const port = this.options.text;
    let sent = false;
    try {
      if (port?.readiness().ready) {
        const outcome = await port.send(key, text);
        sent = outcome === "sent" || outcome === "already_sent";
      }
    } catch {
      sent = false;
    }
    if (!sent)
      try {
        this.options.notify?.(text);
      } catch {
        // A line that could not be shown changes nothing.
      }
  }

  /** One round: tell the results that came, then start what is due. One start at most. */
  async tick() {
    if (this.ticking || !this.options.worker) return;
    this.ticking = true;
    try {
      let routines: Routine[];
      try {
        routines = this.load();
      } catch {
        return;
      }
      if (!routines.length) return;
      const worker = this.options.worker;
      let snapshot: DesktopExecutionSnapshot;
      try {
        snapshot = worker.snapshot();
      } catch {
        return;
      }
      const now = this.now();
      let changed = false;
      for (const routine of routines) {
        const id = routine.lastRequestId;
        if (!id || routine.reportedRequestId === id) continue;
        let message: string | null = null;
        if (snapshot.requestId === id && ended.has(snapshot.state))
          message = snapshot.message;
        else if (snapshot.requestId !== id) {
          // The service no longer sees it: the journal says how it ended.
          const kept = (() => {
            try {
              return this.options.journal?.get(id) ?? null;
            } catch {
              return null;
            }
          })();
          if (kept && ended.has(kept.state))
            message = `It ended as ${kept.state.replace(/_/g, " ")}.`;
          else if (!kept) message = null;
        }
        if (message === null) continue;
        routine.reportedRequestId = id;
        routine.lastOutcome = "reported";
        changed = true;
        await this.tell(routine, `clawdtime-routine:${id}`, message);
      }
      const busy = () => {
        let call = false;
        try {
          call = this.options.liveCall?.() ?? false;
        } catch {
          call = true;
        }
        return (
          call ||
          live.has(snapshot.state) ||
          snapshot.state === "uncertain" ||
          snapshot.canStop
        );
      };
      for (const routine of routines) {
        if (routine.paused || now < routine.nextAt) continue;
        // Also after a wait for the way: a time is never run hours late.
        if (now - routine.nextAt > staleMs) {
          delete routine.waitingSince;
          routine.lastOutcome = "missed";
          routine.nextAt = nextTime(routine, now);
          changed = true;
          continue;
        }
        if (busy()) {
          if (routine.waitingSince === undefined) {
            routine.waitingSince = now;
            changed = true;
            continue;
          }
          if (now - routine.waitingSince < waitMs) continue;
          const at = routine.nextAt;
          delete routine.waitingSince;
          routine.lastOutcome = "skipped_busy";
          routine.nextAt = nextTime(routine, now);
          changed = true;
          await this.tell(
            routine,
            `clawdtime-routine:${Routines.runId(routine, at)}:skipped`,
            "I skipped it this time: another task or a call was running.",
          );
          continue;
        }
        const runId = Routines.runId(routine, routine.nextAt);
        delete routine.waitingSince;
        routine.lastAt = now;
        routine.nextAt = nextTime(routine, now);
        // Written before the start: a second process sees that this time is taken.
        routine.lastRequestId = runId;
        routine.lastOutcome = "started";
        this.merge(routines);
        changed = false;
        let answer = "";
        try {
          answer = (
            await worker.submitPutOff(
              runId,
              routine.request,
              routineWords(routine),
            )
          ).message;
        } catch {
          answer = "It could not start.";
        }
        const started = (() => {
          try {
            return this.options.journal
              ? this.options.journal.get(runId) !== null
              : worker.snapshot().requestId === runId;
          } catch {
            return false;
          }
        })();
        if (!started) {
          routine.lastOutcome = "not_started";
          routine.reportedRequestId = runId;
          changed = true;
          await this.tell(
            routine,
            `clawdtime-routine:${runId}:not_started`,
            `It did not start. ${answer}`.trim(),
          );
        }
        break;
      }
      if (changed) this.merge(routines);
    } finally {
      this.ticking = false;
    }
  }
}
