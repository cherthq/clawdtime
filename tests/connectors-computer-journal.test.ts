import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerJournal,
  computerDirectory,
  readComputerSwitch,
  setComputerSwitch,
} from "../connectors/computer/journal.js";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "clawdtime-computer-journal-"));
  roots.push(path);
  return path;
};
afterEach(() =>
  roots
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("the journal of computer requests", () => {
  it("keeps the request, its state and each step in an owner-only file", () => {
    const home = root();
    let now = 1000;
    const journal = new ComputerJournal(home, () => now);
    expect(journal.all()).toEqual([]);
    expect(journal.latest()).toBeNull();
    journal.open("talk_1_execution", "Open the notes app and add milk");
    now = 2000;
    journal.step("talk_1_execution", {
      kind: "click_element",
      target: "New Note",
      outcome: "ok",
    });
    journal.set("talk_1_execution", "completed", "done");
    expect(journal.get("talk_1_execution")).toEqual({
      id: "talk_1_execution",
      goal: "Open the notes app and add milk",
      state: "completed",
      reason: "done",
      createdAt: 1000,
      updatedAt: 2000,
      steps: [
        {
          n: 1,
          kind: "click_element",
          target: "New Note",
          outcome: "ok",
          at: 2000,
        },
      ],
    });
    expect(journal.file).toBe(join(home, "computer", "journal.json"));
    expect(mode(journal.file)).toBe(0o600);
    expect(mode(computerDirectory(home))).toBe(0o700);
    // Another reader of the same folder sees the same record.
    expect(new ComputerJournal(home).latest()?.state).toBe("completed");
  });

  it("has no place for an image, typed text or the text of a page", () => {
    const home = root();
    const journal = new ComputerJournal(home, () => 1);
    journal.open("r1", "Do it");
    journal.step("r1", {
      kind: "type",
      target: "Search",
      outcome: "ok",
      // A caller that passes more than the record takes: it is not kept.
      ...({ text: "typed words", image: "aW1hZ2U=" } as object),
    });
    const text = readFileSync(journal.file, "utf8");
    expect(text).not.toContain("typed words");
    expect(text).not.toContain("aW1hZ2U=");
    expect(Object.keys(JSON.parse(text).requests[0].steps[0]).sort()).toEqual([
      "at",
      "kind",
      "n",
      "outcome",
      "target",
    ]);
  });

  it("keeps a marker in place of a request that held a credential", () => {
    const journal = new ComputerJournal(root(), () => 1);
    journal.open("r1", "log in, my password is correct-horse-battery");
    expect(journal.get("r1")!.goal).toBe(
      "[A request that held a credential. Its text is not kept.]",
    );
    expect(readFileSync(journal.file, "utf8")).not.toContain("correct-horse");
  });

  it("cuts a long request, a long name and control characters", () => {
    const journal = new ComputerJournal(root(), () => 1);
    journal.open("r1", `Open\n${"x".repeat(600)}`);
    journal.step("r1", {
      kind: "click_element",
      target: `Save\u0007 ${"y".repeat(300)}`,
      outcome: "ok",
    });
    const kept = journal.get("r1")!;
    expect(kept.goal.length).toBeLessThanOrEqual(300);
    expect(kept.goal).not.toMatch(/\n/);
    expect(kept.steps[0]!.target.length).toBeLessThanOrEqual(80);
    expect(kept.steps[0]!.target).not.toMatch(/\p{C}/u);
  });

  it("turns a request that was running into uncertain on start, once", () => {
    const home = root();
    const first = new ComputerJournal(home, () => 1);
    first.open("r1", "First");
    first.set("r1", "completed", "done");
    first.open("r2", "Second");
    first.set("r2", "waiting_for_person", "question");
    const second = new ComputerJournal(home, () => 5);
    expect(second.unresolved()).toBeNull();
    expect(second.recover().map((request) => request.id)).toEqual(["r2"]);
    expect(second.get("r2")).toMatchObject({
      state: "uncertain",
      reason: "restart",
      updatedAt: 5,
    });
    expect(second.get("r1")!.state).toBe("completed");
    expect(second.unresolved()?.id).toBe("r2");
    expect(second.recover()).toEqual([]);
  });

  it("holds an uncertain request until the person clears it, and keeps its record", () => {
    const home = root();
    let now = 1;
    const journal = new ComputerJournal(home, () => now);
    journal.open("r1", "First");
    journal.set("r1", "uncertain", "lost_result");
    expect(journal.unresolved()?.id).toBe("r1");
    now = 9;
    expect(journal.clear().cleared.map((request) => request.id)).toEqual([
      "r1",
    ]);
    expect(journal.unresolved()).toBeNull();
    expect(journal.get("r1")).toMatchObject({
      state: "uncertain",
      reason: "lost_result",
      clearedAt: 9,
    });
    expect(journal.clear().cleared).toEqual([]);
  });

  it("refuses a second request with the same id", () => {
    const journal = new ComputerJournal(root(), () => 1);
    journal.open("r1", "First");
    expect(() => journal.open("r1", "Again")).toThrow("already");
    expect(() => journal.open("../r2", "Bad")).toThrow();
  });

  it("keeps the last requests only, and never drops one that is not cleared", () => {
    const journal = new ComputerJournal(root(), () => 1);
    journal.open("old", "Old");
    journal.set("old", "uncertain", "lost_result");
    for (let index = 0; index < 40; index++) {
      journal.open(`r${index}`, "Next");
      journal.set(`r${index}`, "completed", "done");
    }
    const kept = journal.all().map((request) => request.id);
    expect(kept.length).toBeLessThanOrEqual(30);
    expect(kept).toContain("old");
    expect(kept).toContain("r39");
    expect(kept).not.toContain("r0");
  });

  it("blocks new work when its file cannot be read, and sets that file aside on clear", () => {
    const home = root();
    const journal = new ComputerJournal(home, () => 7);
    journal.open("r1", "First");
    writeFileSync(journal.file, "{ not json", { mode: 0o600 });
    expect(journal.all()).toEqual([]);
    expect(journal.unresolved()).toMatchObject({
      state: "uncertain",
      reason: "unreadable_journal",
    });
    // Nothing is written over a file that cannot be read.
    expect(() => journal.open("r2", "Second")).toThrow("cannot be read");
    expect(readFileSync(journal.file, "utf8")).toBe("{ not json");
    const result = journal.clear();
    expect(result.setAside).toMatch(/journal\.unreadable-7\.json$/);
    expect(readFileSync(result.setAside!, "utf8")).toBe("{ not json");
    expect(existsSync(journal.file)).toBe(false);
    expect(journal.unresolved()).toBeNull();
    journal.open("r2", "Second");
    expect(journal.latest()?.id).toBe("r2");
  });

  it("does not follow a symbolic link", () => {
    const home = root();
    mkdirSync(computerDirectory(home), { recursive: true, mode: 0o700 });
    const elsewhere = join(home, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, requests: [] }));
    symlinkSync(elsewhere, join(computerDirectory(home), "journal.json"));
    const journal = new ComputerJournal(home, () => 1);
    expect(journal.unresolved()?.reason).toBe("unreadable_journal");
    expect(() => journal.open("r1", "First")).toThrow();
    expect(readFileSync(elsewhere, "utf8")).toBe(
      JSON.stringify({ version: 1, requests: [] }),
    );
  });
});

describe("the switch for computer use", () => {
  it("is off until the person turns it on", () => {
    const home = root();
    expect(readComputerSwitch(home)).toEqual({
      enabled: false,
      since: null,
      problem: null,
    });
    expect(readdirSync(home)).toEqual([]);
    setComputerSwitch(home, true, 5);
    expect(readComputerSwitch(home)).toEqual({
      enabled: true,
      since: 5,
      problem: null,
    });
    const file = join(computerDirectory(home), "config.json");
    expect(mode(file)).toBe(0o600);
    expect(mode(computerDirectory(home))).toBe(0o700);
    setComputerSwitch(home, false, 9);
    expect(readComputerSwitch(home)).toMatchObject({
      enabled: false,
      since: 9,
    });
  });

  it("stays off when its file is not owner-only, is a link or is not valid", () => {
    const home = root();
    setComputerSwitch(home, true, 5);
    const file = join(computerDirectory(home), "config.json");
    chmodSync(file, 0o644);
    expect(readComputerSwitch(home)).toMatchObject({
      enabled: false,
      problem: expect.stringMatching(/owner-only/),
    });
    chmodSync(file, 0o600);
    expect(readComputerSwitch(home).enabled).toBe(true);
    for (const text of [
      "{",
      "{}",
      '{"version":1,"enabled":"yes","since":1}',
      '{"version":2,"enabled":true,"since":1}',
      '{"version":1,"enabled":true,"since":1,"extra":1}',
    ]) {
      writeFileSync(file, text, { mode: 0o600 });
      expect(readComputerSwitch(home)).toMatchObject({
        enabled: false,
        problem: expect.any(String),
      });
    }
    rmSync(file);
    const other = join(home, "other.json");
    writeFileSync(other, '{"version":1,"enabled":true,"since":1}', {
      mode: 0o600,
    });
    symlinkSync(other, file);
    expect(readComputerSwitch(home).enabled).toBe(false);
  });
});
