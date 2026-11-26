import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import { Supervisor } from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { focusSession, type Runner } from "../connectors/agents/focus.js";
import {
  boardWithRemotes,
  focusRemote,
  HostBook,
  mergedId,
  remoteBoard,
  RemoteBoards,
  RemoteDesk,
  remoteFailure,
  remoteId,
  remoteLine,
  remoteSend,
  remoteWindowScript,
  shellQuote,
  sshArguments,
  type RemoteHost,
} from "../connectors/agents/hosts.js";
import { inputRoute } from "../connectors/agents/input.js";
import { renderBoard, where } from "../connectors/agents/render.js";
import {
  boardSnapshotSchema,
  type AgentSession,
  type BoardSnapshot,
} from "../connectors/agents/types.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

/**
 * No test here opens a connection. ssh is a recorded command: each test reads
 * the exact argument list that would run, and decides what "the other Mac"
 * prints. The quoting is proven with a local shell, which is what reads it.
 */
const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-hosts-"));
const mini: RemoteHost = {
  name: "mini",
  ssh: "owner@mac.local",
  command: "clawdtime",
  addedAt: now,
};

const session = (values: Partial<AgentSession> = {}): AgentSession => ({
  id: "100-abc",
  pid: 100,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "deploy fix",
  project: "work",
  cwd: "/work/app",
  mode: "interactive",
  state: "working",
  detail: "turn_running",
  since: now - 90_000,
  source: "registry",
  startedAt: now - 3_600_000,
  spawnedBy: null,
  terminal: {
    tty: "ttys001",
    app: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    tmux: null,
    remote: false,
  },
  focus: "tab",
  ...values,
});
const inTmux = (values: Partial<AgentSession> = {}) =>
  session({
    terminal: {
      tty: "ttys004",
      app: "Ghostty",
      appPath: "/Applications/Ghostty.app",
      tmux: {
        session: "work",
        window: 2,
        pane: 1,
        paneId: "%5",
        socketArgs: ["-L", "agents"],
        clientTty: "ttys009",
      },
      remote: false,
    },
    focus: "pane",
    ...values,
  });
const board = (sessions: AgentSession[]): BoardSnapshot => ({
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: {
    needs_you: sessions.filter((item) => item.state === "needs_you").length,
    working: sessions.filter((item) => item.state === "working").length,
    idle: sessions.filter((item) => item.state === "idle").length,
    unknown: sessions.filter((item) => item.state === "unknown").length,
  },
  sessions,
});

interface Call {
  command: string;
  args: string[];
  timeoutMs: number;
}
type Printed = { status: number | null; stdout: string };
function recorder(answer: (call: Call) => Printed | Promise<Printed>) {
  const calls: Call[] = [];
  const run: Runner = async (command, args, timeoutMs) => {
    const call = { command, args, timeoutMs };
    calls.push(call);
    return answer(call);
  };
  return { calls, run };
}
/** What a shell reads from words that were quoted for it: the words again. */
const read = (quoted: string) =>
  execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${quoted}`], {
    encoding: "utf8",
  })
    .split("\0")
    .slice(0, -1);
/** The words that the remote Mac's zsh would run, from one remote line. */
function remoteWords(line: string) {
  expect(line.startsWith("/bin/zsh -lc '")).toBe(true);
  const [inner] = read(line.slice("/bin/zsh -lc ".length));
  return read(inner!);
}
/** The words of a recorded ssh call, after the fixed options and the target. */
function asked(call: Call, host = mini) {
  expect(call.command).toBe("/usr/bin/ssh");
  expect(call.args.slice(0, 7)).toEqual([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "--",
    host.ssh,
  ]);
  expect(call.args).toHaveLength(8);
  const words = remoteWords(call.args[7]!);
  expect(words[0]).toBe(host.command);
  return words.slice(1);
}

describe("host book", () => {
  it("keeps the Macs in one owner-only file", () => {
    const directory = root();
    const book = new HostBook(directory);
    expect(book.list()).toEqual([]);
    expect(book.add({ name: "mini", ssh: "owner@mac.local", at: now })).toEqual(
      mini,
    );
    book.add({
      name: "studio-2",
      ssh: "studio",
      command: "/opt/clawdtime/bin/clawdtime",
      at: now + 1,
    });
    const file = join(directory, "agents", "hosts.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(book.list().map((host) => host.name)).toEqual(["mini", "studio-2"]);
    // The same name again replaces the entry.
    book.add({ name: "mini", ssh: "mini", at: now + 2 });
    expect(book.get("mini")).toMatchObject({ ssh: "mini", addedAt: now + 2 });
    expect(book.list()).toHaveLength(2);
    expect(book.remove("mini")).toBe(true);
    expect(book.remove("mini")).toBe(false);
    expect(book.get("mini")).toBeNull();
    expect(book.get(undefined)).toBeNull();
    // A file that is not a host list gives no host: no Mac is asked.
    writeFileSync(file, '[{"name":"x","ssh":"-oProxyCommand=evil"}]');
    expect(book.list()).toEqual([]);
    writeFileSync(file, "not json");
    expect(book.list()).toEqual([]);
  });

  it("refuses a target or a command that a shell or ssh could read as something else", () => {
    const book = new HostBook(root());
    for (const ssh of [
      "-oProxyCommand=touch /tmp/x",
      "-l root host",
      "host; rm -rf /",
      "host name",
      "$(id)",
      "host`id`",
      "host'quote",
      "a/b",
      "",
      "host\nother",
    ])
      expect(() => book.add({ name: "mini", ssh, at: now })).toThrow(
        "The ssh target is a host alias or user@host",
      );
    for (const command of [
      "-rf",
      "clawdtime; id",
      "clawdtime --flag",
      "~/bin/clawdtime",
      "bin/clawdtime",
      "/opt/../etc/$(id)",
      "/opt//clawdtime",
      "/opt/-x/clawdtime",
      "",
    ])
      expect(() =>
        book.add({ name: "mini", ssh: "mini", command, at: now }),
      ).toThrow("The command is a bare name or an absolute path");
    for (const name of [
      "Mini",
      "bg-1",
      "bg",
      "local",
      "has_underscore",
      "-x",
      "",
      "seventeen-letters",
    ])
      expect(() => book.add({ name, ssh: "mini", at: now })).toThrow(
        "A host name is 1 to 16 characters",
      );
    expect(book.list()).toEqual([]);
    for (let index = 0; index < 16; index++)
      book.add({ name: `m${index}`, ssh: "mini", at: now });
    expect(() => book.add({ name: "one-more", ssh: "mini", at: now })).toThrow(
      "holds 16 Macs",
    );
  });
});

describe("the line for the remote shell", () => {
  it("quotes every word so that a shell reads exactly that word", () => {
    const marker = join(root(), "must-not-exist");
    const words = [
      "it's",
      '"double"',
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      `a; touch ${marker} #`,
      `a && touch ${marker}`,
      "line one\nline two",
      "-n",
      "--always",
      "",
      " spaced  out ",
      "back\\slash",
      "glob * ? [a]",
      "~",
      "$HOME",
      "ünïcödé ✓",
      "'''",
    ];
    expect(read(words.map(shellQuote).join(" "))).toEqual(words);
    // Twice: once for the zsh that runs the command, once for the shell that ssh starts.
    expect(remoteWords(remoteLine(words))).toEqual(words);
    expect(existsSync(marker)).toBe(false);
    expect(shellQuote("a\0b")).toBe("'ab'");
  });

  it("is one fixed ssh argument list: no prompt, a short connect time, the target after --", () => {
    expect(sshArguments(mini, ["agents", "--json", "--local"])).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "--",
      "owner@mac.local",
      "/bin/zsh -lc ''\\''clawdtime'\\'' '\\''agents'\\'' '\\''--json'\\'' '\\''--local'\\'''",
    ]);
    expect(
      remoteWords(
        sshArguments({ ...mini, command: "/opt/clawdtime/bin/clawdtime" }, [
          "agents",
          "send",
          "100-abc",
          "--",
          "--force is 'fine'; $(id)",
        ])[7]!,
      ),
    ).toEqual([
      "/opt/clawdtime/bin/clawdtime",
      "agents",
      "send",
      "100-abc",
      "--",
      "--force is 'fine'; $(id)",
    ]);
    expect(remoteFailure(mini, null)).toBe("No answer in time.");
    expect(remoteFailure(mini, 255)).toContain(
      "It must work with no password prompt: ssh owner@mac.local true",
    );
    expect(remoteFailure(mini, 127)).toContain("--command /full/path");
    expect(remoteFailure(mini, 2)).toContain("status 2");
  });
});

describe("the board of a remote Mac", () => {
  const theirs = board([
    session({ id: "100-abc", name: "api" }),
    inTmux({
      id: "200-def",
      pid: 200,
      name: "migrations",
      state: "needs_you",
      detail: "permission_prompt",
      spawnedBy: "100-abc",
    }),
    session({
      id: "bg-task_7",
      pid: null,
      name: "nightly",
      mode: "background",
      state: "idle",
      detail: "turn_complete",
      focus: "none",
    }),
  ]);

  it("asks ClawdTime there for its own sessions and gives them ids of this Mac", async () => {
    const { calls, run } = recorder(() => ({
      status: 0,
      stdout: JSON.stringify(theirs),
    }));
    const result = await remoteBoard(mini, run);
    expect(calls).toHaveLength(1);
    expect(asked(calls[0]!)).toEqual(["agents", "--json", "--local"]);
    expect(calls[0]!.timeoutMs).toBe(6000);
    if (!result.ok) throw new Error(result.message);
    expect(result.sessions.map((item) => item.id)).toEqual([
      "mini_100-abc",
      "mini_200-def",
      "mini_bg-task_7",
    ]);
    expect(result.sessions.every((item) => item.host === "mini")).toBe(true);
    // The id maps back to the id of the Mac that runs the session.
    expect(result.sessions.map(remoteId)).toEqual([
      "100-abc",
      "200-def",
      "bg-task_7",
    ]);
    expect(remoteId(session())).toBe("100-abc");
    expect(mergedId("mini", "100-abc")).toBe("mini_100-abc");
    expect(result.sessions[1]!.spawnedBy).toBe("mini_100-abc");
    // What a click can open from here: the tmux pane, a shell on that Mac, or nothing.
    expect(result.sessions.map((item) => item.focus)).toEqual([
      "app",
      "pane",
      "none",
    ]);
    // Its terminal fields still describe that Mac.
    expect(result.sessions[1]!.terminal.tmux?.paneId).toBe("%5");
    expect(boardSnapshotSchema.parse(board(result.sessions)).sessions).toEqual(
      result.sessions,
    );
    // No text goes to a remote terminal from here, and no window of this Mac is its window.
    expect(inputRoute(result.sessions[1]!)).toBe("none");
    expect(await focusSession(result.sessions[1]!, run)).toEqual({
      ok: false,
      precision: "none",
    });
    expect(calls).toHaveLength(1);
  });

  it("leaves out what is not that Mac's own, and says why a Mac did not answer", async () => {
    const chained = board([
      session({ id: "100-abc" }),
      session({ id: "other_300-ghi", host: "other" }),
      session({ id: `9${"a".repeat(62)}` }),
    ]);
    const good = await remoteBoard(
      mini,
      recorder(() => ({ status: 0, stdout: JSON.stringify(chained) })).run,
    );
    expect(good.ok && good.sessions.map((item) => item.id)).toEqual([
      "mini_100-abc",
    ]);
    const failed = async (printed: Printed) =>
      remoteBoard(mini, recorder(() => printed).run);
    expect(await failed({ status: 255, stdout: "" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("ssh could not connect"),
    });
    expect(await failed({ status: null, stdout: "" })).toEqual({
      ok: false,
      message: "No answer in time.",
    });
    expect(await failed({ status: 127, stdout: "" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("was not found there"),
    });
    for (const stdout of [
      "",
      "Welcome to mini\n",
      "{}",
      JSON.stringify({ ...theirs, version: 2 }),
    ])
      expect(await failed({ status: 0, stdout })).toEqual({
        ok: false,
        message:
          "Its answer was not a board. Both Macs need the same ClawdTime version.",
      });
  });

  it("merges into this Mac's board, most urgent first, with a line for each Mac", async () => {
    const directory = root();
    const book = new HostBook(directory);
    book.add({ name: "mini", ssh: "owner@mac.local", at: now });
    let clock = now;
    const { calls, run } = recorder(() => ({
      status: 0,
      stdout: JSON.stringify(theirs),
    }));
    const remotes = new RemoteBoards({ book, run, now: () => clock });
    const mine = board([session({ id: "300-loc", name: "docs" })]);
    // Before any answer the board of this Mac is whole, and the Mac shows as not asked.
    const first = remotes.poll();
    expect(remotes.merge(mine)).toEqual({
      ...mine,
      hosts: [
        {
          name: "mini",
          ok: false,
          sessions: 0,
          checkedAt: null,
          message: "Not asked yet.",
        },
      ],
    });
    await first;
    const merged = remotes.merge(mine);
    expect(merged.sessions.map((item) => item.id)).toEqual([
      "mini_200-def",
      "300-loc",
      "mini_100-abc",
      "mini_bg-task_7",
    ]);
    expect(merged.counts).toEqual({
      needs_you: 1,
      working: 2,
      idle: 1,
      unknown: 0,
    });
    expect(merged.hosts).toEqual([
      { name: "mini", ok: true, sessions: 3, checkedAt: now, message: "" },
    ]);
    expect(boardSnapshotSchema.parse(merged)).toEqual(merged);
    // Its own rhythm: nine seconds between two calls to one Mac.
    expect(calls).toHaveLength(1);
    clock = now + 8999;
    await remotes.poll();
    expect(calls).toHaveLength(1);
    clock = now + 9000;
    await remotes.poll();
    expect(calls).toHaveLength(2);
    // A Mac that leaves the book leaves the board.
    book.remove("mini");
    await remotes.poll();
    expect(remotes.merge(mine)).toEqual(mine);
    // With no Mac in the book nothing changes and nothing is asked.
    expect(new RemoteBoards({ book, run, now: () => clock }).merge(mine)).toBe(
      mine,
    );
    expect(calls).toHaveLength(2);
  });

  it("never waits for a Mac, never asks it twice at once, and drops an old answer", async () => {
    const directory = root();
    const book = new HostBook(directory);
    book.add({ name: "mini", ssh: "owner@mac.local", at: now });
    book.add({ name: "studio", ssh: "studio", at: now });
    let clock = now;
    let release: ((printed: Printed) => void) | undefined;
    let mode: "good" | "hang" | "fail" | "junk" = "good";
    const { calls, run } = recorder((call) => {
      if (call.args[6] === "studio") return { status: 255, stdout: "" };
      if (mode === "hang")
        return new Promise<Printed>((done) => (release = done));
      if (mode === "fail") return { status: null, stdout: "" };
      if (mode === "junk") return { status: 0, stdout: "<html>" };
      return { status: 0, stdout: JSON.stringify(theirs) };
    });
    const remotes = new RemoteBoards({ book, run, now: () => clock });
    const mine = board([session({ id: "300-loc" })]);
    await remotes.poll();
    let merged = remotes.merge(mine);
    // One Mac answers and one does not: the board holds this Mac and the one that answered.
    expect(merged.sessions).toHaveLength(4);
    expect(merged.hosts).toEqual([
      { name: "mini", ok: true, sessions: 3, checkedAt: now, message: "" },
      {
        name: "studio",
        ok: false,
        sessions: 0,
        checkedAt: now,
        message: expect.stringContaining("ssh could not connect"),
      },
    ]);
    // The next call to mini hangs. Polls go on; mini is not asked again while that call is open.
    const tick = () => new Promise((done) => setImmediate(done));
    mode = "hang";
    clock = now + 9000;
    void remotes.poll();
    await tick();
    const afterFirst = calls.length;
    clock = now + 18_000;
    void remotes.poll();
    await tick();
    clock = now + 27_000;
    void remotes.poll();
    await tick();
    expect(calls.filter((call) => call.args[6] === mini.ssh)).toHaveLength(2);
    // The other Mac is still asked on its rhythm: one that hangs holds up no other.
    expect(calls.length).toBe(afterFirst + 2);
    // Meanwhile the last good answer still shows, with this Mac's sessions.
    merged = remotes.merge(mine);
    expect(merged.sessions).toHaveLength(4);
    expect(merged.hosts![0]).toMatchObject({ ok: true, sessions: 3 });
    // Thirty seconds after that answer it is too old to show.
    clock = now + 30_001;
    merged = remotes.merge(mine);
    expect(merged.sessions.map((item) => item.id)).toEqual(["300-loc"]);
    expect(merged.counts).toEqual(mine.counts);
    expect(merged.hosts![0]).toEqual({
      name: "mini",
      ok: false,
      sessions: 0,
      checkedAt: now,
      message: "No answer for some time.",
    });
    // The hung call ends as a timeout: the reason shows, and the Mac is asked again.
    release!({ status: null, stdout: "" });
    await new Promise((done) => setImmediate(done));
    expect(remotes.merge(mine).hosts![0]).toMatchObject({
      ok: false,
      message: "No answer in time.",
    });
    mode = "junk";
    clock = now + 40_000;
    await remotes.poll();
    expect(remotes.merge(mine).hosts![0]).toMatchObject({
      ok: false,
      sessions: 0,
      message: expect.stringContaining("was not a board"),
    });
    expect(remotes.merge(mine).sessions).toEqual(mine.sessions);
    mode = "good";
    clock = now + 50_000;
    await remotes.poll();
    expect(remotes.merge(mine).hosts![0]).toMatchObject({
      ok: true,
      sessions: 3,
      message: "",
    });
    // A runner that throws counts as no answer. Nothing else breaks.
    const thrown = new RemoteBoards({
      book,
      run: async () => {
        throw new Error("spawn failed");
      },
      now: () => clock,
    });
    await thrown.poll();
    expect(thrown.merge(mine).sessions).toEqual(mine.sessions);
    expect(thrown.merge(mine).hosts![0]).toMatchObject({
      ok: false,
      message: "No answer.",
    });
  });

  it("gives the one-shot commands the whole board, or one Mac", async () => {
    const book = new HostBook(root());
    book.add({ name: "mini", ssh: "owner@mac.local", at: now });
    book.add({ name: "studio", ssh: "studio", at: now });
    const { calls, run } = recorder((call) =>
      call.args[6] === "studio"
        ? { status: 0, stdout: JSON.stringify(board([session({ id: "7-s" })])) }
        : { status: 0, stdout: JSON.stringify(theirs) },
    );
    const mine = board([session({ id: "300-loc" })]);
    const all = await boardWithRemotes(mine, book, run, () => now);
    expect(all.sessions).toHaveLength(5);
    expect(all.hosts!.map((host) => host.name)).toEqual(["mini", "studio"]);
    expect(calls).toHaveLength(2);
    const one = await boardWithRemotes(mine, book, run, () => now, "studio");
    expect(one.sessions.map((item) => item.id)).toEqual(["studio_7-s"]);
    expect(one.hosts).toEqual([
      { name: "studio", ok: true, sessions: 1, checkedAt: now, message: "" },
    ]);
    expect(one.counts).toEqual({
      needs_you: 0,
      working: 1,
      idle: 0,
      unknown: 0,
    });
    expect(calls).toHaveLength(3);
  });
});

describe("what agents on a remote Mac ask", () => {
  const request = (values: Record<string, unknown> = {}) => ({
    version: 1,
    id: "0123456789abcdef",
    agent: "claude-code",
    sessionKey: "a".repeat(32),
    cwd: "/work/app",
    pids: [200],
    kind: "permission",
    tool: "Bash",
    summary: "git push origin main",
    pattern: "Bash:git push",
    options: [],
    createdAt: now - 4000,
    holdUntil: now + 40_000,
    ...values,
  });
  const listing = (...requests: unknown[]) =>
    JSON.stringify({ away: false, attended: true, pending: requests });

  it("reads the list there, which also says that someone attends, and sends each answer to that Mac", async () => {
    const book = new HostBook(root());
    book.add({ name: "mini", ssh: "owner@mac.local", at: now });
    let clock = now;
    let status = 0;
    const question = request({
      id: "fedcba9876543210",
      kind: "question",
      tool: "AskUserQuestion",
      summary: "Which branch?",
      pattern: "AskUserQuestion",
      options: ["main", "release"],
    });
    const { calls, run } = recorder((call) =>
      asked(call)[1] === "pending"
        ? { status: 0, stdout: listing(request(), question) }
        : { status, stdout: "" },
    );
    const desk = new RemoteDesk({ book, run, now: () => clock });
    expect(desk.pending()).toEqual([]);
    await desk.poll();
    expect(asked(calls[0]!)).toEqual([
      "agents",
      "pending",
      "--json",
      "--attend",
    ]);
    expect(desk.pending().map((item) => [item.host, item.id])).toEqual([
      ["mini", "0123456789abcdef"],
      ["mini", "fedcba9876543210"],
    ]);
    // Every four seconds while someone reads: well inside the ten seconds that a hook waits for.
    clock = now + 3999;
    await desk.poll();
    expect(calls).toHaveLength(1);
    // An answer goes to the Mac that asked, with the id that Mac knows.
    expect(
      await desk.answer({
        id: "0123456789abcdef",
        decision: "allow",
        remember: true,
      }),
    ).toBe(true);
    expect(asked(calls[1]!)).toEqual([
      "agents",
      "approve",
      "0123456789abcdef",
      "--always",
    ]);
    expect(calls[1]!.timeoutMs).toBe(10_000);
    // It is answered, so it is gone here before the next read.
    expect(desk.pending().map((item) => item.id)).toEqual(["fedcba9876543210"]);
    expect(
      await desk.answer({ id: "0123456789abcdef", decision: "allow" }),
    ).toBe(false);
    expect(calls).toHaveLength(2);
    // The text of an answer is one argument, whatever it holds.
    expect(
      await desk.answer({
        id: "fedcba9876543210",
        decision: "answer",
        text: '--release; it\'s "the" one $(id)',
      }),
    ).toBe(true);
    expect(asked(calls[2]!)).toEqual([
      "agents",
      "answer",
      "fedcba9876543210",
      "--",
      '--release; it\'s "the" one $(id)',
    ]);
    expect(desk.pending()).toEqual([]);
    // A denial with a reason, and one without. A failed call leaves the request.
    clock = now + 4000;
    await desk.poll();
    expect(
      await desk.answer({
        id: "0123456789abcdef",
        decision: "deny",
        text: "not on a Friday\u0007",
      }),
    ).toBe(true);
    expect(asked(calls.at(-1)!)).toEqual([
      "agents",
      "deny",
      "0123456789abcdef",
      "--message",
      "not on a Friday",
    ]);
    expect(
      await desk.answer({
        id: "fedcba9876543210",
        decision: "answer",
        text: " ",
      }),
    ).toBe(false);
    status = 2;
    const before = calls.length;
    expect(
      await desk.answer({ id: "fedcba9876543210", decision: "deny" }),
    ).toBe(false);
    expect(asked(calls.at(-1)!)).toEqual([
      "agents",
      "deny",
      "fedcba9876543210",
    ]);
    expect(calls).toHaveLength(before + 1);
    expect(desk.pending().map((item) => item.id)).toEqual(["fedcba9876543210"]);
    // A request past its hold time is no longer shown.
    clock = now + 40_001;
    expect(desk.pending()).toEqual([]);
  });

  it("shows nothing from a Mac that does not answer or prints something else", async () => {
    const book = new HostBook(root());
    book.add({ name: "mini", ssh: "owner@mac.local", at: now });
    let clock = now;
    let printed: Printed = { status: 0, stdout: listing(request()) };
    const { run } = recorder(() => printed);
    const desk = new RemoteDesk({ book, run, now: () => clock });
    await desk.poll();
    expect(desk.pending()).toHaveLength(1);
    for (const next of [
      { status: 255, stdout: "" },
      { status: 0, stdout: "motd" },
      { status: 0, stdout: JSON.stringify({ pending: [{ id: "x" }] }) },
    ]) {
      printed = next;
      clock += 4000;
      await desk.poll();
    }
    // The last good list ages out after twelve seconds.
    expect(desk.pending()).toHaveLength(1);
    clock = now + 12_001;
    expect(desk.pending()).toEqual([]);
  });

  it("joins the requests of this Mac in the panel's list, and the panel's answer finds its Mac", async () => {
    const directory = root();
    new HostBook(directory).add({
      name: "mini",
      ssh: "owner@mac.local",
      at: now,
    });
    const { calls, run } = recorder((call) => {
      if (call.command !== "/usr/bin/ssh") return { status: 0, stdout: "" };
      return asked(call)[1] === "pending"
        ? { status: 0, stdout: listing(request()) }
        : { status: 0, stdout: "" };
    });
    const feed = new BoardFeed({
      root: directory,
      now: () => now,
      runner: run,
    });
    const theirs = inTmux({
      id: "mini_200-def",
      pid: 200,
      name: "migrations",
      host: "mini",
      state: "needs_you",
      detail: "permission_prompt",
    });
    feed.receive(
      `${JSON.stringify({ ...board([theirs, session({ id: "300-loc", pid: 200 })]), hosts: [{ name: "mini", ok: true, sessions: 1, checkedAt: now, message: "" }] })}\n`,
    );
    expect(feed.snapshot()?.sessions).toHaveLength(2);
    const local = new DecisionDesk(directory, () => now).open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [200],
      described: {
        kind: "permission",
        tool: "Bash",
        summary: "npm test",
        options: [],
      },
      holdSeconds: 45,
    });
    // The first read starts the call to the other Mac and does not wait for it.
    expect(feed.decisions().pending.map((item) => item.id)).toEqual([local.id]);
    await new Promise((done) => setImmediate(done));
    const view = feed.decisions();
    expect(view.pending).toHaveLength(2);
    // The same pid on two Macs: each request finds the session of its own Mac.
    expect(view.pending[0]).toMatchObject({
      id: local.id,
      sessionId: "300-loc",
    });
    expect(view.pending[0]).not.toHaveProperty("host");
    expect(view.pending[1]).toMatchObject({
      id: "0123456789abcdef",
      host: "mini",
      session: "migrations",
      sessionId: "mini_200-def",
      summary: "git push origin main",
      project: "app",
      canRemember: true,
      allowedBefore: 0,
      deniedBefore: 0,
    });
    const sshCalls = () =>
      calls.filter((call) => call.command === "/usr/bin/ssh");
    expect(sshCalls()).toHaveLength(1);
    // The answer for this Mac stays here; the answer for the other Mac goes there.
    expect(feed.answer({ id: local.id, decision: "deny" })).toBe(true);
    expect(sshCalls()).toHaveLength(1);
    expect(
      await feed.answer({ id: "0123456789abcdef", decision: "allow" }),
    ).toBe(true);
    expect(asked(sshCalls()[1]!)).toEqual([
      "agents",
      "approve",
      "0123456789abcdef",
    ]);
    expect(feed.decisions().pending).toEqual([]);

    // Text for a session of the other Mac is typed by ClawdTime there.
    expect(await feed.send("mini_200-def", "run the tests", true)).toEqual({
      ok: true,
      route: "remote",
    });
    expect(asked(sshCalls().at(-1)!)).toEqual([
      "agents",
      "send",
      "200-def",
      "--",
      "run the tests",
    ]);
    // A click opens a new window on that Mac's tmux pane.
    expect(await feed.focus("mini_200-def")).toEqual({
      ok: true,
      precision: "remote_pane",
    });
    expect(calls.at(-1)).toEqual({
      command: "/usr/bin/open",
      args: [join(directory, "agents", "remote", "mini.command")],
      timeoutMs: 5000,
    });
    // A session of a Mac that left the book cannot be reached.
    new HostBook(directory).remove("mini");
    const count = calls.length;
    expect(await feed.focus("mini_200-def")).toEqual({
      ok: false,
      precision: "none",
    });
    expect(await feed.send("mini_200-def", "hello", true)).toEqual({
      ok: false,
      route: "none",
    });
    expect(calls).toHaveLength(count);
  });
});

describe("text and windows for a remote session", () => {
  it("types through ClawdTime on that Mac, as one argument after --", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "" }));
    const theirs = inTmux({ id: "mini_200-def", host: "mini" });
    expect(
      await remoteSend(
        mini,
        theirs,
        "--no-verify; it's $(id)\u001b[31m",
        false,
        run,
      ),
    ).toEqual({ ok: true, route: "remote" });
    expect(asked(calls[0]!)).toEqual([
      "agents",
      "send",
      "200-def",
      "--no-enter",
      "--",
      "--no-verify; it's $(id)[31m",
    ]);
    expect(await remoteSend(mini, theirs, " \u0007 ", true, run)).toEqual({
      ok: false,
      route: "none",
    });
    expect(calls).toHaveLength(1);
    // Text that must not be sent off holds no line break on the way there either.
    await remoteSend(mini, theirs, "one\ntwo\r\nthree", false, run);
    expect(asked(calls[1]!)).toEqual([
      "agents",
      "send",
      "200-def",
      "--no-enter",
      "--",
      "one two three",
    ]);
    calls.length = 1;
    const failing = recorder(() => ({ status: 2, stdout: "" }));
    expect(await remoteSend(mini, theirs, "hello", true, failing.run)).toEqual({
      ok: false,
      route: "remote",
    });
  });

  it("opens a new window: on the tmux pane when there is one, else a shell on that Mac", async () => {
    const directory = root();
    const { calls, run } = recorder(() => ({ status: 0, stdout: "" }));
    const pane = inTmux({ id: "mini_200-def", host: "mini" });
    expect(await focusRemote(mini, pane, run, directory)).toEqual({
      ok: true,
      precision: "remote_pane",
    });
    const file = join(directory, "agents", "remote", "mini.command");
    expect(calls).toEqual([
      { command: "/usr/bin/open", args: [file], timeoutMs: 5000 },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "agents", "remote")).mode & 0o777).toBe(
      0o700,
    );
    const text = readFileSync(file, "utf8");
    expect(text).toBe(remoteWindowScript(mini, pane).text);
    const lines = text.split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[2]!.startsWith("exec ")).toBe(true);
    // What the local shell hands to ssh, and what the remote zsh then runs.
    const argv = read(lines[2]!.slice("exec ".length));
    expect(argv.slice(0, 4)).toEqual([
      "/usr/bin/ssh",
      "-t",
      "--",
      "owner@mac.local",
    ]);
    expect(argv).toHaveLength(5);
    expect(remoteWords(argv[4]!)).toEqual([
      "tmux",
      "-L",
      "agents",
      "attach-session",
      "-t",
      "%5",
      ";",
      "select-window",
      "-t",
      "%5",
      ";",
      "select-pane",
      "-t",
      "%5",
    ]);
    // A socket path with a space and a quote is still one word.
    const odd = inTmux({ id: "mini_1-a", host: "mini" });
    odd.terminal.tmux!.socketArgs = ["-S", "/tmp/it's a socket"];
    const oddArgv = read(
      remoteWindowScript(mini, odd).text.split("\n")[2]!.slice(5),
    );
    expect(remoteWords(oddArgv[4]!).slice(0, 3)).toEqual([
      "tmux",
      "-S",
      "/tmp/it's a socket",
    ]);

    // Not in tmux: a running program cannot be attached to, so it is a shell on that Mac.
    const plain = session({ id: "mini_100-abc", host: "mini", focus: "app" });
    expect(await focusRemote(mini, plain, run, directory)).toEqual({
      ok: true,
      precision: "remote_mac",
    });
    expect(readFileSync(file, "utf8").split("\n")[2]).toBe(
      "exec '/usr/bin/ssh' '-t' '--' 'owner@mac.local'",
    );
    // Nothing to open for a run with no person at a terminal.
    const count = calls.length;
    expect(
      await focusRemote(
        mini,
        session({ host: "mini", focus: "none" }),
        run,
        directory,
      ),
    ).toEqual({ ok: false, precision: "none" });
    expect(calls).toHaveLength(count);
    // A window that could not open is reported as nothing.
    expect(
      await focusRemote(
        mini,
        pane,
        recorder(() => ({ status: 1, stdout: "" })).run,
        directory,
      ),
    ).toEqual({ ok: false, precision: "none" });
    // The script is only ever a regular file of its owner.
    const other = root();
    mkdirSync(join(other, "agents", "remote", "mini.command"), {
      recursive: true,
    });
    expect(await focusRemote(mini, pane, run, other)).toEqual({
      ok: false,
      precision: "none",
    });
    expect(calls).toHaveLength(count);
  });

  it("shows the Mac in the board's place column", () => {
    const pane = inTmux({ id: "mini_200-def", host: "mini" });
    expect(where(pane)).toBe("on mini · tmux work:2.1");
    expect(where(session({ host: "mini" }))).toBe("on mini · ttys001");
    expect(where(session({ host: "mini", mode: "background" }))).toBe(
      "on mini · background",
    );
    expect(where(session())).toBe("Terminal · ttys001");
    expect(
      renderBoard(board([pane]), { color: false, width: 120, now }),
    ).toContain("on mini · tmux work:2.1");
  });
});

describe("commands", () => {
  const theirs = board([
    inTmux({
      id: "200-def",
      pid: 200,
      name: "migrations",
      state: "needs_you",
      detail: "permission_prompt",
    }),
  ]);
  function setup(
    answer: (call: Call) => Printed = () => ({
      status: 0,
      stdout: JSON.stringify(theirs),
    }),
  ) {
    const directory = root();
    const lines: string[] = [];
    const { calls, run } = recorder(answer);
    const system = fakeSystem({
      now,
      env: { CLAWDTIME_CONFIG_HOME: directory, PATH: "/usr/bin" },
    });
    const cli = (...args: string[]) =>
      agentsCli(args, {
        system,
        runner: run,
        print: (line) => lines.push(line),
        hookScript: "/x.js",
        isTTY: false,
        columns: 120,
      });
    return { directory, lines, calls, cli };
  }

  it("adds, lists, checks and removes a Mac", async () => {
    const { directory, lines, calls, cli } = setup();
    await cli("--hosts");
    expect(lines.pop()).toBe(
      "No remote Mac. Add one: clawdtime hosts add NAME SSH_TARGET",
    );
    await cli("--hosts", "add", "mini", "owner@mac.local");
    expect(lines.pop()).toBe(
      "Added mini (owner@mac.local). Check it: clawdtime hosts check mini",
    );
    await cli(
      "--hosts",
      "add",
      "studio",
      "--command",
      "/opt/clawdtime/bin/clawdtime",
      "studio.lan",
    );
    expect(new HostBook(directory).get("studio")).toMatchObject({
      ssh: "studio.lan",
      command: "/opt/clawdtime/bin/clawdtime",
    });
    lines.length = 0;
    await cli("--hosts", "list");
    expect(lines).toEqual([
      "mini             owner@mac.local",
      "studio           studio.lan  (/opt/clawdtime/bin/clawdtime)",
    ]);
    // Adding and listing ask no Mac.
    expect(calls).toEqual([]);
    await cli("--hosts", "check", "mini");
    expect(calls).toHaveLength(1);
    expect(asked(calls[0]!)).toEqual(["agents", "--json", "--local"]);
    expect(lines.pop()).toBe(
      "mini answered over ssh: 1 session (1 needs you).",
    );
    await cli("--hosts", "remove", "studio");
    expect(lines.pop()).toBe(
      "Removed studio. Nothing was changed on that Mac.",
    );
    expect(new HostBook(directory).list().map((host) => host.name)).toEqual([
      "mini",
    ]);
    await expect(cli("--hosts", "check", "studio")).rejects.toThrow(
      'No remote Mac is named "studio"',
    );
    await expect(cli("--hosts", "remove")).rejects.toThrow(
      "Use: clawdtime hosts remove NAME",
    );
    await expect(cli("--hosts", "add", "mini")).rejects.toThrow(
      "Use: clawdtime hosts add NAME SSH_TARGET",
    );
    await expect(
      cli("--hosts", "add", "mini", "-oProxyCommand=x"),
    ).rejects.toThrow("The ssh target");
    await expect(cli("--hosts", "sync")).rejects.toThrow(
      "Use: clawdtime hosts add|list|check|remove",
    );
    await cli("--hosts", "help");
    expect(lines.pop()).toContain("hosts add NAME SSH_TARGET");
    expect(calls).toHaveLength(1);
  });

  it("says when a Mac does not answer, with what to do", async () => {
    const { lines, cli } = setup(() => ({ status: 255, stdout: "" }));
    await cli("--hosts", "add", "mini", "owner@mac.local");
    const before = process.exitCode;
    await cli("--hosts", "check", "mini");
    expect(process.exitCode).toBe(2);
    process.exitCode = before;
    expect(lines.pop()).toBe(
      "mini did not answer. ssh could not connect. It must work with no password prompt: ssh owner@mac.local true",
    );
    lines.length = 0;
    await cli();
    expect(lines.at(-1)).toContain(
      "mini did not answer. ssh could not connect.",
    );
    expect(lines[0]).toContain("no agent sessions");
  });

  it("lists every Mac, this Mac only, or one remote Mac", async () => {
    const { lines, calls, cli } = setup();
    await cli("--hosts", "add", "mini", "owner@mac.local");
    lines.length = 0;
    await cli();
    expect(calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Agents  1 needs you");
    expect(lines[0]).toContain("migrations");
    expect(lines[0]).toContain("on mini · tmux work:2.1");
    // --local asks no Mac. A Mac asked over ssh is asked with --local, so Macs never ask in a circle.
    lines.length = 0;
    await cli("--local");
    expect(calls).toHaveLength(1);
    expect(lines[0]).toContain("no agent sessions");
    await cli("--json", "--host", "mini");
    const printed = boardSnapshotSchema.parse(JSON.parse(lines.pop()!));
    expect(printed.sessions.map((item) => item.id)).toEqual(["mini_200-def"]);
    expect(printed.hosts).toEqual([
      { name: "mini", ok: true, sessions: 1, checkedAt: now, message: "" },
    ]);
    await expect(cli("--host", "studio")).rejects.toThrow(
      'No remote Mac is named "studio"',
    );
    expect(calls).toHaveLength(2);
  });

  it("opens and types into a session of a remote Mac by its name", async () => {
    const { directory, lines, calls, cli } = setup((call) =>
      call.command === "/usr/bin/ssh" && asked(call)[1] === "--json"
        ? { status: 0, stdout: JSON.stringify(theirs) }
        : { status: 0, stdout: "" },
    );
    await cli("--hosts", "add", "mini", "owner@mac.local");
    lines.length = 0;
    await cli("focus", "migrations");
    expect(lines.pop()).toBe(
      "Focused migrations: its tmux pane on that Mac, in a new window.",
    );
    expect(calls.at(-1)).toEqual({
      command: "/usr/bin/open",
      args: [join(directory, "agents", "remote", "mini.command")],
      timeoutMs: 5000,
    });
    await cli("send", "mini_200-def", "--", "--force is fine");
    expect(lines.pop()).toBe("Typed into migrations on mini.");
    expect(asked(calls.at(-1)!)).toEqual([
      "agents",
      "send",
      "200-def",
      "--",
      "--force is fine",
    ]);
  });

  it("marks the desk as attended when another Mac reads the list for a person", async () => {
    const { directory, lines, cli } = setup();
    const desk = new DecisionDesk(directory, () => now);
    await cli("pending", "--json");
    expect(JSON.parse(lines.pop()!)).toEqual({
      away: false,
      attended: false,
      pending: [],
    });
    expect(desk.attended()).toBe(false);
    await cli("pending", "--json", "--attend");
    expect(JSON.parse(lines.pop()!)).toMatchObject({ attended: true });
    expect(desk.attended()).toBe(true);
  });

  it("takes text that starts with dashes after --, on this Mac too", async () => {
    const { lines, cli } = setup();
    // No session here: the text reaches the session lookup whole, and is not read as an option.
    await expect(cli("send", "nobody", "--", "--force", "it")).rejects.toThrow(
      'No session matches "nobody".',
    );
    await expect(cli("send", "nobody", "--force")).rejects.toThrow(
      "Unknown option --force",
    );
    expect(lines).toEqual([]);
  });
});

describe("the ClawdTime agent", () => {
  it("says which Mac a session is on", () => {
    const directory = root();
    const sessions = [
      inTmux({ id: "mini_200-def", host: "mini", name: "migrations" }),
      session({ id: "300-loc", name: "docs" }),
    ];
    const status = new Supervisor(
      {
        now: () => now,
        board: () => board(sessions),
        desk: new DecisionDesk(directory, () => now),
        focus: async () => ({ ok: true }),
        send: async () => ({ ok: true, route: "tmux" }),
        clis: () => [],
      },
      null,
    ).status();
    expect(status).toContain(
      "- migrations (Claude Code on the Mac mini): working for 1m",
    );
    expect(status).toContain("- docs (Claude Code): working for 1m");
  });
});
