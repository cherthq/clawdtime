/**
 * The flags, the results and the comparison that the two evals of computer
 * use share.
 *
 * Each eval runs its cases `--repeat N` times and gives one CaseRun for each
 * run of each case. From those runs this file makes the result of each case
 * (passes of runs, the 95 percent interval, the median and the 90th
 * percentile time) and of each model (all cases, dev and held), prints them,
 * writes them with `--out FILE.json`, and compares two such files with
 * `--compare A.json B.json`. Nothing here opens a connection.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  differenceInterval,
  inSplit,
  median,
  ninetieth,
  scoreInterval,
  splits,
  type Interval,
  type Split,
  type Tally,
} from "./computer-eval-stats.js";

export type EvalName = "planner" | "request";

export interface EvalFlags {
  check: boolean;
  newActions: boolean;
  /** `--repeat N`. Absent: the eval's own default. */
  repeat?: number;
  split: Split;
  out?: string;
  /** `--compare A.json B.json`: the file before and the file after. */
  compare?: [string, string];
  /** The words that are not flags: the models. */
  models: string[];
}

const usage =
  "Flags: --check, --new-actions, --repeat N, --split dev|held|all, --out FILE.json, --compare A.json B.json.";

/** Reads the flags of an eval. A flag with a value takes it as the next word or after "=". */
export function evalFlags(words: readonly string[]): EvalFlags {
  const flags: EvalFlags = {
    check: false,
    newActions: false,
    split: "all",
    models: [],
  };
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (!word.startsWith("--")) {
      flags.models.push(word);
      continue;
    }
    const [flag, inline] = word.split(/=(.*)/s, 2) as [string, string?];
    const value = () => {
      const given = inline ?? words[++index];
      if (!given || (inline === undefined && given.startsWith("--")))
        throw new Error(`${flag} needs a value. ${usage}`);
      return given;
    };
    if (flag === "--check" || flag === "--new-actions") {
      if (inline !== undefined) throw new Error(`${flag} takes no value.`);
      if (flag === "--check") flags.check = true;
      else flags.newActions = true;
    } else if (flag === "--repeat") {
      const given = value();
      if (!/^[1-9]\d*$/.test(given))
        throw new Error(
          `--repeat takes a whole number of 1 or more. Got: ${given}`,
        );
      flags.repeat = Number(given);
    } else if (flag === "--split") {
      const given = value();
      if (!splits.includes(given as Split))
        throw new Error(`--split takes dev, held or all. Got: ${given}`);
      flags.split = given as Split;
    } else if (flag === "--out") flags.out = value();
    else if (flag === "--compare") {
      if (inline !== undefined)
        throw new Error("--compare takes two files: --compare A.json B.json.");
      const before = words[++index];
      const after = words[++index];
      if (
        !before ||
        !after ||
        before.startsWith("--") ||
        after.startsWith("--")
      )
        throw new Error("--compare takes two files: --compare A.json B.json.");
      flags.compare = [before, after];
    } else throw new Error(`Unknown flag ${flag}. ${usage}`);
  }
  if (flags.compare && (flags.check || flags.models.length || flags.out))
    throw new Error(
      "--compare reads two files and runs nothing: give it no model, no --check and no --out.",
    );
  return flags;
}

/** How often each case runs: the flag, else REPEATS of the environment (the older way), else the default. The check mode reads only the flag. */
export function repeatsOf(
  flags: EvalFlags,
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  if (flags.repeat !== undefined) return flags.repeat;
  if (flags.check || env.REPEATS === undefined) return fallback;
  return Math.max(1, Math.floor(Number(env.REPEATS)) || fallback);
}

/** One run of one case. */
export interface CaseRun {
  model: string;
  name: string;
  held: boolean;
  run: number;
  pass: boolean;
  /** The time of the run. Null when there was no answer: an error of the service or of the test. */
  ms: number | null;
}
export interface Rate extends Tally, Interval {}
export interface CaseResult extends Rate {
  model: string;
  name: string;
  held: boolean;
  medianMs: number | null;
  p90Ms: number | null;
  noAnswer: number;
}
export interface ModelResult {
  model: string;
  all: Rate;
  dev: Rate;
  held: Rate;
  /** Over every run with an answer. */
  medianMs: number | null;
  p90Ms: number | null;
  /** The cases that passed in some runs and not in all. */
  flaky: string[];
}
export interface EvalResults {
  eval: EvalName;
  at: string;
  check: boolean;
  split: Split;
  repeats: number;
  models: ModelResult[];
  cases: CaseResult[];
  /** The eval's own rows, one for each run, for a closer look. */
  rows: unknown[];
}

const rate = (passes: number, runs: number): Rate => ({
  passes,
  runs,
  ...scoreInterval(passes, runs),
});
const tallyOf = (cases: readonly CaseResult[]): Rate =>
  rate(
    cases.reduce((sum, item) => sum + item.passes, 0),
    cases.reduce((sum, item) => sum + item.runs, 0),
  );
const timed = (runs: readonly CaseRun[]) =>
  runs.flatMap((run) => (run.ms === null ? [] : [run.ms]));

/** The result of each case and of each model, in the order of the runs. */
export function summarize(runs: readonly CaseRun[]): {
  models: ModelResult[];
  cases: CaseResult[];
} {
  const groups = new Map<string, CaseRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.model, run.name]);
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }
  const cases = [...groups.values()].map((group): CaseResult => {
    const times = timed(group);
    return {
      model: group[0]!.model,
      name: group[0]!.name,
      held: group[0]!.held,
      ...rate(group.filter((run) => run.pass).length, group.length),
      medianMs: median(times),
      p90Ms: ninetieth(times),
      noAnswer: group.length - times.length,
    };
  });
  const models = [...new Set(runs.map((run) => run.model))].map(
    (model): ModelResult => {
      const mine = cases.filter((item) => item.model === model);
      const times = timed(runs.filter((run) => run.model === model));
      return {
        model,
        all: tallyOf(mine),
        dev: tallyOf(mine.filter((item) => !item.held)),
        held: tallyOf(mine.filter((item) => item.held)),
        medianMs: median(times),
        p90Ms: ninetieth(times),
        flaky: mine
          .filter((item) => item.passes > 0 && item.passes < item.runs)
          .map((item) => item.name),
      };
    },
  );
  return { models, cases };
}

export function results(
  name: EvalName,
  options: { check: boolean; split: Split; repeats: number },
  runs: readonly CaseRun[],
  rows: unknown[],
): EvalResults {
  return {
    eval: name,
    at: new Date().toISOString(),
    ...options,
    ...summarize(runs),
    rows,
  };
}

export function writeResults(file: string, out: EvalResults) {
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
}

/** A results file as `--out` wrote it, with its shape checked. */
export function parseResults(text: string, file = "the file"): EvalResults {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON.`);
  }
  const out = data as Partial<EvalResults>;
  const fine =
    typeof out === "object" &&
    out !== null &&
    (out.eval === "planner" || out.eval === "request") &&
    Array.isArray(out.cases) &&
    out.cases.every(
      (item) =>
        typeof item?.model === "string" &&
        typeof item.name === "string" &&
        typeof item.held === "boolean" &&
        Number.isInteger(item.passes) &&
        Number.isInteger(item.runs) &&
        item.passes >= 0 &&
        item.passes <= item.runs,
    );
  if (!fine)
    throw new Error(
      `${file} is not a results file of these evals: write one with --out FILE.json.`,
    );
  return out as EvalResults;
}
export const readResults = (file: string) =>
  parseResults(readFileSync(file, "utf8"), file);

/** A share as a percent, with one decimal unless it is whole. */
const percent = (share: number) => {
  const value = Math.round(share * 1000) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};
const signed = (share: number) =>
  `${share > 0 ? "+" : ""}${percent(share).replace(/^-?0$/, "0")}`;
const seconds = (ms: number | null) =>
  ms === null ? "-" : (ms / 1000).toFixed(2);
const rateLine = (item: Rate) =>
  item.runs
    ? `${item.passes} of ${item.runs}, ${percent(item.passes / item.runs)} percent (95 percent interval ${percent(item.low)} to ${percent(item.high)})`
    : "no runs";

/** The result of each model, and with `cases` the table of every case and the flaky ones. */
export function printResults(
  out: Pick<EvalResults, "models" | "cases">,
  options: { word: string; cases: boolean },
) {
  for (const model of out.models) {
    console.log(`\n${model.model}: ${options.word} ${rateLine(model.all)}`);
    console.log(`  dev:  ${rateLine(model.dev)}`);
    console.log(`  held: ${rateLine(model.held)}`);
    console.log(
      `  time of one run: median ${seconds(model.medianMs)} s, 90th percentile ${seconds(model.p90Ms)} s`,
    );
    if (!options.cases) continue;
    const mine = out.cases.filter((item) => item.model === model.model);
    console.log(
      `case | split | ${options.word} | 95 percent interval | median s | 90th s`,
    );
    for (const item of mine)
      console.log(
        `${item.name} | ${item.held ? "held" : "dev"} | ${item.passes} of ${item.runs} | ${percent(item.low)} to ${percent(item.high)} | ${seconds(item.medianMs)} | ${seconds(item.p90Ms)}${item.noAnswer ? ` | ${item.noAnswer} with no answer` : ""}`,
      );
    const flaky = mine.filter((item) => model.flaky.includes(item.name));
    console.log(
      flaky.length
        ? `Flaky, ${options.word} in some runs and not in all: ${flaky.length} of ${mine.length} cases`
        : `Flaky: none of ${mine.length} cases`,
    );
    for (const item of flaky)
      console.log(
        `  ${item.name} | ${item.held ? "held" : "dev"} | ${item.passes} of ${item.runs}`,
      );
  }
  // With several models, one line for each at the end, side by side.
  if (out.models.length < 2) return;
  console.log(
    `\nmodel | ${options.word} | 95 percent interval | held | median s | 90th s | flaky`,
  );
  for (const model of out.models)
    console.log(
      `${model.model} | ${model.all.passes} of ${model.all.runs} | ${percent(model.all.low)} to ${percent(model.all.high)} | ${model.held.passes} of ${model.held.runs} | ${seconds(model.medianMs)} | ${seconds(model.p90Ms)} | ${model.flaky.length}`,
    );
}

export interface CaseChange {
  name: string;
  held: boolean;
  before: CaseResult;
  after: CaseResult;
  /** The pass rate after minus the pass rate before. */
  difference: number;
  /**
   * True when the two intervals of the case do not overlap. A case has few
   * runs, and at 2 or 3 runs the interval of a difference calls too much
   * beyond the noise, so a case takes this stricter test.
   */
  beyond: boolean;
}
export interface ModelChange {
  before: string;
  after: string;
  /** Over the cases that both files have, in the split. */
  all: ReturnType<typeof differenceInterval> & { from: Tally; to: Tally };
  dev: ReturnType<typeof differenceInterval> & { from: Tally; to: Tally };
  held: ReturnType<typeof differenceInterval> & { from: Tally; to: Tally };
  /** The median of the medians of the shared cases, before and after. */
  medianMs: { before: number | null; after: number | null };
  /** The cases whose pass rate changed. */
  changed: CaseChange[];
  onlyBefore: string[];
  onlyAfter: string[];
}

/**
 * The cases of `after` against those of `before`. Models pair by their
 * label; when each file has one model and the labels differ, those two
 * pair. Only the cases of the split count.
 */
export function compareResults(
  before: EvalResults,
  after: EvalResults,
  split: Split = "all",
): ModelChange[] {
  if (before.eval !== after.eval)
    throw new Error(
      `One file is of the ${before.eval} eval and the other of the ${after.eval} eval.`,
    );
  const labels = (out: EvalResults) => [
    ...new Set(out.cases.map((item) => item.model)),
  ];
  const fromLabels = labels(before);
  const toLabels = labels(after);
  const shared = fromLabels.filter((label) => toLabels.includes(label));
  const pairs: [string, string][] = shared.length
    ? shared.map((label) => [label, label])
    : fromLabels.length === 1 && toLabels.length === 1
      ? [[fromLabels[0]!, toLabels[0]!]]
      : [];
  if (!pairs.length)
    throw new Error(
      `No model to compare: before has ${fromLabels.join(", ") || "none"}, after has ${toLabels.join(", ") || "none"}.`,
    );
  return pairs.map(([from, to]) => {
    const pick = (out: EvalResults, label: string) =>
      new Map(
        out.cases
          .filter((item) => item.model === label && inSplit(item.held, split))
          .map((item) => [item.name, item]),
      );
    const a = pick(before, from);
    const b = pick(after, to);
    const both = [...a.keys()].filter((name) => b.has(name));
    const side = (
      out: Map<string, CaseResult>,
      keep: (item: CaseResult) => boolean,
    ) => {
      const items = both.map((name) => out.get(name)!).filter(keep);
      return {
        passes: items.reduce((sum, item) => sum + item.passes, 0),
        runs: items.reduce((sum, item) => sum + item.runs, 0),
      };
    };
    const change = (keep: (item: CaseResult) => boolean) => {
      const fromTally = side(a, keep);
      const toTally = side(b, keep);
      return {
        ...differenceInterval(fromTally, toTally),
        from: fromTally,
        to: toTally,
      };
    };
    const medians = (out: Map<string, CaseResult>) =>
      median(
        both.flatMap((name) => {
          const value = out.get(name)!.medianMs;
          return value === null ? [] : [value];
        }),
      );
    const changed = both.flatMap((name): CaseChange[] => {
      const x = a.get(name)!;
      const y = b.get(name)!;
      if (x.passes * y.runs === y.passes * x.runs) return [];
      return [
        {
          name,
          held: y.held,
          before: x,
          after: y,
          difference: y.passes / y.runs - x.passes / x.runs,
          beyond: x.high < y.low || y.high < x.low,
        },
      ];
    });
    return {
      before: from,
      after: to,
      all: change(() => true),
      dev: change((item) => !item.held),
      held: change((item) => item.held),
      medianMs: { before: medians(a), after: medians(b) },
      changed,
      onlyBefore: [...a.keys()].filter((name) => !b.has(name)),
      onlyAfter: [...b.keys()].filter((name) => !a.has(name)),
    };
  });
}

const changeLine = (item: {
  from: Tally;
  to: Tally;
  difference: number;
  low: number;
  high: number;
  beyond: boolean;
}) =>
  item.from.runs && item.to.runs
    ? `${item.from.passes} of ${item.from.runs} to ${item.to.passes} of ${item.to.runs}, ${signed(item.difference)} points (95 percent interval ${signed(item.low)} to ${signed(item.high)}): ${item.beyond ? "BEYOND the noise" : "within the noise"}`
    : "no cases in both";

const caseRate = (item: Rate) =>
  `${item.passes} of ${item.runs} (${percent(item.low)} to ${percent(item.high)})`;

export function printComparison(
  files: [string, string],
  before: EvalResults,
  after: EvalResults,
  changes: ModelChange[],
  split: Split,
) {
  const about = (file: string, out: EvalResults) =>
    `${file} (${out.check ? "check, " : ""}${out.repeats} runs of each, split ${out.split}, ${out.at})`;
  console.log(`The ${before.eval} eval, split ${split}.`);
  console.log(`before: ${about(files[0], before)}`);
  console.log(`after:  ${about(files[1], after)}`);
  for (const change of changes) {
    const label =
      change.before === change.after
        ? change.before
        : `${change.before} to ${change.after}`;
    console.log(`\n${label}, over the cases that both files have:`);
    console.log(`  all:  ${changeLine(change.all)}`);
    console.log(`  dev:  ${changeLine(change.dev)}`);
    console.log(`  held: ${changeLine(change.held)}`);
    const { before: was, after: now } = change.medianMs;
    console.log(
      `  median time of a case: ${seconds(was)} s to ${seconds(now)} s${was !== null && now !== null ? ` (${now >= was ? "+" : ""}${seconds(now - was)} s)` : ""}`,
    );
    console.log(
      change.changed.length
        ? `Cases whose pass rate changed: ${change.changed.length}`
        : "No case changed its pass rate.",
    );
    if (change.changed.length)
      console.log(
        "case | split | before (95 percent interval) | after (95 percent interval) | difference | verdict | median s",
      );
    for (const item of change.changed)
      console.log(
        `${item.name} | ${item.held ? "held" : "dev"} | ${caseRate(item.before)} | ${caseRate(item.after)} | ${signed(item.difference)} points | ${item.beyond ? "BEYOND the noise" : "within the noise"} | ${seconds(item.before.medianMs)} to ${seconds(item.after.medianMs)}`,
      );
    if (change.onlyBefore.length)
      console.log(`Only before: ${change.onlyBefore.join("; ")}`);
    if (change.onlyAfter.length)
      console.log(`Only after: ${change.onlyAfter.join("; ")}`);
  }
}

/** `--compare A.json B.json`: reads both files and prints what changed. */
export function compareFiles(files: [string, string], split: Split) {
  const before = readResults(files[0]);
  const after = readResults(files[1]);
  printComparison(
    files,
    before,
    after,
    compareResults(before, after, split),
    split,
  );
}
