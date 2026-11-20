import { z } from "zod";

/**
 * The agent board: every coding-agent CLI session on this Mac, what it is doing
 * and where it lives on screen. The board is read-only towards the agents. It
 * never stores prompts, replies, tool input or screen text: only structural
 * facts (state, times, names, paths, process identities).
 */
export const agentKinds = [
  "claude-code",
  "codex",
  "pi",
  "dexter",
  "amp",
  "gemini",
  "opencode",
  "aider",
  "cursor-agent",
  "goose",
  "crush",
  "qwen",
  "copilot",
  "droid",
] as const;
export type AgentKind = (typeof agentKinds)[number];

/** needs_you: blocked on the human. working: a turn runs. idle: waits for the next instruction. */
export const agentStates = ["needs_you", "working", "idle", "unknown"] as const;
export type AgentState = (typeof agentStates)[number];

export const stateDetails = [
  "permission_prompt",
  "question",
  "plan_review",
  "turn_running",
  "tool_running",
  "background_shell",
  "turn_complete",
  "turn_failed",
  "turn_interrupted",
  "input_prompt",
  "session_started",
  "no_signal",
  "unrecognized",
] as const;
export type StateDetail = (typeof stateDetails)[number];

/**
 * hook and registry are the agent's own report. transcript is read from the
 * agent's session file. process is what the operating system shows.
 */
export const stateSources = [
  "hook",
  "registry",
  "transcript",
  "process",
] as const;
export type StateSource = (typeof stateSources)[number];

export interface StateEvidence {
  state: AgentState;
  detail: StateDetail;
  /** When this state began (epoch ms), when the source records it. */
  since: number | null;
  source: StateSource;
  /** When the source last changed (epoch ms). Newer evidence replaces older. */
  at: number;
}

const text = (max: number) => z.string().max(max);
const epoch = z.number().int().nonnegative();

const ttyName = z.string().regex(/^[A-Za-z0-9]{1,24}$/);

export const tmuxLocationSchema = z
  .object({
    session: text(200),
    window: z.number().int().nonnegative(),
    pane: z.number().int().nonnegative(),
    paneId: z.string().regex(/^%\d{1,9}$/),
    /** How to reach the tmux server: empty, or -S path, or -L name. */
    socketArgs: z.array(text(1024)).max(2),
    /** The terminal of a client attached to this session, when one is. */
    clientTty: ttyName.nullable(),
  })
  .strict();

export const terminalSchema = z
  .object({
    tty: ttyName.nullable(),
    app: text(120).nullable(),
    appPath: text(1024).nullable(),
    tmux: tmuxLocationSchema.nullable(),
    remote: z.boolean(),
  })
  .strict();
export type TerminalLocation = z.infer<typeof terminalSchema>;

/**
 * interactive: a person works in its terminal. headless: a one-shot run with
 * no person at the terminal. background: a session its agent runs detached.
 */
export const sessionModes = ["interactive", "headless", "background"] as const;
export type SessionMode = (typeof sessionModes)[number];

export const focusPrecisions = ["tab", "pane", "app", "none"] as const;
export type FocusPrecision = (typeof focusPrecisions)[number];

export const agentSessionSchema = z
  .object({
    /** Stable for the life of the session: pid plus its start second. */
    id: z.string().regex(/^[0-9a-z][0-9a-z_-]{1,40}$/),
    /** null for a session that has no terminal process, such as a background one. */
    pid: z.number().int().positive().nullable(),
    agent: z.enum(agentKinds),
    agentLabel: text(40),
    agentVersion: text(40).nullable(),
    name: text(80).nullable(),
    project: text(120),
    cwd: text(4096).nullable(),
    mode: z.enum(sessionModes),
    state: z.enum(agentStates),
    detail: z.enum(stateDetails),
    since: epoch.nullable(),
    source: z.enum(stateSources),
    startedAt: epoch.nullable(),
    /** Session id of the agent that started this one, when one did. */
    spawnedBy: z.string().max(40).nullable(),
    terminal: terminalSchema,
    focus: z.enum(focusPrecisions),
  })
  .strict();
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const boardSnapshotSchema = z
  .object({
    version: z.literal(1),
    generatedAt: epoch,
    /** Publishing interval. A reader treats a much older snapshot as stale. */
    intervalMs: z.number().int().positive().max(600_000).nullable(),
    counts: z
      .object({
        needs_you: z.number().int().nonnegative(),
        working: z.number().int().nonnegative(),
        idle: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict(),
    sessions: z.array(agentSessionSchema).max(500),
  })
  .strict();
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

export const stateRank: Record<AgentState, number> = {
  needs_you: 0,
  working: 1,
  idle: 2,
  unknown: 3,
};
