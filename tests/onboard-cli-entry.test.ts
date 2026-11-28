import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

/** Runs the real command in a new session: it has no controlling terminal. */
function clawdtime(args: string[], home: string) {
  return new Promise<{ code: number | null; stdout: string }>((done) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("cli/main.ts"), ...args],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: home, VITEST: "true" },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stdin.end("not a key\n");
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, stdout });
    });
  });
}

it("prints the one line and exits 3 when no terminal exists, and reads nothing from the pipe", async () => {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-onboard-entry-"));
  try {
    const result = await clawdtime(["onboard"], home);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe(
      "Run clawdtime onboard in Terminal to finish setup.\n",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it("shows its help", async () => {
  const home = mkdtempSync(join(tmpdir(), "clawdtime-onboard-entry-"));
  try {
    const result = await clawdtime(["onboard", "--help"], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "clawdtime onboard [--phone] [--local] [--coordinator HTTPS_ORIGIN] [--json]",
    );
    // The phone is a later step, and the help says how to take it.
    expect(result.stdout).toContain(
      "Your phone is a later step:\nclawdtime onboard --phone.",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
