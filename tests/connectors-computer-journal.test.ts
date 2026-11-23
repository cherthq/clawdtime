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
  looksSecretStrict,
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

  it("keeps what the person said after the start beside the journal, in order, as it keeps the request", () => {
    let now = 1000;
    const home = root();
    const journal = new ComputerJournal(home, () => now);
    journal.open("r1", "Open the editor");
    // A request that got no more words has none, and there is no file for them.
    expect(journal.guidance("r1")).toEqual([]);
    expect(journal.guided("g1")).toBeNull();
    expect(existsSync(journal.guidanceFile)).toBe(false);
    expect(journal.guide("r1", { id: "g1", text: "Use the\nother tab" })).toBe(
      "Use the other tab",
    );
    now = 2000;
    journal.guide("r1", {
      id: "g2",
      text: "log in, my password is correct-horse-battery",
    });
    // A mark that the cleaning takes away does not hide a credential.
    journal.guide("r1", {
      id: "g3",
      text: "log in, my password is\u200bcorrect-horse-battery",
    });
    journal.guide("r1", { id: "g4", text: "x".repeat(600) });
    const marker = "[A request that held a credential. Its text is not kept.]";
    const kept = journal.guidance("r1");
    expect(kept.slice(0, 3)).toEqual([
      { id: "g1", text: "Use the other tab", at: 1000 },
      { id: "g2", text: marker, at: 2000 },
      { id: "g3", text: marker, at: 2000 },
    ]);
    expect(kept[3]!.text).toHaveLength(300);
    expect(journal.guidanceFile).toBe(join(home, "computer", "guidance.json"));
    expect(mode(journal.guidanceFile)).toBe(0o600);
    expect(readFileSync(journal.guidanceFile, "utf8")).not.toContain(
      "correct-horse",
    );
    // The id of the words finds the request that took them, and is no request itself.
    expect(journal.guided("g2")).toBe("r1");
    expect(journal.get("g2")).toBeNull();
    // There is room for eight. One more is not written, and the eight stay.
    for (let n = 5; n <= 8; n++)
      journal.guide("r1", { id: `g${n}`, text: `Addition ${n}` });
    expect(() => journal.guide("r1", { id: "g9", text: "One more" })).toThrow();
    expect(journal.guidance("r1")).toHaveLength(8);
    expect(() => journal.guide("none", { id: "g10", text: "x" })).toThrow();
    // Another reader of the same folder reads the record.
    expect(new ComputerJournal(home).guidance("r1")).toHaveLength(8);
  });

  it("leaves the journal as a build before these words reads it, and drops the words with their request", () => {
    const home = root();
    const journal = new ComputerJournal(home, () => 1);
    journal.open("r1", "Open the editor");
    journal.guide("r1", { id: "g1", text: "Use the other tab" });
    // The journal has the keys that it had, and no other.
    const request = JSON.parse(readFileSync(journal.file, "utf8")).requests[0];
    expect(Object.keys(request).sort()).toEqual([
      "createdAt",
      "goal",
      "id",
      "reason",
      "state",
      "steps",
      "updatedAt",
    ]);
    expect(journal.readable()).toBe(true);
    // The journal keeps the last 30 requests. Words for a request that it
    // dropped go with the next write.
    journal.set("r1", "completed", "done");
    for (let n = 2; n <= 32; n++) {
      journal.open(`r${n}`, "Next");
      journal.set(`r${n}`, "completed", "done");
    }
    expect(journal.get("r1")).toBeNull();
    journal.open("last", "Last");
    journal.guide("last", { id: "g2", text: "Use the other tab" });
    expect(journal.guided("g1")).toBeNull();
    expect(journal.guided("g2")).toBe("last");
    // Words that cannot be read are not written over, and block no request.
    writeFileSync(journal.guidanceFile, "not json");
    expect(journal.guidance("last")).toEqual([]);
    expect(journal.guided("g2")).toBeNull();
    expect(() => journal.guide("last", { id: "g3", text: "More" })).toThrow();
    expect(readFileSync(journal.guidanceFile, "utf8")).toBe("not json");
    expect(journal.unresolved()).toBeNull();
  });

  it("masks secrets hidden with zero-width characters, plain-word passwords and short codes, and records seen ids outside the 8-addition cap", () => {
    const home = root();
    const journal = new ComputerJournal(home, () => 1);
    journal.open("r1", "Sign in");
    const marker = "[A request that held a credential. Its text is not kept.]";
    const cases = [
      ["g1", "use key sk-\u200b1234567890abcdefghij", "1234567890abcdefghij"],
      ["g2", "my pass\u200bword is correct-horse-battery", "correct-horse"],
      ["g3", "token ghp_abc\u200bdefghijklmnopqrstuvw", "defghijklmnopqrstuvw"],
      ["g4", "my password is swordfish", "swordfish"],
      ["g5", "my pin is 1234", "1234"],
      ["g6", "otp 482913", "482913"],
      ["g7", "code 12345678", "12345678"],
      ["g8", "api key = mysecretval", "mysecretval"],
    ] as const;
    for (const [id, text] of cases)
      expect(journal.guide("r1", { id, text })).toBe(marker);
    const raw = readFileSync(journal.guidanceFile, "utf8");
    for (const [, , secret] of cases) expect(raw).not.toContain(secret);
    // All 8 guidance slots are full, yet seen ids still persist without error.
    journal.seen("r1", "g_stop");
    journal.seen("r1", "g_refused");
    expect(journal.guided("g_stop")).toBe("r1");
    expect(journal.guided("g_refused")).toBe("r1");
    expect(journal.guidance("r1")).toHaveLength(8);
    // Another reader on the same folder sees the persisted ids.
    const reloaded = new ComputerJournal(home, () => 2);
    expect(reloaded.guided("g_stop")).toBe("r1");
    expect(reloaded.guided("g_refused")).toBe("r1");
    // The file stays version 1 with requests[].said of at most 8 items (readable by ec4496d).
    const parsed = JSON.parse(readFileSync(journal.guidanceFile, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.requests[0].said).toHaveLength(8);
    expect(parsed.requests[0].seen).toEqual(["g_stop", "g_refused"]);
  });

  it("prunes guidance.json when save drops old requests even with no further guidance", () => {
    const home = root();
    const journal = new ComputerJournal(home, () => 1);
    journal.open("r1", "Old task");
    journal.guide("r1", { id: "g1", text: "sensitive context" });
    journal.set("r1", "completed", "done");
    for (let n = 2; n <= 35; n++) {
      journal.open(`r${n}`, "Next");
      journal.set(`r${n}`, "completed", "done");
    }
    expect(journal.get("r1")).toBeNull();
    expect(journal.guidance("r1")).toEqual([]);
    expect(journal.guided("g1")).toBeNull();
    expect(readFileSync(journal.guidanceFile, "utf8")).not.toContain(
      "sensitive context",
    );
  });

  it("sets aside an unreadable guidance.json on clear", () => {
    const home = root();
    const journal = new ComputerJournal(home, () => 9);
    journal.open("r1", "First");
    writeFileSync(journal.guidanceFile, "{ bad json", { mode: 0o600 });
    const result = journal.clear();
    expect(result.setAside).toMatch(/guidance\.unreadable-9\.json$/);
    expect(readFileSync(result.setAside!, "utf8")).toBe("{ bad json");
    expect(existsSync(journal.guidanceFile)).toBe(false);
    expect(journal.guide("r1", { id: "g1", text: "Works again" })).toBe(
      "Works again",
    );
  });

  it("round 2 blocker 6: catches contractions, bare/quoted values, spaced PINs, NFKC full-width, card numbers, wrapped tokens, and invisible joiners without false positives on state words", () => {
    const secrets = [
      "my passcode's 4821",
      "my password's swordfish",
      "passcode 4821",
      'use password "hunter2"',
      "pin 1 2 3 4",
      "use pin \uff11\uff12\uff13\uff14",
      "code \uff14\uff18\uff12\uff19\uff11\uff13",
      "password\uff1aswordfish",
      "my card number is 4532 1234 5678 9010",
      "card 4532-1234-5678-9010",
      "use key sk-12345678\n90abcdefghij",
      "token ghp_abcdef0123\n456789abcdef01",
      "my pass\u200bword\u200bis\u200bswordfish",
      "my pass\u034fword is swordfish",
    ];
    for (const sample of secrets)
      expect(looksSecretStrict(sample), sample).toBe(true);

    const benign = [
      "the password is already filled",
      "the password is saved in Chrome",
      "the pin is not needed",
      "the token is expired",
      "the password is wrong",
      "the password is correct",
      "the password is required",
      "the password is empty",
      "the password is set",
      "open zip code 94107",
      "press the code tab",
      "open the PIN settings",
    ];
    for (const sample of benign)
      expect(looksSecretStrict(sample), sample).toBe(false);
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
