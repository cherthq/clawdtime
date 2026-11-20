import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import { elapsed, title } from "./render.js";
import {
  hostNameSchema,
  type AgentSession,
  type AgentState,
  type BoardSnapshot,
} from "./types.js";

/**
 * The watcher. The board says what each session does now. The watcher follows
 * every session from one scan to the next and reports the four things a person
 * wants to hear about without looking: a session that has waited for them too
 * long, one that works but shows no sign of life, one that ended badly, and
 * work that is done.
 *
 * It only reads. It never sends input to a session and never answers anything.
 * An incident holds structure and names, as the board does: never a prompt, a
 * reply, tool input or command arguments.
 */
export const incidentKinds = [
  "waiting",
  "stalled",
  "failed",
  "finished",
] as const;
export type IncidentKind = (typeof incidentKinds)[number];

const epoch = z.number().int().nonnegative();
export const incidentSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[0-9a-f]{12}$/),
    kind: z.enum(incidentKinds),
    sessionId: z.string().regex(/^[0-9a-z][0-9a-z_-]{1,63}$/),
    title: z.string().max(80),
    agentLabel: z.string().max(40),
    /** The remote Mac of the session. Absent for a session of this Mac. */
    host: hostNameSchema.optional(),
    /** When the condition began: the wait, the silence, the end of the work. */
    since: epoch,
    /** How long the work ran, when the incident is about its end and that is known. */
    workedMs: epoch.nullable(),
    /** `failed` only. gone: its process ended. error: its own evidence says it stopped on one. */
    cause: z.enum(["gone", "error"]).nullable(),
    raisedAt: epoch,
  })
  .strict();
export type Incident = z.infer<typeof incidentSchema>;

export const watchRulesSchema = z
  .object({
    version: z.literal(1),
    /** A session needs the person for this long: that is a decision point. */
    waitSeconds: z.number().int().min(30).max(86_400),
    /** A session works and shows no sign of life for this long: it may hang. */
    stallSeconds: z.number().int().min(30).max(86_400),
    /** Work shorter than this ends with no word. */
    finishedSeconds: z.number().int().min(30).max(86_400),
    /** The kinds that may place a call in away mode. */
    callOn: z.array(z.enum(incidentKinds)).max(4),
  })
  .strict();
export type WatchRules = z.infer<typeof watchRulesSchema>;
export const defaultRules: WatchRules = {
  version: 1,
  waitSeconds: 120,
  stallSeconds: 600,
  finishedSeconds: 180,
  callOn: ["waiting", "failed"],
};

/** An ended incident stays in view this long, unless the person dismisses it. */
const shownMs = 10 * 60_000;
const urgency: Record<IncidentKind, number> = {
  failed: 0,
  waiting: 1,
  stalled: 2,
  finished: 3,
};

/** One plain sentence for the person. The time in it is counted at `now`. */
export function incidentSentence(incident: Incident, now: number) {
  const who = `${incident.title}${incident.host ? ` on ${incident.host}` : ""}`;
  const worked =
    incident.workedMs === null ? "" : elapsed(0, incident.workedMs);
  switch (incident.kind) {
    case "waiting":
      return `${who} has waited for you for ${elapsed(incident.since, now)}.`;
    case "stalled":
      return `${who} has shown no sign of life for ${elapsed(incident.since, now)}.`;
    case "failed":
      return incident.cause === "error"
        ? `${who} stopped on an error${worked ? ` after ${worked}` : ""}.`
        : `${who} is gone: its process ended in the middle of its work.`;
    case "finished":
      return `${who} is done${worked ? ` after ${worked}` : ""}.`;
  }
}

export interface IncidentsView {
  version: 1;
  incidents: (Incident & { text: string })[];
}
export const incidentsView = (
  incidents: Incident[],
  now: number,
): IncidentsView => ({
  version: 1,
  incidents: incidents.map((incident) => ({
    ...incident,
    text: incidentSentence(incident, now),
  })),
});

const text = (file: string) => {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)
    return null;
  return readFileSync(file, "utf8");
};

const logEntrySchema = z
  .object({
    at: epoch,
    event: z.enum(["raised", "cleared", "dismissed"]),
    incident: incidentSchema,
  })
  .strict();
export type IncidentLogEntry = z.infer<typeof logEntrySchema>;

/** The watcher's files, owner only: its rules, the open incidents and a bounded log. */
export class WatchStore {
  private readonly directory: string;
  constructor(root: string) {
    this.directory = join(root, "agents");
  }
  private file(name: string) {
    return join(this.directory, name);
  }

  /** The rules. A file that is missing or not valid gives the defaults. */
  rules(): WatchRules {
    try {
      const raw = text(this.file("watch.json"));
      return raw === null
        ? defaultRules
        : watchRulesSchema.parse(JSON.parse(raw));
    } catch {
      return defaultRules;
    }
  }
  /**
   * Changes one rule. wait, stall and finished take seconds, or a number with
   * s, m or h. call takes the kinds, with commas, or none.
   */
  setRule(key: string, value: string): WatchRules {
    const rules = { ...this.rules() };
    if (key === "call") {
      const kinds =
        value === "none" ? [] : value.split(",").map((item) => item.trim());
      const unknown = kinds.find(
        (kind) => !(incidentKinds as readonly string[]).includes(kind),
      );
      if (unknown !== undefined)
        throw new Error(
          `"${unknown}" is not a kind. Use: ${incidentKinds.join(", ")}, or none.`,
        );
      rules.callOn = [...new Set(kinds)] as IncidentKind[];
    } else {
      const field = (
        {
          wait: "waitSeconds",
          stall: "stallSeconds",
          finished: "finishedSeconds",
        } as const
      )[key];
      if (!field)
        throw new Error("The rules are: wait, stall, finished and call.");
      const match = /^(\d{1,6})([smh]?)$/.exec(value.trim());
      if (!match) throw new Error("Give a time such as 90, 90s, 5m or 1h.");
      const seconds =
        Number(match[1]) *
        (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
      if (seconds < 30)
        throw new Error(
          "A limit under 30 seconds would fire on every pause. Give 30 seconds or more.",
        );
      if (seconds > 86_400) throw new Error("The longest limit is one day.");
      rules[field] = seconds;
    }
    secureWrite(this.file("watch.json"), watchRulesSchema.parse(rules));
    return rules;
  }

  saveOpen(incidents: Incident[], at: number) {
    secureWrite(this.file("watch-open.json"), {
      version: 1,
      updatedAt: at,
      incidents,
    });
  }
  private saved(): { updatedAt: number; incidents: Incident[] } | null {
    try {
      const raw = text(this.file("watch-open.json"));
      if (raw === null) return null;
      return z
        .object({
          version: z.literal(1),
          updatedAt: epoch,
          incidents: z.array(incidentSchema).max(200),
        })
        .strict()
        .parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  /**
   * The open incidents as the running watcher last wrote them. `live`: it wrote
   * within the last 45 seconds. Without a live watcher nothing is shown as open.
   */
  readOpen(now: number): { live: boolean; incidents: Incident[] } {
    const value = this.saved();
    const live = value !== null && now - value.updatedAt <= 45_000;
    return { live, incidents: live ? value.incidents : [] };
  }
  /** What a watcher that starts takes over: every incident that was raised, live writer or not. */
  inherited(): Incident[] {
    return this.saved()?.incidents ?? [];
  }

  log(event: IncidentLogEntry["event"], incident: Incident, at: number) {
    const file = this.file("incidents.jsonl");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
    }
    appendFileSync(file, `${JSON.stringify({ at, event, incident })}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
    // The log is bounded: past 600 lines it is cut back to the last 500.
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > 600)
      writeFileSync(file, `${lines.slice(-500).join("\n")}\n`, { mode: 0o600 });
  }
  /** The newest entries of the log, newest first. A line that does not parse is skipped. */
  recent(limit = 20): IncidentLogEntry[] {
    const raw = text(this.file("incidents.jsonl"));
    if (raw === null) return [];
    const result: IncidentLogEntry[] = [];
    for (const line of raw.split("\n").reverse()) {
      if (!line.trim()) continue;
      try {
        result.push(logEntrySchema.parse(JSON.parse(line)));
      } catch {
        continue;
      }
      if (result.length >= limit) break;
    }
    return result;
  }
}

const kindLabels: Record<IncidentKind, string> = {
  failed: "FAILED",
  waiting: "WAITING",
  stalled: "STALLED",
  finished: "DONE",
};
const kindColors: Record<IncidentKind, string> = {
  failed: "31;1",
  waiting: "33;1",
  stalled: "33",
  finished: "32",
};
/** The incidents as lines for a terminal. Names are data: no control characters reach the screen. */
export function renderIncidents(
  incidents: Incident[],
  options: { color: boolean; now: number },
) {
  return incidents
    .map((incident) => {
      const label = kindLabels[incident.kind].padEnd(8);
      return `  ${options.color ? `\u001b[${kindColors[incident.kind]}m${label}\u001b[0m` : label} ${incidentSentence(incident, options.now).replace(/\p{C}/gu, " ")}`;
    })
    .join("\n");
}

const span = (seconds: number) =>
  seconds % 3600 === 0
    ? `${seconds / 3600}h`
    : seconds % 60 === 0
      ? `${seconds / 60}m`
      : `${seconds}s`;
/** The rules in words, for `clawdtime agents watch-rules`. */
export function renderRules(rules: WatchRules) {
  return [
    "Watch rules",
    `  wait      ${span(rules.waitSeconds).padEnd(6)} a session that needs you for this long is reported`,
    `  stall     ${span(rules.stallSeconds).padEnd(6)} a session that works with no sign of life for this long is reported`,
    `  finished  ${span(rules.finishedSeconds).padEnd(6)} work shorter than this ends with no word`,
    `  call      ${rules.callOn.length ? rules.callOn.join(", ") : "none"}: the kinds that may place a call in away mode`,
    "Change one: clawdtime agents watch-rules set wait 5m",
  ].join("\n");
}

interface Track {
  session: AgentSession;
  state: AgentState;
  /** When this run of work began. Null while it does not work. */
  workSince: number | null;
  /** When it began to need the person. Null while it does not. */
  waitSince: number | null;
  /** Scans in a row in which the session was not on the board. */
  missed: number;
}

export interface WatcherOptions {
  now: () => number;
  /** The rules, read for each scan. The default is the store's, or the defaults. */
  rules?: () => WatchRules;
  /** Whether a process of this Mac still runs. Tests script it. */
  exists?: (pid: number) => boolean;
  /** With a store the open incidents and the log are written. Without one nothing is. */
  store?: WatchStore;
}

const processExists = (pid: number) => {
  try {
    // Signal 0 sends nothing: it only asks whether the process is there.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Follows the sessions over the scans and keeps the open incidents. */
export class Watcher {
  private readonly tracks = new Map<string, Track>();
  private readonly current = new Map<string, Incident>();
  /** Every incident ever raised here: an incident is raised once. */
  private readonly raisedIds = new Set<string>();
  private savedAt = 0;
  constructor(private readonly options: WatcherOptions) {
    // Ended news that was in view before a restart stays in view for the rest of
    // its time. A wait or a stall is found again from the board itself.
    const now = options.now();
    for (const incident of options.store?.inherited() ?? []) {
      this.raisedIds.add(incident.id);
      if (
        (incident.kind === "failed" || incident.kind === "finished") &&
        now - incident.raisedAt < shownMs
      )
        this.current.set(incident.id, incident);
    }
  }

  private rules() {
    return (
      this.options.rules?.() ?? this.options.store?.rules() ?? defaultRules
    );
  }

  /** The open incidents, most urgent first, then the oldest first. */
  open(): Incident[] {
    return [...this.current.values()].sort(
      (left, right) =>
        urgency[left.kind] - urgency[right.kind] ||
        left.since - right.since ||
        left.id.localeCompare(right.id),
    );
  }

  /** The person has seen it. It is not raised again. */
  dismiss(id: string) {
    const incident = this.current.get(id);
    if (!incident) return false;
    this.current.delete(id);
    const now = this.options.now();
    this.options.store?.log("dismissed", incident, now);
    this.save(now, true);
    return true;
  }

  private save(now: number, changed: boolean) {
    // Also written now and then with no change, so a reader knows the watcher lives.
    if (!this.options.store || (!changed && now - this.savedAt < 10_000))
      return;
    try {
      this.options.store.saveOpen(this.open(), now);
      this.savedAt = now;
    } catch {
      // A state folder that cannot be written loses the file, not the watch.
    }
  }

  /** One scan. Returns what it raised and what it cleared. */
  observe(snapshot: BoardSnapshot): {
    raised: Incident[];
    cleared: Incident[];
  } {
    const now = this.options.now();
    const rules = this.rules();
    const raised: Incident[] = [],
      cleared: Incident[] = [];
    const store = this.options.store;
    const raise = (
      kind: IncidentKind,
      session: AgentSession,
      since: number,
      more: { workedMs?: number | null; cause?: "gone" | "error" } = {},
    ) => {
      const at = Math.max(0, Math.floor(since));
      const id = createHash("sha256")
        .update(`${kind}|${session.id}|${at}`)
        .digest("hex")
        .slice(0, 12);
      if (this.raisedIds.has(id)) return;
      // One open incident of a kind for a session: a newer one takes its place.
      clear(kind, session.id);
      const incident: Incident = {
        version: 1,
        id,
        kind,
        sessionId: session.id,
        title: title(session).replace(/\p{C}/gu, " ").slice(0, 80),
        agentLabel: session.agentLabel,
        ...(session.host ? { host: session.host } : {}),
        since: at,
        workedMs:
          more.workedMs === undefined || more.workedMs === null
            ? null
            : Math.max(0, Math.floor(more.workedMs)),
        cause: more.cause ?? null,
        raisedAt: now,
      };
      this.raisedIds.add(id);
      if (this.raisedIds.size > 2000)
        this.raisedIds.delete(this.raisedIds.values().next().value!);
      this.current.set(id, incident);
      raised.push(incident);
      store?.log("raised", incident, now);
    };
    const clear = (kind: IncidentKind, sessionId: string) => {
      for (const incident of [...this.current.values()])
        if (incident.kind === kind && incident.sessionId === sessionId) {
          this.current.delete(incident.id);
          cleared.push(incident);
          store?.log("cleared", incident, now);
        }
    };

    const seen = new Set<string>();
    for (const session of snapshot.sessions) {
      // A one-shot run ends by design. Its end is not news.
      if (session.mode === "headless") continue;
      seen.add(session.id);
      const before = this.tracks.get(session.id);
      const track: Track = before ?? {
        session,
        state: "unknown",
        workSince: null,
        waitSince: null,
        missed: 0,
      };
      track.session = session;
      track.missed = 0;
      const busy = session.state === "working" || session.state === "needs_you";
      if (busy && track.workSince === null)
        track.workSince =
          (session.state === "working" ? session.since : null) ?? now;

      // A decision point: it has needed the person for too long. The agent's own
      // time of the request counts; with none, the time the watcher first saw it.
      if (session.state === "needs_you") {
        if (session.since !== null) track.waitSince = session.since;
        else if (before?.state !== "needs_you" || track.waitSince === null)
          track.waitSince = now;
        if (now - track.waitSince >= rules.waitSeconds * 1000)
          raise("waiting", session, track.waitSince);
      } else {
        track.waitSince = null;
        clear("waiting", session.id);
      }

      // A stall: it works, and nothing has moved for too long. Without a sign-of-life
      // time nothing is said. A session that only waits for a background shell is not stalled.
      if (
        session.state === "working" &&
        session.detail !== "background_shell" &&
        session.activeAt !== undefined &&
        now - session.activeAt >= rules.stallSeconds * 1000
      )
        raise("stalled", session, session.activeAt);
      else clear("stalled", session.id);

      // The end of a run of work that the watcher saw.
      if (
        session.state === "idle" &&
        track.workSince !== null &&
        (before?.state === "working" || before?.state === "needs_you")
      ) {
        const endedAt = Math.max(track.workSince, session.since ?? now);
        const workedMs = endedAt - track.workSince;
        if (session.detail === "turn_failed")
          raise("failed", session, endedAt, { workedMs, cause: "error" });
        // An interrupt is the person's own act. Short work ends with no word.
        else if (
          session.detail !== "turn_interrupted" &&
          workedMs >= rules.finishedSeconds * 1000
        )
          raise("finished", session, endedAt, { workedMs });
      }
      if (!busy) track.workSince = null;
      track.state = session.state;
      this.tracks.set(session.id, track);
    }

    // Sessions that left the board.
    const answering = new Set(
      (snapshot.hosts ?? []).filter((host) => host.ok).map((host) => host.name),
    );
    for (const [id, track] of [...this.tracks]) {
      if (seen.has(id)) continue;
      const { session } = track;
      // A remote Mac that does not answer says nothing about its sessions.
      if (session.host && !answering.has(session.host)) {
        if (!(snapshot.hosts ?? []).some((host) => host.name === session.host))
          this.forget(id, clear);
        continue;
      }
      // One scan can miss a process. Two in a row is an end.
      if (++track.missed < 2) continue;
      this.forget(id, clear);
      // Closed while idle, or never seen at work: the person put it away.
      if (track.state !== "working" && track.state !== "needs_you") continue;
      // A detached session is listed by its agent. A listing that fails is not an end.
      if (session.mode === "background") continue;
      // The process still runs: the scan lost it, the session did not die.
      if (
        !session.host &&
        session.pid !== null &&
        (this.options.exists ?? processExists)(session.pid)
      )
        continue;
      raise("failed", session, now, {
        workedMs: track.workSince === null ? null : now - track.workSince,
        cause: "gone",
      });
    }

    // An ended incident leaves the view after a fixed time.
    for (const incident of [...this.current.values()])
      if (
        (incident.kind === "failed" || incident.kind === "finished") &&
        now - incident.raisedAt >= shownMs
      ) {
        this.current.delete(incident.id);
        cleared.push(incident);
        store?.log("cleared", incident, now);
      }
    this.save(now, raised.length + cleared.length > 0);
    return { raised, cleared };
  }

  private forget(
    id: string,
    clear: (kind: IncidentKind, sessionId: string) => void,
  ) {
    this.tracks.delete(id);
    // What held only while the session was there ends with it.
    clear("waiting", id);
    clear("stalled", id);
  }
}
