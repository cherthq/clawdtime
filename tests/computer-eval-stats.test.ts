import { describe, expect, it, vi } from "vitest";
import {
  compareResults,
  evalFlags,
  parseResults,
  printComparison,
  printResults,
  repeatsOf,
  summarize,
  type CaseRun,
  type EvalResults,
} from "./computer-eval-report.js";
import {
  differenceInterval,
  heldByHash,
  inSplit,
  median,
  ninetieth,
  pickHeld,
  quantile,
  scoreInterval,
  splitHash,
} from "./computer-eval-stats.js";

const close = (value: number, expected: number) =>
  expect(value).toBeCloseTo(expected, 4);

describe("the score interval of a pass rate", () => {
  it("gives the published values for 81 of 263", () => {
    const { low, high } = scoreInterval(81, 263);
    close(low, 0.2553);
    close(high, 0.3662);
  });

  it("keeps a fair width at 0 of n and n of n, with the exact end at 0 or 1", () => {
    expect(scoreInterval(0, 2).low).toBe(0);
    close(scoreInterval(0, 2).high, 0.6576);
    close(scoreInterval(2, 2).low, 0.3424);
    expect(scoreInterval(2, 2).high).toBe(1);
    close(scoreInterval(114, 114).low, 0.9674);
  });

  it("is the same on both sides of one half", () => {
    const { low, high } = scoreInterval(1, 2);
    close(low, 1 - high);
    close(scoreInterval(8, 10).low, 1 - scoreInterval(2, 10).high);
  });

  it("knows nothing with no runs, and refuses a count that cannot be", () => {
    expect(scoreInterval(0, 0)).toEqual({ low: 0, high: 1 });
    expect(() => scoreInterval(3, 2)).toThrow(/3 passes of 2/);
    expect(() => scoreInterval(-1, 2)).toThrow();
    expect(() => scoreInterval(1.5, 2)).toThrow(/whole numbers/);
  });

  it("narrows as the runs grow", () => {
    const width = (passes: number, runs: number) => {
      const { low, high } = scoreInterval(passes, runs);
      return high - low;
    };
    expect(width(4, 5)).toBeGreaterThan(width(40, 50));
    expect(width(40, 50)).toBeGreaterThan(width(400, 500));
  });
});

describe("the interval of the difference of two pass rates", () => {
  // Pairs (after, before) with their published 95 percent intervals.
  const published: [number, number, number, number, number, number][] = [
    [56, 70, 48, 80, 0.0524, 0.3339],
    [9, 10, 3, 10, 0.1705, 0.809],
    [6, 7, 2, 7, 0.0582, 0.8062],
    [5, 56, 0, 29, -0.0381, 0.1926],
    [0, 10, 0, 20, -0.1611, 0.2775],
    [10, 10, 0, 20, 0.6791, 1],
  ];
  it.each(published)(
    "gives the published values for %i of %i against %i of %i",
    (passes, runs, beforePasses, beforeRuns, low, high) => {
      const result = differenceInterval(
        { passes: beforePasses, runs: beforeRuns },
        { passes, runs },
      );
      close(result.difference, passes / runs - beforePasses / beforeRuns);
      close(result.low, low);
      close(result.high, high);
      expect(result.beyond).toBe(low > 0 || high < 0);
    },
  );

  it("calls a flaky case that moved from 1 of 2 to 2 of 2 within the noise", () => {
    const result = differenceInterval(
      { passes: 1, runs: 2 },
      { passes: 2, runs: 2 },
    );
    close(result.difference, 0.5);
    expect(result.low).toBeLessThan(0);
    expect(result.beyond).toBe(false);
  });

  it("calls a fall from 76 of 76 to 60 of 76 beyond the noise, below zero", () => {
    const result = differenceInterval(
      { passes: 76, runs: 76 },
      { passes: 60, runs: 76 },
    );
    expect(result.high).toBeLessThan(0);
    expect(result.beyond).toBe(true);
  });

  it("knows nothing when a side has no runs", () => {
    expect(
      differenceInterval({ passes: 0, runs: 0 }, { passes: 5, runs: 5 }),
    ).toMatchObject({ low: -1, high: 1, beyond: false });
  });
});

describe("the times of a case", () => {
  it("draws a straight line between the two nearest ranks", () => {
    expect(median([2, 1])).toBe(1.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 10);
    expect(ninetieth([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110])).toBe(100);
    expect(quantile([5, 1], 0)).toBe(1);
    expect(quantile([5, 1], 1)).toBe(5);
  });

  it("gives the one value of one run, and null for no runs", () => {
    expect(median([1234])).toBe(1234);
    expect(ninetieth([1234])).toBe(1234);
    expect(median([])).toBeNull();
  });

  it("does not sort the values that it is given", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it("refuses a share outside 0 to 1", () => {
    expect(() => quantile([1], 1.5)).toThrow(/share from 0 to 1/);
  });
});

describe("the split into dev and held", () => {
  it("hashes a name to the first four bytes of its SHA-256", () => {
    expect(splitHash("")).toBe(0xe3b0c442);
    expect(splitHash("abc")).toBe(0xba7816bf);
  });

  it("holds a quarter of a set, rounded, by the lowest hashes, in any order", () => {
    const names = Array.from({ length: 38 }, (_, index) => `case ${index}`);
    const held = pickHeld(names);
    expect(held.size).toBe(10);
    expect(pickHeld([...names].reverse())).toEqual(held);
    expect(pickHeld([...names, ...names])).toEqual(held);
    const highest = Math.max(...[...held].map(splitHash));
    for (const name of names)
      if (!held.has(name)) expect(splitHash(name)).toBeGreaterThan(highest);
    expect(pickHeld(names.slice(0, 7)).size).toBe(2);
    expect(pickHeld([]).size).toBe(0);
  });

  it("gives about a quarter of new names to held, the same each time", () => {
    const names = Array.from({ length: 4000 }, (_, index) => `new ${index}`);
    const held = names.filter(heldByHash).length;
    expect(held).toBeGreaterThan(900);
    expect(held).toBeLessThan(1100);
    expect(names.filter(heldByHash).length).toBe(held);
  });

  it("takes the dev cases, the held cases or all", () => {
    expect([inSplit(false, "dev"), inSplit(true, "dev")]).toEqual([
      true,
      false,
    ]);
    expect([inSplit(false, "held"), inSplit(true, "held")]).toEqual([
      false,
      true,
    ]);
    expect([inSplit(false, "all"), inSplit(true, "all")]).toEqual([true, true]);
  });
});

describe("the flags of the evals", () => {
  it("reads the models and every flag, with a value after a space or after =", () => {
    expect(
      evalFlags([
        "gpt-x@low",
        "--repeat",
        "3",
        "--split=held",
        "--out",
        "a.json",
        "anthropic/model-y",
        "--new-actions",
      ]),
    ).toEqual({
      check: false,
      newActions: true,
      repeat: 3,
      split: "held",
      out: "a.json",
      models: ["gpt-x@low", "anthropic/model-y"],
    });
    expect(evalFlags(["--check", "--repeat=2"])).toMatchObject({
      check: true,
      repeat: 2,
      split: "all",
      models: [],
    });
    expect(evalFlags(["--compare", "a.json", "b.json"]).compare).toEqual([
      "a.json",
      "b.json",
    ]);
  });

  it("refuses what it cannot read", () => {
    expect(() => evalFlags(["--repeat", "0"])).toThrow(/whole number/);
    expect(() => evalFlags(["--repeat", "two"])).toThrow(/whole number/);
    expect(() => evalFlags(["--repeat"])).toThrow(/needs a value/);
    expect(() => evalFlags(["--repeat", "--check"])).toThrow(/needs a value/);
    expect(() => evalFlags(["--out="])).toThrow(/needs a value/);
    expect(() => evalFlags(["--split", "test"])).toThrow(/dev, held or all/);
    expect(() => evalFlags(["--compare", "a.json"])).toThrow(/two files/);
    expect(() => evalFlags(["--compare", "a", "b", "gpt-x"])).toThrow(
      /runs nothing/,
    );
    expect(() => evalFlags(["--check=yes"])).toThrow(/no value/);
    expect(() => evalFlags(["--repeats", "2"])).toThrow(/Unknown flag/);
  });

  it("runs as often as the flag says, else REPEATS, else the default; the check mode reads only the flag", () => {
    const flags = evalFlags([]);
    expect(repeatsOf(flags, {}, 2)).toBe(2);
    expect(repeatsOf(flags, { REPEATS: "5" }, 2)).toBe(5);
    expect(repeatsOf(evalFlags(["--repeat", "3"]), { REPEATS: "5" }, 2)).toBe(
      3,
    );
    expect(repeatsOf(evalFlags(["--check"]), { REPEATS: "5" }, 1)).toBe(1);
    expect(repeatsOf(flags, { REPEATS: "nonsense" }, 2)).toBe(2);
  });
});

/** Runs of one model: each case with its passes, its runs and its times. */
const runsOf = (
  model: string,
  cases: [name: string, held: boolean, passes: boolean[], ms?: number[]][],
): CaseRun[] =>
  cases.flatMap(([name, held, passes, ms]) =>
    passes.map((pass, index) => ({
      model,
      name,
      held,
      run: index + 1,
      pass,
      ms: ms ? (ms[index] ?? null) : 1000,
    })),
  );
const fileOf = (runs: CaseRun[]): EvalResults => ({
  eval: "planner",
  at: "2026-11-26T00:00:00.000Z",
  check: false,
  split: "all",
  repeats: 2,
  ...summarize(runs),
  rows: [],
});

describe("the result of each case and of each model", () => {
  const runs = runsOf("model-a", [
    ["open a row", false, [true, true], [1000, 3000]],
    ["drawn stars", false, [true, false], [1500, 2500]],
    ["a dialog", true, [false, false], [800, 1200]],
    ["a switch", true, [true, true], [900, 1100]],
  ]);
  const { models, cases } = summarize(runs);

  it("counts the passes of each case with its interval and times", () => {
    expect(cases.map((item) => [item.name, item.passes, item.runs])).toEqual([
      ["open a row", 2, 2],
      ["drawn stars", 1, 2],
      ["a dialog", 0, 2],
      ["a switch", 2, 2],
    ]);
    close(cases[0]!.low, 0.3424);
    expect(cases[0]!.medianMs).toBe(2000);
    expect(cases[0]!.p90Ms).toBe(2800);
  });

  it("gives each model its rate over all, dev and held, and its flaky cases", () => {
    const [model] = models;
    expect(model!.all).toMatchObject({ passes: 5, runs: 8 });
    expect(model!.dev).toMatchObject({ passes: 3, runs: 4 });
    expect(model!.held).toMatchObject({ passes: 2, runs: 4 });
    expect(model!.flaky).toEqual(["drawn stars"]);
    // 800, 900, 1000, 1100, 1200, 1500, 2500, 3000.
    expect(model!.medianMs).toBe(1150);
  });

  it("leaves a run with no answer out of the times, not out of the runs", () => {
    const [only] = summarize([
      { model: "m", name: "c", held: false, run: 1, pass: false, ms: null },
      { model: "m", name: "c", held: false, run: 2, pass: true, ms: 1200 },
    ]).cases;
    expect(only).toMatchObject({
      passes: 1,
      runs: 2,
      noAnswer: 1,
      medianMs: 1200,
    });
  });

  it("keeps the models apart", () => {
    const both = summarize([
      ...runsOf("model-a", [["c", false, [true]]]),
      ...runsOf("model-b", [["c", false, [false]]]),
    ]);
    expect(both.models.map((item) => [item.model, item.all.passes])).toEqual([
      ["model-a", 1],
      ["model-b", 0],
    ]);
  });
});

describe("the comparison of two results files", () => {
  it("calls a case beyond the noise only when its two intervals are apart", () => {
    const one = (passes: boolean[]) =>
      fileOf(runsOf("model-a", [["drawn stars", false, passes]]));
    const verdict = (from: boolean[], to: boolean[]) =>
      compareResults(one(from), one(to))[0]!.changed[0]!.beyond;
    const five = (pass: boolean) => [pass, pass, pass, pass, pass];
    expect(verdict(five(true), five(false))).toBe(true);
    expect(verdict([true, true, true], [false, false, false])).toBe(false);
  });

  const before = fileOf(
    runsOf("model-a", [
      ["open a row", false, [true, true]],
      ["drawn stars", false, [false, true]],
      ["a dialog", true, [true, true]],
      ["gone later", false, [true, true]],
    ]),
  );
  const after = fileOf(
    runsOf("model-a", [
      ["open a row", false, [true, true]],
      ["drawn stars", false, [true, true]],
      ["a dialog", true, [false, false]],
      ["new later", true, [true, true]],
    ]),
  );

  it("lists the cases whose pass rate changed, each with its verdict", () => {
    const [change] = compareResults(before, after);
    // Even 2 of 2 to 0 of 2 is within the noise: the two intervals overlap.
    expect(change!.changed.map((item) => [item.name, item.beyond])).toEqual([
      ["drawn stars", false],
      ["a dialog", false],
    ]);
    close(change!.changed[1]!.difference, -1);
    expect(change!.onlyBefore).toEqual(["gone later"]);
    expect(change!.onlyAfter).toEqual(["new later"]);
    // Over the three cases in both: 5 of 6 before, 4 of 6 after.
    expect(change!.all.from).toEqual({ passes: 5, runs: 6 });
    expect(change!.all.to).toEqual({ passes: 4, runs: 6 });
    expect(change!.held.from).toEqual({ passes: 2, runs: 2 });
    expect(change!.held.to).toEqual({ passes: 0, runs: 2 });
  });

  it("calls a large fall on many runs beyond the noise", () => {
    const many = (pass: boolean) =>
      fileOf(
        runsOf(
          "model-a",
          Array.from(
            { length: 30 },
            (_, index): [string, boolean, boolean[]] => [
              `case ${index}`,
              false,
              [pass, pass, pass],
            ],
          ),
        ),
      );
    const [change] = compareResults(many(true), many(false));
    expect(change!.all.beyond).toBe(true);
    expect(change!.all.high).toBeLessThan(0);
    expect(change!.changed).toHaveLength(30);
    // One case from 3 of 3 to 0 of 3 is not: its two intervals overlap.
    expect(change!.changed[0]!.beyond).toBe(false);
  });

  it("compares only the cases of the split", () => {
    const [change] = compareResults(before, after, "dev");
    expect(change!.changed.map((item) => item.name)).toEqual(["drawn stars"]);
    expect(change!.held.from.runs).toBe(0);
  });

  it("pairs two single models of different names, and refuses two evals", () => {
    const other = fileOf(runsOf("model-b", [["open a row", false, [true]]]));
    expect(compareResults(before, other)[0]).toMatchObject({
      before: "model-a",
      after: "model-b",
    });
    expect(() => compareResults(before, { ...after, eval: "request" })).toThrow(
      /planner eval and the other of the request eval/,
    );
  });

  it("reads back what it writes, and refuses a file of another shape", () => {
    expect(parseResults(JSON.stringify(after))).toEqual(after);
    expect(() => parseResults("{", "a.json")).toThrow(/a.json is not JSON/);
    expect(() =>
      parseResults(JSON.stringify({ at: "x", repeats: 2, rows: [] })),
    ).toThrow(/not a results file/);
    expect(() =>
      parseResults(
        JSON.stringify({
          ...after,
          cases: [{ ...after.cases[0], passes: 3, runs: 2 }],
        }),
      ),
    ).toThrow(/not a results file/);
  });
});

describe("the printed report", () => {
  const printed = (print: () => void) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      print();
      return log.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      log.mockRestore();
    }
  };
  const before = fileOf([
    ...runsOf("model-a", [
      ["drawn stars", false, [true, false]],
      ["a dialog", true, [true, true]],
    ]),
    ...runsOf("model-b", [["drawn stars", false, [false, false]]]),
  ]);

  it("names each case, its split, its passes and the flaky ones, and a line for each model", () => {
    const text = printed(() =>
      printResults(before, { word: "right", cases: true }),
    );
    expect(text).toContain("model-a: right 3 of 4, 75 percent");
    expect(text).toContain("drawn stars | dev | 1 of 2 | 9.5 to 90.5 |");
    expect(text).toContain("a dialog | held | 2 of 2 | 34.2 to 100 |");
    expect(text).toContain("Flaky, right in some runs and not in all: 1 of 2");
    expect(text).toContain("model | right | 95 percent interval");
    expect(text).toContain("model-b | 0 of 2 |");
  });

  it("prints each case that changed with both intervals and its verdict", () => {
    const after = fileOf(
      runsOf("model-a", [
        ["drawn stars", false, [true, true]],
        ["a dialog", true, [true, true]],
      ]),
    );
    const text = printed(() =>
      printComparison(
        ["a.json", "b.json"],
        before,
        after,
        compareResults(before, after),
        "all",
      ),
    );
    expect(text).toContain("model-a, over the cases that both files have:");
    expect(text).toContain("Cases whose pass rate changed: 1");
    expect(text).toContain(
      "drawn stars | dev | 1 of 2 (9.5 to 90.5) | 2 of 2 (34.2 to 100) | +50 points | within the noise",
    );
  });
});
