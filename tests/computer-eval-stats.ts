/**
 * The numbers of the two evals of computer use: how sure a pass rate is, the
 * times of a case, and the fixed split of the cases into dev and held.
 *
 * A case that runs n times and passes k times has a pass rate of k / n. With
 * few runs that share is not sure: 2 of 3 can come from a case that passes
 * 9 times in 10 or 3 times in 10. The interval here is the score interval of a
 * share at 95 percent: it stays inside 0 to 1 and keeps a fair width at 0 of
 * n and n of n, where the plain normal interval shrinks to nothing.
 *
 * The split keeps a quarter of the cases out of the work on prompts. A change
 * is designed on the dev cases and judged on the held ones, so a rule that
 * only fits the cases it was made on does not look like a gain.
 *
 * Everything here is pure: no file, no network, no clock.
 */
import { createHash } from "node:crypto";

/** The z of a two-sided 95 percent interval. */
export const z95 = 1.959963984540054;

export interface Interval {
  low: number;
  high: number;
}
export interface Tally {
  passes: number;
  runs: number;
}

/**
 * The score interval of `passes` of `runs`, as shares from 0 to 1. With no
 * runs nothing is known: 0 to 1.
 */
export function scoreInterval(passes: number, runs: number, z = z95): Interval {
  if (!Number.isInteger(passes) || !Number.isInteger(runs))
    throw new Error(`Passes and runs are whole numbers: ${passes} of ${runs}.`);
  if (passes < 0 || runs < 0 || passes > runs)
    throw new Error(`No pass rate has ${passes} passes of ${runs} runs.`);
  if (runs === 0) return { low: 0, high: 1 };
  const share = passes / runs;
  const z2 = z * z;
  const scale = 1 + z2 / runs;
  const middle = (share + z2 / (2 * runs)) / scale;
  const half =
    (z * Math.sqrt((share * (1 - share)) / runs + z2 / (4 * runs * runs))) /
    scale;
  // At 0 of n and n of n one end is exact; rounding must not push it past.
  return {
    low: passes === 0 ? 0 : Math.max(0, middle - half),
    high: passes === runs ? 1 : Math.min(1, middle + half),
  };
}

/**
 * The difference of two pass rates, `after` minus `before`, with its 95
 * percent interval. The interval comes from the score interval of each side
 * (the hybrid score method), so it too stays fair at 0 of n and n of n. The
 * difference is beyond the noise when zero is outside the interval.
 */
export function differenceInterval(
  before: Tally,
  after: Tally,
  z = z95,
): Interval & { difference: number; beyond: boolean } {
  const a = before.runs ? before.passes / before.runs : 0;
  const b = after.runs ? after.passes / after.runs : 0;
  const ia = scoreInterval(before.passes, before.runs, z);
  const ib = scoreInterval(after.passes, after.runs, z);
  const difference = b - a;
  const low = difference - Math.sqrt((b - ib.low) ** 2 + (ia.high - a) ** 2);
  const high = difference + Math.sqrt((ib.high - b) ** 2 + (a - ia.low) ** 2);
  // With no runs on a side nothing is known of the difference.
  if (!before.runs || !after.runs)
    return { difference, low: -1, high: 1, beyond: false };
  return {
    difference,
    low: Math.max(-1, low),
    high: Math.min(1, high),
    beyond: low > 0 || high < 0,
  };
}

/**
 * The value below which `share` of the values lie, by a straight line
 * between the two nearest ranks: the median of 1 and 2 is 1.5. Null for no
 * values.
 */
export function quantile(values: number[], share: number): number | null {
  if (!(share >= 0 && share <= 1))
    throw new Error(`A quantile is a share from 0 to 1. Got: ${share}`);
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const at = (sorted.length - 1) * share;
  const below = Math.floor(at);
  const above = Math.min(sorted.length - 1, below + 1);
  return sorted[below]! + (at - below) * (sorted[above]! - sorted[below]!);
}
export const median = (values: number[]) => quantile(values, 0.5);
export const ninetieth = (values: number[]) => quantile(values, 0.9);

/** Which cases a run takes: the dev cases, the held cases or all of them. */
export type Split = "dev" | "held" | "all";
export const splits: readonly Split[] = ["dev", "held", "all"];

/** True when a case with this tag belongs to the split. */
export const inSplit = (held: boolean, split: Split) =>
  split === "all" || (split === "held") === held;

/** A number from 0 to 2^32 - 1 for a name: the first four bytes of its SHA-256. The same name gives the same number on every machine. */
export function splitHash(name: string): number {
  return createHash("sha256").update(name, "utf8").digest().readUInt32BE(0);
}

/**
 * The held cases of one set, as they were chosen once: the quarter of the
 * names (rounded) with the lowest split hash. The order of the names does
 * not matter. The evals keep the result as a `held` tag on each case, so a
 * new case or a new name moves no other case.
 */
export function pickHeld(names: readonly string[]): Set<string> {
  const unique = [...new Set(names)];
  const count = Math.round(unique.length / 4);
  return new Set(
    unique
      .map((name) => ({ name, hash: splitHash(name) }))
      .sort((x, y) => x.hash - y.hash || (x.name < y.name ? -1 : 1))
      .slice(0, count)
      .map((item) => item.name),
  );
}

/** For a case added after the split: held when its hash is in the lowest quarter of the range, so about a quarter of new cases are. */
export const heldByHash = (name: string) => splitHash(name) < 2 ** 30;
