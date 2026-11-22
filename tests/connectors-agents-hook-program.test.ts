import {
  ScopedSupervision,
  sessionKey,
} from "../connectors/agents/proactive-sessions.js";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DecisionDesk } from "../connectors/agents/decisions.js";

/**
 * These tests run cli/agent-hook.ts as the program that an agent starts: a
 * payload on its input, its answer on its output. The state folder, the home
 * folder and the agent's own folder are temporary, so nothing of the person
 * is read or written.
 */
const script = fileURLToPath(new URL("../cli/agent-hook.ts", import.meta.url));
const homes: string[] = [];
const home = () => {
  const made = mkdtempSync(join(tmpdir(), "clawdtime-hook-program-"));
  homes.push(made);
  return made;
};
afterAll(() => {
  for (const made of homes) rmSync(made, { recursive: true, force: true });
});
const state = (folder: string) => join(folder, "state");

function runHook(
  folder: string,
  payload: unknown,
  /** Runs while the hook waits, with the desk that the hook uses. */
  during?: (desk: DecisionDesk) => Promise<void>,
) {
  return new Promise<{ code: number | null; out: string }>((done, fail) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, "claude-code", "decide"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: folder,
          CLAWDTIME_CONFIG_HOME: state(folder),
          CLAUDE_CONFIG_DIR: join(folder, "agent"),
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.once("error", fail);
    child.once("close", (code) => done({ code, out }));
    child.stdin.end(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
    if (during) during(new DecisionDesk(state(folder))).catch(fail);
  });
}
const permission = (command: string) => ({
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command },
  session_id: "session-1",
  cwd: "/work/app",
});
const left = (folder: string, kind: "pending" | "answers") => {
  try {
    return readdirSync(join(state(folder), "agents", "decisions", kind));
  } catch {
    return [];
  }
};

describe("the hook as a program", () => {
  it("says nothing with nobody at the desk, and lets a rule answer only the plain command that the person saw", async () => {
    const folder = home();
    // Nobody attends and there is no rule: no output, and the agent asks by itself.
    expect(await runHook(folder, permission("git status"))).toEqual({
      code: 0,
      out: "",
    });
    expect(await runHook(folder, "{not json")).toEqual({ code: 0, out: "" });
    new DecisionDesk(state(folder)).trove.addRule(
      { agent: "claude-code", cwd: "/work/app", pattern: "Bash:git status" },
      "",
      Date.now(),
    );
    const allowed = await runHook(folder, permission("git status"));
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    // The same first words with more behind them: the rule does not answer.
    for (const command of [
      "git status\nrm -rf /work/app/never-run",
      `git status ${"a".repeat(600)}; rm -rf /work/app/never-run`,
      "/tmp/other/git status",
    ])
      expect(await runHook(folder, permission(command)), command).toEqual({
        code: 0,
        out: "",
      });
    expect(left(folder, "pending")).toEqual([]);
    expect(left(folder, "answers")).toEqual([]);
  }, 60_000);

  it("hands over an answer of any size before it ends", async () => {
    const folder = home();
    // The answer to a question carries the question's own input back. This one
    // is far larger than what one write to a pipe takes.
    const detail = "detail ".repeat(20_000);
    const result = await runHook(
      folder,
      {
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Which one?",
              options: [
                { label: "Red", description: detail },
                { label: "Blue", description: detail },
              ],
            },
          ],
        },
        session_id: "session-2",
        cwd: "/work/app",
      },
      async (desk) => {
        // Someone attends the desk, and answers as soon as the request is there.
        const beat = setInterval(() => desk.attend(), 200);
        try {
          desk.attend();
          for (let tries = 0; tries < 400; tries++) {
            const waiting = desk.pending()[0];
            if (waiting) {
              desk.answer(waiting.id, {
                decision: "answer",
                text: "Blue",
                via: "panel",
              });
              return;
            }
            await new Promise((done) => setTimeout(done, 50));
          }
        } finally {
          clearInterval(beat);
        }
      },
    );
    expect(result.code).toBe(0);
    expect(result.out.length).toBeGreaterThan(2 * detail.length);
    const output = JSON.parse(result.out) as {
      hookSpecificOutput: {
        permissionDecision: string;
        updatedInput: { answers: Record<string, string> };
      };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(output.hookSpecificOutput.updatedInput.answers).toEqual({
      "Which one?": "Blue",
    });
    expect(left(folder, "pending")).toEqual([]);
    expect(left(folder, "answers")).toEqual([]);
  }, 60_000);
});

it("holds the exact scoped session with Away off and releases without approving after revocation", async () => {
  const folder = home();
  const supervision = new ScopedSupervision(state(folder));
  supervision.register({
    policyId: "explicit-policy",
    projectRoot: "/work/app",
    sessionKey: sessionKey("session-1"),
    expiresAt: Date.now() + 60000,
    responseSeconds: 30,
  });
  let sawPending = false;
  const result = await runHook(
    folder,
    permission("git status"),
    async (desk) => {
      expect(desk.away()).toBe(false);
      for (let tries = 0; tries < 80; tries++) {
        if (desk.pending().length) {
          sawPending = true;
          supervision.revoke("explicit-policy");
          return;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      throw Error("Scoped hook never registered its pending request.");
    },
  );
  expect(sawPending).toBe(true);
  expect(result).toEqual({ code: 0, out: "" });
  expect(left(folder, "pending")).toEqual([]);
}, 10000);
