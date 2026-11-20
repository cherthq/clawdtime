import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realSystem } from "../connectors/agents/system.js";
import { BoardScanner } from "../connectors/agents/board.js";
import { identify } from "../connectors/agents/catalog.js";
import {
  assignFiles,
  claudeEvidence,
  cleanName,
  codexEvidence,
  piDirectory,
  piEvidence,
  reduce,
} from "../connectors/agents/evidence.js";
import {
  ancestors,
  cpuSeconds,
  parseProcesses,
  processTree,
  readProcesses,
  type ProcessFact,
} from "../connectors/agents/processes.js";
import {
  appVersion,
  focusPrecision,
  readTmux,
  tmuxSocket,
} from "../connectors/agents/terminals.js";
import { boardSnapshotSchema } from "../connectors/agents/types.js";
import {
  fakeSystem,
  jsonl,
  psListings,
  type FakeProcess,
} from "./connectors-agents-fixture.js";

const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const minute = 60_000;
const fact = (values: Partial<ProcessFact> & { exe: string }): ProcessFact => ({
  pid: 100,
  ppid: 50,
  tty: "ttys001",
  foreground: true,
  startedAt: now - 10 * minute,
  cpuSeconds: 1,
  command: values.exe,
  ...values,
});

describe("process listing", () => {
  it("joins the two ps listings and reads start time, terminal and arguments", () => {
    const processes: FakeProcess[] = [
      {
        pid: 71837,
        ppid: 71828,
        tty: "ttys012",
        startedAt: now - 5 * minute,
        exe: "claude",
        command:
          "claude --allow-dangerously-skip-permissions --resume my session",
      },
      {
        pid: 17686,
        ppid: 1,
        startedAt: now - 60 * minute,
        exe: "/Users/tester/.codex/bin/codex",
        command: "/Users/tester/.codex/bin/codex app-server daemon",
        foreground: false,
      },
    ];
    const { stats, commands } = psListings(processes);
    const parsed = parseProcesses(stats, commands);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      pid: 71837,
      ppid: 71828,
      tty: "ttys012",
      foreground: true,
      startedAt: now - 5 * minute,
      exe: "claude",
      command:
        "claude --allow-dangerously-skip-permissions --resume my session",
    });
    expect(parsed[1]).toMatchObject({ tty: null, foreground: false });
    // A process that ended between the two listings is dropped, not half-read.
    expect(parseProcesses(stats, commands.split("\n")[0]!)).toHaveLength(1);
  });

  it("reads cumulative CPU in every form ps prints", () => {
    expect(cpuSeconds("0:31.25")).toBeCloseTo(31.25);
    expect(cpuSeconds("6:30.82")).toBeCloseTo(390.82);
    expect(cpuSeconds("1:02:03")).toBe(3723);
    expect(cpuSeconds("2-01:00:00")).toBe(2 * 86_400 + 3600);
    expect(cpuSeconds("garbage")).toBe(0);
  });

  it("walks ancestors nearest first and stops on a loop", () => {
    const tree = processTree([
      fact({ pid: 3, ppid: 2, exe: "claude" }),
      fact({ pid: 2, ppid: 1, exe: "zsh" }),
      fact({ pid: 1, ppid: 3, exe: "loop" }),
    ]);
    expect(ancestors(tree, 3).map((process) => process.pid)).toEqual([2, 1]);
  });
});

describe("agent catalog", () => {
  const cases: [string, Partial<ProcessFact> & { exe: string }, unknown][] = [
    [
      "an interactive session",
      { exe: "claude", command: "claude --resume x" },
      { kind: "claude-code", headless: false },
    ],
    [
      "a one-shot run",
      { exe: "claude", command: "claude -p summarize" },
      { kind: "claude-code", headless: true },
    ],
    [
      "a helper subcommand",
      { exe: "claude", command: "claude mcp serve" },
      null,
    ],
    [
      "a daemon with no terminal",
      {
        exe: "/x/bin/codex",
        command: "/x/bin/codex app-server --listen unix://",
        tty: null,
      },
      null,
    ],
    [
      "a session with no terminal and no one-shot flag",
      { exe: "codex", command: "codex", tty: null },
      null,
    ],
    [
      "codex exec with no terminal",
      { exe: "codex", command: "codex exec fix it", tty: null },
      { kind: "codex", headless: true },
    ],
    [
      "a runtime that started the package by path",
      {
        exe: "node",
        command: "node /opt/lib/node_modules/@google/gemini-cli/dist/index.js",
      },
      { kind: "gemini", headless: false },
    ],
    [
      "a runtime that started a launcher script",
      { exe: "node", command: "node --no-warnings /opt/homebrew/bin/dexter" },
      { kind: "dexter", headless: false },
    ],
    [
      "a process that renamed itself",
      { exe: "dexter", command: "dexter" },
      { kind: "dexter", headless: false },
    ],
    [
      "an unrelated node program",
      { exe: "node", command: "node server.js pi" },
      null,
    ],
    ["an unrelated program", { exe: "/bin/zsh", command: "-zsh" }, null],
    [
      "a language server under a session",
      { exe: "/usr/bin/sourcekit-lsp", command: "/usr/bin/sourcekit-lsp" },
      null,
    ],
  ];
  it.each(cases)("identifies %s", (_name, values, expected) => {
    const result = identify(fact(values));
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatchObject(expected as object);
  });
});

describe("state evidence", () => {
  it("maps every Claude Code status and waiting reason", () => {
    const at = now - minute;
    const state = (record: Record<string, unknown>) => {
      const { state, detail } = claudeEvidence(
        { statusUpdatedAt: at, ...record },
        now,
      );
      return `${state}/${detail}`;
    };
    expect(state({ status: "busy" })).toBe("working/turn_running");
    expect(state({ status: "shell" })).toBe("working/background_shell");
    expect(state({ status: "idle" })).toBe("idle/turn_complete");
    expect(state({ status: "waiting", waitingFor: "permission prompt" })).toBe(
      "needs_you/permission_prompt",
    );
    expect(state({ status: "waiting", waitingFor: "sandbox request" })).toBe(
      "needs_you/permission_prompt",
    );
    expect(state({ status: "waiting", waitingFor: "input needed" })).toBe(
      "needs_you/question",
    );
    expect(state({ status: "waiting", waitingFor: "something new" })).toBe(
      "needs_you/question",
    );
    expect(state({ state: "blocked" })).toBe("needs_you/question");
    expect(state({ state: "failed" })).toBe("idle/turn_failed");
    expect(state({ status: "a later release adds this" })).toBe(
      "unknown/unrecognized",
    );
    expect(
      claudeEvidence({ status: "busy", statusUpdatedAt: at }, now),
    ).toMatchObject({ since: at, at, source: "registry" });
  });

  it("reads a pi session from its last message and never returns its text", () => {
    const message = (role: string, stopReason?: string) => ({
      type: "message",
      timestamp: new Date(now - minute).toISOString(),
      message: {
        role,
        stopReason,
        content: [{ type: "text", text: "SECRET" }],
      },
    });
    const state = (...records: unknown[]) => {
      const evidence = piEvidence(jsonl(...records), now);
      expect(JSON.stringify(evidence)).not.toContain("SECRET");
      return evidence && `${evidence.state}/${evidence.detail}`;
    };
    expect(state(message("user"))).toBe("working/turn_running");
    expect(state(message("assistant", "toolUse"))).toBe("working/tool_running");
    expect(state(message("assistant", "toolUse"), message("toolResult"))).toBe(
      "working/turn_running",
    );
    expect(state(message("assistant", "stop"))).toBe("idle/turn_complete");
    expect(state(message("assistant", "error"))).toBe("idle/turn_failed");
    expect(state(message("assistant", "aborted"))).toBe(
      "idle/turn_interrupted",
    );
    expect(state(message("assistant", "stop"), { type: "model_change" })).toBe(
      "idle/turn_complete",
    );
    expect(state({ type: "session" })).toBeNull();
    expect(piEvidence("not json\n{broken", now)).toBeNull();
    expect(piDirectory("/Users/tester/Documents/chert")).toBe(
      "--Users-tester-Documents-chert--",
    );
  });

  it("reads a Codex rollout from its last turn event", () => {
    const event = (type: string, ago = minute) => ({
      type: "event_msg",
      timestamp: new Date(now - ago).toISOString(),
      payload: { type, last_agent_message: "SECRET" },
    });
    const state = (...records: unknown[]) => {
      const evidence = codexEvidence(jsonl(...records), now);
      expect(JSON.stringify(evidence)).not.toContain("SECRET");
      return evidence && `${evidence.state}/${evidence.detail}`;
    };
    expect(state(event("task_started"))).toBe("working/turn_running");
    expect(
      state(event("task_started"), event("token_count"), {
        type: "response_item",
      }),
    ).toBe("working/turn_running");
    expect(state(event("task_started"), event("task_complete"))).toBe(
      "idle/turn_complete",
    );
    expect(state(event("task_started"), event("turn_aborted"))).toBe(
      "idle/turn_interrupted",
    );
    expect(state({ type: "session_meta", payload: {} })).toBeNull();
    // The record's own time, not the file's, orders it against hook events.
    expect(
      codexEvidence(jsonl(event("task_started", 5 * minute)), now)?.at,
    ).toBe(now - 5 * minute);
  });

  it("gives each process the session file it created, and a resumed one the file it writes", () => {
    const older = fact({ pid: 1, startedAt: now - 60 * minute, exe: "pi" });
    const newer = fact({ pid: 2, startedAt: now - 10 * minute, exe: "pi" });
    const file = (path: string, createdAgo: number, changedAgo: number) => ({
      path,
      createdAt: now - createdAgo * minute,
      mtimeMs: now - changedAgo * minute,
    });
    const assigned = assignFiles(
      [newer, older],
      [
        file("old-first", 59, 50),
        file("old-second", 30, 1),
        file("new", 9, 2),
        file("before-all", 600, 500),
      ],
    );
    // The older process started two sessions: the later one is its current file.
    expect(assigned.get(1)?.path).toBe("old-second");
    expect(assigned.get(2)?.path).toBe("new");
    // A process that resumed an old session owns no new file: it takes the
    // unclaimed file that changed after it started.
    const resumed = assignFiles(
      [newer],
      [file("resumed", 600, 3), file("stale", 700, 400)],
    );
    expect(resumed.get(2)?.path).toBe("resumed");
    expect(assignFiles([newer], [file("stale", 700, 400)]).size).toBe(0);
  });

  it("lets the newest evidence win and stays unknown with none", () => {
    const item = (
      source: "hook" | "registry" | "transcript" | "process",
      state: "working" | "idle" | "needs_you",
      at: number,
    ) => ({ source, state, detail: "turn_running" as const, since: at, at });
    expect(
      reduce(
        [item("transcript", "working", 5), item("hook", "needs_you", 9)],
        10,
      ).state,
    ).toBe("needs_you");
    // A hook that stopped firing does not hold the state against newer facts.
    expect(
      reduce([item("hook", "idle", 5), item("transcript", "working", 9)], 10)
        .state,
    ).toBe("working");
    expect(
      reduce([item("transcript", "idle", 7), item("hook", "working", 7)], 10)
        .source,
    ).toBe("hook");
    expect(reduce([], 10)).toMatchObject({
      state: "unknown",
      detail: "no_signal",
      since: null,
    });
  });

  it("bounds a name and removes control characters", () => {
    expect(cleanName("  work\u001b[31m on\nthis  ")).toBe("work [31m on this");
    expect(cleanName("x".repeat(200))).toHaveLength(80);
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(42)).toBeNull();
  });
});

describe("terminals", () => {
  it("reads the tmux server socket and the terminal version", () => {
    expect(
      tmuxSocket(fact({ exe: "tmux", command: "tmux -L work new -s main" })),
    ).toEqual(["-L", "work"]);
    expect(
      tmuxSocket(fact({ exe: "tmux", command: "tmux -S /tmp/my.sock" })),
    ).toEqual(["-S", "/tmp/my.sock"]);
    expect(
      tmuxSocket(fact({ exe: "tmux", command: "tmux new -s main -S ignored" })),
    ).toEqual([]);
    const plist = (version: string) =>
      `<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>${version}</string></dict></plist>`;
    const system = fakeSystem({
      now,
      files: {
        "/Applications/Ghostty.app/Contents/Info.plist": {
          text: plist("1.4.0"),
        },
        "/Applications/Binary.app/Contents/Info.plist": {
          text: "bplist00\u0000\u0001",
        },
      },
    });
    expect(appVersion(system, "/Applications/Ghostty.app")).toBe("1.4.0");
    expect(appVersion(system, "/Applications/Binary.app")).toBeNull();
    expect(appVersion(system, "/Applications/Missing.app")).toBeNull();
  });

  it("states how exactly focus can land", () => {
    const location = (values: object) => ({
      tty: "ttys001",
      app: "Ghostty",
      appPath: "/Applications/Ghostty.app",
      tmux: null,
      remote: false,
      ...values,
    });
    expect(focusPrecision(location({}), "1.3.1")).toBe("app");
    expect(focusPrecision(location({}), "1.4.0")).toBe("tab");
    expect(focusPrecision(location({}), "2.0")).toBe("tab");
    expect(focusPrecision(location({}), null)).toBe("app");
    expect(focusPrecision(location({ app: "Terminal" }), null)).toBe("tab");
    expect(focusPrecision(location({ app: "iTerm2" }), null)).toBe("tab");
    expect(focusPrecision(location({ app: "Warp" }), "9.9")).toBe("app");
    expect(focusPrecision(location({ app: null, appPath: null }), null)).toBe(
      "none",
    );
    expect(focusPrecision(location({ remote: true }), "1.4.0")).toBe("none");
    expect(
      focusPrecision(
        location({
          app: null,
          tmux: {
            session: "s",
            window: 0,
            pane: 0,
            paneId: "%1",
            socketArgs: [],
            clientTty: null,
          },
        }),
        null,
      ),
    ).toBe("pane");
  });
});

describe("board scan", () => {
  const home = "/Users/tester";
  const work = "/Users/tester/work";
  const ghostty = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
  const shell = (pid: number, ppid: number, tty: string): FakeProcess => ({
    pid,
    ppid,
    tty,
    startedAt: now - 300 * minute,
    exe: "-zsh",
    foreground: false,
  });
  const processes: FakeProcess[] = [
    {
      pid: 10,
      ppid: 1,
      startedAt: now - 900 * minute,
      exe: ghostty,
      foreground: false,
    },
    shell(20, 10, "ttys001"),
    shell(21, 10, "ttys002"),
    shell(22, 10, "ttys003"),
    shell(23, 10, "ttys004"),
    shell(24, 10, "ttys005"),
    // Claude Code: one waits on a permission prompt, one works.
    {
      pid: 100,
      ppid: 20,
      tty: "ttys001",
      startedAt: now - 50 * minute,
      exe: "claude",
      cwd: work,
    },
    {
      pid: 101,
      ppid: 21,
      tty: "ttys002",
      startedAt: now - 40 * minute,
      exe: "claude",
      cwd: work,
    },
    // A one-shot run that the working session started.
    {
      pid: 150,
      ppid: 101,
      tty: "ttys002",
      startedAt: now - 2 * minute,
      exe: "claude",
      command: "claude -p check this",
      cwd: work,
      foreground: false,
    },
    // Codex through its launcher: node starts the binary. One session, not two.
    {
      pid: 200,
      ppid: 22,
      tty: "ttys003",
      startedAt: now - 30 * minute,
      exe: "node",
      command: "node /opt/lib/node_modules/@openai/codex/bin/codex.js",
      cwd: work,
    },
    {
      pid: 201,
      ppid: 200,
      tty: "ttys003",
      startedAt: now - 30 * minute + 400,
      exe: "/opt/lib/node_modules/@openai/codex/vendor/codex",
      cwd: work,
    },
    {
      pid: 17686,
      ppid: 1,
      startedAt: now - 900 * minute,
      exe: "/x/bin/codex",
      command: "/x/bin/codex app-server daemon",
      foreground: false,
    },
    // pi in a tmux pane; the tmux client sits in a Ghostty tab.
    {
      pid: 30,
      ppid: 1,
      startedAt: now - 800 * minute,
      exe: "tmux",
      command: "tmux -L work new -s main",
      foreground: false,
    },
    {
      pid: 31,
      ppid: 30,
      tty: "ttys010",
      startedAt: now - 700 * minute,
      exe: "-zsh",
      foreground: false,
    },
    {
      pid: 300,
      ppid: 31,
      tty: "ttys010",
      startedAt: now - 20 * minute,
      exe: "pi",
      cwd: work,
    },
    {
      pid: 32,
      ppid: 23,
      tty: "ttys004",
      startedAt: now - 700 * minute,
      exe: "tmux",
      command: "tmux -L work attach",
    },
    // A CLI with no state reader.
    {
      pid: 400,
      ppid: 24,
      tty: "ttys005",
      startedAt: now - 5 * minute,
      exe: "amp",
      cwd: home,
    },
  ];
  const iso = (ago: number) => new Date(now - ago).toISOString();
  const rollout =
    "rollout-2026-11-20T11-30-05-01a1ed53-ed7d-76a0-aa93-6cd693483e27.jsonl";
  const system = () =>
    fakeSystem({
      now,
      home,
      processes,
      files: {
        [`${home}/.claude/sessions/100.json`]: {
          text: JSON.stringify({
            pid: 100,
            startedAt: now - 50 * minute,
            status: "waiting",
            waitingFor: "permission prompt",
            statusUpdatedAt: now - 3 * minute,
            name: "deploy fix",
            version: "2.1.329",
          }),
        },
        // Left by an earlier process that had the same pid.
        [`${home}/.claude/sessions/101.json`]: {
          text: JSON.stringify({
            pid: 101,
            startedAt: now - 5000 * minute,
            status: "idle",
            statusUpdatedAt: now - 4000 * minute,
          }),
        },
        [`${home}/.codex/sessions/2026/11/20/${rollout}`]: {
          text: jsonl(
            {
              type: "session_meta",
              payload: {
                id: "t",
                cwd: work,
                cli_version: "0.169.0",
                base_instructions: "x".repeat(9000),
              },
            },
            {
              type: "event_msg",
              timestamp: iso(8 * minute),
              payload: { type: "task_started" },
            },
            {
              type: "event_msg",
              timestamp: iso(6 * minute),
              payload: { type: "task_complete" },
            },
          ),
        },
        [`${home}/.pi/agent/sessions/--Users-tester-work--/2026-11-20T06-41-00-000Z_01a1f72c-934f-703b-b944-5a1718c6f5f9.jsonl`]:
          {
            text: jsonl(
              { type: "session" },
              {
                type: "message",
                timestamp: iso(minute),
                message: { role: "assistant", stopReason: "toolUse" },
              },
            ),
            mtimeMs: now - minute,
          },
        "/opt/homebrew/bin/tmux": { text: "" },
        "/Applications/Ghostty.app/Contents/Info.plist": {
          text: "<key>CFBundleShortVersionString</key><string>1.3.1</string>",
        },
      },
      commands(command, args) {
        if (command === "claude")
          return {
            status: 0,
            stdout: JSON.stringify([
              { pid: 101, kind: "interactive", status: "busy", name: "review" },
              {
                id: "4c49bc33",
                kind: "background",
                state: "blocked",
                name: "director",
                cwd: work,
                startedAt: now - 90 * minute,
              },
            ]),
          };
        if (command === "/opt/homebrew/bin/tmux" && args.includes("list-panes"))
          return { status: 0, stdout: "/dev/ttys010:%7:2:1:main\n" };
        if (
          command === "/opt/homebrew/bin/tmux" &&
          args.includes("list-clients")
        )
          return { status: 0, stdout: "32:/dev/ttys004:main\n" };
        return undefined;
      },
    });

  it("finds every session, its state and its place, and matches the contract", () => {
    const fake = system();
    const snapshot = new BoardScanner(fake).scan(3000);
    boardSnapshotSchema.parse(snapshot);
    const by = (pid: number | null, agent: string) =>
      snapshot.sessions.find(
        (session) => session.pid === pid && session.agent === agent,
      )!;
    expect(
      snapshot.sessions
        .map((session) => `${session.agent}:${session.pid}`)
        .sort(),
    ).toEqual(
      [
        "amp:400",
        "claude-code:100",
        "claude-code:101",
        "claude-code:null",
        "codex:200",
        "pi:300",
      ].sort(),
    );
    expect(by(100, "claude-code")).toMatchObject({
      state: "needs_you",
      detail: "permission_prompt",
      since: now - 3 * minute,
      source: "registry",
      name: "deploy fix",
      agentVersion: "2.1.329",
      project: "work",
      mode: "interactive",
      focus: "app",
      terminal: {
        tty: "ttys001",
        app: "Ghostty",
        appPath: "/Applications/Ghostty.app",
        tmux: null,
        remote: false,
      },
    });
    // Its file was stale, so the supported listing supplied the state.
    expect(by(101, "claude-code")).toMatchObject({
      state: "working",
      detail: "turn_running",
      name: "review",
    });
    expect(by(null, "claude-code")).toMatchObject({
      id: "bg-4c49bc33",
      mode: "background",
      state: "needs_you",
      focus: "none",
      name: "director",
    });
    expect(by(200, "codex")).toMatchObject({
      state: "idle",
      detail: "turn_complete",
      since: now - 6 * minute,
      source: "transcript",
      agentVersion: "0.169.0",
    });
    expect(by(300, "pi")).toMatchObject({
      state: "working",
      detail: "tool_running",
      focus: "pane",
      terminal: {
        tty: "ttys010",
        app: "Ghostty",
        tmux: {
          session: "main",
          window: 2,
          pane: 1,
          paneId: "%7",
          socketArgs: ["-L", "work"],
          clientTty: "ttys004",
        },
      },
    });
    expect(by(400, "amp")).toMatchObject({
      state: "unknown",
      detail: "no_signal",
      project: "~",
    });
    expect(snapshot.counts).toEqual({
      needs_you: 2,
      working: 2,
      idle: 1,
      unknown: 1,
    });
    expect(snapshot.sessions.map((session) => session.state)).toEqual([
      "needs_you",
      "needs_you",
      "working",
      "working",
      "idle",
      "unknown",
    ]);
    expect(snapshot.intervalMs).toBe(3000);
    // Arguments, prompts and instruction text never reach the snapshot.
    expect(JSON.stringify(snapshot)).not.toMatch(
      /check this|xxxxxxxx|--resume/,
    );
  });

  it("lists one-shot runs only on request, under the session that started them", () => {
    const snapshot = new BoardScanner(system(), {
      includeHeadless: true,
    }).scan();
    const run = snapshot.sessions.find((session) => session.pid === 150)!;
    expect(run).toMatchObject({ mode: "headless", focus: "none" });
    expect(run.spawnedBy).toBe(
      snapshot.sessions.find((session) => session.pid === 101)!.id,
    );
  });

  it("returns an empty board when the process listing fails", () => {
    const snapshot = new BoardScanner({
      ...fakeSystem({ now }),
      run: () => ({ status: null, stdout: "" }),
    }).scan();
    expect(snapshot).toMatchObject({
      sessions: [],
      counts: { needs_you: 0, working: 0, idle: 0, unknown: 0 },
    });
  });
});

describe("real file system", () => {
  it("follows a link for a program check and refuses a link for a read", () => {
    const directory = mkdtempSync(join(tmpdir(), "clawdtime-system-"));
    const target = join(directory, "tmux-3.8");
    const link = join(directory, "tmux");
    writeFileSync(target, "first line\nsecond line\nthird line\n");
    symlinkSync(target, link);
    const system = realSystem();
    // Homebrew installs programs as links: the check must see the program.
    expect(system.stat(link)).toMatchObject({
      isFile: true,
      isDirectory: false,
    });
    expect(system.stat(directory)).toMatchObject({
      isFile: false,
      isDirectory: true,
    });
    expect(system.stat(join(directory, "missing"))).toBeNull();
    // A session file is a plain file of its owner: a link is never read.
    expect(system.readText(link)).toBeNull();
    expect(system.readTail(link, 100)).toBeNull();
    expect(system.readText(target)).toBe(
      "first line\nsecond line\nthird line\n",
    );
    expect(system.readText(target, 10)).toBeNull();
    // A cut tail starts at a line boundary; a cut head is the raw first bytes.
    expect(system.readTail(target, 15)).toBe("third line\n");
    expect(system.readTail(target, 1000)).toBe(
      "first line\nsecond line\nthird line\n",
    );
    expect(system.readHead(target, 8)).toBe("first li");
    expect(system.readTail(directory, 100)).toBeNull();
    expect(system.list(directory).sort()).toEqual(["tmux", "tmux-3.8"]);
    expect(system.list(join(directory, "missing"))).toEqual([]);
  });

  it("runs a program with a time limit and reports a program that is missing", () => {
    const system = realSystem();
    expect(system.run("/bin/echo", ["board"])).toEqual({
      status: 0,
      stdout: "board\n",
    });
    expect(system.run("/bin/sh", ["-c", "exit 3"]).status).toBe(3);
    expect(system.run("/nonexistent/program", []).status).toBeNull();
    expect(
      system.run("/bin/sleep", ["5"], { timeoutMs: 100 }).status,
    ).toBeNull();
  });
});

describe("real tmux", () => {
  const binary = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ].find((path) => realSystem().stat(path)?.isFile);
  // A detached server on its own socket: no window opens and no focus moves.
  it.skipIf(!binary)(
    "reads the panes of a real server in the ambient locale and in the C locale",
    () => {
      const socket = `clawdtime-test-${process.pid}`;
      const tmux = (...args: string[]) =>
        spawnSync(binary!, ["-L", socket, ...args], { encoding: "utf8" });
      try {
        expect(
          tmux(
            "new-session",
            "-d",
            "-s",
            "board test",
            "-x",
            "80",
            "-y",
            "24",
            "cat",
          ).status,
        ).toBe(0);
        const real = realSystem();
        const server = readProcesses(real).find(
          (item) =>
            item.command.includes(`-L ${socket} new-session`) &&
            item.tty === null,
        )!;
        expect(tmuxSocket(server)).toEqual(["-L", socket]);
        const inLocale = (locale: Record<string, string>) =>
          readTmux(
            {
              ...real,
              run: (command, args) => {
                const result = spawnSync(command, args, {
                  encoding: "utf8",
                  env: { ...process.env, ...locale },
                });
                return { status: result.status, stdout: result.stdout ?? "" };
              },
            },
            [server],
          );
        const locales: Record<string, string>[] = [
          {},
          { LC_ALL: "C", LANG: "C" },
          { LC_ALL: "en_US.UTF-8" },
        ];
        for (const locale of locales) {
          const view = inLocale(locale);
          expect(view.clients).toEqual([]);
          expect(view.panes).toHaveLength(1);
          expect(view.panes[0]).toMatchObject({
            paneId: "%0",
            window: 0,
            pane: 0,
            session: "board test",
            socketArgs: ["-L", socket],
          });
          expect(view.panes[0]!.tty).toMatch(/^ttys\d+$/);
        }
      } finally {
        tmux("kill-server");
      }
    },
  );
});
