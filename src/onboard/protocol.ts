/**
 * The setup protocol between the setup engine and a user interface: the
 * terminal wizard or the Mac app. One JSON object per line. docs/ONBOARDING.md
 * describes it. A secret input's value never appears in an event.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

export const onboardProtocol = 1;

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
}
export interface StepEvent {
  type: "step";
  id: StepId;
  state: StepState;
  title: string;
  detail?: string;
  recovery?: Recovery;
  input?: InputRequest;
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
  | { type: "done"; ready: boolean; report: ReportRow[] };

const stepId = z.enum(stepIds);
export const onboardCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("input"),
      id: stepId,
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
}

/**
 * The JSON protocol over a pair of streams: events go out as one JSON object
 * per line, commands come in the same way. A line that is not a command is
 * ignored with a fixed warning that never quotes it: it may hold a key. The
 * end of the input is a cancel.
 */
export function jsonLinesIO(
  input: Readable,
  write: (line: string) => void,
): OnboardIO & { close(): void } {
  const queue: OnboardCommand[] = [];
  let waiting: ((command: OnboardCommand) => void) | null = null;
  let ended = false;
  const deliver = (command: OnboardCommand) => {
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
      queue.length
        ? Promise.resolve(queue.shift()!)
        : ended
          ? Promise.resolve({ type: "cancel" })
          : new Promise((resolve) => (waiting = resolve)),
    close: () => lines.close(),
  };
}
