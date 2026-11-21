import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import {
  ChatLog,
  Supervisor,
  type ModelClient,
  type SupervisorWorld,
  type ToolCall,
  type ToolSpec,
} from "../connectors/agents/brain.js";
import { DecisionDesk } from "../connectors/agents/decisions.js";
import type { Runner } from "../connectors/agents/focus.js";
import type {
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";
import {
  cleanView,
  showOnCall,
  ViewStore,
  windowView,
} from "../connectors/agents/view.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = Date.UTC(2026, 10, 21, 6, 0, 0);
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-view-"));
const session = (values: Partial<AgentSession> = {}): AgentSession => ({
  id: "13",
  pid: 113,
  agent: "claude-code",
  agentLabel: "Claude Code",
  agentVersion: null,
  name: "work-13",
  project: "work",
  cwd: "/work/app",
  mode: "interactive",
  state: "working",
  detail: "turn_running",
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
/** A runner that answers the tab script with ok and the window query with a place. */
function recorder(window = "0.1 0.05 0.5 0.8") {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("JavaScript"))
      return { status: 0, stdout: `${window}\n` };
    return { status: 0, stdout: "ok\n" };
  };
  return { calls, run };
}

describe("the view of a call", () => {
  it("is a part of the screen in shares, kept inside the screen, in an owner-only file", () => {
    expect(cleanView({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: 0.6,
    });
    expect(cleanView({ x: 0.7, y: -0.2, w: 0.6, h: 0.5 })).toEqual({
      x: 0.7,
      y: 0,
      w: 0.3,
      h: 0.5,
    });
    for (const bad of [null, "x", {}, { x: 0, y: 0, w: 0.01, h: 1 }])
      expect(cleanView(bad)).toBeNull();
    const directory = root();
    const store = new ViewStore(directory, () => now);
    expect(store.get()).toEqual({ view: null, at: 0 });
    store.set({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
    expect(store.get()).toEqual({
      view: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
      at: now,
    });
    expect(statSync(join(directory, "agents", "view.json")).mode & 0o777).toBe(
      0o600,
    );
    store.set(null);
    expect(store.get()).toEqual({ view: null, at: now });
  });

  it("reads the front window of an application as shares, with the name as an argument", async () => {
    const { calls, run } = recorder("0 0.0336 1 0.8809");
    expect(await windowView(run, "Ghostty")).toEqual({
      x: 0,
      y: 0.0336,
      w: 1,
      h: 0.8809,
    });
    expect(calls[0]!.slice(0, 3)).toEqual([
      "/usr/bin/osascript",
      "-l",
      "JavaScript",
    ]);
    expect(calls[0]!.at(-1)).toBe("Ghostty");
    expect(calls[0]![4]).not.toContain("Ghostty");
    expect(await windowView(recorder("none").run, "Terminal")).toBeNull();
    const failing: Runner = async () => ({ status: 1, stdout: "" });
    expect(await windowView(failing, "Terminal")).toBeNull();
  });

  it("brings the session's tab to the front, then takes its window as the view", async () => {
    const directory = root();
    const store = new ViewStore(directory, () => now);
    const { calls, run } = recorder();
    const result = await showOnCall(
      { store, run, titles: () => ["work-13"], pause: async () => {} },
      session(),
    );
    expect(result).toEqual({
      ok: true,
      said: 'The call now shows only the window of work-13. Say "show the whole screen" to go back.',
    });
    // The tab first, then the window of its terminal application.
    expect(calls[0]![2]).toContain('tell application "Terminal"');
    expect(calls[1]!.at(-1)).toBe("Terminal");
    expect(store.get().view).toEqual({ x: 0.1, y: 0.05, w: 0.5, h: 0.8 });
    // The whole screen again.
    expect(
      (await showOnCall({ store, run, titles: () => [] }, null)).said,
    ).toBe("The call shows the whole screen again.");
    expect(store.get().view).toBeNull();
  });

  it("changes nothing for a session with no window, an unknown terminal, or a window that is not found", async () => {
    const directory = root();
    const store = new ViewStore(directory, () => now);
    store.set({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    const deps = (window?: string) => ({
      store,
      run: recorder(window).run,
      titles: () => ["work-13"],
      pause: async () => {},
    });
    for (const item of [
      session({ focus: "none" }),
      session({ host: "mini" }),
      session({
        terminal: {
          tty: "ttys001",
          app: "Hyper",
          appPath: "/Applications/Hyper.app",
          tmux: null,
          remote: false,
        },
      }),
    ])
      expect((await showOnCall(deps(), item)).ok).toBe(false);
    expect((await showOnCall(deps("none"), session())).ok).toBe(false);
    expect(store.get().view).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
  });
});

const board = (sessions: AgentSession[]): BoardSnapshot => ({
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: { needs_you: 0, working: sessions.length, idle: 0, unknown: 0 },
  sessions,
});
function scripted(steps: (ToolCall[] | string)[]) {
  let step = 0;
  const results: string[] = [];
  const offered: ToolSpec[][] = [];
  const model: ModelClient = {
    async complete(input) {
      offered.push(input.tools);
      const last = input.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      const next = steps[Math.min(step++, steps.length - 1)]!;
      return typeof next === "string"
        ? { text: next, toolCalls: [] }
        : { text: "", toolCalls: next };
    },
  };
  return { model, results, offered };
}
const call = (
  name: string,
  args: unknown = {},
  id = `c-${name}`,
): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

describe("the brain changes what the call shows", () => {
  const lines = session({ id: "13", name: "work-13" });
  const hipaa = session({ id: "9d", pid: 109, name: "work-9d" });
  function world() {
    const shown: string[] = [];
    const value: SupervisorWorld = {
      now: () => now,
      board: () => board([lines, hipaa]),
      desk: new DecisionDesk(root(), () => now),
      focus: async () => ({ ok: true }),
      send: async () => ({ ok: true, route: "tty" }),
      clis: () => [],
      titles: (item) =>
        item.id === "13"
          ? ["work-13", "Line status check"]
          : ["work-9d", "HIPAA compliance roadmap"],
      callView: async (item) => {
        shown.push(item ? item.id : "screen");
        return {
          ok: true,
          said: item ? "Only that window." : "The whole screen.",
        };
      },
    };
    return { value, shown };
  }

  it("zooms the call in on the session that the person describes, and out again", async () => {
    const { value, shown } = world();
    const run = scripted([
      [call("call_view", { target: "session", session: "work-9d" })],
      "Done.",
    ]);
    await new Supervisor(value, run.model).reply(
      [],
      "zoom in just to the terminal where the line status check is happening",
      "call",
    );
    // The person's own words pick the session, not the model's other choice.
    expect(shown).toEqual([]);
    expect(run.results[0]).toContain("work-13");
    const { value: second, shown: seen } = world();
    await new Supervisor(
      second,
      scripted([
        [
          call("call_view", {
            target: "session",
            session: "the line status one",
          }),
        ],
        "Done.",
      ]).model,
    ).reply([], "zoom in on the line status check", "call");
    expect(seen).toEqual(["13"]);
    const { value: third, shown: out } = world();
    await new Supervisor(
      third,
      scripted([[call("call_view", { target: "screen" })], "Done."]).model,
    ).reply([], "show the whole screen again", "call");
    expect(out).toEqual(["screen"]);
  });

  it("changes no view that the person did not ask for, and offers the tool only where a view can change", async () => {
    for (const words of ["what is work-13 doing?", "do not zoom in", "yes"]) {
      const { value, shown } = world();
      const run = scripted([
        [call("call_view", { target: "session", session: "work-13" })],
        "No.",
      ]);
      await new Supervisor(value, run.model).reply([], words, "call");
      expect(shown).toEqual([]);
    }
    const { value } = world();
    delete value.callView;
    const run = scripted([[call("call_view", { target: "screen" })], "No."]);
    await new Supervisor(value, run.model).reply(
      [],
      "show the whole screen",
      "call",
    );
    expect(run.offered[0]!.map((tool) => tool.name)).not.toContain("call_view");
    expect(run.results[0]).toBe(
      "I cannot change what the call shows from here.",
    );
  });
});

describe("the commands of a call", () => {
  it("prints the view as data and clears it, and prints the newest messages for a call that starts", async () => {
    const directory = root();
    const lines: string[] = [];
    const cli = (group: string, args: string[]) =>
      agentsCli(["--supervisor", group, ...args], {
        system: fakeSystem({
          now,
          home: directory,
          env: { CLAWDTIME_CONFIG_HOME: directory },
        }),
        runner: async () => ({ status: 0, stdout: "" }),
        print: (line: string) => lines.push(line),
        model: null,
      });
    await cli("view", ["--json"]);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ view: null, at: 0 });
    new ViewStore(directory, () => now).set({ x: 0.1, y: 0.2, w: 0.5, h: 0.6 });
    await cli("view", ["--json"]);
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      view: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
      at: now,
    });
    await cli("view", []);
    expect(lines.at(-1)).toBe(
      "The call shows one window: 50 by 60 percent of the screen.",
    );
    await cli("view", ["clear"]);
    expect(
      JSON.parse(readFileSync(join(directory, "agents", "view.json"), "utf8"))
        .view,
    ).toBeNull();
    // The newest messages, as data, with no model call and no new message.
    const log = new ChatLog(directory);
    log.append({
      role: "user",
      text: "Build a landing page",
      at: now - 60_000,
      via: "chat",
    });
    log.append({
      role: "assistant",
      text: "On it.",
      at: now - 59_000,
      via: "chat",
    });
    await cli("chat", ["--recent", "5"]);
    expect(JSON.parse(lines.at(-1)!)).toEqual([
      { role: "user", text: "Build a landing page", at: now - 60_000 },
      { role: "assistant", text: "On it.", at: now - 59_000 },
    ]);
    expect(log.recent(10)).toHaveLength(2);
  });
});
