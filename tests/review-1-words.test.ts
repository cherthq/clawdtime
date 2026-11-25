import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { readWords } from "../connectors/computer/orders.js";
import { stoppedText } from "../connectors/computer/worker.js";

/**
 * Review 1: words that arrive while a computer task runs. Each test shows
 * one way in which words that should stop or hold are read as something
 * else. The rule is: when in doubt, do not allow.
 */
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

/** A computer task that runs, as the chat sees it. */
function running() {
  const snapshot = {
    configured: true,
    mode: "native" as const,
    state: "running" as const,
    canStop: true,
    message: 'Working on: "open the editor". Step 2 of at most 40.',
  };
  return {
    snapshot: () => snapshot,
    submit: vi.fn(async (_id: string, _text: string) => ({
      message: "Got it. I take that into the task that runs.",
    })),
    answer: vi.fn(async (_text: string) => ({ message: "Answered." })),
    stop: vi.fn(() => ({
      ...snapshot,
      state: "stopping",
      canStop: false,
      message: stoppedText,
    })),
  };
}
function chat(execution: ReturnType<typeof running>) {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-review-1-words-"));
  roots.push(home);
  return new Supervisor(
    {
      now: () => 1000,
      board: () => null,
      desk: new DecisionDesk(home, () => 1000),
      focus: async () => ({ ok: false }),
      send: async () => ({ ok: false, route: "none" }),
      clis: () => [],
      execution,
    },
    null,
  );
}

describe("review 1: a stop word with a typo", () => {
  // One letter left out, doubled, or hit with the key next to it. None of
  // them is an English word. The casual reader lists only a few swaps.
  const stops = ["stp", "stpp", "srop", "sttop", "canceel", "abortt", "haltt"];

  it.each(stops)("reads %j as a stop", (words) => {
    expect(readWords(words)).toBe("stop");
  });

  it.each(stops)(
    "stops the running task on %j in the chat (today it neither stops nor pauses it)",
    async (words) => {
      const execution = running();
      await chat(execution).reply([], words, "chat");
      expect(execution.stop).toHaveBeenCalledTimes(1);
    },
  );

  it("never steers the task with an order that ends in a stop word with a typo", async () => {
    const words = "click the send button stp";
    expect(readWords(words)).not.toBe("order");
    const execution = running();
    await chat(execution).reply([], words, "chat");
    expect(execution.submit).not.toHaveBeenCalled();
  });
});

describe("review 1: a stop word in letters of another script", () => {
  // A Cyrillic o (U+043E) and a Cyrillic s (U+0455) look the same as the
  // Latin letters. NFKC does not fold them.
  it.each(["stоp", "ѕtop", "STОP"])(
    "reads %j as a stop and stops the running task",
    async (words) => {
      expect(readWords(words)).toBe("stop");
      const execution = running();
      await chat(execution).reply([], words, "chat");
      expect(execution.stop).toHaveBeenCalledTimes(1);
    },
  );
});

describe("review 1: a negation with another apostrophe", () => {
  // The plain apostrophe holds. An acute accent (U+00B4, which NFKC turns
  // into a space and a combining mark), a backtick, a modifier letter
  // apostrophe (U+02BC) and a prime (U+2032) take the negation away.
  // brain.ts already reads all four as an apostrophe in n't.
  it("holds with the plain apostrophe", () => {
    expect(readWords("click the button that doesn't say send")).toBe("hold");
  });
  it.each([
    "click the button that doesn´t say send",
    "click the button that doesn`t say send",
    "click the button that doesnʼt say send",
    "click the button that doesn′t say send",
    "open the email that isn´t spam",
    "open the draft i haven´t sent",
  ])("holds on %j", (words) => {
    expect(readWords(words)).toBe("hold");
  });
});

describe("review 1: a hold cue with a typo or in a casual form after an order", () => {
  // The words after the screen noun are free, so a hold cue that the reader
  // does not know as written lets the order through. The casual reader
  // spells out "wiat" and "w8", but not these.
  it.each([
    "click the send button befor it loads",
    "click the send button untl it loads",
    "click the send button wen it loads",
    "click the send button b4 it loads",
    "click the send button l8r",
    "click the send button latr",
    "click the send button waot",
    "click the button nt the link",
  ])("holds on %j", (words) => {
    expect(readWords(words)).toBe("hold");
  });
});

describe("review 1: a delay that is not in the list", () => {
  // "in 5 minutes" and "later" hold. A delay in hours, a day or a clock
  // time, or a number glued to its unit, is read as an order to act now.
  it.each([
    "click the send button in an hour",
    "click the send button in 2 hours",
    "click the send button in 5min",
    "click the send button tomorrow",
    "click the send button at 5pm",
  ])("holds on %j", (words) => {
    expect(readWords(words)).toBe("hold");
  });
});
