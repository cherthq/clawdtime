import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { secureWrite } from "../shared/state.js";
import type { Candidate, Observations } from "./evidence.js";
import type { ProcessTree } from "./processes.js";
import type { System } from "./system.js";
import {
  agentKinds,
  agentStates,
  stateDetails,
  type AgentKind,
  type AgentState,
  type StateDetail,
  type StateEvidence,
} from "./types.js";

/**
 * Hook events are for agents whose files do not show that they wait for the
 * person. Codex is the first: it does not write an approval request to its
 * session file. The receiver keeps one small file for each session, with the
 * state and the time. It never stores the prompt, the reply or tool input.
 */
const eventSchema = z
  .object({
    version: z.literal(1),
    agent: z.enum(agentKinds),
    state: z.enum(agentStates),
    detail: z.enum(stateDetails),
    since: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
    cwd: z.string().max(4096).nullable(),
    /** The hook's parent, grandparent and great-grandparent processes. */
    pids: z.array(z.number().int().positive()).max(3),
  })
  .strict();
export type HookEvent = z.infer<typeof eventSchema>;

export const stateRoot = (system: Pick<System, "env" | "home">) =>
  system.env.CLAWDTIME_CONFIG_HOME ||
  join(system.home, ".local", "share", "clawdtime");
export const eventsDirectory = (root: string) => join(root, "agents", "events");

const working = (detail: StateDetail) =>
  ({ state: "working", detail }) as const;
const needsYou = (detail: StateDetail) =>
  ({ state: "needs_you", detail }) as const;
const idle = (detail: StateDetail) => ({ state: "idle", detail }) as const;

/** Maps one hook payload to a state. "ended" removes the session's record. */
export function hookState(
  input: Record<string, unknown>,
): { state: AgentState; detail: StateDetail } | "ended" | null {
  switch (input.hook_event_name) {
    case "SessionStart":
      return idle("session_started");
    case "UserPromptSubmit":
    case "BeforeAgent":
      return working("turn_running");
    case "PreToolUse":
      // Claude Code asks its questions and shows its plan through tools.
      if (input.tool_name === "AskUserQuestion") return needsYou("question");
      if (input.tool_name === "ExitPlanMode") return needsYou("plan_review");
      return working("tool_running");
    case "PostToolUse":
    case "PostToolUseFailure":
    case "BeforeTool":
    case "AfterTool":
      return working("tool_running");
    case "PermissionRequest":
      return needsYou("permission_prompt");
    case "Notification":
      switch (input.notification_type) {
        case "permission_prompt":
        case "ToolPermission":
          return needsYou("permission_prompt");
        case "elicitation_dialog":
        case "agent_needs_input":
          return needsYou("question");
        case "idle_prompt":
          return idle("turn_complete");
        default:
          return null;
      }
    case "Stop":
    case "AfterAgent":
      return idle("turn_complete");
    case "StopFailure":
      return idle("turn_failed");
    case "Interrupt":
      return idle("turn_interrupted");
    case "SessionEnd":
      return "ended";
    default:
      return null;
  }
}

const eventFile = (root: string, agent: AgentKind, sessionId: string) =>
  join(
    eventsDirectory(root),
    `${agent}.${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`,
  );

function readEvent(file: string): HookEvent | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) return null;
    return eventSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Records one hook payload. Hooks of one session run as separate processes
 * and can finish out of order, so a record never replaces a newer one.
 */
export function receiveHook(options: {
  root: string;
  agent: AgentKind;
  input: unknown;
  /** When this hook process started (epoch ms). */
  at: number;
  pids: number[];
}): "recorded" | "removed" | "ignored" {
  const input =
    options.input !== null &&
    typeof options.input === "object" &&
    !Array.isArray(options.input)
      ? (options.input as Record<string, unknown>)
      : null;
  const sessionId = input?.session_id;
  if (!input || typeof sessionId !== "string" || !sessionId) return "ignored";
  if (sessionId.length > 200) return "ignored";
  const next = hookState(input);
  if (!next) return "ignored";
  const file = eventFile(options.root, options.agent, sessionId);
  if (next === "ended") {
    if (existsSync(file) && lstatSync(file).isFile()) rmSync(file);
    return "removed";
  }
  const previous = readEvent(file);
  if (previous && previous.at > options.at) return "ignored";
  const cwd = typeof input.cwd === "string" ? input.cwd.slice(0, 4096) : null;
  secureWrite(file, {
    version: 1,
    agent: options.agent,
    state: next.state,
    detail: next.detail,
    since:
      previous?.state === next.state && previous.detail === next.detail
        ? previous.since
        : options.at,
    at: options.at,
    cwd,
    pids: options.pids
      .filter((pid) => Number.isInteger(pid) && pid > 1)
      .slice(0, 3),
  } satisfies HookEvent);
  return "recorded";
}

/** The ancestors of this process, nearest first, from one process listing. */
export function hookAncestors(listing: string, pid: number, limit = 3) {
  const parents = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  const result: number[] = [];
  let current = parents.get(pid);
  while (current && current > 1 && result.length < limit) {
    if (result.includes(current)) break;
    result.push(current);
    current = parents.get(current);
  }
  return result;
}

const descendantOf = (tree: ProcessTree, pid: number, roots: Set<number>) => {
  const seen = new Set<number>();
  let current = tree.byPid.get(pid)?.ppid;
  while (current && current > 1 && !seen.has(current)) {
    if (roots.has(current)) return true;
    seen.add(current);
    current = tree.byPid.get(current)?.ppid;
  }
  return false;
};

/**
 * Reads the hook records and gives each to the session that owns it: the
 * session whose process is an ancestor of the hook, or else the only session
 * of that agent in the same working directory.
 */
export function observeHooks(
  system: System,
  tree: ProcessTree,
  candidates: Candidate[],
): Observations {
  const result: Observations = new Map();
  const directory = eventsDirectory(stateRoot(system));
  const names = system.list(directory).filter((name) => name.endsWith(".json"));
  for (const name of names.slice(0, 500)) {
    let event: HookEvent;
    try {
      event = eventSchema.parse(
        JSON.parse(system.readText(join(directory, name), 8192) ?? ""),
      );
    } catch {
      continue;
    }
    const sameAgent = candidates.filter(
      (candidate) =>
        candidate.kind === event.agent &&
        // A record older than the process belongs to an earlier process.
        (candidate.process.startedAt ?? 0) <= event.at + 5000,
    );
    const inDirectory = sameAgent.filter(
      (candidate) => candidate.cwd !== null && candidate.cwd === event.cwd,
    );
    const owner =
      sameAgent.find((candidate) =>
        event.pids.includes(candidate.process.pid),
      ) ?? (inDirectory.length === 1 ? inDirectory[0] : undefined);
    if (!owner || result.has(owner.process.pid)) continue;
    const evidence: StateEvidence[] = [
      {
        state: event.state,
        detail: event.detail,
        since: event.since,
        source: "hook",
        at: event.at,
      },
    ];
    if (event.detail === "permission_prompt") {
      // No hook fires when the person approves. A tool process that started
      // under the agent after the request shows that the approval was given.
      const roots = new Set(
        [owner.process.pid, ...event.pids].filter((pid) => tree.byPid.has(pid)),
      );
      let started: number | null = null;
      for (const process of tree.byPid.values()) {
        if (roots.has(process.pid) || process.startedAt === null) continue;
        if (process.startedAt <= event.at) continue;
        if (/agent-hook\.[jt]s/.test(process.command)) continue;
        if (!descendantOf(tree, process.pid, roots)) continue;
        if (started === null || process.startedAt < started)
          started = process.startedAt;
      }
      if (started !== null)
        evidence.push({
          state: "working",
          detail: "tool_running",
          since: started,
          source: "process",
          at: started,
        });
    }
    result.set(owner.process.pid, { evidence });
  }
  return result;
}

// ------------------------------------------------------------ Codex hooks file

/** Events that change what the board shows. PreToolUse is left out on purpose:
 * it fires just before PermissionRequest, and the two would race. */
export const codexHookEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The exact command string. Install and uninstall recognise the entry by it. */
export const hookCommand = (node: string, script: string, agent: AgentKind) =>
  `${quote(node)} ${quote(script)} ${agent}`;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;

function parseHooksFile(text: string | undefined): Json {
  if (text === undefined || !text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      "The hooks file is not valid JSON. It is unchanged; repair it first.",
    );
  }
  const root = record(value);
  if (!root || (root.hooks !== undefined && !record(root.hooks)))
    throw new Error("The hooks file has an unexpected shape. It is unchanged.");
  return root;
}

const isOwnGroup = (group: unknown, command: string) => {
  const hooks = record(group)?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.length === 1 &&
    record(hooks[0])?.command === command
  );
};

/** Which of the events already run the command. */
export function installedHookEvents(text: string | undefined, command: string) {
  const hooks = record(parseHooksFile(text).hooks) ?? {};
  return codexHookEvents.filter((event) => {
    const groups = hooks[event];
    return (
      Array.isArray(groups) &&
      groups.some((group) => isOwnGroup(group, command))
    );
  });
}

/** Adds one group for each event. Every other key and group stays as it is. */
export function installHooks(text: string | undefined, command: string) {
  const root = parseHooksFile(text);
  const hooks = { ...(record(root.hooks) ?? {}) };
  for (const event of codexHookEvents) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing))
      throw new Error(
        "The hooks file has an unexpected shape. It is unchanged.",
      );
    const groups = existing ?? [];
    if (groups.some((group) => isOwnGroup(group, command))) continue;
    hooks[event] = [
      ...groups,
      // async: the agent never waits for the board. The receiver prints nothing.
      { hooks: [{ type: "command", command, timeout: 5, async: true }] },
    ];
  }
  return `${JSON.stringify({ ...root, hooks }, null, 2)}\n`;
}

/** Removes only the groups that hold exactly the command. */
export function uninstallHooks(text: string, command: string) {
  const root = parseHooksFile(text);
  const hooks = { ...(record(root.hooks) ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((group) => !isOwnGroup(group, command));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return `${JSON.stringify({ ...root, hooks }, null, 2)}\n`;
}
