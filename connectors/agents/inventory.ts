import { join } from "node:path";
import { catalog } from "./catalog.js";
import { claudeHome, codexHome } from "./evidence.js";
import type { System } from "./system.js";
import type { AgentKind, BoardSnapshot } from "./types.js";

/** One coding-agent command on this Mac: is it installed, which version, how much it is used. */
export interface CliFact {
  kind: AgentKind;
  label: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Sessions on disk, when this agent keeps them where ClawdTime can count them. */
  sessions: number | null;
  sessionsLast7Days: number | null;
  lastUsedAt: number | null;
  runningNow: number;
}

const week = 7 * 86_400_000;

function findProgram(system: System, name: string) {
  for (const directory of (system.env.PATH ?? "").split(":")) {
    if (!directory.startsWith("/")) continue;
    const candidate = join(directory, name);
    if (system.stat(candidate)?.isFile) return candidate;
  }
  return null;
}

interface Usage {
  sessions: number;
  recent: number;
  last: number | null;
}
const empty = (): Usage => ({ sessions: 0, recent: 0, last: null });
function count(usage: Usage, time: number | null, now: number) {
  usage.sessions++;
  if (time === null) return;
  if (now - time <= week) usage.recent++;
  if (usage.last === null || time > usage.last) usage.last = time;
}

/** Claude Code: one transcript file for each session, in a folder for each project. */
function claudeUsage(system: System, now: number): Usage {
  const usage = empty();
  const root = join(claudeHome(system), "projects");
  let looked = 0;
  for (const project of system.list(root)) {
    for (const name of system.list(join(root, project))) {
      if (!name.endsWith(".jsonl")) continue;
      // The file's last change is the session's last use. The walk is bounded.
      const stat =
        looked++ < 6000 ? system.stat(join(root, project, name)) : null;
      count(usage, stat?.isFile ? stat.mtimeMs : null, now);
    }
  }
  return usage;
}

/** Codex: one rollout file for each session, filed by the day it began. The name carries the time. */
function codexUsage(system: System, now: number): Usage {
  const usage = empty();
  const root = join(codexHome(system), "sessions");
  for (const year of system.list(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of system.list(join(root, year))) {
      for (const day of system.list(join(root, year, month))) {
        for (const name of system.list(join(root, year, month, day))) {
          const match =
            /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(
              name,
            );
          if (!match) continue;
          const [y, mo, d, h, mi, s] = match.slice(1).map(Number) as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          count(usage, new Date(y, mo - 1, d, h, mi, s).getTime(), now);
        }
      }
    }
  }
  return usage;
}

/** pi and dexter: one file for each session, in a folder for each working directory. */
function piUsage(system: System, agentHome: string, now: number): Usage {
  const usage = empty();
  const root = join(agentHome, "sessions");
  for (const directory of system.list(root)) {
    for (const name of system.list(join(root, directory))) {
      const match =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
      if (!match) continue;
      const [y, mo, d, h, mi, s, ms] = match.slice(1).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      count(usage, Date.UTC(y, mo - 1, d, h, mi, s, ms), now);
    }
  }
  return usage;
}

/**
 * Every agent command of the catalog that is installed or running, with its
 * version and its use. Counting reads file names and times only, never a transcript.
 */
export function inventory(
  system: System,
  snapshot: BoardSnapshot | null,
): CliFact[] {
  const now = system.now();
  const running = new Map<AgentKind, number>();
  for (const session of snapshot?.sessions ?? [])
    running.set(session.agent, (running.get(session.agent) ?? 0) + 1);
  const result: CliFact[] = [];
  for (const entry of catalog) {
    const path = findProgram(system, entry.names[0]!);
    const runningNow = running.get(entry.kind) ?? 0;
    if (!path && !runningNow) continue;
    let version: string | null = null;
    if (path) {
      const output = system.run(path, ["--version"], {
        timeoutMs: 4000,
        maxBuffer: 65_536,
      });
      const line =
        output.status === 0 ? output.stdout.split("\n")[0]!.trim() : "";
      version = /\d/.test(line)
        ? line.replace(/\p{C}/gu, "").slice(0, 40)
        : null;
    }
    const usage =
      entry.kind === "claude-code"
        ? claudeUsage(system, now)
        : entry.kind === "codex"
          ? codexUsage(system, now)
          : entry.kind === "pi"
            ? piUsage(
                system,
                system.env.PI_CODING_AGENT_DIR ||
                  join(system.home, ".pi", "agent"),
                now,
              )
            : entry.kind === "dexter"
              ? piUsage(system, join(system.home, ".dexter", "agent"), now)
              : null;
    result.push({
      kind: entry.kind,
      label: entry.label,
      installed: path !== null,
      path,
      version,
      sessions: usage?.sessions ?? null,
      sessionsLast7Days: usage?.recent ?? null,
      lastUsedAt: usage?.last ?? null,
      runningNow,
    });
  }
  // Most used in the last week first.
  return result.sort(
    (left, right) =>
      (right.sessionsLast7Days ?? -1) - (left.sessionsLast7Days ?? -1) ||
      right.runningNow - left.runningNow ||
      left.label.localeCompare(right.label),
  );
}
