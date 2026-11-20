import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import { BoardScanner } from "../connectors/agents/board.js";
import {
  codexHookEvents,
  eventsDirectory,
  hookAncestors,
  hookCommand,
  hookState,
  installHooks,
  installedHookEvents,
  receiveHook,
  uninstallHooks,
} from "../connectors/agents/hooks.js";
import {
  fakeSystem,
  jsonl,
  type FakeFile,
  type FakeProcess,
} from "./connectors-agents-fixture.js";

const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const minute = 60_000;
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-hooks-"));
const stored = (directory: string) =>
  readdirSync(eventsDirectory(directory)).map((name) =>
    JSON.parse(readFileSync(join(eventsDirectory(directory), name), "utf8")),
  );

describe("hook payloads", () => {
  it("maps each event to a state", () => {
    const state = (input: Record<string, unknown>) => {
      const result = hookState(input);
      return result && result !== "ended"
        ? `${result.state}/${result.detail}`
        : result;
    };
    expect(state({ hook_event_name: "SessionStart" })).toBe(
      "idle/session_started",
    );
    expect(state({ hook_event_name: "UserPromptSubmit" })).toBe(
      "working/turn_running",
    );
    expect(state({ hook_event_name: "PermissionRequest" })).toBe(
      "needs_you/permission_prompt",
    );
    expect(state({ hook_event_name: "PostToolUse" })).toBe(
      "working/tool_running",
    );
    expect(state({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBe(
      "working/tool_running",
    );
    expect(
      state({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }),
    ).toBe("needs_you/question");
    expect(
      state({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" }),
    ).toBe("needs_you/plan_review");
    expect(
      state({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
      }),
    ).toBe("needs_you/permission_prompt");
    expect(
      state({
        hook_event_name: "Notification",
        notification_type: "ToolPermission",
      }),
    ).toBe("needs_you/permission_prompt");
    expect(
      state({
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
      }),
    ).toBe("idle/turn_complete");
    expect(
      state({
        hook_event_name: "Notification",
        notification_type: "auth_success",
      }),
    ).toBeNull();
    expect(state({ hook_event_name: "Stop" })).toBe("idle/turn_complete");
    expect(state({ hook_event_name: "Interrupt" })).toBe(
      "idle/turn_interrupted",
    );
    expect(state({ hook_event_name: "SessionEnd" })).toBe("ended");
    expect(state({ hook_event_name: "PreCompact" })).toBeNull();
    expect(state({})).toBeNull();
  });

  it("stores only the state, never the prompt, the reply or tool input", () => {
    const directory = root();
    const input = {
      session_id: "thread-1",
      cwd: "/work",
      hook_event_name: "PermissionRequest",
      tool_name: "shell",
      tool_input: { command: "SECRET-COMMAND" },
      prompt: "SECRET-PROMPT",
      last_assistant_message: "SECRET-REPLY",
      transcript_path: "/private/SECRET-PATH.jsonl",
    };
    expect(
      receiveHook({
        root: directory,
        agent: "codex",
        input,
        at: now,
        pids: [9, 8, 7, 6, 1],
      }),
    ).toBe("recorded");
    const [event] = stored(directory);
    expect(event).toEqual({
      version: 1,
      agent: "codex",
      state: "needs_you",
      detail: "permission_prompt",
      since: now,
      at: now,
      cwd: "/work",
      pids: [9, 8, 7],
    });
    const name = readdirSync(eventsDirectory(directory))[0]!;
    expect(name).not.toContain("thread-1");
    expect(statSync(join(eventsDirectory(directory), name)).mode & 0o777).toBe(
      0o600,
    );
  });

  it("keeps the newest record when hooks finish out of order", () => {
    const directory = root();
    const send = (event: string, at: number) =>
      receiveHook({
        root: directory,
        agent: "codex",
        input: { session_id: "t", hook_event_name: event },
        at,
        pids: [9],
      });
    send("PermissionRequest", now + 20);
    // A hook that started earlier and finished later must not win.
    expect(send("UserPromptSubmit", now)).toBe("ignored");
    expect(stored(directory)[0]).toMatchObject({
      state: "needs_you",
      since: now + 20,
    });
    // The same state again keeps the time it began.
    send("PermissionRequest", now + 500);
    expect(stored(directory)[0]).toMatchObject({
      since: now + 20,
      at: now + 500,
    });
    send("PostToolUse", now + 900);
    expect(stored(directory)[0]).toMatchObject({
      state: "working",
      since: now + 900,
    });
    expect(send("SessionEnd", now + 1000)).toBe("removed");
    expect(stored(directory)).toEqual([]);
    expect(send("SessionEnd", now + 1100)).toBe("removed");
  });

  it("ignores payloads it cannot use", () => {
    const directory = root();
    const send = (input: unknown) =>
      receiveHook({
        root: directory,
        agent: "codex",
        input,
        at: now,
        pids: [],
      });
    expect(send(null)).toBe("ignored");
    expect(send([])).toBe("ignored");
    expect(send({ hook_event_name: "Stop" })).toBe("ignored");
    expect(send({ session_id: "x".repeat(201), hook_event_name: "Stop" })).toBe(
      "ignored",
    );
    expect(send({ session_id: "t", hook_event_name: "SomethingNew" })).toBe(
      "ignored",
    );
  });

  it("finds the hook's ancestors from one listing", () => {
    const listing =
      "  500   400\n  400   300\n  300   200\n  200     1\n  999   998\n bad line\n";
    expect(hookAncestors(listing, 500)).toEqual([400, 300, 200]);
    expect(hookAncestors(listing, 500, 2)).toEqual([400, 300]);
    expect(hookAncestors(listing, 12345)).toEqual([]);
    expect(hookAncestors("  5   6\n  6   5\n", 5)).toEqual([6, 5]);
  });
});

describe("hook events on the board", () => {
  const home = "/Users/tester";
  const work = "/Users/tester/work";
  const rollout = `${home}/.codex/sessions/2026/11/20/rollout-2026-11-20T11-30-05-01a1ed53-ed7d-76a0-aa93-6cd693483e27.jsonl`;
  const base: FakeProcess[] = [
    {
      pid: 10,
      ppid: 1,
      startedAt: now - 900 * minute,
      exe: "/Applications/Terminal.app/Contents/MacOS/Terminal",
      foreground: false,
    },
    {
      pid: 20,
      ppid: 10,
      tty: "ttys001",
      startedAt: now - 300 * minute,
      exe: "-zsh",
      foreground: false,
    },
    {
      pid: 200,
      ppid: 20,
      tty: "ttys001",
      startedAt: now - 30 * minute,
      exe: "codex",
      cwd: work,
    },
  ];
  const event = (values: object): FakeFile => ({
    text: JSON.stringify({
      version: 1,
      agent: "codex",
      state: "needs_you",
      detail: "permission_prompt",
      since: now - 2 * minute,
      at: now - 2 * minute,
      cwd: work,
      pids: [200],
      ...values,
    }),
  });
  const scan = (processes: FakeProcess[], events: Record<string, FakeFile>) =>
    new BoardScanner(
      fakeSystem({
        now,
        home,
        processes,
        files: {
          [rollout]: {
            text: jsonl(
              { type: "session_meta", payload: { cwd: work } },
              {
                type: "event_msg",
                timestamp: new Date(now - 5 * minute).toISOString(),
                payload: { type: "task_started" },
              },
            ),
          },
          ...Object.fromEntries(
            Object.entries(events).map(([name, file]) => [
              `${home}/.local/share/clawdtime/agents/events/${name}`,
              file,
            ]),
          ),
        },
      }),
    ).scan().sessions;

  it("shows a Codex approval prompt that the session file does not record", () => {
    // Without the hook the session file says only that a turn runs.
    expect(scan(base, {})[0]).toMatchObject({
      agent: "codex",
      state: "working",
      source: "transcript",
    });
    expect(scan(base, { "codex.a.json": event({}) })[0]).toMatchObject({
      state: "needs_you",
      detail: "permission_prompt",
      since: now - 2 * minute,
      source: "hook",
      focus: "tab",
    });
  });

  it("shows work again once an approved tool runs under the agent", () => {
    const tool: FakeProcess = {
      pid: 900,
      ppid: 200,
      startedAt: now - minute,
      exe: "/usr/bin/make",
      foreground: false,
    };
    expect(
      scan([...base, tool], { "codex.a.json": event({}) })[0],
    ).toMatchObject({
      state: "working",
      detail: "tool_running",
      source: "process",
      since: now - minute,
    });
    // A child that was already running before the request proves nothing.
    const earlier = { ...tool, startedAt: now - 10 * minute };
    expect(
      scan([...base, earlier], { "codex.a.json": event({}) })[0],
    ).toMatchObject({ state: "needs_you" });
    // The hook receiver itself is not a tool.
    const receiver = {
      ...tool,
      exe: "node",
      command: "node /x/dist/cli/agent-hook.js codex",
    };
    expect(
      scan([...base, receiver], { "codex.a.json": event({}) })[0],
    ).toMatchObject({ state: "needs_you" });
  });

  it("gives a record to the right session and drops what it cannot place", () => {
    const second: FakeProcess = {
      pid: 201,
      ppid: 20,
      tty: "ttys002",
      startedAt: now - 20 * minute,
      exe: "codex",
      cwd: work,
    };
    const states = (
      events: Record<string, FakeFile>,
      processes = [...base, second],
    ) =>
      Object.fromEntries(
        scan(processes, events).map((session) => [session.pid, session.source]),
      );
    // By ancestor process.
    expect(
      states({ "codex.a.json": event({ pids: [555, 201] }) }),
    ).toMatchObject({ 201: "hook" });
    // Two sessions share the directory and no ancestor matches: not placed.
    expect(
      Object.values(states({ "codex.a.json": event({ pids: [555] }) })),
    ).not.toContain("hook");
    // One session in that directory: placed by the directory.
    expect(
      states({ "codex.a.json": event({ pids: [555] }) }, base),
    ).toMatchObject({ 200: "hook" });
    // A record older than the process came from an earlier process.
    expect(
      Object.values(
        states(
          {
            "codex.a.json": event({
              at: now - 600 * minute,
              since: now - 600 * minute,
            }),
          },
          base,
        ),
      ),
    ).not.toContain("hook");
    // Another agent's record, a broken file and an unknown field are ignored.
    expect(
      Object.values(
        states(
          {
            "x.json": event({ agent: "pi" }),
            "y.json": { text: "{" },
            "z.json": event({ extra: 1 }),
          },
          base,
        ),
      ),
    ).not.toContain("hook");
  });

  it("lets a newer turn in the session file replace an old hook record", () => {
    const [session] = scan(base, {
      "codex.a.json": event({
        state: "idle",
        detail: "turn_complete",
        at: now - 9 * minute,
        since: now - 9 * minute,
      }),
    });
    expect(session).toMatchObject({ state: "working", source: "transcript" });
  });
});

describe("Codex hooks file", () => {
  const command = hookCommand(
    "/usr/local/bin/node",
    "/opt/clawd time/dist/cli/agent-hook.js",
    "codex",
  );
  const other = {
    matcher: "shell",
    hooks: [{ type: "command", command: "/usr/bin/true", timeout: 3 }],
  };

  it("quotes the command for a shell", () => {
    expect(command).toBe(
      "'/usr/local/bin/node' '/opt/clawd time/dist/cli/agent-hook.js' codex",
    );
    expect(hookCommand("/n", "/it's/x.js", "codex")).toBe(
      `'/n' '/it'\\''s/x.js' codex`,
    );
  });

  it("adds its events, keeps everything else and removes only itself", () => {
    const original = {
      description: "mine",
      hooks: { PostToolUse: [other], PreCompact: [other] },
      custom: [1, 2],
    };
    const installed = installHooks(JSON.stringify(original), command);
    const parsed = JSON.parse(installed);
    expect(parsed.description).toBe("mine");
    expect(parsed.custom).toEqual([1, 2]);
    expect(parsed.hooks.PreCompact).toEqual([other]);
    expect(parsed.hooks.PostToolUse).toEqual([
      other,
      { hooks: [{ type: "command", command, timeout: 5, async: true }] },
    ]);
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      [...codexHookEvents, "PreCompact"].sort(),
    );
    expect(parsed.hooks.PreToolUse).toBeUndefined();
    expect(installedHookEvents(installed, command)).toEqual([
      ...codexHookEvents,
    ]);
    // A second install changes nothing.
    expect(installHooks(installed, command)).toBe(installed);
    expect(JSON.parse(uninstallHooks(installed, command))).toEqual(original);
    // A different build path is a different command: it is not ours to remove.
    expect(
      uninstallHooks(installed, hookCommand("/n", "/elsewhere.js", "codex")),
    ).toBe(installed);
  });

  it("creates the file content when there is none and refuses a file it cannot read safely", () => {
    expect(installedHookEvents(undefined, command)).toEqual([]);
    expect(
      Object.keys(JSON.parse(installHooks(undefined, command)).hooks),
    ).toEqual([...codexHookEvents]);
    expect(
      Object.keys(JSON.parse(installHooks("  \n", command)).hooks),
    ).toEqual([...codexHookEvents]);
    expect(() => installHooks("{ not json", command)).toThrow("not valid JSON");
    expect(() => installHooks("[]", command)).toThrow("unexpected shape");
    expect(() => installHooks('{"hooks":[]}', command)).toThrow(
      "unexpected shape",
    );
    expect(() => installHooks('{"hooks":{"Stop":{}}}', command)).toThrow(
      "unexpected shape",
    );
  });

  it("installs, reports and removes through the command", async () => {
    const codexHome = root();
    const script = join(root(), "agent-hook.js");
    writeFileSync(script, "");
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({ hooks: { Stop: [other] } }),
      { mode: 0o640 },
    );
    const lines: string[] = [];
    const run = (...args: string[]) =>
      agentsCli(args, {
        system: fakeSystem({ now, env: { CODEX_HOME: codexHome } }),
        print: (line) => lines.push(line),
        hookScript: script,
      });
    await run("hooks", "status", "--agent", "codex");
    expect(lines.at(-1)).toContain("Not installed");
    await run("hooks", "install", "--agent", "codex");
    expect(lines.at(-1)).toContain("/hooks");
    const file = join(codexHome, "hooks.json");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop).toHaveLength(2);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(codexHome)).toEqual(["hooks.json"]);
    await run("hooks", "status", "--agent", "codex");
    expect(lines.at(-1)).toContain("Installed");
    await run("hooks", "uninstall", "--agent", "codex");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      hooks: { Stop: [other] },
    });
    await expect(run("hooks", "install", "--agent", "pi")).rejects.toThrow(
      "two agents",
    );
    await expect(
      agentsCli(["hooks", "install", "--agent", "codex"], {
        system: fakeSystem({ now, env: { CODEX_HOME: codexHome } }),
        print: () => {},
        hookScript: join(codexHome, "missing.js"),
      }),
    ).rejects.toThrow("npm run build");
  });
});
