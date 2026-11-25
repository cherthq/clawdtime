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
 * The hands add where their part of the step went: taking the picture, the
 * walk of the Accessibility tree, writing the JPEG and its size, the glide of
 * the guided cursor before an input, and how long commands waited before the
 * panel read them. These are numbers too, and each is there only when the
 * step had it.
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
import type { HandsCost } from "./panel-hands.js";
import type { StepTiming } from "./worker.js";

const duration = z.number().int().min(0).max(86_400_000);
const timedStepSchema = z
  .object({
    at: z.number().int().positive(),
    /** Zero only for an entry that ends a request before its first step. */
    step: z.number().int().nonnegative(),
    kind: z.string().max(40),
    lookMs: duration,
    planMs: duration,
    actMs: duration,
    /** Why the worker held the step back: one of its own fixed sentences. */
    held: z.string().max(200).optional(),
    /** What the worker did to get the request moving: its own fixed words, such as nudge_swing, settled, transient. */
    recovery: z.array(z.string().max(40)).max(8).optional(),
    /** How long it waited for the screen to settle and for the planner. */
    waitMs: duration.optional(),
    /** The hands: taking the picture, writing the JPEG, and its bytes. */
    captureMs: duration.optional(),
    encodeMs: duration.optional(),
    imageBytes: duration.optional(),
    /** The hands: the walk of the Accessibility tree, for every look of the step. */
    walkMs: duration.optional(),
    /** The hands: the guided cursor on its way and at the place, before each input. */
    glideMs: duration.optional(),
    /** The time that the commands of the step waited before the panel read them. */
    pollWaitMs: duration.optional(),
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
  entry: StepTiming & HandsCost,
  now: () => number = Date.now,
) {
  try {
    const whole = (value: number) =>
      Math.min(86_400_000, Math.max(0, Math.round(value)));
    const hands: Partial<Record<(typeof handParts)[number], number>> = {};
    for (const part of handParts) {
      const value = entry[part];
      if (typeof value === "number" && Number.isFinite(value))
        hands[part] = whole(value);
    }
    const step = timedStepSchema.parse({
      at: now(),
      step: entry.step,
      kind: entry.kind.slice(0, 40),
      lookMs: whole(entry.lookMs),
      planMs: whole(entry.planMs),
      actMs: whole(entry.actMs),
      ...(entry.held ? { held: entry.held.slice(0, 200) } : {}),
      ...(entry.recovery?.length
        ? {
            recovery: entry.recovery
              .slice(0, 8)
              .map((word) => word.slice(0, 40)),
          }
        : {}),
      ...(entry.waitMs ? { waitMs: whole(entry.waitMs) } : {}),
      ...hands,
    });
    secureWrite(timingFile(root), {
      steps: [...readTimings(root).slice(-(keptTimings - 1)), step],
    });
  } catch {
    // A diagnostic never changes what the worker does.
  }
}

/** The parts of the hands that a step can have, in the order of the record. */
const handParts = [
  "captureMs",
  "encodeMs",
  "imageBytes",
  "walkMs",
  "glideMs",
  "pollWaitMs",
] as const;

/** Where the hands' time of one step went, for example "capture 90 ms, walk 310 ms". Empty with none. */
export function handsLine(step: TimedStep) {
  const parts: string[] = [];
  if (step.captureMs !== undefined) parts.push(`capture ${step.captureMs} ms`);
  if (step.encodeMs !== undefined) parts.push(`encode ${step.encodeMs} ms`);
  if (step.imageBytes !== undefined)
    parts.push(`image ${Math.round(step.imageBytes / 1024)} KB`);
  if (step.walkMs !== undefined) parts.push(`walk ${step.walkMs} ms`);
  if (step.glideMs !== undefined) parts.push(`glide ${step.glideMs} ms`);
  if (step.pollWaitMs !== undefined)
    parts.push(`poll wait ${step.pollWaitMs} ms`);
  return parts.join(", ");
}

/** One step as a line for a person. */
export const timingLine = (step: TimedStep) => {
  const hands = handsLine(step);
  return `${new Date(step.at).toISOString()} step ${step.step} ${step.kind}: look ${step.lookMs} ms, plan ${step.planMs} ms, act ${step.actMs} ms${hands ? ` (hands: ${hands})` : ""}${step.held ? `. Not sent: ${step.held}` : ""}${step.recovery?.length ? `. To get moving: ${step.recovery.join(", ")}` : ""}${step.waitMs ? `, waited ${step.waitMs} ms` : ""}`;
};
