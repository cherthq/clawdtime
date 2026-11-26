import { describe, expect, it } from "vitest";
import { realExec } from "../connectors/system/host.js";

describe("the real door to the process level", () => {
  it("keeps the newest output of a program that prints more than its cap, when asked", async () => {
    const exec = realExec("/");
    const tail = await exec("/usr/bin/seq", ["1", "100000"], {
      timeoutMs: 10_000,
      maxBytes: 100,
      keep: "tail",
    });
    expect(tail.cut).toBe(true);
    expect(tail.timedOut).toBe(false);
    expect(tail.stdout.endsWith("99999\n100000\n")).toBe(true);
    // No half line at the start.
    expect(tail.stdout.split("\n")[0]).toMatch(/^\d{5}$/);
    expect(tail.stdout.length).toBeLessThanOrEqual(100);
    const head = await exec("/usr/bin/seq", ["1", "100000"], {
      timeoutMs: 10_000,
      maxBytes: 100,
    });
    expect(head.cut).toBe(true);
    expect(head.stdout.startsWith("1\n2\n")).toBe(true);
  });
});
