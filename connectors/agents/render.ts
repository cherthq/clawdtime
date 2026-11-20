import type {
  AgentSession,
  AgentState,
  BoardSnapshot,
  StateDetail,
} from "./types.js";

export const detailLabels: Record<StateDetail, string> = {
  permission_prompt: "permission needed",
  question: "question for you",
  plan_review: "plan to review",
  turn_running: "working",
  tool_running: "running a tool",
  background_shell: "background shell",
  turn_complete: "done",
  turn_failed: "stopped on an error",
  turn_interrupted: "interrupted",
  input_prompt: "ready",
  session_started: "ready",
  no_signal: "no state signal",
  unrecognized: "state not recognized",
};

const stateLabels: Record<AgentState, string> = {
  needs_you: "NEEDS YOU",
  working: "WORKING",
  idle: "IDLE",
  unknown: "UNKNOWN",
};
const stateColors: Record<AgentState, string> = {
  needs_you: "33;1",
  working: "36",
  idle: "2",
  unknown: "2",
};

/** 45s, 12m, 3h 05m, 2d 04h. */
export function elapsed(since: number | null, now: number) {
  if (since === null) return "";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours < 24) return `${hours}h ${pad(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`;
}

export function where(session: AgentSession) {
  const { terminal } = session;
  if (session.mode === "background") return "background";
  if (terminal.remote) return `remote ${terminal.tty ?? ""}`.trim();
  const tmux = terminal.tmux
    ? `tmux ${terminal.tmux.session}:${terminal.tmux.window}.${terminal.tmux.pane}`
    : null;
  return (
    [terminal.app, tmux ?? terminal.tty].filter(Boolean).join(" · ") || "-"
  );
}

export const title = (session: AgentSession) => session.name ?? session.project;

/** Terminal text from names is data: no control characters reach the screen. */
const safe = (value: string) => value.replace(/\p{C}/gu, " ");
const fit = (value: string, width: number) => {
  const characters = [...safe(value)];
  return characters.length <= width
    ? characters.join("").padEnd(width)
    : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
};

export function summary(counts: BoardSnapshot["counts"]) {
  const parts = [
    counts.needs_you
      ? `${counts.needs_you} ${counts.needs_you === 1 ? "needs" : "need"} you`
      : null,
    counts.working ? `${counts.working} working` : null,
    counts.idle ? `${counts.idle} idle` : null,
    counts.unknown ? `${counts.unknown} unknown` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no agent sessions";
}

export interface RenderOptions {
  color: boolean;
  /** Terminal width in columns. */
  width: number;
  now: number;
  /** Index of the row under the cursor, for the watch view. */
  selected?: number;
}

export function renderBoard(snapshot: BoardSnapshot, options: RenderOptions) {
  const paint = (code: string, value: string) =>
    options.color ? `\u001b[${code}m${value}\u001b[0m` : value;
  const width = Math.max(60, Math.min(options.width, 160));
  // Fixed columns, then the name and place share what is left.
  const fixed = 2 + 10 + 13 + 9 + 20 + 4;
  const flexible = Math.max(24, width - fixed);
  const nameWidth = Math.max(12, Math.floor(flexible * 0.45));
  const placeWidth = Math.max(12, flexible - nameWidth);
  const lines = [paint("1", `Agents  ${summary(snapshot.counts)}`), ""];
  snapshot.sessions.forEach((session, index) => {
    const cursor = options.selected === index ? paint("1", "›") : " ";
    const row = [
      fit(stateLabels[session.state], 9),
      fit(session.agentLabel, 12),
      fit(title(session), nameWidth),
      fit(elapsed(session.since, options.now), 8),
      fit(detailLabels[session.detail], 19),
      fit(where(session), placeWidth),
    ].join(" ");
    lines.push(`${cursor} ${paint(stateColors[session.state], row.trimEnd())}`);
  });
  if (!snapshot.sessions.length)
    lines.push("  Start a coding agent in a terminal and it appears here.");
  return lines.join("\n");
}
