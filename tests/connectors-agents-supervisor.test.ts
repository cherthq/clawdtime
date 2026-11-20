import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsCli } from "../cli/agents.js";
import { main } from "../cli/main.js";
import { nextSteps } from "../cli/supervisor.js";
import {
  focusTab,
  frontPageText,
  listTabs,
  openPage,
  parseTabs,
  webAddress,
} from "../connectors/agents/browser.js";
import { Supervisor } from "../connectors/agents/brain.js";
import {
  answerInTerminalText,
  DecisionDesk,
  describeRequest,
  holdPolicy,
  hookOutput,
  type DecisionRequest,
} from "../connectors/agents/decisions.js";
import {
  answerByCall,
  callCanApprove,
  interpret,
  spokenQuestion,
  type CallClient,
} from "../connectors/agents/call.js";
import { BoardFeed } from "../connectors/agents/feed.js";
import type { Runner } from "../connectors/agents/focus.js";
import {
  applyHookPlan,
  hookPlan,
  plannedInstalled,
  removeHookPlan,
} from "../connectors/agents/hooks.js";
import {
  cleanInput,
  inputRoute,
  sendText,
} from "../connectors/agents/input.js";
import { inventory } from "../connectors/agents/inventory.js";
import { headline, renderDeck } from "../connectors/agents/report.js";
import {
  rememberable,
  requestPattern,
  Trove,
} from "../connectors/agents/trove.js";
import type {
  AgentSession,
  BoardSnapshot,
} from "../connectors/agents/types.js";
import { fakeSystem } from "./connectors-agents-fixture.js";

const now = new Date(2026, 10, 20, 12, 0, 0).getTime();
const root = () => mkdtempSync(join(tmpdir(), "clawdtime-supervisor-"));
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
const board = (sessions: AgentSession[]): BoardSnapshot => ({
  version: 1,
  generatedAt: now,
  intervalMs: 3000,
  counts: {
    needs_you: sessions.filter((s) => s.state === "needs_you").length,
    working: sessions.filter((s) => s.state === "working").length,
    idle: sessions.filter((s) => s.state === "idle").length,
    unknown: 0,
  },
  sessions,
});
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
const permission = (command: string) => ({
  session_id: "s1",
  cwd: "/work/app",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command },
});

describe("what an agent asks", () => {
  it("describes a permission, a single question and a plan, and nothing else", () => {
    expect(describeRequest(permission("npm test -- --watch"))).toEqual({
      kind: "permission",
      tool: "Bash",
      summary: "npm test -- --watch",
      options: [],
      pattern: "Bash:npm test",
      path: null,
      answerInTerminal: false,
    });
    expect(
      describeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        tool_input: { file_path: "/work/app/a.ts" },
      })?.summary,
    ).toBe("/work/app/a.ts");
    expect(
      describeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "shell",
        tool_input: { command: ["git", "push"] },
      })?.summary,
    ).toBe("git push");
    expect(
      describeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__x__y",
        tool_input: {},
      })?.summary,
    ).toBe("mcp__x__y");
    expect(
      describeRequest({ hook_event_name: "PermissionRequest", tool_input: {} }),
    ).toBeNull();
    const question = {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which framework?",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: false,
          },
        ],
      },
    };
    expect(describeRequest(question)).toEqual({
      kind: "question",
      tool: "AskUserQuestion",
      summary: "Which framework?",
      options: ["React", "Vue"],
      pattern: "AskUserQuestion",
      path: null,
      answerInTerminal: false,
    });
    // Several questions, or several choices at once, stay in the terminal.
    expect(
      describeRequest({
        ...question,
        tool_input: {
          questions: [
            question.tool_input.questions[0],
            question.tool_input.questions[0],
          ],
        },
      }),
    ).toBeNull();
    expect(
      describeRequest({
        ...question,
        tool_input: {
          questions: [
            { ...question.tool_input.questions[0], multiSelect: true },
          ],
        },
      }),
    ).toBeNull();
    expect(
      describeRequest({
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "1. Do it" },
      }),
    ).toMatchObject({ kind: "plan", summary: "1. Do it" });
    expect(
      describeRequest({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: {},
      }),
    ).toBeNull();
    expect(describeRequest({ hook_event_name: "Stop" })).toBeNull();
    // Control characters never reach the panel or the trove, and the text is bounded.
    expect(
      describeRequest(permission("echo \u001b[2J" + "x".repeat(900)))?.summary,
    ).toHaveLength(600);
    expect(describeRequest(permission("a\u0007\nb"))?.summary).toBe("a b");
  });

  it("prints the exact answer each agent reads", () => {
    const allow = hookOutput(
      permission("x"),
      { kind: "permission" },
      { decision: "allow", text: null },
    );
    expect(JSON.parse(allow!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(
      JSON.parse(
        hookOutput(
          permission("x"),
          { kind: "permission" },
          { decision: "deny", text: "Not on Friday." },
        )!,
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "Not on Friday." },
      },
    });
    expect(
      JSON.parse(
        hookOutput(
          permission("x"),
          { kind: "permission" },
          { decision: "deny", text: null },
        )!,
      ).hookSpecificOutput.decision.message,
    ).toBe("Declined from ClawdTime.");
    const questions = [
      {
        question: "Which framework?",
        options: [{ label: "React" }],
        multiSelect: false,
      },
    ];
    const asked = {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    };
    expect(
      JSON.parse(
        hookOutput(
          asked,
          { kind: "question" },
          { decision: "answer", text: "React" },
        )!,
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { questions, answers: { "Which framework?": "React" } },
      },
    });
    expect(
      JSON.parse(
        hookOutput(
          asked,
          { kind: "question" },
          { decision: "deny", text: "Ask me later." },
        )!,
      ).hookSpecificOutput,
    ).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: "Ask me later.",
    });
    const plan = {
      hook_event_name: "PreToolUse",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "1. Do it" },
    };
    expect(
      JSON.parse(
        hookOutput(plan, { kind: "plan" }, { decision: "allow", text: null })!,
      ).hookSpecificOutput,
    ).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { plan: "1. Do it" },
    });
    // An answer that does not fit the request says nothing: the agent asks in its terminal.
    expect(
      hookOutput(
        permission("x"),
        { kind: "permission" },
        { decision: "answer", text: "yes" },
      ),
    ).toBeNull();
    expect(
      hookOutput(
        asked,
        { kind: "question" },
        { decision: "answer", text: null },
      ),
    ).toBeNull();
  });

  it("waits for an answer only while someone attends, and longer when the person is away", () => {
    expect(holdPolicy({ attended: true, away: false })).toEqual({
      hold: true,
      seconds: 45,
    });
    expect(holdPolicy({ attended: true, away: true })).toEqual({
      hold: true,
      seconds: 540,
    });
    // With nobody at the desk the hook says nothing and the agent asks in its terminal.
    expect(holdPolicy({ attended: false, away: false })).toEqual({
      hold: false,
      seconds: 0,
    });
    expect(holdPolicy({ attended: false, away: true })).toEqual({
      hold: false,
      seconds: 0,
    });
  });
});

describe("decision desk", () => {
  it("takes a request, gives the hook the person's answer once, and keeps it in the trove", () => {
    let clock = now;
    const directory = root();
    const desk = new DecisionDesk(directory, () => clock);
    expect(desk.attended()).toBe(false);
    desk.attend();
    expect(desk.attended()).toBe(true);
    clock += 11_000;
    expect(desk.attended()).toBe(false);
    expect(desk.away()).toBe(false);
    desk.setAway(true);
    expect(desk.away()).toBe(true);

    const request = desk.open({
      agent: "claude-code",
      sessionId: "session-1",
      cwd: "/work/app",
      pids: [9, 8, 7, 6],
      described: describeRequest(permission("npm test"))!,
      holdSeconds: 45,
    });
    expect(request).toMatchObject({
      kind: "permission",
      tool: "Bash",
      summary: "npm test",
      pattern: "Bash:npm test",
      pids: [9, 8, 7],
      holdUntil: clock + 45_000,
    });
    expect(JSON.stringify(request)).not.toContain("session-1");
    expect(desk.pending().map((item) => item.id)).toEqual([request.id]);
    expect(desk.take(request.id)).toBeNull();
    // An answer that does not fit, or for an unknown request, is refused.
    expect(
      desk.answer(request.id, {
        decision: "answer",
        text: "yes",
        via: "panel",
      }),
    ).toBe(false);
    expect(
      desk.answer("0000000000000000", { decision: "allow", via: "panel" }),
    ).toBe(false);
    expect(desk.answer("../../etc", { decision: "allow", via: "panel" })).toBe(
      false,
    );
    clock += 4000;
    expect(
      desk.answer(request.id, {
        decision: "allow",
        via: "panel",
        remember: true,
      }),
    ).toBe(true);
    // The first answer stands.
    expect(desk.answer(request.id, { decision: "deny", via: "cli" })).toBe(
      false,
    );
    const answer = desk.take(request.id)!;
    expect(answer).toMatchObject({
      decision: "allow",
      via: "panel",
      remember: true,
    });
    const entry = desk.close(request, answer)!;
    expect(entry).toMatchObject({
      agent: "claude-code",
      project: "app",
      cwd: "/work/app",
      pattern: "Bash:npm test",
      decision: "allow",
      via: "panel",
      waitedSeconds: 4,
    });
    expect(desk.pending()).toEqual([]);
    expect(desk.take(request.id)).toBeNull();
    // "Remember" made one rule, for this project only.
    expect(desk.trove.rules()).toMatchObject([
      {
        agent: "claude-code",
        cwd: "/work/app",
        pattern: "Bash:npm test",
        decision: "allow",
      },
    ]);
    for (const name of ["decisions.jsonl", "rules.json"])
      expect(statSync(join(directory, "trove", name)).mode & 0o777).toBe(0o600);
  });

  it("drops a request whose time ran out and never answers it late", () => {
    let clock = now;
    const desk = new DecisionDesk(root(), () => clock);
    const request = desk.open({
      agent: "codex",
      sessionId: "t",
      cwd: "/work",
      pids: [],
      described: describeRequest(permission("make deploy"))!,
      holdSeconds: 45,
    });
    clock += 46_000;
    expect(desk.pending()).toEqual([]);
    expect(desk.answer(request.id, { decision: "allow", via: "panel" })).toBe(
      false,
    );
    expect(desk.close(request, null)).toBeNull();
    expect(desk.trove.decisions()).toEqual([]);
    // A hook that died leaves its file. It goes once the hold time is well past.
    const dead = desk.open({
      agent: "codex",
      sessionId: "t",
      cwd: "/work",
      pids: [],
      described: describeRequest(permission("make"))!,
      holdSeconds: 1,
    });
    clock += 7000;
    expect(desk.pending()).toEqual([]);
    expect(desk.get(dead.id)).toBeNull();
  });

  it("answers a question with text and refuses allow for it", () => {
    const desk = new DecisionDesk(root(), () => now);
    const described = describeRequest({
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          { question: "Which?", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
    })!;
    const request = desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/w",
      pids: [],
      described,
      holdSeconds: 45,
    });
    expect(desk.answer(request.id, { decision: "allow", via: "panel" })).toBe(
      false,
    );
    expect(
      desk.answer(request.id, { decision: "answer", text: "  ", via: "panel" }),
    ).toBe(false);
    expect(
      desk.answer(request.id, {
        decision: "answer",
        text: "B",
        via: "call",
        remember: true,
      }),
    ).toBe(true);
    // A question is never remembered as a rule.
    expect(desk.take(request.id)).toMatchObject({
      decision: "answer",
      text: "B",
      via: "call",
      remember: false,
    });
  });

  it("marks a request that the person cannot see whole, and allows it only in its terminal", async () => {
    // A line break, or more text than is shown: only the terminal shows all of it.
    expect(describeRequest(permission("npm test"))!.answerInTerminal).toBe(
      false,
    );
    for (const command of [
      "npm test\nrm -rf /work/app/x",
      `npm test ${"a".repeat(600)}`,
      "echo \u001b[2J",
    ])
      expect(
        describeRequest(permission(command))!.answerInTerminal,
        command,
      ).toBe(true);
    const plan = (text: string) =>
      describeRequest({
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: text },
      })!;
    // The lines of a plan are layout. A plan is marked only when it is cut.
    expect(plan("1. Read the code\n2. Fix it").answerInTerminal).toBe(false);
    expect(plan("step ".repeat(200)).answerInTerminal).toBe(true);

    const directory = root();
    const desk = new DecisionDesk(directory);
    const open = (command: string) =>
      desk.open({
        agent: "claude-code",
        sessionId: "s",
        cwd: "/work/app",
        pids: [],
        described: describeRequest(permission(command))!,
        holdSeconds: 45,
      });
    const request = open("npm test\nrm -rf /work/app/x");
    expect(request.answerInTerminal).toBe(true);
    expect(open("npm test").answerInTerminal).toBe(false);
    desk.close(
      desk.pending().find((item) => item.id !== request.id)!,
      null,
    );
    // The desk itself refuses, so every way to answer is covered.
    for (const via of ["panel", "cli", "call"] as const)
      expect(desk.answer(request.id, { decision: "allow", via }), via).toBe(
        false,
      );
    // The view says so, and the panel route gets a refusal.
    const feed = new BoardFeed({ root: directory });
    expect(feed.decisions().pending).toMatchObject([
      { id: request.id, answerInTerminal: true, canRemember: false },
    ]);
    expect(await feed.answer({ id: request.id, decision: "allow" })).toBe(
      false,
    );
    // The command.
    const lines: string[] = [];
    const before = process.exitCode;
    await agentsCli(["approve", request.id.slice(0, 8)], {
      system: fakeSystem({
        now: Date.now(),
        env: { CLAWDTIME_CONFIG_HOME: directory },
      }),
      print: (line) => lines.push(line),
      hookScript: "/x/agent-hook.js",
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = before;
    expect(lines.at(-1)).toBe(answerInTerminalText);
    // The chat, with no model and with one.
    const world = {
      now: () => Date.now(),
      board: () => null,
      desk,
      focus: async () => ({ ok: true }),
      send: async () => ({ ok: true, route: "tmux" }),
      clis: () => [],
    };
    expect(await new Supervisor(world, null).reply([], "approve", "chat")).toBe(
      answerInTerminalText,
    );
    const seen: string[] = [];
    await new Supervisor(world, {
      complete: async (input) => {
        const last = input.messages.at(-1)!;
        if (last.role === "tool") seen.push(last.content);
        return seen.length
          ? { text: "ok", toolCalls: [] }
          : {
              text: "",
              toolCalls: [
                {
                  id: "c1",
                  name: "decide",
                  arguments: JSON.stringify({
                    request: request.id,
                    decision: "allow",
                  }),
                },
              ],
            };
      },
    }).reply([], "yes, approve it", "chat");
    expect(seen).toEqual([answerInTerminalText]);
    // The call says that it cannot approve, and still takes a denial.
    expect(spokenQuestion(request)).toBe(
      "Claude Code in app asks to run the command: npm test rm -rf /work/app/x. That is not all of it, so I cannot approve it here: approve it in its terminal, or say deny.",
    );
    // A command that is shown whole in the panel, and is longer than what a call reads.
    const long = open(`npm test ${"b".repeat(300)}`);
    expect(long.answerInTerminal).toBe(false);
    expect(callCanApprove(long)).toBe(false);
    expect(callCanApprove(open("npm test"))).toBe(true);
    expect(spokenQuestion(long)).toContain(
      "That is not all of it, so I cannot approve it here: approve it in the panel or its terminal, or say deny.",
    );
    for (const item of desk.pending())
      if (item.id !== request.id) desk.close(item, null);
    const said: string[] = [];
    let reads = 0;
    let clock = Date.now();
    const answer = await answerByCall(
      {
        requestAttention: async () => ({
          request: { id: "att-1", state: "requested" },
        }),
        conversationTurns: async () => ({
          turns: [
            reads++ === 0
              ? { id: "t1", sequence: 1, text: "Approve it." }
              : { id: "t2", sequence: 2, text: "Deny it." },
          ],
          request: { state: "connected" },
        }),
        conversationOperation: async (_id, operation, body) => {
          if (operation === "reply") said.push((body as { text: string }).text);
          return {};
        },
        heartbeat: async () => ({}),
      },
      request,
      {
        now: () => (clock += 1000),
        deadline: clock + 500_000,
        pollMs: 1,
        beatMs: 100_000,
      },
    );
    expect(said).toEqual([
      "I cannot approve this one here. Approve it in its terminal, or say deny.",
      "Denied. I told it.",
    ]);
    expect(answer).toEqual({ decision: "deny", text: "Deny it." });
    expect(desk.take(request.id)).toBeNull();
    // A denial is taken.
    expect(desk.answer(request.id, { decision: "deny", via: "panel" })).toBe(
      true,
    );
  });
});

describe("trove", () => {
  it("groups requests narrowly, so a rule never widens by accident", () => {
    expect(requestPattern("Bash", "npm test -- --watch")).toBe("Bash:npm test");
    expect(requestPattern("Bash", "git push origin main")).toBe(
      "Bash:git push",
    );
    expect(requestPattern("Bash", "make deploy")).toBe("Bash:make deploy");
    expect(requestPattern("Bash", "ls -la")).toBe("Bash:ls");
    expect(requestPattern("shell", "cargo build")).toBe("Bash:cargo build");
    // Anything with shell syntax keeps the bare key, and the bare key takes no rule.
    for (const command of [
      "npm test && rm -rf /",
      "echo $(cat secret)",
      "cat a | sh",
      "a; b",
      "x > y",
      "`id`",
    ])
      expect(requestPattern("Bash", command)).toBe("Bash");
    expect(requestPattern("Edit", "/work/a.ts")).toBe("Edit");
    expect(requestPattern("mcp__github__create_issue", "anything")).toBe(
      "mcp__github__create_issue",
    );
    expect(requestPattern("", "x")).toBe("tool");
  });

  it("a standing rule never covers more than the command that the person saw", () => {
    const key = (command: string) =>
      describeRequest(permission(command))!.pattern;
    expect(key("git status")).toBe("Bash:git status");
    // The key comes from the raw command: a line break, a cut, or a program
    // with a slash keeps the bare tool name, which no rule matches.
    for (const command of [
      "git status\nrm -rf /work/app/x",
      "git status\r\nrm -rf /work/app/x",
      `git status ${"a".repeat(600)}; rm -rf /work/app/x`,
      `git status ${"a".repeat(600)}`,
      "/tmp/other/git status",
      "./git status",
    ])
      expect(key(command), command).toBe("Bash");
    // The parts of a command list are joined, and a break in a part counts.
    expect(
      describeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "shell",
        tool_input: { command: ["git", "status\nrm -rf x"] },
      })!.pattern,
    ).toBe("Bash");

    const trove = new Trove(root());
    const facts = { agent: "claude-code" as const, cwd: "/work/app" };
    // A key that is the program alone groups past answers, and is never a rule.
    for (const command of [
      "rm build/tmp.txt",
      "bash ./build.sh",
      "ls -la",
      "ls",
    ]) {
      const pattern = key(command)!;
      expect(pattern, command).toMatch(/^Bash:\S+$/);
      expect(rememberable({ ...facts, pattern }), command).toBe(false);
      expect(() => trove.addRule({ ...facts, pattern }, "", now)).toThrow(
        "too broad",
      );
    }
    expect(rememberable({ ...facts, pattern: "Bash:git status" })).toBe(true);
    expect(rememberable({ ...facts, pattern: "Bash" })).toBe(false);
    expect(rememberable({ ...facts, cwd: null, pattern: "Bash:a b" })).toBe(
      false,
    );
    // A rule of that kind that an earlier version wrote answers nothing.
    const old = root();
    mkdirSync(join(old, "trove"));
    writeFileSync(
      join(old, "trove", "rules.json"),
      JSON.stringify([
        {
          version: 1,
          id: "00000001",
          agent: "claude-code",
          cwd: "/work/app",
          pattern: "Bash:rm",
          decision: "allow",
          createdAt: now,
          note: "",
        },
      ]),
    );
    expect(new Trove(old).rules()).toHaveLength(1);
    expect(new Trove(old).matchRule({ ...facts, pattern: "Bash:rm" })).toBe(
      null,
    );
  });

  it("a rule for a file tool covers only a path inside its project folder", () => {
    const edit = (path: unknown) =>
      describeRequest({
        hook_event_name: "PermissionRequest",
        tool_name: "Edit",
        tool_input: { file_path: path },
      })!;
    expect(edit("/work/app/src/a.ts")).toMatchObject({
      pattern: "Edit",
      path: "/work/app/src/a.ts",
    });
    expect(describeRequest(permission("npm test"))!.path).toBeNull();
    const trove = new Trove(root());
    const facts = {
      agent: "claude-code" as const,
      cwd: "/work/app",
      pattern: "Edit",
    };
    // A rule is not made from a file outside the folder, or with no file.
    expect(() =>
      trove.addRule({ ...facts, path: "/Users/me/.zshrc" }, "", now),
    ).toThrow("outside the project folder");
    expect(() => trove.addRule(facts, "", now)).toThrow(
      "outside the project folder",
    );
    expect(rememberable({ ...facts, path: "/Users/me/.zshrc" })).toBe(false);
    const rule = trove.addRule(
      { ...facts, path: "/work/app/src/a.ts" },
      "",
      now,
    );
    for (const path of ["/work/app/src/b.ts", "src/b.ts", "/work/app"])
      expect(trove.matchRule({ ...facts, path })?.id, path).toBe(rule.id);
    for (const path of [
      "/Users/me/.zshrc",
      "/work/app/../other/a.ts",
      "../other/a.ts",
      "/work/application/a.ts",
      null,
      undefined,
    ])
      expect(trove.matchRule({ ...facts, path }), String(path)).toBeNull();
    // A link inside the folder that leads out of it is outside.
    const project = join(realpathSync(root()), "project");
    const outside = realpathSync(root());
    mkdirSync(project);
    symlinkSync(outside, join(project, "link"));
    const linked = new Trove(root());
    const here = { ...facts, cwd: project };
    linked.addRule({ ...here, path: join(project, "a.ts") }, "", now);
    expect(
      linked.matchRule({ ...here, path: join(project, "new", "b.ts") }),
    ).not.toBeNull();
    expect(
      linked.matchRule({ ...here, path: join(project, "link", "secret") }),
    ).toBeNull();
    // Any other tool is keyed by its name, as before.
    expect(
      rememberable({ ...facts, pattern: "mcp__github__create_issue" }),
    ).toBe(true);
  });

  it("suggests from past answers, keeps rules to one project, and refuses a broad rule", () => {
    const trove = new Trove(root());
    const facts = {
      agent: "claude-code" as const,
      cwd: "/work/app",
      pattern: "Bash:npm test",
    };
    const entry = (
      decision: "allow" | "deny",
      via: "panel" | "playbook" = "panel",
      cwd = "/work/app",
    ) =>
      trove.record({
        at: now,
        agent: "claude-code",
        project: "app",
        cwd,
        kind: "permission",
        tool: "Bash",
        pattern: "Bash:npm test",
        summary: "npm test",
        decision,
        text: null,
        via,
        waitedSeconds: 3,
      });
    entry("allow");
    entry("allow");
    entry("deny");
    entry("allow", "playbook");
    entry("allow", "panel", "/work/other");
    // A rule's own answers and other projects do not count as the person's answers here.
    expect(trove.suggest(facts)).toEqual({
      allowed: 2,
      denied: 1,
      lastAt: now,
    });
    expect(trove.suggest({ ...facts, agent: "codex" })).toEqual({
      allowed: 0,
      denied: 0,
      lastAt: null,
    });
    expect(trove.matchRule(facts)).toBeNull();
    const rule = trove.addRule(facts, "tests are safe here", now);
    expect(trove.addRule(facts, "again", now).id).toBe(rule.id);
    expect(trove.rules()).toHaveLength(1);
    expect(trove.matchRule(facts)?.id).toBe(rule.id);
    expect(trove.matchRule({ ...facts, cwd: "/work/other" })).toBeNull();
    expect(
      trove.matchRule({ ...facts, pattern: "Bash:npm publish" }),
    ).toBeNull();
    expect(trove.matchRule({ ...facts, cwd: null })).toBeNull();
    expect(() => trove.addRule({ ...facts, pattern: "Bash" }, "", now)).toThrow(
      "too broad",
    );
    expect(() => trove.addRule({ ...facts, cwd: null }, "", now)).toThrow(
      "project folder",
    );
    expect(trove.removeRule("nope")).toBe(false);
    expect(trove.removeRule(rule.id)).toBe(true);
    expect(trove.rules()).toEqual([]);
  });

  it("finds decisions by words, keeps critical notes, and writes a playbook", () => {
    const directory = root();
    const trove = new Trove(directory);
    trove.record({
      at: now - 86_400_000,
      agent: "codex",
      project: "site",
      cwd: "/work/site",
      kind: "permission",
      tool: "Bash",
      pattern: "Bash:git push",
      summary: "git push origin main",
      decision: "deny",
      text: "Not before review.",
      via: "call",
      waitedSeconds: 60,
    });
    trove.record({
      at: now,
      agent: "claude-code",
      project: "app",
      cwd: "/work/app",
      kind: "question",
      tool: "AskUserQuestion",
      pattern: "AskUserQuestion",
      summary: "Which framework?",
      decision: "answer",
      text: "React",
      via: "panel",
      waitedSeconds: 5,
    });
    expect(trove.search("push codex").map((entry) => entry.project)).toEqual([
      "site",
    ]);
    expect(trove.search("review")).toHaveLength(1);
    expect(trove.search("react app")).toHaveLength(1);
    expect(trove.search("nothing here")).toEqual([]);
    expect(trove.search("").map((entry) => entry.project)).toEqual([
      "app",
      "site",
    ]);
    trove.note("Never push to main without a review.", "site", now);
    expect(() => trove.note("   ", null, now)).toThrow("needs some text");
    trove.addRule(
      { agent: "claude-code", cwd: "/work/app", pattern: "Bash:npm test" },
      "",
      now,
    );
    // A broken line in the file is skipped. The rest still reads.
    writeFileSync(
      join(directory, "trove", "decisions.jsonl"),
      readFileSync(join(directory, "trove", "decisions.jsonl"), "utf8") +
        "{broken\n",
    );
    expect(trove.decisions()).toHaveLength(2);
    const playbook = trove.playbook(now);
    expect(playbook).toContain("## Critical decisions");
    expect(playbook).toContain("(site): Never push to main without a review.");
    expect(playbook).toContain(
      "Allow `Bash:npm test` for claude-code in `/work/app`",
    );
    expect(playbook).toContain(
      "| site | codex | `Bash:git push` | 0 | 1 | 0 |",
    );
    expect(new Trove(root()).playbook(now)).toContain(
      "None. Every request is answered by a person.",
    );
  });
});

describe("terminal input", () => {
  it("types into a tmux pane as text, then presses Enter", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "" }));
    const inTmux = session({
      focus: "pane",
      terminal: {
        tty: "ttys010",
        app: null,
        appPath: null,
        tmux: {
          session: "main",
          window: 0,
          pane: 0,
          paneId: "%7",
          socketArgs: ["-L", "work"],
          clientTty: null,
        },
        remote: false,
      },
    });
    expect(
      await sendText(
        inTmux,
        "yes, go on\u001b[2J",
        { enter: true },
        run,
        "/opt/homebrew/bin/tmux",
      ),
    ).toEqual({ ok: true, route: "tmux" });
    expect(calls).toEqual([
      [
        "/opt/homebrew/bin/tmux",
        "-L",
        "work",
        "send-keys",
        "-t",
        "%7",
        "-l",
        "--",
        "yes, go on[2J",
      ],
      [
        "/opt/homebrew/bin/tmux",
        "-L",
        "work",
        "send-keys",
        "-t",
        "%7",
        "Enter",
      ],
    ]);
    calls.length = 0;
    await sendText(inTmux, "-h", { enter: false }, run);
    // A leading dash is text, never an option, and no Enter follows.
    expect(calls).toEqual([
      ["tmux", "-L", "work", "send-keys", "-t", "%7", "-l", "--", "-h"],
    ]);
    // Text that must not be sent off holds no line break: a line break in a
    // terminal sends the line.
    calls.length = 0;
    await sendText(
      inTmux,
      "first line\nsecond line\r\n\nthird",
      { enter: false },
      run,
    );
    expect(calls).toEqual([
      [
        "tmux",
        "-L",
        "work",
        "send-keys",
        "-t",
        "%7",
        "-l",
        "--",
        "first line second line third",
      ],
    ]);
    const scripted = recorder(() => ({ status: 0, stdout: "ok\n" }));
    await sendText(
      session({
        terminal: {
          tty: "ttys001",
          app: "iTerm2",
          appPath: null,
          tmux: null,
          remote: false,
        },
      }),
      "one\ntwo",
      { enter: false },
      scripted.run,
    );
    expect(scripted.calls[0]!.slice(-3)).toEqual([
      "ttys001",
      "one two",
      "stay",
    ]);
    // With Return, the lines stay as the person gave them.
    calls.length = 0;
    await sendText(inTmux, "one\ntwo", { enter: true }, run);
    expect(calls[0]!.at(-1)).toBe("one\ntwo");
  });

  it("uses the terminal's own scripting, with the text as an argument", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok\n" }));
    expect(await sendText(session(), "approve", { enter: true }, run)).toEqual({
      ok: true,
      route: "terminal",
    });
    expect(calls[0]!.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(calls[0]!.slice(3)).toEqual(["ttys001", "approve", "enter"]);
    expect(calls[0]![2]).not.toContain("approve");
    const ghostty = session({
      terminal: {
        tty: "ttys012",
        app: "Ghostty",
        appPath: "/Applications/Ghostty.app",
        tmux: null,
        remote: false,
      },
      focus: "tab",
    });
    expect(inputRoute(ghostty)).toBe("ghostty");
    expect((await sendText(ghostty, "x", { enter: false }, run)).route).toBe(
      "ghostty",
    );
    expect(calls.at(-1)!.slice(3)).toEqual(["ttys012", "x", "stay"]);
    expect(
      inputRoute(
        session({ terminal: { ...session().terminal, app: "iTerm2" } }),
      ),
    ).toBe("iterm");
  });

  it("refuses where it cannot aim: an old Ghostty, a remote or background session, empty text", async () => {
    const { calls, run } = recorder(() => ({ status: 0, stdout: "ok" }));
    const oldGhostty = session({
      terminal: {
        tty: "ttys012",
        app: "Ghostty",
        appPath: "/Applications/Ghostty.app",
        tmux: null,
        remote: false,
      },
      focus: "app",
    });
    expect(await sendText(oldGhostty, "x", { enter: true }, run)).toEqual({
      ok: false,
      route: "none",
    });
    expect(inputRoute(session({ mode: "background" }))).toBe("none");
    expect(
      inputRoute(
        session({ terminal: { ...session().terminal, remote: true } }),
      ),
    ).toBe("none");
    expect(
      inputRoute(session({ terminal: { ...session().terminal, app: "Warp" } })),
    ).toBe("none");
    expect((await sendText(session(), "  ", { enter: true }, run)).ok).toBe(
      false,
    );
    // Terminal types text and Return as one step: it cannot leave the line open.
    expect(await sendText(session(), "x", { enter: false }, run)).toEqual({
      ok: false,
      route: "terminal",
    });
    expect(calls).toEqual([]);
    expect(
      cleanInput("a\u0000b\u001b[31mc\n\td" + "e".repeat(5000)),
    ).toHaveLength(4000);
    expect(cleanInput("a\u0000b\u001b[31mc\n\td")).toBe("ab[31mc\n\td");
  });
});

describe("hook plans", () => {
  const node = "/usr/local/bin/node",
    script = "/opt/clawdtime/dist/cli/agent-hook.js";
  it("gives Claude Code only the hooks that decide, and Codex the state hooks too", () => {
    const claude = hookPlan("claude-code", node, script);
    expect(
      claude.map((hook) => [
        hook.event,
        hook.matcher,
        hook.async,
        hook.timeout,
      ]),
    ).toEqual([
      ["PermissionRequest", undefined, false, 570],
      ["PreToolUse", "AskUserQuestion|ExitPlanMode", false, 570],
    ]);
    expect(claude[0]!.command).toBe(
      "'/usr/local/bin/node' '/opt/clawdtime/dist/cli/agent-hook.js' claude-code decide",
    );
    const codex = hookPlan("codex", node, script);
    expect(
      codex.filter((hook) => !hook.async).map((hook) => hook.event),
    ).toEqual(["PermissionRequest"]);
    expect(codex.find((hook) => hook.event === "Stop")).toMatchObject({
      async: true,
      timeout: 5,
      command:
        "'/usr/local/bin/node' '/opt/clawdtime/dist/cli/agent-hook.js' codex",
    });
  });

  it("adds its hooks to a settings file, keeps the rest, and removes only itself", () => {
    const plan = hookPlan("claude-code", node, script);
    const original = {
      model: "fable",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/usr/bin/true" }],
          },
        ],
        Stop: [{ hooks: [{ type: "command", command: "/usr/bin/say done" }] }],
      },
    };
    const installed = applyHookPlan(JSON.stringify(original), plan);
    const parsed = JSON.parse(installed);
    expect(parsed.model).toBe("fable");
    expect(parsed.permissions).toEqual(original.permissions);
    expect(parsed.hooks.Stop).toEqual(original.hooks.Stop);
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[1]).toEqual({
      matcher: "AskUserQuestion|ExitPlanMode",
      hooks: [{ type: "command", command: plan[1]!.command, timeout: 570 }],
    });
    expect(parsed.hooks.PermissionRequest).toEqual([
      { hooks: [{ type: "command", command: plan[0]!.command, timeout: 570 }] },
    ]);
    expect(plannedInstalled(installed, plan)).toHaveLength(2);
    expect(applyHookPlan(installed, plan)).toBe(installed);
    expect(JSON.parse(removeHookPlan(installed, plan))).toEqual(original);
    expect(plannedInstalled(JSON.stringify(original), plan)).toEqual([]);
    expect(() => applyHookPlan("{ nope", plan)).toThrow("not valid JSON");
  });
});

describe("inventory, report and browser", () => {
  const home = "/Users/tester";
  const system = () =>
    fakeSystem({
      now,
      home,
      env: { PATH: "/opt/bin:/usr/bin" },
      files: {
        "/opt/bin/claude": { text: "" },
        "/opt/bin/codex": { text: "" },
        "/opt/bin/pi": { text: "" },
        [`${home}/.claude/projects/-work-app/a.jsonl`]: {
          text: "{}",
          mtimeMs: now - 3_600_000,
        },
        [`${home}/.claude/projects/-work-app/b.jsonl`]: {
          text: "{}",
          mtimeMs: now - 20 * 86_400_000,
        },
        [`${home}/.claude/projects/-work-site/c.jsonl`]: {
          text: "{}",
          mtimeMs: now - 86_400_000,
        },
        [`${home}/.claude/projects/-work-site/notes.txt`]: { text: "" },
        [`${home}/.codex/sessions/2026/11/19/rollout-2026-11-19T10-00-00-01a1ed53-ed7d-76a0-aa93-6cd693483e27.jsonl`]:
          { text: "{}" },
        [`${home}/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-01a1ed53-ed7d-76a0-aa93-6cd693483e28.jsonl`]:
          { text: "{}" },
        [`${home}/.pi/agent/sessions/--work--/2026-11-20T06-00-00-000Z_01a1f72c-934f-703b-b944-5a1718c6f5f9.jsonl`]:
          { text: "{}" },
      },
      commands: (command) =>
        command === "/opt/bin/claude"
          ? { status: 0, stdout: "2.1.329 (Claude Code)\n" }
          : command === "/opt/bin/codex"
            ? { status: 0, stdout: "codex-cli 0.169.0\n" }
            : command === "/opt/bin/pi"
              ? { status: 1, stdout: "" }
              : undefined,
    });

  it("lists each agent command with its version and its use, from file names and times only", () => {
    const facts = inventory(
      system(),
      board([
        session(),
        session({ id: "2-a", pid: 2 }),
        session({ id: "3-a", pid: 3, agent: "amp", agentLabel: "Amp" }),
      ]),
    );
    expect(facts.map((fact) => fact.kind)).toEqual([
      "claude-code",
      "codex",
      "pi",
      "amp",
    ]);
    expect(facts[0]).toMatchObject({
      installed: true,
      path: "/opt/bin/claude",
      version: "2.1.329 (Claude Code)",
      sessions: 3,
      sessionsLast7Days: 2,
      lastUsedAt: now - 3_600_000,
      runningNow: 2,
    });
    expect(facts[1]).toMatchObject({
      version: "codex-cli 0.169.0",
      sessions: 2,
      sessionsLast7Days: 1,
      runningNow: 0,
    });
    expect(facts[2]).toMatchObject({
      kind: "pi",
      version: null,
      sessions: 1,
      sessionsLast7Days: 1,
    });
    // Running but not on the PATH, and with no session store ClawdTime can count.
    expect(facts[3]).toMatchObject({
      kind: "amp",
      installed: false,
      path: null,
      sessions: null,
      runningNow: 1,
    });
  });

  it("writes a deck that escapes every value and says the most urgent thing first", () => {
    expect(headline(board([session()]))).toBe("1 agent needs you");
    expect(
      headline(
        board([session({ state: "working" }), session({ state: "working" })]),
      ),
    ).toBe("2 agents at work");
    expect(headline(board([session({ state: "idle" })]))).toBe("All quiet");
    expect(headline(board([]))).toBe("No agents are running");
    const trove = new Trove(root());
    trove.record({
      at: now,
      agent: "claude-code",
      project: "app",
      cwd: "/work/app",
      kind: "permission",
      tool: "Bash",
      pattern: "Bash:npm test",
      summary: "npm test <script>alert(1)</script>",
      decision: "allow",
      text: null,
      via: "call",
      waitedSeconds: 3,
    });
    trove.note("Never push to main without a review.", null, now);
    const deck = renderDeck({
      now,
      board: board([session({ name: "<img src=x onerror=alert(1)>" })]),
      clis: inventory(system(), null),
      decisions: trove.decisions(),
      rules: [],
      notes: trove.notes(),
      next: ["Answer deploy fix."],
    });
    expect(deck.startsWith("<!doctype html>")).toBe(true);
    expect(deck).toContain("<h1>1 agent needs you</h1>");
    expect(deck).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(deck).not.toContain("<img src=x");
    expect(deck).not.toContain("<script>alert(1)");
    expect(deck).toContain("Never push to main without a review.");
    expect(deck).toContain("Answer deploy fix.");
    expect(deck.match(/<section class="slide">/g)).toHaveLength(6);
    // One file with no network: no link to another host.
    expect(deck).not.toMatch(/https?:\/\//);
  });

  it("says what to do next", () => {
    const clis = inventory(system(), null);
    const steps = nextSteps(
      board([
        session(),
        session({
          id: "2-a",
          terminal: {
            tty: "t",
            app: "Ghostty",
            appPath: null,
            tmux: null,
            remote: false,
          },
          focus: "app",
          state: "idle",
        }),
      ]),
      clis,
      { claude: false, codex: false },
      0,
      now,
    );
    expect(steps[0]).toBe("Answer deploy fix (Claude Code). It has waited 1m.");
    expect(steps.join("\n")).toContain("hooks install --agent claude-code");
    expect(steps.join("\n")).toContain("hooks install --agent codex");
    expect(steps.join("\n")).toContain("Update Ghostty to 1.4");
    expect(
      nextSteps(board([]), clis, { claude: true, codex: true }, 2, now),
    ).toEqual([]);
  });

  it("lists, opens and focuses browser tabs, and opens only web addresses", async () => {
    expect(
      parseTabs(
        "Google Chrome",
        "1\t1\tfalse\tInbox\thttps://mail.example/\n1\t2\ttrue\tPull request\thttps://github.com/x/y/pull/5\nbad line\n",
      ),
    ).toEqual([
      {
        browser: "Google Chrome",
        window: 1,
        tab: 1,
        active: false,
        title: "Inbox",
        url: "https://mail.example/",
      },
      {
        browser: "Google Chrome",
        window: 1,
        tab: 2,
        active: true,
        title: "Pull request",
        url: "https://github.com/x/y/pull/5",
      },
    ]);
    const { calls, run } = recorder((command, args) =>
      args[1]?.includes("active tab index of window w")
        ? { status: 0, stdout: "1\t1\ttrue\tDocs\thttps://docs.example/\n" }
        : { status: 0, stdout: "ok\n" },
    );
    expect(await listTabs(["Google Chrome"], run)).toHaveLength(1);
    expect(
      await focusTab({ browser: "Google Chrome", window: 1, tab: 2 }, run),
    ).toBe(true);
    expect(calls.at(-1)!.slice(3)).toEqual(["1", "2"]);
    expect(await openPage("https://trychert.com/pricing", null, run)).toBe(
      true,
    );
    expect(calls.at(-1)).toEqual([
      "/usr/bin/open",
      "https://trychert.com/pricing",
    ]);
    await openPage("http://localhost:3000", "Safari", run);
    expect(calls.at(-1)).toEqual([
      "/usr/bin/open",
      "-a",
      "Safari",
      "http://localhost:3000/",
    ]);
    for (const bad of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "ftp://x",
    ])
      expect(() => webAddress(bad)).toThrow();
    expect(
      await frontPageText("Google Chrome", async () => ({
        status: 1,
        stdout: "",
      })),
    ).toBeNull();
    expect(
      await frontPageText("Safari", async () => ({
        status: 0,
        stdout: "Title\nBody\u0007 text",
      })),
    ).toBe("Title\nBody text");
  });
});

describe("supervisor commands", () => {
  it("answers a pending request from the command line and records it", async () => {
    const directory = root();
    const fake = () =>
      fakeSystem({
        now: Date.now(),
        env: { CLAWDTIME_CONFIG_HOME: directory },
      });
    const desk = new DecisionDesk(directory);
    const lines: string[] = [];
    const run = (...args: string[]) =>
      agentsCli(args, {
        system: fake(),
        print: (line) => lines.push(line),
        hookScript: "/x/agent-hook.js",
      });
    await run("pending");
    expect(lines.at(-1)).toContain("Nothing waits");
    const first = desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: describeRequest(permission("npm test"))!,
      holdSeconds: 45,
    });
    const second = desk.open({
      agent: "codex",
      sessionId: "t",
      cwd: "/work/site",
      pids: [],
      described: describeRequest(permission("git push origin main"))!,
      holdSeconds: 45,
    });
    await run("pending");
    const listed = lines.slice(-2).join("\n");
    expect(listed).toContain(
      `${first.id.slice(0, 8)}  claude-code in app  permission: npm test`,
    );
    expect(listed).toContain(
      `${second.id.slice(0, 8)}  codex in site  permission: git push origin main`,
    );
    // Each line starts with the id. A place in the list is not printed: it is not a name.
    expect(listed).toMatch(/^[0-9a-f]{8}  .*\n[0-9a-f]{8}  /);
    // A bare position is refused, and the message shows the ids.
    for (const place of ["1", "2", "12", "abc"]) {
      const refusal = await run("approve", place).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(refusal, place).toContain(
        "Give the id of the request, or its first four characters or more",
      );
      expect(refusal).toContain(`${first.id.slice(0, 8)}  claude-code in app`);
      expect(refusal).toContain(`${second.id.slice(0, 8)}  codex in site`);
    }
    await expect(run("deny")).rejects.toThrow("Give the id of the request");
    expect(desk.take(first.id)).toBeNull();
    expect(desk.take(second.id)).toBeNull();
    await run("approve", first.id.slice(0, 8), "--always");
    expect(lines.at(-1)).toBe(
      "Allowed, and remembered for this project. The agent continues.",
    );
    expect(desk.take(first.id)).toMatchObject({
      decision: "allow",
      via: "cli",
      remember: true,
    });
    await run("deny", second.id.slice(0, 6), "--message", "Not before review.");
    expect(desk.take(second.id)).toMatchObject({
      decision: "deny",
      text: "Not before review.",
    });
    await expect(run("approve", "abcd")).rejects.toThrow("no longer waits");
    await run("away", "on");
    expect(lines.at(-1)).toContain("Away");
    expect(desk.away()).toBe(true);
    await run("away", "off");
    expect(lines.at(-1)).toContain("Here");
    desk.close(first, desk.take(first.id));
    desk.close(second, desk.take(second.id));

    const top = (...args: string[]) =>
      agentsCli(["--supervisor", ...args], {
        system: fake(),
        print: (line) => lines.push(line),
        hookScript: "/x/agent-hook.js",
      });
    await top("trove");
    expect(lines.slice(-2).join("\n")).toContain("deny");
    await top("trove", "search", "push");
    expect(lines.at(-1)).toContain("-> Not before review.");
    await top("trove", "rules");
    expect(lines.at(-1)).toContain(
      "allow Bash:npm test  for claude-code in /work/app",
    );
    await top("trove", "note", "Never", "push", "on", "Friday.");
    expect(lines.at(-1)).toContain("Kept as a critical decision");
    await top("trove", "playbook");
    expect(lines.at(-1)).toContain("Never push on Friday.");
    await top("trove", "forget", desk.trove.rules()[0]!.id);
    expect(desk.trove.rules()).toEqual([]);
    await top("report", "--out", join(directory, "deck.html"));
    expect(readFileSync(join(directory, "deck.html"), "utf8")).toContain(
      "ClawdTime report",
    );
    expect(statSync(join(directory, "deck.html")).mode & 0o777).toBe(0o600);
    await top("clis", "--json");
    expect(JSON.parse(lines.at(-1)!)).toEqual([]);
    expect(readdirSync(join(directory, "trove")).sort()).toEqual([
      "decisions.jsonl",
      "notes.jsonl",
      "rules.json",
    ]);
  });

  it("installs the Claude Code hooks into a settings file and keeps its other settings", async () => {
    const claudeHome = root();
    const script = join(root(), "agent-hook.js");
    writeFileSync(script, "");
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({
        model: "fable",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }],
        },
      }),
    );
    const lines: string[] = [];
    const run = (...args: string[]) =>
      agentsCli(args, {
        system: fakeSystem({ now, env: { CLAUDE_CONFIG_DIR: claudeHome } }),
        print: (line) => lines.push(line),
        hookScript: script,
      });
    await run("hooks", "status", "--agent", "claude-code");
    expect(lines.at(-1)).toContain("cannot answer its prompts");
    await run("hooks", "install", "--agent", "claude-code");
    expect(lines.at(-1)).toContain("only acts while ClawdTime runs");
    const settings = JSON.parse(
      readFileSync(join(claudeHome, "settings.json"), "utf8"),
    );
    expect(settings.model).toBe("fable");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "PermissionRequest",
      "PreToolUse",
      "Stop",
    ]);
    await run("hooks", "status", "--agent", "claude-code");
    expect(lines.at(-1)).toContain("Installed");
    await run("hooks", "uninstall", "--agent", "claude-code");
    expect(
      JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")),
    ).toEqual({
      model: "fable",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }],
      },
    });
    await expect(run("hooks", "install", "--agent", "pi")).rejects.toThrow(
      "two agents",
    );
  });

  it("routes the new top-level commands", async () => {
    const directory = root();
    const previous = process.env.CLAWDTIME_CONFIG_HOME;
    process.env.CLAWDTIME_CONFIG_HOME = directory;
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(String(line));
    try {
      await main(["trove", "note", "Routing", "works."]);
      await main(["trove", "playbook"]);
    } finally {
      console.log = log;
      if (previous === undefined) delete process.env.CLAWDTIME_CONFIG_HOME;
      else process.env.CLAWDTIME_CONFIG_HOME = previous;
    }
    expect(lines.join("\n")).toContain("Routing works.");
  });
});

describe("answer by phone", () => {
  const request = (values: Partial<DecisionRequest> = {}): DecisionRequest => ({
    version: 1,
    id: "0123456789abcdef",
    agent: "claude-code",
    sessionKey: "a".repeat(32),
    cwd: "/work/app",
    pids: [],
    kind: "permission",
    tool: "Bash",
    summary: "npm test",
    pattern: "Bash:npm test",
    options: [],
    createdAt: now,
    holdUntil: now + 540_000,
    ...values,
  });
  const question = request({
    kind: "question",
    tool: "AskUserQuestion",
    summary: "Which color?",
    options: ["Red", "Blue"],
  });

  it("says who asks, what, and how to answer", () => {
    expect(spokenQuestion(request())).toBe(
      "Claude Code in app asks to run the command: npm test. Say approve or deny.",
    );
    expect(
      spokenQuestion(request({ tool: "Edit", summary: "/work/app/a.ts" })),
    ).toBe(
      "Claude Code in app asks to run Edit: /work/app/a.ts. Say approve or deny.",
    );
    expect(spokenQuestion(question)).toBe(
      "Claude Code in app asks: Which color? one, Red. two, Blue. Say the number or the answer.",
    );
    expect(spokenQuestion(request({ kind: "plan", cwd: null }))).toBe(
      "Claude Code has a plan ready. Say approve to start it, or deny.",
    );
  });

  it("reads a clear spoken answer and treats everything else as no answer", () => {
    const read = (words: string, item = request()) => interpret(words, item);
    for (const words of [
      "Approve.",
      "yes",
      "Yeah, go ahead",
      "ok do it",
      "Sure, approve it",
    ])
      expect(read(words)?.decision, words).toBe("allow");
    for (const words of [
      "Deny",
      "no",
      "No, don't run that",
      "stop",
      "reject it",
    ])
      expect(read(words)?.decision, words).toBe("deny");
    expect(read("No, use the staging branch")).toEqual({
      decision: "deny",
      text: "No, use the staging branch",
    });
    // Unclear, both at once, noise or silence never approve.
    for (const words of [
      "",
      "hmm",
      "what does it do?",
      "yes, no, wait",
      "I approve of the weather but do not run it",
      "the television is on",
    ])
      expect(read(words), words).toBeNull();
    expect(read("Blue", question)).toEqual({
      decision: "answer",
      text: "Blue",
    });
    expect(read("number two please", question)).toEqual({
      decision: "answer",
      text: "Blue",
    });
    expect(read("the first one", question)).toEqual({
      decision: "answer",
      text: "Red",
    });
    expect(read("red or blue, I am not sure", question)).toBeNull();
    expect(read("green", question)).toBeNull();
    expect(read("no, skip the question", question)?.decision).toBe("deny");
    // A word inside another word is not an answer.
    expect(
      read(
        "I am not bored",
        request({ kind: "question", options: ["Red", "Blue"] }),
      ),
    ).toBeNull();
    expect(read("that is acknowledged")).toBeNull();
  });

  it("a negation, a hedge or a question is never an approval", () => {
    const read = (words: string, item = request()) => interpret(words, item);
    for (const words of [
      "I would not allow that",
      "I'm not sure",
      "I\u2019m not sure",
      "I can't approve that",
      "I cannot approve that",
      "I won't approve this",
      "that is not okay",
      "never approve that",
      "maybe yes",
      "I think so, yes",
      "I guess it's okay",
      "Is it ok to allow this?",
      "is it ok to allow this",
      "should I approve it",
      "can you approve that",
      "what happens if I allow it",
      "ok is it safe to allow",
      "Okay. What is it asking",
      "wait, okay, what is it asking",
      "hold on, okay",
      "Yeah? Hello?",
      "yeah hello",
      "why would I approve that",
      "do you think it is ok",
      "does it look okay",
    ])
      expect(read(words), words).toBeNull();
    // A clear answer still stands.
    for (const words of [
      "Approve.",
      "yes",
      "okay",
      "ok do it",
      "Yes, go ahead and approve it",
      "um, sure",
    ])
      expect(read(words)?.decision, words).toBe("allow");
    // A sentence that opens with its refusal denies, whatever follows.
    for (const words of [
      "No.",
      "Deny",
      "never",
      "Do not run that",
      "don't",
      "I said no",
      "No, why would it do that?",
      "No, I think that is wrong",
    ])
      expect(read(words)?.decision, words).toBe("deny");
    // A refusal that is asked or hedged is no answer either.
    for (const words of ["should I deny it", "maybe deny it", "I don't know"])
      expect(read(words), words).toBeNull();

    for (const words of [
      "Which one is safer?",
      "which one is safer",
      "hold on one moment",
      "give me one second",
      "I do not want the first",
      "not the first one",
      "maybe red",
      "Red?",
    ])
      expect(read(words, question), words).toBeNull();
    expect(read("number one", question)?.text).toBe("Red");
    expect(read("I want red please", question)?.text).toBe("Red");
    // A choice whose own words refuse or ask is still that choice.
    const yesNo = request({ kind: "question", options: ["Yes", "No"] });
    expect(read("no", yesNo)).toEqual({ decision: "answer", text: "No" });
    expect(read("Yes.", yesNo)).toEqual({ decision: "answer", text: "Yes" });
    const worded = request({
      kind: "question",
      options: ["What we have now", "Do not migrate"],
    });
    expect(read("what we have now", worded)?.text).toBe("What we have now");
    expect(read("do not migrate, please", worded)?.text).toBe("Do not migrate");
  });

  function phone(
    script: {
      turns: { id: string; sequence: number; text?: string }[];
      state?: string;
    }[],
  ) {
    const log: string[] = [];
    let page = 0;
    const client: CallClient = {
      async requestAttention(input) {
        log.push(
          `call ${input.reason} ${input.idempotencyKey}: ${input.question}`,
        );
        return { request: { id: "att-1", state: "requested" } };
      },
      async conversationTurns(_id, after) {
        log.push(`turns after ${after}`);
        const next = script[Math.min(page++, script.length - 1)]!;
        return {
          turns: next.turns,
          request: { state: next.state ?? "connected" },
        };
      },
      async conversationOperation(_id, operation, body) {
        log.push(`${operation} ${JSON.stringify(body)}`);
        return {};
      },
      async heartbeat() {
        log.push("heartbeat");
        return {};
      },
    };
    return { client, log };
  }

  it("places one call, asks again when the words are unclear, and ends on a clear answer", async () => {
    let clock = now;
    const { client, log } = phone([
      { turns: [] },
      { turns: [{ id: "t1", sequence: 1, text: "what does it do" }] },
      {
        turns: [
          { id: "t2", sequence: 2, text: "um" },
          { id: "t3", sequence: 3, text: "Okay, approve it." },
        ],
      },
    ]);
    const answer = await answerByCall(client, request(), {
      now: () => (clock += 1000),
      deadline: now + 500_000,
      pollMs: 1,
      beatMs: 100_000,
    });
    expect(answer).toEqual({ decision: "allow", text: null });
    expect(log[0]).toBe(
      "call approval decision-0123456789abcdef: Claude Code in app asks to run the command: npm test. Say approve or deny.",
    );
    expect(log).toContain('ack {"turnId":"t1"}');
    expect(log).toContain(
      'reply {"turnId":"t1","replyId":"reply-t1","text":"Say approve, or say deny.","expectedCursor":1}',
    );
    expect(log).toContain(
      'reply {"turnId":"t3","replyId":"reply-t3","text":"Approved. It continues now.","expectedCursor":3}',
    );
    expect(log.slice(-2)).toEqual([
      'progress {"turnId":"t3","state":"completed"}',
      "end {}",
    ]);
    expect(log.filter((line) => line.startsWith("call "))).toHaveLength(1);
    // The cursor moves forward, so no turn is read twice.
    expect(log.filter((line) => line.startsWith("turns after"))).toEqual([
      "turns after 0",
      "turns after 0",
      "turns after 1",
    ]);
  });

  it("reads all turns of a batch together, and a negation that ends a batch holds for the next", async () => {
    let clock = now;
    const timing = () => ({
      now: () => (clock += 1000),
      deadline: now + 500_000,
      pollMs: 1,
      beatMs: 100_000,
    });
    // One sentence in two fragments: its last fragment alone would approve.
    const split = phone([
      {
        turns: [
          { id: "t1", sequence: 1, text: "Do not" },
          { id: "t2", sequence: 2, text: "approve that." },
        ],
      },
      { turns: [{ id: "t3", sequence: 3, text: "Deny it." }] },
    ]);
    expect(await answerByCall(split.client, request(), timing())).toEqual({
      decision: "deny",
      text: "Deny it.",
    });
    expect(split.log).toContain(
      'reply {"turnId":"t2","replyId":"reply-t2","text":"Say approve, or say deny.","expectedCursor":2}',
    );
    expect(split.log.join("\n")).not.toContain("Approved");
    // The same kind of sentence over two reads.
    clock = now;
    const late = phone([
      { turns: [{ id: "t1", sequence: 1, text: "I would not" }] },
      { turns: [{ id: "t2", sequence: 2, text: "allow that" }] },
      { turns: [{ id: "t3", sequence: 3, text: "approve" }] },
    ]);
    expect(await answerByCall(late.client, request(), timing())).toEqual({
      decision: "allow",
      text: null,
    });
    expect(
      late.log.filter((line) => line.includes("Say approve, or say deny.")),
    ).toHaveLength(2);
  });

  it("gives no answer when the call is not picked up, ends, or runs out of time", async () => {
    let clock = now;
    const missed = phone([{ turns: [], state: "unanswered" }]);
    expect(
      await answerByCall(missed.client, request(), {
        now: () => (clock += 1000),
        deadline: now + 500_000,
        pollMs: 1,
        beatMs: 100_000,
      }),
    ).toBeNull();
    clock = now;
    const silent = phone([{ turns: [] }]);
    expect(
      await answerByCall(silent.client, request(), {
        now: () => (clock += 30_000),
        deadline: now + 100_000,
        pollMs: 1,
        beatMs: 100_000,
      }),
    ).toBeNull();
    expect(silent.log.at(-1)).toBe("end {}");
    // Too little time left for a call: none is placed.
    const late = phone([{ turns: [] }]);
    expect(
      await answerByCall(late.client, request(), {
        now: () => now,
        deadline: now + 10_000,
      }),
    ).toBeNull();
    expect(late.log).toEqual([]);
  });

  it("in away mode the service attends the desk and places the call by itself, with no panel", async () => {
    const directory = root();
    const calls: string[] = [];
    const feed = new BoardFeed({
      root: directory,
      now: () => Date.now(),
      call: async (item) => {
        calls.push(item.id);
        return { decision: "allow", text: null };
      },
    });
    // At the desk nobody reads the panel: the service alone does not attend,
    // so a hook would not hold and the agent keeps its own prompt.
    feed.superviseAway();
    expect(feed.desk.attended()).toBe(false);
    expect(
      holdPolicy({ attended: feed.desk.attended(), away: feed.desk.away() }),
    ).toEqual({ hold: false, seconds: 0 });
    // Away, with a phone link: the service attends. No panel read happens here.
    feed.setAway(true);
    feed.superviseAway();
    expect(feed.desk.attended()).toBe(true);
    expect(
      holdPolicy({ attended: feed.desk.attended(), away: feed.desk.away() }),
    ).toEqual({ hold: true, seconds: 540 });
    const waiting = feed.desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: describeRequest(permission("npm test"))!,
      holdSeconds: 540,
    });
    feed.superviseAway();
    feed.superviseAway();
    await new Promise((done) => setTimeout(done, 10));
    // One call for the request, however often the service looks.
    expect(calls).toEqual([waiting.id]);
    expect(feed.desk.take(waiting.id)).toMatchObject({
      decision: "allow",
      via: "call",
    });
    // Away with no phone link: nothing here can answer, so nothing is held.
    const bare = new BoardFeed({ root: root(), now: () => Date.now() });
    bare.setAway(true);
    bare.superviseAway();
    expect(bare.desk.attended()).toBe(false);
  });

  it("one phone line: two requests get their calls one after the other, and an unanswered call is not repeated", async () => {
    const clock = { now: 1_000_000 };
    type Answer = {
      decision: "allow" | "deny" | "answer";
      text: string | null;
    };
    const started: string[] = [];
    const finish = new Map<string, (answer: Answer | null) => void>();
    const feed = new BoardFeed({
      root: root(),
      now: () => clock.now,
      call: (item) =>
        new Promise((done) => {
          started.push(item.id);
          finish.set(item.id, done);
        }),
    });
    const settle = () => new Promise((done) => setTimeout(done, 5));
    const ask = (command: string) => {
      clock.now += 10;
      return feed.desk.open({
        agent: "claude-code",
        sessionId: "s",
        cwd: "/work/app",
        pids: [],
        described: describeRequest(permission(command))!,
        holdSeconds: 540,
      });
    };
    feed.setAway(true);
    const first = ask("npm test"),
      second = ask("git push origin main");
    feed.superviseAway();
    feed.superviseAway();
    // The older request has the line. The newer one waits: the backend would refuse it.
    await settle();
    expect(started).toEqual([first.id]);
    finish.get(first.id)!({ decision: "allow", text: null });
    await settle();
    expect(feed.desk.take(first.id)).toMatchObject({
      decision: "allow",
      via: "call",
    });
    feed.superviseAway();
    await settle();
    expect(started).toEqual([first.id, second.id]);
    // The person does not answer the second call. It stays for the panel, and it does not ring again.
    finish.get(second.id)!(null);
    await settle();
    feed.superviseAway();
    feed.decisions();
    await settle();
    expect(started).toEqual([first.id, second.id]);
    expect(feed.desk.take(second.id)).toBeNull();
  });

  it.each(["lost response after dispatch", "busy line", "synchronous failure"])(
    "does not retry %s or turn an unknown call into an answer",
    async (failure) => {
      const clock = { now: 1_000_000 };
      const settle = () => new Promise((done) => setTimeout(done, 5));
      const attempted: string[] = [];
      const feed = new BoardFeed({
        root: root(),
        now: () => clock.now,
        call: (item) => {
          attempted.push(item.id);
          if (failure === "synchronous failure") throw new Error(failure);
          return Promise.reject(new Error(failure));
        },
      });
      feed.setAway(true);
      const waiting = feed.desk.open({
        agent: "codex",
        sessionId: "t",
        cwd: "/work/site",
        pids: [],
        described: describeRequest(permission("npm publish"))!,
        holdSeconds: 540,
      });
      for (const elapsed of [0, 1000, 8000, 30_000, 120_000, 500_000]) {
        clock.now = 1_000_000 + elapsed;
        feed.superviseAway();
        feed.decisions();
        await settle();
      }
      expect(attempted).toEqual([waiting.id]);
      expect(feed.desk.take(waiting.id)).toBeNull();
      // The failed phone attempt leaves the original request answerable locally.
      expect(feed.desk.pending().map((item) => item.id)).toContain(waiting.id);
      feed.answer({ id: waiting.id, decision: "deny", text: "Not now." });
      expect(feed.desk.take(waiting.id)).toMatchObject({
        decision: "deny",
        text: "Not now.",
        via: "panel",
      });
    },
  );

  it("in away mode the service places one call for a waiting request and the spoken answer reaches the hook", async () => {
    const directory = root();
    const calls: string[] = [];
    const feed = new BoardFeed({
      root: directory,
      now: () => Date.now(),
      call: async (item) => {
        calls.push(item.id);
        return { decision: "deny", text: "Not before review." };
      },
    });
    const waiting = feed.desk.open({
      agent: "codex",
      sessionId: "t",
      cwd: "/work/site",
      pids: [],
      described: describeRequest(permission("git push origin main"))!,
      holdSeconds: 540,
    });
    // Here, not away: the panel shows it, and no call is placed.
    let view = feed.decisions();
    expect(view).toMatchObject({ version: 1, away: false, callReady: true });
    expect(view.pending).toMatchObject([
      {
        id: waiting.id,
        agentLabel: "Codex",
        kind: "permission",
        summary: "git push origin main",
        project: "site",
        session: null,
        canRemember: true,
        allowedBefore: 0,
      },
    ]);
    expect(feed.desk.attended()).toBe(true);
    expect(calls).toEqual([]);
    feed.setAway(true);
    view = feed.decisions();
    feed.decisions();
    await new Promise((done) => setTimeout(done, 10));
    expect(calls).toEqual([waiting.id]);
    expect(feed.desk.take(waiting.id)).toMatchObject({
      decision: "deny",
      text: "Not before review.",
      via: "call",
    });
    // The panel can still answer another request by hand.
    const other = feed.desk.open({
      agent: "claude-code",
      sessionId: "s",
      cwd: "/work/app",
      pids: [],
      described: describeRequest(permission("cat a | sh"))!,
      holdSeconds: 540,
    });
    feed.setAway(false);
    expect(
      feed.decisions().pending.find((item) => item.id === other.id),
    ).toMatchObject({ canRemember: false });
    expect(
      feed.answer({ id: other.id, decision: "allow", remember: true }),
    ).toBe(true);
    expect(feed.desk.take(other.id)).toMatchObject({
      via: "panel",
      remember: true,
    });
    expect(await feed.send("999-zz", "hello", true)).toEqual({
      ok: false,
      route: "none",
    });
    expect(new BoardFeed({ root: root() }).decisions().callReady).toBe(false);
  });
});
