/**
 * The setup protocol between the setup engine and a user interface: the
 * terminal wizard or the Mac app. One JSON object per line. docs/ONBOARDING.md
 * describes it. A secret input's value never appears in an event.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

/**
 * 2: every question carries a one-time `question` id, and every input and
 * action must name the question it answers.
 */
export const onboardProtocol = 2;

/** The steps, in order. The ids are fixed. */
export const stepIds = [
  "preflight",
  "model",
  "desktop",
  "computer",
  "permissions",
  "phone",
  "pairing",
  "connection",
  "ready",
] as const;
export type StepId = (typeof stepIds)[number];
export type StepState =
  "pending" | "in_progress" | "needs_input" | "ready" | "failed" | "skipped";

/** Only these steps accept a skip from the person. */
export const skippableSteps: ReadonlySet<StepId> = new Set([
  "phone",
  "pairing",
  "connection",
  "computer",
]);

export interface Recovery {
  label: string;
  action: "retry" | "open_settings" | "open_url";
  url?: string;
}
export interface InputOption {
  id: string;
  label: string;
  detail?: string;
}
export interface InputRequest {
  kind: "secret" | "text" | "choice" | "confirm" | "phone" | "code";
  prompt: string;
  options?: InputOption[];
  multiple?: boolean;
  /**
   * The answer gives or refuses consent: computer use, view, computer
   * actions, reports, the pairing, a replacement, a sign-in text or the
   * connection. An interface gives it no default answer.
   */
  consent?: boolean;
}
export interface StepEvent {
  type: "step";
  id: StepId;
  state: StepState;
  title: string;
  /** Plain words for the person. It names no file path. */
  detail?: string;
  /**
   * Lines that an interface shows only when the person asks for them, such
   * as the full path of each binary that needs a permission.
   */
  details?: string[];
  recovery?: Recovery;
  input?: InputRequest;
  /**
   * The one-time id of the question that this event asks: on `needs_input`,
   * and on `failed` when the step waits for a retry or a skip. An answer
   * names it. A new question always has a new id.
   */
  question?: string;
}
export interface ReportRow {
  id: StepId;
  state: StepState;
  detail: string;
}
export type OnboardEvent =
  | { type: "hello"; protocol: number; version: string }
  | StepEvent
  | { type: "log"; level: "info" | "warn"; message: string }
  | {
      type: "done";
      ready: boolean;
      report: ReportRow[];
      /**
       * With `--app` only: a desktop service that setup started still runs
       * and no owner holds it. The app's owner takes it on Finish, and a
       * cancelled run ends it.
       */
      setupDesktop?: boolean;
    };

const stepId = z.enum(stepIds);
/** A question id: random, url-safe, used for one answer only. */
export const questionIdPattern = /^[A-Za-z0-9_-]{16,64}$/;
const questionId = z.string().regex(questionIdPattern);
export const onboardCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("input"),
      id: stepId,
      question: questionId,
      value: z.union([
        z.string().max(8192),
        z.boolean(),
        z.array(z.string().max(200)).max(32),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("action"),
      id: stepId,
      question: questionId,
      action: z.enum(["retry", "recheck", "skip"]),
    })
    .strict(),
  z.object({ type: z.literal("cancel") }).strict(),
]);
export type OnboardCommand = z.infer<typeof onboardCommandSchema>;

/** What the engine talks to: it sends events and waits for commands. */
export interface OnboardIO {
  emit(event: OnboardEvent): void;
  next(): Promise<OnboardCommand>;
  /**
   * True from the moment the person stops setup: a cancel came in, or the
   * input ended. The engine checks it before each effect, not only at a
   * question, and answers already queued behind it are not used.
   */
  cancelled(): boolean;
}

/**
 * The JSON protocol over a pair of streams: events go out as one JSON object
 * per line, commands come in the same way. A line that is not a command is
 * ignored with a fixed warning that never quotes it: it may hold a key. The
 * end of the input is a cancel. A cancel counts as soon as its line is read,
 * ahead of any command that came before it and is not used yet.
 */
export function jsonLinesIO(
  input: Readable,
  write: (line: string) => void,
): OnboardIO & { close(): void; cancel(): void } {
  const queue: OnboardCommand[] = [];
  let waiting: ((command: OnboardCommand) => void) | null = null;
  let ended = false;
  let stopped = false;
  const deliver = (command: OnboardCommand) => {
    if (command.type === "cancel") {
      stopped = true;
      queue.length = 0;
    }
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(command);
    } else queue.push(command);
  };
  const emit = (event: OnboardEvent) => write(JSON.stringify(event));
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = line.length > 16_384 ? undefined : JSON.parse(line);
    } catch {
      value = undefined;
    }
    const parsed = onboardCommandSchema.safeParse(value);
    if (parsed.success) deliver(parsed.data);
    else
      emit({
        type: "log",
        level: "warn",
        message: "A command line was not understood. It was ignored.",
      });
  });
  lines.on("close", () => {
    ended = true;
    deliver({ type: "cancel" });
  });
  return {
    emit,
    next: () =>
      stopped || ended
        ? Promise.resolve({ type: "cancel" })
        : queue.length
          ? Promise.resolve(queue.shift()!)
          : new Promise((resolve) => (waiting = resolve)),
    cancelled: () => stopped || ended,
    close: () => lines.close(),
    /** A cancel from outside the input, such as SIGTERM. */
    cancel: () => deliver({ type: "cancel" }),
  };
}
