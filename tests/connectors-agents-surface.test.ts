import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentsCli, findSession } from "../cli/agents.js";
import { desktopCli } from "../cli/task-desktop.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import { focusSession, type Runner } from "../connectors/agents/focus.js";
import { runPublisher } from "../connectors/agents/publisher.js";
import {
  elapsed,
  renderBoard,
  summary,
  where,
} from "../connectors/agents/render.js";
import {
  boardSnapshotSchema,
  type AgentSession,
  type BoardSnapshot,
} from "../connectors/agents/types.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const session = (values: Partial<AgentSession> = {}): AgentSession => ({
  id: "100-abc",
  pid: 100,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "deploy fix",
  project: "work",
  cwd: "/Users/tester/work",
  mode: "interactive",
  state: "needs_you",
  detail: "permission_prompt",
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
const board = (sessions: AgentSession[], generatedAt = now): BoardSnapshot => ({
  version: 1,
  generatedAt,
  intervalMs: 3000,
  counts: {
    needs_you: sessions.filter((item) => item.state === "needs_you").length,
    working: sessions.filter((item) => item.state === "working").length,
    idle: sessions.filter((item) => item.state === "idle").length,
    unknown: sessions.filter((item) => item.state === "unknown").length,
  },
  sessions,
});
const tmux = {
  session: "main",
  window: 2,
  pane: 1,
  paneId: "%7",
  socketArgs: ["-L", "work"],
  clientTty: "ttys004",
};

function recorder(
  answers: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout: string },
) {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    return answers(command, args);
  };
  return { calls, run };
}

describe("focus", () => {
  it("selects the tab by TTY and passes the TTY as an argument, not as script text", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok\n" }));
    expect(await focusSession(session(), run)).toEqual({
      ok: true,
      precision: "tab",
    });
    expect(calls).toHaveLength(1);
    const [command, flag, script, tty] = calls[0]!;
    expect([command, flag, tty]).toEqual([
      "/usr/bin/osascript",
      "-e",
      "ttys001",
    ]);
    expect(script).toContain('tell application "Terminal"');
    expect(script).not.toContain("ttys001");
  });

  it("brings the application forward when the tab cannot be selected", async () => {
    for (const answer of [
      { status: 1, stdout: "" },
      { status: 0, stdout: "missing\n" },
    ]) {
      const { calls, run } = recorder((command) =>
        command === "/usr/bin/osascript" ? answer : { status: 0, stdout: "" },
      );
      expect(await focusSession(session(), run)).toEqual({
        ok: true,
        precision: "app",
      });
      expect(calls.at(-1)).toEqual([
        "/usr/bin/open",
        "-a",
        "/System/Applications/Utilities/Terminal.app",
      ]);
    }
  });

  it("only brings the application forward for a terminal that cannot select tabs", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "" }));
    const ghostty = session({
      focus: "app",
      terminal: {
        tty: "ttys001",
        app: "Ghostty",
        appPath: "/Applications/Ghostty.app",
        tmux: null,
        remote: false,
      },
    });
    expect(await focusSession(ghostty, run)).toEqual({
      ok: true,
      precision: "app",
    });
    expect(calls).toEqual([
      ["/usr/bin/open", "-a", "/Applications/Ghostty.app"],
    ]);
  });

  it("selects the tmux window and pane, moves the client, then the client's tab", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok" }));
    const inTmux = session({
      focus: "pane",
      terminal: {
        tty: "ttys010",
        app: "iTerm2",
        appPath: "/Applications/iTerm.app",
        tmux,
        remote: false,
      },
    });
    expect(await focusSession(inTmux, run, "/opt/homebrew/bin/tmux")).toEqual({
      ok: true,
      precision: "pane",
    });
    expect(calls.slice(0, 3)).toEqual([
      ["/opt/homebrew/bin/tmux", "-L", "work", "select-window", "-t", "%7"],
      ["/opt/homebrew/bin/tmux", "-L", "work", "select-pane", "-t", "%7"],
      ["/opt/homebrew/bin/tmux", "-L", "work", "switch-client", "-t", "%7"],
    ]);
    // The tab on screen is the tmux client's terminal, not the pane's.
    expect(calls[3]!.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(calls[3]!.at(-1)).toBe("ttys004");
    expect(calls.flat().join(" ")).not.toMatch(
      /send-keys|paste-buffer|keystroke/,
    );
  });

  it("reports nothing focused when tmux refuses and no application is known", async () => {
    const { calls, run } = recorder(() => ({ status: 1, stdout: "" }));
    const detached = session({
      focus: "pane",
      terminal: {
        tty: "ttys010",
        app: null,
        appPath: null,
        tmux: { ...tmux, clientTty: null },
        remote: false,
      },
    });
    expect(await focusSession(detached, run)).toEqual({
      ok: false,
      precision: "none",
    });
    expect(calls).toHaveLength(2);
  });

  it("does nothing for a session with no terminal on this Mac", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok" }));
    expect(
      await focusSession(session({ focus: "none", mode: "background" }), run),
    ).toEqual({ ok: false, precision: "none" });
    expect(
      await focusSession(
        session({ terminal: { ...session().terminal, remote: true } }),
        run,
      ),
    ).toEqual({ ok: false, precision: "none" });
    expect(calls).toEqual([]);
  });
});

describe("board text", () => {
  it("formats elapsed time", () => {
    expect(elapsed(now - 45_000, now)).toBe("45s");
    expect(elapsed(now - 12 * 60_000, now)).toBe("12m");
    expect(elapsed(now - (3 * 60 + 5) * 60_000, now)).toBe("3h 05m");
    expect(elapsed(now - (52 * 60 + 1) * 60_000, now)).toBe("2d 04h");
    expect(elapsed(now + 5000, now)).toBe("0s");
    expect(elapsed(null, now)).toBe("");
  });

  it("summarizes counts", () => {
    expect(summary({ needs_you: 1, working: 3, idle: 9, unknown: 0 })).toBe(
      "1 needs you · 3 working · 9 idle",
    );
    expect(summary({ needs_you: 2, working: 0, idle: 0, unknown: 1 })).toBe(
      "2 need you · 1 unknown",
    );
    expect(summary({ needs_you: 0, working: 0, idle: 0, unknown: 0 })).toBe(
      "no agent sessions",
    );
  });

  it("says where a session is", () => {
    expect(where(session())).toBe("Terminal · ttys001");
    expect(where(session({ terminal: { ...session().terminal, tmux } }))).toBe(
      "Terminal · tmux main:2.1",
    );
    expect(where(session({ mode: "background" }))).toBe("background");
    expect(
      where(
        session({
          terminal: {
            tty: "ttys009",
            app: null,
            appPath: null,
            tmux: null,
            remote: true,
          },
        }),
      ),
    ).toBe("remote ttys009");
  });

  it("renders one line for each session and never passes control characters through", () => {
    const text = renderBoard(
      board([
        session({ name: "evil\u001b[2J\u0007name" }),
        session({
          id: "101-abc",
          pid: 101,
          state: "working",
          detail: "turn_running",
          name: null,
          since: now - 600_000,
        }),
        session({
          id: "102-abc",
          pid: 102,
          state: "idle",
          detail: "turn_complete",
          name: "a very long session name that does not fit in the column at all",
        }),
      ]),
      { color: false, width: 100, now },
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Agents  1 needs you · 1 working · 1 idle");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toMatch(
      /^ {2}NEEDS YOU Claude Code +evil \[2J name +1m +permission needed +Terminal · ttys001$/,
    );
    expect(lines[3]).toMatch(/WORKING +Claude Code +work +10m +working/);
    expect(lines[4]).toContain("…");
    // No escape or bell byte anywhere without color.
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(100);
    expect(
      renderBoard(board([session()]), {
        color: true,
        width: 100,
        now,
        selected: 0,
      }),
    ).toContain("\u001b[33;1m");
    expect(renderBoard(board([]), { color: false, width: 100, now })).toContain(
      "Start a coding agent",
    );
  });
});

describe("board feed", () => {
  it("keeps the latest valid snapshot and lets it age out", () => {
    let clock = now;
    const feed = new BoardFeed({ now: () => clock, intervalMs: 3000 });
    expect(feed.snapshot()).toBeNull();
    const line = `${JSON.stringify(board([session()]))}\n`;
    // Bytes arrive in pieces.
    feed.receive(line.slice(0, 40));
    expect(feed.snapshot()).toBeNull();
    feed.receive(line.slice(40));
    expect(feed.snapshot()?.sessions).toHaveLength(1);
    // Invalid output never replaces a valid snapshot.
    feed.receive("not json\n");
    feed.receive(`${JSON.stringify({ ...board([]), version: 2 })}\n`);
    feed.receive(`${JSON.stringify({ ...board([]), extra: true })}\n`);
    expect(feed.snapshot()?.sessions).toHaveLength(1);
    clock = now + 3 * 3000 + 2001;
    expect(feed.snapshot()).toBeNull();
  });

  it("focuses only a session on the current board", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok" }));
    const feed = new BoardFeed({ now: () => now, runner: run });
    expect(await feed.focus("100-abc")).toEqual({
      ok: false,
      precision: "none",
    });
    feed.receive(`${JSON.stringify(board([session()]))}\n`);
    expect(await feed.focus("999-zzz")).toEqual({
      ok: false,
      precision: "none",
    });
    expect(calls).toEqual([]);
    expect(await feed.focus("100-abc")).toEqual({ ok: true, precision: "tab" });
    expect(calls).toHaveLength(1);
  });
});

describe("contract fixture", () => {
  it("is a valid board: the Swift panel tests decode this same file", () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "fixtures/agent-board.json",
        ),
        "utf8",
      ),
    );
    const parsed = boardSnapshotSchema.parse(fixture);
    expect(parsed.sessions.map((item) => item.state)).toEqual([
      "needs_you",
      "working",
      "working",
      "idle",
      "unknown",
    ]);
    expect(parsed.counts).toEqual({
      needs_you: 1,
      working: 2,
      idle: 1,
      unknown: 1,
    });
  });
});

describe("publisher", () => {
  it("prints one line for each scan, skips a failed scan and ends when the reader is gone", async () => {
    const lines: string[] = [];
    let scans = 0;
    await runPublisher({
      intervalMs: 3000,
      scan: (interval) => {
        scans++;
        if (scans === 2) throw new Error("scan failed");
        return { scan: scans, interval };
      },
      write: (line) => {
        lines.push(line);
        return lines.length < 3;
      },
      alive: () => true,
      sleep: async () => {},
    });
    expect(lines).toEqual([
      '{"scan":1,"interval":3000}\n',
      '{"scan":3,"interval":3000}\n',
      '{"scan":4,"interval":3000}\n',
    ]);
    let turns = 0;
    await runPublisher({
      intervalMs: 1000,
      scan: () => ({}),
      write: () => true,
      alive: () => turns++ < 2,
      sleep: async () => {},
    });
    expect(turns).toBe(3);
  });
});

describe("agents command", () => {
  it("finds a session by id, pid or a name that only one session has", () => {
    const snapshot = board([
      session(),
      session({ id: "101-abc", pid: 101, name: "deploy docs" }),
      session({ id: "102-abc", pid: 102, name: null, project: "site" }),
    ]);
    expect(findSession(snapshot, "101-abc").pid).toBe(101);
    expect(findSession(snapshot, "102").pid).toBe(102);
    expect(findSession(snapshot, "Deploy Fix").pid).toBe(100);
    expect(findSession(snapshot, "site").pid).toBe(102);
    expect(findSession(snapshot, "docs").pid).toBe(101);
    expect(() => findSession(snapshot, "deploy")).toThrow("matches 2 sessions");
    expect(() => findSession(snapshot, "nothing")).toThrow(
      "No session matches",
    );
  });

  it("prints the contract as JSON and a table as text", async () => {
    const lines: string[] = [];
    const system = fakeSystem({
      now,
      processes: [
        {
          pid: 10,
          ppid: 1,
          startedAt: now - 9_000_000,
          exe: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
          foreground: false,
        },
        {
          pid: 400,
          ppid: 10,
          tty: "ttys005",
          startedAt: now - 300_000,
          exe: "amp",
          cwd: "/Users/tester/site",
        },
      ],
    });
    await agentsCli(["--json"], { system, print: (line) => lines.push(line) });
    const snapshot = boardSnapshotSchema.parse(JSON.parse(lines[0]!));
    expect(snapshot.sessions).toMatchObject([
      { agent: "amp", state: "unknown", project: "site" },
    ]);
    await agentsCli([], {
      system,
      print: (line) => lines.push(line),
      isTTY: false,
      columns: 90,
    });
    expect(lines[1]).toContain("UNKNOWN   Amp");
    await agentsCli(["help"], { system, print: (line) => lines.push(line) });
    expect(lines[2]).toContain("agents watch");
    await expect(
      agentsCli(["--bogus"], { system, print: () => {} }),
    ).rejects.toThrow("Unknown option");
    await expect(
      agentsCli(["launch"], { system, print: () => {} }),
    ).rejects.toThrow("Unknown command");
    await expect(
      agentsCli(["focus"], { system, print: () => {} }),
    ).rejects.toThrow("Give one session");
  });
});

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Synthetic port unavailable");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
async function closeOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timeout);
}

it("real desktop service serves the board to the panel credential only, and turns it off on request", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "clawdtime-agent-board-")),
  );
  const panel = join(temporary, "fake-panel");
  // This tiny test executable exits immediately. It opens no native UI.
  writeFileSync(panel, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const children: ChildProcess[] = [];
  const panelArguments: string[][] = [];
  const spawnOwned = ((command: string, args: string[], options: object) => {
    const child = spawn(command, args, options);
    children.push(child);
    if (command === panel) panelArguments.push(args);
    return child;
  }) as typeof spawn;
  const start = async (name: string, extra: string[]) => {
    const project = join(temporary, `${name}-project`);
    const state = join(temporary, `${name}-private`);
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(state, { mode: 0o700 });
    const port = await unusedPort();
    await desktopCli(
      [
        "--state",
        state,
        "--project",
        project,
        "--port",
        String(port),
        "--panel-binary",
        panel,
        ...extra,
      ],
      {
        root,
        spawn: spawnOwned,
        print: () => {},
        startupMs: 10000,
        pollMs: 50,
      },
    );
    const { token } = JSON.parse(
      readFileSync(join(state, "desktop-panel.json"), "utf8"),
    );
    const request = (
      path: string,
      init: RequestInit = {},
      credential = token,
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
    return request;
  };
  try {
    const request = await start("on", []);
    // The first scan runs in the publisher process, so the board is not there at once.
    let response = await request("/desktop/agents");
    for (let attempt = 0; response.status === 503 && attempt < 100; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
      response = await request("/desktop/agents");
    }
    expect(response.status).toBe(200);
    const snapshot = boardSnapshotSchema.parse(await response.json());
    expect(snapshot.intervalMs).toBe(3000);
    expect((await request("/desktop/agents", {}, "x".repeat(64))).status).toBe(
      401,
    );
    const focus = (body: unknown, credential?: string) =>
      request(
        "/desktop/agents/focus",
        { method: "POST", body: JSON.stringify(body) },
        credential,
      );
    expect((await focus({ id: "999999-zz" }, "x".repeat(64))).status).toBe(401);
    // An id that is not on the board focuses nothing.
    const missed = await focus({ id: "999999-zz" });
    expect(missed.status).toBe(200);
    expect(await missed.json()).toEqual({ ok: false, precision: "none" });
    expect((await focus({ id: "../etc" })).status).toBe(400);
    expect((await focus({ id: "999999-zz", extra: 1 })).status).toBe(400);
    const off = await start("off", ["--agents", "false", "--tucked", "true"]);
    // Only the tucked start passes the switch to the panel.
    expect(panelArguments.map((args) => args.includes("--tucked"))).toEqual([
      false,
      true,
    ]);
    expect(panelArguments[1]!.slice(0, 1)).toEqual(["--config"]);
    expect((await off("/desktop/agents")).status).toBe(404);
    expect((await off("/desktop/state")).status).toBe(200);
  } finally {
    await Promise.all(children.map(closeOwned));
    rmSync(temporary, { recursive: true, force: true });
  }
}, 40000);
