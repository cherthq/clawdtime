import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildComputer } from "../connectors/computer/service.js";
import { setComputerSwitch } from "../connectors/computer/journal.js";
import {
  keptTimings,
  readTimings,
  recordTiming,
  timingFile,
  timingLine,
} from "../connectors/computer/timing.js";

const roots: string[] = [];
const home = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-timing-"));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const step = (number: number) => ({
  step: number,
  kind: "click_element",
  lookMs: 310,
  planMs: 1840,
  actMs: 420,
});

describe("the time of each step, kept in the state folder", () => {
  it("is a file for its owner only, with numbers and the kind of action", () => {
    const root = home();
    expect(readTimings(root)).toEqual([]);
    recordTiming(root, step(1), () => 1_000);
    recordTiming(
      root,
      { step: 2, kind: "done", lookMs: 0.4, planMs: 900.6, actMs: -5 },
      () => 2_000,
    );
    expect(readTimings(root)).toEqual([
      { at: 1_000, ...step(1) },
      // Whole numbers, and never below zero.
      { at: 2_000, step: 2, kind: "done", lookMs: 0, planMs: 901, actMs: 0 },
    ]);
    expect(statSync(timingFile(root)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "computer")).mode & 0o777).toBe(0o700);
    expect(
      Object.keys(JSON.parse(readFileSync(timingFile(root), "utf8"))),
    ).toEqual(["steps"]);
  });

  it("keeps the newest steps only", () => {
    const root = home();
    for (let number = 1; number <= keptTimings + 3; number++)
      recordTiming(root, step(number), () => number);
    const kept = readTimings(root);
    expect(kept).toHaveLength(keptTimings);
    expect(kept[0]!.step).toBe(4);
    expect(kept.at(-1)!.step).toBe(keptTimings + 3);
  });

  it("never stops the worker: a record that cannot be written or read changes nothing", () => {
    // The state folder is a file: nothing can be written under it.
    const blocked = join(home(), "not-a-folder");
    writeFileSync(blocked, "x");
    expect(() => recordTiming(blocked, step(1))).not.toThrow();
    expect(readTimings(blocked)).toEqual([]);
    // A file that is not a record is replaced by the next step.
    const root = home();
    recordTiming(root, step(1), () => 1);
    writeFileSync(timingFile(root), "not json", { mode: 0o600 });
    expect(readTimings(root)).toEqual([]);
    recordTiming(root, step(2), () => 2);
    expect(readTimings(root).map((item) => item.step)).toEqual([2]);
    // A symbolic link is not followed.
    const linked = home();
    recordTiming(linked, step(1), () => 1);
    const elsewhere = join(home(), "elsewhere.json");
    writeFileSync(elsewhere, "{}", { mode: 0o600 });
    rmSync(timingFile(linked));
    symlinkSync(elsewhere, timingFile(linked));
    expect(() => recordTiming(linked, step(2), () => 2)).not.toThrow();
    expect(readFileSync(elsewhere, "utf8")).toBe("{}");
  });

  it("prints one step as a line for a person", () => {
    expect(timingLine({ at: Date.UTC(2026, 10, 22, 9), ...step(3) })).toBe(
      "2026-11-22T09:00:00.000Z step 3 click_element: look 310 ms, plan 1840 ms, act 420 ms",
    );
  });

  it("is on only for the value on in the environment of the service", () => {
    for (const value of [undefined, "off", "1", "true"]) {
      const root = home();
      setComputerSwitch(root, true);
      const built = buildComputer({
        root,
        env: {
          CLAWDTIME_OPENAI_API_KEY: "k",
          ...(value ? { CLAWDTIME_COMPUTER_TIMING: value } : {}),
        },
      });
      expect(built.worker).not.toBeNull();
      expect(
        (built.worker as unknown as { timing?: unknown }).timing,
      ).toBeUndefined();
    }
    const root = home();
    setComputerSwitch(root, true);
    const built = buildComputer({
      root,
      env: { CLAWDTIME_OPENAI_API_KEY: "k", CLAWDTIME_COMPUTER_TIMING: "on" },
    });
    const listener = (
      built.worker as unknown as { timing?: (e: unknown) => void }
    ).timing;
    expect(listener).toBeTypeOf("function");
    listener!(step(7));
    expect(readTimings(root).map((item) => item.step)).toEqual([7]);
  });
});
