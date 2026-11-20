import { join } from "node:path";
import type { ProcessFact } from "./processes.js";
import type { System } from "./system.js";
import type { AgentKind, StateDetail, StateEvidence } from "./types.js";

/** A found session before its state is known. */
export interface Candidate {
  process: ProcessFact;
  kind: AgentKind;
  label: string;
  headless: boolean;
  cwd: string | null;
}
export interface Observation {
  evidence: StateEvidence[];
  name?: string | null;
  version?: string | null;
}
export type Observations = Map<number, Observation>;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const epoch = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** Names come from the person or the agent: bound them and drop control characters. */
export const cleanName = (value: unknown) => {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\p{C}|\p{Zl}|\p{Zp}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 80) : null;
};
const iso = (value: unknown) => {
  if (typeof value !== "string" || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 ? time : null;
};

// ---------------------------------------------------------------- Claude Code

const waitingDetail: Record<string, StateDetail> = {
  "permission prompt": "permission_prompt",
  "sandbox request": "permission_prompt",
  "input needed": "question",
  "worker request": "question",
  "dialog open": "question",
};

/**
 * One record of the Claude Code session listing. The fields are the ones
 * `claude agents --json` documents (status busy, waiting, idle, and waitingFor),
 * plus the status time that the per-process file carries. "shell" is the
 * per-process file's word for "only a background shell runs"; the listing
 * command reports it as busy.
 */
export function claudeEvidence(
  record: Record<string, unknown>,
  observedAt: number,
): StateEvidence {
  const at =
    epoch(record.statusUpdatedAt) ?? epoch(record.updatedAt) ?? observedAt;
  const since = epoch(record.statusUpdatedAt);
  const seen = Math.max(
    epoch(record.statusUpdatedAt) ?? 0,
    epoch(record.updatedAt) ?? 0,
  );
  const evidence = (
    state: StateEvidence["state"],
    detail: StateDetail,
  ): StateEvidence => ({
    state,
    detail,
    since,
    source: "registry",
    at,
    ...(seen ? { alive: seen } : {}),
  });
  const status = record.status ?? record.state;
  switch (status) {
    case "busy":
    case "working":
      return evidence("working", "turn_running");
    case "shell":
      return evidence("working", "background_shell");
    case "waiting":
    case "blocked":
      return evidence(
        "needs_you",
        (typeof record.waitingFor === "string" &&
          waitingDetail[record.waitingFor]) ||
          "question",
      );
    case "idle":
    case "done":
      return evidence("idle", "turn_complete");
    case "failed":
      return evidence("idle", "turn_failed");
    case "stopped":
      return evidence("idle", "turn_interrupted");
    default:
      return evidence("unknown", "unrecognized");
  }
}

export const claudeHome = (system: System) =>
  system.env.CLAUDE_CONFIG_DIR || join(system.home, ".claude");

/**
 * When a Claude Code session last wrote to its own session file. Only the
 * file's time is read, never its text. The file is named after the session and
 * sits in a folder named after the working directory.
 */
export function claudeSessionFileTime(
  system: System,
  record: Record<string, unknown>,
): number | null {
  const { sessionId, cwd } = record;
  if (typeof sessionId !== "string" || !/^[0-9A-Za-z-]{8,64}$/.test(sessionId))
    return null;
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4096)
    return null;
  const stat = system.stat(
    join(
      claudeHome(system),
      "projects",
      cwd.replace(/[^A-Za-z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    ),
  );
  return stat?.isFile ? Math.floor(stat.mtimeMs) : null;
}

/** The record's evidence, with the session file's time as one more sign of life. */
function claudeObserved(
  system: System,
  record: Record<string, unknown>,
  now: number,
): StateEvidence {
  const evidence = claudeEvidence(record, now);
  const written = claudeSessionFileTime(system, record);
  return written === null
    ? evidence
    : { ...evidence, alive: Math.max(evidence.alive ?? 0, written) };
}

/** The supported listing. null when the command is missing or its output is not a list. */
export function claudeListing(
  system: System,
): Record<string, unknown>[] | null {
  const result = system.run("claude", ["agents", "--json"], {
    timeoutMs: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const value = parse(result.stdout);
  if (!Array.isArray(value)) return null;
  const records: Record<string, unknown>[] = [];
  for (const entry of value.slice(0, 500)) {
    const record = object(entry);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Reads each Claude Code process's own status file first: it is one small read
 * and it carries the time of the last status change. A process with no usable
 * file falls back to the supported `claude agents --json` listing.
 */
export function observeClaude(
  system: System,
  candidates: Candidate[],
  listing: () => Record<string, unknown>[] | null,
): Observations {
  const result: Observations = new Map();
  const missing: Candidate[] = [];
  const now = system.now();
  for (const candidate of candidates) {
    const { pid, startedAt } = candidate.process;
    const record = object(
      parse(
        system.readText(
          join(claudeHome(system), "sessions", `${pid}.json`),
          65_536,
        ),
      ),
    );
    const registered = record ? epoch(record.startedAt) : null;
    // A file older than the process belongs to an earlier process with this pid.
    const stale =
      registered !== null &&
      startedAt !== null &&
      registered < startedAt - 5000;
    if (!record || record.pid !== pid || stale) {
      missing.push(candidate);
      continue;
    }
    result.set(pid, {
      evidence: [claudeObserved(system, record, now)],
      name: cleanName(record.name),
      version: cleanName(record.version)?.slice(0, 40) ?? null,
    });
  }
  if (missing.length) {
    const records = listing() ?? [];
    for (const candidate of missing) {
      const record = records.find(
        (entry) => entry.pid === candidate.process.pid,
      );
      if (record)
        result.set(candidate.process.pid, {
          evidence: [claudeObserved(system, record, now)],
          name: cleanName(record.name),
        });
    }
  }
  return result;
}

// ------------------------------------------------- session files (transcripts)

interface SessionFile {
  path: string;
  createdAt: number;
  mtimeMs: number;
}

/**
 * Chooses the session file of each process in one working directory. A file
 * belongs to the newest process that had started when the file was created.
 * A process that owns none (it resumed an older session) takes the most
 * recently changed unclaimed file that changed after the process started.
 * This is an inference, so the evidence is marked as read from the transcript.
 */
export function assignFiles(processes: ProcessFact[], files: SessionFile[]) {
  const result = new Map<number, SessionFile>();
  const byStart = [...processes].sort(
    (left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0),
  );
  // Oldest file first, so each process ends with the newest file it owns.
  for (const file of [...files].sort(
    (left, right) => left.createdAt - right.createdAt,
  )) {
    let owner: ProcessFact | undefined;
    for (const process of byStart)
      if ((process.startedAt ?? 0) <= file.createdAt + 2000) owner = process;
    if (owner) result.set(owner.pid, file);
  }
  const claimed = new Set([...result.values()].map((file) => file.path));
  for (const process of byStart) {
    if (result.has(process.pid)) continue;
    const resumed = files
      .filter(
        (file) =>
          !claimed.has(file.path) &&
          file.mtimeMs >= (process.startedAt ?? Infinity),
      )
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (resumed) {
      result.set(process.pid, resumed);
      claimed.add(resumed.path);
    }
  }
  return result;
}

const lastRecords = function* (tail: string) {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const record = object(parse(line));
    if (record) yield record;
  }
};

// ------------------------------------------------------------------ pi, dexter

/** pi names a session directory after the working directory: / becomes -. */
export const piDirectory = (cwd: string) =>
  `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

const piFileTime = (name: string) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[0-9a-f-]{8,64}\.jsonl$/.exec(
      name,
    );
  if (!match) return null;
  const [year, month, day, hour, minute, second, ms] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number, number];
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
};

/** The last message of a pi session file decides the state. Text is never read out. */
export function piEvidence(
  tail: string,
  mtimeMs: number,
): StateEvidence | null {
  for (const record of lastRecords(tail)) {
    if (record.type !== "message") continue;
    const message = object(record.message);
    if (!message) continue;
    const since = iso(record.timestamp);
    // The record's own time orders this against hook events of the same session.
    const evidence = (state: StateEvidence["state"], detail: StateDetail) =>
      ({
        state,
        detail,
        since,
        source: "transcript",
        at: since ?? mtimeMs,
        // The file changes with every message, also in the middle of a turn.
        alive: Math.floor(Math.max(since ?? 0, mtimeMs)),
      }) satisfies StateEvidence;
    if (message.role !== "assistant")
      return evidence("working", "turn_running");
    switch (message.stopReason) {
      case "toolUse":
        return evidence("working", "tool_running");
      case "error":
        return evidence("idle", "turn_failed");
      case "aborted":
        return evidence("idle", "turn_interrupted");
      default:
        return evidence("idle", "turn_complete");
    }
  }
  return null;
}

export function observePi(
  system: System,
  agentHome: string,
  candidates: Candidate[],
): Observations {
  const result: Observations = new Map();
  const byDirectory = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidate.cwd) continue;
    const group = byDirectory.get(candidate.cwd);
    if (group) group.push(candidate);
    else byDirectory.set(candidate.cwd, [candidate]);
  }
  for (const [cwd, group] of byDirectory) {
    const directory = join(agentHome, "sessions", piDirectory(cwd));
    const earliest = Math.min(
      ...group.map((candidate) => candidate.process.startedAt ?? 0),
    );
    const files: SessionFile[] = [];
    for (const name of system.list(directory)) {
      const createdAt = piFileTime(name);
      if (createdAt === null) continue;
      const path = join(directory, name);
      const stat = system.stat(path);
      // A file that last changed before every process started is not live.
      if (!stat?.isFile || stat.mtimeMs < earliest - 2000) continue;
      files.push({ path, createdAt, mtimeMs: stat.mtimeMs });
    }
    const assigned = assignFiles(
      group.map((candidate) => candidate.process),
      files,
    );
    for (const [pid, file] of assigned) {
      const tail = system.readTail(file.path, 262_144);
      const evidence = tail === null ? null : piEvidence(tail, file.mtimeMs);
      if (evidence) result.set(pid, { evidence: [evidence] });
    }
  }
  return result;
}

// ----------------------------------------------------------------------- Codex

const codexFileTime = (name: string) => {
  // The file name carries local time: rollout-2026-11-18T11-54-22-<uuid>.jsonl
  const match =
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-[0-9a-f-]{8,64}\.jsonl$/.exec(
      name,
    );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number) as [number, number, number, number, number, number];
  return new Date(year, month - 1, day, hour, minute, second).getTime();
};

const codexWaiting: Record<string, StateDetail> = {
  exec_approval_request: "permission_prompt",
  apply_patch_approval_request: "permission_prompt",
  request_permissions: "permission_prompt",
  request_user_input: "question",
  elicitation_request: "question",
};

/** The last turn event of a Codex rollout file decides the state. */
export function codexEvidence(
  tail: string,
  mtimeMs: number,
): StateEvidence | null {
  for (const record of lastRecords(tail)) {
    if (record.type !== "event_msg") continue;
    const type = object(record.payload)?.type;
    if (typeof type !== "string") continue;
    const since = iso(record.timestamp);
    // The record's own time orders this against hook events of the same session.
    const evidence = (state: StateEvidence["state"], detail: StateDetail) =>
      ({
        state,
        detail,
        since,
        source: "transcript",
        at: since ?? mtimeMs,
        // The file changes with every event, also in the middle of a turn.
        alive: Math.floor(Math.max(since ?? 0, mtimeMs)),
      }) satisfies StateEvidence;
    if (type === "task_started" || type === "turn_started")
      return evidence("working", "turn_running");
    if (type === "task_complete" || type === "turn_complete")
      return evidence("idle", "turn_complete");
    if (type === "turn_aborted") return evidence("idle", "turn_interrupted");
    const waiting = codexWaiting[type];
    if (waiting) return evidence("needs_you", waiting);
  }
  return null;
}

export const codexHome = (system: System) =>
  system.env.CODEX_HOME || join(system.home, ".codex");

const dayDirectories = (from: number, to: number) => {
  const result: string[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  // Sessions are filed under the local day they began. Ten days bounds the walk.
  for (let count = 0; count < 10 && day.getTime() <= to; count++) {
    const pad = (value: number) => String(value).padStart(2, "0");
    result.push(
      join(
        String(day.getFullYear()),
        pad(day.getMonth() + 1),
        pad(day.getDate()),
      ),
    );
    day.setDate(day.getDate() + 1);
  }
  return result;
};

export function observeCodex(
  system: System,
  candidates: Candidate[],
): Observations {
  const result: Observations = new Map();
  const live = candidates.filter(
    (candidate) => candidate.cwd && candidate.process.startedAt !== null,
  );
  if (!live.length) return result;
  const now = system.now();
  const earliest = Math.max(
    Math.min(...live.map((candidate) => candidate.process.startedAt!)),
    now - 9 * 86_400_000,
  );
  const byDirectory = new Map<string, SessionFile[]>();
  const versions = new Map<string, string>();
  for (const day of dayDirectories(earliest, now)) {
    const directory = join(codexHome(system), "sessions", day);
    for (const name of system.list(directory)) {
      const createdAt = codexFileTime(name);
      if (createdAt === null || createdAt < earliest - 2000) continue;
      const path = join(directory, name);
      const stat = system.stat(path);
      if (!stat?.isFile) continue;
      // The first record holds the working directory near its start. A bounded
      // head is enough, and the long instruction text after it is never parsed.
      const head = system.readHead(path, 4096) || system.readTail(path, 4096);
      const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head ?? "")?.[1];
      const directoryOfFile = cwd ? parse(cwd) : null;
      if (typeof directoryOfFile !== "string") continue;
      const version = /"cli_version":"([0-9A-Za-z.+-]{1,40})"/.exec(
        head ?? "",
      )?.[1];
      if (version) versions.set(path, version);
      const files = byDirectory.get(directoryOfFile);
      const file = { path, createdAt, mtimeMs: stat.mtimeMs };
      if (files) files.push(file);
      else byDirectory.set(directoryOfFile, [file]);
    }
  }
  const groups = new Map<string, Candidate[]>();
  for (const candidate of live) {
    const group = groups.get(candidate.cwd!);
    if (group) group.push(candidate);
    else groups.set(candidate.cwd!, [candidate]);
  }
  for (const [cwd, group] of groups) {
    const assigned = assignFiles(
      group.map((candidate) => candidate.process),
      byDirectory.get(cwd) ?? [],
    );
    for (const [pid, file] of assigned) {
      const tail = system.readTail(file.path, 262_144);
      const evidence = tail === null ? null : codexEvidence(tail, file.mtimeMs);
      if (evidence)
        result.set(pid, {
          evidence: [evidence],
          version: versions.get(file.path) ?? null,
        });
    }
  }
  return result;
}

// ---------------------------------------------------------------------- reduce

const rank: Record<StateEvidence["source"], number> = {
  hook: 0,
  registry: 1,
  process: 2,
  transcript: 3,
};

/**
 * The newest evidence wins. At the same instant the agent's own report wins
 * over what is read from its files. With no evidence the state is unknown: the
 * board never turns a busy or quiet processor into a claim about the agent.
 */
export function reduce(
  evidence: StateEvidence[],
  observedAt: number,
): StateEvidence {
  let best: StateEvidence | undefined;
  for (const item of evidence)
    if (
      !best ||
      item.at > best.at ||
      (item.at === best.at && rank[item.source] < rank[best.source])
    )
      best = item;
  return (
    best ?? {
      state: "unknown",
      detail: "no_signal",
      since: null,
      source: "process",
      at: observedAt,
    }
  );
}
