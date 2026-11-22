/**
 * Computer use: the time of each step, for a person who looks for the slow
 * part of a request.
 *
 * With `CLAWDTIME_COMPUTER_TIMING=on` in the environment of the desktop
 * service, the worker gives the time of each step to this record: the look at
 * the screen, the answer of the planner, and the action with its checks. The
 * record holds numbers and the kind of action only. It has no place for a text
 * of the screen, for a target or for the request.
 *
 * The desktop service runs with no terminal, so the record is a file in the
 * state folder, written as the journal is: for its owner only, written whole
 * and then renamed. It keeps the newest steps. `clawdtime computer timing`
 * prints them.
 */
import { join } from "node:path";
import { z } from "zod";
import { secureRead, secureWrite } from "../shared/state.js";
import { computerDirectory } from "./journal.js";
import type { StepTiming } from "./worker.js";

const duration = z.number().int().min(0).max(86_400_000);
const timedStepSchema = z
  .object({
    at: z.number().int().positive(),
    step: z.number().int().positive(),
    kind: z.string().max(40),
    lookMs: duration,
    planMs: duration,
    actMs: duration,
  })
  .strict();
export type TimedStep = z.infer<typeof timedStepSchema>;

/** The newest steps that the record keeps. */
export const keptTimings = 400;

export const timingFile = (root: string) =>
  join(computerDirectory(root), "timing.json");

/** The steps of the record, oldest first. A file that is missing or cannot be read holds none. */
export function readTimings(root: string): TimedStep[] {
  try {
    const held = secureRead<{ steps?: unknown }>(timingFile(root));
    return z.array(timedStepSchema).max(keptTimings).parse(held.steps);
  } catch {
    return [];
  }
}

/**
 * Adds one step and keeps the newest ones. A record that cannot be written
 * stops nothing: the request goes on.
 */
export function recordTiming(
  root: string,
  entry: StepTiming,
  now: () => number = Date.now,
) {
  try {
    const whole = (value: number) =>
      Math.min(86_400_000, Math.max(0, Math.round(value)));
    const step = timedStepSchema.parse({
      at: now(),
      step: entry.step,
      kind: entry.kind.slice(0, 40),
      lookMs: whole(entry.lookMs),
      planMs: whole(entry.planMs),
      actMs: whole(entry.actMs),
    });
    secureWrite(timingFile(root), {
      steps: [...readTimings(root).slice(-(keptTimings - 1)), step],
    });
  } catch {
    // A diagnostic never changes what the worker does.
  }
}

/** One step as a line for a person. */
export const timingLine = (step: TimedStep) =>
  `${new Date(step.at).toISOString()} step ${step.step} ${step.kind}: look ${step.lookMs} ms, plan ${step.planMs} ms, act ${step.actMs} ms`;
