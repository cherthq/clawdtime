import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
  type ToolCall,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import { focusSession, type Runner } from "../connectors/agents/focus.js";
import {
  claudeTitle,
  pickSession,
  sessionTitles,
} from "../connectors/agents/topics.js";
import type {
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";
import { sessionWindow } from "../connectors/agents/windows.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = new Date(2026, 10, 21, 1, 0, 0).getTime();
const session = (values: Partial<AgentSession> = {}): AgentSession => ({
  id: "100-abc",
  pid: 100,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "work-13",
  project: "work",
  cwd: "/work/app",
  mode: "interactive",
  state: "idle",
  detail: "turn_complete",
  since: now - 90_000,
  source: "registry",
  startedAt: now - 600_000,
  spawnedBy: null,
  terminal: {
    tty: "ttys013",
    app: "Terminal",
    appPath: "/System/Applications/Utilities/Terminal.app",
    tmux: null,
    remote: false,
  },
  focus: "tab",
  ...values,
});
const ghostty = (values: Partial<AgentSession> = {}) =>
  session({
    focus: "app",
    terminal: {
      tty: "ttys002",
      app: "Ghostty",
      appPath: "/Applications/Ghostty.app",
      tmux: null,
      remote: false,
    },
    ...values,
  });
/** A session that runs in the background: it has no terminal on this Mac. */
const background = session({
  id: "bg-1",
  pid: null,
  name: "night-director",
  mode: "background",
  state: "needs_you",
  detail: "question",
  terminal: { tty: null, app: null, appPath: null, tmux: null, remote: false },
  focus: "none",
});

/** The session file of a Claude Code session: other lines, then the title that its terminal shows. */
function claudeFiles(
  pid: number,
  sessionId: string,
  lines: string[],
  startedAt = now - 600_000,
) {
  return {
    [`/Users/tester/.claude/sessions/${pid}.json`]: {
      text: JSON.stringify({ pid, sessionId, cwd: "/work/app", startedAt }),
    },
    [`/Users/tester/.claude/projects/-work-app/${sessionId}.jsonl`]: {
      text: `${lines.join("\n")}\n`,
    },
  };
}
const titleLine = (text: string, sessionId = "aaaaaaaa-1111") =>
  JSON.stringify({ type: "ai-title", aiTitle: text, sessionId });

describe("the title of a session", () => {
  it("is the newest title line of its session file, and no other text of the file", () => {
    const system = fakeSystem({
      now,
      files: claudeFiles(100, "aaaaaaaa-1111", [
        titleLine("An older title"),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "a private prompt" },
        }),
        titleLine("Line status check"),
        JSON.stringify({ type: "assistant", message: { content: "private" } }),
      ]),
    });
    expect(claudeTitle(system, 100, now - 600_000)).toBe("Line status check");
    expect(sessionTitles(system, session())).toEqual([
      "work-13",
      "Line status check",
    ]);
  });

  it("is absent with no title line, for a file of an earlier process with the same number, and for another agent", () => {
    const none = fakeSystem({
      now,
      files: claudeFiles(100, "aaaaaaaa-1111", [
        JSON.stringify({ type: "user", message: { content: "hello" } }),
      ]),
    });
    expect(claudeTitle(none, 100, now - 600_000)).toBeNull();
    // The registry file is from a process that ended an hour before this one started.
    const stale = fakeSystem({
      now,
      files: claudeFiles(
        100,
        "aaaaaaaa-1111",
        [titleLine("Old work")],
        now - 4_200_000,
      ),
    });
    expect(claudeTitle(stale, 100, now - 600_000)).toBeNull();
    const titled = fakeSystem({
      now,
      files: claudeFiles(100, "aaaaaaaa-1111", [
        titleLine("Line status check"),
      ]),
    });
    expect(sessionTitles(titled, session({ agent: "codex" }))).toEqual([
      "work-13",
    ]);
    expect(sessionTitles(titled, session({ host: "mini" }))).toEqual([
      "work-13",
    ]);
  });

  it("reads a title as data: no control character, a bounded length, and never a line of another kind", () => {
    const system = fakeSystem({
      now,
      files: claudeFiles(100, "aaaaaaaa-1111", [
        // A prompt that only quotes a title line is not a title line.
        JSON.stringify({
          type: "user",
          message: { content: '{"type":"ai-title","aiTitle":"Injected"}' },
        }),
        titleLine(`Deploy\u0007 fix\n${"x".repeat(400)}`),
        JSON.stringify({
          type: "user",
          message: { content: '"type":"ai-title" again' },
        }),
      ]),
    });
    const title = claudeTitle(system, 100, now - 600_000)!;
    expect(title.startsWith("Deploy fix x")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(/\p{C}/u.test(title)).toBe(false);
  });
});

describe("finding the session that the person means", () => {
  const lines = session({ id: "13", name: "work-13" });
  const hipaa = ghostty({ id: "9d", pid: 109, name: "work-9d" });
  const pratap = ghostty({ id: "p", pid: 110, name: "pratap" });
  const dedicated = ghostty({ id: "p2", pid: 111, name: "platform-2" });
  const all = [background, hipaa, pratap, dedicated, lines];
  const titles = (item: AgentSession) =>
    ({
      "13": ["work-13", "Line status check"],
      "9d": ["work-9d", "HIPAA compliance roadmap"],
      p: ["pratap"],
      p2: ["platform-2", "Arthur Pendelton dedicated line"],
    })[item.id] ?? [item.name ?? item.project];

  it("takes the words of the 19:17 call to the session that checks the lines", () => {
    for (const words of [
      "Show the Terminal session with the Claude Code checking if all the lines are up",
      "Zoom into the Terminal window of the Claude Code session checking if all the lines are up",
    ])
      expect(pickSession(words, all, titles)).toEqual({
        kind: "one",
        session: lines,
      });
  });

  it("finds a session by one word of its title, by its name, and by a number", () => {
    expect(pickSession("open the HIPAA one", all, titles)).toEqual({
      kind: "one",
      session: hipaa,
    });
    expect(pickSession("go back to pratap", all, titles)).toEqual({
      kind: "one",
      session: pratap,
    });
    expect(pickSession("the roadmap session please", all, titles)).toEqual({
      kind: "one",
      session: hipaa,
    });
  });

  it("names every session that fits equally well, and finds none from filler words", () => {
    // "line" alone fits the line check and the dedicated line.
    const tied = pickSession("show me the line session", all, titles);
    expect(tied.kind).toBe("many");
    expect(
      tied.kind === "many" && tied.sessions.map((item) => item.id).sort(),
    ).toEqual(["13", "p2"]);
    expect(pickSession("show me that terminal window", all, titles)).toEqual({
      kind: "none",
    });
    expect(pickSession("", all, titles)).toEqual({ kind: "none" });
  });

  it("does not take one fitting word of several for an answer: it returns a maybe", () => {
    // The session that checked the lines has ended. Only "lines" fits the dedicated line.
    const without = all.filter((item) => item.id !== "13");
    const pick = pickSession(
      "Show the Terminal session with the Claude Code checking if all the lines are up",
      without,
      titles,
    );
    expect(pick.kind).toBe("many");
    expect(
      pick.kind === "many" && pick.sessions.map((item) => item.id),
    ).toEqual(["p2"]);
    // Three words that fit are an answer, whatever else the person said.
    const long = ghostty({ id: "57", pid: 157, name: "work-57" });
    expect(
      pickSession(
        "show the session where we fixed the provisioning bug for iMessage on pull request 792",
        [...all, long],
        (item) =>
          item.id === "57"
            ? ["work-57", "Facetime PR 792 iMessage provisioning"]
            : titles(item),
      ),
    ).toEqual({ kind: "one", session: long });
  });

  it("takes the newest session with a window when the person asks for the new one", () => {
    const newer = session({
      id: "new",
      name: "work-77",
      startedAt: now - 1000,
    });
    expect(
      pickSession("show the session you just started", [...all, newer], titles),
    ).toEqual({ kind: "one", session: newer });
    // A background session is never the new one to show: it has no window.
    expect(
      pickSession(
        "open the latest session",
        [{ ...background, startedAt: now }, lines],
        titles,
      ),
    ).toEqual({ kind: "one", session: lines });
  });
});

function recorder(
  answer: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout: string },
) {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    return answer(command, args);
  };
  return { calls, run };
}
/** What a Ghostty before release 1.4 answers: its terminals by id and title, and "ok" to a focus. */
const ghosttyAnswers =
  (listing: string) => (command: string, args: string[]) => {
    if (command !== "/usr/bin/osascript") return { status: 0, stdout: "" };
    const script = args[1] ?? "";
    if (script.includes("name of t")) return { status: 0, stdout: listing };
    return { status: 0, stdout: "ok\n" };
  };

describe("focus on the exact window of a terminal that knows no TTY", () => {
  const listing = [
    "T-1\u001f✳ pratap",
    "T-2\u001f◐ HIPAA compliance roadmap",
    "T-3\u001f✳ Chert CLI",
    "",
  ].join("\u001e");

  it("finds the terminal by the title that the session shows, and selects it by its id as an argument", async () => {
    const { calls, run } = recorder(ghosttyAnswers(listing));
    expect(
      await focusSession(ghostty(), run, "tmux", [
        "work-9d",
        "HIPAA compliance roadmap",
      ]),
    ).toEqual({ ok: true, precision: "tab" });
    expect(calls).toHaveLength(2);
    const focus = calls[1]!;
    expect(focus[0]).toBe("/usr/bin/osascript");
    expect(focus.at(-1)).toBe("T-2");
    // The id is an argument. It is never part of the script text.
    expect(focus[2]).not.toContain("T-2");
    expect(focus[2]).toContain("focus");
  });

  it("finds a session by its own name when the person named it", async () => {
    const { calls, run } = recorder(ghosttyAnswers(listing));
    expect(
      await focusSession(ghostty({ name: "pratap" }), run, "tmux", ["pratap"]),
    ).toEqual({ ok: true, precision: "tab" });
    expect(calls[1]!.at(-1)).toBe("T-1");
  });

  it("brings only the application forward when no terminal, or more than one, has the title", async () => {
    for (const text of [
      "T-1\u001f✳ pratap\u001e",
      "T-1\u001f✳ HIPAA compliance roadmap\u001eT-2\u001f◐ HIPAA compliance roadmap\u001e",
      "",
    ]) {
      const { calls, run } = recorder(ghosttyAnswers(text));
      expect(
        await focusSession(ghostty(), run, "tmux", [
          "work-9d",
          "HIPAA compliance roadmap",
        ]),
      ).toEqual({ ok: true, precision: "app" });
      expect(calls.at(-1)).toEqual([
        "/usr/bin/open",
        "-a",
        "/Applications/Ghostty.app",
      ]);
    }
  });

  it("asks the terminal nothing when no title is known, as before", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "" }));
    expect(await focusSession(ghostty(), run)).toEqual({
      ok: true,
      precision: "app",
    });
    expect(calls).toEqual([
      ["/usr/bin/open", "-a", "/Applications/Ghostty.app"],
    ]);
  });

  it("never matches a title that is only a part of another title", async () => {
    const { run } = recorder(
      ghosttyAnswers("T-1\u001f✳ HIPAA compliance roadmap review\u001e"),
    );
    expect(
      await focusSession(ghostty(), run, "tmux", ["HIPAA compliance roadmap"]),
    ).toEqual({ ok: true, precision: "app" });
  });
});

describe("the size of a session's window", () => {
  it("makes a Terminal window fill the screen and puts it back, by its TTY as an argument", async () => {
    for (const [action, value] of [
      ["maximize", "true"],
      ["restore", "false"],
    ] as const) {
      const { calls, run } = recorder(() => ({ status: 0, stdout: "ok\n" }));
      const result = await sessionWindow(session(), action, run, []);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      const [command, , script, tty, wanted] = calls[0]!;
      expect(command).toBe("/usr/bin/osascript");
      expect([tty, wanted]).toEqual(["ttys013", value]);
      expect(script).toContain("zoomed");
      expect(script).not.toContain("ttys013");
    }
  });

  it("changes the text size of one Ghostty terminal, found by its title", async () => {
    for (const [action, wanted] of [
      ["bigger_text", "increase_font_size:2"],
      ["smaller_text", "decrease_font_size:2"],
      ["normal_text", "reset_font_size"],
    ] as const) {
      const { calls, run } = recorder(
        ghosttyAnswers(
          "T-1\u001f✳ pratap\u001eT-2\u001f◐ HIPAA compliance roadmap\u001e",
        ),
      );
      const result = await sessionWindow(ghostty(), action, run, [
        "HIPAA compliance roadmap",
      ]);
      expect(result.ok).toBe(true);
      expect(calls.at(-1)!.slice(-2)).toEqual(["T-2", wanted]);
    }
  });

  it("toggles the Ghostty window only when its size is not the wanted one already", async () => {
    const answers = (fills: string) => (command: string, args: string[]) => {
      if (command !== "/usr/bin/osascript") return { status: 0, stdout: "" };
      if (args.includes("JavaScript")) return { status: 0, stdout: fills };
      const script = args[1] ?? "";
      if (script.includes("name of t"))
        return {
          status: 0,
          stdout: "T-2\u001f◐ HIPAA compliance roadmap\u001e",
        };
      return { status: 0, stdout: "ok\n" };
    };
    const toggled = (calls: string[][]) =>
      calls.some((entry) => entry.at(-1) === "toggle_maximize");
    // Already full: maximize changes nothing; restore toggles.
    let made = recorder(answers("filled\n"));
    let result = await sessionWindow(ghostty(), "maximize", made.run, [
      "HIPAA compliance roadmap",
    ]);
    expect(result.ok).toBe(true);
    expect(toggled(made.calls)).toBe(false);
    made = recorder(answers("filled\n"));
    await sessionWindow(ghostty(), "restore", made.run, [
      "HIPAA compliance roadmap",
    ]);
    expect(toggled(made.calls)).toBe(true);
    // Not full: maximize toggles; restore changes nothing.
    made = recorder(answers("partial\n"));
    await sessionWindow(ghostty(), "maximize", made.run, [
      "HIPAA compliance roadmap",
    ]);
    expect(toggled(made.calls)).toBe(true);
    made = recorder(answers("partial\n"));
    await sessionWindow(ghostty(), "restore", made.run, [
      "HIPAA compliance roadmap",
    ]);
    expect(toggled(made.calls)).toBe(false);
    // The size cannot be read: a toggle could do the opposite, so nothing is sent.
    made = recorder(answers("unknown\n"));
    result = await sessionWindow(ghostty(), "maximize", made.run, [
      "HIPAA compliance roadmap",
    ]);
    expect(result.ok).toBe(false);
    expect(toggled(made.calls)).toBe(false);
  });

  it("says what it cannot do: a session with no window, a terminal it does not know, and text size in Terminal", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok\n" }));
    expect((await sessionWindow(background, "maximize", run, [])).ok).toBe(
      false,
    );
    expect(
      (
        await sessionWindow(
          session({
            terminal: {
              tty: "ttys001",
              app: "Alacritty",
              appPath: "/Applications/Alacritty.app",
              tmux: null,
              remote: false,
            },
          }),
          "maximize",
          run,
          [],
        )
      ).ok,
    ).toBe(false);
    expect((await sessionWindow(session(), "bigger_text", run, [])).ok).toBe(
      false,
    );
    expect(
      (await sessionWindow(session({ host: "mini" }), "maximize", run, [])).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

const board = (sessions: AgentSession[]): BoardSnapshot => ({
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: {
    needs_you: sessions.filter((item) => item.state === "needs_you").length,
    working: sessions.filter((item) => item.state === "working").length,
    idle: sessions.filter((item) => item.state === "idle").length,
    unknown: 0,
  },
  sessions,
});
function scripted(steps: (ToolCall[] | string)[]) {
  let step = 0;
  const seen: string[] = [];
  const model: ModelClient = {
    async complete(input) {
      const last = input.messages.at(-1);
      if (last?.role === "tool") seen.push(last.content);
      const next = steps[Math.min(step++, steps.length - 1)]!;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  return { model, seen };
}
const call = (name: string, args: unknown, id = `c-${name}`): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

describe("the brain opens the session that the person means", () => {
  const lines = session({ id: "13", name: "work-13" });
  const hipaa = ghostty({ id: "9d", pid: 109, name: "work-9d" });
  const titles = (item: AgentSession) =>
    item.id === "13"
      ? ["work-13", "Line status check"]
      : item.id === "9d"
        ? ["work-9d", "HIPAA compliance roadmap"]
        : [item.name ?? item.project];
  function world(
    sessions: AgentSession[],
    precision: "tab" | "app" | "none" = "tab",
  ) {
    const log: string[] = [];
    const value: SupervisorWorld = {
      now: () => now,
      board: () => board(sessions),
      desk: new DecisionDesk(
        mkdtempSync(join(tmpdir(), "clawdtime-find-")),
        () => now,
      ),
      focus: async (item) => {
        log.push(`focus ${item.id}`);
        return item.focus === "none"
          ? { ok: false, precision: "none" }
          : { ok: precision !== "none", precision };
      },
      send: async () => ({ ok: true, route: "tty" }),
      clis: () => [],
      titles,
      window: async (item, action) => {
        log.push(`window ${item.id} ${action}`);
        return { ok: true, said: "The window fills the screen." };
      },
    };
    return { value, log };
  }

  it("opens the session that checks the lines, as on the 19:17 call, although the model named a session with no window", async () => {
    const { value, log } = world([background, hipaa, lines]);
    const { model, seen } = scripted([
      [call("open_session", { session: "night-director" })],
      "Done.",
    ]);
    await new Supervisor(value, model).reply(
      [],
      "Show the Terminal session with the Claude Code checking if all the lines are up",
      "call",
    );
    expect(log).toEqual(["focus 13"]);
    expect(seen[0]).toBe("Opened work-13.");
  });

  it("takes the model's words about the job when the person's own words name no session", async () => {
    const { value, log } = world([background, hipaa, lines]);
    const { model } = scripted([
      [call("open_session", { session: "the HIPAA roadmap session" })],
      "Done.",
    ]);
    await new Supervisor(value, model).reply([], "open it", "chat");
    expect(log).toEqual(["focus 9d"]);
  });

  it("keeps the session that the person named in full, whatever else their words fit", async () => {
    const { value, log } = world([background, hipaa, lines]);
    const { model } = scripted([
      [call("open_session", { session: "work-13" })],
      "Done.",
    ]);
    await new Supervisor(value, model).reply(
      [],
      "open work-9d, the one that is not about lines",
      "chat",
    );
    expect(log).toEqual(["focus 9d"]);
  });

  it("names the sessions when more than one fits, and opens none", async () => {
    const dedicated = ghostty({ id: "p2", pid: 111, name: "platform-2" });
    const { value, log } = world([lines, dedicated]);
    value.titles = (item) =>
      item.id === "p2"
        ? ["platform-2", "Arthur Pendelton dedicated line"]
        : titles(item);
    const { model } = scripted([
      [call("open_session", { session: "the line session" })],
      "Which one?",
    ]);
    // The code asks which one by itself, with both names.
    const answer = await new Supervisor(value, model).reply(
      [],
      "show the line session",
      "chat",
    );
    expect(log).toEqual([]);
    expect(answer).toMatch(/^Which one: /);
    expect(answer).toContain("work-13");
    expect(answer).toContain("platform-2");
  });

  it("says the truth when only the application came forward", async () => {
    const { value } = world([hipaa], "app");
    const { model, seen } = scripted([
      [call("open_session", { session: "work-9d" })],
      "Done.",
    ]);
    await new Supervisor(value, model).reply([], "open work-9d", "chat");
    expect(seen[0]).toContain("Ghostty");
    expect(seen[0]).not.toBe("Opened work-9d.");
  });

  it("shows the title of a session in the status, as data beside its name", () => {
    const { value } = world([lines, hipaa]);
    const status = new Supervisor(value, null).status();
    expect(status).toContain('work-13, about "Line status check"');
    expect(status).toContain('work-9d, about "HIPAA compliance roadmap"');
  });

  it("changes the size of the window only when the person's own words ask for it", async () => {
    const { value, log } = world([background, hipaa, lines]);
    const asked = scripted([
      [call("session_window", { session: "work-13", action: "maximize" })],
      "Done.",
    ]);
    await new Supervisor(value, asked.model).reply(
      [],
      "Zoom into the Terminal window of the Claude Code session checking if all the lines are up",
      "call",
    );
    expect(log).toEqual(["window 13 maximize"]);
    // The person asked a question. The model alone resizes nothing.
    const { value: other, log: quiet } = world([lines]);
    const unasked = scripted([
      [call("session_window", { session: "work-13", action: "maximize" })],
      "Done.",
    ]);
    await new Supervisor(other, unasked.model).reply(
      [],
      "what is work-13 doing?",
      "chat",
    );
    expect(quiet).toEqual([]);
  });
});

describe("the session match, after an independent review", () => {
  const made = (
    id: string,
    title: string,
    values: Partial<AgentSession> = {},
  ) =>
    ghostty({
      id,
      pid: Number.parseInt(id, 36) + 1000,
      name: `work-${id}`,
      ...values,
    });
  const set = (
    entries: [string, string, Partial<AgentSession>?][],
  ): [AgentSession[], (item: AgentSession) => string[]] => {
    const sessions = entries.map(([id, title, values]) =>
      made(id, title, values),
    );
    const titles = new Map(entries.map(([id, title]) => [id, title]));
    return [
      sessions,
      (item) => [item.name ?? item.project, titles.get(item.id) ?? ""],
    ];
  };

  it("does not take the start of a word for the word", () => {
    for (const [words, title] of [
      ["Show them to me", "Add dark theme to settings"],
      ["Show me everything", "Check the lines of every Mac"],
      ["Read it to me", "Ready the release notes"],
    ] as const) {
      const [sessions, titles] = set([["a", title]]);
      expect(pickSession(words, sessions, titles)).toEqual({ kind: "none" });
    }
    // A plain ending still fits: lines and line, checking and check, fixes and fix.
    const [sessions, titles] = set([
      ["a", "Line status check"],
      ["b", "Fix the login page"],
    ]);
    expect(
      pickSession("the one checking the lines", sessions, titles),
    ).toMatchObject({ kind: "one", session: { id: "a" } });
    expect(
      pickSession("the session that fixes the login", sessions, titles),
    ).toMatchObject({ kind: "one", session: { id: "b" } });
  });

  it("does not take what the person rules out", () => {
    const [sessions, titles] = set([
      ["a", "Billing export nightly"],
      ["b", "Payment tests"],
    ]);
    expect(
      pickSession(
        "Show me the other session, not the billing export one",
        sessions,
        titles,
      ),
    ).toEqual({ kind: "none" });
    expect(
      pickSession("the payment one, not the billing one", sessions, titles),
    ).toMatchObject({ kind: "one", session: { id: "b" } });
  });

  it("takes the newest session only when the person described no other", () => {
    const [sessions, titles] = set([
      ["a", "Billing export", { startedAt: now - 5000 }],
      ["b", "Payment tests", { startedAt: now - 1000 }],
    ]);
    expect(
      pickSession("open the new deploy session", sessions, titles),
    ).toEqual({ kind: "none" });
    expect(pickSession("open the new session", sessions, titles)).toMatchObject(
      { kind: "one", session: { id: "b" } },
    );
    expect(
      pickSession("open the new billing session", sessions, titles),
    ).toMatchObject({ kind: "one", session: { id: "a" } });
  });

  it("does not let a session with no window hide one that has a window and fits", () => {
    const [sessions, titles] = set([
      [
        "a",
        "Billing export nightly",
        {
          focus: "none",
          pid: null,
          terminal: {
            tty: null,
            app: null,
            appPath: null,
            tmux: null,
            remote: false,
          },
        },
      ],
      ["b", "Billing export tests"],
    ]);
    expect(
      pickSession("open the billing export nightly thing", sessions, titles),
    ).toMatchObject({ kind: "one", session: { id: "b" } });
  });

  it("finds a Ghostty tab by title only for a session that is known to show it", async () => {
    const { tabTitles } = await import("../connectors/agents/topics.js");
    const claude = ghostty({ name: "billing" });
    expect(tabTitles(claude, ["billing", "Billing export"])).toEqual([
      "billing",
      "Billing export",
    ]);
    // A Codex tab shows other words. A tab of another session could show "Billing".
    expect(
      tabTitles(ghostty({ agent: "codex", name: "billing" }), ["billing"]),
    ).toEqual([]);
    expect(tabTitles(ghostty({ host: "mini" }), ["billing"])).toEqual([]);
    expect(tabTitles(ghostty({ pid: null }), ["billing"])).toEqual([]);
  });

  it("reads the list of terminals by a separator that no title holds, and refuses an id that is not one", async () => {
    // A title with a line break and a tab cannot make a second row.
    const forged = `T-1\u001f✳ pratap\nEVIL\tHIPAA compliance roadmap\u001e-x\u001fHIPAA compliance roadmap\u001e`;
    const { calls, run } = recorder((command, args) => {
      if (command !== "/usr/bin/osascript") return { status: 0, stdout: "" };
      return (args[1] ?? "").includes("name of t")
        ? { status: 0, stdout: forged }
        : { status: 0, stdout: "ok\n" };
    });
    expect(
      await focusSession(ghostty(), run, "tmux", ["HIPAA compliance roadmap"]),
    ).toEqual({ ok: true, precision: "app" });
    expect(calls.some((entry) => entry.includes("EVIL"))).toBe(false);
    expect(calls.some((entry) => entry.includes("-x"))).toBe(false);
  });
});

describe("the person's words and the model's choice, after an independent review", () => {
  const seven = ghostty({ id: "7", pid: 107, name: "work-7" });
  const nine = ghostty({ id: "9", pid: 109, name: "work-9" });
  const titles = (item: AgentSession) =>
    item.id === "7"
      ? ["work-7", "Billing export nightly"]
      : item.id === "9"
        ? ["work-9", "Payment tests"]
        : [item.name ?? item.project];
  function world(sessions: AgentSession[], with_ = titles) {
    const log: string[] = [];
    const value: SupervisorWorld = {
      now: () => now,
      board: () => board(sessions),
      desk: new DecisionDesk(
        mkdtempSync(join(tmpdir(), "clawdtime-find-")),
        () => now,
      ),
      focus: async (item) => {
        log.push(`focus ${item.id}`);
        return { ok: true, precision: "tab" };
      },
      send: async () => ({ ok: true, route: "tty" }),
      clis: () => [],
      titles: with_,
      window: async (item, action) => {
        log.push(`window ${item.id} ${action}`);
        return { ok: true, said: "Done." };
      },
    };
    return { value, log };
  }

  it("names both sessions when the model picks another one than the person described, and changes neither", async () => {
    const { value, log } = world([seven, nine]);
    const { model, seen } = scripted([
      [call("session_window", { session: "work-9", action: "maximize" })],
      "Which one?",
    ]);
    await new Supervisor(value, model).reply(
      [],
      "Make the billing export window bigger",
      "call",
    );
    expect(log).toEqual([]);
    expect(seen[0]).toContain("work-7");
    expect(seen[0]).toContain("work-9");
  });

  it("does not let a session that is named by a common word win over the person's description", async () => {
    const app = ghostty({ id: "a", pid: 201, name: "app" });
    const web = ghostty({ id: "w", pid: 202, name: "web" });
    const { value, log } = world([app, web], (item) =>
      item.id === "w" ? ["web", "Fix login bug in the app"] : ["app"],
    );
    const { model } = scripted([
      [call("open_session", { session: "app" })],
      "Which one?",
    ]);
    // Both are named, by the code's own question, and none opens.
    const answer = await new Supervisor(value, model).reply(
      [],
      "Open the one that fixes the login bug in the app",
      "call",
    );
    expect(log).toEqual([]);
    expect(answer).toMatch(/^Which one: /);
    expect(answer).toContain("app");
    expect(answer).toContain("web");
  });

  it("still takes the model's choice when the person's words name no session", async () => {
    const { value, log } = world([seven, nine]);
    const { model } = scripted([
      [call("open_session", { session: "work-9" })],
      "Done.",
    ]);
    await new Supervisor(value, model).reply([], "open it", "call");
    expect(log).toEqual(["focus 9"]);
  });
});
