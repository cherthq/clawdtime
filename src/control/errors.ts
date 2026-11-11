export type ControlPreflightCode =
  | "planning_refused"
  | "planner_unavailable"
  | "planning_timeout"
  | "frame_unavailable"
  | "screen_changed"
  | "invalid_plan"
  | "stopped"
  | "context_expired";

const messages: Record<ControlPreflightCode, string> = {
  planning_refused: "The requested screen action needs clarification.",
  planner_unavailable: "The screen action planner is unavailable.",
  planning_timeout: "Screen action planning timed out.",
  frame_unavailable: "A fresh screen frame is required.",
  screen_changed: "The screen changed while planning.",
  invalid_plan: "The proposed screen action is invalid.",
  stopped: "Screen control was stopped.",
  context_expired: "The active call or yielded agent context is unavailable.",
};

/** Only trusted local pre-dispatch code raises this. Never wrap input dispatch failures. */
export class ControlPreflightError extends Error {
  constructor(readonly code: ControlPreflightCode) {
    super(messages[code]);
    this.name = "ControlPreflightError";
  }
}
