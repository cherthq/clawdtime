/**
 * The task that ClawdTime owns for the person, as the agent they talk to sees
 * it. The task service keeps the task and every receipt; this is only a small
 * door to it. Each change carries an event id, so one turn of the conversation
 * acts once however often it is tried.
 */
export interface TaskFacts {
  goal: string;
  /** The task service's own word for where the task is. */
  state: string;
  summary: string;
  /** What the task asks the person, when it waits for an answer. */
  question: string | null;
  /** The answers it offers for that question. */
  choices: string[];
  canAnswer: boolean;
  canAccept: boolean;
  canCancel: boolean;
}
export interface TaskResult {
  ok: boolean;
  /** One plain sentence: what happened, or why nothing did. */
  message: string;
}
export interface TaskPort {
  /** The current task, or null when there is none. */
  current(): TaskFacts | null;
  /** True when a new task can start now. */
  canStart(): boolean;
  start(goal: string, eventId: string): Promise<TaskResult>;
  answer(text: string, eventId: string): Promise<TaskResult>;
  accept(eventId: string): Promise<TaskResult>;
  cancel(eventId: string): Promise<TaskResult>;
  /**
   * True when the task service runs with no coding worker: a task there is
   * recorded and nothing works on it. Absent: not known.
   */
  simulated?(): boolean;
}

/** The part of the desktop task service that this door uses. */
export interface DesktopTasks {
  snapshot(credential: string): {
    canSubmit: boolean;
    /** Who works on a task: "simulation" means that nobody does. */
    worker?: string;
    task: {
      id: string;
      runId: string;
      revision: number;
      goal: string;
      state: string;
      summary: string;
      decision: { question: string; options?: string[] } | null;
      canDecide: boolean;
      canAccept: boolean;
      canCancel: boolean;
    } | null;
  };
  submit(
    credential: string,
    input: unknown,
  ): Promise<{ state: string; message: string }>;
}

const stateWords: Record<string, string> = {
  queued: "waiting to run",
  running: "running",
  verifying: "being checked",
  needs_decision: "waiting for your answer",
  walkthrough_ready: "ready to show you",
  in_call: "on a call with you",
  review_ready: "ready for your review",
  review_call: "on a review call with you",
  accepted: "accepted",
  canceled: "canceled",
  failed: "failed",
};
const finished = new Set(["accepted", "canceled", "failed"]);

/** Where the task is, in words that can be said aloud. */
export function taskStateWords(state: string) {
  return stateWords[state] ?? state.replace(/_/g, " ");
}
/** True once the task is over: accepted, canceled or failed. */
export function taskIsOver(task: TaskFacts) {
  return finished.has(task.state);
}

/**
 * The door over the desktop task service that runs in this process. The
 * service's own capability stays here: the agent that talks never holds it.
 */
export function deskTasks(desktop: DesktopTasks, credential: string): TaskPort {
  const view = () => {
    try {
      return desktop.snapshot(credential);
    } catch {
      return null;
    }
  };
  const send = async (input: Record<string, unknown>): Promise<TaskResult> => {
    try {
      const done = await desktop.submit(credential, input);
      return { ok: done.state === "done", message: done.message };
    } catch (error) {
      // The service names a refusal in one fixed sentence. Anything else stays unnamed.
      const refused =
        error instanceof Error &&
        typeof (error as { status?: unknown }).status === "number";
      return {
        ok: false,
        message: refused
          ? (error as Error).message
          : "The task service did not take that.",
      };
    }
  };
  const bound = (action: string, eventId: string, extra = {}) => {
    const task = view()?.task;
    if (!task)
      return Promise.resolve({ ok: false, message: "No task is active." });
    return send({
      eventId,
      action,
      taskId: task.id,
      runId: task.runId,
      expectedRevision: task.revision,
      ...extra,
    });
  };
  return {
    current() {
      const task = view()?.task;
      if (!task) return null;
      return {
        goal: task.goal,
        state: task.state,
        summary: task.summary,
        question: task.decision?.question ?? null,
        choices: task.decision?.options ?? [],
        canAnswer: task.canDecide,
        canAccept: task.canAccept,
        canCancel: task.canCancel,
      };
    },
    canStart: () => view()?.canSubmit === true,
    start: (goal, eventId) => send({ eventId, action: "submit", goal }),
    answer: (text, eventId) => bound("decide", eventId, { instruction: text }),
    accept: (eventId) => bound("accept", eventId),
    cancel: (eventId) => bound("cancel", eventId),
    simulated: () => view()?.worker === "simulation",
  };
}
