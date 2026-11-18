import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskVerification } from "../contracts.js";

export interface VerificationCheck {
  name: string;
  command: string[];
  timeoutMs?: number;
}
export type VerificationPlan = VerificationCheck[];
export function validateVerificationPlan(plan: VerificationPlan) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 16)
    throw new Error("One to sixteen explicit checks are required.");
  for (const check of plan) {
    if (
      !check.name ||
      check.name.length > 200 ||
      !Array.isArray(check.command) ||
      check.command.length < 1 ||
      check.command.length > 32 ||
      check.command.some(
        (arg) => typeof arg !== "string" || !arg || arg.length > 2000,
      )
    )
      throw new Error("Invalid verification plan.");
    if (
      check.timeoutMs !== undefined &&
      (!Number.isFinite(check.timeoutMs) ||
        check.timeoutMs < 100 ||
        check.timeoutMs > 120000)
    )
      throw new Error("Invalid verification timeout.");
  }
}
export async function runTaskVerification(
  projectRoot: string,
  runId: string,
  plan: VerificationPlan,
  signal: AbortSignal,
  authorize: () => void = () => {},
): Promise<TaskVerification> {
  validateVerificationPlan(plan);
  const checks: TaskVerification["checks"] = [];
  for (const check of plan) {
    try {
      authorize();
    } catch {
      checks.push({
        name: check.name,
        command: check.command,
        state: "blocked",
        exitCode: null,
        summary: "Task authority unavailable before check dispatch.",
      });
      break;
    }
    if (signal.aborted) {
      checks.push({
        name: check.name,
        command: check.command,
        state: "blocked",
        exitCode: null,
        summary: "Verification canceled before dispatch.",
      });
      break;
    }
    checks.push(await runCheck(projectRoot, check, signal));
    if (checks.at(-1)!.state === "unknown") break;
  }
  const state = checks.some((c) => c.state === "unknown")
    ? "unknown"
    : checks.some((c) => c.state === "blocked")
      ? "blocked"
      : checks.some((c) => c.state === "failed")
        ? "failed"
        : "passed";
  return {
    id: `verification_${randomUUID()}`,
    runId,
    state,
    checks,
    completedAt: Date.now(),
  };
}

async function runCheck(
  projectRoot: string,
  check: VerificationCheck,
  signal: AbortSignal,
): Promise<TaskVerification["checks"][number]> {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-check-"));
  try {
    return await new Promise((resolve) => {
      let finished = false,
        interrupted = false,
        spawned = false;
      let bytes = 0;
      const digest = createHash("sha256");
      const child = spawn(check.command[0]!, check.command.slice(1), {
        cwd: projectRoot,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: home,
          CI: "1",
          NO_COLOR: "1",
        },
      });
      const group = (sig: NodeJS.Signals) => {
        if (!child.pid) return true;
        try {
          process.kill(-child.pid, sig);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        interrupted = true;
        group("SIGTERM");
        killTimer ??= setTimeout(() => group("SIGKILL"), 250);
      };
      const timer = setTimeout(
        stop,
        Math.min(120000, Math.max(100, check.timeoutMs ?? 60000)),
      );
      const hardTimer = setTimeout(
        () => {
          group("SIGKILL");
          finish(
            "unknown",
            null,
            "Verification process did not establish termination.",
          );
        },
        Math.min(120000, Math.max(100, check.timeoutMs ?? 60000)) + 2000,
      );
      const finish = (
        state: TaskVerification["state"],
        exitCode: number | null,
        summary: string,
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", stop);
        resolve({
          name: check.name,
          command: check.command,
          state,
          exitCode,
          summary,
        });
      };
      const output = (data: Buffer) => {
        bytes += data.length;
        if (bytes <= 1024 * 1024) digest.update(data);
        else stop();
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("spawn", () => {
        spawned = true;
        if (signal.aborted) stop();
      });
      child.once("error", () =>
        finish(
          spawned ? "unknown" : "blocked",
          null,
          "Verification executable could not run; no passing evidence.",
        ),
      );
      child.once("close", (code) => {
        let cleaned = !child.pid;
        if (child.pid) {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            cleaned = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
        // A submitted kill is cleanup, never proof that detached work stopped.
        if (!cleaned) group("SIGKILL");
        const state = !cleaned
          ? "unknown"
          : interrupted
            ? "blocked"
            : code === 0
              ? "passed"
              : "failed";
        finish(
          state,
          code,
          `${!cleaned ? "Child process outcome unresolved" : interrupted ? "Check interrupted or output limit exceeded" : code === 0 ? "Check exited successfully" : "Check failed"}; output bytes=${bytes}; bounded SHA-256=${digest.digest("hex")}. Raw output discarded.`,
        );
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
