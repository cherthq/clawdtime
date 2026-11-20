import { basename, join } from "node:path";
import { identify } from "./catalog.js";
import {
  claudeEvidence,
  claudeListing,
  cleanName,
  observeClaude,
  observeCodex,
  observePi,
  reduce,
  type Candidate,
  type Observations,
} from "./evidence.js";
import {
  ancestors,
  processTree,
  readProcesses,
  readWorkingDirectories,
} from "./processes.js";
import type { System } from "./system.js";
import { observeHooks } from "./hooks.js";
import {
  appVersion,
  focusPrecision,
  locate,
  readTmux,
  tmuxServers,
} from "./terminals.js";
import {
  stateRank,
  type AgentSession,
  type AgentState,
  type BoardSnapshot,
} from "./types.js";

export interface ScanOptions {
  /** Also list one-shot runs that have no person at a terminal. */
  includeHeadless?: boolean;
}

const sessionId = (pid: number, startedAt: number | null) =>
  `${pid}-${Math.floor((startedAt ?? 0) / 1000).toString(36)}`;

/** The newest sign of life in the evidence, never in the future. None: no key at all. */
const signOfLife = (evidence: { alive?: number }[], now: number) => {
  const newest = Math.max(0, ...evidence.map((item) => item.alive ?? 0));
  return newest > 0 ? { activeAt: Math.min(now, Math.floor(newest)) } : {};
};

const projectName = (cwd: string | null, home: string) =>
  !cwd ? "-" : cwd === home ? "~" : (basename(cwd) || "/").slice(0, 120);

/** Longest wait first, longest run first, most recently finished first. */
export function order(left: AgentSession, right: AgentSession) {
  const rank = stateRank[left.state] - stateRank[right.state];
  if (rank) return rank;
  // A session that only waits for a background shell comes after active turns.
  const background =
    Number(left.detail === "background_shell") -
    Number(right.detail === "background_shell");
  if (background) return background;
  const direction = left.state === "idle" ? -1 : 1;
  const leftSince = left.since ?? left.startedAt ?? 0;
  const rightSince = right.since ?? right.startedAt ?? 0;
  return (
    direction * (leftSince - rightSince) || left.id.localeCompare(right.id)
  );
}

export function countStates(sessions: AgentSession[]) {
  const counts: Record<AgentState, number> = {
    needs_you: 0,
    working: 0,
    idle: 0,
    unknown: 0,
  };
  for (const session of sessions) counts[session.state]++;
  return counts;
}

/**
 * One scanner serves one-shot listings and the long-running publisher. It
 * keeps the Claude Code listing for a short time, because that listing starts
 * a process and background sessions change slowly.
 */
export class BoardScanner {
  private listing: {
    at: number;
    records: Record<string, unknown>[] | null;
  } | null = null;
  private readonly appVersions = new Map<string, string | null>();
  constructor(
    private readonly system: System,
    private readonly options: ScanOptions = {},
  ) {}

  private claude(maxAgeMs: number) {
    const now = this.system.now();
    if (!this.listing || now - this.listing.at > maxAgeMs)
      this.listing = { at: now, records: claudeListing(this.system) };
    return this.listing.records;
  }

  private versionOf(appPath: string | null) {
    if (!appPath) return null;
    if (!this.appVersions.has(appPath))
      this.appVersions.set(appPath, appVersion(this.system, appPath));
    return this.appVersions.get(appPath) ?? null;
  }

  scan(intervalMs: number | null = null): BoardSnapshot {
    const system = this.system;
    const now = system.now();
    const tree = processTree(readProcesses(system));
    const found = new Map<number, Candidate>();
    for (const process of tree.byPid.values()) {
      const identity = identify(process);
      if (!identity) continue;
      if (identity.headless && !this.options.includeHeadless) continue;
      found.set(process.pid, { process, ...identity, cwd: null });
    }
    // A launcher and the binary it starts are one session: keep the launcher.
    // The binary starts at once and runs the same way. A run that a session
    // starts later, or a one-shot under an interactive session, is its own.
    for (const candidate of [...found.values()]) {
      const launcher = ancestors(tree, candidate.process.pid, 3).find(
        (process) => {
          const parent = found.get(process.pid);
          return (
            parent?.kind === candidate.kind &&
            parent.headless === candidate.headless &&
            process.tty === candidate.process.tty &&
            Math.abs(
              (candidate.process.startedAt ?? 0) - (process.startedAt ?? 0),
            ) <= 10_000
          );
        },
      );
      if (launcher) found.delete(candidate.process.pid);
    }
    const candidates = [...found.values()];
    const directories = readWorkingDirectories(
      system,
      candidates.map((candidate) => candidate.process.pid),
    );
    for (const candidate of candidates)
      candidate.cwd = directories.get(candidate.process.pid) ?? null;

    const of = (...kinds: string[]) =>
      candidates.filter((candidate) => kinds.includes(candidate.kind));
    const observations: Observations = new Map();
    for (const reader of [
      observeClaude(system, of("claude-code"), () => this.claude(0)),
      observeCodex(system, of("codex")),
      observePi(
        system,
        system.env.PI_CODING_AGENT_DIR || join(system.home, ".pi", "agent"),
        of("pi"),
      ),
      observePi(system, join(system.home, ".dexter", "agent"), of("dexter")),
      observeHooks(system, tree, candidates),
    ])
      for (const [pid, observation] of reader) {
        const known = observations.get(pid);
        observations.set(pid, {
          evidence: [...(known?.evidence ?? []), ...observation.evidence],
          name: known?.name ?? observation.name ?? null,
          version: known?.version ?? observation.version ?? null,
        });
      }

    const pids = candidates.map((candidate) => candidate.process.pid);
    const tmux = readTmux(system, tmuxServers(tree, pids));
    const sessions: AgentSession[] = candidates.map((candidate) => {
      const { process } = candidate;
      const observation = observations.get(process.pid);
      const state = reduce(observation?.evidence ?? [], now);
      const terminal = locate(tree, tmux, process);
      const parent = ancestors(tree, process.pid).find((ancestor) =>
        found.has(ancestor.pid),
      );
      return {
        id: sessionId(process.pid, process.startedAt),
        pid: process.pid,
        agent: candidate.kind,
        agentLabel: candidate.label,
        agentVersion: observation?.version ?? null,
        name: observation?.name ?? null,
        project: projectName(candidate.cwd, system.home),
        cwd: candidate.cwd?.slice(0, 4096) ?? null,
        mode: candidate.headless ? "headless" : "interactive",
        state: state.state,
        detail: state.detail,
        since: state.since,
        ...signOfLife(observation?.evidence ?? [], now),
        source: state.source,
        startedAt: process.startedAt,
        spawnedBy: parent ? sessionId(parent.pid, parent.startedAt) : null,
        terminal,
        focus: candidate.headless
          ? "none"
          : focusPrecision(terminal, this.versionOf(terminal.appPath)),
      };
    });

    // Claude Code background sessions have no terminal process of their own.
    // The supported listing is their only source, so they come from there.
    if (candidates.some((candidate) => candidate.kind === "claude-code"))
      for (const record of this.claude(15_000) ?? []) {
        if (record.kind !== "background" || typeof record.id !== "string")
          continue;
        if (!/^[0-9A-Za-z_-]{1,24}$/.test(record.id)) continue;
        const state = claudeEvidence(record, now);
        const cwd = typeof record.cwd === "string" ? record.cwd : null;
        sessions.push({
          id: `bg-${record.id.toLowerCase()}`,
          pid: null,
          agent: "claude-code",
          agentLabel: "Claude Code",
          agentVersion: null,
          name: cleanName(record.name),
          project: projectName(cwd, system.home),
          cwd: cwd?.slice(0, 4096) ?? null,
          mode: "background",
          state: state.state,
          detail: state.detail,
          since: state.since,
          ...signOfLife([state], now),
          source: state.source,
          startedAt:
            typeof record.startedAt === "number" && record.startedAt > 0
              ? Math.floor(record.startedAt)
              : null,
          spawnedBy: null,
          terminal: {
            tty: null,
            app: null,
            appPath: null,
            tmux: null,
            remote: false,
          },
          focus: "none",
        });
      }

    sessions.sort(order);
    return {
      version: 1,
      generatedAt: now,
      intervalMs,
      counts: countStates(sessions),
      sessions: sessions.slice(0, 500),
    };
  }
}
