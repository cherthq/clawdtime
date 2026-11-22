import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerCli } from "../cli/computer.js";
import { main } from "../cli/main.js";
import {
  ComputerJournal,
  computerDirectory,
  readComputerSwitch,
} from "../connectors/computer/journal.js";
import { recordTiming } from "../connectors/computer/timing.js";
import { FakeBrowser } from "./connectors-computer-fixture.js";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
function setup(env: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), "clawdtime-computer-cli-"));
  roots.push(root);
  const lines: string[] = [];
  const run = (...args: string[]) => {
    lines.length = 0;
    return computerCli(args, {
      env: { CLAWDTIME_CONFIG_HOME: root, ...env },
      home: "/nowhere",
      now: () => Date.UTC(2026, 10, 20, 12),
      print: (line) => lines.push(line),
    }).then(() => lines.join("\n"));
  };
  return { root, run, journal: new ComputerJournal(root) };
}

describe("clawdtime computer", () => {
  it("is off until the person turns it on, and off again on request", async () => {
    const { root, run } = setup();
    expect(await run("status")).toBe(
      "Computer use is off. Turn it on: clawdtime computer on\nNo request yet.",
    );
    // Reading the state writes nothing.
    expect(readdirSync(root)).toEqual([]);
    const on = await run("on");
    expect(on).toMatch(/^Computer use is on\./);
    expect(on).toMatch(/Start the ClawdTime desktop service again/);
    expect(on).toMatch(/needs your yes/);
    expect(readComputerSwitch(root)).toEqual({
      enabled: true,
      since: Date.UTC(2026, 10, 20, 12),
      problem: null,
    });
    expect(await run("status")).toBe(
      "Computer use is on, since 2026-11-20.\nNo request yet.",
    );
    const off = await run("off");
    expect(off).toBe(
      "Computer use is off. A request that runs now stops before its next action. An action that was already sent may have finished.",
    );
    expect(readComputerSwitch(root).enabled).toBe(false);
    // With no word it tells the state, as status does.
    expect(await run()).toMatch(/^Computer use is off\./);
  });

  it("says when no key for the language model is there, and never prints a key", async () => {
    const none = setup();
    expect(await none.run("on")).toMatch(
      /No key for the language model is in this environment\. The service needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY\./,
    );
    const keyed = setup({ OPENAI_API_KEY: "sk-test-never-printed" });
    const on = await keyed.run("on");
    expect(on).not.toMatch(/No key/);
    for (const command of ["on", "status", "doctor", "off", "clear", "help"])
      expect(await keyed.run(command)).not.toContain("sk-test-never-printed");
  });

  it("tells the last request, and one with an unknown result", async () => {
    const { run, journal } = setup();
    journal.open("r1", "Add milk to the shopping note");
    journal.step("r1", {
      kind: "click_element",
      target: "New Note",
      outcome: "ok",
    });
    journal.set("r1", "completed", "done");
    expect(await run("status")).toMatch(
      /Last request: "Add milk to the shopping note" is completed, after 1 step\./,
    );
    journal.open("r2", "Pay the invoice");
    journal.set("r2", "uncertain", "lost_result");
    const status = await run("status");
    expect(status).toMatch(/Last request: "Pay the invoice" is uncertain/);
    expect(status).toMatch(
      /Its result is not known\. It is not run again, and no new work starts\. Look at the screen, then run: clawdtime computer clear/,
    );
  });

  it("clears a request with an unknown result and keeps its record", async () => {
    const { run, journal } = setup();
    expect(await run("clear")).toBe("Nothing to clear.");
    journal.open("r1", "Pay the invoice");
    journal.set("r1", "uncertain", "restart");
    expect(await run("clear")).toBe(
      'Cleared: "Pay the invoice". Its record stays in the journal. New work can start.',
    );
    expect(journal.unresolved()).toBeNull();
    expect(journal.get("r1")).toMatchObject({
      state: "uncertain",
      clearedAt: Date.UTC(2026, 10, 20, 12),
    });
    expect(await run("clear")).toBe("Nothing to clear.");
    expect(await run("status")).toMatch(
      /Last request: "Pay the invoice" had an unknown result\. You cleared it\./,
    );
  });

  it("sets a journal aside that cannot be read, and never removes it", async () => {
    const { root, run, journal } = setup();
    journal.open("r1", "First");
    writeFileSync(journal.file, "{ not json", { mode: 0o600 });
    expect(await run("status")).toMatch(
      /The record of computer requests cannot be read/,
    );
    const cleared = await run("clear");
    expect(cleared).toMatch(
      /^The record of computer requests could not be read\. It was set aside as .*journal\.unreadable-\d+\.json and is not removed\. New work can start\.$/,
    );
    expect(
      readdirSync(computerDirectory(root)).some((name) =>
        name.startsWith("journal.unreadable-"),
      ),
    ).toBe(true);
    expect(existsSync(journal.file)).toBe(false);
  });

  it("doctor says what is ready and what is missing", async () => {
    const { root, run } = setup();
    const missing = await run("doctor");
    expect(missing).toMatch(/switch +off\. Turn it on: clawdtime computer on/);
    expect(missing).toMatch(
      /model key +missing\. The service needs CLAWDTIME_OPENAI_API_KEY or OPENAI_API_KEY in its environment\./,
    );
    expect(missing).toMatch(/model +gpt-4\.1/);
    expect(missing).toMatch(/journal +no request yet/);
    expect(missing).toMatch(/unknown result +none/);
    expect(missing).toMatch(/hands +in the ClawdTime panel/);
    expect(missing).toMatch(/Accessibility/);
    expect(missing).toMatch(/Screen & System Audio Recording/);
    expect(missing).toMatch(
      /browser +off\. The worker uses the screen for web pages\. To read and operate the page itself, start the desktop service with CLAWDTIME_COMPUTER_BROWSER=on\./,
    );
    expect(readdirSync(root)).toEqual([]);

    const ready = setup({
      CLAWDTIME_OPENAI_API_KEY: "sk-own",
      OPENAI_API_KEY: "sk-general",
      CLAWDTIME_COMPUTER_MODEL: "gpt-4.1-mini",
    });
    await ready.run("on");
    ready.journal.open("r1", "Pay the invoice");
    ready.journal.set("r1", "uncertain", "restart");
    const text = await ready.run("doctor");
    expect(text).toMatch(/switch +on/);
    expect(text).toMatch(/model key +found in CLAWDTIME_OPENAI_API_KEY/);
    expect(text).toMatch(/model +gpt-4\.1-mini/);
    expect(text).toMatch(/state folder +.*computer, for its owner only/);
    expect(text).toMatch(/journal +1 request kept/);
    expect(text).toMatch(
      /unknown result +"Pay the invoice"\. Look at the screen, then run: clawdtime computer clear/,
    );
    expect(text).not.toContain("sk-own");
    // A folder that others can read is named.
    chmodSync(computerDirectory(ready.root), 0o755);
    expect(await ready.run("doctor")).toMatch(
      /state folder +.*is open to other users\. Run: chmod 700 /,
    );
    chmodSync(computerDirectory(ready.root), 0o700);
  });

  it("doctor asks a connected browser whether it can be driven", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawdtime-computer-cli-"));
    roots.push(root);
    const lines: string[] = [];
    const browser = new FakeBrowser();
    await computerCli(["doctor"], {
      env: { CLAWDTIME_CONFIG_HOME: root },
      home: "/nowhere",
      print: (line) => lines.push(line),
      browser,
    });
    expect(lines.join("\n")).toMatch(/browser +chrome can be driven/);
    browser.doctor = async () => ({
      ok: false,
      browser: null,
      reason: "Turn on Allow JavaScript from Apple Events.",
    });
    lines.length = 0;
    await computerCli(["doctor"], {
      env: { CLAWDTIME_CONFIG_HOME: root },
      home: "/nowhere",
      print: (line) => lines.push(line),
      browser,
    });
    expect(lines.join("\n")).toMatch(
      /browser +cannot be driven\. Turn on Allow JavaScript from Apple Events\./,
    );
    // It only asks. It opens, reads and clicks nothing.
    expect(browser.calls).toEqual([]);
  });

  it("prints the time of the newest steps, and says how to turn the record on when there is none", async () => {
    const { root, run } = setup();
    expect(await run("timing")).toBe(
      "No step was timed yet. Start the desktop service with CLAWDTIME_COMPUTER_TIMING=on, then ask for something.",
    );
    // Reading writes nothing.
    expect(readdirSync(root)).toEqual([]);
    const at = Date.UTC(2026, 10, 22, 9);
    for (let step = 1; step <= 23; step++)
      recordTiming(
        root,
        { step, kind: "click_element", lookMs: 310, planMs: 1840, actMs: 420 },
        () => at + step * 1000,
      );
    const printed = (await run("timing")).split("\n");
    // The newest 20, oldest first.
    expect(printed).toHaveLength(20);
    expect(printed[0]).toBe(
      "2026-11-22T09:00:04.000Z step 4 click_element: look 310 ms, plan 1840 ms, act 420 ms",
    );
    expect(printed[19]).toMatch(/^2026-11-22T09:00:23\.000Z step 23 /);
  });

  it("has help, and refuses a word that it does not know", async () => {
    const { root, run } = setup();
    const help = await run("help");
    for (const word of ["status", "on", "off", "doctor", "clear", "timing"])
      expect(help).toMatch(new RegExp(`computer ${word}\\b`));
    await expect(run("launch")).rejects.toThrow(
      "Use: clawdtime computer status|on|off|doctor|clear|timing",
    );
    await expect(run("on", "now")).rejects.toThrow("Use: clawdtime computer");
    expect(readdirSync(root)).toEqual([]);
  });

  it("is a command of clawdtime itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawdtime-computer-cli-"));
    roots.push(root);
    const previous = process.env.CLAWDTIME_CONFIG_HOME;
    process.env.CLAWDTIME_CONFIG_HOME = root;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["computer", "status"]);
      expect(log.mock.calls.map((call) => call[0]).join("\n")).toMatch(
        /^Computer use is off\./,
      );
      log.mockClear();
      await main(["help"]);
      expect(log.mock.calls[0]![0]).toMatch(
        /computer status \| on \| off \| doctor \| clear/,
      );
    } finally {
      log.mockRestore();
      if (previous === undefined) delete process.env.CLAWDTIME_CONFIG_HOME;
      else process.env.CLAWDTIME_CONFIG_HOME = previous;
    }
  });
});
