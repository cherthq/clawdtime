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
});
